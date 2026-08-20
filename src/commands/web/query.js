'use strict';

const dcmjs = require('dcmjs');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { validateUid } = require('../../lib/uid');
const {
  resolveWebOptions,
  webRequest,
  joinUrl,
  buildQuery,
  translateHttpFailure,
} = require('../../lib/webdicom');
const { translateTransportFailure } = require('../../lib/webdicom');

const { DicomMetaDictionary } = dcmjs.data;

const FLAGS = ['url', 'timeout', 'insecure', 'series', 'instances', 'limit', 'offset', 'include'];

const USAGE = `
dcm web query — query a DICOMweb server (QIDO-RS)

Usage:
  dcm web query --url <base> [--series|--instances] [key=value ...]

Levels:
  (default)     Study-level query      GET {base}/studies
  --series      Series-level query     GET {base}/series — or, when the
                matching keys include StudyInstanceUID=<uid>,
                GET {base}/studies/<uid>/series
  --instances   Instance-level query   GET {base}/instances — or, when both
                StudyInstanceUID and SeriesInstanceUID are given,
                GET {base}/studies/<uid>/series/<uid>/instances

Matching keys are bare key=value pairs using DICOM keywords or 8-digit hex
tags (PatientID=12345, 00100020=12345). Values take * and ? wildcards, and
date ranges with a hyphen (StudyDate=20260101-20260131).

Options:
  --url <base>       DICOMweb base URL, with any path prefix the server roots
                     the API under, e.g. https://pacs.example.org/dicom-web
                                                             [env DCM_WEB_URL]
  --limit <n>        Ask the server for at most n matches.
  --offset <n>       Skip the first n matches (paging, together with --limit).
  --include <attr>   Ask for an attribute beyond the server's default set
                     (QIDO-RS includefield). May be repeated.
  --timeout <ms>     Whole-request timeout. Default: 60000.  [env DCM_WEB_TIMEOUT]
  --insecure         Skip TLS certificate verification (test servers only).
  --json             Emit matches as JSON.

Authentication:
  Credentials come from the environment and nowhere else — a flag would land
  in shell history and process listings:
    DCM_WEB_TOKEN                Bearer token
    DCM_WEB_USER / DCM_WEB_PASS  HTTP Basic

Examples:
  dcm web query --url https://pacs.example.org/dicom-web PatientID=12345
  dcm web query --url https://pacs.example.org/dicom-web PatientName=DOE* StudyDate=20260101-20260131
  dcm web query --url https://pacs.example.org/dicom-web --series StudyInstanceUID=1.2.840...
  dcm web query --url https://pacs.example.org/dicom-web --instances Modality=CT --include NumberOfFrames --limit 50

Note: QIDO string matching is exact unless the value carries a wildcard. The
C-FIND habit of PatientName=DOE finds only a patient literally named "DOE";
you almost always want PatientName=DOE*. Zero matches exits with code 1 — it
is an answer of "nothing", not proof the data is absent, since servers differ
on case sensitivity and fuzzy matching, and some index new arrivals late.
`.trimStart();

/**
 * Hex tag → DICOM keyword, inverted once from the dcmjs dictionary.
 *
 * DICOM JSON keys attributes by 8-hex-digit tag; people read keywords. Built
 * lazily because the dictionary walk is only worth paying for when a response
 * actually needs rendering.
 */
let keywordByTag;

/**
 * Resolves an 8-hex-digit tag to its DICOM keyword, or undefined for private
 * and retired tags the dictionary does not name.
 *
 * @param {string} tag e.g. '0020000D'
 * @returns {string|undefined}
 */
function keywordFor(tag) {
  if (!keywordByTag) {
    keywordByTag = new Map();
    for (const [keyword, entry] of Object.entries(DicomMetaDictionary.nameMap)) {
      const hex = String(entry.tag ?? '').replace(/[(),]/g, '').toUpperCase();
      if (/^[0-9A-F]{8}$/.test(hex) && !keywordByTag.has(hex)) {
        keywordByTag.set(hex, keyword);
      }
    }
  }
  return keywordByTag.get(String(tag).toUpperCase());
}

/**
 * True when a UID match value is a single plain UID, and so has a meaningful
 * URL-path form.
 *
 * PS3.18 allows a UID match key to carry a backslash-separated list —
 * StudyInstanceUID=1.2.3\1.2.4 matches either study — and a list has no path
 * form at all: percent-encoded into one segment it names a study that cannot
 * exist, so a two-study query silently becomes a zero-match one. The same
 * goes for anything else that is not a bare UID. Those values stay in the
 * query string, where list matching is exactly what the server implements.
 *
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isSinglePathUid(value) {
  return typeof value === 'string' && validateUid(value).valid;
}

/**
 * Chooses the QIDO-RS resource path for a level, narrowing into the study
 * hierarchy when the matching keys pin it down — the same decision dcm find
 * makes with its --series/--image levels, translated to URL form.
 *
 * Narrowing needs a UID that identifies one resource, so only a single plain
 * UID moves into the path; a list-of-UIDs match value stays a query
 * parameter. A UID that does move is removed from the query parameters:
 * PS3.18 already scopes the narrowed resource by it, and some servers reject
 * the same UID arriving a second time as a match key.
 *
 * @param {'studies'|'series'|'instances'} level
 * @param {Array<[string, string]>} pairs Matching keys from the tokenizer.
 * @returns {{segments: string[], queryPairs: Array<[string, string]>}}
 */
