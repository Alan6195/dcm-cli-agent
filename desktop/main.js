'use strict';

/**
 * AscendI DICOM — Electron main process.
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
const crypto = require('node:crypto');
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
  process.stderr.write('AscendI DICOM is already running; fronting the existing window.\n');
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

// --- Carrying the operator's data across a product rename ------------------
//
// Electron derives userData from productName, so renaming the product moves
// the whole directory: %APPDATA%\Asteris DICOM App\ becomes
// %APPDATA%\AscendI DICOM\, and everything the operator saved stays behind in
// a folder the new build never looks at. From their side that is not a rename,
// it is a wipe — the PACS peers they typed in are gone.
//
// The v0.5 → v0.6 rename got a one-file version of this. The AscendI rename
// generalised it, because by now there are three files and two older names.

/**
 * The files this app owns in its user-data directory.
 *
 * Named individually rather than copying the directory wholesale. userData
 * also holds Chromium's own state — Cache, GPUCache, Local Storage, Cookies —
 * which belongs to the build that wrote it and is worth nothing carried
 * forward. These three are the app's own, and they are the ones whose absence
 * an operator notices: their saved PACS peers, their station identity and
 * defaults, and the window they left the app on.
 */
const STATE_FILES = ['profiles.json', 'settings.json', 'app-state.json'];

/**
 * Product names this app has shipped under, newest first.
 *
 * "Asteris DICOM" was v0.5 and earlier; "Asteris DICOM App" was v0.6 through
 * the AscendI rename. Newest first is deliberate: a machine that has been
 * through both renames has both directories, and the one to trust is the one
 * written most recently.
 */
const LEGACY_PRODUCT_DIRS = ['Asteris DICOM App', 'Asteris DICOM'];

/**
 * Copy state files from earlier user-data directories into the current one.
 *
 * Takes its paths rather than reading them off `app`, so it can be run against
 * throwaway directories. The real ones hold the only copy of somebody's peer
 * list, and a migration nobody can test on a scratch directory is a migration
 * nobody tests.
 *
 * One rule, and it only goes one way: a file is carried only when the current
 * directory does not already have it. A file that is already there was written
 * by a run under the current name and is therefore newer than anything an
 * older name left behind — copying over it would roll the operator back
 * silently, which is worse than the problem this solves. Each file is decided
 * on its own, so an install that has already saved settings.json still gets
 * the old profiles.json.
 *
 * @param {string} targetDir the current userData directory
 * @param {string[]} legacyDirs earlier userData directories, newest first
 * @returns {{carried: {file: string, from: string}[], failed: {file: string, error: string}[]}}
 */
function migrateStateFiles(targetDir, legacyDirs) {
  const carried = [];
  const failed = [];
  for (const file of STATE_FILES) {
    try {
      const target = path.join(targetDir, file);
      if (fs.existsSync(target)) continue; // never overwrite newer data
      const source = (Array.isArray(legacyDirs) ? legacyDirs : [])
        .map((dir) => path.join(dir, file))
        .find((candidate) => fs.existsSync(candidate));
      if (!source) continue;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, target);
      carried.push({ file, from: source });
    } catch (err) {
      // One unreadable file must not cost the operator the other two.
      failed.push({ file, error: String((err && err.message) || err) });
    }
  }
  return { carried, failed };
}

/**
 * The launch-time call.
 *
 * Never throws. An app that refuses to open is a worse outcome than one that
 * opens with an empty peer list, and in the failure case the old directory is
 * still sitting there to be recovered from by hand.
 */
