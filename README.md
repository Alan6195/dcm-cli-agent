# DCM CLI Agent

[![CI](https://github.com/Alan6195/dcm-cli-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Alan6195/dcm-cli-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Alan6195/dcm-cli-agent)](https://github.com/Alan6195/dcm-cli-agent/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A single-binary DICOM CLI for pushing folders of DICOM around. C-ECHO, C-STORE,
C-FIND, a receiver that logs everything, plus inventory and de-identification.
No runtime to install on the box you're running it from. Windows, macOS and
Linux.

I wrote this because every DICOM transfer tool I've used answers the wrong
question. They tell you the association succeeded. What I need to know is
whether all 823 files actually landed, and if not, which ones didn't and why.

```
files found       823
files sent        823
acknowledged      822

SHORTFALL: 1 of 823 file(s) were not acknowledged.
```

That exits non-zero. A partial transfer is a failure, not a warning.

## Install

One line. It grabs the right binary for your machine, checks it against the
published SHA256, installs it under your own user profile and puts it on your
PATH. No admin rights, nothing written outside your home directory.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Alan6195/dcm-cli-agent/master/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Alan6195/dcm-cli-agent/master/install.sh | bash
```

Open a new terminal and type `dcm`. That's it.

<details>
<summary>Rather do it by hand?</summary>

Download the binary for your platform from
[releases](https://github.com/Alan6195/dcm-cli-agent/releases), then let it
install itself:

```powershell
.\dcm-windows-x64.exe install
```

```bash
chmod +x dcm-macos-arm64 && ./dcm-macos-arm64 install
```

`dcm install --dry-run` shows exactly what it would do first. `dcm uninstall`
reverses it.

Or with Node 22+, skip the binary entirely:

```bash
npm install -g dcm-cli-agent
```

</details>

A few things worth knowing:

- **It's a command-line tool, not something you double-click.** If you do
  double-click it you get an interactive menu rather than a window that flashes
  and vanishes, but the real interface is the terminal.
- **Windows SmartScreen will warn you the first time**, because the binary
  isn't code-signed. Check the SHA256 from the release, then *More info → Run
  anyway*.
- **macOS quarantines downloads.** The install script clears that for you. If
  you downloaded by hand, run `xattr -d com.apple.quarantine ./dcm`.

## Not sure where to start?

Just run `dcm` with no arguments. You get a menu that asks for what it needs and
prints the command it's running, so you learn the flags as you go rather than
having to read them first.

```
┌──────────────────────────────────────────────────────────┐
│  ◈ N E W L U M E N                                       │
│  DICOM CLI Agent · v0.2.0                                │
└──────────────────────────────────────────────────────────┘

  What would you like to do?

   1  Test a connection
      C-ECHO — is the peer there, and does it accept our AE Title?
   2  Inventory a folder
      What is in it: studies, series, modalities, sizes. Sends nothing.
   3  Send a study
      C-STORE a folder to a peer, reporting exactly what was acknowledged.
   4  Receive images
      Run a receiver that accepts everything and logs what arrives.
   ...
```

Everything scripted or piped skips the menu entirely, so this never gets in the
way of a cron job.

## Quickstart

Easiest way to see it work is to point it at itself. One terminal:

```bash
dcm scp --port 11112 --ae TEST-SCP --persist ./received
```

Another:

```bash
dcm echo --host localhost --port 11112 --called-ae TEST-SCP
dcm info ./study
dcm send ./study --host localhost --port 11112 --called-ae TEST-SCP
```

Against a real peer I always do the same three steps in the same order. Echo
first so you know the AE Titles are right, inventory second so you know what
you're about to send, then send.

```bash
dcm echo --host pacs.example.org --port 11112 --called-ae ARCHIVE --calling-ae DCM-CLI
dcm info ./study
dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE --calling-ae DCM-CLI
```

If you're doing this repeatedly, put the connection details in the environment:

```bash
export DCM_HOST=pacs.example.org
export DCM_PORT=11112
export DCM_CALLED_AE=ARCHIVE
export DCM_CALLING_AE=DCM-CLI

dcm echo
dcm send ./study
```

Flags and env vars only. It never reads a config file, so a checkout of this
repo can't accidentally carry someone's hostnames or AE Titles.

## Commands

### dcm echo

Is there a DICOM service there, and will it talk to me under these AE Titles?

```bash
dcm echo --host pacs.example.org --port 11112 --called-ae ARCHIVE --calling-ae DCM-CLI
```

```
OK  pacs.example.org:11112 answered C-ECHO in 23 ms
    calling AE DCM-CLI was accepted by ARCHIVE
```

When it fails you get English, not a code:

```
Calling AE Title not recognized: Calling AE Title not recognized by peer — it
likely needs to be registered/allowlisted on the receiving side.
  This is the most common connectivity failure and it is a configuration issue,
  not a code issue. Give the peer's administrator the exact calling AE Title you
  are sending (--calling-ae), plus your source IP, and ask them to register it.
  AE Titles are case-sensitive and limited to 16 characters.
  [A-ASSOCIATE-RJ result=1 source=1 reason=3]
```

The raw code is still there so you can quote it at whoever runs the far end.

One thing worth being clear about: a good echo proves connectivity and that your
calling AE Title is allowed to associate. It does not prove the peer will accept
your images. Storage is negotiated separately per SOP Class.

### dcm send

Walks a folder tree, groups by Study and Series Instance UID, sends each study
in chunks.

```bash
dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE
```

```
────────────────────────────────────────────────────────────────────────
TRANSFER REPORT
────────────────────────────────────────────────────────────────────────
Peer            pacs.example.org:11112 (ARCHIVE)
Calling AE      DCM-CLI
Chunk size      200 instance(s) per association

Study 1.2.840.113619.2.55.3.604688.1
  patient        DOE^JANE / 12345
  modalities     CT

    files found      823
    files sent       823
    acknowledged     822

    SHORTFALL: 1 of 823 file(s) were not acknowledged.

    failed             1  the peer refused the instance

    status codes returned by the peer (all attempts):
      0x0000 x822   Success
      0xA700 x1     Refused: out of resources
        The receiver ran out of resources and refused the instance.
        Usually disk space or a queue limit on the far side.

    files not acknowledged (1):
      series-7/instance-0412.dcm  0xA700 Refused: out of resources
────────────────────────────────────────────────────────────────────────
FAILED — 1 of 823 file(s) were not acknowledged.

Exit code 1. A partial transfer is a failure, not a warning.
```

Options I actually use:

| Option | Meaning |
| --- | --- |
| `--chunk <n>` | Instances per association. Default 200. |
| `--retry <n>` | Retry a chunk where fewer came back than went out. Default 1. |
| `--dry-run` | Scan and show the plan. Doesn't connect. |
| `--no-recurse` | Only files directly in the folder. |
| `--timeout <ms>` | How long to tolerate silence. Default 60000. |
| `--rewrite-series-uid` | Replace Series Instance UIDs. Changes your data, read below. |
| `--verbose` | Full association negotiation. |

Always worth a dry run first on anything big:

```bash
dcm send ./studies --dry-run --chunk 100
```

#### --rewrite-series-uid changes what you send

Some source systems emit the same Series Instance UID for series that are
genuinely different. The receiver then merges them, and a study that had six
series shows up with three. Took me a while to work out what was happening the
first time.

This flag gives each source series a new `2.25.*` UID so distinct series stay
distinct:

```bash
dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE --rewrite-series-uid
```

The new UID is derived from the Study UID, the source Series UID, and the Series
Number. That last part is the bit that actually matters and it took me a go to
get right. If you only hash the study and series UID, both halves of a collision
hash to the same value and you've faithfully reproduced the merge in shiny new
UIDs. Series Number is normally still distinct when the UIDs aren't, so that's
what breaks the tie. If Series Number is missing it falls back to the containing
folder.

For data that isn't broken this is a no-op: one real series has one UID and one
Series Number, so it still maps to exactly one replacement. It won't split
series that were fine.

It's off unless you ask for it, because the peer ends up with something
different from what's on your disk. The mapping is deterministic, so re-sending
maps onto the same series instead of creating a second copy.

Run `dcm info --series` first. It'll tell you whether you actually have this
problem before you reach for the flag.

### dcm scp

A receiver that accepts everything and logs what it sees. I use it as a loopback
target for testing senders, and to find out what a system is actually emitting
when the vendor docs disagree with reality.

```bash
dcm scp --port 11112 --ae TEST-SCP --persist ./received
```

```
listening on port 11112
  called AE Title  : TEST-SCP
  calling AE allow : (any)
  persist          : /home/you/received
  press Ctrl+C to stop

<- association from 192.0.2.10:49871 (calling AE MODALITY -> called AE TEST-SCP)
<- C-STORE #1 CT 1.2.840.113619.2.55.3.604688.1.1
<- C-STORE #2 CT 1.2.840.113619.2.55.3.604688.1.2
-> releasing association with MODALITY (2 instance(s) this association)
```

Files land at `<dir>/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm`.

Two switches for reproducing failures locally, which is much easier than trying
to get a real PACS to misbehave on demand:

```bash
# Reject everything except this calling AE Title. Reproduces reason 3.
dcm scp --port 11112 --accept-calling-ae ALLOWED-AE

# Stop acknowledging after 20 instances per association. Reproduces a mid-transfer stall.
dcm scp --port 11112 --reject-after 20
```

### dcm find

Query a peer. Matching keys are bare `Keyword=value` pairs.

```bash
dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE PatientID=12345
```

```
PatientName  PatientID  StudyDate  ModalitiesInStudy  NumberOfStudyRelatedInstances  StudyDescription
───────────  ─────────  ─────────  ─────────────────  ─────────────────────────────  ────────────────
DOE^JANE     12345      20260115   CT                 823                            CHEST

1 match.
```

```bash
# Date range
dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE --study StudyDate=20260101-20260131

# Series inside a study
dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE --series StudyInstanceUID=1.2.840.113619.2.55.3.604688.1

# Worklist
dcm find --host pacs.example.org --port 11112 --called-ae WORKLIST --mwl Modality=CT

# For scripts
dcm find --host pacs.example.org --port 11112 --called-ae ARCHIVE PatientID=12345 --json
```

Zero matches does not mean your transfer failed. See below.

### dcm info

Inventory a folder without sending anything. It reads metadata only and stops
before the pixel data, so it's fast even on big trees.

```bash
dcm info ./study --series
```

```
────────────────────────────────────────────────────────────────────────
INVENTORY — /data/study
────────────────────────────────────────────────────────────────────────
files examined      824
DICOM instances     823
studies             1
total size          412.7 MB
unreadable          1

modalities:
  CT             823 instance(s)

transfer syntaxes:
  Explicit VR Little Endian                 823 instance(s)
  1.2.840.10008.1.2.1

Study 1/1  1.2.840.113619.2.55.3.604688.1
  patient ID     12345
  study date     20260115
  modalities     CT
  series         7
  instances      823
  size           412.7 MB
  would send in  5 association(s) at --chunk 200
```

`--json` for scripting. `--series` for the per-series breakdown, which also
flags colliding Series Instance UIDs.

### dcm anon

De-identifies a folder into a new directory. Never touches the source.

```bash
dcm anon ./study --out ./study-anon
dcm info ./study-anon
```

Pseudonymises patient identifiers, remaps Study/Series/SOP Instance UIDs to
deterministic `2.25.*` values that keep the relationships intact, strips
institution/physician/device tags and private tags, sets
`PatientIdentityRemoved = YES`.

Please read this bit before you share anything it produces. It does not look at
pixel data, so burned-in annotations survive untouched. It doesn't walk nested
sequences exhaustively, so identifiers in Structured Reports or Presentation
States can survive. It is not a certified implementation of the PS3.15
confidentiality profiles. Check a sample yourself before it leaves your network.
Treat the output as best-effort, not provably anonymous.

### dcm explain (optional)

Pipes a failed transfer log at the Anthropic API and gets back a plain-English
diagnosis. Completely optional. Everything else works without it and nothing
here touches the network unless you run this command.

```bash
export ANTHROPIC_API_KEY=sk-ant-...

dcm send ./study --host pacs.example.org --port 11112 --called-ae ARCHIVE 2>&1 | dcm explain
```

The key comes from `ANTHROPIC_API_KEY` and nowhere else. No flag, no config
file, so there's no way for it to end up in your shell history or a commit.

Patient identifiers get redacted before anything is sent. If you want to see
exactly what would go over the wire:

```bash
dcm explain --show-prompt < transfer.log
```

## Why it behaves the way it does

Every item here is something that bit me.

**It won't silently drop files.** Every file found on disk gets registered and
has to end the run with exactly one recorded outcome: acknowledged, warning,
failed, unreadable, unanswered, or not attempted. At the end it counts those
outcomes and compares against the number of files found. Anything that slipped
through every code path has no outcome, shows up as unaccounted, and fails the
run.

That's why you get three numbers instead of one. Collapsing found, sent and
acknowledged into a single success line is exactly how a lossy transfer ends up
looking clean. I lost one file out of 823 once and only caught it because I
happened to compare the numbers by eye.

Warnings don't count as success either. `0xB000` means the receiver rewrote your
data. That belongs in the report, not folded into a tick.

**Big studies get chunked.** Default 200 instances per association, across
separate associations, so memory stays flat no matter how big the study is.
Cross-sectional work routinely hits thousands of instances and I've watched
naive implementations OOM on a 16 GB laptop.

Requests are built from file paths rather than parsed datasets, so pixel data
never sits in memory. Measured it at about 31 MB versus 388 MB for 200 two-meg
instances. `--rewrite-series-uid` has to parse each dataset to change it, so it
drops the chunk size automatically to compensate.

**Per-instance status codes get parsed.** A peer will happily accept your
association and then refuse individual instances, so the association result on
its own tells you almost nothing. Every C-STORE response status is recorded,
classified (`0x0000` success, `0xB000`–`0xBFFF` warning, everything else a
failure), translated, and reported with counts per distinct code. That includes
codes from attempts that were later retried, so a receiver that's struggling
stays visible even when the run eventually succeeds.

**Rejections get translated.** `A-ASSOCIATE-RJ` reason codes only mean anything
in combination with the source. Reason 3 from the service-user means the calling
AE Title isn't recognised. Reason 3 from a service-provider source isn't a
defined value at all. So the lookup is on the `(result, source, reason)` triple,
not the reason alone. The raw code always gets printed next to the explanation.

Reason 3 is far and away the most common thing you'll hit in the field, and it's
almost always an allowlist entry missing on the receiving side rather than
anything wrong with your setup.

**Timeouts look different from rejections.** A rejection is an answer. A timeout
is silence. Different causes, different fixes, so they never share a message.
Every association is watched, and a timeout is reported by phase: connect,
negotiation, or mid-transfer stall. An abort is a third thing again (the
association was accepted and then torn down) and reads differently too.

**Transient failures get retried.** Some receivers take the association,
acknowledge part of the transfer, then go quiet. Any chunk where fewer instances
came back acknowledged than were sent gets retried, default once, with only the
outstanding instances, before the run is called failed.

**Accepted is not the same as queryable.** A successful C-STORE means the peer
accepted those instances. It does not mean the study is searchable there.
Store-and-forward receivers return zero C-FIND matches for data they've accepted
and not yet indexed or passed on, and this catches people out constantly.

Neither `send` nor `find` will imply otherwise. If you need to know a study is
searchable, query the system that's supposed to hold it, give it time to
process, and check your AE Title is allowed to query as well as store.

**Hostnames, not IPs.** Gateway addresses move. DNS survives. Every example here
uses `pacs.example.org` or an RFC 5737 documentation address.

**`--verbose` is the thing that actually helps.** It logs the whole association
negotiation: every proposed and accepted presentation context, the transfer
syntax each settled on, and the peer's implementation class UID and version.
When something's wrong on the wire that's what you need, and it's usually the
first thing I reach for.

## Troubleshooting

The four things I actually hit, and what they mean. All of these have been
reproduced against a real gateway, not just against the loopback receiver.

### "Calling AE Title not recognized" / reason 3

```
[A-ASSOCIATE-RJ result=1 source=1 reason=3]
```

Your calling AE Title isn't allowlisted on the far end. This is a configuration
entry someone has to add on the receiving side, not anything wrong with your
setup, and no amount of retrying or flag-fiddling will change it.

Send whoever runs the peer the exact value you're passing to `--calling-ae`
along with your source IP. AE Titles are case-sensitive and capped at 16
characters.

Watch out for the direction. Some gateways allowlist the **calling** AET rather
than matching on the called one, and in that case the AE Title they give you is
the one to put in `--calling-ae`, not `--called-ae`. If reason 3 persists with
what you were told is the right AE Title, try it in the other slot:

```bash
dcm echo --host pacs.example.org --port 11112 --called-ae THEIR-AET --calling-ae THEIR-AET
```

### "Called AE Title not recognized" / reason 7

You reached a real DICOM service but asked for a name it doesn't answer to. One
host can serve several AE Titles on one port. Check `--called-ae`.

### C-FIND returns 0x0122, or no matches, for images you know went across

```
error the peer refused the query: 0x0122 SOP Class not supported
```

A successful C-STORE means the peer *accepted* your images. It does not mean it
can be queried for them, and plenty of gateways can't be queried at all.

I've seen a production store-and-forward gateway accept images with `0x0000`,
accept the Study Root Query/Retrieve FIND presentation context during
negotiation, and then answer the query itself with `0x0122`. So `--verbose`
shows a negotiation that looks completely healthy, which makes this a confusing
one to chase — advertising a presentation context isn't a promise to implement
the service behind it.

If images are being accepted but you can't find them, query whichever system is
actually meant to hold them rather than the one you sent to, and give it time to
process. Also check your AE Title is permitted to query, not just to store;
those are often separate permissions.

### It sent, but fewer instances arrived than you sent

That's what the three numbers are for, and it's why the run exits non-zero. Look
at the per-instance status codes in the report — they say whether the receiver
refused them (`0xA700` out of resources is usually transient), never answered
(a stall, retry it), or whether the files never parsed off disk in the first
place.

### Windows says "Windows protected your PC"

The binary isn't code-signed. Verify the SHA256 against the release, then *More
info → Run anyway*.

### macOS says the binary is damaged or can't be opened

macOS quarantines downloads. The install script clears it; by hand:

```bash
xattr -d com.apple.quarantine ./dcm
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Done, nothing lost. |
| `1` | Ran but didn't fully succeed, including an accepted-but-lossy transfer. |
| `2` | Bad command line. |

The 0/1 split is deliberately strict. 823 found and 822 acknowledged exits 1.
It's meant to be safe to drop into a cron job.

## Building from source

Node 22 or newer.

```bash
git clone https://github.com/<owner>/dcm-cli-agent.git
cd dcm-cli-agent
npm install
npm run build
```

You get `dist/dcm.exe` (or `dist/dcm` on macOS and Linux), which is a copy of
the Node binary with the app injected as a Single Executable Application. The
build smoke-tests the binary before it calls itself done.

The only binary artifact in the whole dependency tree is one WebAssembly module
from `dcmjs-codecs`, for transcoding compressed transfer syntaxes. It's embedded
in the exe as a SEA asset and unpacked to a temp file on first use. If it can't
load, the tool still runs, it just can't transcode compressed syntaxes.

No native addons anywhere in the tree, which is the whole reason single-file
packaging works cleanly here.

## Testing

```bash
npm test
```

Unit tests cover the accounting invariants, status and rejection translation,
UID generation and argument parsing. Then end-to-end transfers run against an
in-process receiver: C-ECHO, single-instance send, multi-chunk send, a
deliberate wrong-AE rejection, mid-transfer refusal and retry, and the lossy
transfer case.

Fixtures are synthetic and generated on demand. No real studies in this repo,
and `.gitignore` is set up to keep it that way.

```bash
npm run fixtures
node tools/make-fixtures.js ./fixtures --studies 3 --instances 50 --corrupt
```

If you want to test against something that isn't this tool, `dcm scp` works as a
loopback target and a local Orthanc container works well:

```bash
docker run -p 4242:4242 -p 8042:8042 --rm jodogne/orthanc
dcm echo --host localhost --port 4242 --called-ae ORTHANC
dcm send ./fixtures --host localhost --port 4242 --called-ae ORTHANC
```

## License

MIT. See [LICENSE](LICENSE).
