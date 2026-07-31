#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => {
    // Let stdout drain before exiting, otherwise piped output can be truncated
    // on Windows when the parent closes the pipe early.
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`${err?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
