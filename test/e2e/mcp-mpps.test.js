'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
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

/**
 * A Study Instance UID a RIS invented, which no image on disk can carry.
 *
 * This is the case the owner hit: the worklist item names a study the stock
 * images know nothing about, because in real life the RIS mints that UID before
 * the patient is on the table. The value is the one from their report.
 */
const RIS_STUDY_UID = '2.25.7409558135166679574647759021724211267';

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
 * @param {object} [overrides]  Item keys to replace — StudyInstanceUID above
 *   all, for the case where the order names a study the images do not carry.
 * @returns {string} The file written.
 */
function makeWorklist(dir, overrides = {}) {
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
        ...overrides,
      },
    ], null, 2),
    'utf8'
  );
  return file;
}

/**
 * sha256 of every file under a folder, by relative path.
 *
 * The claim "the source folder is never modified" is worth exactly what a test
 * says about it, and only bytes can say it: a copy that re-stamps in place
 * would leave the same file count and the same names behind.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
function hashTree(root) {
  const hashes = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    hashes[path.relative(root, full)] =
      crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return hashes;
}

/**
 * Turns a dcm_worklist row into dcm_mpps_perform parameters using the mapping
 * the tool published, rather than field names written out here.
 *
 * @param {object} scheduled  A dcm_worklist result.
 * @returns {object}
 */
function handoffArgs(scheduled) {
  const { mppsHandoff, matches } = scheduled.structuredContent;
  assert.ok(mppsHandoff, 'dcm_worklist did not publish the MPPS handoff mapping');
  const stepArgs = {};
  for (const [key, parameter] of Object.entries(mppsHandoff.parameters)) {
    if (matches[0][key] !== undefined && matches[0][key] !== '') {
      stepArgs[parameter] = matches[0][key];
    }
  }
  return stepArgs;
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

test('the MPPS tools are advertised with the honesty rules in their descriptions', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of [
      'dcm_mpps_start', 'dcm_mpps_perform', 'dcm_mpps_complete', 'dcm_mpps_discontinue',
    ]) {
      assert.ok(byName.has(name), `missing tool ${name}; got ${[...byName.keys()].join(', ')}`);
    }
    assert.equal(byName.has('dcm_mpps_list'), false, 'nothing records steps, so nothing lists them');

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

test('no MPPS tool takes a parameter that would write or read a file of steps', async () => {
  // MPPS is stateless about procedure steps: no record directory, no per-step
  // files, no local database. A parameter that survived the removal would be a
  // trap — it would name machinery that is gone.
  const banned = new Set(['recordDir', 'record', 'select', 'writeAcknowledged', 'acknowledged', 'out']);
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const tool of tools.filter((t) => t.name.startsWith('dcm_mpps_'))) {
      for (const key of Object.keys(tool.inputSchema.properties || {})) {
        assert.equal(banned.has(key), false, `${tool.name}.${key} names machinery that is gone`);
      }
      // And no description may still promise it.
      assert.doesNotMatch(tool.description, /recordDir|dcm_mpps_list|writeAcknowledged/);
    }
  });
});

test('dcm_mpps_start says the returned UID is the only handle there will ever be', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    const start = tools.find((t) => t.name === 'dcm_mpps_start');
    assert.match(start.description, /ONLY handle on the step/);
    assert.match(start.description, /KEEP IT/);
    assert.match(start.description, /no query service/);

    // And the closing verbs say the UID is the only way in, so an assistant
    // does not go looking for a listing that no longer exists.
    for (const name of ['dcm_mpps_complete', 'dcm_mpps_discontinue']) {
      const tool = tools.find((t) => t.name === name);
      assert.match(tool.description, /named by its UID and by nothing else/);
      assert.ok(
        (tool.inputSchema.required || []).includes('mppsUid'),
        `${name} must require mppsUid — there is nowhere else to get it`
      );
    }
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
      'storeHost', 'storePort', 'storeCalledAe', 'dryRun',
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

      // Nothing was written anywhere: the whole transaction lived in one call,
      // which is the reason no persistence is needed for the common case.
      assert.deepEqual(
        fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== path.basename(worklistFile)),
        [],
        'a perform must leave no step file behind'
      );

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
      });
      assert.ok(!opened.isError, `start failed: ${textOf(opened)}`);
      assert.equal(opened.structuredContent.performedProcedureStepStatus, 'IN PROGRESS');
      const mppsUid = opened.structuredContent.mppsSopInstanceUid;
      assert.ok(mppsUid);

      // Nothing about the worklist may be claimed by opening a step.
      assert.match(textOf(opened), /not visible from here/);

      // Nothing was written down: the UID in the result is the whole handoff.
      assert.deepEqual(fs.readdirSync(dir), [], 'start must leave no file behind');

      // --series-from is the only performed-series source a standalone close
      // has, and it says out loud what it is asserting.
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

