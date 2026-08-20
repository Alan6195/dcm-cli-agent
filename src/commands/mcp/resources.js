'use strict';

/**
 * MCP resources and prompts — the reference material that makes an assistant
 * drive this engine correctly rather than guessing at it.
 *
 * Two kinds of thing live here:
 *
 *   Resources  Read-only reference text. The bulk of it is each command's own
 *              USAGE string, served verbatim. USAGE is what `dcm <cmd> --help`
 *              prints, so it is the authoritative description of that command's
 *              flags — serving it (rather than a hand-written summary) means
 *              the resource cannot drift from the code. A flag added to a
 *              command shows up here on the next read, with no edit to this
 *              file. Alongside those sits a troubleshooting resource compiled
 *              from README.md and the CHANGELOG: the operational traps that
 *              cost real time, which no usage text would tell you.
 *
 *   Prompts    Parameterised workflows. Each one encodes an order of operations
 *              that is easy to get wrong — verifying a peer, reading a failed
 *              transfer's numbers, moving a study between DIMSE and DICOMweb —
 *              and names only tools that this server actually registers.
 *
 * Every command module is required lazily, inside the read callback. That is
 * not just startup thrift: `dcm mcp` itself is one of the commands documented
 * here, and src/commands/mcp.js requires this module at load time, so a
 * top-level require('../mcp') would resolve to a half-initialised module whose
 * USAGE is still undefined. Reading it at request time sidesteps the cycle.
 */

/**
 * The commands whose USAGE is exposed, in the order the index lists them.
 *
 * `slug` becomes the URI path (dcm://usage/<slug>), `command` is what a person
 * would type, and `load` returns the module so USAGE is read at request time.
 */
const USAGE_SOURCES = [
  {
    slug: 'echo',
    command: 'dcm echo',
    load: () => require('../echo'),
    summary: 'C-ECHO a peer: does it answer, and does it accept our calling AE Title?',
  },
  {
    slug: 'send',
    command: 'dcm send',
    load: () => require('../send'),
    summary: 'C-STORE a folder to a peer, chunked, with found/sent/acknowledged accounting.',
  },
  {
    slug: 'scp',
    command: 'dcm scp',
    load: () => require('../scp'),
    summary: 'Run a local DIMSE receiver — a loopback test target with failure injection.',
  },
  {
    slug: 'find',
    command: 'dcm find',
    load: () => require('../find'),
    summary: 'C-FIND a peer at study, series, image or worklist level.',
  },
  {
    slug: 'info',
    command: 'dcm info',
    load: () => require('../info'),
    summary: 'Inventory a folder: studies, series, modalities, counts, sizes, transfer syntaxes.',
  },
  {
    slug: 'tags',
    command: 'dcm tags',
    load: () => require('../tags'),
    summary: 'Dump and filter the DICOM tags in a file or folder.',
  },
  {
    slug: 'edit',
    command: 'dcm edit',
    load: () => require('../edit'),
    summary: 'Set or remove tags, writing edited copies to a new folder.',
  },
  {
    slug: 'anon',
    command: 'dcm anon',
    load: () => require('../anon'),
    summary: 'Copy a folder with identifiers removed and UIDs remapped (best-effort).',
  },
  {
    slug: 'web',
    command: 'dcm web',
    load: () => require('../web'),
    summary: 'The DICOMweb family and its shared connection/authentication rules.',
  },
  {
    slug: 'web/ping',
    command: 'dcm web ping',
    load: () => require('../web/ping'),
    summary: 'Is there a DICOMweb service at this URL, and do the credentials open it?',
  },
  {
    slug: 'web/send',
    command: 'dcm web send',
    load: () => require('../web/send'),
    summary: 'STOW-RS a folder, settled against the server’s own STOW response.',
  },
  {
    slug: 'web/query',
    command: 'dcm web query',
    load: () => require('../web/query'),
    summary: 'QIDO-RS at study, series or instance level.',
  },
  {
    slug: 'web/retrieve',
    command: 'dcm web retrieve',
    load: () => require('../web/retrieve'),
    summary: 'WADO-RS a study, series or instance into a local folder.',
  },
  {
    slug: 'web/serve',
    command: 'dcm web serve',
    load: () => require('../web/serve'),
    summary: 'Run a local DICOMweb hub — the web mirror of dcm scp.',
  },
  {
    slug: 'mcp',
    command: 'dcm mcp',
    load: () => require('../mcp'),
    summary: 'This server: how it is launched and where DICOMweb credentials come from.',
  },
];

