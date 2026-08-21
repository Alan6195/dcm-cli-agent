'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const log = require('../../src/lib/log');
const json = require('../../src/lib/json');
const { tokenize } = require('../../src/lib/args');
const mpps = require('../../src/lib/mpps');
const dispatcher = require('../../src/commands/mpps');

/**
 * The --json envelope, the worklist selectors and --set, without a socket.
 *
 * Everything here is a path that never reaches the wire: a validation error, a
 * dry run, a worklist read off a pipe. That is deliberate — those are exactly
 * the paths that used to escape --json, because they end before the code that
 * would have printed a document ever runs. The wire-driven half is in
 * test/e2e/mpps-envelope.test.js.
 *
 * The complaint this file answers, in NewLumen's words: `dcm mpps start --json`
 * on a Type 1 validation error exits 2 with plain English and no JSON, and a CI
 * job cannot branch on prose.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs a verb through the dispatcher and returns the one document on stdout.
 *
 * log.beginCapture() rather than the harness's runCommand(): runCommand swaps
 * process.stdout.write for the duration, which also swallows anything the test
 * reporter writes in that window — harmless for an output.includes() assertion,
 * fatal for one parsing stdout as a single JSON document.
 */
async function run(argv) {
  log.configure({ noColor: true });
  const sink = log.beginCapture();
  let code;
  try {
    code = await dispatcher.run(tokenize(argv));
  } finally {
    log.endCapture();
  }
  return { code, stdout: sink.out, stderr: sink.err };
}

/** The single envelope on stdout, failing if there is not exactly one. */
function oneEnvelope(stdout) {
  const found = stdout.split('"schema": "dcm.result/').length - 1;
  assert.equal(found, 1, `expected exactly one envelope on stdout, found ${found}:\n${stdout}`);
  return JSON.parse(stdout);
}

/** Every envelope carries the identity a caller pins on, whatever else it says. */
function assertWellFormed(envelope, command) {
  assert.equal(envelope.schema, 'dcm.result/1');
  assert.equal(envelope.schemaVersion, json.SCHEMA_VERSION);
  assert.equal(envelope.command, command);
  assert.ok(
    Object.values(json.Outcome).includes(envelope.outcome),
    `"${envelope.outcome}" is not a declared outcome`
  );
  assert.equal(typeof envelope.ok, 'boolean');
  assert.equal(typeof envelope.exitCode, 'number');
}

/** A two-item worklist document in the shape `dcm find --mwl --json-raw` emits. */
const TWO_ITEMS = {
  matches: [
    {
      PatientName: { Alphabetic: 'DOE^JANE' },
      PatientID: '12345',
      AccessionNumber: 'A1',
      Modality: 'CT',
      ScheduledProcedureStepID: 'SPS1',
      StudyInstanceUID: '1.2.826.0.1.3680043.8.1055.1',
    },
    {
      PatientName: { Alphabetic: 'ROE^RICHARD' },
      PatientID: '67890',
      AccessionNumber: 'A2',
      Modality: 'MR',
      ScheduledProcedureStepID: 'SPS2',
      StudyInstanceUID: '1.2.826.0.1.3680043.8.1055.2',
    },
  ],
};

/**
 * Writes a worklist document into a temp dir and hands back its path.
 *
 * `async` and awaited, not merely wrapped in try/finally: a synchronous finally
 * around an async callback removes the directory before the callback has read
 * it, and the failure looks like a missing worklist rather than a broken test.
 */
