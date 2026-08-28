'use strict';

const dcmjs = require('dcmjs');

/**
 * Folds dcmjs's per-instance parse chatter into one honest summary line.
 *
 * The problem this exists for is not cosmetic. dcmjs reports two conditions
 * once per occurrence, and both occur on every instance of a study that
 * carries private tags — which is to say, on essentially every real scanner
 * export:
 *
 *   dcmjs.js:12393  log.warn("Unknown name in dataset", name, ":", dataset[name])
 *   dcmjs.js:~9947  validationLog.error("Invalid vr type", type, "- using OW")
 *
 * The first is the expensive one, because it passes the tag *value* as a
 * console argument. Each line is not a line: it is an inspected object graph
 * of ArrayBuffers. A 1600-instance CT sent over 16 concurrent associations
 * produces that unbounded, and the volume alone is enough to wedge a consumer
 * that has to render it.
 *
 * Neither message is actionable. Together they mean one thing: "this dataset
 * contains private tags dcmjs has no dictionary entry for." That is normal for
 * clinical data and it is worth knowing once, not sixty thousand times. So the
 * two messages are counted and withheld, and the count is stated at the end of
 * the run.
 *
 *
 * WHY THIS IS AN ALLOWLIST AND NOT A LEVEL CHANGE
 *
 * The obvious fix — dcmjs.log.setLevel('silent') — is wrong, and the reason
 * matters. These same two loggers also carry warnings that report a real
 * modification to the data, notably:
 *
 *   log.warn(`Truncating value ${value} of ${naturalName} because it is
 *             longer than ${maxLength}`)
 *
 * That one says the tool changed what it was given. Silencing the logger would
 * make a run that quietly truncated a value look identical to one that did
 * not, which is exactly the failure mode this project's reporting is built to
 * prevent. So only the two known-benign messages are matched and withheld;
 * every other thing either logger says passes through untouched, at whatever
 * level dcmjs set it. Suppression here is a allowlist of two, not a mute
 * button, and it cannot grow silently as dcmjs adds messages.
 *
 *
 * WHY THE LOGLEVEL methodFactory AND NOT A CONSOLE PATCH
 *
 * Patching console.warn/console.error does nothing. loglevel binds the real
 * console methods into each logger at construction time, so by the time dcmjs
 * has been required the binding is already taken and a later console patch
 * never sees these calls. loglevel's own documented extension point is
 * `methodFactory`, which is what is replaced here and restored on the way out.
 *
 * `validationLog` is a *separate* logger instance — `log.getLogger(
 * "validation.dcmjs")` at dcmjs.js:376 — so setting a level or a factory on
 * the root logger does not reach it. It is reachable, though: loglevel
 * memoises named loggers, so `dcmjs.log.getLogger('validation.dcmjs')` returns
 * that identical instance, and `dcmjs.log.getLoggers()` enumerates every named
 * logger dcmjs has made. Both are supported public API, so no monkey-patching
 * of dcmjs internals is needed. The root logger is patched as well, because
 * loglevel hands the root's factory to any logger created later — which means
 * a future dcmjs logger is covered without this module knowing its name.
 */

/**
 * The messages this module is allowed to withhold, matched on dcmjs's own
 * literal first argument. Anything not listed here is passed through.
 */
const UNKNOWN_NAME = 'Unknown name in dataset';
const INVALID_VR = 'Invalid vr type';

/**
 * The two VR strings that are not actually invalid.
 *
 * "ox" and "xs" are the DICOM standard's own notation for a VR that depends on
 * context — OB-or-OW, US-or-SS — and they are entries in dcmjs's own VR table.
 * PixelData's dictionary VR is literally "ox". So dcmjs logs an *error* every
 * time it resolves its own dictionary exactly right, which is once per instance
 * on every study ever parsed, private tags or not.
 *
 * That makes them the bulk of the flood and, at the same time, the one part of
 * it that says nothing about the data. They are still counted and still shown
 * in full under --verbose, but they do not earn a clause in the summary and
 * they never on their own cause a line to be printed — otherwise every clean
 * run in the tool's history would end with a footnote about its own pixel data.
 *
 * Any *other* VR string reaching that message is different in kind: it means
 * dcmjs did not recognise the VR at all and fell back to UN, which is a real
 * observation about the dataset and is reported.
 */
const AMBIGUOUS_VR = new Set(['ox', 'xs']);

/** The logger names dcmjs is known to construct, patched explicitly. */
function targetLoggers() {
  const root = dcmjs?.log;
  if (!root || typeof root.methodFactory !== 'function' || typeof root.rebuild !== 'function') {
    return [];
  }

  const loggers = [root];
  // getLoggers() returns loglevel's memoised named loggers — validation.dcmjs
  // and AsyncDicomReader today, whatever dcmjs adds tomorrow.
  const named = typeof root.getLoggers === 'function' ? root.getLoggers() : {};
  for (const logger of Object.values(named ?? {})) {
    if (logger && typeof logger.rebuild === 'function') loggers.push(logger);
  }
  return loggers;
}

/**
 * Counts the withheld messages, and works out how many datasets they came from.
 *
 * The dataset count is the number an operator actually cares about ("how much
 * of my study is like this"), and it has to be derived, because dcmjs reports
 * per tag and says nothing about where one dataset ends and the next begins.
 * Two independent boundaries are used, and a new dataset is started when
 * either fires:
 *
 *   - A tag key repeats. denaturalizeDataset() walks each key of one dataset
 *     exactly once, so a key cannot recur within a dataset; seeing it again
 *     means the next dataset has started. This is the reliable one for the
 *     case that matters, where every instance of a series carries the same
 *     private group.
 *
 *   - A new synchronous turn begins. denaturalizeDataset() never yields, so
 *     everything from one dataset arrives in a single turn.
 *
 * Both boundaries can only ever split a group, never merge two. That direction
 * is deliberate: an over-count says the study was messier than it was, which is
 * a harmless kind of wrong, whereas an under-count would make the run look
 * cleaner than it was, which is the one thing the reporting here may not do.
 */
