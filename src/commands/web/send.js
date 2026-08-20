'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { scan, chunk } = require('../../lib/scan');
const { TransferLedger, Disposition } = require('../../lib/ledger');
const { report } = require('../../lib/report');
// The retryability of a per-instance failure reason is the same judgement the
// DIMSE path already makes: STOW-RS FailureReason values are DIMSE status
// codes by construction (PS3.18 reuses the PS3.4 storage codes), so the same
// table applies and having two copies of it would let them drift.
const { isRetryableStatus } = require('../send');
const { translateTransportFailure } = require('../../lib/webdicom');
const {
  resolveWebOptions,
  webRequest,
  joinUrl,
  buildMultipartRelated,
  translateHttpFailure,
  tagValue,
  TAGS,
} = require('../../lib/webdicom');

const FLAGS = ['url', 'timeout', 'insecure', 'chunk', 'retry', 'dry-run', 'no-recurse'];

const USAGE = `
dcm web send — send a folder of DICOM files to a server (STOW-RS)

Walks a folder tree, groups what it finds by Study Instance UID, and POSTs
each study to the server in chunks of multipart/related requests. The same
accounting as dcm send applies: three separate numbers per study — files
found on disk, files sent, and instances the server accepted — and any
shortfall between them is a failure and exits non-zero.

Usage:
  dcm web send <folder> --url <base-url> [options]

Options:
  --url <url>       DICOMweb base URL, including any path prefix.      [env DCM_WEB_URL]
  --chunk <n>       Instances per POST request. Default: 50.           [env DCM_WEB_CHUNK]
                    Each request streams its files from disk, so memory
                    stays flat; the chunk size decides how much work a
                    single HTTP failure can take down with it.
  --retry <n>       Retry attempts for instances that failed retryably
                    (HTTP 429/5xx, network errors, out-of-resources).
                    Default: 1.
  --dry-run         Scan and report what would be sent. No connection.
  --no-recurse      Only look at files directly in the folder.
  --timeout <ms>    Silence allowed before giving up, per request.
                    Default: 60000.                                    [env DCM_WEB_TIMEOUT]
  --insecure        Skip TLS certificate verification. Only for
                    self-signed test servers you control.
  --json            Emit the result as JSON.
  --verbose         Log each request and response.

Authentication:
  Credentials come from the environment and nowhere else — a flag would land
  them in shell history and process listings, which is exactly where PACS
  credentials must not end up:
    DCM_WEB_TOKEN                Bearer token
    DCM_WEB_USER / DCM_WEB_PASS  HTTP Basic

Examples:
  dcm web send ./study --url https://pacs.example.org/dicom-web
  dcm web send ./studies --url https://pacs.example.org/dicom-web --chunk 25 --retry 2
  dcm web send ./study --dry-run

Note:
  A STOW-RS response is per-instance, not per-request. HTTP 200 means every
  instance in the request was stored, 202 means some were and some were not,
  and 409 means none were — and all three carry a body naming each accepted
  and failed instance. A run is only judged on that body: an instance the
  response never mentions is counted as unanswered, never assumed stored.
`.trimStart();

/**
 * Translates a STOW-RS FailureReason into plain English, raw code in brackets.
 *
 * The values are DIMSE storage status codes (PS3.18 Table 6.6.1-2 reuses
 * PS3.4 Annex B): 0xA700 out of resources, 0xA900 dataset/SOP Class mismatch,
 * 0xC000 cannot understand, plus the general-purpose 0x0110/0x0111/0x0122.
 *
 * @param {number|undefined} code
 * @returns {string}
 */
