'use strict';

/**
 * Headless smoke driver.
 *
 * Loaded from main.js only when DCM_SMOKE_DIR is set, so it never touches a
 * normal launch. It is how this app is verified without a human at a display:
 * it walks every screen, screenshots each, measures what an operator has to
 * read before the button they are about to press, drives real engine runs —
 * an inventory, a send at every speed preset, a whole worklist/MPPS station
 * flow against a receiver it starts itself — and then floods the console three
 * ways to prove the window cannot be wedged by output.
 *
 * It starts its own peers. Two `dcm scp` children run for the length of the
 * run: a RIS (worklist + MPPS, from a worklist fixture this file writes) and an
 * Archive (images). That is the shape the app is built around — one peer holds
 * the RIS role, another the Archive role — and a harness that faked either of
 * them would not be testing the thing that broke in the field.
 *
 * Environment:
 *   DCM_SMOKE_DIR        required. Screenshots, artefacts and userData.
 *   DCM_SMOKE_FIXTURES   a folder of DICOM files (the repo's fixtures/study-1).
 *   DCM_SMOKE_RIS_PORT   pin the RIS receiver's port (default: a free one).
 *   DCM_SMOKE_PEER_PORT  pin the Archive receiver's port (default: a free one).
 *   DCM_SMOKE_FLOOD_LINES  lines per flood pass (default 200000).
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
// This file only ever runs inside the main process, which has already loaded
// electron; taking ipcMain from it is how the native folder dialog is answered
// without one being put on a screen nobody is looking at. See armPicker().
const { ipcMain } = require('electron');

/** The engine this app spawns, vendored by copy-engine.js. */
const ENGINE_ENTRY = path.join(__dirname, '..', 'engine', 'bin', 'dcm.js');

// ---------------------------------------------------------------------------
// The screens, as the redesign left them.
//
// Eight sidebar screens plus Settings, and Echo, which is reached from a peer
// chip or from Settings rather than from the sidebar. DICOMweb and Tools each
// hold four tabbed panes that kept their old `view-<name>` ids, so every
// builder, status chip and console still resolves through them.
// ---------------------------------------------------------------------------
const SECTIONS = [
  'worklist', 'send', 'receive', 'query', 'web', 'tools', 'speed', 'mcp', 'settings', 'echo',
];
const TABS = {
  web: ['webping', 'websend', 'webquery', 'webhub'],
  tools: ['inventory', 'tags', 'rename', 'edit', 'anon'],
};
/** Which section a tab lives in. */
const TAB_SECTION = {};
for (const [group, tabs] of Object.entries(TABS)) for (const t of tabs) TAB_SECTION[t] = group;

/** Every pane that runs a command, and therefore must carry a folded command line. */
const RUN_PANES = ['worklist', 'send', 'receive', 'query', 'speed', 'echo', ...TABS.web, ...TABS.tools];

/**
 * The word budget, per screen.
 *
 * The design rule is that no screen may put more than 60 visible words above
 * its primary button — Connect to Claude is the one exception, at 120, because
 * it is instructions rather than a command. Under that ceiling each screen has
 * its own, pinned a few words above what the redesign actually landed on, so
 * prose creeping back onto a screen fails here rather than in front of an
 * operator. Anything a screen genuinely needs to say still exists: it lives in
 * the help panel behind the ?, which is not counted, because nobody has to read
 * it to act.
 *
 * What is counted: visible words in the pane, in document order, stopping at
 * the container holding the primary button. Hidden elements and closed
 * disclosure bodies are excluded (a closed <details> body has no layout, so it
 * drops out on its own; its summary stays, because the summary is on screen).
 * So are the things that are data rather than the screen's own words: the peer
 * chip, the command fold, results tables, the console, the attribute grid, the
 * status chip and the help panel.
 */
const BUDGET = {
  'worklist-list': 17,   // the station with nothing selected: the whole screen
  worklist: 60,          // the station with a row selected, above "Perform exam"
  // The station with its repair notes showing — the row has left the list, or
  // the folder could not be read, or both. A repair is allowed to cost words
  // that the ordinary screen is not, because it has to say what is wrong and
  // the button below it is dead anyway. It still has a ceiling: without one,
  // "the screen where it is fine to explain things" is how the prose the
  // redesign moved into the help panel walks back onto the station.
  'worklist-gone': 60,       // a row that left the list, folder fine
  'worklist-repairs': 70,    // and the folder unread on top of it
  send: 46,
  receive: 34,
  query: 27,
  echo: 16,
  webping: 22,
  websend: 22,
  webquery: 28,
  webhub: 42,
  inventory: 22,
  tags: 36,
  // Rename is measured twice, like the station: the screen an operator walks
  // up to (a folder box and nothing else) and the screen they act on, with a
  // study loaded and the four boxes filled. The second number carries the one
  // part of this pane that varies with the data rather than the design — the
  // composed PatientName is echoed back in full, so a five-part name reads as
  // more words than a two-part one.
  rename: 20,
  'rename-loaded': 52,
  edit: 44,
  anon: 44,
  speed: 46,
  mcp: 120,              // instructions, not a command: its own budget
  // Settings has none on purpose. It is the screen the other screens were
  // emptied into — set once, read once — and it runs no command, so there is
  // no button to be standing in front of. It is still measured and reported,
  // because a number nobody looks at is how a screen becomes this one twice.
};

/**
 * How long a wait for an engine child may take.
 *
 * Every run here spawns a real `dcm` process, and how long that takes is a
 * fact about the machine, not about the command: on a laptop whose antivirus
 * scans each launch, the same `dcm info` has been measured at 0.7s and at 33s
 * in the same minute. One generous bound, in one place, so a slow machine
 * reads as slow rather than as a broken app. DCM_SMOKE_RUN_MS overrides it.
 */
const RUN_MS = Number(process.env.DCM_SMOKE_RUN_MS || 150000);

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A free TCP port on the loopback interface. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(String(port)));
    });
  });
}

/** DICOM date for today, or today plus a number of days. */
function dicomDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Renderer plumbing
// ---------------------------------------------------------------------------
let WIN = null;
let OUT = '';
const measured = [];
const shotFailures = [];

const say = (line) => process.stdout.write(`${line}\n`);
const record = (line) => { say(line); measured.push(line); };

/** Evaluate an expression in the renderer. */
function js(expr) {
  return WIN.webContents.executeJavaScript(expr);
}

/** Evaluate an expression whose value is a JSON string, and parse it. */
async function jsJSON(expr) {
  return JSON.parse(await js(expr));
}

function bad(msg) {
  throw new Error(msg);
}

/**
 * Does a rendered command name this path?
 *
 * The app puts a path into the command exactly as it sits in the field, and
 * the field holds what the operator typed or what the picker handed back — on
 * Windows, backslashes. These assertions used to compare against one spelling
 * (`fixtures.replace(/\\/g, '/')`), which made the whole harness pass only when
 * DCM_SMOKE_FIXTURES happened to be supplied with forward slashes: given the
 * natural `C:\...\fixtures\study-1` it died at H1. Worse, the two NEGATIVE
 * uses — "the start command must NOT name the folder" — passed vacuously for
 * the same reason, so the harness was at its least trustworthy exactly where
 * it looked strictest.
 *
 * Comparing on a separator-normalised form accepts either spelling of the same
 * folder and still rejects a different one.
 */
const slashes = (s) => String(s).replace(/\\/g, '/');
const cmdNames = (cmd, p) => slashes(cmd).includes(slashes(p));

/**
 * Waits until an expression evaluates truthy in the renderer.
 *
 * Screens that spawn a real engine child finish when the child finishes, not
 * after a guessed number of milliseconds, and a guess that is usually long
 * enough is the kind of test that fails on somebody else's machine.
 *
 * @returns {Promise<boolean>} false if it timed out.
 */
async function waitFor(expr, ms = 20000, label = expr) {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await js(`!!(${expr})`).catch(() => false);
    if (ok) return true;
    if (Date.now() > deadline) {
      say(`waitFor timed out after ${ms}ms: ${label}`);
      return false;
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(150);
  }
}

/** Same, but a timeout is a failure rather than a report. */
async function mustWait(expr, ms, label) {
  if (await waitFor(expr, ms, label)) return;
  // A renderer exception is the usual reason something never finishes, and
  // reading it here beats reading a timeout and guessing.
  const errs = await js('JSON.stringify(window.__errors || [])').catch(() => '[]');
  if (errs && errs !== '[]') say(`renderer errors at that point: ${errs}`);
  bad(`timed out waiting for ${label}`);
}

/**
 * A screenshot, and never a reason the run cannot finish.
 *
 * capturePage stops returning frames when the machine's display sleeps mid-run,
 * which is not a defect in the app. A frame that cannot be taken is counted and
 * named at the end rather than being allowed to end the run.
 */
async function shot(name) {
  try {
    const image = await Promise.race([
      WIN.webContents.capturePage(),
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ]);
    if (!image) throw new Error('capturePage returned no frame within 15s');
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
    say(`shot: ${name}.png`);
  } catch (err) {
    shotFailures.push(`${name}: ${err.message}`);
    say(`shot FAILED: ${name} — ${err.message}`);
  }
}

function artefact(name, text) {
  fs.writeFileSync(path.join(OUT, name), text == null ? '' : String(text));
}

// ---------------------------------------------------------------------------
// Helpers installed in the renderer
//
// The measuring rule lives here rather than being composed into a dozen
// separate expressions, so every screen is measured by exactly the same code.
// ---------------------------------------------------------------------------
const HELPERS = `(() => {
  // Data, not the screen's own words: the peer chip, the command fold, the
  // console, result tables, the attribute grid, the status chip, and the help
  // panel — which is the place the prose was deliberately moved to.
  const SKIP = '[hidden], .help-panel, details.cmd-fold, .console-wrap, [data-result],'
    + ' #mwl-results, #speed-progress, #mpps-attrs, .conn-host, [data-webconn], .peer-menu,'
    + ' .status-chip, #mpps-outcome, #mpps-totals, [data-totals]';
  const WORD = /[A-Za-z0-9][A-Za-z0-9'\\u2019-]*/g;
  const vis = (el) => !!(el.offsetParent || el.getClientRects().length);

  function walk(el, stop, acc) {
    if (!vis(el) || el.matches(SKIP)) return false;
    // A closed disclosure is one line on screen, not the form inside it.
    // Chromium keeps the body laid out, so it has to be excluded by hand
    // rather than by asking whether it is visible.
    if (el.tagName === 'DETAILS' && !el.open) {
      const sum = el.querySelector('summary');
      return sum ? walk(sum, stop, acc) : false;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const w = node.data.match(WORD) || [];
        acc.words += w.length;
        if (w.length) acc.text.push(w.join(' '));
        continue;
      }
      if (node.nodeType !== 1) continue;
      // Stop at the primary button: what is counted is what an operator reads
      // on the way down to it. Containers are descended into rather than
      // skipped whole — the button is nested several deep on the station.
      if (stop && node === stop) return true;
      if (walk(node, stop, acc)) return true;
    }
    return false;
  }

  window.__smoke = {
    vis,
    /**
     * Every engine child the renderer has started since this was last emptied.
     *
     * Filled by a wrapper the harness puts around runCapture when it needs to
     * know whether one gesture spawned one process or two — a doubled folder
     * scan shows up nowhere on screen, only here.
     */
    spawns: [],
    /** Visible words above a pane's primary button, and the controls beside them. */
    measure(paneSel, stopSel) {
      const root = document.querySelector(paneSel);
      if (!root) return null;
      let stop = stopSel ? root.querySelector(stopSel) : null;
      if (stop && !vis(stop)) stop = null;
      if (!stop && !stopSel) stop = Array.from(root.querySelectorAll('[data-run]')).filter(vis)[0] || null;
      const acc = { words: 0, text: [] };
      walk(root, stop, acc);
      return {
        words: acc.words,
        text: acc.text.join(' / '),
        controls: Array.from(root.querySelectorAll('input, select, textarea'))
          .filter((el) => vis(el) && !el.closest('details:not([open])')).length,
        primary: stop ? (stop.textContent || '').trim() : '(none)',
      };
    },

    /** Every command fold in a pane: whether it is folded, and what it says folded and open. */
    folds(paneSel) {
      const root = document.querySelector(paneSel);
      if (!root) return [];
      return Array.from(root.querySelectorAll('details.cmd-fold'))
        .filter((d) => vis(d))
        .map((d) => ({
          id: d.id || '',
          open: d.open,
          sum: (d.querySelector('.cmd-sum') || {}).textContent || '',
          cmd: (d.querySelector('.cmd-preview') || {}).textContent || '',
        }));
    },

    /** Every DIMSE peer chip in a pane, as it reads on screen. */
    chips(paneSel) {
      return Array.from(document.querySelectorAll(paneSel + ' [data-conn]')).map((h) => ({
        role: h.dataset.role || 'any',
        name: (h.querySelector('.peer-name') || {}).textContent || '',
        from: (h.querySelector('.peer-from') || {}).textContent || '',
        unset: !!h.querySelector('.peer-chip.unset'),
      }));
    },

    /** Every builder's argv, plus the four that are not on BUILDERS. */
    argvs() {
      const out = {};
      for (const [k, fn] of Object.entries(BUILDERS)) {
        try { out[k] = fn(); } catch (e) { out[k] = ['<threw>', String(e && e.message)]; }
      }
      try { out['mpps.start'] = mppsStartArgv(); } catch (e) { out['mpps.start'] = ['<threw>']; }
      try { out['steps.complete'] = stepsCloseArgv('complete'); } catch (e) { out['steps.complete'] = ['<threw>']; }
      try { out['steps.discontinue'] = stepsCloseArgv('discontinue'); } catch (e) { out['steps.discontinue'] = ['<threw>']; }
      try { out['steps.send'] = stepsSendArgv('C:/smoke/study'); } catch (e) { out['steps.send'] = ['<threw>']; }
      return out;
    },

    /** Set a form field the way a person does, so every listener fires. */
    set(id, value) {
      const el = document.querySelector('#' + id);
      if (!el) throw new Error('no such field: ' + id);
      if (el.type === 'checkbox') {
        el.checked = !!value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    },

    /**
     * Whether the page scrolls sideways, and what is pushing it.
     *
     * A page-level horizontal scrollbar is the defect; the offender list is
     * only there so a failure names a selector rather than sending somebody
     * back to the screenshots. An element inside a container that clips on the
     * x axis is excluded — a table cell ellipsising is doing its job, and it
     * cannot move the page. Everything else whose right edge is past the
     * document's client width is reported, outermost first.
     */
    overflow() {
      // The window's own scroller is NOT documentElement: .content carries
      // overflow-y:auto, which CSS promotes overflow-x to auto as well, so the
      // sideways scrollbar an operator sees along the bottom of the window
      // belongs to .content and documentElement.scrollWidth never moves. A
      // check that asked only the document would pass over a window that is
      // visibly scrolling sideways — it did.
      //
      // These three are the shell. A container that opts into overflow-x
      // itself — the results table, the console — is not one of them: scrolling
      // a wide table inside its own box is the fix, not the defect.
      const shells = [document.documentElement, document.body, document.querySelector('.content')]
        .filter(Boolean);
      const name = (el) => {
        const cls = typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
        return (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls).slice(0, 90);
      };
      const worst = shells
        .map((el) => ({ el, sel: name(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
        .sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))[0];

      // What is sticking out of it, outermost first. Anything inside a box
      // that clips or scrolls on its own account is skipped: it cannot move
      // the shell, so it is not what is being looked for here.
      const shell = worst.el;
      const box = shell.getBoundingClientRect();
      const limit = box.left + shell.clientWidth;
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== shell; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') return true;
        }
        return false;
      };
      const offenders = [];
      for (const el of shell.querySelectorAll('*')) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.right <= limit + 1) continue;
        if (clipped(el)) continue;
        if (offenders.some((o) => o.el.contains(el))) continue;
        offenders.push({ el, sel: name(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
      return {
        shell: worst.sel,
        scrollWidth: worst.scrollWidth,
        clientWidth: worst.clientWidth,
        offenders: offenders.slice(0, 6).map(({ sel, right, width }) => ({ sel, right, width })),
      };
    },

    /**
     * Text cut off mid-word inside a container, rather than wrapped.
     *
     * Distinct from overflow(): this is the panel that fits on the page but
     * whose own contents do not fit in it. Elements that ellipsise on purpose
     * are excluded, as are inputs, whose value legitimately scrolls.
     */
    clipping(rootSel) {
      const root = document.querySelector(rootSel);
      if (!root) return [];
      const out = [];
      for (const el of root.querySelectorAll('*')) {
        if (!vis(el)) continue;
        if (el.matches('input, textarea, select')) continue;
        const cs = getComputedStyle(el);
        if (cs.textOverflow === 'ellipsis') continue;
        if (cs.overflowX === 'visible' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          out.push({ sel: (el.id ? '#' + el.id : el.tagName.toLowerCase()),
            scroll: el.scrollWidth, client: el.clientWidth });
        }
      }
      return out;
    },

    /** The console text of a view, whichever disclosure it lives in. */
    consoleText(view) {
      const c = consoleEl(view);
      return c ? c.textContent : '';
    },

    /** Whether a view's Output disclosure is open. */
    outOpen(view) {
      const c = consoleEl(view);
      const d = c && c.closest('details');
      return !!(d && d.open);
    },
  };
  window.__errors = window.__errors || [];
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandled rejection: ' + String(e.reason)));
  return true;
})()`;

// ---------------------------------------------------------------------------
// The peers this harness runs
// ---------------------------------------------------------------------------
const peers = [];

/**
 * Starts a `dcm scp` and waits until it says it is listening.
 *
 * Spawned the same way main.js spawns the engine — this Electron binary in
 * node mode against the vendored engine — so the receiver under test is the
 * same code the app itself would run.
 */
function startPeer(label, argv, logBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENGINE_ENTRY, ...argv], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', DCM_NONINTERACTIVE: '1' },
      windowsHide: true,
    });
    const out = fs.createWriteStream(`${logBase}.out`);
    const err = fs.createWriteStream(`${logBase}.err`);
    child.stdout.pipe(out);
    let seen = '';
    let settled = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (t) => {
      err.write(t);
      seen += t;
      if (!settled && /listening on port/.test(seen)) {
        settled = true;
        say(`peer ${label}: ${seen.split('\n')[0].trim()}`);
        resolve(child);
      }
    });
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`${label} exited ${code} before listening: ${seen}`)); }
    });
    peers.push({ label, child });
    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`${label} never said it was listening: ${seen}`)); }
    }, 20000);
  });
}

/**
 * Runs one engine command to completion and hands back what it said.
 *
 * The app's own runs all go through the renderer, which is the point — this is
 * only for building the material a screen is then pointed at, such as a second
 * study to make a folder the Rename tab has to refuse. Same spawn shape as the
 * peers, so it is the vendored engine rather than whatever is on PATH.
 */
