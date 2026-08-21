'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dcmjs = require('dcmjs');
const dcmjsDimse = require('dcmjs-dimse');

const vr = require('../../src/lib/vr');

const { DicomMessage, DicomMetaDictionary, WriteBufferStream } = dcmjs.data;

dcmjs.log.level = 'error';

const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const IMPLICIT_LE = '1.2.840.10008.1.2';

/**
 * What this file is defending.
 *
 * A DICOM parser repairs as it reads, and every repair it makes is a
 * conformance violation the person testing the sender can no longer see. The
 * customer case behind all of this: a server sent PatientWeight as "12.5 kg",
 * the DS parse read 12.5 and threw the unit away, and the test that was meant
 * to catch it passed. So the tests below are almost all of the same shape —
 * put something non-conformant on the wire, and assert that it is still
 * non-conformant when it comes back out.
 */

// ---------------------------------------------------------------------------
// Building octets to read back
// ---------------------------------------------------------------------------

/** Encodes a denaturalized dict the way a peer would, and returns the octets. */
function encode(dict, transferSyntaxUid = EXPLICIT_LE) {
  const stream = new WriteBufferStream();
  DicomMessage.write(dict, stream, transferSyntaxUid, {});
  return Buffer.from(stream.getBuffer());
}

/**
 * Encodes one element by hand, in Explicit VR Little Endian.
 *
 * A conformant encoder pads an odd-length value to the next even octet, which
 * makes the odd-length rule untestable through one. This writes exactly the
 * octets given, which is the only way to rehearse a peer that gets it wrong.
 */
function handEncode(tag, vrCode, text) {
  const value = Buffer.from(text, 'latin1');
  const out = Buffer.alloc(8 + value.length);
  out.writeUInt16LE(parseInt(tag.slice(1, 5), 16), 0);
  out.writeUInt16LE(parseInt(tag.slice(6, 10), 16), 2);
  out.write(vrCode, 4, 'latin1');
  out.writeUInt16LE(value.length, 6);
  value.copy(out, 8);
  return out;
}

/** Parses octets and fails the test rather than returning an error result. */
function parse(bytes, transferSyntaxUid = EXPLICIT_LE) {
  const result = vr.parseElements(bytes, transferSyntaxUid);
  assert.ok(result.ok, `parse failed: ${result.reason}`);
  return result.entries;
}

// ---------------------------------------------------------------------------
// The values survive
// ---------------------------------------------------------------------------

test('a Decimal String with a unit survives byte for byte', () => {
  // The reported failure, at its smallest. dcmjs reads this DS as the number
  // 12.5; the " kg" that made it non-conformant is what has to survive.
  const bytes = encode({ '00101030': { vr: 'DS', Value: ['12.5 kg'] } });

  const naturalized = DicomMetaDictionary.naturalizeDataset(
    DicomMessage._read(
      new dcmjs.data.ReadBufferStream(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      EXPLICIT_LE,
      { ignoreErrors: true }
    )
  );
  assert.equal(naturalized.PatientWeight, 12.5, 'this is what a normal parse does with it');

  const values = vr.valuesOf(parse(bytes));
  assert.equal(values.PatientWeight, '12.5 kg', 'and this is what was actually sent');
  assert.equal(typeof values.PatientWeight, 'string', 'never a parsed number');
});

test('a 72-character Long String survives at full length', () => {
  const long = 'X'.repeat(72);
  const values = vr.valuesOf(parse(encode({ '00321060': { vr: 'LO', Value: [long] } })));

  assert.equal(values.RequestedProcedureDescription, long);
  assert.equal(values.RequestedProcedureDescription.length, 72, 'not truncated to the LO maximum');
});

test('an Integer String with a stray character survives as text', () => {
  const values = vr.valuesOf(parse(encode({ '00201208': { vr: 'IS', Value: ['12a'] } })));
  assert.equal(values.NumberOfStudyRelatedInstances, '12a', 'not the 12 an IS parse reads');
});

test('the padding octet is removed from the value but counted in the length', () => {
  // "12.5 kg" is seven octets, so the encoder pads it to eight. The value a
  // consumer reads should not carry the pad; the length reported must, because
  // the length is the Value Length field that was on the wire.
  const entries = parse(encode({ '00101030': { vr: 'DS', Value: ['12.5 kg'] } }));
  const sidecar = vr.sidecarOf(entries);

  assert.equal(sidecar['(0010,1030)'].value, '12.5 kg');
  assert.equal(sidecar['(0010,1030)'].length, 8);
});

test('Person Names stay objects and sequences stay arrays', () => {
  // The existing --json-raw contract, which `dcm mpps --from-worklist` reads.
  const entries = parse(encode({
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] },
    '00400100': { vr: 'SQ', Value: [{ '00080060': { vr: 'CS', Value: ['CT'] } }] },
    '00081110': { vr: 'SQ', Value: [] },
  }));
  const values = vr.valuesOf(entries);

  assert.deepEqual(values.PatientName, [{ Alphabetic: 'DOE^JANE' }]);
  assert.deepEqual(values.ScheduledProcedureStepSequence, [{ Modality: 'CT' }]);
  assert.deepEqual(values.ReferencedStudySequence, [], 'an empty sequence is not an absent one');
});

