# Asteris DICOM App

A windowed front end for the `dcm` engine. Same DIMSE code as the CLI, no second
implementation: every screen builds the exact `dcm` command a person would type,
shows it, and runs it. Echo, Send (with a live transfer report), a Receiver you
can start and stop, Query, Inventory, Speed test, Tag inspector, Tag editor and De-identify —
plus a DICOMweb group: test a server URL, send over STOW-RS, query over QIDO-RS,
and run a local DICOMweb hub for testing.

**Worklist & perform** is one screen because it is one job: query the worklist,
click a scheduled step, point at the folder of images, perform it. The step's
attributes, the peers and the ten rarely-touched flags are a disclosure away
rather than on screen, and the longer explanations sit behind small ⓘ marks —
visible when you want them, silent when you don't. What must never be quiet
still isn't: a study-UID mismatch, a shortfall, or a step that could not be
closed appears inline the moment it applies. DICOMweb credentials come from the
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

## Speed, on the Send and Speed test screens

**Send a study** asks for a speed, not for two numbers. Normal, Fast, Very fast
and Insane sit in a chip row, in place of the Chunk size and Parallel
associations boxes, because those two were never independent: the concurrency a
run reaches is `min(parallel, chunk count)`, so typing a parallel count without
sizing the chunks to match set up a run that quietly went narrower than it said.
The preset sets both, and the engine derives the chunk size per study.

The raw inputs are still there under **Advanced**, and which one you type
matters, so the screen says which:

- a **Chunk size** replaces only that half. The command keeps `--speed` and adds
  `--chunk`, and the engine names the half that was displaced;
- a **Parallel associations** count replaces the preset outright. The command
  drops `--speed` entirely rather than carrying both — a preset that has lost
  its association count would still be sizing chunks off your number, for a
  width you did not ask it for. The chip row goes inert and says so, since a
  highlighted chip beside a command with no `--speed` in it would be the screen
  describing a run that isn't the run. Clear the field to go back to the preset.

**Insane is marked amber**, and selecting it opens a block explaining why. It is
a benchmark setting for a receiver you own. Sixteen associations is not a number
this end gets to choose — the receiver decides how many it accepts and rejects
the rest — and the cost of the ones it does accept lands on it and on the link,
not here.

**Speed test** sweeps the four presets instead of asking the operator to type a
list of association counts. That list was the same trap in a different screen:
the widths went out as `--parallel`, which overrides the preset's sizing, so the
sweep could compare four runs that had all clamped to the same real width. Typed
counts are still available as an optional extra field, with what they override
written next to them.

Two things the results table is not allowed to do, because they are the whole
point of the feature:

- **Width is measured, not requested.** The column reads the engine's
  `parallelAchieved` — associations the receiver actually accepted — and shows
  `N of M` in amber when the run fell short of what it asked for. It is a floor:
  it can read one low on a run whose tail drains early, and never reads high.
  The engine's per-study shortfall warnings arrive on stderr even under `--json`,
  and now reach the console under the table instead of being dropped whenever
  the JSON parsed.
- **FASTEST goes to a transfer, not to a row.** At 100 instances, Fast,
  Very fast and Insane all clamp to the same chunk size and run the same width:
  three identical transfers. Badging whichever of them drew the best sample
  would claim 16 wide beat 8 on run-to-run noise. Rows that resolved to the same
  effective transfer — same negotiated syntax, same measured width, same
  division of instances into associations — are all badged TIED FASTEST.

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
