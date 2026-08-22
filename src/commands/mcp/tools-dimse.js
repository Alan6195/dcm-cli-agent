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

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveCliCommand } = require('./tools-servers');

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
 * What `raw` changes about a query result, said once for both query tools.
 *
 * Spelled here rather than twice because the two tools differ in what they do
 * with the answer and not in what raw means, and two copies of a paragraph this
 * detailed drift apart on the first edit.
 */
const RAW_DESCRIPTION =
  'Return values exactly as they came off the wire instead of rendered for reading (`dcm find --json-raw`). ' +
  'A DICOM parser normally repairs as it reads — PatientWeight sent as "12.5 kg" arrives as the number 12.5 with the unit silently gone — and that repair is correct when consuming a study and wrong when TESTING the peer that sent it, because the violation disappears before anyone can see it. Raw re-reads the received octets and never turns a value into a number. ' +
  'Each match also carries "_elements", a sidecar keyed by tag holding vr, length (the Value Length field including any pad octet, so an odd length is visible), keyword, vm and the value text; a sequence carries "items", and "vrSource": "dictionary" means the peer sent no VR and ours came from the data dictionary. ' +
  'Two shape changes to expect: a Decimal or Integer String is now text rather than a number, and a Person Name is an object like [{"Alphabetic": "DOE^JANE"}] rather than a string — so a raw PatientName must NOT be copied straight into an MPPS patientName parameter. Leave this off unless the octets are the thing under test.';

/**
 * The VR conformance gate, said once for both query tools.
 */
const CHECK_VR_DESCRIPTION =
  'Audit the elements the peer returned for VR conformance violations and report every one (`dcm find --check-vr`): values over the VR maximum (LO 64, SH 16, PN 64 per component group, AE 16, CS 16, DS 16, IS 12, UI 64), lowercase or non-enumerated Code Strings, Decimal and Integer Strings carrying non-numeric characters, odd-length value fields, and a backslash creating a second value against an attribute defined as VM 1. ' +
  'Findings land in vrViolations, with vrElementsExamined beside them so "no violations" can be told apart from "nothing was examined"; a match whose octets could not be re-read is listed in vrUnreadable and is never counted as clean. ' +
  'This is an audit of the PEER, not of this tool: a violation here is a finding about what the peer emitted. Off by default, because turning every lookup into a conformance audit buries the answer to the question actually asked.';

/**
 * The injection parameter, said once for both query tools.
 *
 * Deliberately not called `set`: dcm_edit already has a `set` that writes
 * ordinary values into files, and an assistant carrying that habit across
 * would reach for this one to "fix" a query. The name has to be unreachable by
 * accident, because the whole purpose of the parameter is to send something
 * wrong on purpose.
 */
const INJECT_DESCRIPTION =
  'A CONFORMANCE TEST INSTRUMENT: stamp values into the outgoing C-FIND identifier VERBATIM, with no client-side checking of any kind — not the length, not the VR\'s character repertoire, not an enumeration (`dcm find --set`). Given as {"PatientSex": "male", "(0010,1030)": "12.5 kg"}. ' +
  'IT EXISTS TO SEND SOMETHING WRONG ON PURPOSE AND SEE WHAT THE PEER DOES WITH IT. It is never the way to make a query work: if a query is being refused or returning nothing, that is a real answer about the peer or about the matching keys, and stamping a value past the refusal replaces a finding with a guess. A response that looks wrong after an injection is very likely the peer answering exactly what it was asked. ' +
  'Applied last, so it overwrites a default return key or a matching key naming the same attribute, and NOT routed into the Scheduled Procedure Step Sequence the way an ordinary worklist key is — name the path if that is where it belongs, e.g. {"ScheduledProcedureStepSequence/Modality": "ct"}. An unknown or private tag is refused rather than injected, because the encoder would drop it without saying so. ' +
  'This only ever builds a QUERY. It reads; it changes nothing on the peer and writes no file. ' +
  'The identifier is encoded and read back before the association is opened, and the query is REFUSED if any injected value did not survive byte for byte — the dataset writer silently shortens an over-long value, so an over-long AE Title would otherwise leave as a perfectly legal 16-character one and a test written to prove the peer rejects it would pass without ever having asked. Over-long AE, CS, DS, IS and UI values are refused for that reason; LO and PN carry at any length, and lowercase, non-enumerated, non-numeric and backslash-bearing values all go out as typed. ' +
  'Every injection is named in the result, in "injected", so there is no way to run an injected query and get an answer that does not say so.';

/**
 * How a dcm_worklist row becomes a dcm_mpps_perform call.
 *
 * The CLI hands a worklist item to MPPS through a file or a pipe: `dcm find
 * --mwl --json-raw > wl.json`, then `dcm mpps perform --from-worklist wl.json`.
 * Across the MCP boundary there is neither — dcm_worklist's answer lands in the
 * conversation, and nothing here writes anything to disk — so there are two
 * ways across, and they are not equivalent:
 *
 *   worklistRow  an opaque handle minted per row by dcm_worklist and resolved
 *                inside this process back to the attributes that row arrived
 *                with. Nothing is transcribed, and nothing is lost: the four
 *                sequence-valued attributes an N-CREATE echoes back
 *                (ReferencedStudySequence, ScheduledProtocolCodeSequence,
 *                ProcedureCodeSequence, ReferencedPatientSequence) have no
 *                named parameter here and can only travel this way. This is
 *                the one to use.
 *
 *   the table     below: one named parameter per row key, for the case where
 *                 the values are being composed or corrected rather than
 *                 carried, and for a step whose attributes did not come from a
 *                 worklist at all. Lossy by construction — it carries the ten
 *                 scalars and nothing else — which is why the handle exists.
 *
 * The table is emitted once per worklist result rather than once per row: the
 * values are already in `matches`, and copying them a second time would be a
 * second thing to keep in step with the first.
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
  // The whole row, without transcription. Preferred over `parameters`.
  handleParameter: 'worklistRow',
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

// ---- The worklist row store ----------------------------------------------

/**
 * THE WORKLIST ROW HANDLE.
 *
 * The problem it solves: `--from-worklist` takes the raw export
 * (`dcm find --mwl --json-raw`), and refuses the rendered one by name, because
 * rendering turns a sequence into a string and an empty sequence into ''. Over
 * MCP there was no way to produce the accepted form — dcm_worklist's answer is
 * JSON in a conversation, not a file — so an assistant had to retype up to ten
 * scalars per row into the named parameters, and the sequences were simply not
 * reachable at all.
 *
 * So dcm_worklist mints an opaque handle per row and keeps the row here, in
 * memory. dcm_mpps_start and dcm_mpps_perform take the handle back and this
 * module resolves it, in this process, to the attributes that row arrived with.
 *
 * NOTHING IS WRITTEN TO DISK. That is not an implementation detail, it is the
 * rule this tool is built on: no records, single process, in memory. A handle
 * is therefore worth nothing outside this server process, and saying so is part
 * of the contract rather than a caveat.
 *
 * Bounded, because a long session querying a busy worklist would otherwise
 * accumulate every row it ever saw. Eviction is oldest-first, which makes
 * "expired" a real state an assistant can hit — hence resolveWorklistHandle()'s
 * message, which tells it to re-query rather than reconstruct a row from
 * memory of an earlier answer. A reconstructed row is precisely the
 * transcription this whole mechanism exists to remove.
 */
const MAX_WORKLIST_ROWS = 200;

/** handle -> {row, peer, index, of, label, mintedAt}. Insertion-ordered. */
const worklistRows = new Map();

/**
 * A handle refusal. Carried as its own type so the tool handlers can answer
 * with a plain error result instead of letting it reach the command layer,
 * which would report it as a failure of a step that was never attempted.
 */
class HandleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HandleError';
  }
}

/**
 * Drops the sidecar keys, so what is stored is attributes and nothing else.
 *
 * `_elements` rides along on a raw match and is bookkeeping about the octets,
 * not an attribute. src/lib/mpps.js would strip it anyway on the way in — every
 * underscore-prefixed key is dropped there — but storing it would mean holding
 * a per-element sidecar for every row of every query for the life of the
 * process, which is most of the memory for none of the meaning.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function attributesOf(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key.startsWith('_')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Mints a handle for one worklist row.
 *
 * Opaque on purpose: an assistant that could read a Study Instance UID out of
 * the handle would start composing them, and a composed handle names a row
 * nobody queried.
 *
 * @param {Record<string, unknown>} row  The raw attributes, sidecar removed.
 * @param {object} provenance  {peer, index, of, label}
 * @returns {string}
 */
function mintWorklistHandle(row, provenance) {
  const handle = `wlrow_${crypto.randomBytes(9).toString('hex')}`;
  worklistRows.set(handle, { row, ...provenance, mintedAt: new Date().toISOString() });
  // Map iterates in insertion order, so the first key is the oldest.
  while (worklistRows.size > MAX_WORKLIST_ROWS) {
    worklistRows.delete(worklistRows.keys().next().value);
  }
  return handle;
}

/**
 * Resolves a handle, or refuses in a way that says what to do instead.
 *
 * An unknown handle and an evicted one are indistinguishable from here, and
 * saying so is better than picking one: what matters is that both have the same
 * fix and that the fix is NOT to guess at the row's attributes.
 *
 * @param {string} handle
 * @returns {object} The stored record.
 */
function resolveWorklistHandle(handle) {
  const record = worklistRows.get(handle);
  if (record) return record;

  throw new HandleError(
    `worklistRow "${handle}" is not a row this server is holding. Either it was never minted ` +
      'here, or it came from a previous session, or it has aged out — only the last ' +
      `${MAX_WORKLIST_ROWS} rows are kept, and nothing is written to disk, so a handle is ` +
      'worth nothing outside the process that made it.\n\n' +
      'RE-RUN dcm_worklist AND USE A HANDLE FROM THAT ANSWER. Do not rebuild the row from an ' +
      'earlier answer in this conversation: a row reassembled from what was displayed has lost ' +
      'its sequences, and a step built from it would name an order the RIS cannot reconcile. ' +
      'If the row is genuinely gone from the worklist, that is itself the finding.' +
      (worklistRows.size
        ? ` (${worklistRows.size} row handle(s) are currently held.)`
        : ' (No row handles are currently held.)')
  );
}

