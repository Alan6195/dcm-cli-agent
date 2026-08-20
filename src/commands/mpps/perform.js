'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { validateUid } = require('../../lib/uid');
const mpps = require('../../lib/mpps');
const restamp = require('../../lib/restamp');
const common = require('./common');
const store = require('./store');

const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.ATTRIBUTE_FLAGS,
  'store-host', 'store-port', 'store-called-ae',
  'chunk', 'retry', 'no-recurse', 'retrieve-ae',
  'end-date', 'end-time', 'dry-run',
  'adopt-worklist-identity', 'restamp', 'study-uid-only',
  'staging', 'keep-staging', 'allow-study-mismatch',
];

const USAGE = `
dcm mpps perform — open a step, send the images, close the step

One transaction: N-CREATE (IN PROGRESS), C-STORE the folder, then N-SET. The
step is marked COMPLETED only if every instance found on disk was acknowledged
by the archive. If any is unaccounted for, the step is marked DISCONTINUED and
this command exits 1.

Usage:
  dcm mpps perform <folder> --host <host> --port <port> --called-ae <AE> [options]

MPPS peer:
  --host <host>          MPPS peer hostname.                    [env DCM_HOST]
  --port <port>          MPPS peer DIMSE port.                  [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.                   [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI         [env DCM_CALLING_AE]

Storage peer (where the images go — often not the same system):
  --store-host <host>        Default: --host
  --store-port <port>        Default: --port
  --store-called-ae <AE>     Default: --called-ae
  The defaults are printed before the transfer starts, so which peer took the
  images is never a guess.

Scheduled and performed step:
  --study-uid <uid>      Study Instance UID. Taken from the folder when the
                         folder holds exactly one study and this is not given.
  --modality <MOD>       Taken from the folder when it holds exactly one.
  --step-id <id>         Performed Procedure Step ID. Type 1.
  --station-ae <AE>      Performed Station AE Title. Default: --calling-ae.
  --from-worklist <file.json>   Take the step attributes from a worklist item.
  See 'dcm mpps start --help' for the full list — it is the same set.

When the images do not already carry the worklist's Study Instance UID:
  --adopt-worklist-identity   Send a re-stamped COPY of the folder carrying the
                         worklist's identity. Alias: --restamp.
  --study-uid-only       With the above, stamp only StudyInstanceUID and leave
                         the images' own patient attributes alone.
  --staging <dir>        Where the copy goes. A fresh subdirectory is created
                         inside it for each run. Default: the OS temp dir.
  --keep-staging         Keep the copy after a run that ended COMPLETED. It is
                         kept automatically after a run that did not.
  --allow-study-mismatch Send the images exactly as they are and open the step
                         against a different study anyway. See below.

Transfer:
  --chunk <n>            Instances per association. Default: 200.
  --retry <n>            Retries for a chunk with unacknowledged instances. Default: 1.
  --no-recurse           Only look at files directly in the folder.
  --retrieve-ae <AE>     Retrieve AE Title recorded against each performed
                         series. Default: the storage peer's called AE, which is
                         where the images were actually sent.

Other:
  --end-date / --end-time    Default: now, local time.
  --dry-run              Scan, build the N-CREATE, and print the plan. Opens no
                         connection and sends nothing.
  --json                 Emit the whole transaction as JSON.
  --verbose              Log the full association negotiation.

How the final status is decided:
  PerformedSeriesSequence is built only from instances the archive positively
  acknowledged, grouped by Series Instance UID. There is no --force. If 410 of
  412 instances were acknowledged, the step is marked DISCONTINUED rather than
  COMPLETED, because COMPLETED asserts that the work is fully accounted for and
  two instances are not. The report shows found, sent, acknowledged and
  referenced-in-MPPS side by side so the shortfall is visible, not inferred.

  A warning status (0xB000-0xBFFF) means the archive stored the instance but
  changed or questioned something about it. Those instances ARE referenced in
  the MPPS — the archive holds them — but they do not count as acknowledged,
  so a run with warnings ends DISCONTINUED.

Adopting the worklist identity (--adopt-worklist-identity):
  A real modality does not refuse to work because the images it just acquired
  do not carry the worklist's Study Instance UID — they cannot, since the RIS
  invented that UID before the patient was on the table. The RIS assigns the
  identity and the modality stamps it onto everything it produces. This flag
  does the same thing, which is what makes rehearsing a worklist against stock
  images honest rather than a fudge.

  It writes a COPY of the folder into a staging directory, with the worklist's
  StudyInstanceUID and, unless --study-uid-only, its PatientID, PatientName,
  PatientBirthDate, PatientSex, AccessionNumber and StudyID where the worklist
  supplies them, and sends that copy. Attributes the worklist leaves blank are
  not stamped: a blank means the RIS did not say, and writing it over what the
  images carry would destroy information rather than adopt any.

  THE SOURCE FOLDER IS NEVER MODIFIED. Every file is opened read-only and
  written somewhere else. The staging path is printed, so what went on the wire
  can be inspected byte for byte.

Note: the copy is written by the same dataset writer 'dcm edit' and 'dcm anon'
  use, and that writer does not carry private tags across. A Siemens
  MR instance measured here went from 216 elements to 119; standard attributes
  and pixel data survive intact, and the count is reported so the loss is not a
  surprise. For rehearsing a worklist that is almost never material, but if what
  you are testing depends on a private tag, --allow-study-mismatch sends the
  original bytes untouched instead.

Note: Series and SOP Instance UIDs are NOT re-stamped. Those belong to the
  equipment that produced the images, not to the order — SeriesInstanceUID ties
  the slices of an acquisition together and SOPInstanceUID is the identity of
  one image, and a worklist item carries neither. Re-minting them would break
  the relationships the images already have and would make a resend look like a
  second acquisition rather than the same one.

Sending anyway (--allow-study-mismatch):
  Opens the step against the worklist's study and sends the images unchanged,
  under their own different study. Nothing reconciles afterwards: the archive
  files the images under one study and the RIS closes a step naming another.
  This is the explicit "I know what I am doing" path. No other flag implies it.

When the worklist has no Study Instance UID:
  The step adopts the FOLDER's study UID instead, and says so. That direction
  is safe and needs no flag — the images already have an identity, and the step
  is being written to describe images that exist. Nothing on disk is changed.
  The reverse is not symmetric, which is why it needs one.

Note: if the N-CREATE fails, nothing is sent. There is no point storing images
  against a procedure step that was never opened, and a half-done transaction is
  harder to reason about than one that stopped at the first step.

Note: this command reports what the MPPS SCP answered. It cannot see whether the
  worklist entry changed on the far end.

Examples:
  dcm mpps perform ./study --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --store-host pacs.example.org --store-port 104 --store-called-ae ARCHIVE \\
    --from-worklist wl.json

  # Rehearsing a worklist against stock images, the way a modality would.
  dcm mpps perform ./stock-mr --host 127.0.0.1 --port 11112 --called-ae WORKLIST \\
    --from-worklist wl.json --adopt-worklist-identity
`.trimStart();

