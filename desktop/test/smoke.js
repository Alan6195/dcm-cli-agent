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
  'echo', 'send', 'receive', 'query', 'worklist', 'mpps', 'steps', 'speed',
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

    // Worklist row -> "Perform this step" hand-off. No MWL SCP is needed: the
    // renderer is fed one match in the shape `dcm find --mwl --json` emits, the
    // row is clicked, and the MPPS command preview is captured. That is the
    // whole contract of the screen — the selection carries the row's attributes
    // into a command, and both peers appear in it in full.
    {
      const folder = fixtures || '/tmp/study';
      await win.webContents.executeJavaScript(`
        showView('worklist');
        state.conn = { host: '127.0.0.1', port: '11112', calledAe: 'RISMPPS', callingAe: 'CT01' };
        syncConnInputs();
        renderWorklist({ matches: [{
          PatientName: 'DOE^JANE', PatientID: 'P-1001', AccessionNumber: 'ACC-77',
          StudyInstanceUID: '2.25.7409558135166679574647759021724211267', Modality: 'CT',
          ScheduledProcedureStepID: 'SPS-1', ScheduledProcedureStepStartDate: '20260820',
          ScheduledProcedureStepStartTime: '0930', ScheduledStationAETitle: 'CT01',
          RequestedProcedureDescription: 'CT Abdomen', RequestedProcedureID: 'RP-5',
        }] });
        document.querySelector('#view-worklist [data-result] tr.pick-row').click();
        true
      `);
      await wait(250);
      await shot(win, outDir, 'worklist-selected');

      // The hand-off button itself, so the path an operator takes is the path
      // that gets exercised.
      await win.webContents.executeJavaScript(`
        document.querySelector('#mwl-perform').click();
        document.querySelector('#mpps-folder').value = ${JSON.stringify(folder)};
        document.querySelector('#mpps-folder').dispatchEvent(new Event('input', {bubbles:true}));
        true
      `);
      // The folder check is a real `dcm info --json` child process.
      // The check is debounced and then spawns a child, so wait for the verdict
      // itself rather than for the absence of one — an empty box is the state
      // before the check starts as well as after it.
      await waitFor(
        win,
        "(() => { const b = document.querySelector('#mpps-folder-check');"
          + " return !b.hidden && b.textContent && !b.textContent.startsWith('Reading'); })()",
        25000,
        'the folder check to produce a verdict'
      );
      await shot(win, outDir, 'mpps-simple');

      // With Advanced closed, count what the operator actually faces.
      const visible = await win.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('#view-mpps input'))
          .filter((el) => el.offsetParent !== null && !el.closest('details:not([open])')).length
      `);
      process.stdout.write(`mpps visible inputs (advanced closed): ${visible}\n`);

      const mppsCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#view-mpps [data-cmd]').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'mpps-cmd.txt'), mppsCmd || '');
      process.stdout.write(`mpps cmd: ${mppsCmd}\n`);
      for (const needed of ['mpps perform', '--study-uid', '--mpps-uid']) {
        if (!String(mppsCmd).includes(needed)) {
          throw new Error(`mpps command preview is missing ${needed}: ${mppsCmd}`);
        }
      }
      // Nothing this app runs may write a step file. The owner ruled out local
      // records, and the engine's flags for them are gone; a command still
      // asking for one would fail at the argument parser, not here.
      for (const banned of ['--write-acknowledged', '--record-dir', '--record ']) {
        if (String(mppsCmd).includes(banned)) {
          throw new Error(`mpps command preview still writes a record (${banned}): ${mppsCmd}`);
        }
      }

      // The list of inputs an operator actually faces on the common path, so a
      // field creeping back onto the simple screen is visible in the log.
      const simpleInputs = await win.webContents.executeJavaScript(`
        JSON.stringify(Array.from(document.querySelectorAll('#view-mpps input'))
          .filter((el) => el.offsetParent !== null && !el.closest('details:not([open])'))
          .map((el) => el.id || el.getAttribute('data-fix') || el.type))
      `);
      fs.writeFileSync(path.join(outDir, 'mpps-simple-inputs.txt'), simpleInputs || '');
      process.stdout.write(`mpps simple inputs: ${simpleInputs}\n`);

      // The folder verdict, in the app's own words.
      const verdict = await win.webContents.executeJavaScript(`
        (document.querySelector('#mpps-folder-check').hidden ? '(hidden)'
          : document.querySelector('#mpps-folder-check').textContent)
      `);
      process.stdout.write(`mpps folder check: ${verdict}\n`);

      // --- the Advanced disclosure -----------------------------------------
      const closedSummary = await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-adv-sum').textContent`
      );
      process.stdout.write(`advanced summary (defaults): ${closedSummary}\n`);

      await win.webContents.executeJavaScript(`
(() => {
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
        // The disclosure sits below the fold on this window size, and a
        // screenshot of the top of the page proves nothing about it.
        document.querySelector('#mpps-adv').scrollIntoView({ block: 'start' });
        return true;
      })()`);
      await wait(250);
      await shot(win, outDir, 'mpps-advanced');

      // Fold it away again: the values must still be legible on the summary.
      await win.webContents.executeJavaScript(
        `document.querySelector('#mpps-adv').open = false;
         document.querySelector('#mpps-adv').scrollIntoView({ block: 'center' });
         true`
      );
      await wait(200);
      await shot(win, outDir, 'mpps-advanced-closed');
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
        `document.querySelector('#view-mpps [data-cmd]').textContent`
      );
      for (const needed of ['--store-host', '--store-port', '--store-called-ae']) {
        if (!String(bothPeers).includes(needed)) {
          throw new Error(`mpps command preview is missing ${needed}: ${bothPeers}`);
        }
      }

      // --- the stock-image case --------------------------------------------
      // Against real fixtures the scan above has already found the mismatch,
      // because the worklist UID fed in is the one from the owner's report and
      // no stock study carries it. Without fixtures there is nothing to scan,
      // so the same finding is put in by hand to capture the screen.
      const found = await win.webContents.executeJavaScript(
        `state.mpps.mismatch ? state.mpps.mismatch.kind : null`
      );
      process.stdout.write(`mismatch detected from the real folder scan: ${found}\n`);
      if (found !== 'one-study') {
        await win.webContents.executeJavaScript(`
          state.mpps.mismatch = {
            kind: 'one-study',
            declared: '2.25.7409558135166679574647759021724211267',
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
      await shot(win, outDir, 'mpps-mismatch');

      const adoptCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#view-mpps [data-cmd]').textContent`
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
      await shot(win, outDir, 'mpps-mismatch-as-is');
      const asIsCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#view-mpps [data-cmd]').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'mpps-mismatch-asis-cmd.txt'), asIsCmd || '');
      process.stdout.write(`mismatch, send as-is: ${asIsCmd}\n`);
      if (!String(asIsCmd).includes('--allow-study-mismatch')
        || String(asIsCmd).includes('--adopt-worklist-identity')) {
        throw new Error(`the two ways past a mismatch are not exclusive: ${asIsCmd}`);
      }
    }

    // Steps this session. There is no record directory any more and no file to
    // seed, so the list is driven the only way it can be: two runs' worth of
    // real engine report text are pushed through the renderer's own parser and
    // its own rememberStep(), exactly as a live run would. That exercises the
    // parser, the session list and the close command together, and it proves
    // the screen needs nothing on disk to work.
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
                   studyInstanceUid: '1.2.826.0.1.3680043.8.498.10101' },
          uid: 'unused-the-report-names-its-own',
          folder: '/studies/completed', peer, store,
        });
        const b = rememberStep({
          report: parseMppsReport(${JSON.stringify(openStdout)}, ${JSON.stringify(openStderr)}),
          attrs: { patientName: 'DOE^JANE', patientId: 'P-1001', modality: 'CT',
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
        showView('steps');
        return JSON.stringify({ a, b, c, entries: state.steps.entries.length });
      })()`);
      process.stdout.write(`steps remembered: ${seeded}\n`);
      if (JSON.parse(seeded).c !== false) {
        throw new Error('a run that never opened a step was remembered anyway');
      }
      await wait(300);
      await shot(win, outDir, 'steps-list');

      const rows = await win.webContents.executeJavaScript(
        `document.querySelectorAll('#view-steps [data-result] tr.pick-row').length`
      );
      process.stdout.write(`steps rows: ${rows}\n`);
      if (rows !== 2) throw new Error(`expected 2 session steps, got ${rows}`);

      // Nothing on this screen may name a file the app wrote.
      const listText = await win.webContents.executeJavaScript(
        `document.querySelector('#view-steps').textContent`
      );
      for (const banned of ['--record-dir', '--write-acknowledged', 'Record folder', 'Record file']) {
        if (String(listText).includes(banned)) {
          throw new Error(`the steps screen still mentions ${banned}`);
        }
      }

      // Pick the IN PROGRESS one and read the close command it offers.
      await win.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('#view-steps [data-result] tr.pick-row'));
        const open = rows.find((tr) => tr.textContent.includes('IN PROGRESS')) || rows[0];
        open.click();
        return true;
      })()`);
      await wait(300);
      await win.webContents.executeJavaScript(
        `document.querySelector('#steps-selected').scrollIntoView({ block: 'start' }); true`
      );
      await wait(200);
      await shot(win, outDir, 'steps-selected');

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

      // Discontinue is the same handle with a different verb, and a coded
      // reason rather than free text.
      await win.webContents.executeJavaScript(`
        document.querySelector('#steps-verb .chip[data-verb="discontinue"]').click();
        const rc = document.querySelector('#steps-reasoncode');
        rc.value = '110513^DCM^Discontinued for equipment failure';
        rc.dispatchEvent(new Event('input', {bubbles:true}));
        true
      `);
      await wait(250);
      await shot(win, outDir, 'steps-discontinue');
      const discCmd = await win.webContents.executeJavaScript(
        `document.querySelector('#steps-close-cmd').textContent`
      );
      process.stdout.write(`steps discontinue cmd: ${discCmd}\n`);
      if (!String(discCmd).includes('mpps discontinue') || !String(discCmd).includes('--reason-code')) {
        throw new Error(`discontinue command is wrong: ${discCmd}`);
      }

      // A COMPLETED entry is history: it offers nothing, and says why.
      await win.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('#view-steps [data-result] tr.pick-row'));
        const done = rows.find((tr) => tr.textContent.includes('COMPLETED'));
        if (done) done.click();
        return true;
      })()`);
      await wait(300);
      const closedState = await win.webContents.executeJavaScript(
        `JSON.stringify({
          offersNothing: document.querySelector('#steps-close').hidden,
          disabled: document.querySelector('#steps-close-run').disabled,
          title: document.querySelector('#steps-pick-title').textContent,
          note: document.querySelector('#steps-note').textContent.slice(0, 90),
        })`
      );
      process.stdout.write(`steps, already-closed step: ${closedState}\n`);
      if (!JSON.parse(closedState).offersNothing) {
        throw new Error('a COMPLETED step still offers a way to close it again');
      }
      await shot(win, outDir, 'steps-already-closed');

      // The whole point of session memory: it is gone when the window is.
      // Nothing on disk can be checked for it, so check the app holds it in
      // one place and one place only.
      const heldWhere = await win.webContents.executeJavaScript(
        `JSON.stringify({ entries: state.steps.entries.length, keys: Object.keys(state.steps) })`
      );
      process.stdout.write(`session memory: ${heldWhere}\n`);
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

    process.stdout.write('smoke: OK\n');
    app.exit(0);
  } catch (err) {
    process.stderr.write(`smoke: FAILED ${err && err.stack ? err.stack : err}\n`);
    app.exit(1);
  }
}

module.exports = { runSmoke };
