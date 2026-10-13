'use strict';

const log = require('./log');
const worklist = require('./worklist');
const { scan } = require('./scan');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('./dimse');
const { RetrieveStatus } = require('./retrieve');

const { CStoreRequest } = dcmjsDimse.requests;
const { CGetResponse, CMoveResponse, CFindResponse } = dcmjsDimse.responses;
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
 * The attributes this receiver can answer at each Study Root level, and where
 * each one comes from in what the scanner read.
 *
 * Deliberately small. These are what an operator types into a search and what
 * `dcm find` asks for by default, and every one of them is something the
 * scanner already read off disk. A key outside this table is not answered with
 * an invented value: it comes back zero-length, which is what "this archive
 * does not hold that attribute" means on the wire.
 */
const FIND_LEVELS = {
  STUDY: {
    StudyInstanceUID: (s) => s.studyInstanceUid,
    PatientName: (s) => s.patientName,
    PatientID: (s) => s.patientId,
    StudyDate: (s) => s.studyDate,
    StudyDescription: (s) => s.studyDescription,
    AccessionNumber: (s) => s.accessionNumber,
    ModalitiesInStudy: (s) => [...(s.modalities ?? [])].filter(Boolean),
    NumberOfStudyRelatedSeries: (s) => String(seriesOf(s).length),
    NumberOfStudyRelatedInstances: (s) => String(s.instances.length),
  },
  SERIES: {
    StudyInstanceUID: (s) => s.studyInstanceUid,
    SeriesInstanceUID: (s, se) => se.seriesInstanceUid,
    SeriesNumber: (s, se) => (se.seriesNumber === undefined ? undefined : String(se.seriesNumber)),
    Modality: (s, se) => se.modality,
    SeriesDescription: (s, se) => se.seriesDescription,
    NumberOfSeriesRelatedInstances: (s, se) => String(se.instances.length),
  },
  IMAGE: {
    StudyInstanceUID: (s, se, i) => i.studyInstanceUid,
    SeriesInstanceUID: (s, se, i) => i.seriesInstanceUid,
    SOPInstanceUID: (s, se, i) => i.sopInstanceUid,
    SOPClassUID: (s, se, i) => i.sopClassUid,
    InstanceNumber: (s, se, i) => (i.instanceNumber === undefined ? undefined : String(i.instanceNumber)),
  },
};

/** Keys that are part of the request's shape rather than something to match. */
const FIND_NON_MATCHING = new Set(['QueryRetrieveLevel', 'SpecificCharacterSet']);

/** The study's series, whether the scanner kept them as a Map or an array. */
function seriesOf(study) {
  const s = study.series;
  if (!s) return [];
  return s instanceof Map ? [...s.values()] : Array.isArray(s) ? s : Object.values(s);
}

/**
 * True when one value satisfies one matching key.
 *
 * The rules are the worklist matcher's, reused rather than restated, so a
 * pattern means the same thing to a study query as it does to a worklist
 * query on the same receiver: `*` and `?` wildcards, a hyphenated date range,
 * a Person Name matched against any of its component groups, and a UID key
 * that may carry a backslash-separated list of UIDs (PS3.4 C.2.2.2.2).
 */
function satisfies(key, actual, criterion) {
  const want = criterion.trim();
  if (Array.isArray(actual)) return actual.some((v) => satisfies(key, v, want));
  const have = actual === undefined || actual === null ? '' : String(actual);
  if (key.endsWith('UID')) return want.split('\\').map((u) => u.trim()).includes(have.trim());
  if (key.endsWith('Date')) return worklist.matchesDate(have, want);
  if (key === 'PatientName') return worklist.matchesPersonName(have, want);
  return worklist.matchesText(have, want);
}

/**
 * Answers a Study Root C-FIND out of the served folder.
 *
 * This is what makes --serve a whole Query/Retrieve stand-in rather than half
 * of one. Before it, a folder could be retrieved from and never searched,
 * which meant a client could pull a study only if it already knew the UID —
 * and the obvious flow, search for the patient and then pull what came back,
 * could not be exercised against this receiver at all.
 *
 * A key this receiver does not hold is not used to filter. That is what most
 * archives do with an optional key they do not support, and the alternative —
 * matching nothing because one unsupported key was present — would make every
 * query from a client that asks for more than this table answers come back
 * empty. The keys that were ignored are returned so the caller can say so.
 *
 * @param {string} serveDir
 * @param {object} elements The identifier's naturalised elements.
 * @returns {{level: string, matches: Array<object>, ignored: string[], problem?: {status: number, comment: string}}}
 */
