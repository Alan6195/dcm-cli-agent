'use strict';

/**
 * End-to-end retrieve tests: the real `dcm get` and `dcm move` against the real
 * receiver, over loopback.
 *
 * These are deliberately not unit tests of lib/retrieve's verdict(). That
 * module's arithmetic is checked on its own; what cannot be checked that way is
 * whether the shipped client and the shipped Q/R SCP actually agree on the
 * wire. A retrieve has four moving parts that only ever meet in a real
 * association — presentation-context negotiation for the Storage SOP Classes a
 * C-GET delivers over, the sub-operation C-STOREs themselves, the pending
 * responses carrying the peer's counts, and the final status — and a mock for
 * any one of them proves only that the mock and the client were written by the
 * same person on the same afternoon.
 *
 * The test this file exists for is the shortfall one. Everything else here
 * guards a message or an exit code; that one guards the single property the
 * whole retrieve feature is built around, which is that the peer's own
 * sub-operation counts are evidence and never the verdict. A peer that reports
 * it completed 5215 sub-operations while 5200 files landed must exit non-zero
 * with the gap named, because that is the failure that gets believed: it carries
 * a success status and it looks completely normal in a progress log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startScp, withTempDir, freePort } = require('../helpers/harness');
const log = require('../../src/lib/log');
const { tokenize } = require('../../src/lib/args');
const { generate } = require('../../tools/make-fixtures');

const find = require('../../src/commands/find');
const get = require('../../src/commands/get');
const move = require('../../src/commands/move');

/**
 * Generates a fixture tree inside a temp dir.
 *
 * outDir is passed explicitly and must stay that way: generate() DEFAULTS it to
 * the repository's own fixtures/ folder and begins with rmSync, so an omitted
 * outDir does not merely write somewhere untidy — it deletes the checked-in
 * fixtures. A previous session did exactly that.
 */
async function fixtures(dir, opts = {}) {
  return generate({
    outDir: dir,
    quiet: true,
    studies: 1,
    seriesPerStudy: 2,
    instancesPerSeries: 3,
    rows: 16,
    cols: 16,
    ...opts,
  });
}

/**
 * Runs a command the way the CLI would, capturing what it printed and ONLY
 * what it printed.
 *
 * This deliberately does not use the harness's runCommand, and the reason is
 * the same one test/e2e/dcmjs-noise.test.js gives for its own `capturing()`
 * helper a few files over: runCommand captures by REPLACING
 * process.stdout.write, node:test writes its own progress frames to
 * process.stdout, and a replacement held across an await — which is every
 * network command in this file — eats whatever the runner emitted during that
 * window.
 *
 * Both halves of that cost were measured here rather than assumed. With
 * runCommand the 12 tests in this file reported as 10, two of them vanishing
 * from the count at random depending on how long an association took. Worse,
 * with a deliberate failure planted in one of the vanished tests, the suite
 * did go red — but as a bare `✖ test/e2e/retrieve.test.js`, with the test's
 * name and its AssertionError both gone, because the frame carrying them was
 * the frame that got eaten. The shortfall test below exists to say exactly why
 * it failed; a capture that can swallow that message defeats the point of
 * writing it.
 *
 * So the command's own output is captured at src/lib/log's chokepoint, which
 * every byte the tool prints passes through, and process.stdout gets a
 * PASS-THROUGH tap rather than a replacement: bytes are recorded and still
 * written on, so the runner keeps its frames. The tap is what catches anything
 * that bypasses log entirely — a direct process.stdout.write of the report
 * would be invisible to the sink.
 *
 * The other benefit is exactness. test/unit/json.test.js has to SCAN stdout for
 * the envelope because of the contamination above, and a scan cannot tell a
 * fully suppressed human report from one that leaked a line with no brace in
 * it. The sink holds exactly the command's stdout, so the --json contract can
 * be asserted by parsing the whole of it.
 *
 * @returns {Promise<{code: number, stdout: string, stderr: string, output: string, direct: string}>}
 */
