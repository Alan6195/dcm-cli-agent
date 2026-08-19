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
];

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
                          that memory stays flat regardless of study size.
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
  --label <text>          Tag this run in --json output, for comparing runs.
  --json                  Emit the result and timing as JSON.
  --rewrite-series-uid    Replace each Series Instance UID with a deterministic
                          2.25.<hash> value. MODIFIES DATA — see below.
  --verbose               Log the full association negotiation.

--rewrite-series-uid:
  Some source systems emit the same Series Instance UID for genuinely different
  series, which makes receivers merge them into one stack. This option assigns
  each source series a new, deterministic UID derived from the study and series
  UID together, so distinct series stay distinct. The same input always yields
  the same output, so a re-send maps onto the same series rather than creating a
  duplicate. It changes the data you send, and is off unless asked for.

Examples:
  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE
  dcm send ./studies --host pacs.example.org --port 11112 --called-ae ARCHIVE --chunk 100 --retry 2
  dcm send ./study --dry-run
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
  if (metrics.parallel > 1) {
    log.out(`parallelism       ${metrics.parallel} concurrent association(s)`);
  }

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
      // Record what the peer actually agreed to carry. Proposing a transfer
      // syntax and getting it are different things, and a speed comparison is
      // meaningless without knowing which one was really used.
      if (options && options.metrics) recordAcceptedSyntaxes(assoc, options.metrics);
    },
  });

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
  const parallel = args.resolve(flags, { name: 'parallel', type: 'number', fallback: 1 });
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) {
    throw new args.UsageError(
      `--parallel must be between 1 and 16, got "${parallel}". Most receivers cap ` +
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

  // Rewriting means holding parsed datasets rather than file paths, which costs
  // roughly the size of the study in memory. Shrink the chunk to compensate
  // unless the operator has chosen a size explicitly.
  let chunkSize = chunkSizeRequested;
  // Both rewriting and transcoding have to hold parsed datasets — pixel data
  // included — in memory, so a chunk sized for streaming from disk is far too
  // large. Shrink it unless a size was chosen explicitly.
  if ((rewriteSeriesUid || transferSyntax) && !flags.has('chunk') && chunkSize > 50) {
    chunkSize = 50;
  }

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

  // --- Dry run stops here ---
  if (dryRun) {
    report.dryRun({ scanned, chunkSize, rewriteSeriesUid });
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
    if (chunkSize !== chunkSizeRequested) {
      log.info(
        `chunk size reduced to ${chunkSize} because rewriting requires holding parsed ` +
          `datasets in memory (pass --chunk explicitly to override)`
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
    const chunks = chunk(entries, chunkSize);

    log.info('');
    log.info(
      `study ${studyIndex}/${ledger.studies.size} ${log.color.bold(studyLedger.studyInstanceUid)}`
    );
    log.info(
      `  ${entries.length} instance(s) in ${chunks.length} association(s) of up to ${chunkSize}`
    );

    // Chunks are dispatched by a small pool of workers, each of which opens its
    // own association. C-STORE is sequential within an association — the
    // protocol has no way to interleave — so the only honest way to go faster
    // is to run several associations at once. One worker reproduces exactly
    // the previous behaviour, which is why that is still the default.
    let nextChunk = 0;
    const workerCount = Math.min(parallel, chunks.length);

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
  }

  // --- Reconcile and report ---
  metrics.elapsedMs = Date.now() - metrics.startedAt;
  const result = ledger.reconcile();

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
      chunkSize,
      parallel,
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

  report.transfer({ result, connection, chunkSize, rewriteSeriesUid });
  reportThroughput(throughput, metrics, transferSyntax);

  return result.ok ? 0 : 1;
}

module.exports = { run, USAGE, isRetryableStatus, buildRequest };
