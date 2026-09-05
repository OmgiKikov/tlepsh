import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelExperimentGit as git } from "./model-experiment-source.js";

/** Git invokes `prepared` after resolving and locking the actual refs. Values
 * travel through quoted environment variables, never through generated shell. */
const REFERENCE_GUARD = `#!/bin/sh
set -eu
[ "$1" = prepared ] || exit 0
if [ "\${AHDE_MODEL_CHANGE_PROBE:-}" = 1 ]; then
  printf 'reference-transaction-ready\n' > "$AHDE_MODEL_CHANGE_PROBE_MARKER"
  exit 1
fi
refuse() {
  echo 'model selection reference update differs from the approved branch and revision' >&2
  exit 1
}
current_ref=$(git symbolic-ref --quiet HEAD) || refuse
[ "$current_ref" = "$AHDE_MODEL_CHANGE_REF" ] || refuse
saw_branch=0
saw_head=0
while IFS=' ' read -r old new ref; do
  case "$ref" in
    "$AHDE_MODEL_CHANGE_REF")
      [ "$old" = "$AHDE_MODEL_CHANGE_BASE" ] || refuse
      [ "$new" = "$AHDE_MODEL_CHANGE_REVISION" ] || refuse
      saw_branch=1
      ;;
    HEAD)
      # Older Git includes the log-only HEAD update beside the resolved ref.
      # It supplies no authority by itself; require that exact branch below.
      [ "$old" = "$AHDE_MODEL_CHANGE_BASE" ] || [ "$old" = 0000000000000000000000000000000000000000 ] || refuse
      [ "$new" = "$AHDE_MODEL_CHANGE_REVISION" ] || refuse
      saw_head=1
      ;;
    ORIG_HEAD)
      [ "$new" = "$AHDE_MODEL_CHANGE_BASE" ] || refuse
      ;;
    AUTO_MERGE)
      [ "$new" = 0000000000000000000000000000000000000000 ] || refuse
      ;;
    *) refuse ;;
  esac
done
[ "$saw_head" = 0 ] || [ "$saw_branch" = 1 ] || refuse
`;

/**
 * The host's private hook is scoped to these two Git invocations. A verify-only
 * transaction proves the hook is enforced without changing any ref. An older
 * Git that ignores this hook fails closed before the fast-forward.
 *
 * A late external checkout can still leave worktree/index changes when Git
 * aborts; the caller keeps its pending receipt and must not promise rollback.
 * The ref transaction itself can never advance an unapproved branch.
 */
export function fastForwardReviewedModel(options: {
	targetDir: string;
	hooksPath: string;
	headRef: string;
	baseSha: string;
	revision: string;
}): void {
	const marker = join(options.hooksPath, "probe-result");
	writeFileSync(join(options.hooksPath, "reference-transaction"), REFERENCE_GUARD, { mode: 0o700 });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		AHDE_MODEL_CHANGE_REF: options.headRef,
		AHDE_MODEL_CHANGE_BASE: options.baseSha,
		AHDE_MODEL_CHANGE_REVISION: options.revision,
		AHDE_MODEL_CHANGE_PROBE_MARKER: marker,
	};
	try {
		git(options.targetDir, ["-c", `core.hooksPath=${options.hooksPath}`, "update-ref", "--stdin"],
			`verify ${options.headRef} ${options.baseSha}\n`, { ...env, AHDE_MODEL_CHANGE_PROBE: "1" });
	} catch {
		// The supported hook intentionally aborts this non-mutating probe.
	}
	if (!existsSync(marker) || readFileSync(marker, "utf8") !== "reference-transaction-ready\n") {
		throw new Error("model selection requires Git reference-transaction hook support; no branch was changed");
	}
	git(options.targetDir, ["-c", `core.hooksPath=${options.hooksPath}`, "merge", "--ff-only", "--no-edit", options.revision],
		undefined, { ...env, AHDE_MODEL_CHANGE_PROBE: "0" });
}
