'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dcmjs = require('dcmjs');
const dcmjsDimse = require('dcmjs-dimse');
const { TransferSyntax, StorageClass } = dcmjsDimse.constants;
const { Dataset } = dcmjsDimse;

const { runCommand, withTempDir } = require('../helpers/harness');
const { generate, uid } = require('../../tools/make-fixtures');

const anon = require('../../src/commands/anon');
const { deterministicUid } = require('../../src/lib/uid');
const { KEY_ENV, SHIFT_MIN_DAYS, SHIFT_MAX_DAYS } = require('../../src/lib/pseudonym');

/**
 * De-identification beyond the top level, under a key.
 *
 * Everything here is synthetic: hand-built naturalised datasets for the walk
 * itself, and tools/make-fixtures.js studies for the command end to end.
 */

const { nameMap } = dcmjs.data.DicomMetaDictionary;
const key = () => crypto.randomBytes(32);

const STUDY = uid(901);
const SERIES = uid(901, 1);
const SOP = uid(901, 1, 1);
const FOR = uid(901, 7);

/** A synthetic dataset carrying identifiers at several depths. */
function nestedDataset(overrides = {}) {
  return {
    _vrMap: {},
    SOPClassUID: StorageClass.CtImageStorage,
    SOPInstanceUID: SOP,
    StudyInstanceUID: STUDY,
    SeriesInstanceUID: SERIES,
    FrameOfReferenceUID: FOR,
    PatientName: [{ Alphabetic: 'SYNTHETIC^NESTED' }],
    PatientID: '12345678',
    PatientSex: 'O',
    PatientAge: '056Y',
    PatientWeight: 70,
    PatientSize: 1.7,
    StudyDate: '20260115',
    SeriesDate: '20260115',
    AcquisitionDate: '20260116',
    ContentDate: '20260116',
    StudyTime: '101500',
    AcquisitionDateTime: '20260116101500.000000+0100',
    RequestedProcedureID: 'RP0001',
    StationAETitle: 'SYNTHSTATION',
    DeviceSerialNumber: 'SN-0001',
    DeviceUID: uid(901, 50),
    InstanceCreatorUID: uid(901, 51),
    OtherPatientIDs: 'OTHER-1',
    OtherPatientIDsSequence: [{ _vrMap: {}, PatientID: 'OTHER-2', IssuerOfPatientID: 'SYNTH' }],
    InstitutionCodeSequence: [{ _vrMap: {}, CodeValue: 'SYNTHHOSP', CodingSchemeDesignator: '99SYNTH' }],
    ReferencedStudySequence: [
      { _vrMap: {}, ReferencedSOPClassUID: '1.2.840.10008.3.1.2.3.1', ReferencedSOPInstanceUID: STUDY },
    ],
    SourceImageSequence: [
      {
        _vrMap: {},
        ReferencedSOPClassUID: StorageClass.CtImageStorage,
        ReferencedSOPInstanceUID: SOP,
        // Two levels down, with identifiers the old top-level pass never saw.
        PurposeOfReferenceCodeSequence: [
          { _vrMap: {}, CodeValue: '121320', CodingSchemeDesignator: 'DCM', InstitutionName: 'SYNTHETIC HOSPITAL' },
        ],
      },
    ],
    VerifyingObserverSequence: [
      {
        _vrMap: {},
        VerifyingObserverName: [{ Alphabetic: 'OBSERVER^SYNTH' }],
        VerifyingOrganization: 'SYNTHETIC HOSPITAL',
        VerificationDateTime: '20260117090000',
        VerifyingObserverIdentificationCodeSequence: [{ _vrMap: {}, CodeValue: 'X1', CodingSchemeDesignator: '99SYNTH' }],
      },
    ],
    ContentSequence: [
      {
        _vrMap: {},
        ValueType: 'TEXT',
        TextValue: 'Synthetic free text naming SYNTHETIC^NESTED',
        ContentSequence: [
          { _vrMap: {}, ValueType: 'PNAME', PersonName: [{ Alphabetic: 'SYNTHETIC^NESTED' }] },
          { _vrMap: {}, ValueType: 'DATE', Date: '20260110' },
          { _vrMap: {}, ValueType: 'UIDREF', UID: SOP },
        ],
      },
    ],
    ...overrides,
  };
}