test('a Person Name keeps its ideographic and phonetic component groups', () => {
  const entries = parse(handEncode('(0010,0010)', 'PN', 'Yamada^Tarou=YAMADA^TAROU=yamada^tarou'));
  assert.deepEqual(vr.valuesOf(entries).PatientName, [{
    Alphabetic: 'Yamada^Tarou',
    Ideographic: 'YAMADA^TAROU',
    Phonetic: 'yamada^tarou',
  }]);
});

// ---------------------------------------------------------------------------
// The sidecar
// ---------------------------------------------------------------------------

test('the sidecar reports the VR and the received length for every element', () => {
  const entries = parse(encode({
    '00100040': { vr: 'CS', Value: ['male'] },
    '00321060': { vr: 'LO', Value: ['X'.repeat(72)] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] },
  }));
  const sidecar = vr.sidecarOf(entries);

  assert.deepEqual(sidecar['(0010,0040)'], {
    vr: 'CS', length: 4, keyword: 'PatientSex', vm: 1, value: 'male',
  });
  assert.deepEqual(sidecar['(0032,1060)'], {
    vr: 'LO', length: 72, keyword: 'RequestedProcedureDescription', vm: 1, value: 'X'.repeat(72),
  });
  assert.equal(sidecar['(0010,0010)'].vr, 'PN');
  assert.equal(sidecar['(0010,0010)'].length, 8);
});

test('the sidecar nests one entry map per sequence item', () => {
  const entries = parse(encode({
    '00400100': {
      vr: 'SQ',
      Value: [
        { '00080060': { vr: 'CS', Value: ['CT'] } },
        { '00080060': { vr: 'CS', Value: ['MR'] } },
      ],
    },
  }));
  const sidecar = vr.sidecarOf(entries);

  assert.equal(sidecar['(0040,0100)'].vr, 'SQ');
  assert.equal(sidecar['(0040,0100)'].items.length, 2);
  assert.equal(sidecar['(0040,0100)'].items[1]['(0008,0060)'].value, 'MR');
});

test('the sidecar records a VM above one', () => {
  const entries = parse(handEncode('(0008,0061)', 'CS', 'CT\\MR '));
  const sidecar = vr.sidecarOf(entries);

  assert.equal(sidecar['(0008,0061)'].vm, 2);
  assert.equal(sidecar['(0008,0061)'].value, 'CT\\MR');
  assert.equal(sidecar['(0008,0061)'].length, 6, 'the length is the whole value field');
});

