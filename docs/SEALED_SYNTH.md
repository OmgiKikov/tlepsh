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
- The Builder may *ask* and may never *author*. `generate-holdout` is a
  consequential Workbench decision whose entire model-facing surface is
  `{ cases, seed?, mode }` in and `{ corpusId?, cases, generator, promptHash,
  reviewPath? }` out. What must not happen is a Builder that has read the exam,
  and that is a property of what comes back, not of who asked: everything
  deciding what the exam *says* — the judge, the Spec, the example draw, the
  corpus name — is host-owned, and nothing about a case comes back. A model
  cannot name the exam either: every generated corpus gets the same host-fixed
  name, because a chosen one would be a channel travelling with the corpus onto
  every surface that lists one.

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

## Inside the loop

The same capability, from the Builder Pi conversation and from `/holdout`.

**The decision.** `ahde_workbench_decide` with
`{ kind: "generate-holdout", cases (15..200, default 20), seed?, mode, reason }`.
Consequential: it always asks. `cases` starts at 15 because that is
`SEALED_GATE_POLICY.minTasks` — below it the guardrail can only ever say
`underpowered`, so the schema refuses an exam that could not produce a verdict
rather than spending on one. The legal stages run from `corpus-design` (where an
approved Spec first exists) to `candidate-verification` (where a missing exam
finally stops the operator).

Everything else is host-owned: the manifest's judge, the approved Spec the host
reads, the seeded draw of published development cases, and the corpus name —
one name for every generated exam, because a name is the one part of a corpus a
model could choose and it would travel with the corpus onto every surface that
lists one.

**The dialog** is the plan, not the exam. `planSealedSynthesis` runs the same
preflight as the generation that follows it and returns coordinates, counts and
hashes plus a cost from the judge's declared rates; that object *is* the subject
the hash covers, and it is planned again after the dialog and compared, so what
gets asked is what the human approved. Four lines and, on the draft path, a
fifth:

```
Экзамен       20 кейсов · генерирует судья openrouter/anthropic/claude-sonnet-4.5
Источник      описание агента + 5 примеров из тестов (только форма)
              Builder содержимого не увидит; в разговор попадёт только число кейсов
Стоимость     ~$0.12
Черновик      — в файл вне репо; правишь и импортируешь через /holdout
```

**`mode: "review"`** writes the draft into
`<state-root>/projects/<id>/sealed-synth/review-<hash>.jsonl`, 0600. That is
inside the Target directory when the state root is `.ahde/`, which the CLI's
review guard refuses — relaxed by exactly one directory, on the argument that
the sealed corpora themselves already live under the state root: a draft beside
them is no more exposed than the exams it is about to become. Everywhere else
inside the Target stays refused, for the reason it always was.

**`/holdout`** now opens with one question — import a file, generate with the
judge, generate a draft to review — and routes the last two into the decision.
The ship-gate header names the second route only where there is no exam at all;
an underpowered or unavailable one is repaired, not replaced by a guess.

**Provenance.** The passport's data line says
`sealed exam (20 cases, generated by the judge, sealed unreviewed)`, or
`… reviewed by the operator` when the sealed corpus came from a draft somebody
read. The reviewed case is recorded at import — `/holdout`, or the
`ahde corpus import` this document already recommends — because that is the only
moment both facts are in one place. It is read back by corpus id, which the
passport compiler already holds and still does not print. An exam the operator
brought records nothing: its provenance is theirs.

## The Builder's own rule

`builders/ahde/AGENTS.md` carries
it. The short form: when the operator has no real cases to hold out, the Builder
offers the judge once, in one sentence, with both modes in it — «Экзамена нет.
Могу попросить судью сгенерировать 20 закрытых кейсов из описания (я их не
увижу), или сделать черновик тебе на правку — что выбираешь?» — and never
offers it instead of real cases they already have. It still never authors,
reads, edits, or guesses a sealed case. Asking is not reading.
