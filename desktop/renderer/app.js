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

  // The last `mpps perform` this app ran. Kept separately from the selection so
  // the outcome keeps naming its own study after a re-query clears the picker.
  mpps: { lastRun: null },
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
// Console output
// --------------------------------------------------------------------------
function consoleEl(view) {
  return $(`#view-${view} [data-console]`);
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
  const chip = $(`#view-${view} [data-status]`);
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
  const el = $(`#view-${view} [data-cmd]`);
  if (el) el.textContent = 'dcm ' + argv.map(quoteArg).join(' ');
}

const BUILDERS = {}; // view -> () => argv

function updateAllPreviews() {
  for (const [view, build] of Object.entries(BUILDERS)) {
    try { setPreview(view, build()); } catch { /* partial form */ }
  }
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

/** Renders worklist matches as a scheduling table. */
function renderWorklist(json) {
  const box = $('#view-worklist [data-result]');
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  box.hidden = false;

  // A fetch replaces the list, so any previous pick is gone with it. Carrying a
  // selection across queries would mean showing attributes the SCP did not just
  // return, which is exactly the kind of stale local state this screen avoids.
  state.mwl.matches = matches;
  clearWorklistSelection();

  if (!matches.length) {
    box.innerHTML =
      '<div class="empty-note">No scheduled procedures matched.<br>' +
      'That can be a genuinely empty worklist, a date with nothing scheduled, ' +
      'or an AE Title the SCP does not answer for. Try <b>Any date</b> with no ' +
      'other filters to see whether the SCP returns anything at all.</div>';
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

  const rows = matches.map((m, i) => `<tr class="pick-row" data-idx="${i}" tabindex="0" role="button" aria-pressed="false">
      <td class="pick-cell"><span class="pick-dot"></span></td>
      <td class="when">${esc(fmtDate(m.ScheduledProcedureStepStartDate))} ${esc(fmtTime(m.ScheduledProcedureStepStartTime))}</td>
      <td><span class="pill ${m.Modality === 'CT' ? 'ct' : ''}">${esc(m.Modality || '?')}</span></td>
      <td>${esc(m.PatientName || '')}</td>
      <td class="mono">${esc(m.PatientID || '')}</td>
      <td class="mono">${esc(m.AccessionNumber || '')}</td>
      <td>${esc(m.ScheduledStationAETitle || '')}</td>
      <td>${esc(m.RequestedProcedureDescription || m.ScheduledProcedureStepDescription || '')}</td>
    </tr>`).join('');

  box.innerHTML =
    `<div class="section-title">${matches.length} scheduled procedure(s) — click one to perform it</div>` +
    '<table><thead><tr><th class="pick-cell"></th><th>Scheduled</th><th>Modality</th><th>Patient</th><th>Patient ID</th>' +
    '<th>Accession</th><th>Station AE</th><th>Procedure</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;
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

function selectWorklistRow(idx) {
  const item = state.mwl.matches[idx];
  if (!item) return;
  state.mwl.selectedIdx = idx;

  for (const tr of $$('#view-worklist [data-result] tr.pick-row')) {
    const on = Number(tr.dataset.idx) === idx;
    tr.classList.toggle('row-selected', on);
    tr.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const a = worklistAttrs(item);
  $('#mwl-attrs').innerHTML =
    attrCell('Patient', a.patientName) +
    attrCell('Patient ID', a.patientId) +
    attrCell('Accession', a.accessionNumber) +
    attrCell('Modality', a.modality) +
    attrCell('Scheduled step ID', a.scheduledStepId) +
    attrCell('Study Instance UID', a.studyInstanceUid);
  $('#mwl-selected').hidden = false;

  // Seed the two Type 1 fields the operator is allowed to correct. Re-seeding
  // on every selection is right: they describe the row that is now picked.
  const stepId = $('#mpps-stepid');
  stepId.value = a.scheduledStepId;
  delete stepId.dataset.touched;
  const desc = $('#mpps-stepdesc');
  desc.value = a.scheduledStepDescription || a.requestedProcedureDescription;
  delete desc.dataset.touched;

  renderMppsPanel();
  updateAllPreviews();
}

function clearWorklistSelection() {
  state.mwl.selectedIdx = null;
  for (const tr of $$('#view-worklist [data-result] tr.pick-row')) {
    tr.classList.remove('row-selected');
    tr.setAttribute('aria-pressed', 'false');
  }
  $('#mwl-selected').hidden = true;
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
  el.hidden = false;
  el.innerHTML = present
    ? `The study you performed (<code>${esc(uid)}</code>) <b>still matches this query.</b> ` +
      'That is not evidence the SCP refused anything: some SCPs keep a scheduled step visible ' +
      'after a performed step is reported, and this app cannot see the SCP\'s worklist rules.'
    : `The study you performed (<code>${esc(uid)}</code>) <b>no longer matches this query.</b> ` +
      'That is a correlation, not proof. An item can drop out of a query because of the date ' +
      'filter, the station AE or the SCP\'s own rules; all that has been re-read here is the query.';
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
    .forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));

  // Delegated, because the table's innerHTML is replaced on every fetch.
  const results = $('#view-worklist [data-result]');
  results.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.pick-row');
    if (tr) selectWorklistRow(Number(tr.dataset.idx));
  });
  results.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr.pick-row');
    if (!tr) return;
    e.preventDefault();
    selectWorklistRow(Number(tr.dataset.idx));
  });

  $('#mwl-clearsel').addEventListener('click', clearWorklistSelection);
  $('#mwl-perform').addEventListener('click', () => showView('mpps'));

  $('#view-worklist [data-run]').addEventListener('click', async () => {
    const miss = connMissing();
    $('#view-worklist [data-result]').hidden = true;
    const c = consoleEl('worklist'); c.hidden = true; c.textContent = '';
    if (miss.length) {
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
      appendConsole('worklist', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
    }
  });
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

  const chunk = $('#mpps-chunk').value.trim();
  if (chunk) argv.push('--chunk', chunk);
  const retry = $('#mpps-retry').value.trim();
  if (retry) argv.push('--retry', retry);
  const retrieveAe = $('#mpps-retrieveae').value.trim();
  if (retrieveAe) argv.push('--retrieve-ae', retrieveAe);
  const record = $('#mpps-record').value.trim();
  if (record) argv.push('--write-acknowledged', record);

  if ($('#mpps-norecurse').checked) argv.push('--no-recurse');
  if ($('#mpps-dryrun').checked) argv.push('--dry-run');
  return argv;
};

