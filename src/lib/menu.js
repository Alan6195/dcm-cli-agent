'use strict';

const readline = require('node:readline/promises');

const log = require('./log');
const brand = require('./brand');
const { tokenize, UsageError } = require('./args');

/**
 * Interactive menu.
 *
 * This exists for the person who was handed a .exe and told "use this to check
 * whether the images went across". They are perfectly capable, but they have
 * not read the flag reference and should not have to before finding out whether
 * a connection works.
 *
 * It only ever runs on an interactive terminal. Everything it does is expressed
 * as an ordinary command line, which it prints before running, so the menu
 * doubles as a way to learn the commands rather than a parallel interface that
 * hides them. Anything scripted or piped never reaches this code.
 */

/** Answers are remembered for the session so repeat actions do not re-ask. */
const remembered = new Map();

/**
 * Asks a question, offering a remembered or environment default.
 *
 * @param {readline.Interface} rl
 * @param {string} key    Where to remember the answer.
 * @param {string} prompt
 * @param {{fallback?: string, env?: string, required?: boolean}} opts
 * @returns {Promise<string|undefined>}
 */
async function ask(rl, key, prompt, opts = {}) {
  const previous = remembered.get(key);
  const envValue = opts.env ? process.env[opts.env] : undefined;
  const suggested = previous ?? envValue ?? opts.fallback;

  for (;;) {
    const shown = suggested ? ` ${log.color.dim(`[${suggested}]`)}` : '';
    const answer = (await rl.question(`  ${prompt}${shown}: `)).trim();
    const value = answer === '' ? suggested : answer;

    if (value === undefined || value === '') {
      if (!opts.required) return undefined;
      log.out(log.color.yellow('    that one is required'));
      continue;
    }

    remembered.set(key, value);
    return value;
  }
}

