'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const json = require('../lib/json');
const { validateUid, safeUidSegment } = require('../lib/uid');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');
const { BAR } = require('../lib/report');
const { explainStatus, verdict, makeReportedCounts } = require('../lib/retrieve');

const { CGetRequest } = dcmjsDimse.requests;
const { CStoreResponse } = dcmjsDimse.responses;
const { Status } = dcmjsDimse.constants;

const FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae',
  'study', 'series', 'instance', 'out',
  'timeout', 'connect-timeout', 'association-timeout',
];

const USAGE = `
dcm get — retrieve a study from a peer into a folder (C-GET)

Usage:
  dcm get --host <host> --port <port> --called-ae <AE> --study <uid> --out <dir>
  dcm get ... --study <uid> --series <uid> --out <dir>
  dcm get ... --study <uid> --series <uid> --instance <uid> --out <dir>

Retrieved instances are written as
  <out>/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm
— the same layout 'dcm scp --persist' and 'dcm web retrieve' produce, so all
three can serve as the local mirror for the other's tooling.

Options:
  --host <host>          Peer hostname.                     [env DCM_HOST]
  --port <port>          Peer DIMSE port.                   [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.               [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI     [env DCM_CALLING_AE]
  --study <uid>          Study Instance UID to retrieve. Required.
  --series <uid>         Narrow the retrieve to one series.
  --instance <uid>       Narrow to one SOP instance (requires --series).
  --out <dir>            Directory to write into. Created if missing.
  --timeout <ms>         Silence allowed before giving up. Default: 60000.
  --json                 Emit the retrieval accounting as JSON.
  --verbose              Log the full association negotiation.

Why C-GET and not C-MOVE:
  C-GET brings the images back down the SAME association the request went out
  on, as C-STORE sub-operations. Nothing has to be configured on the peer and
  nothing has to listen on this machine, which is what makes "pick a study,
  pick a folder" a single step. C-MOVE instead asks the peer to open a FRESH
  association to a destination AE Title it must already have registered, which
  means a firewall hole and a config change on the archive before the first
  image moves.

  The cost is that the peer must implement C-GET, and many archives do not.
  A peer that does not will either refuse the presentation context or answer
  0x0122 SOP Class not supported — both are reported here as exactly that,
  rather than as an empty retrieve.

Note: accepting the presentation context is not a promise to implement the
  service. A peer can negotiate Study Root GET happily and then answer the
  request itself with a failure status, so what this reports is the status the
  peer returned and the number of files that actually exist on disk — never
  the number it said it would send.

Examples:
  dcm get --host pacs.example.org --port 11112 --called-ae ARCHIVE \\
    --study 1.2.840.113619.2.1 --out ./pulled
`.trimStart();

/**
 * Returns a UID, or refuses with a message naming the flag it came from.
 *
 * validateUid() answers with a verdict rather than the value, so the value has
 * to be carried through deliberately. Checked here rather than left to the
 * peer: a malformed UID is otherwise encoded into the identifier, and what
 * comes back is an empty retrieve that looks exactly like a study the archive
 * does not hold.
 *
 * @param {string} value
 * @param {string} label The flag name, for the message.
 * @returns {string}
 */
function requireUid(value, label) {
  const verdict = validateUid(value);
  if (!verdict.valid) {
    throw new args.UsageError(
      `--${label} is not a valid DICOM UID: ${verdict.reason}. ` +
        'A UID is digits and dots, at most 64 characters.'
    );
  }
  return value;
}

/**
 * Writes one arriving sub-operation to disk.
 *
 * The UIDs come from the dataset itself rather than from anything the peer
 * said about it, for the same reason 'dcm web retrieve' re-reads each part:
 * the only trustworthy statement about which instance this is lives in the
 * instance. A dataset that cannot name itself is counted as unreadable rather
 * than written under a guessed name.
 *
 * @param {object} dataset  The naturalised dataset from the C-STORE request.
 * @param {string} outDir   Destination root.
 * @param {object} tally    Mutated: written, unreadable, duplicates.
 * @returns {{ok: boolean, reason?: string, path?: string}}
 */
