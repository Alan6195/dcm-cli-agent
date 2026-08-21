'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dcmjsDimse = require('dcmjs-dimse');
const { Dataset } = dcmjsDimse;
const { NCreateRequest, NSetRequest, CFindRequest } = dcmjsDimse.requests;
const { SopClass, Status, PresentationContextResult } = dcmjsDimse.constants;

const { startScp, withTempDir } = require('../helpers/harness');
const { runAssociation } = require('../../src/lib/dimse');
const worklist = require('../../src/lib/worklist');
const scp = require('../../src/commands/scp');
const { deterministicUid } = require('../../src/lib/uid');

/**
 * Modality Performed Procedure Step, against this repo's own receiver.
 *
 * The requests below are real dcmjs-dimse N-CREATE and N-SET messages sent over
 * a real association, not calls into the handler. That is deliberate: almost
 * everything that goes wrong with MPPS goes wrong on the wire, in ways a direct
 * call cannot reproduce — the SOP Instance UID living in a different field on
 * the request than on the response, a dataset that never got attached because
 * setDataset() was forgotten, a presentation context that was never accepted.
 *
 * These tests deliberately do not use any MPPS SCU command module. The receiver
 * has to be correct against a client written from the standard, not only
 * against its counterpart in this repository.
 */

/** The receiver's AE Title for every test here. */
const CALLED_AE = 'MPPS-SCP';
const CALLING_AE = 'CT01';

/** Short timeouts: everything here is loopback, and a hang should fail fast. */
const TIMEOUTS = Object.freeze({ connect: 5000, association: 5000, pdu: 5000, linger: 50 });

const MPPS_SOP_CLASS = SopClass.ModalityPerformedProcedureStep;

/** The study the fixture worklist schedules and the steps below correlate to. */
const STUDY_UID = '1.2.826.0.1.3680043.8.1055.20260820.1';

/** Two scheduled items, so a correlation can be shown to pick out just one. */
const ITEMS = Object.freeze([
  {
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    AccessionNumber: 'A1',
    Modality: 'CT',
    ScheduledStationAETitle: 'CT01',
    ScheduledProcedureStepStartDate: '20260820',
    ScheduledProcedureStepStartTime: '090000',
    ScheduledProcedureStepID: 'SPS1',
    RequestedProcedureDescription: 'CHEST',
    StudyInstanceUID: STUDY_UID,
  },
  {
    PatientName: 'ROE^RICHARD',
    PatientID: '67890',
    AccessionNumber: 'A2',
    Modality: 'MR',
    ScheduledStationAETitle: 'MR01',
    ScheduledProcedureStepStartDate: '20260821',
    ScheduledProcedureStepStartTime: '103000',
    ScheduledProcedureStepID: 'SPS2',
    RequestedProcedureDescription: 'BRAIN',
    StudyInstanceUID: '1.2.826.0.1.3680043.8.1055.20260821.1',
  },
]);

/** A distinct step UID per test, so nothing leaks between receivers. */
function stepUid(name) {
  return deterministicUid('dcm-cli:test:mpps-scp', name);
}

/**
 * The N-CREATE dataset a conformant SCU sends (PS3.4 F.7.2-1).
 *
 * Type 2 attributes are present and empty rather than absent, because that is
 * what Type 2 means and because a receiver that only ever sees them filled in
 * is not being tested for the case that actually occurs.
 */
function createElements(overrides = {}) {
  return {
    PerformedProcedureStepID: 'PPS001',
    PerformedStationAETitle: CALLING_AE,
    PerformedProcedureStepStartDate: '20260820',
    PerformedProcedureStepStartTime: '090500',
    PerformedProcedureStepStatus: 'IN PROGRESS',
    Modality: 'CT',
    PatientName: 'DOE^JANE',
    PatientID: '12345',
    PatientBirthDate: '',
    PatientSex: '',
    ReferencedPatientSequence: [],
    PerformedStationName: '',
    PerformedLocation: '',
    PerformedProcedureStepDescription: '',
    PerformedProcedureStepEndDate: '',
    PerformedProcedureStepEndTime: '',
    PerformedSeriesSequence: [],
    ProcedureCodeSequence: [],
    ScheduledStepAttributesSequence: [
      {
        StudyInstanceUID: STUDY_UID,
        AccessionNumber: 'A1',
        RequestedProcedureID: 'RP1',
        RequestedProcedureDescription: 'CHEST',
        ScheduledProcedureStepID: 'SPS1',
        ScheduledProcedureStepDescription: 'CHEST CT',
        ReferencedStudySequence: [],
        ScheduledProtocolCodeSequence: [],
      },
    ],
    ...overrides,
  };
}

