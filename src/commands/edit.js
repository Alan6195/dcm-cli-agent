'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const tagLib = require('../lib/tags');
const { scan } = require('../lib/scan');
const { dcmjsDimse } = require('../lib/dimse');
const { BAR } = require('../lib/report');

const { Dataset } = dcmjsDimse;

const FLAGS = ['set', 'remove', 'out', 'in-place', 'dry-run', 'no-recurse', 'force'];

const USAGE = `
dcm edit — change or remove DICOM tags and write the result

Usage:
  dcm edit <file|folder> --set Keyword=Value [--set ...] [--remove Keyword ...] --out <dir>
  dcm edit <file|folder> --set Keyword=Value --in-place

Options:
  --set <Key=Value>  Set a tag. Repeatable. The key may be a keyword
                     (PatientID), a punctuated tag ((0010,0020)) or a bare hex
                     tag (00100020).
  --remove <Key>     Remove a tag. Repeatable.
  --out <dir>        Write modified copies here, mirroring the source layout.
                     The source is not touched.
  --in-place         Overwrite the source files. Destructive and irreversible.
  --dry-run          Show what would change without writing anything.
  --force            Allow editing UIDs and other structural identifiers.
  --no-recurse       Only look at files directly in the folder.

You must choose either --out or --in-place. There is no default, because the
difference between writing a copy and overwriting a study is not something to
get wrong by omission.

Editing UIDs is refused unless you pass --force. Study, Series and SOP Instance
UIDs are what tie a study together and what receivers use to recognise it; a
partial rewrite splits a study or collides with an existing one. If you want new
UIDs across a whole study, "dcm anon" remaps them consistently.

Examples:
  dcm edit ./study --set PatientID=TEST001 --out ./edited
  dcm edit ./study --set "PatientName=DOE^JANE" --set StudyDescription=CHEST --out ./edited
  dcm edit ./study --remove AccessionNumber --remove InstitutionName --out ./edited
  dcm edit ./study --set PatientID=TEST001 --dry-run --out ./edited
`.trimStart();

/**
 * Elements that hold the study together. Editing one of these across part of a
 * study silently breaks the relationships a receiver relies on, so it needs an
 * explicit --force rather than being available by accident.
 */
const STRUCTURAL = new Set([
  'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'SOPClassUID',
  'FrameOfReferenceUID', 'MediaStorageSOPInstanceUID', 'MediaStorageSOPClassUID',
  'TransferSyntaxUID', 'ImplementationClassUID',
]);

/** VRs whose values are binary numbers rather than numeric strings. */
const NUMERIC_VRS = new Set(['US', 'SS', 'UL', 'SL', 'FL', 'FD']);

/** Normalises a flag that may arrive as a single value or an array. */
function asArray(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  if (value === true) return [];
  return [String(value)];
}

/**
 * Parses `--set Key=Value` into a resolved edit.
 *
 * @param {string} raw
 * @returns {{key: string, tag: string, vr: string, keyword: string, value: *}}
 */
