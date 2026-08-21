'use strict';

/**
 * The test entry point, so the suite can set its own environment.
 *
 * It exists for one reason: DCM_LINGER. Every DIMSE association pays a fixed
 * grace period between the last response and A-RELEASE-RQ — see the comment on
 * DEFAULT_TIMEOUTS.linger in src/lib/dimse.js for why that default is 1000 ms
 * and why lowering it for real peers would be trading the truthfulness of the
 * accounting for speed.
 *
 * None of that reasoning applies here. Every association this suite opens is to
 * a receiver on this machine, over loopback, where the in-flight window the
 * grace period protects is microseconds rather than the hundreds of
 * milliseconds a slow clinical link can impose. Paying a full second per
 * association bought nothing and cost minutes: measured over 24 associations
 * with 24 instances, the suite's own accounting came out 24/24 at every value
 * tried, while wall time went from 6.5 s to 1.5 s.
 *
 * That is not a micro-optimisation. The release workflow's macos-x64 runner —
 * x64 Node under Rosetta 2, the slowest of the four — failed the v0.13.1 build
 * on time, reporting `fail 0` with 78 tests cancelled, and a failed build there
 * means none of the four dcm binaries publish.
 *
 * Not zero, deliberately. Measured, linger 0 was SLOWER than 50 ms (7.1 s
 * against 1.5 s over the same work), so releasing the instant the last response
 * is dispatched provokes something worth staying away from. 50 ms is short
 * enough to be free and long enough to be outside that behaviour.
 *
 * An operator's own DCM_LINGER wins, so a developer can reproduce a timing
 * problem at the real default with DCM_LINGER=1000 npm test.
 */

const { spawn } = require('node:child_process');

/** Loopback is fast; this is generous for it and still ~20x below the default. */
const SUITE_LINGER_MS = '50';

const args = ['--test', 'test/unit/*.test.js', 'test/e2e/*.test.js', ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    // Never clobber an explicit choice: reproducing a timing bug means being
    // able to ask for the real default.
    DCM_LINGER: process.env.DCM_LINGER ?? SUITE_LINGER_MS,
  },
});

child.on('exit', (code, signal) => {
  // Preserve the runner's own verdict exactly; CI reads this.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
