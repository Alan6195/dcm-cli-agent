'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const log = require('../../src/lib/log');
const { createWebServer, USAGE } = require('../../src/commands/web/serve');
const { VERBS } = require('../../src/commands/web');
const { webRequest, buildMultipartRelated, parseMultipartRelated, TAGS } = require('../../src/lib/webdicom');
const { generate } = require('../../tools/make-fixtures');
const { freePort, withTempDir } = require('../helpers/harness');

// The hub legitimately logs every request; that chatter is for operators,
// not for the test log.
log.configure({ quiet: true, noColor: true });

/** Starts the shipped hub in-process on a free loopback port. */
async function startHub(config = {}) {
  const stats = {
    requests: 0, stored: 0, rejectedParts: 0, unauthorized: 0,
    queries: 0, retrievedInstances: 0, notFound: 0, clientErrors: 0, errors: 0,
  };
  const server = createWebServer({ rejectAfter: 0, ...config }, stats);
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    stats,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Builds a STOW-RS request body from files on disk. */
function stowRequestParts(files) {
  return buildMultipartRelated(
    files.map((file) => ({
      contentType: 'application/dicom',
      getStream: () => fs.createReadStream(file),
      length: fs.statSync(file).size,
    }))
  );
}

async function stow(base, files, extraHeaders = {}) {
  const { contentType, stream, contentLength } = stowRequestParts(files);
  return webRequest({
    method: 'POST',
    url: `${base}/studies`,
    headers: {
      'Content-Type': contentType,
      'Content-Length': contentLength,
      Accept: 'application/dicom+json',
      ...extraHeaders,
    },
    bodyStream: stream,
  });
}

/** One small fixture study; returns its manifest plus flat instance paths. */
async function makeStudy(dir) {
  const outDir = path.join(dir, 'fixtures');
  const manifest = await generate({
    outDir, quiet: true, studies: 1, seriesPerStudy: 1, instancesPerSeries: 2,
  });
  const study = manifest.studies[0];
  const series = study.series[0];
  return {
    outDir,
    studyUid: study.studyInstanceUid,
    seriesUid: series.seriesInstanceUid,
    files: series.instances.map((i) => i.path),
    sopUids: series.instances.map((i) => i.sopInstanceUid),
  };
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('STOW stores both parts, references both SOP instances, and persists them before answering', async () => {
  await withTempDir('webserve-stow', async (dir) => {
    const fx = await makeStudy(dir);
    const persistDir = path.join(dir, 'received');
    const hub = await startHub({ persistDir });
    try {
      const res = await stow(hub.base, fx.files);
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /application\/dicom\+json/);

      const payload = JSON.parse(res.body.toString('utf8'));
      const referenced = payload[TAGS.REFERENCED_SOP_SEQ]?.Value ?? [];
      assert.equal(referenced.length, 2);
      const referencedUids = referenced.map((item) => item[TAGS.REF_SOP_INSTANCE].Value[0]);
      assert.deepEqual(referencedUids.sort(), [...fx.sopUids].sort());
      assert.equal(payload[TAGS.FAILED_SOP_SEQ], undefined);

      // A STOW 200 must mean stored: the files are on disk under the
      // study/series/sop layout by the time the response arrives.
      for (const sopUid of fx.sopUids) {
        const file = path.join(persistDir, fx.studyUid, fx.seriesUid, `${sopUid}.dcm`);
        assert.ok(fs.existsSync(file), `expected ${file} on disk`);
      }
      assert.equal(hub.stats.stored, 2);
      assert.equal(hub.stats.rejectedParts, 0);
    } finally {
      await hub.close();
    }
  });
});

test('QIDO finds the study by PatientID and answers 204 for a non-match', async () => {
  await withTempDir('webserve-qido', async (dir) => {
    const fx = await makeStudy(dir);
    const hub = await startHub({ rootDir: fx.outDir });
    try {
      const hit = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies?PatientID=SYNTH0001`,
        headers: { Accept: 'application/dicom+json' },
      });
      assert.equal(hit.status, 200);
      const studies = JSON.parse(hit.body.toString('utf8'));
      assert.equal(studies.length, 1);
      assert.equal(studies[0]['0020000D'].Value[0], fx.studyUid);
      assert.equal(studies[0]['00100020'].Value[0], 'SYNTH0001');
      assert.equal(studies[0]['00201208'].Value[0], 2);

      const miss = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies?PatientID=NOSUCHPATIENT`,
        headers: { Accept: 'application/dicom+json' },
      });
      assert.equal(miss.status, 204);
      assert.equal(miss.body.length, 0);
      assert.equal(hub.stats.queries, 2);
    } finally {
      await hub.close();
    }
  });
});

