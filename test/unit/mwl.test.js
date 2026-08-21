'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dcmjsDimse = require('dcmjs-dimse');

const find = require('../../src/commands/find');
const vr = require('../../src/lib/vr');
const mpps = require('../../src/lib/mpps');
const worklist = require('../../src/lib/worklist');
const { tokenize, UsageError } = require('../../src/lib/args');
const { startScp, runCommand, withTempDir } = require('../helpers/harness');

/** The identifier `dcm find` would build for the given argv. */
function identifierFor(argv, level = 'mwl') {
  const { flags, pairs } = tokenize(argv);
  const identifier = find.buildIdentifier(level, pairs);
  find.applyInjections(identifier, find.parseInjections(flags));
  return identifier;
}

/**
 * Modality Worklist query shape.
 *
 * The single most common way an MWL query fails is being built flat. Modality,
 * the scheduled station and the scheduled start date/time are not top-level
 * attributes — they live inside ScheduledProcedureStepSequence (0040,0100). A
 * lenient SCP answers a flat query anyway; a conformant one returns nothing,
 * which reads as "the worklist is empty" rather than "your query was wrong".
 * These tests pin the correct shape so that cannot regress.
 */

test('a worklist query nests scheduled-step keys in the sequence', () => {
  const id = find.buildIdentifier('mwl', []);
  const sps = id.ScheduledProcedureStepSequence;

  assert.ok(Array.isArray(sps), 'ScheduledProcedureStepSequence must be a sequence');
  assert.equal(sps.length, 1, 'one item, used as the matching template');

  for (const key of ['Modality', 'ScheduledStationAETitle', 'ScheduledProcedureStepStartDate']) {
    assert.ok(key in sps[0], `${key} must be requested inside the sequence`);
    assert.equal(sps[0][key], '', 'requested but not matched on when no value is given');
    assert.ok(!(key in id), `${key} must NOT be a top-level attribute`);
  }
});

test('scheduled-step matching keys are routed into the sequence', () => {
  const id = find.buildIdentifier('mwl', [
    ['Modality', 'CT'],
    ['ScheduledProcedureStepStartDate', '20260819'],
  ]);

  assert.equal(id.ScheduledProcedureStepSequence[0].Modality, 'CT');
  assert.equal(id.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate, '20260819');
  assert.ok(!('Modality' in id), 'must not also be sent flat');
});

test('patient-level matching keys stay at the top level', () => {
  const id = find.buildIdentifier('mwl', [['PatientID', '12345'], ['AccessionNumber', 'ACC1']]);

  assert.equal(id.PatientID, '12345');
  assert.equal(id.AccessionNumber, 'ACC1');
  assert.ok(!('PatientID' in id.ScheduledProcedureStepSequence[0]));
});

test('other query levels are unaffected by the worklist handling', () => {
  const study = find.buildIdentifier('study', [['PatientID', '12345']]);
  assert.equal(study.PatientID, '12345');
  assert.ok(!('ScheduledProcedureStepSequence' in study));
});

test('worklist results are flattened for reading', () => {
  const flat = find.flattenWorklistMatch({
    PatientID: '12345',
    ScheduledProcedureStepSequence: [
      { Modality: 'CT', ScheduledStationAETitle: 'CT01', ScheduledProcedureStepStartTime: '0930' },
    ],
  });

  assert.equal(flat.Modality, 'CT');
  assert.equal(flat.ScheduledStationAETitle, 'CT01');
  assert.equal(flat.PatientID, '12345', 'top-level values survive');
  assert.ok(!('ScheduledProcedureStepSequence' in flat), 'the sequence itself is not left behind');
});

test('flattening never overwrites a populated top-level value', () => {
  const flat = find.flattenWorklistMatch({
    Modality: 'MR',
    ScheduledProcedureStepSequence: [{ Modality: 'CT' }],
  });
  assert.equal(flat.Modality, 'MR');
});

test('extra scheduled steps are reported rather than dropped', () => {
  const flat = find.flattenWorklistMatch({
    ScheduledProcedureStepSequence: [{ Modality: 'CT' }, { Modality: 'MR' }],
  });
  assert.equal(flat.Modality, 'CT');
  assert.equal(flat.AdditionalScheduledSteps, '1');
});

