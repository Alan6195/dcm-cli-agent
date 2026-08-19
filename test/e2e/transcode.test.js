'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dcmjsDimse = require('dcmjs-dimse');

/**
 * Converting the transfer syntax before sending, and sending in parallel.
 *
 * Both of these are easy to believe are working when they are not. Asking for a
 * transfer syntax is not the same as sending in it — the peer chooses, and a
 * naive implementation transcodes the study and then silently transcodes it
 * straight back to whatever the peer picked first. So these tests assert on
 * what actually landed on the receiver's disk, not on what was requested.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');
const { TransferSyntax } = dcmjsDimse.constants;

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-ts-'));
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js'), dir,
      '--studies', '1', '--series', '1', '--instances', '2'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `fixtures failed: ${res.stderr}`);
  return dir;
}

/** Starts a receiver and resolves once it is listening. */
function startReceiver(port, persistDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [BIN, 'scp', '--port', String(port), '--ae', 'TSTEST', '--persist', persistDir],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = setTimeout(() => resolve(child), 2500);
    child.stderr.on('data', (d) => {
      if (/listening/i.test(d.toString())) { clearTimeout(done); resolve(child); }
    });
    child.on('error', reject);
  });
}

function send(dir, port, extra = []) {
  const res = spawnSync(process.execPath,
    [BIN, 'send', dir, '--host', '127.0.0.1', '--port', String(port),
      '--called-ae', 'TSTEST', '--json', ...extra],
    { encoding: 'utf8' });
  return { status: res.status, json: JSON.parse(res.stdout) };
}

/** Transfer syntax of the first instance the receiver wrote. */
function storedSyntax(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.dcm')) found.push(p);
    }
  };
  walk(dir);
  assert.ok(found.length, 'receiver wrote nothing');
  return dcmjsDimse.Dataset.fromFile(found[0]).getTransferSyntaxUid();
}

test('--transfer-syntax converts the study before it is sent', async (t) => {
  const dir = makeFixture();
  const received = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-rx-'));
  const port = 11341;
  const scp = await startReceiver(port, received);

  t.after(() => {
    scp.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(received, { recursive: true, force: true });
  });

  const { status, json } = send(dir, port, ['--transfer-syntax', 'rle']);

  assert.equal(status, 0, 'the transfer should succeed');
  assert.equal(json.acknowledged, json.found, 'every instance acknowledged');
  assert.equal(
    storedSyntax(received),
    TransferSyntax.RleLossless,
    'the receiver must end up holding RLE, not the original syntax'
  );
});

test('without --transfer-syntax the study is sent as stored', async (t) => {
  const dir = makeFixture();
  const received = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-rx-'));
  const port = 11342;
  const scp = await startReceiver(port, received);

  t.after(() => {
    scp.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(received, { recursive: true, force: true });
  });

  const { status } = send(dir, port);
  assert.equal(status, 0);
  const uid = storedSyntax(received);
  assert.ok(
    uid === TransferSyntax.ImplicitVRLittleEndian || uid === TransferSyntax.ExplicitVRLittleEndian,
    `expected an uncompressed syntax, got ${uid}`
  );
});

test('--parallel keeps the accounting exact', async (t) => {
  const dir = makeFixture();
  const received = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-rx-'));
  const port = 11343;
  const scp = await startReceiver(port, received);

  t.after(() => {
    scp.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(received, { recursive: true, force: true });
  });

  // Concurrency must not lose or double-count an instance: every file found
  // still has to end with exactly one outcome.
  const { status, json } = send(dir, port, ['--parallel', '4', '--chunk', '1']);
  assert.equal(status, 0);
  assert.equal(json.acknowledged, json.found);
  assert.equal(json.parallel, 4);
});

test('--parallel rejects a value the receiver could never honour', () => {
  const res = spawnSync(process.execPath,
    [BIN, 'send', '/tmp', '--host', 'h', '--port', '104', '--called-ae', 'A', '--parallel', '99'],
    { encoding: 'utf8' });
  assert.equal(res.status, 2, 'a bad --parallel is a usage error');
  assert.match(res.stderr, /between 1 and 16/);
});
