'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dcmjsDimse = require('dcmjs-dimse');
const { Dataset } = dcmjsDimse;
const { NCreateRequest, NSetRequest } = dcmjsDimse.requests;
const { SopClass, Status } = dcmjsDimse.constants;

const { startScp, withTempDir } = require('../helpers/harness');
const { generate, uid: fixtureUid } = require('../../tools/make-fixtures');
const { runAssociation } = require('../../src/lib/dimse');
const { tokenize } = require('../../src/lib/args');
const log = require('../../src/lib/log');
const mpps = require('../../src/lib/mpps');
const dispatcher = require('../../src/commands/mpps');

/**
 * The interim N-SET and the unscheduled step, over a real association.
 *
 * Unlike test/e2e/mpps-scp.test.js, which writes its requests from the standard
 * to test the receiver, this file drives the SHIPPED COMMANDS against the
 * shipped receiver. That is the point: `dcm mpps update` exists because a
 * deployed consumer of the interim N-SET has never had a real client point at
 * it, and a test that calls the dataset builder directly would not have proved
 * that the message can be negotiated, encoded and answered.
 *
 * The sequence under test is the one a modality actually produces:
 *
 *   start -> update -> update -> complete
 *
 * with the performed series GROWING between the two updates, which is what
 * exercises a receiver's rule for merging an interim sequence into what the
 * N-CREATE established.
 */

const CALLED_AE = 'MPPS-SCP';

/**
 * The study these tests name, asked of the generator rather than copied out of
 * it, so the two cannot drift.
 */
const STUDY_UID = fixtureUid(1);

/** The two series that study holds, in the order the generator numbers them. */
const SERIES_UIDS = [fixtureUid(1, 1), fixtureUid(1, 2)];

/**
 * Writes a synthetic study inside `dir` and hands back the path to it.
 *
 * Every test here builds the study it performs. This file used to read
 * `fixtures/study-1` at the repo root — a directory .gitignore excludes so
 * that nobody commits DICOM — which meant the suite passed on the one machine
 * where an earlier manual run had left it lying around and failed on every
 * machine that had not, CI included. A test that reads state it did not create
 * reports a pass that means nothing.
 *
 * The shape is stated at the call site rather than inherited from the
 * generator's defaults, because the counts here are load-bearing: two series of
 * five instances is ten, and ten at `--chunk 4` is three associations, two
 * boundaries, and interim updates carrying four instances and then eight. Tests
 * that only need a folder with readable images in it ask for fewer and say so.
 *
 * The tree goes in a subdirectory of `dir` rather than in `dir` itself, because
 * generate() clears its output directory and the callers keep --persist stores
 * and staged copies alongside it.
 */
async function studyIn(dir, { seriesPerStudy = 2, instancesPerSeries = 5 } = {}) {
  const root = path.join(dir, 'source');
  const manifest = await generate({
    outDir: root,
    quiet: true,
    studies: 1,
    seriesPerStudy,
    instancesPerSeries,
    // Nothing below asserts anything about pixels, and 16x16 keeps ten
    // instances cheap to write in a file that already stands up receivers.
    rows: 16,
    cols: 16,
  });
  assert.equal(
    manifest.studies[0].studyInstanceUid, STUDY_UID,
    'the generated study is the one these tests name'
  );
  return path.join(root, 'study-1');
}

/** Short timeouts: everything here is loopback, and a hang should fail fast. */
const TIMEOUT = ['--timeout', '5000'];

/**
 * Runs a `dcm mpps` verb against the receiver and returns its parsed --json.
 *
 * Through the dispatcher rather than the verb module, so that verb routing is
 * covered too — `update` being reachable at all is part of what is under test.
 *
 * log.beginCapture() rather than the harness's runCommand(), and the difference
 * matters here. runCommand() swaps out process.stdout.write for the duration of
 * the command, which also swallows anything node:test's reporter writes in that
 * window — harmless for a test asserting output.includes(), fatal for one
 * parsing stdout as a single JSON document. log's own capture stack never
 * touches the process streams.
 */
async function mppsJson(receiver, argv) {
  log.configure({ noColor: true });

  const sink = log.beginCapture();
  let code;
  try {
    code = await dispatcher.run(tokenize([
      ...argv,
      '--host', '127.0.0.1',
      '--port', String(receiver.port),
      '--called-ae', CALLED_AE,
      ...TIMEOUT,
      '--json',
    ]));
  } finally {
    log.endCapture();
  }

  let parsed;
  try {
    parsed = JSON.parse(sink.out);
  } catch {
    assert.fail(
      `--json must print exactly one JSON document on stdout; got:\n${sink.out}\n` +
        `stderr:\n${sink.err}`
    );
  }
  return { code, stdout: sink.out, stderr: sink.err, output: sink.out + sink.err, json: parsed };
}

/** Starts the shipped receiver with no worklist loaded. */
async function withReceiver(fn) {
  const receiver = await startScp({ ae: CALLED_AE });
  try {
    return await fn(receiver);
  } finally {
    receiver.close();
  }
}

