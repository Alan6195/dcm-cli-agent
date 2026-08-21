'use strict';

/**
 * Modality Performed Procedure Step: dataset construction, validation and the
 * two N-service round trips.
 *
 * MPPS is the half of the worklist story that says what actually happened. The
 * worklist says a CT of Mrs Jones is scheduled; MPPS says the CT started at
 * 09:31, produced these two series holding these forty-one instances, and
 * finished. A RIS reconciles the two by Study Instance UID and closes the
 * order. Get the reconciliation key wrong and the order stays open forever
 * while the images sit in the archive.
 *
 * Everything in this module is built around one idea: an MPPS N-SET is a
 * clinical record of work performed, so it must only ever assert things this
 * process actually observed. That is why PerformedSeriesSequence is built from
 * transfer-ledger entries the peer positively acknowledged and from nothing
 * else. A sequence built by listing the folder would name SOP Instance UIDs
 * the archive may not hold — a fabricated record that reads as authoritative,
 * and the single most damaging thing this command could do.
 *
 * The same idea drives the Type 1 validation below. Many SCPs accept an
 * N-CREATE carrying an empty Type 1 attribute, answer 0x0000, and then never
 * reconcile the step against the order because the key they reconcile on was
 * blank. The transaction looks successful from here and quietly achieves
 * nothing, so the check has to happen locally, before anything is sent.
 */

const fs = require('fs');
const path = require('path');

const args = require('./args');
const { deterministicUid, validateUid } = require('./uid');
const { Disposition } = require('./ledger');
const { runAssociation, dcmjsDimse, constants } = require('./dimse');

const { Dataset } = dcmjsDimse;
const { NCreateRequest, NSetRequest } = dcmjsDimse.requests;

/** MPPS SOP Class UID (PS3.4 F.7). */
const MPPS_SOP_CLASS = constants.SopClass.ModalityPerformedProcedureStep;

/** The three values PerformedProcedureStepStatus may hold. */
const Status = Object.freeze({
  IN_PROGRESS: 'IN PROGRESS',
  COMPLETED: 'COMPLETED',
  DISCONTINUED: 'DISCONTINUED',
});

/**
 * Legal PerformedProcedureStepStatus transitions (PS3.4 F.7.2).
 *
 * IN PROGRESS is the only non-terminal state, and it has a self-edge: an
 * interim N-SET re-asserts IN PROGRESS while adding to the step, which is how a
 * modality reports progress on a long acquisition without closing it. PS3.4
 * F.7.2-1 marks PerformedProcedureStepStatus as usable on the N-SET, and F.8.2
 * constrains only the terminal states, so IN PROGRESS -> IN PROGRESS is legal
 * and receivers that refuse it are the reason devices abandon sessions.
 *
 * COMPLETED and DISCONTINUED are both final: a conformant SCP refuses an N-SET
 * that tries to move out of one, including re-setting the same value. That
 * refusal is correct behaviour and catching it here turns a confusing 0x0110
 * from the far end into a sentence that says what happened. Adding the
 * self-edge above does not touch that — both terminal rows are still empty, so
 * nothing may leave a terminal state and nothing may re-enter one.
 */
const LEGAL_TRANSITIONS = Object.freeze({
  [Status.IN_PROGRESS]: Object.freeze([
    Status.IN_PROGRESS, Status.COMPLETED, Status.DISCONTINUED,
  ]),
  [Status.COMPLETED]: Object.freeze([]),
  [Status.DISCONTINUED]: Object.freeze([]),
});

/**
 * Type 1 attributes of the N-CREATE (PS3.4 F.7.2-1). Present and non-empty, or
 * the step cannot be reconciled.
 */
const CREATE_TYPE_1 = Object.freeze([
  'PerformedProcedureStepID',
  'PerformedStationAETitle',
  'PerformedProcedureStepStartDate',
  'PerformedProcedureStepStartTime',
  'PerformedProcedureStepStatus',
  'Modality',
  'ScheduledStepAttributesSequence',
]);

/**
 * Type 2 attributes of the N-CREATE: must be *present*, may be empty.
 *
 * Omitting one is not the same as sending it empty. Some SCPs reject an
 * N-CREATE that is missing a Type 2 attribute outright, so they are always
 * emitted — as '' for a string and as [] for a sequence.
 */
const CREATE_TYPE_2 = Object.freeze([
  'PatientName',
  'PatientID',
  'PatientBirthDate',
  'PatientSex',
  'ReferencedPatientSequence',
  'PerformedStationName',
  'PerformedLocation',
  'PerformedProcedureStepDescription',
  'PerformedProcedureStepEndDate',
  'PerformedProcedureStepEndTime',
  'PerformedSeriesSequence',
  'ProcedureCodeSequence',
]);

/**
 * Attributes PS3.4 F.7.2-1 permits on the N-CREATE and on nothing else, keyed
 * by the flag that would carry one into an N-SET.
 *
 * The N-SET column of that table is blank for every attribute here: patient
 * identity, the whole relationship module in ScheduledStepAttributesSequence,
 * and the four attributes that fix what and where the step is —
 * PerformedProcedureStepID, PerformedStationAETitle, the start date and time,
 * and Modality. They describe the step as created; an N-SET reports progress
 * against it.
 *
 * Sending one anyway is worse than useless. Some SCPs answer 0x0105 "No Such
 * Attribute" and the whole update is lost; others accept it and overwrite the
 * identity the RIS already reconciled against, which is how a step ends up
 * pointing at a different study than the images did. Refusing locally, by
 * name, is the only version of this that is easy to act on.
 */
const CREATE_ONLY_ATTRIBUTES = Object.freeze({
  'patient-id': 'PatientID',
  'patient-name': 'PatientName',
  'patient-birth-date': 'PatientBirthDate',
  'patient-sex': 'PatientSex',
  'study-uid': 'ScheduledStepAttributesSequence[1].StudyInstanceUID',
  accession: 'ScheduledStepAttributesSequence[1].AccessionNumber',
  'requested-procedure-id': 'ScheduledStepAttributesSequence[1].RequestedProcedureID',
  'requested-procedure-description':
    'ScheduledStepAttributesSequence[1].RequestedProcedureDescription',
  'scheduled-step-id': 'ScheduledStepAttributesSequence[1].ScheduledProcedureStepID',
  'from-worklist': 'ScheduledStepAttributesSequence',
  unscheduled: 'ScheduledStepAttributesSequence',
  'step-id': 'PerformedProcedureStepID',
  'station-ae': 'PerformedStationAETitle',
  'start-date': 'PerformedProcedureStepStartDate',
  'start-time': 'PerformedProcedureStepStartTime',
  modality: 'Modality',
});

/** Type 2 attributes of one ScheduledStepAttributesSequence item. */
const SCHEDULED_STEP_TYPE_2 = Object.freeze([
  'AccessionNumber',
  'RequestedProcedureID',
  'RequestedProcedureDescription',
  'ScheduledProcedureStepID',
  'ScheduledProcedureStepDescription',
  'ReferencedStudySequence',
  'ScheduledProtocolCodeSequence',
]);