/** The N-SET dataset that finishes a step: only what changed. */
function setElements(status = 'COMPLETED', overrides = {}) {
  return {
    PerformedProcedureStepStatus: status,
    PerformedProcedureStepEndDate: '20260820',
    PerformedProcedureStepEndTime: '093000',
    PerformedSeriesSequence: [
      {
        SeriesInstanceUID: '1.2.826.0.1.3680043.8.1055.20260820.1.1',
        RetrieveAETitle: CALLED_AE,
        SeriesDescription: 'AXIAL',
        ProtocolName: 'CHEST',
        PerformedProcedureStepDescription: 'CHEST CT',
        ReferencedImageSequence: [
          {
            ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
            ReferencedSOPInstanceUID: '1.2.826.0.1.3680043.8.1055.20260820.1.1.1',
          },
          {
            ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
            ReferencedSOPInstanceUID: '1.2.826.0.1.3680043.8.1055.20260820.1.1.2',
          },
        ],
        ReferencedNonImageCompositeSOPInstanceSequence: [],
      },
    ],
    ...overrides,
  };
}

/** An N-CREATE carrying a dataset, as one is only legal with one. */
function nCreate(uid, elements, sopClassUid = MPPS_SOP_CLASS) {
  // Two arguments only. A third would be read as the meta SOP Class UID and
  // would change what is negotiated.
  const request = new NCreateRequest(sopClassUid, uid);
  if (elements !== undefined) request.setDataset(new Dataset(elements));
  return request;
}

/** An N-SET carrying only the attributes that changed. */
function nSet(uid, elements, sopClassUid = MPPS_SOP_CLASS) {
  const request = new NSetRequest(sopClassUid, uid);
  if (elements !== undefined) request.setDataset(new Dataset(elements));
  return request;
}

/**
 * Sends requests on one association and reports what came back.
 *
 * The responses are read the way a client has to read them: the step is the
 * *affected* SOP Instance UID on every response, including an N-SET response,
 * where the request named it as the requested one.
 *
 * @returns {Promise<{responses: object[], mppsContextAccepted: boolean|undefined}>}
 */
async function converse(receiver, requests, opts = {}) {
  const responses = [];
  let mppsContextAccepted;

  for (const request of requests) {
    request.on('response', (response) => {
      responses.push({
        status: response.getStatus(),
        comment: response.getErrorComment(),
        sopInstanceUid: response.getAffectedSopInstanceUid(),
        dataset: response.getDataset(),
      });
    });
  }

  const { outcome } = await runAssociation({
    host: '127.0.0.1',
    port: receiver.port,
    callingAe: opts.callingAe ?? CALLING_AE,
    calledAe: opts.calledAe ?? CALLED_AE,
    requests,
    timeouts: TIMEOUTS,
    onAccepted: (association) => {
      // A peer can accept the association and refuse this context, after which
      // no response ever arrives and the failure looks like a timeout. Checking
      // it here is what distinguishes the two.
      mppsContextAccepted = association.getPresentationContexts().some(({ id }) => {
        const context = association.getPresentationContext(id);
        return context.getAbstractSyntaxUid() === MPPS_SOP_CLASS
          && context.getResult() === PresentationContextResult.Accept;
      });
    },
  });

  assert.equal(outcome.kind, 'completed', `association did not complete: ${outcome.headline}`);
  return { responses, mppsContextAccepted };
}

/**
 * Runs a Modality Worklist C-FIND and returns the Patient IDs that came back.
 *
 * Built here rather than through `dcm find` so that what the worklist answers
 * after a step completes is measured against the wire, not against another
 * command's formatting.
 */
async function worklistPatientIds(receiver) {
  const request = CFindRequest.createWorklistFindRequest({});
  const ids = [];

  request.on('response', (response) => {
    if (response.getStatus() !== Status.Pending) return;
    if (!response.hasDataset()) return;
    ids.push(worklist.textOf(response.getDataset().getElements().PatientID));
  });

  const { outcome } = await runAssociation({
    host: '127.0.0.1',
    port: receiver.port,
    callingAe: CALLING_AE,
    calledAe: CALLED_AE,
    requests: [request],
    timeouts: TIMEOUTS,
  });

  assert.equal(outcome.kind, 'completed');
  return ids.sort();
}

