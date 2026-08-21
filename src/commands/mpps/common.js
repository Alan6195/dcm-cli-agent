'use strict';

/**
 * Flag resolution and result rendering shared by the mpps verbs.
 *
 * Not a verb. `start` and `perform` take the same twenty-odd attribute flags
 * and the same connection, and `complete`, `discontinue` and `perform` all
 * have to explain the same four ways an N-service round trip can go wrong.
 * Keeping one copy of each is what stops the three verbs drifting into three
 * slightly different accounts of the same protocol.
 */

const log = require('../../lib/log');
const args = require('../../lib/args');
const json = require('../../lib/json');
const statusLib = require('../../lib/status');
const { resolveTimeouts } = require('../../lib/dimse');
const { formatOutcome } = require('../../lib/reject');
const mpps = require('../../lib/mpps');

/** Connection flags every verb accepts. */
const CONNECTION_FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae',
  'timeout', 'connect-timeout', 'association-timeout',
];

/** Scheduled- and performed-step attribute flags, shared by start and perform. */
const ATTRIBUTE_FLAGS = [
  'from-worklist', 'index', 'first',
  'study-uid', 'accession', 'patient-id', 'patient-name', 'patient-birth-date',
  'patient-sex', 'modality', 'requested-procedure-id',
  'requested-procedure-description', 'scheduled-step-id', 'step-id',
  'step-description', 'station-name', 'station-ae', 'location',
  'start-date', 'start-time', 'mpps-uid', 'unscheduled',
];

/** Flags that build PerformedSeriesSequence from a folder scan. */
const SERIES_FROM_FLAGS = ['series-from', 'no-recurse', 'retrieve-ae'];

/**
 * The verbatim-injection flag, accepted by every verb that sends a dataset.
 *
 * Its own list rather than a member of one of the three above, because it is
 * neither a connection detail nor a step attribute: it is the escape hatch out
 * of the attribute model altogether.
 */
const INJECTION_FLAGS = ['set'];

// --- --set: stamping a value in verbatim -----------------------------------

/**
 * The `--set` implementation, taken from `dcm find` rather than rewritten.
 *
 * The two halves of this feature shipped a release apart, and the thing that
 * would make them unusable is drift: a tokenizer that splits on a different
 * `=`, a path syntax that accepts `.` here and `/` there, one half refusing a
 * private tag and the other silently dropping it. Sharing the parser makes
 * that impossible rather than merely unlikely, and it is why the banner wording
 * below is find's wording with the dataset named.
 *
 * Required lazily: `dcm mpps complete` should not pay for find's query
 * machinery to discover that --set was not given.
 *
 * @returns {object} find's injection helpers.
 */
function injectionLib() {
  return require('../find');
}

/**
 * Parses --set into resolved injections. See find.js parseInjections().
 *
 * @param {Map} flags
 * @returns {Array<{path: Array<object>, value: string, label: string, tag: string}>}
 */
function parseInjections(flags) {
  return injectionLib().parseInjections(flags);
}

/**
 * Stamps the injected values into a dataset, last, so they win.
 *
 * Applied after the dataset is built from the attribute flags and the worklist,
 * precisely so --set can overwrite what either produced. Nothing is validated
 * and nothing is routed: an attribute named without a path goes in at the top
 * level, where the caller put it.
 *
 * @param {Record<string, unknown>} dataset
 * @param {Array<object>} injections
 */
function applyInjections(dataset, injections) {
  injectionLib().applyInjections(dataset, injections);
}

/**
 * Refuses to send when an injected value would not survive the encoder.
 *
 * The same promise find makes, and for the same reason: dcmjs SHORTENS a value
 * longer than its VR's maximum without failing, so `--set
 * PerformedStationAETitle=STATIONNAMETOOLONG` would leave as a perfectly legal
 * 16-character AE Title, the SCP would answer 0x0000, and a test written to
 * prove the SCP rejects an over-long AE Title would pass without ever having
 * asked. Stopping before the association is the only way the flag means what
 * it says.
 *
 * @param {object} request An NCreateRequest or NSetRequest with its dataset set.
 * @param {Array<object>} injections
 */