test('an inferred VR is marked as inferred, an explicit one is not', () => {
  // Under Implicit VR the peer sends no VR, so every length and grammar check
  // is derived from our dictionary rather than from what the peer said. That
  // has to be visible or the report overstates what it knows.
  const dict = { '00100040': { vr: 'CS', Value: ['M '] } };

  assert.equal(vr.sidecarOf(parse(encode(dict), EXPLICIT_LE))['(0010,0040)'].vrSource, undefined);
  assert.equal(
    vr.sidecarOf(parse(encode(dict, IMPLICIT_LE), IMPLICIT_LE))['(0010,0040)'].vrSource,
    'dictionary'
  );
});

test('lifting a sequence into the sidecar marks where each entry came from', () => {
  const entries = parse(encode({
    '00100020': { vr: 'LO', Value: ['12345'] },
    '00400100': { vr: 'SQ', Value: [{ '00080060': { vr: 'CS', Value: ['CT'] } }] },
  }));
  const lifted = vr.liftSequenceEntries(vr.sidecarOf(entries), 'ScheduledProcedureStepSequence');

  assert.equal(lifted['(0008,0060)'].value, 'CT');
  assert.equal(lifted['(0008,0060)'].from, 'ScheduledProcedureStepSequence');
  assert.equal(lifted['(0010,0020)'].from, undefined, 'a top-level entry is not marked');
  assert.ok(!('(0040,0100)' in lifted), 'the sequence entry itself is not left behind');
});

test('lifting never overwrites a top-level entry with a nested one', () => {
  const entries = parse(encode({
    '00080060': { vr: 'CS', Value: ['MR'] },
    '00400100': { vr: 'SQ', Value: [{ '00080060': { vr: 'CS', Value: ['CT'] } }] },
  }));
  const lifted = vr.liftSequenceEntries(vr.sidecarOf(entries), 'ScheduledProcedureStepSequence');

  assert.equal(lifted['(0008,0060)'].value, 'MR');
  assert.equal(lifted['(0008,0060)'].from, undefined);
});

// ---------------------------------------------------------------------------
// Reading the octets
// ---------------------------------------------------------------------------

test('an undefined-length sequence is read, and reading continues past it', () => {
  // dcmjs writes sequences with undefined length, so this is the ordinary
  // case rather than the exotic one.
  const entries = parse(encode({
    '00100020': { vr: 'LO', Value: ['12345'] },
    '00400100': { vr: 'SQ', Value: [{ '00080060': { vr: 'CS', Value: ['CT'] } }] },
    '00401001': { vr: 'SH', Value: ['RP1'] },
  }));

  // RequestedProcedureID sits after the sequence in tag order, so its presence
  // is the proof that reading resumed correctly past the delimitation item.
  assert.deepEqual(
    entries.map((e) => e.keyword),
    ['PatientID', 'ScheduledProcedureStepSequence', 'RequestedProcedureID']
  );

  const sequence = entries[1];
  assert.equal(sequence.length, null, 'an undefined length is reported as null, not as 4294967295');
  assert.equal(sequence.items[0][0].value, 'CT');
});

test('Implicit and Explicit VR produce the same values', () => {
  const dict = {
    '00100040': { vr: 'CS', Value: ['male'] },
    '00101030': { vr: 'DS', Value: ['12.5 kg'] },
    '00400100': { vr: 'SQ', Value: [{ '00080060': { vr: 'CS', Value: ['ct'] } }] },
  };

  assert.deepEqual(
    vr.valuesOf(parse(encode(dict, IMPLICIT_LE), IMPLICIT_LE)),
    vr.valuesOf(parse(encode(dict, EXPLICIT_LE), EXPLICIT_LE))
  );
});

test('an element with no dictionary entry is kept under its tag, not dropped', () => {
  // Losing an element because we have no name for it would be the same silence
  // this module exists to end.
  const entries = parse(handEncode('(0009,0010)', 'LO', 'ACME_PRIVATE'));

  assert.equal(entries[0].keyword, undefined);
  assert.equal(vr.valuesOf(entries)['(0009,0010)'], 'ACME_PRIVATE');
});

