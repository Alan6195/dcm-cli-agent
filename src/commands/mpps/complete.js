'use strict';

const mpps = require('../../lib/mpps');
const { finish, usageFor } = require('./finish');

const USAGE = usageFor('complete');

/**
 * N-SET the step to COMPLETED.
 *
 * COMPLETED is a claim that the work finished and that every image it produced
 * is accounted for, so `dcm mpps perform` only reaches this verb's status when
 * the whole transfer was acknowledged. Used standalone, the claim is only as
 * good as what --acknowledged or --series-from was given; see the USAGE note.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
function run(parsed) {
  return finish(parsed, { verb: 'complete', status: mpps.Status.COMPLETED });
}

module.exports = { run, USAGE };