function persistInstance(dataset, outDir, tally) {
  const elements = dataset?.getElements?.() ?? {};
  const sopUid = elements.SOPInstanceUID;
  if (!sopUid) {
    tally.unreadable += 1;
    return { ok: false, reason: 'no SOPInstanceUID in the dataset' };
  }

  const dir = path.join(
    outDir,
    safeUidSegment(elements.StudyInstanceUID, 'unknown-study'),
    safeUidSegment(elements.SeriesInstanceUID, 'unknown-series')
  );
  const dest = path.join(dir, `${safeUidSegment(sopUid, 'instance')}.dcm`);

  // Two sub-operations carrying one SOP Instance UID would both be counted as
  // written while the filesystem held a single file, so the repeat is reported
  // instead of overwriting. Overwriting a file left by an EARLIER run is a
  // re-retrieve and stays silent; only a collision within this retrieve lies.
  if (tally.claimed.has(dest)) {
    tally.duplicates += 1;
    return { ok: false, reason: `SOPInstanceUID ${sopUid} already arrived in this retrieve` };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Written beside the destination and renamed over it, so an association
    // that drops mid-instance cannot leave a truncated file looking stored.
    const staging = `${dest}.dcm-get-${process.pid}.tmp`;
    dataset.toFile(staging);
    fs.renameSync(staging, dest);
  } catch (err) {
    tally.unreadable += 1;
    return { ok: false, reason: err.message };
  }

  tally.claimed.set(dest, sopUid);
  tally.written += 1;
  return { ok: true, path: dest };
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;
  if (flags.has('help')) return json.help('get', flags, USAGE);
  return json.guard('get', flags, () => execute(parsed));
}

