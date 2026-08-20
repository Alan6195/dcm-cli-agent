'use strict';

/**
 * End-to-end coverage for the DICOMweb tools of `dcm mcp`.
 *
 * Two real things are wired together here and nothing is stubbed:
 *
 *   - `dcm mcp` runs as a child process speaking JSON-RPC over stdio, driven
 *     by the official MCP client — the same path Claude Code or Claude Desktop
 *     uses, so a regression here breaks the integration the server exists for.
 *   - the DICOMweb hub from `dcm web serve` runs in *this* process via
 *     startWebServer, so the tools talk to a genuine STOW/QIDO/WADO
 *     implementation and the hub's own counters can confirm what happened.
 *
 * Because the server is a child process, its stdout is a pipe the transport
 * owns; the hub logs through src/lib/log in the test process and never touches
 * it. That separation is why this file can use the harness directly rather than
 * the capture dance test/e2e/webflow.test.js needs.
 *
 * The MCP SDK is ESM; it is loaded with dynamic import from these CommonJS
 * tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startWebServer, withTempDir } = require('../helpers/harness');
const { generate } = require('../../tools/make-fixtures');

const BIN = path.join(__dirname, '..', '..', 'bin', 'dcm.js');

/**
 * The environment for the spawned server.
 *
 * DCM_WEB_URL and the credential variables are stripped deliberately. They are
 * exactly the inputs these tools read from the environment rather than from
 * arguments, so a value leaking in from the developer's shell would silently
 * change what is being tested — and a stray DCM_WEB_TOKEN would send an
 * Authorization header to the hub that the test never asked for.
 */
function serverEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', ...extra };
  for (const key of ['DCM_WEB_URL', 'DCM_WEB_TOKEN', 'DCM_WEB_USER', 'DCM_WEB_PASS', 'DCM_WEB_TIMEOUT', 'DCM_WEB_CHUNK']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

/**
 * Connects an MCP client to a freshly spawned `dcm mcp`, and always closes it.
 *
 * @param {(client: object) => Promise<any>} fn
 * @param {object} [env]  Extra environment for the child.
 * @returns {Promise<any>}
 */
async function withClient(fn, env = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    env: serverEnv(env),
  });
  const client = new Client({ name: 'dcm-web-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Generates a small fixture tree: 1 study, 2 series, 3 instances each. */
async function fixtures(dir) {
  return generate({
    outDir: dir,
    quiet: true,
    studies: 1,
    seriesPerStudy: 2,
    instancesPerSeries: 3,
    rows: 16,
    cols: 16,
  });
}

function hubUrl(hub) {
  return `http://127.0.0.1:${hub.port}`;
}

/** The property names of a tool's input schema, as advertised. */
function schemaKeys(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return Object.keys(tool.inputSchema?.properties ?? {});
}

test('the DICOMweb tools are advertised with the whole option set the commands take', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();

    // Every option the CLI accepts has to be reachable, or an assistant is
    // stuck asking a person to run the command by hand.
    const expected = {
      dcm_web_ping: ['url', 'timeout', 'insecure'],
      dcm_web_send: ['url', 'folder', 'chunk', 'retry', 'dryRun', 'noRecurse', 'insecure', 'timeout'],
      dcm_web_query: ['url', 'level', 'keys', 'limit', 'offset', 'include', 'insecure', 'timeout'],
      dcm_web_retrieve: ['url', 'studyUid', 'seriesUid', 'instanceUid', 'outDir', 'insecure', 'timeout'],
    };

    for (const [name, keys] of Object.entries(expected)) {
      const actual = schemaKeys(tools, name);
      for (const key of keys) {
        assert.ok(actual.includes(key), `${name} is missing "${key}"; has ${actual.join(', ')}`);
      }
    }

    // Credentials are environment-only. No schema field may exist that could
    // carry one: a token in a tool argument is a token in the transcript.
    for (const name of Object.keys(expected)) {
      for (const key of schemaKeys(tools, name)) {
        assert.doesNotMatch(
          key,
          /token|password|passwd|pass$|secret|credential|auth/i,
          `${name}.${key} looks like a credential field`
        );
      }
    }

    // The hub is a long-lived process and belongs to the server-lifecycle
    // tools, not here.
    assert.equal(tools.find((t) => t.name === 'dcm_web_serve'), undefined);
  });
});

