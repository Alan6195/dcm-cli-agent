'use strict';

/**
 * Shared plumbing for the MCP tool modules.
 *
 * This is the ONLY module in the MCP layer that touches output capture. Because
 * the server speaks JSON-RPC over stdout, command output must never reach the
 * real stdout: log.beginCapture()/endCapture() redirect it into a string for
 * the duration of each call, and calls are serialised so two commands never
 * capture at once (the capture stack is global).
 *
 * Tools wrap the real command modules — each builds the exact argument vector a
 * person would type and runs that command in-process. Nothing here
 * reimplements engine behaviour.
 */

const log = require('../../lib/log');
const { tokenize } = require('../../lib/args');

/** The command modules each tool drives, loaded lazily. */
const COMMANDS = {
  echo: () => require('../echo'),
  info: () => require('../info'),
  find: () => require('../find'),
  tags: () => require('../tags'),
  send: () => require('../send'),
  anon: () => require('../anon'),
  edit: () => require('../edit'),
  web: () => require('../web'),
};

/**
 * Serialise tool executions so output capture never overlaps.
 *
 * @param {() => (any|Promise<any>)} fn  Work to run once the chain is clear.
 * @returns {Promise<any>}  Resolves with fn's result.
 */
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

/**
 * Build a text tool result, marking non-zero exits as errors.
 *
 * @param {{code:number, out:string, err:string}} result  From runCommand.
 * @param {{successText?: string}} [opts]  Text to use when a success is silent.
 * @returns {{content: object[], isError: boolean}}
 */
function textResult({ code, out, err }, { successText } = {}) {
  const body = [out, err].filter((s) => s && s.trim()).join('\n').trim();
  const text = body || (code === 0 ? (successText || 'Done.') : `Exited with code ${code}.`);
  return { content: [{ type: 'text', text }], isError: code !== 0 };
}

/**
 * For --json tools: return parsed JSON as pretty text plus structured content.
 *
 * The parse is why a --json tool must produce exactly one JSON document.
 *
 * @param {{code:number, out:string, err:string}} result  From runCommand.
 * @returns {{content: object[], structuredContent?: any, isError?: boolean}}
 */
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

/**
 * Push flag/value pairs only when the value is set.
 *
 * Always as one `--flag=value` token. Pushed as two, a value the assistant
 * supplied that begins with `--` would parse as a flag of its own — and so
 * reach switches (--serve, --destination) the tool deliberately does not
 * offer.
 *
 * @param {string[]} argv  Argument vector being built, mutated in place.
 * @param {string} flag  The switch to push.
 * @param {*} value  Pushed as a string when it is not undefined/null/''.
 */
function opt(argv, flag, value) {
  if (value !== undefined && value !== null && value !== '') argv.push(`${flag}=${value}`);
}

/**
 * An assistant-supplied value that goes into argv as a token of its own
 * (a path, a UID): refused if it could be read as a flag.
 *
 * @param {*} value
 * @param {string} what  Named in the refusal.
 * @returns {string}
 */
function pos(value, what) {
  const s = String(value);
  if (s.startsWith('-')) throw new Error(`${what} may not begin with "-": ${JSON.stringify(s)}`);
  return s;
}

/**
 * A `key=value` matching or query pair. Keys are keywords, tags or
 * sequence paths (ScheduledProcedureStepSequence/Modality), none of which
 * begin with "-" or contain "=", so one that does is refused rather than
 * parsed as a flag or re-split.
 *
 * @param {string} key
 * @param {*} value
 * @returns {string}
 */
function pair(key, value) {
  if (!key || key.startsWith('-') || key.includes('=')) {
    throw new Error(`not an attribute keyword, tag or path: ${JSON.stringify(key)}`);
  }
  return `${key}=${value}`;
}

/**
 * Enforces DCM_MCP_ALLOWED_HOSTS when it is set: a comma-separated list of
 * the hosts (names or addresses, matched case-insensitively) this server may
 * send DICOM to or query. Unset, any host is allowed — the default, since a
 * test bench usually points at whatever is to hand.
 *
 * Exists because a tag value or a peer's response can ask the assistant to
 * send a folder somewhere; with the list set, that request fails here.
 *
 * @param {string} host  Hostname or address, without port.
 */
function checkHost(host) {
  const raw = process.env.DCM_MCP_ALLOWED_HOSTS;
  if (!raw) return;
  const allowed = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!allowed.includes(h)) {
    throw new Error(
      `${host} is not in DCM_MCP_ALLOWED_HOSTS (${allowed.join(', ')}). ` +
        'Add it to the MCP server environment to allow it.'
    );
  }
}

module.exports = { COMMANDS, serialize, runCommand, textResult, jsonResult, opt, pos, pair, checkHost };
