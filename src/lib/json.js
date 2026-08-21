'use strict';

/**
 * The `--json` result envelope.
 *
 * WHY THIS EXISTS
 *
 * Exit codes alone cannot carry the answer a CI job needs. `dcm find --mwl
 * --json PatientID=NOPE` exits 1 having correctly returned zero rows; the same
 * command with the wrong --called-ae also exits 1, having been refused at
 * A-ASSOCIATE and never asked the question at all. Both are "1", and the only
 * thing telling them apart was English prose on stderr that this project
 * rewords whenever the wording improves. A test suite pinned to that prose is
 * pinned to nothing.
 *
 * So every terminal path of a `--json` command emits exactly one JSON object on
 * stdout, carrying an explicit outcome discriminator. "Correctly returned zero"
 * and "never got to ask" stop being the same observation.
 *
 * THE CONTRACT (schema dcm.result/1)
 *
 * One JSON object, printed once, on stdout. stderr carries prose and is never
 * part of the contract. These top-level keys are reserved by the envelope and a
 * command payload may not use them:
 *
 *   schema         string   "dcm.result/1". Pin on this.
 *   schemaVersion  number   1. Bumped only on a breaking change to these keys.
 *   command        string   "echo" | "find" | "info" | "tags" | ...
 *   outcome        string   the discriminator; see Outcome below.
 *   ok             boolean  true iff outcome is "ok" or "matched".
 *   exitCode       number   the process exit code this object was emitted with,
 *                           repeated here so a captured document is self-
 *                           contained when the code itself was not recorded.
 *   message        string   one human sentence. Prose: never assert on it.
 *   peer           object?  { host, port, calledAe, callingAe } for anything
 *                           that opened, or tried to open, an association.
 *   detail         object?  the protocol detail; see below. Absent when there
 *                           is nothing protocol-level to say.
 *   expectation    object?  present only when the caller stated one with an
 *                           --expect-* flag; see below.
 *
 * Everything else at the top level is the command's own payload — find's
 * `count`/`matches`, info's `studies`, tags' `results`. The payload is flat
 * rather than nested under a `data` key so that a consumer written against the
 * pre-envelope output keeps working; the reserved list above is what keeps that
 * safe, and build() throws if a payload tries to shadow one of those keys.
 *
 * OUTCOME — the discriminator
 *
 *   ok        Completed. Nothing was being counted (echo answered, an inventory
 *             was produced, --help was asked for).
 *   matched   Completed, and there is at least one result.
 *   empty     Completed, and there are zero results. THIS IS A LEGITIMATE
 *             ANSWER. It is the outcome the expected-empty assertion after an
 *             MPPS N-CREATE is looking for, and it is the one that must never
 *             be confused with the four below.
 *   rejected  The peer answered and said no — an A-ASSOCIATE-RJ, a refused
 *             presentation context, or a DIMSE failure status. Configuration.
 *   aborted   The association was established and then torn down (A-ABORT).
 *             Not access control: the peer had already let us in.
 *   timeout   Silence. Nobody said no; the peer stopped responding.
 *   network   Transport failed before DICOM was in play — ECONNREFUSED,
 *             ENOTFOUND, no route.
 *   usage     The command line was wrong. Exit 2. Nothing was sent.
 *   error     A local failure that is none of the above.
 *
 * `rejected`, `aborted`, `timeout` and `network` are kept apart because they
 * have four different fixes — the same reason src/lib/reject.js refuses to
 * flatten them. A caller that does not care can test `ok`.
 *
 * DETAIL — the protocol record
 *
 * A generalisation of the shape `dcm mpps` already emits on a refusal
 * ({"ok":false,"reason":"refused","status":{"code":"0x0111",...}}), so that
 * richness is available from every command rather than one:
 *
 *   detail.kind      "rejected" | "aborted" | "timeout" | "transport" |
 *                    "status" | "no-context" | "no-response" | "error"
 *   detail.label     short label, e.g. "Calling AE Title not recognized"
 *   detail.headline  one sentence of explanation
 *   detail.hint      what to do about it, when there is something to say
 *   detail.retryable boolean — is trying again meaningful
 *   detail.raw       the wire fact, e.g. "A-ASSOCIATE-RJ result=1 source=1 reason=3"
 *
 * plus exactly one kind-specific block, so the numbers stay assertable:
 *
 *   detail.associate { result, source, reason, permanence }   kind "rejected"
 *   detail.abort     { source, reason }                       kind "aborted"
 *   detail.timeout   { phase, timeoutMs }                     kind "timeout"
 *   detail.transport { code }                                 kind "transport"
 *   detail.status    { code, value, class, label, plain,      kind "status"
 *                      hint?, peerComment? }
 *
 * EXPECTATION — the caller states what it believes
 *
 *   expectation.flag       the flag that stated it, e.g. "--expect-empty"
 *   expectation.kind       "count" | "empty" | "nonempty"
 *   expectation.expected   the number expected, or null for "nonempty"
 *   expectation.actual     what was counted, or null if nothing was counted
 *   expectation.evaluated  false when the command never got to count —
 *                          a refused association cannot satisfy --expect-empty
 *   expectation.held       true only when evaluated and satisfied
 *
 * When an expectation is stated the exit code answers THAT question: 0 if it
 * held, 1 if it did not. That is what makes the code mean something, rather
 * than "1" meaning any of five unrelated things.
 *
 * ONE DOCUMENT
 *
 * emit() is once-per-run. A second call is dropped rather than allowed to
 * append a second document to stdout, because a consumer doing JSON.parse() on
 * the whole stream would fail on the concatenation and report nothing at all
 * — a worse failure than the missing detail. guard() resets the latch per run,
 * so repeated in-process runs (the MCP server, the test harness) behave.
 */

