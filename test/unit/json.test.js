'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startScp, runCommand, withTempDir, freePort } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');

const json = require('../../src/lib/json');
const worklist = require('../../src/lib/worklist');
const echo = require('../../src/commands/echo');
const find = require('../../src/commands/find');
const info = require('../../src/commands/info');
const tags = require('../../src/commands/tags');
const { UsageError } = require('../../src/lib/args');

/**
 * The --json result envelope.
 *
 * The thing under test is not the formatting, it is the promise: on EVERY
 * terminal path a --json command writes exactly one JSON object to stdout, and
 * that object says which of the several very different things that all exit 1
 * actually happened. So the failures here are driven for real — a dead TCP
 * port, a live receiver refusing the called AE, a genuinely malformed command
 * line — rather than by stubbing the outcome, because a stub would agree with
 * whatever the code does.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the single envelope on stdout, and fails if there is not exactly one.
 *
 * Two documents concatenated on stdout parse as neither, so "exactly one" is
 * the load-bearing half of the contract; counting the schema marker catches a
 * second document that a lenient parser would skip past. The harness captures
 * the whole of process.stdout, which the test runner also writes to, so the
 * document is scanned out rather than parsed off the whole buffer.
 *
 * @param {string} stdout
 * @returns {object}
 */
function oneEnvelope(stdout) {
  const marker = '"schema": "dcm.result/';
  const found = stdout.split(marker).length - 1;
  assert.equal(found, 1, `expected exactly one JSON envelope on stdout, found ${found}:\n${stdout}`);

  const start = stdout.indexOf('{\n  "schema"');
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

/** Every envelope must carry the pinnable identity, whatever else it says. */
function assertWellFormed(envelope, command) {
  assert.equal(envelope.schema, 'dcm.result/1');
  assert.equal(envelope.schemaVersion, json.SCHEMA_VERSION);
  assert.equal(envelope.schemaVersion, 1, 'v1 is what NewLumen pins on');
  assert.equal(envelope.command, command);
  assert.ok(Object.values(json.Outcome).includes(envelope.outcome),
    `"${envelope.outcome}" is not a declared outcome`);
  assert.equal(typeof envelope.ok, 'boolean');
  assert.equal(typeof envelope.exitCode, 'number');
}

/** A port nothing is listening on, for the transport-failure paths. */
async function deadPort() {
  // freePort() binds, reads the number back and closes, so the port is known
  // to be closed rather than merely guessed at.
  return freePort();
}

const ITEMS = [
  {
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    AccessionNumber: 'A1',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260820',
    ScheduledProcedureStepStartTime: '090000',
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
    RequestedProcedureDescription: 'BRAIN',
    StudyInstanceUID: '1.2.4',
  },
];

/** Runs the shipped receiver over a worklist file written for the test. */
async function withWorklistScp(fn, items = ITEMS) {
  return withTempDir('dcm-json-mwl', async (dir) => {
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

/** `dcm find --mwl --json` against a receiver, with whatever extra flags. */
function mwl(receiver, extra = [], keys = []) {
  return runCommand(find, [
    '--host', '127.0.0.1', '--port', String(receiver.port),
    '--called-ae', 'WORKLIST', '--mwl', '--json', ...extra, ...keys,
  ]);
}

// ---------------------------------------------------------------------------
// The module itself
// ---------------------------------------------------------------------------

test('the schema version is exported so a caller can pin on it', () => {
  assert.equal(json.SCHEMA_VERSION, 1);
  assert.equal(json.SCHEMA, 'dcm.result/1');
});

test('a payload may not shadow a reserved envelope key', () => {
  // Silently overwriting `outcome` with a command's own field would corrupt the
  // contract for every consumer at once, so it fails loudly at build time.
  for (const key of json.RESERVED_KEYS) {
    assert.throws(
      () => json.build({ command: 'find', outcome: json.Outcome.OK, payload: { [key]: 'x' } }),
      /reserved key/,
      `payload key "${key}" should have been refused`
    );
  }
});

test('an unknown outcome is refused rather than emitted', () => {
  assert.throws(
    () => json.build({ command: 'find', outcome: 'probably-fine' }),
    /not a known outcome/
  );
});

test('every outcome maps to a defined exit code, and only usage is 2', () => {
  assert.equal(json.exitCodeFor(json.Outcome.OK), 0);
  assert.equal(json.exitCodeFor(json.Outcome.MATCHED), 0);
  assert.equal(json.exitCodeFor(json.Outcome.EMPTY), 1);
  assert.equal(json.exitCodeFor(json.Outcome.REJECTED), 1);
  assert.equal(json.exitCodeFor(json.Outcome.ABORTED), 1);
  assert.equal(json.exitCodeFor(json.Outcome.TIMEOUT), 1);
  assert.equal(json.exitCodeFor(json.Outcome.NETWORK), 1);
  assert.equal(json.exitCodeFor(json.Outcome.ERROR), 1);
  assert.equal(json.exitCodeFor(json.Outcome.USAGE), 2);
});

test('exit-code precedence: usage, then a failed gate, then the expectation', () => {
  const held = { held: true };
  const failed = { held: false };

  assert.equal(json.resolveExitCode({ outcome: json.Outcome.USAGE, expectation: held }), 2,
    'nothing ran, so no expectation can be judged');
  assert.equal(json.resolveExitCode({ outcome: json.Outcome.MATCHED, expectation: held, gateFailed: true }), 1,
    'a gate a passing count could suppress is not a gate');
  assert.equal(json.resolveExitCode({ outcome: json.Outcome.EMPTY, expectation: held }), 0,
    'a held expectation is a pass even though zero rows alone is a 1');
  assert.equal(json.resolveExitCode({ outcome: json.Outcome.MATCHED, expectation: failed }), 1);
  assert.equal(json.resolveExitCode({ outcome: json.Outcome.EMPTY }), 1,
    'stating nothing must keep the existing zero-matches convention');
});

test('an expectation that was never tested does not count as held', () => {
  // The whole point. A refused association also returns zero rows locally, and
  // an --expect-empty that such a run could satisfy would pass for years.
  const declared = { flag: '--expect-empty', kind: 'empty', expected: 0 };
  const untested = json.evaluateExpectation(declared, null);

  assert.equal(untested.evaluated, false);
  assert.equal(untested.held, false);
  assert.equal(untested.actual, null);
  assert.equal(json.resolveExitCode({ outcome: json.Outcome.REJECTED, expectation: untested }), 1);

  const tested = json.evaluateExpectation(declared, 0);
  assert.equal(tested.evaluated, true);
  assert.equal(tested.held, true);
});

test('readExpectation refuses two contradictory expectations and a non-number', () => {
  const two = new Map([['expect-empty', true], ['expect-nonempty', true]]);
  assert.throws(() => json.readExpectation(two, { UsageError }), UsageError);

  const notANumber = new Map([['expect-count', 'three']]);
  assert.throws(() => json.readExpectation(notANumber, { UsageError }), UsageError);

  const negative = new Map([['expect-count', '-1']]);
  assert.throws(() => json.readExpectation(negative, { UsageError }), UsageError);

  assert.equal(json.readExpectation(new Map(), { UsageError }), undefined);
});

test('all four association failures map to four different outcomes', () => {
  // Built by the shipped reject.js describers rather than by hand, so the two
  // modules cannot drift apart in the shape they pass between them. An abort
  // and a timeout are not reachable from a test SCP, but the mapping is.
  const reject = require('../../src/lib/reject');

  const rejected = json.fromAssociationOutcome(reject.describeRejection({ result: 1, source: 1, reason: 3 }));
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.detail.associate.reason, 3);
  assert.equal(rejected.detail.retryable, false, 'a permanent rejection is not worth retrying');

  const aborted = json.fromAssociationOutcome(reject.describeAbort({ source: 2, reason: 6 }));
  assert.equal(aborted.outcome, 'aborted');
  assert.equal(aborted.detail.abort.source, 2);
  assert.equal(aborted.detail.abort.reason, 6);

  const timedOut = json.fromAssociationOutcome(reject.describeTimeout({ phase: 'pdu', timeoutMs: 60000 }));
  assert.equal(timedOut.outcome, 'timeout');
  assert.equal(timedOut.detail.timeout.phase, 'pdu');
  assert.equal(timedOut.detail.timeout.timeoutMs, 60000);

  const network = json.fromAssociationOutcome(
    reject.describeTransportError(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), { host: 'h', port: 1 })
  );
  assert.equal(network.outcome, 'network');
  assert.equal(network.detail.kind, 'transport');
  assert.equal(network.detail.transport.code, 'ENOTFOUND');

  // Four kinds, four fixes, four values. Flattening any pair of these back
  // together is the failure this discriminator exists to prevent.
  assert.equal(new Set([rejected, aborted, timedOut, network].map((r) => r.outcome)).size, 4);
});

test('the errno is recovered when the socket error was re-wrapped without it', () => {
  // dcmjs-dimse rebuilds the error, so `code` is gone and only the text says
  // what happened. "Nothing is listening" is the answer a preflight wants.
  const reject = require('../../src/lib/reject');
  const wrapped = reject.describeTransportError(
    new Error(' -> Connection error: connect ECONNREFUSED 127.0.0.1:11112'),
    { host: '127.0.0.1', port: 11112 }
  );
  assert.equal(wrapped.code, undefined, 'the precondition: reject.js has no code to work with');
  const mapped = json.fromAssociationOutcome(wrapped);
  assert.equal(mapped.detail.transport.code, 'ECONNREFUSED');
  assert.equal(mapped.detail.retryable, false,
    'a refused connection is a settled answer; telling CI to retry it wastes minutes a run');
});

test('a second document is suppressed rather than appended to stdout', () => {
  json.begin();
  const first = json.build({ command: 'find', outcome: json.Outcome.OK });
  const second = json.build({ command: 'find', outcome: json.Outcome.EMPTY });

  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    json.emit(first);
    json.emit(second);
  } finally {
    process.stdout.write = original;
  }

  const text = written.join('');
  assert.equal(text.split('"schema"').length - 1, 1, 'only the first document may reach stdout');
  json.begin();
});

// ---------------------------------------------------------------------------
// echo — the CI preflight
// ---------------------------------------------------------------------------

test('echo --json emits a document on success, naming the AE that was accepted', async () => {
  const scp = await startScp({ ae: 'TEST-SCP' });
  try {
    const { code, stdout } = await runCommand(echo, [
      '--host', '127.0.0.1', '--port', String(scp.port),
      '--called-ae', 'TEST-SCP', '--calling-ae', 'DCM-CLI', '--json',
    ]);

    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, 'echo');
    assert.equal(code, 0);
    assert.equal(envelope.outcome, 'ok');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.peer.calledAe, 'TEST-SCP');
    assert.equal(envelope.peer.callingAe, 'DCM-CLI');
    assert.equal(envelope.detail.status.code, '0x0000');
    // A green echo says nothing about storage; the document must not imply it.
    assert.equal(envelope.storageProven, false);
  } finally {
    scp.close();
  }
});