test('a match with no sequence passes through untouched', () => {
  const input = { PatientID: '12345' };
  assert.deepEqual(find.flattenWorklistMatch(input), input);
});

// ---------------------------------------------------------------------------
// Deliberate injection (--set)
// ---------------------------------------------------------------------------

/**
 * `dcm find`'s flag list is closed and rejectUnknown-enforced, and a bare
 * key=value pair is placed into the identifier by rules that know about MWL.
 * That is right for everyday use and wrong for testing a peer, because the one
 * thing a conformance test needs to send is the value the client would
 * normally tidy up. --set is the explicit way to do that, so what these tests
 * pin is that it stays explicit: the value reaches the wire unaltered, and it
 * is impossible to use it without being told.
 */

test('--set binds its Key=Value token rather than letting it become a matching key', () => {
  // The tokenizer treats a bare Key=Value token as a matching key, so a flag
  // may only swallow one if it is named in PAIR_VALUED_FLAGS. 'set' is in that
  // set. Without this, --set PatientSex=male would leave --set as a boolean
  // and PatientSex=male as an ordinary matching key — a different query,
  // built quietly.
  const { flags, pairs } = tokenize(['--set', 'PatientSex=male']);

  assert.equal(flags.get('set'), 'PatientSex=male', '--set swallowed the pair');
  assert.deepEqual(pairs, [], 'and it did not also survive as a matching key');
});

test('--set reaches the identifier byte for byte', () => {
  const identifier = identifierFor([
    '--set', 'PatientSex=male',
    '--set', `RequestedProcedureDescription=${'X'.repeat(72)}`,
    '--set', 'PatientWeight=12.5 kg',
  ]);

  assert.equal(identifier.PatientSex, 'male', 'not upper-cased, not rejected');
  assert.equal(identifier.RequestedProcedureDescription, 'X'.repeat(72), 'not truncated to LO 64');
  assert.equal(identifier.PatientWeight, '12.5 kg', 'not parsed into a number');
});

test('--set is repeatable and takes a tag as well as a keyword', () => {
  const identifier = identifierFor(['--set', '(0010,0040)=male', '--set', '00101030=12.5 kg']);

  assert.equal(identifier.PatientSex, 'male');
  assert.equal(identifier.PatientWeight, '12.5 kg');
});

test('--set splits on the first = and leaves the rest of the value alone', () => {
  const identifier = identifierFor(['--set', 'RequestedProcedureDescription=a=b=c']);
  assert.equal(identifier.RequestedProcedureDescription, 'a=b=c');
});

test('--set can set an attribute to empty, which is a return key and not a match', () => {
  const identifier = identifierFor(['--set', 'PatientSex=']);
  assert.equal(identifier.PatientSex, '');
});

test('--set is applied last, so it overwrites a matching key naming the same attribute', () => {
  const identifier = identifierFor(['PatientID=12345', '--set', 'PatientID=OVERRIDDEN']);
  assert.equal(identifier.PatientID, 'OVERRIDDEN');
});

test('--set does not route a scheduled-step attribute into the sequence', () => {
  // A bare Modality=CT pair is placed inside ScheduledProcedureStepSequence
  // for you. --set deliberately does not do that: it puts the value where it
  // was named, because the point of the flag is the absence of helpfulness.
  const identifier = identifierFor(['--set', 'Modality=ct']);

  assert.equal(identifier.Modality, 'ct', 'at the top level, where it was asked for');
  assert.equal(
    identifier.ScheduledProcedureStepSequence[0].Modality, '',
    'and not moved into the sequence'
  );
});

test('--set reaches into a sequence when the path names one', () => {
  const identifier = identifierFor(['--set', 'ScheduledProcedureStepSequence/Modality=ct']);

  assert.equal(identifier.ScheduledProcedureStepSequence[0].Modality, 'ct');
  assert.ok(!('Modality' in identifier), 'and not also at the top level');
});

test('--set creates the sequence item when the level does not already build one', () => {
  const identifier = identifierFor(['--set', 'ScheduledProcedureStepSequence/Modality=ct'], 'study');
  assert.equal(identifier.ScheduledProcedureStepSequence[0].Modality, 'ct');
});

