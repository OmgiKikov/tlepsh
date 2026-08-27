---
name: run-diagnose
description: Inspect evaluation results, generate deterministic diagnosis, and connect claims to exact evidence.
---

# Run and diagnose

1. Inspect `ahde_workbench_view`; run only when its legal actions contain
   `run`. Use `/run [repetitions]` or request `run-current` through
   `ahde_workbench_decide`. The host confirms the exact cost and subject.
2. Workbench binds the approved Spec, reviewed development corpus, exact Target
   revision, dataset hash, and suite hash. Select among ambiguous artifacts
   explicitly with `ahde_workbench_submit`; never invent an id.
3. Use `/traces` or `ahde_workbench_view` with `aspect: traces` for score,
   provenance, deterministic diagnosis, and the read-only evidence link.
   Infrastructure errors make the result inconclusive and do not advance the
   Workbench stage.
4. Do not infer a harness flaw from a single anecdote when repeated evidence
   exists.
5. Report pass/total, error count, largest failure families, confidence, and
   the next decision the evidence supports.
6. Keep large raw traces out of chat; offer the loopback Evidence Explorer link
   returned by the traces view.

Never use sealed holdout evidence to author a remediation proposal.
