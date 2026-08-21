'use strict';

/**
 * Asteris DICOM — renderer.
 *
 * No Node here. Everything goes through window.dcm (see preload.js). Each view
 * builds the exact `dcm` argument vector a person would type, shows it, and
 * runs it. Read-only views (inventory, tags, query) ask the engine for --json
 * and render it as tables; the transfer views stream the engine's own report
 * into a console panel so what you see in the app is what you'd see in a
 * terminal.
 */

// --------------------------------------------------------------------------
// Small DOM + format helpers
// --------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Strip ANSI just in case; the engine runs with NO_COLOR but be defensive. */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Quote an argv element for display the way a shell would need it. */
function quoteArg(a) {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --------------------------------------------------------------------------
// Shared state
// --------------------------------------------------------------------------
const state = {
  conn: { host: '', port: '', calledAe: '', callingAe: '' },
  web: { url: '' },
  profiles: [],
  info: { home: '', platform: '', version: '' },
  activeRuns: {}, // view -> runId (for cancel/stop)

  // The worklist as the SCP last returned it, plus which row the operator
  // picked. `matches` is replaced wholesale by a fetch and by nothing else.
  mwl: { matches: [], selectedIdx: null },

  // The last `mpps perform` this app ran, the UID the next one will carry, and
  // what the chosen folder turned out to hold. `lastRun` is kept separately
  // from the selection so the outcome keeps naming its own study after a
  // re-query clears the picker.
  mpps: { lastRun: null, nextUid: null, mismatch: null },

  // The steps this app has performed since the window opened, newest first,
  // and which one is picked. This lives here and nowhere else: nothing is
  // written to disk, so quitting forgets it. It is a memory of what this app
  // did, never a claim about the SCP — MPPS has no query service, so there is
  // no way to ask a peer which steps it is holding.
  steps: { entries: [], selectedUid: null },
};

// --------------------------------------------------------------------------
// Connection panel (shared across echo / send / query)
// --------------------------------------------------------------------------
const CONN_HTML = `
  <div class="conn-panel">
    <div class="conn-title">
      <span>Peer connection</span>
      <div class="conn-profiles">
        <select data-profile-select><option value="">— saved peers —</option></select>
        <button class="btn ghost small" data-profile-save>Save peer</button>
        <button class="btn ghost small" data-profile-del>Delete</button>
      </div>
    </div>
    <div class="conn-grid">
      <label>Host <input type="text" data-conn-host placeholder="pacs.example.org or localhost" /></label>
      <label>Port <input type="number" data-conn-port placeholder="11112" min="1" max="65535" /></label>
      <label>Called AE — peer <input type="text" data-conn-calledae maxlength="16" placeholder="ARCHIVE" /></label>
      <label>Calling AE — us <input type="text" data-conn-callingae maxlength="16" placeholder="DCM-CLI" /></label>
    </div>
  </div>
`;

function mountConnectionPanels() {
  for (const host of $$('[data-conn]')) {
    host.innerHTML = CONN_HTML;
    wireConnPanel(host);
  }
  syncConnInputs();
  refreshProfileSelects();
}

function wireConnPanel(panel) {
  const map = {
    host: '[data-conn-host]',
    port: '[data-conn-port]',
    calledAe: '[data-conn-calledae]',
    callingAe: '[data-conn-callingae]',
  };
  for (const [key, sel] of Object.entries(map)) {
    const input = $(sel, panel);
    input.addEventListener('input', () => {
      state.conn[key] = input.value.trim();
      syncConnInputs(panel);
      updateAllPreviews();
    });
  }
  $('[data-profile-select]', panel).addEventListener('change', (e) => {
    applyProfile(e.target.value);
  });
  $('[data-profile-save]', panel).addEventListener('click', saveCurrentProfile);
  $('[data-profile-del]', panel).addEventListener('click', deleteSelectedProfile);
}

/** Push state.conn into every connection panel's inputs (except the source). */
function syncConnInputs(except) {
  for (const panel of $$('[data-conn]')) {
    if (panel === except) continue;
    $('[data-conn-host]', panel).value = state.conn.host;
    $('[data-conn-port]', panel).value = state.conn.port;
    $('[data-conn-calledae]', panel).value = state.conn.calledAe;
    $('[data-conn-callingae]', panel).value = state.conn.callingAe;
  }
}

function connArgs() {
  const a = [];
  if (state.conn.host) a.push('--host', state.conn.host);
  if (state.conn.port) a.push('--port', String(state.conn.port));
  if (state.conn.calledAe) a.push('--called-ae', state.conn.calledAe);
  if (state.conn.callingAe) a.push('--calling-ae', state.conn.callingAe);
  return a;
}

function connMissing() {
  const miss = [];
  if (!state.conn.host) miss.push('host');
  if (!state.conn.port) miss.push('port');
  if (!state.conn.calledAe) miss.push('called AE');
  return miss;
}

// --------------------------------------------------------------------------
// Profiles
// --------------------------------------------------------------------------
async function loadProfiles() {
  const data = await window.dcm.profiles.get();
  state.profiles = Array.isArray(data?.profiles) ? data.profiles : [];
}

async function persistProfiles() {
  await window.dcm.profiles.set({ profiles: state.profiles });
}

function profileName(c) {
  return `${c.calledAe || 'AE'} @ ${c.host || 'host'}:${c.port || '?'}`;
}

/** Entries without a `kind` predate DICOMweb support and are DIMSE peers. */
function isWebProfile(p) {
  return p.kind === 'dicomweb';
}

function refreshProfileSelects() {
  const dimse = state.profiles.filter((p) => !isWebProfile(p));
  for (const sel of $$('[data-profile-select]')) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— saved peers —</option>' +
      dimse.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    if (dimse.some((p) => p.name === current)) sel.value = current;
  }
  const web = state.profiles.filter(isWebProfile);
  for (const sel of $$('[data-webprofile-select]')) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— saved servers —</option>' +
      web.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    if (web.some((p) => p.name === current)) sel.value = current;
  }
}

function applyProfile(name) {
  const p = state.profiles.find((x) => !isWebProfile(x) && x.name === name);
  if (!p) return;
  state.conn = { host: p.host || '', port: p.port || '', calledAe: p.calledAe || '', callingAe: p.callingAe || '' };
  syncConnInputs();
  updateAllPreviews();
}

async function saveCurrentProfile() {
  if (!state.conn.host && !state.conn.calledAe) return;
  const name = profileName(state.conn);
  const entry = { name, ...state.conn };
  const idx = state.profiles.findIndex((p) => !isWebProfile(p) && p.name === name);
  if (idx >= 0) state.profiles[idx] = entry;
  else state.profiles.push(entry);
  await persistProfiles();
  refreshProfileSelects();
  for (const sel of $$('[data-profile-select]')) sel.value = name;
}

async function deleteSelectedProfile() {
  const sel = $('[data-profile-select]');
  const name = sel ? sel.value : '';
  if (!name) return;
  state.profiles = state.profiles.filter((p) => isWebProfile(p) || p.name !== name);
  await persistProfiles();
  refreshProfileSelects();
}

// --------------------------------------------------------------------------
// DICOMweb server panel (shared across the Web: views)
// --------------------------------------------------------------------------
// Deliberately parallel to — not shared with — the DIMSE connection panel:
// distinct data-* attributes keep the two global syncs from touching each
// other. One base URL mirrors across every [data-webconn] host.
const WEBCONN_HTML = `
  <div class="conn-panel">
    <div class="conn-title">
      <span>DICOMweb server</span>
      <div class="conn-profiles">
        <select data-webprofile-select><option value="">— saved servers —</option></select>
        <button class="btn ghost small" data-webprofile-save>Save server</button>
        <button class="btn ghost small" data-webprofile-del>Delete</button>
      </div>
    </div>
    <div class="conn-grid web">
      <label>Base URL <input type="text" data-webconn-url placeholder="https://pacs.example.org/dicom-web" /></label>
    </div>
    <div class="web-auth-hint">Auth comes from the environment: <code>DCM_WEB_TOKEN</code> (Bearer) or <code>DCM_WEB_USER</code> / <code>DCM_WEB_PASS</code> (Basic) — set before launching the app; there is deliberately no token field.</div>
  </div>
`;

function mountWebPanels() {
  for (const host of $$('[data-webconn]')) {
    host.innerHTML = WEBCONN_HTML;
    wireWebPanel(host);
  }
  syncWebInputs();
  refreshProfileSelects();
}

function wireWebPanel(panel) {
  const input = $('[data-webconn-url]', panel);
  input.addEventListener('input', () => {
    state.web.url = input.value.trim();
    syncWebInputs(panel);
    updateAllPreviews();
  });
  $('[data-webprofile-select]', panel).addEventListener('change', (e) => {
    applyWebProfile(e.target.value);
  });
  $('[data-webprofile-save]', panel).addEventListener('click', saveCurrentWebProfile);
  $('[data-webprofile-del]', panel).addEventListener('click', deleteSelectedWebProfile);
}

/** Push state.web into every DICOMweb panel's inputs (except the source). */
function syncWebInputs(except) {
  for (const panel of $$('[data-webconn]')) {
    if (panel === except) continue;
    $('[data-webconn-url]', panel).value = state.web.url;
  }
}

function applyWebProfile(name) {
  const p = state.profiles.find((x) => isWebProfile(x) && x.name === name);
  if (!p) return;
  state.web.url = p.url || '';
  syncWebInputs();
  updateAllPreviews();
}

async function saveCurrentWebProfile() {
  const url = state.web.url;
  if (!url) return;
  const entry = { name: url, kind: 'dicomweb', url };
  const idx = state.profiles.findIndex((p) => isWebProfile(p) && p.name === entry.name);
  if (idx >= 0) state.profiles[idx] = entry;
  else state.profiles.push(entry);
  await persistProfiles();
  refreshProfileSelects();
  for (const sel of $$('[data-webprofile-select]')) sel.value = entry.name;
}

async function deleteSelectedWebProfile() {
  const sel = $('[data-webprofile-select]');
  const name = sel ? sel.value : '';
  if (!name) return;
  state.profiles = state.profiles.filter((p) => !(isWebProfile(p) && p.name === name));
  await persistProfiles();
  refreshProfileSelects();
}

// --------------------------------------------------------------------------
// Navigation
// --------------------------------------------------------------------------
function showView(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  syncConnInputs();
  syncWebInputs();
  updateAllPreviews();
}

// --------------------------------------------------------------------------
// View parts
// --------------------------------------------------------------------------
/**
 * Where a view's command preview, status chip and console actually live.
 *
 * Every other screen runs one command, so `#view-<name> [data-cmd]` is enough
 * to find its preview. The merged worklist screen runs three — the C-FIND, the
 * perform transaction and the closing N-SET — and they are three separate
 * previews in one section, so those three view keys name their elements
 * outright instead of taking whichever one the selector happened to reach
 * first. The console is deliberately shared: one workspace, one output pane,
 * showing the last thing that ran.
 */
const VIEW_PARTS = {
  worklist: { cmd: '#mwl-cmd', status: '#mwl-status', console: '#wl-console' },
  mpps: { cmd: '#mpps-cmd', status: '#mpps-status', console: '#wl-console' },
  steps: { status: '#steps-status', console: '#wl-console' },
};

function viewPart(view, kind) {
  const named = VIEW_PARTS[view] && VIEW_PARTS[view][kind];
  return named ? $(named) : $(`#view-${view} [data-${kind}]`);
}

// --------------------------------------------------------------------------
// Console output
// --------------------------------------------------------------------------
function consoleEl(view) {
  return viewPart(view, 'console');
}

/** Opens the disclosure the shared console sits in, so a failure is not folded away. */
function revealConsole() {
  const box = $('#mwl-out');
  if (box) box.open = true;
}

function clearConsole(view) {
  const c = consoleEl(view);
  if (c) { c.textContent = ''; c.hidden = false; }
}

function appendConsole(view, text, stream) {
  const c = consoleEl(view);
  if (!c) return;
  c.hidden = false;
  const clean = stripAnsi(text);
  const span = document.createElement('span');
  if (stream === 'stderr') span.className = 'err';
  span.textContent = clean;
  c.appendChild(span);
  c.scrollTop = c.scrollHeight;
}

function setStatus(view, kind, label) {
  const chip = viewPart(view, 'status');
  if (!chip) return;
  if (!kind) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.className = `status-chip ${kind}`;
  chip.textContent = label;
}

// --------------------------------------------------------------------------
// Running commands
// --------------------------------------------------------------------------
/**
 * Run a command, streaming into the view's console.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runStreaming(view, argv, { onExit } = {}) {
  return new Promise(async (resolve) => {
    let stdout = '';
    let stderr = '';
    const runId = await window.dcm.start(argv, state.info.home || null, {
      onChunk: (stream, text) => {
        if (stream === 'stdout') stdout += text; else stderr += text;
        appendConsole(view, text, stream);
      },
      onExit: (code) => {
        delete state.activeRuns[view];
        if (onExit) onExit({ code, stdout, stderr });
        resolve({ code, stdout, stderr });
      },
    });
    state.activeRuns[view] = runId;
  });
}

/** Run a command capturing output silently (for --json views). */
function runCapture(view, argv) {
  return new Promise(async (resolve) => {
    let stdout = '';
    let stderr = '';
    const runId = await window.dcm.start(argv, state.info.home || null, {
      onChunk: (stream, text) => { if (stream === 'stdout') stdout += text; else stderr += text; },
      onExit: (code) => { delete state.activeRuns[view]; resolve({ code, stdout, stderr }); },
    });
    state.activeRuns[view] = runId;
  });
}

// --------------------------------------------------------------------------
// Command preview
// --------------------------------------------------------------------------
function setPreview(view, argv) {
  const el = viewPart(view, 'cmd');
  if (el) el.textContent = 'dcm ' + argv.map(quoteArg).join(' ');
}

const BUILDERS = {}; // view -> () => argv

function updateAllPreviews() {
  for (const [view, build] of Object.entries(BUILDERS)) {
    try { setPreview(view, build()); } catch { /* partial form */ }
  }
  // The collapsed peer bar's summary is the reason four fields may be folded
  // away, so it is refreshed by the same hook that catches every edit to them.
  try { renderMwlPeerSummary(); } catch { /* before the DOM is wired */ }
}

// --------------------------------------------------------------------------
// View: ECHO
// --------------------------------------------------------------------------
BUILDERS.echo = () => {
  const argv = ['echo', ...connArgs()];
  const t = $('#echo-timeout').value.trim();
  if (t) argv.push('--timeout', t);
  return argv;
};

function wireEcho() {
  $('#echo-timeout').addEventListener('input', updateAllPreviews);
  $('#view-echo [data-run]').addEventListener('click', async () => {
    const miss = connMissing();
    clearConsole('echo');
    if (miss.length) { appendConsole('echo', `Fill in: ${miss.join(', ')}.\n`, 'stderr'); return; }
    setStatus('echo', 'running', 'Testing…');
    const { code } = await runStreaming('echo', BUILDERS.echo());
    setStatus('echo', code === 0 ? 'ok' : 'fail', code === 0 ? 'Reachable' : 'Failed');
  });
}

// --------------------------------------------------------------------------
// View: SEND
// --------------------------------------------------------------------------
BUILDERS.send = () => {
  const folder = $('#send-folder').value.trim();
  const argv = ['send'];
  if (folder) argv.push(folder);
  argv.push(...connArgs());
  const chunk = $('#send-chunk').value.trim();
  const retry = $('#send-retry').value.trim();
  const timeout = $('#send-timeout').value.trim();
  if (chunk) argv.push('--chunk', chunk);
  if (retry) argv.push('--retry', retry);
  if (timeout) argv.push('--timeout', timeout);
  const syntax = $('#send-syntax').value;
  if (syntax) argv.push('--transfer-syntax', syntax);
  const parallel = $('#send-parallel').value.trim();
  if (parallel && parallel !== '1') argv.push('--parallel', parallel);
  if ($('#send-dryrun').checked) argv.push('--dry-run');
  if ($('#send-norecurse').checked) argv.push('--no-recurse');
  if ($('#send-rewrite').checked) argv.push('--rewrite-series-uid');
  return argv;
};

