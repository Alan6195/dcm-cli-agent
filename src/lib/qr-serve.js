'use strict';

const log = require('./log');
const { scan } = require('./scan');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('./dimse');
const { RetrieveStatus } = require('./retrieve');

const { CStoreRequest } = dcmjsDimse.requests;
const { CGetResponse, CMoveResponse } = dcmjsDimse.responses;
const { Status } = dcmjsDimse.constants;

/**
 * The retrieve half of the Query/Retrieve Service Class, served from a folder.
 *
 * This is what makes the receiver a retrievable target rather than only a
 * destination. Two things wanted it:
 *
 *   - A C-GET or C-MOVE client cannot be tested without a peer that answers
 *     one. Testing the client against a mock written for the test proves the
 *     mock and the client agree; testing it against this proves the shipped
 *     receiver and the shipped client agree, which is the only claim worth
 *     making.
 *
 *   - The tool is used to stand in for a modality or an archive while
 *     something else is being commissioned. An archive that can be queried but
 *     never retrieved from is only half a stand-in.
 *
 * The two services differ in one structural way that drives everything here.
 * C-GET sends the instances back down the association the request arrived on,
 * so this process is briefly a Storage SCP on a connection it did not
 * initiate. C-MOVE opens a SEPARATE outbound association to a destination
 * named only by AE Title, which means a registry: an AE Title this receiver
 * cannot resolve is the 0xA801 that the client has to be able to provoke on
 * purpose in order to test it.
 */

/** Sub-operation statuses that count as a warning rather than a failure. */
const WARNING_STORE_STATUSES = new Set([0xb000, 0xb006, 0xb007]);

/**
 * Finds the instances a retrieve identifier asks for.
 *
 * Matching is on Unique Keys only — Study, Series and SOP Instance UID — which
 * is all a retrieve identifier is allowed to carry (PS3.4 C.4.2.1.4.1). A
 * relational query is not supported and is not pretended to be: an identifier
 * naming no study UID is refused rather than answered with everything on disk,
 * because silently widening a retrieve to the whole folder is how a test
 * fixture becomes a 40 GB transfer.
 *
 * @param {string} serveDir Directory to serve from.
 * @param {object} elements The identifier's naturalised elements.
 * @returns {{level: string, instances: Array<object>, problem?: {status: number, comment: string}}}
 */
function matchInstances(serveDir, elements) {
  const level = String(elements?.QueryRetrieveLevel ?? '').toUpperCase() || 'STUDY';
  const studyUid = elements?.StudyInstanceUID;
  const seriesUid = elements?.SeriesInstanceUID;
  const sopUid = elements?.SOPInstanceUID;

  if (!studyUid) {
    return {
      level,
      instances: [],
      problem: {
        status: RetrieveStatus.IDENTIFIER_MISMATCH,
        comment: 'no StudyInstanceUID in the identifier',
      },
    };
  }

  if (level === 'IMAGE' && !seriesUid) {
    return {
      level,
      instances: [],
      problem: {
        status: RetrieveStatus.IDENTIFIER_MISMATCH,
        comment: 'IMAGE level needs SeriesInstanceUID',
      },
    };
  }

  let result;
  try {
    result = scan(serveDir);
  } catch (err) {
    return {
      level,
      instances: [],
      problem: {
        status: RetrieveStatus.PROCESSING_FAILURE,
        comment: `cannot read the served folder: ${err.message}`,
      },
    };
  }

  const study = result.studies.get(studyUid);
  if (!study) return { level, instances: [] };

  let instances = study.instances;
  if (seriesUid) instances = instances.filter((i) => i.seriesInstanceUid === seriesUid);
  if (sopUid) instances = instances.filter((i) => i.sopInstanceUid === sopUid);

  return { level, instances };
}

/**
 * Accumulates sub-operation outcomes and reports them as DICOM counts.
 *
 * Kept as one object because the four counts have to move together: a
 * sub-operation is completed, warned or failed, never two of those, and a
 * pending response that disagrees with itself is worse than no pending
 * response at all.
 */
