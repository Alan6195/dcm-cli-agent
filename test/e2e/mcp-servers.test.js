'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/**
 * End-to-end coverage for the server-lifecycle MCP tools.
 *
 * The point of these tools is that an assistant can verify a transfer end to
 * end without a PACS: start a receiver or hub, send to it, confirm from its own
 * log what arrived, stop it. So the tests do exactly that, over the real stdio
 * MCP server driven by the official client — the same path Claude Code uses.
 *
 * The other half of the contract is that nothing leaks. Each round trip asserts
 * the child reports exited and its port is bindable again, because a receiver
 * that survives the session holds a port until the machine is rebooted.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');
const { resolveCliCommand, MAX_SERVERS } = require('../../src/commands/mcp/tools-servers');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mcp-srv-'));
  const script = path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js');
  const res = spawnSync(
    process.execPath,
    [script, dir, '--studies', '1', '--series', '1', '--instances', '2'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `fixture generation failed: ${res.stderr}`);
  return dir;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withClient(fn) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'] });
  const client = new Client({ name: 'dcm-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Counts the .dcm files written under a persist folder. */
function countDicomFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.dcm')) n += 1;
  }
  return n;
}

/**
 * Resolves once nothing is listening on the port.
 *
 * Retries because process teardown and socket teardown are not instantaneous:
 * the child's exit is observed before the OS has necessarily released every
 * socket bound to that port.
 */
async function portIsFree(port, attempts = 25) {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('resolveCliCommand passes the script through under node and not under the packaged binary', () => {
  // Running as `node bin/dcm.js`: argv[1] is the script and the child needs it.
  assert.deepEqual(
    resolveCliCommand(['scp', '--port', '104'], path.join('C:', 'app', 'bin', 'dcm.js')),
    [process.execPath, path.join('C:', 'app', 'bin', 'dcm.js'), 'scp', '--port', '104']
  );
  assert.deepEqual(
    resolveCliCommand(['web', 'serve'], '/usr/lib/dcm/bin/dcm.js'),
    [process.execPath, '/usr/lib/dcm/bin/dcm.js', 'web', 'serve']
  );

  // Running as the single-file executable: execPath IS the CLI, so argv[1]
  // must not be passed on — it would become a bogus first argument.
  assert.deepEqual(resolveCliCommand(['scp'], path.join('C:', 'tools', 'dcm.exe')), [process.execPath, 'scp']);
  assert.deepEqual(resolveCliCommand(['scp'], '/usr/local/bin/dcm'), [process.execPath, 'scp']);
  // No entry at all (embedded/eval hosts leave argv[1] empty) takes the same branch.
  assert.deepEqual(resolveCliCommand(['scp'], ''), [process.execPath, 'scp']);
});

test('mcp server advertises the server-lifecycle tools', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'dcm_receiver_start',
      'dcm_web_hub_start',
      'dcm_servers_list',
      'dcm_server_status',
      'dcm_server_stop',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}; got ${names.join(', ')}`);
    }
  });
});

test('DICOMweb hub round trip: start, STOW to it, see it in the log, stop it', async (t) => {
  const fixture = makeFixture();
  const persist = tempDir('dcm-hub-persist-');
  t.after(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(persist, { recursive: true, force: true });
  });

  await withClient(async (client) => {
    // No port given: the hub must pick a free one and tell us where it is.
    const started = await client.callTool({
      name: 'dcm_web_hub_start',
      arguments: { persist },
    });
    assert.ok(!started.isError, `hub failed to start: ${started.content[0].text}`);

    const { serverId, port, address } = started.structuredContent;
    assert.equal(started.structuredContent.kind, 'hub');
    assert.ok(typeof port === 'number' && port > 0, `expected a port, got ${port}`);
    assert.equal(address, `http://127.0.0.1:${port}`);

    // The address it returned must be usable by the very next tool call.
    const sent = await client.callTool({
      name: 'dcm_web_send',
      arguments: { url: address, folder: fixture },
    });
    assert.ok(!sent.isError, `STOW failed: ${sent.content[0].text}`);
    assert.match(sent.content[0].text, /every file found was acknowledged/);

    // Confirm from the hub's own log that it is what received them.
    const status = await client.callTool({
      name: 'dcm_server_status',
      arguments: { serverId, lines: 50 },
    });
    assert.ok(!status.isError);
    assert.equal(status.structuredContent.status, 'running');
    assert.match(status.content[0].text, /POST \/studies/);
    assert.equal(countDicomFiles(persist), 2, 'the hub should have persisted both instances');

    // And that it is listed.
    const listed = await client.callTool({ name: 'dcm_servers_list', arguments: {} });
    const entry = listed.structuredContent.servers.find((s) => s.serverId === serverId);
    assert.ok(entry, `hub missing from the list: ${listed.content[0].text}`);
    assert.equal(entry.status, 'running');

    const stopped = await client.callTool({ name: 'dcm_server_stop', arguments: { serverId } });
    assert.ok(!stopped.isError, `stop reported a problem: ${stopped.content[0].text}`);
    assert.equal(stopped.structuredContent.status, 'exited');
    assert.equal(stopped.structuredContent.alreadyStopped, false);

    // Stopping twice is not an error — an assistant retrying must not be punished.
    const again = await client.callTool({ name: 'dcm_server_stop', arguments: { serverId } });
    assert.ok(!again.isError, `second stop should be harmless: ${again.content[0].text}`);
    assert.equal(again.structuredContent.alreadyStopped, true);
    assert.equal(again.structuredContent.status, 'exited');

    // The list keeps exited servers, so the session's history stays readable.
    const after = await client.callTool({ name: 'dcm_servers_list', arguments: {} });
    assert.equal(after.structuredContent.servers.find((s) => s.serverId === serverId).status, 'exited');

    assert.ok(await portIsFree(port), `port ${port} is still held after stop`);
  });
});

