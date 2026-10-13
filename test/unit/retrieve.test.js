'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RetrieveStatus,
  hex,
  isRefusal,
  explainStatus,
  verdict,
  makeReportedCounts,
} = require('../../src/lib/retrieve');
const {
  matchInstances, findMatches, makeSubOperationTally, parseDestination,
} = require('../../src/lib/qr-serve');
const { generate } = require('../../tools/make-fixtures');

/**
 * What this file is defending.
 *
 * A retrieve has two witnesses to the same transfer — the counts the peer
 * reports, and the files that exist afterwards — and the only outcome that
 * actually hurts anyone is the one where they disagree and the disagreement is
 * not noticed. A peer that says it completed 5215 sub-operations while 5200
 * files landed looks perfectly healthy in a progress log, and the study a
 * radiologist opens is short fifteen images.
 *
 * So the bulk of this file is verdict(): every way the two witnesses can
 * disagree, and the one case where there is deliberately no second witness at
 * all (a C-MOVE to somebody else's AE Title). None of it touches a socket.
 * The loopback end-to-end proof that the shipped SCU and the shipped SCP agree
 * lives in the e2e suite; what is tested here is the accounting those tests
 * depend on being right, including the shapes a real association is awkward to
 * provoke on demand — a peer that reports no counts at all, a peer that ends
 * on Success while admitting failures, a vendor status nobody has defined.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempDirs = [];

/** A temp directory removed when the process exits. */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcm-retrieve-test-${label}-`));
  tempDirs.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let servedPromise;

/**
 * One synthetic study of two series of three instances, generated once.
 *
 * Generated rather than read from anywhere: `fixtures/` at the repo root is
 * gitignored, so a test that reads it passes only on a machine where an
 * earlier run happened to leave it behind — see test-hygiene.test.js for the
 * release that cost. outDir is passed explicitly because generate() otherwise
 * defaults to the repo root and begins with an rmSync.
 *
 * Six instances is enough to prove every narrowing: 6 at study level, 3 at
 * series level, 1 at image level.
 */
function served() {
  if (!servedPromise) {
    servedPromise = (async () => {
      const dir = tempDir('serve');
      const manifest = await generate({
        outDir: dir,
        quiet: true,
        studies: 1,
        seriesPerStudy: 2,
        instancesPerSeries: 3,
      });
      const study = manifest.studies[0];
      return {
        dir,
        studyUid: study.studyInstanceUid,
        seriesUid: study.series[0].seriesInstanceUid,
        sopUid: study.series[0].instances[0].sopInstanceUid,
        total: manifest.totalInstances,
      };
    })();
  }
  return servedPromise;
}

/** The peer's accounting, in the shape makeReportedCounts() leaves it. */
function reported(overrides = {}) {
  return {
    completed: 0,
    failures: 0,
    warnings: 0,
    remaining: undefined,
    counted: true,
    ...overrides,
  };
}

/** What this end can prove: what was written, and the two ways one is lost. */
function tally(overrides = {}) {
  return { written: 0, unreadable: 0, duplicates: 0, ...overrides };
}

/** The problems list as one string, for substring assertions. */
function joined(assessment) {
  return assessment.problems.join(' | ');
}

// ---------------------------------------------------------------------------
// The status map, hex() and isRefusal()
// ---------------------------------------------------------------------------

test('the retrieve statuses are the wire values and the map cannot be edited', () => {
  // These are read off PS3.4 and go on the wire; a typo here is a status the
  // peer never sent being explained to the operator. Spelled out as literals
  // deliberately, so the test fails rather than agreeing with a changed map.
  assert.equal(RetrieveStatus.SUCCESS, 0x0000);
  assert.equal(RetrieveStatus.CANCEL, 0xfe00);
  assert.equal(RetrieveStatus.SUBOPS_FAILED, 0xb000);
  assert.equal(RetrieveStatus.OUT_OF_RESOURCES_MATCHES, 0xa701);
  assert.equal(RetrieveStatus.OUT_OF_RESOURCES_SUBOPS, 0xa702);
  assert.equal(RetrieveStatus.MOVE_DESTINATION_UNKNOWN, 0xa801);
  assert.equal(RetrieveStatus.IDENTIFIER_MISMATCH, 0xa900);
  assert.equal(RetrieveStatus.PROCESSING_FAILURE, 0x0110);
  assert.equal(RetrieveStatus.SOP_CLASS_NOT_SUPPORTED, 0x0122);

  assert.ok(Object.isFrozen(RetrieveStatus));
});

test('hex formats a status as four digits and says plainly when there is none', () => {
  assert.equal(hex(0x0110), '0x0110');
  assert.equal(hex(0x0000), '0x0000');
  assert.equal(hex(0xa801), '0xA801');

  // A peer that released without a final response leaves the status
  // undefined. '(none)' rather than '0x0000' or 'undefined', because those
  // both read as "the peer said it was fine".
  assert.equal(hex(undefined), '(none)');
  assert.equal(hex(null), '(none)');
});

test('isRefusal covers the whole vendor-defined C-xxxx range, not just known codes', () => {
  for (const code of [0xc000, 0xc123, 0xcfff]) {
    assert.equal(isRefusal(code), true, hex(code));
  }
  for (const code of [
    RetrieveStatus.OUT_OF_RESOURCES_MATCHES,
    RetrieveStatus.OUT_OF_RESOURCES_SUBOPS,
    RetrieveStatus.MOVE_DESTINATION_UNKNOWN,
    RetrieveStatus.IDENTIFIER_MISMATCH,
    RetrieveStatus.PROCESSING_FAILURE,
    RetrieveStatus.SOP_CLASS_NOT_SUPPORTED,
  ]) {
    assert.equal(isRefusal(code), true, hex(code));
  }

  // Success, the warning the peer sends when sub-operations failed, and a
  // cancel are all outcomes of a retrieve that ran. They are failures to this
  // tool's client, but they are not refusals, and the explanation differs.
  for (const code of [0x0000, 0xb000, 0xfe00, undefined]) {
    assert.equal(isRefusal(code), false, hex(code));
  }
});

// ---------------------------------------------------------------------------
// explainStatus()
// ---------------------------------------------------------------------------

test('a success and a missing status need no explaining', () => {
  assert.equal(explainStatus(RetrieveStatus.SUCCESS, { service: 'get' }), undefined);
  assert.equal(explainStatus(undefined, { service: 'move' }), undefined);
});

test('an unknown move destination names the AE and points at dcm get', () => {
  const explained = explainStatus(RetrieveStatus.MOVE_DESTINATION_UNKNOWN, {
    service: 'move',
    destinationAe: 'VIEWER-1',
  });

  assert.match(explained.headline, /VIEWER-1/, 'the headline must name the AE that was refused');
  assert.match(explained.headline, /0xA801/);

  // This is the one failure in the whole feature that cannot be fixed from
  // this side: C-MOVE carries an AE Title and no address, so the hint has to
  // say both repairs — register the Title on the archive, or stop needing it.
  assert.match(explained.hint, /registered/i);
  assert.match(explained.hint, /VIEWER-1/);
  assert.match(explained.hint, /dcm get/);

  // Without a destination the message still has to stand on its own rather
  // than printing an empty quoted string.
  const anonymous = explainStatus(RetrieveStatus.MOVE_DESTINATION_UNKNOWN, { service: 'move' });
  assert.match(anonymous.headline, /0xA801/);
  assert.doesNotMatch(anonymous.headline, /""/);
  assert.match(anonymous.hint, /destination AE Title/);
});

test('a peer that will not perform the service is pointed at the other service', () => {
  // The practical value of these two statuses is the redirection: an archive
  // that negotiates C-GET and refuses it very often performs C-MOVE, and the
  // reverse. A hint that names the service the reader already tried wastes
  // the only clue they have.
  for (const code of [
    RetrieveStatus.SOP_CLASS_NOT_SUPPORTED,
    RetrieveStatus.PROCESSING_FAILURE,
  ]) {
    const fromGet = explainStatus(code, { service: 'get' });
    assert.match(fromGet.hint, /dcm move/, `${hex(code)} from get should suggest move`);
    assert.doesNotMatch(fromGet.hint, /dcm get/, `${hex(code)} from get must not suggest get`);

    const fromMove = explainStatus(code, { service: 'move' });
    assert.match(fromMove.hint, /dcm get/, `${hex(code)} from move should suggest get`);
    assert.doesNotMatch(fromMove.hint, /dcm move/, `${hex(code)} from move must not suggest move`);

    assert.match(fromGet.headline, new RegExp(hex(code)));
  }
});

test('every status a retrieve can end on explains itself', () => {
  for (const code of [
    RetrieveStatus.CANCEL,
    RetrieveStatus.SUBOPS_FAILED,
    RetrieveStatus.OUT_OF_RESOURCES_MATCHES,
    RetrieveStatus.OUT_OF_RESOURCES_SUBOPS,
    RetrieveStatus.IDENTIFIER_MISMATCH,
  ]) {
    const explained = explainStatus(code, { service: 'get' });
    assert.ok(explained, `${hex(code)} needs an explanation`);
    assert.ok(explained.headline.length > 20, `${hex(code)} headline is too thin to help`);
    assert.ok(explained.hint, `${hex(code)} needs to say what to do next`);
  }

  // 0xB000 is a WARNING in the standard and a failure to this tool. The
  // explanation has to say so out loud, or the reader reasonably concludes
  // from the standard that the retrieve was fine.
  const warned = explainStatus(RetrieveStatus.SUBOPS_FAILED, { service: 'get' });
  assert.match(warned.hint, /WARNING/);

  // A cancel keeps whatever arrived, so the hint must not imply a clean slate.
  assert.match(explainStatus(RetrieveStatus.CANCEL, { service: 'get' }).hint, /incomplete/i);
});

test('a vendor C-xxxx failure sends the reader to the peer own log', () => {
  const explained = explainStatus(0xc123, { service: 'get' });

  assert.equal(isRefusal(0xc123), true);
  assert.match(explained.headline, /refused/i);
  assert.match(explained.headline, /0xC123/);
  // There is nothing honest to say about the meaning of a vendor code, so the
  // hint says exactly that instead of guessing.
  assert.match(explained.hint, /log/);
});

test('a status nobody defined still explains itself instead of throwing', () => {
  for (const code of [0x7777, 0xa700, 0x0001]) {
    const explained = explainStatus(code, { service: 'get' });
    assert.ok(explained, `${hex(code)} must still produce something to print`);
    assert.ok(explained.headline.includes(hex(code)), `${hex(code)} must appear in its own headline`);
  }

  // The fallback exists so an unrecognised status is reported honestly rather
  // than translated into a guess.
  assert.match(explainStatus(0x7777, { service: 'get' }).headline, /unexpected/i);
  assert.match(explainStatus(0x7777, { service: 'get' }).hint, /--verbose/);

  // Called with no context at all, which is what a caller that has not
  // decided which service it is does.
  assert.ok(explainStatus(0x0110).headline);
});

// ---------------------------------------------------------------------------
// verdict() — the heart of it
// ---------------------------------------------------------------------------

test('a retrieve where both witnesses agree is a success with nothing to report', () => {
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10, remaining: 0 }),
    tally: tally({ written: 10 }),
    refused: 0,
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, true, joined(assessment));
  assert.deepEqual(assessment.problems, []);
  assert.equal(assessment.shortfall, 0);
});

test('a peer that reports more sent than landed on disk is a failure with the gap named', () => {
  // THE test. The partial implementation this replaced compared nothing and
  // would have exited 0 here, which is the single most expensive thing a
  // retrieve tool can do: three images short, reported as complete.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 13 }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.equal(assessment.shortfall, 3);

  // Both numbers have to be in the message. "3 missing" alone leaves the
  // reader unable to tell whether the peer or this end is the liar.
  const problem = assessment.problems.find((p) => p.includes('on disk'));
  assert.ok(problem, joined(assessment));
  assert.match(problem, /13/);
  assert.match(problem, /10/);
  assert.match(problem, /3 missing/);
});

test('more files on disk than the peer claims is not a shortfall', () => {
  // The comparison is one-directional on purpose. An output directory that
  // already held instances, or a peer that undercounts, is not a loss — and
  // reporting a negative shortfall as a failure would make `dcm get` into an
  // existing folder permanently red.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 5 }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, true, joined(assessment));
  assert.equal(assessment.shortfall, 0);
});

test('an instance that arrived and could not be written is a loss', () => {
  // The counts agree with each other and the study is still incomplete: the
  // peer sent ten, ten sub-operations settled, and one of them never reached
  // the disk. Only this end knows that.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 10, unreadable: 1 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /could not be written/);
});

test('one SOP Instance UID arriving twice is a loss, not a bonus', () => {
  // Two sub-operations under one UID means the second overwrote the first:
  // eleven arrived, ten exist, and one instance of the study is gone.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 10, duplicates: 2 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /arrived twice/);
});

test('sub-operations this end answered as failures are a loss', () => {
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 10 }),
    refused: 2,
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /answered as failures by this end/);
});

test('failures the peer admits are not forgiven by a Success status', () => {
  // Observed in the field and permitted by the standard's wording: a peer can
  // report a non-zero failure count and still end the retrieve on Success.
  // Reading the status alone would call this a clean transfer.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10, failures: 2 }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /2 sub-operation\(s\) failed/);
});

test('a retrieve where nothing arrived fails even on a Success status', () => {
  // Distinct from a shortfall, and the cause is different: a study UID that
  // matched nothing, or a peer that holds the study and will not release it
  // to this calling AE Title.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 0 }),
    tally: tally({ written: 0 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /no instances arrived/);
});

test('a peer that sent no counts at all cannot vacuously validate a retrieve', () => {
  // Sub-operation counts are optional on the wire. If an absent count were
  // read as zero, `completed > written` would be false for every retrieve
  // from such a peer and the comparison that this whole module exists for
  // would quietly never run. So counted=false switches the comparison off
  // instead of passing it: ten files arrived and are accepted on the only
  // evidence there is.
  const delivered = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 0, counted: false }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });
  assert.equal(delivered.ok, true, joined(delivered));
  assert.equal(delivered.shortfall, 0);

  // And the other half of the same rule: switching the comparison off must
  // not make a silent peer able to validate a retrieve that delivered
  // nothing. The disk is still checked.
  const empty = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 0, counted: false }),
    tally: tally({ written: 0 }),
    expectLocalFiles: true,
  });
  assert.equal(empty.ok, false);
  assert.match(joined(empty), /no instances arrived/);
});

test('a move to a third-party destination is not judged by this local disk', () => {
  // The images went to somebody else's AE Title. There is no local disk to
  // compare against, so the comparison is switched off — comparing zero files
  // here against ten sent there would fail every successful third-party move.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 0 }),
    expectLocalFiles: false,
  });

  assert.equal(assessment.ok, true, joined(assessment));
  assert.equal(assessment.shortfall, 0);
});

test('sub-operations this end refused are a loss on a third-party move too', () => {
  // An admitted failure has to reach the verdict wherever the images were
  // headed. This once sat inside the local-files branch, so a third-party move
  // with two refused sub-operations came back ok with nothing to report.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 0 }),
    refused: 2,
    expectLocalFiles: false,
  });

  assert.equal(assessment.ok, false, 'a refused sub-operation must never be forgiven');
  assert.match(joined(assessment), /2 sub-operation\(s\) were answered as failures/);
});

test('out of resources and identifier mismatch are matched as bands, not exact codes', () => {
  // The standard fixes the high byte and products vary the low one, so
  // 0xA700 and 0xA7FF mean what 0xA701 means. status.js already matches them
  // by range for C-STORE; a retrieve must not give the same code a worse
  // message than a send does.
  for (const code of [0xa700, 0xa7ff, 0xa900, 0xa9ff]) {
    assert.equal(isRefusal(code), true, hex(code));
  }
  assert.match(explainStatus(0xa7ff, { service: 'get' }).hint, /one series at a time/);
  assert.match(explainStatus(0xa9ff, { service: 'get' }).headline, /identifier/);
  // And the codes with sentences of their own keep them.
  assert.match(explainStatus(0xa702, { service: 'get' }).headline, /part way through/);
});

test('a third-party move the peer itself says moved nothing is a failure', () => {
  // With no disk to check, the peer's own zero is the only evidence there is
  // — and it is conclusive. This is the counterpart that stops the
  // expectLocalFiles=false branch from being an unconditional pass.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 0 }),
    tally: tally({ written: 0 }),
    expectLocalFiles: false,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /sent no instances/);
});

test('a silent peer on a third-party move is not read as having moved nothing', () => {
  // Same rule as the local case: a count the peer omitted is not a zero, so
  // it must not be turned into "it sent nothing" either.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 0, counted: false }),
    tally: tally({ written: 0 }),
    expectLocalFiles: false,
  });

  assert.equal(assessment.ok, true, joined(assessment));
});

test('a warning final status fails even when the disk agrees with the peer', () => {
  // 0xB000 means the peer knows some sub-operation did not succeed. The
  // counts can still line up — the peer reports what it managed to send and
  // that is what landed — and the study is still short whatever it gave up
  // on. The status alone is decisive here.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUBOPS_FAILED,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /final status was 0xB000/);
  assert.equal(assessment.shortfall, 0, 'nothing is missing from disk; only the status failed');
});

test('a refusal status is reported as a problem without re-deriving it', () => {
  for (const code of [
    RetrieveStatus.MOVE_DESTINATION_UNKNOWN,
    RetrieveStatus.PROCESSING_FAILURE,
    RetrieveStatus.CANCEL,
    0xc123,
  ]) {
    const assessment = verdict({
      finalStatus: code,
      reported: reported({ completed: 0, counted: false }),
      tally: tally({ written: 0 }),
      expectLocalFiles: false,
    });
    assert.equal(assessment.ok, false, hex(code));
    assert.match(joined(assessment), new RegExp(`final status was ${hex(code)}`));
  }
});

test('a peer that never sent a final response is judged on the disk alone', () => {
  // A legal-but-rude peer: Pending responses, then A-RELEASE, and no final
  // status. There is nothing to quote, so an undefined status contributes no
  // problem of its own and the files are left to speak. Locking the
  // behaviour in because the alternative — treating "no status" as a failure
  // — would turn a delivered study into exit 1, and because the opposite
  // mistake, defaulting it to Success, would be invisible.
  const delivered = verdict({
    finalStatus: undefined,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });
  assert.equal(delivered.ok, true, joined(delivered));
  assert.deepEqual(delivered.problems, []);

  // The disk still has the last word, so silence plus a short count still
  // fails, and still names the gap.
  const short = verdict({
    finalStatus: undefined,
    reported: reported({ completed: 10 }),
    tally: tally({ written: 4 }),
    expectLocalFiles: true,
  });
  assert.equal(short.ok, false);
  assert.equal(short.shortfall, 6);
  assert.doesNotMatch(joined(short), /final status/, 'there was no status to report');
});

test('a retrieve that lost instances in several ways reports every one of them', () => {
  // The operator gets one chance to read this. Stopping at the first problem
  // would have them fix the duplicate and re-run to discover the shortfall.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUBOPS_FAILED,
    reported: reported({ completed: 13, failures: 1 }),
    tally: tally({ written: 10, unreadable: 1, duplicates: 1 }),
    refused: 1,
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.equal(assessment.shortfall, 3);
  for (const expected of [
    /final status was 0xB000/,
    /1 sub-operation\(s\) failed/,
    /could not be written/,
    /arrived twice/,
    /answered as failures by this end/,
    /3 missing/,
  ]) {
    assert.match(joined(assessment), expected);
  }
  assert.equal(assessment.problems.length, 6, joined(assessment));
});

test('a reported warning count alone does not fail a complete retrieve', () => {
  // A warned sub-operation is one the receiver stored and altered — coercion
  // of a patient ID, most often. The instance is on disk, so this is not a
  // loss and must not be reported as one; the peer's status is what escalates
  // it if it matters.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ completed: 10, warnings: 3 }),
    tally: tally({ written: 10 }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, true, joined(assessment));
});

test('verdict defaults the local tally rather than throwing on a caller that omits it', () => {
  // Called the way an error path does, with nothing proved yet.
  const assessment = verdict({
    finalStatus: RetrieveStatus.SUCCESS,
    reported: reported({ counted: false }),
    expectLocalFiles: true,
  });

  assert.equal(assessment.ok, false);
  assert.match(joined(assessment), /no instances arrived/);
});

// ---------------------------------------------------------------------------
// makeReportedCounts()
// ---------------------------------------------------------------------------

/** A response carrying exactly the counts named, as the library models one. */
function fakeResponse(counts = {}) {
  return {
    getCompleted: () => counts.completed,
    getFailures: () => counts.failures,
    getWarnings: () => counts.warnings,
    getRemaining: () => counts.remaining,
  };
}

test('the reported counts keep the last value the peer gave', () => {
  const counts = makeReportedCounts();

  assert.deepEqual(counts.state, {
    completed: 0,
    failures: 0,
    warnings: 0,
    remaining: undefined,
    counted: false,
  });

  // A C-GET reports cumulative totals on every Pending response, so the last
  // one is the answer — not the sum, which would multiply the study.
  counts.absorb(fakeResponse({ completed: 4, failures: 0, warnings: 0, remaining: 6 }));
  counts.absorb(fakeResponse({ completed: 9, failures: 1, warnings: 0, remaining: 0 }));

  assert.equal(counts.state.completed, 9);
  assert.equal(counts.state.failures, 1);
  assert.equal(counts.state.remaining, 0);
  assert.equal(counts.state.counted, true);

  // absorb() returns the same live object it accumulates into, which is what
  // lets a command hold one reference and read it after the association.
  assert.equal(counts.absorb(fakeResponse({ completed: 10 })), counts.state);
  assert.equal(counts.state.completed, 10);
});

test('a count the peer omitted leaves the previous value and never becomes a zero', () => {
  const counts = makeReportedCounts();
  counts.absorb(fakeResponse({ completed: 7, failures: 2, warnings: 1, remaining: 3 }));

  // The final response of a real retrieve frequently carries fewer counts
  // than the Pending ones did. Folding an absent count in as zero would erase
  // what the peer already said — and erasing a failure count is how a lossy
  // retrieve starts looking clean.
  counts.absorb(fakeResponse({}));
  assert.equal(counts.state.completed, 7);
  assert.equal(counts.state.failures, 2);
  assert.equal(counts.state.warnings, 1);
  assert.equal(counts.state.remaining, 3);

  // A response with no count accessors at all — the shape a different
  // library version hands back — must not throw either.
  counts.absorb({});
  assert.equal(counts.state.completed, 7);
});

test('a response that reports nothing leaves counted false', () => {
  // This is the flag the disk comparison hangs off, so it has to stay false
  // until the peer actually says a number. A peer that answers and reports
  // nothing is "unknown", not "none".
  const counts = makeReportedCounts();
  counts.absorb(fakeResponse({}));
  assert.equal(counts.state.counted, false);
  assert.equal(counts.state.completed, 0);

  counts.absorb({});
  assert.equal(counts.state.counted, false);
});

test('counted flips as soon as any single count arrives, even a zero one', () => {
  // A peer that says "completed: 0" has told us something, and that zero is
  // evidence — it is what makes an empty retrieve a reportable failure
  // rather than an unknown. Each of the three counts has to be enough on its
  // own, since peers vary in which they send.
  for (const counts of [{ completed: 0 }, { failures: 0 }, { warnings: 0 }]) {
    const accumulator = makeReportedCounts();
    accumulator.absorb(fakeResponse(counts));
    assert.equal(accumulator.state.counted, true, JSON.stringify(counts));
    assert.equal(accumulator.state.completed, 0);
  }

  // Remaining is the exception: it is a progress indicator, not an outcome,
  // and a peer that sends only Remaining has still said nothing about what
  // it managed to send.
  const progressOnly = makeReportedCounts();
  progressOnly.absorb(fakeResponse({ remaining: 5 }));
  assert.equal(progressOnly.state.remaining, 5);
  assert.equal(progressOnly.state.counted, false);
});

// ---------------------------------------------------------------------------
// makeSubOperationTally() — the serving side's accounting
// ---------------------------------------------------------------------------

/** C-STORE Success, which is the same 0x0000 the retrieve map calls SUCCESS. */
const STORE_SUCCESS = 0x0000;

test('sub-operation statuses are sorted into completed, warned and failed', () => {
  const tallied = makeSubOperationTally(7);

  tallied.record(STORE_SUCCESS);
  tallied.record(STORE_SUCCESS);

  // The three warning store statuses: coercion, elements discarded, and the
  // data-set-does-not-match variant. The instance was stored, so these are
  // not failures — but they are not clean either.
  for (const warning of [0xb000, 0xb006, 0xb007]) tallied.record(warning);

  // Anything else is a failure, including a cancel: from the tally's point of
  // view the only question is whether the instance is at the far end.
  tallied.record(0x0110);
  tallied.record(0xfe00);

  assert.equal(tallied.completed, 2);
  assert.equal(tallied.warnings, 3);
  assert.equal(tallied.failures, 2);
  assert.equal(tallied.settled, 7);

  // A sub-operation is counted exactly once, in exactly one bucket. A pending
  // response whose counts do not add up to what it promised is worse than no
  // pending response at all.
  assert.equal(tallied.completed + tallied.warnings + tallied.failures, tallied.settled);
});

test('remaining counts down to zero and never goes negative', () => {
  const tallied = makeSubOperationTally(2);
  assert.equal(tallied.remaining, 2);

  tallied.record(STORE_SUCCESS);
  assert.equal(tallied.remaining, 1);

  tallied.record(STORE_SUCCESS);
  assert.equal(tallied.remaining, 0);

  // A retrieve that somehow settles more sub-operations than it started must
  // not put a negative Remaining on the wire: the field is unsigned, and a
  // client reading 65535 remaining would wait for a study that is finished.
  tallied.record(STORE_SUCCESS);
  assert.equal(tallied.remaining, 0);
  assert.equal(tallied.settled, 3);
});

test('the served final status is Success only when nothing failed or warned', () => {
  const clean = makeSubOperationTally(2);
  clean.record(STORE_SUCCESS);
  clean.record(STORE_SUCCESS);
  // Asserted against the client's own constant on purpose: the SCP stamps
  // this value and the SCU compares against RetrieveStatus.SUCCESS, so the
  // two modules agreeing on 0x0000 is the thing worth pinning.
  assert.equal(clean.finalStatus, RetrieveStatus.SUCCESS);

  // Fresh, before anything settles, it reads as Success. That is why serveGet
  // only passes the final response to its callback once the last
  // sub-operation has settled — read early, this would say the retrieve
  // succeeded before a single instance had been sent.
  assert.equal(makeSubOperationTally(5).finalStatus, RetrieveStatus.SUCCESS);

  const failed = makeSubOperationTally(2);
  failed.record(STORE_SUCCESS);
  failed.record(0x0110);
  assert.equal(failed.finalStatus, RetrieveStatus.SUBOPS_FAILED);

  // A warning is enough. The standard's 0xB000 is "sub-operations complete,
  // one or more failures" and this tool's client treats it as a failure,
  // deliberately: part of the study did not arrive intact.
  const warned = makeSubOperationTally(2);
  warned.record(STORE_SUCCESS);
  warned.record(0xb000);
  assert.equal(warned.finalStatus, RetrieveStatus.SUBOPS_FAILED);
});

// ---------------------------------------------------------------------------
// matchInstances() — what the serving side decides to send
// ---------------------------------------------------------------------------

test('a study-level identifier matches every instance in the study', async () => {
  const fixture = await served();
  const result = matchInstances(fixture.dir, {
    QueryRetrieveLevel: 'STUDY',
    StudyInstanceUID: fixture.studyUid,
  });

  assert.equal(result.problem, undefined);
  assert.equal(result.level, 'STUDY');
  assert.equal(result.instances.length, fixture.total);
  assert.equal(result.instances.length, 6);
  for (const instance of result.instances) {
    assert.equal(instance.studyInstanceUid, fixture.studyUid);
    assert.ok(fs.existsSync(instance.path), 'a matched instance must be a file that can be sent');
  }

  // An identifier with no level at all is treated as a study-level retrieve
  // rather than refused, because that is what the Unique Keys given mean.
  const implied = matchInstances(fixture.dir, { StudyInstanceUID: fixture.studyUid });
  assert.equal(implied.level, 'STUDY');
  assert.equal(implied.instances.length, 6);
});

test('a series-level identifier narrows to that series', async () => {
  const fixture = await served();
  const result = matchInstances(fixture.dir, {
    QueryRetrieveLevel: 'SERIES',
    StudyInstanceUID: fixture.studyUid,
    SeriesInstanceUID: fixture.seriesUid,
  });

  assert.equal(result.problem, undefined);
  assert.equal(result.instances.length, 3);
  for (const instance of result.instances) {
    assert.equal(instance.seriesInstanceUid, fixture.seriesUid);
  }

  // The level arrives as a CS from whatever client sent it; case is not a
  // reason to refuse a retrieve.
  const lowercase = matchInstances(fixture.dir, {
    QueryRetrieveLevel: 'series',
    StudyInstanceUID: fixture.studyUid,
    SeriesInstanceUID: fixture.seriesUid,
  });
  assert.equal(lowercase.level, 'SERIES');
  assert.equal(lowercase.instances.length, 3);
});

test('an image-level identifier with its series and SOP UID matches one instance', async () => {
  const fixture = await served();
  const result = matchInstances(fixture.dir, {
    QueryRetrieveLevel: 'IMAGE',
    StudyInstanceUID: fixture.studyUid,
    SeriesInstanceUID: fixture.seriesUid,
    SOPInstanceUID: fixture.sopUid,
  });

  assert.equal(result.problem, undefined);
  assert.equal(result.level, 'IMAGE');
  assert.equal(result.instances.length, 1);
  assert.equal(result.instances[0].sopInstanceUid, fixture.sopUid);
});

test('an image-level identifier without a SeriesInstanceUID is refused', async () => {
  // PS3.4 C.4.2.1.4.1: an image-level identifier carries the Unique Keys of
  // every level above it. Answering this one by guessing which series was
  // meant is how the wrong image gets sent.
  const fixture = await served();
  const result = matchInstances(fixture.dir, {
    QueryRetrieveLevel: 'IMAGE',
    StudyInstanceUID: fixture.studyUid,
    SOPInstanceUID: fixture.sopUid,
  });

  assert.ok(result.problem, 'an incomplete image-level identifier must be refused');
  assert.equal(result.problem.status, RetrieveStatus.IDENTIFIER_MISMATCH);
  assert.match(result.problem.comment, /SeriesInstanceUID/);
  assert.deepEqual(result.instances, []);
});

test('an identifier with no study UID is refused and matches nothing at all', async () => {
  const fixture = await served();

  for (const elements of [
    { QueryRetrieveLevel: 'STUDY' },
    { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '' },
    { QueryRetrieveLevel: 'SERIES', SeriesInstanceUID: fixture.seriesUid },
    undefined,
  ]) {
    const result = matchInstances(fixture.dir, elements);

    assert.ok(result.problem, JSON.stringify(elements));
    assert.equal(result.problem.status, RetrieveStatus.IDENTIFIER_MISMATCH);
    assert.match(result.problem.comment, /StudyInstanceUID/);

    // The assertion that matters more than the status: the match list is
    // EMPTY. A relational retrieve is not supported, and an identifier that
    // names no study must never widen to everything on disk — that is how a
    // test fixture becomes a 40 GB transfer, and how a careless caller that
    // ignores `problem` ships the whole archive.
    assert.deepEqual(result.instances, [], 'a missing study UID must not widen the retrieve');
  }
});

test('a study the receiver does not hold is an empty success, not a failure', async () => {
  // The request was understood and performed; the answer is that there is
  // nothing. A client needs this to be distinguishable from "I broke",
  // because the two have completely different next steps.
  const fixture = await served();
  const result = matchInstances(fixture.dir, {
    QueryRetrieveLevel: 'STUDY',
    StudyInstanceUID: '1.2.826.0.1.3680043.10.1337.999999',
  });

  assert.equal(result.problem, undefined, 'not holding a study is not an error');
  assert.deepEqual(result.instances, []);
});

test('a serve directory that is not there is a processing failure, not a crash', async () => {
  // The receiver is long-lived: the folder it serves can be unmounted or
  // renamed under it. That has to come back as a status the client can read,
  // not an exception that takes the association down.
  const fixture = await served();
  const missing = path.join(fixture.dir, 'not-a-folder');

  const result = matchInstances(missing, {
    QueryRetrieveLevel: 'STUDY',
    StudyInstanceUID: fixture.studyUid,
  });

  assert.ok(result.problem);
  assert.equal(result.problem.status, RetrieveStatus.PROCESSING_FAILURE);
  assert.match(result.problem.comment, /cannot read/i);
  assert.deepEqual(result.instances, []);
});

// ---------------------------------------------------------------------------
// parseDestination()
// ---------------------------------------------------------------------------

test('a destination parses into AE, host and port with the AE upper-cased', () => {
  assert.deepEqual(parseDestination('VIEWER=127.0.0.1:11113'), {
    ae: 'VIEWER',
    host: '127.0.0.1',
    port: 11113,
  });

  // AE Titles are case-sensitive on the wire but conventionally upper case,
  // and the registry is looked up with .toUpperCase() in serveMove — so the
  // key has to be stored the same way or a lower-case --destination would be
  // accepted at startup and then answered 0xA801 at use.
  assert.deepEqual(parseDestination('viewer=localhost:104'), {
    ae: 'VIEWER',
    host: 'localhost',
    port: 104,
  });

  // Whitespace around either side of a shell-quoted argument.
  assert.deepEqual(parseDestination('  VIEWER = 10.0.0.1 : 104 '), {
    ae: 'VIEWER',
    host: '10.0.0.1',
    port: 104,
  });

  // The ends of the port range, which an off-by-one in the bounds check
  // would reject.
  assert.equal(parseDestination('AE=host:1').port, 1);
  assert.equal(parseDestination('AE=host:65535').port, 65535);
});

test('the last colon separates the port, so an IPv6 literal survives', () => {
  // Splitting on the first colon turns ::1 into the host ':' and loses the
  // rest, which fails at connect time with a message about an address nobody
  // typed.
  assert.deepEqual(parseDestination('V6=::1:11112'), { ae: 'V6', host: '::1', port: 11112 });
  assert.deepEqual(parseDestination('V6=fe80::1:104'), { ae: 'V6', host: 'fe80::1', port: 104 });
});

test('every malformed destination throws, and the message says what the form is', () => {
  // A --destination this receiver cannot parse has to fail at startup. The
  // alternative is a registry that silently lacks the AE Title and a C-MOVE
  // refused 0xA801 hours later, which reads as the peer's fault.
  for (const raw of ['no-equals', '=host:104', '', undefined, null]) {
    assert.throws(() => parseDestination(raw), /AE=host:port/, JSON.stringify(raw));
  }

  // Present but incomplete: these report against the AE Title they did
  // manage to read, so the operator can tell which of several
  // --destination flags is the broken one.
  for (const raw of ['AE=hostonly', 'AE=']) {
    assert.throws(() => parseDestination(raw), /host:port/, JSON.stringify(raw));
  }

  // A port with nothing in front of it says that the HOST is what is missing,
  // rather than repeating the general form at someone who clearly knows it.
  assert.throws(() => parseDestination('AE=:11112'), /no host before the port/);

  // A port that is not a port. Port 0 means "any free port" to a listener and
  // is meaningless as a destination; 70000 does not fit the field; a
  // fractional or non-numeric port is a typo that must not be rounded into a
  // plausible-looking connection attempt.
  for (const raw of ['AE=host:abc', 'AE=host:0', 'AE=host:70000', 'AE=host:-1', 'AE=host:11112.5', 'AE=host:']) {
    assert.throws(() => parseDestination(raw), /not a port/, JSON.stringify(raw));
  }

  // The message has to name the offending text, not just the rule.
  assert.throws(() => parseDestination('AE=host:abc'), /"host:abc"/);
  assert.throws(() => parseDestination('nonsense'), /"nonsense"/);
});

// ---------------------------------------------------------------------------
// findMatches: the C-FIND half of --serve.
// ---------------------------------------------------------------------------

test('a study-level C-FIND with no keys answers the study with what the folder holds', async () => {
  const fixture = await served();
  const { level, matches, problem } = findMatches(fixture.dir, {
    QueryRetrieveLevel: 'STUDY', PatientID: '', NumberOfStudyRelatedInstances: '',
  });

  assert.equal(problem, undefined);
  assert.equal(level, 'STUDY');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].StudyInstanceUID, fixture.studyUid, 'the unique key is always returned');
  assert.equal(matches[0].NumberOfStudyRelatedInstances, String(fixture.total));
  assert.ok(matches[0].PatientID, 'a requested key the folder holds is filled in');
});

test('C-FIND matching keys use the same wildcard rules as the worklist', async () => {
  const fixture = await served();
  const { matches: hit } = findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', PatientID: 'SYN*' });
  const { matches: miss } = findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', PatientID: 'NOPE*' });
  const { matches: single } = findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', PatientID: 'SYNTH000?' });

  assert.equal(hit.length, 1);
  assert.equal(miss.length, 0);
  assert.equal(single.length, 1, '? matches exactly one character');
});

test('a date range matches inclusively and an open end is unbounded', async () => {
  const fixture = await served();
  const [{ StudyDate: date }] = findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', StudyDate: '' }).matches;
  assert.match(date, /^[0-9]{8}$/);

  for (const range of [`${date}-${date}`, `${date}-`, `-${date}`, date]) {
    assert.equal(findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', StudyDate: range }).matches.length, 1, range);
  }
  assert.equal(findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', StudyDate: '19000101-19000102' }).matches.length, 0);
});

test('a UID key takes a backslash-separated list of UIDs', async () => {
  const fixture = await served();
  const list = ['1.2.3.4', fixture.studyUid].join(String.fromCharCode(92));
  assert.equal(findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: list }).matches.length, 1);
  assert.equal(findMatches(fixture.dir, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '1.2.3.4' }).matches.length, 0);
});

test('series and image levels answer one row per series and per instance', async () => {
  const fixture = await served();
  const series = findMatches(fixture.dir, { QueryRetrieveLevel: 'SERIES', StudyInstanceUID: fixture.studyUid });
  const images = findMatches(fixture.dir, {
    QueryRetrieveLevel: 'IMAGE', StudyInstanceUID: fixture.studyUid, SeriesInstanceUID: fixture.seriesUid,
  });

  assert.equal(series.matches.length, 2);
  for (const row of series.matches) {
    assert.ok(row.SeriesInstanceUID, 'every series row carries its own unique key');
    assert.equal(row.StudyInstanceUID, fixture.studyUid);
  }
  assert.equal(images.matches.length, 3);
  assert.ok(images.matches.every((row) => row.SeriesInstanceUID === fixture.seriesUid));
});

test('a key the folder does not hold is returned empty and does not filter', async () => {
  // Most archives ignore an optional key they do not support. Matching
  // nothing because one was present would make every rich client query come
  // back empty, which reads as "the study is not here".
  const fixture = await served();
  const { matches, ignored } = findMatches(fixture.dir, {
    QueryRetrieveLevel: 'STUDY', ReferringPhysicianName: 'SMITH*',
  });

  assert.equal(matches.length, 1);
  assert.deepEqual(ignored, ['ReferringPhysicianName']);
  assert.equal(matches[0].ReferringPhysicianName, '');
});

test('a level the Study Root model does not have is refused, not guessed at', async () => {
  const fixture = await served();
  const { matches, problem } = findMatches(fixture.dir, { QueryRetrieveLevel: 'PATIENT' });
  assert.equal(matches.length, 0);
  assert.equal(problem.status, RetrieveStatus.IDENTIFIER_MISMATCH);
});
