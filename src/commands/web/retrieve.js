'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { validateUid, safeUidSegment } = require('../../lib/uid');
const { readMetadata } = require('../../lib/scan');
const {
  resolveWebOptions,
  webRequest,
  joinUrl,
  parseMultipartRelated,
  translateHttpFailure,
} = require('../../lib/webdicom');
const { translateTransportFailure } = require('../../lib/webdicom');

const FLAGS = ['url', 'timeout', 'insecure', 'study', 'series', 'instance', 'out'];

const USAGE = `
dcm web retrieve — retrieve a study from a DICOMweb server (WADO-RS)

Usage:
  dcm web retrieve --url <base> --study <uid> [--series <uid> [--instance <uid>]] --out <dir>

Retrieved instances are written as
  <out>/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm
— the same layout dcm scp --persist produces, so either can serve as the
local mirror for the other's tooling.

Options:
  --url <base>       DICOMweb base URL, with any path prefix the server roots
                     the API under, e.g. https://pacs.example.org/dicom-web
                                                             [env DCM_WEB_URL]
  --study <uid>      Study Instance UID to retrieve.
  --series <uid>     Narrow the retrieve to one series within the study.
  --instance <uid>   Narrow to one SOP instance (requires --series).
  --out <dir>        Directory to write into. Created if missing.
  --timeout <ms>     Whole-request timeout. Default: 60000.  [env DCM_WEB_TIMEOUT]
  --insecure         Skip TLS certificate verification (test servers only).
  --json             Emit the retrieval accounting as JSON.

Authentication:
  Credentials come from the environment and nowhere else — a flag would land
  in shell history and process listings:
    DCM_WEB_TOKEN                Bearer token
    DCM_WEB_USER / DCM_WEB_PASS  HTTP Basic

Examples:
  dcm web retrieve --url https://pacs.example.org/dicom-web --study 1.2.840.113619.2.1 --out ./pulled
  dcm web retrieve --url https://pacs.example.org/dicom-web --study 1.2.840.113619.2.1 --series 1.2.840.113619.2.1.1 --out ./pulled

Note: the request asks for transfer-syntax=*, which means "the bytes as
stored". Without that parameter many servers transcode every instance to
Explicit VR Little Endian — or answer 406 for ones they cannot transcode —
so a retrieve could silently return different bytes than were stored. The
whole response is downloaded before any part is written, so give a
multi-gigabyte study a --timeout to match.

A server that cannot produce every instance may answer 206 Partial Content.
What it did send is parsed and written — those bytes are already here — and
the report says PARTIAL. The exit code is still non-zero: an incomplete study
is not a successful retrieve.
`.trimStart();


/**
 * Writes multipart parts to disk as <out>/<study>/<series>/<sop>.dcm.
 *
 * Each part is written to a temporary file first and read back through the
 * same metadata parser the scanner uses, because the part's own headers
 * cannot be trusted to say which instance it is — the UIDs must come from
 * the DICOM bytes themselves. Only a part that parses is renamed into place;
 * one that does not is counted as unreadable and its temp file removed, so a
 * corrupt download can never masquerade as a stored instance.
 *
 * The temp file lives inside outDir so the rename is same-volume and atomic.
 *
 * @param {Array<{headers: object, body: Buffer}>} parts Parsed multipart parts.
 * @param {string} outDir Destination root (must exist).
 * @returns {{written: Array<{path: string, studyUid?: string, seriesUid?: string, sopUid?: string}>, unreadable: Array<{index: number, reason: string}>, duplicates: Array<{index: number, firstIndex: number, sopUid: string, path: string}>}}
 */
