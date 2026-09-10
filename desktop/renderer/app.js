'use strict';

/**
 * AscendI DICOM — renderer.
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
  // Quotes too: saved peer names and URLs go into data- attributes.
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One of the four identity fields `dcm info` reports, as the scan found it.
 *
 * Each is reported as a pair: a singular that is a string only when every
 * instance carrying the field agrees, and a plural holding the distinct values
 * in the order the walk met them. The singular is null in two different
 * situations — the instances disagree, and no instance carries one — so
 * reading it alone turns a disagreement into an absence, and reading the first
 * instance's value (which is what the scan used to report) turns a
 * disagreement into a fact. Both are lies about a study, and this is the one
 * place either half is read, so neither can be told by accident.
 */
function identityState(study, one, many) {
  const values = Array.isArray(study[many]) ? study[many] : [];
  const value = typeof study[one] === 'string' ? study[one] : '';
  return { value, values, conflict: !value && values.length > 1 };
}

/** Every value of a disagreement, amber, never a count and never one of them. */
function identityClash(values) {
  return `<b class="collision">${values.map(esc).join(' / ')}</b>`;
}

/** Strip ANSI just in case; the engine runs with NO_COLOR but be defensive. */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Quote an argv element for display the way a shell would need it.
 *
 * `^` is in here because of what this text is for. The preview is copyable —
 * clicking it puts the line on the clipboard — and in cmd.exe `^` is the
 * escape character, so an unquoted `--set PatientName=DOE^JANE` pasted into a
 * Windows prompt arrives at the engine as `PatientName=DOEJANE`. A name
 * silently losing its separator is the worst shape that bug could take, and
 * quoting costs nothing anywhere else: `^` is ordinary in POSIX shells, and
 * the app itself spawns an argv array rather than a command line.
 */
function quoteArg(a) {
  return /[\s"^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
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

  // settings.json, normalised (see DEFAULT_SETTINGS). The station's AE Title,
  // the defaults every command inherits, rehearsal and the engineer options.
  settings: null,

  // The screen that is open, the tab open in each tabbed screen, and — per
  // screen — a saved peer the operator picked on the chip this session that
  // differs from the one holding the screen's role. Session memory only.
  activeView: 'worklist',
  tabs: {},
  peerChoice: {},

  // The worklist as the SCP last returned it, and the row the operator picked
  // (kept by key, so a refresh under their hands does not un-pick it). The
  // search key is the operator's override of the box's own guess; the timer
  // is the auto-refresh, alive only while the station is on screen.
  mwl: {
    matches: [], selected: null, filterOpen: false, searchKey: null, timer: null,
    fetched: false, at: null, error: null, detached: false,
  },

  // The last `mpps` run, the UID the next one will carry, what the chosen
  // folder turned out to hold, and — when the engineer option allows it —
  // which way past a study mismatch was chosen.
  mpps: { lastRun: null, nextUid: null, mismatch: null, scan: null, fix: 'adopt' },

  // The steps this app has opened since the window opened, newest first. This
  // lives here and nowhere else: nothing is written to disk, so quitting
  // forgets it. It is a memory of what this app did, never a claim about the
  // SCP — MPPS has no query service, so there is no way to ask a peer which
  // steps it is holding. `armed` is a Discontinue that is waiting for its
  // reason code.
  steps: { entries: [], armed: false },
};

// --------------------------------------------------------------------------
// Peer chip (every screen that talks to a DIMSE peer)
// --------------------------------------------------------------------------
// state.conn is still the single source of truth every builder reads. What
// changed is where it is set: the four fields live in Settings now, and each
// screen shows one line — the chip — naming the saved peer state.conn holds,
// in the role that screen wants. Clicking it switches among the saved peers.
//
// A screen declares its role on the host element: data-role="ris" (worklist
// and MPPS), "archive" (images) or "any" (echo). Showing a screen selects the
// peer holding that role, unless the operator picked a different one on that
// screen this session. The calling AE on every command is the station's own
// AE Title from Settings — one fact that also decides which station an MPPS
// step is attributed to.

const ROLE_LABEL = { ris: 'RIS', archive: 'Archive', any: 'Peer' };

function dimseProfiles() {
  return state.profiles.filter((p) => !isWebProfile(p));
}

function profileForRole(role) {
  return dimseProfiles().find((p) => p.role === role) || null;
}

/** The saved peer state.conn currently matches, or null. */
function currentProfile() {
  const c = state.conn;
  return dimseProfiles().find((p) =>
    (p.host || '') === c.host && String(p.port || '') === String(c.port || '') && (p.calledAe || '') === c.calledAe) || null;
}

function stationAe() {
  return (state.settings && state.settings.stationAe) || '';
}

/**
 * The calling AE a peer is talked to as.
 *
 * The station's own AE Title is the answer for every peer, and that is the
 * point of setting it once — MPPS attributes a step to it. A peer may still
 * carry its own, because a site whose archive whitelists a different caller
 * from its RIS has to be able to talk to both; that override is a field on
 * the peer in Settings, it is what a pre-Settings profile already held, and
 * the chip shows it in the override colour so it is never a hidden change.
 */
function callingAeFor(p) {
  return (p && p.callingAe) || stationAe() || '';
}

/** True when this peer is talked to as something other than the station itself. */
function overridesCallingAe(p) {
  return Boolean(p && p.callingAe && stationAe() && p.callingAe !== stationAe());
}

function connLabel(c) {
  return c.host && c.port && c.calledAe ? `${c.calledAe} @ ${c.host}:${c.port}` : '';
}

function roleTag(role) {
  return role === 'ris' ? 'RIS' : role === 'archive' ? 'Archive' : '';
}

/** Redraws every chip from state.conn. Cheap, and the only way a chip changes. */
function renderPeerChips() {
  const label = connLabel(state.conn);
  const current = currentProfile();
  const peers = dimseProfiles();
  for (const host of $$('[data-conn]')) {
    const role = host.dataset.role || 'any';
    const roleName = ROLE_LABEL[role] || 'Peer';
    const inEcho = Boolean(host.closest('#view-echo'));
    const items = peers.map((p) =>
      `<button type="button" class="peer-item ${current && current.name === p.name ? 'active' : ''}" data-peer-pick="${esc(p.name)}">` +
      `<span class="peer-item-role">${esc(roleTag(p.role))}</span>${esc(p.name)}</button>`).join('');
    host.innerHTML =
      `<div class="peer-chip ${label ? '' : 'unset'}">` +
        '<button type="button" class="peer-chip-btn" aria-haspopup="true" aria-expanded="false">' +
          `<span class="peer-role">${esc(roleName)}</span>` +
          `<span class="peer-name">${label ? esc(label) : `no ${esc(roleName)} peer set`}</span>` +
          (label ? `<span class="peer-from${overridesCallingAe(current) ? ' override' : ''}"` +
            `${overridesCallingAe(current) ? ' title="This peer is talked to as its own calling AE, not this station\'s."' : ''}>` +
            `← ${esc(state.conn.callingAe || 'DCM-CLI')}</span>` : '') +
          '<span class="peer-caret">▾</span>' +
        '</button>' +
        '<div class="peer-menu" hidden>' +
          (items || '<div class="peer-menu-note">No saved peers yet.</div>') +
          '<div class="peer-menu-sep"></div>' +
          (inEcho ? '' : '<button type="button" class="peer-item plain" data-peer-echo>Test connection (C-ECHO)…</button>') +
          '<button type="button" class="peer-item plain" data-peer-settings>Edit in Settings…</button>' +
        '</div>' +
      '</div>';
  }
}

function closePeerMenus() {
  for (const m of $$('.peer-menu:not([hidden])')) {
    m.hidden = true;
    const btn = m.parentElement.querySelector('.peer-chip-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

/** The view a DOM node sits in, by the `view-` id convention. */
function viewOf(el) {
  const v = el.closest('.view');
  return v ? v.id.replace(/^view-/, '') : '';
}

/**
 * Points state.conn at the peer a screen wants: the operator's pick on that
 * screen if there is one, else the peer holding the screen's role. A screen
 * whose role nobody holds gets an empty peer, not somebody else's — an Archive
 * labelled RIS would be exactly the wrong command with the right label on it.
 */
function selectPeerForView(view) {
  const host = $(`#view-${view} [data-conn]`);
  if (!host) return;
  const role = host.dataset.role || 'any';
  const manual = state.peerChoice[view];
  let p = manual ? dimseProfiles().find((x) => x.name === manual) : null;
  if (manual && !p) delete state.peerChoice[view]; // that peer was deleted
  if (!p && role !== 'any') p = profileForRole(role);
  if (!p && role === 'any') {
    if (connLabel(state.conn)) return; // keep whatever the last screen used
    p = dimseProfiles()[0] || null;
  }
  if (p) applyProfile(p.name, { render: false });
  else if (role !== 'any') state.conn = { host: '', port: '', calledAe: '', callingAe: stationAe() };
}

function wirePeerChips() {
  // Delegated: chips are re-rendered from state on every change.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.peer-chip-btn');
    if (btn) {
      const menu = btn.parentElement.querySelector('.peer-menu');
      const opening = menu.hidden;
      closePeerMenus();
      menu.hidden = !opening;
      btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      return;
    }
    const pick = e.target.closest('[data-peer-pick]');
    if (pick) {
      state.peerChoice[viewOf(pick)] = pick.dataset.peerPick;
      closePeerMenus();
      applyProfile(pick.dataset.peerPick);
      return;
    }
    const wpick = e.target.closest('[data-web-pick]');
    if (wpick) {
      closePeerMenus();
      applyWebProfile(wpick.dataset.webPick);
      return;
    }
    if (e.target.closest('[data-peer-echo]')) {
      // Test the peer this chip shows, whichever role it was shown in.
      const cur = currentProfile();
      if (cur) state.peerChoice.echo = cur.name; else delete state.peerChoice.echo;
      closePeerMenus();
      showView('echo');
      return;
    }
    if (e.target.closest('[data-peer-settings]')) {
      closePeerMenus();
      showView('settings');
      return;
    }
    if (!e.target.closest('.peer-menu')) closePeerMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePeerMenus();
  });
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

/** Redraws everything that lists the saved peers: the chips and Settings. */
function refreshPeerViews() {
  renderPeerChips();
  renderWebChips();
  renderSettingsPeers();
}

function applyProfile(name, { render = true } = {}) {
  const p = dimseProfiles().find((x) => x.name === name);
  if (!p) return;
  state.conn = { host: p.host || '', port: p.port || '', calledAe: p.calledAe || '', callingAe: callingAeFor(p) };
  if (render) {
    renderPeerChips();
    updateAllPreviews();
  }
}

/**
 * Gives a peer a role, taking it from whichever peer held it before.
 *
 * One RIS and one Archive at most: a screen pre-selects "the" peer for its
 * role, and two candidates would turn that into a guess. Entries from before
 * roles existed simply have none until one is set here.
 */
function setPeerRole(name, role) {
  for (const p of dimseProfiles()) {
    if (p.name === name) {
      if (role) p.role = role; else delete p.role;
    } else if (role && p.role === role) {
      delete p.role;
    }
  }
}

/** Saves a peer; `replacing` names the entry an edit is replacing, if any. */
async function savePeer(entry, replacing) {
  state.profiles = state.profiles.filter((p) =>
    isWebProfile(p) || (p.name !== entry.name && p.name !== replacing));
  state.profiles.push(entry);
  if (entry.role) setPeerRole(entry.name, entry.role);
  await persistProfiles();
}

async function deletePeer(name) {
  const cur = currentProfile();
  state.profiles = state.profiles.filter((p) => isWebProfile(p) || p.name !== name);
  for (const [view, chosen] of Object.entries(state.peerChoice)) {
    if (chosen === name) delete state.peerChoice[view];
  }
  // A deleted peer cannot go on being the one every command names.
  if (cur && cur.name === name) state.conn = { host: '', port: '', calledAe: '', callingAe: stationAe() };
  await persistProfiles();
}

// --------------------------------------------------------------------------
// DICOMweb server chip (the Web tabs)
// --------------------------------------------------------------------------
// Parallel to — not shared with — the peer chip: one base URL in state.web,
// saved servers in the same profiles file under kind 'dicomweb', added and
// removed in Settings. The hub tab can also point the chip at itself.
function webProfiles() {
  return state.profiles.filter(isWebProfile);
}

function renderWebChips() {
  const url = state.web.url;
  const servers = webProfiles();
  for (const host of $$('[data-webconn]')) {
    const items = servers.map((p) =>
      `<button type="button" class="peer-item ${p.url === url ? 'active' : ''}" data-web-pick="${esc(p.name)}">${esc(p.url)}</button>`).join('');
    host.innerHTML =
      `<div class="peer-chip ${url ? '' : 'unset'}">` +
        '<button type="button" class="peer-chip-btn" aria-haspopup="true" aria-expanded="false">' +
          '<span class="peer-role">Server</span>' +
          `<span class="peer-name">${url ? esc(url) : 'no DICOMweb server set'}</span>` +
          '<span class="peer-caret">▾</span>' +
        '</button>' +
        '<div class="peer-menu" hidden>' +
          (items || '<div class="peer-menu-note">No saved servers yet.</div>') +
          '<div class="peer-menu-sep"></div>' +
          '<button type="button" class="peer-item plain" data-peer-settings>Edit in Settings…</button>' +
        '</div>' +
      '</div>';
  }
}

function applyWebProfile(name) {
  const p = webProfiles().find((x) => x.name === name);
  if (!p) return;
  state.web.url = p.url || '';
  renderWebChips();
  updateAllPreviews();
}

async function saveWebServer(url) {
  const entry = { name: url, kind: 'dicomweb', url };
  state.profiles = state.profiles.filter((p) => !(isWebProfile(p) && p.name === entry.name));
  state.profiles.push(entry);
  if (!state.web.url) state.web.url = url;
  await persistProfiles();
}

async function deleteWebServer(name) {
  state.profiles = state.profiles.filter((p) => !(isWebProfile(p) && p.name === name));
  await persistProfiles();
}

// --------------------------------------------------------------------------
// Settings — set once, read by every builder
// --------------------------------------------------------------------------
// settings.json is the app's own file, like profiles.json: the renderer reads
// it and writes every value it uses onto the command line, and the engine
// never opens it. Nothing here can change what is sent without also changing
// the command the screen shows — that is the rule this whole file is under.
const DEFAULT_SETTINGS = Object.freeze({
  stationAe: '',        // this station's AE Title: the calling AE everywhere, and what MPPS attributes a step to
  modality: '',         // the worklist's default Modality filter
  onlyThisStation: false, // send ScheduledStationAETitle=<stationAe> on the worklist query
  worklistLimit: '',    // --limit on the worklist query; blank = the whole answer
  defaults: { chunk: '', retry: '', timeout: '', retrieveAe: '', recurse: true },
  rehearsal: false,     // every command that can take --dry-run gets it
  cmdExpanded: false,   // the "command" fold under each button starts open
  allowMismatch: false, // offer --allow-study-mismatch beside --adopt-worklist-identity
});

/** Whatever was on disk, coerced into the shape above so no reader has to guard. */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = r.defaults && typeof r.defaults === 'object' ? r.defaults : {};
  const str = (v, max = 64) => (v == null ? '' : String(v).trim().slice(0, max));
  return {
    stationAe: str(r.stationAe, 16),
    modality: str(r.modality, 16),
    onlyThisStation: Boolean(r.onlyThisStation),
    worklistLimit: str(r.worklistLimit, 6).replace(/[^0-9]/g, ''),
    defaults: {
      chunk: str(d.chunk), retry: str(d.retry), timeout: str(d.timeout),
      retrieveAe: str(d.retrieveAe, 16),
      recurse: d.recurse !== false,
    },
    rehearsal: Boolean(r.rehearsal),
    cmdExpanded: Boolean(r.cmdExpanded),
    allowMismatch: Boolean(r.allowMismatch),
  };
}

// Builders run on every keystroke, before and after the file is read, so the
// settings are never null — just empty until loadSettings lands.
state.settings = normalizeSettings({});

async function loadSettings() {
  let raw = {};
  try { raw = await window.dcm.settings.get(); } catch { raw = {}; }
  state.settings = normalizeSettings(raw);
}

async function persistSettings() {
  try { await window.dcm.settings.set(state.settings); } catch { /* the screen still holds the values */ }
}

/** Rehearsal is one switch, read by every builder that has a --dry-run. */
function rehearsal() {
  return Boolean(state.settings && state.settings.rehearsal);
}

/**
 * A screen field's own value, or the Settings default for that flag when the
 * field is blank. Typed always wins, so a per-run override is still one field
 * away; blank everywhere means the flag stays off the command, exactly as it
 * did before Settings existed.
 */
function fieldOr(id, key) {
  const el = $(`#${id}`);
  const typed = el ? el.value.trim() : '';
  if (typed) return typed;
  const d = state.settings && state.settings.defaults;
  return d && d[key] ? String(d[key]) : '';
}

/** Paints the Settings form from state.settings. Called once, at boot. */
function renderSettingsForm() {
  const s = state.settings;
  $('#set-station-ae').value = s.stationAe;
  $('#set-modality').value = s.modality;
  $('#set-only-station').checked = s.onlyThisStation;
  $('#set-mwl-limit').value = s.worklistLimit;
  $('#set-chunk').value = s.defaults.chunk;
  $('#set-retry').value = s.defaults.retry;
  $('#set-timeout').value = s.defaults.timeout;
  $('#set-retrieve-ae').value = s.defaults.retrieveAe;
  $('#set-recurse').checked = s.defaults.recurse;
  $('#set-rehearsal').checked = s.rehearsal;
  $('#set-cmd-expanded').checked = s.cmdExpanded;
  $('#set-allow-mismatch').checked = s.allowMismatch;
  renderStationPlaceholder();
}

/** Until a station AE is set, what actually goes out as --calling-ae is shown as the placeholder. */
function renderStationPlaceholder() {
  const cur = currentProfile();
  $('#set-station-ae').placeholder = (cur && cur.callingAe) || 'DCM-CLI';
}

/** Reads the form into state.settings, saves it, and pushes it to every screen. */
async function commitSettings() {
  state.settings = normalizeSettings({
    stationAe: $('#set-station-ae').value,
    modality: $('#set-modality').value,
    onlyThisStation: $('#set-only-station').checked,
    worklistLimit: $('#set-mwl-limit').value,
    defaults: {
      chunk: $('#set-chunk').value,
      retry: $('#set-retry').value,
      timeout: $('#set-timeout').value,
      retrieveAe: $('#set-retrieve-ae').value,
      recurse: $('#set-recurse').checked,
    },
    rehearsal: $('#set-rehearsal').checked,
    cmdExpanded: $('#set-cmd-expanded').checked,
    allowMismatch: $('#set-allow-mismatch').checked,
  });
  await persistSettings();
  applySettings();
}

/**
 * Everything outside the Settings screen that reads Settings, repainted.
 *
 * The station AE is re-derived onto state.conn, the screens' own
 * recurse/modality fields are re-seeded where nobody has typed in them, the
 * placeholders say what a blank field will send, the command folds open or
 * shut, and the banner comes or goes. Then every preview is rebuilt, because
 * every one of those can change a command.
 */
function applySettings() {
  const cur = currentProfile();
  if (cur) state.conn.callingAe = callingAeFor(cur);
  seedFromSettings();
  applyDefaultPlaceholders();
  applyCmdFold();
  renderRehearsal();
  renderPeerChips();
  renderStationPlaceholder();
  renderSendAdvSummary();
  renderSpeedParallelHint();
  renderModalityPill();
  // Rehearsal relabels the verbs, the Archive role moves the images, and the
  // engineer switch appears or goes: the whole panel is repainted.
  renderMppsPanel();
  renderStepsClose();
  updateAllPreviews();
}

/**
 * The Settings defaults that are checkboxes on a screen are seeded into the
 * screen's own control rather than read around it, so the builder keeps
 * reading one control and the operator can still flip it for one run. A
 * control someone has touched is theirs and is left alone.
 */
function seedFromSettings() {
  const noRecurse = !state.settings.defaults.recurse;
  for (const id of ['send-norecurse', 'mpps-norecurse', 'info-norecurse']) {
    const el = $(`#${id}`);
    if (el && !el.dataset.touched) el.checked = noRecurse;
  }
  const modality = $('#mwl-modality');
  if (modality && !modality.dataset.touched) modality.value = state.settings.modality;
}

/** A blank field sends the Settings default, so the placeholder says which. */
function applyDefaultPlaceholders() {
  const d = state.settings.defaults;
  const ph = (id, key, fallback) => {
    const el = $(`#${id}`);
    if (el) el.placeholder = d[key] ? `${d[key]} (from Settings)` : fallback;
  };
  ph('echo-timeout', 'timeout', '60000');
  ph('send-retry', 'retry', '1');
  ph('send-timeout', 'timeout', '60000');
  ph('send-chunk', 'chunk', 'from the preset');
  ph('mpps-chunk', 'chunk', '200');
  ph('mpps-retry', 'retry', '1');
  ph('mpps-retrieveae', 'retrieveAe', 'ARCHIVE');
  ph('speed-chunk', 'chunk', 'each run decides');
  ph('webping-timeout', 'timeout', '60000');
  ph('websend-chunk', 'chunk', '50');
  ph('websend-retry', 'retry', '1');
  ph('websend-timeout', 'timeout', '60000');
}

/** The preview is never absent; the engineer option only says whether it starts unfolded. */
function applyCmdFold() {
  for (const d of $$('.cmd-fold')) d.open = state.settings.cmdExpanded;
}

/** The amber banner across the top of the content area, for as long as rehearsal is on. */
function renderRehearsal() {
  $('#rehearsal-banner').hidden = !rehearsal();
}

/** The saved peers as Settings lists them: role, name, and the three verbs. */
function renderSettingsPeers() {
  const list = $('#set-peers');
  if (!list) return;
  const peers = dimseProfiles();
  const option = (value, label, current) =>
    `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
  list.innerHTML = peers.length
    ? peers.map((p) =>
      `<div class="peer-row" data-peer="${esc(p.name)}">` +
        `<span class="peer-role ${p.role ? '' : 'none'}">${esc(roleTag(p.role) || 'Other')}</span>` +
        `<span class="peer-row-name" title="${esc(p.name)}">${esc(p.name)}</span>` +
        (p.callingAe
          ? `<span class="peer-from override" title="Talked to as this calling AE, not this station's.">← ${esc(p.callingAe)}</span>`
          : '') +
        `<select data-peer-role-of="${esc(p.name)}" aria-label="Role">` +
          option('', 'Other', p.role || '') +
          option('ris', 'RIS (worklist &amp; MPPS)', p.role || '') +
          option('archive', 'Archive (images)', p.role || '') +
        '</select>' +
        `<button class="btn ghost small" data-peer-test="${esc(p.name)}">Test</button>` +
        `<button class="btn ghost small" data-peer-edit="${esc(p.name)}">Edit</button>` +
        `<button class="btn ghost small" data-peer-delete="${esc(p.name)}">Delete</button>` +
      '</div>').join('')
    : '<div class="empty-note dense">No saved peers yet. Add the RIS and the archive below.</div>';

  const web = $('#set-webservers');
  const servers = webProfiles();
  web.innerHTML = servers.length
    ? servers.map((p) =>
      `<div class="peer-row" data-web="${esc(p.name)}">` +
        '<span class="peer-role">Web</span>' +
        `<span class="peer-row-name" title="${esc(p.url)}">${esc(p.url)}</span>` +
        `<button class="btn ghost small" data-web-delete="${esc(p.name)}">Delete</button>` +
      '</div>').join('')
    : '<div class="empty-note dense">No DICOMweb servers yet.</div>';
}

/** Name of the saved peer the form is editing, or null while adding. */
let peerEditing = null;

function resetPeerForm() {
  peerEditing = null;
  for (const id of ['peer-host', 'peer-port', 'peer-ae', 'peer-callingae']) $(`#${id}`).value = '';
  $('#peer-role').value = '';
  $('#peer-form-title').textContent = 'Add a peer';
  $('#peer-save').textContent = 'Save peer';
  $('#peer-cancel').hidden = true;
  $('#peer-form-note').hidden = true;
}

/** After the saved peers change: the chips, the lists and every command that names a peer. */
function afterPeersChanged() {
  selectPeerForView(state.activeView);
  refreshPeerViews();
  renderStationPlaceholder();
  updateAllPreviews();
}

function wireSettings() {
  // The form commits as it is typed, a beat behind the keystroke, and at once
  // on change (blur, Enter, a checkbox) — so leaving the screen never loses it.
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(commitSettings, 300); };
  for (const el of $$('#view-settings input[id^="set-"]')) {
    el.addEventListener('input', soon);
    el.addEventListener('change', () => { clearTimeout(timer); commitSettings(); });
  }
  $('#rehearsal-off').addEventListener('click', () => {
    $('#set-rehearsal').checked = false;
    commitSettings();
  });

  // The screen controls that Settings seeds stop being seeded once touched.
  for (const id of ['send-norecurse', 'mpps-norecurse', 'info-norecurse']) {
    $(`#${id}`).addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
  }
  $('#mwl-modality').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });

  // ----- the peer form -----
  $('#peer-save').addEventListener('click', async () => {
    const host = $('#peer-host').value.trim();
    const port = $('#peer-port').value.trim();
    const calledAe = $('#peer-ae').value.trim();
    const note = $('#peer-form-note');
    const miss = [];
    if (!host) miss.push('host');
    if (!port) miss.push('port');
    if (!calledAe) miss.push('called AE');
    if (miss.length) {
      note.hidden = false;
      note.textContent = `Fill in: ${miss.join(', ')}.`;
      return;
    }
    note.hidden = true;
    const entry = { name: profileName({ host, port, calledAe }), host, port, calledAe };
    // Blank means "this station's AE Title", which is the answer for almost
    // every peer. A value here is a deliberate per-peer override — the case a
    // site whose archive whitelists a different caller from its RIS needs, and
    // what a profile saved before Settings existed already carried.
    const callingAe = $('#peer-callingae').value.trim();
    if (callingAe) entry.callingAe = callingAe;
    const role = $('#peer-role').value;
    if (role) entry.role = role;
    const wasChosen = Object.entries(state.peerChoice).filter(([, n]) => n === peerEditing);
    await savePeer(entry, peerEditing);
    // A renamed peer keeps the screens that had picked it.
    for (const [view] of wasChosen) state.peerChoice[view] = entry.name;
    resetPeerForm();
    afterPeersChanged();
  });
  $('#peer-cancel').addEventListener('click', resetPeerForm);

  // ----- the lists (delegated: they are re-rendered from state) -----
  $('#set-peers').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-peer-role-of]');
    if (!sel) return;
    setPeerRole(sel.dataset.peerRoleOf, sel.value);
    await persistProfiles();
    afterPeersChanged();
  });
  $('#set-peers').addEventListener('click', async (e) => {
    const test = e.target.closest('[data-peer-test]');
    if (test) {
      state.peerChoice.echo = test.dataset.peerTest;
      showView('echo');
      return;
    }
    const edit = e.target.closest('[data-peer-edit]');
    if (edit) {
      const p = dimseProfiles().find((x) => x.name === edit.dataset.peerEdit);
      if (!p) return;
      peerEditing = p.name;
      $('#peer-host').value = p.host || '';
      $('#peer-port').value = p.port || '';
      $('#peer-ae').value = p.calledAe || '';
      $('#peer-callingae').value = p.callingAe || '';
      $('#peer-role').value = p.role || '';
      $('#peer-form-title').textContent = `Edit ${p.name}`;
      $('#peer-save').textContent = 'Save changes';
      $('#peer-cancel').hidden = false;
      $('#peer-form-note').hidden = true;
      $('#peer-host').focus();
      return;
    }
    const del = e.target.closest('[data-peer-delete]');
    if (del) {
      if (peerEditing === del.dataset.peerDelete) resetPeerForm();
      await deletePeer(del.dataset.peerDelete);
      afterPeersChanged();
    }
  });

  // ----- DICOMweb servers -----
  const addWeb = async () => {
    const url = $('#webserver-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    await saveWebServer(url);
    $('#webserver-url').value = '';
    refreshPeerViews();
    updateAllPreviews();
  };
  $('#webserver-add').addEventListener('click', addWeb);
  $('#webserver-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWeb(); });
  $('#set-webservers').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-web-delete]');
    if (!del) return;
    const gone = webProfiles().find((p) => p.name === del.dataset.webDelete);
    await deleteWebServer(del.dataset.webDelete);
    if (gone && state.web.url === gone.url) state.web.url = (webProfiles()[0] || {}).url || '';
    refreshPeerViews();
    updateAllPreviews();
  });

  resetPeerForm();
}

