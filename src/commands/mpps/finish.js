'use strict';

/**
 * The shared body of `dcm mpps complete` and `dcm mpps discontinue`.
 *
 * Not a verb. The two differ only in the terminal status they set and in
 * whether a discontinuation reason applies, so they share everything else:
 * resolving which step is being closed, deciding what the performed series may
 * legally claim, and refusing a transition the SCP would refuse anyway.
 */

const log = require('../../lib/log');
const args = require('../../lib/args');
const mpps = require('../../lib/mpps');
const common = require('./common');

/** Flags both verbs accept. `reason` and `reason-code` are ignored by complete. */
const FLAGS = [
  ...common.CONNECTION_FLAGS,
  'acknowledged', 'series-from', 'no-recurse', 'retrieve-ae',
  'end-date', 'end-time', 'dry-run', 'reason', 'reason-code',
];

/**
 * Builds the USAGE text for one of the two verbs.
 *
 * @param {string} verb 'complete' or 'discontinue'
 * @returns {string}
 */
function usageFor(verb) {
  const status = verb === 'complete' ? mpps.Status.COMPLETED : mpps.Status.DISCONTINUED;
  const reasonBlock = verb === 'discontinue'
    ? `
Discontinuation reason:
  --reason <text>        Free text. Recorded in this command's output and NOT
                         sent. A discontinuation reason is a coded attribute:
                         CodeValue, CodingSchemeDesignator and CodeMeaning are
                         all Type 1 inside it, so carrying free text there means
                         inventing a code value that means nothing to the
                         receiving system. That is a fabricated record, so this
                         tool will not do it.
  --reason-code <c^s^m>  The coded reason, actually sent, e.g.
                         "110513^DCM^Discontinued for equipment failure".
`
    : '';

  return `
dcm mpps ${verb} — close a performed procedure step (N-SET, ${status})

Usage:
  dcm mpps ${verb} <mpps-uid> --host <host> --port <port> --called-ae <AE> [options]

<mpps-uid> is the MPPS SOP Instance UID printed by 'dcm mpps start'. It may be
omitted when --acknowledged names a step record that carries it.

Connection:
  --host <host>          MPPS peer hostname.                    [env DCM_HOST]
  --port <port>          MPPS peer DIMSE port.                  [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.                   [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI         [env DCM_CALLING_AE]
  --timeout <ms>         Silence allowed before giving up. Default: 60000.

What was performed:
  --acknowledged <file.json>  A step record written by 'dcm mpps start --out' or
                         'dcm mpps perform --write-acknowledged'. Performed
                         series are built from the instances in it, which are
                         exactly the ones the archive acknowledged.
  --series-from <folder> Build the performed series by scanning a folder.
                         READ THE NOTE BELOW before using this.
  --no-recurse           With --series-from, do not descend into subfolders.
  --retrieve-ae <AE>     Retrieve AE Title recorded against each performed
                         series — the AE the images can be fetched from.
  --end-date <YYYYMMDD>  Default: today, local time.
  --end-time <HHMMSS>    Default: now, local time.
${reasonBlock}
Other:
  --dry-run              Build and print the N-SET without connecting.
  --json                 Emit the result as JSON.
  --verbose              Log the full association negotiation.

Note: --series-from asserts what is on YOUR DISK, not what the archive holds.
  PerformedSeriesSequence is a clinical record of work performed, and every
  system downstream reads it as a list of instances that exist in the archive.
  A folder scan cannot know that: it lists what you have locally, which may
  include instances the archive refused, never received, or rejected as
  duplicates. Naming one of those in an MPPS is a fabricated record.

  Use --acknowledged wherever there is a choice. --series-from exists for the
  case where some other tool did the transfer and the step still has to be
  closed, and this command says plainly, in its output, that the sequence was
  asserted from disk.

Note: closing the step here says nothing about the worklist entry.
  This command reports what the MPPS SCP answered. Whether that SCP, or a RIS
  behind it, then moves the scheduled procedure step out of the worklist is its
  own business and is not visible from this end. If you need to know the
  worklist changed, query it: dcm find --mwl ...

Example:
  dcm mpps ${verb} 2.25.31415926535897932384626433832795028841 \\
    --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --acknowledged step.json
`.trimStart();
}

/**
 * Resolves which MPPS SOP Instance UID is being closed.
 *
 * @param {string|undefined} positional
 * @param {object|undefined} record
 * @returns {string}
 */