test('echo --json emits a document on ECONNREFUSED, with the transport code', async () => {
  const port = await deadPort();
  const { code, stdout, stderr } = await runCommand(echo, [
    '--host', '127.0.0.1', '--port', String(port),
    '--called-ae', 'NOBODY', '--json',
  ]);

  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'echo');
  assert.equal(code, 1);
  assert.equal(envelope.outcome, 'network');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.detail.kind, 'transport');
  assert.equal(envelope.detail.transport.code, 'ECONNREFUSED');
  assert.ok(!stderr.includes('"schema"'), 'the document belongs on stdout only');
});

test('echo --json reports a refused called AE as rejected, with the RJ numbers', async () => {
  const scp = await startScp({ ae: 'RIGHT-AE' });
  try {
    const { code, stdout } = await runCommand(echo, [
      '--host', '127.0.0.1', '--port', String(scp.port),
      '--called-ae', 'WRONG-AE', '--json',
    ]);

    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, 'echo');
    assert.equal(code, 1);
    assert.equal(envelope.outcome, 'rejected');
    assert.equal(envelope.detail.kind, 'rejected');
    // PS3.8 Table 9-21: source 1 (service-user), reason 7 (called AE not
    // recognised). The numbers are the assertable fact; the sentence is not.
    assert.equal(envelope.detail.associate.source, 1);
    assert.equal(envelope.detail.associate.reason, 7);
    assert.equal(envelope.detail.associate.permanence, 'permanent');
  } finally {
    scp.close();
  }
});

