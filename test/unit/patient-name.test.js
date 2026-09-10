'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dcmjsDimse = require('dcmjs-dimse');
const { TransferSyntax, StorageClass } = dcmjsDimse.constants;

const { runCommand, withTempDir } = require('../helpers/harness');
const { generate, writeInstance, uid } = require('../../tools/make-fixtures');

const info = require('../../src/commands/info');
const { scan, personNameWire } = require('../../src/lib/scan');

/**
 * `dcm info` reports the patient a study belongs to, and refuses to report one
 * when the study's own instances disagree about it.
 *
 * The second half is the point. Instances under a single Study Instance UID can
 * carry different patient names — a partial rename, a bad export, a mis-keyed
 * re-acquisition — and picking the first one turns a folder holding two
 * patients into a folder that looks like it holds one. These tests exist to
 * stop that from ever being the behaviour again.
 */

/** Writes one more instance into an existing study, with a name of our choosing. */
function addInstance(dir, { studyUid, index, patientName }) {
  return writeInstance({
    filePath: path.join(dir, `extra-${index}.dcm`),
    studyUid,
    seriesUid: uid(1, 1),
    sopUid: uid(1, 1, 900 + index),
    modality: 'CT',
    sopClassUid: StorageClass.CtImageStorage,
    seriesNumber: 1,
    instanceNumber: 900 + index,
    rows: 8,
    cols: 8,
    patientName,
    patientId: 'SYNTH0001',
    studyDescription: 'SYNTHETIC STUDY 1',
    seriesDescription: 'CT SERIES 1',
    transferSyntaxUid: TransferSyntax.ExplicitVRLittleEndian,
  });
}

/** A one-series, one-instance study written from scratch under our own name. */
async function studyNamed(dir, patientName) {
  await writeInstance({
    filePath: path.join(dir, 'only.dcm'),
    studyUid: uid(1),
    seriesUid: uid(1, 1),
    sopUid: uid(1, 1, 1),
    modality: 'CT',
    sopClassUid: StorageClass.CtImageStorage,
    seriesNumber: 1,
    instanceNumber: 1,
    rows: 8,
    cols: 8,
    patientName,
    patientId: 'SYNTH0001',
    studyDescription: 'SYNTHETIC STUDY 1',
    seriesDescription: 'CT SERIES 1',
    transferSyntaxUid: TransferSyntax.ExplicitVRLittleEndian,
  });
}

test('a Person Name is normalised to text, whatever shape dcmjs hands back', () => {
  // dcmjs returns [{Alphabetic: '...'}]; interpolating that printed
  // "[object Object]" where a patient belonged.
  assert.equal(personNameWire([{ Alphabetic: 'DOE^JANE' }]), 'DOE^JANE');
  assert.equal(personNameWire({ Alphabetic: 'DOE^JANE' }), 'DOE^JANE');
  assert.equal(personNameWire('DOE^JANE'), 'DOE^JANE');
  // A name recorded only in another component group is still a name. It keeps
  // the empty groups that precede it, because their position is what says
  // which script this spelling is in — see person-name-groups.test.js.
  assert.equal(personNameWire([{ Ideographic: 'ヤマダ^タロウ' }]), '=ヤマダ^タロウ');
  assert.equal(personNameWire([{ Phonetic: 'YAMADA^TAROU' }]), '==YAMADA^TAROU');
  // Absence, in each of the spellings a dataset can express it.
  assert.equal(personNameWire(undefined), undefined);
  assert.equal(personNameWire(null), undefined);
  assert.equal(personNameWire(''), undefined);
  assert.equal(personNameWire([]), undefined);
  assert.equal(personNameWire([{ Alphabetic: '' }]), undefined);
});

test('info --json carries the patient name of a study whose instances agree', async () => {
  await withTempDir('dcm-patient-agree', async (dir) => {
    const src = path.join(dir, 'src');
    // Two series, three instances each: every one of the six names the same
    // patient, which is what a well-formed study looks like.
    await generate({
      outDir: src, quiet: true, studies: 1, seriesPerStudy: 2,
      instancesPerSeries: 3, rows: 8, cols: 8,
    });

    const { code, stdout } = await runCommand(info, [src, '--json']);
    assert.equal(code, 0);

    const study = JSON.parse(stdout).studies[0];
    assert.equal(study.instanceCount, 6);
    assert.equal(study.patientName, 'SYNTHETIC^PATIENT1');
    assert.deepEqual(study.patientNames, ['SYNTHETIC^PATIENT1']);
    // The name must not have arrived as the raw dcmjs component-group object.
    assert.equal(typeof study.patientName, 'string');
    // And it sits beside the ID the command already reported.
    assert.equal(study.patientId, 'SYNTH0001');
  });
});

test('the human report names the patient above the patient ID', async () => {
  await withTempDir('dcm-patient-human', async (dir) => {
    const src = path.join(dir, 'src');
    await generate({
      outDir: src, quiet: true, studies: 1, seriesPerStudy: 1,
      instancesPerSeries: 2, rows: 8, cols: 8,
    });

    const { code, output } = await runCommand(info, [src]);
    assert.equal(code, 0);
    assert.match(output, /patient\s+SYNTHETIC\^PATIENT1/);
    assert.match(output, /patient ID\s+SYNTH0001/);
    assert.doesNotMatch(output, /\[object Object\]/);
  });
});

