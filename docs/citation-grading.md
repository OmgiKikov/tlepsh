# Source citation and answer accuracy

Under `ahde-evaluator-v5`, `cites_source` passes only when the final answer names
an exact, case-sensitive chunk ID that exists in the run's saved knowledge base.
For example:

```yaml
graders:
  - type: cites_source
    chunk: tariffs.md#0
```

`Source: tariffs.md#0`, `[tariffs.md#0]`, and `[source](tariffs.md#0)` count.
`tariffs.md#01`, a different directory, and copying the whole source without an
ID do not. A missing run-local chunk fails even if the answer names its ID.
The grader uses the saved workspace, never today's project checkout.

This is a **citation check**. It does not prove that the agent retrieved the
source, that the source supports each claim, or that the answer is correct.
Use `tool_called: kb_search` for an executed search and separate checks for facts,
exact numbers, and final test state. `similarity` measures lexical agreement;
it is not a semantic grounding check either. RAG views keep faithfulness as
`not-measured`. Their historical `groundingPassRate` JSON field contains the
recorded source-check pass rate, not a measurement of claim-level grounding.

## Historical results

Evaluator v4 and earlier accepted a chunk ID **or** token-F1 source overlap.
A real development answer reported the two correct tariff prices without a
source ID and passed with overlap **0.388** against a **0.35** threshold. Under
v5 the same recorded answer fails citation. A correctly cited but wrong price
can still pass citation and must fail its separate accuracy check.

The existing `minOverlap` field remains parseable, including its historical
0.35 default, so old task/spec bytes and hashes are not silently changed. It is
deprecated and has no effect under v5; new authored grader definitions should
omit it. Historical artifacts are never rewritten or relabelled as v5. New RunRecords
carry `eval.evaluatorId`, covered by their member hashes. A v5 index must match
every member; changing only an old index to v5 is refused.

Different evaluator IDs cannot be compared. Historical evidence can be read
and compared to evidence from the same generation in explicit `exploratory`
mode or typed `intent: "inspect"` with the normal candidate identity checks.
These views return an explicit historical-evaluator marker and an inconclusive
current gate; they cannot enter a current candidate/release gate or be reused as a fresh
baseline. Startup observations require the current evaluator too.

`ahde regrade` creates separate v5 records from saved traces/workspaces and
preserves the originals. Deterministic citation regrading makes no model calls;
a suite containing model judges can still call those judges. Regrade both arms
for retrospective comparison. Regraded records are not fresh baseline runs;
current candidate/release decisions require a new measurement.