function migrateLegacyUserData() {
  // The smoke harness runs against a throwaway userData directory. Without
  // this, every smoke run would pull the real installed app's profiles and
  // settings into the test — a harness reading state it did not create, and
  // reaching into the operator's own data to do it.
  if (SMOKE) return { carried: [], failed: [] };
  try {
    const appData = app.getPath('appData');
    return migrateStateFiles(
      app.getPath('userData'),
      LEGACY_PRODUCT_DIRS.map((name) => path.join(appData, name))
    );
  } catch {
    return { carried: [], failed: [] };
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
      title: 'AscendI DICOM',
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
    title: 'AscendI DICOM',
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
//  - macOS cannot swap itself: Squirrel.Mac needs a real code signature and
//    these builds are ad-hoc signed. It checks against the GitHub API and
//    then downloads the disk image matching this Mac's architecture into
//    Downloads, checks it, and reveals it in Finder. The operator installs it.
//  - The Windows portable exe has no install to replace. It gets the
//    notify-only check and a button that opens the releases page.
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
  // macOS (ad-hoc signed) can't swap itself — it takes the download-and-reveal
  // path below instead — and there is no Linux build.
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
      const version = String(tag).replace(/^v/, '');
      // Work out here, while the release is in hand, which file this machine
      // would need — so the banner can offer that file by name rather than a
      // page of fourteen. Only macOS has a rule; everything else still gets
      // the page, and so does a Mac whose architecture matched nothing.
      const asset = process.platform === 'darwin' ? pickMacAsset(release.assets, process.arch) : null;
      macUpdate = asset
        ? { version, asset, feedAsset: findReleaseAsset(release.assets, 'latest-mac.yml') }
        : null;
      setUpdateState({
        status: 'available',
        version,
        download: asset ? { name: asset.name, size: asset.size, arch: process.arch } : null,
      });
      return { update: true };
    }
    macUpdate = null;
    return { update: false };
  } catch (err) {
    // Offline or rate-limited; the interval retries.
    return { update: false, error: err ? String(err.message || err) : 'unknown' };
  }
}

// --- macOS: hand over the right disk image, not a web page -----------------
//
// Squirrel.Mac can only swap an app that carries a real Developer ID
// signature, and these builds are ad-hoc signed, so self-update on macOS is
// not something that can be made to work here — wiring it up would fail at
// install time instead of failing honestly now.
//
// But the swap is not what actually costs a Mac operator. The releases page
// is: a release carries fourteen files, two of them disk images that differ
// only by architecture, and installing the wrong one gets "the application is
// damaged" — a dead end that reads as a broken build rather than as a wrong
// download. Deciding which of the two this Mac needs is something the app
// knows and the page does not.
//
// So on macOS the update path downloads the image matching the architecture
// this app is itself running as, checks it against the release's own
// checksum, and reveals it in Finder. The operator still installs it. The
// Windows portable exe deliberately keeps the plain page: its release has one
// portable exe and no architecture to get wrong, and a copy in Downloads does
// not finish the job the way a .dmg does — the exe it would have to replace
// is the one running, which Windows will not let it overwrite.

// The suffixes come from electron-builder: the mac artifactName in
// package.json is AscendI-DICOM--., built for arm64
// and x64. If that name ever changes, this is the other half that has to.
const MAC_ARCH_SUFFIX = { arm64: '-arm64.dmg', x64: '-x64.dmg' };

/**
 * The disk image for this Mac, or null.
 *
 * process.arch is the architecture of the running Electron binary, which is
 * the right question to ask: an x64 build running under Rosetta on Apple
 * Silicon reports 'x64', and the thing that replaces it is the x64 image it
 * is a copy of. An architecture with no rule here returns null and the caller
 * falls back to the releases page — guessing is the exact failure this
 * exists to remove.
 */
function pickMacAsset(assets, arch) {
  const suffix = MAC_ARCH_SUFFIX[arch];
  if (!suffix || !Array.isArray(assets)) return null;
  // endsWith, not a substring test. The same release ships bare CLI binaries
  // named dcm-macos-arm64 and dcm-macos-x64, a -x64-portable.exe, and a
  // .dmg.blockmap beside each image; a substring match on the architecture
  // would hand a Mac any of them.
  return assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(suffix)) || null;
}

/** One named asset out of a release, or null. */
function findReleaseAsset(assets, name) {
  return (Array.isArray(assets) ? assets : []).find((a) => a && a.name === name) || null;
}

/**
 * What latest-mac.yml records for one file: its sha512 (base64) and size.
 *
 * Read by hand rather than adding a YAML dependency, because the file is
 * generated by electron-builder in one fixed shape and this needs two keys out
 * of it. Two things it must not do. It must stop at the end of the entry it
 * matched, and it must ignore anything at column 0: the feed repeats the
 * DEFAULT image's sha512 as a top-level key after the files list, so a reader
 * that ignored indentation would check an Intel download against the Apple
 * Silicon hash and reject a perfectly good file. Anything that does not match
 * the expected shape returns null, and the caller then says what it did check
 * rather than claiming a verification it did not do.
 */
