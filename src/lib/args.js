'use strict';

/**
 * A small, dependency-free argument parser.
 *
 * Deliberately not a general-purpose CLI framework. It supports exactly what
 * this tool needs, which keeps the single-executable bundle small and keeps
 * the dependency surface of a tool that talks to clinical networks close to
 * zero.
 *
 * Connection details resolve in the order: flag, then environment variable,
 * then default. Nothing is ever read from a config file on disk, so a repo
 * checkout can never carry someone's hostnames or AE Titles.
 */

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Splits argv into flags, positionals and bare `key=value` pairs.
 *
 * `key=value` pairs are how `dcm find` takes DICOM matching keys, so they must
 * survive parsing as data rather than being mistaken for flags.
 *
 * @param {string[]} argv
 * @returns {{flags: Map<string, string|boolean|string[]>, positionals: string[], pairs: Array<[string,string]>}}
 */
function tokenize(argv) {
  const flags = new Map();
  const positionals = [];
  const pairs = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');

      if (eq !== -1) {
        setFlag(flags, body.slice(0, eq), body.slice(eq + 1));
        continue;
      }

      // A flag takes the next token as its value unless that token is another
      // flag, a `key=value` pair, or absent. Otherwise it is boolean.
      //
      // Excluding `key=value` matters: `dcm find --study PatientID=12345` must
      // not consume the matching key as the value of --study. Without this,
      // the query key disappears silently and the peer is asked a different
      // question than the one that was typed.
      const next = argv[i + 1];
      const takesPair = PAIR_VALUED_FLAGS.has(body);
      if (next === undefined || next.startsWith('--') || (looksLikePair(next) && !takesPair)) {
        setFlag(flags, body, true);
      } else {
        setFlag(flags, body, next);
        i += 1;
      }
      continue;
    }

    // Bare `key=value`, e.g. PatientID=12345 for a C-FIND.
    const eq = token.indexOf('=');
    if (eq > 0 && !token.startsWith('-')) {
      pairs.push([token.slice(0, eq), token.slice(eq + 1)]);
      continue;
    }

    positionals.push(token);
  }

  return { flags, positionals, pairs };
}

/**
 * True for a bare `Keyword=value` token — the form C-FIND and QIDO matching
 * keys take.
 *
 * DICOM keywords are alphanumeric and start with a letter, which is specific
 * enough to distinguish a matching key from an ordinary flag value such as a
 * hostname or a path. An 8-hex-digit tag (`00100020=12345`) is the other legal
 * spelling of the same thing, and it has to be recognised here too: without
 * it `dcm web query --series 00100020=12345` lets --series swallow the key,
 * and the peer is asked a different question than the one that was typed —
 * the exact failure the keyword form is guarded against above.
 */
function looksLikePair(token) {
  return /^([A-Za-z][A-Za-z0-9]*|[0-9A-Fa-f]{8})=/.test(token);
}

/**
 * Flags whose value is legitimately `Key=Value` shaped.
 *
 * Two commands want opposite things from the same token. `dcm find --study
 * PatientID=12345` needs the pair left alone as a matching key, or the query
 * silently loses it. `dcm edit --set PatientID=TEST001` needs the pair consumed
 * as the flag's value, or the edit silently does nothing. A general rule cannot
 * satisfy both, so the flags that take pair-shaped values are named here.
 *
 * `--require-token` is here for a subtler reason: a base64 token carries `=`
 * padding, so `--require-token abc123==` is pair-shaped by accident and the
 * hub would refuse to start with "expects a value".
 */
const PAIR_VALUED_FLAGS = new Set(['set', 'remove', 'filter', 'value', 'require-token']);

/** Repeated flags accumulate into an array rather than clobbering. */
function setFlag(flags, name, value) {
  if (!flags.has(name)) {
    flags.set(name, value);
    return;
  }
  const existing = flags.get(name);
  if (Array.isArray(existing)) existing.push(value);
  else flags.set(name, [existing, value]);
}