/**
 * Starts the shipped receiver over a real worklist file.
 *
 * `items: null` starts it with no worklist at all. `persist: true` points
 * --persist at a directory inside the temporary one, which the callback is
 * given so it can read back what was written.
 */
async function withReceiver(fn, { items = ITEMS, persist = false, ...config } = {}) {
  return withTempDir('dcm-mpps', async (dir) => {
    let source;
    if (items !== null) {
      const file = path.join(dir, 'worklist.json');
      fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
      source = worklist.loadWorklistFile(file);
    }

    const receiver = await startScp({
      ae: CALLED_AE,
      worklist: source,
      persist: persist ? path.join(dir, 'persisted') : undefined,
      ...config,
    });
    try {
      return await fn(receiver, dir);
    } finally {
      receiver.close();
    }
  });
}

// ---------------------------------------------------------------------------
// N-CREATE
// ---------------------------------------------------------------------------

test('the MPPS context is accepted and an N-CREATE records the step', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('create-ok');
    const { responses, mppsContextAccepted } = await converse(receiver, [
      nCreate(uid, createElements()),
    ]);

    assert.equal(mppsContextAccepted, true, 'the MPPS presentation context was accepted');
    assert.equal(responses.length, 1, 'exactly one response, and it did arrive');
    assert.equal(responses[0].status, Status.Success);
    assert.equal(responses[0].sopInstanceUid, uid);
    assert.equal(responses[0].dataset, undefined, 'an N-CREATE response carries no dataset');

    assert.equal(receiver.stats.mppsCreated, 1);
    assert.equal(receiver.stats.mppsRefused, 0);
    assert.equal(receiver.stats.mppsCompleted, 0);
  });
});

test('a second N-CREATE with the same SOP Instance UID is refused as a duplicate', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('create-duplicate');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nCreate(uid, createElements({ PerformedProcedureStepID: 'PPS002' })),
    ]);

    assert.equal(responses[0].status, Status.Success);
    assert.equal(responses[1].status, Status.DuplicateSOPInstance);
    assert.match(responses[1].comment, /already exists/i);

    assert.equal(receiver.stats.mppsCreated, 1, 'the duplicate did not overwrite the first step');
    assert.equal(receiver.stats.mppsRefused, 1);
  });
});

test('an N-CREATE missing a Type 1 attribute is refused, and the reason names it', async () => {
  await withReceiver(async (receiver) => {
    const elements = createElements();
    delete elements.PerformedStationAETitle;

    const { responses } = await converse(receiver, [nCreate(stepUid('create-missing'), elements)]);

    assert.equal(responses[0].status, Status.MissingAttribute);
    assert.match(responses[0].comment, /PerformedStationAETitle/);
    assert.equal(receiver.stats.mppsCreated, 0, 'nothing was recorded');
    assert.equal(receiver.stats.mppsRefused, 1);
  });
});

test('an empty Type 1 attribute is refused exactly like an absent one', async () => {
  // The case a permissive receiver waves through: the attribute is there, so a
  // presence check passes, and the step can never be reconciled with anything.
  await withReceiver(async (receiver) => {
    const { responses } = await converse(receiver, [
      nCreate(stepUid('create-empty-type1'), createElements({ PerformedProcedureStepID: '' })),
    ]);

    assert.equal(responses[0].status, Status.MissingAttribute);
    assert.match(responses[0].comment, /PerformedProcedureStepID/);
    assert.equal(receiver.stats.mppsCreated, 0);
  });
});

test('an N-CREATE with no dataset at all is refused rather than recorded', async () => {
  // setDataset() is mandatory and forgetting it is a common client bug: the
  // command travels, the attributes do not.
  await withReceiver(async (receiver) => {
    const { responses } = await converse(receiver, [nCreate(stepUid('create-no-dataset'))]);

    assert.equal(responses[0].status, Status.MissingAttribute);
    assert.equal(receiver.stats.mppsCreated, 0);

    // Every Type 1 attribute is missing, so the reason is longer than Error
    // Comment can hold. It is cut to the 64 characters that element allows
    // rather than sent as an illegal value; the whole list is in the log.
    assert.ok(responses[0].comment.length <= 64, responses[0].comment);
    assert.match(responses[0].comment, /^missing Type 1 attribute\(s\): .*\.\.\.$/);
  });
});