function macFeedEntry(text, name) {
  let inEntry = false;
  let sha = null;
  let size = null;
  for (const line of String(text).split(/\r?\n/)) {
    const item = /^\s*-\s+url:\s*(\S+)\s*$/.exec(line);
    if (item) {
      if (inEntry) break; // the entry we wanted has ended
      inEntry = item[1] === name;
      continue;
    }
    if (!inEntry) continue;
    if (/^\S/.test(line)) break; // back at column 0: out of the files list
    const s = /^\s+sha512:\s*(\S+)\s*$/.exec(line);
    if (s) { sha = s[1]; continue; }
    const z = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (z) size = Number(z[1]);
  }
  return sha ? { sha512: sha, size } : null;
}

/** base64 sha512 of a file already on disk. */
function sha512OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.on('data', (d) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * A path in `dir` that nothing occupies. A download must never write over a
 * file that is already there: the likeliest occupant is the same image from an
 * earlier attempt, possibly mounted and mid-install right now.
 */
function freeFilePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate) && n < 100; n += 1) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

/** The release the last check matched, and the file it chose for this Mac. */
let macUpdate = null;
/** One at a time; a second click while a download runs is a no-op, not a race. */
let macFetchInFlight = false;

/**
 * Download the matched disk image to Downloads, check it, reveal it.
 *
 * Progress and failure go out on the same 'update:status' channel the Windows
 * path uses, so the sidebar banner stays the one place this is ever reported.
 */
