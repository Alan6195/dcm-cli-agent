'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');

const log = require('../../src/lib/log');
const { tokenize } = require('../../src/lib/args');
const { withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');
const { buildMultipartRelated, parseMultipartRelated } = require('../../src/lib/webdicom');
// safeUidSegment lives in src/lib/uid.js — every caller reaches it there, and
// so does this test, rather than through whichever command happens to use it.
const { safeUidSegment } = require('../../src/lib/uid');
const retrieve = require('../../src/commands/web/retrieve');
const { persistParts } = retrieve;

// persistParts legitimately warns about unreadable parts; keep the test log clean.
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

/**
 * Builds a WADO-RS-shaped multipart body from raw part buffers, roundtripping
 * through the same builder/parser the shipped code uses.
 */
async function buildWire(bodies) {
  const { contentType, stream } = buildMultipartRelated(
    bodies.map((body) => ({
      contentType: 'application/dicom',
      getStream: () => Readable.from([body]),
      length: body.length,
    }))
  );
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { contentType, wire: Buffer.concat(chunks) };
}

/** A base URL whose port has nothing listening on it: connections are refused. */
async function deadBaseUrl() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/dicom-web`;
}

/** Every regular file under dir, recursively — what actually landed on disk. */
function filesOnDisk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesOnDisk(full));
    else found.push(full);
  }
  return found;
}

/** Generates fixtures and returns their file buffers plus the manifest. */
async function makeStudy(dir, opts = {}) {
  const manifest = await generate({
    outDir: dir,
    studies: 1,
    seriesPerStudy: 2,
    instancesPerSeries: 2,
    quiet: true,
    ...opts,
  });
  const files = [];
  for (const study of manifest.studies) {
    for (const series of study.series) {
      for (const instance of series.instances) {
        files.push({ ...instance, seriesInstanceUid: series.seriesInstanceUid, studyInstanceUid: study.studyInstanceUid });
      }
    }
  }
  return { manifest, files };
}

test('safeUidSegment strips non-UID characters and falls back on traversal-shaped input', () => {
  assert.equal(safeUidSegment('1.2.840.113619', 'fb'), '1.2.840.113619');
  // Path separators and letters cannot reach the filesystem.
  assert.equal(safeUidSegment('1.2/..\\3', 'fb'), '1.2..3');
  // Cleaning that leaves nothing, or a traversal segment, falls back.
  assert.equal(safeUidSegment('..', 'fb'), 'fb');
  assert.equal(safeUidSegment('a/b', 'fb'), 'fb');
  assert.equal(safeUidSegment('evil', 'fb'), 'fb');
  assert.equal(safeUidSegment('', 'fb'), 'fb');
  assert.equal(safeUidSegment(undefined, 'fb'), 'fb');
  assert.equal(safeUidSegment(`1.${'2'.repeat(70)}`, 'fb'), 'fb');
});

test('persistParts lands each part at <out>/<study>/<series>/<sop>.dcm from the DICOM bytes', async () => {
  await withTempDir('webretrieve-fixtures', async (fixtureDir) => {
    const { files } = await makeStudy(path.join(fixtureDir, 'src'));
    const { contentType, wire } = await buildWire(files.map((f) => fs.readFileSync(f.path)));

    const parts = parseMultipartRelated(wire, contentType);
    assert.equal(parts.length, 4);

    await withTempDir('webretrieve-out', async (outDir) => {
      const { written, unreadable } = persistParts(parts, outDir);

      assert.equal(unreadable.length, 0);
      assert.equal(written.length, 4);
      for (const file of files) {
        const expected = path.join(
          outDir,
          file.studyInstanceUid,
          file.seriesInstanceUid,
          `${file.sopInstanceUid}.dcm`
        );
        assert.ok(fs.existsSync(expected), `expected ${expected}`);
      }
      // The written bytes are the part bytes, not a re-encode.
      const first = written.find((w) => w.sopUid === files[0].sopInstanceUid);
      assert.deepEqual(fs.readFileSync(first.path), fs.readFileSync(files[0].path));
      // No temp files may survive, readable or not.
      assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith('.tmp')), []);
    });
  });
});

test('persistParts counts a garbage part as unreadable, removes its temp file, and keeps the rest', async () => {
  await withTempDir('webretrieve-fixtures', async (fixtureDir) => {
    const { files } = await makeStudy(path.join(fixtureDir, 'src'), { seriesPerStudy: 1, instancesPerSeries: 2 });
    const bodies = files.map((f) => fs.readFileSync(f.path));
    // Looks enough like DICOM to be attempted, but cannot parse.
    const garbageHeader = Buffer.alloc(132);
    garbageHeader.write('DICM', 128, 'ascii');
    bodies.push(Buffer.concat([garbageHeader, Buffer.from('not a dataset')]));

    const { contentType, wire } = await buildWire(bodies);
    const parts = parseMultipartRelated(wire, contentType);

    await withTempDir('webretrieve-out', async (outDir) => {
      const { written, unreadable } = persistParts(parts, outDir);
      assert.equal(written.length, 2);
      assert.equal(unreadable.length, 1);
      assert.equal(unreadable[0].index, 2);
      assert.ok(unreadable[0].reason.length > 0);
      assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith('.tmp')), []);
    });
  });
});

test('safeUidSegment is not re-exported by the retrieve command — src/lib/uid.js is its home', () => {
  assert.equal(retrieve.safeUidSegment, undefined);
});

test('persistParts counts a repeated SOP instance once, so written matches the files on disk', async () => {
  await withTempDir('webretrieve-fixtures', async (fixtureDir) => {
    const { files } = await makeStudy(path.join(fixtureDir, 'src'), { seriesPerStudy: 1, instancesPerSeries: 2 });
    const bodies = files.map((f) => fs.readFileSync(f.path));
    // The same instance sent twice — one file can exist at that path, so the
    // written count must stay at 2 rather than claiming a third write.
    bodies.push(bodies[0]);

    const { contentType, wire } = await buildWire(bodies);
    const parts = parseMultipartRelated(wire, contentType);
    assert.equal(parts.length, 3);

    await withTempDir('webretrieve-out', async (outDir) => {
      const { written, unreadable, duplicates } = persistParts(parts, outDir);

      assert.equal(written.length, 2);
      assert.equal(unreadable.length, 0);
      assert.equal(duplicates.length, 1);
      assert.equal(duplicates[0].index, 2);
      assert.equal(duplicates[0].firstIndex, 0);
      assert.equal(duplicates[0].sopUid, files[0].sopInstanceUid);

      // The claim and the filesystem have to agree; that is the whole point.
      assert.equal(filesOnDisk(outDir).length, written.length);
      assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith('.tmp')), []);
      // The kept copy is the first arrival, byte for byte.
      assert.deepEqual(fs.readFileSync(written[0].path), bodies[0]);
    });
  });
});

test('run() retrieves a study end-to-end from a loopback WADO server and exits 0', async () => {
  await withCleanEnv(() =>
    withTempDir('webretrieve-fixtures', async (fixtureDir) => {
      const { manifest, files } = await makeStudy(path.join(fixtureDir, 'src'));
      const studyUid = manifest.studies[0].studyInstanceUid;
      const { contentType, wire } = await buildWire(files.map((f) => fs.readFileSync(f.path)));

      const server = http.createServer((req, res) => {
        assert.equal(req.url, `/dicom-web/studies/${studyUid}`);
        assert.match(req.headers.accept, /multipart\/related/);
        assert.match(req.headers.accept, /transfer-syntax=\*/);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(wire);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        await withTempDir('webretrieve-out', async (outDir) => {
          const { code, stdout } = await runCaptured(retrieve, [
            '--url', `http://127.0.0.1:${port}/dicom-web`,
            '--study', studyUid,
            '--out', outDir,
          ]);
          assert.equal(code, 0);
          assert.match(stdout, /instances received : 4/);
          assert.match(stdout, /written            : 4/);
          assert.match(stdout, /unreadable         : 0/);
          for (const file of files) {
            assert.ok(fs.existsSync(path.join(outDir, studyUid, file.seriesInstanceUid, `${file.sopInstanceUid}.dcm`)));
          }
        });
      } finally {
        server.close();
      }
    })
  );
});