async function runCaptured(mod, argv) {
  // Colour codes would make output assertions brittle, exactly as in the harness.
  log.configure({ noColor: true });

  const sink = log.beginCapture();
  const direct = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function tap(chunk, ...rest) {
    direct.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };

  let code;
  try {
    code = await mod.run(tokenize(argv));
  } finally {
    process.stdout.write = originalWrite;
    log.endCapture();
  }

  return {
    code,
    stdout: sink.out,
    stderr: sink.err,
    output: sink.out + sink.err,
    direct: direct.join(''),
  };
}

/**
 * Every .dcm file beneath a directory, as paths relative to it.
 *
 * Written here rather than borrowed from src/commands/move.js's dcmFilesUnder
 * on purpose. The disk count is the independent half of the comparison this
 * file is about, so measuring it with the same walker the command measures it
 * with would make a bug in that walker invisible to every assertion here.
 */
function dcmFilesUnder(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => entry.toLowerCase().endsWith('.dcm'));
}

/**
 * The box-drawing range the human report's rules are drawn from.
 *
 * BAR in src/lib/report.js is U+2500 repeated, and it opens and closes every
 * block both commands print. Under --json none of it may reach stdout, and a
 * single `say()` that escaped the no-op would land in here.
 */
const BOX_DRAWING = /[─-╿]/;

/** A syntactically valid UID that no fixture generator produces. */
const ABSENT_STUDY_UID = '1.2.826.0.1.3680043.8.498.99999999';

/**
 * Asserts the --json contract and returns the document.
 *
 * The contract is one JSON document on stdout and nothing else, so this parses
 * the WHOLE of stdout rather than hunting for a brace in it: trailing prose,
 * a leading banner or a second document all fail here rather than being
 * skipped over. The box-drawing check is the separate half — a leaked report
 * line that happened to be valid JSON-adjacent whitespace would still be a
 * breach, and the bars are the part of the report that cannot be mistaken for
 * anything else.
 */
function oneDocument(captured, what = '') {
  const where = what ? ` (${what})` : '';
  let parsed;
  try {
    parsed = JSON.parse(captured.stdout);
  } catch (err) {
    assert.fail(
      `--json must put exactly one JSON document on stdout and nothing else${where}, ` +
        `but parsing all of stdout failed (${err.message}). stdout was:\n${captured.stdout}`
    );
  }
  assert.doesNotMatch(
    captured.stdout, BOX_DRAWING,
    `the human report must be fully suppressed under --json${where}, not merely shortened`
  );
  // Nothing may bypass log either: a direct process.stdout.write of the report
  // would be invisible to the check above. The tap also carries node:test's own
  // frames, which is why this is a box-drawing check rather than an emptiness
  // one — the runner's frames have no rule characters in them, the report does.
  assert.doesNotMatch(
    captured.direct, BOX_DRAWING,
    `report output reached stdout outside src/lib/log${where}`
  );
  return parsed;
}

// ---------------------------------------------------------------------------
// C-GET
// ---------------------------------------------------------------------------

test('C-GET pulls a study into the layout the rest of the tool reads', async () => {
  await withTempDir('dcm-get-ok', async (dir) => {
    const serve = path.join(dir, 'serve');
    const out = path.join(dir, 'out');
    const manifest = await fixtures(serve);
    const study = manifest.studies[0];

    const scp = await startScp({ ae: 'QR-SCP', serve });
    try {
      const { code, output } = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', study.studyInstanceUid, '--out', out,
      ]);

      assert.equal(code, 0, `expected a clean retrieve, got:\n${output}`);
      assert.equal(
        dcmFilesUnder(out).length, manifest.totalInstances,
        'the number of files on disk is the only count that is actually checkable'
      );

      // The exact layout, not just the count. <out>/<study>/<series>/<sop>.dcm is
      // what `dcm scp --persist` and `dcm web retrieve` also produce, and the
      // point of all three agreeing is that tooling pointed at one of them finds
      // the others' output. A retrieve that wrote the right number of files
      // under the wrong names would satisfy a count and break that.
      for (const series of study.series) {
        for (const instance of series.instances) {
          const expected = path.join(
            out, study.studyInstanceUid, series.seriesInstanceUid,
            `${instance.sopInstanceUid}.dcm`
          );
          assert.ok(fs.existsSync(expected), `expected ${expected} to exist`);
        }
      }

      // The SCP side really served a retrieve, rather than quietly answering an
      // empty one: one C-GET, and a sub-operation per instance.
      assert.equal(scp.stats.gets, 1);
      assert.equal(scp.stats.subOpsSent, manifest.totalInstances);
      assert.equal(scp.stats.retrieveRefused, 0);

      // Both numbers are printed side by side, which is what makes a gap
      // between them visible to a person rather than only to the exit code.
      assert.match(output, /stored on disk\s+6/);
      assert.match(output, /peer completed\s+6/);
    } finally {
      scp.close();
    }
  });
});

