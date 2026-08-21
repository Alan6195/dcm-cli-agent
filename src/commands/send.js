'use strict';

const path = require('path');

const log = require('../lib/log');
const args = require('../lib/args');
const statusLib = require('../lib/status');
const codecs = require('../lib/codecs');
const { scan, chunk } = require('../lib/scan');
const { rewrittenSeriesUid } = require('../lib/uid');
const { TransferLedger, Disposition } = require('../lib/ledger');
const { runAssociation, resolveTimeouts, dcmjsDimse } = require('../lib/dimse');
const { formatOutcome } = require('../lib/reject');
const { report } = require('../lib/report');

const { Dataset, Transcoding } = dcmjsDimse;
const { TransferSyntax } = dcmjsDimse.constants;
const { CStoreRequest } = dcmjsDimse.requests;

const FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae', 'chunk', 'dry-run', 'recurse',
  'retry', 'timeout', 'connect-timeout', 'association-timeout',
  'rewrite-series-uid', 'no-recurse', 'transfer-syntax', 'label', 'parallel',
  'speed',
];

/**
 * The speed presets, in concurrent associations.
 *
 * The names are the tool owner's. They are what people will type and say to
 * each other, so they are kept verbatim rather than renamed to something more
 * descriptive.
 */
const SPEED_PRESETS = Object.freeze({
  'normal': 1,
  'fast': 4,
  'very-fast': 8,
  'insane': 16,
});

/** Chunk size the tool has always used when nothing else decides one. */
const DEFAULT_CHUNK = 200;

/**
 * The smallest chunk a preset will derive. Per-association setup — TCP connect,
 * association negotiation, and the release grace at the end — is fixed cost
 * that a 10-instance association cannot amortise, so a hundred tiny
 * associations is its own kind of slow, and it is the receiver that pays for
 * most of it.
 */
const MIN_CHUNK_PER_ASSOCIATION = 25;

/** Chunks aimed at per worker. See deriveChunkSize for why it is not one. */
const CHUNKS_PER_WORKER = 2;

/**
 * Ceiling on the chunk size when instances have to be parsed before they are
 * sent — rewriting a UID or transcoding. Those paths hold whole datasets,
 * pixel data included, in memory for the length of an association, so a size
 * chosen for streaming from disk is far too large.
 */
const MEMORY_CHUNK_CAP = 50;

/**
 * Transfer syntaxes that can be asked for by name.
 *
 * The UIDs are what actually goes on the wire, but nobody remembers them and a
 * typo in one is a silent negotiation failure. Names are accepted alongside.
 */
const TRANSFER_SYNTAX_ALIASES = Object.freeze({
  'implicit': TransferSyntax.ImplicitVRLittleEndian,
  'implicit-vr-le': TransferSyntax.ImplicitVRLittleEndian,
  'explicit': TransferSyntax.ExplicitVRLittleEndian,
  'explicit-vr-le': TransferSyntax.ExplicitVRLittleEndian,
  'deflated': TransferSyntax.DeflatedExplicitVRLittleEndian,
  'rle': TransferSyntax.RleLossless,
  'jpeg-lossless': TransferSyntax.JpegLossless,
  'jpeg-baseline': TransferSyntax.JpegBaseline,
  'jpeg-ls': TransferSyntax.JpegLsLossless,
  'jpeg-ls-lossy': TransferSyntax.JpegLsLossy,
  'jpeg2000': TransferSyntax.Jpeg2000Lossless,
  'jpeg2000-lossy': TransferSyntax.Jpeg2000Lossy,
});

/** Human label for a transfer syntax UID, for reports. */
const TRANSFER_SYNTAX_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(TransferSyntax).map(([name, uid]) => [uid, name]))
);

/**
 * Resolves --transfer-syntax to a UID.
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function resolveTransferSyntax(value) {
  if (!value) return undefined;
  const key = String(value).trim();
  if (/^[0-9.]+$/.test(key)) return key;
  const uid = TRANSFER_SYNTAX_ALIASES[key.toLowerCase()];
  if (!uid) {
    const known = Object.keys(TRANSFER_SYNTAX_ALIASES).join(', ');
    throw new args.UsageError(
      `--transfer-syntax "${value}" is not a name I know. Use a UID, or one of: ${known}.`
    );
  }
  return uid;
}

/**
 * Resolves --speed to a preset name.
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function resolveSpeedName(value) {
  if (value === undefined) return undefined;
  // 'very fast' and 'very_fast' are the same thing typed differently; nobody
  // gains from a usage error over a space.
  const key = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!Object.prototype.hasOwnProperty.call(SPEED_PRESETS, key)) {
    throw new args.UsageError(
      `--speed "${value}" is not a preset I know. Choose one of: ` +
        `${Object.keys(SPEED_PRESETS).join(', ')}.`
    );
  }
  return key;
}

/**
 * Chunk size that can actually deliver `parallel` concurrent associations.
 *
 * The arithmetic, because this is the part that is easy to get wrong:
 *
 *   chunks  = ceil(instances / chunk)
 *   workers = min(parallel, chunks)   <- what actually runs
 *
 * so a chunk size chosen without reference to the study silently caps the
 * parallelism. At the old fixed default of 200, a 2508-instance study splits
 * into 13 chunks and --parallel 16 runs 13 wide; a 400-instance study splits
 * into 2, so --parallel 4 runs 2 wide and whoever reads the throughput number
 * believes they measured 4. A preset that set only the parallelism would
 * inherit that trap, which is why it sets both.
 *
 * Aim for two chunks per worker rather than one:
 *
 *   chunk = floor(instances / (parallel * 2))
 *
 * One chunk per worker leaves every worker's tail exposed — the run finishes
 * when its slowest single chunk does, and chunks are not equal because
 * instances are not equal sizes. Two gives the pool something to hand a worker
 * that finishes early, for the cost of one extra association setup per worker.
 *
 * Then clamp to [25, 200]: below 25 an association is mostly setup and release
 * (see MIN_CHUNK_PER_ASSOCIATION), and above 200 is past the size the tool has
 * always used, where memory during a retry starts to matter.
 *
 * Worked, at the sizes this was built for:
 *
 *   2508 at 16 -> floor(2508/32) = 78  -> 33 chunks, ~2 per worker, 16 wide
 *   2508 at  8 -> floor(2508/16) = 156 -> 17 chunks, ~2 per worker,  8 wide
 *    400 at 16 -> floor(400/32)  = 12  -> clamped up to 25 -> 16 chunks, 16 wide
 *    100 at  4 -> floor(100/8)   = 12  -> clamped up to 25 ->  4 chunks,  4 wide
 *    100 at 16 -> clamped up to 25     ->  4 chunks, so 4 wide, not 16
 *
 * That last line is the honest limit rather than a bug: 100 instances cannot
 * fill 16 associations without dropping to 6 instances each, which would cost
 * more in setup than it wins in concurrency. The shortfall is warned about
 * (see planStudy) instead of being papered over.
 *
 * @param {number} instances
 * @param {number} parallel
 * @returns {number}
 */
