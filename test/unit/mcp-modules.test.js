'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The MCP layer is split across ./src/commands/mcp/*.js so separate work can
 * extend disjoint files. These tests pin the contract that split depends on:
 *
 *   - every tool module exports register(server, z, rt);
 *   - the runtime exports the helpers those modules are handed;
 *   - the set of tool names the modules register is exactly the advertised set,
 *     so a tool cannot be silently dropped or renamed by a later edit.
 *
 * The e2e test drives a real server over stdio; this one is the cheap check
 * that runs without spawning anything.
 */

const { z } = require('zod');
const rt = require('../../src/commands/mcp/runtime');
const toolsDimse = require('../../src/commands/mcp/tools-dimse');
const toolsWeb = require('../../src/commands/mcp/tools-web');
const toolsServers = require('../../src/commands/mcp/tools-servers');
const resources = require('../../src/commands/mcp/resources');
const mcp = require('../../src/commands/mcp');

/** A stand-in for McpServer that records what a module registers. */
function fakeServer() {
  const tools = [];
  return {
    tools,
    registerTool(name, config, handler) {
      tools.push({ name, config, handler });
    },
    registerResource(...args) {
      tools.push({ resource: args[0] });
    },
  };
}

const MODULES = {
  'tools-dimse': toolsDimse,
  'tools-web': toolsWeb,
  'tools-servers': toolsServers,
  resources,
};

test('every MCP module exports register(server, z, rt)', () => {
  for (const [name, mod] of Object.entries(MODULES)) {
    assert.equal(typeof mod.register, 'function', `${name} must export register()`);
    assert.equal(mod.register.length, 3, `${name}.register must take (server, z, rt)`);
  }
});

test('the runtime exports the helpers the tool modules are handed', () => {
  for (const fn of ['runCommand', 'textResult', 'jsonResult', 'opt', 'serialize']) {
    assert.equal(typeof rt[fn], 'function', `runtime must export ${fn}()`);
  }
  assert.equal(typeof rt.COMMANDS, 'object');
});

test('tools-dimse registers exactly the DIMSE and local-file tools', () => {
  const server = fakeServer();
  toolsDimse.register(server, z, rt);
  assert.deepEqual(
    server.tools.map((t) => t.name),
    [
      'dcm_echo', 'dcm_query', 'dcm_worklist', 'dcm_inventory', 'dcm_tags',
      'dcm_send', 'dcm_anon', 'dcm_edit',
      'dcm_mpps_perform', 'dcm_mpps_start', 'dcm_mpps_update',
      'dcm_mpps_complete', 'dcm_mpps_discontinue',
    ]
  );
});

test('tools-dimse registers the mpps command it drives with the runtime', () => {
  // `dcm mpps` is not in the runtime's default table; the module that needs it
  // adds it. If that ever stops happening, every MPPS tool fails at call time
  // rather than at load time, which is a much worse place to find out.
  toolsDimse.register(fakeServer(), z, rt);
  assert.equal(typeof rt.COMMANDS.mpps, 'function');
  assert.equal(typeof rt.COMMANDS.mpps().run, 'function');
});

test('tools-web registers exactly the DICOMweb tools', () => {
  const server = fakeServer();
  toolsWeb.register(server, z, rt);
  assert.deepEqual(
    server.tools.map((t) => t.name),
    ['dcm_web_ping', 'dcm_web_send', 'dcm_web_query', 'dcm_web_retrieve']
  );
});

// No stubs are left: resources.js registers resources and prompts (covered by
// test/e2e/mcp-resources.test.js), and tools-servers.js registers the
// server-lifecycle tools below (covered by test/e2e/mcp-servers.test.js).
test('tools-servers registers exactly the server-lifecycle tools', () => {
  const server = fakeServer();
  toolsServers.register(server, z, rt);
  assert.deepEqual(
    server.tools.map((t) => t.name),
    ['dcm_receiver_start', 'dcm_web_hub_start', 'dcm_servers_list', 'dcm_server_status', 'dcm_server_stop']
  );
});

test('every tool has a title, a description and an input schema', () => {
  const server = fakeServer();
  toolsDimse.register(server, z, rt);
  toolsWeb.register(server, z, rt);
  for (const { name, config, handler } of server.tools) {
    assert.ok(config.title, `${name} needs a title`);
    assert.ok(config.description && config.description.length > 40, `${name} needs a real description`);
    assert.equal(typeof config.inputSchema, 'object', `${name} needs an inputSchema`);
    assert.equal(typeof handler, 'function', `${name} needs a handler`);
  }
});

test('a DICOMweb credential never appears as a tool argument', () => {
  const server = fakeServer();
  toolsWeb.register(server, z, rt);
  for (const { name, config } of server.tools) {
    for (const key of Object.keys(config.inputSchema)) {
      assert.doesNotMatch(key, /token|pass|secret|auth|user/i, `${name}.${key} must not carry a credential`);
    }
  }
});

test('USAGE still lists every tool the modules register', () => {
  const server = fakeServer();
  toolsDimse.register(server, z, rt);
  toolsWeb.register(server, z, rt);
  for (const { name } of server.tools) {
    assert.ok(mcp.USAGE.includes(name), `USAGE does not mention ${name}`);
  }
});