async function downloadMacUpdate() {
  if (process.platform !== 'darwin' || !macUpdate) return { ok: false, reason: 'no-asset' };
  if (macFetchInFlight) return { ok: true, reason: 'in-flight' };
  macFetchInFlight = true;

  const { version, asset, feedAsset } = macUpdate;
  // basename, because this name comes off the network and is about to be
  // joined onto a directory path. GitHub will not mint an asset called
  // ../../something-arm64.dmg, and a release that could would mean worse
  // trouble than this — but the cost of not trusting it is one call.
  const name = path.basename(asset.name);
  const dir = app.getPath('downloads');
  let out = null;
  let part = null;

  // The invariant, in one place: a download that did not finish, or did not
  // check out, is never described as ready. It says what went wrong and puts
  // the releases page back in front of them — where they were before any of
  // this existed, which is a worse place but never a wrong one.
  const fail = (message) => {
    setUpdateState({ status: 'error', version, name, message, fallback: 'releases' });
    return { ok: false, reason: 'failed', error: message };
  };

  setUpdateState({
    status: 'fetching', version, name, percent: 0, received: 0, total: asset.size || 0,
  });

  try {
    // The release's own checksum, from the feed electron-builder publishes
    // beside the images. Fetched first, because if it is going to be missing
    // the banner has to say what was checked instead — and it costs half a
    // kilobyte to find out.
    let expect = null;
    if (feedAsset && feedAsset.browser_download_url) {
      try {
        const feed = await net.fetch(feedAsset.browser_download_url);
        if (feed.ok) expect = macFeedEntry(await feed.text(), name);
      } catch {
        /* no feed; the size check below is what is left */
      }
    }

    // Already fetched once. Re-pulling 100 MB to arrive at the same bytes is
    // not a kindness, so if the copy on disk checks out it is simply shown
    // again. A copy that does not check out is left alone and downloaded
    // beside it — it may be the one they are installing from right now.
    const existing = path.join(dir, name);
    if (fs.existsSync(existing)) {
      const ok = expect
        ? (await sha512OfFile(existing)) === expect.sha512
        : fs.statSync(existing).size === (asset.size || -1);
      if (ok) {
        shell.showItemInFolder(existing);
        setUpdateState({
          status: 'fetched', version, name, file: existing, checked: expect ? 'sha512' : 'size',
        });
        return { ok: true, file: existing };
      }
    }

    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok) return fail(`GitHub answered ${res.status}`);
    if (!res.body) return fail('the download returned no data');

    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const target = freeFilePath(dir, name);
    // Written as .part and renamed only after it checks out, so a failed or
    // abandoned download can never sit in Downloads looking like a disk image.
    // That file is precisely the one that gets opened a week later and blamed
    // on the signature.
    part = `${target}.part`;
    out = fs.createWriteStream(part);
    // A write-stream failure has to be able to interrupt whichever await is
    // running, or a dead stream leaves this loop waiting on a chunk that will
    // never be written. That is what the listener below does — but attached
    // and removed around each await, not raced against one long-lived promise.
    // Promise.race registers a reaction on its argument every pass, and while
    // that argument stays pending nothing releases them; each reaction pins the
    // promise it raced, which for a read is the one holding the chunk, so the
    // whole image accumulates in the main process. Measured here: a 300 MB
    // stream peaked 286 MB above baseline raced, 69 MB this way, and this way
    // does not grow with the file.
    let streamErr = null;
    out.on('error', (err) => { streamErr = streamErr || err; });
    const untilError = (promise) => new Promise((resolve, reject) => {
      if (streamErr) { reject(streamErr); return; }
      const onErr = (err) => reject(err);
      out.once('error', onErr);
      const settle = (fn) => (v) => { out.off('error', onErr); fn(v); };
      promise.then(settle(resolve), settle(reject));
    });

    const hash = crypto.createHash('sha512');
    const reader = res.body.getReader();
    let received = 0;
    let lastTick = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await untilError(reader.read());
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      received += chunk.length;
      // eslint-disable-next-line no-await-in-loop
      await untilError(new Promise((resolve, reject) => {
        out.write(chunk, (err) => (err ? reject(err) : resolve()));
      }));
      // Four times a second is enough for a progress number to look alive. One
      // message per chunk would be thousands of IPC round trips for one file,
      // every one of them landing on the renderer's main thread.
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        setUpdateState({
          status: 'fetching',
          version,
          name,
          received,
          total,
          // Held under 100 until the checks have actually passed. "100%" and
          // "not ready" on screen together is how a half-file gets opened.
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
        });
      }
    }
    // The loop exits on `done` without re-checking, and end() on a stream that
    // has already failed may never call back at all.
    if (streamErr) throw streamErr;
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });

    if (total && received !== total) {
      return fail(`the download stopped at ${received} of ${total} bytes`);
    }
    const digest = hash.digest('base64');
    if (expect && digest !== expect.sha512) {
      return fail('the file did not match the checksum published with the release');
    }
    if (!expect && asset.size && received !== asset.size) {
      return fail(`the file is ${received} bytes; the release says ${asset.size}`);
    }

    fs.renameSync(part, target);
    part = null;
    shell.showItemInFolder(target);
    setUpdateState({
      status: 'fetched',
      version,
      name: path.basename(target),
      file: target,
      // Which check was actually made, so the banner can say so. A size that
      // matches is not verification and is not worded as if it were.
      checked: expect ? 'sha512' : 'size',
    });
    return { ok: true, file: target };
  } catch (err) {
    return fail(err ? String(err.message || err) : 'unknown');
  } finally {
    if (out && !out.closed) {
      try { out.destroy(); } catch { /* already gone */ }
    }
    if (part) {
      try { fs.unlinkSync(part); } catch { /* nothing to remove */ }
    }
    macFetchInFlight = false;
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
  // Registered on every platform so a renderer can always ask. Off macOS, and
  // on a Mac whose architecture matched no asset, macUpdate is null and this
  // answers {ok:false}, which is the renderer's cue to open the page instead.
  ipcMain.handle('update:download', () => downloadMacUpdate());
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

  const migrated = migrateLegacyUserData();
  if (migrated.carried.length) {
    // "Where did my peers go?" gets asked once per rename. This is the line
    // that answers it, in the log the support team already asks for.
    process.stderr.write(
      `carried ${migrated.carried.map((c) => c.file).join(', ')} forward from a previous product name\n`
    );
  }

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
        // The asset picker, the feed reader and the state-file migration are
        // pure functions over paths and lists, and they are the parts that can
        // be checked from any machine without a Mac and without touching a
        // real user-data directory. Handed over rather than exported, because
        // requiring main.js from the harness would run this file a second time.
        require('./test/smoke').runSmoke(mainWindow, app, {
          pickMacAsset,
          macFeedEntry,
          migrateStateFiles,
          STATE_FILES,
          LEGACY_PRODUCT_DIRS,
        });
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
