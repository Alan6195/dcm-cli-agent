'use strict';

/**
 * Makes sure a folder's node_modules matches its package-lock.json, installing
 * when it does not. Shared by tools/mcp-launch.js and tools/app.js, so a fresh
 * clone (or a `git pull` that moved a dependency) needs no manual
 * `npm install` before Claude Code or the desktop app can start.
 *
 * "Matches" is judged the cheap way: node_modules/.package-lock.json, which
 * npm writes on every install, must exist and be no older than
 * package-lock.json. A pull that changes the lockfile makes it older; a fresh
 * clone has no node_modules at all. Either way the folder gets `npm ci`, which
 * installs exactly what the lockfile says.
 *
 * Install scripts are skipped (--ignore-scripts). Nothing this repo runs needs
 * one, and skipping them means a compromised dependency cannot run code at
 * install time. Electron fetches its binary on first launch instead.
 *
 * The first install takes the better part of a minute, which can be longer
 * than an MCP client waits for a server to connect. So npm runs detached: if
 * the client gives up and kills this process, the install carries on and the
 * next connection attempt finds it either done or still going. A lock file
 * makes that second attempt wait for the running install instead of starting
 * another `npm ci`, which would delete node_modules out from under it.
 *
 * Every byte npm prints goes to stderr. Under `dcm mcp`, stdout is the
 * JSON-RPC channel, and one stray line there breaks the connection.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MIN_NODE_MAJOR = 22;
/** An install lock older than this is from an install that died. */
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Exits with a readable message when this Node is too old for the engine. */
function requireNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `dcm needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${process.versions.node}. ` +
        'Install a current LTS from https://nodejs.org and try again.\n'
    );
    process.exit(1);
  }
}

/** @param {string} dir  A folder holding package.json and package-lock.json. */
function isCurrent(dir) {
  const marker = path.join(dir, 'node_modules', '.package-lock.json');
  const lock = path.join(dir, 'package-lock.json');
  try {
    return fs.statSync(marker).mtimeMs >= fs.statSync(lock).mtimeMs;
  } catch {
    return false;
  }
}

/** True while another process holds a recent install lock. */
function lockHeld(lockFile) {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs < STALE_LOCK_MS;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} dir
 * @param {string} label  Named in the progress line, e.g. "the MCP server".
 * @returns {Promise<void>}
 */
async function ensureDeps(dir, label) {
  if (isCurrent(dir)) return;
  const lockFile = path.join(dir, '.dcm-installing');

  if (lockHeld(lockFile)) {
    process.stderr.write(`Waiting for the dependency install already running for ${label}...\n`);
    while (lockHeld(lockFile)) await sleep(500);
    if (isCurrent(dir)) return;
  }

  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch {
    // Lost a race to another launcher; wait for it like above.
    while (lockHeld(lockFile)) await sleep(500);
    if (isCurrent(dir)) return;
    fs.writeFileSync(lockFile, String(process.pid));
  }

  process.stderr.write(`Installing dependencies for ${label} (npm ci, first run only, about a minute)...\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // The lock is removed by a shell step after npm, not by this process, so it
  // still goes away if this process is killed mid-install.
  const command =
    process.platform === 'win32'
      ? `${npm} ci --ignore-scripts --no-audit --no-fund & del /q "${lockFile}"`
      : `${npm} ci --ignore-scripts --no-audit --no-fund; rm -f '${lockFile}'`;
  const code = await new Promise((resolve) => {
    const child = spawn(command, {
      cwd: dir,
      shell: true,
      detached: true,
      windowsHide: true,
      // npm's stdout goes onto our stderr; see the note above.
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c));
  });

  if (!isCurrent(dir)) {
    process.stderr.write(`npm ci failed in ${dir} (exit ${code}). Run it there by hand to see why.\n`);
    process.exit(1);
  }
}

module.exports = { ensureDeps, requireNode };
