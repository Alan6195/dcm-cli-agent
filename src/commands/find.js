'use strict';

const log = require('../lib/log');
const args = require('../lib/args');
const statusLib = require('../lib/status');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');

const { CFindRequest } = dcmjsDimse.requests;

const FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae', 'study', 'series', 'image', 'mwl',
  'timeout', 'connect-timeout', 'association-timeout', 'limit',
];

const USAGE = `
dcm find — query a peer (C-FIND)

Usage:
  dcm find --host <host> --port <port> --called-ae <AE> [--study|--series|--image|--mwl] [key=value ...]

Levels:
  --study     Study-level query (default)
  --series    Series-level query — requires StudyInstanceUID=<uid>
  --image     Instance-level query — requires StudyInstanceUID and SeriesInstanceUID
  --mwl       Modality Worklist query

Matching keys are given as bare key=value pairs using DICOM keywords. Values
support the usual DICOM matching: * and ? wildcards, and date ranges with a
hyphen. A key with an empty value is requested but not matched on.

Options:
  --host <host>          Peer hostname.                    [env DCM_HOST]
  --port <port>          Peer DIMSE port.                  [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.              [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI    [env DCM_CALLING_AE]
  --limit <n>            Stop after n matches.
  --json                 Emit matches as JSON.
  --verbose              Log the full association negotiation.

Examples:
  dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE PatientID=12345
  dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE --study StudyDate=20260101-20260131
  dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE --series StudyInstanceUID=1.2.840...
  dcm find --host pacs.example.org --port 11112 --called-ae WORKLIST --mwl Modality=CT

Note: a peer that accepted your images may still return zero matches for them.
Storing and indexing are different operations, and store-and-forward receivers
often do not answer queries for data they have accepted. Zero matches here does
not by itself mean the transfer failed.
`.trimStart();

/** Keys requested at each level when the caller does not name their own. */
const DEFAULT_KEYS = {
  study: [
    'StudyInstanceUID', 'PatientName', 'PatientID', 'StudyDate', 'StudyTime',
    'AccessionNumber', 'StudyDescription', 'ModalitiesInStudy',
    'NumberOfStudyRelatedSeries', 'NumberOfStudyRelatedInstances',
  ],
  series: [
    'StudyInstanceUID', 'SeriesInstanceUID', 'SeriesNumber', 'Modality',
    'SeriesDescription', 'NumberOfSeriesRelatedInstances',
  ],
  image: [
    'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID',
    'SOPClassUID', 'InstanceNumber',
  ],
  mwl: [
    'PatientName', 'PatientID', 'AccessionNumber', 'Modality',
    'ScheduledProcedureStepStartDate', 'ScheduledProcedureStepStartTime',
    'ScheduledStationAETitle', 'RequestedProcedureDescription',
  ],
};

/** Columns printed per level, in order. */
const COLUMNS = {
  study: ['PatientName', 'PatientID', 'StudyDate', 'ModalitiesInStudy', 'NumberOfStudyRelatedInstances', 'StudyDescription', 'StudyInstanceUID'],
  series: ['SeriesNumber', 'Modality', 'NumberOfSeriesRelatedInstances', 'SeriesDescription', 'SeriesInstanceUID'],
  image: ['InstanceNumber', 'SOPInstanceUID'],
  mwl: ['PatientName', 'PatientID', 'Modality', 'ScheduledProcedureStepStartDate', 'ScheduledProcedureStepStartTime', 'RequestedProcedureDescription'],
};

/**
 * Builds the identifier for the query: caller-supplied matching keys, plus the
 * level's default return keys as empty strings so the peer sends them back.
 *
 * @param {string} level
 * @param {Array<[string, string]>} pairs
 * @returns {Record<string, string>}
 */
function buildIdentifier(level, pairs) {
  const elements = {};
  for (const key of DEFAULT_KEYS[level]) elements[key] = '';
  for (const [key, value] of pairs) elements[key] = value;
  return elements;
}

/**
 * Formats an element value for display.
 *
 * dcmjs returns Person Names as objects and multi-valued elements as arrays,
 * so neither can be interpolated directly.
 */