function parseTotals(text) {
  // Grab the last found/sent/acknowledged trio (TOTALS block if present).
  const grab = (label) => {
    const re = new RegExp(`${label}\\s+(\\d+)`, 'g');
    let m, last = null;
    while ((m = re.exec(text)) !== null) last = Number(m[1]);
    return last;
  };
  return {
    found: grab('files found'),
    sent: grab('files sent'),
    acknowledged: grab('acknowledged'),
  };
}

function showTotals(t, ok) {
  const box = $('#view-send [data-totals]');
  if (t.found == null) { box.hidden = true; box.classList.remove('show'); return; }
  const cell = (n, lbl, cls = '') =>
    `<div class="total-card ${cls}"><div class="num">${n ?? '—'}</div><div class="lbl">${lbl}</div></div>`;
  const ackClass = ok ? 'ok' : 'fail';
  box.innerHTML = cell(t.found, 'files found') + cell(t.sent, 'files sent') + cell(t.acknowledged, 'acknowledged', ackClass);
  box.hidden = false;
  box.classList.add('show');
}

function wireSend() {
  ['send-folder', 'send-chunk', 'send-retry', 'send-timeout', 'send-parallel'].forEach((id) =>
    $(`#${id}`).addEventListener('input', updateAllPreviews));
  $('#send-syntax').addEventListener('change', updateAllPreviews);
  ['send-dryrun', 'send-norecurse', 'send-rewrite'].forEach((id) =>
    $(`#${id}`).addEventListener('change', updateAllPreviews));

  $('#view-send [data-run]').addEventListener('click', async () => {
    const folder = $('#send-folder').value.trim();
    clearConsole('send');
    $('#view-send [data-totals]').hidden = true;
    if (!folder) { appendConsole('send', 'Choose a folder to send.\n', 'stderr'); return; }
    const dry = $('#send-dryrun').checked;
    if (!dry) {
      const miss = connMissing();
      if (miss.length) { appendConsole('send', `Fill in the peer connection: ${miss.join(', ')}.\n`, 'stderr'); return; }
    }
    setStatus('send', 'running', dry ? 'Scanning…' : 'Sending…');
    $('#view-send [data-run]').disabled = true;
    if (!dry) $('#view-send [data-cancel]').hidden = false;

    const { code, stdout } = await runStreaming('send', BUILDERS.send());

    $('#view-send [data-run]').disabled = false;
    $('#view-send [data-cancel]').hidden = true;
    const ok = code === 0;
    setStatus('send', ok ? 'ok' : 'fail', ok ? (dry ? 'Plan ready' : 'All acknowledged') : 'Incomplete');
    if (!dry) showTotals(parseTotals(stdout), ok);
  });

  $('#view-send [data-cancel]').addEventListener('click', () => {
    const id = state.activeRuns.send;
    if (id) window.dcm.cancel(id);
  });
}

// --------------------------------------------------------------------------
// View: RECEIVE (scp)
// --------------------------------------------------------------------------
BUILDERS.receive = () => {
  const argv = ['scp'];
  const port = $('#scp-port').value.trim();
  argv.push('--port', port || '11112');
  const ae = $('#scp-ae').value.trim();
  if (ae) argv.push('--ae', ae);
  const persist = $('#scp-persist').value.trim();
  if (persist) argv.push('--persist', persist);
  const accept = $('#scp-accept').value.trim();
  if (accept) accept.split(',').map((s) => s.trim()).filter(Boolean).forEach((a) => argv.push('--accept-calling-ae', a));
  const reject = $('#scp-rejectafter').value.trim();
  if (reject) argv.push('--reject-after', reject);
  return argv;
};

function wireReceive() {
  ['scp-port', 'scp-ae', 'scp-persist', 'scp-accept', 'scp-rejectafter'].forEach((id) =>
    $(`#${id}`).addEventListener('input', updateAllPreviews));

  $('#view-receive [data-run]').addEventListener('click', async () => {
    clearConsole('receive');
    setStatus('receive', 'running', 'Listening');
    $('#view-receive [data-run]').disabled = true;
    $('#view-receive [data-cancel]').hidden = false;
    const { code } = await runStreaming('receive', BUILDERS.receive());
    // Only reached when the receiver stops.
    $('#view-receive [data-run]').disabled = false;
    $('#view-receive [data-cancel]').hidden = true;
    setStatus('receive', code === 0 ? 'ok' : 'fail', code === 0 ? 'Stopped' : 'Stopped');
  });

  $('#view-receive [data-cancel]').addEventListener('click', () => {
    const id = state.activeRuns.receive;
    if (id) window.dcm.cancel(id);
  });
}

// --------------------------------------------------------------------------
// View: QUERY (find)
// --------------------------------------------------------------------------
function findLevel() {
  const r = $('input[name="find-level"]:checked');
  return r ? r.value : 'study';
}

BUILDERS.query = () => {
  const argv = ['find', ...connArgs()];
  const level = findLevel();
  if (level !== 'study') argv.push(`--${level}`);
  const limit = $('#find-limit').value.trim();
  if (limit) argv.push('--limit', limit);
  for (const row of $$('#find-keys .kv-row')) {
    const k = $('.kv-k', row).value.trim();
    const v = $('.kv-v', row).value.trim();
    if (k) argv.push(`${k}=${v}`);
  }
  return argv;
};

function addKvRow(container, { k = '', v = '', keyPh = 'Keyword', valPh = 'value', withVal = true } = {}) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.innerHTML =
    `<input type="text" class="kv-k" placeholder="${keyPh}" value="${esc(k)}" />` +
    (withVal ? `<span class="kv-eq">=</span><input type="text" class="kv-v" placeholder="${valPh}" value="${esc(v)}" />` : '') +
    `<button class="kv-del" title="Remove">✕</button>`;
  $('.kv-del', row).addEventListener('click', () => { row.remove(); updateAllPreviews(); });
  $$('input', row).forEach((i) => i.addEventListener('input', updateAllPreviews));
  container.appendChild(row);
}

function renderFindResults(json) {
  const box = $('#view-query [data-result]');
  const matches = Array.isArray(json?.matches) ? json.matches : (Array.isArray(json) ? json : []);
  if (!matches.length) {
    box.hidden = false;
    box.innerHTML = '<div class="empty-note">0 matches. (A peer can accept images and still return no matches — storing and indexing are different.)</div>';
    return;
  }
  const cols = [];
  for (const m of matches) for (const k of Object.keys(m)) if (!cols.includes(k)) cols.push(k);
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = matches.map((m) =>
    `<tr>${cols.map((c) => `<td class="mono">${esc(m[c] ?? '')}</td>`).join('')}</tr>`).join('');
  box.hidden = false;
  box.innerHTML = `<div class="section-title">${matches.length} match(es)</div><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function wireQuery() {
  $('#find-addkey').addEventListener('click', () => { addKvRow($('#find-keys')); updateAllPreviews(); });
  $$('input[name="find-level"]').forEach((r) => r.addEventListener('change', updateAllPreviews));
  $('#find-limit').addEventListener('input', updateAllPreviews);
  addKvRow($('#find-keys'), { k: 'PatientID', keyPh: 'e.g. PatientID', valPh: 'e.g. 12345' });

  $('#view-query [data-run]').addEventListener('click', async () => {
    const miss = connMissing();
    clearConsole('query');
    $('#view-query [data-result]').hidden = true;
    if (miss.length) { appendConsole('query', `Fill in the peer connection: ${miss.join(', ')}.\n`, 'stderr'); return; }
    setStatus('query', 'running', 'Querying…');
    const argv = [...BUILDERS.query(), '--json'];
    const { code, stdout, stderr } = await runCapture('query', argv);
    setStatus('query', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try {
      renderFindResults(JSON.parse(stdout));
    } catch {
      const c = consoleEl('query'); c.hidden = false;
      appendConsole('query', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
    }
  });
}

// --------------------------------------------------------------------------
// View: WORKLIST (MWL)
// --------------------------------------------------------------------------
/** Local YYYYMMDD, offset by whole days. DICOM dates are local, not UTC. */
function dicomDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** The date-matching value for the selected preset, or '' for any. */
function mwlDateValue() {
  const active = $('#mwl-when .chip.active');
  const when = active ? active.dataset.when : 'today';
  if (when === 'today') return dicomDate(0);
  if (when === 'tomorrow') return dicomDate(1);
  // A DICOM date range is inclusive on both ends.
  if (when === 'week') return `${dicomDate(0)}-${dicomDate(7)}`;
  if (when === 'custom') return $('#mwl-date').value.trim();
  return '';
}

BUILDERS.worklist = () => {
  const argv = ['find', ...connArgs(), '--mwl'];
  const limit = $('#mwl-limit').value.trim();
  if (limit) argv.push('--limit', limit);

  // Scheduling keys go in as ordinary pairs; the engine routes them into the
  // Scheduled Procedure Step Sequence where a conformant SCP expects them.
  const date = mwlDateValue();
  if (date) argv.push(`ScheduledProcedureStepStartDate=${date}`);
  const pairs = [
    ['Modality', $('#mwl-modality').value.trim()],
    ['ScheduledStationAETitle', $('#mwl-station').value.trim()],
    ['PatientName', $('#mwl-patientname').value.trim()],
    ['PatientID', $('#mwl-patientid').value.trim()],
    ['AccessionNumber', $('#mwl-accession').value.trim()],
  ];
  for (const [k, v] of pairs) if (v) argv.push(`${k}=${v}`);
  return argv;
};

/**
 * The session badge for a worklist row, or null.
 *
 * Matched on Study Instance UID, and on the scheduled step ID as well whenever
 * both sides name one. A partial match shows nothing rather than guessing: a
 * badge that named the wrong row would be exactly the false claim about the
 * far end that this table is built to avoid. A row the SCP returned with no
 * Study Instance UID can never be badged, because there is nothing to key on.
 */
function sessionBadgeFor(item) {
  const uid = attrOf(item, 'StudyInstanceUID');
  if (!uid) return null;
  const stepId = attrOf(item, 'ScheduledProcedureStepID');
  // Newest first, so a re-performed study shows what happened most recently.
  const hit = state.steps.entries.find((e) => e.studyInstanceUid === uid
    && (!stepId || !e.scheduledStepId || e.scheduledStepId === stepId));
  if (!hit) return null;

  const c = hit.counts || {};
  const counts = (c.acknowledged != null && c.found != null)
    ? ` ${c.acknowledged}/${c.found}` : '';
  if (hit.status === 'COMPLETED') return { cls: 'done', text: `completed here${counts}`, uid: hit.mppsUid };
  if (hit.status === 'DISCONTINUED') return { cls: 'stopped', text: `discontinued here${counts}`, uid: hit.mppsUid };
  return { cls: 'open', text: 'open — not closed', uid: hit.mppsUid };
}

/** Renders worklist matches as a scheduling table. */
function renderWorklist(json) {
  const box = $('#mwl-results');
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  box.hidden = false;

  // A fetch replaces the list, so any previous pick is gone with it. Carrying a
  // selection across queries would mean showing attributes the SCP did not just
  // return, which is exactly the kind of stale local state this screen avoids.
  state.mwl.matches = matches;
  clearWorklistSelection();

  if (!matches.length) {
    box.innerHTML =
      '<div class="empty-note">No scheduled procedures matched. Try <b>Any date</b> with no ' +
      'other filters to see whether this SCP answers for your AE Title at all.</div>';
    $('#mwl-foot').hidden = true;
    renderOpenAlert();
    return;
  }

  const fmtTime = (t) => {
    const s = String(t || '').replace(/[^0-9]/g, '');
    if (s.length < 4) return s || '';
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
  };
  const fmtDate = (d) => {
    const s = String(d || '');
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
  };

  // The date is printed per row only when the query spans more than one day.
  // Today / Tomorrow already fix it, and repeating it on every row of a
  // one-day query is ten wasted characters times N.
  const active = $('#mwl-when .chip.active');
  const when = active ? active.dataset.when : 'today';
  const showDate = when !== 'today' && when !== 'tomorrow';

  const rows = matches.map((m, i) => {
    const badge = sessionBadgeFor(m);
    const procedure = m.RequestedProcedureDescription || m.ScheduledProcedureStepDescription || '';
    const patient = m.PatientName || '';
    return `<tr class="pick-row" data-idx="${i}" tabindex="0" role="button" aria-pressed="false">
      <td class="pick-cell"><span class="pick-dot"></span></td>
      <td class="when">${showDate ? `${esc(fmtDate(m.ScheduledProcedureStepStartDate))} ` : ''}${esc(fmtTime(m.ScheduledProcedureStepStartTime))}</td>
      <td><span class="pill ${m.Modality === 'CT' ? 'ct' : ''}">${esc(m.Modality || '?')}</span></td>
      <td title="${esc(patient)}">${esc(patient)}</td>
      <td class="mono">${esc(m.PatientID || '')}</td>
      <td class="mono">${esc(m.AccessionNumber || '')}</td>
      <td title="${esc(procedure)}">${esc(procedure)}</td>
      <td class="session-cell">${badge
        ? `<span class="pill session ${badge.cls}" data-step-uid="${esc(badge.uid)}" title="This app performed this step from this window, in this session. It is not a statement about what the RIS now shows.">${esc(badge.text)}</span>`
        : ''}</td>
    </tr>`;
  }).join('');

  box.innerHTML =
    `<div class="qbar-count">${matches.length} scheduled — click one to perform it</div>` +
    '<div class="table-scroll"><table id="mwl-table">' +
    // Widths sum to 720 of the ~857px column; Procedure takes the slack.
    // Modality is sized for its own header, not its 2-3 character values.
    '<colgroup><col style="width:26px"><col style="width:100px"><col style="width:80px">' +
    '<col style="width:150px"><col style="width:96px"><col style="width:96px">' +
    '<col><col style="width:130px"></colgroup>' +
    '<thead><tr><th class="pick-cell"></th><th>Scheduled</th><th>Modality</th><th>Patient</th>' +
    '<th>Patient ID</th><th>Accession</th><th>Procedure</th><th>This app</th></tr></thead>' +
    `<tbody>${rows}</tbody></table></div>`;
  $('#mwl-foot').hidden = false;
  renderOpenAlert();
}

/**
 * Repaints just the badge column against the session list.
 *
 * Called after a run and after a close. It touches the last cell of each row
 * and nothing else — no row is re-coloured, no other cell is rewritten, and
 * the SCP's own data in the other columns is left exactly as it was returned.
 */
function refreshSessionBadges() {
  for (const tr of $$('#mwl-table tr.pick-row')) {
    const item = state.mwl.matches[Number(tr.dataset.idx)];
    const cell = tr.querySelector('td.session-cell');
    if (!item || !cell) continue;
    const badge = sessionBadgeFor(item);
    cell.innerHTML = badge
      ? `<span class="pill session ${badge.cls}" data-step-uid="${esc(badge.uid)}" title="This app performed this step from this window, in this session. It is not a statement about what the RIS now shows.">${esc(badge.text)}</span>`
      : '';
  }
  renderOpenAlert();
}

/**
 * The step this app opened that no row in the current results accounts for.
 *
 * This is the case the merge would otherwise lose. A step left IN PROGRESS has
 * to stay reachable even when the query that produced its row has been
 * replaced, because the only place its UID is remembered is this window.
 */
function renderOpenAlert() {
  const el = $('#mwl-open-alert');
  if (!el) return;
  const open = state.steps.entries.filter((e) => e.status === 'IN PROGRESS');
  const shown = new Set($$('#mwl-table tr.pick-row')
    .map((tr) => sessionBadgeFor(state.mwl.matches[Number(tr.dataset.idx)]))
    .filter(Boolean).map((b) => b.uid));
  const stranded = open.filter((e) => !shown.has(e.mppsUid));
  if (!stranded.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    `<span><b>${stranded.length} step${stranded.length === 1 ? '' : 's'} this app opened ` +
    `${stranded.length === 1 ? 'is' : 'are'} still IN PROGRESS and not in these results.</b></span>` +
    `<button class="btn ghost small" data-show-step="${esc(stranded[0].mppsUid)}">Show it</button>`;
}

// --------------------------------------------------------------------------
// Worklist selection — the hand-off into `dcm mpps perform`
// --------------------------------------------------------------------------
/** The worklist item the operator picked, or null. */
function selectedWorklistItem() {
  const i = state.mwl.selectedIdx;
  return i == null ? null : (state.mwl.matches[i] ?? null);
}

/** First non-empty value among the given keys of a worklist match. */
function attrOf(item, ...keys) {
  for (const k of keys) {
    const v = item ? item[k] : '';
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * The attributes a selected row hands to `dcm mpps perform`.
 *
 * Everything here came off the wire in the C-FIND response. Nothing is
 * defaulted or guessed: a key the SCP did not return stays empty, and the
 * screen says so rather than filling it in.
 */
function worklistAttrs(item) {
  if (!item) return null;
  return {
    studyInstanceUid: attrOf(item, 'StudyInstanceUID'),
    accessionNumber: attrOf(item, 'AccessionNumber'),
    patientId: attrOf(item, 'PatientID'),
    patientName: attrOf(item, 'PatientName'),
    patientBirthDate: attrOf(item, 'PatientBirthDate'),
    patientSex: attrOf(item, 'PatientSex'),
    modality: attrOf(item, 'Modality'),
    scheduledStepId: attrOf(item, 'ScheduledProcedureStepID'),
    scheduledStepDescription: attrOf(item, 'ScheduledProcedureStepDescription'),
    requestedProcedureId: attrOf(item, 'RequestedProcedureID'),
    requestedProcedureDescription: attrOf(item, 'RequestedProcedureDescription'),
    scheduledStationAe: attrOf(item, 'ScheduledStationAETitle'),
  };
}

/** One "key / value" cell, amber when the SCP returned nothing for it. */
function attrCell(label, value, missingLabel = 'not returned by the SCP') {
  const has = value !== '';
  return `<div class="attr ${has ? '' : 'missing'}">` +
    `<div class="attr-k">${esc(label)}</div>` +
    `<div class="attr-v">${esc(has ? value : `— ${missingLabel} —`)}</div></div>`;
}

/**
 * Puts the one action panel into perform mode or closing mode, or takes it down.
 *
 * The panel is one object with two jobs, because a scheduled step and a step
 * this app already opened are two different things to be holding. Only one can
 * be selected at a time, so picking either releases the other.
 */
function setPanelMode(mode) {
  const body = $('#mwl-detail-body');
  const empty = $('#mwl-detail-empty');
  body.hidden = mode === null;
  empty.hidden = mode !== null;
  $('#mwl-perform-mode').hidden = mode !== 'perform';
  $('#mwl-close-mode').hidden = mode !== 'close';
  $('#mwl-detail').classList.toggle('open', mode !== null);
  $('#mwl-detail-title').textContent = mode === 'close'
    ? ($('#steps-close').hidden ? 'This step is closed' : 'Close this step')
    : 'Perform this step';
}

function selectWorklistRow(idx) {
  const item = state.mwl.matches[idx];
  if (!item) return;
  // One panel, one selection: picking a scheduled row releases any session step.
  if (state.steps.selectedUid) clearStepsSelection();
  state.mwl.selectedIdx = idx;

  for (const tr of $$('#mwl-table tr.pick-row')) {
    const on = Number(tr.dataset.idx) === idx;
    tr.classList.toggle('row-selected', on);
    tr.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) tr.scrollIntoView({ block: 'nearest' });
  }

  const a = worklistAttrs(item);

  // Seed the two Type 1 fields the operator is allowed to correct. Re-seeding
  // on every selection is right: they describe the row that is now picked.
  const stepId = $('#mpps-stepid');
  stepId.value = a.scheduledStepId;
  delete stepId.dataset.touched;
  const desc = $('#mpps-stepdesc');
  desc.value = a.scheduledStepDescription || a.requestedProcedureDescription;
  delete desc.dataset.touched;

  setPanelMode('perform');
  renderMppsPanel();
  updateAllPreviews();
  // A different row is a different study, so whatever was concluded about the
  // chosen folder no longer applies to it.
  checkMppsFolder();

  // The one thing the row cannot supply. This absorbs the side effect of the
  // deleted "Perform this step →" button, which existed only to cross a screen
  // boundary that no longer exists.
  const folder = $('#mpps-folder');
  if (!folder.value.trim()) folder.focus();
}

function clearWorklistSelection() {
  state.mwl.selectedIdx = null;
  // Whatever was concluded about the folder was concluded against a row that
  // is no longer picked, so it cannot go on adding a flag to the command.
  state.mpps.mismatch = null;
  renderMppsMismatch();
  for (const tr of $$('#mwl-table tr.pick-row')) {
    tr.classList.remove('row-selected');
    tr.setAttribute('aria-pressed', 'false');
  }
  if (!state.steps.selectedUid) setPanelMode(null);
  renderMppsPanel();
  updateAllPreviews();
}

/**
 * Says whether the study we performed is still returned by this query.
 *
 * Deliberately worded as correlation. A worklist item can leave a query's
 * results for reasons that have nothing to do with our MPPS — the date filter,
 * the station AE, the SCP's own rules — and it can stay in them even after a
 * performed step was accepted. Either way, all that has been re-read is this
 * query.
 */
function renderMwlCorrelation() {
  const el = $('#mwl-correlation');
  const last = state.mpps.lastRun;
  if (!last || !last.studyInstanceUid) { el.hidden = true; return; }

  const uid = last.studyInstanceUid;
  const present = state.mwl.matches.some((m) => attrOf(m, 'StudyInstanceUID') === uid);
  const info = '<button type="button" class="info-btn" aria-expanded="false" ' +
    'aria-controls="info-correlation" aria-label="Why this is correlation"></button>';
  el.hidden = false;
  el.innerHTML = present
    ? 'The study you performed <b>still matches this query.</b> Some SCPs keep a scheduled ' +
      `step visible after one is reported. ${info}`
    : 'The study you performed <b>no longer matches this query.</b> That is correlation, not ' +
      `proof — the date filter or the SCP's own rules can do the same. ${info}`;
}

