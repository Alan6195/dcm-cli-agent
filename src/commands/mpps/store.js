'use strict';

/**
 * The C-STORE leg of `dcm mpps perform`.
 *
 * This is not a verb. It is the adapter that lets the MPPS transaction use the
 * same transfer machinery `dcm send` uses, and come back holding the ledger
 * rather than an exit code.
 *
 * Why an adapter exists at all: `send.run()` scans, sends, prints a report and
 * returns 0 or 1. Its ledger — the per-instance record of what the peer
 * acknowledged — never leaves the function. MPPS needs exactly that record and
 * nothing else, because PerformedSeriesSequence may only name instances the
 * archive actually took. Counts from `--json` cannot substitute: they say how
 * many were acknowledged, never which ones.
 *
 * So the per-file work is delegated to send.js, which already exports the two
 * decisions that are easy to get subtly wrong — how to build a C-STORE request
 * for an entry, and which statuses deserve a retry — and this module supplies
 * only the loop around them. The loop is the part that should not be here: see
 * the note at the bottom of this file for the single export send.js needs for
 * it to be deleted.
 */

const log = require('../../lib/log');
const statusLib = require('../../lib/status');
const { scan, chunk } = require('../../lib/scan');
const { TransferLedger, Disposition } = require('../../lib/ledger');
const { runAssociation } = require('../../lib/dimse');
const send = require('../send');

/**
 * Scans a folder and registers every file in a ledger.
 *
 * Split out from the transfer so `--dry-run` and the multi-study check can run
 * before a connection is opened. Read errors are registered too: a file that is
 * never registered is a file that can never be counted as missing.
 *
 * @param {string} target
 * @param {{recurse?: boolean}} [opts]
 * @returns {{scanned: object, ledger: TransferLedger, metaByPath: Map<string, object>}}
 */
function scanIntoLedger(target, opts = {}) {
  const { recurse = true } = opts;

  const scanned = scan(target, {
    recurse,
    onProgress: (done, total) => log.debug(`examined ${done}/${total} files`),
  });

  const ledger = new TransferLedger();
  const metaByPath = new Map();

  for (const failure of scanned.readErrors) {
    ledger.addUnassignable(failure.path, failure.error);
  }

  for (const [studyUid, study] of scanned.studies) {
    const studyLedger = ledger.study(studyUid, {
      patientId: study.patientId,
      patientName: study.patientName,
      studyDate: study.studyDate,
      studyDescription: study.studyDescription,
      accessionNumber: study.accessionNumber,
      modalities: [...study.modalities],
      seriesCount: study.series.size,
      bytes: study.bytes,
    });

    for (const instance of study.instances) {
      metaByPath.set(instance.path, instance);
      studyLedger.addFile({
        path: instance.path,
        bytes: instance.bytes,
        sopInstanceUid: instance.sopInstanceUid,
        sopClassUid: instance.sopClassUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        transferSyntaxUid: instance.transferSyntaxUid,
      });
    }
  }

  return { scanned, ledger, metaByPath };
}

/**
 * Every ledger entry across every study, in scan order.
 *
 * @param {TransferLedger} ledger
 * @returns {Array<object>}
 */
function allEntries(ledger) {
  const entries = [];
  for (const studyLedger of ledger.studies.values()) entries.push(...studyLedger.entries);
  return entries;
}

/**
 * Sends one chunk over one association, settling every entry it was given.
 *
 * The response handler is bound per entry rather than matching responses back
 * by SOP Instance UID, because a tree can legitimately contain the same
 * instance twice and the match would be ambiguous.
 *
 * @param {object} params
 * @returns {Promise<{outcome: object|undefined}>}
 */
async function sendChunk(params) {
  const { entries, metaByPath, studyLedger, connection, timeouts, label } = params;

  const requests = [];
  const built = [];

  for (const entry of entries) {
    let request;
    try {
      request = send.buildRequest(entry, metaByPath.get(entry.path), {});
    } catch (err) {
      entry.settle(Disposition.READ_ERROR, { detail: err.message });
      continue;
    }

    request.on('response', (response) => {
      const status = response.getStatus();
      const cls = statusLib.classify(status);
      if (cls === statusLib.Class.PENDING) return;
      if (entry.settled) return;

      if (cls === statusLib.Class.SUCCESS) {
        entry.settle(Disposition.ACKNOWLEDGED, { status });
      } else if (cls === statusLib.Class.WARNING) {
        entry.settle(Disposition.WARNING, { status, detail: response.getErrorComment() });
      } else {
        entry.settle(Disposition.FAILED, { status, detail: response.getErrorComment() });
      }
    });

    requests.push(request);
    built.push(entry);
  }

  if (requests.length === 0) return { outcome: undefined };

  let accepted = false;
  const { outcome } = await runAssociation({
    host: connection.host,
    port: connection.port,
    callingAe: connection.callingAe,
    calledAe: connection.calledAe,
    requests,
    timeouts,
    onAccepted: () => {
      accepted = true;
      // Only now can these be called sent: before acceptance nothing went out.
      for (const entry of built) entry.dispatched = true;
    },
  });

  if (outcome && outcome.kind !== 'completed') {
    studyLedger.addEvent({
      kind: outcome.kind,
      message: `${label}: ${outcome.label} — ${outcome.headline}`,
      detail: outcome,
    });
  }

  // Close out anything the peer never spoke about. Whether the association was
  // accepted decides which of the two honest statements applies.
  const reason = outcome ? `${outcome.label} (${outcome.raw})` : 'association ended without a result';
  for (const entry of built) {
    if (entry.settled) continue;
    entry.settle(accepted ? Disposition.UNANSWERED : Disposition.NOT_ATTEMPTED, { detail: reason });
  }

  return { outcome };
}

