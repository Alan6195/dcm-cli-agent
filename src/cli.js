'use strict';

const log = require('./lib/log');
const { tokenize, UsageError } = require('./lib/args');

const { version } = require('../package.json');

/**
 * Exit codes are part of this tool's contract, because it is meant to be run
 * from scripts and scheduled jobs:
 *
 *   0  the operation completed and nothing was lost
 *   1  the operation ran but did not fully succeed — including a transfer that
 *      was accepted but lossy. A partial send is a failure here, never a warning.
 *   2  the command line itself was wrong
 *
 * The distinction between 0 and 1 is deliberately strict. A run that found 823
 * files and got 822 acknowledgements exits 1.
 */
const EXIT = { OK: 0, FAILED: 1, USAGE: 2 };

const COMMANDS = {
  echo: () => require('./commands/echo'),
  send: () => require('./commands/send'),
  scp: () => require('./commands/scp'),
  find: () => require('./commands/find'),
  info: () => require('./commands/info'),
  anon: () => require('./commands/anon'),
  explain: () => require('./commands/explain'),
};

const USAGE = `
dcm — DICOM network operations against folders of DICOM files

Usage:
  dcm <command> [options]

Commands:
  echo      Verify connectivity to a peer (C-ECHO)
  send      Send a folder tree to a peer (C-STORE), grouped by study
  scp       Run a permissive receiver that logs everything
  find      Query a peer (C-FIND) at study, series or worklist level
  info      Inventory a folder or file: modalities, counts, sizes, syntaxes
  anon      De-identify a folder into a new directory
  explain   Explain a failed transfer log using the Anthropic API (optional)

Global options:
  --verbose      Log the full association negotiation — contexts, transfer
                 syntaxes and the peer's implementation. This is what makes
                 connectivity problems diagnosable.
  --quiet        Errors only.
  --json         Machine-readable output, where the command supports it.
  --no-color     Disable ANSI colour.
  --help         Show help. Works per command: dcm send --help
  --version      Print the version.

Connection details come from flags or environment variables, never from a file
on disk:
  DCM_HOST  DCM_PORT  DCM_CALLED_AE  DCM_CALLING_AE  DCM_SCP_PORT

Examples:
  dcm echo --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm scp  --port 11112 --persist ./received
  dcm info ./study

Run 'dcm <command> --help' for details on a command.
`.trimStart();

/**
 * Keeps the console open when the executable was launched by double-clicking it.
 *
 * This is a command-line tool, but it ships as a bare .exe, so people
 * reasonably double-click it expecting an installer. Windows then creates a
 * console for the process, the usage text prints, the process exits, and the
 * window disappears before anything can be read. It looks exactly like a crash.
 *
 * The heuristic is deliberately narrow: Windows, an interactive terminal, and
 * no arguments at all. Someone who typed the bare command in a shell pays one
 * keypress; someone who double-clicked gets an explanation instead of a flash.
 *
 * @returns {Promise<void>}
 */
async function pauseSoTheWindowCanBeRead() {
  const looksLikeDoubleClick =
    process.platform === 'win32' &&
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true;

  if (!looksLikeDoubleClick) return;

  log.out('');
  log.out('─'.repeat(72));
  log.out('This is a command-line tool, not an installer. There is nothing to install.');
  log.out('');
  log.out('If you double-clicked it, run it from a terminal instead. Open PowerShell,');
  log.out('then point it at this file:');
  log.out('');
  log.out('    .\\dcm.exe info C:\\path\\to\\study');
  log.out('');
  log.out('To use it as `dcm` from anywhere, put it in a folder on your PATH.');
  log.out('─'.repeat(72));

  await new Promise((resolve) => {
    process.stdout.write('\nPress Enter to close this window...');
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

/**
 * @param {string[]} argv Arguments after the executable and script.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  const parsed = tokenize(argv);
  const { flags, positionals } = parsed;

  log.configure({
    verbose: flags.get('verbose') === true || flags.get('verbose') === 'true',
    quiet: flags.get('quiet') === true || flags.get('quiet') === 'true',
    noColor: flags.has('no-color'),
  });

  // dcmjs-dimse logs at info level by default, which would dump PDU traces over
  // ordinary output. Route it through our own level so it appears only under
  // --verbose, where the full negotiation trace is exactly what is wanted.
  log.attachLibraryLogger(require('dcmjs-dimse').log);

  // A dependency still calls the deprecated Buffer() constructor, and Node
  // prints that warning straight into the middle of a transfer report. It is
  // not actionable by anyone running this tool, so it is hidden by default and
  // left visible under --verbose, where nothing should be filtered out.
  process.noDeprecation = !log.isVerbose();

  if (flags.has('version') && positionals.length === 0) {
    log.out(version);
    return EXIT.OK;
  }

  const command = positionals[0];

  if (!command) {
    log.out(USAGE);
    // An explicit --help was answered; a bare launch may be a double-click.
    if (flags.has('help')) return EXIT.OK;
    await pauseSoTheWindowCanBeRead();
    return EXIT.USAGE;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    log.error(`Unknown command "${command}".`);
    const names = Object.keys(COMMANDS).join(', ');
    log.error(`Available commands: ${names}`);
    return EXIT.USAGE;
  }

  // The command sees positionals with its own name removed.
  const commandArgs = { ...parsed, positionals: positionals.slice(1) };

  try {
    const mod = loader();
    return await mod.run(commandArgs);
  } catch (err) {
    if (err instanceof UsageError || err?.name === 'UsageError') {
      log.error(err.message);
      log.error(`Run 'dcm ${command} --help' for usage.`);
      return EXIT.USAGE;
    }
    log.error(err?.stack ?? String(err));
    return EXIT.FAILED;
  }
}

module.exports = { main, EXIT, USAGE, version };