test('unreadable octets are reported as a reason, never thrown', () => {
  // A conformance report that cannot tell "clean" from "not examined" is the
  // false pass this module exists to stop, so the failure has to be a value
  // the caller can act on.
  const truncated = encode({ '00100020': { vr: 'LO', Value: ['12345'] } }).subarray(0, 10);
  const result = vr.parseElements(truncated, EXPLICIT_LE);

  assert.equal(result.ok, false);
  assert.match(result.reason, /octets/);
});

test('Explicit VR Big Endian is refused rather than misread', () => {
  const result = vr.parseElements(Buffer.alloc(16), '1.2.840.10008.1.2.2');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Big Endian/);
});

// ---------------------------------------------------------------------------
// Capturing what a Dataset was built from
// ---------------------------------------------------------------------------

test('the received octets are recoverable from a Dataset', () => {
  // This is the join between the library and this module: dcmjs-dimse builds a
  // Dataset from the PDV payload and naturalizes it immediately, so the octets
  // have to be taken on the way past or they are gone.
  vr.installRawCapture();

  const bytes = encode({ '00101030': { vr: 'DS', Value: ['12.5 kg'] } });
  const dataset = new dcmjsDimse.Dataset(bytes, EXPLICIT_LE);

  assert.equal(dataset.getElements().PatientWeight, 12.5, 'the library still parses as it always did');

  const parsed = vr.parseDataset(dataset);
  assert.ok(parsed.ok, parsed.reason);
  assert.equal(vr.valuesOf(parsed.entries).PatientWeight, '12.5 kg');
});

test('installing the capture twice is harmless', () => {
  vr.installRawCapture();
  vr.installRawCapture();

  const bytes = encode({ '00100020': { vr: 'LO', Value: ['12345'] } });
  const dataset = new dcmjsDimse.Dataset(bytes, EXPLICIT_LE);

  assert.equal(vr.rawBytesOf(dataset).length, bytes.length, 'not wrapped twice');
  assert.equal(dataset.getElements().PatientID, '12345');
});

test('a Dataset built from elements rather than octets reports that plainly', () => {
  const parsed = vr.parseDataset(new dcmjsDimse.Dataset({ PatientID: '12345' }, EXPLICIT_LE));
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /not captured/);
});

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Runs the checker over encoded octets and returns the violation kinds. */
function kinds(entries) {
  return vr.checkEntries(entries).map((v) => v.kind);
}

test('an over-long value names the length and the maximum', () => {
  const [violation] = vr.checkEntries(parse(encode({
    '00321060': { vr: 'LO', Value: ['X'.repeat(72)] },
  })));

  assert.equal(violation.kind, 'over-length');
  assert.equal(violation.length, 72);
  assert.equal(violation.max, 64);
  assert.match(violation.message, /72 characters, LO permits 64/);
});

test('a Person Name is measured per component group, not end to end', () => {
  // 74 characters over three groups, none of them over 64: legal.
  const legal = handEncode('(0010,0010)', 'PN', `${'A'.repeat(24)}=${'B'.repeat(24)}=${'C'.repeat(24)}`);
  assert.deepEqual(kinds(parse(legal)), []);

  const illegal = handEncode('(0010,0010)', 'PN', 'A'.repeat(70));
  assert.deepEqual(kinds(parse(illegal)), ['over-length']);
});

test('an odd-length value field is a violation for any VR', () => {
  const entries = parse(handEncode('(0018,0015)', 'CS', 'CHEST'));
  const [violation] = vr.checkEntries(entries);

  assert.equal(violation.kind, 'odd-length');
  assert.equal(violation.length, 5);
});

test('a backslash against a VM-1 attribute is reported as an unintended second value', () => {
  const entries = parse(handEncode('(0032,1060)', 'LO', 'CHEST\\ABDOMEN '));
  const [violation] = vr.checkEntries(entries);

  assert.equal(violation.kind, 'unexpected-vm');
  assert.equal(violation.vm, 2);
});

