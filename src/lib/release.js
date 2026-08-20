'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { version } = require('../../package.json');

/**
 * Reading GitHub Releases, and downloading an asset from one.
 *
 * This deliberately does not go through `lib/webdicom.js`. That module is the
 * DICOMweb transport and is wrong here three times over: it does not follow
 * redirects at all (an asset URL answers 302 to a CDN host, so the caller would
 * get an empty body and a 302), it buffers the whole response into one Buffer
 * (a ~90 MB executable, doubled by the final `Buffer.concat`), and every error
 * it produces is worded about PACS peers. A failed update dressed up as a
 * failed C-STORE would be worse than no message at all.
 *
 * The global `fetch` is used instead. It follows the CDN redirect, it drops the
 * Authorization header across an origin change so a token can never reach the
 * CDN, and its body is a stream, so the download is hashed and written to disk
 * in one pass at constant memory.
 *
 * Note: neither `fetch` nor anything else here honours HTTP_PROXY. Behind a
 * hospital proxy these calls simply fail to reach GitHub, which is why the
 * network error text names a proxy as a possibility rather than only "offline".
 */

const DEFAULT_REPO = 'Alan6195/dcm-cli-agent';

/** GitHub rejects API requests without a User-Agent. */
const USER_AGENT = `dcm-cli-agent/${version}`;

/** A failure with enough structure for the caller to word it usefully. */
class ReleaseError extends Error {
  /**
   * @param {string} message
   * @param {'network'|'not-found'|'rate-limited'|'http'|'empty'} kind
   */
  constructor(message, kind) {
    super(message);
    this.name = 'ReleaseError';
    this.kind = kind;
  }
}

/**
 * The API URL for a release.
 *
 * @param {string} repo   `owner/name`.
 * @param {string} [tag]  A tag such as `v0.9.0`. Omit for the latest release.
 * @returns {string}
 */
function apiUrl(repo, tag) {
  const base = `https://api.github.com/repos/${repo}/releases`;
  return tag ? `${base}/tags/${encodeURIComponent(tag)}` : `${base}/latest`;
}

/**
 * Turns a transport-level failure into one sentence a person can act on.
 *
 * `fetch` reports the real cause on `err.cause`, and the bare message
 * ("fetch failed") says nothing at all, so the code is dug out and named.
 *
 * @param {Error} err
 * @returns {string}
 */
function describeNetworkError(err) {
  const code = err?.cause?.code ?? err?.code;
  const name = err?.name;

  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ABORT_ERR') {
    return 'GitHub did not answer in time';
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'could not resolve api.github.com — no DNS, or no network';
    case 'ECONNREFUSED':
      return 'the connection to GitHub was refused';
    case 'ECONNRESET':
      return 'the connection to GitHub was reset mid-request';
    case 'ETIMEDOUT':
      return 'the connection to GitHub timed out';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `the TLS certificate could not be verified (${code}) — something is intercepting the connection`;
    default:
      return err?.cause?.message ?? err?.message ?? String(err);
  }
}

/** Headers every call sends. A token is added only for api.github.com. */
function baseHeaders(extra = {}) {
  return { 'User-Agent': USER_AGENT, ...extra };
}

/**
 * Classifies a non-2xx answer from the GitHub API.
 *
 * The rate limit is the one worth separating: it is the failure someone on a
 * shared clinic IP hits, and the fix (a token) is not guessable from a bare
 * "403".
 */
