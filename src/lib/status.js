'use strict';

/**
 * DIMSE status code classification and translation.
 *
 * A peer can accept an association and still refuse individual instances, so
 * checking that the association succeeded tells you very little. Each
 * C-STORE-RSP carries its own status, and those are what decide whether an
 * instance actually landed.
 *
 * Classification follows DICOM PS3.7 Annex C:
 *   0x0000            success
 *   0xB000 - 0xBFFF   warning  (stored, but the peer changed or questioned something)
 *   0xFF00 / 0xFF01   pending  (C-FIND/C-MOVE/C-GET only; more responses follow)
 *   0xFE00            cancel
 *   everything else   failure
 *
 * Warnings are deliberately *not* counted as success. A coerced data element
 * means the receiver rewrote your data; that is something an operator should
 * be told about rather than have folded into a green tick.
 */

const Class = Object.freeze({
  SUCCESS: 'success',
  WARNING: 'warning',
  FAILURE: 'failure',
  PENDING: 'pending',
  CANCEL: 'cancel',
});

/**
 * Exact-match status codes.
 * Sources: PS3.7 Annex C, PS3.4 Annex B.2.3 (storage service class).
 */
const EXACT = new Map([
  [0x0000, { label: 'Success', plain: 'Stored and acknowledged by the peer.' }],
  [0xfe00, { label: 'Cancel', plain: 'The operation was cancelled.' }],
  [0xff00, { label: 'Pending', plain: 'More responses are still coming.' }],
  [0xff01, { label: 'Pending (warning)', plain: 'More responses are coming; some optional keys were not supported.' }],

  // Warnings — the instance was stored, but not exactly as sent.
  [0xb000, {
    label: 'Warning: coercion of data elements',
    plain: 'Stored, but the receiver rewrote one or more data elements to fit its own rules.',
    hint: 'Commonly Patient ID, Accession Number or Patient Name being remapped. The instance is on the far side, but it no longer matches what you sent.',
  }],
  [0xb006, {
    label: 'Warning: elements discarded',
    plain: 'Stored, but the receiver dropped one or more data elements.',
    hint: 'Private tags and large non-image elements are the usual casualties.',
  }],
  [0xb007, {
    label: 'Warning: data set does not match SOP Class',
    plain: 'Stored, but the data set did not fully match the SOP Class it was sent under.',
  }],

  // Failures.
  [0x0110, { label: 'Processing failure', plain: 'The receiver hit an internal error handling the instance.' }],
  [0x0111, {
    label: 'Duplicate SOP Instance',
    plain: 'The receiver already holds an instance with this SOP Instance UID.',
    hint: 'Often benign on a re-send. If it appears on a first send, the source may be emitting colliding UIDs.',
  }],
  [0x0112, { label: 'No such object instance', plain: 'The referenced SOP Instance does not exist on the peer.' }],
  [0x0117, {
    label: 'Invalid SOP Instance UID',
    plain: 'The receiver rejected the SOP Instance UID as malformed.',
    hint: 'Check for UIDs longer than 64 characters, or containing characters other than digits and dots.',
  }],
  [0x0119, { label: 'Class/Instance conflict', plain: 'The SOP Class and SOP Instance the peer holds do not agree.' }],
  [0x0122, {
    label: 'SOP Class not supported',
    plain: 'The peer does not support this operation for this type of object.',
    // Observed against a production store-and-forward gateway: it accepted the
    // Study Root Query/Retrieve FIND presentation context during negotiation
    // and then returned 0x0122 for the query itself. A peer advertising a
    // context is not a promise that it implements the service behind it, so
    // sending people to --verbose to look for a rejected context is misleading
    // on its own — both explanations have to be offered.
    hint:
      'Two different things cause this. Either the peer never accepted a presentation ' +
      'context for this SOP Class — run with --verbose to check — or it accepted the ' +
      'context and still refuses the operation, which store-and-forward gateways do ' +
      'routinely because they take images without implementing query at all. If ' +
      '--verbose shows the context was accepted, it is the second case, and the answer ' +
      'is to query whichever system is meant to hold the data rather than the one you ' +
      'sent it to.',
  }],
  [0x0124, {
    label: 'Not authorized',
    plain: 'The receiver refused the instance on authorisation grounds.',
    hint: 'Your AE Title may be registered for association but not permitted to store this data.',
  }],
  [0x0210, { label: 'Duplicate invocation', plain: 'The message ID was reused within the association.' }],
  [0x0211, { label: 'Unrecognized operation', plain: 'The receiver did not recognise the operation requested.' }],
  [0x0212, { label: 'Mistyped argument', plain: 'An attribute was supplied with the wrong type.' }],
]);