test('a study whose instances disagree on PatientName is not given one', async () => {
  await withTempDir('dcm-patient-conflict', async (dir) => {
    const src = path.join(dir, 'src');
    const manifest = await generate({
      outDir: src, quiet: true, studies: 1, seriesPerStudy: 1,
      instancesPerSeries: 2, rows: 8, cols: 8,
    });
    const studyUid = manifest.studies[0].studyInstanceUid;

    // One more instance, same study, different patient. This is the defect.
    await addInstance(path.join(src, 'study-1'), {
      studyUid, index: 1, patientName: 'OTHER^PATIENT',
    });

    const { code, stdout } = await runCommand(info, [src, '--json']);
    // A disagreement is reported, not a failure: the folder is readable and
    // every instance is accounted for. The exit code answers "could this be
    // inventoried", which it could.
    assert.equal(code, 0);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.studies.length, 1, 'one Study Instance UID is still one study');
    const study = parsed.studies[0];
    assert.equal(study.instanceCount, 3);

    // Withheld, because there is no single true answer.
    assert.equal(study.patientName, null);
    // Both competing values are listed, in the order they were found, so the
    // conflict can be acted on rather than merely noticed.
    assert.equal(study.patientNames.length, 2);
    assert.deepEqual(
      [...study.patientNames].sort(),
      ['OTHER^PATIENT', 'SYNTHETIC^PATIENT1']
    );
  });
});

test('the human report shows every competing name rather than picking one', async () => {
  await withTempDir('dcm-patient-conflict-human', async (dir) => {
    const src = path.join(dir, 'src');
    const manifest = await generate({
      outDir: src, quiet: true, studies: 1, seriesPerStudy: 1,
      instancesPerSeries: 2, rows: 8, cols: 8,
    });
    await addInstance(path.join(src, 'study-1'), {
      studyUid: manifest.studies[0].studyInstanceUid,
      index: 1,
      patientName: 'OTHER^PATIENT',
    });

    const { output } = await runCommand(info, [src]);
    assert.match(output, /2 DIFFERENT NAMES/);
    assert.match(output, /SYNTHETIC\^PATIENT1/);
    assert.match(output, /OTHER\^PATIENT/);
    // And it says what to do about it.
    assert.match(output, /dcm tags/);
  });
});

test('an instance with no PatientName does not create a disagreement', async () => {
  await withTempDir('dcm-patient-partial', async (dir) => {
    const src = path.join(dir, 'src');
    const manifest = await generate({
      outDir: src, quiet: true, studies: 1, seriesPerStudy: 1,
      instancesPerSeries: 2, rows: 8, cols: 8,
    });
    // An empty PatientName is an absence, not a second patient. Treating it as
    // a competing value would withhold a name that nothing actually contradicts.
    await addInstance(path.join(src, 'study-1'), {
      studyUid: manifest.studies[0].studyInstanceUid, index: 1, patientName: '',
    });

    const { stdout } = await runCommand(info, [src, '--json']);
    const study = JSON.parse(stdout).studies[0];
    assert.equal(study.instanceCount, 3);
    assert.equal(study.patientName, 'SYNTHETIC^PATIENT1');
    assert.deepEqual(study.patientNames, ['SYNTHETIC^PATIENT1']);
  });
});

test('a study that names no patient at all says so, in JSON and in prose', async () => {
  await withTempDir('dcm-patient-none', async (dir) => {
    const src = path.join(dir, 'src');
    await studyNamed(src, '');

    const { code, stdout } = await runCommand(info, [src, '--json']);
    assert.equal(code, 0);
    const study = JSON.parse(stdout).studies[0];
    // The two shapes are always present, so a consumer never branches on a
    // missing key; an empty patientNames is what tells "absent" from "disputed".
    assert.equal(study.patientName, null);
    assert.deepEqual(study.patientNames, []);

    const { output } = await runCommand(info, [src]);
    assert.match(output, /no PatientName in any instance/);
  });
});

test('scan reports the same two fields the JSON is built from', async () => {
  await withTempDir('dcm-patient-scan', async (dir) => {
    const src = path.join(dir, 'src');
    const manifest = await generate({
      outDir: src, quiet: true, studies: 1, seriesPerStudy: 1,
      instancesPerSeries: 1, rows: 8, cols: 8,
    });
    await addInstance(path.join(src, 'study-1'), {
      studyUid: manifest.studies[0].studyInstanceUid,
      index: 1,
      patientName: 'OTHER^PATIENT',
    });

    // The grouping, not the rendering, is where this is decided — so every
    // consumer of scan() sees the same withheld name, not just `dcm info`.
    const study = [...scan(src).studies.values()][0];
    assert.equal(study.patientName, undefined);
    // A Set here, like the modality roll-up beside it; `dcm info` serialises it.
    assert.equal(study.patientNames.size, 2);
  });
});
