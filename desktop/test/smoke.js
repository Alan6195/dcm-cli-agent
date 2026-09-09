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
  tools: ['inventory', 'tags', 'edit', 'anon'],
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

function stopPeers() {
  for (const p of peers) {
    try { p.child.kill(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('electron').App} app
 */
async function runSmoke(win, app) {
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
      const DRY = ['send', 'mpps', 'mpps.start', 'steps.complete', 'steps.discontinue', 'steps.send', 'websend', 'edit'];
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
          detached: !!state.mwl.detached,
          note: document.querySelector('#mwl-detached-note').hidden ? '' : 'shown',
        });
        renderWorklist({ ok: true, matches: [A, B] });
        selectRow(document.querySelector('#mwl-table tr.pick-row').dataset.key);
        const before = read();
        renderWorklist({ ok: true, matches: [B, A] });   // the same two rows, the other way round
        const reordered = read();
        renderWorklist({ ok: true, matches: [B] });      // and now ALPHA has left the list
        const gone = read();
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
        return JSON.stringify({ before, reordered, gone, picked, unkeyed });
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
      const VERDICT = "(() => { const b = document.querySelector('#mpps-folder-check');"
        + " return !b.hidden && b.textContent && !b.textContent.startsWith('Reading'); })()";
      const SLOW = "/taking too long/.test(document.querySelector('#mpps-folder-check').textContent)";
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
      for (const needed of ['mpps perform', fixtures.replace(/\\/g, '/'), '--study-uid ' + FIX_STUDY,
        '--accession ACC-78', '--patient-id P-2002', '--patient-name SMITH^ALAN', '--modality CT',
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
        if (startCmdFold.cmd.includes('--store-host') || startCmdFold.cmd.includes(fixtures.replace(/\\/g, '/'))) {
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

      // --- H3: start only, then add images and complete -------------------
      // This row names the study the fixtures carry, which is the only case in
      // which images may be added to an already-open step: `dcm send` copies
      // nothing, so there is no re-stamping on this path.
      await selectRowFor('LEE^MIN');
      await js(`__smoke.set('mpps-folder', ${JSON.stringify(fixtures)}); true`);
      await waitFolder();
      const startCmd = await js(`mppsStartArgv().join(' ')`);
      say(`start argv: dcm ${startCmd}`);
      if (!/^mpps start /.test(startCmd) || startCmd.includes(fixtures.replace(/\\/g, '/'))) {
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
    // K. Flood: no output volume, from any source, may wedge this window.
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