const log = require('./log');

/** Bumped only when a reserved top-level key changes meaning or disappears. */
const SCHEMA_VERSION = 1;
const SCHEMA = `dcm.result/${SCHEMA_VERSION}`;

const Outcome = Object.freeze({
  OK: 'ok',
  MATCHED: 'matched',
  EMPTY: 'empty',
  REJECTED: 'rejected',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  USAGE: 'usage',
  ERROR: 'error',
});

/**
 * Top-level keys the envelope owns. A command payload using one of these would
 * silently overwrite part of the contract, so build() refuses it.
 */
const RESERVED_KEYS = Object.freeze([
  'schema', 'schemaVersion', 'command', 'outcome', 'ok', 'exitCode',
  'message', 'peer', 'detail', 'expectation',
]);

/** Outcomes that mean the command did what it was asked. */
const SUCCESSFUL = new Set([Outcome.OK, Outcome.MATCHED]);

/**
 * The exit code an outcome carries when the caller stated no expectation.
 *
 * `empty` maps to 1 deliberately. It is the documented behaviour of `dcm find`
 * today and scripts depend on it, so the ambiguity is resolved by the `outcome`
 * field and by --expect-*, not by changing what an existing script sees.
 */
function exitCodeFor(outcome) {
  if (outcome === Outcome.USAGE) return 2;
  return SUCCESSFUL.has(outcome) ? 0 : 1;
}

/** Whether an outcome counts as success. */
function isOk(outcome) {
  return SUCCESSFUL.has(outcome);
}

/**
 * Builds the envelope.
 *
 * @param {object} spec
 * @param {string} spec.command
 * @param {string} spec.outcome      One of Outcome.
 * @param {string} [spec.message]
 * @param {object} [spec.peer]       { host, port, calledAe, callingAe }
 * @param {object} [spec.detail]     From fromAssociationOutcome/fromStatus/...
 * @param {object} [spec.expectation] From evaluateExpectation().
 * @param {object} [spec.payload]    Command-specific keys, flattened in.
 * @param {number} [spec.exitCode]   Overrides the outcome's default code.
 * @returns {object}
 */
function build(spec) {
  const {
    command, outcome, message, peer, detail, expectation, payload = {},
  } = spec;

  if (!Object.values(Outcome).includes(outcome)) {
    throw new Error(`json.build: "${outcome}" is not a known outcome.`);
  }

  const collisions = RESERVED_KEYS.filter((k) => Object.hasOwn(payload, k));
  if (collisions.length) {
    // A programming error, not a runtime condition: a payload key shadowing
    // the envelope would corrupt the contract for every consumer at once.
    throw new Error(
      `json.build: payload for "${command}" uses reserved key(s) ${collisions.join(', ')}. ` +
        'Rename them; the envelope owns those.'
    );
  }

  const exitCode = spec.exitCode ?? exitCodeFor(outcome);

  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    command,
    outcome,
    ok: isOk(outcome),
    exitCode,
    ...(message ? { message } : {}),
    ...(peer ? { peer } : {}),
    ...(detail ? { detail } : {}),
    ...(expectation ? { expectation } : {}),
    ...payload,
  };
}