/**
 * Fills in the step attributes the images themselves can answer for.
 *
 * Only ever fills a blank. An attribute the operator or the worklist supplied
 * is never overwritten by what is on disk, because the worklist is the order
 * and the images are only evidence about it — where they disagree, that
 * disagreement is worth surfacing rather than silently resolving.
 *
 * @param {object} attrs
 * @param {object} study A study from scan().
 * @param {{fromWorklist?: boolean}} [opts] Whether the attributes came from a
 *   worklist item, which changes what a missing Study Instance UID means.
 * @returns {string[]} Human descriptions of what was filled in.
 */
function adoptFromScan(attrs, study, opts = {}) {
  const adopted = [];

  if (!attrs.studyInstanceUid) {
    attrs.studyInstanceUid = study.studyInstanceUid;
    // The asymmetry here is deliberate and worth stating out loud. A worklist
    // item with no Study Instance UID is a scheduled step that has not been
    // given a study identity, so the step adopts the one the images already
    // carry: the images exist, they have an identity, and the step is being
    // written to describe them. Going the other way — images that disagree
    // with an identity the RIS already assigned — is the case that needs
    // --adopt-worklist-identity, because there the order is authoritative and
    // it is the images that have to move.
    adopted.push(
      opts.fromWorklist
        ? `--study-uid from the folder (${study.studyInstanceUid}) — the worklist item ` +
            'carries no Study Instance UID, so the step adopts the study the images ' +
            'already have. Nothing on disk is changed.'
        : `--study-uid from the folder (${study.studyInstanceUid})`
    );
  }

  if (!attrs.modality) {
    const modalities = [...study.modalities];
    if (modalities.length === 1) {
      attrs.modality = modalities[0];
      adopted.push(`--modality from the folder (${modalities[0]})`);
    } else if (modalities.length > 1) {
      throw new args.UsageError(
        `The folder holds ${modalities.length} modalities (${modalities.join(', ')}), so ` +
          'the performed step\'s Modality cannot be taken from it. Modality is Type 1 on ' +
          'the N-CREATE — name it with --modality.'
      );
    }
  }

  if (!attrs.patientId && study.patientId) {
    attrs.patientId = study.patientId;
    adopted.push('--patient-id from the folder');
  }
  if (!attrs.patientName && study.patientName) {
    attrs.patientName = study.patientName;
    adopted.push('--patient-name from the folder');
  }
  if (!attrs.accessionNumber && study.accessionNumber) {
    attrs.accessionNumber = study.accessionNumber;
    adopted.push('--accession from the folder');
  }

  return adopted;
}

