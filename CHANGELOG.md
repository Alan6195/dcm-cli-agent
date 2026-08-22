# Changelog

## v0.14.1

An independent recheck of the shipped v0.14.0 code landed after the tag. This
entry is what it found, and the largest item is a sentence I wrote myself.

**The help text, the README and the v0.14.0 entry below all describe a failure
mode that does not reliably happen.** All three said that a receiver at its
concurrent-association limit rejects transiently, that "the retry lands in a
slot that has since freed, and every instance ends up acknowledged", and that
the run therefore "exits 0 having quietly done the work narrower than it was
told to" — with a shortfall and a non-zero exit filed as the rarer, permanent
case. I wrote that while correcting the opposite overstatement, and I got there
by reasoning from the DICOM meaning of *transient* — retryable — straight to "so
it recovers", without reading the retry loop I was describing.

`sendChunkWithRetry` has no backoff. The next attempt opens immediately, so
every attempt `--retry` allows is spent within milliseconds of the first
rejection, while the associations occupying the slots are still working through
their chunks — which takes seconds. A slot can free inside that window, and then
the run really does end clean and narrow. Often none does. Measured against a
peer capped at 3 associations, `--parallel 4 --chunk 30 --retry 12` left 60 of
240 instances unacknowledged and exited 1. The same measurement against the
v0.13.4 engine gives the same result, so the behaviour is not new — only the
claim about it was, which is the part that makes it worth an entry rather than a
quiet edit. A correction that overshoots into a second wrong answer is not a
correction.

The honest version is that both endings are reachable, and which one you get
turns on whether some chunk happens to finish inside the few milliseconds the
retries occupy: on chunk size, link speed and the peer's own pace, none of which
the run controls. "Transient" is not "recovered", and a larger `--retry` buys
more attempts inside the same millisecond rather than more time. All three
surfaces now say that, and they end on a takeaway that holds either way: read
the width, and read found/sent/acknowledged. The width says whether the run was
as wide as it was told to be, the counts say whether all of it arrived, and the
exit code answers only the second question.

The rest of what the recheck found in the code:

- **`parallelAchieved` could read one higher than the peer ever granted.**
  `liveAssociations` was decremented when `runAssociation` resolved, which is
  after the socket closes or the 400 ms close grace expires — well after
  A-RELEASE-RP. A peer at its limit frees its slot on the release and admits the
  replacement immediately, so the departing association and the one that took
  its place were both counted live at this end. Against a receiver granting 3, a
  `--speed fast` run reported `parallelAchieved: 4` of 4 with no caveat and no
  warning, in 2 of 5 runs. Non-deterministic, in the flattering direction, and
  landing exactly on the value that suppresses the shortfall caveat — the defect
  class this release exists to end, inside the fix for it. `runAssociation` now
  takes an `onEnded` callback fired from every terminal handler the moment the
  association is over, and the slot goes back there instead. The regression test
  uses a receiver that queues past a cap; the existing coverage only exercised
  refuse-all and accept-all, which is why this survived. One case remains and
  cannot be closed from this end: a peer that puts the replacement's
  A-ASSOCIATE-AC on the wire *before* the departing association's A-RELEASE-RP
  has told the sender about the arrival before the departure, and the count
  reads +1 again. Measured 5 of 5 against a receiver built to do exactly that.
  The error still points the flattering way, which is why it is written down
  here rather than left implied by "errs downward".
- **The association count included associations that carried nothing.** A
  refused association still incremented `metrics.associations`, so a run the
  peer rejected outright reported `associations: 2` beside `sent: 0` and
  `bytesSent: 0`, and bytes-per-association read as poor efficiency rather than
  as a peer saying no. It is counted on acceptance now. This error pointed the
  unflattering way, which is presumably why it lasted.
- **With no studies at all, the width reducer returned the width that was
  requested.** The seed survived untouched, so the one input that measured
  nothing would have reported the full request as an achievement. Unreachable
  today — the run returns before it when nothing was found — but it is the exact
  shape of claim that function exists to prevent, and a length check costs one
  comparison.
- **A warning fired for an override that displaced nothing.** `--speed normal
  --chunk 200` warned that `--chunk` had won and the preset "does not get to
  size associations", when at one association the derivation returns 200 for
  every study, so nothing was displaced. That is the same self-contradicting
  warning v0.14.0 fixed on the `--parallel` side and left standing on the other
  flag — and easy to hit from the desktop, where Chunk size sits under Advanced
  with Normal selected by default. It is now suppressed in the one case where
  equality is decidable for every study at once: one association, the default
  size, and no `--rewrite-series-uid` or `--transfer-syntax`, since those cap a
  derived size but deliberately not a typed one.

