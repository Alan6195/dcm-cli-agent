'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dcmjsDimse = require('dcmjs-dimse');
const { Server, Client, Dataset } = dcmjsDimse;
const { NCreateRequest, NSetRequest, CFindRequest } = dcmjsDimse.requests;
const { SopClass, Status, AbortSource } = dcmjsDimse.constants;

const { freePort, withTempDir } = require('../helpers/harness');
const { runAssociation } = require('../../src/lib/dimse');
const { tokenize, UsageError } = require('../../src/lib/args');
const log = require('../../src/lib/log');
const find = require('../../src/commands/find');
const scp = require('../../src/commands/scp');
const worklist = require('../../src/lib/worklist');
const { describe: describeStatus } = require('../../src/lib/status');
const { deterministicUid } = require('../../src/lib/uid');

/**
 * Fault injection on `dcm scp`.
 *
 * The receiver's only fault knob used to be --reject-after, which is C-STORE
 * only, and the cost of that was concrete: the test proving a refused interim
 * N-SET costs no images had to stub the client's own send boundary, because
 * nothing could make a real peer refuse one. The refusals this receiver could
 * produce honestly — 0x0110 on a terminal step, 0x0112 on a step it never made
 * — refuse the CLOSING N-SET too, which is the opposite of the case worth
 * testing.
 *
 * So these tests are about a receiver that misbehaves on purpose, and about
 * two properties of that:
 *
 *   - it misbehaves in exactly the way it was told to, over a real
 *     association, so a client's handling of a bad peer is measured rather
 *     than asserted; and
 *   - it never misbehaves when nobody asked. Every fault is off by default,
 *     and the last test here pins that: the same conversations, with no flags,
 *     behave exactly as they always did.
 */

const CALLED_AE = 'FAULT-SCP';
const CALLING_AE = 'CT01';
const MPPS_SOP_CLASS = SopClass.ModalityPerformedProcedureStep;
const TIMEOUTS = Object.freeze({ connect: 5000, association: 5000, pdu: 5000, linger: 50 });

const STUDY_UID = '1.2.826.0.1.3680043.8.1055.20260820.7';

const ITEMS = Object.freeze([
  {
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    AccessionNumber: 'A1',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260820',
    ScheduledProcedureStepID: 'SPS1',
    StudyInstanceUID: STUDY_UID,
  },
  {
    PatientName: 'ROE^RICHARD',
    PatientID: '67890',
    AccessionNumber: 'A2',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260821',
    ScheduledProcedureStepID: 'SPS2',
    StudyInstanceUID: '1.2.826.0.1.3680043.8.1055.20260821.7',
  },
  {
    PatientName: 'POE^SAM',
    PatientID: '24680',
    AccessionNumber: 'A3',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260822',
    ScheduledProcedureStepID: 'SPS3',
    StudyInstanceUID: '1.2.826.0.1.3680043.8.1055.20260822.7',
  },
]);

/**
 * Starts the shipped receiver with fault configuration.
 *
 * The shared harness deliberately builds its config key by key, and the fault
 * keys are not among them, so this is that helper with the fault fields
 * threaded through. It is still `makeScpClass` — the class `dcm scp` runs —
 * rather than a stand-in, which is the part that matters.
 */
