'use strict';

const log = require('../../lib/log');
const args = require('../../lib/args');
const { validateUid } = require('../../lib/uid');
const mpps = require('../../lib/mpps');
const common = require('./common');

const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.ATTRIBUTE_FLAGS,
  'dry-run',
];

const USAGE = `
dcm mpps start — open a performed procedure step (N-CREATE, IN PROGRESS)

Tells the MPPS SCP that work has begun on a scheduled study. Prints the MPPS
SOP Instance UID it generated: that UID is the only handle on the step, and
'dcm mpps complete' cannot close it without one.

Nothing is written to disk. This command keeps no record of the step, and MPPS
has no query service, so the printed UID cannot be recovered from anywhere —
not from here, and not from the SCP. Copy it. --json puts it in
"mppsSopInstanceUid" for a caller that would rather not scrape the text.

Usage:
  dcm mpps start --host <host> --port <port> --called-ae <AE> --study-uid <uid> --modality <MOD> [options]
  dcm mpps start --host <host> --port <port> --called-ae <AE> --from-worklist <file.json> [options]

Connection:
  --host <host>          MPPS peer hostname.                    [env DCM_HOST]
  --port <port>          MPPS peer DIMSE port.                  [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.                   [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI         [env DCM_CALLING_AE]
  --timeout <ms>         Silence allowed before giving up. Default: 60000.

Scheduled step (the order this work came from):
  --study-uid <uid>      Study Instance UID. Type 1, and THE correlation key —
                         the RIS matches the step to the order and to the images
                         on this and nothing else. Repeatable; see below.
  --accession <text>     Accession Number.
  --requested-procedure-id <id>
  --requested-procedure-description <text>
  --scheduled-step-id <id>       Scheduled Procedure Step ID.
  --unscheduled          There is no order. Emits ScheduledStepAttributesSequence
                         as exactly one ZERO-LENGTH item, which is how PS3.3
                         represents a walk-in or ER exam. Refuses --study-uid and
                         --from-worklist, which say the opposite.

Performed step (what is actually being done):
  --modality <MOD>       Modality, e.g. CT. Type 1.
  --step-id <id>         Performed Procedure Step ID. Type 1. Defaults to
                         --scheduled-step-id when that is given.
  --station-ae <AE>      Performed Station AE Title. Type 1. Defaults to
                         --calling-ae, which is the AE the images will arrive
                         under, so the two agree by default.
  --station-name <text>  Performed Station Name.
  --location <text>      Performed Location.
  --step-description <text>      Performed Procedure Step Description.
  --start-date <YYYYMMDD>        Default: today, local time.
  --start-time <HHMMSS>          Default: now, local time.

Patient:
  --patient-id <id>  --patient-name <name>  --patient-birth-date <YYYYMMDD>
  --patient-sex <M|F|O>

Other:
  --from-worklist <file.json>   Take the attributes above from a worklist item.
  --mpps-uid <uid>       Use this MPPS SOP Instance UID instead of generating one.
  --dry-run              Build and print the N-CREATE without connecting.
  --json                 Emit the result as JSON.
  --verbose              Log the full association negotiation.

--from-worklist:
  The file may be a single worklist item, an array of them, or an object with a
  "matches" or "items" array. Explicit flags win over anything in the file.

  It must hold the attributes as they arrived, NOT the output of
  'dcm find --mwl --json'. That output is formatted for a person to read, which
  turns every sequence into a string: ReferencedStudySequence comes out as text
  and an empty sequence comes out as "". Feeding it to an N-CREATE would drop
  those attributes. Export with 'dcm find --mwl --json-raw' instead, which emits
  the attributes unrendered. If you pass the rendered form, this command says so
  by name rather than sending a malformed step.

Note:
  Every Type 1 attribute is checked here, before anything is sent. That is not
  belt-and-braces: many SCPs accept an N-CREATE carrying an empty Type 1,
  answer success, and then never reconcile the step against the order, because
  the attribute they reconcile on was blank. From this end it looks like it
  worked. Days later the order is still open.

Unscheduled steps (--unscheduled):
  A walk-in, an ER exam, a repeat nobody booked: the work is real and no
  scheduled procedure step lies behind it. PS3.3 C.4.14 is specific about the
  shape — ScheduledStepAttributesSequence is PRESENT and holds exactly ONE
  ZERO-LENGTH item. All three of the obvious alternatives are wrong, and each
  is wrong differently:

    omitting the sequence         it is Type 1; an SCP that checks refuses it
    --study-uid ""                a present, empty Type 1, which is the shape
                                  SCPs accept and then never reconcile
    an item with blank values     seven empty attributes is not a zero-length
                                  item, and the item is no longer zero-length

  Inside a POPULATED item StudyInstanceUID stays Type 1 and is still checked.
  The exemption applies to the zero-length shape and to nothing else, so a
  half-filled scheduled step cannot borrow it.

One step, several scheduled steps (--study-uid, repeated):
  A single acquisition can fulfil more than one order — a chest and an abdomen
  booked separately, done in one pass. PS3.3 represents that as several items
  in ScheduledStepAttributesSequence, and repeating --study-uid emits one
  populated item per UID.

  Only the FIRST item carries --accession, --scheduled-step-id and the
  requested-procedure attributes. There is one of each on the command line, and
  copying them onto every item would assert that several different orders share
  one accession number. The rest are emitted as the empty Type 2 attributes
  they are. This form cannot be combined with --from-worklist, where
  --study-uid is the flag that narrows the file to a single item.

Examples:
  dcm mpps start --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --study-uid 1.2.840.113619.2.55.3.1 --modality CT --step-id STEP001

  dcm find --mwl --json-raw --host ris.example.org --port 11112 --called-ae WORKLIST \\
    PatientID=12345 > wl.json
  dcm mpps start --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --from-worklist wl.json

  # A walk-in radiograph nobody booked.
  dcm mpps start --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --unscheduled --modality DX --step-id WALKIN-014
`.trimStart();