test('run() --json emits the accounting payload and exits 1 when a part is unreadable', async () => {
  await withCleanEnv(() =>
    withTempDir('webretrieve-fixtures', async (fixtureDir) => {
      const { manifest, files } = await makeStudy(path.join(fixtureDir, 'src'), { seriesPerStudy: 1, instancesPerSeries: 2 });
      const studyUid = manifest.studies[0].studyInstanceUid;
      const bodies = files.map((f) => fs.readFileSync(f.path));
      const garbageHeader = Buffer.alloc(132);
      garbageHeader.write('DICM', 128, 'ascii');
      bodies.push(Buffer.concat([garbageHeader, Buffer.from('junk')]));
      const { contentType, wire } = await buildWire(bodies);

      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(wire);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        await withTempDir('webretrieve-out', async (outDir) => {
          const { code, stdout } = await runCaptured(retrieve, [
            '--url', `http://127.0.0.1:${port}/dicom-web`,
            '--study', studyUid,
            '--out', outDir,
            '--json',
          ]);
          // Partial success is failure: the exit code must not read as clean.
          assert.equal(code, 1);
          const payload = JSON.parse(stdout);
          assert.equal(payload.studyUid, studyUid);
          assert.equal(payload.received, 3);
          assert.equal(payload.written, 2);
          assert.equal(payload.unreadable, 1);
          assert.equal(payload.outDir, outDir);
          assert.match(payload.url, new RegExp(`/studies/${studyUid.replace(/\./g, '\\.')}$`));
        });
      } finally {
        server.close();
      }
    })
  );
});

