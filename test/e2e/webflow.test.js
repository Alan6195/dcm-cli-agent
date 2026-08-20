'use strict';

/**
 * End-to-end DICOMweb loopback: the real `dcm web send/query/retrieve`
 * commands run against the real `dcm web serve` hub, in-process — the web
 * mirror of transfer.test.js, which does the same for DIMSE send vs `dcm scp`.
 *
 * Output capture: log.beginCapture()/log.endCapture() (runCaptured below),
 * NOT harness.runCommand. runCommand monkey-patches process.stdout.write for
 * the whole process, and under the node:test runner stdout is also the channel
 * the test results travel on — holding that hijack across awaits while an
 * in-process HTTP server is handling requests can eat result lines and fail
 * the whole file. transfer.test.js gets away with runCommand against a live
 * DIMSE server, but test/unit/webquery.test.js hit exactly this with a live
 * HTTP server and switched to log's own capture stack. The hub and the client
 * commands both log through src/lib/log, so capturing at that chokepoint
 * collects both sides' output without ever touching the process streams.
 * Verified empirically: this file passes under `node --test` this way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startWebServer, freePort, withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');

const log = require('../../src/lib/log');
const { tokenize } = require('../../src/lib/args');
const web = require('../../src/commands/web');

// Colour codes would make the output assertions brittle. The level stays at
// the default (info) on purpose: the translated warnings these tests assert
// on (DCM_WEB_TOKEN guidance, "Connection refused") are emitted via log.warn.
log.configure({ noColor: true });

/** Runs `dcm web <verb> …` the way the dispatcher would, output captured. */
async function runWeb(argv) {
  const sink = log.beginCapture();
  try {
    const code = await web.run(tokenize(argv));
    return { code, stdout: sink.out, stderr: sink.err, output: sink.out + sink.err };
  } finally {
    log.endCapture();
  }
}

/**
 * Env vars the web options read. Other tests run in this same process, so
 * every test starts from a clean slate and restores whatever was there.
 */
const ENV_KEYS = ['DCM_WEB_URL', 'DCM_WEB_TOKEN', 'DCM_WEB_USER', 'DCM_WEB_PASS', 'DCM_WEB_TIMEOUT', 'DCM_WEB_CHUNK'];

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

/** Generates a small fixture tree inside a temp dir. */
async function fixtures(dir, opts = {}) {
  return generate({
    outDir: dir,
    quiet: true,
    studies: 1,
    seriesPerStudy: 2,
    instancesPerSeries: 3,
    rows: 16,
    cols: 16,
    ...opts,
  });
}

function hubUrl(hub) {
  return `http://127.0.0.1:${hub.port}`;
}

/** Flattens the fixture manifest to one row per instance. */
function manifestInstances(manifest) {
  const rows = [];
  for (const study of manifest.studies) {
    for (const series of study.series) {
      for (const inst of series.instances) {
        rows.push({
          studyUid: study.studyInstanceUid,
          seriesUid: series.seriesInstanceUid,
          sopUid: inst.sopInstanceUid,
          sourcePath: inst.path,
        });
      }
    }
  }
  return rows;
}

test('web send round trip: acknowledged in full, persisted byte-identical in UID layout', async () => {
  await withCleanEnv(() => withTempDir('dcm-webflow-send', async (dir) => {
    const src = path.join(dir, 'src');
    const received = path.join(dir, 'received');
    const manifest = await fixtures(src); // 1 study, 2 series, 3 instances each = 6

    const hub = await startWebServer({ persistDir: received });
    try {
      const { code, output } = await runWeb(['send', src, '--url', hubUrl(hub)]);

      assert.equal(code, 0);
      assert.match(output, /files found\s+6/);
      assert.match(output, /files sent\s+6/);
      assert.match(output, /acknowledged\s+6/);
      assert.match(output, /OK — every file found was acknowledged/);
      assert.equal(hub.stats.stored, 6);

      // Every instance landed under <study>/<series>/<sop>.dcm, and the bytes
      // the hub kept are exactly the bytes the fixture generator wrote.
      for (const inst of manifestInstances(manifest)) {
        const persisted = path.join(received, inst.studyUid, inst.seriesUid, `${inst.sopUid}.dcm`);
        assert.ok(fs.existsSync(persisted), `expected ${persisted} to exist`);
        assert.equal(
          Buffer.compare(fs.readFileSync(persisted), fs.readFileSync(inst.sourcePath)), 0,
          `persisted bytes must be identical to the source for ${inst.sopUid}`
        );
      }
    } finally {
      hub.close();
    }
  }));
});

