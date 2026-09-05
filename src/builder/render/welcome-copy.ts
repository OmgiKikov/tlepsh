import { language } from "../../i18n.js";

const en = {
	tagline: "Build an agent. See what gets better.",
	project: "PROJECT",
	returning: "WELCOME BACK",
	trySaying: "Start with your intent",
	continueWith: "Continue from here",
	create: "Build an agent for my task",
	connectPython: "Connect my Python agent",
	configure: "Help me choose the agent's model",
	describe: "Help me describe what this agent should do",
	run: "Run the test basket",
	previewBasket: "Show me the basket before running it",
	verify: "Verify the prepared change",
	improve: "Improve the agent's failing answers",
	models: "Find a cheaper model for this agent",
	inspect: "Show me the project's current state",
	results: "Explain the latest results",
	workshop: "Continue the unfinished changes",
	candidate: "Show the interrupted attempt",
	selection: "Help me choose what to work on",
	integrity: "Show what needs to be restored",
	freeInput: "Describe what you want. You can change direction as we work.",
} as const;

const ru: Record<keyof typeof en, string> = {
	tagline: "Собери агента. Увидь, что стало лучше.",
	project: "ПРОЕКТ",
	returning: "С ВОЗВРАЩЕНИЕМ",
	trySaying: "Начни со своей задачи",
	continueWith: "Можно продолжить так",
	create: "Создать агента под мою задачу",
	connectPython: "Подключить Python-агента",
	configure: "Помоги выбрать модель агента",
	describe: "Помоги описать, что должен делать агент",
	run: "Прогнать корзину",
	previewBasket: "Покажи корзину перед запуском",
	verify: "Проверить подготовленное изменение",
	improve: "Улучшить ответы, на которых агент ошибается",
	models: "Подобрать агенту модель дешевле",
	inspect: "Покажи текущее состояние проекта",
	results: "Объясни последние результаты",
	workshop: "Продолжить незаконченные изменения",
	candidate: "Покажи прерванную попытку",
	selection: "Помоги выбрать, над чем работаем",
	integrity: "Покажи, что нужно восстановить",
	freeInput: "Пиши обычными словами. Направление можно менять по ходу.",
};

export function welcomeCopy(): Record<keyof typeof en, string> {
	return language() === "ru" ? ru : en;
}
