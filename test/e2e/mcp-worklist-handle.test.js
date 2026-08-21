'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * End-to-end coverage for the three things that landed on the MCP layer after
 * Tier 2: the worklist row handle, the assertion parameters on the query tools,
 * and the receiver's fault-injection knobs.
 *
 * All of it is driven over the real stdio MCP server against a real `dcm scp`,
 * so nothing here is a claim about an argument vector — the handle really is
 * resolved in the server process and piped into a real N-CREATE, the injected
 * refusals really do come back over an association, and the expectation
 * verdicts really are decided by a peer.
 *
 * THE CLAIM THE HANDLE EXISTS FOR is the first test: a row goes from
 * dcm_worklist into dcm_mpps_perform carrying its sequence-valued attributes,
 * with the tool call naming no attribute at all. That is asserted mechanically
 * — the argument object is compared against a fixed set of keys — because "the
 * assistant did not have to retype anything" is only worth what a test says
 * about it, and a test that happened to pass a studyUid along would prove the
 * opposite of what it claims.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 *
 * WHAT IS SHARED, AND WHY. Two costs dominate this file and neither is the
 * assertions: spawning `node bin/dcm.js mcp` (~0.7s, plus ~0.4s for every
 * receiver child it spawns), and the flat ~1.0s every DIMSE association costs
 * regardless of payload — src/lib/dimse.js lingers before releasing, so a
 * C-ECHO on loopback and a four-instance C-STORE cost the same. So exactly one
 * MCP server, one fixture study, one worklist file and one default receiver are
 * built once in before() and torn down once in after(), and one row handle is
 * minted from that receiver for the tests whose subject is not the query.
 *
 * WHAT IS DELIBERATELY NOT SHARED is called out at each test that keeps its own
 * receiver. The rule is that a receiver whose behaviour is the thing under test
 * — armed with a fault, or stopped mid-test — cannot be the shared one, and a
 * test that reads a receiver's persisted output needs a persist directory no
 * other test writes into. The shared receiver runs with keepPerformed so that
 * one test completing a step cannot make the row disappear from another test's
 * query, which is the one way shared receiver state could leak here.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');
const { dicomDate } = require('../../src/commands/mcp/tools-dimse');

/** The UID tools/make-fixtures.js gives its first study, and its patient. */
const STUDY_UID = '1.2.826.0.1.3680043.10.1337.1';
const PATIENT_ID = 'SYNTH0001';

/**
 * The two sequence-valued attributes that make the handle worth having.
 *
 * Neither has a named parameter on dcm_mpps_perform, and both are destroyed by
 * the rendering `dcm find --mwl --json` applies — so an assistant reading a
 * worklist answer and retyping it cannot carry them by any route. They are the
 * measurable difference between the handle and the parameter table.
 */
const REFERENCED_STUDY = {
  ReferencedSOPClassUID: '1.2.840.10008.3.1.2.3.1',
  ReferencedSOPInstanceUID: '1.2.826.0.1.3680043.10.1337.999',
};
const PROTOCOL_CODE = {
  CodeValue: 'CHEST-CT',
  CodingSchemeDesignator: 'L',
  CodeMeaning: 'Chest CT with contrast',
};

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Generates one synthetic study of `instances` CT images, one series.
 *
 * @param {number} [instances]
 * @returns {{root: string, study: string, count: number}}
 */
function makeStudy(instances = 4) {
  const root = tempDir('dcm-mcp-handle-fx-');
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
 * Writes a worklist file holding one item that describes the fixture study,
 * including the two sequences.
 *
 * @param {string} dir
 * @param {object} [overrides]
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
        ReferencedStudySequence: [REFERENCED_STUDY],
        ScheduledProtocolCodeSequence: [PROTOCOL_CODE],
        ...overrides,
      },
    ], null, 2),
    'utf8'
  );
  return file;
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
 * Reads the one procedure step a `--persist` receiver wrote.
 *
 * `dcm scp --persist` keeps each step it was told about under <dir>/mpps, which
 * is the only account of an N-CREATE written by the side that RECEIVED it. That
 * is the difference between proving an attribute crossed the association and
 * believing the sender's summary of what it meant to send.
 *
 * The "exactly one" is load-bearing, which is why every persist directory in
 * this file belongs to exactly one test: a shared one would turn this into an
 * assertion about test order.
 *
 * @param {string} persist
 * @returns {object}
 */
