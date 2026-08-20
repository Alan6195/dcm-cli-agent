# Changelog

## v0.8.0

The MCP server grows up: everything the engine does, reachable by an assistant.

- **`dcm_worklist`** — Modality Worklist is now a tool in its own right rather
  than a level of `dcm_query`. Worklist matching uses a different vocabulary
  (`Modality`, `ScheduledStationAETitle`, scheduled dates) and an empty
  worklist is a legitimate answer, not a failure, so it needed its own shape.
  `scheduledDate` takes `today`/`tomorrow`/`week`, a date, or a range, and
  resolves the words against the local calendar — a UTC-derived "today" asks
  the wrong day either side of midnight and returns an empty worklist that
  looks like nothing is scheduled.
- **`dcm scp --worklist <file>`** — the receiver can now serve a Modality
  Worklist from a JSON file, so a worklist integration can be exercised
  locally: point a modality (or `dcm find --mwl`, or `dcm_worklist`) at
  something that actually answers, and see which query returns the item you
  expect. Matching covers Modality, ScheduledStationAETitle, the scheduled
  start date including open-ended ranges, PatientID, PatientName and
  AccessionNumber, with wildcards; a matching key it does not support is named
  in a warning and ignored rather than silently treated as a match, so results
  are never narrower than they look. This closes the last "we can query it but
  not serve it" gap — and it is a test fixture, not a scheduling system: no
  MPPS, no status transitions, nothing written back.
- **Server tools**: `dcm_receiver_start`, `dcm_web_hub_start`,
  `dcm_servers_list`, `dcm_server_status`, `dcm_server_stop`. An assistant can
  now start a receiver or a DICOMweb hub, send to it, read back what arrived
  and stop it — check its own work end to end, which nothing in the MCP
  surface could do before. They run as child processes so their logging can
  never reach the JSON-RPC channel, pick a free port when none is given, and
  are killed when the server exits.
- **Every engine option an assistant can use is now exposed.** Each tool's
  schema was diffed against its command's actual flag list: `dcm_send` gained
  `transferSyntax` (the v0.5 conversion, previously unreachable), `parallel`,
  `label` and `chunk`; the DICOMweb tools gained `insecure`, `retry`,
  `include`, `offset` and optional `url` so `DCM_WEB_URL` works; `dcm_tags`,
  `dcm_edit`, `dcm_anon` and `dcm_inventory` gained their missing switches.
  Tools that write files say so in the first words of their description.
- **Resources**: `dcm://usage/<command>` serves each command's own help text,
  read from the installed module so it cannot drift from the code, plus
  `dcm://troubleshooting` — the failure modes that actually cost time,
  compiled from this README and changelog rather than invented.
- **Prompts**: `verify-a-peer`, `diagnose-a-failed-transfer` and
  `mirror-a-study` encode orderings that work instead of leaving them to be
  rediscovered.
- **Fixed a shutdown leak.** A running child kept `dcm mcp` alive after the
  client disconnected, so the SDK's close path waited two seconds and then
  hard-killed it, orphaning the servers it had started. Disconnect now cleans
  up in about 30 ms with no survivors.
- `src/commands/mcp.js` was 444 lines and doing everything; the tools now live
  in `mcp/tools-{dimse,web,servers}.js` and `mcp/resources.js`, with capture
  and serialisation in `mcp/runtime.js` — the one place allowed to touch the
  log chokepoint.

## v0.7.0

DICOMweb: the HTTP face of DICOM, with the same accounting spine.

- **`dcm web`** — a new command family for servers that speak DICOMweb:
  `ping` (is there a service at this URL, and do my credentials open it?),
  `send` (STOW-RS), `query` (QIDO-RS), `retrieve` (WADO-RS) and `serve`
  (a loopback hub). No new dependencies — HTTP and the multipart/related
  encoding are done with Node's own modules, and STOW request bodies stream
  file by file, so memory stays flat however large the study is.
- **`web send` keeps the three-number rule.** It registers every file in the
  same ledger DIMSE send uses and settles each one from the server's own
  STOW response: `ReferencedSOPSequence` is acknowledged,
  `FailedSOPSequence` is failed with the reason code translated, and an
  instance the server didn't mention at all is *unanswered* — never silently
  dropped. Shortfall exits non-zero. STOW failure reasons reuse DICOM's
  storage codes, so the report reads the same as a DIMSE transfer.