async function withWorklist(document, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mpps-envelope-'));
  try {
    const file = path.join(dir, 'wl.json');
    fs.writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');
    return await fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The envelope on the paths that never reach the wire
// ---------------------------------------------------------------------------

test('start --json emits a document for a Type 1 validation error', async () => {
  // The reported failure verbatim: this exits 2 having sent nothing, and used
  // to print a paragraph of English to stderr with an empty stdout.
  const { code, stdout } = await run([
    'start', '--json', '--host', '127.0.0.1', '--port', '11112',
    '--called-ae', 'MPPSSCP', '--modality', 'CT',
  ]);

  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'mpps start');
  assert.equal(code, 2);
  assert.equal(envelope.exitCode, 2);
  assert.equal(envelope.outcome, 'usage');
  assert.equal(envelope.ok, false);
  // The attribute names are in the message because that is what has to be
  // fixed; a caller that wants to branch uses `outcome`, not this.
  assert.match(envelope.message, /PerformedProcedureStepID/);
  assert.match(envelope.message, /StudyInstanceUID/);
});

test('every verb answers a usage error with a document, not prose', async () => {
  const cases = [
    { command: 'mpps start', argv: ['start', '--json', '--modality', 'CT'] },
    { command: 'mpps update', argv: ['update', '--json'] },
    { command: 'mpps complete', argv: ['complete', '--json'] },
    { command: 'mpps discontinue', argv: ['discontinue', '--json'] },
    { command: 'mpps perform', argv: ['perform', '--json'] },
    // The dispatcher's own refusal is a terminal path too.
    { command: 'mpps', argv: ['bogus', '--json'] },
  ];

  for (const { command, argv } of cases) {
    const { code, stdout, stderr } = await run(argv);
    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, command);
    assert.equal(envelope.outcome, 'usage', `${command}: ${envelope.message}`);
    assert.equal(code, 2, command);
    assert.ok(
      !stderr.includes('"schema": "dcm.result/'),
      `${command} put a document on stderr, which is not part of the contract`
    );
    assert.ok(stderr.length > 0, `${command} should still say something to a person`);
  }
});

test('a dry run is an ok envelope carrying the dataset that would be sent', async () => {
  const { code, stdout } = await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
  ]);

  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'mpps start');
  assert.equal(code, 0);
  assert.equal(envelope.outcome, 'ok');
  assert.equal(envelope.dryRun, true);
  assert.equal(envelope.dataset.PerformedProcedureStepStatus, 'IN PROGRESS');
  // No association was opened, so there is no peer to report. An envelope that
  // named one would be claiming a conversation that never happened.
  assert.equal(envelope.peer, undefined);
});

test('the payload keeps the keys the MCP layer and existing scripts read', async () => {
  // Flat rather than nested under `data`, which is what lets a consumer written
  // before the envelope keep working. These are the keys src/commands/mcp reads
  // off an mpps document by name.
  const { stdout } = await run(['update', '2.25.1', '--dry-run', '--json']);
  const envelope = oneEnvelope(stdout);
  for (const key of ['mppsSopInstanceUid', 'statusSent', 'performedSeriesSent', 'seriesCount']) {
    assert.ok(key in envelope, `the MCP layer reads ${key} and it is gone`);
  }
});

// ---------------------------------------------------------------------------
// --from-worklist: stdin
// ---------------------------------------------------------------------------

test('--from-worklist - reads a real pipe rather than a file called "-"', () => {
  // Spawned rather than called in-process, and that is the point: fd 0 is what
  // has to work. An in-process test would have to fake standard input, which
  // would prove nothing about the thing that was broken — path.resolve('-')
  // turning a pipe into a filename.
  const document = JSON.stringify({ matches: [TWO_ITEMS.matches[0]] });
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', '..', 'bin', 'dcm.js'),
      'mpps', 'start', '--dry-run', '--json',
      '--from-worklist', '-', '--calling-ae', 'CT01', '--step-id', 'S1',
    ],
    { input: document, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  const envelope = oneEnvelope(result.stdout);
  assert.equal(envelope.studyInstanceUid, '1.2.826.0.1.3680043.8.1055.1');
  assert.equal(envelope.dataset.Modality, 'CT', 'the worklist supplied the modality');
  assert.equal(envelope.dataset.PatientID, '12345');
  assert.equal(envelope.worklist.fromStdin, true);
  assert.equal(envelope.worklist.source, 'standard input');
});

test('--from-worklist - with nothing piped in says so, and does not look for a file', () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', '..', 'bin', 'dcm.js'),
      'mpps', 'start', '--dry-run', '--json', '--from-worklist', '-',
    ],
    { input: '', encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  const envelope = oneEnvelope(result.stdout);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /standard input/);
  // The two failures that used to happen instead. Either would send someone
  // looking for a missing file rather than a missing pipe.
  assert.ok(!envelope.message.includes('does not exist'), envelope.message);
  assert.ok(!/proc[\\/]self/.test(envelope.message), envelope.message);
});

