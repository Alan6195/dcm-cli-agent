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

A study's patient name, patient ID, description and accession number are each
reported only when every instance in it agrees. When they do not, the value is
withheld and all the distinct ones are listed — naming one of two patients
found under a single Study Instance UID would hide the defect rather than
report it. An instance carrying no value at all is an absence rather than a
competing answer, so it never creates a disagreement. Under --json each of the
four is a string or null, beside a plural array holding every distinct value
found; a disagreement is not a failure, so the exit code stays 0.

A patient name is reported as the file holds it. A name written in more than
one script is a single DICOM value whose component groups are separated by "="
— Yamada^Tarou=<kanji>=<kana> — and the whole value is what is printed and what
--json carries, because it is also what you would paste back into a
"dcm edit --set PatientName=...". Printing only the romaji would hand you a
value that deletes the rest of the name on write. Almost every name has one
group and reads exactly as it always did.

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

/** Column geometry shared by the identity lines and their continuations. */
const LABEL_WIDTH = 15;
const INDENT = ' '.repeat(2 + LABEL_WIDTH);

/**
 * What to tell an operator about each kind of disagreement.
 *
 * These are not one defect wearing four hats, so they do not get one line of
 * advice. Two patient names, or two patient IDs, under a single Study Instance
 * UID is a safety problem: an archive files every instance under one patient
 * record, so one of the two patients is about to absorb the other's images.
 * Two descriptions is usually cosmetic — the same exam labelled twice — and
 * the repair is a rename, not a recall. Two accession numbers is the most
 * often benign of the four: an order corrected after acquisition began, or one
 * acquisition filling two orders, both of which happen in working departments
 * and neither of which loses an image. Advice pitched at the worst case would
 * cry wolf three times out of four, and an operator who learns to skip the
 * yellow paragraph will skip it on the day it means a mis-filed patient.
 */
const CONFLICT_ADVICE = Object.freeze({
  PatientName: [
    'One Study Instance UID cannot belong to two patients. An archive will file',
    'every instance under one record, so repair this before sending:',
    '`dcm tags <folder> --filter PatientName` shows which files carry which name.',
  ],
  PatientID: [
    'This is the key an archive files the patient record under, so sending as it',
    'stands puts some of these instances on the wrong patient. Repair it first:',
    '`dcm tags <folder> --filter PatientID` shows which files carry which ID.',
  ],
  StudyDescription: [
    'Nothing routes on the description, so the transfer itself is unaffected — the',
    'study will simply show up under whichever one the archive keeps. Worth',
    'settling if the two describe genuinely different exams, which would mean this',
    'folder holds two studies sharing a UID: `dcm info --series` shows the split.',
  ],
  AccessionNumber: [
    'Often benign: an order corrected after acquisition began, or one acquisition',
    'filling two orders. No image is lost either way, but the archive files the',
    'study under a single accession and the other order will look unfilled. Ask',
    'the RIS which order this study answers before sending.',
  ],
});

/**
 * Prints one identity line, in whichever of the three states its field is in.
 *
 * A disagreement always prints, and prints loudly, whatever the field. This
 * report is what an operator reads to learn what a study currently says, and
 * presenting one instance's answer as the study's answer is the one thing it
 * must not do.
 *
 * Absence keeps the quieter, older rule. The patient name says so in words,
 * because it is the line an operator looks for and a line that is simply
 * missing cannot be told apart from a tool that never looked; for the other
 * three an absent line is unremarkable, and `--json` carries the distinction
 * for anything that needs it.
 *
 * @param {{label: string, element: string, value?: string,
 *          values: Set<string>, plural: string, absent?: string}} spec
 */
function identityLine({ label, element, value, values, plural, absent }) {
  if (values.size > 1) {
    log.out(log.color.yellow(
      `  ${label.padEnd(LABEL_WIDTH)}${values.size} DIFFERENT ${plural} across this study's instances`
    ));
    for (const one of values) log.out(log.color.yellow(`${INDENT}  ${one}`));
    log.out(log.color.dim(CONFLICT_ADVICE[element].map((line) => `${INDENT}${line}`).join('\n')));
    return;
  }
  if (value) {
    log.out(`  ${label.padEnd(LABEL_WIDTH)}${value}`);
    return;
  }
  if (absent) log.out(`  ${label.padEnd(LABEL_WIDTH)}${log.color.dim(absent)}`);
}

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
        // The four identity fields, each as the same pair of keys: always
        // present, always these two shapes, so a consumer never has to branch
        // on a missing key. The singular is a string or null; the plural is an
        // array of every distinct value found, in first-seen order, which says
        // which of the two reasons a null has — empty for "no instance carries
        // one", two or more entries for "they disagree". A single-entry plural
        // beside a non-null singular is the ordinary case. See the grouping
        // comment in lib/scan.js.
        //
        // patientName is the complete Person Name, component groups and all.
        // Two instances whose names differ only in a group a Latin reader
        // cannot see — same romaji, different kanji — are therefore two names
        // and raise a conflict. That is deliberate. This pair is what the
        // desktop Rename tab prefills from and writes back to every instance,
        // so calling them one name would let it choose one instance's kanji
        // and overwrite the other's without ever having shown either. A
        // disagreement no one can see is the worst kind to resolve silently.
        patientName: study.patientName ?? null,
        patientNames: [...study.patientNames],
        patientId: study.patientId ?? null,
        patientIds: [...study.patientIds],
        studyDescription: study.studyDescription ?? null,
        studyDescriptions: [...study.studyDescriptions],
        accessionNumber: study.accessionNumber ?? null,
        accessionNumbers: [...study.accessionNumbers],
        studyDate: study.studyDate,
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
    // The four fields the scan reaches agreement on before reporting. Each is
    // a value, an absence, or a disagreement, and identityLine renders all
    // three without either of the last two being able to pass for the other.
    identityLine({
      label: 'patient', element: 'PatientName', plural: 'NAMES',
      value: study.patientName, values: study.patientNames,
      absent: '(no PatientName in any instance)',
    });
    identityLine({
      label: 'patient ID', element: 'PatientID', plural: 'PATIENT IDS',
      value: study.patientId, values: study.patientIds,
    });
    if (study.studyDate) log.out(`  study date     ${study.studyDate}`);
    identityLine({
      label: 'description', element: 'StudyDescription', plural: 'DESCRIPTIONS',
      value: study.studyDescription, values: study.studyDescriptions,
    });
    identityLine({
      label: 'accession', element: 'AccessionNumber', plural: 'ACCESSION NUMBERS',
      value: study.accessionNumber, values: study.accessionNumbers,
    });
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
