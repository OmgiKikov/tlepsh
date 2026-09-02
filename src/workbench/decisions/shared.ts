import type { AhdeWorkbench } from "../workbench.js";
import type { WorkbenchDecisionInput, WorkbenchDecisionExecutionOptions, WorkbenchHumanGate, WorkbenchStage } from "../types.js";
import type { WorkbenchInventory } from "../inventory.js";

/** The workbench, seen from a decision handler: its state, its gate, its receipts. */
export type DecisionHost = AhdeWorkbench;

/** The decision input already narrowed to one kind. */
export type DecisionInputOf<K extends WorkbenchDecisionInput["kind"]> = Extract<WorkbenchDecisionInput, { kind: K }>;

/** What `decide()` had already established when it dispatched. */
export interface DecisionContext {
	inventory: WorkbenchInventory;
	stage: WorkbenchStage;
	gate: WorkbenchHumanGate;
	options: WorkbenchDecisionExecutionOptions;
}