/** Shows either the "pick a row first" note or the form, and fills the form. */
function renderMppsPanel() {
  const a = worklistAttrs(selectedWorklistItem());
  $('#mpps-nosel').hidden = Boolean(a);
  $('#mpps-body').hidden = !a;
  if (!a) return;

  $('#mpps-attrs').innerHTML =
    attrCell('Patient', a.patientName) +
    attrCell('Patient ID', a.patientId) +
    attrCell('Patient birth date', a.patientBirthDate) +
    attrCell('Patient sex', a.patientSex) +
    attrCell('Accession', a.accessionNumber) +
    attrCell('Modality', a.modality) +
    attrCell('Scheduled step ID', a.scheduledStepId) +
    attrCell('Requested procedure ID', a.requestedProcedureId) +
    attrCell('Procedure', a.requestedProcedureDescription || a.scheduledStepDescription) +
    attrCell('Scheduled station AE', a.scheduledStationAe) +
    attrCell('Study Instance UID', a.studyInstanceUid);

  // Say what the engine will do about anything the SCP left out, rather than
  // quietly filling it in here.
  const notes = [];
  if (!a.studyInstanceUid) {
    notes.push('This row carries no <b>Study Instance UID</b>. It is Type 1 inside ' +
      'ScheduledStepAttributesSequence, and the engine will take it from the folder only if ' +
      'that folder holds exactly one study.');
  }
  if (!a.modality) {
    notes.push('This row carries no <b>Modality</b>. It is Type 1, and the engine will take it ' +
      'from the folder only if the folder holds exactly one.');
  }
  if (!$('#mpps-stepid').value.trim()) {
    notes.push('<b>Performed step ID</b> is Type 1 and there is no scheduled step ID to fall ' +
      'back on. The engine refuses the N-CREATE until it is filled in above.');
  }
  const note = $('#mpps-attr-note');
  note.innerHTML = notes.length
    ? notes.join(' ')
    : 'Every value above came back from the SCP in this query. Attributes not shown ' +
      '(start date and time) are taken at the moment the step is created.';
}

