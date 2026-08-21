'use strict';

/**
 * The shared body of `dcm mpps complete` and `dcm mpps discontinue`.
 *
 * Not a verb. The two differ only in the terminal status they set and in
 * whether a discontinuation reason applies, so they share everything else:
 * resolving which step is being closed, deciding what the performed series may
 * legally claim, and refusing a transition the SCP would refuse anyway.
 */

const path = require('path');

const log = require('../../lib/log');
const args = require('../../lib/args');
const json = require('../../lib/json');
const { validateUid } = require('../../lib/uid');
const mpps = require('../../lib/mpps');
const common = require('./common');

/** Flags both verbs accept. `reason` and `reason-code` are ignored by complete. */
const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.INJECTION_FLAGS,
  'series-from', 'study-uid', 'no-recurse', 'retrieve-ae',
  'end-date', 'end-time', 'dry-run', 'reason', 'reason-code',
  // The UID is positional here and a flag on `start`, and over MCP both are
  // "mppsUid". Accepting the flag as an alias costs one line and removes a
  // "Unknown option: --mpps-uid" that says nothing about what to do instead.
  'mpps-uid',
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
  dcm mpps ${verb} --mpps-uid <uid> --host <host> --port <port> --called-ae <AE> [options]

<mpps-uid> is the MPPS SOP Instance UID printed by 'dcm mpps start'. It is
required. It is the only handle on the step: this command writes no records and
MPPS has no query service, so there is nowhere to look a lost UID up.

It may be written as the argument or as --mpps-uid, which is the spelling
'dcm mpps start' uses for the same value and the one an MPPS tool over MCP
takes. Both forms mean the same thing; giving both is refused, because two UIDs
on one command line means one of them names a step this would close by mistake.

