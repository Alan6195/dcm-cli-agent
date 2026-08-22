'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../../src/lib/log');
const { UsageError } = require('../../src/lib/args');
const dimse = require('../../src/lib/dimse');
const { runCommand, withTempDir, startScp, freePort } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');
const send = require('../../src/commands/send');

const {
  SPEED_PRESETS,
  resolveSpeedName,
  deriveChunkSize,
  resolveSpeedPlan,
  chunkSizeForStudy,
  planStudy,
  planJson,
  runParallelAchieved,
} = send;

log.configure({ quiet: true, noColor: true });

/**
 * `dcm send --speed`.
 *
 * The thing under test is not that a preset sets a number. It is that the
 * number it sets is the number the run achieves, which is a different claim,
 * and the one that was false before presets existed: concurrency is
 * min(--parallel, chunks) and chunks is ceil(instances / --chunk), so a 2508
 * instance study at the old default of 200 chunks into 13 and --parallel 16
 * ran 13 wide without saying so. Every assertion here is about that gap —
 * either it is closed by deriving a chunk size that can fill the workers, or,
 * where the study is too small for any honest chunk size to close it, it is
 * reported rather than hidden.
 *
 * Most of this is the resolution arithmetic on its own or a --dry-run through
 * the real run(), which opens no connection. The exception is the width the
 * run reports: that one is measured rather than computed, so it can only be
 * checked against a receiver that decides for itself what to accept.
 */

/** Study sizes worth checking: a small series, a small study, the owner's CT, a big one. */
const SIZES = [100, 400, 2508, 20000];

/** The smallest association a preset will derive, mirrored from send.js. */
const MIN_CHUNK = 25;

/** Resolves a preset with nothing else typed. */
function planFor(speed) {
  return resolveSpeedPlan({
    speed,
    parallel: 1,
    chunkSize: 200,
    explicitParallel: false,
    explicitChunk: false,
  });
}

/**
 * The chunk size and the study shape one study gets under a plan.
 *
 * The size is a per-study question, so every assertion about a size has to
 * name the study it is about. This pairing is what the run loop does.
 */
function studyUnder(plan, instances) {
  const chunkSize = chunkSizeForStudy(plan, instances);
  return { chunkSize, ...planStudy({ instances, chunkSize, parallel: plan.parallel }) };
}

/**
 * The command's JSON envelope, out of captured stdout.
 *
 * runCommand replaces process.stdout.write for the length of the call, so a
 * receiver running in the same process lands its own bytes in the same buffer
 * — including raw PDU bytes, which can contain a brace. So this tries every
 * opening brace rather than trusting the first, and takes the first one that
 * closes into something parseable. Same problem test/unit/json.test.js has,
 * one degree worse because a DIMSE receiver is on the other end.
 */
function firstJsonDocument(stdout) {
  for (let start = stdout.indexOf('{'); start !== -1; start = stdout.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < stdout.length; i++) {
      const ch = stdout[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, i + 1));
        } catch {
          break; // Not the envelope; try the next brace.
        }
      }
    }
  }
  throw new Error(`no JSON document in output:\n${JSON.stringify(stdout)}`);
}

/**
 * The per-study records run() builds, from a plan and a set of study sizes.
 *
 * `peak` is what the receiver actually accepted at once. It defaults to the
 * dispatched worker count — a receiver that accepted everything — and is
 * overridden where the point of the test is that it did not.
 */
function recordsFor(plan, sizes, peaks) {
  return sizes.map((instances, i) => {
    const study = studyUnder(plan, instances);
    return {
      studyInstanceUid: `1.2.3.${i}`,
      instances,
      chunkSize: study.chunkSize,
      chunks: study.chunks,
      workers: study.workers,
      peakAssociations: peaks ? peaks[i] : study.workers,
    };
  });
}

// ---------------------------------------------------------------------------
// The presets themselves
// ---------------------------------------------------------------------------

test('each preset resolves to the parallelism it advertises', () => {
  assert.deepEqual(SPEED_PRESETS, {
    'normal': 1,
    'fast': 4,
    'very-fast': 8,
    'insane': 16,
  });

  for (const [name, expected] of Object.entries(SPEED_PRESETS)) {
    const plan = planFor(name);
    assert.equal(plan.parallel, expected, `--speed ${name}`);
    assert.equal(plan.parallelSource, 'speed');
  }
});

test('a bogus --speed is a usage error naming the four presets', () => {
  assert.throws(() => resolveSpeedName('ludicrous'), (err) => {
    assert.ok(err instanceof UsageError, 'must be a UsageError, not a crash');
    for (const name of ['normal', 'fast', 'very-fast', 'insane']) {
      assert.match(err.message, new RegExp(name), `the error should name ${name}`);
    }
    return true;
  });

  // The name someone would type for the hyphenated preset, two other ways.
  assert.equal(resolveSpeedName('VERY-FAST'), 'very-fast');
  assert.equal(resolveSpeedName('very fast'), 'very-fast');
  assert.equal(resolveSpeedName(undefined), undefined);
});

// ---------------------------------------------------------------------------
// The derived chunk size — the half that makes the preset true
// ---------------------------------------------------------------------------

test('a preset derives a chunk that actually delivers its parallelism', () => {
  for (const instances of SIZES) {
    for (const name of Object.keys(SPEED_PRESETS)) {
      const plan = planFor(name);
      const study = studyUnder(plan, instances);

      // Below 25 instances per association the setup and release cost more
      // than the transfer, so that floor is the honest limit of what any chunk
      // size can deliver for a study this size.
      const reachable = instances >= MIN_CHUNK * plan.parallel;
      const where = `${instances} instances at --speed ${name}`;

      if (reachable) {
        assert.equal(
          Math.min(plan.parallel, study.chunks),
          plan.parallel,
          `${where}: chunk ${study.chunkSize} gives only ${study.chunks} chunk(s), ` +
            `so the run would be ${study.workers} wide, not ${plan.parallel}`
        );
        assert.equal(study.workers, plan.parallel, where);
        assert.equal(study.warning, undefined, `${where} is reachable and must not warn`);
      } else {
        assert.ok(study.warning, `${where} cannot be reached and must warn`);
      }
    }
  }
});