test('a series-level C-GET writes that series and nothing else', async () => {
  await withTempDir('dcm-get-series', async (dir) => {
    const serve = path.join(dir, 'serve');
    const out = path.join(dir, 'out');
    const manifest = await fixtures(serve);
    const study = manifest.studies[0];
    const [wanted, other] = study.series;

    const scp = await startScp({ ae: 'QR-SCP', serve });
    try {
      const { code, output } = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', study.studyInstanceUid, '--series', wanted.seriesInstanceUid,
        '--out', out,
      ]);

      assert.equal(code, 0, `expected a clean retrieve, got:\n${output}`);
      assert.match(output, /level\s+SERIES/);
      assert.equal(dcmFilesUnder(out).length, wanted.instances.length);
      assert.equal(scp.stats.subOpsSent, wanted.instances.length);

      // The narrowing has to happen at the peer rather than be papered over
      // locally, so the other series must not be on disk at all.
      const seriesDirs = fs.readdirSync(path.join(out, study.studyInstanceUid));
      assert.deepEqual(seriesDirs, [wanted.seriesInstanceUid]);
      assert.equal(
        fs.existsSync(path.join(out, study.studyInstanceUid, other.seriesInstanceUid)),
        false,
        'a series the request did not name must not be retrieved'
      );
    } finally {
      scp.close();
    }
  });
});

test('a study the peer does not hold is an empty retrieve, not a transport failure', async () => {
  // These are two completely different problems with two different fixes, and
  // the receiver answers the first one with SUCCESS and zero sub-operations
  // precisely so a client can tell them apart. Reporting "nothing arrived" as a
  // connection problem sends the reader to the firewall instead of to the UID.
  await withTempDir('dcm-get-missing', async (dir) => {
    const serve = path.join(dir, 'serve');
    const out = path.join(dir, 'out');
    await fixtures(serve);

    const scp = await startScp({ ae: 'QR-SCP', serve });
    try {
      const { code, output } = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', ABSENT_STUDY_UID, '--out', out,
      ]);

      assert.equal(code, 1, 'an empty retrieve is a failed retrieve');
      assert.equal(dcmFilesUnder(out).length, 0);
      assert.match(output, /nothing arrived/i);
      assert.match(output, /matched nothing on this peer/i);

      // The peer answered the question. Nothing was rejected, aborted or
      // refused, and the output must not suggest otherwise.
      assert.doesNotMatch(output, /A-ASSOCIATE-RJ|A-ABORT|ECONNREFUSED/);
      assert.equal(scp.stats.gets, 1);
      assert.equal(scp.stats.subOpsSent, 0);
      assert.equal(scp.stats.retrieveRefused, 0);
    } finally {
      scp.close();
    }
  });
});

test('a receiver with no --serve refuses the retrieve and names the other service', async () => {
  // A receiver that was never given a folder is the common case in the field —
  // it is a destination, not a source — and it must not answer a retrieve it
  // served nothing for with success. What matters in the output is that the
  // reader is sent to a different service rather than left staring at an empty
  // retrieve wondering about the study UID.
  await withTempDir('dcm-get-noserve', async (dir) => {
    const out = path.join(dir, 'out');

    const scp = await startScp({ ae: 'PLAIN-SCP' });
    try {
      const { code, output } = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'PLAIN-SCP',
        '--study', ABSENT_STUDY_UID, '--out', out,
      ]);

      assert.equal(code, 1);
      assert.match(output, /0x0110/);
      assert.match(output, /dcm move/, 'the reader must be pointed at the other service');
      // The peer's own error comment survives, which is what turns a bare
      // status into something actionable.
      assert.match(output, /no folder configured to serve/i);

      assert.equal(scp.stats.gets, 1);
      assert.equal(scp.stats.retrieveRefused, 1);
      assert.equal(scp.stats.subOpsSent, 0);
      assert.equal(dcmFilesUnder(out).length, 0);
    } finally {
      scp.close();
    }
  });
});

