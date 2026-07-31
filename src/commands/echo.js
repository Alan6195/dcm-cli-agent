'use strict';

const log = require('../lib/log');
const args = require('../lib/args');
const status = require('../lib/status');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');

const { CEchoRequest } = dcmjsDimse.requests;

const FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae', 'timeout',
  'connect-timeout', 'association-timeout',
];

const USAGE = `
dcm echo — verify connectivity to a DICOM peer (C-ECHO)

Usage:
  dcm echo --host <host> --port <port> --called-ae <AE> [--calling-ae <AE>]

Options:
  --host <host>          Peer hostname. Prefer a hostname over an IP address.   [env DCM_HOST]
  --port <port>          Peer DIMSE port.                                       [env DCM_PORT]
  --called-ae <AE>       The peer's AE Title.                                   [env DCM_CALLED_AE]
  --calling-ae <AE>      Our AE Title. Must be registered on the peer.          [env DCM_CALLING_AE]
                         Default: DCM-CLI
  --timeout <ms>         Silence allowed before giving up. Default: 60000.
  --verbose              Log the full association negotiation.

Example:
  dcm echo --host pacs.example.org --port 11112 --called-ae ARCHIVE --calling-ae DCM-CLI
`.trimStart();

/**
 * C-ECHO. The cheapest possible question: is there a DICOM service there, and
 * will it talk to us under these AE Titles?
 *
 * A successful echo confirms connectivity and that the calling AE Title is
 * accepted. It does not confirm that the peer will accept storage — those are
 * negotiated per SOP Class, and a peer can happily echo while refusing every
 * image you send it.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>} Process exit code.
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const host = args.resolve(flags, {
    name: 'host', env: 'DCM_HOST', required: true,
    describe: 'the peer hostname',
  });
  const port = args.validatePort(
    args.resolve(flags, { name: 'port', env: 'DCM_PORT', required: true, type: 'number' }),
    'port'
  );
  const calledAe = args.validateAeTitle(
    args.resolve(flags, { name: 'called-ae', env: 'DCM_CALLED_AE', required: true }),
    'called-ae'
  );
  const callingAe = args.validateAeTitle(
    args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
    'calling-ae'
  );

  const timeouts = resolveTimeouts({
    timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
    connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
    associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
  });

  log.info(`C-ECHO ${callingAe} -> ${calledAe} at ${host}:${port}`);

  const request = new CEchoRequest();

  // Captured from the response handler; the association result alone does not
  // tell us what the peer said about the echo itself.
  let echoStatus;
  let echoComment;
  let roundTripMs;
  const started = Date.now();

  request.on('response', (response) => {
    // Timed here rather than around the whole association: the association
    // includes a deliberate linger before release, and reporting that as
    // latency would badly misrepresent a healthy link.
    roundTripMs = Date.now() - started;
    echoStatus = response.getStatus();
    echoComment = response.getErrorComment();
  });

  const { outcome } = await runAssociation({
    host, port, callingAe, calledAe,
    requests: [request],
    timeouts,
  });
  const elapsed = roundTripMs ?? Date.now() - started;

  if (outcome.kind !== 'completed') {
    log.error(`C-ECHO failed after ${elapsed} ms`);
    for (const line of formatOutcome(outcome)) log.out(line);
    return 1;
  }

  if (echoStatus === undefined) {
    log.error(`C-ECHO failed after ${elapsed} ms`);
    log.out(
      'The association was established and released, but the peer never answered the echo. ' +
        'That is unusual: it suggests the peer accepted the association without ' +
        'supporting the Verification SOP Class. Run again with --verbose to see whether ' +
        'the Verification presentation context was actually accepted.'
    );
    return 1;
  }

  const described = status.describe(echoStatus, echoComment);
  if (described.class !== status.Class.SUCCESS) {
    log.error(`C-ECHO returned ${described.code} after ${elapsed} ms`);
    log.out(`${described.label}: ${described.plain}`);
    if (described.hint) log.out(`  ${described.hint}`);
    return 1;
  }

  log.out(`${log.color.green('OK')}  ${host}:${port} answered C-ECHO in ${elapsed} ms`);
  log.out(`    calling AE ${callingAe} was accepted by ${calledAe}`);
  log.out('');
  log.out(
    log.color.dim(
      'A successful echo proves connectivity and that this calling AE Title is allowed to\n' +
        'associate. It does not prove the peer will accept storage — that is negotiated\n' +
        'separately per SOP Class. Use `dcm send --dry-run` to check what would be sent.'
    )
  );
  return 0;
}

module.exports = { run, USAGE };
