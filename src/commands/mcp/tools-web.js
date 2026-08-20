'use strict';

/**
 * MCP tools that drive the DICOMweb commands (STOW-RS, QIDO-RS, WADO-RS).
 *
 * Credentials are read from the environment the MCP server was launched with
 * (DCM_WEB_TOKEN, or DCM_WEB_USER/DCM_WEB_PASS) — deliberately not tool
 * arguments, so a token never transits the assistant conversation. No schema
 * below has a field that could carry one, and that is a property to preserve
 * when adding options: the base URL, matching keys and UIDs are the only
 * strings these tools accept.
 *
 * The `dcm web serve` hub is deliberately absent here. It is a long-lived
 * process rather than a one-shot command, so it belongs with the other server
 * lifecycle tools in ./tools-servers.js.
 */

/**
 * Shared wording for --insecure.
 *
 * The flag turns off the only check that the server on the other end is the
 * one that was named, so the description has to say that in the tool list
 * where an assistant reads it — not just in the CLI's --help.
 */
const INSECURE_DESC =
  'Skip TLS certificate verification. Only for self-signed test servers you control — never for ' +
  'production, because it removes the guarantee that this is the server you named and lets anyone ' +
  'on the network path read or alter the traffic. No effect on an http:// URL.';

/** Shared wording for the base URL, which the environment can also supply. */
const URL_DESC =
  'DICOMweb base URL including any path prefix the server roots the API under, e.g. ' +
  'https://pacs.example.org/dicom-web — a bare hostname is usually the web UI, not the API. ' +
  'Omit only when the MCP server environment sets DCM_WEB_URL. Do not put credentials in the URL; ' +
  'authentication comes from the environment.';

/** Shared wording for the credential rule, appended to every description. */
const CREDS_NOTE =
  ' Credentials come from the environment this MCP server was launched with (DCM_WEB_TOKEN, or ' +
  'DCM_WEB_USER/DCM_WEB_PASS) — there is no argument for them, so a token never travels through ' +
  'the conversation.';

/**
 * Register the DICOMweb tools on an MCP server.
 *
 * @param {object} server  The McpServer to register on.
 * @param {object} z  The zod module (loaded lazily by the mcp command).
 * @param {object} rt  The MCP runtime ({runCommand, textResult, jsonResult, opt, ...}).
 * @returns {void}
 */
