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
 * commands never capture at once.
 */

const log = require('../lib/log');
const { tokenize } = require('../lib/args');

const USAGE = `
dcm mcp — run a Model Context Protocol (MCP) server over stdio

Exposes the DICOM operations as MCP tools so an assistant can drive them:
  dcm_echo, dcm_inventory, dcm_query, dcm_tags, dcm_send, dcm_anon, dcm_edit

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

There are no options. Connection details (host, port, AE Titles) are arguments
to the individual tools, not to this command.
`.trimStart();

/** The command modules each tool drives, loaded lazily. */
const COMMANDS = {
  echo: () => require('./echo'),
  info: () => require('./info'),
  find: () => require('./find'),
  tags: () => require('./tags'),
  send: () => require('./send'),
  anon: () => require('./anon'),
  edit: () => require('./edit'),
};

/** Serialise tool executions so output capture never overlaps. */
let chain = Promise.resolve();
function serialize(fn) {
  const result = chain.then(fn, fn);
  chain = result.then(() => {}, () => {});
  return result;
}

/**
 * Runs a command in-process with its output captured.
 *
 * @param {string} name  Command module key.
 * @param {string[]} argv  Argument vector for that command (without the name).
 * @returns {Promise<{code:number, out:string, err:string}>}
 */
function runCommand(name, argv) {
  return serialize(async () => {
    const mod = COMMANDS[name]();
    const sink = log.beginCapture();
    let code = 0;
    try {
      code = await mod.run(tokenize(argv));
    } catch (err) {
      log.error(err && err.message ? err.message : String(err));
      code = 1;
    } finally {
      log.endCapture();
    }
    return { code, out: sink.out, err: sink.err };
  });
}

/** Build a text tool result, marking non-zero exits as errors. */
function textResult({ code, out, err }, { successText } = {}) {
  const body = [out, err].filter((s) => s && s.trim()).join('\n').trim();
  const text = body || (code === 0 ? (successText || 'Done.') : `Exited with code ${code}.`);
  return { content: [{ type: 'text', text }], isError: code !== 0 };
}

