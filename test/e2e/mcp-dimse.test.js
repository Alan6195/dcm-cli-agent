'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * End-to-end coverage for the DIMSE and local-file MCP tools.
 *
 * Drives the real `dcm mcp` server over stdio with the official MCP client, the
 * same path Claude Code and Claude Desktop take. Two things are being proved:
 *
 * 1. Every option a tool advertises is a real flag on the underlying command.
 *    `args.rejectUnknown` throws "Unknown option: --x" for anything invented,
 *    so a tool that passes a flag the engine does not have fails loudly here.
 *    That is the guard against the MCP layer drifting away from the engine.
 *
 * 2. The argument vector each tool builds is the one a person would type. The
 *    local-file tools prove it by their effect on real generated fixtures; the
 *    networked ones prove it without a peer, because the engine logs the query
 *    it is about to make before it opens the association, and a dry run reports
 *    the plan without connecting at all.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');
const FIXTURE_SCRIPT = path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js');

/** A port nothing listens on, so a connection attempt fails immediately. */
const DEAD_PEER = { host: '127.0.0.1', port: 1, calledAe: 'NOPE' };

/** Roots created during the run, removed in the after hook. */
const tempRoots = [];

/**
 * Generates a synthetic study tree and returns its folder.
 *
 * @param {{studies?: number, series?: number, instances?: number}} [shape]
 * @returns {{root: string, dir: string, out: string, instances: number}}
 */
function makeFixture(shape = {}) {
  const { studies = 1, series = 2, instances = 3 } = shape;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mcp-dimse-'));
  tempRoots.push(root);

  // The source and any destination are siblings: `edit --out` and `anon --out`
  // both refuse a destination inside the source, because the scan would
  // otherwise pick up its own output.
  const dir = path.join(root, 'src');
  const res = spawnSync(
    process.execPath,
    [FIXTURE_SCRIPT, dir, '--studies', String(studies), '--series', String(series), '--instances', String(instances)],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `fixture generation failed: ${res.stderr}`);

  return { root, dir, out: path.join(root, 'out'), instances: studies * series * instances };
}

/** Local YYYYMMDD, the same way a scanner's clock would read it. */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** The text a tool result carries, whatever its shape. */
function textOf(result) {
  return (result.content || []).map((c) => c.text || '').join('\n');
}

/** No tool may pass a flag the engine does not have. */
function assertNoUnknownOption(result) {
  assert.doesNotMatch(
    textOf(result),
    /Unknown option/,
    'a tool passed a flag the command does not accept'
  );
}

let client;
let fixture;

before(async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'] });
  client = new Client({ name: 'dcm-dimse-test', version: '1.0.0' });
  await client.connect(transport);

  fixture = makeFixture();
});