// --- Value formatting ------------------------------------------------------

/**
 * Formats a Date as a DICOM DA value.
 *
 * Local time, deliberately. A performed procedure step happened at a wall
 * clock time in the room, and that is the time the RIS displays next to it.
 *
 * @param {Date} [when]
 * @returns {string} YYYYMMDD
 */
function dicomDate(when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
}

/**
 * Formats a Date as a DICOM TM value.
 *
 * Seconds are included but fractional seconds are not: some older SCPs store
 * TM into a fixed six-character column and truncate anything longer, which
 * turns 093155.482 into 093155 on one system and 093155.4 on another.
 *
 * @param {Date} [when]
 * @returns {string} HHMMSS
 */
function dicomTime(when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
}

/**
 * Reads a DICOM value as plain text.
 *
 * dcmjs hands Person Names back as `{ Alphabetic: 'DOE^JANE' }` and
 * multi-valued elements as arrays, so a value taken off the wire cannot be
 * used as a string without this.
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
 * Removes `_`-prefixed keys at every level.
 *
 * A dataset read off the wire carries a `_vrMap` beside the real attributes,
 * at the top level and inside every sequence item. Copying one into an
 * outgoing dataset makes dcmjs write a bogus element, so it is stripped
 * wherever it is found rather than only at the top.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      out[key] = stripPrivate(v);
    }
    return out;
  }
  return value;
}

/** True when a value is absent, blank, or an empty sequence. */
function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return textOf(value).trim() === '';
  return String(value).trim() === '';
}

// --- UID ------------------------------------------------------------------

/**
 * Derives the MPPS SOP Instance UID.
 *
 * The SCU owns this UID — the SCP does not assign one — so it has to be
 * generated here and quoted back on the N-SET. It is derived rather than
 * random so that re-running the same step at the same second produces the same
 * UID and the SCP answers "duplicate SOP Instance" instead of silently opening
 * a second procedure step for one piece of work.
 *
 * @param {object} key
 * @param {string} key.studyInstanceUid
 * @param {string} key.performedProcedureStepId
 * @param {string} key.performedStationAeTitle
 * @param {string} key.startDate
 * @param {string} key.startTime
 * @returns {string}
 */
function newMppsUid(key) {
  return deterministicUid(
    'dcm-cli:mpps:v1',
    key.studyInstanceUid ?? '',
    key.performedProcedureStepId ?? '',
    key.performedStationAeTitle ?? '',
    key.startDate ?? '',
    key.startTime ?? ''
  );
}

/**
 * Validates a user-supplied MPPS SOP Instance UID.
 *
 * @param {string} uid
 * @param {string} where Text used in the error, e.g. '--mpps-uid'.
 * @returns {string}
 */
function requireUid(uid, where) {
  const verdict = validateUid(uid);
  if (!verdict.valid) {
    throw new args.UsageError(
      `${where} "${uid}" is not a valid DICOM UID: ${verdict.reason}. ` +
        'An MPPS SOP Instance UID is the one printed by `dcm mpps start`.'
    );
  }
  return uid;
}

// --- Status transitions ----------------------------------------------------

/**
 * Refuses an illegal PerformedProcedureStepStatus transition.
 *
 * @param {string} from
 * @param {string} to
 */
function assertLegalTransition(from, to) {
  const allowed = LEGAL_TRANSITIONS[from];
  if (allowed === undefined) {
    throw new args.UsageError(
      `"${from}" is not a PerformedProcedureStepStatus. The only values are ` +
        `${Object.values(Status).map((s) => `"${s}"`).join(', ')}.`
    );
  }
  if (!Object.values(Status).includes(to)) {
    throw new args.UsageError(
      `"${to}" is not a PerformedProcedureStepStatus. The only values are ` +
        `${Object.values(Status).map((s) => `"${s}"`).join(', ')}.`
    );
  }
  if (allowed.includes(to)) return;

  if (allowed.length === 0) {
    throw new args.UsageError(
      `This procedure step is already ${from}, which is a final state. ` +
        `A conformant SCP refuses an N-SET that moves out of it, including one that ` +
        `sets ${to} again. If the step really needs re-stating, the archive's own ` +
        `tooling has to do it — the protocol offers no way from here.`
    );
  }
  throw new args.UsageError(`A procedure step cannot go from ${from} to ${to}.`);
}

// --- N-CREATE dataset ------------------------------------------------------

/**
 * Builds one ScheduledStepAttributesSequence item.
 *
 * StudyInstanceUID is the Type 1 attribute here and it is *the* correlation
 * key: it is how the RIS ties this performed step back to the order it came
 * from and to the images that arrive at the archive. Everything else in the
 * item is Type 2 and exists to make the step legible to a human reading it.
 *
 * @param {object} attrs
 * @returns {Record<string, unknown>}
 */
function buildScheduledStepItem(attrs = {}) {
  const item = {
    StudyInstanceUID: textOf(attrs.studyInstanceUid),
  };

  const type2 = {
    AccessionNumber: textOf(attrs.accessionNumber),
    RequestedProcedureID: textOf(attrs.requestedProcedureId),
    RequestedProcedureDescription: textOf(attrs.requestedProcedureDescription),
    ScheduledProcedureStepID: textOf(attrs.scheduledProcedureStepId),
    ScheduledProcedureStepDescription: textOf(attrs.scheduledProcedureStepDescription),
    ReferencedStudySequence: normaliseSequence(attrs.referencedStudySequence),
    ScheduledProtocolCodeSequence: normaliseSequence(attrs.scheduledProtocolCodeSequence),
  };

  for (const key of SCHEDULED_STEP_TYPE_2) item[key] = type2[key];
  return item;
}

/**
 * The ScheduledStepAttributesSequence of an unscheduled (walk-in) step.
 *
 * PS3.3 C.4.14 is specific about the shape: the sequence is PRESENT and holds
 * exactly ONE ZERO-LENGTH ITEM. It is not omitted — omitting a Type 1 sequence
 * is a different message, and an SCP that checks Type 1 refuses it — and the
 * item is not a populated item with blank values either, because a present
 * StudyInstanceUID that happens to be empty is precisely the shape SCPs accept
 * and then never reconcile.
 *
 * "One zero-length item" means an item with no elements at all, which is why
 * this returns a bare object rather than going through
 * buildScheduledStepItem(): that builder emits the Type 2 attributes, and an
 * item carrying seven empty attributes is not zero-length.
 *
 * A fresh array and item each call, so no caller can mutate a shared one.
 *
 * @returns {Array<Record<string, unknown>>}
 */
function unscheduledStepSequence() {
  return [{}];
}

/**
 * True for the sequence above: exactly one item, and that item empty.
 *
 * Two items that are both empty is not this shape — it is two scheduled steps
 * whose correlation keys were forgotten — so the length check is not
 * incidental.
 *
 * @param {unknown} steps
 * @returns {boolean}
 */
function isUnscheduledStepSequence(steps) {
  return (
    Array.isArray(steps) &&
    steps.length === 1 &&
    Boolean(steps[0]) &&
    typeof steps[0] === 'object' &&
    !Array.isArray(steps[0]) &&
    Object.keys(steps[0]).length === 0
  );
}

