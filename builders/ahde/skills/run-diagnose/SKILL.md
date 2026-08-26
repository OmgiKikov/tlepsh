---
name: run-diagnose
description: Inspect evaluation results, generate deterministic diagnosis, and connect claims to exact evidence.
---

# Run and diagnose

1. For a new measurement, call `ahde_eval_run_development` with the exact
   published development corpus (or the manifest suite) and repetition count.
   The host confirms the cost/evaluation subject before execution.
2. Use `ahde_eval_list` to select existing immutable evidence; never invent a
   run id.
3. Use `ahde_eval_get` for the score, provenance, dataset hash, and execution
   status. Infrastructure errors make the result inconclusive.
4. Use `ahde_eval_diagnose` to derive failure families from verified run
   records. Do not infer a harness flaw from a single anecdote when repeated
   evidence exists.
5. Report pass/total, error count, largest failure families, confidence, and
   the next decision the evidence supports.
6. Use `ahde_evidence_link` when the operator wants to inspect traces. Keep
   large raw traces out of chat.

Never use sealed holdout evidence to author a remediation proposal.