test('a peer that over-reports what it sent fails with the gap named', async () => {
  // THE TEST THIS FILE EXISTS FOR.
  //
  // --retrieve-overcount makes the Q/R SCP claim more completed sub-operations
  // than it actually sent. No correct peer does that, which is exactly why it
  // has to be injected: the failure it stands for is a real archive reporting a
  // study complete while instances are missing, and there is no other way to
  // put a client in front of that on demand.
  //
  // If this test fails, the retrieve client has started believing the peer's own
  // accounting. That is the accepted-but-lossy regression: the command exits 0,
  // the operator reads "complete", and the study that gets opened on a
  // workstation is short some images. The partial implementation this feature
  // replaced got exactly this wrong, and nothing else in the suite would catch
  // it — every file the peer really sent does arrive here, so the disk is clean
  // and only the comparison against the peer's claim can fail.
  await withTempDir('dcm-get-shortfall', async (dir) => {
    const serve = path.join(dir, 'serve');
    const out = path.join(dir, 'out');
    const jsonOut = path.join(dir, 'out-json');
    const manifest = await fixtures(serve);
    const study = manifest.studies[0];
    const real = manifest.totalInstances;
    const claimed = real + 2;

    const scp = await startScp({ ae: 'LYING-SCP', serve, retrieveOvercount: 2 });
    try {
      const human = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'LYING-SCP',
        '--study', study.studyInstanceUid, '--out', out,
      ]);

      assert.equal(
        human.code, 1,
        'a peer claiming it sent more than arrived must exit non-zero — believing its ' +
          'count here is the accepted-but-lossy regression this comparison exists to stop'
      );
      assert.equal(dcmFilesUnder(out).length, real, 'everything really sent did arrive');
      assert.match(
        human.output,
        new RegExp(`the peer reports ${claimed} instance\\(s\\) sent but ${real}\\s+are on disk`),
        'the gap has to be stated in both numbers, or the reader cannot tell which to trust'
      );
      assert.match(human.output, /2 missing/);
      assert.match(human.output, /accepted and is incomplete/i);
      assert.match(human.output, /FAILED/, 'the verdict line must not read as a success');

      const machine = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'LYING-SCP',
        '--study', study.studyInstanceUid, '--out', jsonOut, '--json',
      ]);

      assert.equal(machine.code, 1);
      const env = oneDocument(machine, 'the shortfall path');
      assert.equal(env.schema, 'dcm.result/1');
      assert.equal(env.command, 'get');
      assert.equal(env.ok, false);
      assert.equal(env.exitCode, 1);
      assert.equal(
        env.shortfall, 2,
        'shortfall is the machine-readable form of the gap, and what a CI job asserts on; ' +
          'a 0 here with 2 instances missing is the regression'
      );
      assert.equal(env.written, real, 'written is the provable count — files on disk');
      assert.equal(
        env.reported.completed, claimed,
        "the peer's claim is reported faithfully; it is kept as evidence, not discarded"
      );
      // `counted` is what stops a peer that returns no counts at all from making
      // the comparison pass vacuously, so it has to be true here.
      assert.equal(env.reported.counted, true);
      assert.match(env.problems.join('; '), /2 missing/);
    } finally {
      scp.close();
    }
  });
});