test('a backslash in a Long Text is ordinary text, not a second value', () => {
  // LT, ST, UT and UR are single-valued, so the backslash is not a separator
  // in them. Reporting it would be a false positive on conformant data.
  assert.deepEqual(kinds(parse(handEncode('(0020,4000)', 'LT', 'A\\B'))), ['odd-length']);
});

test('a Decimal String carrying a unit is reported, a plain one is not', () => {
  assert.deepEqual(kinds(parse(encode({ '00101030': { vr: 'DS', Value: ['12.5 kg'] } }))), ['numeric-invalid']);
  assert.deepEqual(kinds(parse(encode({ '00101030': { vr: 'DS', Value: ['12.5'] } }))), []);
  assert.deepEqual(kinds(parse(encode({ '00101030': { vr: 'DS', Value: ['-1.25e-3'] } }))), [],
    'exponential notation is legal DS');
});

test('an Integer String is an integer and nothing else', () => {
  assert.deepEqual(kinds(parse(encode({ '00201208': { vr: 'IS', Value: ['12a'] } }))), ['numeric-invalid']);
  assert.deepEqual(kinds(parse(encode({ '00201208': { vr: 'IS', Value: ['-12'] } }))), []);
  assert.deepEqual(kinds(parse(encode({ '00201208': { vr: 'IS', Value: ['1.5'] } }))), ['numeric-invalid'],
    'a decimal point is not an integer');
});

test('an enumerated Code String is checked for membership, a defined term is not', () => {
  // PatientSex is enumerated: M, F, O and nothing else.
  assert.deepEqual(kinds(parse(encode({ '00100040': { vr: 'CS', Value: ['MALE'] } }))), ['cs-not-enumerated']);
  assert.deepEqual(kinds(parse(encode({ '00100040': { vr: 'CS', Value: ['F'] } }))), []);

  // Modality is a defined-term list, which is open. A site may send something
  // this table has never heard of and still be conformant.
  assert.deepEqual(kinds(parse(encode({ '00080060': { vr: 'CS', Value: ['XYZ'] } }))), []);
});

test('case is reported on its own only when case is the only thing wrong', () => {
  // "ct" upper-cases to a listed Modality, so the case is the whole problem.
  const lower = vr.checkEntries(parse(encode({ '00080060': { vr: 'CS', Value: ['ct'] } })));
  assert.deepEqual(lower.map((v) => v.kind), ['cs-lowercase']);
  assert.match(lower[0].message, /the correct spelling is "CT"/);

  // "male" upper-cases to something that is still not M, F or O, so reporting
  // the case as well would be two findings for one mistake.
  const enumerated = vr.checkEntries(parse(encode({ '00100040': { vr: 'CS', Value: ['male'] } })));
  assert.deepEqual(enumerated.map((v) => v.kind), ['cs-not-enumerated']);
});

test('a present-and-empty value is not a violation', () => {
  // Type 2 attributes and universal matching keys are empty on purpose, and a
  // C-FIND identifier is full of them.
  const entries = parse(encode({
    '00100040': { vr: 'CS', Value: [''] },
    '00101030': { vr: 'DS', Value: [''] },
    '00321060': { vr: 'LO', Value: [''] },
  }));
  assert.deepEqual(kinds(entries), []);
});

test('violations inside a sequence carry the path to them', () => {
  const entries = parse(encode({
    '00400100': { vr: 'SQ', Value: [{ '00080060': { vr: 'CS', Value: ['ct'] } }] },
  }));
  const [violation] = vr.checkEntries(entries);

  assert.deepEqual(violation.path, ['ScheduledProcedureStepSequence']);
  assert.match(vr.formatViolation(violation), /Modality in ScheduledProcedureStepSequence/);
});

