'use strict';

/**
 * DICOMweb plumbing shared by the `dcm web` commands (PS3.18).
 *
 * Everything HTTP lives here so the command modules can stay about DICOM:
 * option resolution, the request primitive, URL and query construction,
 * multipart/related in both directions, failure translation, and the small
 * amount of DICOM JSON handling QIDO/STOW responses need.
 *
 * Built on node:http/node:https only. A DICOMweb client from core modules
 * keeps the dependency surface of a tool that talks to clinical networks
 * close to zero, same reasoning as args.js.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const args = require('./args');
const log = require('./log');

const CRLF = Buffer.from('\r\n');

/**
 * DICOM JSON tags this module and the web commands care about, by their
 * 8-hex-digit group+element form (the keys DICOM JSON uses).
 */
const TAGS = Object.freeze({
  STUDY_UID: '0020000D',
  SERIES_UID: '0020000E',
  SOP_UID: '00080018',
  SOP_CLASS: '00080016',
  REFERENCED_SOP_SEQ: '00081199',
  FAILED_SOP_SEQ: '00081198',
  REF_SOP_CLASS: '00081150',
  REF_SOP_INSTANCE: '00081155',
  FAILURE_REASON: '00081197',
  WARNING_REASON: '00081196',
  RETRIEVE_URL: '00081190',
});

// The cleartext warning fires once per process, not once per request — a
// QIDO-then-WADO run would otherwise nag on every association-equivalent.
let warnedCleartextHttp = false;

/**
 * Resolves the shared DICOMweb connection options.
 *
 * The base URL follows the usual flag → env → default order. Credentials do
 * not: they come from the environment only, mirroring how `dcm explain`
 * handles ANTHROPIC_API_KEY. A --token or --pass flag would put secrets in
 * shell history and process listings, which is exactly where PACS
 * credentials must not end up.
 *
 * @param {Map} flags Parsed flags from args.tokenize.
 * @returns {{baseUrl: string, headers: object, timeoutMs: number, insecure: boolean, authSource: 'bearer'|'basic'|'none'}}
 */
function resolveWebOptions(flags) {
  const raw = args.resolve(flags, {
    name: 'url',
    env: 'DCM_WEB_URL',
    required: true,
    describe: 'the DICOMweb base URL, e.g. https://pacs.example.org/dicom-web',
  });

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new args.UsageError(
      `--url is not a valid URL: "${raw}". Expected something like https://pacs.example.org/dicom-web.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new args.UsageError(
      `--url must start with http:// or https://, got "${parsed.protocol}//". DICOMweb is HTTP.`
    );
  }

  // A trailing slash would produce double slashes once paths are joined on,
  // and some servers 404 on `//studies` rather than normalising it.
  const baseUrl = raw.replace(/\/+$/, '');

  const headers = {};
  let authSource = 'none';
  if (process.env.DCM_WEB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.DCM_WEB_TOKEN}`;
    authSource = 'bearer';
  } else if (process.env.DCM_WEB_USER && process.env.DCM_WEB_PASS) {
    const pair = `${process.env.DCM_WEB_USER}:${process.env.DCM_WEB_PASS}`;
    headers.Authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
    authSource = 'basic';
  } else if (process.env.DCM_WEB_USER || process.env.DCM_WEB_PASS) {
    // Half-set Basic credentials would otherwise be silently ignored, and the
    // resulting 401 sends you looking at the server rather than at the one
    // variable you forgot to export.
    const missing = process.env.DCM_WEB_USER ? 'DCM_WEB_PASS' : 'DCM_WEB_USER';
    log.warn(`${missing} is not set, so HTTP Basic is incomplete — the request will be sent unauthenticated.`);
  }

  const timeoutMs = args.resolve(flags, {
    name: 'timeout',
    env: 'DCM_WEB_TIMEOUT',
    fallback: 60000,
    type: 'number',
  });

  let insecure = args.resolve(flags, { name: 'insecure', type: 'boolean', fallback: false });
  if (insecure) {
    if (parsed.protocol === 'https:') {
      log.warn(
        '--insecure disables TLS certificate verification. Anyone on the network path can ' +
          'read and alter this traffic; use only against servers you control, e.g. self-signed test setups.'
      );
    } else {
      log.warn('--insecure has no effect on an http:// URL; there is no certificate to skip verifying.');
      insecure = false;
    }
  }

  // Cleartext HTTP to anything beyond this machine means credentials and PHI
  // travel unencrypted. Local loopback is the legitimate exception (tests,
  // tunnels, sidecar proxies), so it stays quiet.
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (parsed.protocol === 'http:' && !localHosts.has(parsed.hostname) && !warnedCleartextHttp) {
    warnedCleartextHttp = true;
    log.warn(
      `${parsed.hostname} is being contacted over cleartext http:// — credentials and patient ` +
        'data will travel unencrypted. Prefer an https:// base URL.'
    );
  }

  return { baseUrl, headers, timeoutMs, insecure, authSource };
}

