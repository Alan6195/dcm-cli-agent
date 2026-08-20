'use strict';

const log = require('./lib/log');
const brand = require('./lib/brand');
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
  tags: () => require('./commands/tags'),
  edit: () => require('./commands/edit'),
  anon: () => require('./commands/anon'),
  mpps: () => require('./commands/mpps'),
  web: () => require('./commands/web'),
  explain: () => require('./commands/explain'),
  mcp: () => require('./commands/mcp'),
  install: () => require('./commands/install'),
  uninstall: () => ({ run: require('./commands/install').uninstall }),
  update: () => require('./commands/update'),
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
  tags      Dump the DICOM tags in a file or folder
  edit      Change or remove tags and write the result
  anon      De-identify a folder into a new directory
  mpps      Modality Performed Procedure Step: start, perform, complete a step
  web       DICOMweb: ping, send (STOW), query (QIDO), retrieve (WADO), serve
  explain   Explain a failed transfer log using the Anthropic API (optional)
  mcp       Run an MCP server so an assistant can drive these operations
  install   Put this executable on your PATH so you can type 'dcm' anywhere
  uninstall Undo install
  update    Replace this executable with the latest published release

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
  DCM_WEB_URL  DCM_WEB_TOKEN  DCM_WEB_USER  DCM_WEB_PASS  DCM_WEB_SERVE_PORT

Examples:
  dcm echo --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm scp  --port 11112 --persist ./received
  dcm info ./study

Run 'dcm <command> --help' for details on a command.
`.trimStart();

/**
 * True when this looks like a person at a terminal rather than a script.
 *
 * Both streams must be interactive. Anything piped, redirected or run from CI
 * fails this test and takes the ordinary non-interactive path, so the menu can
 * never hang an automated run.
 */
function isInteractive() {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * @param {string[]} argv Arguments after the executable and script.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  // A reader that closes the pipe early (`dcm info | head`, quitting a pager)
  // must not end in an EPIPE stack trace. Installed before any output.
  log.installStreamGuards();

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
    // A bare launch from a terminal is almost always someone double-clicking
    // the executable, or someone who does not yet know the commands. Both are
    // better served by the menu than by a wall of flags that scrolls away.
    // `--help` is an explicit request for the reference, so it stays literal.
    if (!flags.has('help') && isInteractive()) {
      // Required lazily: the menu prints USAGE, so loading it at module scope
      // would create a cycle.
      const menu = require('./lib/menu');
      return menu.run(version);
    }

    log.out(brand.banner(version));
    log.out('');
    log.out(USAGE);
    return flags.has('help') ? EXIT.OK : EXIT.USAGE;
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