test('the owner\'s case: a 2508-instance CT fills every worker at every preset', () => {
  // The run that started this. At the old fixed chunk of 200 these were 13
  // chunks, so 'insane' would have run 13 wide and 'very-fast' 8 wide by luck.
  const expected = {
    'normal': { parallel: 1, chunk: 200, chunks: 13 },
    'fast': { parallel: 4, chunk: 200, chunks: 13 },
    'very-fast': { parallel: 8, chunk: 156, chunks: 17 },
    'insane': { parallel: 16, chunk: 78, chunks: 33 },
  };

  for (const [name, want] of Object.entries(expected)) {
    const plan = planFor(name);
    const study = studyUnder(plan, 2508);
    assert.equal(plan.parallel, want.parallel, name);
    assert.equal(study.chunkSize, want.chunk, name);
    assert.equal(study.chunks, want.chunks, name);
    assert.equal(study.workers, want.parallel, `${name} must run the full width`);
  }
});

test('the derived chunk stays inside the range that is worth sending', () => {
  for (const instances of [1, 10, 100, 400, 2508, 20000, 500000]) {
    for (const name of Object.keys(SPEED_PRESETS)) {
      const chunkSize = chunkSizeForStudy(planFor(name), instances);
      assert.ok(chunkSize >= MIN_CHUNK, `${instances}/${name}: chunk ${chunkSize} is below ${MIN_CHUNK}`);
      assert.ok(chunkSize <= 200, `${instances}/${name}: chunk ${chunkSize} is above the 200 default`);
      assert.ok(Number.isInteger(chunkSize), `${instances}/${name}: chunk must be a whole number`);
    }
  }
});

test('two chunks per worker, so the tail has something to hand out', () => {
  // The reason the derivation is not instances/parallel: one chunk each means
  // the run ends when its slowest single chunk does.
  assert.equal(deriveChunkSize(3200, 8), 200);   // floor(3200/16) = 200
  assert.equal(deriveChunkSize(1600, 8), 100);   // floor(1600/16) = 100
  assert.equal(Math.ceil(1600 / 100), 16);       // 16 chunks for 8 workers

  // One worker cannot starve, so nothing is derived: the historic default.
  assert.equal(deriveChunkSize(100, 1), 200);
  assert.equal(deriveChunkSize(20000, 1), 200);
});

// ---------------------------------------------------------------------------
// One chunk size per study, not one per run
// ---------------------------------------------------------------------------

test('the chunk is derived per study, so no study pays for another study\'s shape', () => {
  // Chunking and the worker pool are both per study, so the size that fills
  // the requested width is a per-study question. A single run-wide size had to
  // be taken from the smallest study — anything larger would leave the small
  // one running narrow — and that made the smallest study in the folder choose
  // for everybody.
  const plan = planFor('fast');
  assert.equal(plan.parallel, 4);
  assert.equal(plan.chunkSize, null, 'a preset resolves no single run-wide size');

  const each = {
    400: 50,      // floor(400 / 8)
    20000: 200,   // floor(20000 / 8) = 2500, held at the 200 ceiling
  };
  for (const [instances, size] of Object.entries(each)) {
    const study = studyUnder(plan, Number(instances));
    assert.equal(study.chunkSize, size, `${instances} instances`);
    assert.equal(study.workers, 4, `${instances} instances must still run 4 wide`);
    assert.equal(study.warning, undefined, `${instances} instances reaches the width, so no warning`);
  }
});

test('a tiny study no longer drags every other study to the 25-instance floor', () => {
  // The defect, stated as arithmetic. A 30-instance study cannot be more than
  // one association at any size the clamp permits — 30 instances at a chunk of
  // 25 is two, at 200 is one, and either way it runs under the requested width
  // — so sizing the run from it bought it nothing. What it cost the study
  // beside it was 700 extra connect / negotiate / release cycles, most of that
  // paid by the receiver.
  const plan = planFor('fast');

  const tiny = studyUnder(plan, 30);
  const big = studyUnder(plan, 20000);

  assert.equal(big.chunkSize, 200, 'the large study derives its own size');
  assert.equal(big.chunks, 100, 'and splits into 100 associations, not 800');
  assert.equal(big.workers, 4, 'while still reaching the requested width');
  assert.equal(big.warning, undefined);

  // Under one run-wide size taken from the smallest study, the same study
  // would have been chunked at 25.
  assert.equal(Math.ceil(20000 / MIN_CHUNK), 800, 'what the run-wide size used to cost');

  // And the small study is unchanged by any of it: it still cannot reach 4,
  // and still says so.
  assert.equal(tiny.chunkSize, MIN_CHUNK);
  assert.equal(tiny.workers, 2);
  assert.match(tiny.warning, /run 2 wide, not 4/);
});

test('what one study does cannot be changed by what else is in the folder', () => {
  // The general property, and the one that deletes the whole class rather than
  // the one reported instance of it: a study's shape is decided by its own
  // instance count and by nothing else. The plan is resolved from the flags
  // alone — study sizes are not an input to it — so a folder cannot reach
  // across studies at all. Passing counts in anyway proves they are ignored;
  // under a run-wide derivation each of these folders gave a different answer.
  const folders = [[20000], [2, 20000], [30, 20000], [2, 30, 100, 400, 2508, 20000]];

  for (const name of Object.keys(SPEED_PRESETS)) {
    const plans = folders.map((instanceCounts) => resolveSpeedPlan({
      speed: name,
      parallel: 1,
      chunkSize: 200,
      explicitParallel: false,
      explicitChunk: false,
      instanceCounts,
    }));

    for (const instances of [30, 400, 2508, 20000]) {
      const sizes = plans.map((plan) => chunkSizeForStudy(plan, instances));
      assert.deepEqual(
        sizes,
        sizes.map(() => sizes[0]),
        `${instances} instances at --speed ${name} must be sized the same in every folder`
      );

      // And each study reaches the requested width whenever its own instance
      // count allows it, rather than whenever the folder's smallest does.
      if (instances >= MIN_CHUNK * plans[0].parallel) {
        assert.equal(
          studyUnder(plans[0], instances).workers,
          plans[0].parallel,
          `${instances} at --speed ${name}`
        );
      }
    }
  }
});

test('an explicit --chunk stays run-wide and applies to every study unchanged', () => {
  const plan = resolveSpeedPlan({
    speed: 'fast',
    parallel: 1,
    chunkSize: 100,
    explicitParallel: false,
    explicitChunk: true,
  });

  assert.equal(plan.chunkSize, 100, 'a typed number is one number for the run');
  assert.equal(plan.chunkSource, 'flag');
  for (const instances of [30, 400, 20000]) {
    assert.equal(chunkSizeForStudy(plan, instances), 100, `${instances} instances`);
  }
});

