'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * End-to-end coverage for `dcm mcp`.
 *
 * Spawns the CLI as an MCP server over stdio, drives it with the official MCP
 * client, and checks the tools are advertised and actually run the engine. This
 * is the same path an assistant (Claude Code / Claude Desktop) uses, so a
 * regression here breaks the integration the server exists for.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mcp-'));
  const script = path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js');
  const res = spawnSync(process.execPath, [script, dir, '--studies', '1', '--series', '2', '--instances', '3'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `fixture generation failed: ${res.stderr}`);
  return dir;
}

async function withClient(fn) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport , getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'],
      // StdioClientTransport does not inherit this process's environment: it
      // builds one from getDefaultEnvironment(), a fixed allow-list that cannot
      // include DCM_LINGER. Without this the server child opens every association
      // at the 1000 ms default while the suite believes it asked for 50.
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.DCM_LINGER ? { DCM_LINGER: process.env.DCM_LINGER } : {}),
      },
    });
  const client = new Client({ name: 'dcm-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('mcp server advertises the expected tools', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of ['dcm_echo', 'dcm_inventory', 'dcm_query', 'dcm_tags', 'dcm_send', 'dcm_anon', 'dcm_edit']) {
      assert.ok(names.includes(expected), `missing tool ${expected}; got ${names.join(', ')}`);
    }
  });
});

test('dcm_inventory returns structured content from the engine', async () => {
  const dir = makeFixture();
  try {
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'dcm_inventory', arguments: { path: dir, series: true } });
      assert.ok(!res.isError, 'inventory should succeed');
      assert.equal(res.structuredContent.dicomInstances, 6);
      assert.equal(res.structuredContent.studies.length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dcm_echo to a dead port reports an error, not a crash', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'dcm_echo',
      arguments: { host: '127.0.0.1', port: 1, calledAe: 'NOPE' },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Connection|Network|refused/i);
  });
});

test('dcm_send --dry-run plans without connecting', async () => {
  const dir = makeFixture();
  try {
    await withClient(async (client) => {
      const res = await client.callTool({
        name: 'dcm_send',
        arguments: { path: dir, host: 'nonexistent.invalid', port: 104, calledAe: 'A', dryRun: true },
      });
      assert.ok(!res.isError, 'a dry run should not error');
      assert.match(res.content[0].text, /DRY RUN/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
