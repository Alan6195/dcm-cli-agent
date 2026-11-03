'use strict';

const fs = require('fs');
const path = require('path');
const dcmjs = require('dcmjs');

const log = require('../lib/log');
const args = require('../lib/args');
const tagLib = require('../lib/tags');
const { scan } = require('../lib/scan');
const { resolveKey, describeKeySource, createPseudonymiser, KEY_ENV } = require('../lib/pseudonym');
const { dcmjsDimse } = require('../lib/dimse');
const { bytes, BAR } = require('../lib/report');

const { Dataset } = dcmjsDimse;
const { nameMap } = dcmjs.data.DicomMetaDictionary;

const FLAGS = [
  'out', 'no-recurse', 'keep-descriptions', 'keep-private', 'keep-dates', 'keep-patient-characteristics', 'prefix',
];

const USAGE = `
dcm anon — de-identify a folder into a new directory

Produces a copy with patient identifiers removed and UIDs replaced, so a study
can be shared for testing or support without carrying patient data. The source
folder is never modified.

Usage:
  dcm anon <folder> --out <dir> [options]

Options:
  --out <dir>            Destination. Required. Must not be inside <folder>.
  --prefix <text>        Pseudonym prefix. Default: ANON
  --keep-descriptions    Keep Study/Series descriptions (removed by default).
  --keep-dates           Keep dates as they are. By default every date is
                         shifted into the past by a per-patient offset.
  --keep-patient-characteristics
                         Keep age, sex, size, weight, ethnic group, sex
                         neutered, smoking and pregnancy status (removed by
                         default). Needed for PET SUV. PS3.15 Annex E Retain
                         Patient Characteristics Option.
  --keep-private         Keep private and unrecognised tags (removed by default).
  --no-recurse           Only look at files directly in the folder.

Environment:
  ${KEY_ENV}           Secret for the pseudonyms. When set, the same input
                         gives the same pseudonyms on every run and machine
                         that shares it. When unset, a random key is made for
                         each run: consistent within the run, unlinkable
                         between runs. The key is never printed.

What it does (after the DICOM PS3.15 Annex E Basic Profile), at every depth of
every sequence:
  - Replaces patient name, ID, accession number and study ID with keyed
    pseudonyms (HMAC-SHA256), so the same patient maps to the same pseudonym
    across every file in the run and the original cannot be recomputed from
    the output.
  - Replaces every UID (Study, Series, SOP Instance, Frame of Reference, and
    every reference to them) with a keyed 2.25.* value, so the relationships
    between and within instances survive. SOP Class and Transfer Syntax UIDs,
    and anything under the DICOM root 1.2.840.10008, are kept.
  - Replaces or blanks every person name, and removes birth date, age, sex,
    weight, size, addresses, other patient IDs, institution, physician,
    operator, station and device identifiers, and free-text comments. Age,
    sex, size and weight stay with --keep-patient-characteristics.
  - Shifts every date (DA and DT) into the past by an offset that is the same
    for every file of one patient, so intervals survive. Times are kept.
  - Removes overlays (60xx) and curves (50xx), which can carry burned-in text.
  - Removes private and unrecognised tags unless --keep-private.
  - Marks the result with PatientIdentityRemoved = YES and records the method.

What it does NOT do — read this before sharing anything:
  - It does not touch pixel data. Burned-in annotations, scanned requisitions
    and secondary captures of paperwork will still contain identifiers.
  - Coded content and numeric measurements in Structured Reports are kept, and
    with --keep-private any identifier a vendor put in a private tag survives.
  - It is not a certified implementation of the DICOM PS3.15 confidentiality
    profiles, and it is not a substitute for reviewing the output.
  Always inspect a sample before sharing, and treat the result as
  de-identified-on-a-best-effort-basis rather than provably anonymous.

Example:
  dcm anon ./study --out ./study-anon
  dcm info ./study-anon
`.trimStart();

/**
 * Elements replaced with a keyed pseudonym derived from the original.
 * Using a derived value rather than a constant keeps distinct patients
 * distinct in the output, which matters for testing multi-patient behaviour.
 */
const PSEUDONYMISE = ['PatientID', 'AccessionNumber', 'StudyID'];

