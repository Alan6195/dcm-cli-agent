'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startScp, runCommand, withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');

const echo = require('../../src/commands/echo');
const send = require('../../src/commands/send');
const info = require('../../src/commands/info');
const find = require('../../src/commands/find');
const anon = require('../../src/commands/anon');

/** Generates a fixture tree inside a temp dir. */
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

test('C-ECHO against a live receiver succeeds', async () => {
  const scp = await startScp({ ae: 'TEST-SCP' });
  try {
    const { code, output } = await runCommand(echo, [
      '--host', '127.0.0.1', '--port', String(scp.port),
      '--called-ae', 'TEST-SCP', '--calling-ae', 'DCM-CLI',
    ]);

    assert.equal(code, 0);
    assert.match(output, /OK/);
    assert.equal(scp.stats.echoes, 1);
    // The echo must not imply storage will work.
    assert.match(output, /does not prove the peer will accept storage/i);
  } finally {
    scp.close();
  }
});

test('a wrong calling AE Title is rejected and translated', async () => {
  // The deliberate wrong-AE rejection: the receiver allowlists a calling AE
  // Title and everything else gets A-ASSOCIATE-RJ reason 3.
  const scp = await startScp({ acceptCallingAe: ['ALLOWED-AE'] });
  try {
    const { code, output } = await runCommand(echo, [
      '--host', '127.0.0.1', '--port', String(scp.port),
      '--called-ae', 'ANY-SCP', '--calling-ae', 'NOT-ALLOWED',
    ]);

    assert.equal(code, 1);
    assert.match(output, /Calling AE Title not recognized/i);
    assert.match(output, /registered\/allowlisted on the receiving side/i);
    assert.match(output, /result=1 source=1 reason=3/, 'the raw code stays available');
    assert.equal(scp.stats.rejected, 1);
  } finally {
    scp.close();
  }
});

test('a wrong called AE Title is a different rejection', async () => {
  const scp = await startScp({ ae: 'RIGHT-AE' });
  try {
    const { code, output } = await runCommand(echo, [
      '--host', '127.0.0.1', '--port', String(scp.port),
      '--called-ae', 'WRONG-AE', '--calling-ae', 'DCM-CLI',
    ]);

    assert.equal(code, 1);
    assert.match(output, /Called AE Title not recognized/i);
    assert.match(output, /reason=7/);
  } finally {
    scp.close();
  }
});

test('connecting to a closed port reports a transport error, not a rejection', async () => {
  const scp = await startScp({});
  const deadPort = scp.port;
  scp.close();
  // Give the socket a moment to actually release.
  await new Promise((r) => setTimeout(r, 100));

  const { code, output } = await runCommand(echo, [
    '--host', '127.0.0.1', '--port', String(deadPort), '--called-ae', 'NOBODY',
  ]);

  assert.equal(code, 1);
  assert.doesNotMatch(output, /A-ASSOCIATE-RJ/, 'nothing was rejected — nothing answered');
});

test('single-instance send is acknowledged and exits zero', async () => {
  await withTempDir('dcm-single', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 1 });

    const scp = await startScp({ ae: 'STORE-SCP' });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'STORE-SCP',
      ]);

      assert.equal(code, 0);
      assert.match(output, /files found\s+1/);
      assert.match(output, /files sent\s+1/);
      assert.match(output, /acknowledged\s+1/);
      assert.match(output, /OK — every file found was acknowledged/);
      assert.equal(scp.stats.stored, 1);
    } finally {
      scp.close();
    }
  });
});

test('a large study is split across several associations', async () => {
  await withTempDir('dcm-chunk', async (dir) => {
    const src = path.join(dir, 'src');
    // 12 instances at chunk size 4 must open exactly 3 associations.
    await fixtures(src, { seriesPerStudy: 2, instancesPerSeries: 6 });

    const scp = await startScp({ ae: 'STORE-SCP' });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port),
        '--called-ae', 'STORE-SCP', '--chunk', '4',
      ]);

      assert.equal(code, 0);
      assert.match(output, /12 instance\(s\) in 3 association\(s\)/);
      assert.match(output, /acknowledged\s+12/);
      assert.equal(scp.stats.stored, 12);
      assert.equal(
        scp.stats.associations, 3,
        'chunking must actually open separate associations, not just report them'
      );
    } finally {
      scp.close();
    }
  });
});

test('an unreadable file is counted as a loss, not skipped', async () => {
  // The core requirement: a file that exists on disk but never reaches the
  // peer must make the run fail, however cleanly everything else went.
  await withTempDir('dcm-lossy', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 3, corrupt: true });

    const scp = await startScp({ ae: 'STORE-SCP' });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'STORE-SCP',
      ]);

      assert.equal(code, 1, 'a lossy transfer must exit non-zero');
      assert.match(output, /files found\s+4/);
      assert.match(output, /files sent\s+3/);
      assert.match(output, /acknowledged\s+3/);
      assert.match(output, /FAILED — 1 of 4 file\(s\) were not acknowledged/);
      assert.match(output, /truncated\.dcm/, 'the lost file must be named');
      // Everything that did arrive still arrived.
      assert.equal(scp.stats.stored, 3);
    } finally {
      scp.close();
    }
  });
});

