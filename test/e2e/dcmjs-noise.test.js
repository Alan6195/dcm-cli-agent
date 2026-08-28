'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dcmjsDimse = require('dcmjs-dimse');

const cli = require('../../src/cli');
const log = require('../../src/lib/log');
const send = require('../../src/commands/send');
const worklist = require('../../src/lib/worklist');
const { tokenize } = require('../../src/lib/args');
const { startScp, withTempDir } = require('../helpers/harness');

const { Dataset } = dcmjsDimse;
const { TransferSyntax, StorageClass } = dcmjsDimse.constants;

/**
 * The whole failure, end to end.
 *
 * A user sent a real CT to a live peer at --speed insane. dcmjs logged a parse
 * message per occurrence — which is at least once per instance — the console
 * filled with thousands of lines, the app locked up, and because nothing
 * survived to tear the transfer down the DICOM association stayed open on the
 * receiver until the app was force-closed. The unit tests cover the filter
 * itself; these run the thing the user actually ran: a real association, real
 * C-STOREs, through the real command dispatcher.
 *
 * The assertions come in pairs on purpose. It is not enough that the noise is
 * gone — the report has to be exactly as complete as it was before, because
 * the one outcome worse than a noisy run is a quiet run that lost files and
 * did not say so.
 */

/** Pixel array. Contents are irrelevant; being real DICOM is not. */
function pixels(rows, cols, seed) {
  const buffer = Buffer.alloc(rows * cols * 2);
  for (let i = 0; i < rows * cols; i++) buffer.writeUInt16LE((i * 7 + seed) % 4096, i * 2);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
}

/**
 * Writes instances carrying private group 0x5180 — the group in the CT behind
 * the original report, and one dcmjs has no dictionary entry for.
 *
 * Generated here rather than read from anywhere, because a test that reads a
 * directory it did not create reports a pass that means nothing.
 */
async function writePrivateStudy(dir, instances) {
  // Writing these files denaturalizes them, so generation floods too. Captured
  // and dropped, so the suite's own output shows only what the runs under test
  // printed.
  await capturing(() => writePrivateStudyUnquieted(dir, instances));
}

async function writePrivateStudyUnquieted(dir, instances) {
  const root = '1.2.826.0.1.3680043.10.1337';
  for (let i = 1; i <= instances; i++) {
    const elements = {
      _vrMap: { PixelData: 'OW' },
      SOPClassUID: StorageClass.CtImageStorage,
      SOPInstanceUID: `${root}.9.1.${i}`,
      StudyInstanceUID: `${root}.9`,
      SeriesInstanceUID: `${root}.9.1`,
      PatientName: 'PRIVATE^TAGS',
      PatientID: 'PRIV1',
      Modality: 'CT',
      SeriesNumber: 1,
      InstanceNumber: i,
      Rows: 32,
      Columns: 32,
      BitsAllocated: 16,
      BitsStored: 16,
      HighBit: 15,
      PixelRepresentation: 0,
      SamplesPerPixel: 1,
      PhotometricInterpretation: 'MONOCHROME2',
      PixelData: [pixels(32, 32, i)],
      51800010: { vr: 'LO', Value: ['ASTERIS CT PRIVATE'] },
      51800011: { vr: 'LO', Value: ['ASTERIS CT PRIVATE 2'] },
      51801001: { vr: 'DS', Value: ['1.5'] },
    };
    const file = path.join(dir, `inst-${i}.dcm`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const dataset = new Dataset(elements, TransferSyntax.ExplicitVRLittleEndian);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      dataset.toFile(file, (err) => (err ? reject(err) : resolve()));
    });
  }
}

/**
 * Runs something with everything it prints captured, by both routes at once.
 *
 * The two routes are the whole point of this file and they have to stay apart:
 *
 *   - The tool's own output goes through src/lib/log, whose beginCapture() is
 *     the single chokepoint every line of it passes. That is used rather than
 *     a stream patch for a reason beyond tidiness — node:test writes its own
 *     progress to process.stdout, so a test that patches stdout across an
 *     await swallows the runner's result lines and the suite silently
 *     under-reports how many tests it ran.
 *
 *   - dcmjs's output does not go through log at all. loglevel bound the real
 *     console methods at require time, so it lands on process.stderr directly
 *     and nothing but a stderr patch can see it. stderr is safe to patch here
 *     because the runner does not use it.
 *
 * Keeping them in separate buckets is also what lets a test assert that the
 * flood is gone *and* that the report is complete, without one masking the
 * other.
 */
