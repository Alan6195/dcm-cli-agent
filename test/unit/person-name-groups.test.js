'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dcmjsDimse = require('dcmjs-dimse');
const { TransferSyntax, StorageClass } = dcmjsDimse.constants;
const { Dataset } = dcmjsDimse;

const { runCommand, withTempDir } = require('../helpers/harness');
const { writeInstance, uid } = require('../../tools/make-fixtures');

const info = require('../../src/commands/info');
const tags = require('../../src/commands/tags');
const edit = require('../../src/commands/edit');
const anon = require('../../src/commands/anon');
const find = require('../../src/commands/find');
const mpps = require('../../src/lib/mpps');
const restamp = require('../../src/lib/restamp');
const worklist = require('../../src/lib/worklist');
const { displayAttribute } = require('../../src/commands/web/query');
const tagLib = require('../../src/lib/tags');
const { scan, personNameWire, readMetadata } = require('../../src/lib/scan');

/**
 * A DICOM Person Name can hold the same name three times.
 *
 * PS3.5 6.2.1.2: a PN value is up to three component GROUPS separated by `=` —
 * Alphabetic, Ideographic, Phonetic — and each group is a five-component
 * `Family^Given^Middle^Prefix^Suffix`. `Yamada^Tarou=山田^太郎=やまだ^たろう`
 * is one patient, written in romaji, in kanji and in kana.
 *
 * The tool used to reduce that to its Alphabetic group everywhere, which was a
 * defensible display choice and a catastrophic write basis. `dcm info --json`
 * reported `Yamada^Tarou`; the desktop Rename tab prefilled its boxes from that
 * value and composed `--set PatientName=YAMADA^Tarou` from what came back; the
 * kanji and the kana were gone from every instance, and `dcm tags` had the same
 * blind spot so there was nowhere in the tool they could be seen to have
 * existed. Correcting the capitalisation of a surname deleted two thirds of a
 * patient's name.
 *
 * These tests hold both halves of the repair: the whole value is what is
 * reported and compared on, and a name with a single group is byte-for-byte
 * what it always was.
 */

/** A three-group Japanese name: romaji, kanji, kana. */
const JP = 'Yamada^Tarou=山田^太郎=やまだ^たろう';
/** The same patient after a Rename that upper-cases the family name only. */
const JP_RENAMED = 'YAMADA^Tarou=山田^太郎=やまだ^たろう';

/**
 * Writes a study whose every instance carries `patientName`.
 *
 * SpecificCharacterSet is declared because a multi-script name genuinely
 * requires it: without it the octets are still UTF-8 but nothing tells a reader
 * to decode them that way, and a test built on a file no conforming reader
 * could interpret would be testing the wrong thing.
 */
async function studyNamed(dir, patientName, { instances = 2, names } = {}) {
  for (let i = 1; i <= instances; i++) {
    await writeInstance({
      filePath: path.join(dir, `instance-${i}.dcm`),
      studyUid: uid(7),
      seriesUid: uid(7, 1),
      sopUid: uid(7, 1, i),
      modality: 'CT',
      sopClassUid: StorageClass.CtImageStorage,
      seriesNumber: 1,
      instanceNumber: i,
      rows: 8,
      cols: 8,
      patientName: names ? names[i - 1] : patientName,
      patientId: 'JP0001',
      studyDescription: 'CHEST',
      seriesDescription: 'CT SERIES 1',
      specificCharacterSet: 'ISO_IR 192',
      transferSyntaxUid: TransferSyntax.ExplicitVRLittleEndian,
    });
  }
  return dir;
}

/** The PatientName element as dcmjs parses it back off disk. */
function readPatientName(filePath) {
  const dataset = Dataset.fromFile(filePath, undefined, {
    untilTag: '7FE00010',
    includeUntilTagValue: false,
  });
  return dataset.getElements().PatientName;
}