/**
 * Resolves a value from flags, then environment, then a default.
 *
 * @param {Map} flags
 * @param {object} spec
 * @param {string} spec.name       Flag name without leading dashes.
 * @param {string} [spec.env]      Environment variable to fall back to.
 * @param {*} [spec.fallback]      Value when neither flag nor env is present.
 * @param {boolean} [spec.required]
 * @param {'string'|'number'|'boolean'} [spec.type]
 * @param {string} [spec.describe] Used in error messages.
 * @returns {*}
 */
function resolve(flags, spec) {
  const { name, env, fallback, required, type = 'string', describe } = spec;
  let value = flags.has(name) ? flags.get(name) : undefined;
  let origin = 'flag';

  if (Array.isArray(value)) {
    throw new UsageError(`--${name} was given more than once.`);
  }

  if (value === undefined && env && process.env[env] !== undefined && process.env[env] !== '') {
    value = process.env[env];
    origin = 'env';
  }

  if (value === undefined) {
    if (required) {
      const envHint = env ? ` (or set ${env})` : '';
      throw new UsageError(`Missing required option --${name}${envHint}${describe ? ` — ${describe}` : ''}.`);
    }
    return fallback;
  }

  if (type === 'boolean') {
    if (value === true) return true;
    const v = String(value).toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    throw new UsageError(`--${name} expects true or false, got "${value}".`);
  }

  if (value === true) {
    throw new UsageError(`--${name} expects a value.`);
  }

  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new UsageError(`--${name} expects a number, got "${value}"${origin === 'env' ? ` (from ${env})` : ''}.`);
    }
    return n;
  }

  return String(value);
}

/**
 * Validates an AE Title against the DICOM constraints that actually bite:
 * 16 characters maximum, no backslash, no control characters, not all spaces.
 *
 * AE Titles are case-sensitive on most receivers, so this does not normalise
 * case — silently upper-casing someone's AE Title would cause exactly the kind
 * of "registered but still rejected" confusion this tool is meant to prevent.
 *
 * @param {string} value
 * @param {string} flagName
 * @returns {string}
 */
function validateAeTitle(value, flagName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${flagName} must be a non-empty AE Title.`);
  }
  if (value.length > 16) {
    throw new UsageError(
      `--${flagName} is ${value.length} characters; DICOM AE Titles are limited to 16. ` +
        `Receivers usually truncate or reject silently, which looks like an allowlist problem.`
    );
  }
  if (/[\\\x00-\x1f]/.test(value)) {
    throw new UsageError(`--${flagName} contains a backslash or control character, which DICOM does not permit in an AE Title.`);
  }
  return value;
}

/**
 * Validates a TCP port.
 *
 * @param {number} value
 * @param {string} flagName
 * @returns {number}
 */
function validatePort(value, flagName) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new UsageError(`--${flagName} must be an integer between 1 and 65535, got "${value}".`);
  }
  return value;
}

/**
 * Rejects unknown flags so a typo fails loudly instead of being ignored.
 *
 * A silently-ignored `--dry-run` typo would send data for real, so this is a
 * safety measure rather than a nicety.
 *
 * @param {Map} flags
 * @param {string[]} known
 */
function rejectUnknown(flags, known) {
  const allowed = new Set([...known, 'help', 'verbose', 'quiet', 'json', 'no-color']);
  const unknown = [...flags.keys()].filter((k) => !allowed.has(k));
  if (unknown.length) {
    const list = unknown.map((u) => `--${u}`).join(', ');
    const suggestion = suggest(unknown[0], [...allowed]);
    throw new UsageError(
      `Unknown option${unknown.length > 1 ? 's' : ''}: ${list}.` +
        (suggestion ? ` Did you mean --${suggestion}?` : '')
    );
  }
}

/** Cheap edit-distance suggestion for a mistyped flag. */
function suggest(given, candidates) {
  let best;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = levenshtein(given, c);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore <= 3 ? best : undefined;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[n];
}

module.exports = {
  UsageError,
  tokenize,
  resolve,
  validateAeTitle,
  validatePort,
  rejectUnknown,
};
