'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const log = require('../../src/lib/log');
const { UsageError, tokenize } = require('../../src/lib/args');
const { FileEntry, Disposition } = require('../../src/lib/ledger');
const { attr, TAGS } = require('../../src/lib/webdicom');
const { runCommand, withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');
const send = require('../../src/commands/web/send');

log.configure({ quiet: true, noColor: true });

/** All env vars the web send options read; each test starts clean. */
const ENV_KEYS = ['DCM_WEB_URL', 'DCM_WEB_TOKEN', 'DCM_WEB_USER', 'DCM_WEB_PASS', 'DCM_WEB_TIMEOUT', 'DCM_WEB_CHUNK'];

/** Runs fn with exactly the given env vars set, restoring the outer env after. */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** A ledger entry as the scanner would register it, dispatched unless said otherwise. */
function entryOf(sopUid, { dispatched = true } = {}) {
  const entry = new FileEntry({
    path: `/tmp/fake/${sopUid}.dcm`,
    bytes: 1024,
    sopInstanceUid: sopUid,
    sopClassUid: '1.2.840.10008.5.1.4.1.1.7',
  });
  entry.dispatched = dispatched;
  return entry;
}

/** Builds a synthetic STOW-RS DICOM+JSON response dataset. */
function stowBody({ accepted = [], failed = [] } = {}) {
  const body = {};
  if (accepted.length) {
    body[TAGS.REFERENCED_SOP_SEQ] = {
      vr: 'SQ',
      Value: accepted.map(({ uid, warning }) => {
        const item = {
          [TAGS.REF_SOP_CLASS]: attr('UI', '1.2.840.10008.5.1.4.1.1.7'),
          [TAGS.REF_SOP_INSTANCE]: attr('UI', uid),
        };
        if (warning !== undefined) item[TAGS.WARNING_REASON] = attr('US', warning);
        return item;
      }),
    };
  }
  if (failed.length) {
    body[TAGS.FAILED_SOP_SEQ] = {
      vr: 'SQ',
      Value: failed.map(({ uid, reason }) => {
        const item = { [TAGS.REF_SOP_INSTANCE]: attr('UI', uid) };
        if (reason !== undefined) item[TAGS.FAILURE_REASON] = attr('US', reason);
        return item;
      }),
    };
  }
  return body;
}

// --- applyStowResponse: the response-to-ledger mapping -----------------------

test('an instance in ReferencedSOPSequence settles ACKNOWLEDGED with status 0x0000', () => {
  const entry = entryOf('1.2.3.1');
  const summary = send.applyStowResponse([entry], stowBody({ accepted: [{ uid: '1.2.3.1' }] }));

  assert.equal(entry.disposition, Disposition.ACKNOWLEDGED);
  assert.equal(entry.status, 0x0000);
  assert.deepEqual(summary, { acknowledged: 1, warned: 0, failed: 0, unmatched: [] });
});

test('a WarningReason on a referenced item settles WARNING and carries the code', () => {
  const entry = entryOf('1.2.3.2');
  const summary = send.applyStowResponse(
    [entry],
    stowBody({ accepted: [{ uid: '1.2.3.2', warning: 0xb000 }] })
  );

  assert.equal(entry.disposition, Disposition.WARNING);
  assert.equal(entry.status, 0xb000);
  assert.match(entry.detail, /0xB000/);
  assert.equal(summary.warned, 1);
});

test('an instance in FailedSOPSequence settles FAILED with the reason code and its translation', () => {
  const entry = entryOf('1.2.3.3');
  const summary = send.applyStowResponse(
    [entry],
    stowBody({ failed: [{ uid: '1.2.3.3', reason: 43264 }] }) // 0xA900
  );

  assert.equal(entry.disposition, Disposition.FAILED);
  assert.equal(entry.status, 43264);
  assert.match(entry.detail, /0xA900/);
  assert.match(entry.detail, /SOP Class/);
  assert.equal(summary.failed, 1);
});

test('a failed item without a FailureReason still settles FAILED, honestly labelled', () => {
  const entry = entryOf('1.2.3.4');
  send.applyStowResponse([entry], stowBody({ failed: [{ uid: '1.2.3.4' }] }));

  assert.equal(entry.disposition, Disposition.FAILED);
  assert.equal(entry.status, undefined);
  assert.match(entry.detail, /without giving a reason code/);
});

test('an instance the response never mentions is left unsettled for the sweep, never assumed stored', () => {
  const mentioned = entryOf('1.2.3.5');
  const ignored = entryOf('1.2.3.6');
  send.applyStowResponse([mentioned, ignored], stowBody({ accepted: [{ uid: '1.2.3.5' }] }));

  assert.equal(mentioned.settled, true);
  assert.equal(ignored.settled, false);
});

test('a mixed 202-style response maps accepted, warned, failed and missing instances each to their own outcome', () => {
  const okEntry = entryOf('1.1');
  const warnEntry = entryOf('1.2');
  const failEntry = entryOf('1.3');
  const silentEntry = entryOf('1.4');

  const summary = send.applyStowResponse(
    [okEntry, warnEntry, failEntry, silentEntry],
    stowBody({
      accepted: [{ uid: '1.1' }, { uid: '1.2', warning: 0xb006 }],
      failed: [{ uid: '1.3', reason: 42752 }], // 0xA700 out of resources
    })
  );

  assert.equal(okEntry.disposition, Disposition.ACKNOWLEDGED);
  assert.equal(warnEntry.disposition, Disposition.WARNING);
  assert.equal(failEntry.disposition, Disposition.FAILED);
  assert.match(failEntry.detail, /out of resources/i);
  assert.equal(silentEntry.settled, false);
  assert.deepEqual(summary, { acknowledged: 1, warned: 1, failed: 1, unmatched: [] });
});

test('duplicate SOP Instance UIDs in one chunk settle one entry per response item, none twice', () => {
  const first = entryOf('9.9.9');
  const second = entryOf('9.9.9');

  // The server acknowledges the UID twice: both entries settle exactly once.
  send.applyStowResponse([first, second], stowBody({ accepted: [{ uid: '9.9.9' }, { uid: '9.9.9' }] }));
  assert.equal(first.disposition, Disposition.ACKNOWLEDGED);
  assert.equal(second.disposition, Disposition.ACKNOWLEDGED);

  // The server acknowledges it once: exactly one entry settles, the other is
  // left for the sweep rather than being double-counted as stored.
  const third = entryOf('8.8.8');
  const fourth = entryOf('8.8.8');
  send.applyStowResponse([third, fourth], stowBody({ accepted: [{ uid: '8.8.8' }] }));
  assert.equal([third, fourth].filter((e) => e.settled).length, 1);
});

test('a UID the server mentions but the chunk never sent lands in unmatched, not on some entry', () => {
  const entry = entryOf('2.2.2');
  const summary = send.applyStowResponse(
    [entry],
    stowBody({ accepted: [{ uid: '2.2.2' }], failed: [{ uid: '7.7.7', reason: 272 }] })
  );

  assert.equal(entry.disposition, Disposition.ACKNOWLEDGED);
  assert.deepEqual(summary.unmatched, ['7.7.7']);
});

// --- sweepChunk: absence becomes an explicit outcome -------------------------

test('sweepChunk turns unsettled entries into UNANSWERED or NOT_ATTEMPTED by whether they were dispatched', () => {
  const wasSent = entryOf('3.1', { dispatched: true });
  const neverSent = entryOf('3.2', { dispatched: false });
  const alreadyDone = entryOf('3.3');
  alreadyDone.settle(Disposition.ACKNOWLEDGED, { status: 0 });

  const closed = send.sweepChunk([wasSent, neverSent, alreadyDone], 'the request died');

  assert.equal(closed, 2);
  assert.equal(wasSent.disposition, Disposition.UNANSWERED);
  assert.equal(neverSent.disposition, Disposition.NOT_ATTEMPTED);
  assert.equal(alreadyDone.disposition, Disposition.ACKNOWLEDGED);
});

// --- isRetryableHttp / describeFailureReason ---------------------------------

test('isRetryableHttp retries silence, rate limits and server faults, and nothing else', () => {
  assert.equal(send.isRetryableHttp(undefined), true, 'no answer at all is retryable');
  assert.equal(send.isRetryableHttp(429), true);
  assert.equal(send.isRetryableHttp(500), true);
  assert.equal(send.isRetryableHttp(503), true);
  assert.equal(send.isRetryableHttp(599), true);

  for (const permanent of [200, 202, 400, 401, 403, 404, 409, 413, 415]) {
    assert.equal(send.isRetryableHttp(permanent), false, `HTTP ${permanent} must not be retried`);
  }
});

test('describeFailureReason translates the STOW failure codes and keeps the hex in brackets', () => {
  assert.match(send.describeFailureReason(42752), /out of resources/i); // 0xA700
  assert.match(send.describeFailureReason(42752), /\[0xA700\]/);
  assert.match(send.describeFailureReason(43264), /SOP Class/); // 0xA900
  assert.match(send.describeFailureReason(43264), /\[0xA900\]/);
  assert.match(send.describeFailureReason(272), /processing failure/i); // 0x0110
  assert.match(send.describeFailureReason(272), /\[0x0110\]/);
  assert.match(send.describeFailureReason(0x0122), /not supported/i);
  assert.match(send.describeFailureReason(0xc123), /cannot understand/i);
  assert.match(send.describeFailureReason(undefined), /without giving a reason code/);
});

// --- option resolution --------------------------------------------------------

test('web send without a URL is a usage error unless it is a dry run', async () => {
  await withEnv({}, () => {
    assert.throws(() => send.resolveSendOptions(tokenize([]).flags), UsageError);
    // A dry run opens no connection, so no URL is needed.
    const dry = send.resolveSendOptions(tokenize(['--dry-run']).flags);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.web, undefined);
  });
});

