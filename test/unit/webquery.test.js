'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const log = require('../../src/lib/log');
const { tokenize } = require('../../src/lib/args');
const query = require('../../src/commands/web/query');
const { buildQidoTarget, buildQidoUrl, flattenMatch, displayAttribute, keywordFor } = query;

// resolveWebOptions warns about cleartext HTTP and --insecure; those warnings
// are for operators, not for the test log.
log.configure({ quiet: true, noColor: true });

/**
 * Runs the command with output captured through log's own capture stack.
 *
 * Not harness.runCommand: that swaps process.stdout.write, and under the
 * node:test runner stdout is also the channel test results travel on — a
 * hijack across an await eats result lines and fails the whole file.
 */
async function runCaptured(mod, argv) {
  const sink = log.beginCapture();
  try {
    const code = await mod.run(tokenize(argv));
    return { code, stdout: sink.out, stderr: sink.err, output: sink.out + sink.err };
  } finally {
    log.endCapture();
  }
}

/** Env vars the web options read; each run() test starts from a clean slate. */
const ENV_KEYS = ['DCM_WEB_URL', 'DCM_WEB_TOKEN', 'DCM_WEB_USER', 'DCM_WEB_PASS', 'DCM_WEB_TIMEOUT'];

async function withCleanEnv(fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** One-shot QIDO stand-in: answers every request with the given status/body. */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/dicom-web`);
  } finally {
    server.close();
  }
}

/** A base URL whose port has nothing listening on it: connections are refused. */
async function deadBaseUrl() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/dicom-web`;
}

test('the default level queries {base}/studies with all pairs as match params', () => {
  const target = buildQidoTarget('studies', [['PatientID', '12345'], ['StudyDate', '20260101-20260131']]);
  assert.deepEqual(target.segments, ['studies']);
  assert.deepEqual(target.queryPairs, [['PatientID', '12345'], ['StudyDate', '20260101-20260131']]);
});

test('--series without a StudyInstanceUID pair queries the global /series resource', () => {
  const target = buildQidoTarget('series', [['Modality', 'CT']]);
  assert.deepEqual(target.segments, ['series']);
  assert.deepEqual(target.queryPairs, [['Modality', 'CT']]);
});

test('--series with a StudyInstanceUID pair narrows into /studies/{uid}/series and consumes the pair', () => {
  const target = buildQidoTarget('series', [['StudyInstanceUID', '1.2.3'], ['Modality', 'CT']]);
  assert.deepEqual(target.segments, ['studies', '1.2.3', 'series']);
  // The UID moved into the path; sending it again as a match key would make
  // some servers reject the request.
  assert.deepEqual(target.queryPairs, [['Modality', 'CT']]);
});

test('--instances narrows into /studies/{uid}/series/{uid}/instances only when both UIDs are given', () => {
  const both = buildQidoTarget('instances', [
    ['StudyInstanceUID', '1.2.3'],
    ['SeriesInstanceUID', '1.2.3.4'],
    ['InstanceNumber', '7'],
  ]);
  assert.deepEqual(both.segments, ['studies', '1.2.3', 'series', '1.2.3.4', 'instances']);
  assert.deepEqual(both.queryPairs, [['InstanceNumber', '7']]);

  // With only the study UID the global resource keeps the pair as a match key.
  const studyOnly = buildQidoTarget('instances', [['StudyInstanceUID', '1.2.3']]);
  assert.deepEqual(studyOnly.segments, ['instances']);
  assert.deepEqual(studyOnly.queryPairs, [['StudyInstanceUID', '1.2.3']]);
});

test('a list-of-UIDs match value stays a query parameter instead of becoming a path segment', () => {
  // PS3.18 allows '1.2.3\\1.2.4' as a UID match value, meaning either study.
  // Percent-encoded into the path it would name a study that cannot exist,
  // turning a two-study query into a zero-match one.
  const series = buildQidoTarget('series', [['StudyInstanceUID', '1.2.3\\1.2.4']]);
  assert.deepEqual(series.segments, ['series']);
  assert.deepEqual(series.queryPairs, [['StudyInstanceUID', '1.2.3\\1.2.4']]);

  // One legal UID plus one list: only the pair that can identify a single
  // resource may move, and here the series pair cannot, so neither does.
  const instances = buildQidoTarget('instances', [
    ['StudyInstanceUID', '1.2.3'],
    ['SeriesInstanceUID', '1.2.3.4\\1.2.3.5'],
  ]);
  assert.deepEqual(instances.segments, ['instances']);
  assert.deepEqual(instances.queryPairs, [
    ['StudyInstanceUID', '1.2.3'],
    ['SeriesInstanceUID', '1.2.3.4\\1.2.3.5'],
  ]);

  // A wildcard is not legal in a UID match and is equally meaningless in a
  // path; it stays where the server can reject or honour it on its own terms.
  const wildcard = buildQidoTarget('series', [['StudyInstanceUID', '1.2.3*']]);
  assert.deepEqual(wildcard.segments, ['series']);
  assert.deepEqual(wildcard.queryPairs, [['StudyInstanceUID', '1.2.3*']]);
});

