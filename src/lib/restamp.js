'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./log');
const { textOf } = require('./mpps');
const { dcmjsDimse } = require('./dimse');

const { Dataset } = dcmjsDimse;

/**
 * Emulating what a modality does with a worklist.
 *
 * A modality does not refuse to work because the images it just acquired do
 * not already carry the worklist's Study Instance UID — they cannot, since the
 * RIS invented that UID before the patient was on the table. The RIS assigns
 * the identity in the worklist and the modality STAMPS it onto every instance
 * it produces. That is the whole point of Modality Worklist: one identity,
 * assigned once, adopted by everything downstream.
 *
 * Rehearsing a workflow with stock images is the same situation with the
 * timing reversed — the images exist first — so the same answer applies:
 * stamp the worklist identity onto them. This module does that, onto a COPY.
 *
 * Two rules shape everything here.
 *
 * The source is never written to. Stock images are usually the only copy
 * anyone has, and a rehearsal that quietly rewrote them would be worse than
 * the refusal it replaced. Every write goes to a staging directory that this
 * module creates, outside the source tree, and the caller is told where it is.
 *
 * Series and SOP Instance UIDs are not touched. Those belong to the equipment
 * that produced the images, not to the order: SeriesInstanceUID is what ties
 * the slices of an acquisition together and SOPInstanceUID is the identity of
 * one image. A worklist item does not carry them and could not, so there is
 * nothing to adopt. Re-minting them would break the relationships the images
 * already have — references between instances, and any prior copy an archive
 * holds — and would make a resend look like a second acquisition instead of
 * the same one. Study identity comes from the order; series and instance
 * identity come from the modality; this stamps only the first.
 */

/**
 * The attributes a modality takes from the worklist item, in report order.
 *
 * StudyInstanceUID is the one that matters — it is the key the archive
 * reconciles the performed step against. The rest are the patient and order
 * identity that travel with it; an archive that got the study UID right and
 * the patient wrong would still file the images under the wrong record.
 */
const IDENTITY_ATTRIBUTES = Object.freeze([
  { element: 'StudyInstanceUID', key: 'studyInstanceUid' },
  { element: 'PatientID', key: 'patientId' },
  { element: 'PatientName', key: 'patientName' },
  { element: 'PatientBirthDate', key: 'patientBirthDate' },
  { element: 'PatientSex', key: 'patientSex' },
  { element: 'AccessionNumber', key: 'accessionNumber' },
  { element: 'StudyID', key: 'studyId' },
]);

/** UIDs that are the modality's to mint, and are therefore never re-stamped. */
const NEVER_RESTAMPED = Object.freeze(['SeriesInstanceUID', 'SOPInstanceUID']);

/**
 * True for a key dcmjs could not resolve to a keyword — a private or otherwise
 * unrecognised tag, held as a bare hex tag.
 *
 * These are counted because the writer drops them. dcmjs writes an element by
 * looking its keyword up in the dictionary, so a tag it could not name on the
 * way in does not come out the other side: a Siemens MR instance measured here
 * carried 216 elements and its copy carried 119. That is a property of the
 * same write path `dcm edit --out` and `dcm anon` use, not of the re-stamp, but
 * counting it here is what turns a silent loss into a reported one.
 */
function isRawTagKey(key) {
  return /^[0-9A-Fa-f]{8}$/.test(key);
}

/** Directory name used under the OS temp dir when --staging is not given. */
const DEFAULT_STAGING_BASENAME = 'dcm-restamp';

/**
 * Builds the list of attributes to stamp.
 *
 * Only attributes the order actually supplies are included. An empty value in
 * the worklist means "the RIS did not say", and stamping a blank over whatever
 * the images carry would destroy information rather than adopt any.
 *
 * @param {object} attrs Resolved step attributes, as the order supplied them —
 *   i.e. before anything has been filled in from the folder.
 * @param {{studyUidOnly?: boolean}} [opts]
 * @returns {Array<{element: string, value: string}>}
 */
function planRestamp(attrs, opts = {}) {
  const { studyUidOnly = false } = opts;
  const plan = [];

  for (const attribute of IDENTITY_ATTRIBUTES) {
    if (studyUidOnly && attribute.element !== 'StudyInstanceUID') continue;
    const value = textOf(attrs?.[attribute.key]).trim();
    if (value === '') continue;
    plan.push({ element: attribute.element, value });
  }

  return plan;
}

/** Makes a folder name safe to append to a path. */
function safeSegment(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 60) || 'study';
}

/**
 * Chooses the staging directory for one run.
 *
 * Always a fresh subdirectory, never the root the caller named. Two things
 * depend on that: a second run cannot land its copy on top of a first one and
 * send a mixture of the two, and cleanup can delete a directory this process
 * created rather than one the operator pointed at and may care about.
 *
 * @param {string} sourceRoot Resolved source folder, used only for the name.
 * @param {string} [root] Value of --staging. Defaults under the OS temp dir.
 * @returns {{dir: string, root: string, defaulted: boolean}}
 */
function stagingDirFor(sourceRoot, root) {
  const defaulted = root === undefined || root === '';
  const base = defaulted
    ? path.join(os.tmpdir(), DEFAULT_STAGING_BASENAME)
    : path.resolve(root);
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  return {
    dir: path.join(base, `${safeSegment(path.basename(sourceRoot))}-${unique}`),
    root: base,
    defaulted,
  };
}