// ---------------------------------------------------------------------------
// Explicit flags beat the preset, and say so
// ---------------------------------------------------------------------------

test('an explicit --parallel beats the preset and is reported', () => {
  const plan = resolveSpeedPlan({
    speed: 'insane',
    parallel: 6,
    chunkSize: 200,
    explicitParallel: true,
    explicitChunk: false,
  });

  assert.equal(plan.parallel, 6, 'the number that was typed wins');
  assert.equal(plan.parallelSource, 'flag');
  assert.equal(plan.warnings.length, 1, 'an override must not be silent');
  assert.match(plan.warnings[0], /--parallel 6/);
  assert.match(plan.warnings[0], /--speed insane/);
  assert.match(plan.warnings[0], /16/, 'the preset value it displaced should be named');

  // The chunk is still sized for what will actually run, not for the preset.
  assert.equal(studyUnder(plan, 2508).workers, 6);
});

test('typing the number the preset would have picked is not an override', () => {
  // The warning names both values in one sentence, so when they are equal it
  // reads "--parallel 1 wins, so this run opens 1, not the preset's 1" — a
  // sentence that contradicts itself about a displacement that did not happen.
  // Nothing was displaced, so there is nothing to warn about.
  for (const [speed, preset] of Object.entries(SPEED_PRESETS)) {
    const plan = resolveSpeedPlan({
      speed,
      parallel: preset,
      chunkSize: 200,
      explicitParallel: true,
      explicitChunk: false,
    });

    assert.deepEqual(plan.warnings, [], `--speed ${speed} --parallel ${preset}`);
    assert.equal(plan.parallel, preset);
    // The source still says 'flag'. The value came from the flag whether or not
    // it agreed with the preset, and --json must not claim otherwise.
    assert.equal(plan.parallelSource, 'flag', `--speed ${speed} --parallel ${preset}`);
  }

  // One off by one in either direction is a real override and still warns.
  for (const parallel of [3, 5]) {
    const plan = resolveSpeedPlan({
      speed: 'fast',
      parallel,
      chunkSize: 200,
      explicitParallel: true,
      explicitChunk: false,
    });
    assert.equal(plan.warnings.length, 1, `--speed fast --parallel ${parallel}`);
    assert.match(plan.warnings[0], new RegExp(`--parallel ${parallel}`));
  }
});

test('an explicit --chunk beats the preset and is reported', () => {
  const plan = resolveSpeedPlan({
    speed: 'insane',
    parallel: 1,
    chunkSize: 500,
    explicitParallel: false,
    explicitChunk: true,
  });

  assert.equal(plan.chunkSize, 500, 'the number that was typed wins');
  assert.equal(plan.chunkSource, 'flag');
  assert.equal(plan.parallel, 16, 'the preset still picks the parallelism');
  assert.equal(plan.warnings.length, 1, 'an override must not be silent');
  assert.match(plan.warnings[0], /--chunk 500/);
  assert.match(plan.warnings[0], /--speed insane/);
  assert.match(plan.warnings[0], /reaches 16/, 'and says what to check');

  // And this is exactly why the override is worth warning about: 2508
  // instances at 500 is 6 chunks, so 16 workers cannot happen.
  const study = studyUnder(plan, 2508);
  assert.equal(study.chunks, 6);
  assert.equal(study.workers, 6);
  assert.ok(study.warning);
});

test('the --chunk warning does not ask for a check that cannot fail', () => {
  // At one association min(1, chunks) is 1 for any chunk count, so there is no
  // shortfall to look for and telling someone to look for one wastes their time.
  const plan = resolveSpeedPlan({
    speed: 'normal',
    parallel: 1,
    chunkSize: 100,
    explicitParallel: false,
    explicitChunk: true,
  });

  assert.equal(plan.warnings.length, 1, 'the override itself is still real and still warned about');
  assert.match(plan.warnings[0], /--chunk 100 was given alongside --speed normal/);
  assert.doesNotMatch(plan.warnings[0], /Check the association count/);
});

test('typing the size the preset would have derived is not reported as an override', () => {
  // The other half of "--parallel 1 wins, not the preset's 1": a warning that
  // says --chunk displaced the preset when the preset would have chosen the
  // same number describes something that did not happen. At one association
  // deriveChunkSize returns DEFAULT_CHUNK for every study there could be, so
  // this is decidable for the whole run before a single file is scanned.
  const same = resolveSpeedPlan({
    speed: 'normal',
    parallel: 1,
    chunkSize: 200,
    explicitParallel: false,
    explicitChunk: true,
  });
  assert.deepEqual(same.warnings, [], '--speed normal --chunk 200 displaces nothing');
  assert.equal(same.chunkSize, 200, 'and the size is still the one that was typed');
  assert.equal(same.chunkSource, 'flag');
  // The claim under the claim: the preset really would have chosen 200, for
  // any study the folder could hold.
  const derived = resolveSpeedPlan({
    speed: 'normal',
    parallel: 1,
    chunkSize: 200,
    explicitParallel: false,
    explicitChunk: false,
  });
  for (const instances of [1, 30, 400, 2508, 20000]) {
    assert.equal(chunkSizeForStudy(derived, instances), 200, `${instances} instances`);
  }

  // An explicit --parallel of 1 alongside a wider preset is the same case: the
  // resolved width is what the derivation uses.
  assert.deepEqual(
    resolveSpeedPlan({
      speed: 'insane',
      parallel: 1,
      chunkSize: 200,
      explicitParallel: true,
      explicitChunk: true,
    }).warnings.filter((w) => w.includes('--chunk')),
    [],
    'the width was overridden to 1, and at 1 the preset would have derived 200'
  );

  // Above one association the derived size depends on the study, so nothing
  // here can know whether 200 displaced it. The warning stands rather than
  // being guessed at.
  assert.equal(
    resolveSpeedPlan({
      speed: 'fast',
      parallel: 1,
      chunkSize: 200,
      explicitParallel: false,
      explicitChunk: true,
    }).warnings.length,
    1,
    '--speed fast derives per study, so equality is not knowable here'
  );

  // And the one case where typing DEFAULT_CHUNK at one association really does
  // displace something: a run that has to hold parsed datasets caps a derived
  // size at 50 and leaves a typed one alone.
  assert.equal(
    resolveSpeedPlan({
      speed: 'normal',
      parallel: 1,
      chunkSize: 200,
      explicitParallel: false,
      explicitChunk: true,
      memoryBound: true,
    }).warnings.length,
    1,
    'a typed 200 beats the memory cap the preset would have been held to'
  );
});

