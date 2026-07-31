'use strict';

/**
 * Association-level failure translation.
 *
 * Four things can stop an association, and they have completely different
 * causes and fixes:
 *
 *   rejection    the peer answered and said no, with a reason
 *   abort        one side tore the association down mid-conversation
 *   timeout      nobody said no; the peer simply stopped responding
 *   transport    the TCP connection never came up at all
 *
 * Printing a bare code for any of these sends people down the wrong path. The
 * single most common real-world failure is an A-ASSOCIATE-RJ whose reason
 * decodes to "calling AE title not recognized", which almost always means the
 * calling AE Title has not been registered on the receiving side — but as a
 * naked `reason 3` it reads like a protocol bug and people go and rewrite
 * working code.
 *
 * The reason codes are only meaningful in combination with the source. Reason
 * 3 from the service-user means the calling AE Title was not recognised;
 * reason 3 from a service-provider source is a reserved value entirely. Any
 * translation keyed on the reason alone is wrong. See DICOM PS3.8 Table 9-21.
 */

const OutcomeKind = Object.freeze({
  REJECTED: 'rejected',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
  TRANSPORT: 'transport',
});

/** A-ASSOCIATE-RJ result (PS3.8 Table 9-21). */
const RESULT = new Map([
  [1, 'permanent'],
  [2, 'transient'],
]);

/** A-ASSOCIATE-RJ source (PS3.8 Table 9-21). */
const SOURCE = new Map([
  [1, 'the peer application (DICOM UL service-user)'],
  [2, 'the peer\'s DICOM stack (service-provider, ACSE related)'],
  [3, 'the peer\'s DICOM stack (service-provider, presentation related)'],
]);

/**
 * Reject reasons, keyed by `source` then `reason`. Reason numbers repeat
 * across sources with entirely different meanings, so this table must never be
 * flattened.
 */
const REASON_BY_SOURCE = new Map([
  [
    1, // DICOM UL service-user
    new Map([
      [1, {
        label: 'No reason given',
        plain: 'The peer refused the association without saying why.',
        hint: 'Almost always an access-control rule on the receiving side. Ask the peer\'s administrator to check whether your calling AE Title, source IP and port are allowlisted, then check their logs for the matching rejection.',
      }],
      [2, {
        label: 'Application context name not supported',
        plain: 'The peer does not support the DICOM application context that was offered.',
        hint: 'Very rare against a conformant peer, since the context name is fixed by the standard. Usually means the far side is not actually a DICOM service.',
      }],
      [3, {
        label: 'Calling AE Title not recognized',
        plain: 'Calling AE Title not recognized by peer — it likely needs to be registered/allowlisted on the receiving side.',
        hint: 'This is the most common connectivity failure and it is a configuration issue, not a code issue. Give the peer\'s administrator the exact calling AE Title you are sending (--calling-ae), plus your source IP, and ask them to register it. AE Titles are case-sensitive and limited to 16 characters.',
      }],
      [7, {
        label: 'Called AE Title not recognized',
        plain: 'The peer does not answer to the called AE Title you used.',
        hint: 'You reached a real DICOM service, but asked for a name it does not have. Check --called-ae against the peer\'s documented AE Title; a host can serve several AE Titles on one port.',
      }],
    ]),
  ],
  [
    2, // service-provider, ACSE related
    new Map([
      [1, {
        label: 'No reason given',
        plain: 'The peer\'s DICOM stack refused the association without giving a reason.',
      }],
      [2, {
        label: 'Protocol version not supported',
        plain: 'The peer does not support the DICOM upper-layer protocol version that was offered.',
        hint: 'Effectively unheard of against modern systems; suspect a non-DICOM service on this port.',
      }],
    ]),
  ],
  [
    3, // service-provider, presentation related
    new Map([
      [1, {
        label: 'Temporary congestion',
        plain: 'The peer is busy and asked you to try again later.',
        hint: 'Transient by definition. Back off and retry; if it persists, the receiver is likely saturated or stuck.',
      }],
      [2, {
        label: 'Local limit exceeded',
        plain: 'The peer has hit its own limit, typically on simultaneous associations.',
        hint: 'Reduce concurrency, or send fewer, larger chunks so you open fewer associations.',
      }],
    ]),
  ],
]);