/** Coerces a sequence-shaped input to an array of plain objects. */
function normaliseSequence(value) {
  if (value === undefined || value === null || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((item) => item && typeof item === 'object')
    .map((item) => stripPrivate(item));
}

/**
 * Chooses the ScheduledStepAttributesSequence for an N-CREATE.
 *
 * Three shapes, in the order they take precedence:
 *
 *   unscheduled            one zero-length item — a walk-in or ER exam that no
 *                          worklist ever scheduled
 *   scheduledSteps[]       items supplied whole by the caller
 *   scheduledStudyUids[]   one populated item per Study Instance UID, for the
 *                          step that fulfils several scheduled steps at once
 *
 * The multi-UID case only carries the scheduled-step Type 2 attributes on the
 * FIRST item. There is one --accession, one --scheduled-step-id and one
 * --requested-procedure-id on the command line, and copying them onto every
 * item would assert that several different orders share one accession number.
 * The rest are emitted empty, which is what Type 2 means and what is actually
 * known. Use --from-worklist per step if the descriptors matter.
 *
 * @param {object} attrs
 * @returns {Array<Record<string, unknown>>}
 */
function scheduledStepSequence(attrs = {}) {
  if (attrs.unscheduled) return unscheduledStepSequence();

  if (Array.isArray(attrs.scheduledSteps) && attrs.scheduledSteps.length) {
    return attrs.scheduledSteps.map((step) => buildScheduledStepItem(step));
  }

  const uids = Array.isArray(attrs.scheduledStudyUids) ? attrs.scheduledStudyUids : [];
  if (uids.length > 1) {
    return uids.map((uid, i) =>
      buildScheduledStepItem(i === 0 ? { ...attrs, studyInstanceUid: uid } : { studyInstanceUid: uid })
    );
  }

  return [buildScheduledStepItem(attrs)];
}

/**
 * Builds the complete N-CREATE dataset.
 *
 * Type 2 attributes are always emitted, empty if there is nothing to say. See
 * CREATE_TYPE_2 for why an absent Type 2 is not the same as an empty one.
 *
 * PerformedSeriesSequence is empty here on purpose: at creation time no series
 * has been performed yet, and claiming one would be a lie the N-SET then has
 * to walk back.
 *
 * @param {object} attrs
 * @returns {Record<string, unknown>}
 */
function buildCreateDataset(attrs = {}) {
  const scheduledSteps = scheduledStepSequence(attrs);

  const dataset = {
    // Type 1.
    PerformedProcedureStepID: textOf(attrs.performedProcedureStepId),
    PerformedStationAETitle: textOf(attrs.performedStationAeTitle),
    PerformedProcedureStepStartDate: textOf(attrs.startDate),
    PerformedProcedureStepStartTime: textOf(attrs.startTime),
    PerformedProcedureStepStatus: Status.IN_PROGRESS,
    Modality: textOf(attrs.modality),
    ScheduledStepAttributesSequence: scheduledSteps,

    // Type 2, in the order PS3.4 F.7.2-1 lists them.
    PatientName: textOf(attrs.patientName),
    PatientID: textOf(attrs.patientId),
    PatientBirthDate: textOf(attrs.patientBirthDate),
    PatientSex: textOf(attrs.patientSex),
    ReferencedPatientSequence: normaliseSequence(attrs.referencedPatientSequence),
    PerformedStationName: textOf(attrs.performedStationName),
    PerformedLocation: textOf(attrs.performedLocation),
    PerformedProcedureStepDescription: textOf(attrs.performedProcedureStepDescription),
    PerformedProcedureStepEndDate: '',
    PerformedProcedureStepEndTime: '',
    PerformedSeriesSequence: [],
    ProcedureCodeSequence: normaliseSequence(attrs.procedureCodeSequence),
  };

  return dataset;
}

/**
 * Lists the Type 1 attributes an N-CREATE dataset is missing.
 *
 * Returned as dotted paths so the message names the exact place to look,
 * including inside the sequence where the correlation key lives.
 *
 * @param {Record<string, unknown>} dataset
 * @returns {string[]}
 */
function missingType1(dataset) {
  const missing = [];

  for (const key of CREATE_TYPE_1) {
    if (isEmptyValue(dataset?.[key])) missing.push(key);
  }

  // The descent into the sequence is suppressed for the unscheduled shape and
  // for that shape ONLY. A zero-length item is how PS3.3 says "no order lies
  // behind this step", so there is no correlation key to demand. Inside a
  // POPULATED item StudyInstanceUID is still Type 1 — a half-filled item is a
  // scheduled step whose key was forgotten, which is the failure this check
  // exists for, and it must not be able to borrow the walk-in exemption.
  const steps = dataset?.ScheduledStepAttributesSequence;
  if (Array.isArray(steps) && !isUnscheduledStepSequence(steps)) {
    steps.forEach((step, i) => {
      if (isEmptyValue(step?.StudyInstanceUID)) {
        missing.push(`ScheduledStepAttributesSequence[${i + 1}].StudyInstanceUID`);
      }
    });
  }

  return missing;
}

/** Human explanation for each Type 1 attribute, used in the refusal. */
const TYPE_1_HELP = Object.freeze({
  PerformedProcedureStepID: '--step-id (or --scheduled-step-id, which it falls back to)',
  PerformedStationAETitle: '--station-ae (defaults to --calling-ae)',
  PerformedProcedureStepStartDate: '--start-date, or leave it to default to today',
  PerformedProcedureStepStartTime: '--start-time, or leave it to default to now',
  PerformedProcedureStepStatus: 'set internally — report this as a bug',
  Modality: '--modality, or --from-worklist',
  ScheduledStepAttributesSequence:
    '--study-uid, or --from-worklist, or --unscheduled if no order lies behind this step',
  StudyInstanceUID:
    '--study-uid, or --from-worklist, or --unscheduled if no order lies behind this step',
});

/**
 * Refuses to send an N-CREATE that is missing a Type 1 attribute.
 *
 * This is local validation on purpose. A great many SCPs accept an N-CREATE
 * with a blank Type 1, answer success, and then never reconcile the step
 * against the order, so the failure is invisible from this end and shows up
 * days later as an order nobody closed.
 *
 * `exemptKeywords` is how `--set` lifts the check, and it lifts it BY NAME
 * only. An attribute the operator typed a value for — including an empty one —
 * is an attribute they decided about, and refusing it would make the flag
 * unable to ask the one question a conformance test most wants to ask: what
 * does this SCP do with an empty Type 1? Every attribute nobody named is still
 * checked, so the empty Type 1 stays impossible to reach by accident, which is
 * the property this function actually exists to hold.
 *
 * @param {Record<string, unknown>} dataset
 * @param {{exemptKeywords?: Set<string>}} [opts]
 */
function assertCreatable(dataset, opts = {}) {
  const exempt = opts.exemptKeywords ?? new Set();
  const missing = missingType1(dataset).filter((name) => {
    const leaf = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    return !exempt.has(leaf);
  });
  if (missing.length === 0) return;

  const lines = missing.map((name) => {
    const leaf = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    const help = TYPE_1_HELP[leaf];
    return `  ${name}${help ? ` — ${help}` : ''}`;
  });

  throw new args.UsageError(
    `The N-CREATE is missing ${missing.length} Type 1 attribute${missing.length === 1 ? '' : 's'}, ` +
      'so it will not be sent:\n' +
      `${lines.join('\n')}\n` +
      'Type 1 means present and non-empty. Many SCPs accept an N-CREATE with an empty ' +
      'Type 1, answer success, and then never reconcile the step against the order — the ' +
      'transaction looks fine from here and achieves nothing, which is why this is ' +
      'checked before anything goes on the wire.'
  );
}

// --- PerformedSeriesSequence ----------------------------------------------

/** Dispositions whose instance may be named in PerformedSeriesSequence. */
const REFERENCEABLE = new Set([Disposition.ACKNOWLEDGED, Disposition.WARNING]);

/**
 * Builds PerformedSeriesSequence from transfer-ledger entries.
 *
 * Only entries the peer positively acknowledged (or acknowledged with a
 * warning) are referenced. This is the whole reason the function takes ledger
 * entries rather than a folder: naming a SOP Instance UID the archive does not
 * hold turns the MPPS into a fabricated clinical record that reads as
 * authoritative. Every other consumer downstream — the RIS, the report, the
 * billing feed — believes this list.
 *
 * Instances that were acknowledged but cannot be referenced (no Series
 * Instance UID, no SOP Instance UID) are returned in `skipped` rather than
 * dropped, so the caller can say so out loud.
 *
 * @param {Array<object>} entries Ledger FileEntry objects, or anything with the
 *   same shape: {disposition, sopInstanceUid, sopClassUid, seriesInstanceUid}.
 * @param {object} [opts]
 * @param {string} [opts.retrieveAeTitle] AE Title the images can be fetched from.
 * @param {Map<string, object>} [opts.seriesMeta] Per-series descriptive fields.
 * @returns {{items: Array<object>, referenced: number, skipped: Array<object>, duplicates: number}}
 */
function buildPerformedSeriesSequence(entries, opts = {}) {
  const { retrieveAeTitle = '', seriesMeta } = opts;

  /** @type {Map<string, {uid: string, seen: Set<string>, images: Array<object>}>} */
  const bySeries = new Map();
  const skipped = [];
  let duplicates = 0;

  for (const entry of entries ?? []) {
    if (!REFERENCEABLE.has(entry?.disposition)) continue;

    const seriesUid = entry.seriesInstanceUid;
    const sopUid = entry.sopInstanceUid;
    if (!seriesUid || !sopUid) {
      skipped.push({
        path: entry.path,
        sopInstanceUid: sopUid,
        seriesInstanceUid: seriesUid,
        reason: !seriesUid ? 'no SeriesInstanceUID' : 'no SOPInstanceUID',
      });
      continue;
    }

    let series = bySeries.get(seriesUid);
    if (!series) {
      series = { uid: seriesUid, seen: new Set(), images: [] };
      bySeries.set(seriesUid, series);
    }

    // The same instance can appear twice in a tree. Referencing it twice would
    // overstate the work performed, so the second sighting is counted and
    // dropped rather than repeated.
    if (series.seen.has(sopUid)) {
      duplicates += 1;
      continue;
    }
    series.seen.add(sopUid);
    series.images.push({
      ReferencedSOPClassUID: entry.sopClassUid ?? '',
      ReferencedSOPInstanceUID: sopUid,
    });
  }

  const items = [];
  let referenced = 0;
  for (const series of bySeries.values()) {
    const meta = seriesMeta?.get(series.uid) ?? {};
    referenced += series.images.length;
    items.push({
      SeriesInstanceUID: series.uid,
      RetrieveAETitle: retrieveAeTitle,
      PerformedProcedureStepDescription: textOf(meta.performedProcedureStepDescription),
      ProtocolName: textOf(meta.protocolName),
      SeriesDescription: textOf(meta.seriesDescription),
      ReferencedImageSequence: series.images,
      // Type 2, and empty unless there are non-image composites to name. It has
      // to be present: an SCP that expects it and does not find it can reject
      // the whole N-SET.
      ReferencedNonImageCompositeSOPInstanceSequence: [],
    });
  }

  return { items, referenced, skipped, duplicates };
}

/**
 * Builds PerformedSeriesSequence from instances found on disk.
 *
 * This asserts what is on *your disk*, not what the archive holds. Nothing
 * here has been acknowledged by anyone. It exists only for the standalone case
 * where the transfer was done by some other tool and the step still has to be
 * closed, and every caller is required to say so in its output — which is why
 * the result carries `assertedFromDisk` rather than looking like the
 * ledger-derived version.
 *
 * @param {Map<string, object>} studies From scan(): `scanned.studies`.
 * @param {object} [opts] See {@link buildPerformedSeriesSequence}.
 * @returns {{items: Array<object>, referenced: number, skipped: Array<object>, duplicates: number, assertedFromDisk: true}}
 */
function buildPerformedSeriesSequenceFromFolder(studies, opts = {}) {
  const pseudoEntries = [];
  for (const study of studies?.values?.() ?? []) {
    for (const instance of study.instances ?? []) {
      pseudoEntries.push({
        // Deliberately borrowing the ledger's vocabulary so one builder does
        // the grouping. The honesty is carried by the flag on the result and
        // by the caller's disclaimer, not by pretending these were sent.
        disposition: Disposition.ACKNOWLEDGED,
        path: instance.path,
        sopInstanceUid: instance.sopInstanceUid,
        sopClassUid: instance.sopClassUid,
        seriesInstanceUid: instance.seriesInstanceUid,
      });
    }
  }

  const built = buildPerformedSeriesSequence(pseudoEntries, opts);
  return { ...built, assertedFromDisk: true };
}

/**
 * Collects per-series descriptive fields from a scan, keyed by Series
 * Instance UID, for use as `seriesMeta`.
 *
 * @param {Map<string, object>} studies
 * @returns {Map<string, object>}
 */
function seriesMetaFromScan(studies) {
  const meta = new Map();
  for (const study of studies?.values?.() ?? []) {
    for (const series of study.series?.values?.() ?? []) {
      if (!series.seriesInstanceUid) continue;
      meta.set(series.seriesInstanceUid, {
        seriesDescription: series.seriesDescription ?? '',
        protocolName: series.protocolName ?? '',
        performedProcedureStepDescription: '',
      });
    }
  }
  return meta;
}

// --- N-SET dataset ---------------------------------------------------------

/**
 * Builds the N-SET dataset.
 *
 * An N-SET carries only what changes. Re-sending the whole step would invite
 * the SCP to overwrite attributes it has already reconciled, and some do
 * exactly that, so the final status, the end date and time, and the performed
 * series are all that goes out.
 *
 * @param {object} params
 * @param {string} params.status Terminal status.
 * @param {string} params.endDate
 * @param {string} params.endTime
 * @param {Array<object>} [params.performedSeries]
 * @param {Array<object>} [params.discontinuationReasonCode] Coded reason items.
 * @returns {Record<string, unknown>}
 */
function buildSetDataset(params) {
  const { status, endDate, endTime, performedSeries, discontinuationReasonCode } = params;

  if (status !== Status.COMPLETED && status !== Status.DISCONTINUED) {
    throw new args.UsageError(
      `An N-SET closes a procedure step, so its status must be ${Status.COMPLETED} or ` +
        `${Status.DISCONTINUED}, not "${status}".`
    );
  }

  const dataset = {
    PerformedProcedureStepStatus: status,
    PerformedProcedureStepEndDate: textOf(endDate),
    PerformedProcedureStepEndTime: textOf(endTime),
    PerformedSeriesSequence: Array.isArray(performedSeries) ? performedSeries : [],
  };

  // Only sent when a real coded value was supplied — see the note in
  // parseReasonCode() for why a free-text reason is never coerced into a code.
  if (Array.isArray(discontinuationReasonCode) && discontinuationReasonCode.length) {
    dataset.PerformedProcedureStepDiscontinuationReasonCodeSequence = discontinuationReasonCode;
  }

  return dataset;
}

/**
 * Builds the dataset of an INTERIM N-SET — one that reports progress and
 * leaves the step running.
 *
 * A separate builder rather than a flag on buildSetDataset(), and the reason is
 * worth stating. buildSetDataset()'s contract is "this dataset closes the
 * step", and the two things that make it safe are exactly the two things an
 * interim update must not do: it refuses a non-terminal status, and it stamps
 * PerformedProcedureStepEndDate/Time unconditionally. A mode flag would have to
 * disable both guards, so every reader of every call site would have to trace
 * the flag before knowing whether the returned dataset ends a procedure step.
 * Two builders, two contracts, and neither of them has a mode.
 *
 * What goes in is only what the caller asked for. An N-SET is attribute-level
 * REPLACEMENT, not a merge, so an attribute that is present replaces what the
 * SCP holds and an attribute that is absent leaves it alone. That is why
 * `status` and `performedSeries` are distinguished by being undefined rather
 * than by being empty:
 *
 *   status omitted           the status attribute is absent from the dataset.
 *                            The SCP reads "these attributes changed, the step
 *                            is still running" and its own status is untouched.
 *   performedSeries omitted  PerformedSeriesSequence is absent, so whatever the
 *                            N-CREATE or an earlier update established survives.
 *   performedSeries []       the sequence is present and empty, which ERASES
 *                            what the SCP holds. Legal, occasionally meant,
 *                            never accidental — the caller has to pass it.
 *
 * @param {object} [params]
 * @param {string} [params.status] IN PROGRESS, or omitted for no status at all.
 * @param {Array<object>} [params.performedSeries] Omitted to leave the sequence alone.
 * @returns {Record<string, unknown>}
 */
function buildInterimSetDataset(params = {}) {
  const { status, performedSeries } = params;

  if (status !== undefined && status !== Status.IN_PROGRESS) {
    throw new args.UsageError(
      `An interim N-SET leaves the step running, so the only status it may carry is ` +
        `${Status.IN_PROGRESS}, not "${status}". ` +
        `${Status.COMPLETED} and ${Status.DISCONTINUED} close a step — use ` +
        '`dcm mpps complete` or `dcm mpps discontinue`, which also stamp the end date and ' +
        'time that a terminal status has to be accompanied by.'
    );
  }

  const dataset = {};
  if (status !== undefined) dataset.PerformedProcedureStepStatus = status;
  if (performedSeries !== undefined) {
    dataset.PerformedSeriesSequence = Array.isArray(performedSeries) ? performedSeries : [];
  }

  // PerformedProcedureStepEndDate/Time are deliberately absent and there is no
  // way to add them here. An end time on a running step is a contradiction the
  // SCP cannot resolve: some record it and report the step as having ended
  // while its status still says IN PROGRESS, which is how a sweeper decides a
  // live exam is finished and closes the order under it.

  if (Object.keys(dataset).length === 0) {
    throw new args.UsageError(
      'This N-SET would carry no attributes at all — no status, and no performed series. ' +
        'An N-SET says what changed, so one that says nothing changed is not a message the ' +
        'far end can act on; a conformant SCP is entitled to refuse it and a lenient one ' +
        'will record an update that reports nothing.\n' +
        '\n' +
        'The two shapes this is probably meant to be:\n' +
        `  keep-alive              drop --no-status, and the update carries ${Status.IN_PROGRESS}\n` +
        '  status-absent update    add --series-from <folder>, so the sequence is what changed\n' +
        '\n' +
        'Between them those cover both branches a receiver takes on an interim N-SET — a ' +
        'status it recognises, and no status at all — and neither of them is empty.'
    );
  }

  return dataset;
}

/**
 * Refuses flags that would carry an N-CREATE-only attribute into an N-SET.
 *
 * Named by attribute rather than by flag, because the flag is what was typed
 * and the attribute is what is actually wrong: `--station-ae` is a perfectly
 * good flag on `dcm mpps start` and the message has to explain why the same
 * word is refused three commands later.
 *
 * @param {Map} flags
 * @param {string} verb Used in the message, e.g. 'update'.
 */
function assertNoCreateOnlyFlags(flags, verb) {
  const offending = Object.keys(CREATE_ONLY_ATTRIBUTES).filter((name) => flags.has(name));
  if (offending.length === 0) return;

  const lines = offending.map(
    (name) => `  --${name} would set ${CREATE_ONLY_ATTRIBUTES[name]}`
  );

  throw new args.UsageError(
    `${offending.length === 1 ? 'That attribute is' : 'Those attributes are'} N-CREATE-only:\n` +
      `${lines.join('\n')}\n` +
      'PS3.4 F.7.2-1 leaves the N-SET column blank for all of these. They fix what the step ' +
      'is, who it is for and where it ran, and they are settled when the step is created; an ' +
      `N-SET reports progress against a step that already exists. \`dcm mpps ${verb}\` will ` +
      'not send them.\n' +
      'If one of them is wrong, the step itself is wrong: discontinue it and open a new one ' +
      'with `dcm mpps start`.'
  );
}

/**
 * Parses `--reason-code CODE^SCHEME^MEANING` into a code sequence item.
 *
 * A discontinuation reason is a *coded* attribute. Free text has nowhere legal
 * to go in it: all three of CodeValue, CodingSchemeDesignator and CodeMeaning
 * are Type 1 inside the item, so accepting `--reason "patient moved"` and
 * inventing a code value to carry it would put a code in the record that means
 * nothing to the receiving system and cannot be looked up. That is the same
 * class of fabrication as listing an instance the archive does not hold, so
 * `--reason` stays local and human-readable, and only `--reason-code` is sent.
 *
 * @param {string|undefined} value
 * @returns {Array<object>} Zero or one item.
 */
function parseReasonCode(value) {
  if (value === undefined || value === null || value === '') return [];
  const parts = String(value).split('^');
  if (parts.length !== 3 || parts.some((p) => p.trim() === '')) {
    throw new args.UsageError(
      `--reason-code must be CODE^SCHEME^MEANING, e.g. ` +
        `"110513^DCM^Discontinued for equipment failure". Got "${value}".\n` +
        'All three parts are Type 1 inside the code item, so none may be blank.'
    );
  }
  return [{
    CodeValue: parts[0].trim(),
    CodingSchemeDesignator: parts[1].trim(),
    CodeMeaning: parts[2].trim(),
  }];
}

// --- Worklist handoff ------------------------------------------------------

/**
 * Flattens a worklist match without destroying its sequences.
 *
 * `dcm find --mwl` flattens the Scheduled Procedure Step Sequence for reading;
 * a raw export may leave it nested. Both have to work, so scheduled-step
 * attributes are lifted here if they are still nested, and sequence values are
 * carried across as sequences rather than being rendered.
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function flattenWorklistItem(item) {
  const flat = {};
  const clean = stripPrivate(item ?? {});

  const sequence = clean.ScheduledProcedureStepSequence;
  if (Array.isArray(sequence) && sequence.length && sequence[0] && typeof sequence[0] === 'object') {
    Object.assign(flat, sequence[0]);
  }
  for (const [key, value] of Object.entries(clean)) {
    if (key === 'ScheduledProcedureStepSequence') continue;
    if (value === '' && flat[key] !== undefined && flat[key] !== '') continue;
    flat[key] = value;
  }
  return flat;
}

/**
 * Names the attributes whose sequence arrived as a string.
 *
 * `dcm find --mwl --json` puts every value through a display formatter, which
 * stringifies sequences: ReferencedStudySequence comes back as the text
 * `[{"ReferencedSOPClassUID":...}]` and an empty sequence comes back as `''`.
 * That output is for people to read. Feeding it to an N-CREATE would either
 * send a sequence-valued attribute as a string, which dcmjs cannot encode, or
 * silently lose it.
 *
 * Detecting it is worth the twenty lines because the failure otherwise looks
 * like a broken worklist rather than the wrong export format.
 *
 * @param {Record<string, unknown>} item
 * @returns {string[]}
 */
function stringifiedSequences(item) {
  const bad = [];
  for (const [key, value] of Object.entries(item ?? {})) {
    if (!key.endsWith('Sequence')) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) bad.push(key);
  }
  return bad;
}

