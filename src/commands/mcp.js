'use strict';

/**
 * dcm mcp — expose the engine as a Model Context Protocol server over stdio.
 *
 * This lets an MCP client (Claude Code, Claude Desktop, or any other) drive the
 * same DICOM operations the CLI offers, as tools. It is the CLI reused, not a
 * reimplementation: each tool builds the exact argument vector the command
 * takes and runs that command in-process, capturing its output.
 *
 * Because the server speaks JSON-RPC over stdout, command output must never
 * reach the real stdout. log.beginCapture()/endCapture() redirect it into a
 * string for the duration of each call, and calls are serialised so two
 * commands never capture at once. That plumbing lives in ./mcp/runtime.js,
 * the only module that touches capture.
 *
 * This file owns the wiring and nothing else: it builds the server, hands it to
 * each register(server, z, rt) module, and connects the transport. The tools
 * themselves live in ./mcp/tools-*.js so they can grow independently.
 */

const log = require('../lib/log');
const rt = require('./mcp/runtime');
const toolsDimse = require('./mcp/tools-dimse');
const toolsWeb = require('./mcp/tools-web');
const toolsServers = require('./mcp/tools-servers');
const resources = require('./mcp/resources');

const USAGE = `
dcm mcp — run a Model Context Protocol (MCP) server over stdio

Exposes the DICOM operations as MCP tools so an assistant can drive them:
  DIMSE     dcm_echo, dcm_inventory, dcm_query, dcm_worklist, dcm_tags,
            dcm_send, dcm_anon, dcm_edit
  DICOMweb  dcm_web_ping, dcm_web_send, dcm_web_query, dcm_web_retrieve

It speaks JSON-RPC on stdin/stdout and is meant to be launched by an MCP client,
not run by hand. Connect it, for example:

  # Claude Code
  claude mcp add dcm-dicom -- dcm mcp

  # Claude Desktop (claude_desktop_config.json)
  {
    "mcpServers": {
      "dcm-dicom": { "command": "dcm", "args": ["mcp"] }
    }
  }

Usage:
  dcm mcp

There are no options. Connection details (host, port, AE Titles, DICOMweb base
URL) are arguments to the individual tools, not to this command.

DICOMweb credentials are the exception: the web tools read DCM_WEB_TOKEN, or
DCM_WEB_USER and DCM_WEB_PASS, from the environment this server was launched
with. They are deliberately not tool arguments, so a token never travels
through the assistant's conversation.
`.trimStart();

/**
 * @param {{flags: Map}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;
  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  // Loaded here rather than at module scope so `dcm echo` and friends never pay
  // for the MCP SDK, and so a broken/optional install only affects `dcm mcp`.
  let McpServer;
  let StdioServerTransport;
  let z;
  try {
    ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
    ({ z } = require('zod'));
  } catch (err) {
    log.error('The MCP server needs @modelcontextprotocol/sdk and zod, which could not be loaded.');
    log.error(err && err.message ? err.message : String(err));
    log.error('If you installed via npm, run `npm install` in the package. This is only needed for `dcm mcp`.');
    return 1;
  }

  const { version } = require('../../package.json');
  const server = new McpServer({ name: 'dcm-dicom', version });

  toolsDimse.register(server, z, rt);
  toolsWeb.register(server, z, rt);
  toolsServers.register(server, z, rt);
  resources.register(server, z, rt);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Run until the client disconnects (stdin closes), which resolves the
  // transport's close. Keep the process alive meanwhile.
  await new Promise((resolve) => {
    transport.onclose = resolve;
    process.stdin.on('close', resolve);
  });

  return 0;
}

module.exports = { run, USAGE };
