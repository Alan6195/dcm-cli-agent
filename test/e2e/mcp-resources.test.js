'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * End-to-end coverage for the MCP resources and prompts.
 *
 * The tools are covered by mcp.test.js; this file covers the reference layer —
 * the usage resources, the troubleshooting resource and the workflow prompts —
 * over a real stdio server driven by the official MCP client, which is the
 * exact path an assistant uses.
 *
 * The load-bearing assertion is the equality check: a usage resource must
 * return the command module's exported USAGE byte for byte. That is what
 * proves the resource is serving the command's own --help text rather than a
 * copy that will quietly go stale as flags are added.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 */

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');
const resources = require('../../src/commands/mcp/resources');

async function withClient(fn) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport , getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'],
      // StdioClientTransport does not inherit this process's environment: it
      // builds one from getDefaultEnvironment(), a fixed allow-list that cannot
      // include DCM_LINGER. Without this the server child opens every association
      // at the 1000 ms default while the suite believes it asked for 50.
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.DCM_LINGER ? { DCM_LINGER: process.env.DCM_LINGER } : {}),
      },
    });
  const client = new Client({ name: 'dcm-resources-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** The arguments each advertised prompt is exercised with. */
const PROMPT_ARGS = {
  'verify-a-peer': {
    host: 'pacs.example.org',
    port: '11112',
    calledAe: 'ARCHIVE',
    callingAe: 'DCM-CLI',
    folder: '/tmp/study',
  },
  'diagnose-a-failed-transfer': {
    report: 'found 823  sent 823  acknowledged 822',
  },
  'mirror-a-study': {
    direction: 'web-to-dimse',
    studyUid: '1.2.840.113619.2.55.3.604688.1',
    webUrl: 'https://pacs.example.org/dicom-web',
    workDir: '/tmp/mirror',
  },
};

test('mcp server advertises a usage resource for every command', async () => {
  await withClient(async (client) => {
    const { resources: listed } = await client.listResources();
    const uris = listed.map((r) => r.uri);

    for (const slug of ['echo', 'send', 'scp', 'find', 'info', 'tags', 'edit', 'anon', 'web', 'mcp']) {
      assert.ok(uris.includes(`dcm://usage/${slug}`), `missing dcm://usage/${slug}; got ${uris.join(', ')}`);
    }
    for (const verb of ['ping', 'send', 'query', 'retrieve', 'serve']) {
      assert.ok(uris.includes(`dcm://usage/web/${verb}`), `missing dcm://usage/web/${verb}`);
    }
    assert.ok(uris.includes(resources.INDEX_URI), 'missing the index resource');
    assert.ok(uris.includes(resources.TROUBLESHOOTING_URI), 'missing the troubleshooting resource');

    // Every resource must carry the metadata a client shows a user.
    for (const r of listed) {
      assert.ok(r.name, `${r.uri} needs a name`);
      assert.ok(r.description && r.description.length > 20, `${r.uri} needs a real description`);
      assert.equal(r.mimeType, 'text/plain', `${r.uri} should be text/plain`);
    }
  });
});

test('a usage resource is the command module USAGE, byte for byte', async () => {
  await withClient(async (client) => {
    // send is the richest usage text in the engine, so an accidental
    // reformat or truncation shows up here first.
    const res = await client.readResource({ uri: 'dcm://usage/send' });
    assert.equal(res.contents.length, 1);
    assert.equal(res.contents[0].uri, 'dcm://usage/send');
    assert.equal(res.contents[0].mimeType, 'text/plain');
    assert.equal(res.contents[0].text, require('../../src/commands/send').USAGE);
  });
});

test('every usage resource matches its own command module USAGE', async () => {
  await withClient(async (client) => {
    for (const source of resources.USAGE_SOURCES) {
      const uri = `dcm://usage/${source.slug}`;
      const res = await client.readResource({ uri });
      const expected = source.load().USAGE;
      assert.equal(typeof expected, 'string', `${source.command} must export USAGE`);
      assert.ok(expected.length > 0, `${source.command} USAGE must not be empty`);
      assert.equal(res.contents[0].text, expected, `${uri} drifted from ${source.command}'s USAGE`);
    }
  });
});

test('the index resource lists every usage resource that is registered', async () => {
  await withClient(async (client) => {
    const { resources: listed } = await client.listResources();
    const index = await client.readResource({ uri: resources.INDEX_URI });
    const text = index.contents[0].text;

    for (const r of listed) {
      if (r.uri === resources.INDEX_URI) continue;
      assert.ok(text.includes(r.uri), `the index does not mention ${r.uri}`);
    }
  });
});

test('the troubleshooting resource carries the traps that cost real time', async () => {
  await withClient(async (client) => {
    const res = await client.readResource({ uri: resources.TROUBLESHOOTING_URI });
    const text = res.contents[0].text;

    // Each of these is documented in README.md / CHANGELOG.md and is a thing an
    // assistant gets wrong without being told. Losing one is a regression.
    for (const trap of [
      'reason=3',
      'CALLING AET',
      '0x0122',
      'storing and indexing are separate',
      '/dicom-web',
      'not a storage grant',
      'DCM_WEB_TOKEN',
    ]) {
      assert.ok(text.includes(trap), `troubleshooting resource lost: ${trap}`);
    }
    // A good ping/echo must not be presented as proof of a storage grant.
    assert.match(text, /does not prove you may store/i);
  });
});

test('mcp server advertises the workflow prompts with their arguments', async () => {
  await withClient(async (client) => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ['diagnose-a-failed-transfer', 'mirror-a-study', 'verify-a-peer']);

    for (const p of prompts) {
      assert.ok(p.description && p.description.length > 40, `${p.name} needs a real description`);
      assert.ok(Array.isArray(p.arguments) && p.arguments.length > 0, `${p.name} needs arguments`);
      for (const arg of p.arguments) {
        assert.ok(arg.description, `${p.name}.${arg.name} needs a description`);
      }
      assert.ok(PROMPT_ARGS[p.name], `no test arguments for advertised prompt ${p.name}`);
    }
  });
});

