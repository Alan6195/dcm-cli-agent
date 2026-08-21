'use strict';

const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const json = require('../lib/json');
const { scan } = require('../lib/scan');
const { bytes, transferSyntaxName, BAR } = require('../lib/report');

const FLAGS = [
  'recurse', 'no-recurse', 'series', 'chunk',
  'expect-count', 'expect-empty', 'expect-nonempty',
];

const USAGE = `
dcm info — inventory a folder or file

Reads DICOM metadata only (stopping before the pixel data), so it is fast and
memory-light even on large trees. Reports what is there, how it is grouped, and
anything that would prevent it being sent.

Usage:
  dcm info <folder|file> [options]

Options:
  --series        Break the output down to series level.
  --no-recurse    Only look at files directly in the folder.
  --chunk <n>     Show how many associations a send would use. Default: 200.
  --json          Emit the inventory as one JSON result envelope.

  --expect-count <n>   Assert the folder holds exactly n DICOM instances.
  --expect-empty       Assert it holds none.
  --expect-nonempty    Assert it holds at least one.
                       With one of these the exit code answers that question:
                       0 when the expectation held, 1 when it did not.

Examples:
  dcm info ./study
  dcm info ./studies --series
  dcm info ./study --json
  dcm info ./out --expect-count 12
`.trimStart();

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags } = parsed;

  if (flags.has('help')) return json.help('info', flags, USAGE);

  return json.guard('info', flags, () => execute(parsed));
}