const opts = (k, extra = {}) => ({ prefix: 'ANON', key: k, ...extra });

const DAY = 86400000;
function daysBetween(a, b) {
  const t = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Math.round((t(b) - t(a)) / DAY);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

test('nested UIDs are remapped and references still point at the remapped targets', () => {
  const k = key();
  const e = nestedDataset();
  anon.deidentifyElements(e, opts(k));

  assert.match(e.StudyInstanceUID, /^2\.25\./);
  assert.notEqual(e.StudyInstanceUID, STUDY);
  assert.equal(e.StudyInstanceUID, anon.mapUid(STUDY, k));

  // The study reference names the study, the source image names this instance.
  assert.equal(e.ReferencedStudySequence[0].ReferencedSOPInstanceUID, e.StudyInstanceUID);
  assert.equal(e.SourceImageSequence[0].ReferencedSOPInstanceUID, e.SOPInstanceUID);
  // Three levels into an SR content tree.
  assert.equal(e.ContentSequence[0].ContentSequence[2].UID, e.SOPInstanceUID);

  // Class UIDs say what a thing is and identify nobody: kept.
  assert.equal(e.SOPClassUID, StorageClass.CtImageStorage);
  assert.equal(e.ReferencedStudySequence[0].ReferencedSOPClassUID, '1.2.840.10008.3.1.2.3.1');
  assert.equal(e.SourceImageSequence[0].ReferencedSOPClassUID, StorageClass.CtImageStorage);

  // Instance-ish UIDs the old allow-list skipped.
  assert.equal(e.DeviceUID, anon.mapUid(uid(901, 50), k));
  assert.equal(e.InstanceCreatorUID, anon.mapUid(uid(901, 51), k));
});

test('nested person names are replaced, and blank and remove lists apply at every depth', () => {
  const k = key();
  const e = nestedDataset();
  anon.deidentifyElements(e, opts(k));

  assert.match(e.PatientName, /^ANON\^\d{8}$/);
  const observer = e.VerifyingObserverSequence[0];
  assert.equal(observer.VerifyingObserverName.length, 1);
  assert.match(observer.VerifyingObserverName[0], /^ANON\^\d{8}$/, 'a Type 1 name is replaced, not dropped');
  assert.ok(!('VerifyingOrganization' in observer));
  assert.deepEqual(observer.VerifyingObserverIdentificationCodeSequence, []);

  // The same person named in an SR gets the same pseudonym as the patient.
  const pname = e.ContentSequence[0].ContentSequence[0].PersonName;
  assert.deepEqual(pname, [e.PatientName]);
  assert.equal(e.ContentSequence[0].TextValue, '');

  // BLANK, two levels down.
  assert.equal(e.SourceImageSequence[0].PurposeOfReferenceCodeSequence[0].InstitutionName, '');
  // Codes are content, not identity.
  assert.equal(e.SourceImageSequence[0].PurposeOfReferenceCodeSequence[0].CodeValue, '121320');
});

test('Annex E attributes the old pass left untouched are removed or blanked', () => {
  const e = nestedDataset();
  anon.deidentifyElements(e, opts(key()));

  for (const gone of [
    'PatientAge', 'PatientWeight', 'PatientSize', 'RequestedProcedureID', 'StationAETitle',
    'OtherPatientIDs', 'OtherPatientIDsSequence', 'InstitutionCodeSequence',
  ]) {
    assert.ok(!(gone in e), `${gone} should have been removed`);
  }
  assert.equal(e.PatientSex, '');
  assert.equal(e.DeviceSerialNumber, '');
  assert.match(e.PatientID, /^ANON\d{10}$/);
  assert.equal(e.PatientIdentityRemoved, 'YES');
  assert.equal(e.LongitudinalTemporalInformationModified, 'MODIFIED');
  assert.ok(Array.isArray(e.DeidentificationMethod));
  for (const v of e.DeidentificationMethod) assert.ok(v.length <= 64, `LO over 64 characters: ${v}`);
});

test('patient characteristics are removed by default and kept with keepPatientCharacteristics', () => {
  const characteristics = {
    PatientAge: '056Y',
    PatientSex: 'O',
    PatientSize: 1.7,
    PatientWeight: 70,
    EthnicGroup: 'SYNTHETIC',
    PatientSexNeutered: 'UNALTERED',
    SmokingStatus: 'NO',
    PregnancyStatus: 4,
  };

  const removed = nestedDataset(characteristics);
  anon.deidentifyElements(removed, opts(key()));
  for (const name of Object.keys(characteristics)) {
    // Removed outright, or emptied where the attribute is Type 2.
    assert.ok(!(name in removed) || removed[name] === '', `${name} should be gone by default; got ${removed[name]}`);
  }
  assert.ok(!removed.DeidentificationMethod.some((v) => /characteristics/i.test(v)));

  const kept = nestedDataset(characteristics);
  anon.deidentifyElements(kept, opts(key(), { keepPatientCharacteristics: true }));
  for (const [name, value] of Object.entries(characteristics)) {
    assert.equal(kept[name], value, `${name} should be kept with the option`);
  }
  assert.ok(kept.DeidentificationMethod.some((v) => /Patient characteristics kept/.test(v)));
  // The option keeps characteristics, not identity.
  assert.match(kept.PatientID, /^ANON\d{10}$/);
  assert.ok(!('OtherPatientIDsSequence' in kept));
});

test('multi-valued UIDs are remapped value by value, arrays and backslash strings alike', () => {
  const k = key();
  const a = uid(901, 60);
  const b = uid(901, 61);
  const e = nestedDataset({
    FailedSOPInstanceUIDList: [a, b],
    // A backslash-joined value, the shape a raw multi-value reaches us in.
    ReferencedFrameOfReferenceUID: `${a}\\${b}`,
    // Class UIDs, multi-valued: kept.
    RelatedGeneralSOPClassUID: [StorageClass.CtImageStorage, StorageClass.MrImageStorage],
  });
  anon.deidentifyElements(e, opts(k));

  assert.deepEqual(e.FailedSOPInstanceUIDList, [anon.mapUid(a, k), anon.mapUid(b, k)]);
  assert.equal(e.ReferencedFrameOfReferenceUID, `${anon.mapUid(a, k)}\\${anon.mapUid(b, k)}`);
  assert.deepEqual(e.RelatedGeneralSOPClassUID, [StorageClass.CtImageStorage, StorageClass.MrImageStorage]);
});

test('dates shift by one offset per patient, keep their intervals, and are kept with keepDates', () => {
  // A fixed key, so "another patient gets another offset" cannot fail on the
  // one-in-3288 chance that two random offsets coincide.
  const k = Buffer.alloc(32, 7);
  const first = nestedDataset();
  const second = nestedDataset({ StudyInstanceUID: uid(902), StudyDate: '20260301' });
  const other = nestedDataset({ PatientID: '87654321' });
  for (const e of [first, second, other]) anon.deidentifyElements(e, opts(k));

  const offset = daysBetween('20260115', first.StudyDate);
  assert.ok(-offset >= SHIFT_MIN_DAYS && -offset <= SHIFT_MAX_DAYS, `offset ${offset} out of range`);
  assert.equal(daysBetween('20260301', second.StudyDate), offset, 'one patient, one offset, across studies');
  assert.equal(daysBetween(first.StudyDate, first.AcquisitionDate), 1, 'intervals within a study survive');
  assert.equal(daysBetween('20260110', first.ContentSequence[0].ContentSequence[1].Date), offset, 'nested dates too');
  assert.notEqual(daysBetween('20260115', other.StudyDate), offset, 'another patient gets another offset');

  // DT keeps its time of day and UTC offset; TM is not a date and is kept.
  assert.equal(first.AcquisitionDateTime, `${first.AcquisitionDate}101500.000000+0100`);
  assert.equal(first.StudyTime, '101500');
  assert.equal(
    daysBetween('20260117', first.VerifyingObserverSequence[0].VerificationDateTime.slice(0, 8)),
    offset
  );

  const kept = nestedDataset();
  anon.deidentifyElements(kept, opts(k, { keepDates: true }));
  assert.equal(kept.StudyDate, '20260115');
  assert.equal(kept.AcquisitionDateTime, '20260116101500.000000+0100');
  assert.equal(kept.ContentSequence[0].ContentSequence[1].Date, '20260110');
  assert.equal(kept.LongitudinalTemporalInformationModified, 'UNMODIFIED');
});

test('overlay and curve groups are removed, even with keepPrivate; functional groups are not', () => {
  for (const keepPrivate of [false, true]) {
    const e = nestedDataset({
      OverlayRows: 8,
      OverlayColumns: 8,
      OverlayData: [new Uint8Array(8).buffer],
      RETIRED_OverlayComments: 'burned in',
      RETIRED_NumberOfPoints: 3,
      60023000: 'raw overlay in a second group',
      '00091010': 'private value',
      SharedFunctionalGroupsSequence: [{ _vrMap: {}, '00191010': 'nested private' }],
    });
    anon.deidentifyElements(e, opts(key(), { keepPrivate }));

    for (const gone of ['OverlayRows', 'OverlayColumns', 'OverlayData', 'RETIRED_OverlayComments', 'RETIRED_NumberOfPoints', '60023000']) {
      assert.ok(!(gone in e), `${gone} should have been removed (keepPrivate=${keepPrivate})`);
    }
    assert.ok(Array.isArray(e.SharedFunctionalGroupsSequence), 'group 5200 is not a curve group');
    assert.equal('00091010' in e, keepPrivate);
    assert.equal('00191010' in e.SharedFunctionalGroupsSequence[0], keepPrivate, 'private tags inside sequences too');
  }
});

test('the same key gives the same pseudonyms; different keys give different ones', () => {
  const k = key();
  const a = nestedDataset();
  const b = nestedDataset();
  const c = nestedDataset();
  anon.deidentifyElements(a, opts(k));
  anon.deidentifyElements(b, opts(Buffer.from(k)));
  anon.deidentifyElements(c, opts(key()));

  for (const field of ['PatientID', 'PatientName', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'StudyDate']) {
    assert.equal(a[field], b[field], `${field}: same key, same pseudonym`);
  }
  assert.notEqual(a.PatientID, c.PatientID);
  assert.notEqual(a.StudyInstanceUID, c.StudyInstanceUID);
});

test('pseudonyms are not the old unkeyed SHA-256 values', () => {
  const k = key();
  const e = nestedDataset();
  anon.deidentifyElements(e, opts(k));

  // What v1 produced: unkeyed SHA-256 over a salt published in the source, so
  // anyone could recompute it from a guessed MRN.
  const oldId = `ANON${deterministicUid('dcm-cli:anon:id:v1', '12345678').replace(/^2\.25\./, '').slice(0, 10)}`;
  const oldUid = deterministicUid('dcm-cli:anon:uid:v1', STUDY);
  assert.notEqual(e.PatientID, oldId);
  assert.notEqual(e.StudyInstanceUID, oldUid);
  assert.notEqual(anon.pseudonym('ANON', '12345678', k), oldId);
});

test('two patients who share a romaji spelling stay two under one key', () => {
  // The person-name-groups test runs two separate commands; with a random key
  // per run those differ whatever the hash covers, so pin it down here under
  // one key, where only the kanji can tell them apart.
  const k = key();
  const a = nestedDataset({ PatientID: '', PatientName: [{ Alphabetic: 'Yamada^Tarou', Ideographic: '山田^太郎' }] });
  const b = nestedDataset({ PatientID: '', PatientName: [{ Alphabetic: 'Yamada^Tarou', Ideographic: '山田^太一' }] });
  anon.deidentifyElements(a, opts(k));
  anon.deidentifyElements(b, opts(k));
  assert.notEqual(a.PatientName, b.PatientName);
});

test('every keyword in the attribute lists is one dcmjs knows', () => {
  const lists = {
    PSEUDONYMISE: anon.PSEUDONYMISE,
    BLANK: anon.BLANK,
    REMOVE: anon.REMOVE,
    DESCRIPTIONS: anon.DESCRIPTIONS,
    PATIENT_CHARACTERISTICS: anon.PATIENT_CHARACTERISTICS,
  };
  for (const [list, keywords] of Object.entries(lists)) {
    for (const keyword of keywords) {
      assert.ok(nameMap[keyword] || nameMap[`RETIRED_${keyword}`], `${list} names ${keyword}, which matches nothing`);
    }
  }
});

// ---------------------------------------------------------------------------
// The command, end to end
// ---------------------------------------------------------------------------

/** Every output instance's naturalised elements. */
function readAll(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.dcm')) {
      out.push(Dataset.fromFile(path.join(entry.parentPath ?? entry.path, entry.name)).getElements());
    }
  }
  return out;
}

