'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, resolve, validateAeTitle, validatePort, rejectUnknown, UsageError } = require('../../src/lib/args');

test('parses flags, values, positionals and key=value pairs', () => {
  const { flags, positionals, pairs } = tokenize([
    './study', '--host', 'pacs.example.org', '--port=11112',
    '--dry-run', 'PatientID=12345', 'StudyDate=20260101-20260131',
  ]);

  assert.equal(positionals[0], './study');
  assert.equal(flags.get('host'), 'pacs.example.org');
  assert.equal(flags.get('port'), '11112');
  assert.equal(flags.get('dry-run'), true, 'a flag with no value is boolean');
  assert.deepEqual(pairs, [
    ['PatientID', '12345'],
    ['StudyDate', '20260101-20260131'],
  ]);
});

test('key=value pairs survive parsing as data, not flags', () => {
  // C-FIND matching keys are given bare; mistaking them for flags would break
  // every query.
  const { pairs, flags } = tokenize(['PatientName=DOE^JANE']);
  assert.deepEqual(pairs, [['PatientName', 'DOE^JANE']]);
  assert.equal(flags.size, 0);
});

test('a boolean flag does not swallow a following matching key', () => {
  // `dcm find --study PatientID=12345` must keep the matching key. Consuming
  // it as the value of --study loses the key silently and asks the peer a
  // different question than the one that was typed.
  const { flags, pairs } = tokenize(['--study', 'PatientID=12345']);
  assert.equal(flags.get('study'), true);
  assert.deepEqual(pairs, [['PatientID', '12345']]);
});

test('but --set and --remove do take a Key=Value as their value', () => {
  // The mirror case: `dcm edit --set PatientID=TEST001` must consume the pair,
  // or the edit silently does nothing. These two requirements conflict, so the
  // flags that take pair-shaped values are named explicitly.
  const { flags, pairs } = tokenize([
    '--set', 'PatientID=TEST001',
    '--remove', 'InstitutionName',
    '--out', './edited',
  ]);
  assert.equal(flags.get('set'), 'PatientID=TEST001');
  assert.equal(flags.get('remove'), 'InstitutionName');
  assert.equal(flags.get('out'), './edited');
  assert.deepEqual(pairs, [], 'nothing should leak into positional pairs');
});

test('repeated --set accumulates rather than clobbering', () => {
  const { flags } = tokenize([
    '--set', 'PatientID=A',
    '--set', 'PatientName=DOE^JANE',
  ]);
  assert.deepEqual(flags.get('set'), ['PatientID=A', 'PatientName=DOE^JANE']);
});

test('a repeated flag is an error rather than a silent last-wins', () => {
  const { flags } = tokenize(['--calling-ae', 'A', '--calling-ae', 'B']);
  assert.throws(() => resolve(flags, { name: 'calling-ae' }), /more than once/);
});

test('resolution order is flag, then environment, then default', () => {
  const { flags } = tokenize(['--host', 'from-flag']);
  process.env.TEST_DCM_HOST = 'from-env';

  assert.equal(resolve(flags, { name: 'host', env: 'TEST_DCM_HOST' }), 'from-flag');
  assert.equal(
    resolve(new Map(), { name: 'host', env: 'TEST_DCM_HOST' }),
    'from-env'
  );
  assert.equal(
    resolve(new Map(), { name: 'host', env: 'TEST_DCM_UNSET', fallback: 'from-default' }),
    'from-default'
  );

  delete process.env.TEST_DCM_HOST;
});

test('a missing required option names the environment variable too', () => {
  assert.throws(
    () => resolve(new Map(), { name: 'host', env: 'DCM_HOST', required: true }),
    /Missing required option --host \(or set DCM_HOST\)/
  );
});

test('numeric options reject non-numbers', () => {
  const { flags } = tokenize(['--port', 'abc']);
  assert.throws(() => resolve(flags, { name: 'port', type: 'number' }), /expects a number/);
});

test('AE Titles are validated against the rules receivers enforce', () => {
  assert.equal(validateAeTitle('DCM-CLI', 'calling-ae'), 'DCM-CLI');
  assert.equal(validateAeTitle('a'.repeat(16), 'calling-ae').length, 16);

  // Over-length AE Titles get truncated or rejected by receivers, which looks
  // exactly like an allowlist problem — so catch it here with a clear message.
  assert.throws(() => validateAeTitle('a'.repeat(17), 'calling-ae'), /limited to 16/);
  assert.throws(() => validateAeTitle('', 'calling-ae'), /non-empty/);
  assert.throws(() => validateAeTitle('BAD\\AE', 'calling-ae'), /backslash/);
});

test('AE Titles are not silently upper-cased', () => {
  // Receivers are case-sensitive. Normalising here would cause exactly the
  // "registered but still rejected" confusion the tool exists to prevent.
  assert.equal(validateAeTitle('MixedCase', 'calling-ae'), 'MixedCase');
});

test('ports are bounds-checked', () => {
  assert.equal(validatePort(11112, 'port'), 11112);
  assert.throws(() => validatePort(0, 'port'), /between 1 and 65535/);
  assert.throws(() => validatePort(70000, 'port'), /between 1 and 65535/);
  assert.throws(() => validatePort(1.5, 'port'), /integer/);
});

test('an unknown flag fails loudly and suggests the intended one', () => {
  // A silently-ignored --dry-run typo would send data for real.
  const { flags } = tokenize(['--dryrun']);
  assert.throws(() => rejectUnknown(flags, ['dry-run', 'host']), /Unknown option/);
  assert.throws(() => rejectUnknown(flags, ['dry-run', 'host']), /Did you mean --dry-run\?/);
});

test('global flags are always accepted', () => {
  const { flags } = tokenize(['--verbose', '--json', '--help']);
  assert.doesNotThrow(() => rejectUnknown(flags, ['host']));
});

test('a hex-tag matching key is not swallowed by the flag in front of it', () => {
  // `dcm web query --series 00100020=12345` must ask about PatientID, not
  // hand the key to --series. The keyword spelling was already guarded; the
  // 8-hex-digit spelling of the same key has to be too.
  const { flags, pairs } = tokenize(['--series', '00100020=12345']);
  assert.equal(flags.get('series'), true, '--series must stay a bare switch');
  assert.deepEqual(pairs, [['00100020', '12345']]);
});

test('a base64 token keeps its padding instead of looking like a matching key', () => {
  // Padding makes `abc123==` pair-shaped by accident; without --require-token
  // being declared pair-valued the hub refuses to start.
  const { flags } = tokenize(['--require-token', 'abc123==']);
  assert.equal(flags.get('require-token'), 'abc123==');
});
