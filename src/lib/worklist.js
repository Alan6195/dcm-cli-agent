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
 * What this is not: a scheduling system. There is no ordering, no MPPS, no
 * status transitions, nothing is written back, and the file is read once at
 * startup. It is a fixture, not a RIS.
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
};