test('a path is still resolved, and is labelled as the path it resolved to', () => {
  // The other half of the ordering: everything that is not the stdin token goes
  // through path.resolve() exactly as before, so a relative worklist path still
  // works and the messages still name the file that was actually opened.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mpps-source-'));
  try {
    const file = path.join(dir, 'wl.json');
    fs.writeFileSync(file, '{"items":[]}', 'utf8');

    const source = mpps.readWorklistSource(file);
    assert.equal(source.fromStdin, false);
    assert.equal(source.label, path.resolve(file));
    assert.equal(source.raw, '{"items":[]}');

    // And a missing one is still a missing file rather than a missing pipe.
    assert.throws(
      () => mpps.readWorklistSource(path.join(dir, 'absent.json')),
      /does not exist/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --from-worklist: --index and --first
// ---------------------------------------------------------------------------

test('a multi-item worklist is still refused when nothing says which row', async () => {
  // The default does not move. A tool that picks a row on its own produces a
  // step attributed to the wrong order, which looks exactly like one attributed
  // to the right order.
  await withWorklist(TWO_ITEMS, async (file) => {
    const { code, stdout } = await run([
      'start', '--dry-run', '--json', '--from-worklist', file, '--step-id', 'S1',
    ]);
    const envelope = oneEnvelope(stdout);
    assert.equal(code, 2);
    assert.equal(envelope.outcome, 'usage');
    assert.match(envelope.message, /2 worklist items/);
    // The refusal names all four ways out, including the two new ones.
    for (const flag of ['--study-uid', '--accession', '--index', '--first']) {
      assert.match(envelope.message, new RegExp(flag.replace(/-/g, '\\-')));
    }
  });
});

test('--index takes the row the refusal numbered', async () => {
  await withWorklist(TWO_ITEMS, async (file) => {
    const second = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', file, '--index', '2', '--step-id', 'S1',
    ])).stdout);
    assert.equal(second.studyInstanceUid, '1.2.826.0.1.3680043.8.1055.2');
    assert.equal(second.dataset.PatientID, '67890');
    assert.equal(second.dataset.Modality, 'MR');
    assert.equal(second.worklist.index, 2);
    assert.equal(second.worklist.items, 2);

    const first = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', file, '--index', '1', '--step-id', 'S1',
    ])).stdout);
    assert.equal(first.studyInstanceUid, '1.2.826.0.1.3680043.8.1055.1');
  });
});

test('--first is --index 1, and the two together are refused', async () => {
  await withWorklist(TWO_ITEMS, async (file) => {
    const envelope = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', file, '--first', '--step-id', 'S1',
    ])).stdout);
    assert.equal(envelope.studyInstanceUid, '1.2.826.0.1.3680043.8.1055.1');
    assert.match(envelope.worklist.selectedBy, /--first of 2/);

    const both = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', file,
      '--first', '--index', '2', '--step-id', 'S1',
    ])).stdout);
    assert.equal(both.outcome, 'usage');
    assert.match(both.message, /--first is --index 1/);
  });
});

test('--index counts the rows left after --study-uid and --accession filter', async () => {
  // Otherwise the numbers in the refusal would not select what they sit next
  // to, which is worse than having no selector at all.
  await withWorklist(TWO_ITEMS, async (file) => {
    const envelope = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', file,
      '--accession', 'A2', '--index', '1', '--step-id', 'S1',
    ])).stdout);
    assert.equal(envelope.studyInstanceUid, '1.2.826.0.1.3680043.8.1055.2');
  });
});

test('--index out of range names the range rather than falling back', async () => {
  await withWorklist(TWO_ITEMS, async (file) => {
    const envelope = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', file, '--index', '7', '--step-id', 'S1',
    ])).stdout);
    assert.equal(envelope.outcome, 'usage');
    assert.match(envelope.message, /numbered 1 to 2/);
  });
});

