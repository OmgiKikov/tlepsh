# AHDE — сквозная продуктовая приёмка

> Статус: это снимок **до исправлений**, найденных во время приёмки. Актуальный вердикт и повторные проверки находятся в [post-fix отчёте](./2026-09-04-e2e-product-acceptance-post-fix.md).

Дата: 2026-09-04  
Область: текущее рабочее дерево, включая незакоммиченные изменения автоматического автора и unseen validation  
Сценарий: plain Python agent → adoption → basket → runs/traces → automatic prompt improvement → unseen validation → candidate review/ship

## Вердикт

AHDE уже убедителен как управляемая среда для разработки harness: он принимает обычного Python-агента, превращает разговоры и cases в воспроизводимые evals, хранит проверяемые traces, изолирует Builder от sealed exam и не выпускает кандидата без человеческого решения. Ручной путь proposal → development + sealed → review → promote → adopt реально замкнут и проходит демонстрацию.

Новый главный сценарий с несколькими автоматически написанными гипотезами **не замкнут до ship**. Поиск намеренно создаёт `evaluated` Candidate только с unseen validation и без sealed evidence. Workbench затем переводит его прямо в `candidate-review` и предлагает сказать «ship it», но ship-composite не запускает sealed verification, а promotion правильно отказывает без неё. Обычный `verify-candidate` для такого уже evaluated Candidate недоступен. Это безопасный отказ, а не обход gate, но это P0-разрыв в ровно том пользовательском пути, который продукт теперь обещает.

Готовность:

| Контур | Решение | Условия |
|---|---|---|
| Внутреннее демо | **GO, 7/10** | Можно показывать полный ручной Python-путь. Автоматический multi-hypothesis путь показывать только до Pareto/validation и честно называть preview. |
| Design-partner pilot | **Conditional GO, 5/10** | Только с сопровождающим оператором и ручным improvement/verification. Автоматический search-to-ship — NO-GO до P0. |
| Production | **NO-GO, 3/10** | Центральный automatic flow не закрывается; полный gate флакит по времени; Docker-интеграция в этой приёмке не исполнилась; поставка пока из checkout/tarball. |

## Оценка продукта

