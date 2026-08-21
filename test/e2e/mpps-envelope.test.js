'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const { startScp, freePort, withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');
const log = require('../../src/lib/log');
const json = require('../../src/lib/json');
const { tokenize } = require('../../src/lib/args');
const dispatcher = require('../../src/commands/mpps');

/**
 * The --json envelope on the paths that need a peer.
 *
 * The four ways an N-service round trip fails have four different fixes, and
 * before the envelope they were one exit code and four paragraphs of English
 * apart. So none of them is stubbed here: the refusal comes from a live
 * receiver told to expect a different Called AE, the transport failure from a
 * port nothing is listening on, the protocol refusal from a real step that has
 * already reached a terminal status. A stub would agree with whatever the code
 * does, which is the one thing a test must not do.
 */

const CALLED_AE = 'MPPS-SCP';
const STUDY_UID = '1.2.826.0.1.3680043.8.1055.20260821.1';

/** Short timeouts: everything is loopback, and a hang should fail fast. */
const TIMEOUT = ['--timeout', '5000'];

/** Runs a verb against a peer and returns the one document on stdout. */
async function mppsJson(argv, peer) {
  log.configure({ noColor: true });
  const sink = log.beginCapture();
  let code;
  try {
    code = await dispatcher.run(tokenize([
      ...argv,
      '--host', '127.0.0.1', '--port', String(peer.port),
      '--called-ae', peer.calledAe ?? CALLED_AE,
      ...TIMEOUT, '--json',
    ]));
  } finally {
    log.endCapture();
  }

  const found = sink.out.split('"schema": "dcm.result/').length - 1;
  assert.equal(
    found, 1,
    `expected exactly one envelope on stdout, found ${found}:\n${sink.out}\nstderr:\n${sink.err}`
  );
  assert.ok(
    !sink.err.includes('"schema": "dcm.result/'),
    'stderr carries prose and is never part of the contract'
  );

  return { code, stdout: sink.out, stderr: sink.err, json: JSON.parse(sink.out) };
}

/** Every envelope carries the identity a caller pins on. */
function assertWellFormed(envelope, command) {
  assert.equal(envelope.schema, 'dcm.result/1');
  assert.equal(envelope.schemaVersion, json.SCHEMA_VERSION);
  assert.equal(envelope.command, command);
  assert.ok(
    Object.values(json.Outcome).includes(envelope.outcome),
    `"${envelope.outcome}" is not a declared outcome`
  );
  assert.equal(typeof envelope.exitCode, 'number');
  assert.equal(typeof envelope.ok, 'boolean');
}

/** The shipped receiver, closed however the test ends. */
async function withReceiver(fn, config = {}) {
  const receiver = await startScp({ ae: CALLED_AE, ...config });
  try {
    return await fn(receiver);
  } finally {
    receiver.close();
  }
}

/** The flags that make a minimal, valid step. */
function step(id) {
  return ['--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', id];
}

// ---------------------------------------------------------------------------

test('a step that opens is outcome ok, and records the 0x0000 the peer answered', async () => {
  await withReceiver(async (receiver) => {
    const { code, json: envelope } = await mppsJson(
      ['start', ...step('ENV-OK'), '--calling-ae', 'CT01'], receiver
    );

    assertWellFormed(envelope, 'mpps start');
    assert.equal(code, 0);
    assert.equal(envelope.outcome, 'ok');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.performedProcedureStepStatus, 'IN PROGRESS');

    // On success as much as on failure. A positive statement that the peer
    // answered about this step is exactly what a CI preflight wants recorded;
    // an absent detail would prove nothing either way.
    assert.equal(envelope.detail.kind, 'status');
    assert.equal(envelope.detail.status.code, '0x0000');
    assert.equal(envelope.detail.status.class, 'success');

    assert.equal(envelope.peer.calledAe, CALLED_AE);
    assert.equal(envelope.peer.callingAe, 'CT01');
    assert.equal(envelope.peer.host, '127.0.0.1');
  });
});

test('the three AE Titles that decide attribution are in every start document', async () => {
  await withReceiver(async (receiver) => {
    // The station AE is deliberately not the calling AE, which is the shape
    // that produces an accepted-but-unattributed step on a real RIS.
    const { code, json: envelope, stderr } = await mppsJson(
      ['start', ...step('ENV-AE'), '--calling-ae', 'DCM-CLI', '--station-ae', 'CT01'],
      receiver
    );

    assert.equal(code, 0, 'a mismatch is warned about, never refused');
    assert.deepEqual(envelope.attribution, {
      calledAe: CALLED_AE,
      callingAe: 'DCM-CLI',
      performedStationAeTitle: 'CT01',
      performedStationMatchesCallingAe: false,
    });
    // The step really did go out naming the station AE, not the calling one.
    assert.match(stderr, /performed station CT01/);
    assert.match(stderr, /attributed to nobody/);
  });
});