test('echo --json emits a document for a usage error and exits 2', async () => {
  const { code, stdout } = await runCommand(echo, ['--json', '--port', '104', '--called-ae', 'X']);

  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'echo');
  assert.equal(code, 2);
  assert.equal(envelope.exitCode, 2);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /--host/);
});

test('echo --json --help answers with a document rather than a wall of text', async () => {
  const { code, stdout } = await runCommand(echo, ['--help', '--json']);
  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'echo');
  assert.equal(code, 0);
  assert.equal(envelope.outcome, 'ok');
  assert.match(envelope.help, /dcm echo/);
});

test('without --json, echo keeps its prose and its exit codes', async () => {
  const port = await deadPort();
  const { code, stdout } = await runCommand(echo, [
    '--host', '127.0.0.1', '--port', String(port), '--called-ae', 'NOBODY',
  ]);
  assert.equal(code, 1);
  assert.ok(!stdout.includes('"schema"'), '--json is opt-in');
  assert.match(stdout, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// find — telling "correctly zero" from "never asked"
// ---------------------------------------------------------------------------

test('find --json distinguishes a real empty answer from a refused association', async () => {
  await withWorklistScp(async (receiver) => {
    // (a) The query ran and the peer said "nothing matches".
    const genuine = await mwl(receiver, [], ['PatientID=NOPE']);
    const empty = oneEnvelope(genuine.stdout);
    assertWellFormed(empty, 'find');
    assert.equal(empty.outcome, 'empty');
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.matches, []);
    assert.equal(genuine.code, 1, 'the documented zero-matches convention is unchanged');

    // (b) The query never ran: the wrong called AE was refused at association.
    const refused = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WRONGAE', '--mwl', '--json', 'PatientID=NOPE',
    ]);
    const rejected = oneEnvelope(refused.stdout);
    assertWellFormed(rejected, 'find');
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.count, null, 'nothing was counted, so the count is not 0');
    assert.equal(rejected.detail.associate.reason, 7);
    assert.equal(refused.code, 1);

    // Both exit 1. The discriminator, not the exit code, is what separates them.
    assert.notEqual(empty.outcome, rejected.outcome);
  });
});

