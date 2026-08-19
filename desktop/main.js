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

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
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

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0e1420',
    title: 'Asteris DICOM',
    icon: process.platform === 'linux'
      ? path.join(__dirname, 'build', 'icon.png')
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC: running the engine
// ---------------------------------------------------------------------------

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

  const child = spawn(process.execPath, [ENGINE.entry, ...argv], {
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

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (text) => send('dcm:chunk', { runId, stream: 'stdout', text }));
  child.stderr.on('data', (text) => send('dcm:chunk', { runId, stream: 'stderr', text }));

  child.on('error', (err) => {
    send('dcm:chunk', { runId, stream: 'stderr', text: `failed to launch engine: ${err.message}\n` });
    send('dcm:exit', { runId, code: 127, signal: null });
    children.delete(runId);
  });

  child.on('close', (code, signal) => {
    send('dcm:exit', { runId, code: code ?? (signal ? 143 : 0), signal });
    children.delete(runId);
  });

  return { runId };
}

/** Stops a running child (used for the receiver's Stop button, or cancel). */
function cancelRun(_event, runId) {
  const child = children.get(runId);
  if (!child) return { stopped: false };
  try {
    // On Windows there is no SIGINT for a non-console child; kill() terminates it.
    child.kill();
    return { stopped: true };
  } catch (err) {
    return { stopped: false, error: err.message };
  }
}

app.whenReady().then(() => {
  ipcMain.handle('dcm:info', () => ({
    version: ENGINE.version,
    entry: ENGINE.entry,
    platform: process.platform,
    home: app.getPath('home'),
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

  ipcMain.handle('dcm:reveal', (_event, target) => {
    if (target && fs.existsSync(target)) {
      shell.showItemInFolder(target);
      return { ok: true };
    }
    return { ok: false };
  });

  createWindow();

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
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
