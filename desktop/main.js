'use strict';

/**
 * Asteris DICOM — Electron main process.
 *
 * The whole point of this app is to put a friendly face on the existing CLI
 * engine without forking it. Every action the UI takes runs the exact same
 * `dcm` command a person would type in a terminal, and the command line is
 * shown in the UI before it runs. There is no second implementation of DIMSE
 * here to drift out of sync with the tool the support team already trusts.
 *
 * How the engine is invoked:
 *   Electron ships its own Node. With ELECTRON_RUN_AS_NODE=1 the Electron
 *   binary behaves as plain Node, so we spawn it against the engine's own
 *   entry script (bin/dcm.js) and stream its stdout/stderr back to the
 *   renderer line by line. That gives live progress for `send` and a
 *   long-lived, cancellable child for the `scp` receiver, with the engine
 *   code reused verbatim.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, net, screen } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Headless CI/smoke runs need Chromium's setuid sandbox disabled (e.g. running
// as root in a container). Never enabled in a normal launch.
if (process.env.DCM_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

/** Resolve the engine's CLI entry script and its version, robustly. */
function resolveEngine() {
  // The engine source is vendored into ./engine by copy-engine.js (run before
  // start and dist). Its runtime dependencies resolve from ./node_modules.
  const engineRoot = path.join(__dirname, 'engine');
  const entry = path.join(engineRoot, 'bin', 'dcm.js');
  let version = '0.0.0';
  try {
    version = require(path.join(engineRoot, 'package.json')).version || version;
  } catch {
    /* engine not vendored yet; version stays default */
  }
  return { entry, engineRoot, version };
}

const ENGINE = resolveEngine();

// The smoke harness is automated verification, not somebody launching the app:
// it gets its own user-data directory so a test run can never write over real
// saved profiles, and it skips the single-instance lock so it still runs when
// the installed app happens to be open (otherwise CI is fine but a developer's
// verification run silently exits).
const SMOKE = !!process.env.DCM_SMOKE_DIR;

// The smoke harness can ask main to spawn an arbitrary script (see startRun), a
// hook that only makes sense against a source checkout. app.isPackaged is what
// separates the two: an installed build can never reach it however the
// environment is set, so a test affordance cannot become a shipped one.
const SMOKE_UNPACKAGED = SMOKE && !app.isPackaged;
if (SMOKE) {
  app.setPath('userData', path.join(process.env.DCM_SMOKE_DIR, 'userData'));
}

// Two instances would race over profiles.json and fight over receiver ports.
// A second launch just fronts the window that is already there.
const gotInstanceLock = SMOKE || app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  // Say so on stderr: `npm start` while the installed app is open loses this
  // race too, and a silent exit code 0 there looks exactly like a bug.
  process.stderr.write('Asteris DICOM App is already running; fronting the existing window.\n');
  app.quit();
} else {
  app.on('second-instance', () => {
    // During the splash phase the main window exists but has never painted;
    // front the splash instead of revealing a blank window next to it.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.focus();
    }
  });
}

/** Live child processes, keyed by the runId the renderer uses to address them. */
const children = new Map();
let runCounter = 0;

/** Where per-user connection profiles live. This is the GUI's own state — the
 * CLI engine still never reads any config file. */
function profilesPath() {
  return path.join(app.getPath('userData'), 'profiles.json');
}

function readProfiles() {
  try {
    const raw = fs.readFileSync(profilesPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.profiles)) return data;
  } catch {
    /* no profiles yet */
  }
  return { profiles: [], lastUsed: null };
}

function writeProfiles(data) {
  try {
    fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
    fs.writeFileSync(profilesPath(), JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    return { error: err.message };
  }
}

/** v0.5 and earlier ran under the product name "Asteris DICOM", which puts its
 * user data in a different folder. Carry saved connection profiles across the
 * rename so nobody re-types their PACS hosts after an update. */
function migrateLegacyProfiles() {
  try {
    if (fs.existsSync(profilesPath())) return;
    const legacy = path.join(app.getPath('appData'), 'Asteris DICOM', 'profiles.json');
    if (!fs.existsSync(legacy)) return;
    fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
    fs.copyFileSync(legacy, profilesPath());
  } catch {
    /* start fresh rather than fail the launch */
  }
}

/** Where the GUI's settings live: the station's AE Title, peer roles' defaults,
 * rehearsal and the engineer options. Mirrors the profiles file exactly, and
 * under the same policy — the renderer reads it and writes every value it uses
 * into the command line; the engine never opens it. */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    /* no settings yet */
  }
  return {};
}

