'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const worklist = require('../lib/worklist');
const { safeUidSegment } = require('../lib/uid');
const { dcmjsDimse } = require('../lib/dimse');

const { Server, Scp, Dataset } = dcmjsDimse;
const { CEchoResponse, CFindResponse, CStoreResponse } = dcmjsDimse.responses;
const {
  Status,
  PresentationContextResult,
  RejectResult,
  RejectSource,
  RejectReason,
  SopClass,
  TransferSyntax,
} = dcmjsDimse.constants;

/**
 * Modality Worklist Information Model — FIND (1.2.840.10008.5.1.4.31).
 *
 * A worklist query is an ordinary C-FIND; the only thing that distinguishes it
 * from a study-level query is this SOP Class on the request, so it is what the
 * handler switches on.
 */
const MWL_FIND_SOP_CLASS = SopClass.ModalityWorklistInformationModelFind;

const FLAGS = ['port', 'ae', 'persist', 'accept-calling-ae', 'reject-after',
  'prefer-syntax', 'prefer-uncompressed', 'worklist'];

const USAGE = `
dcm scp — a permissive DICOM receiver that logs everything

Runs a store-and-echo receiver on the given port. It accepts every SOP Class
and transfer syntax offered, so it is useful as a loopback target for testing a
sender, and as a way to see exactly what a system is emitting.

Usage:
  dcm scp --port <port> [--ae <AE>] [--persist <dir>] [--worklist <file>]

Options:
  --port <port>              Port to listen on.                        [env DCM_SCP_PORT]
  --ae <AE>                  Only answer to this called AE Title.
                             Others are rejected as "called AE not recognized".
                             Default: answer to any called AE Title.
  --accept-calling-ae <AE>   Allowlist a calling AE Title. May be repeated.
                             Anything else is rejected as "calling AE not
                             recognized" — the same rejection most production
                             receivers issue, useful for testing that path.
                             Default: accept any calling AE Title.
  --persist <dir>            Write received instances to disk, laid out as
                             <dir>/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm
                             Default: acknowledge and discard.
  --worklist <file>          Serve a Modality Worklist from a JSON file, so
                             C-FIND queries for the worklist are answered with
                             real matches instead of nothing.
                             Default: answer every C-FIND with zero matches.
  --prefer-syntax <ts>       Accept this transfer syntax when the sender offers
                             it, by UID or dcmjs name. Default: take whatever
                             the sender proposed first, which is its preference.
  --prefer-uncompressed      Always pick an uncompressed syntax when offered.
  --reject-after <n>         Stop acknowledging after n instances in an
                             association, to simulate a receiver that goes
                             quiet mid-transfer. Testing aid.
  --verbose                  Log full association negotiation for every peer.

Examples:
  dcm scp --port 11112 --ae TEST-SCP --persist ./received
  dcm scp --port 11112 --ae WORKLIST --worklist ./worklist.json

Modality Worklist (--worklist):
  The file is a JSON array of worklist items, each a flat object of DICOM
  keywords. An object with an "items" array works too.

    [
      {
        "PatientName": "DOE^JANE",
        "PatientID": "12345",
        "AccessionNumber": "A1",
        "Modality": "CT",
        "ScheduledStationAETitle": "CT01",
        "ScheduledProcedureStepStartDate": "20260820",
        "ScheduledProcedureStepStartTime": "090000",
        "ScheduledPerformingPhysicianName": "SMITH^JOHN",
        "RequestedProcedureDescription": "CHEST",
        "StudyInstanceUID": "1.2.3"
      }
    ]

  Write the scheduled-step keys flat as above; they are nested into
  ScheduledProcedureStepSequence in the answer, which is where an MWL SCU
  reads them. Matching is supported on Modality, ScheduledStationAETitle,
  ScheduledProcedureStepStartDate (a single YYYYMMDD or a YYYYMMDD-YYYYMMDD
  range, either side open), PatientID, PatientName and AccessionNumber, with
  * and ? wildcards and case-insensitively. A matching key that is not in that
  list is logged and ignored rather than silently treated as a match, so a
  query is never narrower than it looks. An empty matching key matches
  everything, as DICOM requires.

  This is for testing a worklist integration locally: pointing a modality or a
  client at something that answers, and seeing which query actually returns the
  item you expect. It is not a scheduling system and not a stand-in for a RIS.
  The file is read once at startup, nothing is written back, there are no
  procedure-step status transitions and no MPPS. Without --worklist every
  C-FIND still returns zero matches, worklist or not.
`.trimStart();

