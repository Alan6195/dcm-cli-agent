'use strict';

const dcmjsDimse = require('dcmjs-dimse');
const log = require('./log');
const {
  describeRejection,
  describeAbort,
  describeTimeout,
  describeTransportError,
  OutcomeKind,
} = require('./reject');

const { Client } = dcmjsDimse;
const { constants } = dcmjsDimse;

/**
 * Association plumbing shared by every SCU command.
 *
 * The contract is narrow on purpose: run one association, and come back with a
 * single unambiguous statement of what happened to it. DICOM-level outcomes —
 * rejection, abort, timeout — are returned as data rather than thrown, because
 * they are expected results that the caller has to report on, not exceptions.
 * Only genuine programming errors reject the promise.
 *
 * Every association is watched. Two things make that necessary:
 *
 *   - A receiver can accept an association, acknowledge part of a transfer,
 *     and then simply stop answering. Without a watchdog the process hangs
 *     forever on a socket that will never produce another byte.
 *
 *   - The underlying library, on an association or PDU timeout, aborts and
 *     emits a network error. If nothing distinguishes that from an ordinary
 *     close, a stalled transfer reads as a completed one.
 *
 * Timeouts are therefore tracked by phase and reported as timeouts, never
 * folded into the rejection path. A rejection is an answer; a timeout is
 * silence. They have different causes and different fixes, so they must look
 * different on screen.
 */

/** Default watchdog timings, in milliseconds. */
/**
 * How long to wait after an association release for the socket to close, so
 * that byte statistics are final before they are reported.
 */
const RELEASE_CLOSE_GRACE_MS = 400;

const DEFAULT_TIMEOUTS = Object.freeze({
  /** TCP connect. Short: an unreachable host should fail fast. */
  connect: 15000,
  /** Association negotiation, from connect to accept/reject. */
  association: 30000,
  /**
   * Silence between PDUs once the association is up. This is the mid-transfer
   * stall detector and the most operationally important of the four.
   */
  pdu: 60000,
  /** Grace period before releasing after the last response. */
  linger: 1000,
});

/** Phases an association moves through, used to attribute a timeout. */
const Phase = Object.freeze({
  CONNECTING: 'connect',
  NEGOTIATING: 'association',
  TRANSFERRING: 'pdu',
  RELEASING: 'pdu',
});

/**
 * Builds the timeout set from user options.
 *
 * `--timeout` sets the PDU timeout, since that is the one operators actually
 * need to tune (slow receivers on large instances). The others are derived
 * unless overridden explicitly.
 *
 * @param {object} opts
 * @returns {{connect: number, association: number, pdu: number, linger: number}}
 */
function resolveTimeouts(opts = {}) {
  const pdu = opts.timeout ?? DEFAULT_TIMEOUTS.pdu;
  return {
    connect: opts.connectTimeout ?? DEFAULT_TIMEOUTS.connect,
    association: opts.associationTimeout ?? DEFAULT_TIMEOUTS.association,
    pdu,
    linger: opts.lingerTimeout ?? DEFAULT_TIMEOUTS.linger,
  };
}

/**
 * Runs a single association and reports how it ended.
 *
 * @param {object} params
 * @param {string} params.host
 * @param {number} params.port
 * @param {string} params.callingAe
 * @param {string} params.calledAe
 * @param {object[]} params.requests        Requests to send. Response handlers
 *                                          should already be attached by the caller.
 * @param {object} [params.timeouts]        From {@link resolveTimeouts}.
 * @param {function} [params.onAccepted]    Called with the negotiated Association.
 * @param {function} [params.onProgress]    Called on any inbound response, to
 *                                          feed the caller's own idle detection.
 * @param {object} [params.securityOptions] TLS options, passed through.
 * @returns {Promise<{outcome: object, association: object|undefined, statistics: object|undefined}>}
 */
