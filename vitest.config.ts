import { defineConfig } from "vitest/config";

// The heavy integration files. Each one either spawns something real — a Git
// repo or worktree, sandbox-exec, a child process, a loopback HTTP server — or
// moves enough bytes through the disk to cost more than ~8 s on its own.
// `--project quick` leaves them out; a plain `vitest run` still runs them.
// When a new test starts spawning things, add its name here: that is the whole
// maintenance rule.
const HEAVY = [
	"tests/workbench-current-finding.test.ts", // Read-only first finding over actual command runs and Git
	"tests/candidate-portability.test.ts", // Copied real Git project and exact candidate re-verification
	"tests/improvement-best.test.ts", // Real private candidate branches, pinned evaluations and crash recovery
	"tests/workbench-model-experiment.test.ts", // Reviewed corpus publication and exact Git authority changes
	"tests/model-experiment.test.ts", // Isolated model variants, real eval records and reviewed model changes
	"tests/evidence-replay.test.ts", // Exact candidate evidence and paired trace fixtures
	"tests/evidence-replay-page.test.ts", // HTTP evidence routes over verified experiment fixtures
	"tests/agent-log.test.ts", // Git repos through the improve fixtures, plus the sealed-holdout repetitions
	"tests/autoloop.test.ts", // Git repos: a whole improve cycle per case
	"tests/builder-pi-closed-loop.test.ts", // Git, and a mock model over HTTP, to close the loop end to end
	"tests/builder-pi-golden.test.ts", // Git, and a mock model over HTTP, for the golden transcript
	"tests/builder-pi-workshop-loop.test.ts", // Git worktrees, and a mock model over HTTP, for the workshop loop
	"tests/builder-proposal.test.ts", // Git worktrees via execFileSync and spawnSync
	"tests/candidate-experiment.test.ts", // a Git branch per experiment
	"tests/candidate-review.test.ts", // a Git branch and commit per candidate
	"tests/cheap-check.test.ts", // Git repos through the improve fixtures
	"tests/configure-evaluators.test.ts", // Git repos for the evaluator round trip
	"tests/container-backend.test.ts", // spawnSync into sandbox-exec
	"tests/cycle-continuation.test.ts", // Git repos, one per interrupted cycle
	"tests/harness-authoring.test.ts", // Git repos for the authoring round trip
	"tests/improvement-brief.test.ts", // spawns nothing: writes and re-reads hundreds of eval artifacts
	"tests/improvement-author.test.ts", // real Pi author loop and Git-backed hypothesis search
	"tests/proposal-search.test.ts",
	"tests/python-agent.test.ts", // spawns the shipped python-agent against a stub HTTP endpoint // Git-backed improve fixtures, one repo per search round
	"tests/regression-guards.test.ts", // Git improve fixtures plus the sealed-holdout repetitions
	"tests/report.test.ts", // spawns nothing: projects hundreds of eval artifacts and traces off disk
	"tests/runner.integration.test.ts", // Git, and a mock model over HTTP per case
	"tests/serve.test.ts", // boots the loopback HTTP server over a Git cycle fixture
	"tests/simulated-user.test.ts", // Git, and a mock model over HTTP, per simulated session
	"tests/target-command-run.test.ts", // spawns a real command Target child per case, sandboxed
	"tests/target-adoption.test.ts",
	"tests/target-wrap.test.ts", // Git repos, one per adopted folder // Git repos, four of them, to adopt an existing Target
	"tests/target-authoring-context.test.ts", // Git repos, and the sandbox the authoring context reports on
	"tests/target-tools.test.ts", // Git, sandbox-exec and a mock model over HTTP
	"tests/tool-authoring.test.ts", // runs a tool package's own fixtures through the sandbox backend
	"tests/tool-workshop.test.ts", // Git worktrees and an HTTP server for the tool broker
	"tests/version-passport.test.ts", // Git repos through the cycle fixtures
	"tests/vertical-slice.test.ts", // Git, a mock model over HTTP, and the sealed-holdout repetitions
	"tests/workbench.test.ts", // dozens of Workbench cycles over a real Git repo
	"tests/workbench-composites.test.ts", // Git worktrees through the cycle fixtures
	"tests/workshop.test.ts", // Git worktrees, sandbox-exec and an HTTP server
	"tests/world-run.test.ts", // Git, sandbox-exec and a mock model over HTTP, one suite per world
	"tests/workbench-production-failure.test.ts", // Git-backed Workbench publication and failure intake
	"tests/passport-presentation.test.ts", // Git-backed released candidates and saved report artifacts
];

export default defineConfig({
	test: {
		// The real Git/process suites saturate the host and starve worker RPC at
		// CPU-count concurrency. Four workers keep the complete gate responsive.
		maxWorkers: 4,
		testTimeout: 120_000,
		// Cycle fixtures drive a real Workbench through Git; a loaded machine must not flake them.
		hookTimeout: 120_000,
		// Two projects that do not overlap, so a plain `vitest run` is still the
		// whole suite with every file run exactly once — `npm test` and
		// `npm run check` are unchanged. `vitest run --project quick` is the fast
		// profile. (`include` belongs on the projects, not here: a root `include`
		// is inherited by every project and would drag the heavy files back in.)
		projects: [
			{ extends: true, test: { name: "quick", include: ["tests/**/*.test.ts"], exclude: HEAVY } },
			{ extends: true, test: { name: "heavy", include: HEAVY } },
		],
	},
});
