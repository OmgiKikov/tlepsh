# V1.3 — RunEvent and live Builder progress

V1.3 adds live observation without creating a second evidence system.

```text
Target Pi session
  → Runner normalizes bounded RunEvent
  → Eval adds ordering and grading
  → development-only Workbench listener
      → Builder Pi status/widget
      → bounded in-memory live feed
          → loopback Evidence Explorer SSE
      → direct CLI counters

final session.jsonl + run.json + eval_run.json
  → diagnosis
  → read-only Evidence Explorer
```

## Interface

`src/run-events.ts` owns one optional synchronous listener. Its event union
covers run start, complete assistant messages, tool start/end, execution end,
and grading. Every event carries an exact run identity plus one-based
`ordinal/total` for `tasks × repetitions`.

Assistant and tool payloads are serialized deterministically, credential
redacted, and capped at 4,096 characters. Errors are capped at 2,000
characters; tool names and call ids at 200. Assistant text is emitted only
from the complete `message_end`, never token-by-token, so a credential split
across provider deltas cannot evade redaction. Thinking, user/system messages,
provider payloads, session paths, and arbitrary tool details are excluded.

The listener is observational: synchronous throws and accidentally rejected
promises are swallowed. It runs only after the corresponding durable write:

```text
run.json(status=running)       → run_started
run.json(final execution)      → execution_finished
run.json(final grading)        → run_graded
```

No event participates in grading, diagnosis, proposal provenance, comparison,
candidate review, or promotion.

## Two-Pi security

Development events cross the Workbench seam only as a host-owned execution
hook. The hook is not present in model-facing TypeBox/Zod inputs and is never
persisted. Candidate evaluation forwards it to the development baseline and
candidate pair only. The sealed matched pair is invoked without a listener,
so sealed data is excluded structurally rather than filtered afterward.

Natural-language `ahde_workbench_decide` runs and `/run` both project events to
one local Pi widget and, while Builder is running, one capability-scoped live
web view. The random live URL and partial Target text are host UI only: neither
is sent through the tool update callback or returned in the model-facing tool
result. The widget is bounded to 40 physical lines and 32 KiB and is cleared in
`finally` on success, error, abort, or UI failure.

## Ephemeral live web, canonical final evidence

RunEvents are in-process and restart-ephemeral. AHDE does not write
`events.jsonl` or scan mutable run directories. The long-lived Builder process
fans already-redacted events into a bounded memory-only ring and exposes it
through the existing loopback Evidence Explorer:

```text
GET  /live/<random capability>             static HTML shell
GET  /api/live/<random capability>/events SSE RunEvents
HEAD                                      headers only
POST/PUT/PATCH/DELETE                     405
```

The feed retains at most four views, 256 frames and 512 KiB per view, and four
viewers per view. The browser keeps at most 300 rendered rows and 512 KiB of
rendered event text. Completed views expire after 15 minutes, and Builder
repeats the URL in a host-only notification on success, error, or abort. SSE
replay honors socket backpressure; a client whose bounded pending queue still
overflows reconnects from the retained sequence. An explicit gap marker appears
if either the server ring or browser view omitted older provisional frames. A
bind, capacity, listener, browser, or disconnect failure cannot change the
evaluation.

The server binds to `127.0.0.1`, validates `Host` and cross-origin requests,
uses an unguessable 192-bit path capability, exposes no live index, emits no
CORS permission, and serves a same-origin CSP. Target text reaches the DOM only
through `textContent`. The live page shows only a provisional EvalRun id, never
a premature link to not-yet-diagnosed canonical evidence. Candidate
verification attaches the feed to the development pair only; the sealed pair
still receives no listener at all.

Standalone `ahde evidence` remains final-only because another process cannot
observe in-memory events without IPC or a second journal. Direct `ahde run`
keeps its stderr counters and does not create a URL that would disappear as
soon as the command exits.

Raw `session.jsonl` remains the single protected trace artifact. The live view
is marked provisional and cannot justify diagnosis, a Proposal, comparison,
candidate review, or promotion. After a run is final and diagnosed, `/traces`
opens the loopback-only, read-only, hash-verified report from canonical
artifacts.

This preserves the core rule: live output helps the human understand progress,
but only immutable verified artifacts can justify a harness change or a
promotion decision.