function wireWorklist() {
  for (const chip of $$('#mwl-when .chip')) {
    chip.addEventListener('click', () => {
      $$('#mwl-when .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      $('#mwl-date').hidden = chip.dataset.when !== 'custom';
      updateAllPreviews();
    });
  }
  ['mwl-date', 'mwl-modality', 'mwl-station', 'mwl-limit', 'mwl-patientname', 'mwl-patientid', 'mwl-accession']
    .forEach((id) => $(`#${id}`).addEventListener('input', () => {
      renderMwlMoreSummary();
      updateAllPreviews();
    }));
  renderMwlMoreSummary();

  // Delegated, because the table's innerHTML is replaced on every fetch.
  const results = $('#mwl-results');
  results.addEventListener('click', (e) => {
    // The "open — not closed" badge is the shortest path to the fix: it picks
    // the row AND puts the panel straight into closing mode.
    const badge = e.target.closest('.pill.session.open');
    if (badge) {
      e.stopPropagation();
      selectStepRow(badge.dataset.stepUid);
      return;
    }
    const tr = e.target.closest('tr.pick-row');
    if (tr) selectWorklistRow(Number(tr.dataset.idx));
  });
  results.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.pick-row');
    if (!tr) return;
    // Arrowing moves focus only. Selecting on arrow would re-seed the Type 1
    // fields and re-spawn the folder scan on every keypress through the list.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
      if (next && next.classList.contains('pick-row')) { e.preventDefault(); next.focus(); }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    selectWorklistRow(Number(tr.dataset.idx));
  });

  $('#mwl-clearsel').addEventListener('click', () => {
    if (state.steps.selectedUid) clearStepsSelection();
    else clearWorklistSelection();
    setPanelMode(null);
  });

  // The stranded-open-step alert's own button.
  $('#mwl-open-alert').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-show-step]');
    if (!btn) return;
    $('#session-steps').open = true;
    selectStepRow(btn.dataset.showStep);
  });

  $('#mwl-run').addEventListener('click', async () => {
    const miss = connMissing();
    $('#mwl-results').hidden = true;
    $('#mwl-foot').hidden = true;
    const c = consoleEl('worklist'); c.hidden = true; c.textContent = '';
    if (miss.length) {
      $('#mwl-peer').open = true;
      revealConsole();
      appendConsole('worklist', `Fill in the peer connection: ${miss.join(', ')}.\n`, 'stderr');
      return;
    }
    setStatus('worklist', 'running', 'Fetching…');
    const { code, stdout, stderr } = await runCapture('worklist', [...BUILDERS.worklist(), '--json']);
    setStatus('worklist', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try {
      renderWorklist(JSON.parse(stdout));
      renderMwlCorrelation();
    } catch {
      // No parseable answer means nothing was re-read, so the correlation note
      // from an earlier query would be stale. Take it down.
      $('#mwl-correlation').hidden = true;
      revealConsole();
      appendConsole('worklist', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
    }
  });
}

/** The peer bar's one line, so folding four fields away stays honest. */
function renderMwlPeerSummary() {
  const el = $('#mwl-peer-sum');
  if (!el) return;
  const c = state.conn;
  const set = c.host && c.port && c.calledAe;
  el.textContent = set
    ? `— ${c.calledAe} @ ${c.host}:${c.port} ← ${c.callingAe || 'DCM-CLI'}`
    : '— no peer set: fill in host, port and called AE';
  el.classList.toggle('changed', !set);
}

/** One line naming the filters folded away under More filters. */
function renderMwlMoreSummary() {
  const el = $('#mwl-more-sum');
  if (!el) return;
  const parts = [];
  for (const [id, label] of [
    ['mwl-station', 'station AE'], ['mwl-patientid', 'patient ID'], ['mwl-limit', 'limit'],
  ]) {
    const v = $(`#${id}`).value.trim();
    if (v) parts.push(`${label} ${v}`);
  }
  el.textContent = parts.length ? `— ${parts.join(' · ')}` : '';
  el.classList.toggle('changed', parts.length > 0);
}

// --------------------------------------------------------------------------
// View: MPPS — perform the selected step
// --------------------------------------------------------------------------
/** The storage peer as the three fields currently read. */
function mppsStore() {
  return {
    host: $('#mpps-store-host').value.trim(),
    port: $('#mpps-store-port').value.trim(),
    calledAe: $('#mpps-store-ae').value.trim(),
  };
}

/**
 * Keeps the mirrored fields honest.
 *
 * "Same system as the MPPS peer" copies the real values into the storage
 * fields rather than leaving them blank, so the command preview can name both
 * peers in full. The same goes for the Performed Station AE Title, which is
 * Type 1 and would otherwise be an invisible engine default.
 */
function syncMppsMirrors() {
  const same = $('#mpps-store-same').checked;
  for (const [id, val] of [
    ['mpps-store-host', state.conn.host],
    ['mpps-store-port', state.conn.port],
    ['mpps-store-ae', state.conn.calledAe],
  ]) {
    const el = $(`#${id}`);
    el.readOnly = same;
    el.classList.toggle('mirrored', same);
    if (same) el.value = val;
  }

  const station = $('#mpps-stationae');
  if (!station.dataset.touched) station.value = state.conn.callingAe || 'DCM-CLI';
}

// --------------------------------------------------------------------------
// The step's own UID
// --------------------------------------------------------------------------
/**
 * A fresh MPPS SOP Instance UID.
 *
 * The app mints this rather than letting the engine mint one so that the UID
 * is known BEFORE the run: it appears in the command preview, where it can be
 * read and copied, and it is the handle this session's step list is keyed on
 * even when the run's output cannot be parsed. 2.25.<128-bit integer> is the
 * UUID-derived form from PS3.5 B.2 — no registered root is needed, and the
 * whole UID is written into the command where it can be read.
 */
function newMppsUid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) n = 1n; // a UID component may not be empty
  return `2.25.${n.toString()}`;
}

/** The UID the next run will use. Held so the preview and the run agree. */
function mppsNextUid() {
  if (!state.mpps.nextUid) state.mpps.nextUid = newMppsUid();
  return state.mpps.nextUid;
}

// --------------------------------------------------------------------------
// The stock-image case: the folder's study is not the worklist's study
// --------------------------------------------------------------------------
/**
 * Which way past a study mismatch is selected, or null when there is none.
 *
 * Returns null unless a real single-study mismatch was detected, so neither
 * flag can be added to a command that does not need one. --adopt-worklist-
 * identity and --allow-study-mismatch are mutually exclusive in the engine.
 */
function mppsFix() {
  const m = state.mpps.mismatch;
  if (!m || m.kind !== 'one-study') return null;
  const picked = $$('#mpps-choices input[data-fix]').find((r) => r.checked);
  return picked ? picked.dataset.fix : 'adopt';
}

/** Serial number of the newest folder scan, so a stale one cannot land. */
let mppsScanToken = 0;

/**
 * Reads the chosen folder and compares its study with the worklist row's.
 *
 * The engine refuses a mismatch, and that refusal is right: a step naming one
 * study while the images belong to another never reconciles. But a refusal
 * arriving as a wall of stderr after a run is a bad way to learn that, so the
 * comparison happens here, before anything is sent, and the two ways forward
 * are offered as a choice. `dcm info --json` is read-only.
 */
async function checkMppsFolder() {
  const folder = $('#mpps-folder').value.trim();
  const item = selectedWorklistItem();
  const box = $('#mpps-folder-check');
  const token = ++mppsScanToken;

  state.mpps.mismatch = null;
  if (!folder || !item) {
    box.hidden = true;
    renderMppsMismatch();
    updateAllPreviews();
    return;
  }

  box.hidden = false;
  box.className = 'folder-check';
  box.textContent = 'Reading the folder…';
  renderMppsMismatch();

  // Bounded, because a lost exit event must not leave the panel reading
  // "Reading the folder…" for the rest of the session. This scan is advisory:
  // it exists to offer the mismatch as a choice BEFORE anything is sent. The
  // engine still refuses a real mismatch on its own, and wireMpps turns that
  // refusal back into the same choice, so giving up here loses a convenience,
  // never a safeguard.
  const scanned = await Promise.race([
    runCapture('mpps-scan', ['info', folder, '--json']),
    new Promise((r) => setTimeout(() => r(null), 20000)),
  ]);
  if (token !== mppsScanToken) return; // a newer folder was chosen meanwhile

  if (!scanned) {
    box.className = 'folder-check warn';
    box.textContent = 'Could not read this folder in time. The engine checks it again when it runs.';
    renderMppsMismatch();
    updateAllPreviews();
    return;
  }
  const { stdout } = scanned;

  let scan = null;
  try { scan = JSON.parse(stdout); } catch { scan = null; }

  const studies = Array.isArray(scan?.studies) ? scan.studies : null;
  if (!studies) {
    box.className = 'folder-check warn';
    box.textContent =
      'This folder could not be read. The engine will say exactly why when it runs.';
    renderMppsMismatch();
    updateAllPreviews();
    return;
  }

  if (studies.length === 0) {
    box.className = 'folder-check warn';
    box.textContent =
      `No DICOM instances here (${scan.filesExamined} files examined). ` +
      'A step has to describe images that exist.';
    renderMppsMismatch();
    updateAllPreviews();
    return;
  }

  const instances = studies.reduce((n, s) => n + (s.instanceCount || 0), 0);

  if (studies.length > 1) {
    state.mpps.mismatch = { kind: 'many', studies };
    box.className = 'folder-check warn';
    box.textContent = `${studies.length} studies, ${instances} instances.`;
    renderMppsMismatch();
    updateAllPreviews();
    return;
  }

  const study = studies[0];
  const declared = worklistAttrs(item).studyInstanceUid;
  box.className = 'folder-check ok';

  if (!declared) {
    box.textContent =
      `1 study, ${instances} instances. The row named no study, so the step adopts the ` +
      'images\'. No flag needed.';
  } else if (declared === study.studyInstanceUid) {
    box.textContent = `1 study, ${instances} instances — matches the worklist row.`;
  } else {
    box.className = 'folder-check warn';
    box.textContent = `1 study, ${instances} instances.`;
    state.mpps.mismatch = {
      kind: 'one-study',
      declared,
      onDisk: study.studyInstanceUid,
      instances,
      description: study.studyDescription || '',
      patientId: study.patientId || '',
    };
  }

  renderMppsMismatch();
  updateAllPreviews();
}