test('per-instance refusals are surfaced with their status codes', async () => {
  await withTempDir('dcm-refuse', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 4 });

    // The receiver takes the association, acknowledges two, then refuses.
    const scp = await startScp({ ae: 'FLAKY-SCP', rejectAfter: 2 });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port),
        '--called-ae', 'FLAKY-SCP', '--chunk', '4', '--retry', '0',
      ]);

      assert.equal(code, 1);
      assert.match(output, /acknowledged\s+2/);
      assert.match(output, /SHORTFALL: 2 of 4/);
      // Requirement: report the actual codes, translated.
      assert.match(output, /0xA700/);
      assert.match(output, /out of resources/i);
    } finally {
      scp.close();
    }
  });
});

test('a chunk with unacknowledged instances is retried', async () => {
  await withTempDir('dcm-retry', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 4 });

    // Refuses after 2 per association, so a retry with the remainder succeeds.
    const scp = await startScp({ ae: 'FLAKY-SCP', rejectAfter: 2 });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port),
        '--called-ae', 'FLAKY-SCP', '--chunk', '4', '--retry', '3',
      ]);

      assert.equal(code, 0, 'retrying the outstanding instances should complete the study');
      assert.match(output, /acknowledged\s+4/);
      // The refusal history must survive so a flaky peer is still visible.
      assert.match(output, /needed retrying/i);
      assert.match(output, /0xA700/);
    } finally {
      scp.close();
    }
  });
});

test('an association rejected mid-run leaves every instance accounted for', async () => {
  await withTempDir('dcm-reject', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 5 });

    const scp = await startScp({ acceptCallingAe: ['SOMEONE-ELSE'] });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port),
        '--called-ae', 'ANY-SCP', '--calling-ae', 'DCM-CLI', '--retry', '0',
      ]);

      assert.equal(code, 1);
      assert.match(output, /files found\s+5/);
      assert.match(output, /acknowledged\s+0/);
      assert.match(output, /not attempted\s+5/, 'nothing was sent, and that is stated');
      assert.match(output, /Calling AE Title not recognized/i);
      // The invariant that matters: no file vanished.
      assert.doesNotMatch(output, /no recorded outcome at all/);
    } finally {
      scp.close();
    }
  });
});

test('--dry-run reports the plan and opens no connection', async () => {
  await withTempDir('dcm-dry', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 2, instancesPerSeries: 5 });

    const { code, output } = await runCommand(send, [src, '--dry-run', '--chunk', '3']);

    assert.equal(code, 0);
    assert.match(output, /DRY RUN — nothing was sent/);
    assert.match(output, /instances\s+10/);
    assert.match(output, /associations\s+4/, '10 instances at chunk 3 is 4 associations');
  });
});

test('a successful send does not claim the study is queryable', async () => {
  await withTempDir('dcm-queryable', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 2 });

    const scp = await startScp({ ae: 'STORE-SCP' });
    try {
      const { code, output } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'STORE-SCP',
      ]);

      assert.equal(code, 0);
      assert.match(output, /does not mean/i);
      assert.match(output, /queryable/i);
      assert.match(output, /store-and-forward/i);
    } finally {
      scp.close();
    }
  });
});

test('C-FIND returning zero matches explains accepted-versus-queryable', async () => {
  // The receiver stores but does not index, which is exactly what many
  // store-and-forward systems do.
  const scp = await startScp({ ae: 'FIND-SCP' });
  try {
    const { code, output } = await runCommand(find, [
      '--host', '127.0.0.1', '--port', String(scp.port),
      '--called-ae', 'FIND-SCP', 'PatientID=NOBODY',
    ]);

    assert.equal(code, 1);
    assert.match(output, /0 matches/);
    assert.match(output, /not the same as a failed transfer/i);
    assert.match(output, /storing and indexing are\s*\n?\s*separate operations/i);
  } finally {
    scp.close();
  }
});

test('persisted instances land on disk under study and series UIDs', async () => {
  await withTempDir('dcm-persist', async (dir) => {
    const src = path.join(dir, 'src');
    const received = path.join(dir, 'received');
    const manifest = await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 2 });

    const scp = await startScp({ ae: 'STORE-SCP', persist: received });
    try {
      const { code } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'STORE-SCP',
      ]);
      assert.equal(code, 0);

      // Persisting is asynchronous inside the SCP; allow it to flush.
      await new Promise((r) => setTimeout(r, 300));

      const studyUid = manifest.studies[0].studyInstanceUid;
      const studyDir = path.join(received, studyUid);
      assert.ok(fs.existsSync(studyDir), `expected ${studyDir} to exist`);

      const files = fs.readdirSync(studyDir, { recursive: true })
        .filter((f) => String(f).endsWith('.dcm'));
      assert.equal(files.length, 2);
    } finally {
      scp.close();
    }
  });
});