test('--json puts exactly one document on stdout for a successful retrieve', async () => {
  await withTempDir('dcm-get-json-ok', async (dir) => {
    const serve = path.join(dir, 'serve');
    const out = path.join(dir, 'out');
    const manifest = await fixtures(serve);

    const scp = await startScp({ ae: 'QR-SCP', serve });
    try {
      const captured = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', manifest.studies[0].studyInstanceUid, '--out', out, '--json',
      ]);

      assert.equal(captured.code, 0);
      const env = oneDocument(captured, 'a successful retrieve');
      assert.equal(env.outcome, 'ok');
      assert.equal(env.written, manifest.totalInstances);
      assert.equal(env.shortfall, 0);
      assert.equal(env.level, 'STUDY');
    } finally {
      scp.close();
    }
  });
});

test('--json keeps the one-document contract on a failing retrieve too', async () => {
  // The contract is every terminal path, not the happy one. A command that
  // prints its report and only then discovers a failure is the obvious way to
  // end up with prose in front of the document, so the failing paths are the
  // ones worth pinning.
  await withTempDir('dcm-get-json-fail', async (dir) => {
    const out = path.join(dir, 'out');

    const scp = await startScp({ ae: 'PLAIN-SCP' });
    try {
      const captured = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'PLAIN-SCP',
        '--study', ABSENT_STUDY_UID, '--out', out, '--json',
      ]);

      assert.equal(captured.code, 1);
      const env = oneDocument(captured, 'a refused retrieve');
      assert.equal(env.ok, false);
      assert.equal(env.exitCode, 1);
      assert.equal(env.written, 0);
      assert.equal(
        env.status, 0x0110,
        'the raw status stays assertable, not just the sentence describing it'
      );
      // The explanation went to stderr, which is where prose belongs: it is
      // never part of the contract and cannot corrupt the document.
      assert.match(captured.stderr, /0x0110/);
    } finally {
      scp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C-MOVE
// ---------------------------------------------------------------------------

test('C-MOVE into a receiver this command runs itself lands every instance', async () => {
  await withTempDir('dcm-move-ok', async (dir) => {
    const serve = path.join(dir, 'serve');
    const received = path.join(dir, 'received');
    const manifest = await fixtures(serve);
    const study = manifest.studies[0];

    // The port has to be settled before the Q/R SCP starts, because the
    // destination registry it is built with has to name the same number the
    // client will later listen on. That is not a test artefact, it is the shape
    // of C-MOVE: the request carries an AE Title and nothing else, and the
    // address behind it lives in the peer's configuration. The next test is what
    // happens when the two are out of step.
    const recvPort = await freePort();

    const scp = await startScp({
      ae: 'QR-SCP',
      serve,
      destinations: { 'DEST-AE': { host: '127.0.0.1', port: recvPort } },
    });
    try {
      const { code, output } = await runCaptured(move, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', study.studyInstanceUid,
        '--destination', 'DEST-AE',
        '--receive', received, '--receive-port', String(recvPort),
      ]);

      assert.equal(code, 0, `expected a clean move, got:\n${output}`);
      assert.equal(dcmFilesUnder(received).length, manifest.totalInstances);

      // The sub-operations arrived on a SEPARATE association and were written by
      // the receiver rather than by the client, so the layout is worth
      // confirming independently of the C-GET case above: the two have to agree
      // for either to serve as a mirror for the other's tooling.
      for (const series of study.series) {
        for (const instance of series.instances) {
          const expected = path.join(
            received, study.studyInstanceUid, series.seriesInstanceUid,
            `${instance.sopInstanceUid}.dcm`
          );
          assert.ok(fs.existsSync(expected), `expected ${expected} to exist`);
        }
      }

      assert.equal(scp.stats.moves, 1);
      assert.equal(scp.stats.movesRefused, 0);
      assert.equal(scp.stats.subOpsSent, manifest.totalInstances);
      assert.match(output, /peer completed\s+6/);
      assert.match(output, /arrived on disk\s+6/);
    } finally {
      scp.close();
    }
  });
});

test('an unregistered destination AE is 0xA801 with the configuration fix named', async () => {
  // The single most common C-MOVE failure, and the one that looks least like
  // itself: the association is accepted, the request is understood, and then
  // nothing moves because the archive has never heard of the destination. No
  // amount of retrying or firewall work fixes it, so the message has to say the
  // fix is on the peer — or point at `dcm get`, which needs no registration at
  // all because the images come back down the association already open.
  await withTempDir('dcm-move-unknown', async (dir) => {
    const serve = path.join(dir, 'serve');
    const manifest = await fixtures(serve);

    // Served, and with an empty destination registry, so the refusal can only
    // be about the destination.
    const scp = await startScp({ ae: 'QR-SCP', serve });
    try {
      const { code, output } = await runCaptured(move, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', manifest.studies[0].studyInstanceUid,
        '--destination', 'NO-SUCH-AE',
      ]);

      assert.equal(code, 1);
      assert.match(output, /0xa801/i, 'the raw status has to stay in the output');
      assert.match(output, /Move Destination unknown/i);
      assert.match(output, /NO-SUCH-AE/, 'the AE Title that was not found must be named');
      assert.match(
        output, /registered/i,
        'the fix is a registration on the archive, and the message has to say so'
      );
      assert.match(output, /dcm get/, 'the alternative that needs no registration');

      assert.equal(scp.stats.moves, 1);
      assert.equal(scp.stats.movesRefused, 1);
      assert.equal(
        scp.stats.subOpsSent, 0,
        'an unknown destination must be refused before anything is sent anywhere'
      );
    } finally {
      scp.close();
    }
  });
});

test('a third-party move reports what the peer said and claims no verification', async () => {
  // The images went somewhere this process cannot see. There is no local disk to
  // compare against, so the only honest report is the peer's own account of the
  // transfer, and the output has to say so rather than let a 0 exit code read as
  // "the study arrived intact". This test checks the destination itself to prove
  // the move really happened — which is exactly the check the command is right
  // to refuse to claim it made.
  await withTempDir('dcm-move-third-party', async (dir) => {
    const serve = path.join(dir, 'serve');
    const elsewhere = path.join(dir, 'elsewhere');
    const manifest = await fixtures(serve);
    const study = manifest.studies[0];

    const thirdParty = await startScp({ ae: 'THIRD-PARTY', persist: elsewhere });
    const scp = await startScp({
      ae: 'QR-SCP',
      serve,
      destinations: { 'THIRD-PARTY': { host: '127.0.0.1', port: thirdParty.port } },
    });
    try {
      const { code, output } = await runCaptured(move, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', study.studyInstanceUid,
        '--destination', 'THIRD-PARTY',
      ]);

      assert.equal(code, 0, `expected a clean third-party move, got:\n${output}`);
      assert.match(output, /nothing local to check/i);
      assert.match(
        output, /does not prove anything landed there/i,
        'a 0 exit code here must not be allowed to read as a verified arrival'
      );
      assert.match(output, /querying the destination itself/i);
      assert.doesNotMatch(
        output, /arrived on disk/,
        'there is no local disk in this case, and printing a count for one would be a lie'
      );

      // Independently true, and deliberately not something the command claims.
      assert.equal(thirdParty.stats.stored, manifest.totalInstances);

      const machine = await runCaptured(move, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', study.studyInstanceUid,
        '--destination', 'THIRD-PARTY', '--json',
      ]);

      assert.equal(machine.code, 0);
      const env = oneDocument(machine, 'a third-party move');
      assert.equal(env.ok, true);
      assert.equal(
        env.verified, false,
        'the envelope has to carry the fact that nothing was verified, not just the prose'
      );
      assert.equal(
        env.arrived, null,
        'null, not 0: "we did not receive" and "we received nothing" are different answers'
      );
      assert.equal(env.receiveDir, null);
      assert.equal(env.destinationAe, 'THIRD-PARTY');
      assert.equal(env.reported.completed, manifest.totalInstances);
      assert.equal(env.shortfall, 0);
    } finally {
      scp.close();
      thirdParty.close();
    }
  });
});

