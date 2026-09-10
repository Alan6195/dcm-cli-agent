'use strict';

/**
 * electron-builder `afterPack` hook: ad-hoc code-sign the macOS .app.
 *
 * WHY THIS EXISTS
 *
 * macOS on Apple Silicon will not execute an arm64 Mach-O that carries no code
 * signature at all. The loader rejects it outright, and the Finder reports that
 * as "AscendI DICOM is damaged and can't be opened" — wording that sounds
 * like a corrupt download and is nothing of the sort. Intel builds have no such
 * requirement, which is why the x64 .dmg ran while the arm64 one never did.
 *
 * The prebuilt Electron binaries ship ad-hoc signed, but electron-builder then
 * renames the main executable, rewrites Info.plist and drops app.asar into
 * Resources. Every one of those edits breaks the seal, so the .app that comes
 * out of packing is effectively unsigned no matter what Electron shipped. It has
 * to be re-signed, and that has to happen before the .dmg is built around it.
 *
 * This is the same fix the CLI binaries already carry — see the `codesign
 * --sign -` call in tools/build.js, added because Node SEA injection invalidates
 * the signature in exactly the same way. The desktop build never got it.
 *
 * WHAT THIS DOES NOT DO
 *
 * An ad-hoc signature is not a real one. It has no Developer ID, no team, and
 * no notarization ticket. It stops the "damaged" error and nothing else:
 * Gatekeeper still shows "unidentified developer" on first launch, and the user
 * still has to right-click -> Open once (or strip the quarantine attribute).
 * Removing that warning needs a paid Apple Developer ID plus notarization.
 * See desktop/README.md, "Installing on macOS".
 *
 * WHY INNER-OUT AND NOT `--deep`
 *
 * `codesign --deep` is deprecated by Apple for signing (it remains correct for
 * *verifying*, and is used that way at the bottom of this file). Its problem is
 * that it applies one set of options to every nested binary it finds, which is
 * wrong for a bundle whose helpers need distinct entitlements. That specific
 * hazard does not apply here — ad-hoc signing passes no entitlements at all —
 * so `--deep` would very likely work today. It is still the wrong thing to
 * depend on: it is a deprecated flag doing a load-bearing job, it is documented
 * as able to produce a bundle that looks signed and is not, and this whole bug
 * exists because something looked complete and shipped broken. So the bundle is
 * signed inner-out, the way Apple documents: every nested Mach-O first, then
 * framework versions, then helper .apps, then the outer .app, deepest path
 * first at each stage. The final `--verify --deep --strict` then has to agree.
 *
 * FAILURE POLICY
 *
 * Any failure throws. electron-builder propagates a rejected afterPack hook and
 * the build fails. The alternative — warn and continue — is what would let a
 * broken arm64 .dmg reach a release page again, and the CLI's equivalent code
 * only warns because a CLI binary that fails to sign still runs on Intel.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Mach-O and universal-binary magic numbers, read as a big-endian uint32. */
const MACH_O_MAGIC = new Set([
  0xfeedface, // MH_MAGIC     32-bit
  0xfeedfacf, // MH_MAGIC_64  64-bit
  0xcefaedfe, // MH_CIGAM     32-bit, byte-swapped
  0xcffaedfe, // MH_CIGAM_64  64-bit, byte-swapped
  0xcafebabe, // FAT_MAGIC    universal
  0xbebafeca, // FAT_CIGAM    universal, byte-swapped
]);

function log(message) {
  process.stdout.write(`  • ad-hoc-sign: ${message}\n`);
}

/** True if `file` starts with a Mach-O / universal-binary magic number. */
function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACH_O_MAGIC.has(head.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Walks the .app and buckets everything that needs its own signature.
 *
 * Symlinks are skipped deliberately: a framework's `Versions/Current` and its
 * top-level shortcuts all point at `Versions/A`, and signing through them would
 * sign the same code repeatedly under a path codesign does not consider canonical.
 */
function collectTargets(appPath) {
  const machO = [];      // loose executables, dylibs, framework binaries
  const frameworks = []; // concrete framework version directories
  const nestedApps = []; // Helper .apps

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        walk(full);
        if (entry.name.endsWith('.app')) {
          nestedApps.push(full);
        } else if (entry.name.endsWith('.framework')) {
          const versionsDir = path.join(full, 'Versions');
          let versions = [];
          try {
            versions = fs
              .readdirSync(versionsDir, { withFileTypes: true })
              .filter((v) => v.isDirectory() && !v.isSymbolicLink())
              .map((v) => path.join(versionsDir, v.name));
          } catch {
            // Not a versioned framework; sign the bundle directory itself.
          }
          if (versions.length > 0) frameworks.push(...versions);
          else frameworks.push(full);
        }
      } else if (entry.isFile() && isMachO(full)) {
        machO.push(full);
      }
    }
  };

  walk(appPath);
  return { machO, frameworks, nestedApps };
}