/**
 * The `--from-worklist` value that means standard input.
 *
 * One character, and it has to be recognised before anything path-shaped
 * happens to it. `path.resolve('-')` is a file called `-` in the working
 * directory, which is a real thing someone could create and never what was
 * meant; and the POSIX workaround people reach for instead, `/dev/stdin`,
 * resolves to `C:\proc\self\fd\0` on Windows — a path that cannot exist. Both
 * failures read as "the worklist is missing" rather than "this build does not
 * do pipes", which is why the token is checked first and nothing else can get
 * at it.
 */
const STDIN_TOKEN = '-';

/** How the source is named in every message about it. */
const STDIN_LABEL = 'standard input';

/**
 * Reads the raw worklist text from a file or from standard input.
 *
 * @param {string} file A path, or "-" for stdin.
 * @returns {{label: string, raw: string, fromStdin: boolean}}
 */
function readWorklistSource(file) {
  if (file === STDIN_TOKEN) {
    let raw;
    try {
      // fd 0 rather than '/dev/stdin': the descriptor is the portable spelling
      // and is what makes `dcm find --mwl --json-raw ... | dcm mpps start
      // --from-worklist -` work on the platform the CI runners are on.
      raw = fs.readFileSync(0, 'utf8');
    } catch (err) {
      throw new args.UsageError(
        `--from-worklist - could not read ${STDIN_LABEL}: ${err.message}. ` +
          'Something has to be piped in, e.g. ' +
          '`dcm find --mwl --json-raw ... | dcm mpps start --from-worklist - ...`.'
      );
    }
    if (raw.trim() === '') {
      throw new args.UsageError(
        `--from-worklist - read nothing from ${STDIN_LABEL}. ` +
          'Nothing was piped in, or the producing command wrote its matches somewhere else — ' +
          '`dcm find --mwl --json-raw` puts them on stdout, and only --json-raw carries the ' +
          'sequences an N-CREATE needs.'
      );
    }
    return { label: STDIN_LABEL, raw, fromStdin: true };
  }

  const resolved = path.resolve(file);
  try {
    return { label: resolved, raw: fs.readFileSync(resolved, 'utf8'), fromStdin: false };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new args.UsageError(`--from-worklist "${resolved}" does not exist.`);
    }
    if (err.code === 'EISDIR') {
      throw new args.UsageError(`--from-worklist "${resolved}" is a directory, not a JSON file.`);
    }
    throw new args.UsageError(`--from-worklist "${resolved}" could not be read: ${err.message}`);
  }
}

