'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startScp, runCommand, withTempDir } = require('../helpers/harness');

const find = require('../../src/commands/find');
const scp = require('../../src/commands/scp');
const worklist = require('../../src/lib/worklist');
const { UsageError } = require('../../src/lib/args');

/**
 * Modality Worklist, end to end.
 *
 * `dcm find --mwl` could always ask the question; until `dcm scp --worklist`
 * there was nothing in this project that could answer it, so the two halves
 * had never been run against each other. These tests drive the real find
 * command against the real receiver for exactly that reason: a worklist SCP
 * that agrees with itself but not with a client is worth nothing, and the
 * disagreement is always about where the scheduled-step attributes live.
 */

/** The fixture worklist every test below queries. */
const ITEMS = [
  {
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    AccessionNumber: 'A1',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260820',
    ScheduledProcedureStepStartTime: '090000',
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
    ScheduledPerformingPhysicianName: 'JONES^MARY',
    RequestedProcedureDescription: 'BRAIN',
    StudyInstanceUID: '1.2.4',
  },
  {
    PatientName: 'DOEL^SAM',
    PatientID: '24680',
    AccessionNumber: 'A3',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT02',
    ScheduledProcedureStepStartDate: '20260825',
    ScheduledProcedureStepStartTime: '140000',
    ScheduledPerformingPhysicianName: 'SMITH^JOHN',
    RequestedProcedureDescription: 'ABDOMEN',
    StudyInstanceUID: '1.2.5',
  },
];

/**
 * Writes a worklist file, loads it through the shipped loader, and runs the
 * shipped receiver over it — no stand-ins on either side.
 */
async function withWorklistScp(items, fn, scpConfig = {}) {
  return withTempDir('dcm-worklist', async (dir) => {
    const file = path.join(dir, 'worklist.json');
    fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');

    const source = worklist.loadWorklistFile(file);
    const receiver = await startScp({ ae: 'WORKLIST', worklist: source, ...scpConfig });
    try {
      return await fn(receiver, file);
    } finally {
      receiver.close();
    }
  });
}

/** Runs `dcm find --mwl` against a receiver started above. */
function query(receiver, keys = [], extra = []) {
  return runCommand(find, [
    '--host', '127.0.0.1', '--port', String(receiver.port),
    '--called-ae', 'WORKLIST', '--mwl', ...extra, ...keys,
  ]);
}

/**
 * Pulls the JSON document out of captured stdout.
 *
 * The harness captures process.stdout for the duration of a command, and the
 * test runner flushes its own progress lines through the same stream, so the
 * buffer is not guaranteed to hold nothing but the command's output. Scanning
 * for the document rather than parsing the whole buffer keeps these tests
 * about the worklist instead of about reporter timing.
 */
function extractJson(stdout) {
  const start = stdout.indexOf('{\n  "level"');
  assert.notEqual(start, -1, `no JSON document in output:\n${stdout}`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return JSON.parse(stdout.slice(start, i + 1));
  }
  throw new Error(`unterminated JSON document in output:\n${stdout}`);
}

/** Parses the JSON form of a find result. */
async function queryJson(receiver, keys = []) {
  const result = await query(receiver, keys, ['--json']);
  return { ...result, parsed: extractJson(result.stdout) };
}

// ---------------------------------------------------------------------------
// The two halves have to agree about the sequence
// ---------------------------------------------------------------------------

test('the client and the receiver nest the same keys in the step sequence', () => {
  // If these lists drift the client asks about a nested attribute while the
  // receiver answers with a flat one. Nothing errors; the worklist just looks
  // empty. Pinning them together is the cheapest possible guard.
  assert.deepEqual([...worklist.SPS_KEYS], [...find.MWL_SPS_KEYS]);
});

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

test('a worklist query with no matching keys returns every item', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const { code, parsed } = await queryJson(receiver);

    assert.equal(code, 0);
    assert.equal(parsed.count, 3);
    assert.deepEqual(
      parsed.matches.map((m) => m.PatientID).sort(),
      ['12345', '24680', '67890']
    );
    assert.equal(receiver.stats.worklistMatches, 3);
  });
});

test('Modality=CT returns only the CT items', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const { code, parsed } = await queryJson(receiver, ['Modality=CT']);

    assert.equal(code, 0);
    assert.equal(parsed.count, 2);
    assert.deepEqual(parsed.matches.map((m) => m.AccessionNumber).sort(), ['A1', 'A3']);
    for (const match of parsed.matches) assert.equal(match.Modality, 'CT');
  });
});

