'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A closed output pipe must not crash the tool.
 *
 * Piping report output into a reader that stops early — `dcm info | head`, or
 * quitting a pager after the first screen — tears down the pipe, and the next
 * write to it raises EPIPE. Left unhandled, Node turns that into a thrown
 * 'error' event and the tool exits with a stack trace that reads as if it
 * broke, when all that happened is somebody saw enough output. These tests pin
 * the graceful behaviour so the guard in log.js cannot silently regress.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');

/** A folder with enough DICOM in it that a report is many lines long. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-pipe-'));
  const script = path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js');
  const res = spawnSync(
    process.execPath,
    [script, dir, '--studies', '2', '--series', '3', '--instances', '4'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `fixture generation failed: ${res.stderr}`);
  return dir;
}

/**
 * Runs `dcm <args>` with stdout piped into a reader that reads one line and
 * closes, forcing EPIPE on the writer. Resolves with the writer's stderr and
 * exit code.
 */
function runWithEarlyClosingReader(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    // Read the first chunk, then destroy our end of the pipe. The next write
    // the child attempts hits a closed pipe.
    child.stdout.once('data', () => {
      child.stdout.destroy();
    });

    child.on('close', (code) => resolve({ stderr, code }));
  });
}

test('info piped into a reader that closes early does not crash', async () => {
  const dir = makeFixture();
  try {
    const { stderr } = await runWithEarlyClosingReader(['info', dir, '--series']);
    assert.doesNotMatch(stderr, /EPIPE/, `EPIPE leaked to stderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/, `crashed on a closed pipe:\n${stderr}`);
    assert.doesNotMatch(stderr, /throw er;/, `threw on a closed pipe:\n${stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tags piped into a reader that closes early does not crash', async () => {
  const dir = makeFixture();
  try {
    const { stderr } = await runWithEarlyClosingReader(['tags', dir, '--all']);
    assert.doesNotMatch(stderr, /EPIPE/, `EPIPE leaked to stderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/, `crashed on a closed pipe:\n${stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
