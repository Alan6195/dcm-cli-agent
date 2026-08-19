## Which file do I want?

This release carries two separate things: the desktop app and the `dcm`
command-line tool. Every asset below is labelled with which one it belongs to.

### Desktop app

- **Windows:** the file ending in `-setup.exe` is the installer, and the one
  to pick — it keeps itself up to date from these releases. The
  `-portable.exe` variant runs without installing anything, which also means
  it never updates itself.
- **macOS:** pick the `.dmg` for your chip — `arm64` for Apple Silicon, `x64`
  for Intel.

The `latest*.yml` and `*.blockmap` files are metadata the app's auto-updater
reads. They have to stay attached to the release, but you never need to
download them.

### Command-line tool (`dcm`)

One self-contained binary per platform: `dcm-windows-x64.exe`,
`dcm-macos-arm64`, `dcm-macos-x64` and `dcm-linux-x64`. The recommended way to
get one is the one-line installer in the
[README](https://github.com/Alan6195/dcm-cli-agent#install), which fetches the
right binary and checks it against `SHA256SUMS.txt` for you. If you download by
hand instead, `SHA256SUMS.txt` is there so you can run that check yourself.

Full details of what changed are in the
[CHANGELOG](https://github.com/Alan6195/dcm-cli-agent/blob/master/CHANGELOG.md).
