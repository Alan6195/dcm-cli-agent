'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const update = require('../../src/commands/update');
const versions = require('../../src/lib/version');
const release = require('../../src/lib/release');
const { tokenize, UsageError } = require('../../src/lib/args');

/**
 * `dcm update` replaces the binary the user runs. Nothing here touches the
 * network: every decision that matters — is this newer, which file do I want,
 * does the checksum match, may I replace this file, where does it land — is a
 * pure function or a filesystem operation, and those are the parts tested.
 */

// --- version ordering -------------------------------------------------------

test('a later release is newer, in every position', () => {
  assert.equal(versions.isNewer('0.9.0', '0.8.0'), true);
  assert.equal(versions.isNewer('0.8.1', '0.8.0'), true);
  assert.equal(versions.isNewer('1.0.0', '0.99.99'), true);
  assert.equal(versions.isNewer('0.10.0', '0.9.0'), true, '10 > 9, not "10" < "9"');
});

test('the same version is not an update, with or without the v prefix', () => {
  assert.equal(versions.compare('v0.8.0', '0.8.0'), 0);
  assert.equal(versions.isNewer('v0.8.0', '0.8.0'), false);
  assert.equal(versions.isNewer('0.8.0', 'v0.8.0'), false);
});

test('an older release is not an update', () => {
  assert.equal(versions.isNewer('v0.7.0', '0.8.0'), false);
  assert.ok(versions.compare('v0.7.0', '0.8.0') < 0);
});

test('missing components count as zero', () => {
  assert.equal(versions.compare('1', '1.0.0'), 0);
  assert.equal(versions.compare('1.2', '1.2.0'), 0);
  assert.ok(versions.compare('1.2', '1.2.1') < 0);
});

test('a prerelease sorts below the release it leads up to', () => {
  // The defect the desktop app's parseInt comparison has: 0.9.0-rc.1 there
  // reads as exactly 0.9.0, so the real 0.9.0 never looks like an update.
  assert.ok(versions.compare('0.9.0-rc.1', '0.9.0') < 0);
  assert.equal(versions.isNewer('0.9.0', '0.9.0-rc.1'), true);
  assert.equal(versions.isNewer('0.9.0-rc.1', '0.8.0'), true);
});

test('prerelease identifiers compare numerically, not as strings', () => {
  assert.ok(versions.compare('0.9.0-rc.2', '0.9.0-rc.10') < 0);
  assert.ok(versions.compare('0.9.0-rc.1', '0.9.0-rc.1') === 0);
  assert.ok(versions.compare('0.9.0-alpha', '0.9.0-beta') < 0);
});

test('build metadata is ignored', () => {
  assert.equal(versions.compare('0.9.0+build.7', '0.9.0'), 0);
});

test('a malformed version throws rather than being guessed at', () => {
  // Silently reading an unparseable tag as 0.0.0 would either hide a real
  // release or offer a downgrade.
  assert.throws(() => versions.compare('not-a-version', '0.8.0'), /not a version/);
  assert.throws(() => versions.compare('0.8.0', ''), /not a version/);
  assert.throws(() => versions.compare('0.8.0', undefined), /not a version/);
  assert.equal(versions.parse('latest').valid, false);
  assert.equal(versions.parse('v0.8.0').valid, true);
});

test('normalize gives one spelling of a version', () => {
  assert.equal(versions.normalize('v0.9.0'), '0.9.0');
  assert.equal(versions.normalize('0.9.0+build.2'), '0.9.0');
  assert.equal(versions.normalize('v1.2'), '1.2.0');
  assert.equal(versions.normalize('v0.9.0-rc.1'), '0.9.0-rc.1');
});

// --- asset selection --------------------------------------------------------

test('each platform and arch picks the asset the release workflow publishes', () => {
  // These names come from the matrix in .github/workflows/release.yml. If that
  // changes and this does not, dcm update 404s on every machine.
  assert.equal(update.assetNameFor('win32', 'x64'), 'dcm-windows-x64.exe');
  assert.equal(update.assetNameFor('darwin', 'arm64'), 'dcm-macos-arm64');
  assert.equal(update.assetNameFor('darwin', 'x64'), 'dcm-macos-x64');
  assert.equal(update.assetNameFor('linux', 'x64'), 'dcm-linux-x64');
});

test('Windows on arm64 takes the x64 build, which it emulates', () => {
  assert.equal(update.assetNameFor('win32', 'arm64'), 'dcm-windows-x64.exe');
});