test('--index without --from-worklist has nothing to index', async () => {
  const envelope = oneEnvelope((await run([
    'start', '--dry-run', '--json', '--index', '1', '--study-uid', '1.2.3',
    '--modality', 'CT', '--step-id', 'S1',
  ])).stdout);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /no worklist was given/);
});

test('--index 0 and --index two are refused as row numbers', async () => {
  for (const value of ['0', 'two', '-1']) {
    const envelope = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--from-worklist', 'ignored.json', '--index', value,
    ])).stdout);
    assert.equal(envelope.outcome, 'usage', value);
    assert.match(envelope.message, /whole number of 1 or more/);
  }
});

// ---------------------------------------------------------------------------
// --mpps-uid as a flag on the verbs that take it positionally
// ---------------------------------------------------------------------------

test('complete, discontinue and update take the UID either way', async () => {
  const uid = '2.25.31415926535897932384626433832795028841';

  for (const verb of ['complete', 'discontinue', 'update']) {
    const positional = oneEnvelope((await run([verb, uid, '--dry-run', '--json'])).stdout);
    const flagged = oneEnvelope((await run([verb, '--mpps-uid', uid, '--dry-run', '--json'])).stdout);

    assert.equal(positional.mppsSopInstanceUid, uid, verb);
    assert.equal(flagged.mppsSopInstanceUid, uid, verb);
    assert.deepEqual(flagged.dataset, positional.dataset, `${verb}: same UID, same message`);
  }
});

test('two different UIDs on one command line are refused, not resolved', async () => {
  const envelope = oneEnvelope((await run([
    'complete', '2.25.1', '--mpps-uid', '2.25.2', '--dry-run', '--json',
  ])).stdout);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /close by mistake/);
});

test('the same UID twice is refused too, because one of them is redundant', async () => {
  const envelope = oneEnvelope((await run([
    'complete', '2.25.1', '--mpps-uid', '2.25.1', '--dry-run', '--json',
  ])).stdout);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /given twice/);
});

test('a malformed --mpps-uid is named as the flag it was given as', async () => {
  const envelope = oneEnvelope((await run([
    'complete', '--mpps-uid', 'not a uid', '--dry-run', '--json',
  ])).stdout);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /--mpps-uid/);
});

// ---------------------------------------------------------------------------
// --set
// ---------------------------------------------------------------------------

test('the tokenizer binds --set Key=Value rather than reading it as a pair', () => {
  // `set` is in PAIR_VALUED_FLAGS in src/lib/args.js, which is what stops
  // `--set PatientSex=male` being split into a bare matching key and a valueless
  // flag. Pinned here because the whole feature rests on it and nothing else in
  // this file would fail if it changed.
  const parsed = tokenize(['start', '--set', 'PatientSex=male', '--set', 'Modality=ct']);
  assert.deepEqual(parsed.flags.get('set'), ['PatientSex=male', 'Modality=ct']);
  assert.deepEqual(parsed.pairs, [], 'nothing was mistaken for a C-FIND matching key');
});

test('--set stamps the value into the N-CREATE byte for byte', async () => {
  const { stdout, stderr } = await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
    '--set', 'PatientSex=male',
    '--set', 'PerformedProcedureStepStatus=STARTED',
  ]);

  const envelope = oneEnvelope(stdout);
  // Verbatim: lowercase where CS is upper-case only, and a status outside the
  // three PS3.4 defines. Neither is corrected on the way out.
  assert.equal(envelope.dataset.PatientSex, 'male');
  assert.equal(envelope.dataset.PerformedProcedureStepStatus, 'STARTED');

  // The banner, and the record inside the document. Both, always: --quiet
  // silences the banner and a caller reading JSON never sees stderr.
  assert.match(stderr, /--set is stamping 2 attributes into the N-CREATE dataset verbatim/);
  assert.deepEqual(envelope.injected, [
    { tag: '(0010,0040)', attribute: 'PatientSex', value: 'male' },
    { tag: '(0040,0252)', attribute: 'PerformedProcedureStepStatus', value: 'STARTED' },
  ]);
});

