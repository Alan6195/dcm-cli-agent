'use strict';

const fs = require('fs');
const path = require('path');

const log = require('./log');
const tagLib = require('./tags');
const { dcmjsDimse } = require('./dimse');

const { Dataset } = dcmjsDimse;

/**
 * Folder scanning and study grouping.
 *
 * Two properties matter here.
 *
 * Memory. Reading a whole dataset to learn its Study Instance UID pulls the
 * pixel data in with it — a few hundred instances is enough to exhaust a
 * modest machine before a single byte has been sent. dcmjs can stop parsing at
 * a given tag, so metadata reads stop at PixelData (7FE0,0010). On a 2 MB
 * instance that is the difference between roughly 2 MB and roughly 40 KB
 * retained per file.
 *
 * Honesty about what was found. Every file that could plausibly be a DICOM
 * instance is reported, including the ones that fail to parse. A file that is
 * quietly skipped during scanning can never show up as missing later, which is
 * how a lossy transfer starts looking like a clean one. Files that are plainly
 * not DICOM are counted separately and reported, not silently discarded.
 */

/** Tag to stop parsing at: (7FE0,0010) PixelData. */
const PIXEL_DATA_TAG = '7FE00010';

/** Read options for metadata-only parsing. */
const METADATA_READ_OPTIONS = Object.freeze({
  untilTag: PIXEL_DATA_TAG,
  includeUntilTagValue: false,
  ignoreErrors: false,
});

/** Extensions that mark a file as a DICOM candidate even without the magic bytes. */
const DICOM_EXTENSIONS = new Set(['.dcm', '.dicom', '.ima', '.img']);

/** Filenames that are DICOM-related but are not storable instances. */
const NON_INSTANCE_NAMES = new Set(['dicomdir', 'dicomdir.']);

/**
 * Study-level fields collected from every instance instead of from whichever
 * one the walk reached first, as `[singular, plural]` property names.
 *
 * These four say what a study *is* — who it belongs to, what it was called,
 * which order it filled. Instances under a single Study Instance UID can
 * disagree about any of them: a partial rename that stopped halfway, two
 * exports merged into one folder, an accession corrected after the first
 * series was acquired. Reporting one instance's answer as the study's answer
 * turns each of those into a folder that looks correct, and a tool whose whole
 * purpose is to show an operator what a study currently says must not do that.
 *
 * StudyDate is deliberately not here. It is context rather than identity —
 * nothing files or renames a study by it — and a study legitimately spanning
 * midnight would raise a conflict that has no repair.
 */
const CONSENSUS_FIELDS = Object.freeze([
  ['patientName', 'patientNames'],
  ['patientId', 'patientIds'],
  ['studyDescription', 'studyDescriptions'],
  ['accessionNumber', 'accessionNumbers'],
]);

/**
 * Walks a directory tree, yielding file paths.
 *
 * Iterative rather than recursive so that a deep or symlink-looping tree
 * cannot blow the stack, and visited real paths are tracked so a symlink cycle
 * terminates instead of spinning.
 *
 * @param {string} root
 * @param {{recurse?: boolean}} opts
 * @returns {Generator<string>}
 */