test('chunk size resolves flag, then DCM_WEB_CHUNK, then 50', async () => {
  await withEnv({ DCM_WEB_URL: 'https://pacs.example.org/dicom-web' }, () => {
    assert.equal(send.resolveSendOptions(tokenize([]).flags).chunkSize, 50);
  });
  await withEnv({ DCM_WEB_URL: 'https://pacs.example.org/dicom-web', DCM_WEB_CHUNK: '25' }, () => {
    assert.equal(send.resolveSendOptions(tokenize([]).flags).chunkSize, 25);
    assert.equal(send.resolveSendOptions(tokenize(['--chunk', '10']).flags).chunkSize, 10);
  });
});

test('nonsensical --chunk and --retry values are usage errors', async () => {
  await withEnv({ DCM_WEB_URL: 'https://pacs.example.org/dicom-web' }, () => {
    assert.throws(() => send.resolveSendOptions(tokenize(['--chunk', '0']).flags), UsageError);
    assert.throws(() => send.resolveSendOptions(tokenize(['--chunk', '2.5']).flags), UsageError);
    assert.throws(() => send.resolveSendOptions(tokenize(['--retry', '-1']).flags), UsageError);
  });
});

test('retries default to 1 and recurse defaults on, disabled by --no-recurse', async () => {
  await withEnv({ DCM_WEB_URL: 'https://pacs.example.org/dicom-web' }, () => {
    const opts = send.resolveSendOptions(tokenize([]).flags);
    assert.equal(opts.retries, 1);
    assert.equal(opts.recurse, true);
    assert.equal(send.resolveSendOptions(tokenize(['--no-recurse']).flags).recurse, false);
  });
});