/** URI of the resource that lists everything else. */
const INDEX_URI = 'dcm://usage';

/** URI of the compiled operational-traps resource. */
const TROUBLESHOOTING_URI = 'dcm://troubleshooting';

/**
 * Operational knowledge compiled from README.md's troubleshooting section, the
 * "Why it behaves the way it does" section, and the CHANGELOG entries that
 * record where the guidance was corrected after a real gateway disproved it.
 *
 * Kept as literal text rather than parsed out of README.md: the package ships
 * without its README in some install paths, and a resource that silently
 * returns nothing is worse than one that is reviewed by hand.
 */
const TROUBLESHOOTING = `
dcm — operational traps
=======================

Failure modes that have actually been hit against real gateways, and what each
one does and does not tell you. Compiled from README.md and the CHANGELOG.


A good C-ECHO does not prove you may store
------------------------------------------
C-ECHO proves the peer answers and accepts your calling AE Title for a
verification association. Whether it will accept a C-STORE, and whether your AE
Title is permitted to query, are separate server-side decisions. Permission to
store and permission to query are frequently configured separately, so having
one is no evidence of the other.

The DICOMweb equivalent: a successful \`dcm web ping\` proves the URL answers
and the credentials open it. It is not a storage grant.


Association rejected, reason 3
------------------------------
    [A-ASSOCIATE-RJ result=1 source=1 reason=3]

Your *calling* AE Title is not allowlisted on the far end. This is a
configuration entry someone has to add on the receiving side; no amount of
retrying or flag-fiddling changes it. Send whoever runs the peer the exact
value you pass to --calling-ae along with your source IP. AE Titles are
case-sensitive and capped at 16 characters.

THE TRAP: some gateways allowlist the CALLING AET rather than matching on the
called one. When that is how the peer is configured, the AE Title they gave you
belongs in --calling-ae, not --called-ae. If reason 3 persists with what you
were told is the right AE Title, try it in the other slot:

    dcm echo --host pacs.example.org --port 11112 \\
      --called-ae THEIR-AET --calling-ae THEIR-AET

Reason codes are only meaningful together with the source, so the translation
is looked up on the (result, source, reason) triple. Reason 3 from a
service-PROVIDER source is not a defined value at all. The raw code is always
printed next to the explanation.

Reason 3 is by far the most common failure in the field.


Association rejected, reason 7
------------------------------
"Called AE Title not recognized". You reached a real DICOM service but asked
for a name it does not answer to. One host can serve several AE Titles on one
port — check --called-ae.


C-FIND returns 0x0122, or zero matches, for images you know arrived
-------------------------------------------------------------------
    error the peer refused the query: 0x0122 SOP Class not supported

A successful C-STORE means the peer ACCEPTED your images. It does not mean it
can be queried for them, and plenty of gateways cannot be queried at all.

THE TRAP: a production store-and-forward gateway was observed accepting images
with 0x0000, accepting the Study Root Query/Retrieve FIND presentation context
during negotiation, and then answering the query itself with 0x0122. So
--verbose shows a negotiation that looks completely healthy while the query
still fails — advertising a presentation context is not a promise to implement
the service behind it. This is why the 0x0122 guidance names two causes rather
than sending you straight to --verbose.

Zero matches is the quieter version of the same thing. Store-and-forward
receivers return zero C-FIND matches for data they have accepted and not yet
indexed or forwarded — storing and indexing are separate, and zero matches is
not proof a transfer failed.

If images are being accepted but cannot be found: query whichever system is
actually meant to hold them rather than the one you sent to, give it time to
process, and check your AE Title is permitted to query as well as to store.


It sent, but fewer instances arrived than were sent
---------------------------------------------------
That is what the three numbers — found, sent, acknowledged — are for, and why
a shortfall exits non-zero rather than reading as success. Every file found on
disk must end the run with exactly one recorded outcome: acknowledged, warning,
failed, unreadable, unanswered, or not attempted. Anything with no outcome is
reported as unaccounted and fails the run.

Read the per-instance status codes in the report:

  0x0000          success
  0xB000-0xBFFF   warning — the receiver rewrote your data. Not success.
  0xA700          out of resources; usually transient, worth a retry
  (no response)   a stall; the association was taken and then went quiet
  unreadable      the file never parsed off disk in the first place

Codes from attempts that were later retried are kept in the report too, so a
receiver that is struggling stays visible even when the run eventually
succeeds. A chunk that comes back under-acknowledged is retried automatically
(default once) with only the outstanding instances before the run is called
failed.

The association result on its own tells you almost nothing: a peer will
happily accept the association and then refuse individual instances.


Timeouts are not rejections
---------------------------
A rejection is an answer; a timeout is silence. Different causes, different
fixes, so they never share a message. Timeouts are reported by phase —
connect, negotiation, or mid-transfer stall. An abort is a third thing again:
the association was accepted and then torn down.


DICOMweb 404 on ping
--------------------
Most servers root DICOMweb under a path prefix, commonly /dicom-web. A 404
usually means the base URL is missing that prefix, not that the server is down:

    https://pacs.example.org             wrong
    https://pacs.example.org/dicom-web   right

Connection refused on a DICOMweb URL is usually the other direction of the same
mistake — DICOMweb lives on the HTTP(S) port, not on 11112.


DICOMweb credentials
--------------------
They come from the environment the server was launched with and nowhere else:
DCM_WEB_TOKEN for a bearer token, or DCM_WEB_USER and DCM_WEB_PASS for HTTP
Basic. There is no flag and no config file, so nothing lands in shell history —
and over MCP it means a token never travels through the assistant's
conversation. A 401 names the variable to set, never a value.

If a 401 comes back, the fix is for the person running the server to set that
variable in its environment and restart it. Do not ask for the token itself.


Partial DICOMweb transfers
--------------------------
web send settles each instance from the server's own STOW response:
ReferencedSOPSequence is acknowledged, FailedSOPSequence is failed with the
reason code translated, and an instance the server did not mention at all is
recorded as unanswered rather than silently dropped. A shortfall exits
non-zero, exactly as over DIMSE.


--rewrite-series-uid changes what you send
------------------------------------------
It replaces Series Instance UIDs, so the receiver stores data that is no longer
identical to the source. It also forces each dataset to be parsed, which drops
the chunk size automatically. Use it deliberately, not as a retry tactic.


When something is wrong on the wire
-----------------------------------
--verbose logs the whole association negotiation: every proposed and accepted
presentation context, the transfer syntax each settled on, and the peer's
implementation class UID and version. It is the first thing to reach for — with
the 0x0122 caveat above, where a healthy-looking negotiation is exactly the
misleading part.


Exit codes
----------
  0   Done, nothing lost.
  1   Ran but did not fully succeed, including an accepted-but-lossy transfer.
  2   Bad command line.

The 0/1 split is deliberately strict: 823 found and 822 acknowledged exits 1.
`.trimStart();