function* walk(root, opts = {}) {
  const { recurse = true } = opts;
  const stack = [root];
  const seenDirs = new Set();

  while (stack.length) {
    const current = stack.pop();

    let real;
    try {
      real = fs.realpathSync(current);
    } catch (err) {
      log.debug(`cannot resolve ${current}: ${err.message}`);
      continue;
    }
    if (seenDirs.has(real)) {
      log.debug(`skipping already-visited directory (symlink loop?): ${current}`);
      continue;
    }
    seenDirs.add(real);

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      log.warn(`cannot read directory ${current}: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recurse) stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      } else if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (recurse) stack.push(full);
          } else if (stat.isFile()) {
            yield full;
          }
        } catch (err) {
          log.debug(`broken symlink ${full}: ${err.message}`);
        }
      }
    }
  }
}

/**
 * Decides whether a file is worth trying to parse as DICOM.
 *
 * A file with the `DICM` magic at offset 128 is a candidate regardless of
 * name. A file with a DICOM-ish extension is also a candidate even without the
 * magic, so that a truncated or corrupt `.dcm` is reported as a read error
 * rather than ignored. Everything else is not DICOM and is counted separately.
 *
 * @param {string} filePath
 * @returns {{candidate: boolean, reason: string}}
 */
function classifyFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (NON_INSTANCE_NAMES.has(base)) {
    return { candidate: false, reason: 'DICOMDIR index, not a storable instance' };
  }

  const ext = path.extname(filePath).toLowerCase();
  let hasMagic = false;

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(132);
    const read = fs.readSync(fd, header, 0, 132, 0);
    hasMagic = read >= 132 && header.subarray(128, 132).toString('ascii') === 'DICM';
  } catch (err) {
    // Unreadable, but if it looks like DICOM by name it is still a candidate so
    // the failure gets counted rather than hidden.
    if (DICOM_EXTENSIONS.has(ext)) {
      return { candidate: true, reason: `unreadable (${err.message})` };
    }
    return { candidate: false, reason: `unreadable (${err.message})` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do.
      }
    }
  }

  if (hasMagic) return { candidate: true, reason: 'DICM magic present' };
  if (DICOM_EXTENSIONS.has(ext)) {
    return { candidate: true, reason: 'DICOM extension without DICM magic' };
  }
  if (ext === '') {
    // Extensionless files are common in DICOM exports, but without the magic
    // there is nothing to suggest this one is an instance.
    return { candidate: false, reason: 'no extension and no DICM magic' };
  }
  return { candidate: false, reason: `not DICOM (${ext || 'no extension'})` };
}

/**
 * A Person Name as the file holds it — every component group, `=`-separated.
 *
 * dcmjs hands a Person Name back as `[{Alphabetic: 'DOE^JANE'}]` — an array
 * holding a component-group object — so anything that interpolated it into a
 * line of output printed `[object Object]` instead of a patient. This is the
 * normalisation that fixes that, and what it produces is the whole name.
 *
 * The whole name, and not the group a Latin reader would recognise, because
 * reporting is not the only thing done with this value. `dcm info --json` is
 * read by the desktop Rename tab, which prefills its boxes from the name and
 * then writes what those boxes compose back with `dcm edit --set`. Whatever
 * this function dropped would be dropped from the written file, silently, by
 * an operator who was never shown it existed.
 *
 * There is deliberately no display-only sibling that picks a single group.
 * There was one, and after this became the value `readMetadata` reports,
 * nothing called it: every place that shows a name to a person — `dcm info`,
 * `dcm tags`, `dcm find` — shows the whole name too, because a spelling the
 * record does not hold is the wrong thing to put in front of someone deciding
 * whether this is the right study. An accessor documented as the display half
 * of a split, with no display on the other side of it, is a trap for whoever
 * reaches for it next.
 *
 * For the overwhelming majority of data — a single Alphabetic group — this is
 * character-for-character what it returned before there was any distinction:
 * no `=`, nothing new to look at, nothing to explain. It differs only for the
 * names that actually carry more, which are exactly the names that were being
 * damaged.
 *
 * @param {*} value
 * @returns {string|undefined}
 */
function personNameWire(value) {
  const text = tagLib.personNameText(value);
  return text === '' ? undefined : text;
}

/**
 * Reads instance metadata, stopping before the pixel data.
 *
 * @param {string} filePath
 * @returns {object} Metadata fields plus the file size.
 * @throws {Error} When the file cannot be parsed.
 */
function readMetadata(filePath) {
  const stat = fs.statSync(filePath);
  const dataset = Dataset.fromFile(filePath, undefined, { ...METADATA_READ_OPTIONS });

  if (!dataset) {
    throw new Error('parser returned no dataset');
  }

  const get = (tag) => {
    const value = dataset.getElement(tag);
    return value === undefined || value === null || value === '' ? undefined : value;
  };

  return {
    path: filePath,
    bytes: stat.size,
    studyInstanceUid: get('StudyInstanceUID'),
    seriesInstanceUid: get('SeriesInstanceUID'),
    sopInstanceUid: get('SOPInstanceUID'),
    sopClassUid: get('SOPClassUID'),
    transferSyntaxUid: dataset.getTransferSyntaxUid(),
    modality: get('Modality'),
    patientId: get('PatientID'),
    // The whole name, not the group a reader would recognise. This value is
    // what a rename is composed from, so it has to be able to reproduce the
    // name it came from. See personNameWire.
    patientName: personNameWire(get('PatientName')),
    studyDate: get('StudyDate'),
    studyDescription: get('StudyDescription'),
    seriesDescription: get('SeriesDescription'),
    seriesNumber: get('SeriesNumber'),
    instanceNumber: get('InstanceNumber'),
    accessionNumber: get('AccessionNumber'),
  };
}

/**
 * Scans a path and groups what it finds by study.
 *
 * Works for a single file, a folder holding one study, and a tree holding
 * many. Grouping is driven entirely by Study Instance UID from the data, so
 * "one folder is one study" and "mixed tree" need no special handling.
 *
 * @param {string} target File or directory.
 * @param {{recurse?: boolean, onProgress?: function}} opts
 * @returns {{
 *   studies: Map<string, object>,
 *   readErrors: Array<{path: string, error: string}>,
 *   ignored: Array<{path: string, reason: string}>,
 *   candidates: number,
 *   totalBytes: number
 * }}
 */
function scan(target, opts = {}) {
  const { recurse = true, onProgress } = opts;

  const resolved = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new Error(`Cannot read "${target}": ${err.message}`);
  }

  const files = stat.isDirectory() ? [...walk(resolved, { recurse })] : [resolved];

  /** @type {Map<string, object>} */
  const studies = new Map();
  const readErrors = [];
  const ignored = [];
  let candidates = 0;
  let totalBytes = 0;
  let examined = 0;

  for (const filePath of files) {
    examined += 1;
    if (onProgress && examined % 200 === 0) onProgress(examined, files.length);

    const { candidate, reason } = classifyFile(filePath);
    if (!candidate) {
      ignored.push({ path: filePath, reason });
      continue;
    }

    candidates += 1;

    let meta;
    try {
      meta = readMetadata(filePath);
    } catch (err) {
      // Counted, never dropped. This file exists on disk and the operator needs
      // to know it did not make it into the transfer.
      readErrors.push({ path: filePath, error: err.message });
      continue;
    }

    // An instance with no Study Instance UID cannot be grouped or, in practice,
    // stored. Treat it as a read error so it lands in the totals.
    if (!meta.studyInstanceUid) {
      readErrors.push({ path: filePath, error: 'no StudyInstanceUID in the dataset' });
      continue;
    }
    if (!meta.sopInstanceUid) {
      readErrors.push({ path: filePath, error: 'no SOPInstanceUID in the dataset' });
      continue;
    }

    totalBytes += meta.bytes;

    let study = studies.get(meta.studyInstanceUid);
    if (!study) {
      study = {
        studyInstanceUid: meta.studyInstanceUid,
        // The CONSENSUS_FIELDS start empty in both halves and are filled in
        // below from every instance, not from this first one alone.
        patientName: undefined,
        patientNames: new Set(),
        patientId: undefined,
        patientIds: new Set(),
        studyDescription: undefined,
        studyDescriptions: new Set(),
        accessionNumber: undefined,
        accessionNumbers: new Set(),
        studyDate: meta.studyDate,
        modalities: new Set(),
        transferSyntaxes: new Set(),
        sopClasses: new Set(),
        series: new Map(),
        instances: [],
        bytes: 0,
      };
      studies.set(meta.studyInstanceUid, study);
    }

    // Each identity field is rolled up across the whole study rather than taken
    // from whichever instance happened to be walked first, and is reported only
    // when the study speaks with one voice. Taking PatientName as the example:
    //
    //   patientNames.size === 0  no instance carries a name; patientName undefined
    //   patientNames.size === 1  every instance that names a patient agrees
    //   patientNames.size >= 2   they disagree; patientName is withheld
    //
    // An instance carrying no value at all is not a competing identity, so it
    // does not create a disagreement — it just contributes nothing here. That
    // is why the guard is on the value being truthy rather than on the key
    // being present: readMetadata already turns '' and null into undefined.
    //
    // Sets, like the modality and transfer syntax roll-ups beside them: a
    // folder whose instances each carry a distinct pseudonym would otherwise
    // cost a linear scan per instance, and this runs on every file of every
    // study. The `has` check keeps the common case — every instance repeating
    // the same value — from rewriting the singular on every file.
    for (const [key, plural] of CONSENSUS_FIELDS) {
      const value = meta[key];
      if (value && !study[plural].has(value)) {
        study[plural].add(value);
        study[key] = study[plural].size === 1 ? value : undefined;
      }
    }

    if (meta.modality) study.modalities.add(meta.modality);
    if (meta.transferSyntaxUid) study.transferSyntaxes.add(meta.transferSyntaxUid);
    if (meta.sopClassUid) study.sopClasses.add(meta.sopClassUid);
    study.bytes += meta.bytes;
    study.instances.push(meta);

    const seriesUid = meta.seriesInstanceUid ?? '(no SeriesInstanceUID)';
    let series = study.series.get(seriesUid);
    if (!series) {
      series = {
        seriesInstanceUid: meta.seriesInstanceUid,
        seriesNumber: meta.seriesNumber,
        seriesDescription: meta.seriesDescription,
        modality: meta.modality,
        instances: [],
        bytes: 0,
      };
      study.series.set(seriesUid, series);
    }
    series.instances.push(meta);
    series.bytes += meta.bytes;
  }

  return {
    studies,
    readErrors,
    ignored,
    candidates,
    totalBytes,
    filesExamined: files.length,
  };
}

/**
 * Splits a list into fixed-size chunks.
 *
 * @param {Array} items
 * @param {number} size
 * @returns {Array<Array>}
 */
function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

module.exports = {
  walk,
  scan,
  chunk,
  classifyFile,
  readMetadata,
  personNameWire,
  CONSENSUS_FIELDS,
  METADATA_READ_OPTIONS,
  PIXEL_DATA_TAG,
};
