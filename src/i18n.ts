import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Host-rendered language.
 *
 * The operator talks to Builder Pi in their own language; everything the HOST
 * draws around that conversation — the header, the three consequential
 * dialogs, the verdicts, the Evidence Explorer — used to be English only, so
 * every yes/no was read in a different language than the question that led to
 * it.
 *
 * Two rules keep this honest:
 *
 *  - Keys are stable ids. An English sentence is never a key, so changing the
 *    English wording is not a schema change and a missing Russian form is a
 *    type error rather than a silent English leak.
 *  - Machine-readable text is not language. Ids, hashes, command names, flags,
 *    file paths, grader type names, gate policy ids and the verdict tokens that
 *    tests and scripts match on (`improved`, `pass`, `underpowered`) stay
 *    exactly as they are; only the human labels rendered around them bend.
 */

export type Language = "en" | "ru";

function isLanguage(value: unknown): value is Language {
	return value === "en" || value === "ru";
}

/**
 * The Builder's own settings file, the same one `resolveBuilderHome` seeds.
 * `AHDE_HOME` moves it, exactly as it moves auth and models.
 */
export function settingsPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
	const configured = env.AHDE_HOME?.trim();
	const builderHome = configured ? resolve(configured, "builder-pi") : join(home, ".ahde", "builder-pi");
	return join(builderHome, "config", "settings.json");
}

/** An unreadable, unparseable or unset `language` is simply no answer. */
function settingsLanguage(env: Record<string, string | undefined>, home: string): Language | null {
	const path = settingsPath(env, home);
	try {
		if (!existsSync(path)) return null;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const value = typeof parsed === "object" && parsed !== null ? (parsed as { language?: unknown }).language : undefined;
		return isLanguage(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Resolution order, highest first: `AHDE_LANG`, the Builder's own
 * `settings.json`, the shell locale, English. An explicit env override wins
 * because it is how one session, one script or one test says otherwise
 * without editing the machine's settings.
 */
export function resolveLanguage(
	env: Record<string, string | undefined> = process.env,
	home = homedir(),
): Language {
	const explicit = env.AHDE_LANG?.trim().toLowerCase();
	if (isLanguage(explicit)) return explicit;
	const configured = settingsLanguage(env, home);
	if (configured) return configured;
	for (const name of ["LC_ALL", "LANG"] as const) {
		if (env[name]?.trim().toLowerCase().startsWith("ru")) return "ru";
	}
	return "en";
}

let current: Language | null = null;

/** The process language, resolved once: a session does not change language mid-render. */
export function language(): Language {
	current ??= resolveLanguage();
	return current;
}

/** Tests and the CLI entry point only: pin the language, or clear it to re-resolve. */
export function setLanguage(next: Language | null): void {
	current = next;
}

export type MessageParams = Record<string, string | number>;

function interpolate(template: string, params: MessageParams | undefined): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
		const value = params[name];
		return value === undefined ? whole : String(value);
	});
}

/**
 * Nouns, keyed by their English singular — a lexicon, not a sentence
 * dictionary. English bends on one boundary, Russian on three, so the count
 * keeps its digits and only the noun changes.
 */
const NOUNS = {
	en: {
		case: ["case", "cases"],
		"development case": ["development case", "development cases"],
		"previously failing case": ["previously failing case", "previously failing cases"],
		"eval run": ["eval run", "eval runs"],
		"open proposal": ["open proposal", "open proposals"],
		candidate: ["candidate", "candidates"],
		"sealed holdout": ["sealed holdout", "sealed holdouts"],
		task: ["task", "tasks"],
		repetition: ["repetition", "repetitions"],
		execution: ["Target execution", "Target executions"],
		cycle: ["cycle", "cycles"],
		file: ["file", "files"],
		job: ["job", "jobs"],
		row: ["row", "rows"],
		item: ["item", "items"],
		minute: ["minute", "minutes"],
	},
	ru: {
		case: ["кейс", "кейса", "кейсов"],
		"development case": ["кейс разработки", "кейса разработки", "кейсов разработки"],
		"previously failing case": ["ранее падавший кейс", "ранее падавших кейса", "ранее падавших кейсов"],
		"eval run": ["прогон", "прогона", "прогонов"],
		"open proposal": ["открытая правка", "открытые правки", "открытых правок"],
		candidate: ["кандидат", "кандидата", "кандидатов"],
		"sealed holdout": ["закрытый экзамен", "закрытых экзамена", "закрытых экзаменов"],
		task: ["задача", "задачи", "задач"],
		repetition: ["повтор", "повтора", "повторов"],
		execution: ["запуск", "запуска", "запусков"],
		cycle: ["цикл", "цикла", "циклов"],
		file: ["файл", "файла", "файлов"],
		job: ["работа", "работы", "работ"],
		row: ["строка", "строки", "строк"],
		item: ["элемент", "элемента", "элементов"],
		minute: ["минута", "минуты", "минут"],
	},
} as const;

export type NounKey = keyof typeof NOUNS.en;

/** Russian plural category: 1 кейс, 2 кейса, 5 кейсов, 11 кейсов. */
function russianForm(count: number): 0 | 1 | 2 {
	const hundreds = Math.abs(count) % 100;
	if (hundreds >= 11 && hundreds <= 14) return 2;
	const tens = hundreds % 10;
	if (tens === 1) return 0;
	if (tens >= 2 && tens <= 4) return 1;
	return 2;
}

/** The bent noun alone, without its count. */
export function noun(count: number, key: NounKey): string {
	if (language() === "ru") return NOUNS.ru[key][russianForm(count)];
	return NOUNS.en[key][count === 1 ? 0 : 1];
}

/** `24 cases` / `24 кейса`. Digits and units never change; the word does. */
export function plural(count: number, key: NounKey): string {
	return `${count} ${noun(count, key)}`;
}