test('without --speed, nothing about the old defaults moves', () => {
  const plan = resolveSpeedPlan({
    speed: undefined,
    parallel: 1,
    chunkSize: 200,
    explicitParallel: false,
    explicitChunk: false,
  });

  assert.deepEqual(
    { parallel: plan.parallel, chunkSize: plan.chunkSize, warnings: plan.warnings },
    { parallel: 1, chunkSize: 200, warnings: [] }
  );
  assert.equal(plan.parallelSource, 'default');
  assert.equal(plan.chunkSource, 'default');
  // And with no preset there is nothing to derive, so the one size really is
  // one size: every study is chunked at 200.
  for (const instances of [30, 400, 20000]) {
    assert.equal(chunkSizeForStudy(plan, instances), 200, `${instances} instances`);
  }
});

// ---------------------------------------------------------------------------
// The shortfall warning
// ---------------------------------------------------------------------------

test('a width that cannot be reached warns, naming both numbers', () => {
  // Reached by preset: 100 instances cannot fill 16 associations without
  // dropping under 25 per association.
  const viaPreset = studyUnder(planFor('insane'), 100);
  assert.equal(viaPreset.chunks, 4);
  assert.equal(viaPreset.workers, 4);
  assert.match(viaPreset.warning, /16/, 'the requested width must be named');
  assert.match(viaPreset.warning, /\b4\b/, 'the width that will actually run must be named');

  // Reached by a bare --parallel, which is the original trap and must warn
  // just the same: 400 instances at the default chunk is 2 associations.
  const viaParallel = planStudy({ instances: 400, chunkSize: 200, parallel: 4 });
  assert.equal(viaParallel.chunks, 2);
  assert.equal(viaParallel.workers, 2);
  assert.match(viaParallel.warning, /4/);
  assert.match(viaParallel.warning, /\b2\b/);

  // And the same study 16 wide, which is the case the owner hit.
  const ct = planStudy({ instances: 2508, chunkSize: 200, parallel: 16 });
  assert.equal(ct.workers, 13);
  assert.match(ct.warning, /13/);
  assert.match(ct.warning, /16/);
});

test('a reachable width does not warn, and the summary says what will run', () => {
  const study = planStudy({ instances: 2508, chunkSize: 78, parallel: 16 });
  assert.equal(study.warning, undefined);
  assert.equal(study.summary, '2508 instance(s) in 33 association(s) of up to 78, 16 at a time');
});

test('the summary uses the real chunk count when the caller has already split', () => {
  // run() passes the length of the array it is about to send, so the line
  // cannot drift from what happens.
  const study = planStudy({ instances: 2508, chunkSize: 78, parallel: 16, chunkCount: 33 });
  assert.equal(study.chunks, 33);
  assert.equal(study.workers, 16);
});

// ---------------------------------------------------------------------------
// The width that is reported for the whole run
// ---------------------------------------------------------------------------

test('the run-level width is the narrowest study, not the widest', () => {
  // The reduction across studies. `max` was the original mistake: one study
  // that filled every worker let the whole run claim the requested width, so a
  // run where most of the data moved narrow reported no shortfall at all. The
  // throughput figure printed beside it covers every study, so the width has to
  // be one that no part of the run fell below.
  const plan = planFor('fast');
  const mixed = recordsFor(plan, [100, 30, 30, 30, 30, 30, 30]);

  assert.deepEqual(
    mixed.map((s) => s.workers),
    [4, 2, 2, 2, 2, 2, 2],
    'one wide study and six narrow ones'
  );
  assert.equal(runParallelAchieved(mixed, plan.parallel), 2, 'the run ran 2 wide for most of its data');

  // Order must not matter — the widest study first was the case that hid it.
  assert.equal(runParallelAchieved([...mixed].reverse(), plan.parallel), 2);

  // And a run where every study did reach the width reports it plainly.
  const even = recordsFor(plan, [2508, 2508]);
  assert.equal(runParallelAchieved(even, plan.parallel), 4);
});

test('the run-level width counts associations accepted, not workers dispatched', () => {
  // A worker count is arithmetic: min(parallel, chunks), fixed before a socket
  // is opened. A receiver at its concurrent-association limit rejects the
  // extras, and because that rejection is transient it is retryable — the
  // retry lands in a freed slot, every instance is acknowledged and the run
  // exits 0. Nothing about the transfer accounting is wrong in that run. The
  // width beside its throughput figure would be, if the dispatched count were
  // what was reported.
  const plan = planFor('insane');
  const study = studyUnder(plan, 2508);
  assert.equal(study.workers, 16, '16 workers really are dispatched');
  assert.equal(study.warning, undefined, 'and the chunk arithmetic sees no shortfall');

  const capped = recordsFor(plan, [2508], [4]); // receiver accepted 4 at a time
  assert.equal(runParallelAchieved(capped, plan.parallel), 4, 'so the run reports 4, not 16');
});

test('the run-level width is a floor, so no study can hide behind another', () => {
  // Both causes at once: one study too small to fill the workers, one study
  // whose workers the receiver refused. Either alone pulls the number down;
  // together the lower of them wins, and neither conceals the other.
  const plan = planFor('insane');
  const records = recordsFor(plan, [2508, 30], [4, 2]);

  assert.deepEqual(records.map((s) => s.workers), [16, 2]);
  assert.deepEqual(records.map((s) => s.peakAssociations), [4, 2]);
  assert.equal(runParallelAchieved(records, plan.parallel), 2);
});

test('no study means no width, not the width that was asked for', () => {
  // The reduction seeds from the requested width so that the first study can
  // only lower it. With no studies at all the seed is the answer, and the one
  // input that measured nothing would report the full request as an
  // achievement — the exact claim this number exists to prevent. run() returns
  // before this on an empty folder, so the guard is for the next caller.
  for (const parallel of [1, 4, 16]) {
    assert.equal(runParallelAchieved([], parallel), 0, `--parallel ${parallel}`);
  }
});

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