function runEngine(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENGINE_ENTRY, ...argv], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', DCM_NONINTERACTIVE: '1' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (t) => { out += t; });
    child.stderr.on('data', (t) => { err += t; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

function stopPeers() {
  for (const p of peers) {
    try { p.child.kill(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Pressing the app's own Browse… buttons
//
// Until this existed, nothing in the suite had ever driven a [data-pick]
// button. Every route the harness had into a path field went through
// __smoke.set(), which dispatches input AND change — so every one of them took
// a branch that worked, and the branch a picked path actually took was never
// run once. It was broken: wirePickers announced the chosen path with `change`
// alone, the station's invalidate-and-rescan hung off `input`, and Browse…
// therefore left the previous verdict on screen with the verbs live over a
// folder nothing had read. The engine refused those runs with exit 2, in the
// field, on the one route an operator is most likely to take.
//
// The only thing replaced here is the native dialog, which cannot open on a
// headless machine: main.js's 'dcm:pick' IPC handler. Everything on either
// side of it is the app's own — the click on the real button, the
// contextBridge call in preload, the handler in wirePickers, and every
// listener the events it dispatches reach.
// ---------------------------------------------------------------------------

/** What the next dialog answers with. null is exactly what Cancel returns. */
let pickAnswer = null;

/**
 * Takes over 'dcm:pick' for the rest of the run.
 *
 * Not restored afterwards, deliberately: a real showOpenDialog raised during a
 * headless run would block until the harness timed out, so once the dialog is
 * off it stays off.
 */
function armPicker() {
  ipcMain.removeHandler('dcm:pick');
  ipcMain.handle('dcm:pick', async () => ({ path: pickAnswer }));
}

/**
 * Presses a Browse… button and waits for the path to land in its field.
 *
 * The snapshot comes back from the same renderer turn the field changed in —
 * before the station's 350ms scan debounce can have fired — because that
 * instant is where the defect lived: the new path was in the field and nothing
 * had yet reacted to it.
 *
 * @param {string} targetId    the field the button fills, e.g. 'mpps-folder'.
 * @param {string} folder      what the dialog will answer.
 * @param {string} [readExpr]  a renderer expression for extra state to capture
 *                             at that instant, merged into the result.
 */
async function pressPicker(targetId, folder, readExpr = '({})') {
  if (!folder) bad(`pressPicker needs a folder for #${targetId}`);
  pickAnswer = folder;
  const out = await jsJSON(`(async () => {
    const field = document.querySelector('#${targetId}');
    const btn = document.querySelector('[data-pick="${targetId}"]');
    if (!field || !btn) throw new Error('no picker for ${targetId}');
    const before = field.value;
    btn.click();
    // wirePickers awaits an IPC round trip, so yield until the field moves.
    // Only ever called with a path the field is not already holding, which is
    // what makes "it moved" a usable signal.
    for (let i = 0; i < 600 && field.value === before; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return JSON.stringify(Object.assign({ value: field.value }, ${readExpr}));
  })()`);
  if (out.value !== folder) {
    bad(`Browse… did not put the chosen path into #${targetId}: ${JSON.stringify(out.value)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('electron').App} app
 */

// ---------------------------------------------------------------------------
// The macOS update path.
//
// Fixtures, not guesses: these are the fourteen asset names of the real
// v0.15.0 release and the real latest-mac.yml published with it. They are
// checked in here rather than fetched so the harness stays offline and so a
// release that changes shape has to change this file too.
//
// They keep the old product name deliberately. v0.15.0 shipped as
// Asteris-DICOM-App-*, those sha512s belong to those exact files, and editing
// them to match the AscendI rename would turn a real fixture into a made-up
// one. The post-rename naming is checked separately, further down.
// ---------------------------------------------------------------------------
const V15_ASSET_NAMES = [
  'Asteris-DICOM-App-0.15.0-arm64.dmg',
  'Asteris-DICOM-App-0.15.0-arm64.dmg.blockmap',
  'Asteris-DICOM-App-0.15.0-x64-portable.exe',
  'Asteris-DICOM-App-0.15.0-x64-setup.exe',
  'Asteris-DICOM-App-0.15.0-x64-setup.exe.blockmap',
  'Asteris-DICOM-App-0.15.0-x64.dmg',
  'Asteris-DICOM-App-0.15.0-x64.dmg.blockmap',
  'dcm-linux-x64',
  'dcm-macos-arm64',
  'dcm-macos-x64',
  'dcm-windows-x64.exe',
  'latest-mac.yml',
  'latest.yml',
  'SHA256SUMS.txt',
];
const V15_ARM = 'Asteris-DICOM-App-0.15.0-arm64.dmg';
const V15_X64 = 'Asteris-DICOM-App-0.15.0-x64.dmg';
const V15_ARM_SHA = 'dpXf+t1Z39zPFeaygmpjwRuwTD94BstSwhhP79jieS5EzRtzrg0tp/uTbJP9fp1XJgdeSzII3qfMUaImbfL5/A==';
const V15_X64_SHA = 'l54v4/kfoWwVtEmyJCwBh1VT8QFVR6/jrZMTnOSeIOnFMzyeal1eDfrpxxZGoGzfrYr69/Aw5W8vL61ibH3j9w==';
// Verbatim, including the two top-level keys after the list. Those are the
// trap: the file repeats the DEFAULT image's sha512 at column 0 immediately
// after the x64 entry, so a reader that ignored indentation would check an
// Intel download against the Apple Silicon hash.
const V15_MAC_FEED = [
  'version: 0.15.0',
  'files:',
  '  - url: Asteris-DICOM-App-0.15.0-arm64.dmg',
  `    sha512: ${V15_ARM_SHA}`,
  '    size: 102407035',
  '  - url: Asteris-DICOM-App-0.15.0-x64.dmg',
  `    sha512: ${V15_X64_SHA}`,
  '    size: 109497714',
  'path: Asteris-DICOM-App-0.15.0-arm64.dmg',
  `sha512: ${V15_ARM_SHA}`,
  "releaseDate: '2026-09-09T02:46:32.709Z'",
].join('\n');

async function runSmoke(win, app, mainHelpers = {}) {
  WIN = win;
  OUT = process.env.DCM_SMOKE_DIR;
  const fixtures = process.env.DCM_SMOKE_FIXTURES || '';
  fs.mkdirSync(OUT, { recursive: true });
  const work = path.join(OUT, 'work');
  fs.mkdirSync(work, { recursive: true });

  try {
    await js('true').catch(() => {});
    // boot() is async (engine info, settings, profiles, app state), so wait for
    // the thing that only exists once it has finished rather than for a delay.
    await mustWait('typeof showView === "function" && state.settings !== null && !!document.querySelector(".view.active")',
      20000, 'the renderer to finish booting');
    await js(HELPERS);

    // =====================================================================
    // A. Boot invariants: where the app lands, and how it recovers.
    // =====================================================================
    const statePath = path.join(app.getPath('userData'), 'app-state.json');
    let remembered = {};
    try { remembered = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch { remembered = {}; }
    const landed = await jsJSON(`JSON.stringify({
      view: state.activeView,
      active: (document.querySelector('.view.active') || {}).id || '',
      nav: (document.querySelector('.nav-item.active') || {}).textContent.trim(),
      tabs: state.tabs,
    })`);
    record(`boot: landed on ${landed.view} (${landed.active}), sidebar shows "${landed.nav}"; `
      + `app-state.json remembered ${JSON.stringify(remembered.activeView || null)}`);
    // Worklist is the landing screen. With nothing remembered that is the
    // default; with a remembered screen the app reopens where it was left, and
    // with a name that no longer exists it falls back here rather than to a
    // blank page. The harness resets app-state.json on the way out, so the
    // next run exercises the first of those.
    const expectLanding = remembered.activeView && typeof remembered.activeView === 'string'
      ? remembered.activeView : 'worklist';
    if (landed.view !== expectLanding && landed.view !== 'worklist') {
      bad(`the app opened on ${landed.view}, not the remembered ${expectLanding} nor the worklist`);
    }
    if (!remembered.activeView && landed.view !== 'worklist') {
      bad(`with nothing remembered the app must land on the worklist, not ${landed.view}`);
    }
    if (landed.active !== `view-${landed.view}`) {
      bad(`the active section is ${landed.active} while state says ${landed.view}`);
    }

    // Worklist is the landing screen for anything the app cannot resolve —
    // nothing remembered, an empty value, or the name of a screen that no
    // longer exists. boot() passes `remembered.activeView || 'worklist'`
    // straight into showView, so these are the same three cases a first launch
    // and an upgraded install take.
    const nav = await jsJSON(`(() => {
      const landings = {};
      for (const [label, value] of [['nothing', undefined], ['empty', ''], ['null', null]]) {
        showView(value);
        landings[label] = state.activeView;
      }
      showView('a-screen-that-no-longer-exists');
      const fallback = state.activeView;
      showView('webquery');
      const legacy = { view: state.activeView, tab: state.tabs.web,
        pane: !document.querySelector('#view-webquery').hidden };
      showView('tags');
      const legacy2 = { view: state.activeView, tab: state.tabs.tools };
      return JSON.stringify({ landings, fallback, legacy, legacy2 });
    })()`);
    record(`boot: with ${Object.entries(nav.landings).map(([k, v]) => `${k} -> ${v}`).join(', ')} and an `
      + `unknown name -> ${nav.fallback}, the landing screen is the worklist`);
    say(`boot: legacy 'webquery' -> ${nav.legacy.view}/${nav.legacy.tab}; `
      + `legacy 'tags' -> ${nav.legacy2.view}/${nav.legacy2.tab}`);
    for (const [label, view] of Object.entries(nav.landings)) {
      if (view !== 'worklist') bad(`a remembered screen of ${label} landed on ${view}, not the worklist`);
    }
    if (nav.fallback !== 'worklist') bad(`an unknown screen name landed on ${nav.fallback}, not the worklist`);
    if (nav.legacy.view !== 'web' || nav.legacy.tab !== 'webquery' || !nav.legacy.pane) {
      bad(`the legacy name 'webquery' did not open the web section's Query tab: ${JSON.stringify(nav.legacy)}`);
    }
    if (nav.legacy2.view !== 'tools' || nav.legacy2.tab !== 'tags') {
      bad(`the legacy name 'tags' did not open the tools section's Tags tab: ${JSON.stringify(nav.legacy2)}`);
    }

    // And the screen that is open is written down, so the next launch reopens
    // it. Read off disk rather than out of state: the file is the whole
    // mechanism, and a write that never lands is the way this quietly breaks.
    await js(`showTab('tools', 'anon'); showView('speed'); true`);
    await wait(400);
    let persisted = {};
    try { persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { persisted = {}; }
    say(`boot: app-state.json now holds ${JSON.stringify({ activeView: persisted.activeView, activeTabs: persisted.activeTabs })}`);
    if (persisted.activeView !== 'speed' || (persisted.activeTabs || {}).tools !== 'anon') {
      bad(`the open screen and tab were not written down: ${JSON.stringify(persisted)}`);
    }

    // =====================================================================
    // B. The peers, and Settings.
    //
    // Two real receivers: one is the RIS (worklist and MPPS), the other the
    // Archive (images). The app's whole peer model is that those are separate
    // roles that may be separate systems, so the harness gives it two.
    // =====================================================================
    const risPort = process.env.DCM_SMOKE_RIS_PORT || await freePort();
    const archivePort = process.env.DCM_SMOKE_PEER_PORT || await freePort();
    const today = dicomDate(0);
    const FIX_STUDY = '1.2.826.0.1.3680043.10.1337.1'; // the study fixtures/study-1 carries
    const worklistFile = path.join(work, 'worklist.json');
    const rows = [
      // 1. The matching case: this row names the study the fixtures carry.
      { PatientName: 'SMITH^ALAN', PatientID: 'P-2002', AccessionNumber: 'ACC-78',
        StudyInstanceUID: FIX_STUDY, Modality: 'CT', ScheduledProcedureStepID: 'SPS-2',
        ScheduledProcedureStepStartDate: today, ScheduledProcedureStepStartTime: '101500',
        ScheduledStationAETitle: 'CT01', RequestedProcedureDescription: 'Chest 2 View',
        RequestedProcedureID: 'RP-6', PatientBirthDate: '19700101', PatientSex: 'M' },
      // 2. The mismatch case: a study no folder on this machine could carry.
      { PatientName: 'DOE^JANE', PatientID: 'P-1001', AccessionNumber: 'ACC-77',
        StudyInstanceUID: '2.25.740955813516667957464775902172421126', Modality: 'CT',
        ScheduledProcedureStepID: 'SPS-1', ScheduledProcedureStepStartDate: today,
        ScheduledProcedureStepStartTime: '093000', ScheduledStationAETitle: 'CT01',
        RequestedProcedureDescription: 'CT Abdomen', RequestedProcedureID: 'RP-5',
        PatientBirthDate: '19700101', PatientSex: 'F' },
      // 3. Start only, then add images and complete. It names the study the
      //    fixtures carry, because `dcm send` re-stamps nothing: images added
      //    to an open step have to be that step's study or they cannot be
      //    added at all (row 4 is where that refusal is exercised).
      { PatientName: 'LEE^MIN', PatientID: 'P-3003', AccessionNumber: 'ACC-79',
        StudyInstanceUID: FIX_STUDY, Modality: 'CT',
        ScheduledProcedureStepID: 'SPS-3', ScheduledProcedureStepStartDate: today,
        ScheduledProcedureStepStartTime: '111500', ScheduledStationAETitle: 'CT01',
        RequestedProcedureDescription: 'CT Head', RequestedProcedureID: 'RP-7',
        PatientBirthDate: '19800202', PatientSex: 'F' },
      // 4. Start only, then discontinue with a reason code.
      { PatientName: 'PARK^SOO', PatientID: 'P-4004', AccessionNumber: 'ACC-80',
        StudyInstanceUID: '2.25.400400400400400400400400400400', Modality: 'CT',
        ScheduledProcedureStepID: 'SPS-4', ScheduledProcedureStepStartDate: today,
        ScheduledProcedureStepStartTime: '121500', ScheduledStationAETitle: 'CT01',
        RequestedProcedureDescription: 'CT Pelvis', RequestedProcedureID: 'RP-8',
        PatientBirthDate: '19900303', PatientSex: 'M' },
    ];
    fs.writeFileSync(worklistFile, JSON.stringify(rows, null, 2));

    await startPeer('RIS', ['scp', '--port', risPort, '--ae', 'RISMPPS',
      '--worklist', worklistFile, '--persist', path.join(work, 'ris-store')],
    path.join(work, 'peer-ris'));
    await startPeer('ARCHIVE', ['scp', '--port', archivePort, '--ae', 'ARCHIVE',
      '--persist', path.join(work, 'archive-store')],
    path.join(work, 'peer-archive'));

    // Settings is set through its own form, because that is the only way an
    // operator can set it. The saved peers are cleared first: this userData
    // directory is reused across runs and the ports move every time.
    await js(`(async () => {
      state.profiles = [];
      state.peerChoice = {};
      await window.dcm.profiles.set({ profiles: [] });
      refreshPeerViews();
      showView('settings');
    })(); true`);
    await wait(200);
    await js(`(() => {
      __smoke.set('set-station-ae', 'CT01');
      __smoke.set('set-modality', 'CT');
      return true;
    })()`);
    await mustWait('state.settings.stationAe === "CT01" && state.settings.modality === "CT"',
      8000, 'Settings to take the station AE');

    const addPeer = async (host, port, ae, role, callingAe = '') => {
      await js(`(() => {
        document.querySelector('#peer-host').value = ${JSON.stringify(host)};
        document.querySelector('#peer-port').value = ${JSON.stringify(String(port))};
        document.querySelector('#peer-ae').value = ${JSON.stringify(ae)};
        document.querySelector('#peer-callingae').value = ${JSON.stringify(callingAe)};
        document.querySelector('#peer-role').value = ${JSON.stringify(role)};
        document.querySelector('#peer-save').click();
        return true;
      })()`);
      await mustWait(`state.profiles.some((p) => p.name === ${JSON.stringify(`${ae} @ ${host}:${port}`)})`,
        8000, `the ${role} peer to be saved`);
    };
    await addPeer('127.0.0.1', risPort, 'RISMPPS', 'ris');
    await addPeer('127.0.0.1', archivePort, 'ARCHIVE', 'archive');
    const RIS_PEER = `RISMPPS @ 127.0.0.1:${risPort}`;
    const ARCHIVE_PEER = `ARCHIVE @ 127.0.0.1:${archivePort}`;
    record(`peers: RIS ${RIS_PEER}, Archive ${ARCHIVE_PEER}`);
    await shot('settings-peers');

    // One RIS and one Archive: a role a second peer takes is a role the first
    // one loses, because a screen pre-selects "the" peer for its role and two
    // candidates would make that a guess.
    const roleSteal = await jsJSON(`(() => {
      setPeerRole(${JSON.stringify(ARCHIVE_PEER)}, 'ris');
      const after = dimseProfiles().map((p) => [p.name, p.role || '']);
      setPeerRole(${JSON.stringify(RIS_PEER)}, 'ris');
      setPeerRole(${JSON.stringify(ARCHIVE_PEER)}, 'archive');
      refreshPeerViews();
      return JSON.stringify({ after, restored: dimseProfiles().map((p) => [p.name, p.role || '']) });
    })()`);
    say(`roles: giving RIS to the archive left ${JSON.stringify(roleSteal.after)}`);
    if (roleSteal.after.filter(([, r]) => r === 'ris').length !== 1) {
      bad(`two peers held the RIS role at once: ${JSON.stringify(roleSteal.after)}`);
    }
    if (JSON.stringify(roleSteal.restored) !== JSON.stringify([[RIS_PEER, 'ris'], [ARCHIVE_PEER, 'archive']])) {
      bad(`the roles did not come back: ${JSON.stringify(roleSteal.restored)}`);
    }

    // A peer may need to be talked to as something other than this station.
    // The station's AE Title is the answer for almost every peer and it is
    // what MPPS attributes a step to — but a site whose archive whitelists a
    // different caller from its RIS has to be able to talk to both, so a peer
    // carries an optional calling AE of its own and the chip says when it is
    // in force. Nothing hidden: it is on the command line either way.
    const overrideAe = await jsJSON(`(async () => {
      const edit = (calling) => {
        document.querySelector('[data-peer-edit="${ARCHIVE_PEER}"]').click();
        document.querySelector('#peer-callingae').value = calling;
        document.querySelector('#peer-save').click();
      };
      edit('CT01-ARC');
      await new Promise((r) => setTimeout(r, 300));
      showView('send');
      const on = {
        conn: state.conn.callingAe,
        chip: __smoke.chips('#view-send')[0],
        send: BUILDERS.send().join(' '),
        override: !!document.querySelector('#view-send .peer-from.override'),
      };
      showView('worklist');
      on.worklist = BUILDERS.worklist().join(' ');
      edit('');
      await new Promise((r) => setTimeout(r, 300));
      showView('send');
      const off = { conn: state.conn.callingAe, send: BUILDERS.send().join(' ') };
      showView('settings');
      return JSON.stringify({ on, off });
    })()`);
    record(`peers: the Archive with its own calling AE sends "--calling-ae ${overrideAe.on.conn}" `
      + `while the worklist still says "--calling-ae ${/--calling-ae (\S+)/.exec(overrideAe.on.worklist)?.[1]}"`);
    if (overrideAe.on.conn !== 'CT01-ARC' || !overrideAe.on.send.includes('--calling-ae CT01-ARC')) {
      bad(`a peer's own calling AE did not reach its command: ${JSON.stringify(overrideAe.on)}`);
    }
    if (!overrideAe.on.override || overrideAe.on.chip.from !== '← CT01-ARC') {
      bad(`the chip does not show the override: ${JSON.stringify(overrideAe.on.chip)}`);
    }
    if (!overrideAe.on.worklist.includes('--calling-ae CT01')
      || overrideAe.on.worklist.includes('CT01-ARC')) {
      bad(`the override leaked onto the RIS: ${overrideAe.on.worklist}`);
    }
    if (overrideAe.off.conn !== 'CT01' || !overrideAe.off.send.includes('--calling-ae CT01')
      || overrideAe.off.send.includes('CT01-ARC')) {
      bad(`clearing the override did not go back to the station AE: ${JSON.stringify(overrideAe.off)}`);
    }

    // =====================================================================
    // C. Every screen: a frame, the word budget, the folded command, the chip.
    // =====================================================================
    const budgetProblems = [];
    const wordLog = [];
    const measureScreen = async (key, paneSel, stopSel) => {
      const m = await jsJSON(`JSON.stringify(__smoke.measure(${JSON.stringify(paneSel)}, ${stopSel ? JSON.stringify(stopSel) : 'null'}))`);
      if (!m) bad(`no such pane: ${paneSel}`);
      const budget = BUDGET[key];
      const line = `words: ${key} — ${m.words} words, ${m.controls} controls above "${m.primary}"`
        + (budget == null ? ' (no budget)' : ` (budget ${budget})`);
      record(line);
      // What was counted, verbatim, so a number that moves can be read rather
      // than guessed at.
      wordLog.push(`${key} (${m.words} words above "${m.primary}"):\n  ${m.text}\n`);
      artefact('word-measure.txt', wordLog.join('\n'));
      if (budget != null && m.words > budget) {
        budgetProblems.push(`${key}: ${m.words} words above "${m.primary}", budget ${budget}`);
      }
      return m;
    };

    for (const name of SECTIONS) {
      await js(`showView(${JSON.stringify(name)}); true`);
      await wait(250);
      await shot(`view-${name}`);
      if (TABS[name]) {
        for (const tab of TABS[name]) {
          // eslint-disable-next-line no-await-in-loop
          await js(`showTab(${JSON.stringify(name)}, ${JSON.stringify(tab)}); updateAllPreviews(); true`);
          // eslint-disable-next-line no-await-in-loop
          await wait(200);
          // eslint-disable-next-line no-await-in-loop
          await shot(`tab-${tab}`);
          // eslint-disable-next-line no-await-in-loop
          await measureScreen(tab, `#view-${tab}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await js(`showTab(${JSON.stringify(name)}, ${JSON.stringify(TABS[name][0])}); true`);
      } else if (name === 'worklist') {
        // Nothing is selected yet, so "Perform exam" is not on screen and the
        // whole station gets counted: this is the screen an operator walks up to.
        await measureScreen('worklist-list', '#view-worklist', '#mpps-run');
      } else if (name === 'settings') {
        await measureScreen('settings', '#view-settings');
      } else {
        await measureScreen(name, `#view-${name}`);
      }
    }

    // Every screen that runs a command shows that command, folded, with the
    // whole line still readable on the summary. "The preview is the command"
    // is the rule this app is built on; a fold may hide it, never lose it.
    for (const pane of RUN_PANES) {
      const section = TAB_SECTION[pane] || pane;
      // eslint-disable-next-line no-await-in-loop
      await js(`showView(${JSON.stringify(section)});`
        + (TAB_SECTION[pane] ? ` showTab(${JSON.stringify(section)}, ${JSON.stringify(pane)});` : '')
        + ' updateAllPreviews(); true');
      // eslint-disable-next-line no-await-in-loop
      const folds = await jsJSON(`JSON.stringify(__smoke.folds('#view-${pane}'))`);
      if (!folds.length) bad(`${pane} runs a command and has no command fold`);
      for (const f of folds) {
        if (f.open) bad(`${pane}'s command fold is open while "Show commands expanded" is off`);
        if (!f.cmd.startsWith('dcm ')) bad(`${pane}'s command preview is not a dcm command: ${JSON.stringify(f.cmd)}`);
        if (f.sum.trim() !== f.cmd.trim()) {
          bad(`${pane}'s folded summary does not carry the command: ${JSON.stringify(f.sum)} vs ${JSON.stringify(f.cmd)}`);
        }
      }
      say(`command fold: ${pane} — ${folds.length} fold(s), folded, summary carries "${folds[0].cmd.slice(0, 70)}…"`);
    }

    // The engineer option opens every one of them, and only that.
    const expanded = await jsJSON(`(async () => {
      __smoke.set('set-cmd-expanded', true);
      await new Promise((r) => setTimeout(r, 400));
      const all = Array.from(document.querySelectorAll('.cmd-fold'));
      const open = all.filter((d) => d.open).length;
      __smoke.set('set-cmd-expanded', false);
      await new Promise((r) => setTimeout(r, 400));
      const shut = Array.from(document.querySelectorAll('.cmd-fold')).filter((d) => !d.open).length;
      return JSON.stringify({ total: all.length, open, shut });
    })()`);
    record(`command folds: ${expanded.total} in the app; "Show commands expanded" opened ${expanded.open}, shut ${expanded.shut}`);
    if (expanded.open !== expanded.total || expanded.shut !== expanded.total) {
      bad(`the engineer option did not reach every fold: ${JSON.stringify(expanded)}`);
    }

    // The peer chip is a view onto state.conn and nothing else. Every screen
    // that names a DIMSE peer gets the peer holding its role, and a role
    // nobody holds gets an empty chip rather than somebody else's peer.
    for (const [pane, role, expect] of [
      ['worklist', 'ris', RIS_PEER], ['send', 'archive', ARCHIVE_PEER],
      ['query', 'archive', ARCHIVE_PEER], ['speed', 'archive', ARCHIVE_PEER],
      ['echo', 'any', null],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await js(`showView(${JSON.stringify(pane)}); true`);
      // eslint-disable-next-line no-await-in-loop
      const seen = await jsJSON(`JSON.stringify({
        chips: __smoke.chips('#view-${pane}'),
        conn: state.conn,
        label: connLabel(state.conn),
      })`);
      const chip = seen.chips[0];
      if (!chip) bad(`${pane} has no peer chip`);
      if (chip.role !== role) bad(`${pane}'s chip declares role ${chip.role}, expected ${role}`);
      if (chip.name !== (seen.label || `no ${{ ris: 'RIS', archive: 'Archive', any: 'Peer' }[role]} peer set`)) {
        bad(`${pane}'s chip reads "${chip.name}" while state.conn is ${JSON.stringify(seen.conn)}`);
      }
      if (expect && chip.name !== expect) bad(`${pane} did not select its ${role} peer: "${chip.name}"`);
      if (expect && chip.from !== `← ${seen.conn.callingAe}`) {
        bad(`${pane}'s chip does not name the calling AE: "${chip.from}"`);
      }
      say(`chip: ${pane} [${chip.role}] "${chip.name}" ${chip.from}`);
    }

    // A role nobody holds: an empty peer, an amber chip, and no command that
    // silently aims at whichever peer happened to be selected last.
    const orphan = await jsJSON(`(async () => {
      setPeerRole(${JSON.stringify(ARCHIVE_PEER)}, '');
      await window.dcm.profiles.set({ profiles: state.profiles });
      state.peerChoice = {};
      showView('send');
      const chip = __smoke.chips('#view-send')[0];
      const cmd = document.querySelector('#view-send [data-cmd]').textContent;
      setPeerRole(${JSON.stringify(ARCHIVE_PEER)}, 'archive');
      await window.dcm.profiles.set({ profiles: state.profiles });
      showView('send');
      const back = __smoke.chips('#view-send')[0];
      return JSON.stringify({ chip, cmd, conn: state.conn, back });
    })()`);
    say(`chip: with no Archive peer the Send chip reads "${orphan.chip.name}" and the command is "${orphan.cmd}"`);
    if (!/no Archive peer set/.test(orphan.chip.name) || !orphan.chip.unset) {
      bad(`a role nobody holds did not empty the chip: ${JSON.stringify(orphan.chip)}`);
    }
    if (/--host/.test(orphan.cmd)) {
      bad(`with no Archive peer the Send command still names a host: ${orphan.cmd}`);
    }
    if (orphan.back.name !== ARCHIVE_PEER) bad(`the Archive role did not come back: ${JSON.stringify(orphan.back)}`);

    // Picking a peer on the chip moves state.conn and every command with it.
    const picked = await jsJSON(`(() => {
      showView('send');
      document.querySelector('#view-send .peer-chip-btn').click();
      const menu = document.querySelector('#view-send .peer-menu');
      const open = !menu.hidden;
      const item = menu.querySelector('[data-peer-pick="' + ${JSON.stringify(RIS_PEER)}.replace(/"/g, '&quot;') + '"]');
      item.click();
      const after = { chip: __smoke.chips('#view-send')[0], conn: state.conn,
        cmd: document.querySelector('#view-send [data-cmd]').textContent };
      // Put it back on the peer its role names.
      delete state.peerChoice.send;
      showView('send');
      return JSON.stringify({ open, after, restored: __smoke.chips('#view-send')[0].name });
    })()`);
    say(`chip: picking the RIS on Send gave "${picked.after.chip.name}" and ${picked.after.cmd}`);
    if (!picked.open) bad('the peer chip menu did not open');
    if (picked.after.chip.name !== RIS_PEER) bad(`the pick did not reach the chip: ${JSON.stringify(picked.after.chip)}`);
    if (!picked.after.cmd.includes(`--port ${risPort}`)) {
      bad(`the pick did not reach the command: ${picked.after.cmd}`);
    }
    if (picked.restored !== ARCHIVE_PEER) bad(`clearing the pick did not restore the role peer: ${picked.restored}`);

    if (budgetProblems.length) {
      bad(`word budget exceeded:\n  ${budgetProblems.join('\n  ')}`);
    }

    // =====================================================================
    // D. A real inventory run: the structured table and the engine spawn.
    // =====================================================================
    if (fixtures) {
      await js(`(() => {
        showView('inventory');
        __smoke.set('info-folder', ${JSON.stringify(fixtures)});
        __smoke.set('info-series', true);
        document.querySelector('#view-inventory [data-run]').click();
        return true;
      })()`);
      // Wait for the child engine process to finish, not for a guessed number
      // of milliseconds — a run still in flight competes with the next screen's
      // child for the same machine, which is how this harness used to go flaky.
      await mustWait("!document.querySelector('#view-inventory [data-status]').className.includes('running')",
        RUN_MS, 'the inventory run to finish');
      await shot('inventory-result');
      const inv = await jsJSON(`JSON.stringify({
        status: document.querySelector('#view-inventory [data-status]').textContent,
        cmd: document.querySelector('#view-inventory [data-cmd]').textContent,
        rows: document.querySelectorAll('#view-inventory [data-result] tbody tr').length,
        text: document.querySelector('#view-inventory [data-result]').textContent.slice(0, 200),
        outOpen: __smoke.outOpen('inventory'),
      })`);
      record(`inventory: ${inv.status} — ${inv.cmd}`);
      say(`inventory result: ${inv.rows} row(s) — ${inv.text.replace(/\s+/g, ' ').trim()}`);
      artefact('inventory-cmd.txt', inv.cmd);
      if (!/^dcm info /.test(inv.cmd)) bad(`the inventory command is wrong: ${inv.cmd}`);
      if (inv.status !== 'Done' && inv.status !== 'OK') {
        if (/fail/i.test(inv.status)) bad(`the inventory run failed: ${inv.status}`);
      }
      if (!inv.rows) bad('a real inventory run produced no table rows');
      // A run that worked leaves the Output folded: the result is the table.
      if (inv.outOpen) bad('a successful inventory run unfolded the Output pane');
    }

    // A refusal is never folded away.
    await js(`(() => {
      showView('send');
      __smoke.set('send-folder', '');
      document.querySelector('#view-send [data-run]').click();
      return true;
    })()`);
    // The console buffers arrivals and writes them on a frame, so wait for the
    // words rather than for a guess at when they land.
    await mustWait('/Choose a folder/.test(__smoke.consoleText("send"))', 10000, 'the refusal to be written');
    const refusal = await jsJSON(
      'JSON.stringify({ open: __smoke.outOpen("send"), text: __smoke.consoleText("send").trim() })');
    say(`refusal: Send with no folder — Output open ${refusal.open}, says "${refusal.text}"`);
    if (!refusal.open || !/Choose a folder/.test(refusal.text)) {
      bad(`a refusal did not open the Output disclosure: ${JSON.stringify(refusal)}`);
    }
    await shot('send-refusal');

    // =====================================================================
    // E. Speed as a first-class choice, on the Send screen.
    //
    // The whole claim of this screen is that the preview is the command, so
    // the check is not "a chip is highlighted" but "clicking the chip put
    // --speed <preset> in the command and nothing else moved".
    // =====================================================================
    {
      await js(`showView('send'); __smoke.set('send-folder', ${JSON.stringify(fixtures || 'C:/smoke/study')}); true`);
      const pick = (preset) => `(() => {
        document.querySelector('#send-speed .chip[data-speed=${JSON.stringify(preset)}]').click();
        return JSON.stringify({
          cmd: document.querySelector('#view-send [data-cmd]').textContent,
          hint: document.querySelector('#send-speed-hint').textContent,
          amber: !document.querySelector('#send-speed-danger').hidden,
          advSum: document.querySelector('#send-adv-sum').textContent,
        });
      })()`;

      const perPreset = {};
      for (const preset of ['normal', 'fast', 'very-fast', 'insane']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await jsJSON(pick(preset));
        perPreset[preset] = r;
        say(`send --speed ${preset}: ${r.cmd}`);
        if (!r.cmd.includes(`--speed ${preset}`)) {
          bad(`the ${preset} chip did not reach the command: ${r.cmd}`);
        }
        if (!r.hint || r.hint.length < 20) bad(`the ${preset} chip has no one-line description`);
        // Only insane raises the amber block; the other three must not.
        if (r.amber !== (preset === 'insane')) {
          bad(`the amber warning is wrong for ${preset}: shown=${r.amber}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await wait(120);
        // eslint-disable-next-line no-await-in-loop
        if (preset === 'fast') await shot('send-speed-fast');
      }
      await shot('send-speed-insane');
      artefact('send-speed-cmds.txt',
        Object.entries(perPreset).map(([k, v]) => `${k}\t${v.cmd}`).join('\n') + '\n');

      // The amber block's "Why" opens the help panel and never closes it.
      const why = await jsJSON(`(() => {
        setHelp('send-help', false);
        document.querySelector('#send-speed-danger .linklike').click();
        const first = !document.querySelector('#send-help').hidden;
        document.querySelector('#send-speed-danger .linklike').click();
        const second = !document.querySelector('#send-help').hidden;
        const words = (document.querySelector('#send-help').textContent.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
        return JSON.stringify({ first, second, words });
      })()`);
      say(`help: the Insane note's "Why" opened the panel (${why.words} words), and a second click left it open: ${why.second}`);
      if (!why.first || !why.second) bad(`the "Why" link toggles the answer shut: ${JSON.stringify(why)}`);
      await shot('send-help');
      // Escape closes it and hands focus back to the ?
      const esc = await jsJSON(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return JSON.stringify({
          open: document.querySelectorAll('.help-panel:not([hidden])').length,
          focus: (document.activeElement.getAttribute('data-help') || ''),
        });
      })()`);
      if (esc.open !== 0) bad('Escape left a help panel open');
      if (esc.focus !== 'send-help') bad(`Escape did not return focus to the ?: ${JSON.stringify(esc)}`);

      // The raw numbers still exist, under Advanced, and still win — but they
      // do not win the same way, so the two cases are checked separately.
      //
      // A typed chunk size beats half the preset: the preset still supplies the
      // association count, so --speed stays on the line and the engine says
      // what it displaced.
      const chunkOnly = await jsJSON(`(() => {
        document.querySelector('#send-speed .chip[data-speed="fast"]').click();
        document.querySelector('#send-adv').open = true;
        __smoke.set('send-parallel', '');
        __smoke.set('send-chunk', '50');
        return JSON.stringify({
          cmd: document.querySelector('#view-send [data-cmd]').textContent,
          advSum: document.querySelector('#send-adv-sum').textContent,
          inert: document.querySelector('#send-speed').classList.contains('inert'),
        });
      })()`);
      say(`send chunk override: ${JSON.stringify(chunkOnly)}`);
      for (const needed of ['--speed fast', '--chunk 50']) {
        if (!chunkOnly.cmd.includes(needed)) bad(`a typed chunk size dropped ${needed}: ${chunkOnly.cmd}`);
      }
      if (chunkOnly.cmd.includes('--parallel')) {
        bad(`a --parallel appeared with nothing typed in it: ${chunkOnly.cmd}`);
      }
      if (chunkOnly.inert) {
        bad('a typed chunk size switched the preset off; it only replaces half of it');
      }

      // A typed association count replaces the preset outright. The command
      // must carry no --speed at all: the engine gates its chunk derivation on
      // the flag being present rather than on the preset supplying the width,
      // so leaving --speed on the line would keep re-deriving the chunk size
      // from the typed number — a different transfer from the one this field
      // produced before presets existed, and a different one from what the same
      // flags give a CLI user. The screen has to agree: the preview is the
      // command, so a preset that is not on the line must not look chosen.
      const override = await jsJSON(`(() => {
        __smoke.set('send-parallel', '6');
        __smoke.set('send-chunk', '50');
        document.querySelector('#send-adv').scrollIntoView({ block: 'center' });
        return JSON.stringify({
          cmd: document.querySelector('#view-send [data-cmd]').textContent,
          advSum: document.querySelector('#send-adv-sum').textContent,
          changed: document.querySelector('#send-adv-sum').classList.contains('changed'),
          inert: document.querySelector('#send-speed').classList.contains('inert'),
          hint: document.querySelector('#send-speed-hint').textContent,
        });
      })()`);
      await wait(250);
      await shot('send-advanced');
      say(`send advanced override: ${JSON.stringify(override)}`);
      artefact('send-override-cmd.txt', override.cmd);
      for (const needed of ['--parallel 6', '--chunk 50']) {
        if (!override.cmd.includes(needed)) bad(`the override command is missing ${needed}: ${override.cmd}`);
      }
      if (override.cmd.includes('--speed')) {
        bad('a typed association count left --speed on the command line, which re-derives the chunk '
          + `size from the typed number: ${override.cmd}`);
      }
      // Shutting the disclosure must not hide the values it holds.
      for (const needed of ['--parallel 6', '--chunk 50']) {
        if (!override.advSum.includes(needed)) bad(`Advanced folds away a value without naming it: ${override.advSum}`);
      }
      // ...and must not name a flag that is no longer being sent.
      if (/overrides --speed|replaces that half of --speed/.test(override.advSum)) {
        bad(`the summary still describes the preset as merely overridden: ${override.advSum}`);
      }
      if (!/not used/.test(override.advSum)) {
        bad(`the summary does not say the preset is out of the run: ${override.advSum}`);
      }
      if (!override.changed) bad('the Advanced summary is not marked as changed');
      if (!override.inert) bad('the preset chips still look chosen while no --speed is being sent');
      if (!/Not in use/.test(override.hint)) {
        bad(`the chip row's own line does not say the preset is off: ${override.hint}`);
      }

      // Everything that moved under Advanced when this screen was trimmed is
      // still named there the moment it is set, including what it inherits.
      const advNames = await jsJSON(`(() => {
        __smoke.set('send-parallel', '');
        __smoke.set('send-chunk', '');
        __smoke.set('send-retry', '3');
        __smoke.set('send-timeout', '45000');
        __smoke.set('send-syntax', 'jpeg2000');
        __smoke.set('send-norecurse', true);
        __smoke.set('send-rewrite', true);
        return JSON.stringify({
          sum: document.querySelector('#send-adv-sum').textContent,
          cmd: document.querySelector('#view-send [data-cmd]').textContent,
        });
      })()`);
      say(`send advanced summary: ${advNames.sum}`);
      say(`send advanced command: ${advNames.cmd}`);
      for (const flag of ['--retry 3', '--timeout 45000', '--transfer-syntax jpeg2000', '--no-recurse', '--rewrite-series-uid']) {
        if (!advNames.cmd.includes(flag)) bad(`Advanced did not put ${flag} on the command: ${advNames.cmd}`);
        if (!advNames.sum.includes(flag.split(' ')[0])) {
          bad(`the folded summary does not name ${flag}: ${advNames.sum}`);
        }
      }

      // Put the screen back to a clean preset for anything that follows.
      await js(`(() => {
        for (const id of ['send-parallel', 'send-chunk', 'send-retry', 'send-timeout']) __smoke.set(id, '');
        __smoke.set('send-syntax', '');
        __smoke.set('send-norecurse', false);
        __smoke.set('send-rewrite', false);
        document.querySelector('#send-adv').open = false;
        document.querySelector('#send-speed .chip[data-speed="insane"]').click();
        return true;
      })()`);

      // The preset has to survive the whole way to the engine, so insane is
      // actually run — against this harness's own archive. Ten fixture
      // instances cannot fill sixteen associations, so this is also the case
      // the engine warns about, and that warning has to reach the app's
      // console rather than only the engine's own stderr.
      if (fixtures) {
        await js(`document.querySelector('#view-send [data-run]').click(); true`);
        await mustWait("!document.querySelector('#view-send [data-status]').className.includes('running')",
          RUN_MS, 'the insane send to finish');
        // The run is over when the child exits; the console writes what it was
        // given on the next frame, so the last of the report can still be in
        // flight. Wait for the words rather than reading a buffer mid-write.
        await mustWait('/TOTALS/.test(__smoke.consoleText("send"))', 10000, "the send's report to be written");
        const insane = await jsJSON(`JSON.stringify({
          status: document.querySelector('#view-send [data-status]').textContent,
          console: __smoke.consoleText('send'),
          totals: document.querySelector('#view-send [data-totals]').textContent,
        })`);
        artefact('send-insane-console.txt', insane.console);
        record(`send --speed insane: ${insane.status} — ${insane.totals.replace(/\s+/g, ' ').trim()}`);
        if (/Unknown option/.test(insane.console)) {
          bad('the engine this app spawns does not know --speed');
        }
        if (insane.status !== 'All acknowledged') {
          bad(`a real insane send to the harness's archive did not acknowledge everything: ${insane.status}`);
        }
        if (!/association\(s\)/.test(insane.console)) {
          bad(`the engine's own report did not reach the app's console: ${insane.console.slice(0, 300)}`);
        }
        await shot('send-insane-run');
      }
      await js(`document.querySelector('#send-speed .chip[data-speed="normal"]').click(); true`);
    }

    // =====================================================================
    // F. Rehearsal is one switch, and it reaches every command that has a
    //    --dry-run — and nothing else.
    // =====================================================================
    {
      // Edit ships with its own "Preview only" ticked, and that switch is about
      // the disk rather than a peer — it was deliberately kept when the
      // per-screen dry-run controls were replaced by rehearsal. It is turned
      // off here so the two are not confused, and checked again afterwards.
      const editOwn = await jsJSON(`(() => {
        showView('edit');
        const on = BUILDERS.edit().join(' ');
        __smoke.set('edit-dryrun', false);
        return JSON.stringify({ on, off: BUILDERS.edit().join(' ') });
      })()`);
      if (!editOwn.on.includes('--dry-run') || editOwn.off.includes('--dry-run')) {
        bad(`Edit's own "Preview only" no longer controls --dry-run: ${JSON.stringify(editOwn)}`);
      }
      say('rehearsal: Edit\'s own "Preview only" is a separate switch about the disk; turned off for this check');

      const before = await jsJSON('JSON.stringify(__smoke.argvs())');
      const bannerOff = await js('document.querySelector("#rehearsal-banner").hidden');
      if (!bannerOff) bad('the rehearsal banner is up with rehearsal off');
      for (const [k, argv] of Object.entries(before)) {
        if (argv.includes('--dry-run')) bad(`${k} carries --dry-run with rehearsal off: ${argv.join(' ')}`);
      }

      await js('__smoke.set("set-rehearsal", true); true');
      await mustWait('state.settings.rehearsal === true', 8000, 'rehearsal to be committed');
      await wait(200);
      const on = await jsJSON(`JSON.stringify({
        banner: !document.querySelector('#rehearsal-banner').hidden,
        text: document.querySelector('#rehearsal-banner').textContent.replace(/\\s+/g, ' ').trim(),
        argvs: __smoke.argvs(),
      })`);
      record(`rehearsal: banner up — "${on.text}"`);
      if (!on.banner) bad('rehearsal is on and the banner is not up');
      // The station's verbs relabel too, but only a selected row has verbs on
      // screen at all — that is checked in the station flow below.

      // Every command the engine will take a --dry-run for, and no other.
      const DRY = ['send', 'mpps', 'mpps.start', 'steps.complete', 'steps.discontinue', 'steps.send', 'websend', 'edit', 'rename'];
      const gained = [];
      for (const [k, argv] of Object.entries(on.argvs)) {
        const has = argv.includes('--dry-run');
        if (DRY.includes(k)) {
          if (!has) bad(`${k} did not take --dry-run under rehearsal: ${argv.join(' ')}`);
          if (argv.filter((a) => a === '--dry-run').length !== 1) {
            bad(`${k} carries --dry-run more than once: ${argv.join(' ')}`);
          }
          gained.push(k);
          // Removing the flag must leave the command it was before: rehearsal
          // adds a flag, it does not build a different command.
          const stripped = argv.filter((a) => a !== '--dry-run');
          if (JSON.stringify(stripped) !== JSON.stringify(before[k])) {
            bad(`rehearsal changed ${k} beyond adding --dry-run:\n  was ${JSON.stringify(before[k])}\n  now ${JSON.stringify(stripped)}`);
          }
        } else {
          if (has) bad(`${k} took a --dry-run the engine has no flag for: ${argv.join(' ')}`);
          if (JSON.stringify(argv) !== JSON.stringify(before[k])) {
            bad(`rehearsal changed ${k}, which has no --dry-run:\n  was ${JSON.stringify(before[k])}\n  now ${JSON.stringify(argv)}`);
          }
        }
      }
      record(`rehearsal: --dry-run reached ${gained.length} commands (${gained.join(', ')}); `
        + `the other ${Object.keys(on.argvs).length - gained.length} are byte-identical`);
      artefact('rehearsal-argvs.json', JSON.stringify({ before, after: on.argvs }, null, 2));
      await js("showView('send'); true");
      await wait(200);
      await shot('send-rehearsal-banner');

      // A rehearsed send really runs, and says it sent nothing.
      if (fixtures) {
        await js(`(() => {
          __smoke.set('send-folder', ${JSON.stringify(fixtures)});
          document.querySelector('#view-send [data-run]').click();
          return true;
        })()`);
        await mustWait("!document.querySelector('#view-send [data-status]').className.includes('running')",
          RUN_MS, 'the rehearsed send to finish');
        const dry = await jsJSON(`JSON.stringify({
          status: document.querySelector('#view-send [data-status]').textContent,
          cmd: document.querySelector('#view-send [data-cmd]').textContent,
          console: __smoke.consoleText('send').slice(-600),
        })`);
        record(`rehearsed send: ${dry.status} — ${dry.cmd}`);
        if (!dry.cmd.includes('--dry-run')) bad(`the rehearsed send lost its --dry-run: ${dry.cmd}`);
        if (dry.status !== 'Plan ready') bad(`a rehearsed send did not report a plan: ${dry.status}`);
      }

      // The banner's own "Turn off" is the way back.
      await js('document.querySelector("#rehearsal-off").click(); true');
      await mustWait('state.settings.rehearsal === false', 8000, 'rehearsal to be turned off from the banner');
      const after = await jsJSON(`JSON.stringify({
        banner: !document.querySelector('#rehearsal-banner').hidden,
        argvs: __smoke.argvs(),
      })`);
      if (after.banner) bad('the banner stayed up after "Turn off"');
      if (JSON.stringify(after.argvs) !== JSON.stringify(before)) {
        bad('turning rehearsal off did not restore every command exactly');
      }
      say('rehearsal: turned off from the banner; every command is back to what it was');
      await js('__smoke.set("edit-dryrun", true); true');
    }

    // =====================================================================
    // G. The speed-test sweep: the plan, and a table with a failed run in it.
    // =====================================================================
    {
      const sweep = await jsJSON(`(() => {
        showView('speed');
        __smoke.set('speed-folder', ${JSON.stringify(fixtures || 'C:/smoke/study')});
        document.querySelector('#speed-mode .chip[data-mode="parallel"]').click();
        return JSON.stringify({
          hint: document.querySelector('#speed-parallel-hint').textContent,
          cmds: Array.from(document.querySelectorAll('#speed-progress .run-cmd')).map((e) => e.textContent),
          titles: Array.from(document.querySelectorAll('#speed-progress .run-line span:first-child')).map((e) => e.textContent),
        });
      })()`);
      await wait(300);
      await shot('speed-preset-sweep');
      sweep.cmds.forEach((c) => say(`sweep run: ${c}`));
      say(`sweep hint: ${sweep.hint}`);
      artefact('speed-sweep-cmds.txt', sweep.cmds.join('\n') + '\n');

      // The line that tells the operator how to read the sweep afterwards.
      //
      // It used to promise that a preset the receiver will not accept "still
      // acknowledges every instance and comes back narrow rather than short or
      // slow", and send the reader away from the Ack column on the strength of
      // it. The retry has no backoff, so the other ending — attempts exhausted
      // in milliseconds, instances never acknowledged, exit 1 — is reachable
      // and was measured. A screen may not promise either ending, and may not
      // point away from the column that shows the one it did not mention. The
      // paragraph moved into the help panel; the panel has to keep saying it.
      const help = await js(`document.querySelector('#speed-help').textContent`);
      for (const banned of [
        /not the\s+Ack column/i,
        /still\s+acknowledges every instance/i,
        /comes back narrow rather than short or slow/i,
      ]) {
        if (banned.test(sweep.hint) || banned.test(help)) {
          bad(`the ceiling explanation still promises every instance is acknowledged: ${sweep.hint}`);
        }
      }
      for (const needed of [/Width column/, /Ack column/, /no backoff/, /never acknowledged/]) {
        if (!needed.test(help)) bad(`the help panel's ceiling paragraph is missing ${needed}`);
      }
      if (!/Width and Ack columns/.test(sweep.hint)) {
        bad(`the line under the presets does not name both columns: ${sweep.hint}`);
      }
      for (const preset of ['normal', 'fast', 'very-fast', 'insane']) {
        if (!sweep.cmds.some((c) => c.includes(`--speed ${preset}`))) {
          bad(`the sweep does not run ${preset}: ${JSON.stringify(sweep.cmds)}`);
        }
      }
      if (sweep.cmds.length !== 4) bad(`the sweep should be four runs, got ${sweep.cmds.length}`);
      // Calling AE Titles have to stay distinct or the peer's log cannot be read
      // per run — and they are capped at 16 characters by DICOM.
      const aes = sweep.titles.map((t) => t.split('·').pop().trim());
      if (new Set(aes).size !== aes.length) bad(`the sweep reuses a calling AE Title: ${JSON.stringify(aes)}`);
      for (const a of aes) if (a.length > 16) bad(`calling AE Title over 16 characters: ${a}`);
      say(`sweep calling AEs: ${JSON.stringify(aes)}`);

      // Custom entry survives, and is additive rather than replacing the sweep.
      const custom = await jsJSON(`(() => {
        __smoke.set('speed-parallels', '12');
        return JSON.stringify({ cmds: Array.from(document.querySelectorAll('#speed-progress .run-cmd')).map((e) => e.textContent) });
      })()`);
      say(`sweep with custom count: ${custom.cmds.length} runs, last = ${custom.cmds[custom.cmds.length - 1]}`);
      if (custom.cmds.length !== 5 || !custom.cmds[4].includes('--parallel 12')) {
        bad(`custom association counts were dropped: ${JSON.stringify(custom.cmds)}`);
      }

      // A typed chunk size beats every preset, so the screen has to say so
      // before the benchmark rather than after it.
      const capped = await jsJSON(`(() => {
        __smoke.set('speed-parallels', '');
        __smoke.set('speed-chunk', '200');
        return JSON.stringify({
          hint: document.querySelector('#speed-parallel-hint').textContent,
          live: document.querySelector('#speed-parallel-hint').classList.contains('live'),
          first: document.querySelector('#speed-progress .run-cmd').textContent,
        });
      })()`);
      say(`sweep, chunk typed: ${JSON.stringify(capped)}`);
      if (!capped.live || !capped.hint.includes('override')) {
        bad(`a typed chunk size overrides the presets silently: ${capped.hint}`);
      }
      if (!capped.first.includes('--chunk 200')) bad(`the typed chunk size is not in the command: ${capped.first}`);

      // The listed commands are a preview like any other, so they have to move
      // when the peer moves. Nothing in this box is touched by the peer chip,
      // which is how the four commands used to sit there with no --host in them
      // while the single preview above already had one.
      const peerEdit = await jsJSON(`(() => {
        __smoke.set('speed-chunk', '');
        state.conn = { host: '', port: '', calledAe: '', callingAe: '' };
        renderPeerChips();
        updateAllPreviews();
        const before = Array.from(document.querySelectorAll('#speed-progress .run-cmd')).map((e) => e.textContent);
        applyProfile(${JSON.stringify(ARCHIVE_PEER)});
        return JSON.stringify({
          before,
          after: Array.from(document.querySelectorAll('#speed-progress .run-cmd')).map((e) => e.textContent),
          preview: document.querySelector('#view-speed [data-cmd]').textContent,
          chip: __smoke.chips('#view-speed')[0].name,
        });
      })()`);
      if (peerEdit.before.some((c) => c.includes('--host'))) {
        bad(`the sweep commands carried a peer that was cleared: ${JSON.stringify(peerEdit.before)}`);
      }
      for (const c of peerEdit.after) {
        for (const needed of ['--host 127.0.0.1', `--port ${archivePort}`, '--called-ae ARCHIVE']) {
          if (!c.includes(needed)) bad(`picking the peer left a listed command missing ${needed}: ${c}`);
        }
      }
      // The two previews on this screen must not disagree about the peer.
      if (!peerEdit.preview.includes('--host 127.0.0.1')) {
        bad(`the single preview did not pick up the peer: ${peerEdit.preview}`);
      }
      if (peerEdit.chip !== ARCHIVE_PEER) bad(`the chip disagrees with state.conn: ${peerEdit.chip}`);
      say(`sweep after the peer moved: ${peerEdit.after[0]}`);

      // A sweep in flight owns the progress box: the loop writes measured rates
      // into #speed-line-<i> against the array it froze at the start, so a
      // rebuild from the live form would land one run's rate on another run's
      // labelled line and wipe the rates already there. Nothing on this screen
      // is disabled during a sweep except Run, so this is one ordinary click.
      const frozen = await jsJSON(`(() => {
        const snap = () => document.querySelector('#speed-progress').innerHTML;
        const before = snap();
        speedRunning = true;
        const box = document.querySelector('.speed-opt[value="insane"]');
        box.checked = false;
        box.dispatchEvent(new Event('change', {bubbles:true}));
        const during = snap();
        speedRunning = false;
        box.checked = true;
        box.dispatchEvent(new Event('change', {bubbles:true}));
        const after = snap();
        return JSON.stringify({ held: before === during, restored: before === after,
          lines: document.querySelectorAll('#speed-progress .run-line').length });
      })()`);
      say(`sweep list frozen mid-run: ${JSON.stringify(frozen)}`);
      if (!frozen.held) bad('the progress list was rebuilt from the form while a sweep was in flight');
      if (!frozen.restored || frozen.lines !== 4) {
        bad(`the progress list did not come back after the sweep: ${JSON.stringify(frozen)}`);
      }
    }

    // ---------------------------------------------------------------------
    // A sweep with a failed run in it, rendered from known JSON.
    //
    // The live sweep further down needs a receiver, and a receiver the harness
    // starts accepts everything, so the case that matters most on this screen
    // is the one a live run cannot produce: a run that lost instances sitting
    // in the table beside a run that did not. It is fed in the exact shape
    // `dcm send --json` emits.
    //
    // The numbers are the ones that make the defect visible. The Fast run dies
    // partway — 60 of 100 acknowledged — and because it died early its MB/s is
    // the HIGHEST in the sweep: 11.9 against 6.3 for the run that actually
    // finished. That is not a corner case invented for the test, it is the
    // normal shape of the reading, and it is why a rate is not printed for it
    // and why it may not be badged.
    // ---------------------------------------------------------------------
    {
      const SYN = [{ name: 'Implicit VR Little Endian' }];
      const mk = (o) => Object.assign({
        negotiatedTransferSyntaxes: SYN, found: 100, acknowledged: 100, sent: 100,
      }, o);
      const fixture = [
        { run: { title: 'normal · 1 association', callingAe: 'BENCH-1' }, code: 0,
          data: mk({ ok: true, parallel: 1, parallelAchieved: 1, elapsedMs: 8180,
            megabytesPerSecond: 4.1, instancesPerSecond: 12.22, bytesSent: 35127296,
            studies: [{ instances: 100, chunks: 1 }] }) },
        // The one the table used to render as an ordinary row.
        { run: { title: 'fast · 4 associations', callingAe: 'BENCH-2' }, code: 1,
          data: mk({ ok: false, acknowledged: 60, parallel: 4, parallelAchieved: 3,
            elapsedMs: 2110, megabytesPerSecond: 11.9, instancesPerSecond: 28.44,
            bytesSent: 21076377, studies: [{ instances: 100, chunks: 4 }] }) },
        { run: { title: 'very-fast · 8 associations', callingAe: 'BENCH-3' }, code: 0,
          data: mk({ ok: true, parallel: 8, parallelAchieved: 4, elapsedMs: 5320,
            megabytesPerSecond: 6.3, instancesPerSecond: 18.79, bytesSent: 35127296,
            studies: [{ instances: 100, chunks: 4 }] }) },
        // No parseable JSON at all: the other way a run can fail.
        { run: { title: 'insane · 16 associations', callingAe: 'BENCH-4' }, code: 1, data: null },
      ];

      const m = await jsJSON(`(() => {
        showView('speed');
        const results = ${JSON.stringify(fixture)};
        const outcome = speedOutcome(results, false);
        setStatus('speed', outcome.kind, outcome.label);
        renderSpeedResults(results);
        const rows = Array.from(document.querySelectorAll('#view-speed [data-result] tbody tr'));
        const chip = document.querySelector('#view-speed [data-status]');
        return JSON.stringify({
          outcome,
          chip: { text: chip.textContent, cls: chip.className },
          headers: Array.from(document.querySelectorAll('#view-speed [data-result] thead th')).map((e) => e.textContent),
          rows: rows.map((tr) => ({
            cls: tr.className,
            cells: Array.from(tr.children).map((td) => td.textContent.trim()),
            badge: (tr.querySelector('.badge-best') || {}).textContent || '',
            incompleteBadge: (tr.querySelector('.badge-incomplete') || {}).textContent || '',
            ackWarned: !!tr.querySelector('td.ack .warn-inline'),
          })),
          notes: Array.from(document.querySelectorAll('#view-speed [data-result] .local-note')).map((e) => e.textContent),
        });
      })()`);
      await wait(250);
      // The chip is at the top of the screen and the table is below the fold,
      // so the two halves of this get a frame each. The chip is the half that
      // used to read a green "Done" over exactly this table.
      await js(`document.querySelector('#view-speed .view-head').scrollIntoView({ block: 'start' }); true`);
      await wait(200);
      await shot('speed-mixed-chip');
      await js(`document.querySelector('#view-speed [data-result]').scrollIntoView({ block: 'center' }); true`);
      await wait(200);
      await shot('speed-mixed-failure');
      artefact('speed-mixed-table.json', JSON.stringify(m, null, 2));
      m.rows.forEach((r) => say(`mixed row [${r.cls}]: ${JSON.stringify(r.cells)}`));
      m.notes.forEach((n) => say(`mixed note: ${n}`));
      say(`mixed chip: ${JSON.stringify(m.chip)}`);

      const iMB = m.headers.indexOf('MB/s');
      const iInst = m.headers.indexOf('Inst/s');
      const iAck = m.headers.indexOf('Ack');
      const [ordinary, failed, fastest, noJson] = m.rows;

      // 1. The failed row is not an ordinary row.
      if (!/incomplete/.test(failed.cls)) bad(`a run that lost 40 instances has no failure class: ${failed.cls}`);
      if (!failed.incompleteBadge) bad('the failed row carries no badge naming the failure');
      if (ordinary.cls.includes('incomplete') || ordinary.incompleteBadge) {
        bad('a run that acknowledged everything is marked as incomplete');
      }
      // 2. The Ack cell is not styled like the one beside it.
      if (!failed.ackWarned || !/60\/100/.test(failed.cells[iAck])) {
        bad(`the Ack cell does not mark the shortfall: ${JSON.stringify(failed.cells[iAck])}`);
      }
      if (!/40 missing/.test(failed.cells[iAck])) {
        bad(`the Ack cell does not say how many are missing: ${failed.cells[iAck]}`);
      }
      if (ordinary.ackWarned) bad(`100/100 is styled as a shortfall: ${ordinary.cells[iAck]}`);
      // 3. No throughput figure for a transfer that did not complete. The rate
      //    is the whole reason to read this table, and this run's is the
      //    highest in the sweep precisely because it stopped early.
      for (const [name, i] of [['MB/s', iMB], ['Inst/s', iInst]]) {
        if (failed.cells[i] !== '—') bad(`the failed run still reports ${name}: ${failed.cells[i]}`);
        if (ordinary.cells[i] === '—') bad(`a completed run lost its ${name} figure: ${JSON.stringify(ordinary.cells)}`);
      }
      if (/11\.9/.test(JSON.stringify(failed.cells))) {
        bad(`the incomplete run's rate is still on screen: ${JSON.stringify(failed.cells)}`);
      }
      // 4. FASTEST goes to a run that finished, never to the one that died
      //    early with the best-looking number.
      if (failed.badge) bad(`the incomplete run was badged ${failed.badge}`);
      if (!/FASTEST/.test(fastest.badge)) {
        bad(`no completed run was badged fastest: ${JSON.stringify(m.rows.map((r) => r.badge))}`);
      }
      // 5. A run with no JSON at all is marked the same way.
      if (!/incomplete/.test(noJson.cls) || !noJson.incompleteBadge) {
        bad(`a run that produced no result is not marked: ${noJson.cls}`);
      }
      // 6. The sweep's own chip does not read as a success.
      if (m.outcome.kind === 'ok' || /^Done$/.test(m.chip.text)) {
        bad(`the sweep chip reads as success with 2 of 4 runs incomplete: ${m.chip.text}`);
      }
      if (!/2 of 4/.test(m.chip.text) || !/incomplete/i.test(m.chip.text)) {
        bad(`the sweep chip does not count the failures: ${m.chip.text}`);
      }
      if (!m.chip.cls.includes('warn')) bad(`the sweep chip is not the warning colour: ${m.chip.cls}`);
      // 7. The table says in words what the blank cells mean.
      if (!m.notes.some((n) => /did not finish/.test(n) && /40 instances/.test(n))) {
        bad(`no note names the lost instances: ${JSON.stringify(m.notes)}`);
      }
      record('speed table: a sweep with 2 of 4 runs incomplete reads as a warning, prints no rate for '
        + 'either, and badges the fastest completed run');

      // Every run incomplete is red, not amber, and still not "Done".
      const allBad = await jsJSON(`(() => {
        const results = ${JSON.stringify(fixture)}.map((r) => (
          r.data ? { ...r, data: { ...r.data, ok: false, acknowledged: 10 } } : r
        ));
        return JSON.stringify(speedOutcome(results, false));
      })()`);
      say(`all-incomplete chip: ${JSON.stringify(allBad)}`);
      if (allBad.kind !== 'fail') bad(`a sweep with nothing completed is not marked failed: ${JSON.stringify(allBad)}`);

      // Put the screen back the way the live run further down expects it.
      await js(`(() => {
        const box = document.querySelector('#view-speed [data-result]');
        box.hidden = true;
        box.innerHTML = '';
        setStatus('speed', null, '');
        return true;
      })()`);
    }

    // =====================================================================
    // H. The station, against the RIS and the Archive this harness started.
    //
    // Query, pick a row, perform. Then the same panel taken apart: start only,
    // then complete; start only, then discontinue. Then the case a modality
    // meets every day — images that carry a different study than the order.
    // =====================================================================
    if (fixtures) {
      await js(`(() => { showView('worklist'); __smoke.set('mwl-auto', false); return true; })()`);
      await wait(200);
      // Auto is a timer that only runs while this screen is on view.
      const timerOff = await js('!state.mwl.timer');
      if (!timerOff) bad('unchecking Auto left the refresh timer running');
      await js(`(() => { __smoke.set('mwl-auto', true); return true; })()`);
      const timerOn = await js('!!state.mwl.timer');
      if (!timerOn) bad('checking Auto did not start the refresh timer');
      await js(`(() => { showView('send'); return !state.mwl.timer; })()`);
      const timerAway = await js('!state.mwl.timer');
      if (!timerAway) bad('the worklist kept polling after the screen was left');
      // Off for the flow: this harness drives the list itself.
      await js(`(() => { showView('worklist'); __smoke.set('mwl-auto', false); return true; })()`);

      // --- the query ---------------------------------------------------
      await js(`document.querySelector('#mwl-run').click(); true`);
      await mustWait("!document.querySelector('#mwl-status').className.includes('running')",
        RUN_MS, 'the worklist query to answer');
      const list = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mwl-status').textContent,
        cmd: document.querySelector('#mwl-cmd').textContent,
        rows: Array.from(document.querySelectorAll('#mwl-table tr.pick-row')).map((tr) => tr.dataset.key),
        columns: Array.from(document.querySelectorAll('#mwl-table thead th')).map((t) => t.textContent),
        cells: Array.from(document.querySelectorAll('#mwl-table tbody tr')).map(
          (tr) => Array.from(tr.children).map((td) => td.textContent.trim())),
      })`);
      record(`worklist: ${list.rows.length} rows — ${list.cmd}`);
      list.cells.forEach((c) => say(`  row: ${JSON.stringify(c)}`));
      artefact('worklist-cmd.txt', list.cmd);
      await shot('wl-1-list');
      if (list.rows.length !== rows.length) {
        bad(`the worklist query returned ${list.rows.length} rows, expected ${rows.length}`);
      }
      for (const needed of ['find', '--mwl', `ScheduledProcedureStepStartDate=${today}`, 'Modality=CT',
        `--port ${risPort}`, '--called-ae RISMPPS', '--calling-ae CT01']) {
        if (!list.cmd.includes(needed)) bad(`the worklist query is missing ${needed}: ${list.cmd}`);
      }
      if (list.cmd.includes('ScheduledStationAETitle')) {
        bad(`"only this station" is off and the query still narrows by station: ${list.cmd}`);
      }
      if (list.columns.includes('This app')) bad('the old "This app" column is still in the table');
      if (!list.columns.includes('Status')) bad(`the status column is gone: ${JSON.stringify(list.columns)}`);

      // A RIS that does not answer is not an empty worklist.
      //
      // The engine says which it is — outcome "network", ok false — and the
      // screen has to say the same thing. A green clock over an unreachable
      // RIS is the worst reading this screen can give: "not on the list" sends
      // the technologist to the patient, when the answer is that nobody asked
      // the RIS anything. The rows already on screen stay, labelled as the
      // last answer that was read rather than this one.
      const deadPort = await freePort();
      const DEAD_PEER = `NOBODY @ 127.0.0.1:${deadPort}`;
      await addPeer('127.0.0.1', deadPort, 'NOBODY', 'ris');
      await mustWait(`connLabel(state.conn) === ${JSON.stringify(DEAD_PEER)}`,
        8000, 'the RIS chip to move to the peer that is not there');
      await js(`document.querySelector('#mwl-run').click(); true`);
      await mustWait("!document.querySelector('#mwl-status').className.includes('running')",
        RUN_MS, 'the query against a RIS that is not there to answer');
      const down = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mwl-status').textContent,
        cls: document.querySelector('#mwl-status').className,
        list: document.querySelector('#mwl-results').textContent,
        rows: document.querySelectorAll('#mwl-table tr.pick-row').length,
        error: state.mwl.error,
      })`);
      record(`worklist, RIS down: chip "${down.status}" (${down.cls.replace('status-chip ', '')}), `
        + `list says "${down.list.slice(0, 90).replace(/\s+/g, ' ')}"`);
      await shot('wl-1b-ris-down');
      if (!down.cls.includes('fail') || down.status !== 'Failed') {
        bad(`a RIS that is not there did not read as a failure: ${JSON.stringify(down)}`);
      }
      if (/Nothing scheduled/.test(down.list)) {
        bad('an unreachable RIS was reported as an empty worklist');
      }
      if (!/could not be read/.test(down.list) || !down.error) {
        bad(`the failure is not said where the list is: ${JSON.stringify(down)}`);
      }
      if (down.rows !== rows.length || !/last list that was read/.test(down.list)) {
        bad(`the rows left on screen are not labelled as the previous answer: ${JSON.stringify(down)}`);
      }
      // Back to the RIS that is there.
      await js(`(async () => {
        await deletePeer(${JSON.stringify(DEAD_PEER)});
        setPeerRole(${JSON.stringify(RIS_PEER)}, 'ris');
        await window.dcm.profiles.set({ profiles: state.profiles });
        afterPeersChanged();
      })(); true`);
      await mustWait(`connLabel(state.conn) === ${JSON.stringify(RIS_PEER)}`,
        8000, 'the RIS chip to come back');
      await js(`document.querySelector('#mwl-run').click(); true`);
      await mustWait("!document.querySelector('#mwl-status').className.includes('running')",
        RUN_MS, 'the worklist to answer again');
      const recovered = await jsJSON(`JSON.stringify({
        cls: document.querySelector('#mwl-status').className,
        list: document.querySelector('#mwl-results').textContent,
        error: state.mwl.error,
      })`);
      if (!recovered.cls.includes('ok') || recovered.error || /could not be read/.test(recovered.list)) {
        bad(`a good read did not clear the failure: ${JSON.stringify(recovered)}`);
      }
      say('worklist: a RIS that is not there reads as Failed and says so where the list is');

      // How many rows to ask for is one Settings field, and it lands on the
      // command line like everything else that changes what is sent.
      const limited = await jsJSON(`(async () => {
        __smoke.set('set-mwl-limit', '2');
        await new Promise((r) => setTimeout(r, 400));
        const on = document.querySelector('#mwl-cmd').textContent;
        __smoke.set('set-mwl-limit', '');
        await new Promise((r) => setTimeout(r, 400));
        return JSON.stringify({ on, off: document.querySelector('#mwl-cmd').textContent });
      })()`);
      if (!limited.on.includes('--limit 2') || limited.off.includes('--limit')) {
        bad(`"worklist rows to fetch" does not reach the query: ${JSON.stringify(limited)}`);
      }
      say('worklist: "rows to fetch" adds --limit 2 and removes it again');

      // The search box sends one key, chosen by the shape of the text, and the
      // tag beside it says which — and can be cycled.
      const search = await jsJSON(`(() => {
        const out = {};
        for (const [text, expect] of [['1001', 'PatientID'], ['doe', 'PatientName'], ['ACC-78', 'AccessionNumber']]) {
          __smoke.set('mwl-search', text);
          out[text] = { key: document.querySelector('#mwl-search-key').textContent,
            cmd: document.querySelector('#mwl-cmd').textContent, expect };
        }
        document.querySelector('#mwl-search-key').click();
        out.cycled = document.querySelector('#mwl-search-key').textContent;
        __smoke.set('mwl-search', '');
        return JSON.stringify(out);
      })()`);
      for (const [text, r] of Object.entries(search)) {
        if (text === 'cycled') continue;
        say(`search "${text}" -> ${r.key}`);
        if (r.key !== r.expect) bad(`"${text}" was sent as ${r.key}, expected ${r.expect}`);
        if (!r.cmd.includes(`${r.expect}=`)) bad(`the search key did not reach the command: ${r.cmd}`);
      }
      if (search.cycled === 'AccessionNumber') bad('clicking the key tag did not change the key');
      await shot('wl-2-search');

      // "Only this station" is a Settings switch that shows up in the command.
      const onlyStation = await jsJSON(`(async () => {
        __smoke.set('set-only-station', true);
        await new Promise((r) => setTimeout(r, 400));
        const on = document.querySelector('#mwl-cmd').textContent;
        __smoke.set('set-only-station', false);
        await new Promise((r) => setTimeout(r, 400));
        return JSON.stringify({ on, off: document.querySelector('#mwl-cmd').textContent });
      })()`);
      if (!onlyStation.on.includes('ScheduledStationAETitle=CT01') || onlyStation.off.includes('ScheduledStationAETitle')) {
        bad(`"only this station" does not move the query: ${JSON.stringify(onlyStation)}`);
      }
      say('worklist: "only this station" adds ScheduledStationAETitle=CT01 and removes it again');

      // A refresh may not move the selection to another patient.
      //
      // The list re-reads itself every minute with nobody's hand on it, and a
      // selection kept by position would silently re-point at whoever is now
      // in that position — building one `mpps` command out of two patients.
      // Rows that name no study are keyed on accession, step and patient ID;
      // a row that names none of those is not re-bound at all, and the panel
      // says the list no longer identifies which row this patient is.
      const drift = await jsJSON(`(() => {
        __smoke.realMatches = state.mwl.matches;
        const A = { PatientName: 'ALPHA^ANN', PatientID: 'P-111', AccessionNumber: 'ACC-01',
          Modality: 'CT', ScheduledProcedureStepID: 'SPS-A', ScheduledProcedureStepDescription: 'Head CT' };
        const B = { PatientName: 'BRAVO^BOB', PatientID: 'P-222', AccessionNumber: 'ACC-02',
          Modality: 'MR', ScheduledProcedureStepID: 'SPS-B', ScheduledProcedureStepDescription: 'Knee MR' };
        const read = () => ({
          banner: document.querySelector('#mpps-hero-main').textContent,
          name: worklistAttrs(selectedWorklistItem()).patientName,
          stepId: document.querySelector('#mpps-stepid').value,
          argv: BUILDERS.mpps().join(' '),
          detached: state.mwl.detached || false,
          note: document.querySelector('#mwl-detached-note').hidden ? '' : 'shown',
          noteText: document.querySelector('#mwl-detached-note').textContent,
          performDead: document.querySelector('#mpps-run').disabled,
          performWhy: document.querySelector('#mpps-run').title || '',
        });
        renderWorklist({ ok: true, matches: [A, B] });
        selectRow(document.querySelector('#mwl-table tr.pick-row').dataset.key);
        const before = read();
        renderWorklist({ ok: true, matches: [B, A] });   // the same two rows, the other way round
        const reordered = read();
        renderWorklist({ ok: true, matches: [B] });      // and now ALPHA has left the list
        const gone = read();
        renderWorklist({ ok: true, matches: [B, A] });   // …and now it is back
        const returned = read();
        // Rows carrying nothing that identifies them: keyed by position, so
        // the selection is dropped rather than re-pointed.
        renderWorklist({ ok: true, matches: [{ PatientName: 'CHARLIE^CHO' }, { PatientName: 'DELTA^DEE' }] });
        selectRow(document.querySelector('#mwl-table tr.pick-row').dataset.key);
        const picked = read();
        renderWorklist({ ok: true, matches: [{ PatientName: 'DELTA^DEE' }, { PatientName: 'CHARLIE^CHO' }] });
        const unkeyed = read();
        clearSelection();
        // Those synthetic rows named no step, which forces Details open — the
        // screen the budget is measured on is the one an operator walks up to.
        document.querySelector('#mpps-adv').open = false;
        return JSON.stringify({ before, reordered, gone, returned, picked, unkeyed });
      })()`);
      record(`refresh: rows reversed under a selected ALPHA^ANN left "${drift.reordered.name}" `
        + `on the panel with step ${drift.reordered.stepId}`);
      for (const [label, m] of [['reordered', drift.reordered], ['gone', drift.gone]]) {
        if (m.name !== 'ALPHA^ANN' || m.stepId !== 'SPS-A') {
          bad(`a refresh moved the selection (${label}): ${JSON.stringify(m)}`);
        }
        for (const other of ['BRAVO^BOB', 'P-222', 'SPS-B', 'Knee MR']) {
          if (m.argv.includes(other)) bad(`the command mixes two patients (${label}): ${m.argv}`);
        }
        for (const mine of ['--patient-name ALPHA^ANN', '--patient-id P-111', '--scheduled-step-id SPS-A', '--step-id SPS-A']) {
          if (!m.argv.includes(mine)) bad(`the command lost the selected row (${label}): ${m.argv}`);
        }
      }
      // A row that WAS identified and has left the list: the panel keeps the
      // patient — the outcome and any open step still name them — but it says
      // so where it can be read, and "Perform exam" goes dead. Describing a
      // patient the list no longer holds while the button stays live is what
      // this asserts against; it happened in front of an operator.
      if (drift.before.detached || drift.reordered.detached) {
        bad(`a row that is still in the list came up detached: ${JSON.stringify(drift.reordered)}`);
      }
      if (drift.gone.detached !== 'gone' || drift.gone.note !== 'shown') {
        bad(`a row that left the list said nothing: ${JSON.stringify(drift.gone)}`);
      }
      if (!/no longer lists this row/.test(drift.gone.noteText)) {
        bad(`the note does not say the list no longer holds the row: ${drift.gone.noteText}`);
      }
      if (!drift.gone.performDead || !/not in the list/.test(drift.gone.performWhy)) {
        bad(`"Perform exam" stayed live for a row the list no longer holds: ${JSON.stringify(drift.gone)}`);
      }
      // And it heals: the row comes back, the note goes, the verb comes back.
      if (drift.returned.detached || drift.returned.note !== '' || drift.returned.performDead) {
        bad(`the row came back and the panel did not re-attach: ${JSON.stringify(drift.returned)}`);
      }
      if (drift.returned.name !== 'ALPHA^ANN') bad(`re-attaching moved the patient: ${JSON.stringify(drift.returned)}`);
      say('refresh: a row that leaves the list detaches visibly and kills the verb; a row that comes back re-attaches');

      // The station's word budget with its repair notes ON. Those notes sit
      // above the primary button like everything else, so a repair that is
      // three sentences long is a screen nobody reads — the reasons belong in
      // the help panel, and the budget is what keeps them there.
      const repairWords = await jsJSON(`(() => {
        renderWorklist({ ok: true, matches: [{ PatientName: 'ALPHA^ANN', PatientID: 'P-111',
          AccessionNumber: 'ACC-01', Modality: 'CT', ScheduledProcedureStepID: 'SPS-A',
          ScheduledProcedureStepDescription: 'Head CT' }] });
        selectRow(document.querySelector('#mwl-table tr.pick-row').dataset.key);
        renderWorklist({ ok: true, matches: [{ PatientName: 'BRAVO^BOB', PatientID: 'P-222' }] });
        const gone = __smoke.measure('#view-worklist', '#mpps-run');
        // …and again with the folder unread on top of it, which is the other
        // repair line and the two can be on screen together.
        document.querySelector('#mpps-folder').value = 'C:/nowhere';
        state.mpps.scan = null;
        renderFolderLine();
        applyVerbGuards();
        const both = __smoke.measure('#view-worklist', '#mpps-run');
        document.querySelector('#mpps-folder').value = '';
        state.mpps.scan = null;
        clearSelection();
        return JSON.stringify({ gone, both });
      })()`);
      // Asserted here rather than pooled: the pooled check ran back in section
      // C, long before this state could be reached.
      for (const [label, key] of [['gone', 'worklist-gone'], ['both', 'worklist-repairs']]) {
        const m = repairWords[label];
        record(`words: ${key} — ${m.words} words above "${m.primary}" (budget ${BUDGET[key]})`);
        wordLog.push(`${key} (${m.words} words above "${m.primary}"):\n  ${m.text}\n`);
        if (m.words > BUDGET[key]) {
          bad(`word budget exceeded — the station with its repair notes on (${key}): `
            + `${m.words} words above "${m.primary}", budget ${BUDGET[key]}\n  ${m.text}`);
        }
      }
      artefact('word-measure.txt', wordLog.join('\n'));

      if (drift.picked.detached) bad('a fresh selection came up detached');
      if (drift.unkeyed.name !== 'CHARLIE^CHO' || !drift.unkeyed.detached || drift.unkeyed.note !== 'shown') {
        bad(`an unidentifiable row was re-pointed instead of held: ${JSON.stringify(drift.unkeyed)}`);
      }
      if (drift.unkeyed.argv.includes('DELTA^DEE')) {
        bad(`the command followed the list rather than the patient: ${drift.unkeyed.argv}`);
      }
      say('refresh: the selection is kept by identity, never by position; an unkeyable row detaches and says so');
      // Back to the real list, from the answer the RIS already gave.
      await js(`(() => { renderWorklist({ ok: true, matches: __smoke.realMatches }); return true; })()`);
      const restored = await js("document.querySelectorAll('#mwl-table tr.pick-row').length");
      if (restored !== rows.length) bad(`the real list did not come back: ${restored} rows`);

      // --- H1: the matching row, performed --------------------------------
      const selectRowFor = async (patient) => {
        await js(`(() => {
          const tr = Array.from(document.querySelectorAll('#mwl-table tr.pick-row'))
            .find((r) => r.textContent.includes(${JSON.stringify(patient)}));
          if (!tr) throw new Error('no row for ${patient}');
          tr.click();
          return true;
        })()`);
      };
      // The app's own answer, not a guess from the text: mppsFolderUnknown()
      // is the single function the verdict line and the verb guard both read,
      // so waiting on it is waiting on exactly the state the screen is in.
      const VERDICT = "(() => { const b = document.querySelector('#mpps-folder-check');"
        + " return !b.hidden && b.textContent && !mppsFolderUnknown(); })()";
      const SLOW = "/took too long/.test(document.querySelector('#mpps-folder-check').textContent)";
      const waitFolder = async () => {
        // The app gives the scan 20 seconds and then says so rather than
        // hanging. On a loaded machine a child can take that long to hand
        // back, and "it took too long" is not a verdict about the folder — so
        // ask again rather than asserting on it.
        for (let attempt = 0; attempt < 3; attempt++) {
          await mustWait(VERDICT, 60000, 'the folder check to produce a verdict');
          // eslint-disable-next-line no-await-in-loop
          if (!await js(SLOW)) return;
          say('folder check: the scan ran out of time on a busy machine — asking again');
          // eslint-disable-next-line no-await-in-loop
          await js('checkMppsFolder(); true');
          // eslint-disable-next-line no-await-in-loop
          await wait(300);
        }
        bad('the folder check never produced a verdict');
      };

      await selectRowFor('SMITH^ALAN');
      const scanStarted = Date.now();
      await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
      await waitFolder();
      // The folder scan is what the verbs wait for, so how long it takes is
      // part of how this screen behaves, not a detail: it is printed every run.
      record(`station: the folder verdict landed in ${Date.now() - scanStarted}ms`);
      await wait(200);
      await shot('wl-3-row-selected');
      const panel = await jsJSON(`JSON.stringify({
        open: !document.querySelector('#mwl-detail-body').hidden,
        mode: panelMode(),
        hero: document.querySelector('#mpps-hero-main').textContent,
        sub: document.querySelector('#mpps-hero-sub').textContent,
        uid: document.querySelector('#mpps-hero-uid').textContent,
        folderLine: document.querySelector('#mpps-folder-check').textContent,
        folderCls: document.querySelector('#mpps-folder-check').className,
        type1: !document.querySelector('#mpps-type1-warn').hidden,
        cmd: document.querySelector('#mpps-cmd').textContent,
        adv: document.querySelector('#mpps-adv-sum').textContent,
        find: document.querySelector('#mwl-cmd').textContent,
      })`);
      record(`station: ${panel.hero} — ${panel.sub}`);
      record(`station: folder line — ${panel.folderLine}`);
      say(`station: ${panel.cmd}`);
      artefact('mpps-cmd.txt', panel.cmd);
      if (!panel.open || panel.mode !== 'perform') bad(`the panel did not open in perform mode: ${JSON.stringify(panel)}`);
      if (panel.type1) bad(`a complete row raised a Type 1 warning: ${panel.folderLine}`);
      if (!/matches this row/.test(panel.folderLine) || !/ARCHIVE/.test(panel.folderLine)) {
        bad(`the folder line does not say the study matches and where it goes: ${panel.folderLine}`);
      }
      if (!panel.folderCls.includes('ok')) bad(`a matching folder is not styled as OK: ${panel.folderCls}`);
      if (!cmdNames(panel.cmd, fixtures)) bad(`the perform command does not name the folder: ${panel.cmd}`);
      for (const needed of ['mpps perform', '--study-uid ' + FIX_STUDY,
        '--accession ACC-78', '--patient-id P-2002', '--patient-name "SMITH^ALAN"', '--modality CT',
        '--scheduled-step-id SPS-2', '--step-id SPS-2', '--station-ae CT01', '--mpps-uid 2.25.',
        `--store-host 127.0.0.1`, `--store-port ${archivePort}`, '--store-called-ae ARCHIVE',
        `--host 127.0.0.1`, `--port ${risPort}`, '--called-ae RISMPPS', '--calling-ae CT01']) {
        if (!panel.cmd.includes(needed)) bad(`the perform command is missing ${needed}: ${panel.cmd}`);
      }
      // Both peers in full, always: a default you cannot see is a default
      // nobody can check, and the images and the step go to different systems.
      if (panel.cmd.includes('--dry-run')) bad(`rehearsal is off and the perform still carries --dry-run: ${panel.cmd}`);
      for (const banned of ['--adopt-worklist-identity', '--allow-study-mismatch', '--write-acknowledged', '--record-dir']) {
        if (panel.cmd.includes(banned)) bad(`a matching study's command carries ${banned}: ${panel.cmd}`);
      }
      // The query preview is a separate preview in the same section and must
      // not have been overwritten by the perform one.
      if (!panel.find.includes('--mwl')) bad(`the query preview was clobbered: ${panel.find}`);
      await measureScreen('worklist', '#view-worklist', '#mpps-run');

      // Start only runs a different command from Perform exam — no folder, no
      // archive, no re-stamping — so it has a preview of its own. The rule
      // this app is built on is that the preview IS the command; a second verb
      // whose command is nowhere on screen would be the one place it bent.
      const startFold = await jsJSON(`JSON.stringify({
        folds: __smoke.folds('#view-worklist'),
        argv: 'dcm ' + mppsStartArgv().map(quoteArg).join(' '),
      })`);
      const startCmdFold = startFold.folds.find((f) => f.id === 'mpps-start-cmd-fold');
      if (!startCmdFold) bad('"Start only" has no command of its own on screen');
      else {
        if (startCmdFold.open) bad('the start command fold is open while "Show commands expanded" is off');
        if (startCmdFold.cmd !== startFold.argv) {
          bad(`the start preview is not the command that would run: ${startCmdFold.cmd} vs ${startFold.argv}`);
        }
        if (startCmdFold.sum.trim() !== startCmdFold.cmd.trim()) {
          bad(`the folded start summary does not carry its command: ${startCmdFold.sum}`);
        }
        if (!/^dcm mpps start /.test(startCmdFold.cmd)) bad(`the start preview is not a start: ${startCmdFold.cmd}`);
        if (startCmdFold.cmd.includes('--store-host') || cmdNames(startCmdFold.cmd, fixtures)) {
          bad(`the start preview names an archive or a folder it will not touch: ${startCmdFold.cmd}`);
        }
      }
      const performFold = startFold.folds.find((f) => f.id === 'mpps-cmd-fold');
      if (!performFold || !/^dcm mpps perform /.test(performFold.cmd)) {
        bad(`the perform preview is not beside it: ${JSON.stringify(performFold)}`);
      }
      say(`station: "Start only" carries its own command — ${startCmdFold ? startCmdFold.cmd.slice(0, 60) : '(none)'}…`);

      // A performed station AE typed over for one patient belongs to that
      // patient. Blanked, it is said in amber rather than left to be inferred
      // from a flag that quietly went missing — and the next patient gets the
      // station's own AE Title back.
      const stationField = await jsJSON(`(() => {
        __smoke.set('mpps-stationae', '');
        const out = {
          warn: document.querySelector('#mpps-type1-warn').hidden ? '' : document.querySelector('#mpps-type1-warn').textContent,
          argv: BUILDERS.mpps().join(' '),
          start: mppsStartArgv().join(' '),
        };
        __smoke.set('mpps-stationae', 'CT01');
        out.restored = BUILDERS.mpps().join(' ');
        return JSON.stringify(out);
      })()`);
      if (!/no AE Title/.test(stationField.warn)) {
        bad(`a blank performed station AE is not said on screen: ${JSON.stringify(stationField.warn)}`);
      }
      if (stationField.argv.includes('--station-ae')) {
        bad(`a blank field still put --station-ae on the command: ${stationField.argv}`);
      }
      if (!stationField.restored.includes('--station-ae CT01')) {
        bad(`typing the station AE back did not restore the flag: ${stationField.restored}`);
      }
      say('station: blanking the performed station AE is said in amber, not left to a missing flag');

      // …and it belongs to the patient it was typed for: the next patient
      // gets this station's own AE Title back rather than yesterday's edit.
      const stationSticky = await jsJSON(`(async () => {
        __smoke.set('mpps-stationae', 'ONE-OFF');
        const mine = document.querySelector('#mpps-stationae').value;
        selectRow(Array.from(document.querySelectorAll('#mwl-table tr.pick-row'))
          .find((r) => r.textContent.includes('PARK^SOO')).dataset.key);
        await new Promise((r) => setTimeout(r, 100));
        const next = document.querySelector('#mpps-stationae').value;
        selectRow(Array.from(document.querySelectorAll('#mwl-table tr.pick-row'))
          .find((r) => r.textContent.includes('SMITH^ALAN')).dataset.key);
        await new Promise((r) => setTimeout(r, 100));
        return JSON.stringify({ mine, next, back: document.querySelector('#mpps-stationae').value });
      })()`);
      if (stationSticky.mine !== 'ONE-OFF' || stationSticky.next !== 'CT01' || stationSticky.back !== 'CT01') {
        bad(`a one-off station AE outlived its patient: ${JSON.stringify(stationSticky)}`);
      }
      // That round trip cleared the folder, as picking a patient does.
      await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
      await waitFolder();

      // Details holds the per-run overrides. Folding them away must not fold
      // away what they will send, so the summary beside the triangle names
      // anything set — and the command below the button carries it.
      const details = await jsJSON(`(() => {
        __smoke.set('mpps-chunk', '50');
        __smoke.set('mpps-retrieveae', 'ARCH');
        __smoke.set('mpps-stepdesc', 'Desc X');
        const out = { sum: document.querySelector('#mpps-adv-sum').textContent,
          cmd: document.querySelector('#mpps-cmd').textContent };
        __smoke.set('mpps-chunk', '');
        __smoke.set('mpps-retrieveae', '');
        __smoke.set('mpps-stepdesc', 'Chest 2 View');
        out.restored = document.querySelector('#mpps-cmd').textContent;
        return JSON.stringify(out);
      })()`);
      say(`station Details: ${details.sum}`);
      for (const needed of ['chunk 50', 'retrieve AE ARCH', 'Desc X']) {
        if (!details.sum.includes(needed)) bad(`the Details summary hides ${needed}: ${details.sum}`);
      }
      for (const needed of ['--chunk 50', '--retrieve-ae ARCH', '--step-description "Desc X"']) {
        if (!details.cmd.includes(needed)) bad(`Details did not reach the command: ${details.cmd}`);
      }
      if (!/attributes/.test(details.sum)) {
        bad(`the Details summary does not count what the SCP returned: ${details.sum}`);
      }
      for (const gone of ['--chunk', '--retrieve-ae']) {
        if (details.restored.includes(gone)) bad(`clearing a Details field left ${gone} on the command`);
      }

      // Rehearsal, on the one screen where the button says what it will do.
      // A "Perform exam" that is not going to perform anything is the single
      // most dangerous label in this app, so it changes.
      const rehearsed = await jsJSON(`(async () => {
        __smoke.set('set-rehearsal', true);
        await new Promise((r) => setTimeout(r, 400));
        const out = {
          banner: !document.querySelector('#rehearsal-banner').hidden,
          perform: document.querySelector('#mpps-run').textContent,
          start: document.querySelector('#mpps-start').textContent,
          cmd: document.querySelector('#mpps-cmd').textContent,
          startArgv: mppsStartArgv().join(' '),
        };
        __smoke.set('set-rehearsal', false);
        await new Promise((r) => setTimeout(r, 400));
        out.back = document.querySelector('#mpps-run').textContent;
        out.backCmd = document.querySelector('#mpps-cmd').textContent;
        return JSON.stringify(out);
      })()`);
      record(`rehearsal at the station: "${rehearsed.perform}" / "${rehearsed.start}", `
        + `and the command ends ${rehearsed.cmd.slice(-9)}`);
      if (rehearsed.perform !== 'Rehearse exam' || rehearsed.start !== 'Rehearse start') {
        bad(`the station's verbs did not relabel for rehearsal: ${rehearsed.perform} / ${rehearsed.start}`);
      }
      if (!rehearsed.cmd.includes('--dry-run') || !rehearsed.startArgv.includes('--dry-run')) {
        bad(`rehearsal did not reach the station's commands: ${rehearsed.cmd}`);
      }
      if (rehearsed.back !== 'Perform exam' || rehearsed.backCmd.includes('--dry-run')) {
        bad(`turning rehearsal off did not put the station back: ${rehearsed.back} / ${rehearsed.backCmd}`);
      }

      await js(`document.querySelector('#mpps-run').click(); true`);
      await mustWait("!document.querySelector('#mpps-status').className.includes('running')",
        RUN_MS, 'the perform to finish');
      const performed = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mpps-status').textContent,
        outcome: document.querySelector('#mpps-outcome').textContent,
        cls: document.querySelector('#mpps-outcome').className,
        totals: Array.from(document.querySelectorAll('#mpps-totals .total-card')).map(
          (c) => c.querySelector('.lbl').textContent + '=' + c.querySelector('.num').textContent),
        pill: (document.querySelector('#mwl-table tr.row-selected td.session-cell') || {}).textContent || '',
        steps: state.steps.entries.length,
        mode: panelMode(),
      })`);
      record(`perform: ${performed.status} — ${performed.totals.join(', ')}`);
      say(`perform outcome: ${performed.outcome}`);
      await shot('wl-4-performed');
      if (performed.status !== 'COMPLETED') bad(`the perform did not complete: ${performed.status}`);
      if (!performed.cls.includes('ok')) bad(`a COMPLETED step is not styled as a success: ${performed.cls}`);
      if (!performed.totals.includes('found=10') || !performed.totals.includes('acknowledged=10')) {
        bad(`the totals do not account for all ten fixture instances: ${JSON.stringify(performed.totals)}`);
      }
      if (!/COMPLETED 10\/10/.test(performed.pill)) bad(`the row pill does not carry the result: "${performed.pill}"`);
      if (performed.steps !== 1) bad(`the session remembers ${performed.steps} steps after one perform`);

      // --- H2: the mismatch case, with stock fixtures ---------------------
      //
      // A new patient is a new folder: the last patient's images do not carry
      // over, and until the folder that is chosen has been read nothing on
      // screen knows whose images they are — so the verbs are not live while
      // it is being read. The primary button is the first thing a hand goes
      // to, and this is the sequence where that would have sent one patient's
      // images into another patient's procedure step.
      await selectRowFor('DOE^JANE');
      const carried = await jsJSON(`JSON.stringify({
        folder: document.querySelector('#mpps-folder').value,
        line: document.querySelector('#mpps-folder-check').hidden ? '' : document.querySelector('#mpps-folder-check').textContent,
      })`);
      if (carried.folder !== '') {
        bad(`the previous patient's folder carried over to the next one: ${JSON.stringify(carried)}`);
      }
      say('station: picking another patient cleared the folder the last exam was sent from');
      const guarded = await jsJSON(`(async () => {
        const out = { sawReading: false, armedWhileReading: false };
        __smoke.set('mpps-folder', ${JSON.stringify(fixtures)});
        const t0 = Date.now();
        while (Date.now() - t0 < 40000) {
          if (state.mpps.scan && state.mpps.scan.reading) {
            out.sawReading = true;
            if (!document.querySelector('#mpps-run').disabled
              || !document.querySelector('#mpps-start').disabled) out.armedWhileReading = true;
            out.why = document.querySelector('#mpps-run').title;
          } else if (state.mpps.scan) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        out.after = {
          perform: document.querySelector('#mpps-run').disabled,
          start: document.querySelector('#mpps-start').disabled,
        };
        return JSON.stringify(out);
      })()`);
      if (!guarded.sawReading) bad('the folder was never read for the new patient');
      if (guarded.armedWhileReading) {
        bad('"Perform exam" was live while the folder was still being read');
      }
      if (!/folder/i.test(guarded.why || '')) {
        bad(`the dead verb does not say what it is waiting for: ${JSON.stringify(guarded.why)}`);
      }
      if (guarded.after.perform || guarded.after.start) {
        bad(`the verbs stayed dead after the folder was read: ${JSON.stringify(guarded.after)}`);
      }
      say('station: the verbs are dead while the folder is being read and live once it has been');
      await waitFolder();
      await wait(200);
      await shot('wl-5-mismatch');
      const mismatch = await jsJSON(`JSON.stringify({
        kind: state.mpps.mismatch && state.mpps.mismatch.kind,
        line: document.querySelector('#mpps-folder-check').textContent,
        cls: document.querySelector('#mpps-folder-check').className,
        switchHidden: document.querySelector('#mpps-fix-switch').hidden,
        cmd: document.querySelector('#mpps-cmd').textContent,
      })`);
      record(`mismatch: ${mismatch.line}`);
      say(`mismatch command: ${mismatch.cmd}`);
      artefact('mpps-mismatch-adopt-cmd.txt', mismatch.cmd);
      if (mismatch.kind !== 'one-study') {
        bad(`the stock fixtures did not read as a different study for this row: ${JSON.stringify(mismatch)}`);
      }
      if (!/re-stamped copy/.test(mismatch.line) || !/not modified/.test(mismatch.line)) {
        bad(`the folder line does not say what will happen to a different study: ${mismatch.line}`);
      }
      if (!mismatch.cmd.includes('--adopt-worklist-identity')) {
        bad(`the mismatch did not put --adopt-worklist-identity on the command: ${mismatch.cmd}`);
      }
      // Sending as-is exists only when Settings > Engineer options allows it.
      if (!mismatch.switchHidden) bad('the "send as-is" switch is offered without the engineer option');

      const asIs = await jsJSON(`(async () => {
        __smoke.set('set-allow-mismatch', true);
        await new Promise((r) => setTimeout(r, 400));
        const shown = !document.querySelector('#mpps-fix-switch').hidden;
        document.querySelector('#mpps-fix-switch .chip[data-fix="asis"]').click();
        const cmd = document.querySelector('#mpps-cmd').textContent;
        const line = document.querySelector('#mpps-folder-check').textContent;
        document.querySelector('#mpps-fix-switch .chip[data-fix="adopt"]').click();
        __smoke.set('set-allow-mismatch', false);
        await new Promise((r) => setTimeout(r, 400));
        return JSON.stringify({ shown, cmd, line, back: document.querySelector('#mpps-cmd').textContent });
      })()`);
      say(`mismatch, send as-is: ${asIs.cmd}`);
      artefact('mpps-mismatch-asis-cmd.txt', asIs.cmd);
      if (!asIs.shown) bad('the engineer option did not raise the two-way switch');
      if (!asIs.cmd.includes('--allow-study-mismatch') || asIs.cmd.includes('--adopt-worklist-identity')) {
        bad(`the two ways past a mismatch are not exclusive: ${asIs.cmd}`);
      }
      if (!/Nothing reconciles afterwards/.test(asIs.line)) {
        bad(`sending as-is does not say what it costs: ${asIs.line}`);
      }
      if (!asIs.back.includes('--adopt-worklist-identity')) {
        bad(`turning the engineer option off did not go back to re-stamping: ${asIs.back}`);
      }

      await js(`document.querySelector('#mpps-run').click(); true`);
      await mustWait("!document.querySelector('#mpps-status').className.includes('running')",
        RUN_MS, 'the re-stamped perform to finish');
      // Same as the send above: the console is a frame behind the child's exit.
      await mustWait('/staging copy removed|read only/.test(__smoke.consoleText("mpps"))',
        15000, "the re-stamped run's report to be written");
      const adopted = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mpps-status').textContent,
        console: __smoke.consoleText('mpps'),
        totals: Array.from(document.querySelectorAll('#mpps-totals .total-card')).map(
          (c) => c.querySelector('.lbl').textContent + '=' + c.querySelector('.num').textContent),
      })`);
      record(`perform (re-stamped): ${adopted.status} — ${adopted.totals.join(', ')}`);
      await shot('wl-6-mismatch-performed');
      if (adopted.status !== 'COMPLETED') bad(`the re-stamped perform did not complete: ${adopted.status}`);
      if (!/re-stamped 10 instance/.test(adopted.console)) {
        bad(`the engine did not report re-stamping: ${adopted.console.slice(0, 400)}`);
      }
      if (!/read only — not modified/.test(adopted.console)) {
        bad('the engine did not say the source folder was left alone');
      }

      // --- H2b: the screen must never arm a verb it cannot explain ---------
      //
      // The failure this reproduces happened to a real operator against a real
      // RIS: the line under the folder was HIDDEN — `state.mpps.scan` was null,
      // which renderFolderLine treated as "nothing to say" — while "Perform
      // exam" stayed live, so the app built a command from a folder nothing on
      // screen had read and the engine refused it with exit 2. There is
      // nothing special about null: a scan that timed out, could not be
      // parsed, or found no DICOM leaves the screen just as ignorant, and
      // those cases used to leave the verbs live too.
      //
      // So the rule is asserted as a class. For each way of not knowing what
      // the folder holds: the verdict line is on screen, and both verbs are
      // dead with the reason on them.
      const blindStates = await jsJSON(`(() => {
        const box = document.querySelector('#mpps-folder-check');
        const read = () => ({
          hidden: box.hidden,
          line: box.textContent,
          perform: document.querySelector('#mpps-run').disabled,
          start: document.querySelector('#mpps-start').disabled,
          why: document.querySelector('#mpps-run').title || '',
          adopts: document.querySelector('#mpps-cmd').textContent.includes('--adopt-worklist-identity'),
          retry: !!document.querySelector('#mpps-recheck'),
        });
        const put = (scan) => {
          state.mpps.scan = scan;
          state.mpps.mismatch = null;
          renderFolderLine();
          updateAllPreviews();
          applyVerbGuards();
          return read();
        };
        const out = {
          neverRan: put(null),
          timedOut: put({ warn: 'This folder took too long to read, so its study is unknown.' }),
          unreadable: put({ warn: 'This folder could not be read.' }),
          noDicom: put({ warn: 'No DICOM instances here (12 files examined).' }),
          reading: put({ reading: true }),
        };
        return JSON.stringify(out);
      })()`);
      for (const [label, s] of Object.entries(blindStates)) {
        if (s.hidden) bad(`the verdict line is hidden while the folder is unknown (${label}): ${JSON.stringify(s)}`);
        if (!s.line.trim()) bad(`the verdict line is empty while the folder is unknown (${label})`);
        if (!s.perform || !s.start) {
          bad(`a verb stayed live over an unread folder (${label}): ${JSON.stringify(s)}`);
        }
        if (!s.why.trim()) bad(`the dead verb carries no reason (${label})`);
        // Only the folder's own study can put --adopt-worklist-identity on the
        // command; a screen that does not know the study must not be claiming
        // to have re-stamped for it.
        if (s.adopts) bad(`the command claims a re-stamp for a folder nothing read (${label}): ${JSON.stringify(s)}`);
        say(`unread folder (${label}): "${s.line.trim().slice(0, 80)}" — verbs dead, reason "${s.why.slice(0, 60)}"`);
      }
      // Three of those five offer the one-click way out; "reading" does not,
      // because a scan is already running.
      if (!blindStates.neverRan.retry || !blindStates.unreadable.retry) {
        bad('a folder that could not be read offers no way to read it again');
      }
      if (blindStates.reading.retry) bad('"Read it again" is offered while a scan is already running');
      record('station: every way of not knowing what the folder holds kills both verbs and says so where the verdict goes');

      // …and the way out works: the same folder, read again, comes back to a
      // verdict and live verbs rather than needing the path re-typed.
      await js(`(() => { state.mpps.scan = null; renderFolderLine(); applyVerbGuards();
        document.querySelector('#mpps-recheck').click(); return true; })()`);
      await waitFolder();
      const rescanned = await jsJSON(`JSON.stringify({
        perform: document.querySelector('#mpps-run').disabled,
        line: document.querySelector('#mpps-folder-check').textContent,
        adopts: document.querySelector('#mpps-cmd').textContent.includes('--adopt-worklist-identity'),
      })`);
      if (rescanned.perform || !rescanned.adopts) {
        bad(`"Read it again" did not put the screen back: ${JSON.stringify(rescanned)}`);
      }
      say('station: "Read it again" re-reads the same folder and the verbs come back');

      // --- H2c: an exit 2 the app cannot predict, and whose reason it holds -
      //
      // The other half of the same field failure. The app built a command the
      // engine refused, the engine said in one line on stderr exactly which
      // part it refused, and the screen printed "The engine exited 2 without
      // reporting a closed step. The output is the whole story" over the top
      // of it. The story was one line long and the app was holding it.
      //
      // Driven with a row whose Study Instance UID is not a UID. Nothing on
      // this screen can know that — the folder scans fine, the mismatch is
      // found, --adopt-worklist-identity goes on the command — and the engine
      // refuses on the UID before it opens anything. That is the shape: a
      // usage error that is NOT the study mismatch the app special-cases.
      const BAD_UID_ROW = {
        PatientName: 'BADUID^TEST', PatientID: 'P-9009', AccessionNumber: 'ACC-99',
        StudyInstanceUID: '1.2.3..4', Modality: 'CT', ScheduledProcedureStepID: 'SPS-9',
        RequestedProcedureDescription: 'Bad UID row', RequestedProcedureID: 'RP-9',
      };
      await js(`(() => {
        __smoke.savedMatches = state.mwl.matches;
        renderWorklist({ ok: true, matches: [${JSON.stringify(BAD_UID_ROW)}] });
        document.querySelector('#mwl-table tr.pick-row').click();
        return true;
      })()`);
      await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
      await waitFolder();
      const willRefuse = await js("document.querySelector('#mpps-cmd').textContent");
      if (!willRefuse.includes('--study-uid 1.2.3..4')) {
        bad(`the bad UID did not reach the command, so this proves nothing: ${willRefuse}`);
      }
      await js(`document.querySelector('#mpps-run').click(); true`);
      await mustWait("!document.querySelector('#mpps-status').className.includes('running')",
        RUN_MS, 'the refused perform to come back');
      const refused = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mpps-status').textContent,
        cls: document.querySelector('#mpps-outcome').className,
        head: (document.querySelector('#mpps-outcome .outcome-head') || {}).textContent || '',
        said: (document.querySelector('#mpps-outcome .engine-said') || {}).textContent || '',
        all: document.querySelector('#mpps-outcome').textContent,
        outOpen: __smoke.outOpen('mpps'),
      })`);
      record(`refused: ${refused.head} ${refused.said.split('\\n')[0]}`);
      artefact('mpps-refused-outcome.txt', refused.all);
      await shot('wl-5b-refused-exit2');
      if (refused.status !== 'Failed') bad(`a refused run did not read as failed: ${refused.status}`);
      if (!refused.cls.includes('bad')) bad(`a refused run is not in the red box: ${refused.cls}`);
      if (!refused.said) {
        bad(`the engine's own sentence is not on screen: ${JSON.stringify(refused)}`);
      }
      if (!/not a valid DICOM UID/.test(refused.said)) {
        bad(`the screen shows something other than what the engine refused on: ${refused.said}`);
      }
      // The generic sentence the app used to print INSTEAD of the above. It
      // may not come back, and it may not sit alongside a message either.
      if (/is the whole story/.test(refused.all)) {
        bad(`the app is still printing a generic line over a message it holds: ${refused.all}`);
      }
      if (!/Refused before anything ran/.test(refused.head)) {
        bad(`an exit 2 is not said to be a refusal reached before anything ran: ${refused.head}`);
      }
      if (!refused.outOpen) bad('a refused run left the output folded away');
      // Nothing was sent, so nothing may have been remembered as a step.
      const noStep = await js("state.steps.entries.filter((e) => e.patientId === 'P-9009').length");
      if (noStep) bad(`a refused run was remembered as ${noStep} step(s)`);
      record('station: an exit 2 shows the engine\'s own sentence, says nothing was sent, and remembers no step');
      await js(`(() => { renderWorklist({ ok: true, matches: __smoke.savedMatches }); clearSelection(); return true; })()`);

      // --- H2d: the station, driven by its own Browse… button -------------
      //
      // The regression test for the defect this pass was about. See the block
      // above pressPicker() for what was wrong and why nothing here caught it:
      // in short, no test had ever pressed a picker, so the one route an
      // operator actually takes into #mpps-folder was the one route never run.
      //
      // Three presses from a clean screen, each of which reached the engine
      // and was refused: a folder holding two studies, a folder with no DICOM,
      // and a folder whose study differs from the row.
      armPicker();

      // Both refusable folders are built from the fixtures rather than
      // described. `dcm anon` remaps UIDs consistently, so study-a and study-b
      // under one parent really are two Study Instance UIDs, not one twice.
      const pickTwo = path.join(work, 'picked-two-studies');
      fs.rmSync(pickTwo, { recursive: true, force: true });
      fs.mkdirSync(pickTwo, { recursive: true });
      fs.cpSync(fixtures, path.join(pickTwo, 'study-a'), { recursive: true });
      const secondStudy = await runEngine(['anon', fixtures, '--out', path.join(pickTwo, 'study-b')]);
      if (secondStudy.code !== 0) {
        bad(`could not build a two-study folder to pick: ${secondStudy.err.slice(-400)}`);
      }
      // Files, not an empty directory: "nothing here is DICOM" is the case an
      // operator hits by pointing at the wrong folder, and it is a different
      // engine answer from "there is nothing here at all".
      const pickNone = path.join(work, 'picked-no-dicom');
      fs.rmSync(pickNone, { recursive: true, force: true });
      fs.mkdirSync(pickNone, { recursive: true });
      fs.writeFileSync(path.join(pickNone, 'notes.txt'), 'not DICOM\n');
      fs.writeFileSync(path.join(pickNone, 'photo.jpg'), 'not DICOM either\n');

      // What the screen says the instant a picked path lands, and what it says
      // once the folder has been read. The first is the assertion that fails
      // on the old code: with `change` alone the field held a new folder while
      // the verdict line stayed hidden and both verbs stayed live.
      const AT_PRESS = `({
        reading: !!(state.mpps.scan && state.mpps.scan.reading),
        lineHidden: document.querySelector('#mpps-folder-check').hidden,
        line: document.querySelector('#mpps-folder-check').textContent,
        perform: document.querySelector('#mpps-run').disabled,
        start: document.querySelector('#mpps-start').disabled,
        why: document.querySelector('#mpps-run').title || '',
      })`;
      const settled = () => jsJSON(`JSON.stringify({
        line: document.querySelector('#mpps-folder-check').textContent,
        lineHidden: document.querySelector('#mpps-folder-check').hidden,
        cls: document.querySelector('#mpps-folder-check').className,
        perform: document.querySelector('#mpps-run').disabled,
        start: document.querySelector('#mpps-start').disabled,
        why: document.querySelector('#mpps-run').title || '',
        cmd: document.querySelector('#mpps-cmd').textContent,
      })`);
      // "No DICOM here" is a warning rather than a verdict, so mppsFolderUnknown()
      // stays truthy for it by design and waitFolder would wait for a verdict
      // that is never coming. This waits for the scan to settle instead, and
      // re-asks on the one settled state that is about the machine rather than
      // about the folder.
      const waitScanned = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          // eslint-disable-next-line no-await-in-loop
          await mustWait('!!state.mpps.scan && !state.mpps.scan.reading', 60000, 'the folder scan to settle');
          // eslint-disable-next-line no-await-in-loop
          if (!await js(SLOW)) return;
          say('folder check: the scan ran out of time on a busy machine — asking again');
          // eslint-disable-next-line no-await-in-loop
          await js('checkMppsFolder(); true');
          // eslint-disable-next-line no-await-in-loop
          await wait(300);
        }
        bad('the folder scan never settled');
      };
      // A dead button cannot be pressed, and this is how that is proved rather
      // than asserted: click it for real and show that no run began.
      const pressPerform = () => jsJSON(`(async () => {
        document.querySelector('#mpps-run').click();
        await new Promise((r) => setTimeout(r, 400));
        return JSON.stringify({
          ran: !!state.activeRuns.mpps,
          status: document.querySelector('#mpps-status').textContent,
        });
      })()`);

      // ---- 1. a folder holding two studies.
      await selectRowFor('DOE^JANE');
      const twoAt = await pressPicker('mpps-folder', pickTwo, AT_PRESS);
      if (twoAt.lineHidden || !twoAt.reading) {
        bad(`Browse… changed the folder without the screen disowning the old verdict: ${JSON.stringify(twoAt)}`);
      }
      if (!twoAt.perform || !twoAt.start) {
        bad(`a verb was live the instant Browse… filled the field — this is the exit 2: ${JSON.stringify(twoAt)}`);
      }
      record(`picked (two studies): at the press — "${twoAt.line.trim()}", verbs dead ("${twoAt.why}")`);
      await waitFolder();
      const two = await settled();
      await shot('wl-5c-picked-two-studies');
      record(`picked (two studies): ${two.line.trim()}`);
      if (two.lineHidden || !/2 studies/.test(two.line) || !/Split the folder/.test(two.line)) {
        bad(`a picked two-study folder is not named as one: ${JSON.stringify(two)}`);
      }
      if (!two.cls.includes('bad')) bad(`a refused folder is not styled as refused: ${two.cls}`);
      if (!two.perform || !two.start) bad(`a verb is live over two studies: ${JSON.stringify(two)}`);
      if (!/more than one study/.test(two.why)) bad(`the dead verb does not say why: ${two.why}`);
      if (two.cmd.includes('--adopt-worklist-identity')) {
        bad(`a folder holding two studies claims a re-stamp: ${two.cmd}`);
      }
      const twoPress = await pressPerform();
      if (twoPress.ran) bad(`pressing Perform over two studies started a run: ${JSON.stringify(twoPress)}`);

      // ---- 2. a folder with no DICOM in it.
      const noneAt = await pressPicker('mpps-folder', pickNone, AT_PRESS);
      if (noneAt.lineHidden || !noneAt.reading || !noneAt.perform || !noneAt.start) {
        bad(`Browse… to a second folder left the first one's answer standing: ${JSON.stringify(noneAt)}`);
      }
      await waitScanned();
      const none = await settled();
      await shot('wl-5d-picked-no-dicom');
      record(`picked (no DICOM): ${none.line.trim()}`);
      if (none.lineHidden || !/No DICOM instances here/.test(none.line)) {
        bad(`a picked folder with no DICOM in it does not say so: ${JSON.stringify(none)}`);
      }
      if (!none.perform || !none.start) bad(`a verb is live over a folder with no images: ${JSON.stringify(none)}`);
      if (!none.why.trim()) bad('the dead verb carries no reason for a folder with no DICOM');
      if (none.cmd.includes('--adopt-worklist-identity')) {
        bad(`a folder nothing could be read from claims a re-stamp: ${none.cmd}`);
      }
      const nonePress = await pressPerform();
      if (nonePress.ran) bad(`pressing Perform over a folder with no DICOM started a run: ${JSON.stringify(nonePress)}`);

      // ---- 3. a folder whose study differs from the row, end to end.
      // DOE^JANE names a study no folder on this machine carries, so the
      // fixtures are a mismatch for it: the verdict, the re-stamp flag and a
      // real run that has to come back 0.
      const diffAt = await pressPicker('mpps-folder', fixtures, AT_PRESS);
      if (diffAt.lineHidden || !diffAt.reading || !diffAt.perform || !diffAt.start) {
        bad(`Browse… to the fixtures did not put the screen back into reading: ${JSON.stringify(diffAt)}`);
      }
      await waitFolder();
      const diff = await settled();
      await shot('wl-5e-picked-mismatch');
      record(`picked (different study): ${diff.line.trim()}`);
      if (diff.lineHidden || !/different study/.test(diff.line) || !/re-stamped copy/.test(diff.line)) {
        bad(`a picked folder of another study does not say what will happen: ${JSON.stringify(diff)}`);
      }
      if (diff.perform || diff.start) {
        bad(`the verbs stayed dead over a folder that was read: ${JSON.stringify(diff)}`);
      }
      if (!diff.cmd.includes('--adopt-worklist-identity')) {
        bad(`a picked mismatch did not reach the re-stamp flag: ${diff.cmd}`);
      }
      if (!cmdNames(diff.cmd, fixtures)) bad(`the command does not name the picked folder: ${diff.cmd}`);
      await js(`document.querySelector('#mpps-run').click(); true`);
      await mustWait("!document.querySelector('#mpps-status').className.includes('running')",
        RUN_MS, 'the picked perform to finish');
      const pickedRun = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mpps-status').textContent,
        cls: document.querySelector('#mpps-outcome').className,
        all: document.querySelector('#mpps-outcome').textContent.replace(/\\s+/g, ' ').trim(),
      })`);
      record(`picked (different study): performed — ${pickedRun.status}`);
      artefact('mpps-picked-outcome.txt', pickedRun.all);
      await shot('wl-5f-picked-performed');
      if (pickedRun.status !== 'COMPLETED' || !pickedRun.cls.includes('ok')) {
        bad(`a folder chosen with Browse… did not perform cleanly: ${JSON.stringify(pickedRun)}`);
      }
      // The exact failure this pass exists to close. It is worth naming.
      if (/Refused before anything ran|exited 2/.test(pickedRun.all)) {
        bad(`Browse… can still reach exit 2: ${pickedRun.all}`);
      }
      record('station: Browse… invalidates the verdict, blocks the verbs until the folder is read, and performs 0');

      // ---- 4. defence in depth: the change-only route.
      //
      // The picker no longer takes it, but the property that matters is that
      // the verbs are dead whenever the folder's study is unknown, whichever
      // event got us there — so it is asserted from the other side too. This
      // is the assertion that would have caught the original bug without
      // anyone having to think of the picker: set the value and dispatch
      // `change` alone, from a clean screen with live verbs, and the screen
      // must still refuse to act on a folder it has not read.
      const liveBefore = await jsJSON(`JSON.stringify({
        perform: document.querySelector('#mpps-run').disabled,
        start: document.querySelector('#mpps-start').disabled,
      })`);
      if (liveBefore.perform || liveBefore.start) {
        bad('the change-only check has to start from a screen whose verbs are live');
      }
      const changeOnly = await jsJSON(`(() => {
        const field = document.querySelector('#mpps-folder');
        field.value = ${JSON.stringify(pickTwo)};
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({
          value: field.value,
          lineHidden: document.querySelector('#mpps-folder-check').hidden,
          line: document.querySelector('#mpps-folder-check').textContent,
          perform: document.querySelector('#mpps-run').disabled,
          start: document.querySelector('#mpps-start').disabled,
          why: document.querySelector('#mpps-run').title || '',
          cmd: document.querySelector('#mpps-cmd').textContent,
        });
      })()`);
      if (changeOnly.value !== pickTwo) bad('the change-only route did not change the field');
      if (changeOnly.lineHidden || !changeOnly.line.trim()) {
        bad(`a change-only folder change left the verdict line hidden: ${JSON.stringify(changeOnly)}`);
      }
      if (!changeOnly.perform || !changeOnly.start) {
        bad(`a change-only folder change left a verb live over an unread folder: ${JSON.stringify(changeOnly)}`);
      }
      if (!changeOnly.why.trim()) bad('the change-only route left a dead verb with no reason on it');
      if (changeOnly.cmd.includes('--adopt-worklist-identity')) {
        bad(`the change-only route kept the last folder's re-stamp claim: ${changeOnly.cmd}`);
      }
      record(`station: a folder set with \`change\` alone is unknown too — "${changeOnly.line.trim()}", verbs dead`);
      // It is a real change, not just a blocked one: the rescan it scheduled
      // has to land on the folder that was set, with the same verdict pressing
      // Browse… gave.
      await waitFolder();
      const changeSettled = await settled();
      if (!/2 studies/.test(changeSettled.line) || !changeSettled.perform) {
        bad(`the change-only route did not re-read the folder it named: ${JSON.stringify(changeSettled)}`);
      }
      // A blur over a folder nobody retyped must NOT spawn another child: the
      // guard that lets `change` be safe here is the one that would otherwise
      // put a `dcm info` behind every tab-out of the field.
      const idleBlur = await jsJSON(`(() => {
        const before = mppsScanToken;
        const field = document.querySelector('#mpps-folder');
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ before, after: mppsScanToken, reading: !!(state.mpps.scan && state.mpps.scan.reading) });
      })()`);
      if (idleBlur.after !== idleBlur.before || idleBlur.reading) {
        bad(`blurring the folder field re-read a folder that had not changed: ${JSON.stringify(idleBlur)}`);
      }
      record('station: blurring the folder field over an unchanged path reads nothing again');

      await js(`(() => { clearSelection(); return true; })()`);

      // --- H3: start only, then add images and complete -------------------
      // This row names the study the fixtures carry, which is the only case in
      // which images may be added to an already-open step: `dcm send` copies
      // nothing, so there is no re-stamping on this path.
      await selectRowFor('LEE^MIN');
      await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
      await waitFolder();
      const startCmd = await js(`mppsStartArgv().join(' ')`);
      say(`start argv: dcm ${startCmd}`);
      if (!/^mpps start /.test(startCmd) || cmdNames(startCmd, fixtures)) {
        bad(`start must open a step and send nothing: ${startCmd}`);
      }
      await js(`document.querySelector('#mpps-start').click(); true`);
      await mustWait("!document.querySelector('#mpps-status').className.includes('running')",
        RUN_MS, 'the start to finish');
      const started = await jsJSON(`JSON.stringify({
        status: document.querySelector('#mpps-status').textContent,
        outcome: document.querySelector('#mpps-outcome').textContent,
        mode: panelMode(),
        openChip: document.querySelector('#mwl-open-chip').textContent,
        openHidden: document.querySelector('#mwl-open-chip').hidden,
        closeLabel: document.querySelector('#steps-close-run').textContent,
        closeCmd: document.querySelector('#steps-close-cmd').textContent,
        note: document.querySelector('#mpps-hero-note').textContent,
      })`);
      record(`start only: ${started.status}; the chip says "${started.openChip}"`);
      say(`close preview:\n${started.closeCmd}`);
      artefact('steps-close-cmd.txt', started.closeCmd);
      await shot('wl-7-in-progress');
      if (started.status !== 'IN PROGRESS') bad(`start did not leave the step open: ${started.status}`);
      if (started.mode !== 'close') bad('an open step did not put the panel into closing mode');
      if (started.openHidden || !/Open steps: 1/.test(started.openChip)) {
        bad(`the open-steps chip does not count the step: ${JSON.stringify(started)}`);
      }
      if (started.closeLabel !== 'Add images & complete') {
        bad(`a step opened with no images does not offer to add them: "${started.closeLabel}"`);
      }
      // Two commands, both on screen before either runs.
      const lines = started.closeCmd.split('\n');
      if (lines.length !== 2 || !/^dcm send /.test(lines[0]) || !/^dcm mpps complete /.test(lines[1])) {
        bad(`adding images is not shown as send-then-complete: ${started.closeCmd}`);
      }
      if (!lines[0].includes('--called-ae ARCHIVE')) bad(`the added images do not go to the archive: ${lines[0]}`);
      if (!lines[1].includes('--series-from')) bad(`the complete does not name the performed series: ${lines[1]}`);
      if (!lines[1].includes(`--port ${risPort}`) || !lines[1].includes('--called-ae RISMPPS')) {
        bad(`the close is aimed somewhere other than the peer that took the N-CREATE: ${lines[1]}`);
      }
      // In closing mode the line under the folder and the command under the
      // button have to agree about adoption, because on this path there is
      // none: neither claims a re-stamped copy.
      const closeLine = await js(`document.querySelector('#mpps-folder-check').textContent`);
      record(`station, closing: folder line — ${closeLine}`);
      if (/re-stamp/i.test(closeLine) !== /--adopt-worklist-identity/.test(started.closeCmd)) {
        bad(`the folder line and the close command disagree about adoption: "${closeLine}" / ${started.closeCmd}`);
      }
      if (!/matches this step/.test(closeLine)) {
        bad(`a folder that is this step's study does not say so: ${closeLine}`);
      }

      await js(`document.querySelector('#steps-close-run').click(); true`);
      await mustWait("!document.querySelector('#steps-status').className.includes('running')",
        RUN_MS, 'add-images-and-complete to finish');
      const completed = await jsJSON(`JSON.stringify({
        status: document.querySelector('#steps-status').textContent,
        outcome: document.querySelector('#mpps-outcome').textContent,
        cls: document.querySelector('#mpps-outcome').className,
        pill: (document.querySelector('#mwl-table tr.row-selected td.session-cell') || {}).textContent || '',
        openHidden: document.querySelector('#mwl-open-chip').hidden,
        mode: panelMode(),
      })`);
      record(`add images & complete: ${completed.status} — ${completed.outcome.replace(/\s+/g, ' ').trim()}`);
      await shot('wl-8-completed');
      if (completed.status !== 'COMPLETED') bad(`the step did not complete: ${completed.status}`);
      if (!completed.cls.includes('ok')) bad(`a completed close is not styled as a success: ${completed.cls}`);
      if (!/COMPLETED/.test(completed.pill)) bad(`the row pill did not follow the close: "${completed.pill}"`);
      if (!completed.openHidden) bad('the open-steps chip still counts a step that was closed');
      if (completed.mode !== 'perform') bad('a closed step still offers a way to close it again');

      // --- H4: start only, then discontinue -------------------------------
      await selectRowFor('PARK^SOO');
      // No images at all this time: an empty folder has nothing to scan, so
      // this waits out the debounce rather than for a verdict there will be none of.
      await js(`__smoke.set('mpps-folder', ''); true`);
      await wait(700);
      await js(`document.querySelector('#mpps-start').click(); true`);
      await mustWait("!document.querySelector('#mpps-status').className.includes('running')",
        RUN_MS, 'the second start to finish');
      if (await js(`document.querySelector('#mpps-status').textContent`) !== 'IN PROGRESS') {
        bad('the second start did not open a step');
      }
      // Images that are not this step's study cannot be added to it. `dcm send`
      // re-stamps nothing, so the archive would file them under their own
      // study while the RIS closed a step naming another — a pair of records
      // that never reconcile. The line says exactly that and the verb is dead.
      await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
      await waitFolder();
      const closeMismatch = await jsJSON(`JSON.stringify({
        mode: panelMode(),
        line: document.querySelector('#mpps-folder-check').textContent,
        cls: document.querySelector('#mpps-folder-check').className,
        complete: document.querySelector('#steps-close-run').disabled,
        why: document.querySelector('#steps-close-run').title,
        cmd: document.querySelector('#steps-close-cmd').textContent,
      })`);
      record(`closing, different study: ${closeMismatch.line}`);
      await shot('wl-9a-close-mismatch');
      if (closeMismatch.mode !== 'close') bad('the panel is not in closing mode for this check');
      if (/re-stamp|not modified/i.test(closeMismatch.line)) {
        bad(`the closing path promises a re-stamped copy it does not make: ${closeMismatch.line}`);
      }
      if (/--adopt-worklist-identity/.test(closeMismatch.cmd)) {
        bad(`the close command claims adoption: ${closeMismatch.cmd}`);
      }
      if (!/never reconcile/.test(closeMismatch.line) || !closeMismatch.cls.includes('bad')) {
        bad(`a different study is not said plainly on the closing path: ${JSON.stringify(closeMismatch)}`);
      }
      if (!closeMismatch.why) bad('the verb is dead and does not say why');
      if (!closeMismatch.complete) {
        bad('"Add images & complete" is live for images that are not this step\'s study');
      }
      await js(`__smoke.set('mpps-folder', ''); true`);
      await wait(700);
      say('closing: images carrying another study are refused, and the line says why');

      // Stopping an exam is a reason picked in words; the code item it stands
      // for is what goes on the command line, where it can still be read.
      const armed = await jsJSON(`(() => {
        document.querySelector('#steps-discontinue').click();
        const sel = document.querySelector('#steps-reason');
        const reasons = Array.from(sel.options).map((o) => o.textContent);
        sel.value = '110513^DCM^Discontinued for equipment failure';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const picked = document.querySelector('#steps-close-cmd').textContent;
        // The escape hatch for a site with a private scheme.
        sel.value = '__other';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const otherShown = !document.querySelector('#steps-reasoncode').hidden;
        __smoke.set('steps-reasoncode', '99^ACME^Local reason');
        const typed = document.querySelector('#steps-close-cmd').textContent;
        sel.value = '110513^DCM^Discontinued for equipment failure';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({
          rowHidden: document.querySelector('#steps-reason-row').hidden,
          reasons, otherShown, typed,
          freeHidden: document.querySelector('#steps-reasoncode').hidden,
          cmd: document.querySelector('#steps-close-cmd').textContent,
          picked,
          label: document.querySelector('#steps-discontinue-run').textContent,
        });
      })()`);
      say(`discontinue: ${armed.cmd}`);
      record(`discontinue: the reason is picked from ${armed.reasons.length} in words `
        + `— "${armed.reasons[1]}" put ${/--reason-code (".*?"|\S+)/.exec(armed.picked)?.[1] || '(nothing)'} on the command`);
      await shot('wl-9-discontinue-armed');
      if (armed.rowHidden) bad('Discontinue did not ask for a reason');
      if (armed.reasons[0] !== 'No reason given' || armed.reasons.length < 8) {
        bad(`the standard reasons are not offered: ${JSON.stringify(armed.reasons)}`);
      }
      for (const plain of ['Patient did not arrive', 'Equipment failure', 'Patient refused to continue']) {
        if (!armed.reasons.includes(plain)) bad(`"${plain}" is not one of the reasons offered`);
      }
      if (!armed.otherShown || !armed.typed.includes('--reason-code "99^ACME^Local reason"')) {
        bad(`a private code is no longer reachable: ${JSON.stringify(armed.typed)}`);
      }
      if (!armed.freeHidden) bad('the free-text code box is on screen when a standard reason is picked');
      if (!/^dcm mpps discontinue /.test(armed.cmd) || !armed.cmd.includes('--reason-code')) {
        bad(`the discontinue command is wrong: ${armed.cmd}`);
      }
      if (!armed.cmd.includes('--reason-code "110513^DCM^Discontinued for equipment failure"')) {
        bad(`the picked reason did not become its code item: ${armed.cmd}`);
      }
      await js(`document.querySelector('#steps-discontinue-run').click(); true`);
      await mustWait("!document.querySelector('#steps-status').className.includes('running')",
        RUN_MS, 'the discontinue to finish');
      const discontinued = await jsJSON(`JSON.stringify({
        status: document.querySelector('#steps-status').textContent,
        cls: document.querySelector('#mpps-outcome').className,
        outcome: document.querySelector('#mpps-outcome').textContent,
        pill: (document.querySelector('#mwl-table tr.row-selected td.session-cell') || {}).textContent || '',
        open: document.querySelector('#mwl-open-chip').hidden,
      })`);
      record(`discontinue: ${discontinued.status} — ${discontinued.outcome.replace(/\s+/g, ' ').trim()}`);
      await shot('wl-10-discontinued');
      if (discontinued.status !== 'DISCONTINUED') bad(`the step was not discontinued: ${discontinued.status}`);
      // DISCONTINUED is a failure, and is never rounded up.
      if (!discontinued.cls.includes('bad')) bad(`DISCONTINUED is not styled as a failure: ${discontinued.cls}`);
      if (!/DISCONTINUED/.test(discontinued.pill)) bad(`the row pill does not carry it: "${discontinued.pill}"`);
      if (!discontinued.open) bad('a discontinued step is still counted as open');

      // Nothing on this screen may name a file the app wrote: there is no
      // records directory, and the session list lives in this window only.
      const words = await js(`document.querySelector('#view-worklist').textContent`);
      for (const banned of ['--record-dir', '--write-acknowledged', 'Record folder', 'Record file']) {
        if (words.includes(banned)) bad(`the station still mentions ${banned}`);
      }
      // The pill is about this app, never about the RIS.
      const pills = await jsJSON(`JSON.stringify(Array.from(document.querySelectorAll('#mwl-table .pill.session')).map(
        (p) => ({ text: p.textContent, title: p.title })))`);
      say(`row pills: ${JSON.stringify(pills)}`);
      for (const p of pills) {
        if (!/this app sent/i.test(p.title)) bad(`a pill does not say whose claim it is: ${JSON.stringify(p)}`);
      }
      if (pills.length !== 4) bad(`expected a pill on all four rows, got ${pills.length}`);

      // A completed step leaves the SCP's worklist, and the row it was on
      // stays selectable from what this window remembers.
      await js(`document.querySelector('#mwl-run').click(); true`);
      await mustWait("!document.querySelector('#mwl-status').className.includes('running')",
        RUN_MS, 'the second worklist query to answer');
      const after = await jsJSON(`JSON.stringify({
        matches: state.mwl.matches.length,
        rows: document.querySelectorAll('#mwl-table tr.pick-row').length,
        selected: !!state.mwl.selected,
      })`);
      record(`worklist re-queried: the SCP now returns ${after.matches} of ${rows.length} rows `
        + `(a completed step leaves the worklist); ${after.rows} on screen`);
      await shot('wl-11-requeried');

      // -----------------------------------------------------------------
      // The three reports a live run against a cooperative receiver cannot
      // produce, pushed through the renderer's own parser and its own
      // rememberStep, exactly as a run would.
      //
      // The shortfall is the one that matters most: DISCONTINUED has to read
      // as a failure, with its counts, and must never be rounded up. The
      // N-SET failure is the case that proves the parser reads both streams —
      // the sentence saying the step is still open is on stderr, and there is
      // no "step status" line on stdout at all. The N-CREATE failure opened no
      // step, so it must leave no trace anywhere.
      // -----------------------------------------------------------------
      const openStdout = [
        '', 'MPPS SOP Instance UID  2.25.31415926535897932384626433832795028841',
        'study                  2.25.7409558135166679574647759021724211267', '',
        '  found                36', '  sent                 36',
        '  acknowledged         36', '  referenced in MPPS   36', '',
      ].join('\n');
      const shortfall = [
        '', 'MPPS SOP Instance UID  2.25.16180339887498948482045868343656381177',
        'study                  2.25.7409558135166679574647759021724211267', '',
        '  found                214', '  sent                 214',
        '  acknowledged         211', '  referenced in MPPS   211', '',
        'step status            DISCONTINUED', '',
        '211 of 214 instances were acknowledged. 3 are unaccounted for.', '',
      ].join('\n');

      const reports = await jsJSON(`(() => {
        const keep = state.steps.entries.slice();
        const peer = { host: 'ris.example.org', port: '11112', calledAe: 'MPPSSCP', callingAe: 'CT01' };
        const store = { host: 'pacs.example.org', port: '104', calledAe: 'ARCHIVE' };
        const attrs = { patientName: 'DOE^JANE', patientId: 'P-1001', modality: 'CT',
          scheduledStepId: 'SPS-1', studyInstanceUid: '2.25.7409558135166679574647759021724211267' };

        // 1. N-SET failed: the verdict is only on stderr.
        const openReport = parseMppsReport(${JSON.stringify(openStdout)},
          'N-SET failed — the step is still IN PROGRESS on MPPSSCP\\n');
        const openRemembered = rememberStep({ report: openReport, attrs,
          uid: 'unused-the-report-names-its-own', folder: '/studies/open', peer, store });
        const openEntry = state.steps.entries[0];

        // 2. N-CREATE failed: no step was opened, so nothing may be remembered.
        const neverReport = parseMppsReport('',
          'N-CREATE failed — the procedure step was never opened, so nothing was sent\\n');
        const neverRemembered = rememberStep({ report: neverReport,
          attrs: { patientName: 'NOBODY' }, uid: '2.25.999', folder: '/studies/never', peer, store });

        // 3. A shortfall, rendered into the panel the way a run leaves it.
        const shortReport = parseMppsReport(${JSON.stringify(shortfall)});
        renderMppsTotals(shortReport);
        renderMppsOutcome({ code: 1, report: shortReport, dryRun: false, verb: 'perform' });
        const short = {
          cls: document.querySelector('#mpps-outcome').className,
          head: document.querySelector('#mpps-outcome .outcome-head').textContent,
          body: document.querySelector('#mpps-outcome').textContent,
          status: document.querySelector('#mpps-status').textContent,
          cards: Array.from(document.querySelectorAll('#mpps-totals .total-card')).map(
            (c) => c.className.replace('total-card', '').trim() + ':' + c.querySelector('.num').textContent),
        };
        const out = {
          openReport, openRemembered, openEntryStatus: openEntry && openEntry.status,
          openEntryPeer: openEntry && openEntry.peer.calledAe,
          neverReport, neverRemembered, short,
        };
        // Put the window back the way the live flow left it.
        state.steps.entries = keep;
        document.querySelector('#mpps-outcome').hidden = true;
        document.querySelector('#mpps-totals').hidden = true;
        setStatus('mpps', null);
        refreshRowPills();
        renderMppsPanel();
        return JSON.stringify(out);
      })()`);
      await shot('wl-12-shortfall');
      say(`report: N-SET failure parsed as ${JSON.stringify(reports.openReport)}`);
      say(`report: shortfall outcome ${JSON.stringify(reports.short)}`);
      if (!reports.openReport.stillInProgress || reports.openReport.acknowledged !== 36) {
        bad(`the parser did not read both streams: ${JSON.stringify(reports.openReport)}`);
      }
      if (reports.openRemembered !== true || reports.openEntryStatus !== 'IN PROGRESS') {
        bad(`a step left open was not remembered as open: ${JSON.stringify(reports)}`);
      }
      // The step lives on the system that took the N-CREATE, not on whatever
      // the chip says now.
      if (reports.openEntryPeer !== 'MPPSSCP') {
        bad(`the remembered step did not keep its own peer: ${reports.openEntryPeer}`);
      }
      if (!reports.neverReport.neverOpened || reports.neverRemembered !== false) {
        bad('a run that never opened a step was remembered anyway');
      }
      const s = reports.short;
      if (!s.cls.includes('bad')) bad(`a shortfall is not styled as a failure: ${s.cls}`);
      if (!/failure/i.test(s.head)) bad(`a shortfall does not read as a failure: ${s.head}`);
      if (!s.body.includes('211 of 214')) bad(`the shortfall counts are not shown: ${s.body}`);
      if (!/no override/i.test(s.body)) bad(`the shortfall does not say there is no override: ${s.body}`);
      if (s.status !== 'DISCONTINUED') bad(`the status chip rounds a shortfall up: ${s.status}`);
      if (!s.cards.some((c) => c.startsWith('fail:211'))) {
        bad(`acknowledged is not marked as a shortfall: ${JSON.stringify(s.cards)}`);
      }
      record('reports: an N-SET failure is read off stderr and stays open, an N-CREATE failure is '
        + 'remembered nowhere, and a shortfall reads as DISCONTINUED with its counts');
    }

    // =====================================================================
    // I. A live speed sweep, against the archive this harness started.
    //
    // The preset sweep rather than the transfer-syntax one, because the preset
    // sweep is the case the table used to get wrong: a fixture folder cannot
    // fill four, eight or sixteen associations, so every preset above normal
    // comes back narrower than it asked for, and the table used to print the
    // number it asked for beside a real MB/s and stamp FASTEST on the winner of
    // the noise between runs that were byte-identical.
    // =====================================================================
    if (fixtures) {
      await js(`(() => {
        showView('speed');
        __smoke.set('speed-folder', ${JSON.stringify(fixtures)});
        document.querySelector('#speed-mode .chip[data-mode="parallel"]').click();
        document.querySelector('#view-speed [data-run]').click();
        return true;
      })()`);
      await mustWait("!document.querySelector('#view-speed [data-status]').className.includes('running')",
        RUN_MS * 4, 'the four-preset sweep to finish');
      // The per-study warning is the last thing each run writes, and the
      // console writes on a frame, so wait for it rather than for the sweep.
      await mustWait('/association\\(s\\)/.test(__smoke.consoleText("speed"))',
        15000, "the sweep's warnings to be written");
      await shot('speed-result');
      await js(`document.querySelector('#view-speed [data-result]').scrollIntoView({ block: 'start' }); true`);
      await wait(300);
      await shot('speed-comparison');
      const t = await jsJSON(`(() => {
        const rows = Array.from(document.querySelectorAll('#view-speed [data-result] tbody tr'));
        return JSON.stringify({
          headers: Array.from(document.querySelectorAll('#view-speed [data-result] thead th')).map((e) => e.textContent),
          rows: rows.map((tr) => Array.from(tr.children).map((td) => td.textContent.trim())),
          badges: rows.map((tr) => (tr.querySelector('.badge-best') || {}).textContent || ''),
          notes: Array.from(document.querySelectorAll('#view-speed [data-result] .local-note')).map((e) => e.textContent),
          console: __smoke.consoleText('speed'),
          progress: Array.from(document.querySelectorAll('#speed-progress .run-line')).map((e) => e.textContent),
          status: document.querySelector('#view-speed [data-status]').textContent,
        });
      })()`);
      artefact('speed-table.json', JSON.stringify(t, null, 2));
      record(`live sweep: ${t.status}, ${t.rows.length} rows`);
      t.rows.forEach((r) => say(`speed row: ${JSON.stringify(r)}`));
      t.notes.forEach((n) => say(`speed note: ${n}`));

      // The measured width has to be a column of its own, beside the rate it
      // qualifies. Reading it off the run's own title is what went wrong.
      if (!t.headers.includes('Width')) {
        bad(`the comparison table has no achieved-width column: ${JSON.stringify(t.headers)}`);
      }
      const widths = t.rows.map((r) => r[1]);
      if (!widths.some((w) => /\d+ of \d+/.test(w))) {
        bad('no row reports falling short of the width it asked for, over a folder too small to fill '
          + `sixteen associations: ${JSON.stringify(widths)}`);
      }
      // The engine's per-study warning is on stderr and --json does not silence
      // it. It used to be discarded on every run whose stdout parsed — that is,
      // on exactly the runs whose numbers reach the table.
      if (!/association\(s\)/.test(t.console) || !/wide|accepted at once/.test(t.console)) {
        bad(`the engine's shortfall warning did not reach the app: ${t.console.slice(0, 400)}`);
      }
      // Fixture studies resolve every preset to the same transfer, so there is
      // no winner to declare and the table must not declare one.
      const badged = t.badges.filter(Boolean);
      if (badged.length > 1 && !badged.every((b) => /TIED/.test(b))) {
        bad(`more than one row is badged and not as a tie: ${JSON.stringify(badged)}`);
      }
      if (!t.notes.length) bad('a table with a short row carries no caveat under it');
      // The transient list has to agree with the table it sits above.
      if (!t.progress.some((p) => /of \d+ wide/.test(p))) {
        bad(`the progress lines report rates with no width: ${JSON.stringify(t.progress)}`);
      }
    }

    // =====================================================================
    // J. A live tag load and edit preview.
    // =====================================================================
    if (fixtures) {
      await js(`(() => {
        showView('edit');
        __smoke.set('edit-target', ${JSON.stringify(fixtures)});
        document.querySelector('#edit-load').click();
        return true;
      })()`);
      // Loading the tags is a child process too; wait for the grid, not a guess.
      await mustWait("document.querySelectorAll('#edit-grid .tag-row[data-kw]').length > 0",
        40000, 'the tag editor to load');
      const edit = await jsJSON(`(() => {
        __smoke.set('edit-target', ${JSON.stringify(fixtures)});
        const row = document.querySelector('.tag-row[data-kw="PatientID"] .tag-val');
        row.value = 'TEST-999';
        row.dispatchEvent(new Event('input', {bubbles:true}));
        return JSON.stringify({
          tags: document.querySelectorAll('#edit-grid .tag-row[data-kw]').length,
          cmd: document.querySelector('#view-edit [data-cmd]').textContent,
          loadIsGhost: document.querySelector('#edit-load').classList.contains('ghost'),
          primaries: Array.from(document.querySelectorAll('#view-edit .btn.primary'))
            .filter(__smoke.vis).map((b) => b.textContent.trim()),
        });
      })()`);
      await wait(300);
      await shot('edit-loaded');
      record(`edit: ${edit.tags} tags loaded — ${edit.cmd}`);
      if (!edit.cmd.includes('PatientID=TEST-999')) bad(`the edit did not reach the command: ${edit.cmd}`);
      // One primary button per screen: Load tags is a ghost now.
      if (!edit.loadIsGhost || edit.primaries.length !== 1) {
        bad(`the Edit tab has ${edit.primaries.length} primary buttons: ${JSON.stringify(edit.primaries)}`);
      }
    }

    // Ctrl+Enter reaches the open tab's primary, not the first one in the
    // section's markup — a tabbed screen holds four.
    const chord = await jsJSON(`(() => {
      showView('tools');
      showTab('tools', 'tags');
      const active = document.querySelector('.view.active');
      const run = Array.from(active.querySelectorAll('[data-run]:not([disabled])')).find((b) => b.offsetParent !== null);
      return JSON.stringify({ label: run ? run.textContent.trim() : '', pane: run ? run.closest('.tab-pane').id : '' });
    })()`);
    say(`Ctrl+Enter on Tools/Tags would press "${chord.label}" in ${chord.pane}`);
    if (chord.pane !== 'view-tags') bad(`Ctrl+Enter would leave the open tab: ${JSON.stringify(chord)}`);

    // =====================================================================
    // K. The Rename tab: what it refuses, what it composes, what it writes.
    // =====================================================================
    if (fixtures) {
      // This pane is taller than the harness window, so the amber note and the
      // engine report sit below the fold. Scroll before the frame, or the
      // screenshot is of a screen nobody would be looking at.
      const paneScroll = async (to) => {
        await js(`document.querySelector('.content').scrollTop = ${to}; true`);
        await wait(300);
      };

      // ---- The refusal. Two studies under one folder cannot have one of them
      // renamed, because `dcm edit` has no per-study scope. The second study is
      // made with `dcm anon`, which remaps UIDs consistently, so the folder
      // really does hold two distinct Study Instance UIDs rather than the same
      // one twice.
      const multi = path.join(work, 'multi');
      fs.mkdirSync(multi, { recursive: true });
      fs.cpSync(fixtures, path.join(multi, 'study-a'), { recursive: true });
      const made = await runEngine(['anon', fixtures, '--out', path.join(multi, 'study-b')]);
      if (made.code !== 0) bad(`could not build a two-study folder: ${made.err.slice(-400)}`);

      await js(`showView('tools'); showTab('tools', 'rename'); true`);
      await js(`__smoke.set('rename-folder', ${JSON.stringify(multi)}); true`);
      await mustWait("!document.querySelector('#rename-found').hidden",
        RUN_MS, 'the two-study folder to be scanned');
      const refusal = await jsJSON(`JSON.stringify({
        text: document.querySelector('#rename-found').textContent.replace(/\\s+/g, ' ').trim(),
        caution: !!document.querySelector('#rename-found .caution'),
        cards: document.querySelectorAll('#rename-found .study-card').length,
        uids: Array.from(document.querySelectorAll('#rename-found .study-card .uid')).map((e) => e.textContent.trim()),
        formShown: !document.querySelector('#rename-form').hidden,
        btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
        disabled: document.querySelector('#view-rename [data-run]').disabled,
        status: document.querySelector('#view-rename [data-status]').textContent,
      })`);
      await shot('rename-refused-multi-study');
      record(`rename: two studies -> "${refusal.text.slice(0, 160)}…"`);
      if (!refusal.caution || refusal.cards !== 2) {
        bad(`the two-study folder was not refused with both studies named: ${JSON.stringify(refusal)}`);
      }
      if (refusal.uids.length !== 2 || refusal.uids[0] === refusal.uids[1]) {
        bad(`the harness did not actually build two studies: ${JSON.stringify(refusal.uids)}`);
      }
      if (refusal.formShown || !refusal.disabled) {
        bad(`the rename form was offered for a folder holding two studies: ${JSON.stringify(refusal)}`);
      }
      if (!/merge, not a rename/.test(refusal.text)) {
        bad(`the refusal does not say why renaming two studies at once is a merge: ${refusal.text}`);
      }

      // ---- One study: what is there, and an inert button until something differs.
      await js(`__smoke.set('rename-folder', ${JSON.stringify(fixtures)}); true`);
      await mustWait('renameState.study !== null', RUN_MS, 'the single-study folder to be scanned');
      const loaded = await jsJSON(`JSON.stringify({
        found: document.querySelector('#rename-found').textContent.replace(/\\s+/g, ' ').trim(),
        cards: document.querySelectorAll('#rename-found .study-card').length,
        family: document.querySelector('#rename-family').value,
        given: document.querySelector('#rename-given').value,
        pid: document.querySelector('#rename-patientid').value,
        desc: document.querySelector('#rename-desc').value,
        acc: document.querySelector('#rename-accession').value,
        pn: document.querySelector('#rename-pn').textContent.replace(/\\s+/g, ' ').trim(),
        btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
        disabled: document.querySelector('#view-rename [data-run]').disabled,
        diffShown: !document.querySelector('#rename-diff').hidden,
        uid: renameState.study.studyInstanceUid,
        argv: BUILDERS.rename(),
        cmd: document.querySelector('#view-rename [data-cmd]').textContent,
      })`);
      await shot('rename-loaded');
      record(`rename: loaded ${loaded.pn} / ${loaded.pid} — ${loaded.found.slice(0, 130)}`);
      record(`rename: unchanged form — button reads "${loaded.btn}", disabled=${loaded.disabled}`);
      if (loaded.cards !== 1) bad(`one study did not draw one card: ${loaded.cards}`);
      if (!loaded.family) {
        bad('the patient name did not reach the form — is the vendored engine stale '
          + `(no patientName in dcm info --json)?: ${JSON.stringify(loaded)}`);
      }
      if (!loaded.pid || !loaded.desc || !loaded.acc) {
        bad(`the form was not prefilled from the study: ${JSON.stringify(loaded)}`);
      }
      // An unchanged form is inert and says so, and builds a command with no
      // --set in it at all: an untouched field is not rewritten to itself.
      if (!loaded.disabled || loaded.btn !== 'Nothing changed yet') {
        bad(`an unchanged form left the button live: ${JSON.stringify(loaded)}`);
      }
      if (loaded.diffShown) bad('an unchanged form showed a change list');
      if (loaded.argv.includes('--set')) bad(`an unchanged form still set something: ${loaded.argv.join(' ')}`);
      await measureScreen('rename-loaded', '#view-rename');

      // ---- The composition. Family and Given are separate boxes; what they
      // compose to is on screen, and it is what reaches the command.
      const outDir = path.join(work, 'renamed');
      const typed = await jsJSON(`(() => {
        __smoke.set('rename-family', 'DOE');
        __smoke.set('rename-given', 'JANE');
        __smoke.set('rename-patientid', 'P-RENAMED');
        __smoke.set('rename-out', ${JSON.stringify(outDir)});
        return JSON.stringify({
          pn: document.querySelector('#rename-pn').textContent.replace(/\\s+/g, ' ').trim(),
          diff: document.querySelector('#rename-diff').textContent.replace(/\\s+/g, ' ').trim(),
          diffRows: document.querySelectorAll('#rename-diff .rn-diff-row').length,
          btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
          disabled: document.querySelector('#view-rename [data-run]').disabled,
          argv: BUILDERS.rename(),
          cmd: document.querySelector('#view-rename [data-cmd]').textContent,
        });
      })()`);
      await wait(350);
      await shot('rename-composed');
      record(`rename: composes to ${typed.pn}`);
      record(`rename: change list — ${typed.diff}`);
      record(`rename: ${typed.cmd}`);
      artefact('rename-cmd.txt', `${typed.cmd}\n\nargv: ${JSON.stringify(typed.argv)}\n`);
      if (!typed.pn.includes('DOE^JANE')) bad(`Family + Given did not compose to DOE^JANE: ${typed.pn}`);
      if (!typed.argv.includes('PatientName=DOE^JANE')) {
        bad(`the composed name did not reach the argv: ${JSON.stringify(typed.argv)}`);
      }
      // Quoted in the preview because the preview is copyable and cmd.exe eats
      // an unquoted caret.
      if (!typed.cmd.includes('--set "PatientName=DOE^JANE"')) {
        bad(`the command does not carry the composed name quoted: ${typed.cmd}`);
      }
      // Only what differs: two fields were touched, and the untouched
      // description and accession produce nothing.
      if (typed.diffRows !== 2) bad(`the change list is not just the changed fields: ${typed.diff}`);
      if (typed.argv.filter((a) => a === '--set').length !== 2) {
        bad(`an untouched field was rewritten to itself: ${JSON.stringify(typed.argv)}`);
      }
      if (typed.disabled || typed.btn !== 'Rename study') {
        bad(`a real change left the button inert: ${JSON.stringify(typed)}`);
      }
      // UIDs are what tie a study together. Nothing on this screen may reach
      // for --force, and nothing on it may set a UID.
      if (typed.argv.includes('--force')) bad(`Rename passed --force: ${JSON.stringify(typed.argv)}`);
      if (typed.argv.some((a) => /UID=/i.test(a))) bad(`Rename set a UID: ${JSON.stringify(typed.argv)}`);

      // ---- In place: armed, and not fired. The default is a copy; choosing to
      // overwrite the originals is a separate press that changes the command
      // and puts the amber note on screen.
      const armed = await jsJSON(`(() => {
        document.querySelector('#rename-dest-row .chip[data-dest="inplace"]').click();
        return JSON.stringify({
          outRowHidden: document.querySelector('#rename-out-row').hidden,
          note: document.querySelector('#rename-inplace-note').hidden
            ? '' : document.querySelector('#rename-inplace-note').textContent.replace(/\\s+/g, ' ').trim(),
          argv: BUILDERS.rename(),
          cmd: document.querySelector('#view-rename [data-cmd]').textContent,
        });
      })()`);
      await paneScroll(9999);
      await shot('rename-in-place-armed');
      await paneScroll(0);
      record(`rename: in place — ${armed.cmd}`);
      record(`rename: in place note — ${armed.note}`);
      if (!armed.argv.includes('--in-place') || armed.argv.includes('--out')) {
        bad(`choosing in place did not change the destination: ${JSON.stringify(armed.argv)}`);
      }
      if (!armed.note || !/no undo/i.test(armed.note) || !armed.outRowHidden) {
        bad(`in place was armed without the amber warning: ${JSON.stringify(armed)}`);
      }
      if (armed.argv.includes('--force')) bad(`in place reached for --force: ${JSON.stringify(armed.argv)}`);
      await js(`document.querySelector('#rename-dest-row .chip[data-dest="copy"]').click(); true`);
      const backToCopy = await jsJSON('JSON.stringify(BUILDERS.rename())');
      if (backToCopy.includes('--in-place') || !backToCopy.includes('--out')) {
        bad(`switching back to a copy did not disarm in place: ${JSON.stringify(backToCopy)}`);
      }
      say('rename: in place was armed, inspected and disarmed without being pressed');

      // ---- The copy, for real. Then point the tab at what it produced: the
      // proof a rename worked is that the renamed folder reads back renamed.
      await js(`document.querySelector('#view-rename [data-run]').click(); true`);
      await mustWait("!document.querySelector('#view-rename [data-status]').className.includes('running')",
        RUN_MS, 'the rename to finish');
      // The status chip settles on the child's exit; the console paints on a
      // frame. Reading it the instant the chip changes catches the run with
      // its last chunk still buffered, which is a race in this harness rather
      // than in the app — wait for the report's closing line instead.
      await mustWait("/instance\\(s\\) written/.test(__smoke.consoleText('rename'))",
        20000, "the engine's report to finish painting");
      const ran = await jsJSON(`JSON.stringify({
        status: document.querySelector('#view-rename [data-status]').textContent,
        cmd: document.querySelector('#view-rename [data-cmd]').textContent,
        console: __smoke.consoleText('rename').slice(-1500),
      })`);
      await paneScroll(9999);
      await shot('rename-written');
      await paneScroll(0);
      record(`rename: ${ran.status} — ${ran.cmd}`);
      artefact('rename-output.txt', ran.console);
      if (ran.status !== 'Done') bad(`the rename did not finish cleanly: ${ran.status}`);
      // The engine's own report is what appears, unrewritten: its per-tag
      // count is the accounting, and reimplementing it here would be a second
      // answer to the same question, free to disagree with the first.
      if (!/set PatientName\s+\d+ instance\(s\)/.test(ran.console)
        || !/instances found\s+\d+/.test(ran.console)) {
        bad(`the engine's own report did not reach the Output pane: ${ran.console.slice(-400)}`);
      }
      if (!fs.existsSync(outDir)) bad(`the rename wrote no copy to ${outDir}`);

      await js(`__smoke.set('rename-folder', ${JSON.stringify(outDir)}); true`);
      await mustWait(`renameState.study !== null && renameState.path === ${JSON.stringify(outDir)}`,
        RUN_MS, 'the renamed copy to be read back');
      const readBack = await jsJSON(`JSON.stringify({
        name: renameState.study.patientName,
        pid: renameState.study.patientId,
        desc: renameState.study.studyDescription,
        uid: renameState.study.studyInstanceUid,
        family: document.querySelector('#rename-family').value,
        given: document.querySelector('#rename-given').value,
        btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
      })`);
      await wait(350);
      await shot('rename-read-back');
      record(`rename: the copy reads back as ${readBack.name} / ${readBack.pid}, study UID ${readBack.uid}`);
      if (readBack.name !== 'DOE^JANE' || readBack.pid !== 'P-RENAMED') {
        bad(`the copy did not come back renamed: ${JSON.stringify(readBack)}`);
      }
      if (readBack.desc !== loaded.desc) {
        bad(`a field nobody touched changed anyway: ${JSON.stringify(readBack)} vs ${loaded.desc}`);
      }
      // The whole promise of this screen: the study is called something else
      // and is still the same study. Anchored to the UID read off the source
      // before the rename, not to a card's position in the refusal panel —
      // `dcm info` orders studies however it found them.
      if (readBack.uid !== loaded.uid) {
        bad(`the rename changed the Study Instance UID: ${readBack.uid} was ${loaded.uid}`);
      }
      if (readBack.btn !== 'Nothing changed yet') {
        bad(`the renamed copy did not read back as already-correct: ${readBack.btn}`);
      }
      if (readBack.family !== 'DOE' || readBack.given !== 'JANE') {
        bad(`the renamed copy did not split back into Family/Given: ${JSON.stringify(readBack)}`);
      }
      // ---- All four identity fields disagreeing under one Study Instance UID.
      //
      // The bug this replaces: the scan reported whichever instance the walk
      // reached first as the study's patient ID, description and accession,
      // and the card printed it as fact. `dcm info` now withholds all four the
      // way it always withheld the name, so there is no current value to
      // prefill from and the boxes stay empty. This builds the worst case —
      // every field in disagreement at once — because a screen that handled
      // one conflicting field by special-casing it would pass a one-field test.
      const conflicted = path.join(work, 'conflict');
      fs.cpSync(fixtures, conflicted, { recursive: true });
      const OTHER = {
        PatientName: 'OTHER^PATIENT',
        PatientID: 'WRONG-ID',
        StudyDescription: 'A DIFFERENT STUDY',
        AccessionNumber: 'ACC-OTHER',
      };
      const splitArgv = ['edit', path.join(conflicted, 'series-2')];
      for (const [k, v] of Object.entries(OTHER)) splitArgv.push('--set', `${k}=${v}`);
      splitArgv.push('--in-place');
      const split = await runEngine(splitArgv);
      if (split.code !== 0) bad(`could not build a four-way conflicted study: ${split.err.slice(-400)}`);

      await js(`__smoke.set('rename-folder', ${JSON.stringify(conflicted)}); true`);
      await mustWait('renameState.study !== null', RUN_MS, 'the conflicted study to be scanned');
      const clash = await jsJSON(`JSON.stringify({
        conflicts: renameState.conflicts,
        singulars: {
          PatientName: renameState.study.patientName,
          PatientID: renameState.study.patientId,
          StudyDescription: renameState.study.studyDescription,
          AccessionNumber: renameState.study.accessionNumber,
        },
        panels: document.querySelectorAll('#rename-found .caution').length,
        panelText: (document.querySelector('#rename-found .caution') || {}).textContent || '',
        rows: document.querySelectorAll('#rename-found .rn-cf-row').length,
        picks: Array.from(document.querySelectorAll('#rename-found .rn-pick'))
          .map((b) => b.dataset.adopt + '=' + b.dataset.value),
        chosen: document.querySelectorAll('#rename-found .rn-pick.chosen').length,
        cardHtml: document.querySelector('#rename-found .study-card').innerHTML,
        collisions: Array.from(document.querySelectorAll('#rename-found .study-card .collision'))
          .map((e) => e.textContent.trim()),
        family: document.querySelector('#rename-family').value,
        given: document.querySelector('#rename-given').value,
        pid: document.querySelector('#rename-patientid').value,
        desc: document.querySelector('#rename-desc').value,
        acc: document.querySelector('#rename-accession').value,
        btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
        disabled: document.querySelector('#view-rename [data-run]').disabled,
        status: document.querySelector('#view-rename [data-status]').textContent,
        argv: BUILDERS.rename(),
      })`);
      await wait(300);
      await shot('rename-conflict-four-fields');
      record(`rename: conflicts — ${Object.entries(clash.conflicts)
        .map(([k, v]) => `${k}: ${v.join(' / ')}`).join('; ')}`);
      record(`rename: status chip reads "${clash.status}", panel — ${clash.panelText.replace(/\s+/g, ' ').trim()}`);
      artefact('rename-conflict-card.html', `${clash.cardHtml}\n`);

      // Every field disagrees, and the screen knows it about every one of them.
      for (const k of Object.keys(OTHER)) {
        if (!clash.conflicts[k] || clash.conflicts[k].length !== 2) {
          bad(`${k} did not read as a conflict — is the vendored engine stale `
            + `(no ${k} plural in dcm info --json)?: ${JSON.stringify(clash.conflicts)}`);
        }
        if (clash.singulars[k] !== null) {
          bad(`dcm info reported a single ${k} for a study that disagrees: ${JSON.stringify(clash.singulars)}`);
        }
      }
      // The card is the thing that used to lie. Every disagreeing field is
      // drawn as its disagreement, and neither value appears anywhere on the
      // card standing on its own as the study's.
      if (clash.collisions.length !== 4 || clash.collisions.some((t) => !t.includes(' / '))) {
        bad(`the card did not show all four disagreements: ${JSON.stringify(clash.collisions)}`);
      }
      const outsideCollisions = clash.cardHtml.split(/<b class="collision">[\s\S]*?<\/b>/).join('');
      for (const [k, other] of Object.entries(OTHER)) {
        if (!clash.collisions.some((t) => t.includes(other))) {
          bad(`the card dropped one side of the ${k} disagreement: ${JSON.stringify(clash.collisions)}`);
        }
        // A value drawn outside a .collision would be the card asserting it.
        if (outsideCollisions.includes(other)) {
          bad(`the card presented ${k}=${other} as the study's value: ${outsideCollisions}`);
        }
      }
      // One panel, four rows, both values of each as a button, nothing chosen.
      if (clash.panels !== 1 || clash.rows !== 4 || clash.picks.length !== 8 || clash.chosen !== 0) {
        bad(`the conflict panel is not one panel of four unchosen rows: ${JSON.stringify(
          { panels: clash.panels, rows: clash.rows, picks: clash.picks, chosen: clash.chosen })}`);
      }
      if (!/disagree/i.test(clash.panelText) || !/every instance/i.test(clash.panelText)) {
        bad(`the panel does not say what is wrong or what fixes it: ${clash.panelText}`);
      }
      if (!/disagree/i.test(clash.status)) {
        bad(`a conflicted study still chipped as plain "Loaded": ${clash.status}`);
      }
      if (clash.family || clash.given || clash.pid || clash.desc || clash.acc) {
        bad(`a conflicting value was prefilled from one of the two: ${JSON.stringify(clash)}`);
      }
      // Empty boxes over a conflict mean "leave it alone", not "blank all four
      // fields on every instance" — so nothing is set until something is chosen.
      if (clash.argv.includes('--set') || !clash.disabled || clash.btn !== 'Nothing changed yet') {
        bad(`an untouched conflict proposed a change: ${JSON.stringify(clash)}`);
      }

      // ---- The Inventory tab reads the same JSON and heads its card with the
      // same two fields. It is not the screen the defect was reported against,
      // but a card that falls back to "Study" with no ID beside it for a study
      // that carries two of each is filing a disagreement as an absence — the
      // engine change made that reachable, so it is checked here while there is
      // a study on disk that provokes it.
      await js(`(() => {
        showView('tools');
        showTab('tools', 'inventory');
        __smoke.set('info-folder', ${JSON.stringify(conflicted)});
        document.querySelector('#view-inventory [data-run]').click();
        return true;
      })()`);
      await mustWait("!document.querySelector('#view-inventory [data-status]').className.includes('running')",
        RUN_MS, 'the inventory of the conflicted study to finish');
      const invClash = await jsJSON(`JSON.stringify({
        head: document.querySelector('#view-inventory [data-result] .study-card h3').textContent
          .replace(/\\s+/g, ' ').trim(),
        collisions: document.querySelectorAll('#view-inventory [data-result] .study-card .collision').length,
      })`);
      await shot('inventory-conflict');
      record(`inventory: the conflicted study heads its card "${invClash.head}"`);
      if (invClash.collisions !== 2 || !invClash.head.includes('WRONG-ID')
        || !invClash.head.includes('A DIFFERENT STUDY')) {
        bad(`the inventory card filed a disagreement as an absence: ${JSON.stringify(invClash)}`);
      }
      await js(`showTab('tools', 'rename'); true`);

      // ---- The repair. One click per field takes the value the fixtures
      // started with; the command that comes out writes each of them to every
      // instance under the folder, which is what makes the study one study
      // again. In place, because a repaired copy leaves the broken original
      // exactly as broken as it was.
      const KEEP = {
        PatientName: 'SYNTHETIC^PATIENT1',
        PatientID: 'SYNTH0001',
        StudyDescription: 'SYNTHETIC STUDY 1',
        AccessionNumber: 'ACC0000001',
      };
      const repair = await jsJSON(`(() => {
        for (const [k, v] of Object.entries(${JSON.stringify(KEEP)})) {
          const b = document.querySelector('#rename-found .rn-pick[data-adopt="' + k + '"][data-value="' + v + '"]');
          if (!b) throw new Error('no button offering ' + k + '=' + v);
          b.click();
        }
        document.querySelector('#rename-dest-row .chip[data-dest="inplace"]').click();
        return JSON.stringify({
          diff: document.querySelector('#rename-diff').textContent.replace(/\\s+/g, ' ').trim(),
          rows: document.querySelectorAll('#rename-diff .rn-diff-row').length,
          conflictFroms: document.querySelectorAll('#rename-diff .rn-a.conflict').length,
          chosen: Array.from(document.querySelectorAll('#rename-found .rn-pick.chosen'))
            .map((b) => b.dataset.adopt + '=' + b.dataset.value),
          pn: document.querySelector('#rename-pn').textContent.replace(/\\s+/g, ' ').trim(),
          argv: BUILDERS.rename(),
          cmd: document.querySelector('#view-rename [data-cmd]').textContent,
          disabled: document.querySelector('#view-rename [data-run]').disabled,
          btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
        });
      })()`);
      await wait(300);
      await shot('rename-conflict-repaired');
      record(`rename: repair chose ${repair.chosen.join(', ')}; PatientName composes to ${repair.pn}`);
      record(`rename: repair change list — ${repair.diff}`);
      record(`rename: repair command — ${repair.cmd}`);
      artefact('rename-repair-cmd.txt', `${repair.cmd}\n\nargv: ${JSON.stringify(repair.argv)}\n`);
      if (repair.chosen.length !== 4) {
        bad(`the panel did not mark what was chosen: ${JSON.stringify(repair.chosen)}`);
      }
      // Four --set pairs, over the originals, so every instance under the
      // folder is rewritten. Not a copy: this repairs the study that is there.
      for (const [k, v] of Object.entries(KEEP)) {
        if (!repair.argv.includes(`${k}=${v}`)) {
          bad(`choosing ${k}=${v} did not reach the command: ${JSON.stringify(repair.argv)}`);
        }
      }
      if (repair.argv.filter((a) => a === '--set').length !== 4 || !repair.argv.includes('--in-place')) {
        bad(`the repair is not four fields written over the originals: ${JSON.stringify(repair.argv)}`);
      }
      if (repair.argv.includes('--force') || repair.argv.some((a) => /UID=/i.test(a))) {
        bad(`the repair reached past the four fields: ${JSON.stringify(repair.argv)}`);
      }
      if (repair.rows !== 4 || repair.conflictFroms !== 4) {
        bad(`the change list did not show all four disagreements as the "before": ${repair.diff}`);
      }
      for (const other of Object.values(OTHER)) {
        if (!repair.diff.includes(other)) {
          bad(`the change list dropped what the conflict was between: ${repair.diff}`);
        }
      }
      if (repair.disabled || repair.btn !== 'Rename study') {
        bad(`a repair left the button inert: ${JSON.stringify(repair)}`);
      }

      // ---- Run it, and read the folder back. The proof is not the command:
      // it is that the study which disagreed with itself no longer does.
      await js(`document.querySelector('#view-rename [data-run]').click(); true`);
      await mustWait("!document.querySelector('#view-rename [data-status]').className.includes('running')",
        RUN_MS, 'the repair to finish');
      await mustWait("/instance\\(s\\) written/.test(__smoke.consoleText('rename'))",
        20000, "the repair's report to finish painting");
      await mustWait('renameState.study !== null && !Object.keys(renameState.conflicts).length',
        RUN_MS, 'the repaired study to be re-read');
      const healed = await jsJSON(`JSON.stringify({
        singulars: {
          PatientName: renameState.study.patientName,
          PatientID: renameState.study.patientId,
          StudyDescription: renameState.study.studyDescription,
          AccessionNumber: renameState.study.accessionNumber,
        },
        plurals: {
          PatientName: renameState.study.patientNames,
          PatientID: renameState.study.patientIds,
          StudyDescription: renameState.study.studyDescriptions,
          AccessionNumber: renameState.study.accessionNumbers,
        },
        uid: renameState.study.studyInstanceUid,
        instances: renameState.study.instanceCount,
        panels: document.querySelectorAll('#rename-found .caution').length,
        collisions: document.querySelectorAll('#rename-found .study-card .collision').length,
        status: document.querySelector('#view-rename [data-status]').textContent,
        btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
        found: document.querySelector('#rename-found').textContent.replace(/\\s+/g, ' ').trim(),
        console: __smoke.consoleText('rename').slice(-900),
      })`);
      await wait(300);
      await shot('rename-conflict-healed');
      artefact('rename-repair-output.txt', healed.console);
      record(`rename: repaired study reads back — ${healed.found.slice(0, 170)}`);
      for (const [k, v] of Object.entries(KEEP)) {
        if (healed.singulars[k] !== v || (healed.plurals[k] || []).length !== 1) {
          bad(`${k} did not come back as one agreed value across all `
            + `${healed.instances} instances: ${JSON.stringify(healed)}`);
        }
      }
      if (healed.panels || healed.collisions) {
        bad(`the repaired study still shows a disagreement: ${JSON.stringify(healed)}`);
      }
      if (healed.status !== 'Loaded' || healed.btn !== 'Nothing changed yet') {
        bad(`the repaired study did not read back as already-correct: ${JSON.stringify(healed)}`);
      }
      // An in-place write is the destructive one and its per-tag report is the
      // only account of it there will be. The re-read that proves it worked
      // must not be what wipes it off the screen.
      if (!/set PatientName\s+\d+ instance\(s\)/.test(healed.console)
        || !/instance\(s\) written/.test(healed.console)) {
        bad(`the re-read wiped the repair's own report: ${healed.console.slice(-400)}`);
      }
      // The whole promise again: it is called what it is called and it is
      // still the same study.
      if (healed.uid !== loaded.uid) {
        bad(`the repair changed the Study Instance UID: ${healed.uid} was ${loaded.uid}`);
      }
      await js(`document.querySelector('#rename-dest-row .chip[data-dest="copy"]').click(); true`);
      say('rename: four disagreeing fields are shown as disagreements, never as facts, '
        + 'and one click each repairs every instance');

      // ---- A patient name written in three scripts.
      //
      // The defect this replaces: a DICOM Person Name can hold up to three
      // component GROUPS separated by "=" — the same name in Latin letters, in
      // ideographs, and phonetically. The engine reported only the first, this
      // screen prefilled from what it reported, and the name it composed back
      // was that first group alone. Correcting the capitalisation of a surname
      // deleted the kanji and the kana from every instance, and `dcm tags` had
      // the same blind spot, so there was nowhere in the app they could be
      // seen to have existed.
      //
      // A throwaway copy, never the fixtures themselves: this arms --in-place.
      const jp = path.join(work, 'multiscript');
      fs.cpSync(fixtures, jp, { recursive: true });
      // SpecificCharacterSet is not optional here. The octets go out as UTF-8
      // either way, but without it nothing tells a reader to decode them that
      // way, and a test built on a file no conforming reader could interpret
      // would be testing something else.
      const JP_NAME = 'Yamada^Tarou=山田^太郎=やまだ^たろう';
      const JP_RENAMED = 'YAMADA^Tarou=山田^太郎=やまだ^たろう';
      const script = await runEngine([
        'edit', jp,
        '--set', 'SpecificCharacterSet=ISO_IR 192',
        '--set', `PatientName=${JP_NAME}`,
        '--in-place',
      ]);
      if (script.code !== 0) bad(`could not build a multi-script study: ${script.err.slice(-400)}`);

      await js(`__smoke.set('rename-folder', ${JSON.stringify(jp)}); true`);
      await mustWait(`renameState.study !== null && renameState.path === ${JSON.stringify(jp)}`,
        RUN_MS, 'the multi-script study to be scanned');
      const script1 = await jsJSON(`JSON.stringify({
        name: renameState.study.patientName,
        family: document.querySelector('#rename-family').value,
        given: document.querySelector('#rename-given').value,
        groups: renameState.groups,
        extras: renameState.extras,
        pn: document.querySelector('#rename-pn').textContent.replace(/\\s+/g, ' ').trim(),
      })`);
      record(`rename: multi-script study loads as ${script1.name}`);
      record(`rename: composed line reads — ${script1.pn}`);
      // The engine has to have reported the whole name, or nothing downstream
      // can preserve it. A stale vendored engine fails here first.
      if (script1.name !== JP_NAME) {
        bad('dcm info --json reduced a three-group name to one group — is the vendored '
          + `engine stale?: ${JSON.stringify(script1)}`);
      }
      // The boxes hold the Latin group, which is the group they can edit.
      if (script1.family !== 'Yamada' || script1.given !== 'Tarou') {
        bad(`the boxes did not take Family/Given from the Latin group: ${JSON.stringify(script1)}`);
      }
      // The other two ride along in state rather than in the boxes.
      if (script1.groups.length !== 2 || script1.extras.length !== 0) {
        bad(`the other two spellings were not carried: ${JSON.stringify(script1)}`);
      }
      // Nothing preserved invisibly: the composed line is the whole value, and
      // says in five words that the rest is kept rather than about to go.
      if (!script1.pn.includes(JP_NAME) || !/other spelling\(s\) kept/.test(script1.pn)) {
        bad(`the screen did not show what it is about to write: ${script1.pn}`);
      }

      // ---- Correct the surname in Latin letters only, which is the edit that
      // used to be a deletion.
      const jpOut = path.join(work, 'multiscript-renamed');
      const script2 = await jsJSON(`(() => {
        __smoke.set('rename-family', 'YAMADA');
        __smoke.set('rename-out', ${JSON.stringify(jpOut)});
        return JSON.stringify({
          pn: document.querySelector('#rename-pn').textContent.replace(/\\s+/g, ' ').trim(),
          diff: document.querySelector('#rename-diff').textContent.replace(/\\s+/g, ' ').trim(),
          rows: document.querySelectorAll('#rename-diff .rn-diff-row').length,
          argv: BUILDERS.rename(),
          cmd: document.querySelector('#view-rename [data-cmd]').textContent,
        });
      })()`);
      // This window does not composite while the harness drives it, so a frame
      // asked for too soon is the previous screen. The other new-screen shots pay
      // the same wait for the same reason.
      await wait(900);
      await shot('rename-multiscript');
      record(`rename: multi-script composes to ${script2.pn}`);
      record(`rename: multi-script command — ${script2.cmd}`);
      artefact('rename-multiscript-cmd.txt',
        `${script2.cmd}\n\nargv: ${JSON.stringify(script2.argv)}\n`);
      // The one assertion this whole repair exists for: what goes on the
      // command line carries every group the file had.
      if (!script2.argv.includes(`PatientName=${JP_RENAMED}`)) {
        bad(`the rename dropped a component group on its way to the command: ${JSON.stringify(script2.argv)}`);
      }
      if (script2.rows !== 1) bad(`one changed field did not make one change row: ${script2.diff}`);
      // And it was on screen before it was on the command line.
      if (!script2.pn.includes(JP_RENAMED)) {
        bad(`the screen would have written a name it did not show: ${script2.pn}`);
      }

      await js(`document.querySelector('#view-rename [data-run]').click(); true`);
      await mustWait("!document.querySelector('#view-rename [data-status]').className.includes('running')",
        RUN_MS, 'the multi-script rename to finish');
      await mustWait("/instance\\(s\\) written/.test(__smoke.consoleText('rename'))",
        20000, "the multi-script rename's report to finish painting");

      await js(`__smoke.set('rename-folder', ${JSON.stringify(jpOut)}); true`);
      await mustWait(`renameState.study !== null && renameState.path === ${JSON.stringify(jpOut)}`,
        RUN_MS, 'the multi-script copy to be read back');
      const script3 = await jsJSON(`JSON.stringify({
        name: renameState.study.patientName,
        family: document.querySelector('#rename-family').value,
        given: document.querySelector('#rename-given').value,
        groups: renameState.groups,
        btn: document.querySelector('#view-rename [data-run]').textContent.trim(),
      })`);
      await wait(900);
      await shot('rename-multiscript-read-back');
      record(`rename: the multi-script copy reads back as ${script3.name}`);
      // Read off disk, not off the form: the surname is corrected and both
      // other spellings are still there.
      if (script3.name !== JP_RENAMED) {
        bad(`the written file lost a component group: ${JSON.stringify(script3)}`);
      }
      if (script3.groups.length !== 2 || script3.family !== 'YAMADA' || script3.given !== 'Tarou') {
        bad(`the renamed copy did not split back into its groups: ${JSON.stringify(script3)}`);
      }
      if (script3.btn !== 'Nothing changed yet') {
        bad(`re-loading the renamed copy proposed a further change: ${JSON.stringify(script3)}`);
      }
      say('rename: a name written in three scripts was renamed in one of them and '
        + 'kept the other two, on screen and on disk');

      await js("__smoke.set('rename-folder', ''); true");
    }

    // =====================================================================
    // K2. Layout, at the window sizes this app is actually used at.
    //
    // A page that scrolls sideways is the defect, and it is the one an eye
    // misses: a detail panel jammed past the right edge with its labels cut
    // off mid-word looks, in a screenshot, like a panel that is merely tight.
    // So it is asserted rather than looked at — on every screen, at every
    // width from a small laptop to a 4K desktop, with the screens full of the
    // data this run has already put on them.
    //
    // 1915x1017 is in the list because it is the size the window was at when a
    // real exam was run against a real RIS and the panel came out clipped.
    // =====================================================================
    const SIZES = [
      { w: 1024, h: 768, label: '1024x768' },
      { w: 1440, h: 900, label: '1440x900' },
      { w: 1915, h: 1017, label: '1915x1017', wide: true },  // the owner's maximised window
      { w: 2560, h: 1440, label: '2560x1440' },
    ];
    const layoutProblems = [];
    const startBounds = win.getContentBounds();
    // The station is put into the state the screenshots were taken in: the
    // real list, a patient picked, a folder chosen, and Details open — which
    // is where the three-field form row and the store-AE placeholder live, and
    // where the clipping was. A layout pass over a folded-away form proves
    // nothing about the form.
    await js(`(() => {
      showView('worklist');
      renderWorklist({ ok: true, matches: __smoke.realMatches || state.mwl.matches });
      const tr = Array.from(document.querySelectorAll('#mwl-table tr.pick-row'))[0];
      if (tr) tr.click();
      document.querySelector('#mpps-adv').open = true;
      return true;
    })()`);
    await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
    // A verdict, or the app's own "it took too long" — either is a settled
    // screen, which is all this pass needs. It is not measuring the scan.
    await mustWait("!document.querySelector('#mpps-folder-check').hidden && !mppsFolderUnknown()"
      + " || /took too long/.test(document.querySelector('#mpps-folder-check').textContent)",
    60000, 'the station to settle before the layout pass');
    for (const size of SIZES) {
      win.setContentSize(size.w, size.h);
      // eslint-disable-next-line no-await-in-loop
      await wait(250);
      // eslint-disable-next-line no-await-in-loop
      const got = await jsJSON('JSON.stringify({ w: innerWidth, h: innerHeight })');
      // A display smaller than the size asked for clamps the window on some
      // platforms. Say what was actually measured rather than what was asked
      // for, so a pass at 2560 cannot be a pass at 1900 wearing its name.
      say(`layout: asked for ${size.label}, the window reports ${got.w}x${got.h}`);
      if (got.w < size.w - 4) {
        layoutProblems.push(`${size.label}: the window would not go wider than ${got.w}px, so this width was not tested`);
        continue;
      }
      for (const name of SECTIONS) {
        // eslint-disable-next-line no-await-in-loop
        await js(`showView(${JSON.stringify(name)}); true`);
        const panes = TABS[name] ? TABS[name] : [null];
        for (const tab of panes) {
          if (tab) {
            // eslint-disable-next-line no-await-in-loop
            await js(`showTab(${JSON.stringify(name)}, ${JSON.stringify(tab)}); true`);
          }
          // eslint-disable-next-line no-await-in-loop
          await wait(60);
          // eslint-disable-next-line no-await-in-loop
          const o = await jsJSON('JSON.stringify(__smoke.overflow())');
          const where = tab ? `${name}/${tab}` : name;
          // One full set of frames at the size the field report came from, so
          // every screen can be looked at as the operator sees it rather than
          // only asserted about.
          if (size.wide) {
            // eslint-disable-next-line no-await-in-loop
            await shot(`wide-${where.replace('/', '-')}`);
          }
          if (o.scrollWidth > o.clientWidth) {
            layoutProblems.push(`${size.label} ${where}: the page scrolls sideways — `
              + `${o.shell} scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}`
              + (o.offenders.length ? `; pushed by ${o.offenders.map((x) => `${x.sel} (right ${x.right})`).join(', ')}` : ''));
          }
        }
        if (TABS[name]) {
          // eslint-disable-next-line no-await-in-loop
          await js(`showTab(${JSON.stringify(name)}, ${JSON.stringify(TABS[name][0])}); true`);
        }
      }

      // The station with a patient on it is the screen that broke, so its
      // panel is checked for its own clipping as well as the page's.
      // eslint-disable-next-line no-await-in-loop
      await js('showView("worklist"); true');
      // eslint-disable-next-line no-await-in-loop
      await wait(150);
      // eslint-disable-next-line no-await-in-loop
      const clip = await jsJSON('JSON.stringify(__smoke.clipping("#mwl-detail"))');
      if (clip.length) {
        layoutProblems.push(`${size.label} worklist: the patient panel cuts its own contents off — `
          + clip.map((c) => `${c.sel} needs ${c.scroll}px in ${c.client}px`).join(', '));
      }
      // eslint-disable-next-line no-await-in-loop
      const station = await jsJSON(`JSON.stringify({
        cols: getComputedStyle(document.querySelector('.station-body')).gridTemplateColumns,
        panelRight: Math.round(document.querySelector('#mwl-detail').getBoundingClientRect().right),
        tableRows: Math.round(document.querySelector('#view-worklist .table-scroll') ? document.querySelector('#view-worklist .table-scroll').clientHeight : 0),
        cmdLines: (() => { const el = document.querySelector('#mpps-cmd');
          return el ? Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight)) : 0; })(),
        cmdScrolls: (() => { const el = document.querySelector('#mpps-cmd');
          return el ? (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) : false; })(),
      })`);
      record(`layout ${size.label}: station columns ${station.cols}, panel right edge ${station.panelRight} `
        + `of ${got.w}, list ${station.tableRows}px tall, command ${station.cmdLines} line(s)`);
      // The command preview is this app's promise. It may be folded; it may
      // never need scrolling to be read from its first character.
      if (station.cmdScrolls) {
        layoutProblems.push(`${size.label} worklist: the command preview scrolls inside itself instead of wrapping`);
      }
      // eslint-disable-next-line no-await-in-loop
      await shot(`layout-${size.label}-worklist`);
      // eslint-disable-next-line no-await-in-loop
      await js('showView("settings"); true');
      // eslint-disable-next-line no-await-in-loop
      await wait(120);
      // eslint-disable-next-line no-await-in-loop
      await shot(`layout-${size.label}-settings`);
    }
    win.setContentBounds(startBounds);
    await wait(200);
    await js('showView("worklist"); true');
    if (layoutProblems.length) {
      artefact('layout-problems.txt', layoutProblems.join('\n'));
      for (const p of layoutProblems) say(`layout PROBLEM: ${p}`);
      bad(`${layoutProblems.length} layout problem(s) — see layout-problems.txt`);
    }
    record(`layout: no page-level horizontal scrolling on any screen at ${SIZES.map((s) => s.label).join(', ')}`);

    // =====================================================================
    // K2. Every other Browse… button.
    //
    // wirePickers is shared: repairing the station repaired it by making a
    // picked path announce itself with `input` and then `change`, in the order
    // typing produces them, which changes what happens on every screen a
    // picker feeds. Several of those fields had listeners on only one of the
    // two events, so the question is not academic — a field that used to see
    // one event now sees both, and a handler that runs twice is a second child
    // process or a second render.
    //
    // The property asserted is the strongest one available and needs no
    // per-field knowledge: pressing Browse… must leave the app in exactly the
    // state typing the same path leaves it in — every builder's argv, across
    // every screen, identical — and must not start more engine children than
    // typing did. Anything a picker does that typing does not is, by
    // definition, a path only the picker can take, which is where the last bug
    // lived.
    // =====================================================================
    {
      armPicker();
      const pickPath = fixtures || work;
      // Where each picker-fed field lives. mpps-folder is not here: it is
      // driven end to end against the real RIS in section H, which needs a
      // selected worklist row this one has no business creating.
      const PICKERS = [
        ['send-folder', "showView('send')"],
        ['scp-persist', "showView('receive')"],
        ['websend-folder', "showView('web'); showTab('web', 'websend')"],
        ['webhub-persist', "showView('web'); showTab('web', 'webhub')"],
        ['webhub-root', "showView('web'); showTab('web', 'webhub')"],
        ['info-folder', "showView('tools'); showTab('tools', 'inventory')"],
        ['tags-target', "showView('tools'); showTab('tools', 'tags')"],
        ['rename-folder', "showView('tools'); showTab('tools', 'rename')"],
        ['rename-out', "showView('tools'); showTab('tools', 'rename')"],
        ['edit-target', "showView('tools'); showTab('tools', 'edit')"],
        ['edit-out', "showView('tools'); showTab('tools', 'edit')"],
        ['anon-folder', "showView('tools'); showTab('tools', 'anon')"],
        ['anon-out', "showView('tools'); showTab('tools', 'anon')"],
        ['speed-folder', "showView('speed')"],
      ];
      // Nothing may be added to index.html without being pressed here.
      const inDom = await jsJSON(`JSON.stringify(Array.from(new Set(
        Array.from(document.querySelectorAll('[data-pick]')).map((b) => b.dataset.pick))))`);
      const covered = new Set([...PICKERS.map(([id]) => id), 'mpps-folder']);
      const uncovered = inDom.filter((id) => !covered.has(id));
      if (uncovered.length) bad(`picker(s) nothing presses: ${uncovered.join(', ')}`);
      if (covered.size !== inDom.length) {
        bad(`this list names a picker index.html does not have: ${JSON.stringify([...covered])} vs ${JSON.stringify(inDom)}`);
      }

      // Engine children are counted where the renderer starts them. A doubled
      // folder scan is the specific cost worth naming, and it does not show up
      // in any rendered output — only in a second process.
      await js(`(() => {
        __smoke._origCapture = runCapture;
        runCapture = function (view, argv) {
          __smoke.spawns.push(view + ': ' + argv.join(' '));
          return __smoke._origCapture.apply(null, arguments);
        };
        return true;
      })()`);

      // 600ms clears the station's 350ms debounce and every render these
      // fields set off. Rename is the only one of them that reads the folder,
      // so it is the only one with a child to wait on properly.
      const settle = async (id) => {
        if (id.startsWith('rename')) await waitFor('!state.activeRuns.rename', 30000, 'the rename scan to finish');
        await wait(600);
      };
      const fill = async (id, how) => {
        await js(`(() => { __smoke.set('${id}', ''); __smoke.spawns = []; return true; })()`);
        await settle(id);
        await js(`(() => { __smoke.spawns = []; return true; })()`);
        if (how === 'type') await js(`__smoke.set('${id}', ${JSON.stringify(pickPath)}); true`);
        else await pressPicker(id, pickPath);
        await settle(id);
        return jsJSON(`JSON.stringify({
          value: document.querySelector('#${id}').value,
          argvs: __smoke.argvs(),
          spawns: __smoke.spawns.slice(),
          errors: window.__errors.length,
        })`);
      };

      const pickerNotes = [];
      for (const [id, goto] of PICKERS) {
        // eslint-disable-next-line no-await-in-loop
        await js(`(() => { ${goto}; return true; })()`);
        // eslint-disable-next-line no-await-in-loop
        await wait(150);
        // eslint-disable-next-line no-await-in-loop
        const typed = await fill(id, 'type');
        // eslint-disable-next-line no-await-in-loop
        const picked = await fill(id, 'pick');

        if (picked.value !== pickPath) bad(`Browse… did not fill #${id}: ${JSON.stringify(picked.value)}`);
        if (picked.errors !== typed.errors) {
          bad(`pressing Browse… on #${id} threw where typing did not — see __errors`);
        }
        if (JSON.stringify(picked.argvs) !== JSON.stringify(typed.argvs)) {
          bad(`Browse… and typing leave #${id} in different states.\n  typed:  ${JSON.stringify(typed.argvs)}\n  picked: ${JSON.stringify(picked.argvs)}`);
        }
        if (picked.spawns.length > typed.spawns.length) {
          bad(`Browse… on #${id} started ${picked.spawns.length} engine child(ren) where typing started `
            + `${typed.spawns.length}: ${JSON.stringify(picked.spawns)}`);
        }
        if (picked.spawns.length > 1) {
          bad(`one Browse… on #${id} started ${picked.spawns.length} engine children: ${JSON.stringify(picked.spawns)}`);
        }
        pickerNotes.push(`${id}: picked === typed, ${picked.spawns.length} engine child(ren)`);
        // eslint-disable-next-line no-await-in-loop
        await js(`(() => { __smoke.set('${id}', ''); return true; })()`);
      }
      await js(`(() => { runCapture = __smoke._origCapture; return true; })()`);
      artefact('pickers.txt', pickerNotes.join('\n'));
      for (const n of pickerNotes) say(`picker ${n}`);
      record(`pickers: all ${PICKERS.length} other Browse… buttons leave the app exactly where typing does, `
        + 'and none of them starts a second engine child');
    }

    // =====================================================================
    // L. Flood: no output volume, from any source, may wedge this window.
    //
    // The bug this guards against was a hang with a live socket behind it. A
    // CT carrying private tags made dcmjs log per instance; the console grew a
    // DOM node per pipe read and read scrollHeight straight after each append,
    // forcing a layout every time; the renderer stopped answering; and because
    // nothing could reach the Stop button the engine kept its association open
    // on the peer until the app was force-closed. Removing the source of that
    // particular flood does not make the window safe — the next high-volume
    // stream would do it again.
    //
    // No `dcm` command emits at that rate on demand, so this drives the exact
    // same path (spawn, pipe, IPC, console) with a child that does nothing
    // else. main.js only honours the __script__ argv while DCM_SMOKE_DIR is set.
    // =====================================================================
    const floodScript = path.join(work, 'flood.js');
    const floodPidFile = path.join(work, 'flood.pid');
    fs.writeFileSync(floodScript, [
      "'use strict';",
      '// Emits to stderr as fast as the pipe will take it. argv[2] is the line',
      '// count, or 0 for endless. The lines are long on purpose: the dcmjs',
      '// message behind the original hang passes the tag value, so each one',
      '// dumps an object graph rather than a word.',
      "const fs = require('node:fs');",
      'const total = Number(process.argv[2] || 0);',
      'const pidFile = process.argv[3];',
      'if (pidFile) fs.writeFileSync(pidFile, String(process.pid));',
      "const line = 'Unknown name in dataset (5180,1001) : '",
      "  + '[object ArrayBuffer] { byteLength: 512 } '.repeat(6) + '\\n';",
      'let n = 0;',
      'function pump() {',
      '  for (;;) {',
      '    // Returning rather than calling process.exit: exit can discard writes',
      '    // still queued for a pipe, and a truncated flood is not the test.',
      '    if (total && n >= total) return;',
      '    n++;',
      "    if (!process.stderr.write(line)) { process.stderr.once('drain', pump); return; }",
      '  }',
      '}',
      'pump();',
      '',
    ].join('\n'));

    // Overridable so the same harness can measure the pre-fix renderer, which
    // cannot absorb the full flood in any bounded time — that being the point.
    const FLOOD_LINES = Number(process.env.DCM_SMOKE_FLOOD_LINES || 200000);
    const FLOOD_CAP = 2000; // CONSOLE_MAX_LINES in the renderer

    /** Round-trip time to the renderer, sampled while the flood is running. */
    const pingRenderer = (samples) => {
      let live = true;
      const loop = (async () => {
        while (live) {
          const t0 = Date.now();
          // eslint-disable-next-line no-await-in-loop
          await js('1').catch(() => {});
          samples.push(Date.now() - t0);
          // eslint-disable-next-line no-await-in-loop
          await wait(150);
        }
      })();
      return async () => { live = false; await loop; };
    };

    const READ_CONSOLE = `(() => {
      const wrap = document.querySelector('#view-receive .console-wrap');
      const c = wrap.querySelector('[data-console]');
      const notice = wrap.querySelector('.console-trim');
      const text = c.textContent;
      return JSON.stringify({
        spans: c.childNodes.length,
        nodes: wrap.getElementsByTagName('*').length,
        retainedLines: (text.match(/\\n/g) || []).length,
        chars: text.length,
        notice: notice ? notice.textContent : '',
        lagMs: Math.round((window.__lag || {}).max || 0),
        frames: (window.__lag || {}).frames || 0,
        cost: window.__cost || null,
        dropped: (consoleStates.get(c) || {}).dropped || 0,
        droppedUpstream: (consoleStates.get(c) || {}).droppedUpstream || 0,
        outOpen: __smoke.outOpen('receive'),
      });
    })()`;

    await js(`
      showView('receive');
      clearConsole('receive');
      document.querySelector('#view-receive [data-cancel]').hidden = false;
      // A frame-gap probe. If the renderer wedges, frames stop and the gap is
      // the length of the wedge — which is the number the user experienced.
      window.__lag = { max: 0, frames: 0, last: 0 };
      // What the console itself costs the main thread, as distinct from what
      // the machine happened to be doing. Wall-clock on this box swings by 5x
      // with its display state; this number does not, and it is the one that
      // says whether the console is what would block a click.
      window.__cost = { append: 0, flush: 0, appends: 0, flushes: 0 };
      // Rest args, not a fixed list. Spelling the parameters out here once
      // silently swallowed appendConsole's fourth argument — the count of
      // lines the main process had dropped — and the harness then reported
      // that nothing had been dropped upstream while 195,860 lines were
      // missing. A wrapper that has to be kept in step with a signature is a
      // wrapper that will not be.
      const rawAppend = window.appendConsole;
      window.appendConsole = (...a) => {
        const t0 = performance.now();
        rawAppend(...a);
        window.__cost.append += performance.now() - t0;
        window.__cost.appends++;
      };
      const rawFlush = window.flushConsole;
      window.flushConsole = (...a) => {
        const t0 = performance.now();
        rawFlush(...a);
        window.__cost.flush += performance.now() - t0;
        window.__cost.flushes++;
      };
      (function probe() {
        requestAnimationFrame((t) => {
          if (window.__lag.last) {
            const d = t - window.__lag.last;
            if (d > window.__lag.max) window.__lag.max = d;
          }
          window.__lag.last = t;
          window.__lag.frames++;
          probe();
        });
      })();
      true
    `);
    await wait(400);

    // --- Pass 1: a finite flood, to measure what the console retains. -------
    const pings = [];
    const stopPing = pingRenderer(pings);
    const floodStart = Date.now();
    await js(`
      window.__floodDone_drain = false;
      runStreaming('receive', ['__script__', ${JSON.stringify(floodScript)}, '${FLOOD_LINES}'])
        .then(() => { window.__floodDone_drain = true; });
      true
    `);
    // Sampled while it is still arriving. A console that only behaves once the
    // stream has stopped is not the thing being tested, and the round-trip time
    // of this very read is what an operator's click would have queued behind.
    await wait(600);
    const midAt = Date.now();
    const mid = JSON.parse(await js(READ_CONSOLE));
    const midMs = Date.now() - midAt;
    // Printed the moment it is taken. If the window never recovers, this is the
    // only number that survives, and it is the one that says why.
    const midLine = `flood: mid-flood the wrap held ${mid.nodes} nodes in ${mid.spans} spans; `
      + `reading that took ${midMs}ms`;
    say(midLine);

    const finished = await waitFor('window.__floodDone_drain', 120000, `${FLOOD_LINES} lines to drain`);
    const floodMs = Date.now() - floodStart;
    await stopPing();
    if (!finished) bad('the flood never finished draining');
    // Wait for the console to have actually written what it was given, rather
    // than guessing at a delay. Chromium throttles setTimeout to about 1Hz for
    // a window it considers hidden, so the fallback clock runs four times
    // slower when minimised and a fixed wait either races it or is far longer
    // than it needs to be everywhere else.
    const DRAINED = `(() => {
      const c = document.querySelector('#view-receive [data-console]');
      const st = consoleStates.get(c);
      return !st || st.pending.length === 0;
    })()`;
    if (!await waitFor(DRAINED, 15000, 'the console to write what it kept')) {
      bad('the console never wrote out its buffer');
    }

    const f = JSON.parse(await js(READ_CONSOLE));
    const worstPing = pings.length ? Math.max(...pings) : -1;
    [
      `flood: ${FLOOD_LINES} lines delivered in ${floodMs}ms`,
      midLine,
      `flood: console retained ${f.retainedLines} lines in ${f.spans} spans, ${f.nodes} nodes in the wrap`,
      `flood: worst renderer round-trip during the flood ${worstPing}ms over ${pings.length} samples`,
      f.frames
        ? `flood: worst frame gap ${f.lagMs}ms over ${f.frames} frames`
        // A window that is not compositing (headless, occluded, no display) is
        // given no frames at all, which is not the same thing as a wedge — the
        // round-trip above is what says whether it was answering.
        : 'flood: no animation frames were served at all (window not compositing)',
      `flood: console cost ${Math.round(f.cost.append)}ms buffering over ${f.cost.appends} chunks `
        + `and ${Math.round(f.cost.flush)}ms writing over ${f.cost.flushes} flushes, `
        + `of ${floodMs}ms wall clock`,
      `flood: of those, ${f.droppedUpstream} were dropped upstream by the main process`,
      `flood: notice = ${f.notice || '(none)'}`,
    ].forEach(record);
    await shot('flood-console');

    // The console is a window onto the stream, and it has to admit it.
    if (!f.notice) bad(`${FLOOD_LINES} lines went in and the console claims it dropped none of them`);
    const dropped = Number((f.notice.match(/^([\d,]+)/) || [])[1].replace(/,/g, ''));
    if (!(dropped > 0)) bad(`the drop notice reports no drops: ${f.notice}`);
    // The number on screen has to be the number the console actually holds.
    if (dropped !== f.dropped) {
      bad(`the notice says ${dropped} lines dropped but the console counted ${f.dropped}`);
    }
    // Retained plus dropped is the whole stream, wherever along it the loss
    // happened. It may exceed the line count by a little — a line split across
    // two pipe reads is counted on both sides of the split, deliberately, so a
    // notice can never understate. It may never fall short: that would mean
    // output went missing with nothing anywhere admitting it, which is the
    // failure this whole notice exists to prevent.
    const accounted = dropped + f.retainedLines;
    if (accounted < FLOOD_LINES) {
      bad(`the console accounts for ${accounted} of ${FLOOD_LINES} lines, so it lost `
        + `${FLOOD_LINES - accounted} without saying so`);
    }
    // An upstream drop is a different claim about *where* the gap is, so it
    // has to be said separately rather than folded into "earlier lines".
    if (f.droppedUpstream && !/mid-run/.test(f.notice)) {
      bad(`${f.droppedUpstream} lines went missing mid-run and the notice does not say so`);
    }
    if (f.spans > 60) bad(`the console kept ${f.spans} spans; the cap should hold it near 20`);
    if (f.retainedLines > FLOOD_CAP + 300) {
      bad(`the console retained ${f.retainedLines} lines, past its ${FLOOD_CAP} cap`);
    }
    // The Receive screen's Output starts open, because on that screen the log
    // is the result. A flood must not have shut it.
    if (!f.outOpen) bad('the receiver\'s Output disclosure closed while output was arriving');
    // The point of all of it: the window kept answering while that arrived.
    //
    // Asserted on the console's own CPU cost rather than on the round-trip.
    // The round-trip is reported above and is what an operator would feel, but
    // it moves by 5x with what else the machine is doing, and a threshold that
    // has to tolerate that is too loose to catch a regression. What must stay
    // true is that no single turn of the console is long enough to sit in
    // front of a click: the whole flood costs it well under a second, spread
    // over hundreds of turns.
    const worstFlush = f.cost.flushes ? f.cost.flush / f.cost.flushes : 0;
    if (f.cost.append + f.cost.flush > 3000) {
      bad(`the console spent ${Math.round(f.cost.append + f.cost.flush)}ms of main thread on ${FLOOD_LINES} lines`);
    }
    if (worstFlush > 250) bad(`the console averaged ${Math.round(worstFlush)}ms per write to the DOM`);
    if (worstPing > 20000) bad(`the renderer took ${worstPing}ms to answer during the flood`);

    // --- Pass 2: an endless flood, stopped by the button. -------------------
    // A finite flood that ends on its own proves nothing about the case that
    // mattered, which is an operator trying to stop a transfer that is still
    // going. This one only ends if the button works.
    try { fs.unlinkSync(floodPidFile); } catch { /* first run */ }
    await js(`
      clearConsole('receive');
      window.__floodDone_stop = false;
      window.__stopResult = null;
      runStreaming('receive', ['__script__', ${JSON.stringify(floodScript)}, '0', ${JSON.stringify(floodPidFile)}])
        .then(() => { window.__floodDone_stop = true; });
      true
    `);
    const startedFlood = await waitFor(
      "document.querySelector('#view-receive [data-console]').textContent.length > 0",
      15000, 'the endless flood to start');
    if (!startedFlood) bad('the endless flood never produced output');
    await wait(1500); // let it get properly ahead of the window
    const floodPid = Number(fs.readFileSync(floodPidFile, 'utf8').trim());

    // A real click through the DOM event path, on the button an operator uses.
    // The button's handler does not hand its result anywhere the harness can
    // see, so stopRun is wrapped first — app.js is a classic script, so the
    // handler's reference to it resolves through the global object.
    const clickAt = Date.now();
    await js(`
      const inner = window.stopRun;
      window.stopRun = (v, b) => inner(v, b).then((r) => { window.__stopResult = r; return r; });
      document.querySelector('#view-receive [data-cancel]').click();
      true
    `);
    const answered = await waitFor('window.__stopResult', 20000, 'Stop to take effect');
    const stopMs = Date.now() - clickAt;
    const stopResult = JSON.parse(await js('JSON.stringify(window.__stopResult || null)'));
    // 60s, not 10s: main sends dcm:exit on 'close' — after the pipes drain —
    // and under a flood that backlog can take tens of seconds to cross IPC even
    // though the child died in well under a second. The assertion below is the
    // one that matters, and it checks the process itself rather than the
    // report of it. A timeout here means the exit event is slow, not that
    // anything is still holding the peer.
    await waitFor('window.__floodDone_stop', 60000, 'the stopped run to report its exit');

    // The engine process itself has to be gone, not merely reported gone. This
    // is the whole point: a child left alive is a child still holding whatever
    // it had open on the peer.
    let alive = true;
    try { process.kill(floodPid, 0); } catch { alive = false; }

    record(`flood: Stop clicked mid-flood, answered in ${stopMs}ms: ${JSON.stringify(stopResult)}`);
    record(`flood: engine pid ${floodPid} alive after Stop: ${alive}`);
    await shot('flood-stopped');

    // Reality first, then the report — in that order, so a report that
    // disagrees with the process table is named as the thing it is. Both
    // directions matter: claiming a stop that did not happen leaves an
    // association open behind a reassuring UI, and reporting a failure that
    // did not happen sends an operator hunting a receiver that is already
    // clear. The first version of this waited on the child's pipes draining
    // rather than on the process exiting, and reported the second.
    if (alive) bad(`Stop returned but engine pid ${floodPid} is still running`);
    if (!answered || !stopResult || stopResult.stopped !== true) {
      bad(`Stop reported ${JSON.stringify(stopResult)} for an engine that is in fact gone`);
    }
    if (stopMs > 5000) bad(`Stop took ${stopMs}ms to reach the engine during a flood`);

    // --- Pass 3: the same flood at a minimised window. ----------------------
    // requestAnimationFrame is not served to a window that is not compositing,
    // so a console that only writes on a frame would show nothing at all until
    // the window came back — and would by then have thrown away everything but
    // its last few thousand lines, with no note saying so. A receiver left
    // running behind a minimised window is an ordinary thing to do, so this
    // pins the fallback clock down rather than leaving it to whether the
    // machine running the test happens to be compositing.
    await js(`
      clearConsole('receive');
      window.__floodDone_min = false;
      window.__lag = { max: 0, frames: 0, last: 0 };
      true
    `);
    win.minimize();
    await wait(500);
    const minStart = Date.now();
    await js(`
      runStreaming('receive', ['__script__', ${JSON.stringify(floodScript)}, '${FLOOD_LINES}'])
        .then(() => { window.__floodDone_min = true; });
      true
    `);
    const minDone = await waitFor('window.__floodDone_min', 120000, `${FLOOD_LINES} lines at a minimised window`);
    const minMs = Date.now() - minStart;
    // Same wait as pass 1, and it matters more here: minimised is exactly when
    // the fallback clock is throttled. Reading mid-backlog would count lines as
    // missing that are merely not written yet.
    if (!await waitFor(DRAINED, 20000, 'the minimised console to write what it kept')) {
      bad('a minimised console never wrote out its buffer');
    }
    const m = JSON.parse(await js(READ_CONSOLE));
    win.restore();
    await wait(600);
    // The scroll was skipped while nothing was painting, so it has to catch up
    // on the first frame after restore. This also covers the case that broke
    // it: a console whose element has no layout reports clientHeight 0, and
    // the trim's own scroll events used to latch stick-to-bottom off.
    // Otherwise the operator comes back to a console parked where they left it,
    // with everything they minimised the window to collect below the fold.
    const scrolled = JSON.parse(await js(`(() => {
      const c = document.querySelector('#view-receive [data-console]');
      return JSON.stringify({ top: c.scrollTop, height: c.scrollHeight, view: c.clientHeight });
    })()`));
    const fromBottom = scrolled.height - scrolled.top - scrolled.view;
    record(`flood: minimised — after restore the console sits ${fromBottom}px from the bottom`);

    [
      `flood: minimised — ${FLOOD_LINES} lines drained in ${minMs}ms over ${m.frames} frames`,
      `flood: minimised — retained ${m.retainedLines} lines in ${m.spans} spans, ${m.nodes} nodes`,
      `flood: minimised — ${m.dropped} dropped (${m.droppedUpstream} of them upstream), `
        + `${m.dropped + m.retainedLines} of ${FLOOD_LINES} accounted for`,
      `flood: minimised — notice = ${m.notice || '(none)'}`,
    ].forEach(record);

    if (!minDone) bad('the flood never drained while the window was minimised');
    if (!m.retainedLines) {
      bad('a minimised window received the whole flood and wrote none of it to the console');
    }
    if (!m.notice) bad('a minimised window dropped output and said nothing about it');
    if (m.retainedLines > FLOOD_CAP + 300) {
      bad(`a minimised console retained ${m.retainedLines} lines, past its ${FLOOD_CAP} cap`);
    }
    // The same total that pass 1 demands. A window nobody is looking at is
    // exactly where output could go missing unnoticed, so it is held to the
    // same standard rather than a softer one.
    if (m.dropped + m.retainedLines < FLOOD_LINES) {
      bad(`a minimised console accounts for ${m.dropped + m.retainedLines} of ${FLOOD_LINES} lines, `
        + `so it lost ${FLOOD_LINES - m.dropped - m.retainedLines} without saying so`);
    }
    if (fromBottom > 40) {
      bad(`after restore the console is ${fromBottom}px from the bottom, not following its output`);
    }

    // =====================================================================
    // Carrying user data across a product rename.
    //
    // Electron derives userData from productName, so the AscendI rename moved
    // %APPDATA%\Asteris DICOM App\ to %APPDATA%\AscendI DICOM\. To the person
    // updating, an un-migrated rename does not look like a rename — it looks
    // like the app forgot every PACS peer they ever typed in.
    //
    // main.js hands over the migration as a pure function over paths, which is
    // the only way to test it honestly: it is checked here against throwaway
    // directories this harness creates, never against a real %APPDATA%.
    // =====================================================================
    const { migrateStateFiles, STATE_FILES, LEGACY_PRODUCT_DIRS } = mainHelpers;
    if (typeof migrateStateFiles !== 'function' || !Array.isArray(STATE_FILES)) {
      bad('main did not hand the user-data migration to the harness');
    } else {
      const appData = path.join(work, 'appdata');
      const dirFor = (product) => path.join(appData, product);
      const NEW_PRODUCT = 'AscendI DICOM';
      const legacyDirs = () => LEGACY_PRODUCT_DIRS.map((n) => dirFor(n));
      const put = (product, file, body) => {
        fs.mkdirSync(dirFor(product), { recursive: true });
        fs.writeFileSync(path.join(dirFor(product), file), JSON.stringify(body));
      };
      const get = (product, file) => {
        try { return JSON.parse(fs.readFileSync(path.join(dirFor(product), file), 'utf8')); } catch { return null; }
      };
      const clean = () => { fs.rmSync(appData, { recursive: true, force: true }); };

      // 1. The update everyone will actually perform: the new directory does
      //    not exist yet, and every file the app owns has to arrive.
      clean();
      put('Asteris DICOM App', 'profiles.json', { profiles: [{ name: 'ARCHIVE', host: '10.0.0.9', port: 11112 }] });
      put('Asteris DICOM App', 'settings.json', { stationAe: 'CT01' });
      put('Asteris DICOM App', 'app-state.json', { activeView: 'worklist' });
      // Chromium's own state lives in the same directory and must stay put.
      fs.writeFileSync(path.join(dirFor('Asteris DICOM App'), 'Cookies'), 'not ours');
      const first = migrateStateFiles(dirFor(NEW_PRODUCT), legacyDirs());
      record(`rename: carried ${first.carried.map((c) => c.file).join(', ') || 'nothing'} into a fresh ${NEW_PRODUCT} directory`);
      for (const file of STATE_FILES) {
        if (!get(NEW_PRODUCT, file)) bad(`the rename lost ${file}: an operator would see this as wiped data`);
      }
      if ((get(NEW_PRODUCT, 'profiles.json') || {}).profiles?.[0]?.host !== '10.0.0.9') {
        bad('the migrated profiles.json does not contain the peer that was in the old one');
      }
      if (fs.existsSync(path.join(dirFor(NEW_PRODUCT), 'Cookies'))) {
        bad("the migration copied Chromium's own state, which belongs to the build that wrote it");
      }
      if (!get('Asteris DICOM App', 'profiles.json')) {
        bad('the migration moved the old file instead of copying it; a rollback would find nothing');
      }

      // 2. The direction that loses data if it is wrong. A file already under
      //    the new name was written by a newer run and must win.
      clean();
      put('Asteris DICOM App', 'profiles.json', { profiles: [{ name: 'STALE' }] });
      put('Asteris DICOM App', 'settings.json', { stationAe: 'OLD-AE' });
      put(NEW_PRODUCT, 'profiles.json', { profiles: [{ name: 'CURRENT' }] });
      const second = migrateStateFiles(dirFor(NEW_PRODUCT), legacyDirs());
      if ((get(NEW_PRODUCT, 'profiles.json') || {}).profiles?.[0]?.name !== 'CURRENT') {
        bad('an older profiles.json overwrote a newer one; the rename rolled the operator back');
      }
      if (!get(NEW_PRODUCT, 'settings.json')) {
        bad('the migration is all-or-nothing: one file already present stopped the others being carried');
      }
      record(`rename: an existing profiles.json survived untouched while ${second.carried.map((c) => c.file).join(', ')} still came across`);

      // 3. Two renames deep, and the empty case. Newest legacy name wins; a
      //    first-ever install must not so much as create a directory.
      clean();
      put('Asteris DICOM', 'profiles.json', { profiles: [{ name: 'V05' }] });
      put('Asteris DICOM App', 'profiles.json', { profiles: [{ name: 'V06' }] });
      migrateStateFiles(dirFor(NEW_PRODUCT), legacyDirs());
      if ((get(NEW_PRODUCT, 'profiles.json') || {}).profiles?.[0]?.name !== 'V06') {
        bad('with both old names present the migration took the older one');
      }
      clean();
      const fresh = migrateStateFiles(dirFor(NEW_PRODUCT), legacyDirs());
      if (fresh.carried.length || fs.existsSync(dirFor(NEW_PRODUCT))) {
        bad('a first-ever install had something migrated into it');
      }
      // Never fail a launch: whatever it is handed, it returns a report.
      for (const junk of [undefined, null, 'not a list', [null, 42]]) {
        let report = null;
        try { report = migrateStateFiles(dirFor(NEW_PRODUCT), junk); } catch (err) {
          bad(`the migration threw on ${JSON.stringify(junk)} — that would fail the launch: ${err.message}`);
        }
        if (report && report.carried.length) bad(`the migration carried something from ${JSON.stringify(junk)}`);
      }
      record('rename: the newer of two old names wins, a fresh install migrates nothing, and bad input cannot fail the launch');
      clean();
    }

    // =====================================================================
    // The macOS update path.
    //
    // Two halves, and this harness can reach both without a Mac.
    //
    //   1. Which file the app decides to fetch. That is a pure function over
    //      the release's asset list, and it is the half that has already gone
    //      wrong in front of an operator: the wrong architecture installs and
    //      then reports itself as damaged. Run here against the real v0.15.0
    //      asset names and the real latest-mac.yml.
    //   2. What the banner says once it has. Driven by hand through every
    //      state, because the wording is the other half of the promise —
    //      an app that fetched an installer must not say it updated itself.
    //
    // What this does NOT do, and cannot from here: perform a real download,
    // mount a disk image, or observe Gatekeeper. Nothing below should be read
    // as evidence that a macOS install works.
    // =====================================================================
    const { pickMacAsset, macFeedEntry } = mainHelpers;
    if (typeof pickMacAsset !== 'function' || typeof macFeedEntry !== 'function') {
      bad('main did not hand the macOS update helpers to the harness');
    } else {
      const assets = V15_ASSET_NAMES.map((name) => ({ name, browser_download_url: `https://example/${name}` }));
      const pick = (arch, list) => {
        const a = pickMacAsset(list || assets, arch);
        return a ? a.name : null;
      };

      const picks = { arm64: pick('arm64'), x64: pick('x64') };
      record(`mac update: arm64 -> ${picks.arm64}, x64 -> ${picks.x64}`);
      if (picks.arm64 !== V15_ARM) bad(`Apple Silicon would be given ${picks.arm64}, not ${V15_ARM}`);
      if (picks.x64 !== V15_X64) bad(`Intel would be given ${picks.x64}, not ${V15_X64}`);

      // The near misses in this very release. Each of these is a file whose
      // name contains the architecture and which must never be handed to a Mac.
      for (const wrong of ['.blockmap', 'portable', '.exe', 'dcm-macos']) {
        if (picks.arm64.includes(wrong) || picks.x64.includes(wrong)) {
          bad(`the asset picker matched a "${wrong}" file: ${JSON.stringify(picks)}`);
        }
      }

      // No rule, no file. An architecture the app has never heard of, and a
      // release that is missing the image, both fall back to the page — which
      // is the whole reason the fallback exists.
      for (const [label, got] of [
        ['an unknown architecture', pick('ia32')],
        ['no architecture at all', pick(undefined)],
        ['a release with no assets', pickMacAsset(undefined, 'arm64')],
        ['a release missing the arm64 image',
          pick('arm64', assets.filter((a) => a.name !== V15_ARM))],
      ]) {
        if (got !== null) bad(`${label} produced ${JSON.stringify(got)} instead of falling back to the page`);
      }
      record('mac update: an unknown architecture, a missing image and an empty release all fall back to the page');

      // The rename must not break this. The fixtures above are the real
      // v0.15.0 release, published under the old product name, and they stay
      // that way — those sha512s belong to those exact files. What changes
      // after the rename is the artifactName in package.json, so the same
      // release shape is checked again under the new one. The picker matches
      // on the architecture suffix and never on the product name, which is
      // why it survives; this is the check that says so out loud.
      const renamed = [
        'AscendI-DICOM-0.15.2-arm64.dmg',
        'AscendI-DICOM-0.15.2-arm64.dmg.blockmap',
        'AscendI-DICOM-0.15.2-x64.dmg',
        'AscendI-DICOM-0.15.2-x64.dmg.blockmap',
        'AscendI-DICOM-0.15.2-x64-setup.exe',
        'AscendI-DICOM-0.15.2-x64-portable.exe',
        'dcm-macos-arm64', 'dcm-macos-x64', 'latest-mac.yml',
      ].map((name) => ({ name, browser_download_url: `https://example/${name}` }));
      const renamedPicks = { arm64: pick('arm64', renamed), x64: pick('x64', renamed) };
      record(`mac update, post-rename assets: arm64 -> ${renamedPicks.arm64}, x64 -> ${renamedPicks.x64}`);
      if (renamedPicks.arm64 !== 'AscendI-DICOM-0.15.2-arm64.dmg' || renamedPicks.x64 !== 'AscendI-DICOM-0.15.2-x64.dmg') {
        bad(`the rename broke the macOS asset picker: ${JSON.stringify(renamedPicks)}`);
      }

      // The feed. The x64 case is the one that matters: it is the last entry
      // in the list, and the top-level sha512 that follows it belongs to the
      // arm64 image.
      const armEntry = macFeedEntry(V15_MAC_FEED, V15_ARM);
      const x64Entry = macFeedEntry(V15_MAC_FEED, V15_X64);
      record(`mac update: latest-mac.yml gives arm64 ${armEntry && armEntry.sha512.slice(0, 12)}…, `
        + `x64 ${x64Entry && x64Entry.sha512.slice(0, 12)}…`);
      if (!armEntry || armEntry.sha512 !== V15_ARM_SHA || armEntry.size !== 102407035) {
        bad(`the feed reader misread the arm64 entry: ${JSON.stringify(armEntry)}`);
      }
      if (!x64Entry || x64Entry.sha512 !== V15_X64_SHA || x64Entry.size !== 109497714) {
        bad(`the feed reader misread the x64 entry: ${JSON.stringify(x64Entry)}`);
      }
      if (x64Entry && x64Entry.sha512 === V15_ARM_SHA) {
        bad('the feed reader took the top-level sha512 for the x64 image; every Intel download would be rejected');
      }
      // A feed that cannot be read must produce nothing rather than something
      // wrong — the caller then says it checked the size, not the checksum.
      for (const [label, got] of [
        ['a file the feed does not list', macFeedEntry(V15_MAC_FEED, 'nope.dmg')],
        ['a feed that is not the expected shape', macFeedEntry('not yaml at all', V15_ARM)],
        ['an empty feed', macFeedEntry('', V15_ARM)],
      ]) {
        if (got !== null) bad(`${label} produced ${JSON.stringify(got)} instead of null`);
      }
      record('mac update: an unlisted file, a malformed feed and an empty feed all read as "no checksum"');
    }

    // --- The banner, in every state ----------------------------------------
    // renderUpdateState is a pure function of the state object, so the states
    // main would send are sent by hand. What each one is allowed to say is the
    // point: the download states must never read as an install.
    const bannerState = async (updateState) => jsJSON(`(() => {
      renderUpdateState(${JSON.stringify(updateState)});
      const vis = (el) => (el && !el.hidden ? el.textContent.trim() : '');
      return JSON.stringify({
        hidden: document.querySelector('#update-banner').hidden,
        text: document.querySelector('#update-text').textContent.trim(),
        note: vis(document.querySelector('#update-note')),
        action: vis(document.querySelector('#update-action')),
        more: !document.querySelector('#update-more').hidden,
        check: document.querySelector('#update-check').hidden,
        // The link only ever appears on a packaged build, and this harness
        // usually runs from a source checkout. Without this the assertions
        // below would be testing the dev build's silence.
        eligible: updateCheckEligible,
      });
    })()`);

    const V = '0.15.0';
    const banners = {
      idle: await bannerState({ status: 'idle' }),
      available: await bannerState({ status: 'available', version: V, download: null }),
      availableMac: await bannerState({
        status: 'available', version: V, download: { name: V15_ARM, size: 102407035, arch: 'arm64' },
      }),
      fetching: await bannerState({
        status: 'fetching', version: V, name: V15_ARM, percent: 42, received: 1, total: 2,
      }),
      fetched: await bannerState({
        status: 'fetched', version: V, name: V15_ARM, file: `/Users/x/Downloads/${V15_ARM}`, checked: 'sha512',
      }),
      fetchedUnverified: await bannerState({
        status: 'fetched', version: V, name: V15_ARM, file: `/Users/x/Downloads/${V15_ARM}`, checked: 'size',
      }),
      failed: await bannerState({
        status: 'error', version: V, name: V15_ARM, fallback: 'releases',
        message: 'the file did not match the checksum published with the release',
      }),
      quietError: await bannerState({ status: 'error', message: 'offline' }),
    };
    artefact('update-banner.txt', Object.entries(banners)
      .map(([k, b]) => `${k}:\n  ${JSON.stringify(b, null, 2).split('\n').join('\n  ')}`).join('\n\n'));
    for (const [name, b] of Object.entries(banners)) {
      record(`update banner: ${name} — ${b.hidden ? '(hidden)' : `"${b.text}" [${b.action || 'no button'}]`}`);
    }

    if (!banners.idle.hidden) bad('the banner shows itself with no update to report');
    if (!banners.quietError.hidden) {
      bad('a background check failure raised a banner; only a failure the operator asked for should');
    }
    if (banners.available.action !== 'Download') {
      bad(`a build with no matched file lost its page button: ${JSON.stringify(banners.available)}`);
    }
    if (banners.availableMac.action !== 'Download for this Mac' || banners.availableMac.note !== V15_ARM) {
      bad(`the banner does not name the file it is about to fetch: ${JSON.stringify(banners.availableMac)}`);
    }
    if (!/42%/.test(banners.fetching.text)) {
      bad(`the download reports no progress: ${JSON.stringify(banners.fetching.text)}`);
    }
    if (banners.fetched.action !== 'Show in Finder' || !banners.fetched.more) {
      bad(`a finished download offers no way to the file or to the explanation: ${JSON.stringify(banners.fetched)}`);
    }
    if (banners.failed.action !== 'Open the releases page') {
      bad(`a failed download does not fall back to the page: ${JSON.stringify(banners.failed)}`);
    }

    // The wording, which is the part that can quietly become a lie. The app
    // fetched an installer; it did not install anything, and it did not update
    // itself. And the Gatekeeper line must not send anyone to right-click →
    // Open, which macOS 15 removed.
    for (const key of ['fetching', 'fetched', 'fetchedUnverified']) {
      const said = `${banners[key].text} ${banners[key].note}`;
      if (/\b(installed|installing|updated itself|up to date now)\b/i.test(said)) {
        bad(`the ${key} banner claims an install the app did not perform: ${JSON.stringify(said)}`);
      }
      if (/right[- ]?click/i.test(said)) {
        bad(`the ${key} banner offers right-click → Open, which macOS 15 removed: ${JSON.stringify(said)}`);
      }
    }
    if (!/Privacy & Security/.test(banners.fetched.note) || !/Open Anyway/.test(banners.fetched.note)) {
      bad(`the finished download does not give the Gatekeeper step: ${JSON.stringify(banners.fetched.note)}`);
    }
    if (banners.fetched.note !== banners.fetchedUnverified.note) {
      bad('the Gatekeeper step is worded two different ways');
    }
    // A download that could only be size-checked must say so rather than
    // borrowing the word "verified" from the run that did check the checksum.
    if (/verified/i.test(banners.fetchedUnverified.text)) {
      bad(`an unverified download calls itself verified: ${JSON.stringify(banners.fetchedUnverified.text)}`);
    }
    if (!/checksum/i.test(banners.fetchedUnverified.text)) {
      bad(`an unverified download does not say what was missing: ${JSON.stringify(banners.fetchedUnverified.text)}`);
    }
    if (!/verified/i.test(banners.fetched.text)) {
      bad(`a checksum-verified download does not say so: ${JSON.stringify(banners.fetched.text)}`);
    }

    // The banner and the "Check for updates" link are alternatives, and that
    // has to hold for the new states too or the link stacks under the banner.
    if (banners.idle.eligible) {
      for (const key of ['available', 'availableMac', 'fetching', 'fetched', 'failed']) {
        if (!banners[key].check) bad(`the check link is still showing under the ${key} banner`);
      }
      if (banners.idle.check) bad('the check link did not come back when the banner went away');
    } else {
      say('update banner: this build is unpackaged, so the check link stays hidden throughout');
    }

    await js(`renderUpdateState({ status: 'fetched', version: '${V}', name: ${JSON.stringify(V15_ARM)}, `
      + `file: '/Users/x/Downloads/' + ${JSON.stringify(V15_ARM)}, checked: 'sha512' }); true`);
    // capturePage can hand back the frame from before this render, and did:
    // the screenshot was named for a banner it did not contain. The assertions
    // above are the evidence either way, but an artefact that does not show
    // what its name says is worse than no artefact.
    await wait(250);
    await shot('update-banner-fetched');
    // Left as it was found: this banner is a fiction, and a screenshot is the
    // only thing that should outlive it.
    await js("renderUpdateState({ status: 'idle' }); true");

    // The long version lives in Settings, behind the help affordance every
    // other screen uses, and it is macOS-only — a Windows operator has no
    // Gatekeeper to read about.
    const macHelp = await jsJSON(`(() => {
      const panel = document.querySelector('#mac-update-help');
      showView('settings');
      setHelp('mac-update-help', true);
      panel.scrollIntoView({ block: 'center' });
      const text = panel.textContent;
      return JSON.stringify({
        exists: !!panel,
        sequoia: /Sequoia/.test(text),
        openAnyway: /Open Anyway/.test(text),
        xattr: /xattr -cr/.test(text),
        rightClick: /right[- ]?click →/i.test(text) && !/removed/.test(text),
        macOnlyHidden: Array.from(document.querySelectorAll('.mac-only')).every((el) => el.hidden),
      });
    })()`);
    record(`mac update: the Settings explainer names Sequoia=${macHelp.sequoia}, `
      + `Open Anyway=${macHelp.openAnyway}, xattr=${macHelp.xattr}`);
    if (!macHelp.exists || !macHelp.openAnyway || !macHelp.xattr || !macHelp.sequoia) {
      bad(`the macOS explainer is missing part of the escape route: ${JSON.stringify(macHelp)}`);
    }
    await wait(250);
    await shot('update-mac-explainer');
    // Read, then put away: the panel is opened here and nowhere else.
    const closed = await js("setHelp('mac-update-help', false); document.querySelector('#mac-update-help').hidden");
    if (!closed) bad('the macOS explainer would not close');

    if (macHelp.rightClick) bad('the macOS explainer still recommends right-click → Open');
    if (process.platform !== 'darwin' && !macHelp.macOnlyHidden) {
      bad('the macOS-only Settings section is showing on a platform that has no Gatekeeper');
    }

    // wireUpdates' macOS branch, run for real on whatever machine this is.
    // Everything above tests the branch's *effect* while standing outside it;
    // this enters it. That matters because the branch is unreachable on
    // Windows, so a mistake inside it ships unseen — and one did: the unhide
    // was written with $ (querySelector, one Element, no forEach) instead of
    // $$, and the throw landed before the onStatus subscription two lines
    // below, leaving the update banner dead on the only platform the whole
    // download path exists for. Nothing but entering the branch catches that.
    const macWire = await jsJSON(`(async () => {
      const was = state.info.platform;
      state.info.platform = 'darwin';
      let threw = null;
      try { await wireUpdates(); } catch (e) { threw = String((e && e.message) || e); }
      const shown = $$('.mac-only').filter((el) => !el.hidden).length;
      state.info.platform = was;
      // Put the screen back: this run is not on a Mac.
      $$('.mac-only').forEach((el) => { el.hidden = true; });
      return JSON.stringify({ threw, shown, total: $$('.mac-only').length });
    })()`);
    record(`mac update: on darwin, wireUpdates reveals ${macWire.shown} of ${macWire.total} macOS-only elements`);
    if (macWire.threw) bad(`wireUpdates threw on macOS: ${macWire.threw}`);
    if (!macWire.total || macWire.shown !== macWire.total) {
      bad(`the macOS-only Settings section stays hidden on a Mac: ${JSON.stringify(macWire)}`);
    }

    // =====================================================================
    // Close out.
    // =====================================================================
    const errors = await jsJSON('JSON.stringify(window.__errors || [])');
    if (errors.length) bad(`the renderer raised ${errors.length} error(s): ${JSON.stringify(errors)}`);

    if (shotFailures.length) {
      record(`shots: ${shotFailures.length} frame(s) could not be captured — ${shotFailures.join('; ')}`);
    }
    fs.writeFileSync(path.join(OUT, 'measurements.txt'), measured.join('\n') + '\n');
    // This run ends on the Receive screen, and leaving that behind would make
    // the next launch open there. Cleared, so the next run starts where a
    // first launch does.
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'app-state.json'), '{}\n'); } catch { /* not fatal */ }
    stopPeers();
    say('smoke: OK');
    app.exit(0);
  } catch (err) {
    try {
      fs.writeFileSync(path.join(OUT, 'measurements.txt'), measured.join('\n') + '\n');
    } catch { /* the failure below is what matters */ }
    stopPeers();
    process.stderr.write(`smoke: FAILED ${err && err.stack ? err.stack : err}\n`);
    app.exit(1);
  }
}

module.exports = { runSmoke };