- **An unreachable PACS was told it had a concurrency problem.** The width
  warning was ungated, so the default configuration — one association, no
  `--speed`, no `--parallel` — greeted a peer that accepted nothing with
  "1 concurrent association(s) were opened ... the peer never had more than 0
  accepted at once ... lower --parallel or --speed to what it allows". At one
  association there is no rest for the peer to refuse and nothing that could
  have overlapped; the only way to reach the check is a peer that accepted
  nothing at all, which the shortfall and the exit code already state plainly.
  A feature about concurrency had put itself in front of the most common
  failure mode there is, on a setting nobody chose. It now requires more than
  one association to fire, which is the only case where either of its two
  readings is possible.
- **`--speed` reached the MCP `dcm_send` tool.** v0.14.0 exposed `--chunk`,
  `--parallel` and `--retry` there but not the preset, so an agent could set
  either half of a benchmark and not the thing that sets both — the release's
  headline feature was the one lever it could not pull.

Two things that are working as intended and are documented rather than changed:

- **`parallelAchieved` is a floor across studies, and it will read as a bug.**
  One unavoidably narrow study pins the number for the whole run, and a study
  can be narrow for a reason no setting can fix: 3 instances is one chunk, one
  chunk is one association, at every preset. So a folder holding a 240-instance
  series that genuinely ran 4 wide and a 3-instance dose SR beside it — the
  shape of most real folders — reports `parallelAchieved: 1` and prints
  `parallelism 1 of the 4 requested` for a run in which 98.8% of the data moved
  4 wide. Nothing is overstated and nothing is wrong; it is the conservative
  reading, because the throughput figure printed next to the width covers the
  whole run, so the width has to be one that no part of the run fell below. The
  alternative — an average, or the widest study — would put a number next to
  that throughput figure which no single study is answerable for. It is now
  spelled out everywhere the width is explained, with a pointer to the
  per-study `studies` array, instead of being left for the first operator to
  hit it.
- **`--json`: `chunkSize` is `null` whenever a preset derived the size.** It was
  always a number before v0.14.0. This shipped undocumented and should have been
  called out then: nothing in the repo breaks, since the desktop reads
  `parallelAchieved`, `parallel` and `studies`, and the MCP `dcm_send` tool
  passes text through without parsing the envelope — but an external benchmark
  script dividing by it gets `Infinity` or `NaN`. The size is per study once a
  preset derives it, and no single number is true of the run; it is a number
  only when one really did apply everywhere. `parallel` and `chunkSize` keep
  their names, and `speed`, `parallelSource`, `parallelAchieved`, `chunkSource`
  and `studies` are additive.

Also corrected in `dcm send --help`, both stale rather than wrong when written:
`--chunk` claimed memory stays flat, which is true as a study grows but not as
the parallelism grows, since each association holds its own chunk; and
`--transfer-syntax` said the chunk size is "reduced automatically" when it is a
cap on a derived size, and a typed `--chunk` is left alone.

## v0.14.0

`dcm send --speed <normal|fast|very-fast|insane>`, and the reason it is a
preset rather than a nicer name for `--parallel`.

The concurrency a run actually reaches is
`min(--parallel, ceil(instances / --chunk))`. At the default chunk of 200, a
2508-instance CT is 13 chunks, so `--parallel 16` ran 13 wide and reported
nothing about it. That caught this tool's own author, benchmarking a real
transfer to a staging PACS: a measured throughput figure written down against a
concurrency the run never had. Nothing was broken — every instance landed, exit
0 — which is what makes it the bad kind of wrong. A preset that set only the
parallelism would have inherited the trap and handed it to more people, so
`--speed` sets both halves. It picks the association count, then derives a
chunk size that can fill it — about two chunks per worker so nobody idles at the
tail, held between 25 and 200 instances, because under 25 an association costs
more in setup and release than it carries. Where the requested width still
cannot be reached, a warning names both numbers instead of letting the run
imply it got what it asked for.