/** Elements emptied (zero length): the original list, plus Annex E "Z" items. */
const BLANK = [
  'PatientBirthDate', 'PatientBirthTime', 'PatientAddress', 'PatientTelephoneNumbers',
  'PatientMotherBirthName', 'OtherPatientNames', 'PatientBirthName',
  'ReferringPhysicianName', 'ReferringPhysicianAddress', 'ReferringPhysicianTelephoneNumbers',
  'PerformingPhysicianName', 'NameOfPhysiciansReadingStudy', 'PhysiciansOfRecord',
  'OperatorsName', 'RequestingPhysician', 'ScheduledPerformingPhysicianName',
  'InstitutionName', 'InstitutionAddress', 'InstitutionalDepartmentName',
  'StationName', 'DeviceSerialNumber', 'PlateID', 'DetectorID',
  'MilitaryRank', 'BranchOfService', 'EthnicGroup', 'Occupation',
  'PatientComments', 'AdditionalPatientHistory', 'MedicalRecordLocator',
  'PatientInsurancePlanCodeSequence', 'IssuerOfPatientID',
  'ImageComments', 'DerivationDescription', 'ContentCreatorName',
  'RequestAttributesSequence', 'ReferencedPatientSequence',
  'PerformedProcedureStepID', 'ScheduledStudyLocation', 'CurrentPatientLocation',
  // Added from Annex E.
  'PatientSex', 'FillerOrderNumberImagingServiceRequest', 'PlacerOrderNumberImagingServiceRequest',
  'TextValue', 'UnformattedTextValue',
];

/** Elements deleted outright — Annex E "X". Matched with any RETIRED_ prefix stripped. */
const REMOVE = [
  // Patient characteristics and history.
  'PatientAge', 'PatientWeight', 'PatientSize', 'PatientSexNeutered', 'PregnancyStatus',
  'SmokingStatus', 'LastMenstrualDate', 'Allergies', 'MedicalAlerts', 'PatientReligiousPreference',
  'PatientState', 'PatientTransportArrangements', 'SpecialNeeds', 'CountryOfResidence',
  'RegionOfResidence', 'PatientInstitutionResidence', 'PatientPrimaryLanguageCodeSequence',
  'PatientPrimaryLanguageModifierCodeSequence', 'PatientTelecomInformation', 'EthnicGroupCodeSequence',
  'PatientBirthDateInAlternativeCalendar', 'PatientDeathDateInAlternativeCalendar', 'PatientAlternativeCalendar',
  'ConfidentialityConstraintOnPatientDataDescription',
  // Other identifiers for the same patient.
  'OtherPatientIDs', 'OtherPatientIDsSequence', 'ReferencedPatientAliasSequence',
  // Visit and admission.
  'AdmissionID', 'IssuerOfAdmissionID', 'IssuerOfAdmissionIDSequence', 'ServiceEpisodeID',
  'ServiceEpisodeDescription', 'IssuerOfServiceEpisodeID', 'IssuerOfServiceEpisodeIDSequence',
  'AdmittingDiagnosesDescription', 'AdmittingDiagnosesCodeSequence', 'DischargeDiagnosisDescription',
  'VisitComments', 'ScheduledPatientInstitutionResidence',
  // Order, request and procedure step.
  'RequestedProcedureID', 'RequestedProcedureComments', 'RequestedProcedureLocation',
  'RequestedContrastAgent', 'RequestingService', 'ReasonForTheImagingServiceRequest', 'ReasonForStudy',
  'ImagingServiceRequestComments', 'OrderEnteredBy', 'OrderEntererLocation', 'OrderCallbackPhoneNumber',
  'OrderCallbackTelecomInformation', 'StudyComments', 'StudyIDIssuer',
  'ScheduledProcedureStepDescription', 'ScheduledProcedureStepLocation', 'ScheduledStationAETitle',
  'ScheduledStationName', 'ScheduledStationNameCodeSequence', 'ScheduledStationGeographicLocationCodeSequence',
  'ScheduledStudyLocationAETitle', 'ScheduledHumanPerformersSequence', 'PreMedication',
  'CommentsOnThePerformedProcedureStep', 'PerformedLocation', 'PerformedStationAETitle',
  'PerformedStationName', 'PerformedStationNameCodeSequence', 'PerformedStationGeographicLocationCodeSequence',
  'ActualHumanPerformersSequence', 'HumanPerformerName', 'HumanPerformerOrganization',
  // Institution, station and device.
  'InstitutionCodeSequence', 'InstitutionalDepartmentTypeCodeSequence', 'StationAETitle',
  'SourceApplicationEntityTitle', 'GantryID', 'GeneratorID', 'CassetteID',
  'ModifyingDeviceID', 'ModifyingDeviceManufacturer',
  // Free text, interpretation and results.
  'AcquisitionComments', 'AcquisitionDeviceProcessingDescription', 'AcquisitionProtocolDescription',
  'ContributionDescription', 'FrameComments', 'IdentifyingComments', 'ImagePresentationComments',
  'TextComments', 'TextString', 'TopicAuthor', 'TopicKeywords', 'TopicSubject', 'TopicTitle',
  'Impressions', 'InterpretationText', 'InterpretationAuthor', 'InterpretationDiagnosisDescription',
  'InterpretationIDIssuer', 'InterpretationRecorder', 'InterpretationTranscriber',
  'InterpretationApproverSequence', 'PhysicianApprovingInterpretation', 'ResultsComments',
  'ResultsIDIssuer', 'ResultsDistributionListSequence', 'DistributionAddress', 'DistributionName',
  'NamesOfIntendedRecipientsOfResults', 'PersonAddress', 'PersonTelephoneNumbers',
  'PersonTelecomInformation', 'ResponsibleOrganization', 'ResponsiblePerson',
  'CustodialOrganizationSequence', 'AuthorObserverSequence', 'ParticipantSequence', 'VerifyingOrganization',
  // Copies of the original data, signatures over it, and thumbnails of it.
  'OriginalAttributesSequence', 'ModifiedAttributesSequence', 'DigitalSignaturesSequence',
  'ReferencedDigitalSignatureSequence', 'ReferencedSOPInstanceMACSequence', 'MACParametersSequence',
  'DataSetTrailingPadding', 'IconImageSequence',
];

