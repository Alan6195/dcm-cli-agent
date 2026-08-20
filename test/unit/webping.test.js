'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const log = require('../../src/lib/log');
const { UsageError, tokenize } = require('../../src/lib/args');
const { runCommand } = require('../helpers/harness');
const ping = require('../../src/commands/web/ping');
const { translateTransportFailure } = require('../../src/lib/webdicom');

// resolveWebOptions legitimately warns about cleartext and --insecure; those
// warnings are for operators, not for the test log.
log.configure({ quiet: true, noColor: true });

/** All env vars the web option resolver reads; each test starts clean. */
const ENV_KEYS = ['DCM_WEB_URL', 'DCM_WEB_TOKEN', 'DCM_WEB_USER', 'DCM_WEB_PASS', 'DCM_WEB_TIMEOUT'];

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

test('web ping --help prints the usage and exits 0 without touching the network', async () => {
  const { code, stdout } = await runCommand(ping, ['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /dcm web ping/);
  assert.match(stdout, /DCM_WEB_URL/);
  assert.match(stdout, /storage \(STOW-RS\) is a separate grant/);
});

test('web ping without a URL is a usage error, not an operational failure', async () => {
  await withEnv({}, async () => {
    await assert.rejects(ping.run(tokenize([])), UsageError);
  });
});

test('web ping rejects an unknown flag with a usage error', async () => {
  await withEnv({ DCM_WEB_URL: 'https://pacs.example.org/dicom-web' }, async () => {
    await assert.rejects(ping.run(tokenize(['--host', 'pacs.example.org'])), UsageError);
  });
});

test('translateTransportFailure keeps the raw code in brackets for every shape of failure', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'DCM_WEB_TIMEOUT', 'ESOMETHINGELSE']) {
    const err = Object.assign(new Error('boom'), { code });
    assert.match(translateTransportFailure(err).join('\n'), new RegExp(`\\[${code}\\]`));
  }
});

test('translateTransportFailure explains a refused connection in terms of the port', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const text = translateTransportFailure(err).join('\n');
  assert.match(text, /nothing is listening/i);
  assert.match(text, /port/i);
});

test('translateTransportFailure names the hostname that did not resolve', () => {
  const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
    code: 'ENOTFOUND',
    hostname: 'pacs.internal.example',
  });
  const text = translateTransportFailure(err).join('\n');
  assert.match(text, /pacs\.internal\.example/);
});

test('translateTransportFailure distinguishes a timeout from a refusal', () => {
  const err = Object.assign(new Error('No complete response within 100 ms.'), {
    code: 'DCM_WEB_TIMEOUT',
  });
  const text = translateTransportFailure(err).join('\n');
  assert.match(text, /timeout/i);
  assert.doesNotMatch(text, /nothing is listening/i);
});

test('translateTransportFailure points a self-signed certificate failure at --insecure, with a caution', () => {
  const err = Object.assign(new Error('self signed certificate'), {
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  });
  const text = translateTransportFailure(err).join('\n');
  assert.match(text, /--insecure/);
  assert.match(text, /[Nn]ever use it against a production/);
});
