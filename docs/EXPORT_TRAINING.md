# `ahde export --training`

## Purpose

AHDE optimizes a harness around a fixed model. The next step — training a small
model *under* that optimized harness — needs the conversations the harness
already produced, in the shape a tuning run reads. This command is that door,
and nothing else: a pure read over durable development evidence. No model call,
no Target execution, no state change; the only thing written is one JSONL file.

```
ahde export --training --target <dir> [--project <id>]
            (--eval <erun-id> | --all)
            [--out <path.jsonl>] [--min-score <0..1>] [--include-failed] [--include-aa]
```

`--eval` exports one exact eval run; `--all` exports every compatible one in the
runs root. `--out` defaults to `<runs-root>/exports/training-<timestamp>.jsonl`.
The summary prints runs scanned, exported, and skipped by reason. Exit 2 means
the named evidence is missing or not exportable — a training corpus that was
silently short is exactly the failure a later training run cannot detect.

## What it never contains

**Sealed holdout anything.** Visibility is decided by `isSealedEvalRun` on the
bounded EvalRun index — the same check `report` and `diagnose` use — *before* a
single member run, trace, or workspace snapshot is opened, and again on the
verified record afterwards. `--project` additionally supplies the project's
sealed corpus content hashes, so a legacy eval run that predates explicit
visibility is refused too. Naming a sealed eval run with `--eval` is a refusal,
not an empty file.

**Anything that is not evidence.** A cheap-check screen (`purpose: "screen"`) is
refused from the record itself, with the `runs/screens/` marker as a fail-closed
second check; so is a legacy one-arm record whose purpose cannot be
reconstructed. A/A calibration arms are excluded unless `--include-aa`, because
they measure run-to-run noise rather than behaviour — and a candidate arm whose
baseline index cannot be read is excluded with them, since nothing proves the
two revisions differ. Ordinary candidate arms *are* included: they are ordinary
development evidence.

**Infrastructure failures.** An errored run, a run with no recorded trace, and a
run whose model-visible workspace snapshot is gone are inconclusive evidence,
never behavioural examples. They are counted under `infra`, never exported.

**Credentials.** Every string — instructions, user turns, assistant text, tool
names, tool-call arguments, tool results, model id, grader types — passes
`redactTraceText`, the same sanitizer reports use.

**The current checkout.** The system message is the Target's effective
instructions *as that run saw them*, read from `<runs-root>/<runId>/workspace/`.
The operator's working tree is never consulted. Labelling a conversation with
instructions the agent never received would be a lie about the harness.

## The shape

One JSONL line per exported run:

```json
{
  "messages": [
    { "role": "system",    "content": "<the AGENTS.md that run saw>" },
    { "role": "user",      "content": "Проверь договор 42." },
    { "role": "assistant",
      "tool_calls": [ { "id": "call_1", "type": "function",
                        "function": { "name": "lookup", "arguments": "{\"number\":\"42\"}" } } ],
      "content": "Сейчас посмотрю договор." },
    { "role": "tool", "name": "lookup", "tool_call_id": "call_1", "content": "contract 42: active" },
    { "role": "assistant", "content": "Договор 42 действует." }
  ],
  "tools": [
    { "type": "function", "function": { "name": "bash", "description": "Built-in Target capability declared by the harness (execution.tools). …" } },
    { "type": "function", "function": { "name": "lookup", "description": "Look up a contract by its number.",
                                        "parameters": { "type": "object", "properties": { "number": { "type": "string" } }, "required": ["number"] } } }
  ],
  "meta": {
    "taskId": "task_001", "runId": "run_dev_1", "evalRunId": "erun_dev",
    "targetSha": "aaaa…", "workspaceHash": "sha256:…", "model": "qwen3.5-27b",
    "graders": [ { "type": "output_contains", "passed": true, "score": 1 } ],
    "score": 1, "passed": true, "repetition": 0
  }
}
```

Notes on the shape:

- **Messages are never dropped.** Oversized content is truncated in place and
  carries `…[truncated by ahde export --training]`; the turn itself stays, because a
  training example missing a turn is a different conversation. An assistant turn
  that only called tools has `tool_calls` and no `content`; one that only spoke
  has `content` and no `tool_calls`. The whole line is bounded by the canonical
  8 MB / 25 000-record trace-artifact limit that `trace.ts` enforces on read.
  A truncated `arguments` string is no longer parseable JSON, by design: the
  export never rewrites what the agent actually sent.
- **Thinking blocks are not exported.** They are in the trace, they are not in
  this shape, and adding them is a separate decision.
- **`tools` carries two kinds and invents neither.** A declared subprocess tool
  contributes the exact JSON Schema its `tool.yaml` declared. A built-in
  capability (`execution.tools`, as that run recorded it) contributes its name
  and a description saying the schema is host-owned — no `parameters` key is
  fabricated for it. Built-ins first, then declared tools, each sorted by name.
- **`score` is the mean grader score in [0,1]**, clamped, with a graderless run
  keeping its binary outcome. It is the same `runGraderScore` the comparison gate
  pairs per task, so "how well it scored" means one number everywhere.
- **`passed` is `score >= --min-score`** — the label of this example under the
  bar this export was run with, which at the default `1.0` coincides with the
  run's recorded grader outcome.
- **`taskId` is the public projection** (`publicTaskId`), so a task id that
  itself carried a credential shape cannot ride out in metadata.

## Skill paragraph

Proposed addition for the AHDE Builder skill (the task names
`skills/ahde/SKILL.md`; in this repository the packaged Builder skills live under
`builders/ahde/skills/`). Not applied here — `skills/**` is out of scope for this
change:

> **Exporting training data.** When the operator asks for the agent's own
> conversations as training data — "выгрузи данные для дообучения", "export the
> traces for fine-tuning", "training set" — the command is
> `ahde export --training --target <dir> --all`, run outside the conversation.
> It is a pure read: no model call, nothing promoted, nothing changed. Say what
> it will and will not contain before running it. It exports development
> evidence only, one JSONL line per passing run, with the system message taken
> from the exact workspace snapshot that run executed against. It never exports
> sealed holdout evidence, cheap-check screens, A/A calibration arms, or
> infrastructure errors, and every string is credential-redacted. `--min-score`
> lowers the bar from "every grader satisfied"; `--include-failed` adds the runs
> below it marked `"passed": false`, which is what preference or contrastive
> data needs. Never offer to widen the export past the sealed boundary: a
> holdout that reached a training set has stopped being a holdout.