/**
 * Kept by --keep-patient-characteristics: the attributes the Annex E Retain
 * Patient Characteristics Option marks K. Its "C" (clean) items — allergies,
 * medical alerts, additional history and the like — are free text that cannot
 * be cleaned mechanically, so they stay removed.
 */
const PATIENT_CHARACTERISTICS = [
  'PatientAge', 'PatientSex', 'PatientSize', 'PatientWeight',
  'EthnicGroup', 'PatientSexNeutered', 'SmokingStatus', 'PregnancyStatus',
];

/** Descriptions: clinically useful, occasionally identifying. */
const DESCRIPTIONS = [
  'StudyDescription', 'SeriesDescription', 'ProtocolName',
  'RequestedProcedureDescription', 'PerformedProcedureStepDescription',
];

/**
 * Person identification sequences — PerformingPhysicianIdentificationSequence,
 * VerifyingObserverIdentificationCodeSequence and the rest. Emptied rather than
 * deleted, because some are Type 2.
 */
const IDENTIFICATION_SEQUENCE = /Identification(Code)?Sequence$/;

/**
 * UIDs that name a kind of thing rather than a thing: SOP classes, transfer
 * syntaxes, coding schemes. They identify nobody, and replacing them would make
 * the file unreadable or its codes meaningless. Everything else with VR UI is
 * an instance UID and is replaced, wherever it sits.
 */
const PRESERVED_UID_KEYWORDS = /(ClassUID|ClassesInStudy|ClassesInSeries|ClassesSupported|TransferSyntaxUID)(InFile)?$/;
const PRESERVED_UID_NAMES = new Set(['CodingSchemeUID', 'ContextUID', 'MappingResourceUID', 'SegmentationTemplateUID']);
/** Every UID the standard itself defines — SOP classes, well-known instances, context groups. */
const DICOM_ROOT = '1.2.840.10008.';

const BLANK_SET = new Set(BLANK);
const REMOVE_SET = new Set(REMOVE);
const DESCRIPTION_SET = new Set(DESCRIPTIONS);
const PSEUDONYMISE_SET = new Set(PSEUDONYMISE);
const PATIENT_CHARACTERISTICS_SET = new Set(PATIENT_CHARACTERISTICS);

/**
 * Key used when deidentifyElements is called without one — a library caller,
 * or a test. Random, once per process. `dcm anon` itself always passes the
 * run's key.
 */
let defaultKey;
function fallbackKey() {
  if (!defaultKey) defaultKey = resolveKey({}).key;
  return defaultKey;
}

function pseudonymiserFor(key) {
  return createPseudonymiser(key || fallbackKey());
}

