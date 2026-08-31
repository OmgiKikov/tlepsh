#!/usr/bin/env node
// Long-lived scripted model for the SKILL walkthrough (docs/SKILL_WALKTHROUGH.md).
// The AHDE CLI runs out-of-process, so the loopback model from scripts/demo.mjs
// has to outlive a single script: this starts it, writes the base URL to a file,
// and stays up until SIGTERM. It spends no tokens.
import { writeFileSync } from "node:fs";
import { startMockModel } from "../dist/mock-model.js";

// The improved AGENTS.md carries this marker; the baseline one does not.
const MARKER = "AHDE-RETURNS-POLICY-V2";

const GOOD = [
	"Здравствуйте! Оформить возврат можно в течение 30 дней с даты доставки.",
	"Пожалуйста, оформите заявку в личном кабинете в разделе «Возвраты».",
].join(" ");
const BAD = "Hello! Our returns window is 14 days from purchase. Please email support@example.com.";

const mock = await startMockModel([
	{ match: ({ system }) => system.includes(MARKER), steps: [{ text: GOOD }] },
	{ match: () => true, steps: [{ text: BAD }] },
]);

const outPath = process.argv[2];
if (!outPath) throw new Error("usage: skill-mock-model.mjs <url-file>");
writeFileSync(outPath, mock.url);
console.log(`mock model listening on ${mock.url}`);

const stop = async () => {
	await mock.close();
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