function makeSubOperationTally(total) {
  return {
    total,
    completed: 0,
    warnings: 0,
    failures: 0,
    settled: 0,
    /** Folds one C-STORE response in. */
    record(storeStatus) {
      if (storeStatus === Status.Success) this.completed += 1;
      else if (WARNING_STORE_STATUSES.has(storeStatus)) this.warnings += 1;
      else this.failures += 1;
      this.settled += 1;
    },
    get remaining() {
      return Math.max(0, this.total - this.settled);
    },
    /**
     * The status a finished retrieve ends on.
     *
     * Success only when every sub-operation succeeded. Anything less is
     * 0xB000 — the standard's "sub-operations complete, one or more failures" —
     * which is a WARNING in the standard and treated as a failure by this
     * tool's client, deliberately: part of the study did not arrive.
     */
    get finalStatus() {
      if (this.failures > 0 || this.warnings > 0) return RetrieveStatus.SUBOPS_FAILED;
      return Status.Success;
    },
  };
}

/**
 * Stamps the four sub-operation counts onto a response.
 *
 * `overcount` exists only to lie. A peer that reports more completed
 * sub-operations than it actually sent is the failure mode a retrieve client
 * most needs to survive and the one hardest to arrange a test for, because no
 * correct peer produces it. --retrieve-overcount makes this receiver produce it
 * on demand, so the client's disk-versus-reported comparison can be proved to
 * fire rather than assumed to.
 *
 * @param {object} response
 * @param {object} tally
 * @param {number} [overcount] Added to the completed count on the wire only.
 */
function applyCounts(response, tally, overcount = 0) {
  response.setRemaining(tally.remaining);
  response.setCompleted(tally.completed + overcount);
  response.setWarnings(tally.warnings);
  response.setFailures(tally.failures);
}

/**
 * Answers a retrieve that matched nothing, or that cannot be answered.
 *
 * A study this receiver does not hold is a SUCCESS with zero sub-operations,
 * not a failure: the request was understood and performed, and the answer is
 * that there is nothing. That distinction is exactly what a client needs in
 * order to tell "you asked for something I do not have" from "I broke".
 */
function answerEmpty(ResponseClass, request, callback, problem) {
  const final = ResponseClass.fromRequest(request);
  if (problem) {
    final.setStatus(problem.status);
    if (final.setErrorComment) final.setErrorComment(problem.comment.slice(0, 64));
  } else {
    final.setStatus(Status.Success);
  }
  final.setRemaining(0);
  final.setCompleted(0);
  final.setWarnings(0);
  final.setFailures(0);
  callback([final]);
}

/**
 * Serves a C-GET: sends the matched instances back down this association.
 *
 * The ordering here is the part that was established empirically rather than
 * from the library's declarations. The sub-operations are issued with
 * sendRequests(); each one's response is counted; a Pending C-GET response
 * goes out through sendResponse() as each settles, because the callback can
 * only fire once; and the final response is passed to the callback only when
 * the last sub-operation has settled, so its counts are true when the client
 * reads them.
 *
 * @param {object} params
 * @param {object} params.scp      The Scp instance (for sendRequests/sendResponse).
 * @param {object} params.request  The CGetRequest.
 * @param {function} params.callback
 * @param {object} params.config   Receiver config; config.serve is the folder.
 * @param {object} params.stats    Mutated counters.
 */
