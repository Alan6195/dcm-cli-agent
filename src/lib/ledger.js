'use strict';

/**
 * Transfer accounting.
 *
 * This module exists because of one specific class of bug: a transfer that
 * loses files but prints as a clean success. The canonical shape is
 * `Promise.allSettled(...)` whose rejected entries are never inspected, so
 * 823 files found becomes 822 instances stored and nobody notices.
 *
 * The defence here is structural rather than disciplinary. Every file that is
 * discovered on disk is registered as a `FileEntry`, and every entry must end
 * the run holding exactly one terminal disposition. Reconciliation counts the
 * dispositions and compares that total against the number of files found. An
 * entry that somehow escaped every code path holds no disposition, lands in
 * `unaccounted`, and turns the run into a failure. You cannot drop a file
 * quietly, because dropping it means nobody set its disposition, and that is
 * precisely what reconciliation looks for.
 *
 * The three numbers the CLI reports per study come straight off this ledger:
 *   found        - candidate files discovered on disk
 *   sent         - files read and dispatched as a C-STORE request
 *   acknowledged - instances the peer positively acknowledged (status 0x0000)
 *
 * They are deliberately three separate counters. Collapsing them is how the
 * information that a transfer was lossy gets lost.
 */

/** Terminal dispositions. Exactly one is held by each entry at the end of a run. */
const Disposition = Object.freeze({
  /** Peer returned status 0x0000 for this instance. The only success. */
  ACKNOWLEDGED: 'acknowledged',
  /** Peer returned a warning status (0xB000-0xBFFF). Stored, but with caveats. */
  WARNING: 'warning',
  /** Peer returned a failure status, or refused the instance. */
  FAILED: 'failed',
  /** The file could not be read or parsed, so it was never dispatched. */
  READ_ERROR: 'read-error',
  /** Dispatched, but the association ended before any response arrived. */
  UNANSWERED: 'unanswered',
  /** Never dispatched: dry run, association rejected, chunk aborted first. */
  NOT_ATTEMPTED: 'not-attempted',
});

const TERMINAL = new Set(Object.values(Disposition));

/** Dispositions that a retry is allowed to attempt again. */
const RETRYABLE = new Set([
  Disposition.UNANSWERED,
  Disposition.FAILED,
  Disposition.NOT_ATTEMPTED,
]);

/**
 * One discovered file, tracked from disk through to the peer's response.
 */
class FileEntry {
  /**
   * @param {object} info
   * @param {string} info.path            Absolute path on disk.
   * @param {number} [info.bytes]         File size in bytes.
   * @param {string} [info.sopInstanceUid]
   * @param {string} [info.sopClassUid]
   * @param {string} [info.seriesInstanceUid]
   * @param {string} [info.transferSyntaxUid]
   */
  constructor(info) {
    this.path = info.path;
    this.bytes = info.bytes ?? 0;
    this.sopInstanceUid = info.sopInstanceUid;
    this.sopClassUid = info.sopClassUid;
    this.seriesInstanceUid = info.seriesInstanceUid;
    this.transferSyntaxUid = info.transferSyntaxUid;

    /** @type {string|undefined} Current terminal disposition, if any. */
    this.disposition = undefined;
    /** @type {number|undefined} DIMSE status code from the peer, when one arrived. */
    this.status = undefined;
    /** @type {string|undefined} Peer error comment or local error message. */
    this.detail = undefined;
    /** True once a C-STORE request for this entry was actually dispatched. */
    this.dispatched = false;
    /** Prior dispositions, one per superseded attempt. Retries append here. */
    this.attempts = [];
  }

