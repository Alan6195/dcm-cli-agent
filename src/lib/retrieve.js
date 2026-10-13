'use strict';

const { formatCode } = require('./status');

/**
 * The one place that decides whether a retrieve succeeded.
 *
 * Both `dcm get` and `dcm move` end the same way: the peer hands back a final
 * DIMSE status and a set of sub-operation counts, and — when the instances were
 * coming to this machine — a number of files now exist on disk. Those are two
 * independent claims about the same transfer, and the whole reason this module
 * exists is that they can disagree.
 *
 * A retrieve is the mirror image of a send, and it fails in the mirror-image
 * way. `dcm send` guards against a receiver that accepts an association and
 * acknowledges fewer instances than were offered. A retrieve has to guard
 * against a peer that reports it completed 5215 sub-operations while 5200
 * files landed. In both directions the dangerous outcome is not an error — it
 * is a success status over a short count, because that is the one that gets
 * believed.
 *
 * So the rule enforced here is: the peer's own accounting is evidence, never
 * the verdict. The verdict is the smaller of what the peer claims and what can
 * be proved, and any gap between them is a failure with the gap named.
 *
 * This matters most on exactly the studies where it is hardest to notice. A
 * ten-instance test retrieve that loses one is obvious. A five-thousand-image
 * CT that loses fifteen looks completely normal in a progress log, and the
 * only thing standing between that and a radiologist reading an incomplete
 * study is this comparison.
 */

/** Final statuses a retrieve can end on (PS3.4 C.4.2.1.5, C.4.3.1.4). */
const RetrieveStatus = Object.freeze({
  SUCCESS: 0x0000,
  CANCEL: 0xfe00,
  /** Warning: sub-operations complete, one or more failures. */
  SUBOPS_FAILED: 0xb000,
  /** Failure: out of resources, unable to calculate number of matches. */
  OUT_OF_RESOURCES_MATCHES: 0xa701,
  /** Failure: out of resources, unable to perform sub-operations. */
  OUT_OF_RESOURCES_SUBOPS: 0xa702,
  /** Failure: Move Destination unknown. C-MOVE only. */
  MOVE_DESTINATION_UNKNOWN: 0xa801,
  /** Failure: identifier does not match SOP Class. */
  IDENTIFIER_MISMATCH: 0xa900,
  /** The peer negotiated the service and then refused to perform it. */
  PROCESSING_FAILURE: 0x0110,
  /** The peer does not implement the SOP Class it just accepted. */
  SOP_CLASS_NOT_SUPPORTED: 0x0122,
});

/**
 * `0xA801`, for a status in a message.
 *
 * Delegates to status.formatCode so a status prints the same way here as it
 * does from `dcm send` or `dcm find`. Two spellings of one code in a single run
 * of `dcm move` — one from this module, one from status.js — meant neither
 * could be grepped for reliably.
 */
function hex(status) {
  if (status === undefined || status === null) return '(none)';
  return formatCode(status);
}

/** True when a status lies in the band whose high byte is `high`. */
function inBand(status, high) {
  return status !== undefined && (status & 0xff00) === high;
}

/**
 * True for a status that says the peer refused the retrieve outright.
 *
 * The C-xxxx range is reserved for a peer's own failure reasons, so anything in
 * it is a refusal even when this build has never heard of the specific code.
 */
function isRefusal(status) {
  if (status === undefined) return false;
  if (status >= 0xc000 && status <= 0xcfff) return true;
  // Out of resources and identifier mismatch are BANDS: the standard fixes the
  // high byte and products vary the low one. Matched by range, as status.js
  // matches them for C-STORE, so 0xA700 is a refusal here exactly as it is there.
  if (inBand(status, 0xa700) || inBand(status, 0xa900)) return true;
  return [
    RetrieveStatus.MOVE_DESTINATION_UNKNOWN,
    RetrieveStatus.PROCESSING_FAILURE,
    RetrieveStatus.SOP_CLASS_NOT_SUPPORTED,
  ].includes(status);
}

/**
 * Explains a final retrieve status, and names the fix.
 *
 * `service` is 'get' or 'move'; a few statuses mean different things depending
 * on which one asked, and the fix for "this peer cannot do it" is to try the
 * other service, so the message has to know which one it is in.
 *
 * @param {number|undefined} status
 * @param {{service: 'get'|'move', destinationAe?: string, callingAe?: string}} ctx
 * @returns {{headline: string, hint?: string}|undefined} Undefined when the
 *          status needs no explaining (a plain success).
 */
