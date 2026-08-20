'use strict';

const log = require('../../lib/log');
const args = require('../../lib/args');
const {
  resolveWebOptions,
  webRequest,
  joinUrl,
  buildQuery,
  translateHttpFailure,
  translateTransportFailure,
} = require('../../lib/webdicom');

const FLAGS = ['url', 'timeout', 'insecure'];

const USAGE = `
dcm web ping — verify connectivity to a DICOMweb server (QIDO-RS)

Asks the server the cheapest question it can answer — GET /studies?limit=1 —
and reports how long the round trip took. This is the DICOMweb counterpart of
dcm echo: it tells you whether there is a service at this URL and whether your
credentials open the door.

Usage:
  dcm web ping --url <base-url>

Options:
  --url <url>       DICOMweb base URL, including any path prefix.      [env DCM_WEB_URL]
                    Most servers root the API under a prefix such as
                    /dicom-web — a bare hostname is usually the web UI.
  --timeout <ms>    Silence allowed before giving up. Default: 60000.  [env DCM_WEB_TIMEOUT]
  --insecure        Skip TLS certificate verification. Only for
                    self-signed test servers you control.
  --json            Emit {url, ok, status, elapsedMs} as JSON.
  --verbose         Log the request and response exchange.

Authentication:
  Credentials come from the environment and nowhere else — a flag would land
  them in shell history and process listings, which is exactly where PACS
  credentials must not end up:
    DCM_WEB_TOKEN                Bearer token
    DCM_WEB_USER / DCM_WEB_PASS  HTTP Basic

Examples:
  dcm web ping --url https://pacs.example.org/dicom-web
  dcm web ping --url http://localhost:8042/dicom-web --timeout 5000
  dcm web ping --url https://pacs.example.org/dicom-web --json

Note:
  A good ping proves the URL points at a DICOMweb service and that these
  credentials can query it. It does not prove the server will accept images:
  storage (STOW-RS) is a separate grant on many servers, and a server can
  answer queries all day while refusing every upload. The first real
  "dcm web send" is the only test of storage that counts.
`.trimStart();

/**
 * dcm web ping. The cheapest possible DICOMweb question: is there a QIDO-RS
 * service at this URL, and do these credentials open it?
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>} Process exit code.
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const web = resolveWebOptions(flags);
  const asJson = flags.has('json');

  // limit=1 keeps the answer as small as the server allows; the point is the
  // status line and the round trip, not the data.
  const target = joinUrl(web.baseUrl, 'studies') + buildQuery([], { limit: 1 });

  log.info(`GET ${target}`);
  const started = Date.now();

  let res;
  try {
    res = await webRequest({
      method: 'GET',
      url: target,
      headers: { ...web.headers, Accept: 'application/dicom+json' },
      timeoutMs: web.timeoutMs,
      insecure: web.insecure,
    });
  } catch (err) {
    const elapsedMs = Date.now() - started;
    if (asJson) {
      log.out(JSON.stringify({ url: web.baseUrl, ok: false, status: null, elapsedMs }, null, 2));
    } else {
      log.error(`ping failed after ${elapsedMs} ms`);
      for (const line of translateTransportFailure(err)) log.out(line);
    }
    return 1;
  }

  const elapsedMs = Date.now() - started;
  // 200 is a result set (possibly empty); 204 is the spec's way of saying
  // "zero matches". Both mean the service answered the query properly.
  const ok = res.status === 200 || res.status === 204;

  if (asJson) {
    log.out(JSON.stringify({ url: web.baseUrl, ok, status: res.status, elapsedMs }, null, 2));
    return ok ? 0 : 1;
  }

  if (!ok) {
    log.error(`ping failed after ${elapsedMs} ms`);
    for (const line of translateHttpFailure(res.status, 'ping')) log.out(line);
    return 1;
  }

  // A 200 that is actually a login page fools health checks all the time.
  const contentType = String(res.headers['content-type'] ?? '');
  if (res.status === 200 && /text\/html/i.test(contentType)) {
    log.warn(
      'the server answered 200 with an HTML page rather than application/dicom+json — ' +
        'this URL may be a web UI, not the DICOMweb API. Check for a path prefix such as /dicom-web.'
    );
  }

  log.out(`${log.color.green('OK')}  ${web.baseUrl} answered QIDO-RS in ${elapsedMs} ms [HTTP ${res.status}]`);
  const authLine =
    web.authSource === 'bearer'
      ? 'the bearer token from DCM_WEB_TOKEN was accepted'
      : web.authSource === 'basic'
        ? 'the HTTP Basic credentials from DCM_WEB_USER / DCM_WEB_PASS were accepted'
        : 'no credentials were sent — the server allows anonymous queries';
  log.out(`    ${authLine}`);
  log.out('');
  log.out(
    log.color.dim(
      'A good ping proves the URL points at a DICOMweb service and that these\n' +
        'credentials can query it. It does not prove the server will accept images —\n' +
        'storage (STOW-RS) is a separate grant on many servers, and a server can answer\n' +
        'queries while refusing every upload.'
    )
  );
  return 0;
}

module.exports = { run, USAGE };
