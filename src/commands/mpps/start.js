'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { validateUid } = require('../../lib/uid');
const mpps = require('../../lib/mpps');
const common = require('./common');

const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.ATTRIBUTE_FLAGS,
  'out', 'dry-run',
];

const USAGE = `
dcm mpps start — open a performed procedure step (N-CREATE, IN PROGRESS)

Tells the MPPS SCP that work has begun on a scheduled study. Prints the MPPS
SOP Instance UID it generated: that UID is the only handle on the step, and
'dcm mpps complete' cannot close it without one.

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
                         on this and nothing else.
  --accession <text>     Accession Number.
  --requested-procedure-id <id>
  --requested-procedure-description <text>
  --scheduled-step-id <id>       Scheduled Procedure Step ID.

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
  --out <file.json>      Write the step record for 'dcm mpps complete' to read.
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

Examples:
  dcm mpps start --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --study-uid 1.2.840.113619.2.55.3.1 --modality CT --step-id STEP001

  dcm find --mwl --json-raw --host ris.example.org --port 11112 --called-ae WORKLIST \\
    PatientID=12345 > wl.json
  dcm mpps start --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --from-worklist wl.json --out step.json
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

  let outFile;
  if (verdict.ok) {
    const outFlag = args.resolve(flags, { name: 'out' });
    if (outFlag !== undefined) {
      outFile = writeStepRecord(outFlag, {
        mppsSopInstanceUid,
        status: mpps.Status.IN_PROGRESS,
        studyInstanceUid: attrs.studyInstanceUid,
        peer: connection,
        entries: [],
      });
    }
  }

  if (asJson) {
    log.out(JSON.stringify({
      ok: verdict.ok,
      reason: verdict.reason,
      mppsSopInstanceUid,
      sopClassUid: mpps.MPPS_SOP_CLASS,
      performedProcedureStepStatus: verdict.ok ? mpps.Status.IN_PROGRESS : null,
      studyInstanceUid: attrs.studyInstanceUid,
      peer: connection,
      status: verdict.status ? { code: verdict.status.code, label: verdict.status.label } : null,
      message: verdict.lines.join(' '),
      stepRecord: outFile ?? null,
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
  log.out(`  study                  ${attrs.studyInstanceUid}`);
  log.out(`  performed step ID      ${attrs.performedProcedureStepId}`);
  log.out(`  station AE             ${attrs.performedStationAeTitle}`);
  log.out(`  started                ${attrs.startDate} ${attrs.startTime}`);
  if (outFile) log.out(`  step record            ${outFile}`);
  log.out('');
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

/**
 * Writes the step record for a later `mpps complete`.
 *
 * @param {string} file
 * @param {object} params See mpps.buildStepRecord().
 * @returns {string} Resolved path.
 */
function writeStepRecord(file, params) {
  const resolved = path.resolve(file);
  const record = mpps.buildStepRecord(params);
  try {
    fs.writeFileSync(resolved, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (err) {
    // The step is already open on the SCP at this point, so failing to write
    // the convenience file must not read as the step having failed.
    log.warn(`could not write --out "${resolved}": ${err.message}`);
    log.warn(`the step is open regardless; its UID is ${params.mppsSopInstanceUid}`);
    return undefined;
  }
  return resolved;
}

module.exports = { run, USAGE, writeStepRecord };