/**
 * Runs the CLI as a child process with a document on its standard input.
 *
 * This is the one place the MCP layer does not run a command in-process, and
 * the reason is narrow: `--from-worklist -` reads file descriptor 0, and in
 * this process descriptor 0 is the JSON-RPC channel the MCP client is talking
 * over. Reading it would consume protocol bytes and hang the session. A child
 * has its own descriptor 0, which we write the row into and close.
 *
 * The alternative — a temporary file — is the one thing this tool does not do.
 * The row exists in this process's memory, in the pipe, and in the child's
 * memory; it never touches a disk.
 *
 * The result shape is runCommand's, so everything downstream is unchanged.
 * There is no serialisation around it: the capture stack runCommand serialises
 * for is this process's, and a child writes to neither end of it.
 *
 * @param {string[]} argv  Full CLI arguments, e.g. ['mpps', 'perform', ...].
 * @param {string} input  Written to the child's stdin, which is then closed.
 * @returns {Promise<{code:number, out:string, err:string}>}
 */
function runCliWithStdin(argv, input) {
  return new Promise((resolve) => {
    const [command, ...commandArgs] = resolveCliCommand(argv);
    const child = spawn(command, commandArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    child.on('error', (e) => {
      resolve({ code: 1, out, err: `${err}\nCould not run the CLI: ${e.message}`.trim() });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));

    // A verb that refuses before reading the worklist closes descriptor 0 while
    // we are still writing to it. That EPIPE is not the failure — the refusal
    // on stderr is — so it must not become an unhandled error event.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

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

  /**
   * The three fidelity/injection parameters both query tools take.
   *
   * @returns {Record<string, object>}
   */
  const inspectionSchema = () => ({
    raw: z.boolean().optional().describe(RAW_DESCRIPTION),
    checkVr: z.boolean().optional().describe(CHECK_VR_DESCRIPTION),
    injectVerbatim: z.record(z.string(), z.string()).optional().describe(INJECT_DESCRIPTION),
  });

  /**
   * The three assertion parameters both query tools take.
   *
   * They are on the query tools and nowhere else, and that is a decision worth
   * stating: the whole value of an expectation is that a query which never
   * reached the peer CANNOT satisfy it. A refused association, an A-ABORT and a
   * dead host all produce zero rows locally, and only one of the four
   * zero-row cases is a passing test. A local-file tool has no association to
   * fail, and its answer is an array this conversation can count, so the same
   * flags on dcm_inventory or dcm_tags would be ceremony rather than a guard.
   *
   * @returns {Record<string, object>}
   */
  const expectationSchema = () => ({
    expectCount: z.number().int().optional().describe(
      'ASSERT that the peer returns exactly this many matches, and report a failure if it does not (`dcm find --expect-count`). ' +
      'The result still says what actually happened in "outcome"; the expectation is judged separately and appears in "expectation".'),
    expectEmpty: z.boolean().optional().describe(
      'ASSERT that the peer returns NO matches (`dcm find --expect-empty`). ' +
      'THE POINT OF THIS RATHER THAN READING count YOURSELF: a query that never reached the peer does not satisfy it. ' +
      'A refused association, a wrong Called AE Title, an A-ABORT mid-C-FIND and a peer answering 0x0122 all produce zero rows at this end, ' +
      'and "the worklist entry is correctly gone" is a pass while "the tenant lookup failed" is not. ' +
      'When the query did not complete, expectation.evaluated is false, expectation.held is false, and this reports an error — never a satisfied assertion.'),
    expectNonempty: z.boolean().optional().describe(
      'ASSERT that the peer returns at least one match (`dcm find --expect-nonempty`). The natural preflight: prove the query works before drawing a conclusion from a later empty one.'),
  });

  /**
   * Pushes the assertion half of a find argument vector.
   *
   * The three are mutually exclusive and the command refuses two of them with a
   * message naming both, which is better than anything a schema could say, so
   * nothing is resolved here.
   *
   * @param {string[]} argv  Argument vector being built, mutated in place.
   * @param {object} a  Tool arguments.
   */
  const expectationArgv = (argv, a) => {
    opt(argv, '--expect-count', a.expectCount);
    if (a.expectEmpty) argv.push('--expect-empty');
    if (a.expectNonempty) argv.push('--expect-nonempty');
  };

  /**
   * Says what an expectation verdict means, from the fields the command emitted.
   *
   * `evaluated` is the field that matters and the one an assistant will not
   * think to look at, so the unevaluated case gets its own sentence saying it
   * is a failure rather than an empty result.
   *
   * @param {object} p  The parsed document.
   * @returns {string|null}
   */
  /**
   * True when this is a `dcm.result/N` envelope rather than some other JSON.
   *
   * @param {*} parsed
   * @returns {boolean}
   */
  function isEnvelope(parsed) {
    return Boolean(parsed) && typeof parsed === 'object' &&
      typeof parsed.schema === 'string' && parsed.schema.startsWith('dcm.result/');
  }

  /**
   * Presents a query envelope that never got to count anything.
   *
   * The association was refused, the peer aborted, the host was unreachable, or
   * the command line was wrong. jsonResult would throw the document away and
   * hand back the stderr text, which is exactly backwards: `outcome`,
   * `detail.associate`, `detail.transport` and above all
   * `expectation.evaluated` are the fields that tell a refusal apart from an
   * empty answer, and they live nowhere else.
   *
   * @param {object} parsed  The envelope.
   * @param {string} err  Whatever the command said on stderr.
   * @returns {object}  MCP tool result.
   */
  function incompleteQueryResult(parsed, err) {
    const notes = [
      `The query did not complete: outcome "${parsed.outcome}". NOTHING WAS COUNTED, so this is ` +
        'not an empty result and must not be reported as one — a peer that refused the ' +
        'association never answered the question that was asked.',
    ];
    const verdict = expectationNote(parsed);
    if (verdict) notes.push(verdict);
    if (err && err.trim()) notes.push(err.trim());

    return {
      content: [{ type: 'text', text: `${JSON.stringify(parsed, null, 2)}\n\n${notes.join('\n\n')}` }],
      structuredContent: parsed,
      isError: true,
    };
  }

  function expectationNote(p) {
    const e = p.expectation;
    if (!e) return null;

    const want = e.kind === 'nonempty'
      ? 'at least one match'
      : `exactly ${e.expected} match${e.expected === 1 ? '' : 'es'}`;

    if (!e.evaluated) {
      return `EXPECTATION NOT TESTED: ${e.flag} wanted ${want}, but the query never completed, so ` +
        `nothing was counted. This is a FAILURE, not an empty result — outcome "${p.outcome}" says ` +
        'what actually happened, and a query that was refused cannot prove the peer holds nothing.';
    }
    return e.held
      ? `Expectation held: ${e.flag} wanted ${want} and the peer returned ${e.actual}.`
      : `EXPECTATION FAILED: ${e.flag} wanted ${want}; the peer returned ${e.actual}. ` +
        'The query itself completed, so this is a statement about what the peer holds.';
  }

  /**
   * Pushes the fidelity/injection half of a find argument vector, and returns
   * the output flag the caller has to append last.
   *
   * `--json` and `--json-raw` are two different shapes and the command refuses
   * both at once, so exactly one is chosen here rather than in each tool.
   *
   * @param {string[]} argv  Argument vector being built, mutated in place.
   * @param {object} a  Tool arguments.
   * @returns {string} The output flag to push after the matching keys.
   */
  const inspectionArgv = (argv, a) => {
    if (a.checkVr) argv.push('--check-vr');
    // Attached form is not available: `set` is pair-valued in the tokenizer, so
    // the next token is taken as its value even though it looks like a
    // matching key. Two tokens is therefore both correct and repeatable.
    for (const [k, v] of Object.entries(a.injectVerbatim || {})) argv.push('--set', `${k}=${v}`);
    return a.raw ? '--json-raw' : '--json';
  };

  /**
   * Note text for the conformance and injection halves of a query result.
   *
   * Both are recorded in the JSON document by the command itself; this says
   * what they MEAN, which is the part that decides whether an assistant reports
   * a bug in the peer or a bug in its own query.
   *
   * @param {object} p  The parsed document.
   * @returns {string[]}
   */
  function inspectionNotes(p) {
    const notes = [];

    if (Array.isArray(p.vrViolations)) {
      notes.push(
        p.vrViolations.length === 0
          ? `VR conformance: no violations over ${p.vrElementsExamined} element(s) returned. ` +
            'That is a statement about what came back on this query and about nothing else — ' +
            'other queries against the same peer can still return malformed values.'
          : `VR conformance: ${p.vrViolations.length} violation(s) over ` +
            `${p.vrElementsExamined} element(s) returned. These are findings about what the ` +
            'PEER emitted, not about this query. The command exits non-zero on any violation ' +
            'so it can be used as a CI gate.'
      );
      if (p.vrUnreadable && p.vrUnreadable.length) {
        notes.push(
          `${p.vrUnreadable.length} match(es) could not be re-read at the octet level, so no ` +
            'conformance statement is possible for them. They are NOT counted as clean.'
        );
      }
    }

    if (Array.isArray(p.injected) && p.injected.length) {
      notes.push(
        'INJECTED, VERBATIM AND UNCHECKED: ' +
          p.injected.map((i) => `${i.attribute} ${i.tag} = ${JSON.stringify(i.value)}`).join(', ') +
          '. Nothing about these values was validated before they went on the wire. Whatever ' +
          'came back may be the peer answering exactly what it was asked, so read an odd ' +
          'answer as a finding about the peer only after ruling that out.'
      );
    }

    if (p.raw) {
      notes.push(
        'Values are raw: a Decimal or Integer String is the text that arrived rather than a ' +
          'number, and a Person Name is [{"Alphabetic": "..."}] rather than a string. Do not ' +
          'copy a raw PatientName into an MPPS patientName parameter — read .Alphabetic first.'
      );
    }

    return notes;
  }

  // ---- Query -------------------------------------------------------------
  server.registerTool(
    'dcm_query',
    {
      title: 'DICOM C-FIND',
      description:
        'Query a peer for stored studies, series or instances (C-FIND). Note: a peer can accept images and still return zero matches — storing and indexing are separate operations, so zero matches is not proof a transfer failed. For Modality Worklist (what is scheduled, not what is stored) use dcm_worklist instead: the matching keys are a different vocabulary and level "mwl" here gives you no help with them. ' +
        'For testing the peer rather than consuming its data: raw returns values as the octets carried them instead of repaired for reading, checkVr audits what came back for VR conformance violations, injectVerbatim sends a deliberately non-conformant identifier to see how the peer handles it, and expectCount / expectEmpty / expectNonempty turn the query into an assertion that a query which never reached the peer cannot satisfy.',
      inputSchema: {
        ...peerSchema(),
        level: z.enum(['study', 'series', 'image', 'mwl']).optional().describe('Query level (default study). "series" requires StudyInstanceUID; "image" requires StudyInstanceUID and SeriesInstanceUID. "mwl" works but prefer dcm_worklist — it is the one that mints worklist row handles.'),
        keys: z.record(z.string(), z.string()).optional().describe('Matching keys as DICOM keyword→value, e.g. {"PatientID":"12345"}. Values take * and ? wildcards and hyphenated date ranges. An empty value requests the key without matching on it.'),
        limit: z.number().int().optional().describe('Stop after this many matches.'),
        ...inspectionSchema(),
        ...expectationSchema(),
      },
    },
    async (a) => {
      const argv = peerArgv(a);
      if (a.level && a.level !== 'study') argv.push(`--${a.level}`);
      opt(argv, '--limit', a.limit);
      const output = inspectionArgv(argv, a);
      expectationArgv(argv, a);
      for (const [k, v] of Object.entries(a.keys || {})) argv.push(`${k}=${v}`);
      argv.push(output);
      return queryResult(await runCommand('find', argv));
    }
  );

  /**
   * Presents a `dcm find` result for dcm_query.
   *
   * jsonResult drops the document on a non-zero exit, which is wrong for both
   * of the ways this command exits non-zero having answered: zero matches, and
   * a VR violation. The numbers ARE the answer in either case, so
   * the document always survives; the exit code still decides isError, because
   * "did my study arrive" wants a failing result when it did not and a
   * conformance gate wants one when the peer misbehaved.
   *
   * @param {{code:number, out:string, err:string}} result  From runCommand.
   * @returns {object}  MCP tool result.
   */
  function queryResult(result) {
    let parsed;
    try {
      parsed = JSON.parse(result.out);
    } catch {
      return jsonResult(result);
    }
    if (!isEnvelope(parsed)) return jsonResult(result);
    if (typeof parsed.count !== 'number') return incompleteQueryResult(parsed, result.err);

    const notes = inspectionNotes(parsed);
    if (parsed.count === 0) {
      notes.push(
        'Zero matches. A peer can accept instances via C-STORE and still return nothing ' +
          'here — storing and indexing are separate operations — so this is not by itself ' +
          'proof that a transfer failed.'
      );
    }
    const verdict = expectationNote(parsed);
    if (verdict) notes.push(verdict);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(parsed, null, 2) + (notes.length ? `\n\n${notes.join('\n\n')}` : ''),
      }],
      structuredContent: parsed,
      isError: result.code !== 0,
    };
  }

  server.registerTool(
    'dcm_worklist',
    {
      title: 'Modality Worklist (C-FIND MWL)',
      description:
        'Ask a worklist SCP what is SCHEDULED — which patients and procedures are booked on a modality, and when. This is scheduling data, not stored images: a study appearing here has not necessarily been acquired, and one that has been acquired may already have left the worklist. Matching keys are a different vocabulary from a study query (ScheduledProcedureStepStartDate, ScheduledStationAETitle, Modality, ScheduledPerformingPhysicianName, RequestedProcedureDescription, AccessionNumber, PatientID, PatientName) and the scheduling ones belong inside the Scheduled Procedure Step Sequence — the engine places them there for you and flattens them back out in the answer, which is why a hand-built flat worklist query usually returns nothing. An empty worklist is a legitimate answer, not a fault: nothing may be booked for that date, station or modality. Before concluding the SCP is broken, retry with scheduledDate "any" and no other filters to see whether it returns anything at all — or state expectEmpty, which fails rather than passes when the query never reached the peer. ' +
        'EVERY ROW CARRIES A HANDLE, matches[i]._handle, and the handles are listed in order in rowHandles.handles. Pass one as worklistRow to dcm_mpps_perform or dcm_mpps_start and that row becomes the performed step: the handle is resolved inside this server back to the full set of attributes the row arrived with, so nothing is retyped and nothing is dropped — including ReferencedStudySequence, ScheduledProtocolCodeSequence, ProcedureCodeSequence and ReferencedPatientSequence, which no named parameter can carry. Handles live in this server process only and are never written to disk. THIS IS THE WAY TO GO FROM A SCHEDULED ROW TO A PERFORMED STEP. The named parameters still work, still win over the handle when both are given, and are the right tool for correcting a value rather than carrying one; structuredContent.mppsHandoff.parameters is that mapping. ' +
        'When the worklist SCP is the thing UNDER TEST rather than the thing being consumed, checkVr audits what it returned for VR conformance violations and fails on any, raw returns the values as the octets carried them along with the per-element sidecar, injectVerbatim sends a deliberately non-conformant identifier to see how it copes, and the expect parameters turn the query into an assertion. ' +
        'Note that this tool always asks for the octets and renders them for reading unless raw is set, so a value the peer sent malformed is shown as it arrived rather than as a parser would repair it — for a conformant value the two are the same text.',
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
        ...inspectionSchema(),
        ...expectationSchema(),
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
      // ALWAYS --json-raw, whatever `raw` says, because the handle has to hold
      // the row as it arrived. The rendered form is the one --from-worklist
      // refuses by name: it stringifies a sequence and blanks an empty one, so
      // a handle minted from it would carry exactly the attributes an N-CREATE
      // has to echo back, as text a dataset writer cannot encode.
      //
      // What the caller asked for still decides what it is SHOWN — see
      // worklistResult, which renders these same values through find's own
      // display() when raw was not asked for. One query, one association, both
      // answers.
      const output = inspectionArgv(argv, { ...a, raw: true });
      expectationArgv(argv, a);
      for (const [k, v] of pairs) argv.push(`${k}=${v}`);
      argv.push(output);

      return worklistResult(await runCommand('find', argv), a);
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
   * A VR violation is the exception to that leniency. checkVr is asked for
   * precisely so a malformed answer fails, and reporting a run that found
   * violations as a plain success would turn the one parameter meant to be a
   * gate into a parameter that reports and shrugs.
   *
   * A stated expectation is the other exception, and for the same reason:
   * expectEmpty is asked for precisely so that "nothing is scheduled" and "the
   * query never reached the peer" stop being the same result, and reporting a
   * failed expectation as a success would make the parameter decorative.
   *
   * @param {{code:number, out:string, err:string}} result  From runCommand.
   * @param {object} a  Tool arguments, for what the caller asked to be shown.
   * @returns {object}  MCP tool result.
   */
  function worklistResult(result, a) {
    let parsed;
    try {
      parsed = JSON.parse(result.out);
    } catch {
      return jsonResult(result);
    }
    if (!isEnvelope(parsed)) return jsonResult(result);
    // The leniency below is for an empty ANSWER. A query that never reached the
    // peer counted nothing at all, and presenting that as a legitimate empty
    // worklist is the single most expensive mistake this tool could make.
    if (typeof parsed.count !== 'number') return incompleteQueryResult(parsed, result.err);

    const rawMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const shown = presentRows(rawMatches, parsed.peer, Boolean(a && a.raw));

    const notes = inspectionNotes({ ...parsed, raw: Boolean(a && a.raw) });
    notes.push(parsed.count === 0
      ? 'No scheduled procedures matched. That is a legitimate answer — nothing may be ' +
        'booked for this date, station or modality. Re-run with scheduledDate "any" and no ' +
        'other filters before concluding the worklist SCP is at fault. If you need "the ' +
        'schedule really is empty" to be distinguishable from "the query never reached the ' +
        'peer", state expectEmpty: a refused association does not satisfy it.'
      : 'To report what was performed against one of these rows, pass its handle: ' +
        `dcm_mpps_perform { worklistRow: "${shown.handles[0] ?? 'matches[i]._handle'}", folder: ..., host, port, calledAe }. ` +
        'The handle is resolved here, in memory, to every attribute that row arrived with — ' +
        'including the sequences that have no named parameter — so nothing has to be restated ' +
        'and nothing is lost. Handles are valid for the life of this server process only and ' +
        'are written nowhere; if one is refused, re-run this query rather than rebuilding the ' +
        'row by hand. The named parameters (structuredContent.mppsHandoff.parameters) still ' +
        'work and override the handle, which is how a value the worklist got wrong is ' +
        'corrected.');

    const verdict = expectationNote(parsed);
    if (verdict) notes.push(verdict);

    // Additive: `count` and `matches` keep the shape every existing consumer
    // reads. `raw` is reported as what the caller is looking at rather than as
    // what went on the wire — the query is always raw now, and a document
    // claiming raw values while showing rendered ones would be the more
    // misleading of the two.
    const structured = {
      ...parsed,
      raw: Boolean(a && a.raw),
      matches: shown.rows,
      ...(rawMatches.length ? { rowHandles: shown.block, mppsHandoff: MPPS_HANDOFF } : {}),
    };

    const violations = Array.isArray(parsed.vrViolations) ? parsed.vrViolations.length : 0;
    const expectationFailed = Boolean(parsed.expectation) && parsed.expectation.held !== true;
    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) + `\n\n${notes.join('\n\n')}` }],
      structuredContent: structured,
      isError: violations > 0 || expectationFailed,
    };
  }

  /**
   * Mints a handle per row and produces the rows to show.
   *
   * The rendering is find's own: `display()` is required from the command
   * rather than reimplemented, and the loop is the one find's own `--json`
   * branch runs, so the two cannot drift into two different ideas of what a
   * Person Name looks like.
   *
   * One consequence worth knowing, and it is an improvement rather than a
   * surprise: these values are rendered from the OCTETS. Where a peer sent
   * something a parser would quietly repair — PatientWeight as "12.5 kg" —
   * the repair no longer happens on the way to a rendered row, so what is shown
   * is what arrived. For a conformant value the two are identical.
   *
   * @param {Array<object>} rawMatches  Rows exactly as --json-raw produced them.
   * @param {object|undefined} peer  The envelope's peer block, for provenance.
   * @param {boolean} wantsRaw
   * @returns {{rows: Array<object>, handles: string[], block: object}}
   */
  function presentRows(rawMatches, peer, wantsRaw) {
    const { display } = require('../find');

    const rows = [];
    const handles = [];

    rawMatches.forEach((raw, i) => {
      const attributes = attributesOf(raw);
      const rendered = {};
      for (const [key, value] of Object.entries(attributes)) rendered[key] = display(value);

      const handle = mintWorklistHandle(attributes, {
        peer: peer ?? null,
        index: i + 1,
        of: rawMatches.length,
        label:
          `${rendered.PatientName || '(no name)'} · Accession ${rendered.AccessionNumber || '(none)'} · ` +
          `Study ${rendered.StudyInstanceUID || '(none)'}`,
      });
      handles.push(handle);

      // On the row itself, where an assistant is already looking, and
      // underscore-prefixed like `_elements` because it is not an attribute.
      // That prefix is load-bearing rather than cosmetic: every consumer of a
      // worklist item in this repo — src/lib/mpps.js, src/lib/worklist.js,
      // find's own renderer — drops underscore keys, so a handle cannot be
      // re-encoded as a DICOM element even if the whole row is fed back in.
      rows.push({ ...(wantsRaw ? raw : rendered), _handle: handle });
    });

    return {
      rows,
      handles,
      block: {
        parameter: 'worklistRow',
        acceptedBy: ['dcm_mpps_perform', 'dcm_mpps_start'],
        handles,
        resolvedServerSide: true,
        lifetime:
          'this MCP server process only. Nothing is written to disk, and the last ' +
          `${MAX_WORKLIST_ROWS} rows minted are kept; older ones are refused with a message ` +
          'saying to re-query.',
      },
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
        chunk: z.number().int().optional().describe('Instances per association (default 200). One number for the whole run: it overrides the per-study size a speed preset would derive. Converting or rewriting holds parsed datasets in memory, which CAPS a size this tool derived — a size you typed is left as typed.'),
        retry: z.number().int().optional().describe('Retry attempts for a chunk where fewer instances came back acknowledged than were sent (default 1). The retries carry no backoff, so they are spent within milliseconds of the first failure — a larger number buys more attempts, not more time.'),
        parallel: z.number().int().optional().describe('Associations to run at once, 1-16 (default 1). C-STORE is sequential inside one association, so concurrency is the only real lever on throughput — but raising THIS alone does not widen the run: achieved width is min(parallel, chunks) and chunks is ceil(instances / chunk), so at the default chunk of 200 a 400-instance study runs 2 wide however high this goes. Prefer speed, which sizes the chunks to match. Either way, check what the receiver allows: exceeding its limit gets associations rejected rather than speeding anything up.'),
        speed: z.enum(['normal', 'fast', 'very-fast', 'insane']).optional().describe('Preset that picks the parallelism AND a chunk size that can actually deliver it, which is the trap raising parallel alone falls into. normal is 1 association: ordinary clinical traffic, and the only setting that adds nothing to the receiver\'s association count. fast is 4: a backlog or a migration, to a receiver known to tolerate a handful at once. very-fast is 8: a bulk move on a link with the bandwidth for the concurrency to pay. insane is 16, a BENCHMARK setting for a receiver you own — not production traffic, and not a thing to point at someone else\'s archive. The ceiling is not ours to set: the receiver decides how many associations it accepts, and going past its limit gets them REJECTED rather than queued, which can leave instances unacknowledged rather than speed anything up. Ask what it allows before reaching past fast. An explicit parallel or chunk beats this preset, and the run warns when it does. Read parallelAchieved afterwards: it is MEASURED, and it is a floor across studies that errs downward, so one 3-instance study beside a large one pins it to 1 for the whole run.'),
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
      // Both are passed when both are given, rather than one being suppressed
      // here: the command is where that contest is resolved, and it warns on
      // stderr when a typed number displaces the preset's. Deciding it in this
      // layer would swallow the warning, which is the only thing that tells a
      // caller the run was not configured the way the preset name says.
      opt(argv, '--speed', a.speed);
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

  /**
   * The injection parameter on the two N-CREATE verbs.
   *
   * Whether an assistant should be able to send a deliberately non-conformant
   * MPPS at all is the one real judgement call in this module, so the reasoning
   * is here rather than only in a report:
   *
   * FOR. Coercion is a property only the peer can answer, and it cannot be
   * asked any other way. Does the SCP truncate a 20-character
   * PerformedStationAETitle or refuse it? Does it accept a lowercase Code
   * String? Does it accept an EMPTY Type 1 and then never reconcile the step —
   * the exact silent failure this whole command group exists to make visible?
   * Every one of those is a question about a system NewLumen's CI points at,
   * and the CLI can already ask them. Withholding it over MCP would not make
   * the malformed N-CREATE unsendable; it would only make it unaskable by the
   * one participant that is going to be asked to test the server.
   *
   * AGAINST, and it is not small. Unlike the C-FIND injection, THIS WRITES. An
   * N-CREATE puts a record into a RIS, and an assistant that reached for this
   * to get past a refusal would write a deliberately malformed clinical record
   * into a live system while believing it had fixed something.
   *
   * SO: offered on dcm_mpps_start and dcm_mpps_perform, where it reaches the
   * N-CREATE, and NOT on dcm_mpps_update, dcm_mpps_complete or
   * dcm_mpps_discontinue, where it would reach the N-SET. That line is not
   * squeamishness about the N-SET; it is that PerformedProcedureStepStatus
   * lives there, and a parameter that can stamp COMPLETED into the closing
   * message is a way to assert that work is fully accounted for when the tool
   * knows it is not. dcm_mpps_perform refusing to say COMPLETED on a shortfall
   * is the rule this group is built on, and no parameter here may offer a way
   * round it. On perform the injection reaches the N-CREATE only, so that rule
   * is untouched. The CLI still has --set on all five verbs for someone who has
   * read what it does.
   */
  const MPPS_INJECT_DESCRIPTION =
    'A CONFORMANCE TEST INSTRUMENT, AND IT WRITES: stamp values into the outgoing N-CREATE dataset VERBATIM, with no client-side checking of any kind — ' +
    'not the length, not the VR\'s character repertoire, not an enumeration, not whether a UID is a UID (`dcm mpps --set`). Given as {"PerformedStationAETitle": "STATION-NAME-FAR-TOO-LONG"} or {"ScheduledStepAttributesSequence/StudyInstanceUID": "not-a-uid"}. ' +
    'IT EXISTS TO SEND SOMETHING WRONG ON PURPOSE AND SEE HOW THE SERVER COERCES IT — does it truncate an over-long AE Title or refuse it, does it take a lowercase Code String, does it accept an EMPTY Type 1 and then never reconcile the step. That last one is the silent failure this whole tool group exists to expose, and it cannot be asked any other way. ' +
    'IT IS NEVER THE WAY TO MAKE A REFUSED STEP GO THROUGH. A refusal is a real answer about the peer or about the attributes; stamping a value past it replaces a finding with a fabricated record in someone\'s RIS. Unlike a query, this MESSAGE CREATES A CLINICAL RECORD ON THE FAR END — one that a person will later see attached to a patient. ' +
    'Applied last, so it overwrites what the named parameters and the worklist row produced, and NOT routed into ScheduledStepAttributesSequence the way a scheduled-step attribute is — name the path if that is where it belongs. An unknown or private tag is refused rather than injected, because the encoder would drop it without saying so. ' +
    'THE LOCAL TYPE 1 CHECK IS LIFTED FOR EXACTLY THE ATTRIBUTES NAMED HERE, and for no others: {"Modality": ""} really does go out present-and-empty, while every attribute you did not name is still checked, so an accidental empty Type 1 stays impossible. ' +
    'The dataset is encoded and read back BEFORE any association is opened, including on a dry run, and the call is REFUSED if an injected value did not survive byte for byte — the writer silently shortens an over-long value, so an over-long AE Title would otherwise leave as a perfectly legal 16-character one and a test written to prove the server rejects it would pass without ever having asked. ' +
    'Every injection is named in the result under "injected". Reaches the N-CREATE only; the closing N-SET is deliberately out of reach, because a parameter that could stamp PerformedProcedureStepStatus into it would be a way to claim COMPLETED for work this tool knows was not fully acknowledged.';

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
      'Study Instance UID — StudyInstanceUID from the dcm_worklist row. Type 1 inside ScheduledStepAttributesSequence, and THE correlation key: the RIS ties the step to the order and to the images on this and little else. dcm_mpps_perform takes it from the folder when the folder holds exactly one study and this is not given. When it is given and the folder disagrees, the call is refused by default and the refusal names the two ways forward — adoptWorklistIdentity, which stamps this UID onto a copy of the images the way a modality does, and allowStudyMismatch, which sends them as they are and accepts that nothing will reconcile. Neither is chosen for you. ' +
      'When NO order lies behind the work at all, this is not the parameter to leave blank — a present-but-empty Type 1 is the shape SCPs accept and then never reconcile. Use unscheduled, which emits the zero-length scheduled step PS3.3 defines for exactly that. On dcm_mpps_start, studyUids carries several when one step fulfils several scheduled steps.'),
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
    mppsUid: z.string().optional().describe('Use this MPPS SOP Instance UID rather than generating one. Either way the UID is returned, and it remains the only handle on the step: nothing here writes it down and MPPS has no query service, so keep it if the step will be updated or closed by a later call.'),
    worklistRow: z.string().optional().describe(
      'AN OPAQUE ROW HANDLE FROM dcm_worklist — matches[i]._handle, also listed in order in rowHandles.handles. THIS IS THE WAY TO TURN A SCHEDULED ROW INTO A PERFORMED STEP. ' +
      'The handle is resolved inside this MCP server back to every attribute that row arrived with and handed to the command as the worklist item, so nothing is transcribed and nothing is guessed. ' +
      'It carries what the named parameters above CANNOT: ReferencedStudySequence, ScheduledProtocolCodeSequence, ProcedureCodeSequence and ReferencedPatientSequence have no parameter here, and an N-CREATE that drops them is a step the RIS has less to reconcile on than it should. ' +
      'The named parameters still win over it, attribute by attribute, which is how a value the worklist got wrong is corrected without abandoning the rest of the row. ' +
      `Handles live in THIS SERVER PROCESS ONLY — nothing about them is written to disk, and the last ${MAX_WORKLIST_ROWS} minted are kept. ` +
      'An unknown or aged-out handle is refused with a message telling you to re-run dcm_worklist; do NOT rebuild the row from an earlier answer in the conversation, because a row reassembled from what was displayed has lost exactly the sequences the handle exists to carry. ' +
      'Cannot be combined with fromWorklist, which names a different worklist.'),
    fromWorklist: z.string().optional().describe(
      'Path to a JSON file of worklist attributes on this machine, as written by `dcm find --mwl --json-raw` (its "matches" array is read directly), or a bare array, or an object with an "items" array. ' +
      'It is NOT the output of dcm_worklist or `dcm find --mwl --json`: that form is rendered for people to read, which turns sequences into strings, and it is refused by name rather than sent malformed. ' +
      'Over MCP prefer worklistRow, which carries the same attributes from a query you just ran with no file involved. Use this one for a fixture file that already exists on disk. ' +
      'Named parameters win over anything in the file. A file holding several rows must be narrowed — by studyUid, accessionNumber, worklistIndex or worklistFirst — because a performed procedure step describes exactly one.'),
    worklistIndex: z.number().int().optional().describe(
      'Which row of fromWorklist to take, numbered from 1 as the refusal that lists them numbers them. It counts the rows LEFT AFTER studyUid and accessionNumber have filtered, not the rows in the file. Refused without fromWorklist, and refused alongside worklistFirst — which is worklistIndex 1.'),
    worklistFirst: z.boolean().optional().describe(
      'Take the first row of fromWorklist, for a query written to return exactly one. Refused without fromWorklist. Note that the default refusal when a file holds several rows is deliberate: a step quietly attributed to the wrong order looks identical to a correct one.'),
    injectVerbatim: z.record(z.string(), z.string()).optional().describe(MPPS_INJECT_DESCRIPTION),
  });

  /**
   * Builds the attribute half of an mpps argument vector, and the standard
   * input the command will need if a row handle was given.
   *
   * @param {object} a  Tool arguments.
   * @returns {{argv: string[], stdin: string|undefined, row: object|undefined}}
   * @throws {HandleError} When the handle is unknown, or contradicts fromWorklist.
   */
  const stepPlan = (a) => {
    const argv = [];
    let stdin;
    let row;
    let handle;

    // First, so the explicit parameters below override what the worklist
    // carries — the same precedence the CLI has.
    if (a.worklistRow !== undefined && a.worklistRow !== '') {
      if (a.fromWorklist) {
        throw new HandleError(
          'worklistRow and fromWorklist name two different worklists, and a performed procedure ' +
            'step describes one scheduled step. Give one: worklistRow for a row from a ' +
            'dcm_worklist answer, fromWorklist for a file on this machine.'
        );
      }
      if (a.worklistIndex !== undefined || a.worklistFirst) {
        throw new HandleError(
          'worklistRow already names one row, so there is nothing for worklistIndex or ' +
            'worklistFirst to pick from. Those two select a row out of a fromWorklist FILE; ' +
            'to perform a different scheduled row, pass that row\'s own handle.'
        );
      }
      handle = a.worklistRow;
      row = resolveWorklistHandle(handle);
      // The shape `dcm find --mwl --json-raw` writes, which is what
      // --from-worklist reads, so the handle path and the shell pipeline
      // NewLumen's CI uses are the same code on the far side.
      stdin = JSON.stringify({ matches: [row.row] });
      argv.push('--from-worklist', '-');
    } else {
      opt(argv, '--from-worklist', a.fromWorklist);
      opt(argv, '--index', a.worklistIndex);
      if (a.worklistFirst) argv.push('--first');
    }

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
    // Accepted by start and perform alike, and refused by both alongside
    // studyUid or fromWorklist — those say an order exists, this says none
    // does, and resolving that here would be picking one on the caller's
    // behalf. Described separately on each tool, because what it does to the
    // C-STORE differs between them.
    if (a.unscheduled) argv.push('--unscheduled');

    // Last, which is also where the command applies them: --set overwrites
    // whatever the flags and the worklist produced. Two tokens rather than the
    // attached form, because `set` is pair-valued in the tokenizer and the
    // token after it is taken as its value.
    for (const [k, v] of Object.entries(a.injectVerbatim || {})) argv.push('--set', `${k}=${v}`);

    return { argv, stdin, row, handle };
  };

  /**
   * Turns a HandleError into a tool result, and lets anything else through.
   *
   * A refused handle is a mistake in the call, not a failure of a procedure
   * step: nothing was sent, no step was opened, and reporting it through
   * mppsResult would produce a document describing a transaction that never
   * started.
   *
   * @param {Error} err
   * @returns {object|null} A tool result, or null if this is not ours.
   */
  function handleFailure(err) {
    if (!(err instanceof HandleError)) return null;
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }

  /**
   * Runs an mpps verb, through a child process when a row has to reach it on
   * standard input.
   *
   * @param {string[]} argv  Arguments after `mpps`, e.g. ['perform', folder, ...].
   * @param {string|undefined} stdin
   * @returns {Promise<{code:number, out:string, err:string}>}
   */
  function runMpps(argv, stdin) {
    if (stdin === undefined) return runCommand('mpps', argv);
    return runCliWithStdin(['mpps', ...argv], stdin);
  }

  /**
   * What --unscheduled means, for the half of the description both tools share.
   */
  const UNSCHEDULED_SHAPE =
    'Report work that NO ORDER LIES BEHIND — a walk-in, an ER exam, a repeat nobody booked. ' +
    'On the wire this is not an omitted or blanked-out scheduled step: ScheduledStepAttributesSequence is PRESENT and holds exactly ONE ZERO-LENGTH item, which is how PS3.3 C.4.14 represents "there was no order". All three of the obvious alternatives are wrong and each is wrong differently — omitting the sequence fails a Type 1 check, an empty studyUid is the present-but-blank Type 1 that SCPs accept and then never reconcile, and an item carrying seven blank attributes is not a zero-length item. ' +
    'Inside a POPULATED item StudyInstanceUID stays Type 1 and is still checked; the exemption covers the zero-length shape and nothing else. ' +
    'Refused together with studyUid or fromWorklist, which say the opposite. Nothing reconciles an unscheduled step against an order, because there is no order: the receiving system has only PerformedProcedureStepID and the station AE to file it under, and what it does with it is not visible from here.';

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
          `{ mppsUid: "${p.mppsSopInstanceUid}" }. That call will carry no performed series: ` +
          'the ledger of what the archive acknowledged lives in the process that did the ' +
          'sending and is written nowhere, and seriesFrom would assert what is in the folder ' +
          'rather than what the archive took. Re-running dcm_mpps_perform is the way to get ' +
          'an honest performed series.'
      );
    } else if (!p.ok && p.message) {
      notes.push(p.message);
    }

    // The command says both of these on stderr, which is where a person reads
    // them and is nowhere an assistant reads them: only the JSON document
    // survives into a tool result. Without these two the difference between
    // "the images were made to match the order" and "the images were sent under
    // a study nothing will reconcile" is a pair of fields nobody reads.
    if (p.restamp) {
      notes.push(
        (p.dryRun
          ? `Would send a re-stamped COPY of the folder carrying ${p.restamp.attributes.join(', ')} `
          : `The images sent were a re-stamped COPY of the folder carrying ${p.restamp.attributes.join(', ')} `) +
          `from the order${p.restamp.stagingDir ? `, staged at ${p.restamp.stagingDir}` : ''}. ` +
          `The source folder at ${p.restamp.source} is not modified, and ` +
          `${p.restamp.unchangedByDesign.join(' and ')} are left exactly as the equipment minted ` +
          'them — they belong to the acquisition rather than to the order.' +
          (p.restamp.privateElementsNotCarried
            ? ` The dataset writer did not carry ${p.restamp.privateElementsNotCarried} private ` +
              'or unrecognised element(s) across, which is a property of that writer and not of ' +
              'this step; standard attributes and pixel data are intact. If what you are testing ' +
              'depends on a private tag, allowStudyMismatch is the path that sends the original bytes.'
            : '')
      );
    }

    if (p.studyUidMismatch && p.allowStudyMismatch) {
      notes.push(
        `${p.dryRun ? 'WOULD SEND' : 'SENT'} IMAGES UNDER A STUDY THE STEP DOES NOT NAME. The ` +
          `step names ${p.studyUidMismatch.declared}; the images carry ` +
          `${p.studyUidMismatch.onDisk}. An archive files images by the Study Instance UID inside ` +
          'them and a RIS reconciles the step by the one in the step, so these two will very ' +
          'likely never be reconciled: the step sits open against a study that has no images, ' +
          'and the images land under a study that has no step. adoptWorklistIdentity is the ' +
          'parameter that makes them agree; this run was asked not to.'
      );
    }

    // The interim N-SET. `statusSent` is emitted by that verb and by no other,
    // on both the dry-run and the live path.
    //
    // These two sentences are the whole reason the verb has two shapes, and the
    // command says them on stdout where a person reads them and nowhere an
    // assistant does: under --json only the document survives into a tool
    // result. Without them "the sequence was not sent" and "the sequence was
    // sent empty" look like the same answer, and they are opposites.
    if (p.statusSent !== undefined) {
      notes.push(
        p.statusSent
          ? 'The update carried PerformedProcedureStepStatus IN PROGRESS, re-asserting that the ' +
            'step is running. That is the shape a watchdog on the far end reads as a sign of life.'
          : 'The update carried NO PerformedProcedureStepStatus — the attribute is absent from ' +
            'the dataset, not empty — so the receiver keeps whatever status it holds. The step ' +
            'is still open either way; no end date or time was sent.'
      );

      if (p.performedSeriesSent && p.seriesCount === 0) {
        notes.push(
          'PerformedSeriesSequence WAS SENT AND IS EMPTY. N-SET replaces rather than appends, ' +
            'so this ERASED whatever performed series the step held. Omit seriesFrom to leave ' +
            'them alone.'
        );
      } else if (p.performedSeriesSent) {
        notes.push(
          `PerformedSeriesSequence carried ${p.seriesCount} series and REPLACED the one the step ` +
            'held — N-SET does not append. The next update has to carry these again alongside ' +
            'anything new, or they are lost. Point seriesFrom at the growing folder each time ' +
            'and it stays cumulative for you.'
        );
      } else {
        notes.push(
          'PerformedSeriesSequence was NOT SENT, so whatever the step already held is untouched. ' +
            'An absent sequence is not an empty one and must not be read as erasing anything — ' +
            'that is the point of leaving seriesFrom off.'
        );
      }

      if (!p.ok) {
        notes.push(
          'The step is whatever the SCP held before this ran, which this end cannot see. An ' +
            'interim update is the message a receiver is least likely to have been tested ' +
            'against, so a refusal here — on a step a closing N-SET would take cleanly — is a ' +
            'finding about the peer rather than about this call. If the refusal was 0x0106 on ' +
            'the status, retry with omitStatus true: some receivers accept only the ' +
            'status-absent shape, and knowing which one a peer takes is itself the result.'
        );
      }
    }

    if (p.interimUpdates) {
      const { attempted, accepted, failures } = p.interimUpdates;
      notes.push(
        `Interim updates at chunk boundaries: ${accepted} of ${attempted} accepted.` +
          (failures && failures.length
            ? ` Refused: ${failures.join('; ')}. A refused progress report does NOT stop the ` +
              'transfer and does not affect the numbers above — the images are the work, the ' +
              'update is a report about it, and the closing N-SET still carried the full ' +
              'sequence. These refusals are findings about the peer.'
            : '')
      );
    }

    if (p.assertedFromDisk) {
      notes.push(
        'The performed series above were built by scanning a local folder. Nothing here ' +
          'confirms the archive holds those instances — they were not sent by this call and ' +
          'nobody acknowledged them. The MPPS now asserts they exist.'
      );
    }

    if (p.unscheduled) {
      notes.push(
        'This step is UNSCHEDULED: ScheduledStepAttributesSequence is one zero-length item and ' +
          'the step names no study, so nothing will reconcile it against an order — there is no ' +
          'order.' +
          // Two names for one value: the live document calls the folder's study
          // imagesStudyInstanceUid, the dry-run document calls it
          // studyInstanceUid. Read both rather than say nothing on a dry run,
          // which is the one place this divergence is most worth explaining.
          ((p.imagesStudyInstanceUid || p.studyInstanceUid)
            ? ` The images ${p.dryRun ? 'would be' : 'were'} filed under ${p.imagesStudyInstanceUid || p.studyInstanceUid}, which is the folder's own ` +
              'Study Instance UID and is what the archive and any later query use. The step and ' +
              'the images diverge here on purpose.'
            : '')
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
   * @param {object} [plan]  From stepPlan(), when a worklist row was resolved.
   * @returns {object}  MCP tool result.
   */
  function mppsResult(result, plan) {
    let parsed;
    try {
      parsed = JSON.parse(result.out);
    } catch {
      // A usage error is refused before anything is sent and never prints a
      // document; its message is the whole answer.
      return textResult(result);
    }

    const notes = [];
    // Which row became this step, first, because it is the first thing anyone
    // asks when a step is attributed to the wrong order — and with a handle
    // there is no file left anywhere to go back and look at. The command's own
    // document records the source as "standard input", which is true and says
    // nothing about which row that was.
    const structured = plan && plan.row
      ? { ...parsed, worklistRow: rowProvenance(plan) }
      : parsed;
    if (plan && plan.row) {
      notes.push(
        `Step attributes came from worklist row ${plan.row.index} of ${plan.row.of} — ` +
          `${plan.row.label} — queried at ${plan.row.mintedAt}` +
          (plan.row.peer ? ` from ${plan.row.peer.calledAe} at ${plan.row.peer.host}:${plan.row.peer.port}` : '') +
          '. The handle was resolved in this server and the whole row was handed to the command, ' +
          'so nothing was retyped and the sequence-valued attributes travelled with it.'
      );
    }

    const note = mppsNote(parsed);
    if (note) notes.push(note);

    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) + (notes.length ? `\n\n${notes.join('\n\n')}` : '') }],
      structuredContent: structured,
      isError: parsed.ok !== true,
    };
  }

  /**
   * The provenance block for a step built from a row handle.
   *
   * The row itself is deliberately not copied in: it is already the step's
   * attributes, and a second copy would be a second thing to keep in step with
   * the first.
   *
   * @param {object} plan  From stepPlan().
   * @returns {object}
   */
  function rowProvenance(plan) {
    return {
      handle: plan.handle,
      index: plan.row.index,
      of: plan.row.of,
      label: plan.row.label,
      queriedAt: plan.row.mintedAt,
      queriedFrom: plan.row.peer,
      resolvedServerSide: true,
      writtenToDisk: false,
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
        'WHEN THE IMAGES DO NOT CARRY THE WORKLIST\'S STUDY INSTANCE UID this is refused by default, because the step would name one study and the images would belong to another and the archive would never reconcile them. That is the normal state of affairs when rehearsing a worklist against stock or phantom images, and adoptWorklistIdentity is the answer to it: it stamps the worklist\'s identity onto a COPY of the images, which is exactly what a real modality does with a UID the RIS invented before the patient was on the table. allowStudyMismatch is the other way past the refusal and means something quite different — send them as they are and accept that nothing reconciles. Neither is implied by any other parameter. ' +
        'TAKE THE STEP ATTRIBUTES FROM A dcm_worklist ROW BY PASSING ITS HANDLE as worklistRow (matches[i]._handle). The handle is resolved inside this server to every attribute the row arrived with, sequences included, so nothing is retyped; the named parameters below still work, still override it, and are the way to correct a value rather than carry one. ' +
        'To exercise the whole loop locally with no PACS, start dcm_receiver_start with a worklist file and point both the MPPS and the storage side at it — and to see what this does when the far end misbehaves, arm that receiver with refuseNCreate, refuseNSet or rejectAfter, which is how a genuine shortfall and a genuine refusal are produced rather than imagined. Use dryRun to see the N-CREATE without connecting, including the re-stamp that would be applied. ' +
        'Two paths worth knowing about: updateEachChunk sends an interim N-SET at each chunk boundary carrying only what the archive has acknowledged so far, and unscheduled reports work no order lies behind, where the step names no study but the C-STORE still uses the folder\'s own.',
      inputSchema: {
        folder: z.string().describe('Folder of DICOM files that were produced. Must hold exactly one study: a performed procedure step describes one study, and Study Instance UID is what the RIS reconciles on. adoptWorklistIdentity does not relax this — stamping one identity onto two studies would merge them into a study that never existed, so a folder holding several is refused and has to be split.'),
        ...peerSchema(),
        storeHost: z.string().optional().describe('Archive hostname. Default: host. MPPS and storage are frequently different systems — a RIS or broker takes the step, an archive takes the images — and the result says which peer took what.'),
        storePort: z.number().int().optional().describe('Archive DIMSE port. Default: port.'),
        storeCalledAe: z.string().optional().describe("The archive's AE Title. Default: calledAe."),
        ...stepSchema(),
        chunk: z.number().int().optional().describe('Instances per storage association (default 200).'),
        retry: z.number().int().optional().describe('Retries for a chunk that came back with fewer acknowledgements than it sent (default 1).'),
        retrieveAe: z.string().optional().describe('Retrieve AE Title recorded against each performed series — where the images can be fetched from. Default: the archive AE they were sent to.'),
        adoptWorklistIdentity: z.boolean().optional().describe(
          'Send a re-stamped COPY of the folder carrying the identity the order gave it: StudyInstanceUID, and unless studyUidOnly also PatientID, PatientName, PatientBirthDate, PatientSex, AccessionNumber and StudyID wherever the worklist supplies them. THIS IS WHAT A REAL MODALITY DOES. The RIS invents the Study Instance UID before the patient is on the table; the images cannot already carry it, and the modality stamps it onto everything it acquires. So this is not an override of the mismatch check — it is the normal behaviour the check was pointing at, and it is the right answer for rehearsing a worklist against stock or phantom images, because the step and the images then name the same study and the archive reconciles them, which is the thing being rehearsed. ' +
          'THE SOURCE FOLDER IS NEVER MODIFIED: every file is opened read-only, the copy goes to a staging directory, and the staging path is reported so what went on the wire can be inspected. Attributes the worklist leaves blank are not stamped — a blank means the RIS did not say, and writing it over what the images carry would destroy information rather than adopt any. Series and SOP Instance UIDs are deliberately never re-stamped: they belong to the equipment that produced the images rather than to the order, and re-minting them would break the relationships the images already have and make a resend look like a second acquisition. ' +
          'One real cost: the copy is written by the same dataset writer dcm_edit and dcm_anon use, and that writer does not carry private tags across — a Siemens MR instance measured here went from 216 elements to 119. Standard attributes and pixel data survive intact and the number of dropped elements is reported. If what you are testing depends on a private tag, allowStudyMismatch is the path that sends the original bytes. Nothing else turns this on.'),
        studyUidOnly: z.boolean().optional().describe('With adoptWorklistIdentity, stamp only StudyInstanceUID and leave the images\' own patient attributes alone. For when the demographics on the images are the ones you want to keep and only the correlation key has to agree. Refused on its own: with nothing being stamped there is nothing for it to narrow.'),
        staging: z.string().optional().describe('Where the re-stamped copy is written. A fresh subdirectory is created inside it for each run, so the cleanup afterwards can only remove what that run made. Default: the OS temp directory. Refused unless adoptWorklistIdentity is set, because otherwise no copy is made.'),
        keepStaging: z.boolean().optional().describe('Keep the staged copy after a run that ended COMPLETED, to inspect the bytes that went on the wire. A copy from a run that ended any other way is kept regardless. Refused unless adoptWorklistIdentity is set.'),
        allowStudyMismatch: z.boolean().optional().describe(
          'Open the step against the worklist\'s study and send the images unchanged, under the different study they carry. THE ARCHIVE WILL VERY LIKELY NEVER RECONCILE THE STEP WITH THE IMAGES: an archive files images by the Study Instance UID inside them and a RIS reconciles the step by the one in the step, so the step sits open against a study that has no images while the images land under a study that has no step, and no later action joins them up. ' +
          'This is the explicit "I know what I am doing" path. It exists because it is also the only one that sends the ORIGINAL BYTES, private tags and all, which re-stamping cannot. It is not implied by any other parameter, and it cannot be combined with adoptWorklistIdentity, which asks for the opposite. If the goal is a rehearsal that behaves like the real thing, adoptWorklistIdentity is the one you want.'),
        unscheduled: z.boolean().optional().describe(
          `${UNSCHEDULED_SHAPE} ` +
          'HERE THE C-STORE STILL USES THE FOLDER\'S OWN STUDY INSTANCE UID. The images keep the study they carry and are sent under it, because that is what the archive files them by and what a later query finds them under; only the STEP names no study. So the two identities diverge on purpose, and the result prints both — imagesStudyInstanceUid is the folder\'s, stepStudyInstanceUid is null. A run where they differ silently is exactly the run nobody can debug afterwards, which is why it is said in the result rather than only here. ' +
          'The folder must still hold exactly one study; unscheduled does not relax that.'),
        updateEachChunk: z.boolean().optional().describe(
          'Send an interim N-SET at every chunk boundary except the last, carrying PerformedProcedureStepStatus IN PROGRESS and the performed series built from what the archive has ACKNOWLEDGED SO FAR — never from what is still queued and never from a folder listing, so the same honesty rule as the closing N-SET, applied earlier. Default off. ' +
          'What it is for: a transfer of 412 instances at chunk 200 spans three associations and by default sends no MPPS traffic between them, so a receiver watching for signs of life sees nothing for the whole transfer. This is how you exercise that path. Not sent after the last chunk, because the closing N-SET follows immediately with the same sequence. ' +
          'A REFUSED INTERIM UPDATE DOES NOT STOP THE TRANSFER and does not change whether the step ends COMPLETED: the images are the work, an update is a progress report about it. Refusals are counted and named in interimUpdates. A peer that refuses the status-bearing shape with 0x0106 is a finding about that peer: the message is conformant, and dcm_receiver_start accepts it.'),
        endDate: z.string().optional().describe('YYYYMMDD the step ended. Default: now, local time.'),
        endTime: z.string().optional().describe('HHMMSS the step ended. Default: now, local time.'),
        dryRun: z.boolean().optional().describe('Scan the folder and return the N-CREATE that would be sent, along with the re-stamp that would be applied and any study-UID mismatch. Opens no connection, creates no step, sends no images and writes no copy.'),
        recurse: z.boolean().optional().describe('Recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      let plan;
      try {
        plan = stepPlan(a);
      } catch (err) {
        const refused = handleFailure(err);
        if (refused) return refused;
        throw err;
      }

      const argv = ['perform', a.folder, ...peerArgv(a), ...plan.argv];
      opt(argv, '--store-host', a.storeHost);
      opt(argv, '--store-port', a.storePort);
      opt(argv, '--store-called-ae', a.storeCalledAe);
      opt(argv, '--chunk', a.chunk);
      opt(argv, '--retry', a.retry);
      opt(argv, '--retrieve-ae', a.retrieveAe);

      // Passed straight through, never inferred from one another: the command
      // refuses studyUidOnly, staging and keepStaging without
      // adoptWorklistIdentity, and refuses adoptWorklistIdentity together with
      // allowStudyMismatch, and those refusals are the point. Turning one on
      // because another was set would decide, on the caller's behalf, whether
      // the images or the order wins — which is the whole question.
      if (a.adoptWorklistIdentity) argv.push('--adopt-worklist-identity');
      if (a.studyUidOnly) argv.push('--study-uid-only');
      opt(argv, '--staging', a.staging);
      if (a.keepStaging) argv.push('--keep-staging');
      if (a.allowStudyMismatch) argv.push('--allow-study-mismatch');
      if (a.updateEachChunk) argv.push('--update-each-chunk');

      opt(argv, '--end-date', a.endDate);
      opt(argv, '--end-time', a.endTime);
      if (a.dryRun) argv.push('--dry-run');
      if (a.recurse === false) argv.push('--no-recurse');
      argv.push('--json');

      return mppsResult(await runMpps(argv, plan.stdin), plan);
    }
  );

  server.registerTool(
    'dcm_mpps_start',
    {
      title: 'Open a procedure step (MPPS N-CREATE)',
      description:
        'Tell an MPPS SCP that work has begun on a scheduled study: N-CREATE with status IN PROGRESS. Returns the MPPS SOP Instance UID it generated in mppsSopInstanceUid, which is the ONLY handle on the step. KEEP IT: nothing here writes it down — this tool holds no records of any kind — and MPPS has no query service, so a UID that is lost cannot be recovered from this tool or from the SCP, and the step can then never be closed. ' +
        'Use this only when the images are sent by something else, or when the step has to stay open while other work happens; dcm_mpps_perform does start, store and close as one transaction and is the usual choice. ' +
        'Every Type 1 attribute is checked here before anything goes on the wire, and a missing one is refused by name. That is not belt and braces: many SCPs accept an N-CREATE carrying an empty Type 1, answer success, and then never reconcile the step against the order, so from this end it looks like it worked and days later the order is still open. ' +
        'A step opened here can be refreshed while it runs with dcm_mpps_update (an interim N-SET, which leaves it open) and must eventually be closed with dcm_mpps_complete or dcm_mpps_discontinue. Two shapes are reachable from here that a scheduled study does not need: unscheduled, for work no order lies behind, and studyUids, for one step that fulfils several scheduled steps. ' +
        'To open a step against a scheduled row, pass that row\'s handle as worklistRow: it is resolved inside this server to every attribute the row arrived with, including the sequences no named parameter here can carry. ' +
        'Opening a step says nothing about the worklist entry — whether the SCP moves the scheduled step to ARRIVED or STARTED is its business and is not visible from here.',
      inputSchema: {
        ...peerSchema(),
        ...stepSchema(),
        unscheduled: z.boolean().optional().describe(
          `${UNSCHEDULED_SHAPE} ` +
          'Nothing is sent by this tool, so there is no second identity to diverge from: the step simply names no study. If images follow later from dcm_send, they keep their own Study Instance UID and the archive files them under it.'),
        studyUids: z.array(z.string()).optional().describe(
          'Several Study Instance UIDs, when ONE performed step fulfils SEVERAL scheduled steps — a chest and an abdomen booked separately and acquired in one pass. PS3.3 represents that as several items in ScheduledStepAttributesSequence, and this emits one populated item per UID, in the order given (studyUid, if also set, is the first). ' +
          'ONLY THE FIRST ITEM carries accessionNumber, scheduledStepId and the requested-procedure attributes: there is one of each here, and copying an accession onto every item would assert that different orders share it. The rest are emitted as the empty Type 2 attributes they are. ' +
          'Cannot be combined with fromWorklist, where studyUid is the selector that narrows the file to one item, nor with unscheduled. dcm_mpps_perform refuses several UIDs entirely — it sends one folder, and one folder is one study — so a grouped step is opened here, sent with dcm_send, and closed with dcm_mpps_complete.'),
        dryRun: z.boolean().optional().describe('Build and return the N-CREATE dataset without connecting.'),
      },
    },
    async (a) => {
      let plan;
      try {
        plan = stepPlan(a);
      } catch (err) {
        const refused = handleFailure(err);
        if (refused) return refused;
        throw err;
      }

      const argv = ['start', ...peerArgv(a), ...plan.argv];
      // After the step arguments, so an explicit studyUid stays item 1 and the
      // order here is the order the sequence comes out in. The CLI accumulates
      // repeated --study-uid into one item each; nothing needs deduplicating,
      // because two identical UIDs would be two identical orders and the
      // operator is the one who can say whether that was meant.
      for (const uid of a.studyUids || []) opt(argv, '--study-uid', uid);
      if (a.dryRun) argv.push('--dry-run');
      argv.push('--json');
      return mppsResult(await runMpps(argv, plan.stdin), plan);
    }
  );

  server.registerTool(
    'dcm_mpps_update',
    {
      title: 'Report progress on a running step (interim MPPS N-SET)',
      description:
        'Refresh a procedure step that is still running WITHOUT closing it: an interim N-SET. This is what a modality sends part-way through a long acquisition — the series performed so far, and a step that is still IN PROGRESS. No end date and no end time are sent, because the step has not ended. Use dcm_mpps_complete or dcm_mpps_discontinue to close it; this verb cannot, and re-sending an interim update against an already-closed step is refused by the SCP. ' +
        'The two things it is for: telling the far end the device is still alive on a step that would otherwise be silent for the whole acquisition, and GROWING PerformedSeriesSequence as more series are acquired. ' +
        'PERFORMED SERIES REPLACE, THEY DO NOT APPEND. N-SET is attribute-level replacement (PS3.4 F.7.2), so an update naming only the series acquired since the last one does not add them — it ERASES the earlier ones. Every update has to carry the CUMULATIVE sequence, which is what pointing seriesFrom at a growing folder does for you. ' +
        'OMITTING seriesFrom IS NOT THE SAME AS SENDING AN EMPTY ONE AND MUST NOT BE READ AS ERASING ANYTHING. With seriesFrom left off, PerformedSeriesSequence is absent from the dataset entirely and whatever the step already holds survives untouched — that is the default, and it is what "report progress, do not restate the performed series" means. A seriesFrom folder that scans to nothing is the opposite: a PRESENT, EMPTY sequence, which wipes what the step holds. That case is warned about loudly in the result. ' +
        'TWO WIRE SHAPES, BOTH LEGAL AND BOTH COMMON, and a receiver that handles one and not the other fails in production rather than in testing — which is why both are reachable here. By default the update carries PerformedProcedureStepStatus IN PROGRESS, re-asserting the step is running. With omitStatus the attribute is ABSENT from the dataset entirely, which tells the receiver "these attributes changed, the step is still running" and leaves its own status alone. ' +
        'BOTH SHAPES ARE REHEARSABLE against dcm_receiver_start, which accepts the status-bearing update and the status-absent one — and dcm_receiver_start { refuseNSet: "0x0106" } makes it REFUSE the interim while still allowing the close, so the failure below can be driven against a real association instead of imagined. Against a real peer, try both: this is exactly the message receivers are least likely to have been tested against, and a 0x0106 on the status-bearing shape is a real finding — PS3.4 F.7.2-1 lists PerformedProcedureStepStatus among the attributes an N-SET may carry, and a receiver that refuses it is why modalities give up mid-exam and leave a worklist entry uncleared. ' +
        'An update cannot change what the step IS. Patient identity, the scheduled step and its Study Instance UID, PerformedProcedureStepID, the station AE, the start date and time and the modality are all N-CREATE-only; the parameters that would carry them are not offered here, and an end date or time is refused because an end time on a step still reporting IN PROGRESS is a contradiction some receivers resolve by closing the step under you. ' +
        'As with every verb here, what the SCP then does with the scheduled procedure step is not visible from this end.',
      inputSchema: {
        mppsUid: z.string().describe('The MPPS SOP Instance UID returned by dcm_mpps_start or dcm_mpps_perform. Required, and there is no way around it: this tool keeps no records, so there is no directory to pick a step out of, and MPPS has no query service, so the SCP cannot be asked what it is holding either.'),
        ...peerSchema(),
        seriesFrom: z.string().optional().describe(
          'Build the CUMULATIVE PerformedSeriesSequence by scanning this folder. Point it at the folder the acquisition is filling and successive updates carry a growing sequence, which is what the replace-not-append rule requires. ' +
          'IT ASSERTS WHAT IS ON YOUR DISK, NOT WHAT THE ARCHIVE HOLDS — a local folder can contain instances the archive refused, never received, or rejected as duplicates, and naming one of those in an MPPS is a fabricated record that everything downstream believes. The result says so every time. The honest version is dcm_mpps_perform with updateEachChunk, which sends the images itself and names only what the archive acknowledged at each chunk boundary. ' +
          'LEAVE IT OFF and PerformedSeriesSequence is not sent at all and the step keeps what it holds. That is the default and it erases nothing.'),
        retrieveAe: z.string().optional().describe('Retrieve AE Title recorded against each performed series — the AE the images can be fetched from.'),
        omitStatus: z.boolean().optional().describe(
          'Send NO PerformedProcedureStepStatus at all — the attribute is ABSENT from the dataset, which is not the same as present-and-empty. Default false, which sends IN PROGRESS. ' +
          'Both shapes are legal and receivers branch on them differently, so exercise both. Note that omitStatus with no seriesFrom would be an N-SET carrying nothing whatever, and is refused locally rather than sent: add seriesFrom, or drop omitStatus for the keep-alive shape.'),
        dryRun: z.boolean().optional().describe('Build and return the interim N-SET dataset without connecting. The clearest way to see the difference between the two shapes before sending either.'),
        recurse: z.boolean().optional().describe('With seriesFrom, recurse into subfolders (default true).'),
      },
    },
    async (a) => {
      const argv = ['update'];
      // Positional, and it must precede the flags the tokenizer reads.
      if (a.mppsUid !== undefined && a.mppsUid !== '') argv.push(String(a.mppsUid));
      argv.push(...peerArgv(a));

      opt(argv, '--series-from', a.seriesFrom);
      opt(argv, '--retrieve-ae', a.retrieveAe);
      if (a.omitStatus) argv.push('--no-status');
      if (a.dryRun) argv.push('--dry-run');
      if (a.recurse === false) argv.push('--no-recurse');
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
    mppsUid: z.string().describe('The MPPS SOP Instance UID returned by dcm_mpps_start or dcm_mpps_perform. Required, and there is no way around it: this tool keeps no records, so there is no directory to pick a step out of, and MPPS has no query service, so the SCP cannot be asked what it is holding either.'),
    ...peerSchema(),
    seriesFrom: z.string().optional().describe('Build PerformedSeriesSequence by scanning this folder. It is the ONLY source this tool has here, and IT ASSERTS WHAT IS ON YOUR DISK, NOT WHAT THE ARCHIVE HOLDS — a local folder can contain instances the archive refused, never received, or rejected as duplicates, and naming one of those in an MPPS is a fabricated record. The result says plainly that the sequence was asserted from disk. Only the process that did the C-STORE knows what the archive actually acknowledged and that is written nowhere, so when the performed series matters use dcm_mpps_perform, which sends the images and closes the step in one go. Omit this and the step is closed naming no images at all. A folder holding more than one study is REFUSED rather than merged — see studyUid.'),
    studyUid: z.string().optional().describe(
      'Narrow seriesFrom to this one study, for a folder that holds more than one. A performed procedure step describes a SINGLE study, so a sequence built from two would attribute half the images to the wrong order, and anything downstream that totals ReferencedImageSequence into an expected image count would get a number the step\'s own scheduled attributes contradict — with nothing in the N-SET showing it. So such a folder is refused unless this names which study the step performed. ' +
      'It SCOPES; it does not re-stamp anything and it does not change what the step names. Refused when the UID is malformed, when the folder does not hold that study (refused rather than closed with an empty sequence), and when given without seriesFrom. With a single-study folder it is unnecessary.'),
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

    opt(argv, '--series-from', a.seriesFrom);
    opt(argv, '--study-uid', a.studyUid);
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
        'Close a step left open by dcm_mpps_start, refreshed by any number of dcm_mpps_update calls, or left open by a dcm_mpps_perform whose closing N-SET failed: N-SET to COMPLETED. ' +
        'COMPLETED asserts that the work finished and is fully accounted for. The only performed-series source this tool has here is seriesFrom, which scans a folder and therefore asserts what is on your disk rather than what the archive holds — the result labels that plainly. Completing without it is legal DICOM and warns, because it claims the work finished and names no images at all. Only the process that did the C-STORE knows what the archive acknowledged, and that is written nowhere, so when the performed series matters use dcm_mpps_perform instead. ' +
        'The step is named by its UID and by nothing else: no records are kept, so there is no listing to pick it out of. ' +
        'Note that this tool does not re-check the transfer: it sets the status you asked for. dcm_mpps_perform is the verb that refuses to say COMPLETED when instances are unaccounted for, because it is the one that did the sending and knows. ' +
        'Closing the step here says nothing about the worklist entry. Whether the SCP or a RIS behind it then retires the scheduled step is its own business; query dcm_worklist if you need to know, and read the disappearance as correlation rather than as proof.',
      inputSchema: { ...finishSchema() },
    },
    async (a) => mppsResult(
      await runCommand('mpps', [...finishArgv('complete', a), '--json'])
    )
  );

  server.registerTool(
    'dcm_mpps_discontinue',
    {
      title: 'Close a procedure step as DISCONTINUED (MPPS N-SET)',
      description:
        'Close a step that did not finish: N-SET to DISCONTINUED. This is the honest ending for an abandoned or partial acquisition, and it is what dcm_mpps_perform sets by itself when the archive did not acknowledge every instance. It is also the right ending for a step dcm_mpps_update kept alive and nothing ever completed — a step left IN PROGRESS forever is worse for the receiving system than one explicitly discontinued. As with dcm_mpps_complete, the step is named by its UID and by nothing else, and seriesFrom is the only performed-series source — a folder scan, labelled as one. ' +
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