/**
 * One line of the numbered preview a multi-item refusal prints.
 *
 * Extracted because --index is documented as being the number this preview
 * shows, and a selector that means one thing and a preview that numbers
 * another would be worse than no selector at all.
 *
 * @param {Record<string, unknown>} item
 * @param {number} i Zero-based.
 * @returns {string}
 */
function previewLine(item, i) {
  return `  ${i + 1}. ${textOf(item.PatientName) || '(no name)'} · ` +
    `Accession ${textOf(item.AccessionNumber) || '(none)'} · ` +
    `Study ${textOf(item.StudyInstanceUID) || '(none)'}`;
}

/**
 * Reads a structured worklist item from a JSON file or from standard input.
 *
 * Accepts, in order of how people actually produce them:
 *   - `{ matches: [ ... ] }`, the shape a machine-readable `dcm find --mwl`
 *     export has (see the note in the `--from-worklist` help)
 *   - `{ items: [ ... ] }`, the hand-written shape `dcm scp --worklist` reads
 *   - a bare array of items
 *   - a single item object
 *
 * @param {string} file A path, or "-" for standard input.
 * @param {{studyUid?: string, accession?: string, index?: number, first?: boolean}} [select]
 *   Narrows a multi-item document. studyUid and accession filter; index and
 *   first pick a row out of what is left.
 * @returns {{file: string, item: Record<string, unknown>, count: number,
 *   fromStdin: boolean, index: number, selectedBy: string}}
 */