- **Credentials are environment-only** (`DCM_WEB_TOKEN`, or
  `DCM_WEB_USER`/`DCM_WEB_PASS`), the same policy as `dcm explain`'s API
  key: no flag, no config file, nothing to leak into shell history. A 401
  names the variable to set, never a value. Cleartext `http://` to a
  non-local host warns that credentials and PHI would travel unencrypted.
- **`web serve`** is the web mirror of `dcm scp`: accepts STOW (persisting
  *before* it acknowledges — a 200 means stored), answers QIDO over what it
  holds, streams WADO back, logs every request in the receiver's style, and
  binds 127.0.0.1 unless told otherwise. `--require-token` and
  `--reject-after` reproduce auth failures and partial stores locally, which
  is how the client's shortfall accounting is end-to-end tested.
- Failures translate to plain English with the raw code kept in brackets,
  same ethos as the DIMSE rejections: 404 suggests the missing `/dicom-web`
  path prefix, connection-refused points out that DICOMweb lives on the HTTP
  port rather than 11112, TLS failures explain `--insecure` and warn against
  using it on anything real.
- **Desktop: a DICOMweb group** — test connection, send, query and a local
  hub screen, all building real `dcm web` commands like every other screen.
  DICOMweb server URLs get their own saved profiles, kept separate from the
  DIMSE ones.
- **MCP: four new tools** — `dcm_web_ping`, `dcm_web_send`, `dcm_web_query`,
  `dcm_web_retrieve` — same engine, credentials read from the server's
  environment so a token never transits the assistant conversation.
- The path-safety function that turns wire-supplied UIDs into directory names
  is now shared (`src/lib/uid.js`) instead of restated per receiver.

## v0.6.0

The desktop app updates itself, announces itself properly, and got a face.

- **Desktop: in-app updates.** The installed Windows app and the Linux
  AppImage check the GitHub release feed on launch, download a new version in
  the background, and show a "Restart & update" button in the sidebar; the
  install is silent and the app relaunches. If the button is never clicked,
  the downloaded update is applied on the next normal quit, so simply using
  the app keeps it current. The update is verified against the SHA-512 in the
  release's `latest.yml` before it is applied — the integrity check the
  missing code signature would otherwise give. A "Check for updates" link
  skips the four-hour timer, and the first launch after any update shows a
  one-time "Updated to vX.Y.Z" notice, so a silent on-quit update never
  leaves you wondering which version you're on.
- Builds that cannot replace themselves are told, not left behind: the
  portable exe has no install to swap and the unsigned macOS build can't
  self-update (Squirrel.Mac requires a signature), so those check the GitHub
  API and show a button that opens the releases page instead.
- **Renamed to "Asteris DICOM App".** Typing "asteris" in the Windows Start
  menu now finds it, and the name distinguishes it from the `dcm` CLI. Saved
  connection profiles are migrated from the old name's data folder
  automatically.
- **An actual icon.** Builds previously shipped the default Electron icon,
  which made the app look anonymous exactly where the new name is supposed to
  help — the Start menu. The ◈ mark, drawn as geometry at 1024px;
  electron-builder derives the Windows and macOS formats from it.
- **A splash screen on launch.** A packaged app pays for asar extraction and
  first paint before anything appears, and that silent gap reads exactly like
  "it didn't work". The splash appears immediately and hands over to the main
  window when it has painted, with an 8-second fallback so a wedged renderer
  still produces a window rather than an eternal splash.
- **Single instance.** Launching the app twice now fronts the existing window
  instead of starting a second copy that races the first for profile writes
  and receiver ports.
- Window size, position and maximized state are remembered across launches,
  and forgotten if the display they were on is no longer connected.
- Fixed the echo screen's missing status chip — every other screen showed
  running/OK/failed next to its Run button; C-ECHO only ever showed console
  text.
- **Release assets are labeled.** The releases page now says which file is
  the CLI and which is the App, per platform, instead of a bare filename
  list — and the release body opens with a short "which file do I want"
  guide. Both release workflows apply identical labels, so it holds no matter
  which one creates the release.
- Installing a newer setup exe by hand over an existing install keeps working
  as before — the NSIS installer removes the previous version and preserves
  profiles, which live in the app's user-data folder, not the install folder.
- Fixed a corrupted `--text-faint` color value in the app stylesheet that
  made the declaration invalid CSS.
- **Releases are cut by CI.** Pushing a version bump to master now tags the
  commit and starts the release builds — the tag step that was easy to forget
  (and once produced binaries reporting the wrong version) no longer exists
  as a manual step. The auto-tagger refuses a half-bumped tree where the CLI
  and desktop versions disagree, and stands down when the tag already exists,
  so the old manual `git tag` flow still works.
