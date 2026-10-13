'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const json = require('../lib/json');
const { validateUid } = require('../lib/uid');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');
const { BAR } = require('../lib/report');
const { explainStatus, verdict, makeReportedCounts } = require('../lib/retrieve');
const { makeScpClass } = require('./scp');

const { Server } = dcmjsDimse;
const { CMoveRequest } = dcmjsDimse.requests;
const { Status } = dcmjsDimse.constants;

const FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae',
  'study', 'series', 'instance',
  'destination', 'receive', 'receive-port',
  'timeout', 'connect-timeout', 'association-timeout',
];

const USAGE = `
dcm move — ask a peer to send a study somewhere (C-MOVE)

Usage:
  dcm move --host <host> --port <port> --called-ae <AE> --study <uid> --destination <AE>
  dcm move ... --study <uid> --receive <dir> --receive-port <port>

C-MOVE does not carry an address. It carries a destination AE TITLE, and the
PEER must already resolve that title to a host and port it can reach. That one
fact is the cause of nearly every failed C-MOVE: the request is accepted, the
archive looks up the title, finds nothing, and answers 0xA801 "Move
Destination unknown" without a single image moving.

So there are two ways to use this command, and they fail differently:

  --destination <AE>   Name a destination the peer already knows. The images go
                       there, not here. This command then reports only what the
                       peer says about the transfer, because nothing local can
                       be checked — and it says so rather than implying it
                       verified anything.

  --receive <dir>      Run a receiver here for the duration of the move and
    --receive-port <p> write what arrives into <dir>. The destination AE Title
                       defaults to this tool's own calling AE. This is the
                       self-contained form, and it still requires that the peer
                       has that AE Title registered against THIS machine's
                       address and this port. Running a receiver does not tell
                       the archive about it.

If the peer has nothing registered for you, use 'dcm get' instead: C-GET brings
the images back down the association you already opened, so it needs no
configuration on the peer at all.

Options:
  --host <host>          Peer hostname.                     [env DCM_HOST]
  --port <port>          Peer DIMSE port.                   [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.               [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Default: DCM-CLI     [env DCM_CALLING_AE]
  --study <uid>          Study Instance UID to move. Required.
  --series <uid>         Narrow the move to one series.
  --instance <uid>       Narrow to one SOP instance (requires --series).
  --destination <AE>     Destination AE Title. Defaults to --calling-ae when
                         --receive is used.
  --receive <dir>        Run a receiver here and write arrivals into <dir>.
  --receive-port <port>  Port for that receiver. Required with --receive.
                                                            [env DCM_SCP_PORT]
  --timeout <ms>         Silence allowed before giving up. Default: 60000.
  --json                 Emit the move accounting as JSON.
  --verbose              Log the full association negotiation.

What is checked, and what is only reported:
  With --receive, the number of files that actually appeared on disk is compared
  against the number of sub-operations the peer says it completed, and a gap is
  a failure with a non-zero exit code. A transfer the archive calls complete
  while instances are missing is the failure this comparison exists to catch,
  and it is invisible in a progress log.

  Without --receive the images went to a third party and no such comparison is
  possible. The exit code then reflects the peer's own status and failure count
  and nothing more. Do not read a 0 there as "the study arrived intact
  somewhere" — only the destination can say that.

Examples:
  dcm move --host pacs.example.org --port 11112 --called-ae ARCHIVE \\
    --study 1.2.840.113619.2.1 --destination PACS-VIEWER

  dcm move --host pacs.example.org --port 11112 --called-ae ARCHIVE \\
    --study 1.2.840.113619.2.1 --receive ./pulled --receive-port 11113

Note: the sub-operation C-STOREs arrive on a SEPARATE association from the one
  this command opened, and they carry MoveOriginatorApplicationEntityTitle set
  to the peer. A receiver that allowlists calling AE Titles must therefore
  allow the ARCHIVE's AE, not this tool's — a detail that turns into a silent
  zero-instance move if it is got wrong.
`.trimStart();

/**
 * Returns a UID, or refuses with a message naming the flag it came from.
 *
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function requireUid(value, label) {
  const verdict_ = validateUid(value);
  if (!verdict_.valid) {
    throw new args.UsageError(
      `--${label} is not a valid DICOM UID: ${verdict_.reason}. ` +
        'A UID is digits and dots, at most 64 characters.'
    );
  }
  return value;
}

/** Every .dcm path under a directory, as a Set. Missing directory is empty. */
function dcmFilesUnder(root) {
  const found = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dcm')) found.add(full);
    }
  };
  walk(root);
  return found;
}

/**
 * Starts a receiver for the duration of a move.
 *
 * Uses the same Scp class `dcm scp` runs, so what accepts the archive's
 * sub-operations here is the shipped receiver rather than a stand-in that
 * might be more permissive than the real one.
 *
 * @param {{dir: string, port: number, ae: string}} config
 * @returns {Promise<{stats: object, close: function}>}
 */