/**
 * The once-per-run latch. Reset by guard() so repeated in-process runs — the
 * MCP server, the test harness — each get their own document.
 */
let hasEmitted = false;

function begin() {
  hasEmitted = false;
}

function emitted() {
  return hasEmitted;
}

/**
 * Writes the envelope to stdout, once.
 *
 * @param {object} envelope From build().
 * @returns {number} The exit code the envelope declares.
 */
function emit(envelope) {
  if (hasEmitted) {
    // Two documents concatenated on stdout parse as neither, so the second is
    // dropped and the loss is reported on stderr where it cannot corrupt the
    // first. This should not happen; it is a guard, not a feature.
    log.debug(`a second JSON document was suppressed (outcome ${envelope.outcome})`);
    return envelope.exitCode;
  }
  hasEmitted = true;
  log.out(JSON.stringify(envelope, null, 2));
  return envelope.exitCode;
}

/**
 * Build and emit in one call, returning the exit code.
 *
 * This is the call every command makes on every terminal path.
 *
 * @param {object} spec See build().
 * @returns {number} Exit code.
 */
function result(spec) {
  return emit(build(spec));
}

/**
 * Turns a src/lib/reject.js association outcome into an outcome + detail.
 *
 * @param {object} outcome From runAssociation(); kind is one of
 *   'rejected' | 'aborted' | 'timeout' | 'transport'.
 * @returns {{outcome: string, message: string, detail: object}}
 */
function fromAssociationOutcome(outcome) {
  const base = {
    kind: outcome.kind === 'transport' ? 'transport' : outcome.kind,
    label: outcome.label,
    headline: outcome.headline,
    ...(outcome.hint ? { hint: outcome.hint } : {}),
    retryable: Boolean(outcome.retryable),
    raw: outcome.raw,
  };

  if (outcome.kind === 'rejected') {
    return {
      outcome: Outcome.REJECTED,
      message: outcome.headline,
      detail: {
        ...base,
        associate: {
          result: outcome.result,
          source: outcome.source,
          reason: outcome.reason,
          permanence: outcome.permanence,
        },
      },
    };
  }

  if (outcome.kind === 'aborted') {
    return {
      outcome: Outcome.ABORTED,
      message: outcome.headline,
      detail: { ...base, abort: { source: outcome.source, reason: outcome.reason } },
    };
  }

  if (outcome.kind === 'timeout') {
    return {
      outcome: Outcome.TIMEOUT,
      message: outcome.headline,
      detail: { ...base, timeout: { phase: outcome.phase, timeoutMs: outcome.timeoutMs } },
    };
  }

  // 'transport' — the TCP connection never came up. Reported as `network`
  // because that is the word a caller reaches for, while detail.kind keeps the
  // reject.js vocabulary intact.
  const code = outcome.code ?? errnoFrom(outcome.raw);
  return {
    outcome: Outcome.NETWORK,
    message: outcome.headline,
    detail: {
      ...base,
      // reject.js decided `retryable` from an Error whose `code` had been
      // stripped, so it defaulted to true. With the errno recovered, apply its
      // own rule: a refused connection and an unresolvable name are settled
      // answers, and telling a CI job to retry them wastes minutes per run.
      retryable: NOT_RETRYABLE.has(code) ? false : base.retryable,
      transport: { code },
    },
  };
}

/** The errno names worth recovering from a re-wrapped socket error. */
const ERRNOS = [
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
  'ECONNRESET', 'EPIPE', 'EACCES', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'EHOSTDOWN',
];

/** Transport failures reject.js treats as settled rather than worth retrying. */
const NOT_RETRYABLE = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/**
 * Recovers the errno from the text when the Error object no longer carries it.
 *
 * dcmjs-dimse re-wraps a socket failure into a fresh Error before it reaches
 * us, so `err.code` is undefined and only the message still says
 * "connect ECONNREFUSED 127.0.0.1:11112". Leaving `transport.code` null there
 * would gut the most useful field on the most common failure a CI preflight
 * sees — "nothing is listening" is precisely what it is trying to detect.
 *
 * A last resort, not a substitute: the real `code` is used whenever it survives.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function errnoFrom(raw) {
  const text = String(raw ?? '');
  return ERRNOS.find((code) => text.includes(code)) ?? null;
}

/**
 * A DIMSE status as the `detail` block carries it.
 *
 * This is the generalisation of the MPPS refusal shape: the full status record
 * travels, so a CI job can assert on `detail.status.code` rather than on the
 * sentence describing it. Emitted on success too — `detail.status.code` of
 * "0x0000" is a positive statement that the peer answered, which is exactly
 * what a connectivity preflight wants to record.
 *
 * @param {object} described From status.describe().
 * @returns {object}
 */
