'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dcmjsDimse = require('dcmjs-dimse');
const { Server } = dcmjsDimse;

const log = require('../../src/lib/log');
const { makeScpClass } = require('../../src/commands/scp');
const { createWebServer } = require('../../src/commands/web/serve');
const { tokenize } = require('../../src/lib/args');

// Keep the library quiet during tests; individual tests opt into verbosity.
dcmjsDimse.log.setLevel('silent');

/** Finds a free TCP port by binding to 0 and reading back what the OS gave us. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the real permissive receiver in-process.
 *
 * Uses the same Scp class the `dcm scp` command uses, so the tests exercise
 * shipped code rather than a stand-in.
 *
 * @param {object} config See makeScpClass.
 * @returns {Promise<{port: number, stats: object, close: function}>}
 */
async function startScp(config = {}) {
  const port = await freePort();
  const stats = {
    associations: 0, rejected: 0, echoes: 0, stored: 0,
    finds: 0, worklistMatches: 0, refused: 0, aborts: 0, errors: 0,
  };

  const full = {
    ae: config.ae,
    acceptCallingAe: config.acceptCallingAe ?? [],
    persist: config.persist,
    rejectAfter: config.rejectAfter ?? 0,
    // { file, items } from src/lib/worklist.loadWorklistFile, or undefined for
    // the default receiver that answers every C-FIND with zero matches.
    worklist: config.worklist,
  };

  const server = new Server(makeScpClass(full, stats));
  server.on('networkError', () => {
    stats.errors += 1;
  });

  await new Promise((resolve) => {
    server.on('listening', resolve);
    server.listen(port, { logCommandDatasets: false, logDatasets: false });
  });

  return {
    port,
    stats,
    close: () => {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Starts the real DICOMweb hub in-process.
 *
 * Uses the same createWebServer factory the `dcm web serve` command uses, so
 * the tests exercise shipped code rather than a stand-in — the web mirror of
 * startScp above.
 *
 * @param {object} config { persistDir?, rootDir?, requireToken?, rejectAfter? } — see createWebServer.
 * @returns {Promise<{port: number, stats: object, close: function}>}
 */
async function startWebServer(config = {}) {
  // The same stats object `dcm web serve`'s run() hands the factory; the hub
  // mutates it in place, so tests can read counters straight off it.
  const stats = {
    requests: 0, stored: 0, rejectedParts: 0, unauthorized: 0,
    queries: 0, retrievedInstances: 0, notFound: 0, errors: 0,
  };

  const server = createWebServer(config, stats);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  return {
    port,
    stats,
    close: () => {
      try {
        server.close();
        // Client requests ride Node's keep-alive global agent, so idle
        // sockets would otherwise hold the server (and the test process)
        // open for the keep-alive timeout.
        server.closeAllConnections?.();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Runs a command module the way the CLI would, capturing everything it prints.
 *
 * @param {object} mod   A command module exposing run().
 * @param {string[]} argv
 * @returns {Promise<{code: number, stdout: string, stderr: string, output: string}>}
 */
async function runCommand(mod, argv) {
  const parsed = tokenize(argv);

  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;

  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };

  // Colour codes would make output assertions brittle.
  log.configure({ noColor: true });

  let code;
  try {
    code = await mod.run(parsed);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  const out = stdout.join('');
  const err = stderr.join('');
  return { code, stdout: out, stderr: err, output: out + err };
}

/** Creates a throwaway directory that is removed when the callback finishes. */
async function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { freePort, startScp, startWebServer, runCommand, withTempDir };
