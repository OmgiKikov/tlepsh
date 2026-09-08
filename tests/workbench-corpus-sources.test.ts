import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	describeDevelopmentCorpusPublication,
	loadDevelopmentCorpusPublicationReceipt,
	publishBuilderDevelopmentCorpus,
} from "../src/application/builder-authoring.js";
import {
	createBuilderCorpusDraft,
	loadBuilderCorpusDraft,
	type BuilderCorpusDraftRevisionOperation,
} from "../src/application/builder-corpus-draft.js";
import { configureEvaluators } from "../src/application/configure-evaluators.js";
import { captureCorpusSourceBinding } from "../src/application/corpus-source.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderView } from "../src/builder/render/view.js";
import { listCorpora, loadCorpus } from "../src/corpus.js";
import * as gitCommands from "../src/git/commands.js";
import { setLanguage, t } from "../src/i18n.js";
import { loadTarget, ModelBlock } from "../src/manifest.js";
import { loadApprovedSpec } from "../src/spec.js";
import {
	corpusSourceFreshness,
	loadWorkbenchCorpusPublication,
} from "../src/workbench/corpus-publication.js";
import {
	createAhdeWorkbench,
	WorkbenchStaleDecisionError,
	type AhdeWorkbenchDependencies,
} from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import { ACTOR_ID, gate, git, NOW, PROJECT_ID, spec, writeDevelopmentEval } from "./helpers/cycle-fixtures.js";

const KB_FILE = "data/kb/refund-policy.md";
const REASON = "Review the refund policy cases";
const EVAL_RUN_ID = "erun_corpus_sources";
const TASK = {
	input: "What is the refund window?",
	expected: "30 days",
	graders: [{ type: "exact" as const, normalize: "trim" as const }],
};
const HOST_JUDGE = {
	selection: { provider: "qwen-mock", modelId: "independent-judge" },
	model: ModelBlock.parse({
		provider: "qwen-mock", id: "independent-judge", api: "openai-completions",
		baseUrl: "http://127.0.0.1:9902/v1", apiKeyEnv: "TEST_JUDGE_KEY",
		thinkingLevel: "off", timeoutMs: 60_000,
	}),
};
const roots: string[] = [];

beforeEach(() => setLanguage("en"));
afterEach(() => {
	vi.restoreAllMocks();
	setLanguage(null);
	for (const root of roots.splice(0)) cleanup(root);
});

async function fixture({ legacy = false, needsJudge = false } = {}) {
	const files = baseFixtureFiles({
		".gitignore": ".ahde/\nruns/\n",
		[KB_FILE]: "Refunds are available within 30 days.\n",
	});
	files.find((file) => file.path === "manifest.yaml")!.content += "data: [data/kb]\n";
	const projectDir = makeTargetFixture(files);
	roots.push(projectDir);
	const paths = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
	const runSuite = vi.fn<AhdeWorkbenchDependencies["runSuite"]>(async () => {
		const corpus = listCorpora({ stateRoot: paths.stateRoot, projectId: PROJECT_ID })
			.find((item) => item.visibility === "development");
		if (!corpus) throw new Error("No development corpus was published before runSuite");
		return writeDevelopmentEval(paths, corpus.id, EVAL_RUN_ID);
	});
	const publish = vi.fn(publishBuilderDevelopmentCorpus);
	const configure = vi.fn(configureEvaluators);
	const restart = () => createAhdeWorkbench({
		...paths, projectId: PROJECT_ID,
		dependencies: { now: () => NOW, runSuite, publishDevelopmentCorpus: publish, configureEvaluators: configure },
	});
	const workbench = restart();
	await workbench.submit({ kind: "spec-draft", spec: spec() });
	const approved = await workbench.decide({ kind: "approve-spec", reason: REASON }, gate());
	const tasks = [{ ...TASK, graders: [...TASK.graders,
		...(needsJudge ? [{ type: "judge" as const, rubric: "Names the refund window in the policy" }] : []),
	] }];
	const draftInput = { name: "Refund policy cases", tasks, revisionSummary: "Read the 30-day refund policy" };
	let draftId: string;
	if (legacy) {
		const approvedSpec = loadApprovedSpec({
			stateRoot: paths.stateRoot, projectId: PROJECT_ID, specId: approved.result.approvedSpecId,
		}).reference;
		draftId = createBuilderCorpusDraft({ ...draftInput, stateRoot: paths.stateRoot, approvedSpec }, { now: () => NOW }).draft.id;
		await workbench.submit({ kind: "select", entity: "corpus-draft", id: draftId });
	} else {
		const turn = await workbench.submit({ kind: "corpus-draft", ...draftInput });
		draftId = String(turn.artifact?.id);
	}
	const draft = loadBuilderCorpusDraft(paths.stateRoot, PROJECT_ID, draftId);
	const commit = (path: string, content: string) => {
		writeFileSync(join(projectDir, path), content);
		git(projectDir, "add", path);
		git(projectDir, "commit", "-qm", `Update ${path}`);
	};
	const changeKb = () => commit(KB_FILE, "Refunds are available within 14 days.\n");
	return { ...paths, workbench, restart, draft, runSuite, publish, configure, commit, changeKb };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function decisionInput(kind: "publish-corpus" | "run-current" | "start-testing") {
	return kind === "publish-corpus" ? { kind, reason: REASON } : { kind, repetitions: 1, reason: REASON };
}

// Warning copy must survive rendering, regardless of terminal line wrapping.
function renderedText(lines: string[]): string {
	return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** Compare all durable state, including receipts, not only the selected corpus. */
function stateFiles(root: string): Record<string, string> {
	if (!existsSync(root)) return {};
	return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			return [path, readFileSync(path, "utf8")];
		}));
}

