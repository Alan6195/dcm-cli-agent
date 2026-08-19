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
  profiles: [],
  info: { home: '', platform: '', version: '' },
  activeRuns: {}, // view -> runId (for cancel/stop)
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

function refreshProfileSelects() {
  for (const sel of $$('[data-profile-select]')) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— saved peers —</option>' +
      state.profiles.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    if (state.profiles.some((p) => p.name === current)) sel.value = current;
  }
}

function applyProfile(name) {
  const p = state.profiles.find((x) => x.name === name);
  if (!p) return;
  state.conn = { host: p.host || '', port: p.port || '', calledAe: p.calledAe || '', callingAe: p.callingAe || '' };
  syncConnInputs();
  updateAllPreviews();
}

async function saveCurrentProfile() {
  if (!state.conn.host && !state.conn.calledAe) return;
  const name = profileName(state.conn);
  const entry = { name, ...state.conn };
  const idx = state.profiles.findIndex((p) => p.name === name);
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
  state.profiles = state.profiles.filter((p) => p.name !== name);
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

  const rows = matches.map((m) => `<tr>
      <td class="when">${esc(fmtDate(m.ScheduledProcedureStepStartDate))} ${esc(fmtTime(m.ScheduledProcedureStepStartTime))}</td>
      <td><span class="pill ${m.Modality === 'CT' ? 'ct' : ''}">${esc(m.Modality || '?')}</span></td>
      <td>${esc(m.PatientName || '')}</td>
      <td class="mono">${esc(m.PatientID || '')}</td>
      <td class="mono">${esc(m.AccessionNumber || '')}</td>
      <td>${esc(m.ScheduledStationAETitle || '')}</td>
      <td>${esc(m.RequestedProcedureDescription || m.ScheduledProcedureStepDescription || '')}</td>
    </tr>`).join('');

  box.innerHTML =
    `<div class="section-title">${matches.length} scheduled procedure(s)</div>` +
    '<table><thead><tr><th>Scheduled</th><th>Modality</th><th>Patient</th><th>Patient ID</th>' +
    '<th>Accession</th><th>Station AE</th><th>Procedure</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;
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
    } catch {
      appendConsole('worklist', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
    }
  });
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

  wireEcho();
  wireSend();
  wireReceive();
  wireQuery();
  wireWorklist();
  wireSpeed();
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
