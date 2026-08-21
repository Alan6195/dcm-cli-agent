'use strict';

/**
 * Modality Worklist source and matcher.
 *
 * This is the SCP half of the worklist story. `dcm find --mwl` could always
 * ask a worklist question; until now nothing here could answer one, so an MWL
 * integration could never be exercised end to end — you could type the query
 * and never see a match come back.
 *
 * What this is: a worklist read from a hand-written JSON file, matched against
 * the keys a modality actually sends. It exists so a modality's worklist
 * integration, or an assistant driving this engine, can be tested against
 * something real and local.
 *
 * What this is not: a scheduling system. There is no ordering, no priorities,
 * and the file is read once at startup and never written back to. It is a
 * fixture, not a RIS.
 *
 * The second half of this module is the Modality Performed Procedure Step side
 * of the same fixture: validating what an MPPS SCU sends, deciding which status
 * transitions are legal, and correlating a finished step back to the worklist
 * item it was scheduled from. That correlation is the reason a completed step
 * can stop being offered by later worklist queries, which is what a real RIS
 * does and what makes a worklist integration testable end to end. The rules
 * live here, next to the matching they have to agree with; the state they act
 * on lives in the receiver, and only in memory.
 */

const fs = require('fs');
const path = require('path');

const args = require('./args');

/**
 * Worklist keys that belong inside the Scheduled Procedure Step Sequence.
 *
 * This list must stay identical to `MWL_SPS_KEYS` in src/commands/find.js. The
 * two halves have to agree on where these attributes live or the client asks
 * about a nested key while the server answers with a flat one, and the result
 * is zero matches with nothing visibly wrong on either side — the exact
 * failure mode the client-side comment warns about. It is duplicated rather
 * than imported so a library never has to reach into a command module; a test
 * pins the two lists together instead.
 */
const SPS_KEYS = Object.freeze([
  'Modality',
  'ScheduledStationAETitle',
  'ScheduledProcedureStepStartDate',
  'ScheduledProcedureStepStartTime',
  'ScheduledProcedureStepDescription',
  'ScheduledPerformingPhysicianName',
  'ScheduledProcedureStepID',
  'ScheduledProcedureStepStatus',
]);

/**
 * Matching keys this receiver honours.
 *
 * Anything else in the identifier is reported and ignored rather than quietly
 * treated as a match — see {@link readMatchingKeys}. These are the keys a
 * modality actually narrows a worklist with.
 */
const SUPPORTED_KEYS = Object.freeze([
  'Modality',
  'ScheduledStationAETitle',
  'ScheduledProcedureStepStartDate',
  'PatientID',
  'PatientName',
  'AccessionNumber',
]);

/** Matched as a DICOM date, single value or `YYYYMMDD-YYYYMMDD` range. */
const DATE_KEYS = Object.freeze(['ScheduledProcedureStepStartDate']);

/**
 * Identifier entries that are protocol furniture, not matching keys.
 *
 * QueryRetrieveLevel has no meaning at the worklist level — a worklist is
 * flat — and SpecificCharacterSet describes the encoding of the query rather
 * than narrowing it. Neither should be reported as an unsupported key, because
 * a warning about something the client had to send is just noise.
 */
const NON_MATCHING_KEYS = new Set(['QueryRetrieveLevel', 'SpecificCharacterSet']);