function statusDetail(described) {
  return {
    kind: 'status',
    label: described.label,
    headline: described.plain,
    ...(described.hint ? { hint: described.hint } : {}),
    retryable: false,
    raw: `DIMSE status ${described.code}`,
    status: {
      code: described.code,
      value: described.status,
      class: described.class,
      label: described.label,
      plain: described.plain,
      ...(described.hint ? { hint: described.hint } : {}),
      ...(described.peerComment ? { peerComment: described.peerComment } : {}),
    },
  };
}

/**
 * Turns a failing src/lib/status.js description into an outcome + detail.
 *
 * A status that is not success means the peer answered and said no, which is a
 * rejection in the sense the discriminator uses even though no A-ASSOCIATE-RJ
 * was involved. `detail.kind` of "status" says which of the two it was.
 *
 * @param {object} described From status.describe().
 * @returns {{outcome: string, message: string, detail: object}}
 */
function fromStatus(described) {
  return {
    outcome: Outcome.REJECTED,
    message: described.plain,
    detail: statusDetail(described),
  };
}

/**
 * Detail for a local failure with no protocol content.
 *
 * @param {Error} err
 * @returns {object}
 */
function fromError(err) {
  return {
    kind: 'error',
    label: err?.name ?? 'Error',
    headline: err?.message ?? String(err),
    retryable: false,
    raw: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
    // Only under --verbose: a stack in a machine document is noise that also
    // leaks local paths into whatever the CI job archives.
    ...(log.isVerbose() && err?.stack ? { stack: err.stack } : {}),
  };
}

/**
 * The connection block. Both AE Titles are always present, because which AE
 * Title was used is the single most common cause of a result that looks wrong.
 *
 * @param {{host: string, port: number, calledAe: string, callingAe: string}} conn
 * @returns {object}
 */
function peerOf(conn) {
  return {
    host: conn.host,
    port: conn.port,
    calledAe: conn.calledAe,
    callingAe: conn.callingAe,
  };
}

/**
 * Reads the --expect-* flags into a single declared expectation.
 *
 * The flags are mutually exclusive: two contradictory expectations in one
 * command line is a mistake worth failing on rather than resolving by
 * precedence.
 *
 * @param {Map} flags
 * @param {{UsageError: Function}} argsLib Passed in to keep this module free of
 *   a dependency on the parser.
 * @returns {{flag: string, kind: string, expected: number|null}|undefined}
 */
function readExpectation(flags, argsLib) {
  const stated = [];

  if (flags.has('expect-count')) {
    const raw = flags.get('expect-count');
    if (raw === true) throw new argsLib.UsageError('--expect-count expects a number.');
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new argsLib.UsageError(
        `--expect-count expects a non-negative whole number, got "${raw}".`
      );
    }
    stated.push({ flag: '--expect-count', kind: 'count', expected: n });
  }
  if (flags.has('expect-empty')) {
    stated.push({ flag: '--expect-empty', kind: 'empty', expected: 0 });
  }
  if (flags.has('expect-nonempty')) {
    stated.push({ flag: '--expect-nonempty', kind: 'nonempty', expected: null });
  }

  if (stated.length > 1) {
    throw new argsLib.UsageError(
      `${stated.map((s) => s.flag).join(' and ')} state different expectations; give one.`
    );
  }
  return stated[0];
}

/**
 * Judges a declared expectation against what was actually counted.
 *
 * `actual === null` means the command never got to count — the association was
 * refused, the peer aborted, the host was unreachable. Such a run does NOT
 * satisfy --expect-empty. That distinction is the entire reason this exists:
 * "the worklist entry is correctly gone" and "the tenant lookup failed because
 * the Called AE was wrong" both produce zero rows locally, and only one of them
 * is a passing test.
 *
 * @param {object|undefined} declared From readExpectation().
 * @param {number|null} actual
 * @returns {object|undefined}
 */
function evaluateExpectation(declared, actual) {
  if (!declared) return undefined;

  if (actual === null || actual === undefined) {
    return {
      ...declared,
      actual: null,
      evaluated: false,
      held: false,
      reason: 'the command did not complete, so nothing was counted',
    };
  }

  let held;
  if (declared.kind === 'count') held = actual === declared.expected;
  else if (declared.kind === 'empty') held = actual === 0;
  else held = actual > 0;

  return { ...declared, actual, evaluated: true, held };
}