test('--set refuses a target it cannot name, rather than dropping it', () => {
  // The encoder discards an attribute it has no dictionary entry for and says
  // nothing, so a query that silently lost the one key it was testing would
  // look like a peer that ignored it.
  assert.throws(() => identifierFor(['--set', 'NotADicomKeyword=1']), UsageError);
  assert.throws(() => identifierFor(['--set', '(0009,0010)=ACME']), UsageError);
  assert.throws(() => identifierFor(['--set', 'PatientSex']), UsageError);
  assert.throws(() => identifierFor(['--set', '=male']), UsageError);
});

test('--set refuses a path element that is not a sequence', () => {
  assert.throws(
    () => identifierFor(['--set', 'PatientID/Modality=ct']),
    (err) => err instanceof UsageError && /cannot contain/.test(err.message)
  );
});

test('--set with no value at all is a usage error, not a boolean flag', () => {
  const { flags } = tokenize(['--set', '--mwl']);
  assert.throws(() => find.parseInjections(flags), UsageError);
});

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

test('the banner names every injected attribute and its value', () => {
  // The capability is indistinguishable from a bug in this tool if it is ever
  // used without being announced: a query carrying a deliberately malformed
  // value looks exactly like a query this tool built wrong.
  const { flags } = tokenize([
    '--set', 'PatientSex=male',
    '--set', 'ScheduledProcedureStepSequence/Modality=ct',
  ]);
  const banner = find.injectionBanner(find.parseInjections(flags));

  assert.match(banner, /--set is stamping 2 attributes/);
  assert.match(banner, /\(0010,0040\) PatientSex = "male"/);
  assert.match(banner, /\(0008,0060\) ScheduledProcedureStepSequence\/Modality = "ct"/);
  assert.match(banner, /Nothing about these values was checked/);
});

test('the banner is singular for one attribute', () => {
  const { flags } = tokenize(['--set', 'PatientSex=male']);
  assert.match(find.injectionBanner(find.parseInjections(flags)), /stamping 1 attribute into/);
});

// ---------------------------------------------------------------------------
// A value the encoder will not carry
// ---------------------------------------------------------------------------

/** Builds the request `dcm find` would send, without sending it. */
function requestFor(argv) {
  const { flags, pairs } = tokenize(argv);
  const injections = find.parseInjections(flags);
  const identifier = find.buildIdentifier('mwl', pairs);
  find.applyInjections(identifier, injections);
  return {
    injections,
    request: dcmjsDimse.requests.CFindRequest.createWorklistFindRequest(identifier),
  };
}

test('an injected value the encoder would shorten stops the query', () => {
  // The dataset writer enforces the VR maximum and shortens a longer value
  // without failing, so this would otherwise go out as a legal 16-character AE
  // Title. The peer answers a conformant query, and a test written to prove
  // the peer rejects an over-long one passes without ever having asked.
  const { request, injections } = requestFor([
    '--set', 'ScheduledStationAETitle=SCHEDULEDSTATION0020',
  ]);

  assert.throws(
    () => find.verifyInjections(request, injections),
    (err) => err instanceof UsageError
      && /cannot send these values verbatim/.test(err.message)
      && /SCHEDULEDSTATION0020/.test(err.message)
      && /SCHEDULEDSTATION"/.test(err.message)
  );
});

test('an injected value the encoder does carry passes verification', () => {
  const { request, injections } = requestFor([
    '--set', 'PatientSex=male',
    '--set', 'PatientWeight=12.5 kg',
    '--set', `RequestedProcedureDescription=${'X'.repeat(72)}`,
    '--set', 'ScheduledProcedureStepSequence/Modality=ct',
  ]);

  assert.doesNotThrow(() => find.verifyInjections(request, injections));
});

// ---------------------------------------------------------------------------
// The whole thing, against the shipped receiver
// ---------------------------------------------------------------------------

/**
 * A worklist item holding the four violations NewLumen reproduced, every one
 * of which this tool used to repair before anybody could see it.
 */
