'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { scan, readMetadata } = require('../../lib/scan');
const { safeUidSegment } = require('../../lib/uid');
const {
  parseMultipartRelated,
  buildMultipartRelated,
  joinUrl,
  attr,
  TAGS,
} = require('../../lib/webdicom');

const FLAGS = ['port', 'host', 'persist', 'root', 'require-token', 'reject-after', 'max-body'];

/**
 * Largest STOW request body the hub will hold, in bytes.
 *
 * The hub buffers each STOW body whole and parses it as a Buffer — the right
 * trade for a test target, where a simple parser is worth more than streaming.
 * That trade is only safe with a ceiling on it: without one, a single mistaken
 * multi-gigabyte POST takes the process out with an allocation failure, and a
 * test target that dies under a bad request is useless precisely when the bad
 * request is what you were trying to reproduce. 512 MB is far above any
 * realistic study and far below anything that threatens the heap.
 */
const DEFAULT_MAX_BODY_MB = 512;

const USAGE = `
dcm web serve — a loopback DICOMweb hub for testing web clients

Runs a small DICOMweb server (STOW-RS, QIDO-RS, WADO-RS) over plain HTTP on
this machine. It is the web mirror of \`dcm scp\`: a receiver you fully
control, useful as a target for exercising a sender, and as a way to
reproduce server-side failures (missing auth, partial stores) locally.

Usage:
  dcm web serve --port <port> [--persist <dir>] [--root <dir>]

Options:
  --port <port>          Port to listen on.                    [env DCM_WEB_SERVE_PORT]
  --host <host>          Interface to bind. Default: 127.0.0.1.
                         Loopback by default on purpose: this hub speaks
                         cleartext HTTP with no TLS, so serving anything
                         beyond this machine must be an explicit choice,
                         never an accident.
  --persist <dir>        Write stored instances to disk, laid out as
                         <dir>/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm
                         Default: parse, count and index each part's
                         metadata, then discard the bytes — the same
                         acknowledge-and-discard mode as \`dcm scp\`.
  --root <dir>           Scan an existing folder at startup and serve it:
                         its studies become queryable over QIDO and, since
                         the files stay on disk, retrievable over WADO.
  --require-token <t>    Reject every request that does not carry
                         "Authorization: Bearer <t>" with 401, to reproduce
                         a client-side auth failure locally. Use a made-up
                         value: a flag value lands in shell history, so a
                         real PACS token must never be passed here.
  --reject-after <n>     Per STOW request, accept n parts and fail every
                         further part with 0xA700 (out of resources). This
                         produces a genuine partial store — HTTP 202 with a
                         FailedSOPSequence — for testing a sender's
                         shortfall accounting.
  --max-body <mb>        Largest STOW request body to accept, in megabytes.
                         A larger body is refused with 413 rather than
                         buffered. Default: ${DEFAULT_MAX_BODY_MB}.           [env DCM_WEB_SERVE_MAX_BODY]
  --verbose              Log per-request detail.

Examples:
  dcm web serve --port 8042 --persist ./received
  dcm web serve --port 8042 --root ./fixtures
  DCM_WEB_URL=http://127.0.0.1:8042 dcm web query PatientID=12345

Note:
  The hub implements the DICOMweb subset most clients actually exercise:
  STOW to /studies, QIDO over studies, series and instances with the common
  matching keys, and WADO retrieval of complete instances. It is honest
  about the edges: /metadata answers 501 rather than pretending, and a
  matching key the hub does not understand is ignored with a warning rather
  than silently matched.

  A STOW body is buffered in memory whole before it is parsed. That is a
  deliberate choice for a test hub — a Buffer-in, parts-out parser is far
  easier to reason about than a streaming one — and --max-body is what keeps
  it safe: past that ceiling the request is refused with 413 rather than
  grown into an out-of-memory crash. Raise it if you genuinely mean to post
  a study larger than ${DEFAULT_MAX_BODY_MB} MB in one request; a real PACS would usually
  rather you sent it in several.
`.trimStart();


/** PN values arrive as a bare string, {Alphabetic}, or a one-element array of either; normalise. */
function pnText(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value.Alphabetic;
  return String(value);
}

/** DICOM single-value matching with * and ? wildcards, per QIDO-RS. */
function wildcardMatch(value, pattern) {
  if (value === undefined || value === null) return false;
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return String(value).toUpperCase() === pattern.toUpperCase();
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(String(value));
}

/**
 * StudyDate matching: a single value, or a range "a-b" with either side open.
 * DA values are YYYYMMDD, so string comparison orders them correctly.
 */
