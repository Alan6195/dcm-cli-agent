'use strict';

const path = require('path');

const log = require('./log');
const statusLib = require('./status');
const { formatOutcome } = require('./reject');

/**
 * Human-readable reporting.
 *
 * The output is shaped around one idea: a transfer that lost files must never
 * look like one that did not. Three counts are printed side by side for every
 * study — found, sent, acknowledged — because a single "done" line is exactly
 * what let a lossy transfer pass unnoticed in the first place. When they do not
 * agree, the difference is stated in plain language and the run exits non-zero.
 */

const BAR = '─'.repeat(72);

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Short, readable name for a transfer syntax UID. */
const TS_NAMES = new Map([
  ['1.2.840.10008.1.2', 'Implicit VR Little Endian'],
  ['1.2.840.10008.1.2.1', 'Explicit VR Little Endian'],
  ['1.2.840.10008.1.2.1.99', 'Deflated Explicit VR Little Endian'],
  ['1.2.840.10008.1.2.2', 'Explicit VR Big Endian'],
  ['1.2.840.10008.1.2.5', 'RLE Lossless'],
  ['1.2.840.10008.1.2.4.50', 'JPEG Baseline'],
  ['1.2.840.10008.1.2.4.70', 'JPEG Lossless'],
  ['1.2.840.10008.1.2.4.80', 'JPEG-LS Lossless'],
  ['1.2.840.10008.1.2.4.81', 'JPEG-LS Lossy'],
  ['1.2.840.10008.1.2.4.90', 'JPEG 2000 Lossless'],
  ['1.2.840.10008.1.2.4.91', 'JPEG 2000'],
  ['1.2.840.10008.1.2.4.110', 'JPEG XL Lossless'],
  ['1.2.840.10008.1.2.4.112', 'JPEG XL'],
  ['1.2.840.10008.1.2.4.201', 'High-Throughput JPEG 2000 Lossless'],
  ['1.2.840.10008.1.2.4.203', 'High-Throughput JPEG 2000'],
]);

function transferSyntaxName(uid) {
  return TS_NAMES.get(uid) ? `${TS_NAMES.get(uid)}` : uid;
}

/**
 * Names a file compactly but unambiguously.
 *
 * A bare basename is not enough: `series-1/instance-3.dcm` and
 * `series-2/instance-3.dcm` both render as `instance-3.dcm`, so a list of
 * failures reads as though the same file failed twice. Including the parent
 * directory disambiguates without printing a full absolute path per line.
 */
function shortPath(filePath) {
  const parent = path.basename(path.dirname(filePath));
  return parent ? path.join(parent, path.basename(filePath)) : path.basename(filePath);
}

/** Pads a label so the three headline counts line up. */
function countLine(label, value, colorFn) {
  const padded = String(value).padStart(6);
  const text = `    ${label.padEnd(14)}${padded}`;
  return colorFn ? colorFn(text) : text;
}

/**
 * Reports what a dry run would do.
 *
 * @param {{scanned: object, chunkSize: number, rewriteSeriesUid: boolean}} params
 */
function dryRun({ scanned, chunkSize, rewriteSeriesUid }) {
  log.out('');
  log.out(BAR);
  log.out('DRY RUN — nothing was sent and no connection was opened');
  log.out(BAR);

  let totalAssociations = 0;

  for (const [studyUid, study] of scanned.studies) {
    const associations = Math.ceil(study.instances.length / chunkSize);
    totalAssociations += associations;

    log.out('');
    log.out(`Study ${studyUid}`);
    if (study.patientName || study.patientId) {
      log.out(`  patient        ${study.patientName ?? '(no name)'} / ${study.patientId ?? '(no ID)'}`);
    }
    if (study.studyDescription) log.out(`  description    ${study.studyDescription}`);
    if (study.studyDate) log.out(`  study date     ${study.studyDate}`);
    log.out(`  modalities     ${[...study.modalities].join(', ') || '(none recorded)'}`);
    log.out(`  series         ${study.series.size}`);
    log.out(`  instances      ${study.instances.length}`);
    log.out(`  size           ${bytes(study.bytes)}`);
    log.out(`  associations   ${associations} (chunk size ${chunkSize})`);
    log.out(`  transfer syntaxes:`);
    for (const ts of study.transferSyntaxes) {
      log.out(`    ${transferSyntaxName(ts)}`);
    }

    if (rewriteSeriesUid) {
      log.out(`  ${log.color.yellow('series UIDs would be rewritten:')}`);
      for (const [, series] of study.series) {
        log.out(`    ${series.seriesInstanceUid} -> (deterministic 2.25.* value)`);
      }
    }
  }

  log.out('');
  log.out(BAR);
  log.out(`Would open ${totalAssociations} association(s) and send ${scanned.candidates} instance(s).`);

  if (scanned.readErrors.length) {
    log.out('');
    log.out(log.color.red(`${scanned.readErrors.length} file(s) could not be read and would NOT be sent:`));
    for (const failure of scanned.readErrors.slice(0, 25)) {
      log.out(`  ${failure.path}`);
      log.out(`    ${failure.error}`);
    }
    if (scanned.readErrors.length > 25) {
      log.out(`  ... and ${scanned.readErrors.length - 25} more`);
    }
  }

  if (scanned.ignored.length) {
    log.out('');
    log.out(log.color.dim(`${scanned.ignored.length} non-DICOM file(s) were ignored (not counted above).`));
  }
}

