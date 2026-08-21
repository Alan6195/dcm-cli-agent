'use strict';

/**
 * Headless smoke driver.
 *
 * Loaded from main.js only when DCM_SMOKE_DIR is set, so it never touches a
 * normal launch. It walks the window through each view, captures a screenshot
 * of each, drives one real inventory run so the structured table is exercised,
 * and exits. This is how the app is verified without a human at a display.
 */

const fs = require('node:fs');
const path = require('node:path');

const VIEWS = [
  'echo', 'send', 'receive', 'query', 'worklist', 'speed',
  'webping', 'websend', 'webquery', 'webhub',
  'inventory', 'tags', 'edit', 'anon', 'mcp',
];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
async function waitFor(win, expr, ms = 20000, label = expr) {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await win.webContents.executeJavaScript(`!!(${expr})`).catch(() => false);
    if (ok) return true;
    if (Date.now() > deadline) {
      process.stdout.write(`waitFor timed out after ${ms}ms: ${label}
`);
      return false;
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(200);
  }
}

/**
 * What an operator actually faces in the live DOM: visible words and visible
 * inputs, with hidden elements removed and closed <details> bodies excluded.
 * The pre-merge renderer was measured with exactly this rule, so the before
 * and after numbers are comparable.
 */
const MEASURE = (sel) => `
  (() => {
    const root = document.querySelector(${JSON.stringify(sel)});
    const clone = root.cloneNode(true);
    for (const el of clone.querySelectorAll('[hidden]')) el.remove();
    for (const d of clone.querySelectorAll('details:not([open]) .adv-body')) d.remove();
    const words = (clone.textContent.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
    const inputs = Array.from(root.querySelectorAll('input, select, textarea'))
      .filter((el) => el.offsetParent !== null && !el.closest('details:not([open])')).length;
    return JSON.stringify({ words, inputs });
  })()`;

async function measure(win, label, sink) {
  const r = JSON.parse(await win.webContents.executeJavaScript(MEASURE('#view-worklist')));
  const line = `${label}: ${r.words} words, ${r.inputs} inputs`;
  process.stdout.write(`${line}\n`);
  sink.push(line);
  return r;
}

async function shot(win, outDir, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  process.stdout.write(`shot: ${file}\n`);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('electron').App} app
 */
