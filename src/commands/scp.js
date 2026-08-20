'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const worklist = require('../lib/worklist');
const { formatCode } = require('../lib/status');
const { safeUidSegment, validateUid } = require('../lib/uid');
const { dcmjsDimse } = require('../lib/dimse');

const { Server, Scp, Dataset } = dcmjsDimse;
const {
  CEchoResponse, CFindResponse, CStoreResponse, NCreateResponse, NSetResponse,
} = dcmjsDimse.responses;
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

/**
 * Modality Performed Procedure Step (1.2.840.10008.3.1.2.3.3).
 *
 * MPPS is an N-service, not a C-service: the step is an object the modality
 * creates with N-CREATE and finishes with N-SET, and both carry this SOP Class.
 * It is the only SOP Class this receiver accepts those messages for.
 */
const MPPS_SOP_CLASS = SopClass.ModalityPerformedProcedureStep;

/**
 * Error Comment (0000,0902) has VR LO, which is 64 characters.
 *
 * A longer value is an illegal element, and what a peer does with one ranges
 * from truncating it to failing to parse the response at all. The full reason
 * always goes to this receiver's own log; only the wire copy is cut.
 */
const MAX_ERROR_COMMENT = 64;

const FLAGS = ['port', 'ae', 'persist', 'accept-calling-ae', 'reject-after',
  'prefer-syntax', 'prefer-uncompressed', 'worklist', 'keep-performed'];

/**
 * Trims an error comment to what the element can legally carry.
 *
 * @param {string} text
 * @returns {string}
 */
function wireComment(text) {
  return text.length <= MAX_ERROR_COMMENT
    ? text
    : `${text.slice(0, MAX_ERROR_COMMENT - 3)}...`;
}