async function withKeyEnv(value, fn) {
  const before = process.env[KEY_ENV];
  if (value === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = before;
  }
}

async function study(dir) {
  return generate({ outDir: dir, quiet: true, studies: 1, seriesPerStudy: 2, instancesPerSeries: 2, rows: 8, cols: 8 });
}

test('one run maps one patient and one study to one pseudonym across every file', async () => {
  await withTempDir('dcm-anon-run', async (dir) => {
    const src = path.join(dir, 'src');
    await study(src);
    const { code, output } = await withKeyEnv(undefined, () => runCommand(anon, [src, '--out', path.join(dir, 'out')]));
    assert.equal(code, 0, output);
    assert.match(output, /pseudonym key: random for this run \(set DCM_ANON_KEY for repeatable output\)/);

    const all = readAll(path.join(dir, 'out'));
    assert.equal(all.length, 4);
    assert.equal(new Set(all.map((e) => e.PatientID)).size, 1);
    assert.equal(new Set(all.map((e) => e.StudyInstanceUID)).size, 1);
    assert.equal(new Set(all.map((e) => e.SeriesInstanceUID)).size, 2);
    assert.equal(new Set(all.map((e) => e.StudyDate)).size, 1);
    assert.notEqual(all[0].StudyDate, '20260115', 'dates are shifted by default');
  });
});

