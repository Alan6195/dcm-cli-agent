'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cli = require('../../src/cli');

/**
 * Commands are required lazily so that startup stays fast and an unused
 * command's dependencies are never loaded. The cost of that is real: a syntax
 * error, a bad import or a missing export inside a command file surfaces only
 * when somebody actually runs that command, and the rest of the suite passes
 * happily meanwhile.
 *
 * A stray backtick inside a template literal in one command's help text got all
 * the way to a manual run once. These tests load every command so that cannot
 * happen again.
 */

const COMMAND_DIR = path.join(__dirname, '..', '..', 'src', 'commands');

/** Command names as advertised in the top-level usage text. */
function advertisedCommands() {
  const section = cli.USAGE.split('Commands:')[1].split('Global options:')[0];
  return section
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => /^[a-z]+$/.test(name));
}

test('every command file loads and exposes run()', () => {
  const files = fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8, `expected the command directory to be populated, saw ${files.length}`);

  for (const file of files) {
    const modulePath = path.join(COMMAND_DIR, file);
    let mod;
    assert.doesNotThrow(() => {
      mod = require(modulePath);
    }, `${file} failed to load`);

    assert.equal(typeof mod.run, 'function', `${file} must export run()`);
    assert.equal(typeof mod.USAGE, 'string', `${file} must export USAGE`);
    assert.ok(mod.USAGE.trim().length > 0, `${file} USAGE must not be empty`);
  }
});

test('every advertised command actually resolves', () => {
  // A command listed in the help text but not wired into the dispatch table
  // is a promise the tool does not keep.
  for (const name of advertisedCommands()) {
    const argv = [name, '--help'];
    assert.doesNotThrow(() => {
      const file = path.join(COMMAND_DIR, `${name}.js`);
      // uninstall is an alias onto install's second export.
      if (name === 'uninstall') {
        const mod = require(path.join(COMMAND_DIR, 'install.js'));
        assert.equal(typeof mod.uninstall, 'function');
        return;
      }
      assert.ok(fs.existsSync(file), `${name} is advertised but ${file} does not exist`);
      require(file);
    }, `advertised command "${name}" (${argv.join(' ')}) does not resolve`);
  }
});

test('each command help mentions its own name', () => {
  // Catches a help text copied from another command and not updated.
  const files = fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const name = path.basename(file, '.js');
    const mod = require(path.join(COMMAND_DIR, file));
    assert.match(
      mod.USAGE,
      new RegExp(`dcm ${name}\\b`),
      `${file} help text should describe "dcm ${name}"`
    );
  }
});

test('exit codes are the documented three', () => {
  assert.equal(cli.EXIT.OK, 0);
  assert.equal(cli.EXIT.FAILED, 1);
  assert.equal(cli.EXIT.USAGE, 2);
});

test('the usage text lists every command in the dispatch table', () => {
  // The reverse of the check above: a command that exists but is undocumented
  // is one nobody will find.
  const advertised = new Set(advertisedCommands());
  const files = fs
    .readdirSync(COMMAND_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.basename(f, '.js'));

  for (const name of files) {
    assert.ok(advertised.has(name), `"${name}" is implemented but not listed in the usage text`);
  }
});