test('every advertised prompt can be fetched with its arguments', async () => {
  await withClient(async (client) => {
    const { prompts } = await client.listPrompts();

    for (const p of prompts) {
      const res = await client.getPrompt({ name: p.name, arguments: PROMPT_ARGS[p.name] });
      assert.ok(res.messages.length > 0, `${p.name} returned no messages`);
      const text = res.messages[0].content.text;
      assert.equal(res.messages[0].role, 'user');
      assert.ok(text.length > 200, `${p.name} produced a suspiciously short body`);
      // The arguments must actually reach the body, not be silently dropped.
      for (const value of Object.values(PROMPT_ARGS[p.name])) {
        if (value.length < 6) continue;
        assert.ok(text.includes(value), `${p.name} dropped the argument value ${value}`);
      }
    }
  });
});

test('every required prompt argument really is required', async () => {
  await withClient(async (client) => {
    const { prompts } = await client.listPrompts();
    const verify = prompts.find((p) => p.name === 'verify-a-peer');
    const required = verify.arguments.filter((a) => a.required).map((a) => a.name).sort();
    assert.deepEqual(required, ['calledAe', 'host', 'port']);

    // Omitting one must be rejected by the server rather than producing a
    // prompt full of "undefined".
    await assert.rejects(
      () => client.getPrompt({ name: 'verify-a-peer', arguments: { host: 'pacs.example.org' } }),
      /Invalid arguments/i
    );
  });
});

test('the prompts only name tools this server actually registers', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const known = new Set(tools.map((t) => t.name));
    const { prompts } = await client.listPrompts();

    for (const p of prompts) {
      const res = await client.getPrompt({ name: p.name, arguments: PROMPT_ARGS[p.name] });
      const text = res.messages.map((m) => m.content.text).join('\n');
      for (const mentioned of text.match(/\bdcm_[a-z_]+\b/g) || []) {
        assert.ok(known.has(mentioned), `${p.name} names ${mentioned}, which is not a registered tool`);
      }
    }
  });
});

test('no prompt or resource asks for a DICOMweb credential value', async () => {
  await withClient(async (client) => {
    const { prompts } = await client.listPrompts();
    for (const p of prompts) {
      for (const arg of p.arguments) {
        assert.doesNotMatch(arg.name, /token|pass|secret|auth/i, `${p.name}.${arg.name} must not carry a credential`);
      }
    }
    // The troubleshooting text names the variables, which is the point; it must
    // not tell the assistant to obtain the value itself.
    const res = await client.readResource({ uri: resources.TROUBLESHOOTING_URI });
    assert.match(res.contents[0].text, /never ask for|Do not ask for the token/i);
  });
});
