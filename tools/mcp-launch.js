#!/usr/bin/env node
'use strict';

/**
 * What .mcp.json starts: `dcm mcp` from this checkout, installing its
 * dependencies first if the clone has none yet. That is what lets someone
 * clone the repo, open it in Claude Code and have the DICOM tools work, with
 * no install step and no `dcm` binary on PATH.
 *
 * Runs the source, not a release binary, so the tools are always the code in
 * this checkout, including anything uncommitted.
 */

const path = require('node:path');
const { ensureDeps, requireNode } = require('./ensure-deps');

requireNode();
const ROOT = path.resolve(__dirname, '..');
ensureDeps(ROOT, 'the dcm MCP server').then(() => {
  process.argv = [process.argv[0], path.join(ROOT, 'bin', 'dcm.js'), 'mcp'];
  require('../bin/dcm.js');
});