/** Keyed replacement UID for a source UID. */
function mapUid(sourceUid, key) {
  return pseudonymiserFor(key).uid(sourceUid);
}

/**
 * Short, readable pseudonym derived from a source value under the key.
 *
 * @param {string} prefix
 * @param {string} value
 * @param {Buffer} [key]
 * @returns {string}
 */
function pseudonym(prefix, value, key) {
  return `${prefix}${pseudonymiserFor(key).digits(value, 10)}`;
}

/** True for keys dcmjs could not resolve to a keyword — i.e. private/unknown tags. */
function isRawTagKey(key) {
  return /^[0-9A-Fa-f]{8}$/.test(key);
}

/** Overlay (6000–601E) and curve (5000–501E) repeating groups. */
function isOverlayOrCurveGroup(group) {
  const high = group & 0xff00;
  const low = group & 0x00ff;
  return (high === 0x6000 || high === 0x5000) && low <= 0x1e && low % 2 === 0;
}

/** The group number of a keyword or raw tag key, or undefined. */
function groupOf(key) {
  if (isRawTagKey(key)) return parseInt(key.slice(0, 4), 16);
  const entry = nameMap[key];
  if (!entry || typeof entry.tag !== 'string') return undefined;
  const match = /^\(([0-9A-Fa-f]{4}),/.exec(entry.tag);
  return match ? parseInt(match[1], 16) : undefined;
}

function vrOf(item, key) {
  const mapped = item._vrMap && item._vrMap[key];
  if (mapped) return mapped;
  const entry = nameMap[key];
  return entry ? entry.vr : undefined;
}

/** Applies fn to each value of a possibly multi-valued string element. */
function mapValues(value, fn) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? mapValues(v, fn) : v));
  if (typeof value !== 'string') return value;
  if (value.includes('\\')) return value.split('\\').map((v) => fn(v.trim())).join('\\');
  return fn(value.trim());
}

/** Counts the non-empty string values in a possibly multi-valued element. */
function countValues(value) {
  if (Array.isArray(value)) return value.reduce((n, v) => n + countValues(v), 0);
  if (typeof value !== 'string' || value.trim() === '') return 0;
  return value.split('\\').filter((v) => v.trim() !== '').length;
}