test('buildQidoUrl composes path, match params, includefield, limit and offset fully encoded', () => {
  const url = buildQidoUrl(
    'https://pacs.example.org/dicom-web',
    'series',
    [['StudyInstanceUID', '1.2.3'], ['SeriesDescription', 'T1 AXIAL*']],
    { limit: 10, offset: 5, includefields: ['00081030', 'NumberOfSeriesRelatedInstances'] }
  );
  assert.equal(
    url,
    'https://pacs.example.org/dicom-web/studies/1.2.3/series' +
      '?SeriesDescription=T1%20AXIAL*&includefield=00081030' +
      '&includefield=NumberOfSeriesRelatedInstances&limit=10&offset=5'
  );
});

test('keywordFor maps hex tags to keywords and leaves private tags unnamed', () => {
  assert.equal(keywordFor('0020000D'), 'StudyInstanceUID');
  assert.equal(keywordFor('0020000d'), 'StudyInstanceUID');
  assert.equal(keywordFor('00100010'), 'PatientName');
  assert.equal(keywordFor('00090001'), undefined);
});

test('flattenMatch renders PersonName as the Alphabetic component and keys by keyword', () => {
  const row = flattenMatch({
    '0020000D': { vr: 'UI', Value: ['1.2.3.4'] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE', Ideographic: '' }] },
  });
  assert.equal(row.StudyInstanceUID, '1.2.3.4');
  assert.equal(row.PatientName, 'DOE^JANE');
});

test('flattenMatch joins multi-valued attributes with a backslash and stringifies numbers', () => {
  const row = flattenMatch({
    '00080061': { vr: 'CS', Value: ['CT', 'MR'] },
    '00201208': { vr: 'IS', Value: [42] },
  });
  assert.equal(row.ModalitiesInStudy, 'CT\\MR');
  assert.equal(row.NumberOfStudyRelatedInstances, '42');
});

test('flattenMatch keeps requested-but-empty attributes, private tags, and summarises sequences', () => {
  const row = flattenMatch({
    '00081030': { vr: 'LO' },
    '00090010': { vr: 'LO', Value: ['ACME 1.0'] },
    '00081199': { vr: 'SQ', Value: [{}, {}] },
  });
  // Empty attribute: DICOM JSON omits Value; the column still exists.
  assert.equal(row.StudyDescription, '');
  // Unknown/private tag keeps its hex form rather than vanishing.
  assert.equal(row['00090010'], 'ACME 1.0');
  assert.equal(row.ReferencedSOPSequence, '<sequence, 2 items>');
});

test('flattenMatch tolerates a bare-string PersonName, which some servers send', () => {
  const row = flattenMatch({ '00100010': { vr: 'PN', Value: ['SMITH^A'] } });
  assert.equal(row.PatientName, 'SMITH^A');
});

test('displayAttribute reports out-of-band binary rather than an empty cell', () => {
  assert.equal(
    displayAttribute({ vr: 'OB', BulkDataURI: 'https://x.example.org/bulk/1' }),
    '<bulk data at https://x.example.org/bulk/1>'
  );
  assert.equal(displayAttribute({ vr: 'OB', InlineBinary: 'AAAA' }), '<binary, inline>');
});

test('run() renders a table over the union of returned attributes and exits 0', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      assert.match(req.url, /^\/dicom-web\/studies\?PatientID=12345/);
      assert.equal(req.headers.accept, 'application/dicom+json');
      res.writeHead(200, { 'Content-Type': 'application/dicom+json' });
      res.end(JSON.stringify([
        {
          '0020000D': { vr: 'UI', Value: ['1.2.3'] },
          '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] },
        },
        {
          '0020000D': { vr: 'UI', Value: ['1.2.4'] },
          '00080061': { vr: 'CS', Value: ['CT', 'MR'] },
        },
      ]));
    }, async (base) => {
      const { code, stdout } = await runCaptured(query, ['--url', base, 'PatientID=12345']);
      assert.equal(code, 0);
      // The union of attributes: PatientName came back on one match only.
      assert.match(stdout, /PatientName/);
      assert.match(stdout, /ModalitiesInStudy/);
      assert.match(stdout, /DOE\^JANE/);
      assert.match(stdout, /CT\\MR/);
      assert.match(stdout, /2 matches\./);
    })
  );
});

