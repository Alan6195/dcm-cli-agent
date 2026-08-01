# Changelog

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
