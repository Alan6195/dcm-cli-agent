'use strict';

const fs = require('fs');
const path = require('path');

const log = require('./log');
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
    patientName: get('PatientName'),
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
        patientId: meta.patientId,
        patientName: meta.patientName,
        studyDate: meta.studyDate,
        studyDescription: meta.studyDescription,
        accessionNumber: meta.accessionNumber,
        modalities: new Set(),
        transferSyntaxes: new Set(),
        sopClasses: new Set(),
        series: new Map(),
        instances: [],
        bytes: 0,
      };
      studies.set(meta.studyInstanceUid, study);
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
  METADATA_READ_OPTIONS,
  PIXEL_DATA_TAG,
};
