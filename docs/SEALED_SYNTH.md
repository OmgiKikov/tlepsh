# Host-side sealed synthetic generation

Roadmap wave 2, item 11. One command:

```
ahde corpus synth --target <dir> [--project <id>] --sealed <N> --name "<exam name>"
                  [--seed <s>] [--from <spec.md>] [--examples <K>] [--review <path>]
```

A sealed holdout is the only measurement in AHDE that nobody in the improvement
loop has read. Importing one is the honest path whenever real cases exist. When
they do not — a new agent, a Spec and nothing else — the alternative has been to
develop against everything you have and promote on a guardrail that can only say
`underpowered`. This command writes the exam instead, without letting any agent
in the loop see it.

## Why the generator is the judge model, and not the Builder

The Builder is the one model that must never write this. It reads failure
modes, authors the harness, and proposes the change the exam then judges. A
Builder that wrote the holdout has read the holdout, and everything measured
against it afterwards is an echo — the same argument `configure-evaluators`
already makes one step earlier when it refuses a judge equal to the Target's own
model (invariant 40, `sameModelAsTarget`).

The judge is the model that is already outside the Target's trust domain, whose
output already never re-enters a Builder context, and whose fingerprint already
travels on `provenanceAxes` as a declared evaluation input (invariant 38). Using
it here adds no new trust: the same model that decides whether an answer passed
also wrote the question, and both facts are recorded in the same place.

Consequences, enforced:

- **No judge configured → refused, exit 2**, with the `next:` line pointing at
  the reviewed evaluator setup. There is no fallback to the Target model, the
  Builder model, or "any configured endpoint".
- **Judge equal to the Target model → refused, exit 2.** A model writing its own
  exam grades itself twice.
- The refusal happens before the endpoint is called, so a misconfigured Target
  spends nothing.
- This is a host command, not a Builder tool. There is no
  `ahde_workbench_submit` or `ahde_workbench_decide` shape for it, deliberately:
  the model in the conversation must not be able to ask for a holdout, and the
  operator's shell is the only surface that can.

## What is recorded, and what is not

Every run writes one immutable receipt to
`<state-root>/projects/<id>/sealed-synth/<content-hash>.json`, mode 0600:

| Field | What it is |
|---|---|
| `generator`, `generatorHash` | the exact judge model fingerprint (provider, id, api, baseUrl, `apiKeyEnv` **name**, thinking level, params, spec) |
| `promptSha256` | sha256 of `{ system, user }` — the exact question asked |
| `specSha256`, `specSource`, `specId` | the Spec text's hash, where it came from, and the approved snapshot id when it came from one |
| `developmentExampleIds` | the ids of the K development cases shown as format examples — development cases, which the Builder may already read |
| `requested`, `seed`, `accepted`, `droppedMalformed`, `droppedDuplicate` | what was asked for and what survived validation |
| `outcome` | `{ kind: "sealed", corpusId, corpusHash, taskCount }` or `{ kind: "review", reviewPath, caseCount }` |
| `targetId`, `projectId`, `corpusName`, `at` | which Target, which project, under what name, when |

What is **not** recorded, anywhere outside the sealed corpus itself:

- No case input, expected answer, grader, or fragment of one.
- No credential value — only the environment variable's name, as everywhere
  else in AHDE.
- Not even a length or a per-case hash: a per-case digest is a membership
  oracle, and a holdout that can be tested for membership is not sealed.

**The raw generator exchange is deleted.** Every evaluator call writes the exact
request and response to a sidecar before anything is parsed, and this one is no
exception — but it lands in a private `sealed-synth/exchanges/<prefix>/`
directory that the command removes as soon as the cases have a home. A second
copy of a holdout beside its own receipt is one more thing that could be
projected by mistake. A run that produced **nothing** keeps its exchange,
because then there is no holdout to protect and a failure with no evidence is
unfixable.

**Printed output is four lines and no case:**

```
corpus        corpus-<64 hex>
cases         40
generator     <provider>/<judge-id>
prompt        sha256:<64 hex>
```

Counts, the receipt path, and the sealed guardrail warning go to stderr.
`renderSealedSynthOutput` is a pure function of the result, so the whole visible
surface of the command is one testable object — and it is the only place a case
could ever be printed, which is exactly why it cannot.

## What the generator is given, and what comes back

The prompt carries three things and nothing else:

1. **The Spec.** `--from <file>`, else `spec.md` in the Target, else the
   project's newest approved Spec snapshot rendered back to markdown. None of
   the three: refused, with the `next:` naming all three.
2. **K development cases as format examples** (`--examples K`, default 5, `0`
   allowed). Drawn deterministically from the dataset hash, the seed and the
   case id, so the same `--seed` over the same development suite always shows
   the same examples and a different seed asks a different question of the same
   Spec. Their ids are stripped: an example is a shape, never a subject.
3. **The development suite's grader shapes**, canonicalized and deduplicated, so
   the generator uses graders that exist rather than inventing types.

The answer must be one JSON object `{"cases": [...]}`. Then, host-side:

- Each case is validated against `CorpusTaskSchema` plus the dialogue
  invariant. Malformed cases are **dropped and counted**, never repaired.
- **Ids are derived by AHDE**, not taken from the generator:
  `synth-<sha256(specHash + normalized input)[0:24]>`. A model-chosen `id` is
  discarded on sight, exactly as a corpus import discards caller-owned ids
  (invariant 27).
- **Novelty is enforced by normalized input** (NFKC, lower-cased, whitespace
  collapsed) against **every** development case — not only the K shown — and
  against everything already accepted in this run. Duplicates are dropped and
  counted.
- Below `SEALED_GATE_POLICY.minTasks` (15) surviving cases, the command prints
  the same guardrail warning `ahde corpus ingest` and `ahde corpus import`
  print: an exam that small can only ever produce `underpowered`.

## The two paths

**Seal now (default).** The surviving cases go straight through
`createCorpus(..., visibility: "sealed")` — the same immutable, content-addressed,
0600 corpus every other sealed holdout is. Nothing intermediate is written where
a human or a model could read it, because nothing needs to be: the operator
asked for an exam they explicitly do not want to see.

**Edit and seal (`--review <path>`).** The cases are written to one
operator-owned JSONL file, mode 0600, and nothing is sealed. The operator reads
it, deletes what is wrong, rewrites what is close, and seals it themselves:

```
ahde corpus import --project <id> --visibility sealed --name "<exam name>" --file <path>
```

This is the "human edits and seals" path, and it is the honest default for a
first exam: a generated case that is subtly wrong is worse than no case, and the
only cure is somebody reading it. The cost is real and stated plainly — whoever
reads that file has read the holdout, and it is no longer sealed *from them*.
That is a decision an operator may take about their own exam; it is not one the
Builder can take about it.

Two refusals protect the file:

- **A path inside the Target tree is refused.** A Harness snapshot copies the
  Target; an exam sitting inside it would ride into every run's workspace.
- **An existing path is refused.** A second `synth` must never overwrite the
  edits somebody already made.

## Boundaries

- `--sealed N`: 1..200. `--examples K`: 0..20.
- `--project` defaults to the Target's manifest id: the command already reads
  the manifest to find the judge.
- A Spec file over 64 KiB, or a generator response over 2 MiB, is refused.
- Parse and validation failures never quote the model's text. An exam that leaks
  through a stack trace is not sealed.
- Nothing here promotes, adopts, publishes a development corpus, or approves a
  Spec. It creates one sealed corpus (or one file) and one receipt.

## Skill paragraph

Proposed addition for the Builder skill that owns corpus design. This repo keeps
its Builder skills at `builders/ahde/skills/design-evals/SKILL.md` (there is no
`skills/ahde/SKILL.md`); the paragraph belongs after step 6, "Keep development
and sealed holdout corpora distinct." It is written here and **not** applied —
editing `skills/**` is out of scope for this change.

> 6b. When the operator has no real cases to hold out and asks for a sealed exam
> anyway, do not write one. There is no Builder surface for authoring sealed
> content and there will not be: a model that writes the holdout has read the
> holdout, and every later verdict on it is an echo of your own guess. Tell them
> the host can write it with the Target's configured judge model — the same
> model that grades an answer, already outside your context — by running
> `ahde corpus synth --target . --sealed <N> --name "<exam name>"` in their own
> terminal. It needs `evalSuite.judge` configured (`kind: configure-evaluators`
> if it is not) and a Spec: `--from <file>`, `spec.md` in the Target, or the
> approved Spec you already helped them write. Recommend `--review <path>` for a
> first exam so they read and edit the cases before sealing them, and recommend
> at least 15 cases, below which the sealed guardrail can only say
> `underpowered`. You will see the corpus id, the case count, the generator
> model and the prompt hash — never a case, and never ask for one.
