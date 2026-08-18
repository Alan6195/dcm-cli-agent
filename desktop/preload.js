'use strict';

/**
 * Preload bridge.
 *
 * The renderer runs with no Node access at all. Everything it can do is
 * enumerated here and goes through IPC to the main process. Output from a run
 * arrives as 'dcm:chunk' events which are dispatched to the callbacks the
 * caller registered for that run's id.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** runId -> { onChunk(stream, text), onExit(code, signal) } */
const runHandlers = new Map();

ipcRenderer.on('dcm:chunk', (_event, { runId, stream, text }) => {
  const h = runHandlers.get(runId);
  if (h && typeof h.onChunk === 'function') h.onChunk(stream, text);
});

ipcRenderer.on('dcm:exit', (_event, { runId, code, signal }) => {
  const h = runHandlers.get(runId);
  if (h && typeof h.onExit === 'function') h.onExit(code, signal);
  runHandlers.delete(runId);
});

contextBridge.exposeInMainWorld('dcm', {
  /** Engine version, entry path, platform and home dir. */
  info: () => ipcRenderer.invoke('dcm:info'),

  /** Native path picker. mode: 'folder' | 'file' | 'create'. */
  pick: (opts) => ipcRenderer.invoke('dcm:pick', opts),

  /** Reveal a file or folder in the OS file manager. */
  reveal: (target) => ipcRenderer.invoke('dcm:reveal', target),

  profiles: {
    get: () => ipcRenderer.invoke('dcm:profiles:get'),
    set: (data) => ipcRenderer.invoke('dcm:profiles:set', data),
  },

  /**
   * Start a `dcm` run.
   *
   * @param {string[]} argv     Full argument vector, e.g. ['echo','--host',...]
   * @param {string|null} cwd   Working directory for the child, or null.
   * @param {{onChunk?:Function, onExit?:Function}} handlers
   * @returns {Promise<number>} the runId
   */
  start: async (argv, cwd, handlers) => {
    const { runId } = await ipcRenderer.invoke('dcm:start', { argv, cwd });
    runHandlers.set(runId, handlers || {});
    return runId;
  },

  /** Stop a running child by its runId. */
  cancel: (runId) => ipcRenderer.invoke('dcm:cancel', runId),
});
