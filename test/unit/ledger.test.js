'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TransferLedger, StudyLedger, Disposition } = require('../../src/lib/ledger');

/**
 * These tests exist for one bug: a transfer that loses files but reports
 * success. Everything here is about making that impossible to do quietly.
 */

test('reports found, sent and acknowledged as three separate numbers', () => {
  const ledger = new StudyLedger('1.2.3');
  for (let i = 0; i < 5; i++) {
    ledger.addFile({ path: `/tmp/${i}.dcm`, sopInstanceUid: `1.2.3.${i}` });
  }

  // Three read fine and are acknowledged; one fails to parse; one is refused.
  ledger.entries[0].dispatched = true;
  ledger.entries[0].settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
  ledger.entries[1].dispatched = true;
  ledger.entries[1].settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
  ledger.entries[2].dispatched = true;
  ledger.entries[2].settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
  ledger.entries[3].settle(Disposition.READ_ERROR, { detail: 'truncated' });
  ledger.entries[4].dispatched = true;
  ledger.entries[4].settle(Disposition.FAILED, { status: 0x0122 });

  const result = ledger.reconcile();

  assert.equal(result.found, 5, 'five files were discovered on disk');
  assert.equal(result.sent, 4, 'only four were actually dispatched');
  assert.equal(result.acknowledged, 3, 'only three were acknowledged');
  assert.equal(result.shortfall, 2);
  assert.equal(result.ok, false);
});

test('an entry that no code path settles is reported as unaccounted, not dropped', () => {
  // This is the exact shape of the silent-drop bug: a file is discovered, some
  // branch forgets to record what happened to it, and the totals quietly stop
  // adding up. Reconciliation has to catch it rather than round it away.
  const ledger = new StudyLedger('1.2.3');
  ledger.addFile({ path: '/tmp/a.dcm' });
  ledger.addFile({ path: '/tmp/b.dcm' });

  ledger.entries[0].dispatched = true;
  ledger.entries[0].settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
  // entries[1] is deliberately left unsettled.

  const result = ledger.reconcile();

  assert.equal(result.found, 2);
  assert.equal(result.acknowledged, 1);
  assert.deepEqual(result.unaccounted, ['/tmp/b.dcm']);
  assert.equal(result.accounted, 1, 'dispositions must not silently cover the gap');
  assert.notEqual(result.accounted, result.found);
  assert.equal(result.ok, false, 'an unaccounted file must fail the run');
});

test('settleOutstanding converts silence into a counted outcome', () => {
  const ledger = new StudyLedger('1.2.3');
  ledger.addFile({ path: '/tmp/sent.dcm' });
  ledger.addFile({ path: '/tmp/never-sent.dcm' });

  // One was handed to the peer, one never got a turn.
  ledger.entries[0].dispatched = true;

  const closed = ledger.settleOutstanding('peer stopped responding');
  assert.equal(closed, 2);

  const result = ledger.reconcile();
  assert.equal(result.unanswered, 1, 'dispatched but unanswered');
  assert.equal(result.notAttempted, 1, 'never dispatched');
  assert.equal(result.unaccounted.length, 0, 'nothing left unaccounted');
  assert.equal(result.accounted, result.found);
  assert.equal(result.ok, false);
});

test('rejections funnelled through the ledger surface as a shortfall', () => {
  // Guards the Promise.allSettled failure mode directly: if every rejection is
  // routed into the ledger, a lossy run cannot print as a clean one — the
  // discarded outcomes become UNANSWERED and the totals disagree.
  const ledger = new StudyLedger('1.2.3');
  for (let i = 0; i < 823; i++) ledger.addFile({ path: `/tmp/${i}.dcm` });

  const settled = ledger.entries.map((entry, i) => {
    entry.dispatched = true;
    // One instance out of 823 never comes back — the real-world case.
    return i === 500 ? Promise.reject(new Error('socket closed')) : Promise.resolve(i);
  });

  return Promise.allSettled(settled).then((results) => {
    results.forEach((outcome, i) => {
      const entry = ledger.entries[i];
      if (outcome.status === 'fulfilled') {
        entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
      } else {
        entry.settle(Disposition.UNANSWERED, { detail: outcome.reason.message });
      }
    });

    const result = ledger.reconcile();
    assert.equal(result.found, 823);
    assert.equal(result.acknowledged, 822);
    assert.equal(result.shortfall, 1, '823 found and 822 acknowledged is a failure');
    assert.equal(result.ok, false);
  });
});