test('run() translates 404 as the server not holding the study and exits 1', async () => {
  await withCleanEnv(async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      await withTempDir('webretrieve-out', async (outDir) => {
        const { code, output } = await runCaptured(retrieve, [
          '--url', `http://127.0.0.1:${port}/dicom-web`,
          '--study', '1.2.3.4',
          '--out', outDir,
        ]);
        assert.equal(code, 1);
        assert.match(output, /does not hold that study/);
        assert.match(output, /\[HTTP 404\]/);
      });
    } finally {
      server.close();
    }
  });
});

test('run() keeps the instances a 206 Partial Content response carried, reports PARTIAL, exits 1', async () => {
  await withCleanEnv(() =>
    withTempDir('webretrieve-fixtures', async (fixtureDir) => {
      const { manifest, files } = await makeStudy(path.join(fixtureDir, 'src'));
      const studyUid = manifest.studies[0].studyInstanceUid;
      const { contentType, wire } = await buildWire(files.map((f) => fs.readFileSync(f.path)));

      // dcm4chee-arc answers 206 when it can produce some instances but not
      // all of them. The body is a normal multipart response.
      const server = http.createServer((req, res) => {
        res.writeHead(206, { 'Content-Type': contentType });
        res.end(wire);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        await withTempDir('webretrieve-out', async (outDir) => {
          const { code, stdout } = await runCaptured(retrieve, [
            '--url', `http://127.0.0.1:${port}/dicom-web`,
            '--study', studyUid,
            '--out', outDir,
          ]);
          // Incomplete study: a failure, but not an empty-handed one.
          assert.equal(code, 1);
          assert.match(stdout, /PARTIAL CONTENT/);
          assert.match(stdout, /HTTP 206/);
          assert.match(stdout, /instances received : 4/);
          assert.match(stdout, /written            : 4/);
          // Every byte that arrived is on disk — nothing was thrown away.
          for (const file of files) {
            assert.ok(fs.existsSync(path.join(outDir, studyUid, file.seriesInstanceUid, `${file.sopInstanceUid}.dcm`)));
          }
        });
      } finally {
        server.close();
      }
    })
  );
});

test('run() --json marks a 206 response partial and not ok, with the parts still written', async () => {
  await withCleanEnv(() =>
    withTempDir('webretrieve-fixtures', async (fixtureDir) => {
      const { manifest, files } = await makeStudy(path.join(fixtureDir, 'src'), { seriesPerStudy: 1, instancesPerSeries: 2 });
      const studyUid = manifest.studies[0].studyInstanceUid;
      const { contentType, wire } = await buildWire(files.map((f) => fs.readFileSync(f.path)));

      const server = http.createServer((req, res) => {
        res.writeHead(206, { 'Content-Type': contentType });
        res.end(wire);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        await withTempDir('webretrieve-out', async (outDir) => {
          const { code, stdout } = await runCaptured(retrieve, [
            '--url', `http://127.0.0.1:${port}/dicom-web`,
            '--study', studyUid,
            '--out', outDir,
            '--json',
          ]);
          assert.equal(code, 1);
          const payload = JSON.parse(stdout);
          assert.equal(payload.partial, true);
          assert.equal(payload.ok, false);
          assert.equal(payload.status, 206);
          assert.equal(payload.received, 2);
          assert.equal(payload.written, 2);
        });
      } finally {
        server.close();
      }
    })
  );
});

test('run() reports a duplicated SOP instance as its own outcome and exits 1', async () => {
  await withCleanEnv(() =>
    withTempDir('webretrieve-fixtures', async (fixtureDir) => {
      const { manifest, files } = await makeStudy(path.join(fixtureDir, 'src'), { seriesPerStudy: 1, instancesPerSeries: 2 });
      const studyUid = manifest.studies[0].studyInstanceUid;
      const bodies = files.map((f) => fs.readFileSync(f.path));
      bodies.push(bodies[1]);
      const { contentType, wire } = await buildWire(bodies);

      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(wire);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        await withTempDir('webretrieve-out', async (outDir) => {
          const { code, stdout } = await runCaptured(retrieve, [
            '--url', `http://127.0.0.1:${port}/dicom-web`,
            '--study', studyUid,
            '--out', outDir,
            '--json',
          ]);
          assert.equal(code, 1);
          const payload = JSON.parse(stdout);
          assert.equal(payload.received, 3);
          assert.equal(payload.written, 2);
          assert.equal(payload.duplicates, 1);
          assert.equal(payload.ok, false);
          // The report's written count is the number of files that exist.
          assert.equal(filesOnDisk(outDir).length, payload.written);
        });
      } finally {
        server.close();
      }
    })
  );
});

test('run() --json emits exactly one JSON document when the server answers 404', async () => {
  await withCleanEnv(async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      await withTempDir('webretrieve-out', async (outDir) => {
        const { code, stdout, stderr } = await runCaptured(retrieve, [
          '--url', `http://127.0.0.1:${port}/dicom-web`,
          '--study', '1.2.3.4',
          '--out', outDir,
          '--json',
        ]);
        assert.equal(code, 1);
        // Prose on stdout would make this throw — that is the invariant.
        const payload = JSON.parse(stdout);
        assert.equal(payload.ok, false);
        assert.equal(payload.status, 404);
        assert.equal(payload.written, 0);
        assert.ok(payload.error.join(' ').includes('[HTTP 404]'));
        // The human headline still reaches the operator, on stderr.
        assert.match(stderr, /does not hold that study/);
      });
    } finally {
      server.close();
    }
  });
});

