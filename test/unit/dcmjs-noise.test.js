'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dcmjs = require('dcmjs');

const noise = require('../../src/lib/dcmjs-noise');

const { DicomMetaDictionary, ValueRepresentation } = dcmjs.data;

/**
 * What this file is defending.
 *
 * A real CT sent at --speed insane filled a console with tens of thousands of
 * dcmjs parse messages, wedged the renderer, and left the DICOM association
 * open behind it because nothing survived to tear the transfer down. The flood
 * is two dcmjs messages, each emitted once per occurrence and therefore at
 * least once per instance on any study ever parsed.
 *
 * The fix withholds those two messages and states the count once. So there are
 * two things to defend, and the second matters more than the first:
 *
 *   1. The flood is gone.
 *   2. Nothing else went with it. The count is accurate, dcmjs's other
 *      warnings still print, and the tool's own reporting is untouched.
 *
 * Every test here drives the genuine dcmjs call sites — denaturalizeDataset()
 * and createByTypeString() — rather than calling the logger directly, so a
 * dcmjs upgrade that changes the message wording fails these tests instead of
 * silently reopening the flood.
 */

/** The first emitter, at its real call site in dcmjs. */
function denaturalizeWithPrivateTags(instance) {
  // Private group 0x5180, the group in the CT behind the original report.
  // dcmjs has no dictionary entry for any of these, so denaturalizeDataset()
  // warns once per tag and passes the tag *value* to the logger with it —
  // which is why one "line" of this flood is an inspected object graph.
  return DicomMetaDictionary.denaturalizeDataset({
    SOPInstanceUID: `1.2.826.0.1.3680043.10.1337.${instance}`,
    51800010: { vr: 'LO', Value: ['ASTERIS CT PRIVATE'] },
    51800011: { vr: 'LO', Value: ['ASTERIS CT PRIVATE 2'] },
    51801001: { vr: 'DS', Value: ['1.5'] },
    _meta: {},
  });
}

/** The second, from the separate validation.dcmjs logger. */
function resolveVr(type) {
  return ValueRepresentation.createByTypeString(type);
}

/**
 * Captures what actually reaches the console.
 *
 * It has to be process.stderr.write and not console.warn. loglevel binds the
 * real console methods into each logger when the logger is constructed, which
 * for dcmjs is at require time, so a console patch installed afterwards never
 * sees these calls at all. That is the same reason the fix itself cannot be a
 * console patch, and asserting at this level is what proves the messages are
 * gone rather than merely redirected.
 */
function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

test('the flood is withheld at the source', () => {
  const handle = noise.install({});
  let output;
  try {
    output = captureStderr(() => {
      for (let i = 0; i < 50; i++) denaturalizeWithPrivateTags(i);
      for (let i = 0; i < 50; i++) resolveVr('ox');
    });
  } finally {
    handle.restore();
  }

  assert.equal(output, '', `expected no dcmjs output, saw:\n${output}`);
});

test('the same run without the filter really does flood', () => {
  // Without this, the test above would pass just as happily against a dcmjs
  // that had stopped logging, and the suite would go on reporting a fix that
  // is no longer doing anything.
  const output = captureStderr(() => {
    for (let i = 0; i < 10; i++) denaturalizeWithPrivateTags(i);
    resolveVr('ox');
  });

  const lines = output.split('\n').filter(Boolean);
  assert.ok(lines.length >= 31, `expected a flood, saw ${lines.length} line(s)`);
  assert.match(output, /Unknown name in dataset/);
  assert.match(output, /Invalid vr type/);
});