test('platforms with no published build get null rather than a wrong guess', () => {
  assert.equal(update.assetNameFor('linux', 'arm64'), null, 'there is no linux-arm64 build');
  assert.equal(update.assetNameFor('win32', 'ia32'), null);
  assert.equal(update.assetNameFor('darwin', 'ppc'), null);
  assert.equal(update.assetNameFor('freebsd', 'x64'), null);
  assert.equal(update.assetNameFor('aix', 'ppc64'), null);
});

test('an asset is found by exact name, or not at found at all', () => {
  const rel = {
    assets: [
      { name: 'dcm-linux-x64', browser_download_url: 'https://example/linux' },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://example/sums' },
    ],
  };
  assert.equal(update.pickAsset(rel, 'dcm-linux-x64').browser_download_url, 'https://example/linux');
  assert.equal(update.pickAsset(rel, 'dcm-macos-x64'), null);
  assert.equal(update.pickAsset({}, 'anything'), null);
  assert.deepEqual(update.assetNames(rel), ['dcm-linux-x64', 'SHA256SUMS.txt']);
});

// --- SHA256SUMS.txt ---------------------------------------------------------

const SUMS = [
  '1111111111111111111111111111111111111111111111111111111111111111  dcm-linux-x64',
  '2222222222222222222222222222222222222222222222222222222222222222 *dcm-windows-x64.exe',
  '3333333333333333333333333333333333333333333333333333333333333333  dcm-macos-arm64',
].join('\n');

test('a GNU sha256sum file parses into name to digest', () => {
  const sums = update.parseSums(SUMS);
  assert.equal(sums.size, 3);
  assert.equal(sums.get('dcm-linux-x64'), '1'.repeat(64));
  assert.equal(sums.get('dcm-macos-arm64'), '3'.repeat(64));
});

test('the binary-mode asterisk is not part of the name', () => {
  assert.equal(update.expectedSum(SUMS, 'dcm-windows-x64.exe'), '2'.repeat(64));
  assert.equal(update.expectedSum(SUMS, '*dcm-windows-x64.exe'), null);
});

test('CRLF endings and trailing blank lines parse', () => {
  const text = SUMS.split('\n').join('\r\n') + '\r\n\r\n';
  assert.equal(update.expectedSum(text, 'dcm-linux-x64'), '1'.repeat(64));
});

test('digests are lower-cased so the comparison cannot fail on case alone', () => {
  const text = `${'A'.repeat(64)}  dcm-linux-x64`;
  assert.equal(update.expectedSum(text, 'dcm-linux-x64'), 'a'.repeat(64));
});

test('a missing entry is null, not a near miss', () => {
  // A substring match — what both shipped installers do — would answer
  // dcm-macos-x64 with the dcm-macos-x64.sig line, or the other way round.
  const text = [
    `${'4'.repeat(64)}  dcm-macos-x64.sig`,
    `${'5'.repeat(64)}  dcm-linux-x64`,
  ].join('\n');
  assert.equal(update.expectedSum(text, 'dcm-macos-x64'), null);
  assert.equal(update.expectedSum(SUMS, 'dcm-macos-x64'), null);
  assert.equal(update.expectedSum('', 'dcm-linux-x64'), null);
});

test('a mismatched digest is visible as a mismatch', () => {
  // The comparison the command makes: published value against what was hashed.
  const published = update.expectedSum(SUMS, 'dcm-linux-x64');
  assert.notEqual(published, '9'.repeat(64));
  assert.equal(published, '1'.repeat(64));
});

test('junk lines are skipped rather than parsed into a bogus digest', () => {
  const text = [
    '# a comment nobody writes but which must not become a checksum',
    'deadbeef  dcm-linux-x64',
    `${'6'.repeat(64)}  dcm-linux-x64`,
  ].join('\n');
  assert.equal(update.expectedSum(text, 'dcm-linux-x64'), '6'.repeat(64));
});

// --- run mode ---------------------------------------------------------------

test('a packaged executable is the only mode that may replace itself', () => {
  const detected = update.detectRuntime({ sea: true, root: 'C:\\anywhere', execPath: '/x/dcm' });
  assert.equal(detected.mode, 'sea');
  assert.equal(detected.exePath, '/x/dcm');
});

test('a source checkout is detected by the files npm does not publish', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-checkout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const root = path.join(dir, 'dcm-cli-agent');
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'build.js'), '// build');

  assert.equal(update.detectRuntime({ sea: false, root }).mode, 'checkout');
});