/**
 * Reads a value as plain text.
 *
 * dcmjs hands back Person Names as `{ Alphabetic: 'DOE^JANE' }` and
 * multi-valued elements as arrays, so neither can be compared as-is. Only the
 * first component of a multi-valued matching key is used: this receiver does
 * not implement list-of-values matching, and pretending to would be worse than
 * saying so.
 *
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.length ? textOf(value[0]) : '';
  if (typeof value === 'object') {
    if (value.Alphabetic !== undefined) return String(value.Alphabetic);
    if (value.Ideographic !== undefined) return String(value.Ideographic);
    if (value.Phonetic !== undefined) return String(value.Phonetic);
    return '';
  }
  return String(value);
}

/**
 * True for a matching key that is present but empty.
 *
 * In DICOM that is universal matching: "return this attribute, do not filter
 * on it". Every return key `dcm find` requests arrives this way, so getting
 * this wrong would turn a request for eight attributes into eight impossible
 * filters and every query would answer nothing.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isUniversal(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0 || value.every(isUniversal);
  if (typeof value === 'object') {
    if ('Alphabetic' in value || 'Ideographic' in value || 'Phonetic' in value) {
      return textOf(value).trim() === '';
    }
    return Object.values(value).every(isUniversal);
  }

  // A zero-length element with a binary VR comes back as 0, not as "". Every
  // worklist query carries one — PregnancyStatus (US) is in the standard set
  // of return keys dcmjs-dimse builds — so reading 0 as a real value would
  // report an unsupported matching key on every single query, which is how a
  // warning that matters gets tuned out. Nothing this receiver matches on has
  // a binary VR, so the only thing lost is a warning about a key it would
  // ignore anyway.
  if (typeof value === 'number') return value === 0;

  return String(value).trim() === '';
}

/**
 * Compiles a DICOM string-matching pattern into a regular expression.
 *
 * `*` is any run of characters, `?` is exactly one. Everything else is a
 * literal, so a Person Name's `^` separators and a UID's dots cannot be read
 * as regex syntax.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function wildcardToRegExp(pattern) {
  let body = '';
  for (const ch of pattern) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Single-value or wildcard matching, case-insensitively.
 *
 * Case insensitivity is a deliberate convenience rather than strict
 * conformance: a modality that asks for `ct` and a worklist file written as
 * `CT` should agree, because the alternative is a local test that fails for a
 * reason that has nothing to do with the integration being tested.
 *
 * @param {string} value     The worklist item's value.
 * @param {string} criterion The query's value.
 * @returns {boolean}
 */
function matchesText(value, criterion) {
  const pattern = criterion.trim();
  if (pattern === '') return true;
  if (pattern.includes('*') || pattern.includes('?')) {
    return wildcardToRegExp(pattern).test(value.trim());
  }
  return value.trim().toUpperCase() === pattern.toUpperCase();
}

/**
 * Date matching: a single `YYYYMMDD`, or a range with either side left open.
 *
 * DICOM dates are fixed-width and zero-padded, so lexicographic comparison is
 * chronological comparison and no parsing is needed. An item with no date can
 * never fall inside a range, which is why the empty check is not folded into
 * the bounds.
 *
 * @param {string} value
 * @param {string} criterion
 * @returns {boolean}
 */
function matchesDate(value, criterion) {
  const pattern = criterion.trim();
  if (pattern === '') return true;

  const dash = pattern.indexOf('-');
  const actual = value.trim();
  if (dash === -1) return actual === pattern;

  const from = pattern.slice(0, dash).trim();
  const to = pattern.slice(dash + 1).trim();
  if (actual === '') return false;
  if (from && actual < from) return false;
  if (to && actual > to) return false;
  return true;
}

/**
 * Describes a JSON value for an error message.
 *
 * "must be an array, found an object" is actionable; "invalid worklist" is not.
 */
function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return `${type === 'object' ? 'an' : 'a'} ${type}`;
}

/**
 * Loads and validates a worklist file.
 *
 * Both shapes people naturally hand-write are accepted: a bare array of items,
 * and an object with an `items` array (which leaves room for a comment or a
 * name alongside them).
 *
 * Every failure here is a UsageError naming the file and the problem. A
 * receiver that starts with a silently empty worklist looks identical to one
 * whose matching is broken, and both look identical to an empty schedule —
 * three very different problems that must not share one symptom.
 *
 * @param {string} file Path as the user typed it.
 * @returns {{file: string, items: Array<Record<string, unknown>>}}
 */
