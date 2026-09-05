# Command protocol and usage compatibility

Choose the wire version in `execution.command.protocolVersion`. An omitted
version means **v1** for existing descriptors. The shipped Python agent uses
**v2**. The host sends the selected version in every JSONL frame and in
`AHDE_PROTOCOL`; the agent must use that same version throughout the session.
A frame from another version is an infrastructure error, before its contents
can become an answer or a usage measurement.

```yaml
execution:
  kind: command
  command:
    argv: [python3, agent.py]
    protocolVersion: 2
```

Both versions use the existing `hello`, `user`, `tool_result`, `cancel`,
`assistant`, `tool_call`, `tool_note`, `usage`, and `error` frames. Only the
interpretation of usage differs:

| Version | `usage.tokens` | `usage.costUsd` |
| --- | --- | --- |
| v1 | Latest cumulative **session** snapshot replaces the previous tokens. | Incremental charge; reported charges are added, preserving the historical contract. |
| v2 | Increment for **one model request**; all request increments are added. | Increment for that request; if any usage frame omits cost, the session cost is unknown. |

For example, v1 snapshots with token totals **18, then 36** record **36** tokens.
Two v2 requests reporting **18 each** also record **36** tokens. The request that
chooses a tool consumes tokens too: report it before the tool call, then report
the next request before the final assistant frame. A recovery request is another
request, even when its `turn` number is unchanged. Never send the same v2 request
increment twice. No usage frames means unknown usage, not zero.

Usage is an agent report. AHDE verifies the protocol and aggregates the declared
numbers; it does not reconcile them with a provider invoice or infer unreported
model requests.
The Python template forwards a provider's numeric `usage.cost` as `costUsd` only
when it is finite and nonnegative (including a reported zero). Missing, negative,
non-numeric or non-finite prices stay unknown; the template does not invent rates.

## Migrating an adapter

An earlier AHDE change accidentally switched v1 token handling from replacement
to addition without changing the wire version. Existing v1 artifacts therefore
do not establish which interpretation was used. The compatibility rule is now
explicit: v1 preserves the original snapshot behavior, and per-request adapters
must change **both** their manifest version and emitted frame version to v2.
No adapter is automatically reclassified from its numbers.

New command runs attest their version and usage semantics in
`execution.commandProtocol`. Pi fingerprints are unchanged. Historical command
artifacts remain readable and are never rewritten or assigned guessed semantics.
Their unmarked accounting is refused for comparison and baseline reuse, including
comparisons between two historical command artifacts. Rerun the agent to obtain
comparable and reusable evidence. Regrading an old trace cannot reconstruct
missing usage reports.

## Completion and the canonical score

Evaluator v4 records `final_answer` as a host check after the common recovery
attempt. It is a prerequisite, not an extra point in the rubric: a silent run
scores **0**, even if a safety check such as `no_secret` passes. A completed run
is scored using only its declared rubric checks. A wrong answer that merely
exists receives no completion bonus; one passing and one failing rubric check
score **0.5**, not **2/3**.

Comparisons, model selection, watch and training-export thresholds use
`runGraderScore`. This canonical behavior was already introduced with evaluator
v4; the compatibility work adds evaluator-backed regression coverage and removes
the separate trace-display average. Historical runs without host-observed
completion retain their recorded interpretation and cannot be silently regraded
as v4 evidence.