test('web send rejects an unknown flag and a missing folder as usage errors', async () => {
  await withEnv({ DCM_WEB_URL: 'https://pacs.example.org/dicom-web' }, async () => {
    await assert.rejects(send.run(tokenize(['./x', '--called-ae', 'ARCHIVE'])), UsageError);
    await assert.rejects(send.run(tokenize([])), UsageError);
  });
});

test('web send --help prints the usage and exits 0', async () => {
  const { code, stdout } = await runCommand(send, ['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /dcm web send/);
  assert.match(stdout, /DCM_WEB_CHUNK/);
  assert.match(stdout, /202 means some were and some were not/);
});

// --- dry run: full scan-and-plan path, no network -----------------------------

test('web send --dry-run scans real fixtures, plans the requests, and opens no connection', async () => {
  await withTempDir('websend-dry', async (dir) => {
    const outDir = path.join(dir, 'fixtures');
    await generate({ outDir, quiet: true, studies: 1, seriesPerStudy: 2, instancesPerSeries: 3 });

    await withEnv({}, async () => {
      // No URL anywhere: a dry run must not require one.
      const { code, stdout } = await runCommand(send, [outDir, '--dry-run', '--chunk', '4']);
      assert.equal(code, 0);
      assert.match(stdout, /DRY RUN/);
      assert.match(stdout, /instances\s+6/);
      // 6 instances at chunk 4 -> 2 requests planned.
      assert.match(stdout, /associations\s+2 \(chunk size 4\)/);
    });
  });
});
