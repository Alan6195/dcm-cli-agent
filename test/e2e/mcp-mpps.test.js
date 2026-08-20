'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * End-to-end coverage for the MPPS tools, over the real stdio MCP server.
 *
 * The whole loop the product goal describes is exercised here with no PACS and
 * no RIS: start a receiver holding a worklist, ask it what is scheduled, report
 * one of those rows as performed, and see the item leave the worklist. That is
 * the only way to test the part that matters — the four tools are thin, but the
 * claims their descriptions make are not, and a claim is only worth what a test
 * says about it.
 *
 * Three of those claims are asserted directly:
 *
 *   COMPLETED requires every found instance to have been acknowledged. The
 *   shortfall case is induced for real, by pointing the storage leg at a
 *   receiver that rejects our calling AE Title, and the step must come back
 *   DISCONTINUED with a non-zero exit surfaced as an error result.
 *
 *   PerformedSeriesSequence names only acknowledged instances. In the shortfall
 *   case nothing was acknowledged, so it must be empty rather than a list of
 *   what happens to be on disk.
 *
 *   Nothing implies the worklist changed because local state changed. The item
 *   really does leave the worklist here, and the tool's own note still says
 *   that is the SCP's correlation and not proof.
 *
 * The MPPS tools reach `dcm mpps` through the runtime's command table rather
 * than through src/cli.js, so these tests pass whether or not the dispatcher
 * has been wired up yet.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');
const { dicomDate } = require('../../src/commands/mcp/tools-dimse');

/** The UID tools/make-fixtures.js gives its first study, and its patient. */
const STUDY_UID = '1.2.826.0.1.3680043.10.1337.1';
const PATIENT_ID = 'SYNTH0001';

/** A peer that is not there, for the paths that must refuse before connecting. */
const DEAD_PEER = { host: '127.0.0.1', port: 1, calledAe: 'NOBODY' };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Generates one synthetic study of `instances` CT images.
 *
 * One series, so the modality is unambiguous and `dcm mpps perform` can take it
 * from the folder the way a modality would.
 *
 * @param {number} [instances]
 * @returns {{root: string, study: string, count: number}}
 */
function makeStudy(instances = 4) {
  const root = tempDir('dcm-mcp-mpps-fx-');
  const script = path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js');
  const res = spawnSync(
    process.execPath,
    [script, root, '--studies', '1', '--series', '1', '--instances', String(instances)],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `fixture generation failed: ${res.stderr}`);
  return { root, study: path.join(root, 'study-1'), count: instances };
}

/**
 * Writes a worklist file holding one item that describes the fixture study.
 *
 * Scheduled for today, so a `scheduledDate: "today"` query is a real test of
 * the date resolution rather than a hardcoded string that rots.
 *
 * @param {string} dir
 * @returns {string} The file written.
 */
function makeWorklist(dir) {
  const file = path.join(dir, 'worklist.json');
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        PatientName: 'SYNTHETIC^PATIENT1',
        PatientID: PATIENT_ID,
        PatientBirthDate: '19700101',
        PatientSex: 'O',
        AccessionNumber: 'ACC0000001',
        StudyInstanceUID: STUDY_UID,
        RequestedProcedureID: 'RP001',
        RequestedProcedureDescription: 'CHEST',
        Modality: 'CT',
        ScheduledStationAETitle: 'CT01',
        ScheduledProcedureStepID: 'SPS001',
        ScheduledProcedureStepStartDate: dicomDate(0),
        ScheduledProcedureStepStartTime: '090000',
      },
    ], null, 2),
    'utf8'
  );
  return file;
}

async function withClient(fn) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'] });
  const client = new Client({ name: 'dcm-mpps-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn({
      client,
      call: (name, args) => client.callTool({ name, arguments: args }),
    });
  } finally {
    await client.close();
  }
}

/** The text half of a tool result. */
function textOf(res) {
  return (res.content || []).map((c) => c.text || '').join('\n');
}

/** Counts the .dcm files a receiver persisted. */
function countDicomFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.dcm')) n += 1;
  }
  return n;
}

// ---- Advertisement --------------------------------------------------------