async function startFaultScp(config = {}) {
  const port = await freePort();
  const stats = {
    associations: 0, rejected: 0, echoes: 0, stored: 0,
    finds: 0, worklistMatches: 0, refused: 0, aborts: 0, errors: 0,
    mppsCreated: 0, mppsCompleted: 0, mppsDiscontinued: 0, mppsRefused: 0,
    worklistWithheld: 0, faultsInjected: 0,
  };

  const full = {
    ae: config.ae ?? CALLED_AE,
    acceptCallingAe: config.acceptCallingAe ?? [],
    persist: config.persist,
    rejectAfter: config.rejectAfter ?? 0,
    worklist: config.worklist,
    keepPerformed: config.keepPerformed ?? false,
    refuseNSet: config.refuseNSet,
    refuseNCreate: config.refuseNCreate,
    findStatus: config.findStatus,
    abortFindAfter: config.abortFindAfter,
  };

  const server = new Server(scp.makeScpClass(full, stats));
  server.on('networkError', () => {
    stats.errors += 1;
  });

  await new Promise((resolve) => {
    server.on('listening', resolve);
    server.listen(port, { logCommandDatasets: false, logDatasets: false });
  });

  return {
    port,
    stats,
    close: () => {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** Starts a receiver, runs the body, and always closes it. */
async function withReceiver(config, fn) {
  const receiver = await startFaultScp(config);
  try {
    return await fn(receiver);
  } finally {
    receiver.close();
  }
}

/** A worklist source built from ITEMS without going near the repo root. */
async function withWorklistReceiver(config, fn) {
  return withTempDir('dcm-fault-wl', async (dir) => {
    const file = path.join(dir, 'worklist.json');
    fs.writeFileSync(file, JSON.stringify(ITEMS, null, 2), 'utf8');
    return withReceiver({ ...config, worklist: worklist.loadWorklistFile(file) }, fn);
  });
}

function stepUid(name) {
  return deterministicUid('dcm-cli:test:scp-faults', name);
}

/** The N-CREATE dataset a conformant SCU sends (PS3.4 F.7.2-1). */
function createElements(overrides = {}) {
  return {
    PerformedProcedureStepID: 'PPS-FAULT',
    PerformedStationAETitle: CALLING_AE,
    PerformedProcedureStepStartDate: '20260820',
    PerformedProcedureStepStartTime: '090500',
    PerformedProcedureStepStatus: 'IN PROGRESS',
    Modality: 'CT',
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    PatientBirthDate: '',
    PatientSex: '',
    PerformedSeriesSequence: [],
    ScheduledStepAttributesSequence: [
      {
        StudyInstanceUID: STUDY_UID,
        AccessionNumber: 'A1',
        ScheduledProcedureStepID: 'SPS1',
        ReferencedStudySequence: [],
      },
    ],
    ...overrides,
  };
}

/**
 * An interim N-SET: a progress report.
 *
 * Both legal spellings are exercised across the tests below — one carrying no
 * status at all, one re-asserting IN PROGRESS — because the scope rule has to
 * treat them identically and it would be easy to write one that only sees the
 * second.
 */
function interimElements(withStatus) {
  const elements = {
    PerformedSeriesSequence: [
      {
        SeriesInstanceUID: `${STUDY_UID}.1`,
        RetrieveAETitle: CALLED_AE,
        ReferencedImageSequence: [
          {
            ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
            ReferencedSOPInstanceUID: `${STUDY_UID}.1.1`,
          },
        ],
      },
    ],
  };
  if (withStatus) elements.PerformedProcedureStepStatus = 'IN PROGRESS';
  return elements;
}

/** The terminal N-SET: the one that closes the step. */
function closeElements(status = 'COMPLETED') {
  return {
    PerformedProcedureStepStatus: status,
    PerformedProcedureStepEndDate: '20260820',
    PerformedProcedureStepEndTime: '093000',
    PerformedSeriesSequence: [
      {
        SeriesInstanceUID: `${STUDY_UID}.1`,
        RetrieveAETitle: CALLED_AE,
        ReferencedImageSequence: [
          {
            ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
            ReferencedSOPInstanceUID: `${STUDY_UID}.1.1`,
          },
          {
            ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
            ReferencedSOPInstanceUID: `${STUDY_UID}.1.2`,
          },
        ],
      },
    ],
  };
}

function nCreate(uid, elements, sopClassUid = MPPS_SOP_CLASS) {
  const request = new NCreateRequest(sopClassUid, uid);
  if (elements !== undefined) request.setDataset(new Dataset(elements));
  return request;
}

function nSet(uid, elements, sopClassUid = MPPS_SOP_CLASS) {
  const request = new NSetRequest(sopClassUid, uid);
  if (elements !== undefined) request.setDataset(new Dataset(elements));
  return request;
}

/**
 * Sends requests on one association and reports what came back, in order.
 *
 * Answers are stored at the index of the request they belong to rather than
 * appended, so an assertion about the third response cannot be satisfied by
 * whichever answer happened to arrive third.
 */
async function converse(receiver, requests, { expect = 'completed' } = {}) {
  const responses = [];
  requests.forEach((request, index) => {
    request.on('response', (response) => {
      responses[index] = {
        status: response.getStatus(),
        comment: response.getErrorComment(),
      };
    });
  });

  const { outcome } = await runAssociation({
    host: '127.0.0.1',
    port: receiver.port,
    callingAe: CALLING_AE,
    calledAe: CALLED_AE,
    requests,
    timeouts: TIMEOUTS,
  });

  assert.equal(outcome.kind, expect, `association outcome was "${outcome.kind}": ${outcome.headline}`);
  return { responses, outcome };
}

/**
 * Runs a worklist C-FIND and reports what actually arrived, A-ABORT included.
 *
 * This reaches past `runAssociation` on purpose, and the reason is worth
 * recording: dcmjs-dimse's Client re-emits `connect`, `associationAccepted`,
 * `associationRejected`, `associationReleaseResponse`, `done`, `cStoreRequest`,
 * `nEventReportRequest`, `networkError` and `close` from the Network it owns —
 * but not `abort`. An A-ABORT from the peer therefore never reaches anything
 * built on the Client, which is why the assertion that the abort is real has
 * to listen to the Network directly.
 *
 * @returns {Promise<{pending: object[], finalStatus: number|undefined, abort: object|undefined}>}
 */
function rawWorklistFind(receiver, identifier = {}) {
  const request = CFindRequest.createWorklistFindRequest(identifier);
  const pending = [];
  let finalStatus;

  request.on('response', (response) => {
    if (response.getStatus() === Status.Pending) pending.push(response.getStatus());
    else finalStatus = response.getStatus();
  });

  const client = new Client();
  client.addRequest(request);

  return new Promise((resolve) => {
    let abort;
    const done = () => resolve({ pending, finalStatus, abort });
    // A socket torn down under the client is reported as a network error; it
    // is the expected consequence here, not a failure of the test.
    client.on('networkError', done);
    client.on('closed', done);
    client.send('127.0.0.1', receiver.port, CALLING_AE, CALLED_AE, {
      connectTimeout: TIMEOUTS.connect,
      associationTimeout: TIMEOUTS.association,
      pduTimeout: TIMEOUTS.pdu,
      associationLingerTimeout: TIMEOUTS.linger,
      logCommandDatasets: false,
      logDatasets: false,
    });
    client.network.on('abort', (received) => {
      abort = received;
    });
  });
}

/** Runs `dcm find --mwl --json` and returns the single JSON document. */
async function findMwl(receiver, argv = []) {
  log.configure({ noColor: true });
  const sink = log.beginCapture();
  let code;
  try {
    code = await find.run(tokenize([
      '--host', '127.0.0.1', '--port', String(receiver.port),
      '--called-ae', CALLED_AE, '--mwl', '--json', '--timeout', '5000', ...argv,
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
  return { code, json: parsed, stderr: sink.err };
}

// ---------------------------------------------------------------------------
// Parsing the flags
// ---------------------------------------------------------------------------

/** Runs `dcm scp` far enough to parse its flags. Never reaches listen(). */
function parseScpFlags(argv) {
  return scp.run(tokenize(['--port', '11112', ...argv]));
}

test('a fault status may be given as hex or as any spelling of its name', () => {
  // Three spellings of one code, because the USAGE and the log lines use the
  // names while the DICOM literature and every bug report use the hex. Anyone
  // reading either has to be able to type what they read.
  for (const spelling of ['0x0106', '0X106', 'InvalidAttributeValue',
    'invalid-attribute-value', 'invalid attribute value']) {
    assert.equal(
      scp.parseStatusCode(spelling, 'refuse-nset'), 0x0106,
      `"${spelling}" should be Invalid Attribute Value`
    );
  }

  assert.equal(scp.parseStatusCode('no-such-object-instance', 'refuse-nset'), 0x0112);
  assert.equal(scp.parseStatusCode('ProcessingFailure', 'refuse-nset'), 0x0110);

  // Hex reaches codes the library has no constant for at all, which is what
  // keeps the flag useful for a vendor's private status.
  assert.equal(scp.parseStatusCode('0xA700', 'refuse-nset'), 0xa700);
  assert.equal(scp.parseStatusCode('0xC123', 'refuse-nset'), 0xc123);

  // A warning is a legitimate thing for a peer to answer with, so it is
  // allowed; only statuses that refuse nothing are not.
  assert.equal(scp.parseStatusCode('0xB000', 'refuse-nset'), 0xb000);
});

test('a status that is not a status, or that refuses nothing, is a usage error', async () => {
  const rejects = (argv, pattern) => assert.rejects(
    () => parseScpFlags(argv),
    (err) => err instanceof UsageError && pattern.test(err.message),
    `expected ${argv.join(' ')} to be refused with ${pattern}`
  );

  await rejects(['--refuse-nset', 'wat'], /not a DIMSE status/);
  // Bare digits are the trap: 110 is 0x006E as decimal and 0x0110 as hex, and
  // the person typing it meant Processing Failure.
  await rejects(['--refuse-nset', '110'], /write 0x110/);
  await rejects(['--refuse-nset', '0x0000'], /success status, which refuses nothing/);
  await rejects(['--refuse-ncreate', 'Pending'], /pending status, which refuses nothing/);
  await rejects(['--refuse-nset', '0x0106', '--refuse-nset-scope', 'sometimes'],
    /not one of interim, terminal, all/);
  await rejects(['--refuse-nset-scope', 'all'], /only means something alongside --refuse-nset/);
  await rejects(['--abort-find-after', '-1'], /whole number of 0 or more/);
  await rejects(['--abort-find-after', '1.5'], /whole number of 0 or more/);
  await rejects(['--find-status', '0x0122', '--abort-find-after', '2'],
    /only one can happen/);
});

// ---------------------------------------------------------------------------
// --refuse-nset
// ---------------------------------------------------------------------------

test('--refuse-nset answers the named status on the wire, with a comment naming the flag',
  async () => {
    await withReceiver({ refuseNSet: { code: 0x0106, scope: 'interim' } }, async (receiver) => {
      const uid = stepUid('wire');
      const { responses } = await converse(receiver, [
        nCreate(uid, createElements()),
        nSet(uid, interimElements(true)),
      ]);

      assert.equal(responses[0].status, Status.Success, 'the N-CREATE is untouched');
      assert.equal(responses[1].status, 0x0106);
      assert.match(responses[1].comment, /--refuse-nset/);
      assert.match(responses[1].comment, /0x0106/);
      assert.ok(
        responses[1].comment.length <= 64,
        `Error Comment is LO and holds 64 characters; got ${responses[1].comment.length}`
      );

      assert.equal(receiver.stats.faultsInjected, 1);
      assert.equal(receiver.stats.mppsCreated, 1);
      assert.equal(receiver.stats.mppsCompleted, 0);
    });
  });

test('the client sees the injected refusal as the refusal it is', async () => {
  // The other half of "on the wire": a status the peer sent is only useful if
  // the client reports it. 0x0120 rather than 0x0106 so the assertion cannot
  // pass on the receiver's own historic behaviour.
  await withReceiver({ refuseNSet: { code: 0x0120, scope: 'interim' } }, async (receiver) => {
    const uid = stepUid('client-sees');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, interimElements(false)),
    ]);

    const described = describeStatus(responses[1].status, responses[1].comment);
    assert.equal(described.code, '0x0120');
    assert.equal(described.class, 'failure');
    assert.equal(described.label, 'Missing attribute');
    assert.match(described.peerComment, /--refuse-nset/);
  });
});

test('refusing the interim while letting the close through works', async () => {
  // The case the whole flag exists for, and the one a scope of "all" cannot
  // express. Two progress reports are refused and the step still completes,
  // which is what a resilient client has to survive.
  await withWorklistReceiver(
    { refuseNSet: { code: 0x0106, scope: 'interim' } },
    async (receiver) => {
      const uid = stepUid('interim-then-close');

      const { responses } = await converse(receiver, [
        nCreate(uid, createElements()),
        nSet(uid, interimElements(false)), // no status at all
        nSet(uid, interimElements(true)),  // re-asserting IN PROGRESS
        nSet(uid, closeElements('COMPLETED')),
      ]);

      assert.equal(responses[0].status, Status.Success, 'N-CREATE');
      assert.equal(responses[1].status, 0x0106, 'interim without a status is refused');
      assert.equal(responses[2].status, 0x0106, 'interim re-asserting IN PROGRESS is refused');
      assert.equal(responses[3].status, Status.Success, 'the closing N-SET goes through');

      assert.equal(receiver.stats.faultsInjected, 2, 'exactly the two interims');
      assert.equal(receiver.stats.mppsCompleted, 1);

      // And the refusals cost the step nothing: it completed, so it correlated
      // back to the worklist and its item left. A refused interim that had
      // been half-applied would show up here.
      assert.equal(receiver.stats.worklistWithheld, 1);
      const remaining = await findMwl(receiver);
      assert.equal(remaining.json.count, ITEMS.length - 1);
      assert.ok(
        !remaining.json.matches.some((m) => m.PatientID === '12345'),
        'the completed study left the worklist'
      );
    }
  );
});

test('--refuse-nset-scope terminal leaves a modality holding a step it cannot finish',
  async () => {
    await withWorklistReceiver(
      { refuseNSet: { code: 0x0110, scope: 'terminal' } },
      async (receiver) => {
        const uid = stepUid('terminal-scope');
        const { responses } = await converse(receiver, [
          nCreate(uid, createElements()),
          nSet(uid, interimElements(true)),
          nSet(uid, closeElements('COMPLETED')),
          nSet(uid, closeElements('DISCONTINUED')),
        ]);

        assert.equal(responses[0].status, Status.Success);
        assert.equal(responses[1].status, Status.Success, 'the interim is handled normally');
        assert.equal(responses[2].status, 0x0110, 'COMPLETED is refused');
        assert.equal(responses[3].status, 0x0110, 'DISCONTINUED is refused too');

        assert.equal(receiver.stats.faultsInjected, 2);
        assert.equal(receiver.stats.mppsCompleted, 0);
        assert.equal(receiver.stats.mppsDiscontinued, 0);

        // The step never finished, so nothing was correlated and the worklist
        // is untouched. That is the failure being reproduced, not a side
        // effect of it.
        assert.equal(receiver.stats.worklistWithheld, 0);
        const still = await findMwl(receiver);
        assert.equal(still.json.count, ITEMS.length);
      }
    );
  });

test('--refuse-nset-scope all refuses both, and the step stays open', async () => {
  await withReceiver({ refuseNSet: { code: 0x0110, scope: 'all' } }, async (receiver) => {
    const uid = stepUid('all-scope');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, interimElements(true)),
      nSet(uid, closeElements('COMPLETED')),
    ]);

    assert.equal(responses[0].status, Status.Success);
    assert.equal(responses[1].status, 0x0110);
    assert.equal(responses[2].status, 0x0110);
    assert.equal(receiver.stats.faultsInjected, 2);
    assert.equal(receiver.stats.mppsCompleted, 0);
  });
});

test('a refused N-SET changes nothing about the step it names', async () => {
  // The injected refusal is decided before the step is looked up, so it has to
  // leave the step exactly as it was — otherwise a fault flag would be
  // corrupting the record it is supposed to be testing around.
  await withTempDir('dcm-fault-persist', async (dir) => {
    const persisted = path.join(dir, 'persisted');
    const uid = stepUid('untouched');

    await withReceiver(
      { persist: persisted, refuseNSet: { code: 0x0106, scope: 'interim' } },
      async (receiver) => {
        await converse(receiver, [
          nCreate(uid, createElements()),
          nSet(uid, interimElements(true)),
          nSet(uid, interimElements(true)),
        ]);
      }
    );

    const step = JSON.parse(fs.readFileSync(path.join(persisted, 'mpps', `${uid}.json`), 'utf8'));
    assert.equal(step.status, 'IN PROGRESS');
    assert.equal(step.updates, 0, 'neither refused N-SET was applied to the step');
    assert.deepEqual(
      step.elements.PerformedSeriesSequence, [],
      'the series the refused updates carried were never merged in'
    );
  });
});

test('--refuse-nset does not touch an N-SET for another SOP Class', async () => {
  // The SOP Class check comes first on purpose: a genuinely misdirected N-SET
  // still deserves 0x0122, and a fault flag must not be able to take the blame
  // for it.
  await withReceiver({ refuseNSet: { code: 0x0106, scope: 'all' } }, async (receiver) => {
    const uid = stepUid('wrong-sop-class');
    const { responses } = await converse(receiver, [
      nSet(uid, interimElements(true), SopClass.StorageCommitmentPushModel),
    ]);
    assert.equal(responses[0].status, Status.SopClassNotSupported);
    assert.equal(receiver.stats.faultsInjected, 0);
  });
});

// ---------------------------------------------------------------------------
// --refuse-ncreate
// ---------------------------------------------------------------------------

test('--refuse-ncreate refuses every step, and no step is created', async () => {
  await withReceiver({ refuseNCreate: 0x0110 }, async (receiver) => {
    const uid = stepUid('no-create');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      // The N-SET that follows fails on its own terms: there is no step. That
      // is the situation, not a second injected fault.
      nSet(uid, closeElements('COMPLETED')),
    ]);

    assert.equal(responses[0].status, 0x0110);
    assert.match(responses[0].comment, /--refuse-ncreate/);
    assert.equal(responses[1].status, Status.NoSuchObjectInstance);

    assert.equal(receiver.stats.mppsCreated, 0);
    assert.equal(receiver.stats.faultsInjected, 1, 'only the N-CREATE was injected');
  });
});

