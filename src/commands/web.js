'use strict';

const log = require('../lib/log');
const { UsageError } = require('../lib/args');

/**
 * dcm web — DICOMweb operations, dispatched one level below the CLI.
 *
 * The top-level dispatcher in src/cli.js is deliberately one level deep, so
 * "web" is a single command that routes its own sub-verbs the same way:
 * a lazy-require table, so `dcm web query` never pays for the server's code
 * and vice versa. Each verb is an ordinary command module living in
 * src/commands/web/.
 */
const VERBS = {
  ping: () => require('./web/ping'),
  send: () => require('./web/send'),
  query: () => require('./web/query'),
  retrieve: () => require('./web/retrieve'),
  serve: () => require('./web/serve'),
};

const USAGE = `
dcm web — talk DICOMweb: STOW-RS, QIDO-RS, WADO-RS, plus a loopback hub

Usage:
  dcm web <verb> [options]

Verbs:
  ping      Is there a DICOMweb service at this URL, and do my credentials work?
  send      Send a folder of DICOM to a server (STOW-RS), with full accounting
  query     Query a server (QIDO-RS) at study, series or instance level
  retrieve  Retrieve a study from a server (WADO-RS) into a folder
  serve     Run a local DICOMweb hub — a loopback test target, like dcm scp

Connection:
  The base URL comes from --url or DCM_WEB_URL. Many servers root DICOMweb
  under a path prefix — include it: https://pacs.example.org/dicom-web

Authentication:
  Credentials come from the environment and nowhere else — no flag, no config
  file, so they cannot land in your shell history or a repo:
    DCM_WEB_TOKEN                Bearer token
    DCM_WEB_USER / DCM_WEB_PASS  HTTP Basic

Examples:
  dcm web ping --url https://pacs.example.org/dicom-web
  dcm web send ./study --url https://pacs.example.org/dicom-web
  dcm web query --url https://pacs.example.org/dicom-web PatientID=12345
  dcm web retrieve --url https://pacs.example.org/dicom-web --study 1.2.840... --out ./pulled
  dcm web serve --port 10808 --persist ./received

Run 'dcm web <verb> --help' for the verb's options.
`.trimStart();

/**
 * @param {{flags: Map, positionals: string[], pairs: Array<[string,string]>}} parsed
 * @returns {Promise<number>} exit code
 */
async function run(parsed) {
  const verb = parsed.positionals[0];

  if (!verb) {
    if (parsed.flags.has('help')) {
      log.out(USAGE);
      return 0;
    }
    throw new UsageError(`dcm web needs a verb: ${Object.keys(VERBS).join(', ')}`);
  }

  const loader = VERBS[verb];
  if (!loader) {
    throw new UsageError(`unknown web verb '${verb}' — expected one of: ${Object.keys(VERBS).join(', ')}`);
  }

  const mod = loader();
  return mod.run({ ...parsed, positionals: parsed.positionals.slice(1) });
}

module.exports = { run, USAGE, VERBS };