test('info counts unreadable files and exits non-zero', async () => {
  await withTempDir('dcm-info', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 2, instancesPerSeries: 3, corrupt: true });

    const { code, output } = await runCommand(info, [src]);

    assert.equal(code, 1);
    assert.match(output, /DICOM instances\s+6/);
    assert.match(output, /unreadable\s+1/);
    assert.match(output, /non-DICOM ignored\s+1/);
  });
});

test('info --json emits parseable output', async () => {
  await withTempDir('dcm-info-json', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 2 });

    const { code, stdout } = await runCommand(info, [src, '--json']);
    assert.equal(code, 0);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.dicomInstances, 2);
    assert.equal(parsed.studies.length, 1);
    assert.equal(parsed.studies[0].instanceCount, 2);
    assert.equal(parsed.studies[0].series.length, 1);
  });
});

test('info flags colliding series UIDs', async () => {
  await withTempDir('dcm-collide', async (dir) => {
    const src = path.join(dir, 'src');
    // Two genuinely different series emitted under one Series Instance UID.
    await fixtures(src, { seriesPerStudy: 2, instancesPerSeries: 2, collidingSeriesUids: true });

    const { output } = await runCommand(info, [src, '--series']);
    assert.match(output, /shared by 2 distinct series/i);
    assert.match(output, /--rewrite-series-uid/);
  });
});

test('--rewrite-series-uid separates series that shared one source UID', async () => {
  await withTempDir('dcm-rewrite', async (dir) => {
    const src = path.join(dir, 'src');
    const received = path.join(dir, 'received');
    // Two genuinely different series emitted under a single Series Instance UID.
    await fixtures(src, {
      seriesPerStudy: 2, instancesPerSeries: 2, collidingSeriesUids: true,
    });

    const scp = await startScp({ ae: 'STORE-SCP', persist: received });
    try {
      const { code } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port),
        '--called-ae', 'STORE-SCP', '--rewrite-series-uid',
      ]);
      assert.equal(code, 0);
      await new Promise((r) => setTimeout(r, 400));

      // The receiver lays instances out by Series Instance UID, so the number
      // of series directories is a direct measure of whether they merged.
      const studyDir = fs.readdirSync(received)[0];
      const seriesDirs = fs.readdirSync(path.join(received, studyDir));

      assert.equal(seriesDirs.length, 2, 'the two series must not be merged into one stack');
      for (const seriesUid of seriesDirs) {
        assert.match(seriesUid, /^2\.25\./, 'replacements use the UUID-derived root');
      }
    } finally {
      scp.close();
    }
  });
});

test('without --rewrite-series-uid colliding series still merge', async () => {
  // Confirms the previous test is measuring something real rather than an
  // artefact of the fixture.
  await withTempDir('dcm-merge', async (dir) => {
    const src = path.join(dir, 'src');
    const received = path.join(dir, 'received');
    await fixtures(src, {
      seriesPerStudy: 2, instancesPerSeries: 2, collidingSeriesUids: true,
    });

    const scp = await startScp({ ae: 'STORE-SCP', persist: received });
    try {
      const { code } = await runCommand(send, [
        src, '--host', '127.0.0.1', '--port', String(scp.port), '--called-ae', 'STORE-SCP',
      ]);
      assert.equal(code, 0);
      await new Promise((r) => setTimeout(r, 400));

      const studyDir = fs.readdirSync(received)[0];
      const seriesDirs = fs.readdirSync(path.join(received, studyDir));
      assert.equal(seriesDirs.length, 1, 'this is the defect the flag exists to repair');
    } finally {
      scp.close();
    }
  });
});

test('anon removes identifiers, remaps UIDs and writes every instance', async () => {
  await withTempDir('dcm-anon', async (dir) => {
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'out');
    const manifest = await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 3 });

    const { code, output } = await runCommand(anon, [src, '--out', out]);

    assert.equal(code, 0);
    assert.match(output, /instances written\s+3/);
    assert.match(output, /UIDs remapped/);

    // The original Study UID must not appear anywhere in the output tree.
    const originalStudyUid = manifest.studies[0].studyInstanceUid;
    assert.ok(!fs.existsSync(path.join(out, originalStudyUid)),
      'output must not be laid out under the original UIDs');

    const { code: infoCode, stdout } = await runCommand(info, [out, '--json']);
    assert.equal(infoCode, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.dicomInstances, 3, 'the output must still be readable DICOM');
    assert.notEqual(parsed.studies[0].studyInstanceUid, originalStudyUid);
    assert.match(parsed.studies[0].studyInstanceUid, /^2\.25\./);
    assert.notEqual(parsed.studies[0].patientId, 'SYNTH0001');
  });
});

test('anon refuses to write inside the source folder', async () => {
  await withTempDir('dcm-anon-guard', async (dir) => {
    const src = path.join(dir, 'src');
    await fixtures(src, { seriesPerStudy: 1, instancesPerSeries: 1 });

    await assert.rejects(
      () => runCommand(anon, [src, '--out', path.join(src, 'inner')]),
      /inside the source folder/
    );
  });
});