function buildQidoTarget(level, pairs) {
  const given = new Map(pairs);
  const studyUid = given.get('StudyInstanceUID');
  const seriesUid = given.get('SeriesInstanceUID');

  if (level === 'series' && isSinglePathUid(studyUid)) {
    return {
      segments: ['studies', studyUid, 'series'],
      queryPairs: pairs.filter(([k]) => k !== 'StudyInstanceUID'),
    };
  }

  if (level === 'instances' && isSinglePathUid(studyUid) && isSinglePathUid(seriesUid)) {
    return {
      segments: [
        'studies', studyUid,
        'series', seriesUid,
        'instances',
      ],
      queryPairs: pairs.filter(([k]) => k !== 'StudyInstanceUID' && k !== 'SeriesInstanceUID'),
    };
  }

  return { segments: [level], queryPairs: pairs };
}

/**
 * Builds the full QIDO-RS request URL.
 *
 * @param {string} baseUrl
 * @param {'studies'|'series'|'instances'} level
 * @param {Array<[string, string]>} pairs
 * @param {{limit?: number, offset?: number, includefields?: string[]}} [opts]
 * @returns {string}
 */
function buildQidoUrl(baseUrl, level, pairs, opts = {}) {
  const { segments, queryPairs } = buildQidoTarget(level, pairs);
  return joinUrl(baseUrl, ...segments) + buildQuery(queryPairs, opts);
}

/**
 * Renders one DICOM JSON attribute as printable text.
 *
 * Multi-valued attributes join with a backslash, the delimiter DICOM itself
 * uses. Person Names render as their Alphabetic component group. Sequences
 * are summarised rather than dumped, matching how src/lib/tags.js prints
 * datasets.
 *
 * @param {{vr?: string, Value?: Array<*>, BulkDataURI?: string, InlineBinary?: string}} attribute
 * @returns {string}
 */
function displayAttribute(attribute) {
  if (!attribute || typeof attribute !== 'object') return '';
  const { vr, Value } = attribute;

  if (!Array.isArray(Value) || Value.length === 0) {
    // DICOM JSON omits Value entirely for an empty attribute; binary values
    // arrive out-of-band instead.
    if (attribute.BulkDataURI) return `<bulk data at ${attribute.BulkDataURI}>`;
    if (attribute.InlineBinary) return '<binary, inline>';
    return '';
  }

  if (vr === 'SQ') return `<sequence, ${Value.length} item${Value.length === 1 ? '' : 's'}>`;

  return Value.map((item) => {
    if (item === undefined || item === null) return '';
    if (typeof item === 'object') {
      // PN in DICOM JSON is { Alphabetic, Ideographic, Phonetic }; some
      // servers send a bare string anyway, which the string branch covers.
      if (item.Alphabetic !== undefined) return String(item.Alphabetic);
      return JSON.stringify(item);
    }
    return String(item);
  }).join('\\');
}

/**
 * Flattens one DICOM JSON match into a keyword → display-string object.
 *
 * Tags the dictionary cannot name — private tags, mostly — keep their hex
 * form rather than being dropped, for the same reason dcm tags labels them:
 * they are exactly the attributes people need to be able to see.
 *
 * @param {object} dataset A DICOM JSON dataset from a QIDO response.
 * @returns {Record<string, string>}
 */
function flattenMatch(dataset) {
  const row = {};
  for (const [tag, attribute] of Object.entries(dataset ?? {})) {
    if (!/^[0-9A-Fa-f]{8}$/.test(tag)) continue;
    const key = keywordFor(tag) ?? tag.toUpperCase();
    row[key] = displayAttribute(attribute);
  }
  return row;
}