test('QIDO query after a store finds the study; zero matches exits 1', async () => {
  await withCleanEnv(() => withTempDir('dcm-webflow-query', async (dir) => {
    const src = path.join(dir, 'src');
    const manifest = await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 2 });
    const studyUid = manifest.studies[0].studyInstanceUid;

    // No persist: acknowledge-and-discard mode still indexes for QIDO.
    const hub = await startWebServer({});
    try {
      const sent = await runWeb(['send', src, '--url', hubUrl(hub)]);
      assert.equal(sent.code, 0);

      // The generator stamps study 1 with PatientID SYNTH0001 (the manifest
      // does not carry it; transfer.test.js relies on the same constant).
      const found = await runWeb(['query', '--url', hubUrl(hub), 'PatientID=SYNTH0001']);
      assert.equal(found.code, 0);
      assert.ok(found.output.includes(studyUid), 'the match must show the StudyInstanceUID');

      const asJson = await runWeb(['query', '--url', hubUrl(hub), 'PatientID=SYNTH0001', '--json']);
      assert.equal(asJson.code, 0);
      const payload = JSON.parse(asJson.stdout);
      assert.ok(payload.count >= 1);
      assert.equal(payload.matches[0].StudyInstanceUID, studyUid);

      // Zero matches is the answer "nothing matched", and by convention exit 1.
      const before = hub.stats.queries;
      const missing = await runWeb(['query', '--url', hubUrl(hub), 'PatientID=NOPE-9999']);
      assert.equal(missing.code, 1);
      assert.match(missing.output, /0 matches\./);
      assert.equal(hub.stats.queries, before + 1, 'the hub must have actually been asked');
    } finally {
      hub.close();
    }
  }));
});

test('WADO retrieve after a store returns every instance byte-identical', async () => {
  await withCleanEnv(() => withTempDir('dcm-webflow-retrieve', async (dir) => {
    const src = path.join(dir, 'src');
    const received = path.join(dir, 'received');
    const pulled = path.join(dir, 'pulled');
    const manifest = await fixtures(src); // 6 instances
    const studyUid = manifest.studies[0].studyInstanceUid;

    // Retrieval needs the bytes retained, so this hub persists.
    const hub = await startWebServer({ persistDir: received });
    try {
      const sent = await runWeb(['send', src, '--url', hubUrl(hub)]);
      assert.equal(sent.code, 0);
      assert.equal(hub.stats.stored, 6);

      const { code, output } = await runWeb([
        'retrieve', '--url', hubUrl(hub), '--study', studyUid, '--out', pulled,
      ]);

      assert.equal(code, 0);
      assert.match(output, /instances received\s+:\s+6/);
      assert.match(output, /written\s+:\s+6/);
      assert.equal(hub.stats.retrievedInstances, 6);

      // Written count equals stored instance count, on disk, not just in the report.
      const files = fs.readdirSync(pulled, { recursive: true })
        .filter((f) => String(f).endsWith('.dcm'));
      assert.equal(files.length, 6);

      // And the retrieved bytes are the original bytes.
      for (const inst of manifestInstances(manifest)) {
        const retrieved = path.join(pulled, inst.studyUid, inst.seriesUid, `${inst.sopUid}.dcm`);
        assert.ok(fs.existsSync(retrieved), `expected ${retrieved} to exist`);
        assert.equal(
          Buffer.compare(fs.readFileSync(retrieved), fs.readFileSync(inst.sourcePath)), 0,
          `retrieved bytes must be identical to the source for ${inst.sopUid}`
        );
      }
    } finally {
      hub.close();
    }
  }));
});

