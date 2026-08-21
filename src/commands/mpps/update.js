'use strict';

const log = require('../../lib/log');
const args = require('../../lib/args');
const json = require('../../lib/json');
const mpps = require('../../lib/mpps');
const common = require('./common');

/**
 * Flags this verb accepts.
 *
 * The N-CREATE-only flags are NOT here, and that is on purpose: they are
 * refused by name a moment later, by mpps.assertNoCreateOnlyFlags(), so that
 * `--station-ae` gets "PerformedStationAETitle is N-CREATE-only" rather than
 * "Unknown option. Did you mean --station-name?". The second message sends
 * someone looking for a typo that is not there.
 */
const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.SERIES_FROM_FLAGS,
  ...common.INJECTION_FLAGS,
  'no-status',
  'dry-run',
  // The same alias the closing verbs take. `--mpps-uid` is not an N-CREATE-only
  // attribute — it names the step rather than setting one of its attributes —
  // so it does not belong in the refusal list below.
  'mpps-uid',
  // Accepted by the parser purely so they can be refused by attribute name
  // below. rejectUnknown() runs first and would otherwise get there ahead of
  // the explanation.
  ...Object.keys(mpps.CREATE_ONLY_ATTRIBUTES),
  'end-date', 'end-time',
];

const USAGE = `
dcm mpps update — report progress on a step that is still running (interim N-SET)

Usage:
  dcm mpps update <mpps-uid> --host <host> --port <port> --called-ae <AE> [options]

An interim N-SET adds to a performed procedure step and leaves it OPEN. It is
what a modality sends part-way through a long acquisition: the series performed
so far, and a status that still says ${mpps.Status.IN_PROGRESS}. No end date and no end
time are sent, because the step has not ended.

"update" rather than "progress" or "set": N-SET is the operation, the word does
not imply closure, and it leaves --status free for a terminal value later.

<mpps-uid> is the MPPS SOP Instance UID printed by 'dcm mpps start'. It is the
only handle on the step: this command writes no records and MPPS has no query
service, so there is nowhere to look a lost UID up.

Connection:
  --host <host>          MPPS peer hostname.                    [env DCM_HOST]
  --port <port>          MPPS peer DIMSE port.                  [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.                   [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI         [env DCM_CALLING_AE]
  --timeout <ms>         Silence allowed before giving up. Default: 60000.

What the update carries:
  --series-from <folder> Build PerformedSeriesSequence by scanning a folder.
                         Omitted, the sequence is not sent AT ALL, and whatever
                         the step already holds survives. READ THE TWO NOTES
                         BELOW — this flag asserts what is on your disk, and the
                         sequence REPLACES rather than appends.
  --no-recurse           With --series-from, do not descend into subfolders.
  --retrieve-ae <AE>     Retrieve AE Title recorded against each performed
                         series — the AE the images can be fetched from.
  --no-status            Send NO PerformedProcedureStepStatus at all. Without
                         it the update carries ${mpps.Status.IN_PROGRESS}.

Other:
  --mpps-uid <uid>       The step being updated, as a flag rather than an
                         argument. Same value, same meaning; give one.
  --set <Key>=<Value>    Stamp a value into the outgoing N-SET verbatim, with no
                         client-side validation at all. Repeatable. It is
                         applied after the dataset is built, so it reaches past
                         the two refusals below: --set
                         PerformedProcedureStepEndTime=120000 sends the end time
                         this verb will not construct, and --set
                         PerformedProcedureStepStatus=COMPLETED sends a terminal
                         status from a verb whose whole point is not to. Both
                         are worth doing deliberately against a receiver under
                         test and neither should ever happen by accident, which
                         is the difference this flag draws. Banners on stderr,
                         "injected" in the JSON.
  --dry-run              Build and print the N-SET without connecting.
  --json                 Emit the result as JSON.
  --verbose              Log the full association negotiation.

The two shapes, and why both exist:
  With a status     PerformedProcedureStepStatus = ${mpps.Status.IN_PROGRESS}, re-asserted.
  Without one       the attribute is absent from the dataset entirely.

  These are different messages on the wire and receivers branch on them
  differently. An absent status means "these attributes changed, the step is
  still running" and the receiver leaves its own status alone; a present one
  re-asserts it, which is also what tells a watchdog on the far end that the
  device is still alive. Both are legal, both are common, and a receiver that
  handles one and not the other fails in production rather than in testing.

Note: PerformedSeriesSequence REPLACES, it does not append.
  N-SET is attribute-level replacement (PS3.4 F.7.2). A second update naming
  only the series acquired since the first one does not add them — it erases
  the first ones. Every update must carry the CUMULATIVE sequence, which is
  what --series-from does when the folder grows between runs.

  The corollary is the reason --series-from is optional: an update that omits
  the sequence leaves it exactly as the N-CREATE or an earlier update left it.
  Omitting is the default here precisely so that "report progress" and "restate
  the whole performed series" stay separate decisions.

Note: --series-from asserts what is on YOUR DISK, not what the archive holds.
  A folder scan lists what you have locally, which may include instances the
  archive refused, never received, or rejected as duplicates. Naming one of
  those in an MPPS is a fabricated clinical record, and everything downstream
  believes it. This command says so, in yellow, every time it does it.

  There is no better source here and that is deliberate: only the process that
  did the C-STORE knows what was acknowledged, and this tool writes nothing
  down. 'dcm mpps perform --update-each-chunk' is the honest version — it sends
  the images itself and updates the step with what the archive took.

Note: an update cannot change what the step IS.
  Patient identity, ScheduledStepAttributesSequence and its StudyInstanceUID,
  PerformedProcedureStepID, PerformedStationAETitle, the start date and time,
  and Modality are all N-CREATE-only — PS3.4 F.7.2-1 leaves the N-SET column
  blank for every one of them. The flags that would carry them are refused here
  by attribute name rather than reported as unknown options.

  PS3.4 does allow an N-SET to carry PerformedProcedureStepDescription,
  PerformedStationName, PerformedLocation and the two code sequences as Type 3.
  This verb does not send them: an interim update exists to report what has been
  performed, and re-sending descriptive attributes on every update invites an
  SCP to overwrite ones it has already reconciled. Close and reopen the step if
  its description is wrong.

Note: an end date or time is not accepted here, even though PS3.4 allows one.
  An end time on a step whose status still says ${mpps.Status.IN_PROGRESS} is a contradiction
  the receiving system has to resolve on its own, and some resolve it by
  treating the step as finished. Close the step with 'dcm mpps complete' or
  'dcm mpps discontinue'; both stamp the end date and time themselves.

Note: --no-status and --dry-run take no value.
  The parser gives a flag the next token unless that token is another flag, so
  'dcm mpps update --no-status 2.25.1' reads the UID as the flag's value. Write
  the UID first. This is detected and named rather than reported as a missing
  UID.

Examples:
  # Still running, nothing else to say. This is the keep-alive shape.
  dcm mpps update 2.25.31415926535897932384626433832795028841 \\
    --host ris.example.org --port 11112 --called-ae MPPSSCP

  # Two series performed so far; the step stays open.
  dcm mpps update 2.25.31415926535897932384626433832795028841 \\
    --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --series-from ./acquired-so-far --retrieve-ae ARCHIVE

  # The same, with the status attribute entirely absent.
  dcm mpps update 2.25.31415926535897932384626433832795028841 --no-status \\
    --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --series-from ./acquired-so-far
`.trimStart();