function deriveChunkSize(instances, parallel) {
  // A single worker cannot be starved of chunks, so there is nothing to derive:
  // keep the size every run used before presets existed.
  if (parallel <= 1) return DEFAULT_CHUNK;

  const raw = Math.floor(instances / (parallel * CHUNKS_PER_WORKER));
  return Math.max(MIN_CHUNK_PER_ASSOCIATION, Math.min(DEFAULT_CHUNK, raw));
}

/**
 * Resolves --speed, --parallel and --chunk into the plan the run will use.
 *
 * An explicit --parallel or --chunk always beats the preset — someone who
 * typed a number meant it — but never silently: overriding half a preset is
 * exactly how you end up measuring something other than what you configured,
 * so each override comes back as a warning for the caller to print. The
 * warning is only worth printing when the two values actually differ; typing
 * the number the preset would have picked displaces nothing, and a sentence
 * that says "--parallel 1 wins, not the preset's 1" reads as a bug.
 *
 * A preset does NOT resolve a chunk size here, because there is no single
 * chunk size to resolve: see chunkSizeForStudy. `chunkSize` comes back null in
 * that case, which is the honest answer to "what size is this run using" when
 * the answer depends on the study. An explicit --chunk is run-wide and stays a
 * number.
 *
 * @param {object} params
 * @param {string|undefined} params.speed
 * @param {number} params.parallel          --parallel, or its default.
 * @param {number} params.chunkSize         --chunk, or its default.
 * @param {boolean} params.explicitParallel --parallel was typed.
 * @param {boolean} params.explicitChunk    --chunk was typed.
 * @returns {{speed: string|undefined, parallel: number, parallelSource: string,
 *            chunkSize: number|null, chunkSource: string, chunkCap: number,
 *            warnings: string[]}}
 */
function resolveSpeedPlan(params) {
  const { speed, parallel, chunkSize, explicitParallel, explicitChunk } = params;
  const preset = speed === undefined ? undefined : SPEED_PRESETS[speed];
  const warnings = [];

  let resolvedParallel = parallel;
  let parallelSource = explicitParallel ? 'flag' : 'default';

  if (preset !== undefined) {
    if (explicitParallel) {
      if (parallel !== preset) {
        warnings.push(
          `--parallel ${parallel} was given alongside --speed ${speed}; --parallel wins, so this ` +
            `run opens ${parallel} concurrent association(s), not the preset's ${preset}.`
        );
      }
    } else {
      resolvedParallel = preset;
      parallelSource = 'speed';
    }
  }

  let resolvedChunk = chunkSize;
  let chunkSource = explicitChunk ? 'flag' : 'default';

  if (speed !== undefined) {
    if (explicitChunk) {
      warnings.push(
        `--chunk ${chunkSize} was given alongside --speed ${speed}; --chunk wins, so the preset ` +
          `does not get to size associations for ${resolvedParallel}-wide sending.` +
          // At one association a shortfall is arithmetically impossible —
          // min(1, chunks) is 1 for any chunk count — so asking someone to
          // check for one is asking them to check nothing.
          (resolvedParallel > 1
            ? ` Check the association count below actually reaches ${resolvedParallel}.`
            : '')
      );
    } else {
      // No number here. The size is a per-study question and is answered per
      // study; see chunkSizeForStudy.
      resolvedChunk = null;
      chunkSource = 'speed';
    }
  }

  return {
    speed,
    parallel: resolvedParallel,
    parallelSource,
    chunkSize: resolvedChunk,
    chunkSource,
    // A ceiling the run may lower later (see the memory cap in run()). Not a
    // chosen size: it only ever reduces one.
    chunkCap: Infinity,
    warnings,
  };
}

/**
 * The chunk size one study will actually be split with.
 *
 * Chunking and the worker pool are both per study — `chunk(entries, size)` and
 * the pool that drains it are inside the study loop — so the size that makes a
 * preset true is a per-study question. Resolving it once for the run meant the
 * smallest study in the folder chose the size for every other one, and because
 * a small study pins the derivation at the 25-instance floor, one 30-instance
 * study alongside a 20000-instance one took the big study from 100 associations
 * to 800. That is 700 extra connect / negotiate / release cycles, most of the
 * cost of them paid by the receiver — spent on behalf of a study that the
 * smaller size bought almost nothing: 30 instances is one association at 200
 * and two at 25, still nowhere near the four that were asked for. Deriving per
 * study deletes that: each study gets the size that fills the requested width
 * on its own terms, and no study pays for another's shape.
 *
 * An explicit --chunk is a different kind of thing — someone typed one number
 * for the run — so it applies to every study unchanged.
 *
 * @param {object} plan       From resolveSpeedPlan.
 * @param {number} instances  Instances in this study.
 * @returns {number}
 */
function chunkSizeForStudy(plan, instances) {
  const size = plan.chunkSize === null
    ? deriveChunkSize(instances, plan.parallel)
    : plan.chunkSize;

  // The memory cap is a ceiling on any size this run may use, not a size that
  // was chosen, so it applies to a derived size exactly as it does to the
  // default. Splitting further never costs parallelism.
  return Math.min(size, plan.chunkCap ?? Infinity);
}

/**
 * What one study's transfer will actually look like, and whether that is what
 * was asked for.
 *
 * The shortfall this reports is the whole reason --speed exists: actual
 * concurrency is min(parallel, chunks), so a study that does not split into
 * enough chunks runs narrower than requested and says nothing about it. It is
 * checked here for every run, however the parallelism was arrived at — preset
 * or a bare --parallel — because the trap does not care which flag you used.
 *
 * @param {object} params
 * @param {number} params.instances
 * @param {number} params.chunkSize
 * @param {number} params.parallel
 * @param {number} [params.chunkCount] The real chunk count, when the caller has
 *   already split the study; defaults to the arithmetic.
 * @returns {{chunks: number, workers: number, summary: string, warning: string|undefined}}
 */
function planStudy({ instances, chunkSize, parallel, chunkCount }) {
  const chunks = chunkCount === undefined ? Math.ceil(instances / chunkSize) : chunkCount;
  const workers = Math.min(parallel, chunks);

  const summary =
    `${instances} instance(s) in ${chunks} association(s) of up to ${chunkSize}, ` +
    `${workers} at a time`;

  const warning = workers < parallel
    ? `${parallel} concurrent association(s) were requested but this study splits into only ` +
      `${chunks} chunk(s) of ${chunkSize}, so it will run ${workers} wide, not ${parallel} — ` +
      `any throughput figure from this run is for ${workers}. Lower --chunk to split it further, ` +
      `or send more instances at once.`
    : undefined;

  return { chunks, workers, summary, warning };
}

