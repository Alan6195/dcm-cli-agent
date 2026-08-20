'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../../lib/log');
const args = require('../../lib/args');
const { validateUid } = require('../../lib/uid');
const mpps = require('../../lib/mpps');
const common = require('./common');
const store = require('./store');

const FLAGS = [
  ...common.CONNECTION_FLAGS,
  ...common.ATTRIBUTE_FLAGS,
  'store-host', 'store-port', 'store-called-ae',
  'chunk', 'retry', 'no-recurse', 'retrieve-ae',
  'write-acknowledged', 'end-date', 'end-time', 'dry-run',
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

Transfer:
  --chunk <n>            Instances per association. Default: 200.
  --retry <n>            Retries for a chunk with unacknowledged instances. Default: 1.
  --no-recurse           Only look at files directly in the folder.
  --retrieve-ae <AE>     Retrieve AE Title recorded against each performed
                         series. Default: the storage peer's called AE, which is
                         where the images were actually sent.

Other:
  --write-acknowledged <file.json>  Record the step and the acknowledged
                         instances, so the step can be reopened or inspected
                         later, and so 'dcm mpps complete' has something honest
                         to build a performed-series list from.
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

Note: if the N-CREATE fails, nothing is sent. There is no point storing images
  against a procedure step that was never opened, and a half-done transaction is
  harder to reason about than one that stopped at the first step.

Note: this command reports what the MPPS SCP answered. It cannot see whether the
  worklist entry changed on the far end.

Example:
  dcm mpps perform ./study --host ris.example.org --port 11112 --called-ae MPPSSCP \\
    --store-host pacs.example.org --store-port 104 --store-called-ae ARCHIVE \\
    --from-worklist wl.json --write-acknowledged step.json
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
 * @returns {string[]} Human descriptions of what was filled in.
 */
function adoptFromScan(attrs, study) {
  const adopted = [];

  if (!attrs.studyInstanceUid) {
    attrs.studyInstanceUid = study.studyInstanceUid;
    adopted.push(`--study-uid from the folder (${study.studyInstanceUid})`);
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
 */
function assertOneStudy(scanned, target, declaredStudyUid) {
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
        'Split the folder and run this once per study.'
    );
  }

  const [study] = scanned.studies.values();
  if (declaredStudyUid && declaredStudyUid !== study.studyInstanceUid) {
    throw new args.UsageError(
      `--study-uid says ${declaredStudyUid} but the folder holds ${study.studyInstanceUid}. ` +
        'The performed step would name one study and the images would belong to another, ' +
        'and the archive would never reconcile them.'
    );
  }

  return study;
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
 * The transaction the worklist workflow is actually for.
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
  const { scanned, ledger, metaByPath } = store.scanIntoLedger(target, { recurse });
  const study = assertOneStudy(scanned, target, attrs.studyInstanceUid);

  const adopted = adoptFromScan(attrs, study);
  for (const note of adopted) log.info(`  took ${note}`);
  if (scanned.readErrors.length) {
    log.warn(
      `${scanned.readErrors.length} file(s) under ${path.resolve(target)} could not be read; ` +
        'they count as found and can never be acknowledged, so this run cannot end COMPLETED.'
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
      dataset,
    };
    if (asJson) {
      log.out(JSON.stringify(plan, null, 2));
      return scanned.readErrors.length ? 1 : 0;
    }
    log.out(`MPPS SOP Instance UID  ${mppsSopInstanceUid}`);
    log.out(`study                  ${attrs.studyInstanceUid}`);
    log.out(`would send             ${scanned.candidates} instance(s) in ${study.series.size} series`);
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

  // --- 5. Record what was acknowledged ------------------------------------
  let recordFile;
  const recordFlag = args.resolve(flags, { name: 'write-acknowledged' });
  if (recordFlag !== undefined) {
    recordFile = writeRecord(recordFlag, {
      mppsSopInstanceUid,
      status: setVerdict.ok ? finalStatus : mpps.Status.IN_PROGRESS,
      studyInstanceUid: attrs.studyInstanceUid,
      peer: { mpps: connection, store: { ...storeConnection, inherited: undefined } },
      entries,
    });
  }

  // --- 6. Report -----------------------------------------------------------
  const totals = result.totals;
  const shortfallSentence =
    `${totals.acknowledged} of ${totals.found} instances were acknowledged. ` +
      `The step was marked ${mpps.Status.DISCONTINUED}, not ${mpps.Status.COMPLETED}, because ` +
      `${totals.found - totals.acknowledged} ${totals.found - totals.acknowledged === 1 ? 'instance is' : 'instances are'} unaccounted for.`;

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
      stepRecord: recordFile ?? null,
      explanation: finalStatus === mpps.Status.DISCONTINUED ? shortfallSentence : null,
      message: setVerdict.ok ? '' : setVerdict.lines.join(' '),
    }, null, 2));
    return setVerdict.ok && finalStatus === mpps.Status.COMPLETED ? 0 : 1;
  }

  const colour = finalStatus === mpps.Status.COMPLETED ? log.color.green : log.color.yellow;
  log.out('');
  log.out(`${log.color.bold('MPPS SOP Instance UID')}  ${mppsSopInstanceUid}`);
  log.out(`study                  ${attrs.studyInstanceUid}`);
  log.out(`images sent to         ${storeConnection.calledAe} at ${storeConnection.host}:${storeConnection.port}`);
  log.out(`MPPS sent to           ${connection.calledAe} at ${connection.host}:${connection.port}`);
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
        `--called-ae ${connection.calledAe}` +
        (recordFile ? ` --acknowledged ${recordFile}` : '') +
        (recordFile ? '' : '\n(next time pass --write-acknowledged so the acknowledged instances survive this failure)')
    ));
    return 1;
  }

  log.out(`step status            ${colour(finalStatus)}`);
  if (recordFile) log.out(`step record            ${recordFile}`);
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

/**
 * Writes the step record.
 *
 * @param {string} file
 * @param {object} params See mpps.buildStepRecord().
 * @returns {string|undefined} Resolved path, or undefined if it could not be written.
 */
function writeRecord(file, params) {
  const resolved = path.resolve(file);
  try {
    fs.writeFileSync(
      resolved,
      `${JSON.stringify(mpps.buildStepRecord(params), null, 2)}\n`,
      'utf8'
    );
  } catch (err) {
    log.warn(`could not write --write-acknowledged "${resolved}": ${err.message}`);
    return undefined;
  }
  return resolved;
}

module.exports = { run, USAGE, adoptFromScan, assertOneStudy };
