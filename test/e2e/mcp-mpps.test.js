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

/**
 * Copies `count` instances out of a study folder into `into`.
 *
 * An interim update exists to report a sequence that GROWS, and the only way
 * to test that honestly is a folder that really is growing between calls —
 * pointing two updates at the same static folder would prove nothing about the
 * cumulative rule.
 *
 * @param {string} from  A folder of .dcm files.
 * @param {string} into  Destination, created if needed.
 * @param {number} count  How many files to have in `into` afterwards.
 * @returns {number} How many are there now.
 */
function fillFolder(from, into, count) {
  fs.mkdirSync(into, { recursive: true });
  const files = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.dcm')) {
      files.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  files.sort();
  for (const file of files.slice(0, count)) {
    fs.copyFileSync(file, path.join(into, path.basename(file)));
  }
  return Math.min(count, files.length);
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

// ---- The interim N-SET ----------------------------------------------------

/**
 * Reads the step a `dcm scp --persist` receiver wrote for `mppsUid`.
 *
 * This is the only way to see what the RECEIVER holds. Everything else in this
 * file asserts what the sending half said it did, and for an interim update
 * that is precisely the thing not worth asserting: "the sequence was not sent"
 * and "the sequence was sent empty" produce almost the same result document and
 * opposite states on the far end. Only the receiver's own copy tells them
 * apart.
 *
 * @param {string} persist  The receiver's persist directory.
 * @param {string} mppsUid
 * @returns {object} The step as the receiver recorded it.
 */
function receiverStep(persist, mppsUid) {
  const dir = path.join(persist, 'mpps');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const step = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (step.sopInstanceUid === mppsUid) return step;
  }
  throw new assert.AssertionError({
    message: `the receiver recorded no step ${mppsUid}; it has ${files.join(', ') || 'nothing'}`,
  });
}

/** Instances named across a recorded step's PerformedSeriesSequence. */
function referencedInStep(step) {
  const series = step.elements.PerformedSeriesSequence;
  if (!Array.isArray(series)) return null;
  return series.reduce(
    (n, item) => n + (Array.isArray(item?.ReferencedImageSequence) ? item.ReferencedImageSequence.length : 0),
    0
  );
}

test('the interim update tool is advertised with the replace rule and both wire shapes', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const update = byName.get('dcm_mpps_update');
    assert.ok(update, `missing dcm_mpps_update; got ${[...byName.keys()].join(', ')}`);

    // What it is for. Both halves, because a tool that only says "interim
    // N-SET" tells an assistant nothing about when to reach for it.
    assert.match(update.description, /still running/i);
    assert.match(update.description, /WITHOUT closing it/i);
    assert.match(update.description, /GROWING PerformedSeriesSequence/);

    // The rule that makes the sequence dangerous, and the rule that makes
    // omitting it safe. These are opposites and both have to be said.
    assert.match(update.description, /REPLACE, THEY DO NOT APPEND/);
    assert.match(update.description, /CUMULATIVE/);
    assert.match(update.description, /MUST NOT BE READ AS ERASING ANYTHING/);
    assert.match(update.inputSchema.properties.seriesFrom.description, /erases nothing/i);

    // Both shapes reachable, and distinguished by absence rather than emptiness.
    assert.ok(update.inputSchema.properties.omitStatus, 'the status-absent shape must be reachable');
    assert.match(update.description, /IN PROGRESS/);
    assert.match(update.inputSchema.properties.omitStatus.description, /ABSENT from the dataset/);
    assert.match(
      update.inputSchema.properties.omitStatus.description,
      /not the same as present-and-empty/
    );

    // It closes nothing, and no end date/time may be offered — an end time on a
    // running step is the contradiction the CLI refuses outright.
    assert.equal(update.inputSchema.properties.endDate, undefined);
    assert.equal(update.inputSchema.properties.endTime, undefined);
    assert.match(update.description, /cannot|Use dcm_mpps_complete or dcm_mpps_discontinue/);
    // And it may not carry what an N-SET cannot change.
    for (const banned of ['studyUid', 'modality', 'stepId', 'stationAe', 'patientId', 'startDate']) {
      assert.equal(
        update.inputSchema.properties[banned], undefined,
        `${banned} is N-CREATE-only; offering it here would promise something PS3.4 forbids`
      );
    }
    assert.ok((update.inputSchema.required || []).includes('mppsUid'));
  });
});

