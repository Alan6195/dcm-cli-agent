'use strict';

/**
 * What main.js forks as the utilityProcess for each engine run:
 *
 *   engine-host.js <entry> [args...]
 *
 * A utility process differs from plain Node in one way that matters here: it
 * does not exit when its work is done. Its link to the parent keeps the event
 * loop alive, so a command that finishes, sets process.exitCode and returns
 * (as bin/dcm.js does, so piped output can drain) would sit there forever and
 * the run would never end. This host supplies the exit plain Node would have:
 *
 *   - For the engine, it calls the command's own main(). For anything else
 *     (the smoke harness's flood script), it runs the file.
 *   - It waits until nothing but the stdio pipes is keeping the process busy.
 *     That is exactly when plain Node would exit, and it does not wait for
 *     main() to settle: a receiver that failed to bind (port taken) leaves a
 *     promise pending forever with nothing left to run, and plain Node exits
 *     there. So does this.
 *   - It flushes stdout and stderr, and exits with main()'s code if it
 *     settled, else process.exitCode.
 */

const path = require('node:path');

const [entry, ...argv] = process.argv.slice(2);
process.argv = [process.argv[0], entry, ...argv];

/** Handles that are this process's own plumbing, not work in progress. */
const PLUMBING = new Set(['PipeWrap', 'TTYWrap']);
const POLL_MS = 50;

/**
 * How long a still-running command must sit with nothing alive before it is
 * taken to be finished. A send can pass through an instant with no handle
 * open (between one association closing and the next opening), and a single
 * idle reading there cut a run off before its report. Real "nothing left to
 * do" (a receiver whose port was taken) stays idle indefinitely.
 */
const PENDING_IDLE_MS = 2000;

/** True when the only thing left alive is the stdio plumbing. */
function isIdle() {
  // Called from inside this file's own timer callback, so exactly one
  // Timeout in the list is that timer.
  const busy = process.getActiveResourcesInfo().filter((r) => !PLUMBING.has(r));
  return busy.length - (busy.includes('Timeout') ? 1 : 0) <= 0;
}

/**
 * Resolves once the process has been continuously idle for `holdMs()`
 * milliseconds. The hold is re-read on every check so it can drop to zero
 * the moment main() settles.
 *
 * @param {() => number} holdMs
 */
function idleFor(holdMs) {
  return new Promise((resolve) => {
    let since = null;
    const check = () => {
      if (!isIdle()) since = null;
      else if (since === null) since = Date.now();
      if (since !== null && Date.now() - since >= holdMs()) resolve();
      else setTimeout(check, POLL_MS);
    };
    setTimeout(check, POLL_MS);
  });
}

/** Resolves once everything already written to `stream` has been handed off. */
function drained(stream) {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

async function run() {
  let code;
  let settled = false;
  if (path.basename(entry) === 'dcm.js' && path.basename(path.dirname(entry)) === 'bin') {
    const { main } = require(path.join(path.dirname(entry), '..', 'src', 'cli'));
    Promise.resolve()
      .then(() => main(argv))
      .then(
        (c) => {
          code = c;
        },
        (err) => {
          process.stderr.write(`${err?.stack ?? String(err)}\n`);
          code = 1;
        }
      )
      .finally(() => {
        settled = true;
      });
  } else {
    // A plain script has no promise to settle, so it is always "pending".
    require(path.resolve(entry));
  }
  await idleFor(() => (settled ? 0 : PENDING_IDLE_MS));
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code ?? process.exitCode ?? 0);
}

run();
