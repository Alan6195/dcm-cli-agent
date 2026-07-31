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
  const inStudyA = rewrittenSeriesUid('1.2.840.1', '1.2.840.9.9', 1);
  const inStudyB = rewrittenSeriesUid('1.2.840.2', '1.2.840.9.9', 1);
  assert.notEqual(inStudyA, inStudyB);
});

test('two distinct series sharing one source UID are separated', () => {
  // The collision this option exists to repair. Both series carry the same
  // Series Instance UID, so the discriminator — Series Number — is the only
  // thing left that distinguishes them. Keying on study + series UID alone
  // maps both onto one replacement and reproduces the merge in new UIDs.
  const seriesOne = rewrittenSeriesUid('1.2.840.1', '1.2.840.9.9', 1);
  const seriesTwo = rewrittenSeriesUid('1.2.840.1', '1.2.840.9.9', 2);

  assert.notEqual(seriesOne, seriesTwo, 'colliding source series must not merge again');
  assert.match(seriesOne, /^2\.25\./);
  assert.match(seriesTwo, /^2\.25\./);
});

test('a well-formed series still maps to exactly one replacement', () => {
  // Every instance in one real series shares a UID and a Series Number, so the
  // rewrite must be a no-op for correct data — otherwise it would split series
  // that were never broken.
  const first = rewrittenSeriesUid('1.2.840.1', '1.2.840.1.7', 7);
  const second = rewrittenSeriesUid('1.2.840.1', '1.2.840.1.7', 7);
  assert.equal(first, second);
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