after(async () => {
  if (client) await client.close();
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

const call = (name, args) => client.callTool({ name, arguments: args });

// ---- Advertisement --------------------------------------------------------

test('dcm_worklist is advertised with worklist-specific parameters', async () => {
  const { tools } = await client.listTools();
  const worklist = tools.find((t) => t.name === 'dcm_worklist');
  assert.ok(worklist, `dcm_worklist not advertised; got ${tools.map((t) => t.name).join(', ')}`);

  const properties = worklist.inputSchema.properties;
  for (const expected of [
    'host', 'port', 'calledAe', 'callingAe',
    'modality', 'scheduledDate', 'scheduledStationAe',
    'patientId', 'patientName', 'accessionNumber', 'keys', 'limit',
  ]) {
    assert.ok(properties[expected], `dcm_worklist is missing the ${expected} parameter`);
  }
  assert.deepEqual(
    ['host', 'port', 'calledAe'].filter((k) => (worklist.inputSchema.required || []).includes(k)),
    ['host', 'port', 'calledAe'],
    'the peer connection must be required'
  );

  // The honesty the repo trades on: an empty worklist is an answer, and the
  // scheduling keys are their own vocabulary. Both belong in the description
  // because that is the only place an assistant reads them.
  assert.match(worklist.description, /schedul/i);
  assert.match(worklist.description, /empty worklist is a legitimate answer/i);
  assert.match(worklist.description, /ScheduledProcedureStepStartDate/);
  assert.match(worklist.description, /ScheduledStationAETitle/);

  // The date parameter has to say what it accepts, or "today" is unguessable.
  assert.match(properties.scheduledDate.description, /today/);
  assert.match(properties.scheduledDate.description, /YYYYMMDD/);
});

test('dcm_query points at dcm_worklist rather than hiding MWL as a level', async () => {
  const { tools } = await client.listTools();
  const query = tools.find((t) => t.name === 'dcm_query');
  assert.ok(query);
  assert.match(query.description, /dcm_worklist/);
  // Compatibility: the level itself must still be offered.
  assert.ok(query.inputSchema.properties.level.enum.includes('mwl'));
  assert.ok(query.inputSchema.properties.timeout, 'dcm_query should expose timeout');
});

test('dcm_send advertises the transfer syntax, parallel and label options', async () => {
  const { tools } = await client.listTools();
  const send = tools.find((t) => t.name === 'dcm_send');
  const properties = send.inputSchema.properties;
  for (const expected of ['transferSyntax', 'parallel', 'label', 'recurse']) {
    assert.ok(properties[expected], `dcm_send is missing the ${expected} parameter`);
  }
  // The v0.5 headline: it converts, it does not merely propose.
  assert.match(properties.transferSyntax.description, /BEFORE sending/i);
  assert.match(properties.transferSyntax.description, /jpeg2000/);
});

test('the tools that write data say so in their description', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  assert.match(byName.get('dcm_anon').description, /WRITES FILES/);
  assert.match(byName.get('dcm_anon').description, /source folder is never modified/i);

  const edit = byName.get('dcm_edit');
  assert.match(edit.description, /WRITES FILES/);
  assert.match(edit.description, /OVERWRITTEN/);
  assert.ok(edit.inputSchema.properties.inPlace, 'dcm_edit is missing inPlace');
  assert.match(edit.inputSchema.properties.inPlace.description, /irreversible/i);
});

// ---- Worklist -------------------------------------------------------------

test('dcm_worklist builds a real MWL query with the scheduling keys', async () => {
  const res = await call('dcm_worklist', {
    ...DEAD_PEER,
    modality: 'CT',
    scheduledDate: 'today',
    scheduledStationAe: 'CT01',
    patientId: 'SYNTH0001',
    limit: 5,
  });

  // No peer, so the query cannot complete — but the engine logs the query it is
  // about to make before it opens the association, which is what proves the
  // argument vector.
  const text = textOf(res);
  assertNoUnknownOption(res);
  assert.match(text, /C-FIND \(mwl\)/, 'the worklist level was not selected');
  assert.match(text, /Modality=CT/);
  assert.match(text, /ScheduledStationAETitle=CT01/);
  assert.match(text, /PatientID=SYNTH0001/);
  assert.ok(
    text.includes(`ScheduledProcedureStepStartDate=${today()}`),
    `"today" should resolve to the local date ${today()}; got: ${text}`
  );
});

test('dcm_worklist passes free-form keys through and lets named parameters win', async () => {
  const res = await call('dcm_worklist', {
    ...DEAD_PEER,
    modality: 'MR',
    keys: { Modality: 'CT', ScheduledPerformingPhysicianName: 'DOE^JANE' },
  });
  const text = textOf(res);
  assertNoUnknownOption(res);
  assert.match(text, /ScheduledPerformingPhysicianName=DOE\^JANE/);
  assert.match(text, /Modality=MR/, 'the named parameter should win over keys');
  assert.doesNotMatch(text, /Modality=CT/);
});

test('dcm_worklist accepts a date range and "any" for no date matching', async () => {
  const ranged = await call('dcm_worklist', {
    ...DEAD_PEER,
    scheduledDate: '20260101-20260131',
  });
  assert.match(textOf(ranged), /ScheduledProcedureStepStartDate=20260101-20260131/);

  const any = await call('dcm_worklist', { ...DEAD_PEER, scheduledDate: 'any' });
  assert.doesNotMatch(textOf(any), /ScheduledProcedureStepStartDate=/);
});

test('dcm_worklist refuses a scheduledDate it cannot interpret, without connecting', async () => {
  const res = await call('dcm_worklist', { ...DEAD_PEER, scheduledDate: 'next tuesday' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /neither a DICOM date nor a word I know/);
  assert.doesNotMatch(textOf(res), /C-FIND/, 'a bad date must be caught before any connection');
});

test('dcm_query still accepts level mwl for compatibility', async () => {
  const res = await call('dcm_query', {
    ...DEAD_PEER,
    level: 'mwl',
    keys: { Modality: 'CR' },
    timeout: 2000,
  });
  assertNoUnknownOption(res);
  assert.match(textOf(res), /C-FIND \(mwl\)/);
  assert.match(textOf(res), /Modality=CR/);
});

// ---- Connectivity ---------------------------------------------------------

test('dcm_echo accepts the connect and association timeouts', async () => {
  const res = await call('dcm_echo', {
    ...DEAD_PEER,
    callingAe: 'DCM-TEST',
    timeout: 3000,
    connectTimeout: 1500,
    associationTimeout: 1500,
  });
  assertNoUnknownOption(res);
  assert.equal(res.isError, true, 'there is no peer, so this must report a failure');
  assert.match(textOf(res), /DCM-TEST -> NOPE/);
});

// ---- Local files ----------------------------------------------------------

test('dcm_inventory passes series, chunk and recurse to the engine', async () => {
  const res = await call('dcm_inventory', {
    path: fixture.dir,
    series: true,
    chunk: 2,
    recurse: true,
  });
  assert.ok(!res.isError, textOf(res));
  assert.equal(res.structuredContent.dicomInstances, fixture.instances);
  assert.equal(res.structuredContent.studies[0].series.length, 2, '--series should break it down');
  // ceil(6 / 2) — the only observable proof that --chunk arrived.
  assert.equal(res.structuredContent.studies[0].associationsAtChunkSize, 3);
});

test('dcm_tags passes filter, value, depth, limit, all and recurse', async () => {
  const res = await call('dcm_tags', {
    path: fixture.dir,
    filter: 'Patient',
    value: 'SYNTHETIC',
    all: true,
    depth: 1,
    limit: 2,
    recurse: true,
  });
  assertNoUnknownOption(res);
  assert.ok(!res.isError, textOf(res));
  assert.equal(res.structuredContent.files, 2, '--limit 2 with --all should dump two files');
  for (const file of res.structuredContent.results) {
    for (const tag of file.tags) {
      assert.match(tag.keyword, /Patient/, '--filter should have narrowed the keywords');
      assert.match(tag.value, /SYNTHETIC/, '--value should have narrowed the values');
    }
  }
});

test('dcm_tags privateOnly is a real flag', async () => {
  const res = await call('dcm_tags', { path: fixture.dir, privateOnly: true });
  // The fixtures carry no private tags, so nothing matching is the right
  // answer. What is being checked is that --private reached the command.
  assertNoUnknownOption(res);
  assert.match(textOf(res), /"files": 0|"tags": 0/);
});

// ---- Mutation -------------------------------------------------------------

test('dcm_edit writes copies to out and leaves the source alone', async () => {
  const f = makeFixture({ studies: 1, series: 1, instances: 2 });
  const res = await call('dcm_edit', {
    path: f.dir,
    out: f.out,
    set: { PatientID: 'EDIT001' },
    remove: ['StudyDescription'],
    recurse: true,
  });
  assertNoUnknownOption(res);
  assert.ok(!res.isError, textOf(res));
  assert.match(textOf(res), /written\s+2/);

  const edited = await call('dcm_tags', { path: f.out, filter: 'PatientID', all: true });
  assert.ok(!edited.isError, textOf(edited));
  assert.equal(edited.structuredContent.results[0].tags[0].value, 'EDIT001');

  const source = await call('dcm_tags', { path: f.dir, filter: 'PatientID', all: true });
  assert.equal(
    source.structuredContent.results[0].tags[0].value,
    'SYNTH0001',
    'the source must not have been touched'
  );
});

test('dcm_edit dryRun writes nothing at all', async () => {
  const f = makeFixture({ studies: 1, series: 1, instances: 1 });
  const res = await call('dcm_edit', {
    path: f.dir,
    out: f.out,
    set: { PatientID: 'NEVER' },
    dryRun: true,
  });
  assert.ok(!res.isError, textOf(res));
  assert.match(textOf(res), /DRY RUN/);
  assert.equal(fs.existsSync(f.out), false, 'a dry run must not create the destination');
});

test('dcm_edit refuses structural UIDs unless force is passed', async () => {
  const f = makeFixture({ studies: 1, series: 1, instances: 1 });

  const refused = await call('dcm_edit', {
    path: f.dir,
    out: f.out,
    set: { StudyInstanceUID: '1.2.3.4' },
    dryRun: true,
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /--force/);

  const forced = await call('dcm_edit', {
    path: f.dir,
    out: f.out,
    set: { StudyInstanceUID: '1.2.3.4' },
    dryRun: true,
    force: true,
  });
  assertNoUnknownOption(forced);
  assert.ok(!forced.isError, textOf(forced));
  assert.match(textOf(forced), /would change\s+1/);
});

test('dcm_edit inPlace overwrites the source, and is exclusive with out', async () => {
  const f = makeFixture({ studies: 1, series: 1, instances: 1 });

  const conflict = await call('dcm_edit', {
    path: f.dir,
    out: f.out,
    inPlace: true,
    set: { PatientID: 'NOPE' },
  });
  assert.equal(conflict.isError, true);
  assert.match(textOf(conflict), /mutually exclusive/);

  const res = await call('dcm_edit', {
    path: f.dir,
    inPlace: true,
    set: { PatientID: 'INPLACE1' },
  });
  assertNoUnknownOption(res);
  assert.ok(!res.isError, textOf(res));
  assert.match(textOf(res), /IN PLACE/);

  const after_ = await call('dcm_tags', { path: f.dir, filter: 'PatientID', all: true });
  assert.equal(after_.structuredContent.results[0].tags[0].value, 'INPLACE1');
});

test('dcm_anon passes prefix, keepDescriptions, keepPrivate and recurse', async () => {
  const f = makeFixture({ studies: 1, series: 1, instances: 2 });
  const res = await call('dcm_anon', {
    path: f.dir,
    out: f.out,
    prefix: 'ZZTEST',
    keepDescriptions: true,
    keepPrivate: true,
    recurse: true,
  });
  assertNoUnknownOption(res);
  assert.ok(!res.isError, textOf(res));

  const ids = await call('dcm_tags', { path: f.out, filter: 'PatientID', all: true });
  assert.ok(!ids.isError, textOf(ids));
  const value = ids.structuredContent.results[0].tags[0].value;
  assert.ok(value.startsWith('ZZTEST'), `--prefix should have shaped the pseudonym; got ${value}`);

  // The original identifier must not survive anywhere in the copy.
  const original = await call('dcm_tags', { path: f.out, value: 'SYNTH0001', all: true });
  assert.match(textOf(original), /"files": 0|Nothing matched/);
});

// ---- Transfer -------------------------------------------------------------

test('dcm_send dryRun reports the found counts without connecting', async () => {
  const res = await call('dcm_send', {
    path: fixture.dir,
    host: 'nonexistent.invalid',
    port: 104,
    calledAe: 'ARCHIVE',
    dryRun: true,
  });
  assert.ok(!res.isError, textOf(res));
  const text = textOf(res);
  assert.match(text, /DRY RUN — nothing was sent and no connection was opened/);
  assert.match(text, new RegExp(`send ${fixture.instances} instance\\(s\\)`));
  assert.match(text, /chunk size 200/);
});

test('dcm_send transferSyntax reaches the command', async () => {
  // A recognised syntax shrinks the default chunk, because converting means
  // holding parsed datasets in memory. That change in the dry-run plan is the
  // proof the value arrived — no peer required.
  const converted = await call('dcm_send', {
    path: fixture.dir,
    host: 'nonexistent.invalid',
    port: 104,
    calledAe: 'ARCHIVE',
    transferSyntax: 'jpeg2000',
    dryRun: true,
  });
  assertNoUnknownOption(converted);
  assert.ok(!converted.isError, textOf(converted));
  assert.match(textOf(converted), /chunk size 50/);

  // And an unrecognised one is rejected by the command, naming what it accepts.
  const rejected = await call('dcm_send', {
    path: fixture.dir,
    host: 'nonexistent.invalid',
    port: 104,
    calledAe: 'ARCHIVE',
    transferSyntax: 'not-a-syntax',
    dryRun: true,
  });
  assert.equal(rejected.isError, true);
  assert.match(textOf(rejected), /--transfer-syntax "not-a-syntax" is not a name I know/);
  assert.match(textOf(rejected), /jpeg2000-lossy/);
});

test('dcm_send accepts parallel, label, retry, chunk and recurse', async () => {
  const res = await call('dcm_send', {
    path: fixture.dir,
    host: 'nonexistent.invalid',
    port: 104,
    calledAe: 'ARCHIVE',
    chunk: 4,
    retry: 2,
    parallel: 4,
    label: 'run=2',
    recurse: true,
    rewriteSeriesUid: true,
    dryRun: true,
  });
  assertNoUnknownOption(res);
  assert.ok(!res.isError, textOf(res));
  // An explicit --chunk survives even when rewriting would otherwise shrink it.
  assert.match(textOf(res), /chunk size 4/);
  assert.match(textOf(res), /series UIDs would be rewritten/);
});

test('dcm_send rejects a parallelism the engine will not allow', async () => {
  const res = await call('dcm_send', {
    path: fixture.dir,
    host: 'nonexistent.invalid',
    port: 104,
    calledAe: 'ARCHIVE',
    parallel: 99,
    dryRun: true,
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /--parallel must be between 1 and 16/);
});
