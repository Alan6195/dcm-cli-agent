'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('../../src/lib/log');
const { tokenize } = require('../../src/lib/args');
const { scan } = require('../../src/lib/scan');
const finish = require('../../src/commands/mpps/finish');
const perform = require('../../src/commands/mpps/perform');
const dispatcher = require('../../src/commands/mpps');
const { generate } = require('../../tools/make-fixtures');

/**
 * Closing a step — `dcm mpps complete` and `dcm mpps discontinue`.
 *
 * Two properties are under test, and both are about the same thing: what a
 * closed step is allowed to claim.
 *
 * One performed procedure step describes one study. `perform` has always
 * refused a folder holding two; the standalone close scanned the same folder
 * and quietly built a PerformedSeriesSequence spanning both, which is worse
 * than a refusal because the N-SET succeeds and a reader totalling
 * ReferencedImageSequence gets a count the step's own scheduled attributes
 * contradict.
 *
 * And a performed series built from a folder scan asserts what is on disk
 * rather than what the archive holds, so it has to say so — including under
 * --dry-run, which is the run where someone is actually reading the dataset.
 *
 * Nothing here opens a socket. Every test stops at --dry-run or earlier.
 */

// --- helpers ---------------------------------------------------------------

const tempDirs = [];

/** A temp directory removed when the process exits. */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcm-mpps-finish-${label}-`));
  tempDirs.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** An MPPS SOP Instance UID shaped like the one `dcm mpps start` prints. */
const STEP_UID = '2.25.31415926535897932384626433832795028841';

/**
 * Writes a fixture tree holding `studies` studies, two series each.
 *
 * @param {number} studies
 * @param {string} label
 * @returns {Promise<{dir: string, manifest: object}>}
 */
async function fixtureTree(studies, label) {
  const dir = path.join(tempDir(label), 'tree');
  const manifest = await generate({
    outDir: dir,
    studies,
    seriesPerStudy: 2,
    instancesPerSeries: 2,
    quiet: true,
  });
  return { dir, manifest };
}

/** Flags as the CLI would resolve them. */
function flagsOf(argv) {
  return tokenize(argv).flags;
}

/** Runs fn, asserts it threw a UsageError, and hands the error back. */
function throwsUsage(fn) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'UsageError', `expected a UsageError, got ${err.stack}`);
    return err;
  }
  assert.fail('expected a UsageError, nothing was thrown');
}

/** The async form: the verbs are async, so their refusals arrive as rejections. */
async function rejectsUsage(fn) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.name, 'UsageError', `expected a UsageError, got ${err.stack}`);
    return err;
  }
  assert.fail('expected a UsageError, nothing was thrown');
}

/** Runs a command through the mpps dispatcher with stdout and stderr captured. */
async function runCaptured(argv) {
  const sink = log.beginCapture();
  let code;
  let error;
  try {
    code = await dispatcher.run(tokenize(argv));
  } catch (err) {
    error = err;
  } finally {
    log.endCapture();
  }
  return { code, error, out: sink.out, err: sink.err };
}

// --- one step, one study ---------------------------------------------------

test('a folder holding two studies is refused by complete, in perform\'s words', async () => {
  const { dir } = await fixtureTree(2, 'two-a');

  // The wording is taken from the guard `perform` uses on the same scan, so
  // the assertion fails if the two paths ever drift into two accounts of the
  // same rule rather than one.
  const performRefusal = throwsUsage(
    () => perform.assertOneStudy(scan(dir, { recurse: true }), dir, '')
  ).message;

  const err = await rejectsUsage(
    () => dispatcher.run(tokenize(['complete', STEP_UID, '--series-from', dir, '--dry-run']))
  );

  assert.ok(
    err.message.startsWith(performRefusal),
    `close refused in different words than perform:\n${err.message}`
  );
  assert.match(err.message, /holds 2 studies/);
  assert.match(err.message, /exactly one/);
  assert.match(err.message, /attribute half these images to the wrong order/);

  // And it points at the way out that this verb actually has.
  assert.match(err.message, /--study-uid <uid>/);
});

test('discontinue refuses the same folder with the same message', async () => {
  const { dir } = await fixtureTree(2, 'two-b');

  const completeErr = await rejectsUsage(
    () => dispatcher.run(tokenize(['complete', STEP_UID, '--series-from', dir, '--dry-run']))
  );
  const discontinueErr = await rejectsUsage(
    () => dispatcher.run(tokenize(['discontinue', STEP_UID, '--series-from', dir, '--dry-run']))
  );

  assert.equal(discontinueErr.message, completeErr.message);
});

test('the refusal happens before anything is built, on the dry run too', async () => {
  const { dir } = await fixtureTree(2, 'two-c');

  // --dry-run is where an operator would look at a merged sequence and believe
  // it, so the guard has to sit in front of the dataset, not behind it.
  const { error, out } = await runCaptured(
    ['complete', STEP_UID, '--series-from', dir, '--dry-run']
  );
  assert.equal(error?.name, 'UsageError');
  assert.equal(out, '', 'nothing may be printed for a folder that cannot be described');
});

test('without --study-uid a two-study folder never reaches the builder', async () => {
  const { dir } = await fixtureTree(2, 'two-d');

  // The regression itself: four series spanning two studies, exit 0, silence.
  const err = throwsUsage(() => finish.resolvePerformedSeries(flagsOf(['--series-from', dir]), ''));
  assert.match(err.message, /exactly one/);
});

// --- scoping a mixed folder ------------------------------------------------

test('--study-uid scopes a mixed folder to exactly one study', async () => {
  const { dir, manifest } = await fixtureTree(2, 'scope');
  const [first, second] = manifest.studies;

  const { built, sourceLabel, assertedFromDisk } = finish.resolvePerformedSeries(
    flagsOf(['--series-from', dir, '--study-uid', second.studyInstanceUid]),
    'ARCHIVE'
  );

  const wanted = new Set(second.series.map((s) => s.seriesInstanceUid));
  const unwanted = new Set(first.series.map((s) => s.seriesInstanceUid));

  assert.equal(built.items.length, second.series.length);
  for (const item of built.items) {
    assert.ok(wanted.has(item.SeriesInstanceUID), `${item.SeriesInstanceUID} is not this study's`);
    assert.ok(!unwanted.has(item.SeriesInstanceUID));
  }

  // The number the reconciliation downstream is built on: only this study's
  // instances, not the folder's.
  assert.equal(built.referenced, second.instanceCount);
  assert.equal(
    built.items.reduce((n, s) => n + s.ReferencedImageSequence.length, 0),
    second.instanceCount
  );

  // Still a disk assertion, and the source says which study it was narrowed to.
  assert.equal(assertedFromDisk, true);
  assert.ok(sourceLabel.includes(second.studyInstanceUid));
});