/** The raw octets of (0010,0010), so "preserved" can mean the bytes and not a re-render. */
function patientNameBytes(filePath) {
  const buffer = fs.readFileSync(filePath);
  const at = buffer.indexOf(Buffer.from([0x10, 0x00, 0x10, 0x00, 0x50, 0x4e]));
  assert.ok(at > 0, `no explicit-VR PatientName element found in ${filePath}`);
  const length = buffer.readUInt16LE(at + 6);
  return buffer.subarray(at + 8, at + 8 + length);
}

// ---------------------------------------------------------------------------
// The joiner
// ---------------------------------------------------------------------------

test('a Person Name renders as every group it carries, joined the way DICOM stores them', () => {
  const { personNameText } = tagLib;

  // The ordinary case, and the whole reason this is safe to put everywhere:
  // one group in, that group out, no separator anywhere.
  assert.equal(personNameText([{ Alphabetic: 'DOE^JANE' }]), 'DOE^JANE');
  assert.equal(personNameText({ Alphabetic: 'DOE^JANE' }), 'DOE^JANE');
  assert.equal(personNameText('DOE^JANE'), 'DOE^JANE');

  // Three groups: one value, two separators.
  assert.equal(
    personNameText([{
      Alphabetic: 'Yamada^Tarou',
      Ideographic: '山田^太郎',
      Phonetic: 'やまだ^たろう',
    }]),
    JP
  );

  // Positional, not "the groups that happen to be present". A phonetic
  // spelling with no ideographic one keeps the empty slot between them, or it
  // is read back as an ideographic spelling — the same name filed as a
  // different script.
  assert.equal(personNameText([{ Alphabetic: 'A^B', Phonetic: 'C^D' }]), 'A^B==C^D');
  // A name with no Latin spelling leads with the empty group it does not have.
  assert.equal(personNameText([{ Ideographic: '山田^太郎' }]), '=山田^太郎');

  // Trailing empties are dropped: "DOE^JANE==" and "DOE^JANE" are one name and
  // only the second is what a writer puts on disk.
  assert.equal(personNameText([{ Alphabetic: 'DOE^JANE', Ideographic: '', Phonetic: '' }]), 'DOE^JANE');

  // Absence, in each spelling a dataset can express it.
  assert.equal(personNameText(undefined), '');
  assert.equal(personNameText(null), '');
  assert.equal(personNameText([]), '');
  assert.equal(personNameText([{ Alphabetic: '' }]), '');
});