async function execute(parsed) {
  const { flags } = parsed;
  const asJson = flags.has('json');

  args.rejectUnknown(flags, FLAGS);

  const host = args.resolve(flags, {
    name: 'host', env: 'DCM_HOST', required: true, describe: 'the peer hostname',
  });
  const port = args.validatePort(
    args.resolve(flags, { name: 'port', env: 'DCM_PORT', required: true, type: 'number' }),
    'port'
  );
  const calledAe = args.validateAeTitle(
    args.resolve(flags, { name: 'called-ae', env: 'DCM_CALLED_AE', required: true }), 'called-ae'
  );
  const callingAe = args.validateAeTitle(
    args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
    'calling-ae'
  );

  const studyUid = requireUid(args.resolve(flags, { name: 'study', required: true }), 'study');
  const seriesRaw = args.resolve(flags, { name: 'series' });
  const instanceRaw = args.resolve(flags, { name: 'instance' });
  const seriesUid = seriesRaw ? requireUid(seriesRaw, 'series') : undefined;
  const instanceUid = instanceRaw ? requireUid(instanceRaw, 'instance') : undefined;

  if (instanceUid && !seriesUid) {
    throw new args.UsageError(
      '--instance names one instance inside a series, so --series is required with it. ' +
        'Without it the level of the query is ambiguous and the peer would be asked ' +
        'something different from what you meant.'
    );
  }

  const outRaw = args.resolve(flags, { name: 'out', required: true });
  const outDir = path.resolve(outRaw);
  fs.mkdirSync(outDir, { recursive: true });

  const timeouts = resolveTimeouts({
    timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
    connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
    associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
  });

  // Under --json, stdout carries exactly one JSON document and nothing else —
  // that is the contract every other command here keeps, and `dcm find --json
  // | jq` depends on it. The human report therefore goes through `say`, which
  // is a no-op in JSON mode. Diagnostics stay on log.error/log.info: stderr
  // cannot corrupt the document on stdout.
  const say = asJson ? () => {} : log.out;

  const peer = json.peerOf({ host, port, calledAe, callingAe });
  const level = instanceUid ? 'IMAGE' : seriesUid ? 'SERIES' : 'STUDY';

  const request = instanceUid
    ? CGetRequest.createImageGetRequest(studyUid, seriesUid, instanceUid)
    : seriesUid
      ? CGetRequest.createSeriesGetRequest(studyUid, seriesUid)
      : CGetRequest.createStudyGetRequest(studyUid);

  const tally = { written: 0, unreadable: 0, duplicates: 0, claimed: new Map() };
  const failures = [];
  // What the PEER says about the transfer, kept apart from what is on disk.
  // They are different claims and only one of them is checkable here; see
  // lib/retrieve for why the gap between them is the thing being guarded.
  const counts = makeReportedCounts();
  const reported = counts.state;
  let finalStatus;
  let errorComment;

  request.on('response', (response) => {
    const status = response.getStatus();
    counts.absorb(response);

    if (status === Status.Pending) {
      const total = reported.counted
        ? (reported.completed ?? 0) + (reported.remaining ?? 0)
        : 0;
      log.info(
        `  ${tally.written} stored` +
          (total ? ` / ${total} announced` : '') +
          (reported.failures ? `, ${reported.failures} failed at the peer` : '')
      );
      return;
    }
    finalStatus = status;
    errorComment = response.getErrorComment?.();
  });

  say('');
  say(BAR);
  say('GET');
  say(BAR);
  say(`peer          ${calledAe} at ${host}:${port}`);
  say(`level         ${level}`);
  say(`study         ${studyUid}`);
  if (seriesUid) say(`series        ${seriesUid}`);
  if (instanceUid) say(`instance      ${instanceUid}`);
  say(`destination   ${outDir}`);
  say('');

  const { outcome } = await runAssociation({
    host, port, callingAe, calledAe,
    requests: [request],
    timeouts,
    // Each image arrives here, on this same association.
    onStoreRequest: (storeRequest, callback) => {
      const response = CStoreResponse.fromRequest(storeRequest);
      const result = persistInstance(storeRequest.getDataset(), outDir, tally);
      if (result.ok) {
        response.setStatus(Status.Success);
      } else {
        failures.push(result.reason);
        log.debug(`sub-operation not stored: ${result.reason}`);
        // Answered as a failure rather than a success, so the peer's own
        // accounting records that this instance did not land. Claiming success
        // for an instance that is not on disk is the lie this tool exists to
        // stop.
        response.setStatus(Status.ProcessingFailure);
      }
      callback(response);
    },
  });

  if (outcome.kind !== 'completed') {
    say('');
    for (const line of formatOutcome(outcome)) say(line);
    if (asJson) {
      const mapped = json.fromAssociationOutcome(outcome);
      return json.result({
        command: 'get', peer,
        outcome: mapped.outcome,
        message: mapped.message,
        detail: mapped.detail,
        payload: { outDir, written: tally.written, reported },
      });
    }
    return 1;
  }

  // A C-GET always delivers to this disk, so the disk is always checkable.
  const assessment = verdict({
    finalStatus,
    reported,
    tally,
    refused: failures.length,
    expectLocalFiles: true,
  });
  const ok = assessment.ok;

  say('');
  say(BAR);
  say(`stored on disk      ${tally.written}`);
  if (reported.counted) {
    say(`peer completed      ${reported.completed}`);
    if (reported.failures) say(`peer failed         ${reported.failures}`);
    if (reported.warnings) say(`peer warnings       ${reported.warnings}`);
  }
  if (tally.duplicates) say(`duplicate arrivals  ${tally.duplicates}`);
  if (tally.unreadable) say(`unreadable          ${tally.unreadable}`);
  say(`destination         ${outDir}`);

  // A peer that sent no sub-operation counts has given nothing to check the
  // disk against. Saying so is the difference between "verified complete" and
  // "nothing contradicted it", and only one of those is true here.
  if (!reported.counted && tally.written > 0) {
    say('');
    log.info(
      'The peer returned no sub-operation counts, so the only number above is what is ' +
        'on disk. Nothing here confirms the study is complete — compare the count ' +
        "against the archive's own, or run `dcm find --series` for its instance counts."
    );
  }

  const explained = explainStatus(finalStatus, { service: 'get' });
  if (explained) {
    say('');
    log.error(explained.headline + (errorComment ? ` — ${errorComment}` : ''));
    if (explained.hint) log.error(explained.hint);
  }

  if (assessment.shortfall > 0) {
    say('');
    log.error(
      `${assessment.shortfall} instance(s) the peer says it sent are not on disk. ` +
        'The transfer was accepted and is incomplete, which is why this exits non-zero ' +
        'rather than reporting the peer\'s own count as the result.'
    );
  }

  if (!explained && tally.written === 0) {
    say('');
    log.error(
      'The retrieve succeeded and nothing arrived. The study UID matched nothing on this ' +
        'peer, or it holds the study but will not release it to this calling AE Title.'
    );
  }

  say('');
  say(ok
    ? log.color.green(`OK — ${tally.written} instance(s) written to ${outDir}`)
    : log.color.red(`FAILED — ${assessment.problems.join('; ')}`));

  if (asJson) {
    return json.result({
      command: 'get', peer,
      outcome: ok ? json.Outcome.OK : json.Outcome.ERROR,
      message: ok
        ? `${tally.written} instance(s) retrieved.`
        : `The retrieve did not complete cleanly: ${assessment.problems.join('; ')}.`,
      payload: {
        outDir,
        level,
        studyInstanceUid: studyUid,
        seriesInstanceUid: seriesUid,
        sopInstanceUid: instanceUid,
        written: tally.written,
        duplicates: tally.duplicates,
        unreadable: tally.unreadable,
        refused: failures.length,
        status: finalStatus,
        // The peer's own claims, flagged so a consumer can tell "the peer said
        // none" from "the peer said nothing".
        reported,
        // The gap between what the peer claims it sent and what exists here.
        shortfall: assessment.shortfall,
        problems: assessment.problems,
      },
    });
  }

  return ok ? 0 : 1;
}

module.exports = { run, USAGE, persistInstance };
