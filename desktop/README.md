# Asteris DICOM App

A windowed front end for the `dcm` engine. Same DIMSE code as the CLI, no second
implementation: every screen builds the exact `dcm` command a person would type,
shows it, and runs it. Echo, Send (with a live transfer report), a Receiver you
can start and stop, Query, Inventory, Tag inspector, Tag editor and De-identify —
plus a DICOMweb group: test a server URL, send over STOW-RS, query over QIDO-RS,
and run a local DICOMweb hub for testing. DICOMweb credentials come from the
environment the app was launched from (`DCM_WEB_TOKEN`, or
`DCM_WEB_USER`/`DCM_WEB_PASS`) — there is deliberately no token field.

The product name is deliberately "Asteris DICOM App" — typing "asteris" into
the Windows Start menu finds it, and the trailing "App" separates it from the
`dcm` CLI when both are installed.

Launch behavior worth knowing, all deliberate:

- a splash appears immediately on launch, so a slow first start never looks
  like a failed one; the main window takes over as soon as it has painted;
- only one instance runs — launching it again fronts the existing window
  instead of racing the first instance for profiles and receiver ports;
- window size, position and maximized state are remembered across launches
  (and reset if the monitor they were on is gone);
- saved connection profiles survive updates and the v0.5 → v0.6 rename.

## Why it's built this way

The engine (`../src`) is reused verbatim. Electron ships its own Node, so with
`ELECTRON_RUN_AS_NODE=1` the app spawns the engine's own entry script
(`bin/dcm.js`) as a child process and streams its stdout/stderr into the UI.
That means:

- one DIMSE implementation, shared with the CLI — nothing to drift out of sync;
- the transfer report you see in the app is byte-for-byte what the terminal shows;
- the receiver is a real, cancellable child process;
- no Node install is required on the target machine — Electron provides it.

Read-only screens (Inventory, Query, Tags) ask the engine for `--json` and render
it as tables. The transfer screens stream the engine's own text report.

Connection profiles you save live in the app's own user-data folder. The engine
still never reads a config file — that property is unchanged.

## Run it in development

From this folder:

```bash
npm install      # installs Electron and links the engine from ..
npm start        # launches the app
```

`npm install` pulls the engine in as a local dependency (`file:..`), so its
DIMSE code and the one WebAssembly codec module come along automatically.

## Build installers

```bash
npm run dist         # build for the current OS
npm run dist:win     # Windows: NSIS installer + portable .exe (x64)
npm run dist:mac     # macOS: .dmg (arm64 + x64)
```

Output lands in `release/`. Builds are per-OS: Windows installers must be built
on Windows, macOS on macOS. The included GitHub Actions workflow
(`.github/workflows/desktop.yml`) builds both on a tag and attaches them to
the release. The tag itself is cut by CI: when a version bump lands on master,
`.github/workflows/autotag.yml` tags it and starts the release builds, so a
release is just "bump versions, update CHANGELOG, push".

Like the CLI binaries, the installers are **not code-signed**. Windows
SmartScreen will warn on first run (*More info → Run anyway*); macOS will need
`xattr -d com.apple.quarantine` on the .app or a right-click → Open. Signing is a
later step if this goes past the support team.

## Updates

The installed Windows app keeps itself current.
On launch (and every few hours after) the app checks the GitHub release feed,
downloads a newer version in the background, and shows **Restart & update** in
the sidebar. Clicking it installs silently and relaunches. If you never click
it, the downloaded update is applied on the next normal quit instead — either
way you don't visit the releases page again.

There's a **Check for updates** link under the engine version for when you
don't want to wait out the timer, and after any update the next launch shows a
one-time "Updated to vX.Y.Z" notice with a link to that release's notes — so a
silent on-quit update never leaves you wondering which version you're on.

The check and download happen through `electron-updater` against the
`latest*.yml` metadata that the release workflow attaches next to the
installers, and the download is verified against the SHA-512 recorded there
before it is applied. That is the integrity check a code signature would
otherwise provide.

Two builds can't replace themselves, so they notify instead of updating:

- the **portable exe** — there is no install to swap, so it shows the new
  version with a button that opens the releases page;
- **macOS** — Squirrel.Mac refuses to swap an unsigned app, so same behavior.
  If the app is ever signed, flipping macOS to full self-update is only a
  matter of removing the platform guard in `main.js`.

Installing a newer setup exe by hand always works too: the NSIS installer
uninstalls the previous version and installs over it. Connection profiles
survive — they live in the per-user app-data folder, not the install folder.

Dev runs (`npm start`) never check for updates; the updater only arms in a
packaged app.

## Layout

```
main.js            Electron main process: window, IPC, engine spawning, profiles, updates
preload.js         The only bridge the renderer gets (contextIsolation on)
renderer/          The UI — index.html, styles.css, app.js (no framework, no build)
renderer/splash.html  The launch splash (static HTML/CSS, no scripts)
build/icon.png     App icon; electron-builder derives the .ico and .icns from it
test/smoke.js      Headless screenshot/verification driver (env-guarded)
```
