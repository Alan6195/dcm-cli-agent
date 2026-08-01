'use strict';

const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const tagLib = require('../lib/tags');
const { scan, readMetadata } = require('../lib/scan');
const { dcmjsDimse } = require('../lib/dimse');
const { BAR } = require('../lib/report');

const { Dataset } = dcmjsDimse;

const FLAGS = ['all', 'filter', 'private', 'depth', 'no-recurse', 'limit', 'value'];

const USAGE = `
dcm tags — dump the DICOM tags in a file or folder

Reads metadata only, so it is fast even on large trees, and never prints pixel
data — bulk binary elements are reported by size instead.

Usage:
  dcm tags <file|folder> [options]

Options:
  --all             Dump every file in the folder. Default: one representative
                    file per series, which is usually what you want and keeps
                    the output readable.
  --filter <text>   Only show tags whose keyword, tag number or value matches.
                    Case-insensitive substring, or /regex/ for a pattern.
  --value <text>    Only show tags whose VALUE matches. Useful for finding which
                    files still carry an identifier.
  --private         Only show private and unrecognised tags — the ones that
                    usually survive de-identification.
  --depth <n>       How far to walk into sequences. Default: 2.
  --limit <n>       Stop after n files.
  --no-recurse      Only look at files directly in the folder.
  --json            Emit as JSON.

Examples:
  dcm tags ./study/instance-1.dcm
  dcm tags ./study --filter Patient
  dcm tags ./study --value "DOE^JANE"
  dcm tags ./study --private
  dcm tags ./study/instance-1.dcm --json
`.trimStart();

/** Builds a matcher from a --filter or --value argument. */
function makeMatcher(pattern) {
  if (!pattern) return undefined;
  const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (asRegex) {
    const re = new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`);
    return (text) => re.test(text);
  }
  const needle = pattern.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

/**
 * Chooses which files to dump.
 *
 * A folder can hold thousands of instances that differ only in pixel data and
 * instance number, so dumping all of them by default buries the information
 * rather than revealing it. One per series is the useful default.
 */
function chooseFiles(scanned, { all, limit }) {
  const chosen = [];

  for (const study of scanned.studies.values()) {
    if (all) {
      for (const instance of study.instances) chosen.push(instance);
    } else {
      for (const series of study.series.values()) {
        if (series.instances.length) chosen.push(series.instances[0]);
      }
    }
  }

  chosen.sort((a, b) => a.path.localeCompare(b.path));
  return limit ? chosen.slice(0, limit) : chosen;
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
    throw new args.UsageError('Missing file or folder. Usage: dcm tags <file|folder>');
  }

  const all = args.resolve(flags, { name: 'all', type: 'boolean', fallback: false });
  const privateOnly = args.resolve(flags, { name: 'private', type: 'boolean', fallback: false });
  const depth = args.resolve(flags, { name: 'depth', type: 'number', fallback: 2 });
  const limit = args.resolve(flags, { name: 'limit', type: 'number' });
  const recurse = !flags.has('no-recurse');
  const asJson = flags.has('json');

  const filterMatch = makeMatcher(args.resolve(flags, { name: 'filter' }));
  const valueMatch = makeMatcher(args.resolve(flags, { name: 'value' }));

  const scanned = scan(target, { recurse });
  if (scanned.candidates - scanned.readErrors.length === 0) {
    log.error(`No readable DICOM instances found at ${path.resolve(target)}.`);
    for (const failure of scanned.readErrors.slice(0, 5)) {
      log.error(`  ${failure.path}: ${failure.error}`);
    }
    return 1;
  }

  const files = chooseFiles(scanned, { all, limit });
  const results = [];
  let shown = 0;
  let matched = 0;

  for (const instance of files) {
    let elements;
    try {
      // Metadata only. Pixel data is never needed here and reading it would
      // make dumping a large folder needlessly expensive.
      const dataset = Dataset.fromFile(instance.path, undefined, {
        untilTag: '7FE00010',
        includeUntilTagValue: false,
      });
      elements = dataset.getElements();
    } catch (err) {
      log.error(`${instance.path}: ${err.message}`);
      continue;
    }

    let rows = tagLib.flatten(elements, { depth });

    if (privateOnly) rows = rows.filter((r) => r.private);
    if (filterMatch) {
      rows = rows.filter((r) => filterMatch(`${r.keyword} ${r.tag} ${r.value}`));
    }
    if (valueMatch) rows = rows.filter((r) => valueMatch(r.value));

    if (rows.length === 0) continue;
    matched += 1;

    if (asJson) {
      results.push({
        path: instance.path,
        studyInstanceUid: instance.studyInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        sopInstanceUid: instance.sopInstanceUid,
        tags: rows.map((r) => ({
          tag: r.tag, vr: r.vr, keyword: r.keyword, value: r.value, private: r.private,
        })),
      });
      shown += rows.length;
      continue;
    }

    log.out('');
    log.out(BAR);
    log.out(path.resolve(instance.path));
    if (instance.modality || instance.seriesDescription) {
      log.out(log.color.dim(
        `${instance.modality ?? ''} ${instance.seriesDescription ?? ''}`.trim()
      ));
    }
    log.out(BAR);

    for (const row of rows) {
      const indent = '  '.repeat(row.level);
      if (!row.tag) {
        // Sequence item marker.
        log.out(`${indent}${log.color.dim(row.keyword)}`);
        continue;
      }
      const keyword = row.private ? log.color.yellow(row.keyword) : row.keyword;
      log.out(
        `${indent}${log.color.dim(row.tag)} ${row.vr.padEnd(2)} ` +
          `${keyword.padEnd(Math.max(0, 34 - indent.length))} ${row.value}`
      );
      shown += 1;
    }
  }

  if (asJson) {
    log.out(JSON.stringify({ files: results.length, tags: shown, results }, null, 2));
    return results.length > 0 ? 0 : 1;
  }

  log.out('');
  log.out(BAR);
  log.out(`${shown} tag(s) across ${matched} file(s).`);
  if (!all && files.length < scanned.candidates - scanned.readErrors.length) {
    log.out(
      log.color.dim(
        `Showing one file per series. ${scanned.candidates - scanned.readErrors.length} ` +
          `instance(s) were found in total — pass --all to dump every one.`
      )
    );
  }
  if ((filterMatch || valueMatch || privateOnly) && matched === 0) {
    log.out(log.color.yellow('Nothing matched.'));
    return 1;
  }

  return shown > 0 ? 0 : 1;
}

module.exports = { run, USAGE, makeMatcher, chooseFiles };