function describeFailureReason(code) {
  if (code === undefined || code === null) {
    return 'the server reported a failure for this instance without giving a reason code';
  }
  const n = Number(code);
  const hex = `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

  if (n >= 0xa700 && n <= 0xa7ff) {
    return `out of resources — the server cannot store this instance right now [${hex}]`;
  }
  if (n >= 0xa900 && n <= 0xa9ff) {
    return `the data set does not match its SOP Class — the server considers the instance inconsistent [${hex}]`;
  }
  if (n >= 0xc000 && n <= 0xcfff) {
    return `the server cannot understand this instance [${hex}]`;
  }
  if (n === 0x0110) {
    return `processing failure — the server hit an internal error while storing it [${hex}]`;
  }
  if (n === 0x0111) {
    return `duplicate SOP Instance — the server already holds an instance with this UID [${hex}]`;
  }
  if (n === 0x0122) {
    return `this SOP Class is not supported by the server [${hex}]`;
  }
  return `failure reason ${n} [${hex}]`;
}

/**
 * Is an HTTP-level chunk failure worth a second attempt?
 *
 * The analogue of isRetryableStatus for the transport: a rate limit or a
 * server fault may well clear a moment later; a 403 or 413 never will, and
 * retrying it just wastes time and muddies the report. No status at all means
 * the request never got an answer (network error, timeout), which is the most
 * retryable situation there is.
 *
 * @param {number|undefined} status
 * @returns {boolean}
 */
function isRetryableHttp(status) {
  if (status === undefined) return true; // never answered
  if (status === 429) return true; // rate limited
  if (status >= 500 && status <= 599) return true; // server fault
  return false;
}

/**
 * Maps a STOW-RS response body onto ledger entries.
 *
 * Instances named in ReferencedSOPSequence settle ACKNOWLEDGED (or WARNING
 * when the item carries a WarningReason); instances in FailedSOPSequence
 * settle FAILED with the reason translated. Instances the response never
 * mentions are deliberately left unsettled — the caller's sweep turns that
 * absence into an explicit UNANSWERED/NOT_ATTEMPTED, which is how a server
 * that quietly drops instances still shows up in the totals.
 *
 * Entries are matched by SOP Instance UID through a multimap consumed
 * front-to-back, so a tree containing the same instance twice cannot settle
 * one entry twice while the other escapes accounting.
 *
 * @param {import('../../lib/ledger').FileEntry[]} entries Entries of this chunk.
 * @param {object} body Parsed DICOM JSON response dataset.
 * @returns {{acknowledged: number, warned: number, failed: number, unmatched: string[]}}
 *   unmatched carries SOP Instance UIDs the server mentioned but this chunk never sent.
 */
function applyStowResponse(entries, body) {
  const byUid = new Map();
  for (const entry of entries) {
    if (entry.settled) continue;
    const list = byUid.get(entry.sopInstanceUid);
    if (list) list.push(entry);
    else byUid.set(entry.sopInstanceUid, [entry]);
  }
  const take = (uid) => {
    const list = byUid.get(uid);
    return list && list.length ? list.shift() : undefined;
  };

  const summary = { acknowledged: 0, warned: 0, failed: 0, unmatched: [] };

  const referenced = body?.[TAGS.REFERENCED_SOP_SEQ]?.Value ?? [];
  for (const item of referenced) {
    const uid = tagValue(item, TAGS.REF_SOP_INSTANCE);
    const entry = take(uid);
    if (!entry) {
      summary.unmatched.push(String(uid));
      continue;
    }
    const warning = tagValue(item, TAGS.WARNING_REASON);
    if (warning !== undefined && warning !== null) {
      const code = Number(warning);
      entry.settle(Disposition.WARNING, {
        status: code,
        detail: `WarningReason 0x${code.toString(16).toUpperCase().padStart(4, '0')}`,
      });
      summary.warned += 1;
    } else {
      // STOW has no explicit status for a plain acceptance; 0x0000 keeps the
      // web and DIMSE ledgers speaking the same status language in reports.
      entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
      summary.acknowledged += 1;
    }
  }

  const failed = body?.[TAGS.FAILED_SOP_SEQ]?.Value ?? [];
  for (const item of failed) {
    const uid = tagValue(item, TAGS.REF_SOP_INSTANCE);
    const entry = take(uid);
    if (!entry) {
      summary.unmatched.push(String(uid));
      continue;
    }
    const reason = tagValue(item, TAGS.FAILURE_REASON);
    entry.settle(Disposition.FAILED, {
      status: reason === undefined || reason === null ? undefined : Number(reason),
      detail: describeFailureReason(reason === undefined || reason === null ? undefined : Number(reason)),
    });
    summary.failed += 1;
  }

  return summary;
}

/**
 * Settles every unsettled entry in a chunk after its request has concluded.
 * Whether the entry's bytes were actually handed to the request decides which
 * of the two honest statements applies — exactly the distinction sendChunk
 * draws for DIMSE.
 *
 * @param {import('../../lib/ledger').FileEntry[]} entries
 * @param {string} reason
 * @returns {number} How many entries were closed out.
 */
function sweepChunk(entries, reason) {
  let closed = 0;
  for (const entry of entries) {
    if (entry.settled) continue;
    entry.settle(
      entry.dispatched ? Disposition.UNANSWERED : Disposition.NOT_ATTEMPTED,
      { detail: reason }
    );
    closed += 1;
  }
  return closed;
}

/**
 * POSTs one chunk of instances as a single STOW-RS request.
 *
 * Every entry handed in leaves with a terminal disposition, same contract as
 * the DIMSE sendChunk: an entry that reached the end without one would be a
 * file that vanished, and reconciliation reports exactly that.
 *
 * @param {object} params
 * @param {import('../../lib/ledger').FileEntry[]} params.entries
 * @param {string} params.studyUid
 * @param {object} params.studyLedger
 * @param {object} params.web  Resolved connection options from resolveWebOptions.
 * @param {object} params.metrics
 * @param {string} params.label
 * @returns {Promise<{httpOk: boolean, httpStatus: number|undefined}>}
 */
async function stowChunk({ entries, studyUid, studyLedger, web, metrics, label }) {
  const parts = [];
  const built = [];

  for (const entry of entries) {
    // Stat at build time rather than trusting the scan: the declared part
    // length becomes the request's Content-Length, and a file that changed
    // size since scanning would corrupt the whole multipart body.
    let size;
    try {
      size = fs.statSync(entry.path).size;
    } catch (err) {
      entry.settle(Disposition.READ_ERROR, { detail: err.message });
      continue;
    }

    built.push(entry);
    parts.push({
      contentType: 'application/dicom',
      length: size,
      getStream: () => {
        const stream = fs.createReadStream(entry.path);
        // 'end' fires when the last byte has left disk for the request body —
        // the closest honest moment for "this instance was sent". Note the
        // request may still buffer before the socket connects, so a chunk
        // that dies very early can occasionally count as UNANSWERED rather
        // than NOT_ATTEMPTED; both are non-success and both are retried.
        stream.once('end', () => {
          entry.dispatched = true;
        });
        return stream;
      },
    });
  }

  if (built.length === 0) {
    // Every file in the chunk failed to stat; nothing to POST.
    return { httpOk: true, httpStatus: undefined };
  }

  const { contentType, stream, contentLength } = buildMultipartRelated(parts);
  const headers = {
    ...web.headers,
    Accept: 'application/dicom+json',
    'Content-Type': contentType,
  };
  if (contentLength !== undefined) headers['Content-Length'] = contentLength;

  let res;
  try {
    metrics.requests += 1;
    res = await webRequest({
      method: 'POST',
      url: joinUrl(web.baseUrl, 'studies', studyUid),
      headers,
      timeoutMs: web.timeoutMs,
      insecure: web.insecure,
      bodyStream: stream,
    });
  } catch (err) {
    const lines = translateTransportFailure(err);
    for (const line of lines) log.warn(line);
    studyLedger.addEvent({
      kind: 'transport',
      message: `${label}: ${lines[0]} [${err.code ?? 'ERROR'}]`,
    });
    sweepChunk(built, `request failed before a response arrived (${err.code ?? err.message})`);
    return { httpOk: false, httpStatus: undefined };
  }

  // 200 (all stored), 202 (partial) and 409 (all failed) each carry a DICOM
  // JSON body naming every instance's fate — those are answers, not errors,
  // and the body is what the ledger is settled from.
  if (res.status === 200 || res.status === 202 || res.status === 409) {
    let body;
    try {
      const parsedBody = JSON.parse(res.body.toString('utf8') || 'null');
      // The spec says a single dataset; some servers wrap it in an array.
      body = Array.isArray(parsedBody) ? parsedBody[0] : parsedBody;
    } catch {
      body = undefined;
    }

    if (!body || typeof body !== 'object') {
      // A per-instance status code with no per-instance body: there is
      // nothing safe to conclude about any individual instance.
      studyLedger.addEvent({
        kind: 'protocol',
        message: `${label}: HTTP ${res.status} carried no parseable DICOM JSON body — per-instance outcomes are unknown`,
      });
      sweepChunk(built, `the server answered HTTP ${res.status} but its body could not be parsed`);
      return { httpOk: false, httpStatus: res.status };
    }

    const summary = applyStowResponse(built, body);
    if (summary.unmatched.length) {
      log.warn(
        `${label}: the server's response mentioned ${summary.unmatched.length} SOP Instance UID(s) ` +
          'this request never sent — ignoring them'
      );
    }
    const swept = sweepChunk(built, `the server's HTTP ${res.status} response did not mention this instance`);
    if (swept > 0) {
      studyLedger.addEvent({
        kind: 'protocol',
        message: `${label}: the HTTP ${res.status} response did not account for ${swept} instance(s)`,
      });
    }
    return { httpOk: true, httpStatus: res.status };
  }

  // HTTP-level refusal: the whole chunk failed as one, before any
  // per-instance judgement was made.
  const translated = translateHttpFailure(res.status, 'stow');
  for (const line of translated) log.warn(line);
  studyLedger.addEvent({
    kind: 'http',
    message: `${label}: ${translated[0]} [HTTP ${res.status}]`,
  });
  sweepChunk(built, `the whole request was refused with HTTP ${res.status}`);
  return { httpOk: false, httpStatus: res.status };
}

