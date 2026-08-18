'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const log = require('../lib/log');
const args = require('../lib/args');

const FLAGS = ['dir', 'no-path', 'dry-run', 'force'];

const USAGE = `
dcm install — put this executable on your PATH as \`dcm\`

Copies the running executable into a per-user programs folder and adds that
folder to your PATH, so you can type \`dcm\` from any terminal. No administrator
rights needed, nothing written outside your own user profile.

Usage:
  dcm install [--dir <path>] [--no-path] [--dry-run]
  dcm uninstall [--dir <path>]

Options:
  --dir <path>   Install location. Defaults to a per-user programs folder.
  --no-path      Copy the executable but leave PATH alone.
  --dry-run      Show exactly what would happen. Changes nothing.
  --force        Overwrite an existing install without asking.

Examples:
  dcm install --dry-run       # see what it would do first
  dcm install
  dcm uninstall
`.trimStart();

/** Default per-user install directory. No admin rights, no shared state. */
function defaultDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Programs', 'dcm-cli');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

/** Name the installed binary should have so the command is `dcm`. */
function binaryName() {
  return process.platform === 'win32' ? 'dcm.exe' : 'dcm';
}

/**
 * Removes the Mark of the Web from an installed binary on Windows.
 *
 * Windows tags anything downloaded through a browser with a Zone.Identifier
 * alternate data stream, and SmartScreen warns on every launch of a marked,
 * unsigned executable. `fs.copyFileSync` copies that stream along with the
 * file, so installing a browser-downloaded exe produces an installed copy that
 * keeps warning — not once, but every single time `dcm` is run.
 *
 * The mark means "this came from the internet", which was true of the download
 * and is not a useful thing to assert about a binary the user has deliberately
 * installed. Clearing it here is the same thing right-click → Unblock does.
 *
 * Best effort: a filesystem without alternate data stream support simply has
 * nothing to remove.
 *
 * @param {string} target
 * @returns {boolean} True when a mark was present and cleared.
 */