test('Modality matching is case-insensitive', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const { parsed } = await queryJson(receiver, ['Modality=ct']);
    assert.equal(parsed.count, 2);
  });
});

test('ScheduledStationAETitle selects one station', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const { parsed } = await queryJson(receiver, ['ScheduledStationAETitle=CT02']);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.matches[0].AccessionNumber, 'A3');
  });
});

test('a date range selects the items scheduled inside it', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const inclusive = await queryJson(receiver, [
      'ScheduledProcedureStepStartDate=20260821-20260825',
    ]);
    assert.equal(inclusive.parsed.count, 2, 'both ends of the range are inclusive');
    assert.deepEqual(
      inclusive.parsed.matches.map((m) => m.AccessionNumber).sort(),
      ['A2', 'A3']
    );

    const openStart = await queryJson(receiver, [
      'ScheduledProcedureStepStartDate=-20260820',
    ]);
    assert.equal(openStart.parsed.count, 1, 'an open start bounds only the far end');
    assert.equal(openStart.parsed.matches[0].AccessionNumber, 'A1');

    const openEnd = await queryJson(receiver, [
      'ScheduledProcedureStepStartDate=20260821-',
    ]);
    assert.equal(openEnd.parsed.count, 2, 'an open end bounds only the near end');

    const single = await queryJson(receiver, [
      'ScheduledProcedureStepStartDate=20260820',
    ]);
    assert.equal(single.parsed.count, 1, 'a single date is not a range');
    assert.equal(single.parsed.matches[0].AccessionNumber, 'A1');
  });
});

test('a wildcard PatientName matches, and ? matches exactly one character', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const star = await queryJson(receiver, ['PatientName=DOE*']);
    assert.equal(star.parsed.count, 2, 'DOE^JANE and DOEL^SAM');

    const anchored = await queryJson(receiver, ['PatientName=DOE^*']);
    assert.equal(anchored.parsed.count, 1, 'the ^ separator is a literal, not regex syntax');
    assert.equal(anchored.parsed.matches[0].PatientID, '12345');

    const single = await queryJson(receiver, ['PatientName=DOE?^SAM']);
    assert.equal(single.parsed.count, 1);
    assert.equal(single.parsed.matches[0].PatientID, '24680');
  });
});

test('PatientID and AccessionNumber narrow to one item', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const byId = await queryJson(receiver, ['PatientID=67890']);
    assert.equal(byId.parsed.count, 1);
    assert.equal(byId.parsed.matches[0].PatientName, 'ROE^RICHARD');

    const byAccession = await queryJson(receiver, ['AccessionNumber=A2']);
    assert.equal(byAccession.parsed.count, 1);
    assert.equal(byAccession.parsed.matches[0].PatientID, '67890');
  });
});

test('several matching keys are combined, not alternated', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const both = await queryJson(receiver, ['Modality=CT', 'ScheduledStationAETitle=CT01']);
    assert.equal(both.parsed.count, 1);
    assert.equal(both.parsed.matches[0].AccessionNumber, 'A1');

    // Two keys that individually match, but never the same item.
    const contradictory = await queryJson(receiver, [
      'Modality=MR', 'ScheduledStationAETitle=CT01',
    ]);
    assert.equal(contradictory.parsed.count, 0);
  });
});

// ---------------------------------------------------------------------------
// The nesting the client depends on
// ---------------------------------------------------------------------------

test("the client's flattened output shows the scheduled-step fields", async () => {
  // This is the proof that the response nests the scheduled step where an MWL
  // SCU reads it. `dcm find --mwl` only flattens what it finds inside
  // ScheduledProcedureStepSequence, so these values reaching the table at all
  // means the receiver put them there.
  await withWorklistScp(ITEMS, async (receiver) => {
    const { code, output } = await query(receiver, ['PatientID=12345']);

    assert.equal(code, 0);
    assert.match(output, /1 match\./);
    assert.match(output, /DOE\^JANE/);
    assert.match(output, /\bCT\b/, 'Modality came out of the sequence');
    assert.match(output, /20260820/, 'the scheduled start date came out of the sequence');
    assert.match(output, /090000/, 'the scheduled start time came out of the sequence');
    assert.match(output, /CT01/, 'the scheduled station came out of the sequence');
    assert.match(output, /CHEST/, 'the top-level requested procedure survived');
  });
});