/** Deepest path first, so nested code is always signed before its container. */
function deepestFirst(paths) {
  return [...paths].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

function codesign(args) {
  execFileSync('codesign', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

/**
 * `--force` because Electron's prebuilt code already carries signatures that
 * packing invalidated; without it codesign refuses to replace them.
 * `--timestamp=none` because an ad-hoc signature has no timestamp to fetch —
 * this only guarantees no build ever blocks on Apple's timestamp server.
 */
function signOne(target) {
  codesign(['--force', '--timestamp=none', '--sign', '-', target]);
}

/**
 * Whether a real signing identity is configured, in which case this hook stands
 * down entirely and leaves the bundle to electron-builder.
 *
 * electron-builder runs its own signing pass immediately *after* this hook
 * (macPackager.js: `afterPack` then `doSignAfterPack`), so a real Developer ID
 * signature would overwrite an ad-hoc one anyway and skipping is belt-and-braces.
 * The check mirrors electron-builder 25's own resolution order: an explicit
 * `mac.identity` or `CSC_NAME`, or a certificate supplied via `CSC_LINK`.
 *
 * Note `CSC_IDENTITY_AUTO_DISCOVERY=false` is NOT treated as "a real identity
 * exists" — it means the opposite, that electron-builder must not go hunting
 * the keychain for one. It also does not disable signing outright: with
 * `CSC_NAME` or `mac.identity` set, electron-builder 25 still signs for real.
 */
function realIdentityConfigured(context) {
  const identity = context.packager.platformSpecificBuildOptions?.identity;
  if (typeof identity === 'string' && identity.trim() !== '') return `mac.identity=${identity}`;

  const cscName = process.env.CSC_NAME;
  if (cscName && cscName.trim() !== '') return `CSC_NAME=${cscName}`;

  const cscLink = process.env.CSC_LINK;
  if (cscLink && cscLink.trim() !== '') return 'CSC_LINK is set';

  return null;
}

exports.default = async function adHocSignMac(context) {
  // No-op on the Windows and Linux legs of the build matrix. Both checks matter:
  // electronPlatformName covers "not building for mac", process.platform covers
  // "codesign does not exist on this runner" for any cross-build attempt.
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    log(`skipped — building for darwin on ${process.platform}, codesign is macOS-only`);
    return;
  }

  const configured = realIdentityConfigured(context);
  if (configured) {
    log(`skipped — a real signing identity is configured (${configured}); leaving it to electron-builder`);
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  let appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    // Fall back to whatever single .app is there, so a productName change
    // cannot silently turn this hook into a no-op.
    const candidates = fs
      .readdirSync(context.appOutDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.endsWith('.app'))
      .map((e) => path.join(context.appOutDir, e.name));
    if (candidates.length !== 1) {
      throw new Error(
        `ad-hoc-sign: expected ${appName} in ${context.appOutDir}, found ${candidates.length} .app bundles. ` +
          'Refusing to guess — an unsigned arm64 build will not launch.'
      );
    }
    appPath = candidates[0];
  }

  const { machO, frameworks, nestedApps } = collectTargets(appPath);
  log(
    `signing ${appName} (${context.arch === undefined ? 'unknown arch' : `arch ${context.arch}`}): ` +
      `${machO.length} Mach-O files, ${frameworks.length} framework versions, ${nestedApps.length} nested apps`
  );

  // Inner-out: nested code first, container last.
  for (const target of deepestFirst(machO)) signOne(target);
  for (const target of deepestFirst(frameworks)) signOne(target);
  for (const target of deepestFirst(nestedApps)) signOne(target);
  signOne(appPath);

  // --deep is correct here: verifying nested code is the job it was kept for.
  // --strict makes codesign apply the same checks the loader will.
  codesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  log(`verified — ${appName} is ad-hoc signed (not notarized; first launch still needs right-click -> Open)`);
};

// Exposed for tests only. Everything here runs solely on macOS, so this is the
// only way the walk order and the identity check get exercised on a Windows or
// Linux dev box. Deliberately not named `afterPack`: electron-builder's resolver
// prefers a named export matching the hook over the default one.
exports.internals = { isMachO, collectTargets, deepestFirst, realIdentityConfigured };
