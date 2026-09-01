import { join } from "node:path";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchView } from "../workbench/types.js";
import {
	compileVersionPassport,
	renderVersionPassportMarkdown,
} from "../application/version-passport.js";
import { writeTextArtifact } from "../storage/artifacts.js";

type PassportWorkbench = Pick<
	AhdeWorkbench,
	"view" | "projectDir" | "stateRoot" | "runsRoot" | "projectId"
>;

/** The one Builder seam used by conversational Ship and explicit export. */
export async function compileBuilderPassport(
	workbench: PassportWorkbench,
	options: { version?: string; view?: WorkbenchView; save?: boolean } = {},
) {
	const view = options.view ?? await workbench.view();
	const passport = compileVersionPassport({
		runsRoot: workbench.runsRoot,
		stateRoot: workbench.stateRoot,
		projectId: workbench.projectId,
		...(options.version ? { version: options.version } : {}),
		...(view.target.id ? { targetId: view.target.id } : {}),
		model: view.target.model ? { provider: view.target.model.provider, id: view.target.model.id } : null,
	});
	const slug = passport.version.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
	const name = `passport-${slug.startsWith("v") ? slug : `v${slug}`}.md`;
	let written: string | null = null;
	if (options.save === true) {
		written = name;
		try {
			writeTextArtifact(join(workbench.projectDir, name), renderVersionPassportMarkdown(passport));
		} catch {
			// The page remains useful in the Builder even when the checkout is read-only.
			written = null;
		}
	}
	return { passport, written };
}