async function startReceiver({ dir, port, ae }) {
  const stats = {
    associations: 0, rejected: 0, echoes: 0, stored: 0,
    finds: 0, worklistMatches: 0, refused: 0, aborts: 0, errors: 0,
    mppsCreated: 0, mppsCompleted: 0, mppsDiscontinued: 0, mppsRefused: 0,
    worklistWithheld: 0,
  };

  const server = new Server(
    makeScpClass(
      {
        ae,
        // The sub-operations come from the ARCHIVE, not from this tool, so an
        // allowlist here would reject the very thing being waited for.
        acceptCallingAe: [],
        persist: dir,
        rejectAfter: 0,
        worklist: undefined,
        keepPerformed: false,
      },
      stats
    )
  );

  server.on('networkError', (err) => {
    stats.errors += 1;
    log.debug(`receiver network error: ${err?.message ?? err}`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.on('listening', resolve);
    try {
      server.listen(port, { logCommandDatasets: log.isVerbose(), logDatasets: false });
    } catch (err) {
      reject(err);
    }
  });

  return {
    stats,
    close: () => {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Waits until the receiver stops gaining files, so the count is final.
 *
 * The final C-MOVE response says the sub-operations are over, but the files
 * those sub-operations produced are written asynchronously on a different
 * association, and the last of them can still be in flight when the response
 * arrives. Counting immediately would report a shortfall that does not exist.
 *
 * This settles rather than sleeping a fixed time: it returns as soon as two
 * consecutive looks agree, and gives up after the budget so a receiver that
 * keeps dribbling cannot hang the command.
 *
 * @param {string} dir
 * @param {Set<string>} before
 * @param {number} budgetMs
 * @returns {Promise<Set<string>>} Paths that appeared during the move.
 */
async function settleArrivals(dir, before, budgetMs = 5000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const arrivals = () => {
    const now = dcmFilesUnder(dir);
    for (const p of before) now.delete(p);
    return now;
  };

  let last = arrivals();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const next = arrivals();
    if (next.size === last.size) return next;
    last = next;
  }
  return last;
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;
  if (flags.has('help')) return json.help('move', flags, USAGE);
  return json.guard('move', flags, () => execute(parsed));
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
        'Without it the level of the request is ambiguous and the peer would be asked ' +
        'something different from what you meant.'
    );
  }

  const receiveRaw = args.resolve(flags, { name: 'receive' });
  const receiveDir = receiveRaw ? path.resolve(receiveRaw) : undefined;

  let receivePort;
  if (receiveDir) {
    receivePort = args.validatePort(
      args.resolve(flags, {
        name: 'receive-port', env: 'DCM_SCP_PORT', required: true, type: 'number',
        describe: 'the port this receiver listens on, which must match what the peer has registered',
      }),
      'receive-port'
    );
  } else if (args.resolve(flags, { name: 'receive-port' })) {
    throw new args.UsageError(
      '--receive-port only means something with --receive, which is what starts the ' +
        'receiver it would be the port for.'
    );
  }

  const destinationRaw = args.resolve(flags, { name: 'destination' });
  if (!destinationRaw && !receiveDir) {
    throw new args.UsageError(
      'A C-MOVE needs somewhere to move to: give --destination <AE> for a destination the ' +
        'peer already knows, or --receive <dir> --receive-port <port> to run a receiver ' +
        'here. If the peer has no AE Title registered for you at all, use `dcm get` ' +
        'instead — it needs nothing configured on the peer.'
    );
  }
  const destinationAe = args.validateAeTitle(destinationRaw ?? callingAe, 'destination');

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
    ? CMoveRequest.createImageMoveRequest(destinationAe, studyUid, seriesUid, instanceUid)
    : seriesUid
      ? CMoveRequest.createSeriesMoveRequest(destinationAe, studyUid, seriesUid)
      : CMoveRequest.createStudyMoveRequest(destinationAe, studyUid);

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
        `  ${reported.completed} completed at the peer` +
          (total ? ` / ${total} announced` : '') +
          (reported.failures ? `, ${reported.failures} failed` : '')
      );
      return;
    }
    finalStatus = status;
    errorComment = response.getErrorComment?.();
  });

  say('');
  say(BAR);
  say('MOVE');
  say(BAR);
  say(`peer          ${calledAe} at ${host}:${port}`);
  say(`level         ${level}`);
  say(`study         ${studyUid}`);
  if (seriesUid) say(`series        ${seriesUid}`);
  if (instanceUid) say(`instance      ${instanceUid}`);
  say(`destination   ${destinationAe}${destinationRaw ? '' : ' (this tool\'s calling AE)'}`);
  if (receiveDir) {
    say(`receiving on  port ${receivePort} -> ${receiveDir}`);
  } else {
    say('receiving     elsewhere — nothing local to check');
  }
  say('');

  let receiver;
  let before = new Set();
  if (receiveDir) {
    fs.mkdirSync(receiveDir, { recursive: true });
    // Snapshotted so a re-run into a directory that already holds the study
    // counts only what THIS move delivered. Counting everything present would
    // let a previous run's files cover a shortfall in this one.
    before = dcmFilesUnder(receiveDir);
    try {
      receiver = await startReceiver({ dir: receiveDir, port: receivePort, ae: destinationAe });
    } catch (err) {
      log.error(
        `could not listen on port ${receivePort}: ${err.message}. ` +
          'The receiver has to be up before the move is issued, because the peer may start ' +
          'sending immediately.'
      );
      return 1;
    }
    log.info(`receiver listening on port ${receivePort} as AE ${destinationAe}`);
  }

  let arrivals = new Set();
  try {
    const { outcome } = await runAssociation({
      host, port, callingAe, calledAe,
      requests: [request],
      timeouts,
    });

    if (outcome.kind !== 'completed') {
      say('');
      for (const line of formatOutcome(outcome)) say(line);
      if (receiveDir) arrivals = await settleArrivals(receiveDir, before);
      if (asJson) {
        const mapped = json.fromAssociationOutcome(outcome);
        return json.result({
          command: 'move', peer,
          outcome: mapped.outcome,
          message: mapped.message,
          detail: mapped.detail,
          payload: {
            destinationAe,
            receiveDir,
            arrived: arrivals.size,
            reported,
          },
        });
      }
      return 1;
    }

    if (receiveDir) arrivals = await settleArrivals(receiveDir, before);
  } finally {
    receiver?.close();
  }

  const tally = {
    written: arrivals.size,
    // The receiver reports its own write failures; they are losses here too.
    unreadable: receiver ? receiver.stats.errors : 0,
    duplicates: 0,
  };

  const assessment = verdict({
    finalStatus,
    reported,
    tally,
    refused: 0,
    // Only a move we are receiving ourselves has a disk to check.
    expectLocalFiles: Boolean(receiveDir),
  });
  const ok = assessment.ok;

  say('');
  say(BAR);
  if (reported.counted) {
    say(`peer completed      ${reported.completed}`);
    if (reported.failures) say(`peer failed         ${reported.failures}`);
    if (reported.warnings) say(`peer warnings       ${reported.warnings}`);
  } else {
    say('peer counts         (none returned)');
  }
  if (receiveDir) {
    say(`arrived on disk     ${arrivals.size}`);
    if (tally.unreadable) say(`write failures      ${tally.unreadable}`);
    say(`destination         ${receiveDir}`);
  }

  const explained = explainStatus(finalStatus, { service: 'move', destinationAe });
  if (explained) {
    say('');
    log.error(explained.headline + (errorComment ? ` — ${errorComment}` : ''));
    if (explained.hint) log.error(explained.hint);
  }

  if (assessment.shortfall > 0) {
    say('');
    log.error(
      `${assessment.shortfall} instance(s) the peer says it sent did not arrive. ` +
        'The move was accepted and is incomplete, which is why this exits non-zero ' +
        'rather than reporting the peer\'s own count as the result.'
    );
  }

  if (!receiveDir && ok) {
    say('');
    log.info(
      `The images went to ${destinationAe}, so the only evidence here is what this peer ` +
        'reported. Confirm the study arrived by querying the destination itself — a 0 ' +
        'exit code from this command does not prove anything landed there.'
    );
  }

  say('');
  say(ok
    ? log.color.green(
        receiveDir
          ? `OK — ${arrivals.size} instance(s) arrived in ${receiveDir}`
          : `OK — the peer reports ${reported.counted ? reported.completed : 'an unstated number of'} instance(s) sent to ${destinationAe}`
      )
    : log.color.red(`FAILED — ${assessment.problems.join('; ')}`));

  if (asJson) {
    return json.result({
      command: 'move', peer,
      outcome: ok ? json.Outcome.OK : json.Outcome.ERROR,
      message: ok
        ? `The move completed; ${receiveDir ? `${arrivals.size} instance(s) arrived.` : `destination ${destinationAe}.`}`
        : `The move did not complete cleanly: ${assessment.problems.join('; ')}.`,
      payload: {
        level,
        studyInstanceUid: studyUid,
        seriesInstanceUid: seriesUid,
        sopInstanceUid: instanceUid,
        destinationAe,
        // Null rather than absent, so a consumer can tell "we did not receive"
        // from "we received nothing".
        receiveDir: receiveDir ?? null,
        arrived: receiveDir ? arrivals.size : null,
        verified: Boolean(receiveDir),
        status: finalStatus,
        reported,
        shortfall: assessment.shortfall,
        problems: assessment.problems,
      },
    });
  }

  return ok ? 0 : 1;
}

module.exports = { run, USAGE, dcmFilesUnder, settleArrivals };