/**
 * Composes the exit code from the outcome, the expectation verdict, and any
 * independent gate the command runs.
 *
 * The three can disagree, so the precedence is spelled out once here rather
 * than re-derived per command:
 *
 *   1. A usage error is always 2. Nothing ran, so nothing else can be judged.
 *   2. A gate that failed is always 1. `--check-vr` finding a violation, or
 *      `dcm info` hitting an unreadable file, is a failure regardless of how
 *      many rows came back — a gate that a passing count could suppress is not
 *      a gate.
 *   3. An expectation, when stated, decides. This is the point of the flags:
 *      --expect-empty holding is a pass even though zero rows alone is a 1.
 *   4. Otherwise the outcome's own default, which preserves the existing
 *      "zero matches exits 1" convention for every caller that states nothing.
 *
 * @param {{outcome: string, expectation?: object, gateFailed?: boolean}} spec
 * @returns {number}
 */
function resolveExitCode(spec) {
  const { outcome, expectation, gateFailed = false } = spec;
  const base = exitCodeFor(outcome);
  if (base === 2) return 2;
  if (gateFailed) return 1;
  if (expectation) return expectation.held ? 0 : 1;
  return base;
}

/** One sentence describing an expectation verdict, for stderr and `message`. */
function describeExpectation(verdict) {
  if (!verdict) return '';
  const want = verdict.kind === 'nonempty'
    ? 'at least one result'
    : `${verdict.expected} result${verdict.expected === 1 ? '' : 's'}`;

  if (!verdict.evaluated) {
    return `${verdict.flag} expected ${want}, but the command did not complete, ` +
      'so the expectation was never tested. This is a failure, not an empty result.';
  }
  if (verdict.held) return `${verdict.flag} held: ${want}, got ${verdict.actual}.`;
  return `${verdict.flag} expected ${want}, got ${verdict.actual}.`;
}

/**
 * Wraps a command body so no terminal path can escape without a document.
 *
 * Without this, `--json` is a promise each command keeps by hand, and the
 * paths that get forgotten are exactly the interesting ones — a usage error
 * thrown before the first log.out, an unexpected throw from a parser. Both
 * previously reached src/cli.js, which prints English to stderr and leaves
 * stdout empty.
 *
 * Outside --json mode the error is re-thrown untouched, so the existing prose
 * behaviour in src/cli.js is unchanged.
 *
 * @param {string} command
 * @param {Map} flags
 * @param {() => Promise<number>} fn The command body.
 * @returns {Promise<number>} Exit code.
 */
async function guard(command, flags, fn) {
  begin();
  const wantsJson = flags.has('json') || flags.has('json-raw');

  try {
    return await fn();
  } catch (err) {
    if (!wantsJson) throw err;

    const isUsage = err?.name === 'UsageError';

    // stderr as well as the document: a person tailing a CI log should not have
    // to pipe through jq to find out they mistyped a flag.
    log.error(err?.message ?? String(err));
    if (isUsage) log.error(`Run 'dcm ${command} --help' for usage.`);

    if (hasEmitted) {
      // The command already answered and then threw. The document that is out
      // there is the better record; do not contradict it with a second one.
      return isUsage ? 2 : 1;
    }

    return result({
      command,
      outcome: isUsage ? Outcome.USAGE : Outcome.ERROR,
      message: err?.message ?? String(err),
      detail: fromError(err),
    });
  }
}

/**
 * The `--help` path under --json.
 *
 * Help is a terminal path like any other, and a machine asking a command what
 * it accepts should not have to parse a wall of text out of an unmarked stdout.
 *
 * @param {string} command
 * @param {Map} flags
 * @param {string} usage
 * @returns {number} Exit code.
 */
function help(command, flags, usage) {
  if (!(flags.has('json') || flags.has('json-raw'))) {
    log.out(usage);
    return 0;
  }
  begin();
  return result({
    command,
    outcome: Outcome.OK,
    message: `Usage for dcm ${command}.`,
    payload: { help: usage },
  });
}

module.exports = {
  SCHEMA,
  SCHEMA_VERSION,
  Outcome,
  RESERVED_KEYS,
  exitCodeFor,
  isOk,
  build,
  begin,
  emitted,
  emit,
  result,
  fromAssociationOutcome,
  statusDetail,
  fromStatus,
  fromError,
  peerOf,
  readExpectation,
  evaluateExpectation,
  resolveExitCode,
  describeExpectation,
  guard,
  help,
};