const en = {
	"stage.target-setup": "Target setup",
	"stage.spec-design": "Spec design",
	"stage.spec-review": "Spec review",
	"stage.corpus-design": "Eval design",
	"stage.corpus-review": "Eval review",
	"stage.ready-to-evaluate": "Ready to run",
	"stage.improvement-authoring": "Diagnosis",
	"stage.proposal-review": "Proposal review",
	"stage.candidate-verification": "Candidate verification",
	"stage.candidate-review": "Candidate review",
	"stage.release-decision": "Release decision",
	"stage.candidate-adoption": "Adopt candidate",
	"stage.complete": "Cycle complete",
	"stage.selection-required": "Selection needed",

	"next.target-setup": "Describe the agent you want to build",
	"next.spec-design": "Describe the agent you want",
	"next.spec-review": "Say “ok” to approve it, or what to change",
	"next.corpus-design": "Describe what the agent still needs built, or say “tests” to write the cases",
	"next.corpus-review": "Say “tests” to publish them and run",
	"next.ready-to-evaluate": "Describe what the agent still needs built, or say “tests” to run them",
	"next.improvement-authoring": "Say “fix the first problem”",
	"next.proposal-review": "Say “apply” after reading the diff, or “discard”",
	"next.candidate-verification": "Say “check” to verify the change",
	"next.candidate-review": "Say “ship it” — or “reject”",
	"next.release-decision": "Say “ship it 0.2.0” — or “reject”",
	"next.candidate-adoption": "Say “ship it” to make it the active agent",
	"next.complete": "Say “next” to start the next cycle",
	"next.selection-required": "Select the artifact to continue with",
	"next.interrupted": "Read the interrupted attempt, then say “discard” to abandon it before retrying",
	"next.model-required": "Tell the Builder which model the agent should use",

	"label.target": "Target",
	"label.stage": "Stage",
	"label.next": "Next",
	"label.evidence": "Evidence",
	"label.evaluators": "Evaluators",
	"label.judge": "judge",
	"label.user-model": "user model",
	"label.ship-gate": "Ship gate",
	"label.noise": "Noise",
	"label.blocked": "Blocked",
	"label.warnings": "Warnings",
	"label.selected": "Selected",
	"label.builder-model": "Builder model",
	"label.verdict": "Verdict",
	"label.development": "Development",
	"label.sealed-holdout": "Sealed holdout",
	"label.judge-instrument": "Judge",
	"label.revision": "Revision",
	"label.applied": "Applied",
	"label.diff": "Diff",
	"label.review": "Review",
	"label.promoted": "Promoted",
	"label.rejected": "Rejected",
	"label.adopted": "Adopted",
	"label.cycle": "Cycle",
	"label.reason": "Reason",
	"label.exact-subject": "Exact subject",
	"label.live-trace": "Live trace",
	"label.model": "Model",
	"label.receipt": "Receipt",
	"label.tag": "Tag",
	"label.recommendation": "Recommendation",
	"label.verification": "Verification",
	"label.changes": "Changes",
	"label.risks": "Risks",
	"label.branch": "Branch",
	"label.spec": "Spec",
	"label.basket": "Basket",
	"label.run": "Run",
	"label.estimate": "Estimate",
	"label.version": "Version",
	"label.sealed": "Sealed",
	"label.skipped": "Skipped",
	"label.cheap-check": "Cheap check",
	"label.exact-proposal": "Exact proposal",

	"target.missing": "not created yet",
	"target.model-not-chosen": "model not chosen",
	"target.credential-missing": "({env} missing)",

	"ship-gate.missing": "no sealed holdout",
	"ship-gate.underpowered": "sealed holdout has fewer than {minimum} cases",
	"ship-gate.unavailable": "sealed holdout is unavailable or failed integrity checks",
	"ship-gate.hint": "· /holdout imports an operator-owned JSONL exam (minimum {minimum})",

	"noise.not-calibrated": "not calibrated",
	"noise.hint": "· say “calibrate” or /calibrate",
	"noise.reps": "{count} reps recommended",
	"noise.flip": "flip",

	"header.title": "AHDE Builder",
	"header.tagline": "· build, evaluate, and improve another agent through evidence",
	"header.state-unavailable": "Project state unavailable",
	"header.doctor-hint": "· /doctor for recovery",
	"header.not-connected": "not connected — /login",
	"header.not-connected-suffix": "· not connected — /login",
	"header.help": "Describe what you want in plain language · /help for shortcuts",

	"verdict.improved": "improved",
	"verdict.regressed": "regressed",
	"verdict.unchanged": "unchanged",
	"verdict.inconclusive": "inconclusive",
	"verdict.underpowered": "underpowered",
	"verdict.pass": "pass",
	"verdict.fail": "fail",
	"verdict.promising": "promising",
	"verdict.flat": "flat",

	"unit.points": "pts",
	"unit.ci": "95% CI",
	"unit.cost-ratio": "cost",
	"unit.latency-ratio": "latency",
	"unit.token-ratio": "tokens",

	"candidate.title": "Candidate",
	"candidate.verified": "Candidate verified",
	"candidate.interrupted": "Interrupted candidate",
	"candidate.rejected": "Candidate rejected",
	"candidate.review-recorded": "Review recorded",
	"candidate.not-built": "not built",
	"candidate.not-evaluated": "not evaluated yet",
	"candidate.not-reconstructable": "comparison not reconstructable",
	"candidate.applied-by-loop": "applied by the improvement loop",
	"candidate.applied-by-search": "applied by the proposal search",
	"candidate.applied-automated": "— {actor} authorized the automated trial, not this individual diff",
	"candidate.applied-reviewed": "by {actor}, who read this diff",
	"candidate.not-adopted": "not yet — /adopt fast-forwards the current branch",
	"candidate.cycle-closed": "closed {when}",

	"development.comparison": "baseline {baseline} → candidate {candidate}",
	"development.on-tasks": "on {tasks}",
	"development.score": "· score {before} → {after}",
	"development.improved": "↑ {count} improved",
	"development.lower": "↓ {count} lower",
	"development.unchanged": "= {count} unchanged",
	"development.collapsed": "· {tasks} collapsed",

	"sealed.not-executed": "not executed",
	"sealed.gate-passed": "gate passed",
	"sealed.legacy": "legacy evidence — not promotable",

	"judge.not-calibrated": "not calibrated",
	"judge.label-hint": "· ahde label",
	"judge.label-hint-long": "· ahde label checks it against your own eyes",
	"judge.agreement": "agreement {rate}",

	"confirm.start-testing.title": "Start testing — {parts}",
	"confirm.start-testing.part.approve-spec": "approve the Spec",
	"confirm.start-testing.part.publish-corpus": "publish the eval basket",
	"confirm.start-testing.part.run": "run {runs}",
	"confirm.apply-proposal.title": "Apply exact Builder proposal",
	"confirm.ship.title": "Ship candidate as v{version}",
	"confirm.ship.title-untagged": "Ship this candidate",
	"confirm.question": "{title}?",
	"confirm.discard-proposal": "Discard this proposal? It can never be applied later.",
	"confirm.reject-candidate": "Reject this candidate? The agent stays at its baseline.",
	"confirm.abandon-candidate": "Abandon this interrupted attempt? The applied proposal can be verified again.",
	"confirm.run-eval": "Run {runs} on the reviewed basket?",
	"confirm.calibrate": "Measure noise with {runs}?",
	"confirm.covers": "This one confirmation covers:",
	"confirm.step-record": "Each step still writes its own durable record; the first one that fails stops the rest.",
	"confirm.cost-guard": "{question} {guard}. Continue?",

	"guard.unknown-cost": "no comparable run has finished yet, so {runs} cost an unknown amount",
	"guard.over-cost": "about ${cost} — over the ${bound} routine bound (AHDE_ROUTINE_COST_USD)",
	"guard.over-minutes": "about {minutes} minutes — over the {bound}-minute routine bound (AHDE_ROUTINE_MINUTES)",

	"estimate.unknown": "unknown",
	"estimate.nothing-comparable": "· nothing comparable has run yet",
	"estimate.covenant": "— approving this change also approves that measurement",
	"estimate.under-cent": "under $0.01",
	"estimate.about-cost": "about ${cost}",
	"estimate.under-minute": "under a minute",
	"estimate.about-minutes": "about {minutes}",

	"result.target-created": "Target harness created",
	"result.target-configured": "Target configured",
	"result.evaluators-configured": "Evaluator models configured",
	"result.spec-approved": "Spec approved",
	"result.tests-published": "Tests published",
	"result.basket-published": "Development basket published",
	"result.dataset-imported": "Dataset imported",
	"result.noise-calibrated": "Noise calibrated",
	"result.shipped": "Shipped",
	"result.proposal-applied": "Proposal applied",
	"result.proposal-discarded": "Proposal discarded",
	"result.candidate-abandoned": "Interrupted candidate abandoned",
	"result.candidate-promoted": "Candidate promoted",
	"result.candidate-adopted": "Candidate adopted",
	"result.cycle-closed": "Cycle closed",
	"result.improvement-cycles": "Improvement cycles",
	"result.already-tagged": "already tagged",
	"result.credential-present": "present",
	"result.credential-missing": "missing — export {env} before running",
	"result.simulated-user": "Simulated user",
	"result.retained": "· retained for 15 minutes",
	"result.next-cycle": "Cycle closed · next: {stage}.",
	"result.active-target": "The promoted harness is now the active Target for `ahde target` and the next cycle.",
	"result.checkout-unchanged": "Your checkout was not switched; the candidate lives on its own branch until you adopt it.",
	"result.tag-records": "The tag records the exact reviewed revision. The active Target is unchanged until you /adopt.",
	"result.verify-again": "The applied proposal can be verified again with /run.",
	"result.promotion-yours": "Promotion is yours: say “ship it” to run the sealed guardrail and release.",
	"result.stopped": "Stopped: {reason}.",
	"result.nothing-measured":
		"Nothing was measured: the {executions}-execution verification was not spent. A screen is not a verdict — author another change, or verify anyway with force.",
	"result.draft-landed": "The cases landed in an editable draft; review them, then publish.",
	"result.sealed-held-out": "held out",
	"result.sealed-exam": "· the exam; nobody develops against it",
	"result.sealed-none": "nothing held out",
	"result.sealed-no-exam": "· there is no exam for this file",
	"result.skipped-rows": "did not map to a case",
	"result.active-target-line": "active Target",
	"result.branch": "branch",
	"result.candidate-word": "candidate",
	"result.proposal-word": "proposal",
	"result.stopped-at": "{candidate} · stopped at {status}",
	"result.screen-detail": "{improved} improved · {unchanged} unchanged · {regressed} regressed",
	"result.screen-inconclusive": "· {count} inconclusive",
	"result.screen-over-budget": "· over the infrastructure error budget, so inconclusive",
	"result.screen-shape": "· {cases} × 1 · {detail}",
	"result.pass-rate": "· {executions} · {rate}% pass rate",
	"result.still-needed": "Still needed: {pending}",

	"panel.title": "AHDE · {detail}",
	"panel.diagnosis": "Diagnosis",
	"panel.target": "Target",
	"panel.history": "Already tried",
	"panel.dataset": "Dataset",
	"panel.spec-review": "Spec review",
	"panel.basket-review": "Eval basket review",
	"panel.proposal-review": "Proposal review",
	"panel.applied-proposal": "Applied proposal",
	"panel.candidate-review": "Candidate review",
	"panel.interrupted-candidate": "Interrupted candidate",
	"panel.passport": "Passport",
	"panel.growth": "Growth",
	"panel.help": "AHDE Builder help",
	"panel.doctor": "AHDE Doctor",
	"panel.run-complete": "Run complete",
	"panel.ready-next": "Ready for the next step",
	"panel.cheap-check-nothing": "Cheap check found nothing",
	"panel.candidate-verified": "Candidate verified",
	"panel.shipped": "Shipped",
	"panel.improvement-complete": "Improvement cycles complete",
	"panel.noise-calibrated": "Noise calibrated",
	"panel.target-created": "Target created",
	"panel.target-configured": "Target configured",
	"panel.evaluators-configured": "Evaluator models configured",
	"panel.spec-approved": "Spec approved",
	"panel.basket-published": "Eval basket published",
	"panel.dataset-imported": "Dataset imported",
	"panel.proposal-applied": "Proposal applied",
	"panel.proposal-discarded": "Proposal discarded",
	"panel.attempt-abandoned": "Candidate attempt abandoned",
	"panel.review-recorded": "Review recorded",
	"panel.candidate-promoted": "Candidate promoted",
	"panel.candidate-rejected": "Candidate rejected",
	"panel.candidate-adopted": "Candidate adopted",
	"panel.next-cycle": "Next cycle started",
	"panel.holdout-imported": "Sealed holdout imported",
	"panel.agent-created": "Agent created",
	"panel.agent-configured": "Agent configured",

	"doctor.builder-ok": "Builder model {model} · credential present (provider access is verified on first request)",
	"doctor.builder-no-credential": "Builder model {model} has no credential — /login, or /model to pick a configured model",
	"doctor.builder-none": "No Builder model selected — /login to connect a provider, then /model",
	"doctor.target-missing": "No Target yet — describe the agent and the Builder will create it",
	"doctor.target-bootstrap": "Target exists but its model is not chosen — tell the Builder which model to use",
	"doctor.target-ok": "Target {id} @ {sha}",
	"doctor.target-model-ok": "Target model {model} · {env} is set",
	"doctor.target-model-missing": "Target model {model} · export {env} in the shell that runs ahde before /run",
	"doctor.judge-model": "Judge model",
	"doctor.simulated-user-model": "Simulated-user model",
	"doctor.evaluator-required": "{label} is required by the current basket but not configured",
	"doctor.evaluator-optional": "· {label} not configured · not required by the current basket",
	"doctor.evaluator-ok": "{label} {model} · {env} is set",
	"doctor.evaluator-missing": "{label} {model} · export {env} in the shell that runs ahde before /run",
	"doctor.evaluator-unused": "· {label} {model} · {env} is missing, but this basket does not use it",
	"doctor.gate-ready": "Ship gate has a sufficiently large evaluator-only sealed holdout",
	"doctor.gate-missing": "Ship gate has no sealed holdout — /holdout privately imports one (minimum {minimum} cases)",
	"doctor.gate-underpowered":
		"Ship gate holdout is underpowered — /holdout privately imports a separate exam with at least {minimum} cases",
	"doctor.gate-unavailable":
		"Ship gate holdout is unavailable or failed integrity checks — repair private corpus storage or /holdout privately imports a replacement",
	"doctor.ready": "Ready: everything needed for /run is in place",
	"doctor.action-required": "Action required before the next run",

	"onboarding.builder-needs-model": "AHDE Builder needs a model to talk to you",
	"onboarding.login-choice": "Log in to a provider (OAuth or API key)",
	"onboarding.model-choice": "Pick a model that already has a credential",
	"onboarding.later-choice": "Not now",
	"onboarding.connect-first": "Connect the Builder to a model first: /login, or /model to pick one with a credential.",
	"onboarding.login-hint": "Press Enter to open the provider login. One login serves every AHDE project.",
	"onboarding.model-hint": "Press Enter to open the model picker.",
	"onboarding.connect-anytime": "You can connect any time with /login or /model.",
	"onboarding.no-agent-here": "This folder ({directory}) has no agent yet",
	"onboarding.create-here": "Create the agent here",
	"onboarding.which-model": "Which model should the agent itself use?",
	"onboarding.same-as-builder": " (same as the Builder)",
	"onboarding.other-model": "Another model — I will tell the Builder",
	"onboarding.credential-env": "Environment variable holding the {provider} key for {subject}",
	"onboarding.subject-agent": "the agent",
	"onboarding.subject-judge": "the judge",
	"onboarding.subject-user": "the simulated user",
	"onboarding.describe-now":
		"Now describe what the agent should do, for whom, and what “done” looks like. One question at a time from here.",
	"onboarding.no-agent-yet": "No agent yet. Tell me what you want to build and I will set it up here.",
	"onboarding.agent-no-model": "The agent exists but has no model yet. Tell me which model it should use.",
	"onboarding.setup-fallback": "You can also just tell me what you want to build.",
	"onboarding.state-unreadable": "AHDE could not read project state: {error}\nRun /doctor for recovery guidance.",
	"onboarding.working": "AHDE Builder is working…",

	"explorer.th.task": "Task",
	"explorer.th.rep": "Rep",
	"explorer.th.input": "Input",
	"explorer.th.outcome": "Outcome",
	"explorer.th.score": "Score",
	"explorer.th.graders": "Graders",
	"explorer.th.failure-mode": "Failure mode",
	"explorer.th.tools": "Tools",
	"explorer.th.latency": "Latency",
	"explorer.th.cost": "Cost",
	"explorer.th.tokens": "Tokens",
	"explorer.th.index": "#",
	"explorer.th.answer": "Answer",
	"explorer.th.judge-evidence": "Judge evidence",
	"explorer.th.baseline": "Baseline",
	"explorer.th.candidate": "Candidate",
	"explorer.th.delta": "Delta",
	"explorer.th.flip": "Flip",
	"explorer.h2.runs": "Runs",
	"explorer.h2.failure-modes": "Failure modes",
	"explorer.h2.why": "Why",
	"explorer.h2.run-error": "Run error",
	"explorer.h2.verdict": "Verdict",
	"explorer.h2.conversation": "Conversation",
	"explorer.h2.per-task": "Per-task outcome",
	"explorer.h2.candidates": "Candidates covering this eval",
	"explorer.repetition": "repetition {index}",
	"explorer.candidate-suffix": "candidate",
	"explorer.eval-arm": "this eval is the {role} arm · {verdict}",
	"explorer.mode-count": "{runs} run(s) · {affected}/{total} tasks · {reproduction}% reproduction",

	"why.error":
		"{task} repetition {rep} ended with an infrastructure error, so its evidence is inconclusive rather than a behavioural failure.",
	"why.pass": "{task} repetition {rep} passed: all {graders} grader(s) were satisfied.",
	"why.fail": "{task} repetition {rep} failed: {failed} of {graders} grader(s) did not pass.",
	"why.grader-expected": "{name} ({type}) {expected}; {actual}.",
	"why.grader-plain": "{name} ({type}): {actual}.",
	"why.grader-reason": "The grader recorded: “{reason}”.",
	"why.assertion": "Assertion {index} was answered “{answer}”; the judge's evidence: “{evidence}”.",
	"why.jury": "A jury of {size} decided this grader: {passed} of {size} voted pass.",
	"why.failure-mode":
		"This run is evidence for the failure mode “{title}” ({scope}, {severity}, {affected} of {total} task(s), {reproduction}% reproduction).",
	"why.hypothesis": "Hypothesis, not proof: {hypothesis}",
	"why.flip":
		"{subject} {candidate} re-ran this task: {before} → {after} ({direction}; baseline {baselinePass}/{baselineTotal}, candidate {candidatePass}/{candidateTotal}).",
	"why.flip-subject-aa": "A/A calibration",
	"why.flip-subject-candidate": "Candidate",
	"why.standing-not-run": "not run",
	"why.standing-failed": "failed",
	"why.standing-passed": "passed",
	"why.standing-partial": "{pass}/{total} passed",

	"help.body": `Talk normally: describe the agent you want, answer one useful question at a time,
and AHDE turns the conversation into a reviewed Spec, evaluation cases, runs,
diagnosis, and exact harness changes. Slash commands are shortcuts, not a
requirement.`,
} as const;