test('an interim update grows the performed series; a keep-alive leaves it alone', async (t) => {
  const fixture = makeStudy(4);
  const dir = tempDir('dcm-mcp-mpps-interim-');
  const persist = tempDir('dcm-mcp-mpps-interim-store-');
  const growing = path.join(dir, 'acquired-so-far');
  t.after(() => {
    for (const d of [fixture.root, dir, persist]) fs.rmSync(d, { recursive: true, force: true });
  });
  const worklistFile = makeWorklist(dir);

  // Two of the four instances have been acquired when the first update goes out.
  assert.equal(fillFolder(fixture.study, growing, 2), 2);

  await withClient(async ({ call }) => {
    const started = await call('dcm_receiver_start', {
      ae: 'WORKLIST', worklist: worklistFile, persist,
    });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    const peer = { host, port, calledAe: 'WORKLIST' };

    try {
      // --- The scheduled row, so this is the real loop and not a fixture ---
      const scheduled = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
      assert.ok(!scheduled.isError, `worklist query failed: ${textOf(scheduled)}`);
      const stepArgs = handoffArgs(scheduled);
      assert.equal(stepArgs.studyUid, STUDY_UID);

      // --- 1. Open the step ---------------------------------------------
      const opened = await call('dcm_mpps_start', { ...peer, ...stepArgs });
      assert.ok(!opened.isError, `start failed: ${textOf(opened)}`);
      const mppsUid = opened.structuredContent.mppsSopInstanceUid;
      const atCreate = receiverStep(persist, mppsUid);
      assert.equal(atCreate.status, 'IN PROGRESS');
      // The N-CREATE carries PerformedSeriesSequence as a present, empty Type 2
      // attribute, so the receiver already holds a zero-length one. Every
      // "erased nothing" assertion below is against this baseline rather than
      // against absence.
      assert.equal(referencedInStep(atCreate), 0);

      // --- 2. The status-bearing shape, which is a keep-alive ------------
      //
      // This receiver used to answer it 0x0106. That was a bug — PS3.4 F.7.2-1
      // lists PerformedProcedureStepStatus among the attributes an N-SET may
      // carry — and it is the receiver behaviour that makes a real modality
      // abandon the session. Accepted now, and what has to hold with it is
      // that a message carrying only a status deposits only a status.
      const keepAlive = await call('dcm_mpps_update', { ...peer, mppsUid });
      assert.ok(!keepAlive.isError, `keep-alive failed: ${textOf(keepAlive)}`);
      const alive = keepAlive.structuredContent;
      assert.equal(alive.ok, true);
      assert.equal(alive.status.code, '0x0000', 'the receiver has to have accepted it');
      assert.equal(alive.statusSent, true);
      assert.equal(alive.statusValue, 'IN PROGRESS');
      assert.equal(alive.performedSeriesSent, false);
      assert.equal(alive.endDateTimeSent, false, 'a keep-alive never ends the step');
      assert.match(textOf(keepAlive), /re-asserting that the step is running/);
      assert.match(textOf(keepAlive), /must not be read as erasing anything/);
      // It reached the far end, and it deposited nothing but the status.
      const afterKeepAlive = receiverStep(persist, mppsUid);
      assert.equal(afterKeepAlive.status, 'IN PROGRESS', 'a keep-alive does not close the step');
      assert.equal(afterKeepAlive.updates, atCreate.updates + 1, 'the receiver took it');
      assert.equal(
        referencedInStep(afterKeepAlive), 0,
        'no sequence was sent, so none may appear'
      );

      // --- 3. The status-absent shape, which it accepts ------------------
      const first = await call('dcm_mpps_update', {
        ...peer, mppsUid, omitStatus: true, seriesFrom: growing,
      });
      assert.ok(!first.isError, `interim update failed: ${textOf(first)}`);
      const u1 = first.structuredContent;
      assert.equal(u1.ok, true);
      assert.equal(u1.status.code, '0x0000', 'the receiver has to have accepted it');
      assert.equal(u1.statusSent, false, 'omitStatus means the attribute is not in the dataset');
      assert.equal(u1.statusValue, null);
      assert.equal(u1.endDateTimeSent, false, 'an interim update never ends the step');
      assert.equal(u1.performedSeriesSent, true);
      assert.equal(u1.seriesCount, 1);
      assert.equal(u1.instancesReferenced, 2);
      assert.equal(u1.assertedFromDisk, true);

      // The receiver holds what was sent, and the step is still open.
      const held1 = receiverStep(persist, mppsUid);
      assert.equal(held1.status, 'IN PROGRESS', 'an interim update must not close the step');
      assert.equal(referencedInStep(held1), 2);

      // The two claims that only exist in prose under --json.
      assert.match(textOf(first), /NO PerformedProcedureStepStatus/);
      assert.match(textOf(first), /REPLACED the one the step\s+held/);
      assert.match(textOf(first), /scanning a local folder/);

      // --- 4. Two more instances arrive; the sequence grows --------------
      assert.equal(fillFolder(fixture.study, growing, 4), 4);
      const second = await call('dcm_mpps_update', {
        ...peer, mppsUid, omitStatus: true, seriesFrom: growing,
      });
      assert.ok(!second.isError, `second interim update failed: ${textOf(second)}`);
      assert.equal(second.structuredContent.instancesReferenced, 4);
      const held2 = receiverStep(persist, mppsUid);
      assert.equal(held2.status, 'IN PROGRESS');
      assert.equal(
        referencedInStep(held2), 4,
        'a cumulative folder scan is what makes replacement behave like growth'
      );

      // --- 5. A keep-alive over a step that now holds four ---------------
      //
      // The claim the description makes in capitals, tested where it can
      // actually be observed and where it can actually fail: this one goes on
      // the wire, and the receiver's own copy still holds all four afterwards.
      const stillAlive = await call('dcm_mpps_update', { ...peer, mppsUid });
      assert.ok(!stillAlive.isError, `keep-alive failed: ${textOf(stillAlive)}`);
      const held3 = receiverStep(persist, mppsUid);
      assert.equal(held3.status, 'IN PROGRESS');
      assert.equal(held3.updates, held2.updates + 1, 'it reached the receiver');
      assert.equal(
        referencedInStep(held3), 4,
        'an absent PerformedSeriesSequence is not an empty one and erases nothing'
      );

      // --- 6. And one that would carry nothing at all never leaves -------
      const quiet = await call('dcm_mpps_update', { ...peer, mppsUid, omitStatus: true });
      assert.equal(quiet.isError, true, 'an N-SET carrying nothing at all is refused, not sent');
      assert.match(textOf(quiet), /keep-alive|status-absent/);

      const held4 = receiverStep(persist, mppsUid);
      assert.equal(referencedInStep(held4), 4, 'nothing may have touched the sequence');
      assert.equal(held4.updates, held3.updates, 'a refused update is not an update');

      // --- 7. Close it ---------------------------------------------------
      const closed = await call('dcm_mpps_complete', { ...peer, mppsUid, seriesFrom: growing });
      assert.ok(!closed.isError, `complete failed: ${textOf(closed)}`);
      assert.equal(closed.structuredContent.performedProcedureStepStatus, 'COMPLETED');
      assert.equal(closed.structuredContent.instancesReferenced, 4);
      assert.equal(receiverStep(persist, mppsUid).status, 'COMPLETED');

      // A closed step is closed: the interim verb cannot reopen it.
      const late = await call('dcm_mpps_update', {
        ...peer, mppsUid, omitStatus: true, seriesFrom: growing,
      });
      assert.equal(late.isError, true, 'a terminal step may no longer be updated');
      assert.equal(late.structuredContent.status.code, '0x0110');

      // And the loop still closes: the item leaves the worklist on the
      // COMPLETED, never on an update.
      const after = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
      assert.equal(after.structuredContent.count, 0);
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});

test('an interim update that would carry nothing is refused before any connection', async () => {
  await withClient(async ({ call }) => {
    const res = await call('dcm_mpps_update', {
      ...DEAD_PEER,
      mppsUid: '2.25.31415926535897932384626433832795028841',
      omitStatus: true,
    });
    assert.equal(res.isError, true);
    const text = textOf(res);
    // Both branches named, so the refusal is actionable rather than a dead end.
    assert.match(text, /keep-alive/);
    assert.match(text, /status-absent/);
    assert.doesNotMatch(text, /ECONNREFUSED|connection refused/i);
  });
});

// ---- Unscheduled steps ----------------------------------------------------

test('an unscheduled step is one zero-length item, and our own receiver cannot read it', async (t) => {
  const fixture = makeStudy(2);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await withClient(async ({ client, call }) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    // The shape, said where the choice is made, on both tools that offer it.
    for (const name of ['dcm_mpps_start', 'dcm_mpps_perform']) {
      const described = byName.get(name).inputSchema.properties.unscheduled;
      assert.ok(described, `${name} does not offer unscheduled`);
      assert.match(described.description, /ONE ZERO-LENGTH item/);
      assert.match(described.description, /PRESENT/);
      // The three wrong shapes, so an assistant does not invent one of them.
      assert.match(described.description, /omitting the sequence/);
      assert.match(described.description, /never reconcile/);
    }
    // And on perform, the divergence that only exists there.
    const onPerform = byName.get('dcm_mpps_perform').inputSchema.properties.unscheduled.description;
    assert.match(onPerform, /C-STORE STILL USES THE FOLDER'S OWN STUDY INSTANCE UID/);

    // --- The dataset that goes on the wire ----------------------------
    const planned = await call('dcm_mpps_start', {
      ...DEAD_PEER, unscheduled: true, modality: 'DX', stepId: 'WALKIN-014', dryRun: true,
    });
    assert.ok(!planned.isError, textOf(planned));
    const sequence = planned.structuredContent.dataset.ScheduledStepAttributesSequence;
    assert.equal(Array.isArray(sequence), true, 'the sequence is present, not omitted');
    assert.equal(sequence.length, 1, 'exactly one item');
    assert.deepEqual(Object.keys(sequence[0]), [], 'and that item is zero-length, not blank-filled');
    assert.equal(planned.structuredContent.unscheduled, true);

    // On perform the two identities diverge, and the result has to print both
    // — a run where they differ silently is the run nobody can debug.
    const plannedPerform = await call('dcm_mpps_perform', {
      folder: fixture.study,
      ...DEAD_PEER,
      unscheduled: true,
      modality: 'CT',
      stepId: 'WALKIN-015',
      dryRun: true,
    });
    assert.ok(!plannedPerform.isError, textOf(plannedPerform));
    const pp = plannedPerform.structuredContent;
    assert.equal(pp.unscheduled, true);
    // The dry-run document names the folder's study `studyInstanceUid`; the
    // live one names the same value `imagesStudyInstanceUid`. Both are read,
    // because a consumer that knows only one of the two names breaks on the
    // other run — see the note to the integrator.
    assert.equal(
      pp.imagesStudyInstanceUid ?? pp.studyInstanceUid, STUDY_UID,
      'the C-STORE keeps the folder\'s study'
    );
    assert.equal(pp.stepStudyInstanceUid, null, 'the step names none');
    assert.deepEqual(pp.dataset.ScheduledStepAttributesSequence, [{}]);
    assert.match(textOf(plannedPerform), /UNSCHEDULED/);
    assert.match(
      textOf(plannedPerform),
      new RegExp(`would be filed under ${STUDY_UID.replace(/\./g, '\\.')}`)
    );

    // And it is refused alongside a study UID, which says the opposite.
    const contradiction = await call('dcm_mpps_start', {
      ...DEAD_PEER, unscheduled: true, studyUid: STUDY_UID, modality: 'DX', stepId: 'W1',
    });
    assert.equal(contradiction.isError, true);

    // --- What our own receiver does with it ---------------------------
    //
    // Nothing good, and the reason is below this tool: dcmjs's naturalising
    // parser reads a sequence holding one zero-length item back as [], so
    // dcm scp is handed an empty Type 1 and answers 0x0120 Missing Attribute
    // — correctly, about something it was never given. The SCU half is still
    // worth shipping, because the receivers this gets pointed at in the field
    // are not dcmjs, but --unscheduled cannot be rehearsed against
    // dcm_receiver_start today and a demo that pretends otherwise would be
    // the silent gap this whole exercise is about. Pinned so that the day the
    // library carries the item, this fails and the note gets rewritten.
    const started = await call('dcm_receiver_start', { ae: 'MPPSSCP' });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    try {
      const sent = await call('dcm_mpps_start', {
        host, port, calledAe: 'MPPSSCP',
        unscheduled: true, modality: 'DX', stepId: 'WALKIN-014',
      });
      assert.equal(
        sent.isError, true,
        'if this now succeeds, dcmjs carries the zero-length item and the note above is stale'
      );
      assert.equal(sent.structuredContent.status.code, '0x0120');
      assert.match(textOf(sent), /ScheduledStepAttributesSequence/);
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});

// ---- Scoping a close to one study of several ------------------------------

test('the closing verbs take studyUid to scope a folder that holds two studies', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of ['dcm_mpps_complete', 'dcm_mpps_discontinue']) {
      const properties = tools.find((t) => t.name === name).inputSchema.properties;
      const studyUid = properties.studyUid;
      assert.ok(studyUid, `${name} cannot scope seriesFrom without studyUid`);
      // It narrows the scan. It does not restamp, and it does not change what
      // the step names — an assistant that believed either would use it to
      // paper over a mismatch that ought to be refused.
      assert.match(studyUid.description, /SCOPES; it does not re-stamp/);
      assert.match(studyUid.description, /SINGLE study/);
      // And the refusal it exists for is named on the parameter it applies to.
      assert.match(properties.seriesFrom.description, /REFUSED rather than merged/);
    }
  });
});

// ---- Conformance testing on the query side --------------------------------

test('the query tools expose the fidelity and injection paths, unmistakably', async () => {
  await withClient(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of ['dcm_query', 'dcm_worklist']) {
      const properties = tools.find((t) => t.name === name).inputSchema.properties;

      // Raw, and the two shape changes that bite.
      assert.match(properties.raw.description, /exactly as they came off the wire/);
      assert.match(properties.raw.description, /_elements/);
      assert.match(properties.raw.description, /must NOT be copied straight into an MPPS/);

      // The conformance gate, and that it judges the PEER.
      assert.match(properties.checkVr.description, /VR conformance violations/);
      assert.match(properties.checkVr.description, /audit of the PEER/);
      assert.match(properties.checkVr.description, /vrElementsExamined/);

      // Injection. This one sends something deliberately wrong, so the
      // description has to make that impossible to miss, has to say what it is
      // NOT for, and has to say it cannot write anything.
      const inject = properties.injectVerbatim;
      assert.ok(inject, `${name} does not expose the injection path`);
      assert.match(inject.description, /CONFORMANCE TEST INSTRUMENT/);
      assert.match(inject.description, /SEND SOMETHING WRONG ON PURPOSE/);
      assert.match(inject.description, /never the way to make a query work/);
      assert.match(inject.description, /changes nothing on the peer and writes no file/);
      assert.match(inject.description, /REFUSED if any injected value did not survive/);
      assert.match(inject.description, /"injected"/);

      // It is not offered where it would write. A "verbatim, unchecked" value
      // stamped into a C-FIND is a query; stamped into a file or a C-STORE it
      // is a corrupted record.
      assert.equal(properties.set, undefined, 'the find-side injection must not be named `set`');
    }

    for (const name of ['dcm_send', 'dcm_edit', 'dcm_anon']) {
      const properties = tools.find((t) => t.name === name).inputSchema.properties;
      assert.equal(
        properties.injectVerbatim, undefined,
        `${name} writes; unchecked verbatim values have no business there`
      );
    }
  });
});