async function runSmoke(win, app) {
  const outDir = process.env.DCM_SMOKE_DIR;
  const fixtures = process.env.DCM_SMOKE_FIXTURES || '';
  const measured = [];
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await win.webContents.executeJavaScript('true').catch(() => {});
    await wait(1200); // let boot() finish (engine info + profiles)

    for (const v of VIEWS) {
      await win.webContents.executeJavaScript(`showView(${JSON.stringify(v)}); true`);
      await wait(250);
      await shot(win, outDir, `view-${v}`);
    }

    // Drive a real inventory run to exercise the structured table + engine spawn.
    if (fixtures) {
      await win.webContents.executeJavaScript(`
        showView('inventory');
        document.querySelector('#info-folder').value = ${JSON.stringify(fixtures)};
        document.querySelector('#info-series').checked = true;
        document.querySelector('#view-inventory [data-run]').click();
        true
      `);
      // Wait for the child engine process to finish, not for a guessed number
      // of milliseconds — a run still in flight competes with the next screen's
      // child for the same machine, which is how this harness used to go flaky.
      await waitFor(
        win,
        "!document.querySelector('#view-inventory [data-status]').className.includes('running')",
        25000,
        'the inventory run to finish'
      );
      await shot(win, outDir, 'inventory-result');

      // Capture the live command preview text for the record.
      const preview = await win.webContents.executeJavaScript(
        `document.querySelector('#view-inventory [data-cmd]').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'inventory-cmd.txt'), preview || '');
      process.stdout.write(`inventory cmd: ${preview}\n`);
    }

    // Drive a streaming send --dry-run to exercise the console-output path
    // that Send / Receive / Edit / De-identify all share.
    if (fixtures) {
      await win.webContents.executeJavaScript(`
        showView('send');
        document.querySelector('#send-folder').value = ${JSON.stringify(fixtures)};
        document.querySelector('#send-dryrun').checked = true;
        document.querySelector('#view-send [data-run]').click();
        true
      `);
      await waitFor(
        win,
        "!document.querySelector('#view-send [data-status]').className.includes('running')",
        25000,
        'the send dry run to finish'
      );
      await shot(win, outDir, 'send-dryrun-result');
      const consoleText = await win.webContents.executeJavaScript(
        `document.querySelector('#view-send [data-console]').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'send-console.txt'), consoleText || '');
      process.stdout.write(`send console bytes: ${(consoleText || '').length}\n`);
    }

    // ---------------------------------------------------------------------
    // The one workspace: query -> pick a row -> perform -> close.
    //
    // No MWL SCP is needed. The renderer is fed matches in the shape
    // `dcm find --mwl --json` emits, a row is clicked, and the commands the
    // screen builds are captured. That is the whole contract: the selection
    // carries the row's attributes into a command, both peers appear in it in
    // full, and the two ways past a study mismatch stay a visible choice.
    // ---------------------------------------------------------------------
    {
      const folder = fixtures || '/tmp/study';
      const WL_UID = '2.25.7409558135166679574647759021724211267';

      // --- S1: nothing queried ---------------------------------------------
      await win.webContents.executeJavaScript(`
        showView('worklist');
        state.conn = { host: '127.0.0.1', port: '11112', calledAe: 'RISMPPS', callingAe: 'CT01' };
        syncConnInputs();
        updateAllPreviews();
        true
      `);
      await wait(300);
      await shot(win, outDir, 'wl-1-empty');

      // What an operator faces before anything has happened.
      await measure(win, 'workspace at rest', measured);

      // --- S3: results ------------------------------------------------------
      await win.webContents.executeJavaScript(`
        renderWorklist({ matches: [{
          PatientName: 'DOE^JANE', PatientID: 'P-1001', AccessionNumber: 'ACC-77',
          StudyInstanceUID: ${JSON.stringify(WL_UID)}, Modality: 'CT',
          ScheduledProcedureStepID: 'SPS-1', ScheduledProcedureStepStartDate: '20260820',
          ScheduledProcedureStepStartTime: '0930', ScheduledStationAETitle: 'CT01',
          RequestedProcedureDescription: 'CT Abdomen', RequestedProcedureID: 'RP-5',
        }, {
          PatientName: 'SMITH^ALAN', PatientID: 'P-2002', AccessionNumber: 'ACC-78',
          StudyInstanceUID: '1.2.826.0.1.3680043.8.498.10101', Modality: 'CR',
          ScheduledProcedureStepID: 'SPS-2', ScheduledProcedureStepStartDate: '20260820',
          ScheduledProcedureStepStartTime: '1015', ScheduledStationAETitle: 'CR02',
          RequestedProcedureDescription: 'Chest 2 View', RequestedProcedureID: 'RP-6',
        }] });
        true
      `);
      await wait(250);
      await shot(win, outDir, 'wl-2-results');

      const cols = await win.webContents.executeJavaScript(
        `JSON.stringify(Array.from(document.querySelectorAll('#mwl-table thead th')).map((t) => t.textContent))`
      );
      process.stdout.write(`table columns: ${cols}\n`);

      // --- S4/S6: a row selected, the action panel open ----------------------
      await win.webContents.executeJavaScript(`
        document.querySelector('#mwl-table tr.pick-row').click();
        document.querySelector('#mpps-folder').value = ${JSON.stringify(folder)};
        document.querySelector('#mpps-folder').dispatchEvent(new Event('input', {bubbles:true}));
        true
      `);
      // The folder check is a real `dcm info --json` child process. Wait for the
      // verdict itself, not for the absence of one: an empty box is the state
      // before the check starts as well as after it.
      await waitFor(
        win,
        "(() => { const b = document.querySelector('#mpps-folder-check');"
          + " return !b.hidden && b.textContent && !b.textContent.startsWith('Reading'); })()",
        25000,
        'the folder check to produce a verdict'
      );
      await wait(200);
      await shot(win, outDir, 'wl-3-row-selected');

      const panelOpen = await win.webContents.executeJavaScript(
        `JSON.stringify({
          panel: !document.querySelector('#mwl-detail-body').hidden,
          mode: !document.querySelector('#mwl-perform-mode').hidden ? 'perform' : 'close',
          title: document.querySelector('#mwl-detail-title').textContent,
          assert: document.querySelector('#mpps-assert-sum').textContent,
          folderCheck: document.querySelector('#mpps-folder-check').textContent,
        })`
      );
      process.stdout.write(`action panel: ${panelOpen}\n`);
      if (!JSON.parse(panelOpen).panel) throw new Error('the action panel did not open on select');

      await measure(win, 'workspace, row selected + folder chosen', measured);

      // The inputs an operator faces mid-task, with the disclosures closed.
      const midInputs = await win.webContents.executeJavaScript(`
        JSON.stringify(Array.from(document.querySelectorAll('#view-worklist input'))
          .filter((el) => el.offsetParent !== null && !el.closest('details:not([open])'))
          .map((el) => el.id || el.getAttribute('data-fix') || el.type))
      `);
      process.stdout.write(`workspace inputs, row selected: ${midInputs}\n`);
      fs.writeFileSync(path.join(outDir, 'workspace-inputs.txt'), midInputs || '');

      const mppsCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-cmd').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'mpps-cmd.txt'), mppsCmd || '');
      process.stdout.write(`mpps cmd: ${mppsCmd}\n`);
      for (const needed of ['mpps perform', '--study-uid', '--mpps-uid', '--dry-run']) {
        if (!String(mppsCmd).includes(needed)) {
          throw new Error(`mpps command preview is missing ${needed}: ${mppsCmd}`);
        }
      }
      for (const banned of ['--write-acknowledged', '--record-dir', '--record ']) {
        if (String(mppsCmd).includes(banned)) {
          throw new Error(`mpps command preview still writes a record (${banned}): ${mppsCmd}`);
        }
      }
      // The query command is a separate preview in the same section and must
      // not have been overwritten by the perform one.
      const findCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#mwl-cmd').textContent`
      );
      process.stdout.write(`find cmd: ${findCmd}\n`);
      if (!String(findCmd).includes('find') || !String(findCmd).includes('--mwl')) {
        throw new Error(`the query preview was clobbered: ${findCmd}`);
      }

      // --- the info icon -----------------------------------------------------
      await win.webContents.executeJavaScript(`
        document.querySelector('.info-btn[aria-controls="info-overview"]').click();
        true
      `);
      await wait(250);
      await shot(win, outDir, 'wl-4-info-open');
      const infoState = await win.webContents.executeJavaScript(
        `JSON.stringify({
          open: !document.querySelector('#info-overview').hidden,
          expanded: document.querySelector('.info-btn[aria-controls="info-overview"]').getAttribute('aria-expanded'),
          openCount: document.querySelectorAll('.info-pop:not([hidden])').length,
          words: (document.querySelector('#info-overview').textContent.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length,
        })`
      );
      process.stdout.write(`info icon: ${infoState}\n`);
      if (!JSON.parse(infoState).open) throw new Error('the info block did not open');
      if (JSON.parse(infoState).openCount !== 1) throw new Error('more than one info block open at once');
      // Clicking elsewhere closes it.
      await win.webContents.executeJavaScript(`document.body.click(); true`);
      await wait(150);
      const infoClosed = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.info-pop:not([hidden])').length`
      );
      if (infoClosed !== 0) throw new Error('the info block did not close on an outside click');

      // --- the Advanced disclosure -------------------------------------------
      const closedSummary = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-adv-sum').textContent`
      );
      process.stdout.write(`advanced summary (defaults): ${closedSummary}\n`);

      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#mpps-adv').open = true;
        document.querySelector('#mpps-store-same').checked = false;
        document.querySelector('#mpps-store-same').dispatchEvent(new Event('change', {bubbles:true}));
        const set = (id, v) => {
          const el = document.querySelector('#' + id);
          el.value = v;
          el.dispatchEvent(new Event('input', {bubbles:true}));
        };
        set('mpps-store-host', 'pacs.example.org');
        set('mpps-store-port', '104');
        set('mpps-store-ae', 'ARCHIVE');
        set('mpps-chunk', '50');
        document.querySelector('#mpps-adv').scrollIntoView({ block: 'start' });
        return true;
      })()`);
      await wait(250);
      await shot(win, outDir, 'wl-5-advanced');

      await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-adv').open = false;
         document.querySelector('#mpps-adv').scrollIntoView({ block: 'center' });
         true`
      );
      await wait(200);
      const openSummary = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-adv-sum').textContent`
      );
      process.stdout.write(`advanced summary (changed): ${openSummary}\n`);
      for (const needed of ['pacs.example.org', 'ARCHIVE', 'chunk 50']) {
        if (!String(openSummary).includes(needed)) {
          throw new Error(`advanced summary hides ${needed}: ${openSummary}`);
        }
      }

      const bothPeers = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-cmd').textContent`
      );
      for (const needed of ['--store-host', '--store-port', '--store-called-ae']) {
        if (!String(bothPeers).includes(needed)) {
          throw new Error(`mpps command preview is missing ${needed}: ${bothPeers}`);
        }
      }

      // --- the stock-image case ---------------------------------------------
      const found = await win.webContents.executeJavaScript(
        `state.mpps.mismatch ? state.mpps.mismatch.kind : null`
      );
      process.stdout.write(`mismatch detected from the real folder scan: ${found}\n`);
      if (found !== 'one-study') {
        await win.webContents.executeJavaScript(`
          state.mpps.mismatch = {
            kind: 'one-study',
            declared: ${JSON.stringify(WL_UID)},
            onDisk: '1.2.826.0.1.3680043.2.174.20260220.7102849763113',
            instances: 36,
            description: 'L PD SAG L EXTREMITY',
            patientId: 'STOCK-1',
          };
          renderMppsMismatch();
          updateAllPreviews();
          true
        `);
        await wait(200);
      }
      await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-mismatch').scrollIntoView({ block: 'start' }); true`
      );
      await wait(200);
      await shot(win, outDir, 'wl-6-mismatch');

      // The choice must be on screen, not folded into a disclosure.
      const choiceVisible = await win.webContents.executeJavaScript(
        `JSON.stringify({
          panel: !document.querySelector('#mpps-mismatch').hidden,
          choices: !document.querySelector('#mpps-choices').hidden,
          insideDetails: !!document.querySelector('#mpps-mismatch').closest('details'),
          flags: Array.from(document.querySelectorAll('#mpps-choices .choice-flag code')).map((c) => c.textContent),
        })`
      );
      process.stdout.write(`mismatch choice: ${choiceVisible}\n`);
      {
        const c = JSON.parse(choiceVisible);
        if (!c.panel || !c.choices) throw new Error('the mismatch choice is not visible');
        if (c.insideDetails) throw new Error('the mismatch choice was buried in a disclosure');
        if (!c.flags.includes('--adopt-worklist-identity') || !c.flags.includes('--allow-study-mismatch')) {
          throw new Error(`each choice must show its flag: ${choiceVisible}`);
        }
      }

      // The per-choice info icon lives inside a <label> wrapping a radio, so
      // opening it must not pick that choice on the way past.
      const choiceInfo = await win.webContents.executeJavaScript(`(() => {
        const before = document.querySelector('#mpps-choices input[data-fix="asis"]').checked;
        document.querySelector('.info-btn[aria-controls="info-asis"]').click();
        return JSON.stringify({
          before,
          after: document.querySelector('#mpps-choices input[data-fix="asis"]').checked,
          open: !document.querySelector('#info-asis').hidden,
        });
      })()`);
      process.stdout.write(`per-choice info icon: ${choiceInfo}\n`);
      {
        const c = JSON.parse(choiceInfo);
        if (!c.open) throw new Error('the per-choice info block did not open');
        if (c.before !== c.after) {
          throw new Error('opening an explanation changed the choice it explains');
        }
      }
      await win.webContents.executeJavaScript(`document.body.click(); true`);
      await wait(150);

      await measure(win, 'workspace, mismatch armed (worst honest case)', measured);

      const adoptCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-cmd').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'mpps-mismatch-adopt-cmd.txt'), adoptCmd || '');
      process.stdout.write(`mismatch, default choice: ${adoptCmd}\n`);
      if (!String(adoptCmd).includes('--adopt-worklist-identity')) {
        throw new Error(`the recommended choice does not add its flag: ${adoptCmd}`);
      }

      await win.webContents.executeJavaScript(`(() => {
        const asis = document.querySelector('#mpps-choices input[data-fix="asis"]');
        asis.checked = true;
        asis.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      })()`);
      await wait(200);
      await shot(win, outDir, 'wl-7-mismatch-as-is');
      const asIsCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-cmd').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'mpps-mismatch-asis-cmd.txt'), asIsCmd || '');
      process.stdout.write(`mismatch, send as-is: ${asIsCmd}\n`);
      if (!String(asIsCmd).includes('--allow-study-mismatch')
        || String(asIsCmd).includes('--adopt-worklist-identity')) {
        throw new Error(`the two ways past a mismatch are not exclusive: ${asIsCmd}`);
      }

      // Put the panel back on the recommended choice for the screenshots below.
      await win.webContents.executeJavaScript(`(() => {
        const adopt = document.querySelector('#mpps-choices input[data-fix="adopt"]');
        adopt.checked = true;
        adopt.dispatchEvent(new Event('change', {bubbles:true}));
        state.mpps.mismatch = null;
        renderMppsMismatch();
        updateAllPreviews();
        return true;
      })()`);
      await wait(200);
      // The target resting state of the job: a row picked, a folder that
      // matches, nothing wrong. This is the number the redesign is aimed at.
      await measure(win, 'workspace, row selected + folder OK (no mismatch)', measured);
    }

    // ---------------------------------------------------------------------
    // Finished runs. Two runs' worth of real engine report text are pushed
    // through the renderer's own parser and its own rememberStep(), exactly as
    // a live run would: one COMPLETED, one whose N-SET failed, and one whose
    // N-CREATE failed and which must therefore leave no trace anywhere.
    //
    // The shortfall run is the one that matters most: DISCONTINUED has to read
    // as a failure, with its counts, and must never be rounded up.
    // ---------------------------------------------------------------------
    {
      const completed = [
        '',
        'MPPS SOP Instance UID  2.25.27182818284590452353602874713526624977',
        'study                  1.2.826.0.1.3680043.8.498.10101',
        'images sent to         ARCHIVE at pacs.example.org:104',
        'MPPS sent to           MPPSSCP at ris.example.org:11112',
        '',
        '  found                412',
        '  sent                 412',
        '  acknowledged         412',
        '  referenced in MPPS   412',
        '',
        '  performed series     1',
        '    1.2.3.9  412 instance(s)',
        '',
        'step status            COMPLETED',
        '',
        'OK  every instance found was acknowledged and is referenced in the MPPS.',
        '',
      ].join('\n');

      // The N-SET failure: no "step status" line on stdout at all, and the
      // sentence that says the step is still open printed on stderr. That
      // split is why the parser reads both streams.
      const openStdout = [
        '',
        'MPPS SOP Instance UID  2.25.31415926535897932384626433832795028841',
        'study                  2.25.7409558135166679574647759021724211267',
        'images sent to         ARCHIVE at pacs.example.org:104',
        'MPPS sent to           MPPSSCP at ris.example.org:11112',
        '',
        '  found                36',
        '  sent                 36',
        '  acknowledged         36',
        '  referenced in MPPS   36',
        '',
        '  performed series     1',
        '',
      ].join('\n');
      const openStderr =
        'N-SET failed — the step is still IN PROGRESS on MPPSSCP\n';

      const seeded = await win.webContents.executeJavaScript(`(() => {
        const peer = { host: 'ris.example.org', port: '11112', calledAe: 'MPPSSCP', callingAe: 'CT01' };
        const store = { host: 'pacs.example.org', port: '104', calledAe: 'ARCHIVE' };
        const a = rememberStep({
          report: parseMppsReport(${JSON.stringify(completed)}),
          attrs: { patientName: 'SMITH^ALAN', patientId: 'P-2002', modality: 'CR',
                   scheduledStepId: 'SPS-2',
                   studyInstanceUid: '1.2.826.0.1.3680043.8.498.10101' },
          uid: 'unused-the-report-names-its-own',
          folder: '/studies/completed', peer, store,
        });
        const b = rememberStep({
          report: parseMppsReport(${JSON.stringify(openStdout)}, ${JSON.stringify(openStderr)}),
          attrs: { patientName: 'DOE^JANE', patientId: 'P-1001', modality: 'CT',
                   scheduledStepId: 'SPS-1',
                   studyInstanceUid: '2.25.7409558135166679574647759021724211267' },
          uid: 'unused-the-report-names-its-own',
          folder: '/studies/open', peer, store,
        });
        // A run whose N-CREATE failed opened no step, so it must leave no trace.
        const c = rememberStep({
          report: parseMppsReport('', 'N-CREATE failed — the procedure step was never opened, so nothing was sent\\n'),
          attrs: { patientName: 'NOBODY', patientId: '', modality: '', studyInstanceUid: '' },
          uid: '2.25.999', folder: '/studies/never', peer, store,
        });
        refreshSessionBadges();
        return JSON.stringify({ a, b, c, entries: state.steps.entries.length });
      })()`);
      process.stdout.write(`steps remembered: ${seeded}\n`);
      if (JSON.parse(seeded).c !== false) {
        throw new Error('a run that never opened a step was remembered anyway');
      }
      await wait(300);
      await shot(win, outDir, 'wl-8-session-badges');

      // The badges landed on the worklist rows, and nowhere else.
      const badges = await win.webContents.executeJavaScript(
        `JSON.stringify(Array.from(document.querySelectorAll('#mwl-table tr.pick-row')).map((tr) => ({
          accession: tr.children[5].textContent,
          badge: tr.querySelector('td.session-cell').textContent.trim(),
        })))`
      );
      process.stdout.write(`session badges: ${badges}\n`);
      {
        const b = JSON.parse(badges);
        if (!b.some((r) => r.badge.includes('completed here'))) {
          throw new Error(`the COMPLETED step did not badge its row: ${badges}`);
        }
        if (!b.some((r) => r.badge.includes('open'))) {
          throw new Error(`the still-open step did not badge its row: ${badges}`);
        }
        // The badge may never be phrased as the RIS's verdict.
        for (const r of b) {
          if (/\bdone\b|\bfinished\b|RIS/i.test(r.badge)) {
            throw new Error(`a badge claims the far end changed: ${r.badge}`);
          }
        }
      }

      const rows = await win.webContents.executeJavaScript(
        `document.querySelectorAll('#steps-results tr.pick-row').length`
      );
      process.stdout.write(`session steps rows: ${rows}\n`);
      if (rows !== 2) throw new Error(`expected 2 session steps, got ${rows}`);

      // Nothing on this screen may name a file the app wrote.
      const listText = await win.webContents.executeJavaScript(
        `document.querySelector('#view-worklist').textContent`
      );
      for (const banned of ['--record-dir', '--write-acknowledged', 'Record folder', 'Record file']) {
        if (String(listText).includes(banned)) {
          throw new Error(`the workspace still mentions ${banned}`);
        }
      }

      // --- closing an open step, in the same panel, without leaving --------
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#session-steps').open = true;
        const rows = Array.from(document.querySelectorAll('#steps-results tr.pick-row'));
        const open = rows.find((tr) => tr.textContent.includes('IN PROGRESS')) || rows[0];
        open.click();
        return true;
      })()`);
      await wait(300);
      await win.webContents.executeJavaScript(
        `document.querySelector('#mwl-detail').scrollIntoView({ block: 'start' }); true`
      );
      await wait(200);
      await shot(win, outDir, 'wl-9-closing-mode');

      const closeMode = await win.webContents.executeJavaScript(
        `JSON.stringify({
          mode: !document.querySelector('#mwl-close-mode').hidden ? 'close' : 'perform',
          title: document.querySelector('#mwl-detail-title').textContent,
          note: document.querySelector('#steps-note').textContent.slice(0, 160),
        })`
      );
      process.stdout.write(`closing mode: ${closeMode}\n`);
      if (JSON.parse(closeMode).mode !== 'close') {
        throw new Error('selecting a session step did not put the panel into closing mode');
      }
      // The peer is named, so the invariant is checkable rather than merely stated.
      if (!JSON.parse(closeMode).note.includes('ris.example.org')) {
        throw new Error(`the closing panel does not name the peer it was opened on: ${closeMode}`);
      }

      const closeCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#steps-close-cmd').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'steps-close-cmd.txt'), closeCmd || '');
      process.stdout.write(`steps close cmd: ${closeCmd}\n`);
      for (const needed of [
        'mpps complete',
        '2.25.31415926535897932384626433832795028841',
        '--host ris.example.org', '--called-ae MPPSSCP',
      ]) {
        if (!String(closeCmd).includes(needed)) {
          throw new Error(`close command is missing ${needed}: ${closeCmd}`);
        }
      }
      if (String(closeCmd).includes('--acknowledged')) {
        throw new Error(`close command still reads a step file: ${closeCmd}`);
      }
      // Every instance found was acknowledged, so naming the folder as the
      // performed series is offered and taken by default.
      if (!String(closeCmd).includes('--series-from /studies/open')) {
        throw new Error(`the fully-acknowledged step does not offer its folder: ${closeCmd}`);
      }
      // The close goes to the peer it was opened on, never to the live panel.
      if (String(closeCmd).includes('127.0.0.1') || String(closeCmd).includes('RISMPPS')) {
        throw new Error(`the close was aimed at the connection panel, not the entry: ${closeCmd}`);
      }

      await win.webContents.executeJavaScript(`
        document.querySelector('#steps-verb .chip[data-verb="discontinue"]').click();
        const rc = document.querySelector('#steps-reasoncode');
        rc.value = '110513^DCM^Discontinued for equipment failure';
        rc.dispatchEvent(new Event('input', {bubbles:true}));
        true
      `);
      await wait(250);
      await shot(win, outDir, 'wl-10-discontinue');
      const discCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#steps-close-cmd').textContent`
      );
      process.stdout.write(`steps discontinue cmd: ${discCmd}\n`);
      if (!String(discCmd).includes('mpps discontinue') || !String(discCmd).includes('--reason-code')) {
        throw new Error(`discontinue command is wrong: ${discCmd}`);
      }

      // A COMPLETED entry is history: it offers nothing, and says why.
      await win.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('#steps-results tr.pick-row'));
        const done = rows.find((tr) => tr.textContent.includes('COMPLETED'));
        if (done) done.click();
        return true;
      })()`);
      await wait(300);
      const closedState = await win.webContents.executeJavaScript(
        `JSON.stringify({
          offersNothing: document.querySelector('#steps-close').hidden,
          disabled: document.querySelector('#steps-close-run').disabled,
          title: document.querySelector('#mwl-detail-title').textContent,
          note: document.querySelector('#steps-note').textContent.slice(0, 90),
        })`
      );
      process.stdout.write(`already-closed step: ${closedState}\n`);
      if (!JSON.parse(closedState).offersNothing) {
        throw new Error('a COMPLETED step still offers a way to close it again');
      }
      await shot(win, outDir, 'wl-11-already-closed');

      // --- the shortfall ----------------------------------------------------
      // DISCONTINUED is a failure, with its counts, and is never rounded up.
      const shortfall = [
        '',
        'MPPS SOP Instance UID  2.25.16180339887498948482045868343656381177',
        'study                  2.25.7409558135166679574647759021724211267',
        'images sent to         ARCHIVE at pacs.example.org:104',
        'MPPS sent to           MPPSSCP at ris.example.org:11112',
        '',
        '  found                214',
        '  sent                 214',
        '  acknowledged         211',
        '  referenced in MPPS   211',
        '',
        'step status            DISCONTINUED',
        '',
        '211 of 214 instances were acknowledged. 3 are unaccounted for.',
        '',
      ].join('\n');

      await win.webContents.executeJavaScript(`(() => {
        // Put the panel back in perform mode against the worklist row, the way
        // a real run that ended in a shortfall would leave it.
        document.querySelector('#mwl-table tr.pick-row').click();
        const report = parseMppsReport(${JSON.stringify(shortfall)});
        renderMppsTotals(report);
        renderMppsOutcome({ code: 1, report, dryRun: false });
        rememberStep({
          report,
          attrs: { patientName: 'DOE^JANE', patientId: 'P-1001', modality: 'CT',
                   scheduledStepId: 'SPS-1',
                   studyInstanceUid: '2.25.7409558135166679574647759021724211267' },
          uid: 'unused', folder: '/studies/short',
          peer: { host: 'ris.example.org', port: '11112', calledAe: 'MPPSSCP', callingAe: 'CT01' },
          store: { host: 'pacs.example.org', port: '104', calledAe: 'ARCHIVE' },
        });
        refreshSessionBadges();
        document.querySelector('#mpps-outcome').scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await wait(350);
      await shot(win, outDir, 'wl-12-shortfall');

      const short = await win.webContents.executeJavaScript(
        `JSON.stringify({
          cls: document.querySelector('#mpps-outcome').className,
          head: document.querySelector('#mpps-outcome .outcome-head').textContent,
          body: document.querySelector('#mpps-outcome').textContent,
          status: document.querySelector('#mpps-status').textContent,
          cards: Array.from(document.querySelectorAll('#mpps-totals .total-card')).map(
            (c) => c.className.replace('total-card', '').trim() + ':' + c.querySelector('.num').textContent),
          badge: (() => {
            const b = document.querySelector('#mwl-table tr.pick-row td.session-cell');
            return b ? b.textContent.trim() : '';
          })(),
        })`
      );
      process.stdout.write(`shortfall outcome: ${short}\n`);
      {
        const s = JSON.parse(short);
        if (!s.cls.includes('bad')) throw new Error(`a shortfall is not styled as a failure: ${s.cls}`);
        if (!/failure/i.test(s.head)) throw new Error(`a shortfall does not read as a failure: ${s.head}`);
        if (!s.body.includes('211 of 214')) {
          throw new Error(`the shortfall counts are not shown: ${s.body}`);
        }
        if (s.status !== 'DISCONTINUED') throw new Error(`status chip rounds up: ${s.status}`);
        if (!s.cards.some((c) => c.startsWith('fail:211'))) {
          throw new Error(`acknowledged is not marked as a shortfall: ${s.cards}`);
        }
        if (!s.badge.includes('discontinued here')) {
          throw new Error(`the row badge does not carry the failure: ${s.badge}`);
        }
      }
    }


    // Live speed test against a receiver started by the harness caller.
    if (process.env.DCM_SMOKE_PEER_PORT && fixtures) {
      const port = process.env.DCM_SMOKE_PEER_PORT;
      await win.webContents.executeJavaScript(`
        showView('speed');
        document.querySelector('#speed-folder').value = ${JSON.stringify(fixtures)};
        state.conn = { host: '127.0.0.1', port: '${port}', calledAe: 'SMOKE', callingAe: '' };
        syncConnInputs();
        document.querySelectorAll('.ts-opt')[1].checked = true;
        document.querySelector('#view-speed [data-run]').click();
        true
      `);
      await wait(20000);
      await shot(win, outDir, 'speed-result');
      const rows = await win.webContents.executeJavaScript(
        `document.querySelectorAll('#view-speed [data-result] tbody tr').length`
      );
      process.stdout.write(`speed rows: ${rows}\n`);
    }

    // Live tag load + edit preview.
    if (fixtures) {
      await win.webContents.executeJavaScript(`
        showView('edit');
        document.querySelector('#edit-target').value = ${JSON.stringify(fixtures)};
        document.querySelector('#edit-load').click();
        true
      `);
      // Loading the tags is a child process too; wait for the grid, not a guess.
      await waitFor(
        win,
        "document.querySelectorAll('#edit-grid .tag-row[data-kw]').length > 0",
        25000,
        'the tag editor to load'
      );
      const tagCount = await win.webContents.executeJavaScript(
        `document.querySelectorAll('#edit-grid .tag-row[data-kw]').length`
      );
      process.stdout.write(`editor tags: ${tagCount}\n`);
      await win.webContents.executeJavaScript(`
        const row = document.querySelector('.tag-row[data-kw="PatientID"] .tag-val');
        row.value = 'TEST-999';
        row.dispatchEvent(new Event('input', {bubbles:true}));
        true
      `);
      await wait(400);
      await shot(win, outDir, 'edit-loaded');
      const cmd = await win.webContents.executeJavaScript(
        `document.querySelector('#view-edit [data-cmd]').textContent`
      );
      process.stdout.write(`edit cmd: ${cmd}\n`);
    }

    fs.writeFileSync(path.join(outDir, 'measurements.txt'), measured.join('\n') + '\n');
    process.stdout.write('smoke: OK\n');
    app.exit(0);
  } catch (err) {
    process.stderr.write(`smoke: FAILED ${err && err.stack ? err.stack : err}\n`);
    app.exit(1);
  }
}

module.exports = { runSmoke };