test('a violation line names the tag, the keyword and the VR', () => {
  const [violation] = vr.checkEntries(parse(encode({
    '00321060': { vr: 'LO', Value: ['X'.repeat(72)] },
  })));

  const line = vr.formatViolation(violation);
  assert.match(line, /\(0032,1060\)/);
  assert.match(line, /RequestedProcedureDescription/);
  assert.match(line, /\bLO\b/);
});

// ---------------------------------------------------------------------------
// The named torture fixtures
// ---------------------------------------------------------------------------

test('every torture fixture trips exactly the violation it is named for', () => {
  // The whole point of the fixture set. A fixture that trips two checks cannot
  // tell you which of the two the server under test actually handles, so the
  // test it feeds proves less than it looks like it proves.
  for (const fixture of vr.TORTURE_FIXTURES) {
    const found = vr.checkFixture(fixture.name);
    assert.deepEqual(
      found.map((v) => v.kind),
      [fixture.expect],
      `vr-torture: ${fixture.name} should trip ${fixture.expect} and nothing else`
    );
  }
});

test('every torture fixture is named, resolvable and self-describing', () => {
  const names = new Set();
  for (const fixture of vr.TORTURE_FIXTURES) {
    assert.ok(!names.has(fixture.name), `duplicate fixture name ${fixture.name}`);
    names.add(fixture.name);

    assert.ok(fixture.tag, `${fixture.name} has no tag — its keyword is not in the dictionary`);
    assert.equal(fixture.tag, vr.resolveAttribute(fixture.keyword).tag);
    assert.ok(fixture.why.length > 20, `${fixture.name} should say why it is wrong`);
    assert.equal(vr.TORTURE_BY_NAME[fixture.name], fixture);
  }
});

test('the fixture set covers every VR class and every check', () => {
  const covered = new Set(vr.TORTURE_FIXTURES.map((f) => f.vr));
  for (const expected of ['LO', 'SH', 'PN', 'AE', 'CS', 'DS', 'IS', 'UI']) {
    assert.ok(covered.has(expected), `no torture fixture for ${expected}`);
  }

  const checks = new Set(vr.TORTURE_FIXTURES.map((f) => f.expect));
  for (const expected of ['over-length', 'cs-lowercase', 'cs-not-enumerated', 'numeric-invalid', 'odd-length', 'unexpected-vm']) {
    assert.ok(checks.has(expected), `no torture fixture for ${expected}`);
  }
});

test('a fixture states the length it would arrive with, padding included', () => {
  // "12.5 kg" is seven octets and would be padded to eight, so it must NOT
  // also trip the odd-length check. Getting this wrong is how a fixture ends
  // up proving two things and therefore nothing.
  assert.equal(vr.TORTURE_BY_NAME['ds-nonnumeric-units'].length, 8);
  assert.equal(vr.TORTURE_BY_NAME['odd-length-cs'].length, 5);
});

test('a fixture that no encoder can produce says so', () => {
  // Odd length cannot survive a conformant writer, which pads it. Marking it
  // is better than shipping a fixture that quietly becomes legal on the way
  // out and then never fails.
  assert.equal(vr.TORTURE_BY_NAME['odd-length-cs'].wireReproducible, false);
  for (const fixture of vr.TORTURE_FIXTURES) {
    if (fixture.name === 'odd-length-cs') continue;
    assert.equal(fixture.wireReproducible, true, `${fixture.name}`);
  }
});

test('whether a fixture survives this tool\'s encoder is measured, not assumed', () => {
  // The dataset writer silently TRUNCATES a value longer than its VR maximum,
  // so several fixtures cannot be put on the wire by this tool at all. That is
  // a property of the writer rather than of DICOM, and it moves when the
  // dependency does, so it is asked rather than written down. What this test
  // pins is that the answer is knowable and that a fixture reported as
  // survivable really is still non-conformant afterwards.
  for (const fixture of vr.TORTURE_FIXTURES) {
    const result = vr.encodeFixture(fixture.name);
    assert.equal(typeof result.ok, 'boolean', `${fixture.name} gave no answer`);
    if (!result.ok) continue;

    const tag = fixture.tag.slice(1, 5) + fixture.tag.slice(6, 10);
    const value = fixture.vr === 'PN' ? [{ Alphabetic: fixture.value }] : [fixture.value];
    assert.deepEqual(
      vr.checkEntries(parse(encode({ [tag]: { vr: fixture.vr, Value: value } }))).map((v) => v.kind),
      [fixture.expect],
      `vr-torture: ${fixture.name} was reported survivable but is conformant after encoding`
    );
  }
});

