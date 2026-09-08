# Generated basket: architecture review

2026-09-07. Read-only review of the current working tree, including its uncommitted first-build changes. No implementation or test run is claimed by this report.

Applied `improve-codebase-architecture`, its HTML report reference, and `codebase-design` / `DEEPENING.md`. The requested parallel-review/merged-plan format replaces the skill's interactive candidate selection and separate HTML browser report. No `CONTEXT.md` or `docs/adr/` exists; `docs/INVARIANTS_V1.md` supplies the existing domain decisions.

## Recommendation

**Strong: deepen the existing Corpus Draft module. Pi Builder already generates cases; AHDE already owns revision, review, publication and baseline.** The missing product is a reliable authoring brief and legible review, not a second generator implementation.

Before:

```text
Operator: no basket
  → Pi reconstructs an authoring procedure from scattered instructions
  → target index/resources (KB content unavailable)
  → corpus-draft {tasks, coverageNotes}
  → review cards (source/reason buried in arbitrary metadata)
  → corpus-revision → run-current → baseline
```

After:

```text
Operator: generate tests for this agent
  → Pi reads approved Spec + declared Target resources + bounded KB passages
  → corpus-draft: small explained cases; unknown rules remain questions
  → same review cards: why, expected behaviour, source, checks, world/dialogue
  → operator edits in conversation → corpus-revision
  → “test it” → existing run-current exact review/publication/baseline
```

One interface gives leverage to imported, handwritten and generated cases. The seam stays at Workbench `submit`/`decide`, and locality stays in existing draft validation and case rendering. No new adapter is justified: the existing Pi adapter is already the author, and Workbench dependency injection already supports deterministic acceptance tests.

## What already works and must be reused

| Existing module | Established responsibility | Evidence |
| --- | --- | --- |
| Approved Spec | Immutable purpose, jobs, success criteria, constraints and open questions | `src/spec.ts:17`, `ApprovedSpecReferenceSchema` |
| Exact Target context | Clean Git identity, declared instructions/skills/tools/harness files, bounded reads | `src/application/target-authoring-context.ts:643` |
| Corpus Draft | Explicit graders, task size/count bounds, host-derived content IDs, duplicate refusal, immutable revisions | `src/application/builder-corpus-draft.ts:54`, `:433` |
| Draft submission | Resolves actual approved Spec and checks runnable graders | `src/workbench/workbench.ts:3080` |
| Draft revision | Add/replace/remove cases, edit graders, preserve world/dialogue/metadata | `src/application/builder-corpus-draft.ts:473` |
| Human review | Draft, dataset preview and recorded world cases share the same case cards | `src/builder/render/view.ts:597`, `:1173`, `:1247` |
| Publication | Exact reviewed draft/Spec/task hashes, human receipt, stale decision check | `src/workbench/decisions/corpus.ts:43`, `src/workbench/corpus-publication.ts` |
| Baseline | `run-current` resolves the already-existing start-testing/run-eval/verify-candidate paths | `src/workbench/decisions/run-current.ts:47` |
| Dialogue/world | Input + frozen messages OR simulated user; explicit world state and expectations | `src/manifest.ts:300`, `:415` |
| KB retrieval | Existing bounded chunking and BM25; only `data/kb` activates native retrieval | `src/domain/kb.ts`, `src/target/kb-tool.ts` |

These modules pass the deletion test: removing them redistributes proven invariants across callers. A proposed `BasketGenerator`, generic generation jobs, generation backend registry or parallel lifecycle would fail the deletion test: deleting those additions leaves Pi plus Corpus Draft able to do the work.

## Actual gaps

1. **No explicit “I have no basket” authoring contract.** Builder instructions say “Write the tests” (`builders/ahde/AGENTS.md:242`) but do not establish a consistent coverage set, explain each expected result, or make unavailable business rules visible before a run. `next-actions.ts:114` only says “write the first Spec-bound cases”.
2. **KB content is inaccessible to Builder.** Target context `data` lists counts and at most 32 names; `resourcePath` rejects every data file (`target-authoring-context.ts:825–852`). Source code is readable, but source code and actual Target replies cannot establish business truth. For a RAG basket the declared knowledge documents are a real input, not speculative scope.
3. **Review has the execution facts but lacks the reason for the case.** `datasetCasePreview` already carries metadata, expected, graders, world and dialogue; `worldCardLines` shows arbitrary metadata only for non-world cases and truncates it into tiny key=value fragments. Source and rationale should be first-class readable lines in this same rendering implementation.
4. **A worlded case can hide its reference expectation on screen.** Its card's “must” uses graders and `world.expect`, but not `sample.expected`. Generated cases must show the actual expected behaviour for both worlded and plain cases, independent of a terse grader label.

## Smallest implementation plan

### 1. Make the current Pi authoring path explicit

Files: `builders/ahde/AGENTS.md`, `src/builder/workbench-adapter.ts`, `src/workbench/next-actions.ts`, corresponding existing copy in `src/i18n.ts`.