/**
 * Build the index resource's text from USAGE_SOURCES, so it cannot list a
 * resource that is not registered or omit one that is.
 *
 * @returns {string}  Plain-text index of every resource this module exposes.
 */
function buildIndex() {
  const width = USAGE_SOURCES.reduce((n, s) => Math.max(n, s.slug.length), 0) + 8;
  const lines = USAGE_SOURCES.map((s) => `  ${`dcm://usage/${s.slug}`.padEnd(width + 12)}${s.command} — ${s.summary}`);
  return [
    'dcm — reference resources',
    '=========================',
    '',
    "Each usage resource is the command's own --help text, read from the command",
    'module at request time, so it always matches the installed engine.',
    '',
    lines.join('\n'),
    '',
    `  ${TROUBLESHOOTING_URI}`,
    '      Operational traps compiled from README.md and the CHANGELOG: what a',
    '      rejection reason means, why a successful store can still return zero',
    '      query matches, and which results prove less than they appear to.',
    '',
    'Prompts (workflows, fetched by name with arguments):',
    '  verify-a-peer               echo → dry-run send → query, and how to read each result',
    '  diagnose-a-failed-transfer  walk found/sent/acknowledged and status codes to a cause',
    '  mirror-a-study              move a study between a DIMSE peer and a DICOMweb server',
    '',
  ].join('\n');
}

/**
 * Wrap plain text as a resource read result.
 *
 * The registered URI is echoed back verbatim rather than the parsed URL's href,
 * so what the client asked for is exactly what it is told it got.
 *
 * @param {string} uri  The resource's registered URI.
 * @param {string} text  Body to return.
 * @returns {{contents: object[]}}
 */
function textResource(uri, text) {
  return { contents: [{ uri, mimeType: 'text/plain', text }] };
}

/**
 * Wrap prompt body text as a single user message.
 *
 * @param {string} description  One-line description echoed back with the prompt.
 * @param {string} text  The prompt body.
 * @returns {{description: string, messages: object[]}}
 */
function userPrompt(description, text) {
  return {
    description,
    messages: [{ role: 'user', content: { type: 'text', text: text.trim() } }],
  };
}

/**
 * Register the reference resources and workflow prompts on an MCP server.
 *
 * @param {object} server  The McpServer to register on.
 * @param {object} z  The zod module (loaded lazily by the mcp command).
 * @param {object} rt  The MCP runtime ({runCommand, textResult, jsonResult, opt, ...}).
 * @returns {void}
 */
function register(server, z, rt) {
  // ---- Resources ---------------------------------------------------------
  server.registerResource(
    'usage-index',
    INDEX_URI,
    {
      title: 'Reference index',
      description: 'Every usage resource and prompt this server exposes, with a one-line summary of each.',
      mimeType: 'text/plain',
    },
    async () => textResource(INDEX_URI, buildIndex())
  );

  for (const source of USAGE_SOURCES) {
    const uri = `dcm://usage/${source.slug}`;
    server.registerResource(
      `usage-${source.slug.replace('/', '-')}`,
      uri,
      {
        title: `${source.command} usage`,
        description: `${source.summary} This is the command's own --help text, read from the installed module, so it cannot drift from its actual flags.`,
        mimeType: 'text/plain',
      },
      // Required inside the callback, not at module load: `dcm mcp` is one of
      // the commands listed here and src/commands/mcp.js requires this module,
      // so a top-level require would see a half-initialised module.
      async () => textResource(uri, source.load().USAGE)
    );
  }

  server.registerResource(
    'troubleshooting',
    TROUBLESHOOTING_URI,
    {
      title: 'Operational traps',
      description:
        'What association rejection reasons mean, why a successful store can still return zero query matches, and which results prove less than they appear to. Compiled from this project’s README and CHANGELOG, not from general DICOM lore.',
      mimeType: 'text/plain',
    },
    async () => textResource(TROUBLESHOOTING_URI, TROUBLESHOOTING)
  );

  // ---- Prompts -----------------------------------------------------------
  server.registerPrompt(
    'verify-a-peer',
    {
      title: 'Verify a DICOM peer',
      description:
        'Full connectivity check against a DIMSE peer — echo, a dry-run send, then a query — with what each result does and does not prove.',
      argsSchema: {
        host: z.string().describe('Peer hostname or IP.'),
        port: z.string().describe('Peer DIMSE port, e.g. 11112.'),
        calledAe: z.string().describe("The peer's AE Title."),
        callingAe: z.string().optional().describe('Our AE Title (default DCM-CLI).'),
        folder: z.string().optional().describe('Optional folder to plan a dry-run send from.'),
      },
    },
    (a) =>
      userPrompt(
        `Verify ${a.calledAe} at ${a.host}:${a.port}`,
        `
Verify the DICOM peer ${a.calledAe} at ${a.host}:${a.port}${a.callingAe ? `, calling as ${a.callingAe}` : ''}.
Work through these steps in order and report what each one establishes. Read
dcm://troubleshooting before interpreting any failure.

1. dcm_echo — host ${a.host}, port ${a.port}, calledAe ${a.calledAe}${a.callingAe ? `, callingAe ${a.callingAe}` : ''}.
   Success proves the peer answers and accepted this calling AE Title for a
   verification association. It does NOT prove storage is permitted.
   If it is rejected with reason 3, the calling AE Title is not allowlisted on
   the far end — and check the trap where the gateway allowlists the CALLING
   AET, so the AE Title you were given belongs in callingAe as well.
   Reason 7 means the called AE Title is wrong, not the calling one.
   Silence rather than a rejection is a timeout: a different problem.

${
  a.folder
    ? `2. dcm_send with dryRun true — path ${a.folder}, same connection details.
   This scans the folder and prints the plan without opening a connection, so
   it confirms the files parse and shows how many instances and associations a
   real send would involve. It proves nothing about the peer.`
    : `2. dcm_send with dryRun true against a folder of DICOM files, if one is
   available. It scans and prints the plan without connecting, confirming the
   files parse and how many instances a real send would involve. Ask which
   folder to use rather than guessing at a path.`
}

3. dcm_query — same connection details, level study, no keys or a wide key.
   A result set proves the peer answers C-FIND for this AE Title. Zero matches
   proves very little: storing and indexing are separate, and permission to
   query is often configured separately from permission to store. 0x0122 can
   arrive even when negotiation looked healthy.

Then state plainly which of these three the peer supports for this AE Title,
and name anything still unproven — in particular, do not report "verified" as
though storage has been confirmed unless a real store has actually run.
`
      )
  );

  server.registerPrompt(
    'diagnose-a-failed-transfer',
    {
      title: 'Diagnose a failed transfer',
      description:
        'Walk the found / sent / acknowledged numbers and the per-instance status codes of a transfer report toward a cause.',
      argsSchema: {
        report: z.string().describe('The transfer report or error output, pasted verbatim.'),
        host: z.string().optional().describe('Peer host, if a follow-up check should be run.'),
        port: z.string().optional().describe('Peer DIMSE port.'),
        calledAe: z.string().optional().describe("The peer's AE Title."),
        callingAe: z.string().optional().describe('The calling AE Title that was used.'),
      },
    },
    (a) =>
      userPrompt(
        'Diagnose a failed DICOM transfer',
        `
Diagnose this transfer. Read dcm://troubleshooting first — it names the traps
that make these reports misleading.

--- report ---
${a.report}
--- end report ---

Work in this order:

1. The three numbers. Found is what was on disk, sent is what left, acknowledged
   is what the receiver confirmed. Say which gap you are looking at:
   - found > sent: files that never left. Usually unreadable on disk, or the
     run stopped early. Check with dcm_inventory over the same folder.
   - sent > acknowledged: the receiver took them and did not confirm them all.
     That is the receiver's answer, not a local problem.
   - anything unaccounted: a file with no recorded outcome. Report it as such.
   A shortfall of one instance is still a failure; the exit code is 1 by design.

2. The per-instance status codes, if the transfer got that far.
   0xB000-0xBFFF are warnings — the receiver rewrote the data. Not success.
   0xA700 is out of resources, usually transient; a retry is reasonable.
   No response at all is a stall, not a refusal.
   Codes from retried attempts are in the report too, so a struggling receiver
   stays visible even in a run that eventually succeeded.

3. If the association never formed, translate the rejection with its source,
   not the reason alone. Reason 3 (service-user) is the calling AE Title not
   being allowlisted, including the trap where the gateway allowlists the
   CALLING AET. Reason 7 is the called AE Title. A timeout is silence, not a
   rejection, and is reported by phase: connect, negotiation, or mid-transfer.

4. Only then propose a next action.${
          a.host && a.port && a.calledAe
            ? ` A dcm_echo to ${a.host}:${a.port} calledAe ${a.calledAe}${a.callingAe ? ` callingAe ${a.callingAe}` : ''} separates "the peer is unreachable or rejecting us" from "the peer accepted the association and refused instances".`
            : ' A dcm_echo to the same peer separates "unreachable or rejecting us" from "accepted the association and refused instances" — ask for the connection details if they are not in the report.'
        }
   Do not conclude the transfer failed because a follow-up query returns
   nothing: storing and indexing are separate, and a gateway can accept images
   it will never answer a query about.

Finish with a single sentence naming the most likely cause and who has to act —
us, or whoever runs the peer.
`
      )
  );

  server.registerPrompt(
    'mirror-a-study',
    {
      title: 'Mirror a study between DIMSE and DICOMweb',
      description:
        'Move one study between a DIMSE peer and a DICOMweb server using the right tools in the right order, with verification at each end.',
      argsSchema: {
        direction: z
          .enum(['web-to-dimse', 'dimse-to-web'])
          .describe('web-to-dimse retrieves over WADO-RS then C-STOREs; dimse-to-web reads a local folder then STOWs.'),
        studyUid: z.string().describe('StudyInstanceUID of the study to move.'),
        webUrl: z.string().describe('DICOMweb base URL, including any path prefix such as /dicom-web.'),
        workDir: z.string().describe('Absolute path of a local folder to stage the study in.'),
        host: z.string().optional().describe('DIMSE peer hostname or IP.'),
        port: z.string().optional().describe('DIMSE peer port.'),
        calledAe: z.string().optional().describe("The DIMSE peer's AE Title."),
        callingAe: z.string().optional().describe('Our AE Title.'),
      },
    },
    (a) => {
      const peer = `${a.host || '<host>'}:${a.port || '<port>'} calledAe ${a.calledAe || '<calledAe>'}${
        a.callingAe ? ` callingAe ${a.callingAe}` : ''
      }`;
      const toDimse = a.direction === 'web-to-dimse';
      const body = toDimse
        ? `
1. dcm_web_ping against ${a.webUrl}. A 404 here almost always means the base URL
   is missing its path prefix (commonly /dicom-web), not that the server is
   down. Credentials come from this server's environment; never ask for a token.

2. dcm_web_query — url ${a.webUrl}, level studies, keys {"StudyInstanceUID": "${a.studyUid}"}.
   Confirm the study exists and note how many series and instances are expected.

3. dcm_web_retrieve — url ${a.webUrl}, studyUid ${a.studyUid}, outDir ${a.workDir}.

4. dcm_inventory over ${a.workDir}. This is the checkpoint: compare the instance
   count against what the query reported. Do not send a study you have not
   counted.

5. dcm_echo to ${peer}. It proves the peer answers and accepts the calling AE
   Title. It does NOT prove storage is permitted — that is step 6's job.

6. dcm_send — path ${a.workDir}, ${peer}. Run it with dryRun true first if the
   instance count is large. Report found, sent and acknowledged; a shortfall is
   a failure, not a rounding error.

7. dcm_query the peer for StudyInstanceUID ${a.studyUid} if you want to confirm
   it is searchable there. Zero matches does NOT mean the send failed —
   storing and indexing are separate, the peer may not be the system that
   indexes, and it may need time. Trust the acknowledged count from step 6 for
   whether the transfer succeeded, and treat the query as a separate question.`
        : `
1. dcm_echo to ${peer}, then dcm_query for StudyInstanceUID ${a.studyUid} at
   level study to confirm the peer has it. If the query comes back empty but
   you have reason to believe the study is there, note that querying and
   storing are separate permissions before concluding anything.

2. Get the instances into ${a.workDir}. This engine's DIMSE side sends; it does
   not pull. Either point it at a folder that already holds the study, or have
   the peer push it to a receiver (dcm scp — see dcm://usage/scp) and use that
   folder. Ask which of these applies rather than assuming a C-MOVE exists.

3. dcm_inventory over ${a.workDir}. Confirm the StudyInstanceUID matches
   ${a.studyUid} and note the instance count — this is the number every later
   step is checked against.

4. dcm_web_ping against ${a.webUrl}. A 404 almost always means the base URL is
   missing its path prefix (commonly /dicom-web). A successful ping proves the
   URL answers and the credentials open it; it is not a storage grant.
   Credentials come from this server's environment — never ask for a token.

5. dcm_web_send — url ${a.webUrl}, folder ${a.workDir}. Use dryRun true first if
   the study is large. The report settles every instance against the server's
   own STOW response: acknowledged, failed with a reason, or unanswered. A
   shortfall is a failure.

6. dcm_web_query — url ${a.webUrl}, keys {"StudyInstanceUID": "${a.studyUid}"} —
   to confirm the study is now searchable there. If it returns nothing but
   step 5 acknowledged everything, that is an indexing question, not a transfer
   failure. Say so rather than re-sending.`;

      return userPrompt(
        `Mirror study ${a.studyUid} (${a.direction})`,
        `
Mirror study ${a.studyUid}, direction ${a.direction}: ${toDimse ? `from DICOMweb (${a.webUrl}) to the DIMSE peer` : `from the DIMSE side to DICOMweb (${a.webUrl})`}, staging through ${a.workDir}.

Read dcm://troubleshooting before interpreting any failure. Do not skip a
verification step because an earlier one succeeded — the whole point of the
order below is that each step proves something the previous one did not.
${body}

If a de-identified copy is needed before it leaves, dcm_anon writes one to a new
folder and never modifies the source — but it is best-effort and does not touch
pixel data, so say that plainly rather than calling the result anonymous.

Report the instance count at every hop and flag the first place they stop
matching.
`
      );
    }
  );
}

module.exports = { register, USAGE_SOURCES, INDEX_URI, TROUBLESHOOTING_URI, TROUBLESHOOTING, buildIndex };