function verifyInjections(request, injections) {
  if (!injections.length) return;
  injectionLib().verifyInjections(request, injections);
}

/**
 * Encodes the dataset and refuses if an injected value did not survive.
 *
 * Called once per verb, right after the injections are applied, so that BOTH
 * the dry run and the live send are covered by the same check. A dry run is
 * where a person reads the dataset and decides whether to send it; printing one
 * that the writer would then shorten would be the false reassurance --set
 * exists to remove.
 *
 * A no-op when nothing was injected, so an ordinary run pays nothing for it.
 *
 * @param {'N-CREATE'|'N-SET'} kind
 * @param {string} mppsSopInstanceUid
 * @param {Record<string, unknown>} dataset
 * @param {Array<object>} injections
 */
function verifyDataset(kind, mppsSopInstanceUid, dataset, injections) {
  if (!injections.length) return;
  const request = kind === 'N-CREATE'
    ? mpps.createRequest(mppsSopInstanceUid, dataset)
    : mpps.setRequest(mppsSopInstanceUid, dataset);
  verifyInjections(request, injections);
}

/**
 * The banner shown whenever --set is in use.
 *
 * Loud, on stderr, and unconditional, because a dataset carrying a deliberately
 * malformed value looks exactly like a dataset this tool built wrong. stderr
 * rather than stdout so --json stays one document; the same facts also go into
 * the document as `injected`, so --quiet cannot produce a run that does not say
 * what it did.
 *
 * @param {Array<object>} injections
 * @param {string} what 'N-CREATE' or 'N-SET'.
 * @returns {string}
 */
function injectionBanner(injections, what) {
  const lines = [
    `--set is stamping ${injections.length} attribute${injections.length === 1 ? '' : 's'} ` +
      `into the ${what} dataset verbatim.`,
    '        Nothing about these values was checked — not length, not character',
    '        repertoire, not enumeration, and not whether a UID is a UID. A refusal',
    '        from the peer may be the peer answering exactly what it was asked.',
  ];
  for (const injection of injections) {
    lines.push(`          ${injection.tag} ${injection.label} = ${JSON.stringify(injection.value)}`);
  }
  return lines.join('\n');
}

/**
 * The record of what was injected, for the JSON document and the table.
 *
 * Same three keys as `dcm find` emits, so one consumer reads both.
 *
 * @param {Array<object>} injections
 * @returns {Array<{tag: string, attribute: string, value: string}>}
 */
function injectionSummary(injections) {
  return injections.map((i) => ({ tag: i.tag, attribute: i.label, value: i.value }));
}

/**
 * The Type 1 attributes --set has taken responsibility for.
 *
 * An attribute the operator typed a value for is one they decided about, so
 * assertCreatable() stops checking it — including when the value is empty,
 * which is the one question about an SCP that cannot be asked any other way.
 * Every attribute nobody named is still checked, so the accidental empty Type 1
 * this tool exists to prevent stays prevented.
 *
 * @param {Array<object>} injections
 * @returns {Set<string>}
 */
function exemptKeywords(injections) {
  const exempt = new Set();
  for (const injection of injections) {
    for (const step of injection.path) exempt.add(step.keyword);
  }
  return exempt;
}

/**
 * Announces --set on stdout when the document will not carry it.
 *
 * The banner is on stderr and --quiet silences stderr, so a human-mode run must
 * also say it where the product is. In --json mode the `injected` array is that
 * record and this stays quiet, because a second document on stdout parses as
 * neither.
 *
 * @param {Array<object>} injections
 * @param {boolean} asJson
 * @param {string} what
 */
function reportInjections(injections, asJson, what) {
  if (!injections.length) return;
  log.warn(log.color.yellow(injectionBanner(injections, what)));
  if (asJson) return;
  log.out('');
  log.out(log.color.yellow(
    `--set stamped ${injections.map((i) => `${i.label}=${JSON.stringify(i.value)}`).join(', ')} ` +
      `into the ${what} verbatim.`
  ));
}