function findMatches(serveDir, elements) {
  const level = String(elements?.QueryRetrieveLevel ?? '').trim().toUpperCase() || 'STUDY';
  const table = FIND_LEVELS[level];
  if (!table) {
    return {
      level,
      matches: [],
      ignored: [],
      problem: {
        status: RetrieveStatus.IDENTIFIER_MISMATCH,
        comment: `level ${level} is not served; use STUDY, SERIES or IMAGE`,
      },
    };
  }

  // Requested keys, in the order asked, and the subset that actually filters.
  const requested = [];
  const criteria = [];
  const ignored = [];
  for (const [key, value] of Object.entries(elements ?? {})) {
    if (key.startsWith('_') || FIND_NON_MATCHING.has(key)) continue;
    requested.push(key);
    if (worklist.isUniversal(value)) continue;
    if (!table[key]) {
      ignored.push(key);
      continue;
    }
    criteria.push({ key, value: worklist.textOf(value) });
  }

  let result;
  try {
    result = scan(serveDir);
  } catch (err) {
    return {
      level,
      matches: [],
      ignored,
      problem: {
        status: RetrieveStatus.PROCESSING_FAILURE,
        comment: `cannot read the served folder: ${err.message}`.slice(0, 64),
      },
    };
  }

  // One candidate per entity at the requested level, each able to answer the
  // keys of its own level.
  const candidates = [];
  for (const study of result.studies.values()) {
    if (level === 'STUDY') {
      candidates.push((key) => table[key]?.(study));
      continue;
    }
    for (const series of seriesOf(study)) {
      if (level === 'SERIES') {
        candidates.push((key) => table[key]?.(study, series));
        continue;
      }
      for (const instance of series.instances ?? []) {
        candidates.push((key) => table[key]?.(study, series, instance));
      }
    }
  }

  const matches = [];
  for (const read of candidates) {
    if (!criteria.every(({ key, value }) => satisfies(key, read(key), value))) continue;

    // The answer carries every key that was asked for: known ones filled in,
    // unknown ones zero-length. The level's unique key is always present, so
    // a client that forgot to ask for it can still act on the row.
    const row = { QueryRetrieveLevel: level };
    const keys = new Set(requested);
    keys.add(level === 'STUDY' ? 'StudyInstanceUID' : level === 'SERIES' ? 'SeriesInstanceUID' : 'SOPInstanceUID');
    for (const key of keys) {
      const value = table[key] ? read(key) : undefined;
      row[key] = value === undefined || value === null ? '' : value;
    }
    matches.push(row);
  }

  return { level, matches, ignored };
}

/**
 * Serves a non-worklist C-FIND from --serve.
 *
 * Returns the response list rather than calling back, so the receiver's own
 * answerFind() keeps sending it — which is what keeps --abort-find-after and
 * --find-status working against a served folder exactly as they do against a
 * worklist.
 *
 * @param {object} params
 * @param {object} params.request
 * @param {object} params.config
 * @param {object} params.stats
 * @param {Function} params.Dataset  dcmjs-dimse's Dataset class.
 * @returns {{pendings: object[], final: object}}
 */
function serveFind({ request, config, stats, Dataset }) {
  const identifier = request.getDataset?.();
  const elements = identifier?.getElements?.() ?? {};
  const transferSyntaxUid = identifier?.getTransferSyntaxUid?.();
  const { level, matches, ignored, problem } = findMatches(config.serve, elements);

  const final = CFindResponse.fromRequest(request);
  if (problem) {
    final.setStatus(problem.status);
    final.setErrorComment?.(problem.comment.slice(0, 64));
    log.info(`${log.color.cyan('<-')} C-FIND ${level} refused: ${problem.comment}`);
    return { pendings: [], final };
  }

  const pendings = matches.map((row) => {
    const pending = CFindResponse.fromRequest(request);
    pending.setStatus(Status.Pending);
    pending.setDataset(new Dataset(row, transferSyntaxUid));
    return pending;
  });
  final.setStatus(Status.Success);

  stats.findMatches = (stats.findMatches ?? 0) + matches.length;
  log.info(
    `${log.color.cyan('->')} C-FIND ${level}: ${matches.length} match(es) from the served folder` +
      (ignored.length ? ` (not held, so not matched on: ${ignored.join(', ')})` : '')
  );
  return { pendings, final };
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
  findMatches,
  serveFind,
  makeSubOperationTally,
  serveGet,
  serveMove,
  parseDestination,
};
