import { language } from "../i18n.js";

const copy = {
	en: {
		publicProgress: "Observed public phases",
		plannedBudget: (count: number) => `Planned budget: ${count} executions, including private runs`,
		limited: "Live progress limit reached; counts cover tracked executions only",
	},
	ru: {
		publicProgress: "Наблюдаемые открытые этапы",
		plannedBudget: (count: number) => `Плановый бюджет: ${count} запусков, включая закрытые прогоны`,
		limited: "Достигнут лимит живого прогресса; счётчики охватывают только отслеживаемые запуски",
	},
};

export function runProgressCopy() {
	return copy[language()];
}
