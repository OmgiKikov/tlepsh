# V1.3 — RunEvent and live Builder progress

V1.3 adds live observation without creating a second evidence system.

```text
Target Pi session
  → Runner normalizes bounded RunEvent
  → Eval adds ordering and grading
  → development-only Workbench listener
      → Builder Pi status/widget
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
one local Pi widget. Partial Target text is not sent through the tool update
callback and therefore never enters Builder model context. The widget is
bounded to 40 physical lines and 32 KiB and is cleared in `finally` on success,
error, abort, or UI failure.

## Canonical tracing remains final-only

RunEvents are in-process and restart-ephemeral. AHDE does not write
`events.jsonl`, expose live HTTP/SSE, or scan mutable run directories. Raw
`session.jsonl` remains the single protected trace artifact. After a run is
final and diagnosed, `/traces` opens the existing loopback-only, read-only,
hash-verified Evidence Explorer.

This preserves the core rule: live output helps the human understand progress,
but only immutable verified artifacts can justify a harness change or a
promotion decision.
