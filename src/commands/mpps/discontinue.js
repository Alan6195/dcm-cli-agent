'use strict';

const mpps = require('../../lib/mpps');
const { finish, usageFor } = require('./finish');

const USAGE = usageFor('discontinue');

/**
 * N-SET the step to DISCONTINUED.
 *
 * DISCONTINUED is not a failure of this tool; it is the honest terminal status
 * for work that started and did not finish, and it is what `dcm mpps perform`
 * sets when any instance is unaccounted for. A step left IN PROGRESS forever is
 * worse for the receiving system than one explicitly discontinued.
 *
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
function run(parsed) {
  return finish(parsed, { verb: 'discontinue', status: mpps.Status.DISCONTINUED });
}

module.exports = { run, USAGE };