| Измерение | Балл | Основание |
|---|---:|---|
| Value | **8/10** | Продукт решает дорогую задачу: превращает изменения prompt/tools/KB в измеримый, воспроизводимый и обозреваемый цикл. README описывает шесть live-сессий, включая обычного Python-агента ([README.md:131](../../README.md#L131), [README.md:143](../../README.md#L143)). |
| Usability | **6/10** | Builder Pi и free-text вход сильны ([README.md:27](../../README.md#L27)), но в новом главном пути пользователь получает «pick one / ship it» там, где штатно закрыть sealed gate невозможно. Несколько search-candidates дополнительно требуют ручного выбора и закрытия остальных. |
| Trust / evals | **9/10** | Hash-pinned evidence, disjoint split, sandbox, human gates и жёсткий promotion refusal очень сильны. Система не выпускает недопроверенного кандидата. Минус — минимум 2 unseen cases и нестратифицированный split дают слабый практический сигнал на маленьких неоднородных baskets. |
| RAG observability | **5/10** | Есть `kb_search`, неизменяемая run-копия KB, trace tool calls и `cites_source`. Нет отдельного retrieval diagnosis: query/rewrite, ранги и scores top-k, hit/recall/precision, used-vs-retrieved context, unsupported claims и retrieval latency/cost не сведены в продуктовую поверхность. |
| Reliability | **7/10** | 2115 тестов прошли; manual demo и package verification зелёные. Полный gate упал на одном 120s timeout, хотя изолированный повтор прошёл. Три Docker-теста были skipped из-за недоступного daemon. Новый автоматический путь не имеет одного сквозного acceptance-теста до ship. |
| Deployability | **4/10** | Tarball ставится и smoke проходит, есть loopback `serve`. Пакета ещё нет в npm registry ([README.md:14](../../README.md#L14)); нет production deployment/operations контура, а новый automatic flow не проверяется installed-package smoke. |

## Сквозной путь

### 1. Plain Python agent → adoption: проходит

- Детектор предлагает adopt существующего агента: [src/workbench/inventory.ts:1140](../../src/workbench/inventory.ts#L1140).
- `tests/target-wrap.test.ts` проверяет точный список создаваемых файлов, receipt, инициализацию Git, сохранение существующего `AGENTS.md`, dirty-tree и stale-subject отказ.
- `tests/python-agent.test.ts` проверяет обычный ответ, host-brokered tool call и разделение protocol stdout / diagnostics stderr.
- README фиксирует реальную шестую сессию: plain Python folder → 15 cases → 45 runs → prompt rewrite → sealed verification → `v0.1.0` → dataset export ([README.md:143](../../README.md#L143)).

Ограничение: автоматический author + unseen validation в этой live-сессии не использовался; README прямо говорит, что новый auto-author ещё не проходил paid live session ([README.md:116](../../README.md#L116)).

### 2. Adoption → basket → runs/traces: проходит

- Builder free-text flow, `/test`, `/traces`, `/trace`, `/dataset`, `/holdout` документированы как единый интерфейс ([README.md:33](../../README.md#L33), [README.md:45](../../README.md#L45)).
- `tests/target-command-run.test.ts` покрывает command protocol, tool brokerage, world, hashes, regrade, simulated conversation, malformed/silent/error behavior.
- `tests/world-run.test.ts`, `tests/simulated-user.test.ts`, `tests/export-dataset.test.ts` покрывают stateful cases, разговоры и экспорт.
- Evidence Explorer показывает runs, transcript, graders, Why и matched comparison; sealed runs не публикуются ([README.md:186](../../README.md#L186)). Tool args/results реально входят в bounded/redacted transcript ([src/application/run-explanation.ts:419](../../src/application/run-explanation.ts#L419)).

### 3. Automatic prompt improvement: проходит до validation

- Builder Pi может создать 2–4 независимые гипотезы, с лимитами на turns/tokens/tools/time/files и без shell/exam/release tools ([README.md:94](../../README.md#L94)).
- `tests/improvement-author.test.ts:387-433` использует настоящий Pi author loop и Workbench, создаёт две гипотезы и проверяет, что checkout не изменён.
- Standalone `ahde improve` автоматического автора не имеет: он использует `recordedBuilderProposalAuthor` ([src/cli.ts:1469](../../src/cli.ts#L1469), [src/cli.ts:1542](../../src/cli.ts#L1542)). Это документировано, но означает, что магический auto-author доступен только внутри live Builder Pi host.

### 4. Unseen validation: технически сильна, статистически минимальна

- Design требует минимум четыре reviewed cases, двух на каждую сторону ([src/application/improvement-experiment-design.ts:16](../../src/application/improvement-experiment-design.ts#L16)).
- Split детерминированно hash-rank'ит task IDs, резервирует 40% (минимум два) под validation и хранит точное disjoint membership ([src/application/improvement-experiment-design.ts:83](../../src/application/improvement-experiment-design.ts#L83)).
- Schema требует отсутствие overlap и полное покрытие source corpus ([src/application/improvement-experiment-design.ts:31](../../src/application/improvement-experiment-design.ts#L31)).

Разрыв качества: split не стратифицирован по job, grader family, failure mode, language или tool/world usage. На минимальных четырёх cases validation состоит из двух примеров и легко не содержит важный продуктовый режим. Такое сравнение честно слепое, но часто недостаточно полезное для выбора лучшего prompt.

### 5. Candidate review → ship: P0, путь разорван

Последовательность воспроизводится из кода без предположений:

1. Search запускает matched validation и намеренно не передаёт sealed corpus: «a search never asks may this ship» ([src/application/proposal-search.ts:606](../../src/application/proposal-search.ts#L606), особенно строки 618–619).
2. Результат уже получает `candidateId`, статус `verified` в таблице и Candidate event `evaluated` ([src/application/proposal-search.ts:631](../../src/application/proposal-search.ts#L631)). Тест прямо утверждает, что sealed holdout отсутствует ([tests/proposal-search.test.ts:404](../../tests/proposal-search.test.ts#L404)).
3. Любой `evaluated` Candidate попадает в `candidate-review`, где actions уже `review` и `ship` ([src/workbench/inventory.ts:1187](../../src/workbench/inventory.ts#L1187)). Текст следующего действия: «read the evidence, then say ship it» ([src/workbench/transition-policy.ts:87](../../src/workbench/transition-policy.ts#L87)).
4. Ship-composite из `candidate-review` планирует только review → promote → adopt → continue ([src/workbench/workbench.ts:1597](../../src/workbench/workbench.ts#L1597), [src/workbench/workbench.ts:1611](../../src/workbench/workbench.ts#L1611)). Он может показать `sealed: not run`, но не добавляет verification ([src/workbench/workbench.ts:1661](../../src/workbench/workbench.ts#L1661)).
5. Promotion корректно отказывает: `promotion requires sealed-holdout evidence` ([src/application/candidate-review.ts:1006](../../src/application/candidate-review.ts#L1006)).
6. Обычный `verify-candidate` разрешён только в `candidate-verification`, а evaluated search Candidate уже находится в `candidate-review` ([src/workbench/transition-policy.ts:69](../../src/workbench/transition-policy.ts#L69)).
7. CLI повторяет тупик: после Pareto предлагает `ahde review --candidate ...`, не sealed verification ([src/cli.ts:1553](../../src/cli.ts#L1553)); затем доступны review и promote, где тот же promotion gate откажет.

`tests/improvement-author.test.ts` сознательно заканчивается утверждением «never runs sealed or ships» ([tests/improvement-author.test.ts:387](../../tests/improvement-author.test.ts#L387)). Существующий полный Builder test действительно закрывает ship, но пишет ровно одну manual `structured-proposal`, после чего запускает обычную candidate verification с sealed ([tests/builder-pi-closed-loop.test.ts:143](../../tests/builder-pi-closed-loop.test.ts#L143), [tests/builder-pi-closed-loop.test.ts:184](../../tests/builder-pi-closed-loop.test.ts#L184)). Он не тестирует auto-author → unseen validation → selected winner → sealed → ship.

## RAG-приёмка

Что уже хорошо:

- KB chunk IDs стабильны; `kb_search` возвращает `id`, `path`, `text`, а run сохраняет собственную копию корпуса (`tests/kb.test.ts:200-216`).
- `cites_source` проверяет id или token-F1 overlap и fail-closed ведёт себя при отсутствии chunk/run workspace (`tests/kb.test.ts:318-396`).
- Trace показывает вызов retrieval tool с аргументами и результатом; Why отдельно объясняет citation/overlap failure ([src/application/run-explanation.ts:766](../../src/application/run-explanation.ts#L766)).
- Judge может сгенерировать KB holdout; tests покрывают отсутствие KB и sealed generation.

Чего не хватает для design partner с RAG:

- per-query retrieval card: исходный query, rewrite, top-k chunk IDs, ranks и BM25 scores;
- retrieval metrics по размеченному expected chunk: hit@k/recall@k/MRR и corpus/job coverage;
- generation metrics: context utilization, unsupported claims, answer faithfulness отдельно от citation formatting;
- сравнение baseline/candidate по retrieval и generation отдельно, чтобы продукт говорил «чинить retriever / KB / prompt», а не только «answer failed»;
- latency, tokens и cost, привязанные к retrieval turns, а также drift KB identity между версиями.

## Проверки

| Команда | Результат |
|---|---|
| `npm run check` | **FAIL:** 127 test files passed, 1 failed; 2115 tests passed, 1 timed out, 3 skipped. `tests/report.test.ts:585` превысил общий timeout 120s; также Vitest сообщил worker RPC timeout. |
| `npx vitest run --project heavy tests/report.test.ts -t "projects oversized evidence failure-first"` | **PASS:** 1/1, 36.54s. Значит, это suite-load performance flake, а не устойчивый функциональный отказ. |
| `npm run verify:package` | **PASS:** pack → clean global install → init → validate → Builder startup → sandboxed tool → container argv/matrix → Evidence HTTP → gated serve API → canonical promotion. |
| `npm run demo` | **PASS:** 0/2 baseline → proposal → explicit apply → development improved → sealed pass on 15×2 → tag `v0.2.0` → adopt → next cycle. Это manual proposal path, не automatic multi-hypothesis path. |

Docker daemon был недоступен (`/Users/kikov/.docker/run/docker.sock`), поэтому три real-daemon container tests были skipped. Остальная container policy/argv матрица прошла, но production readiness нельзя считать подтверждённой реальным container runtime в этой приёмке.

Рабочее дерево содержит 61 изменённый/новый файл (1384 additions, 395 deletions). Это не дефект продукта, но production artifact должен быть собран и повторно проверен из чистого зафиксированного commit, а не из текущей рабочей копии.

## Приоритеты

### P0 — до обещания automatic search-to-ship

1. **Замкнуть selected winner → sealed → ship.** После явного выбора Pareto-кандидата Workbench должен выполнить sealed matched pair на его точных baseline/candidate SHA, добавить promotion-grade sealed evidence к однозначному release Candidate и только затем открыть human review/ship. Validation evidence и experiment-design hash должны остаться видимыми, но не подменять release gate.
2. **Добавить один настоящий acceptance test ровно на продуктовый сценарий:** plain Python folder → adopt → ≥4 reviewed cases/world → runs/traces → isolated automatic author 2+ hypotheses → persisted disjoint validation → select candidate → sealed exam → exact diff review → promote → adopt → passport/dataset. Тест должен падать на нынешнем переходе и проходить только когда цикл действительно закрыт.

### P1 — до design-partner pilot

1. **Сделать выбор победителя атомарным продуктовым шагом.** Показать frontier, точный diff и validation evidence; выбор одного кандидата должен переводить его к release verification, а остальные — в явный rejected/superseded terminal state. Сейчас несколько `evaluated` Candidates остаются active и вызывают `selection-required` ([src/workbench/inventory.ts:1169](../../src/workbench/inventory.ts#L1169)).
2. **Усилить split.** Стратифицировать по job/failure mode/grader/tool/world/language, показывать coverage обеих сторон и отказывать либо маркировать weak evidence, если значимый слой отсутствует. Четыре cases оставить только как developer smoke; для product claim задать более высокий рекомендуемый минимум.
3. **Провести paid live acceptance auto-author.** README сам фиксирует, что такого запуска не было. Использовать реальный plain Python/RAG agent, сохранить cost/latency, provider failures и time-to-winner.
4. **Убрать performance flake полного gate.** Профилировать oversized evidence projection и/или ограничить concurrency/memory для heavy suite. Требование для pilot: два последовательных чистых `npm run check` без timeout.
5. **Добавить RAG X-ray.** В Evidence Explorer показать retrieval и generation как две независимые части качества, с top-k/ranks/scores и matched delta.
6. **Синхронизировать продуктовые тексты.** Roadmap всё ещё называет autoloop Stage 3 будущей работой ([docs/ROADMAP.md:86](../../docs/ROADMAP.md#L86)), тогда как README объявляет auto-author/unseen validation доступными. README ссылается на «42-invariant», файл содержит 44 ([README.md:208](../../README.md#L208), [docs/INVARIANTS_V1.md:305](../../docs/INVARIANTS_V1.md#L305)).
7. **Расширить installed-package smoke** новым author/design и complete selected-winner flow, а не только canonical manual promotion.

### P2 — до production

1. Опубликовать версионированный пакет/installer; checkout install оставить developer path.
2. Определить production operating model: поддерживаемые OS/container backends, credentials, artifact retention, backup/restore, concurrent operators, cancellation/recovery и upgrade compatibility.
3. Добавить release matrix на clean commits: macOS/Linux, Docker reachable/unreachable, command Target, Pi Target, RAG Target, interrupted/restarted cycle.
4. Ввести продуктовые SLO: time-to-first-baseline, time-to-reviewed-candidate, flake rate, infra-error budget, cost per validated hypothesis и доля cycles, дошедших до sealed decision.

## Каким должен быть идеальный продуктовый сценарий

Пользователь открывает папку обычного агента и отвечает на один adoption review. После первых разговоров Builder предлагает basket, явно показывает coverage и происхождение cases. Команда «попробуй три улучшения» вызывает один spend confirmation; три изолированных автора видят только authoring arm, а пользователь получает короткую validation-таблицу: что изменилось, какие jobs улучшились/ухудшились, confidence, cost и latency. Выбор строки запускает sealed exam ровно один раз. Финальный review показывает exact diff, validation, sealed verdict, judge calibration и прогноз влияния; одна подтверждённая команда создаёт tag, fast-forward, passport и следующий цикл. В RAG-режиме та же карточка отдельно отвечает, изменился ли retrieval или generation.

До исправления P0 продукт уже хорошо доказывает «мы умеем безопасно измерять и выпускать ручное улучшение». Он пока не доказывает главное новое обещание: «мы автоматически нашли лучший prompt и довели выбранный вариант до ship без ручного обхода состояния».