/**
 * Range-matched status codes. DICOM encodes a family of related errors by
 * fixing the high byte and leaving the low byte free, so these must be matched
 * by range rather than exact value.
 */
const RANGES = [
  {
    lo: 0xa700, hi: 0xa7ff,
    label: 'Refused: out of resources',
    plain: 'The receiver ran out of resources and refused the instance.',
    hint: 'Usually disk space or a queue limit on the far side. Retrying later, or sending smaller chunks, often clears it.',
  },
  {
    lo: 0xa900, hi: 0xa9ff,
    label: 'Error: data set does not match SOP Class',
    plain: 'The data set contents did not match the SOP Class it was sent under.',
    hint: 'Typically a malformed or mislabelled object at the source.',
  },
  {
    lo: 0xc000, hi: 0xcfff,
    label: 'Error: cannot understand',
    plain: 'The receiver could not parse the data set.',
    hint: 'Often a transfer syntax the peer claims to accept but cannot actually decode. --verbose shows the negotiated syntax.',
  },
  {
    lo: 0xb000, hi: 0xbfff,
    label: 'Warning',
    plain: 'Stored, but the receiver flagged something about the instance.',
  },
];

/**
 * Classifies a DIMSE status code.
 *
 * @param {number} status
 * @returns {string} One of {@link Class}.
 */
function classify(status) {
  if (status === 0x0000) return Class.SUCCESS;
  if (status === 0xfe00) return Class.CANCEL;
  if (status === 0xff00 || status === 0xff01) return Class.PENDING;
  if (status >= 0xb000 && status <= 0xbfff) return Class.WARNING;
  return Class.FAILURE;
}

/**
 * Renders a status code as `0xXXXX`.
 *
 * @param {number} status
 * @returns {string}
 */
function formatCode(status) {
  return `0x${(status >>> 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Translates a status code into plain English.
 *
 * @param {number} status
 * @param {string} [errorComment] Free-text comment supplied by the peer.
 * @returns {{code: string, status: number, class: string, label: string, plain: string, hint?: string, peerComment?: string}}
 */
function describe(status, errorComment) {
  const cls = classify(status);
  let info = EXACT.get(status);

  if (!info) {
    info = RANGES.find((r) => status >= r.lo && status <= r.hi);
  }

  if (!info) {
    info = {
      label: cls === Class.WARNING ? 'Unrecognised warning' : 'Unrecognised failure',
      plain:
        `The peer returned status ${formatCode(status)}, which is not a code this tool ` +
        `has a translation for. It is being treated as a ${cls}.`,
      hint: 'Check the receiving system\'s own logs — vendors do define private status codes.',
    };
  }

  const out = {
    code: formatCode(status),
    status,
    class: cls,
    label: info.label,
    plain: info.plain,
  };
  if (info.hint) out.hint = info.hint;
  if (errorComment) out.peerComment = errorComment;
  return out;
}

/**
 * Formats a one-line summary suitable for a report table.
 *
 * @param {number} status
 * @param {string} [errorComment]
 * @returns {string}
 */
function summarize(status, errorComment) {
  const d = describe(status, errorComment);
  const comment = d.peerComment ? ` (peer said: ${d.peerComment})` : '';
  return `${d.code} ${d.label}${comment}`;
}

module.exports = { Class, classify, describe, summarize, formatCode };