test('run() --json emits exactly one JSON document when the server cannot be reached', async () => {
  await withCleanEnv(async () => {
    const base = await deadBaseUrl();
    await withTempDir('webretrieve-out', async (outDir) => {
      const { code, stdout, stderr } = await runCaptured(retrieve, [
        '--url', base, '--study', '1.2.3.4', '--out', outDir, '--json',
      ]);
      assert.equal(code, 1);
      const payload = JSON.parse(stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, null);
      assert.ok(payload.error.length > 0);
      assert.match(payload.error.join(' '), /ECONNREFUSED|ECONNRESET|ENOTFOUND/);
      assert.match(stderr, /WADO-RS retrieve failed/);
    });
  });
});

test('run() rejects an invalid --study UID and --instance without --series before any request', async () => {
  await withCleanEnv(async () => {
    await withTempDir('webretrieve-out', async (outDir) => {
      await assert.rejects(
        runCaptured(retrieve, ['--url', 'https://x.example.org', '--study', 'not-a-uid', '--out', outDir]),
        /--study is not a valid UID/
      );
      await assert.rejects(
        runCaptured(retrieve, [
          '--url', 'https://x.example.org',
          '--study', '1.2.3', '--instance', '1.2.3.4.5', '--out', outDir,
        ]),
        /--instance needs --series/
      );
    });
  });
});
