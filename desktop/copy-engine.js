'use strict';

/**
 * Vendors the engine source into ./engine so the desktop app has a lean, self
 * contained copy to spawn — bin/, src/ and package.json only, nothing else.
 *
 * Using a copy of just the source (rather than a file:.. dependency that
 * deep-copies the whole repo working tree) keeps the packaged app small and
 * predictable: the engine's runtime dependencies are declared directly in this
 * app's package.json and resolve from ./node_modules at runtime.
 *
 * Run automatically before start / dist via npm pre-hooks.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const DEST = path.join(__dirname, 'engine');

const ITEMS = ['bin', 'src', 'package.json', 'LICENSE'];

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

for (const item of ITEMS) {
  const from = path.join(REPO, item);
  const to = path.join(DEST, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, to, { recursive: true });
}

// Sanity: the entry the app spawns must exist.
const entry = path.join(DEST, 'bin', 'dcm.js');
if (!fs.existsSync(entry)) {
  process.stderr.write(`copy-engine: expected ${entry} to exist after copy\n`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(DEST, 'package.json'), 'utf8')).version;
process.stdout.write(`copy-engine: vendored engine v${version} -> ${path.relative(process.cwd(), DEST)}\n`);