const TORTURED_ITEM = {
  PatientName: 'DOE^JANE',
  PatientID: '12345',
  PatientSex: 'male',
  PatientWeight: '12.5 kg',
  AccessionNumber: 'A1',
  Modality: 'ct',
  ScheduledStationAETitle: 'CT01',
  ScheduledProcedureStepStartDate: '20260820',
  RequestedProcedureDescription: 'X'.repeat(72),
  StudyInstanceUID: '1.2.3',
};

/** Runs the real find command against the real receiver over one worklist. */
function againstReceiver(items, argv) {
  return withTempDir('dcm-mwl-raw', async (dir) => {
    const file = path.join(dir, 'worklist.json');
    fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');

    const receiver = await startScp({ ae: 'WORKLIST', worklist: worklist.loadWorklistFile(file) });
    try {
      return await runCommand(find, [
        '--host', '127.0.0.1', '--port', String(receiver.port),
        '--called-ae', 'WORKLIST', '--mwl', ...argv,
      ]);
    } finally {
      receiver.close();
    }
  });
}

/**
 * Pulls the single JSON document out of captured stdout.
 *
 * The harness captures process.stdout for the duration of a command and the
 * test runner flushes its own progress lines through the same stream, so the
 * buffer is not guaranteed to hold nothing but the command's output.
 */
function jsonFrom(stdout) {
  const start = stdout.indexOf('{\n  "level"');
  assert.notEqual(start, -1, `no JSON document in output:\n${stdout}`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return JSON.parse(stdout.slice(start, i + 1));
  }
  throw new Error(`unterminated JSON document in output:\n${stdout}`);
}

test('--json-raw carries the values the receiver actually sent', async () => {
  const { code, stdout } = await againstReceiver([TORTURED_ITEM], ['--json-raw']);
  assert.equal(code, 0);

  const [match] = jsonFrom(stdout).matches;

  // The reported failure: dcmjs reads this DS as 12.5 and the unit is gone.
  assert.equal(match.PatientWeight, '12.5 kg');
  assert.equal(typeof match.PatientWeight, 'string', 'never a parsed number');

  assert.equal(match.PatientSex, 'male', 'not repaired to M');
  assert.equal(match.Modality, 'ct', 'not upper-cased');
  assert.equal(match.RequestedProcedureDescription, 'X'.repeat(72), 'not truncated to LO 64');
  assert.deepEqual(match.PatientName, [{ Alphabetic: 'DOE^JANE' }], 'Person Names stay objects');
});

test('--json-raw carries a sidecar with the right VR and length for every element', async () => {
  const { stdout } = await againstReceiver([TORTURED_ITEM], ['--json-raw']);
  const [match] = jsonFrom(stdout).matches;

  assert.equal(match._elements['(0010,1030)'].vr, 'DS');
  assert.equal(match._elements['(0010,1030)'].value, '12.5 kg');
  assert.equal(match._elements['(0010,1030)'].length, 8, 'seven octets, padded to eight');

  assert.equal(match._elements['(0032,1060)'].vr, 'LO');
  assert.equal(match._elements['(0032,1060)'].length, 72);

  // Modality is lifted out of the Scheduled Procedure Step Sequence along with
  // the value and says so, so every flat key has an entry beside it.
  assert.equal(match._elements['(0008,0060)'].value, 'ct');
  assert.equal(match._elements['(0008,0060)'].from, 'ScheduledProcedureStepSequence');

  for (const key of Object.keys(match)) {
    if (key.startsWith('_')) continue;
    assert.ok(match._elements[vr.resolveAttribute(key).tag], `${key} has no sidecar entry`);
  }
});

test('the sidecar survives the reader that consumes this output', () => {
  // `dcm mpps --from-worklist` reads --json-raw and strips `_`-prefixed keys at
  // every level, which is the whole reason the sidecar is named that way. If
  // this ever stops being true the sidecar becomes a bogus attribute in an
  // outgoing N-CREATE, so it is pinned here rather than left to be discovered.
  const withSidecar = find.withSidecar({ PatientID: '12345' }, {
    ok: true,
    sidecar: { '(0010,0020)': { vr: 'LO', length: 6, keyword: 'PatientID', vm: 1, value: '12345' } },
  });

  assert.equal(withSidecar._elements['(0010,0020)'].vr, 'LO');
  assert.deepEqual(mpps.flattenWorklistItem(withSidecar), { PatientID: '12345' });
});

