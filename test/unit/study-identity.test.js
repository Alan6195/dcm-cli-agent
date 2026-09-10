'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runCommand, withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');

const info = require('../../src/commands/info');
const edit = require('../../src/commands/edit');
const { scan } = require('../../src/lib/scan');

/**
 * The three identity fields that used to be first-instance-wins.
 *
 * `test/unit/patient-name.test.js` pins the same rule for PatientName, and this
 * file exists because the rule was PatientName's alone for one release. A
 * screen whose entire job is to show an operator what a study currently says
 * had been reporting whichever instance the walk reached first as the study's
 * answer for PatientID, StudyDescription and AccessionNumber, with no warning
 * anywhere — and the more instances a folder holds, the more arbitrary that
 * answer gets. These tests are what stops that being the behaviour again.
 *
 * Each field is exercised through the same four states: agreement, an absence
 * that must not read as disagreement, a real disagreement, and the JSON shape
 * a consumer builds against.
 */

/**
 * The fields under test, with the value the fixture generator writes and a
 * second value to put in conflict with it.
 *
 * `advice` is the phrase that must appear under a conflict for THIS field and
 * no other. Two PatientIDs and two accession numbers are not the same kind of
 * wrong — one mis-files a patient, the other usually means an order was
 * corrected mid-acquisition — so a single paragraph reused four times would be
 * a regression even with every value correctly listed.
 */
const FIELDS = [
  {
    element: 'PatientID',
    key: 'patientId',
    plural: 'patientIds',
    original: 'SYNTH0001',
    other: 'WRONG-ID',
    banner: /2 DIFFERENT PATIENT IDS across this study's instances/,
    advice: /wrong patient/i,
  },
  {
    element: 'StudyDescription',
    key: 'studyDescription',
    plural: 'studyDescriptions',
    original: 'SYNTHETIC STUDY 1',
    other: 'A DIFFERENT STUDY',
    banner: /2 DIFFERENT DESCRIPTIONS across this study's instances/,
    advice: /Nothing routes on the description/i,
  },
  {
    element: 'AccessionNumber',
    key: 'accessionNumber',
    plural: 'accessionNumbers',
    original: 'ACC0000001',
    other: 'ACC-OTHER',
    banner: /2 DIFFERENT ACCESSION NUMBERS across this study's instances/,
    advice: /Often benign/i,
  },
];

/**
 * Writes a two-series study into `dir` and returns its root.
 *
 * Two series rather than two loose instances because that is the shape the
 * defect turns up in: an export or a rename that was applied to part of a
 * study and stopped.
 */
async function twoSeriesStudy(dir) {
  const src = path.join(dir, 'src');
  await generate({
    outDir: src, quiet: true, studies: 1, seriesPerStudy: 2,
    instancesPerSeries: 2, rows: 8, cols: 8,
  });
  return src;
}

/** The half of that study we edit, leaving the other half as generated. */
function secondSeries(src) {
  return path.join(src, 'study-1', 'series-2');
}

/**
 * Rewrites one element across one series, in place.
 *
 * In place, and safe: every caller runs inside withTempDir on a study this
 * test generated a moment earlier. Nothing here points at the repo's own
 * fixtures directory.
 */
async function editSeries(src, argv) {
  const { code } = await runCommand(edit, [secondSeries(src), ...argv, '--in-place']);
  assert.equal(code, 0, 'the fixture edit itself must succeed');
}

/** The same, across every instance of the study rather than half of it. */
async function editStudy(src, argv) {
  const { code } = await runCommand(edit, [src, ...argv, '--in-place']);
  assert.equal(code, 0, 'the fixture edit itself must succeed');
}

/** The single study `dcm info --json` reports for a folder. */
async function studyJson(src) {
  const { code, stdout } = await runCommand(info, [src, '--json']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.studies.length, 1, 'one Study Instance UID is still one study');
  return { code, outcome: parsed.outcome, study: parsed.studies[0] };
}

