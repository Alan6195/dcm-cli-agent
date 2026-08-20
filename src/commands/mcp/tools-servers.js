'use strict';

/**
 * MCP tools for the two long-running servers: the DIMSE receiver (`dcm scp`)
 * and the DICOMweb hub (`dcm web serve`).
 *
 * A server that runs for hours cannot be a single request/response tool, so it
 * is modelled as a lifecycle instead: start -> list / status -> stop. Start
 * returns the address a client would use, so the very next tool call can target
 * it and a whole transfer can be verified end to end — start a receiver, send
 * to it, confirm from its log what arrived, stop it.
 *
 * These run as CHILD PROCESSES, and that is not an optimisation. A receiver
 * hosted inside this process would log through the shared log.js chokepoint,
 * and its output is asynchronous: a line written minutes later would land in
 * whichever tool happened to be capturing stdout at that moment, silently
 * corrupting that tool's result. A child owns its own streams; we read them
 * over a pipe and keep them in a buffer of our own.
 */

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * How many servers may run at once.
 *
 * Each one holds a port and a process for as long as the session lasts, and an
 * assistant retrying a failed start is the normal way to end up with a dozen.
 * Refusing past a small number is better than leaking processes silently.
 */
const MAX_SERVERS = 4;

/** Log lines retained per server. A receiver left running logs for hours. */
const MAX_LOG_LINES = 400;

/** Lines returned by status when the caller does not ask for a count. */
const DEFAULT_TAIL = 20;

/** Upper bound on a caller-requested tail, so one call cannot dump everything. */
const MAX_TAIL = 200;

/** How long to wait for a freshly spawned server to report that it is listening. */
const START_TIMEOUT_MS = 15000;

/** Grace period between the polite kill and SIGKILL. */
const STOP_GRACE_MS = 3000;

/**
 * Both servers announce themselves with a "listening" line on stderr once the
 * socket is up. Waiting for it is what lets start() return an address that is
 * actually reachable by the next tool call.
 */
const LISTENING = /\blistening\b/i;

/** Every server started in this session, by id, including the exited ones. */
const servers = new Map();

let idCounter = 0;

/**
 * Builds the command that re-runs this CLI as a child process.
 *
 * The engine ships two ways: as `node bin/dcm.js`, and as a single-file
 * executable with Node embedded. Under Node, process.argv[1] is the script and
 * has to be passed on. In the packaged executable, process.execPath *is* the
 * CLI, and passing argv[1] would hand it a bogus first argument.
 *
 * @param {string[]} argv  CLI arguments, e.g. ['scp', '--port', '11112'].
 * @param {string} [entry]  Script path to test; defaults to process.argv[1].
 * @returns {string[]}  [command, ...args], ready for spawn().
 */
function resolveCliCommand(argv, entry = process.argv[1]) {
  if (entry && /\.[cm]?js$/i.test(entry)) return [process.execPath, entry, ...argv];
  return [process.execPath, ...argv];
}

/**
 * Finds a free TCP port by binding 0 on loopback and reading back what the OS
 * gave us.
 *
 * There is an unavoidable gap between releasing the probe and the child binding
 * the port. Nothing else on the machine normally claims a just-freed ephemeral
 * port in that window, and the alternative — making an assistant guess a port —
 * fails far more often. If the port is taken anyway the child fails to listen
 * and the start tool reports that, rather than pretending to have started.
 *
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Appends one line to a server's ring buffer, discarding the oldest. */
function pushLine(rec, line) {
  rec.lines.push(line);
  if (rec.lines.length > MAX_LOG_LINES) {
    rec.lines.splice(0, rec.lines.length - MAX_LOG_LINES);
    rec.truncated = true;
  }
}

/**
 * Collects a child stream into the ring buffer a line at a time.
 *
 * Chunk boundaries fall wherever the OS put them, so a partial line is held
 * back until its newline arrives — otherwise a status tail shows text sliced in
 * half.
 *
 * @param {object} rec  Server record.
 * @param {import('node:stream').Readable} stream  Child stdout or stderr.
 */
function collect(rec, stream) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();
    for (const line of parts) pushLine(rec, line);
  });
  stream.on('end', () => {
    if (pending.trim()) pushLine(rec, pending);
    pending = '';
  });
}

/** True while the child is still running. */
function isRunning(rec) {
  return rec.exitedAt === undefined;
}

