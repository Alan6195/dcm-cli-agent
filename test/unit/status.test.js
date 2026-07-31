'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const status = require('../../src/lib/status');

test('classifies the three bands the CLI reports on', () => {
  assert.equal(status.classify(0x0000), status.Class.SUCCESS);

  // The whole 0xB000-0xBFFF range is a warning, not a success.
  for (const code of [0xb000, 0xb006, 0xb007, 0xb123, 0xbfff]) {
    assert.equal(status.classify(code), status.Class.WARNING, `0x${code.toString(16)}`);
  }

  // Everything else is a failure.
  for (const code of [0x0110, 0x0122, 0xa700, 0xa900, 0xc000, 0x1234]) {
    assert.equal(status.classify(code), status.Class.FAILURE, `0x${code.toString(16)}`);
  }

  assert.equal(status.classify(0xff00), status.Class.PENDING);
  assert.equal(status.classify(0xff01), status.Class.PENDING);
  assert.equal(status.classify(0xfe00), status.Class.CANCEL);
});

test('formats codes as four-digit hex', () => {
  assert.equal(status.formatCode(0x0000), '0x0000');
  assert.equal(status.formatCode(0xa700), '0xA700');
  assert.equal(status.formatCode(0xb000), '0xB000');
});

test('translates range-matched codes rather than falling through', () => {
  // The low byte varies, so these must be matched by range, not exact value.
  for (const code of [0xa700, 0xa701, 0xa7ff]) {
    const d = status.describe(code);
    assert.match(d.label, /out of resources/i);
    assert.equal(d.class, status.Class.FAILURE);
    assert.ok(d.hint, 'an out-of-resources refusal should suggest what to do');
  }

  for (const code of [0xc000, 0xc123, 0xcfff]) {
    assert.match(status.describe(code).label, /cannot understand/i);
  }

  for (const code of [0xa900, 0xa9ff]) {
    assert.match(status.describe(code).label, /does not match SOP Class/i);
  }
});

test('gives plain English for the codes people actually hit', () => {
  assert.match(status.describe(0x0000).plain, /acknowledged/i);
  assert.match(status.describe(0xb000).plain, /rewrote/i);
  assert.match(status.describe(0x0122).plain, /does not accept this type/i);
  assert.match(status.describe(0x0111).plain, /already holds/i);
  assert.match(status.describe(0x0124).plain, /authorisation/i);
});

test('an unknown code is reported honestly rather than guessed at', () => {
  const d = status.describe(0x1234);
  assert.equal(d.class, status.Class.FAILURE);
  assert.match(d.plain, /not a code this tool has a translation for/i);
  assert.match(d.code, /0x1234/i);
});

test('carries the peer error comment through', () => {
  const d = status.describe(0x0110, 'disk full on node 3');
  assert.equal(d.peerComment, 'disk full on node 3');
  assert.match(status.summarize(0x0110, 'disk full on node 3'), /disk full on node 3/);
});