test('find --json emits a document when the host is unreachable', async () => {
  const port = await deadPort();
  const { code, stdout } = await runCommand(find, [
    '--host', '127.0.0.1', '--port', String(port),
    '--called-ae', 'WORKLIST', '--mwl', '--json',
  ]);

  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'find');
  assert.equal(code, 1);
  assert.equal(envelope.outcome, 'network');
  assert.equal(envelope.detail.transport.code, 'ECONNREFUSED');
  assert.equal(envelope.count, null);
});

test('find --json emits a document for a usage error before any association', async () => {
  const { code, stdout } = await runCommand(find, [
    '--host', '127.0.0.1', '--port', '11112', '--called-ae', 'ARCHIVE',
    '--series', '--json',
  ]);

  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'find');
  assert.equal(code, 2);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /StudyInstanceUID/);
});

test('find --json carries both AE Titles on every path, refused or not', async () => {
  await withWorklistScp(async (receiver) => {
    const ok = oneEnvelope((await mwl(receiver)).stdout);
    assert.equal(ok.peer.calledAe, 'WORKLIST');
    assert.equal(ok.peer.callingAe, 'DCM-CLI');

    const refused = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WRONGAE', '--calling-ae', 'STATION1', '--mwl', '--json',
    ]);
    const bad = oneEnvelope(refused.stdout);
    assert.equal(bad.peer.calledAe, 'WRONGAE');
    assert.equal(bad.peer.callingAe, 'STATION1');
  });
});

test('find --json-raw is the same envelope, marked raw', async () => {
  await withWorklistScp(async (receiver) => {
    const { code, stdout } = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WORKLIST', '--mwl', '--json-raw',
    ]);
    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, 'find');
    assert.equal(code, 0);
    assert.equal(envelope.outcome, 'matched');
    assert.equal(envelope.raw, true);
    assert.equal(envelope.count, 2);
  });
});

// ---------------------------------------------------------------------------
// The expectation flags
// ---------------------------------------------------------------------------