test('a wrong Called AE is outcome rejected, with the numbers not the sentence', async () => {
  await withReceiver(async (receiver) => {
    const { code, json: envelope } = await mppsJson(
      ['start', ...step('ENV-REJECT'), '--calling-ae', 'CT01'],
      { port: receiver.port, calledAe: 'WRONG-AE' }
    );

    assertWellFormed(envelope, 'mpps start');
    assert.equal(code, 1);
    assert.equal(envelope.outcome, 'rejected');
    assert.equal(envelope.detail.kind, 'rejected');
    // The wire fact, assertable without touching the prose: called AE not
    // recognised is source 1, reason 7.
    assert.equal(envelope.detail.associate.source, 1);
    assert.equal(envelope.detail.associate.reason, 7);
    assert.equal(envelope.peer.calledAe, 'WRONG-AE');
    assert.equal(envelope.mppsSopInstanceUid.length > 0, true, 'the UID was still generated');
  });
});

test('nothing listening is outcome network, and is not confused with a refusal', async () => {
  // The distinction the whole discriminator exists for: "the peer said no" and
  // "there was no peer" were both exit 1 and both a paragraph on stderr.
  const port = await freePort();
  const { code, json: envelope } = await mppsJson(
    ['start', ...step('ENV-NET')], { port }
  );

  assertWellFormed(envelope, 'mpps start');
  assert.equal(code, 1);
  assert.equal(envelope.outcome, 'network');
  assert.equal(envelope.detail.transport.code, 'ECONNREFUSED');
  assert.equal(envelope.detail.retryable, false, 'a refused connection is a settled answer');
});

test('closing a step twice is outcome rejected, carrying the DIMSE status', async () => {
  // A protocol refusal rather than a negotiation one: the association was
  // accepted and the peer answered with a failure status. detail.kind tells the
  // two apart while `outcome` keeps them together as "the peer said no".
  await withReceiver(async (receiver) => {
    const opened = await mppsJson(['start', ...step('ENV-TWICE')], receiver);
    const uid = opened.json.mppsSopInstanceUid;

    const first = await mppsJson(['complete', uid], receiver);
    assert.equal(first.json.outcome, 'ok');
    assert.equal(first.json.detail.status.code, '0x0000');

    const second = await mppsJson(['complete', '--mpps-uid', uid], receiver);
    assertWellFormed(second.json, 'mpps complete');
    assert.equal(second.code, 1);
    assert.equal(second.json.outcome, 'rejected');
    assert.equal(second.json.detail.kind, 'status');
    assert.match(second.json.detail.status.code, /^0x0[13]/);
    assert.equal(second.json.detail.status.class, 'failure');
    // The rich status detail NewLumen already relies on, generalised rather
    // than dropped: the peer's own comment survives into the record.
    assert.equal(typeof second.json.detail.status.plain, 'string');
    assert.equal(second.json.performedProcedureStepStatus, 'IN PROGRESS',
      'the step is whatever the peer holds, which is not what this asked for');
  });
});

test('--mpps-uid and the positional close the same step', async () => {
  await withReceiver(async (receiver) => {
    const a = await mppsJson(['start', ...step('ENV-FLAG-A')], receiver);
    const closedByFlag = await mppsJson(
      ['complete', '--mpps-uid', a.json.mppsSopInstanceUid], receiver
    );
    assert.equal(closedByFlag.code, 0);
    assert.equal(closedByFlag.json.outcome, 'ok');
    assert.equal(closedByFlag.json.mppsSopInstanceUid, a.json.mppsSopInstanceUid);

    const b = await mppsJson(['start', ...step('ENV-FLAG-B')], receiver);
    const closedByArg = await mppsJson(['complete', b.json.mppsSopInstanceUid], receiver);
    assert.equal(closedByArg.code, 0);
    assert.equal(closedByArg.json.outcome, 'ok');
  });
});

