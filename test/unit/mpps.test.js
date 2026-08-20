'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tokenize, UsageError } = require('../../src/lib/args');
const { Disposition } = require('../../src/lib/ledger');
const { validateUid } = require('../../src/lib/uid');
const mpps = require('../../src/lib/mpps');
const dispatcher = require('../../src/commands/mpps');
const common = require('../../src/commands/mpps/common');
const finish = require('../../src/commands/mpps/finish');
const perform = require('../../src/commands/mpps/perform');

/**
 * Modality Performed Procedure Step.
 *
 * Nothing here opens a socket. Every test is about a decision made before
 * anything goes on the wire, which is where all four of this command's
 * honesty rules actually live: what may be claimed, what must be refused, and
 * what the flags resolve to.
 */

// --- helpers ---------------------------------------------------------------

/** Parses a command line the way the CLI does, minus the verb. */
function flagsOf(line) {
  return tokenize(line.split(' ').filter(Boolean)).flags;
}

/** A minimal ledger-entry-shaped object. */
function entry(disposition, sopUid, seriesUid, sopClassUid = '1.2.840.10008.5.1.4.1.1.2') {
  return {
    disposition,
    path: `/tmp/${sopUid}.dcm`,
    sopInstanceUid: sopUid,
    seriesInstanceUid: seriesUid,
    sopClassUid,
  };
}

/**
 * Runs fn, asserts it threw a UsageError, and hands the error back.
 *
 * node:assert's throws() returns undefined, so the error has to be caught here
 * for the message to be asserted on — and the message is most of the point:
 * a refusal that does not say which attribute is wrong is not much better than
 * no refusal at all.
 */
function throwsUsage(fn) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'UsageError', `expected a UsageError, got ${err.stack}`);
    return err;
  }
  assert.fail('expected a UsageError, nothing was thrown');
}