function readWorklistFile(file, select = {}) {
  const { label: resolved, raw, fromStdin } = readWorklistSource(file);

  // How the source is named in a sentence. A path is quoted; stdin is not,
  // because `--from-worklist "standard input"` reads as a filename.
  const where = fromStdin ? `--from-worklist - (${STDIN_LABEL})` : `--from-worklist "${resolved}"`;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new args.UsageError(`${where} is not valid JSON: ${err.message}`);
  }

  let items;
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed && Array.isArray(parsed.matches)) items = parsed.matches;
  else if (parsed && Array.isArray(parsed.items)) items = parsed.items;
  else if (parsed && typeof parsed === 'object') items = [parsed];
  else {
    throw new args.UsageError(
      `${where} must be a worklist item, an array of them, or an ` +
        'object with a "matches" or "items" array.'
    );
  }

  if (items.length === 0) {
    throw new args.UsageError(`${where} contains no worklist items.`);
  }

  const flattened = items.map((item) => flattenWorklistItem(item));

  const stringified = flattened.flatMap((item) => stringifiedSequences(item));
  if (stringified.length) {
    throw new args.UsageError(
      `${where} holds rendered text where sequences should be: ` +
        `${[...new Set(stringified)].join(', ')}.\n` +
        'That file came from `dcm find --mwl --json`, which formats every value for a ' +
        'person to read and turns a sequence into a string. It cannot be fed to an ' +
        'N-CREATE. Re-export it with `dcm find --mwl --json-raw`, which emits the ' +
        'attributes as they arrived, and pass that.'
    );
  }

  // Selection and override are the same two flags wearing different hats, and
  // which hat they wear depends on how many items there are.
  //
  // With one item there is nothing to narrow, so --study-uid and --accession
  // are pure overrides: correcting an accession the worklist got wrong is a
  // normal thing to do, and filtering the only item out because of it would
  // read as "the worklist is empty". The one exception is Study Instance UID,
  // which is not an override at all — it is the key this step will be
  // reconciled on, so naming a different one than the item carries means the
  // file does not describe the study being performed.
  // --index and --first are positional selectors, and two of them state
  // different rows, so both together is a mistake worth failing on rather than
  // resolving by precedence. (--first IS --index 1, which is why the message
  // says so instead of just refusing.)
  if (select.index !== undefined && select.first) {
    throw new args.UsageError(
      `--index ${select.index} and --first both say which row to take. --first is --index 1; ` +
        'give one of them.'
    );
  }

  if (flattened.length === 1) {
    const only = flattened[0];
    const itemStudyUid = textOf(only.StudyInstanceUID);
    if (select.studyUid && itemStudyUid && itemStudyUid !== select.studyUid) {
      throw new args.UsageError(
        `--study-uid says ${select.studyUid} but the only item in ${resolved} is for ` +
          `${itemStudyUid}. Study Instance UID is what the RIS reconciles the performed ` +
          'step against, so these cannot disagree.'
      );
    }
    if (select.index !== undefined && select.index !== 1) {
      throw new args.UsageError(
        `--index ${select.index} names row ${select.index}, and ${where} holds one item. ` +
          'Row numbers are 1-based and count the rows left after --study-uid and --accession ' +
          'have filtered.'
      );
    }
    return {
      file: resolved,
      item: only,
      count: 1,
      fromStdin,
      index: 1,
      selectedBy: 'the only item',
    };
  }

  const wanted = flattened.filter((item) => {
    if (select.studyUid && textOf(item.StudyInstanceUID) !== select.studyUid) return false;
    if (select.accession && textOf(item.AccessionNumber) !== select.accession) return false;
    return true;
  });

  if (wanted.length === 0) {
    const how = [
      select.studyUid ? `--study-uid ${select.studyUid}` : undefined,
      select.accession ? `--accession ${select.accession}` : undefined,
    ].filter(Boolean).join(' and ');
    throw new args.UsageError(
      `${where} has ${flattened.length} items, none matching ` +
        `${how || 'the given selection'}.`
    );
  }

  // The numbering below is the numbering the refusal prints, and --index is
  // documented against it: it counts the rows that survived --study-uid and
  // --accession, not the rows in the document. Anything else would make the
  // preview a list of numbers that do not select what they are next to.
  const preview = wanted.slice(0, 5).map(previewLine);
  const previewBlock =
    `${preview.join('\n')}${wanted.length > 5 ? `\n  … and ${wanted.length - 5} more` : ''}`;

  if (select.index !== undefined) {
    if (select.index < 1 || select.index > wanted.length) {
      throw new args.UsageError(
        `--index ${select.index} is out of range: ${where} offers ` +
          `${wanted.length} row${wanted.length === 1 ? '' : 's'} to choose from, numbered 1 to ` +
          `${wanted.length}.\n${previewBlock}`
      );
    }
    return {
      file: resolved,
      item: wanted[select.index - 1],
      count: flattened.length,
      fromStdin,
      index: select.index,
      selectedBy: `--index ${select.index} of ${wanted.length}`,
    };
  }

  if (select.first) {
    return {
      file: resolved,
      item: wanted[0],
      count: flattened.length,
      fromStdin,
      index: 1,
      selectedBy: `--first of ${wanted.length}`,
    };
  }

  if (wanted.length > 1) {
    // Still the default, and deliberately: an MPPS step is a clinical record of
    // one piece of work, and a tool that quietly picks a row when the operator
    // did not say which one produces a step attributed to the wrong order with
    // nothing on the wire to show for it. --index and --first are the ways to
    // say it out loud.
    throw new args.UsageError(
      `${where} holds ${wanted.length} worklist items, and an MPPS ` +
        'procedure step describes exactly one. Say which:\n' +
        `${previewBlock}\n` +
        '  --study-uid <uid>   the one being performed, and the key it reconciles on\n' +
        '  --accession <text>  the order number\n' +
        '  --index <n>         the row above, by the number printed next to it\n' +
        '  --first             the first row above, for a query written to return one'
    );
  }

  return {
    file: resolved,
    item: wanted[0],
    count: flattened.length,
    fromStdin,
    index: 1,
    selectedBy: [
      select.studyUid ? `--study-uid ${select.studyUid}` : undefined,
      select.accession ? `--accession ${select.accession}` : undefined,
    ].filter(Boolean).join(' and ') || 'the only matching item',
  };
}