test('--set reaches into a sequence when the path names one', async () => {
  const envelope = oneEnvelope((await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
    '--set', 'ScheduledStepAttributesSequence/StudyInstanceUID=not-a-uid',
  ])).stdout);

  // The UID validation --study-uid runs is bypassed entirely, which is the
  // point: an SCP's handling of a malformed correlation key cannot be tested
  // through a flag that refuses malformed correlation keys.
  assert.equal(
    envelope.dataset.ScheduledStepAttributesSequence[0].StudyInstanceUID, 'not-a-uid'
  );
});

test('--set is applied last, so it overwrites the flag that built the attribute', async () => {
  const envelope = oneEnvelope((await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
    '--set', 'Modality=ct',
  ])).stdout);
  assert.equal(envelope.dataset.Modality, 'ct', '--set won, not --modality');
});

test('--set exempts a Type 1 by name, and only by name', async () => {
  // The one question that cannot be asked any other way: what does this SCP do
  // with a Type 1 that is present and empty?
  const named = oneEnvelope((await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--step-id', 'S1', '--set', 'Modality=',
  ])).stdout);
  assert.equal(named.outcome, 'ok');
  assert.equal(named.dataset.Modality, '', 'present and empty, which is the shape under test');

  // Nothing was said about PerformedProcedureStepID, so it is still checked.
  const unnamed = oneEnvelope((await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--set', 'Modality=',
  ])).stdout);
  assert.equal(unnamed.outcome, 'usage');
  assert.match(unnamed.message, /PerformedProcedureStepID/);
  assert.ok(!unnamed.message.includes('Modality'), 'the exempted attribute is not re-reported');
});

test('--set refuses a value the encoder would silently shorten, on the dry run too', async () => {
  // The dry run is where a person reads the dataset and decides whether to send
  // it, so a dry run printing a value that would not survive is the worst place
  // for this to be missed.
  const envelope = oneEnvelope((await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
    '--set', 'PerformedStationAETitle=SEVENTEENCHARSXXX',
  ])).stdout);

  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /17 characters/);
  assert.match(envelope.message, /SEVENTEENCHARSXX"? \(16\)/);
});

test('--set refuses a tag the encoder would drop without saying so', async () => {
  for (const token of ['(0009,0010)=PRIVATE', 'NotAKeyword=1']) {
    const envelope = oneEnvelope((await run([
      'start', '--dry-run', '--json', '--calling-ae', 'CT01',
      '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1', '--set', token,
    ])).stdout);
    assert.equal(envelope.outcome, 'usage', token);
    assert.match(envelope.message, /--set/);
  }
});

test('--set works on the closing N-SET, where the status is otherwise fixed', async () => {
  const { stdout, stderr } = await run([
    'complete', '2.25.1', '--dry-run', '--json',
    '--set', 'PerformedProcedureStepStatus=FINISHED',
  ]);
  const envelope = oneEnvelope(stdout);
  assert.equal(envelope.dataset.PerformedProcedureStepStatus, 'FINISHED');
  assert.match(stderr, /into the N-SET dataset verbatim/);
  assert.deepEqual(envelope.injected, [
    { tag: '(0040,0252)', attribute: 'PerformedProcedureStepStatus', value: 'FINISHED' },
  ]);
});

test('--set on an interim update reaches past the end-time refusal', async () => {
  // `--end-time` is refused by this verb because an end time on a running step
  // is a contradiction. --set sends it anyway, deliberately and loudly, which
  // is the only way to find out how a receiver resolves that contradiction.
  const envelope = oneEnvelope((await run([
    'update', '2.25.1', '--dry-run', '--json',
    '--set', 'PerformedProcedureStepEndTime=120000',
  ])).stdout);
  assert.equal(envelope.dataset.PerformedProcedureStepEndTime, '120000');
  assert.equal(envelope.dataset.PerformedProcedureStepStatus, 'IN PROGRESS');
});

test('in human mode the injections are on stdout as well, because --quiet exists', async () => {
  const { stdout, stderr } = await run([
    'start', '--dry-run', '--calling-ae', 'CT01',
    '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
    '--set', 'PatientSex=male',
  ]);
  assert.match(stderr, /--set is stamping/);
  assert.match(stdout, /--set stamped PatientSex="male" into the N-CREATE verbatim/);
});