/**
 * One HTTP request, promisified over node:http/node:https.
 *
 * The timeout covers the whole request — connect, send, and the full response
 * — because a WADO retrieve that connects instantly and then stalls
 * mid-download is every bit as stuck as one that never connects. On expiry
 * the socket is destroyed and the rejection carries code 'DCM_WEB_TIMEOUT'
 * so callers can tell silence apart from an answer, the same distinction
 * reject.js draws for DIMSE.
 *
 * The response body is always buffered in full. Retrieve responses are
 * bounded by study size, which for v1 is an acceptable ceiling; if
 * multi-gigabyte studies become routine this is the seam where a streaming
 * parser would slot in.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.url Absolute URL.
 * @param {object} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.insecure] Skip TLS certificate verification (https only).
 * @param {Buffer|string} [opts.body]
 * @param {import('stream').Readable} [opts.bodyStream] Piped as the request body (STOW uploads).
 * @returns {Promise<{status: number, statusMessage: string, headers: object, body: Buffer}>}
 */
function webRequest({ method, url, headers = {}, timeoutMs = 60000, insecure = false, body, bodyStream }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;

    const options = { method, headers };
    if (target.protocol === 'https:' && insecure) options.rejectUnauthorized = false;

    const requestContentType = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'content-type'
    )?.[1];
    log.debug(`${method} ${url}`);
    if (requestContentType) log.debug(`request content-type: ${requestContentType}`);

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const req = transport.request(target, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log.debug(
          `response ${res.statusCode} ${res.statusMessage ?? ''} (${res.headers['content-type'] ?? 'no content-type'})`
        );
        resolve({
          status: res.statusCode,
          statusMessage: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    const timer = setTimeout(() => {
      const err = new Error(`No complete response from ${target.host} within ${timeoutMs} ms.`);
      err.code = 'DCM_WEB_TIMEOUT';
      req.destroy(err);
      fail(err);
    }, timeoutMs);

    // Connection-level failures (ECONNREFUSED, ENOTFOUND, TLS errors) arrive
    // here with their code intact; callers translate them, we just preserve.
    req.on('error', fail);

    if (bodyStream) {
      bodyStream.once('error', (err) => {
        req.destroy(err);
        fail(err);
      });
      bodyStream.pipe(req);
    } else {
      if (body !== undefined) req.write(body);
      req.end();
    }
  });
}

/**
 * Joins path segments onto a base URL with each segment percent-encoded.
 *
 * Encoding per segment matters because study/series/SOP UIDs go straight
 * into the path; a stray character in one must not be able to change the
 * route. A base path like https://host/dicom-web survives intact.
 *
 * @param {string} base
 * @param {...(string|number)} segments
 * @returns {string}
 */
function joinUrl(base, ...segments) {
  let url = String(base).replace(/\/+$/, '');
  for (const segment of segments) {
    url += `/${encodeURIComponent(String(segment))}`;
  }
  return url;
}

/**
 * Builds a QIDO-RS query string from tokenizer pairs plus paging options.
 *
 * @param {Array<[string, string]>} pairs Matching keys straight from args.tokenize.
 * @param {{limit?: number, offset?: number, includefields?: string[]}} [opts]
 * @returns {string} '?k=v&…' fully encoded, or '' when there is nothing to send.
 */
