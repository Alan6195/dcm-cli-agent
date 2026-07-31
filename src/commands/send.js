'use strict';

const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const statusLib = require('../lib/status');
const codecs = require('../lib/codecs');
const { scan, chunk } = require('../lib/scan');
const { rewrittenSeriesUid } = require('../lib/uid');
const { TransferLedger, Disposition } = require('../lib/ledger');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');
const { report } = require('../lib/report');

const { Dataset, Transcoding } = dcmjsDimse;
const { CStoreRequest } = dcmjsDimse.requests;

const FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae', 'chunk', 'dry-run', 'recurse',
  'retry', 'timeout', 'connect-timeout', 'association-timeout',
  'rewrite-series-uid', 'no-recurse',
];

const USAGE = `
dcm send — send a folder of DICOM files to a peer (C-STORE)

Walks a folder tree, groups what it finds by Study and Series Instance UID, and
sends each study in chunks. Reports three separate numbers per study: files
found on disk, files sent, and instances the peer acknowledged. Any shortfall
between them is a failure and exits non-zero.

Usage:
  dcm send <folder> --host <host> --port <port> --called-ae <AE> [options]

Options:
  --host <host>           Peer hostname. Prefer a hostname over an IP address.  [env DCM_HOST]
  --port <port>           Peer DIMSE port.                                      [env DCM_PORT]
  --called-ae <AE>        The peer's AE Title.                                  [env DCM_CALLED_AE]
  --calling-ae <AE>       Our AE Title. Must be registered on the peer.         [env DCM_CALLING_AE]
                          Default: DCM-CLI
  --chunk <n>             Instances per association. Default: 200.
                          Large studies are split across several associations so
                          that memory stays flat regardless of study size.
  --retry <n>             Retry attempts for a chunk where fewer instances were
                          acknowledged than sent. Default: 1.
  --dry-run               Scan and report what would be sent. Opens no connection.
  --no-recurse            Only look at files directly in the folder.
  --timeout <ms>          Silence allowed before giving up. Default: 60000.
  --rewrite-series-uid    Replace each Series Instance UID with a deterministic
                          2.25.<hash> value. MODIFIES DATA — see below.
  --verbose               Log the full association negotiation.

--rewrite-series-uid:
  Some source systems emit the same Series Instance UID for genuinely different
  series, which makes receivers merge them into one stack. This option assigns
  each source series a new, deterministic UID derived from the study and series
  UID together, so distinct series stay distinct. The same input always yields
  the same output, so a re-send maps onto the same series rather than creating a
  duplicate. It changes the data you send, and is off unless asked for.

Examples:
  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm send ./studies --host pacs.example.org --port 11112 --called-ae ARCHIVE --chunk 100 --retry 2
  dcm send ./study --dry-run
`.trimStart();

/**
 * Statuses worth a second attempt. A receiver that is out of resources or hit
 * a transient internal error may well succeed a moment later; one that does not
 * support the SOP Class never will, and retrying it just wastes time and
 * muddies the report.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  if (status === undefined) return true; // never answered
  if (status >= 0xa700 && status <= 0xa7ff) return true; // out of resources
  if (status === 0x0110) return true; // processing failure
  return false;
}

/**
 * Builds a C-STORE request for one file.
 *
 * The normal path hands the library a file path rather than a parsed dataset.
 * That keeps the request lazy: a few hundred bytes per instance instead of the
 * whole image, which is what makes a multi-thousand-instance study possible on
 * a modest machine.
 *
 * The rewrite path has to parse the dataset in order to change it, so it costs
 * real memory. The chunk size is reduced to compensate.
 *
 * @param {object} entry     Ledger entry.
 * @param {object} meta      Scanner metadata for the file.
 * @param {{rewriteSeriesUid: boolean}} opts
 * @returns {object} A CStoreRequest.
 */
function buildRequest(entry, meta, opts) {
  if (!opts.rewriteSeriesUid) {
    return new CStoreRequest(entry.path);
  }

  const dataset = Dataset.fromFile(entry.path);
  if (!dataset) throw new Error('parser returned no dataset');

  const sourceSeries = dataset.getElement('SeriesInstanceUID');
  const studyUid = dataset.getElement('StudyInstanceUID');
  if (!sourceSeries || !studyUid) {
    throw new Error('cannot rewrite Series Instance UID: study or series UID missing');
  }

  const replacement = rewrittenSeriesUid(studyUid, sourceSeries);
  dataset.setElement('SeriesInstanceUID', replacement);
  entry.rewrittenSeriesUid = replacement;

  return new CStoreRequest(dataset);
}

/**
 * Sends one chunk over one association.
 *
 * Every entry handed in leaves this function with a terminal disposition. That
 * is the whole point: an entry that reaches the end without one would be a file
 * that vanished, and reconciliation reports exactly that.
 *
 * @param {object} params
 * @returns {Promise<{outcome: object|undefined, dispatched: number}>}
 */