/**
 * The resolved plan, for --json.
 *
 * Separate from the rest of the envelope so that what a run resolved to is one
 * object with one shape, whether it was read by a person or by whatever is
 * comparing two benchmark runs.
 *
 * Two of these fields are easy to read as more than they are, so they are
 * defined here rather than left to inference:
 *
 *   parallelAchieved is MEASURED, and it is a floor. It is the smallest number
 *   of simultaneously accepted associations any single study reached — see
 *   runParallelAchieved. A single scalar for a multi-study run has to pick a
 *   direction, and the only direction that cannot flatter the run is downwards,
 *   because the throughput figure beside it covers the whole run and not just
 *   its widest study. Per-study numbers are in `studies`; use those for
 *   anything finer.
 *
 *   chunkSize is null whenever a preset derived it, because it is then a
 *   per-study number and no single value is true of the run. It is a number
 *   only when one number really did apply to everything — an explicit --chunk,
 *   or the plain default with no preset. The per-study sizes are in `studies`.
 *
 * @param {object} plan             From resolveSpeedPlan.
 * @param {number} parallelAchieved Measured floor across studies.
 * @param {object[]} [studies]      Per-study record; see run().
 */
function planJson(plan, parallelAchieved, studies = []) {
  return {
    speed: plan.speed ?? null,
    parallel: plan.parallel,
    parallelSource: plan.parallelSource,
    parallelAchieved,
    chunkSize: plan.chunkSize,
    chunkSource: plan.chunkSource,
    studies,
  };
}

/**
 * Reduces the per-study records to the one number that can sit beside a
 * run-level throughput figure.
 *
 * A minimum, seeded from the requested width so the first study lowers it
 * rather than raising it from zero. `max` was the original mistake here: a run
 * with one wide study and six narrow ones claimed the full width for the whole
 * transfer, which is precisely the misattribution --speed exists to end. The
 * throughput figure covers every study, so the width printed next to it has to
 * be one no part of the run fell below.
 *
 * A fold rather than Math.min(...spread): the element count is the number of
 * studies in the folder, and a spread of that many arguments throws
 * RangeError past roughly 125k arguments — on a migration tree, after the
 * whole scan has already been paid for.
 *
 * @param {object[]} studies  Per-study records; see run().
 * @param {number} parallel   Requested width, and the seed.
 * @returns {number}
 */
function runParallelAchieved(studies, parallel) {
  let achieved = parallel;
  for (const study of studies) {
    if (study.peakAssociations < achieved) achieved = study.peakAssociations;
  }
  return achieved;
}

const USAGE = `
dcm send — send a folder of DICOM files to a peer (C-STORE)

Walks a folder tree, groups what it finds by Study and Series Instance UID, and
sends each study in chunks. Reports three separate numbers per study: files
found on disk, files sent, and instances the peer acknowledged. Any shortfall
between them is a failure and exits non-zero.

Usage:
  dcm send <folder> --host <host> --port <port> --called-ae <AE> [options]

Options:
  --host <host>           Peer hostname. Prefer a hostname over an IP address.  [env DCM_HOST]
  --port <port>           Peer DIMSE port.                                      [env DCM_PORT]
  --called-ae <AE>        The peer's AE Title.                                  [env DCM_CALLED_AE]
  --calling-ae <AE>       Our AE Title. Must be registered on the peer.         [env DCM_CALLING_AE]
                          Default: DCM-CLI
  --chunk <n>             Instances per association. Default: 200.
                          Large studies are split across several associations so
                          that memory stays flat regardless of study size. One
                          number for the whole run: it overrides the per-study
                          size a --speed preset would derive.
  --retry <n>             Retry attempts for a chunk where fewer instances were
                          acknowledged than sent. Default: 1.
  --dry-run               Scan and report what would be sent. Opens no connection.
  --no-recurse            Only look at files directly in the folder.
  --timeout <ms>          Silence allowed before giving up. Default: 60000.
  --transfer-syntax <ts>  Convert each instance to this transfer syntax before
                          sending it, by name or UID. Names: implicit, explicit,
                          deflated, rle, jpeg-lossless, jpeg-baseline, jpeg-ls,
                          jpeg2000, jpeg2000-lossy. This is a real conversion,
                          not just a proposal — the bytes on the wire are in the
                          syntax you asked for. Needs the codecs module for
                          compressed syntaxes, and holds datasets in memory, so
                          the chunk size is reduced automatically.
  --parallel <n>          Run n associations at once (1-16, default 1). C-STORE is
                          sequential inside one association, so this is the only
                          real way to go faster. Check what the receiver allows:
                          exceeding its limit gets associations rejected rather
                          than speeding anything up.
  --speed <preset>        normal, fast, very-fast or insane. Picks the parallelism
                          AND a chunk size that can actually deliver it — see
                          "Speed presets" below. An explicit --parallel or --chunk
                          always wins over the preset, and says so when it does.
  --label <text>          Tag this run in --json output, for comparing runs.
  --json                  Emit the result and timing as JSON.
  --rewrite-series-uid    Replace each Series Instance UID with a deterministic
                          2.25.<hash> value. MODIFIES DATA — see below.
  --verbose               Log the full association negotiation.

--rewrite-series-uid:
  Some source systems emit the same Series Instance UID for genuinely different
  series, which makes receivers merge them into one stack. This option assigns
  each source series a new, deterministic UID derived from the study UID, the
  series UID and the SeriesNumber (or the containing folder when there is no
  SeriesNumber). That last input is what keeps genuinely different series which
  shipped with the same UID from being rewritten to a single new UID and staying
  merged, which would defeat the whole point. The same input always yields
  the same output, so a re-send maps onto the same series rather than creating a
  duplicate. It changes the data you send, and is off unless asked for.

Speed presets:
  --speed sets two things, because setting one of them alone does not work. The
  concurrency a run achieves is min(--parallel, number of chunks), and the
  number of chunks is ceil(instances / --chunk), so a preset that raised the
  parallelism without sizing the chunks would quietly run narrower than asked:
  2508 instances at --chunk 200 is 13 chunks, and 13 chunks cannot be sent 16
  at a time. Each preset therefore picks its parallelism and then derives a
  chunk size, aiming for about two chunks per worker so nobody sits idle at the
  tail. The derived size is held between 25 and 200 instances: under 25, an
  association costs more in setup and release than it carries.

  The size is derived PER STUDY, from that study's own instance count, because
  chunking and the worker pool are both per study. A folder holding a
  30-instance study and a 20000-instance one gives the first a chunk of 25 and
  the second a chunk of 200 — each the size that fills the requested width for
  that study. One size for the whole run would have meant the smallest study
  choosing for everybody, and since a small study pins the derivation at the
  floor, that took the 20000-instance study from 100 associations to 800 for no
  gain: a 30-instance study is one association at any size the clamp permits.
  An explicit --chunk is the exception, and stays run-wide.

    normal      1 association.  The default, and ordinary clinical traffic. The
                                only setting that adds nothing to the receiver's
                                association count.
    fast        4 associations. A backlog or a migration, to a receiver you know
                                tolerates a handful at once.
    very-fast   8 associations. A bulk move you are watching, on a link with
                                enough bandwidth for the concurrency to pay.
    insane     16 associations. A benchmark setting for a receiver you own. Not
                                a default for production traffic, and not a
                                thing to point at someone else's archive.

  What parallelism buys, and what it costs someone else:
  C-STORE is sequential inside one association — the protocol has no way to
  interleave instances — so running several associations at once is the only
  real lever on throughput. The ceiling is not ours to set. The receiver decides
  how many associations it will accept, and going past that limit gets
  associations REJECTED. That does not surface as slowness, and usually not as
  failure either. A receiver at its limit answers A-ASSOCIATE-RJ with reason 2,
  'local limit exceeded', which is a TRANSIENT rejection: the chunk is retried,
  the retry lands in a slot that has since freed, and every instance ends up
  acknowledged. The run exits 0 having quietly done the work narrower than it
  was told to, and the only sign is the per-study width warning on stderr and
  parallelAchieved in --json. A shortfall and a non-zero exit are what a
  PERMANENT rejection gives you — the loud case, and the rarer one. Ask what the
  receiver allows before reaching past 'fast', and read the width, not just the
  exit code.

  The cost lands on the receiver and the link far more than on this machine.
  Sending is a socket and a few hundred bytes per queued request here; the
  receiver pays for every concurrent write, index update and lock, and the link
  carries the sum of all of them at once. A setting that is comfortable here can
  saturate a WAN or push an archive into its own queue limits.

  What the run reports, and exactly what it means:
  The per-study line names that study's chunk count and the width it will run
  at. --json carries speed, parallel, parallelAchieved, chunkSize, where each
  came from, and a per-study "studies" array. Two of those fields mean less
  than their names suggest, so read them as follows.

  parallelAchieved is measured, and it is a FLOOR, not an average and not a
  peak. It is the fewest simultaneously accepted associations any single study
  reached. It counts associations the receiver accepted, so a receiver at its
  concurrent-association limit — which rejects the extra ones rather than
  slowing down — pulls this number down instead of hiding behind the number
  that was requested. Two honest limits on it. Because workers open and release
  associations as they pick up chunks, a run whose tail drains early can
  measure one or two below the width it genuinely sustained; the error is
  always downward, never upward. And a single scalar cannot describe a
  multi-study run — one study that ran 2 wide pulls the whole run's figure to
  2, which is deliberate, because the throughput figure beside it covers the
  whole run. For anything finer, read "studies": per study it carries the
  instance count, the chunk size used, the chunk count, the workers dispatched
  and the peak associations actually accepted.

  chunkSize is null when a preset derived it, because the size is then
  per-study and no single number is true of the run. It is a number only when
  one really did apply everywhere: an explicit --chunk, or the plain default.

  If the requested concurrency cannot be reached, a warning on stderr names
  both numbers — before the transfer when the chunk arithmetic cannot fill the
  workers, and after it when the receiver accepted fewer associations than the
  arithmetic allowed.

Examples:
  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm send ./studies --host pacs.example.org --port 11112 --called-ae ARCHIVE --chunk 100 --retry 2
  dcm send ./ct --host pacs.example.org --port 11112 --called-ae ARCHIVE --speed fast
  dcm send ./ct --host bench.example.org --port 11112 --called-ae BENCH --speed insane --json
  dcm send ./study --dry-run --speed very-fast
`.trimStart();