for (const field of FIELDS) {
  test(`info --json carries ${field.element} when every instance agrees`, async () => {
    await withTempDir(`dcm-${field.key}-agree`, async (dir) => {
      const src = await twoSeriesStudy(dir);

      const { code, study } = await studyJson(src);
      assert.equal(code, 0);
      assert.equal(study.instanceCount, 4);
      assert.equal(study[field.key], field.original);
      // A one-entry plural beside a non-null singular is the ordinary case.
      assert.deepEqual(study[field.plural], [field.original]);
    });
  });

  test(`a study whose instances disagree on ${field.element} is not given one`, async () => {
    await withTempDir(`dcm-${field.key}-conflict`, async (dir) => {
      const src = await twoSeriesStudy(dir);
      await editSeries(src, ['--set', `${field.element}=${field.other}`]);

      const { code, outcome, study } = await studyJson(src);
      // A disagreement is reported, not a failure: the folder was readable and
      // every instance is accounted for. The exit code answers "could this be
      // inventoried", which it could.
      assert.equal(code, 0);
      assert.equal(outcome, 'ok');
      assert.equal(study.instanceCount, 4);

      // Withheld, because there is no single true answer.
      assert.equal(study[field.key], null);
      // Both competing values are listed, so the conflict can be acted on
      // rather than merely noticed.
      assert.equal(study[field.plural].length, 2);
      assert.deepEqual(
        [...study[field.plural]].sort(),
        [field.original, field.other].sort()
      );
    });
  });

  test(`the ${field.element} plural is in first-seen order`, async () => {
    await withTempDir(`dcm-${field.key}-order`, async (dir) => {
      const src = await twoSeriesStudy(dir);
      await editSeries(src, ['--set', `${field.element}=${field.other}`]);

      // Which of the two the walk reaches first depends on the filesystem, so
      // the assertion asks the scan itself rather than assuming an order: the
      // first entry in the plural is whatever the first instance carried.
      const study = [...scan(src).studies.values()][0];
      assert.equal([...study[field.plural]][0], study.instances[0][field.key]);
      assert.equal(study[field.plural].size, 2);
    });
  });

  test(`an instance with no ${field.element} does not create a disagreement`, async () => {
    await withTempDir(`dcm-${field.key}-partial`, async (dir) => {
      const src = await twoSeriesStudy(dir);
      // An absent value is not a competing identity. Treating it as one would
      // withhold a value that nothing actually contradicts — which is a worse
      // report than the first-instance-wins bug it replaced.
      await editSeries(src, ['--remove', field.element]);

      const { code, study } = await studyJson(src);
      assert.equal(code, 0);
      assert.equal(study.instanceCount, 4);
      assert.equal(study[field.key], field.original);
      assert.deepEqual(study[field.plural], [field.original]);
    });
  });

  test(`the human report shows every competing ${field.element}, not one of them`, async () => {
    await withTempDir(`dcm-${field.key}-human`, async (dir) => {
      const src = await twoSeriesStudy(dir);
      await editSeries(src, ['--set', `${field.element}=${field.other}`]);

      const { code, output } = await runCommand(info, [src]);
      assert.equal(code, 0);
      assert.match(output, field.banner);
      assert.ok(output.includes(field.original), `${field.original} is missing from the report`);
      assert.ok(output.includes(field.other), `${field.other} is missing from the report`);
      // And advice written for this field rather than a single warning reused
      // across all four.
      assert.match(output, field.advice);
      for (const other of FIELDS) {
        if (other.element === field.element) continue;
        assert.doesNotMatch(
          output, other.advice,
          `${field.element}'s conflict is being explained with ${other.element}'s advice`
        );
      }
    });
  });

  test(`scan withholds ${field.key} itself, not just the rendering`, async () => {
    await withTempDir(`dcm-${field.key}-scan`, async (dir) => {
      const src = await twoSeriesStudy(dir);
      await editSeries(src, ['--set', `${field.element}=${field.other}`]);

      // The grouping, not the report, is where this is decided — so every
      // consumer of scan() sees the withheld value, not just `dcm info`.
      const study = [...scan(src).studies.values()][0];
      assert.equal(study[field.key], undefined);
      // A Set here, like the modality roll-up beside it; `dcm info` serialises it.
      assert.equal(study[field.plural].size, 2);
    });
  });
}