function buildQuery(pairs = [], opts = {}) {
  const { limit, offset, includefields } = opts;
  const params = [];

  for (const [key, value] of pairs) {
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  // PS3.18 wants one includefield parameter per attribute, not a joined list.
  if (Array.isArray(includefields)) {
    for (const field of includefields) {
      params.push(`includefield=${encodeURIComponent(field)}`);
    }
  }
  if (limit !== undefined) params.push(`limit=${encodeURIComponent(limit)}`);
  if (offset !== undefined) params.push(`offset=${encodeURIComponent(offset)}`);

  return params.length ? `?${params.join('&')}` : '';
}

/**
 * Builds a multipart/related request body for STOW-RS.
 *
 * The returned stream yields each part's headers and then its bytes strictly
 * in sequence, pulling each part's stream only when its turn comes. Nothing
 * is buffered whole: a 200-instance CT study flows through at chunk size,
 * the same memory-flat property the DIMSE send path gets from chunking.
 * That is the point of taking getStream() factories rather than buffers.
 *
 * contentLength is computed exactly from the declared part lengths so the
 * request can carry a Content-Length header — some servers refuse chunked
 * transfer encoding on STOW.
 *
 * @param {Array<{contentType: string, getStream: () => import('stream').Readable, length: number, location?: string}>} parts
 * @returns {{contentType: string, stream: import('stream').Readable, contentLength?: number}}
 */
function buildMultipartRelated(parts) {
  // A UUID-derived boundary cannot realistically collide with DICOM bytes.
  const boundary = `dcm-boundary-${crypto.randomUUID()}`;
  const contentType = `multipart/related; type="application/dicom"; boundary="${boundary}"`;

  const headerBlocks = parts.map((part) => {
    let head = `--${boundary}\r\nContent-Type: ${part.contentType}\r\n`;
    if (part.location) head += `Content-Location: ${part.location}\r\n`;
    head += '\r\n';
    return Buffer.from(head, 'latin1');
  });
  const closing = Buffer.from(`--${boundary}--\r\n`, 'latin1');

  let contentLength = closing.length;
  for (let i = 0; i < parts.length; i++) {
    if (!Number.isFinite(parts[i].length)) {
      contentLength = undefined;
      break;
    }
    contentLength += headerBlocks[i].length + parts[i].length + CRLF.length;
  }

  async function* emit() {
    for (let i = 0; i < parts.length; i++) {
      yield headerBlocks[i];
      for await (const chunk of parts[i].getStream()) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
      yield CRLF;
    }
    yield closing;
  }

  return { contentType, stream: Readable.from(emit()), contentLength };
}

/**
 * Parses a multipart/related response body (WADO-RS retrieves).
 *
 * Deliberately tolerant of what servers actually emit — quoted or bare
 * boundary parameter, preamble before the first boundary, epilogue after the
 * last, padding after a delimiter, mixed-case part headers — but strict
 * about the closing boundary. A body without one is a truncated download,
 * and silently returning the parts found so far would present a partial
 * study as complete.
 *
 * @param {Buffer} bodyBuffer
 * @param {string} contentTypeHeader The response's Content-Type header.
 * @returns {Array<{headers: object, body: Buffer}>} Header keys lowercased.
 */
function parseMultipartRelated(bodyBuffer, contentTypeHeader) {
  const body = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer ?? '');

  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentTypeHeader ?? ''));
  if (!match) {
    throw new Error(
      `The response Content-Type carries no multipart boundary parameter ` +
        `("${contentTypeHeader}"), so the body cannot be split into parts.`
    );
  }
  const boundary = match[1] ?? match[2];
  const delimiter = `--${boundary}`;

  let pos = body.indexOf(delimiter);
  if (pos === -1) {
    throw new Error(
      `The multipart body never contains its own boundary "${boundary}" — the response is malformed or truncated.`
    );
  }

  const parts = [];
  const DASH = 0x2d;
  const SP = 0x20;
  const TAB = 0x09;
  const CR = 0x0d;
  const LF = 0x0a;

  for (;;) {
    let cursor = pos + delimiter.length;

    // '--' straight after the boundary is the closing delimiter; anything
    // beyond it is epilogue and is ignored.
    if (body[cursor] === DASH && body[cursor + 1] === DASH) break;

    // Optional transport padding, then the line break ending the delimiter line.
    while (body[cursor] === SP || body[cursor] === TAB) cursor += 1;
    if (body[cursor] === CR && body[cursor + 1] === LF) cursor += 2;
    else if (body[cursor] === LF) cursor += 1;
    else throw new Error('Malformed multipart body: a boundary delimiter is not followed by a line break.');

    // A part ends at the CRLF that precedes the next delimiter line.
    const next = body.indexOf(`\r\n${delimiter}`, cursor);
    if (next === -1) {
      throw new Error(
        'Malformed multipart body: no closing boundary. The response was likely truncated mid-transfer.'
      );
    }

    const raw = body.slice(cursor, next);

    let headerBlock;
    let bodyStart;
    if (raw[0] === CR && raw[1] === LF) {
      // Empty header section: the part starts with the blank line itself.
      headerBlock = '';
      bodyStart = 2;
    } else {
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        headerBlock = raw.toString('latin1');
        bodyStart = raw.length;
      } else {
        headerBlock = raw.slice(0, headerEnd).toString('latin1');
        bodyStart = headerEnd + 4;
      }
    }

    const headers = {};
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    parts.push({ headers, body: raw.slice(bodyStart) });
    pos = next + 2;
  }

  return parts;
}