function register(server, z, rt) {
  const { runCommand, textResult, jsonResult, opt } = rt;

  // ---- DICOMweb ----------------------------------------------------------
  // Credentials are read from the environment the MCP server was launched
  // with (DCM_WEB_TOKEN, or DCM_WEB_USER/DCM_WEB_PASS) — deliberately not
  // tool arguments, so a token never transits the assistant conversation.
  server.registerTool(
    'dcm_web_ping',
    {
      title: 'DICOMweb connectivity check',
      description:
        'Verify a DICOMweb base URL answers and the credentials in the server environment work. ' +
        'Asks the cheapest question there is — GET /studies?limit=1 — and reports the round trip. ' +
        'Does not prove the server will accept images: storage (STOW-RS) is a separate grant on ' +
        'many servers, and a server can answer queries all day while refusing every upload. The ' +
        'first real dcm_web_send is the only test of storage that counts.' + CREDS_NOTE,
      inputSchema: {
        url: z.string().optional().describe(URL_DESC),
        timeout: z.number().int().optional().describe('Milliseconds to tolerate (default 60000).'),
        insecure: z.boolean().optional().describe(INSECURE_DESC),
      },
    },
    async (a) => {
      const argv = ['ping'];
      opt(argv, '--url', a.url);
      opt(argv, '--timeout', a.timeout);
      if (a.insecure) argv.push('--insecure');
      return textResult(await runCommand('web', argv));
    }
  );

  server.registerTool(
    'dcm_web_send',
    {
      title: 'DICOMweb store (STOW-RS)',
      description:
        'Send a folder of DICOM files to a DICOMweb server (STOW-RS), grouped by study and posted ' +
        'in chunks. Reports files found / sent / acknowledged exactly like dcm_send, and any ' +
        'shortfall between those three numbers is a failure, not a success. Acknowledgement is ' +
        'read per instance from the STOW-RS response body: an instance the response never mentions ' +
        'is counted as unanswered, never assumed stored. Storing is not indexing — a study the ' +
        'server accepted may not answer a query for it yet.' + CREDS_NOTE,
      inputSchema: {
        url: z.string().optional().describe(URL_DESC),
        folder: z.string().describe('Absolute path of the folder to send.'),
        chunk: z.number().int().optional().describe(
          'Instances per STOW request (default 50). Decides how much work one failed request takes down with it.'
        ),
        retry: z.number().int().optional().describe(
          'Retry attempts for instances that failed retryably — HTTP 429/5xx, network errors, out-of-resources (default 1).'
        ),
        dryRun: z.boolean().optional().describe('Scan and report the plan without connecting.'),
        noRecurse: z.boolean().optional().describe('Only send files sitting directly in the folder, not subfolders.'),
        insecure: z.boolean().optional().describe(INSECURE_DESC),
        timeout: z.number().int().optional().describe('Milliseconds of silence tolerated per request (default 60000).'),
      },
    },
    async (a) => {
      const argv = ['send', a.folder];
      opt(argv, '--url', a.url);
      opt(argv, '--chunk', a.chunk);
      opt(argv, '--retry', a.retry);
      opt(argv, '--timeout', a.timeout);
      if (a.dryRun) argv.push('--dry-run');
      if (a.noRecurse) argv.push('--no-recurse');
      if (a.insecure) argv.push('--insecure');
      return textResult(await runCommand('web', argv));
    }
  );

  server.registerTool(
    'dcm_web_query',
    {
      title: 'DICOMweb query (QIDO-RS)',
      description:
        'Query a DICOMweb server (QIDO-RS) at study, series or instance level. Matching keys are ' +
        'DICOM keywords or 8-hex-digit tags — {"PatientID":"12345"} and {"00100020":"12345"} are ' +
        'the same query. Values take * and ? wildcards and hyphenated date ranges ' +
        '(StudyDate=20260101-20260131). QIDO string matching is exact unless the value carries a ' +
        'wildcard, so PatientName=DOE matches only a patient literally named DOE — you almost ' +
        'always want DOE*. Levels narrow rather than filter: giving StudyInstanceUID at series ' +
        'level asks GET /studies/<uid>/series, and giving both StudyInstanceUID and ' +
        'SeriesInstanceUID at instance level asks GET /studies/<uid>/series/<uid>/instances; ' +
        'without those keys the same levels query the server-wide /series and /instances. Use ' +
        'include for attributes beyond the server\'s default set, and limit/offset to page. Zero ' +
        'matches comes back as an error result (exit 1 is the CLI convention) — that means ' +
        '"nothing matched these keys", NOT "the transfer failed": servers differ on case ' +
        'sensitivity and fuzzy matching, and some index new arrivals late.' + CREDS_NOTE,
      inputSchema: {
        url: z.string().optional().describe(URL_DESC),
        level: z.enum(['studies', 'series', 'instances']).optional().describe('Query level (default studies).'),
        keys: z.record(z.string(), z.string()).optional().describe(
          'Matching keys as DICOM keyword→value or 8-hex-digit tag→value, e.g. {"PatientID":"12345"} or ' +
          '{"00100020":"12345"}. Wildcards (* ?) and date ranges (20260101-20260131) are allowed in values. ' +
          'StudyInstanceUID/SeriesInstanceUID here are what narrow a series or instance query into one study.'
        ),
        limit: z.number().int().optional().describe('Ask the server for at most this many matches.'),
        offset: z.number().int().optional().describe('Skip this many matches — paging, together with limit.'),
        include: z.array(z.string()).optional().describe(
          'Extra attributes to ask for beyond the server\'s default set (QIDO-RS includefield), by keyword or ' +
          '8-hex-digit tag. Each entry becomes its own --include, which is how the engine takes them.'
        ),
        insecure: z.boolean().optional().describe(INSECURE_DESC),
        timeout: z.number().int().optional().describe('Whole-request timeout in milliseconds (default 60000).'),
      },
    },
    async (a) => {
      // Matching keys go in before the level switch: a bare switch immediately
      // followed by a key=value token is the one ordering where the tokenizer
      // has to decide whether the key is the switch's value.
      const argv = ['query'];
      opt(argv, '--url', a.url);
      for (const [k, v] of Object.entries(a.keys || {})) argv.push(`${k}=${v}`);
      opt(argv, '--limit', a.limit);
      opt(argv, '--offset', a.offset);
      // --include is repeatable in the engine, so one switch per attribute is
      // the literal argv a person would type; the parser accumulates them.
      for (const field of a.include || []) opt(argv, '--include', field);
      opt(argv, '--timeout', a.timeout);
      if (a.insecure) argv.push('--insecure');
      if (a.level && a.level !== 'studies') argv.push(`--${a.level}`);
      argv.push('--json');
      return jsonResult(await runCommand('web', argv));
    }
  );

  server.registerTool(
    'dcm_web_retrieve',
    {
      title: 'DICOMweb retrieve (WADO-RS)',
      description:
        'Retrieve a study — or one series, or one instance — from a DICOMweb server (WADO-RS) into ' +
        'a local folder, written as <outDir>/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm. ' +
        'The request asks for transfer-syntax=*, the bytes as stored, so nothing is silently ' +
        'transcoded on the way out. The whole response is downloaded before any part is written, ' +
        'so give a large study a timeout to match. A server that can produce only part of the ' +
        'study answers 206: what arrived is parsed and written, and the result is still an error, ' +
        'because an incomplete study is not a successful retrieve.' + CREDS_NOTE,
      inputSchema: {
        url: z.string().optional().describe(URL_DESC),
        studyUid: z.string().describe('StudyInstanceUID to retrieve.'),
        seriesUid: z.string().optional().describe('Narrow the retrieve to one series within that study.'),
        instanceUid: z.string().optional().describe(
          'Narrow to one SOP instance. Requires seriesUid — WADO-RS addresses an instance inside its series, ' +
          'so there is no path for an instance without one.'
        ),
        outDir: z.string().describe('Absolute path of the folder to write into. Created if missing.'),
        insecure: z.boolean().optional().describe(INSECURE_DESC),
        timeout: z.number().int().optional().describe('Whole-request timeout in milliseconds (default 60000).'),
      },
    },
    async (a) => {
      const argv = ['retrieve'];
      opt(argv, '--url', a.url);
      opt(argv, '--study', a.studyUid);
      opt(argv, '--series', a.seriesUid);
      opt(argv, '--instance', a.instanceUid);
      opt(argv, '--out', a.outDir);
      opt(argv, '--timeout', a.timeout);
      if (a.insecure) argv.push('--insecure');
      argv.push('--json');
      return jsonResult(await runCommand('web', argv));
    }
  );
}

module.exports = { register };