test('a hub requiring a token refuses an unauthenticated send and names DCM_WEB_TOKEN', async () => {
  await withCleanEnv(() => withTempDir('dcm-webflow-auth', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 2 });

    const hub = await startWebServer({ requireToken: 'test-secret-1' });
    try {
      // withCleanEnv has already removed DCM_WEB_TOKEN, so this send is bare.
      const denied = await runWeb(['send', src, '--url', hubUrl(hub)]);

      assert.equal(denied.code, 1);
      assert.match(denied.output, /files found\s+2/);
      assert.match(denied.output, /acknowledged\s+0/);
      // The guidance must name the env var, not just say "unauthorized".
      assert.match(denied.output, /DCM_WEB_TOKEN/);
      assert.ok(hub.stats.unauthorized >= 1);
      assert.equal(hub.stats.stored, 0, 'nothing may have been stored');

      // With the token in the environment the same hub opens the door.
      process.env.DCM_WEB_TOKEN = 'test-secret-1'; // restored by withCleanEnv
      const ping = await runWeb(['ping', '--url', hubUrl(hub)]);
      assert.equal(ping.code, 0);
      assert.match(ping.output, /OK/);
    } finally {
      hub.close();
    }
  }));
});

test('a partial store is a failure: acknowledged 2, failed 4 with 0xA700, exit 1', async () => {
  // The hub's rejectAfter is per STOW request: with all 6 instances in one
  // request (--chunk 50), 2 are accepted and 4 land in the FailedSOPSequence
  // with reason 42752 (0xA700, out of resources) on an HTTP 202. 0xA700 is
  // retryable in the shared DIMSE status table and web send retries retryable
  // failures (--retry defaults to 1), which would let the next request accept
  // 2 more — so this test pins --retry 0 for a clean single-request assertion.
  // The retried outcome is asserted separately below.
  await withCleanEnv(() => withTempDir('dcm-webflow-partial', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 6 });

    const hub = await startWebServer({ rejectAfter: 2 });
    try {
      const { code, output } = await runWeb([
        'send', src, '--url', hubUrl(hub), '--chunk', '50', '--retry', '0',
      ]);

      assert.equal(code, 1, 'a partial store must exit non-zero');
      assert.match(output, /acknowledged\s+2/);
      assert.match(output, /SHORTFALL: 4 of 6/);
      // Requirement: the failure code is visible in the report, translated.
      assert.match(output, /0xA700/);
      assert.match(output, /out of resources/i);
      assert.equal(hub.stats.stored, 2);
      assert.equal(hub.stats.rejectedParts, 4);
    } finally {
      hub.close();
    }
  }));
});

test('retrying a partial store recovers: each request stores 2 more until whole', async () => {
  // The real default-path semantics the previous test pins away: because
  // rejectAfter counts per request, every retry request stores 2 more. Six
  // instances at 2 per request need the initial attempt plus 2 retries.
  await withCleanEnv(() => withTempDir('dcm-webflow-retry', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 6 });

    const hub = await startWebServer({ rejectAfter: 2 });
    try {
      const { code, output } = await runWeb([
        'send', src, '--url', hubUrl(hub), '--chunk', '50', '--retry', '2',
      ]);

      assert.equal(code, 0, 'retrying the outstanding instances should complete the study');
      assert.match(output, /acknowledged\s+6/);
      // The refusal history must survive so a struggling server stays visible.
      assert.match(output, /needed retrying/i);
      assert.match(output, /0xA700/);
      assert.equal(hub.stats.stored, 6);
    } finally {
      hub.close();
    }
  }));
});

test('a send to a port where nothing listens reports Connection refused, nothing acknowledged', async () => {
  await withCleanEnv(() => withTempDir('dcm-webflow-refused', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 2 });

    const port = await freePort(); // probed and released — nothing listens here

    const { code, output } = await runWeb([
      'send', src, '--url', `http://127.0.0.1:${port}`, '--retry', '0',
    ]);

    assert.equal(code, 1);
    assert.match(output, /Connection refused/);
    assert.match(output, /files found\s+2/);
    assert.match(output, /acknowledged\s+0/);
  }));
});