/**
 * @param {{flags: Map, positionals: string[], pairs: Array<[string,string]>}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags, pairs } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const levels = ['series', 'instances'].filter((l) => flags.has(l));
  if (levels.length > 1) {
    throw new args.UsageError('Choose one query level, not --series and --instances.');
  }
  // --series/--instances are switches. Catching a stray value here matters:
  // `--series 1.2.3` would otherwise silently swallow the UID and query for
  // something different than what was typed.
  for (const l of levels) {
    if (flags.get(l) !== true) {
      throw new args.UsageError(
        `--${l} takes no value; give the UID as a matching key, e.g. ` +
          (l === 'series' ? 'StudyInstanceUID=<uid>.' : 'SeriesInstanceUID=<uid>.')
      );
    }
  }
  const level = levels[0] ?? 'studies';

  const limit = args.resolve(flags, { name: 'limit', type: 'number' });
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new args.UsageError(`--limit must be a positive integer, got "${limit}".`);
  }
  const offset = args.resolve(flags, { name: 'offset', type: 'number' });
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new args.UsageError(`--offset must be zero or a positive integer, got "${offset}".`);
  }

  // Repeatable, so it can arrive as a string or an array; args.resolve
  // deliberately throws on arrays.
  const includeRaw = flags.get('include');
  const includefields = includeRaw === undefined
    ? undefined
    : (Array.isArray(includeRaw) ? includeRaw : [includeRaw]).map((v) => {
        if (v === true) {
          throw new args.UsageError('--include expects an attribute keyword or 8-digit hex tag.');
        }
        return String(v);
      });

  const web = resolveWebOptions(flags);
  const asJson = flags.has('json');

  const url = buildQidoUrl(web.baseUrl, level, pairs, { limit, offset, includefields });

  log.info(`QIDO-RS (${level}) query -> ${web.baseUrl}`);
  if (pairs.length) {
    log.info(`  matching on: ${pairs.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  } else {
    log.info('  no matching keys given — this asks for everything the server will page out');
  }

  /**
   * The single JSON document a failing --json run owes stdout.
   *
   * `dcm web query --json | jq .` has to receive one JSON document on every
   * path, including the ones where the server never answered — printing prose
   * to stdout instead leaves the reader with nothing parseable, and the MCP
   * layer's jsonResult is built on that invariant. dcm web ping sets the
   * contract; this follows it. The explanation rides inside the document so
   * nothing is lost, and the headline goes to stderr where it cannot corrupt
   * the pipe.
   *
   * @param {number|null} status HTTP status, or null when none arrived.
   * @param {string[]} lines The human-readable explanation.
   * @returns {number} Exit code, always 1.
   */
  const jsonFailure = (status, lines) => {
    log.out(JSON.stringify(
      { url, level, ok: false, status, count: 0, matches: [], error: lines },
      null,
      2
    ));
    return 1;
  };

  let res;
  try {
    res = await webRequest({
      method: 'GET',
      url,
      headers: { ...web.headers, Accept: 'application/dicom+json' },
      timeoutMs: web.timeoutMs,
      insecure: web.insecure,
    });
  } catch (err) {
    const lines = translateTransportFailure(err);
    log.error('QIDO-RS query failed');
    if (asJson) return jsonFailure(null, lines);
    for (const line of lines) log.out(line);
    return 1;
  }

  let datasets = [];
  if (res.status === 200) {
    const text = res.body.toString('utf8').trim();
    if (text !== '') {
      try {
        datasets = JSON.parse(text);
      } catch (err) {
        const reason = `the server answered 200 but the body is not JSON: ${err.message}`;
        log.error(reason);
        return asJson ? jsonFailure(res.status, [reason]) : 1;
      }
      if (!Array.isArray(datasets)) {
        const reason =
          'the server answered 200 with JSON that is not an array of matches — not a QIDO-RS response.';
        log.error(reason);
        return asJson ? jsonFailure(res.status, [reason]) : 1;
      }
    }
  } else if (res.status !== 204) {
    // 204 No Content is QIDO's "zero matches" and falls through with an
    // empty list; anything else is a failure to translate.
    const lines = translateHttpFailure(res.status, 'qido');
    log.error(`QIDO-RS query failed (HTTP ${res.status})`);
    if (asJson) return jsonFailure(res.status, lines);
    for (const line of lines) log.out(line);
    return 1;
  }

  const matches = datasets.map(flattenMatch);

  if (asJson) {
    // ok reports that the server answered the query properly, the same sense
    // dcm web ping gives it. Zero matches is a proper answer, so it is ok:true
    // with count 0 — and still exit 1, because "nothing" is the result the
    // caller has to act on.
    log.out(JSON.stringify(
      { url, level, ok: true, status: res.status, count: matches.length, matches },
      null,
      2
    ));
    return matches.length > 0 ? 0 : 1;
  }

  if (matches.length === 0) {
    log.out('');
    log.out('0 matches.');
    log.out('');
    log.out(
      log.color.dim(
        'The server answered; nothing matched these keys. QIDO string matching is exact\n' +
          'unless the value carries a * wildcard — PatientName=DOE matches only a patient\n' +
          'literally named DOE. If the data was stored moments ago, the server may also\n' +
          'not have indexed it yet.'
      )
    );
    return 1;
  }

  // Columns are the union of returned attributes, ordered by tag number so
  // the table reads like every other DICOM dumper regardless of which match
  // happened to arrive first.
  const tagSet = new Set();
  for (const dataset of datasets) {
    for (const tag of Object.keys(dataset ?? {})) {
      if (/^[0-9A-Fa-f]{8}$/.test(tag)) tagSet.add(tag.toUpperCase());
    }
  }
  const columns = [...tagSet].sort().map((tag) => keywordFor(tag) ?? tag);

  const rows = matches.map((m) => columns.map((c) => m[c] ?? ''));
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));

  log.out('');
  log.out(columns.map((c, i) => c.padEnd(widths[i])).join('  '));
  log.out(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    log.out(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
  }
  log.out('');
  log.out(`${matches.length} match${matches.length === 1 ? '' : 'es'}.`);

  return 0;
}

module.exports = { run, USAGE, buildQidoTarget, buildQidoUrl, flattenMatch, displayAttribute, keywordFor };