- Note for this release only: v0.6.0 is the first build that carries the
  updater, so it has to be installed by hand once. Every release after it
  arrives through the app.

## v0.5.0

Transfer-syntax conversion, parallel sending, and a speed test.

- **`dcm send --transfer-syntax <ts>`** converts each instance to the requested
  transfer syntax *before* it is sent, rather than only proposing it. This is
  the distinction that matters: the library offers one presentation context of
  [Implicit, Explicit, ...additional], so merely adding a syntax there gets the
  study transcoded straight back to whatever the receiver picks first, and
  nothing changes on the wire. Converting the dataset instead means the library
  proposes a dedicated context for the converted syntax, and a peer that accepts
  it receives exactly what was asked for. Measured on a 36-instance study: 98.6
  KB on the wire as stored, 68.2 KB as RLE, 39.0 KB as JPEG 2000 — and the
  receiver stores it in that syntax. Names or UIDs are accepted.
- **`dcm send --parallel <n>`** runs up to 16 associations at once. C-STORE is
  sequential inside one association, so concurrent associations are the only
  honest way to make a transfer faster. Measured 4x on 160 instances (23.5s to
  6.0s) with the accounting still exact. Default stays 1.
- **`dcm send --json`** reports the outcome plus elapsed time, throughput, bytes
  on disk, bytes on the wire and the negotiated syntaxes. `--label` tags a run.
- Throughput is now printed under the ordinary transfer report too. It is
  measured against bytes on disk rather than bytes on the wire, so compressing a
  study does not flatter the number.
- **`dcm scp`** now accepts the transfer syntax the sender proposed first — its
  stated preference — instead of always forcing uncompressed. Forcing it made
  the loopback receiver silently undo a deliberate conversion, which made
  testing compressed transfer impossible. `--prefer-syntax` and
  `--prefer-uncompressed` restore explicit control.
- **Desktop: Speed test screen.** Compare transfer syntaxes, chunk sizes,
  association counts, or just repeat a run. Every run gets its own calling AE
  Title so the peer's ingress log can be read run by run.
- **Desktop: rebuilt tag editor.** Load a study or a single file, edit values in
  an inline grid, tick tags to remove, choose whether it applies to every
  instance or just the loaded file, and preview before writing.
- Byte statistics are captured after the socket closes rather than at
  association release, where they were still zero.

## v0.4.0

An MCP server, a desktop app, and two robustness fixes.

- **`dcm mcp`** runs a Model Context Protocol server over stdio so an assistant
  (Claude Code, Claude Desktop) can drive DICOM operations as tools:
  `dcm_echo`, `dcm_inventory`, `dcm_query`, `dcm_tags`, `dcm_send`, `dcm_anon`,
  `dcm_edit`. It reuses the CLI engine — each tool runs the real command and
  captures its output — so there is no second DIMSE implementation to drift.
  Output capture happens at the single `log` chokepoint so it never pollutes the
  JSON-RPC channel. `claude mcp add dcm-dicom -- dcm mcp`.
- **Desktop app** (`desktop/`): an Electron front end that reuses the engine
  verbatim by spawning `bin/dcm.js` through Electron's own Node. Screens for
  echo, send (with a live transfer report), a start/stop receiver, query,
  inventory, tags, edit and de-identify — each showing the exact `dcm` command
  it runs. Builds to Windows/macOS/Linux installers via a new workflow.
- **Fixed** an EPIPE crash: piping report output into a reader that closes early
  (`dcm info | head`, quitting a pager) raised an unhandled `write EPIPE` and a
  stack trace. A closed downstream pipe now exits quietly.
- **Fixed** an install failure on a Windows profile that has never had a user
  PATH: `GetValueKind('Path')` throws on a missing value, which would crash the
  install on exactly the clean machine it is most likely to run on. Both the
  one-line installer and `dcm install` now treat that as an empty PATH.