test('the four MPPS verbs are advertised with the honesty rules in their descriptions', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of [
      'dcm_mpps_start', 'dcm_mpps_perform', 'dcm_mpps_complete', 'dcm_mpps_discontinue',
    ]) {
      assert.ok(byName.has(name), `missing tool ${name}; got ${[...byName.keys()].join(', ')}`);
    }

    const perform = byName.get('dcm_mpps_perform');
    // Rule 1: COMPLETED only when everything was acknowledged, and no override.
    assert.match(perform.description, /ONLY IF EVERY INSTANCE FOUND ON DISK WAS ACKNOWLEDGED/);
    assert.match(perform.description, /no override/i);
    assert.match(perform.description, /DISCONTINUED/);
    assert.match(perform.description, /error result/i);
    // Rule 2: the performed series comes from acknowledgements, not a folder.
    assert.match(perform.description, /only from instances the archive positively acknowledged/i);
    assert.match(perform.description, /never from a folder listing/i);
    // Rule 4: a worklist that changed is correlation, not proof.
    assert.match(perform.description, /not proof/i);
    // The local loop this makes possible.
    assert.match(perform.description, /dcm_receiver_start/);

    // Rule 2 again, from the other side: the folder-scan source has to carry
    // its own warning, because it is the one that can fabricate a record.
    const complete = byName.get('dcm_mpps_complete');
    assert.match(
      complete.inputSchema.properties.seriesFrom.description,
      /ASSERTS WHAT IS ON YOUR DISK, NOT WHAT THE ARCHIVE HOLDS/
    );
    assert.match(complete.description, /correlation rather than as proof/);

    // Rule 3: the Type 1 check is local and refuses by name.
    assert.match(byName.get('dcm_mpps_start').description, /Type 1/);
    assert.match(byName.get('dcm_mpps_start').description, /before anything goes on the wire/i);

    // The coded-reason judgement call, stated where it is read.
    const discontinue = byName.get('dcm_mpps_discontinue');
    assert.match(discontinue.description, /NOT sent/);
    assert.match(discontinue.inputSchema.properties.reasonCode.description, /CODE\^SCHEME\^MEANING/);
  });
});

test('no MPPS tool offers a way to force a COMPLETED', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const tool of tools.filter((t) => t.name.startsWith('dcm_mpps_'))) {
      for (const key of Object.keys(tool.inputSchema.properties || {})) {
        assert.doesNotMatch(key, /^force$/i, `${tool.name}.${key} would defeat rule 1`);
      }
    }
  });
});

test('dcm_mpps_perform takes the worklist keys as named parameters', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    const perform = tools.find((t) => t.name === 'dcm_mpps_perform');
    const properties = perform.inputSchema.properties;

    // The handoff is these parameters. If one disappears, a worklist row can no
    // longer be turned into a performed step without a file.
    for (const expected of [
      'studyUid', 'accessionNumber', 'scheduledStepId', 'modality',
      'patientId', 'patientName', 'patientBirthDate', 'patientSex',
      'requestedProcedureId', 'requestedProcedureDescription',
      'storeHost', 'storePort', 'storeCalledAe', 'writeAcknowledged', 'dryRun',
    ]) {
      assert.ok(properties[expected], `dcm_mpps_perform is missing the ${expected} parameter`);
    }
    assert.deepEqual((perform.inputSchema.required || []).includes('folder'), true);

    // The trap the CLI names by hand: rendered worklist JSON is not raw.
    assert.match(properties.fromWorklist.description, /json-raw/);
    assert.match(properties.fromWorklist.description, /NOT the output of dcm_worklist/);
  });
});

// ---- The loop -------------------------------------------------------------