test('--refuse-ncreate fires before this receiver would have validated anything', async () => {
  // A dataset missing a Type 1 attribute would earn 0x0120 on its own. With
  // the flag set, the answer is the one that was asked for — a knob that only
  // fires on requests the receiver would otherwise have accepted is not a
  // knob, because a test could not tell the two answers apart.
  await withReceiver({ refuseNCreate: 0x0124 }, async (receiver) => {
    const uid = stepUid('before-validation');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements({ PerformedProcedureStepID: '' })),
    ]);
    assert.equal(responses[0].status, 0x0124);
  });
});

// ---------------------------------------------------------------------------
// The C-FIND path
// ---------------------------------------------------------------------------

test('--find-status answers a worklist query with the named failure, not with matches',
  async () => {
    await withWorklistReceiver({ findStatus: 0x0122 }, async (receiver) => {
      const result = await findMwl(receiver);

      // The failure the flag reproduces: a peer that accepted the presentation
      // context and still refuses the query. Zero matches and a refusal must
      // not look the same, and the envelope is where that is decided.
      assert.equal(result.json.outcome, 'rejected');
      assert.equal(result.json.ok, false);
      assert.equal(result.json.detail.kind, 'status');
      assert.equal(result.json.detail.status.code, '0x0122');
      assert.match(result.json.detail.status.peerComment, /--find-status/);
      assert.equal(receiver.stats.faultsInjected, 1);
      assert.equal(receiver.stats.worklistMatches, 0, 'no item was ever matched');
    });
  });