function writeSettings(data) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    return { error: err.message };
  }
}

/** GUI-only state: window bounds, last-run version, the screen that was open.
 * Same policy as profiles — this is the app's own file, the engine still never
 * reads any config. */
function appStatePath() {
  return path.join(app.getPath('userData'), 'app-state.json');
}

function readAppState() {
  try {
    return JSON.parse(fs.readFileSync(appStatePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeAppState(patch) {
  try {
    const next = { ...readAppState(), ...patch };
    fs.mkdirSync(path.dirname(appStatePath()), { recursive: true });
    fs.writeFileSync(appStatePath(), JSON.stringify(next, null, 2));
  } catch {
    /* losing window bounds is not worth surfacing */
  }
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  writeAppState({
    bounds: { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() },
  });
}

/** Last session's window bounds, but only if they still land on a connected
 * display — a detached monitor must not strand the window off-screen. */
function restoreWindowBounds() {
  const fallback = { width: 1180, height: 800, x: undefined, y: undefined, maximized: false };
  const b = readAppState().bounds;
  if (!b || !(b.width >= 940) || !(b.height >= 620)) return fallback;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40
      && b.y >= a.y - 20 && b.y < a.y + a.height - 40;
  });
  return onScreen ? b : fallback;
}

let mainWindow = null;
let splashWindow = null;

function createWindow(opts = {}) {
  // A packaged cold launch can take a few seconds (asar, engine, first
  // paint), and a silent gap between double-click and window reads exactly
  // like "it didn't work". So a small splash appears immediately and the main
  // window stays hidden until its first paint is ready. Two exceptions: the
  // smoke harness screenshots the main window (DCM_SMOKE_DIR), and a macOS
  // Dock reopen of an already-running app has no cold-start latency to cover —
  // both show the window directly.
  const smoke = !!process.env.DCM_SMOKE_DIR;
  const withSplash = !smoke && opts.splash !== false;
  if (withSplash) {
    splashWindow = new BrowserWindow({
      width: 440,
      height: 280,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      // Alt+F4 on the splash would leave the app alive with no window at all
      // until the main window is ready; it lives a few seconds, closing it is
      // not a thing anyone needs.
      closable: false,
      backgroundColor: '#0e1420',
      title: 'Asteris DICOM App',
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
    splashWindow.on('closed', () => { splashWindow = null; });
  }

  const bounds = restoreWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 620,
    show: !withSplash,
    backgroundColor: '#0e1420',
    title: 'Asteris DICOM App',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // maximize() also *shows* a hidden window, so during the splash phase it has
  // to wait for reveal() rather than run at construction.
  if (bounds.maximized && !withSplash) mainWindow.maximize();

  const reveal = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      if (bounds.maximized) mainWindow.maximize();
      else mainWindow.show();
    }
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  };
  if (withSplash) {
    mainWindow.once('ready-to-show', reveal);
    // If the renderer never signals ready, show the window anyway rather than
    // leaving a splash pulsing forever over nothing.
    setTimeout(reveal, 8000);
  }

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', () => saveWindowBounds());

  // If the renderer ever stops answering again, the main process is still fine
  // and is the only place that can say so. Children keep running while a
  // renderer is wedged — an engine mid-transfer holding an association open
  // while its window is frozen is exactly the state this app must not be
  // silent about, and it is invisible from inside the frozen window.
  //
  // Nothing is killed here on our own initiative: a long legitimate transfer
  // must not be aborted because the UI stuttered. Closing the window still
  // works while a renderer is unresponsive, and before-quit stops every child,
  // so the operator's escape hatch is intact either way.
  mainWindow.webContents.on('unresponsive', () => {
    process.stderr.write(`renderer unresponsive with ${children.size} engine child(ren) running\n`);
  });
  mainWindow.webContents.on('responsive', () => {
    process.stderr.write('renderer responsive again\n');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC: running the engine
// ---------------------------------------------------------------------------
//
// Output arrives from the engine in whatever sized reads the pipe happens to
// give us. A noisy run makes that thousands of reads a second, and one IPC
// message per read puts the renderer on the hook for thousands of tasks a
// second before it has even looked at the text — with the Stop button's click
// queued behind all of them. So the main process is the choke point: reads are
// concatenated here and handed over on a fixed cadence.
//
// Draining the pipe promptly matters for its own sake too. A child blocked
// writing into a full pipe is a child not making progress on its association.

/** How often buffered output is handed to the renderer. */
const CHUNK_FLUSH_MS = 40;

/**
 * How much output may sit here waiting for a renderer that is not taking it.
 *
 * Only stderr is ever dropped. stdout carries the engine's own report and its
 * --json payload — the accounting of what was found, sent and acknowledged —
 * and an app that quietly deletes part of that would let a run look better
 * than it was. Floods live on stderr (dcmjs's parse chatter, --verbose, PDU
 * traces), so that is the only stream with a ceiling.
 *
 * Reaching it is reported as a count alongside the chunk, not as a line
 * inserted into the stream. A notice written into the output is output, and
 * the console trims output — the first version of this did exactly that, and
 * the admission that lines were missing was itself trimmed away, leaving a
 * total that no longer added up and no way to tell. The count travels beside
 * the text so it can land somewhere that is never trimmed.
 */
const STDERR_BUFFER_LIMIT = 8 * 1024 * 1024;

/**
 * Buffers a child's output and releases it to the renderer on a fixed cadence.
 *
 * @param {number} runId
 * @param {(channel: string, data: object) => void} send
 */
function makeChunkPump(runId, send) {
  const pending = { stdout: '', stderr: '' };
  let droppedLines = 0;
  let timer = null;

  const flush = () => {
    timer = null;
    for (const stream of ['stdout', 'stderr']) {
      const text = pending[stream];
      const dropped = stream === 'stderr' ? droppedLines : 0;
      if (!text && !dropped) continue;
      pending[stream] = '';
      if (dropped) droppedLines = 0;
      send('dcm:chunk', { runId, stream, text, dropped });
    }
  };

  return {
    push(stream, text) {
      pending[stream] += text;
      if (stream === 'stderr' && pending.stderr.length > STDERR_BUFFER_LIMIT) {
        const cut = pending.stderr.length - STDERR_BUFFER_LIMIT;
        // Counted in lines, the same unit the console reports its own trimming
        // in, so the two add into one honest total rather than sitting there as
        // two numbers in different currencies that nobody can reconcile.
        droppedLines += pending.stderr.slice(0, cut).split('\n').length - 1;
        pending.stderr = pending.stderr.slice(cut);
      }
      if (timer === null) timer = setTimeout(flush, CHUNK_FLUSH_MS);
    },
    /** Empties the buffer now, so exit never overtakes the last of the output. */
    drain() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    },
  };
}

/**
 * Starts an engine command and streams its output to the calling renderer.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {{argv: string[], cwd?: string}} payload  argv is the full `dcm`
 *   argument vector, e.g. ['echo','--host','localhost',...].
 * @returns {{runId: number}}
 */
function startRun(event, payload) {
  const argv = Array.isArray(payload?.argv) ? payload.argv.map(String) : [];
  const cwd = payload?.cwd && fs.existsSync(payload.cwd) ? payload.cwd : app.getPath('home');
  const runId = ++runCounter;

  // Verifying that no output volume can wedge the window needs a child that
  // emits as fast as a pipe will carry it, and no real `dcm` command does that
  // on demand. Gated on the same env var that gates the smoke harness itself,
  // so a normal launch can never reach it.
  const script = SMOKE_UNPACKAGED && argv[0] === '__script__' ? argv[1] : null;
  const spawnArgs = script ? [script, ...argv.slice(2)] : [ENGINE.entry, ...argv];

  const child = spawn(process.execPath, spawnArgs, {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NO_COLOR: '1',
      // Keep the engine from probing for a TTY-driven menu; a piped stdin is
      // already non-interactive, this is belt and suspenders.
      DCM_NONINTERACTIVE: '1',
    },
    windowsHide: true,
  });

  children.set(runId, child);

  const sender = event.sender;
  const send = (channel, data) => {
    if (!sender.isDestroyed()) sender.send(channel, data);
  };

  const pump = makeChunkPump(runId, send);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (text) => pump.push('stdout', text));
  child.stderr.on('data', (text) => pump.push('stderr', text));

  child.on('error', (err) => {
    pump.push('stderr', `failed to launch engine: ${err.message}\n`);
    pump.drain();
    send('dcm:exit', { runId, code: 127, signal: null });
    children.delete(runId);
  });

  child.on('close', (code, signal) => {
    // Drain before the exit event: the renderer treats exit as the end of the
    // run, and output still sitting in the buffer would arrive after the run
    // it belongs to had already been reported as finished.
    pump.drain();
    send('dcm:exit', { runId, code: code ?? (signal ? 143 : 0), signal });
    children.delete(runId);
  });

  return { runId };
}

/**
 * How long a child is given to stop on its own before it is taken away.
 *
 * `scp` and `web serve` install SIGINT/SIGTERM handlers that close their
 * sockets and release what they hold, and that shutdown is the whole reason
 * for a grace period. `send` installs none, so on POSIX it dies on the signal
 * and the kernel closes its sockets — a receiver sees the association's
 * transport go away, which is recoverable, rather than an association that
 * stays open with nobody behind it.
 *
 * Windows has no signal to send: kill() is TerminateProcess, so there the
 * first attempt is already the forceful one and the escalation below only
 * matters for a child that somehow survives it.
 */
const STOP_GRACE_MS = 4000;

/** A second, shorter wait after the forceful kill, before we admit defeat. */
const STOP_FORCE_MS = 2000;

/** How often the process table is asked whether the child is really gone. */
const STOP_POLL_MS = 200;

/**
 * Stops a running child and resolves with what actually happened.
 *
 * The old version fired kill() and reported success without waiting, so a
 * child that ignored it looked exactly like one that had stopped. That is the
 * distinction that matters here: the thing we are trying to prevent is an
 * engine still holding an association open while the operator has been told
 * the transfer is over.
 *
 * This waits on 'exit', not 'close'. 'close' also waits for our own pipes to
 * drain, which under a flood means waiting on tens of megabytes we have
 * already decided we do not need — measured at over six seconds after a child
 * that died instantly, long enough to trip the escalation and report a
 * failure to stop something that had already stopped. The peer's question is
 * answered at 'exit': the process is gone, so its sockets are closed. What is
 * still in our pipe afterwards is our business, not the receiver's. (startRun
 * does wait for 'close' before telling the renderer the run finished, which is
 * the opposite question — there, output still in flight must not arrive after
 * the run it belongs to has been reported as over.)
 *
 * @param {number} runId
 * @returns {Promise<{stopped: boolean, forced?: boolean, error?: string}>}
 */
function stopChild(runId) {
  const child = children.get(runId);
  if (!child) return Promise.resolve({ stopped: false, reason: 'not running' });
  // Still in `children` until its pipes close, so it can be here having
  // already exited. Waiting for an 'exit' that fired before we listened would
  // spend the whole grace period to report a failure to stop a dead process.
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ stopped: true, forced: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let forced = false;
    let escalate = null;
    let giveUp = null;
    let poll = null;

    const onExit = () => finish({ stopped: true, forced });
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      clearTimeout(giveUp);
      clearInterval(poll);
      child.removeListener('exit', onExit);
      resolve(result);
    }

    child.on('exit', onExit);

    try {
      child.kill();
    } catch (err) {
      finish({ stopped: false, error: err.message });
      return;
    }

    // The event is the fast path, not the authority. Under the load this whole
    // change is about, the main process is busy enough that Node's 'exit' can
    // arrive seconds after the process is actually gone — measured here at
    // over four, long enough to trip the escalation below and report a failure
    // to stop something that had stopped in 250ms. Asking the operating system
    // answers the question we actually care about: the process is gone, so its
    // sockets are closed, so the peer is not holding an association for it.
    //
    // On Windows a terminated child reports gone here while Node still has it
    // at exitCode null, which is exactly the gap this closes. On POSIX the
    // child is a zombie until Node reaps it, so the pid still answers and this
    // poll never wins the race — there 'exit' arrives first and does the job.
    poll = setInterval(() => {
      try {
        process.kill(child.pid, 0);
      } catch {
        finish({ stopped: true, forced });
      }
    }, STOP_POLL_MS);

    escalate = setTimeout(() => {
      forced = true;
      try {
        if (process.platform === 'win32') {
          // /t takes the process tree with it. A child that has spawned its own
          // helpers would otherwise leave them holding the port or the socket.
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* nothing left to do but report below */
      }
      giveUp = setTimeout(() => {
        finish({ stopped: false, forced: true, error: 'the engine did not exit' });
      }, STOP_FORCE_MS);
    }, STOP_GRACE_MS);
  });
}