function dateMatch(value, pattern) {
  if (value === undefined || value === null) return false;
  const dash = pattern.indexOf('-');
  if (dash === -1) return String(value) === pattern;
  const lo = pattern.slice(0, dash);
  const hi = pattern.slice(dash + 1);
  const v = String(value);
  if (lo && v < lo) return false;
  if (hi && v > hi) return false;
  return true;
}

/** STOW-RS failure reasons the hub emits (PS3.18 / PS3.4 annex). */
const FAILURE = Object.freeze({
  OUT_OF_RESOURCES: 42752, // 0xA700
  CLASS_INSTANCE_MISMATCH: 43264, // 0xA900 — instance does not match the URL's study
  PROCESSING_FAILURE: 272, // 0x0110 — unparseable or unstorable part
});

/**
 * Builds the DICOMweb hub as a plain node:http server. Exported so tests can
 * drive the shipped request handler in-process — the same reason scp.js
 * exports makeScpClass rather than only run().
 *
 * The instance index lives in this closure:
 *   studyUid -> Map<seriesUid, Map<sopUid, {path?, bytes, meta}>>
 * `path` is present only when the bytes were kept (--persist or --root);
 * without it the instance is queryable but not retrievable.
 *
 * @param {object} config { persistDir?, rootDir?, requireToken?, rejectAfter?, maxBodyBytes? }
 * @param {object} stats  Mutable counters shared with the caller.
 * @returns {import('http').Server}
 */