// ---- Adopting the worklist identity ---------------------------------------

test('the two ways past a study-UID mismatch are advertised with their consequences', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    const properties = tools.find((t) => t.name === 'dcm_mpps_perform').inputSchema.properties;

    for (const expected of [
      'adoptWorklistIdentity', 'studyUidOnly', 'staging', 'keepStaging', 'allowStudyMismatch',
    ]) {
      assert.ok(properties[expected], `dcm_mpps_perform is missing the ${expected} parameter`);
    }

    // The reasoning, not the mechanics: an assistant choosing between these two
    // has to know that one is what a modality does and the other is a decision
    // to leave the archive unable to reconcile anything.
    const adopt = properties.adoptWorklistIdentity.description;
    assert.match(adopt, /WHAT A REAL MODALITY DOES/i);
    assert.match(adopt, /before the patient is on the table/);
    assert.match(adopt, /rehears/i);
    assert.match(adopt, /SOURCE FOLDER IS NEVER MODIFIED/);
    assert.match(adopt, /Series and SOP Instance UIDs are deliberately never re-stamped/);
    assert.match(adopt, /private tags/);

    const allow = properties.allowStudyMismatch.description;
    assert.match(allow, /NEVER RECONCILE/i);
    assert.match(allow, /original bytes/i);

    // Neither may be implied by another argument, and both say so where the
    // choice is being made.
    assert.match(adopt, /Nothing else turns this on/);
    assert.match(allow, /not implied by any other parameter/);
    assert.match(properties.studyUid.description, /Neither is chosen for you/);

    // seriesFrom is now the only performed-series source the closing verbs
    // have, and it has to say so rather than point at a source that is gone.
    for (const name of ['dcm_mpps_complete', 'dcm_mpps_discontinue']) {
      const tool = tools.find((t) => t.name === name);
      const seriesFrom = tool.inputSchema.properties.seriesFrom.description;
      assert.match(seriesFrom, /ONLY source this tool has/);
      assert.match(seriesFrom, /ASSERTS WHAT IS ON YOUR DISK/);
      assert.match(seriesFrom, /dcm_mpps_perform/);
    }
  });
});