/**
 * Statuses worth a second attempt. A receiver that is out of resources or hit
 * a transient internal error may well succeed a moment later; one that does not
 * support the SOP Class never will, and retrying it just wastes time and
 * muddies the report.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  if (status === undefined) return true; // never answered
  if (status >= 0xa700 && status <= 0xa7ff) return true; // out of resources
  if (status === 0x0110) return true; // processing failure
  return false;
}

/**
 * Builds a C-STORE request for one file.
 *
 * The normal path hands the library a file path rather than a parsed dataset.
 * That keeps the request lazy: a few hundred bytes per instance instead of the
 * whole image, which is what makes a multi-thousand-instance study possible on
 * a modest machine.
 *
 * The rewrite path has to parse the dataset in order to change it, so it costs
 * real memory. The chunk size is reduced to compensate.
 *
 * @param {object} entry     Ledger entry.
 * @param {object} meta      Scanner metadata for the file.
 * @param {{rewriteSeriesUid: boolean}} opts
 * @returns {object} A CStoreRequest.
 */
function buildRequest(entry, meta, opts) {
  // The fast path: nothing about the instance needs changing, so the file is
  // streamed straight from disk and its pixel data never enters memory.
  if (!opts.rewriteSeriesUid && !opts.transferSyntax) {
    return new CStoreRequest(entry.path);
  }

  let dataset = Dataset.fromFile(entry.path);
  if (!dataset) throw new Error('parser returned no dataset');

  // Convert before it goes out, rather than only proposing the syntax and
  // letting the peer decide. Asking for a syntax and actually sending it are
  // different things: a peer that also accepts the original will usually just
  // take the original, so proposing alone is not a conversion.
  if (opts.transferSyntax) {
    const source = dataset.getTransferSyntaxUid();
    if (source !== opts.transferSyntax) {
      dataset = Transcoding.transcodeDataset(dataset, opts.transferSyntax);
      entry.transcodedFrom = source;
    }
    entry.transferSyntax = dataset.getTransferSyntaxUid();
  }

  if (!opts.rewriteSeriesUid) {
    return new CStoreRequest(dataset);
  }

  const sourceSeries = dataset.getElement('SeriesInstanceUID');
  const studyUid = dataset.getElement('StudyInstanceUID');
  if (!sourceSeries || !studyUid) {
    throw new Error('cannot rewrite Series Instance UID: study or series UID missing');
  }

  // Series Number is what still distinguishes two series that share a UID.
  // Without it in the key, colliding series would be rewritten to a single new
  // UID and stay merged. When it is absent, fall back to the containing folder,
  // which is how most exports separate series on disk.
  const discriminator =
    dataset.getElement('SeriesNumber') ?? path.basename(path.dirname(entry.path));

  const replacement = rewrittenSeriesUid(studyUid, sourceSeries, discriminator);
  dataset.setElement('SeriesInstanceUID', replacement);
  entry.rewrittenSeriesUid = replacement;

  return new CStoreRequest(dataset);
}

