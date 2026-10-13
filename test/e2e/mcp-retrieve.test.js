'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { z } = require('zod');
const rt = require('../../src/commands/mcp/runtime');
const toolsDimse = require('../../src/commands/mcp/tools-dimse');
const { generate } = require('../../tools/make-fixtures');
const { startScp, freePort } = require('../helpers/harness');

/**
 * The dcm_get and dcm_move MCP tools, driven in-process against the shipped
 * loopback Q/R receiver.
 *
 * What these prove that the command-level e2e tests do not: the TOOL layer's
 * presentation of a retrieve. The ordinary jsonResult helper discards the JSON
 * document on a non-zero exit and hands back stderr — exactly backwards here,
 * because the most important reason these two commands exit non-zero is an
 * accepted-but-lossy retrieve, and the shortfall, the counts and the problems
 * live nowhere but in that document. So an assistant driving these tools must
 * get the envelope on failure as well as on success, and must be told in words
 * that a shortfall means the study is incomplete. A tool that reported the
 * shortfall case as a bare error string would invite the model to retry until
 * a run "worked", or worse, to summarise the peer's count as the result.
 *
 * Handlers are called directly with a fake server, so these run without the
 * stdio transport. test/e2e/mcp-dimse.test.js covers that path for the tool set
 * as a whole.
 */

const tools = new Map();
toolsDimse.register(
  { registerTool: (name, config, handler) => tools.set(name, handler), registerResource() {} },
  z,
  rt
);
const call = (name, args) => tools.get(name)(args);

/** Every .dcm file under a directory. */
function countDcm(root) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.dcm')) n += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return n;
}

let root;
let serveDir;
let manifest;
let studyUid;
let total;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-retrieve-'));
  serveDir = path.join(root, 'serve');
  // outDir is always explicit: generate() otherwise defaults to the repo and
  // starts by clearing it.
  manifest = await generate({ outDir: serveDir, quiet: true });
  studyUid = manifest.studies[0].studyInstanceUid;
  total = countDcm(serveDir);
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('dcm_get retrieves a study and returns the accounting envelope', async () => {
  const scp = await startScp({ ae: 'QR-SCP', serve: serveDir });
  try {
    const outDir = path.join(root, 'got');
    const res = await call('dcm_get', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid, outDir,
    });
    const env = res.structuredContent;
    assert.equal(res.isError, false, res.content[0].text.slice(-600));
    assert.equal(env.written, total);
    assert.equal(countDcm(outDir), total);
    assert.equal(env.reported.completed, total);
    assert.equal(env.shortfall, 0);
    assert.ok(fs.existsSync(path.join(outDir, studyUid)), 'laid out as study/series/sop');
    assert.equal(scp.stats.gets, 1);
  } finally {
    scp.close();
  }
});

test('dcm_get narrows to a series when given one', async () => {
  const scp = await startScp({ ae: 'QR-SCP', serve: serveDir });
  try {
    const series = manifest.studies[0].series[0];
    const outDir = path.join(root, 'got-series');
    const res = await call('dcm_get', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP',
      studyUid, seriesUid: series.seriesInstanceUid, outDir,
    });
    const env = res.structuredContent;
    assert.equal(res.isError, false, res.content[0].text.slice(-600));
    assert.equal(env.level, 'SERIES');
    assert.ok(env.written > 0 && env.written < total, `a series is part of the study, got ${env.written}/${total}`);
  } finally {
    scp.close();
  }
});

