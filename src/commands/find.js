'use strict';

const log = require('../lib/log');
const args = require('../lib/args');
const statusLib = require('../lib/status');
const vr = require('../lib/vr');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');

const { CFindRequest } = dcmjsDimse.requests;

const FLAGS = [
  'json-raw', 'check-vr', 'set',
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
  --json                 Emit matches as JSON, values rendered for reading.
  --json-raw             Emit matches as JSON with values exactly as they came
                         off the wire — sequences stay arrays, Person Names stay
                         objects, and nothing is parsed into a number. Carries a
                         per-element sidecar. See below. This is the form to
                         feed to 'dcm mpps', which needs the correlation keys
                         intact; --json flattens a sequence to a string and
                         cannot carry them.
  --check-vr             Report every VR conformance violation in what the peer
                         returned, and exit 1 if there are any. See below.
  --set <Key>=<Value>    Stamp a value into the outgoing identifier verbatim,
                         with no client-side validation at all. Repeatable.
                         See below.
  --verbose              Log the full association negotiation.

Examples:
  dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE PatientID=12345
  dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE --study StudyDate=20260101-20260131
  dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE --series StudyInstanceUID=1.2.840...
  dcm find --host pacs.example.org --port 11112 --called-ae WORKLIST --mwl Modality=CT
  dcm find --host pacs.example.org --port 11112 --called-ae WORKLIST --mwl ScheduledStationAETitle=CT01 ScheduledProcedureStepStartDate=20260819

Modality Worklist:
  Modality, ScheduledStationAETitle, ScheduledProcedureStepStartDate/Time,
  ScheduledProcedureStepDescription/ID/Status and ScheduledPerformingPhysicianName
  belong inside the Scheduled Procedure Step Sequence, not at the top level.
  Give them as ordinary key=value pairs and they are placed there for you, and
  the scheduling fields in the answer are flattened back out for reading. This
  is the usual reason a hand-built worklist query returns nothing at all.

What --json-raw means by raw:
  Every value is carried as the text that arrived. A DICOM parser normally
  repairs as it reads — a Decimal String becomes a JS number, and PatientWeight
  sent as "12.5 kg" arrives as 12.5 with the unit silently gone. That repair is
  correct when you are consuming a study and wrong when you are testing the
  peer that sent it, because the violation disappears before you can see it.
  So the received octets are read again here, at the octet level, and no value
  is ever turned into a number.

  Each match also carries "_elements", a sidecar keyed by tag:

    "_elements": {
      "(0010,1030)": { "vr": "DS", "length": 8, "keyword": "PatientWeight",
                       "vm": 1, "value": "12.5 kg" }
    }

  "length" is the Value Length field as received, padding octet included, so an
  odd length is visible directly. "value" is the same text as the flat value.
  A sequence entry carries "items" instead, one sidecar per item. An entry
  lifted out of the Scheduled Procedure Step Sequence carries "from" naming it.
  A "vrSource" of "dictionary" means the peer sent no VR — see the note below.

Note: the flat values keep the shape they always had, so an existing consumer
  keeps working. "_elements" is additive and, because it starts with an
  underscore, is discarded by the same rule that already discards dcmjs
  bookkeeping keys — including by 'dcm mpps --from-worklist', which reads this
  output. The one value that does change shape is a DS or IS: it is now the
  text that arrived rather than a number, which is the whole point.

VR conformance (--check-vr):
  Reports what is wrong with the elements the peer actually returned: values
  over the VR maximum (LO 64, SH 16, PN 64 per component group, AE 16, CS 16,
  DS 16, IS 12, UI 64), lowercase or non-enumerated Code Strings, Decimal and
  Integer Strings carrying non-numeric characters, odd-length value fields, and
  a backslash creating a second value against an attribute defined as VM 1.

  One line per violation, and "vrViolations" in JSON mode. It exits 1 when it
  finds any, so it can be a CI gate rather than something to read. It is off by
  default: this command's job is to report a query, and turning every worklist
  lookup into a conformance audit would bury that.

Note: under Implicit VR Little Endian the peer sends no VR, so ours comes from
  the data dictionary and every length and grammar check is derived from the
  standard rather than from what the peer emitted. Those elements are marked
  "vrSource": "dictionary" in the sidecar. Negotiate Explicit VR if you need
  the peer's own VR on the record.

Injecting a value (--set):
  --set <Keyword|(gggg,eeee)>=<Value> puts the value into the C-FIND identifier
  exactly as typed. Nothing is checked: not the length, not the VR's character
  repertoire, not an enumeration. It is applied last, so it overwrites a
  default return key or a matching key naming the same attribute, and it is NOT
  routed into the Scheduled Procedure Step Sequence the way a bare key=value
  pair is — name the path if that is where you want it:

    --set PatientSex=male
    --set (0010,1030)=12.5 kg
    --set ScheduledProcedureStepSequence/Modality=ct

  This is the explicit "I know what I am doing" path. No other flag implies it.
  A banner naming every injected attribute is printed on stderr whenever it is
  in use, and because --quiet silences stderr the injections are ALSO recorded
  in the output itself — as "injected" in JSON, and above the table otherwise.
  There is no way to run an injected query and get output that does not say so,
  which is what stops a deliberately odd response being read as a bug here.

Note: an unknown or private tag is refused rather than injected. The encoder
  drops an attribute it has no dictionary entry for without saying so, and a
  query that silently lost the one key it was testing is worse than one that
  never ran.

Note: the built identifier is read back and compared against what was asked
  for, and the query is refused if anything changed. The dataset writer
  enforces the VR maximum and SHORTENS a longer value without failing, so
  --set ScheduledStationAETitle=SCHEDULEDSTATION0020 would otherwise leave as a
  perfectly legal 16-character AE Title, the peer would answer it normally, and
  a test written to prove the peer rejects an over-long AE Title would pass
  without ever having asked. Over-long AE, CS, DS, IS and UI values are refused
  here for that reason. LO and PN are carried at any length, and every other
  kind of malformed value — lowercase, non-enumerated, non-numeric, embedded
  backslash — goes out exactly as typed.

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
    'PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex',
    'AccessionNumber', 'StudyInstanceUID',
    'RequestedProcedureDescription', 'RequestedProcedureID',
  ],
};