test('--json carries the resolved values and where each came from', () => {
  const plan = planFor('very-fast');
  const studies = recordsFor(plan, [2508]);
  const payload = planJson(plan, runParallelAchieved(studies, plan.parallel), studies);

  assert.deepEqual(payload, {
    speed: 'very-fast',
    parallel: 8,
    parallelSource: 'speed',
    parallelAchieved: 8,
    // Null, not a number: a preset sizes each study separately, so no single
    // value is true of the run. The per-study sizes are in `studies`.
    chunkSize: null,
    chunkSource: 'speed',
    studies: [{
      studyInstanceUid: '1.2.3.0',
      instances: 2508,
      chunkSize: 156,
      chunks: 17,
      workers: 8,
      peakAssociations: 8,
    }],
  });

  // A run that fell short carries both numbers, so a benchmark comparing two
  // JSON documents can see it without reading the log.
  const shortStudies = recordsFor(planFor('insane'), [100]);
  const short = planJson(planFor('insane'), runParallelAchieved(shortStudies, 16), shortStudies);
  assert.equal(short.parallel, 16);
  assert.equal(short.parallelAchieved, 4);

  // No preset: speed is present and null rather than absent, so consumers do
  // not have to distinguish "old version" from "no preset", and chunkSize is a
  // real number because one size really did apply to the whole run.
  const plainPlan = resolveSpeedPlan({
    speed: undefined,
    parallel: 4,
    chunkSize: 200,
    explicitParallel: true,
    explicitChunk: false,
  });
  const plainStudies = recordsFor(plainPlan, [400], [2]);
  const plain = planJson(plainPlan, runParallelAchieved(plainStudies, 4), plainStudies);
  assert.equal(plain.speed, null);
  assert.equal(plain.parallelSource, 'flag');
  assert.equal(plain.chunkSize, 200);
  assert.equal(plain.parallelAchieved, 2);
});

test('--json states one chunk size only when one applied to the whole run', () => {
  // The mixed folder from the per-study derivation: 25 for the small study and
  // 200 for the large one. A single chunkSize field cannot say that, so it says
  // null and the array says the rest.
  const plan = planFor('fast');
  const studies = recordsFor(plan, [30, 20000]);
  const payload = planJson(plan, runParallelAchieved(studies, plan.parallel), studies);

  assert.equal(payload.chunkSize, null);
  assert.deepEqual(payload.studies.map((s) => s.chunkSize), [25, 200]);
  assert.deepEqual(payload.studies.map((s) => s.chunks), [2, 100]);
  assert.deepEqual(payload.studies.map((s) => s.workers), [2, 4]);
  assert.equal(payload.parallelAchieved, 2, 'and the run-level width is the narrow study\'s');

  // An explicit --chunk is the case where one number is true, and then the
  // field carries it.
  const typed = resolveSpeedPlan({
    speed: 'fast',
    parallel: 1,
    chunkSize: 100,
    explicitParallel: false,
    explicitChunk: true,
  });
  const typedStudies = recordsFor(typed, [30, 20000]);
  assert.equal(planJson(typed, 1, typedStudies).chunkSize, 100);
  assert.deepEqual(typedStudies.map((s) => s.chunkSize), [100, 100]);
});

test('reducing over a large folder does not blow the stack', () => {
  // The reduction is a fold, not Math.min(...counts): one spread argument per
  // study throws RangeError past roughly 125k, and a migration tree reaches
  // that with single-instance CR studies inside a normal heap. The crash landed
  // after the whole scan, on exactly the workload --speed fast is documented for.
  const plan = planFor('fast');
  const studies = Array.from({ length: 200000 }, () => ({ workers: 4, peakAssociations: 4 }));
  studies[123456].peakAssociations = 1;

  assert.equal(runParallelAchieved(studies, plan.parallel), 1);

  // And the plan itself no longer looks at the study count at all, so the same
  // folder cannot crash on the way in either.
  assert.equal(
    resolveSpeedPlan({
      speed: 'fast',
      parallel: 1,
      chunkSize: 200,
      explicitParallel: false,
      explicitChunk: false,
      instanceCounts: new Array(200000).fill(1),
    }).chunkSize,
    null
  );
});

// ---------------------------------------------------------------------------
// Wired into the command — driven through run(), which opens no connection
// because --dry-run returns before any of the peer options are even read.
// ---------------------------------------------------------------------------

test('a dry run reports the resolution and warns about a width it cannot reach', async (t) => {
  await withTempDir('dcm-speed', async (dir) => {
    const outDir = path.join(dir, 'study');
    await generate({ outDir, studies: 1, seriesPerStudy: 2, instancesPerSeries: 50, quiet: true });

    await t.test('a reachable preset states what it resolved to', async () => {
      const { code, stderr } = await runCommand(send, [outDir, '--dry-run', '--speed', 'fast']);
      assert.equal(code, 0);
      // 100 instances, 4 workers: floor(100/8) = 12, held up to 25, so 4 chunks.
      assert.match(stderr, /up to 4 association\(s\) at a time, up to 25 instance\(s\) each/);
      assert.match(stderr, /--speed fast/);
      assert.doesNotMatch(stderr, /were requested but this study splits into only/);
    });

    await t.test('an unreachable preset warns instead of quietly running narrow', async () => {
      const { code, stderr } = await runCommand(send, [outDir, '--dry-run', '--speed', 'insane']);
      assert.equal(code, 0);
      assert.match(stderr, /warning/);
      assert.match(stderr, /16/);
      assert.match(stderr, /run 4 wide, not 16/);
    });

    await t.test('a bare --parallel that cannot be reached warns too', async () => {
      const { code, stderr } = await runCommand(send, [outDir, '--dry-run', '--parallel', '8']);
      assert.equal(code, 0);
      // No preset, so the chunk stays at 200: one association for 100 instances.
      assert.match(stderr, /run 1 wide, not 8/);
    });

    await t.test('an explicit --parallel alongside --speed says which won', async () => {
      const { code, stderr } = await runCommand(send, [
        outDir, '--dry-run', '--speed', 'insane', '--parallel', '2',
      ]);
      assert.equal(code, 0);
      assert.match(stderr, /--parallel 2 was given alongside --speed insane/);
      assert.match(stderr, /up to 2 association\(s\) at a time/);
    });

    await t.test('an explicit --chunk alongside --speed says which won', async () => {
      const { code, stderr } = await runCommand(send, [
        outDir, '--dry-run', '--speed', 'fast', '--chunk', '200',
      ]);
      assert.equal(code, 0);
      assert.match(stderr, /--chunk 200 was given alongside --speed fast/);
      assert.match(stderr, /up to 200 instance\(s\) each/);
      assert.doesNotMatch(stderr, /derived per study/, 'a typed size is one size for the run');
    });

    await t.test('an explicit --chunk that displaces nothing says nothing', async () => {
      // --speed normal is 1 association wide, and at one association the preset
      // derives 200 whatever the study holds. Warning that --chunk 200 stopped
      // the preset from sizing associations describes a displacement that did
      // not happen, and the desktop hits it by default: Chunk size sits under
      // Advanced with Normal already selected.
      const { code, stderr } = await runCommand(send, [
        outDir, '--dry-run', '--speed', 'normal', '--chunk', '200',
      ]);
      assert.equal(code, 0);
      assert.doesNotMatch(stderr, /was given alongside/);
      assert.match(stderr, /up to 200 instance\(s\) each/, 'the size itself is still stated');
    });

    await t.test('the same flags do warn when the preset would have been capped', async () => {
      // Rewriting forces a parse, which holds a derived size at 50 and leaves a
      // typed one alone — so here the typed 200 really did displace something.
      const { code, stderr } = await runCommand(send, [
        outDir, '--dry-run', '--speed', 'normal', '--chunk', '200', '--rewrite-series-uid',
      ]);
      assert.equal(code, 0);
      assert.match(stderr, /--chunk 200 was given alongside --speed normal/);
    });

    await t.test('typing the preset\'s own number is not reported as an override', async () => {
      const { code, stderr } = await runCommand(send, [
        outDir, '--dry-run', '--speed', 'fast', '--parallel', '4',
      ]);
      assert.equal(code, 0);
      assert.doesNotMatch(stderr, /was given alongside/);
      assert.match(stderr, /up to 4 association\(s\) at a time/);
    });

    await t.test('a bogus preset fails before anything is scanned', async () => {
      await assert.rejects(
        () => runCommand(send, [outDir, '--dry-run', '--speed', 'ludicrous']),
        (err) => {
          assert.ok(err instanceof UsageError);
          assert.match(err.message, /normal, fast, very-fast, insane/);
          return true;
        }
      );
    });
  });
});

