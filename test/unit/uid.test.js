'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deterministicUid, validateUid, rewrittenSeriesUid, MAX_UID_LENGTH } = require('../../src/lib/uid');

test('generated UIDs are valid DICOM UIDs', () => {
  const uid = deterministicUid('anything');
  assert.match(uid, /^2\.25\.\d+$/);
  assert.ok(uid.length <= MAX_UID_LENGTH, `${uid.length} <= ${MAX_UID_LENGTH}`);
  assert.equal(validateUid(uid).valid, true);
});

test('the same input always produces the same UID', () => {
  // A re-send has to map onto the same series, or a retry silently creates a
  // second copy of the series on the receiver.
  const a = rewrittenSeriesUid('1.2.840.1', '1.2.840.1.1');
  const b = rewrittenSeriesUid('1.2.840.1', '1.2.840.1.1');
  assert.equal(a, b);
});

test('different inputs produce different UIDs', () => {
  const a = rewrittenSeriesUid('1.2.840.1', '1.2.840.1.1');
  const b = rewrittenSeriesUid('1.2.840.1', '1.2.840.1.2');
  assert.notEqual(a, b);
});

test('the same series UID under different studies maps to different UIDs', () => {
  // This is the collision the rewrite exists to repair. Keying on the series
  // UID alone would preserve the collision instead of breaking it.
  const inStudyA = rewrittenSeriesUid('1.2.840.1', '1.2.840.9.9');
  const inStudyB = rewrittenSeriesUid('1.2.840.2', '1.2.840.9.9');
  assert.notEqual(inStudyA, inStudyB, 'colliding source series UIDs must be separated');
});

test('inputs cannot collide by concatenation', () => {
  // ('ab', 'c') and ('a', 'bc') must not hash to the same value.
  assert.notEqual(deterministicUid('ab', 'c'), deterministicUid('a', 'bc'));
});

test('validateUid rejects what receivers reject', () => {
  assert.equal(validateUid('1.2.840.10008.1.2.1').valid, true);
  assert.equal(validateUid('0').valid, true, 'a single zero component is legal');

  assert.equal(validateUid('').valid, false);
  assert.equal(validateUid('1.2.abc').valid, false);
  assert.equal(validateUid('1.2..3').valid, false);
  assert.equal(validateUid('1.02.3').valid, false, 'leading zeros are not permitted');
  assert.equal(validateUid('1'.repeat(65)).valid, false, 'over 64 characters');

  assert.match(validateUid('1.2.abc').reason, /digits and dots/);
  assert.match(validateUid('1'.repeat(65)).reason, /longer than 64/);
});