/** Draws the mismatch panel, or takes it down. */
function renderMppsMismatch() {
  const panel = $('#mpps-mismatch');
  const m = state.mpps.mismatch;
  const choices = $('#mpps-choices');

  if (!m) {
    panel.hidden = true;
    choices.hidden = true;
    delete panel.dataset.for;
    return;
  }

  panel.hidden = false;

  if (m.kind === 'many') {
    panel.className = 'mismatch compact bad';
    choices.hidden = true;
    $('#mpps-mismatch-head').textContent =
      `This folder holds ${m.studies.length} studies. One performed step describes exactly one.`;
    $('#mpps-mismatch-uids').innerHTML = m.studies.slice(0, 5).map((s) =>
      `<div class="uid-line"><span class="uid-k">${esc(String(s.instanceCount))} instance(s)</span>` +
      `<code>${esc(s.studyInstanceUid)}</code></div>`).join('') +
      (m.studies.length > 5 ? `<div class="uid-line dim">… and ${m.studies.length - 5} more</div>` : '');
    $('#mpps-mismatch-body').innerHTML =
      '<b>Re-stamping cannot fix this</b> — it would merge them into a study that never ' +
      'existed. Split the folder and perform one step per study.' +
      '<button type="button" class="info-btn" aria-expanded="false" ' +
      'aria-controls="info-many-studies" aria-label="Why one step is one study"></button>';
    return;
  }

  panel.className = 'mismatch compact';
  choices.hidden = false;

  // A new mismatch starts on the recommended choice again. Carrying "send
  // as-is" over to a different folder would be a decision nobody made.
  const key = `${m.declared}|${m.onDisk}`;
  if (panel.dataset.for !== key) {
    panel.dataset.for = key;
    const adopt = $('#mpps-choices input[data-fix="adopt"]');
    if (adopt) adopt.checked = true;
  }

  $('#mpps-mismatch-head').textContent =
    'These images belong to a different study than the worklist row.';
  $('#mpps-mismatch-uids').innerHTML =
    `<div class="uid-line"><span class="uid-k">Worklist row</span><code>${esc(m.declared)}</code></div>` +
    `<div class="uid-line"><span class="uid-k">This folder</span><code>${esc(m.onDisk)}</code>` +
    `<span class="uid-x">${esc(m.description || `${m.instances} instance(s)`)}</span></div>`;
  $('#mpps-mismatch-body').innerHTML =
    'Normal for stock images. It has to be resolved before anything is sent — the two records ' +
    'never reconcile otherwise.' +
    '<button type="button" class="info-btn" aria-expanded="false" ' +
    'aria-controls="info-mismatch-why" aria-label="Why this happens"></button>';
}

BUILDERS.mpps = () => {
  // Builders run on every keystroke anywhere, which makes this the one hook
  // that catches a change to the shared connection panel too.
  syncMppsMirrors();

  const argv = ['mpps', 'perform'];
  const folder = $('#mpps-folder').value.trim();
  if (folder) argv.push(folder);

  argv.push(...connArgs());

  // Both peers, always written out. `dcm mpps perform` defaults each --store-*
  // to the MPPS peer, but a default you cannot see is a default nobody can
  // check — and sending images to the RIS by accident is the exact mistake
  // this screen exists to prevent.
  const store = mppsStore();
  if (store.host) argv.push('--store-host', store.host);
  if (store.port) argv.push('--store-port', store.port);
  if (store.calledAe) argv.push('--store-called-ae', store.calledAe);

  const a = worklistAttrs(selectedWorklistItem());
  if (a) {
    const push = (flag, value) => { if (value) argv.push(flag, value); };
    push('--study-uid', a.studyInstanceUid);
    push('--accession', a.accessionNumber);
    push('--patient-id', a.patientId);
    push('--patient-name', a.patientName);
    push('--patient-birth-date', a.patientBirthDate);
    push('--patient-sex', a.patientSex);
    push('--modality', a.modality);
    push('--scheduled-step-id', a.scheduledStepId);
    push('--requested-procedure-id', a.requestedProcedureId);
    push('--requested-procedure-description', a.requestedProcedureDescription);
  }

  const stepId = $('#mpps-stepid').value.trim();
  if (stepId) argv.push('--step-id', stepId);
  const stationAe = $('#mpps-stationae').value.trim();
  if (stationAe) argv.push('--station-ae', stationAe);
  const stepDesc = $('#mpps-stepdesc').value.trim();
  if (stepDesc) argv.push('--step-description', stepDesc);

  // The step's own UID, minted here so it is visible before the run rather
  // than only afterwards in the report.
  argv.push('--mpps-uid', mppsNextUid());

  // Exactly one of these, and only when a mismatch was actually found.
  const fix = mppsFix();
  if (fix === 'adopt') argv.push('--adopt-worklist-identity');
  else if (fix === 'asis') argv.push('--allow-study-mismatch');

  const chunk = $('#mpps-chunk').value.trim();
  if (chunk) argv.push('--chunk', chunk);
  const retry = $('#mpps-retry').value.trim();
  if (retry) argv.push('--retry', retry);
  const retrieveAe = $('#mpps-retrieveae').value.trim();
  if (retrieveAe) argv.push('--retrieve-ae', retrieveAe);

  if ($('#mpps-norecurse').checked) argv.push('--no-recurse');
  if (mppsDryRun()) argv.push('--dry-run');
  return argv;
};

/**
 * Whether the perform toggle is on Dry run.
 *
 * A two-state segmented toggle rather than a checkbox with an eighteen-word
 * label: the mode is then legible at a glance instead of parsed from a
 * sentence. Dry run is still the default posture.
 */
function mppsDryRun() {
  const active = $('#mpps-mode .chip.active');
  return !active || active.dataset.mode === 'dry';
}

/** Keeps the run button, the hint and the command in step with the toggle. */
function renderMppsMode() {
  const dry = mppsDryRun();
  $('#mpps-run').textContent = dry ? 'Dry run' : 'Perform step';
  $('#mpps-mode-hint').textContent = dry
    ? 'Nothing is sent in dry run.'
    : 'This opens a step on the peer and sends the images.';
  $('#mpps-mode-hint').classList.toggle('live', !dry);
}

/** One line naming everything folded away under Advanced that is not a default. */
function renderMppsAdvSummary() {
  const el = $('#mpps-adv-sum');
  if (!el) return;
  const parts = [];

  const store = mppsStore();
  if (!$('#mpps-store-same').checked) {
    parts.push(`images → ${store.host || '?'}:${store.port || '?'} ${store.calledAe || '?'}`);
  }

  const a = worklistAttrs(selectedWorklistItem());
  const stepId = $('#mpps-stepid').value.trim();
  if (a && stepId && stepId !== a.scheduledStepId) parts.push(`step ID ${stepId}`);
  const station = $('#mpps-stationae').value.trim();
  if (station && station !== (state.conn.callingAe || 'DCM-CLI')) parts.push(`station AE ${station}`);
  const desc = $('#mpps-stepdesc').value.trim();
  const seeded = a ? (a.scheduledStepDescription || a.requestedProcedureDescription) : '';
  if (desc && desc !== seeded) parts.push(`description "${desc}"`);

  for (const [id, label] of [
    ['mpps-chunk', 'chunk'], ['mpps-retry', 'retries'], ['mpps-retrieveae', 'retrieve AE'],
  ]) {
    const v = $(`#${id}`).value.trim();
    if (v) parts.push(`${label} ${v}`);
  }

  if ($('#mpps-norecurse').checked) parts.push('no recursion');

  el.textContent = parts.length
    ? `— ${parts.join(' · ')}`
    : '— all defaults: images to the MPPS peer, step ID from the row';
  el.classList.toggle('changed', parts.length > 0);
}

/** Fills the action panel from the selected row. */
function renderMppsPanel() {
  const a = worklistAttrs(selectedWorklistItem());
  if (!a) return;

  const chip = (value, missing) => (value
    ? `<span>${esc(value)}</span>`
    : `<span class="miss">— ${esc(missing)} —</span>`);

  $('#mpps-hero').innerHTML =
    `<div class="hero-main">${chip(a.patientName, 'no patient name')}` +
    `<span class="hero-sep">·</span>${chip(a.modality, 'no modality')}` +
    `<span class="hero-sep">·</span>` +
    `${chip(a.requestedProcedureDescription || a.scheduledStepDescription, 'no procedure description')}</div>` +
    `<div class="hero-sub">Accession ${chip(a.accessionNumber, 'none returned')}` +
    `<span class="hero-sep">·</span>Patient ID ${chip(a.patientId, 'none returned')}` +
    `<span class="hero-sep">·</span>Step ${chip(a.scheduledStepId, 'none returned')}</div>` +
    `<div class="hero-uid">Study ${a.studyInstanceUid
      ? `<code>${esc(a.studyInstanceUid)}</code>`
      : '<span class="miss">— none returned by the SCP —</span>'}</div>`;

  const cells = [
    ['Patient', a.patientName], ['Patient ID', a.patientId],
    ['Patient birth date', a.patientBirthDate], ['Patient sex', a.patientSex],
    ['Accession', a.accessionNumber], ['Modality', a.modality],
    ['Scheduled step ID', a.scheduledStepId], ['Requested procedure ID', a.requestedProcedureId],
    ['Procedure', a.requestedProcedureDescription || a.scheduledStepDescription],
    ['Scheduled station AE', a.scheduledStationAe], ['Study Instance UID', a.studyInstanceUid],
  ];
  $('#mpps-attrs').innerHTML = cells.map(([k, v]) => attrCell(k, v)).join('');
  const filled = cells.filter(([, v]) => v !== '').length;
  // Always visible, and it replaces the twenty-seven words that used to say
  // nothing was wrong. A counter says the same thing and can be read at a
  // glance, which is the whole trade this screen is making.
  $('#mpps-assert-sum').textContent =
    `${filled} of ${cells.length} attributes returned by the SCP`;

  // Anything the SCP left out that the engine is Type 1 about. Inline and
  // amber, never behind the info icon: the third of these stops the N-CREATE
  // outright, and that cannot be something you discover by opening a
  // disclosure.
  const notes = [];
  if (!a.studyInstanceUid) {
    notes.push('No <b>Study Instance UID</b> on this row. Type 1 — the engine takes it from ' +
      'the folder if the folder holds one study.');
  }
  if (!a.modality) {
    notes.push('No <b>Modality</b> on this row. Type 1 — the engine takes it from the folder ' +
      'if the folder holds one.');
  }
  const stepIdMissing = !$('#mpps-stepid').value.trim();
  if (stepIdMissing) {
    notes.push('<b>Performed step ID</b> is empty. It is Type 1; the engine refuses the ' +
      'N-CREATE without it.');
    // Escalated, because the field that fixes it lives under Advanced.
    $('#mpps-adv').open = true;
  }
  const warn = $('#mpps-type1-warn');
  warn.hidden = notes.length === 0;
  warn.innerHTML = notes.join('<br>');

  renderMppsAdvSummary();
}

/**
 * Reads the engine's own report.
 *
 * Deliberately reads the printed report rather than re-deriving anything: the
 * counts and the status sentence shown here are the engine's words, so the app
 * cannot claim more than the transaction did.
 *
 * Both streams are read, and that is not incidental. The counts and the final
 * status are the product and go to stdout, but the two sentences that say a
 * step was never opened or is still open are failures and go to stderr. This
 * screen decides from those two whether a step exists on the peer at all, so
 * reading only stdout would mean deciding it from silence.
 *
 * @param {string} text stdout
 * @param {string} [errText] stderr
 */
function parseMppsReport(text, errText = '') {
  const t = stripAnsi(text);
  const both = `${t}\n${stripAnsi(errText)}`;
  const num = (label) => {
    const m = new RegExp(`^ {2}${label} +(\\d+)`, 'm').exec(t);
    return m ? Number(m[1]) : null;
  };
  const statusMatch = /^step status +(\S+)/m.exec(t);
  const uidMatch = /^MPPS SOP Instance UID +(\S+)/m.exec(t);
  const shortfall = /^\d+ of \d+ instances were acknowledged\.[\s\S]*?unaccounted for\./m.exec(t);
  return {
    status: statusMatch ? statusMatch[1] : null,
    // `step status` is only printed once the N-SET lands, so a run whose N-SET
    // failed reports no status here — stillInProgress below is what says so.
    mppsUid: uidMatch ? uidMatch[1] : null,
    found: num('found'),
    sent: num('sent'),
    acknowledged: num('acknowledged'),
    referenced: num('referenced in MPPS'),
    shortfall: shortfall ? shortfall[0].replace(/\s+/g, ' ') : null,
    stillInProgress: /the step is still IN PROGRESS/.test(both),
    neverOpened: /the procedure step was never opened/.test(both),
  };
}

function renderMppsTotals(r) {
  const box = $('#mpps-totals');
  if (r.found == null) { box.hidden = true; box.classList.remove('show'); return; }
  const cell = (n, lbl, cls = '', extra = '') =>
    `<div class="total-card ${cls}"><div class="num">${n ?? '—'}</div><div class="lbl">${lbl}${extra}</div></div>`;
  const complete = r.acknowledged != null && r.acknowledged === r.found;
  box.innerHTML =
    cell(r.found, 'found') +
    cell(r.sent, 'sent') +
    cell(r.acknowledged, 'acknowledged', complete ? 'ok' : 'fail') +
    cell(r.referenced, 'referenced in MPPS', complete ? 'ok' : 'fail',
      '<button type="button" class="info-btn" aria-expanded="false" ' +
      'aria-controls="info-performed-series" aria-label="How performed series are built"></button>');
  box.hidden = false;
  box.classList.add('show');
}

/**
 * Turns the run into one verdict.
 *
 * DISCONTINUED is a failure here, not a qualified success. The engine already
 * exits non-zero for it; the screen has to say the same thing, because a step
 * that says DISCONTINUED means the study is not fully accounted for in the
 * archive and somebody has to act on that.
 */
