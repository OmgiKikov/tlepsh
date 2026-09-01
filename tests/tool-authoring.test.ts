import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertToolContract,
	compileToolPackage,
	type ToolAuthoringBrief,
} from "../src/application/tool-authoring.js";
import {
	openBuilderWorkshop,
	type BuilderWorkshop,
} from "../src/application/tool-workshop.js";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import { loadTarget } from "../src/manifest.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) cleanup(root);
});

function targetFixture(): string {
	const dir = makeTargetFixture(baseFixtureFiles());
	roots.push(dir);
	return dir;
}

function workshop(dir: string): BuilderWorkshop {
	const target = loadTarget(dir);
	const authoring = inspectTargetAuthoringContext({
		repositoryDir: dir,
		expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
	});
	return openBuilderWorkshop({
		repositoryDir: dir,
		expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
		authoringContext: authoring.claim,
		binding: { basis: "construction", approvedSpecId: "spec_tool_authoring", source: null },
	});
}

function brief(overrides: Partial<ToolAuthoringBrief> = {}): ToolAuthoringBrief {
	return {
		name: "health_check",
		purpose: "Return whether the external service is healthy.",
		dataSource: "The service health endpoint.",
		parameters: {
			type: "object",
			properties: { simulateError: { type: "boolean" } },
			required: [],
			additionalProperties: false,
		},
		output: {
			format: "json",
			description: "A stable health result.",
			schema: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			},
		},
		errors: [{ condition: "The process cannot answer", behavior: "Exit non-zero and explain the failure on stderr." }],
		permissions: { network: "deny", filesystem: "read-only", process: "sandboxed-subprocess" },
		credentials: [],
		implementation: "#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *'\"simulateError\":true'*) printf 'service unavailable\\n' >&2; exit 2;; esac\nprintf '{\"ok\":true}\\n'\n",
		supportFiles: [],
		fixtures: [
			{ name: "healthy", covers: "happy-path", input: {}, expect: { exitCode: 0, jsonEquals: { ok: true } } },
			{ name: "service-error", covers: "error-handling", input: { simulateError: true }, expect: { exitCode: 2, stderrContains: "service unavailable" } },
		],
		timeoutMs: 10_000,
		maxOutputBytes: 8_192,
		...overrides,
	};
}

describe("conversational Tool Authoring", () => {
	it("compiles a complete canonical package and keeps credential values out of it", () => {
		const dir = targetFixture();
		const target = loadTarget(dir);
		const compiled = compileToolPackage({
			brief: brief({
				permissions: { network: "allow", filesystem: "read-only", process: "sandboxed-subprocess" },
				credentials: [{ id: "api_token", purpose: "Service API token", required: true }],
				implementation: "#!/bin/sh\ntest -n \"${HEALTH_TOKEN:-}\" || exit 2\nprintf '{\"ok\":true}\\n'\n"
					.replace("HEALTH_TOKEN", "{{credential.api_token}}"),
			}),
			credentialBindings: { api_token: "HEALTH_TOKEN" },
			currentExecution: target.manifest.execution,
		});

		expect(compiled.files.map((file) => file.path)).toEqual(expect.arrayContaining([
			"run",
			"tool.yaml",
			"input.schema.json",
			"output.schema.json",
			"contract-tests.json",
			"README.md",
			"fixtures/healthy.json",
			"fixtures/service-error.json",
		]));
		expect(compiled.descriptor.permissions.environment).toEqual(["HEALTH_TOKEN"]);
		expect(compiled.executionPatch).toMatchObject({ network: "allow", environmentAllowlist: ["HEALTH_TOKEN"] });
		expect(compiled.files.find((file) => file.path === "run")?.content).toContain("HEALTH_TOKEN");
		expect(JSON.stringify(compiled)).not.toContain("secret-value");
	});

	it("validates the output schema and every real fixture before close", async () => {
		const dir = targetFixture();
		const target = loadTarget(dir);
		const opened = workshop(dir);
		try {
			const compiled = compileToolPackage({
				brief: brief(),
				credentialBindings: {},
				currentExecution: target.manifest.execution,
			});
			opened.configureToolAuthoringPolicy({
				network: compiled.executionPolicy.network,
				environmentAllowlist: compiled.executionPolicy.environmentAllowlist,
			});
			opened.replaceToolPackage(compiled.brief.name, compiled.files);

			expect(readFileSync(join(opened.path, "tools/health_check/input.schema.json"), "utf8")).toContain("additionalProperties");
			expect(() => opened.compile({ summary: "Add health check", validationPlan: ["Run contract fixtures"] }))
				.toThrow(/contract tests not green.*healthy.*service-error/);

			const observed = await opened.tryTool({ tool: "health_check", input: {}, test: "healthy" });
			const assertion = assertToolContract(
				compiled.fixtures[0]!,
				observed,
				compiled.brief.output.format === "json" ? compiled.brief.output.schema : undefined,
			);
			opened.recordContractAssertion("healthy", assertion.passed, assertion.failures);
			expect(assertion).toEqual({ passed: true, failures: [] });
			const failedObserved = await opened.tryTool({
				tool: "health_check",
				input: { simulateError: true },
				test: "service-error",
			});
			const failedAssertion = assertToolContract(
				compiled.fixtures[1]!,
				failedObserved,
				compiled.brief.output.schema,
			);
			opened.recordContractAssertion("service-error", failedAssertion.passed, failedAssertion.failures);
			expect(failedAssertion).toEqual({ passed: true, failures: [] });
			const proposal = opened.compile({ summary: "Add health check", validationPlan: ["Run contract fixtures"] });
			expect(proposal.proposal.changes.map((change) => change.path)).toEqual(expect.arrayContaining([
				"manifest.yaml",
				"tools/health_check/tool.yaml",
				"tools/health_check/run",
			]));
		} finally {
			opened.dispose();
		}
	});

	it("rejects a pretend output schema before it can become a package", () => {
		const dir = targetFixture();
		expect(() => compileToolPackage({
			brief: brief({
				output: {
					format: "json",
					description: "Invalid schema",
					schema: { type: "object", properties: {}, required: [], additionalProperties: true },
				},
			}),
			credentialBindings: {},
			currentExecution: loadTarget(dir).manifest.execution,
		})).toThrow(/additionalProperties.*must be false/);
	});
});