/**
 * Builds the Scp subclass. The configuration is closed over rather than passed
 * through `customOptions`, which keeps it typed and avoids threading state
 * through the library's option bag.
 *
 * @param {object} config
 * @param {object} stats Mutable counters shared across connections.
 */
function makeScpClass(config, stats) {
  // Unsupported worklist matching keys are named once per receiver rather than
  // once per query. A modality polls its worklist on a timer, so warning every
  // time would bury the log in the same line and teach the operator to ignore
  // it — but staying silent would let a key the client believes is narrowing
  // the results quietly do nothing.
  const warnedKeys = new Set();

  return class PermissiveScp extends Scp {
    constructor(socket, opts) {
      super(socket, opts);
      this.association = undefined;
      this.peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? '?'}`;
      this.storedThisAssociation = 0;
    }

    associationRequested(association) {
      this.association = association;
      const callingAe = association.getCallingAeTitle();
      const calledAe = association.getCalledAeTitle();

      stats.associations += 1;
      log.info(
        `${log.color.cyan('<-')} association from ${this.peer} ` +
          `(calling AE ${callingAe} -> called AE ${calledAe})`
      );

      // Called AE Title check. Mirrors what a production receiver does when it
      // serves several AE Titles on one port.
      if (config.ae && calledAe !== config.ae) {
        log.warn(
          `rejecting: called AE "${calledAe}" does not match --ae "${config.ae}" ` +
            `(A-ASSOCIATE-RJ reason 7)`
        );
        stats.rejected += 1;
        this.sendAssociationReject(
          RejectResult.Permanent,
          RejectSource.ServiceUser,
          RejectReason.CalledAeNotRecognized
        );
        return;
      }

      // Calling AE Title allowlist. This is the rejection operators hit most
      // often in the field, so being able to reproduce it locally matters.
      if (config.acceptCallingAe.length && !config.acceptCallingAe.includes(callingAe)) {
        log.warn(
          `rejecting: calling AE "${callingAe}" is not in the allowlist ` +
            `[${config.acceptCallingAe.join(', ')}] (A-ASSOCIATE-RJ reason 3)`
        );
        stats.rejected += 1;
        this.sendAssociationReject(
          RejectResult.Permanent,
          RejectSource.ServiceUser,
          RejectReason.CallingAeNotRecognized
        );
        return;
      }

      // Permissive: accept every proposed abstract syntax.
      //
      // That includes the Modality Worklist Information Model — FIND, which is
      // why --worklist needs no negotiation special-case: the loop below has no
      // allowlist to add it to. Verified rather than assumed — the worklist
      // end-to-end tests only pass because this context is accepted.
      //
      // Transfer syntax is taken in the order the sender proposed it, which is
      // the sender's stated preference. That matters for testing: forcing
      // uncompressed here would silently undo a sender that deliberately
      // converted a study to a compressed syntax, and the transfer would look
      // like the conversion never happened. --prefer-syntax overrides, and
      // --prefer-uncompressed restores the old always-decodable behaviour.
      const preferred = config.preferUncompressed
        ? [TransferSyntax.ExplicitVRLittleEndian, TransferSyntax.ImplicitVRLittleEndian]
        : (config.preferSyntax ? [config.preferSyntax] : []);

      for (const { id } of association.getPresentationContexts()) {
        const context = association.getPresentationContext(id);
        const offered = context.getTransferSyntaxUids();
        const chosen = preferred.find((ts) => offered.includes(ts)) ?? offered[0];

        if (chosen) {
          context.setResult(PresentationContextResult.Accept, chosen);
          log.debug(`accepting context ${id}: ${context.getAbstractSyntaxUid()} as ${chosen}`);
        } else {
          context.setResult(PresentationContextResult.RejectNoReason);
          log.debug(`context ${id} offered no transfer syntax`);
        }
      }

      log.logAssociation(association, dcmjsDimse.constants, 'accepted');
      this.sendAssociationAccept();
    }

    cEchoRequest(request, callback) {
      stats.echoes += 1;
      log.info(`${log.color.cyan('<-')} C-ECHO from ${this.association?.getCallingAeTitle()}`);
      const response = CEchoResponse.fromRequest(request);
      response.setStatus(Status.Success);
      callback(response);
    }

    cStoreRequest(request, callback) {
      const response = CStoreResponse.fromRequest(request);

      // Simulated mid-transfer stall, for exercising the sender's watchdog and
      // retry paths. Never on unless explicitly asked for.
      if (config.rejectAfter > 0 && this.storedThisAssociation >= config.rejectAfter) {
        stats.refused += 1;
        log.warn(
          `--reject-after ${config.rejectAfter} reached; refusing this instance ` +
            `with 0xA700 (out of resources)`
        );
        response.setStatus(0xa700);
        callback(response);
        return;
      }

      let dataset;
      try {
        dataset = request.getDataset();
      } catch (err) {
        stats.errors += 1;
        log.error(`could not read incoming dataset: ${err.message}`);
        response.setStatus(0xc000);
        callback(response);
        return;
      }

      const sopInstanceUid = dataset?.getElement('SOPInstanceUID');
      const sopClassUid = dataset?.getElement('SOPClassUID');
      const studyUid = dataset?.getElement('StudyInstanceUID');
      const seriesUid = dataset?.getElement('SeriesInstanceUID');
      const modality = dataset?.getElement('Modality');
      const tsuid = dataset?.getTransferSyntaxUid();

      stats.stored += 1;
      this.storedThisAssociation += 1;

      log.info(
        `${log.color.cyan('<-')} C-STORE #${stats.stored} ` +
          `${modality ?? '??'} ${sopInstanceUid ?? '(no SOP Instance UID)'}`
      );
      log.debug(`     SOP Class:      ${sopClassUid}`);
      log.debug(`     Study UID:      ${studyUid}`);
      log.debug(`     Series UID:     ${seriesUid}`);
      log.debug(`     Transfer syntax:${tsuid}`);

      if (config.persist) {
        try {
          const dir = path.join(
            config.persist,
            safeUidSegment(studyUid, 'unknown-study'),
            safeUidSegment(seriesUid, 'unknown-series')
          );
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${safeUidSegment(sopInstanceUid, `instance-${stats.stored}`)}.dcm`);
          dataset.toFile(file, (err) => {
            if (err) {
              stats.errors += 1;
              log.error(`failed to persist ${file}: ${err.message}`);
            } else {
              log.debug(`     persisted to ${file}`);
            }
          });
        } catch (err) {
          stats.errors += 1;
          log.error(`failed to persist instance: ${err.message}`);
        }
      }

      response.setStatus(Status.Success);
      callback(response);
    }

    cFindRequest(request, callback) {
      stats.finds += 1;

      // A worklist query is an ordinary C-FIND carrying the Modality Worklist
      // SOP Class. dcmjs-dimse puts it on the request as the affected SOP
      // Class UID (createWorklistFindRequest sets it there), but a peer that
      // spells it as the requested SOP Class is answered just the same.
      const sopClassUid = request.getAffectedSopClassUid?.() || request.getRequestedSopClassUid?.();
      if (config.worklist && sopClassUid === MWL_FIND_SOP_CLASS) {
        this.worklistFind(request, callback);
        return;
      }

      log.info(`${log.color.cyan('<-')} C-FIND from ${this.association?.getCallingAeTitle()}`);
      log.info(
        log.color.dim(
          '     this receiver stores but does not index, so it returns zero matches — ' +
            'the same behaviour many store-and-forward systems exhibit'
        )
      );

      const finalResponse = CFindResponse.fromRequest(request);
      finalResponse.setStatus(Status.Success);
      callback([finalResponse]);
    }

    /**
     * Answers a Modality Worklist C-FIND from the configured items.
     *
     * One Pending response per match, each carrying that item's dataset, then
     * a single Success with no dataset. That is the DIMSE convention for a
     * C-FIND and what every MWL SCU is written against: a Success arriving
     * first would be read as "the worklist is empty".
     *
     * @param {object} request
     * @param {function} callback
     */
    worklistFind(request, callback) {
      const { items, file } = config.worklist;
      const callingAe = this.association?.getCallingAeTitle() ?? 'peer';

      let identifier;
      let elements = {};
      try {
        identifier = request.getDataset();
        elements = identifier?.getElements() ?? {};
      } catch (err) {
        // A query we cannot read is a query we cannot answer honestly.
        stats.errors += 1;
        log.error(`could not read the worklist query identifier: ${err.message}`);
        const failure = CFindResponse.fromRequest(request);
        failure.setAffectedSopClassUid(MWL_FIND_SOP_CLASS);
        failure.setStatus(Status.ProcessingFailure);
        callback([failure]);
        return;
      }

      const { criteria, unsupported } = worklist.readMatchingKeys(elements);

      log.info(
        `${log.color.cyan('<-')} C-FIND (Modality Worklist) from ${callingAe}`
      );

      // Warned before the summary below, so the summary is the last word on
      // what was actually matched on.
      for (const key of unsupported) {
        if (warnedKeys.has(key)) continue;
        warnedKeys.add(key);
        log.warn(
          `worklist matching key "${key}" is not supported by this receiver and is being ` +
            'ignored, so the results are wider than the query asks for. Supported keys: ' +
            `${worklist.SUPPORTED_KEYS.join(', ')}.`
        );
      }

      if (criteria.length) {
        log.info(`     matching on: ${criteria.map((c) => `${c.key}=${c.value}`).join(', ')}`);
      } else {
        log.info(log.color.dim('     no matching keys — returning the whole worklist'));
      }

      const matched = worklist.selectItems(items, criteria);

      // Reuse the identifier's transfer syntax: it is the one negotiated for
      // this presentation context, so the library has nothing to transcode.
      const transferSyntaxUid =
        identifier?.getTransferSyntaxUid() ?? TransferSyntax.ImplicitVRLittleEndian;

      const responses = matched.map((item) => {
        const pending = CFindResponse.fromRequest(request);
        // fromRequest defaults every C-FIND response to the Study Root model;
        // a worklist answer has to name the model it is answering for.
        pending.setAffectedSopClassUid(MWL_FIND_SOP_CLASS);
        pending.setStatus(Status.Pending);
        pending.setDataset(new Dataset(worklist.toDataset(item), transferSyntaxUid));
        return pending;
      });

      const finalResponse = CFindResponse.fromRequest(request);
      finalResponse.setAffectedSopClassUid(MWL_FIND_SOP_CLASS);
      finalResponse.setStatus(Status.Success);
      responses.push(finalResponse);

      stats.worklistMatches = (stats.worklistMatches ?? 0) + matched.length;
      log.info(
        `${log.color.cyan('->')} ${matched.length} worklist match(es) of ${items.length} item(s) ` +
          `from ${file}`
      );

      callback(responses);
    }

    associationReleaseRequested() {
      log.info(
        `${log.color.cyan('->')} releasing association with ` +
          `${this.association?.getCallingAeTitle() ?? 'peer'} ` +
          `(${this.storedThisAssociation} instance(s) this association)`
      );
      this.sendAssociationReleaseResponse();
    }

    abort(source, reason) {
      stats.aborts += 1;
      log.warn(`association aborted by peer (source ${source}, reason ${reason})`);
    }
  };
}

/**
 * Runs the receiver until interrupted.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const port = args.validatePort(
    args.resolve(flags, { name: 'port', env: 'DCM_SCP_PORT', required: true, type: 'number' }),
    'port'
  );

  const aeRaw = args.resolve(flags, { name: 'ae' });
  const ae = aeRaw ? args.validateAeTitle(aeRaw, 'ae') : undefined;

  // May be repeated, so it can arrive as a string or an array.
  const callingRaw = flags.get('accept-calling-ae');
  const acceptCallingAe = (
    callingRaw === undefined ? [] : Array.isArray(callingRaw) ? callingRaw : [callingRaw]
  ).map((v, i) => args.validateAeTitle(String(v), `accept-calling-ae[${i}]`));

  const persistRaw = args.resolve(flags, { name: 'persist' });
  const persist = persistRaw ? path.resolve(persistRaw) : undefined;

  const rejectAfter = args.resolve(flags, { name: 'reject-after', type: 'number', fallback: 0 });

  // Loaded and validated before the socket opens. A worklist that turns out to
  // be unreadable is a mistake to report now, not one to discover as a stream
  // of empty answers once a modality is already polling.
  const worklistRaw = args.resolve(flags, { name: 'worklist' });
  const worklistSource = worklistRaw ? worklist.loadWorklistFile(worklistRaw) : undefined;
  if (worklistSource && worklistSource.items.length === 0) {
    log.warn(
      `--worklist "${worklistSource.file}" contains no items, so every worklist query will ` +
        'return zero matches. That is indistinguishable from an empty schedule on the client.'
    );
  }

  if (persist) {
    fs.mkdirSync(persist, { recursive: true });
  }

  const stats = {
    associations: 0, rejected: 0, echoes: 0, stored: 0,
    finds: 0, worklistMatches: 0, refused: 0, aborts: 0, errors: 0,
  };

  const preferUncompressed = args.resolve(flags, {
    name: 'prefer-uncompressed', type: 'boolean', fallback: false,
  });
  const preferSyntaxRaw = args.resolve(flags, { name: 'prefer-syntax' });
  const preferSyntax = preferSyntaxRaw
    ? (/^[0-9.]+$/.test(preferSyntaxRaw) ? preferSyntaxRaw : TransferSyntax[preferSyntaxRaw])
    : undefined;
  if (preferSyntaxRaw && !preferSyntax) {
    throw new args.UsageError(
      `--prefer-syntax "${preferSyntaxRaw}" is not a transfer syntax UID or a known name.`
    );
  }

  const config = {
    ae, acceptCallingAe, persist, rejectAfter, preferUncompressed, preferSyntax,
    worklist: worklistSource,
  };
  const server = new Server(makeScpClass(config, stats));

  server.on('networkError', (err) => {
    stats.errors += 1;
    log.error(`server network error: ${err.message}`);
  });

  return new Promise((resolve) => {
    const summarize = () => {
      log.out('');
      log.out('Receiver summary');
      log.out(`  associations accepted : ${stats.associations - stats.rejected}`);
      log.out(`  associations rejected : ${stats.rejected}`);
      log.out(`  C-ECHO                : ${stats.echoes}`);
      log.out(`  C-STORE stored        : ${stats.stored}`);
      log.out(`  C-STORE refused       : ${stats.refused}`);
      log.out(`  C-FIND                : ${stats.finds}`);
      if (worklistSource) {
        log.out(`  worklist matches sent : ${stats.worklistMatches}`);
      }
      log.out(`  aborts                : ${stats.aborts}`);
      log.out(`  errors                : ${stats.errors}`);
      if (persist) log.out(`  written to            : ${persist}`);
      if (worklistSource) {
        log.out(`  worklist              : ${worklistSource.file} (${worklistSource.items.length} item(s))`);
      }
    };

    const shutdown = () => {
      log.info('');
      log.info('shutting down receiver');
      try {
        server.close();
      } catch {
        // Already closing.
      }
      summarize();
      resolve(stats.errors > 0 ? 1 : 0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    server.on('listening', () => {
      log.info(`${log.color.green('listening')} on port ${port}`);
      log.info(`  called AE Title  : ${ae ?? log.color.dim('(any)')}`);
      log.info(`  calling AE allow : ${acceptCallingAe.length ? acceptCallingAe.join(', ') : log.color.dim('(any)')}`);
      log.info(`  persist          : ${persist ?? log.color.dim('(discard after acknowledging)')}`);
      log.info(
        `  worklist         : ${
          worklistSource
            ? `${worklistSource.items.length} item(s) from ${worklistSource.file}`
            : log.color.dim('(none — C-FIND returns zero matches)')
        }`
      );
      log.info('  press Ctrl+C to stop');
    });

    server.listen(port, {
      logCommandDatasets: log.isVerbose(),
      logDatasets: false,
    });
  });
}

module.exports = { run, USAGE, makeScpClass };
