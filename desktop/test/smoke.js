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

const VIEWS = ['echo', 'send', 'receive', 'query', 'worklist', 'speed', 'inventory', 'tags', 'edit', 'anon', 'mcp'];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      // Wait for the child engine process to run and the table to render.
      await wait(3000);
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
      await wait(3000);
      await shot(win, outDir, 'send-dryrun-result');
      const consoleText = await win.webContents.executeJavaScript(
        `document.querySelector('#view-send [data-console]').textContent`
      );
      fs.writeFileSync(path.join(outDir, 'send-console.txt'), consoleText || '');
      process.stdout.write(`send console bytes: ${(consoleText || '').length}\n`);
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
      await wait(4000);
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