test('two runs without DCM_ANON_KEY cannot be linked', async () => {
  await withTempDir('dcm-anon-unlinked', async (dir) => {
    const src = path.join(dir, 'src');
    await study(src);
    const runs = [];
    for (const name of ['one', 'two']) {
      const { code } = await withKeyEnv(undefined, () => runCommand(anon, [src, '--out', path.join(dir, name)]));
      assert.equal(code, 0);
      runs.push(readAll(path.join(dir, name))[0]);
    }
    assert.notEqual(runs[0].PatientID, runs[1].PatientID);
    assert.notEqual(runs[0].PatientName, runs[1].PatientName);
    assert.notEqual(runs[0].StudyInstanceUID, runs[1].StudyInstanceUID);
  });
});

test('with DCM_ANON_KEY two runs give identical pseudonyms, and the key is never printed', async () => {
  await withTempDir('dcm-anon-keyed', async (dir) => {
    const src = path.join(dir, 'src');
    await study(src);
    const secret = `synthetic-test-key-${crypto.randomBytes(8).toString('hex')}`;
    const runs = [];
    for (const name of ['one', 'two']) {
      const { code, output } = await withKeyEnv(secret, () => runCommand(anon, [src, '--out', path.join(dir, name)]));
      assert.equal(code, 0, output);
      assert.match(output, /pseudonym key: from DCM_ANON_KEY/);
      assert.ok(!output.includes(secret), 'the key must never appear in the output');
      runs.push(readAll(path.join(dir, name)).sort((x, y) => x.SOPInstanceUID.localeCompare(y.SOPInstanceUID)));
    }
    for (const field of ['PatientID', 'PatientName', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'StudyDate', 'AccessionNumber']) {
      assert.deepEqual(runs[0].map((e) => e[field]), runs[1].map((e) => e[field]), field);
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'one')), fs.readdirSync(path.join(dir, 'two')));
  });
});