test('--study-uid is no longer an unknown option on either verb', async () => {
  const { dir, manifest } = await fixtureTree(2, 'known');

  const { code, error, out } = await runCaptured([
    'complete', STEP_UID, '--series-from', dir,
    '--study-uid', manifest.studies[0].studyInstanceUid, '--dry-run',
  ]);
  assert.equal(error, undefined);
  assert.equal(code, 0);
  assert.match(out, /PerformedSeriesSequence|N-SET dataset/);
  assert.ok(finish.FLAGS.includes('study-uid'));
});

test('a --study-uid the folder does not hold is refused, not closed empty', async () => {
  const { dir, manifest } = await fixtureTree(2, 'absent');

  // An empty PerformedSeriesSequence is legal DICOM, so a typo here would
  // otherwise close the step claiming no images at all.
  const err = throwsUsage(
    () => finish.resolvePerformedSeries(
      flagsOf(['--series-from', dir, '--study-uid', '2.25.404']), ''
    )
  );
  assert.match(err.message, /is not in/);
  assert.ok(err.message.includes(manifest.studies[0].studyInstanceUid));
  assert.match(err.message, /Nothing was sent/);
});

test('--study-uid must be a UID, and must have a folder to scope', () => {
  // The folder does not exist, so a scan would fail with a different error.
  // Checking the flag first is what makes a typo cheap on a large tree.
  assert.match(
    throwsUsage(
      () => finish.resolvePerformedSeries(
        flagsOf(['--series-from', path.join(os.tmpdir(), 'dcm-no-such-folder'), '--study-uid', 'not a uid']),
        ''
      )
    ).message,
    /not a valid DICOM UID/
  );

  assert.match(
    throwsUsage(() => finish.resolvePerformedSeries(flagsOf(['--study-uid', '2.25.1']), '')).message,
    /nothing to scope/
  );
});