function runAssociation(params) {
  const {
    host,
    port,
    callingAe,
    calledAe,
    requests,
    timeouts = resolveTimeouts(),
    onAccepted,
    onProgress,
    securityOptions,
  } = params;

  return new Promise((resolve, reject) => {
    let settled = false;
    let phase = Phase.CONNECTING;
    let association;
    let client;
    let watchdog;
    let releaseOutcome;
    let releaseTimer;
    let lastActivity = Date.now();

    /**
     * Settles exactly once. Anything arriving afterwards is noise from a
     * socket that is already being torn down.
     */
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(releaseTimer);
      let statistics;
      try {
        statistics = client?.getStatistics?.();
      } catch {
        // Statistics are decorative; never let them break the result.
      }
      resolve({ outcome, association, statistics });
    };

    /** Marks inbound activity so the idle watchdog does not fire mid-transfer. */
    const touch = () => {
      lastActivity = Date.now();
      if (onProgress) {
        try {
          onProgress();
        } catch (err) {
          log.debug(`onProgress handler threw: ${err.message}`);
        }
      }
    };

    try {
      client = new Client();

      for (const request of requests) {
        // Any response at all counts as the peer being alive.
        request.on('response', touch);
        client.addRequest(request);
      }

      client.on('connected', () => {
        log.debug(`TCP connection established to ${host}:${port}`);
        phase = Phase.NEGOTIATING;
        touch();
      });

      client.on('associationAccepted', (assoc) => {
        association = assoc;
        phase = Phase.TRANSFERRING;
        touch();
        log.debug('peer accepted the association');
        log.logAssociation(assoc, constants, 'accepted');
        if (onAccepted) {
          try {
            onAccepted(assoc);
          } catch (err) {
            log.debug(`onAccepted handler threw: ${err.message}`);
          }
        }
      });

      client.on('associationRejected', (rj) => {
        touch();
        settle(describeRejection(rj));
      });

      client.on('abort', (ab) => {
        touch();
        settle(describeAbort(ab));
      });

      client.on('associationReleased', () => {
        touch();
        releaseOutcome = {
          kind: 'completed',
          label: 'Association completed',
          headline: 'The association was released normally.',
          retryable: false,
          raw: 'A-RELEASE-RP',
        };
        // Byte statistics are only final once the socket actually closes, and
        // the close follows a release immediately. Waiting for it makes the
        // throughput figures real instead of zero. A peer that holds the
        // socket open must never stall the run, so this is a short grace
        // period, not a dependency.
        releaseTimer = setTimeout(() => settle(releaseOutcome), RELEASE_CLOSE_GRACE_MS);
      });

      client.on('networkError', (err) => {
        // The library aborts and emits a network error on its own association
        // and PDU timeouts. Attribute those as timeouts rather than transport
        // failures, so a stalled receiver never reads as a broken network.
        const message = String(err?.message ?? '');
        if (/timeout/i.test(message)) {
          const attributed = /PDU timeout/i.test(message)
            ? 'pdu'
            : /association timeout/i.test(message)
              ? 'association'
              : phase;
          settle(describeTimeout({ phase: attributed, timeoutMs: timeouts[attributed] ?? timeouts.pdu }));
          return;
        }
        settle(describeTransportError(err, { host, port }));
      });

      // The library exposes both; either can be the last thing we hear.
      const onClosed = () => {
        // The ordinary path: released, then closed. Settle with the completion
        // recorded at release, now that the statistics are final.
        if (releaseOutcome) {
          settle(releaseOutcome);
          return;
        }

        // Reaching here unsettled means the socket closed without a release,
        // a rejection, an abort or an error. Treat it as a failure rather than
        // a completion: a silent close during a transfer is exactly how a
        // partial send would otherwise pass for a clean one.
        settle({
          kind: OutcomeKind.TRANSPORT,
          label: 'Connection closed unexpectedly',
          headline:
            phase === Phase.TRANSFERRING
              ? 'The peer closed the connection mid-transfer without releasing the association.'
              : 'The connection closed before the association was established.',
          hint: 'The receiver terminated the session without saying why. Check its logs for the matching timestamp.',
          retryable: true,
          raw: `socket closed during phase=${phase}`,
        });
      };
      client.on('closed', onClosed);
      client.on('close', onClosed);

      // Independent watchdog. The library has its own timers, but relying on
      // them alone would leave the process hanging if they ever failed to fire.
      watchdog = setInterval(() => {
        if (settled) return;
        const idleMs = Date.now() - lastActivity;
        const budget =
          phase === Phase.CONNECTING
            ? timeouts.connect
            : phase === Phase.NEGOTIATING
              ? timeouts.association
              : timeouts.pdu;

        // Allow a margin so the library's own timer normally wins and can
        // abort cleanly; this is the backstop for when it does not.
        if (idleMs >= budget + 5000) {
          try {
            client.abort();
          } catch {
            // Already tearing down.
          }
          settle(describeTimeout({ phase, timeoutMs: budget }));
        }
      }, 1000);
      if (typeof watchdog.unref === 'function') watchdog.unref();

      log.debug(
        `opening association to ${host}:${port} ` +
          `(calling AE ${callingAe} -> called AE ${calledAe}, ${requests.length} request(s))`
      );
      log.debug(
        `timeouts: connect ${timeouts.connect}ms, association ${timeouts.association}ms, ` +
          `pdu ${timeouts.pdu}ms, linger ${timeouts.linger}ms`
      );

      client.send(host, port, callingAe, calledAe, {
        connectTimeout: timeouts.connect,
        associationTimeout: timeouts.association,
        pduTimeout: timeouts.pdu,
        associationLingerTimeout: timeouts.linger,
        logCommandDatasets: log.isVerbose(),
        logDatasets: false,
        ...(securityOptions ? { securityOptions } : {}),
      });
    } catch (err) {
      // A synchronous throw out of the client is a real error, not a DICOM
      // outcome, so it propagates.
      clearInterval(watchdog);
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

/**
 * True when the association ended in a way worth retrying.
 *
 * @param {object} outcome
 * @returns {boolean}
 */
function isRetryable(outcome) {
  return Boolean(outcome?.retryable);
}

/**
 * True when the association was established and released normally.
 *
 * Note that this says nothing about whether individual instances were stored.
 * A peer can complete an association cleanly while refusing every instance in
 * it, which is exactly why per-instance status codes are tracked separately.
 *
 * @param {object} outcome
 * @returns {boolean}
 */
function isCompleted(outcome) {
  return outcome?.kind === 'completed';
}

module.exports = {
  runAssociation,
  resolveTimeouts,
  isRetryable,
  isCompleted,
  DEFAULT_TIMEOUTS,
  Phase,
  constants,
  dcmjsDimse,
};