async function sendChunk(params) {
  const { entries, metaByPath, studyLedger, connection, timeouts, options, label } = params;

  const requests = [];
  const built = [];

  for (const entry of entries) {
    let request;
    try {
      request = buildRequest(entry, metaByPath.get(entry.path), options);
    } catch (err) {
      // Could not even construct the request. Counted here, not dropped.
      entry.settle(Disposition.READ_ERROR, { detail: err.message });
      continue;
    }

    // Per-request handler. Binding the handler to this specific entry avoids
    // matching responses back by SOP Instance UID, which would be ambiguous
    // whenever a tree contains the same instance twice.
    request.on('response', (response) => {
      const status = response.getStatus();
      const comment = response.getErrorComment();

      // Pending responses are not terminal; C-STORE should not emit them, but
      // a non-conformant peer might.
      const cls = statusLib.classify(status);
      if (cls === statusLib.Class.PENDING) return;

      if (entry.settled) {
        // A second terminal response for one request means the peer is not
        // behaving. Record it rather than crashing the transfer.
        log.debug(
          `duplicate response for ${path.basename(entry.path)} ` +
            `(already ${entry.disposition}, now ${statusLib.formatCode(status)})`
        );
        return;
      }

      if (cls === statusLib.Class.SUCCESS) {
        entry.settle(Disposition.ACKNOWLEDGED, { status });
      } else if (cls === statusLib.Class.WARNING) {
        entry.settle(Disposition.WARNING, { status, detail: comment });
      } else {
        entry.settle(Disposition.FAILED, { status, detail: comment });
      }
    });

    requests.push(request);
    built.push(entry);
  }

  if (requests.length === 0) {
    return { outcome: undefined, dispatched: 0 };
  }

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
  const reason = outcome
    ? `${outcome.label} (${outcome.raw})`
    : 'association ended without a result';

  for (const entry of built) {
    if (entry.settled) continue;
    entry.settle(
      accepted ? Disposition.UNANSWERED : Disposition.NOT_ATTEMPTED,
      { detail: reason }
    );
  }

  return { outcome, dispatched: accepted ? built.length : 0 };
}

/**
 * Sends one chunk, retrying the instances that did not come back acknowledged.
 *
 * The retry exists for a specific failure: a receiver that accepts an
 * association, acknowledges part of the transfer, then goes quiet. Re-sending
 * only the outstanding instances usually completes them.
 *
 * @returns {Promise<void>}
 */
