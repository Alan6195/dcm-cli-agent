'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const log = require('./log');

/**
 * Locating and initialising the codecs WebAssembly module.
 *
 * Compressed transfer syntaxes (JPEG, JPEG-LS, JPEG 2000, RLE) need the
 * dcmjs-codecs WebAssembly module to decode or transcode. Everything else —
 * association handling, uncompressed transfer syntaxes, and the whole of
 * C-ECHO and C-FIND — works without it.
 *
 * That distinction drives the design here: initialisation is best-effort and
 * never fatal. A tool that refused to run C-ECHO because it could not find a
 * codec would be useless in exactly the situation people reach for it.
 *
 * The module is found in one of three ways, in order:
 *
 *   1. As an embedded SEA asset, when running as the single executable.
 *      Initialisation only accepts a filesystem path, not bytes, so the asset
 *      is written to a temp file and that path is handed over.
 *   2. Next to the executable, for anyone who prefers to ship the .wasm
 *      alongside the binary rather than inside it.
 *   3. From node_modules, which is the normal development path.
 */

const ASSET_NAME = 'dcmjs-native-codecs.wasm';

/** Cached result, so repeated calls in one process do no extra work. */
let initialised;

/** @returns {object|undefined} The node:sea module when running as a SEA. */
function seaModule() {
  try {
    // eslint-disable-next-line global-require
    const sea = require('node:sea');
    return sea.isSea() ? sea : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the embedded asset to a temp file and returns its path.
 *
 * The filename includes a hash of the contents so that a rebuilt binary does
 * not reuse a stale extraction, and so several versions can coexist.
 *
 * @param {object} sea
 * @returns {string|undefined}
 */
function extractFromSea(sea) {
  let buffer;
  try {
    const asset = sea.getAsset(ASSET_NAME);
    buffer = Buffer.from(asset);
  } catch (err) {
    log.debug(`no embedded ${ASSET_NAME} asset: ${err.message}`);
    return undefined;
  }

  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'dcm-cli-codecs');
  const target = path.join(dir, `${digest}-${ASSET_NAME}`);

  try {
    if (fs.existsSync(target) && fs.statSync(target).size === buffer.length) {
      log.debug(`reusing extracted codecs at ${target}`);
      return target;
    }
    fs.mkdirSync(dir, { recursive: true });
    // Write to a unique temp name then rename, so two concurrent invocations
    // cannot leave a half-written file behind for the other to load.
    const staging = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(staging, buffer);
    fs.renameSync(staging, target);
    log.debug(`extracted codecs to ${target}`);
    return target;
  } catch (err) {
    log.debug(`could not extract codecs to disk: ${err.message}`);
    return undefined;
  }
}

/** @returns {string|undefined} Path to a .wasm sitting beside the executable. */
function findBesideExecutable() {
  try {
    const candidate = path.join(path.dirname(process.execPath), ASSET_NAME);
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** @returns {string|undefined} Path to the .wasm inside node_modules. */
function findInNodeModules() {
  try {
    return require.resolve(`dcmjs-codecs/build/${ASSET_NAME}`);
  } catch {
    return undefined;
  }
}

/**
 * Resolves a filesystem path to the codecs module, or undefined.
 *
 * @returns {string|undefined}
 */
function locate() {
  const sea = seaModule();
  if (sea) {
    const extracted = extractFromSea(sea);
    if (extracted) return extracted;
  }

  const beside = findBesideExecutable();
  if (beside) {
    log.debug(`using codecs beside the executable: ${beside}`);
    return beside;
  }

  const inModules = findInNodeModules();
  if (inModules) {
    log.debug(`using codecs from node_modules: ${inModules}`);
    return inModules;
  }

  return undefined;
}

/**
 * Initialises transcoding if the codecs module can be found.
 *
 * Always resolves. The boolean says whether compressed transfer syntaxes are
 * available; callers that hit a compressed syntax without it should say so
 * plainly rather than failing with a decode error.
 *
 * @param {object} Transcoding The Transcoding export from dcmjs-dimse.
 * @returns {Promise<boolean>}
 */
async function initialize(Transcoding) {
  if (initialised !== undefined) return initialised;

  if (Transcoding.isInitialized()) {
    initialised = true;
    return true;
  }

  const wasmPath = locate();
  if (!wasmPath) {
    log.debug(
      `${ASSET_NAME} not found; compressed transfer syntaxes cannot be transcoded. ` +
        'Uncompressed syntaxes are unaffected.'
    );
    initialised = false;
    return false;
  }

  try {
    await Transcoding.initializeAsync({
      webAssemblyModulePathOrUrl: wasmPath,
      logCodecsInfo: log.isVerbose(),
    });
    initialised = Transcoding.isInitialized();
    log.debug(`transcoding initialised (${initialised})`);
    return initialised;
  } catch (err) {
    log.debug(`transcoding unavailable: ${err.message}`);
    initialised = false;
    return false;
  }
}

/**
 * Notes in the log that a compressed syntax was seen without codec support.
 *
 * @param {string} transferSyntaxUid
 */
function warnUnavailable(transferSyntaxUid) {
  log.warn(
    `transfer syntax ${transferSyntaxUid} is compressed, but the codecs module could ` +
      'not be loaded, so it cannot be transcoded. It will be sent as-is; if the peer ' +
      'does not accept this syntax the instance will be refused.'
  );
}

module.exports = { initialize, locate, warnUnavailable, ASSET_NAME };
