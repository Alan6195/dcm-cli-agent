'use strict';

const log = require('../lib/log');
const { UsageError } = require('../lib/args');

/**
 * dcm mpps — Modality Performed Procedure Step, dispatched one level below the
 * CLI, the same way `dcm web` is.
 *
 * Lazy-required so that `dcm mpps start` never pays for the scanner and the
 * DICOM parser that `dcm mpps perform` pulls in.
 */
const VERBS = {
  start: () => require('./mpps/start'),
  update: () => require('./mpps/update'),
  complete: () => require('./mpps/complete'),
  discontinue: () => require('./mpps/discontinue'),
  perform: () => require('./mpps/perform'),
};

const USAGE = `
dcm mpps — tell an MPPS SCP what was actually performed

A Modality Worklist says what is scheduled. MPPS says what happened: this step
started, produced these series holding these instances, and finished. A RIS
reconciles the two on Study Instance UID and closes the order.

Usage:
  dcm mpps <verb> [options]

Verbs:
  start        Open a step: N-CREATE with status IN PROGRESS
  update       Report progress and leave the step open: interim N-SET
  perform      Open a step, send a folder, close it — one transaction
  complete     Close a step: N-SET to COMPLETED
  discontinue  Close a step that did not finish: N-SET to DISCONTINUED

The usual sequence is one command:

  dcm mpps perform ./study --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --store-host pacs.example.org --store-port 104 --store-called-ae ARCHIVE \\
    --from-worklist wl.json

start / complete are the same transaction taken apart, for when the images are
sent by something else or the step has to stay open in between. 'update' is the
interim N-SET that goes between them: it adds performed series to an open step,
or re-asserts IN PROGRESS, and sends no end date or time because the step has
not ended. Its --no-status form omits the status attribute entirely, which is a
different message on the wire and one receivers handle on a different branch.

A step that was never scheduled — a walk-in or an ER exam — is 'start' or
'perform' with --unscheduled. PS3.3 represents it as
ScheduledStepAttributesSequence PRESENT holding exactly one ZERO-LENGTH item,
which is what that flag emits; it is not the same as omitting the sequence, and
it is not the same as an item whose StudyInstanceUID is blank.

This command writes nothing to disk and remembers nothing between runs:
  There is no record directory and no local database of steps. 'perform' needs
  none — it opens, stores and closes in one process, so the step never has to
  outlive it. When the two halves really are separate, the MPPS SOP Instance
  UID that 'start' prints is the ONLY handle on the step: keep it and pass it
  to 'complete' or 'discontinue'. Nothing here can hand it back to you later,
  and nothing can ask the SCP for it either — MPPS has no query service.

Two rules this command does not bend:

  COMPLETED means every instance found on disk was acknowledged by the archive.
  There is no --force. A shortfall makes the step DISCONTINUED and the run
  exits 1, saying how many instances are unaccounted for.

  PerformedSeriesSequence is built only from instances the archive positively
  acknowledged, never from a folder listing. Naming a SOP Instance UID the
  archive does not hold is a fabricated clinical record, and everything
  downstream believes it.

Getting a worklist item into a step:
  'dcm find --mwl --json' formats every value for a person to read, which turns
  sequences into strings. Use 'dcm find --mwl --json-raw' and feed that to
  --from-worklist. Passing the rendered form is detected and refused by name.

Run 'dcm mpps <verb> --help' for the verb's options.
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
    throw new UsageError(`dcm mpps needs a verb: ${Object.keys(VERBS).join(', ')}`);
  }

  const loader = VERBS[verb];
  if (!loader) {
    throw new UsageError(
      `unknown mpps verb '${verb}' — expected one of: ${Object.keys(VERBS).join(', ')}`
    );
  }

  const mod = loader();
  return mod.run({ ...parsed, positionals: parsed.positionals.slice(1) });
}

module.exports = { run, USAGE, VERBS };