async function sendChunkWithRetry(params) {
  const { entries, retries, label } = params;

  let attempt = 0;
  let working = entries;

  for (;;) {
    const { outcome } = await sendChunk({ ...params, entries: working, label: `${label} attempt ${attempt + 1}` });

    const outstanding = working.filter(
      (e) => e.retryable && isRetryableStatus(e.status)
    );

    const acknowledged = working.length - outstanding.length;
    if (outstanding.length === 0) {
      return;
    }

    if (attempt >= retries) {
      if (retries > 0) {
        log.warn(
          `${label}: ${outstanding.length} instance(s) still outstanding after ` +
            `${attempt + 1} attempt(s); giving up on them`
        );
      }
      return;
    }

    // A permanently failed association will not improve on a second attempt.
    //
    // This deliberately only applies when the association itself failed. An
    // association that completed normally is marked non-retryable — there is
    // nothing to retry about the association — but the instances inside it can
    // still have been refused individually, and re-sending those is the entire
    // point of this retry. Treating "association completed" as "do not retry"
    // silently disables the retry in the exact case it exists for.
    if (outcome && outcome.kind !== 'completed' && outcome.retryable === false) {
      log.debug(`${label}: ${outcome.label} is not retryable, not attempting again`);
      return;
    }

    attempt += 1;
    log.warn(
      `${label}: ${acknowledged}/${working.length} acknowledged — ` +
        `retrying ${outstanding.length} instance(s) (attempt ${attempt + 1} of ${retries + 1})`
    );

    for (const entry of outstanding) entry.resetForRetry();
    working = outstanding;
  }
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags, positionals } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const target = positionals[0];
  if (!target) {
    throw new args.UsageError('Missing folder. Usage: dcm send <folder> --host ... --port ... --called-ae ...');
  }

  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });
  const recurse = !flags.has('no-recurse');
  const chunkSizeRequested = args.resolve(flags, { name: 'chunk', type: 'number', fallback: 200 });
  const retries = args.resolve(flags, { name: 'retry', type: 'number', fallback: 1 });
  const rewriteSeriesUid = args.resolve(flags, {
    name: 'rewrite-series-uid', type: 'boolean', fallback: false,
  });

  if (!Number.isInteger(chunkSizeRequested) || chunkSizeRequested < 1) {
    throw new args.UsageError(`--chunk must be a positive integer, got "${chunkSizeRequested}".`);
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new args.UsageError(`--retry must be zero or a positive integer, got "${retries}".`);
  }

  // Rewriting means holding parsed datasets rather than file paths, which costs
  // roughly the size of the study in memory. Shrink the chunk to compensate
  // unless the operator has chosen a size explicitly.
  let chunkSize = chunkSizeRequested;
  if (rewriteSeriesUid && !flags.has('chunk') && chunkSize > 50) {
    chunkSize = 50;
  }

  // Connection details are only required once we intend to connect.
  let connection;
  let timeouts;
  if (!dryRun) {
    const host = args.resolve(flags, { name: 'host', env: 'DCM_HOST', required: true });
    const port = args.validatePort(
      args.resolve(flags, { name: 'port', env: 'DCM_PORT', required: true, type: 'number' }),
      'port'
    );
    const calledAe = args.validateAeTitle(
      args.resolve(flags, { name: 'called-ae', env: 'DCM_CALLED_AE', required: true }),
      'called-ae'
    );
    const callingAe = args.validateAeTitle(
      args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
      'calling-ae'
    );
    connection = { host, port, calledAe, callingAe };
    timeouts = resolveTimeouts({
      timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
      connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
      associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
    });
  }

  // --- Scan ---
  log.info(`scanning ${path.resolve(target)}${recurse ? '' : ' (not recursing)'}`);
  const scanned = scan(target, {
    recurse,
    onProgress: (done, total) => log.debug(`examined ${done}/${total} files`),
  });

  if (scanned.ignored.length) {
    log.info(`ignored ${scanned.ignored.length} non-DICOM file(s)`);
    for (const item of scanned.ignored.slice(0, 20)) {
      log.debug(`  ignored ${item.path}: ${item.reason}`);
    }
  }

  // --- Register everything in the ledger, including what failed to parse ---
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
      transferSyntaxes: [...study.transferSyntaxes],
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

  const totalFound = scanned.candidates;
  if (totalFound === 0) {
    log.error(`No DICOM instances found under ${path.resolve(target)}.`);
    if (scanned.filesExamined > 0) {
      log.error(`Examined ${scanned.filesExamined} file(s); none were DICOM.`);
    }
    return 1;
  }

  log.info(
    `found ${totalFound} instance(s) in ${scanned.studies.size} stud${scanned.studies.size === 1 ? 'y' : 'ies'}` +
      (scanned.readErrors.length ? `, ${scanned.readErrors.length} unreadable` : '')
  );

  // --- Dry run stops here ---
  if (dryRun) {
    report.dryRun({ scanned, chunkSize, rewriteSeriesUid });
    // A dry run that found unreadable files should still say so loudly.
    return scanned.readErrors.length > 0 ? 1 : 0;
  }

  // Compressed transfer syntaxes need the codecs module; uncompressed do not.
  await codecs.initialize(Transcoding);

  if (rewriteSeriesUid) {
    log.warn(
      '--rewrite-series-uid is on: the Series Instance UID of every instance will be ' +
        'replaced before sending. The data the peer receives will not match the data on disk.'
    );
    if (chunkSize !== chunkSizeRequested) {
      log.info(
        `chunk size reduced to ${chunkSize} because rewriting requires holding parsed ` +
          `datasets in memory (pass --chunk explicitly to override)`
      );
    }
  }

  // --- Send, study by study ---
  const options = { rewriteSeriesUid };
  let studyIndex = 0;

  for (const studyLedger of ledger.studies.values()) {
    studyIndex += 1;
    const entries = studyLedger.entries;
    const chunks = chunk(entries, chunkSize);

    log.info('');
    log.info(
      `study ${studyIndex}/${ledger.studies.size} ${log.color.bold(studyLedger.studyInstanceUid)}`
    );
    log.info(
      `  ${entries.length} instance(s) in ${chunks.length} association(s) of up to ${chunkSize}`
    );

    for (let i = 0; i < chunks.length; i++) {
      const label = `study ${studyIndex} chunk ${i + 1}/${chunks.length}`;
      log.info(`  ${label}: sending ${chunks[i].length} instance(s)`);

      await sendChunkWithRetry({
        entries: chunks[i],
        metaByPath,
        studyLedger,
        connection,
        timeouts,
        options,
        retries,
        label,
      });

      const soFar = studyLedger.reconcile();
      log.info(
        `  ${label}: ${soFar.acknowledged}/${soFar.found} acknowledged so far`
      );
    }
  }

  // --- Reconcile and report ---
  const result = ledger.reconcile();
  report.transfer({ result, connection, chunkSize, rewriteSeriesUid });

  return result.ok ? 0 : 1;
}

module.exports = { run, USAGE, isRetryableStatus, buildRequest };
