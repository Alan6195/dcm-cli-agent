'use strict';

const crypto = require('crypto');

const { UUID_ROOT, MAX_UID_LENGTH } = require('./uid');

/**
 * Keyed pseudonyms for de-identification.
 *
 * `dcm anon` used to derive every pseudonym — PatientID → ANONxxxxxxxxxx, and
 * every replacement UID — from an UNKEYED SHA-256 over a salt written in this
 * (public) source. Anyone holding the output could therefore recompute the
 * mapping: an 8-digit MRN space is 10^8 hashes, seconds on a laptop, and an
 * original Study Instance UID seen anywhere else could be linked to its
 * replacement by hashing it. A pseudonym that can be inverted is not a
 * pseudonym.
 *
 * Everything here is HMAC-SHA256 under a secret key instead:
 *
 *   - DCM_ANON_KEY, when set. A team that shares the value gets the same
 *     pseudonyms on every run and every machine, so two exports of one patient
 *     still line up.
 *   - Otherwise 32 random bytes, generated once per run. Every file in that run
 *     is mapped under the one key — the same patient, study and series across
 *     files still map to the same pseudonym — but two runs cannot be linked to
 *     each other, or back to the source.
 *
 * The key is never printed or written anywhere.
 *
 * Each use has its own domain label, so a PatientID and a UID that happen to
 * share a string cannot be correlated through their pseudonyms.
 */

const KEY_ENV = 'DCM_ANON_KEY';

const DOMAIN = {
  uid: 'dcm-cli:anon:v2:uid',
  id: 'dcm-cli:anon:v2:id',
  date: 'dcm-cli:anon:v2:date',
};

/** Shortest passphrase accepted without a warning. */
const MIN_ENV_KEY_LENGTH = 16;

/** Date shifts fall in this many days into the past, inclusive. */
const SHIFT_MIN_DAYS = 365;
const SHIFT_MAX_DAYS = 3652;

/**
 * The key for one run.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{key: Buffer, source: 'env'|'random', weak: boolean}}
 */
function resolveKey(env = process.env) {
  const fromEnv = env[KEY_ENV];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { key: Buffer.from(fromEnv, 'utf8'), source: 'env', weak: fromEnv.length < MIN_ENV_KEY_LENGTH };
  }
  return { key: crypto.randomBytes(32), source: 'random', weak: false };
}

/** One line for the command's output describing where the key came from. Never the key. */
function describeKeySource(source) {
  return source === 'env'
    ? `from ${KEY_ENV} (repeatable across runs that share it)`
    : `random for this run (set ${KEY_ENV} for repeatable output)`;
}

function hmac(key, domain, value) {
  return crypto.createHmac('sha256', key).update(domain).update('\0').update(String(value), 'utf8').digest();
}

/**
 * Builds the pseudonym functions for one key.
 *
 * @param {Buffer} key
 */
function createPseudonymiser(key) {
  if (!Buffer.isBuffer(key) || key.length === 0) {
    throw new Error('createPseudonymiser needs a non-empty key Buffer');
  }

  /** Replacement UID of the form 2.25.<decimal of 128 bits>. */
  function uid(sourceUid) {
    const digest = hmac(key, DOMAIN.uid, sourceUid);
    let value = 0n;
    for (let i = 0; i < 16; i++) value = (value << 8n) | BigInt(digest[i]);
    const out = `${UUID_ROOT}.${value.toString(10)}`;
    if (out.length > MAX_UID_LENGTH) throw new Error(`Generated UID exceeds ${MAX_UID_LENGTH} characters`);
    return out;
  }

  /** A fixed-width string of decimal digits, uniformly distributed. */
  function digits(value, width = 10) {
    const digest = hmac(key, DOMAIN.id, value);
    const n = digest.readBigUInt64BE(0) % 10n ** BigInt(width);
    return n.toString(10).padStart(width, '0');
  }

  /**
   * Days to shift a patient's dates by: always into the past, between one and
   * ten years, and the same for every file of that patient so intervals
   * between studies survive.
   */
  function dayOffset(patientKey) {
    const digest = hmac(key, DOMAIN.date, patientKey);
    const span = SHIFT_MAX_DAYS - SHIFT_MIN_DAYS + 1;
    return -(SHIFT_MIN_DAYS + (digest.readUInt32BE(0) % span));
  }

  return { uid, digits, dayOffset };
}

module.exports = {
  KEY_ENV,
  SHIFT_MIN_DAYS,
  SHIFT_MAX_DAYS,
  resolveKey,
  describeKeySource,
  createPseudonymiser,
};