test('a move that cannot be aimed anywhere is a usage error, before any association', async () => {
  // Asserted through --json on purpose. Without it a UsageError propagates out
  // of run() and it is src/cli.js that turns it into exit 2, so the code is not
  // observable from here; with it the command's own guard both returns 2 and
  // emits the document, which is the pair a CI job consumes. Either way nothing
  // is sent — there is no receiver in this test at all, and every case below
  // would hang or report a transport error if the check came after the
  // association rather than before it.
  const cases = [
    {
      what: 'neither --destination nor --receive',
      argv: ['--study', '1.2.3'],
      expect: /needs somewhere to move to/i,
      also: /dcm get/,
    },
    {
      what: '--receive-port without --receive',
      argv: ['--study', '1.2.3', '--destination', 'SOMEWHERE', '--receive-port', '11113'],
      expect: /--receive-port only means something with --receive/i,
    },
    {
      what: '--instance without --series',
      argv: ['--study', '1.2.3', '--instance', '1.2.3.4', '--destination', 'SOMEWHERE'],
      expect: /--series is required with it/i,
    },
  ];

  for (const { what, argv, expect, also } of cases) {
    // eslint-disable-next-line no-await-in-loop
    const captured = await runCaptured(move, [
      '--host', '127.0.0.1', '--port', '11112', '--called-ae', 'ARCHIVE',
      ...argv, '--json',
    ]);

    assert.equal(captured.code, 2, `${what} should be a usage error, exit 2`);
    const env = oneDocument(captured, what);
    assert.equal(env.outcome, 'usage', what);
    assert.equal(env.exitCode, 2, what);
    assert.match(env.message, expect, what);
    if (also) assert.match(env.message, also, what);
  }
});