- “No basket / generate tests” means read the approved Spec and declared resources, then submit `corpus-draft`. Do not execute Target to discover correct answers.
- Start with roughly 8–12 readable cases unless the user specifies a count. Select relevant ordinary requests, ambiguity/clarification, denied or unsupported actions, missing knowledge, and tool failure/recovery. Do not fill a quota with irrelevant categories.
- Every executable case has an observable expected behaviour and at least one portable grader. Prefer deterministic tools/output/world checks when those represent the requirement; judge assertions must carry enough explicit criteria to be answerable.
- A fictional test fixture is allowed: label it as a scenario assumption. An unknown business rule is different: ask/record it as unresolved coverage and do not invent a scored reference for it. With no answer, generate the independently grounded cases and name the gap.
- For a simulator, goal/persona contain what the user wants and knows. Hidden account state remains in `world.state`; graders/reference answers never become simulator facts. Existing persona can hold known facts without a new simulator protocol.
- Reuse `corpus-revision` for “make these harder”, “remove this case”, “change the expected answer”. Existing `run-current` is the only run action.
- Two rules from [Anthropic's eval guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), added 2026-09-07: the set is **balanced** (for every behaviour, a case where it must happen and one where it must not, so the agent cannot pass by always doing it), and every case is **solvable** by an agent that follows the Spec, with the reference in `expected`. A capability basket aims at what the agent fails; a first run above 80% measures too little.
- A `simulatedUser` case is scored by its outcome: `world.expect` or a deterministic grader. The host refuses a judge-only simulated case at draft time, because a dialogue only a judge can score proves nothing about the interaction the simulator exists to test.

### 2. Improve case explanation at the existing rendering seam

Files: `src/builder/render/view.ts`, `src/workbench/workbench.ts` (`datasetCasePreview` only if its current bounds are insufficient), `src/i18n.ts`.

For the minimal first implementation, use the existing bounded `TaskMetadataSchema` strings for `title`, `rationale`, `expectedBehavior`, and `source`; use existing `coverageNotes` for unresolved coverage. Give these known fields labelled lines, including on worlded cases; keep unknown imported metadata generic. These fields survive draft revisions, publication and canonical task identity without a new serialized Task version.

Metadata is an author claim, **not verified provenance**. Label it accordingly; do not mint a “grounded” or “verified” badge merely because it contains a path. Human approval judges whether the source actually supports the expected result. If tamper-verifiable source references are included in this delivery, use a small typed draft field validated by the host against the same exact Spec/Git resources, version the stored draft, and bind it to confirmation. Do not overload the existing host-verified failure-provenance union with model-authored source strings.

Keep the complete case available via the existing review interface; the default bounded list must report omitted cases. Do not create a second generated-case preview implementation or bespoke browser editor.

### 3. Add bounded read-only access to declared knowledge

Files: `src/application/target-authoring-context.ts`, `src/workbench/types.ts`, `src/workbench/workbench.ts` target view, `src/builder/workbench-adapter.ts`, `src/builder/render/view.ts`, `docs/INVARIANTS_V1.md`.

**Existing decision conflict:** invariant 30 expressly makes every `data/**` path unreadable to Builder. Relax only for knowledge reading, explicitly. Do not accidentally authorize editing data by adding it to the canonical writable authoring resources.

- Extend the current Target context interface with a read-only knowledge query/selection; keep the exact Git reader and safety checks in the same deep module.
- Only declared `data/kb` roots/subdirectories and supported `.md`/`.txt` documents are eligible. Never follow broad `harness.files` patterns or enumerate ambient data, imports, evaluation files, private state or sealed cases.
- Read Git blobs from the selected committed SHA, enforce byte/count/output bounds and UTF-8/symlink rules. Reuse `chunkKnowledge`/`bm25Search` if passages are returned. Do not use `readKnowledgeBaseFiles` on the mutable operator worktree: its existing adapter is for frozen runtime workspaces.
- Include source path, exact content hash (and stable chunk identity if chunked); verify the selected revision before returning. A source read is data, never an instruction to Pi.
- Preserve Proposal resource closure and write authority. Knowledge content must not join the writable `resources` list or become legal proposal edits merely because it is readable here.
- External/unavailable KB stays an explicitly unavailable input. No vector database, embedding integration, web crawling or remote KB connector is needed for this feature.

### 4. Prove the actual operator flow through its interface

Use existing Workbench/Pi test seams; one end-to-end generated-basket test plus focused safety tests. No new test harness or generator abstraction.

Acceptance:

1. Built/adopted Python agent, approved Spec, zero corpora: Pi inspects resources and submits a reviewable draft; no Target invocation or publication occurs during generation.
2. Draft has a plain grounded case, missing-knowledge case, tool/world case and live clarification case. Card shows reason, expected behaviour, source claim and actual graders on both plain/world shapes.
3. User revises one case; old draft remains immutable, new task IDs/hash reflect the change, world/simulator fields survive.
4. A missing business rule remains visible as unresolved coverage and produces no invented scored reference.
5. “Test it” confirms the current draft through existing `run-current`, publishes exactly its hash and launches baseline. A changed Spec/draft during confirmation is refused.
6. Baseline and subsequent candidate use the same published dataset and graders; generating a new revision never rewrites an old run's evidence.
7. Declared KB passage is readable with exact source identity; undeclared path, sibling KB outside declared subdirectory, `.ahde`, imports, datasets, symlink, dirty/stale SHA and oversized text refuse before exposing bytes.
8. Simulator receives its goal/persona/transcript, not world secrets, grader criteria or reference answer. The existing simulated-user isolation test remains green.

## Do not add

No separate generation agent/process, generator provider framework, new workflow stages, case database, orchestration queue, YAML-writing detour, vector store, “100% coverage” score or claim of autonomous business-truth verification. No rewrite of `workbench.ts` is needed to ship this path. A broader module split can wait for demonstrated friction from another feature.

The technically impressive result here is an explained, editable basket that really runs and stays comparable through improvement. The existing deep modules already provide most of that depth.