test('a step created with a status other than IN PROGRESS is refused', async () => {
  await withReceiver(async (receiver) => {
    const { responses } = await converse(receiver, [
      nCreate(
        stepUid('create-completed'),
        createElements({ PerformedProcedureStepStatus: 'COMPLETED' })
      ),
    ]);

    assert.equal(responses[0].status, Status.InvalidAttributeValue);
    assert.match(responses[0].comment, /IN PROGRESS/);
    assert.equal(receiver.stats.mppsCreated, 0);
  });
});

test('an N-CREATE for another SOP Class is refused, not recorded as a step', async () => {
  await withReceiver(async (receiver) => {
    const { responses } = await converse(receiver, [
      nCreate(stepUid('create-wrong-class'), createElements(), SopClass.BasicFilmSession),
    ]);

    assert.equal(responses[0].status, Status.SopClassNotSupported);
    assert.equal(receiver.stats.mppsCreated, 0);
  });
});

// ---------------------------------------------------------------------------
// N-SET
// ---------------------------------------------------------------------------

test('an N-SET to COMPLETED transitions the step and is counted', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('set-completed');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, setElements('COMPLETED')),
    ]);

    assert.equal(responses[0].status, Status.Success);
    assert.equal(responses[1].status, Status.Success);
    // The asymmetry a client has to know about: the request named this UID as
    // the requested SOP Instance UID, the response carries it as the affected
    // one, and getRequestedSopInstanceUid() on the response is undefined.
    assert.equal(responses[1].sopInstanceUid, uid);

    assert.equal(receiver.stats.mppsCreated, 1);
    assert.equal(receiver.stats.mppsCompleted, 1);
    assert.equal(receiver.stats.mppsDiscontinued, 0);
    assert.equal(receiver.stats.mppsRefused, 0);
  });
});

test('DISCONTINUED is a legal ending and is counted separately', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('set-discontinued');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, setElements('DISCONTINUED')),
    ]);

    assert.equal(responses[1].status, Status.Success);
    assert.equal(receiver.stats.mppsCompleted, 0);
    assert.equal(receiver.stats.mppsDiscontinued, 1);
  });
});

test('an N-SET naming a step that was never created is refused', async () => {
  await withReceiver(async (receiver) => {
    const { responses } = await converse(receiver, [
      nSet(stepUid('set-unknown'), setElements('COMPLETED')),
    ]);

    assert.equal(responses[0].status, Status.NoSuchObjectInstance);
    assert.equal(receiver.stats.mppsRefused, 1);
    assert.equal(receiver.stats.mppsCompleted, 0);
  });
});

test('a step that has finished may not be set again', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('set-terminal');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, setElements('COMPLETED')),
      nSet(uid, setElements('DISCONTINUED')),
    ]);

    assert.equal(responses[1].status, Status.Success);
    assert.equal(responses[2].status, Status.ProcessingFailure);
    assert.match(responses[2].comment, /already COMPLETED/);

    assert.equal(receiver.stats.mppsCompleted, 1, 'the record of what happened stands');
    assert.equal(receiver.stats.mppsDiscontinued, 0);
    assert.equal(receiver.stats.mppsRefused, 1);
  });
});

test('a status that is not a legal ending is refused', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('set-bad-status');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, { PerformedProcedureStepStatus: 'FINISHED' }),
    ]);

    assert.equal(responses[1].status, Status.InvalidAttributeValue);
    assert.match(responses[1].comment, /not a legal status/);
    assert.equal(receiver.stats.mppsCompleted, 0);
  });
});

test('an N-SET with no status is an attribute update on a step still running', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('set-no-status');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, { PerformedSeriesSequence: setElements().PerformedSeriesSequence }),
      nSet(uid, setElements('COMPLETED')),
    ]);

    assert.equal(responses[1].status, Status.Success, 'adding series mid-step is legal');
    assert.equal(responses[2].status, Status.Success, 'and the step can still be completed');
    assert.equal(receiver.stats.mppsCompleted, 1);
  });
});

// ---------------------------------------------------------------------------
// The worklist, before and after
// ---------------------------------------------------------------------------