/**
 * Reads a flag that takes no value, and says so when one was swallowed.
 *
 * The parser gives a flag the next token unless that token is another flag, so
 * `dcm mpps update --no-status 2.25.1` reads the UID as the value of
 * --no-status and then reports a missing UID — two lies about one typo. The
 * flags here never take a value, so a value is always this mistake.
 *
 * @param {Map} flags
 * @param {string} name
 * @param {string} [swallowedHint] What the swallowed token probably was.
 * @returns {boolean}
 */
function booleanFlag(flags, name, swallowedHint) {
  const raw = flags.get(name);
  if (typeof raw === 'string') {
    throw new args.UsageError(
      `--${name} takes no value, but "${raw}" was read as one` +
        (swallowedHint ? ` — that looks like ${swallowedHint}` : '') +
        `.\nPut --${name} after the positional argument, or write it last.`
    );
  }
  if (Array.isArray(raw)) {
    throw new args.UsageError(`--${name} was given more than once.`);
  }
  return flags.has(name);
}

/**
 * Every value of a repeatable flag, in the order they were typed.
 *
 * args.resolve() refuses a repeated flag, which is right for a hostname and
 * wrong for --study-uid: one performed step may fulfil several scheduled steps,
 * and PS3.3 represents that as several items in
 * ScheduledStepAttributesSequence.
 *
 * @param {Map} flags
 * @param {string} name
 * @returns {string[]}
 */
function repeatedValues(flags, name) {
  if (!flags.has(name)) return [];
  const raw = flags.get(name);
  const list = Array.isArray(raw) ? raw : [raw];
  for (const value of list) {
    if (value === true) throw new args.UsageError(`--${name} expects a value.`);
  }
  return list.map((value) => String(value));
}

/**
 * The worklist provenance block, for the JSON document.
 *
 * Which row of which document became this step is the first thing anyone asks
 * when a step is attributed to the wrong order, and with `--from-worklist -`
 * there is no file left on disk to go back and look at. Recording it is the
 * only way the answer survives the run.
 *
 * @param {object} source From resolveAttributes().
 * @returns {{worklist?: object}}
 */
function worklistSource(source) {
  if (!source?.worklist) return {};
  return {
    worklist: {
      source: source.worklist,
      fromStdin: Boolean(source.worklistFromStdin),
      items: source.worklistItems,
      index: source.worklistIndex,
      selectedBy: source.worklistSelectedBy,
    },
  };
}

/**
 * Reads --index as a 1-based row number.
 *
 * 1-based because the refusal it answers already prints the rows numbered from
 * 1, and a selector that disagrees with the list it selects from is a trap
 * rather than a convenience.
 *
 * @param {Map} flags
 * @returns {number|undefined}
 */
function readIndexFlag(flags) {
  if (!flags.has('index')) return undefined;
  const raw = flags.get('index');
  if (raw === true) throw new args.UsageError('--index expects a row number, e.g. --index 2.');
  if (Array.isArray(raw)) throw new args.UsageError('--index was given more than once.');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new args.UsageError(
      `--index expects a whole number of 1 or more, got "${raw}". Rows are numbered from 1, ` +
        'the way the refusal that lists them numbers them.'
    );
  }
  return n;
}

/**
 * Resolves the MPPS peer.
 *
 * @param {Map} flags
 * @returns {{host: string, port: number, calledAe: string, callingAe: string}}
 */
function resolveConnection(flags) {
  const host = args.resolve(flags, {
    name: 'host', env: 'DCM_HOST', required: true, describe: 'the MPPS peer hostname',
  });
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
  return { host, port, calledAe, callingAe };
}

/**
 * Resolves the storage peer for `mpps perform`.
 *
 * The images and the procedure step very often go to different systems — the
 * archive takes the images, the RIS or a broker takes the MPPS. Each --store-*
 * flag therefore falls back to the corresponding MPPS value, and the caller is
 * expected to print which of the two it ended up using: a default that is
 * invisible is a default nobody can check.
 *
 * @param {Map} flags
 * @param {object} mppsConnection
 * @returns {{host: string, port: number, calledAe: string, callingAe: string, inherited: string[]}}
 */