test('ping, send, query and retrieve round-trip through the MCP server against a real hub', async () => {
  await withTempDir('dcm-mcp-web', async (dir) => {
    const src = path.join(dir, 'src');
    const received = path.join(dir, 'received');
    const pulled = path.join(dir, 'pulled');
    const manifest = await fixtures(src); // 6 instances
    const study = manifest.studies[0];

    const hub = await startWebServer({ persistDir: received });
    try {
      await withClient(async (client) => {
        const url = hubUrl(hub);

        // --- ping ---------------------------------------------------------
        const ping = await client.callTool({ name: 'dcm_web_ping', arguments: { url } });
        assert.ok(!ping.isError, `ping should succeed: ${ping.content[0].text}`);
        assert.match(ping.content[0].text, /OK/);
        // The honesty the description promises has to survive into the result.
        assert.match(ping.content[0].text, /does not prove the server will accept images/i);

        // --- send ---------------------------------------------------------
        const send = await client.callTool({
          name: 'dcm_web_send',
          arguments: { url, folder: src, chunk: 4, retry: 0 },
        });
        assert.ok(!send.isError, `send should succeed: ${send.content[0].text}`);
        assert.match(send.content[0].text, /files found\s+6/);
        assert.match(send.content[0].text, /acknowledged\s+6/);

        // The hub's own counter, not the client's report — the two agreeing is
        // the point of running a real server.
        assert.equal(hub.stats.stored, 6, 'the hub should have stored 6 instances');
        assert.equal(hub.stats.rejectedParts, 0);

        // --- query (study level) -------------------------------------------
        const q = await client.callTool({
          name: 'dcm_web_query',
          arguments: { url, keys: { PatientID: 'SYNTH*' }, limit: 10 },
        });
        assert.ok(!q.isError, `query should succeed: ${q.content[0].text}`);
        assert.equal(q.structuredContent.ok, true);
        assert.equal(q.structuredContent.level, 'studies');
        assert.equal(q.structuredContent.count, 1);
        assert.equal(q.structuredContent.matches[0].StudyInstanceUID, study.studyInstanceUid);

        // --- query (series level, narrowed into the study) -----------------
        // Narrowing is a URL-path decision, not a filter: the request must go
        // to /studies/<uid>/series, which is what makes the level useful.
        const qs = await client.callTool({
          name: 'dcm_web_query',
          arguments: {
            url,
            level: 'series',
            keys: { StudyInstanceUID: study.studyInstanceUid },
            include: ['NumberOfSeriesRelatedInstances'],
            offset: 0,
          },
        });
        assert.ok(!qs.isError, `series query should succeed: ${qs.content[0].text}`);
        assert.equal(qs.structuredContent.count, 2, 'the fixture study has 2 series');
        assert.match(qs.structuredContent.url, new RegExp(`/studies/${study.studyInstanceUid}/series`));

        // --- retrieve -------------------------------------------------------
        const r = await client.callTool({
          name: 'dcm_web_retrieve',
          arguments: { url, studyUid: study.studyInstanceUid, outDir: pulled },
        });
        assert.ok(!r.isError, `retrieve should succeed: ${r.content[0].text}`);
        assert.equal(r.structuredContent.ok, true);
        assert.equal(r.structuredContent.partial, false);
        assert.equal(r.structuredContent.received, 6);
        assert.equal(r.structuredContent.written, 6);

        // Written in the UID layout, on disk, where the report says they are.
        for (const series of study.series) {
          for (const inst of series.instances) {
            const dest = path.join(pulled, study.studyInstanceUid, series.seriesInstanceUid, `${inst.sopInstanceUid}.dcm`);
            assert.ok(fs.existsSync(dest), `expected ${dest} to exist`);
          }
        }

        // --- retrieve, narrowed to one series -------------------------------
        const oneSeries = study.series[0];
        const rs = await client.callTool({
          name: 'dcm_web_retrieve',
          arguments: {
            url,
            studyUid: study.studyInstanceUid,
            seriesUid: oneSeries.seriesInstanceUid,
            outDir: path.join(dir, 'pulled-series'),
          },
        });
        assert.ok(!rs.isError, `series retrieve should succeed: ${rs.content[0].text}`);
        assert.equal(rs.structuredContent.written, oneSeries.instances.length);
      });
    } finally {
      hub.close();
    }
  });
});

test('a query that matches nothing is an error result, not a crash', async () => {
  await withTempDir('dcm-mcp-web-empty', async (dir) => {
    const hub = await startWebServer({ persistDir: path.join(dir, 'received') });
    try {
      await withClient(async (client) => {
        const res = await client.callTool({
          name: 'dcm_web_query',
          arguments: { url: hubUrl(hub), keys: { PatientID: 'NOBODY-EVER' } },
        });

        // Zero matches exits 1 by CLI convention, which the runtime turns into
        // an error result. It has to arrive as an answer — text explaining that
        // nothing matched — rather than a transport failure or a hang.
        assert.equal(res.isError, true);
        assert.ok(res.content[0].text.trim().length > 0, 'an empty result should still explain itself');
        assert.doesNotMatch(res.content[0].text, /ECONNREFUSED|Cannot read|undefined is not/i);

        // The hub answered: it counted the query and reported no errors.
        assert.equal(hub.stats.queries, 1);
        assert.equal(hub.stats.errors, 0);
      });
    } finally {
      hub.close();
    }
  });
});

test('the base URL and the credentials both come from the server environment', async () => {
  await withTempDir('dcm-mcp-web-env', async (dir) => {
    const hub = await startWebServer({ persistDir: path.join(dir, 'received'), requireToken: 'test-secret-1' });
    try {
      // No url argument and no token argument: the operator launches the
      // server with these set, and the assistant never sees either value.
      await withClient(async (client) => {
        const res = await client.callTool({ name: 'dcm_web_ping', arguments: {} });
        assert.ok(!res.isError, `ping should succeed on env config: ${res.content[0].text}`);
        assert.match(res.content[0].text, /bearer token from DCM_WEB_TOKEN was accepted/);
        assert.equal(hub.stats.unauthorized, 0);
      }, { DCM_WEB_URL: hubUrl(hub), DCM_WEB_TOKEN: 'test-secret-1' });
    } finally {
      hub.close();
    }
  });
});

test('retrieving an instance without its series is refused as a usage error, not attempted', async () => {
  await withTempDir('dcm-mcp-web-usage', async (dir) => {
    const hub = await startWebServer({ persistDir: path.join(dir, 'received') });
    try {
      await withClient(async (client) => {
        const res = await client.callTool({
          name: 'dcm_web_retrieve',
          arguments: {
            url: hubUrl(hub),
            studyUid: '1.2.840.10008.1.2.3',
            instanceUid: '1.2.840.10008.1.2.3.4',
            outDir: path.join(dir, 'pulled'),
          },
        });

        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /--instance needs --series/);
        // Nothing should have been asked of the server.
        assert.equal(hub.stats.requests, 0);
      });
    } finally {
      hub.close();
    }
  });
});
