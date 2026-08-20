'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');

const log = require('../../src/lib/log');
const { UsageError } = require('../../src/lib/args');
const {
  resolveWebOptions,
  webRequest,
  joinUrl,
  buildQuery,
  buildMultipartRelated,
  parseMultipartRelated,
  translateHttpFailure,
  attr,
  tagValue,
  personName,
  TAGS,
} = require('../../src/lib/webdicom');

// resolveWebOptions legitimately warns about cleartext and --insecure; those
// warnings are for operators, not for the test log.
log.configure({ quiet: true, noColor: true });

/** All env vars this module reads; every test starts from a clean slate. */
const ENV_KEYS = ['DCM_WEB_URL', 'DCM_WEB_TOKEN', 'DCM_WEB_USER', 'DCM_WEB_PASS', 'DCM_WEB_TIMEOUT'];

/** Runs fn with exactly the given env vars set, restoring the outer env after. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function flagsOf(entries) {
  return new Map(entries);
}

test('resolveWebOptions strips the trailing slash from the base URL', () => {
  withEnv({}, () => {
    const opts = resolveWebOptions(flagsOf([['url', 'https://pacs.example.org/dicom-web/']]));
    assert.equal(opts.baseUrl, 'https://pacs.example.org/dicom-web');
  });
});

test('resolveWebOptions rejects a missing, malformed, or non-http URL as a usage error', () => {
  withEnv({}, () => {
    assert.throws(() => resolveWebOptions(flagsOf([])), UsageError);
    assert.throws(() => resolveWebOptions(flagsOf([['url', 'not a url at all']])), UsageError);
    assert.throws(() => resolveWebOptions(flagsOf([['url', 'ftp://pacs.example.org/dicom-web']])), UsageError);
  });
});

test('the base URL resolves flag first, then DCM_WEB_URL', () => {
  withEnv({ DCM_WEB_URL: 'https://from-env.example.org/dicom-web' }, () => {
    const fromEnv = resolveWebOptions(flagsOf([]));
    assert.equal(fromEnv.baseUrl, 'https://from-env.example.org/dicom-web');

    const fromFlag = resolveWebOptions(flagsOf([['url', 'https://from-flag.example.org/dicom-web']]));
    assert.equal(fromFlag.baseUrl, 'https://from-flag.example.org/dicom-web');
  });
});

test('DCM_WEB_TOKEN yields a Bearer Authorization header and authSource bearer', () => {
  withEnv({ DCM_WEB_TOKEN: 'tok-123' }, () => {
    const opts = resolveWebOptions(flagsOf([['url', 'https://pacs.example.org/dicom-web']]));
    assert.equal(opts.authSource, 'bearer');
    assert.equal(opts.headers.Authorization, 'Bearer tok-123');
  });
});

test('DCM_WEB_USER and DCM_WEB_PASS yield HTTP Basic, and the token wins when both are set', () => {
  withEnv({ DCM_WEB_USER: 'alice', DCM_WEB_PASS: 's3cret' }, () => {
    const opts = resolveWebOptions(flagsOf([['url', 'https://pacs.example.org/dicom-web']]));
    assert.equal(opts.authSource, 'basic');
    assert.equal(opts.headers.Authorization, `Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  });

  withEnv({ DCM_WEB_TOKEN: 't', DCM_WEB_USER: 'alice', DCM_WEB_PASS: 's3cret' }, () => {
    assert.equal(
      resolveWebOptions(flagsOf([['url', 'https://pacs.example.org/dicom-web']])).authSource,
      'bearer'
    );
  });
});

test('with no credentials in the environment there is no Authorization header', () => {
  withEnv({}, () => {
    const opts = resolveWebOptions(flagsOf([['url', 'https://pacs.example.org/dicom-web']]));
    assert.equal(opts.authSource, 'none');
    assert.equal(opts.headers.Authorization, undefined);
  });
});

test('timeout resolves flag, then DCM_WEB_TIMEOUT, then 60000', () => {
  withEnv({}, () => {
    assert.equal(resolveWebOptions(flagsOf([['url', 'https://x.example.org']])).timeoutMs, 60000);
  });
  withEnv({ DCM_WEB_TIMEOUT: '5000' }, () => {
    assert.equal(resolveWebOptions(flagsOf([['url', 'https://x.example.org']])).timeoutMs, 5000);
    assert.equal(
      resolveWebOptions(flagsOf([['url', 'https://x.example.org'], ['timeout', '250']])).timeoutMs,
      250
    );
  });
});

test('--insecure is honoured for https and ignored for http', () => {
  withEnv({}, () => {
    assert.equal(
      resolveWebOptions(flagsOf([['url', 'https://x.example.org'], ['insecure', true]])).insecure,
      true
    );
    assert.equal(
      resolveWebOptions(flagsOf([['url', 'http://localhost:8042'], ['insecure', true]])).insecure,
      false
    );
  });
});

test('joinUrl preserves a based path and percent-encodes each segment', () => {
  assert.equal(
    joinUrl('https://pacs.example.org/dicom-web', 'studies', '1.2.840.113619.2.1'),
    'https://pacs.example.org/dicom-web/studies/1.2.840.113619.2.1'
  );
  // A trailing slash on the base must not double up.
  assert.equal(joinUrl('https://pacs.example.org/dicom-web/', 'studies'), 'https://pacs.example.org/dicom-web/studies');
  // A hostile or merely odd segment cannot change the route.
  assert.equal(
    joinUrl('https://h.example.org/dicom-web', 'a/b', 'c d?e=f'),
    'https://h.example.org/dicom-web/a%2Fb/c%20d%3Fe%3Df'
  );
});

test('buildQuery encodes keys and values and repeats includefield per attribute', () => {
  const query = buildQuery(
    [
      ['PatientName', 'DOE^JOHN'],
      ['StudyDate', '20240101-20241231'],
    ],
    { limit: 10, offset: 5, includefields: ['00081030', 'ModalitiesInStudy'] }
  );

  assert.ok(query.startsWith('?'));
  assert.ok(query.includes('PatientName=DOE%5EJOHN'));
  assert.ok(query.includes('StudyDate=20240101-20241231'));
  assert.ok(query.includes('includefield=00081030'));
  assert.ok(query.includes('includefield=ModalitiesInStudy'));
  assert.ok(query.includes('limit=10'));
  assert.ok(query.includes('offset=5'));
  assert.equal((query.match(/includefield=/g) ?? []).length, 2);
});

test('buildQuery returns an empty string when there is nothing to send', () => {
  assert.equal(buildQuery([], {}), '');
});

test('multipart build then parse roundtrips two binary parts byte-for-byte', async () => {
  // Bodies deliberately contain CRLFs and leading dashes — the byte patterns
  // most likely to confuse a sloppy boundary scan.
  const partA = Buffer.concat([Buffer.from('DICM\r\n--not-a-boundary\r\n'), Buffer.from([0, 1, 2, 255, 254, 13, 10])]);
  const partB = Buffer.from([0x2d, 0x2d, 0x0d, 0x0a, 0x00, 0x80, 0xff, 0x7f]);

  const { contentType, stream, contentLength } = buildMultipartRelated([
    { contentType: 'application/dicom', getStream: () => Readable.from([partA]), length: partA.length },
    { contentType: 'application/dicom', getStream: () => Readable.from([partB]), length: partB.length },
  ]);

  assert.match(contentType, /^multipart\/related; type="application\/dicom"; boundary="[^"]+"$/);

  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const wire = Buffer.concat(chunks);

  // The declared Content-Length must match the bytes actually produced,
  // or servers will cut the upload short or hang waiting for more.
  assert.equal(wire.length, contentLength);

  const parts = parseMultipartRelated(wire, contentType);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].headers['content-type'], 'application/dicom');
  assert.equal(parts[1].headers['content-type'], 'application/dicom');
  assert.deepEqual(parts[0].body, partA);
  assert.deepEqual(parts[1].body, partB);
});

test('parseMultipartRelated handles quoted boundary, preamble, epilogue and mixed-case headers', () => {
  const fixture = Buffer.from(
    'this preamble should be ignored\r\n' +
      '--BOUNDARY-42\r\n' +
      'CONTENT-TYPE: application/dicom+json\r\n' +
      'X-Custom: hello\r\n' +
      '\r\n' +
      '{"a":1}\r\n' +
      '--BOUNDARY-42  \r\n' +
      'Content-Type: application/octet-stream\r\n' +
      '\r\n' +
      'raw\x00bytes\r\n' +
      '--BOUNDARY-42--\r\n' +
      'and this epilogue should be ignored too',
    'latin1'
  );

  const parts = parseMultipartRelated(
    fixture,
    'multipart/related; type="application/dicom"; boundary="BOUNDARY-42"'
  );

  assert.equal(parts.length, 2);
  assert.equal(parts[0].headers['content-type'], 'application/dicom+json');
  assert.equal(parts[0].headers['x-custom'], 'hello');
  assert.equal(parts[0].body.toString(), '{"a":1}');
  assert.deepEqual(parts[1].body, Buffer.from('raw\x00bytes', 'latin1'));

  // A bare (unquoted) boundary parameter parses identically.
  const bare = parseMultipartRelated(fixture, 'multipart/related; boundary=BOUNDARY-42; type="application/dicom"');
  assert.equal(bare.length, 2);
});

test('parseMultipartRelated throws on a truncated body and on a missing boundary parameter', () => {
  const truncated = Buffer.from('--B\r\nContent-Type: application/dicom\r\n\r\ndata with no closing boundary');
  assert.throws(
    () => parseMultipartRelated(truncated, 'multipart/related; boundary="B"'),
    /closing boundary/i
  );

  assert.throws(
    () => parseMultipartRelated(Buffer.from('whatever'), 'application/dicom+json'),
    /boundary/i
  );
});

test('translateHttpFailure 401 names the env vars and never leaks their values', () => {
  withEnv({ DCM_WEB_TOKEN: 'super-secret-token-value' }, () => {
    const text = translateHttpFailure(401, 'qido').join('\n');
    assert.match(text, /DCM_WEB_TOKEN/);
    assert.match(text, /DCM_WEB_USER/);
    assert.match(text, /DCM_WEB_PASS/);
    assert.ok(!text.includes('super-secret-token-value'), 'a credential value must never be printed');
    assert.match(text, /\[HTTP 401\]/);
  });
});

test('translateHttpFailure gives targeted advice for the common statuses', () => {
  assert.match(translateHttpFailure(404, 'ping').join('\n'), /\/dicom-web/);
  assert.match(translateHttpFailure(404, 'wado').join('\n'), /study UID/i);
  assert.match(translateHttpFailure(413, 'stow').join('\n'), /--chunk/);
  assert.match(translateHttpFailure(429, 'stow').join('\n'), /retry/i);
  assert.match(translateHttpFailure(503, 'qido').join('\n'), /\[HTTP 503\]/);
  assert.match(translateHttpFailure(415, 'stow').join('\n'), /multipart\/related/);
});

test('webRequest returns status, headers and a buffered body from a live server', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/dicom+json' });
    res.end(JSON.stringify([{ ok: true }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await webRequest({
      method: 'GET',
      url: `http://127.0.0.1:${port}/studies`,
      headers: { Accept: 'application/dicom+json' },
      timeoutMs: 5000,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/dicom+json');
    assert.ok(Buffer.isBuffer(res.body));
    assert.deepEqual(JSON.parse(res.body.toString()), [{ ok: true }]);
  } finally {
    server.close();
  }
});

test('webRequest rejects with DCM_WEB_TIMEOUT when the server never answers', async () => {
  // Accept the connection, then say nothing — the classic silent stall.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      webRequest({ method: 'GET', url: `http://127.0.0.1:${port}/studies`, timeoutMs: 150 }),
      (err) => err.code === 'DCM_WEB_TIMEOUT'
    );
  } finally {
    server.close();
  }
});

test('webRequest preserves the transport error code on connection failure', async () => {
  // Bind then close so the port is known-dead.
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  await assert.rejects(
    webRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 }),
    (err) => err.code === 'ECONNREFUSED'
  );
});

test('dicom json helpers build and read attributes the way PS3.18 shapes them', () => {
  assert.deepEqual(attr('UI', '1.2.3'), { vr: 'UI', Value: ['1.2.3'] });
  assert.deepEqual(attr('US', 42752), { vr: 'US', Value: [42752] });
  // Empty attribute: Value is omitted, not an empty array.
  assert.deepEqual(attr('UI'), { vr: 'UI' });

  const dataset = {
    [TAGS.STUDY_UID]: { vr: 'UI', Value: ['1.2.3.4'] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JOHN' }] },
    '00100020': { vr: 'LO', Value: ['MRN-1'] },
  };
  assert.equal(tagValue(dataset, TAGS.STUDY_UID), '1.2.3.4');
  assert.equal(tagValue(dataset, TAGS.SOP_UID), undefined);
  assert.equal(personName(dataset, '00100010'), 'DOE^JOHN');
  // Some servers send PN as a bare string; both shapes must read.
  assert.equal(personName({ '00100010': { vr: 'PN', Value: ['SMITH^A'] } }, '00100010'), 'SMITH^A');
  assert.equal(personName(dataset, '00080090'), undefined);
});