async function execute(parsed) {
  const { flags, positionals } = parsed;

  args.rejectUnknown(flags, FLAGS);

  const declared = json.readExpectation(flags, args);

  const target = positionals[0];
  if (!target) {
    throw new args.UsageError('Missing folder or file. Usage: dcm info <folder|file>');
  }

  const recurse = !flags.has('no-recurse');
  const showSeries = flags.has('series');
  const asJson = flags.has('json');
  const chunkSize = args.resolve(flags, { name: 'chunk', type: 'number', fallback: 200 });

  const resolved = path.resolve(target);
  log.info(`scanning ${resolved}${recurse ? '' : ' (not recursing)'}`);

  const scanned = scan(target, {
    recurse,
    onProgress: (done, total) => log.debug(`examined ${done}/${total} files`),
  });

  // The inventory is what this command counts, so it is what an expectation is
  // judged against. Computed before any output so the JSON and prose paths
  // cannot drift.
  const instanceCount = scanned.candidates - scanned.readErrors.length;
  const expectation = json.evaluateExpectation(declared, instanceCount);
  const outcome = scanned.studies.size === 0
    ? json.Outcome.EMPTY
    : (scanned.readErrors.length ? json.Outcome.ERROR : json.Outcome.OK);
  const exitCode = json.resolveExitCode({
    outcome, expectation, gateFailed: scanned.readErrors.length > 0,
  });
  if (expectation) log.info(json.describeExpectation(expectation));

  if (asJson) {
    const payload = {
      path: resolved,
      filesExamined: scanned.filesExamined,
      dicomInstances: instanceCount,
      unreadable: scanned.readErrors.length,
      ignored: scanned.ignored.length,
      totalBytes: scanned.totalBytes,
      studies: [...scanned.studies.values()].map((study) => ({
        studyInstanceUid: study.studyInstanceUid,
        patientId: study.patientId,
        studyDate: study.studyDate,
        studyDescription: study.studyDescription,
        accessionNumber: study.accessionNumber,
        modalities: [...study.modalities],
        transferSyntaxes: [...study.transferSyntaxes],
        sopClasses: [...study.sopClasses],
        seriesCount: study.series.size,
        instanceCount: study.instances.length,
        bytes: study.bytes,
        associationsAtChunkSize: Math.ceil(study.instances.length / chunkSize),
        series: [...study.series.values()].map((series) => ({
          seriesInstanceUid: series.seriesInstanceUid,
          seriesNumber: series.seriesNumber,
          seriesDescription: series.seriesDescription,
          modality: series.modality,
          instanceCount: series.instances.length,
          bytes: series.bytes,
        })),
      })),
      readErrors: scanned.readErrors,
    };
    return json.result({
      command: 'info',
      outcome,
      exitCode,
      expectation,
      message: messageFor(outcome, instanceCount, scanned, expectation),
      ...(scanned.readErrors.length
        ? {
          detail: {
            kind: 'error',
            label: 'Unreadable files',
            headline: `${scanned.readErrors.length} file(s) in this tree could not be read, ` +
              'so the inventory is incomplete and those instances would not be sent.',
            retryable: false,
            raw: `unreadable=${scanned.readErrors.length}`,
          },
        }
        : {}),
      payload,
    });
  }

  log.out('');
  log.out(BAR);
  log.out(`INVENTORY — ${resolved}`);
  log.out(BAR);
  log.out(`files examined      ${scanned.filesExamined}`);
  log.out(`DICOM instances     ${instanceCount}`);
  log.out(`studies             ${scanned.studies.size}`);
  log.out(`total size          ${bytes(scanned.totalBytes)}`);
  if (scanned.ignored.length) {
    log.out(`non-DICOM ignored   ${scanned.ignored.length}`);
  }
  if (scanned.readErrors.length) {
    log.out(log.color.red(`unreadable          ${scanned.readErrors.length}`));
  }

  if (scanned.studies.size === 0) {
    log.out('');
    log.out('No DICOM instances found.');
    if (scanned.ignored.length) {
      log.out('');
      log.out('Files that were skipped and why:');
      for (const item of scanned.ignored.slice(0, 15)) {
        log.out(`  ${path.basename(item.path)} — ${log.color.dim(item.reason)}`);
      }
      if (scanned.ignored.length > 15) {
        log.out(`  ... and ${scanned.ignored.length - 15} more`);
      }
    }
    return exitCode;
  }

  // Modality roll-up across the whole tree.
  const modalityCounts = new Map();
  for (const study of scanned.studies.values()) {
    for (const instance of study.instances) {
      const m = instance.modality ?? '(none)';
      modalityCounts.set(m, (modalityCounts.get(m) ?? 0) + 1);
    }
  }
  log.out('');
  log.out('modalities:');
  for (const [modality, count] of [...modalityCounts].sort((a, b) => b[1] - a[1])) {
    log.out(`  ${String(modality).padEnd(10)} ${String(count).padStart(7)} instance(s)`);
  }

  // Transfer syntaxes matter for sending: a peer that will not accept a
  // compressed syntax refuses the instance even though the association is fine.
  const tsCounts = new Map();
  for (const study of scanned.studies.values()) {
    for (const instance of study.instances) {
      const ts = instance.transferSyntaxUid ?? '(unknown)';
      tsCounts.set(ts, (tsCounts.get(ts) ?? 0) + 1);
    }
  }
  log.out('');
  log.out('transfer syntaxes:');
  for (const [ts, count] of [...tsCounts].sort((a, b) => b[1] - a[1])) {
    log.out(`  ${transferSyntaxName(ts).padEnd(38)} ${String(count).padStart(7)} instance(s)`);
    log.out(`  ${log.color.dim(ts)}`);
  }

  log.out('');
  log.out(BAR);

  let index = 0;
  for (const study of scanned.studies.values()) {
    index += 1;
    const associations = Math.ceil(study.instances.length / chunkSize);

    log.out('');
    log.out(`Study ${index}/${scanned.studies.size}  ${log.color.bold(study.studyInstanceUid)}`);
    if (study.patientId) log.out(`  patient ID     ${study.patientId}`);
    if (study.studyDate) log.out(`  study date     ${study.studyDate}`);
    if (study.studyDescription) log.out(`  description    ${study.studyDescription}`);
    if (study.accessionNumber) log.out(`  accession      ${study.accessionNumber}`);
    log.out(`  modalities     ${[...study.modalities].join(', ') || '(none recorded)'}`);
    log.out(`  series         ${study.series.size}`);
    log.out(`  instances      ${study.instances.length}`);
    log.out(`  size           ${bytes(study.bytes)}`);
    log.out(`  would send in  ${associations} association(s) at --chunk ${chunkSize}`);

    if (showSeries) {
      log.out('');
      const sorted = [...study.series.values()].sort(
        (a, b) => Number(a.seriesNumber ?? 0) - Number(b.seriesNumber ?? 0)
      );
      for (const series of sorted) {
        const number = series.seriesNumber ?? '?';
        log.out(
          `    series ${String(number).padStart(3)}  ` +
            `${String(series.modality ?? '??').padEnd(4)} ` +
            `${String(series.instances.length).padStart(5)} inst  ` +
            `${bytes(series.bytes).padStart(9)}  ` +
            `${series.seriesDescription ?? ''}`
        );
        log.out(`      ${log.color.dim(series.seriesInstanceUid ?? '(no SeriesInstanceUID)')}`);
      }

      // Colliding series UIDs are the reason --rewrite-series-uid exists, so
      // surface them here rather than letting a receiver silently merge stacks.
      //
      // This has to look at instances rather than at the grouped series: the
      // scanner keys series by Series Instance UID, so two colliding series
      // have already been folded into a single group by the time we get here.
      // Comparing groups could never detect the collision.
      const uidToDescriptions = new Map();
      for (const instance of study.instances) {
        const key = instance.seriesInstanceUid;
        if (!key) continue;
        if (!uidToDescriptions.has(key)) uidToDescriptions.set(key, new Set());
        uidToDescriptions
          .get(key)
          .add(`${instance.modality ?? '??'}/${instance.seriesDescription ?? ''}/${instance.seriesNumber ?? ''}`);
      }
      for (const [uid, descriptions] of uidToDescriptions) {
        if (descriptions.size > 1) {
          log.out('');
          log.out(
            log.color.yellow(
              `    Series UID ${uid} is shared by ${descriptions.size} distinct series.`
            )
          );
          log.out(
            log.color.dim(
              '    A receiver will merge these into one stack. `dcm send --rewrite-series-uid`\n' +
                '    assigns each a deterministic replacement UID to keep them separate.'
            )
          );
        }
      }
    }
  }

  if (scanned.readErrors.length) {
    log.out('');
    log.out(log.color.red(`${scanned.readErrors.length} file(s) could not be read:`));
    for (const failure of scanned.readErrors.slice(0, 20)) {
      log.out(`  ${failure.path}`);
      log.out(`    ${log.color.dim(failure.error)}`);
    }
    if (scanned.readErrors.length > 20) {
      log.out(`  ... and ${scanned.readErrors.length - 20} more`);
    }
    log.out('');
    log.out('These would not be sent.');
    return exitCode;
  }

  return exitCode;
}

/**
 * The one-sentence `message`. Prose, so nothing should assert on it — the
 * outcome and the expectation verdict are what a test reads.
 */
function messageFor(outcome, instanceCount, scanned, expectation) {
  if (expectation && !expectation.held) return json.describeExpectation(expectation);
  if (outcome === json.Outcome.EMPTY) {
    return `No DICOM instances found; ${scanned.filesExamined} file(s) were examined.`;
  }
  if (outcome === json.Outcome.ERROR) {
    return `${instanceCount} instance(s) inventoried, ${scanned.readErrors.length} unreadable.`;
  }
  return `${instanceCount} instance(s) across ${scanned.studies.size} study(ies).`;
}

module.exports = { run, USAGE };