function resolveStoreConnection(flags, mppsConnection) {
  const inherited = [];

  let host = args.resolve(flags, { name: 'store-host' });
  if (host === undefined) { host = mppsConnection.host; inherited.push('--store-host'); }

  let port = args.resolve(flags, { name: 'store-port', type: 'number' });
  if (port === undefined) { port = mppsConnection.port; inherited.push('--store-port'); }
  else port = args.validatePort(port, 'store-port');

  let calledAe = args.resolve(flags, { name: 'store-called-ae' });
  if (calledAe === undefined) { calledAe = mppsConnection.calledAe; inherited.push('--store-called-ae'); }
  else calledAe = args.validateAeTitle(calledAe, 'store-called-ae');

  return { host, port, calledAe, callingAe: mppsConnection.callingAe, inherited };
}

/**
 * @param {Map} flags
 * @returns {object}
 */
function timeoutsFrom(flags) {
  return resolveTimeouts({
    timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
    connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
    associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
  });
}

/**
 * Resolves the procedure-step attributes from a worklist file and explicit
 * flags, with the flags winning.
 *
 * That precedence is the useful one: the worklist supplies the twelve
 * attributes nobody wants to retype, and a flag corrects the one the worklist
 * got wrong or the operator changed at the console.
 *
 * @param {Map} flags
 * @param {{callingAe: string}} connection
 * @param {Date} [now]
 * @returns {{attrs: object, source: {worklist?: string, worklistItems?: number}}}
 */