// --------------------------------------------------------------------------
// Tabs (DICOMweb, Tools)
// --------------------------------------------------------------------------
// Four former screens sit under one sidebar item as tabs. Each pane keeps its
// old `view-<name>` id, so every builder, status chip and console resolves as
// before; only what is on screen changes. The open tab is remembered per group.
function showTab(group, tab) {
  const row = $(`[data-tabs="${group}"]`);
  if (!row) return;
  const chips = $$('[data-tab]', row);
  if (!chips.some((c) => c.dataset.tab === tab)) tab = chips[0].dataset.tab;
  for (const c of chips) {
    const on = c.dataset.tab === tab;
    c.classList.toggle('active', on);
    c.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  const section = row.closest('.view');
  for (const pane of $$('.tab-pane', section)) pane.hidden = pane.id !== `view-${tab}`;
  state.tabs[group] = tab;
}

function wireTabs() {
  for (const row of $$('[data-tabs]')) {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-tab]');
      if (!chip) return;
      showTab(row.dataset.tabs, chip.dataset.tab);
      renderWebChips();
      updateAllPreviews();
      persistAppState();
    });
  }
}

// --------------------------------------------------------------------------
// Navigation
// --------------------------------------------------------------------------
function showView(name) {
  let view = $(`#view-${name}`);
  // A pane's old screen name (say 'webquery', remembered by a previous
  // version) still opens: its section, with that tab selected.
  if (view && view.classList.contains('tab-pane')) {
    const section = view.closest('.view');
    const row = $('[data-tabs]', section);
    if (row) showTab(row.dataset.tabs, name);
    name = section.id.replace(/^view-/, '');
    view = section;
  }
  if (!view || !view.classList.contains('view')) {
    name = 'worklist';
    view = $('#view-worklist');
  }
  state.activeView = name;
  // A screen reached from another (echo, from Settings or a chip) lights the
  // sidebar item it belongs under rather than none.
  const nav = view.dataset.nav || name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === nav));
  $$('.view').forEach((v) => v.classList.toggle('active', v === view));
  closePeerMenus();
  selectPeerForView(name);
  renderPeerChips();
  renderWebChips();
  updateAllPreviews();
  persistAppState();
  // The station reads its list when it comes on screen and keeps it fresh
  // while it stays there; off screen, the timer stops.
  stationVisibility(name === 'worklist');
}

/** Remembers the open screen and tabs, so the next launch opens where this one left off. */
function persistAppState() {
  try {
    window.dcm.appState.set({ activeView: state.activeView, activeTabs: state.tabs });
  } catch {
    /* not worth surfacing */
  }
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

/**
 * Opens the disclosure a view's console sits in, so a failure is never folded
 * away.
 *
 * Every screen now ends with a "▸ Output" disclosure, and the rule is the same
 * on all of them: the output may be folded, but it may never be missing, and
 * nothing that went wrong is allowed to stay behind a triangle. Called with no
 * argument this still means the station's shared pane, which is what its own
 * failure paths ask for.
 */
function revealConsole(view) {
  const c = view ? consoleEl(view) : $('#wl-console');
  if (!c) return;
  c.hidden = false;
  const box = c.closest('details');
  if (box && !box.open) box.open = true;
}

/** A refusal the operator has to see: unfold the output, then say why. */
function fail(view, msg) {
  revealConsole(view);
  appendConsole(view, msg, 'stderr');
}

// --------------------------------------------------------------------------
// A console is a fixed-size window onto a stream that has no fixed size.
//
// Two things used to go wrong here at once, and both had to be fixed before
// either helped. The DOM grew without limit — one <span> per chunk, never
// removed — so a run that printed a few hundred thousand lines built a few
// hundred thousand nodes. And every chunk read `scrollHeight` immediately
// after appending to that same element, which forces a synchronous layout;
// layout is the expensive part, and it was being paid once per pipe read
// rather than once per frame. Together they wedged the renderer, and a wedged
// renderer cannot run the Stop button, so whatever the engine was doing —
// including holding an association open on somebody's clinical receiver —
// simply carried on.
//
// So: arrival is cheap and touches no DOM at all, the frame does the work, and
// what is retained is capped. Losing old output is much better than losing the
// window, but it is still a loss, and it is announced. A console that quietly
// drops the beginning of a transfer report is telling you a run went better
// than it did, and that is the one thing this tool must never do.
// --------------------------------------------------------------------------

/**
 * Lines of output a console keeps.
 *
 * This is the one number that sets the worst case, because the worst case is a
 * flush that has to write the whole window at once — which is what happens the
 * first time the console catches up after falling behind. Measured on a loaded
 * machine, 5000 lines cost ~480ms in a single turn, and a turn is exactly what
 * a click has to wait behind. 2000 is still far more scrollback than any of
 * this tool's own reports produce, and it costs well under a fifth of that.
 */
const CONSOLE_MAX_LINES = 2000;

/**
 * Trim granularity. Output is cut into pieces of at most this many lines, and
 * a piece is what gets dropped, so it is also the unit the drop count is
 * counted in. Smaller means smoother trimming and more DOM nodes; this holds
 * the console to at most ~20 spans and drops at most 100 lines at a time.
 */
const CONSOLE_PIECE_LINES = 100;

/** How near the bottom counts as "at the bottom", in CSS pixels. */
const CONSOLE_STICK_SLOP = 24;

/**
 * How long the console will wait for an animation frame before writing anyway.
 *
 * requestAnimationFrame is the right clock while the window is compositing —
 * it is exactly once per painted frame, which is as often as a write could
 * possibly be seen. But it does not fire *at all* for a window that is
 * minimised, occluded, or on a display that has gone away, and a console that
 * shows nothing at all until the window comes back is its own kind of missing
 * output. So the frame is the fast path and this is the floor.
 */
const CONSOLE_FALLBACK_MS = 250;

/** Per-console-element buffering, retention and drop accounting. */
const consoleStates = new WeakMap();

function consoleStateFor(c) {
  let s = consoleStates.get(c);
  if (s) return s;
  s = {
    pending: [], pendingLines: 0, frame: 0, timer: 0, scrollFrame: 0,
    lines: 0, dropped: 0, droppedUpstream: 0, stick: true, owed: false, notice: null,
  };
  consoleStates.set(c, s);
  // Stick-to-bottom is the operator's call, not ours. Someone who scrolled up
  // to read a failure is not asking to be dragged back down every frame, so
  // the flush only scrolls when they were already at the bottom. Read here,
  // inside a scroll event, where layout is settled and the read is free.
  c.addEventListener('scroll', () => {
    // Where the console sits only says what the operator wants while the
    // console is somewhere it could have been put on purpose.
    //
    // `owed` means the last write deliberately skipped its scroll because the
    // window was not painting. The position is then knowingly stale, trimming
    // still fires scroll events at it, and every one of those measures as a
    // deliberate scroll away from the end — which would latch stick-to-bottom
    // off, and the console would quietly stop following its own output from
    // then on. That is what happened: a run left behind a minimised window
    // came back parked 115,000px above its own last line.
    //
    // A console with no layout at all — a view switched away from — has no
    // bottom to be at either, and reports clientHeight 0.
    if (s.owed || !c.clientHeight) return;
    s.stick = c.scrollHeight - c.scrollTop - c.clientHeight <= CONSOLE_STICK_SLOP;
  }, { passive: true });
  return s;
}

/**
 * Cuts text into line-aligned pieces of at most `max` lines.
 *
 * A piece that does not end at a newline is counted as carrying one more line
 * than it has newlines, because on screen it is one. A line split across two
 * pipe reads therefore counts as two if both halves are dropped. That
 * over-counts by at most one per dropped piece, which is deliberate: a drop
 * notice that overstates makes the run look messier than it was, and
 * understating would make it look tidier.
 */
function splitConsoleText(text, max) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let lines = 0;
    while (lines < max) {
      const nl = text.indexOf('\n', end);
      if (nl === -1) { end = text.length; break; }
      end = nl + 1;
      lines++;
    }
    if (end === start) end = text.length;
    const piece = text.slice(start, end);
    pieces.push({ text: piece, lines: piece.endsWith('\n') ? lines : lines + 1 });
    start = end;
  }
  return pieces;
}

/**
 * Books the next write. Whichever of the two clocks arrives first does the
 * work and cancels the other, so a compositing window pays one flush per
 * frame and a window that is not compositing still pays one every 250ms.
 */
function scheduleConsoleFlush(c, s) {
  if (s.frame || s.timer) return;
  const run = (painting) => {
    if (s.frame) { cancelAnimationFrame(s.frame); s.frame = 0; }
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    flushConsole(c, painting);
  };
  s.frame = requestAnimationFrame(() => run(true));
  s.timer = setTimeout(() => run(false), CONSOLE_FALLBACK_MS);
}

function clearConsole(view) {
  const c = consoleEl(view);
  if (!c) return;
  resetConsole(c);
  c.hidden = false;
}

/** Empties a console and its accounting together, so neither outlives the other. */
function resetConsole(c) {
  const s = consoleStateFor(c);
  if (s.frame) { cancelAnimationFrame(s.frame); s.frame = 0; }
  if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
  if (s.scrollFrame) { cancelAnimationFrame(s.scrollFrame); s.scrollFrame = 0; }
  s.pending.length = 0;
  s.pendingLines = 0;
  s.lines = 0;
  s.dropped = 0;
  s.droppedUpstream = 0;
  s.stick = true;
  s.owed = false;
  if (s.notice) { s.notice.remove(); s.notice = null; }
  c.textContent = '';
}

/**
 * @param {string} view
 * @param {string} text
 * @param {'stdout'|'stderr'} stream
 * @param {number} [dropped]  lines the main process discarded before this
 *   chunk, because the window was not taking them fast enough. Folded into the
 *   same total as the console's own trimming, so there is one number to read
 *   and it covers everything that went missing between the engine and the eye.
 */
function appendConsole(view, text, stream, dropped) {
  const c = consoleEl(view);
  if (!c) return;
  const s = consoleStateFor(c);
  if (dropped) {
    s.dropped += dropped;
    s.droppedUpstream += dropped;
    scheduleConsoleFlush(c, s);
  }
  if (!text) return;
  const err = stream === 'stderr';
  for (const piece of splitConsoleText(stripAnsi(text), CONSOLE_PIECE_LINES)) {
    s.pending.push({ text: piece.text, lines: piece.lines, err });
    s.pendingLines += piece.lines;
  }
  // The buffer is trimmed too, not just the DOM. requestAnimationFrame does
  // not fire for a minimised or hidden window, so without this a long receive
  // behind a minimised window would queue every line it ever printed in
  // memory and hand the whole backlog over on restore.
  while (s.pendingLines > CONSOLE_MAX_LINES && s.pending.length > 1) {
    const gone = s.pending.shift();
    s.pendingLines -= gone.lines;
    s.dropped += gone.lines;
  }
  // Nothing above touched the DOM: arrival stays cheap however fast it comes.
  scheduleConsoleFlush(c, s);
}

/**
 * @param {HTMLElement} c
 * @param {boolean} painting  true when an animation frame woke this, i.e. the
 *   window is compositing and the scroll below will actually be seen.
 */
function flushConsole(c, painting) {
  const s = consoleStates.get(c);
  if (!s) return;
  // A flush booked by an upstream drop alone carries no text but still owes an
  // updated notice.
  if (!s.pending.length) {
    if (s.dropped) renderConsoleNotice(c, s);
    return;
  }

  // Taken before any mutation. The old code read scrollHeight straight after
  // appendChild, which forces the layout it just invalidated — once per chunk.
  //
  // Reading it is still the single most expensive thing in this function, and
  // on a window that is not compositing it is the *only* thing asking for
  // layout, so every read pays for a full one of the whole retained block.
  // Measured at 200,000 lines it was the difference between draining in 1.8s
  // and in 9.2s. Nobody is looking at a scroll position on a window that is
  // not painting, so the content is written and only the scroll waits — booked
  // below for the next frame that actually arrives.
  const stick = s.stick && painting;

  const frag = document.createDocumentFragment();
  let written = 0;
  for (const piece of s.pending) {
    const span = document.createElement('span');
    if (piece.err) span.className = 'err';
    span.textContent = piece.text;
    // A plain property, not a data- attribute: an attribute write would
    // invalidate style for every span we add.
    span.consoleLines = piece.lines;
    written += piece.lines;
    s.lines += piece.lines;
    frag.appendChild(span);
  }
  s.pending.length = 0;
  s.pendingLines = 0;

  c.hidden = false;
  if (written >= CONSOLE_MAX_LINES) {
    // Everything already on screen is doomed anyway — this one flush carries a
    // full window on its own. Replacing in one operation beats appending and
    // then unpicking the old content span by span.
    for (const gone of c.childNodes) s.dropped += gone.consoleLines || 0;
    s.lines = written;
    c.replaceChildren(frag);
  } else {
    c.appendChild(frag);
  }

  while (s.lines > CONSOLE_MAX_LINES && c.firstChild && c.firstChild !== c.lastChild) {
    const gone = c.firstChild;
    s.lines -= gone.consoleLines || 0;
    s.dropped += gone.consoleLines || 0;
    gone.remove();
  }

  if (s.dropped) renderConsoleNotice(c, s);

  if (stick) {
    // One layout read and one scroll write per frame, instead of per chunk.
    c.scrollTop = c.scrollHeight;
    s.owed = false;
  } else if (s.stick && !painting) {
    // Skipped above because the window is not painting. Book it on the frame
    // clock, which fires when the window is next composited — possibly on
    // restore, long after the run ended. Without this a console filled behind
    // a minimised window comes back parked where it was before, with the
    // output the operator minimised it to collect sitting below the fold.
    s.owed = true;
    if (!s.scrollFrame) {
      s.scrollFrame = requestAnimationFrame(() => {
        s.scrollFrame = 0;
        if (s.stick) c.scrollTop = c.scrollHeight;
        // Cleared after the write, so the scroll event it causes is measured
        // against a position we actually chose.
        s.owed = false;
      });
    }
  }
}

/**
 * The banner saying what is missing from the top of this console.
 *
 * It sits above the scroll area rather than inside it, so it stays on screen
 * while the operator reads: the fact that output was dropped is not something
 * they should have to scroll to the top to discover.
 */
