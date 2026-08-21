'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startScp, withTempDir } = require('../helpers/harness');
const { tokenize } = require('../../src/lib/args');
const log = require('../../src/lib/log');
const find = require('../../src/commands/find');
const scp = require('../../src/commands/scp');
const worklist = require('../../src/lib/worklist');
const { UsageError } = require('../../src/lib/args');

/**
 * Capture and replay: `dcm find --mwl --json-raw > wl.json` feeding
 * `dcm scp --worklist wl.json`.
 *
 * The pipeline was one `jq '{items: .matches}'` short of working, and the gap
 * was invisible: both halves are this project's, both speak JSON, and the file
 * the query writes looks exactly like the file the receiver reads. It just
 * was not. Anyone who found the recipe found it by reading the loader.
 *
 * So the round trip is driven here end to end and byte for byte. The document
 * the query writes is the document the receiver is handed — no key added, no
 * key removed, no reshaping in between — because a test that reshapes the file
 * proves the reshaping works and says nothing about the recipe in the USAGE.
 */

/** The worklist the FIRST receiver serves, and the source of every capture. */
const ITEMS = [
  {
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    AccessionNumber: 'A1',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260820',
    ScheduledProcedureStepStartTime: '090000',
    ScheduledProcedureStepID: 'SPS-1',
    ScheduledPerformingPhysicianName: 'SMITH^JOHN',
    RequestedProcedureDescription: 'CHEST',
    StudyInstanceUID: '1.2.3',
  },
  {
    PatientName: 'ROE^RICHARD',
    PatientID: '67890',
    AccessionNumber: 'A2',
    Modality: 'MR',
    ScheduledStationAETitle: 'MR01',
    ScheduledProcedureStepStartDate: '20260821',
    ScheduledProcedureStepStartTime: '103000',
    ScheduledProcedureStepID: 'SPS-2',
    ScheduledPerformingPhysicianName: 'JONES^MARY',
    RequestedProcedureDescription: 'BRAIN',
    StudyInstanceUID: '1.2.4',
  },
];

/** The keys a replayed row has to still carry, and where each one lives. */
const TOP_LEVEL = ['PatientName', 'PatientID', 'AccessionNumber', 'StudyInstanceUID'];
const SCHEDULED = [
  'Modality', 'ScheduledStationAETitle', 'ScheduledProcedureStepStartDate',
  'ScheduledProcedureStepStartTime', 'ScheduledProcedureStepID',
];

/**
 * Runs `dcm find --mwl` against a receiver and returns its parsed document.
 *
 * log.beginCapture() rather than the harness's runCommand(): runCommand swaps
 * process.stdout for the duration of the call, which also swallows whatever
 * node:test's reporter writes in that window, and this test parses stdout as a
 * single JSON document.
 */
async function query(receiver, argv) {
  log.configure({ noColor: true });
  const sink = log.beginCapture();
  let code;
  try {
    code = await find.run(tokenize([
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WORKLIST', '--mwl', ...argv,
    ]));
  } finally {
    log.endCapture();
  }

  let parsed;
  try {
    parsed = JSON.parse(sink.out);
  } catch {
    assert.fail(`expected one JSON document on stdout, got:\n${sink.out}\nstderr:\n${sink.err}`);
  }
  return { code, json: parsed, raw: sink.out, stderr: sink.err };
}

/** Starts the shipped receiver over a worklist source. */
async function serve(source, fn) {
  const receiver = await startScp({ ae: 'WORKLIST', worklist: source });
  try {
    return await fn(receiver);
  } finally {
    receiver.close();
  }
}