test('--keep-dates keeps dates on disk', async () => {
  await withTempDir('dcm-anon-keepdates', async (dir) => {
    const src = path.join(dir, 'src');
    await study(src);
    const { code, output } = await runCommand(anon, [src, '--out', path.join(dir, 'out'), '--keep-dates']);
    assert.equal(code, 0, output);
    assert.match(output, /dates shifted\s+none \(--keep-dates\)/);
    for (const e of readAll(path.join(dir, 'out'))) assert.equal(e.StudyDate, '20260115');
  });
});

test('--keep-patient-characteristics keeps sex on disk; without it the copy has none', async () => {
  await withTempDir('dcm-anon-keepchars', async (dir) => {
    const src = path.join(dir, 'src');
    await study(src);

    const plain = await runCommand(anon, [src, '--out', path.join(dir, 'plain')]);
    assert.equal(plain.code, 0, plain.output);
    for (const e of readAll(path.join(dir, 'plain'))) assert.ok(!e.PatientSex, 'PatientSex should be emptied by default');

    const kept = await runCommand(anon, [src, '--out', path.join(dir, 'kept'), '--keep-patient-characteristics']);
    assert.equal(kept.code, 0, kept.output);
    // make-fixtures writes PatientSex O on every instance.
    for (const e of readAll(path.join(dir, 'kept'))) assert.equal(e.PatientSex, 'O');
  });
});