export type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
	"stage.target-setup": "Настройка агента",
	"stage.spec-design": "Описание агента",
	"stage.spec-review": "Проверка описания",
	"stage.corpus-design": "Подготовка тестов",
	"stage.corpus-review": "Проверка тестов",
	"stage.ready-to-evaluate": "Готов к прогону",
	"stage.improvement-authoring": "Разбор",
	"stage.proposal-review": "Проверка правки",
	"stage.candidate-verification": "Проверка кандидата",
	"stage.candidate-review": "Обзор кандидата",
	"stage.release-decision": "Решение о выкатке",
	"stage.candidate-adoption": "Принять кандидата",
	"stage.complete": "Цикл закрыт",
	"stage.selection-required": "Нужен выбор",

	"next.target-setup": "Опиши агента, которого хочешь собрать",
	"next.spec-design": "Опиши, какой агент тебе нужен",
	"next.spec-review": "Скажи «ок» или что поправить",
	"next.corpus-design": "Скажи, чего агенту ещё не хватает, или «тесты» — напишу кейсы",
	"next.corpus-review": "Скажи «тесты» — опубликую и прогоню",
	"next.ready-to-evaluate": "Скажи, чего агенту ещё не хватает, или «тесты» — прогоню",
	"next.improvement-authoring": "Скажи «исправь первую проблему»",
	"next.proposal-review": "Прочитай диф и скажи «применить» или «выброси»",
	"next.candidate-verification": "Скажи «проверь» — проверю правку",
	"next.candidate-review": "Скажи «выкатывай» — или «отклонить»",
	"next.release-decision": "Скажи «выкатывай 0.2.0» — или «отклонить»",
	"next.candidate-adoption": "Скажи «выкатывай» — сделаю активным агентом",
	"next.complete": "Скажи «дальше» — начну новый цикл",
	"next.selection-required": "Выбери, с чем продолжить",
	"next.interrupted": "Прочитай прерванную попытку и скажи «выброси» — сброшу её перед новой",
	"next.model-required": "Скажи Билдеру, какую модель должен использовать агент",

	"label.target": "Агент",
	"label.stage": "Стадия",
	"label.next": "Дальше",
	"label.evidence": "Данные",
	"label.evaluators": "Оценщики",
	"label.judge": "судья",
	"label.user-model": "модель пользователя",
	"label.ship-gate": "Порог выкатки",
	"label.noise": "Шум",
	"label.blocked": "Заблокировано",
	"label.warnings": "Предупреждения",
	"label.selected": "Выбрано",
	"label.builder-model": "Модель Билдера",
	"label.verdict": "Вердикт",
	"label.development": "Разработка",
	"label.sealed-holdout": "Экзамен",
	"label.judge-instrument": "Судья",
	"label.revision": "Ревизия",
	"label.applied": "Применил",
	"label.diff": "Диф",
	"label.review": "Обзор",
	"label.promoted": "Выкачено",
	"label.rejected": "Отклонено",
	"label.adopted": "Принято",
	"label.cycle": "Цикл",
	"label.reason": "Причина",
	"label.exact-subject": "Точный предмет",
	"label.live-trace": "Живой трейс",
	"label.model": "Модель",
	"label.receipt": "Квитанция",
	"label.tag": "Тег",
	"label.recommendation": "Рекомендация",
	"label.verification": "Проверка",
	"label.changes": "Изменения",
	"label.risks": "Риски",
	"label.branch": "Ветка",
	"label.spec": "Описание",
	"label.basket": "Тесты",
	"label.run": "Прогон",
	"label.estimate": "Оценка",
	"label.version": "Версия",
	"label.sealed": "Закрыто",
	"label.skipped": "Пропущено",
	"label.cheap-check": "Быстрая проба",
	"label.exact-proposal": "Точная правка",

	"target.missing": "ещё не создан",
	"target.model-not-chosen": "модель не выбрана",
	"target.credential-missing": "({env} не задан)",

	"ship-gate.missing": "нет закрытого экзамена",
	"ship-gate.underpowered": "в закрытом экзамене меньше {minimum} кейсов",
	"ship-gate.unavailable": "закрытый экзамен недоступен или не прошёл проверку целостности",
	"ship-gate.hint": "· /holdout загрузит твой JSONL-экзамен (минимум {minimum})",

	"noise.not-calibrated": "не измерен",
	"noise.hint": "· скажи «измерь шум» или /calibrate",
	"noise.reps": "рекомендую повторов: {count}",
	"noise.flip": "переключений",

	"header.title": "AHDE Билдер",
	"header.tagline": "· собирает, проверяет и улучшает другого агента по данным",
	"header.state-unavailable": "Состояние проекта недоступно",
	"header.doctor-hint": "· /doctor подскажет, как починить",
	"header.not-connected": "не подключена — /login",
	"header.not-connected-suffix": "· не подключена — /login",
	"header.help": "Просто скажи, что нужно · /help — список команд",

	"verdict.improved": "стало лучше",
	"verdict.regressed": "стало хуже",
	"verdict.unchanged": "без изменений",
	"verdict.inconclusive": "неубедительно",
	"verdict.underpowered": "мало данных",
	"verdict.pass": "пройден",
	"verdict.fail": "провален",
	"verdict.promising": "обещает",
	"verdict.flat": "ровно",

	"unit.points": "п.п.",
	"unit.ci": "95% ДИ",
	"unit.cost-ratio": "цена",
	"unit.latency-ratio": "задержка",
	"unit.token-ratio": "токены",

	"candidate.title": "Кандидат",
	"candidate.verified": "Кандидат проверен",
	"candidate.interrupted": "Прерванный кандидат",
	"candidate.rejected": "Кандидат отклонён",
	"candidate.review-recorded": "Обзор записан",
	"candidate.not-built": "не собран",
	"candidate.not-evaluated": "ещё не проверялся",
	"candidate.not-reconstructable": "сравнение не восстановить",
	"candidate.applied-by-loop": "применено циклом улучшений",
	"candidate.applied-by-search": "применено поиском правок",
	"candidate.applied-automated": "— {actor} разрешил автоматический прогон, а не именно этот диф",
	"candidate.applied-reviewed": "{actor}, который прочитал этот диф",
	"candidate.not-adopted": "ещё нет — /adopt переведёт текущую ветку",
	"candidate.cycle-closed": "закрыт {when}",

	"development.comparison": "было {baseline} → кандидат {candidate}",
	"development.on-tasks": "на {tasks}",
	"development.score": "· балл {before} → {after}",
	"development.improved": "↑ {count} лучше",
	"development.lower": "↓ {count} хуже",
	"development.unchanged": "= {count} без изменений",
	"development.collapsed": "· {tasks} сломалось",

	"sealed.not-executed": "не прогонялся",
	"sealed.gate-passed": "порог пройден",
	"sealed.legacy": "старые данные — выкатить нельзя",

	"judge.not-calibrated": "не откалиброван",
	"judge.label-hint": "· ahde label",
	"judge.label-hint-long": "· ahde label сверит его с твоими глазами",
	"judge.agreement": "согласие {rate}",

	"confirm.start-testing.title": "Начать тесты — {parts}",
	"confirm.start-testing.part.approve-spec": "одобрить описание",
	"confirm.start-testing.part.publish-corpus": "опубликовать {cases}",
	"confirm.start-testing.part.run": "прогнать {runs}",
	"confirm.apply-proposal.title": "Применить эту правку",
	"confirm.ship.title": "Выкатить как v{version}",
	"confirm.ship.title-untagged": "Выкатить этого кандидата",
	"confirm.question": "{title}?",
	"confirm.discard-proposal": "Выбросить эту правку? Применить её потом будет нельзя.",
	"confirm.reject-candidate": "Отклонить этого кандидата? Агент останется на прежней версии.",
	"confirm.abandon-candidate": "Сбросить прерванную попытку? Применённую правку можно проверить снова.",
	"confirm.run-eval": "Прогнать {runs} на проверенных тестах?",
	"confirm.calibrate": "Измерить шум — {runs}?",
	"confirm.covers": "Это одно подтверждение включает:",
	"confirm.step-record": "Каждый шаг пишет свою запись; первый упавший останавливает остальные.",
	"confirm.cost-guard": "{question} {guard}. Продолжить?",

	"guard.unknown-cost": "сравнимых прогонов ещё не было, поэтому {runs} стоят неизвестно сколько",
	"guard.over-cost": "около ${cost} — больше рутинного порога ${bound} (AHDE_ROUTINE_COST_USD)",
	"guard.over-minutes": "около {minutes} минут — больше рутинного порога {bound} минут (AHDE_ROUTINE_MINUTES)",

	"estimate.unknown": "неизвестно",
	"estimate.nothing-comparable": "· сравнимых прогонов ещё не было",
	"estimate.covenant": "— одобряя правку, ты одобряешь и эту проверку",
	"estimate.under-cent": "меньше $0.01",
	"estimate.about-cost": "около ${cost}",
	"estimate.under-minute": "меньше минуты",
	"estimate.about-minutes": "около {minutes}",

	"result.target-created": "Агент создан",
	"result.target-configured": "Агент настроен",
	"result.evaluators-configured": "Модели оценщиков настроены",
	"result.spec-approved": "Описание одобрено",
	"result.tests-published": "Тесты опубликованы",
	"result.basket-published": "Тесты разработки опубликованы",
	"result.dataset-imported": "Данные загружены",
	"result.noise-calibrated": "Шум измерен",
	"result.shipped": "Выкачено",
	"result.proposal-applied": "Правка применена",
	"result.proposal-discarded": "Правка выброшена",
	"result.candidate-abandoned": "Прерванный кандидат сброшен",
	"result.candidate-promoted": "Кандидат выкачен",
	"result.candidate-adopted": "Кандидат принят",
	"result.cycle-closed": "Цикл закрыт",
	"result.improvement-cycles": "Циклы улучшений",
	"result.already-tagged": "тег уже стоит",
	"result.credential-present": "задан",
	"result.credential-missing": "не задан — экспортируй {env} перед прогоном",
	"result.simulated-user": "Модель пользователя",
	"result.retained": "· живёт 15 минут",
	"result.next-cycle": "Цикл закрыт · дальше: {stage}.",
	"result.active-target": "Выкаченный агент теперь активен для `ahde target` и следующего цикла.",
	"result.checkout-unchanged": "Твой рабочий каталог не переключали; кандидат живёт на своей ветке, пока ты его не примешь.",
	"result.tag-records": "Тег фиксирует именно проверенную ревизию. Активный агент не меняется до /adopt.",
	"result.verify-again": "Применённую правку можно проверить снова через /run.",
	"result.promotion-yours": "Выкатка за тобой: скажи «выкатывай» — прогоню закрытый экзамен и выпущу.",
	"result.stopped": "Остановлено: {reason}.",
	"result.nothing-measured":
		"Ничего не измерено: проверка на {executions} не потрачена. Проба — не вердикт: сделай другую правку или проверь принудительно.",
	"result.draft-landed": "Кейсы легли в черновик — посмотри их и опубликуй.",
	"result.sealed-held-out": "отложено",
	"result.sealed-exam": "· это экзамен; против него никто не разрабатывает",
	"result.sealed-none": "ничего не отложено",
	"result.sealed-no-exam": "· для этого файла экзамена нет",
	"result.skipped-rows": "не превратились в кейсы",
	"result.active-target-line": "активный агент",
	"result.branch": "ветка",
	"result.candidate-word": "кандидат",
	"result.proposal-word": "правка",
	"result.stopped-at": "{candidate} · остановлен на {status}",
	"result.screen-detail": "{improved} лучше · {unchanged} без изменений · {regressed} хуже",
	"result.screen-inconclusive": "· {count} неубедительно",
	"result.screen-over-budget": "· превышен бюджет инфраструктурных ошибок, поэтому неубедительно",
	"result.screen-shape": "· {cases} × 1 · {detail}",
	"result.pass-rate": "· {executions} · {rate}% проходит",
	"result.still-needed": "Ещё нужно: {pending}",

	"panel.title": "AHDE · {detail}",
	"panel.diagnosis": "Разбор",
	"panel.target": "Агент",
	"panel.history": "Что уже пробовали",
	"panel.dataset": "Данные",
	"panel.spec-review": "Проверка описания",
	"panel.basket-review": "Проверка тестов",
	"panel.proposal-review": "Проверка правки",
	"panel.applied-proposal": "Применённая правка",
	"panel.candidate-review": "Обзор кандидата",
	"panel.interrupted-candidate": "Прерванный кандидат",
	"panel.passport": "Паспорт",
	"panel.growth": "Рост",
	"panel.help": "Справка AHDE Билдера",
	"panel.doctor": "Диагностика AHDE",
	"panel.run-complete": "Прогон закончен",
	"panel.ready-next": "Готов к следующему шагу",
	"panel.cheap-check-nothing": "Быстрая проба ничего не нашла",
	"panel.candidate-verified": "Кандидат проверен",
	"panel.shipped": "Выкачено",
	"panel.improvement-complete": "Циклы улучшений закончены",
	"panel.noise-calibrated": "Шум измерен",
	"panel.target-created": "Агент создан",
	"panel.target-configured": "Агент настроен",
	"panel.evaluators-configured": "Модели оценщиков настроены",
	"panel.spec-approved": "Описание одобрено",
	"panel.basket-published": "Тесты опубликованы",
	"panel.dataset-imported": "Данные загружены",
	"panel.proposal-applied": "Правка применена",
	"panel.proposal-discarded": "Правка выброшена",
	"panel.attempt-abandoned": "Попытка сброшена",
	"panel.review-recorded": "Обзор записан",
	"panel.candidate-promoted": "Кандидат выкачен",
	"panel.candidate-rejected": "Кандидат отклонён",
	"panel.candidate-adopted": "Кандидат принят",
	"panel.next-cycle": "Новый цикл начат",
	"panel.holdout-imported": "Закрытый экзамен загружен",
	"panel.agent-created": "Агент создан",
	"panel.agent-configured": "Агент настроен",

	"doctor.builder-ok": "Модель Билдера {model} · ключ задан (доступ проверяется на первом запросе)",
	"doctor.builder-no-credential": "У модели Билдера {model} нет ключа — /login или /model, чтобы выбрать настроенную",
	"doctor.builder-none": "Модель Билдера не выбрана — /login подключит провайдера, затем /model",
	"doctor.target-missing": "Агента ещё нет — опиши его, и Билдер создаст",
	"doctor.target-bootstrap": "Агент есть, но модель не выбрана — скажи Билдеру, какую использовать",
	"doctor.target-ok": "Агент {id} @ {sha}",
	"doctor.target-model-ok": "Модель агента {model} · {env} задан",
	"doctor.target-model-missing": "Модель агента {model} · экспортируй {env} в той же оболочке, где запускаешь ahde, до /run",
	"doctor.judge-model": "Модель судьи",
	"doctor.simulated-user-model": "Модель пользователя",
	"doctor.evaluator-required": "{label} нужна текущим тестам, но не настроена",
	"doctor.evaluator-optional": "· {label} не настроена · текущим тестам не нужна",
	"doctor.evaluator-ok": "{label} {model} · {env} задан",
	"doctor.evaluator-missing": "{label} {model} · экспортируй {env} в той же оболочке, где запускаешь ahde, до /run",
	"doctor.evaluator-unused": "· {label} {model} · {env} не задан, но эти тесты его не используют",
	"doctor.gate-ready": "У порога выкатки есть достаточно большой закрытый экзамен",
	"doctor.gate-missing": "У порога выкатки нет закрытого экзамена — /holdout загрузит его приватно (минимум {minimum} кейсов)",
	"doctor.gate-underpowered":
		"Закрытый экзамен слишком мал — /holdout загрузит приватно отдельный экзамен минимум на {minimum} кейсов",
	"doctor.gate-unavailable":
		"Закрытый экзамен недоступен или не прошёл проверку целостности — починить приватное хранилище или /holdout загрузит замену",
	"doctor.ready": "Готово: всё для /run на месте",
	"doctor.action-required": "Перед следующим прогоном нужно кое-что сделать",

	"onboarding.builder-needs-model": "AHDE Билдеру нужна модель, чтобы говорить с тобой",
	"onboarding.login-choice": "Войти к провайдеру (OAuth или API-ключ)",
	"onboarding.model-choice": "Выбрать модель, у которой уже есть ключ",
	"onboarding.later-choice": "Не сейчас",
	"onboarding.connect-first": "Сначала подключи Билдера к модели: /login, или /model — выбрать ту, у которой есть ключ.",
	"onboarding.login-hint": "Нажми Enter — откроется вход к провайдеру. Один вход работает во всех проектах AHDE.",
	"onboarding.model-hint": "Нажми Enter — откроется выбор модели.",
	"onboarding.connect-anytime": "Подключиться можно в любой момент: /login или /model.",
	"onboarding.no-agent-here": "В этой папке ({directory}) агента ещё нет",
	"onboarding.create-here": "Создать агента здесь",
	"onboarding.which-model": "Какую модель должен использовать сам агент?",
	"onboarding.same-as-builder": " (та же, что у Билдера)",
	"onboarding.other-model": "Другую модель — скажу Билдеру",
	"onboarding.credential-env": "Переменная окружения с ключом {provider} для {subject}",
	"onboarding.subject-agent": "агента",
	"onboarding.subject-judge": "судьи",
	"onboarding.subject-user": "модели пользователя",
	"onboarding.describe-now":
		"Теперь опиши, что агент должен делать, для кого и что считается «готово». Дальше — по одному вопросу.",
	"onboarding.no-agent-yet": "Агента пока нет. Скажи, что хочешь собрать, и я всё настрою здесь.",
	"onboarding.agent-no-model": "Агент есть, но модели у него нет. Скажи, какую использовать.",
	"onboarding.setup-fallback": "Или просто скажи, что хочешь собрать.",
	"onboarding.state-unreadable": "AHDE не смог прочитать состояние проекта: {error}\n/doctor подскажет, как починить.",
	"onboarding.working": "AHDE Билдер работает…",

	"explorer.th.task": "Задача",
	"explorer.th.rep": "Повтор",
	"explorer.th.input": "Вход",
	"explorer.th.outcome": "Итог",
	"explorer.th.score": "Балл",
	"explorer.th.graders": "Проверки",
	"explorer.th.failure-mode": "Тип сбоя",
	"explorer.th.tools": "Инструменты",
	"explorer.th.latency": "Задержка",
	"explorer.th.cost": "Цена",
	"explorer.th.tokens": "Токены",
	"explorer.th.index": "№",
	"explorer.th.answer": "Ответ",
	"explorer.th.judge-evidence": "Обоснование судьи",
	"explorer.th.baseline": "База",
	"explorer.th.candidate": "Кандидат",
	"explorer.th.delta": "Разница",
	"explorer.th.flip": "Переключение",
	"explorer.h2.runs": "Прогоны",
	"explorer.h2.failure-modes": "Типы сбоев",
	"explorer.h2.why": "Почему",
	"explorer.h2.run-error": "Ошибка прогона",
	"explorer.h2.verdict": "Вердикт",
	"explorer.h2.conversation": "Диалог",
	"explorer.h2.per-task": "Итог по задачам",
	"explorer.h2.candidates": "Кандидаты по этим тестам",
	"explorer.repetition": "повтор {index}",
	"explorer.candidate-suffix": "кандидат",
	"explorer.eval-arm": "эти тесты — {role}-плечо · {verdict}",
	"explorer.mode-count": "прогонов: {runs} · задач: {affected}/{total} · воспроизводится в {reproduction}%",

	"why.error":
		"{task}, повтор {rep}: инфраструктурная ошибка, поэтому данные неубедительны, а не показывают сбой поведения.",
	"why.pass": "{task}, повтор {rep}: пройден, все проверки ({graders}) удовлетворены.",
	"why.fail": "{task}, повтор {rep}: провален, не прошли {failed} из {graders} проверок.",
	"why.grader-expected": "{name} ({type}) {expected}; {actual}.",
	"why.grader-plain": "{name} ({type}): {actual}.",
	"why.grader-reason": "Проверка записала: «{reason}».",
	"why.assertion": "На утверждение {index} ответ «{answer}»; обоснование судьи: «{evidence}».",
	"why.jury": "Проверку решала коллегия из {size}: за «пройдено» — {passed} из {size}.",
	"why.failure-mode":
		"Этот прогон — данные для типа сбоя «{title}» ({scope}, {severity}, задач: {affected} из {total}, воспроизводится в {reproduction}%).",
	"why.hypothesis": "Гипотеза, не доказательство: {hypothesis}",
	"why.flip":
		"{subject} {candidate} прогнал эту задачу заново: {before} → {after} ({direction}; база {baselinePass}/{baselineTotal}, кандидат {candidatePass}/{candidateTotal}).",
	"why.flip-subject-aa": "Замер шума A/A",
	"why.flip-subject-candidate": "Кандидат",
	"why.standing-not-run": "не прогонялась",
	"why.standing-failed": "провалена",
	"why.standing-passed": "пройдена",
	"why.standing-partial": "пройдена {pass}/{total}",

	"help.body": `Говори обычными словами: опиши агента, который нужен, отвечай по одному
вопросу за раз — AHDE превратит разговор в проверенное описание, тестовые
кейсы, прогоны, разбор и точные правки харнесса. Слэш-команды — это
сокращения, а не обязанность.`,
};

const TABLES: Record<Language, Partial<Record<MessageKey, string>>> = { en, ru };

/**
 * One localized string. A key with no form in the active language falls back
 * to English rather than to its own id: an operator reading a familiar English
 * label is a smaller failure than one reading `label.sealed-holdout`.
 */
export function t(key: MessageKey, params?: MessageParams): string {
	return interpolate(TABLES[language()][key] ?? en[key], params);
}

/** The human label for a verdict token; the token itself never changes. */
export function verdictLabel(verdict: string): string {
	const key = `verdict.${verdict}` as MessageKey;
	return key in en ? t(key) : verdict;
}