function resolveAttributes(flags, connection, now = new Date()) {
  const flagValue = (name) => args.resolve(flags, { name });

  const studyUids = repeatedValues(flags, 'study-uid');
  const unscheduled = booleanFlag(flags, 'unscheduled');

  // The two say opposite things about the same sequence, and picking a winner
  // would mean guessing which one was meant. --unscheduled asserts that no
  // order lies behind this step; --study-uid names the order it came from.
  if (unscheduled && studyUids.length) {
    throw new args.UsageError(
      '--unscheduled and --study-uid ask for opposite things. --unscheduled emits ' +
        'ScheduledStepAttributesSequence as one zero-length item, which is how PS3.3 says ' +
        '"this step fulfils no scheduled step at all"; --study-uid names the study the step ' +
        'is being reconciled against, and it can only live inside a populated item. Drop one.'
    );
  }
  if (unscheduled && flags.has('from-worklist')) {
    throw new args.UsageError(
      '--unscheduled and --from-worklist ask for opposite things. A worklist item IS the ' +
        'scheduled step; an unscheduled step is one that was never scheduled.'
    );
  }
  if (studyUids.length > 1 && flags.has('from-worklist')) {
    throw new args.UsageError(
      `--study-uid was given ${studyUids.length} times alongside --from-worklist. There it ` +
        'is the flag that narrows the file to one item, so several of them describe no ' +
        'single item. Build the multi-step case from flags, or narrow the worklist to one ' +
        'study and pass that.'
    );
  }

  const studyUidFlag = studyUids.length ? studyUids[0] : undefined;
  const accessionFlag = flagValue('accession');

  const first = booleanFlag(flags, 'first');
  const index = readIndexFlag(flags);
  if ((first || index !== undefined) && !flags.has('from-worklist')) {
    throw new args.UsageError(
      `${first ? '--first' : `--index ${index}`} picks a row out of --from-worklist, and no ` +
        'worklist was given, so there are no rows to pick from.'
    );
  }

  let fromWorklist = {};
  const source = {};
  const worklistFile = flagValue('from-worklist');
  if (worklistFile !== undefined) {
    const loaded = mpps.readWorklistFile(worklistFile, {
      studyUid: studyUidFlag,
      accession: accessionFlag,
      index,
      first,
    });
    fromWorklist = mpps.worklistToAttributes(loaded.item);
    source.worklist = loaded.file;
    source.worklistItems = loaded.count;
    source.worklistFromStdin = loaded.fromStdin;
    source.worklistIndex = loaded.index;
    source.worklistSelectedBy = loaded.selectedBy;
    // The item itself, so nothing downstream has to read the document a second
    // time. That used to be merely wasteful; with `--from-worklist -` it is
    // impossible — a pipe is consumed once — and with --index it would repeat
    // the selection from flags that no longer describe it.
    source.worklistItem = loaded.item;
  }

  const pick = (flagName, key) => {
    const v = flagValue(flagName);
    return v !== undefined ? v : (fromWorklist[key] ?? '');
  };

  const attrs = {
    studyInstanceUid: studyUidFlag !== undefined
      ? studyUidFlag
      : (fromWorklist.studyInstanceUid ?? ''),
    // Only set when the step fulfils more than one scheduled step; see
    // mpps.scheduledStepSequence() for what the extra items carry and why.
    scheduledStudyUids: studyUids.length > 1 ? studyUids : undefined,
    unscheduled,
    accessionNumber: pick('accession', 'accessionNumber'),
    patientId: pick('patient-id', 'patientId'),
    patientName: pick('patient-name', 'patientName'),
    patientBirthDate: pick('patient-birth-date', 'patientBirthDate'),
    patientSex: pick('patient-sex', 'patientSex'),
    modality: pick('modality', 'modality'),
    requestedProcedureId: pick('requested-procedure-id', 'requestedProcedureId'),
    requestedProcedureDescription: pick(
      'requested-procedure-description', 'requestedProcedureDescription'
    ),
    scheduledProcedureStepId: pick('scheduled-step-id', 'scheduledProcedureStepId'),
    scheduledProcedureStepDescription: fromWorklist.scheduledProcedureStepDescription ?? '',
    performedProcedureStepDescription: pick(
      'step-description', 'performedProcedureStepDescription'
    ),
    performedStationName: flagValue('station-name') ?? '',
    performedLocation: flagValue('location') ?? '',
    referencedStudySequence: fromWorklist.referencedStudySequence ?? [],
    scheduledProtocolCodeSequence: fromWorklist.scheduledProtocolCodeSequence ?? [],
    procedureCodeSequence: fromWorklist.procedureCodeSequence ?? [],
    referencedPatientSequence: fromWorklist.referencedPatientSequence ?? [],
    startDate: flagValue('start-date') ?? mpps.dicomDate(now),
    startTime: flagValue('start-time') ?? mpps.dicomTime(now),
  };

  // PerformedStationAETitle is Type 1 and is what the archive matches the
  // incoming images against, so it defaults to the AE Title we are actually
  // associating under rather than to nothing.
  const stationAe = flagValue('station-ae');
  attrs.performedStationAeTitle = stationAe !== undefined
    ? args.validateAeTitle(stationAe, 'station-ae')
    : connection.callingAe;

  // PerformedProcedureStepID is Type 1 too. Falling back to the scheduled step
  // ID is what most modalities do and it keeps the two IDs correlatable; when
  // there is no scheduled step either, it stays empty and the Type 1 check
  // refuses rather than inventing one.
  const stepId = flagValue('step-id');
  attrs.performedProcedureStepId = stepId !== undefined
    ? stepId
    : (attrs.scheduledProcedureStepId || '');

  return { attrs, source };
}

/**
 * Builds PerformedSeriesSequence from --series-from, or reports that no source
 * was given at all.
 *
 * The distinction the caller needs is between "no sequence" and "an empty
 * sequence", so `built` is undefined when no folder was named rather than being
 * an empty result. On an N-SET those two are different messages: an absent
 * PerformedSeriesSequence leaves what the SCP holds alone, and a present empty
 * one replaces it with nothing.
 *
 * @param {Map} flags
 * @param {string} retrieveAeTitle
 * @returns {{built: object|undefined, sourceLabel: string, assertedFromDisk: boolean}}
 */
