'use strict';

const fs = require('fs');

const log = require('../lib/log');
const args = require('../lib/args');

const FLAGS = ['model', 'max-tokens', 'no-redact', 'show-prompt', 'effort'];

/**
 * Default model. Kept current deliberately — a diagnosis is only as good as the
 * model producing it, and this is a low-volume, high-value call.
 */
const DEFAULT_MODEL = 'claude-opus-5';

const USAGE = `
dcm explain — explain a failed transfer using the Anthropic API (optional)

Pipe a log, a status code, or an association trace in and get a plain-English
diagnosis with suggested next steps. Entirely optional: every other command
works without it, and nothing in this tool calls the API unless you run this.

Usage:
  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE 2>&1 | dcm explain
  dcm explain transfer.log
  dcm explain --show-prompt < transfer.log

Options:
  --model <id>        Model to use. Default: ${DEFAULT_MODEL}
  --max-tokens <n>    Response cap. Default: 16000
  --effort <level>    low | medium | high | xhigh | max. Default: high
  --no-redact         Send the input verbatim. Off by default — see below.
  --show-prompt       Print exactly what would be sent and exit. No network call.

Authentication:
  The API key is read from the ANTHROPIC_API_KEY environment variable and
  nowhere else. There is deliberately no flag and no config file, so a key
  cannot end up in your shell history or committed to a repository.

    export ANTHROPIC_API_KEY=sk-ant-...      # macOS / Linux
    $env:ANTHROPIC_API_KEY = "sk-ant-..."    # PowerShell

Privacy:
  This command sends the text you give it to the Anthropic API. Transfer logs
  from this tool contain UIDs, AE Titles and hostnames rather than patient
  data, but verbose output can include patient-level elements. Identifiers are
  therefore redacted before sending unless you pass --no-redact, and
  --show-prompt lets you inspect the exact payload first.
`.trimStart();

/**
 * Patterns for identifiers that should not leave the machine.
 *
 * Deliberately conservative about UIDs: Study, Series and SOP Instance UIDs
 * are what make a transfer problem diagnosable, and they are not patient
 * identifiers, so they are left intact. Names, IDs, birth dates and accession
 * numbers are replaced.
 */
