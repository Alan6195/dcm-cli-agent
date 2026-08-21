'use strict';

const log = require('../../lib/log');
const args = require('../../lib/args');
const json = require('../../lib/json');
const { validateUid } = require('../../lib/uid');
const mpps = require('../../lib/mpps');
const common = require('./common');

const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.ATTRIBUTE_FLAGS,
  ...common.INJECTION_FLAGS,
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
  --from-worklist <file.json|->  Take the attributes above from a worklist item.
                         "-" reads the worklist from standard input.
  --index <n>            With --from-worklist, take row n. 1-based, numbered the
                         way the "holds N worklist items" refusal numbers them.
  --first                With --from-worklist, take the first row.
  --mpps-uid <uid>       Use this MPPS SOP Instance UID instead of generating one.
  --set <Key>=<Value>    Stamp a value into the outgoing N-CREATE verbatim, with
                         no client-side validation at all. Repeatable. See below.
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

  Pass "-" to read it from standard input, which is what makes the two halves
  of the workflow one command:

    dcm find --mwl --json-raw --host ris --port 11112 --called-ae WORKLIST \\
      PatientID=12345 | dcm mpps start --from-worklist - --host ris ...

  "-" is recognised before the value is treated as a path. That is not a
  detail: path.resolve("-") is a file called "-" in the working directory, and
  the /dev/stdin people reach for instead becomes C:\\proc\\self\\fd\\0 on
  Windows. Both fail as "the worklist is missing" rather than as "this build
  does not do pipes".

  A document holding more than one item is REFUSED rather than resolved by
  guessing, because a step attributed to the wrong order looks exactly like a
  step attributed to the right one. Say which row you mean: --study-uid or
  --accession select by content, --index by the printed row number, --first
  when the query was written to return exactly one and you want the pipeline to
  fail loudly if it ever returns none.

Injecting a value (--set):
  --set <Keyword|(gggg,eeee)>=<Value> puts the value into the N-CREATE dataset
  exactly as typed. Nothing is checked: not the length, not the VR's character
  repertoire, not an enumeration, and not whether a UID is a UID — --set
  StudyInstanceUID=not-a-uid goes out as typed where the flag would be refused.
  It is applied last, so it overwrites whatever the flags and the worklist
  produced, and it is NOT routed into ScheduledStepAttributesSequence the way
  --study-uid is — name the path if that is where you want it:

    --set PatientSex=male
    --set PerformedProcedureStepStatus=STARTED
    --set ScheduledStepAttributesSequence/StudyInstanceUID=1.2.3

  This is the explicit "I know what I am doing" path, the same framing as
  --allow-study-mismatch on 'dcm mpps perform'. No other flag implies it. A
  banner naming every injected attribute is printed on stderr whenever it is in
  use, and because --quiet silences stderr the injections are ALSO recorded in
  the output itself — as "injected" in JSON, and above the result otherwise.
  There is no way to run an injected N-CREATE and get output that does not say
  so, which is what stops a deliberately odd response being read as a bug here.

  The Type 1 check still runs, and --set feeds it rather than being blocked by
  it: an attribute you gave a value for is exempt BY NAME, including when the
  value is empty. So --set Modality= is how you ask an SCP what it does with an
  empty Type 1 — the one question that cannot be asked any other way — while
  every attribute you did not name is still checked, so the accidental empty
  Type 1 stays impossible.