test('--expect-empty passes on a genuine empty answer and exits 0', async () => {
  await withWorklistScp(async (receiver) => {
    const { code, stdout } = await mwl(receiver, ['--expect-empty'], ['PatientID=NOPE']);
    const envelope = oneEnvelope(stdout);

    assert.equal(code, 0, 'the caller asked "is it empty?" and it is');
    assert.equal(envelope.exitCode, 0);
    assert.equal(envelope.outcome, 'empty', 'the outcome still reports what happened');
    assert.equal(envelope.expectation.kind, 'empty');
    assert.equal(envelope.expectation.evaluated, true);
    assert.equal(envelope.expectation.held, true);
    assert.equal(envelope.expectation.actual, 0);
  });
});

test('--expect-empty FAILS when the association was refused, not silently passing', async () => {
  // NewLumen's single most valuable assertion is an expected-empty one, and the
  // failure mode that would make it worthless is a wrong Called AE reading as
  // "correctly zero". This is that test.
  await withWorklistScp(async (receiver) => {
    const { code, stdout } = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WRONGAE', '--mwl', '--json', '--expect-empty',
    ]);
    const envelope = oneEnvelope(stdout);

    assert.equal(code, 1);
    assert.equal(envelope.outcome, 'rejected');
    assert.equal(envelope.expectation.evaluated, false);
    assert.equal(envelope.expectation.held, false);
    assert.equal(envelope.expectation.actual, null);
  });
});

test('--expect-empty also fails when the host is unreachable', async () => {
  const port = await deadPort();
  const { code, stdout } = await runCommand(find, [
    '--host', '127.0.0.1', '--port', String(port),
    '--called-ae', 'WORKLIST', '--mwl', '--json', '--expect-empty',
  ]);
  const envelope = oneEnvelope(stdout);
  assert.equal(code, 1);
  assert.equal(envelope.outcome, 'network');
  assert.equal(envelope.expectation.held, false);
  assert.equal(envelope.expectation.evaluated, false);
});

test('--expect-count answers exactly the question it was asked', async () => {
  await withWorklistScp(async (receiver) => {
    const right = await mwl(receiver, ['--expect-count', '2']);
    assert.equal(right.code, 0);
    const held = oneEnvelope(right.stdout);
    assert.equal(held.expectation.expected, 2);
    assert.equal(held.expectation.actual, 2);
    assert.equal(held.expectation.held, true);

    const wrong = await mwl(receiver, ['--expect-count', '5']);
    assert.equal(wrong.code, 1, 'two matches is a failure when five were expected');
    const missed = oneEnvelope(wrong.stdout);
    assert.equal(missed.outcome, 'matched', 'the query still succeeded; the belief did not');
    assert.equal(missed.expectation.held, false);
    assert.equal(missed.expectation.actual, 2);
  });
});

test('--expect-nonempty passes with rows and fails without them', async () => {
  await withWorklistScp(async (receiver) => {
    const some = await mwl(receiver, ['--expect-nonempty']);
    assert.equal(some.code, 0);
    assert.equal(oneEnvelope(some.stdout).expectation.held, true);

    const none = await mwl(receiver, ['--expect-nonempty'], ['PatientID=NOPE']);
    assert.equal(none.code, 1);
    const envelope = oneEnvelope(none.stdout);
    assert.equal(envelope.outcome, 'empty');
    assert.equal(envelope.expectation.held, false);
    assert.equal(envelope.expectation.expected, null);
  });
});

test('two expectations at once is a usage error, with a document', async () => {
  const { code, stdout } = await runCommand(find, [
    '--host', '127.0.0.1', '--port', '11112', '--called-ae', 'ARCHIVE',
    '--json', '--expect-empty', '--expect-nonempty',
  ]);
  const envelope = oneEnvelope(stdout);
  assert.equal(code, 2);
  assert.equal(envelope.outcome, 'usage');
  assert.match(envelope.message, /--expect-empty and --expect-nonempty/);
});

test('an expectation works without --json too, so a shell script can use it', async () => {
  await withWorklistScp(async (receiver) => {
    const { code, stdout } = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WORKLIST', '--mwl', '--expect-empty', 'PatientID=NOPE',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /0 matches/);
  });
});

// ---------------------------------------------------------------------------
// The calling-AE asymmetry warning
// ---------------------------------------------------------------------------

