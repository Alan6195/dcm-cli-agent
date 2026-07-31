'use strict';

/**
 * Entry point for the bundled single executable.
 *
 * Kept separate from bin/dcm.js so the bundler has one unambiguous root, and
 * so the published npm package and the standalone binary can differ in how
 * they boot without either having to care about the other.
 */

const { main } = require('./cli');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`${err?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
