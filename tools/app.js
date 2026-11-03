#!/usr/bin/env node
'use strict';

/**
 * `npm run app`: start the desktop app from this checkout.
 *
 * It installs desktop/ dependencies when they are missing or behind the
 * lockfile, vendors the engine (desktop's own prestart), and launches Electron.
 * Electron downloads its binary the first time it runs (about 100 MB, once).
 *
 * This is for running from source. The installers on the Releases page are
 * the normal way to get the app, and they update themselves.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureDeps, requireNode } = require('./ensure-deps');

requireNode();
const DESKTOP = path.resolve(__dirname, '..', 'desktop');
ensureDeps(DESKTOP, 'the desktop app').then(() => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['start'], {
    cwd: DESKTOP,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exitCode = result.status ?? 1;
});