test('a completed step takes its worklist item out of later queries', async () => {
  await withReceiver(async (receiver) => {
    assert.deepEqual(
      await worklistPatientIds(receiver),
      ['12345', '67890'],
      'both items are scheduled to begin with'
    );

    const uid = stepUid('worklist-retire');
    const { responses } = await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, setElements('COMPLETED')),
    ]);
    assert.equal(responses[1].status, Status.Success);

    assert.deepEqual(
      await worklistPatientIds(receiver),
      ['67890'],
      'the performed study is gone; the one still scheduled is not'
    );
    assert.equal(receiver.stats.worklistWithheld, 1);
  });
});

test('--keep-performed leaves the item in the worklist', async () => {
  await withReceiver(
    async (receiver) => {
      const uid = stepUid('worklist-keep');
      await converse(receiver, [
        nCreate(uid, createElements()),
        nSet(uid, setElements('COMPLETED')),
      ]);

      assert.deepEqual(
        await worklistPatientIds(receiver),
        ['12345', '67890'],
        'the item still answers, which is what the flag is for'
      );
      assert.equal(receiver.stats.mppsCompleted, 1, 'the step still completed');
      assert.equal(receiver.stats.worklistWithheld, 0);
    },
    { keepPerformed: true }
  );
});

test('a discontinued step also leaves the worklist', async () => {
  // It is finished, whatever the outcome was; offering it again would schedule
  // a second attempt that nobody asked for.
  await withReceiver(async (receiver) => {
    const uid = stepUid('worklist-discontinued');
    await converse(receiver, [
      nCreate(uid, createElements()),
      nSet(uid, setElements('DISCONTINUED')),
    ]);

    assert.deepEqual(await worklistPatientIds(receiver), ['67890']);
  });
});

test('a step correlating with nothing completes and withholds nothing', async () => {
  await withReceiver(async (receiver) => {
    const uid = stepUid('worklist-uncorrelated');
    const elements = createElements({
      ScheduledStepAttributesSequence: [
        { StudyInstanceUID: '1.2.826.0.1.3680043.8.1055.99999', ReferencedStudySequence: [] },
      ],
    });

    const { responses } = await converse(receiver, [
      nCreate(uid, elements),
      nSet(uid, setElements('COMPLETED')),
    ]);

    assert.equal(responses[1].status, Status.Success, 'an unscheduled study is not an error');
    assert.equal(receiver.stats.mppsCompleted, 1);
    assert.equal(receiver.stats.worklistWithheld, 0, 'nothing was retired on a guess');
    assert.deepEqual(await worklistPatientIds(receiver), ['12345', '67890']);
  });
});

test('MPPS works with no worklist loaded at all', async () => {
  await withReceiver(
    async (receiver) => {
      const uid = stepUid('no-worklist');
      const { responses } = await converse(receiver, [
        nCreate(uid, createElements()),
        nSet(uid, setElements('COMPLETED')),
      ]);

      assert.equal(responses[0].status, Status.Success);
      assert.equal(responses[1].status, Status.Success);
      assert.equal(receiver.stats.mppsCompleted, 1);
      assert.equal(receiver.stats.worklistWithheld, 0);
    },
    { items: null }
  );
});

// ---------------------------------------------------------------------------
// --persist
// ---------------------------------------------------------------------------

test('--persist writes the step, and an N-SET merges into what was created', async () => {
  await withReceiver(
    async (receiver, dir) => {
      const uid = stepUid('persist');
      await converse(receiver, [
        nCreate(uid, createElements()),
        nSet(uid, setElements('COMPLETED')),
      ]);

      const file = path.join(dir, 'persisted', 'mpps', `${uid}.json`);
      const step = JSON.parse(fs.readFileSync(file, 'utf8'));

      assert.equal(step.sopInstanceUid, uid);
      assert.equal(step.status, 'COMPLETED');
      assert.equal(step.updates, 1);

      // Merged, not replaced: what the N-CREATE established is still there.
      assert.equal(step.elements.PerformedProcedureStepID, 'PPS001');
      assert.equal(step.elements.PerformedStationAETitle, CALLING_AE);
      assert.equal(step.elements.PerformedProcedureStepStartTime, '090500');
      // And what the N-SET carried has replaced its earlier value.
      assert.equal(step.elements.PerformedProcedureStepEndTime, '093000');
      assert.equal(step.elements.PerformedSeriesSequence.length, 1);
      assert.equal(
        step.elements.PerformedSeriesSequence[0].ReferencedImageSequence.length,
        2
      );

      assert.equal(step.correlatedTo.by, 'StudyInstanceUID');
      assert.equal(step.correlatedTo.value, STUDY_UID);

      // Library bookkeeping must not end up in a record anyone reads.
      assert.equal(JSON.stringify(step).includes('_vrMap'), false);
    },
    { persist: true }
  );
});

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

