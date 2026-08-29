# AHDE V1.9 — Any data → benchmark

Roadmap item 0b. Slice 1 (the core) has shipped: the case fields, the parsers,
the mapping recipe, the sealed draw, and the ingest receipt. This document is
the contract for slice 2 — the surfaces that wire the core to the Builder, the
human and the runner. Nothing here is implemented yet.

## Shipped in slice 1

`src/manifest.ts` — three optional case fields, additive by construction:

```
expected?  string, ≤ 8 KiB                      a reference answer
messages?  { role: "user"|"assistant"; content: string }[], ≤ 40, each ≤ 8 KiB
metadata?  Record<string,string>, ≤ 8 keys, keys ≤ 64, values ≤ 500 chars
```

Invariants, enforced by `taskDialogueIssue()` on every path that admits a task
(`loadDataset`, `parseTasks`, the compiler):

- when `messages` is present its last turn is `role: "user"` and its `content`
  equals `input`, so every consumer that reads only `input` keeps working;
- a case with none of the three fields hashes exactly as it did before they
  existed — canonical JSON drops `undefined`, and `datasetIdentity()` emits
  them only when present. Pinned by literal hashes in `tests/manifest.test.ts`
  and `tests/dataset-ingest.test.ts`.

`src/application/dataset-ingest.ts` — the deep module:

```ts
inspectDatasetFile({ projectDir, sourcePath, holdout? }): DatasetPreview
holdOutSealedSlice({ projectDir, sourcePath, count, seed, stratifyBy? }): SealedSliceSplit
compileDatasetCases({ projectDir, sourcePath, recipe, holdout? }): CompiledDatasetCases
compileSealedSlice({ projectDir, sourcePath, recipe, holdout }): CompiledDatasetCases
ingestDataset({ projectDir, stateRoot, projectId, sourcePath, recipe,
                holdout, developmentName, sealedName?, now? }): DatasetIngestResult
loadDatasetIngestReceipt(stateRoot, projectId, sha): DatasetIngestReceipt
```

Formats: `csv` (RFC 4180, delimiter sniffed between `,` `;` tab), `tsv`,
`json`, `jsonl` (dot-path flattening), `markdown-table`, `text-lines` (one case
per line, or per blank-line block), `chat-export` (ChatGPT `conversations.json`,
Claude, Telegram, and the generic `[{role,content}]` / `{messages:[…]}` shapes,
collapsed to `messages` + `first_user` / `last_user` / `last_assistant` /
`title` / `message_count`). Inbox contract unchanged, byte bound 16 MiB, rows
capped at 50 000, columns at 128.

## Slice 2 — the surfaces

### Workbench view aspect `dataset`

`WorkbenchViewQuerySchema.aspect` gains `"dataset"`, paired with the inbox path
in the existing `resourcePath` field (today restricted to `aspect: "target"`;
the refinement widens to allow it for `"dataset"` as well).

```
{ aspect: "dataset"; content: { sourcePath, preview: DatasetPreview } }
```

`DatasetPreview` is already bounded and credential-redacted, and excludes the
sealed rows when the project's holdout spec is in force. Two rules:

- the host computes the preview; the Builder never reads `imports/` itself;
- no development-facing object may carry a sealed corpus id.

### Submit kind `dataset-recipe`

```ts
z.strictObject({
  kind: z.literal("dataset-recipe"),
  approvedSpecId: ArtifactIdSchema.optional(),
  sourcePath: DatasetSourcePathSchema,
  recipe: DatasetMappingRecipeSchema,
  name: NonBlankSchema.max(200),
  revisionSummary: NonBlankSchema.max(4_000),
})
```

The Builder proposes the recipe from the preview alone. The host re-validates
it against the real columns (`compileDatasetCases` throws before any row is
mapped if a column or a `{{placeholder}}` does not resolve) and answers with
the first sample rows compiled through it, so the human argues with cases, not
with JSON.

### Decision `import-dataset`

```ts
z.strictObject({
  kind: z.literal("import-dataset"),
  submissionId: ArtifactIdSchema.optional(),
  sealed: z.strictObject({ count: z.number().int().min(1), seed: SeedSchema,
                           stratifyBy: z.string().optional() }).nullable(),
  reason: NonBlankSchema.max(4_000),
})
```

The human confirms the recipe on the sample rows; the host compiles everything.
Order is fixed and load-bearing: `compileSealedSlice` → `createCorpus({
visibility: "sealed" })` → development cases → receipt. The sealed rows never
pass through a model-visible path, and the split is recomputable from
(file sha256, seed, count, stratifyBy) rather than stored.

Development cases are handed to the existing draft/publish flow, which still
owns publication. `BuilderCorpusDraftTaskInputSchema` must widen to carry
`expected`, `messages` and `metadata` for that to work — today it is strict on
`{ input, graders }`, so a compiled dialogue case cannot yet enter a draft.

### CLI

```
ahde corpus ingest --project <id> --file <imports/…> --recipe <json|@path>
                   --name <name> [--sealed N --seed S [--stratify-by <column>]]
ahde corpus inspect --project <id> --file <imports/…> [--sealed N --seed S]
```

`inspect` prints the preview; `ingest` prints the receipt, the sealed corpus id
and the skipped-row counts. Neither ever prints a sealed row.

### Graders that consume `expected`

```
{ type: "exact",      normalize?: "trim"|"lower"|"none" }   output equals expected
{ type: "similarity", metric: "token-f1"|"levenshtein", threshold: number }
{ type: "judge", rubric: string, withReference?: true }      reference in the prompt
```

`exact` and `similarity` are deterministic and need no judge model. All three
must fail loudly on a case with no `expected` rather than passing vacuously.
`graderName()` and the `GraderCheckCode` union grow with them.

### Runner change

When a task carries `messages`, the runner seeds those turns into the session
before sending the final prompt, and grades only the reply that follows. The
final user turn equals `input`, so a runner that ignores `messages` still sends
the right prompt — that is the whole point of the invariant.

## Deliberate limits

- The `metadata` value bound truncates at 500 characters with an ellipsis; the
  dialogue keeps its most recent 40 turns. Both are recorded here rather than
  reported per row, because a compile reports counts, never row contents.
- Sampling thins only the development side. The sealed slice is the exam.
- XLSX and PDF remain out; the extension allowlist is the gate.