/** For --json tools: return parsed JSON as pretty text plus structured content. */
function jsonResult({ code, out, err }) {
  if (code !== 0) {
    return { content: [{ type: 'text', text: (err || out || `Exited with code ${code}.`).trim() }], isError: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { content: [{ type: 'text', text: out.trim() || '(no output)' }] };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
    structuredContent: parsed,
  };
}

/** Push flag/value pairs only when the value is set. */
function opt(argv, flag, value) {
  if (value !== undefined && value !== null && value !== '') argv.push(flag, String(value));
}

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

  // ---- Connectivity ------------------------------------------------------
  server.registerTool(
    'dcm_echo',
    {
      title: 'DICOM C-ECHO',
      description:
        'Verify connectivity to a DICOM peer (C-ECHO). Confirms the peer answers and accepts your calling AE Title. Sends no images.',
      inputSchema: {
        host: z.string().describe('Peer hostname or IP.'),
        port: z.number().int().describe('Peer DIMSE port, e.g. 11112.'),
        calledAe: z.string().describe("The peer's AE Title."),
        callingAe: z.string().optional().describe('Our AE Title (default DCM-CLI).'),
        timeout: z.number().int().optional().describe('Milliseconds of silence to tolerate.'),
      },
    },
    async (a) => {
      const argv = ['--host', a.host, '--port', String(a.port), '--called-ae', a.calledAe];
      opt(argv, '--calling-ae', a.callingAe);
      opt(argv, '--timeout', a.timeout);
      return textResult(await runCommand('echo', argv));
    }
  );

  server.registerTool(
    'dcm_query',
    {
      title: 'DICOM C-FIND',
      description:
        'Query a peer (C-FIND). Note: a peer can accept images and still return zero matches — storing and indexing are separate.',
      inputSchema: {
        host: z.string(),
        port: z.number().int(),
        calledAe: z.string(),
        callingAe: z.string().optional(),
        level: z.enum(['study', 'series', 'image', 'mwl']).optional().describe('Query level (default study).'),
        keys: z.record(z.string(), z.string()).optional().describe('Matching keys as DICOM keyword→value, e.g. {"PatientID":"12345"}.'),
        limit: z.number().int().optional(),
      },
    },
    async (a) => {
      const argv = ['--host', a.host, '--port', String(a.port), '--called-ae', a.calledAe];
      opt(argv, '--calling-ae', a.callingAe);
      if (a.level && a.level !== 'study') argv.push(`--${a.level}`);
      opt(argv, '--limit', a.limit);
      for (const [k, v] of Object.entries(a.keys || {})) argv.push(`${k}=${v}`);
      argv.push('--json');
      return jsonResult(await runCommand('find', argv));
    }
  );

  // ---- Local files -------------------------------------------------------
  server.registerTool(
    'dcm_inventory',
    {
      title: 'Inventory a DICOM folder',
      description:
        'Inventory a folder or file: studies, series, modalities, counts, sizes and transfer syntaxes. Reads metadata only; sends nothing.',
      inputSchema: {
        path: z.string().describe('Folder or .dcm file to inspect.'),
        series: z.boolean().optional().describe('Break down per series and flag colliding Series UIDs.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = [a.path];
      if (a.series) argv.push('--series');
      if (a.recurse === false) argv.push('--no-recurse');
      argv.push('--json');
      return jsonResult(await runCommand('info', argv));
    }
  );

  server.registerTool(
    'dcm_tags',
    {
      title: 'Inspect DICOM tags',
      description: 'Dump the DICOM tags in a file or folder. Reads metadata only and never returns pixel data.',
      inputSchema: {
        path: z.string(),
        filter: z.string().optional().describe('Substring on keyword/tag/value, or /regex/.'),
        value: z.string().optional().describe('Only tags whose value matches — useful for finding lingering identifiers.'),
        privateOnly: z.boolean().optional().describe('Only private/unrecognised tags.'),
        all: z.boolean().optional().describe('Every file, not one representative per series.'),
        limit: z.number().int().optional(),
      },
    },
    async (a) => {
      const argv = [a.path];
      opt(argv, '--filter', a.filter);
      opt(argv, '--value', a.value);
      if (a.privateOnly) argv.push('--private');
      if (a.all) argv.push('--all');
      opt(argv, '--limit', a.limit);
      argv.push('--json');
      return jsonResult(await runCommand('tags', argv));
    }
  );

  // ---- Transfer / mutation ----------------------------------------------
  server.registerTool(
    'dcm_send',
    {
      title: 'Send a study (C-STORE)',
      description:
        'Send a folder to a peer (C-STORE), grouped by study and chunked. Reports files found, sent and acknowledged; a shortfall is a failure (isError). Use dryRun to plan without connecting.',
      inputSchema: {
        path: z.string().describe('Folder of DICOM files to send.'),
        host: z.string(),
        port: z.number().int(),
        calledAe: z.string(),
        callingAe: z.string().optional(),
        chunk: z.number().int().optional().describe('Instances per association (default 200).'),
        retry: z.number().int().optional().describe('Retries for an under-acknowledged chunk (default 1).'),
        dryRun: z.boolean().optional().describe('Scan and report the plan without opening a connection.'),
        rewriteSeriesUid: z.boolean().optional().describe('Replace Series Instance UIDs (changes the data sent).'),
        timeout: z.number().int().optional(),
      },
    },
    async (a) => {
      const argv = [a.path, '--host', a.host, '--port', String(a.port), '--called-ae', a.calledAe];
      opt(argv, '--calling-ae', a.callingAe);
      opt(argv, '--chunk', a.chunk);
      opt(argv, '--retry', a.retry);
      opt(argv, '--timeout', a.timeout);
      if (a.dryRun) argv.push('--dry-run');
      if (a.rewriteSeriesUid) argv.push('--rewrite-series-uid');
      return textResult(await runCommand('send', argv));
    }
  );

  server.registerTool(
    'dcm_anon',
    {
      title: 'De-identify a folder',
      description:
        'Copy a folder with patient identifiers removed and UIDs remapped (best-effort, not certified — does not touch pixel data). The source is never modified.',
      inputSchema: {
        path: z.string().describe('Source folder.'),
        out: z.string().describe('Destination folder (must be outside the source).'),
        prefix: z.string().optional().describe('Pseudonym prefix (default ANON).'),
        keepDescriptions: z.boolean().optional(),
        keepPrivate: z.boolean().optional(),
      },
    },
    async (a) => {
      const argv = [a.path, '--out', a.out];
      opt(argv, '--prefix', a.prefix);
      if (a.keepDescriptions) argv.push('--keep-descriptions');
      if (a.keepPrivate) argv.push('--keep-private');
      return textResult(await runCommand('anon', argv), { successText: 'De-identified.' });
    }
  );

  server.registerTool(
    'dcm_edit',
    {
      title: 'Edit DICOM tags',
      description:
        'Change or remove tags and write copies to a new folder (the source is untouched). Editing UIDs requires force. Use dryRun to preview.',
      inputSchema: {
        path: z.string().describe('Source file or folder.'),
        out: z.string().describe('Destination folder for the edited copies.'),
        set: z.record(z.string(), z.string()).optional().describe('Tags to set, keyword or (gggg,eeee) → value.'),
        remove: z.array(z.string()).optional().describe('Tag keywords/numbers to remove.'),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional().describe('Allow editing UIDs and structural identifiers.'),
      },
    },
    async (a) => {
      const argv = [a.path];
      for (const [k, v] of Object.entries(a.set || {})) argv.push('--set', `${k}=${v}`);
      for (const k of a.remove || []) argv.push('--remove', k);
      argv.push('--out', a.out);
      if (a.dryRun) argv.push('--dry-run');
      if (a.force) argv.push('--force');
      return textResult(await runCommand('edit', argv));
    }
  );

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