test('--set reaches the wire: the receiver reads back the value exactly as typed', async () => {
  // The end of the promise, and the only assertion that actually settles it.
  // Everything before this proves the dataset was BUILT with the value in it;
  // this proves the encoder carried it, the association negotiated it and the
  // peer parsed it off the wire — read back out of the step the receiver wrote,
  // not out of the sender's own account of what it did.
  await withTempDir('dcm-mpps-envelope-set', async (dir) => {
    await withReceiver(async (receiver) => {
      const { code, json: envelope, stderr } = await mppsJson(
        [
          'start', ...step('ENV-SET'), '--calling-ae', 'CT01',
          '--set', 'PatientSex=male',
          '--set', 'PerformedProcedureStepDescription=lower case and  spaces',
        ],
        receiver
      );

      assert.equal(code, 0, envelope.message);
      assert.equal(envelope.outcome, 'ok');
      assert.deepEqual(envelope.injected, [
        { tag: '(0010,0040)', attribute: 'PatientSex', value: 'male' },
        {
          tag: '(0040,0254)',
          attribute: 'PerformedProcedureStepDescription',
          value: 'lower case and  spaces',
        },
      ]);
      assert.match(stderr, /--set is stamping 2 attributes into the N-CREATE dataset verbatim/);

      const written = JSON.parse(fs.readFileSync(
        path.join(dir, 'mpps', `${envelope.mppsSopInstanceUid}.json`), 'utf8'
      ));
      // The receiver stores the step under `elements`, merged across N-CREATE
      // and any later N-SET. This is what it actually parsed off the wire.
      const received = written.elements;
      assert.equal(
        received.PatientSex, 'male',
        'CS is upper-case-only in the standard; the value went out as typed anyway'
      );
      assert.equal(received.PerformedProcedureStepDescription, 'lower case and  spaces');
    }, { persist: dir });
  });
});

test('an update is the same envelope, with the interim keys alongside it', async () => {
  await withReceiver(async (receiver) => {
    const opened = await mppsJson(['start', ...step('ENV-UPDATE')], receiver);
    const updated = await mppsJson(
      ['update', '--mpps-uid', opened.json.mppsSopInstanceUid], receiver
    );

    assertWellFormed(updated.json, 'mpps update');
    assert.equal(updated.code, 0);
    assert.equal(updated.json.outcome, 'ok');
    assert.equal(updated.json.statusSent, true);
    assert.equal(updated.json.performedSeriesSent, false);
    assert.equal(updated.json.endDateTimeSent, false);
    assert.equal(updated.json.detail.status.code, '0x0000');
  });
});

test('perform reports the MPPS peer as `peer` and the archive as `storePeer`', async () => {
  // They are frequently different systems, and both have to be on the record.
  // `peer` is reserved by the envelope and means the peer this outcome is
  // about, which for an mpps verb is the MPPS one; the archive gets its own key
  // rather than being nested inside it.
  await withTempDir('dcm-mpps-envelope-perform', async (dir) => {
    await generate({ outDir: dir, quiet: true, instancesPerSeries: 1, seriesPerStudy: 1 });
    const folder = path.join(dir, 'study-1');
    const storePort = await freePort();

    await withReceiver(async (receiver) => {
      const { code, json: envelope } = await mppsJson(
        [
          'perform', folder, '--modality', 'CT', '--step-id', 'ENV-PEERS',
          '--calling-ae', 'CT01',
          '--store-host', '127.0.0.1', '--store-port', String(storePort),
          '--store-called-ae', 'ARCHIVE',
        ],
        receiver
      );

      assertWellFormed(envelope, 'mpps perform');
      assert.equal(envelope.peer.calledAe, CALLED_AE, 'the envelope peer is the MPPS peer');
      assert.equal(envelope.peer.callingAe, 'CT01');
      assert.equal(envelope.storePeer.calledAe, 'ARCHIVE');
      assert.equal(envelope.storePeer.port, storePort);
      assert.equal(envelope.attribution.performedStationAeTitle, 'CT01');

      // Nothing is listening on the store port, so not one instance can be
      // acknowledged and the step closes DISCONTINUED. The outcome names why
      // rather than leaving "1" to mean any of five things.
      assert.equal(code, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.performedProcedureStepStatus, 'DISCONTINUED');
      assert.equal(envelope.acknowledged, 0);
      assert.ok(envelope.found > 0);
      assert.ok(
        ['rejected', 'timeout', 'error'].includes(envelope.outcome),
        `a shortfall is attributed to what caused it, got ${envelope.outcome}`
      );
      // The N-SET itself succeeded, and the record says so even though the
      // transaction as a whole did not.
      assert.equal(envelope.stage, 'done');
      assert.equal(envelope.detail.status.code, '0x0000');
      assert.match(envelope.message, /unaccounted for/);
    });
  });
});