function resolveSeriesFromFolder(flags, retrieveAeTitle) {
  const seriesFrom = args.resolve(flags, { name: 'series-from' });
  if (seriesFrom === undefined) {
    return {
      built: undefined,
      sourceLabel: 'nothing — no performed series was given',
      assertedFromDisk: false,
    };
  }

  // Required lazily: an update that names no folder should not pay for the
  // scanner, and the scanner pulls in the DICOM parser.
  const { scan } = require('../../lib/scan');
  const scanned = scan(seriesFrom, { recurse: !flags.has('no-recurse') });
  const built = mpps.buildPerformedSeriesSequenceFromFolder(scanned.studies, {
    retrieveAeTitle,
    seriesMeta: mpps.seriesMetaFromScan(scanned.studies),
  });
  return { built, sourceLabel: `a scan of ${seriesFrom}`, assertedFromDisk: true };
}

// --- The three AE Titles that decide attribution ---------------------------

/**
 * The AE Titles a performed procedure step is decided by.
 *
 * Three of them, and they are three different keys with three different owners:
 *
 *   calledAe                 tenancy. Which system, and which of its
 *                            configurations, answers at all.
 *   callingAe                identity on the wire. What the peer's access
 *                            control sees, and what the images arrive under.
 *   performedStationAeTitle  ATTRIBUTION. PS3.4 F.7.2-1 Type 1, and the key an
 *                            MPPS SCP files the step under. It defaults to the
 *                            calling AE, and --station-ae detaches the two.
 *
 * The failure this exists for is silent by construction: a step whose
 * PerformedStationAETitle names no station the receiver knows is ACCEPTED —
 * status 0x0000, everything looks fine — and then attributed to nobody, so it
 * never reaches the worklist entry it was meant to close. Nothing on the wire
 * says so. The only place it can be caught is here, before the N-CREATE, by
 * printing what the three are about to be.
 *
 * @param {{callingAe?: string, calledAe?: string, performedStationAeTitle?: string}} spec
 * @returns {object}
 */
function attributionOf(spec) {
  const callingAe = spec.callingAe ?? null;
  const calledAe = spec.calledAe ?? null;
  const performedStationAeTitle = spec.performedStationAeTitle || null;

  return {
    calledAe,
    callingAe,
    performedStationAeTitle,
    // Null rather than false when either side is unknown — a dry run resolves
    // no called AE — because "they disagree" and "nothing said" are different
    // facts and a test should be able to tell them apart.
    performedStationMatchesCallingAe:
      performedStationAeTitle === null || callingAe === null
        ? null
        : performedStationAeTitle === callingAe,
  };
}

/**
 * Prints the three AE Titles on one line, before the N-CREATE goes out.
 *
 * stderr, via log.info, for two reasons: stdout is the command's product and
 * must stay a single JSON document under --json, and this line is wanted on
 * every run rather than only the ones that fail. It is the last moment a
 * mistyped --station-ae can be caught by a person reading the output.
 *
 * @param {object} attribution From attributionOf().
 */
function reportAttribution(attribution) {
  const { callingAe, calledAe, performedStationAeTitle } = attribution;
  log.info(
    `AE  calling ${callingAe ?? '(none)'} · ` +
      `performed station ${performedStationAeTitle ?? '(none)'} · ` +
      `called ${calledAe ?? '(none)'}`
  );

  if (attribution.performedStationMatchesCallingAe !== false) return;

  log.warn(
    `PerformedStationAETitle is ${performedStationAeTitle}, but this association is being ` +
      `opened as ${callingAe}.`
  );
  log.warn(
    [
      '        Those are different keys. The peer authorises on the CALLING AE and files',
      '        the images under it; an MPPS SCP attributes the step on the PERFORMED',
      '        STATION AE. A step naming a station the receiver does not know is accepted,',
      '        answered 0x0000, and then attributed to nobody — nothing on the wire says',
      '        so. That is legitimate when this tool is standing in for a station it is not',
      `        running on; if it is not meant to, drop --station-ae or pass --calling-ae`,
      `        ${performedStationAeTitle}.`,
    ].join('\n')
  );
}