/**
 * Refuses a folder that does not hold exactly one study.
 *
 * A performed procedure step is about one study — StudyInstanceUID is Type 1
 * inside ScheduledStepAttributesSequence and is the single key the RIS
 * reconciles on. Sending two studies under one step would attribute half the
 * images to the wrong order.
 *
 * @param {object} scanned
 * @param {string} target
 * @param {string} declaredStudyUid
 * @param {{adoptIdentity?: boolean, allowMismatch?: boolean}} [opts] Whether
 *   the caller has already chosen one of the two ways past a mismatch.
 * @returns {{study: object, mismatch: {declared: string, onDisk: string}|null}}
 */
function assertOneStudy(scanned, target, declaredStudyUid, opts = {}) {
  if (scanned.studies.size === 0) {
    throw new args.UsageError(
      `No DICOM instances found under ${path.resolve(target)}` +
        (scanned.filesExamined ? `; examined ${scanned.filesExamined} file(s), none were DICOM.` : '.')
    );
  }

  if (scanned.studies.size > 1) {
    const list = [...scanned.studies.values()]
      .slice(0, 5)
      .map((s) => `  ${s.studyInstanceUid}  ${s.instances.length} instance(s)  ${s.patientName ?? ''}`);
    throw new args.UsageError(
      `${path.resolve(target)} holds ${scanned.studies.size} studies, and one performed ` +
        'procedure step describes exactly one. Study Instance UID is the key the RIS ' +
        'reconciles the step against, so sending two studies under one step would ' +
        'attribute half these images to the wrong order.\n' +
        `${list.join('\n')}${scanned.studies.size > 5 ? `\n  … and ${scanned.studies.size - 5} more` : ''}\n` +
        'Re-stamping cannot fix this: --adopt-worklist-identity gives one folder one ' +
        'identity, and stamping it here would merge these studies into a single study ' +
        'that never existed. Split the folder and run this once per study.'
    );
  }

  const [study] = scanned.studies.values();
  const mismatch = declaredStudyUid && declaredStudyUid !== study.studyInstanceUid
    ? { declared: declaredStudyUid, onDisk: study.studyInstanceUid }
    : null;

  if (mismatch && !opts.adoptIdentity && !opts.allowMismatch) {
    throw new args.UsageError(
      `--study-uid says ${declaredStudyUid} but the folder holds ${study.studyInstanceUid}. ` +
        'The performed step would name one study and the images would belong to another, ' +
        'and the archive would never reconcile them.\n' +
        '\n' +
        'Two ways forward:\n' +
        '  --adopt-worklist-identity  Send a re-stamped COPY of the folder carrying the\n' +
        '                             study the worklist named\n' +
        `                               ${declaredStudyUid}\n` +
        '                             plus its patient and accession where the worklist\n' +
        '                             supplies them. This is what a real modality does:\n' +
        '                             the RIS assigns the identity and the modality stamps\n' +
        '                             it onto the images it acquires. The copy goes to a\n' +
        '                             staging directory; the source folder is not modified.\n' +
        '  --allow-study-mismatch     Send the images exactly as they are and open the step\n' +
        '                             against a different study anyway. Nothing reconciles\n' +
        '                             afterwards; use it only if that is what you want.'
    );
  }

  return { study, mismatch };
}

/**
 * Reads StudyID out of the worklist item.
 *
 * StudyID is not an MPPS attribute — it is not in the N-CREATE and
 * common.resolveAttributes() rightly does not carry it — but it is part of the
 * identity the RIS assigns, so `--adopt-worklist-identity` stamps it. The item
 * is re-read here with the same selection common.js used, which is cheap (a
 * small JSON file that has already parsed once) and keeps this need out of the
 * shared attribute resolver, where it would look like an MPPS attribute.
 *
 * @param {Map} flags
 * @param {{worklist?: string}} source From common.resolveAttributes().
 * @returns {string}
 */
function studyIdFromWorklist(flags, source) {
  if (!source.worklist) return '';
  const loaded = mpps.readWorklistFile(source.worklist, {
    studyUid: args.resolve(flags, { name: 'study-uid' }),
    accession: args.resolve(flags, { name: 'accession' }),
  });
  return mpps.worklistToAttributes(loaded.item).studyId ?? '';
}

/**
 * Writes the re-stamped copy and re-scans it, so everything downstream — the
 * ledger, the C-STORE, the PerformedSeriesSequence — is about the bytes that
 * will actually go on the wire rather than about the source.
 *
 * @param {object} params
 * @returns {Promise<{result: object, scanned: object, ledger: object, metaByPath: Map}>}
 */