test('an npm install is detected by its node_modules parent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-npm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // What `npm install -g` produces: <prefix>/lib/node_modules/dcm-cli-agent,
  // with only the published files in it.
  const root = path.join(dir, 'lib', 'node_modules', 'dcm-cli-agent');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  assert.equal(update.detectRuntime({ sea: false, root }).mode, 'npm');
});

test('a checkout that happens to sit under node_modules is still a checkout', (t) => {
  // tools/ is never in the published tarball, so its presence outranks layout.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-linked-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const root = path.join(dir, 'node_modules', 'dcm-cli-agent');
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'build.js'), '// build');

  assert.equal(update.detectRuntime({ sea: false, root }).mode, 'checkout');
});

test('this repo, run under node, detects as a checkout', () => {
  // The real thing rather than a fabricated directory: the test suite runs
  // from a clone, so this is the mode `dcm update` must refuse in.
  assert.equal(update.detectRuntime({ sea: false }).mode, 'checkout');
});

// --- flag resolution --------------------------------------------------------

/** The command sees positionals with its own name already removed. */
function opts(...argv) {
  return update.resolveOptions(tokenize(argv));
}

test('the defaults are: latest release, this project, nothing changed unasked', () => {
  const resolved = opts();
  assert.equal(resolved.check, false);
  assert.equal(resolved.dryRun, false);
  assert.equal(resolved.force, false);
  assert.equal(resolved.tag, undefined);
  assert.equal(resolved.dir, undefined);
  assert.equal(resolved.json, false);
  assert.equal(resolved.repo, release.DEFAULT_REPO);
});

test('--version reaches the command instead of printing the CLI version', () => {
  // --version is also the global "print the version" flag. cli.js only honours
  // that when there are no positionals, and `update` is one, so it arrives here.
  assert.equal(opts('--version', 'v0.7.0').tag, 'v0.7.0');
  assert.equal(opts('--version=v0.7.0').tag, 'v0.7.0');
});

test('--check --json --force --dir all resolve', () => {
  const resolved = opts('--check', '--json', '--force', '--dir', 'C:\\tools\\dcm');
  assert.equal(resolved.check, true);
  assert.equal(resolved.json, true);
  assert.equal(resolved.force, true);
  assert.equal(resolved.dir, 'C:\\tools\\dcm');
});

test('--version with no value is a usage error, not a silent "latest"', () => {
  assert.throws(() => opts('--version'), UsageError);
  assert.throws(() => opts('--version'), /expects a value/);
});

test('a tag that is not tag-shaped is refused before it reaches a URL', () => {
  assert.throws(() => opts('--version', '../../other/repo'), UsageError);
  assert.throws(() => opts('--version', 'v0.9.0 --force'), /release tag/);
});

test('--repo must be owner/name', () => {
  assert.throws(() => opts('--repo', 'notarepo'), UsageError);
  assert.throws(() => opts('--repo', 'a/b/c'), /owner\/name/);
  assert.equal(opts('--repo', 'someone/dcm-cli-agent').repo, 'someone/dcm-cli-agent');
});

test('--check and --dry-run together are refused rather than silently ranked', () => {
  assert.throws(() => opts('--check', '--dry-run'), UsageError);
});

test('DCM_UPDATE_REPO is honoured when --repo is absent', (t) => {
  const before = process.env.DCM_UPDATE_REPO;
  t.after(() => {
    if (before === undefined) delete process.env.DCM_UPDATE_REPO;
    else process.env.DCM_UPDATE_REPO = before;
  });

  process.env.DCM_UPDATE_REPO = 'someone/fork';
  assert.equal(opts().repo, 'someone/fork');
  assert.equal(opts('--repo', 'other/thing').repo, 'other/thing', 'the flag wins');
});

test('--help short-circuits before anything else happens', async () => {
  const captured = require('../../src/lib/log').beginCapture();
  let code;
  try {
    code = await update.run(tokenize(['--help']));
  } finally {
    require('../../src/lib/log').endCapture();
  }
  assert.equal(code, 0);
  assert.match(captured.out, /dcm update —/);
  assert.match(captured.out, /--check/);
});

// --- the swap ---------------------------------------------------------------