function display(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.map(display).filter(Boolean).join('\\');
  if (typeof value === 'object') {
    // Person Name: { Alphabetic: 'DOE^JANE' }
    if (value.Alphabetic) return String(value.Alphabetic);
    return JSON.stringify(value);
  }
  return String(value);
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

  const levels = ['study', 'series', 'image', 'mwl'].filter((l) => flags.has(l));
  if (levels.length > 1) {
    throw new args.UsageError(
      `Choose one query level, not ${levels.map((l) => `--${l}`).join(' and ')}.`
    );
  }
  const level = levels[0] ?? 'study';

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
  const limit = args.resolve(flags, { name: 'limit', type: 'number' });
  const asJson = flags.has('json');

  const timeouts = resolveTimeouts({
    timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
    connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
    associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
  });

  // Hierarchical queries need their parent UIDs, and a peer's error for a
  // missing one is usually opaque. Fail here with something readable instead.
  const given = new Map(pairs);
  if (level === 'series' && !given.has('StudyInstanceUID')) {
    throw new args.UsageError('--series requires StudyInstanceUID=<uid> to say which study to look inside.');
  }
  if (level === 'image' && (!given.has('StudyInstanceUID') || !given.has('SeriesInstanceUID'))) {
    throw new args.UsageError('--image requires both StudyInstanceUID=<uid> and SeriesInstanceUID=<uid>.');
  }

  const identifier = buildIdentifier(level, pairs);

  const builders = {
    study: CFindRequest.createStudyFindRequest,
    series: CFindRequest.createSeriesFindRequest,
    image: CFindRequest.createImageFindRequest,
    mwl: CFindRequest.createWorklistFindRequest,
  };
  const request = builders[level](identifier);

  log.info(`C-FIND (${level}) ${callingAe} -> ${calledAe} at ${host}:${port}`);
  if (pairs.length) {
    log.info(`  matching on: ${pairs.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  } else {
    log.info('  no matching keys given — this requests everything the peer will return');
  }

  const matches = [];
  let finalStatus;
  let finalComment;
  let cancelled = false;

  request.on('response', (response) => {
    const status = response.getStatus();

    if (statusLib.classify(status) === statusLib.Class.PENDING) {
      if (!response.hasDataset()) return;
      const elements = response.getDataset().getElements();
      matches.push(elements);

      if (limit && matches.length >= limit && !cancelled) {
        cancelled = true;
        log.debug(`reached --limit ${limit}, cancelling the query`);
      }
      return;
    }

    finalStatus = status;
    finalComment = response.getErrorComment();
  });

  const { outcome } = await runAssociation({
    host, port, callingAe, calledAe,
    requests: [request],
    timeouts,
  });

  if (outcome.kind !== 'completed') {
    log.error('C-FIND failed');
    for (const line of formatOutcome(outcome)) log.out(line);
    return 1;
  }

  // The association completing says nothing about the query itself.
  if (finalStatus !== undefined && statusLib.classify(finalStatus) === statusLib.Class.FAILURE) {
    const d = statusLib.describe(finalStatus, finalComment);
    log.error(`the peer refused the query: ${d.code} ${d.label}`);
    log.out(d.plain);
    if (d.hint) log.out(`  ${d.hint}`);
    return 1;
  }

  if (asJson) {
    const plain = matches.map((m) => {
      const row = {};
      for (const [k, v] of Object.entries(m)) {
        if (k.startsWith('_')) continue;
        row[k] = display(v);
      }
      return row;
    });
    log.out(JSON.stringify({ level, host, port, calledAe, count: plain.length, matches: plain }, null, 2));
    return matches.length > 0 ? 0 : 1;
  }

  if (matches.length === 0) {
    log.out('');
    log.out('0 matches.');
    log.out('');
    log.out(
      log.color.dim(
        'Zero matches is not the same as a failed transfer. A receiver can accept\n' +
          'instances via C-STORE and still return nothing here — storing and indexing are\n' +
          'separate operations, and store-and-forward systems frequently do not answer\n' +
          'queries at all for data they have accepted and passed on.\n' +
          '\n' +
          'If you are checking whether a study arrived, query the system that is meant to\n' +
          'hold it rather than the one you sent to, allow for its processing delay, and\n' +
          'confirm this AE Title is permitted to query as well as to store.'
      )
    );
    return 1;
  }

  const columns = COLUMNS[level];
  const rows = matches.map((m) => columns.map((c) => display(m[c])));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => r[i].length))
  );

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

module.exports = { run, USAGE, buildIdentifier, display };
