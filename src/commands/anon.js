'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const { scan } = require('../lib/scan');
const { deterministicUid } = require('../lib/uid');
const { dcmjsDimse } = require('../lib/dimse');
const { bytes, BAR } = require('../lib/report');

const { Dataset } = dcmjsDimse;

const FLAGS = ['out', 'no-recurse', 'keep-descriptions', 'keep-private', 'keep-dates', 'prefix'];

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
  --keep-dates           Keep study and acquisition dates (kept by default;
                         this flag exists for symmetry and is a no-op).
  --keep-private         Keep private and unrecognised tags (removed by default).
  --no-recurse           Only look at files directly in the folder.

What it does:
  - Replaces patient name, ID, birth date, address and phone with pseudonyms.
    The pseudonym is derived from the original value, so the same patient maps
    to the same pseudonym across every file in the run.
  - Replaces Study, Series, SOP Instance and Frame of Reference UIDs with
    deterministic 2.25.* values, preserving the relationships between them.
  - Removes institution, physician, operator and device identifiers.
  - Removes private and unrecognised tags unless --keep-private.
  - Marks the result with PatientIdentityRemoved = YES and records the method.

What it does NOT do — read this before sharing anything:
  - It does not touch pixel data. Burned-in annotations, scanned requisitions
    and secondary captures of paperwork will still contain identifiers.
  - It does not parse nested sequences exhaustively, so identifiers inside
    Structured Reports, Presentation States or Radiotherapy objects may survive.
  - It is not a certified implementation of the DICOM PS3.15 confidentiality
    profiles, and it is not a substitute for reviewing the output.
  Always inspect a sample before sharing, and treat the result as
  de-identified-on-a-best-effort-basis rather than provably anonymous.

Example:
  dcm anon ./study --out ./study-anon
  dcm info ./study-anon
`.trimStart();

/**
 * Elements replaced with a deterministic pseudonym derived from the original.
 * Using a derived value rather than a constant keeps distinct patients
 * distinct in the output, which matters for testing multi-patient behaviour.
 */
const PSEUDONYMISE = ['PatientID', 'AccessionNumber', 'StudyID', 'OtherPatientIDs'];

/** Elements emptied outright. */
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
];

/** Descriptions: clinically useful, occasionally identifying. */
const DESCRIPTIONS = [
  'StudyDescription', 'SeriesDescription', 'ProtocolName',
  'RequestedProcedureDescription', 'PerformedProcedureStepDescription',
];

/** UIDs remapped deterministically, preserving study/series/instance structure. */
const UID_ELEMENTS = [
  'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID',
  'FrameOfReferenceUID', 'SynchronizationFrameOfReferenceUID',
  'ConcatenationUID', 'IrradiationEventUID',
];

/** Salt so the mapping is stable across runs but distinct from other tools. */
const UID_SALT = 'dcm-cli:anon:uid:v1';
const ID_SALT = 'dcm-cli:anon:id:v1';

/** Deterministic replacement UID for a source UID. */
function mapUid(sourceUid) {
  return deterministicUid(UID_SALT, sourceUid);
}

/**
 * Short, readable pseudonym derived from a source value.
 *
 * @param {string} prefix
 * @param {string} value
 * @returns {string}
 */
function pseudonym(prefix, value) {
  const derived = deterministicUid(ID_SALT, value);
  // Take the trailing digits of the derived UID for a compact, stable token.
  const digits = derived.replace(/^2\.25\./, '').slice(0, 10);
  return `${prefix}${digits}`;
}

/** True for keys dcmjs could not resolve to a keyword — i.e. private/unknown tags. */
function isRawTagKey(key) {
  return /^[0-9A-Fa-f]{8}$/.test(key);
}

/**
 * De-identifies one naturalised dataset in place.
 *
 * @param {Record<string, unknown>} elements
 * @param {object} opts
 * @returns {{uidsRemapped: number, elementsRemoved: number, privateRemoved: number}}
 */
function deidentifyElements(elements, opts) {
  const stats = { uidsRemapped: 0, elementsRemoved: 0, privateRemoved: 0 };

  // Patient name: one pseudonym per distinct original, in DICOM PN form.
  if (elements.PatientName !== undefined) {
    const original =
      typeof elements.PatientName === 'object' && elements.PatientName !== null
        ? elements.PatientName.Alphabetic ?? JSON.stringify(elements.PatientName)
        : String(elements.PatientName);
    elements.PatientName = `${opts.prefix}^${pseudonym('', original).slice(0, 8)}`;
  }

  for (const key of PSEUDONYMISE) {
    if (elements[key] === undefined || elements[key] === '') continue;
    elements[key] = pseudonym(opts.prefix, String(elements[key]));
  }

  for (const key of BLANK) {
    if (elements[key] === undefined) continue;
    elements[key] = '';
    stats.elementsRemoved += 1;
  }

  if (!opts.keepDescriptions) {
    for (const key of DESCRIPTIONS) {
      if (elements[key] === undefined) continue;
      elements[key] = '';
      stats.elementsRemoved += 1;
    }
  }

  for (const key of UID_ELEMENTS) {
    const value = elements[key];
    if (typeof value !== 'string' || value === '') continue;
    elements[key] = mapUid(value);
    stats.uidsRemapped += 1;
  }

  if (!opts.keepPrivate) {
    for (const key of Object.keys(elements)) {
      // Preserve dcmjs's own bookkeeping keys.
      if (key.startsWith('_')) continue;
      if (isRawTagKey(key)) {
        delete elements[key];
        stats.privateRemoved += 1;
      }
    }
  }

  // Declare what was done, as PS3.15 expects of de-identified data.
  elements.PatientIdentityRemoved = 'YES';
  elements.DeidentificationMethod =
    'dcm-cli-agent best-effort de-identification: identifiers pseudonymised, ' +
    'UIDs remapped, private tags removed. Pixel data not inspected.';

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

  const opts = {
    prefix: args.resolve(flags, { name: 'prefix', fallback: 'ANON' }),
    keepDescriptions: flags.has('keep-descriptions'),
    keepPrivate: flags.has('keep-private'),
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
  log.warn(
    'this is best-effort de-identification. Pixel data is not inspected, so burned-in ' +
      'annotations survive. Review a sample before sharing.'
  );

  fs.mkdirSync(out, { recursive: true });

  const totals = { written: 0, failed: 0, uidsRemapped: 0, elementsRemoved: 0, privateRemoved: 0, bytes: 0 };
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

      // Lay the output out by the NEW UIDs, so the directory structure carries
      // no information about the original identifiers either.
      const newStudyUid = elements.StudyInstanceUID ?? mapUid(study.studyInstanceUid);
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

module.exports = { run, USAGE, deidentifyElements, mapUid, pseudonym };