/*
 * A note on why the conversion above is the whole mechanism, and why the
 * request is deliberately left alone afterwards.
 *
 * It is tempting to also call setAdditionalTransferSyntaxes() with the target.
 * That backfires. The library builds one presentation context offering
 * [Implicit, Explicit, ...additional], and a receiver that takes the first
 * entry then picks Implicit — so the dataset is transcoded straight back and
 * nothing was gained. Leaving the request alone means the dataset's (now
 * converted) syntax is not in that context, so the library proposes a second
 * context offering only the converted syntax. A peer that accepts it receives
 * exactly what was asked for; a peer that refuses it falls back to the
 * uncompressed context, which the report then shows as the negotiated syntax.
 */


/**
 * Derives the throughput figures a speed comparison needs.
 *
 * Two different byte counts matter and conflating them is misleading. Bytes on
 * disk is how much study you moved; bytes on the wire is what the network
 * actually carried, which is far smaller for a compressed syntax. Throughput is
 * reported against bytes on disk, because that is the work done — otherwise
 * compressing looks slower for moving the same study.
 *
 * @param {object} result   Reconciled ledger result.
 * @param {object} metrics
 */
function summariseThroughput(result, metrics) {
  const seconds = Math.max(metrics.elapsedMs, 1) / 1000;
  const bytesOnDisk = metrics.bytesOnDisk || 0;
  const acknowledged = result.totals ? result.totals.acknowledged : 0;

  return {
    bytesOnDisk,
    negotiated: [...metrics.acceptedSyntaxes].map((uid) => ({
      uid,
      name: TRANSFER_SYNTAX_NAMES[uid] || uid,
    })),
    instancesPerSecond: Number((acknowledged / seconds).toFixed(2)),
    megabytesPerSecond: Number((bytesOnDisk / 1048576 / seconds).toFixed(2)),
    wireMegabytes: Number((metrics.bytesSent / 1048576).toFixed(2)),
  };
}

/** Prints the timing block under the transfer report. */
function reportThroughput(throughput, metrics, requestedSyntax) {
  const seconds = (metrics.elapsedMs / 1000).toFixed(2);
  log.out('');
  log.out(`elapsed           ${seconds}s`);
  log.out(`throughput        ${throughput.instancesPerSecond} instance/s · ${throughput.megabytesPerSecond} MB/s`);
  log.out(`sent on the wire  ${throughput.wireMegabytes} MB in ${metrics.associations} association(s)`);

  // Always printed, including at 1. A throughput number without the width it
  // was measured at is not comparable to anything, and the width that matters
  // is the one that ran, not the one that was asked for.
  const width = metrics.parallelAchieved === metrics.parallel
    ? `${metrics.parallel}`
    : `${metrics.parallelAchieved} of the ${metrics.parallel} requested`;
  log.out(
    `parallelism       ${width} concurrent association(s)` +
      (metrics.speed ? ` — --speed ${metrics.speed}` : '')
  );
  // On its own line rather than folded into the parallelism sentence, because
  // with a preset there is no single size: each study derives its own, and a
  // range with the reason for it is the only true thing to print.
  log.out(`chunk size        ${metrics.chunkRange} instance(s) per association${metrics.perStudy}`);

  if (requestedSyntax) {
    const name = TRANSFER_SYNTAX_NAMES[requestedSyntax] || requestedSyntax;
    log.out(`requested syntax  ${name}`);
  }
  if (throughput.negotiated.length) {
    log.out(`negotiated        ${throughput.negotiated.map((t) => t.name).join(', ')}`);
    if (requestedSyntax && !throughput.negotiated.some((t) => t.uid === requestedSyntax)) {
      log.out(log.color.yellow(
        '  the peer did not accept the requested syntax and fell back — the timing above is for what it did accept'
      ));
    }
  }
}

/**
 * Notes which transfer syntaxes the peer accepted for this association.
 *
 * @param {object} association
 * @param {{acceptedSyntaxes: Set<string>}} metrics
 */
function recordAcceptedSyntaxes(association, metrics) {
  try {
    for (const { context } of association.getPresentationContexts()) {
      const uid = context.getAcceptedTransferSyntaxUid();
      if (uid) metrics.acceptedSyntaxes.add(uid);
    }
  } catch {
    // Not every peer/stack populates this; it is reporting, not correctness.
  }
}

/**
 * Sends one chunk over one association.
 *
 * Every entry handed in leaves this function with a terminal disposition. That
 * is the whole point: an entry that reaches the end without one would be a file
 * that vanished, and reconciliation reports exactly that.
 *
 * @param {object} params
 * @returns {Promise<{outcome: object|undefined, dispatched: number}>}
 */
async function sendChunk(params) {
  const { entries, metaByPath, studyLedger, connection, timeouts, options, label } = params;

  const requests = [];
  const built = [];

  for (const entry of entries) {
    let request;
    try {
      request = buildRequest(entry, metaByPath.get(entry.path), options);
    } catch (err) {
      // Could not even construct the request. Counted here, not dropped.
      entry.settle(Disposition.READ_ERROR, { detail: err.message });
      continue;
    }

    // Per-request handler. Binding the handler to this specific entry avoids
    // matching responses back by SOP Instance UID, which would be ambiguous
    // whenever a tree contains the same instance twice.
    request.on('response', (response) => {
      const status = response.getStatus();
      const comment = response.getErrorComment();

      // Pending responses are not terminal; C-STORE should not emit them, but
      // a non-conformant peer might.
      const cls = statusLib.classify(status);
      if (cls === statusLib.Class.PENDING) return;

      if (entry.settled) {
        // A second terminal response for one request means the peer is not
        // behaving. Record it rather than crashing the transfer.
        log.debug(
          `duplicate response for ${path.basename(entry.path)} ` +
            `(already ${entry.disposition}, now ${statusLib.formatCode(status)})`
        );
        return;
      }

      if (cls === statusLib.Class.SUCCESS) {
        entry.settle(Disposition.ACKNOWLEDGED, { status });
      } else if (cls === statusLib.Class.WARNING) {
        entry.settle(Disposition.WARNING, { status, detail: comment });
      } else {
        entry.settle(Disposition.FAILED, { status, detail: comment });
      }
    });

    requests.push(request);
    built.push(entry);
  }

  if (requests.length === 0) {
    return { outcome: undefined, dispatched: 0 };
  }

  let accepted = false;
  const { outcome, statistics } = await runAssociation({
    host: connection.host,
    port: connection.port,
    callingAe: connection.callingAe,
    calledAe: connection.calledAe,
    requests,
    timeouts,
    onAccepted: (assoc) => {
      accepted = true;
      // Only now can these be called sent: before acceptance nothing went out.
      for (const entry of built) entry.dispatched = true;
      if (options && options.metrics) {
        // The high-water mark of associations the PEER accepted, which is the
        // only measurement of concurrency worth reporting. The worker count is
        // arithmetic — it is fixed before a socket is opened and says nothing
        // about what the receiver allowed. A receiver at its concurrent
        // association limit rejects the extras (A-ASSOCIATE-RJ), and with a
        // transient rejection the retry usually lands in a freed slot, so the
        // run can complete, exit 0, and report a width it never ran at unless
        // acceptance is what is counted.
        const m = options.metrics;
        m.liveAssociations += 1;
        if (m.liveAssociations > m.peakAssociations) m.peakAssociations = m.liveAssociations;
        // Record what the peer actually agreed to carry. Proposing a transfer
        // syntax and getting it are different things, and a speed comparison is
        // meaningless without knowing which one was really used.
        recordAcceptedSyntaxes(assoc, m);
      }
    },
  });

  // The slot is free the moment runAssociation resolves: the association has
  // been released, aborted or rejected by then, so nothing is holding it open.
  if (accepted && options && options.metrics) options.metrics.liveAssociations -= 1;

  // Bytes actually put on the wire, which is the number that matters when
  // comparing transfer syntaxes: a compressed one sends far fewer.
  if (options && options.metrics && statistics) {
    try {
      options.metrics.bytesSent += statistics.getBytesSent() || 0;
      options.metrics.bytesReceived += statistics.getBytesReceived() || 0;
    } catch {
      /* statistics are decorative; never fail a transfer over them */
    }
    options.metrics.associations += 1;
  }

  if (outcome && outcome.kind !== 'completed') {
    studyLedger.addEvent({
      kind: outcome.kind,
      message: `${label}: ${outcome.label} — ${outcome.headline}`,
      detail: outcome,
    });
  }

  // Close out anything the peer never spoke about. Whether the association was
  // accepted decides which of the two honest statements applies.
  const reason = outcome
    ? `${outcome.label} (${outcome.raw})`
    : 'association ended without a result';

  for (const entry of built) {
    if (entry.settled) continue;
    entry.settle(
      accepted ? Disposition.UNANSWERED : Disposition.NOT_ATTEMPTED,
      { detail: reason }
    );
  }

  return { outcome, dispatched: accepted ? built.length : 0 };
}