test('stock images against a made-up worklist: refused, then re-stamped and reconciled', async (t) => {
  const fixture = makeStudy(4);
  const dir = tempDir('dcm-mcp-mpps-adopt-');
  const persist = tempDir('dcm-mcp-mpps-adopt-store-');
  const staging = tempDir('dcm-mcp-mpps-adopt-stage-');
  t.after(() => {
    for (const d of [fixture.root, dir, persist, staging]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // The order names a study these images cannot possibly carry.
  const worklistFile = makeWorklist(dir, { StudyInstanceUID: RIS_STUDY_UID });
  const sourceBefore = hashTree(fixture.study);

  await withClient(async ({ call }) => {
    const started = await call('dcm_receiver_start', {
      ae: 'WORKLIST', worklist: worklistFile, persist,
    });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    const peer = { host, port, calledAe: 'WORKLIST' };

    try {
      const scheduled = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
      assert.ok(!scheduled.isError, `worklist query failed: ${textOf(scheduled)}`);
      const stepArgs = handoffArgs(scheduled);
      assert.equal(stepArgs.studyUid, RIS_STUDY_UID);
      assert.notEqual(stepArgs.studyUid, STUDY_UID, 'the whole point is that they differ');

      // --- 1. Refused, before anything is opened or sent -----------------
      const refused = await call('dcm_mpps_perform', {
        folder: fixture.study, ...peer, ...stepArgs,
      });
      assert.equal(refused.isError, true, 'the mismatch must not be sent by default');

      const refusal = textOf(refused);
      assert.match(refusal, /would never reconcile them/);
      assert.match(refusal, new RegExp(RIS_STUDY_UID.replace(/\./g, '\\.')));
      assert.match(refusal, /the folder holds 1\.2\.826\.0\.1\.3680043\.10\.1337\.1/);
      // A refusal with no way forward is what the owner ran into.
      assert.match(refusal, /--adopt-worklist-identity/);
      assert.match(refusal, /--allow-study-mismatch/);
      assert.equal(countDicomFiles(persist), 0, 'nothing may be sent by a refused run');

      // --- 2. Adopt the identity, the way a modality would ---------------
      const performed = await call('dcm_mpps_perform', {
        folder: fixture.study,
        ...peer,
        ...stepArgs,
        adoptWorklistIdentity: true,
        staging,
      });
      assert.ok(!performed.isError, `perform with adoption failed: ${textOf(performed)}`);

      const p = performed.structuredContent;
      assert.equal(p.performedProcedureStepStatus, 'COMPLETED');
      assert.equal(p.studyInstanceUid, RIS_STUDY_UID, 'the step names the study the order named');
      assert.equal(p.found, fixture.count);
      assert.equal(p.acknowledged, fixture.count);
      assert.equal(p.referencedInMpps, fixture.count);

      // The re-stamp is reported rather than done quietly.
      assert.ok(p.restamp, 're-stamping must be visible in the result');
      assert.equal(p.restamp.source, path.resolve(fixture.study));
      assert.equal(p.restamp.sourceModified, false);
      assert.equal(p.restamp.instances, fixture.count);
      assert.ok(p.restamp.attributes.includes('StudyInstanceUID'));
      assert.deepEqual(p.restamp.unchangedByDesign, ['SeriesInstanceUID', 'SOPInstanceUID']);
      assert.ok(
        p.restamp.stagingDir.startsWith(path.resolve(staging)),
        `the copy went to ${p.restamp.stagingDir}, not under the staging directory given`
      );
      assert.equal(p.restamp.stagingKept, false);
      assert.deepEqual(
        fs.readdirSync(staging), [],
        'a COMPLETED run should leave no staged copy behind'
      );

      // The claim that matters most: the images on disk are untouched.
      assert.deepEqual(hashTree(fixture.study), sourceBefore);

      // And the result says in words what it did, not only in JSON fields.
      const said = textOf(performed);
      assert.match(said, /re-stamped COPY/);
      assert.match(said, /source folder at .* is not modified/);
      assert.match(said, /SeriesInstanceUID and SOPInstanceUID are left exactly as/);

      // What the archive holds is the study the ORDER named, not the fixture's.
      assert.equal(countDicomFiles(persist), fixture.count);
      const inventory = await call('dcm_inventory', { path: persist });
      assert.ok(!inventory.isError, textOf(inventory));
      assert.deepEqual(
        inventory.structuredContent.studies.map((s) => s.studyInstanceUid),
        [RIS_STUDY_UID]
      );

      // And so the step and the images reconcile: the item leaves the worklist.
      const after = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
      assert.equal(
        after.structuredContent.count, 0,
        'the receiver should correlate the completed step with the scheduled item'
      );

    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});

test('allowStudyMismatch sends the images unchanged, and nothing reconciles', async (t) => {
  const fixture = makeStudy(2);
  const dir = tempDir('dcm-mcp-mpps-mismatch-');
  const persist = tempDir('dcm-mcp-mpps-mismatch-store-');
  t.after(() => {
    for (const d of [fixture.root, dir, persist]) fs.rmSync(d, { recursive: true, force: true });
  });
  const worklistFile = makeWorklist(dir, { StudyInstanceUID: RIS_STUDY_UID });

  await withClient(async ({ call }) => {
    const started = await call('dcm_receiver_start', {
      ae: 'WORKLIST', worklist: worklistFile, persist,
    });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    const peer = { host, port, calledAe: 'WORKLIST' };
    const step = { studyUid: RIS_STUDY_UID, modality: 'CT', stepId: 'STEP1' };

    try {
      // Asking for both is refused: they want opposite things.
      const both = await call('dcm_mpps_perform', {
        folder: fixture.study,
        ...peer,
        ...step,
        adoptWorklistIdentity: true,
        allowStudyMismatch: true,
      });
      assert.equal(both.isError, true);
      assert.match(textOf(both), /opposite things/);

      // Neither is implied by the staging parameters.
      const stagingAlone = await call('dcm_mpps_perform', {
        folder: fixture.study, ...peer, ...step, keepStaging: true,
      });
      assert.equal(stagingAlone.isError, true, 'keepStaging must not turn adoption on');
      assert.match(textOf(stagingAlone), /no copy would be made/);

      const sent = await call('dcm_mpps_perform', {
        folder: fixture.study, ...peer, ...step, allowStudyMismatch: true,
      });
      assert.ok(!sent.isError, `perform with allowStudyMismatch failed: ${textOf(sent)}`);

      const p = sent.structuredContent;
      assert.equal(p.allowStudyMismatch, true);
      assert.equal(p.restamp, null, 'nothing may be re-stamped on this path');
      assert.deepEqual(p.studyUidMismatch, { declared: RIS_STUDY_UID, onDisk: STUDY_UID });

      // The consequence has to be in words in the result, not only in a pair of
      // JSON fields: this is the one path where a success means the archive
      // ends up unable to join the step to the images.
      const text = textOf(sent);
      assert.match(text, /UNDER A STUDY THE STEP DOES NOT NAME/);
      assert.match(text, /never be reconciled/);
      assert.match(text, /adoptWorklistIdentity is the parameter that makes them agree/);

      // The images went as they are, under their own study — which is exactly
      // the damage. The step and the ORDER still correlate, because the step
      // names the study the order named; it is the IMAGES that are orphaned,
      // filed under a study no step describes.
      const inventory = await call('dcm_inventory', { path: persist });
      assert.deepEqual(
        inventory.structuredContent.studies.map((s) => s.studyInstanceUid),
        [STUDY_UID],
        'the images must be stored exactly as they were, under their own study'
      );
      assert.notEqual(
        inventory.structuredContent.studies[0].studyInstanceUid,
        p.studyInstanceUid,
        'the archive holds a study the completed step does not name — nothing joins them'
      );
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});

// ---- Closing a step with the UID, because there is nothing else -----------

test('a step opened by start is closed by its UID and by nothing else', async (t) => {
  const dir = tempDir('dcm-mcp-mpps-uid-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
        accessionNumber: 'ACC0000001',
        patientId: PATIENT_ID,
        patientName: 'SYNTHETIC^PATIENT1',
      });
      assert.ok(!opened.isError, `start failed: ${textOf(opened)}`);

      // The UID is the whole handoff, so it has to be in the structured result
      // and not only somewhere in the prose.
      const mppsUid = opened.structuredContent.mppsSopInstanceUid;
      assert.ok(mppsUid, 'the step UID is the only handle on the step');
      assert.doesNotMatch(textOf(opened), /Filed as |recordDir/);

      // Nothing was written: not into the working directory, not anywhere the
      // caller named, because there is nowhere for it to go.
      assert.deepEqual(fs.readdirSync(dir), [], 'start must leave no file behind');

      const closed = await call('dcm_mpps_complete', { ...peer, mppsUid });
      assert.ok(!closed.isError, `complete failed: ${textOf(closed)}`);
      assert.equal(closed.structuredContent.mppsSopInstanceUid, mppsUid);
      assert.equal(closed.structuredContent.performedProcedureStepStatus, 'COMPLETED');

      // Closed with no performed series at all, which is legal and warned about
      // rather than quietly filled in from a folder nobody named.
      assert.equal(closed.structuredContent.seriesCount, 0);

      // A terminal step is terminal: the SCP refuses the second N-SET.
      const again = await call('dcm_mpps_complete', { ...peer, mppsUid });
      assert.equal(again.isError, true, 'a completed step must not be completable twice');

      // And with no UID there is nothing to fall back on — the call is refused
      // rather than reaching for a listing or asking the peer.
      const noUid = await call('dcm_mpps_complete', { ...peer });
      assert.equal(noUid.isError, true, 'mppsUid is the only way to name a step');
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});