test('warnings are not counted as success', () => {
  // A coerced element means the receiver rewrote the data. Folding that into
  // the success count hides a real change to what the peer now holds.
  const ledger = new StudyLedger('1.2.3');
  ledger.addFile({ path: '/tmp/a.dcm' });
  ledger.entries[0].dispatched = true;
  ledger.entries[0].settle(Disposition.WARNING, { status: 0xb000 });

  const result = ledger.reconcile();
  assert.equal(result.acknowledged, 0);
  assert.equal(result.warning, 1);
  assert.equal(result.shortfall, 1);
  assert.equal(result.ok, false);
});

test('settling the same entry twice throws instead of double-counting', () => {
  const ledger = new StudyLedger('1.2.3');
  const entry = ledger.addFile({ path: '/tmp/a.dcm' });
  entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });

  assert.throws(
    () => entry.settle(Disposition.FAILED, { status: 0x0110 }),
    /Double-settle/,
    'two code paths claiming one file is a bug that must surface'
  );
});

test('retry preserves the earlier attempt and its status', () => {
  const ledger = new StudyLedger('1.2.3');
  const entry = ledger.addFile({ path: '/tmp/a.dcm' });

  entry.dispatched = true;
  entry.settle(Disposition.FAILED, { status: 0xa700 });
  assert.equal(entry.retryable, true);

  entry.resetForRetry();
  assert.equal(entry.settled, false);
  assert.equal(entry.dispatched, false);
  assert.equal(entry.attempts.length, 1);
  assert.equal(entry.attempts[0].status, 0xa700);

  entry.dispatched = true;
  entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });

  const result = ledger.reconcile();
  assert.equal(result.acknowledged, 1);
  assert.equal(result.ok, true, 'a successful retry is a success');
  // The refusal history must survive, or a flaky peer looks healthy.
  assert.equal(result.retriedEntries, 1);
  assert.equal(result.statusCounts.get(0xa700), 1, 'the earlier refusal is still counted');
  assert.equal(result.statusCounts.get(0x0000), 1);
});

test('a clean run reconciles to ok', () => {
  const ledger = new StudyLedger('1.2.3');
  for (let i = 0; i < 10; i++) {
    const entry = ledger.addFile({ path: `/tmp/${i}.dcm` });
    entry.dispatched = true;
    entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
  }
  const result = ledger.reconcile();
  assert.equal(result.found, 10);
  assert.equal(result.sent, 10);
  assert.equal(result.acknowledged, 10);
  assert.equal(result.shortfall, 0);
  assert.equal(result.accounted, result.found);
  assert.equal(result.ok, true);
});

test('unreadable files count toward the run total', () => {
  // A file that could not be parsed still exists on disk. Excluding it from
  // the totals would make a lossy run look complete.
  const ledger = new TransferLedger();
  const study = ledger.study('1.2.3');
  const entry = study.addFile({ path: '/tmp/good.dcm' });
  entry.dispatched = true;
  entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });

  ledger.addUnassignable('/tmp/corrupt.dcm', new Error('meta length tag malformed'));

  const result = ledger.reconcile();
  assert.equal(result.totals.found, 2, 'the corrupt file is still a file that was found');
  assert.equal(result.totals.acknowledged, 1);
  assert.equal(result.totals.shortfall, 1);
  assert.equal(result.ok, false);
});

test('totals roll up across studies', () => {
  const ledger = new TransferLedger();
  for (const uid of ['1.2.3', '1.2.4']) {
    const study = ledger.study(uid);
    for (let i = 0; i < 3; i++) {
      const entry = study.addFile({ path: `/tmp/${uid}-${i}.dcm` });
      entry.dispatched = true;
      entry.settle(Disposition.ACKNOWLEDGED, { status: 0x0000 });
    }
  }

  const result = ledger.reconcile();
  assert.equal(result.totals.studies, 2);
  assert.equal(result.totals.found, 6);
  assert.equal(result.totals.acknowledged, 6);
  assert.equal(result.ok, true);
});