function renderConsoleNotice(c, s) {
  if (!s.notice) {
    s.notice = document.createElement('div');
    s.notice.className = 'console-trim';
    c.parentNode.insertBefore(s.notice, c);
  }
  const n = s.dropped;
  const u = s.droppedUpstream;
  s.notice.textContent =
    `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'} of output dropped — this console keeps the `
    + `last ${CONSOLE_MAX_LINES.toLocaleString()} so the window stays responsive`
    // Trimming takes the oldest lines, a contiguous run from the start. An
    // overflow upstream takes them from wherever the window fell behind, which
    // is somewhere in the middle, and that is a different claim about what is
    // missing — so it is said separately rather than folded into "earlier".
    + (u
      ? `, and ${u.toLocaleString()} of those came off mid-run, where output arrived `
        + 'faster than the window could take it'
      : '')
    + `. The run itself was not affected, and the totals it reports are counted from all of it.`;
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
// A run's output is also held whole in memory, separately from the console,
// because the callers parse it: parseTotals reads the report a send prints at
// the end, and the --json screens JSON.parse the entirety of stdout. Those
// strings were unbounded too, so the same flood that grew the DOM without
// limit grew a pair of strings without limit beside it.
//
// The limits below sit far above any real run. They exist so a runaway stream
// costs a bounded amount of memory, not to trim ordinary output — a study's
// --json payload has to survive intact or the screens that read it break.
const RUN_STDOUT_LIMIT = 24 * 1024 * 1024;
const RUN_STDERR_LIMIT = 4 * 1024 * 1024;

/**
 * Accumulates a stream, keeping the head and the tail if it outgrows `limit`.
 *
 * The tail can never be the part that goes: the engine's closing report is at
 * the end, and dropping it would leave a transfer with no accounting at all.
 * The head is kept alongside it because the first thing printed is usually
 * what the run was asked to do. What is lost from the middle gets a marker
 * saying how much — the string is read by code, but it is also shown to people
 * on the paths that fail to parse, and it must not look complete.
 */
function makeBounded(limit) {
  const keep = Math.floor(limit / 2);
  let head = '';
  let tail = '';
  let elided = 0;
  return {
    push(text) {
      if (head.length < keep) {
        const room = keep - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
        if (!text) return;
      }
      tail += text;
      if (tail.length > keep) {
        const cut = tail.length - keep;
        tail = tail.slice(cut);
        elided += cut;
      }
    },
    get value() {
      if (!elided) return head + tail;
      return `${head}\n[app] ${elided.toLocaleString()} characters of output dropped from the `
        + `middle of this run to stay within memory\n${tail}`;
    },
  };
}

/**
 * Run a command, streaming into the view's console.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runStreaming(view, argv, { onExit } = {}) {
  return new Promise(async (resolve) => {
    const out = makeBounded(RUN_STDOUT_LIMIT);
    const err = makeBounded(RUN_STDERR_LIMIT);
    const runId = await window.dcm.start(argv, state.info.home || null, {
      onChunk: (stream, text, dropped) => {
        if (stream === 'stdout') out.push(text); else err.push(text);
        appendConsole(view, text, stream, dropped);
      },
      onExit: (code) => {
        delete state.activeRuns[view];
        // A non-zero exit is exactly the case the fold must not swallow.
        if (code !== 0) revealConsole(view);
        const result = { code, stdout: out.value, stderr: err.value };
        if (onExit) onExit(result);
        resolve(result);
      },
    });
    state.activeRuns[view] = runId;
  });
}

/**
 * Stops the run a view owns, and says what actually happened.
 *
 * The old handlers fired cancel and forgot about it, so a child that ignored
 * the request looked exactly like one that had stopped. That distinction is
 * the whole point of the button: what we are trying to prevent is an engine
 * still holding an association open on someone's receiver while the operator
 * has been shown "Stopped" and moved on. If it does not take, say so, and say
 * what to do about it.
 *
 * @param {string} view
 * @param {HTMLElement|null} btn  the Stop button, relabelled while we wait.
 */
async function stopRun(view, btn) {
  const id = state.activeRuns[view];
  if (!id) return { stopped: false };
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  let result;
  try {
    result = await window.dcm.cancel(id);
  } catch (err) {
    result = { stopped: false, error: err && err.message ? err.message : String(err) };
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  // A run that had already finished on its own is not a failure to stop.
  if (result && !result.stopped && result.reason !== 'not running') {
    fail(view,
      `\nStop did not take: ${result.error || 'the engine is still running'}. `
      + `Anything it has open with the peer is still open — close the app window to release it.\n`);
  }
  return result;
}

/** Run a command capturing output silently (for --json views). */
function runCapture(view, argv) {
  return new Promise(async (resolve) => {
    const out = makeBounded(RUN_STDOUT_LIMIT);
    const err = makeBounded(RUN_STDERR_LIMIT);
    const runId = await window.dcm.start(argv, state.info.home || null, {
      onChunk: (stream, text) => { if (stream === 'stdout') out.push(text); else err.push(text); },
      onExit: (code) => {
        delete state.activeRuns[view];
        resolve({ code, stdout: out.value, stderr: err.value });
      },
    });
    state.activeRuns[view] = runId;
  });
}

// --------------------------------------------------------------------------
// Command preview
// --------------------------------------------------------------------------
function setPreviewEl(el, argv) {
  if (!el) return;
  const line = 'dcm ' + argv.map(quoteArg).join(' ');
  el.textContent = line;
  // The fold's summary carries the command while the fold is shut, so a
  // glance still says what the button will run.
  const fold = el.closest('.cmd-fold');
  const sum = fold && fold.querySelector('.cmd-sum');
  if (sum) sum.textContent = line;
}

function setPreview(view, argv) {
  setPreviewEl(viewPart(view, 'cmd'), argv);
}

const BUILDERS = {}; // view -> () => argv

function updateAllPreviews() {
  for (const [view, build] of Object.entries(BUILDERS)) {
    try { setPreview(view, build()); } catch { /* partial form */ }
  }
  // The sweep's list of commands is a preview too — it just holds several
  // commands rather than one, and it is built from the same peer connection.
  // Refreshed from the same hook so that editing the peer, picking a saved
  // profile, switching views or choosing a folder with Browse... cannot leave
  // the listed commands missing flags the single preview above already shows.
  try { renderSpeedPlan(); } catch { /* before the DOM is wired */ }
  // The station's second verb has its own command, and it changes with the
  // same keystrokes the first one does.
  try { if (panelMode()) renderStartPreview(); } catch { /* before the DOM is wired */ }
}

// --------------------------------------------------------------------------
// View: ECHO
// --------------------------------------------------------------------------
BUILDERS.echo = () => {
  const argv = ['echo', ...connArgs()];
  const t = fieldOr('echo-timeout', 'timeout');
  if (t) argv.push('--timeout', t);
  return argv;
};

function wireEcho() {
  $('#echo-timeout').addEventListener('input', updateAllPreviews);
  $('#view-echo [data-run]').addEventListener('click', async () => {
    const miss = connMissing();
    clearConsole('echo');
    if (miss.length) { fail('echo', `Fill in: ${miss.join(', ')}.\n`); return; }
    setStatus('echo', 'running', 'Testing…');
    const { code } = await runStreaming('echo', BUILDERS.echo());
    setStatus('echo', code === 0 ? 'ok' : 'fail', code === 0 ? 'Reachable' : 'Failed');
  });
}

// --------------------------------------------------------------------------
// View: SEND
// --------------------------------------------------------------------------
/**
 * The four speed presets, named exactly as the engine names them.
 *
 * The number of associations each one opens is repeated here only to say it in
 * the sentence an operator reads; the engine owns the value, and the command
 * carries the preset name rather than the number, so the two cannot drift into
 * disagreeing about what was sent.
 */
const SEND_SPEEDS = {
  'normal': { associations: 1, hint: 'One association at a time — ordinary clinical traffic.' },
  'fast': { associations: 4, hint: 'Four at a time — a backlog or a migration.' },
  'very-fast': { associations: 8, hint: 'Eight at a time — a bulk move you are watching.' },
  'insane': { associations: 16, hint: 'Sixteen at a time — the widest the engine goes.' },
};

/** Which preset the Send screen is set to. */
function sendSpeed() {
  const active = $('#send-speed .chip.active');
  return active ? active.dataset.speed : 'normal';
}

/**
 * True when a typed association count has displaced the preset outright.
 *
 * The chip row has no off position — Normal ships active — so typing a number
 * into Parallel is the only way a user says "no preset". When they do, the
 * command must carry no --speed at all, not --speed plus --parallel. The engine
 * gates its chunk derivation on the flag being *present* rather than on the
 * preset supplying the width (resolveSpeedPlan, src/commands/send.js), so a
 * --speed the user never engaged goes on sizing the chunks off their typed
 * number: Parallel 4 over a 100-instance study used to mean one association of
 * up to 200 and would silently become four of 25. Same field, same value,
 * different transfer. A CLI user typing `--parallel 4` gets the old behaviour,
 * and this box has to agree with the CLI.
 */
function sendPresetInert() {
  return $('#send-parallel').value.trim() !== '';
}

/**
 * The one line under the chip row, and the amber block insane earns.
 *
 * One line that changes rather than four permanent paragraphs: the descriptions
 * only matter at the moment of choosing, and this screen has been too talkative
 * before. The full form of all four is in the help panel. Insane is the
 * exception — its cost lands on someone else's receiver, so it is marked in the
 * row itself, with a link into the paragraph that says what going too wide
 * looks like.
 *
 * The row also has an off state, because the command has one. The preview is
 * the command on this screen; a highlighted chip beside a command with no
 * --speed in it would be the screen describing a run that is not the run.
 */
function renderSendSpeed() {
  const speed = sendSpeed();
  const preset = SEND_SPEEDS[speed] || SEND_SPEEDS.normal;
  const inert = sendPresetInert();
  $('#send-speed').classList.toggle('inert', inert);
  $('#send-speed-hint').textContent = inert
    ? `Not in use: Parallel ${$('#send-parallel').value.trim()} under Advanced replaces the preset, `
      + 'so the command carries --parallel and no --speed.'
    : preset.hint;
  $('#send-speed-hint').classList.toggle('live', inert);
  // The amber block is about what insane costs a receiver. Nothing is being
  // asked of any receiver on insane's behalf while the preset is off the line.
  $('#send-speed-danger').hidden = speed !== 'insane' || inert;
}

/**
 * One line naming every override folded away under Advanced.
 *
 * Folding the controls away must never fold away the values they hold: what is
 * under there decides what goes on the wire, so the summary says so whether the
 * section is open or shut.
 */
function renderSendAdvSummary() {
  const el = $('#send-adv-sum');
  if (!el) return;
  const speed = sendSpeed();
  const parallel = $('#send-parallel').value.trim();
  const chunk = fieldOr('send-chunk', 'chunk');
  // A chunk size inherited from Settings is an override all the same — it is
  // on the command line — so the summary names it and says where it came from.
  const inherited = chunk && !$('#send-chunk').value.trim();
  const parts = [];
  if (parallel) parts.push(`--parallel ${parallel}`);
  if (chunk) parts.push(`--chunk ${chunk}${inherited ? ' (from Settings)' : ''}`);
  let text;
  if (!parts.length) {
    text = `— nothing set; --speed ${speed} sizes both`;
  } else if (parallel) {
    // Not "overrides --speed": there is no --speed on the command line to
    // override. Saying otherwise would leave the summary naming a flag the
    // preview below it does not show. See sendPresetInert.
    text = `— ${parts.join(' · ')}; the ${speed} preset is not used`;
  } else {
    // A typed chunk size really is half an override: the preset still supplies
    // the association count, so --speed stays on the line and the engine says
    // what it displaced.
    text = `— ${parts.join(' · ')} replaces that half of --speed ${speed}`;
  }

  // Retries, the timeout, the transfer syntax and the two switches moved under
  // here when this screen was trimmed. A flag folded away is still a flag on
  // the command line, so each one is named the moment it is set — including
  // the ones inherited from Settings, which are nobody's typing at all.
  const rest = [];
  const flag = (id, key, name) => {
    const v = fieldOr(id, key);
    if (v) rest.push(`${name} ${v}${$(`#${id}`).value.trim() ? '' : ' (from Settings)'}`);
  };
  flag('send-retry', 'retry', '--retry');
  flag('send-timeout', 'timeout', '--timeout');
  const syntax = $('#send-syntax').value;
  if (syntax) rest.push(`--transfer-syntax ${syntax}`);
  if ($('#send-norecurse').checked) rest.push('--no-recurse');
  if ($('#send-rewrite').checked) rest.push('--rewrite-series-uid');
  if (rest.length) text += ` · ${rest.join(' · ')}`;

  el.textContent = text;
  el.classList.toggle('changed', parts.length > 0 || rest.length > 0);
}

BUILDERS.send = () => {
  const folder = $('#send-folder').value.trim();
  const argv = ['send'];
  if (folder) argv.push(folder);
  argv.push(...connArgs());
  const parallel = $('#send-parallel').value.trim();
  const chunk = fieldOr('send-chunk', 'chunk');
  // The preset first, then the flag that can beat half of it, so the command
  // reads in the order the engine resolves it — except that a typed Parallel
  // beats all of it and the preset is left off entirely. See sendPresetInert
  // for why the flag cannot stay on the line once its width has been displaced.
  // --parallel 1 counts as typed: someone who typed it meant it.
  if (!parallel) argv.push('--speed', sendSpeed());
  if (parallel) argv.push('--parallel', parallel);
  if (chunk) argv.push('--chunk', chunk);
  const retry = fieldOr('send-retry', 'retry');
  const timeout = fieldOr('send-timeout', 'timeout');
  if (retry) argv.push('--retry', retry);
  if (timeout) argv.push('--timeout', timeout);
  const syntax = $('#send-syntax').value;
  if (syntax) argv.push('--transfer-syntax', syntax);
  if (rehearsal()) argv.push('--dry-run');
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
  $('#send-folder').addEventListener('input', updateAllPreviews);
  ['send-retry', 'send-timeout'].forEach((id) =>
    $(`#${id}`).addEventListener('input', () => { renderSendAdvSummary(); updateAllPreviews(); }));
  // The two override fields also move the Advanced summary, which is the only
  // thing on screen naming them while the disclosure is shut — and Parallel
  // decides whether the preset is on the command line at all, so the chip row
  // above has to be repainted from the same keystroke.
  ['send-chunk', 'send-parallel'].forEach((id) =>
    $(`#${id}`).addEventListener('input', () => {
      renderSendSpeed();
      renderSendAdvSummary();
      updateAllPreviews();
    }));
  for (const chip of $$('#send-speed .chip')) {
    chip.addEventListener('click', () => {
      $$('#send-speed .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderSendSpeed();
      renderSendAdvSummary();
      updateAllPreviews();
    });
  }
  renderSendSpeed();
  renderSendAdvSummary();
  $('#send-syntax').addEventListener('change', () => { renderSendAdvSummary(); updateAllPreviews(); });
  ['send-norecurse', 'send-rewrite'].forEach((id) =>
    $(`#${id}`).addEventListener('change', () => { renderSendAdvSummary(); updateAllPreviews(); }));

  $('#view-send [data-run]').addEventListener('click', async () => {
    const folder = $('#send-folder').value.trim();
    clearConsole('send');
    $('#view-send [data-totals]').hidden = true;
    if (!folder) { fail('send', 'Choose a folder to send.\n'); return; }
    const dry = rehearsal();
    if (!dry) {
      const miss = connMissing();
      if (miss.length) { fail('send', `Fill in the peer connection: ${miss.join(', ')}.\n`); return; }
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

  $('#view-send [data-cancel]').addEventListener('click', (e) => {
    stopRun('send', e.currentTarget);
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

/**
 * One line naming whatever the receiver's Advanced holds.
 *
 * Both of the controls under there change who gets in and what gets
 * acknowledged, which is the whole subject of this screen — so folding them
 * away is only allowed as long as the fold says what they hold.
 */
function renderReceiveAdvSummary() {
  const el = $('#receive-adv-sum');
  if (!el) return;
  const accept = $('#scp-accept').value.trim();
  const reject = $('#scp-rejectafter').value.trim();
  const parts = [];
  if (accept) parts.push(`only ${accept}`);
  if (reject) parts.push(`stops acknowledging after ${reject}`);
  el.textContent = parts.length ? `— ${parts.join(' · ')}` : '— accepts every caller, acknowledges everything';
  el.classList.toggle('changed', parts.length > 0);
}

function wireReceive() {
  ['scp-port', 'scp-ae', 'scp-persist', 'scp-accept', 'scp-rejectafter'].forEach((id) =>
    $(`#${id}`).addEventListener('input', () => { renderReceiveAdvSummary(); updateAllPreviews(); }));
  renderReceiveAdvSummary();

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

  $('#view-receive [data-cancel]').addEventListener('click', (e) => {
    stopRun('receive', e.currentTarget);
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
    if (miss.length) { fail('query', `Fill in the peer connection: ${miss.join(', ')}.\n`); return; }
    setStatus('query', 'running', 'Querying…');
    const argv = [...BUILDERS.query(), '--json'];
    const { code, stdout, stderr } = await runCapture('query', argv);
    setStatus('query', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try {
      renderFindResults(JSON.parse(stdout));
    } catch {
      const c = consoleEl('query'); c.hidden = false;
      revealConsole('query'); appendConsole('query', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
    }
  });
}

// --------------------------------------------------------------------------
// View: WORKLIST — the station
// --------------------------------------------------------------------------
// One screen, used the way an acquisition console is used: the list of what
// is scheduled, one selected patient, and a button whose label is the verb.
// The RIS peer, the station's AE Title and the default modality come from
// Settings; the images come from a folder; everything else on the command is
// read off the selected row, verbatim, and never guessed.
//
// Three commands run from here — the C-FIND, `mpps perform` (or `mpps start`)
// and the closing N-SET — and each has its own preview under its own button.
// The console at the bottom is shared: one workspace, one output pane.

/** Local YYYYMMDD, offset by whole days. DICOM dates are local, not UTC. */
function dicomDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function mwlWhen() {
  const active = $('#mwl-when .chip.active');
  return active ? active.dataset.when : 'today';
}

/** The date-matching value for the selected preset, or '' for any date. */
function mwlDateValue() {
  const when = mwlWhen();
  if (when === 'today') return dicomDate(0);
  if (when === 'tomorrow') return dicomDate(1);
  // Pick…: a day, a range (inclusive both ends), or blank for any date.
  return $('#mwl-date').value.trim();
}

const SEARCH_KEYS = ['PatientName', 'PatientID', 'AccessionNumber'];

/**
 * Which worklist key a search term is sent as, by the shape of the text.
 *
 * Digits alone are a patient ID; letters or a `^` are a name; anything mixed
 * — an accession like A1 or ACC-77 — is an accession number. The tag beside
 * the box says which was chosen, and clicking it overrides the guess.
 */
function guessSearchKey(text) {
  if (/^\d+$/.test(text)) return 'PatientID';
  if (/[\^*?]/.test(text) || /^[A-Za-z ,'-]+$/.test(text)) return 'PatientName';
  return 'AccessionNumber';
}

/** The one Key=Value the search box adds, or null when it is empty. */
function mwlSearchTerm() {
  const text = $('#mwl-search').value.trim();
  if (!text) return null;
  const key = state.mwl.searchKey || guessSearchKey(text);
  let value = text;
  // A name is matched anywhere in the name unless a wildcard was typed: a
  // console operator types the surname they were told, not DOE^JANE.
  if (key === 'PatientName' && !/[*?]/.test(text)) value = `*${text}*`;
  return { key, value };
}

function renderSearchKey() {
  const tag = $('#mwl-search-key');
  const term = mwlSearchTerm();
  tag.hidden = !term;
  if (term) {
    tag.textContent = term.key;
    tag.classList.toggle('pinned', Boolean(state.mwl.searchKey));
  }
}

BUILDERS.worklist = () => {
  const argv = ['find', ...connArgs(), '--mwl'];
  // Scheduling keys go in as ordinary pairs; the engine routes them into the
  // Scheduled Procedure Step Sequence where a conformant SCP expects them.
  const date = mwlDateValue();
  if (date) argv.push(`ScheduledProcedureStepStartDate=${date}`);
  const modality = $('#mwl-modality').value.trim();
  if (modality) argv.push(`Modality=${modality}`);
  // Only when Settings says "only this station's worklist": the engine warns
  // on a mismatch anyway, so by default the whole list is shown.
  const station = state.settings.onlyThisStation ? stationAe() : '';
  if (station) argv.push(`ScheduledStationAETitle=${station}`);
  const term = mwlSearchTerm();
  if (term) argv.push(`${term.key}=${term.value}`);
  // How many rows to ask for. Blank fetches the whole answer, which is what a
  // small department wants; a busy RIS being re-read every minute is the case
  // this exists for, so it is set once in Settings rather than per query.
  const limit = state.settings.worklistLimit;
  if (limit) argv.push('--limit', limit);
  return argv;
};

/** The Modality filter as a pill; the field behind it is what the builder reads. */
function renderModalityPill() {
  const v = $('#mwl-modality').value.trim();
  const pill = $('#mwl-modality-pill');
  pill.textContent = v || 'any modality';
  pill.classList.toggle('active', Boolean(v));
}

// ---------------- rows and pills ----------------

/**
 * The key a row is tracked by across refreshes.
 *
 * The study and the step within it when the SCP named a study; otherwise the
 * accession, the scheduled step and the patient, which is what an MWL row
 * carries when it names no study yet. Position is never part of a key that
 * survives a refresh: the SCP is free to return the same rows in a different
 * order, and a key that meant "the second row" would quietly re-point the
 * selection at a different patient. A row with nothing identifying on it at
 * all gets a positional key, and `stableKey` says it may not be re-bound.
 */
function rowKey(item, idx) {
  const step = attrOf(item, 'ScheduledProcedureStepID');
  const uid = attrOf(item, 'StudyInstanceUID');
  if (uid) return `${uid}|${step}`;
  const acc = attrOf(item, 'AccessionNumber');
  const pid = attrOf(item, 'PatientID');
  if (acc || step || pid) return `id:${acc}|${step}|${pid}`;
  return `idx:${idx}`;
}

/** Whether a key identifies a row rather than a position in the last answer. */
function stableKey(key) {
  return Boolean(key) && !String(key).startsWith('idx:');
}

/** Whether two worklist rows say the same thing about the same patient. */
function sameRowAttrs(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(worklistAttrs(a)) === JSON.stringify(worklistAttrs(b));
}

/**
 * The session step for a worklist row, or null.
 *
 * Matched on Study Instance UID, and on the scheduled step ID as well whenever
 * both sides name one. A partial match shows nothing rather than guessing: a
 * pill that named the wrong row would be exactly the false claim about the far
 * end this table is built to avoid. A row the SCP returned with no Study
 * Instance UID can never carry a pill, because there is nothing to key on.
 */
function stepFor(item) {
  if (!item) return null;
  if (item._memoryUid) return state.steps.entries.find((e) => e.mppsUid === item._memoryUid) || null;
  const uid = attrOf(item, 'StudyInstanceUID');
  if (!uid) return null;
  const stepId = attrOf(item, 'ScheduledProcedureStepID');
  // Newest first, so a re-performed study shows what happened most recently.
  return state.steps.entries.find((e) => e.studyInstanceUid === uid
    && (!stepId || !e.scheduledStepId || e.scheduledStepId === stepId)) || null;
}

const PILL_TITLE = 'What this app sent from this window, in this session — not what the RIS shows.';

/** The status pill for a row: (none) | IN PROGRESS | COMPLETED n/n | DISCONTINUED n/n. */
function rowPill(item) {
  const e = stepFor(item);
  if (!e) return '';
  const c = e.counts || {};
  const counts = (c.acknowledged != null && c.found != null) ? ` ${c.acknowledged}/${c.found}` : '';
  const cls = e.status === 'COMPLETED' ? 'ok' : e.status === 'DISCONTINUED' ? 'bad' : 'warn';
  return `<span class="pill session ${cls}" title="${PILL_TITLE}">${esc(e.status)}${esc(counts)}</span>`;
}

/**
 * A row for a step this app opened that no row in the results accounts for.
 *
 * A step left IN PROGRESS has to stay reachable even when the query that
 * produced its row has been replaced — the only place its UID is remembered
 * is this window. It is drawn from memory, dimmed, and says so.
 */
function memoryItem(e) {
  return {
    _memoryUid: e.mppsUid,
    PatientName: e.patientName, PatientID: e.patientId, Modality: e.modality,
    AccessionNumber: e.accessionNumber, StudyInstanceUID: e.studyInstanceUid,
    ScheduledProcedureStepID: e.scheduledStepId,
    RequestedProcedureDescription: e.description,
  };
}

/** The rows on screen: the SCP's matches, then any open step the results do not show. */
function stationRows() {
  const rows = state.mwl.matches.map((item, idx) => ({ item, key: rowKey(item, idx) }));
  const shown = new Set(rows.map((r) => stepFor(r.item)).filter(Boolean).map((e) => e.mppsUid));
  for (const e of state.steps.entries) {
    if (e.status === 'IN PROGRESS' && !shown.has(e.mppsUid)) {
      rows.push({ item: memoryItem(e), key: `mem:${e.mppsUid}`, memory: true });
    }
  }
  if (state.mwl.filterOpen) {
    return rows.filter((r) => { const e = stepFor(r.item); return e && e.status === 'IN PROGRESS'; });
  }
  return rows;
}

/** A Date as HH:MM, the way the status chip prints the last read. */
const fmtClock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const fmtTime = (t) => {
  const s = String(t || '').replace(/[^0-9]/g, '');
  return s.length < 4 ? s : `${s.slice(0, 2)}:${s.slice(2, 4)}`;
};
const fmtDate = (d) => {
  const s = String(d || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

/** Draws the list. The selection survives: rows are matched by key, not position. */
function renderWorklistTable() {
  const box = $('#mwl-results');
  const rows = stationRows();
  const selKey = state.mwl.selected ? state.mwl.selected.key : null;

  // A query that failed is not an empty worklist, and the difference is the
  // whole screen: "nothing scheduled" sends the operator to the patient, and
  // "the RIS did not answer" sends them to the phone.
  const failed = state.mwl.error
    ? `<div class="folder-check bad list-error"><b>The worklist could not be read.</b> ${esc(state.mwl.error)}</div>`
    : '';

  if (!rows.length) {
    box.innerHTML = failed || `<div class="empty-note dense">${state.mwl.filterOpen
      ? 'No open steps.'
      : (state.mwl.fetched ? 'Nothing scheduled for this query.' : '')}</div>`;
    return;
  }

  // Rows survived a failed read: they are the last answer, not this one.
  const stale = failed
    ? `<div class="empty-note dense">Showing the last list that was read${state.mwl.at ? `, at ${esc(fmtClock(state.mwl.at))}` : ''}.</div>`
    : '';

  // The date is printed per row only when the query can span more than one day.
  const showDate = mwlWhen() === 'custom';
  const html = rows.map((r) => {
    const m = r.item;
    const procedure = m.RequestedProcedureDescription || m.ScheduledProcedureStepDescription || '';
    const on = r.key === selKey;
    return `<tr class="pick-row ${r.memory ? 'memory' : ''} ${on ? 'row-selected' : ''}" data-key="${esc(r.key)}" tabindex="0" role="button" aria-pressed="${on}"
      ${r.memory ? 'title="Not in the current results — remembered from this session"' : ''}>
      <td class="pick-cell"><span class="pick-dot"></span></td>
      <td class="when">${showDate ? `${esc(fmtDate(m.ScheduledProcedureStepStartDate))} ` : ''}${esc(fmtTime(m.ScheduledProcedureStepStartTime))}</td>
      <td><span class="pill ${m.Modality === 'CT' ? 'ct' : ''}">${esc(m.Modality || '?')}</span></td>
      <td title="${esc(m.PatientName || '')}">${esc(m.PatientName || '')}</td>
      <td class="mono">${esc(m.PatientID || '')}</td>
      <td class="mono">${esc(m.AccessionNumber || '')}</td>
      <td title="${esc(procedure)}">${esc(procedure)}</td>
      <td class="session-cell">${rowPill(m)}</td>
    </tr>`;
  }).join('');

  box.innerHTML = failed + stale +
    '<div class="table-scroll"><table id="mwl-table">' +
    '<colgroup><col style="width:26px"><col style="width:100px"><col style="width:80px">' +
    '<col style="width:150px"><col style="width:96px"><col style="width:96px">' +
    '<col><col style="width:150px"></colgroup>' +
    '<thead><tr><th class="pick-cell"></th><th>Scheduled</th><th>Modality</th><th>Patient</th>' +
    '<th>Patient ID</th><th>Accession</th><th>Procedure</th><th>Status</th></tr></thead>' +
    `<tbody>${html}</tbody></table></div>`;
  for (const tr of $$('#mwl-table tr.pick-row')) tr.classList.toggle('row-selected', tr.dataset.key === selKey);
}

/**
 * Repaints just the pill column and the open-steps chip. Called after a run
 * and after a close; it touches the last cell of each row and nothing else,
 * so the SCP's own data in the other columns stays exactly as returned.
 */
function refreshRowPills() {
  const rows = stationRows();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let stale = false;
  for (const tr of $$('#mwl-table tr.pick-row')) {
    const r = byKey.get(tr.dataset.key);
    if (!r) { stale = true; continue; }
    tr.querySelector('td.session-cell').innerHTML = rowPill(r.item);
    byKey.delete(tr.dataset.key);
  }
  // A memory row appeared or went away: the row set itself changed.
  if (stale || byKey.size) renderWorklistTable();
  renderOpenChip();
}

/** "Open steps: N" — a filter, and the one place a stranded step is counted. */
function renderOpenChip() {
  const chip = $('#mwl-open-chip');
  const open = state.steps.entries.filter((e) => e.status === 'IN PROGRESS').length;
  if (!open && state.mwl.filterOpen) { state.mwl.filterOpen = false; renderWorklistTable(); }
  chip.hidden = !open;
  chip.textContent = `Open steps: ${open}`;
  chip.classList.toggle('active', state.mwl.filterOpen);
  chip.setAttribute('aria-pressed', state.mwl.filterOpen ? 'true' : 'false');
}

/**
 * Takes a fresh answer from the SCP. The list is replaced wholesale; the
 * selection is kept by key, so an auto-refresh under the operator's hands
 * never un-picks the patient they are about to perform. A selected row the
 * SCP no longer returns stays selected from memory: some SCPs withhold an
 * item once its step completes, and the outcome on screen still names it.
 */
function renderWorklist(json) {
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  state.mwl.matches = matches;
  state.mwl.fetched = true;
  state.mwl.error = null;
  state.mwl.at = new Date();
  const sel = state.mwl.selected;
  if (sel) {
    // Only a key that identifies a row may be re-bound. A positional one is
    // dropped instead: the patient the operator picked stays on screen from
    // memory, detached from the list, rather than the panel being re-pointed
    // at whoever now occupies that position.
    const idx = stableKey(sel.key) ? matches.findIndex((m, i) => rowKey(m, i) === sel.key) : -1;
    if (idx >= 0) {
      const prev = sel.item;
      sel.item = matches[idx];
      // The SCP may return the same row with different attributes. Everything
      // selectRow seeded came off the row, so it is re-seeded here too — the
      // alternative is a command mixing this answer with the last one.
      if (!sameRowAttrs(prev, sel.item)) {
        seedRowFields(sel.item, { prev });
        checkMppsFolder();
      }
    } else if (!stableKey(sel.key)) {
      state.mwl.detached = true;
      sel.key = 'mem:selection';
    }
  }
  renderWorklistTable();
  renderOpenChip();
  // A refresh can change every attribute the commands are built from, so the
  // previews are rebuilt with the list. Nothing may run a command the screen
  // is not showing.
  renderMppsPanel();
  updateAllPreviews();
}

// ---------------- selection ----------------

function selectedWorklistItem() {
  return state.mwl.selected ? state.mwl.selected.item : null;
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
 * The attributes a selected row hands to `dcm mpps`.
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
    startTime: attrOf(item, 'ScheduledProcedureStepStartTime'),
  };
}

/** One "key / value" cell, amber when the SCP returned nothing for it. */
function attrCell(label, value, missingLabel = 'not returned by the SCP') {
  const has = value !== '';
  return `<div class="attr ${has ? '' : 'missing'}">` +
    `<div class="attr-k">${esc(label)}</div>` +
    `<div class="attr-v">${esc(has ? value : `— ${missingLabel} —`)}</div></div>`;
}

/** 'perform' | 'close' | null — decided by whether this app holds the row's step open. */
function panelMode() {
  const item = selectedWorklistItem();
  if (!item) return null;
  const e = stepFor(item);
  return e && e.status === 'IN PROGRESS' ? 'close' : 'perform';
}

/**
 * Everything on the panel that comes off the row, seeded from the row.
 *
 * Called when a row is picked and again whenever a refresh replaces the row
 * behind the selection: every one of these fields ends up on the command, so
 * leaving one behind would build a command out of two different patients.
 * The folder is one of them — a different patient's images are not this
 * patient's — unless the same study is still on the row, or the row's step
 * was opened by this app with a folder it already sent.
 */
function seedRowFields(item, { prev = null } = {}) {
  const a = worklistAttrs(item);
  const stepId = $('#mpps-stepid');
  stepId.value = a.scheduledStepId;
  delete stepId.dataset.touched;
  const desc = $('#mpps-stepdesc');
  desc.value = a.scheduledStepDescription || a.requestedProcedureDescription;
  delete desc.dataset.touched;
  // The performed station AE follows the station's own AE Title again: a hand
  // edit belongs to the patient it was made for, not to the rest of the day.
  delete $('#mpps-stationae').dataset.touched;
  syncStationAe();

  const e = stepFor(item);
  const keep = prev
    && attrOf(prev, 'StudyInstanceUID') === attrOf(item, 'StudyInstanceUID')
    && attrOf(prev, 'PatientID') === attrOf(item, 'PatientID');
  const folder = $('#mpps-folder');
  if (e && e.status === 'IN PROGRESS' && e.folder) folder.value = e.folder;
  else if (!keep) folder.value = '';
  $('#steps-series').checked = Boolean(e && e.folder) && stepFullyAcknowledged(e);
}

function selectRow(key) {
  const row = stationRows().find((r) => r.key === key);
  if (!row) return;
  const same = state.mwl.selected && state.mwl.selected.key === key;
  state.mwl.selected = { key, item: row.item };
  state.mwl.detached = false;
  for (const tr of $$('#mwl-table tr.pick-row')) {
    const on = tr.dataset.key === key;
    tr.classList.toggle('row-selected', on);
    tr.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) tr.scrollIntoView({ block: 'nearest' });
  }
  if (same) return;

  // A new patient: the last run's verdict was about someone else.
  $('#mpps-outcome').hidden = true;
  $('#mpps-totals').hidden = true;
  setStatus('mpps', null);
  setStatus('steps', null);
  state.steps.armed = false;

  seedRowFields(row.item);

  renderMppsPanel();
  updateAllPreviews();
  // A different row is a different study, so whatever was concluded about the
  // chosen folder no longer applies to it.
  checkMppsFolder();
  const folder = $('#mpps-folder');
  if (!folder.value.trim()) folder.focus();
}

function clearSelection() {
  state.mwl.selected = null;
  state.mwl.detached = false;
  state.mpps.mismatch = null;
  state.mpps.scan = null;
  state.steps.armed = false;
  for (const tr of $$('#mwl-table tr.pick-row')) {
    tr.classList.remove('row-selected');
    tr.setAttribute('aria-pressed', 'false');
  }
  renderMppsPanel();
  updateAllPreviews();
}

// ---------------- fetching ----------------

const MWL_AUTO_MS = 60000;

/**
 * Reads the worklist. `auto` marks the timer's own reads: they are quieter —
 * no console reset — and they step aside while a step is being performed or
 * closed, because a list repaint under a running transaction helps nobody.
 */
async function fetchWorklist({ auto = false } = {}) {
  if (state.activeRuns.worklist) return;
  if (auto && (state.activeRuns.mpps || state.activeRuns.steps)) return;
  const miss = connMissing();
  if (miss.length) {
    if (auto) return;
    const c = consoleEl('worklist'); resetConsole(c); c.hidden = false;
    revealConsole();
    appendConsole('worklist', `No RIS peer: give a saved peer the RIS role in Settings, or pick one on the chip (missing ${miss.join(', ')}).\n`, 'stderr');
    return;
  }
  setStatus('worklist', 'running', 'Fetching…');
  const { code, stdout, stderr } = await runCapture('worklist', [...BUILDERS.worklist(), '--json']);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // Zero matches is an answer, not a failure: the engine says so and exits 1
  // with a parseable result. Everything else that exits 1 — a refused
  // association, a timeout, an unreachable host — is a failure, and the
  // engine's own verdict is what says which. It has to be read from `ok` and
  // `outcome`, never from the shape of `matches`: a network failure carries an
  // empty matches array too, and reading that as an answer paints a fresh
  // green clock over a RIS that is down.
  let json = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  const answered = Boolean(json) && (json.ok === true || json.outcome === 'empty'
    || (json.ok === undefined && Array.isArray(json.matches)));
  if (answered) {
    // The list is drawn before the clock turns green: a green clock over a
    // list that could not be drawn is the same lie as one over a RIS that
    // never answered.
    try {
      renderWorklist(json);
      setStatus('worklist', 'ok', hhmm);
    } catch (err) {
      setStatus('worklist', 'fail', 'Failed');
      const c = consoleEl('worklist'); resetConsole(c); c.hidden = false;
      revealConsole();
      appendConsole('worklist', `The worklist was read but could not be drawn: ${err.message}`, 'stderr');
    }
  } else {
    // Said where the list is, not only in a console nobody opened.
    state.mwl.error = (json && json.message)
      || stripAnsi(stderr).trim().split('\n').filter(Boolean).pop()
      || 'The worklist could not be read.';
    state.mwl.fetched = true;
    setStatus('worklist', 'fail', 'Failed');
    renderWorklistTable();
    const c = consoleEl('worklist'); resetConsole(c); c.hidden = false;
    if (!auto) revealConsole();
    appendConsole('worklist', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
  }
}

/** Runs the auto-refresh only while the station is the screen on view and the toggle is on. */
function stationVisibility(visible) {
  clearInterval(state.mwl.timer);
  state.mwl.timer = null;
  if (!visible) return;
  if (!state.mwl.fetched && !connMissing().length) fetchWorklist({ auto: true });
  if ($('#mwl-auto').checked) {
    state.mwl.timer = setInterval(() => fetchWorklist({ auto: true }), MWL_AUTO_MS);
  }
}

function wireWorklist() {
  for (const chip of $$('#mwl-when .chip')) {
    chip.addEventListener('click', () => {
      $$('#mwl-when .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const custom = chip.dataset.when === 'custom';
      $('#mwl-date').hidden = !custom;
      if (custom) $('#mwl-date').focus();
      updateAllPreviews();
      if (!custom) fetchWorklist();
    });
  }
  $('#mwl-date').addEventListener('input', updateAllPreviews);
  $('#mwl-date').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchWorklist(); });

  // The modality pill opens the field; leaving the field closes it.
  const pill = $('#mwl-modality-pill');
  const field = $('#mwl-modality');
  pill.addEventListener('click', () => {
    pill.hidden = true;
    field.hidden = false;
    field.focus();
    field.select();
  });
  const closeModality = () => {
    field.hidden = true;
    pill.hidden = false;
    renderModalityPill();
    updateAllPreviews();
    fetchWorklist();
  };
  field.addEventListener('blur', closeModality);
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') field.blur(); });
  field.addEventListener('input', () => { renderModalityPill(); updateAllPreviews(); });
  renderModalityPill();

  const search = $('#mwl-search');
  search.addEventListener('input', () => {
    if (!search.value.trim()) state.mwl.searchKey = null;
    renderSearchKey();
    updateAllPreviews();
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchWorklist(); });
  $('#mwl-search-key').addEventListener('click', () => {
    const cur = mwlSearchTerm();
    if (!cur) return;
    state.mwl.searchKey = SEARCH_KEYS[(SEARCH_KEYS.indexOf(cur.key) + 1) % SEARCH_KEYS.length];
    renderSearchKey();
    updateAllPreviews();
  });

  $('#mwl-run').addEventListener('click', () => fetchWorklist());
  $('#mwl-auto').addEventListener('change', () => stationVisibility(state.activeView === 'worklist'));
  $('#mwl-open-chip').addEventListener('click', () => {
    state.mwl.filterOpen = !state.mwl.filterOpen;
    renderWorklistTable();
    renderOpenChip();
  });

  // The ? and its panel are wired by wireHelp, along with every other screen's.

  // Delegated, because the table's innerHTML is replaced on every fetch.
  const results = $('#mwl-results');
  results.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.pick-row');
    if (tr) selectRow(tr.dataset.key);
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
    selectRow(tr.dataset.key);
  });
  $('#mwl-clearsel').addEventListener('click', clearSelection);
}

// --------------------------------------------------------------------------
// The selected patient — `dcm mpps perform` / `dcm mpps start`
// --------------------------------------------------------------------------
/**
 * Where the images go: the saved peer holding the Archive role, else the RIS
 * peer itself. Both peers are always written out in full on the command —
 * `dcm mpps perform` defaults each --store-* to the MPPS peer, but a default
 * you cannot see is a default nobody can check, and sending images to the
 * RIS by accident is the exact mistake this screen exists to prevent.
 */
function mppsStore() {
  const p = profileForRole('archive');
  if (p) return { host: p.host || '', port: String(p.port || ''), calledAe: p.calledAe || '', name: 'Archive' };
  return { host: state.conn.host, port: String(state.conn.port || ''), calledAe: state.conn.calledAe, name: 'RIS' };
}

/** The Performed Station AE Title: Type 1, and Settings' station AE unless overridden. */
function syncStationAe() {
  const station = $('#mpps-stationae');
  if (!station.dataset.touched) station.value = state.conn.callingAe || 'DCM-CLI';
}

/**
 * A fresh MPPS SOP Instance UID.
 *
 * The app mints this rather than letting the engine mint one so that the UID
 * is known BEFORE the run: it appears in the command preview, where it can be
 * read and copied, and it is the handle the session's step list is keyed on
 * even when the run's output cannot be parsed. 2.25.<128-bit integer> is the
 * UUID-derived form from PS3.5 B.2 — no registered root is needed.
 */
function newMppsUid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) n = 1n;
  return `2.25.${n.toString()}`;
}

/** The UID the next run will use. Held so the preview and the run agree. */
function mppsNextUid() {
  if (!state.mpps.nextUid) state.mpps.nextUid = newMppsUid();
  return state.mpps.nextUid;
}

/**
 * Which way past a study mismatch applies, or null when there is none.
 *
 * Null unless a real single-study mismatch was detected, so neither flag can
 * be added to a command that does not need one. The station re-stamps, as a
 * modality would; sending as-is exists only while Settings > Engineer options
 * allows it, and then it is a two-way switch under the folder line.
 */
function mppsFix() {
  const m = state.mpps.mismatch;
  if (!m || m.kind !== 'one-study') return null;
  if (!state.settings.allowMismatch) return 'adopt';
  return state.mpps.fix === 'asis' ? 'asis' : 'adopt';
}

/** Serial number of the newest folder scan, so a stale one cannot land. */
let mppsScanToken = 0;

/**
 * Reads the chosen folder and compares its study with the worklist row's.
 *
 * The engine refuses a mismatch, and that refusal is right: a step naming one
 * study while the images belong to another never reconciles. But a refusal
 * arriving as a wall of stderr after a run is a bad way to learn that, so the
 * comparison happens here, before anything is sent, and the folder line says
 * what will happen. `dcm info --json` is read-only.
 */
async function checkMppsFolder() {
  const folder = $('#mpps-folder').value.trim();
  const item = selectedWorklistItem();
  const token = ++mppsScanToken;

  state.mpps.mismatch = null;
  state.mpps.scan = null;
  // The folder an open step already sent was scanned when it was sent; there
  // is nothing new to conclude about it.
  const open = stepsSelected();
  if (!folder || !item || (open && open.folder === folder)) {
    renderFolderLine(); applyVerbGuards(); updateAllPreviews(); return;
  }

  // The verbs go dead for as long as this takes: until the folder has been
  // read, nothing on screen knows whose images these are.
  state.mpps.scan = { reading: true };
  renderFolderLine();
  applyVerbGuards();

  // Bounded, because a lost exit event must not leave the panel reading
  // "Reading the folder…" for the rest of the session. This scan is advisory:
  // the engine still refuses a real mismatch on its own, and the run handler
  // turns that refusal back into the same line, so giving up here loses a
  // convenience, never a safeguard.
  const scanned = await Promise.race([
    runCapture('mpps-scan', ['info', folder, '--json']),
    new Promise((r) => setTimeout(() => r(null), 20000)),
  ]);
  if (token !== mppsScanToken) return;

  let scan = null;
  if (scanned) { try { scan = JSON.parse(scanned.stdout); } catch { scan = null; } }
  const studies = Array.isArray(scan?.studies) ? scan.studies : null;

  if (!scanned) {
    state.mpps.scan = { warn: 'This folder is taking too long to read, so it has not been checked against this row. The exam still checks the images when it runs, and refuses them if they are a different study.' };
  } else if (!studies) {
    state.mpps.scan = { warn: 'This folder could not be read. Running the exam says exactly why.' };
  } else if (studies.length === 0) {
    state.mpps.scan = { warn: `No DICOM instances here (${scan.filesExamined} files examined).` };
  } else {
    const instances = studies.reduce((n, s) => n + (s.instanceCount || 0), 0);
    const modalities = [...new Set(studies.flatMap((s) => s.modalities || []))].join('+');
    state.mpps.scan = { instances, modalities, studies: studies.length };
    const declared = worklistAttrs(item).studyInstanceUid;
    if (studies.length > 1) {
      state.mpps.mismatch = { kind: 'many', studies };
    } else if (declared && declared !== studies[0].studyInstanceUid) {
      state.mpps.mismatch = { kind: 'one-study', declared, onDisk: studies[0].studyInstanceUid };
      state.mpps.fix = 'adopt';
    }
  }
  renderFolderLine();
  applyVerbGuards();
  updateAllPreviews();
}

/**
 * One line under the folder: what it holds, and what will be done with it.
 * It states the outcome rather than asking — the station re-stamps a copy of
 * a different study the way a modality would. The only choice offered is
 * the engineer's, and only when Settings turned it on.
 */
function renderFolderLine() {
  const box = $('#mpps-folder-check');
  const sw = $('#mpps-fix-switch');
  const s = state.mpps.scan;
  const m = state.mpps.mismatch;
  sw.hidden = true;
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  if (s.reading) { box.className = 'folder-check'; box.textContent = 'Reading the folder…'; return; }
  if (s.warn) { box.className = 'folder-check warn'; box.textContent = s.warn; return; }

  // Where the images go, by AE Title: the command names it in full. When no
  // saved peer holds the Archive role they go to the RIS, and that is said.
  const store = mppsStore();
  const to = store.name === 'Archive' ? `→ ${store.calledAe}` : `→ ${store.calledAe || '?'} (no Archive peer set)`;
  const what = `${s.instances} instance${s.instances === 1 ? '' : 's'}${s.modalities ? ` ${s.modalities}` : ''}`;

  if (m && m.kind === 'many') {
    box.className = 'folder-check bad';
    box.innerHTML = `<b>${esc(s.studies)} studies</b> in this folder — one step describes exactly one. Split the folder.`;
    return;
  }
  if (m && m.kind === 'one-study') {
    // Closing a step is not performing one: `dcm send` has no re-stamping in
    // it, so images added to an open step go to the archive exactly as they
    // are. There is no copy, so the line must not promise one — and the
    // Complete button is blocked while a folder like this is chosen.
    if (panelMode() === 'close') {
      box.className = 'folder-check bad';
      box.innerHTML = `${esc(what)} ${esc(to)} · <b>a different study.</b> Added to this step they would be filed under their own study, ` +
        'not this step\'s, and the two would never reconcile. Clear the folder to complete without them, or perform this study as its own exam.';
      return;
    }
    box.className = 'folder-check warn';
    if (state.settings.allowMismatch) {
      sw.hidden = false;
      for (const c of $$('#mpps-fix-switch .chip')) c.classList.toggle('active', c.dataset.fix === mppsFix());
      box.innerHTML = `${esc(what)} ${esc(to)} · a different study — ` + (mppsFix() === 'asis'
        ? '<b>sent as-is: the step names one study, the images another. Nothing reconciles afterwards.</b>'
        : 'sent carrying this worklist\'s identity (a re-stamped copy; your folder is not modified).');
    } else {
      box.innerHTML = `${esc(what)} ${esc(to)} · a different study — sent carrying this worklist's identity (a re-stamped copy; your folder is not modified).`;
    }
    return;
  }
  box.className = 'folder-check ok';
  const declared = worklistAttrs(selectedWorklistItem()).studyInstanceUid;
  box.textContent = declared
    ? `${what} · matches this ${panelMode() === 'close' ? 'step' : 'row'} ${to}`
    : `${what} ${to} · the row named no study, so the step adopts the images'`;
}

/** The attributes every `mpps` verb takes off the row, in one place. */
function pushRowAttrs(argv, a) {
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

/** The performed-step fields: seeded from the row and Settings, editable under Details. */
function pushStepFields(argv) {
  const stepId = $('#mpps-stepid').value.trim();
  if (stepId) argv.push('--step-id', stepId);
  const station = $('#mpps-stationae').value.trim();
  if (station) argv.push('--station-ae', station);
  const stepDesc = $('#mpps-stepdesc').value.trim();
  if (stepDesc) argv.push('--step-description', stepDesc);
  // The step's own UID, minted here so it is visible before the run rather
  // than only afterwards in the report.
  argv.push('--mpps-uid', mppsNextUid());
}

BUILDERS.mpps = () => {
  // Builders run on every keystroke anywhere, which makes this the one hook
  // that catches a change to the peer or the station AE too.
  syncStationAe();

  const argv = ['mpps', 'perform'];
  const folder = $('#mpps-folder').value.trim();
  if (folder) argv.push(folder);
  argv.push(...connArgs());

  const store = mppsStore();
  if (store.host) argv.push('--store-host', store.host);
  if (store.port) argv.push('--store-port', store.port);
  if (store.calledAe) argv.push('--store-called-ae', store.calledAe);

  const a = worklistAttrs(selectedWorklistItem());
  if (a) pushRowAttrs(argv, a);
  pushStepFields(argv);

  // Exactly one of these, and only when a mismatch was actually found.
  const fix = mppsFix();
  if (fix === 'adopt') argv.push('--adopt-worklist-identity');
  else if (fix === 'asis') argv.push('--allow-study-mismatch');

  const chunk = fieldOr('mpps-chunk', 'chunk');
  if (chunk) argv.push('--chunk', chunk);
  const retry = fieldOr('mpps-retry', 'retry');
  if (retry) argv.push('--retry', retry);
  const retrieveAe = fieldOr('mpps-retrieveae', 'retrieveAe');
  if (retrieveAe) argv.push('--retrieve-ae', retrieveAe);
  const timeout = state.settings.defaults.timeout;
  if (timeout) argv.push('--timeout', timeout);
  if ($('#mpps-norecurse').checked) argv.push('--no-recurse');
  if (mppsDryRun()) argv.push('--dry-run');
  return argv;
};

/** `dcm mpps start`: the same step, opened and left IN PROGRESS. No folder, no archive. */
function mppsStartArgv() {
  syncStationAe();
  const argv = ['mpps', 'start', ...connArgs()];
  const a = worklistAttrs(selectedWorklistItem());
  if (a) pushRowAttrs(argv, a);
  pushStepFields(argv);
  const timeout = state.settings.defaults.timeout;
  if (timeout) argv.push('--timeout', timeout);
  if (mppsDryRun()) argv.push('--dry-run');
  return argv;
}

/** Whether the perform is a rehearsal: one switch in Settings, and the banner says so. */
function mppsDryRun() {
  return rehearsal();
}

/** The Details summary: what the SCP returned, and any override that is not a default. */
function renderMppsAdvSummary() {
  const el = $('#mpps-adv-sum');
  if (!el) return;
  const a = worklistAttrs(selectedWorklistItem());
  const parts = [];
  if (a) {
    const cells = attrCells(a);
    parts.push(`${cells.filter(([, v]) => v !== '').length}/${cells.length} attributes`);
    const stepId = $('#mpps-stepid').value.trim();
    if (stepId && stepId !== a.scheduledStepId) parts.push(`step ID ${stepId}`);
    const desc = $('#mpps-stepdesc').value.trim();
    if (desc && desc !== (a.scheduledStepDescription || a.requestedProcedureDescription)) parts.push(`description "${desc}"`);
  }
  const station = $('#mpps-stationae').value.trim();
  if (station && station !== (state.conn.callingAe || 'DCM-CLI')) parts.push(`station AE ${station}`);
  for (const [id, label] of [['mpps-chunk', 'chunk'], ['mpps-retry', 'retries'], ['mpps-retrieveae', 'retrieve AE']]) {
    const v = $(`#${id}`).value.trim();
    if (v) parts.push(`${label} ${v}`);
  }
  if ($('#mpps-norecurse').checked !== !state.settings.defaults.recurse) parts.push($('#mpps-norecurse').checked ? 'no recursion' : 'recursing');
  el.textContent = parts.length ? `· ${parts.join(' · ')}` : '';
  el.classList.toggle('changed', parts.length > 1);
}

function attrCells(a) {
  return [
    ['Patient', a.patientName], ['Patient ID', a.patientId],
    ['Patient birth date', a.patientBirthDate], ['Patient sex', a.patientSex],
    ['Accession', a.accessionNumber], ['Modality', a.modality],
    ['Scheduled step ID', a.scheduledStepId], ['Requested procedure ID', a.requestedProcedureId],
    ['Procedure', a.requestedProcedureDescription || a.scheduledStepDescription],
    ['Scheduled station AE', a.scheduledStationAe], ['Study Instance UID', a.studyInstanceUid],
  ];
}

/** Who, what, when — off the row. One line, one secondary line, the study UID. */
function renderPatientBanner() {
  const item = selectedWorklistItem();
  const a = worklistAttrs(item);
  if (!a) return;
  const chip = (value, missing) => (value ? `<span>${esc(value)}</span>` : `<span class="miss">— ${esc(missing)} —</span>`);
  const sep = '<span class="hero-sep">·</span>';
  $('#mpps-hero-main').innerHTML =
    chip(a.patientName, 'no patient name') + sep + chip(a.modality, 'no modality') + sep +
    chip(a.requestedProcedureDescription || a.scheduledStepDescription, 'no procedure') +
    (a.accessionNumber ? sep + `<span class="mono">${esc(a.accessionNumber)}</span>` : '') +
    (a.startTime ? sep + `<span class="mono">${esc(fmtTime(a.startTime))}</span>` : '');
  const sub = [];
  if (a.patientId) sub.push(`<span class="mono">${esc(a.patientId)}</span>`);
  if (a.patientSex) sub.push(esc(a.patientSex));
  if (a.patientBirthDate) sub.push(esc(fmtDate(a.patientBirthDate)));
  if (a.scheduledStepId) sub.push(`step <span class="mono">${esc(a.scheduledStepId)}</span>`);
  if (a.requestedProcedureId) sub.push(`<span class="mono">${esc(a.requestedProcedureId)}</span>`);
  if (a.scheduledStationAe) sub.push(`station <span class="mono">${esc(a.scheduledStationAe)}</span>`);
  $('#mpps-hero-sub').innerHTML = sub.join(sep);
  $('#mpps-hero-uid').innerHTML = a.studyInstanceUid
    ? `<code>${esc(a.studyInstanceUid)}</code>`
    : '<span class="miss">— no Study Instance UID returned by the SCP —</span>';

  // In closing mode the banner also says where the step is open, because the
  // N-SET goes where the N-CREATE went, not wherever the chip points now.
  const e = stepFor(item);
  const note = $('#mpps-hero-note');
  if (e && e.status === 'IN PROGRESS') {
    const c = e.counts || {};
    const peer = e.peer && e.peer.host ? `${e.peer.calledAe || '?'} @ ${e.peer.host}:${e.peer.port || '?'}` : '?';
    note.hidden = false;
    note.innerHTML = `<span class="pill session warn">IN PROGRESS</span> on <b>${esc(peer)}</b> since ${esc(formatStepWhen(e))}` +
      (c.acknowledged != null ? ` · ${esc(String(c.acknowledged))}/${esc(String(c.found))} acknowledged` : '');
  } else {
    note.hidden = true;
  }
}

/** Fills the panel from the selected row, in whichever mode the row's step puts it. */
function renderMppsPanel() {
  const mode = panelMode();
  $('#mwl-detail-body').hidden = mode === null;
  $('#mwl-detail-empty').hidden = mode !== null;
  $('#mwl-detail').classList.toggle('open', mode !== null);
  if (mode === null) return;

  renderPatientBanner();
  const a = worklistAttrs(selectedWorklistItem());
  const e = stepFor(selectedWorklistItem());
  const closing = mode === 'close';

  $('#mpps-attrs').innerHTML = attrCells(a).map(([k, v]) => attrCell(k, v)).join('');

  // What the RIS left out that this exam still needs. Inline and amber, never
  // behind a disclosure: the step ID stops the exam outright, and that cannot
  // be something you discover by opening one. Said in the words of the room —
  // the conformance names for these are in the help panel.
  const notes = [];
  if (!closing) {
    if (!a.studyInstanceUid) notes.push('This row names no <b>study</b>. The exam takes it from the folder, if the folder holds exactly one.');
    if (!a.modality) notes.push('This row names no <b>modality</b>. The exam takes it from the folder, if the folder names one.');
    if (!$('#mpps-stepid').value.trim()) {
      notes.push('<b>This step has no ID.</b> The worklist didn\'t send one — type it in below, or ask the RIS to fill it in. The exam can\'t be started without it.');
      $('#mpps-adv').open = true; // the field that fixes it lives there
    }
    if (!$('#mpps-stationae').value.trim()) {
      notes.push('<b>This station has no AE Title.</b> Set it in Settings, or type one below — it is what the RIS files this exam under.');
      $('#mpps-adv').open = true;
    }
  }
  const warn = $('#mpps-type1-warn');
  warn.hidden = notes.length === 0;
  warn.innerHTML = notes.join('<br>');

  // The list may no longer say which row this patient is; the panel says so
  // rather than the selection quietly moving to whoever is there now.
  const detached = $('#mwl-detached-note');
  detached.hidden = !state.mwl.detached;
  if (state.mwl.detached) {
    detached.innerHTML = 'This patient is held from the last list that was read. The rows the RIS returns carry nothing that identifies them, so the list cannot say which row this is. Refresh and pick again before performing.';
  }

  // The verbs. Perform mode: Perform exam / Start only. Close mode: Complete /
  // Discontinue, and the folder is either the one already sent or one to add.
  const dry = mppsDryRun();
  $('#mpps-run').hidden = closing;
  $('#mpps-start').hidden = closing;
  $('#mpps-cmd-fold').hidden = closing;
  $('#steps-close-run').hidden = !closing;
  $('#steps-discontinue').hidden = !closing;
  $('#steps-cmd-fold').hidden = !closing;
  $('#mpps-run').textContent = dry ? 'Rehearse exam' : 'Perform exam';
  $('#mpps-start').textContent = dry ? 'Rehearse start' : 'Start only';

  const folder = $('#mpps-folder');
  const sent = closing && e.folder;
  $('#mpps-folder-label').textContent = sent ? 'Images sent' : 'Images';
  folder.readOnly = Boolean(sent);
  folder.placeholder = closing ? 'Folder of images to add before completing (optional)…' : 'Folder holding this exam\'s images…';
  $('#steps-series-row').hidden = !sent;
  $('#mpps-adv').hidden = closing;

  renderFolderLine();
  renderMppsAdvSummary();
  renderStepsClose();
  renderStartPreview();
  applyVerbGuards();
}

/**
 * `Start only` runs a different command from `Perform exam` — no folder, no
 * archive, no re-stamping — so it gets its own preview rather than sharing
 * one that names things it will not touch. The preview is the command.
 */
function renderStartPreview() {
  const fold = $('#mpps-start-cmd-fold');
  if (!fold) return;
  fold.hidden = panelMode() !== 'perform';
  setPreviewEl($('#mpps-start-cmd'), mppsStartArgv());
}

/**
 * The verbs are live only when the thing they would do is known.
 *
 * A primary button is the first thing a hand goes to, so it must not be armed
 * while the folder is still being read, while it holds a study this step
 * cannot carry, or while a required field is empty. Each of those already has
 * a line on screen saying so; this stops the button from outrunning it.
 */
function verbBlock() {
  const mode = panelMode();
  if (!mode) return null;
  const s = state.mpps.scan;
  if (s && s.reading) return 'Checking the folder…';
  const m = state.mpps.mismatch;
  if (m && m.kind === 'many') return 'This folder holds more than one study — split it first.';
  if (mode === 'close') {
    if (m && stepsFolderToAdd()) return 'These images carry a different study than this step.';
    return null;
  }
  if (!$('#mpps-stepid').value.trim()) return 'This step has no ID — fill it in under Details.';
  return null;
}

function applyVerbGuards() {
  // A run in flight disables these itself and re-enables them when it ends;
  // leave that alone rather than fighting it mid-transaction.
  if (state.activeRuns.mpps || state.activeRuns.steps) return;
  const why = verbBlock();
  for (const id of ['mpps-run', 'mpps-start', 'steps-close-run']) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.disabled = Boolean(why);
    if (why) el.title = why; else el.removeAttribute('title');
  }
}

/**
 * Reads the engine's own report, from both streams.
 *
 * The counts and the final status go to stdout; the two sentences that say a
 * step was never opened or is still open are failures and go to stderr. This
 * screen decides from those whether a step exists on the peer at all, so
 * reading only stdout would mean deciding it from silence. `start` prints its
 * verdict as an IN PROGRESS line rather than a `step status` line.
 */
function parseMppsReport(text, errText = '') {
  const t = stripAnsi(text);
  const both = `${t}\n${stripAnsi(errText)}`;
  const num = (label) => {
    const m = new RegExp(`^ {2}${label} +(\\d+)`, 'm').exec(t);
    return m ? Number(m[1]) : null;
  };
  const statusMatch = /^step status +(\S+)/m.exec(t);
  const started = /^IN PROGRESS\s+procedure step opened/m.test(t);
  const uidMatch = /^\s*MPPS SOP Instance UID +(\S+)/m.exec(t);
  const shortfall = /^\d+ of \d+ instances were acknowledged\.[\s\S]*?unaccounted for\./m.exec(t);
  return {
    status: statusMatch ? statusMatch[1] : (started ? 'IN PROGRESS' : null),
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
  const cell = (n, lbl, cls = '') =>
    `<div class="total-card ${cls}"><div class="num">${n ?? '—'}</div><div class="lbl">${lbl}</div></div>`;
  const complete = r.acknowledged != null && r.acknowledged === r.found;
  box.innerHTML =
    cell(r.found, 'found') + cell(r.sent, 'sent') +
    cell(r.acknowledged, 'acknowledged', complete ? 'ok' : 'fail') +
    cell(r.referenced, 'listed on the step', complete ? 'ok' : 'fail');
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
function renderMppsOutcome({ code, report, dryRun, verb }) {
  const box = $('#mpps-outcome');
  box.hidden = false;

  if (dryRun) {
    box.className = 'outcome';
    box.innerHTML = '<span class="outcome-head">Rehearsal — nothing was sent.</span>' +
      (verb === 'start' ? 'No connection, no step.' : 'No connection, no step, no images. Performed series cannot be previewed.');
    setStatus('mpps', code === 0 ? 'ok' : 'fail', code === 0 ? 'Plan ready' : 'Scan failed');
    return;
  }

  if (verb === 'start') {
    if (code === 0 && report.status === 'IN PROGRESS') {
      box.className = 'outcome';
      box.innerHTML = `<span class="outcome-head">Step opened — IN PROGRESS on ${esc(state.conn.calledAe)}.</span>` +
        'Complete or discontinue it below. This window is the only place its UID is kept.';
      setStatus('mpps', 'ok', 'IN PROGRESS');
    } else {
      box.className = 'outcome bad';
      revealConsole();
      box.innerHTML = '<span class="outcome-head">N-CREATE failed — no step was opened.</span>The output says why.';
      setStatus('mpps', 'fail', 'Failed');
    }
    return;
  }

  if (report.status === 'COMPLETED' && code === 0) {
    box.className = 'outcome ok';
    box.innerHTML = '<span class="outcome-head">Step COMPLETED.</span>Every instance found on disk was acknowledged and referenced.';
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
      '<b>There is no override.</b> Resend the outstanding instances and open a new step, or find out why the archive refused them.';
  } else if (report.neverOpened) {
    head = 'N-CREATE failed — no step was opened.';
    body = 'Nothing was sent, the images are untouched. The output says why.';
  } else if (report.stillInProgress) {
    head = `N-SET failed — the step is still open on ${esc(state.conn.calledAe || 'the RIS')}.`;
    body = 'Close it below before quitting; this app remembers the UID only until it closes.';
  } else {
    body = `The engine exited ${esc(String(code))} without reporting a closed step. The output is the whole story.`;
  }
  box.innerHTML = `<span class="outcome-head">${head}</span>${body}`;
  setStatus('mpps', 'fail', report.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'Failed');
}

/** Runs `perform` or `start` for the selected row and remembers what came back. */
async function runMpps(verb) {
  const item = selectedWorklistItem();
  clearConsole('mpps');
  $('#mpps-outcome').hidden = true;
  $('#mpps-totals').hidden = true;
  if (!item) { revealConsole(); appendConsole('mpps', 'Select a patient first.\n', 'stderr'); return; }

  const folder = $('#mpps-folder').value.trim();
  if (verb === 'perform' && !folder) {
    revealConsole();
    appendConsole('mpps', 'Choose the folder holding this exam\'s images.\n', 'stderr');
    return;
  }
  const dryRun = mppsDryRun();
  if (!dryRun) {
    const miss = connMissing();
    if (miss.length) {
      revealConsole();
      appendConsole('mpps', `No RIS peer (missing ${miss.join(', ')}). Give a saved peer the RIS role in Settings.\n`, 'stderr');
      return;
    }
  }

  const argv = verb === 'perform' ? BUILDERS.mpps() : mppsStartArgv();
  const attrs = worklistAttrs(item);
  // Read before the run: the UID this command carries, and the peers it
  // names, are what the session entry is built from afterwards.
  const uid = mppsNextUid();
  const storePeer = mppsStore();
  setStatus('mpps', 'running', dryRun ? 'Building…' : (verb === 'perform' ? 'Performing…' : 'Opening…'));
  $('#mpps-run').disabled = true;
  $('#mpps-start').disabled = true;
  if (!dryRun) {
    $('#mpps-cancel').hidden = false;
    revealConsole(); // during a real transfer the stream is the interesting thing
  }
  const { code, stdout, stderr } = await runStreaming('mpps', argv);
  $('#mpps-run').disabled = false;
  $('#mpps-start').disabled = false;
  $('#mpps-cancel').hidden = true;
  applyVerbGuards();

  // The engine's own study-mismatch refusal, in case the folder changed
  // between the scan and the run. It is right to refuse; re-read the folder
  // so the line under it says what will happen next time.
  if (/would name one study/.test(stderr) && /--adopt-worklist-identity/.test(stderr)) {
    await checkMppsFolder();
    const box = $('#mpps-outcome');
    box.hidden = false;
    box.className = 'outcome bad';
    box.innerHTML = '<span class="outcome-head">Refused — the images belong to a different study.</span>Nothing was sent, nothing on disk touched. See the line under the folder.';
    setStatus('mpps', 'fail', 'Study mismatch');
    return;
  }

  const report = parseMppsReport(stdout, stderr);
  if (!dryRun) {
    if (verb === 'perform') renderMppsTotals(report);
    state.mpps.lastRun = { studyInstanceUid: attrs.studyInstanceUid, status: report.status, code };
    rememberStep({
      report, attrs, uid, folder: verb === 'perform' ? folder : '',
      peer: { ...state.conn }, store: storePeer,
    });
    // The UID is spent: a second N-CREATE carrying the same one would be a
    // different step claiming the same identity. Mint the next one now.
    state.mpps.nextUid = null;
    refreshRowPills();
    // The row's step may now be open, which puts the panel into closing mode.
    renderMppsPanel();
    updateAllPreviews();
  }
  renderMppsOutcome({ code, report, dryRun, verb });
}

function wireMpps() {
  // A field the row seeds stops being seeded once it is edited by hand. This
  // is wired FIRST: a listener that rebuilt the command before the field was
  // marked would run syncStationAe and put the seeded value straight back, so
  // clearing the station AE would look like it had not happened.
  ['mpps-stationae', 'mpps-stepid', 'mpps-stepdesc'].forEach((id) =>
    $(`#${id}`).addEventListener('input', (e) => { e.target.dataset.touched = '1'; }));
  const ids = ['mpps-stepid', 'mpps-stationae', 'mpps-stepdesc', 'mpps-chunk', 'mpps-retry', 'mpps-retrieveae'];
  ids.forEach((id) => $(`#${id}`).addEventListener('input', () => {
    renderMppsAdvSummary();
    updateAllPreviews();
  }));
  // Filling in a missing step ID or station AE retires the warning about it,
  // and — for the step ID — puts the verbs back.
  $('#mpps-stepid').addEventListener('input', renderMppsPanel);
  $('#mpps-stationae').addEventListener('input', renderMppsPanel);
  $('#mpps-norecurse').addEventListener('change', () => { renderMppsAdvSummary(); updateAllPreviews(); });

  // A different folder is a different study, so re-read it. Debounced because
  // this fires per keystroke when the path is typed rather than picked.
  let folderTimer = null;
  $('#mpps-folder').addEventListener('input', () => {
    updateAllPreviews();
    // In closing mode the folder is images to add, which changes the verb's
    // label and its command.
    renderStepsClose();
    clearTimeout(folderTimer);
    folderTimer = setTimeout(checkMppsFolder, 350);
  });

  $('#mpps-fix-switch').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fix]');
    if (!chip) return;
    state.mpps.fix = chip.dataset.fix;
    renderFolderLine();
    updateAllPreviews();
  });

  $('#mpps-cancel').addEventListener('click', (e) => stopRun('mpps', e.currentTarget));
  $('#mpps-run').addEventListener('click', () => runMpps('perform'));
  $('#mpps-start').addEventListener('click', () => runMpps('start'));

  renderMppsPanel();
}

// --------------------------------------------------------------------------
// Session steps — what this app opened, and closing it
// --------------------------------------------------------------------------
/**
 * Adds a step this app just opened to the session list.
 *
 * Session memory on purpose. There is no records directory and no per-step
 * file, so the only place a performed step is remembered is this window, and
 * quitting forgets it. That is the honest shape for it: this list is a note of
 * what THIS APP did, and a note cannot be mistaken for the peer's own state.
 * A run that never opened a step is not remembered — an entry for it would
 * name something that does not exist.
 */
function rememberStep({ report, attrs, uid, folder, peer, store }) {
  if (report.neverOpened) return false;
  // The engine prints the UID it used. Prefer it over the one this app minted
  // so the list names what actually went on the wire.
  const mppsUid = report.mppsUid || uid;
  const status = report.status || (report.stillInProgress ? 'IN PROGRESS' : '');
  if (!mppsUid || !status) return false;
  state.steps.entries.unshift({
    mppsUid, status,
    patientName: attrs.patientName || '',
    patientId: attrs.patientId || '',
    accessionNumber: attrs.accessionNumber || '',
    description: attrs.requestedProcedureDescription || attrs.scheduledStepDescription || '',
    studyInstanceUid: attrs.studyInstanceUid || '',
    scheduledStepId: attrs.scheduledStepId || '',
    modality: attrs.modality || '',
    at: new Date(),
    folder,
    peer: { ...peer },
    store: { ...store },
    counts: { found: report.found, sent: report.sent, acknowledged: report.acknowledged, referenced: report.referenced },
  });
  return true;
}

/** True when a folder scan and the acknowledged set are the same set. */
function stepFullyAcknowledged(e) {
  const c = e.counts || {};
  return c.found != null && c.acknowledged != null && c.found === c.acknowledged;
}

/** The IN PROGRESS entry the selected row maps to, or null. */
function stepsSelected() {
  const e = stepFor(selectedWorklistItem());
  return e && e.status === 'IN PROGRESS' ? e : null;
}

function formatStepWhen(e) {
  const d = e.at instanceof Date ? e.at : new Date(e.at);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A folder picked for an open step that was opened without one: images still to send. */
function stepsFolderToAdd() {
  const e = stepsSelected();
  const folder = $('#mpps-folder').value.trim();
  return e && !e.folder && folder ? folder : '';
}

/**
 * The exact `dcm mpps complete|discontinue` this screen would run.
 *
 * The peer comes from the entry, not from the chip: the step lives on the
 * system that took the N-CREATE, and closing it against whatever the chip
 * happens to say now would be an N-SET aimed at a peer that never heard of
 * this UID.
 */
function stepsCloseArgv(verb = 'complete', { seriesFrom = '' } = {}) {
  const e = stepsSelected();
  const argv = ['mpps', verb];
  if (e) {
    argv.push(e.mppsUid);
    if (e.peer.host) argv.push('--host', e.peer.host);
    if (e.peer.port) argv.push('--port', String(e.peer.port));
    if (e.peer.calledAe) argv.push('--called-ae', e.peer.calledAe);
    if (e.peer.callingAe) argv.push('--calling-ae', e.peer.callingAe);
    const from = seriesFrom || (e.folder && $('#steps-series').checked ? e.folder : '');
    if (from) argv.push('--series-from', from);
  }
  if (verb === 'discontinue') {
    const code = reasonCode();
    if (code) argv.push('--reason-code', code);
  }
  if (stepsDryRun()) argv.push('--dry-run');
  return argv;
}

/** `dcm send` for images added to a step opened without them. Goes to the archive, like perform's C-STORE. */
function stepsSendArgv(folder) {
  const store = mppsStore();
  const argv = ['send', folder];
  if (store.host) argv.push('--host', store.host);
  if (store.port) argv.push('--port', store.port);
  if (store.calledAe) argv.push('--called-ae', store.calledAe);
  const e = stepsSelected();
  const calling = (e && e.peer.callingAe) || state.conn.callingAe;
  if (calling) argv.push('--calling-ae', calling);
  const chunk = fieldOr('mpps-chunk', 'chunk');
  if (chunk) argv.push('--chunk', chunk);
  const retry = fieldOr('mpps-retry', 'retry');
  if (retry) argv.push('--retry', retry);
  const timeout = state.settings.defaults.timeout;
  if (timeout) argv.push('--timeout', timeout);
  if ($('#mpps-norecurse').checked) argv.push('--no-recurse');
  if (stepsDryRun()) argv.push('--dry-run');
  return argv;
}

/**
 * The reason an exam was stopped, as the code item the engine requires.
 *
 * A coded reason has to be a real code — the engine refuses free text, and it
 * is right to: `value^scheme^meaning` is what the RIS reads. So the operator
 * picks the reason in words and the triplet is what goes on the command line,
 * where it is still visible. "Another code…" keeps a private scheme reachable
 * for the site that has one.
 */
function reasonCode() {
  const sel = $('#steps-reason');
  const chosen = sel ? sel.value : '';
  if (chosen === '__other') return $('#steps-reasoncode').value.trim();
  return chosen;
}

/** Whether the close is a rehearsal. The one Settings switch, same as perform. */
function stepsDryRun() {
  return rehearsal();
}

/** Several commands in one preview: one per line, joined with && in the fold's summary. */
function setPreviewLines(el, argvs) {
  const lines = argvs.map((argv) => 'dcm ' + argv.map(quoteArg).join(' '));
  el.textContent = lines.join('\n');
  const fold = el.closest('.cmd-fold');
  const sum = fold && fold.querySelector('.cmd-sum');
  if (sum) sum.textContent = lines.join(' && ');
}

/** The closing verbs and their preview: Complete (with images to add, if any) or the armed Discontinue. */
function renderStepsClose() {
  const e = stepsSelected();
  const armed = Boolean(e) && state.steps.armed;
  const dry = stepsDryRun();
  const adding = stepsFolderToAdd();

  $('#steps-reason-row').hidden = !armed;
  $('#steps-close-run').hidden = !e || armed;
  $('#steps-discontinue').hidden = !e || armed;
  $('#steps-close-run').textContent = (dry ? 'Rehearse ' : '') + (adding ? 'Add images & complete' : 'Complete');
  $('#steps-discontinue-run').textContent = dry ? 'Rehearse discontinue' : 'Discontinue step';

  const el = $('#steps-close-cmd');
  if (!e) { setPreviewLines(el, [['mpps', 'complete']]); return; }
  if (armed) setPreviewLines(el, [stepsCloseArgv('discontinue')]);
  else if (adding) setPreviewLines(el, [stepsSendArgv(adding), stepsCloseArgv('complete', { seriesFrom: adding })]);
  else setPreviewLines(el, [stepsCloseArgv('complete')]);
  applyVerbGuards();
}

/** The verdict on a close, in the same box the perform uses. */
function renderCloseOutcome({ code, dry, verb, peer, extra = '' }) {
  const box = $('#mpps-outcome');
  box.hidden = false;
  if (dry) {
    box.className = 'outcome';
    box.innerHTML = '<span class="outcome-head">Rehearsal — nothing was sent.</span>The N-SET was built and printed, not sent.';
    return;
  }
  if (code === 0) {
    const status = verb === 'complete' ? 'COMPLETED' : 'DISCONTINUED';
    box.className = verb === 'complete' ? 'outcome ok' : 'outcome bad';
    box.innerHTML = `<span class="outcome-head">Step ${status}.</span>Closed on ${esc(peer)}. ${extra}`;
  } else {
    box.className = 'outcome bad';
    box.innerHTML = `<span class="outcome-head">N-SET failed — the step is still open on ${esc(peer)}.</span>The output says why. ${extra}`;
  }
}

/**
 * Closes the selected open step.
 *
 * With images to add, `dcm send` runs first, and the step is completed
 * naming that folder only if every instance was acknowledged — otherwise it
 * is discontinued, for the same reason `perform` would: COMPLETED means the
 * archive holds everything found on disk, and there is no override.
 */
async function runClose(verb) {
  const e = stepsSelected();
  if (!e) return;
  clearConsole('steps');
  $('#mpps-outcome').hidden = true;
  $('#mpps-totals').hidden = true;
  const dry = stepsDryRun();
  const peer = e.peer && e.peer.host ? `${e.peer.calledAe || '?'} @ ${e.peer.host}:${e.peer.port || '?'}` : (e.peer.calledAe || '?');
  const adding = verb === 'complete' ? stepsFolderToAdd() : '';
  // The images added to a step are sent by `dcm send`, which re-stamps
  // nothing. A folder that is not this step's study cannot be added to it,
  // and the line under the folder says so; this is the same refusal in code,
  // for the case the button was reached some other way.
  if (adding && state.mpps.mismatch) {
    revealConsole();
    appendConsole('steps', 'These images carry a different study than this step. Clear the folder to complete without them, or perform that study as its own exam.\n', 'stderr');
    return;
  }
  let argv = stepsCloseArgv(verb);
  let extra = '';

  for (const b of ['steps-close-run', 'steps-discontinue', 'steps-discontinue-run']) $(`#${b}`).disabled = true;
  if (!dry) revealConsole();

  if (adding) {
    setStatus('steps', 'running', dry ? 'Building…' : 'Sending…');
    const sent = await runStreaming('steps', stepsSendArgv(adding));
    const t = parseTotals(stripAnsi(sent.stdout));
    argv = stepsCloseArgv('complete', { seriesFrom: adding });
    if (!dry) {
      e.folder = adding;
      e.counts = { ...e.counts, found: t.found, sent: t.sent, acknowledged: t.acknowledged };
      const ok = sent.code === 0 && t.found != null && t.found === t.acknowledged;
      if (!ok) {
        // The same rule as perform: a shortfall cannot be COMPLETED.
        verb = 'discontinue';
        extra = `${t.acknowledged ?? '?'} of ${t.found ?? '?'} instances were acknowledged, so the step could not be completed. <b>There is no override.</b>`;
        appendConsole('steps', `\n${extra.replace(/<[^>]+>/g, '')} Discontinuing instead.\n`, 'stderr');
        argv = stepsCloseArgv('discontinue', { seriesFrom: adding });
      } else {
        argv = stepsCloseArgv('complete', { seriesFrom: adding });
      }
      renderMppsTotals({ found: t.found, sent: t.sent, acknowledged: t.acknowledged, referenced: ok ? t.acknowledged : null });
    }
  }

  setStatus('steps', 'running', dry ? 'Building…' : 'Closing…');
  const { code } = await runStreaming('steps', argv);
  for (const b of ['steps-close-run', 'steps-discontinue', 'steps-discontinue-run']) $(`#${b}`).disabled = false;
  applyVerbGuards();
  setStatus('steps', code === 0 ? 'ok' : 'fail', code === 0 ? (dry ? 'Plan ready' : (verb === 'complete' ? 'COMPLETED' : 'DISCONTINUED')) : 'Failed');
  if (code !== 0) revealConsole();

  // The entry moves only when a real N-SET was accepted: the engine exits zero
  // only when the SCP accepted the status it was sent, and that status is the
  // one written here.
  if (!dry && code === 0) {
    e.status = verb === 'complete' ? 'COMPLETED' : 'DISCONTINUED';
    state.steps.armed = false;
    refreshRowPills();
  }
  renderCloseOutcome({ code, dry, verb, peer, extra });
  renderMppsPanel();
  updateAllPreviews();
}

function wireSteps() {
  $('#steps-reasoncode').addEventListener('input', renderStepsClose);
  $('#steps-reason').addEventListener('change', () => {
    const other = $('#steps-reason').value === '__other';
    $('#steps-reasoncode').hidden = !other;
    if (other) $('#steps-reasoncode').focus();
    renderStepsClose();
  });
  $('#steps-series').addEventListener('change', renderStepsClose);
  $('#steps-close-run').addEventListener('click', () => runClose('complete'));
  $('#steps-discontinue').addEventListener('click', () => {
    state.steps.armed = true;
    // A reason belongs to the step it was given for: arming starts blank
    // rather than carrying the last patient's reason into this one.
    $('#steps-reason').value = '';
    $('#steps-reasoncode').value = '';
    $('#steps-reasoncode').hidden = true;
    renderStepsClose();
    $('#steps-reason').focus();
  });
  $('#steps-discontinue-cancel').addEventListener('click', () => {
    state.steps.armed = false;
    renderStepsClose();
  });
  $('#steps-discontinue-run').addEventListener('click', () => runClose('discontinue'));
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
  const baseChunk = fieldOr('speed-chunk', 'chunk');
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
    // The presets first, because sweeping them is what finds the ceiling: each
    // one sizes its own associations, so a run that comes back narrow came back
    // narrow for a reason the receiver decided, not because the chunk size
    // happened to cap it.
    const presets = $$('.speed-opt').filter((c) => c.checked);
    presets.forEach((c, i) => {
      const preset = SEND_SPEEDS[c.value] || {};
      runs.push({
        label: `speed ${c.value}`,
        title: `${c.value} · ${preset.associations} association${preset.associations === 1 ? '' : 's'}`,
        transferSyntax: null,
        chunk: baseChunk,
        speed: c.value,
        callingAe: ae(c.value, i + 1),
      });
    });
    // Anything typed here is still honoured, and still numbered after the
    // presets so the calling AE Titles stay unique in the peer's ingress log.
    const counts = $('#speed-parallels').value.split(',').map((x) => x.trim()).filter(Boolean);
    counts.forEach((n, i) => {
      runs.push({
        label: `parallel ${n}`,
        title: `${n} association${n === '1' ? '' : 's'}`,
        transferSyntax: null,
        chunk: baseChunk,
        parallel: n,
        callingAe: ae(`P${n}`, presets.length + i + 1),
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
  if (run.speed) argv.push('--speed', run.speed);
  if (run.parallel) argv.push('--parallel', run.parallel);
  if (run.chunk) argv.push('--chunk', run.chunk);
  if (run.transferSyntax) argv.push('--transfer-syntax', run.transferSyntax);
  argv.push('--label', run.label, '--json');
  return argv;
}

BUILDERS.speed = () => {
  const runs = speedRuns();
  return runs.length ? speedArgv(runs[0]) : ['send'];
};

/**
 * The line under the preset checkboxes, plus the one caveat that can quietly
 * ruin the sweep.
 *
 * A chunk size typed into the field below applies to every run and beats each
 * preset's own sizing, which is exactly the trap the presets exist to close —
 * so it is said on screen, before the benchmark, rather than left to be noticed
 * in the engine's warning afterwards.
 */
function renderSpeedParallelHint() {
  const el = $('#speed-parallel-hint');
  if (!el) return;
  const baseChunk = fieldOr('speed-chunk', 'chunk');
  if (baseChunk) {
    const from = $('#speed-chunk').value.trim() ? 'below' : 'from Settings';
    el.innerHTML = esc(`Chunk size ${baseChunk} ${from} applies to every run and overrides each preset's own sizing, `
      + 'so a preset may not reach its association count. ')
      + '<button type="button" class="linklike" data-help="speed-help">Why</button>';
    el.classList.add('live');
    return;
  }
  // Both columns, because a rejection has two endings and neither column can
  // report the other's.
  //
  // This line used to send the operator to the Width column and away from the
  // Ack column, on the claim that a refused association is always retried into
  // a freed slot, so every instance is acknowledged and only the width comes
  // back short. That is one of two endings, and it was written as if it were
  // the only one. sendChunkWithRetry re-enters sendChunk immediately — there is
  // no backoff — so every attempt --retry allows is spent within milliseconds
  // of the first A-ASSOCIATE-RJ, while the associations holding the slots are
  // still working through their chunks. If no slot frees inside that window the
  // instances are never acknowledged and the run exits 1: measured against a
  // peer capped at 3, --parallel 4 --chunk 30 --retry 12 over 240 instances
  // came back short in 4 of 4 runs, 150 unacknowledged.
  //
  // Which ending arrives is timing, not a setting, so the line promises
  // neither. It names both and points at the column that answers each. The
  // full paragraph moved into the help panel when this screen was trimmed; it
  // still tracks desktop/README.md and `dcm send --help`, and the three say
  // the same thing on purpose.
  el.innerHTML = 'Read the Width and Ack columns afterwards. '
    + '<button type="button" class="linklike" data-help="speed-help">Why</button>';
  el.classList.remove('live');
}

/**
 * Every command in the sweep, on screen before any of them runs.
 *
 * The preview above shows one command, and a sweep is several — so the whole
 * list is laid out here as soon as the options change. Nothing gets sent that
 * was not written out first.
 */
function renderSpeedPlan(runs) {
  const progress = $('#speed-progress');
  if (!progress) return;
  // While a sweep is in flight this box is the live progress list, and the loop
  // addresses its lines positionally (#speed-line-<i>) against the runs array
  // it captured before starting. Rebuilding it from the current form remaps
  // index to run: completed rates are wiped, and if a preset checkbox moved,
  // the next measured rate lands on a line labelled with a different run's
  // title, calling AE and command. Nothing on this screen is disabled during a
  // sweep except the Run button, so this is an ordinary click away. Only the
  // sweep's own explicit-argument call gets through.
  if (!runs && speedRunning) return;
  const list = runs || speedRuns();
  if (!list.length) { progress.hidden = true; progress.innerHTML = ''; return; }
  progress.hidden = false;
  progress.innerHTML =
    `<div class="section-title">${list.length} run${list.length === 1 ? '' : 's'}, in order</div>` +
    list.map((r, i) =>
      `<div class="run-line" id="speed-line-${i}">` +
        `<span>${esc(r.title)} · ${esc(r.callingAe)}</span><span class="rate">waiting…</span></div>` +
      // r.argv is set once, by runSpeedTest, at the moment the sweep is frozen.
      // Before that there is no sweep to freeze and the current form is the
      // truth. Either way the string printed here is the argv that is spawned.
      `<div class="run-cmd">dcm ${esc((r.argv || speedArgv(r)).map(quoteArg).join(' '))}</div>`
    ).join('');
}

/**
 * The width a run actually ran at, from the run's own JSON.
 *
 * `parallel` is what was asked for. `parallelAchieved` is measured — the fewest
 * simultaneously *accepted* associations any single study in the run reached
 * (see planJson in src/commands/send.js). The two come apart when a study does
 * not split into enough chunks to fill the pool, and again when the receiver
 * refuses the extra associations. That second case has two endings — the retry
 * is admitted into a freed slot and only the width is short, or the retries
 * burn out unbacked-off and instances go unacknowledged — so a short width is
 * not on its own evidence that everything arrived. The Ack column answers that,
 * and this one does not.
 *
 * The reason is per-study and this row is not, so the row states the measured
 * fact and nothing more — the engine's per-study warning names the cause, and
 * that warning now reaches the console below.
 *
 * @returns {{got:number, asked:number, short:boolean}|null} null pre-0.14 JSON.
 */
function achievedWidth(d) {
  if (typeof d.parallelAchieved !== 'number' || typeof d.parallel !== 'number') return null;
  return { got: d.parallelAchieved, asked: d.parallel, short: d.parallelAchieved < d.parallel };
}

/**
 * What a row actually ran, reduced to a key, so that two rows which resolved to
 * the same transfer can be recognised as the same transfer.
 *
 * At 100 instances, fast, very-fast and insane all clamp to 25-instance chunks,
 * split into 4, and run 4 wide: three byte-identical transfers. Stamping
 * FASTEST on whichever of them drew the best sample tells the operator that 16
 * wide beat 8 and 4, on a difference that is run-to-run variation.
 *
 * Keyed on how the instances were actually divided — instances and chunk count
 * per study — rather than on the chunk size, which is only the cap. Ten
 * instances go in one association whether the cap is 25 or 200, and calling
 * those two runs different because their caps differed is the same mistake in
 * miniature: reporting what was asked for instead of what happened. The
 * negotiated syntax is in the key because in the transfer-syntax sweep it is
 * the whole point of the comparison.
 *
 * Width comes from parallelAchieved, which is measured and is a floor, so two
 * runs of one configuration can occasionally measure apart and miss the tie.
 * That is the error worth having: the alternative is keying on the dispatched
 * count, which would group a run the receiver refused with one it accepted.
 */
function effectiveRun(d) {
  const syntaxes = (d.negotiatedTransferSyntaxes || []).map((t) => t.name).sort().join('+');
  const shape = Array.isArray(d.studies) && d.studies.length
    ? d.studies.map((s) => `${s.instances}/${s.chunks}`).join(',')
    : `${d.found}/?`;
  return `${syntaxes}|${d.parallelAchieved}|${shape}`;
}

/**
 * Whether a run delivered everything it found, from the run's own JSON.
 *
 * `found` is files on disk, `acknowledged` is instances the peer confirmed it
 * stored. Any gap between them is a failure — the engine exits non-zero on it
 * (see "Any shortfall between them is a failure" in `dcm send --help`) — and
 * `ok` carries that same verdict. Both are read: `ok` covers a run that failed
 * for a reason the counts do not show, and the counts name what was lost.
 *
 * This is the one column a rejected-association shortfall can show up in. A
 * width can come back short with everything acknowledged; a short Ack means
 * instances are not on the peer.
 *
 * @returns {{acknowledged:number|null, found:number|null, missing:number|null}|null}
 *   null when the run delivered everything, an object when it did not.
 */
function ackShortfall(d) {
  const found = typeof d.found === 'number' ? d.found : null;
  const acknowledged = typeof d.acknowledged === 'number' ? d.acknowledged : null;
  const missing = found !== null && acknowledged !== null ? found - acknowledged : null;
  const bad = d.ok === false || (missing !== null && missing > 0);
  return bad ? { acknowledged, found, missing } : null;
}

/**
 * Renders the comparison table once runs have results.
 *
 * Two things this table is not allowed to do, because they are the whole reason
 * --speed exists: attribute a throughput figure to a width the run never
 * reached, and declare a winner between runs that did identical work.
 *
 * So the row is labelled with the width that was *measured* alongside the one
 * that was requested, and the badge goes to every row that resolved to the same
 * effective transfer as the fastest one rather than to whichever of them drew
 * the best sample.
 *
 * A third, added here: a run that did not deliver every instance must not sit
 * in this table looking like a result. It is not a slow row to be ranked below
 * the others — there is nothing to rank. Its rate is computed over a transfer
 * that stopped early, which is fewer bytes over less time, so it lands wherever
 * the run happened to die and often lands high. See the rate cells below.
 */
function renderSpeedResults(results) {
  const box = $('#view-speed [data-result]');
  box.hidden = false;
  // Cancelled before the first run returned. There is nothing to tabulate, and
  // an empty table would read as a sweep that found nothing rather than as one
  // that never happened.
  if (!results.length) {
    box.innerHTML = '<div class="empty-note">No run produced a result. The output below says why.</div>';
    return;
  }
  // A run that fell short of its own instance count is not in this set, so it
  // cannot set the best rate and cannot be tied with the row that did.
  const ok = results.filter((r) => r.data && r.data.ok && !ackShortfall(r.data));

  // FASTEST is computed over completed runs only, and the badge is only ever
  // put on a row drawn from that set. An incomplete run is not eligible: its
  // MB/s is not a measurement of anything the sweep is comparing, and a
  // shortfall that ended a run early is exactly the way to *win* on a figure
  // like that. Nothing here falls back to results[] when `ok` is empty — a
  // sweep in which every run fell short declares no winner at all.
  let winningRun = null;
  let tied = [];
  let isTie = false;
  if (ok.length) {
    const bestRate = Math.max(...ok.map((r) => r.data.megabytesPerSecond || 0));
    const winner = ok.find((r) => (r.data.megabytesPerSecond || 0) === bestRate);
    winningRun = effectiveRun(winner.data);
    // Every completed run that did the same work as the fastest one. Usually
    // just the fastest one; more than that means the sweep found no difference.
    tied = ok.filter((r) => effectiveRun(r.data) === winningRun);
    isTie = tied.length > 1;
  }
  const badge = isTie ? 'TIED FASTEST' : 'FASTEST';
  const short = results.filter((r) => r.data && (achievedWidth(r.data) || {}).short);
  // Both kinds of failure, in run order: a run whose JSON says it lost
  // instances, and a run that produced no parseable JSON at all.
  const lost = results.filter((r) => r.data && ackShortfall(r.data));
  const incomplete = results.filter((r) => !r.data || ackShortfall(r.data));

  const rows = results.map((r) => {
    if (!r.data) {
      return `<tr class="incomplete"><td>${esc(r.run.title)}`
        + '<span class="badge-incomplete">INCOMPLETE</span></td>'
        + '<td colspan="8" class="dim">failed — see output</td></tr>';
    }
    const d = r.data;
    const miss = ackShortfall(d);
    const isBest = !miss && d.ok && winningRun !== null && effectiveRun(d) === winningRun;
    const w = achievedWidth(d);
    const width = !w
      ? '—'
      : w.short
        ? `<span class="warn-inline">${w.got} of ${w.asked}</span>`
        : String(w.got);
    const negotiated = (d.negotiatedTransferSyntaxes || []).map((t) => t.name).join(', ') || '—';
    // What an incomplete run's throughput cells show, and why they show it.
    //
    // Not the number. MB/s and instances/s are bytes and instances over the
    // elapsed time of a run that gave up partway: the denominator shrank with
    // the numerator, and neither one covers the transfer that was asked for. It
    // is not a slow reading of this configuration, it is not a reading of this
    // configuration at all, and because a run that dies early is a *short* run
    // it frequently prints faster than the runs that finished. Printing it
    // greyed, or struck through, or with a footnote still leaves a figure in a
    // column whose only purpose is to be compared down a page.
    //
    // So the cells read "—", and the note under the table says what is missing
    // and why it is not here. Elapsed and On the wire stay: those are facts
    // about what happened, not rates attributed to a transfer that did not.
    const rate = miss
      ? '<td class="num dim">—</td><td class="num dim">—</td>'
      : `<td class="num">${d.megabytesPerSecond}</td><td class="num">${d.instancesPerSecond}</td>`;
    // The counts are the row's verdict, so they are amber and they carry the
    // gap in words — "60/100" and "100/100" differ by one character otherwise.
    const ack = miss && miss.missing > 0
      ? `<span class="warn-inline">${d.acknowledged}/${d.found} · ${miss.missing} missing</span>`
      : `${d.acknowledged}/${d.found}`;
    const cls = miss ? 'incomplete' : (isBest ? (isTie ? 'best tied' : 'best') : '');
    return `<tr class="${cls}">
      <td>${esc(r.run.title)}${miss ? '<span class="badge-incomplete">INCOMPLETE</span>' : ''}${
        isBest ? `<span class="badge-best${isTie ? ' tied' : ''}">${badge}</span>` : ''}</td>
      <td class="num width">${width}</td>
      <td class="mono">${esc(r.run.callingAe)}</td>
      <td>${esc(negotiated)}</td>
      <td class="num">${(d.elapsedMs / 1000).toFixed(2)}s</td>
      ${rate}
      <td class="num">${humanBytes(d.bytesSent)}</td>
      <td class="num ack">${ack}</td>
    </tr>`;
  }).join('');

  const notes = [];
  // First note in the box, above the width caveat: a shortfall outranks
  // everything else the table has to say about the sweep.
  if (incomplete.length) {
    const missing = lost.reduce((n, r) => n + Math.max(0, (ackShortfall(r.data) || {}).missing || 0), 0);
    const lostPhrase = missing
      ? `, leaving ${missing} instance${missing === 1 ? '' : 's'} the receiver never acknowledged`
      : '';
    notes.push(
      `<div class="local-note"><b>${incomplete.length} of ${results.length} run` +
      `${results.length === 1 ? '' : 's'} did not finish${lostPhrase}.</b> ` +
      'Those rows carry no MB/s and no instances/s, and that is deliberate: a rate over a transfer ' +
      'that stopped early is fewer bytes over less time, so it is not a slower reading of that ' +
      'setting — it is not a reading of it, and it often prints faster than the runs that ' +
      'completed. They are also not eligible for FASTEST. Elapsed and On the wire are what did ' +
      'happen; Ack is what did not. The engine\'s own report is in the output below. A receiver at ' +
      'its association limit rejects transiently and the chunk is retried with no backoff, so every ' +
      'attempt is spent within milliseconds while the accepted associations are still transferring; ' +
      'when no slot frees inside that window, this is the ending you get.</div>'
    );
  }
  if (short.length) {
    notes.push(
      `<div class="local-note"><b>${short.length} run${short.length === 1 ? '' : 's'} did not reach the ` +
      `width ${short.length === 1 ? 'it' : 'they'} asked for.</b> Where Width reads "N of M", any MB/s ` +
      'beside it is the rate for N concurrent associations, not for M — it is not a measurement of M ' +
      'and cannot be compared to one. The engine warned per study in the output below, and that warning ' +
      'names the reason: either the study did not split into enough chunks to fill the pool, or the peer ' +
      'never had that many accepted at once. Achieved width is a floor, so it can read low by one on a ' +
      'run whose last chunks drain early; it never reads high.</div>'
    );
  }
  if (tied.length > 1) {
    const names = tied.map((r) => r.run.title.split('·')[0].trim());
    notes.push(
      `<div class="local-note"><b>${esc(names.join(', '))} resolved to the same transfer.</b> The same ` +
      `instances went in the same number of associations, ${tied[0].data.parallelAchieved} at a time, over ` +
      'the same negotiated syntax — so the gaps between their rates are run-to-run variation and not a ' +
      'difference between the settings. Asking for more than this bought nothing here; to tell the wider ' +
      'settings apart, sweep a folder with enough instances to fill them.</div>'
    );
  }

  box.innerHTML =
    '<div class="section-title">Comparison</div>' +
    '<table><thead><tr><th>Run</th><th class="num">Width</th><th>Calling AE</th><th>Negotiated syntax</th>' +
    '<th class="num">Elapsed</th><th class="num">MB/s</th><th class="num">Inst/s</th>' +
    '<th class="num">On the wire</th><th class="num">Ack</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>` +
    notes.join('');
}

/**
 * The sweep's one-line verdict, for the status chip at the top of the screen.
 *
 * The chip used to read a green "Done" whenever *any* single run came back ok,
 * so a sweep in which three of four runs lost instances announced itself as a
 * success from the top of the screen — above a table the operator then had to
 * read closely to find out otherwise. A sweep is one benchmark made of several
 * runs; it has not succeeded while any part of it is missing instances.
 *
 * Three outcomes, and the middle one is the point: every run complete is green,
 * nothing complete is red, and a mixture is amber and counted. Amber rather
 * than red because the completed runs in that sweep are real measurements and
 * the table below them is worth reading; counted rather than a bare "Incomplete"
 * because the number is what tells the operator whether to trust any of it.
 *
 * @param {Array<{data:object|null}>} results Runs that returned, in order.
 * @param {boolean} cancelled Whether the operator stopped the sweep.
 * @returns {{kind:string, label:string}} A setStatus kind and its label.
 */
function speedOutcome(results, cancelled) {
  // Stopped before anything returned: no runs, so nothing succeeded either.
  if (!results.length) return { kind: 'fail', label: cancelled ? 'Stopped' : 'Failed' };
  const bad = results.filter((r) => !r.data || ackShortfall(r.data)).length;
  const stopped = cancelled ? 'Stopped · ' : '';
  if (!bad) return { kind: 'ok', label: cancelled ? 'Stopped' : 'Done' };
  const kind = bad === results.length ? 'fail' : 'warn';
  return { kind, label: `${stopped}${bad} of ${results.length} incomplete` };
}

/**
 * True from the moment a sweep freezes its runs until the last one has exited.
 *
 * A flag rather than a look at state.activeRuns.speed: that key is deleted when
 * each child exits and re-set only after the next one has been spawned, so
 * there is a gap between runs in which a keystroke would still rebuild the live
 * list. See the guard at the top of renderSpeedPlan.
 */
let speedRunning = false;

function wireSpeed() {
  // Every control on this screen changes which commands the sweep will run, so
  // they all land on the same refresh: the caveat line, then updateAllPreviews,
  // which repaints both the single preview and the full list of commands.
  const refreshSpeed = () => {
    renderSpeedParallelHint();
    updateAllPreviews();
  };

  for (const chip of $$('#speed-mode .chip')) {
    chip.addEventListener('click', () => {
      $$('#speed-mode .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const mode = chip.dataset.mode;
      $('#speed-syntax-opts').hidden = mode !== 'syntax';
      $('#speed-chunk-opts').hidden = mode !== 'chunk';
      $('#speed-parallel-opts').hidden = mode !== 'parallel';
      $('#speed-repeat-opts').hidden = mode !== 'repeat';
      refreshSpeed();
    });
  }
  ['speed-folder', 'speed-aeprefix', 'speed-chunk', 'speed-chunks', 'speed-repeats', 'speed-parallels']
    .forEach((id) => $(`#${id}`).addEventListener('input', refreshSpeed));
  $$('.ts-opt').forEach((c) => c.addEventListener('change', refreshSpeed));
  $$('.speed-opt').forEach((c) => c.addEventListener('change', refreshSpeed));
  renderSpeedParallelHint();
  renderSpeedPlan();

  $('#view-speed [data-cancel]').addEventListener('click', (e) => {
    speedCancelled = true;
    stopRun('speed', e.currentTarget);
  });

  $('#view-speed [data-run]').addEventListener('click', runSpeedTest);
}

let speedCancelled = false;

async function runSpeedTest() {
  const folder = $('#speed-folder').value.trim();
  const box = $('#view-speed [data-result]');
  const c = consoleEl('speed');
  box.hidden = true;
  resetConsole(c);
  c.hidden = true;

  if (!folder) {
    fail('speed', 'Choose a study folder to send.\n');
    return;
  }
  const miss = connMissing();
  if (miss.length) {
    fail('speed', `Fill in the peer connection: ${miss.join(', ')}.\n`);
    return;
  }

  const runs = speedRuns();
  if (!runs.length) {
    fail('speed', 'Pick at least one thing to compare.\n');
    return;
  }

  speedCancelled = false;
  speedRunning = true;
  $('#view-speed [data-run]').disabled = true;
  $('#view-speed [data-cancel]').hidden = false;
  setStatus('speed', 'running', `Running 1/${runs.length}…`);
  // Each run's argv is frozen here, at the moment it is written on screen, and
  // dispatched from the same array below. speedArgv reads the folder and the
  // peer connection live, so building it again at dispatch time would let an
  // edit made mid-sweep spawn a command that differs from the one printed
  // against its line — and a sweep whose later runs measured a different folder
  // is not a comparison at all.
  for (const r of runs) r.argv = speedArgv(r);
  renderSpeedPlan(runs);

  const results = [];
  try {
    for (let i = 0; i < runs.length; i++) {
      if (speedCancelled) break;
      setStatus('speed', 'running', `Running ${i + 1}/${runs.length}…`);
      const line = $(`#speed-line-${i} .rate`);
      if (line) line.textContent = 'sending…';

      const { code, stdout, stderr } = await runCapture('speed', runs[i].argv);
      let data = null;
      try {
        data = JSON.parse(stdout);
      } catch {
        appendConsole('speed', `\n--- ${runs[i].title} ---\n${stdout || stderr}\n`, 'stderr');
      }
      // Everything the engine says about what a run actually did is on stderr,
      // and --json does not silence it: the per-study shortfall warning naming
      // the width the study really ran at, and any flag a preset displaced.
      // Discarding stderr whenever stdout parsed meant throwing it away on
      // precisely the runs whose numbers reach the table.
      if (data && stderr.trim()) {
        appendConsole('speed', `\n--- ${runs[i].title} ---\n${stderr}`, 'stderr');
      }
      results.push({ run: runs[i], data, code });

      if (line) {
        const w = data ? achievedWidth(data) : null;
        const miss = data ? ackShortfall(data) : null;
        // The line's own label says how many associations were asked for, so a
        // rate written beside it has to carry what was reached — and a run that
        // lost instances gets no rate at all, for the same reason its row in the
        // table below gets none. This list is read while the sweep is still
        // going, so it is the first place the shortfall can be seen.
        if (!data) {
          line.textContent = `failed (exit ${code})`;
        } else if (miss) {
          line.textContent = miss.missing > 0
            ? `incomplete · ${data.acknowledged} of ${data.found} acknowledged`
            : `incomplete · exit ${code}`;
        } else {
          line.textContent = `${data.megabytesPerSecond} MB/s · ${(data.elapsedMs / 1000).toFixed(2)}s`
            + (w && w.short ? ` · ran ${w.got} of ${w.asked} wide` : '');
        }
        line.classList.toggle('bad', !data || !!miss);
      }
      const parent = $(`#speed-line-${i}`);
      if (parent) parent.classList.add('done');
    }
  } finally {
    // Unlocked even if a run threw, or the form stays frozen for the session.
    speedRunning = false;
  }

  $('#view-speed [data-run]').disabled = false;
  $('#view-speed [data-cancel]').hidden = true;
  const outcome = speedOutcome(results, speedCancelled);
  setStatus('speed', outcome.kind, outcome.label);
  renderSpeedResults(results);
}

// --------------------------------------------------------------------------
// View: WEB PING (DICOMweb connectivity)
// --------------------------------------------------------------------------
BUILDERS.webping = () => {
  const argv = ['web', 'ping'];
  if (state.web.url) argv.push('--url', state.web.url);
  const t = fieldOr('webping-timeout', 'timeout');
  if (t) argv.push('--timeout', t);
  return argv;
};

function wireWebping() {
  $('#webping-timeout').addEventListener('input', updateAllPreviews);
  $('#view-webping [data-run]').addEventListener('click', async () => {
    clearConsole('webping');
    if (!state.web.url) { fail('webping', 'Fill in the server URL.\n'); return; }
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
  const chunk = fieldOr('websend-chunk', 'chunk');
  if (chunk) argv.push('--chunk', chunk);
  const retry = fieldOr('websend-retry', 'retry');
  if (retry !== '') argv.push('--retry', retry);
  const timeout = fieldOr('websend-timeout', 'timeout');
  if (timeout) argv.push('--timeout', timeout);
  if (rehearsal()) argv.push('--dry-run');
  return argv;
};

function wireWebsend() {
  ['websend-folder', 'websend-chunk', 'websend-retry', 'websend-timeout'].forEach((id) =>
    $(`#${id}`).addEventListener('input', updateAllPreviews));

  $('#view-websend [data-run]').addEventListener('click', async () => {
    const folder = $('#websend-folder').value.trim();
    clearConsole('websend');
    if (!folder) { fail('websend', 'Choose a folder to send.\n'); return; }
    // A rehearsal opens no connection, so it needs no server.
    const dry = rehearsal();
    if (!dry && !state.web.url) { fail('websend', 'Pick a DICOMweb server on the chip, or add one in Settings.\n'); return; }
    setStatus('websend', 'running', dry ? 'Scanning…' : 'Sending…');
    $('#view-websend [data-run]').disabled = true;
    const { code } = await runStreaming('websend', BUILDERS.websend());
    $('#view-websend [data-run]').disabled = false;
    setStatus('websend', code === 0 ? 'ok' : 'fail', code === 0 ? (dry ? 'Plan ready' : 'Complete') : 'Failed');
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
  const timeout = state.settings.defaults.timeout;
  if (timeout) argv.push('--timeout', timeout);
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
    if (!state.web.url) { fail('webquery', 'Fill in the server URL.\n'); return; }
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
      revealConsole('webquery'); appendConsole('webquery', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr');
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

/** One line naming whatever the hub's Advanced holds: both knobs make it refuse things. */
function renderWebhubAdvSummary() {
  const el = $('#webhub-adv-sum');
  if (!el) return;
  const token = $('#webhub-token').value.trim();
  const reject = $('#webhub-rejectafter').value.trim();
  const parts = [];
  if (token) parts.push('a Bearer token is required');
  if (reject) parts.push(`rejects after ${reject}`);
  el.textContent = parts.length ? `— ${parts.join(' · ')}` : '— open, accepts everything';
  el.classList.toggle('changed', parts.length > 0);
}

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
    hint.innerHTML = `Clients point at <code>${esc(url)}</code> — <button class="linklike" id="webhub-use">use it on the other tabs</button>`;
    $('#webhub-use').addEventListener('click', () => {
      state.web.url = url;
      renderWebChips();
      updateAllPreviews();
    });
  };

  ['webhub-port', 'webhub-persist', 'webhub-root', 'webhub-token', 'webhub-rejectafter'].forEach((id) =>
    $(`#${id}`).addEventListener('input', () => { renderWebhubAdvSummary(); updateAllPreviews(); }));
  $('#webhub-port').addEventListener('input', showBaseUrl);
  showBaseUrl();
  renderWebhubAdvSummary();

  $('#view-webhub [data-run]').addEventListener('click', async () => {
    clearConsole('webhub');
    const port = $('#webhub-port').value.trim();
    if (!port) { fail('webhub', 'Choose a port to listen on.\n'); return; }
    setStatus('webhub', 'running', 'Listening');
    $('#view-webhub [data-run]').disabled = true;
    $('#view-webhub [data-cancel]').hidden = false;
    const { code } = await runStreaming('webhub', BUILDERS.webhub());
    // Only reached when the hub stops.
    $('#view-webhub [data-run]').disabled = false;
    $('#view-webhub [data-cancel]').hidden = true;
    setStatus('webhub', code === 0 ? 'ok' : 'fail', 'Stopped');
  });

  $('#view-webhub [data-cancel]').addEventListener('click', (e) => {
    stopRun('webhub', e.currentTarget);
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
    // A study whose instances disagree about its description or patient ID has
    // no single one to head the card with. Left as-is it would fall through to
    // "Study" with no ID beside it, which reads as a study that carries neither
    // — a disagreement quietly filed as an absence. Absence itself is unchanged:
    // that is what this card has always shown for a study that really has none.
    const desc = identityState(s, 'studyDescription', 'studyDescriptions');
    const pid = identityState(s, 'patientId', 'patientIds');
    html += `<div class="study-card">
      <h3>${desc.conflict ? identityClash(desc.values) : esc(desc.value || 'Study')} `
      + `${pid.conflict ? `· ${identityClash(pid.values)}` : (pid.value ? `· ${esc(pid.value)}` : '')}</h3>
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
    const c = consoleEl('inventory'); resetConsole(c); c.hidden = true;
    if (!t) { fail('inventory', 'Choose a folder or file.\n'); return; }
    setStatus('inventory', 'running', 'Reading…');
    const { code, stdout, stderr } = await runCapture('inventory', [...BUILDERS.inventory(), '--json']);
    setStatus('inventory', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try { renderInventory(JSON.parse(stdout)); }
    catch { revealConsole('inventory'); appendConsole('inventory', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr'); }
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
    const c = consoleEl('tags'); resetConsole(c); c.hidden = true;
    if (!t) { fail('tags', 'Choose a file or folder.\n'); return; }
    setStatus('tags', 'running', 'Reading…');
    const { code, stdout, stderr } = await runCapture('tags', [...BUILDERS.tags(), '--json']);
    setStatus('tags', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    try { renderTags(JSON.parse(stdout)); }
    catch { revealConsole('tags'); appendConsole('tags', stdout || stderr || 'No output.\n', code === 0 ? 'stdout' : 'stderr'); }
  });
}

// --------------------------------------------------------------------------
// View: RENAME (the four fields that say whose study this is)
// --------------------------------------------------------------------------
/**
 * Renaming a study is `dcm edit --set` with the keywords already known.
 *
 * Edit asks which tag. This asks which patient, which is the question anyone
 * actually has, and it answers three things Edit cannot:
 *
 *  - what the study currently says, read with `dcm info --json` before any
 *    field is offered, so the operator can see they are about to rename the
 *    study they meant rather than the one next to it;
 *  - that PatientName is `Family^Given^Middle^Prefix^Suffix` and not a
 *    free-text field, so Family and Given are separate boxes that compose —
 *    and that it can hold that five-part name three times over, once per
 *    script, which the boxes cannot edit and must not therefore destroy;
 *  - that a folder holding two studies cannot have one of them renamed.
 *
 * `--force` is never passed from here. UIDs are what tie a study together;
 * this screen changes what a study is called, never what it is.
 */
const renameState = {
  /** The folder the loaded values were read from — '' until a scan lands. */
  path: '',
  /** The single study `dcm info` found there, or null. */
  study: null,
  /**
   * PatientName components past Family and Given (middle, prefix, suffix).
   * Carried through untouched: an operator correcting a surname has not asked
   * for "DOE^JANE^Q^DR^III" to lose its last three components, and silently
   * dropping them would be a second, unannounced edit.
   */
  extras: [],
  /**
   * The name's component groups after the first — its ideographic and phonetic
   * spellings, `=`-separated in the value `dcm info` reports.
   *
   * The same argument as `extras`, one level up and with more at stake. A
   * Japanese name is one DICOM value holding three writings of itself, and the
   * two boxes on this screen can only edit the Latin one. Composing the new
   * name out of those boxes alone would write "YAMADA^Tarou" over
   * "Yamada^Tarou=<kanji>=<kana>" and delete two thirds of the patient's name
   * from every instance, to repair a typo in the third — which is what this
   * screen did before these were carried.
   *
   * They ride along untouched and are shown in the echo below the boxes, so
   * what is preserved is preserved in view rather than behind the operator's
   * back. Almost every name has none of these and the array stays empty.
   */
  groups: [],
  /**
   * Current values, keyed by the keyword each will be written to. A field is
   * '' when the study's instances disagree about it — `dcm info` withholds the
   * singular in that case rather than picking one, and so do we.
   */
  current: null,
  /**
   * keyword -> the values a disagreement is between, for the fields that have
   * one. Absent keyword means the study speaks with one voice about it (or
   * says nothing at all, which is not the same thing and is not a conflict).
   */
  conflicts: {},
};

/**
 * The four fields, in the order they render.
 *
 * `one` / `many` are the pair `dcm info --json` reports each field as. Both
 * keys are always present: the singular is a string only when every instance
 * that carries the field agrees, and is null both when they disagree and when
 * no instance carries one — the plural is the only thing that tells those two
 * apart. Reading the singular alone is exactly the bug this screen must not
 * have, so nothing here reads it alone.
 */
const RENAME_FIELDS = [
  { keyword: 'PatientName', label: 'Patient name', one: 'patientName', many: 'patientNames', miss: 'no name' },
  { keyword: 'PatientID', label: 'Patient ID', one: 'patientId', many: 'patientIds', miss: 'no ID', input: 'rename-patientid' },
  { keyword: 'StudyDescription', label: 'Study description', one: 'studyDescription', many: 'studyDescriptions', miss: 'no description', input: 'rename-desc' },
  { keyword: 'AccessionNumber', label: 'Accession number', one: 'accessionNumber', many: 'accessionNumbers', miss: 'none', input: 'rename-accession' },
];

/** This screen's four fields, through the shared reader. */
function renameFieldState(s, field) {
  return identityState(s, field.one, field.many);
}

/**
 * A PatientName taken apart into the two things this screen edits and the two
 * it only carries.
 *
 * A DICOM Person Name nests twice. The outer level is up to three component
 * GROUPS separated by `=` — the same name written in Latin script, in
 * ideographs, and phonetically. Each group is then five `^` components,
 * Family^Given^Middle^Prefix^Suffix. `dcm info` reports the whole thing, so
 * "Yamada^Tarou=<kanji>=<kana>" arrives here as one string.
 *
 * Family and Given come out of the FIRST group, because that is the group the
 * two boxes can meaningfully hold. `extras` is the rest of that group;
 * `groups` is every later group, kept whole. Both are carried, neither is
 * edited, and `joinPn` puts them back exactly where they were.
 */
function splitPn(value) {
  const groups = String(value ?? '').split('=');
  const parts = groups[0].split('^');
  return {
    family: parts[0] || '',
    given: parts[1] || '',
    extras: parts.slice(2),
    groups: groups.slice(1),
  };
}

/**
 * Family + Given + the preserved tail + the preserved groups, back into one PN.
 *
 * Trailing empties are dropped at both levels, because "DOE^JANE^^^" and
 * "DOE^JANE" are the same name and only one of them looks like a name, and
 * "DOE^JANE==" is the same again with two empty scripts announced.
 *
 * An interior empty group is NOT dropped: a name with a phonetic spelling and
 * no ideographic one is "A^B==C^D", and closing that gap would file the
 * phonetic spelling as the ideographic one. That is why the groups are joined
 * positionally rather than filtered.
 *
 * A name with a single group — nearly all of them — composes to exactly what
 * it composed to before there were groups at all: no `=`, byte for byte the
 * old behaviour.
 */
function joinPn(family, given, extras, groups = []) {
  const parts = [family, given, ...extras].map((p) => String(p ?? ''));
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  const all = [parts.join('^'), ...groups.map((g) => String(g ?? ''))];
  while (all.length > 1 && all[all.length - 1] === '') all.pop();
  return all.join('=');
}

function renameComposed() {
  return joinPn(
    $('#rename-family').value.trim(),
    $('#rename-given').value.trim(),
    renameState.extras,
    renameState.groups
  );
}

/** 'copy' (the default) or 'inplace'. */
function renameDest() {
  const active = $('#rename-dest-row .chip.active');
  return active ? active.dataset.dest : 'copy';
}

/** What the operator has typed, keyed the way the engine wants it. */
function renameWanted() {
  return {
    PatientName: renameComposed(),
    PatientID: $('#rename-patientid').value.trim(),
    StudyDescription: $('#rename-desc').value.trim(),
    AccessionNumber: $('#rename-accession').value.trim(),
  };
}

/**
 * Only the fields that actually differ, as [keyword, value].
 *
 * Rewriting a field to the value it already holds is not free — it is an
 * instance touched, a line in the report, and a difference between the copy
 * and the source that has to be explained later — so an unchanged field
 * produces no --set at all.
 */
function renamePairs() {
  if (!renameState.study || !renameState.current) return [];
  const wanted = renameWanted();
  const pairs = [];
  for (const { keyword } of RENAME_FIELDS) {
    if (wanted[keyword] !== renameState.current[keyword]) pairs.push([keyword, wanted[keyword]]);
  }
  return pairs;
}

BUILDERS.rename = () => {
  const argv = ['edit'];
  const folder = $('#rename-folder').value.trim();
  if (folder) argv.push(folder);
  for (const [keyword, value] of renamePairs()) argv.push('--set', `${keyword}=${value}`);
  if (renameDest() === 'inplace') {
    argv.push('--in-place');
  } else {
    const out = $('#rename-out').value.trim();
    if (out) argv.push('--out', out);
  }
  // No --force, ever: nothing this screen can set is a UID.
  if (rehearsal()) argv.push('--dry-run');
  return argv;
};

/**
 * One identity field on the card.
 *
 * A disagreement is drawn as the disagreement — every value, amber — because
 * the alternative is the card stating a fact the study does not contain. It
 * is deliberately not collapsed to "2 values": an operator who can see
 * SYNTH0001 / WRONG-ID can usually tell at a glance which one is the mistake,
 * and a count tells them only that they must go and look somewhere else.
 */
function renameFieldHtml(s, field) {
  const st = renameFieldState(s, field);
  if (st.value) return `<b>${esc(st.value)}</b>`;
  if (st.conflict) return identityClash(st.values);
  return `<b class="miss">${esc(field.miss)}</b>`;
}

/** One study, as the scan found it. Same shape the Inventory tab draws. */
function renameStudyCard(s) {
  const [name, pid, desc, acc] = RENAME_FIELDS.map((f) => renameFieldHtml(s, f));
  return `<div class="study-card">
    <h3>${name} · ${pid}</h3>
    <div class="uid">${esc(s.studyInstanceUid)}</div>
    <div class="study-meta">
      <span>${desc}</span>
      <span>accession ${acc}</span>
      <span>date ${s.studyDate ? `<b>${esc(s.studyDate)}</b>` : '<b class="miss">none</b>'}</span>
      <span><b>${(s.modalities || []).join(', ') || '—'}</b></span>
      <span><b>${s.seriesCount ?? '—'}</b> series</span>
      <span><b>${s.instanceCount ?? '—'}</b> instances</span>
    </div>
  </div>`;
}

/**
 * Draws the scan panel: what is there, or why this folder cannot be renamed.
 *
 * The refusal is the reason this tab exists as something other than a shortcut
 * to Edit. `dcm edit` applies to every instance under the path it is given and
 * has no way to be pointed at one study inside it, so "rename this study" in a
 * folder of three is not a thing that can be done — it would write one identity
 * over all three, which is a merge. There is no "do it anyway": the option
 * would only ever be pressed by someone who had misread the sentence above it.
 */
function renderRenameFound(html) {
  const box = $('#rename-found');
  box.innerHTML = html;
  box.hidden = !html;
}

/**
 * The composed PatientName, spelled out, so nothing is written unseen.
 *
 * This line is the whole guarantee. Everything the two boxes do not edit — the
 * middle name, the suffix, the kanji and kana spellings — is composed into the
 * value here first, and the value here is character-for-character the one that
 * goes after `--set PatientName=`. An operator who reads this line has read
 * the name that will be written.
 *
 * The counts after it name what is being carried rather than describing it.
 * Two words each: an operator who can already see "山田^太郎" in the value does
 * not need a sentence telling them it is there, they need to know it is kept
 * rather than about to be overwritten.
 */
function renderRenamePn() {
  const el = $('#rename-pn');
  const value = renameComposed();
  const notes = [];
  if (renameState.extras.length) {
    notes.push(`keeping ${renameState.extras.length} further component(s) the name already had`);
  }
  if (renameState.groups.length) {
    notes.push(`${renameState.groups.length} other spelling(s) kept`);
  }
  const kept = notes.length ? ` <span class="pn-kept">${esc(notes.join(', '))}</span>` : '';
  el.innerHTML = value
    ? `<b>PatientName</b> <span class="pn-value">${esc(value)}</span>${kept}`
    : '<b>PatientName</b> <span class="pn-value empty">(empty)</span>';
}

/** A value as it should read in the change list, blanks named rather than blank. */
function renameValueText(v) {
  return v ? `<span class="rn-b">${esc(v)}</span>` : '<span class="rn-b rn-none">(empty)</span>';
}

/**
 * One panel for every field that disagrees, rather than one panel per field.
 *
 * Four amber blocks down a screen is not four times the warning; it is a
 * screen that has gone amber, and the fourth block is read the way the first
 * three were — which is to say skipped. They would also be saying one thing
 * four times: these instances do not agree about what this study is. That is a
 * single fact about a single study, and the repair is a single press, so it
 * gets a single panel with a row per field.
 *
 * The per-field reasoning — what a disagreeing AccessionNumber costs versus a
 * disagreeing PatientID — is real, and it already exists in full in `dcm info`,
 * which prints a paragraph written for the particular field. Reprinting those
 * four paragraphs here would spend the whole screen on text an operator has to
 * scroll past to reach the boxes that fix it.
 *
 * Each value is a button because the repair is a choice between values that
 * are already on screen. Re-typing "ACC0000001" by eye is how a repair invents
 * a third value, and the buttons cost no words to explain.
 */
function renameConflictPanel() {
  const rows = RENAME_FIELDS.filter((f) => renameState.conflicts[f.keyword]);
  if (!rows.length) return '';
  const body = rows.map((f) => {
    const picks = renameState.conflicts[f.keyword].map((v) => `<button type="button" class="rn-pick" `
      + `data-adopt="${esc(f.keyword)}" data-value="${esc(v)}">${esc(v)}</button>`).join('');
    return `<div class="rn-cf-row"><span class="rn-cf-k">${esc(f.label)}</span>`
      + `<span class="rn-cf-v">${picks}</span></div>`;
  }).join('');
  return `<div class="caution rn-conflicts">`
    + `<strong>These instances disagree about what this study is.</strong> `
    + `One Study Instance UID has one identity, so nothing below is prefilled. `
    + `Pick or type a value and the rename writes it to every instance.`
    + `<div class="rn-cf">${body}</div></div>`;
}

/**
 * Taking one of the values a conflict is between.
 *
 * It fills the box; it does not rename anything. The operator still reads the
 * change list and still presses the button, so a mis-click is a mis-click and
 * not a rewritten study.
 */
function adoptConflictValue(keyword, value) {
  if (keyword === 'PatientName') {
    const pn = splitPn(value);
    // The adopted name brings its own tail and its own other scripts: taking
    // "DOE^JANE^Q" and then keeping the extras of the name we did not take
    // would compose a fifth name out of two the study already disagrees about,
    // and keeping its kanji under the other name's romaji would be the same
    // mistake in a script the operator cannot read to catch it.
    renameState.extras = pn.extras;
    renameState.groups = pn.groups;
    $('#rename-family').value = pn.family;
    $('#rename-given').value = pn.given;
  } else {
    const field = RENAME_FIELDS.find((f) => f.keyword === keyword);
    if (!field || !field.input) return;
    $(`#${field.input}`).value = value;
  }
  refreshRename();
}

/**
 * Marks the value the boxes currently hold, so the panel shows what was
 * chosen. Typing one of them by hand lights the same button: what is marked is
 * the state of the form, not the memory of a click.
 */
function syncConflictPicks() {
  const wanted = renameState.study ? renameWanted() : {};
  for (const btn of $$('#rename-found .rn-pick')) {
    btn.classList.toggle('chosen', wanted[btn.dataset.adopt] === btn.dataset.value);
  }
}

/** Only what differs, current -> new. Nothing to show is itself the answer. */
function renderRenameDiff() {
  const box = $('#rename-diff');
  const pairs = renamePairs();
  if (!pairs.length) { box.hidden = true; box.innerHTML = ''; return; }
  const labels = new Map(RENAME_FIELDS.map((f) => [f.keyword, f.label]));
  box.innerHTML = pairs.map(([keyword, value]) => {
    const was = renameState.current[keyword];
    const conflict = renameState.conflicts[keyword];
    let from;
    // A conflict is not an empty "before". Struck-through nothing would read
    // as "this study had no accession number", which is the same lie the card
    // is not allowed to tell.
    if (conflict) {
      from = `<span class="rn-a conflict">${conflict.map(esc).join(' / ')}</span>`;
    } else if (was) {
      from = `<span class="rn-a">${esc(was)}</span>`;
    } else {
      from = '<span class="rn-a rn-none">(empty)</span>';
    }
    return `<div class="rn-diff-row"><span class="rn-k">${esc(labels.get(keyword))}</span>`
      + `${from}<span class="rn-arrow"> → </span>${renameValueText(value)}</div>`;
  }).join('');
  box.hidden = false;
}

/**
 * The button, and the one thing it is allowed to say.
 *
 * An unchanged form is not an error to be discovered after pressing; the
 * button goes inert and relabels itself, so the screen answers the question
 * before it is asked.
 */
function syncRenameButton() {
  const btn = $('#view-rename [data-run]');
  const loaded = !!renameState.study;
  const pairs = renamePairs();
  btn.disabled = !loaded || !pairs.length;
  btn.textContent = loaded && !pairs.length ? 'Nothing changed yet' : 'Rename study';
}

/** Everything the loaded study put on screen, taken back off it. */
function resetRenameStudy() {
  renameState.path = '';
  renameState.study = null;
  renameState.current = null;
  renameState.extras = [];
  renameState.groups = [];
  renameState.conflicts = {};
  renderRenameFound('');
  $('#rename-form').hidden = true;
  $('#rename-diff').hidden = true;
  syncRenameButton();
  updateAllPreviews();
}

/** Fills the four boxes from the study, so an untouched field is visibly untouched. */
function seedRenameFields(s) {
  // `dcm info` gives a string only when every instance that carries the field
  // agrees. Two patient IDs under one Study Instance UID is not a current
  // value to prefill from — picking one would be inventing the answer — so
  // that box starts empty and the panel says what the disagreement is between.
  // Leaving it empty leaves the study alone; putting one value in writes that
  // value to every instance, which is what repairs it.
  renameState.conflicts = {};
  renameState.current = {};
  for (const field of RENAME_FIELDS) {
    const st = renameFieldState(s, field);
    if (st.conflict) renameState.conflicts[field.keyword] = st.values;
    renameState.current[field.keyword] = st.value;
  }

  const pn = splitPn(renameState.current.PatientName);
  renameState.extras = pn.extras;
  renameState.groups = pn.groups;

  $('#rename-family').value = pn.family;
  $('#rename-given').value = pn.given;
  for (const field of RENAME_FIELDS) {
    if (field.input) $(`#${field.input}`).value = renameState.current[field.keyword];
  }
}

/**
 * Reads the folder with `dcm info --json` and decides whether it can be renamed.
 *
 * `keepConsole` is for the re-read that follows an in-place rename. That write
 * is the destructive one and its report — how many instances were touched, per
 * tag — is the only account of it there will ever be, so the scan that proves
 * it worked is not allowed to wipe it off the screen on its way past. Every
 * other entry point clears, because a failure from the last folder must not sit
 * under the next one's card.
 */
async function scanRenameFolder({ keepConsole = false } = {}) {
  const folder = $('#rename-folder').value.trim();
  resetRenameStudy();
  if (!keepConsole) clearConsole('rename');
  if (!folder) return;

  setStatus('rename', 'running', 'Reading…');
  const { code, stdout, stderr } = await runCapture('rename', ['info', folder, '--json']);

  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  if (code !== 0 || !parsed) {
    setStatus('rename', 'fail', 'Failed');
    fail('rename', stdout || stderr || 'Could not read that folder.\n');
    return;
  }

  const studies = Array.isArray(parsed.studies) ? parsed.studies : [];
  if (!studies.length) {
    setStatus('rename', 'fail', 'Nothing there');
    renderRenameFound('<div class="caution"><strong>No DICOM instances here.</strong> '
      + `${parsed.filesExamined || 0} file(s) examined and none of them was a DICOM instance.</div>`);
    return;
  }

  if (studies.length > 1) {
    setStatus('rename', 'warn', `${studies.length} studies`);
    renderRenameFound(
      `<div class="caution"><strong>This folder holds ${studies.length} studies.</strong> `
      + 'A rename applies to every instance under the folder and cannot be pointed at one study '
      + `inside it, so renaming here would write a single identity over all ${studies.length} — `
      + 'a merge, not a rename. Point at one study\'s own folder instead.</div>'
      + studies.map(renameStudyCard).join('')
    );
    return;
  }

  const study = studies[0];
  renameState.path = folder;
  renameState.study = study;
  seedRenameFields(study);

  renderRenameFound(renameConflictPanel() + renameStudyCard(study));

  $('#rename-form').hidden = false;
  renderRenamePn();
  renderRenameDiff();
  syncRenameButton();
  syncConflictPicks();
  updateAllPreviews();
  // A loaded study whose instances disagree is loaded and is also a problem;
  // "Loaded" alone would put a green chip on the one outcome this screen
  // exists to catch.
  const clashes = Object.keys(renameState.conflicts).length;
  if (clashes) setStatus('rename', 'warn', `${clashes} field${clashes === 1 ? '' : 's'} disagree`);
  else setStatus('rename', 'ok', 'Loaded');
}

/** Every keystroke in the four boxes ends here. */
function refreshRename() {
  renderRenamePn();
  renderRenameDiff();
  syncRenameButton();
  syncConflictPicks();
  updateAllPreviews();
}

function renderRenameDest() {
  const inplace = renameDest() === 'inplace';
  $('#rename-out-row').hidden = inplace;
  $('#rename-inplace-note').hidden = !inplace;
}

function wireRename() {
  // A typed path is scanned when it is finished with, not per keystroke — each
  // scan is a child process. Changing it drops the loaded study first, so the
  // fields on screen can never belong to a folder other than the one named
  // above them. The picker dispatches `change`, so Browse… lands here too.
  $('#rename-folder').addEventListener('input', () => {
    if ($('#rename-folder').value.trim() !== renameState.path) resetRenameStudy();
  });
  $('#rename-folder').addEventListener('change', () => scanRenameFolder());

  for (const id of ['rename-family', 'rename-given', 'rename-patientid', 'rename-desc', 'rename-accession']) {
    $(`#${id}`).addEventListener('input', refreshRename);
  }

  // Delegated: the conflict panel is redrawn from scratch on every scan.
  $('#rename-found').addEventListener('click', (e) => {
    const pick = e.target.closest('.rn-pick');
    if (pick) adoptConflictValue(pick.dataset.adopt, pick.dataset.value);
  });
  $('#rename-out').addEventListener('input', updateAllPreviews);

  for (const chip of $$('#rename-dest-row .chip')) {
    chip.addEventListener('click', () => {
      $$('#rename-dest-row .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderRenameDest();
      updateAllPreviews();
    });
  }
  renderRenameDest();

  $('#view-rename [data-run]').addEventListener('click', async () => {
    clearConsole('rename');
    const folder = $('#rename-folder').value.trim();
    if (!folder) { fail('rename', 'Choose the folder holding the study first.\n'); return; }
    if (!renameState.study) {
      fail('rename', 'That folder has not been read yet, or it does not hold exactly one study.\n');
      return;
    }
    const pairs = renamePairs();
    if (!pairs.length) { fail('rename', 'Nothing differs from what the study already says.\n'); return; }

    const inplace = renameDest() === 'inplace';
    if (!inplace && !$('#rename-out').value.trim()) {
      fail('rename', 'Choose where to write the renamed copy.\n');
      return;
    }

    setStatus('rename', 'running', rehearsal() ? 'Previewing…' : (inplace ? 'Rewriting…' : 'Writing copy…'));
    const { code } = await runStreaming('rename', BUILDERS.rename());
    setStatus('rename', code === 0 ? 'ok' : 'fail', code === 0 ? 'Done' : 'Failed');
    // The source's own values have moved, so what is on screen as "current" is
    // now yesterday's. Re-read rather than leave a stale prefill behind.
    if (code === 0 && inplace) await scanRenameFolder({ keepConsole: true });
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
  // Preview-only is this tab's own switch (it is about the disk, not a peer);
  // rehearsal adds the same flag from the other direction.
  if ($('#edit-dryrun').checked || rehearsal()) argv.push('--dry-run');
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
    fail('edit', 'Choose a study folder or a .dcm file first.\n');
    return;
  }

  setStatus('edit', 'running', 'Loading…');
  // One representative file is what we edit against: a study shares its tag
  // structure, and dumping every instance would be slow and unreadable.
  const { code, stdout, stderr } = await runCapture('edit', ['tags', target, '--json']);
  setStatus('edit', code === 0 ? 'ok' : 'fail', code === 0 ? 'Loaded' : 'Failed');

  if (code !== 0) {
    fail('edit', stdout || stderr || 'Could not read tags.\n');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail('edit', stdout || 'Unexpected output.\n');
    return;
  }

  const first = (parsed.results || [])[0];
  if (!first) {
    fail('edit', 'No DICOM instances found there.\n');
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

    if (!target) { fail('edit', 'Choose a source folder or file.\n'); return; }
    if (!editState.changes.size && !editState.removals.size) {
      fail('edit', 'Nothing to apply — change a value or tick a tag to remove.\n');
      return;
    }
    if (!out) { fail('edit', 'Choose where to write the edited copy.\n'); return; }

    const touchingUid = [...editState.changes.keys(), ...editState.removals]
      .some((kw) => UID_KEYWORDS.has(kw));
    if (touchingUid && !$('#edit-force').checked) {
      appendConsole('edit',
        'That includes a UID, which is refused unless you tick "Allow editing UIDs".\n' +
        'Rewriting UIDs on some instances and not others splits a study. To get fresh\n' +
        'UIDs across a whole study consistently, use De-identify instead.\n', 'stderr');
      return;
    }

    setStatus('edit', 'running', ($('#edit-dryrun').checked || rehearsal()) ? 'Previewing…' : 'Writing…');
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

/** One line naming what de-identification was told to keep. */
function renderAnonAdvSummary() {
  const el = $('#anon-adv-sum');
  if (!el) return;
  const prefix = $('#anon-prefix').value.trim();
  const parts = [];
  if (prefix) parts.push(`pseudonyms as ${prefix}…`);
  if ($('#anon-keepdesc').checked) parts.push('keeps descriptions');
  if ($('#anon-keepprivate').checked) parts.push('keeps private tags');
  el.textContent = parts.length ? `— ${parts.join(' · ')}` : '— removes everything it knows how to remove';
  el.classList.toggle('changed', parts.length > 0);
}

function wireAnon() {
  ['anon-folder', 'anon-out', 'anon-prefix'].forEach((id) =>
    $(`#${id}`).addEventListener('input', () => { renderAnonAdvSummary(); updateAllPreviews(); }));
  ['anon-keepdesc', 'anon-keepprivate'].forEach((id) =>
    $(`#${id}`).addEventListener('change', () => { renderAnonAdvSummary(); updateAllPreviews(); }));
  renderAnonAdvSummary();
  $('#view-anon [data-run]').addEventListener('click', async () => {
    clearConsole('anon');
    const f = $('#anon-folder').value.trim();
    const out = $('#anon-out').value.trim();
    if (!f) { fail('anon', 'Choose a folder to de-identify.\n'); return; }
    if (!out) { fail('anon', 'Choose an output folder.\n'); return; }
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
        const field = $(`#${targetId}`);
        field.value = res.path;
        // A picked path is a path the operator chose, exactly as if they had
        // typed it and pressed Enter — so it fires `change` and any screen
        // that reacts to a folder being settled on (Rename reads it) reacts.
        field.dispatchEvent(new Event('change', { bubbles: true }));
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

// --------------------------------------------------------------------------
// Help panels — the ? in a screen's header
// --------------------------------------------------------------------------
/**
 * Every explanation the screens used to carry inline, one panel per screen.
 *
 * Deliberately a block under the header and not a floating popover. These
 * explanations run to several paragraphs, and a popover wide enough to hold
 * one would cover the very controls it is explaining and would need
 * edge-collision code against the page, the capped table scroll and the
 * panels — measurement logic this renderer has no business growing. A block
 * cannot be clipped and cannot cover data.
 *
 * Nothing that matters at the moment it arises is put in here: the folder
 * verdicts, the missing Type 1 notes, the amber Insane warning and every
 * failed outcome stay on the screen. What lives in a panel is the reasoning —
 * what an operator does not need to read to act, but does need to read to
 * trust the thing.
 *
 * Any control can open one: the Insane note and the de-identify caution carry
 * their own link into the panel that explains them, so the short line on
 * screen and the long form behind it are never two separate texts to keep in
 * agreement.
 */
function setHelp(id, open) {
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.hidden = !open;
  for (const btn of $$(`.help-btn[aria-controls="${id}"]`)) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (open) panel.scrollTop = 0;
}

function wireHelp() {
  document.addEventListener('click', (e) => {
    // A click inside an open panel is someone reading or selecting it.
    const close = e.target.closest('[data-help-close]');
    if (close) {
      const panel = close.closest('.help-panel');
      if (panel) setHelp(panel.id, false);
      return;
    }
    if (e.target.closest('.help-panel')) return;
    const btn = e.target.closest('[data-help]');
    if (!btn) return;
    // The icons sit inside <summary> and <label> elements that would otherwise
    // toggle a disclosure or a checkbox on the way past.
    e.preventDefault();
    e.stopPropagation();
    const panel = document.getElementById(btn.dataset.help);
    if (!panel) return;
    // The header's ? toggles; a link from inside the screen always opens, so
    // clicking "what going too wide looks like" never shuts the answer.
    const open = btn.classList.contains('help-btn') ? panel.hidden : true;
    setHelp(panel.id, open);
    if (open && !btn.classList.contains('help-btn')) panel.scrollIntoView({ block: 'nearest' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.help-panel:not([hidden])');
    if (!open.length) return;
    e.stopPropagation();
    for (const p of open) {
      setHelp(p.id, false);
      const btn = $(`.help-btn[aria-controls="${p.id}"]`);
      if (btn) btn.focus();
    }
  });
}

/** Ctrl/Cmd+Enter runs the active view's primary action. */
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const active = $('.view.active');
      // The first run button that is actually on screen: a tabbed screen holds
      // one per tab, and only the open tab's is in layout.
      const run = active && $$('[data-run]:not([disabled])', active).find((b) => b.offsetParent !== null);
      if (run) { run.click(); e.preventDefault(); }
    }
  });
}

// --------------------------------------------------------------------------
// Updates
// --------------------------------------------------------------------------
/**
 * Renders the update banner in the sidebar footer.
 *
 * Three shapes, because the builds differ in what they can actually do:
 *
 *   installed Windows  idle -> downloading -> ready       ("Restart & update")
 *   macOS              idle -> available -> fetching -> fetched
 *   portable Windows   idle -> available                  ("Download" -> page)
 *
 * The macOS states are deliberately not the Windows ones. "ready" means the
 * app has an update it can apply to itself; "fetched" means a disk image is
 * sitting in Downloads and the operator has to open it. Sharing a word
 * between those would make the banner claim something the app cannot do.
 *
 * Errors stay silent except the one that follows a click — a failed
 * background check is not worth a banner, but a download the operator asked
 * for and did not get has to say so, and has to leave a way forward.
 */
/** True on packaged builds, where the manual check link makes sense. */
let updateCheckEligible = false;

function renderUpdateState(s) {
  const banner = $('#update-banner');
  const text = $('#update-text');
  const action = $('#update-action');
  const note = $('#update-note');
  const more = $('#update-more');
  if (!banner || !s) return;

  const label = s.version ? `v${s.version}` : 'update';
  let visible = true;
  // Every state starts from nothing showing but the line of text, so no state
  // can inherit a button or a note from the one before it.
  action.hidden = true;
  action.disabled = false;
  action.onclick = null;
  note.hidden = true;
  note.textContent = '';
  more.hidden = true;

  if (s.status === 'downloading') {
    text.textContent = `Downloading ${label}… ${s.percent || 0}%`;
  } else if (s.status === 'ready') {
    text.textContent = `Update ${label} is ready.`;
    action.textContent = 'Restart & update';
    action.hidden = false;
    action.onclick = () => window.dcm.update.install();
  } else if (s.status === 'fetching') {
    // "Getting", not "Installing" and not "Updating". The app is fetching a
    // file for you; that is the whole of what is happening.
    text.textContent = `Getting ${label}… ${s.percent || 0}%`;
    if (s.name) { note.textContent = s.name; note.hidden = false; }
  } else if (s.status === 'fetched') {
    // Two lines, and the second one is the Gatekeeper step — said here,
    // once, at the only moment it is about to matter. Not right-click → Open:
    // macOS 15 removed that, and sending someone to a menu item that is no
    // longer there is worse than saying nothing.
    text.textContent = s.checked === 'sha512'
      ? `${label} downloaded and checksum-verified. Open it from Downloads to install it.`
      : `${label} downloaded — the size matches, the release checksum was unavailable. Open it from Downloads to install it.`;
    note.textContent = 'macOS will say it cannot verify the app: System Settings → Privacy & Security → Open Anyway.';
    note.hidden = false;
    action.textContent = 'Show in Finder';
    action.hidden = false;
    action.onclick = () => { if (s.file) window.dcm.reveal(s.file); };
    more.hidden = false;
    more.onclick = () => {
      showView('settings');
      setHelp('mac-update-help', true);
      // Settings is a long screen and this panel sits near the bottom of it.
      // Opening it out of sight would look like the link did nothing.
      const panel = $('#mac-update-help');
      if (panel) panel.scrollIntoView({ block: 'center' });
    };
  } else if (s.status === 'available') {
    text.textContent = `${label} is available.`;
    if (s.download) {
      // The file is named on the banner before the click. Being able to see
      // which of the two images is about to be fetched is the whole point of
      // this path: it is the check nobody could make on the releases page.
      action.textContent = 'Download for this Mac';
      note.textContent = s.download.name;
      note.hidden = false;
      action.onclick = async () => {
        action.disabled = true;
        const r = await window.dcm.update.download();
        // Main takes over the banner from here via update:status. It only
        // comes back with no-asset if this banner is stale — a re-check that
        // cleared the match — and then the page is still the way forward.
        if (!r || (!r.ok && r.reason === 'no-asset')) {
          action.disabled = false;
          window.dcm.update.openReleases(s.version);
        }
      };
    } else {
      action.textContent = 'Download';
      action.onclick = () => window.dcm.update.openReleases();
    }
    action.hidden = false;
  } else if (s.status === 'error' && s.fallback === 'releases') {
    text.textContent = `Could not download ${label}: ${s.message || 'unknown error'}.`;
    action.textContent = 'Open the releases page';
    action.hidden = false;
    action.onclick = () => window.dcm.update.openReleases(s.version);
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
  if (state.info.platform === 'darwin') {
    // $$ (querySelectorAll), not $ (querySelector). $ returns one Element,
    // which has no forEach, so this threw on macOS and only on macOS — before
    // the onStatus subscription two lines down, which left the update banner
    // dead on the one platform this path exists for.
    $$('.mac-only').forEach((el) => { el.hidden = false; });
  }
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
  // In-page links to another screen ("← Settings" on the echo screen).
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) showView(go.dataset.goto);
  });

  await loadSettings();
  await loadProfiles();
  // The web chip starts on the first saved server; the peer chips start on
  // whichever saved peer holds each screen's role, chosen when the screen opens.
  state.web.url = (webProfiles()[0] || {}).url || '';
  wirePeerChips();
  wireTabs();
  wireSettings();

  wireHelp();
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
  wireRename();
  wireEdit();
  wireAnon();
  wirePickers();
  wireCopy();
  wireKeyboard();
  wireUpdates();
  checkMcpStatus();

  renderSettingsForm();
  refreshPeerViews();
  // Seeds the screens from Settings, folds the commands, raises the banner,
  // and rebuilds every preview from all of it.
  applySettings();

  // Where the last session left off. The first launch, and any launch whose
  // remembered screen no longer exists, lands on the station (showView falls
  // back to the worklist for a name it does not know).
  let remembered = null;
  try { remembered = await window.dcm.appState.get(); } catch { remembered = null; }
  const tabs = (remembered && remembered.activeTabs) || {};
  for (const [group, tab] of Object.entries(tabs)) if (typeof tab === 'string') showTab(group, tab);
  showView((remembered && remembered.activeView) || 'worklist');
}

boot();