/**
 * Sends one chunk, retrying the instances that did not come back acknowledged.
 *
 * The retry exists for a specific failure: a receiver that accepts an
 * association, acknowledges part of the transfer, then goes quiet. Re-sending
 * only the outstanding instances usually completes them.
 *
 * @returns {Promise<void>}
 */
async function sendChunkWithRetry(params) {
  const { entries, retries, label } = params;

  let attempt = 0;
  let working = entries;

  for (;;) {
    const { outcome } = await sendChunk({ ...params, entries: working, label: `${label} attempt ${attempt + 1}` });

    const outstanding = working.filter(
      (e) => e.retryable && isRetryableStatus(e.status)
    );

    const acknowledged = working.length - outstanding.length;
    if (outstanding.length === 0) {
      return;
    }

    if (attempt >= retries) {
      if (retries > 0) {
        log.warn(
          `${label}: ${outstanding.length} instance(s) still outstanding after ` +
            `${attempt + 1} attempt(s); giving up on them`
        );
      }
      return;
    }

    // A permanently failed association will not improve on a second attempt.
    //
    // This deliberately only applies when the association itself failed. An
    // association that completed normally is marked non-retryable — there is
    // nothing to retry about the association — but the instances inside it can
    // still have been refused individually, and re-sending those is the entire
    // point of this retry. Treating "association completed" as "do not retry"
    // silently disables the retry in the exact case it exists for.
    if (outcome && outcome.kind !== 'completed' && outcome.retryable === false) {
      log.debug(`${label}: ${outcome.label} is not retryable, not attempting again`);
      return;
    }

    attempt += 1;
    log.warn(
      `${label}: ${acknowledged}/${working.length} acknowledged — ` +
        `retrying ${outstanding.length} instance(s) (attempt ${attempt + 1} of ${retries + 1})`
    );

    for (const entry of outstanding) entry.resetForRetry();
    working = outstanding;
  }
}

/**
 * @param {{flags: Map, positionals: string[]}} parsed
 * @returns {Promise<number>}
 */