/**
 * Reads the engine's own report.
 *
 * Deliberately reads the printed report rather than re-deriving anything: the
 * counts and the status sentence shown here are the engine's words, so the app
 * cannot claim more than the transaction did.
 */
function parseMppsReport(text) {
  const t = stripAnsi(text);
  const num = (label) => {
    const m = new RegExp(`^ {2}${label} +(\\d+)`, 'm').exec(t);
    return m ? Number(m[1]) : null;
  };
  const statusMatch = /^step status +(\S+)/m.exec(t);
  const shortfall = /^\d+ of \d+ instances were acknowledged\.[\s\S]*?unaccounted for\./m.exec(t);
  return {
    status: statusMatch ? statusMatch[1] : null,
    found: num('found'),
    sent: num('sent'),
    acknowledged: num('acknowledged'),
    referenced: num('referenced in MPPS'),
    shortfall: shortfall ? shortfall[0].replace(/\s+/g, ' ') : null,
    stillInProgress: /the step is still IN PROGRESS/.test(t),
    neverOpened: /the procedure step was never opened/.test(t),
  };
}

function renderMppsTotals(r) {
  const box = $('#view-mpps [data-totals]');
  if (r.found == null) { box.hidden = true; box.classList.remove('show'); return; }
  const cell = (n, lbl, cls = '') =>
    `<div class="total-card ${cls}"><div class="num">${n ?? '—'}</div><div class="lbl">${lbl}</div></div>`;
  const complete = r.acknowledged != null && r.acknowledged === r.found;
  box.innerHTML =
    cell(r.found, 'found') +
    cell(r.sent, 'sent') +
    cell(r.acknowledged, 'acknowledged', complete ? 'ok' : 'fail') +
    cell(r.referenced, 'referenced in MPPS', complete ? 'ok' : 'fail');
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
      'No connection was opened, no procedure step was created and no images left this machine. ' +
      'PerformedSeriesSequence cannot be previewed: it is built from what the archive ' +
      'acknowledges, and nothing has been acknowledged.';
    setStatus('mpps', code === 0 ? 'ok' : 'fail', code === 0 ? 'Plan ready' : 'Scan failed');
    return;
  }

  if (report.status === 'COMPLETED' && code === 0) {
    box.className = 'outcome ok';
    box.innerHTML = '<span class="outcome-head">Step COMPLETED.</span>' +
      'Every instance found on disk was acknowledged by the archive and is referenced in the ' +
      'MPPS. <b>What the MPPS SCP does with the scheduled worklist entry is not visible from ' +
      'here</b> — re-query the worklist if you need to see whether it still matches.';
    setStatus('mpps', 'ok', 'COMPLETED');
    return;
  }

  box.className = 'outcome bad';
  let head = 'The step was not completed.';
  let body;
  if (report.status === 'DISCONTINUED') {
    head = 'Step DISCONTINUED — this is a failure.';
    body = (report.shortfall ? `${esc(report.shortfall)} ` : '') +
      'There is no override for this. COMPLETED asserts the work is fully accounted for, and ' +
      'the performed series above name only what the archive actually took. Resend the ' +
      'outstanding instances and open a new step, or find out why the archive refused them.';
  } else if (report.neverOpened) {
    head = 'N-CREATE failed — the step was never opened.';
    body = 'Nothing was sent. The images are untouched; the output above says why the MPPS peer ' +
      'refused. Fix the peer and run this again.';
  } else if (report.stillInProgress) {
    head = 'N-SET failed — the step is still IN PROGRESS on the peer.';
    body = 'The images were sent, but the closing N-SET did not land, so the step is open on the ' +
      'MPPS peer. Close it by hand with <b>dcm mpps complete</b> or <b>discontinue</b> once the ' +
      'peer is reachable — the command in the output above is the one to run.';
  } else {
    body = 'The engine exited ' + esc(String(code)) + ' without reporting a closed step. The ' +
      'output above is the whole story; nothing here is inferred beyond it.';
  }
  box.innerHTML = `<span class="outcome-head">${esc(head)}</span>${body}`;
  setStatus('mpps', 'fail', report.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'Failed');
}