test('there is one accessor, and what it yields can reproduce the name it read', () => {
  const three = [{
    Alphabetic: 'Yamada^Tarou',
    Ideographic: '山田^太郎',
    Phonetic: 'やまだ^たろう',
  }];

  // personNameWire is what everything reads and what a write may be based on.
  assert.equal(personNameWire(three), JP);

  // There is deliberately no second accessor that picks one group for display.
  // One existed, documented as the display half of a split, and after
  // readMetadata moved to the whole name nothing called it — which made it a
  // trap rather than a service. Asserted here so it does not quietly return.
  assert.equal(require('../../src/lib/scan').personName, undefined);

  // On the data almost everyone has, the whole name is one group and no
  // separator appears. That is the property that made the change a non-event.
  assert.equal(personNameWire([{ Alphabetic: 'DOE^JANE' }]), 'DOE^JANE');
  // And it still says "nothing here" rather than "".
  assert.equal(personNameWire([{ Alphabetic: '' }]), undefined);
  assert.equal(personNameWire(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Reading: what the engine reports
// ---------------------------------------------------------------------------

test('scan reports the whole name, so what is compared is what is on disk', async () => {
  await withTempDir('dcm-pn-scan', async (dir) => {
    const src = path.join(dir, 'src');
    await studyNamed(src, JP);

    const meta = readMetadata(path.join(src, 'instance-1.dcm'));
    assert.equal(meta.patientName, JP);

    const study = [...scan(src).studies.values()][0];
    assert.equal(study.patientName, JP);
    assert.deepEqual([...study.patientNames], [JP]);
  });
});

test('info --json carries every group, and a plain name is untouched', async () => {
  await withTempDir('dcm-pn-json', async (dir) => {
    const multi = path.join(dir, 'multi');
    await studyNamed(multi, JP);
    const { code, stdout } = await runCommand(info, [multi, '--json']);
    assert.equal(code, 0);
    const study = JSON.parse(stdout).studies[0];

    // The contract: a string, and exactly the lone entry of its plural.
    assert.equal(typeof study.patientName, 'string');
    assert.equal(study.patientName, JP);
    assert.deepEqual(study.patientNames, [JP]);
    assert.deepEqual(study.patientNames, [study.patientName]);

    // A single-group name reports as it always did — no "=", no ceremony.
    const plain = path.join(dir, 'plain');
    await studyNamed(plain, 'DOE^JANE');
    const flat = JSON.parse((await runCommand(info, [plain, '--json'])).stdout).studies[0];
    assert.equal(flat.patientName, 'DOE^JANE');
    assert.deepEqual(flat.patientNames, ['DOE^JANE']);
    assert.ok(!flat.patientName.includes('='), 'a one-group name must carry no separator');
  });
});

test('the human report prints the value you would paste back into --set', async () => {
  await withTempDir('dcm-pn-prose', async (dir) => {
    const src = path.join(dir, 'src');
    await studyNamed(src, JP);
    const { output } = await runCommand(info, [src]);
    // Not the romaji alone: the line an operator copies has to be the whole
    // name, or copying it is the defect.
    assert.match(output, /patient\s+Yamada\^Tarou=山田\^太郎=やまだ\^たろう/);
    assert.doesNotMatch(output, /\[object Object\]/);
  });
});

test('dcm tags shows the groups, so they can be seen to exist before anything writes', async () => {
  await withTempDir('dcm-pn-tags', async (dir) => {
    const src = path.join(dir, 'src');
    await studyNamed(src, JP);

    const { code, output } = await runCommand(tags, [src, '--filter', 'PatientName']);
    assert.equal(code, 0);
    assert.match(output, /\(0010,0010\)/);
    assert.ok(output.includes(JP), `tags did not print the whole name:\n${output}`);

    // And --value can find a study by a spelling that is not the Latin one,
    // which it could not when only the Alphabetic group was ever rendered.
    const byKanji = await runCommand(tags, [src, '--value', '山田^太郎']);
    assert.equal(byKanji.code, 0);
    assert.match(byKanji.output, /1 tag\(s\)/);
  });
});

test('two names differing only in a group no Latin reader can see is a conflict', async () => {
  await withTempDir('dcm-pn-conflict', async (dir) => {
    const src = path.join(dir, 'src');
    // Same romaji, different kanji. Under the old reduction these were one
    // name; the study looked intact and a rename would have picked one
    // patient's kanji and written it over the other's, unseen.
    const other = 'Yamada^Tarou=山田^太一';
    await studyNamed(src, null, { instances: 2, names: [JP, other] });

    const { code, stdout } = await runCommand(info, [src, '--json']);
    // A disagreement is reported, not a failure.
    assert.equal(code, 0);
    const study = JSON.parse(stdout).studies[0];

    assert.equal(study.patientName, null, 'a disputed name must not be reported as the study\'s name');
    assert.equal(study.patientNames.length, 2);
    assert.deepEqual([...study.patientNames].sort(), [JP, other].sort());

    // And the report prints them, which it can only do usefully because the
    // printed values differ: two names shown as their shared romaji would be
    // two identical amber lines.
    const { output } = await runCommand(info, [src]);
    assert.match(output, /2 DIFFERENT NAMES/);
    assert.ok(output.includes(JP) && output.includes(other));
  });
});

// ---------------------------------------------------------------------------
// Writing: the round trip the defect was found in
// ---------------------------------------------------------------------------

test('--set takes a multi-group name because it splits on the first = only', () => {
  const parsed = edit.parseSet(`PatientName=${JP_RENAMED}`);
  assert.equal(parsed.keyword, 'PatientName');
  assert.equal(parsed.tag, '(0010,0010)');
  // The whole rest of the argument is the value, separators and all. Splitting
  // on every "=" would make a multi-script name unwritable through this tool,
  // which would make preserving one impossible rather than merely hard.
  assert.equal(parsed.value, JP_RENAMED);
});

test('renaming the family name in romaji leaves the kanji and kana on disk', async () => {
  await withTempDir('dcm-pn-roundtrip', async (dir) => {
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'renamed');
    await studyNamed(src, JP);

    // What the study says, read the way the Rename tab reads it.
    const before = JSON.parse((await runCommand(info, [src, '--json'])).stdout).studies[0];
    assert.equal(before.patientName, JP);

    // The Rename tab's composition, in engine terms: the Latin group's Family
    // is edited, everything else is carried. `desktop/test/smoke.js` drives
    // the real boxes; this asserts the value they compose is writable.
    const argv = [src, '--set', `PatientName=${JP_RENAMED}`, '--out', out];
    const { code } = await runCommand(edit, argv);
    assert.equal(code, 0);

    const written = readPatientName(path.join(out, 'instance-1.dcm'));
    // Three groups back out, parsed as three groups — not one string with
    // stray "=" in it, and not one group with two deleted.
    assert.deepEqual(written, [{
      Alphabetic: 'YAMADA^Tarou',
      Ideographic: '山田^太郎',
      Phonetic: 'やまだ^たろう',
    }]);

    const after = JSON.parse((await runCommand(info, [out, '--json'])).stdout).studies[0];
    assert.equal(after.patientName, JP_RENAMED);
    assert.deepEqual(after.patientNames, [JP_RENAMED]);
  });
});

test('a name with one group survives a rename byte-identically', async () => {
  await withTempDir('dcm-pn-plain-bytes', async (dir) => {
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'renamed');
    await studyNamed(src, 'DOE^JANE');

    // The requirement the multi-group repair is not allowed to cost anything:
    // ordinary data must come out exactly as it went in. Written as octets
    // rather than as a re-render, because a re-render is what would hide a
    // stray separator.
    const { code } = await runCommand(edit, [src, '--set', 'PatientName=DOE^JANE', '--out', out]);
    assert.equal(code, 0, 'setting a field to what it already holds is a no-op edit, not a failure');

    // Nothing changed, so nothing was written — assert on the source instead,
    // whose octets are what a one-group name has always produced.
    const bytes = patientNameBytes(path.join(src, 'instance-1.dcm'));
    assert.equal(bytes.toString('latin1'), 'DOE^JANE');
    assert.ok(!bytes.includes(0x3d), 'a one-group name must contain no "=" byte');
  });
});

test('de-identification does not merge two patients who share a romaji spelling', async () => {
  await withTempDir('dcm-pn-anon', async (dir) => {
    // Same Latin spelling, different kanji: two people, and a Japanese
    // department has plenty of them. Hashing the Latin group alone gave both
    // the same pseudonym, which merges two patients into one in the copy —
    // exactly what a de-identified export must not do.
    const one = path.join(dir, 'one');
    const two = path.join(dir, 'two');
    await studyNamed(one, JP);
    await studyNamed(two, 'Yamada^Tarou=山田^太一=やまだ^たいち');

    const anonymised = async (src, out) => {
      const { code } = await runCommand(anon, [src, '--out', out]);
      assert.equal(code, 0);
      return JSON.parse((await runCommand(info, [out, '--json'])).stdout).studies[0].patientName;
    };

    const a = await anonymised(one, path.join(dir, 'anon-one'));
    const b = await anonymised(two, path.join(dir, 'anon-two'));
    assert.notEqual(a, b, 'two patients came out of de-identification as one');
    // Both are still replaced outright — the point is which hash they got, not
    // that anything of the original survived.
    assert.match(a, /^ANON\^/);
    assert.match(b, /^ANON\^/);
  });
});

test('an edited one-group name is still one group afterwards', async () => {
  await withTempDir('dcm-pn-plain-edit', async (dir) => {
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'renamed');
    await studyNamed(src, 'DOE^JANE');

    const { code } = await runCommand(edit, [src, '--set', 'PatientName=ROE^JANE', '--out', out]);
    assert.equal(code, 0);

    assert.deepEqual(readPatientName(path.join(out, 'instance-1.dcm')), [{ Alphabetic: 'ROE^JANE' }]);
    const bytes = patientNameBytes(path.join(out, 'instance-1.dcm'));
    assert.equal(bytes.toString('latin1'), 'ROE^JANE');
  });
});

// ---------------------------------------------------------------------------
// The splitter, and its inverse
// ---------------------------------------------------------------------------

test('splitting a name into groups is the exact inverse of joining them', () => {
  const { personNameText, personNameGroups } = tagLib;

  // The DICOM JSON shape (PS3.18 F.2.2): one key per group, and only the
  // groups that exist.
  assert.deepEqual(personNameGroups(JP), {
    Alphabetic: 'Yamada^Tarou',
    Ideographic: '山田^太郎',
    Phonetic: 'やまだ^たろう',
  });
  assert.deepEqual(personNameGroups('DOE^JANE'), { Alphabetic: 'DOE^JANE' });
  assert.deepEqual(personNameGroups([{ Alphabetic: 'DOE^JANE' }]), { Alphabetic: 'DOE^JANE' });

  // An empty group is omitted, not emitted as "". The position it held is
  // recovered from the key names, which is the whole reason the JSON form can
  // afford to drop it and the Part 10 form cannot.
  assert.deepEqual(personNameGroups('A^B==C^D'), { Alphabetic: 'A^B', Phonetic: 'C^D' });
  assert.deepEqual(personNameGroups('=山田^太郎'), { Ideographic: '山田^太郎' });
  assert.deepEqual(personNameGroups(undefined), {});
  assert.deepEqual(personNameGroups([{ Alphabetic: '' }]), {});

  // The property that makes it safe to convert in either direction anywhere:
  // every well-formed name survives the round trip unchanged.
  for (const name of [JP, JP_RENAMED, 'DOE^JANE', 'A^B==C^D', '=山田^太郎', '==やまだ^たろう']) {
    assert.equal(personNameText(personNameGroups(name)), name, name);
  }

  // No group ever carries the separator: in JSON the key says which group a
  // string is, so a "=" inside one could only be read as part of a name.
  for (const value of Object.values(personNameGroups(JP))) {
    assert.ok(!value.includes('='));
  }
});

// ---------------------------------------------------------------------------
// Writing: the acquisition station's identity
// ---------------------------------------------------------------------------

/** A worklist item as `dcm find --mwl --json` captures one, named as given. */
function worklistItem(patientName) {
  return {
    PatientName: patientName,
    PatientID: 'RIS-000123',
    PatientBirthDate: '19700101',
    PatientSex: 'O',
    AccessionNumber: 'ACC-1',
    StudyInstanceUID: '2.25.7409558135166679574647759021724211267',
    StudyID: 'RIS1',
    Modality: 'CT',
    ScheduledProcedureStepID: 'SPS1',
    ScheduledProcedureStepDescription: 'CHEST CT',
    RequestedProcedureID: 'RP1',
  };
}

/** PatientName as dcmjs hands a three-group name back off the wire. */
const JP_GROUPS = [{
  Alphabetic: 'Yamada^Tarou',
  Ideographic: '山田^太郎',
  Phonetic: 'やまだ^たろう',
}];

test('the identity taken from a worklist item carries every group of the name', () => {
  // textOf is what reads every value out of a worklist item, and it used to
  // pick one component group. Everything downstream of it writes.
  assert.equal(mpps.textOf(JP_GROUPS), JP);
  assert.equal(mpps.textOf([{ Alphabetic: 'DOE^JANE' }]), 'DOE^JANE');
  assert.equal(mpps.textOf(undefined), '');

  const attrs = mpps.worklistToAttributes(worklistItem(JP_GROUPS));
  assert.equal(attrs.patientName, JP);

  // And into the N-CREATE the station sends the RIS. A step created with a
  // shortened name is a clinical record naming a patient who does not exist
  // under that spelling in the department that scheduled them.
  const dataset = mpps.buildCreateDataset({
    ...attrs,
    performedProcedureStepId: 'PPS1',
    performedStationAeTitle: 'STATION',
    startDate: '20260115',
    startTime: '101500',
  });
  assert.equal(dataset.PatientName, JP);

  // A one-group name is the same string it always was, everywhere on the path.
  const plain = mpps.worklistToAttributes(worklistItem([{ Alphabetic: 'DOE^JANE' }]));
  assert.equal(plain.patientName, 'DOE^JANE');
  assert.ok(!plain.patientName.includes('='));
});

test('--adopt-worklist-identity stamps the whole name onto the images', async () => {
  await withTempDir('dcm-pn-restamp', async (dir) => {
    const src = path.join(dir, 'src');
    const staging = path.join(dir, 'staging');
    await studyNamed(src, 'PLACEHOLDER^NAME', { instances: 2 });

    const attrs = mpps.worklistToAttributes(worklistItem(JP_GROUPS));
    const plan = restamp.planRestamp(attrs);
    const stamped = plan.find((entry) => entry.element === 'PatientName');
    assert.equal(stamped.value, JP, 'the plan writes the whole name, not one group');

    const study = [...scan(src).studies.values()][0];
    const result = await restamp.restampFolder({
      instances: study.instances, sourceRoot: src, stagingDir: staging, plan,
    });
    assert.equal(result.failed, 0);
    assert.equal(result.written, 2);

    for (const instance of study.instances) {
      const copy = path.join(staging, path.relative(src, instance.path));

      // Three groups on disk, parsed back as three groups — the same assertion
      // the Rename round trip makes, on the path the station takes every day.
      assert.deepEqual(readPatientName(copy), [{
        Alphabetic: 'Yamada^Tarou',
        Ideographic: '山田^太郎',
        Phonetic: 'やまだ^たろう',
      }]);
      // As octets, so "preserved" means the bytes and not a re-render.
      assert.equal(patientNameBytes(copy).toString('utf8'), JP);
    }
  });
});

test('a one-group worklist name re-stamps byte-identically to what it always did', async () => {
  await withTempDir('dcm-pn-restamp-plain', async (dir) => {
    const src = path.join(dir, 'src');
    const staging = path.join(dir, 'staging');
    await studyNamed(src, 'PLACEHOLDER^NAME', { instances: 1 });

    const attrs = mpps.worklistToAttributes(worklistItem([{ Alphabetic: 'DOE^JANE' }]));
    const study = [...scan(src).studies.values()][0];
    await restamp.restampFolder({
      instances: study.instances,
      sourceRoot: src,
      stagingDir: staging,
      plan: restamp.planRestamp(attrs),
    });

    const copy = path.join(staging, path.relative(src, study.instances[0].path));
    assert.deepEqual(readPatientName(copy), [{ Alphabetic: 'DOE^JANE' }]);
    const bytes = patientNameBytes(copy);
    assert.equal(bytes.toString('latin1'), 'DOE^JANE');
    assert.ok(!bytes.includes(0x3d), 'a one-group name must contain no "=" byte');
  });
});

test('re-stamping a name onto a study that already carries it changes nothing', async () => {
  await withTempDir('dcm-pn-restamp-noop', async (dir) => {
    const src = path.join(dir, 'src');
    const staging = path.join(dir, 'staging');
    await studyNamed(src, JP, { instances: 2 });

    // Only PatientName is worth stamping here, so the study already matches
    // the order in the one attribute the plan carries.
    const plan = restamp.planRestamp({ patientName: JP });
    assert.deepEqual(plan, [{ element: 'PatientName', value: JP }]);

    const study = [...scan(src).studies.values()][0];
    const result = await restamp.restampFolder({
      instances: study.instances, sourceRoot: src, stagingDir: staging, plan,
    });

    // The comparison puts both sides through textOf, so it compares a name to
    // a name. Comparing the parsed groups against the string would have found
    // every instance different and reported two changes that were not.
    assert.equal(result.instancesChanged, 0);
    assert.equal(result.changedElements.length, 0);
  });
});

// ---------------------------------------------------------------------------
// What the audit turned up on the paths either side of the write
// ---------------------------------------------------------------------------

test('a worklist query finds an item by any one of the name\'s spellings', () => {
  const items = [{ PatientName: JP_GROUPS, PatientID: 'RIS-000123', Modality: 'CT' }];

  const matched = (criterion) =>
    worklist.selectItems(items, [{ key: 'PatientName', value: criterion }]).length;

  // The receiver keeps the whole name on the item, because the item is what
  // `dcm mpps` writes from. Being forgiving is the comparison's job instead:
  // a modality that knows only the romaji still finds the patient, and so does
  // a department querying in kanji.
  assert.equal(matched('Yamada^Tarou'), 1);
  assert.equal(matched('山田^太郎'), 1);
  assert.equal(matched('やまだ^たろう'), 1);
  assert.equal(matched(JP), 1);
  assert.equal(matched('Yamada*'), 1);
  assert.equal(matched('Suzuki^Ichiro'), 0);

  // What comes back out is still the whole name, so the identity the station
  // adopts is the one the RIS scheduled.
  assert.equal(mpps.textOf(worklist.selectItems(items, [])[0].PatientName), JP);
});

test('a C-FIND answer and a QIDO answer both show the whole name', () => {
  // Both display paths reduced a name to its Alphabetic group. The operator
  // reads these to decide whether the study is the one they want, and a
  // spelling the record does not hold is the wrong basis for that.
  assert.equal(find.display(JP_GROUPS), JP);
  assert.equal(find.display([{ Alphabetic: 'DOE^JANE' }]), 'DOE^JANE');
  // A name with no Latin spelling used to print as raw JSON, because the
  // Alphabetic group was absent rather than merely different.
  assert.equal(find.display([{ Ideographic: '山田^太郎' }]), '=山田^太郎');

  assert.equal(
    displayAttribute({ vr: 'PN', Value: [{ Alphabetic: 'Yamada^Tarou', Ideographic: '山田^太郎', Phonetic: 'やまだ^たろう' }] }),
    JP
  );
  assert.equal(displayAttribute({ vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] }), 'DOE^JANE');
  // Some servers send PN as a bare string; that branch is untouched.
  assert.equal(displayAttribute({ vr: 'PN', Value: ['DOE^JANE'] }), 'DOE^JANE');
});