class NoiseCounter {
  constructor() {
    this.withheld = 0;
    this.unknownTags = new Set();
    this.invalidVrTypes = new Set();
    this.datasets = 0;
    this._groupKeys = new Set();
    this._turnOpen = false;
  }

  /** @param {string} key The tag name or number dcmjs could not resolve. */
  noteUnknownTag(key) {
    this.withheld += 1;
    this.unknownTags.add(key);

    if (!this._turnOpen || this._groupKeys.has(key)) {
      this.datasets += 1;
      this._groupKeys.clear();
    }
    this._groupKeys.add(key);

    if (!this._turnOpen) {
      this._turnOpen = true;
      // Closes the group at the end of this synchronous turn. queueMicrotask
      // rather than setImmediate: it drains before any I/O, so the next file's
      // parse cannot be folded into this dataset's group.
      queueMicrotask(() => {
        this._turnOpen = false;
      });
    }
  }

  /** @param {string} type The VR string dcmjs could not resolve. */
  noteInvalidVr(type) {
    this.withheld += 1;
    this.invalidVrTypes.add(type);
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Renders the one line the operator sees, or null when there was nothing to
 * say. Nothing withheld means no line at all — a clean study must not grow a
 * "0 suppressed" footnote.
 *
 * @param {NoiseCounter} counter
 * @param {boolean} passedThrough True when the raw output was let through, so
 *   the line describes what was shown rather than what was hidden.
 * @returns {string|null}
 */
function summarise(counter, passedThrough) {
  if (counter.withheld === 0) return null;

  const clauses = [];
  if (counter.unknownTags.size) {
    clauses.push(
      `${plural(counter.datasets, 'dataset')} carried ` +
        `${plural(counter.unknownTags.size, 'tag')} dcmjs has no dictionary entry for`
    );
  }

  // Only the genuinely unrecognised ones. See AMBIGUOUS_VR.
  const unrecognised = [...counter.invalidVrTypes].filter((t) => !AMBIGUOUS_VR.has(t)).sort();
  if (unrecognised.length) {
    clauses.push(
      `${plural(unrecognised.length, 'VR type')} went unrecognised, ` +
        `read as UN (${unrecognised.join(', ')})`
    );
  }

  // Nothing notable happened — what was withheld was dcmjs narrating its own
  // context-dependent VR table. A run that found nothing to say says nothing.
  if (clauses.length === 0) return null;

  const tail = passedThrough
    ? `${plural(counter.withheld, 'message')} above`
    : `${plural(counter.withheld, 'message')} withheld; re-run with --verbose to see them`;

  // Named as dcmjs's observation, not this tool's, because that is whose
  // dictionary is incomplete. Private tags are normal; nothing was dropped and
  // nothing failed, and the wording must not imply either.
  return `dcmjs: ${clauses.join('; ')} — ${tail}`;
}

/**
 * Installs the filter. Idempotent per handle; call restore() to undo.
 *
 * @param {{passThrough?: boolean}} opts
 *   passThrough leaves the raw messages visible while still counting them. It
 *   is what --verbose passes, and the reasoning is that --verbose in this tool
 *   means nothing is filtered out (it is already why process.noDeprecation is
 *   lifted there). Someone staring at a dataset that is genuinely malformed,
 *   rather than merely private, needs the tag names and values these messages
 *   carry; that is the only place they exist. The count is identical either
 *   way, so the summary line does not change meaning between the two runs.
 * @returns {{restore: function, summary: function, stats: function}}
 */
function install(opts = {}) {
  const passThrough = opts.passThrough === true;
  const counter = new NoiseCounter();
  const loggers = targetLoggers();
  const saved = [];

  for (const logger of loggers) {
    const originalFactory = logger.methodFactory;
    saved.push({ logger, originalFactory });

    logger.methodFactory = function filteringFactory(methodName, level, loggerName) {
      // The genuine emitter, built by whatever factory was in place before.
      // Everything not on the allowlist is handed straight to it, so dcmjs's
      // other messages keep their exact original behaviour and formatting.
      const emit = originalFactory.call(this, methodName, level, loggerName);

      return function filtered(...parts) {
        if (parts[0] === UNKNOWN_NAME) {
          counter.noteUnknownTag(String(parts[1]));
          if (!passThrough) return;
        } else if (parts[0] === INVALID_VR) {
          counter.noteInvalidVr(String(parts[1]));
          if (!passThrough) return;
        }
        return emit.apply(this, parts);
      };
    };

    // rebuild() re-installs the logging methods from the factory just set.
    // setLevel() would do it too, but it also tries to persist the level, and
    // rebuild() is the side-effect-free way in.
    logger.rebuild();
  }

  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      for (const { logger, originalFactory } of saved) {
        logger.methodFactory = originalFactory;
        logger.rebuild();
      }
    },
    summary: () => summarise(counter, passThrough),
    stats: () => ({
      withheld: counter.withheld,
      datasets: counter.datasets,
      unknownTags: [...counter.unknownTags],
      invalidVrTypes: [...counter.invalidVrTypes],
    }),
  };
}

module.exports = { install, UNKNOWN_NAME, INVALID_VR };
