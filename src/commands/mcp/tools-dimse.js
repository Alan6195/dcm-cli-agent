'use strict';

/**
 * MCP tools that drive DIMSE and local-file commands: connectivity, query,
 * worklist, inventory, tag inspection, transfer and mutation.
 *
 * Each tool builds the argument vector the CLI command takes and runs that
 * command through the runtime — the descriptions say what a result does and
 * does not prove, because that is the part an assistant gets wrong.
 */

/**
 * Transfer syntax names `dcm send --transfer-syntax` accepts, for the schema
 * description. A UID is accepted too, which is why the parameter is a string
 * rather than an enum — pinning it to this list would make a peer-specific UID
 * unreachable, and the command already rejects a name it does not know with a
 * message naming every one it does.
 */
const TRANSFER_SYNTAX_NAMES =
  'implicit, explicit, deflated, rle, jpeg-lossless, jpeg-baseline, jpeg-ls, ' +
  'jpeg-ls-lossy, jpeg2000, jpeg2000-lossy';

/**
 * Worklist matching keys that are not exposed as named parameters, listed in
 * the schema so an assistant knows what `keys` is for at the worklist level.
 */
const EXTRA_MWL_KEYS =
  'ScheduledProcedureStepStartTime, ScheduledProcedureStepDescription, ' +
  'ScheduledProcedureStepStatus, ScheduledProcedureStepID, ' +
  'ScheduledPerformingPhysicianName, RequestedProcedureDescription, ' +
  'RequestedProcedureID, PatientBirthDate, PatientSex';

/**
 * Today's date in DICOM DA form, offset by whole days.
 *
 * Built from the local calendar rather than an ISO/UTC slice on purpose: a
 * DICOM date is local to the scanner, so a UTC-derived "today" asks a European
 * afternoon or an American evening about the wrong day and returns an empty
 * worklist that looks like nothing is scheduled.
 *
 * @param {number} [offsetDays]  Whole days from today; negative is the past.
 * @returns {string}  YYYYMMDD.
 */
function dicomDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** A single DICOM date, a closed range, or a range open at either end. */
const DATE_FORMS = /^(\d{8}|\d{8}-\d{8}|\d{8}-|-\d{8})$/;

/**
 * Resolves the scheduledDate parameter to a DICOM date-matching value.
 *
 * The convenience words exist because an assistant frequently does not know
 * what today's date is on the machine running the query, and a worklist is
 * almost always asked about today. Anything already in DICOM form is passed
 * through untouched.
 *
 * @param {string} value
 * @returns {string|null}  The matching value, or null if it is not a date.
 */
function resolveScheduledDate(value) {
  const raw = String(value).trim();
  const word = raw.toLowerCase();
  if (word === 'today') return dicomDate(0);
  if (word === 'tomorrow') return dicomDate(1);
  if (word === 'yesterday') return dicomDate(-1);
  // Inclusive on both ends, which is what a DICOM range means.
  if (word === 'week') return `${dicomDate(0)}-${dicomDate(7)}`;
  if (word === 'any') return '';
  return DATE_FORMS.test(raw) ? raw : null;
}

/**
 * Register the DIMSE and local-file tools on an MCP server.
 *
 * @param {object} server  The McpServer to register on.
 * @param {object} z  The zod module (loaded lazily by the mcp command).
 * @param {object} rt  The MCP runtime ({runCommand, textResult, jsonResult, opt, ...}).
 * @returns {void}
 */