function serveGet({ scp, request, callback, config, stats }) {
  stats.gets += 1;

  if (!config.serve) {
    log.info(
      `${log.color.cyan('<-')} C-GET refused: this receiver was not given a folder to serve`
    );
    stats.retrieveRefused += 1;
    answerEmpty(CGetResponse, request, callback, {
      status: RetrieveStatus.PROCESSING_FAILURE,
      comment: 'no folder configured to serve',
    });
    return;
  }

  const elements = request.getDataset()?.getElements?.() ?? {};
  const { level, instances, problem } = matchInstances(config.serve, elements);

  log.info(
    `${log.color.cyan('<-')} C-GET ${level} ${elements.StudyInstanceUID ?? '(no study UID)'} ` +
      `-> ${instances.length} instance(s)`
  );

  if (problem) {
    stats.retrieveRefused += 1;
    answerEmpty(CGetResponse, request, callback, problem);
    return;
  }
  if (instances.length === 0) {
    answerEmpty(CGetResponse, request, callback);
    return;
  }

  const tally = makeSubOperationTally(instances.length);

  const stores = instances.map((instance) => {
    const store = new CStoreRequest(instance.path);
    store.on('response', (response) => {
      tally.record(response.getStatus());
      stats.subOpsSent += 1;

      if (tally.settled < tally.total) {
        const pending = CGetResponse.fromRequest(request);
        pending.setStatus(Status.Pending);
        applyCounts(pending, tally);
        scp.sendResponse(request, pending);
        return;
      }

      const final = CGetResponse.fromRequest(request);
      final.setStatus(tally.failures > 0 || tally.warnings > 0
        ? RetrieveStatus.SUBOPS_FAILED
        : Status.Success);
      applyCounts(final, tally, config.retrieveOvercount);
      log.info(
        `${log.color.cyan('->')} C-GET complete: ${tally.completed} sent, ` +
          `${tally.failures} failed, ${tally.warnings} warned` +
          (config.retrieveOvercount
            ? ` (reporting ${tally.completed + config.retrieveOvercount} — overcounting by ${config.retrieveOvercount})`
            : '')
      );
      callback([final]);
    });
    return store;
  });

  scp.sendRequests(stores);
}

/**
 * Serves a C-MOVE: opens a fresh association to the destination and stores there.
 *
 * The destination is an AE Title and nothing else, so it has to be looked up.
 * An unknown Title is answered 0xA801 without opening anything — which is both
 * the correct behaviour and the only way a client's handling of the field's
 * most common failure can be tested on loopback.
 *
 * @param {object} params See serveGet. config.destinations maps AE Title -> {host, port}.
 */