test('an item written with a real ScheduledProcedureStepSequence behaves identically', async () => {
  // The file format is flat, but a nested item is the shape a DICOM person
  // would reach for. Both have to match and answer the same way, or the same
  // worklist gives different results depending on how it was typed.
  const nested = [
    {
      PatientName: 'NESTED^NORA',
      PatientID: '99999',
      AccessionNumber: 'A9',
      RequestedProcedureDescription: 'KNEE',
      ScheduledProcedureStepSequence: [
        {
          Modality: 'CR',
          ScheduledStationAETitle: 'CR01',
          ScheduledProcedureStepStartDate: '20260820',
          ScheduledProcedureStepStartTime: '080000',
        },
      ],
    },
  ];

  await withWorklistScp(nested, async (receiver) => {
    const { code, parsed } = await queryJson(receiver, ['Modality=CR']);
    assert.equal(code, 0);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.matches[0].ScheduledStationAETitle, 'CR01');
    assert.equal(parsed.matches[0].PatientID, '99999');
  });
});

// ---------------------------------------------------------------------------
// Zero matches, and the receiver without a worklist
// ---------------------------------------------------------------------------

test('a query matching nothing returns zero matches and exits 1', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    const { code, output } = await query(receiver, ['Modality=US']);

    assert.equal(code, 1, "the CLI's zero-matches convention");
    assert.match(output, /0 matches/);
    assert.equal(receiver.stats.worklistMatches, 0);
    assert.equal(receiver.stats.finds, 1, 'the query was answered, not refused');
  });
});

test('a receiver started without --worklist still returns zero matches', async () => {
  // The default receiver must be untouched by any of this: it stores, it does
  // not index, and it says so.
  const receiver = await startScp({ ae: 'WORKLIST' });
  try {
    const { code, output } = await query(receiver, ['Modality=CT']);

    assert.equal(code, 1);
    assert.match(output, /0 matches/);
    assert.match(output, /not the same as a failed transfer/i);
    assert.equal(receiver.stats.worklistMatches, 0);
    assert.equal(receiver.stats.finds, 1);
  } finally {
    receiver.close();
  }
});

test('a study-level C-FIND is unaffected by a configured worklist', async () => {
  // --worklist answers worklist queries. It does not turn the receiver into an
  // archive, and a study-level query must still get the honest zero.
  await withWorklistScp(ITEMS, async (receiver) => {
    const { code, output } = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WORKLIST', 'PatientID=12345',
    ]);

    assert.equal(code, 1);
    assert.match(output, /0 matches/);
    assert.equal(receiver.stats.worklistMatches, 0);
  });
});

// ---------------------------------------------------------------------------
// Matching keys we do not implement
// ---------------------------------------------------------------------------

test('an unsupported matching key is reported and ignored, not silently honoured', async () => {
  await withWorklistScp(ITEMS, async (receiver) => {
    // The receiver does not match on the scheduled start time. Ignoring it
    // must widen the answer, never narrow it to nothing.
    const { parsed } = await queryJson(receiver, [
      'Modality=CT', 'ScheduledProcedureStepStartTime=999999',
    ]);
    assert.equal(parsed.count, 2, 'the unsupported key did not filter anything out');
  });
});

test('readMatchingKeys separates supported keys, unsupported keys and universal ones', () => {
  const { criteria, unsupported } = worklist.readMatchingKeys({
    PatientID: '12345',
    PatientName: '',
    StudyDescription: 'CHEST',
    AccessionNumber: { Alphabetic: 'A1' },
    QueryRetrieveLevel: '',
    RequestedProcedureCodeSequence: [],
    ScheduledProcedureStepSequence: [
      { Modality: 'CT', ScheduledProcedureStepStartTime: '090000', ScheduledStationAETitle: '' },
    ],
  });

  assert.deepEqual(
    criteria.map((c) => `${c.key}=${c.value}`).sort(),
    ['AccessionNumber=A1', 'Modality=CT', 'PatientID=12345']
  );
  assert.deepEqual(unsupported.sort(), ['ScheduledProcedureStepStartTime', 'StudyDescription']);
});

