'use strict';

/**
 * Version parsing and ordering for release tags.
 *
 * `dcm update` compares a tag from GitHub (`v0.9.0`) against the version baked
 * into this build (`0.8.0`), and the answer decides whether a 90 MB binary gets
 * downloaded and swapped in. That makes it worth doing properly rather than
 * with a `split('.')` and a `parseInt`.
 *
 * The desktop app has its own comparison in `desktop/main.js`, which parses
 * with `parseInt` and so reads `0.9.0-rc.1` as exactly `0.9.0` — a prerelease
 * and its release compare as identical. It gets away with that by separately
 * checking the release's `prerelease` flag. This module orders a prerelease
 * below the release it precedes instead, which is the rule everyone already
 * expects from semver, so `--version v0.9.0-rc.1` behaves sensibly.
 *
 * Deliberately not a semver library: no ranges, no caret matching. Two
 * versions, one ordering.
 */

/** Major[.minor[.patch]] — the shape every tag in this project has. */
const CORE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Splits a version string into its numeric core and prerelease suffix.
 *
 * @param {string} input A tag (`v0.9.0`) or a bare version (`0.9.0-rc.1`).
 * @returns {{valid: boolean, raw: string, numbers: number[], prerelease: string|null}}
 */
function parse(input) {
  const raw = String(input ?? '').trim();

  // Build metadata (`+build.7`) carries no ordering information at all, so it
  // is discarded before anything else looks at the string.
  const withoutMetadata = raw.split('+')[0];
  const body = withoutMetadata.replace(/^[vV]/, '');

  const dash = body.indexOf('-');
  const core = dash === -1 ? body : body.slice(0, dash);
  const suffix = dash === -1 ? '' : body.slice(dash + 1);

  const match = CORE.exec(core);
  if (!match) {
    return { valid: false, raw, numbers: [0, 0, 0], prerelease: suffix || null };
  }

  return {
    valid: true,
    raw,
    numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: suffix === '' ? null : suffix,
  };
}

/**
 * The version without its `v` prefix or build metadata.
 *
 * Used for reporting and for the `--json` document, so that a tag and a
 * `--version` string are never printed in two different spellings of the same
 * release.
 *
 * @param {string} input
 * @returns {string}
 */
function normalize(input) {
  const parsed = parse(input);
  if (!parsed.valid) return String(input ?? '').trim();
  return parsed.numbers.join('.') + (parsed.prerelease ? `-${parsed.prerelease}` : '');
}

/**
 * Orders two prerelease suffixes the way semver does: dot-separated
 * identifiers, numeric ones compared as numbers and ranked below alphanumeric
 * ones, and a shorter run of otherwise-equal identifiers ranking lower.
 *
 * Comparing the identifiers numerically is what puts `rc.2` below `rc.10`. A
 * plain string comparison would put them the other way round and report the
 * older prerelease as the newer one.
 */
function comparePrerelease(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two versions.
 *
 * Throws rather than guessing when either side is not a version. A tag this
 * cannot read is a reason to stop and say so — silently treating it as `0.0.0`
 * would either offer a downgrade or hide a real release.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a < b, 0 when equal, positive when a > b.
 */
function compare(a, b) {
  const left = parse(a);
  const right = parse(b);
  if (!left.valid) throw new Error(`"${left.raw}" is not a version this can compare`);
  if (!right.valid) throw new Error(`"${right.raw}" is not a version this can compare`);

  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) {
      return left.numbers[i] < right.numbers[i] ? -1 : 1;
    }
  }

  // Same numbers. A prerelease comes before the release it leads up to, so
  // 0.9.0-rc.1 < 0.9.0, and an installed 0.9.0-rc.1 sees 0.9.0 as an update.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * True when `remote` is a later version than `local`.
 *
 * @param {string} remote
 * @param {string} local
 * @returns {boolean}
 */
function isNewer(remote, local) {
  return compare(remote, local) > 0;
}

module.exports = { parse, normalize, compare, isNewer };