// ---------------------------------------------------------------------------
// The three AE Titles
// ---------------------------------------------------------------------------

test('the AE trio is in the envelope and on one line before the N-CREATE', async () => {
  const { stdout, stderr } = await run([
    'start', '--dry-run', '--json', '--calling-ae', 'CT01',
    '--station-ae', 'CT01', '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
  ]);

  const envelope = oneEnvelope(stdout);
  assert.deepEqual(envelope.attribution, {
    // No association is opened on a dry run, so there is no called AE to name.
    calledAe: null,
    callingAe: 'CT01',
    performedStationAeTitle: 'CT01',
    performedStationMatchesCallingAe: true,
  });
  assert.match(stderr, /AE {2}calling CT01 · performed station CT01 · called \(none\)/);
});

test('a station AE that is not the calling AE is warned about, never refused', async () => {
  // The failure is silent otherwise: the SCP answers 0x0000 and attributes the
  // step to a station it has never heard of.
  const { code, stdout, stderr } = await run([
    'start', '--dry-run', '--json', '--calling-ae', 'DCM-CLI',
    '--station-ae', 'CT01', '--study-uid', '1.2.3', '--modality', 'CT', '--step-id', 'S1',
  ]);

  const envelope = oneEnvelope(stdout);
  assert.equal(code, 0, 'a mismatch is legitimate — this tool is often not the station');
  assert.equal(envelope.attribution.performedStationAeTitle, 'CT01');
  assert.equal(envelope.attribution.callingAe, 'DCM-CLI');
  assert.equal(envelope.attribution.performedStationMatchesCallingAe, false);
  assert.match(stderr, /attributed to nobody/);
});

test('perform reports the same trio, and the archive is its own key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mpps-perform-'));
  try {
    const { generate } = require('../../tools/make-fixtures');
    await generate({ outDir: dir, quiet: true, instancesPerSeries: 1, seriesPerStudy: 1 });

    const envelope = oneEnvelope((await run([
      'perform', path.join(dir, 'study-1'), '--dry-run', '--json',
      '--calling-ae', 'CT01', '--station-ae', 'CT01', '--step-id', 'S1',
    ])).stdout);

    assert.equal(envelope.attribution.callingAe, 'CT01');
    assert.equal(envelope.attribution.performedStationAeTitle, 'CT01');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a piped worklist is read once, so perform can still stamp StudyID from it', async () => {
  // The bug this pins: `mpps perform --adopt-worklist-identity` used to re-open
  // the worklist to read StudyID, which is merely wasteful for a file and
  // impossible for a pipe — a pipe is consumed exactly once, and the second
  // read would find nothing. It would also re-run the selection from
  // --study-uid and --accession alone, which no longer describes the chosen row
  // once --index or --first made the choice.
  const { generate, uid: fixtureUid } = require('../../tools/make-fixtures');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mpps-pipe-'));
  try {
    await generate({ outDir: dir, quiet: true, instancesPerSeries: 1, seriesPerStudy: 1 });

    const document = JSON.stringify({
      matches: [
        {
          StudyInstanceUID: fixtureUid(1),
          Modality: 'CT',
          ScheduledProcedureStepID: 'SPS1',
          StudyID: 'ST9',
          PatientID: 'P1',
        },
        { StudyInstanceUID: '9.9.9', Modality: 'MR', ScheduledProcedureStepID: 'SPS2' },
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', '..', 'bin', 'dcm.js'),
        'mpps', 'perform', path.join(dir, 'study-1'), '--dry-run', '--json',
        '--from-worklist', '-', '--first',
        '--adopt-worklist-identity', '--calling-ae', 'CT01',
      ],
      { input: document, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const envelope = oneEnvelope(result.stdout);
    assert.equal(envelope.worklist.fromStdin, true);
    assert.equal(envelope.worklist.selectedBy, '--first of 2');
    // StudyID lives only in the worklist item — not in the N-CREATE, and not in
    // anything common.resolveAttributes() carries — so its presence in the
    // re-stamp plan is proof the item survived the single read.
    assert.equal(envelope.restamp.values.StudyID, 'ST9');
    assert.equal(envelope.restamp.values.PatientID, 'P1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