function createWebServer(config, stats) {
  /** @type {Map<string, Map<string, Map<string, {path?: string, bytes: number, meta: object}>>>} */
  const index = new Map();

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_MB * 1024 * 1024;

  // Requests the hub refused because the client asked wrong — a malformed path,
  // a body past --max-body, an upload abandoned mid-flight. Kept apart from
  // stats.errors on purpose: errors decides the exit code, and a client's
  // syntax mistake must not make an otherwise healthy hub exit 1. An embedder
  // that predates this counter still gets 0 rather than NaN.
  stats.clientErrors ??= 0;

  // Warn once per unsupported matching key, not once per request — the point
  // is honesty about what the hub matches, not a nag on every poll.
  const warnedKeys = new Set();

  // The factory owns this so in-process tests (and any other embedder) get a
  // working persist tree without repeating run()'s setup.
  if (config.persistDir) fs.mkdirSync(config.persistDir, { recursive: true });

  function fileInstance(meta, filePath, bytes) {
    let seriesMap = index.get(meta.studyInstanceUid);
    if (!seriesMap) {
      seriesMap = new Map();
      index.set(meta.studyInstanceUid, seriesMap);
    }
    const seriesUid = meta.seriesInstanceUid;
    let sops = seriesMap.get(seriesUid);
    if (!sops) {
      sops = new Map();
      seriesMap.set(seriesUid, sops);
    }
    if (sops.has(meta.sopInstanceUid)) {
      log.debug(`re-received ${meta.sopInstanceUid}; last one wins`);
    }
    sops.set(meta.sopInstanceUid, { path: filePath, bytes, meta });
  }

  if (config.rootDir) {
    const result = scan(config.rootDir, { recurse: true });
    let indexed = 0;
    for (const study of result.studies.values()) {
      for (const meta of study.instances) {
        if (!meta.seriesInstanceUid) continue;
        fileInstance(meta, meta.path, meta.bytes);
        indexed += 1;
      }
    }
    log.info(`indexed ${indexed} instance(s) from ${config.rootDir}`);
    if (result.readErrors.length) {
      log.warn(`${result.readErrors.length} file(s) under --root could not be read and are not served`);
    }
  }

  // ---- responses ----------------------------------------------------------

  function answer(res, status, headers, body, note) {
    log.info(`${log.color.cyan('->')} ${status}${note ? ` ${note}` : ''}`);
    res.writeHead(status, headers);
    res.end(body);
  }

  function answerText(res, status, text, note) {
    answer(res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, `${text}\n`, note);
  }

  function answerJson(res, status, payload, note) {
    answer(
      res,
      status,
      { 'Content-Type': 'application/dicom+json' },
      JSON.stringify(payload),
      note
    );
  }

  // ---- QIDO ---------------------------------------------------------------

  function unsupportedKeyWarning(key) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    log.warn(`this hub does not match on "${key}"; the key is ignored`);
  }

  /**
   * Applies query params to candidate rows of {values, json} where `values`
   * maps supported keyword AND tag spellings to the raw comparable value and
   * names the match style. Unsupported keys are ignored loudly.
   */
  function applyQuery(searchParams, rows, supported) {
    let matched = rows;
    let limit;
    let offset = 0;

    for (const [key, pattern] of searchParams.entries()) {
      if (key === 'limit') {
        limit = Number(pattern);
        continue;
      }
      if (key === 'offset') {
        offset = Number(pattern);
        continue;
      }
      if (key === 'includefield') {
        // The hub always returns every attribute it knows, so includefield
        // is satisfied by construction.
        log.debug(`includefield=${pattern} — all known attributes are returned anyway`);
        continue;
      }
      const spec = supported[key];
      if (!spec) {
        unsupportedKeyWarning(key);
        continue;
      }
      matched = matched.filter((row) => spec.match(row, pattern));
    }

    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    matched = matched.slice(offset);
    if (Number.isInteger(limit) && limit >= 0) matched = matched.slice(0, limit);
    return matched;
  }

  /** One supported-keys entry under both its keyword and its 8-hex-digit tag. */
  function keyed(keyword, tag, match) {
    return { [keyword]: { match }, [tag]: { match } };
  }

  function studyRows() {
    const rows = [];
    for (const [studyUid, seriesMap] of index) {
      let first;
      const modalities = new Set();
      let instances = 0;
      for (const sops of seriesMap.values()) {
        for (const rec of sops.values()) {
          if (!first) first = rec.meta;
          if (rec.meta.modality) modalities.add(rec.meta.modality);
          instances += 1;
        }
      }
      const patientName = pnText(first.patientName);
      const json = {
        '00080020': attr('DA', first.studyDate),
        '00080050': attr('SH', first.accessionNumber),
        '00080061': attr('CS', ...[...modalities].sort()),
        '00100010': patientName ? { vr: 'PN', Value: [{ Alphabetic: patientName }] } : { vr: 'PN' },
        '00100020': attr('LO', first.patientId),
        '0020000D': attr('UI', studyUid),
        '00201206': attr('IS', seriesMap.size),
        '00201208': attr('IS', instances),
      };
      rows.push({ studyUid, patientName, meta: first, modalities, json });
    }
    return rows;
  }

  const STUDY_KEYS = {
    ...keyed('StudyInstanceUID', '0020000D', (row, p) => row.studyUid === p),
    ...keyed('PatientID', '00100020', (row, p) => wildcardMatch(row.meta.patientId, p)),
    ...keyed('PatientName', '00100010', (row, p) => wildcardMatch(row.patientName, p)),
    ...keyed('StudyDate', '00080020', (row, p) => dateMatch(row.meta.studyDate, p)),
    ...keyed('ModalitiesInStudy', '00080061', (row, p) =>
      [...row.modalities].some((m) => wildcardMatch(m, p))
    ),
  };

  function seriesRows(studyFilter) {
    const rows = [];
    for (const [studyUid, seriesMap] of index) {
      if (studyFilter && studyUid !== studyFilter) continue;
      for (const [seriesUid, sops] of seriesMap) {
        const first = sops.values().next().value.meta;
        const seriesNumber = Number(first.seriesNumber);
        const json = {
          '00080060': attr('CS', first.modality),
          '0020000D': attr('UI', studyUid),
          '0020000E': attr('UI', seriesUid),
          '00200011': attr('IS', Number.isFinite(seriesNumber) ? seriesNumber : undefined),
          '00201209': attr('IS', sops.size),
        };
        rows.push({ studyUid, seriesUid, meta: first, json });
      }
    }
    return rows;
  }

  const SERIES_KEYS = {
    ...keyed('StudyInstanceUID', '0020000D', (row, p) => row.studyUid === p),
    ...keyed('SeriesInstanceUID', '0020000E', (row, p) => row.seriesUid === p),
    ...keyed('Modality', '00080060', (row, p) => wildcardMatch(row.meta.modality, p)),
  };

  function instanceRows(studyFilter, seriesFilter) {
    const rows = [];
    for (const [studyUid, seriesMap] of index) {
      if (studyFilter && studyUid !== studyFilter) continue;
      for (const [seriesUid, sops] of seriesMap) {
        if (seriesFilter && seriesUid !== seriesFilter) continue;
        for (const [sopUid, rec] of sops) {
          const instanceNumber = Number(rec.meta.instanceNumber);
          const json = {
            '00080016': attr('UI', rec.meta.sopClassUid),
            '00080018': attr('UI', sopUid),
            '0020000D': attr('UI', studyUid),
            '0020000E': attr('UI', seriesUid),
            '00200013': attr('IS', Number.isFinite(instanceNumber) ? instanceNumber : undefined),
          };
          rows.push({ studyUid, seriesUid, sopUid, meta: rec.meta, json });
        }
      }
    }
    return rows;
  }

  const INSTANCE_KEYS = {
    ...keyed('StudyInstanceUID', '0020000D', (row, p) => row.studyUid === p),
    ...keyed('SeriesInstanceUID', '0020000E', (row, p) => row.seriesUid === p),
    ...keyed('SOPInstanceUID', '00080018', (row, p) => row.sopUid === p),
    ...keyed('SOPClassUID', '00080016', (row, p) => row.meta.sopClassUid === p),
  };

  function handleQido(res, searchParams, rows, supported, what) {
    const matched = applyQuery(searchParams, rows, supported);
    stats.queries += 1;
    if (matched.length === 0) {
      answer(res, 204, {}, undefined, `(no matching ${what})`);
      return;
    }
    answerJson(res, 200, matched.map((row) => row.json), `(${matched.length} ${what})`);
  }

  // ---- STOW ---------------------------------------------------------------

  /**
   * Buffers a request body, refusing anything past --max-body.
   *
   * Written on events rather than `for await (const chunk of req)` because the
   * loop cannot decline: breaking out of it destroys the request, and a
   * destroyed request takes the socket with it — before the 413 explaining why
   * has reached the client. Here the cap stops the buffering and leaves the
   * connection intact long enough to answer.
   *
   * @param {import('http').IncomingMessage} req
   * @returns {Promise<{body?: Buffer, tooLarge?: boolean, received?: number}>}
   */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let received = 0;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBodyBytes) {
          // Refused, so what has been read is pure cost — drop it now rather
          // than hold a half-gigabyte alive until the handler returns.
          chunks.length = 0;
          req.pause();
          settle(resolve, { tooLarge: true, received });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => settle(resolve, { body: Buffer.concat(chunks) }));
      req.on('error', (err) => settle(reject, err));
      // A client that vanishes mid-upload emits 'close' and never 'end'.
      // Without this the promise never settles and the handler leaks.
      req.on('close', () => {
        if (req.readableEnded) return;
        const err = new Error('the client closed the connection mid-upload');
        err.code = 'DCM_WEB_CLIENT_GONE';
        settle(reject, err);
      });
    });
  }

  /**
   * The address this hub is reachable at, as the client itself addressed it.
   *
   * The scheme is fixed: the hub speaks cleartext HTTP by design. The authority
   * comes from the Host header because that is the one address the client is
   * known to be able to reach, and it is run through the URL parser so a
   * nonsense Host yields no URL rather than a malformed one.
   *
   * @param {import('http').IncomingMessage} req
   * @returns {string|undefined}
   */
  function hubOrigin(req) {
    const host = req.headers.host;
    if (!host) return undefined; // HTTP/1.0 without Host: no address to name.
    try {
      return new URL(`http://${host}`).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * The WADO-RS URL a stored resource can actually be retrieved from, or
   * undefined when the hub cannot honestly name one.
   *
   * Two things have to hold: the client told us an address (Host), and the
   * bytes were kept. In discard mode the hub indexes metadata and throws the
   * bytes away, so any URL it published would answer 404 — and RetrieveURL is
   * Type 2, so leaving it empty is both legal and true, where a link that does
   * not work is neither.
   *
   * @param {import('http').IncomingMessage} req
   * @param {...string} segments Path segments, encoded by joinUrl.
   * @returns {string|undefined}
   */
  function retrieveUrl(req, ...segments) {
    if (!config.persistDir) return undefined;
    const origin = hubOrigin(req);
    return origin ? joinUrl(origin, ...segments) : undefined;
  }

  async function handleStow(req, res, urlStudyUid) {
    let read;
    try {
      read = await readBody(req);
    } catch (err) {
      if (err.code === 'DCM_WEB_CLIENT_GONE') {
        // Nobody left to answer, and nothing the hub did wrong: log it and let
        // the request go. Counting it as an error would taint the exit code
        // over a sender that pressed Ctrl+C.
        stats.clientErrors += 1;
        log.warn(`STOW upload abandoned: ${err.message}`);
        return;
      }
      throw err;
    }

    if (read.tooLarge) {
      // A client sending more than the hub agreed to hold is a client fault,
      // not a hub fault, so it lands in clientErrors and leaves stats.errors —
      // the counter that decides the exit code — alone.
      stats.clientErrors += 1;
      log.warn(
        `STOW body exceeded --max-body (${maxBodyBytes} bytes); refusing it with 413`
      );
      answer(
        res,
        413,
        { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' },
        `This hub buffers STOW bodies in memory and accepts at most ${maxBodyBytes} bytes ` +
          '(--max-body). Send fewer instances per request, or raise the limit.\n',
        '(body too large)'
      );
      // Nothing more is buffered from here: the rest of the upload is bytes the
      // hub will never look at. "Connection: close" is what actually cuts it
      // off — node discards the remainder and tears the socket down once this
      // response has been flushed. Destroying the request here instead would
      // close the socket first, and a close with an unread body in flight sends
      // an RST that can drop the 413 out of the client's receive buffer, making
      // a clear refusal look like an unexplained connection reset.
      return;
    }

    const body = read.body;

    let parts;
    try {
      parts = parseMultipartRelated(body, req.headers['content-type']);
      if (parts.length === 0) throw new Error('the multipart body contains no parts');
    } catch (err) {
      // A body this hub cannot parse is the client's mistake, the same class
      // as a malformed path: it is answered 400 and counted as a client error,
      // so reproducing a bad request never decides that the hub's own run
      // failed.
      stats.clientErrors += 1;
      log.warn(`malformed STOW body: ${err.message}`);
      answerText(res, 400, `Malformed multipart body: ${err.message}`, '(malformed body)');
      return;
    }

    log.info(`${log.color.cyan('<-')} POST ${req.url} (${parts.length} part(s))`);

    // Temp files land next to the persist tree when there is one, so the
    // final placement is a same-volume rename rather than a copy.
    const tmpBase = config.persistDir ?? os.tmpdir();
    const accepted = [];
    const failed = [];

    for (const part of parts) {
      const tmpPath = path.join(tmpBase, `.stow-${crypto.randomUUID()}.tmp`);
      let meta;
      try {
        fs.writeFileSync(tmpPath, part.body);
        meta = readMetadata(tmpPath);
        if (!meta.studyInstanceUid || !meta.seriesInstanceUid || !meta.sopInstanceUid) {
          throw new Error('missing Study/Series/SOP Instance UID');
        }
      } catch (err) {
        stats.rejectedParts += 1;
        log.warn(`unparseable STOW part: ${err.message} — failing it with 0x0110`);
        failed.push({ meta, reason: FAILURE.PROCESSING_FAILURE });
        fs.rmSync(tmpPath, { force: true });
        continue;
      }

      // Posted to /studies/{uid} but the instance belongs elsewhere: PS3.18
      // fails the part with 0xA900 rather than filing it under the wrong study.
      if (urlStudyUid && meta.studyInstanceUid !== urlStudyUid) {
        stats.rejectedParts += 1;
        log.warn(
          `part's StudyInstanceUID ${meta.studyInstanceUid} does not match the URL's ` +
            `${urlStudyUid} — failing it with 0xA900`
        );
        failed.push({ meta, reason: FAILURE.CLASS_INSTANCE_MISMATCH });
        fs.rmSync(tmpPath, { force: true });
        continue;
      }

      // Simulated mid-request resource exhaustion. Never on unless asked for.
      if (config.rejectAfter > 0 && accepted.length >= config.rejectAfter) {
        stats.rejectedParts += 1;
        log.warn(
          `--reject-after ${config.rejectAfter} reached; failing this part with 0xA700 (out of resources)`
        );
        failed.push({ meta, reason: FAILURE.OUT_OF_RESOURCES });
        fs.rmSync(tmpPath, { force: true });
        continue;
      }

      let finalPath;
      if (config.persistDir) {
        // Persist synchronously, before the response. scp.js persists after
        // acknowledging because DIMSE has already committed to the C-STORE-RSP;
        // here the response has not been written yet, and a STOW 200 is the
        // client's proof of storage, so the bytes must be on disk first.
        try {
          const dir = path.join(
            config.persistDir,
            safeUidSegment(meta.studyInstanceUid, 'unknown-study'),
            safeUidSegment(meta.seriesInstanceUid, 'unknown-series')
          );
          fs.mkdirSync(dir, { recursive: true });
          finalPath = path.join(dir, `${safeUidSegment(meta.sopInstanceUid, `instance-${stats.stored + 1}`)}.dcm`);
          fs.renameSync(tmpPath, finalPath);
          log.debug(`persisted to ${finalPath}`);
        } catch (err) {
          stats.rejectedParts += 1;
          stats.errors += 1;
          log.error(`failed to persist ${meta.sopInstanceUid}: ${err.message} — failing the part with 0x0110`);
          failed.push({ meta, reason: FAILURE.PROCESSING_FAILURE });
          fs.rmSync(tmpPath, { force: true });
          continue;
        }
      } else {
        // Discard mode: the metadata is kept for QIDO, the bytes are not.
        fs.rmSync(tmpPath, { force: true });
      }

      fileInstance(meta, finalPath, part.body.length);
      stats.stored += 1;
      log.debug(`stored ${meta.modality ?? '??'} ${meta.sopInstanceUid}`);
      accepted.push({ meta });
    }

    // RetrieveURL (0008,1190) is Type 2 in PS3.18's Store Instances Response
    // Module — required, may be zero-length — both at the response root and in
    // each ReferencedSOPSequence item. Conformance-checking senders read both,
    // so the attribute is always emitted; attr() with no value omits Value,
    // which is exactly the empty-Type-2 shape.
    //
    // The root URL names the study the request stored into. A POST to /studies
    // may carry instances from more than one study, and then no single study
    // URL is true — better zero-length than wrong.
    const storedStudies = new Set(accepted.map(({ meta }) => meta.studyInstanceUid));
    const rootStudyUid = storedStudies.size === 1 ? [...storedStudies][0] : undefined;

    const payload = {
      [TAGS.RETRIEVE_URL]: attr(
        'UR',
        rootStudyUid ? retrieveUrl(req, 'studies', rootStudyUid) : undefined
      ),
    };
    if (accepted.length) {
      payload[TAGS.REFERENCED_SOP_SEQ] = {
        vr: 'SQ',
        Value: accepted.map(({ meta }) => ({
          [TAGS.REF_SOP_CLASS]: attr('UI', meta.sopClassUid),
          [TAGS.REF_SOP_INSTANCE]: attr('UI', meta.sopInstanceUid),
          [TAGS.RETRIEVE_URL]: attr(
            'UR',
            retrieveUrl(
              req,
              'studies', meta.studyInstanceUid,
              'series', meta.seriesInstanceUid,
              'instances', meta.sopInstanceUid
            )
          ),
        })),
      };
    }
    if (failed.length) {
      payload[TAGS.FAILED_SOP_SEQ] = {
        vr: 'SQ',
        Value: failed.map(({ meta, reason }) => ({
          [TAGS.REF_SOP_CLASS]: attr('UI', meta?.sopClassUid),
          [TAGS.REF_SOP_INSTANCE]: attr('UI', meta?.sopInstanceUid),
          [TAGS.FAILURE_REASON]: attr('US', reason),
        })),
      };
    }

    const status = failed.length === 0 ? 200 : accepted.length === 0 ? 409 : 202;
    answerJson(res, status, payload, `(${accepted.length} stored, ${failed.length} failed)`);
  }

  // ---- WADO ---------------------------------------------------------------

  function handleWado(res, studyUid, seriesUid, sopUid) {
    const seriesMap = index.get(studyUid);
    const records = [];
    let known = false;

    if (seriesMap) {
      for (const [suid, sops] of seriesMap) {
        if (seriesUid && suid !== seriesUid) continue;
        for (const [iuid, rec] of sops) {
          if (sopUid && iuid !== sopUid) continue;
          known = true;
          records.push(rec);
        }
      }
    }

    if (!known) {
      stats.notFound += 1;
      answerText(res, 404, 'No such study, series or instance on this hub.', '(not found)');
      return;
    }

    const onDisk = records.filter((rec) => rec.path);
    if (onDisk.length === 0) {
      // The instances were received without --persist, so only their metadata
      // survived. Saying "known but not retained" beats a bare 404.
      stats.notFound += 1;
      answerText(
        res,
        404,
        'These instances were received without --persist, so their bytes were discarded ' +
          'and cannot be retrieved. Restart the hub with --persist or --root.',
        '(bytes not retained)'
      );
      return;
    }
    if (onDisk.length < records.length) {
      log.warn(`${records.length - onDisk.length} matching instance(s) have no retained bytes and are omitted`);
    }

    const { contentType, stream, contentLength } = buildMultipartRelated(
      onDisk.map((rec) => ({
        contentType: 'application/dicom',
        getStream: () => fs.createReadStream(rec.path),
        length: rec.bytes,
      }))
    );

    stats.retrievedInstances += onDisk.length;
    log.info(`${log.color.cyan('->')} 200 (${onDisk.length} instance(s))`);
    const headers = { 'Content-Type': contentType };
    if (contentLength !== undefined) headers['Content-Length'] = contentLength;
    res.writeHead(200, headers);

    // A file indexed at startup can be gone, or unreadable, by the time WADO
    // reaches it. That read failure arrives after the 200 is already on the
    // wire, so there is no status left to change: the body is cut short
    // instead. Truncation is the honest signal — the declared Content-Length
    // and the missing closing boundary both fail the client's own accounting,
    // where a short but well-formed body would quietly look complete.
    //
    // Above all this handler must exist at all: an unhandled 'error' on the
    // source takes down the whole hub, and one unreadable file must never end
    // the process for every other client using it.
    stream.on('error', (err) => {
      stats.errors += 1;
      log.error(`WADO source failed mid-response: ${err.message} — truncating the body`);
      stream.destroy();
      res.destroy();
    });

    // The client hanging up mid-download is ordinary — a viewer closing a tab,
    // a cancelled retrieve. It must not crash the hub either, and it is not a
    // hub fault, so it stays out of stats.errors and off the exit code.
    res.on('error', (err) => {
      log.debug(`WADO response failed: ${err.message} — the client is gone`);
      stream.destroy();
    });

    stream.pipe(res);
  }

  // ---- routing ------------------------------------------------------------

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://hub.invalid');
    const isStow = req.method === 'POST';

    // STOW logs its arrival with the part count, once the body is parsed.
    if (!isStow) {
      log.info(`${log.color.cyan('<-')} ${req.method} ${req.url}`);
    }
    stats.requests += 1;

    if (config.requireToken && req.headers.authorization !== `Bearer ${config.requireToken}`) {
      stats.unauthorized += 1;
      if (isStow) log.info(`${log.color.cyan('<-')} ${req.method} ${req.url}`);
      answer(
        res,
        401,
        { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Bearer' },
        'Unauthorized: this hub requires "Authorization: Bearer <token>" (--require-token).\n',
        '(unauthorized)'
      );
      return;
    }

    let seg;
    try {
      seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      // decodeURIComponent throws URIError on malformed percent-encoding, e.g.
      // GET /studies/%ZZ. That is a client syntax error: it is a 400, not the
      // 500 the catch-all would make of it, and it stays out of stats.errors —
      // one mistyped URL must not decide that the whole run exits 1.
      if (isStow) log.info(`${log.color.cyan('<-')} ${req.method} ${req.url}`);
      stats.clientErrors += 1;
      answerText(
        res,
        400,
        `Malformed percent-encoding in the request path: ${url.pathname}`,
        '(malformed path)'
      );
      return;
    }

    if (isStow && seg[0] === 'studies' && seg.length <= 2) {
      await handleStow(req, res, seg[1]);
      return;
    }

    if (req.method === 'GET') {
      const q = url.searchParams;

      if (seg.length === 1 && seg[0] === 'studies') {
        handleQido(res, q, studyRows(), STUDY_KEYS, 'study(ies)');
        return;
      }
      if (seg.length === 1 && seg[0] === 'series') {
        handleQido(res, q, seriesRows(), SERIES_KEYS, 'series');
        return;
      }
      if (seg.length === 1 && seg[0] === 'instances') {
        handleQido(res, q, instanceRows(), INSTANCE_KEYS, 'instance(s)');
        return;
      }
      if (seg[0] === 'studies' && seg[seg.length - 1] === 'metadata') {
        answerText(res, 501, 'This hub does not serve /metadata; retrieve the instances instead.', '(metadata not implemented)');
        return;
      }
      if (seg.length === 3 && seg[0] === 'studies' && seg[2] === 'series') {
        handleQido(res, q, seriesRows(seg[1]), SERIES_KEYS, 'series');
        return;
      }
      if (seg.length === 5 && seg[0] === 'studies' && seg[2] === 'series' && seg[4] === 'instances') {
        handleQido(res, q, instanceRows(seg[1], seg[3]), INSTANCE_KEYS, 'instance(s)');
        return;
      }
      if (seg.length === 2 && seg[0] === 'studies') {
        handleWado(res, seg[1]);
        return;
      }
      if (seg.length === 4 && seg[0] === 'studies' && seg[2] === 'series') {
        handleWado(res, seg[1], seg[3]);
        return;
      }
      if (seg.length === 6 && seg[0] === 'studies' && seg[2] === 'series' && seg[4] === 'instances') {
        handleWado(res, seg[1], seg[3], seg[5]);
        return;
      }
    }

    stats.notFound += 1;
    answerText(res, 404, `Nothing lives at ${req.method} ${url.pathname} on this hub.`, '(no such route)');
  }

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      stats.errors += 1;
      log.error(`request handling failed: ${err.message}`);
      if (!res.headersSent) {
        answerText(res, 500, `Internal hub error: ${err.message}`, '(internal error)');
      } else {
        res.destroy();
      }
    });
  });
}