test('the return keys every worklist query carries are not mistaken for filters', () => {
  // dcmjs-dimse builds a worklist request with a fixed set of return keys, and
  // a zero-length element does not always come back as "". Binary VRs decode
  // to 0, Person Names to [], DS to null. Reading any of those as a real value
  // would filter on it, or warn about it, on every query ever made — which is
  // how a warning that matters gets tuned out.
  const { criteria, unsupported } = worklist.readMatchingKeys({
    _vrMap: {},
    PregnancyStatus: 0,        // US, zero-length
    PatientWeight: null,       // DS, zero-length
    PatientName: [],           // PN, zero-length
    ReferringPhysicianName: [],
    ReferencedStudySequence: [],
    StudyDate: '',
    QueryRetrieveLevel: '',
    ScheduledProcedureStepSequence: [{ _vrMap: {}, Modality: '' }],
  });

  assert.deepEqual(criteria, []);
  assert.deepEqual(unsupported, []);
});

test('DICOM padding on a matching key does not defeat the match', () => {
  // Odd-length values are padded with a trailing space on the wire, so the
  // criterion that arrives is not always the one that was typed.
  const { criteria } = worklist.readMatchingKeys({ PatientID: '12345 ' });
  assert.deepEqual(criteria, [{ key: 'PatientID', value: '12345' }]);
  assert.equal(worklist.matchesDate('20260821', '20260821- '), true);
});

// ---------------------------------------------------------------------------
// Loading and validating the file
// ---------------------------------------------------------------------------

test('an object with an items array is accepted alongside a bare array', async () => {
  await withTempDir('dcm-worklist-shape', async (dir) => {
    const bare = path.join(dir, 'bare.json');
    const wrapped = path.join(dir, 'wrapped.json');
    fs.writeFileSync(bare, JSON.stringify(ITEMS), 'utf8');
    fs.writeFileSync(wrapped, JSON.stringify({ name: 'today', items: ITEMS }), 'utf8');

    assert.equal(worklist.loadWorklistFile(bare).items.length, 3);
    assert.equal(worklist.loadWorklistFile(wrapped).items.length, 3);
  });
});

test('a missing worklist file is a usage error naming the file', async () => {
  await withTempDir('dcm-worklist-missing', async (dir) => {
    const missing = path.join(dir, 'nope.json');
    assert.throws(
      () => worklist.loadWorklistFile(missing),
      (err) => err instanceof UsageError && err.message.includes('nope.json')
        && /does not exist/.test(err.message)
    );
  });
});

test('malformed JSON, a non-array and a non-object item are each named', async () => {
  await withTempDir('dcm-worklist-bad', async (dir) => {
    const write = (name, text) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text, 'utf8');
      return file;
    };

    assert.throws(
      () => worklist.loadWorklistFile(write('broken.json', '[{"PatientID": "1",}]')),
      (err) => err instanceof UsageError && /not valid JSON/.test(err.message)
        && err.message.includes('broken.json')
    );

    assert.throws(
      () => worklist.loadWorklistFile(write('object.json', '{"PatientID":"1"}')),
      (err) => err instanceof UsageError && /must be a JSON array/.test(err.message)
    );

    assert.throws(
      () => worklist.loadWorklistFile(write('items-bad.json', '{"items":"nope"}')),
      (err) => err instanceof UsageError && /"items" property that is a string/.test(err.message)
    );

    assert.throws(
      () => worklist.loadWorklistFile(write('item-bad.json', '[{"PatientID":"1"}, "CT"]')),
      (err) => err instanceof UsageError && /item 2 of 2 is a string/.test(err.message)
    );

    assert.throws(
      () => worklist.loadWorklistFile(write('item-null.json', '[null]')),
      (err) => err instanceof UsageError && /item 1 of 1 is null/.test(err.message)
    );
  });
});

test('an empty worklist loads, so an empty schedule can be tested deliberately', async () => {
  await withTempDir('dcm-worklist-empty', async (dir) => {
    const file = path.join(dir, 'empty.json');
    fs.writeFileSync(file, '[]', 'utf8');
    assert.deepEqual(worklist.loadWorklistFile(file).items, []);
  });
});

test('scp --worklist rejects a missing file before it opens a socket', async () => {
  await withTempDir('dcm-worklist-startup', async (dir) => {
    await assert.rejects(
      () => runCommand(scp, ['--port', '11112', '--worklist', path.join(dir, 'absent.json')]),
      (err) => err instanceof UsageError && /absent\.json/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

test('the scp usage documents --worklist and what it is not', () => {
  assert.match(scp.USAGE, /--worklist <file>/);
  assert.match(scp.USAGE, /ScheduledProcedureStepSequence/);
  assert.match(scp.USAGE, /not a scheduling system/i);
  assert.match(scp.USAGE, /RIS/);
});