test('the count matches exactly what was withheld', () => {
  const handle = noise.install({});
  let filtered;
  try {
    filtered = captureStderr(() => {
      for (let i = 0; i < 20; i++) denaturalizeWithPrivateTags(i);
      for (let i = 0; i < 7; i++) resolveVr('ox');
      for (let i = 0; i < 3; i++) resolveVr('xs');
    });
  } finally {
    handle.restore();
  }

  // The identical work with the filter off, counted by line. This is the check
  // that the summary is honest: the number reported as withheld has to be the
  // number of messages that would otherwise have been printed.
  const flooded = captureStderr(() => {
    for (let i = 0; i < 20; i++) denaturalizeWithPrivateTags(i);
    for (let i = 0; i < 7; i++) resolveVr('ox');
    for (let i = 0; i < 3; i++) resolveVr('xs');
  });

  assert.equal(filtered, '');

  const stats = handle.stats();
  const floodedLines = flooded.split('\n').filter((l) => /Unknown name|Invalid vr type/.test(l));
  assert.equal(
    stats.withheld,
    floodedLines.length,
    'withheld count must equal the number of messages actually suppressed'
  );

  assert.equal(stats.datasets, 20);
  assert.deepEqual(stats.unknownTags.sort(), ['51800010', '51800011', '51801001']);
  assert.deepEqual(stats.invalidVrTypes.sort(), ['ox', 'xs']);
});

test('the summary names the distinct tags and datasets, not the message total alone', () => {
  const handle = noise.install({});
  try {
    captureStderr(() => {
      for (let i = 0; i < 12; i++) denaturalizeWithPrivateTags(i);
      resolveVr('ox');
    });
  } finally {
    handle.restore();
  }

  const summary = handle.summary();
  assert.match(summary, /^dcmjs: /);
  assert.match(summary, /12 datasets/);
  assert.match(summary, /3 tags/);
  assert.match(summary, /37 messages withheld/);
  assert.match(summary, /--verbose/);

  // "ox" is dcmjs resolving its own context-dependent VR table correctly. It is
  // counted and it is in the total, but it is not a finding about the study and
  // must not be dressed up as one.
  assert.ok(!summary.includes('UN'), 'ox must not be reported as an unrecognised VR');

  // One line. The whole point is that it cannot compete with the report.
  assert.ok(!summary.includes('\n'), 'the summary must be a single line');
});

test('a clean run says nothing at all', () => {
  const handle = noise.install({});
  try {
    captureStderr(() => {
      DicomMetaDictionary.denaturalizeDataset({ SOPInstanceUID: '1.2.3', _meta: {} });
    });
  } finally {
    handle.restore();
  }

  // A study with nothing to say about must not grow a "0 suppressed" footnote.
  assert.equal(handle.summary(), null);
  assert.equal(handle.stats().withheld, 0);
});

test('routine context-dependent VRs are withheld but never reported as a finding', () => {
  // PixelData's dictionary VR is literally "ox", so dcmjs logs an error every
  // time it reads its own table correctly — on every instance of every study
  // ever parsed. If that earned a summary line, every clean transfer the tool
  // has ever done would end with a footnote about its own pixel data.
  const handle = noise.install({});
  let output;
  try {
    output = captureStderr(() => {
      for (let i = 0; i < 200; i++) resolveVr('ox');
      for (let i = 0; i < 200; i++) resolveVr('xs');
    });
  } finally {
    handle.restore();
  }

  assert.equal(output, '', 'the flood is still withheld');
  assert.equal(handle.stats().withheld, 400, 'and still counted, so --verbose can show it');
  assert.equal(handle.summary(), null, 'but it is not a fact about the study');
});

test('a VR dcmjs genuinely does not recognise is reported', () => {
  // The other branch of the same dcmjs message: not an ambiguous VR resolved
  // correctly, but a VR string dcmjs has never heard of, read as UN. That is a
  // real observation about the dataset and it has to survive the filter.
  const handle = noise.install({});
  try {
    captureStderr(() => {
      resolveVr('ZZ');
      resolveVr('ox');
    });
  } finally {
    handle.restore();
  }

  const summary = handle.summary();
  assert.match(summary, /1 VR type went unrecognised, read as UN \(ZZ\)/);
  assert.ok(!summary.includes('ox'), 'the routine one must not be listed alongside it');
});

