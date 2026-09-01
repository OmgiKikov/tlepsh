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
		"recorded answer": ["recorded answer", "recorded answers"],
		"eval run": ["eval run", "eval runs"],
		"open proposal": ["open proposal", "open proposals"],
		candidate: ["candidate", "candidates"],
		"sealed holdout": ["sealed holdout", "sealed holdouts"],
		task: ["task", "tasks"],
		repetition: ["repetition", "repetitions"],
		execution: ["Target execution", "Target executions"],
		cycle: ["cycle", "cycles"],
		file: ["file", "files"],
		tool: ["tool", "tools"],
		skill: ["skill", "skills"],
		try: ["try", "tries"],
		job: ["job", "jobs"],
		row: ["row", "rows"],
		item: ["item", "items"],
		example: ["example", "examples"],
		minute: ["minute", "minutes"],
	},
	ru: {
		case: ["кейс", "кейса", "кейсов"],
		"development case": ["кейс разработки", "кейса разработки", "кейсов разработки"],
		"previously failing case": ["ранее падавший кейс", "ранее падавших кейса", "ранее падавших кейсов"],
		"recorded answer": ["записанный ответ", "записанных ответа", "записанных ответов"],
		"eval run": ["прогон", "прогона", "прогонов"],
		"open proposal": ["открытая правка", "открытые правки", "открытых правок"],
		candidate: ["кандидат", "кандидата", "кандидатов"],
		"sealed holdout": ["закрытый экзамен", "закрытых экзамена", "закрытых экзаменов"],
		task: ["задача", "задачи", "задач"],
		repetition: ["повтор", "повтора", "повторов"],
		execution: ["запуск", "запуска", "запусков"],
		cycle: ["цикл", "цикла", "циклов"],
		file: ["файл", "файла", "файлов"],
		tool: ["инструмент", "инструмента", "инструментов"],
		skill: ["скилл", "скилла", "скиллов"],
		try: ["запуск", "запуска", "запусков"],
		job: ["работа", "работы", "работ"],
		row: ["строка", "строки", "строк"],
		item: ["элемент", "элемента", "элементов"],
		example: ["пример", "примера", "примеров"],
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
	"label.tool-key": "Tool key",
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
	"label.exam": "Exam",
	"label.source": "Source",
	"label.cost": "Cost",
	"label.draft": "Draft",
	"label.skipped": "Skipped",
	"label.cheap-check": "Cheap check",
	"label.exact-proposal": "Exact proposal",
	"label.base": "base",

	"target.missing": "not created yet",
	"target.model-not-chosen": "model not chosen",
	"target.credential-missing": "({env} missing)",

	"ship-gate.missing": "no sealed holdout",
	"ship-gate.underpowered": "sealed holdout has fewer than {minimum} cases",
	"ship-gate.unavailable": "sealed holdout is unavailable or failed integrity checks",
	"ship-gate.hint": "· /holdout imports an operator-owned JSONL exam (minimum {minimum})",
	// Only where there is no exam at all is “have one written” the right next
	// move: an underpowered or broken one is repaired, not replaced by a guess.
	"ship-gate.hint-none": "· /holdout imports your JSONL exam (minimum {minimum}) · or lets the judge write one",

	"noise.not-calibrated": "not calibrated",
	"noise.hint": "· say “calibrate” or /calibrate",
	"noise.reps": "{count} reps recommended",
	"noise.flip": "flip",

	"header.title": "AHDE Builder",
	"header.tagline": "· build, evaluate, and improve another agent through evidence",
	"header.state-unavailable": "Project state unavailable",
	"header.not-connected": "not connected — connect a model to continue",
	"header.not-connected-suffix": "· not connected",
	"header.help": "Describe what you want in plain language",

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

	// Predicted impact: the falsifiable number a change is judged against.
	"label.prediction": "Prediction",
	"prediction.expect": "Expecting",
	"prediction.mode": "mode «{mode}» {from}/{of} → ≤{to}/{of}",
	"prediction.overall": "overall {delta}",
	"prediction.none": "no prediction stated",
	"prediction.mode-outcome": "predicted ≤{expected}/{of} · got {actual}/{of}",
	"prediction.mode-unpredicted": "no prediction · got {actual}/{of}",
	"prediction.overall-outcome": "predicted {predicted} · got {actual}",
	"prediction.overall-unmeasured": "predicted {predicted} · nothing comparable measured yet",
	"prediction.interval": "(CI {low} … {high})",
	"prediction.calibration": "Builder predicts: {hits}/{total} hit · error ±{error} · {strip}",
	"prediction.calibration-none": "Builder predicts: nothing decided has carried a prediction yet",
	"prediction.passport": "Promised {predicted} · got {actual}",
	"prediction.passport-unmeasured": "Promised {predicted} · nothing comparable was measured",

	"judge.not-calibrated": "not calibrated",
	"judge.label-hint": "· ahde label",
	"judge.label-hint-long": "· ahde label checks it against your own eyes",
	"judge.agreement": "agreement {rate}",
	"judge.agrees-with-you": "agrees with you {rate}",

	// The judge calibration exercise: one answer at a time, blind, then the
	// reveal. Every string here is read mid-exercise, so none of them may name a
	// stage, a hash, or a grader type.
	"label.no-judge": "There is nothing to check the judge on — the tests have no judge graders",
	"label.panel": "Judge {ordinal}/{total}",
	"label.done": "Judge checked",
	"label.field.request": "what they asked",
	"label.field.goal": "the goal",
	"label.field.answer": "the agent answered",
	"label.field.conversation": "the conversation",
	"label.field.reference": "reference answer",
	"label.field.rubric": "the rubric the judge was given",
	"label.field.assertions": "the checklist the judge answered",
	"label.legacy": "the basket that graded this run is out of scope, so the judge's own rubric cannot be shown",
	"label.ask": "Your verdict — before you see the judge's",
	"label.ask-assertion": "{index}/{total} · {assertion}",
	"label.ask-note": "What was wrong? (optional)",
	"label.choice.good": "good",
	"label.choice.bad": "bad",
	"label.choice.skip": "skip",
	"label.choice.stop": "stop",
	"label.choice.yes": "yes",
	"label.choice.no": "no",
	"label.choice.unknown": "don't know",
	"label.reveal": "the judge said: {verdict} · {agreement}",
	"label.reveal-agrees": "agrees with you",
	"label.reveal-disagrees": "DISAGREES with you",
	"label.reveal-assertion": "{index}. you said {human} · the judge said {judge}",
	"label.stopped": "Stopped — {labelled} answered, {left} left.",
	"label.nothing": "Nothing was answered, so nothing was written.",
	"label.all-labelled": "You have already answered every judged case in this run",
	"label.summary": "agreement {rate} · κ {kappa} · n={n}",
	"label.by-grader": "by rubric:",
	"label.perfect": "The judge agreed with you every time.",
	"label.meaning": "The judge is wrong about one answer in {ratio}; {direction}",
	"label.meaning-misses-failures": "it catches failures worse than successes.",
	"label.meaning-invents-failures": "it fails answers you would have passed.",
	"label.meaning-both": "it errs in both directions equally.",
	"label.next-more": "Another {count} answers will sharpen the number",
	"label.next-enough": "That is enough to trust the judge at release",

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
	"confirm.regrade": "Re-score {answers} with the revised graders? The Target is not called again; only the judge is paid.",
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
	// The re-score, in the words an operator used to ask for it: what the new
	// rubric would have said about answers that are already paid for.
	"result.regraded": "Re-scored",
	"regrade.was-now": "was {before} \u2192 now {after}",
	"regrade.no-target": "the Target was not called",
	"regrade.now-passing": "now passing",
	"regrade.now-failing": "now failing",
	"regrade.unchanged": "unchanged",
	"regrade.score": "score",
	"regrade.rubrics": "rubrics rewritten: {count}",
	"regrade.no-change": "no verdict moved",
	"regrade.sealed": "sealed evidence: which answers moved stays withheld",
	"regrade.more": "\u2026 +{count} more",
	"regrade.assertion": "assertion {index} now {answer}",
	"regrade.yes": "yes",
	"regrade.no": "no",
	"regrade.grader-passes": "now passes",
	"regrade.grader-fails": "now fails",
	"regrade.not-a-baseline": "This is a re-score, not a new baseline: to measure a candidate on the new graders, re-score the baseline with the same set.",
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
	"result.tag-records": "The tag records the exact reviewed revision. The active agent is unchanged until you ask to adopt it.",
	"result.verification-blocked": "Automatic verification blocked",
	"result.passport-unavailable": "Passport unavailable: {reason}",
	"result.contract-cases": "I added {count} contract cases for {tool}; publish them with the next test.",
	"handoff.talk-to-agent": "Talk to the agent: ahde target (in a new terminal)",
	"result.verify-again": "The applied proposal can be verified again whenever you ask to check it.",
	"result.promotion-yours": "Promotion is yours: say “ship it” to run the sealed guardrail and release.",
	"result.stopped": "Stopped: {reason}.",
	"result.nothing-measured":
		"Nothing was measured: the {executions}-execution verification was not spent. A screen is not a verdict — author another change, or verify anyway with force.",
	"result.draft-landed": "The cases landed in an editable draft; review them, then publish.",
	"result.sealed-held-out": "held out",
	"result.sealed-exam": "· the exam; nobody develops against it",
	"result.sealed-none": "nothing held out",
	"result.sealed-no-exam": "· there is no exam for this file",

	// The exam the judge writes: the dialog that asks for it, the panel that
	// reports it, and the one line a passport says about where it came from.
	"generate-holdout.by-judge": "{cases} · written by the judge {generator}",
	"generate-holdout.source": "the agent's description + {examples} from the tests (shape only)",
	"generate-holdout.source-spec-only": "the agent's description alone (no examples)",
	"generate-holdout.blind": "The Builder never sees the content; only the case count reaches the conversation",
	"generate-holdout.draft": "Draft — to a file outside the repo; you edit it and import it with /holdout",
	"generate-holdout.sealed-note": "Nobody in the improvement loop reads these cases; the exam stays evaluator-only.",
	"generate-holdout.draft-next": "Read it, edit out what is wrong, then run /holdout on that file to seal it.",
	"generate-holdout.underpowered": "An exam of {cases} can only ever say “underpowered”; the ship gate needs at least {minimum}.",
	"holdout.choose": "Where should the sealed exam come from?",
	"holdout.import-file": "Import a file",
	"holdout.generate-seal": "Generate with the judge",
	"holdout.generate-review": "Generate a draft to review",
	"holdout.how-many": "How many cases? (minimum {minimum})",
	"holdout.reason": "the operator asked for a sealed exam with /holdout",
	"passport.exam-generated": "generated by the judge, sealed unreviewed",
	"passport.exam-generated-reviewed": "generated by the judge, reviewed by the operator",
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
	"panel.runs": "Runs",
	"panel.trace": "Trace {run}",
	"panel.traceShort": "Trace",
	"panel.plan": "Plan",
	"panel.background": "Background",

	"plan.step.spec": "Description",
	"plan.step.harness": "Harness",
	"plan.step.tests": "Tests",
	"plan.step.exam": "Exam",
	"plan.step.baseline": "Baseline",
	"plan.step.change": "Change",
	"plan.step.verification": "Verification",
	"plan.step.release": "Release",
	"plan.none": "not yet",
	"plan.spec.approved": "approved",
	"plan.spec.draft": "draft awaiting your review",
	"plan.harness.configured": "configured",
	"plan.tests.published": "published",
	"plan.tests.draft": "draft",
	"plan.exam.ready": "ready for the ship gate",
	"plan.baseline.none": "nothing has run yet",
	"plan.baseline.recorded": "recorded",
	"plan.baseline.rate": "{pass}/{total} · {percent} passed",
	"plan.change.open": "waiting for your reading",
	"plan.change.applied": "applied on {branch}",
	"plan.change.applied-unknown": "applied",
	"plan.workshop": "workshop · {files} changed · {tries}",
	"plan.verification.measured": "measured",
	"plan.verification.none": "not verified yet",
	"plan.verification.development": "development: {verdict}",
	"plan.verification.sealed": "exam: {verdict}",
	"plan.release.none": "not shipped",
	"plan.release.rejected": "rejected",
	"plan.job": "running: {label} · {progress}",
	"plan.header": "Plan {done}/{total} · {marker} {step}",

	"receipt.judge": "judge {cost}",
	"unit.hour-short": "h",
	"unit.minute-short": "m",
	"unit.second-short": "s",
	"status.spend": "{cost} this cycle",

	"note.decision": "Builder received: the result of /{command} ({detail})",
	"note.trace": "Builder received: the trace of {run}",
	"note.job": "Builder received: the background {label} ({detail})",

	"job.started": "Started in the background",
	"job.finished": "Background task finished",
	"job.failed": "Background task failed",
	"job.stopped": "Background task stopped",
	"job.busy": "Wait — {label} is running ({progress})",
	"job.none": "Nothing is running in the background",
	"job.stop-hint": "/stop cancels it; the measurement is discarded",
	"job.nothing-to-stop": "Nothing is running, so there is nothing to stop",
	"job.label.run": "the test run",
	"job.label.verify": "candidate verification",
	"job.label.calibrate": "the noise measurement",
	"job.label.regrade": "the re-score",
	"trace.run": "Run",
	"trace.error": "Error",
	"trace.why": "Why",
	"trace.verdict": "Verdict",
	"trace.conversation": "Conversation",
	"trace.noGraders": "No grader graded this run.",
	"trace.user": "user",
	"trace.agent": "agent",
	"trace.finalAnswer": "agent · final answer",
	"trace.toolCalls": "{n} tool call(s)",
	"trace.moreEntries": "… {n} more entries; the Explorer page has the bounded rest",
	"trace.omitted": "… {n} more lines omitted; open /runs/{run} in the Explorer",
	"trace.refused": "This run cannot be opened here: {reason}",
	"trace.unreadable": "The trace could not be read: {reason}",
	"trace.noMore": "No more runs in that direction.",
	"trace.notListed": "The runs of {eval} cannot be listed here: {reason}",
	"table.none": "No runs to show for this evaluation.",
	"table.more": "… {n} more rows · /traces {m} shows more",
	"table.hint": "say “/trace 1” to open row 1 · “/trace next” walks the failures · the evidence link above has every run",
	"table.col.task": "task",
	"table.col.rep": "rep",
	"table.col.outcome": "outcome",
	"table.col.score": "score",
	"table.col.graders": "graders",
	"table.col.mode": "failure mode",
	"table.col.tools": "tools",
	"table.col.latency": "latency",
	"panel.help": "AHDE Builder help",
	"panel.doctor": "AHDE Doctor",
	"panel.run-complete": "Run complete",
	"panel.ready-next": "Ready for the next step",
	"panel.cheap-check-nothing": "Cheap check found nothing",
	"panel.candidate-verified": "Candidate verified",
	"panel.shipped": "Shipped",
	"panel.improvement-complete": "Improvement cycles complete",
	"panel.noise-calibrated": "Noise calibrated",
	"panel.regraded": "Re-scored with the new graders",
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
	"panel.holdout-generated": "Exam created",
	"panel.holdout-drafted": "Exam draft ready",
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
	"workshop.fixtures-word": "fixtures",
	"label.tool": "Tool",
	"label.data-source": "Data source",
	"label.package": "Package",
	"label.contract-tests": "contract tests",
	"confirm.tool-authoring.secrets": "Secrets stay in the host environment. The Builder receives only test outcomes and the reviewable source diff.",
	"grader.no-secret": "no credential in the answer",
	"impact.tool-contract": "Tool contract for {tools}, through the development cases:",
	"impact.tool-contract-questions": "calls the tool · right arguments · says so when it fails · no credential in the answer. “Answers better” is the gate above.",
	"permissions.title": "Permissions",
	"permissions.network": "network",
	"permissions.filesystem": "filesystem",
	"permissions.env": "env",
	"permissions.setup": "setup network",
	"permissions.none": "none",
	"permissions.removed": "removed by this change",
	"panel.created-changed": "Created / changed",
	"panel.tool-tests": "Tool tests",
	"panel.two-outcomes": "Apply or discard",
	"panel.two-outcomes-hint": "Say which one you want. Nothing changes until you apply.",
	"fixtures.all-passed": "{passed}/{total} fixtures",
	"fixtures.failed": "{passed}/{total} — {fixture}: {reason}",
	"fixtures.none": "no fixtures were run",
	"tool-key.missing": "{tools} needs {names} — export it in the shell that runs ahde",
	"onboarding.connect-in-tui": "Connect a Builder model in this local TUI before continuing.",
	"onboarding.connect-then-continue": "Connect the Builder, then AHDE will continue with what you just wrote",
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
	"onboarding.subject-tool-key": "the credential",
	"onboarding.tool-credential-env": "Environment variable holding {purpose} for {tool}",
	"onboarding.tool-credential-export": "Nothing is stored here. Export {environment} in the shell that runs ahde, then try the tool again.",
	"onboarding.tool-credential-rename": "{tool} declares {declared}, not {chosen}. Changing which variable it reads is a change to the tool, so ask for it in plain words and I will prepare the diff.",
	"onboarding.tool-credential-name-only": "That is not an environment-variable name. Name the variable, never paste the credential itself.",
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

	"confirm.title.scaffold-target": "Create exact Target harness",
	"confirm.title.configure-target": "Configure exact Target identity and model",
	"confirm.title.configure-evaluators": "Configure exact evaluator models",
	"confirm.title.approve-spec": "Approve exact Spec draft",
	"confirm.title.abandon-candidate": "Abandon interrupted candidate attempt",
	"confirm.title.publish-corpus": "Publish exact development corpus",
	"confirm.title.import-dataset": "Import an exact dataset as eval cases",
	"confirm.title.generate-holdout": "Have the judge write a sealed exam",
	"confirm.title.run-eval": "Run exact development evaluation",
	"confirm.title.calibrate": "Calibrate run-to-run noise",
	"confirm.title.regrade": "Re-score the recorded answers",
	"confirm.title.discard-proposal": "Discard exact Builder proposal",
	"confirm.title.verify-candidate": "Verify exact applied candidate",
	"confirm.title.review-candidate": "Record exact candidate review",
	"confirm.title.promote-candidate": "Promote exact candidate",
	"confirm.title.reject-candidate": "Reject exact candidate",
	"section.spec-draft": "Spec draft",
	"section.basket-draft": "Eval basket draft",
	"section.evaluation": "Evaluation",
	"section.target": "Target",
	"section.already-tried": "Already tried",
	"section.dataset": "Dataset",
	"confirm.apply-checkout": "Your checkout stays where it is; the proposal is committed on the candidate branch.",
	"confirm.apply-remainder": "/review shows the exact remainder",
	"confirm.ship.already-promoted": "already promoted",
	"confirm.step.approve-spec": "approve the Spec draft",
	"confirm.step.publish-corpus": "publish the eval basket",
	"confirm.step.run-eval": "run the basket against the Target",
	"confirm.step.review-candidate": "record the review",
	"confirm.step.promote-candidate": "tag the reviewed revision",
	"confirm.step.adopt-candidate": "fast-forward this branch to it",
	"confirm.step.continue-cycle": "close the cycle",
	"confirm.ship.exact-diff": "Exact diff · {hash}",
	"confirm.ship.no-exact-diff": "Exact diff is unavailable; do not ship this automated candidate",
	"report.h2.failure-modes": "Failure modes",
	"report.h2.drill-down": "Task issue drill-down",
	"report.h2.comparison": "Matched comparison",
	"report.h2.run-evidence": "Run evidence",
	"report.h2.trace-inspector": "Trace inspector",
	"report.h2.growth": "Growth",
	"report.nav.runs": "Runs",
	"report.select-run": "Select a run",
	"report.choose-run": "Choose a run to inspect its normalized trace.",
	"report.filter-placeholder": "Filter by task id or input text",
	"report.filter-label": "Filter runs",
	"report.stat.pass-rate": "Pass rate",
	"report.stat.passed": "Passed",
	"report.stat.errors": "Errors",
	"report.stat.failure-modes": "Failure modes",
	"report.th.task": "Task",
	"report.th.baseline": "Baseline",
	"report.th.candidate": "Candidate",
	"report.th.score": "Score",
	"report.th.delta": "Delta",
	"report.th.version": "Version",
	"report.th.date": "Date",
	"report.th.revision": "Revision",
	"report.th.development": "Development",
	"report.th.sealed": "Sealed",
	"report.th.cost": "Cost",
	"report.th.resolved-modes": "Resolved modes",
	"report.th.reason": "Reason",
	"help.body": `AHDE Builder

Talk normally: describe the agent you want, answer one useful question at a time,
and AHDE turns the conversation into a reviewed Spec, evaluation cases, runs,
diagnosis, and exact harness changes. Slash commands are shortcuts, not a
requirement.

Workflow:  idea → Spec → eval basket → run → diagnosis → proposal → diff review
           → apply → candidate verification → promote/reject → adopt → next cycle

Commands: three verbs do the work.
  /test [N] [reason]    test the agent — approve, publish and run whatever is
                        pending, or verify the candidate you just changed
  /fix [n] [reason]     fix problem n (the first one by default): refresh the
                        traces, prepare the change, and show you the diff
  /ship [version]       ship the verified candidate: promote, adopt, next cycle

Looking around:
  /status               where you are and the next step
  /plan                 the whole cycle as a checklist: done, current, still ahead
  /jobs                 the background measurement that is running, if any
  /stop                 cancel it; nothing it measured is kept
  /review               the exact artifact awaiting your review, with actions
  /traces [rows]        diagnosis, failure modes, the evidence link, and the runs table
  /trace <n|next|prev>  one run: why it failed, every verdict, and the conversation
  /target [resource]    the exact committed Target, or one declared resource
  /passport [version]   what the newest shipped version promised and measured
  /log [n]              how the agent grew: every version and what it scored
  /label [n]            check the judge: grade n answers blind, then see what
                        it said — about ten minutes, and nothing runs
  /doctor               model auth, Target readiness, and recovery steps
  /holdout              privately import the operator-owned sealed JSONL exam
  /help                 this reference

One step at a time (the same decisions, taken separately):
  /run [N] [reason]     alias of /test
  /calibrate [N]        measure run-to-run noise: the same revision against itself
  /regrade [erun]       re-score the recorded answers with the graders you just
                        revised — the agent is not called again, only the judge
  /approve [reason]     approve the reviewed Spec draft
  /publish [name]       publish the reviewed eval basket
  /apply <branch>       apply the reviewed proposal to a candidate branch
  /discard [reason]     discard a proposal or abandon an interrupted candidate
  /promote <version>    promote the verified candidate (records the review first)
  /reject [reason]      reject the verified candidate
  /adopt [reason]       fast-forward the current branch to the promoted candidate
  /next [reason]        close this cycle and continue with the active Target

Pi's own built-ins configure the Builder's model, not the agent's:
  /login                connect a provider (OAuth or API key), once per machine
  /model                pick a Builder model that already has a credential

Every consequential step shows the exact subject and asks you once: starting
the tests, applying a diff, and shipping. Runs and checks just happen — unless
one would cost more than usual, and then you get a single yes/no.`,
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
	"label.tool-key": "Ключ инструмента",
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
	"label.exam": "Экзамен",
	"label.source": "Источник",
	"label.cost": "Стоимость",
	"label.draft": "Черновик",
	"label.skipped": "Пропущено",
	"label.cheap-check": "Быстрая проба",
	"label.exact-proposal": "Точная правка",
	"label.base": "база",

	"target.missing": "ещё не создан",
	"target.model-not-chosen": "модель не выбрана",
	"target.credential-missing": "({env} не задан)",

	"ship-gate.missing": "нет закрытого экзамена",
	"ship-gate.underpowered": "в закрытом экзамене меньше {minimum} кейсов",
	"ship-gate.unavailable": "закрытый экзамен недоступен или не прошёл проверку целостности",
	"ship-gate.hint": "· /holdout загрузит твой JSONL-экзамен (минимум {minimum})",
	"ship-gate.hint-none": "· /holdout загрузит твой JSONL-экзамен (мин. {minimum}) · или его напишет судья",

	"noise.not-calibrated": "не измерен",
	"noise.hint": "· скажи «измерь шум» или /calibrate",
	"noise.reps": "рекомендую повторов: {count}",
	"noise.flip": "переключений",

	"header.title": "AHDE Билдер",
	"header.tagline": "· собирает, проверяет и улучшает другого агента по данным",
	"header.state-unavailable": "Состояние проекта недоступно",
	"header.not-connected": "не подключена — подключи модель, чтобы продолжить",
	"header.not-connected-suffix": "· не подключена",
	"header.help": "Просто скажи, что нужно",

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
	"development.on-tasks": "· задач {count}",
	"development.score": "· балл {before} → {after}",
	"development.improved": "↑ {count} лучше",
	"development.lower": "↓ {count} хуже",
	"development.unchanged": "= {count} без изменений",
	"development.collapsed": "· {tasks} сломалось",

	"sealed.not-executed": "не прогонялся",
	"sealed.gate-passed": "порог пройден",
	"sealed.legacy": "старые данные — выкатить нельзя",

	// Прогноз: проверяемое число, по которому судят правку.
	"label.prediction": "Прогноз",
	"prediction.expect": "Ожидаю",
	"prediction.mode": "mode «{mode}» {from}/{of} → ≤{to}/{of}",
	"prediction.overall": "итог {delta}",
	"prediction.none": "прогноз не заявлен",
	"prediction.mode-outcome": "предсказано ≤{expected}/{of} · получено {actual}/{of}",
	"prediction.mode-unpredicted": "без прогноза · получено {actual}/{of}",
	"prediction.overall-outcome": "предсказано {predicted} · получено {actual}",
	"prediction.overall-unmeasured": "предсказано {predicted} · сопоставимого измерения ещё нет",
	"prediction.interval": "(ДИ {low} … {high})",
	"prediction.calibration": "Builder предсказывает: попаданий {hits}/{total} · ошибка ±{error} · {strip}",
	"prediction.calibration-none": "Builder предсказывает: пока ни одно решение не несло прогноза",
	"prediction.passport": "Обещано {predicted} · получено {actual}",
	"prediction.passport-unmeasured": "Обещано {predicted} · сопоставимого измерения нет",

	"judge.not-calibrated": "не откалиброван",
	"judge.label-hint": "· ahde label",
	"judge.label-hint-long": "· ahde label сверит его с твоими глазами",
	"judge.agreement": "согласие {rate}",
	"judge.agrees-with-you": "согласен с тобой {rate}",

	"label.no-judge": "Судью проверять не на чем — в тестах нет judge-грейдеров",
	"label.panel": "Судья {ordinal}/{total}",
	"label.done": "Судья проверен",
	"label.field.request": "что спросили",
	"label.field.goal": "цель пользователя",
	"label.field.answer": "агент ответил",
	"label.field.conversation": "диалог",
	"label.field.reference": "эталонный ответ",
	"label.field.rubric": "критерий, который дали судье",
	"label.field.assertions": "чек-лист, который заполнял судья",
	"label.legacy": "тесты, по которым оценивали этот прогон, вне области видимости — критерий судьи показать нечем",
	"label.ask": "Твой вердикт — до того, как увидишь судью",
	"label.ask-assertion": "{index}/{total} · {assertion}",
	"label.ask-note": "Что не так? (можно пропустить)",
	"label.choice.good": "хорошо",
	"label.choice.bad": "плохо",
	"label.choice.skip": "пропустить",
	"label.choice.stop": "стоп",
	"label.choice.yes": "да",
	"label.choice.no": "нет",
	"label.choice.unknown": "не знаю",
	"label.reveal": "судья сказал: {verdict} · {agreement}",
	"label.reveal-agrees": "согласен с тобой",
	"label.reveal-disagrees": "РАСХОДИТСЯ с тобой",
	"label.reveal-assertion": "{index}. ты — {human} · судья — {judge}",
	"label.stopped": "Стоп — ответов: {labelled}, осталось: {left}.",
	"label.nothing": "Ты не ответил ни разу, так что записывать нечего.",
	"label.all-labelled": "Ты уже оценил все ответы этого прогона, которые смотрел судья",
	"label.summary": "согласие {rate} · κ {kappa} · n={n}",
	"label.by-grader": "по критериям:",
	"label.perfect": "Судья согласился с тобой везде.",
	"label.meaning": "Судья ошибается примерно в одном ответе из {ratio}; {direction}",
	"label.meaning-misses-failures": "провалы он ловит хуже, чем успехи.",
	"label.meaning-invents-failures": "он заваливает ответы, которые ты бы принял.",
	"label.meaning-both": "он ошибается в обе стороны одинаково.",
	"label.next-more": "Ещё {count} ответов уточнят цифру",
	"label.next-enough": "Этого достаточно, чтобы верить судье при выпуске",

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
	"confirm.regrade": "Пересчитать {answers} новыми грейдерами? Target заново не вызывается, платим только судье.",
	"confirm.covers": "Это одно подтверждение включает:",
	"confirm.step-record": "Каждый шаг пишет свою запись; первый упавший останавливает остальные.",
	"confirm.cost-guard": "{question} {guard}. Продолжить?",

	"guard.unknown-cost": "сравнимых прогонов ещё не было, поэтому {runs} стоят неизвестно сколько",
	"guard.over-cost": "около ${cost} — больше рутинного порога ${bound} (AHDE_ROUTINE_COST_USD)",
	"guard.over-minutes": "около {minutes} мин — больше рутинного порога {bound} мин (AHDE_ROUTINE_MINUTES)",

	"estimate.unknown": "неизвестно",
	"estimate.nothing-comparable": "· сравнимых прогонов ещё не было",
	"estimate.covenant": "— одобряя правку, ты одобряешь и эту проверку",
	"estimate.under-cent": "меньше $0.01",
	"estimate.about-cost": "около ${cost}",
	"estimate.under-minute": "меньше минуты",
	"estimate.about-minutes": "около {count} мин",

	"result.target-created": "Агент создан",
	"result.target-configured": "Агент настроен",
	"result.evaluators-configured": "Модели оценщиков настроены",
	"result.spec-approved": "Описание одобрено",
	"result.tests-published": "Тесты опубликованы",
	"result.basket-published": "Тесты разработки опубликованы",
	"result.dataset-imported": "Данные загружены",
	"result.noise-calibrated": "\u0428\u0443\u043c \u0438\u0437\u043c\u0435\u0440\u0435\u043d",
	"result.regraded": "Пересчёт",
	"regrade.was-now": "было {before} \u2192 стало {after}",
	"regrade.no-target": "Target не вызывался",
	"regrade.now-passing": "теперь проходят",
	"regrade.now-failing": "теперь падают",
	"regrade.unchanged": "без изменений",
	"regrade.score": "балл",
	"regrade.rubrics": "переписаны рубрики: {count}",
	"regrade.no-change": "ни один вердикт не сдвинулся",
	"regrade.sealed": "закрытые данные: какие ответы сдвинулись — не показываем",
	"regrade.more": "\u2026 ещё {count}",
	"regrade.assertion": "утверждение {index} теперь {answer}",
	"regrade.yes": "да",
	"regrade.no": "нет",
	"regrade.grader-passes": "теперь проходит",
	"regrade.grader-fails": "теперь падает",
	"regrade.not-a-baseline": "Это пересчёт, не новая база: чтобы измерить кандидата на новых грейдерах, пересчитай и базу тем же набором.",
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
	"result.tag-records": "Тег фиксирует именно проверенную ревизию. Активный агент не меняется, пока ты не скажешь «прими».",
	"result.verification-blocked": "Автоматическая проверка не запустилась",
	"result.passport-unavailable": "Паспорт недоступен: {reason}",
	"result.contract-cases": "Добавил {count} контрактных кейса для {tool} — опубликуй их со следующим прогоном тестов.",
	"handoff.talk-to-agent": "Поговорить с агентом: ahde target (в новом терминале)",
	"result.verify-again": "Применённую правку можно проверить снова — просто скажи «проверь».",
	"result.promotion-yours": "Выкатка за тобой: скажи «выкатывай» — прогоню закрытый экзамен и выпущу.",
	"result.stopped": "Остановлено: {reason}.",
	"result.nothing-measured":
		"Ничего не измерено: проверка на {executions} не потрачена. Проба — не вердикт: сделай другую правку или проверь принудительно.",
	"result.draft-landed": "Кейсы легли в черновик — посмотри их и опубликуй.",
	"result.sealed-held-out": "отложено",
	"result.sealed-exam": "· это экзамен; против него никто не разрабатывает",
	"result.sealed-none": "ничего не отложено",
	"result.sealed-no-exam": "· для этого файла экзамена нет",

	"generate-holdout.by-judge": "{cases} · генерирует судья {generator}",
	"generate-holdout.source": "описание агента + {examples} из тестов (только форма)",
	"generate-holdout.source-spec-only": "только описание агента (без примеров)",
	"generate-holdout.blind": "Builder содержимого не увидит; в разговор попадёт только число кейсов",
	"generate-holdout.draft": "Черновик — в файл вне репо; правишь и импортируешь через /holdout",
	"generate-holdout.sealed-note": "Эти кейсы не читает никто в цикле улучшений; экзамен остаётся только для оценщика.",
	"generate-holdout.draft-next": "Прочитай, вычисти лишнее и запусти /holdout на этом файле, чтобы закрыть его.",
	"generate-holdout.underpowered": "Экзамен из {cases} всегда даст только «underpowered»; для выката нужно хотя бы {minimum}.",
	"holdout.choose": "Откуда взять закрытый экзамен?",
	"holdout.import-file": "Загрузить файл",
	"holdout.generate-seal": "Пусть напишет судья",
	"holdout.generate-review": "Черновик от судьи мне на правку",
	"holdout.how-many": "Сколько кейсов? (минимум {minimum})",
	"holdout.reason": "оператор попросил закрытый экзамен через /holdout",
	"passport.exam-generated": "написан судьёй, закрыт без проверки",
	"passport.exam-generated-reviewed": "написан судьёй, проверен оператором",
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
	"panel.runs": "Прогоны",
	"panel.trace": "Прогон {run}",
	"panel.traceShort": "Прогон",
	"panel.plan": "План",
	"panel.background": "Фон",

	"plan.step.spec": "Описание",
	"plan.step.harness": "Харнес",
	"plan.step.tests": "Тесты",
	"plan.step.exam": "Экзамен",
	"plan.step.baseline": "База",
	"plan.step.change": "Правка",
	"plan.step.verification": "Проверка",
	"plan.step.release": "Выпуск",
	"plan.none": "ещё нет",
	"plan.spec.approved": "одобрено",
	"plan.spec.draft": "черновик ждёт проверки",
	"plan.harness.configured": "настроен",
	"plan.tests.published": "опубликованы",
	"plan.tests.draft": "черновик",
	"plan.exam.ready": "готов к выкатке",
	"plan.baseline.none": "прогонов ещё не было",
	"plan.baseline.recorded": "записана",
	"plan.baseline.rate": "{pass}/{total} · {percent} проходит",
	"plan.change.open": "ждёт твоего чтения",
	"plan.change.applied": "на ветке {branch}",
	"plan.change.applied-unknown": "применена",
	"plan.workshop": "мастерская · изменено {files} · {tries}",
	"plan.verification.measured": "измерено",
	"plan.verification.none": "ещё не проверяли",
	"plan.verification.development": "разработка: {verdict}",
	"plan.verification.sealed": "экзамен: {verdict}",
	"plan.release.none": "не выкачено",
	"plan.release.rejected": "отклонён",
	"plan.job": "идёт: {label} · {progress}",
	"plan.header": "План {done}/{total} · {marker} {step}",

	"receipt.judge": "судья {cost}",
	"unit.hour-short": "ч",
	"unit.minute-short": "м",
	"unit.second-short": "с",
	"status.spend": "{cost} за цикл",

	"note.decision": "Builder получил: результат /{command} ({detail})",
	"note.trace": "Builder получил: разбор прогона {run}",
	"note.job": "Builder получил: фоновую задачу — {label} ({detail})",

	"job.started": "Запущено в фоне",
	"job.finished": "Фоновая задача завершена",
	"job.failed": "Фоновая задача не удалась",
	"job.stopped": "Фоновая задача остановлена",
	"job.busy": "Дождись — {label} идёт ({progress})",
	"job.none": "В фоне ничего не идёт",
	"job.stop-hint": "/stop остановит; измерение будет выброшено",
	"job.nothing-to-stop": "Ничего не идёт — останавливать нечего",
	"job.label.run": "прогон тестов",
	"job.label.verify": "проверка кандидата",
	"job.label.calibrate": "измерение шума",
	"job.label.regrade": "пересчёт",
	"trace.run": "Прогон",
	"trace.error": "Ошибка",
	"trace.why": "Почему",
	"trace.verdict": "Вердикт",
	"trace.conversation": "Диалог",
	"trace.noGraders": "Ни один грейдер не оценивал этот прогон.",
	"trace.user": "пользователь",
	"trace.agent": "агент",
	"trace.finalAnswer": "агент · финальный ответ",
	"trace.toolCalls": "вызовов инструментов: {n}",
	"trace.moreEntries": "… ещё {n} записей; остальное — на странице эксплорера",
	"trace.omitted": "… ещё {n} строк опущено; открой /runs/{run} в эксплорере",
	"trace.refused": "Этот прогон здесь не открыть: {reason}",
	"trace.unreadable": "Трейс не читается: {reason}",
	"trace.noMore": "Дальше прогонов нет.",
	"trace.notListed": "Прогоны {eval} здесь не перечислить: {reason}",
	"table.none": "В этой оценке нет прогонов.",
	"table.more": "… ещё {n} строк · /traces {m} покажет больше",
	"table.hint": "скажи «/trace 1», чтобы открыть строку 1 · «/trace next» идёт по провалам · ссылка выше ведёт ко всем прогонам",
	"table.col.task": "кейс",
	"table.col.rep": "повт",
	"table.col.outcome": "исход",
	"table.col.score": "балл",
	"table.col.graders": "грейдеры",
	"table.col.mode": "тип сбоя",
	"table.col.tools": "тулы",
	"table.col.latency": "время",
	"panel.help": "Справка AHDE Билдера",
	"panel.doctor": "Диагностика AHDE",
	"panel.run-complete": "Прогон закончен",
	"panel.ready-next": "Готов к следующему шагу",
	"panel.cheap-check-nothing": "Быстрая проба ничего не нашла",
	"panel.candidate-verified": "Кандидат проверен",
	"panel.shipped": "Выкачено",
	"panel.improvement-complete": "Циклы улучшений закончены",
	"panel.noise-calibrated": "Шум измерен",
	"panel.regraded": "Пересчёт с новыми грейдерами",
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
	"panel.holdout-generated": "Экзамен создан",
	"panel.holdout-drafted": "Черновик экзамена готов",
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
	"workshop.fixtures-word": "фикстур",
	"label.tool": "Инструмент",
	"label.data-source": "Источник данных",
	"label.package": "Пакет",
	"label.contract-tests": "контрактные тесты",
	"confirm.tool-authoring.secrets": "Секреты остаются в окружении хоста. Билдер видит только результаты тестов и обычный диф исходников.",
	"grader.no-secret": "ключа нет в ответе",
	"impact.tool-contract": "Контракт инструмента {tools} — по кейсам разработки:",
	"impact.tool-contract-questions": "вызывает инструмент · верные аргументы · честно говорит про ошибку · ключа нет в ответе. «Отвечает лучше» — это гейт выше.",
	"permissions.title": "Права",
	"permissions.network": "сеть",
	"permissions.filesystem": "файлы",
	"permissions.env": "ключи",
	"permissions.setup": "сеть при установке",
	"permissions.none": "нет",
	"permissions.removed": "удаляется этой правкой",
	"panel.created-changed": "Создано / изменено",
	"panel.tool-tests": "Тесты инструмента",
	"panel.two-outcomes": "Применить или выбросить",
	"panel.two-outcomes-hint": "Скажи, что из двух. Пока не применишь — ничего не меняется.",
	"fixtures.all-passed": "{passed}/{total} фикстур",
	"fixtures.failed": "{passed}/{total} — {fixture}: {reason}",
	"fixtures.none": "фикстуры не запускались",
	"tool-key.missing": "{tools} нужен {names} — экспортируй его в той оболочке, где запущен ahde",
	"onboarding.connect-in-tui": "Подключи модель Билдера в этом локальном TUI, прежде чем продолжать.",
	"onboarding.connect-then-continue": "Подключи Билдера — и AHDE продолжит с того, что ты только что написал",
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
	"onboarding.subject-tool-key": "ключ",
	"onboarding.tool-credential-env": "Переменная окружения, где лежит {purpose} для {tool}",
	"onboarding.tool-credential-export": "Здесь ничего не сохраняется. Экспортируй {environment} в той оболочке, где запущен ahde, и попробуй инструмент снова.",
	"onboarding.tool-credential-rename": "{tool} объявляет {declared}, а не {chosen}. Сменить переменную — это правка самого инструмента: скажи словами, и я её подготовлю.",
	"onboarding.tool-credential-name-only": "Это не имя переменной окружения. Назови переменную, а сам ключ сюда не вставляй.",
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

	"confirm.title.scaffold-target": "Создать агента",
	"confirm.title.configure-target": "Настроить агента и его модель",
	"confirm.title.configure-evaluators": "Настроить модели оценщиков",
	"confirm.title.approve-spec": "Одобрить описание",
	"confirm.title.abandon-candidate": "Сбросить прерванную попытку",
	"confirm.title.publish-corpus": "Опубликовать тесты",
	"confirm.title.import-dataset": "Загрузить данные как тестовые кейсы",
	"confirm.title.generate-holdout": "Судья напишет закрытый экзамен",
	"confirm.title.run-eval": "Прогнать тесты",
	"confirm.title.calibrate": "Измерить шум между прогонами",
	"confirm.title.regrade": "Пересчитать записанные ответы",
	"confirm.title.discard-proposal": "Выбросить правку",
	"confirm.title.verify-candidate": "Проверить применённую правку",
	"confirm.title.review-candidate": "Записать обзор кандидата",
	"confirm.title.promote-candidate": "Выкатить кандидата",
	"confirm.title.reject-candidate": "Отклонить кандидата",
	"section.spec-draft": "Черновик описания",
	"section.basket-draft": "Черновик тестов",
	"section.evaluation": "Прогон",
	"section.target": "Агент",
	"section.already-tried": "Что уже пробовали",
	"section.dataset": "Данные",
	"confirm.apply-checkout": "Твой рабочий каталог остаётся на месте; правка коммитится на ветку кандидата.",
	"confirm.apply-remainder": "/review покажет точный остаток",
	"confirm.ship.already-promoted": "уже выкачен",
	"confirm.step.approve-spec": "одобрить черновик описания",
	"confirm.step.publish-corpus": "опубликовать тесты",
	"confirm.step.run-eval": "прогнать тесты против агента",
	"confirm.step.review-candidate": "записать обзор",
	"confirm.step.promote-candidate": "поставить тег на проверенную ревизию",
	"confirm.step.adopt-candidate": "перевести эту ветку на неё",
	"confirm.step.continue-cycle": "закрыть цикл",
	"confirm.ship.exact-diff": "Точный диф · {hash}",
	"confirm.ship.no-exact-diff": "Точного дифа нет; не выкатывай этого автоматического кандидата",
	"report.h2.failure-modes": "Типы сбоев",
	"report.h2.drill-down": "Разбор по задачам",
	"report.h2.comparison": "Парное сравнение",
	"report.h2.run-evidence": "Данные прогонов",
	"report.h2.trace-inspector": "Трейсы",
	"report.h2.growth": "Рост",
	"report.nav.runs": "Прогоны",
	"report.select-run": "Выбери прогон",
	"report.choose-run": "Выбери прогон, чтобы посмотреть его трейс.",
	"report.filter-placeholder": "Фильтр по id задачи или тексту входа",
	"report.filter-label": "Фильтр прогонов",
	"report.stat.pass-rate": "Проходит",
	"report.stat.passed": "Пройдено",
	"report.stat.errors": "Ошибки",
	"report.stat.failure-modes": "Типы сбоев",
	"report.th.task": "Задача",
	"report.th.baseline": "База",
	"report.th.candidate": "Кандидат",
	"report.th.score": "Балл",
	"report.th.delta": "Разница",
	"report.th.version": "Версия",
	"report.th.date": "Дата",
	"report.th.revision": "Ревизия",
	"report.th.development": "Разработка",
	"report.th.sealed": "Экзамен",
	"report.th.cost": "Цена",
	"report.th.resolved-modes": "Закрытые сбои",
	"report.th.reason": "Причина",
	"help.body": `AHDE Билдер

Говори обычными словами: опиши агента, который тебе нужен, отвечай по одному
полезному вопросу за раз — AHDE превратит разговор в проверенное описание,
тестовые кейсы, прогоны, разбор и точные правки харнесса. Слэш-команды —
сокращения, а не обязанность.

Путь:  идея → описание → тесты → прогон → разбор → правка → чтение дифа
       → применить → проверка кандидата → выкатить/отклонить → принять → новый цикл

Команды: работу делают три глагола.
  /test [N] [причина]   проверить агента — одобрю, опубликую и прогоню всё,
                        что ждёт, или проверю правку, которую ты только сделал
  /fix [n] [причина]    исправить проблему n (по умолчанию первую): обновлю
                        трейсы, подготовлю правку и покажу диф
  /ship [версия]        выкатить проверенного кандидата: выкатка, принятие, новый цикл

Посмотреть:
  /status               где ты и что дальше
  /plan                 весь цикл списком: что сделано, где ты, что осталось
  /jobs                 фоновое измерение, если оно идёт
  /stop                 остановить его; измеренное не сохраняется
  /review               то, что ждёт твоей проверки, вместе с действиями
  /traces [строк]       разбор, типы сбоев, ссылка на данные и таблица прогонов
  /trace <n|next|prev>  один прогон: почему провал, все вердикты и диалог
  /target [ресурс]      точный закоммиченный агент или один его ресурс
  /passport [версия]    что обещала и что измерила последняя выкаченная версия
  /log [n]              как агент рос: каждая версия и её результат
  /label [n]            проверить судью: оценить n ответов вслепую и увидеть,
                        что сказал он — минут десять, ничего не прогоняется
  /doctor               ключи моделей, готовность агента и как починить
  /holdout              приватно загрузить твой закрытый JSONL-экзамен
  /help                 эта справка

По одному шагу (те же решения, но по отдельности):
  /run [N] [причина]    то же, что /test
  /calibrate [N]        измерить шум: та же ревизия против себя же
  /regrade [erun]       пересчитать записанные ответы новыми грейдерами —
                        агента заново не зовём, платим только судье
  /approve [причина]    одобрить проверенное описание
  /publish [имя]        опубликовать проверенные тесты
  /apply <ветка>        применить проверенную правку на ветку кандидата
  /discard [причина]    выбросить правку или сбросить прерванного кандидата
  /promote <версия>     выкатить проверенного кандидата (сначала запишет обзор)
  /reject [причина]     отклонить проверенного кандидата
  /adopt [причина]      перевести текущую ветку на выкаченного кандидата
  /next [причина]       закрыть цикл и продолжить с активным агентом

Встроенные команды Pi настраивают модель Билдера, а не агента:
  /login                подключить провайдера (OAuth или API-ключ), раз на машину
  /model                выбрать модель Билдера, у которой уже есть ключ

Каждый серьёзный шаг показывает точный предмет и спрашивает один раз: начать
тесты, применить диф, выкатить. Прогоны и проверки просто происходят — если
только один не выйдет дороже обычного, тогда будет один да/нет.`,
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
