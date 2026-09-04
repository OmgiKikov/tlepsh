# AHDE: продуктовый ресерч и решения

Дата: 2026-09-04

## Вывод

Сильная версия AHDE — не ещё один playground для промптов. Это локальная доказательная система для агентских изменений: она воспроизводит диалог и состояние мира, объясняет сбой по trace, предлагает несколько ограниченных изменений и показывает победителя на данных, которых автор изменения не видел.

Первый продуктовый контракт:

> Дай AHDE папку Python support-агента и тестовую корзину. Он воспроизведёт клиента, tools, RAG и состояние, найдёт системный сбой, проверит несколько исправлений на независимой выборке и вернёт кандидат, trace и стоимость. Человек принимает одно финальное решение о выпуске.

## Что подтверждают первичные источники

### 1. Оценивать надо outcome, trace и устойчивость, а не только финальный текст

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) разделяет task, trial, grader, transcript и outcome; рекомендует несколько trials, изолированную среду и регулярное чтение transcript-ов.
- [OpenAI: Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals) ставит traces, graders, datasets и eval runs в один цикл.
- [OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading) описывает structured grading полного лога решений, tool calls и промежуточных шагов.
- [τ-bench](https://arxiv.org/abs/2406.12045) проверяет конечное состояние базы после динамического диалога и вводит `pass^k`: вероятность, что агент стабильно пройдёт несколько попыток.

Решение для AHDE: conversation flight recorder должен связывать сообщения, tool calls, world diff, retrieval trace, graders и стоимость. На capability-карте рядом со средним score нужен reliability-показатель по повторениям.

### 2. Автоулучшение без независимой validation-выборки создаёт ложную победу

- [LangSmith: Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts) прямо рекомендует training/validation/test splits против overfitting.
- [LangSmith: Manage datasets](https://docs.langchain.com/langsmith/manage-datasets) хранит версии и именованные splits, а провальные production traces возвращает в datasets.
- [LangSmith: Pairwise evaluation](https://docs.langchain.com/langsmith/evaluate-pairwise) сравнивает два полных run-а и рандомизирует порядок ответов, чтобы уменьшить positional bias judge-а.
- [Langfuse: Evaluate with datasets](https://langfuse.com/docs/evaluation/get-started/offline) связывает dataset item, experiment trace и evaluator score и поддерживает self-hosted deployment.

Решение для AHDE: Builder видит только authoring split; cheap screen, full comparison и Pareto frontier используют validation split; sealed exam открывается один раз после выбора. Split имеет seed, хеш, точные task IDs и сохраняется до запуска модели.

### 3. Оптимизатор должен хранить гипотезы и знания, а не бесконечно переписывать текст

- [GEPA](https://arxiv.org/abs/2507.19457) извлекает правила из trajectories, тестирует несколько обновлений и комбинирует взаимодополняющие уроки с Pareto frontier.
- [VISTA / Reflection in the Dark](https://arxiv.org/abs/2603.18388) показывает, что reflective optimization может ухудшать prompt; авторы отделяют генерацию именованной гипотезы от переписывания и проверяют гипотезы параллельно.

Решение для AHDE: каждая попытка получает короткую проверяемую гипотезу, failure mode, ожидаемый эффект, diff, validation outcome и причину проигрыша. Повтор уже проигравшей гипотезы не тратит бюджет.

### 4. RAG надо раскладывать на retrieval и generation

- [RAGChecker](https://github.com/amazon-science/RAGChecker) отдельно измеряет retriever (`claim_recall`, `context_precision`) и generator (`context_utilization`, `noise_sensitivity`, `hallucination`, `faithfulness`).

Решение для AHDE: RAG X-ray показывает query/rewrite, top-k chunks с doc/chunk ID и score, использованные claims, лишний шум и unsupported claims. Тогда продукт отвечает, что чинить: поиск, knowledge base, prompt или tool policy.

## Очерёдность продукта

1. **Blind improvement** — persisted authoring/validation split, независимое ранжирование 2–4 гипотез, отказ при маленькой корзине.
2. **Два reference agents** — простой Python RAG и сложный stateful support-agent с tools, блокировками и многоходовым клиентом.
3. **Conversation flight recorder** — единая временная шкала message/tool/retrieval/world/grader/cost и state diff до/после.
4. **RAG X-ray** — раздельные retrieval/generation метрики и диагноз по каждому кейсу.
5. **Reliability + capability map** — score, `pass^k`, latency и cost по навыкам, а не одно среднее число.
6. **Failure → regression** — один клик превращает реальный trace в reviewed кейс с provenance и дедупликацией.
7. **Counterfactual replay** — повторить тот же диалог и мир с другим prompt/model/retriever без повторной ручной подготовки.
8. **Candidate passport** — что изменилось, почему, где победило/проиграло, confidence, цена и оставшиеся риски.

## Что пока не строить

- Визуальный Langflow-подобный конструктор до доказанного loop на двух реальных агентах.
- Универсальную платформу для всех типов агентов.
- Собственную vector DB или новый orchestration framework.
- Автоматический release без единственного финального решения человека.

## Реализовано в этом срезе

- Для поиска по 2–4 гипотезам введён persisted blind split с минимумом 4 reviewed cases.
- Разбиение детерминировано `loopId` и identity исходной корзины; повторный запуск читает тот же immutable design.
- Authoring и validation сохраняются как отдельные immutable development corpora с точными task IDs и хешами.
- Builder diagnosis, failure bundle и proposal provenance строятся только по authoring arm.
- Validation baseline запускается только после завершения всех author attempts; cheap screen и matched candidate comparison используют validation arm.
- Candidate provenance содержит hash-pinned split-design artifact; подмена корпуса, overlap или несовпадение task order блокируют verification.
- Workbench отказывает на корзине меньше четырёх кейсов до provider preparation, подтверждения, branch creation и model spend.
- Диалог заранее показывает количество authoring и unseen validation cases и считает отдельный conservative execution ceiling.

Проверка: `npm run check` — 2,116 passed, 3 skipped из-за недоступного Docker daemon; `npm run verify:package` — pack, clean install и canonical promotion прошли.