Connection:
  --host <host>          MPPS peer hostname.                    [env DCM_HOST]
  --port <port>          MPPS peer DIMSE port.                  [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.                   [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI         [env DCM_CALLING_AE]
  --timeout <ms>         Silence allowed before giving up. Default: 60000.

What was performed:
  --series-from <folder> Build the performed series by scanning a folder. This
                         is the ONLY source this verb has, and it asserts what
                         is on your disk. READ THE NOTE BELOW before using it.
                         Given nothing, the step is closed naming no images.
  --study-uid <uid>      Scope --series-from to this one study. Only needed when
                         the folder holds more than one: without it, such a
                         folder is refused rather than merged.
  --no-recurse           With --series-from, do not descend into subfolders.
  --retrieve-ae <AE>     Retrieve AE Title recorded against each performed
                         series — the AE the images can be fetched from.
  --end-date <YYYYMMDD>  Default: today, local time.
  --end-time <HHMMSS>    Default: now, local time.
${reasonBlock}
Other:
  --mpps-uid <uid>       The step being closed, as a flag rather than an
                         argument. Same value, same meaning; give one.
  --set <Key>=<Value>    Stamp a value into the outgoing N-SET verbatim, with no
                         client-side validation at all. Repeatable. See below.
  --dry-run              Build and print the N-SET without connecting.
  --json                 Emit the result as JSON.
  --verbose              Log the full association negotiation.

Injecting a value (--set):
  --set <Keyword|(gggg,eeee)>=<Value> puts the value into the N-SET dataset
  exactly as typed, with nothing checked — not length, not the VR's character
  repertoire, not an enumeration. It is applied last, so it overwrites what the
  flags produced, including the terminal status itself:

    --set PerformedProcedureStepStatus=FINISHED
    --set PerformedProcedureStepEndTime=25:00:00

  That first one is the reason this exists here. ${status} is the only value
  this verb will construct, so an SCP's handling of a status outside the three
  PS3.4 defines cannot be exercised any other way.

  This is the explicit "I know what I am doing" path, the same framing as
  --allow-study-mismatch on 'dcm mpps perform'. A banner naming every injected
  attribute goes to stderr whenever it is in use, and the injections are ALSO
  recorded in the output — as "injected" in JSON, above the result otherwise —
  so --quiet cannot produce a run that does not say what it did. An unknown or
  private tag is refused rather than injected, and a value the dataset writer
  would silently SHORTEN is refused before the association opens: a shortened
  value is conformant, so the peer would answer it normally and the test would
  pass without ever having asked the question.

Note: --series-from asserts what is on YOUR DISK, not what the archive holds.
  PerformedSeriesSequence is a clinical record of work performed, and every
  system downstream reads it as a list of instances that exist in the archive.
  A folder scan cannot know that: it lists what you have locally, which may
  include instances the archive refused, never received, or rejected as
  duplicates. Naming one of those in an MPPS is a fabricated record.

  There is no better source here, and that is deliberate. Only the process that
  did the C-STORE knows which instances the archive positively acknowledged,
  and that knowledge is written nowhere — this tool keeps no records of any
  kind. So a standalone 'dcm mpps ${verb}' has exactly two honest answers to
  "which images?": name none, or name what a folder scan found and say plainly
  that it came from disk. It does say so, in yellow, every time it does it.

  When the performed series matters, use 'dcm mpps perform'. It does the
  N-CREATE, the C-STORE and the N-SET in one process, so the acknowledgement
  ledger never has to survive anything.

Note: --series-from describes ONE study, so a folder holding two is refused.
  A performed procedure step is about a single study — Study Instance UID is
  Type 1 inside ScheduledStepAttributesSequence and is the key the RIS
  reconciles the step against — so a PerformedSeriesSequence built from two
  studies would attribute half those images to the wrong order. Anything
  downstream that totals ReferencedImageSequence into an expected image count
  would then get a number the step's own scheduled attributes contradict, and
  nothing in the N-SET would show it. Pass --study-uid to name which study in
  the folder this step performed, or split the folder and close one step per
  study. It is the same refusal 'dcm mpps perform' gives.

Note: closing the step here says nothing about the worklist entry.
  This command reports what the MPPS SCP answered. Whether that SCP, or a RIS
  behind it, then moves the scheduled procedure step out of the worklist is its
  own business and is not visible from this end. If you need to know the
  worklist changed, query it: dcm find --mwl ...

Example:
  dcm mpps ${verb} 2.25.31415926535897932384626433832795028841 \\
    --host ris.example.org --port 11112 --called-ae MPPSSCP
`.trimStart();
}

/**
 * Resolves which MPPS SOP Instance UID is being closed.
 *
 * One source, and deliberately no other: the argument. Nothing is written to
 * disk, so there is no file to read it out of, and MPPS has no query service,
 * so the peer cannot be asked which steps it is holding either.
 *
 * Two spellings, one meaning. The UID is positional here and `--mpps-uid` on
 * `dcm mpps start`, which is a difference nobody chose: the flag simply was
 * never accepted on the closing verbs, so a script that had just read
 * `mppsSopInstanceUid` out of start's JSON and written the obvious command line
 * got "Unknown option: --mpps-uid" — a message that does not hint at the
 * positional form. Over MCP both verbs already take one parameter named
 * mppsUid, so the two spellings were only ever apart at the shell.
 *
 * Giving both is a mistake worth failing on rather than resolving by
 * precedence: two UIDs on one command line means one of them is not the step
 * being closed, and closing the wrong step is not recoverable from here.
 *
 * @param {string|undefined} positional
 * @param {string|undefined} flag
 * @param {string} verb
 * @returns {string}
 */
function resolveMppsUid(positional, flag, verb = 'complete') {
  if (positional && flag !== undefined) {
    if (positional === flag) {
      throw new args.UsageError(
        `The MPPS SOP Instance UID was given twice, as an argument and as --mpps-uid ${flag}. ` +
          'They agree, so nothing is ambiguous, but give one of them.'
      );
    }
    throw new args.UsageError(
      `Two different MPPS SOP Instance UIDs: "${positional}" as an argument and ` +
        `"${flag}" as --mpps-uid. One of them names a step this command would close by ` +
        'mistake, and nothing here can tell which. Give one.'
    );
  }

  const uid = positional ?? flag;
  if (!uid) {
    throw new args.UsageError(
      'Missing the MPPS SOP Instance UID. It is the value `dcm mpps start` printed as ' +
        '"MPPS SOP Instance UID", and it is the only handle on the step:\n' +
        `  dcm mpps ${verb} <mpps-uid> --host ... --port ... --called-ae ...\n` +
        `  dcm mpps ${verb} --mpps-uid <mpps-uid> --host ... --port ... --called-ae ...\n` +
        'This tool keeps no record of the steps it opened, and MPPS has no query service, ' +
        'so a lost UID cannot be recovered from here or from the peer.'
    );
  }

  return mpps.requireUid(uid, positional ? '<mpps-uid>' : '--mpps-uid');
}

/**
 * Checks --study-uid is a UID at all.
 *
 * Called before the scan as well as inside the scoping, because scanning a
 * large tree to then reject the value for a stray space is a slow way to say
 * something that was knowable immediately.
 *
 * @param {string} uid
 * @returns {string}
 */
function requireStudyUidFlag(uid) {
  const verdict = validateUid(uid);
  if (!verdict.valid) {
    throw new args.UsageError(
      `--study-uid "${uid}" is not a valid DICOM UID: ${verdict.reason}.`
    );
  }
  return uid;
}

/**
 * Narrows a scan down to the one study this step is allowed to describe.
 *
 * One performed procedure step is one study. The builder in lib/mpps.js walks
 * every study a scan found, so handing it a scan wholesale is what merged two
 * studies into one PerformedSeriesSequence: the sequence claimed series from
 * both, while ScheduledStepAttributesSequence named only one, and any count
 * taken off ReferencedImageSequence came out wrong with nothing to show for it.
 * Scoping happens here, at the caller, so the builder keeps its single job.
 *
 * @param {object} scanned From scan().
 * @param {string} seriesFrom The folder as the operator wrote it.
 * @param {string|undefined} requestedStudyUid --study-uid, if given.
 * @returns {{studies: Map<string, object>, sourceLabel: string}}
 */
function scopeToOneStudy(scanned, seriesFrom, requestedStudyUid) {
  if (requestedStudyUid !== undefined) {
    requireStudyUidFlag(requestedStudyUid);

    const study = scanned.studies.get(requestedStudyUid);
    if (!study) {
      // Naming a study the folder does not hold has to be refused, not turned
      // into an empty sequence: an empty PerformedSeriesSequence is a legal
      // N-SET, so a typo here would close the step claiming no images at all.
      const found = [...scanned.studies.values()]
        .slice(0, 5)
        .map((s) => `  ${s.studyInstanceUid}  ${s.instances.length} instance(s)  ${s.patientName ?? ''}`);
      throw new args.UsageError(
        `--study-uid ${requestedStudyUid} is not in ${path.resolve(seriesFrom)}. ` +
          (scanned.studies.size === 0
            ? 'No DICOM instances were found there at all.'
            : `The scan found ${scanned.studies.size} stud${scanned.studies.size === 1 ? 'y' : 'ies'}:\n` +
              `${found.join('\n')}${scanned.studies.size > 5 ? `\n  … and ${scanned.studies.size - 5} more` : ''}`) +
          '\nNothing was sent.'
      );
    }

    return {
      studies: new Map([[requestedStudyUid, study]]),
      sourceLabel: `a scan of ${seriesFrom}, scoped to study ${requestedStudyUid}`,
    };
  }

  if (scanned.studies.size > 1) {
    // The same refusal `dcm mpps perform` gives, in perform's own words, so an
    // operator who has met one recognises the other. Required lazily because
    // perform pulls in the store and re-stamp machinery a close never uses.
    //
    // Only the ambiguous case is delegated. A folder holding no DICOM at all is
    // left alone deliberately: this verb already warns, loudly and by name,
    // that it is about to mark a step COMPLETED naming no images, and that
    // warning is the more useful one here.
    const { assertOneStudy } = require('./perform');
    try {
      assertOneStudy(scanned, seriesFrom, '');
    } catch (err) {
      if (err.name !== 'UsageError') throw err;
      throw new args.UsageError(
        `${err.message}\n` +
          '\n' +
          'Or name the one this step performed:\n' +
          '  --study-uid <uid>          Build PerformedSeriesSequence from that study alone\n' +
          '                             and ignore the rest of the folder.'
      );
    }
  }

  return { studies: scanned.studies, sourceLabel: `a scan of ${seriesFrom}` };
}

/**
 * Builds PerformedSeriesSequence from the one source this verb has.
 *
 * A folder scan, or nothing at all. The acknowledged-instance ledger belongs to
 * the process that did the C-STORE and is not written down anywhere, so a
 * standalone close cannot have it. `dcm mpps perform` is the verb that does.
 *
 * @param {Map} flags
 * @param {string} retrieveAeTitle
 * @returns {{built: object, sourceLabel: string, assertedFromDisk: boolean}}
 */
function resolvePerformedSeries(flags, retrieveAeTitle) {
  const seriesFrom = args.resolve(flags, { name: 'series-from' });
  const requestedStudyUid = args.resolve(flags, { name: 'study-uid' });

  if (seriesFrom !== undefined) {
    if (requestedStudyUid !== undefined) requireStudyUidFlag(requestedStudyUid);

    // Required lazily: a close that names no folder should not pay for the
    // scanner, and the scanner pulls in the DICOM parser.
    const { scan } = require('../../lib/scan');
    const scanned = scan(seriesFrom, { recurse: !flags.has('no-recurse') });
    const { studies, sourceLabel } = scopeToOneStudy(scanned, seriesFrom, requestedStudyUid);

    // Both of these take the scoped map. seriesMeta keyed off the whole scan
    // would let a second study's series description reach this step's sequence.
    const built = mpps.buildPerformedSeriesSequenceFromFolder(studies, {
      retrieveAeTitle,
      seriesMeta: mpps.seriesMetaFromScan(studies),
    });
    return { built, sourceLabel, assertedFromDisk: true };
  }

  if (requestedStudyUid !== undefined) {
    throw new args.UsageError(
      '--study-uid scopes the folder --series-from scans, and no folder was given, so ' +
        'there is nothing to scope. It does not name the study being closed: the step is ' +
        'named by its MPPS SOP Instance UID, and the study it belongs to was fixed when ' +
        '`dcm mpps start` created it.'
    );
  }

  return {
    built: { items: [], referenced: 0, skipped: [], duplicates: 0 },
    sourceLabel: 'nothing — no performed series was given',
    assertedFromDisk: false,
  };
}

/**
 * Prints the caveat a folder-scanned performed series must carry.
 *
 * The USAGE promises this appears "every time", and --dry-run is the run where
 * it matters most: that is when a human is reading the dataset and deciding
 * whether to send it. It lives in one function so the two callers cannot drift
 * into two different accounts of the same claim.
 *
 * @param {number} seriesCount
 * @param {{dryRun?: boolean}} [opts] Whether the assertion has been made yet.
 */
function reportAssertedFromDisk(seriesCount, opts = {}) {
  const claim = opts.dryRun ? 'would assert' : 'now asserts';
  log.out(
    log.color.yellow(
      `The ${seriesCount} performed series above were built by scanning your disk.`
    )
  );
  log.out(
    log.color.dim(
      'Nothing here confirms the archive holds those instances — they were not sent by\n' +
        `this command and nobody acknowledged them. The MPPS ${claim} they exist. If\n` +
        'that is not certain, use `dcm mpps perform`, which sends the images itself and\n' +
        'names only what the archive acknowledged.'
    )
  );
  log.out('');
}

/**
 * N-SET to a terminal status.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @param {{verb: string, status: string}} spec
 * @returns {Promise<number>}
 */
async function finish(parsed, spec) {
  const { flags } = parsed;
  const { verb } = spec;

  if (flags.has('help')) return common.helpFor(verb, flags, usageFor(verb));

  // Outside this wrapper a UsageError — a malformed UID, a folder holding two
  // studies, --reason on complete — reaches src/cli.js and prints prose to
  // stderr with an empty stdout, which under --json is a promise broken.
  return common.guardVerb(verb, flags, () => execute(parsed, spec));
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @param {{verb: string, status: string}} spec
 * @returns {Promise<number>}
 */
async function execute(parsed, spec) {
  const { flags, positionals } = parsed;
  const { verb, status } = spec;

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

  const mppsSopInstanceUid = resolveMppsUid(
    positionals[0], args.resolve(flags, { name: 'mpps-uid' }), verb
  );

  // Nothing local says otherwise — no records are kept — so the step is assumed
  // open. The SCP is the authority on that and will refuse if it is not.
  const priorStatus = mpps.Status.IN_PROGRESS;
  mpps.assertLegalTransition(priorStatus, status);

  const now = new Date();
  const endDate = args.resolve(flags, { name: 'end-date' }) ?? mpps.dicomDate(now);
  const endTime = args.resolve(flags, { name: 'end-time' }) ?? mpps.dicomTime(now);
  const retrieveAeTitle = args.resolve(flags, { name: 'retrieve-ae' }) ?? '';

  const { built, sourceLabel, assertedFromDisk } =
    resolvePerformedSeries(flags, retrieveAeTitle);

  const reason = verb === 'discontinue' ? args.resolve(flags, { name: 'reason' }) : undefined;
  const reasonCode = verb === 'discontinue'
    ? mpps.parseReasonCode(args.resolve(flags, { name: 'reason-code' }))
    : [];

  const injections = common.parseInjections(flags);
  const injected = common.injectionSummary(injections);

  const dataset = mpps.buildSetDataset({
    status,
    endDate,
    endTime,
    performedSeries: built.items,
    discontinuationReasonCode: reasonCode,
  });
  // Last, so --set overwrites what the flags produced — including the terminal
  // status itself, which is the only way to ask an SCP what it does with a
  // PerformedProcedureStepStatus that is not one of the three legal values.
  common.applyInjections(dataset, injections);
  common.verifyDataset('N-SET', mppsSopInstanceUid, dataset, injections);

  // An empty PerformedSeriesSequence on a COMPLETED step is legal DICOM and
  // almost never what someone meant: it says the work finished and produced
  // nothing. Which of the two warnings applies depends on whether a source was
  // given at all, because "you forgot a flag" and "the flag you gave is empty"
  // have different fixes.
  if (status === mpps.Status.COMPLETED && built.items.length === 0) {
    log.warn(
      'this N-SET marks the step COMPLETED with an empty PerformedSeriesSequence — ' +
        'it claims the work finished and names no images at all. Pass --series-from ' +
        'unless that is really what you mean.'
    );
  }

  for (const skip of built.skipped) {
    log.warn(`not referenced in the MPPS: ${skip.path ?? skip.sopInstanceUid} — ${skip.reason}`);
  }
  if (built.duplicates) {
    log.info(`${built.duplicates} duplicate SOP Instance UID(s) referenced once each`);
  }

  if (dryRun) {
    common.reportInjections(injections, asJson, 'N-SET');
    if (asJson) {
      return json.result({
        command: `mpps ${verb}`,
        outcome: json.Outcome.OK,
        message: 'Dry run: the N-SET was built and nothing was sent.',
        payload: {
          dryRun: true,
          mppsSopInstanceUid,
          performedProcedureStepStatus: status,
          seriesCount: built.items.length,
          instancesReferenced: built.referenced,
          assertedFromDisk,
          reasonRecordedLocally: reason ?? null,
          ...(injected.length ? { injected } : {}),
          dataset,
        },
      });
    }
    log.out(`MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
    log.out('');
    log.out('N-SET dataset that would be sent:');
    log.out(common.formatDataset(dataset));
    log.out('');
    // Before the "nothing was sent" line, not after: the caveat is about the
    // dataset printed above, and this is the moment someone is reading it.
    if (assertedFromDisk) reportAssertedFromDisk(built.items.length, { dryRun: true });
    log.out(log.color.dim('--dry-run: no connection was opened and nothing was sent.'));
    return 0;
  }

  const connection = common.resolveConnection(flags);
  const timeouts = common.timeoutsFrom(flags);

  log.info(
    `N-SET ${connection.callingAe} -> ${connection.calledAe} at ${connection.host}:${connection.port}`
  );
  log.info(`  ${priorStatus} -> ${status}, ${built.items.length} performed series from ${sourceLabel}`);

  // The three AE Titles are printed by the verbs that open a step, where a
  // mismatch is decided; here the step already exists and is named by its UID,
  // so only the two that decide whether this association is allowed matter.
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
      command: `mpps ${verb}`,
      peer,
      outcome: verdict.envelope.outcome,
      message: verdict.envelope.message,
      detail: verdict.envelope.detail,
      payload: {
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
        ...(injected.length ? { injected } : {}),
        affectedSopInstanceUid: result.affectedSopInstanceUid ?? null,
        status: verdict.status ? { code: verdict.status.code, label: verdict.status.label } : null,
      },
    });
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

  if (assertedFromDisk) reportAssertedFromDisk(built.items.length);

  log.out(
    log.color.dim(
      'The SCP accepted the N-SET. What it does next with the scheduled procedure step —\n' +
        'whether the worklist entry disappears, changes status, or stays put — happens on\n' +
        'its side and is not visible from here. Query the worklist if you need to know.'
    )
  );
  return 0;
}

module.exports = {
  finish, usageFor, FLAGS, resolveMppsUid, resolvePerformedSeries, scopeToOneStudy,
};
