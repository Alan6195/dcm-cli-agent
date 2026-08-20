'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('../../src/lib/log');
const { tokenize, UsageError } = require('../../src/lib/args');
const { scan } = require('../../src/lib/scan');
const { dcmjsDimse } = require('../../src/lib/dimse');
const restamp = require('../../src/lib/restamp');
const perform = require('../../src/commands/mpps/perform');
const dispatcher = require('../../src/commands/mpps');
const { generate } = require('../../tools/make-fixtures');

const { Dataset } = dcmjsDimse;

/**
 * Adopting the worklist identity — `mpps perform --adopt-worklist-identity`.
 *
 * The property every test here is circling is the one that makes the feature
 * safe to use on the only copy of a study anyone has: the source folder is
 * read, never written. Two tests assert that with hashes rather than by
 * inspection, because "we do not write there" is exactly the kind of claim
 * that survives a refactor in the comments and not in the code.
 *
 * Nothing here opens a socket. The transfer is `dcm send`'s and is tested
 * there; what is new is what happens to the bytes before they reach it.
 */

// --- helpers ---------------------------------------------------------------

/** The UID and patient tools/make-fixtures.js gives its first study. */
const FIXTURE_STUDY_UID = '1.2.826.0.1.3680043.10.1337.1';

/** A worklist study UID that is deliberately nothing like the fixture's. */
const WORKLIST_STUDY_UID = '2.25.7409558135166679574647759021724211267';

const tempDirs = [];