/**
 * Worklist keys that live inside the Scheduled Procedure Step Sequence.
 *
 * This is the part of a Modality Worklist query people most often get wrong.
 * Modality, the scheduled station and the scheduled start date/time are not
 * top-level attributes — they are inside ScheduledProcedureStepSequence
 * (0040,0100). Some SCPs are lenient and answer a flat query anyway; a
 * conformant one either ignores the matching (returning the whole worklist) or
 * returns nothing at all, which looks like "the worklist is empty" rather than
 * "the query was malformed". So the sequence is built properly, and a matching
 * key naming one of these is routed into it automatically.
 */
const MWL_SPS_KEYS = [
  'Modality',
  'ScheduledStationAETitle',
  'ScheduledProcedureStepStartDate',
  'ScheduledProcedureStepStartTime',
  'ScheduledProcedureStepDescription',
  'ScheduledPerformingPhysicianName',
  'ScheduledProcedureStepID',
  'ScheduledProcedureStepStatus',
];

/** Columns printed per level, in order. */
const COLUMNS = {
  study: ['PatientName', 'PatientID', 'StudyDate', 'ModalitiesInStudy', 'NumberOfStudyRelatedInstances', 'StudyDescription', 'StudyInstanceUID'],
  series: ['SeriesNumber', 'Modality', 'NumberOfSeriesRelatedInstances', 'SeriesDescription', 'SeriesInstanceUID'],
  image: ['InstanceNumber', 'SOPInstanceUID'],
  mwl: ['PatientName', 'PatientID', 'AccessionNumber', 'Modality', 'ScheduledProcedureStepStartDate', 'ScheduledProcedureStepStartTime', 'ScheduledStationAETitle', 'RequestedProcedureDescription'],
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

  if (level === 'mwl') {
    // Request the whole Scheduled Procedure Step Sequence, with each key
    // present but empty so the peer returns it.
    const sps = {};
    for (const key of MWL_SPS_KEYS) sps[key] = '';
    for (const [key, value] of pairs) {
      if (MWL_SPS_KEYS.includes(key)) sps[key] = value;
      else elements[key] = value;
    }
    elements.ScheduledProcedureStepSequence = [sps];
    return elements;
  }

  for (const [key, value] of pairs) elements[key] = value;
  return elements;
}