/**
 * Copies the first `count` instances of the study at `source` into `dir`.
 *
 * Copied rather than referenced so a folder can GROW between two updates, which
 * is the only way to make `--series-from` produce a larger sequence the second
 * time and the only honest way to rehearse a modality mid-acquisition.
 */
function stageInstances(source, dir, count) {
  const files = [];
  for (const series of fs.readdirSync(source)) {
    const seriesDir = path.join(source, series);
    for (const name of fs.readdirSync(seriesDir)) {
      files.push({ series, name, from: path.join(seriesDir, name) });
    }
  }
  files.sort((a, b) => `${a.series}/${a.name}`.localeCompare(`${b.series}/${b.name}`));

  for (const file of files.slice(0, count)) {
    const target = path.join(dir, file.series);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(file.from, path.join(target, file.name));
  }
  return dir;
}

/** Reads back the step a --persist receiver wrote for `uid`. */
function readStep(persisted, uid) {
  return JSON.parse(fs.readFileSync(path.join(persisted, 'mpps', `${uid}.json`), 'utf8'));
}

/** Instances named across a recorded step's PerformedSeriesSequence. */
function referencedIn(step) {
  const series = step.elements.PerformedSeriesSequence;
  if (!Array.isArray(series)) return null;
  return series.reduce(
    (n, item) => n + (Array.isArray(item?.ReferencedImageSequence) ? item.ReferencedImageSequence.length : 0),
    0
  );
}

/**
 * Sends hand-written N-service requests by hand, and reports the raw statuses.
 *
 * Answers are stored at the index of the request they belong to rather than
 * appended, so an assertion about the third response cannot be satisfied by
 * whichever answer happened to arrive third.
 */
async function converse(receiver, requests) {
  const responses = [];
  requests.forEach((request, index) => {
    request.on('response', (response) => {
      responses[index] = { status: response.getStatus(), comment: response.getErrorComment() };
    });
  });

  const { outcome } = await runAssociation({
    host: '127.0.0.1',
    port: receiver.port,
    callingAe: 'CT01',
    calledAe: CALLED_AE,
    requests,
    timeouts: { connect: 5000, association: 5000, pdu: 5000, linger: 50 },
  });
  assert.equal(outcome.kind, 'completed', `association did not complete: ${outcome.headline}`);
  return responses;
}

// ---------------------------------------------------------------------------
// The sequence NewLumen have no client coverage for
// ---------------------------------------------------------------------------

test('start -> update -> update -> complete, every message accepted', async () => {
  await withReceiver(async (receiver) => {
    await withTempDir('dcm-interim', async (dir) => {
      // Two series of five. The two updates below reference five instances and
      // then ten, and the first five sorted files are the whole of series-1.
      const source = await studyIn(dir);
      const growing = path.join(dir, 'acquired');
      fs.mkdirSync(growing);

      // 1. Open the step.
      const started = await mppsJson(receiver, [
        'start', '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-INTERIM',
      ]);
      assert.equal(started.code, 0, started.output);
      assert.equal(started.json.ok, true);
      assert.equal(started.json.performedProcedureStepStatus, mpps.Status.IN_PROGRESS);
      const uid = started.json.mppsSopInstanceUid;
      assert.equal(receiver.stats.mppsCreated, 1);

      // 2. First interim update: five instances acquired so far.
      //
      // --no-status leaves PerformedProcedureStepStatus out of the dataset
      // altogether, which is one of the two legal interim shapes. The other
      // re-asserts IN PROGRESS and is exercised below.
      stageInstances(source, growing, 5);
      const first = await mppsJson(receiver, [
        'update', uid, '--no-status', '--series-from', growing, '--retrieve-ae', CALLED_AE,
      ]);
      assert.equal(first.code, 0, first.output);
      assert.equal(first.json.ok, true, `the interim N-SET was refused: ${first.json.message}`);
      assert.equal(first.json.statusSent, false);
      assert.equal(first.json.instancesReferenced, 5);
      assert.equal(first.json.endDateTimeSent, false, 'a running step has not ended');

      // 3. Second interim update, with the folder grown. This is the message
      //    that exercises a receiver's merge rule: the sequence must get bigger
      //    rather than being replaced by only the new instances.
      stageInstances(source, growing, 10);
      const second = await mppsJson(receiver, [
        'update', uid, '--no-status', '--series-from', growing, '--retrieve-ae', CALLED_AE,
      ]);
      assert.equal(second.code, 0, second.output);
      assert.equal(second.json.ok, true);
      assert.equal(
        second.json.instancesReferenced, 10,
        'the second update carries the CUMULATIVE sequence — N-SET replaces, it does not append'
      );
      assert.ok(
        second.json.instancesReferenced > first.json.instancesReferenced,
        'the performed series grew between the two updates'
      );

      // Neither update closed the step: the receiver still has it running, so
      // it has not been counted as completed or discontinued.
      assert.equal(receiver.stats.mppsCompleted, 0);
      assert.equal(receiver.stats.mppsDiscontinued, 0);

      // The SCP's own status enforcement did not refuse either interim.
      assert.equal(
        receiver.stats.mppsRefused, 0,
        'the receiver refused an interim N-SET it should have accepted'
      );

      // 4. Close it. A step that took two interim updates must still be
      //    completable — an update must not have walked it into a state the
      //    terminal N-SET cannot leave.
      const done = await mppsJson(receiver, ['complete', uid, '--series-from', growing]);
      assert.equal(done.code, 0, done.output);
      assert.equal(done.json.ok, true);
      assert.equal(done.json.performedProcedureStepStatus, mpps.Status.COMPLETED);
      assert.equal(receiver.stats.mppsCompleted, 1);
      assert.equal(receiver.stats.mppsRefused, 0);
    });
  });
});