function parseSet(raw) {
  const eq = raw.indexOf('=');
  if (eq < 1) {
    throw new args.UsageError(`--set expects Keyword=Value, got "${raw}".`);
  }
  const reference = raw.slice(0, eq).trim();
  const rawValue = raw.slice(eq + 1);

  const resolved = tagLib.resolveReference(reference);
  if (!resolved) {
    throw new args.UsageError(
      `"${reference}" is not a DICOM keyword or tag. Use a keyword (PatientID), ` +
        'a punctuated tag ((0010,0020)) or a bare hex tag (00100020).'
    );
  }

  let value = rawValue;
  if (NUMERIC_VRS.has(resolved.vr)) {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      throw new args.UsageError(
        `${resolved.keyword} has VR ${resolved.vr}, which is numeric, but "${rawValue}" is not a number.`
      );
    }
    value = n;
  }

  return { ...resolved, value };
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags, positionals } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const target = positionals[0];
  if (!target) {
    throw new args.UsageError('Missing file or folder. Usage: dcm edit <file|folder> --set Key=Value --out <dir>');
  }

  const sets = asArray(flags.get('set')).map(parseSet);
  const removes = asArray(flags.get('remove')).map((reference) => {
    const resolved = tagLib.resolveReference(reference);
    if (!resolved) {
      throw new args.UsageError(`"${reference}" is not a DICOM keyword or tag.`);
    }
    return resolved;
  });

  if (sets.length === 0 && removes.length === 0) {
    throw new args.UsageError('Nothing to do. Pass at least one --set or --remove.');
  }

  const inPlace = args.resolve(flags, { name: 'in-place', type: 'boolean', fallback: false });
  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });
  const force = args.resolve(flags, { name: 'force', type: 'boolean', fallback: false });
  const outRaw = args.resolve(flags, { name: 'out' });
  const recurse = !flags.has('no-recurse');

  // Writing a copy and overwriting a study are too different to pick by default.
  if (!inPlace && !outRaw) {
    throw new args.UsageError(
      'Choose where the result goes: --out <dir> to write copies, or --in-place to overwrite the source.'
    );
  }
  if (inPlace && outRaw) {
    throw new args.UsageError('--in-place and --out are mutually exclusive.');
  }

  // Guard the identifiers that hold a study together.
  const structural = [...sets, ...removes].filter((e) => STRUCTURAL.has(e.key));
  if (structural.length && !force) {
    log.error(
      `Refusing to edit ${structural.map((e) => e.keyword).join(', ')} without --force.`
    );
    log.error('');
    log.error('These identifiers are what tie a study together and what receivers use to');
    log.error('recognise it. Changing them on some instances and not others splits a study,');
    log.error('and reusing a UID that already exists elsewhere collides with it.');
    log.error('');
    log.error('If you want fresh UIDs across a whole study, "dcm anon" remaps them');
    log.error('consistently and keeps the relationships intact. If you really mean to do');
    log.error('this, re-run with --force.');
    return 2;
  }

  const source = path.resolve(target);
  const sourceRoot = fs.statSync(source).isDirectory() ? source : path.dirname(source);
  const out = outRaw ? path.resolve(outRaw) : undefined;

  if (out) {
    const relative = path.relative(sourceRoot, out);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new args.UsageError(
        `--out (${out}) is inside the source folder. Choose a destination outside it.`
      );
    }
  }

  const scanned = scan(target, { recurse });
  const found = scanned.candidates - scanned.readErrors.length;
  if (found === 0) {
    log.error(`No readable DICOM instances found at ${source}.`);
    return 1;
  }

  log.out('');
  log.out(BAR);
  log.out(dryRun ? 'EDIT — DRY RUN, nothing will be written' : 'EDIT');
  log.out(BAR);
  log.out(`source        ${source}`);
  log.out(`destination   ${inPlace ? log.color.red('IN PLACE — the source will be overwritten') : out}`);
  log.out(`instances     ${found}`);
  for (const edit of sets) {
    log.out(`  set     ${log.color.dim(edit.tag)} ${edit.keyword} = ${JSON.stringify(edit.value)}`);
  }
  for (const edit of removes) {
    log.out(`  remove  ${log.color.dim(edit.tag)} ${edit.keyword}`);
  }
  if (structural.length) {
    log.out('');
    log.warn(`--force is set: editing structural identifiers (${structural.map((e) => e.keyword).join(', ')}).`);
  }

  const totals = { found, changed: 0, unchanged: 0, written: 0, failed: 0 };
  const failures = [];
  const changeCounts = new Map();

  for (const study of scanned.studies.values()) {
    for (const instance of study.instances) {
      let dataset;
      try {
        // The whole dataset is needed: the pixel data has to be carried over.
        dataset = Dataset.fromFile(instance.path);
        if (!dataset) throw new Error('parser returned no dataset');
      } catch (err) {
        totals.failed += 1;
        failures.push({ path: instance.path, error: err.message });
        continue;
      }

      const elements = dataset.getElements();
      let touched = false;

      for (const edit of sets) {
        const before = elements[edit.key];
        elements[edit.key] = edit.value;
        if (JSON.stringify(before) !== JSON.stringify(edit.value)) {
          touched = true;
          changeCounts.set(`set ${edit.keyword}`, (changeCounts.get(`set ${edit.keyword}`) ?? 0) + 1);
        }
      }

      for (const edit of removes) {
        if (elements[edit.key] !== undefined) {
          delete elements[edit.key];
          touched = true;
          changeCounts.set(`remove ${edit.keyword}`, (changeCounts.get(`remove ${edit.keyword}`) ?? 0) + 1);
        }
      }

      if (!touched) {
        totals.unchanged += 1;
        continue;
      }
      totals.changed += 1;

      if (dryRun) continue;

      const destination = inPlace
        ? instance.path
        : path.join(out, path.relative(sourceRoot, instance.path));

      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });

        if (inPlace) {
          // Write beside the original and rename over it, so an interrupted
          // write cannot leave a truncated file where a valid study used to be.
          const staging = `${destination}.dcm-edit-${process.pid}.tmp`;
          await new Promise((resolve, reject) => {
            dataset.toFile(staging, (err) => (err ? reject(err) : resolve()));
          });
          fs.renameSync(staging, destination);
        } else {
          await new Promise((resolve, reject) => {
            dataset.toFile(destination, (err) => (err ? reject(err) : resolve()));
          });
        }

        totals.written += 1;
        log.debug(`wrote ${destination}`);
      } catch (err) {
        totals.failed += 1;
        failures.push({ path: instance.path, error: `write failed: ${err.message}` });
      }
    }
  }

  log.out('');
  log.out(BAR);
  log.out(`instances found     ${totals.found}`);
  log.out(`would change        ${totals.changed}`);
  log.out(`already correct     ${totals.unchanged}`);
  if (!dryRun) log.out(`written             ${totals.written}`);
  log.out(`failed              ${totals.failed}`);

  if (changeCounts.size) {
    log.out('');
    log.out('changes:');
    for (const [what, count] of changeCounts) {
      log.out(`  ${what.padEnd(40)} ${count} instance(s)`);
    }
  }

  if (scanned.readErrors.length) {
    log.out('');
    log.out(log.color.red(`${scanned.readErrors.length} source file(s) were unreadable and were not edited:`));
    for (const failure of scanned.readErrors.slice(0, 10)) {
      log.out(`  ${failure.path} — ${log.color.dim(failure.error)}`);
    }
  }

  if (failures.length) {
    log.out('');
    log.out(log.color.red(`${failures.length} instance(s) failed:`));
    for (const failure of failures.slice(0, 20)) {
      log.out(`  ${failure.path}`);
      log.out(`    ${log.color.dim(failure.error)}`);
    }
  }

  log.out('');
  if (dryRun) {
    log.out('DRY RUN — nothing was written.');
    return 0;
  }

  const ok = totals.failed === 0 && scanned.readErrors.length === 0 && totals.written === totals.changed;
  log.out(
    ok
      ? log.color.green(`OK — ${totals.written} instance(s) written.`)
      : log.color.red('FAILED — not every instance was written.')
  );
  return ok ? 0 : 1;
}

module.exports = { run, USAGE, parseSet, STRUCTURAL };
