# Live automatic improvement acceptance — 2026-09-05

AHDE completed two paid synthetic support-agent improvement cycles through the production Workbench. Claude Sonnet 4.6 authored two independent changes, Qwen 3.5 9B executed the Target, the host compared unseen cases, and the synthetic operator selected and released a measured candidate. The Target's answers and the authored diffs were not scripted.

The first attempted cycle failed to gather two hypotheses. The author saw an incomplete resource inventory and spent its bounded turns guessing nonexistent paths. The fix gives it declared data metadata, Target tool contracts and a bounded `workshop_read(".")` inventory. Failed attempts now retain their final tool error, and the result explains why authoring stopped. No additional filesystem, shell, credential or release capability was granted.

## Measured results

Every baseline initially failed 8/8 reviewed cases. The authoring split contained five cases; three other cases, repeated twice, supplied independent validation. Each sealed exam contained 15 cases repeated twice. These are small, synthetic samples.

| Attempt | Author | Selected validation pass rate | Selected score movement | Sealed task pass rate | Pipeline |
|---|---|---|---|---|---|
| Initial, before fix | 12 calls, $0.0933 | — | — | — | Stopped: only one compiled hypothesis |
| Instrumented, before fix | 12 calls, $0.0947 | 0% → 83.3% | +88.9 pp | 21/30 (70%) | Released v0.1.0; next cycle ready |
| With inventory fix | 11 calls, $0.0944 | 0% → 50% | +72.2 pp | 7/30 (23.3%) | Released v0.1.0; next cycle ready |

The closed-loop result is reproducible; a perfect Target is not. Sealed gate `pass` describes the relative non-regression policy, not 100% task correctness. The small Target still omits citations and occasionally retrieves poorly or invents unsupported details. The variation above is deliberately retained instead of selecting only the best run.

The corrected follow-up driver resumed from the exact released revision after using an evaluation summary where a full EvalRun was needed. No agent code or release evidence was manually repaired.

- An actual failing model transcript was imported as a synthetic incident, with its original revision kept as a source claim and the current revision bound by the host. After a Workbench restart, `/test` published and ran all nine cases: 7 passed, the imported regression still failed, and one answer hit the pilot's 400-token output limit. The error was recorded, not counted as a successful answer.
- A separate probe changed refund/delivery/warranty values from 30/4/18 to 45/6/24. Released instructions stayed byte-identical. All six answers used the new numbers and called retrieval; 5/6 passed all checks, with one missing citation.
- Author contexts were checked for sealed markers and held-out task ids. Neither reached the author.
- Search left the operator checkout unchanged. Selection, verification, review, promotion, adoption and continuation used ordinary Workbench decisions; the test driver supplied explicit synthetic-operator approvals.
- A separate integration test imports, publishes and executes a regression when the workspace id differs from the Target id. Ownership, content hashes and source revision remain bound independently.

Across the three attempts and follow-up there were 259 recorded Target executions. Reported model cost was about $0.3132 including author requests; all recorded costs were known. This is provider-reported usage, not a billing reconciliation.

## Verification

- `npm run check`: 139 files, 2,238 tests passed, 3 Docker-dependent tests skipped.
- `npm run verify:package`: pack, clean installation, initialization, validation, Builder startup, sandboxed tool execution, container argument/matrix checks, Evidence HTTP, authenticated serve API and canonical promotion passed.
- Interactive first run in an empty isolated home showed the Russian model-connection prompt and exited cleanly.
- `git diff --check` and the live driver's syntax check passed.

## Reproduce

```bash
npm run acceptance:live -- --live
```

Requires the configured OpenRouter key and explicitly enables paid calls. The host driver uses synthetic conversations, an isolated repository, a $2 author request ceiling and a 15-minute run timeout. `npm run acceptance:pilot` uses local scripted models and no paid provider.

To run only the post-release probes for a preserved pilot:

```bash
node scripts/pilot-live.mjs --live --after-release .ahde/live-pilots/support-<id>
```

Local evidence from this session is preserved under `.ahde/live-pilots/`: `support-wM3AKS`, `support-n3mokq`, `support-7gDcCh`. Each contains `results.json`, the exact Target repository and immutable run artifacts. These synthetic artifacts are intentionally outside the published package.