  /**
   * Records a terminal disposition.
   *
   * Setting a disposition twice without an intervening `resetForRetry()` is a
   * programming error, not a runtime condition: it means two code paths both
   * believe they own this file's outcome, and one of them is wrong. Throwing
   * here surfaces the double-accounting immediately instead of letting the
   * totals silently disagree with reality.
   *
   * @param {string} disposition
   * @param {{status?: number, detail?: string}} [extra]
   */
  settle(disposition, extra = {}) {
    if (!TERMINAL.has(disposition)) {
      throw new Error(`Unknown disposition: ${disposition}`);
    }
    if (this.disposition !== undefined) {
      throw new Error(
        `Double-settle for ${this.path}: already ${this.disposition}, ` +
          `refusing to overwrite with ${disposition}. This is a bug in the ` +
          `send pipeline — two paths are claiming the same file.`
      );
    }
    this.disposition = disposition;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.detail !== undefined) this.detail = extra.detail;
    return this;
  }

  /** True when this entry holds a terminal disposition. */
  get settled() {
    return this.disposition !== undefined;
  }

  /** True when this entry may be re-attempted by a retry pass. */
  get retryable() {
    return this.settled && RETRYABLE.has(this.disposition);
  }

  /**
   * Clears the current disposition so the entry can be dispatched again,
   * preserving what happened on the previous attempt.
   */
  resetForRetry() {
    if (!this.settled) {
      throw new Error(`resetForRetry on unsettled entry: ${this.path}`);
    }
    this.attempts.push({
      disposition: this.disposition,
      status: this.status,
      detail: this.detail,
    });
    this.disposition = undefined;
    this.status = undefined;
    this.detail = undefined;
    this.dispatched = false;
    return this;
  }
}

/**
 * Per-study accounting. A study is the unit the CLI reports on, because that
 * is the unit a human cares about when a transfer goes wrong.
 */
class StudyLedger {
  /**
   * @param {string} studyInstanceUid
   * @param {object} [meta] Descriptive fields for reporting only.
   */
  constructor(studyInstanceUid, meta = {}) {
    this.studyInstanceUid = studyInstanceUid;
    this.meta = meta;
    /** @type {FileEntry[]} */
    this.entries = [];
    /** Association-level events that affected this study (rejections, timeouts, aborts). */
    this.events = [];
  }

  /**
   * Registers a discovered file. Every file the scanner finds must be
   * registered here, including ones that fail to parse — a file that is never
   * registered is a file that can never be counted as missing.
   *
   * @param {object} info See {@link FileEntry}.
   * @returns {FileEntry}
   */
  addFile(info) {
    const entry = new FileEntry(info);
    this.entries.push(entry);
    return entry;
  }

  /**
   * Records an association-level event. These explain *why* a batch of entries
   * ended up unanswered or not attempted, and are surfaced alongside the counts.
   *
   * @param {{kind: string, message: string, detail?: object}} event
   */
  addEvent(event) {
    this.events.push(event);
    return this;
  }

  /** Entries that may be re-attempted by a retry pass. */
  retryableEntries() {
    return this.entries.filter((e) => e.retryable);
  }

  /**
   * Settles every entry that still has no disposition.
   *
   * Called when an association ends, so that "dispatched but never answered"
   * and "never got a turn" become explicit outcomes rather than absences.
   * This is what converts a silent drop into a counted one.
   *
   * @param {string} reason Human-readable cause, attached as detail.
   */
  settleOutstanding(reason) {
    let closed = 0;
    for (const entry of this.entries) {
      if (entry.settled) continue;
      entry.settle(
        entry.dispatched ? Disposition.UNANSWERED : Disposition.NOT_ATTEMPTED,
        { detail: reason }
      );
      closed += 1;
    }
    return closed;
  }