function expectNoPublication(f: Fixture, before: Record<string, string>) {
	expect(f.runSuite).not.toHaveBeenCalled();
	expect(f.publish).not.toHaveBeenCalled();
	expect(f.configure).not.toHaveBeenCalled();
	expect(listCorpora({ stateRoot: f.stateRoot, projectId: PROJECT_ID })).toEqual([]);
	expect(stateFiles(f.stateRoot)).toEqual(before);
	expect(existsSync(f.runsRoot)).toBe(false);
}

describe("Workbench corpus source binding", () => {
	it("persists the actual declared KB tree with a 30-day exact reference, not the whole commit", async () => {
		const f = await fixture();
		expect(readFileSync(join(f.projectDir, KB_FILE), "utf8")).toBe("Refunds are available within 30 days.\n");
		expect(f.draft).toMatchObject({ schemaVersion: 4, tasks: [TASK], sourceBinding: {
			algorithmId: "declared-kb-trees-v1", targetId: PROJECT_ID,
			roots: [{ path: "data/kb", treeSha: git(f.projectDir, "rev-parse", "HEAD:data/kb") }],
		} });
		expect(f.draft.sourceBinding).toEqual(captureCorpusSourceBinding(loadTarget(f.projectDir)));
		const review = await f.restart().view({ aspect: "review" });
		expect(review.detail?.content).toMatchObject({ kind: "corpus-draft", sourceFreshness: {
			status: "current", binding: f.draft.sourceBinding,
		} });
		for (const language of ["en", "ru"] as const) {
			setLanguage(language);
			expect.soft(renderedText(renderView(review, plainPaint))).toContain(t("corpus.sources.current"));
		}
	});

	describe.each([false, true])("KB committed after drafting (restart: %s)", (restart) => {
		it.each(["publish-corpus", "run-current"] as const)("%s refuses before the gate or runner and writes no corpus or receipt", async (kind) => {
			const f = await fixture();
			f.changeKb();
			setLanguage(restart ? "ru" : "en");
			const workbench = restart ? f.restart() : f.workbench;
			const review = await workbench.view({ aspect: "review" });
			expect(review.detail?.content).toMatchObject({ kind: "corpus-draft", tasks: [TASK], sourceFreshness: {
				status: "changed", binding: captureCorpusSourceBinding(loadTarget(f.projectDir)),
			} });
			expect.soft(renderedText(renderView(review, plainPaint))).toContain(t("corpus.sources.changed"));
			const before = stateFiles(f.stateRoot);
			const human = gate();
			await expect(workbench.decide(decisionInput(kind), human)).rejects.toThrow(t("corpus.sources.changed"));
			expect(human.confirm).not.toHaveBeenCalled();
			expectNoPublication(f, before);
		});
	});

	it.each(["publish-corpus", "run-current"] as const)("%s rechecks a KB commit made during confirmation", async (kind) => {
		const f = await fixture();
		const before = stateFiles(f.stateRoot);
		const human = gate();
		human.confirm.mockImplementationOnce(async (confirmation) => {
			expect(confirmation.subject).toMatchObject({ sourceFreshness: { status: "current", binding: f.draft.sourceBinding } });
			f.changeKb();
			return { approved: true, actorId: ACTOR_ID };
		});
		const decision = f.workbench.decide(decisionInput(kind), human);
		if (kind === "publish-corpus") await expect(decision).rejects.toThrow(t("corpus.sources.changed"));
		else await expect(decision).rejects.toBeInstanceOf(WorkbenchStaleDecisionError);
		expect(human.confirm).toHaveBeenCalledOnce();
		expectNoPublication(f, before);
	});

	it("refuses uncommitted KB edits and permits a new reviewed draft after the source is updated", async () => {
		const f = await fixture();
		writeFileSync(join(f.projectDir, KB_FILE), "Refunds are available within 14 days.\n");
		const human = gate();
		const before = stateFiles(f.stateRoot);
		for (const kind of ["publish-corpus", "run-current"] as const) {
			await expect(f.workbench.decide(decisionInput(kind), human)).rejects.toThrow(t("corpus.sources.unavailable"));
		}
		expect(human.confirm).not.toHaveBeenCalled();
		expectNoPublication(f, before);
		f.changeKb();
		const turn = await f.workbench.submit({ kind: "corpus-draft", name: "Reviewed updated refund policy",
			tasks: [{ ...TASK, expected: "14 days" }], revisionSummary: "Reread the current policy and reviewed all references",
		});
		const current = loadBuilderCorpusDraft(f.stateRoot, PROJECT_ID, String(turn.artifact?.id));
		expect(current.sourceBinding).not.toEqual(f.draft.sourceBinding);
		await f.workbench.decide(decisionInput("publish-corpus"), human);
		const [published] = listCorpora({ stateRoot: f.stateRoot, projectId: PROJECT_ID });
		expect(loadCorpus({ stateRoot: f.stateRoot, projectId: PROJECT_ID, corpusId: published!.id }).tasks[0]!.expected).toBe("14 days");
		expect(loadBuilderCorpusDraft(f.stateRoot, PROJECT_ID, f.draft.id)).toEqual(f.draft);
	});

	it.each(["before", "during"] as const)("start-testing refuses changed KB %s confirmation without configuring the requested judge", async (when) => {
		const f = await fixture({ needsJudge: true });
		const human = gate();
		if (when === "before") f.changeKb();
		else human.confirm.mockImplementationOnce(async () => {
			f.changeKb();
			return { approved: true, actorId: ACTOR_ID };
		});
		const before = stateFiles(f.stateRoot);
		const manifest = readFileSync(join(f.projectDir, "manifest.yaml"), "utf8");
		const decision = f.workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human, { defaultJudge: () => HOST_JUDGE });
		if (when === "before") await expect(decision).rejects.toThrow(t("corpus.sources.changed"));
		else await expect(decision).rejects.toBeInstanceOf(WorkbenchStaleDecisionError);
		expect(human.confirm).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
		expect(readFileSync(join(f.projectDir, "manifest.yaml"), "utf8")).toBe(manifest);
		expectNoPublication(f, before);
	});

	describe.each(["unrelated", "evaluator-only"] as const)("%s commits", (change) => {
		it.each(["publish-corpus", "run-current"] as const)("leave sources current and allow %s after restart", async (kind) => {
			const f = await fixture();
			const initialSha = git(f.projectDir, "rev-parse", "HEAD");
			if (change === "unrelated") f.commit("AGENTS.md", "Answer using the local refund policy.\n");
			else {
				const manifest = readFileSync(join(f.projectDir, "manifest.yaml"), "utf8");
				f.commit("manifest.yaml", manifest.replace("  graders: evals/graders.yaml\n", `  graders: evals/graders.yaml
  judge: ${JSON.stringify(HOST_JUDGE.model)}
`));
			}
			expect(git(f.projectDir, "rev-parse", "HEAD")).not.toBe(initialSha);
			expect(corpusSourceFreshness(f.draft, loadTarget(f.projectDir))).toEqual({ status: "current", binding: f.draft.sourceBinding });
			setLanguage(change === "evaluator-only" ? "ru" : "en");
			const human = gate();
			const result = await f.restart().decide(decisionInput(kind), human);
			expect(human.confirm).toHaveBeenCalledOnce();
			expect(human.confirm.mock.calls[0]![0].subject).toMatchObject({ sourceFreshness: { status: "current" } });
			expect.soft(renderedText(renderConfirmation(human.confirm.mock.calls[0]![0], plainPaint)))
				.toContain(t("corpus.sources.current"));
			expect(f.publish).toHaveBeenCalledOnce();
			expect(f.runSuite).toHaveBeenCalledTimes(kind === "run-current" ? 1 : 0);
			const [corpus] = listCorpora({ stateRoot: f.stateRoot, projectId: PROJECT_ID });
			expect(loadCorpus({ stateRoot: f.stateRoot, projectId: PROJECT_ID, corpusId: corpus!.id }).tasks).toEqual(f.draft.tasks);
			expect(loadWorkbenchCorpusPublication(f.stateRoot, PROJECT_ID, corpus!.id).draftId).toBe(f.draft.id);
			if (kind === "run-current") expect(result.result).toMatchObject({
				resolvedAs: "start-testing", steps: [{ kind: "publish-corpus" }, { kind: "run-eval" }],
				evaluation: { evaluation: { evalRunId: EVAL_RUN_ID } },
			});
		});
	});

	it("keeps the same source binding when start-testing configures an evaluator inside its one consent", async () => {
		const f = await fixture({ needsJudge: true });
		const human = gate();
		const ran = await f.workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human, { defaultJudge: () => HOST_JUDGE });
		expect(ran.result.steps.map((step) => step.kind)).toEqual(["configure-evaluators", "publish-corpus", "run-eval"]);
		expect(ran.result.evaluation?.evaluation.evalRunId).toBe(EVAL_RUN_ID);
		expect(human.confirm).toHaveBeenCalledOnce();
		expect(f.configure).toHaveBeenCalledOnce();
		expect(f.publish).toHaveBeenCalledOnce();
		expect(f.runSuite).toHaveBeenCalledOnce();
		expect(captureCorpusSourceBinding(loadTarget(f.projectDir))).toEqual(f.draft.sourceBinding);
		expect(loadBuilderCorpusDraft(f.stateRoot, PROJECT_ID, f.draft.id)).toEqual(f.draft);
	});

	it.each(["rename", "set-notes", "replace"] as const)("a %s revision cannot erase its parent's staleness", async (type) => {
		const f = await fixture();
		f.changeKb();
		const operation: BuilderCorpusDraftRevisionOperation = type === "rename"
			? { type, name: "Renamed refund cases" }
			: type === "set-notes"
			? { type, coverageNotes: ["Edited after the policy changed"] }
			: { type, taskId: f.draft.tasks[0]!.id, task: { ...TASK, input: "How many days do I have to request a refund?" } };
		const revision = await f.workbench.submit({ kind: "corpus-revision", parentDraftId: f.draft.id,
			operations: [operation], revisionSummary: "Edit the old draft, without rereading sources",
		});
		const child = loadBuilderCorpusDraft(f.stateRoot, PROJECT_ID, String(revision.artifact?.id));
		expect(child).toMatchObject({ schemaVersion: 4, parentDraftId: f.draft.id, sourceBinding: f.draft.sourceBinding });
		expect(child.id).not.toBe(f.draft.id);
		expect(child.tasks[0]!.expected).toBe("30 days");
		expect(loadBuilderCorpusDraft(f.stateRoot, PROJECT_ID, f.draft.id)).toEqual(f.draft);
		const workbench = f.restart();
		expect((await workbench.view({ aspect: "review" })).detail?.content)
			.toMatchObject({ kind: "corpus-draft", id: child.id, sourceFreshness: { status: "changed" } });
		const before = stateFiles(f.stateRoot);
		const human = gate();
		for (const kind of ["publish-corpus", "run-current"] as const) {
			await expect(workbench.decide(decisionInput(kind), human)).rejects.toThrow(t("corpus.sources.changed"));
		}
		expect(human.confirm).not.toHaveBeenCalled();
		expectNoPublication(f, before);
	});

	describe.each(["en", "ru"] as const)("legacy unbound v2 drafts (%s)", (language) => {
		it.each(["publish-corpus", "start-testing"] as const)("show unknown in review and %s confirmation, but permit explicit approval", async (kind) => {
			const f = await fixture({ legacy: true });
			f.changeKb();
			setLanguage(language);
			expect(f.draft.schemaVersion).toBe(2);
			expect(f.draft).not.toHaveProperty("sourceBinding");
			const workbench = f.restart();
			const review = await workbench.view({ aspect: "review" });
			expect(review.detail?.content).toMatchObject({ kind: "corpus-draft", id: f.draft.id,
				sourceFreshness: { status: "unknown", binding: captureCorpusSourceBinding(loadTarget(f.projectDir)) },
			});
			expect.soft(renderedText(renderView(review, plainPaint))).toContain(t("corpus.sources.unknown"));
			const human = gate();
			const result = await workbench.decide(decisionInput(kind), human);
			expect(human.confirm).toHaveBeenCalledOnce();
			const confirmation = human.confirm.mock.calls[0]![0];
			expect(confirmation.kind).toBe(kind);
			expect(confirmation.subject).toMatchObject({ sourceFreshness: { status: "unknown" } });
			expect.soft(renderedText(renderConfirmation(confirmation, plainPaint))).toContain(t("corpus.sources.unknown"));
			expect(f.publish).toHaveBeenCalledOnce();
			expect(f.runSuite).toHaveBeenCalledTimes(kind === "start-testing" ? 1 : 0);
			expect(loadBuilderCorpusDraft(f.stateRoot, PROJECT_ID, f.draft.id)).toEqual(f.draft);
			const [corpus] = listCorpora({ stateRoot: f.stateRoot, projectId: PROJECT_ID });
			expect(loadWorkbenchCorpusPublication(f.stateRoot, PROJECT_ID, corpus!.id).draftId).toBe(f.draft.id);
			if (kind === "start-testing") expect(result.result).toMatchObject({ evaluation: { evaluation: { evalRunId: EVAL_RUN_ID } } });
		});
	});

	it.each(["missing", "unreadable"] as const)("refuses %s committed KB metadata before either gate or any durable write", async (failure) => {
		const f = await fixture();
		if (failure === "missing") {
			// Leave an empty, loadable worktree directory, but no committed source tree.
			unlinkSync(join(f.projectDir, KB_FILE));
			git(f.projectDir, "add", KB_FILE);
			git(f.projectDir, "commit", "-qm", "Remove the declared KB tree");
		} else {
			const realGit = gitCommands.git;
			vi.spyOn(gitCommands, "git").mockImplementation((directory, args, options) => {
				if (directory === f.projectDir && args[0] === "ls-tree" && args.at(-1) === "data/kb") {
					throw new Error("Cannot read committed KB tree metadata");
				}
				return realGit(directory, args, options);
			});
		}
		const workbench = f.restart();
		const review = await workbench.view({ aspect: "review" });
		expect(review.detail?.content).toMatchObject({ kind: "corpus-draft", sourceFreshness: { status: "unavailable", binding: null } });
		for (const language of ["en", "ru"] as const) {
			setLanguage(language);
			expect.soft(renderedText(renderView(review, plainPaint))).toContain(t("corpus.sources.unavailable"));
		}
		const before = stateFiles(f.stateRoot);
		const human = gate();
		for (const kind of ["publish-corpus", "run-current"] as const) {
			await expect(workbench.decide(decisionInput(kind), human)).rejects.toThrow(t("corpus.sources.unavailable"));
		}
		expect(human.confirm).not.toHaveBeenCalled();
		expectNoPublication(f, before);
	});

	it.each(["publish-corpus", "run-current"] as const)("%s cannot recover an already-created publication receipt without lineage after the KB changes", async (kind) => {
		const f = await fixture();
		const subject = describeDevelopmentCorpusPublication({ projectId: PROJECT_ID, name: f.draft.name, tasks: f.draft.tasks });
		// Simulate interruption after the application published, before Workbench wrote lineage.
		const published = publishBuilderDevelopmentCorpus({
			stateRoot: f.stateRoot, projectId: PROJECT_ID, name: f.draft.name, tasks: f.draft.tasks,
			expectedSubjectHash: subject.subjectHash, actor: { kind: "human", id: ACTOR_ID }, reason: REASON,
		}, { now: () => NOW });
		expect(loadDevelopmentCorpusPublicationReceipt(f.stateRoot, PROJECT_ID, published.corpus.id)).toEqual(published.receipt);
		expect(() => loadWorkbenchCorpusPublication(f.stateRoot, PROJECT_ID, published.corpus.id)).toThrow(/no Workbench publication lineage/);
		f.changeKb();
		const workbench = f.restart();
		expect((await workbench.view()).stage).toBe("corpus-review");
		const before = stateFiles(f.stateRoot);
		const human = gate();
		await expect(workbench.decide(decisionInput(kind), human)).rejects.toThrow(t("corpus.sources.changed"));
		expect(human.confirm).not.toHaveBeenCalled();
		expect(f.publish).not.toHaveBeenCalled();
		expect(f.runSuite).not.toHaveBeenCalled();
		expect(stateFiles(f.stateRoot)).toEqual(before);
		expect(listCorpora({ stateRoot: f.stateRoot, projectId: PROJECT_ID })).toEqual([published.corpus]);
		expect(() => loadWorkbenchCorpusPublication(f.stateRoot, PROJECT_ID, published.corpus.id)).toThrow(/no Workbench publication lineage/);
		expect(existsSync(f.runsRoot)).toBe(false);
	});
});