/**
 * Lifts Scheduled Procedure Step fields to the top level of a worklist match.
 *
 * The scheduling information a person actually wants to read — modality, when,
 * which station — arrives nested one level down. Flattening it here keeps the
 * table and the JSON flat, which is what every consumer of this output wants.
 * Top-level values already present are never overwritten.
 *
 * @param {Record<string, unknown>} elements
 * @returns {Record<string, unknown>}
 */
function flattenWorklistMatch(elements) {
  const sequence = elements.ScheduledProcedureStepSequence;
  if (!Array.isArray(sequence) || sequence.length === 0) return elements;

  const flattened = { ...elements };
  delete flattened.ScheduledProcedureStepSequence;

  // A step can legitimately appear more than once. The first is the scheduled
  // one in practice; anything beyond it is kept so nothing is silently lost.
  const [first, ...rest] = sequence;
  for (const [key, value] of Object.entries(first || {})) {
    if (key.startsWith('_')) continue;
    if (flattened[key] === undefined || flattened[key] === '') flattened[key] = value;
  }
  if (rest.length) flattened.AdditionalScheduledSteps = String(rest.length);
  return flattened;
}

/**
 * Parses --set into resolved injections.
 *
 * The token is split on the FIRST `=`, so a value may contain as many more as
 * it likes — that is the point of the flag. The target may be a keyword, a
 * `(gggg,eeee)` tag, or a `/`-separated path into a sequence.
 *
 * An unresolvable target is refused here rather than passed on. The dataset
 * encoder drops an attribute it cannot find in the data dictionary and says
 * nothing about it, so a private or mistyped tag would produce a query that
 * quietly lost the one key the run was testing — the exact silent-loss failure
 * this whole flag exists to make impossible.
 *
 * @param {Map} flags
 * @returns {Array<{path: Array<{tag: string, keyword: string, vr: string}>, value: string, label: string}>}
 */
function parseInjections(flags) {
  if (!flags.has('set')) return [];

  const given = flags.get('set');
  if (given === true) {
    throw new args.UsageError('--set expects <Keyword|(gggg,eeee)>=<Value>.');
  }

  const tokens = Array.isArray(given) ? given : [given];
  return tokens.map((token) => {
    const text = String(token);
    const eq = text.indexOf('=');
    if (eq <= 0) {
      throw new args.UsageError(
        `--set "${text}" is not <Keyword|(gggg,eeee)>=<Value>. The first = separates them.`
      );
    }

    const steps = text.slice(0, eq).split('/').map((s) => s.trim()).filter(Boolean);
    if (steps.length === 0) {
      throw new args.UsageError(`--set "${text}" names no attribute before the =.`);
    }

    const path = steps.map((step) => {
      const attribute = vr.resolveAttribute(step);
      if (!attribute) {
        throw new args.UsageError(
          `--set: "${step}" is neither a DICOM keyword nor a (gggg,eeee) tag.`
        );
      }
      if (!attribute.keyword) {
        throw new args.UsageError(
          `--set: ${attribute.tag} is not in the data dictionary, so the encoder would drop ` +
            'it without saying so. Private and unknown tags cannot be injected this way.'
        );
      }
      return attribute;
    });

    for (const step of path.slice(0, -1)) {
      if (step.vr !== 'SQ') {
        throw new args.UsageError(
          `--set: ${step.keyword} has VR ${step.vr}, so it cannot contain ${path[path.length - 1].keyword}. ` +
            'Only a sequence can be a path element.'
        );
      }
    }

    return {
      path,
      value: text.slice(eq + 1),
      label: path.map((p) => p.keyword).join('/'),
      tag: path[path.length - 1].tag,
    };
  });
}

/**
 * Stamps the injected values into the identifier, last, so they win.
 *
 * Applied after the level defaults and after the matching keys precisely so
 * that --set can overwrite either. Nothing is validated and nothing is routed:
 * a scheduled-step attribute named without a path goes in at the top level,
 * where the caller put it.
 *
 * @param {Record<string, unknown>} identifier
 * @param {ReturnType<typeof parseInjections>} injections
 */