/** Stops a running child (used for the receiver's Stop button, or cancel). */
function cancelRun(_event, runId) {
  return stopChild(runId);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
//
// Two tiers, because not every build of this app can replace itself:
//
//  - The installed Windows app (NSIS) self-updates via electron-updater
//    against the GitHub release feed: check on launch, download in the
//    background, swap on "Restart & update" — or silently on the next normal
//    quit if the button is never clicked.
//  - The Windows portable exe has no install to replace, and the unsigned
//    macOS build cannot swap itself (Squirrel.Mac requires a code signature).
//    Those get a notify-only check against the GitHub API and a button that
//    opens the releases page.
//
// Either way the update itself is the real installer from the release, the
// same file a person would download by hand.

const RELEASES_URL = 'https://github.com/Alan6195/dcm-cli-agent/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/Alan6195/dcm-cli-agent/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Pushed to the renderer on every change; also queryable, because the
 * renderer may finish booting after an event has already fired. */
let updateState = { status: 'idle' };

function setUpdateState(next) {
  updateState = next;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', updateState);
  }
}

function selfUpdateSupported() {
  if (!app.isPackaged) return false;
  // The portable launcher sets this; a portable exe has no install to update.
  // macOS (unsigned) can't swap itself, and there is no Linux build.
  return process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function isNewerVersion(remote, local) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Notify-only path: compare the latest release tag against our version. */
async function checkForUpdateViaApi() {
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { update: false, error: `GitHub answered ${res.status}` };
    const release = await res.json();
    const tag = release && release.tag_name;
    if (tag && !release.draft && !release.prerelease && isNewerVersion(tag, app.getVersion())) {
      setUpdateState({ status: 'available', version: String(tag).replace(/^v/, '') });
      return { update: true };
    }
    return { update: false };
  } catch (err) {
    // Offline or rate-limited; the interval retries.
    return { update: false, error: err ? String(err.message || err) : 'unknown' };
  }
}

