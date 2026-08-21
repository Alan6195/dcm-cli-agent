# DCM CLI Agent

[![CI](https://github.com/Alan6195/dcm-cli-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Alan6195/dcm-cli-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Alan6195/dcm-cli-agent)](https://github.com/Alan6195/dcm-cli-agent/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A single-binary DICOM CLI for pushing folders of DICOM around. C-ECHO, C-STORE,
C-FIND, a receiver that logs everything, worklists and MPPS, DICOMweb
(STOW/QIDO/WADO), plus inventory and de-identification. No runtime to install
on the box you're running it from. Windows, macOS and Linux.

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
reverses it, and `dcm update` replaces the installed binary with the latest
release.

</details>

A few things worth knowing:

- **It's a command-line tool, not something you double-click.** If you do
  double-click it you get an interactive menu rather than a window that flashes
  and vanishes, but the real interface is the terminal.
- **The binaries aren't code-signed**, and I'm not planning to sign them —
  a certificate costs real money for a tool a handful of people use. Use the
  one-line installer and this costs you nothing: it fetches over PowerShell
  rather than a browser, so Windows never applies the mark that triggers
  SmartScreen, and it clears the mark anyway if one is present.

  If you download by hand from a browser instead, Windows *will* warn: click
  *More info → Run anyway*. Then run `dcm install`, which strips the mark from
  the installed copy so you're not warned again on every launch. Verify the
  SHA256 from the release either way — that's the integrity check a signature
  would otherwise give you.
- **macOS quarantines downloads.** The install script clears that for you. If
  you downloaded by hand, run `xattr -d com.apple.quarantine ./dcm`.

### dcm update

The CLI counterpart to the desktop app's in-app updates. It replaces the
binary you're running with the latest published release.

```bash
dcm update --check    # is there a newer one? changes nothing
dcm update            # fetch it, verify it, install it
dcm update --dry-run  # everything except the replacement
```

It fetches the release for your platform from GitHub, checks it against the
`SHA256SUMS.txt` published alongside it, runs it once to confirm it reports the
version it should, and only then puts it in place. The download goes to a temp
file in the install directory, so a checksum that doesn't match costs you a
deleted temp file and nothing else — your working binary is never touched until
the new one has passed. There's no flag to skip the checksum: the binaries
aren't code-signed, so it's the only thing standing in for a signature.

`--check` exits 0 either way — it answered the question. Read
`updateAvailable` from `--check --json`, not the exit code. Exit 1 means the
installed binary is not the version you asked for.

On Windows a running `.exe` can't be overwritten, so the old one is renamed
aside and the new one takes its name. That rename can't be deleted while it's
still being run, so it's swept on the next update; a leftover `dcm.exe.old-*`
is not a failure. Either way the new version takes effect the next time you
run `dcm`, not in the process that did the update.

Self-replacement only makes sense for the standalone binary. Run from a
checkout, it tells you to `git pull` instead of handing you a copy of Node.
It never phones home on its own — a check happens when you ask for one.

## Prefer a window?

The same engine ships as a desktop app — **Asteris DICOM App** — for the
people on the team who won't touch a terminal. Every screen builds the real
`dcm` command, shows it, and runs it, so what the app does and what the CLI
does can never drift apart. Download the installer for your platform from
[releases](https://github.com/Alan6195/dcm-cli-agent/releases/latest) (assets
are labeled "App — …" to tell them apart from the CLI binaries). The
installed Windows app keeps itself up to date from the same releases page;
the macOS and portable builds tell you when a new version is out and take
you there instead — unsigned apps can't swap themselves. Details in
[desktop/README.md](desktop/README.md).

## Not sure where to start?

Just run `dcm` with no arguments. You get a menu that asks for what it needs and
prints the command it's running, so you learn the flags as you go rather than
having to read them first.

```
┌──────────────────────────────────────────────────────────┐
│  ◈ A S T E R I S                                         │
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
| `--speed <preset>` | `normal`, `fast`, `very-fast` or `insane`. Picks how many associations run at once *and* sizes the chunks to fill them. Read below before using it. |
| `--parallel <n>` | Associations at once, 1–16. Default 1. Wins over a preset's association count. |
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

#### Speed presets

C-STORE is sequential inside one association, so opening several at once is the
only real lever on throughput. But `--parallel` on its own is a trap, and I
walked into it: the concurrency you actually get is
`min(--parallel, ceil(instances / --chunk))`. At the default chunk of 200 a
2508-instance CT is 13 chunks, so `--parallel 16` runs 13 wide and says nothing
about it. I wrote down a throughput figure from a real transfer to a staging
PACS and attributed it to a concurrency that run never had.

`--speed` sets both halves so that can't happen. It picks the association count
and then derives a chunk size that can fill it, aiming at about two chunks per
worker so nobody idles at the tail, held between 25 and 200 instances — below 25
an association costs more in setup and release than it carries.

| Preset | Associations | What it's for |
| --- | --- | --- |
| `normal` | 1 | Ordinary clinical traffic. The default, and the only setting that adds nothing to the receiver's association count. |
| `fast` | 4 | A backlog or a migration, to a receiver you know tolerates a handful at once. |
| `very-fast` | 8 | A bulk move you're watching, on a link with enough bandwidth for the concurrency to pay. |
| `insane` | 16 | A benchmark, against a receiver you own. Not a default for production traffic, and not a thing to point at someone else's archive. |

```bash
dcm send ./ct --host pacs.example.org --port 11112 --called-ae ARCHIVE --speed fast
```

The size is derived per study, from that study's own instance count, because
chunking and the worker pool are both per study. A folder holding a 30-instance
study and a 20000-instance one gives the first a chunk of 25 and the second 200.
An explicit `--chunk` is one number for the whole run and beats the derivation;
an explicit `--parallel` beats the preset's association count. Either one says
on stderr what it displaced, so you can't half-configure a benchmark and not be
told.

**The ceiling isn't yours to set.** The receiver decides how many associations
it will accept, and going past that limit gets the extras rejected rather than
slowing anything down. A receiver at its limit answers A-ASSOCIATE-RJ with
reason 2, "local limit exceeded", and that is a *transient* rejection: the chunk
is retried, the retry lands in a slot that has since freed, and every instance
ends up acknowledged. So the usual outcome is the quiet one — a clean exit 0
whose throughput was measured at a width you never got. The loud outcome, a
shortfall between instances found and acknowledged with a non-zero exit, is what
a *permanent* rejection gives you, and it is the rarer case. Ask what the
receiver allows before you reach past `fast`, and read the width rather than
just the exit code.

Which is what the line under the report is for. It reports the width that ran,
not the one that was asked for:

```
parallelism       4 of the 16 requested concurrent association(s) — --speed insane
```

That number is measured from associations the peer actually accepted, not
workers dispatched, and it's a floor across the whole run — it can read one low
when the tail drains early, and it never reads high. `--json` carries it as
`parallelAchieved` alongside a per-study `studies` array.

`dcm send --help` is the long version: the arithmetic worked through, what each
JSON field does and doesn't mean, and what the concurrency costs the receiver
and the link rather than this machine.

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


**Serving a worklist.** By default this receiver stores but does not index, so
every C-FIND against it returns zero matches. Give it `--worklist` and it
answers Modality Worklist queries from a JSON file, which is what you want when
you're testing whether a modality's worklist query is shaped right:

```bash
dcm scp --port 11112 --ae WORKLIST --worklist ./worklist.json
```

```jsonc
[
  {
    "PatientName": "DOE^JANE",
    "PatientID": "12345",
    "AccessionNumber": "A1",
    "Modality": "CT",
    "ScheduledStationAETitle": "CT01",
    "ScheduledProcedureStepStartDate": "20260820",
    "ScheduledProcedureStepStartTime": "090000",
    "RequestedProcedureDescription": "CHEST"
  }
]
```

Write the scheduled-step keys flat; they're nested into
`ScheduledProcedureStepSequence` in the answer, which is where an MWL SCU reads
them. It matches on Modality, ScheduledStationAETitle, the scheduled start date
(a single date or a `YYYYMMDD-YYYYMMDD` range, either side open), PatientID,
PatientName and AccessionNumber, with `*` and `?` wildcards. A matching key it
doesn't support is named in a warning and ignored rather than quietly treated as
a match — results are never narrower than they look.

It's a test fixture, not a RIS: the file is read once at startup, nothing is
written back, and there are no procedure-step status transitions or MPPS.

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

### dcm mpps

A worklist says what is *scheduled*. MPPS — Modality Performed Procedure Step —
says what *happened*, and the RIS reconciles the two on Study Instance UID to
close the order. This is the half that lets a study actually be completed
rather than just looked up.

The whole transaction in one command: open the step, send the images, close the
step.

```bash
dcm find --mwl --host ris.example.org --port 11112 --called-ae WORKLIST \
  --json-raw Modality=CT > worklist.json

dcm mpps perform ./acquired --from-worklist worklist.json \
  --host ris.example.org --port 11112 --called-ae RIS-MPPS --calling-ae CT01
```

```
N-CREATE: opening the step as IN PROGRESS
  step 2.25.9030360608524058115956103740651924 is IN PROGRESS

C-STORE: sending 412 instance(s) to ARCHIVE
N-SET: closing the step as COMPLETED

  found                412
  acknowledged         412
  referenced in MPPS   412
  step status            COMPLETED
```

**A step is marked COMPLETED only when every instance was acknowledged.** There
is no flag to override that. If two instances are unaccounted for, the step is
marked DISCONTINUED and the command exits non-zero:

```
410 of 412 instances were acknowledged. The step was marked DISCONTINUED, not
COMPLETED, because two instances are unaccounted for.
```

That's the same rule the transfer report has always followed, and it matters
more here. A shortfall in `dcm send` is a number on your screen. An MPPS marked
COMPLETED is a claim in someone else's database, which a technologist will read
and believe. For the same reason, the Performed Series Sequence is built from
the instances the peer acknowledged — never from a scan of your folder — so the
record cannot reference an image the archive doesn't hold.

Use `--from-worklist` rather than retyping UIDs: `--json-raw` keeps values as
they came off the wire, while plain `--json` renders them for reading and turns
sequences into strings, losing the correlation keys MPPS needs.

The individual steps exist too, for a workflow that spans processes:

```bash
dcm mpps start --from-worklist worklist.json ...        # prints the MPPS UID
dcm mpps update <mpps-uid> --series-from ./acquired ... # still running
dcm mpps complete <mpps-uid> --series-from ./acquired ...
dcm mpps discontinue <mpps-uid> --reason-code 110501^DCM^"Equipment failure" ...
```

**Reporting progress without closing the step.** `dcm mpps update` sends an
interim N-SET: the step stays open, and `--series-from` grows
`PerformedSeriesSequence` as series complete. It is how a modality says "still
working", and it is the message receivers are least likely to have been tested
against — a server that refuses it with `0x0106` makes real devices abandon the
session, after which the worklist entry never clears.

Both wire shapes are reachable, because receivers handle them differently and
you want to know which one yours takes:

```bash
dcm mpps update <uid> ...                  # carries PerformedProcedureStepStatus = IN PROGRESS
dcm mpps update <uid> --no-status ...      # the status attribute is absent entirely
```

Leaving `--series-from` off omits `PerformedSeriesSequence` from the message,
which is not the same as sending an empty one: absent means "nothing to say
about the series", empty means "there are none". Attributes that are
N-CREATE-only per PS3.4 F.7.2-1 — patient identity, the scheduled step,
`PerformedProcedureStepID`, the station AE, start time, modality — are refused
by name rather than quietly sent.

**Walk-in exams.** `--unscheduled` on `start` and `perform` emits the scheduled
step sequence as one zero-length item, which is how PS3.3 represents a
procedure with no prior order. `perform --unscheduled` still takes the study
UID from the folder for the C-STORE, and says so, because those two identities
differing is the whole point.

The tool keeps no records of any kind, which is why `perform` is the path worth
using. Only the process that ran the C-STORE knows which instances the archive
actually acknowledged, and nothing writes that down — so a standalone
`complete` has two honest answers to "which images?": name none, or name what a
folder scan found and say so. `--series-from` does the latter and prints a
disclaimer, in yellow, every time.

The MPPS peer and the archive are often different systems, so `--store-host`,
`--store-port` and `--store-called-ae` are separate; they default to the MPPS
peer and the command prints both in full either way.

**Rehearsing with images you already have.** A worklist item invents its Study
Instance UID before the images exist, so stock images never match it, and the
tool refuses rather than sending a step and a set of images the archive can
never reconcile. The fix is the one a real modality uses — it adopts the
identity the RIS assigned:

```bash
dcm mpps perform ./stock-images --from-worklist worklist.json --adopt-worklist-identity ...
```

That sends a re-stamped **copy** carrying the worklist's study, patient and
accession. **Your folder is not modified** — the copy goes to a staging
directory whose path is printed. Series and SOP Instance UIDs are left alone,
because those belong to the equipment rather than to the order. If you would
rather send the images untouched and accept that nothing will reconcile,
`--allow-study-mismatch` says so explicitly. One caveat worth knowing: the
re-stamped copy is written by the same dataset writer `dcm edit` and `dcm anon`
use, which does not carry private tags across — if a private tag is the thing
you are testing, send as-is.

**Testing it locally.** `dcm scp` speaks MPPS as well, so you can exercise the
whole loop without a RIS:

```bash
dcm scp --port 11112 --ae WLSCP --worklist ./worklist.json --persist ./received
```

It enforces the legal status transitions, refuses a duplicate step or a missing
Type 1 attribute the way a conformant SCP does, and when a step finishes it
correlates back to the worklist item on Study Instance UID and stops returning
it — which is what a real RIS does. `--keep-performed` leaves them in.

**Checking what a peer actually emitted.** `--json-raw` carries values exactly
as received — a `PatientWeight` of `"12.5 kg"` stays that string rather than
becoming the number `12.5` — with an `_elements` sidecar giving the VR and
length per tag. `--check-vr` then reports every conformance violation in what
came back:

```bash
dcm find --mwl --check-vr --host ris.example.org --port 11112 --called-ae WORKLIST
```

```
VR conformance: 4 violations over 13 elements returned.
  match 0  (0010,0040) PatientSex  CS  "male" is not one of M, F, O
  match 0  (0010,1030) PatientWeight  DS  "12.5 kg" is not a valid DS value
  match 0  (0032,1060) RequestedProcedureDescription  LO  72 characters, LO permits 64
```

It exits 1 when any are found, and emits `vrViolations` under `--json`. This
exists because a tool that quietly repairs a violation on the way past reports
a clean pass whether or not the server was right — which is the worst possible
answer for anyone testing their own coercion.

And `--set <Key>=<Value>` stamps a value into the outgoing C-FIND identifier
byte for byte, bypassing validation, so you can hand a server something
deliberately hostile and watch what it does. It announces itself loudly every
time, for the same reason `--allow-study-mismatch` does.

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

### dcm tags

Dumps the DICOM tags in a file or folder. Reads metadata only and never prints
pixel data, so it's safe to point at anything.

```bash
dcm tags ./study/instance-1.dcm
```

```
(0008,0016) UI SOPClassUID                        1.2.840.10008.5.1.4.1.1.2
(0008,0018) UI SOPInstanceUID                     1.2.840.113619.2.55.3.604688.1.1
(0008,0060) CS Modality                           CT
(0008,0080) LO InstitutionName                    ST ELSEWHERE
(0010,0010) PN PatientName                        DOE^JANE
(0010,0020) LO PatientID                          12345
(0020,000D) UI StudyInstanceUID                   1.2.840.113619.2.55.3.604688.1
(7FE0,0010) ox PixelData                          <not read — metadata only>
```

Point it at a folder and it shows one representative file per series, which is
usually what you want. `--all` dumps every file.

```bash
dcm tags ./study --filter Patient          # substring on keyword, tag or value
dcm tags ./study --filter "/Patient|Study/" # or a regex
dcm tags ./study --value "DOE^JANE" --all   # which files still carry this?
dcm tags ./study --private                  # private and unrecognised tags only
dcm tags ./study --json
```

`--value` is the one I reach for most: it answers "which instances still have
an identifier in them" without opening anything.

### dcm edit

Changes or removes tags and writes the result.

```bash
dcm edit ./study --set PatientID=TEST001 --remove InstitutionName --out ./edited
```

```
  set     (0010,0020) PatientID = "TEST001"
  remove  (0008,0080) InstitutionName
instances found     823
would change        823
written             823

OK — 823 instance(s) written.
```

The key can be a keyword (`PatientID`), a punctuated tag (`(0010,0020)`) or a
bare hex tag (`00100020`), because people copy tags from all three. `--set` and
`--remove` are repeatable.

You have to say where the output goes — `--out <dir>` to write copies, or
`--in-place` to overwrite. There's deliberately no default, because the
difference between writing a copy and overwriting a study isn't something to
get wrong by leaving a flag off. `--dry-run` shows what would change first.

Editing UIDs is refused unless you pass `--force`. Study, Series and SOP
Instance UIDs are what tie a study together and what receivers use to recognise
it, so rewriting them on some instances and not others splits a study, and
reusing one that exists elsewhere collides with it. If you want fresh UIDs
across a whole study, `dcm anon` remaps them consistently and keeps the
relationships intact.

`--in-place` writes to a temporary file and renames over the original, so an
interrupted write can't leave a truncated file where a valid instance used to
be.

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

### dcm web

The same operations over DICOMweb — the HTTP face of DICOM — for the servers
that speak it (cloud PACS, VNAs, Orthanc's DICOMweb plugin). STOW-RS to send,
QIDO-RS to query, WADO-RS to retrieve, and a loopback hub to test against.

```bash
export DCM_WEB_URL=https://pacs.example.org/dicom-web

dcm web ping
dcm web send ./study
dcm web query PatientID=12345
dcm web retrieve --study 1.2.840.113619.2.55.3.604688.1 --out ./pulled
```

The same three numbers, the same rule: `web send` reports files found, sent
and acknowledged from the server's own STOW response — instances the server
listed as failed, or didn't account for at all, exit non-zero. A partial
transfer is a failure over HTTP too.

Credentials come from the environment and nowhere else, same policy as
`dcm explain`'s API key — no flag, no config file, so they can't land in your
shell history:

```bash
export DCM_WEB_TOKEN=...            # Bearer, or:
export DCM_WEB_USER=... DCM_WEB_PASS=...  # HTTP Basic
```

Two things worth knowing before you chase a "failure":

- **Include the path prefix in the URL.** Most servers root DICOMweb under
  something like `/dicom-web`; a 404 on ping usually means the base URL is
  missing it, not that the server is down.
- **A good ping is not a storage grant.** Like C-ECHO, `web ping` proves the
  URL answers and your credentials open it. Whether STOW is permitted is a
  separate server-side decision.

And the loopback hub, the web mirror of `dcm scp`:

```bash
dcm web serve --port 10808 --persist ./received
```

It accepts STOW, answers QIDO over what it holds, and serves WADO back. Binds
127.0.0.1 unless you say otherwise — it's a test target, not a PACS. The same
failure-injection switches exist for reproducing problems locally:
`--require-token <token>` (reproduces 401s — use a made-up value, never a real
one) and `--reject-after <n>` (a server that accepts part of a request and
refuses the rest, for testing the shortfall accounting).

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

### dcm mcp

Runs a Model Context Protocol server over stdio, so an assistant — Claude Code,
Claude Desktop, or anything else that speaks MCP — can drive these operations as
tools. It is the same engine, not a second implementation: each tool builds the
argument vector the command takes and runs it, capturing the output.

```bash
# Claude Code
claude mcp add dcm-dicom -- dcm mcp
```

```jsonc
// Claude Desktop — claude_desktop_config.json
{
  "mcpServers": {
    "dcm-dicom": { "command": "dcm", "args": ["mcp"] }
  }
}
```

**Tools.** Everything the CLI does, minus the parts that make no sense to an
assistant (`explain` — it *is* the assistant; `install` — it manages its own
PATH):

| | |
|---|---|
| DIMSE | `dcm_echo`, `dcm_query`, `dcm_worklist`, `dcm_send` |
| DICOMweb | `dcm_web_ping`, `dcm_web_query`, `dcm_web_send`, `dcm_web_retrieve` |
| Local files | `dcm_inventory`, `dcm_tags`, `dcm_edit`, `dcm_anon` |
| Servers | `dcm_receiver_start`, `dcm_web_hub_start`, `dcm_servers_list`, `dcm_server_status`, `dcm_server_stop` |

`dcm_worklist` is a Modality Worklist query in its own right rather than a
level of `dcm_query`, because worklist matching uses a different vocabulary —
`Modality`, `ScheduledStationAETitle`, scheduled dates — and an empty worklist
is a legitimate answer rather than a failure. It takes `scheduledDate: "today"`
as well as an explicit date or range.

The server tools are what let an assistant check its own work: start a
receiver or a DICOMweb hub on this machine, send to it, read back what arrived,
and stop it. They run as separate child processes so their logging can never
touch the JSON-RPC channel, they pick a free port if you don't name one, and
they are killed when the server exits. Stop them when you're done.

**Resources.** `dcm://usage/<command>` serves each command's own `--help` text,
read from the installed code so it cannot drift, and `dcm://troubleshooting`
carries the failure modes that actually cost time — the calling-AE allowlist
trap, `0x0122` arriving *after* a successful store, a peer that stores happily
and still answers zero queries, a DICOMweb 404 that is really a missing
`/dicom-web` prefix.

**Prompts.** `verify-a-peer`, `diagnose-a-failed-transfer` and `mirror-a-study`
encode the orderings that work, rather than leaving them to be rediscovered.

It reads and writes JSON-RPC on stdin/stdout and is meant to be launched by the
client, not run by hand. `dcm_send` reports the same found/sent/acknowledged
accounting as the CLI and flags a shortfall as an error; pass `dryRun` to plan
without connecting. DICOMweb credentials are read from the environment the
server was launched with (`DCM_WEB_TOKEN`, or `DCM_WEB_USER`/`DCM_WEB_PASS`) and
are deliberately not tool arguments, so a token never travels through the
conversation.

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

The binaries aren't code-signed and won't be. Verify the SHA256 against the
release, then *More info → Run anyway*.

You can avoid it entirely by using the one-line installer instead of downloading
through a browser — PowerShell doesn't apply the mark that triggers SmartScreen.

If you already downloaded by hand, run `dcm install` after clicking through
once. That strips the mark from the installed copy, so you're warned once rather
than every single time you run `dcm`. (Windows copies the mark along with the
file, so an installed copy of a marked binary stays marked until something
clears it.)

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

Two things that look like failures and aren't: `dcm update --check` exits 0
whether or not an update exists, because it answered the question; and a
`dcm.exe.old-*` file left behind by an update exits 0, because the new binary
is installed and the leftover is swept on the next run.

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