function applyInjections(identifier, injections) {
  for (const injection of injections) {
    let target = identifier;
    for (const step of injection.path.slice(0, -1)) {
      let sequence = target[step.keyword];
      if (!Array.isArray(sequence) || sequence.length === 0) {
        sequence = [{}];
        target[step.keyword] = sequence;
      }
      target = sequence[0];
    }
    target[injection.path[injection.path.length - 1].keyword] = injection.value;
  }
}

/**
 * Reads the built identifier back and refuses to send if an injected value
 * did not survive the encoder byte for byte.
 *
 * This is not defensive coding, it is the whole promise of the flag. dcmjs
 * silently TRUNCATES a value longer than its VR's maximum on the way out:
 * --set ScheduledStationAETitle=SCHEDULEDSTATION0020 leaves as the legal
 * 16-character "SCHEDULEDSTATION", the peer answers a conformant query, and
 * the test that was meant to prove the peer rejects an over-long AE Title
 * passes without ever having asked. That is the exact false pass this work
 * exists to remove, so the query is stopped before an association is opened
 * rather than sent under a claim it does not meet.
 *
 * Trailing whitespace is compared loosely because DICOM pads values to an even
 * length and a trailing pad octet is not carryable; everything else must match
 * exactly.
 *
 * @param {object} request
 * @param {ReturnType<typeof parseInjections>} injections
 */
