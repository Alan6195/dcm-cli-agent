'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeRejection,
  describeAbort,
  describeTimeout,
  describeTransportError,
  OutcomeKind,
} = require('../../src/lib/reject');

test('reason 3 from the service user is translated, not printed as a code', () => {
  // The single most common real-world failure. The raw code sends people to
  // debug their own code; the translation points at the peer's allowlist.
  const d = describeRejection({ result: 1, source: 1, reason: 3 });

  assert.equal(d.kind, OutcomeKind.REJECTED);
  assert.match(d.label, /Calling AE Title not recognized/i);
  assert.match(
    d.headline,
    /registered\/allowlisted on the receiving side/i,
    'must say plainly that this is a peer-side registration problem'
  );
  assert.match(d.hint, /configuration issue, not a code issue/i);
  assert.equal(d.permanence, 'permanent');
  assert.equal(d.retryable, false);
  assert.match(d.raw, /result=1 source=1 reason=3/);
});

test('reason codes are interpreted per source, not globally', () => {
  // Reason 3 means "calling AE not recognized" only from source 1. From a
  // service-provider source it is not a defined value at all. Flattening the
  // table would produce confidently wrong advice.
  const fromUser = describeRejection({ result: 1, source: 1, reason: 3 });
  const fromProvider = describeRejection({ result: 1, source: 3, reason: 3 });

  assert.match(fromUser.label, /Calling AE Title not recognized/i);
  assert.doesNotMatch(fromProvider.label, /Calling AE Title not recognized/i);
  assert.match(fromProvider.headline, /not a value defined for that source/i);

  // Reason 2 legitimately means three different things depending on source.
  assert.match(describeRejection({ result: 1, source: 1, reason: 2 }).label, /application context/i);
  assert.match(describeRejection({ result: 1, source: 2, reason: 2 }).label, /protocol version/i);
  assert.match(describeRejection({ result: 1, source: 3, reason: 2 }).label, /local limit/i);
});

test('called AE mismatch is distinguished from calling AE mismatch', () => {
  const called = describeRejection({ result: 1, source: 1, reason: 7 });
  assert.match(called.label, /Called AE Title not recognized/i);
  assert.match(called.hint, /--called-ae/);
});

test('transient rejections are marked retryable, permanent ones are not', () => {
  assert.equal(describeRejection({ result: 2, source: 3, reason: 1 }).retryable, true);
  assert.equal(describeRejection({ result: 1, source: 1, reason: 3 }).retryable, false);
});

test('an abort reads as distinct from a rejection', () => {
  // Different cause, different fix. An abort means the association was
  // accepted and then torn down.
  const d = describeAbort({ source: 2, reason: 1 });
  assert.equal(d.kind, OutcomeKind.ABORTED);
  assert.match(d.headline, /not a rejection/i);
  assert.match(d.headline, /already accepted the association/i);
  assert.equal(d.retryable, true);
});

test('a timeout reads as distinct from a rejection', () => {
  // A rejection is an answer; a timeout is silence. Conflating them costs
  // real debugging time.
  const connect = describeTimeout({ phase: 'connect', timeoutMs: 15000 });
  const negotiate = describeTimeout({ phase: 'association', timeoutMs: 30000 });
  const midStream = describeTimeout({ phase: 'pdu', timeoutMs: 60000 });

  assert.equal(connect.kind, OutcomeKind.TIMEOUT);
  assert.match(connect.headline, /No TCP connection/i);
  assert.match(connect.hint, /firewall/i);

  assert.match(negotiate.headline, /did not complete association negotiation/i);

  // The mid-transfer stall is the one operators most need named correctly.
  assert.match(midStream.headline, /accepted the association but stopped responding/i);
  assert.match(midStream.hint, /mid-transfer stall/i);
  assert.match(midStream.hint, /not a rejection/i);

  for (const outcome of [connect, negotiate, midStream]) {
    assert.equal(outcome.retryable, true);
    assert.match(outcome.raw, /timeout/);
  }
});

test('transport errors are named by cause', () => {
  const refused = describeTransportError(
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    { host: 'pacs.example.org', port: 11112 }
  );
  assert.equal(refused.kind, OutcomeKind.TRANSPORT);
  assert.match(refused.headline, /Nothing is accepting connections/i);
  assert.match(refused.headline, /pacs\.example\.org:11112/);
  assert.equal(refused.retryable, false, 'a refused connection will not fix itself');

  const dns = describeTransportError(
    Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    { host: 'pacs.example.org', port: 11112 }
  );
  assert.match(dns.headline, /could not be resolved by DNS/i);
  assert.match(dns.hint, /VPN|internal network/i);

  const timedOut = describeTransportError(
    Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    { host: 'pacs.example.org', port: 11112 }
  );
  assert.match(timedOut.hint, /firewall dropping packets/i);
});

test('an unknown transport error still produces something readable', () => {
  const d = describeTransportError(new Error('something odd'), { host: 'h', port: 1 });
  assert.equal(d.kind, OutcomeKind.TRANSPORT);
  assert.match(d.headline, /something odd/);
});