test('missingType1 names every Type 1 attribute that is absent or empty', () => {
  assert.deepEqual(worklist.missingType1(createElements()), []);

  const bare = worklist.missingType1({});
  assert.deepEqual(bare.sort(), [...worklist.MPPS_TYPE1_KEYS].sort());

  assert.deepEqual(
    worklist.missingType1(createElements({ Modality: '  ' })),
    ['Modality'],
    'whitespace is not a value'
  );

  assert.deepEqual(
    worklist.missingType1(createElements({ ScheduledStepAttributesSequence: [] })),
    ['ScheduledStepAttributesSequence'],
    'a sequence with no items is an empty Type 1 attribute'
  );

  assert.deepEqual(
    worklist.missingType1(createElements({
      ScheduledStepAttributesSequence: [{ AccessionNumber: 'A1' }],
    })),
    ['ScheduledStepAttributesSequence[1].StudyInstanceUID'],
    'the correlation key inside the sequence is Type 1 too'
  );
});

test('a running step accepts interim updates; a finished one accepts nothing', () => {
  assert.equal(worklist.transitionRefusal('IN PROGRESS', 'COMPLETED'), undefined);
  assert.equal(worklist.transitionRefusal('IN PROGRESS', 'DISCONTINUED'), undefined);
  assert.equal(worklist.transitionRefusal('IN PROGRESS', ''), undefined, 'attributes only');
  assert.match(worklist.transitionRefusal('IN PROGRESS', 'IN BITS'), /not a legal status/);
  assert.equal(
    worklist.transitionRefusal('IN PROGRESS', 'IN PROGRESS'),
    undefined,
    'an interim N-SET re-asserting IN PROGRESS is legal: PS3.4 F.7.2-1 lets an '
      + 'N-SET carry the status and F.8.2 closes only the terminal states. This '
      + 'receiver used to refuse it with 0x0106, which is what makes real '
      + 'modalities give up on a session and leave the worklist entry uncleared.'
  );
  assert.match(worklist.transitionRefusal('COMPLETED', 'DISCONTINUED'), /already COMPLETED/);
  assert.match(
    worklist.transitionRefusal('DISCONTINUED', ''),
    /already DISCONTINUED/,
    'a terminal step is closed to attribute updates as well'
  );
});

test('correlation prefers StudyInstanceUID and never falls back past a match', () => {
  const keys = worklist.readCorrelationKeys(createElements());
  assert.deepEqual(keys.StudyInstanceUID, [STUDY_UID]);
  assert.deepEqual(keys.AccessionNumber, ['A1']);
  assert.deepEqual(keys.ScheduledProcedureStepID, ['SPS1']);

  const byStudy = worklist.correlateItems(ITEMS, keys);
  assert.equal(byStudy.by, 'StudyInstanceUID');
  assert.equal(byStudy.items.length, 1);
  assert.equal(byStudy.items[0].PatientID, '12345');

  // A stale Accession Number alongside a correct UID must not retire the wrong
  // item: the stronger key answered, so the weaker one is never consulted.
  const mixed = worklist.correlateItems(ITEMS, {
    StudyInstanceUID: [STUDY_UID],
    AccessionNumber: ['A2'],
    ScheduledProcedureStepID: [],
  });
  assert.equal(mixed.by, 'StudyInstanceUID');
  assert.deepEqual(mixed.items.map((i) => i.PatientID), ['12345']);

  // With no UID the fallbacks are used, in order.
  const byAccession = worklist.correlateItems(ITEMS, {
    StudyInstanceUID: [],
    AccessionNumber: ['A2'],
    ScheduledProcedureStepID: ['SPS1'],
  });
  assert.equal(byAccession.by, 'AccessionNumber');
  assert.deepEqual(byAccession.items.map((i) => i.PatientID), ['67890']);

  const nothing = worklist.correlateItems(ITEMS, worklist.readCorrelationKeys({}));
  assert.equal(nothing.by, undefined);
  assert.deepEqual(nothing.items, []);
});

