// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { resolve } from "node:path";
import { t } from "../../i18n.js";
import { hashValue } from "../../provenance.js";
import { WorkbenchStaleDecisionError } from "../errors.js";
import { exactSame } from "../workbench.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

export async function decideScaffoldTarget(
	host: DecisionHost,
	input: DecisionInputOf<"scaffold-target">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (inventory.target) throw new WorkbenchStaleDecisionError(input.kind);
	if (!host.templateDir) throw new Error("AHDE Builder is missing its trusted starter template");
	const before = host.dependencies.describeTargetScaffold({
		projectDir: host.projectDir,
		templateDir: host.templateDir,
	});
	const actor = await host.confirm(input, gate, t("confirm.title.scaffold-target"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	if (current.target) throw new WorkbenchStaleDecisionError(input.kind);
	const after = host.dependencies.describeTargetScaffold({
		projectDir: host.projectDir,
		templateDir: host.templateDir,
	});
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.applyTargetScaffold({
		projectDir: host.projectDir,
		stateRoot: host.stateRoot,
		templateDir: host.templateDir,
		expectedSubjectHash: hashValue(before),
		actor: { kind: "human", id: actor },
		reason: input.reason,
	});
	return {
		kind: input.kind,
		message: t("message.target-created"),
		result: {
			targetId: result.target.manifest.id,
			targetGitSha: result.target.gitSha,
			receiptId: result.receipt.id,
		},
		view: await host.view(),
	};
}

export async function decideConfigureTarget(
	host: DecisionHost,
	input: DecisionInputOf<"configure-target">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (!inventory.target) throw new WorkbenchStaleDecisionError(input.kind);
	if (!options.resolveTargetModel) {
		throw new Error("Target model selection requires the trusted host model catalog");
	}
	const describe = () => host.dependencies.describeTargetBootstrap({
		targetDir: host.projectDir,
		stateRoot: host.stateRoot,
		runsRoot: host.runsRoot,
		targetId: input.targetId,
		model: options.resolveTargetModel!(input.model),
	});
	const before = describe();
	const actor = await host.confirm(input, gate, t("confirm.title.configure-target"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	if (!current.target) throw new WorkbenchStaleDecisionError(input.kind);
	const after = describe();
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.configureTargetBootstrap({
		targetDir: host.projectDir,
		stateRoot: host.stateRoot,
		runsRoot: host.runsRoot,
		targetId: input.targetId,
		model: after.next.model,
		expectedSubjectHash: before.subjectHash,
		actor: { kind: "human", id: actor },
		reason: input.reason,
	});
	return {
		kind: input.kind,
		message: t("message.target-configured"),
		result: {
			targetId: result.manifest.id,
			targetGitSha: result.receipt.configuredTargetSha,
			receiptId: result.receipt.id,
			credentialEnv: result.manifest.model.apiKeyEnv,
		},
		view: await host.view(),
	};
}

export async function decideConfigureEvaluators(
	host: DecisionHost,
	input: DecisionInputOf<"configure-evaluators">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (!inventory.target) throw new WorkbenchStaleDecisionError(input.kind);
	if (!options.resolveEvaluatorModel) {
		throw new Error("Evaluator model selection requires the trusted host model catalog");
	}
	const resolve = options.resolveEvaluatorModel;
	// Resolved once, before the dialog and again after it: the subject the
	// human approved must still be the subject that gets committed.
	const describe = () => host.dependencies.describeEvaluatorConfiguration({
		targetDir: host.projectDir,
		stateRoot: host.stateRoot,
		...(input.judge ? { judge: resolve("judge", input.judge) } : {}),
		...(input.simulatedUser ? { simulatedUser: resolve("simulatedUser", input.simulatedUser) } : {}),
	});
	const before = describe();
	const actor = await host.confirm(input, gate, t("confirm.title.configure-evaluators"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	if (!current.target) throw new WorkbenchStaleDecisionError(input.kind);
	const after = describe();
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.configureEvaluators({
		targetDir: host.projectDir,
		stateRoot: host.stateRoot,
		...(input.judge ? { judge: after.next.judge } : {}),
		...(input.simulatedUser ? { simulatedUser: after.next.simulatedUser } : {}),
		expectedSubjectHash: before.subjectHash,
		actor: { kind: "human", id: actor },
		reason: input.reason,
	});
	const configured: { role: "judge" | "simulatedUser"; model: string; credentialEnv: string }[] = [];
	if (input.judge && result.manifest.evalSuite.judge) {
		const judge = result.manifest.evalSuite.judge;
		configured.push({ role: "judge", model: `${judge.provider}/${judge.id}`, credentialEnv: judge.apiKeyEnv });
	}
	if (input.simulatedUser && result.manifest.evalSuite.simulatedUser) {
		const user = result.manifest.evalSuite.simulatedUser;
		configured.push({ role: "simulatedUser", model: `${user.provider}/${user.id}`, credentialEnv: user.apiKeyEnv });
	}
	return {
		kind: input.kind,
		message: t("message.evaluators-configured"),
		result: {
			targetGitSha: result.receipt.configuredTargetSha,
			receiptId: result.receipt.id,
			configured,
		},
		view: await host.view(),
	};
}

/**
 * Adopt the agent that is already in this folder.
 *
 * The same describe → confirm → re-describe → `exactSame` → apply shape
 * `scaffold-target` uses, and for the same reason: the operator approves an
 * exact set of files with exact bytes, and anything that moved between the
 * question and the answer invalidates the answer.
 *
 * What differs is what is at stake. A scaffold writes into an empty folder; an
 * adoption writes beside code somebody else owns. So the detector runs again
 * here — if the folder stopped looking like an agent while the dialog was
 * open, there is nothing to adopt.
 */
export async function decideWrapTarget(
	host: DecisionHost,
	input: DecisionInputOf<"wrap-target">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (inventory.target) throw new WorkbenchStaleDecisionError(input.kind);
	const found = host.dependencies.detectAgentFolder(host.projectDir);
	if (!found) throw new Error("no agent was found in this folder to adopt");
	const describe = () => host.dependencies.describeTargetWrap({
		projectDir: host.projectDir,
		found,
		argv: [...input.argv],
		harnessFiles: [...input.harnessFiles],
	});
	const before = describe();
	const actor = await host.confirm(input, gate, t("confirm.title.wrap-target"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	if (current.target) throw new WorkbenchStaleDecisionError(input.kind);
	const after = describe();
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.applyTargetWrap({
		projectDir: host.projectDir,
		stateRoot: host.stateRoot,
		found,
		argv: [...input.argv],
		harnessFiles: [...input.harnessFiles],
		expectedSubjectHash: hashValue(before),
		actor: { kind: "human", id: actor },
		reason: input.reason,
	});
	return {
		kind: input.kind,
		message: t("message.target-adopted"),
		result: {
			targetId: result.target.manifest.id,
			targetGitSha: result.target.gitSha,
			receiptId: result.receipt.id,
			entry: found.entry,
		},
		view: await host.view(),
	};
}
