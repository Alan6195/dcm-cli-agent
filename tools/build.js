'use strict';

/**
 * Single-executable build.
 *
 * Node's SEA support can only run one self-contained script, so the source is
 * bundled with esbuild first and the resulting file is injected into a copy of
 * the Node binary.
 *
 *   bundle   src/cli.js and its dependencies -> dist/bundle.cjs
 *   blob     dist/bundle.cjs + assets        -> dist/dcm.blob
 *   inject   node binary + blob              -> dist/dcm(.exe)
 *
 * The one binary artifact in the dependency tree is a WebAssembly module from
 * dcmjs-codecs, used to transcode compressed transfer syntaxes. It is embedded
 * as a SEA asset. Transcoding initialisation only accepts a filesystem path, so
 * at runtime the asset is written to a temporary file first — see
 * src/lib/codecs.js. If that fails the tool still works; it just cannot
 * transcode compressed syntaxes.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const IS_WINDOWS = process.platform === 'win32';
const EXE_NAME = IS_WINDOWS ? 'dcm.exe' : 'dcm';

const WASM_SOURCE = path.join(
  ROOT, 'node_modules', 'dcmjs-codecs', 'build', 'dcmjs-native-codecs.wasm'
);

/** The fuse string Node looks for when locating an injected SEA blob. */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function ensureDist() {
  fs.mkdirSync(DIST, { recursive: true });
}

function clean() {
  fs.rmSync(DIST, { recursive: true, force: true });
  log('removed dist/');
}

/** Bundles the CLI into a single CommonJS file. */
function bundle() {
  ensureDist();
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    throw new Error(
      'esbuild is not installed. Run `npm install` first — it is a devDependency ' +
        'used only to build the executable, and is not part of what ships.'
    );
  }

  const outfile = path.join(DIST, 'bundle.cjs');

  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'cli-entry.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile,
    // Keep the bundle readable enough that a stack trace from the shipped
    // binary still points somewhere useful.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    // The wasm ships as a SEA asset, not as a bundled import.
    external: ['*.wasm'],
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  const size = fs.statSync(outfile).size;
  log(`bundled -> ${path.relative(ROOT, outfile)} (${(size / 1048576).toFixed(2)} MB)`);
  return outfile;
}

/** Writes the SEA config and generates the blob. */
function blob() {
  ensureDist();

  if (!fs.existsSync(WASM_SOURCE)) {
    throw new Error(
      `Expected the codecs WebAssembly module at ${WASM_SOURCE} but it is missing. ` +
        'Run `npm install`.'
    );
  }

  const configPath = path.join(DIST, 'sea-config.json');
  const config = {
    main: path.join(DIST, 'bundle.cjs'),
    output: path.join(DIST, 'dcm.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: {
      'dcmjs-native-codecs.wasm': WASM_SOURCE,
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  execFileSync(process.execPath, ['--experimental-sea-config', configPath], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  const size = fs.statSync(config.output).size;
  log(`blob     -> ${path.relative(ROOT, config.output)} (${(size / 1048576).toFixed(2)} MB)`);
  return config.output;
}

/** Copies the Node binary and injects the blob into it. */
function inject(blobPath) {
  const target = path.join(DIST, EXE_NAME);

  fs.copyFileSync(process.execPath, target);
  // Copying the binary preserves the read-only bit on some systems, which
  // would make injection fail with a confusing permissions error.
  fs.chmodSync(target, 0o755);
  log(`copied   -> ${path.relative(ROOT, target)} (from ${process.execPath})`);

  let postjectBin;
  try {
    postjectBin = require.resolve('postject/dist/cli.js');
  } catch {
    throw new Error(
      'postject is not installed. Run `npm install` — it is a devDependency used ' +
        'only to inject the bundle into the Node binary.'
    );
  }

  const argv = [
    postjectBin,
    target,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SENTINEL_FUSE,
  ];

  // macOS binaries are signed, and injection invalidates the signature.
  if (process.platform === 'darwin') {
    argv.push('--macho-segment-name', 'NODE_SEA');
  }

  execFileSync(process.execPath, argv, { stdio: 'inherit', cwd: ROOT });

  const size = fs.statSync(target).size;
  log(`injected -> ${path.relative(ROOT, target)} (${(size / 1048576).toFixed(2)} MB)`);

  if (process.platform === 'darwin') {
    try {
      execFileSync('codesign', ['--sign', '-', target], { stdio: 'inherit' });
      log('re-signed (ad-hoc) for macOS');
    } catch {
      log('warning: could not re-sign the binary; macOS may refuse to run it');
    }
  }

  return target;
}

/** Smoke-tests the produced binary so packaging failures surface here. */
function verify(target) {
  const runs = [
    { args: ['--version'], expect: /\d+\.\d+\.\d+/ },
    { args: ['--help'], expect: /DICOM network operations/ },
    { args: ['info', '--help'], expect: /dcm info/ },
  ];

  for (const { args, expect } of runs) {
    const output = execFileSync(target, args, { encoding: 'utf8' });
    if (!expect.test(output)) {
      throw new Error(
        `Smoke test failed for \`${EXE_NAME} ${args.join(' ')}\`: ` +
          `output did not match ${expect}.\nGot:\n${output}`
      );
    }
    log(`verified -> ${EXE_NAME} ${args.join(' ')}`);
  }
}

function all() {
  bundle();
  const blobPath = blob();
  const target = inject(blobPath);
  verify(target);
  log('');
  log(`Done. Standalone executable: ${path.relative(ROOT, target)}`);
  log('It needs no Node.js installation on the target machine.');
}

const step = process.argv[2] ?? 'all';
const steps = { bundle, blob: () => blob(), inject: () => inject(path.join(DIST, 'dcm.blob')), clean, all, verify: () => verify(path.join(DIST, EXE_NAME)) };

if (!steps[step]) {
  process.stderr.write(`Unknown build step "${step}". Known: ${Object.keys(steps).join(', ')}\n`);
  process.exit(2);
}

try {
  steps[step]();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