function wireMpps() {
  const ids = [
    'mpps-folder', 'mpps-store-host', 'mpps-store-port', 'mpps-store-ae',
    'mpps-stepid', 'mpps-stationae', 'mpps-stepdesc',
    'mpps-chunk', 'mpps-retry', 'mpps-retrieveae', 'mpps-record',
  ];
  ids.forEach((id) => $(`#${id}`).addEventListener('input', updateAllPreviews));

  // Once either Type 1 field is edited by hand, stop overwriting it.
  ['mpps-stationae', 'mpps-stepid', 'mpps-stepdesc'].forEach((id) =>
    $(`#${id}`).addEventListener('input', (e) => { e.target.dataset.touched = '1'; }));

  // Filling in a missing Type 1 step ID should retire the warning about it.
  $('#mpps-stepid').addEventListener('input', renderMppsPanel);

  $('#mpps-store-same').addEventListener('change', updateAllPreviews);
  $('#mpps-norecurse').addEventListener('change', updateAllPreviews);
  $('#mpps-dryrun').addEventListener('change', () => {
    $('#view-mpps [data-run]').textContent = $('#mpps-dryrun').checked ? 'Dry run' : 'Perform step';
    updateAllPreviews();
  });

  $('#mpps-requery').addEventListener('click', () => {
    showView('worklist');
    $('#view-worklist [data-run]').click();
  });

  $('#view-mpps [data-cancel]').addEventListener('click', () => {
    const id = state.activeRuns.mpps;
    if (id) window.dcm.cancel(id);
  });

  $('#view-mpps [data-run]').addEventListener('click', async () => {
    const item = selectedWorklistItem();
    clearConsole('mpps');
    $('#mpps-outcome').hidden = true;
    $('#view-mpps [data-totals]').hidden = true;
    $('#mpps-after').hidden = true;

    if (!item) {
      appendConsole('mpps', 'Select a worklist row first.\n', 'stderr');
      return;
    }
    const folder = $('#mpps-folder').value.trim();
    if (!folder) {
      appendConsole('mpps', 'Choose the folder holding this study\'s images.\n', 'stderr');
      return;
    }

    const dryRun = $('#mpps-dryrun').checked;
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
          `Fill in the storage peer: ${storeMiss.join(', ')}. Both peers are named in full in ` +
          'the command, so neither can be left to a hidden default.\n', 'stderr');
        return;
      }
    }

    const argv = BUILDERS.mpps();
    const attrs = worklistAttrs(item);
    setStatus('mpps', 'running', dryRun ? 'Scanning…' : 'Performing…');
    $('#view-mpps [data-run]').disabled = true;
    if (!dryRun) $('#view-mpps [data-cancel]').hidden = false;

    const { code, stdout } = await runStreaming('mpps', argv);

    $('#view-mpps [data-run]').disabled = false;
    $('#view-mpps [data-cancel]').hidden = true;

    const report = parseMppsReport(stdout);
    if (!dryRun) {
      renderMppsTotals(report);
      // Recorded so the re-query can name the study it is looking for, even
      // after a fresh fetch clears the selection.
      state.mpps.lastRun = {
        studyInstanceUid: attrs.studyInstanceUid,
        status: report.status,
        code,
      };
      $('#mpps-after').hidden = false;
    }
    renderMppsOutcome({ code, report, dryRun });
  });

  renderMppsPanel();
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

  wireEcho();
  wireSend();
  wireReceive();
  wireQuery();
  wireWorklist();
  wireMpps();
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