test('get refuses an instance-level retrieve without its series, same as move', async () => {
  // The two commands share the rule because they share the identifier: an
  // instance-level request without its series UID is a different question from
  // the one the operator meant, and peers disagree about what to do with it —
  // some answer 0xA900, others answer about the wrong series. Refusing locally
  // is the only outcome that is the same everywhere.
  await withTempDir('dcm-get-usage', async (dir) => {
    const captured = await runCaptured(get, [
      '--host', '127.0.0.1', '--port', '11112', '--called-ae', 'ARCHIVE',
      '--study', '1.2.3', '--instance', '1.2.3.4',
      '--out', path.join(dir, 'out'), '--json',
    ]);

    assert.equal(captured.code, 2);
    const env = oneDocument(captured, 'get --instance without --series');
    assert.equal(env.outcome, 'usage');
    assert.match(env.message, /--series is required with it/i);
  });
});

// ---------------------------------------------------------------------------
// The whole loop: search, then pull what the search returned
// ---------------------------------------------------------------------------

test('a served folder can be searched and the study it returns pulled back', async () => {
  // The flow an operator actually runs: find the patient, then retrieve the
  // row. Every UID here comes from the query answer, not from the fixture
  // manifest, so this proves the two halves of Query/Retrieve agree with each
  // other on the same receiver, which is what the desktop Query screen depends
  // on when it puts a Retrieve button on a result row.
  await withTempDir('dcm-qr-loop', async (dir) => {
    const serve = path.join(dir, 'serve');
    const out = path.join(dir, 'out');
    const manifest = await fixtures(serve);

    const scp = await startScp({ ae: 'QR-SCP', serve });
    try {
      const found = await runCaptured(find, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--json', 'PatientID=*',
      ]);
      assert.equal(found.code, 0, `the search must succeed:\n${found.output}`);
      const answer = oneDocument(found, 'find');
      assert.equal(answer.outcome, 'matched');
      assert.equal(answer.matches.length, 1);
      const studyUid = answer.matches[0].StudyInstanceUID;
      assert.equal(studyUid, manifest.studies[0].studyInstanceUid);

      const pulled = await runCaptured(get, [
        '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'QR-SCP',
        '--study', studyUid, '--out', out,
      ]);
      assert.equal(pulled.code, 0, `the retrieve of the searched study must succeed:\n${pulled.output}`);
      assert.equal(dcmFilesUnder(out).length, manifest.totalInstances);
      assert.equal(
        Number(answer.matches[0].NumberOfStudyRelatedInstances), manifest.totalInstances,
        'the count the search advertised is the count the retrieve delivered'
      );
    } finally {
      scp.close();
    }
  });
});
