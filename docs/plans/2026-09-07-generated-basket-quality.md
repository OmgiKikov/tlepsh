# Generated basket: thermo-nuclear quality planning review

Reviewed 2026-09-07. Scope: generation of an editable development basket from an existing agent, its approved Spec, declared tools and knowledge base, followed by the existing AHDE publication and execution flow. Applied `/Users/kikov/.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`. Source inspection only; no product code changed and no test execution claimed by this review.

## Verdict

Implement as better authoring of the existing `BuilderCorpusDraft`, by the existing Builder Pi. Do not introduce a second dataset type, a separate generator model, a new workbench stage, or a fork of sealed synthesis. The runnable case model, immutable revisions, human publication and run orchestration already exist. Missing pieces are a readable source context, defensible per-case grounding, a complete human review, and one broken revision validation path.

## Ranked findings

### P1 — Validate complete revised cases, not projected grader fragments

`src/workbench/workbench.ts:3273-3279` maps revision operations to `{ graders }`, discarding `expected`, the simulated user and the world. `assertGradersRunnable` then rejects any reference-dependent grader without `expected` (`src/application/corpus-target.ts:417`). A correct `add` or `replace` carrying an expected answer therefore fails; changing a grader on a parent case that already has an expected answer has the same problem. This directly breaks “generate, then correct the answer/check.”

Fix the canonical revision path: compute the complete revised draft once, validate its tasks, and only then write the immutable artifact. Do not add a generated-case exception or reconstruct selected parent fields in another workbench conditional. Existing semantic revision and task-ID/provenance remapping in `src/application/builder-corpus-draft.ts:489-640` should stay authoritative.

Acceptance: a reference-answer case can be added, replaced and have its grader changed; deleting an expected answer while keeping a reference grader is rejected before a child draft is persisted. Existing source provenance remains intact after grader edits and is removed/recomputed after content replacement according to its current contract.

### P1 — The advertised knowledge-base input is currently unreadable to Builder

`src/application/target-authoring-context.ts:119-130` deliberately exposes `data/**` as shape, never content. The context enumerates data at lines 826-848, and rejects reading it as an authoring resource at lines 850-852. Asking Pi to generate factual RAG expectations from that view encourages guessed facts: it knows file names, not what the documents say.

Add one bounded, host-owned source read for basket authoring. Reuse the existing declared resource reader for instructions/tools and the canonical KB chunk representation/search from `src/domain/kb.ts` and `src/target/kb-tool.ts`. Only expose committed, declared source content with source identity and exact content hashes. Do not broaden `aspect:target` into arbitrary filesystem reading, and do not expose `imports`, raw runs, sealed data or generic `data/**` merely because a basket needs documents. If a KB is absent or unsupported, explicitly return that limitation and generate only requirements-backed cases.

The source read needs total bytes, individual bytes, item count and omitted-count bounds before unbounded content is assembled. A whole-document read followed by output truncation is not a memory bound. A displayed excerpt is evidence only for the displayed claim; truncation must be visible.

Acceptance: a declared Markdown KB passage is readable and referenceable; undeclared paths, symlinks, traversal, private state and sealed sources are not. Source content containing instructions remains data. Missing/empty/oversized KB returns a useful limitation rather than an invented answer.

### P1 — Model-written metadata is not verified grounding

The current draft submission carries `tasks` and free-form `coverageNotes` (`src/workbench/types.ts:672-680`). Identity binds the approved Spec and task bytes (`src/application/builder-corpus-draft.ts:213-255`), but does not prove that a claimed KB quote, tool name or expected business rule came from a source. `TaskMetadataSchema` is a generic string map (`src/manifest.ts:279`), so putting `verified`, `source_hash`, or `grounded` there would create an authority claim the model can invent.

Represent any grounding that gates publication as a typed, draft-owned contract. The model may request a source reference and explain an inference; the host resolves and validates the reference against the context it issued. Host-derived source identity must not be accepted as arbitrary model-authored provenance. A saved source link proves where text came from, not that the expected answer follows logically: the human still reviews the expectation. Distinguish requirements/document evidence from an existing implementation assumption; a bug in the agent must not become the oracle used to grade that agent.

Unresolved business rules belong in explicit review questions/coverage gaps. Do not silently convert them into runnable scored assertions. Use the ordinary `expected`, `graders`, `world` and `simulatedUser` fields for execution; keep review explanations out of simulator goals and out of free-form metadata used as a security decision.

Acceptance: fabricated source IDs/hashes/quotes and nonexistent tool names are rejected; an unknown business rule is visibly unresolved and cannot masquerade as a confirmed test expectation. A legitimately inferred scenario is labelled as an assumption for review, not “verified.”

### P1 — Bind generated authoring to real inputs, then freeze the reviewed basket

Structured proposals already carry a host-minted context claim (`src/workbench/types.ts:724-728`), whereas corpus drafts have no equivalent source binding. Publication compares draft hashes and the approved Spec (`src/workbench/decisions/corpus.ts:47-63`), but a changed source document is not part of that subject. Generated cases could therefore be accepted as based on today's KB while retaining yesterday's expected answer.