/**
 * Resolves which step is being updated.
 *
 * One source and deliberately no other: the argument. Nothing is written to
 * disk, so there is no file to read it out of, and MPPS has no query service,
 * so the peer cannot be asked which steps it is holding either.
 *
 * Accepted as the argument or as --mpps-uid, which is what `dcm mpps start`
 * calls the same value. See the note in finish.js for why both spellings exist
 * and why giving both is refused.
 *
 * @param {string|undefined} positional
 * @param {string|undefined} flag
 * @returns {string}
 */
function resolveMppsUid(positional, flag) {
  if (positional && flag !== undefined) {
    throw new args.UsageError(
      positional === flag
        ? `The MPPS SOP Instance UID was given twice, as an argument and as --mpps-uid ${flag}. ` +
          'They agree, so nothing is ambiguous, but give one of them.'
        : `Two different MPPS SOP Instance UIDs: "${positional}" as an argument and "${flag}" ` +
          'as --mpps-uid. One of them names a step this command would update by mistake, and ' +
          'nothing here can tell which. Give one.'
    );
  }

  const uid = positional ?? flag;
  if (!uid) {
    throw new args.UsageError(
      'Missing the MPPS SOP Instance UID. It is the value `dcm mpps start` printed as ' +
        '"MPPS SOP Instance UID", and it is the only handle on the step:\n' +
        '  dcm mpps update <mpps-uid> --host ... --port ... --called-ae ...\n' +
        '  dcm mpps update --mpps-uid <mpps-uid> --host ... --port ... --called-ae ...\n' +
        'This tool keeps no record of the steps it opened, and MPPS has no query service, ' +
        'so a lost UID cannot be recovered from here or from the peer.'
    );
  }
  return mpps.requireUid(uid, positional ? '<mpps-uid>' : '--mpps-uid');
}