test('a later update REPLACES the performed series rather than appending to it', async () => {
  // NewLumen's COALESCE rule is about exactly this. N-SET is attribute-level
  // replacement (PS3.4 F.7.2), so an update naming only what was acquired since
  // the last one does not add those series — it erases the earlier ones. The
  // second update below names only series-2, and the step ends up holding only
  // series-2.
  //
  // This is what makes `--series-from` scan the WHOLE folder rather than a
  // delta, and it is why omitting the sequence entirely has to be expressible:
  // omitting is the only way to leave what the step holds alone.
  await withTempDir('dcm-replace', async (dir) => {
    // What is counted here is SERIES, not instances: two series, and one
    // instance in each is enough to make either of them a legal update. The two
    // must carry different Series Instance UIDs, which the generator gives them
    // unless it is asked for the colliding-UID defect.
    const source = await studyIn(dir, { instancesPerSeries: 1 });
    const persisted = path.join(dir, 'persisted');
    const receiver = await startScp({ ae: CALLED_AE, persist: persisted });
    try {
      const started = await mppsJson(receiver, [
        'start', '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-REPLACE',
      ]);
      const uid = started.json.mppsSopInstanceUid;

      const seriesOf = (name) => {
        const only = path.join(dir, name);
        fs.mkdirSync(only, { recursive: true });
        for (const file of fs.readdirSync(path.join(source, name))) {
          fs.copyFileSync(path.join(source, name, file), path.join(only, file));
        }
        return only;
      };

      const first = await mppsJson(receiver, [
        'update', uid, '--no-status', '--series-from', seriesOf('series-1'),
      ]);
      assert.equal(first.json.ok, true, first.output);
      assert.equal(first.json.seriesCount, 1);

      const second = await mppsJson(receiver, [
        'update', uid, '--no-status', '--series-from', seriesOf('series-2'),
      ]);
      assert.equal(second.json.ok, true, second.output);
      assert.equal(second.json.seriesCount, 1);

      const step = JSON.parse(
        fs.readFileSync(path.join(persisted, 'mpps', `${uid}.json`), 'utf8')
      );
      assert.equal(
        step.elements.PerformedSeriesSequence.length, 1,
        'the second update replaced the first series rather than being added to it'
      );
      assert.notEqual(
        step.elements.PerformedSeriesSequence[0].SeriesInstanceUID,
        first.json.performedSeriesSource,
        'and what survives is the sequence the LAST update carried'
      );
      // The same claim, checked against the UID rather than against the label
      // `performedSeriesSource` carries. Nameable only because this test now
      // generates the study and therefore knows which UID belongs to which
      // series: series-2 went second, so series-2 is what is left.
      assert.equal(
        step.elements.PerformedSeriesSequence[0].SeriesInstanceUID,
        SERIES_UIDS[1],
        'the surviving series is the one the second update named, not the first'
      );
      assert.equal(step.status, mpps.Status.IN_PROGRESS, 'the step is still open throughout');
    } finally {
      receiver.close();
    }
  });
});

test('the keep-alive update carries IN PROGRESS and leaves the performed series alone', async () => {
  // The keep-alive shape: nothing new to report, the device is still there. It
  // is the message a sweeper on the far end uses to tell a running exam from a
  // dead one, and it carries a status and no PerformedSeriesSequence.
  //
  // It cannot be sent with --no-status, because a dataset with neither a status
  // nor a sequence carries nothing at all and is refused before it is sent.
  //
  // This receiver used to answer it 0x0106 because it re-asserts IN PROGRESS.
  // That was wrong — PS3.4 F.7.2-1 lists PerformedProcedureStepStatus among the
  // attributes an N-SET may carry — so what is asserted now is the pair that
  // makes the shape useful: the receiver accepts it, and it deposits nothing.
  await withTempDir('dcm-keepalive', async (dir) => {
    // Two series of five: the first update deposits all ten, and the ten is
    // what the keep-alive then has to leave alone.
    const source = await studyIn(dir);
    const persisted = path.join(dir, 'persisted');
    const receiver = await startScp({ ae: CALLED_AE, persist: persisted });
    try {
      const started = await mppsJson(receiver, [
        'start', '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-ALIVE',
      ]);
      const uid = started.json.mppsSopInstanceUid;

      // Something for the keep-alive to leave alone. Without it, "left the
      // series untouched" would be a claim about an empty sequence and would
      // hold whatever the receiver did with the message.
      const deposited = await mppsJson(receiver, [
        'update', uid, '--no-status', '--series-from', source,
      ]);
      assert.equal(deposited.json.ok, true, deposited.output);
      const held = referencedIn(readStep(persisted, uid));
      assert.equal(held, 10, 'the whole generated study, deposited by the first update');

      const alive = await mppsJson(receiver, ['update', uid]);
      assert.equal(alive.code, 0, alive.output);
      assert.equal(alive.json.ok, true, `the keep-alive was refused: ${alive.json.message}`);
      assert.equal(alive.json.status.code, '0x0000');
      assert.equal(alive.json.statusSent, true);
      assert.equal(alive.json.statusValue, mpps.Status.IN_PROGRESS);
      assert.equal(
        alive.json.performedSeriesSent, false,
        'omitting the sequence is what leaves the step\'s own series untouched'
      );
      assert.equal(alive.json.endDateTimeSent, false);

      // What the receiver actually holds afterwards, which is the half the
      // client cannot see.
      const after = readStep(persisted, uid);
      assert.equal(after.status, mpps.Status.IN_PROGRESS, 'a keep-alive does not close the step');
      assert.equal(after.updates, 2, 'it was taken as an update, not discarded as a no-op');
      assert.equal(
        referencedIn(after), held,
        'an absent PerformedSeriesSequence is not an empty one and must erase nothing'
      );
      assert.equal(receiver.stats.mppsRefused, 0);
      assert.equal(receiver.stats.mppsCompleted, 0);
    } finally {
      receiver.close();
    }
  });
});