At generation submission, verify the exact source context the model read. Persist the relevant source identities in the immutable draft. Before publication, detect changed referenced instruction/tool/KB content or a changed approved Spec and require a refreshed review. Do not bind the entire lifecycle to the original target SHA: `start-testing` may configure evaluators without changing source content, and baseline/candidate must later use the same published basket across agent revisions. Keep historical SHA as provenance; use actual referenced source content hashes for staleness before publication. After publication, preserve the corpus identity and existing paired evaluation behavior.

Revision semantics must be explicit: an unchanged case can retain its valid grounding; a replaced expected answer or source reference needs new validation. A renamed basket should not demand regeneration. Do not mutate a published corpus when the source changes.

Acceptance: source mutation between read and submit, or during the human publish confirmation, is detected; a model/evaluator-only configuration change does not falsely invalidate untouched document evidence; an agent candidate still runs against the exact baseline corpus hash.

### P2 — The current compact review hides important parts of generated dialogue cases

`renderCorpusDraft` shows at most 25 cases (`src/builder/render/view.ts:587-602`). The world-card branch at lines 1195-1243 does not display the actual opening input, expected answer, complete simulated-user configuration or all initial state. `metadata` is only rendered in the non-world branch, with four truncated fields. This is an acceptable summary, but it is insufficient as the only review surface for approving generated cases and their business rules.

Keep one shared case presentation. Add a focused per-case inspection to the existing review experience, with complete opening input, expected behavior/checks, source excerpt/reference, known user facts, initial/final world expectations, and unresolved assumptions. Summaries should link to or clearly offer that detail, including cases beyond the first page. Use existing semantic revisions for edits. Do not create a second basket editor or make the operator manipulate JSON to reach hidden details.

Acceptance: the reviewer can reach case 26 and inspect a worlded dialogue case without losing its opening line, expected answer, stop condition or grounding. The summarized and detailed case are the same task ID and revision. A reference change results in a new immutable draft and the next confirmation uses it.

### P2 — Keep generator orchestration out of already giant workbench/render files

Current sizes: `workbench.ts` 3,524 lines, `workbench/types.ts` 1,569, `builder/render/view.ts` 1,294, `application/sealed-synth.ts` 1,493. The corpus draft module is 679 lines. These are boundaries to respect, not permission to add another 300-line mode to each. Reusing sealed synthesis with a `development` boolean would mix two incompatible authorities: Builder-visible editable cases and evaluator-private exam cases.

The code-judo move is that Pi already generates text and calls `corpus-draft`. Build one cohesive application module for bounded basket source context/grounding, extend ordinary draft authoring and review, and keep workbench additions as dispatch plus existing create/revise/publish calls. Extract the case renderer only if needed to keep its complete presentation together. Avoid a generic generation framework, model catalog, job store, new retry mechanism or new state-machine stage for this feature.

Acceptance: no duplicate corpus store, grader parser, publication gate or execution loop; no new `generated` checks scattered through run/candidate/release paths; source-backed and manual drafts converge before publication and use the same run path.

## Minimal implementation sequence

1. Repair canonical revision preparation/validation before write, with regression coverage for reference-dependent graders.
2. Add a bounded generation-source context through the existing workbench view transport; expose approved Spec, declared instruction/tool resources, and selected KB passages with host-owned source references and visible limits.
3. Extend existing draft authoring with typed per-case review/grounding information and exact source validation. Preserve old drafts and their content hashes; introduce an explicit schema version if persisted identity semantics change. Revisions preserve or revalidate grounding according to the content actually changed.
4. Teach Builder Pi the natural-language entry “нет корзины / сгенерируй проверки”: read source context, produce a small balanced basket, surface unknown rules, show the review. Use the existing Pi session and tools. Default to a small readable set; do not require every agent to have KB, tools and multi-turn scenarios.
5. Complete the existing human review and then use `start-testing`/publication/run unchanged in responsibility. Approval is over the exact reviewed draft. Budget/evaluator selection belongs to the existing host flow.

## Focused acceptance suite

- Source-bound contract tests: known and forged references, stale source bytes, explicit unresolved assumptions, byte/count bounds and forbidden source classes.
- Draft revision regression: add/replace/reference-grader update are valid with expected answers; malformed resulting cases write no child artifact; unchanged provenance survives a rename and valid grader edit.
- One Workbench integration: built Python/command fixture with declared mock tool and small KB → no imported basket → ordinary generated draft with a factual case, a tool/world case and a multi-turn case → revise one expectation → human confirms → baseline runs the exact published cases. Verify mock/tool execution and simulator isolation rather than relying only on output snapshots.
- One stale-confirmation integration: changing referenced source content while confirmation is open prevents publication; changing evaluator configuration alone does not spoil source grounding.
- One human-presentation check: all material details of a worlded dialogue case and a case beyond summary page one remain inspectable in the normal flow.
- Existing draft/import/provenance/corpus validation, simulator, workbench run and transport suites remain green. A live paid model smoke is useful only if credentials/authorization are already available; deterministic integration remains required. Do not claim customer readiness from a synthetic fixture alone.

## Deliberately excluded

No new evaluator model, training pipeline, separate studio, methodology framework, automatic judge reliability claim, sealed synthesis redesign or general first-build cleanup. Package smoke/first-build/sealed legacy issues from earlier audits are outside this bounded feature unless they block the exact integration above. Customer-agent value remains unverified until actual source code and business rules arrive.