async function stageRestamped(params) {
  const { target, study, plan, stagingRoot } = params;

  const sourceRoot = fs.statSync(path.resolve(target)).isDirectory()
    ? path.resolve(target)
    : path.dirname(path.resolve(target));
  const staging = restamp.stagingDirFor(sourceRoot, stagingRoot);

  try {
    restamp.assertStagingIsOutside(sourceRoot, staging.root);
  } catch (err) {
    throw new args.UsageError(`--staging: ${err.message}`);
  }

  log.info('');
  log.info(
    `--adopt-worklist-identity: writing a re-stamped copy of ${study.instances.length} ` +
      `instance(s) to ${staging.dir}`
  );
  for (const { element, value } of plan) log.info(`  ${element} = ${value}`);
  log.info(`  ${path.resolve(target)} is opened read-only and is not modified`);

  const result = await restamp.restampFolder({
    instances: study.instances,
    sourceRoot,
    stagingDir: staging.dir,
    plan,
    onProgress: (written, total) => log.info(`  ${written}/${total} written`),
  });
  result.defaultedStagingRoot = staging.defaulted;

  for (const failure of result.failures) {
    log.warn(`could not re-stamp ${failure.path}: ${failure.error}`);
  }
  if (result.written === 0) {
    throw new args.UsageError(
      `--adopt-worklist-identity could not write a single instance into ${staging.dir}. ` +
        'Nothing was sent and no step was opened.'
    );
  }

  log.info(restamp.describeRestamp(result));

  // The one loss worth naming out loud. It is the writer's, shared with
  // `dcm edit --out` and `dcm anon`, but it is this command's copy that goes on
  // the wire, so this command is where it has to be said.
  if (result.unnamedElements > 0) {
    log.warn(
      `the copy does not carry private tags: up to ${result.unnamedElements} element(s) per ` +
        'instance had no keyword the writer could resolve and were not written. Standard ' +
        'attributes and pixel data are intact. If what you are rehearsing depends on a ' +
        'private tag, --allow-study-mismatch sends the original bytes instead.'
    );
  }

  // Re-scan the copy. The ledger has to describe the files being sent: a
  // ledger built from the source would name paths that are not what went on
  // the wire, and the PerformedSeriesSequence is built from that ledger.
  const rescanned = store.scanIntoLedger(staging.dir, { recurse: true });

  return { result, ...rescanned };
}

/** Prints the four counts that matter, side by side. */
function reportCounts(totals, referenced, notReferenced) {
  log.out('');
  log.out(`  found                ${totals.found}`);
  log.out(`  sent                 ${totals.sent}`);
  log.out(`  acknowledged         ${totals.acknowledged}${totals.warning ? ` (+${totals.warning} with warnings)` : ''}`);
  log.out(`  referenced in MPPS   ${referenced}${notReferenced ? `  (${notReferenced} could not be referenced)` : ''}`);
  if (totals.failed) log.out(`  refused by the peer  ${totals.failed}`);
  if (totals.unanswered) log.out(`  never answered       ${totals.unanswered}`);
  if (totals.notAttempted) log.out(`  never attempted      ${totals.notAttempted}`);
  if (totals.readError) log.out(`  unreadable on disk   ${totals.readError}`);
}

/**
 * Whether the staging copy survives the run.
 *
 * Kept when --keep-staging was given, and kept after any run that did not end
 * COMPLETED — a failed or partial transfer is exactly when someone needs to
 * look at, or resend, the bytes that actually went on the wire.
 *
 * @param {{stagingDir?: string, keepStaging?: boolean}} session
 * @param {number} code Exit code the run is about to return.
 * @returns {boolean}
 */
function stagingIsKept(session, code) {
  return Boolean(session.keepStaging) || code !== 0;
}

/**
 * Removes or reports the staging copy, once the exit code is known.
 *
 * @param {object} session
 * @param {number} code
 */
function settleStaging(session, code) {
  if (!session.stagingDir) return;

  if (!stagingIsKept(session, code)) {
    const { removed, error } = restamp.removeStaging(session.stagingDir);
    if (removed) log.info(`staging copy removed: ${session.stagingDir}`);
    else log.warn(`could not remove the staging copy at ${session.stagingDir}: ${error}`);
    return;
  }

  log.info(
    `staging copy kept at ${session.stagingDir}` +
      (session.keepStaging
        ? ' (--keep-staging)'
        : ' — this run did not end COMPLETED, so the exact bytes that were sent are still there')
  );
}

/**
 * The transaction the worklist workflow is actually for.
 *
 * A thin wrapper so the staging copy is settled on every exit, including the
 * ones that throw. It is derived data this command created, and leaving it
 * behind unmentioned would slowly fill the temp directory with copies of
 * studies.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const session = {};
  let code = 1;
  try {
    code = await performTransaction(parsed, session);
    return code;
  } finally {
    settleStaging(session, code);
  }
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @param {object} session Carries the staging directory out to run().
 * @returns {Promise<number>}
 */