function readPersistedStep(persist) {
  const dir = path.join(persist, 'mpps');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, `expected one persisted step, found ${files.length}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

// ---- The one MCP server, the one receiver, the one fixture ----------------

/**
 * Everything built once for the whole file.
 *
 *  - client / call: the single `dcm mcp` child and a shorthand for calling it.
 *  - fixture:       one 4-instance study; nothing here needs a second one.
 *  - worklist:      one worklist file, read-only to every test.
 *  - peer/started:  the default receiver, running for the whole file.
 *  - persist:       the default receiver's store. ONLY the first test writes
 *                   into it, which is what lets that test count what arrived.
 *  - scheduled:     the query that minted `handle`, kept whole so the first
 *                   test can assert on the answer rather than re-run it.
 *  - handle:        a row handle from that query, reused by the tests whose
 *                   subject is what a handle carries rather than how it is got.
 */
const shared = {};
let client;

/** Calls a tool on the shared server. */
function call(name, args) {
  return client.callTool({ name, arguments: args });
}

/**
 * Starts a receiver of its own and runs `fn` against it, stopping it afterwards.
 *
 * Used by the tests that cannot use the shared receiver: one armed with a fault,
 * one that has to be stopped while the test is still running, and the ones that
 * read a persist directory nobody else writes to.
 *
 * @param {object} args  dcm_receiver_start arguments.
 * @param {(peerAndServer: object) => Promise<void>} fn
 */
async function withReceiver(args, fn) {
  const started = await call('dcm_receiver_start', { ae: 'WORKLIST', ...args });
  assert.ok(!started.isError, `receiver failed to start: ${textOf(started)}`);
  const { serverId, port, host } = started.structuredContent;
  try {
    return await fn({
      started,
      serverId,
      peer: { host, port, calledAe: 'WORKLIST' },
    });
  } finally {
    await call('dcm_server_stop', { serverId });
  }
}

before(async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'] });
  client = new Client({ name: 'dcm-handle-test', version: '1.0.0' });
  await client.connect(transport);

  shared.fixture = makeStudy(4);
  shared.dir = tempDir('dcm-mcp-handle-');
  shared.persist = tempDir('dcm-mcp-handle-store-');
  shared.worklist = makeWorklist(shared.dir);

  // keepPerformed, because the receiver otherwise withholds a row once its step
  // has been performed — and the first test performs this row. That withholding
  // is real behaviour with its own coverage in test/e2e/mpps-scp.test.js; here
  // it would only be a way for one test to empty another test's worklist.
  shared.started = await call('dcm_receiver_start', {
    ae: 'WORKLIST',
    worklist: shared.worklist,
    persist: shared.persist,
    keepPerformed: true,
  });
  assert.ok(!shared.started.isError, `receiver failed to start: ${textOf(shared.started)}`);
  const { serverId, host, port } = shared.started.structuredContent;
  shared.serverId = serverId;
  shared.peer = { host, port, calledAe: 'WORKLIST' };

  shared.scheduled = await call('dcm_worklist', { ...shared.peer, scheduledDate: 'today' });
  assert.ok(!shared.scheduled.isError, `worklist query failed: ${textOf(shared.scheduled)}`);
  shared.handle = shared.scheduled.structuredContent.matches[0]._handle;
  assert.ok(shared.handle, 'the shared query must have minted a handle');
});

after(async () => {
  try {
    if (client) {
      if (shared.serverId) await call('dcm_server_stop', { serverId: shared.serverId });
      await client.close();
    }
  } finally {
    for (const d of [shared.fixture && shared.fixture.root, shared.dir, shared.persist]) {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

// ---- The handle, end to end ----------------------------------------------

test('a worklist row handle carries a whole row into a performed step, untyped', async () => {
  // The query this asserts on is the one before() ran, against this same
  // receiver: the row really came off an association, and it is the same row
  // the perform below is handed. Re-running it would buy nothing but a second
  // C-FIND.
  const { peer, persist, fixture, dir, worklist, scheduled, handle } = shared;

  // --- 1. The row comes back with a handle on it --------------------
  assert.equal(scheduled.structuredContent.count, 1);

  const row = scheduled.structuredContent.matches[0];
  assert.ok(handle, 'every worklist row must carry a handle');
  assert.match(handle, /^wlrow_[0-9a-f]{18}$/, 'the handle must be opaque');

  const block = scheduled.structuredContent.rowHandles;
  assert.deepEqual(block.handles, [handle], 'rowHandles.handles is index-aligned with matches');
  assert.deepEqual(block.acceptedBy.sort(), ['dcm_mpps_perform', 'dcm_mpps_start']);
  assert.equal(block.parameter, 'worklistRow');
  assert.match(block.lifetime, /never|only|disk/i);

  // The rendered row an assistant reads has LOST the sequences: this is
  // exactly the loss the handle exists to route around, so it is asserted
  // rather than assumed. Retyping from here cannot reproduce them.
  assert.equal(typeof row.ReferencedStudySequence, 'string');
  assert.match(textOf(scheduled), /worklistRow/);

  // --- 2. Perform it naming NO attribute ----------------------------
  // The argument object is the assertion: four connection keys, the
  // folder, and the handle. Nothing about the patient, the study, the
  // accession or the scheduled step appears anywhere in this call.
  const args = { folder: fixture.study, ...peer, worklistRow: handle };
  assert.deepEqual(
    Object.keys(args).sort(),
    ['calledAe', 'folder', 'host', 'port', 'worklistRow'],
    'the whole point is that no step attribute is restated here'
  );

  const performed = await call('dcm_mpps_perform', args);
  assert.ok(!performed.isError, `perform failed: ${textOf(performed)}`);

  const p = performed.structuredContent;
  assert.equal(p.performedProcedureStepStatus, 'COMPLETED');
  // Every one of these came out of the handle and out of nothing else.
  assert.equal(p.studyInstanceUid, STUDY_UID);
  assert.equal(p.found, fixture.count);
  assert.equal(p.acknowledged, fixture.count);
  assert.equal(p.notReferenced, 0);
  assert.ok(p.mppsSopInstanceUid);

  // --- 3. The sequences really travelled ----------------------------
  // Read out of the step the RECEIVER wrote, not out of the sender's own
  // account of what it sent: the claim is that these attributes crossed an
  // association, and only the far end can say so. This is the only test that
  // sends anything to the shared receiver, so its persist directory holds
  // exactly this step and exactly these images.
  const step = readPersistedStep(persist);
  const wire = JSON.stringify(step);
  assert.ok(
    wire.includes(REFERENCED_STUDY.ReferencedSOPInstanceUID),
    'ReferencedStudySequence has no named parameter and must have come from the handle'
  );
  assert.ok(
    wire.includes(PROTOCOL_CODE.CodeValue),
    'ScheduledProtocolCodeSequence has no named parameter and must have come from the handle'
  );
  // And the ordinary scalars arrived too, so this is a whole row rather
  // than two sequences and a gap.
  assert.ok(wire.includes(PATIENT_ID));
  assert.ok(wire.includes('ACC0000001'));
  assert.ok(wire.includes('SPS001'));

  // --- 4. Which row it was is on the record -------------------------
  const provenance = p.worklistRow;
  assert.equal(provenance.handle, handle);
  assert.equal(provenance.index, 1);
  assert.equal(provenance.of, 1);
  assert.equal(provenance.resolvedServerSide, true);
  assert.equal(provenance.writtenToDisk, false);
  assert.equal(provenance.queriedFrom.calledAe, 'WORKLIST');
  assert.match(textOf(performed), /Step attributes came from worklist row 1 of 1/);

  // The images really went.
  assert.equal(countDicomFiles(persist), fixture.count);

  // And nothing was written down: no file appeared beside the worklist.
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f !== path.basename(worklist)),
    [],
    'a handle must leave nothing on disk'
  );
});

test('the named parameters still work, and still win over the handle', async () => {
  // A dry run, because what is being asserted is the dataset rather than
  // anything a peer does with it — so this test needs no receiver at all, only
  // a handle to override.
  const preview = await call('dcm_mpps_start', {
    ...shared.peer,
    worklistRow: shared.handle,
    // The one the worklist got "wrong", corrected without abandoning the
    // rest of the row.
    stepId: 'CORRECTED-1',
    dryRun: true,
  });
  assert.ok(!preview.isError, textOf(preview));

  const document = JSON.stringify(preview.structuredContent);
  assert.ok(document.includes('CORRECTED-1'), 'the named parameter must override the row');
  assert.ok(document.includes(PATIENT_ID), 'the rest of the row must survive the override');
  assert.ok(
    document.includes(REFERENCED_STUDY.ReferencedSOPInstanceUID),
    'the sequences must survive the override too'
  );
  assert.ok(!document.includes('"SPS001"') || document.includes('CORRECTED-1'));
});

// ---- Refusals -------------------------------------------------------------

test('an unknown row handle is refused with the fix, and nothing is sent', async () => {
  const res = await call('dcm_mpps_perform', {
    folder: os.tmpdir(),
    host: '127.0.0.1',
    port: 1,
    calledAe: 'NOBODY',
    worklistRow: 'wlrow_000000000000000000',
  });

  assert.equal(res.isError, true);
  const text = textOf(res);
  assert.match(text, /not a row this server is holding/);
  // The fix has to be named, and the wrong fix has to be named as wrong.
  assert.match(text, /RE-RUN dcm_worklist/);
  assert.match(text, /Do not rebuild the row/);
  // Refused before anything was attempted: a dead peer would otherwise have
  // produced a connection failure in the text.
  assert.doesNotMatch(text, /ECONNREFUSED|N-CREATE|association/i);
});

test('a handle from a stopped query is still valid; a handle is not a session token', async () => {
  // The lifetime claim is "this server process", not "while the receiver is
  // running". A handle that quietly stopped working when the peer went away
  // would send an assistant looking for a fault in the wrong place.
  //
  // ISOLATED ON PURPOSE: the premise is a receiver that is gone by the time the
  // handle is used, so this cannot be the shared receiver and cannot be the
  // shared handle. It mints its own from its own peer and then kills it.
  let handle;
  await withReceiver({ worklist: shared.worklist }, async ({ peer }) => {
    const scheduled = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });
    assert.ok(!scheduled.isError, textOf(scheduled));
    handle = scheduled.structuredContent.matches[0]._handle;
  });

  // The receiver is stopped. The handle still resolves; the dry run needs no
  // peer, so this reaches the dataset and stops there.
  const preview = await call('dcm_mpps_start', {
    host: '127.0.0.1', port: 1, calledAe: 'NOBODY',
    worklistRow: handle,
    dryRun: true,
  });
  assert.ok(!preview.isError, textOf(preview));
  assert.ok(JSON.stringify(preview.structuredContent).includes(STUDY_UID));
});

test('a handle and a worklist file are refused together, and so is a row selector', async () => {
  const both = await call('dcm_mpps_start', {
    host: '127.0.0.1', port: 1, calledAe: 'NOBODY',
    worklistRow: 'wlrow_000000000000000000',
    fromWorklist: path.join(os.tmpdir(), 'nowhere.json'),
  });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /two different worklists/);

  const selector = await call('dcm_mpps_start', {
    host: '127.0.0.1', port: 1, calledAe: 'NOBODY',
    worklistRow: 'wlrow_000000000000000000',
    worklistFirst: true,
  });
  assert.equal(selector.isError, true);
  assert.match(textOf(selector), /already names one row/);
});

// ---- Advertisement --------------------------------------------------------

test('the handle is advertised on the tools that mint and take it', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  const worklist = byName.get('dcm_worklist');
  assert.match(worklist.description, /_handle/);
  assert.match(worklist.description, /never written to disk/i);
  assert.match(worklist.description, /worklistRow/);

  for (const name of ['dcm_mpps_perform', 'dcm_mpps_start']) {
    const tool = byName.get(name);
    const row = tool.inputSchema.properties.worklistRow;
    assert.ok(row, `${name} must accept worklistRow`);
    assert.match(row.description, /ReferencedStudySequence/);
    assert.match(row.description, /THIS SERVER PROCESS ONLY/);
    assert.match(row.description, /re-run dcm_worklist/i);
    // The named parameters must not have been removed: the handle is an
    // addition, and a step whose attributes never came from a worklist still
    // has to be expressible.
    for (const kept of ['studyUid', 'accessionNumber', 'modality', 'stepId']) {
      assert.ok(tool.inputSchema.properties[kept], `${name}.${kept} must still exist`);
    }
  }

  // The row selectors that landed on --from-worklist.
  for (const name of ['dcm_mpps_perform', 'dcm_mpps_start']) {
    const properties = byName.get(name).inputSchema.properties;
    assert.ok(properties.worklistIndex, `${name} should expose --index`);
    assert.ok(properties.worklistFirst, `${name} should expose --first`);
    assert.match(properties.worklistIndex.description, /after studyUid and accessionNumber/i);
  }
});

test('injectVerbatim reaches the N-CREATE verbs and no closing verb', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of ['dcm_mpps_start', 'dcm_mpps_perform']) {
    const inject = byName.get(name).inputSchema.properties.injectVerbatim;
    assert.ok(inject, `${name} must offer injectVerbatim`);
    // Unmistakable about what it is for. These are the sentences that decide
    // whether an assistant reaches for it to test a server or to get past a
    // refusal, which are opposite acts.
    assert.match(inject.description, /CONFORMANCE TEST INSTRUMENT, AND IT WRITES/);
    assert.match(inject.description, /SEND SOMETHING WRONG ON PURPOSE/);
    assert.match(inject.description, /NEVER THE WAY TO MAKE A REFUSED STEP GO THROUGH/);
    assert.match(inject.description, /CREATES A CLINICAL RECORD ON THE FAR END/);
    assert.match(inject.description, /Type 1 check is lifted for exactly the attributes named here/i);
  }

  // The closing verbs must not offer it: PerformedProcedureStepStatus lives
  // in the N-SET, and a parameter that could stamp COMPLETED there is a way
  // round the rule dcm_mpps_perform is built on.
  for (const name of ['dcm_mpps_update', 'dcm_mpps_complete', 'dcm_mpps_discontinue']) {
    assert.equal(
      byName.get(name).inputSchema.properties.injectVerbatim,
      undefined,
      `${name} must not offer a way to stamp a terminal status`
    );
  }
});

test('injectVerbatim stamps the N-CREATE, lifts Type 1 by name, and refuses a lost value', async (t) => {
  // ISOLATED ON PURPOSE: this reads the step the receiver wrote, and
  // readPersistedStep's "exactly one" only means anything if nothing else can
  // write into the directory. So it gets its own receiver and its own store.
  // The ROW it uses is the shared one — the subject here is injectVerbatim, and
  // a second C-FIND would only be a second way to fill the same attributes.
  const persist = tempDir('dcm-mcp-inject-store-');
  t.after(() => fs.rmSync(persist, { recursive: true, force: true }));

  await withReceiver({ worklist: shared.worklist, persist }, async ({ peer }) => {
    // A lowercase Code String goes out AS TYPED, over a real association, and
    // the answer says so — this is the coercion question, and the only way to
    // ask it is to send the wrong thing on purpose.
    const opened = await call('dcm_mpps_start', {
      ...peer,
      worklistRow: shared.handle,
      injectVerbatim: { PatientSex: 'male' },
    });
    assert.ok(!opened.isError, textOf(opened));
    assert.deepEqual(
      opened.structuredContent.injected,
      [{ tag: '(0010,0040)', attribute: 'PatientSex', value: 'male' }]
    );

    const step = readPersistedStep(persist);
    assert.ok(
      JSON.stringify(step).includes('"male"'),
      'the receiver must have been given the value exactly as typed'
    );

    // The Type 1 check is lifted for the attribute NAMED and for no other:
    // an empty Modality really goes out, which is the one question about an
    // SCP that cannot be asked any other way.
    const empty = await call('dcm_mpps_start', {
      ...peer,
      stepId: 'S-EMPTY',
      studyUid: STUDY_UID,
      injectVerbatim: { Modality: '' },
      dryRun: true,
    });
    assert.ok(!empty.isError, `an injected empty Type 1 must not be refused: ${textOf(empty)}`);

    // ...while an attribute nobody named is still checked, so the accidental
    // empty Type 1 stays impossible.
    const missing = await call('dcm_mpps_start', {
      ...peer,
      studyUid: STUDY_UID,
      injectVerbatim: { PatientSex: 'male' },
      dryRun: true,
    });
    assert.equal(missing.isError, true, 'an unnamed Type 1 must still be checked');
    assert.match(textOf(missing), /Type 1/);

    // And a value the dataset writer would silently shorten is refused rather
    // than sent as a legal one — otherwise a test written to prove the server
    // rejects an over-long AE Title would pass without ever having asked.
    const shortened = await call('dcm_mpps_start', {
      ...peer,
      worklistRow: shared.handle,
      injectVerbatim: { PerformedStationAETitle: 'AE-TITLE-FAR-TOO-LONG-FOR-DICOM' },
    });
    assert.equal(shortened.isError, true, 'a value that would not survive the encoder must be refused');
  });
});

// ---- The assertion parameters --------------------------------------------

test('expectEmpty is a real assertion: it fails on a match and on a refusal alike', async () => {
  const { peer } = shared;

  // One row is scheduled, so "expect none" must fail — even though the
  // query itself completed perfectly.
  const wrong = await call('dcm_worklist', { ...peer, scheduledDate: 'today', expectEmpty: true });
  assert.equal(wrong.isError, true, 'a failed expectation must surface as an error');
  assert.equal(wrong.structuredContent.expectation.evaluated, true);
  assert.equal(wrong.structuredContent.expectation.held, false);
  assert.equal(wrong.structuredContent.expectation.actual, 1);
  assert.match(textOf(wrong), /EXPECTATION FAILED/);

  // And the same query with the right assertion passes.
  const right = await call('dcm_worklist', { ...peer, scheduledDate: 'today', expectNonempty: true });
  assert.ok(!right.isError, textOf(right));
  assert.equal(right.structuredContent.expectation.held, true);
  assert.match(textOf(right), /Expectation held/);

  const counted = await call('dcm_worklist', { ...peer, scheduledDate: 'today', expectCount: 1 });
  assert.ok(!counted.isError, textOf(counted));
  assert.equal(counted.structuredContent.expectation.expected, 1);

  // THE CASE THE FLAG EXISTS FOR. A receiver answering every C-FIND 0x0122
  // returns no rows, exactly like an empty schedule — and an assistant
  // reading `count: 0` would report the worklist as correctly empty. The
  // expectation must NOT be satisfied by a query that never got an answer.
  //
  // ISOLATED ON PURPOSE: findStatus is armed at start, so it cannot be the
  // shared receiver. Both refusal cases below are asked of ONE such receiver —
  // it refuses every C-FIND identically and keeps no state between them, so a
  // second one would only buy a second child process.
  await withReceiver({ worklist: shared.worklist, findStatus: '0x0122' }, async ({ peer: refusing }) => {
    const refused = await call('dcm_worklist', { ...refusing, scheduledDate: 'today', expectEmpty: true });
    assert.equal(refused.isError, true, 'a refused query must never satisfy expectEmpty');

    // The document has to survive a failed run, because the fields that tell
    // a refusal apart from an empty schedule live in it and nowhere else.
    const p = refused.structuredContent;
    assert.ok(p, 'the envelope must survive a query that did not complete');
    assert.equal(p.outcome, 'rejected');
    assert.equal(p.count, null, 'nothing was counted, which is not the same as zero');
    assert.equal(p.expectation.evaluated, false);
    assert.equal(p.expectation.held, false);
    assert.equal(p.detail.status.code, '0x0122');

    const text = textOf(refused);
    assert.match(text, /EXPECTATION NOT TESTED/);
    assert.match(text, /NOTHING WAS COUNTED/);
    assert.doesNotMatch(text, /Expectation held/);

    // And the same failure WITHOUT an expectation still must not read as an
    // empty worklist: the leniency is for an empty answer, not for a query
    // that never got one.
    const bare = await call('dcm_worklist', { ...refusing, scheduledDate: 'today' });
    assert.equal(bare.isError, true);
    assert.equal(bare.structuredContent.outcome, 'rejected');
    assert.doesNotMatch(textOf(bare), /legitimate answer/);
  });
});

test('the assertion parameters are on the query tools and nowhere else', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of ['dcm_query', 'dcm_worklist']) {
    const properties = byName.get(name).inputSchema.properties;
    for (const flag of ['expectCount', 'expectEmpty', 'expectNonempty']) {
      assert.ok(properties[flag], `${name} is missing ${flag}`);
    }
    assert.match(properties.expectEmpty.description, /never reached the peer/i);
  }

  // A local-file tool has no association to fail, so the same parameters
  // there would be ceremony rather than a guard.
  for (const name of ['dcm_inventory', 'dcm_tags']) {
    const properties = byName.get(name).inputSchema.properties;
    assert.equal(properties.expectEmpty, undefined, `${name} should not pretend to guard a peer`);
  }
});

// ---- Fault injection ------------------------------------------------------

test('the fault-injection flags reach the receiver and are declared in the answer', async () => {
  // ISOLATED ON PURPOSE, both halves. The armed one obviously cannot be shared;
  // the second is the "off by default" claim, and reusing the shared receiver
  // for it would be asserting a default about a receiver this file starts with
  // options set.
  await withReceiver(
    { worklist: shared.worklist, refuseNSet: '0x0106', refuseNSetScope: 'interim', rejectAfter: 3, keepPerformed: true },
    async ({ started }) => {
      const armed = started.structuredContent.faultInjection;
      assert.equal(armed.refuseNSet, '0x0106');
      assert.equal(armed.refuseNSetScope, 'interim');
      assert.equal(armed.rejectAfter, 3);
      assert.equal(started.structuredContent.keepPerformed, true);

      // The arming has to be visible in the prose too: an injected refusal
      // must never be read as a finding, and the receiver's own banner never
      // reaches this side.
      assert.match(textOf(started), /FAULT INJECTION IS ON/);
      assert.match(textOf(started), /--refuse-nset 0x0106 --refuse-nset-scope interim/);
      assert.match(textOf(started), /INJECTED, not a finding/);
    }
  );

  // Off by default, and said so by its absence rather than by a false null.
  await withReceiver({ worklist: shared.worklist }, async ({ started }) => {
    assert.equal(started.structuredContent.faultInjection, null);
    assert.doesNotMatch(textOf(started), /FAULT INJECTION IS ON/);
  });
});

test('a refused interim N-SET is injected for real, and does not stop the transfer', async (t) => {
  // ISOLATED ON PURPOSE: armed with refuseNSet, and it counts what landed in
  // its own store. The row is the shared one; what is under test is the
  // receiver's refusal, not how the attributes were obtained.
  const persist = tempDir('dcm-mcp-faults-store-');
  t.after(() => fs.rmSync(persist, { recursive: true, force: true }));

  await withReceiver({ worklist: shared.worklist, persist, refuseNSet: '0x0106' }, async ({ peer }) => {
    // chunk 2 over 4 instances is three associations and one interim update
    // at the boundary, which the receiver is armed to refuse.
    const performed = await call('dcm_mpps_perform', {
      folder: shared.fixture.study,
      ...peer,
      worklistRow: shared.handle,
      chunk: 2,
      updateEachChunk: true,
    });

    const p = performed.structuredContent;
    assert.ok(p.interimUpdates, 'an interim update should have been attempted');
    assert.ok(p.interimUpdates.attempted >= 1);
    assert.equal(p.interimUpdates.accepted, 0, 'the receiver was armed to refuse every interim');

    // The claim the scope default exists for: the interim was refused and
    // the step still closed COMPLETED, because the images are the work and
    // an update is a report about it.
    assert.equal(p.performedProcedureStepStatus, 'COMPLETED');
    assert.equal(p.acknowledged, shared.fixture.count);
    assert.equal(countDicomFiles(persist), shared.fixture.count);
    assert.match(textOf(performed), /does NOT stop the transfer/i);
  });
});

test('refuseNCreate stops a step being opened at all, and says which stage failed', async () => {
  // ISOLATED ON PURPOSE: armed with refuseNCreate.
  await withReceiver({ worklist: shared.worklist, refuseNCreate: '0x0110' }, async ({ peer }) => {
    const performed = await call('dcm_mpps_perform', {
      folder: shared.fixture.study, ...peer, worklistRow: shared.handle,
    });
    assert.equal(performed.isError, true);
    assert.equal(performed.structuredContent.stage, 'n-create');
    assert.match(textOf(performed), /no step was opened and nothing was sent/);
    // The refusal carries the receiver's own explanation of why, which names
    // the flag, so this cannot be mistaken for a finding about the client.
    assert.match(textOf(performed), /--refuse-ncreate/);
  });
});

test('abortFindAfter aborts a real C-FIND, and the client does not call it an answer', async () => {
  // ISOLATED ON PURPOSE: armed with abortFindAfter, which would abort every
  // other test's query too.
  await withReceiver({ worklist: shared.worklist, abortFindAfter: 0 }, async ({ peer }) => {
    const res = await call('dcm_worklist', { ...peer, scheduledDate: 'today' });

    // The invariant rather than the outcome name: an A-ABORT mid-C-FIND is
    // currently mis-reported by src/lib/dimse.js (the client never sees the
    // abort event), so this asserts what must be true either way — the run
    // failed and produced no matches. It keeps passing once that is fixed.
    assert.equal(res.isError, true, 'an aborted query is not an empty worklist');
    const count = res.structuredContent && res.structuredContent.count;
    assert.ok(count === 0 || count === null || count === undefined);
    assert.doesNotMatch(textOf(res), /"outcome": "(matched|empty)"/);
  });
});

test('a fault-injection status the engine will not accept is refused loudly', async () => {
  // Bare digits are ambiguous in the worst way — 110 decimal is 0x006E — and
  // the engine refuses rather than guessing. The MCP layer must pass that
  // refusal through instead of normalising it into something quieter.
  const res = await call('dcm_receiver_start', { refuseNSet: '110' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Bare digits are refused/);

  const success = await call('dcm_receiver_start', { refuseNSet: '0x0000' });
  assert.equal(success.isError, true, 'a success status refuses nothing and must not arm');
});

test('the receiver tool describes the fault knobs and the capture-and-replay worklist', async () => {
  const { tools } = await client.listTools();
  const receiver = tools.find((t) => t.name === 'dcm_receiver_start');
  const properties = receiver.inputSchema.properties;

  for (const flag of [
    'rejectAfter', 'refuseNCreate', 'refuseNSet', 'refuseNSetScope',
    'findStatus', 'abortFindAfter', 'keepPerformed',
  ]) {
    assert.ok(properties[flag], `dcm_receiver_start is missing ${flag}`);
  }

  assert.match(receiver.description, /FAULT INJECTION/);
  assert.match(receiver.description, /never be read as a finding/i);

  // The scope default is the point of the flag, so it has to be explained
  // where it is read rather than only in the CLI help.
  assert.match(properties.refuseNSetScope.description, /interim.*default/is);
  assert.match(properties.refuseNSetScope.description, /lets the closing COMPLETED or DISCONTINUED through/);

  // Capture and replay: the shape dcm_worklist's own query writes.
  assert.match(properties.worklist.description, /json-raw/);
  assert.match(properties.worklist.description, /matches/);
  assert.match(properties.findStatus.description, /0x0122/);
  assert.match(properties.abortFindAfter.description, /never sending the final Success/i);
});
