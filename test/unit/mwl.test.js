'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const find = require('../../src/commands/find');

/**
 * Modality Worklist query shape.
 *
 * The single most common way an MWL query fails is being built flat. Modality,
 * the scheduled station and the scheduled start date/time are not top-level
 * attributes — they live inside ScheduledProcedureStepSequence (0040,0100). A
 * lenient SCP answers a flat query anyway; a conformant one returns nothing,
 * which reads as "the worklist is empty" rather than "your query was wrong".
 * These tests pin the correct shape so that cannot regress.
 */

test('a worklist query nests scheduled-step keys in the sequence', () => {
  const id = find.buildIdentifier('mwl', []);
  const sps = id.ScheduledProcedureStepSequence;

  assert.ok(Array.isArray(sps), 'ScheduledProcedureStepSequence must be a sequence');
  assert.equal(sps.length, 1, 'one item, used as the matching template');

  for (const key of ['Modality', 'ScheduledStationAETitle', 'ScheduledProcedureStepStartDate']) {
    assert.ok(key in sps[0], `${key} must be requested inside the sequence`);
    assert.equal(sps[0][key], '', 'requested but not matched on when no value is given');
    assert.ok(!(key in id), `${key} must NOT be a top-level attribute`);
  }
});

test('scheduled-step matching keys are routed into the sequence', () => {
  const id = find.buildIdentifier('mwl', [
    ['Modality', 'CT'],
    ['ScheduledProcedureStepStartDate', '20260819'],
  ]);

  assert.equal(id.ScheduledProcedureStepSequence[0].Modality, 'CT');
  assert.equal(id.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate, '20260819');
  assert.ok(!('Modality' in id), 'must not also be sent flat');
});

test('patient-level matching keys stay at the top level', () => {
  const id = find.buildIdentifier('mwl', [['PatientID', '12345'], ['AccessionNumber', 'ACC1']]);

  assert.equal(id.PatientID, '12345');
  assert.equal(id.AccessionNumber, 'ACC1');
  assert.ok(!('PatientID' in id.ScheduledProcedureStepSequence[0]));
});

test('other query levels are unaffected by the worklist handling', () => {
  const study = find.buildIdentifier('study', [['PatientID', '12345']]);
  assert.equal(study.PatientID, '12345');
  assert.ok(!('ScheduledProcedureStepSequence' in study));
});

test('worklist results are flattened for reading', () => {
  const flat = find.flattenWorklistMatch({
    PatientID: '12345',
    ScheduledProcedureStepSequence: [
      { Modality: 'CT', ScheduledStationAETitle: 'CT01', ScheduledProcedureStepStartTime: '0930' },
    ],
  });

  assert.equal(flat.Modality, 'CT');
  assert.equal(flat.ScheduledStationAETitle, 'CT01');
  assert.equal(flat.PatientID, '12345', 'top-level values survive');
  assert.ok(!('ScheduledProcedureStepSequence' in flat), 'the sequence itself is not left behind');
});

test('flattening never overwrites a populated top-level value', () => {
  const flat = find.flattenWorklistMatch({
    Modality: 'MR',
    ScheduledProcedureStepSequence: [{ Modality: 'CT' }],
  });
  assert.equal(flat.Modality, 'MR');
});

test('extra scheduled steps are reported rather than dropped', () => {
  const flat = find.flattenWorklistMatch({
    ScheduledProcedureStepSequence: [{ Modality: 'CT' }, { Modality: 'MR' }],
  });
  assert.equal(flat.Modality, 'CT');
  assert.equal(flat.AdditionalScheduledSteps, '1');
});

test('a match with no sequence passes through untouched', () => {
  const input = { PatientID: '12345' };
  assert.deepEqual(find.flattenWorklistMatch(input), input);
});