test('setting a name to the value it already holds is reported as no change, and writes nothing', async () => {
  await withTempDir('dcm-pn-noop-edit', async (dir) => {
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'renamed');
    await studyNamed(src, JP, { instances: 3 });

    const { code, output } = await runCommand(edit, [src, '--set', `PatientName=${JP}`, '--out', out]);
    assert.equal(code, 0);

    // The comparison used to hold a parsed `[{Alphabetic: ...}]` against the
    // string --set carries, which are the same name and never the same JSON.
    // Every instance was reported changed and rewritten for nothing.
    assert.match(output, /would change\s+0/);
    assert.match(output, /already correct\s+3/);
    assert.ok(!fs.existsSync(out), 'a no-op edit must not produce an output tree');

    // And the ordinary case reads the same way.
    const plain = path.join(dir, 'plain');
    await studyNamed(plain, 'DOE^JANE', { instances: 2 });
    const flat = await runCommand(edit, [plain, '--set', 'PatientName=DOE^JANE', '--out', path.join(dir, 'plain-out')]);
    assert.match(flat.output, /already correct\s+2/);

    // A real change is still a change: the fix must not turn the comparison
    // into one that never fires.
    const changed = await runCommand(edit, [src, '--set', `PatientName=${JP_RENAMED}`, '--out', out]);
    assert.match(changed.output, /would change\s+3/);
    assert.equal(readPatientName(path.join(out, 'instance-1.dcm'))[0].Alphabetic, 'YAMADA^Tarou');
  });
});
