'use strict';

/**
 * electron-builder `afterPack` hook: flip the Electron fuses, then (on macOS)
 * ad-hoc sign.
 *
 * Fuses are bits baked into the Electron binary that switch off features an
 * attacker can use to run their own code as this app, with its identity and,
 * on macOS, its privacy grants:
 *
 *   RunAsNode                         ELECTRON_RUN_AS_NODE=1 turns the app into
 *                                     a plain Node that runs any script. The
 *                                     engine runs as a utilityProcess instead
 *                                     (see launchEngine in main.js), so the
 *                                     app does not need it.
 *   EnableNodeOptionsEnvironmentVariable  NODE_OPTIONS=--require evil.js.
 *   EnableNodeCliInspectArguments     --inspect: attach a debugger, run anything.
 *   EnableEmbeddedAsarIntegrityValidation  refuse an app.asar that does not
 *                                     match the hash electron-builder embedded.
 *   OnlyLoadAppFromAsar               never load app code from a loose folder
 *                                     placed beside the asar.
 *
 * ORDER MATTERS. Flipping a fuse rewrites the binary, which breaks any code
 * signature on it. So fuses go first, then the ad-hoc signer below, and
 * electron-builder's own signing (Windows, or a real macOS identity) runs
 * after afterPack anyway. The CI step "The macOS app must be signed"
 * verifies the finished .app, so a wrong order fails the build rather than
 * shipping an app that will not launch.
 *
 * Unpackaged runs (`npm start`, the smoke harness) never come through here,
 * so development keeps every fuse at its default.
 */

const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const adHocSignMac = require('./ad-hoc-sign-mac').default;

/** The packaged Electron binary for the platform being built. */
function electronBinary(context) {
  const name = context.packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case 'darwin':
    case 'mas':
      return path.join(context.appOutDir, `${name}.app`);
    case 'win32':
      return path.join(context.appOutDir, `${name}.exe`);
    default:
      return path.join(context.appOutDir, context.packager.executableName);
  }
}

exports.default = async function afterPack(context) {
  const binary = electronBinary(context);
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // The ad-hoc signer re-signs everything right after, so the arm64 binary
    // is never left unsigned on disk for long. With a real identity
    // configured, electron-builder signs it after this hook.
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  process.stdout.write(`  • fuses: flipped on ${path.basename(binary)}\n`);

  await adHocSignMac(context);
};