/**
 * True when `inner` is `outer` or sits underneath it.
 *
 * @param {string} outer Resolved path.
 * @param {string} inner Resolved path.
 * @returns {boolean}
 */
function isInside(outer, inner) {
  const relative = path.relative(outer, inner);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Refuses a staging location that would let the copy touch the source.
 *
 * @param {string} sourceRoot Resolved.
 * @param {string} stagingRoot Resolved.
 * @throws {Error} When staging is inside the source tree.
 */
function assertStagingIsOutside(sourceRoot, stagingRoot) {
  if (isInside(sourceRoot, stagingRoot)) {
    throw new Error(
      `the staging directory (${stagingRoot}) is inside the source folder (${sourceRoot}). ` +
        'The source folder is never written to, so staging has to live somewhere else. ' +
        'Leave --staging off to use the OS temp directory, or point it outside the study.'
    );
  }
}

/**
 * Writes a re-stamped copy of every instance into the staging directory.
 *
 * The source layout is mirrored, so a folder that was recognisable before is
 * still recognisable after. Every file is opened read-only and written
 * somewhere else; there is no in-place branch in this function and there
 * should never be one.
 *
 * @param {object} params
 * @param {Array<{path: string}>} params.instances Instances from scan().
 * @param {string} params.sourceRoot Resolved source folder.
 * @param {string} params.stagingDir Resolved destination, created here.
 * @param {Array<{element: string, value: string}>} params.plan From planRestamp().
 * @param {function} [params.onProgress] Called as (written, total).
 * @returns {Promise<{
 *   stagingDir: string, written: number, failed: number,
 *   failures: Array<{path: string, error: string}>,
 *   changed: Map<string, number>, changedElements: string[], instancesChanged: number
 * }>}
 */
async function restampFolder(params) {
  const { instances, sourceRoot, stagingDir, plan, onProgress } = params;

  assertStagingIsOutside(sourceRoot, stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  const changed = new Map();
  const failures = [];
  let written = 0;
  let instancesChanged = 0;
  let unnamedElements = 0;

  for (const instance of instances) {
    let dataset;
    try {
      // The whole dataset, not the metadata-only read the scan used: the pixel
      // data has to be carried across into the copy.
      dataset = Dataset.fromFile(instance.path);
      if (!dataset) throw new Error('parser returned no dataset');
    } catch (err) {
      failures.push({ path: instance.path, error: err.message });
      continue;
    }

    const elements = dataset.getElements();
    let touched = false;

    const unnamed = Object.keys(elements).filter(isRawTagKey).length;
    if (unnamed > unnamedElements) unnamedElements = unnamed;

    for (const { element, value } of plan) {
      if (textOf(elements[element]) === value) continue;
      elements[element] = value;
      touched = true;
      changed.set(element, (changed.get(element) ?? 0) + 1);
    }
    if (touched) instancesChanged += 1;

    const destination = path.join(stagingDir, path.relative(sourceRoot, instance.path));

    // Belt and braces. path.relative() on a file outside sourceRoot yields a
    // '..' path, which would escape staging and could land on the source.
    if (!isInside(stagingDir, destination)) {
      failures.push({
        path: instance.path,
        error: `resolves outside the staging directory (${destination}); not written`,
      });
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // toFile is callback-style; wrap it so a write failure is counted rather
      // than lost to an unhandled async error.
      await new Promise((resolve, reject) => {
        dataset.toFile(destination, (err) => (err ? reject(err) : resolve()));
      });
      written += 1;
      log.debug(`re-stamped ${instance.path} -> ${destination}`);
      if (onProgress && written % 50 === 0) onProgress(written, instances.length);
    } catch (err) {
      failures.push({ path: instance.path, error: `write failed: ${err.message}` });
    }
  }

  return {
    stagingDir,
    written,
    failed: failures.length,
    failures,
    changed,
    changedElements: [...changed.keys()],
    instancesChanged,
    unnamedElements,
  };
}

/**
 * Removes a staging directory created by stagingDirFor().
 *
 * Deliberately narrow: it deletes the per-run subdirectory and never the root
 * the operator named with --staging, because that root may be a directory with
 * other things in it.
 *
 * @param {string} dir
 * @returns {{removed: boolean, error?: string}}
 */
function removeStaging(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (err) {
    return { removed: false, error: err.message };
  }
}

/**
 * The one-line summary the operator reads.
 *
 * @param {object} result From restampFolder().
 * @returns {string}
 */
function describeRestamp(result) {
  const elements = result.changedElements.length
    ? result.changedElements.join(', ')
    : 'nothing (the images already carried this identity)';
  return `re-stamped ${result.written} instance(s): ${elements} -> staging at ${result.stagingDir}`;
}

module.exports = {
  IDENTITY_ATTRIBUTES,
  NEVER_RESTAMPED,
  DEFAULT_STAGING_BASENAME,
  planRestamp,
  stagingDirFor,
  assertStagingIsOutside,
  isInside,
  restampFolder,
  removeStaging,
  describeRestamp,
};