/**
 * Prints the per-study accounting and the run verdict.
 *
 * @param {{result: object, connection: object, chunkSize: number, rewriteSeriesUid: boolean}} params
 */
function transfer({ result, connection, chunkSize, rewriteSeriesUid }) {
  const { studies, totals, unassignable } = result;

  log.out('');
  log.out(BAR);
  log.out('TRANSFER REPORT');
  log.out(BAR);
  // A DIMSE connection has a host/port/AE pair; a DICOMweb one is just a URL.
  // The accounting below is identical either way — that is the point of the
  // ledger — so only these header lines differ.
  if (connection.url) {
    log.out(`Server          ${connection.url} (STOW-RS)`);
  } else {
    log.out(`Peer            ${connection.host}:${connection.port} (${connection.calledAe})`);
    log.out(`Calling AE      ${connection.callingAe}`);
  }
  log.out(`Chunk size      ${chunkSize} instance(s) per ${connection.url ? 'request' : 'association'}`);
  if (rewriteSeriesUid) {
    log.out(`Series UIDs     ${log.color.yellow('REWRITTEN — sent data differs from data on disk')}`);
  }

  for (const study of studies) {
    log.out('');
    log.out(`Study ${study.studyInstanceUid}`);
    const meta = study.meta ?? {};
    if (meta.patientName || meta.patientId) {
      log.out(`  patient        ${meta.patientName ?? '(no name)'} / ${meta.patientId ?? '(no ID)'}`);
    }
    if (meta.studyDescription) log.out(`  description    ${meta.studyDescription}`);
    if (meta.modalities?.length) log.out(`  modalities     ${meta.modalities.join(', ')}`);

    // The three numbers. Kept adjacent and always printed, even when equal.
    log.out('');
    log.out(countLine('files found', study.found));
    log.out(countLine('files sent', study.sent));
    log.out(
      countLine('acknowledged', study.acknowledged,
        study.acknowledged === study.found ? log.color.green : log.color.red)
    );

    if (study.shortfall !== 0) {
      log.out('');
      log.out(
        log.color.red(
          `    SHORTFALL: ${study.shortfall} of ${study.found} file(s) were not acknowledged.`
        )
      );
    }

    // Everything that is not a plain acknowledgement, itemised.
    const breakdown = [
      ['warnings', study.warning, 'stored, but the peer changed or questioned something'],
      ['failed', study.failed, 'the peer refused the instance'],
      ['read errors', study.readError, 'could not be read from disk'],
      ['unanswered', study.unanswered, 'sent, but the peer never responded'],
      ['not attempted', study.notAttempted, 'never sent'],
    ].filter(([, count]) => count > 0);

    if (breakdown.length) {
      log.out('');
      for (const [label, count, explanation] of breakdown) {
        log.out(`    ${label.padEnd(14)}${String(count).padStart(6)}  ${log.color.dim(explanation)}`);
      }
    }

    // A transfer that only completed after retries is worth flagging even
    // when it ultimately succeeded — it says the receiver is struggling.
    if (study.retriedEntries > 0) {
      log.out('');
      log.out(
        log.color.yellow(
          `    ${study.retriedEntries} instance(s) needed retrying ` +
            `(${study.retryAttempts} retry attempt(s) in total).`
        )
      );
      log.out(
        log.color.dim(
          '    The peer refused or ignored these before finally taking them. That usually\n' +
            '    means it is under load or intermittently unhealthy — worth raising with\n' +
            '    whoever runs it, even though this run finished.'
        )
      );
    }

    // Distinct status codes seen, translated. Requirement: report the codes,
    // not just a pass/fail.
    if (study.statusCounts.size) {
      log.out('');
      log.out('    status codes returned by the peer (all attempts):');
      const sorted = [...study.statusCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [code, count] of sorted) {
        const d = statusLib.describe(code);
        const tint =
          d.class === statusLib.Class.SUCCESS ? log.color.green
            : d.class === statusLib.Class.WARNING ? log.color.yellow
              : log.color.red;
        log.out(`      ${tint(d.code)} x${String(count).padEnd(6)} ${d.label}`);
        if (d.class !== statusLib.Class.SUCCESS) {
          log.out(`        ${log.color.dim(d.plain)}`);
          if (d.hint) log.out(`        ${log.color.dim(d.hint)}`);
        }
      }
    }

    // Association-level events: rejections, aborts, timeouts.
    if (study.events.length) {
      log.out('');
      log.out(`    ${connection.url ? 'request' : 'association'} events:`);
      for (const event of study.events) {
        log.out(`      ${event.message}`);
        if (event.detail?.hint) log.out(`        ${log.color.dim(event.detail.hint)}`);
      }
    }

    // Name the files that did not make it. A count alone is not actionable.
    const lost = study.entries.filter(
      (e) => e.disposition && e.disposition !== 'acknowledged'
    );
    if (lost.length) {
      log.out('');
      log.out(`    files not acknowledged (${lost.length}):`);
      for (const entry of lost.slice(0, 20)) {
        const detail = entry.status !== undefined
          ? statusLib.summarize(entry.status, entry.detail)
          : `${entry.disposition}${entry.detail ? ` — ${entry.detail}` : ''}`;
        log.out(`      ${shortPath(entry.path)}  ${log.color.dim(detail)}`);
      }
      if (lost.length > 20) log.out(`      ... and ${lost.length - 20} more`);
    }

    // The bug this whole module exists to catch.
    if (study.unaccounted.length) {
      log.out('');
      log.out(
        log.color.red(
          `    ${study.unaccounted.length} file(s) reached the end of the run with no ` +
            `recorded outcome at all. This is a bug in this tool, not a peer problem — ` +
            `please report it.`
        )
      );
      for (const p of study.unaccounted.slice(0, 10)) log.out(`      ${p}`);
    }
  }

  if (unassignable.length) {
    log.out('');
    log.out(log.color.red(`${unassignable.length} file(s) could not be read at all and were never sent:`));
    for (const item of unassignable.slice(0, 20)) {
      log.out(`  ${item.path}`);
      log.out(`    ${log.color.dim(item.detail)}`);
    }
    if (unassignable.length > 20) log.out(`  ... and ${unassignable.length - 20} more`);
  }

  // --- Run totals ---
  log.out('');
  log.out(BAR);
  log.out(`TOTALS across ${totals.studies} stud${totals.studies === 1 ? 'y' : 'ies'}`);
  log.out(countLine('files found', totals.found));
  log.out(countLine('files sent', totals.sent));
  log.out(
    countLine('acknowledged', totals.acknowledged,
      totals.acknowledged === totals.found ? log.color.green : log.color.red)
  );
  log.out(BAR);

  if (result.ok) {
    log.out(log.color.green('OK — every file found was acknowledged by the peer.'));
    log.out('');
    // Storing is not the same as being findable.
    log.out(
      log.color.dim(
        'Note: acknowledged means the peer accepted these instances. It does not mean\n' +
          'they are queryable yet. Store-and-forward receivers routinely return zero\n' +
          'C-FIND matches for data they have accepted and not yet indexed or forwarded.\n' +
          'If you need to confirm the study is searchable, query the system that is meant\n' +
          'to hold it, and allow for its processing delay.'
      )
    );
  } else {
    log.out(
      log.color.red(
        `FAILED — ${totals.shortfall} of ${totals.found} file(s) were not acknowledged.`
      )
    );
    if (totals.unaccounted > 0) {
      log.out(
        log.color.red(
          `${totals.unaccounted} file(s) had no recorded outcome at all — please report this.`
        )
      );
    }
    log.out('');
    log.out('Exit code 1. A partial transfer is a failure, not a warning.');
  }
}

/**
 * Prints an association outcome on its own, for commands with no per-file
 * accounting to report.
 *
 * @param {object} outcome
 */
function outcome(o) {
  for (const line of formatOutcome(o)) log.out(line);
}

module.exports = { report: { dryRun, transfer, outcome }, bytes, transferSyntaxName, BAR };