/**
 * Sends one chunk, re-sending the instances that did not come back acknowledged.
 *
 * @param {object} params
 * @returns {Promise<void>}
 */
async function sendChunkWithRetry(params) {
  const { entries, retries, label } = params;

  let attempt = 0;
  let working = entries;

  for (;;) {
    const { outcome } = await sendChunk({
      ...params,
      entries: working,
      label: `${label} attempt ${attempt + 1}`,
    });

    const outstanding = working.filter((e) => e.retryable && send.isRetryableStatus(e.status));
    if (outstanding.length === 0) return;

    if (attempt >= retries) {
      if (retries > 0) {
        log.warn(
          `${label}: ${outstanding.length} instance(s) still outstanding after ` +
            `${attempt + 1} attempt(s); giving up on them`
        );
      }
      return;
    }

    // Only an association-level failure is unretryable. An association that
    // completed normally can still have had instances refused inside it, and
    // re-sending those is the entire point of this retry.
    if (outcome && outcome.kind !== 'completed' && outcome.retryable === false) {
      log.debug(`${label}: ${outcome.label} is not retryable, not attempting again`);
      return;
    }

    attempt += 1;
    log.warn(
      `${label}: ${working.length - outstanding.length}/${working.length} acknowledged — ` +
        `retrying ${outstanding.length} instance(s) (attempt ${attempt + 1} of ${retries + 1})`
    );
    for (const entry of outstanding) entry.resetForRetry();
    working = outstanding;
  }
}

/**
 * Sends everything registered in the ledger and reconciles.
 *
 * @param {object} params
 * @param {TransferLedger} params.ledger  From {@link scanIntoLedger}.
 * @param {Map} params.metaByPath
 * @param {object} params.connection      {host, port, callingAe, calledAe}
 * @param {object} params.timeouts
 * @param {number} params.chunkSize
 * @param {number} params.retries
 * @returns {Promise<object>} The reconciled result.
 */
async function storeLedger(params) {
  const { ledger, metaByPath, connection, timeouts, chunkSize, retries } = params;

  let studyIndex = 0;
  for (const studyLedger of ledger.studies.values()) {
    studyIndex += 1;
    const chunks = chunk(studyLedger.entries, chunkSize);

    log.info(
      `  study ${studyIndex}/${ledger.studies.size} ${studyLedger.studyInstanceUid}: ` +
        `${studyLedger.entries.length} instance(s) in ${chunks.length} association(s)`
    );

    // Deliberately serial, unlike `dcm send --parallel`. The images being
    // stored here are the ones the N-SET is about to claim as performed work,
    // and a serial transfer keeps the ledger's story simple enough to explain
    // in the one report this command prints.
    for (let i = 0; i < chunks.length; i++) {
      const label = `  chunk ${i + 1}/${chunks.length}`;
      await sendChunkWithRetry({
        entries: chunks[i],
        metaByPath,
        studyLedger,
        connection,
        timeouts,
        retries,
        label,
      });
      const soFar = studyLedger.reconcile();
      log.info(`${label}: ${soFar.acknowledged}/${soFar.found} acknowledged so far`);
    }
  }

  return ledger.reconcile();
}

/*
 * The loop above duplicates src/commands/send.js's sendChunk and
 * sendChunkWithRetry, minus the parallel pool, the transfer-syntax conversion
 * and the byte metrics. That duplication is not something to live with.
 *
 * It goes away the moment send.js exports its driver — the whole of it, not
 * another decision function:
 *
 *   async function transfer({ ledger, metaByPath, connection, timeouts,
 *                             chunkSize, retries, options, parallel })
 *     -> reconciled result
 *
 * i.e. the body of `run()` from "Send, study by study" to the reconcile, with
 * the scan and the reporting left where they are. With that export this file
 * keeps only scanIntoLedger() and allEntries(), and calls send.transfer().
 * Nothing else about send.js needs to change, and `dcm send` keeps behaving
 * exactly as it does now.
 */

module.exports = { scanIntoLedger, allEntries, storeLedger, sendChunk, sendChunkWithRetry };