Note: an unknown or private tag is refused rather than injected. The encoder
  drops an attribute it has no dictionary entry for without saying so, and an
  N-CREATE that silently lost the one attribute being tested is worse than one
  that never ran. Over-long AE, CS, DS, IS and UI values are refused here too:
  the dataset writer SHORTENS them without failing, so the peer would answer a
  perfectly conformant message and the test would pass without having asked.

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
  const { flags } = parsed;

  if (flags.has('help')) return common.helpFor('start', flags, USAGE);

  // Every terminal path below leaves through here. A Type 1 validation error is
  // thrown before the first line of output, and under --json it used to reach
  // src/cli.js, which prints English on stderr and leaves stdout empty — the
  // exact "a CI job cannot branch on prose" complaint this answers.
  return common.guardVerb('start', flags, () => execute(parsed));
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function execute(parsed) {
  const { flags, positionals } = parsed;

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

  const injections = common.parseInjections(flags);

  const dataset = mpps.buildCreateDataset(attrs);
  // Applied before the Type 1 check rather than after, so an injected value
  // counts as the attribute being present. See common.exemptKeywords() for why
  // an injected EMPTY value is exempted rather than refused.
  common.applyInjections(dataset, injections);

  if (attrs.unscheduled && injections.some((i) => i.path[0].keyword === 'ScheduledStepAttributesSequence')) {
    log.warn(
      '--set is writing into ScheduledStepAttributesSequence on an --unscheduled step. That ' +
        'sequence was one zero-length item, which is how PS3.3 C.4.14 says "no order lies ' +
        'behind this step"; it is now a populated item and no longer means that.'
    );
  }

  mpps.assertCreatable(dataset, { exemptKeywords: common.exemptKeywords(injections) });

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

  // Encoded and read back here, before the dry run prints the dataset and
  // before anything is opened, so both paths make the same promise.
  common.verifyDataset('N-CREATE', mppsSopInstanceUid, dataset, injections);

  if (source.worklist) {
    log.info(
      `worklist item read from ${source.worklist} ` +
        `(${source.worklistItems} item(s); took ${source.worklistSelectedBy})`
    );
  }

  // The three AE Titles that decide attribution, on one line, before anything
  // is sent. On a dry run the called AE may not have been resolved at all.
  const attribution = common.attributionOf({
    callingAe: connection.callingAe,
    calledAe: connection.calledAe,
    performedStationAeTitle: attrs.performedStationAeTitle,
  });
  common.reportAttribution(attribution);

  const injected = common.injectionSummary(injections);

  if (dryRun) {
    common.reportInjections(injections, asJson, 'N-CREATE');
    if (asJson) {
      return json.result({
        command: 'mpps start',
        outcome: json.Outcome.OK,
        message: 'Dry run: the N-CREATE was built and nothing was sent.',
        payload: {
          dryRun: true,
          mppsSopInstanceUid,
          sopClassUid: mpps.MPPS_SOP_CLASS,
          unscheduled: Boolean(attrs.unscheduled),
          scheduledStepItems: scheduledSteps.length,
          studyInstanceUid: attrs.studyInstanceUid,
          attribution,
          ...(injected.length ? { injected } : {}),
          ...common.worklistSource(source),
          dataset,
        },
      });
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

  common.reportInjections(injections, asJson, 'N-CREATE');

  const peer = json.peerOf(connection);
  const result = await mpps.nCreate({ connection, timeouts, mppsSopInstanceUid, dataset });
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
    return json.result({
      command: 'mpps start',
      peer,
      outcome: verdict.envelope.outcome,
      message: verdict.envelope.message,
      detail: verdict.envelope.detail,
      payload: {
        // `reason` predates the envelope and is kept: it is the vocabulary the
        // MCP layer and NewLumen's existing scripts already read, and `outcome`
        // answers a coarser question than it does.
        reason: verdict.reason,
        mppsSopInstanceUid,
        sopClassUid: mpps.MPPS_SOP_CLASS,
        performedProcedureStepStatus: verdict.ok ? mpps.Status.IN_PROGRESS : null,
        unscheduled: Boolean(attrs.unscheduled),
        scheduledStepItems: scheduledSteps.length,
        studyInstanceUid: attrs.studyInstanceUid,
        attribution,
        ...(injected.length ? { injected } : {}),
        ...common.worklistSource(source),
        affectedSopInstanceUid: result.affectedSopInstanceUid ?? null,
        status: verdict.status ? { code: verdict.status.code, label: verdict.status.label } : null,
      },
    });
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