- Stripped a UTF-8 BOM from `package.json` (it broke strict JSON readers such as
  electron-builder's).

## v0.3.1

No code signing, so the friction from not signing is handled instead.

- `dcm install` clears the downloaded-from-the-internet mark from the installed
  binary on Windows. `fs.copyFileSync` carries that mark across with the file,
  so installing a browser-downloaded exe previously produced an installed copy
  that triggered SmartScreen on *every* launch rather than once. Since the
  binaries are unsigned, that would have been permanent.
- The one-line installer clears it too, belt and braces. It fetches over
  PowerShell rather than a browser, so the mark is normally never applied in
  the first place — verified empirically: the one-liner install has no mark,
  a browser download has `ZoneId=3`.
- Documented the accurate story: the recommended install path sees no
  SmartScreen warning at all; only manual browser downloads do.
- `dcm explain` is now covered by tests that stand a fake SDK in front of it
  and assert on the request it builds — model, cache breakpoint, prefix
  stability, redaction, refusal handling, and that the key is read from the
  environment only. Everything except the network round-trip.
- Release workflow can publish to npm, gated on an `NPM_TOKEN` secret.

## v0.3.0

Tag inspection and editing.

- **`dcm tags`** dumps tag number, VR, keyword and value for a file or folder.
  Metadata only, so it's fast on big trees, and it never prints pixel data.
  A folder shows one representative file per series; `--all` dumps everything.
  `--filter` matches keyword, tag or value, `--value` matches values only, and
  `--private` shows just the private and unrecognised tags.
- **`dcm edit`** sets and removes tags and writes the result. Keys can be a
  keyword, a punctuated tag or bare hex. You have to choose `--out` or
  `--in-place`; there's no default, because copying a study and overwriting one
  are too different to pick by omission. UID edits need `--force`, since
  rewriting them on part of a study splits it. `--in-place` writes to a temp
  file and renames over the original, so an interrupted write can't leave a
  truncated file behind.

Fixed:

- Person Names rendered as `<sequence, 1 item>`. dcmjs stores a PN as an array
  holding an object, which is shape-identical to a one-item sequence, so the
  value representation has to decide rather than the shape. Every patient name
  in a dump was affected.
- `--set Key=Value` silently did nothing. The parser had been taught not to let
  a flag swallow a `Key=Value` token, which C-FIND matching keys need, and that
  is exactly the opposite of what `--set` requires.
- Tests now load every command module. Commands are required lazily, so a
  syntax error in one used to surface only when somebody ran that command.

## v0.2.1

- Corrected the `0x0122 SOP Class not supported` guidance. It assumed the only
  cause was a presentation context the peer never accepted, and sent you to
  `--verbose` to find it. A production gateway was observed accepting a C-STORE
  with `0x0000`, accepting the Study Root FIND context during negotiation, and
  then refusing the query itself — so `--verbose` showed a healthy negotiation
  and the advice led away from the problem. The message now names both causes
  and says how to tell them apart.
- Added a troubleshooting section covering reason 3 (including the trap where a
  gateway allowlists the *calling* AET), reason 7, `0x0122` after a successful
  store, short transfers, SmartScreen and macOS quarantine.
- The release now fails if the built binary's version doesn't match the tag.
  v0.2.1 initially shipped binaries reporting 0.2.0 because the tag landed on a
  commit older than the version bump, and nothing caught it.

## v0.2.0

Installable in one line, on every platform.

- One-line installers for Windows, macOS and Linux that verify the download
  against the published checksums before writing anything.
- All four platforms now published: Windows x64, macOS arm64, macOS Intel and
  Linux x64. Previously Windows only.
- **`dcm install` / `dcm uninstall`** — the executable puts itself on your PATH.
  Per-user, no admin rights, `--dry-run` first. PATH is edited through the
  registry with the value type preserved, never via `setx`, which truncates at
  1024 characters.
- Running `dcm` with no arguments on a terminal opens an interactive menu that
  prompts for what each command needs and prints the command line it runs.
  Piped and scripted use never reaches it.
- NewLumen theming.
- Fixed `npm test`, which never worked — it passed directory paths that the
  Node test runner cannot resolve, so it reported 0 passed and 2 failed on
  every platform.

## v0.1.1

- Double-clicking the executable explains what the tool is instead of flashing
  a console and vanishing, which looked exactly like a crash.
- Suppressed a dependency's `Buffer()` deprecation warning that printed into
  the middle of transfer reports. Still shown under `--verbose`.

## v0.1.0

First release.

- `echo`, `send`, `scp`, `find`, `info`, `anon`, and an optional `explain`.
- Reports files found, files sent and instances acknowledged as three separate
  numbers per study, and exits non-zero on any shortfall.
- Large studies are chunked across associations, with requests built from file
  paths so pixel data never sits in memory.
- Per-instance C-STORE statuses are parsed, classified and translated.
- `A-ASSOCIATE-RJ` is translated on the `(result, source, reason)` triple,
  since reason codes are only meaningful together with their source.
- Timeouts, aborts, rejections and transport errors read differently.
- Chunks with unacknowledged instances are retried before being failed.
- Nothing implies a successful C-STORE makes a study queryable.