/** A-ABORT source (PS3.8 Table 9-26). */
const ABORT_SOURCE = new Map([
  [0, 'the DICOM UL service-user (the peer application deliberately aborted)'],
  [1, 'an unspecified source'],
  [2, 'the DICOM UL service-provider (the peer\'s DICOM stack aborted)'],
]);

/** A-ABORT reason (PS3.8 Table 9-26). Only meaningful when source is 2. */
const ABORT_REASON = new Map([
  [0, 'reason not specified'],
  [1, 'unrecognised PDU'],
  [2, 'unexpected PDU'],
  [4, 'unrecognised PDU parameter'],
  [5, 'unexpected PDU parameter'],
  [6, 'invalid PDU parameter'],
]);

/**
 * Translates an A-ASSOCIATE-RJ into plain English.
 *
 * @param {{result: number, source: number, reason: number}} rj
 * @returns {object}
 */
function describeRejection(rj) {
  const { result, source, reason } = rj;
  const permanence = RESULT.get(result) ?? 'unknown';
  const sourceText = SOURCE.get(source) ?? `an unknown source (${source})`;
  const info = REASON_BY_SOURCE.get(source)?.get(reason);

  const headline = info
    ? info.plain
    : `The peer rejected the association with reason code ${reason} from ${sourceText}, ` +
      `which is not a value defined for that source in DICOM PS3.8. The peer may be ` +
      `sending a non-standard code — check its own logs.`;

  return {
    kind: OutcomeKind.REJECTED,
    result,
    source,
    reason,
    permanence,
    label: info?.label ?? `Unknown reject reason ${reason} (source ${source})`,
    headline,
    hint: info?.hint,
    /** Transient rejections are worth retrying; permanent ones are not. */
    retryable: permanence === 'transient',
    raw: `A-ASSOCIATE-RJ result=${result} source=${source} reason=${reason}`,
    sourceText,
  };
}

/**
 * Translates an A-ABORT into plain English.
 *
 * An abort is not a rejection. The peer accepted the association and then tore
 * it down, which points at something going wrong during the exchange rather
 * than at access control.
 *
 * @param {{source: number, reason: number}} ab
 * @returns {object}
 */
function describeAbort(ab) {
  const { source, reason } = ab;
  const sourceText = ABORT_SOURCE.get(source) ?? `an unknown source (${source})`;
  const reasonText = ABORT_REASON.get(reason) ?? `reason code ${reason}`;

  return {
    kind: OutcomeKind.ABORTED,
    source,
    reason,
    label: 'Association aborted',
    headline:
      `The association was aborted by ${sourceText}. This is not a rejection: the peer ` +
      `had already accepted the association and then tore it down (${reasonText}).`,
    hint:
      'A mid-transfer abort usually means the receiver hit an internal error, a queue ' +
      'limit, or an instance it could not handle. Check which instances were acknowledged ' +
      'before the abort, and look at the receiver\'s logs at that timestamp.',
    retryable: true,
    raw: `A-ABORT source=${source} reason=${reason}`,
  };
}

/**
 * Describes a watchdog timeout.
 *
 * Kept deliberately distinct from a rejection. A rejection is an answer; a
 * timeout is silence. Confusing the two costs real debugging time, because a
 * rejection points at configuration and a timeout points at the network path,
 * a firewall dropping packets, or a receiver that has stopped servicing the
 * association.
 *
 * @param {{phase: string, timeoutMs: number, sent?: number, acknowledged?: number}} info
 * @returns {object}
 */
