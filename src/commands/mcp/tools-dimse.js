'use strict';

/**
 * MCP tools that drive DIMSE and local-file commands: connectivity, query,
 * worklist, inventory, tag inspection, transfer, mutation, and the Modality
 * Performed Procedure Step verbs that close the worklist loop.
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
 * How a dcm_worklist row becomes a dcm_mpps_perform call.
 *
 * The CLI hands a worklist item to MPPS through a file: `dcm find --mwl
 * --json-raw > wl.json`, then `dcm mpps perform --from-worklist wl.json`.
 * Across the MCP boundary there is no file — dcm_worklist's answer lands in the
 * conversation, and nothing here writes it to disk — so the handoff is made of
 * named parameters instead, one per row key, and this table is the mapping. It
 * is emitted once per worklist result rather than once per row: the values are
 * already in `matches`, and copying them a second time would be a second thing
 * to keep in step with the first.
 *
 * ScheduledStationAETitle is deliberately absent. It names the station the work
 * was BOOKED on; PerformedStationAETitle names the AE the images actually
 * arrive under, and defaulting the second to the first would break the match
 * the archive makes between the images and the step whenever this tool is not
 * running on that station.
 */
const MPPS_HANDOFF = {
  tool: 'dcm_mpps_perform',
  // In the order an MPPS SCP tries them: the first key that matches anything
  // decides, so a correct Study Instance UID is worth more than the rest.
  correlationKeys: ['StudyInstanceUID', 'AccessionNumber', 'ScheduledProcedureStepID'],
  parameters: {
    StudyInstanceUID: 'studyUid',
    AccessionNumber: 'accessionNumber',
    ScheduledProcedureStepID: 'scheduledStepId',
    Modality: 'modality',
    PatientID: 'patientId',
    PatientName: 'patientName',
    PatientBirthDate: 'patientBirthDate',
    PatientSex: 'patientSex',
    RequestedProcedureID: 'requestedProcedureId',
    RequestedProcedureDescription: 'requestedProcedureDescription',
  },
};

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
        'Ask a worklist SCP what is SCHEDULED — which patients and procedures are booked on a modality, and when. This is scheduling data, not stored images: a study appearing here has not necessarily been acquired, and one that has been acquired may already have left the worklist. Matching keys are a different vocabulary from a study query (ScheduledProcedureStepStartDate, ScheduledStationAETitle, Modality, ScheduledPerformingPhysicianName, RequestedProcedureDescription, AccessionNumber, PatientID, PatientName) and the scheduling ones belong inside the Scheduled Procedure Step Sequence — the engine places them there for you and flattens them back out in the answer, which is why a hand-built flat worklist query usually returns nothing. An empty worklist is a legitimate answer, not a fault: nothing may be booked for that date, station or modality. Before concluding the SCP is broken, retry with scheduledDate "any" and no other filters to see whether it returns anything at all. Each row carries the keys the MPPS tools need — StudyInstanceUID above all — and structuredContent.mppsHandoff names which parameter of dcm_mpps_perform each one goes to, so going from a scheduled row to a performed step needs no guessing.',
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
      : '\n\nTo report what was performed against one of these rows, pass its keys to ' +
        'dcm_mpps_perform as named parameters: StudyInstanceUID as studyUid, ' +
        'AccessionNumber as accessionNumber, ScheduledProcedureStepID as scheduledStepId, ' +
        'Modality as modality, and the patient keys likewise. The full mapping is in ' +
        'structuredContent.mppsHandoff. Do not write these rows to a file and pass them as ' +
        'fromWorklist: this JSON is rendered for reading, and the MPPS commands refuse it ' +
        'by name.';

    // Additive: `count` and `matches` keep the shape every existing consumer
    // reads. The handoff table rides along so the mapping is machine-readable
    // and not only prose in the note above.
    const structured = parsed.count === 0 ? parsed : { ...parsed, mppsHandoff: MPPS_HANDOFF };

    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) + note }],
      structuredContent: structured,
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

  // ---- Modality Performed Procedure Step ---------------------------------

  // `dcm mpps` is not in the runtime's default command table. The table is the
  // set the first tool modules needed, not a closed list, so a module that
  // drives a command missing from it registers that command here rather than
  // reaching around runCommand and opening a second output capture. Guarded
  // because register() is called once per server and several times per test
  // run.
  if (!rt.COMMANDS.mpps) rt.COMMANDS.mpps = () => require('../mpps');

  /**
   * The step attributes dcm_mpps_start and dcm_mpps_perform share.
   *
   * Named after the dcm_worklist row keys they come from, so the handoff is a
   * rename and not a translation. See MPPS_HANDOFF for why this is parameters
   * rather than a file.
   *
   * @returns {Record<string, object>}
   */
  const stepSchema = () => ({
    studyUid: z.string().optional().describe(
      'Study Instance UID — StudyInstanceUID from the dcm_worklist row. Type 1 inside ScheduledStepAttributesSequence, and THE correlation key: the RIS ties the step to the order and to the images on this and little else. dcm_mpps_perform takes it from the folder when the folder holds exactly one study and this is not given, and refuses if the two disagree.'),
    accessionNumber: z.string().optional().describe('AccessionNumber from the worklist row. The second correlation key an SCP tries.'),
    scheduledStepId: z.string().optional().describe('ScheduledProcedureStepID from the worklist row. The third correlation key, and what stepId defaults to.'),
    modality: z.string().optional().describe('Modality of the performed step, e.g. CT. Type 1. dcm_mpps_perform reads it from the folder when the folder holds exactly one modality, and refuses to guess when it holds several.'),
    stepId: z.string().optional().describe('Performed Procedure Step ID. Type 1. Defaults to scheduledStepId. With neither, the call is refused locally before anything is sent.'),
    stationAe: z.string().optional().describe('Performed Station AE Title. Type 1. Defaults to callingAe, which is the AE the images arrive under, so the archive matches the two by default. Setting it to the SCHEDULED station AE instead breaks that match unless the images really are sent from there.'),
    stationName: z.string().optional().describe('Performed Station Name (free text, not an AE Title).'),
    location: z.string().optional().describe('Performed Location.'),
    stepDescription: z.string().optional().describe('Performed Procedure Step Description — what was actually done.'),
    patientId: z.string().optional(),
    patientName: z.string().optional().describe('DICOM person name, e.g. "DOE^JANE".'),
    patientBirthDate: z.string().optional().describe('YYYYMMDD.'),
    patientSex: z.string().optional().describe('M, F or O.'),
    requestedProcedureId: z.string().optional(),
    requestedProcedureDescription: z.string().optional(),
    startDate: z.string().optional().describe('YYYYMMDD the step started. Default: today, local time on this machine.'),
    startTime: z.string().optional().describe('HHMMSS the step started. Default: now, local time on this machine.'),
    mppsUid: z.string().optional().describe('Use this MPPS SOP Instance UID rather than generating one. The generated one is returned, and it is the only handle on the step.'),
    fromWorklist: z.string().optional().describe(
      'Path to a JSON file of worklist attributes, as written by `dcm find --mwl --json-raw`. It is NOT the output of dcm_worklist or `dcm find --mwl --json`: that form is rendered for people to read, which turns sequences into strings, and it is refused by name rather than sent malformed. Over MCP prefer the named parameters above — they carry the same values with no file involved. Named parameters win over anything in the file.'),
  });

  /**
   * Builds the attribute half of an mpps argument vector.
   *
   * @param {object} a  Tool arguments.
   * @returns {string[]}
   */
  const stepArgv = (a) => {
    const argv = [];
    // First, so the explicit parameters below override what the file carries —
    // the same precedence the CLI has.
    opt(argv, '--from-worklist', a.fromWorklist);
    opt(argv, '--study-uid', a.studyUid);
    opt(argv, '--accession', a.accessionNumber);
    opt(argv, '--scheduled-step-id', a.scheduledStepId);
    opt(argv, '--modality', a.modality);
    opt(argv, '--step-id', a.stepId);
    opt(argv, '--station-ae', a.stationAe);
    opt(argv, '--station-name', a.stationName);
    opt(argv, '--location', a.location);
    opt(argv, '--step-description', a.stepDescription);
    opt(argv, '--patient-id', a.patientId);
    opt(argv, '--patient-name', a.patientName);
    opt(argv, '--patient-birth-date', a.patientBirthDate);
    opt(argv, '--patient-sex', a.patientSex);
    opt(argv, '--requested-procedure-id', a.requestedProcedureId);
    opt(argv, '--requested-procedure-description', a.requestedProcedureDescription);
    opt(argv, '--start-date', a.startDate);
    opt(argv, '--start-time', a.startTime);
    opt(argv, '--mpps-uid', a.mppsUid);
    return argv;
  };

  /**
   * The sentences an MPPS result has to end with, assembled from the fields the
   * command emitted rather than restated here.
   *
   * The rule this enforces is the fourth honesty rule: nothing in an MPPS
   * result may imply the worklist changed on the far end. The step status is
   * what the SCP answered about the step; what it then does with the scheduled
   * procedure step is invisible from this side of the association, so the note
   * says so every time the round trip succeeded.
   *
   * @param {object} p  The parsed JSON document the mpps verb printed.
   * @returns {string}
   */
  function mppsNote(p) {
    const notes = [];

    if (p.dryRun) {
      notes.push(
        '--dry-run: no connection was opened, no step was created and nothing was sent. ' +
          'The dataset above is what would go on the wire.' +
          (p.found === undefined
            ? ''
            : ' PerformedSeriesSequence cannot be previewed — it is built from what the ' +
              'archive acknowledges, and nothing has been acknowledged.')
      );
    }

    if (p.explanation) {
      notes.push(
        `${p.explanation}\n\nThere is no override for this. COMPLETED asserts the work is ` +
          'fully accounted for, and PerformedSeriesSequence names only what the archive ' +
          'actually took, so a COMPLETED here would be a claim nothing supports. Resend the ' +
          'outstanding instances and open a new step, or find out why the archive refused them.'
      );
    }

    if (p.stage === 'n-create') {
      notes.push('The N-CREATE failed, so no step was opened and nothing was sent. The instances on disk are untouched.');
    } else if (p.stage === 'n-set') {
      notes.push(
        'The images were sent and the acknowledged count above is real, but the closing N-SET ' +
          `failed, so the step is still IN PROGRESS on the peer. Close it with dcm_mpps_${p.intendedStatus === 'DISCONTINUED' ? 'discontinue' : 'complete'} ` +
          `{ mppsUid: "${p.mppsSopInstanceUid}" }` +
          (p.stepRecord ? `, passing acknowledged: "${p.stepRecord}" so the performed series survive.` : '. Pass writeAcknowledged next time so the acknowledged instances survive a failure like this.')
      );
    } else if (!p.ok && p.message) {
      notes.push(p.message);
    }

    if (p.assertedFromDisk) {
      notes.push(
        'The performed series above were built by scanning a local folder. Nothing here ' +
          'confirms the archive holds those instances — they were not sent by this call and ' +
          'nobody acknowledged them. The MPPS now asserts they exist.'
      );
    }

    if (p.reasonRecordedLocally && !p.reasonSent) {
      notes.push(
        `The reason "${p.reasonRecordedLocally}" was recorded in this result and NOT sent. A ` +
          'discontinuation reason is a coded attribute whose CodeValue, CodingSchemeDesignator ' +
          'and CodeMeaning are all Type 1, so free text has nowhere legal to go in it. Use ' +
          'reasonCode "CODE^SCHEME^MEANING" to send a real one.'
      );
    }

    // Guarded on dryRun as well as ok: a dry run reports ok:true having spoken
    // to nobody, and saying the SCP answered would be exactly the kind of
    // invented reassurance these tools exist to avoid.
    if (p.ok && !p.dryRun) {
      notes.push(
        'The SCP answered success. What it does next with the scheduled procedure step — ' +
          'whether the worklist entry disappears, changes status or stays put — happens on its ' +
          'side and is not visible from here. If a later dcm_worklist no longer returns the ' +
          'item, that is the SCP correlating the two, not proof this call changed the order.'
      );
    }

    return notes.join('\n\n');
  }

  /**
   * Presents an mpps verb's `--json` document.
   *
   * Unlike jsonResult, a failure still carries structuredContent. The shortfall
   * path IS the interesting one — found, sent and acknowledged side by side are
   * the whole point of it — and dropping the numbers because the exit code was
   * non-zero would leave an assistant with nothing to reason about at exactly
   * the moment it needs them.
   *
   * @param {{code:number, out:string, err:string}} result  From runCommand.
   * @returns {object}  MCP tool result.
   */
  function mppsResult(result) {
    let parsed;
    try {
      parsed = JSON.parse(result.out);
    } catch {
      // A usage error is refused before anything is sent and never prints a
      // document; its message is the whole answer.
      return textResult(result);
    }

    const note = mppsNote(parsed);
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) + (note ? `\n\n${note}` : '') }],
      structuredContent: parsed,
      isError: parsed.ok !== true,
    };
  }

  server.registerTool(
    'dcm_mpps_perform',
    {
      title: 'Perform a study (MPPS N-CREATE, C-STORE, N-SET)',
      description:
        'Report a study as performed, end to end: open a Modality Performed Procedure Step (N-CREATE, IN PROGRESS), C-STORE the folder to the archive, then close the step (N-SET). This is the verb that closes the worklist loop — dcm_worklist says what is scheduled, this says what happened, and a RIS reconciles the two on Study Instance UID. ' +
        'THE STEP IS MARKED COMPLETED ONLY IF EVERY INSTANCE FOUND ON DISK WAS ACKNOWLEDGED BY THE ARCHIVE. There is no override. If even one is unaccounted for the step is marked DISCONTINUED and this tool returns an error result saying how many are missing — a partial transfer is never reported as a completed procedure. ' +
        'PerformedSeriesSequence is built only from instances the archive positively acknowledged, never from a folder listing, because naming a SOP Instance UID the archive does not hold is a fabricated clinical record that everything downstream believes. Instances stored with a warning status are referenced (the archive holds them) but do not count as acknowledged, so a run with warnings still ends DISCONTINUED. ' +
        'What this tool reports is what the MPPS SCP answered. It cannot see the worklist: if the item stops appearing in dcm_worklist afterwards, that is the SCP correlating the step to the order, not proof that this call changed anything. ' +
        'Take the step attributes from a dcm_worklist row — StudyInstanceUID as studyUid above all. To exercise the whole loop locally with no PACS, start dcm_receiver_start with a worklist file and point both the MPPS and the storage side at it. Use dryRun to see the N-CREATE without connecting.',
      inputSchema: {
        folder: z.string().describe('Folder of DICOM files that were produced. Must hold exactly one study: a performed procedure step describes one study, and Study Instance UID is what the RIS reconciles on.'),
        ...peerSchema(),
        storeHost: z.string().optional().describe('Archive hostname. Default: host. MPPS and storage are frequently different systems — a RIS or broker takes the step, an archive takes the images — and the result says which peer took what.'),
        storePort: z.number().int().optional().describe('Archive DIMSE port. Default: port.'),
        storeCalledAe: z.string().optional().describe("The archive's AE Title. Default: calledAe."),
        ...stepSchema(),
        chunk: z.number().int().optional().describe('Instances per storage association (default 200).'),
        retry: z.number().int().optional().describe('Retries for a chunk that came back with fewer acknowledgements than it sent (default 1).'),
        retrieveAe: z.string().optional().describe('Retrieve AE Title recorded against each performed series — where the images can be fetched from. Default: the archive AE they were sent to.'),
        writeAcknowledged: z.string().optional().describe('Path to write a step record: the step, and the instances the archive acknowledged. Pass it if the closing N-SET might fail — it is what lets dcm_mpps_complete rebuild an honest performed-series list later.'),
        endDate: z.string().optional().describe('YYYYMMDD the step ended. Default: now, local time.'),
        endTime: z.string().optional().describe('HHMMSS the step ended. Default: now, local time.'),
        dryRun: z.boolean().optional().describe('Scan the folder and print the N-CREATE that would be sent. Opens no connection, creates no step and sends no images.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = ['perform', a.folder, ...peerArgv(a), ...stepArgv(a)];
      opt(argv, '--store-host', a.storeHost);
      opt(argv, '--store-port', a.storePort);
      opt(argv, '--store-called-ae', a.storeCalledAe);
      opt(argv, '--chunk', a.chunk);
      opt(argv, '--retry', a.retry);
      opt(argv, '--retrieve-ae', a.retrieveAe);
      opt(argv, '--write-acknowledged', a.writeAcknowledged);
      opt(argv, '--end-date', a.endDate);
      opt(argv, '--end-time', a.endTime);
      if (a.dryRun) argv.push('--dry-run');
      if (a.recurse === false) argv.push('--no-recurse');
      argv.push('--json');
      return mppsResult(await runCommand('mpps', argv));
    }
  );

  server.registerTool(
    'dcm_mpps_start',
    {
      title: 'Open a procedure step (MPPS N-CREATE)',
      description:
        'Tell an MPPS SCP that work has begun on a scheduled study: N-CREATE with status IN PROGRESS. Returns the MPPS SOP Instance UID it generated, which is the ONLY handle on the step — dcm_mpps_complete cannot close it without one, so keep it. ' +
        'Use this only when the images are sent by something else, or when the step has to stay open while other work happens; dcm_mpps_perform does start, store and close as one transaction and is the usual choice. ' +
        'Every Type 1 attribute is checked here before anything goes on the wire, and a missing one is refused by name. That is not belt and braces: many SCPs accept an N-CREATE carrying an empty Type 1, answer success, and then never reconcile the step against the order, so from this end it looks like it worked and days later the order is still open. ' +
        'Opening a step says nothing about the worklist entry — whether the SCP moves the scheduled step to ARRIVED or STARTED is its business and is not visible from here.',
      inputSchema: {
        ...peerSchema(),
        ...stepSchema(),
        out: z.string().optional().describe('Path to write a step record carrying the step UID, so dcm_mpps_complete can be given it later instead of the UID by hand.'),
        dryRun: z.boolean().optional().describe('Build and return the N-CREATE dataset without connecting.'),
      },
    },
    async (a) => {
      const argv = ['start', ...peerArgv(a), ...stepArgv(a)];
      opt(argv, '--out', a.out);
      if (a.dryRun) argv.push('--dry-run');
      argv.push('--json');
      return mppsResult(await runCommand('mpps', argv));
    }
  );

  /**
   * Parameters shared by complete and discontinue, which differ only in the
   * terminal status they set and in whether a reason applies.
   *
   * @returns {Record<string, object>}
   */
  const finishSchema = () => ({
    mppsUid: z.string().optional().describe('The MPPS SOP Instance UID returned by dcm_mpps_start. May be omitted when acknowledged names a step record that carries it; giving both a UID and a record that disagree is refused rather than closing the wrong step.'),
    ...peerSchema(),
    acknowledged: z.string().optional().describe('Path to a step record written by dcm_mpps_start (out) or dcm_mpps_perform (writeAcknowledged). PerformedSeriesSequence is built from the instances in it, which are exactly the ones the archive acknowledged. This is the honest source; prefer it wherever it exists.'),
    seriesFrom: z.string().optional().describe('Build PerformedSeriesSequence by scanning this folder instead. IT ASSERTS WHAT IS ON YOUR DISK, NOT WHAT THE ARCHIVE HOLDS — a local folder can contain instances the archive refused, never received, or rejected as duplicates, and naming one of those in an MPPS is a fabricated record. It exists for the case where some other tool did the transfer, and the result says plainly that the sequence was asserted from disk. Mutually exclusive with acknowledged.'),
    retrieveAe: z.string().optional().describe('Retrieve AE Title recorded against each performed series — the AE the images can be fetched from.'),
    endDate: z.string().optional().describe('YYYYMMDD. Default: today, local time.'),
    endTime: z.string().optional().describe('HHMMSS. Default: now, local time.'),
    dryRun: z.boolean().optional().describe('Build and return the N-SET dataset without connecting.'),
    recurse: z.boolean().optional().describe('With seriesFrom, recurse into subfolders (default true).'),
  });

  /**
   * Builds the argument vector for complete and discontinue.
   *
   * @param {string} verb
   * @param {object} a
   * @returns {string[]}
   */
  const finishArgv = (verb, a) => {
    const argv = [verb];
    // The UID is positional and must precede the flags the tokenizer reads.
    if (a.mppsUid !== undefined && a.mppsUid !== '') argv.push(String(a.mppsUid));
    argv.push(...peerArgv(a));
    opt(argv, '--acknowledged', a.acknowledged);
    opt(argv, '--series-from', a.seriesFrom);
    opt(argv, '--retrieve-ae', a.retrieveAe);
    opt(argv, '--end-date', a.endDate);
    opt(argv, '--end-time', a.endTime);
    if (a.dryRun) argv.push('--dry-run');
    if (a.recurse === false) argv.push('--no-recurse');
    return argv;
  };

  server.registerTool(
    'dcm_mpps_complete',
    {
      title: 'Close a procedure step as COMPLETED (MPPS N-SET)',
      description:
        'Close a step opened by dcm_mpps_start: N-SET to COMPLETED. ' +
        'COMPLETED asserts that the work finished and is fully accounted for, so the performed series it carries must be real: pass acknowledged, a step record naming the instances the archive positively acknowledged. seriesFrom scans a folder instead and therefore asserts what is on your disk rather than what the archive holds — the result labels that plainly, and the two sources cannot be combined. Completing with neither is legal DICOM and warns, because it claims the work finished and names no images at all. ' +
        'Note that this tool does not re-check the transfer: it sets the status you asked for. dcm_mpps_perform is the verb that refuses to say COMPLETED when instances are unaccounted for, because it is the one that did the sending and knows. ' +
        'Closing the step here says nothing about the worklist entry. Whether the SCP or a RIS behind it then retires the scheduled step is its own business; query dcm_worklist if you need to know, and read the disappearance as correlation rather than as proof.',
      inputSchema: { ...finishSchema() },
    },
    async (a) => mppsResult(await runCommand('mpps', [...finishArgv('complete', a), '--json']))
  );

  server.registerTool(
    'dcm_mpps_discontinue',
    {
      title: 'Close a procedure step as DISCONTINUED (MPPS N-SET)',
      description:
        'Close a step that did not finish: N-SET to DISCONTINUED. This is the honest ending for an abandoned or partial acquisition, and it is what dcm_mpps_perform sets by itself when the archive did not acknowledge every instance. Any performed series it carries are still built only from acknowledged instances — a step that stopped early still may not claim images the archive does not hold. ' +
        'reason is free text: it is recorded in the result and NOT sent. A discontinuation reason is a coded attribute whose CodeValue, CodingSchemeDesignator and CodeMeaning are all Type 1, so carrying free text there means inventing a code value that means nothing to the receiver — the same fabrication as naming instances that do not exist. reasonCode sends a real one. The result says which of the two happened. ' +
        'As with every verb here, what the SCP then does with the scheduled step is not visible from this end.',
      inputSchema: {
        ...finishSchema(),
        reason: z.string().optional().describe('Free-text reason. Recorded in this result and NOT sent — there is no legal place for free text in a coded reason. Use reasonCode to send one.'),
        reasonCode: z.string().optional().describe('The coded reason, actually sent, as "CODE^SCHEME^MEANING", e.g. "110513^DCM^Discontinued for equipment failure".'),
      },
    },
    async (a) => {
      const argv = finishArgv('discontinue', a);
      // Attached form: a free-text reason shaped like `dose=high` would be read
      // as a matching key by the tokenizer, leaving --reason valueless.
      if (a.reason !== undefined && a.reason !== '') argv.push(`--reason=${a.reason}`);
      if (a.reasonCode !== undefined && a.reasonCode !== '') argv.push(`--reason-code=${a.reasonCode}`);
      argv.push('--json');
      return mppsResult(await runCommand('mpps', argv));
    }
  );
}

module.exports = { register, dicomDate, resolveScheduledDate, MPPS_HANDOFF };