function explainStatus(status, ctx = {}) {
  const { service, destinationAe, callingAe } = ctx;
  const other = service === 'get' ? 'dcm move' : 'dcm get';

  switch (status) {
    case RetrieveStatus.SUCCESS:
    case undefined:
      return undefined;

    case RetrieveStatus.CANCEL:
      return {
        headline: 'The retrieve was cancelled before the peer finished sending.',
        hint:
          'Whatever arrived before the cancel is on disk and is counted above, ' +
          'but the study is incomplete. Run it again to finish it.',
      };

    case RetrieveStatus.SUBOPS_FAILED:
      return {
        headline:
          'The peer finished the retrieve and reports that one or more instances failed ' +
          `(${hex(status)}, "sub-operations complete — one or more failures").`,
        hint:
          'This is a WARNING status in the standard and a failure here: part of the study ' +
          'did not come back. The per-instance reason is in the peer\'s own log at this ' +
          'timestamp — it is not carried in this response.',
      };

    case RetrieveStatus.OUT_OF_RESOURCES_MATCHES:
      return {
        headline: `The peer ran out of resources working out what to send (${hex(status)}).`,
        hint: 'Narrow the request to one series at a time and retry.',
      };

    case RetrieveStatus.OUT_OF_RESOURCES_SUBOPS:
      return {
        headline: `The peer ran out of resources part way through sending (${hex(status)}).`,
        hint:
          'Commonly a per-association instance cap or a full spool directory on the ' +
          'archive. Retrieve one series at a time, or ask for the cap to be raised.',
      };

    case RetrieveStatus.MOVE_DESTINATION_UNKNOWN:
      return {
        headline:
          `The peer does not know where to send the images (${hex(status)}, ` +
          `"Move Destination unknown")${destinationAe ? `: it has no AE Title "${destinationAe}"` : ''}.`,
        hint:
          'C-MOVE does not carry a host and port — it carries only an AE Title, which the ' +
          'PEER must already resolve to an address it can reach. This is a configuration ' +
          'change on the archive, not something this tool can send. Either have ' +
          `${destinationAe ? `"${destinationAe}"` : 'the destination AE Title'} registered ` +
          'there against this machine\'s address and listening port, or use `dcm get`, ' +
          'which needs nothing configured on the peer because the images come back down ' +
          'the association you already opened.',
      };

    case RetrieveStatus.IDENTIFIER_MISMATCH:
      return {
        headline: `The peer rejected the identifier as wrong for this SOP Class (${hex(status)}).`,
        hint:
          'The retrieve level and the UIDs given do not agree — e.g. an instance-level ' +
          'request without its series UID. Check --study/--series/--instance.',
      };

    case RetrieveStatus.SOP_CLASS_NOT_SUPPORTED:
      return {
        headline:
          `This peer does not implement the service it accepted (${hex(status)}, ` +
          '"SOP Class not supported").',
        hint:
          'Accepting a presentation context is not a promise to implement the service ' +
          `behind it. Use ${other} instead.`,
      };

    case RetrieveStatus.PROCESSING_FAILURE:
      return {
        headline: `The peer accepted the request and then failed to process it (${hex(status)}).`,
        hint:
          'In practice this is what an archive that negotiates the context but has no ' +
          `implementation behind it returns. Try ${other}. If that also fails, the peer ` +
          'likely offers no DIMSE retrieve at all and the study has to be pushed from it.',
      };

    default:
      // The rest of each band. 0xA701 and 0xA702 have their own sentences
      // above; any other low byte is still "out of resources" and still has
      // the same fix, and the same goes for the identifier-mismatch band.
      if (inBand(status, 0xa700)) {
        return {
          headline: `The peer ran out of resources and refused the retrieve (${hex(status)}).`,
          hint: 'Narrow the request to one series at a time and retry.',
        };
      }
      if (inBand(status, 0xa900)) {
        return {
          headline: `The peer rejected the identifier as wrong for this SOP Class (${hex(status)}).`,
          hint:
            'The retrieve level and the UIDs given do not agree. Check ' +
            '--study/--series/--instance.',
        };
      }
      if (isRefusal(status)) {
        return {
          headline: `The peer refused the retrieve with ${hex(status)}.`,
          hint:
            'A C-xxxx status is the peer\'s own failure reason; its meaning is defined by ' +
            'that product, so the explanation is in its log at this timestamp.',
        };
      }
      return {
        headline: `The peer ended the retrieve with an unexpected status, ${hex(status)}.`,
        hint: 'Re-run with --verbose to get the full association and command-set trace.',
      };
  }
}