/**
 * Maps a flattened worklist item onto the attribute names the builders take.
 *
 * @param {Record<string, unknown>} item
 * @returns {object}
 */
function worklistToAttributes(item) {
  const t = (key) => textOf(item?.[key]);
  return {
    studyInstanceUid: t('StudyInstanceUID'),
    accessionNumber: t('AccessionNumber'),
    patientId: t('PatientID'),
    patientName: t('PatientName'),
    patientBirthDate: t('PatientBirthDate'),
    patientSex: t('PatientSex'),
    modality: t('Modality'),
    requestedProcedureId: t('RequestedProcedureID'),
    requestedProcedureDescription: t('RequestedProcedureDescription'),
    scheduledProcedureStepId: t('ScheduledProcedureStepID'),
    scheduledProcedureStepDescription: t('ScheduledProcedureStepDescription'),
    // Not an MPPS attribute — StudyID is not sent in the N-CREATE. It is here
    // because it is part of the identity the RIS assigns, and
    // `mpps perform --adopt-worklist-identity` stamps it onto the images.
    studyId: t('StudyID'),
    performedProcedureStepDescription: t('ScheduledProcedureStepDescription'),
    scheduledStationAeTitle: t('ScheduledStationAETitle'),
    referencedStudySequence: normaliseSequence(item?.ReferencedStudySequence),
    scheduledProtocolCodeSequence: normaliseSequence(item?.ScheduledProtocolCodeSequence),
    procedureCodeSequence: normaliseSequence(item?.ProcedureCodeSequence),
    referencedPatientSequence: normaliseSequence(item?.ReferencedPatientSequence),
  };
}