/** A directory holding a pretend installed binary and a pretend download. */
function stagedDir(t, { withTarget = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'dcm.exe');
  const staged = path.join(dir, 'dcm.exe.download-999');
  if (withTarget) fs.writeFileSync(target, 'OLD BINARY');
  fs.writeFileSync(staged, 'NEW BINARY');
  return { dir, target, staged, oldPath: path.join(dir, 'dcm.exe.old-0.8.0') };
}

test('the swap leaves the new binary under the name the old one had', (t) => {
  const { target, staged, oldPath } = stagedDir(t);

  const result = update.swapInPlace({ target, staged, oldPath });

  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW BINARY');
  assert.equal(fs.existsSync(staged), false, 'the temp file must not be left behind');
  assert.equal(result.replaced, true);
  assert.equal(result.leftover, null, 'a deletable old binary is deleted');
  assert.equal(fs.existsSync(oldPath), false);
});

test('the swap works when there is nothing to replace', (t) => {
  const { target, staged, oldPath } = stagedDir(t, { withTarget: false });

  const result = update.swapInPlace({ target, staged, oldPath });

  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW BINARY');
  assert.equal(result.replaced, false);
  assert.equal(result.leftover, null);
});

test('a failed move puts the old binary back, so the user is never left with none', (t) => {
  const { target, oldPath, dir } = stagedDir(t, { withTarget: true });
  const missing = path.join(dir, 'never-downloaded');

  assert.throws(
    () => update.swapInPlace({ target, staged: missing, oldPath }),
    /ENOENT/
  );

  // The whole point: the working binary is back where it was, under its name.
  assert.equal(fs.existsSync(target), true, 'the old binary must be restored');
  assert.equal(fs.readFileSync(target, 'utf8'), 'OLD BINARY');
  assert.equal(fs.existsSync(oldPath), false, 'nothing renamed aside is left behind');
});

test('an unrecoverable swap is reported as such, with both paths', (t) => {
  const { target, oldPath, dir } = stagedDir(t);
  const missing = path.join(dir, 'never-downloaded');

  // Force the rollback to fail too, by putting something in the way that
  // cannot be renamed over on any platform: a non-empty directory.
  const blockerDir = target;
  fs.rmSync(blockerDir);
  fs.writeFileSync(oldPath, 'OLD BINARY');
  fs.mkdirSync(blockerDir);
  fs.writeFileSync(path.join(blockerDir, 'in-the-way'), 'x');

  // target exists (as a directory), so the aside-rename is attempted first.
  const err = (() => {
    try {
      update.swapInPlace({ target, staged: missing, oldPath });
      return null;
    } catch (e) {
      return e;
    }
  })();

  assert.ok(err, 'the caller must be told');
  // Either the first rename or the rollback failed; both are exit-1 paths and
  // the second one has to carry the paths needed to repair it by hand.
  if (err.code === 'DCM_ROLLBACK_FAILED') {
    assert.equal(err.target, target);
    assert.equal(err.oldPath, oldPath);
    assert.match(err.message, /could not restore the old one/);
  }
});

test('the displaced binary is named after the version it holds', (t) => {
  const { dir } = stagedDir(t);
  const first = update.oldPathFor(dir, 'dcm.exe', '0.8.0');
  assert.equal(path.basename(first), 'dcm.exe.old-0.8.0');

  // A second update before the first leftover could be deleted must not try to
  // rename onto a file that is still mapped by a running process.
  fs.writeFileSync(first, 'stuck');
  const second = update.oldPathFor(dir, 'dcm.exe', '0.8.0');
  assert.notEqual(second, first);
  assert.match(path.basename(second), /^dcm\.exe\.old-0\.8\.0-\d+$/);
});

// --- sweeping leftovers -----------------------------------------------------

test('leftovers are matched by name, and nothing else is', () => {
  const pattern = update.stalePattern('dcm.exe');
  assert.equal(pattern.test('dcm.exe.old-0.8.0'), true);
  assert.equal(pattern.test('dcm.exe.old-0.8.0-1234'), true);
  assert.equal(pattern.test('dcm.exe.download-4321'), true);

  assert.equal(pattern.test('dcm.exe'), false, 'the installed binary is not a leftover');
  assert.equal(pattern.test('dcm.exe.config'), false);
  assert.equal(pattern.test('dcmXexe.old-1'), false, 'the dot must be a dot');
  assert.equal(pattern.test('other.exe.old-0.8.0'), false);

  const posix = update.stalePattern('dcm');
  assert.equal(posix.test('dcm.old-0.8.0'), true);
  assert.equal(posix.test('dcm'), false);
  assert.equal(posix.test('dcm.exe'), false);
});

