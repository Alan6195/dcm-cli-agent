'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const log = require('../lib/log');
const args = require('../lib/args');
const release = require('../lib/release');
const versions = require('../lib/version');
const install = require('./install');

const { version } = require('../../package.json');

const FLAGS = ['check', 'version', 'dir', 'force', 'dry-run', 'repo'];

const USAGE = `
dcm update — replace this executable with the latest published release

Downloads the build for this machine from GitHub Releases, checks it against
the SHA256SUMS.txt published alongside it, and only then puts it in place. It
is the CLI counterpart to the desktop app's in-app updates.

Nothing here runs on its own. A tool that talks to clinical networks does not
phone home on ordinary invocations, so a check happens when you ask for one.

Usage:
  dcm update [--check] [--version <tag>] [--dir <path>] [--dry-run] [--json]

Options:
  --check                Report what is available and change nothing.
  --version <tag>        Install a specific release, e.g. v0.7.0. Default: the
                         latest published release.
  --dir <path>           Directory holding the installed binary. Defaults to
                         the folder this executable is running from.
  --force                Reinstall the same version, or go back to an older one.
  --dry-run              Show exactly what would happen. Changes nothing.
  --json                 One JSON document on stdout: currentVersion,
                         latestVersion, updateAvailable, asset.
  --repo <owner/name>    Where to look. For testing.   [env DCM_UPDATE_REPO]

  A GitHub token is optional. It only raises the rate limit, which anonymous
  requests from a shared address can exhaust.          [env DCM_GITHUB_TOKEN]

Examples:
  dcm update --check          # is there a newer one? changes nothing
  dcm update --check --json   # the same answer, for a script
  dcm update                  # fetch it, verify it, install it
  dcm update --version v0.7.0 --force

Note: --check exits 0 whether or not an update exists — it answered the
question either way. Read updateAvailable, not the exit code. Exit 1 means the
installed binary is not the version you asked for: a failed download, a
checksum that did not match, or a directory that could not be written.

Note: on Windows a running .exe cannot be overwritten, so the old one is
renamed aside and the new one takes its name. The rename cannot be deleted
while this process is still running it, so it is swept on the next update. A
leftover .old- file is not a failure and does not change the exit code. The
new version takes effect the next time you run dcm, not in this process.
`.trimStart();

/**
 * The asset name the release workflow publishes for a platform and
 * architecture. Mirrors the matrix in .github/workflows/release.yml, which is
 * the authority; the same table is hard-coded in install.ps1 and install.sh.
 *
 * Windows on arm64 gets the x64 build deliberately: there is no native arm64
 * Windows build, and Windows runs x64 executables under emulation. Linux on
 * arm64 has neither a build nor an emulator, so it gets an honest null.
 *
 * @param {string} platform process.platform
 * @param {string} arch     process.arch
 * @returns {string|null}
 */
function assetNameFor(platform, arch) {
  if (platform === 'win32') {
    return arch === 'x64' || arch === 'arm64' ? 'dcm-windows-x64.exe' : null;
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'dcm-macos-arm64';
    if (arch === 'x64') return 'dcm-macos-x64';
    return null;
  }
  if (platform === 'linux') {
    return arch === 'x64' ? 'dcm-linux-x64' : null;
  }
  return null;
}

/**
 * Parses a GNU `sha256sum` file into name → digest.
 *
 * The publish job runs `sha256sum *` over a flattened directory, so every line
 * is `<64 hex><space><mode indicator><basename>` with LF endings and bare
 * basenames. The `\r` is tolerated because a file that has been through a
 * Windows editor or an odd transfer is not a reason to refuse an update, and
 * the leading `*` (binary mode) is stripped because it is not part of the name.
 *
 * Both shipped installers match with a substring search. This does not: an
 * exact basename lookup cannot accidentally pick up `dcm-macos-x64` when it
 * was asked about `dcm-macos-x64.sig`.
 *
 * @param {string} text
 * @returns {Map<string, string>} Lower-cased digests by asset name.
 */