/**
 * Sends one chunk, retrying the instances that failed retryably.
 *
 * Mirrors the DIMSE sendChunkWithRetry: per-instance retryability is judged
 * by the failure reason on the entry (isRetryableStatus — the codes are the
 * same table), and a chunk whose HTTP failure is permanent (403, 404, 413…)
 * is not attempted again, because it will not improve.
 *
 * @param {object} params stowChunk params plus {retries: number}.
 * @returns {Promise<void>}
 */
async function stowChunkWithRetry(params) {
  const { entries, retries, label } = params;

  let attempt = 0;
  let working = entries;

  for (;;) {
    const { httpOk, httpStatus } = await stowChunk({
      ...params,
      entries: working,
      label: `${label} attempt ${attempt + 1}`,
    });

    // UNANSWERED/NOT_ATTEMPTED entries carry no status and are always worth
    // retrying (subject to the chunk-level check below); FAILED entries are
    // retried only when their failure reason is transient.
    const outstanding = working.filter((e) => e.retryable && isRetryableStatus(e.status));
    const acknowledged = working.length - outstanding.length;

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

    if (!httpOk && !isRetryableHttp(httpStatus)) {
      log.debug(`${label}: HTTP ${httpStatus ?? '(no status)'} is not retryable, not attempting again`);
      return;
    }

    attempt += 1;
    log.warn(
      `${label}: ${acknowledged}/${working.length} accepted — ` +
        `retrying ${outstanding.length} instance(s) (attempt ${attempt + 1} of ${retries + 1})`
    );

    for (const entry of outstanding) entry.resetForRetry();
    working = outstanding;
  }
}