const REDACTIONS = [
  {
    label: 'patient name',
    // Matches "PatientName: DOE^JANE", "(0010,0010) DOE^JANE", "patient  DOE^JANE / ID"
    pattern: /((?:PatientName|Patient Name|\(0010,0010\)|patient)\s*[:=]?\s*)([^\s/,;]+(?:\^[^\s/,;]*)+|[A-Z][A-Za-z'-]+\^[^\s/,;]*)/g,
    replace: (_m, prefix) => `${prefix}[REDACTED-NAME]`,
  },
  {
    label: 'patient ID',
    pattern: /((?:PatientID|Patient ID|MRN|\(0010,0020\))\s*[:=]?\s*)([^\s/,;]+)/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED-ID]`,
  },
  {
    label: 'birth date',
    pattern: /((?:PatientBirthDate|BirthDate|DOB|\(0010,0030\))\s*[:=]?\s*)([^\s/,;]+)/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED-DOB]`,
  },
  {
    label: 'accession number',
    pattern: /((?:AccessionNumber|Accession|\(0008,0050\))\s*[:=]?\s*)([^\s/,;]+)/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED-ACCESSION]`,
  },
  {
    label: 'bare PN-formatted value',
    // A caret-delimited token is the DICOM Person Name form; treat any
    // survivor as a name even without a labelling prefix.
    pattern: /\b[A-Za-z'-]{2,}\^[A-Za-z'^-]{2,}\b/g,
    replace: () => '[REDACTED-NAME]',
  },
];

/**
 * Strips patient identifiers from the text.
 *
 * @param {string} text
 * @returns {{text: string, counts: Map<string, number>}}
 */
function redact(text) {
  const counts = new Map();
  let out = text;

  for (const { label, pattern, replace } of REDACTIONS) {
    let hits = 0;
    out = out.replace(pattern, (...matchArgs) => {
      hits += 1;
      return replace(...matchArgs);
    });
    if (hits) counts.set(label, hits);
  }

  return { text: out, counts };
}

/**
 * Domain reference for the model.
 *
 * This is a large, completely static block, so it is the cache prefix: it is
 * marked with `cache_control` and never interpolated with anything that varies
 * between runs. The log being diagnosed goes in the user turn, after the
 * cached prefix, so repeated calls read the cache rather than rewriting it.
 */
const SYSTEM_PROMPT = `You are a DICOM networking expert helping an engineer diagnose a failed or
degraded DIMSE transfer. You are being called from a command-line tool called
"dcm", which performs C-ECHO, C-STORE, C-FIND and runs a permissive receiver.

Your job: read the log, trace or status code the user provides, state what went
wrong in plain English, and give concrete next steps. Be specific and practical.
The reader is technical but may not know DICOM deeply.

Reference — association rejection (A-ASSOCIATE-RJ, DICOM PS3.8 Table 9-21).
Reason codes are only meaningful together with the source; the same number
means different things from different sources.

  Source 1 (service-user, i.e. the peer application):
    1 = no reason given. In practice almost always an access-control rule.
    2 = application context name not supported. Very rare; suspect the port is
        not actually a DICOM service.
    3 = calling AE Title not recognized. THE most common real-world failure.
        It means the calling AE Title is not registered/allowlisted on the
        receiving side. It is a configuration issue on the peer, not a bug in
        the sender. The fix is to have the peer's administrator register the
        exact calling AE Title (case-sensitive, max 16 characters) together
        with the source IP.
    7 = called AE Title not recognized. You reached a real DICOM service but
        asked for a name it does not answer to. Check the called AE Title.
  Source 2 (service-provider, ACSE):
    1 = no reason given.  2 = protocol version not supported.
  Source 3 (service-provider, presentation):
    1 = temporary congestion (transient — retry).
    2 = local limit exceeded (too many simultaneous associations).

Reference — C-STORE response status (DICOM PS3.7 Annex C, PS3.4 Annex B).
A peer can accept an association and still refuse individual instances, so
per-instance statuses matter more than the association result.

  0x0000            success.
  0xB000            warning: coercion of data elements. Stored, but the
                    receiver rewrote elements (often Patient ID or Accession
                    Number). The data on the far side no longer matches yours.
  0xB006            warning: elements discarded.
  0xB007            warning: data set does not match SOP Class.
  0xA7xx            refused: out of resources. Usually disk or queue limits.
                    Transient; smaller chunks or a later retry often works.
  0xA9xx            error: data set does not match SOP Class.
  0xCxxx            error: cannot understand. Often a transfer syntax the peer
                    claims to accept but cannot actually decode.
  0x0110            processing failure (internal error on the receiver).
  0x0111            duplicate SOP Instance UID. Benign on a re-send; on a first
                    send it suggests the source emits colliding UIDs.
  0x0117            invalid SOP Instance UID (malformed, or over 64 chars).
  0x0122            SOP Class not supported — the peer took the association but
                    not this object type.
  0x0124            not authorized.

Reference — distinguishing failure modes. These have completely different
causes and must not be conflated:
  - A rejection is an ANSWER from the peer. Points at configuration/access control.
  - An abort means the association was accepted and then torn down. Points at
    an internal error, a queue limit, or a specific instance the receiver choked on.
  - A timeout is SILENCE, not an answer. Points at a network path, a firewall
    dropping packets, or a receiver that stopped servicing the association.
    A mid-transfer PDU timeout after partial acknowledgement is the classic
    "receiver accepted then went quiet" case; retrying the outstanding
    instances usually completes them.
  - A transport error (ECONNREFUSED, ENOTFOUND) means DICOM never started.

Reference — accepted is not the same as queryable. A successful C-STORE means
the peer accepted those instances. It does NOT mean the study is searchable
there. Store-and-forward receivers routinely return zero C-FIND matches for
data they have accepted but not yet indexed or forwarded. Never tell the user
a successful store implies a successful query, and if they report "it sent but
we can't find it", explain this distinction first.

Reference — lossy transfers. The dcm tool reports three numbers per study:
files found on disk, files sent, and instances acknowledged by the peer. If
acknowledged is lower than found, the transfer lost data even if it otherwise
looks successful. Always call out a shortfall explicitly and help the user find
where the instances went (read errors, refusals, unanswered requests).

Output format:
1. A one-line summary of what went wrong.
2. "What this means" — two or three sentences of plain English.
3. "What to do" — a short numbered list of concrete next steps, most likely
   fix first. Say which side each step happens on (sender or receiver), since
   many fixes require the peer's administrator.
4. If the evidence is ambiguous, say so and list what to capture next
   (for example: run again with --verbose to see the negotiated contexts).

Be concise. Do not restate the whole log. Do not speculate beyond the evidence.
If identifiers appear as [REDACTED-...], that is expected — the tool removes
patient identifiers before sending; do not ask for them.`;

/**
 * Reads the text to diagnose, from a file argument or from stdin.
 *
 * @param {string|undefined} filePath
 * @returns {Promise<string>}
 */
async function readInput(filePath) {
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new args.UsageError(`Cannot read "${filePath}": ${err.message}`);
    }
  }

  if (process.stdin.isTTY) {
    throw new args.UsageError(
      'No input. Pipe a log in, or pass a file:\n' +
        '  dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE 2>&1 | dcm explain\n' +
        '  dcm explain transfer.log'
    );
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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

  const model = args.resolve(flags, { name: 'model', fallback: DEFAULT_MODEL });
  const maxTokens = args.resolve(flags, { name: 'max-tokens', type: 'number', fallback: 16000 });
  const effort = args.resolve(flags, { name: 'effort', fallback: 'high' });
  const noRedact = args.resolve(flags, { name: 'no-redact', type: 'boolean', fallback: false });
  const showPrompt = args.resolve(flags, { name: 'show-prompt', type: 'boolean', fallback: false });

  const raw = await readInput(positionals[0]);
  if (!raw.trim()) {
    throw new args.UsageError('Input was empty — nothing to explain.');
  }

  let payload = raw;
  if (!noRedact) {
    const { text, counts } = redact(raw);
    payload = text;
    if (counts.size) {
      const summary = [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(', ');
      log.info(`redacted before sending: ${summary}`);
    }
  } else {
    log.warn('--no-redact is set: the input is being sent verbatim, including any identifiers.');
  }

  const userContent =
    'Diagnose the following DICOM transfer output. Explain what went wrong and what to do next.\n\n' +
    '```\n' +
    payload.trim() +
    '\n```';

  if (showPrompt) {
    log.out('===== system prompt (cached prefix) =====');
    log.out(SYSTEM_PROMPT);
    log.out('');
    log.out('===== user message (sent each time) =====');
    log.out(userContent);
    log.out('');
    log.out('===== request =====');
    log.out(`model: ${model}`);
    log.out(`max_tokens: ${maxTokens}`);
    log.out(`effort: ${effort}`);
    log.out('No network call was made.');
    return 0;
  }

  // Read the key from the environment and nowhere else.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.error('ANTHROPIC_API_KEY is not set.');
    log.error('');
    log.error('This command is optional — every other dcm command works without it.');
    log.error('To use it, set the key in your environment:');
    log.error('  export ANTHROPIC_API_KEY=sk-ant-...      # macOS / Linux');
    log.error('  $env:ANTHROPIC_API_KEY = "sk-ant-..."    # PowerShell');
    log.error('');
    log.error('The key is only ever read from the environment. There is no flag and no');
    log.error('config file, so it cannot be committed or captured in shell history.');
    return 1;
  }

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    log.error('The Anthropic SDK is not available in this build, so `dcm explain` cannot run.');
    log.error('Every other command is unaffected.');
    return 1;
  }

  const client = new Anthropic({ apiKey });

  log.info(`asking ${model} to diagnose ${payload.length} characters of output...`);

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      // Route a policy decline to a fallback model rather than returning
      // nothing useful to someone in the middle of debugging a transfer.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // The reference block above is identical on every invocation, so it
          // is the stable cache prefix. Everything that varies — the log being
          // diagnosed — sits after it in the user turn.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    if (err?.status === 401) {
      log.error('The API rejected the key in ANTHROPIC_API_KEY (401).');
      return 1;
    }
    if (err?.status === 429) {
      log.error('Rate limited by the API (429). Try again shortly.');
      return 1;
    }
    log.error(`Could not reach the Anthropic API: ${err?.message ?? String(err)}`);
    return 1;
  }

  // A refusal returns HTTP 200 with no usable content; reading content[0]
  // without checking would throw here rather than explain itself.
  if (response.stop_reason === 'refusal') {
    log.error('The model declined to answer this input.');
    if (response.stop_details?.explanation) {
      log.error(response.stop_details.explanation);
    }
    return 1;
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) {
    log.error('The model returned no text. Try again, or raise --max-tokens.');
    return 1;
  }

  log.out('');
  log.out(text);
  log.out('');

  const usage = response.usage ?? {};
  log.debug(
    `tokens — input ${usage.input_tokens ?? 0}, output ${usage.output_tokens ?? 0}, ` +
      `cache write ${usage.cache_creation_input_tokens ?? 0}, ` +
      `cache read ${usage.cache_read_input_tokens ?? 0}`
  );

  if (response.stop_reason === 'max_tokens') {
    log.warn('The response hit --max-tokens and was cut off. Re-run with a higher value.');
  }

  return 0;
}

module.exports = { run, USAGE, redact, SYSTEM_PROMPT };