test('a mixed folder is reported per study, and never as one size it does not have', async (t) => {
  await withTempDir('dcm-speed-mixed', async (dir) => {
    // Two studies of very different sizes in one folder — the ordinary shape
    // of `dcm send ./studies`. Written as two trees because the fixture
    // generator numbers Study UIDs from 1, so a second call with a different
    // size would otherwise land in the same study.
    const big = path.join(dir, 'big');
    const small = path.join(dir, 'small');
    await generate({ outDir: big, studies: 1, seriesPerStudy: 1, instancesPerSeries: 120, quiet: true });
    await generate({ outDir: small, studies: 2, seriesPerStudy: 1, instancesPerSeries: 5, quiet: true });
    // Drop the first study of the second tree; it shares a Study UID with the
    // first tree's, and the point here is two studies of unequal size.
    fs.rmSync(path.join(small, 'study-1'), { recursive: true });

    // --parallel 2 rather than a bare preset only because the derivation has
    // to clear the 25-instance floor for the sizes to differ at all: at 2 wide
    // the 120-instance study derives floor(120/4) = 30 while the 5-instance one
    // stays at the floor.
    const { code, stdout, stderr } = await runCommand(send, [
      dir, '--dry-run', '--speed', 'fast', '--parallel', '2',
    ]);
    assert.equal(code, 0);

    await t.test('the header states a range, not a number no study uses', () => {
      assert.match(stderr, /up to 2 association\(s\) at a time, up to 25–30 instance\(s\) each, derived per study/);
      // The failure this replaces: one size for the run, taken from the
      // smallest study, which chunked the 120-instance study at 25.
      assert.doesNotMatch(stderr, /up to 25 instance\(s\) each(?!,)/);
    });

    await t.test('each study is sized from its own instance count', () => {
      // report.dryRun resolves the size per study, so these association counts
      // are each study's own rather than one size applied to both.
      assert.ok(stdout.includes('associations   4 (chunk size 30)'), stdout);
      assert.ok(stdout.includes('associations   1 (chunk size 25)'), stdout);
    });

    await t.test('the big study reaches the width and the small one says it cannot', () => {
      assert.match(stderr, /run 1 wide, not 2/, 'the 5-instance study is one association at any size');
      // And exactly one shortfall warning: the 120-instance study reaches 2.
      assert.equal((stderr.match(/wide, not 2/g) || []).length, 1);
    });

    await t.test('the dry run states each size outright, with no caveat', () => {
      // This replaces an assertion on a warning that told the reader the block
      // below stated a single size and that its association counts were only an
      // upper bound. That warning existed because report.dryRun divided every
      // study by one run-wide number. It resolves per study now, so the counts
      // are exact and there is nothing left to apologise for.
      assert.doesNotMatch(stderr, /upper bound/);
      assert.doesNotMatch(stderr, /derive different chunk sizes/);
    });
  });
});