// --- The result envelope ---------------------------------------------------

/**
 * Wraps a verb body so no terminal path can escape without a JSON document.
 *
 * The complaint this answers: `dcm mpps start --json` refusing a Type 1
 * validation error exited 2 with a paragraph of English and an empty stdout,
 * and a CI job cannot branch on prose. Every validation error in this command
 * group is thrown as a UsageError before the first line of output, which is
 * exactly the path a hand-written `if (asJson)` at the end of run() cannot
 * cover. json.guard() covers it because it is outside the body rather than in
 * it.
 *
 * @param {string} verb 'start', 'complete', ...
 * @param {Map} flags
 * @param {() => Promise<number>} fn
 * @returns {Promise<number>}
 */
function guardVerb(verb, flags, fn) {
  return json.guard(`mpps ${verb}`, flags, fn);
}

/** The `--help` path, as a document under --json and as text otherwise. */
function helpFor(verb, flags, usage) {
  return json.help(`mpps ${verb}`, flags, usage);
}

/**
 * Turns an N-service round trip into a verdict.
 *
 * Four outcomes have to be told apart, because they have four different fixes:
 * the association never completed; the peer accepted the association but
 * refused the MPPS presentation context; the context was accepted but no
 * response arrived; and a response arrived carrying a status.
 *
 * Every branch also carries `envelope` — the {outcome, message, detail} triple
 * src/lib/json.js takes — so the prose and the machine-readable record are
 * derived from one decision rather than from two that can disagree. That is the
 * whole point of the discriminator: "the peer refused the MPPS context" and
 * "the peer never answered" are one exit code and one paragraph apart in the
 * prose, and a CI job branching on the paragraph is branching on nothing.
 *
 * @param {object} result From mpps.sendNRequest().
 * @param {string} verb  'N-CREATE' or 'N-SET'.
 * @returns {{ok: boolean, reason: string, lines: string[], status?: object,
 *   envelope: {outcome: string, message: string, detail: object}}}
 */