test('all four identity fields carry both halves of the shape, always', async () => {
  await withTempDir('dcm-identity-shape', async (dir) => {
    const src = await twoSeriesStudy(dir);
    // Every state a consumer can meet, in one payload: PatientName agreed,
    // PatientID and AccessionNumber disputed, StudyDescription absent from the
    // whole study rather than from half of it — the only way to reach an empty
    // plural, since one surviving value is agreement.
    await editSeries(src, [
      '--set', 'PatientID=WRONG-ID',
      '--set', 'AccessionNumber=ACC-OTHER',
    ]);
    await editStudy(src, ['--remove', 'StudyDescription']);

    const { code, study } = await studyJson(src);
    assert.equal(code, 0);

    // Both keys of every pair are present whatever the state, so a consumer
    // never has to tell a missing key from a null one.
    for (const [singular, plural] of [
      ['patientName', 'patientNames'],
      ['patientId', 'patientIds'],
      ['studyDescription', 'studyDescriptions'],
      ['accessionNumber', 'accessionNumbers'],
    ]) {
      assert.ok(singular in study, `${singular} is missing from the payload`);
      assert.ok(plural in study, `${plural} is missing from the payload`);
      assert.ok(
        typeof study[singular] === 'string' || study[singular] === null,
        `${singular} must be a string or null, got ${JSON.stringify(study[singular])}`
      );
      assert.ok(Array.isArray(study[plural]), `${plural} must be an array`);
      // The invariant tying the two together: a singular is exactly the lone
      // entry of its plural, or it is null.
      if (study[singular] === null) {
        assert.notEqual(study[plural].length, 1, `${singular} was withheld with one value found`);
      } else {
        assert.deepEqual(study[plural], [study[singular]]);
      }
    }

    assert.equal(study.patientName, 'SYNTHETIC^PATIENT1');
    assert.deepEqual(study.patientNames, ['SYNTHETIC^PATIENT1']);
    // Disputed: null beside two values.
    assert.equal(study.patientId, null);
    assert.equal(study.patientIds.length, 2);
    assert.equal(study.accessionNumber, null);
    assert.equal(study.accessionNumbers.length, 2);
    // Absent: null beside none. The empty plural is what tells the two nulls
    // apart, and it is the only thing that does.
    assert.equal(study.studyDescription, null);
    assert.deepEqual(study.studyDescriptions, []);
  });
});

test('a conflict on every field at once still exits 0 with outcome ok', async () => {
  await withTempDir('dcm-identity-all', async (dir) => {
    const src = await twoSeriesStudy(dir);
    await editSeries(src, [
      '--set', 'PatientName=OTHER^PATIENT',
      '--set', 'PatientID=WRONG-ID',
      '--set', 'StudyDescription=A DIFFERENT STUDY',
      '--set', 'AccessionNumber=ACC-OTHER',
    ]);

    // Four disagreements is a folder in real trouble, and still not a read
    // failure. The exit code says whether the inventory could be taken.
    const { code, outcome, study } = await studyJson(src);
    assert.equal(code, 0);
    assert.equal(outcome, 'ok');
    assert.equal(study.patientName, null);
    assert.equal(study.patientId, null);
    assert.equal(study.studyDescription, null);
    assert.equal(study.accessionNumber, null);

    const { output } = await runCommand(info, [src]);
    for (const field of [...FIELDS, { banner: /2 DIFFERENT NAMES/ }]) {
      assert.match(output, field.banner);
    }
  });
});