test('DIMSE receiver round trip: start, C-STORE to it, see it in the log, stop it', async (t) => {
  const fixture = makeFixture();
  const persist = tempDir('dcm-scp-persist-');
  t.after(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(persist, { recursive: true, force: true });
  });

  await withClient(async (client) => {
    const started = await client.callTool({
      name: 'dcm_receiver_start',
      arguments: { ae: 'TEST-SCP', persist },
    });
    assert.ok(!started.isError, `receiver failed to start: ${started.content[0].text}`);

    const { serverId, port, address, host } = started.structuredContent;
    assert.equal(started.structuredContent.kind, 'receiver');
    assert.ok(typeof port === 'number' && port > 0, `expected a port, got ${port}`);
    assert.equal(address, `127.0.0.1:${port}`);

    const sent = await client.callTool({
      name: 'dcm_send',
      arguments: { path: fixture, host, port, calledAe: 'TEST-SCP' },
    });
    assert.ok(!sent.isError, `C-STORE failed: ${sent.content[0].text}`);
    assert.match(sent.content[0].text, /every file found was acknowledged/);

    const status = await client.callTool({
      name: 'dcm_server_status',
      arguments: { serverId, lines: 50 },
    });
    assert.ok(!status.isError);
    assert.equal(status.structuredContent.status, 'running');
    assert.match(status.content[0].text, /C-STORE/);
    assert.equal(countDicomFiles(persist), 2, 'the receiver should have persisted both instances');

    const stopped = await client.callTool({ name: 'dcm_server_stop', arguments: { serverId } });
    assert.ok(!stopped.isError, `stop reported a problem: ${stopped.content[0].text}`);
    assert.equal(stopped.structuredContent.status, 'exited');

    assert.ok(await portIsFree(port), `port ${port} is still held after stop`);
  });
});

test('the running-server limit is refused clearly, not spawned without bound', async () => {
  await withClient(async (client) => {
    const ids = [];
    for (let i = 0; i < MAX_SERVERS; i++) {
      const started = await client.callTool({ name: 'dcm_web_hub_start', arguments: {} });
      assert.ok(!started.isError, `hub ${i + 1} failed to start: ${started.content[0].text}`);
      ids.push(started.structuredContent.serverId);
    }

    const refused = await client.callTool({ name: 'dcm_web_hub_start', arguments: {} });
    assert.equal(refused.isError, true, 'the server past the limit should be refused');
    assert.match(refused.content[0].text, new RegExp(`limit is ${MAX_SERVERS}`));
    assert.match(refused.content[0].text, /dcm_server_stop/);

    // Stopping one makes room again — the limit counts running servers, not
    // everything the session has ever started.
    await client.callTool({ name: 'dcm_server_stop', arguments: { serverId: ids[0] } });
    const allowed = await client.callTool({ name: 'dcm_web_hub_start', arguments: {} });
    assert.ok(!allowed.isError, `a slot should have freed up: ${allowed.content[0].text}`);
    ids.push(allowed.structuredContent.serverId);

    for (const serverId of ids.slice(1)) {
      const stopped = await client.callTool({ name: 'dcm_server_stop', arguments: { serverId } });
      assert.equal(stopped.structuredContent.status, 'exited');
    }
  });
});

test('a started server does not outlive the client that started it', async () => {
  // The failure this guards against is silent: an assistant disconnects, and a
  // receiver nobody can see keeps the port until the machine is rebooted.
  const port = await withClient(async (client) => {
    const started = await client.callTool({ name: 'dcm_receiver_start', arguments: {} });
    assert.ok(!started.isError, `receiver failed to start: ${started.content[0].text}`);
    return started.structuredContent.port;
  });

  assert.ok(await portIsFree(port), `port ${port} survived the client disconnecting`);
});

test('status and stop reject an unknown server id instead of inventing one', async () => {
  await withClient(async (client) => {
    const status = await client.callTool({
      name: 'dcm_server_status',
      arguments: { serverId: 'receiver-999' },
    });
    assert.equal(status.isError, true);
    assert.match(status.content[0].text, /No server with id/);

    const stop = await client.callTool({
      name: 'dcm_server_stop',
      arguments: { serverId: 'hub-999' },
    });
    assert.equal(stop.isError, true);
    assert.match(stop.content[0].text, /No server with id/);

    const listed = await client.callTool({ name: 'dcm_servers_list', arguments: {} });
    assert.ok(!listed.isError);
    assert.deepEqual(listed.structuredContent.servers, []);
    assert.match(listed.content[0].text, /No servers have been started/);
  });
});
