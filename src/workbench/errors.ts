export class WorkbenchSelectionRequiredError extends Error {
	readonly kind: string;
	readonly choices: readonly string[];

	constructor(kind: string, choices: readonly string[]) {
		super(
			choices.length === 0
				? `No compatible ${kind} is available`
				: `Several compatible ${kind} artifacts exist; select one before continuing`,
		);
		this.name = "WorkbenchSelectionRequiredError";
		this.kind = kind;
		this.choices = choices;
	}
}

export class WorkbenchDecisionDeclinedError extends Error {
	constructor(kind: string) {
		super(`${kind} was declined by the human operator`);
		this.name = "WorkbenchDecisionDeclinedError";
	}
}

export class WorkbenchStaleDecisionError extends Error {
	constructor(kind: string) {
		super(`${kind} subject changed after confirmation; the decision is stale`);
		this.name = "WorkbenchStaleDecisionError";
	}
}