async function performTransaction(parsed, session) {
  const { flags, positionals } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const target = positionals[0];
  if (!target) {
    throw new args.UsageError(
      'Missing folder. Usage: dcm mpps perform <folder> --host ... --port ... --called-ae ...'
    );
  }
  if (positionals.length > 1) {
    throw new args.UsageError(
      `dcm mpps perform takes one folder, got ${positionals.length}: ${positionals.join(', ')}.`
    );
  }

  const dryRun = flags.has('dry-run');
  const asJson = flags.has('json');
  const recurse = !flags.has('no-recurse');

  const chunkSize = args.resolve(flags, { name: 'chunk', type: 'number', fallback: 200 });
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new args.UsageError(`--chunk must be a positive integer, got "${chunkSize}".`);
  }
  const retries = args.resolve(flags, { name: 'retry', type: 'number', fallback: 1 });
  if (!Number.isInteger(retries) || retries < 0) {
    throw new args.UsageError(`--retry must be zero or a positive integer, got "${retries}".`);
  }

  // --- The two ways past a study-UID mismatch, resolved before anything runs.
  const adoptIdentity = flags.has('adopt-worklist-identity') || flags.has('restamp');
  const allowMismatch = flags.has('allow-study-mismatch');
  const studyUidOnly = flags.has('study-uid-only');
  const keepStaging = flags.has('keep-staging');
  const stagingRoot = args.resolve(flags, { name: 'staging' });

  // They ask for opposite things — one makes the images match the order, the
  // other sends images that do not. Picking a winner would mean guessing which
  // of the two the operator meant.
  if (adoptIdentity && allowMismatch) {
    throw new args.UsageError(
      '--adopt-worklist-identity and --allow-study-mismatch ask for opposite things. ' +
        'The first stamps the worklist identity onto a copy of the images so the step and ' +
        'the images agree; the second sends images that disagree with the step on purpose. ' +
        'Choose one.'
    );
  }
  if (studyUidOnly && !adoptIdentity) {
    throw new args.UsageError(
      '--study-uid-only narrows what --adopt-worklist-identity stamps, so it only means ' +
        'something alongside it. On its own nothing is being stamped.'
    );
  }
  for (const [name, given] of [['--staging', stagingRoot !== undefined], ['--keep-staging', keepStaging]]) {
    if (given && !adoptIdentity) {
      throw new args.UsageError(
        `${name} describes the staging copy that --adopt-worklist-identity writes, and ` +
          'that flag is not set, so no copy would be made.'
      );
    }
  }

  const connection = dryRun
    ? {
        callingAe: args.validateAeTitle(
          args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
          'calling-ae'
        ),
      }
    : common.resolveConnection(flags);

  const { attrs, source } = common.resolveAttributes(flags, connection);
  if (source.worklist) {
    log.info(`worklist item read from ${source.worklist} (${source.worklistItems} item(s) in the file)`);
  }

  if (attrs.studyInstanceUid) {
    const verdict = validateUid(attrs.studyInstanceUid);
    if (!verdict.valid) {
      throw new args.UsageError(
        `--study-uid "${attrs.studyInstanceUid}" is not a valid DICOM UID: ${verdict.reason}.`
      );
    }
  }

  // --- Scan first. Nothing is opened until we know what there is to send. ---
  log.info(`scanning ${path.resolve(target)}${recurse ? '' : ' (not recursing)'}`);
  let { scanned, ledger, metaByPath } = store.scanIntoLedger(target, { recurse });
  const { study, mismatch } = assertOneStudy(scanned, target, attrs.studyInstanceUid, {
    adoptIdentity, allowMismatch,
  });

  // The re-stamp plan is built from the attributes AS THE ORDER SUPPLIED THEM,
  // before adoptFromScan() fills any blank from the folder. Stamping a value
  // that came off these very images back onto them would be a no-op dressed up
  // as a change, and would put attributes in the report that nothing asked for.
  const orderedIdentity = { ...attrs, studyId: studyIdFromWorklist(flags, source) };

  const adopted = adoptFromScan(attrs, study, { fromWorklist: Boolean(source.worklist) });
  for (const note of adopted) log.info(`  took ${note}`);
  if (scanned.readErrors.length) {
    log.warn(
      `${scanned.readErrors.length} file(s) under ${path.resolve(target)} could not be read; ` +
        'they count as found and can never be acknowledged, so this run cannot end COMPLETED.'
    );
  }

  const restampPlan = adoptIdentity ? restamp.planRestamp(orderedIdentity, { studyUidOnly }) : [];

  if (mismatch && allowMismatch) {
    log.warn('');
    log.warn(
      `SENDING A STUDY THE STEP DOES NOT NAME. The performed step will name study ` +
        `${mismatch.declared}; the ${scanned.candidates} instance(s) about to be sent carry ` +
        `${mismatch.onDisk}. The archive files images by the Study Instance UID inside them, ` +
        'and the RIS reconciles the step by the one in the step, so these two will very ' +
        'likely never be reconciled — the step will sit open against a study that has no ' +
        'images and the images will land under a study that has no step.'
    );
    log.warn(
      '--adopt-worklist-identity is the flag that makes them agree, by stamping ' +
        `${mismatch.declared} onto a copy of the images. This run was asked not to.`
    );
    log.warn('');
  }

  if (adoptIdentity && restampPlan.length === 0) {
    // Worth saying rather than silently doing nothing: the operator asked for
    // an identity to be adopted and there is none to adopt.
    log.info(
      'nothing to adopt: the worklist and flags supply none of the identity attributes ' +
        `(${restamp.IDENTITY_ATTRIBUTES.map((a) => a.element).join(', ')}), so no copy is ` +
        'made and the folder is sent as it is.'
    );
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

  const storeConnection = dryRun
    ? undefined
    : common.resolveStoreConnection(flags, connection);

  if (dryRun) {
    const plan = {
      ok: true,
      dryRun: true,
      mppsSopInstanceUid,
      sopClassUid: mpps.MPPS_SOP_CLASS,
      studyInstanceUid: attrs.studyInstanceUid,
      found: scanned.candidates,
      unreadable: scanned.readErrors.length,
      series: study.series.size,
      chunkSize,
      adoptWorklistIdentity: adoptIdentity,
      // Same shape as the real run's `restamp` block, so one parser reads both.
      restamp: restampPlan.length
        ? {
            source: path.resolve(target),
            sourceModified: false,
            attributes: restampPlan.map((p) => p.element),
            values: Object.fromEntries(restampPlan.map((p) => [p.element, p.value])),
            unchangedByDesign: restamp.NEVER_RESTAMPED,
          }
        : null,
      allowStudyMismatch: allowMismatch,
      studyUidMismatch: mismatch,
      dataset,
    };
    if (asJson) {
      log.out(JSON.stringify(plan, null, 2));
      return scanned.readErrors.length ? 1 : 0;
    }
    log.out(`MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
    log.out(`study                  ${attrs.studyInstanceUid}`);
    log.out(`would send             ${scanned.candidates} instance(s) in ${study.series.size} series`);
    if (restampPlan.length) {
      log.out('');
      log.out('would re-stamp a copy of the folder, then send the copy:');
      for (const { element, value } of restampPlan) {
        log.out(`  ${element.padEnd(20)} ${value}`);
      }
      log.out(`  ${log.color.dim('Series and SOP Instance UIDs are left alone; the source folder is not modified.')}`);
    }
    if (mismatch && allowMismatch) {
      log.out('');
      log.out(log.color.yellow(
        `would send images carrying study ${mismatch.onDisk} under a step naming ` +
          `${mismatch.declared} — nothing would reconcile them.`
      ));
    }
    log.out('');
    log.out('N-CREATE dataset that would be sent:');
    log.out(common.formatDataset(dataset));
    log.out('');
    log.out(log.color.dim(
      '--dry-run: no connection was opened, no step was created and nothing was sent.\n' +
        'PerformedSeriesSequence cannot be previewed — it is built from what the archive\n' +
        'acknowledges, and nothing has been acknowledged.'
    ));
    return scanned.readErrors.length ? 1 : 0;
  }

  // --- 0. Re-stamp, if asked -----------------------------------------------
  // Before the step is opened and before anything goes on the wire, so a run
  // that cannot produce the copy has not yet told the RIS that work started.
  let restamped;
  if (restampPlan.length) {
    const staged = await stageRestamped({
      target, study, plan: restampPlan, stagingRoot,
    });
    restamped = staged.result;
    ({ scanned, ledger, metaByPath } = staged);

    session.stagingDir = restamped.stagingDir;
    session.keepStaging = keepStaging;

    // The copy has to be exactly the study the step will name. If it is not,
    // something rewrote or re-scanned wrong and the honest move is to stop.
    // allowMismatch here means "hand the mismatch back", not "let it through":
    // it is reported below in this command's own words.
    const check = assertOneStudy(scanned, restamped.stagingDir, attrs.studyInstanceUid, {
      allowMismatch: true,
    });
    if (check.mismatch) {
      throw new args.UsageError(
        `the re-stamped copy at ${restamped.stagingDir} carries ${check.mismatch.onDisk}, ` +
          `not ${check.mismatch.declared}. Nothing was sent.`
      );
    }
  }

  const timeouts = common.timeoutsFrom(flags);
  const retrieveAeTitle = args.resolve(flags, { name: 'retrieve-ae' }) ?? storeConnection.calledAe;

  log.info('');
  log.info(`MPPS   ${connection.callingAe} -> ${connection.calledAe} at ${connection.host}:${connection.port}`);
  log.info(
    `store  ${connection.callingAe} -> ${storeConnection.calledAe} at ` +
      `${storeConnection.host}:${storeConnection.port}` +
      (storeConnection.inherited.length
        ? ` (${storeConnection.inherited.join(', ')} defaulted to the MPPS peer)`
        : '')
  );

  // --- 1. N-CREATE ---------------------------------------------------------
  log.info('');
  log.info(`N-CREATE: opening the step as ${mpps.Status.IN_PROGRESS}`);
  const created = await mpps.nCreate({ connection, timeouts, mppsSopInstanceUid, dataset });
  const createVerdict = common.describeNResult(created, 'N-CREATE');

  if (!createVerdict.ok) {
    if (asJson) {
      log.out(JSON.stringify({
        ok: false,
        stage: 'n-create',
        reason: createVerdict.reason,
        mppsSopInstanceUid,
        studyInstanceUid: attrs.studyInstanceUid,
        found: scanned.candidates,
        sent: 0,
        acknowledged: 0,
        referencedInMpps: 0,
        performedProcedureStepStatus: null,
        message: createVerdict.lines.join(' '),
      }, null, 2));
      return 1;
    }
    log.error('N-CREATE failed — the procedure step was never opened, so nothing was sent');
    common.reportNResult(createVerdict);
    log.out('');
    log.out(log.color.dim(
      `The ${scanned.candidates} instance(s) under ${path.resolve(target)} are untouched. ` +
        'Fix the MPPS peer and run this again, or send them with `dcm send` and close the ' +
        'step by hand if the step already exists.'
    ));
    return 1;
  }

  log.info(`  step ${mppsSopInstanceUid} is ${mpps.Status.IN_PROGRESS}`);

  // --- 2. C-STORE ----------------------------------------------------------
  log.info('');
  log.info(`C-STORE: sending ${scanned.candidates} instance(s) to ${storeConnection.calledAe}`);
  const result = await store.storeLedger({
    ledger, metaByPath, connection: storeConnection, timeouts, chunkSize, retries,
  });
  const entries = store.allEntries(ledger);

  // --- 3. PerformedSeriesSequence, from acknowledged instances only --------
  const built = mpps.buildPerformedSeriesSequence(entries, {
    retrieveAeTitle,
    seriesMeta: mpps.seriesMetaFromScan(scanned.studies),
  });
  for (const skip of built.skipped) {
    log.warn(`acknowledged but not referenceable in the MPPS: ${skip.path} — ${skip.reason}`);
  }

  // --- 4. N-SET ------------------------------------------------------------
  // COMPLETED requires every found instance to have been acknowledged. The
  // ledger's own verdict is that test, and there is deliberately no way to
  // override it: an MPPS that says COMPLETED is read downstream as "this work
  // is fully accounted for", and that is either true or it is not.
  const finalStatus = result.ok ? mpps.Status.COMPLETED : mpps.Status.DISCONTINUED;
  const now = new Date();
  const endDate = args.resolve(flags, { name: 'end-date' }) ?? mpps.dicomDate(now);
  const endTime = args.resolve(flags, { name: 'end-time' }) ?? mpps.dicomTime(now);

  mpps.assertLegalTransition(mpps.Status.IN_PROGRESS, finalStatus);

  const setDataset = mpps.buildSetDataset({
    status: finalStatus,
    endDate,
    endTime,
    performedSeries: built.items,
  });

  log.info('');
  log.info(`N-SET: closing the step as ${finalStatus}`);
  const set = await mpps.nSet({ connection, timeouts, mppsSopInstanceUid, dataset: setDataset });
  const setVerdict = common.describeNResult(set, 'N-SET');

  // --- 5. Report -----------------------------------------------------------
  const totals = result.totals;
  const shortfallSentence =
    `${totals.acknowledged} of ${totals.found} instances were acknowledged. ` +
      `The step was marked ${mpps.Status.DISCONTINUED}, not ${mpps.Status.COMPLETED}, because ` +
      `${totals.found - totals.acknowledged} ${totals.found - totals.acknowledged === 1 ? 'instance is' : 'instances are'} unaccounted for.`;

  const exitCode = setVerdict.ok && finalStatus === mpps.Status.COMPLETED ? 0 : 1;

  if (asJson) {
    log.out(JSON.stringify({
      ok: setVerdict.ok && finalStatus === mpps.Status.COMPLETED,
      stage: setVerdict.ok ? 'done' : 'n-set',
      mppsSopInstanceUid,
      sopClassUid: mpps.MPPS_SOP_CLASS,
      studyInstanceUid: attrs.studyInstanceUid,
      performedProcedureStepStatus: setVerdict.ok ? finalStatus : mpps.Status.IN_PROGRESS,
      intendedStatus: finalStatus,
      found: totals.found,
      sent: totals.sent,
      acknowledged: totals.acknowledged,
      warned: totals.warning,
      failed: totals.failed,
      unanswered: totals.unanswered,
      notAttempted: totals.notAttempted,
      readError: totals.readError,
      shortfall: totals.shortfall,
      referencedInMpps: built.referenced,
      notReferenced: built.skipped.length,
      performedSeries: built.items.map((s) => ({
        seriesInstanceUid: s.SeriesInstanceUID,
        instances: s.ReferencedImageSequence.length,
      })),
      peer: { mpps: connection, store: { ...storeConnection, inherited: undefined } },
      storeDefaultsInherited: storeConnection.inherited,
      restamp: restamped
        ? {
            source: path.resolve(target),
            sourceModified: false,
            stagingDir: restamped.stagingDir,
            stagingKept: stagingIsKept(session, exitCode),
            instances: restamped.written,
            instancesChanged: restamped.instancesChanged,
            attributes: restampPlan.map((p) => p.element),
            changed: Object.fromEntries(restamped.changed),
            unchangedByDesign: restamp.NEVER_RESTAMPED,
            privateElementsNotCarried: restamped.unnamedElements,
          }
        : null,
      studyUidMismatch: mismatch,
      allowStudyMismatch: allowMismatch,
      explanation: finalStatus === mpps.Status.DISCONTINUED ? shortfallSentence : null,
      message: setVerdict.ok ? '' : setVerdict.lines.join(' '),
    }, null, 2));
    return exitCode;
  }

  const colour = finalStatus === mpps.Status.COMPLETED ? log.color.green : log.color.yellow;
  log.out('');
  log.out(`${log.color.bold('MPPS SOP Instance UID')}  ${mppsSopInstanceUid}`);
  log.out(`study                  ${attrs.studyInstanceUid}`);
  log.out(`images sent to         ${storeConnection.calledAe} at ${storeConnection.host}:${storeConnection.port}`);
  log.out(`MPPS sent to           ${connection.calledAe} at ${connection.host}:${connection.port}`);
  if (restamped) {
    log.out('');
    log.out(restamp.describeRestamp(restamped));
    log.out(`source folder          ${path.resolve(target)} ${log.color.dim('(read only — not modified)')}`);
    log.out(`what was sent          the copy at ${restamped.stagingDir}`);
    log.out(log.color.dim(
      `  ${restamp.NEVER_RESTAMPED.join(' and ')} are unchanged — they are the modality's to`
    ));
    log.out(log.color.dim(
      '  mint, and re-stamping them would break the series relationships these images have.'
    ));
  }
  if (mismatch && allowMismatch) {
    log.out('');
    log.out(log.color.yellow(
      `--allow-study-mismatch: the step names ${mismatch.declared}, the images carry ` +
        `${mismatch.onDisk}. Nothing on either side will reconcile them.`
    ));
  }
  reportCounts(totals, built.referenced, built.skipped.length);
  log.out('');
  log.out(`  performed series     ${built.items.length}`);
  for (const item of built.items) {
    log.out(`    ${item.SeriesInstanceUID}  ${item.ReferencedImageSequence.length} instance(s)`);
  }
  log.out('');

  if (!setVerdict.ok) {
    log.error(`N-SET failed — the step is still ${mpps.Status.IN_PROGRESS} on ${connection.calledAe}`);
    common.reportNResult(setVerdict);
    log.out('');
    log.out(log.color.dim(
      `The images were sent and ${totals.acknowledged} were acknowledged; only the closing\n` +
        'N-SET failed. Close the step once the peer is reachable:\n' +
        `  dcm mpps ${finalStatus === mpps.Status.COMPLETED ? 'complete' : 'discontinue'} ` +
        `${mppsSopInstanceUid} --host ${connection.host} --port ${connection.port} ` +
        `--called-ae ${connection.calledAe}\n` +
        '\n' +
        'That N-SET will carry no performed series. The ledger of what the archive\n' +
        'acknowledged lives in this process and dies with it — nothing is written to disk —\n' +
        'and --series-from would assert what is in the folder rather than what the archive\n' +
        'took. Re-running this command is the way to get an honest one.'
    ));
    return 1;
  }

  log.out(`step status            ${colour(finalStatus)}`);
  log.out('');

  if (finalStatus === mpps.Status.COMPLETED) {
    log.out(`${log.color.green('OK')}  every instance found was acknowledged and is referenced in the MPPS.`);
  } else {
    log.out(log.color.yellow(shortfallSentence));
    log.out('');
    log.out(log.color.dim(
      'There is no override for this. COMPLETED asserts the work is fully accounted for,\n' +
        'and PerformedSeriesSequence above names only what the archive actually took, so a\n' +
        'COMPLETED here would be a claim nothing supports. Resend the outstanding instances\n' +
        'with `dcm send` and open a new step, or investigate why the archive refused them.'
    ));
  }

  log.out('');
  log.out(log.color.dim(
    'The SCP accepted the N-SET. Whether the worklist entry changes on its side is not\n' +
      'visible from here — query the worklist if you need to know.'
  ));

  return finalStatus === mpps.Status.COMPLETED ? 0 : 1;
}

module.exports = { run, USAGE, adoptFromScan, assertOneStudy, stagingIsKept };