test('correlation reads a worklist item written with a nested scheduled step', () => {
  // The file format allows both shapes, so both have to correlate identically.
  const nested = [{
    PatientID: '55555',
    StudyInstanceUID: STUDY_UID,
    ScheduledProcedureStepSequence: [{ Modality: 'CT', ScheduledProcedureStepID: 'SPS9' }],
  }];

  const bySps = worklist.correlateItems(nested, {
    StudyInstanceUID: [],
    AccessionNumber: [],
    ScheduledProcedureStepID: ['SPS9'],
  });
  assert.equal(bySps.by, 'ScheduledProcedureStepID');
  assert.equal(bySps.items.length, 1);
});

test('plainElements strips the library private keys at every level', () => {
  const stripped = worklist.plainElements({
    _vrMap: {},
    PatientID: '1',
    ScheduledStepAttributesSequence: [{ _vrMap: {}, StudyInstanceUID: '1.2.3' }],
    PerformedSeriesSequence: [{ _vrMap: {}, ReferencedImageSequence: [{ _vrMap: {}, X: 'y' }] }],
  });

  assert.deepEqual(stripped, {
    PatientID: '1',
    ScheduledStepAttributesSequence: [{ StudyInstanceUID: '1.2.3' }],
    PerformedSeriesSequence: [{ ReferencedImageSequence: [{ X: 'y' }] }],
  });
});

test('the sending and receiving halves agree about Type 1 and the transitions', (t) => {
  // The same guard worklist.test.js puts on the scheduled-step key lists, for
  // the same reason: two halves that disagree do not error, they just refuse
  // each other's perfectly good messages. If the SCU half tightens its Type 1
  // list and this one does not, `dcm mpps` starts refusing locally what this
  // receiver would have accepted — or worse, the other way round.
  let mpps;
  try {
    mpps = require('../../src/lib/mpps');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    t.skip('src/lib/mpps.js, the SCU half, is not part of this build');
    return;
  }

  assert.deepEqual([...mpps.CREATE_TYPE_1], [...worklist.MPPS_TYPE1_KEYS]);
  assert.equal(mpps.Status.IN_PROGRESS, worklist.MPPS_IN_PROGRESS);
  assert.deepEqual(
    [mpps.Status.COMPLETED, mpps.Status.DISCONTINUED],
    [...worklist.MPPS_TERMINAL_STATUSES]
  );

  // No exemptions: the two halves must agree about every transition, including
  // the interim self-edge. They did not always — this receiver used to refuse
  // an N-SET re-asserting IN PROGRESS with 0x0106, which is the exact shape of
  // behaviour that makes real modalities abandon a session. It accepts it now,
  // and this loop is what keeps the two halves from drifting apart again.
  for (const [from, allowed] of Object.entries(mpps.LEGAL_TRANSITIONS)) {
    for (const to of Object.values(mpps.Status)) {
      assert.equal(
        worklist.transitionRefusal(from, to) === undefined,
        allowed.includes(to),
        `${from} -> ${to}`
      );
    }
  }

  assert.equal(
    worklist.transitionRefusal(mpps.Status.IN_PROGRESS, mpps.Status.IN_PROGRESS) === undefined,
    true,
    'an interim N-SET re-asserting IN PROGRESS is accepted'
  );
  assert.equal(
    worklist.transitionRefusal(mpps.Status.IN_PROGRESS, '') === undefined,
    true,
    'and so is the same update with the status attribute absent'
  );
  for (const terminal of [mpps.Status.COMPLETED, mpps.Status.DISCONTINUED]) {
    assert.deepEqual(
      [...mpps.LEGAL_TRANSITIONS[terminal]],
      [],
      'the self-edge must not have opened a terminal state to anything'
    );
    assert.ok(
      worklist.transitionRefusal(terminal, mpps.Status.IN_PROGRESS) !== undefined,
      'and a finished step still cannot be reopened'
    );
  }
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

test('the scp usage documents MPPS, the refusals, and --keep-performed', () => {
  assert.match(scp.USAGE, /Modality Performed Procedure Step/);
  assert.match(scp.USAGE, /--keep-performed/);
  assert.match(scp.USAGE, /Duplicate SOP Instance/);
  assert.match(scp.USAGE, /Missing Attribute/);
  assert.match(scp.USAGE, /StudyInstanceUID/);
  // The trap: the same query stops returning the patient once the step is done.
  assert.match(scp.USAGE, /Note: completing a step/);
  // And the honesty rule: nothing outside this receiver was told anything.
  assert.match(scp.USAGE, /no\s+other system is told anything/);
});