function emptyValue(vr) {
  return vr === 'SQ' ? [] : '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** YYYYMMDD shifted by days, or null when the input is not a real date. */
function shiftYmd(year, month, day, days) {
  const t = Date.UTC(year, month - 1, day);
  const check = new Date(t);
  if (Number.isNaN(t) || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const d = new Date(t + days * 86400000);
  const y = d.getUTCFullYear();
  if (y < 1 || y > 9999) return null;
  return `${String(y).padStart(4, '0')}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/**
 * Shifts one DA value. A date that cannot be parsed is blanked rather than
 * passed through: an unshifted date beside shifted ones would give away the
 * offset.
 */
function shiftDate(value, days) {
  if (value === '') return '';
  if (value.includes('-')) {
    // A range, as a query or a worklist carries it.
    return value.split('-').map((part) => (part === '' ? '' : shiftDate(part, days))).join('-');
  }
  const m = /^(\d{4})\.?(\d{2})\.?(\d{2})$/.exec(value);
  if (!m) return '';
  return shiftYmd(Number(m[1]), Number(m[2]), Number(m[3]), days) ?? '';
}

/** Shifts one DT value, keeping its precision, time of day and UTC offset. */
function shiftDateTime(value, days) {
  if (value === '') return '';
  const m = /^(\d{4})(\d{2})?(\d{2})?(.*)$/.exec(value);
  if (!m) return '';
  const [, y, mo, d, rest] = m;
  const shifted = shiftYmd(Number(y), Number(mo ?? '01'), Number(d ?? '01'), days);
  if (!shifted) return '';
  const precision = 4 + (mo ? 2 : 0) + (d ? 2 : 0);
  return shifted.slice(0, precision) + rest;
}

/** The value a patient's date offset is keyed to, read before anything is replaced. */
function patientKeyOf(elements) {
  const id = elements.PatientID;
  if (typeof id === 'string' && id.trim() !== '') return `id:${id.trim()}`;
  const name = tagLib.personNameText(elements.PatientName);
  if (name !== '') return `name:${name}`;
  return `study:${elements.StudyInstanceUID ?? ''}`;
}

function personPseudonym(ctx, original) {
  return `${ctx.prefix}^${ctx.p.digits(original, 10).slice(0, 8)}`;
}

function isItem(child) {
  return child !== null && typeof child === 'object' && !ArrayBuffer.isView(child) && !(child instanceof ArrayBuffer);
}

/** Walks one dataset or sequence item, in place, recursing into every sequence. */
function cleanItem(item, ctx, stats) {
  for (const key of Object.keys(item)) {
    // Preserve dcmjs's own bookkeeping keys.
    if (key.startsWith('_')) continue;
    const value = item[key];
    const name = key.replace(/^RETIRED_/, '');
    const vr = vrOf(item, key);

    // Overlays and curves go regardless of --keep-private: OverlayData is a
    // bitmap that is drawn over the image, and it can carry burned-in text.
    const group = groupOf(key);
    if (group !== undefined && isOverlayOrCurveGroup(group)) {
      delete item[key];
      stats.elementsRemoved += 1;
      continue;
    }

    if (isRawTagKey(key)) {
      if (!ctx.keepPrivate) {
        delete item[key];
        stats.privateRemoved += 1;
      }
      continue;
    }

    if (ctx.keepPatientCharacteristics && PATIENT_CHARACTERISTICS_SET.has(name)) continue;

    if (REMOVE_SET.has(name)) {
      delete item[key];
      stats.elementsRemoved += 1;
      continue;
    }

    if (BLANK_SET.has(name) || (vr === 'SQ' && IDENTIFICATION_SEQUENCE.test(name))) {
      item[key] = emptyValue(vr);
      stats.elementsRemoved += 1;
      continue;
    }

    if (DESCRIPTION_SET.has(name)) {
      if (!ctx.keepDescriptions) {
        item[key] = '';
        stats.elementsRemoved += 1;
      }
      continue;
    }

    // Patient name: one pseudonym per distinct original, in DICOM PN form.
    //
    // The whole name is hashed, not its Latin component group alone. Two
    // patients whose names are written the same in romaji and differently in
    // kanji are two patients, and hashing only the romaji would give them one
    // pseudonym — merging two people into one in the de-identified copy, which
    // is the opposite of what this command is for.
    if (name === 'PatientName') {
      item[key] = personPseudonym(ctx, tagLib.personNameText(value));
      continue;
    }

    if (PSEUDONYMISE_SET.has(name)) {
      if (value !== undefined && value !== '') {
        item[key] = mapValues(value, (v) => (v === '' ? '' : `${ctx.prefix}${ctx.p.digits(v, 10)}`));
      }
      continue;
    }

    switch (vr) {
      case 'SQ':
        if (Array.isArray(value)) {
          for (const child of value) if (isItem(child)) cleanItem(child, ctx, stats);
        }
        break;

      case 'UI':
        if (PRESERVED_UID_KEYWORDS.test(name) || PRESERVED_UID_NAMES.has(name)) break;
        // Every instance UID, at every depth, under the one key — so
        // ReferencedSOPInstanceUID inside a reference sequence still points at
        // the replaced SOPInstanceUID of the instance it names.
        item[key] = mapValues(value, (v) => {
          if (v === '' || v.startsWith(DICOM_ROOT)) return v;
          stats.uidsRemapped += 1;
          return ctx.p.uid(v);
        });
        break;

      case 'PN': {
        // Any other person — an observer, a performer, a name in an SR content
        // item — gets the same kind of pseudonym, so a Type 1 name stays
        // present and one person stays one person.
        const one = (v) => {
          const text = tagLib.personNameText(v);
          return text === '' ? '' : personPseudonym(ctx, text);
        };
        if (Array.isArray(value)) item[key] = value.map(one);
        else if (value !== undefined && value !== null) item[key] = one(value);
        break;
      }

      case 'DA':
      case 'DT': {
        if (ctx.keepDates) break;
        const shift = vr === 'DA' ? shiftDate : shiftDateTime;
        stats.datesShifted += countValues(value);
        item[key] = mapValues(value, (v) => shift(v, ctx.dayOffset));
        break;
      }

      default:
        break;
    }
  }
}

/** DeidentificationMethod values, each inside the 64-character LO limit. */
function methodValues(ctx) {
  return [
    'dcm-cli-agent best effort after PS3.15 Annex E Basic Profile',
    'Identifiers and UIDs replaced with keyed HMAC pseudonyms',
    'Nested sequences processed; overlays and curves removed',
    ctx.keepDates ? 'Dates kept' : 'Dates shifted by a per-patient offset',
    ctx.keepDescriptions ? 'Descriptions kept' : 'Descriptions removed',
    ctx.keepPrivate ? 'Private tags kept' : 'Private tags removed',
    ...(ctx.keepPatientCharacteristics ? ['Patient characteristics kept (Annex E option)'] : []),
    'Pixel data not inspected',
  ];
}

/**
 * De-identifies one naturalised dataset in place.
 *
 * @param {Record<string, unknown>} elements
 * @param {{prefix: string, keepDescriptions?: boolean, keepPrivate?: boolean,
 *   keepDates?: boolean, keepPatientCharacteristics?: boolean, key?: Buffer}} opts  `key` is the run's pseudonym
 *   key; every file of one run must be given the same one.
 * @returns {{uidsRemapped: number, elementsRemoved: number, privateRemoved: number, datesShifted: number}}
 */
function deidentifyElements(elements, opts) {
  const stats = { uidsRemapped: 0, elementsRemoved: 0, privateRemoved: 0, datesShifted: 0 };
  const p = pseudonymiserFor(opts.key);
  const ctx = {
    p,
    prefix: opts.prefix ?? 'ANON',
    keepDescriptions: !!opts.keepDescriptions,
    keepPrivate: !!opts.keepPrivate,
    keepDates: !!opts.keepDates,
    keepPatientCharacteristics: !!opts.keepPatientCharacteristics,
    // Read before PatientID is replaced: every file of one patient shifts by
    // the same number of days, so intervals between studies survive.
    dayOffset: p.dayOffset(patientKeyOf(elements)),
  };

  cleanItem(elements, ctx, stats);

  // Declare what was done, as PS3.15 expects of de-identified data.
  elements.PatientIdentityRemoved = 'YES';
  elements.LongitudinalTemporalInformationModified = ctx.keepDates ? 'UNMODIFIED' : 'MODIFIED';
  elements.DeidentificationMethod = methodValues(ctx);

  return stats;
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
    throw new args.UsageError('Missing folder. Usage: dcm anon <folder> --out <dir>');
  }

  const outRaw = args.resolve(flags, { name: 'out', required: true, describe: 'the destination folder' });
  const source = path.resolve(target);
  const out = path.resolve(outRaw);

  // Writing inside the source would make the scan race against its own output.
  const relative = path.relative(source, out);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new args.UsageError(
      `--out (${out}) is inside the source folder (${source}). ` +
        'Choose a destination outside it so the scan cannot pick up its own output.'
    );
  }

  // One key for the whole run, so every file of one patient, study and series
  // maps to the same pseudonyms. Never printed.
  const keyInfo = resolveKey(process.env);
  const opts = {
    prefix: args.resolve(flags, { name: 'prefix', fallback: 'ANON' }),
    keepDescriptions: flags.has('keep-descriptions'),
    keepPrivate: flags.has('keep-private'),
    keepDates: flags.has('keep-dates'),
    keepPatientCharacteristics: flags.has('keep-patient-characteristics'),
    key: keyInfo.key,
  };
  const recurse = !flags.has('no-recurse');

  log.info(`scanning ${source}`);
  const scanned = scan(target, { recurse });

  const instanceCount = scanned.candidates - scanned.readErrors.length;
  if (instanceCount === 0) {
    log.error(`No DICOM instances found under ${source}.`);
    return 1;
  }

  log.info(`de-identifying ${instanceCount} instance(s) into ${out}`);
  log.info(`pseudonym key: ${describeKeySource(keyInfo.source)}`);
  if (keyInfo.weak) {
    log.warn(`${KEY_ENV} is short; anyone who can guess it can recompute the pseudonyms. Use 16+ random characters.`);
  }
  log.warn(
    'this is best-effort de-identification. Pixel data is not inspected, so burned-in ' +
      'annotations survive. Review a sample before sharing.'
  );

  fs.mkdirSync(out, { recursive: true });

  const totals = {
    written: 0, failed: 0, uidsRemapped: 0, elementsRemoved: 0, privateRemoved: 0, datesShifted: 0, bytes: 0,
  };
  const failures = [];

  for (const study of scanned.studies.values()) {
    for (const instance of study.instances) {
      let dataset;
      try {
        // The full dataset is needed here — pixel data has to be carried over.
        dataset = Dataset.fromFile(instance.path);
        if (!dataset) throw new Error('parser returned no dataset');
      } catch (err) {
        totals.failed += 1;
        failures.push({ path: instance.path, error: err.message });
        continue;
      }

      const elements = dataset.getElements();
      const stats = deidentifyElements(elements, opts);
      totals.uidsRemapped += stats.uidsRemapped;
      totals.elementsRemoved += stats.elementsRemoved;
      totals.privateRemoved += stats.privateRemoved;
      totals.datesShifted += stats.datesShifted;

      // Lay the output out by the NEW UIDs, so the directory structure carries
      // no information about the original identifiers either.
      const newStudyUid = elements.StudyInstanceUID ?? mapUid(study.studyInstanceUid, opts.key);
      const newSeriesUid = elements.SeriesInstanceUID ?? 'unknown-series';
      const newSopUid = elements.SOPInstanceUID ?? `instance-${totals.written + 1}`;

      const destDir = path.join(out, newStudyUid, newSeriesUid);
      const destFile = path.join(destDir, `${newSopUid}.dcm`);

      try {
        fs.mkdirSync(destDir, { recursive: true });
        // toFile is callback-style; wrap it so failures are counted rather
        // than lost to an unhandled async error.
        await new Promise((resolve, reject) => {
          dataset.toFile(destFile, (err) => (err ? reject(err) : resolve()));
        });
        totals.written += 1;
        totals.bytes += fs.statSync(destFile).size;
        log.debug(`wrote ${destFile}`);
      } catch (err) {
        totals.failed += 1;
        failures.push({ path: instance.path, error: `write failed: ${err.message}` });
      }

      if (totals.written % 50 === 0 && totals.written > 0) {
        log.info(`  ${totals.written}/${instanceCount} written`);
      }
    }
  }

  log.out('');
  log.out(BAR);
  log.out('DE-IDENTIFICATION REPORT');
  log.out(BAR);
  log.out(`source                ${source}`);
  log.out(`destination           ${out}`);
  log.out(`instances found       ${instanceCount}`);
  log.out(
    `instances written     ${totals.written}` +
      (totals.written === instanceCount ? '' : log.color.red('  <- shortfall'))
  );
  log.out(`failed                ${totals.failed}`);
  log.out(`UIDs remapped         ${totals.uidsRemapped}`);
  log.out(`elements cleared      ${totals.elementsRemoved}`);
  log.out(`private tags removed  ${totals.privateRemoved}`);
  log.out(`dates shifted         ${opts.keepDates ? 'none (--keep-dates)' : totals.datesShifted}`);
  log.out(`pseudonym key         ${describeKeySource(keyInfo.source)}`);
  log.out(`output size           ${bytes(totals.bytes)}`);

  if (scanned.readErrors.length) {
    log.out('');
    log.out(log.color.red(`${scanned.readErrors.length} source file(s) were unreadable and were not processed:`));
    for (const failure of scanned.readErrors.slice(0, 10)) {
      log.out(`  ${failure.path} — ${log.color.dim(failure.error)}`);
    }
  }

  if (failures.length) {
    log.out('');
    log.out(log.color.red(`${failures.length} instance(s) failed:`));
    for (const failure of failures.slice(0, 20)) {
      log.out(`  ${failure.path}`);
      log.out(`    ${log.color.dim(failure.error)}`);
    }
    if (failures.length > 20) log.out(`  ... and ${failures.length - 20} more`);
  }

  log.out('');
  if (totals.written === instanceCount && scanned.readErrors.length === 0) {
    log.out(log.color.green('OK — every instance found was de-identified and written.'));
  } else {
    log.out(log.color.red('FAILED — not every instance was written. Exit code 1.'));
  }
  log.out('');
  log.out(
    log.color.dim(
      'Reminder: pixel data was not inspected. Check a sample for burned-in identifiers\n' +
        'before sharing, and treat this output as best-effort rather than certified.'
    )
  );

  const ok = totals.written === instanceCount && totals.failed === 0 && scanned.readErrors.length === 0;
  return ok ? 0 : 1;
}

module.exports = {
  run,
  USAGE,
  deidentifyElements,
  mapUid,
  pseudonym,
  // For tests: the attribute lists, so a misspelt keyword cannot silently match nothing.
  PSEUDONYMISE,
  BLANK,
  REMOVE,
  DESCRIPTIONS,
  PATIENT_CHARACTERISTICS,
};