test('--check-vr names every violation and exits 1', async () => {
  const { code, stdout } = await againstReceiver([TORTURED_ITEM], ['--check-vr']);

  assert.equal(code, 1, 'a conformance failure is a failure');
  assert.match(stdout, /VR conformance: 4 violations/);
  assert.match(stdout, /\(0010,0040\) PatientSex.*is not one of M, F, O/);
  assert.match(stdout, /\(0010,1030\) PatientWeight.*not a valid DS value/);
  assert.match(stdout, /\(0032,1060\) RequestedProcedureDescription.*72 characters, LO permits 64/);
  assert.match(stdout, /\(0008,0060\) Modality.*contains lowercase/);
});

test('--check-vr says so plainly when there is nothing wrong, and exits 0', async () => {
  const clean = {
    ...TORTURED_ITEM,
    PatientSex: 'F',
    PatientWeight: '12.5',
    Modality: 'CT',
    RequestedProcedureDescription: 'CHEST',
  };
  const { code, stdout } = await againstReceiver([clean], ['--check-vr']);

  assert.equal(code, 0);
  assert.match(stdout, /VR conformance: no violations over \d+ elements returned/);
});

test('--check-vr puts the violations inside the single JSON document', async () => {
  const { code, stdout } = await againstReceiver([TORTURED_ITEM], ['--json', '--check-vr']);
  assert.equal(code, 1);

  const doc = jsonFrom(stdout);
  assert.equal(doc.vrViolations.length, 4);
  assert.ok(doc.vrElementsExamined > 0);
  assert.deepEqual(
    doc.vrViolations.map((v) => v.kind).sort(),
    ['cs-lowercase', 'cs-not-enumerated', 'numeric-invalid', 'over-length']
  );
  for (const violation of doc.vrViolations) {
    assert.equal(violation.match, 0, 'every violation says which match it came from');
  }
});

test('--check-vr is off unless it is asked for', async () => {
  const { code, stdout } = await againstReceiver([TORTURED_ITEM], []);

  assert.equal(code, 0, 'a query that returned a match succeeded');
  assert.doesNotMatch(stdout, /VR conformance/);
});

test('the banner appears on stderr whenever --set is used, and never otherwise', async () => {
  const injected = await againstReceiver([TORTURED_ITEM], ['--set', 'PatientSex=male', '--json']);

  assert.match(injected.stderr, /--set is stamping 1 attribute/);
  assert.match(injected.stderr, /\(0010,0040\) PatientSex = "male"/);
  assert.doesNotMatch(injected.stdout, /--set is stamping/, 'stdout stays one JSON document');
  assert.deepEqual(jsonFrom(injected.stdout).injected, [
    { tag: '(0010,0040)', attribute: 'PatientSex', value: 'male' },
  ]);

  const plain = await againstReceiver([TORTURED_ITEM], ['--json']);
  assert.doesNotMatch(plain.stderr, /--set is stamping/);
  assert.equal(jsonFrom(plain.stdout).injected, undefined);
});

test('an injected value arrives at the receiver exactly as typed', async () => {
  // The proof that --set reaches the wire and not merely the identifier
  // object: the receiver returns this item only if it matched on the lowercase
  // value that was injected into the scheduled step.
  const { code, stdout } = await againstReceiver(
    [TORTURED_ITEM],
    ['--set', 'ScheduledProcedureStepSequence/Modality=ct', '--json']
  );

  assert.equal(code, 0);
  assert.equal(jsonFrom(stdout).count, 1);
});

test('the injection is recorded in the table output too, where --quiet cannot hide it', async () => {
  // The stderr banner is level-gated, so --quiet would otherwise leave a query
  // carrying a deliberately malformed value looking like an ordinary one.
  const { stdout } = await againstReceiver([TORTURED_ITEM], ['--set', 'PatientSex=male']);
  assert.match(stdout, /--set stamped PatientSex="male" into this query verbatim/);
});