function renderMppsOutcome({ code, report, dryRun }) {
  const box = $('#mpps-outcome');
  box.hidden = false;

  if (dryRun) {
    box.className = 'outcome';
    box.innerHTML = '<span class="outcome-head">Dry run — nothing was sent.</span>' +
      'No connection, no step, no images. Performed series cannot be previewed.';
    setStatus('mpps', code === 0 ? 'ok' : 'fail', code === 0 ? 'Plan ready' : 'Scan failed');
    return;
  }

  if (report.status === 'COMPLETED' && code === 0) {
    box.className = 'outcome ok';
    box.innerHTML = '<span class="outcome-head">Step COMPLETED.</span>' +
      'Every instance found on disk was acknowledged and referenced.' +
      '<button type="button" class="info-btn" aria-expanded="false" ' +
      'aria-controls="info-completed" aria-label="What this does not say"></button>';
    setStatus('mpps', 'ok', 'COMPLETED');
    return;
  }

  box.className = 'outcome bad';
  revealConsole();
  let head = 'The step was not completed.';
  let body;
  if (report.status === 'DISCONTINUED') {
    // A shortfall is the one place words are cheap. It stays long on purpose,
    // it stays red, and it is never rounded up to a caveat on a success.
    head = 'Step DISCONTINUED — this is a failure.';
    body = (report.shortfall ? `${esc(report.shortfall)} ` : '') +
      '<b>There is no override.</b> Resend the outstanding instances and open a new step, or ' +
      'find out why the archive refused them.';
  } else if (report.neverOpened) {
    head = 'N-CREATE failed — no step was opened.';
    body = 'Nothing was sent, the images are untouched. The output says why.';
  } else if (report.stillInProgress) {
    // Half the old text was directions to a screen that is gone. The control
    // itself replaces them.
    const peer = state.conn.calledAe || 'the MPPS peer';
    head = `N-SET failed — the step is still open on ${peer}.`;
    body = 'Close it before quitting; this app remembers the UID only until it closes. ' +
      '<button class="btn ghost small" id="mpps-close-now">Close this step</button>';
  } else {
    body = 'The engine exited ' + esc(String(code)) + ' without reporting a closed step. The ' +
      'output above is the whole story.';
  }
  box.innerHTML = `<span class="outcome-head">${esc(head)}</span>${body}`;
  setStatus('mpps', 'fail', report.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'Failed');
}

