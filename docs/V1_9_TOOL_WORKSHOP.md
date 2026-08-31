# AHDE V1.9 — The tool workshop

Roadmap item 0c, then wave 2 item 9. This document is two things: the record of
the application core that landed on `eg/workshop`, and the contract the
Builder-facing surface honours now that it has landed too. Both halves are
implemented; the second half's section below records what shipped, not what is
planned.

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

## What landed (the Builder-facing surface)

Wave 2 item 9. The Builder now writes code and runs it before anybody reviews
it, and the proposal a human reads is the diff of exactly that code.

### The workshop

`openBuilderWorkshop` (`src/application/tool-workshop.ts`) opens one detached
worktree of the exact clean Target commit the authoring context was minted from
— `openDetachedWorktree` in `src/git/experiment-worktree.ts` holds it across
calls and guarantees the cleanup that `withDetachedWorktree` already did for one
call. The operator's checkout is never switched, never written, and never read
for execution.

Scope, enforced on the **resolved real path** for every read, write, `cwd`, and
sandbox write root:

```
AGENTS.md    skills/**    tools/**    bin/**    data/**
```

Everything else fails closed and names the offending path: `manifest.yaml`,
`evals/**`, `imports/**`, `runs/`, `.git`, `.env`, `.ahde`, a `..` traversal, an
absolute path, a symlink anywhere along the path, and a leaf that is not a
regular file or directory. `manifest.yaml` is host-owned rather than forbidden:
the host re-derives the declared `skills`, `tools`, and `data` lists from the
files that exist after every write and every command, through the same
`renderManifest` the intent compiler uses, so the workshop's Harness always
loads and a hand-edited manifest can never survive into a proposal.

### The four tools

They are registered once and legal only while a workshop is open — the
`tool_call` guard refuses them otherwise, and `setActiveTools` hides them so the
model is not offered hands it does not have.

- **`ahde_workshop_read`** — one file's exact complete text, mode, bytes and
  hash, or one directory's bounded listing.
- **`ahde_workshop_write`** — `{ path, content }`, or an exact
  `{ path, oldText, newText }` replacement that must match exactly once, or
  `{ path, remove: true }`. Modes are derived (`bin/<tool>` and
  `tools/<tool>/run` are 100755), bytes are bounded, and CRLF/NUL/oversize/empty
  all fail closed.
- **`ahde_workshop_bash`** — argv only. There is no shell and no interpolation;
  `argv[0]` is a bare PATH command or an absolute path. It runs through
  `sandboxInvocation` in the same `sandbox-exec`/`bwrap` profile a declared tool
  gets, with the Target's declared network and environment allowlist, the
  worktree readable, only the Harness scope plus a private scratch writable,
  bounded output and a bounded timeout. The sandbox itself is not optional here:
  `execution.sandbox` describes the *Target's* shell and can never widen what
  Builder Pi reaches, so a host with no usable backend refuses the command.
- **`ahde_workshop_try`** — `tryTool` against the workshop's own copy, so a tool
  written a second ago can be run a second later, setup step included. Still a
  look, not a measurement: no artifact, no evidence, no eval run.

### The proposal is the diff

`workshop-close` compiles the proposal from `git status`/`git diff` of the
worktree against its baseline commit:

```
workshop-open (submit)          →  detached worktree of the exact clean commit
  read / write / bash / try     →  0..n times, no artifacts, no evidence
workshop-close (submit)         →  git diff → CandidateProposal
                                →  the same scope assertion (allowed paths +
                                   assertResourceOnlyManifestChange + the
                                   declared data/skills/tools lists)
                                →  the same closure check on the resulting
                                   Harness (invariant 30)
                                →  recordBuilderAuthoredProposal → admission
                                   receipt (approved Spec + Builder run +
                                   proposal hash)
                                →  human apply gate (unchanged)
                                →  Candidate → development + sealed
                                   verification → promotion
```

Nothing downstream changed. The compiled artifact is the same
`CandidateProposal` the intent compiler emits — whole-file unified diffs from
the same renderer, `git apply --check` against the exact base revision, the same
`validateCandidateProposal` scope. A workshop that produced no change, produced
a change outside the scope, or wrote a path Git ignores refuses at close time
and names the exact paths. A workshop whose Target moved or whose checkout went
dirty refuses too. Success disposes the worktree; a refusal leaves it open so
the Builder can fix what it wrote, and `workshop-discard` throws it away.

### The intent compiler stays

`harness-authoring.ts` is unchanged in behaviour and remains the second path:
the fallback for single-file edits, and the **only** way to change the Target's
execution policy (`execution.configure`), because a workshop diff may change
resources and resource declarations only.

## Left out on purpose

- **No subagent for the edit loop.** Pi's `examples/extensions/subagent` spawns
  an isolated process per delegated task; a long write → try → fix loop belongs
  in one of those so the operator's conversation receives the outcome rather
  than fifty tool results. The workshop works without it; the loop is simply
  noisier in the transcript than it needs to be.
- **One workshop per Builder conversation.** No parallel workshops, no
  workshop over a branch other than the current clean Target revision, and no
  resuming a workshop after the process dies.
- **A workshop diff cannot change the execution policy.** `execution.configure`
  stays an intent, because the policy is a manifest field rather than a Harness
  resource and `assertResourceOnlyManifestChange` refuses it by design.
- **Setup output is not cached across snapshots.** Two EvalRuns of the same
  revision each run `npm ci` once. A content-addressed cache keyed by
  `toolsetHash` is an obvious follow-up and a poor thing to get wrong early.
- **`tryTool` runs one tool per call.** No batch, no sample-input file format,
  no recorded try history.
- **Data is copied, not mounted.** A 64 MiB corpus is copied per run workspace.
  Fine at this bound; a read-only bind of a declared data root is the way out
  when it stops being fine.
