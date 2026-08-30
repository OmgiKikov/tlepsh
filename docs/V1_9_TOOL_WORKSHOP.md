# AHDE V1.9 — The tool workshop

Roadmap item 0c. This document is two things: the record of the application
core that landed on `eg/workshop`, and the contract the next wave implements
when it gives Builder Pi a workbench instead of a typewriter.

## Why

Today a custom Target tool is one executable, authored blind. The Builder emits
a `tool.upsert` intent carrying a shell script it has never run, a human applies
the diff, and the first time anybody learns whether the code works is a 90-run
verification. "Build me a RAG agent" is impossible in that shape: a retrieval
tool is several files, a dependency, an index build, and a corpus — none of
which fit through a single `#!/bin/sh` string, and none of which can be checked
without executing them.

Three things had to become expressible before a Builder could be trusted with
code: a tool that is more than one file, a dependency step that runs somewhere,
and data the tool reads. Then one operation — try it — closes the loop between
writing and knowing.

## What landed (the application core)

### 1. Multi-file tools

A tool may keep its single-file shape, `tools/<name>.tool.yaml` + `bin/<name>`,
which hashes exactly as it did before. Or it may be a directory:

```
tools/<name>/
  tool.yaml        the descriptor; name must be <name>, argv[0] must be tools/<name>/run
  run              the entry point, mode 100755, JSON on stdin → stdout (unchanged contract)
  lib/…            any support files
  requirements.txt declared as a lockfile, if the tool has dependencies
```

Descriptor additions, both directory-only:

```yaml
setup:                       # optional, runs once per prepared tool home
  argv: [npm, ci, --ignore-scripts]   # argv[0] is a bare PATH command or an absolute path
  timeoutMs: 120000
  network: allow             # deny unless declared AND execution.network already allows it
lockfiles: [package-lock.json]        # directory-relative; their bytes join the tool digest
```

`toolsetHash` covers every file in the directory — sorted by path, with the
executable bit folded in — so one changed byte or one changed mode is a
different tool identity, and CONTEXT invariant 17 keeps holding for tools that
are no longer single files. Symlinks, non-regular files, unsafe names, depth
over 6, more than 256 files, or more than 8 MiB fail closed at load.

### 2. Setup, and where its output lives

The interesting question is not "how do I run `npm ci`" but "where does
`node_modules` go so that it never becomes evidence". The answer: **not in the
workspace**.

Per EvalRun snapshot AHDE creates a private *prepared tool home* beside the
snapshot, copies each directory tool's hash-verified files into
`<home>/<name>/`, and runs the declared `setup` there once, in the same OS
sandbox as the tool itself, with:

- write access to `<home>/<name>/` and the run scratch, and nothing else;
- `network` exactly as the descriptor declares;
- `timeoutMs` as declared, output bounded to 64 KiB;
- the same scrubbed environment a tool call gets, plus `AHDE_TOOL_HOME`.

Directory tools then execute from that prepared home — `run` resolves under
`AHDE_TOOL_HOME`, not under the model-writable workspace copy — so a
`workspace-write` tool cannot rewrite its own code between two calls. Whatever
setup produced is derived state: it is outside the hashed workspace, so
`workspaceHash` stays the hash of the declared source tree and invariant 19 is
unaffected. Identity is the declared inputs (descriptor + files + lockfile
bytes); the output of running them is not identity.

Setup failure is an **infrastructure error for the run** (invariant 9), not a
behavioral failure: the harness could not be constructed, the model is never
contacted, and the RunRecord ends `status: "error"`. Preparation is idempotent
through a marker in the home, so one suite of 90 executions pays for `npm ci`
once.

### 3. `data/**`

`manifest.yaml` gains `data: string[]` — directories under `data/`:

```yaml
data: [data/docs, data/index]
```

Only declared directories are copied into a Target workspace snapshot and
therefore hashed into `workspaceHash`; anything else under `data/` is private to
the operator's checkout, the way `imports/` already is. Total declared bytes are
bounded at 64 MiB (`AHDE_DATA_MAX_BYTES` to raise it deliberately), file count at
20 000, and symlinks or special files fail closed.