test('a worklist query can report VR conformance about what the peer returned', async (t) => {
  const dir = tempDir('dcm-mcp-mpps-vr-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worklistFile = makeWorklist(dir);

  await withClient(async ({ call }) => {
    const started = await call('dcm_receiver_start', { ae: 'WORKLIST', worklist: worklistFile });
    assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
    const { serverId, port, host } = started.structuredContent;
    const peer = { host, port, calledAe: 'WORKLIST' };

    try {
      // A clean worklist audits clean, and says over how many elements — the
      // distinction between "no violations" and "nothing examined" is the
      // false pass the flag exists to stop.
      const audited = await call('dcm_worklist', { ...peer, scheduledDate: 'today', checkVr: true });
      assert.ok(!audited.isError, `a clean audit must not read as a failure: ${textOf(audited)}`);
      assert.deepEqual(audited.structuredContent.vrViolations, []);
      assert.ok(audited.structuredContent.vrElementsExamined > 0);
      assert.match(textOf(audited), /no violations over \d+ element/);

      // Raw carries the per-element sidecar, and the handoff still works
      // because the flat keys survive — but PatientName does not, and the note
      // has to say so before an assistant copies it into an MPPS call.
      const raw = await call('dcm_worklist', { ...peer, scheduledDate: 'today', raw: true });
      assert.ok(!raw.isError, textOf(raw));
      assert.equal(raw.structuredContent.raw, true);
      const match = raw.structuredContent.matches[0];
      assert.equal(match.StudyInstanceUID, STUDY_UID);
      assert.equal(match._elements['(0020,000D)'].vr, 'UI');
      assert.equal(match._elements['(0020,000D)'].value, STUDY_UID);
      assert.equal(typeof match.PatientName, 'object', 'a raw PN is not a string');
      assert.match(textOf(raw), /Do not\s+copy a raw PatientName/);

      // An injected value goes out as typed, and the answer says so in the
      // document itself rather than only on a stderr banner nothing here reads.
      const injected = await call('dcm_worklist', {
        ...peer, scheduledDate: 'today', injectVerbatim: { PatientSex: 'male' },
      });
      assert.deepEqual(
        injected.structuredContent.injected,
        [{ tag: '(0010,0040)', attribute: 'PatientSex', value: 'male' }]
      );
      assert.match(textOf(injected), /INJECTED, VERBATIM AND UNCHECKED/);
      assert.match(textOf(injected), /answering exactly what it was asked/);

      // A tag the encoder would silently drop is refused rather than injected.
      const dropped = await call('dcm_worklist', {
        ...peer, scheduledDate: 'today', injectVerbatim: { '(0009,0010)': 'PRIVATE' },
      });
      assert.equal(dropped.isError, true, 'a private tag must not be quietly lost');
    } finally {
      await call('dcm_server_stop', { serverId });
    }
  });
});