const USAGE = `
dcm scp — a permissive DICOM receiver that logs everything

Runs a store-and-echo receiver on the given port. It accepts every SOP Class
and transfer syntax offered, so it is useful as a loopback target for testing a
sender, and as a way to see exactly what a system is emitting. With --worklist
it also answers Modality Worklist queries and records the Modality Performed
Procedure Steps a modality reports back against them.

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
                             Performed procedure steps are written alongside
                             them as <dir>/mpps/<SOP Instance UID>.json.
                             Default: acknowledge and discard.
  --worklist <file>          Serve a Modality Worklist from a JSON file, so
                             C-FIND queries for the worklist are answered with
                             real matches instead of nothing.
                             Default: answer every C-FIND with zero matches.
  --keep-performed           Keep answering worklist queries with an item after
                             its performed procedure step has completed.
                             Default: a completed or discontinued step's item
                             is withheld from later worklist queries, which is
                             what a real RIS does.
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
  dcm scp --port 11112 --ae WORKLIST --worklist ./worklist.json --keep-performed

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
  The file is read once at startup and is never written back to: a step that
  completes withholds its item in memory only, and the file on disk is left
  exactly as you wrote it. Without --worklist every C-FIND still returns zero
  matches, worklist or not.

Modality Performed Procedure Step (MPPS):
  The receiver implements N-CREATE and N-SET for the MPPS SOP Class. A modality
  creates a step when it starts imaging and sets it to COMPLETED or
  DISCONTINUED when it stops, and this receiver records both, so an MPPS client
  can be run against something that actually enforces the rules rather than
  against a peer that says Success to everything.

  What it refuses, and why refusing matters:
    - A duplicate SOP Instance UID               -> 0x0111 Duplicate SOP Instance
    - A missing or empty Type 1 attribute        -> 0x0120 Missing Attribute
    - A creation status other than IN PROGRESS   -> 0x0106 Invalid Attribute Value
    - An N-SET naming a step that was never made -> 0x0112 No Such Object Instance
    - An N-SET on an already-terminal step       -> 0x0110 Processing Failure
  A receiver that accepts an N-CREATE with an empty Type 1 attribute and
  answers Success is the usual reason a step is never reconciled with anything.
  Each refusal names the reason in Error Comment, truncated to the 64
  characters that element can hold; the whole reason is on this receiver's log.

  When a step reaches COMPLETED or DISCONTINUED, it is correlated back to the
  loaded worklist on StudyInstanceUID, then AccessionNumber, then
  ScheduledProcedureStepID, all read from ScheduledStepAttributesSequence. The
  matching item is then withheld from further worklist queries, so a completed
  study leaves the worklist the way it does with a real RIS. Use
  --keep-performed to leave it there instead. If nothing matches, that is said
  plainly in the log rather than passed over — an uncorrelated step is the
  single most useful signal this receiver produces.

  Without --worklist, MPPS still works: steps are created, validated and
  completed, and are simply not correlated with anything. The log says so each
  time a step finishes.

Note: completing a step is meant to remove its item from the worklist, so the
same query that returned the patient a minute ago will return nothing
afterwards. That is the feature, not a broken worklist. Run with
--keep-performed while you are testing the query itself. Note also that a step
completing here changes only this receiver's in-memory copy of the worklist: no
other system is told anything, and the JSON file is not modified.
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

  /**
   * Performed procedure steps, keyed by their SOP Instance UID.
   *
   * Per receiver rather than per association, because that is what MPPS
   * requires: the modality creates the step on one association and finishes it
   * on another, minutes or hours later. State scoped to a connection would make
   * every N-SET fail with "no such object instance".
   */
  const steps = new Map();

  /**
   * Worklist items whose step has finished, held by object identity.
   *
   * `config.worklist.items` is loaded once and never rebuilt, so the objects in
   * it are stable for the life of the receiver and are their own keys. Nothing
   * is removed from the array itself: the file is a fixture, and mutating it
   * would make the count in the startup banner a lie.
   */
  const performed = new Set();

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
      // That includes the Modality Worklist Information Model — FIND and the
      // Modality Performed Procedure Step SOP Class, which is why neither needs
      // a negotiation special-case: the loop below has no allowlist to add them
      // to. Verified rather than assumed — the worklist and MPPS end-to-end
      // tests only pass because these contexts are accepted. A peer that
      // accepts an association while rejecting the MPPS context is a real
      // failure mode, and it is one this receiver cannot produce.
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

      // Items whose performed step has finished are gone from the worklist,
      // which is the whole point of correlating MPPS back to it. They are
      // filtered before matching so the count below describes what was actually
      // considered, and the withheld ones are named in their own line rather
      // than silently shrinking the answer.
      const available = config.keepPerformed || performed.size === 0
        ? items
        : items.filter((item) => !performed.has(item));
      const withheld = items.length - available.length;
      if (withheld) {
        log.info(
          log.color.dim(
            `     ${withheld} item(s) withheld: their performed procedure step has ` +
              'finished (--keep-performed keeps them)'
          )
        );
      }

      const matched = worklist.selectItems(available, criteria);

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

    /**
     * Refuses an N-service request, with the reason recorded in both places.
     *
     * The wire copy of the reason is cut to what Error Comment can hold; the
     * whole of it goes to the log, because the operator watching this receiver
     * is the one who can act on it.
     *
     * @param {object} response Already built from the request.
     * @param {function} callback
     * @param {number} status
     * @param {string} reason
     */
    refuseStep(response, callback, status, reason) {
      stats.mppsRefused = (stats.mppsRefused ?? 0) + 1;
      response.setStatus(status);
      response.setErrorComment(wireComment(reason));
      log.warn(`${log.color.cyan('->')} refused ${formatCode(status)}: ${reason}`);
      callback(response);
    }

    /**
     * Reads an N-service request's dataset, or refuses the request.
     *
     * A request whose dataset cannot be read cannot be acted on honestly, and
     * an N-CREATE that carries no dataset at all is not an edge case — it is a
     * client that forgot setDataset(), which leaves every Type 1 attribute
     * missing and is reported as exactly that.
     *
     * @returns {Record<string, unknown>|undefined} undefined once refused.
     */
    stepElements(request, response, callback) {
      try {
        return request.getDataset()?.getElements() ?? {};
      } catch (err) {
        stats.errors += 1;
        this.refuseStep(
          response, callback, Status.ProcessingFailure,
          `the dataset could not be read: ${err.message}`
        );
        return undefined;
      }
    }

    /**
     * MPPS N-CREATE: a modality reporting that it has started imaging.
     *
     * The SCU generates the SOP Instance UID for the step, so this receiver's
     * job is to check it, check the attributes that must be there, and record
     * the correlation keys that will later tie the step back to the worklist.
     */
    nCreateRequest(request, callback) {
      const response = NCreateResponse.fromRequest(request);
      const callingAe = this.association?.getCallingAeTitle() ?? 'peer';
      const sopClassUid = request.getAffectedSopClassUid();
      const stepUid = request.getAffectedSopInstanceUid();

      log.info(
        `${log.color.cyan('<-')} N-CREATE (MPPS) ` +
          `${stepUid ?? '(no SOP Instance UID)'} from ${callingAe}`
      );

      if (sopClassUid !== MPPS_SOP_CLASS) {
        this.refuseStep(
          response, callback, Status.SopClassNotSupported,
          `this receiver implements N-CREATE for Modality Performed Procedure Step only, ` +
            `not for ${sopClassUid ?? '(no SOP Class UID)'}`
        );
        return;
      }

      // The UID is checked rather than trusted because it is the key everything
      // else hangs off: an N-SET arrives later carrying nothing but this UID,
      // and it is also what --persist turns into a filename.
      const uidCheck = validateUid(stepUid ?? '');
      if (!uidCheck.valid) {
        this.refuseStep(
          response, callback, Status.InvalidObjectInstance,
          `the affected SOP Instance UID is ${uidCheck.reason}`
        );
        return;
      }

      if (steps.has(stepUid)) {
        this.refuseStep(
          response, callback, Status.DuplicateSOPInstance,
          'a step with this SOP Instance UID already exists here'
        );
        return;
      }

      const elements = this.stepElements(request, response, callback);
      if (elements === undefined) return;

      const missing = worklist.missingType1(elements);
      if (missing.length) {
        this.refuseStep(
          response, callback, Status.MissingAttribute,
          `missing Type 1 attribute(s): ${missing.join(', ')}`
        );
        return;
      }

      const stepStatus = worklist.textOf(elements.PerformedProcedureStepStatus).trim().toUpperCase();
      if (stepStatus !== worklist.MPPS_IN_PROGRESS) {
        this.refuseStep(
          response, callback, Status.InvalidAttributeValue,
          `a step must be created ${worklist.MPPS_IN_PROGRESS}, not "${stepStatus}"`
        );
        return;
      }

      const step = {
        sopInstanceUid: stepUid,
        status: stepStatus,
        createdAt: new Date().toISOString(),
        createdBy: callingAe,
        updates: 0,
        correlation: worklist.readCorrelationKeys(elements),
        correlatedTo: undefined,
        elements: worklist.plainElements(elements),
      };
      steps.set(stepUid, step);
      stats.mppsCreated = (stats.mppsCreated ?? 0) + 1;

      log.info(
        `${log.color.cyan('->')} step created: ` +
          `${worklist.textOf(elements.PerformedProcedureStepID)} ` +
          `${worklist.textOf(elements.Modality)} ${stepStatus}`
      );
      log.debug(`     station AE:     ${worklist.textOf(elements.PerformedStationAETitle)}`);
      log.debug(
        `     started:        ${worklist.textOf(elements.PerformedProcedureStepStartDate)} ` +
          `${worklist.textOf(elements.PerformedProcedureStepStartTime)}`
      );
      log.debug(
        `     correlates on:  ${worklist.formatCorrelationKeys(step.correlation) || '(nothing)'}`
      );

      this.persistStep(step);

      response.setStatus(Status.Success);
      callback(response);
    }

    /**
     * MPPS N-SET: a modality finishing, or adding to, a step it created.
     *
     * The asymmetry in the UID getters is real and is easy to get backwards. On
     * the *request* the step is the requested SOP Instance UID; on the response
     * the library maps it to the affected one. Reading the affected UID here
     * gets undefined and every N-SET fails as unknown.
     */
    nSetRequest(request, callback) {
      const response = NSetResponse.fromRequest(request);
      const callingAe = this.association?.getCallingAeTitle() ?? 'peer';
      const sopClassUid = request.getRequestedSopClassUid();
      const stepUid = request.getRequestedSopInstanceUid();

      log.info(
        `${log.color.cyan('<-')} N-SET (MPPS) ` +
          `${stepUid ?? '(no SOP Instance UID)'} from ${callingAe}`
      );

      if (sopClassUid !== MPPS_SOP_CLASS) {
        this.refuseStep(
          response, callback, Status.SopClassNotSupported,
          `this receiver implements N-SET for Modality Performed Procedure Step only, ` +
            `not for ${sopClassUid ?? '(no SOP Class UID)'}`
        );
        return;
      }

      const step = steps.get(stepUid);
      if (!step) {
        this.refuseStep(
          response, callback, Status.NoSuchObjectInstance,
          'no step with this SOP Instance UID was created here'
        );
        return;
      }

      const elements = this.stepElements(request, response, callback);
      if (elements === undefined) return;

      // An N-SET carries only what changes, so an absent status is not an empty
      // one: it means "these attributes changed, the step is still running".
      const next = worklist.textOf(elements.PerformedProcedureStepStatus).trim().toUpperCase();
      const refusal = worklist.transitionRefusal(step.status, next);
      if (refusal) {
        const status = worklist.MPPS_TERMINAL_STATUSES.includes(step.status)
          ? Status.ProcessingFailure // PS3.4 F.8.2: may no longer be updated.
          : Status.InvalidAttributeValue;
        this.refuseStep(response, callback, status, refusal);
        return;
      }

      // Attribute-level replacement, which is what N-SET means: a supplied
      // PerformedSeriesSequence replaces the one held, it does not append to
      // it. Anything the client did not send is left exactly as it was.
      Object.assign(step.elements, worklist.plainElements(elements));
      step.updates += 1;
      step.updatedAt = new Date().toISOString();
      if (next) step.status = next;

      const series = Array.isArray(step.elements.PerformedSeriesSequence)
        ? step.elements.PerformedSeriesSequence
        : [];
      const instances = series.reduce(
        (n, item) => n + (Array.isArray(item?.ReferencedImageSequence)
          ? item.ReferencedImageSequence.length
          : 0),
        0
      );

      const finished = worklist.MPPS_TERMINAL_STATUSES.includes(step.status);
      if (finished) {
        if (step.status === worklist.MPPS_COMPLETED) {
          stats.mppsCompleted = (stats.mppsCompleted ?? 0) + 1;
        } else {
          stats.mppsDiscontinued = (stats.mppsDiscontinued ?? 0) + 1;
        }
        log.info(
          `${log.color.cyan('->')} step ${step.status}: ${series.length} series, ` +
            `${instances} instance(s) referenced`
        );
      } else {
        log.info(
          `${log.color.cyan('->')} step updated, still ${step.status}: ${series.length} series, ` +
            `${instances} instance(s) referenced`
        );
      }
      // Worth being explicit about: the sequence is what the modality says it
      // produced. This receiver does not check those SOP Instance UIDs against
      // anything it has been sent, and no receiver's acceptance of an N-SET is
      // evidence that the images exist.
      log.debug('     the series above are as declared by the SCU; they are not verified here');
      for (const item of series) {
        log.debug(`     series:         ${worklist.textOf(item?.SeriesInstanceUID)}`);
      }

      // Only now, with the step recorded as finished, is it right to touch the
      // worklist: an item is retired because a step ended, never because one
      // was updated.
      if (finished) this.retireWorklistItems(step);

      this.persistStep(step);

      response.setStatus(Status.Success);
      callback(response);
    }

    /**
     * Correlates a finished step back to the worklist it came from.
     *
     * Every branch says what happened, including the branch where nothing
     * matched. A step that correlates with nothing is not an error — a modality
     * may legitimately perform something unscheduled — but it is the case where
     * an operator most needs to know that the worklist did not change, and it
     * is also what a mismatched Study Instance UID looks like.
     *
     * @param {object} step
     */
    retireWorklistItems(step) {
      const keys = worklist.formatCorrelationKeys(step.correlation);

      if (!config.worklist) {
        log.info(
          log.color.dim(
            '     no worklist is loaded (--worklist), so this step is recorded but ' +
              'correlated with nothing'
          )
        );
        return;
      }

      const { by, value, items } = worklist.correlateItems(config.worklist.items, step.correlation);
      if (!by) {
        log.warn(
          'no worklist item matched this performed procedure step, so nothing was marked ' +
            `performed. Tried ${keys || '(the step carried no correlation keys)'} against ` +
            `${config.worklist.items.length} item(s) in ${config.worklist.file}.`
        );
        return;
      }

      step.correlatedTo = { by, value, count: items.length };

      if (config.keepPerformed) {
        log.info(
          `${log.color.cyan('->')} matched ${items.length} worklist item(s) on ${by}=${value}; ` +
            '--keep-performed is set, so they still answer worklist queries'
        );
        return;
      }

      for (const item of items) performed.add(item);
      stats.worklistWithheld = performed.size;
      log.info(
        `${log.color.cyan('->')} matched ${items.length} worklist item(s) on ${by}=${value}; ` +
          'withheld from this receiver\'s later worklist queries'
      );
    }

    /**
     * Writes a step to disk under --persist, so a finished run can be read back.
     *
     * One JSON file per step, rewritten in full on every change: a step is
     * small, and a file that always holds the current state is worth more here
     * than an append-only history nobody will replay.
     *
     * @param {object} step
     */
    persistStep(step) {
      if (!config.persist) return;
      try {
        const dir = path.join(config.persist, 'mpps');
        fs.mkdirSync(dir, { recursive: true });
        const name = safeUidSegment(step.sopInstanceUid, `step-${steps.size}`);
        const file = path.join(dir, `${name}.json`);
        fs.writeFileSync(file, `${JSON.stringify(step, null, 2)}\n`, 'utf8');
        log.debug(`     step written to ${file}`);
      } catch (err) {
        stats.errors += 1;
        log.error(`failed to persist performed procedure step: ${err.message}`);
      }
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

  const keepPerformed = args.resolve(flags, {
    name: 'keep-performed', type: 'boolean', fallback: false,
  });
  if (keepPerformed && !worklistSource) {
    log.warn(
      '--keep-performed only affects the worklist, and no --worklist is loaded, so it has ' +
        'nothing to keep. MPPS steps are still recorded.'
    );
  }

  if (persist) {
    fs.mkdirSync(persist, { recursive: true });
  }

  const stats = {
    associations: 0, rejected: 0, echoes: 0, stored: 0,
    finds: 0, worklistMatches: 0, refused: 0, aborts: 0, errors: 0,
    mppsCreated: 0, mppsCompleted: 0, mppsDiscontinued: 0, mppsRefused: 0,
    worklistWithheld: 0,
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
    worklist: worklistSource, keepPerformed,
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
      log.out(`  MPPS created          : ${stats.mppsCreated}`);
      log.out(`  MPPS completed        : ${stats.mppsCompleted}`);
      log.out(`  MPPS discontinued     : ${stats.mppsDiscontinued}`);
      log.out(`  MPPS refused          : ${stats.mppsRefused}`);
      if (worklistSource) {
        log.out(`  worklist withheld     : ${stats.worklistWithheld}`);
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
      log.info(
        `  performed steps  : ${
          worklistSource
            ? (keepPerformed
              ? 'stay in the worklist after completing (--keep-performed)'
              : 'leave the worklist when they complete')
            : log.color.dim('(recorded, but correlated with nothing)')
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