/**
 * Resolves everything dcm web send needs from flags/environment.
 * Split out of run() so option handling is testable without touching disk
 * or network.
 *
 * @param {Map} flags
 * @returns {{dryRun: boolean, recurse: boolean, chunkSize: number, retries: number, web: object|undefined}}
 */
function resolveSendOptions(flags) {
  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });
  const recurse = !flags.has('no-recurse');
  const chunkSize = args.resolve(flags, {
    name: 'chunk', env: 'DCM_WEB_CHUNK', type: 'number', fallback: 50,
  });
  const retries = args.resolve(flags, { name: 'retry', type: 'number', fallback: 1 });

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new args.UsageError(`--chunk must be a positive integer, got "${chunkSize}".`);
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new args.UsageError(`--retry must be zero or a positive integer, got "${retries}".`);
  }

  // A dry run opens no connection, so the URL is only required when we will
  // actually use it — same reasoning as dcm send with its host/port.
  const web = dryRun ? undefined : resolveWebOptions(flags);

  return { dryRun, recurse, chunkSize, retries, web };
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
    throw new args.UsageError('Missing folder. Usage: dcm web send <folder> --url https://…/dicom-web');
  }

  const { dryRun, recurse, chunkSize, retries, web } = resolveSendOptions(flags);
  const asJson = flags.has('json');

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
    report.dryRun({ scanned, chunkSize, rewriteSeriesUid: false });
    // A dry run that found unreadable files should still say so loudly.
    return scanned.readErrors.length > 0 ? 1 : 0;
  }

  // --- Send, study by study ---
  let bytesOnDisk = 0;
  for (const studyLedger of ledger.studies.values()) {
    for (const entry of studyLedger.entries) bytesOnDisk += entry.bytes || 0;
  }

  const metrics = { requests: 0, startedAt: Date.now() };
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
      `  ${entries.length} instance(s) in ${chunks.length} request(s) of up to ${chunkSize}`
    );

    for (let i = 0; i < chunks.length; i++) {
      const label = `study ${studyIndex} chunk ${i + 1}/${chunks.length}`;
      log.info(`  ${label}: sending ${chunks[i].length} instance(s)`);

      await stowChunkWithRetry({
        entries: chunks[i],
        studyUid: studyLedger.studyInstanceUid,
        studyLedger,
        web,
        metrics,
        retries,
        label,
      });

      const soFar = studyLedger.reconcile();
      log.info(`  ${label}: ${soFar.acknowledged}/${soFar.found} accepted so far`);
    }
  }

  // --- Reconcile and report ---
  const elapsedMs = Date.now() - metrics.startedAt;
  const result = ledger.reconcile();

  if (asJson) {
    log.out(JSON.stringify({
      ok: result.ok,
      url: web.baseUrl,
      found: result.totals.found,
      sent: result.totals.sent,
      acknowledged: result.totals.acknowledged,
      failed: result.totals.failed,
      warned: result.totals.warning,
      shortfall: result.totals.shortfall,
      chunkSize,
      requests: metrics.requests,
      elapsedMs,
      bytesOnDisk,
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  report.transfer({
    result,
    connection: { url: web.baseUrl },
    chunkSize,
    rewriteSeriesUid: false,
  });
  log.out('');
  log.out(`elapsed           ${(elapsedMs / 1000).toFixed(2)}s in ${metrics.requests} request(s)`);

  return result.ok ? 0 : 1;
}

module.exports = {
  run,
  USAGE,
  applyStowResponse,
  describeFailureReason,
  isRetryableHttp,
  resolveSendOptions,
  sweepChunk,
};