function describeTimeout(info) {
  const { phase, timeoutMs } = info;

  const byPhase = {
    connect: {
      label: 'Connection timed out',
      headline: `No TCP connection was established within ${timeoutMs} ms.`,
      hint: 'The host or port is unreachable, or a firewall is dropping the packets silently rather than refusing them. Confirm the hostname resolves and the port is open from this machine.',
    },
    association: {
      label: 'Association negotiation timed out',
      headline: `The TCP connection came up, but the peer did not complete association negotiation within ${timeoutMs} ms.`,
      hint: 'Something is listening on the port but is not answering as a DICOM service, or is too slow to respond. Confirm the port really is the peer\'s DIMSE port.',
    },
    pdu: {
      label: 'Timed out waiting for the peer',
      headline: `The peer accepted the association but stopped responding for ${timeoutMs} ms.`,
      hint: 'This is the classic mid-transfer stall: the receiver takes the association, acknowledges some instances, then goes quiet. It is not a rejection and not an access-control problem. Retrying the affected chunk often succeeds; if it recurs at the same point, the receiver is likely choking on a specific instance.',
    },
  };

  const chosen = byPhase[phase] ?? {
    label: 'Timed out',
    headline: `The operation timed out after ${timeoutMs} ms.`,
  };

  return {
    kind: OutcomeKind.TIMEOUT,
    phase,
    timeoutMs,
    label: chosen.label,
    headline: chosen.headline,
    hint: chosen.hint,
    retryable: true,
    raw: `timeout phase=${phase} after=${timeoutMs}ms`,
  };
}

/**
 * Translates a transport-level error, before DICOM is even in play.
 *
 * @param {Error & {code?: string}} error
 * @param {{host?: string, port?: number}} [target]
 * @returns {object}
 */
function describeTransportError(error, target = {}) {
  const where = target.host ? `${target.host}:${target.port}` : 'the peer';
  const byCode = {
    ECONNREFUSED: {
      label: 'Connection refused',
      headline: `Nothing is accepting connections on ${where}.`,
      hint: 'The host is reachable and actively refused the connection, so the port is almost certainly wrong or the service is not running.',
    },
    ENOTFOUND: {
      label: 'Hostname did not resolve',
      headline: `The hostname in ${where} could not be resolved by DNS.`,
      hint: 'Check spelling, and check that this machine uses a resolver that knows the name — internal names often only resolve on the internal network or over VPN.',
    },
    EHOSTUNREACH: {
      label: 'Host unreachable',
      headline: `No network route to ${where}.`,
      hint: 'Routing or VPN issue rather than a DICOM issue.',
    },
    ENETUNREACH: {
      label: 'Network unreachable',
      headline: `No network route to ${where}.`,
      hint: 'Routing or VPN issue rather than a DICOM issue.',
    },
    ETIMEDOUT: {
      label: 'Connection timed out',
      headline: `No response while opening a connection to ${where}.`,
      hint: 'Typically a firewall dropping packets silently. A refused connection would have come back immediately.',
    },
    ECONNRESET: {
      label: 'Connection reset by peer',
      headline: `${where} closed the connection abruptly.`,
      hint: 'Something terminated the TCP session — often a firewall or load balancer between you and the peer rather than the peer itself.',
    },
    EPIPE: {
      label: 'Connection closed while sending',
      headline: `The connection to ${where} closed while data was still being written.`,
      hint: 'The receiver went away mid-transfer. Treat this like a mid-stream abort.',
    },
  };

  const chosen = byCode[error.code] ?? {
    label: 'Network error',
    headline: `Could not talk to ${where}: ${error.message}`,
  };

  return {
    kind: OutcomeKind.TRANSPORT,
    code: error.code,
    label: chosen.label,
    headline: chosen.headline,
    hint: chosen.hint,
    retryable: error.code !== 'ECONNREFUSED' && error.code !== 'ENOTFOUND',
    raw: `${error.code ?? 'ERR'}: ${error.message}`,
  };
}

/**
 * Renders any outcome from this module as human-readable lines.
 *
 * @param {object} outcome
 * @returns {string[]}
 */
function formatOutcome(outcome) {
  const lines = [`${outcome.label}: ${outcome.headline}`];
  if (outcome.hint) lines.push(`  ${outcome.hint}`);
  lines.push(`  [${outcome.raw}]`);
  return lines;
}

module.exports = {
  OutcomeKind,
  describeRejection,
  describeAbort,
  describeTimeout,
  describeTransportError,
  formatOutcome,
};