/**
 * Runs the hub until interrupted.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const port = args.validatePort(
    args.resolve(flags, { name: 'port', env: 'DCM_WEB_SERVE_PORT', required: true, type: 'number' }),
    'port'
  );
  const host = args.resolve(flags, { name: 'host', fallback: '127.0.0.1' });

  const persistRaw = args.resolve(flags, { name: 'persist' });
  const persistDir = persistRaw ? path.resolve(persistRaw) : undefined;
  if (persistDir) fs.mkdirSync(persistDir, { recursive: true });

  const rootRaw = args.resolve(flags, { name: 'root' });
  const rootDir = rootRaw ? path.resolve(rootRaw) : undefined;

  const requireToken = args.resolve(flags, { name: 'require-token' });
  const rejectAfter = args.resolve(flags, { name: 'reject-after', type: 'number', fallback: 0 });

  const maxBodyMb = args.resolve(flags, {
    name: 'max-body',
    env: 'DCM_WEB_SERVE_MAX_BODY',
    type: 'number',
    fallback: DEFAULT_MAX_BODY_MB,
  });
  if (!(maxBodyMb > 0)) {
    throw new args.UsageError(
      `--max-body must be a positive number of megabytes, got "${maxBodyMb}".`
    );
  }
  const maxBodyBytes = Math.floor(maxBodyMb * 1024 * 1024);

  const stats = {
    requests: 0, stored: 0, rejectedParts: 0, unauthorized: 0,
    queries: 0, retrievedInstances: 0, notFound: 0, clientErrors: 0, errors: 0,
  };

  const config = { persistDir, rootDir, requireToken, rejectAfter, maxBodyBytes };
  const server = createWebServer(config, stats);

  return new Promise((resolve) => {
    let listening = false;

    server.on('error', (err) => {
      stats.errors += 1;
      log.error(`server error: ${err.message}${err.code ? ` [${err.code}]` : ''}`);
      // A failure before the socket is up (port taken, host unassignable) is
      // fatal; afterwards it is logged and the hub keeps serving.
      if (!listening) resolve(1);
    });

    const summarize = () => {
      log.out('');
      log.out('Hub summary');
      log.out(`  requests             : ${stats.requests}`);
      log.out(`  STOW parts stored    : ${stats.stored}`);
      log.out(`  STOW parts rejected  : ${stats.rejectedParts}`);
      log.out(`  QIDO queries         : ${stats.queries}`);
      log.out(`  WADO instances sent  : ${stats.retrievedInstances}`);
      log.out(`  unauthorized         : ${stats.unauthorized}`);
      log.out(`  not found            : ${stats.notFound}`);
      // Split out from errors below because only errors decides the exit code:
      // these are requests the client got wrong, not faults of the hub.
      log.out(`  refused (client)     : ${stats.clientErrors}`);
      log.out(`  errors               : ${stats.errors}`);
      if (persistDir) log.out(`  written to           : ${persistDir}`);
    };

    const shutdown = () => {
      log.info('');
      log.info('shutting down hub');
      try {
        server.close();
      } catch {
        // Already closing.
      }
      summarize();
      resolve(stats.errors > 0 ? 1 : 0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    server.listen(port, host, () => {
      listening = true;
      log.info(`${log.color.green('listening')} on http://${host}:${port}`);
      log.info(`  bind host     : ${host}${host === '127.0.0.1' ? log.color.dim(' (loopback only)') : ''}`);
      log.info(`  persist       : ${persistDir ?? log.color.dim('(index metadata, discard bytes)')}`);
      log.info(`  root index    : ${rootDir ?? log.color.dim('(none)')}`);
      log.info(`  require token : ${requireToken ? 'yes' : log.color.dim('no')}`);
      log.info(`  reject after  : ${rejectAfter > 0 ? `${rejectAfter} part(s) per STOW request` : log.color.dim('never')}`);
      log.info(`  max body      : ${maxBodyMb} MB per STOW request`);
      log.info('  press Ctrl+C to stop');
    });
  });
}

module.exports = { run, USAGE, createWebServer };