/** Writes items as a hand-written worklist file and loads it. */
function writeWorklist(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/** Indexes rows by Patient ID so an assertion cannot depend on ordering. */
function byPatientId(matches) {
  const out = new Map();
  for (const row of matches) out.set(String(row.PatientID), row);
  return out;
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test('a captured --json-raw document replays through --worklist unmodified', async () => {
  await withTempDir('dcm-capture', async (dir) => {
    const original = writeWorklist(dir, 'worklist.json', ITEMS);

    // 1. Serve the hand-written worklist and capture a real query against it.
    //    The capture is written to disk exactly as it came off stdout: this is
    //    the `dcm find --mwl --json-raw > wl.json` half of the recipe, and any
    //    massaging here would be the undocumented step this change removes.
    const captured = await serve(worklist.loadWorklistFile(original), (receiver) =>
      query(receiver, ['--json-raw']));
    assert.equal(captured.code, 0, captured.stderr);
    assert.equal(captured.json.count, 2);

    const replayFile = path.join(dir, 'wl.json');
    fs.writeFileSync(replayFile, captured.raw, 'utf8');

    // The sidecar and the envelope really are in the file being replayed —
    // otherwise the rest of this test would be proving nothing about either.
    assert.equal(captured.json.schema, 'dcm.result/1');
    assert.ok(captured.json.matches.every((m) => m._elements), 'every match carries _elements');

    // 2. `dcm scp --worklist wl.json`.
    const replaySource = worklist.loadWorklistFile(replayFile);
    assert.equal(replaySource.shape, worklist.WORKLIST_SHAPES.MATCHES);
    assert.equal(replaySource.items.length, 2);
    assert.equal(replaySource.capture.command, 'find');
    assert.equal(replaySource.capture.ok, true);

    // 3. Query the replay the same way and compare it with the original.
    const replayed = await serve(replaySource, (receiver) => query(receiver, ['--json-raw']));
    assert.equal(replayed.code, 0, replayed.stderr);
    assert.equal(replayed.json.count, 2, 'the replay serves as many rows as were captured');

    const before = byPatientId(captured.json.matches);
    const after = byPatientId(replayed.json.matches);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());

    for (const [id, source] of before) {
      const copy = after.get(id);
      for (const key of [...TOP_LEVEL, ...SCHEDULED, 'RequestedProcedureDescription',
        'ScheduledPerformingPhysicianName']) {
        assert.deepEqual(
          copy[key], source[key],
          `${key} changed for patient ${id} on the way through the replay`
        );
      }
    }
  });
});

test('the replayed rows still arrive nested in ScheduledProcedureStepSequence', async () => {
  // The one thing a replay could quietly get wrong. `--mwl` flattens the
  // scheduled step out for reading, so a capture is FLAT — and if the receiver
  // served it back flat, every conformant SCU would see a worklist with no
  // scheduling information in it and nothing anywhere would look broken.
  await withTempDir('dcm-capture-nesting', async (dir) => {
    const original = writeWorklist(dir, 'worklist.json', ITEMS);
    const captured = await serve(worklist.loadWorklistFile(original), (receiver) =>
      query(receiver, ['--json-raw']));

    for (const row of captured.json.matches) {
      assert.equal(
        row.ScheduledProcedureStepSequence, undefined,
        'the capture is flat, which is exactly why the receiver has to re-nest it'
      );
    }

    const replayFile = path.join(dir, 'wl.json');
    fs.writeFileSync(replayFile, captured.raw, 'utf8');
    const source = worklist.loadWorklistFile(replayFile);

    // Read the datasets the receiver would put on the wire, rather than the
    // client's flattened view of them: the flattening is what would hide the
    // mistake.
    for (const item of source.items) {
      const dataset = worklist.toDataset(item);
      assert.ok(
        Array.isArray(dataset.ScheduledProcedureStepSequence)
          && dataset.ScheduledProcedureStepSequence.length === 1,
        'the answer carries exactly one scheduled procedure step'
      );
      const step = dataset.ScheduledProcedureStepSequence[0];
      for (const key of SCHEDULED) {
        assert.ok(step[key] !== undefined, `${key} belongs inside the scheduled step, not flat`);
        assert.equal(dataset[key], undefined, `${key} must not also be at the top level`);
      }
      for (const key of TOP_LEVEL) {
        assert.ok(dataset[key] !== undefined, `${key} belongs at the top level`);
      }
    }

    // And end to end: a replaying receiver answers a query narrowed on a
    // scheduled-step key, which only works if the key was nested correctly.
    const replayed = await serve(source, (receiver) =>
      query(receiver, ['--json', 'ScheduledStationAETitle=MR01']));
    assert.equal(replayed.json.count, 1, replayed.stderr);
    assert.equal(replayed.json.matches[0].PatientID, '67890');
  });
});

test('a narrowed capture replays as a narrowed worklist', async () => {
  // The capture records the rows the query returned, which is the property
  // that makes "reproduce this customer's worklist" work at all: you capture
  // the query that misbehaved, not the whole schedule behind it.
  await withTempDir('dcm-capture-narrow', async (dir) => {
    const original = writeWorklist(dir, 'worklist.json', ITEMS);
    const captured = await serve(worklist.loadWorklistFile(original), (receiver) =>
      query(receiver, ['--json-raw', 'Modality=CT']));
    assert.equal(captured.json.count, 1);

    const replayFile = path.join(dir, 'wl.json');
    fs.writeFileSync(replayFile, captured.raw, 'utf8');

    const source = worklist.loadWorklistFile(replayFile);
    assert.equal(source.items.length, 1);

    const replayed = await serve(source, (receiver) => query(receiver, ['--json']));
    assert.equal(replayed.json.count, 1);
    assert.equal(replayed.json.matches[0].PatientID, '12345');
  });
});

// ---------------------------------------------------------------------------
// Tolerance: extra keys and the sidecar
// ---------------------------------------------------------------------------

test('unknown envelope keys and the _elements sidecar do not break the reader', async () => {
  await withTempDir('dcm-capture-extra', async (dir) => {
    // A document shaped like a capture from a future version: keys this reader
    // has never heard of at the top level and inside each row, plus the
    // sidecar. None of it may be an error, and none of it may reach the wire.
    const document = {
      schema: 'dcm.result/1',
      schemaVersion: 1,
      command: 'find',
      outcome: 'matched',
      ok: true,
      exitCode: 0,
      message: 'prose that is never asserted on',
      peer: { host: 'ris.example', port: 104, calledAe: 'RIS', callingAe: 'DCM-CLI' },
      level: 'mwl',
      raw: true,
      count: 1,
      attribution: { stations: ['CT01'] },
      somethingAddedLater: { nested: [1, 2, 3] },
      matches: [
        {
          PatientName: 'DOE^JANE',
          PatientID: '12345',
          AccessionNumber: 'A1',
          Modality: 'CT',
          ScheduledStationAETitle: 'CT01',
          ScheduledProcedureStepStartDate: '20260820',
          StudyInstanceUID: '1.2.3',
          _elements: {
            '(0010,0020)': { vr: 'LO', length: 6, keyword: 'PatientID', vm: 1, value: '12345' },
            '(0040,0100)': { vr: 'SQ', items: [{ '(0008,0060)': { vr: 'CS', value: 'CT' } }] },
          },
          _somethingElseAddedLater: 'ignored too',
        },
      ],
    };

    const file = writeWorklist(dir, 'future.json', document);
    const source = worklist.loadWorklistFile(file);
    assert.equal(source.shape, worklist.WORKLIST_SHAPES.MATCHES);
    assert.equal(source.items.length, 1);

    // Nothing underscore-prefixed survives into the answer, at any depth.
    const dataset = worklist.toDataset(source.items[0]);
    assert.equal(dataset._elements, undefined);
    assert.equal(dataset._somethingElseAddedLater, undefined);
    for (const key of Object.keys(dataset)) assert.ok(!key.startsWith('_'), key);

    // And it survives the wire, which is the assertion that would fail if the
    // sidecar were being encoded as attributes.
    const replayed = await serve(source, (receiver) => query(receiver, ['--json-raw']));
    assert.equal(replayed.code, 0, replayed.stderr);
    assert.equal(replayed.json.count, 1);
    assert.equal(replayed.json.matches[0].PatientID, '12345');
    assert.equal(replayed.json.matches[0].Modality, 'CT');
  });
});

test('dcmjs bookkeeping inside a sequence item never reaches the answer', async () => {
  // A row that has been off a wire once carries _vrMap inside every sequence
  // item, not only at the top level. Stripping the first level only would put
  // library bookkeeping back into the dataset this receiver encodes.
  const item = {
    PatientID: '12345',
    _vrMap: { PatientID: 'LO' },
    ScheduledProcedureStepSequence: [
      { Modality: 'CT', ScheduledProcedureStepID: 'SPS-1', _vrMap: { Modality: 'CS' } },
    ],
    ReferencedStudySequence: [{ ReferencedSOPClassUID: '1.2.3', _vrMap: { x: 'UI' } }],
  };

  const dataset = worklist.toDataset(item);
  assert.equal(dataset._vrMap, undefined);
  assert.equal(dataset.ScheduledProcedureStepSequence[0]._vrMap, undefined);
  assert.equal(dataset.ScheduledProcedureStepSequence[0].Modality, 'CT');
  assert.equal(dataset.ReferencedStudySequence[0]._vrMap, undefined);
  assert.equal(dataset.ReferencedStudySequence[0].ReferencedSOPClassUID, '1.2.3');
});

// ---------------------------------------------------------------------------
// What the loader reports back, and what it refuses
// ---------------------------------------------------------------------------

test('all three accepted shapes load, and each says which one it was', async () => {
  await withTempDir('dcm-capture-shapes', async (dir) => {
    const bare = writeWorklist(dir, 'bare.json', ITEMS);
    const wrapped = writeWorklist(dir, 'wrapped.json', { name: 'today', items: ITEMS });
    const capture = writeWorklist(dir, 'capture.json', {
      schema: 'dcm.result/1', command: 'find', outcome: 'matched', ok: true,
      count: ITEMS.length, matches: ITEMS,
    });

    assert.equal(worklist.loadWorklistFile(bare).shape, worklist.WORKLIST_SHAPES.ARRAY);
    assert.equal(worklist.loadWorklistFile(wrapped).shape, worklist.WORKLIST_SHAPES.ITEMS);

    const loaded = worklist.loadWorklistFile(capture);
    assert.equal(loaded.shape, worklist.WORKLIST_SHAPES.MATCHES);
    assert.equal(loaded.items.length, 2);
    assert.deepEqual(loaded.capture, {
      command: 'find', outcome: 'matched', ok: true, count: 2,
    });

    // Only a capture reports one; there is nothing to report about a file
    // somebody wrote by hand.
    assert.equal(worklist.loadWorklistFile(bare).capture, undefined);
    assert.equal(worklist.loadWorklistFile(wrapped).capture, undefined);
  });
});

test('a hand-written "items" array wins over a "matches" array in the same file', async () => {
  await withTempDir('dcm-capture-both', async (dir) => {
    const file = writeWorklist(dir, 'both.json', {
      items: [ITEMS[0]],
      matches: ITEMS,
    });
    const loaded = worklist.loadWorklistFile(file);
    assert.equal(loaded.shape, worklist.WORKLIST_SHAPES.ITEMS);
    assert.equal(loaded.items.length, 1);
  });
});

test('a capture of a query that failed loads, and is not mistaken for a schedule', async () => {
  // The trap this shape brings with it. A refused association produces a
  // perfectly well-formed document whose "matches" array is empty, and
  // replaying it is indistinguishable from an empty schedule unless the
  // recorded outcome is carried through.
  await withTempDir('dcm-capture-failed', async (dir) => {
    const file = writeWorklist(dir, 'refused.json', {
      schema: 'dcm.result/1', command: 'find', outcome: 'rejected', ok: false,
      exitCode: 1, count: null,
      detail: { kind: 'rejected', label: 'Calling AE Title not recognized' },
      matches: [],
    });

    const loaded = worklist.loadWorklistFile(file);
    assert.deepEqual(loaded.items, []);
    assert.equal(loaded.capture.ok, false);
    assert.equal(loaded.capture.outcome, 'rejected');
  });
});

test('a "matches" property that is not an array is refused by name', async () => {
  await withTempDir('dcm-capture-bad', async (dir) => {
    assert.throws(
      () => worklist.loadWorklistFile(writeWorklist(dir, 'bad.json', { matches: 'nope' })),
      (err) => err instanceof UsageError
        && /"matches" property that is a string/.test(err.message)
        && /--json-raw/.test(err.message)
    );

    // And the catch-all message now offers the third shape too, so someone
    // handed the wrong file learns that a capture is an option.
    assert.throws(
      () => worklist.loadWorklistFile(writeWorklist(dir, 'plain.json', { PatientID: '1' })),
      (err) => err instanceof UsageError && /"matches"/.test(err.message)
    );
  });
});

test('the scp usage documents the capture-and-replay recipe', () => {
  assert.match(scp.USAGE, /Capture and replay/);
  assert.match(scp.USAGE, /dcm find --mwl/);
  assert.match(scp.USAGE, /--json-raw/);
  assert.match(scp.USAGE, /--worklist wl\.json/);
  // The two properties that make the recipe safe to print: no editing step,
  // and unknown keys tolerated.
  assert.match(scp.USAGE, /_elements/);
});