test('a scheduled station that differs from --calling-ae warns, and never refuses', async () => {
  await withWorklistScp(async (receiver) => {
    const { code, stdout, stderr } = await mwl(receiver, ['--calling-ae', 'DCM-CLI']);
    const envelope = oneEnvelope(stdout);

    assert.equal(code, 0, 'a mismatch is legitimate: this tool need not be the station');
    assert.equal(envelope.outcome, 'matched');

    assert.match(stderr, /calling-ae is DCM-CLI/);
    assert.match(stderr, /PERFORMED STATION AE/,
      'the warning has to explain the asymmetry, not just note a difference');

    // The three AE Titles that decide attribution, so CI can assert on them.
    assert.equal(envelope.attribution.calledAe, 'WORKLIST');
    assert.equal(envelope.attribution.callingAe, 'DCM-CLI');
    assert.deepEqual(envelope.attribution.scheduledStationAeTitles, ['CT01', 'MR01']);
    assert.deepEqual(envelope.attribution.mismatchedStationAeTitles, ['CT01', 'MR01']);
    assert.equal(envelope.attribution.callingAeMatchesScheduledStation, false);
  });
});

test('no warning when the calling AE is the scheduled station', async () => {
  await withWorklistScp(async (receiver) => {
    const { code, stdout, stderr } = await mwl(
      receiver, ['--calling-ae', 'CT01'], ['ScheduledStationAETitle=CT01']
    );
    const envelope = oneEnvelope(stdout);

    assert.equal(code, 0);
    assert.equal(envelope.count, 1);
    assert.equal(envelope.attribution.callingAeMatchesScheduledStation, true);
    assert.deepEqual(envelope.attribution.mismatchedStationAeTitles, []);
    assert.doesNotMatch(stderr, /calling-ae is/, 'agreement must be silent');
  });
});

test('no rows named a station: "nothing said" is not "they disagree"', () => {
  const silent = find.attributionOf([{ PatientID: '1' }], { callingAe: 'X', calledAe: 'Y' });
  assert.deepEqual(silent.scheduledStationAeTitles, []);
  assert.equal(silent.callingAeMatchesScheduledStation, null);

  const agreeing = find.attributionOf(
    [{ ScheduledStationAETitle: 'X' }], { callingAe: 'X', calledAe: 'Y' }
  );
  assert.equal(agreeing.callingAeMatchesScheduledStation, true);
});

test('a study-level query carries no attribution block', async () => {
  await withWorklistScp(async (receiver) => {
    const { stdout } = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', 'WORKLIST', '--json',
    ]);
    const envelope = oneEnvelope(stdout);
    assert.equal(envelope.level, 'study');
    assert.equal(envelope.attribution, undefined,
      'MPPS attribution is a worklist concern; a study query has nothing to say about it');
  });
});

// ---------------------------------------------------------------------------
// info and tags
// ---------------------------------------------------------------------------

test('info --json emits the envelope, with the inventory still at the top level', async () => {
  await withTempDir('dcm-json-info', async (dir) => {
    const src = path.join(dir, 'src');
    await generate({ outDir: src, quiet: true, studies: 1, seriesPerStudy: 1, instancesPerSeries: 2, rows: 16, cols: 16 });

    const { code, stdout } = await runCommand(info, [src, '--json']);
    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, 'info');
    assert.equal(code, 0);
    assert.equal(envelope.outcome, 'ok');
    assert.equal(envelope.dicomInstances, 2, 'the payload keys must not have moved');
    assert.equal(envelope.studies.length, 1);
  });
});

test('info --json on a folder with no DICOM in it is empty, not an error', async () => {
  await withTempDir('dcm-json-info-empty', async (dir) => {
    const { code, stdout } = await runCommand(info, [dir, '--json']);
    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, 'info');
    assert.equal(code, 1);
    assert.equal(envelope.outcome, 'empty');
    assert.equal(envelope.dicomInstances, 0);
  });
});

