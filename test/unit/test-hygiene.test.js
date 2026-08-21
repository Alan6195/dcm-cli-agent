'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Guards against a test suite that passes on the machine that wrote it and
 * fails everywhere else.
 *
 * This exists because it happened. Twelve MPPS tests read a study from a
 * `fixtures/` directory at the repo root — a directory that `.gitignore`
 * excludes precisely so nobody commits DICOM. On the machine that wrote them
 * it was there, left over from an earlier run, and the suite reported 585
 * passing. In CI there was no such directory and every one of those tests
 * failed, which took the whole release with it: the four CLI binaries never
 * built, and v0.12.0 published with the desktop installers alone.
 *
 * The failure mode is worse than a broken test. A suite that reads state it
 * did not create reports a pass that means nothing, which is the same false
 * pass this tool exists to stop other people from shipping.
 *
 * The rule the rest of the suite already follows: a test creates what it
 * needs, inside withTempDir, with tools/make-fixtures.js. test/e2e/transfer.js
 * has done that from the beginning.
 */

const TEST_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Every *.test.js under test/, recursively. */
function testFiles(dir = TEST_ROOT) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/**
 * Matches a path expression that climbs out of test/ and back down into a
 * directory at the repo root — `path.resolve(__dirname, '..', '..', 'x')` and
 * its join/relative spellings. A temp directory named 'fixtures' inside
 * withTempDir is fine and common; this is only about reaching the repo root.
 */
const CLIMB_TO_ROOT = /['"]\.\.['"]\s*,\s*['"]\.\.['"]\s*,\s*['"]([^'"]+)['"]/g;

/**
 * The other spelling, and the one that hid from the first version of this
 * guard: a bare relative literal like './fixtures/study-1' handed to a command
 * as an argument. Node resolves it against process.cwd(), which is the repo
 * root under `npm test`, so it reaches exactly the same untracked directory by
 * a route the climb pattern never sees. A trailing slash is required so that
 * path.join(dir, 'fixtures') — a temp directory that merely shares the name —
 * does not trip it.
 */
const RELATIVE_LITERAL = /['"]\.?\/?([A-Za-z0-9._-]+)\//g;

/** Directories at the repo root that git does not track. */
function ignoredAtRoot() {
  const ignored = new Set();
  const gitignore = path.join(REPO_ROOT, '.gitignore');
  if (!fs.existsSync(gitignore)) return ignored;
  for (const raw of fs.readFileSync(gitignore, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Only plain directory entries matter here: `fixtures/`, `dist/`.
    if (line.endsWith('/') && !line.includes('*')) ignored.add(line.slice(0, -1));
  }
  return ignored;
}

test('no test reads a directory that git does not track', () => {
  const ignored = ignoredAtRoot();
  assert.ok(ignored.size > 0, 'the .gitignore parse found nothing, so this guard would pass vacuously');

  const offenders = [];
  for (const file of testFiles()) {
    // This file necessarily quotes the very pattern it hunts for, in the
    // comments explaining what went wrong. Excluding it is not a loophole:
    // it asserts nothing about fixtures and reads no study.
    if (path.resolve(file) === path.resolve(__filename)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const seen = new Set();
    for (const pattern of [CLIMB_TO_ROOT, RELATIVE_LITERAL]) {
      for (const match of source.matchAll(pattern)) {
        const target = match[1];
        // tools/ and src/ are tracked and are legitimate things for a test to
        // reach: make-fixtures lives in one and the code under test in another.
        if (ignored.has(target) && !seen.has(target)) {
          seen.add(target);
          offenders.push(`${path.relative(REPO_ROOT, file)} reads ./${target}/`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These tests read a gitignored directory at the repo root, so they pass only on a\n' +
      'machine where that directory happens to exist and fail in CI:\n  ' +
      offenders.join('\n  ') +
      '\nGenerate what the test needs instead: withTempDir + generate() from\n' +
      'tools/make-fixtures.js, the way test/e2e/transfer.test.js does.'
  );
});

test('the fixture generator is reachable from tests, so there is no excuse', () => {
  const generator = path.join(REPO_ROOT, 'tools', 'make-fixtures.js');
  assert.ok(fs.existsSync(generator), 'tools/make-fixtures.js is what tests build studies with');
  const { generate } = require(generator);
  assert.equal(typeof generate, 'function');
});