function describeNResult(result, verb) {
  const { outcome, status, comment, contextAccepted } = result;

  if (outcome.kind !== 'completed') {
    return {
      ok: false,
      reason: 'association',
      lines: formatOutcome(outcome),
      envelope: json.fromAssociationOutcome(outcome),
    };
  }

  if (!contextAccepted) {
    const headline =
      'This peer does not support MPPS: it accepted the association and then refused the ' +
      `presentation context for the Modality Performed Procedure Step SOP Class ` +
      `(${mpps.MPPS_SOP_CLASS}), so the ${verb} was never carried.`;
    return {
      ok: false,
      reason: 'no-mpps-context',
      envelope: {
        // The peer answered and said no. Not a transport fault and not silence:
        // it is a negotiation refusal, which has its own fix — a different host
        // or AE Title — and detail.kind keeps it apart from an A-ASSOCIATE-RJ.
        outcome: json.Outcome.REJECTED,
        message: headline,
        detail: {
          kind: 'no-context',
          label: 'MPPS presentation context refused',
          headline,
          hint:
            'MPPS is frequently handled by a different system from the one that stores ' +
            'images — a RIS or a broker rather than the archive. Check which host and AE ' +
            'Title the site expects MPPS on.',
          retryable: false,
          raw: `presentation context for ${mpps.MPPS_SOP_CLASS} not accepted`,
        },
      },
      lines: [
        'This peer does not support MPPS.',
        '',
        'It accepted the association and then refused the presentation context for the',
        `Modality Performed Procedure Step SOP Class (${mpps.MPPS_SOP_CLASS}), so the`,
        `${verb} was never carried. Nothing was sent and nothing changed on the far end.`,
        '',
        'MPPS is frequently handled by a different system from the one that stores images —',
        'a RIS or a broker rather than the archive. Check which host and AE Title the site',
        'expects MPPS on. Run again with --verbose to see the refused context.',
      ],
    };
  }

  if (status === undefined) {
    const headline =
      `The association was established and released, but the peer never answered the ${verb}. ` +
      'The MPPS presentation context was accepted, so this is not a negotiation problem — the ' +
      'peer took the request and said nothing.';
    return {
      ok: false,
      reason: 'no-response',
      envelope: {
        // Silence AFTER a completed association, which is not the `timeout`
        // outcome: nothing timed out, the association was released normally.
        // The peer accepted the request and declined to answer it.
        outcome: json.Outcome.REJECTED,
        message: headline,
        detail: {
          kind: 'no-response',
          label: 'No N-service response',
          headline,
          hint:
            'Check the peer log at the matching timestamp; nothing here can tell whether it ' +
            'acted on the request or dropped it.',
          retryable: true,
          raw: `association completed without a response to the ${verb}`,
        },
      },
      lines: [
        `The association was established and released, but the peer never answered the ${verb}.`,
        'The MPPS presentation context was accepted, so this is not a negotiation problem —',
        'the peer took the request and said nothing. Check its logs for the matching',
        'timestamp; nothing here can tell whether it acted on the request or dropped it.',
      ],
    };
  }

  const described = statusLib.describe(status, comment);
  if (described.class === statusLib.Class.SUCCESS) {
    return {
      ok: true,
      reason: 'success',
      lines: [],
      status: described,
      // Emitted on success too. `detail.status.code` of "0x0000" is a positive
      // statement that the peer answered about this step, which is what a CI
      // preflight wants on the record — an absent detail proves nothing.
      envelope: {
        outcome: json.Outcome.OK,
        message: `The peer accepted the ${verb} (${described.code} ${described.label}).`,
        detail: json.statusDetail(described),
      },
    };
  }

  const lines = [`${described.code} ${described.label}`, described.plain];
  if (described.hint) lines.push(`  ${described.hint}`);
  if (described.peerComment) lines.push(`  peer said: ${described.peerComment}`);
  return {
    ok: false,
    reason: described.class === statusLib.Class.WARNING ? 'warning' : 'refused',
    lines,
    status: described,
    // The rich status record NewLumen already relies on, generalised into the
    // envelope rather than dropped: detail.status keeps code, value, class,
    // label, plain, hint and the peer's own comment, so a test can assert on
    // the number instead of on the sentence describing it.
    //
    // The message is widened past json.fromStatus()'s to carry the peer's own
    // comment, because that comment is usually the only sentence anywhere that
    // names the attribute the peer objected to — 0x0120 "Missing Attribute"
    // says a Type 1 is absent, and only the comment says which one. Dropping it
    // from `message` to keep it solely in detail.status.peerComment would make
    // the top-level sentence strictly less useful than the one it replaced.
    envelope: {
      ...json.fromStatus(described),
      message: described.peerComment
        ? `${described.plain} The peer said: ${described.peerComment}`
        : described.plain,
    },
  };
}

/**
 * Prints a describeNResult() verdict.
 *
 * @param {object} verdict
 */
function reportNResult(verdict) {
  for (const line of verdict.lines) log.out(line);
}

/**
 * Renders a dataset for `--dry-run`, so what would go on the wire can be read
 * before it does.
 *
 * @param {Record<string, unknown>} dataset
 * @returns {string}
 */
function formatDataset(dataset) {
  return JSON.stringify(dataset, null, 2);
}

module.exports = {
  CONNECTION_FLAGS,
  ATTRIBUTE_FLAGS,
  SERIES_FROM_FLAGS,
  INJECTION_FLAGS,
  booleanFlag,
  readIndexFlag,
  worklistSource,
  repeatedValues,
  parseInjections,
  applyInjections,
  verifyInjections,
  verifyDataset,
  injectionBanner,
  injectionSummary,
  exemptKeywords,
  reportInjections,
  attributionOf,
  reportAttribution,
  guardVerb,
  helpFor,
  resolveSeriesFromFolder,
  resolveConnection,
  resolveStoreConnection,
  timeoutsFrom,
  resolveAttributes,
  describeNResult,
  reportNResult,
  formatDataset,
};