The Builder never reads a data file. The authoring context lists each declared
directory as shape only: path, file count, byte total, and a bounded sample of
at most 32 names. A retrieval corpus is a fact about the Harness, not context to
spend tokens on.

### 4. Intents

`tool.upsert` keeps its single-executable form and gains a multi-file one —
exactly one of `executable` or `files` is required:

```ts
{ type: "tool.upsert", name, descriptor, executable }                    // bin/<name>
{ type: "tool.upsert", name, descriptor,
  files: [{ path, content | contentBase64, mode? }] }                    // tools/<name>/
{ type: "tool.remove", name }
{ type: "data.upsert", path: "data/<dir>/<file>", content | contentBase64 }
{ type: "data.remove", path: "data/<dir>/<file>" }
```

- `path` in `files` is relative to `tools/<name>/`; `tool.yaml` is compiled from
  `descriptor` and cannot be authored directly; `run` is required and is always
  mode 100755.
- An upsert replaces the whole directory: files that existed and are no longer
  authored are deleted in the same reviewed diff, so a tool never keeps stale
  bytes nobody looked at.
- A tool cannot silently change layout; re-authoring a directory tool as a
  single-file tool (or the reverse) requires an explicit `tool.remove` first.
- `data.upsert` carries its declaration: the first file in `data/docs` adds
  `data/docs` to `manifest.data`, and removing the last file retires the
  declaration, so the compiled manifest always loads.
- `contentBase64` is an encoding convenience, not an escape into binary. It is
  decoded, required to be NUL-free LF-only UTF-8 within the 512 KiB file bound,
  and compiled into the same exact text diff — the proposal reviewer sees paths,
  modes, byte counts, and every line.

`HARNESS_AUTHORING_ALLOWED_PATHS` and `CANDIDATE_SCOPE_POLICY`
(`candidate-harness-resources-v3`) now admit `data/**` alongside `AGENTS.md`,
`manifest.yaml`, `skills/**`, `bin/**`, `tools/**`. Invariant 6 grows by exactly
one scope; nothing else moves.

### 5. `tryTool`

`src/application/tool-workshop.ts`:

```ts
tryTool({
  repositoryDir,
  tool: "search",
  input: { term: "refunds" },
  source: { kind: "head" }                       // or
         | { kind: "branch", ref }               // an exact other revision
         | { kind: "draft", intents },           // code that exists only in a proposal
}) → {
  tool, layout, source: { kind, ref, changedPaths },
  target: { id, gitSha, toolsetHash, toolDigest },
  sandbox, setup, stdout, stderr, exitCode, durationMs, truncated, timedOut
}
```

What it does: resolves the source into a **detached worktree** (a draft is
compiled through `compileHarnessAuthoringProposal` and `git apply`-ed there, so
a tool can be tried before it exists anywhere), materializes the ordinary
Target workspace snapshot from it — no `evals/`, no `imports/`, no `.env`, only
declared data — prepares the tool home, runs setup, and executes the one tool
through the existing broker with the input validated against its declared
parameter schema.

What it does not do: touch the operator's checkout, write anything into the runs
root, or create an artifact. Looking is not measuring; a try produces no eval
evidence, and it can never become promotion evidence. Output is redacted through
the trace redactor and then bounded to 8 KiB per stream; a non-zero exit comes
back as data rather than an exception, because a reviewer needs to see the
failure, not a stack trace about it.

For operators and tests:

```
ahde tool try --target <dir> --tool <name> --input <json|@path> [--branch <ref>]
```

Exit 0 when the tool exited 0, 1 when it did not.

## The contract for the Builder-facing surface

The next wave adds the Workbench/extension surface. This is what it must honor.

### Scoped write/edit/bash inside a proposal worktree

The Builder gets generic file tools for the first time. They are safe only
because of where they point:

1. **A private worktree, never the checkout.** The host creates a detached
   worktree of the exact clean Target commit the authoring context was minted
   from, and the tools' root is that path. `withDetachedWorktree` already does
   the creation, lineage validation, and guaranteed cleanup.