test('info --expect-count answers the count question', async () => {
  await withTempDir('dcm-json-info-expect', async (dir) => {
    const src = path.join(dir, 'src');
    await generate({ outDir: src, quiet: true, studies: 1, seriesPerStudy: 1, instancesPerSeries: 3, rows: 16, cols: 16 });

    const right = await runCommand(info, [src, '--json', '--expect-count', '3']);
    assert.equal(right.code, 0);
    assert.equal(oneEnvelope(right.stdout).expectation.held, true);

    const wrong = await runCommand(info, [src, '--json', '--expect-count', '4']);
    assert.equal(wrong.code, 1);
    assert.equal(oneEnvelope(wrong.stdout).expectation.actual, 3);

    // An empty folder must not satisfy --expect-nonempty just by existing.
    const emptyDir = path.join(dir, 'nothing');
    fs.mkdirSync(emptyDir);
    const none = await runCommand(info, [emptyDir, '--json', '--expect-nonempty']);
    assert.equal(none.code, 1);
    assert.equal(oneEnvelope(none.stdout).expectation.held, false);
  });
});

test('info --json emits a document when the folder argument is missing', async () => {
  const { code, stdout } = await runCommand(info, ['--json']);
  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'info');
  assert.equal(code, 2);
  assert.equal(envelope.outcome, 'usage');
});

test('info --json emits a document when the path does not exist', async () => {
  const { code, stdout } = await runCommand(info, [
    path.join(__dirname, 'no-such-folder-8f2c'), '--json',
  ]);
  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'info');
  assert.notEqual(code, 0);
  assert.ok(['error', 'usage'].includes(envelope.outcome), `got ${envelope.outcome}`);
});

test('tags --json emits the envelope and keeps files/tags/results in place', async () => {
  await withTempDir('dcm-json-tags', async (dir) => {
    const src = path.join(dir, 'src');
    await generate({ outDir: src, quiet: true, studies: 1, seriesPerStudy: 1, instancesPerSeries: 1, rows: 16, cols: 16 });

    const { code, stdout } = await runCommand(tags, [src, '--json']);
    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, 'tags');
    assert.equal(code, 0);
    assert.equal(envelope.outcome, 'matched');
    assert.equal(envelope.files, 1);
    assert.ok(envelope.results[0].tags.length > 0);
  });
});

test('tags --expect-empty proves an identifier is gone, and cannot be fooled by an unreadable folder', async () => {
  await withTempDir('dcm-json-tags-expect', async (dir) => {
    const src = path.join(dir, 'src');
    await generate({ outDir: src, quiet: true, studies: 1, seriesPerStudy: 1, instancesPerSeries: 1, rows: 16, cols: 16 });

    // Nothing carries this value, so the assertion holds.
    const gone = await runCommand(tags, [src, '--json', '--value', 'NOT-IN-ANY-FILE', '--expect-empty']);
    assert.equal(gone.code, 0);
    const envelope = oneEnvelope(gone.stdout);
    assert.equal(envelope.outcome, 'empty');
    assert.equal(envelope.expectation.held, true);

    // The same assertion against a folder holding no DICOM at all must NOT
    // pass: nothing was examined, so nothing was proved.
    const emptyDir = path.join(dir, 'nothing');
    fs.mkdirSync(emptyDir);
    const nothing = await runCommand(tags, [emptyDir, '--json', '--value', 'NOT-IN-ANY-FILE', '--expect-empty']);
    assert.equal(nothing.code, 1);
    const unread = oneEnvelope(nothing.stdout);
    assert.equal(unread.outcome, 'error');
    assert.equal(unread.expectation.evaluated, false);
    assert.equal(unread.expectation.held, false);
  });
});

test('tags --json emits a document when the target is missing', async () => {
  const { code, stdout } = await runCommand(tags, ['--json']);
  const envelope = oneEnvelope(stdout);
  assertWellFormed(envelope, 'tags');
  assert.equal(code, 2);
  assert.equal(envelope.outcome, 'usage');
});

test('an unknown flag is a usage document, not bare prose, on every command', async () => {
  for (const [name, mod, argv] of [
    ['echo', echo, ['--host', 'x', '--port', '1', '--called-ae', 'A', '--nope', '--json']],
    ['find', find, ['--host', 'x', '--port', '1', '--called-ae', 'A', '--nope', '--json']],
    ['info', info, ['.', '--nope', '--json']],
    ['tags', tags, ['.', '--nope', '--json']],
  ]) {
    const { code, stdout } = await runCommand(mod, argv);
    const envelope = oneEnvelope(stdout);
    assertWellFormed(envelope, name);
    assert.equal(code, 2, `${name} should exit 2 on an unknown flag`);
    assert.equal(envelope.outcome, 'usage');
    assert.match(envelope.message, /Unknown option/);
  }
});