test('a folder holding one study still needs no flag', async () => {
  const { dir, manifest } = await fixtureTree(1, 'single');
  const [only] = manifest.studies;

  const { built, sourceLabel } = finish.resolvePerformedSeries(flagsOf(['--series-from', dir]), '');
  assert.equal(built.items.length, only.series.length);
  assert.equal(built.referenced, only.instanceCount);
  assert.ok(!sourceLabel.includes('scoped'));
});

test('scopeToOneStudy narrows the map itself, so seriesMeta cannot leak either', () => {
  const scanned = {
    filesExamined: 2,
    studies: new Map([
      ['1.2.3', { studyInstanceUid: '1.2.3', instances: [{}], patientName: 'A' }],
      ['1.2.4', { studyInstanceUid: '1.2.4', instances: [{}], patientName: 'B' }],
    ]),
  };

  const { studies } = finish.scopeToOneStudy(scanned, './x', '1.2.4');
  assert.deepEqual([...studies.keys()], ['1.2.4']);
});

// --- the caveat the USAGE promises "every time" ----------------------------

test('--dry-run says the performed series was asserted from disk', async () => {
  const { dir } = await fixtureTree(1, 'caveat');

  const { code, error, out, err } = await runCaptured(
    ['complete', STEP_UID, '--series-from', dir, '--dry-run']
  );

  assert.equal(error, undefined);
  assert.equal(code, 0);

  // --dry-run is exactly when a human is inspecting the dataset, which is when
  // the caveat matters most. It was previously printed only after the send.
  const printed = `${out}${err}`;
  assert.match(printed, /built by scanning your disk/);
  assert.match(printed, /Nothing here confirms the archive holds those instances/);
  assert.match(printed, /dcm mpps perform/);

  // It is the product of the command, so it belongs on stdout with the dataset.
  assert.match(out, /built by scanning your disk/);

  // And it is about a claim that has not been made yet.
  assert.match(out, /would assert they exist/);
  assert.doesNotMatch(out, /now asserts they exist/);

  // Before the closing line, so it is read with the dataset it is about.
  assert.ok(
    out.indexOf('built by scanning your disk') < out.indexOf('no connection was opened'),
    'the caveat must not trail the "nothing was sent" line'
  );
});

test('discontinue --dry-run carries the caveat too', async () => {
  const { dir } = await fixtureTree(1, 'caveat-disc');
  const { out } = await runCaptured(
    ['discontinue', STEP_UID, '--series-from', dir, '--dry-run']
  );
  assert.match(out, /built by scanning your disk/);
});

test('a close naming no folder asserts nothing, and says nothing about disk', async () => {
  const { code, out } = await runCaptured(['complete', STEP_UID, '--dry-run']);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /scanning your disk/);
});

test('the JSON dry run still carries assertedFromDisk, as one document', async () => {
  const { dir, manifest } = await fixtureTree(2, 'json');
  const [, second] = manifest.studies;

  const { code, out } = await runCaptured([
    'complete', STEP_UID, '--series-from', dir,
    '--study-uid', second.studyInstanceUid, '--dry-run', '--json',
  ]);

  assert.equal(code, 0);

  // Exactly one JSON document on stdout: the yellow caveat is a human-output
  // fix and must not have leaked a second line into the parseable stream.
  const parsed = JSON.parse(out);
  assert.equal(parsed.assertedFromDisk, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.seriesCount, second.series.length);
  assert.equal(parsed.instancesReferenced, second.instanceCount);
  assert.equal(parsed.dataset.PerformedSeriesSequence.length, second.series.length);
});

test('the usage documents the scoping flag and the refusal behind it', () => {
  for (const verb of ['complete', 'discontinue']) {
    const usage = finish.usageFor(verb);
    assert.ok(usage.includes('--study-uid <uid>'));
    assert.match(usage, /a folder holding two is refused/);
  }
});