test('the reported width comes from what the receiver accepted', async (t) => {
  // Finding 7's case, against the real receiver. The worker count is settled
  // before a socket is opened, so a run whose associations the peer refuses
  // still dispatches every worker. Only a measurement can tell the difference,
  // and the difference is the whole value of the number.
  await withTempDir('dcm-speed-peer', async (dir) => {
    const outDir = path.join(dir, 'study');
    await generate({ outDir, studies: 1, seriesPerStudy: 1, instancesPerSeries: 10, quiet: true });
    const scp = await startScp({ acceptCallingAe: ['ALLOWED'] });

    try {
      const peer = [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'ANY',
        '--parallel', '2', '--chunk', '5', '--json',
      ];

      await t.test('a peer that refuses every association reports 0, not 2', async () => {
        const { code, stdout, stderr } = await runCommand(send, [
          outDir, ...peer, '--calling-ae', 'DENIED', '--retry', '0',
        ]);
        const payload = firstJsonDocument(stdout);

        assert.equal(payload.studies.length, 1);
        assert.equal(payload.studies[0].chunks, 2);
        assert.equal(payload.studies[0].workers, 2, 'both workers really were dispatched');
        assert.equal(payload.studies[0].peakAssociations, 0, 'and the peer accepted none of them');
        assert.equal(payload.parallelAchieved, 0, 'so the run reports 0');
        assert.match(stderr, /never had more than 0 accepted at once/);

        // And nothing counts as an association that the peer refused. Two were
        // attempted and two were turned away, so the count of associations the
        // transfer was carried in is zero: "0 B in 2 association(s)" describes
        // a run that never happened.
        assert.equal(payload.associations, 0, 'a refused association carried nothing');

        // The transfer accounting is separately true, and says the same thing
        // in its own terms: nothing was sent, and that is a failure.
        assert.equal(code, 1);
        assert.equal(payload.found, 10);
        assert.equal(payload.sent, 0);
        assert.equal(payload.acknowledged, 0);
        assert.equal(payload.shortfall, 10);
      });

      await t.test('a peer that accepts reports a width it actually granted', async () => {
        const { code, stdout, stderr } = await runCommand(send, [
          outDir, ...peer, '--calling-ae', 'ALLOWED',
        ]);
        const payload = firstJsonDocument(stdout);

        assert.equal(code, 0);
        assert.equal(payload.acknowledged, 10);
        // Not pinned to 2: whether both associations overlap depends on how
        // fast the first chunk drains, and the measurement is a floor by
        // design. What must hold is that it is a real, granted width — never
        // more than was dispatched, and never the zero of the refused run.
        assert.ok(
          payload.studies[0].peakAssociations >= 1 &&
            payload.studies[0].peakAssociations <= payload.studies[0].workers,
          `peak ${payload.studies[0].peakAssociations} outside 1..${payload.studies[0].workers}`
        );
        assert.equal(payload.parallelAchieved, payload.studies[0].peakAssociations);

        // The warning has to agree with the measurement, whichever way the
        // measurement went, and this assertion has to allow the same range the
        // one above does. The engine warns on exactly `peak < workers`, so
        // "there is no warning" while a peak of 1 against 2 workers is
        // permitted asserts the absence of a warning the engine is required to
        // print — the test would fail because the engine had been honest, and
        // it would fail on the slow runner rather than here, where a failed
        // build blocks every binary. What is actually required is that the two
        // statements match.
        const { peakAssociations, workers } = payload.studies[0];
        if (peakAssociations < workers) {
          assert.match(
            stderr,
            new RegExp(`never had more than ${peakAssociations} accepted at once`),
            'a measured shortfall must be said out loud'
          );
        } else {
          assert.doesNotMatch(stderr, /never had more than/, 'nothing fell short, so nothing to warn about');
        }
        // Whichever branch ran, this is not the refused run: a peer that
        // acknowledged all ten instances accepted something.
        assert.doesNotMatch(stderr, /never had more than 0 accepted at once/);
      });
    } finally {
      scp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// When the sender gives a slot back
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stand-in peer that grants a fixed number of concurrent associations and
 * QUEUES the rest instead of refusing them.
 *
 * That is the receiver shape the width was wrong against, and it is a common
 * one: an archive at its limit that makes the next association wait rather than
 * rejecting it, so the run is clean — everything acknowledged, exit 0, no
 * rejection to notice — and the only thing that can be wrong about it is the
 * width printed beside the throughput.
 *
 * It stands in for runAssociation because the defect is a question of WHEN, and
 * the two moments it sits between are a millisecond apart against a real
 * loopback receiver: a test that raced them would be a coin toss on a slow
 * runner. Here every association has two phases that are deliberately far
 * apart — it carries the transfer and then it ENDS (A-RELEASE-RP, `onEnded`,
 * the peer's slot free, the next association admitted), and only `settleMs`
 * later does the call resolve with its byte statistics. A sender that counts
 * the slot down when the association ends measures the cap the peer really
 * enforced; one that waits for the resolution counts the departing association
 * and its replacement at the same time and reports a width the peer never
 * granted, in the flattering direction.
 *
 * `observed` is the peer's own count, kept independently of anything the sender
 * reports, so the two can be compared rather than assumed equal.
 */
function queueingPeer({ cap, transferMs = 25, settleMs = 150 }) {
  const observed = { accepted: 0, live: 0, peak: 0 };
  const waiting = [];
  let free = cap;

  const pump = () => {
    while (free > 0 && waiting.length > 0) {
      free -= 1;
      waiting.shift()();
    }
  };

  const runAssociation = async (params) => {
    // Queued, not refused: the caller waits for a slot.
    await new Promise((admit) => {
      waiting.push(admit);
      pump();
    });

    observed.accepted += 1;
    observed.live += 1;
    if (observed.live > observed.peak) observed.peak = observed.live;

    // A-ASSOCIATE-AC, then every instance acknowledged. recordAcceptedSyntaxes
    // reads the association object inside a try/catch, so an empty one will do.
    if (params.onAccepted) params.onAccepted({});
    for (const request of params.requests) {
      request.emit('response', { getStatus: () => 0x0000, getErrorComment: () => undefined });
    }

    await sleep(transferMs);

    // A-RELEASE-RP. The association is over: the peer's slot is free and the
    // next association is admitted into it here, not `settleMs` from now.
    observed.live -= 1;
    if (params.onEnded) params.onEnded();
    free += 1;
    pump();

    // Released, but not yet resolved — the window the miscount lived in.
    await sleep(settleMs);

    return {
      outcome: {
        kind: 'completed',
        label: 'Association completed',
        headline: 'The association was released normally.',
        retryable: false,
        raw: 'A-RELEASE-RP',
      },
      association: {},
      statistics: undefined,
    };
  };

  return { observed, runAssociation };
}

/**
 * Runs the command against a stand-in runAssociation.
 *
 * send.js destructures runAssociation at load, so the stand-in has to be in the
 * dimse module before send.js is required. The original module object is put
 * back afterwards, which leaves the copy every other test in this file uses
 * untouched — it captured the real function when it was first loaded.
 */
async function withStubbedAssociations(runAssociation, fn) {
  const dimsePath = require.resolve('../../src/lib/dimse');
  const sendPath = require.resolve('../../src/commands/send');
  const dimseModule = require.cache[dimsePath];
  const sendModule = require.cache[sendPath];
  const realExports = dimseModule.exports;

  dimseModule.exports = { ...realExports, runAssociation };
  delete require.cache[sendPath];

  try {
    return await fn(require(sendPath));
  } finally {
    dimseModule.exports = realExports;
    require.cache[sendPath] = sendModule;
  }
}

test('a slot is given back when the association ends, not when its statistics settle', async (t) => {
  await t.test('runAssociation announces the end before it resolves, on every path', async () => {
    // The contract the accounting rests on. runAssociation resolves once the
    // socket has closed or the close grace has expired, which is after
    // A-RELEASE-RP — by which point the peer has freed the slot and may have
    // admitted somebody else. So the end has to be announced separately, and it
    // has to be announced whatever ended the association: a path that forgot to
    // would leak a live association and raise the floor of every peak after it.
    const scp = await startScp({ acceptCallingAe: ['ALLOWED'] });
    const deadPort = await freePort();

    try {
      const scenarios = [
        { name: 'released', port: scp.port, callingAe: 'ALLOWED', kind: 'completed' },
        { name: 'rejected', port: scp.port, callingAe: 'DENIED', kind: 'rejected' },
        { name: 'no peer at all', port: deadPort, callingAe: 'ALLOWED', kind: 'transport' },
      ];

      for (const scenario of scenarios) {
        const order = [];
        let ends = 0;

        const { outcome } = await dimse.runAssociation({
          host: '127.0.0.1',
          port: scenario.port,
          callingAe: scenario.callingAe,
          calledAe: 'ANY',
          requests: [new dimse.dcmjsDimse.requests.CEchoRequest()],
          timeouts: dimse.resolveTimeouts({ connectTimeout: 5000 }),
          onEnded: () => {
            ends += 1;
            order.push('ended');
          },
        });
        order.push('resolved');

        assert.equal(outcome.kind, scenario.kind, scenario.name);
        assert.equal(ends, 1, `${scenario.name}: announced exactly once`);
        assert.deepEqual(order, ['ended', 'resolved'], `${scenario.name}: announced before it resolved`);
      }
    } finally {
      scp.close();
    }
  });

  await t.test('a peer that grants one association at a time is reported as one', async () => {
    await withTempDir('dcm-speed-slot', async (dir) => {
      const outDir = path.join(dir, 'study');
      await generate({ outDir, studies: 1, seriesPerStudy: 1, instancesPerSeries: 40, quiet: true });

      const peer = queueingPeer({ cap: 1 });
      const { code, stdout, stderr } = await withStubbedAssociations(
        peer.runAssociation,
        (stubbedSend) => runCommand(stubbedSend, [
          outDir,
          '--host', '127.0.0.1', '--port', '104', '--called-ae', 'ANY',
          '--parallel', '2', '--chunk', '10', '--retry', '0', '--json',
        ])
      );
      const payload = firstJsonDocument(stdout);

      // Nothing went wrong with the transfer: this is the quiet case, where the
      // width is the only thing that could be false.
      assert.equal(code, 0);
      assert.equal(payload.found, 40);
      assert.equal(payload.sent, 40);
      assert.equal(payload.acknowledged, 40);
      assert.equal(payload.studies[0].chunks, 4);
      assert.equal(payload.studies[0].workers, 2, 'two workers really were dispatched');

      assert.equal(peer.observed.accepted, 4, 'every chunk got its association');
      assert.equal(peer.observed.peak, 1, 'and the peer never ran more than one at a time');
      assert.equal(
        payload.studies[0].peakAssociations,
        peer.observed.peak,
        'the sender must not count a released association and its replacement together'
      );
      assert.equal(payload.parallelAchieved, 1, 'so the run reports the width it actually got');
      assert.equal(payload.associations, 4);
      assert.match(stderr, /never had more than 1 accepted at once/, 'and says the width fell short');
    });
  });

  await t.test('a peer that grants two is reported as two', async () => {
    // The other direction, so the number above is a measurement rather than a
    // reflex: the same run against a peer with room for both workers reports 2
    // and has nothing to warn about.
    await withTempDir('dcm-speed-slot-wide', async (dir) => {
      const outDir = path.join(dir, 'study');
      await generate({ outDir, studies: 1, seriesPerStudy: 1, instancesPerSeries: 40, quiet: true });

      // A transfer phase long enough that a stalled runner cannot make the two
      // workers miss each other: they are admitted in the same microtask drain,
      // and this is the window they then share.
      const peer = queueingPeer({ cap: 2, transferMs: 100 });
      const { code, stdout, stderr } = await withStubbedAssociations(
        peer.runAssociation,
        (stubbedSend) => runCommand(stubbedSend, [
          outDir,
          '--host', '127.0.0.1', '--port', '104', '--called-ae', 'ANY',
          '--parallel', '2', '--chunk', '10', '--retry', '0', '--json',
        ])
      );
      const payload = firstJsonDocument(stdout);

      assert.equal(code, 0);
      assert.equal(payload.acknowledged, 40);
      assert.equal(peer.observed.peak, 2);
      assert.equal(payload.studies[0].peakAssociations, 2);
      assert.equal(payload.parallelAchieved, 2);
      assert.doesNotMatch(stderr, /never had more than/);
    });
  });
});

test('--speed is documented, including what it costs the receiver', () => {
  const usage = send.USAGE;
  for (const name of ['normal', 'fast', 'very-fast', 'insane']) {
    assert.match(usage, new RegExp(name), `USAGE should describe --speed ${name}`);
  }
  assert.match(usage, /REJECTED/, 'the ceiling is the receiver, and rejection is how exceeding it shows up');
  assert.match(usage, /benchmark/, "'insane' should read as a benchmark setting, not a default");
});

test('a one-association run never blames a concurrency limit', async (t) => {
  // v0.14.0 shipped this warning ungated, so the tool's DEFAULT configuration
  // — one association, no --speed, no --parallel — greeted an unreachable PACS
  // by telling the operator to lower --parallel. At one association there is no
  // "rest" for the peer to refuse and nothing that could have overlapped, so
  // the only way to reach the check is a peer that accepted nothing at all,
  // which the shortfall and the exit code already report correctly. Pointing at
  // a concurrency limit that is not involved sends the reader looking in the
  // wrong place on the most common failure mode there is.
  await withTempDir('dcm-speed-oneassoc', async (dir) => {
    await generate({ outDir: dir, studies: 1, seriesPerStudy: 1, instancesPerSeries: 6, quiet: true });
    // A port nothing is listening on: freePort reserves and releases one.
    const dead = await freePort();
    const peer = ['--host', '127.0.0.1', '--port', String(dead), '--called-ae', 'NOPE',
      '--connect-timeout', '800', '--retry', '0'];

    await t.test('one association: absent, and the failure is still reported', async () => {
      const { code, stderr } = await runCommand(send, [dir, ...peer]);
      assert.equal(code, 1, 'an unreachable peer is a failed transfer');
      assert.doesNotMatch(stderr, /never had more than/);
      assert.doesNotMatch(stderr, /lower --parallel or --speed/);
    });

    await t.test('several associations: still fires, because there the reading is real', async () => {
      const { code, stderr } = await runCommand(send, [dir, ...peer, '--parallel', '4', '--chunk', '2']);
      assert.equal(code, 1);
      assert.match(stderr, /never had more than 0 accepted at once/);
    });
  });
});