test('a shortfall is an error that keeps the envelope and says the study is incomplete', async () => {
  // The peer over-reports by three. The tool must not hand the model a bare
  // error string here: the numbers that say WHAT is missing are in the
  // envelope, and the prose has to say plainly that this is not a success.
  const scp = await startScp({ ae: 'QR-SCP', serve: serveDir, retrieveOvercount: 3 });
  try {
    const outDir = path.join(root, 'got-short');
    const res = await call('dcm_get', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid, outDir,
    });
    const env = res.structuredContent;
    const text = res.content[0].text;
    assert.equal(res.isError, true, 'an accepted-but-lossy retrieve must surface as an error');
    assert.ok(env, 'the envelope must survive a non-zero exit — the shortfall lives nowhere else');
    assert.equal(env.shortfall, 3);
    assert.equal(env.written, total);
    assert.match(text, /SHORTFALL: 3 instance\(s\)/);
    assert.match(text, /THE STUDY IS INCOMPLETE/);
  } finally {
    scp.close();
  }
});

test('dcm_move to a destination the peer does not know is an error carrying 0xA801', async () => {
  const scp = await startScp({ ae: 'QR-SCP', serve: serveDir });
  try {
    const res = await call('dcm_move', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid,
      destinationAe: 'NO-SUCH-AE',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.status, 0xa801);
    assert.equal(scp.stats.movesRefused, 1);
  } finally {
    scp.close();
  }
});

test('dcm_move with a self-receiver verifies what arrived', async () => {
  const recvPort = await freePort();
  const recvDir = path.join(root, 'moved');
  const scp = await startScp({
    ae: 'QR-SCP', serve: serveDir,
    destinations: { 'DEST-AE': { host: '127.0.0.1', port: recvPort } },
  });
  try {
    const res = await call('dcm_move', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid,
      destinationAe: 'DEST-AE', receiveDir: recvDir, receivePort: recvPort,
    });
    const env = res.structuredContent;
    assert.equal(res.isError, false, res.content[0].text.slice(-600));
    assert.equal(env.arrived, total);
    assert.equal(env.verified, true);
    assert.equal(countDcm(recvDir), total);
  } finally {
    scp.close();
  }
});

test('dcm_move to a third party reports success without claiming to have verified it', async () => {
  // A real receiver stands in for the third party, so the move genuinely
  // completes. The point is that THIS tool has no local disk to check and must
  // say so, rather than letting a 0 exit read as "the study arrived intact".
  const sinkDir = path.join(root, 'third-party-sink');
  fs.mkdirSync(sinkDir, { recursive: true });
  const sink = await startScp({ ae: 'DEST-AE', persist: sinkDir });
  const scp = await startScp({
    ae: 'QR-SCP', serve: serveDir,
    destinations: { 'DEST-AE': { host: '127.0.0.1', port: sink.port } },
  });
  try {
    const res = await call('dcm_move', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid,
      destinationAe: 'DEST-AE',
    });
    const env = res.structuredContent;
    const text = res.content[0].text.replace(/\s+/g, ' ');
    assert.equal(res.isError, false, text.slice(-600));
    assert.equal(env.verified, false);
    assert.equal(env.arrived, null);
    assert.match(text, /no local folder to check/);
  } finally {
    scp.close();
    sink.close();
  }
});

test('a peer that does not serve retrieves is an error, not an empty success', async () => {
  const scp = await startScp({ ae: 'PLAIN-SCP' });
  try {
    const res = await call('dcm_get', {
      host: '127.0.0.1', port: scp.port, calledAe: 'PLAIN-SCP', studyUid,
      outDir: path.join(root, 'got-refused'),
    });
    assert.equal(res.isError, true);
  } finally {
    scp.close();
  }
});

test('the refusals the commands own reach the model as errors that name the way out', async () => {
  const scp = await startScp({ ae: 'QR-SCP', serve: serveDir });
  try {
    const noTarget = await call('dcm_move', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid,
    });
    assert.equal(noTarget.isError, true);
    assert.match(noTarget.content[0].text, /dcm get/, 'a move with nowhere to go should point at C-GET');

    const badLevel = await call('dcm_get', {
      host: '127.0.0.1', port: scp.port, calledAe: 'QR-SCP', studyUid,
      instanceUid: '1.2.3', outDir: path.join(root, 'nope'),
    });
    assert.equal(badLevel.isError, true);
  } finally {
    scp.close();
  }
});
