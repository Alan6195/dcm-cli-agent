'use strict';

/**
 * Console output.
 *
 * Two rules shape this module:
 *
 * 1. Human-readable reporting goes to stdout; diagnostics and warnings go to
 *    stderr. That keeps `dcm info --json | jq` and friends usable without the
 *    log chatter corrupting the payload.
 *
 * 2. `--verbose` is not decoration. Association negotiation — proposed and
 *    accepted presentation contexts, transfer syntaxes, and the peer's
 *    implementation class UID and version — is what actually makes a
 *    connectivity problem diagnosable. It is logged in full at verbose level.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let level = LEVELS.info;
let useColor =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(code, text) {
  return useColor ? `${code}${text}${ANSI.reset}` : text;
}

const color = {
  dim: (t) => paint(ANSI.dim, t),
  bold: (t) => paint(ANSI.bold, t),
  red: (t) => paint(ANSI.red, t),
  green: (t) => paint(ANSI.green, t),
  yellow: (t) => paint(ANSI.yellow, t),
  blue: (t) => paint(ANSI.blue, t),
  magenta: (t) => paint(ANSI.magenta, t),
  cyan: (t) => paint(ANSI.cyan, t),
};

/**
 * @param {{verbose?: boolean, quiet?: boolean, noColor?: boolean}} opts
 */
function configure(opts = {}) {
  if (opts.verbose) level = LEVELS.debug;
  else if (opts.quiet) level = LEVELS.error;
  else level = LEVELS.info;

  if (opts.noColor) useColor = false;
}

function isVerbose() {
  return level >= LEVELS.debug;
}

/** Report output. Goes to stdout because it is the product of the command. */
function out(msg = '') {
  process.stdout.write(`${msg}\n`);
}

function info(msg = '') {
  if (level >= LEVELS.info) process.stderr.write(`${msg}\n`);
}

function warn(msg = '') {
  if (level >= LEVELS.warn) process.stderr.write(`${color.yellow('warning')} ${msg}\n`);
}

function error(msg = '') {
  if (level >= LEVELS.error) process.stderr.write(`${color.red('error')} ${msg}\n`);
}

/** Verbose diagnostics. Only emitted under --verbose. */
function debug(msg = '') {
  if (level >= LEVELS.debug) process.stderr.write(`${color.dim(`  · ${msg}`)}\n`);
}

/**
 * Logs the negotiated association in full.
 *
 * This is the payload that makes connectivity issues debuggable: what we
 * proposed, what the peer accepted or refused and why, which transfer syntax
 * each context settled on, and who the peer says it is.
 *
 * @param {object} association A dcmjs-dimse Association.
 * @param {{PresentationContextResult: object}} constants
 * @param {string} phase 'proposed' or 'accepted'
 */
function logAssociation(association, constants, phase) {
  if (!isVerbose() || !association) return;

  const { PresentationContextResult } = constants;
  const resultNames = new Map([
    [PresentationContextResult.Proposed, 'proposed'],
    [PresentationContextResult.Accept, 'accepted'],
    [PresentationContextResult.RejectUser, 'rejected by user'],
    [PresentationContextResult.RejectNoReason, 'rejected (no reason)'],
    [PresentationContextResult.RejectAbstractSyntaxNotSupported, 'rejected (abstract syntax not supported)'],
    [PresentationContextResult.RejectTransferSyntaxesNotSupported, 'rejected (transfer syntaxes not supported)'],
  ]);

  debug(`association ${phase}:`);
  debug(`  calling AE: ${association.getCallingAeTitle()}`);
  debug(`  called AE:  ${association.getCalledAeTitle()}`);
  debug(`  max PDU:    ${association.getMaxPduLength()}`);

  // Who the peer says it is. Vendor and version here often explains odd behaviour.
  try {
    debug(`  peer implementation class UID: ${association.getImplementationClassUid()}`);
    debug(`  peer implementation version:   ${association.getImplementationVersion()}`);
  } catch {
    // Not populated until the peer has answered; not worth failing over.
  }

  let contexts = [];
  try {
    contexts = association.getPresentationContexts();
  } catch {
    return;
  }

  debug(`  presentation contexts (${contexts.length}):`);
  for (const { id, context } of contexts) {
    const result = context.getResult();
    const name = resultNames.get(result) ?? `result ${result}`;
    const accepted = context.getAcceptedTransferSyntaxUid();
    debug(`    [${id}] ${context.getAbstractSyntaxUid()} — ${name}`);
    if (accepted) {
      debug(`         accepted transfer syntax: ${accepted}`);
    } else {
      for (const ts of context.getTransferSyntaxUids()) {
        debug(`         offered: ${ts}`);
      }
    }
  }
}

/**
 * Wires the dcmjs-dimse internal logger through to our verbose stream so that
 * `--verbose` also surfaces the library's own PDU-level trace.
 *
 * @param {object} dimseLog The `log` export from dcmjs-dimse (a loglevel logger).
 */
function attachLibraryLogger(dimseLog) {
  if (!dimseLog || typeof dimseLog.setLevel !== 'function') return;
  dimseLog.setLevel(isVerbose() ? 'info' : 'silent');
}

module.exports = {
  configure,
  isVerbose,
  out,
  info,
  warn,
  error,
  debug,
  color,
  logAssociation,
  attachLibraryLogger,
  LEVELS,
};