function resolveMppsUid(positional, record) {
  const fromRecord = record?.mppsSopInstanceUid;

  if (positional && fromRecord && positional !== fromRecord) {
    throw new args.UsageError(
      `The UID on the command line (${positional}) is not the one in the step record ` +
        `(${fromRecord}). One of them names a different procedure step, and closing ` +
        'the wrong one is worse than closing none. Drop the positional argument to use ' +
        'the record, or drop --acknowledged to use the argument.'
    );
  }

  const uid = positional ?? fromRecord;
  if (!uid) {
    throw new args.UsageError(
      'Missing the MPPS SOP Instance UID. It is the value `dcm mpps start` printed as ' +
        '"MPPS SOP Instance UID", and it is the only handle on the step:\n' +
        '  dcm mpps complete <mpps-uid> --host ... --port ... --called-ae ...\n' +
        'Or pass --acknowledged <file.json>, which carries it.'
    );
  }

  return mpps.requireUid(uid, positional ? '<mpps-uid>' : 'the step record');
}

/**
 * Builds PerformedSeriesSequence from whichever source was named.
 *
 * @param {Map} flags
 * @param {object|undefined} record
 * @param {string} retrieveAeTitle
 * @returns {{built: object, sourceLabel: string, assertedFromDisk: boolean}}
 */
function resolvePerformedSeries(flags, record, retrieveAeTitle) {
  const seriesFrom = args.resolve(flags, { name: 'series-from' });
  const hasRecord = record !== undefined;

  if (seriesFrom !== undefined && hasRecord) {
    throw new args.UsageError(
      '--acknowledged and --series-from both answer "which instances were performed?", ' +
        'and they answer it differently: one lists what the archive acknowledged, the ' +
        'other lists what is on this disk. Pick one. --acknowledged is the honest answer ' +
        'wherever it is available.'
    );
  }

  if (hasRecord) {
    const built = mpps.buildPerformedSeriesSequence(record.instances, { retrieveAeTitle });
    return { built, sourceLabel: 'acknowledged instances', assertedFromDisk: false };
  }

  if (seriesFrom !== undefined) {
    // Required lazily: a `complete` that uses --acknowledged should not pay for
    // the scanner, and the scanner pulls in the DICOM parser.
    const { scan } = require('../../lib/scan');
    const scanned = scan(seriesFrom, { recurse: !flags.has('no-recurse') });
    const built = mpps.buildPerformedSeriesSequenceFromFolder(scanned.studies, {
      retrieveAeTitle,
      seriesMeta: mpps.seriesMetaFromScan(scanned.studies),
    });
    return { built, sourceLabel: `a scan of ${seriesFrom}`, assertedFromDisk: true };
  }

  return {
    built: { items: [], referenced: 0, skipped: [], duplicates: 0 },
    sourceLabel: 'nothing — no performed series was given',
    assertedFromDisk: false,
  };
}

/**
 * N-SET to a terminal status.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @param {{verb: string, status: string}} spec
 * @returns {Promise<number>}
 */