2. **Confined to `tools/**`, `bin/**`, `data/**`.** Enforced twice: the
   `ExecutionPolicy` file tools already refuse paths outside their root
   (`src/execution-policy.ts`), and a `tool_call` guard rejects `write`/`edit`
   outside the three scopes before the call runs. Pi's `protected-paths.ts`
   example is the exact shape of that guard —
   `pi.on("tool_call", …) → { block: true, reason }` — inverted from a denylist
   to an allowlist, because a denylist is not a scope.
3. **`bash` inside the same OS sandbox as a tool.** The Builder's shell is
   `sandbox-exec`/`bwrap` with the workshop confinement: read the worktree,
   write only the three scopes plus scratch, network denied. Pi's
   `examples/extensions/sandbox` shows the override seam
   (replace the built-in `bash`, or mutate its input in `tool_call`);
   `sandboxInvocation` in `src/target/tool-broker.ts` is the AHDE-side builder
   for the profile, and `TargetToolConfinement` is the one place read roots,
   write roots, and network are decided.
4. **The worktree is not the proposal.** Nothing the Builder writes there
   applies to anything. When it is done, the host *reads back* the worktree diff
   and compiles it into `tool.upsert` / `data.upsert` intents — or the Builder
   emits the intents directly and the worktree was only a scratchpad. Either
   way the artifact that reaches a human is an ordinary immutable
   `CandidateProposal`: exact paths, exact base SHAs, whole-file unified diffs,
   a human apply gate, verification, promotion. Invariant 6 and invariant 20 are
   untouched; the workshop changes how a proposal is *written*, never how it is
   *applied*.
5. **A long edit session is a subagent's job.** Pi's `examples/extensions/
   subagent` spawns an isolated `pi` process per delegated task with its own
   context window and JSON output. A tool-writing loop — write, `try_tool`,
   read the error, fix, try again — belongs in one of those, so the operator's
   Builder conversation receives the outcome, not fifty tool results.

### `try_tool` as a Workbench operation

`tryTool` is the application service; the Workbench operation is the gate around
it. Rules it inherits from the existing seam:

- The host supplies the subject. The model names a declared tool and a JSON
  input; the host derives repository, revision, and source. No model-supplied
  paths, no model-supplied refs (invariant 16).
- The result is a bounded projection, not evidence. It is already redacted and
  truncated; the Workbench must not persist it as an artifact, must not let it
  reach a Comparison Verdict, and must not let a green try substitute for a run.
  "The tool works" and "the harness is better" are different claims.
- Sealed stays sealed. A try executes a tool on an operator-supplied or
  Builder-authored input; it never receives holdout content (invariants 5, 13).
- It is cheap and repeatable, so it needs no confirmation dialog — unlike apply,
  run, verify, and promote, it changes nothing.

### How results become an ordinary Proposal

```
Builder writes in the worktree  →  try_tool (0..n times, no artifacts)
                                →  structured-proposal submit (intents + context claim)
                                →  compileHarnessAuthoringProposal (exact diffs, host-derived paths)
                                →  human apply gate (unchanged)
                                →  Candidate → development + sealed verification → promotion
```

The context claim (invariant 30) still pins compilation to the exact clean
revision the Builder read, and the closure check still refuses a proposal that
would produce a Harness the Builder cannot read back — which is why every file
of a multi-file tool is an inspectable authoring resource, while a data
directory is shape only.

## Left out on purpose

- **No Builder UI.** No `write`/`edit`/`bash` tools, no `try_tool` Workbench
  operation, no worktree-diff → intents compiler. That is the next wave; this
  lane is the application core it calls.
- **Setup output is not cached across snapshots.** Two EvalRuns of the same
  revision each run `npm ci` once. A content-addressed cache keyed by
  `toolsetHash` is an obvious follow-up and a poor thing to get wrong early.
- **`tryTool` runs one tool per call.** No batch, no sample-input file format,
  no recorded try history.
- **Data is copied, not mounted.** A 64 MiB corpus is copied per run workspace.
  Fine at this bound; a read-only bind of a declared data root is the way out
  when it stops being fine.