The presets are 1, 4, 8 and 16 associations. `insane` is documented as a
benchmark setting for a receiver you own, because the ceiling is not ours to
set: the receiver decides how many associations it accepts, and going past that
gets them rejected rather than slowed. A receiver at its limit answers
A-ASSOCIATE-RJ with reason 2, "local limit exceeded", and that is a *transient*
rejection — the chunk is retried, the retry lands in a slot that has since
freed, and the run finishes clean at a width it never ran at. That quiet outcome
is the common one, and it is the first item below. The loud one, a shortfall and
a non-zero exit, is what a *permanent* rejection gives you.

**The rest of this entry is what an adversarial review of the first
implementation found.** The pattern across all six is the same one `--speed`
exists to end — a run reporting better than it was — which is worth recording
rather than quietly fixing, because every one of them passed its own tests.

- **`parallelAchieved` was reduced across studies with `max`.** One wide study
  let a whole run claim the full requested width. Reproduced with 64% of the
  instances moving at width 2 while the JSON said 4 of 4. It is now measured
  from associations the receiver actually **accepted** rather than workers
  dispatched — a receiver at its concurrent-association limit rejects the
  extras, and with a transient rejection the retry lands in a slot that has
  since freed, so the run completes cleanly at a width it never ran at unless
  acceptance is what gets counted — reduced with `min`, and documented as a
  floor. It can read one or two low on a run whose tail drains early. That is
  the direction the error is allowed to point: the throughput figure beside it
  covers the whole run, so the width printed next to it has to be one no part
  of the run fell below. Per-study numbers are in a new `studies` array for
  anything finer.
- **The chunk size was derived from the smallest study and applied to all of
  them.** Chunking and the worker pool are both per study, so one size for the
  run meant the smallest study chose for everybody — and since a small study
  pins the derivation at the 25-instance floor, a 30-instance study took a
  20000-instance neighbour from 100 associations to 800. Seven hundred extra
  connect/negotiate/release cycles, most of the cost paid by the receiver, on
  behalf of a study that gained nothing: 30 instances is one association at 200
  and two at 25, nowhere near the four requested either way. Derivation is now
  per study. An explicit `--chunk` is still one number for the whole run.
- **`Math.min(...instanceCounts)` blew the stack past roughly 125k studies.**
  A spread of that many arguments throws `RangeError`, after the entire scan
  has been paid for. It is reachable only by adding `--speed` to a migration —
  the exact job `fast` is documented for. That code path is gone entirely, not
  guarded: the reduction is a fold now, and it runs over per-study records
  rather than a parallel array.
- **The desktop's speed-test sweep would have labelled each row with the width
  it asked for**, while discarding the engine's stderr shortfall warnings
  whenever the JSON parsed, and then stamped FASTEST across rows measured at
  different real widths. Width now comes from `parallelAchieved` and reads
  `N of M` in amber when short; the warnings reach the console; and the badge
  goes to every row that resolved to the same effective transfer — same
  negotiated syntax, same measured width, same division of instances into
  associations. At 100 instances `fast`, `very-fast` and `insane` all clamp to
  the same chunks and run the same width, and declaring a winner among three
  identical transfers is announcing run-to-run variation as a finding.
- **The desktop manufactured `--speed normal` even when a Parallel value was
  typed**, so someone who never engaged the feature had chunk sizes silently
  re-derived under them. A typed association count now drops `--speed` from the
  command entirely — carrying both would leave the preset sizing chunks for a
  width it was not given — and the chip row goes inert and says why.
- **`report.dryRun` divided every study by one run-wide chunk size**, so
  per-study sizing made its association counts wrong for every study but one.
  It now resolves the size per study through the same function the send loop
  uses. A dry run's association count is a promise, and it has to match what
  runs.

Also in this release: `--parallel` is documented in the README, which it never
was.

## v0.13.4

The suite runs in about 40 seconds instead of about 66, and the reason the
first attempt did not work is worth writing down.

- **`DCM_LINGER` was never reaching the MCP server child.**
  `StdioClientTransport` does not inherit the parent environment: it builds one
  from `getDefaultEnvironment()`, a fixed twelve-key allow-list that cannot
  contain `DCM_LINGER`. So v0.13.3 set it, the test process had it, and the
  `dcm mcp` child — the SCU for every association those tests open — went on
  paying the 1000 ms default. That is why `mcp-mpps.test.js` measured the same
  at 1000 ms and 50 ms, and why it looked "spawn-bound" when it was half
  linger-bound. The seven test files that spawn an MCP client now pass the
  variable through explicitly.