/**
 * Translates an HTTP failure status into plain-English lines, in the same
 * spirit as reject.js: say what actually went wrong and where to look, and
 * keep the raw code in brackets for the person grepping server logs.
 *
 * @param {number} status HTTP status code.
 * @param {'ping'|'stow'|'qido'|'wado'} context Which operation failed.
 * @returns {string[]}
 */
function translateHttpFailure(status, context) {
  const lines = [];

  if (status === 401) {
    lines.push('Not authenticated: the server wants credentials it did not receive, or rejected the ones it got.');
    lines.push(
      '  Set DCM_WEB_TOKEN for bearer-token servers, or DCM_WEB_USER and DCM_WEB_PASS for HTTP Basic.'
    );
    lines.push(
      '  Credentials are read from the environment only — never from flags — so they stay out of shell history.'
    );
  } else if (status === 403) {
    lines.push(
      'Not permitted: the credentials were accepted, but this account is not allowed to perform this operation.'
    );
    lines.push(
      '  This is a server-side grant, not something to fix on this end. Ask the server\'s administrator ' +
        `to allow ${context === 'stow' ? 'storage (STOW-RS)' : context === 'qido' ? 'query (QIDO-RS)' : context === 'wado' ? 'retrieve (WADO-RS)' : 'this service'} for your account.`
    );
  } else if (status === 404) {
    lines.push('Not found: the server answered, but nothing lives at this path.');
    lines.push(
      '  Most servers root DICOMweb under a prefix such as /dicom-web — check that the base URL ' +
        '(--url / DCM_WEB_URL) includes it. A bare hostname is usually the web UI, not the API.'
    );
    if (context === 'wado') {
      lines.push('  If the base URL is right, the study UID may simply not exist on this server.');
    }
  } else if (status === 406 || status === 415) {
    lines.push(
      status === 406
        ? 'Content negotiation failed: the server cannot produce the representation this request asked for.'
        : 'Content negotiation failed: the server refused the content type of the request body.'
    );
    if (context === 'stow') {
      lines.push(
        '  The server may not accept multipart/related with type "application/dicom". Check its conformance statement for supported STOW-RS media types.'
      );
    } else {
      lines.push(
        '  The server may not support application/dicom+json or the requested transfer syntax. Check its conformance statement.'
      );
    }
  } else if (status === 413) {
    lines.push('Request too large: the server capped the request body below what was sent.');
    // Only `web send` has --chunk; suggesting it elsewhere sends the reader to
    // a flag their command would reject.
    lines.push(
      context === 'stow'
        ? '  Lower --chunk so each request carries fewer instances.'
        : '  A proxy in front of the server is the usual cause; its body limit is what has to change.'
    );
  } else if (status === 429) {
    lines.push('Rate limited: the server is asking for a slower pace. This is transient — retry after backing off.');
  } else if (status >= 500 && status <= 599) {
    lines.push(
      `Server fault: the request was understood but the server failed while handling it (HTTP ${status}). ` +
        'This is retryable; if it persists, the server\'s own logs at this timestamp will say why.'
    );
  } else {
    lines.push(`The server answered HTTP ${status}, which this ${context} operation cannot interpret further.`);
  }

  lines.push(`  [HTTP ${status}]`);
  return lines;
}

