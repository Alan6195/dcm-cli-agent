'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { withTempDir } = require('../helpers/harness');
const { generate, uid: fixtureUid } = require('../../tools/make-fixtures');
const log = require('../../src/lib/log');
const { tokenize, UsageError } = require('../../src/lib/args');
const mpps = require('../../src/lib/mpps');
const dispatcher = require('../../src/commands/mpps');
const common = require('../../src/commands/mpps/common');
const update = require('../../src/commands/mpps/update');

/** The Study Instance UID the generator gives its first study. */
const STUDY_UID = fixtureUid(1);

/**
 * Writes a two-series study inside `dir` and hands back the path to it.
 *
 * Three of the dry runs below need a folder of DICOM on disk, and each one
 * builds its own. They used to be handed a bare relative literal naming
 * `fixtures/study-1`, which Node resolves against process.cwd() — the repo root
 * under `npm test`, where .gitignore keeps that directory out of the tree
 * precisely so that nobody commits DICOM. They passed on the machine that had
 * generated it once and failed everywhere else.
 *
 * Two series, because one of those dry runs counts them. One instance each,
 * because none of them counts instances, and 16x16 pixels because none of them
 * looks at a pixel.
 */
async function studyIn(dir) {
  const root = path.join(dir, 'source');
  const manifest = await generate({
    outDir: root,
    quiet: true,
    studies: 1,
    seriesPerStudy: 2,
    instancesPerSeries: 1,
    rows: 16,
    cols: 16,
  });
  assert.equal(manifest.studies[0].studyInstanceUid, STUDY_UID);
  return path.join(root, 'study-1');
}

/**
 * The interim N-SET and the unscheduled step.
 *
 * Both are messages that a deployed receiver already branches on and that no
 * real client has ever produced, so the tests here are almost entirely about
 * the exact SHAPE of a dataset — which attributes are present, which are
 * absent, and the difference between the two. An attribute that is absent and
 * one that is present-and-empty are different messages on the wire and are
 * handled by different code on the far end; a test that only checked values
 * would pass while sending the wrong one.
 *
 * Nothing here opens a socket. See test/e2e/mpps-interim.test.js for the same
 * messages against a real receiver.
 */

// --- helpers ---------------------------------------------------------------

/** Parses a command line the way the CLI does, minus the verb. */
function flagsOf(line) {
  return tokenize(line.split(' ').filter(Boolean)).flags;
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
}

/** Awaits fn, asserts it rejected with a UsageError, and hands the error back. */
async function rejectsUsage(fn) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.name, 'UsageError', `expected a UsageError, got ${err.stack}`);
    return err;
  }
  assert.fail('expected a UsageError, nothing was thrown');
}

/** A valid step UID to hang the flag tests off. */
const STEP_UID = '2.25.31415926535897932384626433832795028841';

const GOOD_ATTRS = Object.freeze({
  studyInstanceUid: '1.2.826.0.1.3680043.10.1337.1',
  performedProcedureStepId: 'STEP001',
  performedStationAeTitle: 'CT01',
  startDate: '20260820',
  startTime: '093155',
  modality: 'CT',
});