function persistParts(parts, outDir) {
  const written = [];
  const unreadable = [];
  const duplicates = [];

  // Destinations this response has already claimed, dest → part index.
  //
  // fs.renameSync overwrites without complaint, so two parts carrying the
  // same SOP Instance UID would both be counted as written while the
  // filesystem held one file. The written count has to be the number of files
  // that exist, so a repeat is reported as its own outcome instead. Only
  // collisions *within this response* are a lie; overwriting a file left by an
  // earlier run is a re-retrieve and stays silent.
  const claimed = new Map();

  for (let i = 0; i < parts.length; i++) {
    const tmp = path.join(outDir, `.retrieve-${process.pid}-${i}.tmp`);
    try {
      fs.writeFileSync(tmp, parts[i].body);
      const meta = readMetadata(tmp);
      if (!meta.sopInstanceUid) {
        throw new Error('no SOPInstanceUID in the dataset');
      }

      const dir = path.join(
        outDir,
        safeUidSegment(meta.studyInstanceUid, 'unknown-study'),
        safeUidSegment(meta.seriesInstanceUid, 'unknown-series')
      );
      const dest = path.join(dir, `${safeUidSegment(meta.sopInstanceUid, `instance-${i + 1}`)}.dcm`);

      if (claimed.has(dest)) {
        // Either the server sent one instance twice, or two different
        // datasets share a SOP Instance UID. One file can live at that path
        // either way, so the first arrival is kept and this part is reported
        // rather than written over it — a silent overwrite would leave the
        // operator with a count that does not match the disk, and hide a UID
        // collision that is worth knowing about.
        const firstIndex = claimed.get(dest);
        duplicates.push({ index: i, firstIndex, sopUid: meta.sopInstanceUid, path: dest });
        log.warn(
          `part ${i + 1} carries SOPInstanceUID ${meta.sopInstanceUid}, already written by part ` +
            `${firstIndex + 1} — the first copy was kept and this one was not stored`
        );
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // Nothing to clean up if it is already gone.
        }
        continue;
      }

      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(tmp, dest);
      claimed.set(dest, i);

      written.push({
        path: dest,
        studyUid: meta.studyInstanceUid,
        seriesUid: meta.seriesInstanceUid,
        sopUid: meta.sopInstanceUid,
      });
      log.debug(`part ${i + 1} -> ${dest}`);
    } catch (err) {
      // Counted, never dropped — the operator must learn that the server sent
      // something this tool could not keep.
      unreadable.push({ index: i, reason: err.message });
      log.warn(`part ${i + 1} could not be stored as DICOM: ${err.message}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // The temp file may never have been created.
      }
    }
  }

  return { written, unreadable, duplicates };
}

/** Validates a UID flag value, translating the reason into the usage error. */
function requireValidUid(value, flagName) {
  const verdict = validateUid(value);
  if (!verdict.valid) {
    throw new args.UsageError(`--${flagName} is not a valid UID: ${verdict.reason}.`);
  }
  return value;
}

/**
 * @param {{flags: Map, positionals: string[], pairs: Array<[string,string]>}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const studyUid = requireValidUid(
    args.resolve(flags, { name: 'study', required: true, describe: 'the Study Instance UID to retrieve' }),
    'study'
  );
  const seriesRaw = args.resolve(flags, { name: 'series' });
  const seriesUid = seriesRaw ? requireValidUid(seriesRaw, 'series') : undefined;
  const instanceRaw = args.resolve(flags, { name: 'instance' });
  const instanceUid = instanceRaw ? requireValidUid(instanceRaw, 'instance') : undefined;
  if (instanceUid && !seriesUid) {
    throw new args.UsageError('--instance needs --series to say which series the instance lives in.');
  }

  const outDir = path.resolve(
    args.resolve(flags, { name: 'out', required: true, describe: 'the directory to write into' })
  );

  const web = resolveWebOptions(flags);
  const asJson = flags.has('json');

  const segments = ['studies', studyUid];
  if (seriesUid) segments.push('series', seriesUid);
  if (instanceUid) segments.push('instances', instanceUid);
  const url = joinUrl(web.baseUrl, ...segments);

  fs.mkdirSync(outDir, { recursive: true });

  log.info(`WADO-RS retrieve -> ${url}`);
  log.info(`  writing into ${outDir}`);

  /**
   * The single JSON document a failing --json run owes stdout.
   *
   * `dcm web retrieve --json | jq .` has to receive one JSON document on
   * every path, including the ones where the server never answered — printing
   * prose to stdout instead leaves the reader with nothing parseable, and the
   * MCP layer's jsonResult is built on that invariant. dcm web ping sets the
   * contract; this follows it. The explanation rides inside the document so
   * nothing is lost, and the headline goes to stderr where it cannot corrupt
   * the pipe.
   *
   * @param {number|null} status HTTP status, or null when none arrived.
   * @param {string[]} lines The human-readable explanation.
   * @returns {number} Exit code, always 1.
   */
  const jsonFailure = (status, lines) => {
    log.out(JSON.stringify({
      url,
      studyUid,
      ok: false,
      status,
      partial: false,
      received: 0,
      written: 0,
      duplicates: 0,
      unreadable: 0,
      outDir,
      error: lines,
    }, null, 2));
    return 1;
  };

  let res;
  try {
    res = await webRequest({
      method: 'GET',
      url,
      headers: {
        ...web.headers,
        Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*',
      },
      timeoutMs: web.timeoutMs,
      insecure: web.insecure,
    });
  } catch (err) {
    const lines = translateTransportFailure(err);
    log.error('WADO-RS retrieve failed');
    if (asJson) return jsonFailure(null, lines);
    for (const line of lines) log.out(line);
    return 1;
  }

  // 200 is the whole resource. 206 Partial Content is a server — dcm4chee-arc
  // does this when some instances are unavailable — saying it could not
  // produce every instance and is sending the ones it has. The body is still
  // a well-formed multipart response carrying real instances, so it is parsed
  // and written exactly as a 200 is: discarding bytes already downloaded onto
  // this machine helps nobody. The run still fails, because the study on disk
  // is not the study that was asked for.
  const partial = res.status === 206;

  if (res.status !== 200 && !partial) {
    const lines = translateHttpFailure(res.status, 'wado');
    if (res.status === 404) {
      log.error('the server does not hold that study (or roots its DICOMweb service elsewhere)');
    } else {
      log.error(`WADO-RS retrieve failed (HTTP ${res.status})`);
    }
    if (asJson) return jsonFailure(res.status, lines);
    for (const line of lines) log.out(line);
    return 1;
  }

  if (partial) {
    log.warn(
      'the server answered HTTP 206 Partial Content — this is part of the study, not all of it'
    );
  }

  let parts;
  try {
    parts = parseMultipartRelated(res.body, res.headers['content-type']);
  } catch (err) {
    const reason = `the response could not be split into instances: ${err.message}`;
    log.error(reason);
    return asJson ? jsonFailure(res.status, [reason]) : 1;
  }

  const received = parts.length;
  log.info(`  received ${received} part${received === 1 ? '' : 's'} (${res.body.length} bytes)`);

  const { written, unreadable, duplicates } = persistParts(parts, outDir);

  // Anything short of "the whole study arrived and every instance is on disk"
  // is a failure, the same rule dcm send applies to an unacknowledged
  // instance. A duplicate SOP instance counts as a shortfall too: fewer files
  // exist than the server sent parts for.
  const ok = !partial && received > 0 && unreadable.length === 0 && duplicates.length === 0;

  if (asJson) {
    log.out(JSON.stringify({
      url,
      studyUid,
      ok,
      status: res.status,
      partial,
      received,
      written: written.length,
      duplicates: duplicates.length,
      unreadable: unreadable.length,
      outDir,
    }, null, 2));
    return ok ? 0 : 1;
  }

  if (received === 0) {
    log.error(`the server answered ${res.status} with zero instances — an empty multipart body`);
    log.out('Nothing was retrieved. The study exists as a resource but the response carried no parts.');
    return 1;
  }

  log.out('');
  if (partial) {
    // Loud and above the numbers: the counts below are honest about what
    // arrived, and say nothing about what did not.
    log.out(log.color.yellow('PARTIAL CONTENT — the server sent part of this study, not all of it.'));
    log.out('');
  }
  log.out('Retrieve summary');
  log.out(`  instances received : ${received}`);
  log.out(`  written            : ${written.length}`);
  log.out(`  duplicates         : ${duplicates.length}`);
  log.out(`  unreadable         : ${unreadable.length}`);
  log.out(`  written to         : ${outDir}`);

  if (partial) {
    log.out('');
    log.out(
      log.color.dim(
        'HTTP 206 means the server could not produce every instance of this study and\n' +
          'returned the ones it could. What arrived was written and is counted above, but\n' +
          'the study is incomplete, which is why this exits non-zero. The instances that\n' +
          'are missing are missing on the server; its own logs will say why.'
      )
    );
  }

  if (duplicates.length > 0) {
    log.out('');
    log.out(
      log.color.dim(
        'Duplicate parts carried a SOP Instance UID another part had already written. The\n' +
          'first copy was kept and the repeat discarded, so the written count is the number\n' +
          'of files on disk. Either the server sent an instance twice, or two different\n' +
          'instances share a UID — run dcm info --series over the output to tell which.'
      )
    );
  }

  if (unreadable.length > 0) {
    log.out('');
    log.out(
      log.color.dim(
        'Unreadable parts were downloaded but did not parse as DICOM, so they were not\n' +
          'kept. Re-run with --verbose to see each failure; if it persists, the server is\n' +
          'sending something other than application/dicom parts for those instances.'
      )
    );
  }

  return ok ? 0 : 1;
}

module.exports = { run, USAGE, persistParts };