function verifyInjections(request, injections) {
  const dataset = request.getDataset();

  let entries;
  try {
    const parsed = vr.parseElements(
      dataset.getDenaturalizedDataset(),
      dataset.getTransferSyntaxUid()
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    entries = parsed.entries;
  } catch (err) {
    throw new args.UsageError(
      `--set: the identifier could not be encoded and read back, so there is no way to ` +
        `confirm what would go on the wire: ${err.message}`
    );
  }

  const significant = (text) => String(text ?? '').replace(/[ \0]+$/, '');
  const problems = [];

  for (const injection of injections) {
    const actual = findInjected(entries, injection.path);
    if (actual === undefined) {
      problems.push(`  ${injection.label} never reached the identifier`);
    } else if (significant(actual) !== significant(injection.value)) {
      problems.push(
        `  ${injection.label} was given as ${JSON.stringify(injection.value)} ` +
          `(${injection.value.length} characters) but the encoder produced ` +
          `${JSON.stringify(actual)} (${actual.length})`
      );
    }
  }

  if (problems.length === 0) return;

  throw new args.UsageError(
    `--set cannot send these values verbatim, so nothing was sent:\n${problems.join('\n')}\n` +
      'The dataset writer enforces the VR maximum length and shortens a longer value ' +
      'without failing. A query built from a shortened value is conformant, so the peer ' +
      'answers it normally and the test passes without having asked the question. ' +
      'Injecting a value the writer will not carry needs an octet-level sender, not this flag.'
  );
}

/** Walks an entry tree along an injection path and returns the value found. */
function findInjected(entries, path) {
  let current = entries;
  for (const [index, step] of path.entries()) {
    const entry = current.find((e) => e.tag === step.tag);
    if (!entry) return undefined;
    if (index === path.length - 1) return entry.value;
    if (!entry.items || entry.items.length === 0) return undefined;
    current = entry.items[0];
  }
  return undefined;
}

/**
 * The banner shown whenever --set is in use.
 *
 * Loud, on stderr, and unconditional. The capability is indistinguishable from
 * a bug in this tool if it is ever used without being announced — a query that
 * carries a deliberately malformed value looks exactly like a query this tool
 * built wrong. stderr rather than stdout so --json stays one document.
 */
function injectionBanner(injections) {
  const lines = [
    `--set is stamping ${injections.length} attribute${injections.length === 1 ? '' : 's'} ` +
      'into the C-FIND identifier verbatim.',
    '        Nothing about these values was checked — not length, not character',
    '        repertoire, not enumeration. A response that looks wrong may be the',
    '        peer answering exactly what it was asked.',
  ];
  for (const injection of injections) {
    lines.push(`          ${injection.tag} ${injection.label} = ${JSON.stringify(injection.value)}`);
  }
  return lines.join('\n');
}

/**
 * Reads one received dataset back at the octet level.
 *
 * Returns the values as they arrived alongside the sidecar and the parsed
 * entries. When the octets cannot be re-read the naturalized elements are
 * handed back with the reason, so the caller can say that no statement about
 * the wire is possible rather than presenting a repaired value as a raw one.
 *
 * @param {object} dataset A dcmjs-dimse Dataset.
 * @param {string} level
 */
function rawView(dataset, level) {
  const naturalized = stripPrivateKeys(dataset.getElements());
  const parsed = vr.parseDataset(dataset);

  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      values: level === 'mwl' ? flattenWorklistMatch(naturalized) : naturalized,
    };
  }

  // The naturalized elements underneath, the octet-level values on top. The
  // only elements the naturalized layer still supplies are the binary VRs this
  // module does not render as text, which have nothing to be repaired.
  const values = { ...naturalized, ...vr.valuesOf(parsed.entries) };
  const sidecar = vr.sidecarOf(parsed.entries);

  return {
    ok: true,
    entries: parsed.entries,
    values: level === 'mwl' ? flattenWorklistMatch(values) : values,
    sidecar: level === 'mwl'
      ? vr.liftSequenceEntries(sidecar, 'ScheduledProcedureStepSequence')
      : sidecar,
  };
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
  const asRawJson = flags.has('json-raw');
  const checkVr = flags.has('check-vr');
  if (asJson && asRawJson) {
    throw new args.UsageError('--json and --json-raw ask for two different shapes; choose one.');
  }

  const injections = parseInjections(flags);

  // Only when something will read them: re-reading every dataset costs a parse
  // per match, and the default table has no use for the octets.
  const wantRaw = asRawJson || checkVr;
  if (wantRaw) vr.installRawCapture();

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
  applyInjections(identifier, injections);

  const builders = {
    study: CFindRequest.createStudyFindRequest,
    series: CFindRequest.createSeriesFindRequest,
    image: CFindRequest.createImageFindRequest,
    mwl: CFindRequest.createWorklistFindRequest,
  };
  const request = builders[level](identifier);
  if (injections.length) verifyInjections(request, injections);

  log.info(`C-FIND (${level}) ${callingAe} -> ${calledAe} at ${host}:${port}`);
  if (pairs.length) {
    log.info(`  matching on: ${pairs.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  } else if (!injections.length) {
    log.info('  no matching keys given — this requests everything the peer will return');
  }
  if (injections.length) log.warn(log.color.yellow(injectionBanner(injections)));

  const matches = [];
  /** Octet-level views, index-aligned with `matches`. Empty unless wantRaw. */
  const views = [];
  let finalStatus;
  let finalComment;
  let cancelled = false;

  request.on('response', (response) => {
    const status = response.getStatus();

    if (statusLib.classify(status) === statusLib.Class.PENDING) {
      if (!response.hasDataset()) return;
      const dataset = response.getDataset();

      if (wantRaw) {
        const view = rawView(dataset, level);
        views.push(view);
        matches.push(view.values);
      } else {
        const elements = dataset.getElements();
        matches.push(level === 'mwl' ? flattenWorklistMatch(elements) : elements);
      }

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

  // The conformance report is built before anything is printed, because in
  // JSON mode it has to go inside the single document rather than beside it.
  const conformance = checkVr ? buildConformance(views) : undefined;

  const injected = injections.map((i) => ({
    tag: i.tag, attribute: i.label, value: i.value,
  }));

  // The stderr banner is level-gated and --quiet silences it, so the record of
  // what was injected also goes into the product itself: the "injected" array
  // in JSON mode, and this line above the table otherwise. There must be no
  // way to run an injected query and end up with output that does not say so.
  if (injected.length && !asJson && !asRawJson) {
    log.out('');
    log.out(log.color.yellow(
      `--set stamped ${injected.map((i) => `${i.attribute}=${JSON.stringify(i.value)}`).join(', ')} ` +
        'into this query verbatim.'
    ));
  }

  if (asRawJson) {
    // Values exactly as the peer sent them. `display()` is for a person
    // reading a table; it turns a sequence into a string and an empty
    // sequence into '', which silently destroys the very attributes an MPPS
    // N-CREATE must echo back for the RIS to correlate the step.
    log.out(JSON.stringify({
      level, host, port, calledAe, raw: true,
      count: matches.length,
      ...(injected.length ? { injected } : {}),
      ...(conformance ? conformanceJson(conformance) : {}),
      matches: matches.map((m, i) => withSidecar(stripPrivateKeys(m), views[i])),
    }, null, 2));
    return conformance?.violations.length ? 1 : (matches.length > 0 ? 0 : 1);
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
    log.out(JSON.stringify({
      level, host, port, calledAe,
      count: plain.length,
      ...(injected.length ? { injected } : {}),
      ...(conformance ? conformanceJson(conformance) : {}),
      matches: plain,
    }, null, 2));
    return conformance?.violations.length ? 1 : (matches.length > 0 ? 0 : 1);
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

  if (conformance) {
    reportConformance(conformance);
    if (conformance.violations.length || conformance.unreadable.length) return 1;
  }

  return 0;
}

/**
 * Attaches the per-element sidecar to a match.
 *
 * Under a `_` key on purpose. Every consumer of this output already strips
 * `_`-prefixed keys at every level — that is how dcmjs's own `_vrMap` is kept
 * out of an outgoing dataset — so the sidecar is additive by construction and
 * `dcm mpps --from-worklist` needs no change to read this file.
 */
function withSidecar(match, view) {
  if (!view) return match;
  if (view.sidecar) return { ...match, _elements: view.sidecar };
  // The octets could not be re-read. Saying so inside the document is the
  // difference between "no violations" and "no statement possible".
  return { ...match, _rawUnavailable: view.reason };
}

/**
 * Collects the conformance report over every match.
 *
 * A match whose octets could not be re-read is counted separately and never
 * folded into "no violations found". A conformance report that cannot tell
 * "clean" from "not examined" is the false pass this command exists to stop.
 */
function buildConformance(views) {
  const violations = [];
  const unreadable = [];
  let elementsExamined = 0;

  views.forEach((view, index) => {
    if (!view.ok) {
      unreadable.push({ match: index, reason: view.reason });
      return;
    }
    elementsExamined += countEntries(view.entries);
    for (const violation of vr.checkEntries(view.entries)) {
      violations.push({ match: index, ...violation });
    }
  });

  return { violations, unreadable, elementsExamined, matches: views.length };
}

/** Elements examined, counting inside sequences. */
function countEntries(entries) {
  let total = 0;
  for (const entry of entries) {
    total += 1;
    if (entry.items) for (const item of entry.items) total += countEntries(item);
  }
  return total;
}

/** The conformance report as the JSON document carries it. */
function conformanceJson(conformance) {
  return {
    vrViolations: conformance.violations,
    vrElementsExamined: conformance.elementsExamined,
    ...(conformance.unreadable.length ? { vrUnreadable: conformance.unreadable } : {}),
  };
}

/** The conformance report as a person reads it. */
function reportConformance(conformance) {
  const { violations, unreadable, elementsExamined } = conformance;

  log.out('');
  if (unreadable.length) {
    log.out(log.color.yellow(
      `VR conformance: ${unreadable.length} match(es) could not be read at the octet level, ` +
        'so no conformance statement is possible for them.'
    ));
    for (const item of unreadable) log.out(`  match ${item.match}: ${item.reason}`);
  }

  if (violations.length === 0) {
    if (!unreadable.length) {
      log.out(log.color.dim(`VR conformance: no violations over ${elementsExamined} elements returned.`));
    }
    return;
  }

  log.out(log.color.yellow(
    `VR conformance: ${violations.length} violation${violations.length === 1 ? '' : 's'} ` +
      `over ${elementsExamined} elements returned.`
  ));
  for (const violation of violations) {
    log.out(`  match ${violation.match}  ${vr.formatViolation(violation)}`);
  }
}

/**
 * Strips dcmjs bookkeeping keys (_vrMap and friends) at every level, including
 * inside sequence items, leaving a plain JSON-safe structure.
 *
 * @param {*} value
 * @returns {*}
 */
function stripPrivateKeys(value) {
  if (Array.isArray(value)) return value.map(stripPrivateKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = stripPrivateKeys(v);
    }
    return out;
  }
  return value;
}

module.exports = {
  stripPrivateKeys, run, USAGE, buildIdentifier, display, flattenWorklistMatch, MWL_SPS_KEYS,
  parseInjections, applyInjections, verifyInjections, injectionBanner, rawView,
  buildConformance, withSidecar };