// --- The wire --------------------------------------------------------------

/**
 * True when the peer accepted a presentation context for MPPS.
 *
 * A peer can accept the association and refuse this one context, in which case
 * no response ever arrives and the command sits there until the PDU watchdog
 * fires. Reporting "this peer does not support MPPS" is the difference between
 * a two-second answer and a sixty-second timeout that reads like a network
 * fault.
 *
 * @param {object} association
 * @returns {boolean}
 */
function mppsContextAccepted(association) {
  try {
    for (const { context } of association.getPresentationContexts()) {
      if (
        context.getAbstractSyntaxUid() === MPPS_SOP_CLASS &&
        context.getResult() === constants.PresentationContextResult.Accept
      ) {
        return true;
      }
    }
  } catch {
    // Not every stack populates this before the first response. Absence of
    // evidence is not evidence of refusal, so assume the context is there and
    // let the response — or its absence — speak.
    return true;
  }
  return false;
}

/**
 * Runs one N-service request over its own association.
 *
 * Returns data rather than throwing, in the same spirit as runAssociation():
 * a peer that refuses the operation is an expected result the caller has to
 * report on, not an exception.
 *
 * @param {object} params
 * @param {object} params.connection {host, port, callingAe, calledAe}
 * @param {object} params.timeouts
 * @param {object} params.request An NCreateRequest or NSetRequest.
 * @returns {Promise<{outcome: object, status: number|undefined, comment: string|undefined,
 *   contextAccepted: boolean, affectedSopInstanceUid: string|undefined, dataset: object|undefined}>}
 */
async function sendNRequest(params) {
  const { connection, timeouts, request } = params;

  let status;
  let comment;
  let affectedSopInstanceUid;
  let dataset;

  request.on('response', (response) => {
    status = response.getStatus();
    comment = response.getErrorComment();

    // The asymmetry that catches everyone, and the reason this is one shared
    // getter rather than one per request type: on an N-SET *request* the
    // instance UID is the "requested" one, but NSetResponse.fromRequest() maps
    // requested onto affected, so on the *response* — for N-CREATE and N-SET
    // alike — only getAffectedSopInstanceUid() returns anything.
    // getRequestedSopInstanceUid() yields undefined here and makes a perfectly
    // good response look unattributable.
    try {
      affectedSopInstanceUid = response.getAffectedSopInstanceUid();
    } catch {
      affectedSopInstanceUid = undefined;
    }

    // N-CREATE and N-SET responses usually carry no dataset at all. Asking for
    // its elements without checking is how this path throws on a success.
    try {
      const ds = response.getDataset();
      if (ds) dataset = ds.getElements();
    } catch {
      dataset = undefined;
    }
  });

  let contextAccepted = true;
  const { outcome } = await runAssociation({
    host: connection.host,
    port: connection.port,
    callingAe: connection.callingAe,
    calledAe: connection.calledAe,
    requests: [request],
    timeouts,
    onAccepted: (assoc) => {
      contextAccepted = mppsContextAccepted(assoc);
    },
  });

  return { outcome, status, comment, contextAccepted, affectedSopInstanceUid, dataset };
}

/**
 * Sends the N-CREATE that opens a procedure step.
 *
 * @param {object} params
 * @param {object} params.connection
 * @param {object} params.timeouts
 * @param {string} params.mppsSopInstanceUid
 * @param {Record<string, unknown>} params.dataset
 * @returns {Promise<object>} See {@link sendNRequest}.
 */
function nCreate(params) {
  const { connection, timeouts, mppsSopInstanceUid, dataset } = params;
  return sendNRequest({
    connection, timeouts, request: createRequest(mppsSopInstanceUid, dataset),
  });
}

/**
 * Builds the N-CREATE request, without sending it.
 *
 * Separate from nCreate() so that the encoded octets can be read back before
 * anything is opened — `--set` promises a value goes on the wire byte for byte,
 * and the only way to keep that promise is to encode the dataset and look, on
 * the dry run as well as on the live path. A dry run that printed a dataset the
 * writer would then shorten would be exactly the false reassurance the flag
 * exists to remove.
 *
 * @param {string} mppsSopInstanceUid
 * @param {Record<string, unknown>} dataset
 * @returns {object} An NCreateRequest with its dataset attached.
 */
function createRequest(mppsSopInstanceUid, dataset) {
  // Two arguments only. Passing a third (metaSopClassUid) makes the library
  // negotiate a context for the meta class and the real one never gets
  // proposed, so the peer answers nothing.
  const request = new NCreateRequest(MPPS_SOP_CLASS, mppsSopInstanceUid);

  // Mandatory: setDataset() is what flips CommandDataSetType. Without it the
  // command says "no dataset follows" and the SCP receives an empty N-CREATE.
  request.setDataset(new Dataset(dataset));
  return request;
}

/**
 * Sends the N-SET that closes or updates a procedure step.
 *
 * @param {object} params See {@link nCreate}.
 * @returns {Promise<object>} See {@link sendNRequest}.
 */
function nSet(params) {
  const { connection, timeouts, mppsSopInstanceUid, dataset } = params;
  return sendNRequest({
    connection, timeouts, request: setRequest(mppsSopInstanceUid, dataset),
  });
}

/**
 * Builds the N-SET request, without sending it. See {@link createRequest}.
 *
 * @param {string} mppsSopInstanceUid
 * @param {Record<string, unknown>} dataset
 * @returns {object}
 */
function setRequest(mppsSopInstanceUid, dataset) {
  const request = new NSetRequest(MPPS_SOP_CLASS, mppsSopInstanceUid);
  request.setDataset(new Dataset(dataset));
  return request;
}

module.exports = {
  MPPS_SOP_CLASS,
  Status,
  LEGAL_TRANSITIONS,
  CREATE_TYPE_1,
  CREATE_TYPE_2,
  CREATE_ONLY_ATTRIBUTES,
  SCHEDULED_STEP_TYPE_2,

  dicomDate,
  dicomTime,
  textOf,
  stripPrivate,
  isEmptyValue,
  normaliseSequence,

  newMppsUid,
  requireUid,
  assertLegalTransition,

  buildScheduledStepItem,
  scheduledStepSequence,
  unscheduledStepSequence,
  isUnscheduledStepSequence,
  buildCreateDataset,
  missingType1,
  assertCreatable,

  buildPerformedSeriesSequence,
  buildPerformedSeriesSequenceFromFolder,
  seriesMetaFromScan,
  buildSetDataset,
  buildInterimSetDataset,
  assertNoCreateOnlyFlags,
  parseReasonCode,

  flattenWorklistItem,
  stringifiedSequences,
  readWorklistSource,
  readWorklistFile,
  worklistToAttributes,
  STDIN_TOKEN,
  STDIN_LABEL,

  mppsContextAccepted,
  sendNRequest,
  nCreate,
  createRequest,
  nSet,
  setRequest,
};