/** Milliseconds the server has been (or was) up. */
function uptimeMs(rec) {
  return (isRunning(rec) ? Date.now() : rec.exitedAt) - rec.startedAt;
}

/** Human-readable duration, e.g. "1m 04s". */
function formatUptime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Terminates a child.
 *
 * On POSIX this is SIGTERM, which both servers handle: they close the socket
 * and print their summary. On Windows there is no signal delivery — kill()
 * terminates the process outright — so the Ctrl+C summary never prints. That is
 * why status and stop report from the captured log rather than waiting for a
 * summary that may never come.
 *
 * @param {object} rec  Server record.
 * @param {string} [signal]
 */
function killChild(rec, signal) {
  if (!isRunning(rec)) return;
  try {
    rec.child.kill(signal);
  } catch {
    // Already gone; the exit handler has the truth.
  }
}

/**
 * Waits for a child to exit.
 *
 * @param {object} rec  Server record.
 * @param {number} ms  How long to wait.
 * @returns {Promise<boolean>}  True if it exited within the window.
 */
function waitForExit(rec, ms) {
  if (!isRunning(rec)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      rec.child.removeListener('exit', onExit);
      resolve(false);
    }, ms);
    timer.unref?.();
    rec.child.once('exit', onExit);
  });
}

/**
 * Kills every child still running. Registered on process exit and on the
 * termination signals, because a leaked receiver holds its port long after the
 * assistant that started it has disconnected.
 */
function killAll() {
  for (const rec of servers.values()) killChild(rec);
}

let cleanupInstalled = false;
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;

  process.on('exit', killAll);

  // Installing a signal handler suppresses Node's default termination, so each
  // of these has to end the process itself.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      killAll();
      process.exit(0);
    });
  }

  // The client disconnecting closes our stdin, and that is the end of the
  // session these servers belong to. Killing them here is what lets this
  // process exit at all: a running child's piped stdout and stderr are
  // referenced handles, so the event loop would never drain and `dcm mcp`
  // would sit there holding every port until something killed it — after
  // which the children would be orphaned. Listening for the stream's end is
  // safe; only a 'data' listener would resume it and steal protocol bytes.
  //
  // A hard kill of this process (Windows has no interruptible signal) still
  // skips all of this. Nothing in JavaScript can catch that, which is the
  // other reason dcm_server_stop exists: it is the reliable way to end one.
  let closing = false;
  const sessionOver = () => {
    if (closing) return;
    closing = true;
    killAll();
  };
  process.stdin.on('end', sessionOver);
  process.stdin.on('close', sessionOver);
}

/**
 * Waits until the child logs its listening line, exits, or the timeout passes.
 *
 * @param {object} rec  Server record.
 * @returns {Promise<boolean>}  True once it is listening.
 */
async function waitUntilListening(rec) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (rec.lines.some((line) => LISTENING.test(line))) return true;
    if (!isRunning(rec)) return false;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/**
 * Spawns one server and waits for it to listen.
 *
 * @param {{kind: string, argv: string[], port: number, address: string}} spec
 * @returns {Promise<{ok: true, rec: object}|{ok: false, text: string}>}
 */