test('WADO returns the stored instances byte-identical to the originals', async () => {
  await withTempDir('webserve-wado', async (dir) => {
    const fx = await makeStudy(dir);
    const hub = await startHub({ rootDir: fx.outDir });
    try {
      const res = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies/${fx.studyUid}`,
        headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' },
      });
      assert.equal(res.status, 200);

      const parts = parseMultipartRelated(res.body, res.headers['content-type']);
      assert.equal(parts.length, 2);

      const sentHashes = parts.map((part) => sha(part.body)).sort();
      const originalHashes = fx.files.map((file) => sha(fs.readFileSync(file))).sort();
      assert.deepEqual(sentHashes, originalHashes);
      assert.equal(hub.stats.retrievedInstances, 2);

      const missing = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies/1.2.3.4.5.6.7.8.9`,
        headers: { Accept: 'multipart/related; type="application/dicom"' },
      });
      assert.equal(missing.status, 404);
      assert.equal(hub.stats.notFound, 1);
    } finally {
      await hub.close();
    }
  });
});

test('--require-token answers 401 without the bearer token and 200 with it', async () => {
  await withTempDir('webserve-token', async (dir) => {
    const fx = await makeStudy(dir);
    const hub = await startHub({ rootDir: fx.outDir, requireToken: 'test-token' });
    try {
      const denied = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies`,
        headers: { Accept: 'application/dicom+json' },
      });
      assert.equal(denied.status, 401);
      assert.equal(hub.stats.unauthorized, 1);

      const wrong = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies`,
        headers: { Accept: 'application/dicom+json', Authorization: 'Bearer wrong' },
      });
      assert.equal(wrong.status, 401);
      assert.equal(hub.stats.unauthorized, 2);

      const allowed = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies`,
        headers: { Accept: 'application/dicom+json', Authorization: 'Bearer test-token' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(JSON.parse(allowed.body.toString('utf8')).length, 1);
    } finally {
      await hub.close();
    }
  });
});

test('--reject-after 1 produces a 202 partial store with one referenced and one 0xA700 failure', async () => {
  await withTempDir('webserve-partial', async (dir) => {
    const fx = await makeStudy(dir);
    const persistDir = path.join(dir, 'received');
    const hub = await startHub({ persistDir, rejectAfter: 1 });
    try {
      const res = await stow(hub.base, fx.files);
      assert.equal(res.status, 202);

      const payload = JSON.parse(res.body.toString('utf8'));
      const referenced = payload[TAGS.REFERENCED_SOP_SEQ]?.Value ?? [];
      const failed = payload[TAGS.FAILED_SOP_SEQ]?.Value ?? [];
      assert.equal(referenced.length, 1);
      assert.equal(failed.length, 1);
      assert.equal(failed[0][TAGS.FAILURE_REASON].Value[0], 42752);

      // The failed part must not have been quietly stored anyway.
      assert.equal(hub.stats.stored, 1);
      assert.equal(hub.stats.rejectedParts, 1);
    } finally {
      await hub.close();
    }
  });
});

test('a WADO source that fails mid-response truncates the body and leaves the hub serving', async () => {
  await withTempDir('webserve-wado-readfail', async (dir) => {
    const fx = await makeStudy(dir);
    const hub = await startHub({ rootDir: fx.outDir });
    try {
      // Indexed at startup, then removed underneath the hub: the request gets
      // its 200 and Content-Length, and the read fails afterwards. That is the
      // failure that used to reach the process as an unhandled 'error'.
      for (const file of fx.files) fs.rmSync(file);

      await assert.rejects(
        webRequest({
          method: 'GET',
          url: `${hub.base}/studies/${fx.studyUid}`,
          headers: { Accept: 'multipart/related; type="application/dicom"' },
        }),
        'the client must see a cut-short response, not a complete one'
      );
      assert.equal(hub.stats.errors, 1);

      // The whole point: one unreadable file is one failed request, not a dead
      // hub. A later request still gets a real answer.
      const after = await webRequest({
        method: 'GET',
        url: `${hub.base}/studies`,
        headers: { Accept: 'application/dicom+json' },
      });
      assert.equal(after.status, 200);
    } finally {
      await hub.close();
    }
  });
});

test('a STOW body past --max-body is refused with 413 without touching the error counter', async () => {
  const hub = await startHub({ maxBodyBytes: 1024 });
  try {
    const res = await webRequest({
      method: 'POST',
      url: `${hub.base}/studies`,
      headers: {
        'Content-Type': 'multipart/related; type="application/dicom"; boundary="b"',
        'Content-Length': 8192,
        Accept: 'application/dicom+json',
      },
      body: Buffer.alloc(8192, 0x41),
    });
    assert.equal(res.status, 413);
    assert.match(res.body.toString('utf8'), /--max-body/);

    // A client sending too much is a client fault: it must not feed stats.errors,
    // which is what decides the hub's exit code.
    assert.equal(hub.stats.errors, 0);
    assert.equal(hub.stats.clientErrors, 1);
    assert.equal(hub.stats.stored, 0);

    const after = await webRequest({
      method: 'GET',
      url: `${hub.base}/studies`,
      headers: { Accept: 'application/dicom+json' },
    });
    assert.equal(after.status, 204);
  } finally {
    await hub.close();
  }
});

test('a malformed percent-encoded path is a 400, not a 500, and does not taint the exit code', async () => {
  const hub = await startHub({});
  try {
    const res = await webRequest({
      method: 'GET',
      url: `${hub.base}/studies/%ZZ`,
      headers: { Accept: 'application/dicom+json' },
    });
    assert.equal(res.status, 400);
    assert.equal(hub.stats.errors, 0);
    assert.equal(hub.stats.clientErrors, 1);
  } finally {
    await hub.close();
  }
});

test('the STOW response carries RetrieveURL at the root and per referenced instance', async () => {
  await withTempDir('webserve-retrieveurl', async (dir) => {
    const fx = await makeStudy(dir);
    const hub = await startHub({ persistDir: path.join(dir, 'received') });
    try {
      const res = await stow(hub.base, fx.files);
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body.toString('utf8'));

      const studyUrl = payload[TAGS.RETRIEVE_URL].Value[0];
      assert.equal(studyUrl, `${hub.base}/studies/${fx.studyUid}`);

      for (const item of payload[TAGS.REFERENCED_SOP_SEQ].Value) {
        const sopUid = item[TAGS.REF_SOP_INSTANCE].Value[0];
        assert.equal(
          item[TAGS.RETRIEVE_URL].Value[0],
          `${hub.base}/studies/${fx.studyUid}/series/${fx.seriesUid}/instances/${sopUid}`
        );
      }

      // The URL is only worth publishing if it retrieves: follow it.
      const retrieved = await webRequest({
        method: 'GET',
        url: studyUrl,
        headers: { Accept: 'multipart/related; type="application/dicom"' },
      });
      assert.equal(retrieved.status, 200);
      assert.equal(parseMultipartRelated(retrieved.body, retrieved.headers['content-type']).length, 2);
    } finally {
      await hub.close();
    }
  });
});

test('without --persist RetrieveURL is present but zero-length, since nothing is retrievable', async () => {
  await withTempDir('webserve-retrieveurl-discard', async (dir) => {
    const fx = await makeStudy(dir);
    const hub = await startHub({});
    try {
      const res = await stow(hub.base, fx.files);
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body.toString('utf8'));

      // Type 2: the attribute is there, with no Value — DICOM JSON's spelling
      // of "required, but the hub has nothing true to put here".
      assert.deepEqual(payload[TAGS.RETRIEVE_URL], { vr: 'UR' });
      for (const item of payload[TAGS.REFERENCED_SOP_SEQ].Value) {
        assert.deepEqual(item[TAGS.RETRIEVE_URL], { vr: 'UR' });
      }
    } finally {
      await hub.close();
    }
  });
});

test('every dcm web example in the help text names a verb that exists', () => {
  const verbs = new Set(Object.keys(VERBS));
  const cited = [...USAGE.matchAll(/dcm web ([a-z][a-z-]*)/g)].map((m) => m[1]);
  assert.ok(cited.length > 0);
  for (const verb of cited) {
    assert.ok(verbs.has(verb), `help text invokes "dcm web ${verb}", which is not a verb`);
  }
  // The cap has to be documented where people look for it, not only in code.
  assert.match(USAGE, /--max-body/);
  assert.match(USAGE, /DCM_WEB_SERVE_MAX_BODY/);
});

test('a malformed multipart body is a 400 charged to the client, not the hub', async () => {
  const hub = await startHub({});
  try {
    const res = await webRequest({
      method: 'POST',
      url: `${hub.base}/studies`,
      headers: {
        'Content-Type': 'multipart/related; type="application/dicom"; boundary="b"',
        Accept: 'application/dicom+json',
      },
      body: Buffer.from('this is not a multipart body at all'),
    });
    assert.equal(res.status, 400);
    // Reproducing a bad request must not make the hub's own run exit 1.
    assert.equal(hub.stats.errors, 0, 'a client sending garbage is not a hub fault');
    assert.equal(hub.stats.clientErrors, 1);
    assert.equal(hub.stats.stored, 0);
  } finally {
    await hub.close();
  }
});