const SERIES = Object.freeze([
  {
    SeriesInstanceUID: '1.2.826.0.1.3680043.10.1337.1.1',
    ReferencedImageSequence: [
      { ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2', ReferencedSOPInstanceUID: '1.2.3.4' },
    ],
  },
]);

// ---------------------------------------------------------------------------
// The interim N-SET dataset
// ---------------------------------------------------------------------------

test('an interim N-SET never carries an end date or an end time', () => {
  // The whole point of the verb. A step that is still running has not ended,
  // and an end time beside a status of IN PROGRESS is a contradiction some
  // receivers resolve by treating the step as finished.
  for (const params of [
    { status: mpps.Status.IN_PROGRESS },
    { status: mpps.Status.IN_PROGRESS, performedSeries: SERIES },
    { performedSeries: SERIES },
  ]) {
    const ds = mpps.buildInterimSetDataset(params);
    assert.equal(ds.PerformedProcedureStepEndDate, undefined);
    assert.equal(ds.PerformedProcedureStepEndTime, undefined);
    assert.ok(
      !('PerformedProcedureStepEndDate' in ds),
      'absent, not present-and-empty — an empty end date would still overwrite one'
    );
    assert.ok(!('PerformedProcedureStepEndTime' in ds));
  }
});

test('the closing builder still stamps the end date and time it always did', () => {
  // The interim builder exists so this one keeps its contract intact rather
  // than growing a mode flag that turns its two guards off.
  const ds = mpps.buildSetDataset({
    status: mpps.Status.COMPLETED, endDate: '20260820', endTime: '094500',
  });
  assert.equal(ds.PerformedProcedureStepEndDate, '20260820');
  assert.equal(ds.PerformedProcedureStepEndTime, '094500');
  assert.throws(
    () => mpps.buildSetDataset({ status: mpps.Status.IN_PROGRESS, endDate: '1', endTime: '1' }),
    UsageError,
    'and it still refuses a non-terminal status'
  );
});

test('the status attribute is absent entirely, not empty, when none was asked for', () => {
  // NewLumen's gateway branches on IsNullOrWhiteSpace(status). An empty string
  // would take the same branch by luck; an absent attribute takes it by
  // construction, and only one of the two is what a modality actually sends.
  const ds = mpps.buildInterimSetDataset({ performedSeries: SERIES });
  assert.ok(
    !('PerformedProcedureStepStatus' in ds),
    `the key must not be in the dataset at all, got ${JSON.stringify(ds)}`
  );
  assert.deepEqual(Object.keys(ds), ['PerformedSeriesSequence']);
});

test('the status attribute is present and IN PROGRESS when it is asked for', () => {
  const ds = mpps.buildInterimSetDataset({ status: mpps.Status.IN_PROGRESS });
  assert.deepEqual(ds, { PerformedProcedureStepStatus: 'IN PROGRESS' });
});

test('an interim N-SET refuses a terminal status, by name, with the way out', () => {
  for (const status of [mpps.Status.COMPLETED, mpps.Status.DISCONTINUED]) {
    const err = throwsUsage(() => mpps.buildInterimSetDataset({ status }));
    assert.ok(err.message.includes(status));
    assert.match(err.message, /dcm mpps complete|dcm mpps discontinue/);
  }
  throwsUsage(() => mpps.buildInterimSetDataset({ status: 'PAUSED' }));
});

test('an omitted performed series is not the same message as an empty one', () => {
  // The COALESCE rule this verb exists to exercise. N-SET replaces rather than
  // appends, so a present empty sequence erases what the step holds and an
  // absent one leaves it alone.
  const omitted = mpps.buildInterimSetDataset({ status: mpps.Status.IN_PROGRESS });
  assert.ok(!('PerformedSeriesSequence' in omitted), 'omitted leaves the step alone');

  const emptied = mpps.buildInterimSetDataset({ status: mpps.Status.IN_PROGRESS, performedSeries: [] });
  assert.deepEqual(emptied.PerformedSeriesSequence, [], 'present and empty erases');
  assert.ok('PerformedSeriesSequence' in emptied);
});

test('an interim N-SET that would say nothing at all is refused', () => {
  const err = throwsUsage(() => mpps.buildInterimSetDataset({}));
  assert.match(err.message, /no attributes at all/);
  // The refusal has to name both ways out, because which one is meant depends
  // on which branch of the receiver is being tested.
  assert.match(err.message, /keep-alive/);
  assert.match(err.message, /--series-from/);
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test('IN PROGRESS may stay IN PROGRESS, which is what an interim N-SET does', () => {
  assert.doesNotThrow(
    () => mpps.assertLegalTransition(mpps.Status.IN_PROGRESS, mpps.Status.IN_PROGRESS)
  );
  assert.ok(mpps.LEGAL_TRANSITIONS[mpps.Status.IN_PROGRESS].includes(mpps.Status.IN_PROGRESS));
});

test('the self-edge did not open a terminal state to anything', () => {
  // The guard on the change that added it. Both terminal rows stay empty, so
  // nothing may leave a terminal state and nothing may re-enter one.
  for (const from of [mpps.Status.COMPLETED, mpps.Status.DISCONTINUED]) {
    assert.deepEqual([...mpps.LEGAL_TRANSITIONS[from]], []);
    for (const to of Object.values(mpps.Status)) {
      const err = throwsUsage(() => mpps.assertLegalTransition(from, to));
      assert.match(err.message, /final state/);
    }
  }
});

test('a step that has finished cannot be re-opened by an interim update', () => {
  // The failure mode the self-edge could plausibly have introduced: an update
  // that walks a COMPLETED step back to IN PROGRESS.
  const err = throwsUsage(
    () => mpps.assertLegalTransition(mpps.Status.COMPLETED, mpps.Status.IN_PROGRESS)
  );
  assert.match(err.message, /final state/);
});

// ---------------------------------------------------------------------------
// N-CREATE-only attributes
// ---------------------------------------------------------------------------

test('every attribute PS3.4 marks N-CREATE-only is refused by name', () => {
  // Named individually rather than by iterating the map alone, so that removing
  // one from the map fails here instead of quietly shrinking what is refused.
  const expected = {
    'patient-id': 'PatientID',
    'patient-name': 'PatientName',
    'patient-birth-date': 'PatientBirthDate',
    'patient-sex': 'PatientSex',
    'study-uid': 'StudyInstanceUID',
    'step-id': 'PerformedProcedureStepID',
    'station-ae': 'PerformedStationAETitle',
    'start-date': 'PerformedProcedureStepStartDate',
    'start-time': 'PerformedProcedureStepStartTime',
    modality: 'Modality',
    'from-worklist': 'ScheduledStepAttributesSequence',
  };

  for (const [flag, attribute] of Object.entries(expected)) {
    assert.ok(
      mpps.CREATE_ONLY_ATTRIBUTES[flag],
      `--${flag} must still be listed as N-CREATE-only`
    );
    const err = throwsUsage(() => mpps.assertNoCreateOnlyFlags(flagsOf(`--${flag} x`), 'update'));
    assert.ok(
      err.message.includes(attribute),
      `the refusal must name ${attribute}, got: ${err.message}`
    );
    assert.match(err.message, /N-CREATE-only/);
  }
});

test('the refusal names the attribute, not only the flag that would carry it', () => {
  // "--station-ae is not allowed" sends someone looking for a typo.
  // "PerformedStationAETitle is N-CREATE-only" says what is actually wrong.
  const err = throwsUsage(
    () => mpps.assertNoCreateOnlyFlags(flagsOf('--station-ae CT01'), 'update')
  );
  assert.match(err.message, /PerformedStationAETitle/);
  assert.match(err.message, /F\.7\.2-1/);
  assert.match(err.message, /dcm mpps start/, 'and it says what to do instead');
});

test('several offending flags are all named, not just the first', () => {
  const err = throwsUsage(
    () => mpps.assertNoCreateOnlyFlags(flagsOf('--patient-id 1 --modality CT --step-id S1'), 'update')
  );
  for (const attribute of ['PatientID', 'Modality', 'PerformedProcedureStepID']) {
    assert.ok(err.message.includes(attribute), `must name ${attribute}`);
  }
});

test('a clean flag set passes', () => {
  assert.doesNotThrow(
    () => mpps.assertNoCreateOnlyFlags(flagsOf('--host h --port 1 --series-from ./x'), 'update')
  );
});

test('dcm mpps update refuses an N-CREATE-only flag rather than calling it unknown', async () => {
  // rejectUnknown() would otherwise get there first and answer "Unknown option
  // --station-ae. Did you mean --station-name?", which is a worse answer to a
  // question about the protocol.
  const err = await rejectsUsage(
    () => dispatcher.run(tokenize(['update', STEP_UID, '--dry-run', '--station-ae', 'CT01']))
  );
  assert.match(err.message, /PerformedStationAETitle/);
  assert.doesNotMatch(err.message, /Unknown option/);
});

test('an end date or time is refused with a reason about this verb', async () => {
  // Not N-CREATE-only — PS3.4 allows both on an N-SET — so the refusal has to
  // be about the interim case rather than about the table.
  for (const flag of ['end-date', 'end-time']) {
    const err = await rejectsUsage(
      () => dispatcher.run(tokenize(['update', STEP_UID, '--dry-run', `--${flag}`, '20260820']))
    );
    assert.match(err.message, /still running|leaves it running/);
    assert.match(err.message, /dcm mpps complete/);
  }
});

// ---------------------------------------------------------------------------
// Unscheduled steps
// ---------------------------------------------------------------------------

test('an unscheduled step emits exactly one zero-length item', () => {
  const ds = mpps.buildCreateDataset({ ...GOOD_ATTRS, studyInstanceUid: '', unscheduled: true });
  const seq = ds.ScheduledStepAttributesSequence;

  assert.ok(Array.isArray(seq), 'the sequence is present, not omitted — it is Type 1');
  assert.equal(seq.length, 1, 'exactly one item');
  assert.deepEqual(seq[0], {}, 'and that item is zero-length: no elements at all');
  assert.equal(
    Object.keys(seq[0]).length, 0,
    'not an item carrying the Type 2 attributes as empty strings — that is not zero-length'
  );
});

test('an unscheduled step passes the Type 1 check that used to refuse it', () => {
  // The reported blocker: `dcm mpps start --modality DX --step-id S1` failed on
  // ScheduledStepAttributesSequence[1].StudyInstanceUID, and --study-uid ""
  // failed identically.
  const ds = mpps.buildCreateDataset({
    performedProcedureStepId: 'S1',
    performedStationAeTitle: 'DX01',
    startDate: '20260821',
    startTime: '101010',
    modality: 'DX',
    unscheduled: true,
  });
  assert.deepEqual(mpps.missingType1(ds), []);
  assert.doesNotThrow(() => mpps.assertCreatable(ds));
});

test('StudyInstanceUID is still Type 1 inside a POPULATED item', () => {
  // The exemption must not be borrowable. A half-filled scheduled step is a
  // forgotten correlation key, which is the failure the check exists for.
  const ds = mpps.buildCreateDataset({ ...GOOD_ATTRS, studyInstanceUid: '' });
  assert.deepEqual(
    mpps.missingType1(ds),
    ['ScheduledStepAttributesSequence[1].StudyInstanceUID']
  );
  assert.throws(() => mpps.assertCreatable(ds), UsageError);
});

test('an item with blank values is not the unscheduled shape', () => {
  // The near-miss that matters: seven present-but-empty attributes look empty
  // and are not zero-length, so the Type 1 descent must still run.
  const item = mpps.buildScheduledStepItem({});
  assert.ok(Object.keys(item).length > 1);
  assert.equal(mpps.isUnscheduledStepSequence([item]), false);
  assert.deepEqual(
    mpps.missingType1({ ...mpps.buildCreateDataset(GOOD_ATTRS), ScheduledStepAttributesSequence: [item] }),
    ['ScheduledStepAttributesSequence[1].StudyInstanceUID']
  );
});

test('two empty items are not the unscheduled shape either', () => {
  // PS3.3 says exactly one. Two is two scheduled steps whose keys were lost,
  // and both are reported at their own index.
  assert.equal(mpps.isUnscheduledStepSequence([{}, {}]), false);
  const ds = { ...mpps.buildCreateDataset(GOOD_ATTRS), ScheduledStepAttributesSequence: [{}, {}] };
  assert.deepEqual(mpps.missingType1(ds), [
    'ScheduledStepAttributesSequence[1].StudyInstanceUID',
    'ScheduledStepAttributesSequence[2].StudyInstanceUID',
  ]);
});

test('the unscheduled sequence is a fresh object each time', () => {
  // Two steps built in one process must not share an item that either could
  // mutate into a populated one.
  const a = mpps.unscheduledStepSequence();
  const b = mpps.unscheduledStepSequence();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
});

test('the Type 1 refusal offers --unscheduled as one of the ways forward', () => {
  const err = throwsUsage(
    () => mpps.assertCreatable(mpps.buildCreateDataset({ ...GOOD_ATTRS, studyInstanceUid: '' }))
  );
  assert.match(err.message, /--unscheduled/);
});

test('--unscheduled and --study-uid are refused together, not silently ranked', () => {
  const err = throwsUsage(
    () => common.resolveAttributes(
      flagsOf('--unscheduled --study-uid 1.2.3 --modality DX --step-id S1'), { callingAe: 'DX01' }
    )
  );
  assert.match(err.message, /opposite things/);
});

test('--unscheduled and --from-worklist are refused together', () => {
  throwsUsage(
    () => common.resolveAttributes(flagsOf('--unscheduled --from-worklist wl.json'), { callingAe: 'DX01' })
  );
});

// ---------------------------------------------------------------------------
// One step fulfilling several scheduled steps
// ---------------------------------------------------------------------------

test('a repeated --study-uid produces one populated item per study', () => {
  const { attrs } = common.resolveAttributes(
    flagsOf('--study-uid 1.2.3 --study-uid 1.2.4 --modality CT --step-id S1'),
    { callingAe: 'CT01' }
  );
  const seq = mpps.buildCreateDataset(attrs).ScheduledStepAttributesSequence;

  assert.equal(seq.length, 2);
  assert.equal(seq[0].StudyInstanceUID, '1.2.3');
  assert.equal(seq[1].StudyInstanceUID, '1.2.4');
  assert.deepEqual(mpps.missingType1(mpps.buildCreateDataset(attrs)), [], 'both keys are present');
});

test('only the first item carries the single accession there is', () => {
  // Copying one accession onto several items would assert that several
  // different orders share it, which is a fabrication of exactly the kind this
  // command refuses everywhere else.
  const { attrs } = common.resolveAttributes(
    flagsOf('--study-uid 1.2.3 --study-uid 1.2.4 --accession A1 --modality CT --step-id S1'),
    { callingAe: 'CT01' }
  );
  const seq = mpps.buildCreateDataset(attrs).ScheduledStepAttributesSequence;

  assert.equal(seq[0].AccessionNumber, 'A1');
  assert.equal(seq[1].AccessionNumber, '', 'present and empty, which is what Type 2 means');
  for (const key of mpps.SCHEDULED_STEP_TYPE_2) {
    assert.ok(key in seq[1], `${key} is Type 2 and must be present even on the extra items`);
  }
});

test('a repeated --study-uid is refused alongside --from-worklist', () => {
  const err = throwsUsage(
    () => common.resolveAttributes(
      flagsOf('--study-uid 1.2.3 --study-uid 1.2.4 --from-worklist wl.json'), { callingAe: 'CT01' }
    )
  );
  assert.match(err.message, /narrows the file/);
});

test('a single --study-uid still produces one item, as it always did', () => {
  const { attrs } = common.resolveAttributes(
    flagsOf('--study-uid 1.2.3 --modality CT --step-id S1'), { callingAe: 'CT01' }
  );
  assert.equal(attrs.scheduledStudyUids, undefined);
  assert.equal(mpps.buildCreateDataset(attrs).ScheduledStepAttributesSequence.length, 1);
});

test('dcm mpps perform refuses a repeated --study-uid and says where it works', async () => {
  // One folder is one study, so the extra studies would be named by a step
  // whose images do not belong to them.
  await withTempDir('dcm-mpps-update', async (dir) => {
    const source = await studyIn(dir);
    const err = await rejectsUsage(
      () => dispatcher.run(tokenize([
        'perform', source, '--dry-run',
        '--study-uid', '1.2.3', '--study-uid', '1.2.4',
      ]))
    );
    assert.match(err.message, /one folder is one study/);
    assert.match(err.message, /dcm mpps start/);
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

test('a flag that takes no value says so when the UID was swallowed', () => {
  // The parser gives a flag the next token unless it is another flag, so
  // `update --no-status 2.25.1` reads the UID as the value and then reports a
  // missing UID — two wrong sentences about one typo.
  const err = throwsUsage(
    () => common.booleanFlag(flagsOf(`--no-status ${STEP_UID}`), 'no-status', 'the MPPS SOP Instance UID')
  );
  assert.match(err.message, /takes no value/);
  assert.ok(err.message.includes(STEP_UID));
});

test('the same flag written last is read as the boolean it is', () => {
  assert.equal(common.booleanFlag(flagsOf('--series-from ./x --no-status'), 'no-status'), true);
  assert.equal(common.booleanFlag(flagsOf('--series-from ./x'), 'no-status'), false);
});

test('an update naming no step says the UID is the only handle there is', async () => {
  const err = await rejectsUsage(() => dispatcher.run(tokenize(['update', '--dry-run'])));
  assert.match(err.message, /only handle/);
  assert.match(err.message, /no query service/);
});

test('an update naming two steps is refused', async () => {
  await rejectsUsage(
    () => dispatcher.run(tokenize(['update', STEP_UID, '2.25.2', '--dry-run']))
  );
});

test('a malformed step UID is refused before anything connects', async () => {
  await rejectsUsage(() => dispatcher.run(tokenize(['update', 'not-a-uid', '--dry-run'])));
});

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

test('--json emits exactly one JSON document, and it names both absences', async () => {
  const sink = log.beginCapture();
  let code;
  try {
    code = await dispatcher.run(tokenize(['update', STEP_UID, '--dry-run', '--json']));
  } finally {
    log.endCapture();
  }

  assert.equal(code, 0);
  const parsed = JSON.parse(sink.out);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.statusSent, true);
  assert.equal(parsed.performedSeriesSent, false);
  assert.deepEqual(parsed.dataset, { PerformedProcedureStepStatus: 'IN PROGRESS' });
});

test('--no-status --series-from emits the status-absent shape', async () => {
  await withTempDir('dcm-mpps-update', async (dir) => {
    const source = await studyIn(dir);

    const sink = log.beginCapture();
    try {
      await dispatcher.run(tokenize([
        'update', STEP_UID, '--dry-run', '--json', '--no-status',
        '--series-from', source,
      ]));
    } finally {
      log.endCapture();
    }

    const parsed = JSON.parse(sink.out);
    assert.equal(parsed.statusSent, false);
    assert.equal(parsed.performedSeriesSent, true);
    assert.equal(parsed.assertedFromDisk, true, 'a folder scan is never presented as acknowledged');
    assert.ok(!('PerformedProcedureStepStatus' in parsed.dataset));
    assert.equal(
      parsed.dataset.PerformedSeriesSequence.length, 2,
      'two series were generated, and the scan found both'
    );
  });
});

test('a start dry-run reports the unscheduled shape in its JSON', async () => {
  const sink = log.beginCapture();
  try {
    await dispatcher.run(tokenize([
      'start', '--dry-run', '--json', '--unscheduled', '--modality', 'DX', '--step-id', 'W1',
    ]));
  } finally {
    log.endCapture();
  }

  const parsed = JSON.parse(sink.out);
  assert.equal(parsed.unscheduled, true);
  assert.equal(parsed.scheduledStepItems, 1);
  assert.deepEqual(parsed.dataset.ScheduledStepAttributesSequence, [{}]);
});

test('a perform dry-run says the two identities diverge under --unscheduled', async () => {
  await withTempDir('dcm-mpps-update', async (dir) => {
    const source = await studyIn(dir);

    const sink = log.beginCapture();
    try {
      await dispatcher.run(tokenize([
        'perform', source, '--dry-run', '--json',
        '--unscheduled', '--modality', 'DX', '--step-id', 'W1',
      ]));
    } finally {
      log.endCapture();
    }

    const parsed = JSON.parse(sink.out);
    assert.equal(parsed.unscheduled, true);
    assert.equal(
      parsed.studyInstanceUid, STUDY_UID,
      'the images keep the study they carry, because that is what the archive files them by'
    );
    assert.equal(parsed.stepStudyInstanceUid, null, 'and the step names none');
    assert.deepEqual(parsed.dataset.ScheduledStepAttributesSequence, [{}]);
  });
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

test('the update usage names the traps rather than only the flags', () => {
  // Each of these is a trap someone hits once and then hits again, so the
  // usage has to carry them: the replacement semantics, the disk-asserted
  // sequence, the N-CREATE-only refusal, and the missing end date.
  assert.match(update.USAGE, /REPLACES, it does not append/);
  assert.match(update.USAGE, /YOUR DISK/);
  assert.match(update.USAGE, /N-CREATE-only/);
  assert.match(update.USAGE, /an end date or time is not accepted here/i);
  assert.match(update.USAGE, /--no-status/);
  assert.ok(!/^\s/.test(update.USAGE), 'USAGE is trimStart()ed, like every other command');
});

test('the update usage does not advertise a flag that would write a record', () => {
  // The same guard the other verbs carry: this tool keeps nothing on disk.
  assert.equal(/--(record-dir|record|write-acknowledged|acknowledged)\b/.test(update.USAGE), false);
  assert.equal(/^\s+--out\b/m.test(update.USAGE), false);
});

test('start and perform document the unscheduled shape precisely', () => {
  const start = dispatcher.VERBS.start().USAGE;
  const perform = dispatcher.VERBS.perform().USAGE;

  for (const usage of [start, perform]) {
    assert.match(usage, /--unscheduled/);
    assert.match(usage, /ZERO-LENGTH/);
  }
  // The divergence is the whole point of --unscheduled on perform, so it has
  // to be stated there rather than left for someone to notice in the output.
  assert.match(perform, /DIVERGE|diverge/);
  assert.match(perform, /--update-each-chunk/);
});