/** Set per build flavor by initUpdates; backs the "Check for updates" button. */
let manualUpdateCheck = null;

/** One-shot "you were just updated" notice, shown by the renderer until
 * dismissed. Computed at startup from the version recorded last run. */
let whatsNew = null;

function initUpdates() {
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => (manualUpdateCheck ? manualUpdateCheck() : { update: false }));
  ipcMain.handle('update:whatsnew', () => whatsNew);
  ipcMain.handle('update:whatsnew-ack', () => { whatsNew = null; return { ok: true }; });
  ipcMain.handle('update:open-releases', (_event, version) => {
    const url = version
      ? `https://github.com/Alan6195/dcm-cli-agent/releases/tag/v${encodeURIComponent(String(version))}`
      : RELEASES_URL;
    shell.openExternal(url);
  });

  if (!app.isPackaged) {
    ipcMain.handle('update:install', () => ({ ok: false }));
    return;
  }

  if (!selfUpdateSupported()) {
    ipcMain.handle('update:install', () => ({ ok: false }));
    manualUpdateCheck = checkForUpdateViaApi;
    setTimeout(checkForUpdateViaApi, 5000);
    setInterval(checkForUpdateViaApi, UPDATE_CHECK_INTERVAL_MS);
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  // Even if the button is never clicked, a downloaded update is applied
  // silently on the next normal quit.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    // A periodic re-check after the download completed re-emits this while the
    // cached file is re-validated; that must not knock a ready update back to
    // "downloading 0%" and hide the install button.
    if (updateState.status === 'ready' && updateState.version === info.version) return;
    setUpdateState({ status: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (updateState.status === 'ready') return;
    setUpdateState({ status: 'downloading', version: updateState.version, percent: Math.round(progress.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // A failed background check must never hide an update that is already
    // downloaded and installable; otherwise stay quiet and retry later.
    if (updateState.status === 'ready') return;
    setUpdateState({ status: 'error', message: err ? String(err.message || err) : 'unknown' });
  });

  ipcMain.handle('update:install', () => {
    if (updateState.status !== 'ready') return { ok: false };
    // Silent install, relaunch when done. before-quit still runs, so any
    // receiver or transfer child is killed the same as on a normal quit.
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  });

  manualUpdateCheck = async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result && result.updateInfo && result.updateInfo.version;
      return { update: Boolean(version && isNewerVersion(version, app.getVersion())) };
    } catch (err) {
      return { update: false, error: err ? String(err.message || err) : 'unknown' };
    }
  };

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(() => {
  if (!gotInstanceLock) return;

  migrateLegacyProfiles();

  // Record the version each run; a change since last run means an update
  // happened (possibly silently on quit), and the renderer says so once.
  const lastVersion = readAppState().lastVersion || null;
  if (lastVersion !== app.getVersion()) writeAppState({ lastVersion: app.getVersion() });
  if (app.isPackaged && lastVersion && lastVersion !== app.getVersion()) {
    whatsNew = { from: lastVersion, to: app.getVersion() };
  }

  ipcMain.handle('dcm:info', () => ({
    version: ENGINE.version,
    entry: ENGINE.entry,
    platform: process.platform,
    home: app.getPath('home'),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('dcm:start', startRun);
  ipcMain.handle('dcm:cancel', cancelRun);

  ipcMain.handle('dcm:pick', async (_event, opts = {}) => {
    const props = [];
    if (opts.mode === 'file') props.push('openFile');
    else props.push('openDirectory');
    if (opts.mode === 'create') props.push('createDirectory', 'promptToCreate');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || 'Choose',
      properties: props,
      defaultPath: opts.defaultPath || app.getPath('home'),
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('dcm:profiles:get', () => readProfiles());
  ipcMain.handle('dcm:profiles:set', (_event, data) => writeProfiles(data));

  ipcMain.handle('dcm:settings:get', () => readSettings());
  ipcMain.handle('dcm:settings:set', (_event, data) => writeSettings(data));

  // The renderer may remember which screen and tabs were open, and nothing
  // else: the bounds and the version stamp are this process's to write.
  ipcMain.handle('dcm:appstate:get', () => {
    const s = readAppState();
    return { activeView: s.activeView || null, activeTabs: s.activeTabs || {} };
  });
  ipcMain.handle('dcm:appstate:set', (_event, patch) => {
    const next = {};
    if (patch && typeof patch.activeView === 'string') next.activeView = patch.activeView;
    if (patch && patch.activeTabs && typeof patch.activeTabs === 'object') next.activeTabs = patch.activeTabs;
    if (Object.keys(next).length) writeAppState(next);
    return { ok: true };
  });

  ipcMain.handle('dcm:reveal', (_event, target) => {
    if (target && fs.existsSync(target)) {
      shell.showItemInFolder(target);
      return { ok: true };
    }
    return { ok: false };
  });

  createWindow();
  initUpdates();

  // Headless verification. Guarded by env; a normal launch never enters here.
  if (process.env.DCM_SMOKE_DIR && mainWindow) {
    const startSmoke = () => {
      try {
        require('./test/smoke').runSmoke(mainWindow, app);
      } catch (err) {
        // The harness is not shipped in packaged builds. Say so loudly rather
        // than leaving the process alive and looking like a hang.
        process.stderr.write(`smoke harness unavailable: ${err.message}\n`);
        app.exit(3);
      }
    };
    // A packaged app can finish loading from the asar archive before this
    // listener is attached, so waiting on did-finish-load alone would hang.
    if (mainWindow.webContents.isLoadingMainFrame()) {
      mainWindow.webContents.once('did-finish-load', startSmoke);
    } else {
      startSmoke();
    }
  }

  app.on('activate', () => {
    // Dock reopen on macOS: the app is already warm, no splash needed.
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ splash: false });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never leave a receiver or transfer running after the app exits.
app.on('before-quit', () => {
  for (const child of children.values()) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
});