/**
 * Decides whether a retrieve succeeded, and says why not.
 *
 * `expectLocalFiles` is the pivot. A C-GET, and a C-MOVE aimed at a receiver
 * this command is running itself, both end with files on this disk, and those
 * files are checkable. A C-MOVE to a third-party destination AE does not: the
 * images went somewhere else entirely and the only thing this process can
 * honestly report is what the peer said about them. Comparing a disk count to
 * a reported count in that case would fail every successful third-party move,
 * so the comparison is switched off and the output says so rather than
 * implying a verification that did not happen.
 *
 * @param {object} params
 * @param {number|undefined} params.finalStatus  The peer's final DIMSE status.
 * @param {{completed: number, failures: number, warnings: number, remaining: number|undefined, counted: boolean}} params.reported
 *        What the peer claims. `counted` is false when the peer sent no
 *        sub-operation counts at all, which is legal and must not be read as zero.
 * @param {{written: number, unreadable: number, duplicates: number}} params.tally
 *        What this process can prove. Ignored when expectLocalFiles is false.
 * @param {number} [params.refused]  Sub-operations this process answered with a failure.
 * @param {boolean} params.expectLocalFiles
 * @returns {{ok: boolean, problems: string[], shortfall: number}}
 */
function verdict(params) {
  const {
    finalStatus,
    reported,
    tally = { written: 0, unreadable: 0, duplicates: 0 },
    refused = 0,
    expectLocalFiles,
  } = params;

  const problems = [];

  // A final status that is not Success is decisive on its own, and explainStatus
  // has already been given the job of saying what it means. Recorded here as a
  // problem so the caller never has to re-derive "did the status fail".
  if (finalStatus !== undefined && finalStatus !== RetrieveStatus.SUCCESS) {
    problems.push(`the peer's final status was ${hex(finalStatus)}`);
  }

  // The peer's own failure count. A peer can report failures and still end on
  // Success — some do — so this is checked independently of the status.
  if (reported.failures > 0) {
    problems.push(`the peer reports ${reported.failures} sub-operation(s) failed`);
  }

  // Sub-operations this end answered as failures. Checked outside the
  // local-files branch on purpose: an admitted loss is a loss wherever the
  // images were headed, and letting it depend on expectLocalFiles is exactly the
  // shape — evidence that never reaches the verdict — this module exists to stop.
  if (refused > 0) {
    problems.push(`${refused} sub-operation(s) were answered as failures by this end`);
  }

  let shortfall = 0;

  if (expectLocalFiles) {
    // Our own losses: an instance that arrived and could not be stored is lost
    // just as surely as one the peer never sent.
    if (tally.unreadable > 0) {
      problems.push(`${tally.unreadable} arriving instance(s) could not be written`);
    }
    if (tally.duplicates > 0) {
      problems.push(
        `${tally.duplicates} instance(s) arrived twice under one SOP Instance UID`
      );
    }
    // THE COMPARISON. The peer says it completed N sub-operations; N files had
    // better exist. Only meaningful when the peer actually sent counts.
    if (reported.counted && reported.completed > tally.written) {
      shortfall = reported.completed - tally.written;
      problems.push(
        `the peer reports ${reported.completed} instance(s) sent but ${tally.written} ` +
          `are on disk — ${shortfall} missing`
      );
    }

    // Nothing at all arrived. Distinct from a shortfall and worth its own line,
    // because the cause is different: a study UID that matched nothing, or a
    // peer that holds it and will not release it to this calling AE Title.
    if (tally.written === 0) {
      problems.push('no instances arrived');
    }
  } else if (reported.counted && reported.completed === 0) {
    // A third-party move that moved nothing. There is no disk to check, so the
    // peer's own zero is the only evidence available — and it is enough.
    problems.push('the peer reports it sent no instances');
  }

  return { ok: problems.length === 0, problems, shortfall };
}

/**
 * Accumulates what the peer says across the response stream.
 *
 * Kept as a factory rather than inlined in both commands so the "a count the
 * peer omitted is not a zero" rule lives in one place. The library returns
 * undefined for an absent count; defaulting that to 0 would silently turn "the
 * peer told us nothing" into "the peer told us none", and the second of those
 * would make the disk comparison above pass vacuously.
 */
function makeReportedCounts() {
  const state = {
    completed: 0,
    failures: 0,
    warnings: 0,
    remaining: undefined,
    counted: false,
  };

  return {
    state,
    /** Folds one response's counts in, keeping the last value the peer gave. */
    absorb(response) {
      const completed = response.getCompleted?.();
      const failures = response.getFailures?.();
      const warnings = response.getWarnings?.();
      const remaining = response.getRemaining?.();

      if (completed !== undefined) {
        state.completed = completed;
        state.counted = true;
      }
      if (failures !== undefined) {
        state.failures = failures;
        state.counted = true;
      }
      if (warnings !== undefined) {
        state.warnings = warnings;
        state.counted = true;
      }
      if (remaining !== undefined) state.remaining = remaining;
      return state;
    },
  };
}

module.exports = {
  RetrieveStatus,
  hex,
  isRefusal,
  explainStatus,
  verdict,
  makeReportedCounts,
};
