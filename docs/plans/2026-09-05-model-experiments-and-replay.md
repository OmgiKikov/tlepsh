# Model experiments and behavior replay

The request was to choose and implement worthwhile product ideas from the code,
without delegating the product choices back to the operator.

## Why these changes

The existing improvement loop already authors several hypotheses, screens them,
compares candidates and waits for a human release decision. Another wrapper
around that loop would add little new capability. The missing intervention was
the Target model itself: the ordinary comparison correctly refuses model changes,
and the original model setup only configures a new agent.

AHDE now has a separate model experiment. The user can ask for lower cost or
latency; the host compares the current Pi model and up to two catalog alternatives
on the same reviewed development cases. The operator chooses the execution limit
and score-loss tolerance before the experiment. Private snapshots and a distinct
run purpose keep this research out of ordinary baseline and promotion discovery.

An accepted alternative produces one reviewed manifest change. Branch, commit,
manifest bytes, model metadata, corpus and experiment identity are rechecked.
The next normal evaluation creates a baseline for the changed configuration.
The experiment itself never creates a release.

The supporting evidence work makes observed changes inspectable: independent
before/after transcript steps, the same case and repetition, actual tool results,
final checks, a verified proposal diff and links retaining exact positions.
The Builder can read a selected development or model-experiment run through a
bounded typed view, with hidden reasoning excluded.

## Boundaries that matter

- Model alternatives come from the host catalog; credentials and endpoint
  metadata are resolved by the host. The Builder sees identities and measurements.
- The fixed harness, graders, cases and prepared tool bytes must match across
  model arms. Model changes are explicitly permitted only in this experiment.
- Recommendations need at least 15 cases, two repetitions, complete evidence and
  a paired interval within the predeclared tolerance. Selection remains exploratory;
  intervals are not corrected for choosing among alternatives.
- Target costs use recorded tariff estimates. Missing prices stay unknown; judge
  and simulated-user overhead is identified separately when used. An execution
  limit is not a hard USD cap. Observed latency can depend on provider conditions.
- Stop and failure retain available artifacts, without successful completion
  labels. A confirmed plan cannot be reused to spend again in another store.
- Model acceptance checks the actual branch update inside Git's prepared ref
  transaction. A concurrent checkout cannot advance an unapproved branch; a late
  failure can still leave index/worktree changes, so the pending receipt is kept
  for inspection rather than promising an automatic rollback.
- Read paths check public purpose and exact ownership before opening member runs.
  Replay never reconstructs intermediate world state or claims a causal explanation.

## Verification

`npm run demo:models` uses three local scripted models and fictitious tariffs. It
runs 90 actual Pi executions, rejects the cheaper option that regresses on six
cases, reads one erroneous dialogue, accepts the measured alternative and runs
15 ordinary baseline cases. The active checkout stays unchanged until acceptance;
only `manifest.yaml` changes afterward. This verifies the mechanism, not real
model quality or market prices.

Focused tests cover budget and consent replay, stale branch/files, catalog and
credential ownership, private evidence integrity, model-specific run isolation,
tool setup consistency, partial results, exact acceptance and bounded trace reads.
Replay was also exercised in Chromium at desktop and mobile sizes: independent
steps, autoplay, Escape, search, exact URLs, reload and overflow checks.

Repository verification: both TypeScript checks and all 149 test files passed
(2,383 tests passed; three Docker tests deferred to Linux CI). `verify:package`
passed its pack, clean local/global install, startup, sandbox, HTTP and promotion
checks. Browser replay checks passed at desktop and mobile sizes.
The subsequent Git 2.39 compatibility fixture passed with all 21 focused model
experiment tests and both TypeScript checks. Both scripted demos completed:
the existing proposal-to-release cycle and the 105-execution model-selection flow.