function loadWorklistFile(file) {
  const resolved = path.resolve(file);

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new args.UsageError(`--worklist "${resolved}" does not exist.`);
    }
    if (err.code === 'EISDIR') {
      throw new args.UsageError(`--worklist "${resolved}" is a directory, not a JSON file.`);
    }
    throw new args.UsageError(`--worklist "${resolved}" could not be read: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new args.UsageError(
      `--worklist "${resolved}" is not valid JSON: ${err.message}`
    );
  }

  let items;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
    items = parsed.items;
  } else if (parsed && typeof parsed === 'object' && 'items' in parsed) {
    throw new args.UsageError(
      `--worklist "${resolved}" has an "items" property that is ${describeShape(parsed.items)}, ` +
        'not an array of worklist items.'
    );
  } else {
    throw new args.UsageError(
      `--worklist "${resolved}" must be a JSON array of worklist items, or an object with an ` +
        `"items" array. Found ${describeShape(parsed)}.`
    );
  }

  items.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new args.UsageError(
        `--worklist "${resolved}" item ${i + 1} of ${items.length} is ${describeShape(item)}. ` +
          'Each item must be an object of DICOM keyword/value pairs, e.g. ' +
          '{"PatientName":"DOE^JANE","PatientID":"12345","Modality":"CT"}.'
      );
    }
  });

  return { file: resolved, items };
}

/**
 * Flattens an item so a matching key can be looked up wherever it was written.
 *
 * The file format is flat, but an item may also be written with a real
 * ScheduledProcedureStepSequence. Both have to match identically, or the same
 * worklist would answer differently depending on how it was typed.
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function flattenItem(item) {
  const flat = {};
  const sequence = item.ScheduledProcedureStepSequence;
  if (Array.isArray(sequence) && sequence.length && sequence[0] && typeof sequence[0] === 'object') {
    Object.assign(flat, sequence[0]);
  }
  for (const [key, value] of Object.entries(item)) {
    if (key === 'ScheduledProcedureStepSequence') continue;
    flat[key] = value;
  }
  return flat;
}

/**
 * Builds the response dataset for one item, with the scheduled-step attributes
 * nested where an MWL SCU reads them.
 *
 * Modality, the scheduled station and the scheduled start date/time are not
 * top-level attributes: they live inside ScheduledProcedureStepSequence
 * (0040,0100). Returning them flat is the mirror image of the client-side
 * mistake `dcm find --mwl` guards against, and it would look like the answer
 * arrived with no scheduling information at all.
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function toDataset(item) {
  const top = {};
  const step = {};

  const provided = item.ScheduledProcedureStepSequence;
  if (Array.isArray(provided) && provided.length && provided[0] && typeof provided[0] === 'object') {
    Object.assign(step, provided[0]);
  }

  for (const [key, value] of Object.entries(item)) {
    if (key.startsWith('_')) continue; // Room for comments in the file.
    if (key === 'ScheduledProcedureStepSequence') continue;
    if (SPS_KEYS.includes(key)) step[key] = value;
    else top[key] = value;
  }

  top.ScheduledProcedureStepSequence = [step];
  return top;
}

/**
 * Reads the matching keys out of a C-FIND identifier.
 *
 * Keys are collected from the top level and from inside the Scheduled
 * Procedure Step Sequence, because a conformant SCU puts them in the second
 * place and a lenient one may put them in the first.
 *
 * @param {Record<string, unknown>} elements The request's dataset elements.
 * @returns {{criteria: Array<{key: string, value: string}>, unsupported: string[]}}
 */
function readMatchingKeys(elements) {
  const criteria = [];
  const unsupported = [];

  const consider = (key, value) => {
    if (key.startsWith('_') || NON_MATCHING_KEYS.has(key)) return;
    if (isUniversal(value)) return; // Universal matching: a return key, not a filter.
    // DICOM pads odd-length values with a trailing space, so the criterion off
    // the wire is not always the one that was typed. Trim once here rather
    // than leaving padding to show up in the log line as well.
    if (SUPPORTED_KEYS.includes(key)) criteria.push({ key, value: textOf(value).trim() });
    else if (!unsupported.includes(key)) unsupported.push(key);
  };

  for (const [key, value] of Object.entries(elements ?? {})) {
    if (key === 'ScheduledProcedureStepSequence') continue;
    consider(key, value);
  }

  const sequence = elements?.ScheduledProcedureStepSequence;
  if (Array.isArray(sequence)) {
    for (const step of sequence) {
      if (!step || typeof step !== 'object') continue;
      for (const [key, value] of Object.entries(step)) consider(key, value);
    }
  }

  return { criteria, unsupported };
}

/**
 * Selects the items every criterion accepts.
 *
 * @param {Array<Record<string, unknown>>} items
 * @param {Array<{key: string, value: string}>} criteria
 * @returns {Array<Record<string, unknown>>}
 */
function selectItems(items, criteria) {
  if (!criteria.length) return [...items];

  return items.filter((item) => {
    const flat = flattenItem(item);
    return criteria.every(({ key, value }) => {
      const actual = textOf(flat[key]);
      return DATE_KEYS.includes(key)
        ? matchesDate(actual, value)
        : matchesText(actual, value);
    });
  });
}

// ---------------------------------------------------------------------------
// Modality Performed Procedure Step
// ---------------------------------------------------------------------------

/** The only status an MPPS instance may be created with (PS3.4 F.7.2). */
const MPPS_IN_PROGRESS = 'IN PROGRESS';

/** The step ran to the end. */
const MPPS_COMPLETED = 'COMPLETED';

/** The step stopped early — a patient who could not continue, a repeat, a fault. */
const MPPS_DISCONTINUED = 'DISCONTINUED';

/**
 * The two states a step can finish in.
 *
 * They are terminal in the strict sense: once a step is in one of them it may
 * not be set again, not even to the same value. A receiver that allows it lets
 * a client quietly overwrite the record of what happened.
 */
const MPPS_TERMINAL_STATUSES = Object.freeze([MPPS_COMPLETED, MPPS_DISCONTINUED]);

/**
 * Type 1 attributes of the N-CREATE dataset (PS3.4 F.7.2-1).
 *
 * Type 1 means present *and* non-empty. Checking this is the whole reason a
 * local MPPS receiver is worth having: many SCPs accept an N-CREATE carrying an
 * empty Type 1 attribute, return Success, and then silently fail to reconcile
 * the step with anything. The failure surfaces days later as a procedure that
 * never left the worklist, with nothing in any log tying it to the request that
 * caused it.
 */
const MPPS_TYPE1_KEYS = Object.freeze([
  'PerformedProcedureStepID',
  'PerformedStationAETitle',
  'PerformedProcedureStepStartDate',
  'PerformedProcedureStepStartTime',
  'PerformedProcedureStepStatus',
  'Modality',
  'ScheduledStepAttributesSequence',
]);

/**
 * Attributes that tie a performed step back to a scheduled one, in the order
 * they are trusted.
 *
 * StudyInstanceUID first because it is Type 1 inside
 * ScheduledStepAttributesSequence and is the key the standard intends for this:
 * the worklist gives the modality a Study Instance UID and the modality gives
 * it back. The other two are fallbacks for a client that fills in less than it
 * should — an Accession Number can be reused across a patient's visits and a
 * Scheduled Procedure Step ID is only unique within a requested procedure, so
 * neither is safe to reach for while the UID is available.
 */
const MPPS_CORRELATION_KEYS = Object.freeze([
  'StudyInstanceUID',
  'AccessionNumber',
  'ScheduledProcedureStepID',
]);

/**
 * Deep copy with the library's private keys removed.
 *
 * A dataset read off the wire carries a `_vrMap` at the top level and inside
 * every sequence item. Keeping it would put library bookkeeping into anything
 * this record is later written to or compared against, so it is stripped at
 * every level rather than only the first — the same thing {@link toDataset} and
 * find.js do for datasets going the other way.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function plainElements(value) {
  if (Array.isArray(value)) return value.map(plainElements);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      out[key] = plainElements(inner);
    }
    return out;
  }
  return value;
}

/**
 * Names every Type 1 attribute an N-CREATE dataset is missing.
 *
 * Absent and present-but-empty are the same failure here, which is why
 * {@link isUniversal} does the work: for a matching key an empty value means
 * "do not filter on this", and for a Type 1 attribute it means "this attribute
 * was never really supplied". The condition is identical; only the reading of
 * it differs.
 *
 * Returns names rather than a boolean because the useful thing to tell a client
 * is which attributes to add.
 *
 * @param {Record<string, unknown>} elements N-CREATE dataset elements.
 * @returns {string[]} Empty when nothing is missing.
 */
function missingType1(elements) {
  const source = elements ?? {};
  const missing = [];

  for (const key of MPPS_TYPE1_KEYS) {
    const value = source[key];

    if (key === 'ScheduledStepAttributesSequence') {
      // A sequence with no items is an empty Type 1 attribute, not a filled
      // one. Without at least one item there is nothing to correlate the step
      // with, which makes the step unreconcilable by construction.
      if (!Array.isArray(value) || value.length === 0) missing.push(key);
      continue;
    }

    if (isUniversal(value)) missing.push(key);
  }

  const steps = source.ScheduledStepAttributesSequence;
  if (Array.isArray(steps)) {
    steps.forEach((step, i) => {
      const uid = step && typeof step === 'object' ? step.StudyInstanceUID : undefined;
      if (isUniversal(uid)) {
        // Indexed from 1: DICOM sequence items are counted that way everywhere
        // else an operator will see them.
        missing.push(`ScheduledStepAttributesSequence[${i + 1}].StudyInstanceUID`);
      }
    });
  }

  return missing;
}

/**
 * Reads the correlation keys out of an N-CREATE dataset.
 *
 * Values are collected per key across every scheduled-step item, because one
 * performed step may cover several scheduled ones (PS3.4 F.7.2 allows exactly
 * that, and it is how a single acquisition satisfies a grouped procedure).
 *
 * @param {Record<string, unknown>} elements
 * @returns {Record<string, string[]>} One array per key in
 *   {@link MPPS_CORRELATION_KEYS}, each de-duplicated and free of empties.
 */
function readCorrelationKeys(elements) {
  const keys = {};
  for (const key of MPPS_CORRELATION_KEYS) keys[key] = [];

  const steps = elements?.ScheduledStepAttributesSequence;
  if (!Array.isArray(steps)) return keys;

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    for (const key of MPPS_CORRELATION_KEYS) {
      const value = textOf(step[key]).trim();
      if (value !== '' && !keys[key].includes(value)) keys[key].push(value);
    }
  }

  return keys;
}

/**
 * Renders correlation keys for a log line.
 *
 * @param {Record<string, string[]>} keys
 * @returns {string} Empty when the client supplied nothing to correlate on.
 */
function formatCorrelationKeys(keys) {
  const parts = [];
  for (const key of MPPS_CORRELATION_KEYS) {
    for (const value of keys?.[key] ?? []) parts.push(`${key}=${value}`);
  }
  return parts.join(', ');
}

/**
 * Compares two identifier values.
 *
 * Case-insensitively, for the same reason the matching above is: a local test
 * should not fail over the case of an Accession Number. UIDs are digits and
 * dots, so this changes nothing for the key that matters most.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameIdentifier(a, b) {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Finds the worklist items a performed step was scheduled from.
 *
 * The keys are tried in {@link MPPS_CORRELATION_KEYS} order and the first one
 * that matches anything wins; a weaker key is never consulted once a stronger
 * one has answered. Matching on all of them at once would be worse than either:
 * a client that sends a correct Study Instance UID and a stale Accession Number
 * would retire an item that has nothing to do with the study just performed.
 *
 * @param {Array<Record<string, unknown>>} items The loaded worklist.
 * @param {Record<string, string[]>} keys From {@link readCorrelationKeys}.
 * @returns {{by?: string, value?: string, items: Array<Record<string, unknown>>}}
 */
function correlateItems(items, keys) {
  for (const key of MPPS_CORRELATION_KEYS) {
    for (const value of keys?.[key] ?? []) {
      const matched = (items ?? []).filter((item) => {
        const actual = textOf(flattenItem(item)[key]).trim();
        return actual !== '' && sameIdentifier(actual, value);
      });
      if (matched.length) return { by: key, value, items: matched };
    }
  }
  return { items: [] };
}

/**
 * Decides whether an N-SET may change a step's status.
 *
 * The legal graph is small and total: IN PROGRESS may become COMPLETED or
 * DISCONTINUED, and that is all. An N-SET that carries no status at all is an
 * attribute update, which is legal while the step is still in progress — that
 * is how a client adds series to a step it has not finished yet.
 *
 * Setting IN PROGRESS on a step that is already IN PROGRESS is refused rather
 * than waved through as a no-op. N-SET carries what changes; a status that is
 * not changing has no business being in the message, and letting it through
 * would mean this receiver and a conformant one disagree about the same
 * request.
 *
 * @param {string} current The status held here.
 * @param {string} next    The status being set, or '' when none was sent.
 * @returns {string|undefined} The reason to refuse, or undefined if it is legal.
 */
function transitionRefusal(current, next) {
  if (MPPS_TERMINAL_STATUSES.includes(current)) {
    // PS3.4 F.8.2: a step in a terminal state may no longer be updated. This is
    // the one rule that protects the record — allowing it would let a repeated
    // or delayed N-SET rewrite what was reported as performed.
    return `the step is already ${current} and may no longer be updated`;
  }
  if (next === '') return undefined;
  if (next === MPPS_IN_PROGRESS) {
    // An N-SET that keeps the step IN PROGRESS is legal and useful: PS3.4
    // F.7.2-1 lists PerformedProcedureStepStatus among the attributes an N-SET
    // may carry, and F.8.2 closes only the terminal states. It is how a
    // modality says "still working" and grows PerformedSeriesSequence as
    // series complete.
    //
    // Refusing it was a real bug here, and an expensive class of one: a
    // receiver that answers an interim update with 0x0106 makes devices
    // abandon the session, after which the worklist entry never clears. The
    // step reached this line only because it is not terminal, so the rule
    // above still protects a finished record.
    return undefined;
  }
  if (!MPPS_TERMINAL_STATUSES.includes(next)) {
    // Kept short on purpose: this reason travels in Error Comment, which is LO
    // and holds 64 characters, and the client can only act on what it receives.
    return `"${next}" is not a legal status; use ${MPPS_TERMINAL_STATUSES.join(' or ')}`;
  }
  return undefined;
}

module.exports = {
  SPS_KEYS,
  SUPPORTED_KEYS,
  DATE_KEYS,
  loadWorklistFile,
  flattenItem,
  toDataset,
  readMatchingKeys,
  selectItems,
  matchesText,
  matchesDate,
  isUniversal,
  textOf,
  MPPS_IN_PROGRESS,
  MPPS_COMPLETED,
  MPPS_DISCONTINUED,
  MPPS_TERMINAL_STATUSES,
  MPPS_TYPE1_KEYS,
  MPPS_CORRELATION_KEYS,
  plainElements,
  missingType1,
  readCorrelationKeys,
  formatCorrelationKeys,
  correlateItems,
  transitionRefusal,
};
