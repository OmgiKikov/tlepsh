# V1.6 — Context-aware Harness authoring

V1.6 lets Builder Pi inspect the Target it is improving without giving it a
shell, ambient filesystem access, or another tool.

```text
verified failure mode
  → Target overview at exact Git revision
  → exact declared resource content
  → semantic Harness intent
  → host recompiles context and exact diff
  → review → Apply or Discard
```

## Model-facing flow

The registered Builder surface remains exactly three tools. Target context is
part of `ahde_workbench_view`:

```json
{ "aspect": "target" }
```

returns a safe overview with:

- Target id and exact 40-character Git revision;
- sanitized model identity and execution policy;
- a deterministic `contextHash`;
- a host-minted `claim` binding that hash to Target id and Git revision;
- metadata and SHA-256 for every declared authoring resource.

To read one resource completely, Builder calls the same tool:

```json
{ "aspect": "target", "resourcePath": "AGENTS.md" }
```

`resourcePath` must come from the overview. Content is exact, complete UTF-8
from the selected Git blob; it is never a mutable-worktree read and never
silently truncated. `/target [resource]` is the human shortcut over the same
Workbench view.

Before a structured Proposal, Builder refreshes the overview and reads every
existing resource it will fully replace:

- `AGENTS.md` for `instructions.replace`;
- the declared `SKILL.md` for an existing `skill.upsert`;
- both descriptor and executable for an existing `tool.upsert`;
- the overview for `execution.configure`.

New skills and tools have no existing content to read. The model echoes the
overview's exact `claim` as `authoringContext`; it cannot author any claim
field. The host re-derives the complete context, rejects a stale/mutated claim,
pins compilation to that revision, and persists the claim with Proposal
provenance. Raw paths, modes, and content hashes remain host-derived.

## Declared surface

The context contains only canonical manifest-declared Harness resources:

```text
AGENTS.md
skills/<name>/SKILL.md
tools/<name>.tool.yaml
bin/<name>
```

Raw `manifest.yaml` is not exposed. Its safe model/execution projection is
enough for typed policy authoring. Execution-environment allowlist names are
visible because an exact policy replacement needs them, but their values never
are; model `apiKeyEnv`, base URLs, model params, eval dataset and grader paths
remain private. Orphan files under `skills/`, `tools/`, or `bin/` are not
discovered by directory walking.

The following are never readable through this interface:

- eval cases or graders;
- `.env`, credentials, `.git`, `.ahde`, runs, and imports;
- absolute, traversal, dot-private, or undeclared paths;
- symlinks, gitlinks, directories, or files with unsafe Git modes.

Denied and undeclared requests share a bounded non-oracle error and do not
reveal whether a private path exists.

## Exact-revision guarantees

`TargetAuthoringContext` is one deep application module. Its caller supplies a
fresh host-derived `{ targetId, gitSha }`; the module hides all Git and path
mechanics behind one inspection interface.

For every overview or resource read it:

1. verifies a regular non-symlink Git worktree root;
2. rejects staged, unstaged, and non-ignored untracked changes;
3. verifies exact `HEAD` against the host-selected commit;
4. reads the strict manifest and resources only from Git objects with Git
   replacement refs disabled;
5. validates canonical skill/tool declarations and tool policy;
6. checks every tree ancestor and leaf type/mode;
7. fatal-decodes UTF-8 and rejects NUL and CR content;
8. enforces per-resource, count, and aggregate byte limits;
9. rechecks cleanliness and `HEAD` after materialization;
10. hashes exact bytes and the deterministic safe projection.

Current limits are 1 MiB for the manifest, 512 KiB per authoring resource, 64
skills, 64 tools, and 8 MiB across the complete declared context. Exceeding a
limit fails closed; no partial authoring view is presented as complete.

## Workbench and compatibility

Workbench passes the Target identity from the freshly validated inventory,
reopens the context immediately before `compileHarnessAuthoringProposal`, and
requires the Builder to echo the exact host-minted claim from its view. Thus a
stale, dirty, or silently replaced Target cannot reach Proposal recording. The
Proposal compiler independently pins the inspected base revision, derives the
exact diff, and applies the same count/per-file/aggregate projection policy to
the resulting Harness. A proposal therefore cannot create a Target that the
next Builder turn is unable to inspect.

The retired direct `ahde_target_read` compatibility adapter now delegates to
this same module; production Builder Pi still registers only:

```text
ahde_workbench_view
ahde_workbench_submit
ahde_workbench_decide
```

Tests exercise real temporary Git repositories, exact resource hashes,
private/undeclared denial, dirty and stale revisions, symlinks, invalid UTF-8,
Git replacement refs, compiler-policy closure, claim staleness and durable
claim provenance, oversize and mode failures, Workbench projection, transport bounds, and the
three-tool flow `traces → target overview → AGENTS.md → proposal → review`
without an implicit decision.