/**
 * N-SET that leaves the step running.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) return common.helpFor('update', flags, USAGE);

  // The N-CREATE-only refusals below are thrown before any output, so without
  // this wrapper `--json` gets prose on stderr and an empty stdout.
  return common.guardVerb('update', flags, () => execute(parsed));
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function execute(parsed) {
  const { flags, positionals } = parsed;

  args.rejectUnknown(flags, FLAGS);

  // Before anything else, because "that attribute cannot be set" is a better
  // first sentence than "the UID is missing" when both are true.
  mpps.assertNoCreateOnlyFlags(flags, 'update');

  // Not N-CREATE-only — PS3.4 F.7.2-1 marks both Type 3 on the N-SET — so they
  // get their own refusal, for a reason about this verb rather than about the
  // table: an end time on a step that is still running is a contradiction, and
  // the systems that resolve it resolve it by treating the step as finished.
  for (const name of ['end-date', 'end-time']) {
    if (!flags.has(name)) continue;
    throw new args.UsageError(
      `--${name} ends a procedure step, and an interim update leaves it running. ` +
        'A PerformedProcedureStepEndDate/Time alongside a status that still says ' +
        `${mpps.Status.IN_PROGRESS} is a contradiction the receiving system has to resolve ` +
        'on its own, and some resolve it by closing the step under you.\n' +
        'Close the step with `dcm mpps complete` or `dcm mpps discontinue`; both take ' +
        `--${name} and both stamp it as part of a terminal status.`
    );
  }

  const noStatus = common.booleanFlag(flags, 'no-status', 'the MPPS SOP Instance UID');
  const dryRun = common.booleanFlag(flags, 'dry-run');
  const asJson = flags.has('json');

  if (positionals.length > 1) {
    throw new args.UsageError(
      `dcm mpps update takes one MPPS SOP Instance UID, got ${positionals.length}: ` +
        `${positionals.join(', ')}.`
    );
  }
  const mppsSopInstanceUid = resolveMppsUid(
    positionals[0], args.resolve(flags, { name: 'mpps-uid' })
  );

  // Nothing local says otherwise — no records are kept — so the step is assumed
  // open. The SCP is the authority and will refuse if it is not. Checking it
  // here is what turns a later 0x0110 into a sentence about terminal states.
  const priorStatus = mpps.Status.IN_PROGRESS;
  const status = noStatus ? undefined : mpps.Status.IN_PROGRESS;
  if (status !== undefined) mpps.assertLegalTransition(priorStatus, status);

  const retrieveAeTitle = args.resolve(flags, { name: 'retrieve-ae' }) ?? '';
  const { built, sourceLabel, assertedFromDisk } =
    common.resolveSeriesFromFolder(flags, retrieveAeTitle);

  const injections = common.parseInjections(flags);
  const injected = common.injectionSummary(injections);

  const dataset = mpps.buildInterimSetDataset({
    status,
    // undefined, not [], when no folder was named: an absent sequence leaves
    // what the step already holds alone, and an empty one wipes it.
    performedSeries: built ? built.items : undefined,
  });
  // Applied after the builder, which is what lets --set reach past its two
  // refusals: the builder will not carry an end date on a running step or a
  // status other than IN PROGRESS, and both are things a receiver's handling of
  // needs testing. The builder's refusals stay the default; --set is the way to
  // say the contradiction is deliberate.
  common.applyInjections(dataset, injections);
  common.verifyDataset('N-SET', mppsSopInstanceUid, dataset, injections);

  // The trap this whole verb is most likely to spring. A folder that scanned to
  // nothing still produces a PRESENT, EMPTY PerformedSeriesSequence, and on an
  // N-SET that erases every series the step had. Saying it before the send is
  // the only place it can still be stopped.
  if (built && built.items.length === 0) {
    log.warn(
      `--series-from found no DICOM instances, so this N-SET carries an EMPTY ` +
        'PerformedSeriesSequence. An N-SET replaces rather than appends, so that will ' +
        'ERASE whatever performed series the step already holds. Drop --series-from to ' +
        'leave them alone.'
    );
  }
  if (built && built.items.length) {
    log.info(
      `${built.items.length} performed series carrying ${built.referenced} instance(s), ` +
        `replacing whatever the step holds now`
    );
  }
  for (const skip of built?.skipped ?? []) {
    log.warn(`not referenced in the MPPS: ${skip.path ?? skip.sopInstanceUid} — ${skip.reason}`);
  }
  if (built?.duplicates) {
    log.info(`${built.duplicates} duplicate SOP Instance UID(s) referenced once each`);
  }

  if (dryRun) {
    common.reportInjections(injections, asJson, 'N-SET');
    if (asJson) {
      return json.result({
        command: 'mpps update',
        outcome: json.Outcome.OK,
        message: 'Dry run: the interim N-SET was built and nothing was sent.',
        payload: {
          dryRun: true,
          mppsSopInstanceUid,
          performedProcedureStepStatus: status ?? null,
          statusSent: status !== undefined,
          performedSeriesSent: built !== undefined,
          seriesCount: built ? built.items.length : 0,
          instancesReferenced: built ? built.referenced : 0,
          assertedFromDisk,
          ...(injected.length ? { injected } : {}),
          dataset,
        },
      });
    }
    log.out(`MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
    log.out('');
    log.out('interim N-SET dataset that would be sent:');
    log.out(common.formatDataset(dataset));
    log.out('');
    log.out(log.color.dim(
      (status === undefined
        ? 'PerformedProcedureStepStatus is absent, not empty: the attribute is not in the\n' +
          'dataset at all, so the step keeps whatever status the SCP holds.\n'
        : `PerformedProcedureStepStatus re-asserts ${mpps.Status.IN_PROGRESS}; the step stays open.\n`) +
        'PerformedProcedureStepEndDate and EndTime are absent, because the step has not ended.'
    ));
    log.out('');
    log.out(log.color.dim('--dry-run: no connection was opened and nothing was sent.'));
    return 0;
  }

  const connection = common.resolveConnection(flags);
  const timeouts = common.timeoutsFrom(flags);

  log.info(
    `N-SET ${connection.callingAe} -> ${connection.calledAe} at ${connection.host}:${connection.port}`
  );
  log.info(
    `  interim: status ${status ?? '(absent)'}, ` +
      `${built ? `${built.items.length} performed series from ${sourceLabel}` : 'no performed series sent'}`
  );
  log.info(`AE  calling ${connection.callingAe} · called ${connection.calledAe}`);

  common.reportInjections(injections, asJson, 'N-SET');

  const peer = json.peerOf(connection);
  const result = await mpps.nSet({ connection, timeouts, mppsSopInstanceUid, dataset });
  const verdict = common.describeNResult(result, 'N-SET');

  if (verdict.ok &&
      result.affectedSopInstanceUid &&
      result.affectedSopInstanceUid !== mppsSopInstanceUid) {
    log.warn(
      `the peer answered about ${result.affectedSopInstanceUid}, not the ` +
        `${mppsSopInstanceUid} that was sent.`
    );
  }

  if (asJson) {
    return json.result({
      command: 'mpps update',
      peer,
      outcome: verdict.envelope.outcome,
      message: verdict.envelope.message,
      detail: verdict.envelope.detail,
      payload: {
        reason: verdict.reason,
        mppsSopInstanceUid,
        // The step is still running either way; this names what the update said
        // about it, which is not the same thing as what the SCP now holds.
        performedProcedureStepStatus: priorStatus,
        statusSent: status !== undefined,
        statusValue: status ?? null,
        performedSeriesSent: built !== undefined,
        seriesCount: built ? built.items.length : 0,
        instancesReferenced: built ? built.referenced : 0,
        instancesNotReferenced: built ? built.skipped.length : 0,
        performedSeriesSource: sourceLabel,
        assertedFromDisk,
        endDateTimeSent: false,
        ...(injected.length ? { injected } : {}),
        affectedSopInstanceUid: result.affectedSopInstanceUid ?? null,
        status: verdict.status ? { code: verdict.status.code, label: verdict.status.label } : null,
      },
    });
  }

  if (!verdict.ok) {
    log.error('N-SET failed — the step was not updated');
    common.reportNResult(verdict);
    log.out('');
    log.out(log.color.dim(
      `The step is whatever the SCP had before this ran, which this end cannot see.\n` +
        'An interim update is the message receivers are least likely to have been tested\n' +
        'against: a refusal here, on a step that a COMPLETED N-SET would close cleanly, is\n' +
        'a finding about the peer rather than about this command. Run again with --verbose\n' +
        'and check the peer log at the matching timestamp.'
    ));
    return 1;
  }

  log.out(`${log.color.green(mpps.Status.IN_PROGRESS)}  procedure step updated on ${connection.calledAe}`);
  log.out('');
  log.out(`  MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
  log.out(`  status attribute       ${status === undefined ? 'not sent' : status}`);
  log.out(`  performed series       ${built ? built.items.length : 'not sent'}`);
  if (built) {
    log.out(`  instances referenced   ${built.referenced}  (from ${sourceLabel})`);
  }
  log.out(`  end date / time        not sent — the step is still running`);
  log.out('');

  if (built) {
    log.out(log.color.dim(
      'That sequence REPLACED the one the step held; N-SET does not append. The next\n' +
        'update has to carry these series again alongside any new ones, or they are lost.'
    ));
    log.out('');
  } else {
    log.out(log.color.dim(
      'PerformedSeriesSequence was not sent, so whatever the step already held is\n' +
        'untouched. That is the point of leaving --series-from off.'
    ));
    log.out('');
  }

  if (assertedFromDisk) {
    log.out(log.color.yellow(
      `The ${built.items.length} performed series above were built by scanning your disk.`
    ));
    log.out(log.color.dim(
      'Nothing here confirms the archive holds those instances — they were not sent by\n' +
        'this command and nobody acknowledged them. The MPPS now asserts they exist. Use\n' +
        '`dcm mpps perform --update-each-chunk`, which sends the images itself and names\n' +
        'only what the archive acknowledged at each chunk boundary.'
    ));
    log.out('');
  }

  log.out(log.color.dim(
    'The step is still open. Close it with `dcm mpps complete` or `dcm mpps discontinue`,\n' +
      'which are the only things that stamp the end date and time. A step left\n' +
      `${mpps.Status.IN_PROGRESS} forever is worse for the receiving system than one explicitly\n` +
      'discontinued.'
  ));
  return 0;
}

module.exports = { run, USAGE, FLAGS, resolveMppsUid };