/** Writes a JSON file into a fresh temp directory and returns its path. */
function tempJson(name, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mpps-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

const GOOD_ATTRS = Object.freeze({
  studyInstanceUid: '1.2.826.0.1.3680043.10.1337.1',
  performedProcedureStepId: 'STEP001',
  performedStationAeTitle: 'CT01',
  startDate: '20260820',
  startTime: '093155',
  modality: 'CT',
});

// --- Type 1 validation -----------------------------------------------------

test('a complete N-CREATE dataset passes the Type 1 check', () => {
  const ds = mpps.buildCreateDataset(GOOD_ATTRS);
  assert.deepEqual(mpps.missingType1(ds), []);
  assert.doesNotThrow(() => mpps.assertCreatable(ds));
});

test('every missing Type 1 attribute is named, not just the first', () => {
  const ds = mpps.buildCreateDataset({ studyInstanceUid: '1.2.3' });
  const missing = mpps.missingType1(ds);

  assert.ok(missing.includes('PerformedProcedureStepID'));
  assert.ok(missing.includes('PerformedStationAETitle'));
  assert.ok(missing.includes('Modality'));
  assert.ok(missing.includes('PerformedProcedureStepStartDate'));
  assert.ok(missing.includes('PerformedProcedureStepStartTime'));

  const err = throwsUsage(() => mpps.assertCreatable(ds));
  for (const name of missing) {
    assert.ok(err.message.includes(name), `the refusal must name ${name}`);
  }
});

test('a blank Type 1 is refused, because that is what SCPs silently accept', () => {
  // Whitespace, not absence: this is the shape that gets through a naive check
  // and then leaves the order unreconciled forever.
  const ds = mpps.buildCreateDataset({ ...GOOD_ATTRS, performedProcedureStepId: '   ' });
  assert.deepEqual(mpps.missingType1(ds), ['PerformedProcedureStepID']);
  assert.throws(() => mpps.assertCreatable(ds), UsageError);
});

test('a missing StudyInstanceUID is reported at its path inside the sequence', () => {
  const ds = mpps.buildCreateDataset({ ...GOOD_ATTRS, studyInstanceUid: '' });
  const missing = mpps.missingType1(ds);
  assert.ok(
    missing.includes('ScheduledStepAttributesSequence[1].StudyInstanceUID'),
    `expected the nested path, got ${JSON.stringify(missing)}`
  );
});

test('Type 2 attributes are present but empty, never absent', () => {
  const ds = mpps.buildCreateDataset(GOOD_ATTRS);
  for (const key of mpps.CREATE_TYPE_2) {
    assert.ok(key in ds, `${key} must be present even when there is nothing to say`);
  }
  // Empty means '' for a string and [] for a sequence, and the two are not
  // interchangeable — dcmjs writes a very different element for each.
  assert.equal(ds.PatientName, '');
  assert.deepEqual(ds.ProcedureCodeSequence, []);
  assert.deepEqual(ds.ReferencedPatientSequence, []);
});

test('PerformedSeriesSequence is empty at creation', () => {
  const ds = mpps.buildCreateDataset({ ...GOOD_ATTRS, performedSeries: [{ SeriesInstanceUID: '1.2.3' }] });
  assert.deepEqual(
    ds.PerformedSeriesSequence, [],
    'nothing has been performed yet, so nothing may be claimed'
  );
});

test('PerformedProcedureStepStatus is IN PROGRESS on the N-CREATE', () => {
  assert.equal(
    mpps.buildCreateDataset(GOOD_ATTRS).PerformedProcedureStepStatus,
    mpps.Status.IN_PROGRESS
  );
});

// --- ScheduledStepAttributesSequence correlation ---------------------------

test('StudyInstanceUID is the correlation key inside the scheduled step', () => {
  const ds = mpps.buildCreateDataset(GOOD_ATTRS);
  const [step] = ds.ScheduledStepAttributesSequence;

  assert.equal(step.StudyInstanceUID, GOOD_ATTRS.studyInstanceUid);
  assert.ok(
    !('StudyInstanceUID' in ds),
    'it belongs in the sequence, not at the top level — a top-level copy is the ' +
      'mirror of the flat-MWL-query mistake'
  );
});

test('the scheduled step carries every Type 2 attribute, empty when unknown', () => {
  const [step] = mpps.buildCreateDataset(GOOD_ATTRS).ScheduledStepAttributesSequence;
  for (const key of mpps.SCHEDULED_STEP_TYPE_2) {
    assert.ok(key in step, `${key} must be present in the scheduled step item`);
  }
  assert.equal(step.AccessionNumber, '');
  assert.deepEqual(step.ReferencedStudySequence, []);
});

test('scheduled-step attributes survive from the worklist into the sequence', () => {
  const [step] = mpps.buildCreateDataset({
    ...GOOD_ATTRS,
    accessionNumber: 'ACC1',
    requestedProcedureId: 'RP001',
    scheduledProcedureStepId: 'SPS001',
    referencedStudySequence: [{ ReferencedSOPInstanceUID: '1.2.3', _vrMap: { x: 'UI' } }],
  }).ScheduledStepAttributesSequence;

  assert.equal(step.AccessionNumber, 'ACC1');
  assert.equal(step.RequestedProcedureID, 'RP001');
  assert.equal(step.ScheduledProcedureStepID, 'SPS001');
  assert.deepEqual(step.ReferencedStudySequence, [{ ReferencedSOPInstanceUID: '1.2.3' }]);
});

test('_vrMap keys are stripped at every level, not just the top', () => {
  const stripped = mpps.stripPrivate({
    PatientID: '1',
    _vrMap: { PatientID: 'LO' },
    Seq: [{ A: '1', _vrMap: { A: 'SH' }, Inner: [{ B: '2', _vrMap: {} }] }],
  });
  assert.deepEqual(stripped, { PatientID: '1', Seq: [{ A: '1', Inner: [{ B: '2' }] }] });
});

// --- PerformedSeriesSequence ----------------------------------------------

test('only acknowledged instances reach PerformedSeriesSequence', () => {
  const built = mpps.buildPerformedSeriesSequence([
    entry(Disposition.ACKNOWLEDGED, '1.1', 'S1'),
    entry(Disposition.FAILED, '1.2', 'S1'),
    entry(Disposition.UNANSWERED, '1.3', 'S1'),
    entry(Disposition.NOT_ATTEMPTED, '1.4', 'S1'),
    entry(Disposition.READ_ERROR, '1.5', 'S1'),
  ]);

  assert.equal(built.referenced, 1);
  const referenced = built.items[0].ReferencedImageSequence.map((i) => i.ReferencedSOPInstanceUID);
  assert.deepEqual(referenced, ['1.1']);
  // Naming an instance the archive refused would be a fabricated record: every
  // system downstream reads this list as instances that exist in the archive.
  for (const unwanted of ['1.2', '1.3', '1.4', '1.5']) {
    assert.ok(!referenced.includes(unwanted), `${unwanted} must not be referenced`);
  }
});

test('a warning instance is referenced — the archive did store it', () => {
  const built = mpps.buildPerformedSeriesSequence([entry(Disposition.WARNING, '2.1', 'S1')]);
  assert.equal(built.referenced, 1);
});

test('performed series are grouped by Series Instance UID', () => {
  const built = mpps.buildPerformedSeriesSequence([
    entry(Disposition.ACKNOWLEDGED, '1.1', 'S1'),
    entry(Disposition.ACKNOWLEDGED, '2.1', 'S2'),
    entry(Disposition.ACKNOWLEDGED, '1.2', 'S1'),
    entry(Disposition.ACKNOWLEDGED, '2.2', 'S2'),
  ]);

  assert.equal(built.items.length, 2);
  assert.equal(built.referenced, 4);
  const bySeries = new Map(built.items.map((i) => [i.SeriesInstanceUID, i]));
  assert.deepEqual(
    bySeries.get('S1').ReferencedImageSequence.map((i) => i.ReferencedSOPInstanceUID),
    ['1.1', '1.2']
  );
  assert.deepEqual(
    bySeries.get('S2').ReferencedImageSequence.map((i) => i.ReferencedSOPInstanceUID),
    ['2.1', '2.2']
  );
});

test('an instance found twice on disk is referenced once', () => {
  const built = mpps.buildPerformedSeriesSequence([
    entry(Disposition.ACKNOWLEDGED, '1.1', 'S1'),
    entry(Disposition.ACKNOWLEDGED, '1.1', 'S1'),
  ]);
  assert.equal(built.referenced, 1, 'referencing it twice would overstate the work performed');
  assert.equal(built.duplicates, 1, 'and the second sighting is counted, not silently dropped');
});

test('an acknowledged instance that cannot be referenced is reported, not dropped', () => {
  const built = mpps.buildPerformedSeriesSequence([
    entry(Disposition.ACKNOWLEDGED, '1.1', undefined),
    entry(Disposition.ACKNOWLEDGED, undefined, 'S1'),
  ]);
  assert.equal(built.referenced, 0);
  assert.equal(built.skipped.length, 2);
  assert.equal(built.skipped[0].reason, 'no SeriesInstanceUID');
  assert.equal(built.skipped[1].reason, 'no SOPInstanceUID');
});

test('each performed series carries the Type 2 attributes an SCP may expect', () => {
  const [item] = mpps.buildPerformedSeriesSequence(
    [entry(Disposition.ACKNOWLEDGED, '1.1', 'S1')],
    { retrieveAeTitle: 'ARCHIVE', seriesMeta: new Map([['S1', { seriesDescription: 'AX CT' }]]) }
  ).items;

  assert.equal(item.RetrieveAETitle, 'ARCHIVE');
  assert.equal(item.SeriesDescription, 'AX CT');
  assert.equal(item.ProtocolName, '');
  assert.deepEqual(item.ReferencedNonImageCompositeSOPInstanceSequence, []);
});

test('a folder-derived sequence is flagged as asserted from disk', () => {
  const studies = new Map([['ST1', {
    instances: [
      { path: '/a.dcm', sopInstanceUid: '1.1', seriesInstanceUid: 'S1', sopClassUid: 'C' },
      { path: '/b.dcm', sopInstanceUid: '1.2', seriesInstanceUid: 'S1', sopClassUid: 'C' },
    ],
  }]]);

  const built = mpps.buildPerformedSeriesSequenceFromFolder(studies);
  assert.equal(built.referenced, 2);
  assert.equal(
    built.assertedFromDisk, true,
    'the caller has to be able to tell the two sources apart in order to say so'
  );

  // The ledger-derived builder never sets this, which is what makes the flag
  // meaningful rather than decorative.
  const fromLedger = mpps.buildPerformedSeriesSequence([entry(Disposition.ACKNOWLEDGED, '1.1', 'S1')]);
  assert.equal(fromLedger.assertedFromDisk, undefined);
});

// --- N-SET dataset and status transitions ---------------------------------

test('an N-SET carries only what changes', () => {
  const ds = mpps.buildSetDataset({
    status: mpps.Status.COMPLETED,
    endDate: '20260820',
    endTime: '094500',
    performedSeries: [{ SeriesInstanceUID: 'S1' }],
  });

  assert.deepEqual(Object.keys(ds).sort(), [
    'PerformedProcedureStepEndDate',
    'PerformedProcedureStepEndTime',
    'PerformedProcedureStepStatus',
    'PerformedSeriesSequence',
  ]);
});

test('an N-SET cannot set IN PROGRESS', () => {
  assert.throws(
    () => mpps.buildSetDataset({ status: mpps.Status.IN_PROGRESS, endDate: '1', endTime: '1' }),
    UsageError
  );
});

test('IN PROGRESS may go to either terminal status', () => {
  assert.doesNotThrow(() => mpps.assertLegalTransition(mpps.Status.IN_PROGRESS, mpps.Status.COMPLETED));
  assert.doesNotThrow(() => mpps.assertLegalTransition(mpps.Status.IN_PROGRESS, mpps.Status.DISCONTINUED));
});

test('a terminal status is final, including re-setting the same one', () => {
  for (const from of [mpps.Status.COMPLETED, mpps.Status.DISCONTINUED]) {
    for (const to of [mpps.Status.COMPLETED, mpps.Status.DISCONTINUED]) {
      const err = throwsUsage(() => mpps.assertLegalTransition(from, to));
      assert.ok(err.message.includes('final state'));
    }
  }
});

test('a status that is not a status is refused by name', () => {
  assert.throws(() => mpps.assertLegalTransition('STARTED', mpps.Status.COMPLETED), UsageError);
  assert.throws(() => mpps.assertLegalTransition(mpps.Status.IN_PROGRESS, 'DONE'), UsageError);
});

test('a free-text reason is never coerced into a code', () => {
  assert.deepEqual(mpps.parseReasonCode(undefined), []);
  assert.deepEqual(mpps.parseReasonCode(''), []);
  assert.throws(() => mpps.parseReasonCode('patient moved'), UsageError);
  assert.throws(() => mpps.parseReasonCode('110513^DCM'), UsageError);
  assert.throws(() => mpps.parseReasonCode('110513^^Meaning'), UsageError);

  assert.deepEqual(mpps.parseReasonCode('110513^DCM^Equipment failure'), [{
    CodeValue: '110513',
    CodingSchemeDesignator: 'DCM',
    CodeMeaning: 'Equipment failure',
  }]);
});

test('a discontinuation reason code only appears when one was given', () => {
  const without = mpps.buildSetDataset({
    status: mpps.Status.DISCONTINUED, endDate: '1', endTime: '1', discontinuationReasonCode: [],
  });
  assert.ok(!('PerformedProcedureStepDiscontinuationReasonCodeSequence' in without));

  const with_ = mpps.buildSetDataset({
    status: mpps.Status.DISCONTINUED,
    endDate: '1',
    endTime: '1',
    discontinuationReasonCode: mpps.parseReasonCode('110513^DCM^Equipment failure'),
  });
  assert.equal(with_.PerformedProcedureStepDiscontinuationReasonCodeSequence.length, 1);
});

// --- UID generation --------------------------------------------------------

test('the MPPS SOP Instance UID is a valid 2.25 UID', () => {
  const uid = mpps.newMppsUid({
    studyInstanceUid: '1.2.3', performedProcedureStepId: 'S1',
    performedStationAeTitle: 'CT01', startDate: '20260820', startTime: '093155',
  });
  assert.ok(uid.startsWith('2.25.'));
  assert.deepEqual(validateUid(uid), { valid: true });
  assert.ok(uid.length <= 64);
});

test('the same step at the same second yields the same UID', () => {
  const key = {
    studyInstanceUid: '1.2.3', performedProcedureStepId: 'S1',
    performedStationAeTitle: 'CT01', startDate: '20260820', startTime: '093155',
  };
  assert.equal(mpps.newMppsUid(key), mpps.newMppsUid(key));
});

test('a different step yields a different UID', () => {
  const base = {
    studyInstanceUid: '1.2.3', performedProcedureStepId: 'S1',
    performedStationAeTitle: 'CT01', startDate: '20260820', startTime: '093155',
  };
  const seen = new Set([mpps.newMppsUid(base)]);
  for (const change of [
    { studyInstanceUid: '1.2.4' },
    { performedProcedureStepId: 'S2' },
    { performedStationAeTitle: 'CT02' },
    { startDate: '20260821' },
    { startTime: '093156' },
  ]) {
    seen.add(mpps.newMppsUid({ ...base, ...change }));
  }
  assert.equal(seen.size, 6, 'each component of the key must change the UID');
});

test('a supplied MPPS UID is validated rather than trusted', () => {
  assert.equal(mpps.requireUid('2.25.1', '--mpps-uid'), '2.25.1');
  assert.throws(() => mpps.requireUid('not a uid', '--mpps-uid'), UsageError);
  assert.throws(() => mpps.requireUid('1.2.03', '--mpps-uid'), UsageError);
  assert.throws(() => mpps.requireUid(`1.${'2'.repeat(70)}`, '--mpps-uid'), UsageError);
});

// --- date and time ---------------------------------------------------------

test('dates and times are formatted as DA and TM', () => {
  const when = new Date(2026, 7, 20, 9, 3, 5);
  assert.equal(mpps.dicomDate(when), '20260820');
  assert.equal(mpps.dicomTime(when), '090305');
});

// --- worklist handoff ------------------------------------------------------

test('a worklist file is accepted in every shape people produce', () => {
  const item = { StudyInstanceUID: '1.2.3', Modality: 'CT' };
  for (const value of [item, [item], { items: [item] }, { matches: [item], count: 1 }]) {
    const loaded = mpps.readWorklistFile(tempJson('wl.json', value));
    assert.equal(loaded.item.StudyInstanceUID, '1.2.3');
  }
});

test('a nested ScheduledProcedureStepSequence is flattened without losing sequences', () => {
  const loaded = mpps.readWorklistFile(tempJson('wl.json', {
    matches: [{
      PatientID: '12345',
      _vrMap: { PatientID: 'LO' },
      ScheduledProcedureStepSequence: [{
        Modality: 'CT',
        ScheduledProcedureStepID: 'SPS001',
        ScheduledProtocolCodeSequence: [{ CodeValue: '1', CodingSchemeDesignator: 'L', CodeMeaning: 'X' }],
        _vrMap: {},
      }],
    }],
  }));

  assert.equal(loaded.item.Modality, 'CT');
  assert.equal(loaded.item.ScheduledProcedureStepID, 'SPS001');
  assert.equal(loaded.item.ScheduledProtocolCodeSequence.length, 1);
  assert.ok(!('_vrMap' in loaded.item));
});

test('rendered output from `find --mwl --json` is refused by name', () => {
  // display() turns a sequence into text. Feeding that to an N-CREATE would
  // either fail to encode or silently drop the attribute, and the symptom
  // looks like a broken worklist rather than the wrong export format.
  const file = tempJson('rendered.json', {
    matches: [{
      StudyInstanceUID: '1.2.3',
      ReferencedStudySequence: '[{"ReferencedSOPInstanceUID":"1.2.3"}]',
    }],
  });

  const err = throwsUsage(() => mpps.readWorklistFile(file));
  assert.ok(err.message.includes('ReferencedStudySequence'), 'names the offending attribute');
  assert.ok(err.message.includes('--json-raw'), 'names the fix');
});

test('an empty rendered sequence is not mistaken for rendered text', () => {
  // display([]) is '', which is indistinguishable from a genuinely empty
  // string value. Refusing on that would reject perfectly good files.
  const loaded = mpps.readWorklistFile(tempJson('wl.json', {
    matches: [{ StudyInstanceUID: '1.2.3', ReferencedStudySequence: '' }],
  }));
  assert.deepEqual(mpps.worklistToAttributes(loaded.item).referencedStudySequence, []);
});

test('a multi-item worklist file must be narrowed to one step', () => {
  const file = tempJson('wl.json', {
    matches: [
      { StudyInstanceUID: '1.2.3', AccessionNumber: 'A1' },
      { StudyInstanceUID: '1.2.4', AccessionNumber: 'A2' },
    ],
  });

  const err = throwsUsage(() => mpps.readWorklistFile(file));
  assert.ok(err.message.includes('exactly one'));

  assert.equal(mpps.readWorklistFile(file, { studyUid: '1.2.4' }).item.AccessionNumber, 'A2');
  assert.equal(mpps.readWorklistFile(file, { accession: 'A1' }).item.StudyInstanceUID, '1.2.3');
  assert.throws(() => mpps.readWorklistFile(file, { studyUid: '9.9.9' }), UsageError);
});

test('an unreadable or malformed worklist file fails with a readable message', () => {
  assert.throws(() => mpps.readWorklistFile(path.join(os.tmpdir(), 'no-such-worklist.json')), UsageError);
  assert.throws(() => mpps.readWorklistFile(tempJson('bad.json', '{ not json')), UsageError);
  assert.throws(() => mpps.readWorklistFile(tempJson('empty.json', [])), UsageError);
});

test('a Person Name object from the wire becomes a plain string', () => {
  const attrs = mpps.worklistToAttributes({
    PatientName: { Alphabetic: 'DOE^JANE' },
    StudyInstanceUID: '1.2.3',
  });
  assert.equal(attrs.patientName, 'DOE^JANE');
  assert.equal(mpps.buildCreateDataset(attrs).PatientName, 'DOE^JANE');
});

// --- step record -----------------------------------------------------------

test('a step record holds only the instances that were acknowledged', () => {
  const record = mpps.buildStepRecord({
    mppsSopInstanceUid: '2.25.1',
    status: mpps.Status.COMPLETED,
    studyInstanceUid: '1.2.3',
    peer: { host: 'h', port: 1, calledAe: 'A', callingAe: 'B' },
    entries: [
      entry(Disposition.ACKNOWLEDGED, '1.1', 'S1'),
      entry(Disposition.WARNING, '1.2', 'S1'),
      entry(Disposition.FAILED, '1.3', 'S1'),
      entry(Disposition.UNANSWERED, '1.4', 'S1'),
    ],
  });

  assert.equal(record.kind, mpps.STEP_FILE_KIND);
  assert.deepEqual(record.instances.map((i) => i.sopInstanceUid), ['1.1', '1.2']);
});

test('a step record round-trips and rebuilds the same performed series', () => {
  const record = mpps.buildStepRecord({
    mppsSopInstanceUid: '2.25.1',
    status: mpps.Status.IN_PROGRESS,
    studyInstanceUid: '1.2.3',
    peer: {},
    entries: [entry(Disposition.ACKNOWLEDGED, '1.1', 'S1'), entry(Disposition.ACKNOWLEDGED, '2.1', 'S2')],
  });

  const { record: read } = mpps.readStepRecord(tempJson('step.json', record));
  const built = mpps.buildPerformedSeriesSequence(read.instances);
  assert.equal(built.items.length, 2);
  assert.equal(built.referenced, 2);
});

test('a file that is not a step record is refused', () => {
  assert.throws(() => mpps.readStepRecord(tempJson('x.json', { instances: [] })), UsageError);
  assert.throws(() => mpps.readStepRecord(tempJson('x.json', { kind: mpps.STEP_FILE_KIND })), UsageError);
});

test('a step record edited to claim unacknowledged instances is refused', () => {
  // The whole value of the file is that everything in it was acknowledged. If
  // that stops being true it must fail loudly, not quietly build a false record.
  const tampered = {
    kind: mpps.STEP_FILE_KIND,
    version: mpps.STEP_FILE_VERSION,
    instances: [{ disposition: Disposition.FAILED, sopInstanceUid: '1.1', seriesInstanceUid: 'S1' }],
  };
  const err = throwsUsage(() => mpps.readStepRecord(tempJson('bad.json', tampered)));
  assert.ok(err.message.includes('disposition'));
});

// --- flag resolution -------------------------------------------------------

test('the station AE defaults to the calling AE, which is how the images arrive', () => {
  const { attrs } = common.resolveAttributes(flagsOf('--study-uid 1.2.3 --modality CT --step-id S1'), { callingAe: 'CT01' });
  assert.equal(attrs.performedStationAeTitle, 'CT01');

  const explicit = common.resolveAttributes(
    flagsOf('--study-uid 1.2.3 --station-ae SCANNER1'), { callingAe: 'CT01' }
  );
  assert.equal(explicit.attrs.performedStationAeTitle, 'SCANNER1');
});

test('an over-long station AE is refused rather than truncated', () => {
  assert.throws(
    () => common.resolveAttributes(flagsOf('--station-ae SEVENTEEN-CHARSXX'), { callingAe: 'A' }),
    UsageError
  );
});

test('the performed step ID falls back to the scheduled step ID', () => {
  const { attrs } = common.resolveAttributes(
    flagsOf('--study-uid 1.2.3 --modality CT --scheduled-step-id SPS001'), { callingAe: 'A' }
  );
  assert.equal(attrs.performedProcedureStepId, 'SPS001');
  assert.equal(attrs.scheduledProcedureStepId, 'SPS001');

  const explicit = common.resolveAttributes(
    flagsOf('--scheduled-step-id SPS001 --step-id PPS001'), { callingAe: 'A' }
  );
  assert.equal(explicit.attrs.performedProcedureStepId, 'PPS001');
});

test('start date and time default to now', () => {
  const now = new Date(2026, 7, 20, 9, 31, 55);
  const { attrs } = common.resolveAttributes(flagsOf('--study-uid 1.2.3'), { callingAe: 'A' }, now);
  assert.equal(attrs.startDate, '20260820');
  assert.equal(attrs.startTime, '093155');

  const given = common.resolveAttributes(
    flagsOf('--start-date 20250101 --start-time 010203'), { callingAe: 'A' }, now
  );
  assert.equal(given.attrs.startDate, '20250101');
  assert.equal(given.attrs.startTime, '010203');
});

test('an explicit flag beats the worklist, and the worklist fills the rest', () => {
  const file = tempJson('wl.json', {
    matches: [{
      StudyInstanceUID: '1.2.3',
      Modality: 'CT',
      AccessionNumber: 'FROM-WORKLIST',
      PatientID: '12345',
      RequestedProcedureID: 'RP001',
    }],
  });

  const { attrs, source } = common.resolveAttributes(
    flagsOf(`--from-worklist ${file} --accession OVERRIDDEN`), { callingAe: 'A' }
  );

  assert.equal(attrs.accessionNumber, 'OVERRIDDEN', 'the flag wins');
  assert.equal(attrs.modality, 'CT', 'the worklist fills what the flags left blank');
  assert.equal(attrs.patientId, '12345');
  assert.equal(attrs.requestedProcedureId, 'RP001');
  assert.equal(source.worklistItems, 1);
});

test('--study-uid narrows a multi-item worklist rather than colliding with it', () => {
  const file = tempJson('wl.json', {
    matches: [
      { StudyInstanceUID: '1.2.3', Modality: 'CT' },
      { StudyInstanceUID: '1.2.4', Modality: 'MR' },
    ],
  });
  const { attrs } = common.resolveAttributes(
    flagsOf(`--from-worklist ${file} --study-uid 1.2.4`), { callingAe: 'A' }
  );
  assert.equal(attrs.modality, 'MR');
});

test('the storage peer defaults to the MPPS peer, and says which parts it inherited', () => {
  const peer = { host: 'ris.example.org', port: 11112, calledAe: 'MPPSSCP', callingAe: 'DCM-CLI' };

  const all = common.resolveStoreConnection(flagsOf(''), peer);
  assert.deepEqual(
    { host: all.host, port: all.port, calledAe: all.calledAe },
    { host: 'ris.example.org', port: 11112, calledAe: 'MPPSSCP' }
  );
  assert.deepEqual(all.inherited, ['--store-host', '--store-port', '--store-called-ae']);

  const split = common.resolveStoreConnection(
    flagsOf('--store-host pacs.example.org --store-port 104 --store-called-ae ARCHIVE'), peer
  );
  assert.deepEqual(
    { host: split.host, port: split.port, calledAe: split.calledAe },
    { host: 'pacs.example.org', port: 104, calledAe: 'ARCHIVE' }
  );
  assert.deepEqual(split.inherited, [], 'nothing was defaulted, so nothing is claimed');

  const partial = common.resolveStoreConnection(flagsOf('--store-host pacs.example.org'), peer);
  assert.equal(partial.port, 11112);
  assert.deepEqual(partial.inherited, ['--store-port', '--store-called-ae']);
});

test('a bad storage port is refused', () => {
  const peer = { host: 'h', port: 1, calledAe: 'A', callingAe: 'B' };
  assert.throws(() => common.resolveStoreConnection(flagsOf('--store-port 99999'), peer), UsageError);
});

// --- closing a step --------------------------------------------------------

test('the UID may come from the argument or the step record, but not disagree', () => {
  assert.equal(finish.resolveMppsUid('2.25.1', undefined), '2.25.1');
  assert.equal(finish.resolveMppsUid(undefined, { mppsSopInstanceUid: '2.25.2' }), '2.25.2');
  assert.equal(finish.resolveMppsUid('2.25.3', { mppsSopInstanceUid: '2.25.3' }), '2.25.3');

  const err = throwsUsage(() => finish.resolveMppsUid('2.25.1', { mppsSopInstanceUid: '2.25.2' }));
  assert.ok(err.message.includes('different procedure step'));

  assert.throws(() => finish.resolveMppsUid(undefined, undefined), UsageError);
});

test('--acknowledged and --series-from cannot both answer the same question', () => {
  const err = throwsUsage(
    () => finish.resolvePerformedSeries(flagsOf('--series-from ./x'), { instances: [] }, '')
  );
  assert.ok(err.message.includes('Pick one'));
});

test('with neither source the performed series is empty and says so', () => {
  const { built, assertedFromDisk } = finish.resolvePerformedSeries(flagsOf(''), undefined, '');
  assert.deepEqual(built.items, []);
  assert.equal(assertedFromDisk, false);
});

test('a step record builds a performed series that is not asserted from disk', () => {
  const { built, assertedFromDisk, sourceLabel } = finish.resolvePerformedSeries(
    flagsOf(''),
    { instances: [entry(Disposition.ACKNOWLEDGED, '1.1', 'S1')] },
    'ARCHIVE'
  );
  assert.equal(built.referenced, 1);
  assert.equal(built.items[0].RetrieveAETitle, 'ARCHIVE');
  assert.equal(assertedFromDisk, false);
  assert.equal(sourceLabel, 'acknowledged instances');
});

// --- perform ---------------------------------------------------------------

test('a folder holding more than one study is refused', () => {
  const scanned = {
    filesExamined: 2,
    studies: new Map([
      ['1.2.3', { studyInstanceUid: '1.2.3', instances: [{}], patientName: 'A' }],
      ['1.2.4', { studyInstanceUid: '1.2.4', instances: [{}], patientName: 'B' }],
    ]),
  };
  const err = throwsUsage(() => perform.assertOneStudy(scanned, './x', ''));
  assert.ok(err.message.includes('exactly one'));
});

test('an empty folder is refused before anything is opened', () => {
  assert.throws(
    () => perform.assertOneStudy({ filesExamined: 3, studies: new Map() }, './x', ''),
    UsageError
  );
});

test('--study-uid disagreeing with the folder is refused', () => {
  const scanned = { studies: new Map([['1.2.3', { studyInstanceUid: '1.2.3', instances: [{}] }]]) };
  const err = throwsUsage(() => perform.assertOneStudy(scanned, './x', '1.2.9'));
  assert.ok(err.message.includes('never reconcile'));
});

test('the folder fills blank attributes and never overwrites given ones', () => {
  const study = {
    studyInstanceUid: '1.2.3',
    modalities: new Set(['CT']),
    patientId: 'FROM-DISK',
    patientName: 'DISK^PATIENT',
    accessionNumber: 'ACC-DISK',
  };

  const blank = { studyInstanceUid: '', modality: '', patientId: '', patientName: '', accessionNumber: '' };
  perform.adoptFromScan(blank, study);
  assert.equal(blank.studyInstanceUid, '1.2.3');
  assert.equal(blank.modality, 'CT');
  assert.equal(blank.patientId, 'FROM-DISK');

  const given = {
    studyInstanceUid: '1.2.3', modality: 'MR',
    patientId: 'FROM-WORKLIST', patientName: 'WL^PATIENT', accessionNumber: 'ACC-WL',
  };
  perform.adoptFromScan(given, study);
  assert.equal(given.modality, 'MR', 'the order is authoritative, the images are only evidence');
  assert.equal(given.patientId, 'FROM-WORKLIST');
  assert.equal(given.accessionNumber, 'ACC-WL');
});

test('a mixed-modality folder cannot supply the Type 1 Modality', () => {
  const study = { studyInstanceUid: '1.2.3', modalities: new Set(['CT', 'MR']) };
  assert.throws(() => perform.adoptFromScan({ studyInstanceUid: '1.2.3', modality: '' }, study), UsageError);
});

// --- N-service result interpretation ---------------------------------------

test('a refused MPPS presentation context is reported as unsupported, not as a timeout', () => {
  const verdict = common.describeNResult(
    { outcome: { kind: 'completed' }, status: undefined, contextAccepted: false },
    'N-CREATE'
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-mpps-context');
  assert.ok(verdict.lines.join(' ').includes('does not support MPPS'));
  assert.ok(verdict.lines.join(' ').includes(mpps.MPPS_SOP_CLASS));
});

test('the MPPS presentation context is looked for by abstract syntax and result', () => {
  // A peer can accept the association and refuse this one context, and then no
  // response ever arrives. Getting this check wrong turns a two-second answer
  // into a sixty-second timeout that reads like a network fault.
  const { constants } = require('dcmjs-dimse');
  const ctx = (uid, result) => ({
    context: { getAbstractSyntaxUid: () => uid, getResult: () => result },
  });

  const accepted = {
    getPresentationContexts: () => [
      ctx('1.2.840.10008.1.1', constants.PresentationContextResult.Accept),
      ctx(mpps.MPPS_SOP_CLASS, constants.PresentationContextResult.Accept),
    ],
  };
  assert.equal(mpps.mppsContextAccepted(accepted), true);

  const refused = {
    getPresentationContexts: () => [
      ctx('1.2.840.10008.1.1', constants.PresentationContextResult.Accept),
      ctx(mpps.MPPS_SOP_CLASS, constants.PresentationContextResult.RejectAbstractSyntaxNotSupported),
    ],
  };
  assert.equal(mpps.mppsContextAccepted(refused), false);

  const absent = { getPresentationContexts: () => [ctx('1.2.840.10008.1.1', constants.PresentationContextResult.Accept)] };
  assert.equal(mpps.mppsContextAccepted(absent), false);

  // Not every stack populates the contexts before the first response. Absence
  // of evidence is not evidence of refusal, so a throwing association must not
  // be reported as an unsupported peer.
  const opaque = { getPresentationContexts: () => { throw new Error('not yet'); } };
  assert.equal(mpps.mppsContextAccepted(opaque), true);
});

test('an accepted context with no response is told apart from a refused one', () => {
  const verdict = common.describeNResult(
    { outcome: { kind: 'completed' }, status: undefined, contextAccepted: true },
    'N-SET'
  );
  assert.equal(verdict.reason, 'no-response');
  assert.ok(verdict.lines.join(' ').includes('never answered'));
});

test('a failed association is reported as an association failure', () => {
  const verdict = common.describeNResult(
    { outcome: { kind: 'rejection', label: 'Rejected', headline: 'no', raw: 'x' }, contextAccepted: true },
    'N-CREATE'
  );
  assert.equal(verdict.reason, 'association');
  assert.ok(verdict.lines.length > 0);
});

test('status 0x0000 is the only success', () => {
  const ok = common.describeNResult(
    { outcome: { kind: 'completed' }, status: 0x0000, contextAccepted: true }, 'N-CREATE'
  );
  assert.equal(ok.ok, true);

  for (const status of [0x0111, 0x0110, 0x0124, 0xa700, 0xb000]) {
    const bad = common.describeNResult(
      { outcome: { kind: 'completed' }, status, contextAccepted: true }, 'N-CREATE'
    );
    assert.equal(bad.ok, false, `${status.toString(16)} must not read as success`);
    assert.ok(bad.lines.length > 0, 'and must explain itself');
  }
});

test('the N-service status codes an MPPS SCP actually returns are translated', () => {
  const statusLib = require('../../src/lib/status');
  for (const code of [0x0112, 0x0110, 0x0111, 0x0124]) {
    const d = statusLib.describe(code);
    assert.ok(d.label && !d.label.startsWith('Unrecognised'), `${code.toString(16)} needs a translation`);
  }
});

// --- dispatcher ------------------------------------------------------------

test('the dispatcher routes exactly the four verbs', () => {
  assert.deepEqual(Object.keys(dispatcher.VERBS), ['start', 'complete', 'discontinue', 'perform']);
  for (const load of Object.values(dispatcher.VERBS)) {
    const mod = load();
    assert.equal(typeof mod.run, 'function');
    assert.equal(typeof mod.USAGE, 'string');
    assert.ok(mod.USAGE.length > 0);
    assert.ok(!/^\s/.test(mod.USAGE), 'USAGE is trimStart()ed, like every other command');
  }
});

test('an unknown verb names the ones that exist', async () => {
  await assert.rejects(
    () => dispatcher.run(tokenize(['finish'])),
    (err) => {
      assert.equal(err.name, 'UsageError');
      assert.ok(err.message.includes("'finish'"));
      for (const verb of Object.keys(dispatcher.VERBS)) {
        assert.ok(err.message.includes(verb), `the refusal must offer ${verb}`);
      }
      return true;
    }
  );

  await assert.rejects(() => dispatcher.run(tokenize([])), UsageError);
});

test('--help works at the dispatcher and at every verb', async () => {
  const log = require('../../src/lib/log');

  const sink = log.beginCapture();
  try {
    assert.equal(await dispatcher.run(tokenize(['--help'])), 0);
    for (const verb of Object.keys(dispatcher.VERBS)) {
      assert.equal(await dispatcher.run(tokenize([verb, '--help'])), 0);
    }
  } finally {
    log.endCapture();
  }

  assert.ok(sink.out.includes('dcm mpps'));
  assert.ok(sink.err === '', 'help is the product of the command, so it goes to stdout');
});

test('a mistyped flag is refused rather than ignored', async () => {
  // --dryrun instead of --dry-run would otherwise open a real step.
  await assert.rejects(
    () => dispatcher.run(tokenize(['start', '--dryrun', '--study-uid', '1.2.3'])),
    UsageError
  );
});

test('mpps start takes no positional argument', async () => {
  await assert.rejects(
    () => dispatcher.run(tokenize(['start', '2.25.1', '--dry-run'])),
    UsageError
  );
});

test('a reason belongs to a discontinued step, not a completed one', async () => {
  await assert.rejects(
    () => dispatcher.run(tokenize(['complete', '2.25.1', '--reason', 'x', '--dry-run'])),
    UsageError
  );
});

// --- output contract -------------------------------------------------------

test('--json emits exactly one JSON document on stdout', async () => {
  const log = require('../../src/lib/log');

  const sink = log.beginCapture();
  let code;
  try {
    code = await dispatcher.run(tokenize([
      'start', '--dry-run', '--json',
      '--study-uid', '1.2.826.0.1.3680043.10.1337.1',
      '--modality', 'CT', '--step-id', 'S1',
    ]));
  } finally {
    log.endCapture();
  }

  assert.equal(code, 0);
  const parsed = JSON.parse(sink.out);
  assert.equal(parsed.dryRun, true);
  assert.ok(parsed.mppsSopInstanceUid.startsWith('2.25.'));
  assert.equal(parsed.sopClassUid, mpps.MPPS_SOP_CLASS);
  assert.equal(parsed.dataset.PerformedProcedureStepStatus, mpps.Status.IN_PROGRESS);
});

test('the MPPS SOP Class UID is the one from the library, not a literal', () => {
  const { constants } = require('dcmjs-dimse');
  assert.equal(mpps.MPPS_SOP_CLASS, constants.SopClass.ModalityPerformedProcedureStep);
  assert.equal(mpps.MPPS_SOP_CLASS, '1.2.840.10008.3.1.2.3.3');
});