- **`mcp-mpps.test.js`: ~70 s to ~13 s.** One MCP client, one fixture study and
  one shared receiver (with `keepPerformed: true`, so a completed step cannot
  empty another test's worklist) replace 23 server spawns, 11 receivers and 9
  fixture generations. Tests whose subject is the receiver itself — armed with
  a fault, stopped mid-test, or reading back a persist directory that must hold
  exactly one step — keep their own. All 23 tests and every assertion survive.
- **A latent flake found by the sharing, not caused by it.** `dcm mpps start`
  derives the MPPS SOP Instance UID deterministically from study, performed
  step ID, station AE and start time, so three tests opening `SPS001` against
  one receiver collided on `0x0111 Duplicate SOP Instance`. They now use
  distinct *performed* step IDs while keeping the same *scheduled* step, which
  is what really happens — one scheduled step, several performed ones — and
  removes a same-second collision that could have fired at any time.

## v0.13.3

The per-association grace period is now measurable, tunable, and no longer
paid by the test suite.

- **`DCM_LINGER` sets the grace period between the last response and
  A-RELEASE-RQ.** It was already threaded through `resolveTimeouts` as
  `opts.lingerTimeout` and nothing ever set it — no flag, no environment
  variable, no way to reach it.
- **The default stays at 1000 ms, deliberately.** It is a fixed sleep, not a
  settling timeout: dcmjs-dimse implements it as
  `on('done', () => setTimeout(release, linger))`, so a loopback C-ECHO and a
  four-instance C-STORE cost the same ~1020 ms per association. Lowering it
  globally is tempting and was not done. Releasing the moment the last response
  is dispatched is how a client loses a response still in flight, and in this
  tool that is not a slow report — it is a file settled as UNANSWERED and a
  shortfall that never happened. Every measurement available was taken against
  a receiver on the same machine, where that in-flight window is microseconds;
  a slow clinical link is exactly the case the margin exists for and exactly
  the case there is no evidence about.
- **The suite sets it to 50 ms**, through a new `tools/run-tests.js`, because
  none of that reasoning applies to loopback. `test/e2e/worklist.test.js` went
  from 28.0 s to 2.3 s. Accounting was checked rather than assumed: 24
  instances over 6 associations, four runs at each of 1000/200/50/25/0 ms, all
  24/24 acknowledged and exit 0 every time.
- **Not zero.** Measured, `linger: 0` was *slower* than 50 ms — 7.1 s against
  1.5 s over identical work — so releasing instantly provokes something worth
  staying clear of. An explicit `DCM_LINGER` always wins, so
  `DCM_LINGER=1000 npm test` reproduces the real default.
- Measured and worth recording: `mcp-mpps.test.js` is unaffected by the linger
  (57-62 s either way). Its cost is process spawning, not associations, and it
  now bounds the suite. That is the next thing to fix, not this.

## v0.13.2

No behaviour change. The MCP worklist-handle suite went from 58s to 26s by
sharing one server, one receiver and one fixture study across the tests that
only use them as a vehicle, while every test whose subject is an isolated
receiver — the fault-injection ones, and the one proving a handle outlives the
query that made it — keeps its own.

This matters because the v0.13.1 CLI build failed on the macos-x64 runner with
`fail 0` and 78 tests cancelled: nothing was wrong, the slowest of the four
runners simply ran out of room, and a failed build there means the `dcm`
binaries never publish. A re-run passed unchanged, which is the definition of
a landmine rather than a bug.

Measured while doing it, and worth writing down: every DIMSE association in
this tool costs a fixed ~1020 ms regardless of payload, because
`DEFAULT_TIMEOUTS.linger` is a delay before A-RELEASE-RQ rather than a timeout
that settles early. A loopback C-ECHO and a four-instance transfer pay the same
per association. That is a deliberate default — releasing early risks dropping
a response that was still in flight, which would report a shortfall that never
happened — so it has not been changed here, only measured.

## v0.13.1

- **MCP: a worklist row can be handed straight to a procedure step.**
  `dcm_worklist` now returns an opaque handle per row, and
  `dcm_mpps_start` / `dcm_mpps_perform` accept it. An assistant used to
  transcribe up to ten attributes per row — patient, accession, study UID,
  scheduled step id — because the tool it had access to emitted rendered
  values, which are the one form `--from-worklist` refuses. The handle is
  resolved in-process to the attributes exactly as they came off the wire.
  It lives in memory for the life of the MCP server and is written nowhere:
  this tool still keeps no records. An unknown or expired handle says so and
  tells the assistant to re-query rather than guess.
- MCP also gains the flags that landed in v0.13.0 — the `--from-worklist`
  selectors, `--set` on the mpps verbs, and the receiver's fault-injection
  switches on `dcm_receiver_start` — so an assistant-driven rehearsal
  exercises the same paths as the CLI rather than a subset of them.

## v0.13.0

A machine-readable contract, and a receiver that can misbehave on purpose.

**This release also carries the four CLI binaries v0.12.0 failed to publish.**
Twelve MPPS tests read a study from a `fixtures/` directory that `.gitignore`
excludes; it existed on the machine that wrote them, so the suite reported
green, and in CI every one of them failed and took all four build jobs with
them. The tests now generate what they read, and a new guard fails any test
that reaches a directory git does not track — by either spelling, the
`__dirname` climb and the bare `'./fixtures/...'` argument. A suite that reads
state it did not create reports a pass that means nothing.

- **`--json` is a contract now, not a courtesy.** Every command emits exactly
  one envelope on stdout on every terminal path — success, empty, association
  rejected, aborted mid-stream, network failure, usage error — carrying a
  schema version and an explicit outcome discriminator. Before this, a CI job
  could not tell "the peer correctly returned zero" from "the Called AE was
  wrong" from "the association aborted on an over-long value": all three exited
  1, and the only discriminating detail was English prose on stderr that this
  project rewords freely.
- **`dcm echo --json`** now emits that envelope on success and on failure. A
  machine-readable connectivity probe is table stakes for a CI preflight.
- **`--expect-count <n>`, `--expect-empty`, `--expect-nonempty`** on `find`.
  The caller states what it believes and the exit code answers *that* question,
  which is more useful than a code meaning "ran, found nothing, or failed".
  The existing exit-code contract is unchanged: silently changing what `find`
  returns for zero matches would break every script that already exists.
- **`--from-worklist -` reads stdin**, guarded before `path.resolve` so `-`
  can never be taken as a filename and `/dev/stdin` can never be mangled into
  `C:\proc\self\fd\0` on Windows. `--index <n>` (1-based, numbered the way
  the existing error message already prints them) and `--first` select a row
  from a multi-item file; the refusal stays the default, so nothing silently
  picks one for you.
- **`--set <Keyword|(gggg,eeee)>=<Value>` on the `mpps` verbs**, matching the
  `find` half that shipped in v0.12.0. It stamps a value into the outgoing
  N-CREATE or N-SET byte for byte with no validation, and says so loudly every
  time — the explicit "I know what I am doing" path, for testing what a server
  does with a hostile value.
- **`--mpps-uid` works as a flag on `complete` and `discontinue`**, not only
  positionally. It was a flag on `start` and an "Unknown option" on the closing
  verbs, which is a stall in the middle of a demo.
- **`dcm scp` can misbehave on purpose.** `--refuse-nset <status>` with
  `--refuse-nset-scope interim|terminal|all`, `--refuse-ncreate <status>`,
  `--find-status <status>` and `--abort-find-after <n>`. The N-SET scope
  defaults to `interim` rather than `all` on purpose: refusing every N-SET
  refuses the close too, so the run fails for a reason unrelated to the
  behaviour under test. Interim-only is what reproduces the receiver bug this
  project has actually met — and it lets the "a refused interim costs no
  images" case run over a real association instead of a stub.
- **Capture and replay.** `dcm scp --worklist` accepts a `{matches:[...]}`
  envelope, so `dcm find --mwl --json-raw > wl.json && dcm scp --worklist
  wl.json` is now a documented recipe for rebuilding a customer's exact
  worklist offline. The reader tolerates the `_elements` sidecar and any other
  metadata the capture carries.
- **The calling-AE asymmetry is surfaced.** A server can key worklist tenancy
  on the *called* AE while keying MPPS attribution on the *calling* AE, so a
  query with the wrong calling AE succeeds and the step that follows is
  accepted but attributed to nobody. `find --mwl` now warns when a returned
  row's ScheduledStationAETitle differs from `--calling-ae`, and the three AEs
  that decide attribution are echoed into the JSON envelope so CI can assert on
  them. A warning, never a refusal: the mismatch is legitimate when the tool is
  not running on the station.

## v0.12.0

For the team testing an MWL/MPPS server in CI: the messages a receiver is
least likely to have been tested against.

- **`dcm mpps update <mpps-uid>`** — the interim N-SET. A step can now report
  progress and stay open, in both shapes a real modality sends: carrying
  `PerformedProcedureStepStatus = IN PROGRESS`, or with the status attribute
  absent entirely (`--no-status`). `--series-from` grows
  `PerformedSeriesSequence` across successive updates; leaving it off omits
  the sequence, which is the default and must not be read as erasing what the
  step already holds. Attributes PS3.4 F.7.2-1 marks N-CREATE-only — patient
  identity, the scheduled step, `PerformedProcedureStepID`, the station AE,
  start date/time, modality — are refused by name rather than sent.
- **`dcm scp` was refusing that message with `0x0106`**, treating any
  non-terminal status on an N-SET as illegal. That was wrong: F.7.2-1 lets an
  N-SET carry the status and F.8.2 closes only the terminal states. It is also
  the precise behaviour that makes real modalities abandon a session and leave
  a worklist entry uncleared, so our own receiver was modelling the bug it
  exists to help people find. Fixed; a finished step still refuses everything,
  and `0x0110`, `0x0111`, `0x0112` and `0x0120` enforcement is untouched.
- **`--unscheduled`** on `start` and `perform` emits `(0040,0270)` as one
  zero-length item, which is how PS3.3 represents a walk-in exam with no prior
  order. Type 1 descent is suppressed for that shape only — a populated item
  still requires `StudyInstanceUID`. `perform --unscheduled` still takes the
  study UID from the folder for the C-STORE and says so, because those two
  identities differing is the point. **Known limit:** dcmjs reads a
  one-empty-item sequence back as `[]`, so `dcm scp` cannot receive this shape
  and `--unscheduled` cannot be rehearsed against it. The message on the wire
  is correct; verified byte for byte.
- **`--json-raw` is now genuinely raw.** It claimed values exactly as received
  and did not deliver: a `PatientWeight` of `"12.5 kg"` came back as the JSON
  number `12.5`, silently dropping the unit, and over-long or lowercase values
  were repaired on the way past. That produced false passes for anyone using
  this tool to observe what their server actually emitted. Values are now
  carried as received, with an `_elements` sidecar giving `{vr, length}` per
  tag — and `_rawUnavailable` with a reason when the octets could not be
  re-read, because a report that cannot tell "clean" from "not examined" is
  the same false pass in a different coat.
- **`dcm find --check-vr`** reports every VR conformance violation in what the
  peer returned: over-long values against the VR maximum, non-enumerated and
  lowercase CS, DS/IS carrying non-numeric characters, odd-length values,
  embedded backslashes creating unintended VM. One line per violation for a
  human, `vrViolations` in JSON, exit 1 when any are found.
- **`dcm find --set <Key>=<Value>`** stamps a value into the outgoing C-FIND
  identifier byte for byte, bypassing client-side validation, so a server's
  own coercion can be tested with a deliberately hostile value. It announces
  itself loudly whenever it is used — the same framing as
  `--allow-study-mismatch`: the explicit "I know what I am doing" path.
- **Fixed: `complete`/`discontinue --series-from` silently merged multiple
  studies.** A folder holding two studies produced a `PerformedSeriesSequence`
  spanning both, exit 0, no warning — while `perform` correctly refused the
  same folder. Since the sequence feeds an expected-image count, that quietly
  poisoned reconciliation. Both closing verbs now apply `perform`'s guard and
  its wording, and `--study-uid` scopes a legitimately mixed folder.
- **Fixed: the "asserted from disk" caveat never appeared under `--dry-run`**,
  which is exactly when someone is reading the dataset. It was emitted after
  the dry-run return.
- `0x0106` and `0x0120` now translate to English instead of "Unrecognised
  failure" — they are the two codes an MPPS client meets most, and the generic
  wrapper buried the peer's Error Comment, which is usually the explanation.
- MCP gains `dcm_mpps_update`, and `--unscheduled` / `--study-uid` on the
  tools that take them, so an assistant-driven rehearsal exercises the same
  paths as the CLI.

## v0.11.0

One screen for one job.

- **Worklist, Perform a step and Steps this session are now a single
  "Worklist & perform" screen.** Query at the top, the scheduled steps as a
  table, click a row and the action panel opens beneath it: folder, then go.
  The steps you performed show as a badge on the row itself, so there is no
  third screen to visit and nothing to navigate between to finish one task.
- **The prose is gone from the resting state.** Those three screens carried
  860 words of always-on explanation between them, plus 900 more injected at
  runtime; the merged screen shows about 70 at rest. Nothing was deleted — the
  reasoning moved behind small ⓘ marks, one click away. A GUI is not a man
  page, and the explanations were being read once and then endured forever.
- **What must stay loud stayed loud.** The study-UID mismatch still presents
  its two real choices inline, with the flag each one adds, at the moment it
  arises — it is a decision, not a footnote. A shortfall still reports as a
  failure with its numbers. A step that cannot be closed still says so.
- Dry run is a two-state toggle rather than a checkbox with an 18-word label,
  so the posture is legible at a glance. The peer collapses to one line
  (`RISMPPS @ 10.0.0.5:11112 ← CT01`) and expands to edit. The Advanced
  disclosure summarises its own non-default values, so folding it away hides
  nothing.
- The row badge says what **this app** sent, never what the RIS believes, and
  only a fresh query still changes the table. That distinction is the reason
  the badge is allowed to exist at all.

## v0.10.0

Performing a step made simple, and usable with the images you already have.

- **Rehearsing with stock images now works.** A worklist item's Study Instance
  UID is invented by the RIS before the pictures exist, so images you already
  have never carry it, and `mpps perform` refused — correctly, because a step
  naming one study while the images carry another is a pair of records the
  archive can never reconcile. The answer is the one a real modality uses:
  **`--adopt-worklist-identity`** stamps the worklist's study, patient and
  accession onto a re-stamped **copy** and sends that. The folder you chose is
  never modified and the staging path is printed. Series and SOP Instance UIDs
  are left alone — they belong to the equipment, not the order.
  `--allow-study-mismatch` sends untouched for when a mismatch is the thing
  being tested, and the refusal now names both ways forward instead of just
  stopping.
- **The Perform screen is three decisions**: which scheduled step, which folder
  of images, go. The twelve other fields moved behind a closed "Advanced"
  disclosure that summarises any non-default value it holds, so nothing is
  hidden while nothing is in the way. A study-UID mismatch is now a plain
  choice in the app — adopt the worklist identity, or send as-is — rather than
  an engine error.
- **"Steps this session"** lists what the app has performed since it opened:
  status, patient, study, counts. Selecting one that is still IN PROGRESS
  fills its UID into a Complete or Discontinue command, so nobody retypes a
  64-character identifier. It closes the step on the peer it was opened on,
  not whatever the connection panel says now.
- **The tool keeps no records of any kind.** The step-record file
  (`start --out`), `perform --write-acknowledged` and the `--acknowledged`
  input that consumed them are gone, along with `dcm mpps list`. `perform`
  does N-CREATE, C-STORE and N-SET in one process, so the acknowledgement
  ledger never has to survive anything, and the list in the app is session
  memory that says so. This is a deliberate removal of shipped surface: there
  is no local database to go stale, and no file to explain.
- A standalone `complete` therefore has exactly two honest answers to "which
  images?" — name none, or `--series-from <folder>` and say plainly that it
  came from a disk scan rather than from what the archive confirmed. It says
  so in yellow, every time. Three tests guard the removal so it cannot creep
  back.

## v0.9.0

MPPS: the worklist can now be answered, not just read. Plus a CLI that
replaces itself.

- **`dcm mpps`** — Modality Performed Procedure Step, the other half of a
  worklist. A worklist says what is scheduled; MPPS says what happened, and a
  RIS reconciles the two on Study Instance UID to close the order. Verbs:
  `start` (N-CREATE, IN PROGRESS), `complete` / `discontinue` (N-SET), and
  **`perform`**, which is the whole transaction — open the step, send the
  folder, close the step — in one command.
- **A step is only marked COMPLETED when every instance was acknowledged.**
  There is no `--force`. A shortfall marks it DISCONTINUED and exits non-zero,
  saying so in numbers: *"6 of 10 instances were acknowledged. The step was
  marked DISCONTINUED, not COMPLETED, because 4 instances are unaccounted
  for."* This is the same rule the transfer report has always applied, but it
  matters more here: `send` reporting a shortfall is a number on your screen,
  while an MPPS marked COMPLETED is a claim in someone else's database that a
  technologist will believe.
- **PerformedSeriesSequence is built from the ledger, never from a folder.**
  Only instances the peer actually acknowledged are referenced, so the record
  cannot list a SOP Instance UID the archive does not hold. The report prints
  *referenced in MPPS* next to *found* and *acknowledged*, so any gap is on
  screen. `complete --series-from <folder>` exists for the standalone case and
  says plainly, in yellow, that it is asserting what is on your disk rather
  than what the archive confirmed.
- **Type 1 attributes are validated before anything is sent**, naming each
  missing one and the flag that supplies it. Many SCPs accept an N-CREATE with
  an empty Type 1 and then silently fail to reconcile it — success status,
  useless result.
- **A peer that accepts the association but refuses the MPPS presentation
  context is named as such** ("this peer does not support MPPS") in about a
  second, instead of looking like a 60-second timeout.
- **`dcm scp` speaks MPPS too**, so the whole loop is testable locally: it
  accepts N-CREATE/N-SET, enforces the legal status transitions, refuses a
  duplicate step or a missing Type 1 the way a conformant SCP does, and
  correlates a finished step back to the worklist item by Study Instance UID —
  after which that item stops being returned by MWL queries, which is what a
  real RIS does. `--keep-performed` keeps them coming back.
- **`dcm find --mwl --json-raw`** emits worklist matches with values exactly as
  they came off the wire — sequences stay arrays, Person Names stay objects.
  The existing `--json` renders values for reading, which turns a sequence into
  a string and loses precisely the correlation keys MPPS needs. `dcm mpps
  perform --from-worklist <file>` reads the raw form, so a worklist match
  reaches an N-CREATE without anyone retyping a UID.
- **Desktop: a Perform a step (MPPS) screen.** Pick a worklist row, attach the
  images, perform. It shows *what this step will assert* attribute by
  attribute, marks anything the SCP did not return rather than inventing it,
  and writes both peers into the command in full even when they are the same
  system — a default you cannot see is a default nobody can check. It never
  re-colours a worklist row from local state: only a fresh query may change
  that table, and the result is worded as correlation, not proof.
- **MCP: `dcm_mpps_start`, `dcm_mpps_complete`, `dcm_mpps_discontinue`,
  `dcm_mpps_perform`**, with the same rules stated in their descriptions.
- `dcm-cli-agent` was never published to npm, so the release workflow no
  longer pretends: the npm job is gone and the install instructions no longer
  offer a package that does not exist.

### The binary can also replace itself now

- **`dcm update`** — checks GitHub Releases, downloads the build for this
  platform, verifies it against the `SHA256SUMS.txt` published with it, runs it
  once to confirm it reports the version it should, and only then puts it in
  place. The download is written to a temp file in the install directory, so
  the swap is a rename on one volume and a checksum that does not match costs a
  deleted temp file and nothing else — the working binary is untouched until
  the new one has passed every check. There is deliberately no flag to skip the
  checksum: the binaries are not code-signed, so it is the only thing standing
  in for a signature. `--check` reports without changing anything and exits 0
  either way, because it answered the question; `--check --json` gives a script
  `updateAvailable` to read instead of an exit code. `--dry-run`, `--force`,
  `--version <tag>` and `--dir` are there too.
- **Windows self-replacement is handled properly.** A running `.exe` cannot be
  overwritten, but it can be renamed: the old binary is moved aside, the new
  one takes its name, and the rename is deleted on the next update once nothing
  is running it. A leftover `dcm.exe.old-*` is reported on stderr and does not
  change the exit code — it is inert, and training people to ignore exit 1
  would cost more than the file does. If the second rename fails, the first is
  undone immediately, so a failed update can never leave you with no `dcm` on
  your PATH. The downloaded-from-the-internet mark is cleared the way
  `dcm install` already does it, so SmartScreen stays quiet.
- **It refuses where self-replacement is the wrong answer** rather than
  half-doing it: from a source checkout it says `git pull`, and from an
  `npm install -g` copy it says to let npm replace it. `--check` still reports
  in both.
- **Nothing phones home.** A version check happens when you ask for one, never
  on an ordinary invocation. `dcm update --check` in a login script is the
  supported way to be told.
- New `src/lib/version.js` orders versions properly, including prereleases —
  `0.9.0-rc.1` now sorts below `0.9.0` rather than comparing equal to it.

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