function register(server, z, rt) {
  const { runCommand, textResult, jsonResult, opt } = rt;

  /**
   * Connection parameters shared by every tool that opens an association.
   *
   * Spelled once so a peer is described identically wherever it appears — an
   * assistant that has learned these five names for dcm_echo can use dcm_send
   * without relearning them.
   *
   * @returns {Record<string, object>}
   */
  const peerSchema = () => ({
    host: z.string().describe('Peer hostname or IP.'),
    port: z.number().int().describe('Peer DIMSE port, e.g. 11112.'),
    calledAe: z.string().describe("The peer's AE Title."),
    callingAe: z.string().optional().describe('Our AE Title (default DCM-CLI). Must be registered on the peer.'),
    timeout: z.number().int().optional().describe('Milliseconds of silence to tolerate before giving up (default 60000).'),
    connectTimeout: z.number().int().optional().describe('Milliseconds to wait for the TCP connection alone. Separates "unreachable" from "slow to answer".'),
    associationTimeout: z.number().int().optional().describe('Milliseconds to wait for the association to be accepted or rejected.'),
  });

  /**
   * Build the connection argv every DIMSE tool starts from.
   *
   * @param {object} a  Tool arguments.
   * @returns {string[]}
   */
  const peerArgv = (a) => {
    const argv = ['--host', a.host, '--port', String(a.port), '--called-ae', a.calledAe];
    opt(argv, '--calling-ae', a.callingAe);
    opt(argv, '--timeout', a.timeout);
    opt(argv, '--connect-timeout', a.connectTimeout);
    opt(argv, '--association-timeout', a.associationTimeout);
    return argv;
  };

  // ---- Connectivity ------------------------------------------------------
  server.registerTool(
    'dcm_echo',
    {
      title: 'DICOM C-ECHO',
      description:
        'Verify connectivity to a DICOM peer (C-ECHO). Confirms the peer answers and accepts your calling AE Title. Sends no images. A successful echo does NOT prove storage is permitted: storage is negotiated per SOP Class, and a peer can echo happily while refusing every image you send it.',
      inputSchema: { ...peerSchema() },
    },
    async (a) => textResult(await runCommand('echo', peerArgv(a)))
  );

  // ---- Query -------------------------------------------------------------
  server.registerTool(
    'dcm_query',
    {
      title: 'DICOM C-FIND',
      description:
        'Query a peer for stored studies, series or instances (C-FIND). Note: a peer can accept images and still return zero matches — storing and indexing are separate operations, so zero matches is not proof a transfer failed. For Modality Worklist (what is scheduled, not what is stored) use dcm_worklist instead: the matching keys are a different vocabulary and level "mwl" here gives you no help with them.',
      inputSchema: {
        ...peerSchema(),
        level: z.enum(['study', 'series', 'image', 'mwl']).optional().describe('Query level (default study). "series" requires StudyInstanceUID; "image" requires StudyInstanceUID and SeriesInstanceUID. "mwl" works but prefer dcm_worklist.'),
        keys: z.record(z.string(), z.string()).optional().describe('Matching keys as DICOM keyword→value, e.g. {"PatientID":"12345"}. Values take * and ? wildcards and hyphenated date ranges. An empty value requests the key without matching on it.'),
        limit: z.number().int().optional().describe('Stop after this many matches.'),
      },
    },
    async (a) => {
      const argv = peerArgv(a);
      if (a.level && a.level !== 'study') argv.push(`--${a.level}`);
      opt(argv, '--limit', a.limit);
      for (const [k, v] of Object.entries(a.keys || {})) argv.push(`${k}=${v}`);
      argv.push('--json');
      return jsonResult(await runCommand('find', argv));
    }
  );

  server.registerTool(
    'dcm_worklist',
    {
      title: 'Modality Worklist (C-FIND MWL)',
      description:
        'Ask a worklist SCP what is SCHEDULED — which patients and procedures are booked on a modality, and when. This is scheduling data, not stored images: a study appearing here has not necessarily been acquired, and one that has been acquired may already have left the worklist. Matching keys are a different vocabulary from a study query (ScheduledProcedureStepStartDate, ScheduledStationAETitle, Modality, ScheduledPerformingPhysicianName, RequestedProcedureDescription, AccessionNumber, PatientID, PatientName) and the scheduling ones belong inside the Scheduled Procedure Step Sequence — the engine places them there for you and flattens them back out in the answer, which is why a hand-built flat worklist query usually returns nothing. An empty worklist is a legitimate answer, not a fault: nothing may be booked for that date, station or modality. Before concluding the SCP is broken, retry with scheduledDate "any" and no other filters to see whether it returns anything at all.',
      inputSchema: {
        ...peerSchema(),
        modality: z.string().optional().describe('Modality the procedure is scheduled on, e.g. CT, MR, CR, US.'),
        scheduledDate: z.string().optional().describe('Scheduled start date. Accepts "today", "tomorrow", "yesterday", "week" (today through seven days ahead), "any" (no date matching), a single YYYYMMDD, or a range YYYYMMDD-YYYYMMDD, YYYYMMDD- or -YYYYMMDD. Prefer the words: they are resolved against the local calendar of the machine running the query.'),
        scheduledStationAe: z.string().optional().describe('AE Title of the station the procedure is scheduled on — how a single scanner asks for only its own list.'),
        patientId: z.string().optional(),
        patientName: z.string().optional().describe('DICOM person name, e.g. "DOE^JANE". Wildcards allowed, e.g. "DOE*".'),
        accessionNumber: z.string().optional(),
        keys: z.record(z.string(), z.string()).optional().describe(`Any other matching key as DICOM keyword→value, for what the named parameters do not cover: ${EXTRA_MWL_KEYS}. A named parameter wins if it sets the same key.`),
        limit: z.number().int().optional().describe('Stop after this many scheduled procedures.'),
      },
    },
    async (a) => {
      // Free-form keys go in first so the named parameters overwrite them:
      // the named ones are the explicit request, and silently ignoring
      // modality because keys also carried a Modality would be the wrong way
      // round.
      const pairs = new Map(Object.entries(a.keys || {}));

      if (a.scheduledDate !== undefined && a.scheduledDate !== '') {
        const date = resolveScheduledDate(a.scheduledDate);
        if (date === null) {
          return {
            content: [{
              type: 'text',
              text:
                `scheduledDate "${a.scheduledDate}" is neither a DICOM date nor a word I know. ` +
                'Use YYYYMMDD, a range YYYYMMDD-YYYYMMDD, or one of: today, tomorrow, yesterday, week, any.',
            }],
            isError: true,
          };
        }
        if (date !== '') pairs.set('ScheduledProcedureStepStartDate', date);
      }

      const named = [
        ['Modality', a.modality],
        ['ScheduledStationAETitle', a.scheduledStationAe],
        ['PatientID', a.patientId],
        ['PatientName', a.patientName],
        ['AccessionNumber', a.accessionNumber],
      ];
      for (const [key, value] of named) {
        if (value !== undefined && value !== '') pairs.set(key, String(value));
      }

      const argv = peerArgv(a);
      argv.push('--mwl');
      opt(argv, '--limit', a.limit);
      for (const [k, v] of pairs) argv.push(`${k}=${v}`);
      argv.push('--json');

      return worklistResult(await runCommand('find', argv));
    }
  );

  /**
   * Present a worklist query result.
   *
   * `dcm find` exits non-zero on zero matches, which is right for a shell —
   * "did my study arrive?" wants a failing exit code when it did not. It is
   * wrong here: an empty worklist is a real answer to "what is scheduled",
   * and flagging it isError makes an assistant report a fault that does not
   * exist. So a run that produced a parseable result document is reported as
   * a success whatever the exit code, and only a query that failed to produce
   * one falls through to the ordinary JSON handling.
   *
   * @param {{code:number, out:string, err:string}} result  From runCommand.
   * @returns {object}  MCP tool result.
   */
  function worklistResult(result) {
    let parsed;
    try {
      parsed = JSON.parse(result.out);
    } catch {
      return jsonResult(result);
    }
    if (!parsed || typeof parsed.count !== 'number') return jsonResult(result);

    const note = parsed.count === 0
      ? '\n\nNo scheduled procedures matched. That is a legitimate answer — nothing may be ' +
        'booked for this date, station or modality. Re-run with scheduledDate "any" and no ' +
        'other filters before concluding the worklist SCP is at fault.'
      : '';

    return {
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) + note }],
      structuredContent: parsed,
    };
  }

  // ---- Local files -------------------------------------------------------
  server.registerTool(
    'dcm_inventory',
    {
      title: 'Inventory a DICOM folder',
      description:
        'Inventory a folder or file: studies, series, modalities, counts, sizes and transfer syntaxes. Reads metadata only, writes nothing and sends nothing.',
      inputSchema: {
        path: z.string().describe('Folder or .dcm file to inspect.'),
        series: z.boolean().optional().describe('Break the inventory down per series and flag colliding Series UIDs.'),
        chunk: z.number().int().optional().describe('Instances per association, to show how many associations a send would take (default 200).'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true). false looks only at files directly in the folder.'),
      },
    },
    async (a) => {
      const argv = [a.path];
      if (a.series) argv.push('--series');
      opt(argv, '--chunk', a.chunk);
      if (a.recurse === false) argv.push('--no-recurse');
      argv.push('--json');
      return jsonResult(await runCommand('info', argv));
    }
  );

  server.registerTool(
    'dcm_tags',
    {
      title: 'Inspect DICOM tags',
      description:
        'Dump the DICOM tags in a file or folder. Reads metadata only, writes nothing, and never returns pixel data — bulk binary elements are reported by size instead. By default one representative file per series is dumped, because a folder of a thousand instances differing only in pixel data buries the answer rather than showing it.',
      inputSchema: {
        path: z.string().describe('File or folder to read.'),
        filter: z.string().optional().describe('Only tags whose keyword, tag number or value matches. Case-insensitive substring, or /regex/.'),
        value: z.string().optional().describe('Only tags whose VALUE matches — how you find which files still carry an identifier.'),
        privateOnly: z.boolean().optional().describe('Only private and unrecognised tags — the ones most likely to survive de-identification.'),
        all: z.boolean().optional().describe('Dump every file, not one representative per series.'),
        depth: z.number().int().optional().describe('How far to walk into sequences (default 2).'),
        limit: z.number().int().optional().describe('Stop after this many files.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = [a.path];
      opt(argv, '--filter', a.filter);
      opt(argv, '--value', a.value);
      if (a.privateOnly) argv.push('--private');
      if (a.all) argv.push('--all');
      opt(argv, '--depth', a.depth);
      opt(argv, '--limit', a.limit);
      if (a.recurse === false) argv.push('--no-recurse');
      argv.push('--json');
      return jsonResult(await runCommand('tags', argv));
    }
  );

  // ---- Transfer / mutation ----------------------------------------------
  server.registerTool(
    'dcm_send',
    {
      title: 'Send a study (C-STORE)',
      description:
        'Send a folder to a peer (C-STORE), grouped by study and chunked across associations. Reports three separate numbers — files found on disk, files sent, instances the peer acknowledged — and any shortfall between them is a failure (isError). Acknowledgement means the peer accepted the instances; it does not mean they are queryable, which is a separate operation. Use dryRun to plan without connecting.',
      inputSchema: {
        path: z.string().describe('Folder of DICOM files to send.'),
        ...peerSchema(),
        chunk: z.number().int().optional().describe('Instances per association (default 200; automatically reduced when converting or rewriting, which hold datasets in memory).'),
        retry: z.number().int().optional().describe('Retry attempts for a chunk where fewer instances came back acknowledged than were sent (default 1).'),
        parallel: z.number().int().optional().describe('Associations to run at once, 1-16 (default 1). C-STORE is sequential inside one association, so this is the only real way to go faster — but check what the receiver allows: exceeding its limit gets associations rejected rather than speeding anything up.'),
        transferSyntax: z.string().optional().describe(`Convert every instance to this transfer syntax BEFORE sending it — a real conversion, not just a proposal, so the bytes on the wire are in the syntax you asked for. A name (${TRANSFER_SYNTAX_NAMES}) or a UID. The files on disk are not modified. If the peer refuses the converted syntax the transfer falls back to one it accepts, and the report names what was actually negotiated.`),
        label: z.string().optional().describe('Free-text tag for this run, carried into the result so several runs can be compared.'),
        dryRun: z.boolean().optional().describe('Scan and report the plan without opening a connection.'),
        rewriteSeriesUid: z.boolean().optional().describe('Replace each Series Instance UID with a deterministic value before sending, so sources that reuse one UID for different series do not get merged. MODIFIES THE DATA THE PEER RECEIVES — it will not match the files on disk. The files on disk are not modified.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = [a.path, ...peerArgv(a)];
      opt(argv, '--chunk', a.chunk);
      opt(argv, '--retry', a.retry);
      opt(argv, '--parallel', a.parallel);
      opt(argv, '--transfer-syntax', a.transferSyntax);
      // Attached form rather than two tokens: a label is free text, and one
      // shaped like `run=2` would be read as a C-FIND matching key by the
      // tokenizer, leaving --label valueless. `--label=run=2` cannot be.
      if (a.label !== undefined && a.label !== '') argv.push(`--label=${a.label}`);
      if (a.dryRun) argv.push('--dry-run');
      if (a.rewriteSeriesUid) argv.push('--rewrite-series-uid');
      if (a.recurse === false) argv.push('--no-recurse');
      return textResult(await runCommand('send', argv));
    }
  );

  server.registerTool(
    'dcm_anon',
    {
      title: 'De-identify a folder',
      description:
        'WRITES FILES: copies a folder into out with patient identifiers removed and UIDs remapped deterministically. The source folder is never modified, but out is created and filled. Best-effort, not certified: it does not touch pixel data, so burned-in annotations and scanned paperwork still carry identifiers, and identifiers nested inside sequences such as Structured Reports may survive. Inspect a sample with dcm_tags before sharing anything.',
      inputSchema: {
        path: z.string().describe('Source folder.'),
        out: z.string().describe('Destination folder, created if needed. Must be outside the source.'),
        prefix: z.string().optional().describe('Pseudonym prefix (default ANON).'),
        keepDescriptions: z.boolean().optional().describe('Keep Study/Series descriptions, which are removed by default.'),
        keepPrivate: z.boolean().optional().describe('Keep private and unrecognised tags, which are removed by default.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = [a.path, '--out', a.out];
      opt(argv, '--prefix', a.prefix);
      if (a.keepDescriptions) argv.push('--keep-descriptions');
      if (a.keepPrivate) argv.push('--keep-private');
      if (a.recurse === false) argv.push('--no-recurse');
      return textResult(await runCommand('anon', argv), { successText: 'De-identified.' });
    }
  );

  server.registerTool(
    'dcm_edit',
    {
      title: 'Edit DICOM tags',
      description:
        'WRITES FILES: changes or removes tags. With out, edited copies are written there and the source is untouched. With inPlace, the SOURCE FILES ARE OVERWRITTEN — destructive and irreversible, so prefer out unless overwriting is explicitly what was asked for. Exactly one of out or inPlace is required; there is no default. Editing UIDs is refused without force, because changing them on some instances and not others splits a study or collides with an existing one — dcm_anon remaps UIDs consistently instead. Use dryRun first to see what would change.',
      inputSchema: {
        path: z.string().describe('Source file or folder.'),
        out: z.string().optional().describe('Destination folder for the edited copies, mirroring the source layout. Must be outside the source. Mutually exclusive with inPlace.'),
        inPlace: z.boolean().optional().describe('Overwrite the source files instead of writing copies. Destructive and irreversible. Mutually exclusive with out.'),
        set: z.record(z.string(), z.string()).optional().describe('Tags to set: keyword (PatientID), punctuated tag ((0010,0020)) or bare hex tag (00100020) → value.'),
        remove: z.array(z.string()).optional().describe('Tag keywords or numbers to remove.'),
        dryRun: z.boolean().optional().describe('Report what would change without writing anything.'),
        force: z.boolean().optional().describe('Allow editing UIDs and other structural identifiers.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = [a.path];
      for (const [k, v] of Object.entries(a.set || {})) argv.push('--set', `${k}=${v}`);
      for (const k of a.remove || []) argv.push('--remove', k);
      // Neither given is left to the command, which explains the choice
      // between copying and overwriting far better than a schema error could.
      opt(argv, '--out', a.out);
      if (a.inPlace) argv.push('--in-place');
      if (a.dryRun) argv.push('--dry-run');
      if (a.force) argv.push('--force');
      if (a.recurse === false) argv.push('--no-recurse');
      return textResult(await runCommand('edit', argv));
    }
  );
}

module.exports = { register, dicomDate, resolveScheduledDate };