test('datasets are counted separately even within one synchronous turn', () => {
  // The turn boundary alone would fold these into one, because nothing yields
  // between them. The repeated-tag-key boundary is what keeps the count from
  // understating how much of the study was affected — the direction that would
  // make a run look cleaner than it was.
  const handle = noise.install({});
  try {
    captureStderr(() => {
      for (let i = 0; i < 8; i++) denaturalizeWithPrivateTags(i);
    });
  } finally {
    handle.restore();
  }

  assert.equal(handle.stats().datasets, 8);
});

test('dcmjs warnings that report a real modification still print', () => {
  // This is the line the fix must never swallow: it says dcmjs changed the
  // value it was given. A run that quietly truncated an attribute may not look
  // identical to one that did not, so the suppression is an allowlist of two
  // messages and everything else on these loggers goes straight through.
  const handle = noise.install({});
  let output;
  try {
    output = captureStderr(() => {
      dcmjs.log.warn('Truncating value ABC of PatientName because it is longer than 64');
      dcmjs.log.getLogger('validation.dcmjs').error('some other validation problem');
    });
  } finally {
    handle.restore();
  }

  assert.match(output, /Truncating value ABC of PatientName/);
  assert.match(output, /some other validation problem/);

  // And they are not quietly folded into the private-tag count either, which
  // would misreport what the summary line is describing.
  assert.equal(handle.stats().withheld, 0);
  assert.equal(handle.summary(), null);
});

test('--verbose lets the raw messages through and still counts them', () => {
  const handle = noise.install({ passThrough: true });
  let output;
  try {
    output = captureStderr(() => {
      for (let i = 0; i < 4; i++) denaturalizeWithPrivateTags(i);
    });
  } finally {
    handle.restore();
  }

  assert.match(output, /Unknown name in dataset/);
  assert.equal(output.split('\n').filter(Boolean).length, 12);

  // The accounting is identical either way; only the closing words change,
  // because the messages are above rather than withheld.
  assert.equal(handle.stats().withheld, 12);
  assert.equal(handle.stats().datasets, 4);
  assert.match(handle.summary(), /4 datasets/);
  assert.match(handle.summary(), /12 messages above/);
  assert.ok(!handle.summary().includes('--verbose'));
});

test('restore puts dcmjs back exactly as it was', () => {
  const before = captureStderr(() => denaturalizeWithPrivateTags(1));

  const handle = noise.install({});
  captureStderr(() => denaturalizeWithPrivateTags(1));
  handle.restore();

  const after = captureStderr(() => denaturalizeWithPrivateTags(1));

  // Byte-identical, so a later command in the same process — `dcm mcp` runs
  // many — gets the library it would have had if this had never been installed.
  assert.equal(after, before);
  assert.match(after, /Unknown name in dataset/);
});

test('restore is idempotent and a second install starts a fresh count', () => {
  const first = noise.install({});
  captureStderr(() => denaturalizeWithPrivateTags(1));
  first.restore();
  first.restore();
  assert.equal(first.stats().withheld, 3);

  const second = noise.install({});
  try {
    captureStderr(() => denaturalizeWithPrivateTags(2));
  } finally {
    second.restore();
  }

  // A running total across runs would misattribute one run's noise to another.
  assert.equal(second.stats().withheld, 3);
});

test('validationLog is reached through supported loglevel API', () => {
  // The messages come from two different logger instances: dcmjs.log and the
  // named logger dcmjs.log.getLogger('validation.dcmjs'). Setting anything on
  // the root does not reach the second one, so if loglevel ever stopped
  // memoising named loggers the fix would silently cover only half the flood.
  const root = dcmjs.log;
  assert.equal(typeof root.getLogger, 'function');
  assert.equal(typeof root.getLoggers, 'function');

  const validation = root.getLogger('validation.dcmjs');
  assert.notEqual(validation, root, 'validationLog must be a separate instance');
  assert.equal(
    validation,
    root.getLogger('validation.dcmjs'),
    'named loggers must be memoised, or the instance dcmjs holds is unreachable'
  );
  assert.ok(
    Object.keys(root.getLoggers()).includes('validation.dcmjs'),
    'getLoggers() must enumerate the validation logger'
  );
});