test('--abort-find-after puts n Pending answers and then a real A-ABORT on the wire',
  async () => {
    await withWorklistReceiver({ abortFindAfter: 2 }, async (receiver) => {
      const { pending, abort, finalStatus } = await rawWorklistFind(receiver);

      assert.equal(pending.length, 2, 'two Pending responses arrived before the teardown');
      assert.equal(finalStatus, undefined, 'no final status was ever sent — that is the point');
      assert.ok(abort, 'the peer sent an A-ABORT');
      assert.equal(abort.source, AbortSource.ServiceUser);

      assert.equal(receiver.stats.faultsInjected, 1);
      // Our own deliberate teardown is not the peer aborting on us, and the
      // summary must not claim the client misbehaved.
      assert.equal(receiver.stats.aborts, 0);
    });
  });

test('a client reading an aborted C-FIND does not report the partial answer as complete',
  async () => {
    // The whole point of the flag. Three items match, one Pending is delivered,
    // and the association dies with no final status. A client that counted the
    // row it received and exited 0 would be reporting a truncated worklist as
    // a complete one.
    //
    // The invariant is asserted rather than the specific outcome name. The
    // exact name is currently wrong for a reason outside this receiver:
    // dcmjs-dimse's Client forwards connect, accept, reject, release,
    // networkError and close from its Network, but not `abort`, so
    // src/lib/dimse.js's `client.on('abort')` never fires and an A-ABORT
    // arrives as whatever happens next — a closed socket. Pinning "aborted"
    // here would pin a library gap; pinning "not a complete answer" is what
    // this flag is for, and it keeps holding once the gap is closed.
    await withWorklistReceiver({ abortFindAfter: 1 }, async (receiver) => {
      const result = await findMwl(receiver);
      assert.equal(result.json.ok, false, 'a torn-down query is not an answer');
      assert.notEqual(result.code, 0);
      assert.equal(result.json.count, null, 'nothing was counted, so nothing may be reported');
      assert.deepEqual(result.json.matches, []);
      assert.notEqual(result.json.outcome, 'matched');
      assert.notEqual(result.json.outcome, 'empty');
      assert.equal(receiver.stats.faultsInjected, 1);
    });
  });