function wireMpps() {
  const ids = [
    'mpps-store-host', 'mpps-store-port', 'mpps-store-ae',
    'mpps-stepid', 'mpps-stationae', 'mpps-stepdesc',
    'mpps-chunk', 'mpps-retry', 'mpps-retrieveae',
  ];
  ids.forEach((id) => $(`#${id}`).addEventListener('input', () => {
    renderMppsAdvSummary();
    updateAllPreviews();
  }));

  // Once either Type 1 field is edited by hand, stop overwriting it.
  ['mpps-stationae', 'mpps-stepid', 'mpps-stepdesc'].forEach((id) =>
    $(`#${id}`).addEventListener('input', (e) => { e.target.dataset.touched = '1'; }));

  // Filling in a missing Type 1 step ID should retire the warning about it.
  $('#mpps-stepid').addEventListener('input', renderMppsPanel);

  // A different folder is a different study, so re-read it. Debounced because
  // this fires per keystroke when the path is typed rather than picked.
  let folderTimer = null;
  $('#mpps-folder').addEventListener('input', () => {
    updateAllPreviews();
    clearTimeout(folderTimer);
    folderTimer = setTimeout(checkMppsFolder, 350);
  });

  for (const radio of $$('#mpps-choices input[data-fix]')) {
    radio.addEventListener('change', updateAllPreviews);
  }

  $('#mpps-store-same').addEventListener('change', () => {
    renderMppsAdvSummary();
    updateAllPreviews();
  });
  $('#mpps-norecurse').addEventListener('change', () => {
    renderMppsAdvSummary();
    updateAllPreviews();
  });
  for (const chip of $$('#mpps-mode .chip')) {
    chip.addEventListener('click', () => {
      $$('#mpps-mode .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderMppsMode();
      updateAllPreviews();
    });
  }

  // The assert grid: read once, then trusted, so it opens on demand behind the
  // counter line rather than occupying eleven cells of permanent screen.
  $('#mpps-assert-toggle').addEventListener('click', () => {
    const grid = $('#mpps-attrs');
    grid.hidden = !grid.hidden;
    $('#mpps-assert-toggle').textContent = grid.hidden ? 'Show all' : 'Hide';
  });

  $('#mpps-cancel').addEventListener('click', () => {
    const id = state.activeRuns.mpps;
    if (id) window.dcm.cancel(id);
  });

  // The inline "Close this step" the still-IN-PROGRESS outcome offers. It puts
  // the panel into closing mode without leaving the screen, which is the whole
  // reason the third screen could go.
  $('#mpps-outcome').addEventListener('click', (e) => {
    if (!e.target.closest('#mpps-close-now')) return;
    const open = state.steps.entries.find((x) => x.status === 'IN PROGRESS');
    if (open) { $('#session-steps').open = true; selectStepRow(open.mppsUid); }
  });

  $('#mpps-run').addEventListener('click', async () => {
    const item = selectedWorklistItem();
    clearConsole('mpps');
    $('#mpps-outcome').hidden = true;
    $('#mpps-totals').hidden = true;

    if (!item) {
      revealConsole();
      appendConsole('mpps', 'Select a worklist row first.\n', 'stderr');
      return;
    }
    const folder = $('#mpps-folder').value.trim();
    if (!folder) {
      revealConsole();
      appendConsole('mpps', 'Choose the folder holding this study\'s images.\n', 'stderr');
      return;
    }

    const dryRun = mppsDryRun();
    if (!dryRun) {
      const miss = connMissing();
      if (miss.length) {
        appendConsole('mpps', `Fill in the MPPS peer: ${miss.join(', ')}.\n`, 'stderr');
        return;
      }
      const store = mppsStore();
      const storeMiss = [
        ['host', store.host], ['port', store.port], ['called AE', store.calledAe],
      ].filter(([, v]) => !v).map(([label]) => label);
      if (storeMiss.length) {
        appendConsole('mpps',
          `Fill in the storage peer under Advanced: ${storeMiss.join(', ')}. Both peers are named ` +
          'in full in the command, so neither can be left to a hidden default.\n', 'stderr');
        return;
      }
    }

    const argv = BUILDERS.mpps();
    const attrs = worklistAttrs(item);
    // Read before the run: the UID this command carries, and the peers it
    // names, are what the session entry is built from afterwards.
    const uid = mppsNextUid();
    const storePeer = mppsStore();
    setStatus('mpps', 'running', dryRun ? 'Scanning…' : 'Performing…');
    $('#mpps-run').disabled = true;
    if (!dryRun) {
      $('#mpps-cancel').hidden = false;
      // During a real transfer the stream is the interesting thing.
      revealConsole();
    }

    const { code, stdout, stderr } = await runStreaming('mpps', argv);

    $('#mpps-run').disabled = false;
    $('#mpps-cancel').hidden = true;

    // The engine's own study-mismatch refusal, in case the folder changed
    // between the scan above and the run. It is right to refuse; what it
    // cannot do is offer the choice as a choice, so re-read and do that.
    if (/would name one study/.test(stderr) && /--adopt-worklist-identity/.test(stderr)) {
      await checkMppsFolder();
      const box = $('#mpps-outcome');
      box.hidden = false;
      box.className = 'outcome bad';
      box.innerHTML = '<span class="outcome-head">Refused — the images belong to a different ' +
        'study.</span>Nothing was sent, nothing on disk touched. Pick one of the two options above.';
      setStatus('mpps', 'fail', 'Study mismatch');
      return;
    }

    const report = parseMppsReport(stdout, stderr);
    if (!dryRun) {
      renderMppsTotals(report);
      // Recorded so the re-query can name the study it is looking for, even
      // after a fresh fetch clears the selection.
      state.mpps.lastRun = {
        studyInstanceUid: attrs.studyInstanceUid,
        status: report.status,
        code,
      };
      rememberStep({
        report, attrs, uid, folder, peer: { ...state.conn }, store: storePeer,
      });
      // The badge column, and only the badge column. Everything else in the
      // table is what the SCP returned and stays exactly as it was returned;
      // a fresh query is still the only thing that may replace it.
      refreshSessionBadges();
      // The one button now does both jobs, so after a run it says which one.
      $('#mwl-run').textContent = 'Re-query worklist';
      // The UID is spent: a step is identified by it, and a second N-CREATE
      // carrying the same one would be a different step claiming the same
      // identity. Mint the next one now so the preview shows what will run.
      state.mpps.nextUid = null;
      updateAllPreviews();
    }
    renderMppsOutcome({ code, report, dryRun });
  });

  // Resting state: no row picked, so the panel is one line of empty note.
  setPanelMode(null);
  renderMppsMode();
  renderMppsAdvSummary();
}

// --------------------------------------------------------------------------
// Session steps — what this app did since it was opened
// --------------------------------------------------------------------------
/**
 * Adds a step this app just performed to the session list.
 *
 * Session memory on purpose. There is no records directory and no per-step
 * file, so the only place a performed step is remembered is this window, and
 * quitting forgets it. That is the honest shape for it: this list is a note of
 * what THIS APP did, and a note cannot be mistaken for the peer's own state.
 * It could not be that anyway — MPPS has no query service, so there is no way
 * to ask an SCP which steps it is holding, and a file on disk claiming to know
 * would only be a stale guess with a timestamp on it.
 *
 * A run that never opened a step is not remembered. If the N-CREATE failed
 * there is no step on the peer, and an entry for one would name something that
 * does not exist.
 *
 * @param {{report: object, attrs: object, uid: string, folder: string,
 *          peer: object, store: object}} run
 * @returns {boolean} Whether an entry was added.
 */
function rememberStep({ report, attrs, uid, folder, peer, store }) {
  if (report.neverOpened) return false;

  // The engine prints the UID it used. Prefer it over the one this app minted
  // so the list names what actually went on the wire.
  const mppsUid = report.mppsUid || uid;
  const status = report.status || (report.stillInProgress ? 'IN PROGRESS' : '');
  if (!mppsUid || !status) return false;

  state.steps.entries.unshift({
    mppsUid,
    status,
    patientName: attrs.patientName || '',
    patientId: attrs.patientId || '',
    studyInstanceUid: attrs.studyInstanceUid || '',
    // Recorded so a badge can be matched on the study AND the scheduled step,
    // rather than on a study UID alone.
    scheduledStepId: attrs.scheduledStepId || '',
    modality: attrs.modality || '',
    at: new Date(),
    folder,
    peer: { ...peer },
    store: { ...store },
    counts: {
      found: report.found, sent: report.sent,
      acknowledged: report.acknowledged, referenced: report.referenced,
    },
  });
  renderSteps();
  return true;
}

/** complete or discontinue. */
function stepsVerb() {
  const active = $('#steps-verb .chip.active');
  return active ? active.dataset.verb : 'complete';
}

function stepsSelected() {
  const uid = state.steps.selectedUid;
  return uid ? (state.steps.entries.find((e) => e.mppsUid === uid) || null) : null;
}

/** True when a folder scan and the acknowledged set are the same set. */
function stepFullyAcknowledged(e) {
  const c = e.counts || {};
  return c.found != null && c.acknowledged != null && c.found === c.acknowledged;
}

/**
 * The exact `dcm mpps complete|discontinue` this screen would run.
 *
 * The peer comes from the entry, not from the connection panel: the step lives
 * on the system that took the N-CREATE, and closing it against whatever the
 * panel happens to say now would be an N-SET aimed at a peer that never heard
 * of this UID.
 */
function stepsCloseArgv() {
  const e = stepsSelected();
  const argv = ['mpps', stepsVerb()];
  if (e) {
    argv.push(e.mppsUid);
    if (e.peer.host) argv.push('--host', e.peer.host);
    if (e.peer.port) argv.push('--port', String(e.peer.port));
    if (e.peer.calledAe) argv.push('--called-ae', e.peer.calledAe);
    if (e.peer.callingAe) argv.push('--calling-ae', e.peer.callingAe);
    if (e.folder && $('#steps-series').checked) argv.push('--series-from', e.folder);
  }
  if (stepsVerb() === 'discontinue') {
    const code = $('#steps-reasoncode').value.trim();
    if (code) argv.push('--reason-code', code);
  }
  if (stepsDryRun()) argv.push('--dry-run');
  return argv;
}

/** Whether the closing toggle is on Dry run. Same segmented control as perform. */
function stepsDryRun() {
  const active = $('#steps-mode .chip.active');
  return !active || active.dataset.mode === 'dry';
}

function renderStepsClose() {
  const e = stepsSelected();
  const closed = Boolean(e) && e.status !== 'IN PROGRESS';

  // A closed step is history and offers nothing. Taking the controls down is
  // the honest form of that: a disabled button beside a complete command still
  // reads as something that could be made to work.
  $('#steps-close').hidden = !e || closed;
  if (state.steps.selectedUid) {
    $('#mwl-detail-title').textContent = closed ? 'This step is closed' : 'Close this step';
  }

  $('#steps-reason-row').hidden = stepsVerb() !== 'discontinue';
  const dry = stepsDryRun();
  const btn = $('#steps-close-run');
  btn.textContent = dry ? 'Dry run' : (stepsVerb() === 'complete' ? 'Complete step' : 'Discontinue step');
  btn.disabled = !e || closed;

  // The performed-series option only exists while there is a folder to scan
  // and a step still open to close.
  const row = $('#steps-series-row');
  row.hidden = !e || closed || !e.folder;
  if (!row.hidden) {
    $('#steps-series-label').innerHTML =
      'Name the images in this folder as the performed series ' +
      '<button type="button" class="info-btn" aria-expanded="false" ' +
      'aria-controls="info-series-from" aria-label="What series-from asserts"></button> ' +
      '<code>--series-from</code>';
  }

  const note = $('#steps-note');
  if (!e) {
    note.textContent = '';
  } else if (closed) {
    note.innerHTML =
      `This app set this step to <b>${esc(e.status)}</b>. Both COMPLETED and DISCONTINUED are ` +
      'final; a conformant SCP refuses an N-SET out of either.';
  } else {
    const c = e.counts || {};
    let series;
    if (!e.folder) {
      series = 'No folder remembered. Performed series will be empty — the N-SET claims the ' +
        'work finished and names no images.';
    } else if (stepFullyAcknowledged(e)) {
      series = `All ${c.found} instances in that folder were acknowledged, so the two sets match.`;
    } else if (c.found != null && c.acknowledged != null) {
      // A shortfall stays visible and stays specific.
      series = `Only ${c.acknowledged} of ${c.found} were acknowledged, so a scan of that folder ` +
        'would name images the archive may not hold. Off by default.';
    } else {
      series = 'This run reported no counts, so nothing here says that folder matches what the ' +
        'archive took.';
    }
    // Naming the actual peer makes the invariant checkable rather than merely
    // stated: the N-SET goes where the N-CREATE went, not where the peer bar
    // now points.
    const peer = e.peer && e.peer.host
      ? `${e.peer.calledAe || '?'} @ ${e.peer.host}:${e.peer.port || '?'}`
      : (e.peer && e.peer.calledAe) || '?';
    note.innerHTML =
      `This app opened this step on <b>${esc(peer)}</b> and has not closed it. The N-SET goes ` +
      'there.<button type="button" class="info-btn" aria-expanded="false" ' +
      'aria-controls="info-close-peer" aria-label="Why that peer"></button> ' +
      `<span class="series-note">${series}</span>`;
  }

  $('#steps-close-cmd').textContent = 'dcm ' + stepsCloseArgv().map(quoteArg).join(' ');
}

function clearStepsSelection() {
  state.steps.selectedUid = null;
  for (const tr of $$('#steps-results tr.pick-row')) {
    tr.classList.remove('row-selected');
    tr.setAttribute('aria-pressed', 'false');
  }
  if (state.mwl.selectedIdx == null) setPanelMode(null);
}

function selectStepRow(uid) {
  const e = state.steps.entries.find((x) => x.mppsUid === uid);
  if (!e) return;
  // One panel, one selection: picking a session step releases the worklist row.
  if (state.mwl.selectedIdx != null) clearWorklistSelection();
  state.steps.selectedUid = uid;
  for (const tr of $$('#steps-results tr.pick-row')) {
    const on = tr.dataset.uid === uid;
    tr.classList.toggle('row-selected', on);
    tr.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const c = e.counts || {};
  const peerLine = (p) => (p && p.host
    ? `${p.calledAe || '?'} @ ${p.host}:${p.port || '?'}`
    : '');
  $('#steps-attrs').innerHTML =
    attrCell('Status', e.status) +
    attrCell('Patient', e.patientName || e.patientId || '', 'not named by the worklist row') +
    attrCell('Modality', e.modality || '', 'not named by the worklist row') +
    attrCell('Study Instance UID', e.studyInstanceUid || '', 'taken from the folder by the engine') +
    attrCell('MPPS SOP Instance UID', e.mppsUid) +
    attrCell('Acknowledged', c.acknowledged == null ? '' : `${c.acknowledged} of ${c.found} found`, 'no counts reported') +
    attrCell('Performed at', formatStepWhen(e)) +
    attrCell('MPPS peer', peerLine(e.peer), 'not known for this run') +
    attrCell('Storage peer', peerLine(e.store), 'not known for this run') +
    attrCell('Folder sent', e.folder || '', 'none');
  setPanelMode('close');
  // A fresh selection starts on the option that suits it, rather than
  // inheriting a choice made about a different step. This default IS the
  // shortfall invariant: a folder is only offered as the performed series when
  // every instance in it was acknowledged.
  $('#steps-series').checked = Boolean(e.folder) && stepFullyAcknowledged(e);
  renderStepsClose();
  $('#mwl-detail').scrollIntoView({ block: 'nearest' });
}

function formatStepWhen(e) {
  const d = e.at instanceof Date ? e.at : new Date(e.at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Draws the session list. */
function renderSteps() {
  const box = $('#steps-results');
  const strip = $('#session-steps');
  const entries = state.steps.entries;
  const keep = state.steps.selectedUid;

  // With no separate screen, an empty session list simply does not render.
  // Nothing to explain, so nothing to explain it with.
  if (!entries.length) {
    strip.hidden = true;
    box.innerHTML = '';
    clearStepsSelection();
    renderOpenAlert();
    return;
  }
  strip.hidden = false;

  const statusClass = (s) => (s === 'COMPLETED' ? 'ok' : s === 'DISCONTINUED' ? 'bad' : 'warn');
  const rows = entries.map((e) => {
    const c = e.counts || {};
    const patient = e.patientName || e.patientId || '';
    return `<tr class="pick-row" data-uid="${esc(e.mppsUid)}" tabindex="0" role="button" aria-pressed="false">
      <td class="pick-cell"><span class="pick-dot"></span></td>
      <td><span class="pill ${statusClass(e.status)}">${esc(e.status)}</span></td>
      <td>${patient ? esc(patient) : '<span class="miss">— not named by the row —</span>'}</td>
      <td>${esc(e.modality || '')}</td>
      <td class="mono uid-cell">${esc(e.studyInstanceUid || '')}</td>
      <td class="mono">${c.acknowledged == null ? '—' : `${c.acknowledged}/${c.found}`}</td>
      <td class="when">${esc(formatStepWhen(e))}</td>
      <td>${esc(e.peer && e.peer.host ? `${e.peer.calledAe || '?'} @ ${e.peer.host}:${e.peer.port || '?'}` : '')}</td>
    </tr>`;
  }).join('');

  const open = entries.filter((e) => e.status === 'IN PROGRESS').length;
  box.innerHTML =
    '<table><thead><tr><th class="pick-cell"></th><th>Status</th><th>Patient</th><th>Modality</th>' +
    '<th>Study Instance UID</th><th>Acknowledged</th><th>Performed at</th><th>MPPS peer</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;

  // The summary carries the count and, when it matters, the one that still
  // needs an action — so a step left open is legible with the strip closed.
  const sum = $('#session-steps-sum');
  sum.textContent = open
    ? `— ${entries.length}, ${open} still IN PROGRESS`
    : `— ${entries.length}`;
  sum.classList.toggle('changed', open > 0);
  if (open) strip.open = true;

  // Re-drawing must not silently drop a selection that still exists — a close
  // that just landed re-renders this table under the operator's cursor.
  if (keep && entries.some((e) => e.mppsUid === keep)) selectStepRow(keep);
  else clearStepsSelection();
  renderOpenAlert();
}

function wireSteps() {
  for (const chip of $$('#steps-verb .chip')) {
    chip.addEventListener('click', () => {
      $$('#steps-verb .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderStepsClose();
    });
  }
  $('#steps-reasoncode').addEventListener('input', renderStepsClose);
  $('#steps-series').addEventListener('change', renderStepsClose);
  for (const chip of $$('#steps-mode .chip')) {
    chip.addEventListener('click', () => {
      $$('#steps-mode .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderStepsClose();
    });
  }

  const results = $('#steps-results');
  results.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.pick-row');
    if (tr) selectStepRow(tr.dataset.uid);
  });
  results.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr.pick-row');
    if (!tr) return;
    e.preventDefault();
    selectStepRow(tr.dataset.uid);
  });

  $('#steps-close-run').addEventListener('click', async () => {
    const e = stepsSelected();
    clearConsole('steps');
    if (!e) return;
    const dry = stepsDryRun();
    const verb = stepsVerb();
    setStatus('steps', 'running', dry ? 'Building…' : 'Closing…');
    $('#steps-close-run').disabled = true;
    if (!dry) revealConsole();
    const { code } = await runStreaming('steps', stepsCloseArgv());
    $('#steps-close-run').disabled = false;
    setStatus('steps', code === 0 ? 'ok' : 'fail', code === 0 ? (dry ? 'Plan ready' : 'Closed') : 'Failed');
    if (code !== 0) revealConsole();

    // The entry moves only when a real N-SET was accepted. This is not the app
    // repainting a row from what it hoped happened: the engine exits zero only
    // when the SCP accepted the status it was sent, and that status is the one
    // written here.
    if (!dry && code === 0) {
      e.status = verb === 'complete' ? 'COMPLETED' : 'DISCONTINUED';
      renderSteps();
      // The worklist row's badge names this app's own step, so it moves with it.
      refreshSessionBadges();
    }
  });

  renderSteps();
  renderStepsClose();
}

// --------------------------------------------------------------------------
// View: SPEED TEST
// --------------------------------------------------------------------------
/** Which comparison the speed screen is set to run. */
function speedMode() {
  const active = $('#speed-mode .chip.active');
  return active ? active.dataset.mode : 'syntax';
}

/**
 * Builds the list of runs to perform.
 *
 * Each run carries its own calling AE Title so the peer's ingress log can be
 * read per run rather than showing one indistinguishable stream. AE Titles are
 * capped at 16 characters by DICOM, so the label is trimmed to fit rather than
 * being silently truncated by the receiver.
 */
function speedRuns() {
  const prefix = ($('#speed-aeprefix').value.trim() || 'AST').toUpperCase();
  const baseChunk = $('#speed-chunk').value.trim();
  const mode = speedMode();
  const runs = [];

  const ae = (tag, n) => {
    const suffix = `-${String(n).padStart(2, '0')}`;
    const room = 16 - prefix.length - suffix.length - 1;
    const mid = room > 0 ? `-${tag.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, room)}` : '';
    return `${prefix}${mid}${suffix}`.slice(0, 16);
  };

  if (mode === 'syntax') {
    const chosen = $$('.ts-opt').filter((c) => c.checked);
    chosen.forEach((c, i) => {
      const label = c.value || 'as-stored';
      runs.push({
        label,
        title: c.parentElement.textContent.trim(),
        transferSyntax: c.value || null,
        chunk: baseChunk,
        callingAe: ae(c.value || 'STORED', i + 1),
      });
    });
  } else if (mode === 'chunk') {
    const sizes = $('#speed-chunks').value.split(',').map((s) => s.trim()).filter(Boolean);
    sizes.forEach((size, i) => {
      runs.push({
        label: `chunk ${size}`,
        title: `Chunk ${size}`,
        transferSyntax: null,
        chunk: size,
        callingAe: ae(`C${size}`, i + 1),
      });
    });
  } else if (mode === 'parallel') {
    const counts = $('#speed-parallels').value.split(',').map((x) => x.trim()).filter(Boolean);
    counts.forEach((n, i) => {
      runs.push({
        label: `parallel ${n}`,
        title: `${n} association${n === '1' ? '' : 's'}`,
        transferSyntax: null,
        chunk: baseChunk,
        parallel: n,
        callingAe: ae(`P${n}`, i + 1),
      });
    });
  } else {
    const n = Math.max(1, Number($('#speed-repeats').value) || 3);
    for (let i = 0; i < n; i++) {
      runs.push({
        label: `run ${i + 1}`,
        title: `Run ${i + 1}`,
        transferSyntax: null,
        chunk: baseChunk,
        callingAe: ae('RUN', i + 1),
      });
    }
  }
  return runs;
}

/** argv for a single speed run. */
function speedArgv(run) {
  const folder = $('#speed-folder').value.trim();
  const argv = ['send'];
  if (folder) argv.push(folder);
  if (state.conn.host) argv.push('--host', state.conn.host);
  if (state.conn.port) argv.push('--port', String(state.conn.port));
  if (state.conn.calledAe) argv.push('--called-ae', state.conn.calledAe);
  argv.push('--calling-ae', run.callingAe);
  if (run.chunk) argv.push('--chunk', run.chunk);
  if (run.transferSyntax) argv.push('--transfer-syntax', run.transferSyntax);
  if (run.parallel && run.parallel !== '1') argv.push('--parallel', run.parallel);
  argv.push('--label', run.label, '--json');
  return argv;
}

BUILDERS.speed = () => {
  const runs = speedRuns();
  return runs.length ? speedArgv(runs[0]) : ['send'];
};

/** Renders the comparison table once runs have results. */
function renderSpeedResults(results) {
  const box = $('#view-speed [data-result]');
  box.hidden = false;
  const ok = results.filter((r) => r.data && r.data.ok);

  if (!ok.length) {
    box.innerHTML = '<div class="empty-note">No run completed successfully. The output below says why.</div>';
    return;
  }

  const best = Math.max(...ok.map((r) => r.data.megabytesPerSecond || 0));
  const rows = results.map((r) => {
    if (!r.data) {
      return `<tr><td>${esc(r.run.title)}</td><td colspan="6" class="dim">failed — see output</td></tr>`;
    }
    const d = r.data;
    const isBest = (d.megabytesPerSecond || 0) === best && d.ok;
    const negotiated = (d.negotiatedTransferSyntaxes || []).map((t) => t.name).join(', ') || '—';
    return `<tr class="${isBest ? 'best' : ''}">
      <td>${esc(r.run.title)}${isBest ? '<span class="badge-best">FASTEST</span>' : ''}</td>
      <td class="mono">${esc(r.run.callingAe)}</td>
      <td>${esc(negotiated)}</td>
      <td class="num">${(d.elapsedMs / 1000).toFixed(2)}s</td>
      <td class="num">${d.megabytesPerSecond}</td>
      <td class="num">${d.instancesPerSecond}</td>
      <td class="num">${humanBytes(d.bytesSent)}</td>
      <td class="num">${d.acknowledged}/${d.found}</td>
    </tr>`;
  }).join('');

  box.innerHTML =
    '<div class="section-title">Comparison</div>' +
    '<table><thead><tr><th>Run</th><th>Calling AE</th><th>Negotiated syntax</th>' +
    '<th class="num">Elapsed</th><th class="num">MB/s</th><th class="num">Inst/s</th>' +
    '<th class="num">On the wire</th><th class="num">Ack</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;
}

function wireSpeed() {
  for (const chip of $$('#speed-mode .chip')) {
    chip.addEventListener('click', () => {
      $$('#speed-mode .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const mode = chip.dataset.mode;
      $('#speed-syntax-opts').hidden = mode !== 'syntax';
      $('#speed-chunk-opts').hidden = mode !== 'chunk';
      $('#speed-parallel-opts').hidden = mode !== 'parallel';
      $('#speed-repeat-opts').hidden = mode !== 'repeat';
      updateAllPreviews();
    });
  }
  ['speed-folder', 'speed-aeprefix', 'speed-chunk', 'speed-chunks', 'speed-repeats', 'speed-parallels']
    .forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));
  $$('.ts-opt').forEach((c) => c.addEventListener('change', updateAllPreviews));

  $('#view-speed [data-cancel]').addEventListener('click', () => {
    speedCancelled = true;
    const id = state.activeRuns.speed;
    if (id) window.dcm.cancel(id);
  });

  $('#view-speed [data-run]').addEventListener('click', runSpeedTest);
}

let speedCancelled = false;

async function runSpeedTest() {
  const folder = $('#speed-folder').value.trim();
  const progress = $('#speed-progress');
  const box = $('#view-speed [data-result]');
  const c = consoleEl('speed');
  box.hidden = true;
  c.hidden = true;
  c.textContent = '';

  if (!folder) {
    appendConsole('speed', 'Choose a study folder to send.\n', 'stderr');
    return;
  }
  const miss = connMissing();
  if (miss.length) {
    appendConsole('speed', `Fill in the peer connection: ${miss.join(', ')}.\n`, 'stderr');
    return;
  }

  const runs = speedRuns();
  if (!runs.length) {
    appendConsole('speed', 'Pick at least one thing to compare.\n', 'stderr');
    return;
  }

  speedCancelled = false;
  $('#view-speed [data-run]').disabled = true;
  $('#view-speed [data-cancel]').hidden = false;
  setStatus('speed', 'running', `Running 1/${runs.length}…`);
  progress.hidden = false;
  progress.innerHTML = runs
    .map((r, i) => `<div class="run-line" id="speed-line-${i}"><span>${esc(r.title)} · ${esc(r.callingAe)}</span><span class="rate">waiting…</span></div>`)
    .join('');

  const results = [];
  for (let i = 0; i < runs.length; i++) {
    if (speedCancelled) break;
    setStatus('speed', 'running', `Running ${i + 1}/${runs.length}…`);
    const line = $(`#speed-line-${i} .rate`);
    if (line) line.textContent = 'sending…';

    const { code, stdout, stderr } = await runCapture('speed', speedArgv(runs[i]));
    let data = null;
    try {
      data = JSON.parse(stdout);
    } catch {
      appendConsole('speed', `\n--- ${runs[i].title} ---\n${stdout || stderr}\n`, 'stderr');
    }
    results.push({ run: runs[i], data, code });

    if (line) {
      line.textContent = data
        ? `${data.megabytesPerSecond} MB/s · ${(data.elapsedMs / 1000).toFixed(2)}s`
        : `failed (exit ${code})`;
    }
    const parent = $(`#speed-line-${i}`);
    if (parent) parent.classList.add('done');
  }

  $('#view-speed [data-run]').disabled = false;
  $('#view-speed [data-cancel]').hidden = true;
  const anyOk = results.some((r) => r.data && r.data.ok);
  setStatus('speed', anyOk ? 'ok' : 'fail', speedCancelled ? 'Stopped' : (anyOk ? 'Done' : 'Failed'));
  renderSpeedResults(results);
}

// --------------------------------------------------------------------------
// View: WEB PING (DICOMweb connectivity)
// --------------------------------------------------------------------------
BUILDERS.webping = () => {
  const argv = ['web', 'ping'];
  if (state.web.url) argv.push('--url', state.web.url);
  const t = $('#webping-timeout').value.trim();
  if (t) argv.push('--timeout', t);
  return argv;
};

function wireWebping() {
  $('#webping-timeout').addEventListener('input', updateAllPreviews);
  $('#view-webping [data-run]').addEventListener('click', async () => {
    clearConsole('webping');
    if (!state.web.url) { appendConsole('webping', 'Fill in the server URL.\n', 'stderr'); return; }
    setStatus('webping', 'running', 'Testing…');
    const { code } = await runStreaming('webping', BUILDERS.webping());
    setStatus('webping', code === 0 ? 'ok' : 'fail', code === 0 ? 'Reachable' : 'Failed');
  });
}

// --------------------------------------------------------------------------
// View: WEB SEND (STOW-RS)
// --------------------------------------------------------------------------
BUILDERS.websend = () => {
  const argv = ['web', 'send'];
  const folder = $('#websend-folder').value.trim();
  if (folder) argv.push(folder);
  if (state.web.url) argv.push('--url', state.web.url);
  const chunk = $('#websend-chunk').value.trim();
  if (chunk) argv.push('--chunk', chunk);
  const retry = $('#websend-retry').value.trim();
  if (retry !== '') argv.push('--retry', retry);
  const timeout = $('#websend-timeout').value.trim();
  if (timeout) argv.push('--timeout', timeout);
  if ($('#websend-dryrun').checked) argv.push('--dry-run');
  return argv;
};

function wireWebsend() {
  ['websend-folder', 'websend-chunk', 'websend-retry', 'websend-timeout'].forEach((id) =>
    $(`#${id}`).addEventListener('input', updateAllPreviews));
  $('#websend-dryrun').addEventListener('change', updateAllPreviews);

  $('#view-websend [data-run]').addEventListener('click', async () => {
    const folder = $('#websend-folder').value.trim();
    clearConsole('websend');
    if (!folder) { appendConsole('websend', 'Choose a folder to send.\n', 'stderr'); return; }
    if (!state.web.url) { appendConsole('websend', 'Fill in the server URL.\n', 'stderr'); return; }
    setStatus('websend', 'running', 'Sending…');
    $('#view-websend [data-run]').disabled = true;
    const { code } = await runStreaming('websend', BUILDERS.websend());
    $('#view-websend [data-run]').disabled = false;
    setStatus('websend', code === 0 ? 'ok' : 'fail', code === 0 ? 'Complete' : 'Failed');
  });
}

// --------------------------------------------------------------------------
// View: WEB QUERY (QIDO-RS)
// --------------------------------------------------------------------------
function webQueryLevel() {
  const active = $('#webquery-level .chip.active');
  return active ? active.dataset.level : 'studies';
}

BUILDERS.webquery = () => {
  const argv = ['web', 'query'];
  const pairs = [
    ['PatientID', $('#webquery-patientid').value.trim()],
    ['PatientName', $('#webquery-patientname').value.trim()],
    ['StudyDate', $('#webquery-studydate').value.trim()],
    ['StudyInstanceUID', $('#webquery-studyuid').value.trim()],
  ];
  for (const [k, v] of pairs) if (v) argv.push(`${k}=${v}`);
  if (state.web.url) argv.push('--url', state.web.url);
  const level = webQueryLevel();
  if (level === 'series') argv.push('--series');
  else if (level === 'instances') argv.push('--instances');
  const limit = $('#webquery-limit').value.trim();
  if (limit) argv.push('--limit', limit);
  return argv;
};

/** Union-of-keys table over QIDO matches, same shape as renderFindResults. */
function renderWebQueryResults(json) {
  const box = $('#view-webquery [data-result]');
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  if (!matches.length) {
    box.hidden = false;
    box.innerHTML = '<div class="empty-note">0 matches. (Exit code 1 on zero matches is the CLI convention — the server answered; nothing matched.)</div>';
    return;
  }
  const cols = [];
  for (const m of matches) for (const k of Object.keys(m)) if (!cols.includes(k)) cols.push(k);
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = matches.map((m) =>
    `<tr>${cols.map((c) => `<td class="mono">${esc(m[c] ?? '')}</td>`).join('')}</tr>`).join('');
  box.hidden = false;
  box.innerHTML = `<div class="section-title">${matches.length} match(es)</div><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function wireWebquery() {
  for (const chip of $$('#webquery-level .chip')) {
    chip.addEventListener('click', () => {
      $$('#webquery-level .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      updateAllPreviews();
    });
  }
  ['webquery-patientid', 'webquery-patientname', 'webquery-studydate', 'webquery-studyuid', 'webquery-limit']
    .forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));

  $('#view-webquery [data-run]').addEventListener('click', async () => {
    clearConsole('webquery');
    $('#view-webquery [data-result]').hidden = true;
    if (!state.web.url) { appendConsole('webquery', 'Fill in the server URL.\n', 'stderr'); return; }
    setStatus('webquery', 'running', 'Querying…');
    const { code, stdout, stderr } = await runCapture('webquery', [...BUILDERS.webquery(), '--json']);

    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* raw fallback below */ }
    const matches = parsed && Array.isArray(parsed.matches) ? parsed.matches : null;

    // Exit code 1 with count 0 is the CLI's "no matches" convention, not an
    // app error — a reachable server that found nothing is still a good run.
    const ok = code === 0 || (code === 1 && parsed && parsed.count === 0);
    setStatus('webquery', ok ? 'ok' : 'fail', ok ? 'Done' : 'Failed');

    if (matches) {
      renderWebQueryResults(parsed);
    } else {
      const c = consoleEl('webquery'); c.hidden = false;
      appendConsole('webquery', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
    }
  });
}

// --------------------------------------------------------------------------
// View: WEB HUB (serve)
// --------------------------------------------------------------------------
BUILDERS.webhub = () => {
  const argv = ['web', 'serve'];
  const port = $('#webhub-port').value.trim();
  if (port) argv.push('--port', port);
  const persist = $('#webhub-persist').value.trim();
  if (persist) argv.push('--persist', persist);
  const root = $('#webhub-root').value.trim();
  if (root) argv.push('--root', root);
  const token = $('#webhub-token').value.trim();
  if (token) argv.push('--require-token', token);
  const reject = $('#webhub-rejectafter').value.trim();
  if (reject) argv.push('--reject-after', reject);
  return argv;
};

function wireWebhub() {
  // The hub IS the server, so it has no Base URL field — but the other Web
  // screens need one. Show the address to point them at, built from the port
  // as it is typed, and offer it as one click into the shared web panel.
  const showBaseUrl = () => {
    const port = $('#webhub-port').value.trim();
    const hint = $('#webhub-baseurl');
    if (!port) {
      hint.textContent = 'Choose a port; the address to point clients at appears here.';
      return;
    }
    const url = `http://127.0.0.1:${port}`;
    hint.innerHTML = `Clients point at <code>${esc(url)}</code> — <button class="linklike" id="webhub-use">use it on the other Web screens</button>`;
    $('#webhub-use').addEventListener('click', () => {
      state.web.url = url;
      syncWebInputs();
      updateAllPreviews();
    });
  };

  ['webhub-port', 'webhub-persist', 'webhub-root', 'webhub-token', 'webhub-rejectafter'].forEach((id) =>
    $(`#${id}`).addEventListener('input', updateAllPreviews));
  $('#webhub-port').addEventListener('input', showBaseUrl);
  showBaseUrl();

  $('#view-webhub [data-run]').addEventListener('click', async () => {
    clearConsole('webhub');
    const port = $('#webhub-port').value.trim();
    if (!port) { appendConsole('webhub', 'Choose a port to listen on.\n', 'stderr'); return; }
    setStatus('webhub', 'running', 'Listening');
    $('#view-webhub [data-run]').disabled = true;
    $('#view-webhub [data-cancel]').hidden = false;
    const { code } = await runStreaming('webhub', BUILDERS.webhub());
    // Only reached when the hub stops.
    $('#view-webhub [data-run]').disabled = false;
    $('#view-webhub [data-cancel]').hidden = true;
    setStatus('webhub', code === 0 ? 'ok' : 'fail', 'Stopped');
  });

  $('#view-webhub [data-cancel]').addEventListener('click', () => {
    const id = state.activeRuns.webhub;
    if (id) window.dcm.cancel(id);
  });
}