async function serveMove({ scp, request, callback, config, stats }) {
  stats.moves += 1;

  // The destination lives in the COMMAND set as Move Destination (0000,0600),
  // not in the identifier and not behind an accessor — the library models it
  // only on the constructor side. Read from the command dataset so a move that
  // arrives from any client, not just this tool's, is handled the same way.
  const destinationAe = String(
    request.getCommandDataset?.()?.getElements?.()?.MoveDestination ?? ''
  ).trim();
  const registry = config.destinations instanceof Map ? config.destinations : new Map();
  const target = registry.get(destinationAe.toUpperCase());

  if (!target) {
    log.info(
      `${log.color.cyan('<-')} C-MOVE to "${destinationAe}" refused: ` +
        `no such destination${registry.size ? ` (known: ${[...registry.keys()].join(', ')})` : ' registered'}`
    );
    stats.movesRefused += 1;
    answerEmpty(CMoveResponse, request, callback, {
      status: RetrieveStatus.MOVE_DESTINATION_UNKNOWN,
      comment: `unknown destination AE ${destinationAe}`.slice(0, 64),
    });
    return;
  }

  if (!config.serve) {
    stats.retrieveRefused += 1;
    answerEmpty(CMoveResponse, request, callback, {
      status: RetrieveStatus.PROCESSING_FAILURE,
      comment: 'no folder configured to serve',
    });
    return;
  }

  const elements = request.getDataset()?.getElements?.() ?? {};
  const { level, instances, problem } = matchInstances(config.serve, elements);

  log.info(
    `${log.color.cyan('<-')} C-MOVE ${level} ${elements.StudyInstanceUID ?? '(no study UID)'} ` +
      `-> ${instances.length} instance(s) to ${destinationAe} at ${target.host}:${target.port}`
  );

  if (problem) {
    stats.retrieveRefused += 1;
    answerEmpty(CMoveResponse, request, callback, problem);
    return;
  }
  if (instances.length === 0) {
    answerEmpty(CMoveResponse, request, callback);
    return;
  }

  const tally = makeSubOperationTally(instances.length);

  const stores = instances.map((instance) => {
    const store = new CStoreRequest(instance.path);
    store.on('response', (response) => {
      tally.record(response.getStatus());
      stats.subOpsSent += 1;
      if (tally.settled < tally.total) {
        const pending = CMoveResponse.fromRequest(request);
        pending.setStatus(Status.Pending);
        applyCounts(pending, tally);
        scp.sendResponse(request, pending);
      }
    });
    return store;
  });

  // The outbound association is a separate conversation with a third party, so
  // it gets the same watchdog every other association in this tool gets. A
  // destination that accepts the connection and then goes silent must not hang
  // the C-MOVE that is waiting on it.
  const { outcome } = await runAssociation({
    host: target.host,
    port: target.port,
    // The move originator is this receiver, which is what the destination sees
    // as the calling AE — not the client that asked for the move.
    callingAe: config.ae ?? 'DCM-SCP',
    calledAe: destinationAe,
    requests: stores,
    timeouts: resolveTimeouts({}),
  });

  const final = CMoveResponse.fromRequest(request);

  if (outcome.kind !== 'completed') {
    // The association to the destination failed. Every sub-operation that did
    // not settle is a failure, not an unknown: the client is owed a count that
    // adds up to what it asked for.
    const unsettled = tally.total - tally.settled;
    tally.failures += unsettled;
    tally.settled = tally.total;
    log.error(
      `C-MOVE could not deliver to ${destinationAe} at ${target.host}:${target.port}: ` +
        `${outcome.label}`
    );
    final.setStatus(RetrieveStatus.SUBOPS_FAILED);
    if (final.setErrorComment) {
      final.setErrorComment(`destination unreachable: ${outcome.label}`.slice(0, 64));
    }
  } else {
    final.setStatus(tally.failures > 0 || tally.warnings > 0
      ? RetrieveStatus.SUBOPS_FAILED
      : Status.Success);
  }

  applyCounts(final, tally, config.retrieveOvercount);
  log.info(
    `${log.color.cyan('->')} C-MOVE complete: ${tally.completed} stored at ${destinationAe}, ` +
      `${tally.failures} failed, ${tally.warnings} warned` +
      (config.retrieveOvercount
        ? ` (reporting ${tally.completed + config.retrieveOvercount} — overcounting by ${config.retrieveOvercount})`
        : '')
  );
  callback([final]);
}

/**
 * Parses a --destination AE=host:port into a registry entry.
 *
 * @param {string} raw
 * @returns {{ae: string, host: string, port: number}}
 */
function parseDestination(raw) {
  const text = String(raw ?? '').trim();
  const eq = text.indexOf('=');
  if (eq <= 0) {
    throw new Error(
      `--destination needs the form AE=host:port, not "${text}". ` +
        'The AE Title is what a C-MOVE names; the host and port are what this ' +
        'receiver has to resolve it to, because the request does not carry them.'
    );
  }
  const ae = text.slice(0, eq).trim();
  const where = text.slice(eq + 1).trim();
  const colon = where.lastIndexOf(':');
  if (colon < 0) {
    throw new Error(`--destination ${ae}= needs host:port, not "${where}".`);
  }
  const host = where.slice(0, colon).trim();
  // Checked before the port so the message names the part that is actually
  // missing: `AE=:11112` has a port and no host, and should say so.
  if (!host) throw new Error(`--destination ${ae} has no host before the port: "${where}".`);
  const port = Number(where.slice(colon + 1).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--destination ${ae} has a port that is not a port: "${where}".`);
  }
  return { ae: ae.toUpperCase(), host, port };
}

module.exports = {
  matchInstances,
  makeSubOperationTally,
  serveGet,
  serveMove,
  parseDestination,
};