async function launch({ kind, argv, port, address }) {
  const running = [...servers.values()].filter(isRunning);
  if (running.length >= MAX_SERVERS) {
    return {
      ok: false,
      text:
        `Refusing to start another server: ${running.length} are already running ` +
        `(${running.map((r) => r.id).join(', ')}) and the limit is ${MAX_SERVERS}. ` +
        'Stop one with dcm_server_stop first.',
    };
  }

  installCleanup();

  idCounter += 1;
  const id = `${kind}-${idCounter}`;
  const [command, ...commandArgs] = resolveCliCommand(argv);

  const rec = {
    id,
    kind,
    port,
    address,
    argv,
    lines: [],
    truncated: false,
    startedAt: Date.now(),
    exitedAt: undefined,
    exitCode: null,
    exitSignal: null,
    child: null,
  };

  // stdio: stdin ignored (nothing types at it), stdout and stderr piped. Never
  // 'inherit' — this process's stdout is the JSON-RPC channel, and an inherited
  // handle would let the child write DICOM chatter straight into the protocol.
  const child = spawn(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  rec.child = child;
  servers.set(id, rec);

  child.on('error', (err) => {
    pushLine(rec, `failed to spawn: ${err && err.message ? err.message : String(err)}`);
    if (isRunning(rec)) {
      rec.exitedAt = Date.now();
      rec.exitCode = null;
      rec.exitSignal = null;
    }
  });
  child.on('exit', (code, signal) => {
    rec.exitedAt = Date.now();
    rec.exitCode = code;
    rec.exitSignal = signal;
  });

  collect(rec, child.stdout);
  collect(rec, child.stderr);

  if (await waitUntilListening(rec)) return { ok: true, rec };

  // It never came up. Kill whatever is left and hand back what it said, which
  // is where the reason lives (port in use, bad AE Title, unreadable folder).
  killChild(rec);
  await waitForExit(rec, STOP_GRACE_MS);
  servers.delete(id);
  const tail = rec.lines.slice(-DEFAULT_TAIL).join('\n').trim();
  return {
    ok: false,
    text:
      `The ${kind} did not start listening on port ${port} within ` +
      `${Math.round(START_TIMEOUT_MS / 1000)}s.\n\n${tail || '(it produced no output)'}`,
  };
}

/**
 * Stops a server, escalating if it ignores the polite kill.
 *
 * @param {object} rec  Server record.
 * @returns {Promise<void>}
 */
async function stopServer(rec) {
  if (!isRunning(rec)) return;
  killChild(rec);
  if (await waitForExit(rec, STOP_GRACE_MS)) return;
  killChild(rec, 'SIGKILL');
  await waitForExit(rec, STOP_GRACE_MS);
}

/** The structured shape both list and status report a server as. */
function describe(rec, tailLines) {
  const tail = rec.lines.slice(-tailLines);
  return {
    serverId: rec.id,
    kind: rec.kind,
    port: rec.port,
    address: rec.address,
    status: isRunning(rec) ? 'running' : 'exited',
    uptimeMs: uptimeMs(rec),
    uptime: formatUptime(uptimeMs(rec)),
    exitCode: isRunning(rec) ? null : rec.exitCode,
    exitSignal: isRunning(rec) ? null : rec.exitSignal,
    logLines: tail,
    logTruncated: rec.truncated,
  };
}

/** A tool result carrying both a readable summary and the structured payload. */
function result(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** A tool result that reports a failure. */
function failure(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Renders a log tail for the text half of a result. */
function renderTail(rec, tailLines) {
  const tail = rec.lines.slice(-tailLines);
  if (!tail.length) return '(no output yet)';
  return tail.join('\n');
}

/**
 * Register the server-lifecycle tools on an MCP server.
 *
 * @param {object} server  The McpServer to register on.
 * @param {object} z  The zod module (loaded lazily by the mcp command).
 * @param {object} rt  The MCP runtime ({runCommand, textResult, jsonResult, opt, ...}).
 * @returns {void}
 */
function register(server, z, rt) {
  const { opt } = rt;

  // ---- Starting ----------------------------------------------------------
  server.registerTool(
    'dcm_receiver_start',
    {
      title: 'Start a DIMSE receiver',
      description:
        'Start `dcm scp`, a permissive DICOM receiver, as a background process on this machine and return the host:port to send to. ' +
        'It accepts every SOP Class and transfer syntax offered, so it proves what a sender emits — not what a real PACS would accept. ' +
        'It stores but does not index: C-FIND against it returns zero matches, exactly like many store-and-forward systems — ' +
        'unless you pass worklist, which makes it answer Modality Worklist queries from a file so dcm_worklist can be tested against something real. ' +
        'Without persist it acknowledges and discards the bytes. Omit port to have a free one picked for you. ' +
        'It listens on this machine until you stop it with dcm_server_stop, and is stopped for you if this MCP session ends. Stop it when you are finished.',
      inputSchema: {
        port: z.number().int().optional().describe('Port to listen on. Omit to get a free one.'),
        ae: z.string().optional().describe('Only answer to this called AE Title; others are rejected as "called AE not recognized". Default: answer to any.'),
        persist: z.string().optional().describe('Folder to write received instances into, as <dir>/<StudyUID>/<SeriesUID>/<SOPUID>.dcm. Default: acknowledge and discard.'),
        acceptCallingAe: z.array(z.string()).optional().describe('Allowlist of calling AE Titles; anything else is rejected. Default: accept any.'),
        worklist: z.string().optional().describe(
          'Path to a JSON file of Modality Worklist items (an array of flat DICOM keyword objects: PatientName, PatientID, ' +
          'AccessionNumber, Modality, ScheduledStationAETitle, ScheduledProcedureStepStartDate/Time, ...). The receiver then ' +
          'answers worklist C-FIND queries from it, so a worklist integration can be exercised locally. Without it, every C-FIND returns zero matches.'
        ),
      },
    },
    async (a) => {
      const port = a.port ?? (await freePort());
      const argv = ['scp', '--port', String(port)];
      opt(argv, '--ae', a.ae);
      opt(argv, '--persist', a.persist ? path.resolve(a.persist) : undefined);
      for (const ae of a.acceptCallingAe || []) argv.push('--accept-calling-ae', ae);
      opt(argv, '--worklist', a.worklist ? path.resolve(a.worklist) : undefined);

      const address = `127.0.0.1:${port}`;
      const started = await launch({ kind: 'receiver', argv, port, address });
      if (!started.ok) return failure(started.text);

      const { rec } = started;
      return result(
        `Receiver ${rec.id} is listening on ${address}` +
          `${a.ae ? ` as called AE ${a.ae}` : ''}.\n` +
          `Send to it with dcm_send { host: "127.0.0.1", port: ${port}, calledAe: "${a.ae || 'ANY'}" }, ` +
          `then read what arrived with dcm_server_status { serverId: "${rec.id}" }.\n` +
          `It runs on this machine until dcm_server_stop { serverId: "${rec.id}" }.`,
        {
          serverId: rec.id,
          kind: rec.kind,
          port,
          address,
          host: '127.0.0.1',
          calledAe: a.ae ?? null,
          persist: a.persist ? path.resolve(a.persist) : null,
        }
      );
    }
  );

  server.registerTool(
    'dcm_web_hub_start',
    {
      title: 'Start a DICOMweb hub',
      description:
        'Start `dcm web serve`, a local DICOMweb hub (STOW-RS, QIDO-RS, WADO-RS), as a background process and return its base URL. ' +
        'It binds loopback only and speaks cleartext HTTP with no TLS; there is deliberately no option to bind it wider. ' +
        'Use it as a target for dcm_web_send / dcm_web_query / dcm_web_retrieve. Omit port to have a free one picked for you. ' +
        'It runs until you stop it with dcm_server_stop, and is stopped for you if this MCP session ends. Stop it when you are finished.',
      inputSchema: {
        port: z.number().int().optional().describe('Port to listen on. Omit to get a free one.'),
        persist: z.string().optional().describe('Folder to write stored instances into. Default: index each part\'s metadata, discard the bytes.'),
        root: z.string().optional().describe('Existing folder to index at startup, so its studies are queryable over QIDO and retrievable over WADO.'),
        requireToken: z.string().optional().describe('Reject requests without "Authorization: Bearer <t>" with 401, to reproduce an auth failure locally. Use a made-up value: never a real PACS token — this one travels through the conversation and appears in this machine\'s process list. Real credentials reach the web tools through DCM_WEB_TOKEN in this server\'s environment instead.'),
        rejectAfter: z.number().int().optional().describe('Per STOW request, accept n parts and fail the rest, producing a genuine partial store for testing shortfall accounting.'),
        maxBody: z.number().int().optional().describe('Largest STOW body to accept, in megabytes (default 512); larger is refused with 413.'),
      },
    },
    async (a) => {
      const port = a.port ?? (await freePort());
      const argv = ['web', 'serve', '--port', String(port)];
      opt(argv, '--persist', a.persist ? path.resolve(a.persist) : undefined);
      opt(argv, '--root', a.root ? path.resolve(a.root) : undefined);
      opt(argv, '--require-token', a.requireToken);
      opt(argv, '--reject-after', a.rejectAfter);
      opt(argv, '--max-body', a.maxBody);

      const address = `http://127.0.0.1:${port}`;
      const started = await launch({ kind: 'hub', argv, port, address });
      if (!started.ok) return failure(started.text);

      const { rec } = started;
      return result(
        `DICOMweb hub ${rec.id} is listening on ${address} (loopback only).\n` +
          `Store to it with dcm_web_send { url: "${address}", folder: ... }, ` +
          `then read what arrived with dcm_server_status { serverId: "${rec.id}" }.\n` +
          `It runs on this machine until dcm_server_stop { serverId: "${rec.id}" }.`,
        {
          serverId: rec.id,
          kind: rec.kind,
          port,
          address,
          url: address,
          persist: a.persist ? path.resolve(a.persist) : null,
          root: a.root ? path.resolve(a.root) : null,
          requireToken: Boolean(a.requireToken),
        }
      );
    }
  );

  // ---- Inspecting --------------------------------------------------------
  server.registerTool(
    'dcm_servers_list',
    {
      title: 'List servers started this session',
      description:
        'List every receiver and hub started through this MCP server, running or exited, with its address, uptime and the last few log lines. ' +
        'Only servers this session started are here — a receiver someone launched from a terminal is invisible to it.',
      inputSchema: {},
    },
    async () => {
      const all = [...servers.values()].map((rec) => describe(rec, 3));
      if (!all.length) {
        return result('No servers have been started in this session.', { servers: [] });
      }
      const text = all
        .map(
          (s) =>
            `${s.serverId}  ${s.kind}  ${s.address}  ${s.status}` +
            `${s.status === 'exited' ? ` (exit ${s.exitCode ?? s.exitSignal ?? 'unknown'})` : ''}  up ${s.uptime}` +
            (s.logLines.length ? `\n${s.logLines.map((l) => `    ${l}`).join('\n')}` : '')
        )
        .join('\n');
      return result(text, { servers: all });
    }
  );

  server.registerTool(
    'dcm_server_status',
    {
      title: 'Status of a started server',
      description:
        'Report whether a started server is still running and show its recent output — which is where a receiver records the associations, C-ECHOs and C-STOREs it saw, and the hub records its STOW, QIDO and WADO requests. ' +
        'This reads the log the process produced, not a live count: a line here proves the server logged it, and nothing more.',
      inputSchema: {
        serverId: z.string().describe('Id returned by dcm_receiver_start or dcm_web_hub_start.'),
        lines: z.number().int().optional().describe(`Log lines to return from the end (default ${DEFAULT_TAIL}, max ${MAX_TAIL}).`),
      },
    },
    async (a) => {
      const rec = servers.get(a.serverId);
      if (!rec) return failure(`No server with id "${a.serverId}". Use dcm_servers_list to see what this session started.`);

      const tailLines = Math.min(Math.max(a.lines ?? DEFAULT_TAIL, 1), MAX_TAIL);
      const info = describe(rec, tailLines);
      const header = isRunning(rec)
        ? `${rec.id} (${rec.kind}) is running on ${rec.address}, up ${info.uptime}.`
        : `${rec.id} (${rec.kind}) has exited (${rec.exitCode ?? rec.exitSignal ?? 'unknown'}) after ${info.uptime}. Port ${rec.port} is free again.`;
      return result(`${header}\n\n${renderTail(rec, tailLines)}`, info);
    }
  );

  // ---- Stopping ----------------------------------------------------------
  server.registerTool(
    'dcm_server_stop',
    {
      title: 'Stop a started server',
      description:
        'Stop a receiver or hub started through this MCP server and return its final output and exit state. Stopping one that has already exited is not an error. ' +
        'On Windows the process is terminated rather than interrupted, so the Ctrl+C summary a person would see in a terminal is not printed — the counts to trust are the ones in the log lines above it.',
      inputSchema: {
        serverId: z.string().describe('Id returned by dcm_receiver_start or dcm_web_hub_start.'),
        lines: z.number().int().optional().describe(`Log lines to return from the end (default ${DEFAULT_TAIL}, max ${MAX_TAIL}).`),
      },
    },
    async (a) => {
      const rec = servers.get(a.serverId);
      if (!rec) return failure(`No server with id "${a.serverId}". Use dcm_servers_list to see what this session started.`);

      const alreadyStopped = !isRunning(rec);
      await stopServer(rec);

      const tailLines = Math.min(Math.max(a.lines ?? DEFAULT_TAIL, 1), MAX_TAIL);
      const info = describe(rec, tailLines);
      const stillRunning = isRunning(rec);
      const header = stillRunning
        ? `${rec.id} (${rec.kind}) did not exit after being killed; it may be wedged.`
        : alreadyStopped
          ? `${rec.id} (${rec.kind}) had already exited (${rec.exitCode ?? rec.exitSignal ?? 'unknown'}); nothing to stop.`
          : `Stopped ${rec.id} (${rec.kind}) on ${rec.address} after ${info.uptime}. Port ${rec.port} is free again.`;

      const out = { content: [{ type: 'text', text: `${header}\n\n${renderTail(rec, tailLines)}` }], structuredContent: { ...info, alreadyStopped } };
      if (stillRunning) out.isError = true;
      return out;
    }
  );
}

module.exports = { register, resolveCliCommand, MAX_SERVERS };