// --------------------------------------------------------------------------
// View: INVENTORY (info)
// --------------------------------------------------------------------------
BUILDERS.inventory = () => {
  const argv = ['info'];
  const t = $('#info-folder').value.trim();
  if (t) argv.push(t);
  if ($('#info-series').checked) argv.push('--series');
  if ($('#info-norecurse').checked) argv.push('--no-recurse');
  return argv;
};

function renderInventory(j) {
  const box = $('#view-inventory [data-result]');
  const tiles = [
    ['files examined', j.filesExamined],
    ['DICOM instances', j.dicomInstances],
    ['studies', Array.isArray(j.studies) ? j.studies.length : 0],
    ['total size', humanBytes(j.totalBytes)],
  ];
  if (j.unreadable) tiles.push(['unreadable', j.unreadable, 'warn']);
  if (j.ignored) tiles.push(['non-DICOM', j.ignored]);

  let html = '<div class="tiles">' + tiles.map(([lbl, num, cls]) =>
    `<div class="tile ${cls || ''}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join('') + '</div>';

  for (const s of j.studies || []) {
    const seenSeries = new Map();
    (s.series || []).forEach((se) => seenSeries.set(se.seriesInstanceUid, (seenSeries.get(se.seriesInstanceUid) || 0) + 1));
    html += `<div class="study-card">
      <h3>${esc(s.studyDescription || 'Study')} ${s.patientId ? `· ${esc(s.patientId)}` : ''}</h3>
      <div class="uid">${esc(s.studyInstanceUid)}</div>
      <div class="study-meta">
        <span><b>${(s.modalities || []).join(', ') || '—'}</b> modality</span>
        <span><b>${s.seriesCount ?? (s.series ? s.series.length : '—')}</b> series</span>
        <span><b>${s.instanceCount ?? '—'}</b> instances</span>
        <span><b>${humanBytes(s.bytes)}</b></span>
        <span>${s.studyDate ? `date <b>${esc(s.studyDate)}</b>` : ''}</span>
        <span>~<b>${s.associationsAtChunkSize ?? '—'}</b> association(s)</span>
      </div>`;
    if (s.series && s.series.length) {
      const rows = s.series.map((se) => {
        const collide = seenSeries.get(se.seriesInstanceUid) > 1;
        return `<tr>
          <td>${se.seriesNumber ?? '—'}</td>
          <td><span class="pill ${se.modality === 'CT' ? 'ct' : ''}">${esc(se.modality || '?')}</span></td>
          <td>${esc(se.seriesDescription || '')}</td>
          <td>${se.instanceCount}</td>
          <td>${humanBytes(se.bytes)}</td>
          <td class="mono">${esc(se.seriesInstanceUid)}${collide ? ' <span class="collision">⚠ colliding UID</span>' : ''}</td>
        </tr>`;
      }).join('');
      html += `<table><thead><tr><th>#</th><th>Modality</th><th>Description</th><th>Instances</th><th>Size</th><th>Series UID</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    html += '</div>';
  }
  box.hidden = false;
  box.innerHTML = html;
}