test('the encoder shortening a value is reported rather than passed off as sent', () => {
  // The concrete failure this guards: an over-long AE Title leaves as a legal
  // 16-character one, the peer answers a conformant query, and a test written
  // to prove the peer rejects it passes without having asked.
  const truncated = vr.encodeFixture('ae-overlong-20');
  assert.equal(truncated.ok, false);
  assert.equal(truncated.sent, 'SCHEDULEDSTATION');

  // A Long String is carried at any length, so this one really does go out.
  assert.equal(vr.encodeFixture('lo-overlong-72').ok, true);
  assert.equal(vr.encodeFixture('cs-lowercase-modality').ok, true);
  assert.equal(vr.encodeFixture('ds-nonnumeric-units').ok, true);
});

test('the fixtures come out as one worklist item each, addressable by name', () => {
  const items = vr.tortureWorklistItems();
  assert.equal(items.length, vr.TORTURE_FIXTURES.length);

  for (const [index, fixture] of vr.TORTURE_FIXTURES.entries()) {
    const item = items[index];
    assert.equal(item.PatientID, fixture.name, 'the item names the fixture it carries');
    assert.equal(item.AccessionNumber, fixture.name);
    assert.equal(
      item[fixture.keyword], fixture.value,
      `${fixture.name} must not be overwritten by the item's own identity attributes`
    );
  }

  const uids = new Set(items.map((i) => i.StudyInstanceUID));
  assert.equal(uids.size, items.length, 'each item is a distinct study');
});

// ---------------------------------------------------------------------------
// Resolving an attribute the way --set does
// ---------------------------------------------------------------------------

test('an attribute resolves from a keyword, a punctuated tag or a bare tag', () => {
  const expected = { tag: '(0010,0040)', keyword: 'PatientSex', vr: 'CS' };
  assert.deepEqual(vr.resolveAttribute('PatientSex'), expected);
  assert.deepEqual(vr.resolveAttribute('(0010,0040)'), expected);
  assert.deepEqual(vr.resolveAttribute('00100040'), expected);
  assert.deepEqual(vr.resolveAttribute('  0010,0040  '), expected);
});

test('an unknown tag resolves to a tag with no keyword, and gibberish to nothing', () => {
  // The caller needs to tell these apart: a real tag we have no name for is
  // refusable with a useful message, a typo is refusable with a different one.
  const priv = vr.resolveAttribute('(0009,0010)');
  assert.equal(priv.tag, '(0009,0010)');
  assert.equal(priv.keyword, undefined);

  assert.equal(vr.resolveAttribute('NotADicomKeyword'), undefined);
  assert.equal(vr.resolveAttribute(''), undefined);
});

test('the VR table states the maxima the checks are made of', () => {
  // Pinned because these numbers are the whole contract with PS3.5, and a
  // silent edit to one would quietly stop catching a class of violation.
  assert.equal(vr.VR_TABLE.LO.max, 64);
  assert.equal(vr.VR_TABLE.SH.max, 16);
  assert.equal(vr.VR_TABLE.PN.max, 64);
  assert.equal(vr.VR_TABLE.AE.max, 16);
  assert.equal(vr.VR_TABLE.CS.max, 16);
  assert.equal(vr.VR_TABLE.DS.max, 16);
  assert.equal(vr.VR_TABLE.IS.max, 12);
  assert.equal(vr.VR_TABLE.UI.max, 64);
  assert.equal(vr.VR_TABLE.PN.perComponentGroup, true);
});