test('a file with nested references and multi-valued UIDs round-trips to valid, consistent DICOM', async () => {
  await withTempDir('dcm-anon-nested-file', async (dir) => {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    const elements = nestedDataset({
      _vrMap: { PixelData: 'OW' },
      FailedSOPInstanceUIDList: [uid(901, 60), uid(901, 61)],
      OverlayRows: 8,
      Modality: 'CT',
      Rows: 4,
      Columns: 4,
      BitsAllocated: 16,
      BitsStored: 16,
      HighBit: 15,
      PixelRepresentation: 0,
      SamplesPerPixel: 1,
      PhotometricInterpretation: 'MONOCHROME2',
      PixelData: [new Uint16Array(16).buffer],
    });
    await new Promise((resolve, reject) => {
      new Dataset(elements, TransferSyntax.ExplicitVRLittleEndian)
        .toFile(path.join(src, 'nested.dcm'), (err) => (err ? reject(err) : resolve()));
    });

    const out = path.join(dir, 'out');
    const { code, output } = await runCommand(anon, [src, '--out', out]);
    assert.equal(code, 0, output);

    const [e] = readAll(out);
    assert.equal(e.ReferencedStudySequence[0].ReferencedSOPInstanceUID, e.StudyInstanceUID);
    assert.equal(e.SourceImageSequence[0].ReferencedSOPInstanceUID, e.SOPInstanceUID);
    assert.equal(e.FailedSOPInstanceUIDList.length, 2);
    for (const v of e.FailedSOPInstanceUIDList) assert.match(v, /^2\.25\./);
    assert.ok(!('OverlayRows' in e));
    assert.ok(!('OtherPatientIDsSequence' in e));

    // Laid out by the new UIDs, as before.
    assert.ok(fs.existsSync(path.join(out, e.StudyInstanceUID, e.SeriesInstanceUID, `${e.SOPInstanceUID}.dcm`)));
  });
});