/**
 * N-CREATE with PerformedProcedureStepStatus 'IN PROGRESS'.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags, positionals } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  if (positionals.length) {
    throw new args.UsageError(
      `dcm mpps start takes no positional arguments, got "${positionals[0]}". ` +
        'The MPPS SOP Instance UID is generated here and printed — it is an output, ' +
        'not an input. Use --mpps-uid to supply one.'
    );
  }

  const dryRun = flags.has('dry-run');
  const asJson = flags.has('json');

  // Under --dry-run nothing is opened, so only the calling AE Title matters —
  // it is what PerformedStationAETitle defaults to, and the point of the dry
  // run is to see the dataset that default produces.
  const connection = dryRun
    ? {
        callingAe: args.validateAeTitle(
          args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
          'calling-ae'
        ),
      }
    : common.resolveConnection(flags);

  const { attrs, source } = common.resolveAttributes(flags, connection);

  // A malformed Study Instance UID is the correlation key being wrong, which is
  // the failure this whole command exists to avoid. Catch it here rather than
  // letting the SCP answer 0x0117 about an attribute it does not name.
  if (attrs.studyInstanceUid) {
    const verdict = validateUid(attrs.studyInstanceUid);
    if (!verdict.valid) {
      throw new args.UsageError(
        `--study-uid "${attrs.studyInstanceUid}" is not a valid DICOM UID: ${verdict.reason}. ` +
          'This is the attribute the RIS reconciles the step against, so a malformed one ' +
          'leaves the order open no matter what the SCP answers.'
      );
    }
  }

  const dataset = mpps.buildCreateDataset(attrs);
  mpps.assertCreatable(dataset);

  const scheduledSteps = dataset.ScheduledStepAttributesSequence;
  if (attrs.unscheduled) {
    log.info(
      '--unscheduled: ScheduledStepAttributesSequence is one zero-length item. The step ' +
        'names no order, so there is no Study Instance UID for the RIS to reconcile it on.'
    );
  } else if (scheduledSteps.length > 1) {
    log.info(
      `${scheduledSteps.length} scheduled steps in one performed step; only the first item ` +
        'carries the accession and scheduled-step attributes, because there is one of each ' +
        'on the command line.'
    );
  }

  const mppsUidFlag = args.resolve(flags, { name: 'mpps-uid' });
  const mppsSopInstanceUid = mppsUidFlag !== undefined
    ? mpps.requireUid(mppsUidFlag, '--mpps-uid')
    : mpps.newMppsUid({
        studyInstanceUid: attrs.studyInstanceUid,
        performedProcedureStepId: attrs.performedProcedureStepId,
        performedStationAeTitle: attrs.performedStationAeTitle,
        startDate: attrs.startDate,
        startTime: attrs.startTime,
      });

  if (source.worklist) {
    log.info(`worklist item read from ${source.worklist} (${source.worklistItems} item(s) in the file)`);
  }

  if (dryRun) {
    if (asJson) {
      log.out(JSON.stringify({
        ok: true,
        dryRun: true,
        mppsSopInstanceUid,
        sopClassUid: mpps.MPPS_SOP_CLASS,
        unscheduled: Boolean(attrs.unscheduled),
        scheduledStepItems: scheduledSteps.length,
        dataset,
      }, null, 2));
      return 0;
    }
    log.out(`MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
    log.out(`SOP Class UID          ${mpps.MPPS_SOP_CLASS}`);
    log.out('');
    log.out('N-CREATE dataset that would be sent:');
    log.out(common.formatDataset(dataset));
    log.out('');
    log.out(log.color.dim('--dry-run: no connection was opened and nothing was sent.'));
    return 0;
  }

  const timeouts = common.timeoutsFrom(flags);
  log.info(
    `N-CREATE ${connection.callingAe} -> ${connection.calledAe} at ` +
      `${connection.host}:${connection.port}`
  );
  log.info(`  study ${attrs.studyInstanceUid}, modality ${attrs.modality}, step ${attrs.performedProcedureStepId}`);

  const result = await mpps.nCreate({
    connection, timeouts, mppsSopInstanceUid, dataset,
  });
  const verdict = common.describeNResult(result, 'N-CREATE');

  // The SCP echoes the instance UID it acted on. A mismatch means the step that
  // now exists is not the one this UID names, and every later N-SET would go to
  // the wrong place — worth a warning even though the status said success.
  if (verdict.ok &&
      result.affectedSopInstanceUid &&
      result.affectedSopInstanceUid !== mppsSopInstanceUid) {
    log.warn(
      `the peer answered about ${result.affectedSopInstanceUid}, not the ` +
        `${mppsSopInstanceUid} that was sent. Use the peer's UID to complete this step.`
    );
  }

  if (asJson) {
    log.out(JSON.stringify({
      ok: verdict.ok,
      reason: verdict.reason,
      mppsSopInstanceUid,
      sopClassUid: mpps.MPPS_SOP_CLASS,
      performedProcedureStepStatus: verdict.ok ? mpps.Status.IN_PROGRESS : null,
      unscheduled: Boolean(attrs.unscheduled),
      scheduledStepItems: scheduledSteps.length,
      studyInstanceUid: attrs.studyInstanceUid,
      peer: connection,
      status: verdict.status ? { code: verdict.status.code, label: verdict.status.label } : null,
      message: verdict.lines.join(' '),
    }, null, 2));
    return verdict.ok ? 0 : 1;
  }

  if (!verdict.ok) {
    log.error('N-CREATE failed — no procedure step was opened');
    common.reportNResult(verdict);
    return 1;
  }

  log.out(`${log.color.green('IN PROGRESS')}  procedure step opened on ${connection.calledAe}`);
  log.out('');
  log.out(`  ${log.color.bold('MPPS SOP Instance UID')}  ${log.color.bold(mppsSopInstanceUid)}`);
  if (attrs.unscheduled) {
    log.out(`  study                  ${log.color.yellow('none — unscheduled step')}`);
  } else if (scheduledSteps.length > 1) {
    log.out(`  studies                ${scheduledSteps.length} scheduled steps:`);
    for (const item of scheduledSteps) log.out(`    ${item.StudyInstanceUID}`);
  } else {
    log.out(`  study                  ${attrs.studyInstanceUid}`);
  }
  log.out(`  performed step ID      ${attrs.performedProcedureStepId}`);
  log.out(`  station AE             ${attrs.performedStationAeTitle}`);
  log.out(`  started                ${attrs.startDate} ${attrs.startTime}`);
  log.out('');
  if (attrs.unscheduled) {
    log.out(log.color.yellow(
      'This step names no scheduled procedure step, so nothing will reconcile it against an\n' +
        'order — there is no order. The RIS has only PerformedProcedureStepID and the\n' +
        'station AE to file it under, and whether it creates an unscheduled entry or drops\n' +
        'the step is its own business and is not visible from here.'
    ));
    log.out('');
  }
  log.out(
    log.color.dim(
      'Keep that UID. It is the only handle on this step:\n' +
        `  dcm mpps complete ${mppsSopInstanceUid} --host ${connection.host} ` +
        `--port ${connection.port} --called-ae ${connection.calledAe}\n` +
        '\n' +
        'The step is open on the SCP. Nothing about the worklist entry has been observed\n' +
        'from here — whether the SCP moved the scheduled step to ARRIVED or STARTED is its\n' +
        'business, and this command cannot see it.'
    )
  );
  return 0;
}

module.exports = { run, USAGE };
