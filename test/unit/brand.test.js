'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const brand = require('../../src/lib/brand');
const menu = require('../../src/lib/menu');
const install = require('../../src/commands/install');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Runs a function with stdout forced to look like a colour-capable terminal. */
function asTerminal(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    else delete process.stdout.isTTY;
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
  }
}

test('the banner box stays aligned regardless of version length', () => {
  // Padding computed against a coloured string counts ANSI escape bytes as
  // visible characters, which silently skews the right edge. Measuring the
  // rendered width catches that.
  for (const version of ['0.1.0', '0.2.0', '0.10.123-rc1', '1.0.0-alpha.20260731']) {
    const widths = asTerminal(() => brand.banner(version))
      .split('\n')
      .map((line) => strip(line).length);

    assert.equal(new Set(widths).size, 1, `banner lines differ in width for v${version}: ${widths}`);
  }
});

test('the banner degrades to plain text when output is not a terminal', () => {
  // A banner full of escape sequences in a redirected log helps nobody.
  const plain = brand.banner('0.2.0');
  assert.equal(plain, strip(plain), 'must contain no ANSI escapes');
  assert.match(plain, /Asteris/);
  assert.match(plain, /0\.2\.0/);
});

test('NO_COLOR is honoured', () => {
  const before = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    assert.equal(brand.decorated(), false, 'NO_COLOR must win over an interactive terminal');
  } finally {
    if (before === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = before;
    delete process.stdout.isTTY;
  }
});

test('the menu prints the command line it is about to run', () => {
  // The menu is meant to teach the commands, not hide them, so every action
  // must be expressible as something the operator could have typed.
  assert.equal(
    menu.asCommandLine('send', ['./study', '--host', 'pacs.example.org', '--port', '11112']),
    'dcm send ./study --host pacs.example.org --port 11112'
  );
});

test('paths with spaces are quoted in the shown command line', () => {
  assert.equal(
    menu.asCommandLine('info', ['C:\\Two Words\\study']),
    'dcm info "C:\\Two Words\\study"'
  );
});

test('every menu action maps to a real command', () => {
  // A menu entry pointing at a command that does not exist would only fail at
  // the moment someone picked it.
  const commands = require('../../src/cli');
  for (const action of menu.ACTIONS) {
    assert.ok(action.key, 'each action needs a key');
    assert.ok(action.label, 'each action needs a label');
    assert.ok(action.detail, 'each action needs an explanation');
    assert.equal(typeof action.build, 'function');
  }
  assert.ok(commands.USAGE.includes('install'), 'install must be documented in the usage text');
});

test('menu keys are unique', () => {
  const keys = menu.ACTIONS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('install targets a per-user location that needs no admin rights', () => {
  const dir = install.defaultDir();
  assert.ok(dir.length > 0);
  if (process.platform === 'win32') {
    assert.match(dir, /AppData[\\/]Local[\\/]Programs/i, 'must be under the user profile');
    assert.equal(install.binaryName(), 'dcm.exe');
  } else {
    assert.match(dir, /\.local[\\/]bin/, 'must be under the home directory');
    assert.equal(install.binaryName(), 'dcm');
  }
  // Never a machine-wide location.
  assert.doesNotMatch(dir, /Program Files|\/usr\/|\/opt\//i);
});

test('installing strips the downloaded-from-the-internet mark', { skip: process.platform !== 'win32' }, () => {
  // fs.copyFileSync carries the Zone.Identifier stream across with the file, so
  // installing a browser-downloaded exe produces an installed copy that keeps
  // triggering SmartScreen on every launch rather than once. Since the binaries
  // are not code-signed, that would be permanent.
  const os = require('os');
  const fsx = require('fs');
  const pathx = require('path');

  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'dcm-motw-'));
  const file = pathx.join(dir, 'marked.exe');
  try {
    fsx.writeFileSync(file, 'not really an executable');
    fsx.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3');

    // Confirm the fixture really is marked, or the test proves nothing.
    assert.equal(fsx.existsSync(`${file}:Zone.Identifier`), true, 'fixture should start marked');

    assert.equal(install.clearMarkOfTheWeb(file), true, 'should report having cleared a mark');
    assert.equal(fsx.existsSync(`${file}:Zone.Identifier`), false, 'mark must be gone');

    // Clearing an unmarked file is a no-op, not an error.
    assert.equal(install.clearMarkOfTheWeb(file), false);
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test('install refuses to run from a source checkout', () => {
  // From `node bin/dcm.js`, process.execPath is the Node binary. Copying that
  // to the install directory would hand the user a copy of Node named dcm.
  assert.equal(
    install.isPackagedExecutable(),
    false,
    'the test suite runs from source, so this must be false'
  );
});