test('worklist to MPPS: query, perform, and the item leaves the worklist', async (t) => {
  const fixture = makeStudy(4);
  const dir = tempDir('dcm-mcp-mpps-');
  const persist = tempDir('dcm-mcp-mpps-store-');
  t.after(() => {
    for (const d of [fixture.root, dir, persist]) fs.rmSync(d, { recursive: true, force: true });
  });
  const worklistFile = makeWorklist(dir);
  const record = path.join(dir, 'step.json');

  await withClient(async ({ call }) => {
    const started = await call('dcm_receiver_start', {
      ae: 'WORKLIST', worklist: worklistFile, persist,
    });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    const peer = { host, port, calledAe: 'WORKLIST' };

    try {
      // --- 1. What is scheduled? ---------------------------------------
      const scheduled = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
      assert.ok(!scheduled.isError, `worklist query failed: ${textOf(scheduled)}`);
      assert.equal(scheduled.structuredContent.count, 1);

      const row = scheduled.structuredContent.matches[0];
      assert.equal(row.StudyInstanceUID, STUDY_UID);
      assert.equal(row.PatientID, PATIENT_ID);

      // The handoff has to be usable without guessing, so the perform call is
      // built mechanically from the mapping the tool published rather than
      // from field names written out here.
      const handoff = scheduled.structuredContent.mppsHandoff;
      assert.ok(handoff, 'dcm_worklist did not publish the MPPS handoff mapping');
      assert.equal(handoff.tool, 'dcm_mpps_perform');
      assert.equal(handoff.correlationKeys[0], 'StudyInstanceUID');

      const stepArgs = {};
      for (const [key, parameter] of Object.entries(handoff.parameters)) {
        if (row[key] !== undefined && row[key] !== '') stepArgs[parameter] = row[key];
      }
      assert.equal(stepArgs.studyUid, STUDY_UID);
      assert.equal(stepArgs.scheduledStepId, 'SPS001');

      // --- 2. Perform it ------------------------------------------------
      const performed = await call('dcm_mpps_perform', {
        folder: fixture.study,
        ...peer,
        ...stepArgs,
        writeAcknowledged: record,
      });
      assert.ok(!performed.isError, `perform failed: ${textOf(performed)}`);

      const p = performed.structuredContent;
      assert.equal(p.performedProcedureStepStatus, 'COMPLETED');
      assert.equal(p.studyInstanceUid, STUDY_UID);
      assert.equal(p.found, fixture.count);
      assert.equal(p.acknowledged, fixture.count, 'acknowledged must equal found for a COMPLETED step');
      assert.equal(p.referencedInMpps, fixture.count);
      assert.equal(p.notReferenced, 0);
      assert.ok(!p.shortfall, `expected no shortfall, got ${p.shortfall}`);
      assert.equal(p.explanation, null);
      assert.equal(p.performedSeries.length, 1);
      assert.equal(p.performedSeries[0].instances, fixture.count);
      assert.ok(p.mppsSopInstanceUid, 'the step UID is the only handle on the step');

      // The images really went: the receiver wrote them.
      assert.equal(countDicomFiles(persist), fixture.count);

      // The step record is the honest source a later complete would read.
      const written = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(written.mppsSopInstanceUid, p.mppsSopInstanceUid);
      assert.equal(written.instances.length, fixture.count);
      for (const instance of written.instances) {
        assert.equal(instance.disposition, 'acknowledged');
      }

      // Rule 4 is in the answer even on the happy path.
      assert.match(textOf(performed), /not visible from here/);
      assert.match(textOf(performed), /correlating the two, not proof/);

      // --- 3. It is gone from the worklist ------------------------------
      const after = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
      assert.ok(!after.isError, `second worklist query failed: ${textOf(after)}`);
      assert.equal(
        after.structuredContent.count, 0,
        'the receiver should withhold an item whose performed step completed'
      );
      assert.match(textOf(after), /legitimate answer/);
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});

// ---- The shortfall --------------------------------------------------------

test('a partial transfer ends DISCONTINUED and is surfaced as an error result', async (t) => {
  const fixture = makeStudy(4);
  const dir = tempDir('dcm-mcp-mpps-short-');
  t.after(() => {
    for (const d of [fixture.root, dir]) fs.rmSync(d, { recursive: true, force: true });
  });
  const worklistFile = makeWorklist(dir);

  await withClient(async ({ call }) => {
    // dcm_receiver_start does not expose `dcm scp --reject-after`, which is how
    // the CLI tests induce a partial store. The shortfall is produced instead
    // by splitting the transaction across two receivers and having the storage
    // one refuse our calling AE Title: the step opens on the first, no instance
    // is ever acknowledged by the second, and the reconcile fails for real
    // rather than through a test hook.
    const mppsPeer = await call('dcm_receiver_start', { ae: 'MPPSSCP', worklist: worklistFile });
    assert.ok(!mppsPeer.isError, `MPPS receiver failed to start: ${textOf(mppsPeer)}`);
    const archive = await call('dcm_receiver_start', {
      ae: 'ARCHIVE', acceptCallingAe: ['OTHER-AE'],
    });
    assert.ok(!archive.isError, `archive receiver failed to start: ${textOf(archive)}`);

    try {
      const performed = await call('dcm_mpps_perform', {
        folder: fixture.study,
        host: mppsPeer.structuredContent.host,
        port: mppsPeer.structuredContent.port,
        calledAe: 'MPPSSCP',
        storeHost: archive.structuredContent.host,
        storePort: archive.structuredContent.port,
        storeCalledAe: 'ARCHIVE',
        studyUid: STUDY_UID,
        scheduledStepId: 'SPS001',
        modality: 'CT',
        patientId: PATIENT_ID,
      });

      assert.equal(performed.isError, true, 'a shortfall must not read as success');

      const p = performed.structuredContent;
      assert.ok(p, 'the numbers must survive the error result — they are the answer');
      assert.equal(p.ok, false);
      assert.equal(p.performedProcedureStepStatus, 'DISCONTINUED');
      assert.equal(p.found, fixture.count);
      assert.equal(p.acknowledged, 0);
      assert.ok(p.acknowledged < p.found, 'the shortfall is the point of this test');

      // Rule 2: nothing was acknowledged, so nothing may be named, even though
      // every one of those instances is sitting on disk.
      assert.equal(p.referencedInMpps, 0);
      assert.deepEqual(p.performedSeries, []);

      // Rule 1: said in numbers, in one sentence, and with no way out.
      assert.match(p.explanation, /0 of 4 instances were acknowledged/);
      assert.match(p.explanation, /DISCONTINUED, not COMPLETED/);
      assert.match(p.explanation, /4 instances are unaccounted for/);
      assert.match(textOf(performed), /no override for this/);
    } finally {
      await call('dcm_server_stop', { serverId: mppsPeer.structuredContent.serverId });
      await call('dcm_server_stop', { serverId: archive.structuredContent.serverId });
    }
  });
});

// ---- start / complete, and the folder-scan disclaimer ---------------------

test('start then complete, with the performed series asserted from disk', async (t) => {
  const fixture = makeStudy(2);
  const dir = tempDir('dcm-mcp-mpps-two-step-');
  t.after(() => {
    for (const d of [fixture.root, dir]) fs.rmSync(d, { recursive: true, force: true });
  });
  const record = path.join(dir, 'opened.json');

  await withClient(async ({ call }) => {
    const started = await call('dcm_receiver_start', { ae: 'MPPSSCP' });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    const peer = { host, port, calledAe: 'MPPSSCP' };

    try {
      const opened = await call('dcm_mpps_start', {
        ...peer,
        studyUid: STUDY_UID,
        modality: 'CT',
        scheduledStepId: 'SPS001',
        patientId: PATIENT_ID,
        out: record,
      });
      assert.ok(!opened.isError, `start failed: ${textOf(opened)}`);
      assert.equal(opened.structuredContent.performedProcedureStepStatus, 'IN PROGRESS');
      const mppsUid = opened.structuredContent.mppsSopInstanceUid;
      assert.ok(mppsUid);

      // Nothing about the worklist may be claimed by opening a step.
      assert.match(textOf(opened), /not visible from here/);

      // The two sources of a performed-series list answer the same question
      // differently, so asking for both is refused rather than merged.
      const both = await call('dcm_mpps_complete', {
        ...peer, mppsUid, acknowledged: record, seriesFrom: fixture.study,
      });
      assert.equal(both.isError, true);
      assert.match(textOf(both), /Pick one/);

      // --series-from is allowed, and says out loud what it is asserting.
      const completed = await call('dcm_mpps_complete', {
        ...peer, mppsUid, seriesFrom: fixture.study,
      });
      assert.ok(!completed.isError, `complete failed: ${textOf(completed)}`);
      assert.equal(completed.structuredContent.performedProcedureStepStatus, 'COMPLETED');
      assert.equal(completed.structuredContent.assertedFromDisk, true);
      assert.equal(completed.structuredContent.instancesReferenced, fixture.count);
      assert.match(textOf(completed), /scanning a local folder/);
      assert.match(textOf(completed), /Nothing here\s+confirms|Nothing here confirms/);

      // A terminal step is terminal: the SCP refuses a second N-SET.
      const again = await call('dcm_mpps_complete', { ...peer, mppsUid });
      assert.equal(again.isError, true, 'a completed step must not be completable twice');
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});

// ---- Refusals that happen before anything is sent -------------------------

test('a missing Type 1 attribute is refused locally, by name, with no connection', async (t) => {
  const fixture = makeStudy(1);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await withClient(async ({ call }) => {
    // No stepId and no scheduledStepId, so PerformedProcedureStepID is empty.
    // The peer is not there; if this ever tried to connect, it would fail with
    // a connection error instead of the message asserted below.
    const res = await call('dcm_mpps_perform', {
      folder: fixture.study, ...DEAD_PEER, studyUid: STUDY_UID, modality: 'CT',
    });

    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.match(text, /PerformedProcedureStepID/);
    assert.match(text, /Type 1/);
    assert.doesNotMatch(text, /ECONNREFUSED|connection refused/i);
  });
});

test('a study UID that disagrees with the folder is refused rather than sent', async (t) => {
  const fixture = makeStudy(1);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await withClient(async ({ call }) => {
    const res = await call('dcm_mpps_perform', {
      folder: fixture.study,
      ...DEAD_PEER,
      studyUid: '1.2.826.0.1.3680043.10.1337.999',
      modality: 'CT',
      stepId: 'STEP1',
    });

    assert.equal(res.isError, true);
    assert.match(textOf(res), /the folder holds 1\.2\.826\.0\.1\.3680043\.10\.1337\.1/);
  });
});

test('a dry run reports what would be sent without claiming an SCP answered', async (t) => {
  const fixture = makeStudy(3);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await withClient(async ({ call }) => {
    const res = await call('dcm_mpps_perform', {
      folder: fixture.study,
      ...DEAD_PEER,
      studyUid: STUDY_UID,
      modality: 'CT',
      stepId: 'STEP1',
      dryRun: true,
    });

    assert.ok(!res.isError, textOf(res));
    const p = res.structuredContent;
    assert.equal(p.dryRun, true);
    assert.equal(p.found, 3);
    assert.equal(p.dataset.PerformedProcedureStepStatus, 'IN PROGRESS');
    assert.equal(p.dataset.ScheduledStepAttributesSequence[0].StudyInstanceUID, STUDY_UID);

    const text = textOf(res);
    assert.match(text, /no connection was opened/);
    assert.match(text, /cannot be previewed/);
    // ok is true here, but nobody answered, and the note must not pretend one did.
    assert.doesNotMatch(text, /The SCP answered success/);
  });
});

test('a free-text discontinuation reason is recorded and not sent; a coded one is sent', async (t) => {
  await withClient(async ({ call }) => {
    const uid = '2.25.31415926535897932384626433832795028841';

    const freeText = await call('dcm_mpps_discontinue', {
      ...DEAD_PEER, mppsUid: uid, reason: 'patient could not tolerate the scan', dryRun: true,
    });
    assert.ok(!freeText.isError, textOf(freeText));
    assert.equal(freeText.structuredContent.reasonRecordedLocally, 'patient could not tolerate the scan');
    // Absent, not empty: the attribute is only written when a real code exists.
    assert.equal(
      freeText.structuredContent.dataset.PerformedProcedureStepDiscontinuationReasonCodeSequence,
      undefined
    );
    assert.match(textOf(freeText), /recorded in this result and NOT sent/);

    const coded = await call('dcm_mpps_discontinue', {
      ...DEAD_PEER,
      mppsUid: uid,
      reasonCode: '110513^DCM^Discontinued for equipment failure',
      dryRun: true,
    });
    assert.ok(!coded.isError, textOf(coded));
    const sequence = coded.structuredContent.dataset
      .PerformedProcedureStepDiscontinuationReasonCodeSequence;
    assert.equal(sequence.length, 1);
    assert.equal(sequence[0].CodeValue, '110513');
    assert.equal(sequence[0].CodingSchemeDesignator, 'DCM');
    assert.doesNotMatch(textOf(coded), /NOT sent/);
  });
});