function wireInventory() {
  $('#info-folder').addEventListener('input', updateAllPreviews);
  ['info-series', 'info-norecurse'].forEach((id) => $(`#${id}`).addEventListener('change', updateAllPreviews));
  $('#view-inventory [data-run]').addEventListener('click', async () => {
    const t = $('#info-folder').value.trim();
    $('#view-inventory [data-result]').hidden = true;
    const c = consoleEl('inventory'); c.hidden = true; c.textContent = '';
    if (!t) { appendConsole('inventory', 'Choose a folder or file.\n', 'stderr'); return; }
    setStatus('inventory', 'running', 'Reading…');
    const { code, stdout, stderr } = await runCapture('inventory', [...BUILDERS.inventory(), '--json']);
    setStatus('inventory', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try { renderInventory(JSON.parse(stdout)); }
    catch { appendConsole('inventory', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr'); }
  });
}

// --------------------------------------------------------------------------
// View: TAGS
// --------------------------------------------------------------------------
BUILDERS.tags = () => {
  const argv = ['tags'];
  const t = $('#tags-target').value.trim();
  if (t) argv.push(t);
  const filter = $('#tags-filter').value.trim();
  const value = $('#tags-value').value.trim();
  if (filter) argv.push('--filter', filter);
  if (value) argv.push('--value', value);
  if ($('#tags-private').checked) argv.push('--private');
  if ($('#tags-all').checked) argv.push('--all');
  return argv;
};

function renderTags(j) {
  const box = $('#view-tags [data-result]');
  const results = Array.isArray(j?.results) ? j.results : [];
  if (!results.length) { box.hidden = false; box.innerHTML = '<div class="empty-note">No matching tags.</div>'; return; }
  let html = `<div class="section-title">${j.files} file(s), ${j.tags} tag(s)</div>`;
  for (const r of results) {
    const rows = (r.tags || []).map((t) =>
      `<tr><td class="mono">${esc(t.tag)}</td><td>${esc(t.vr)}</td><td>${esc(t.keyword)}${t.private ? ' <span class="pill">priv</span>' : ''}</td><td class="mono">${esc(t.value)}</td></tr>`).join('');
    html += `<div class="study-card"><div class="uid">${esc(r.path)}</div>
      <table><thead><tr><th>Tag</th><th>VR</th><th>Keyword</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  box.hidden = false;
  box.innerHTML = html;
}

function wireTags() {
  ['tags-target', 'tags-filter', 'tags-value'].forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));
  ['tags-private', 'tags-all'].forEach((id) => $(`#${id}`).addEventListener('change', updateAllPreviews));
  $('#view-tags [data-run]').addEventListener('click', async () => {
    const t = $('#tags-target').value.trim();
    $('#view-tags [data-result]').hidden = true;
    const c = consoleEl('tags'); c.hidden = true; c.textContent = '';
    if (!t) { appendConsole('tags', 'Choose a file or folder.\n', 'stderr'); return; }
    setStatus('tags', 'running', 'Reading…');
    const { code, stdout, stderr } = await runCapture('tags', [...BUILDERS.tags(), '--json']);
    setStatus('tags', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try { renderTags(JSON.parse(stdout)); }
    catch { appendConsole('tags', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr'); }
  });
}

// --------------------------------------------------------------------------
// View: EDIT (load tags, edit in place, write a copy)
// --------------------------------------------------------------------------
/** Tags loaded from the chosen study/file, plus the user's pending changes. */
const editState = {
  tags: [],          // [{tag, vr, keyword, value}]
  changes: new Map(), // keyword -> new value
  removals: new Set(),// keyword
  loadedPath: '',
  scope: 'study',
};

/** UIDs are structural; changing them is gated behind --force for good reason. */
const UID_KEYWORDS = new Set([
  'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID',
  'FrameOfReferenceUID', 'MediaStorageSOPInstanceUID',
]);

function editScope() {
  const active = $('#edit-scope-row .chip.active');
  return active ? active.dataset.scope : 'study';
}

BUILDERS.edit = () => {
  const argv = ['edit'];
  const target = $('#edit-target').value.trim();
  if (target) argv.push(target);
  for (const [keyword, value] of editState.changes) argv.push('--set', `${keyword}=${value}`);
  for (const keyword of editState.removals) argv.push('--remove', keyword);
  const out = $('#edit-out').value.trim();
  if (out) argv.push('--out', out);
  if (editScope() === 'one') argv.push('--no-recurse');
  if ($('#edit-dryrun').checked) argv.push('--dry-run');
  if ($('#edit-force').checked) argv.push('--force');
  return argv;
};

/** Draws the editable grid from editState.tags, filtered by the search box. */
function renderTagEditor() {
  const grid = $('#edit-grid');
  const needle = $('#edit-filter').value.trim().toLowerCase();

  const visible = editState.tags.filter((t) => {
    if (!needle) return true;
    return (
      (t.keyword || '').toLowerCase().includes(needle) ||
      (t.tag || '').toLowerCase().includes(needle) ||
      String(t.value ?? '').toLowerCase().includes(needle)
    );
  });

  const head =
    '<div class="tag-row head"><div>Tag</div><div>Keyword</div><div>Value</div><div>Remove</div></div>';

  const rows = visible.map((t) => {
    const kw = t.keyword;
    const changed = editState.changes.has(kw);
    const removing = editState.removals.has(kw);
    const value = changed ? editState.changes.get(kw) : (t.value ?? '');
    const isUid = UID_KEYWORDS.has(kw);
    return `<div class="tag-row ${changed ? 'changed' : ''} ${removing ? 'removing' : ''}" data-kw="${esc(kw)}">
      <div class="tg">${esc(t.tag)}</div>
      <div class="kw">${esc(kw)}${isUid ? ' <span class="pill">UID</span>' : ''}</div>
      <div><input type="text" class="tag-val" value="${esc(value)}" ${removing ? 'disabled' : ''} /></div>
      <div><label class="rm"><input type="checkbox" class="tag-rm" ${removing ? 'checked' : ''} /> remove</label></div>
    </div>`;
  }).join('');

  grid.innerHTML = head + (rows || '<div class="empty-note" style="padding:14px">No tags match that filter.</div>');

  for (const row of $$('.tag-row[data-kw]', grid)) {
    const kw = row.dataset.kw;
    const original = editState.tags.find((t) => t.keyword === kw);

    $('.tag-val', row).addEventListener('input', (e) => {
      const v = e.target.value;
      // Only record a change when it actually differs from what was loaded —
      // otherwise every field touched would be rewritten needlessly.
      if (v === String(original?.value ?? '')) editState.changes.delete(kw);
      else editState.changes.set(kw, v);
      row.classList.toggle('changed', editState.changes.has(kw));
      renderPending();
      updateAllPreviews();
    });

    $('.tag-rm', row).addEventListener('change', (e) => {
      if (e.target.checked) {
        editState.removals.add(kw);
        editState.changes.delete(kw);
      } else {
        editState.removals.delete(kw);
      }
      renderTagEditor();
      renderPending();
      updateAllPreviews();
    });
  }
}

/** One-line summary of what will happen, so nothing is applied blind. */
function renderPending() {
  const box = $('#edit-pending');
  const n = editState.changes.size;
  const r = editState.removals.size;
  if (!n && !r) { box.hidden = true; return; }

  const scopeText = editScope() === 'one'
    ? 'the loaded file only'
    : 'every instance in the study';
  const bits = [];
  if (n) bits.push(`<b>${n}</b> tag${n === 1 ? '' : 's'} changed`);
  if (r) bits.push(`<b>${r}</b> removed`);
  box.hidden = false;
  box.innerHTML = `${bits.join(' · ')} — will apply to ${scopeText}.`;
}

async function loadTagsForEditing() {
  const target = $('#edit-target').value.trim();
  clearConsole('edit');
  if (!target) {
    appendConsole('edit', 'Choose a study folder or a .dcm file first.\n', 'stderr');
    return;
  }

  setStatus('edit', 'running', 'Loading…');
  // One representative file is what we edit against: a study shares its tag
  // structure, and dumping every instance would be slow and unreadable.
  const { code, stdout, stderr } = await runCapture('edit', ['tags', target, '--json']);
  setStatus('edit', code === 0 ? 'ok' : 'fail', code === 0 ? 'Loaded' : 'Failed');

  if (code !== 0) {
    appendConsole('edit', stdout || stderr || 'Could not read tags.\n', 'stderr');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    appendConsole('edit', stdout || 'Unexpected output.\n', 'stderr');
    return;
  }

  const first = (parsed.results || [])[0];
  if (!first) {
    appendConsole('edit', 'No DICOM instances found there.\n', 'stderr');
    return;
  }

  // Only tags with a real keyword can be addressed by name on the command line.
  editState.tags = (first.tags || []).filter((t) => t.keyword && !/^\(/.test(t.keyword));
  editState.changes.clear();
  editState.removals.clear();
  editState.loadedPath = first.path || target;

  $('#edit-scope-row').hidden = false;
  $('#edit-loaded').hidden = false;
  $('#edit-filter').value = '';
  renderTagEditor();
  renderPending();
  updateAllPreviews();

  appendConsole('edit', `Loaded ${editState.tags.length} tags from ${editState.loadedPath}\n`, 'stdout');
}

function wireEdit() {
  $('#edit-load').addEventListener('click', loadTagsForEditing);
  $('#edit-filter').addEventListener('input', renderTagEditor);
  ['edit-target', 'edit-out'].forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));
  ['edit-dryrun', 'edit-force'].forEach((id) => $(`#${id}`).addEventListener('change', updateAllPreviews));

  for (const chip of $$('#edit-scope-row .chip')) {
    chip.addEventListener('click', () => {
      $$('#edit-scope-row .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderPending();
      updateAllPreviews();
    });
  }

  $('#view-edit [data-run]').addEventListener('click', async () => {
    clearConsole('edit');
    const target = $('#edit-target').value.trim();
    const out = $('#edit-out').value.trim();

    if (!target) { appendConsole('edit', 'Choose a source folder or file.\n', 'stderr'); return; }
    if (!editState.changes.size && !editState.removals.size) {
      appendConsole('edit', 'Nothing to apply — change a value or tick a tag to remove.\n', 'stderr');
      return;
    }
    if (!out) { appendConsole('edit', 'Choose where to write the edited copy.\n', 'stderr'); return; }

    const touchingUid = [...editState.changes.keys(), ...editState.removals]
      .some((kw) => UID_KEYWORDS.has(kw));
    if (touchingUid && !$('#edit-force').checked) {
      appendConsole('edit',
        'That includes a UID, which is refused unless you tick "Allow editing UIDs".\n' +
        'Rewriting UIDs on some instances and not others splits a study. To get fresh\n' +
        'UIDs across a whole study consistently, use De-identify instead.\n', 'stderr');
      return;
    }

    setStatus('edit', 'running', $('#edit-dryrun').checked ? 'Previewing…' : 'Writing…');
    const { code } = await runStreaming('edit', BUILDERS.edit());
    setStatus('edit', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
  });
}

// --------------------------------------------------------------------------
// View: ANON
// --------------------------------------------------------------------------
BUILDERS.anon = () => {
  const argv = ['anon'];
  const f = $('#anon-folder').value.trim();
  if (f) argv.push(f);
  const out = $('#anon-out').value.trim();
  if (out) argv.push('--out', out);
  const prefix = $('#anon-prefix').value.trim();
  if (prefix) argv.push('--prefix', prefix);
  if ($('#anon-keepdesc').checked) argv.push('--keep-descriptions');
  if ($('#anon-keepprivate').checked) argv.push('--keep-private');
  return argv;
};

function wireAnon() {
  ['anon-folder', 'anon-out', 'anon-prefix'].forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));
  ['anon-keepdesc', 'anon-keepprivate'].forEach((id) => $(`#${id}`).addEventListener('change', updateAllPreviews));
  $('#view-anon [data-run]').addEventListener('click', async () => {
    clearConsole('anon');
    const f = $('#anon-folder').value.trim();
    const out = $('#anon-out').value.trim();
    if (!f) { appendConsole('anon', 'Choose a folder to de-identify.\n', 'stderr'); return; }
    if (!out) { appendConsole('anon', 'Choose an output folder.\n', 'stderr'); return; }
    setStatus('anon', 'running', 'De-identifying…');
    const { code } = await runStreaming('anon', BUILDERS.anon());
    setStatus('anon', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
  });
}

// --------------------------------------------------------------------------
// Path pickers / reveal
// --------------------------------------------------------------------------
function wirePickers() {
  for (const btn of $$('[data-pick]')) {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.pick;
      const mode = btn.dataset.pickMode || 'folder';
      const res = await window.dcm.pick({ mode, defaultPath: state.info.home });
      if (res && res.path) {
        $(`#${targetId}`).value = res.path;
        updateAllPreviews();
      }
    });
  }
  for (const btn of $$('[data-reveal]')) {
    btn.addEventListener('click', async () => {
      const val = $(`#${btn.dataset.reveal}`).value.trim();
      if (val) await window.dcm.reveal(val);
    });
  }
}

// --------------------------------------------------------------------------
// Copy affordances + MCP screen
// --------------------------------------------------------------------------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function flash(el, cls = 'copied') {
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1100);
}

function wireCopy() {
  // Click a command preview to copy the command.
  document.addEventListener('click', async (e) => {
    const cmd = e.target.closest('.cmd-preview');
    if (cmd && cmd.textContent.trim()) {
      if (await copyText(cmd.textContent.replace(/^\$\s*/, ''))) flash(cmd);
      return;
    }
    const box = e.target.closest('.copy-box');
    if (box) {
      const text = box.getAttribute('data-copy') || '';
      if (await copyText(text)) {
        const btn = box.querySelector('.btn');
        if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; flash(btn); setTimeout(() => (btn.textContent = t), 1100); }
      }
    }
  });
}

async function checkMcpStatus() {
  // Probe whether `dcm mcp` is runnable from PATH by asking the engine (which we
  // already run) for its version; if that works, the same command backs `dcm mcp`.
  const el = $('#mcp-status');
  const txt = $('#mcp-status-text');
  try {
    if (state.info && state.info.version) {
      el.className = 'mcp-status ok';
      txt.innerHTML = `Ready — this app runs engine <code>v${esc(state.info.version)}</code>. Once <code>dcm</code> is on your PATH, the commands below connect Claude to it.`;
    } else {
      el.className = 'mcp-status bad';
      txt.textContent = 'Engine not detected.';
    }
  } catch {
    el.className = 'mcp-status bad';
    txt.textContent = 'Engine not detected.';
  }
}

/** Ctrl/Cmd+Enter runs the active view's primary action. */
// --------------------------------------------------------------------------
// Info icons — one handler for every circled-i in the app
// --------------------------------------------------------------------------
/**
 * One short line stays on screen; the reasoning behind it opens as a block
 * directly under that line.
 *
 * Deliberately a block and not a floating popover. These explanations run to
 * 40-90 words, and at this column width a popover wide enough to hold one
 * would cover the very rows it is explaining and would need edge-collision
 * code against the page, the capped table scroll and the panel — measurement
 * logic this renderer has no business growing. A block cannot be clipped and
 * cannot cover data.
 *
 * Warnings that matter when they arise are never put in here: the mismatch
 * choice, the folder verdicts, the missing Type 1 notes and every failed
 * outcome stay inline.
 */
function infoBtnFor(pop) {
  return $(`.info-btn[aria-controls="${pop.id}"]`);
}

function closeInfo(pop, focusBtn = false) {
  pop.hidden = true;
  const btn = infoBtnFor(pop);
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) btn.focus();
  }
}

function closeAllInfo(except) {
  for (const p of $$('.info-pop:not([hidden])')) if (p !== except) closeInfo(p);
}

function wireInfo() {
  document.addEventListener('click', (e) => {
    // A click inside an open explanation is someone reading or selecting it.
    if (e.target.closest('.info-pop')) return;
    const btn = e.target.closest('.info-btn');
    if (!btn) { closeAllInfo(); return; }
    // The icons inside a <label class="choice"> and inside a <summary> would
    // otherwise pick the radio / toggle the disclosure on the way past.
    e.preventDefault();
    e.stopPropagation();
    const pop = document.getElementById(btn.getAttribute('aria-controls'));
    if (!pop) return;
    const opening = pop.hidden;
    closeAllInfo(pop); // only one open at a time, so layout grows by one block
    pop.hidden = !opening;
    btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.info-pop:not([hidden])');
    if (!open.length) return;
    e.stopPropagation();
    open.forEach((p, i) => closeInfo(p, i === 0));
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const active = $('.view.active');
      const run = active && active.querySelector('[data-run]:not([disabled])');
      if (run) { run.click(); e.preventDefault(); }
    }
  });
}

// --------------------------------------------------------------------------
// Updates
// --------------------------------------------------------------------------
/**
 * Renders the update banner in the sidebar footer. Self-updating builds go
 * idle -> downloading -> ready ("Restart & update"); builds that cannot swap
 * themselves (portable exe, unsigned macOS) go idle -> available ("Download",
 * which opens the releases page). Errors stay silent — a failed background
 * check is not worth a banner.
 */
/** True on packaged builds, where the manual check link makes sense. */
let updateCheckEligible = false;

function renderUpdateState(s) {
  const banner = $('#update-banner');
  const text = $('#update-text');
  const action = $('#update-action');
  if (!banner || !s) return;

  const label = s.version ? `v${s.version}` : 'update';
  let visible = true;
  if (s.status === 'downloading') {
    action.hidden = true;
    text.textContent = `Downloading ${label}… ${s.percent || 0}%`;
  } else if (s.status === 'ready') {
    text.textContent = `Update ${label} is ready.`;
    action.textContent = 'Restart & update';
    action.hidden = false;
    action.onclick = () => window.dcm.update.install();
  } else if (s.status === 'available') {
    text.textContent = `${label} is available.`;
    action.textContent = 'Download';
    action.hidden = false;
    action.onclick = () => window.dcm.update.openReleases();
  } else {
    visible = false;
  }
  banner.hidden = !visible;

  // The check link and the banner are alternatives: the link hides while the
  // banner is up and comes back reset whenever the banner goes away (say, a
  // download failed), so there is always a live way to re-trigger a check.
  const check = $('#update-check');
  if (check && updateCheckEligible) {
    check.hidden = visible;
    if (!visible) {
      check.disabled = false;
      check.textContent = 'Check for updates';
    }
  }
}

async function wireUpdates() {
  updateCheckEligible = Boolean(state.info.packaged);
  window.dcm.update.onStatus(renderUpdateState);
  renderUpdateState(await window.dcm.update.state());

  // Manual "check now", so nobody has to wait out the 4-hour timer to know.
  // Dev runs have no update source, so the link only appears when packaged.
  const check = $('#update-check');
  if (updateCheckEligible && check) {
    check.addEventListener('click', async () => {
      check.disabled = true;
      check.textContent = 'Checking…';
      const r = await window.dcm.update.check();
      if (r && r.update) {
        // The status events take over: the banner appears and
        // renderUpdateState hides and resets this link.
        return;
      }
      check.textContent = r && r.error ? 'Check failed — will retry later' : 'Up to date';
      setTimeout(() => {
        check.textContent = 'Check for updates';
        check.disabled = false;
      }, 4000);
    });
  }

  // One-time "you were just updated" notice after a version change.
  const wn = await window.dcm.update.whatsnew();
  if (wn && wn.to) {
    const banner = $('#whatsnew-banner');
    $('#whatsnew-text').textContent = `Updated to v${wn.to}.`;
    banner.hidden = false;
    $('#whatsnew-open').addEventListener('click', () => window.dcm.update.openReleases(wn.to));
    $('#whatsnew-dismiss').addEventListener('click', () => {
      banner.hidden = true;
      window.dcm.update.whatsnewAck();
    });
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function boot() {
  state.info = await window.dcm.info();
  $('#engine-version').textContent = `engine v${state.info.version}`;

  $$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  await loadProfiles();
  mountConnectionPanels();
  mountWebPanels();

  wireInfo();
  wireEcho();
  wireSend();
  wireReceive();
  wireQuery();
  wireWorklist();
  wireMpps();
  wireSteps();
  wireSpeed();
  wireWebping();
  wireWebsend();
  wireWebquery();
  wireWebhub();
  wireInventory();
  wireTags();
  wireEdit();
  wireAnon();
  wirePickers();
  wireCopy();
  wireKeyboard();
  wireUpdates();
  checkMcpStatus();

  updateAllPreviews();
}

boot();