test('run() treats 204 No Content as zero matches and exits 1', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      res.writeHead(204);
      res.end();
    }, async (base) => {
      const { code, stdout } = await runCaptured(query, ['--url', base, 'PatientID=NOSUCH']);
      assert.equal(code, 1);
      assert.match(stdout, /0 matches\./);
    })
  );
});

test('run() treats 200 with an empty array as zero matches too', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/dicom+json' });
      res.end('[]');
    }, async (base) => {
      const { code } = await runCaptured(query, ['--url', base]);
      assert.equal(code, 1);
    })
  );
});

test('run() --json emits exactly one payload with url, level, count and flat matches', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/dicom+json' });
      res.end(JSON.stringify([{
        '0020000E': { vr: 'UI', Value: ['1.2.3.4'] },
        '00080060': { vr: 'CS', Value: ['CT'] },
      }]));
    }, async (base) => {
      const { code, stdout } = await runCaptured(query, ['--url', base, '--series', 'StudyInstanceUID=1.2.3', '--json']);
      assert.equal(code, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.level, 'series');
      assert.equal(payload.count, 1);
      assert.match(payload.url, /\/studies\/1\.2\.3\/series$/);
      assert.deepEqual(payload.matches, [{ SeriesInstanceUID: '1.2.3.4', Modality: 'CT' }]);
    })
  );
});

test('run() translates an HTTP failure into plain English with the status in brackets', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      res.writeHead(401);
      res.end();
    }, async (base) => {
      const { code, output } = await runCaptured(query, ['--url', base]);
      assert.equal(code, 1);
      assert.match(output, /DCM_WEB_TOKEN/);
      assert.match(output, /\[HTTP 401\]/);
    })
  );
});

test('run() --json emits exactly one JSON document when the server answers 401', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      res.writeHead(401);
      res.end();
    }, async (base) => {
      const { code, stdout, stderr } = await runCaptured(query, ['--url', base, '--json']);
      assert.equal(code, 1);
      // Prose on stdout would make this throw — that is the invariant
      // `dcm web query --json | jq .` and MCP's jsonResult depend on.
      const payload = JSON.parse(stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, 401);
      assert.equal(payload.count, 0);
      assert.deepEqual(payload.matches, []);
      // The guidance is carried, not lost: it names the env var to set.
      assert.ok(payload.error.join(' ').includes('DCM_WEB_TOKEN'));
      assert.ok(payload.error.join(' ').includes('[HTTP 401]'));
      // The human headline goes to stderr, where it cannot corrupt the pipe.
      assert.match(stderr, /HTTP 401/);
    })
  );
});

test('run() --json emits exactly one JSON document when the server cannot be reached', async () => {
  await withCleanEnv(async () => {
    const base = await deadBaseUrl();
    const { code, stdout, stderr } = await runCaptured(query, ['--url', base, 'PatientID=1', '--json']);
    assert.equal(code, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, null);
    assert.deepEqual(payload.matches, []);
    assert.match(payload.error.join(' '), /ECONNREFUSED|ECONNRESET|ENOTFOUND/);
    assert.match(stderr, /QIDO-RS query failed/);
  });
});

test('run() --json emits exactly one JSON document when a 200 body is not QIDO JSON', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      // The classic case: a login page or proxy error served as 200.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Sign in</body></html>');
    }, async (base) => {
      const { code, stdout } = await runCaptured(query, ['--url', base, '--json']);
      assert.equal(code, 1);
      const payload = JSON.parse(stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, 200);
      assert.ok(payload.error.join(' ').includes('not JSON'));
    })
  );
});

test('run() without --json keeps printing the failure translation on stdout', async () => {
  await withCleanEnv(() =>
    withServer((req, res) => {
      res.writeHead(503);
      res.end();
    }, async (base) => {
      const { code, stdout } = await runCaptured(query, ['--url', base]);
      assert.equal(code, 1);
      assert.match(stdout, /\[HTTP 503\]/);
    })
  );
});

test('run() rejects --series carrying a value instead of swallowing the UID silently', async () => {
  await withCleanEnv(async () => {
    await assert.rejects(
      runCaptured(query, ['--url', 'https://x.example.org', '--series', '1.2.3']),
      /StudyInstanceUID=/
    );
  });
});

test('run() rejects choosing two levels and non-integer paging', async () => {
  await withCleanEnv(async () => {
    await assert.rejects(
      runCaptured(query, ['--url', 'https://x.example.org', '--series', '--instances']),
      /one query level/
    );
    await assert.rejects(
      runCaptured(query, ['--url', 'https://x.example.org', '--limit', 'many']),
      /--limit/
    );
    await assert.rejects(
      runCaptured(query, ['--url', 'https://x.example.org', '--offset', '-1']),
      /--offset/
    );
  });
});