function httpError(res, url) {
  if (res.status === 404) {
    return new ReleaseError(`GitHub has no such release (404 for ${url})`, 'not-found');
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  if ((res.status === 403 || res.status === 429) && remaining === '0') {
    return new ReleaseError('GitHub rate limit reached for this IP address', 'rate-limited');
  }
  return new ReleaseError(`GitHub answered ${res.status} ${res.statusText || ''}`.trim(), 'http');
}

/**
 * Fetches one release's metadata.
 *
 * `/releases/latest` excludes drafts and prereleases server-side, so the
 * default path cannot pick up a release candidate; that is only reachable by
 * naming its tag.
 *
 * @param {object} opts
 * @param {string} [opts.repo]
 * @param {string} [opts.tag]
 * @param {string} [opts.token]     Raises the anonymous rate limit.
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl] Injected in tests.
 * @returns {Promise<object>} The release JSON.
 */
async function getRelease(opts = {}) {
  const {
    repo = DEFAULT_REPO,
    tag,
    token,
    timeoutMs = 15000,
    fetchImpl = globalThis.fetch,
  } = opts;

  const url = apiUrl(repo, tag);
  const headers = baseHeaders({ Accept: 'application/vnd.github+json' });
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ReleaseError(describeNetworkError(err), 'network');
  }

  if (!res.ok) throw httpError(res, url);

  try {
    return await res.json();
  } catch (err) {
    throw new ReleaseError(`GitHub's answer was not JSON: ${err.message}`, 'http');
  }
}

/**
 * Fetches a small text asset — SHA256SUMS.txt, and nothing larger.
 *
 * Buffering is fine here and only here: the checksum file is a few hundred
 * bytes. The binary itself goes through `downloadTo`.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, fetchImpl?: Function}} [opts]
 * @returns {Promise<string>}
 */
async function fetchText(url, opts = {}) {
  const { timeoutMs = 30000, fetchImpl = globalThis.fetch } = opts;

  let res;
  try {
    res = await fetchImpl(url, {
      headers: baseHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ReleaseError(describeNetworkError(err), 'network');
  }

  if (!res.ok) throw httpError(res, url);
  return res.text();
}

/**
 * Streams a release asset to disk, hashing it on the way past.
 *
 * The hash is computed in the same pass as the write, so verification costs no
 * second read of a 90 MB file and the whole thing never exists in memory.
 *
 * The deadline is a stall watchdog rather than a whole-request timeout: a
 * hospital link that manages 200 KB/s is slow but healthy, and killing it at a
 * flat 60 seconds would make the update impossible on exactly the networks this
 * tool is built for. Silence is the thing worth giving up on.
 *
 * @param {string} url
 * @param {string} dest
 * @param {object} [opts]
 * @param {number} [opts.stallMs]   Silence tolerated before aborting.
 * @param {Function} [opts.onProgress] (bytesSoFar, totalBytesOrZero)
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{sha256: string, bytes: number, expectedBytes: number}>}
 */
async function downloadTo(url, dest, opts = {}) {
  const { stallMs = 30000, onProgress, fetchImpl = globalThis.fetch } = opts;

  const controller = new AbortController();
  let watchdog = null;
  const arm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      controller.abort(new Error(`no data for ${Math.round(stallMs / 1000)}s`));
    }, stallMs);
    // Never let the watchdog be the reason the process stays alive.
    if (typeof watchdog.unref === 'function') watchdog.unref();
  };

  try {
    arm();

    let res;
    try {
      res = await fetchImpl(url, {
        headers: baseHeaders(),
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      throw new ReleaseError(describeNetworkError(err), 'network');
    }

    if (!res.ok) throw httpError(res, url);
    if (!res.body) throw new ReleaseError('the download returned no body', 'empty');

    const expectedBytes = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    // A pass-through Transform rather than a 'data' listener: the listener
    // would put the stream into flowing mode before the pipeline attaches its
    // own destination, which is a good way to lose the first chunk.
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        arm();
        if (onProgress) onProgress(bytes, expectedBytes);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      throw new ReleaseError(describeNetworkError(err), 'network');
    }

    return { sha256: hash.digest('hex'), bytes, expectedBytes };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

module.exports = {
  DEFAULT_REPO,
  ReleaseError,
  apiUrl,
  describeNetworkError,
  getRelease,
  fetchText,
  downloadTo,
};