async function capturing(fn) {
  const raw = [];
  const originalErr = process.stderr.write;
  process.stderr.write = (chunk) => (raw.push(String(chunk)), true);

  const sink = log.beginCapture();
  let code;
  try {
    code = await fn();
  } finally {
    log.endCapture();
    process.stderr.write = originalErr;
  }

  return {
    code,
    /** The tool's report. */
    stdout: sink.out,
    /** The tool's diagnostics, including the dcmjs summary line. */
    stderr: sink.err,
    /** What dcmjs itself printed, straight to the console. */
    dcmjs: raw.join(''),
    output: sink.out + sink.err + raw.join(''),
  };
}

/** Runs the CLI exactly as bin/dcm.js does. */
function runCli(argv) {
  return capturing(() => cli.main([...argv, '--no-color']));
}

/** The two messages that made up the flood. */
function floodLines(text) {
  return text
    .split('\n')
    .filter((line) => line.includes('Unknown name in dataset') || line.includes('Invalid vr type'));
}

function summaryLines(text) {
  return text.split('\n').filter((line) => line.startsWith('dcmjs: '));
}

/** Asserts the accounting a transfer report must always carry. */
function assertReportIntact(result, instances) {
  assert.equal(result.code, 0, `expected a clean exit, got ${result.code}`);
  assert.match(result.stdout, /TRANSFER REPORT/);
  assert.match(result.stdout, new RegExp(`files found\\s+${instances}`));
  assert.match(result.stdout, new RegExp(`files sent\\s+${instances}`));
  assert.match(result.stdout, new RegExp(`acknowledged\\s+${instances}`));
}

// ---------------------------------------------------------------------------
// The transfer the user was blocked on
// ---------------------------------------------------------------------------

test('a real send does not flood, and still reports every instance', async () => {
  await withTempDir('dcm-noise', async (dir) => {
    const study = path.join(dir, 'study');
    await writePrivateStudy(study, 12);

    const scp = await startScp({});
    let result;
    try {
      result = await runCli([
        'send', study,
        '--host', '127.0.0.1',
        '--port', String(scp.port),
        '--called-ae', 'ANY',
      ]);
    } finally {
      await scp.close();
    }

    assert.deepEqual(
      floodLines(result.output),
      [],
      'no dcmjs parse message may reach the console on an ordinary send'
    );

    // And the accounting the tool exists for is untouched.
    assertReportIntact(result, 12);
  });
});

test('the same send floods without the filter', async () => {
  // Pins the thing being fixed. Without this, the test above would pass just as
  // well against a dcmjs that had stopped logging, and the suite would go on
  // reporting a fix that no longer does anything.
  await withTempDir('dcm-noise-unfiltered', async (dir) => {
    const study = path.join(dir, 'study');
    await writePrivateStudy(study, 12);

    const scp = await startScp({});
    let result;
    try {
      // Straight to the command module, bypassing the dispatcher in cli.js
      // where the filter is installed. This is what the user saw.
      const argv = tokenize([
        study,
        '--host', '127.0.0.1',
        '--port', String(scp.port),
        '--called-ae', 'ANY',
        '--no-color',
      ]);
      result = await capturing(() => send.run(argv));
    } finally {
      await scp.close();
    }

    assert.ok(
      floodLines(result.dcmjs).length >= 12,
      `expected at least one dcmjs message per instance, saw ${floodLines(result.dcmjs).length}`
    );
  });
});

test('the summary stays on stderr, clear of the report and of --json', async () => {
  await withTempDir('dcm-noise-json', async (dir) => {
    const study = path.join(dir, 'study');
    await writePrivateStudy(study, 4);

    const scp = await startScp({});
    let result;
    try {
      result = await runCli([
        'send', study,
        '--host', '127.0.0.1',
        '--port', String(scp.port),
        '--called-ae', 'ANY',
        '--json',
      ]);
    } finally {
      await scp.close();
    }

    // stdout has to stay machine-readable: `dcm send --json | jq` is the point.
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.found, 4);
    assert.equal(payload.sent, 4);
    assert.equal(payload.acknowledged, 4);
    assert.equal(payload.ok, true);

    assert.deepEqual(floodLines(result.output), []);
    assert.deepEqual(summaryLines(result.stdout), [], 'the summary must not land on stdout');
  });
});