  /**
   * Counts every entry by disposition and checks the totals add up.
   *
   * @returns {object} A reconciliation report. `ok` is true only when every
   *   file found was acknowledged by the peer — warnings, failures, read
   *   errors, unanswered and unaccounted entries all make it false.
   */
  reconcile() {
    const counts = {
      acknowledged: 0,
      warning: 0,
      failed: 0,
      readError: 0,
      unanswered: 0,
      notAttempted: 0,
    };
    const byDisposition = {
      [Disposition.ACKNOWLEDGED]: 'acknowledged',
      [Disposition.WARNING]: 'warning',
      [Disposition.FAILED]: 'failed',
      [Disposition.READ_ERROR]: 'readError',
      [Disposition.UNANSWERED]: 'unanswered',
      [Disposition.NOT_ATTEMPTED]: 'notAttempted',
    };

    /** @type {FileEntry[]} Entries holding no disposition at all. */
    const unaccounted = [];
    let sent = 0;

    for (const entry of this.entries) {
      if (entry.dispatched) sent += 1;
      if (!entry.settled) {
        unaccounted.push(entry);
        continue;
      }
      counts[byDisposition[entry.disposition]] += 1;
    }

    const found = this.entries.length;
    const accounted =
      counts.acknowledged +
      counts.warning +
      counts.failed +
      counts.readError +
      counts.unanswered +
      counts.notAttempted;

    // Distinct status codes the peer used, across every attempt.
    //
    // Superseded attempts are counted too. An instance that was refused twice
    // and then acknowledged is a materially different situation from one that
    // succeeded immediately: it says the receiver is unhealthy. Counting only
    // the final status would make a transfer that needed three attempts look
    // identical to one that worked first time, and throw away the signal.
    const statusCounts = new Map();
    const bump = (status) => {
      if (status === undefined) return;
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    };
    let retriedEntries = 0;
    let retryAttempts = 0;
    for (const entry of this.entries) {
      bump(entry.status);
      for (const attempt of entry.attempts) bump(attempt.status);
      if (entry.attempts.length > 0) {
        retriedEntries += 1;
        retryAttempts += entry.attempts.length;
      }
    }

    const shortfall = found - counts.acknowledged;

    return {
      studyInstanceUid: this.studyInstanceUid,
      meta: this.meta,
      found,
      sent,
      acknowledged: counts.acknowledged,
      warning: counts.warning,
      failed: counts.failed,
      readError: counts.readError,
      unanswered: counts.unanswered,
      notAttempted: counts.notAttempted,
      /** Files found minus files acknowledged. Non-zero means the transfer was lossy. */
      shortfall,
      /** Entries that escaped every code path. Non-empty means a pipeline bug. */
      unaccounted: unaccounted.map((e) => e.path),
      /** Sum of all dispositions; must equal `found`. */
      accounted,
      statusCounts,
      /** Instances that needed at least one retry, and total retries spent. */
      retriedEntries,
      retryAttempts,
      events: this.events,
      /** True only when every file found was acknowledged. */
      ok: shortfall === 0 && unaccounted.length === 0,
      entries: this.entries,
    };
  }
}

/**
 * Whole-run accounting across every study in a folder tree.
 */
class TransferLedger {
  constructor() {
    /** @type {Map<string, StudyLedger>} */
    this.studies = new Map();
    /** Files the scanner rejected before a study could be determined. */
    this.unassignable = [];
  }

  /**
   * @param {string} studyInstanceUid
   * @param {object} [meta]
   * @returns {StudyLedger}
   */
  study(studyInstanceUid, meta) {
    let ledger = this.studies.get(studyInstanceUid);
    if (!ledger) {
      ledger = new StudyLedger(studyInstanceUid, meta);
      this.studies.set(studyInstanceUid, ledger);
    } else if (meta) {
      Object.assign(ledger.meta, meta);
    }
    return ledger;
  }

  /**
   * Records a file that could not even be attributed to a study — typically
   * unreadable or not DICOM at all. These still count toward files found so
   * that the top-line totals match what is on disk.
   *
   * @param {string} filePath
   * @param {Error|string} error
   */
  addUnassignable(filePath, error) {
    this.unassignable.push({
      path: filePath,
      detail: error instanceof Error ? error.message : String(error),
    });
    return this;
  }

  /**
   * Rolls every study up into a single verdict for the process exit code.
   *
   * @returns {object}
   */
  reconcile() {
    const studies = [...this.studies.values()].map((s) => s.reconcile());

    const totals = {
      studies: studies.length,
      found: this.unassignable.length,
      sent: 0,
      acknowledged: 0,
      warning: 0,
      failed: 0,
      readError: this.unassignable.length,
      unanswered: 0,
      notAttempted: 0,
      unaccounted: 0,
      retriedEntries: 0,
      retryAttempts: 0,
    };

    for (const s of studies) {
      totals.retriedEntries += s.retriedEntries;
      totals.retryAttempts += s.retryAttempts;
      totals.found += s.found;
      totals.sent += s.sent;
      totals.acknowledged += s.acknowledged;
      totals.warning += s.warning;
      totals.failed += s.failed;
      totals.readError += s.readError;
      totals.unanswered += s.unanswered;
      totals.notAttempted += s.notAttempted;
      totals.unaccounted += s.unaccounted.length;
    }

    totals.shortfall = totals.found - totals.acknowledged;

    return {
      studies,
      unassignable: this.unassignable,
      totals,
      ok: totals.shortfall === 0 && totals.unaccounted === 0,
    };
  }
}

module.exports = {
  Disposition,
  FileEntry,
  StudyLedger,
  TransferLedger,
};