async function finish(parsed, spec) {
  const { flags, positionals } = parsed;
  const { verb, status } = spec;

  if (flags.has('help')) {
    log.out(usageFor(verb));
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  if (verb === 'complete' && (flags.has('reason') || flags.has('reason-code'))) {
    throw new args.UsageError(
      'A reason belongs to a discontinued step, not a completed one. Use ' +
        '`dcm mpps discontinue` if the work did not finish.'
    );
  }

  if (positionals.length > 1) {
    throw new args.UsageError(
      `dcm mpps ${verb} takes one MPPS SOP Instance UID, got ${positionals.length}: ` +
        `${positionals.join(', ')}.`
    );
  }

  const dryRun = flags.has('dry-run');
  const asJson = flags.has('json');

  const acknowledgedFlag = args.resolve(flags, { name: 'acknowledged' });
  const loaded = acknowledgedFlag !== undefined
    ? mpps.readStepRecord(acknowledgedFlag)
    : undefined;
  const record = loaded?.record;

  const mppsSopInstanceUid = resolveMppsUid(positionals[0], record);

  // With no record there is nothing local that says otherwise, so the step is
  // assumed open — the SCP is the authority and will refuse if it is not.
  const priorStatus = record?.status ?? mpps.Status.IN_PROGRESS;
  mpps.assertLegalTransition(priorStatus, status);

  const now = new Date();
  const endDate = args.resolve(flags, { name: 'end-date' }) ?? mpps.dicomDate(now);
  const endTime = args.resolve(flags, { name: 'end-time' }) ?? mpps.dicomTime(now);
  const retrieveAeTitle = args.resolve(flags, { name: 'retrieve-ae' }) ?? '';

  const { built, sourceLabel, assertedFromDisk } =
    resolvePerformedSeries(flags, record, retrieveAeTitle);

  const reason = verb === 'discontinue' ? args.resolve(flags, { name: 'reason' }) : undefined;
  const reasonCode = verb === 'discontinue'
    ? mpps.parseReasonCode(args.resolve(flags, { name: 'reason-code' }))
    : [];

  const dataset = mpps.buildSetDataset({
    status,
    endDate,
    endTime,
    performedSeries: built.items,
    discontinuationReasonCode: reasonCode,
  });

  // An empty PerformedSeriesSequence on a COMPLETED step is legal DICOM and
  // almost never what someone meant: it says the work finished and produced
  // nothing. Which of the two warnings applies depends on whether a source was
  // given at all, because "you forgot a flag" and "the flag you gave is empty"
  // have different fixes.
  if (status === mpps.Status.COMPLETED && built.items.length === 0) {
    log.warn(
      record
        ? `this N-SET marks the step COMPLETED, but "${loaded.file}" records no ` +
            'acknowledged instances, so PerformedSeriesSequence is empty — the step will ' +
            'claim the work finished and name no images at all.'
        : 'this N-SET marks the step COMPLETED with an empty PerformedSeriesSequence — ' +
            'it claims the work finished and names no images at all. Pass --acknowledged ' +
            '(or --series-from) unless that is really what you mean.'
    );
  }

  for (const skip of built.skipped) {
    log.warn(`not referenced in the MPPS: ${skip.path ?? skip.sopInstanceUid} — ${skip.reason}`);
  }
  if (built.duplicates) {
    log.info(`${built.duplicates} duplicate SOP Instance UID(s) referenced once each`);
  }

  if (dryRun) {
    if (asJson) {
      log.out(JSON.stringify({
        ok: true, dryRun: true, mppsSopInstanceUid,
        performedProcedureStepStatus: status,
        seriesCount: built.items.length,
        instancesReferenced: built.referenced,
        assertedFromDisk,
        reasonRecordedLocally: reason ?? null,
        dataset,
      }, null, 2));
      return 0;
    }
    log.out(`MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
    log.out('');
    log.out('N-SET dataset that would be sent:');
    log.out(common.formatDataset(dataset));
    log.out('');
    log.out(log.color.dim('--dry-run: no connection was opened and nothing was sent.'));
    return 0;
  }

  const connection = common.resolveConnection(flags);
  const timeouts = common.timeoutsFrom(flags);

  log.info(
    `N-SET ${connection.callingAe} -> ${connection.calledAe} at ${connection.host}:${connection.port}`
  );
  log.info(`  ${priorStatus} -> ${status}, ${built.items.length} performed series from ${sourceLabel}`);

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
    log.out(JSON.stringify({
      ok: verdict.ok,
      reason: verdict.reason,
      mppsSopInstanceUid,
      performedProcedureStepStatus: verdict.ok ? status : priorStatus,
      priorStatus,
      seriesCount: built.items.length,
      instancesReferenced: built.referenced,
      instancesNotReferenced: built.skipped.length,
      performedSeriesSource: sourceLabel,
      assertedFromDisk,
      reasonRecordedLocally: reason ?? null,
      reasonSent: reasonCode.length ? reasonCode[0] : null,
      peer: connection,
      status: verdict.status ? { code: verdict.status.code, label: verdict.status.label } : null,
      message: verdict.lines.join(' '),
    }, null, 2));
    return verdict.ok ? 0 : 1;
  }

  if (!verdict.ok) {
    log.error(`N-SET failed — the step was not marked ${status}`);
    common.reportNResult(verdict);
    return 1;
  }

  const colour = status === mpps.Status.COMPLETED ? log.color.green : log.color.yellow;
  log.out(`${colour(status)}  procedure step closed on ${connection.calledAe}`);
  log.out('');
  log.out(`  MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
  log.out(`  ended                  ${endDate} ${endTime}`);
  log.out(`  performed series       ${built.items.length}`);
  log.out(`  instances referenced   ${built.referenced}  (from ${sourceLabel})`);
  if (reason) log.out(`  reason                 ${reason}`);
  log.out('');

  if (reason && reasonCode.length === 0) {
    log.out(
      log.color.dim(
        `The reason "${reason}" was recorded here and NOT sent. A discontinuation reason\n` +
          'is a coded attribute whose CodeValue, CodingSchemeDesignator and CodeMeaning are\n' +
          'all Type 1, so free text has nowhere legal to go in it and inventing a code would\n' +
          'put a meaningless one in the record. Use --reason-code CODE^SCHEME^MEANING to send\n' +
          'a real one.'
      )
    );
    log.out('');
  }

  if (assertedFromDisk) {
    log.out(
      log.color.yellow(
        `The ${built.items.length} performed series above were built by scanning your disk.`
      )
    );
    log.out(
      log.color.dim(
        'Nothing here confirms the archive holds those instances — they were not sent by\n' +
          'this command and nobody acknowledged them. The MPPS now asserts they exist. If\n' +
          'that is not certain, close the step with --acknowledged instead.'
      )
    );
    log.out('');
  }

  log.out(
    log.color.dim(
      'The SCP accepted the N-SET. What it does next with the scheduled procedure step —\n' +
        'whether the worklist entry disappears, changes status, or stays put — happens on\n' +
        'its side and is not visible from here. Query the worklist if you need to know.'
    )
  );
  return 0;
}

module.exports = { finish, usageFor, FLAGS, resolveMppsUid, resolvePerformedSeries };