test('--verbose lets the raw dcmjs output through', async () => {
  await withTempDir('dcm-noise-verbose', async (dir) => {
    const study = path.join(dir, 'study');
    await writePrivateStudy(study, 3);

    const scp = await startScp({});
    let result;
    try {
      result = await runCli([
        'send', study,
        '--host', '127.0.0.1',
        '--port', String(scp.port),
        '--called-ae', 'ANY',
        '--verbose',
      ]);
    } finally {
      await scp.close();
    }

    // --verbose already means nothing is filtered out — it is why
    // process.noDeprecation is lifted there — and someone debugging a dataset
    // that is genuinely malformed rather than merely private needs the tag
    // names and values only these messages carry.
    assert.ok(
      floodLines(result.output).length > 0,
      'the raw dcmjs messages must survive --verbose'
    );

    assertReportIntact(result, 3);
  });
});

// ---------------------------------------------------------------------------
// The summary line, through the dispatcher
// ---------------------------------------------------------------------------

/**
 * Answering a worklist is the path that reaches dcmjs's other message. The
 * receiver denaturalizes each item to put it on the wire, so an item carrying a
 * private tag makes dcmjs warn once per tag per matched item — and it does so
 * while `dcm find` is running, inside the window where the dispatcher has the
 * filter installed.
 */
async function withPrivateWorklist(items, fn) {
  return withTempDir('dcm-noise-mwl', async (dir) => {
    const file = path.join(dir, 'worklist.json');
    fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
    const receiver = await startScp({ ae: 'WORKLIST', worklist: worklist.loadWorklistFile(file) });
    try {
      return await fn(receiver);
    } finally {
      receiver.close();
    }
  });
}

const PRIVATE_ITEMS = [1, 2, 3].map((n) => ({
  PatientName: `PRIVATE^${n}`,
  PatientID: `P${n}`,
  AccessionNumber: `A${n}`,
  Modality: 'CT',
  ScheduledStationAETitle: 'CT01',
  ScheduledProcedureStepStartDate: '20260820',
  StudyInstanceUID: `1.2.3.${n}`,
  51800010: 'ASTERIS PRIVATE',
  51801001: '1.5',
}));

test('unnameable tags are summarised once, with an accurate count', async () => {
  await withPrivateWorklist(PRIVATE_ITEMS, async (receiver) => {
    const result = await runCli([
      'find',
      '--host', '127.0.0.1',
      '--port', String(receiver.port),
      '--called-ae', 'WORKLIST',
      '--mwl',
    ]);

    assert.equal(result.code, 0);
    assert.deepEqual(floodLines(result.output), [], 'the per-tag warnings must not print');

    const lines = summaryLines(result.output);
    assert.equal(lines.length, 1, `expected exactly one summary line, saw ${lines.length}`);

    // Three items, each carrying the same two tags dcmjs cannot name. The
    // dataset count has to be the items, and the tag count the distinct tags —
    // not six of one or one of the other.
    assert.match(lines[0], /3 datasets carried 2 tags/);
    assert.match(lines[0], /6 messages withheld/);
    assert.match(lines[0], /--verbose/);

    // The command's own answer is untouched: three matches, still reported.
    assert.match(result.stdout, /PRIVATE\^1/);
    assert.match(result.stdout, /PRIVATE\^3/);
    assert.equal(receiver.stats.worklistMatches, 3);
  });
});

test('a query with nothing unnameable in it gets no footnote', async () => {
  // Every instance dcmjs parses makes it narrate its own context-dependent VR
  // table ("ox" is PixelData's dictionary VR). That is withheld too, but it is
  // not a fact about the data, so it must never produce a line — otherwise
  // every clean run the tool has ever done would end with one.
  const plain = PRIVATE_ITEMS.map(({ 51800010: _a, 51801001: _b, ...rest }) => rest);

  await withPrivateWorklist(plain, async (receiver) => {
    const result = await runCli([
      'find',
      '--host', '127.0.0.1',
      '--port', String(receiver.port),
      '--called-ae', 'WORKLIST',
      '--mwl',
    ]);

    assert.equal(result.code, 0);
    assert.deepEqual(floodLines(result.output), []);
    assert.deepEqual(summaryLines(result.output), []);
    assert.equal(receiver.stats.worklistMatches, 3);
  });
});
