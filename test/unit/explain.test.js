'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const { runCommand } = require('../helpers/harness');

/**
 * `dcm explain` is the one command that talks to something outside the machine,
 * which makes it the one command that cannot be exercised by simply running it.
 * These tests stand a fake SDK in front of it and assert on the request it
 * builds, so everything except the network round-trip is verified: the model,
 * the cache breakpoint, where the volatile log is placed, redaction, refusal
 * handling, and the rule that the key comes only from the environment.
 */

const SDK = '@anthropic-ai/sdk';
const sdkPath = require.resolve(SDK);

/** Captures the last request and returns a canned response. */
function installFakeSdk(behaviour) {
  const captured = { requests: [], constructedWith: undefined };

  class FakeAnthropic {
    constructor(options) {
      captured.constructedWith = options;
      this.beta = {
        messages: {
          create: async (request) => {
            captured.requests.push(request);
            if (behaviour.throws) throw behaviour.throws;
            return behaviour.response;
          },
        },
      };
    }
  }

  const fakeModule = new Module(sdkPath, null);
  fakeModule.filename = sdkPath;
  fakeModule.loaded = true;
  fakeModule.exports = FakeAnthropic;
  require.cache[sdkPath] = fakeModule;

  return captured;
}

function restoreSdk() {
  delete require.cache[sdkPath];
}

/** Loads a fresh copy of the command so module-level state cannot leak. */
function loadExplain() {
  const explainPath = require.resolve('../../src/commands/explain');
  delete require.cache[explainPath];
  return require(explainPath);
}

/** Runs explain with stdin replaced by a fixed string. */
async function explainWith(input, argv, behaviour = {}) {
  const captured = installFakeSdk({
    response: behaviour.response ?? {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'The peer rejected the association.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    throws: behaviour.throws,
  });

  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const { Readable } = require('stream');
  const fake = Readable.from([Buffer.from(input)]);
  fake.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });

  const previousKey = process.env.ANTHROPIC_API_KEY;
  if (behaviour.apiKey !== null) {
    process.env.ANTHROPIC_API_KEY = behaviour.apiKey ?? 'sk-ant-test-key';
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }

  try {
    const explain = loadExplain();
    const result = await runCommand(explain, argv);
    return { ...result, captured };
  } finally {
    Object.defineProperty(process, 'stdin', descriptor);
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    restoreSdk();
  }
}

test('sends a current model and marks the stable prefix as cacheable', async () => {
  const { code, captured } = await explainWith('A-ASSOCIATE-RJ reason 3', []);
  assert.equal(code, 0);
  assert.equal(captured.requests.length, 1);

  const request = captured.requests[0];
  assert.equal(request.model, 'claude-opus-5');

  // The reference block is identical on every invocation, so it is the cache
  // prefix. Without a breakpoint here every call rewrites the cache.
  assert.equal(request.system[0].cache_control.type, 'ephemeral');
  assert.ok(request.system[0].text.length > 1000, 'the cached prefix must be substantial');
});

test('the volatile log goes after the cached prefix, never inside it', async () => {
  // Interpolating the log into the system prompt would change the cache prefix
  // on every single call, so nothing would ever be read from cache.
  const marker = 'UNIQUE-LOG-MARKER-12345';
  const { captured } = await explainWith(`something failed ${marker}`, []);
  const request = captured.requests[0];

  assert.doesNotMatch(request.system[0].text, new RegExp(marker), 'log must not reach the system prompt');
  assert.match(request.messages[0].content, new RegExp(marker), 'log belongs in the user turn');
  assert.equal(request.messages[0].role, 'user');
});

test('the cached prefix is byte-identical across calls', async () => {
  const first = await explainWith('failure one', []);
  const second = await explainWith('a completely different failure', []);

  assert.equal(
    first.captured.requests[0].system[0].text,
    second.captured.requests[0].system[0].text,
    'any variation in the prefix defeats caching entirely'
  );
});

test('identifiers are redacted before anything leaves the machine', async () => {
  const input = 'PatientName: DOE^JANE PatientID: 12345 failed with reason 3';
  const { captured, output } = await explainWith(input, []);

  const sent = captured.requests[0].messages[0].content;
  assert.doesNotMatch(sent, /DOE\^JANE/, 'the patient name must not be sent');
  assert.doesNotMatch(sent, /12345/, 'the patient ID must not be sent');
  assert.match(sent, /REDACTED/);
  // The operator is told what was removed rather than it happening silently.
  assert.match(output, /redacted before sending/i);
});

test('UIDs survive redaction, because they are what makes a failure diagnosable', async () => {
  const input = 'StudyInstanceUID: 1.2.840.113619.2.55.3.604688.1 refused';
  const { captured } = await explainWith(input, []);
  assert.match(captured.requests[0].messages[0].content, /1\.2\.840\.113619\.2\.55\.3\.604688\.1/);
});

test('--no-redact sends verbatim and says so', async () => {
  const input = 'PatientName: DOE^JANE failed';
  const { captured, output } = await explainWith(input, ['--no-redact']);
  assert.match(captured.requests[0].messages[0].content, /DOE\^JANE/);
  assert.match(output, /sent verbatim/i);
});

test('--show-prompt makes no network call at all', async () => {
  const { code, captured, output } = await explainWith('anything', ['--show-prompt']);
  assert.equal(code, 0);
  assert.equal(captured.requests.length, 0, 'nothing may be sent');
  assert.match(output, /No network call was made/);
});

test('a refusal is handled instead of crashing on empty content', async () => {
  // A refusal returns HTTP 200 with no usable content. Reading content[0]
  // without checking stop_reason throws here rather than explaining itself.
  const { code, output } = await explainWith('anything', [], {
    response: {
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', explanation: 'declined' },
      content: [],
    },
  });
  assert.equal(code, 1);
  assert.match(output, /declined to answer/i);
});

test('a truncated response warns rather than passing off a half answer', async () => {
  const { code, output } = await explainWith('anything', [], {
    response: {
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'partial diagnosis' }],
      usage: {},
    },
  });
  assert.equal(code, 0);
  assert.match(output, /hit --max-tokens/i);
});

test('the API key is read from the environment and nowhere else', async () => {
  const { captured } = await explainWith('anything', [], { apiKey: 'sk-ant-from-env' });
  assert.equal(captured.constructedWith.apiKey, 'sk-ant-from-env');
});

test('a missing key fails helpfully and stresses the command is optional', async () => {
  const { code, output } = await explainWith('anything', [], { apiKey: null });
  assert.equal(code, 1);
  assert.match(output, /ANTHROPIC_API_KEY is not set/);
  assert.match(output, /optional/i, 'must make clear the rest of the tool is unaffected');
  assert.match(output, /no flag and no/i, 'must explain why there is no --api-key');
});

test('there is no way to pass a key as a flag', async () => {
  // A key on the command line lands in shell history and process listings.
  const explain = loadExplain();
  assert.doesNotMatch(explain.USAGE, /--api-key/);
  assert.doesNotMatch(explain.USAGE, /--key\b/);
  assert.match(explain.USAGE, /ANTHROPIC_API_KEY/);
});

test('API errors are reported by cause, not as a stack trace', async () => {
  for (const [status, expected] of [[401, /rejected the key/i], [429, /Rate limited/i]]) {
    const { code, output } = await explainWith('anything', [], {
      throws: Object.assign(new Error('boom'), { status }),
    });
    assert.equal(code, 1);
    assert.match(output, expected);
  }
});

test('empty input is refused before a request is built', async () => {
  await assert.rejects(() => explainWith('   \n  ', []), /empty/i);
});