test('a later run deletes what the previous one could not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'dcm.exe'), 'current');
  fs.writeFileSync(path.join(dir, 'dcm.exe.old-0.7.0'), 'previous');
  fs.writeFileSync(path.join(dir, 'dcm.exe.download-31337'), 'half a download');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'someone else’s file');

  const removed = update.sweepStale(dir, 'dcm.exe');

  assert.equal(removed.length, 2);
  assert.equal(fs.existsSync(path.join(dir, 'dcm.exe')), true, 'never the live binary');
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true, 'never anything else');
  assert.equal(fs.existsSync(path.join(dir, 'dcm.exe.old-0.7.0')), false);
  assert.equal(fs.existsSync(path.join(dir, 'dcm.exe.download-31337')), false);
});

test('the sweep leaves a download that is still in flight alone', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-sweep-mine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mine = path.join(dir, 'dcm.exe.download-1');
  fs.writeFileSync(mine, 'downloading right now');
  fs.writeFileSync(path.join(dir, 'dcm.exe.download-2'), 'abandoned');

  const removed = update.sweepStale(dir, 'dcm.exe', mine);

  assert.deepEqual(removed, [path.join(dir, 'dcm.exe.download-2')]);
  assert.equal(fs.existsSync(mine), true);
});

test('sweeping a directory that is not there is not an error', () => {
  const missing = path.join(os.tmpdir(), 'dcm-update-no-such-dir-9182736');
  assert.deepEqual(update.sweepStale(missing, 'dcm.exe'), []);
});

// --- download and verification, against a fake fetch ------------------------

test('a download is written to disk and hashed in the same pass', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const payload = Buffer.from('pretend this is 90 MB of executable');
  const dest = path.join(dir, 'dcm.exe.download-1');

  const fetchImpl = async () =>
    new Response(payload, {
      status: 200,
      headers: { 'content-length': String(payload.length) },
    });

  const result = await release.downloadTo('https://example/asset', dest, { fetchImpl });

  const onDisk = fs.readFileSync(dest);
  assert.deepEqual(onDisk, payload, 'the bytes on disk must be the bytes fetched');
  assert.equal(result.bytes, payload.length);
  assert.equal(
    result.sha256,
    require('crypto').createHash('sha256').update(payload).digest('hex'),
    'the streamed hash must match a hash of the finished file'
  );
});

test('an HTTP failure on the download is a ReleaseError, not a written file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-update-download-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dest = path.join(dir, 'dcm.exe.download-1');
  const fetchImpl = async () => new Response('nope', { status: 404 });

  await assert.rejects(
    () => release.downloadTo('https://example/asset', dest, { fetchImpl }),
    (err) => err instanceof release.ReleaseError && err.kind === 'not-found'
  );
});

test('the API URL is the REST endpoint, and a tag is escaped into it', () => {
  assert.equal(
    release.apiUrl('Alan6195/dcm-cli-agent'),
    'https://api.github.com/repos/Alan6195/dcm-cli-agent/releases/latest'
  );
  assert.equal(
    release.apiUrl('Alan6195/dcm-cli-agent', 'v0.9.0'),
    'https://api.github.com/repos/Alan6195/dcm-cli-agent/releases/tags/v0.9.0'
  );
});

test('a 404 and a spent rate limit are told apart', async () => {
  const notFound = async () => new Response('{}', { status: 404 });
  await assert.rejects(
    () => release.getRelease({ tag: 'v9.9.9', fetchImpl: notFound }),
    (err) => err.kind === 'not-found'
  );

  const limited = async () =>
    new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  await assert.rejects(
    () => release.getRelease({ fetchImpl: limited }),
    (err) => err.kind === 'rate-limited'
  );

  const forbidden = async () =>
    new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '57' } });
  await assert.rejects(
    () => release.getRelease({ fetchImpl: forbidden }),
    (err) => err.kind === 'http'
  );
});

test('transport failures are named rather than reported as "fetch failed"', () => {
  const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match(release.describeNetworkError(dns), /resolve api\.github\.com/);

  const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.match(release.describeNetworkError(refused), /refused/);

  const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  assert.match(release.describeNetworkError(timeout), /did not answer in time/);

  const intercepted = Object.assign(new Error('fetch failed'), {
    cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
  });
  assert.match(release.describeNetworkError(intercepted), /intercepting/);
});