function clearMarkOfTheWeb(target) {
  if (process.platform !== 'win32') return false;
  try {
    fs.rmSync(`${target}:Zone.Identifier`);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when we are a packaged single executable rather than `node bin/dcm.js`.
 *
 * Installing a copy of the Node binary from a source checkout would produce
 * something that runs Node rather than this tool, so that case is refused.
 */
function isPackagedExecutable() {
  try {
    // eslint-disable-next-line global-require
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

/**
 * Reads the current user PATH from the registry, preserving its value type.
 *
 * `setx` is deliberately not used anywhere here: it silently truncates at 1024
 * characters, which is a well-known way to destroy someone's PATH. Reading and
 * writing the registry value directly avoids that, and preserving the value
 * kind keeps `%VAR%` references in an existing REG_EXPAND_SZ PATH working.
 *
 * @returns {{value: string, kind: string}}
 */
function readUserPath() {
  // The kind is an enum and the value is a string. Concatenating them with `+`
  // makes PowerShell try to coerce the string into the enum and fail, so they
  // are interpolated instead. `DoNotExpandEnvironmentNames` matters too: without
  // it, an existing `%USERPROFILE%` style entry would be read back expanded and
  // then written out hard-coded.
  // A user profile that has never had a user PATH has no Path value under
  // HKCU\Environment at all. GetValueKind throws on a missing value rather
  // than reporting its absence, so a bare `GetValueKind('Path')` would crash
  // the install on exactly the clean machine this is most likely to run on.
  // Treat "no value" as an empty String-kind PATH, which is what we then
  // create.
  const script = `
    $ErrorActionPreference = 'Stop'
    $key = Get-Item -Path 'HKCU:\\Environment'
    $value = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    try { $kind = $key.GetValueKind('Path') } catch { $kind = 'String' }
    [Console]::Out.Write("$kind\`n$value")
  `;
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' }
  );
  const newline = out.indexOf('\n');
  if (newline === -1) {
    throw new Error(`could not read the user PATH from the registry (got: ${out.slice(0, 80)})`);
  }
  const kind = out.slice(0, newline).trim();
  if (!['String', 'ExpandString'].includes(kind)) {
    throw new Error(`unexpected registry value type for PATH: ${kind}`);
  }
  return { kind, value: out.slice(newline + 1) };
}

/**
 * Appends a directory to the user PATH, preserving the existing value type.
 *
 * @param {string} dir
 * @returns {{changed: boolean, reason?: string}}
 */
function addToUserPath(dir) {
  const { value, kind } = readUserPath();

  const entries = value.split(';').filter((e) => e.trim() !== '');
  const already = entries.some(
    (e) => path.normalize(e.replace(/"/g, '').trim()).toLowerCase() ===
      path.normalize(dir).toLowerCase()
  );
  if (already) return { changed: false, reason: 'already on PATH' };

  const updated = entries.concat(dir).join(';');

  // Refuse to write something obviously wrong rather than risk the PATH.
  if (!updated.includes(dir)) {
    throw new Error('refusing to write PATH: the new entry is missing from the result');
  }

  const script = `
    $ErrorActionPreference = 'Stop'
    $new = [System.Environment]::GetEnvironmentVariable('DCM_NEW_PATH', 'Process')
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::${kind === 'String' ? 'String' : 'ExpandString'})
    $key.Close()
  `;
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env: { ...process.env, DCM_NEW_PATH: updated } }
  );

  return { changed: true };
}

/**
 * Removes a directory from the user PATH.
 *
 * @param {string} dir
 * @returns {{changed: boolean}}
 */
function removeFromUserPath(dir) {
  const { value, kind } = readUserPath();
  const entries = value.split(';').filter((e) => e.trim() !== '');
  const kept = entries.filter(
    (e) => path.normalize(e.replace(/"/g, '').trim()).toLowerCase() !==
      path.normalize(dir).toLowerCase()
  );
  if (kept.length === entries.length) return { changed: false };

  const script = `
    $ErrorActionPreference = 'Stop'
    $new = [System.Environment]::GetEnvironmentVariable('DCM_NEW_PATH', 'Process')
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::${kind === 'String' ? 'String' : 'ExpandString'})
    $key.Close()
  `;
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env: { ...process.env, DCM_NEW_PATH: kept.join(';') } }
  );

  return { changed: true };
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

  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });
  const skipPath = args.resolve(flags, { name: 'no-path', type: 'boolean', fallback: false });
  const force = args.resolve(flags, { name: 'force', type: 'boolean', fallback: false });
  const targetDir = path.resolve(args.resolve(flags, { name: 'dir', fallback: defaultDir() }));
  const target = path.join(targetDir, binaryName());
  const source = process.execPath;

  if (!isPackagedExecutable()) {
    log.error('`dcm install` only works from the packaged executable.');
    log.error('');
    log.error('You are running from a source checkout, where process.execPath is the Node');
    log.error('binary rather than this tool — installing it would give you a copy of Node.');
    log.error('');
    log.error('Build the executable first, then install that:');
    log.error('  npm run build');
    log.error('  .\\dist\\dcm.exe install');
    log.error('');
    log.error('Or use npm directly:  npm install -g dcm-cli-agent');
    return 1;
  }

  const alreadyInstalledHere =
    path.normalize(source).toLowerCase() === path.normalize(target).toLowerCase();

  log.out('');
  log.out(`install location   ${target}`);
  log.out(`running from       ${source}`);
  log.out(`update PATH        ${skipPath ? 'no (--no-path)' : 'yes'}`);

  if (dryRun) {
    log.out('');
    log.out('DRY RUN — nothing was changed.');
    log.out('');
    log.out('It would:');
    if (alreadyInstalledHere) {
      log.out(`  - leave ${target} alone (already running from there)`);
    } else {
      log.out(`  - create ${targetDir}`);
      log.out(`  - copy this executable to ${target}`);
    }
    if (!skipPath && process.platform === 'win32') {
      const { value } = readUserPath();
      const present = value.split(';').some(
        (e) => path.normalize(e.trim()).toLowerCase() === targetDir.toLowerCase()
      );
      log.out(
        present
          ? `  - leave PATH alone (${targetDir} is already on it)`
          : `  - append ${targetDir} to your user PATH (HKCU\\Environment)`
      );
      log.out('  - it never touches the system PATH and never needs administrator rights');
    }
    return 0;
  }

  // --- Copy ---
  if (alreadyInstalledHere) {
    log.info('already running from the install location; not copying over itself');
  } else {
    if (fs.existsSync(target) && !force) {
      log.info(`replacing the existing executable at ${target}`);
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, target);
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
      log.out('');
      log.out(`${log.color.green('installed')}  ${target}`);

      if (clearMarkOfTheWeb(target)) {
        log.out(
          `${log.color.green('unblocked')}  cleared the downloaded-from-the-internet mark, ` +
            'so Windows will not warn on every launch'
        );
      }
    } catch (err) {
      log.error(`Could not install to ${target}: ${err.message}`);
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        log.error('');
        log.error('That usually means a dcm process is still running from that location.');
        log.error('Close any running dcm windows and try again.');
      }
      return 1;
    }
  }

  // --- PATH ---
  if (skipPath) {
    log.out('');
    log.out(`PATH was left alone. Run it with the full path, or add this folder yourself:`);
    log.out(`  ${targetDir}`);
    return 0;
  }

  if (process.platform !== 'win32') {
    log.out('');
    log.out(`Make sure ${targetDir} is on your PATH. If it is not, add this to your shell profile:`);
    log.out(`  export PATH="${targetDir}:$PATH"`);
    return 0;
  }

  try {
    const result = addToUserPath(targetDir);
    if (result.changed) {
      log.out(`${log.color.green('PATH')}       added ${targetDir} to your user PATH`);
    } else {
      log.out(`PATH       ${targetDir} was already there`);
    }
  } catch (err) {
    log.error('');
    log.error(`Installed the executable, but could not update PATH: ${err.message}`);
    log.error('Add this folder to your PATH manually:');
    log.error(`  ${targetDir}`);
    return 1;
  }

  log.out('');
  log.out('─'.repeat(72));
  log.out('Done. Open a NEW terminal, then:');
  log.out('');
  log.out('    dcm --help');
  log.out('    dcm info C:\\path\\to\\study');
  log.out('');
  log.out(log.color.dim(
    'The new terminal matters — PATH is read when a shell starts, so windows that\n' +
      'were already open will not see it yet.'
  ));
  log.out('─'.repeat(72));

  return 0;
}