test('--abort-find-after 0 aborts before a single match is sent', async () => {
  await withWorklistReceiver({ abortFindAfter: 0 }, async (receiver) => {
    const { pending, abort } = await rawWorklistFind(receiver);
    assert.equal(pending.length, 0);
    assert.ok(abort, 'the association died before any answer at all');
    assert.equal(receiver.stats.faultsInjected, 1);
  });
});

test('an abort point the query never reaches is answered normally, and said out loud',
  async () => {
    // A test that expected an abort, got a clean answer and passed anyway is
    // worse than one that fails, so the receiver says the abort did not fire.
    await withWorklistReceiver({ abortFindAfter: 99 }, async (receiver) => {
      const result = await findMwl(receiver);
      assert.equal(result.json.outcome, 'matched');
      assert.equal(result.json.count, ITEMS.length);
      assert.equal(receiver.stats.faultsInjected, 0);
    });
  });

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

test('with no fault flags, the worklist and MPPS behaviour is exactly what it was', async () => {
  // The guard on everything above. Each fault path had to be threaded through
  // code that runs on every request, and the failure that would matter most is
  // one that fires when nobody asked for it.
  await withWorklistReceiver({}, async (receiver) => {
    const uid = stepUid('no-faults');

    const before = await findMwl(receiver);
    assert.equal(before.json.outcome, 'matched');
    assert.equal(before.json.count, ITEMS.length);

    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, interimElements(false)),
      nSet(uid, interimElements(true)),
      nSet(uid, closeElements('COMPLETED')),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [Status.Success, Status.Success, Status.Success, Status.Success],
      'every message in a normal MPPS sequence is accepted'
    );

    // The receiver's own enforcement is still armed: a second terminal N-SET
    // on a finished step is still refused, and refused by the receiver rather
    // than by a fault.
    const { responses: after } = await converse(receiver, [
      nSet(uid, closeElements('COMPLETED')),
    ]);
    assert.equal(after[0].status, Status.ProcessingFailure);
    assert.match(after[0].comment, /already COMPLETED/);

    assert.equal(receiver.stats.faultsInjected, 0, 'nothing was injected');
    assert.equal(receiver.stats.mppsCreated, 1);
    assert.equal(receiver.stats.mppsCompleted, 1);
    assert.equal(receiver.stats.mppsRefused, 1, 'the one real refusal, and only that');

    // And the completed step retired its worklist item, as it always did.
    const remaining = await findMwl(receiver);
    assert.equal(remaining.json.count, ITEMS.length - 1);
  });
});

test('the scp usage documents the fault knobs the way it documents --reject-after', () => {
  assert.match(scp.USAGE, /Fault injection/);
  for (const flag of ['--refuse-nset', '--refuse-nset-scope', '--refuse-ncreate',
    '--find-status', '--abort-find-after', '--reject-after']) {
    assert.ok(scp.USAGE.includes(flag), `${flag} is not documented`);
  }
  // The scope, and why the default is what it is, is the part someone has to
  // read before the flag does what they expect.
  assert.match(scp.USAGE, /interim/);
  assert.match(scp.USAGE, /"interim" is the default/);
});