function parseSums(text) {
  const sums = new Map();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

/**
 * The published digest for one asset, or null when the release does not
 * publish one for it.
 *
 * @param {string} text
 * @param {string} assetName
 * @returns {string|null}
 */
function expectedSum(text, assetName) {
  return parseSums(text).get(assetName) ?? null;
}

/**
 * Finds a named asset on a release.
 *
 * @param {object} rel      Release JSON.
 * @param {string} name
 * @returns {object|null}
 */
function pickAsset(rel, name) {
  const assets = Array.isArray(rel?.assets) ? rel.assets : [];
  return assets.find((a) => a && a.name === name) ?? null;
}

/** Every asset name on a release, for a "there is no build for you" message. */
function assetNames(rel) {
  const assets = Array.isArray(rel?.assets) ? rel.assets : [];
  return assets.map((a) => a?.name).filter(Boolean);
}

/**
 * Works out how this copy of dcm is being run, because that decides whether
 * replacing a file is even the right thing to do.
 *
 *   sea       a packaged single executable — process.execPath IS this tool,
 *             and swapping it is exactly what `dcm update` means
 *   checkout  `node bin/dcm.js` from a clone — process.execPath is Node, and
 *             replacing it would replace the user's Node
 *   npm       installed from the registry — npm owns the files, and writing
 *             into node_modules behind its back would be undone by the next
 *             `npm install`
 *
 * The npm/checkout split uses the published `files` list: the tarball ships
 * only bin/, src/, README and LICENSE, so `tools/build.js` exists in a clone
 * and never in an install. The node_modules parent check catches the same
 * thing from the other side, for a layout that is neither.
 *
 * @param {{sea?: boolean, root?: string, execPath?: string}} [override] For tests.
 * @returns {{mode: 'sea'|'checkout'|'npm', root: string, exePath: string}}
 */
function detectRuntime(override = {}) {
  const exePath = override.execPath ?? process.execPath;
  const root = override.root ?? path.resolve(__dirname, '..', '..');
  const packaged = override.sea ?? install.isPackagedExecutable();

  if (packaged) return { mode: 'sea', root, exePath };

  const underNodeModules = path.basename(path.dirname(root)) === 'node_modules';
  const hasBuildTools = fs.existsSync(path.join(root, 'tools', 'build.js'));
  const mode = hasBuildTools || !underNodeModules ? 'checkout' : 'npm';
  return { mode, root, exePath };
}

/**
 * Matches the files a previous update may have left behind in the install
 * directory: the renamed-aside old binary, and a half-finished download from a
 * run that was interrupted.
 *
 * @param {string} binary `dcm` or `dcm.exe`
 * @returns {RegExp}
 */
function stalePattern(binary) {
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.(old|download)-`);
}

/**
 * Deletes what the last update could not.
 *
 * On Windows the previous binary is still mapped by the process doing the
 * update, so its delete fails and the file survives until a later run — this
 * one. By then nothing has it open and the delete succeeds. Best effort
 * throughout: a leftover file is inert, and failing an update over one would
 * be absurd.
 *
 * @param {string} dir
 * @param {string} binary
 * @param {string} [except] A path to leave alone — our own download in flight.
 * @returns {string[]} What was removed.
 */
function sweepStale(dir, binary, except) {
  const pattern = stalePattern(binary);
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const full = path.join(dir, entry);
    if (except && path.resolve(full) === path.resolve(except)) continue;
    try {
      fs.rmSync(full, { force: true });
      removed.push(full);
    } catch {
      // Still running, or still locked. It will keep.
    }
  }
  return removed;
}

/**
 * Puts the staged binary in place of the target, atomically as far as anything
 * on this filesystem is concerned.
 *
 * Windows refuses to open a running image for writing, which is why this is
 * two renames rather than a copy. A rename only rewrites the directory entry;
 * the running process keeps the file object it already has and carries on
 * unbothered, so the old binary can be moved out from under itself. Both
 * renames stay inside one directory, so neither can turn into a cross-device
 * copy halfway through.
 *
 * If the second rename fails, the first is undone immediately — otherwise the
 * user is left with no `dcm` on their PATH at all, which is far worse than a
 * failed update. A failure to undo it is the one genuinely bad outcome, and it
 * is reported as such rather than swallowed.
 *
 * @param {{target: string, staged: string, oldPath: string}} paths
 * @returns {{replaced: boolean, leftover: string|null}}
 */
function swapInPlace({ target, staged, oldPath }) {
  let movedAside = false;

  if (fs.existsSync(target)) {
    fs.renameSync(target, oldPath);
    movedAside = true;
  }

  try {
    fs.renameSync(staged, target);
  } catch (err) {
    if (movedAside) {
      try {
        fs.renameSync(oldPath, target);
      } catch (rollbackErr) {
        const fatal = new Error(
          `could not put the new binary in place (${err.message}) and could not ` +
            `restore the old one (${rollbackErr.message})`
        );
        fatal.code = 'DCM_ROLLBACK_FAILED';
        fatal.target = target;
        fatal.oldPath = oldPath;
        throw fatal;
      }
    }
    throw err;
  }

  let leftover = null;
  if (movedAside) {
    try {
      fs.rmSync(oldPath, { force: true });
      if (fs.existsSync(oldPath)) leftover = oldPath;
    } catch {
      // Expected in the self-update case: this process is running that file.
      leftover = oldPath;
    }
  }

  return { replaced: movedAside, leftover };
}

/**
 * A name for the displaced binary that will not collide with one an earlier
 * update failed to clean up.
 *
 * @param {string} dir
 * @param {string} binary
 * @param {string} oldVersion
 * @returns {string}
 */
function oldPathFor(dir, binary, oldVersion) {
  const base = path.join(dir, `${binary}.old-${oldVersion}`);
  return fs.existsSync(base) ? `${base}-${process.pid}` : base;
}

/**
 * Reads the command line.
 *
 * Split out so the flag rules — including the ones that throw — can be tested
 * without a network or a filesystem.
 *
 * `--version` needs a word of explanation: it is also the global "print the
 * version" flag, but cli.js only honours that when there are no positionals,
 * and `dcm update` is a positional. So it arrives here intact and means "this
 * release".
 *
 * @param {{flags: Map}} parsed
 * @returns {{check: boolean, tag: string|undefined, dir: string|undefined,
 *   force: boolean, dryRun: boolean, json: boolean, repo: string}}
 */
function resolveOptions(parsed) {
  const { flags } = parsed;

  const check = args.resolve(flags, { name: 'check', type: 'boolean', fallback: false });
  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });
  const force = args.resolve(flags, { name: 'force', type: 'boolean', fallback: false });
  const dir = args.resolve(flags, { name: 'dir' });
  const tag = args.resolve(flags, { name: 'version' });
  const repo = args.resolve(flags, {
    name: 'repo', env: 'DCM_UPDATE_REPO', fallback: release.DEFAULT_REPO,
  });

  if (check && dryRun) {
    throw new args.UsageError('--check and --dry-run both mean "change nothing". Pick one.');
  }

  // A tag goes straight into a URL path. Anything with a slash or whitespace
  // in it is not a tag this project publishes, and quietly requesting a
  // different path than the one that was typed is how surprises happen.
  if (tag !== undefined && !/^[A-Za-z0-9._-]+$/.test(tag)) {
    throw new args.UsageError(
      `--version takes a release tag such as v0.9.0, got "${tag}".`
    );
  }

  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new args.UsageError(`--repo takes owner/name, got "${repo}".`);
  }

  return { check, dryRun, force, dir, tag, repo, json: flags.has('json') };
}

/** Human-sized bytes, matching the way the rest of the tool reports sizes. */
function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Runs the downloaded binary before trusting it with the name `dcm`.
 *
 * This is what tools/build.js does to the binary it has just produced, for the
 * same reason: it costs a couple of hundred milliseconds and it catches a
 * corrupt or wrong-architecture download while the working binary is still in
 * place, so the failure path is nothing more than deleting a temp file.
 *
 * @param {string} binaryPath
 * @returns {string} What it reports as its version.
 */
function smokeTest(binaryPath) {
  const out = execFileSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return String(out).trim();
}

/** Explains a release-fetch failure in terms of what to do about it. */
function reportReleaseError(err, { repo, tag }) {
  if (err.kind === 'not-found') {
    log.error(
      tag
        ? `Release "${tag}" does not exist in ${repo}.`
        : `${repo} has no published releases.`
    );
    log.error(`Releases: https://github.com/${repo}/releases`);
    return;
  }
  if (err.kind === 'rate-limited') {
    log.error('GitHub is rate-limiting this IP address, so the release could not be read.');
    log.error('');
    log.error('Anonymous requests share a small hourly budget per address, which a');
    log.error('shared clinic address can exhaust. Either wait, or set a token:');
    log.error('  DCM_GITHUB_TOKEN=<a personal access token with no scopes>');
    return;
  }
  if (err.kind === 'network') {
    log.error(`Could not reach GitHub: ${err.message}`);
    log.error('');
    log.error('Nothing was changed. This machine needs to reach api.github.com and');
    log.error('objects.githubusercontent.com over HTTPS.');
    log.error('If this network requires an HTTP proxy, note that dcm does not use one —');
    log.error('download the binary from the release page and run `dcm install` instead.');
    return;
  }
  log.error(`Could not read the release: ${err.message}`);
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const opts = resolveOptions(parsed);
  const runtime = detectRuntime();
  const binary = install.binaryName();
  const asset = assetNameFor(process.platform, process.arch);

  // With --json, stdout carries exactly one document and nothing else, so the
  // running commentary moves to stderr rather than corrupting it.
  const say = (msg = '') => (opts.json ? log.info(msg) : log.out(msg));
  const emit = (doc) => {
    if (opts.json) log.out(JSON.stringify(doc, null, 2));
  };

  const installDir = path.resolve(
    opts.dir ?? (runtime.mode === 'sea' ? path.dirname(runtime.exePath) : install.defaultDir())
  );
  const target = path.join(installDir, binary);

  // --- Refuse the modes where replacing a file is the wrong answer ---------
  // A check is only a question, so it is answered in every mode.
  if (!opts.check && runtime.mode !== 'sea') {
    if (runtime.mode === 'checkout') {
      log.error('`dcm update` only works from the packaged executable.');
      log.error('');
      log.error('You are running from a source checkout, where process.execPath is the');
      log.error('Node binary rather than this tool — replacing it would replace your Node.');
      log.error('');
      log.error('Update the checkout instead:');
      log.error('  git pull');
      log.error('  npm ci');
      log.error('  npm run build     # if you want a fresh dist/dcm');
    } else {
      log.error('This copy of dcm is running out of a node_modules tree, so replacing');
      log.error('it here would be undone by the next install. dcm is not published to');
      log.error('npm; the standalone binary is the distributed build, and it updates');
      log.error('itself:');
      log.error(`  https://github.com/${opts.repo}/releases/latest`);
    }
    log.error('');
    log.error('`dcm update --check` still works here and reports what is published.');
    emit({
      currentVersion: version,
      latestVersion: null,
      updateAvailable: false,
      error: `cannot self-update in ${runtime.mode} mode`,
    });
    return 1;
  }

  // --- Sweep what the last update could not delete ------------------------
  // Before the network, because this is the run where the file finally goes,
  // and it should go whether or not there turns out to be anything to install.
  if (runtime.mode === 'sea' && !opts.check && !opts.dryRun) {
    for (const swept of sweepStale(installDir, binary)) {
      log.debug(`removed a leftover from an earlier update: ${swept}`);
    }
  }

  // --- Resolve the release ------------------------------------------------
  let rel;
  try {
    rel = await release.getRelease({
      repo: opts.repo,
      tag: opts.tag,
      token: process.env.DCM_GITHUB_TOKEN,
    });
  } catch (err) {
    reportReleaseError(err, opts);
    emit({
      currentVersion: version,
      latestVersion: null,
      updateAvailable: false,
      error: err.message,
    });
    return 1;
  }

  const tagName = String(rel?.tag_name ?? '');
  let ordering;
  try {
    ordering = versions.compare(tagName, version);
  } catch {
    log.error(
      `The release is tagged "${tagName}", which cannot be compared against this ` +
        `build's version (${version}). Not updating.`
    );
    emit({
      currentVersion: version,
      latestVersion: tagName || null,
      updateAvailable: false,
      error: 'unreadable release tag',
    });
    return 1;
  }

  const latestVersion = versions.normalize(tagName);
  const updateAvailable = ordering > 0;

  // --- --check: answer the question and stop ------------------------------
  if (opts.check) {
    const doc = { currentVersion: version, latestVersion, updateAvailable };
    if (asset && pickAsset(rel, asset)) doc.asset = asset;
    emit(doc);

    if (!opts.json) {
      log.out('');
      log.out(`installed   ${version}`);
      log.out(`published   ${latestVersion}${opts.tag ? ` (${tagName}, as asked)` : ''}`);
      log.out('');
      if (updateAvailable) {
        log.out(`${log.color.green('An update is available.')} Run \`dcm update\` to install it.`);
        if (asset && !pickAsset(rel, asset)) {
          log.out('');
          log.warn(`but that release publishes no ${asset}, so there is nothing to install here`);
        }
      } else if (ordering === 0) {
        log.out('You are on the latest version.');
      } else {
        log.out('This build is newer than the published release.');
      }
    }
    // Answering "yes, there is one" is a successful answer, not a failure.
    return 0;
  }

  // --- Decide whether to do anything at all -------------------------------
  if (ordering === 0 && !opts.force) {
    say('');
    say(`Already on the latest version (${version}). Nothing to do.`);
    emit({ currentVersion: version, latestVersion, updateAvailable: false });
    return 0;
  }
  if (ordering < 0 && !opts.force) {
    log.error(
      `The published release is ${latestVersion}, which is older than this build ` +
        `(${version}). Not going backwards without --force.`
    );
    emit({
      currentVersion: version,
      latestVersion,
      updateAvailable: false,
      error: 'refusing to downgrade without --force',
    });
    return 1;
  }

  // --- Find the build for this machine ------------------------------------
  if (!asset) {
    log.error(`There is no published build for ${process.platform}/${process.arch}.`);
    log.error('');
    log.error('Build it from source instead — Node 22 or newer:');
    log.error(`  git clone https://github.com/${opts.repo}.git`);
    log.error('  cd dcm-cli-agent && npm ci && npm run build');
    emit({
      currentVersion: version,
      latestVersion,
      updateAvailable,
      error: `no build for ${process.platform}/${process.arch}`,
    });
    return 1;
  }

  const binaryAsset = pickAsset(rel, asset);
  if (!binaryAsset) {
    log.error(`Release ${tagName} publishes no asset named ${asset}.`);
    const available = assetNames(rel);
    log.error(available.length ? `It has: ${available.join(', ')}` : 'It has no assets at all.');
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: `no ${asset} on ${tagName}`,
    });
    return 1;
  }

  // --- The checksum, before the 90 MB download ----------------------------
  // Fetched first on purpose: a release with no checksum for this asset is a
  // release this will not install, and finding that out after the download
  // would waste the download.
  const sumsAsset = pickAsset(rel, 'SHA256SUMS.txt');
  let expected = null;
  if (sumsAsset) {
    try {
      expected = expectedSum(await release.fetchText(sumsAsset.browser_download_url), asset);
    } catch (err) {
      log.error(`Could not read SHA256SUMS.txt for ${tagName}: ${err.message}`);
      emit({
        currentVersion: version, latestVersion, updateAvailable, asset,
        error: 'checksum file unreadable',
      });
      return 1;
    }
  }
  if (!expected) {
    log.error(
      sumsAsset
        ? `SHA256SUMS.txt for ${tagName} has no entry for ${asset}.`
        : `Release ${tagName} publishes no SHA256SUMS.txt.`
    );
    log.error('');
    log.error('Not installing. These binaries are not code-signed, so the published');
    log.error('checksum is the only thing that says the file came from this project');
    log.error('and arrived whole. There is deliberately no flag to skip it.');
    log.error('');
    log.error(`Existing binary at ${target} is untouched.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: 'no published checksum for this asset',
    });
    return 1;
  }

  // --- Dry run ------------------------------------------------------------
  // Reads everything above, changes nothing: "changes nothing" is not the same
  // promise as "learns nothing", and the useful part of a dry run is finding
  // out that the asset and its checksum are actually there.
  if (opts.dryRun) {
    log.out('');
    log.out(`install location   ${target}`);
    log.out(`running from       ${runtime.exePath}`);
    log.out(`installed version  ${version}`);
    log.out(`release            ${tagName}`);
    log.out(`asset              ${asset} (${megabytes(binaryAsset.size ?? 0)})`);
    log.out(`published sha256   ${expected}`);
    log.out('');
    log.out('DRY RUN — nothing was changed.');
    log.out('');
    log.out('It would:');
    log.out(`  - download ${asset} to ${installDir} as a temporary file`);
    log.out('  - check its SHA-256 against the published value above');
    log.out('  - run it once to confirm it reports the expected version');
    if (process.platform === 'win32') {
      log.out(`  - rename ${target} aside, then move the new binary into its place`);
      log.out('  - clear the downloaded-from-the-internet mark so SmartScreen stays quiet');
    } else {
      log.out(`  - move the new binary onto ${target}`);
    }
    log.out('  - leave your PATH alone; the file keeps the name it already has');
    return 0;
  }

  // --- Stage the download next to the target ------------------------------
  // Same directory, which does two jobs: the move at the end is a rename on
  // one volume rather than a cross-device copy, and a directory that cannot be
  // written fails here, before anything has been downloaded.
  const staged = path.join(installDir, `${binary}.download-${process.pid}`);
  try {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(staged, '');
  } catch (err) {
    log.error(`Cannot write to ${installDir}: ${err.message}`);
    log.error('');
    if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
      log.error('That directory is not writable by this account. A machine-wide location');
      log.error('needs an elevated terminal (Run as administrator, or sudo); a per-user');
      log.error('one needs nothing at all. Either elevate, or reinstall somewhere you own:');
      log.error('  dcm install              # per-user location, no admin rights needed');
      log.error('  dcm update --dir <path>  # or point it at a directory you can write');
    }
    log.error(`Nothing was downloaded and ${target} is untouched.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: `cannot write to ${installDir}`,
    });
    return 1;
  }

  const discard = () => {
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      // A temp file we could not remove is swept by the next run.
    }
  };

  // --- Download and hash in one pass --------------------------------------
  const expectedSize = Number(binaryAsset.size) || 0;
  say('');
  say(`downloading ${asset}${expectedSize ? ` (${megabytes(expectedSize)})` : ''}`);

  let downloaded;
  try {
    let lastReported = 0;
    downloaded = await release.downloadTo(binaryAsset.browser_download_url, staged, {
      onProgress: (bytes, total) => {
        // Only for a person watching. Piped or redirected output gets the
        // start and end lines and nothing in between.
        if (!process.stderr.isTTY || !total) return;
        const percent = Math.floor((bytes / total) * 100);
        if (percent >= lastReported + 20) {
          lastReported = percent - (percent % 20);
          log.info(`  ${lastReported}%`);
        }
      },
    });
  } catch (err) {
    discard();
    log.error(`Download failed: ${err.message}`);
    log.error(`Nothing was changed. ${target} is untouched.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: `download failed: ${err.message}`,
    });
    return 1;
  }

  if (expectedSize && downloaded.bytes !== expectedSize) {
    discard();
    log.error(
      `The download stopped short: ${downloaded.bytes} bytes of an expected ${expectedSize}.`
    );
    log.error(`Nothing was changed. ${target} is untouched.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: 'truncated download',
    });
    return 1;
  }

  // --- Verify -------------------------------------------------------------
  if (downloaded.sha256 !== expected) {
    discard();
    log.error('CHECKSUM MISMATCH — the download does not match what the release published.');
    log.error('');
    log.error(`  expected  ${expected}`);
    log.error(`  got       ${downloaded.sha256}`);
    log.error('');
    log.error('Not installing, and the download has been deleted.');
    log.error(`${target} is exactly as it was.`);
    log.error('');
    log.error('This is either a corrupted transfer or a file that is not the one this');
    log.error('project published. Try again; if it happens twice, do not install it.');
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: 'checksum mismatch',
    });
    return 1;
  }
  say(`${log.color.green('verified')}  sha256 ${expected.slice(0, 16)}… matches the published checksum`);

  // --- Run it once before trusting it -------------------------------------
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(staged, 0o755);
    } catch (err) {
      discard();
      log.error(`Could not make the download executable: ${err.message}`);
      emit({
        currentVersion: version, latestVersion, updateAvailable, asset,
        error: 'chmod failed',
      });
      return 1;
    }
  }

  let reported;
  try {
    reported = smokeTest(staged);
  } catch (err) {
    discard();
    log.error(`The downloaded binary would not run: ${err.message}`);
    log.error('');
    log.error('The checksum matched, so the file is the published one — it just does not');
    log.error(`run on this machine (${process.platform}/${process.arch}).`);
    log.error(`Nothing was changed. ${target} is untouched.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: 'downloaded binary would not run',
    });
    return 1;
  }

  if (versions.normalize(reported) !== latestVersion) {
    discard();
    log.error(
      `The downloaded binary reports version "${reported}", but ${tagName} should be ` +
        `${latestVersion}. Not installing it.`
    );
    log.error(`Nothing was changed. ${target} is untouched.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: 'version mismatch in the downloaded binary',
    });
    return 1;
  }

  // --- Swap ---------------------------------------------------------------
  let leftover = null;
  try {
    ({ leftover } = swapInPlace({
      target,
      staged,
      oldPath: oldPathFor(installDir, binary, version),
    }));
  } catch (err) {
    if (err.code === 'DCM_ROLLBACK_FAILED') {
      log.error(`${err.message}.`);
      log.error('');
      log.error('This needs a hand. The old binary is sitting next to where it belongs:');
      log.error(
        process.platform === 'win32'
          ? `  move "${err.oldPath}" "${err.target}"`
          : `  mv "${err.oldPath}" "${err.target}"`
      );
      log.error(`and the new one is at ${staged}.`);
      emit({
        currentVersion: version, latestVersion, updateAvailable, asset,
        error: 'the swap failed and could not be rolled back',
      });
      return 1;
    }
    discard();
    log.error(`Could not install the new binary: ${err.message}`);
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      log.error('');
      log.error('That usually means another dcm process has that file open — a receiver');
      log.error('(`dcm scp`), a DICOMweb hub, or an MCP server. Stop it and try again.');
    }
    log.error(`${target} is unchanged.`);
    emit({
      currentVersion: version, latestVersion, updateAvailable, asset,
      error: `swap failed: ${err.message}`,
    });
    return 1;
  }

  // Windows marks anything that came off the internet, and SmartScreen warns
  // on every launch of a marked unsigned executable. A file written by Node
  // carries no such mark, but clearing it costs nothing and covers the case
  // where the filesystem or an endpoint agent added one.
  install.clearMarkOfTheWeb(target);

  say('');
  say(`${log.color.green('installed')}  ${latestVersion} → ${target}`);
  say('');
  // Deliberately not "you are now running 0.9.0": on Windows this process is
  // still executing the file that was renamed aside, and on POSIX it is still
  // the old inode. The new code runs next time, not now.
  say('It takes effect the next time you run dcm. This process is still the old build.');

  if (leftover) {
    log.info(
      `the previous binary is still in use and could not be deleted yet: ${leftover} ` +
        '(the next `dcm update` removes it — this is not a failure)'
    );
  }

  emit({
    currentVersion: version,
    latestVersion,
    updateAvailable: true,
    asset,
    installed: true,
    target,
    ...(leftover ? { leftover } : {}),
  });

  return 0;
}

module.exports = {
  run,
  USAGE,
  // Exported for tests: the pieces that decide what gets downloaded, whether it
  // is trusted, and how it lands.
  assetNameFor,
  parseSums,
  expectedSum,
  pickAsset,
  assetNames,
  detectRuntime,
  stalePattern,
  sweepStale,
  swapInPlace,
  oldPathFor,
  resolveOptions,
};
