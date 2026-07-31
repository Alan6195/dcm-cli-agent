'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const { dcmjsDimse } = require('../lib/dimse');

const { Server, Scp } = dcmjsDimse;
const { CEchoResponse, CFindResponse, CStoreResponse } = dcmjsDimse.responses;
const {
  Status,
  PresentationContextResult,
  RejectResult,
  RejectSource,
  RejectReason,
  TransferSyntax,
} = dcmjsDimse.constants;

const FLAGS = ['port', 'ae', 'persist', 'accept-calling-ae', 'reject-after'];

const USAGE = `
dcm scp — a permissive DICOM receiver that logs everything

Runs a store-and-echo receiver on the given port. It accepts every SOP Class
and transfer syntax offered, so it is useful as a loopback target for testing a
sender, and as a way to see exactly what a system is emitting.

Usage:
  dcm scp --port <port> [--ae <AE>] [--persist <dir>]

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
  --reject-after <n>         Stop acknowledging after n instances in an
                             association, to simulate a receiver that goes
                             quiet mid-transfer. Testing aid.
  --verbose                  Log full association negotiation for every peer.

Example:
  dcm scp --port 11112 --ae TEST-SCP --persist ./received
`.trimStart();

/** UIDs are digits and dots; anything else must not reach the filesystem. */
function safeUidSegment(uid, fallback) {
  if (typeof uid !== 'string' || uid.length === 0) return fallback;
  const cleaned = uid.replace(/[^0-9.]/g, '');
  // Reject traversal-ish and empty results outright rather than repairing them.
  if (cleaned === '' || cleaned === '.' || cleaned === '..' || cleaned.length > 64) {
    return fallback;
  }
  return cleaned;
}

/**
 * Builds the Scp subclass. The configuration is closed over rather than passed
 * through `customOptions`, which keeps it typed and avoids threading state
 * through the library's option bag.
 *
 * @param {object} config
 * @param {object} stats Mutable counters shared across connections.
 */
function makeScpClass(config, stats) {
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

      // Permissive: accept every proposed abstract syntax. Prefer an
      // uncompressed transfer syntax when one is offered, because those are
      // always decodable; otherwise take what is on the table.
      const preferred = [TransferSyntax.ExplicitVRLittleEndian, TransferSyntax.ImplicitVRLittleEndian];

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

  if (persist) {
    fs.mkdirSync(persist, { recursive: true });
  }

  const stats = {
    associations: 0, rejected: 0, echoes: 0, stored: 0,
    finds: 0, refused: 0, aborts: 0, errors: 0,
  };

  const config = { ae, acceptCallingAe, persist, rejectAfter };
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
      log.out(`  aborts                : ${stats.aborts}`);
      log.out(`  errors                : ${stats.errors}`);
      if (persist) log.out(`  written to            : ${persist}`);
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
      log.info('  press Ctrl+C to stop');
    });

    server.listen(port, {
      logCommandDatasets: log.isVerbose(),
      logDatasets: false,
    });
  });
}

module.exports = { run, USAGE, makeScpClass };