/** Asks a yes/no question. */
async function confirm(rl, prompt, defaultYes = false) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await rl.question(`  ${prompt} ${log.color.dim(hint)}: `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Collects the connection details every SCU action needs. */
async function askConnection(rl) {
  const host = await ask(rl, 'host', 'Peer hostname', {
    env: 'DCM_HOST', fallback: 'localhost', required: true,
  });
  const port = await ask(rl, 'port', 'Port', {
    env: 'DCM_PORT', fallback: '11112', required: true,
  });
  const calledAe = await ask(rl, 'calledAe', "The peer's AE Title", {
    env: 'DCM_CALLED_AE', required: true,
  });
  const callingAe = await ask(rl, 'callingAe', 'Our AE Title', {
    env: 'DCM_CALLING_AE', fallback: 'DCM-CLI', required: true,
  });

  return ['--host', host, '--port', port, '--called-ae', calledAe, '--calling-ae', callingAe];
}

/** Renders an argv array the way a person would type it. */
function asCommandLine(command, argv) {
  const quoted = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return `dcm ${command} ${quoted.join(' ')}`.trim();
}

/**
 * Runs a command module with the given argv, printing the equivalent command
 * line first so the menu teaches rather than conceals.
 *
 * @returns {Promise<number>}
 */
async function runAction(command, argv) {
  log.out('');
  log.out(brand.rule());
  log.out(`${log.color.dim('running:')}  ${brand.accent(asCommandLine(command, argv))}`);
  log.out(brand.rule());
  log.out('');

  const mod = require(`../commands/${command}`);
  try {
    return await mod.run(tokenize(argv));
  } catch (err) {
    if (err instanceof UsageError || err?.name === 'UsageError') {
      log.error(err.message);
      return 2;
    }
    log.error(err?.stack ?? String(err));
    return 1;
  }
}

const ACTIONS = [
  {
    key: '1',
    label: 'Test a connection',
    detail: 'C-ECHO — is the peer there, and does it accept our AE Title?',
    async build(rl) {
      return { command: 'echo', argv: await askConnection(rl) };
    },
  },
  {
    key: '2',
    label: 'Inventory a folder',
    detail: 'What is in it: studies, series, modalities, sizes. Sends nothing.',
    async build(rl) {
      const folder = await ask(rl, 'folder', 'Folder to inspect', { required: true });
      const perSeries = await confirm(rl, 'Break it down per series?', false);
      return { command: 'info', argv: perSeries ? [folder, '--series'] : [folder] };
    },
  },
  {
    key: '3',
    label: 'Send a study',
    detail: 'C-STORE a folder to a peer, reporting exactly what was acknowledged.',
    async build(rl) {
      const folder = await ask(rl, 'folder', 'Folder to send', { required: true });
      const connection = await askConnection(rl);
      const dryRun = await confirm(rl, 'Dry run first (recommended)?', true);
      const argv = [folder, ...connection];
      if (dryRun) return { command: 'send', argv: [folder, '--dry-run'] };
      return { command: 'send', argv };
    },
  },
  {
    key: '4',
    label: 'Receive images',
    detail: 'Run a receiver that accepts everything and logs what arrives.',
    async build(rl) {
      const port = await ask(rl, 'scpPort', 'Port to listen on', { fallback: '11112', required: true });
      const ae = await ask(rl, 'scpAe', 'Our AE Title', { fallback: 'DCM-CLI', required: true });
      const save = await confirm(rl, 'Save what arrives to disk?', true);
      const argv = ['--port', port, '--ae', ae];
      if (save) {
        const dir = await ask(rl, 'scpDir', 'Save to folder', { fallback: './received', required: true });
        argv.push('--persist', dir);
      }
      log.out('');
      log.out(log.color.dim('  This runs until you stop it with Ctrl+C.'));
      return { command: 'scp', argv };
    },
  },
  {
    key: '5',
    label: 'Query a peer',
    detail: 'C-FIND — search for studies. Note: a peer can accept images and still not answer queries.',
    async build(rl) {
      const connection = await askConnection(rl);
      const key = await ask(rl, 'findKey', 'Match on (e.g. PatientID=12345)', { required: true });
      return { command: 'find', argv: [...connection, key] };
    },
  },
  {
    key: '6',
    label: 'Inspect DICOM tags',
    detail: 'Dump the tags in a file or folder. Never prints pixel data.',
    async build(rl) {
      const target = await ask(rl, 'folder', 'File or folder', { required: true });
      const filter = await ask(rl, 'tagFilter', 'Filter by keyword or value (blank for everything)', {});
      const argv = [target];
      if (filter) argv.push('--filter', filter);
      return { command: 'tags', argv };
    },
  },
  {
    key: '7',
    label: 'Change or remove tags',
    detail: 'Edit tag values and write the result. Writes a copy; never edits in place from here.',
    async build(rl) {
      const target = await ask(rl, 'folder', 'File or folder', { required: true });
      const out = await ask(rl, 'editOut', 'Write the edited copy to', { required: true });
      const set = await ask(rl, 'editSet', 'Set a tag (Keyword=Value, blank to skip)', {});
      const remove = await ask(rl, 'editRemove', 'Remove a tag (Keyword, blank to skip)', {});

      if (!set && !remove) {
        throw new Error('Nothing to do — give at least one tag to set or remove.');
      }

      const argv = [target, '--out', out];
      if (set) argv.push('--set', set);
      if (remove) argv.push('--remove', remove);

      // The menu deliberately never offers --in-place. Overwriting a study is
      // something to do on purpose from a command line, not by picking a
      // number off a list.
      const dry = await confirm(rl, 'Show what would change first, without writing?', true);
      if (dry) argv.push('--dry-run');
      return { command: 'edit', argv };
    },
  },
  {
    key: '8',
    label: 'De-identify a folder',
    detail: 'Copy a folder with identifiers removed, for sharing or testing.',
    async build(rl) {
      const folder = await ask(rl, 'folder', 'Folder to de-identify', { required: true });
      const out = await ask(rl, 'anonOut', 'Write the copy to', { required: true });
      return { command: 'anon', argv: [folder, '--out', out] };
    },
  },
  {
    key: '9',
    label: 'Install as a `dcm` command',
    detail: 'Put this on your PATH so you can type `dcm` in any terminal.',
    async build(rl) {
      const dry = await confirm(rl, 'Show what it would do first, without changing anything?', true);
      return { command: 'install', argv: dry ? ['--dry-run'] : [] };
    },
  },
  {
    key: '10',
    label: 'DICOMweb (HTTP): ping, send, query, retrieve, or serve',
    detail: 'STOW/QIDO/WADO against a DICOMweb URL. Credentials come from DCM_WEB_TOKEN or DCM_WEB_USER/DCM_WEB_PASS in the environment, never from a prompt.',
    async build(rl) {
      const verb = (await ask(rl, 'webVerb', 'Which operation? (ping / send / query / retrieve / serve)', { fallback: 'ping' })).toLowerCase();
      // Falling through to ping on a typo would run a different operation than
      // the one that was asked for, silently. The CLI rejects unknown verbs;
      // so does this.
      if (!['ping', 'send', 'query', 'retrieve', 'serve'].includes(verb)) {
        throw new Error(`"${verb}" is not one of: ping, send, query, retrieve, serve`);
      }
      if (verb === 'serve') {
        const port = await ask(rl, 'webServePort', 'Port to listen on', { env: 'DCM_WEB_SERVE_PORT', required: true });
        const persist = await ask(rl, 'webServePersist', 'Folder to store received instances (empty = discard)', {});
        const argv = ['serve', '--port', port];
        if (persist) argv.push('--persist', persist);
        return { command: 'web', argv };
      }
      const url = await ask(rl, 'webUrl', 'Base URL (include any /dicom-web prefix)', { env: 'DCM_WEB_URL', required: true });
      if (verb === 'send') {
        const folder = await ask(rl, 'webSendFolder', 'Folder to send', { required: true });
        return { command: 'web', argv: ['send', folder, '--url', url] };
      }
      if (verb === 'query') {
        const patientId = await ask(rl, 'webQueryPatient', 'PatientID to match (empty = all studies)', {});
        const argv = ['query', '--url', url];
        if (patientId) argv.push(`PatientID=${patientId}`);
        return { command: 'web', argv };
      }
      if (verb === 'retrieve') {
        const study = await ask(rl, 'webRetrieveStudy', 'StudyInstanceUID to retrieve', { required: true });
        const out = await ask(rl, 'webRetrieveOut', 'Folder to write into', { required: true });
        return { command: 'web', argv: ['retrieve', '--url', url, '--study', study, '--out', out] };
      }
      return { command: 'web', argv: ['ping', '--url', url] };
    },
  },
];

/**
 * Runs the menu until the operator quits.
 *
 * @param {string} version
 * @returns {Promise<number>}
 */
async function run(version) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let lastCode = 0;

  // Ctrl+C should leave cleanly rather than dumping a stack trace.
  rl.on('SIGINT', () => {
    log.out('');
    rl.close();
    process.exit(lastCode);
  });

  try {
    for (;;) {
      log.out('');
      log.out(brand.banner(version));
      log.out('');
      log.out(`  ${brand.heading('What would you like to do?')}`);
      log.out('');

      for (const action of ACTIONS) {
        log.out(`   ${brand.accent(action.key)}  ${action.label}`);
        log.out(`      ${log.color.dim(action.detail)}`);
      }
      log.out('');
      log.out(`   ${brand.accent('h')}  Show the full command reference`);
      log.out(`   ${brand.accent('q')}  Quit`);
      log.out('');

      const choice = (await rl.question(`  ${brand.accent('>')} `)).trim().toLowerCase();

      if (choice === 'q' || choice === 'quit' || choice === 'exit') {
        log.out('');
        return lastCode;
      }

      if (choice === 'h' || choice === 'help' || choice === '?') {
        const { USAGE } = require('../cli');
        log.out('');
        log.out(USAGE);
        await rl.question(log.color.dim('  Press Enter to go back... '));
        continue;
      }

      const action = ACTIONS.find((a) => a.key === choice);
      if (!action) {
        log.out(log.color.yellow(`  "${choice}" is not one of the options.`));
        continue;
      }

      log.out('');
      log.out(`  ${brand.heading(action.label)}`);
      log.out(`  ${log.color.dim(action.detail)}`);
      log.out('');

      let built;
      try {
        built = await action.build(rl);
      } catch (err) {
        log.error(err?.message ?? String(err));
        continue;
      }

      lastCode = await runAction(built.command, built.argv);

      log.out('');
      log.out(
        lastCode === 0
          ? log.color.green('  Finished successfully.')
          : log.color.red(`  Finished with exit code ${lastCode}.`)
      );
      await rl.question(log.color.dim('\n  Press Enter to return to the menu... '));
    }
  } finally {
    rl.close();
  }
}

module.exports = { run, ACTIONS, asCommandLine };