/**
 * Builds a DICOM JSON attribute: {vr, Value: [...]}, with Value omitted
 * entirely when there are no values — DICOM JSON represents an empty
 * attribute by the absence of Value, not by an empty array.
 *
 * @param {string} vr
 * @param {...*} values
 * @returns {{vr: string, Value?: Array<*>}}
 */
function attr(vr, ...values) {
  const present = values.filter((v) => v !== undefined && v !== null && v !== '');
  return present.length ? { vr, Value: present } : { vr };
}

/**
 * First Value of a tag in a DICOM JSON object, or undefined.
 *
 * @param {object} obj DICOM JSON dataset.
 * @param {string} tag 8-hex-digit tag, e.g. TAGS.STUDY_UID.
 * @returns {*}
 */
function tagValue(obj, tag) {
  return obj?.[tag]?.Value?.[0];
}

/**
 * Person name as its Alphabetic component group — the form PN takes in
 * DICOM JSON is an object, not a bare string, and some servers send the
 * bare string anyway. Handles both.
 *
 * @param {object} obj DICOM JSON dataset.
 * @param {string} tag
 * @returns {string|undefined}
 */
function personName(obj, tag) {
  const value = tagValue(obj, tag);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value.Alphabetic;
  return String(value);
}

/**
 * Translates a transport-level failure (no HTTP response at all) into
 * plain-English lines, keeping the raw code in brackets for the person
 * grepping logs — the same shape reject.js and translateHttpFailure use.
 *
 * @param {Error & {code?: string, hostname?: string}} err
 * @returns {string[]}
 */
function translateTransportFailure(err) {
  const code = err.code ?? 'ERROR';
  const lines = [];

  if (code === 'DCM_WEB_TIMEOUT') {
    lines.push('No answer: the server did not produce a complete response within the timeout.');
    lines.push(
      '  The connection may be silently dropped by a firewall, or the server may be stalled. ' +
        'Raise --timeout only if the server is known to be slow; silence usually means blocked.'
    );
  } else if (code === 'ECONNREFUSED') {
    lines.push('Connection refused: the host is reachable, but nothing is listening on that port.');
    lines.push(
      '  Check the port in the URL. DICOMweb lives on the HTTP(S) port of the server, ' +
        'not on its DIMSE port — 8042 or 443 is common, 11112 is not.'
    );
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    lines.push(`Name resolution failed: "${err.hostname ?? 'the hostname'}" does not resolve from this machine.`);
    lines.push(
      '  Check the hostname for typos, and whether this machine is on the right network — ' +
        'clinical hostnames often only resolve on the VPN or internal DNS.'
    );
  } else if (code === 'ECONNRESET') {
    lines.push('Connection reset: the server, or something between, dropped the connection mid-request.');
    lines.push('  A proxy or TLS terminator that dislikes the request is the usual culprit.');
  } else if (/CERT|TLS|SSL|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(String(code))) {
    lines.push(`TLS certificate verification failed: ${err.message}`);
    lines.push(
      '  For a self-signed test server you control, --insecure skips verification. ' +
        'Never use it against a production system — it removes the protection entirely.'
    );
  } else {
    lines.push(`The request failed before any HTTP response arrived: ${err.message}`);
  }

  lines.push(`  [${code}]`);
  return lines;
}

module.exports = {
  resolveWebOptions,
  webRequest,
  joinUrl,
  buildQuery,
  buildMultipartRelated,
  parseMultipartRelated,
  translateHttpFailure,
  translateTransportFailure,
  attr,
  tagValue,
  personName,
  TAGS,
};