async function run(parsed) {
  const { flags, positionals } = parsed;

  if (flags.has('help')) {
    log.out(USAGE);
    return 0;
  }

  args.rejectUnknown(flags, FLAGS);

  const target = positionals[0];
  if (!target) {
    throw new args.UsageError('Missing folder. Usage: dcm send <folder> --host ... --port ... --called-ae ...');
  }

  const dryRun = args.resolve(flags, { name: 'dry-run', type: 'boolean', fallback: false });
  const recurse = !flags.has('no-recurse');
  const chunkSizeRequested = args.resolve(flags, { name: 'chunk', type: 'number', fallback: 200 });
  const retries = args.resolve(flags, { name: 'retry', type: 'number', fallback: 1 });
  const rewriteSeriesUid = args.resolve(flags, {
    name: 'rewrite-series-uid', type: 'boolean', fallback: false,
  });
  const transferSyntax = resolveTransferSyntax(args.resolve(flags, { name: 'transfer-syntax' }));
  const speed = resolveSpeedName(args.resolve(flags, { name: 'speed' }));
  // Which of these were typed decides who wins over a preset, so it is read
  // before the values are defaulted and cannot be inferred from them after.
  const explicitParallel = flags.has('parallel');
  const explicitChunk = flags.has('chunk');
  const parallelRequested = args.resolve(flags, { name: 'parallel', type: 'number', fallback: 1 });
  if (!Number.isInteger(parallelRequested) || parallelRequested < 1 || parallelRequested > 16) {
    throw new args.UsageError(
      `--parallel must be between 1 and 16, got "${parallelRequested}". Most receivers cap ` +
        'concurrent associations well below that, and exceeding their limit gets ' +
        'associations rejected rather than making the transfer faster.'
    );
  }
  // A free-text label carried into --json output, so a run can be tied back to
  // whatever the caller was testing without the caller having to correlate.
  const label = args.resolve(flags, { name: 'label' });
  const asJson = flags.has('json');

  if (!Number.isInteger(chunkSizeRequested) || chunkSizeRequested < 1) {
    throw new args.UsageError(`--chunk must be a positive integer, got "${chunkSizeRequested}".`);
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new args.UsageError(`--retry must be zero or a positive integer, got "${retries}".`);
  }

  // The chunk size cannot be settled yet: a preset derives it from how many
  // instances the scan finds, so the plan is resolved below, after the scan.

  // Connection details are only required once we intend to connect.
  let connection;
  let timeouts;
  if (!dryRun) {
    const host = args.resolve(flags, { name: 'host', env: 'DCM_HOST', required: true });
    const port = args.validatePort(
      args.resolve(flags, { name: 'port', env: 'DCM_PORT', required: true, type: 'number' }),
      'port'
    );
    const calledAe = args.validateAeTitle(
      args.resolve(flags, { name: 'called-ae', env: 'DCM_CALLED_AE', required: true }),
      'called-ae'
    );
    const callingAe = args.validateAeTitle(
      args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
      'calling-ae'
    );
    connection = { host, port, calledAe, callingAe };
    timeouts = resolveTimeouts({
      timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
      connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
      associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
    });
  }

  // --- Scan ---
  log.info(`scanning ${path.resolve(target)}${recurse ? '' : ' (not recursing)'}`);
  const scanned = scan(target, {
    recurse,
    onProgress: (done, total) => log.debug(`examined ${done}/${total} files`),
  });

  if (scanned.ignored.length) {
    log.info(`ignored ${scanned.ignored.length} non-DICOM file(s)`);
    for (const item of scanned.ignored.slice(0, 20)) {
      log.debug(`  ignored ${item.path}: ${item.reason}`);
    }
  }

  // --- Register everything in the ledger, including what failed to parse ---
  const ledger = new TransferLedger();
  const metaByPath = new Map();

  for (const failure of scanned.readErrors) {
    ledger.addUnassignable(failure.path, failure.error);
  }

  for (const [studyUid, study] of scanned.studies) {
    const studyLedger = ledger.study(studyUid, {
      patientId: study.patientId,
      patientName: study.patientName,
      studyDate: study.studyDate,
      studyDescription: study.studyDescription,
      accessionNumber: study.accessionNumber,
      modalities: [...study.modalities],
      transferSyntaxes: [...study.transferSyntaxes],
      seriesCount: study.series.size,
      bytes: study.bytes,
    });

    for (const instance of study.instances) {
      metaByPath.set(instance.path, instance);
      studyLedger.addFile({
        path: instance.path,
        bytes: instance.bytes,
        sopInstanceUid: instance.sopInstanceUid,
        sopClassUid: instance.sopClassUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        transferSyntaxUid: instance.transferSyntaxUid,
      });
    }
  }

  const totalFound = scanned.candidates;
  if (totalFound === 0) {
    log.error(`No DICOM instances found under ${path.resolve(target)}.`);
    if (scanned.filesExamined > 0) {
      log.error(`Examined ${scanned.filesExamined} file(s); none were DICOM.`);
    }
    return 1;
  }

  log.info(
    `found ${totalFound} instance(s) in ${scanned.studies.size} stud${scanned.studies.size === 1 ? 'y' : 'ies'}` +
      (scanned.readErrors.length ? `, ${scanned.readErrors.length} unreadable` : '')
  );

  // --- Resolve the plan, now that the study sizes are known ---
  const instanceCounts = [...scanned.studies.values()].map((s) => s.instances.length);
  const plan = resolveSpeedPlan({
    speed,
    parallel: parallelRequested,
    chunkSize: chunkSizeRequested,
    explicitParallel,
    explicitChunk,
  });
  for (const warning of plan.warnings) log.warn(warning);

  const parallel = plan.parallel;

  // Both rewriting and transcoding have to hold parsed datasets — pixel data
  // included — in memory, so a chunk sized for streaming from disk is far too
  // large. Cap it unless a size was chosen explicitly. This only ever splits a
  // study into more chunks, so it cannot cost the run any parallelism. Applied
  // as a ceiling rather than a replacement, because with a preset there is no
  // single size to replace.
  if ((rewriteSeriesUid || transferSyntax) && !explicitChunk) {
    const before = instanceCounts.map((n) => chunkSizeForStudy(plan, n));
    plan.chunkCap = MEMORY_CHUNK_CAP;
    // 'memory' is only the true source if the cap actually bound something. A
    // preset that derived 25 for every study was not overruled by a cap of 50.
    if (before.some((size, i) => chunkSizeForStudy(plan, instanceCounts[i]) < size)) {
      plan.chunkSource = 'memory';
      if (plan.chunkSize !== null) plan.chunkSize = MEMORY_CHUNK_CAP;
    }
  }

  // The sizes every study will actually use. Computed once here so that the
  // header, the reports and the send loop cannot drift from each other.
  const chunkSizes = instanceCounts.map((n) => chunkSizeForStudy(plan, n));
  let chunkMin = chunkSizes.length ? chunkSizes[0] : chunkSizeForStudy(plan, 0);
  let chunkMax = chunkMin;
  for (const size of chunkSizes) {
    if (size < chunkMin) chunkMin = size;
    if (size > chunkMax) chunkMax = size;
  }
  const chunkUniform = chunkMin === chunkMax;
  // One number when one number is true of the whole run, a range otherwise.
  // Never a single number that only some of the studies will use.
  const chunkRange = chunkUniform ? `${chunkMax}` : `${chunkMin}–${chunkMax}`;
  const perStudy = chunkUniform ? '' : ', derived per study';

  log.info(
    `sending up to ${parallel} association(s) at a time, up to ${chunkRange} instance(s) each` +
      perStudy +
      (plan.parallelSource === 'speed' ? ` (--speed ${speed})` : '')
  );

  // --- Dry run stops here ---
  if (dryRun) {
    // Whether the requested width is reachable is a per-study question, and a
    // dry run is exactly where someone would want the answer — before the
    // benchmark rather than after reading a number that measured something
    // narrower than they configured.
    for (const [i, study] of [...scanned.studies.values()].entries()) {
      const studyPlan = planStudy({
        instances: study.instances.length,
        chunkSize: chunkSizes[i],
        parallel,
      });
      if (studyPlan.warning) log.warn(studyPlan.warning);
    }

    report.dryRun({
      scanned,
      // The same resolver the send loop uses, so a dry run cannot promise an
      // association count the real run will not produce.
      chunkSize: (instances) => chunkSizeForStudy(plan, instances),
      rewriteSeriesUid,
    });
    // A dry run that found unreadable files should still say so loudly.
    return scanned.readErrors.length > 0 ? 1 : 0;
  }

  // Compressed transfer syntaxes need the codecs module; uncompressed do not.
  await codecs.initialize(Transcoding);

  if (rewriteSeriesUid) {
    log.warn(
      '--rewrite-series-uid is on: the Series Instance UID of every instance will be ' +
        'replaced before sending. The data the peer receives will not match the data on disk.'
    );
    if (plan.chunkSource === 'memory') {
      log.info(
        `chunk size held at or below ${MEMORY_CHUNK_CAP} (${chunkRange}) because rewriting ` +
          `requires holding parsed datasets in memory (pass --chunk explicitly to override)`
      );
    }
  }

  // --- Send, study by study ---
  // Bytes on disk across everything registered, so throughput can be expressed
  // as study-moved-per-second rather than wire-bytes-per-second.
  let bytesOnDisk = 0;
  for (const studyLedger of ledger.studies.values()) {
    for (const entry of studyLedger.entries) bytesOnDisk += entry.bytes || 0;
  }

  const metrics = {
    parallel,
    chunkRange,
    perStudy,
    // Associations currently open and accepted, and the most there have ever
    // been at once in the study being sent. Both are measured; see the
    // onAccepted handler in sendChunk for why nothing else will do. The peak
    // is reset per study, because a study is what the pool is sized for.
    liveAssociations: 0,
    peakAssociations: 0,
    // One record per study, so that a run of unequal studies can be read as
    // what it was rather than reduced to a single number that fits none of them.
    studies: [],
    speed: plan.parallelSource === 'speed' ? speed : undefined,
    bytesOnDisk,
    bytesSent: 0,
    bytesReceived: 0,
    associations: 0,
    acceptedSyntaxes: new Set(),
    startedAt: Date.now(),
  };
  const options = { rewriteSeriesUid, transferSyntax, metrics };
  let studyIndex = 0;

  for (const studyLedger of ledger.studies.values()) {
    studyIndex += 1;
    const entries = studyLedger.entries;
    // This study's own size. See chunkSizeForStudy: sizing every study off the
    // smallest one in the folder charged the large studies for the small one's
    // shape and bought the small one nothing.
    const studyChunkSize = chunkSizeForStudy(plan, entries.length);
    const chunks = chunk(entries, studyChunkSize);

    log.info('');
    log.info(
      `study ${studyIndex}/${ledger.studies.size} ${log.color.bold(studyLedger.studyInstanceUid)}`
    );
    // What this study will actually do, computed from the chunks that were just
    // made rather than from the request, so the line cannot flatter the run.
    const studyPlan = planStudy({
      instances: entries.length,
      chunkSize: studyChunkSize,
      parallel,
      chunkCount: chunks.length,
    });

    log.info(`  ${studyPlan.summary}`);
    // The requested width was not achievable for this study. Said out loud, so
    // that a throughput figure is never quietly attributed to a concurrency
    // that never happened. This fires before the transfer and catches only the
    // chunk-count cause; what the receiver did is checked after the run.
    if (studyPlan.warning) log.warn(`  ${studyPlan.warning}`);

    // Chunks are dispatched by a small pool of workers, each of which opens its
    // own association. C-STORE is sequential within an association — the
    // protocol has no way to interleave — so the only honest way to go faster
    // is to run several associations at once. One worker reproduces exactly
    // the previous behaviour, which is why that is still the default.
    let nextChunk = 0;
    const workerCount = studyPlan.workers;
    metrics.peakAssociations = 0;

    const worker = async (workerId) => {
      for (;;) {
        const i = nextChunk++;
        if (i >= chunks.length) return;

        const label = parallel > 1
          ? `study ${studyIndex} chunk ${i + 1}/${chunks.length} [w${workerId}]`
          : `study ${studyIndex} chunk ${i + 1}/${chunks.length}`;
        log.info(`  ${label}: sending ${chunks[i].length} instance(s)`);

        await sendChunkWithRetry({
          entries: chunks[i],
          metaByPath,
          studyLedger,
          connection,
          timeouts,
          options,
          retries,
          label,
        });

        const soFar = studyLedger.reconcile();
        log.info(
          `  ${label}: ${soFar.acknowledged}/${soFar.found} acknowledged so far`
        );
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, (_, w) => worker(w + 1))
    );

    // The workers were dispatched but the peer never had that many
    // associations accepted at once. Usually that is a receiver at its
    // concurrent-association limit, which rejects the extras rather than
    // slowing down; it can also just be a tail that drained before the last
    // worker got started, which is why the warning names both readings and
    // neither is asserted. Checked per study rather than run-wide, because
    // a run-wide minimum would let one narrow study hide a rejection in a wide
    // one. Worth saying even when the run succeeds: an A-ASSOCIATE-RJ with
    // transient permanence is retryable, so the retry lands in a slot that has
    // since freed and every instance ends up acknowledged — a clean exit 0
    // whose throughput was measured on a link that never carried the width
    // this study asked for. On stderr, so it reaches the --json path too.
    if (metrics.peakAssociations < workerCount) {
      log.warn(
        `  ${workerCount} concurrent association(s) were opened for this study but the peer ` +
          `never had more than ${metrics.peakAssociations} accepted at once — any throughput ` +
          `figure for this run is for ${metrics.peakAssociations}. Either the peer refused the ` +
          `rest, which is what a receiver at its concurrent-association limit does, or they ` +
          `never overlapped. Check the peer's logs before trusting a wider number, and lower ` +
          `--parallel or --speed to what it allows.`
      );
    }

    metrics.studies.push({
      studyInstanceUid: studyLedger.studyInstanceUid,
      instances: entries.length,
      chunkSize: studyChunkSize,
      chunks: chunks.length,
      // Named for what it is: workers this study dispatched. It is arithmetic —
      // min(parallel, chunks) — and says nothing about what the receiver
      // accepted. peakAssociations is the number that does.
      workers: workerCount,
      peakAssociations: metrics.peakAssociations,
    });
  }

  // --- Reconcile and report ---
  metrics.elapsedMs = Date.now() - metrics.startedAt;
  const result = ledger.reconcile();

  metrics.parallelAchieved = runParallelAchieved(metrics.studies, parallel);

  const throughput = summariseThroughput(result, metrics);

  if (asJson) {
    log.out(JSON.stringify({
      ok: result.ok,
      peer: { host: connection.host, port: connection.port, calledAe: connection.calledAe, callingAe: connection.callingAe },
      label,
      requestedTransferSyntax: transferSyntax
        ? { uid: transferSyntax, name: TRANSFER_SYNTAX_NAMES[transferSyntax] || transferSyntax }
        : null,
      negotiatedTransferSyntaxes: throughput.negotiated,
      found: result.totals.found,
      sent: result.totals.sent,
      acknowledged: result.totals.acknowledged,
      failed: result.totals.failed,
      warned: result.totals.warning,
      shortfall: result.totals.shortfall,
      ...planJson(plan, metrics.parallelAchieved, metrics.studies),
      associations: metrics.associations,
      elapsedMs: metrics.elapsedMs,
      bytesOnDisk: throughput.bytesOnDisk,
      bytesSent: metrics.bytesSent,
      bytesReceived: metrics.bytesReceived,
      instancesPerSecond: throughput.instancesPerSecond,
      megabytesPerSecond: throughput.megabytesPerSecond,
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  // A label rather than a number when the studies used different sizes: the
  // header line there names one size per association and there was no one size.
  report.transfer({
    result,
    connection,
    chunkSize: chunkUniform ? chunkMax : `${chunkRange} (derived per study)`,
    rewriteSeriesUid,
  });
  reportThroughput(throughput, metrics, transferSyntax);

  return result.ok ? 0 : 1;
}

module.exports = {
  run,
  USAGE,
  isRetryableStatus,
  buildRequest,
  SPEED_PRESETS,
  resolveSpeedName,
  deriveChunkSize,
  resolveSpeedPlan,
  chunkSizeForStudy,
  planStudy,
  planJson,
  runParallelAchieved,
};