/** A temp directory removed when the process exits. */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcm-restamp-test-${label}-`));
  tempDirs.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a fixture study.
 *
 * @param {object} [opts]
 * @returns {Promise<{dir: string, manifest: object}>}
 */
async function fixtureStudy(opts = {}) {
  const dir = path.join(tempDir('src'), 'study');
  const manifest = await generate({
    outDir: dir,
    studies: 1,
    seriesPerStudy: 2,
    instancesPerSeries: 2,
    quiet: true,
    ...opts,
  });
  return { dir: path.join(dir, 'study-1'), root: dir, manifest };
}

/** SHA-256 of every file under a directory, keyed by path relative to it. */
function hashTree(root) {
  const hashes = new Map();
  const stack = [root];
  while (stack.length) {
    for (const entry of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        hashes.set(
          path.relative(root, full),
          crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        );
      }
    }
  }
  return hashes;
}

/** Naturalised elements of one instance, minus the bulk and the VR map. */
function elementsOf(file) {
  const elements = { ...Dataset.fromFile(file).getElements() };
  const pixelBytes = Array.isArray(elements.PixelData) && elements.PixelData[0]
    ? elements.PixelData[0].byteLength
    : 0;
  delete elements.PixelData;
  delete elements._vrMap;
  return { elements, pixelBytes };
}

/** Keys whose values differ between two instances. */
function differingKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** Runs a command through the mpps dispatcher with stdout and stderr captured. */
async function runCaptured(argv) {
  const sink = log.beginCapture();
  let code;
  let error;
  try {
    code = await dispatcher.run(tokenize(argv));
  } catch (err) {
    error = err;
  } finally {
    log.endCapture();
  }
  return { code, error, out: sink.out, err: sink.err };
}

/** Runs fn, asserts it threw a UsageError, and hands the error back. */
function throwsUsage(fn) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'UsageError', `expected a UsageError, got ${err.stack}`);
    return err;
  }
  assert.fail('expected a UsageError, nothing was thrown');
  return undefined;
}

/**
 * Splices Explicit VR Little Endian LO elements into a file, just before
 * PixelData so tag order stays ascending.
 *
 * @param {string} file
 * @param {Array<[number, number, string]>} elements [group, element, value]
 */
function injectPrivateElements(file, elements) {
  const original = fs.readFileSync(file);
  const pixelDataTag = Buffer.from([0xe0, 0x7f, 0x10, 0x00]);
  const at = original.indexOf(pixelDataTag);
  assert.ok(at > 0, 'the fixture should have a PixelData element to splice in front of');

  const pieces = elements.map(([group, element, value]) => {
    const padded = value.length % 2 ? `${value} ` : value;
    const header = Buffer.alloc(8);
    header.writeUInt16LE(group, 0);
    header.writeUInt16LE(element, 2);
    header.write('LO', 4, 'ascii');
    header.writeUInt16LE(padded.length, 6);
    return Buffer.concat([header, Buffer.from(padded, 'ascii')]);
  });

  fs.writeFileSync(file, Buffer.concat([original.subarray(0, at), ...pieces, original.subarray(at)]));
}

/** A worklist file whose item names a study the images do not have. */
function worklistFile(dir, overrides = {}) {
  const file = path.join(dir, 'wl.json');
  fs.writeFileSync(file, `${JSON.stringify([{
    StudyInstanceUID: WORKLIST_STUDY_UID,
    PatientID: 'RIS-000123',
    PatientName: 'REHEARSAL^WORKLIST',
    PatientBirthDate: '19850302',
    PatientSex: 'F',
    AccessionNumber: 'ACC-REHEARSE-1',
    StudyID: 'ST-9',
    Modality: 'CT',
    ScheduledProcedureStepID: 'SPS1',
    ScheduledProcedureStepDescription: 'REHEARSAL',
    ...overrides,
  }], null, 2)}\n`)
  ;
  return file;
}

// --- what gets stamped -----------------------------------------------------

test('the plan stamps what the order supplies and nothing it left blank', () => {
  const plan = restamp.planRestamp({
    studyInstanceUid: WORKLIST_STUDY_UID,
    patientId: 'RIS-000123',
    patientName: 'REHEARSAL^WORKLIST',
    patientBirthDate: '',
    patientSex: '   ',
    accessionNumber: 'ACC-1',
    studyId: undefined,
  });

  assert.deepEqual(
    plan.map((p) => p.element),
    ['StudyInstanceUID', 'PatientID', 'PatientName', 'AccessionNumber'],
    'a blank in the worklist means the RIS did not say, not "make it blank"'
  );
  assert.equal(plan[0].value, WORKLIST_STUDY_UID);
});

test('--study-uid-only narrows the plan to the one attribute that must agree', () => {
  const attrs = {
    studyInstanceUid: WORKLIST_STUDY_UID,
    patientId: 'RIS-000123',
    patientName: 'REHEARSAL^WORKLIST',
  };
  assert.deepEqual(
    restamp.planRestamp(attrs, { studyUidOnly: true }).map((p) => p.element),
    ['StudyInstanceUID']
  );
});

test('Series and SOP Instance UIDs are not in the identity set at all', () => {
  const elements = restamp.IDENTITY_ATTRIBUTES.map((a) => a.element);
  for (const uid of restamp.NEVER_RESTAMPED) {
    assert.ok(!elements.includes(uid), `${uid} belongs to the modality, not to the order`);
  }
});

// --- the copy --------------------------------------------------------------

test('re-stamping changes exactly the intended attributes and nothing else', async () => {
  const { dir } = await fixtureStudy();
  const staging = path.join(tempDir('staging'), 'run-1');

  const scanned = scan(dir);
  const [study] = scanned.studies.values();

  const plan = restamp.planRestamp({
    studyInstanceUid: WORKLIST_STUDY_UID,
    patientId: 'RIS-000123',
    patientName: 'REHEARSAL^WORKLIST',
    patientBirthDate: '19850302',
    patientSex: 'F',
    accessionNumber: 'ACC-REHEARSE-1',
    studyId: 'ST-9',
  });

  const result = await restamp.restampFolder({
    instances: study.instances, sourceRoot: dir, stagingDir: staging, plan,
  });

  assert.equal(result.written, 4);
  assert.equal(result.failed, 0);
  assert.equal(result.instancesChanged, 4);

  for (const instance of study.instances) {
    const copy = path.join(staging, path.relative(dir, instance.path));
    assert.ok(fs.existsSync(copy), `${copy} should exist`);

    const before = elementsOf(instance.path);
    const after = elementsOf(copy);

    assert.deepEqual(
      differingKeys(before.elements, after.elements),
      ['AccessionNumber', 'PatientBirthDate', 'PatientID', 'PatientName', 'PatientSex',
        'StudyID', 'StudyInstanceUID'].sort(),
      'the copy differs from the source in the seven stamped attributes and in nothing else'
    );

    assert.equal(after.elements.StudyInstanceUID, WORKLIST_STUDY_UID);
    assert.equal(after.elements.PatientID, 'RIS-000123');
    assert.equal(after.elements.PatientName.Alphabetic, 'REHEARSAL^WORKLIST');

    // The two the modality owns. Re-stamping these would split the series the
    // images already belong to and make a resend look like a new acquisition.
    assert.equal(after.elements.SeriesInstanceUID, before.elements.SeriesInstanceUID);
    assert.equal(after.elements.SOPInstanceUID, before.elements.SOPInstanceUID);

    assert.ok(after.pixelBytes > 0, 'the copy is a whole instance, not just a header');
    assert.equal(after.pixelBytes, before.pixelBytes);
  }

  // The copy is still one study with the series structure it started with.
  const staged = scan(staging);
  assert.equal(staged.studies.size, 1);
  const [stagedStudy] = staged.studies.values();
  assert.equal(stagedStudy.studyInstanceUid, WORKLIST_STUDY_UID);
  assert.equal(stagedStudy.series.size, study.series.size);
});

test('the source folder comes out byte-identical', async () => {
  const { dir } = await fixtureStudy();
  const staging = path.join(tempDir('staging'), 'run-1');

  const before = hashTree(dir);
  assert.ok(before.size >= 4);

  const scanned = scan(dir);
  const [study] = scanned.studies.values();
  await restamp.restampFolder({
    instances: study.instances,
    sourceRoot: dir,
    stagingDir: staging,
    plan: restamp.planRestamp({ studyInstanceUid: WORKLIST_STUDY_UID, patientId: 'RIS-000123' }),
  });

  assert.deepEqual(hashTree(dir), before, 'not one byte of the source may change');
});

test('an instance that already carries the identity is copied but not counted as changed', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });
  const staging = path.join(tempDir('staging'), 'run-1');

  const scanned = scan(dir);
  const [study] = scanned.studies.values();

  // Stamp the study UID it already has.
  const result = await restamp.restampFolder({
    instances: study.instances,
    sourceRoot: dir,
    stagingDir: staging,
    plan: restamp.planRestamp({ studyInstanceUid: FIXTURE_STUDY_UID }),
  });

  assert.equal(result.written, 1, 'the copy is still what gets sent, so it is still written');
  assert.equal(result.instancesChanged, 0);
  assert.deepEqual(result.changedElements, []);
  assert.match(restamp.describeRestamp(result), /already carried this identity/);
});

test('private tags the writer cannot carry across are counted, not lost silently', async () => {
  // Real stock images are full of them: a Siemens MR instance from the study
  // this feature was built against carried 216 elements and its copy carried
  // 119. That is the shared dataset writer's behaviour, not the re-stamp's, but
  // it is this copy that goes on the wire, so it has to be reported.
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });
  const series = path.join(dir, fs.readdirSync(dir)[0]);
  const original = path.join(series, fs.readdirSync(series)[0]);

  // The private elements have to be spliced in as bytes: the writer that drops
  // them on the way out cannot be used to put them in.
  injectPrivateElements(original, [[0x0021, 0x1001, 'SIEMENS PRIVATE'], [0x0021, 0x1002, 'ANOTHER']]);

  const scanned = scan(dir);
  const [study] = scanned.studies.values();
  assert.ok(Object.keys(Dataset.fromFile(original).getElements()).filter(
    (k) => /^[0-9A-Fa-f]{8}$/.test(k)
  ).length >= 2, 'the fixture really does carry unnamed tags now');

  const staging = path.join(tempDir('staging'), 'run-1');
  const result = await restamp.restampFolder({
    instances: study.instances,
    sourceRoot: dir,
    stagingDir: staging,
    plan: restamp.planRestamp({ studyInstanceUid: WORKLIST_STUDY_UID }),
  });

  assert.ok(result.unnamedElements >= 2,
    `the count is reported so the loss is visible, got ${result.unnamedElements}`);
});

// --- where the copy goes ---------------------------------------------------

test('staging defaults under the OS temp dir and is a fresh subdirectory each run', () => {
  const first = restamp.stagingDirFor(path.join('C:', 'studies', 'MASSEY MR'), undefined);
  const second = restamp.stagingDirFor(path.join('C:', 'studies', 'MASSEY MR'), undefined);

  assert.equal(first.defaulted, true);
  assert.equal(first.root, path.join(os.tmpdir(), restamp.DEFAULT_STAGING_BASENAME));
  assert.notEqual(first.dir, second.dir, 'two runs must not land on top of each other');
  assert.ok(
    path.basename(first.dir).startsWith('MASSEY_MR-'),
    `the folder should be recognisable, got ${path.basename(first.dir)}`
  );
});

test('--staging is honoured and is never the directory the operator named', () => {
  const root = path.resolve(path.join('D:', 'scratch'));
  const chosen = restamp.stagingDirFor(path.resolve(path.join('C:', 'studies', 'mr')), root);
  assert.equal(chosen.defaulted, false);
  assert.equal(chosen.root, root);
  assert.equal(path.dirname(chosen.dir), root);
  assert.notEqual(chosen.dir, root, 'cleanup must never be able to delete the named root');
});

test('staging inside the source folder is refused', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });

  assert.throws(
    () => restamp.assertStagingIsOutside(dir, path.join(dir, 'staged')),
    /never written to/
  );
  assert.throws(() => restamp.assertStagingIsOutside(dir, dir), /never written to/);

  await assert.rejects(
    () => restamp.restampFolder({
      instances: [], sourceRoot: dir, stagingDir: path.join(dir, 'staged'), plan: [],
    }),
    /never written to/
  );
  assert.ok(!fs.existsSync(path.join(dir, 'staged')), 'and nothing was created inside the source');
});

// --- cleanup ---------------------------------------------------------------

test('the staging copy is removed after a completed run and kept after anything else', () => {
  assert.equal(perform.stagingIsKept({ stagingDir: '/x' }, 0), false);
  assert.equal(perform.stagingIsKept({ stagingDir: '/x' }, 1), true,
    'a run that did not end COMPLETED is exactly when the sent bytes are wanted');
  assert.equal(perform.stagingIsKept({ stagingDir: '/x', keepStaging: true }, 0), true);
  assert.equal(perform.stagingIsKept({ stagingDir: '/x', keepStaging: true }, 1), true);
});

test('removeStaging deletes the run directory and leaves the root it sat in', () => {
  const root = tempDir('staging-root');
  const sibling = path.join(root, 'someone-elses-work');
  fs.mkdirSync(sibling, { recursive: true });

  const run = path.join(root, 'run-1', 'series-1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'instance.dcm'), 'x');

  assert.deepEqual(restamp.removeStaging(path.join(root, 'run-1')), { removed: true });
  assert.ok(!fs.existsSync(path.join(root, 'run-1')));
  assert.ok(fs.existsSync(sibling), '--staging may point at a directory with other things in it');

  assert.deepEqual(
    restamp.removeStaging(path.join(root, 'never-existed')),
    { removed: true },
    'removing what is already gone is not a failure'
  );
});

// --- the refusal -----------------------------------------------------------

test('the refusal names both ways forward, and says which one a modality does', () => {
  const scanned = {
    studies: new Map([[FIXTURE_STUDY_UID, {
      studyInstanceUid: FIXTURE_STUDY_UID, instances: [{}],
    }]]),
  };

  const err = throwsUsage(() => perform.assertOneStudy(scanned, './x', WORKLIST_STUDY_UID));

  assert.ok(err.message.includes('never reconcile'), 'it still says why this is wrong');
  assert.ok(err.message.includes(WORKLIST_STUDY_UID) && err.message.includes(FIXTURE_STUDY_UID),
    'both UIDs are named, so which is which is not a guess');
  assert.ok(err.message.includes('--adopt-worklist-identity'));
  assert.ok(err.message.includes('--allow-study-mismatch'));
  assert.ok(/modality does|modality stamps/.test(err.message),
    'the ordinary answer is explained as what a real modality does');
  assert.ok(err.message.includes('source folder is not modified'));
});

test('a mismatch is returned rather than thrown once a way past it is chosen', () => {
  const scanned = {
    studies: new Map([[FIXTURE_STUDY_UID, {
      studyInstanceUid: FIXTURE_STUDY_UID, instances: [{}],
    }]]),
  };

  for (const opts of [{ adoptIdentity: true }, { allowMismatch: true }]) {
    const { study, mismatch } = perform.assertOneStudy(scanned, './x', WORKLIST_STUDY_UID, opts);
    assert.equal(study.studyInstanceUid, FIXTURE_STUDY_UID);
    assert.deepEqual(mismatch, { declared: WORKLIST_STUDY_UID, onDisk: FIXTURE_STUDY_UID });
  }

  const agreeing = perform.assertOneStudy(scanned, './x', FIXTURE_STUDY_UID);
  assert.equal(agreeing.mismatch, null);
});

test('a folder holding two studies is still refused, and says re-stamping cannot fix it', () => {
  const scanned = {
    filesExamined: 2,
    studies: new Map([
      ['1.2.3', { studyInstanceUid: '1.2.3', instances: [{}], patientName: 'A' }],
      ['1.2.4', { studyInstanceUid: '1.2.4', instances: [{}], patientName: 'B' }],
    ]),
  };

  for (const opts of [{}, { adoptIdentity: true }, { allowMismatch: true }]) {
    const err = throwsUsage(() => perform.assertOneStudy(scanned, './x', '', opts));
    assert.ok(err.message.includes('Re-stamping cannot fix this'));
    assert.ok(err.message.includes('once per study'));
  }
});

// --- the reverse asymmetry -------------------------------------------------

test('a worklist with no study UID lets the step adopt the folder\'s, and says why', () => {
  const study = {
    studyInstanceUid: FIXTURE_STUDY_UID,
    modalities: new Set(['CT']),
    patientId: 'SYNTH0001',
  };

  const attrs = { studyInstanceUid: '', modality: '', patientId: '' };
  const notes = perform.adoptFromScan(attrs, study, { fromWorklist: true });

  assert.equal(attrs.studyInstanceUid, FIXTURE_STUDY_UID);
  const note = notes.join(' ');
  assert.ok(note.includes('carries no Study Instance UID'));
  assert.ok(note.includes('Nothing on disk is changed'),
    'the safe direction needs no copy, and saying so is the point');

  // Without a worklist the note stays short — there is no asymmetry to explain.
  const plain = perform.adoptFromScan({ studyInstanceUid: '', modality: 'CT' }, study);
  assert.ok(!plain.join(' ').includes('Nothing on disk is changed'));
});

// --- the flags, as the command resolves them -------------------------------

test('--adopt-worklist-identity and --allow-study-mismatch cannot both be given', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });
  const { error } = await runCaptured([
    'perform', dir, '--dry-run', '--modality', 'CT', '--step-id', 'S1',
    '--study-uid', WORKLIST_STUDY_UID,
    '--adopt-worklist-identity', '--allow-study-mismatch',
  ]);
  assert.ok(error instanceof UsageError, `expected a UsageError, got ${error}`);
  assert.ok(error.message.includes('opposite things'));
});

test('the staging flags are refused when nothing is being staged', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });

  for (const extra of [['--staging', tempDir('unused')], ['--keep-staging'], ['--study-uid-only']]) {
    const { error } = await runCaptured([
      'perform', dir, '--dry-run', '--modality', 'CT', '--step-id', 'S1', ...extra,
    ]);
    assert.ok(error instanceof UsageError, `${extra[0]} should be refused on its own`);
  }
});

test('--restamp is an accepted alias, and --dry-run writes no copy', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });
  const staging = tempDir('staging-dry');
  const before = hashTree(dir);

  const { code, out } = await runCaptured([
    'perform', dir, '--dry-run', '--json', '--modality', 'CT', '--step-id', 'S1',
    '--from-worklist', worklistFile(tempDir('wl')),
    '--restamp', '--staging', staging,
  ]);

  assert.equal(code, 0);
  const plan = JSON.parse(out);
  assert.equal(plan.adoptWorklistIdentity, true);
  assert.equal(plan.studyInstanceUid, WORKLIST_STUDY_UID);
  assert.deepEqual(plan.restamp.attributes, [
    'StudyInstanceUID', 'PatientID', 'PatientName', 'PatientBirthDate',
    'PatientSex', 'AccessionNumber', 'StudyID',
  ]);
  assert.equal(plan.restamp.values.StudyInstanceUID, WORKLIST_STUDY_UID);
  assert.equal(plan.restamp.values.PatientName, 'REHEARSAL^WORKLIST');
  assert.equal(plan.restamp.sourceModified, false);
  assert.deepEqual(plan.restamp.unchangedByDesign, ['SeriesInstanceUID', 'SOPInstanceUID']);
  assert.deepEqual(plan.studyUidMismatch, {
    declared: WORKLIST_STUDY_UID, onDisk: FIXTURE_STUDY_UID,
  });

  assert.deepEqual(fs.readdirSync(staging), [], '--dry-run opens nothing and writes nothing');
  assert.deepEqual(hashTree(dir), before);
});

test('--allow-study-mismatch proceeds, and says loudly what will not reconcile', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });

  const { code, out, err } = await runCaptured([
    'perform', dir, '--dry-run', '--modality', 'CT', '--step-id', 'S1',
    '--study-uid', WORKLIST_STUDY_UID, '--allow-study-mismatch',
  ]);

  assert.equal(code, 0, 'it proceeds rather than refusing');
  const said = `${out}\n${err}`;
  assert.ok(said.includes(WORKLIST_STUDY_UID) && said.includes(FIXTURE_STUDY_UID),
    'both UIDs are named in the warning');
  assert.ok(/never be reconciled|nothing would reconcile|not reconcile/i.test(said));
  assert.ok(said.includes('--adopt-worklist-identity'),
    'the warning still points at the flag that would have made them agree');
});

test('--adopt-worklist-identity is never implied by --allow-study-mismatch, or the reverse', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });

  const mismatchOnly = await runCaptured([
    'perform', dir, '--dry-run', '--json', '--modality', 'CT', '--step-id', 'S1',
    '--study-uid', WORKLIST_STUDY_UID, '--allow-study-mismatch',
  ]);
  const plan = JSON.parse(mismatchOnly.out);
  assert.equal(plan.adoptWorklistIdentity, false);
  assert.equal(plan.restamp, null, 'no copy is planned; the images go exactly as they are');
  assert.equal(plan.allowStudyMismatch, true);

  const adoptOnly = await runCaptured([
    'perform', dir, '--dry-run', '--json', '--modality', 'CT', '--step-id', 'S1',
    '--study-uid', WORKLIST_STUDY_UID, '--adopt-worklist-identity',
  ]);
  assert.equal(JSON.parse(adoptOnly.out).allowStudyMismatch, false);
});

test('--adopt-worklist-identity with nothing to adopt says so instead of copying', async () => {
  const { dir } = await fixtureStudy({ seriesPerStudy: 1, instancesPerSeries: 1 });

  const { code, out } = await runCaptured([
    'perform', dir, '--dry-run', '--json', '--modality', 'CT', '--step-id', 'S1',
    '--adopt-worklist-identity',
  ]);

  assert.equal(code, 0);
  const plan = JSON.parse(out);
  assert.equal(plan.restamp, null);
  assert.equal(plan.studyInstanceUid, FIXTURE_STUDY_UID,
    'with no order to adopt from, the step takes the study the images already have');
});

// --- what the help promises ------------------------------------------------

test('the help states the two things that are easy to get wrong', () => {
  assert.ok(perform.USAGE.includes('THE SOURCE FOLDER IS NEVER MODIFIED'));
  assert.ok(perform.USAGE.includes('Series and SOP Instance UIDs are NOT re-stamped'));
  assert.ok(perform.USAGE.includes('--allow-study-mismatch'));
  assert.ok(perform.USAGE.includes('--staging'));
  assert.ok(perform.USAGE.includes('does not carry private tags across'),
    'the one thing the copy loses is stated, not left to be discovered');
});