/**
 * Reverses an install.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function uninstall(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const targetDir = path.resolve(args.resolve(flags, { name: 'dir', fallback: defaultDir() }));
  const target = path.join(targetDir, binaryName());
  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });

  log.out('');
  log.out(`would remove   ${target}`);
  log.out(`and drop       ${targetDir} from your user PATH`);

  if (dryRun) {
    log.out('');
    log.out('DRY RUN — nothing was changed.');
    return 0;
  }

  // Removing the executable that is currently running fails on Windows, so
  // reverse the PATH entry and tell the operator what is left behind.
  const runningFromTarget =
    path.normalize(process.execPath).toLowerCase() === path.normalize(target).toLowerCase();

  if (process.platform === 'win32') {
    try {
      const result = removeFromUserPath(targetDir);
      log.out('');
      log.out(result.changed ? `removed ${targetDir} from your user PATH` : 'PATH was already clean');
    } catch (err) {
      log.error(`Could not update PATH: ${err.message}`);
      return 1;
    }
  }

  if (runningFromTarget) {
    log.out('');
    log.warn(
      'The executable is running right now, so it could not delete itself. ' +
        `Delete it manually once this exits:\n  ${target}`
    );
    return 0;
  }

  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      log.out(`removed ${target}`);
    }
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length === 0) {
      fs.rmdirSync(targetDir);
    }
  } catch (err) {
    log.error(`Could not remove ${target}: ${err.message}`);
    return 1;
  }

  log.out('');
  log.out('Uninstalled. Open a new terminal for the PATH change to take effect.');
  return 0;
}

module.exports = {
  run,
  uninstall,
  USAGE,
  defaultDir,
  binaryName,
  isPackagedExecutable,
  readUserPath,
  clearMarkOfTheWeb,
};