test('a terminal step refuses a later interim update, and says why', async () => {
  // The rule the self-edge must not have loosened. Once the step is COMPLETED,
  // an interim update is refused — by this end if it can tell, and by the
  // receiver with 0x0110 if it cannot.
  await withTempDir('dcm-terminal', async (dir) => {
    // What the folder holds is incidental: the refusal is about the step's
    // state, not about the sequence. It only has to hold enough for the update
    // to be a legal message at all, which one instance per series is.
    const source = await studyIn(dir, { instancesPerSeries: 1 });
    await withReceiver(async (receiver) => {
      const started = await mppsJson(receiver, [
        'start', '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-CLOSED',
      ]);
      const uid = started.json.mppsSopInstanceUid;

      assert.equal((await mppsJson(receiver, ['complete', uid])).json.ok, true);

      const late = await mppsJson(receiver, [
        'update', uid, '--no-status', '--series-from', source,
      ]);
      assert.equal(late.code, 1, 'an update on a closed step must fail');
      assert.equal(late.json.ok, false);
      assert.equal(
        late.json.status.code, '0x0110',
        'PS3.4 F.8.2: a terminal step may no longer be updated'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The two interim shapes, at the wire level
// ---------------------------------------------------------------------------

test('the status-absent interim N-SET is accepted by this receiver', async () => {
  await withReceiver(async (receiver) => {
    const uid = '2.25.100000000000000000000000000000000001';
    const create = new NCreateRequest(SopClass.ModalityPerformedProcedureStep, uid);
    create.setDataset(new Dataset(mpps.buildCreateDataset({
      studyInstanceUid: STUDY_UID,
      performedProcedureStepId: 'PPS-A',
      performedStationAeTitle: 'CT01',
      startDate: '20260821',
      startTime: '090000',
      modality: 'CT',
    })));

    const set = new NSetRequest(SopClass.ModalityPerformedProcedureStep, uid);
    set.setDataset(new Dataset(mpps.buildInterimSetDataset({
      performedSeries: [{
        SeriesInstanceUID: `${STUDY_UID}.1`,
        ReferencedImageSequence: [
          { ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2', ReferencedSOPInstanceUID: `${STUDY_UID}.1.1` },
        ],
      }],
    })));

    const responses = await converse(receiver, [create, set]);
    assert.equal(responses[0].status, Status.Success);
    assert.equal(responses[1].status, Status.Success, 'no status attribute means "still running"');
  });
});

test('an N-SET may re-assert IN PROGRESS; a status that is not a state is still refused', async () => {
  // This receiver used to answer the first N-SET below with 0x0106 Invalid
  // Attribute Value. That was a bug: PS3.4 F.7.2-1 lists
  // PerformedProcedureStepStatus among the attributes an N-SET may carry and
  // F.8.2 closes only the terminal states, so re-asserting IN PROGRESS is a
  // legal message — and refusing it is what makes a modality abandon the
  // session and leave the worklist entry uncleared.
  //
  // The paired refusal is the point of testing them together. Only one edge of
  // the transition graph opened: a status that names no state at all is still
  // 0x0106, so the enforcement is intact rather than switched off, and the two
  // are still genuinely different code paths in the receiver.
  await withReceiver(async (receiver) => {
    const uid = '2.25.100000000000000000000000000000000002';
    const create = new NCreateRequest(SopClass.ModalityPerformedProcedureStep, uid);
    create.setDataset(new Dataset(mpps.buildCreateDataset({
      studyInstanceUid: STUDY_UID,
      performedProcedureStepId: 'PPS-B',
      performedStationAeTitle: 'CT01',
      startDate: '20260821',
      startTime: '090000',
      modality: 'CT',
    })));

    const inProgress = new NSetRequest(SopClass.ModalityPerformedProcedureStep, uid);
    inProgress.setDataset(new Dataset(mpps.buildInterimSetDataset({
      status: mpps.Status.IN_PROGRESS,
    })));

    // Written out by hand, because buildInterimSetDataset() refuses this shape
    // at the client — which is exactly why the receiver's own guard has to be
    // reached by a request the client would never build.
    const invented = new NSetRequest(SopClass.ModalityPerformedProcedureStep, uid);
    invented.setDataset(new Dataset({ PerformedProcedureStepStatus: 'PAUSED' }));

    const close = new NSetRequest(SopClass.ModalityPerformedProcedureStep, uid);
    close.setDataset(new Dataset(mpps.buildSetDataset({
      status: mpps.Status.COMPLETED, endDate: '20260821', endTime: '093000',
    })));

    const responses = await converse(receiver, [create, inProgress, invented, close]);
    assert.equal(responses[0].status, Status.Success);
    assert.equal(
      responses[1].status, Status.Success,
      'an interim N-SET re-asserting IN PROGRESS is legal and must be accepted'
    );
    assert.equal(responses[2].status, Status.InvalidAttributeValue, 'PAUSED is not a state');
    assert.match(responses[2].comment, /not a legal status/);
    assert.equal(
      responses[3].status, Status.Success,
      'and the accepted self-edge left the step in a state the closing N-SET can still take'
    );

    assert.equal(receiver.stats.mppsCompleted, 1);
    assert.equal(receiver.stats.mppsRefused, 1, 'exactly one refusal: the invented status');
  });
});

test('the two interim shapes really are different messages on the wire', () => {
  // The distinction the receiver branches on, asserted at the point it is made
  // rather than only inferred from two different response codes.
  const withStatus = mpps.buildInterimSetDataset({ status: mpps.Status.IN_PROGRESS });
  const withoutStatus = mpps.buildInterimSetDataset({ performedSeries: [] });

  assert.ok('PerformedProcedureStepStatus' in withStatus);
  assert.ok(!('PerformedProcedureStepStatus' in withoutStatus));
  for (const ds of [withStatus, withoutStatus]) {
    assert.ok(!('PerformedProcedureStepEndDate' in ds));
    assert.ok(!('PerformedProcedureStepEndTime' in ds));
  }
});

// ---------------------------------------------------------------------------
// Unscheduled steps
// ---------------------------------------------------------------------------

test('an unscheduled step is ENCODED as a sequence holding one zero-length item', async () => {
  // The part the SCU is responsible for, asserted against the bytes rather than
  // against a receiver, because the receiver turns out not to be able to read
  // them (see the next test).
  //
  // PS3.5 7.5: a sequence of undefined length holds items delimited by
  // (FFFE,E00D) and ends at (FFFE,E0DD). A zero-length item is an item tag
  // followed immediately by its delimiter — no elements in between. That is
  // what has to be on the wire, and nothing less specific will do: an omitted
  // sequence and an item carrying blank attributes are both different messages.
  const dataset = mpps.buildCreateDataset({
    performedProcedureStepId: 'WALKIN-014',
    performedStationAeTitle: 'DX01',
    startDate: '20260821',
    startTime: '101010',
    modality: 'DX',
    unscheduled: true,
  });

  const bytes = new Dataset({
    ScheduledStepAttributesSequence: dataset.ScheduledStepAttributesSequence,
  }).getDenaturalizedDataset();
  const hex = Buffer.from(bytes).toString('hex');

  // (0040,0270) little-endian implicit VR, undefined length, then one item that
  // is delimited immediately, then the sequence delimiter. Spelled out as bytes
  // rather than matched loosely, because every near-miss shape — no item, two
  // items, an item carrying one empty element — differs from this by a few
  // bytes and each of them is a different message.
  // Tags are little-endian, so each 16-bit half is byte-swapped: (FFFE,E000)
  // goes on the wire as fe ff 00 e0. Writing them out this way is the point —
  // a test that built the expectation with the same helper as the code would
  // agree with it about the wrong bytes.
  const SEQUENCE_TAG = '40007002';        // (0040,0270) ScheduledStepAttributesSequence
  const UNDEFINED_LENGTH = 'ffffffff';
  const ITEM = 'feff00e0';                // (FFFE,E000) Item
  const ITEM_DELIMITER = 'feff0de000000000';    // (FFFE,E00D), length 0
  const SEQUENCE_DELIMITER = 'feffdde000000000'; // (FFFE,E0DD), length 0

  const expected = [
    SEQUENCE_TAG, UNDEFINED_LENGTH,
    ITEM, UNDEFINED_LENGTH,
    ITEM_DELIMITER,
    SEQUENCE_DELIMITER,
  ].join('');

  assert.ok(
    hex.includes(expected),
    `expected one zero-length item on the wire (${expected}), got ${hex}`
  );
  assert.equal(
    hex.split(ITEM_DELIMITER).length - 1, 1,
    'exactly one item, not two'
  );
});

test('this receiver refuses an unscheduled step 0x0120, because dcmjs drops the empty item', async () => {
  // A SECOND FINDING, and this one is not in this repository's code at all.
  //
  // The bytes above are conformant. dcmjs's naturalising parser reads a
  // sequence holding exactly one ZERO-LENGTH item back as an EMPTY sequence —
  // the item does not survive the read. Any dcmjs-based receiver therefore sees
  // ScheduledStepAttributesSequence as absent, fails its own Type 1 check, and
  // answers 0x0120 Missing Attribute.
  //
  // That is what happens here. 0x0120 is one of the status codes this
  // receiver's enforcement is explicitly required to keep, and it is behaving
  // correctly given what it was handed — the loss happens underneath it, in the
  // library, before the handler runs.
  //
  // The consequence is worth stating plainly: an unscheduled step cannot be
  // round-tripped through a dcmjs-based receiver today. The SCU half is correct
  // and is worth having, because the receivers it is pointed at in the field
  // are not dcmjs. Pinned so that a library upgrade that fixes the reader shows
  // up here as a failing test rather than going unnoticed.
  await withReceiver(async (receiver) => {
    const started = await mppsJson(receiver, [
      'start', '--unscheduled', '--modality', 'DX', '--step-id', 'WALKIN-014',
    ]);

    assert.equal(started.json.unscheduled, true);
    assert.equal(started.json.scheduledStepItems, 1, 'the client built one item');
    assert.equal(
      started.json.status.code, '0x0120',
      'if this now succeeds, dcmjs reads zero-length items — invert this assertion'
    );
    assert.match(started.json.message, /ScheduledStepAttributesSequence/);
    assert.equal(receiver.stats.mppsCreated, 0);
  });
});

test('perform --unscheduled sends nothing when the step cannot be opened', async () => {
  // Two things at once, and the second is the one that matters.
  //
  // The divergence --unscheduled creates is reported: the images would be filed
  // under the folder's study and the step names none. And because the N-CREATE
  // is refused (previous test), NOT ONE INSTANCE is sent — perform's rule that
  // a step which was never opened gets no images holds for this path too.
  await withTempDir('dcm-unscheduled', async (dir) => {
    // Two instances is enough to make "not one instance was sent" a claim about
    // something: what is asserted is zero, against a folder that is not empty.
    const source = await studyIn(dir, { instancesPerSeries: 1 });
    await withReceiver(async (receiver) => {
      const result = await mppsJson(receiver, [
        'perform', source, '--unscheduled', '--modality', 'DX', '--step-id', 'WALKIN-016',
      ]);

      assert.equal(result.code, 1);
      assert.equal(result.json.stage, 'n-create');
      assert.equal(result.json.found, 2, 'there were images to send, and none were sent');
      assert.equal(
        result.json.sent, 0, 'no images go to an archive for a step that was never opened'
      );
      assert.equal(receiver.stats.stored, 0);
    });
  });
});

test('perform --unscheduled reports the two identities separately in its dry run', async () => {
  // The divergence itself, where it can be asserted without the receiver: the
  // C-STORE would use the folder's study because that is what the archive files
  // images by, and the step names none.
  await withTempDir('dcm-unscheduled-dry', async (dir) => {
    // The study UID is what this asserts, and the generator settles it; the
    // instance count does not come into it.
    const source = await studyIn(dir, { instancesPerSeries: 1 });

    log.configure({ noColor: true });
    const sink = log.beginCapture();
    try {
      await dispatcher.run(tokenize([
        'perform', source, '--dry-run', '--json',
        '--unscheduled', '--modality', 'DX', '--step-id', 'WALKIN-017',
      ]));
    } finally {
      log.endCapture();
    }

    const parsed = JSON.parse(sink.out);
    assert.equal(parsed.unscheduled, true);
    assert.equal(parsed.studyInstanceUid, STUDY_UID, 'the images keep the study they carry');
    assert.equal(parsed.stepStudyInstanceUid, null, 'and the step names none');
    assert.deepEqual(parsed.dataset.ScheduledStepAttributesSequence, [{}]);
  });
});

// ---------------------------------------------------------------------------
// Interim updates during a chunked transfer
// ---------------------------------------------------------------------------

test('perform --update-each-chunk sends an interim N-SET at every boundary but the last', async () => {
  // Ten instances at --chunk 4 is three associations, so two boundaries and two
  // updates: none after the last chunk, because the closing N-SET follows
  // immediately and carries the same sequence.
  //
  // Both updates carry IN PROGRESS, which this receiver used to refuse 0x0106 —
  // a message PS3.4 F.7.2-1 permits, so the refusal was a bug. They are
  // accepted now, and the run is asserted end to end: what went out, what the
  // receiver took, and what it was left holding.
  await withTempDir('dcm-chunk-accepted', async (dir) => {
    // Ten instances exactly, because every number below is derived from it:
    // three chunks of 4/4/2, two boundaries, and updates at four and eight.
    const source = await studyIn(dir);
    const persisted = path.join(dir, 'persisted');
    const receiver = await startScp({ ae: CALLED_AE, persist: persisted });
    try {
      const result = await mppsJson(receiver, [
        'perform', source, '--update-each-chunk', '--chunk', '4',
        '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-CHUNKED',
      ]);

      assert.equal(result.json.interimUpdates.attempted, 2, 'three chunks, two boundaries');
      assert.equal(result.json.interimUpdates.accepted, 2);
      assert.deepEqual(result.json.interimUpdates.failures, []);
      assert.equal(receiver.stats.mppsRefused, 0);

      // Each boundary reports only what the archive had taken by then, so the
      // sequence GROWS across the run rather than being sent whole twice.
      const acknowledgedAt = [...result.output.matchAll(
        /interim N-SET — \d+ series, (\d+) instance\(s\) acknowledged so far/g
      )].map((m) => Number(m[1]));
      assert.deepEqual(acknowledgedAt, [4, 8], 'four after the first chunk, eight after the second');

      assert.equal(result.code, 0, result.output);
      assert.equal(result.json.ok, true);
      assert.equal(result.json.acknowledged, 10);
      assert.equal(result.json.performedProcedureStepStatus, mpps.Status.COMPLETED);

      // And what the receiver was left holding: three accepted N-SETs, and a
      // stored step reflecting the LAST of them. N-SET replaces rather than
      // appends, so the step must hold the closing sequence and not the
      // eight-instance snapshot the second update carried.
      const step = readStep(persisted, result.json.mppsSopInstanceUid);
      assert.equal(step.updates, 3, 'two interim N-SETs and the closing one');
      assert.equal(step.status, mpps.Status.COMPLETED);
      assert.equal(referencedIn(step), 10, 'every acknowledged instance, named once');
    } finally {
      receiver.close();
    }
  });
});

test('an interim update never names an instance the archive has not acknowledged', async () => {
  // The honesty rule, applied earlier than the closing N-SET rather than
  // relaxed for it. Asserted at the builder boundary rather than over an
  // association, because the ledger state a mid-transfer update is built from
  // is the thing under test and it can be set up exactly here. The boundary
  // counts as they actually arrive are asserted in the --update-each-chunk
  // test above.
  //
  // With --chunk 4 over ten instances the first update is built when four have
  // been acknowledged, so it may reference four — never the ten sitting in the
  // folder, and never the six not yet sent.
  const { TransferLedger, Disposition } = require('../../src/lib/ledger');

  const ledger = new TransferLedger();
  const study = ledger.study(STUDY_UID, {});
  for (let i = 1; i <= 10; i++) {
    study.addFile({
      path: `/tmp/${i}.dcm`,
      bytes: 1,
      sopInstanceUid: `${STUDY_UID}.1.${i}`,
      sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
      seriesInstanceUid: `${STUDY_UID}.1`,
    });
  }

  // Only the first chunk has been answered.
  for (const entry of study.entries.slice(0, 4)) {
    entry.dispatched = true;
    entry.settle(Disposition.ACKNOWLEDGED, { status: 0 });
  }

  const soFar = mpps.buildPerformedSeriesSequence(study.entries, {});
  assert.equal(soFar.referenced, 4, 'four acknowledged, four referenced');
  assert.equal(
    soFar.items[0].ReferencedImageSequence.length, 4,
    'the six instances not yet sent are not named — they have not been acknowledged by anyone'
  );
});

test('a refused interim update costs no images: the run still lands as one closing N-SET', async () => {
  // The resilience rule, driven by a real refusal rather than by a receiver bug.
  //
  // `dcm scp` cannot be made to refuse an N-SET on demand. Its only fault
  // injection is --reject-after, which stops acknowledging C-STOREs, and the
  // N-SET refusals it can produce honestly — 0x0110 on a terminal step, 0x0112
  // on a step it never made — would refuse the CLOSING N-SET too, which is the
  // opposite of what is under test here. So the refusal is injected at the
  // client's own send boundary: mpps.nSet() answers every INTERIM N-SET with
  // the same 0x0106 this receiver itself used to return, and hands the closing
  // one straight to the real implementation.
  //
  // Everything else is real — the C-STORE, the ledger, the closing N-SET, and
  // the step the receiver writes to disk.
  await withTempDir('dcm-chunk-interim', async (dir) => {
    // Ten again: two refused boundaries at --chunk 4, and ten acknowledged
    // instances that the refusals must not have cost.
    const source = await studyIn(dir);
    const persisted = path.join(dir, 'persisted');
    const receiver = await startScp({ ae: CALLED_AE, persist: persisted });

    const realNSet = mpps.nSet;
    const refusedDatasets = [];
    mpps.nSet = (params) => {
      // The closing N-SET carries a terminal status; only the interim ones
      // re-assert IN PROGRESS.
      if (params.dataset.PerformedProcedureStepStatus !== mpps.Status.IN_PROGRESS) {
        return realNSet(params);
      }
      refusedDatasets.push(params.dataset);
      return Promise.resolve({
        outcome: { kind: 'completed' },
        status: 0x0106,
        comment: '"IN PROGRESS" is not a legal status',
        contextAccepted: true,
      });
    };

    try {
      const result = await mppsJson(receiver, [
        'perform', source, '--update-each-chunk', '--chunk', '4',
        '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-HONEST',
      ]);

      // Both progress reports were refused, and both are named rather than
      // folded into a single count.
      assert.equal(refusedDatasets.length, 2, 'the two interim N-SETs went through the refusal');
      assert.equal(result.json.interimUpdates.attempted, 2);
      assert.equal(result.json.interimUpdates.accepted, 0);
      assert.equal(result.json.interimUpdates.failures.length, 2);
      for (const failure of result.json.interimUpdates.failures) {
        assert.match(failure, /0x0106/);
      }

      // And not one image was lost to them. This is the whole design decision,
      // verified rather than asserted in a comment: the images are the work and
      // an update is a progress report about it.
      assert.equal(result.code, 0, result.output);
      assert.equal(result.json.ok, true, result.output);
      assert.equal(result.json.acknowledged, 10, 'a refused update costs no images');
      assert.equal(result.json.performedProcedureStepStatus, mpps.Status.COMPLETED);
      assert.equal(receiver.stats.stored, 10);

      const step = readStep(persisted, result.json.mppsSopInstanceUid);
      assert.equal(referencedIn(step), 10);
      assert.equal(
        referencedIn(step), result.json.acknowledged, 'never more than the archive took'
      );
      assert.equal(step.status, mpps.Status.COMPLETED);
      assert.equal(
        step.updates, 1,
        'the refused updates never reached the receiver, so the closing N-SET is the only one it saw'
      );
    } finally {
      mpps.nSet = realNSet;
      receiver.close();
    }
  });
});

test('one association means no interim updates, and the report says so', async () => {
  await withTempDir('dcm-chunk-single', async (dir) => {
    // Ten instances under a chunk size of 200: one association, so no boundary
    // to update at. The ten is what makes "no updates" mean "not because there
    // was nothing to send".
    const source = await studyIn(dir);
    await withReceiver(async (receiver) => {
      const result = await mppsJson(receiver, [
        'perform', source, '--update-each-chunk', '--chunk', '200',
        '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-ONECHUNK',
      ]);

      assert.equal(result.json.ok, true, result.output);
      assert.equal(result.json.interimUpdates.attempted, 0);
      assert.equal(result.json.acknowledged, 10);
    });
  });
});

test('without the flag the transfer sends no MPPS traffic between chunks', async () => {
  // The default has to stay exactly as it was: this is the control for the test
  // above, and it is what proves --update-each-chunk is opt-in.
  await withTempDir('dcm-chunk-default', async (dir) => {
    // Ten at --chunk 4 again, and the ten matters: with a study small enough to
    // fit one association there would be no boundary to stay silent at, and
    // "no MPPS traffic between chunks" would hold vacuously.
    const source = await studyIn(dir);
    const persisted = path.join(dir, 'persisted');
    const receiver = await startScp({ ae: CALLED_AE, persist: persisted });
    try {
      const result = await mppsJson(receiver, [
        'perform', source, '--chunk', '4',
        '--study-uid', STUDY_UID, '--modality', 'CT', '--step-id', 'PPS-DEFAULT',
      ]);
      assert.equal(result.json.ok, true, result.output);
      assert.equal(result.json.interimUpdates, null);
      assert.equal(result.json.acknowledged, 10, 'three associations carried the whole study');

      const file = path.join(persisted, 'mpps', `${result.json.mppsSopInstanceUid}.json`);
      const step = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(step.updates, 1, 'the closing N-SET and nothing else');
    } finally {
      receiver.close();
    }
  });
});

/*
 * The finding this file still pins.
 *
 * An unscheduled step cannot be READ by a dcmjs-based receiver.
 *
 * The client encodes ScheduledStepAttributesSequence as one zero-length item
 * and the bytes are conformant — asserted above, byte for byte. dcmjs's
 * naturalising parser reads that sequence back as an empty one: the item does
 * not survive. Every dcmjs receiver therefore sees a missing Type 1 attribute
 * and answers 0x0120, correctly, about something it was never handed.
 *
 * Nothing in this repository can fix that, and the SCU half is still worth
 * having: the receivers it is aimed at in the field are not dcmjs, and the
 * walk-in workflow is routine. The tests above pin both halves so that a
 * library upgrade which fixes the reader shows up here rather than silently.
 *
 * The other finding this file used to pin — this receiver answering 0x0106 to
 * an interim N-SET that re-asserts IN PROGRESS — was a bug in
 * transitionRefusal() in src/lib/worklist.js and is fixed. PS3.4 F.7.2-1 lists
 * PerformedProcedureStepStatus among the attributes an N-SET may carry and
 * F.8.2 closes only the terminal states, so the message was always legal, and
 * refusing it is what makes a modality abandon the session and leave the
 * worklist entry uncleared.
 *
 * What is NOT covered, and is worth a flag: `dcm scp` offers no way to refuse
 * an N-SET on demand, so the resilience test above has to inject the refusal at
 * the client instead of provoking one. A fault-injection flag on the receiver
 * (`--refuse-nset <code>`, say) would let that test drive a real refusal over a
 * real association.
 */
