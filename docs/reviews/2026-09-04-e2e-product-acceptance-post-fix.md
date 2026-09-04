# AHDE — post-fix продуктовая приёмка

Дата: 2026-09-04  
Область: текущее рабочее дерево после сквозного QA и исправления release-loop  
Сценарий: plain Python agent → adoption → basket → runs/traces → automatic multi-hypothesis improvement → blind validation → sealed verification → review → promotion → adoption → next cycle

## Вердикт

**AHDE готов к сильному внутреннему демо и к сопровождаемому design-partner pilot. До самостоятельного production rollout ещё нужны реальные provider/container прогоны и продуктовый слой для RAG-диагностики.**

Найденный в исходной приёмке P0 закрыт. Автоматически найденный победитель больше не попадает в тупик между blind validation и release: Workbench распознаёт его как кандидата, требующего sealed verification, перепроверяет provenance исходного experiment design, запускает sealed matched pair и только затем открывает review/promotion. Один `ship` теперь замыкает весь разрешённый контур: `verify-candidate → review-candidate → promote-candidate → adopt-candidate → continue-cycle`.

| Контур | Решение | Оценка | Что это означает |
|---|---|---:|---|
| Внутреннее демо | **GO** | **9/10** | Можно честно показывать Python adoption, traces, несколько гипотез, слепой выбор, sealed gate и версию победителя. |
| Design-partner pilot | **Conditional GO** | **7/10** | Подходит для 1–2 агентов при участии команды и контролируемых provider/runtime. До старта закрыть launch gates ниже. |
| Production | **NO-GO** | **5/10** | Нет полного paid-live acceptance, реальный Docker daemon не был доступен, отсутствует production operations matrix и RAG diagnosis недостаточно глубок. |

Итоговая продуктовая оценка: **7.8/10**.

| Измерение | Балл | Основание |
|---|---:|---|
| Ценность | **9/10** | Замыкает редкий и дорогой цикл: фактические диалоги → воспроизводимый eval → несколько улучшений → слепой выбор → безопасный выпуск. |
| Удобство | **7/10** | Builder даёт единый разговорный интерфейс; Python стал главным quickstart. Для первого пользователя всё ещё много внутренних сущностей и предупреждений. |
| Доверие к evals | **9/10** | Hash-pinned evidence, disjoint development/validation split, sealed exam, exact diff, sandbox и human release approval. |
| RAG observability | **5/10** | KB и tool traces воспроизводимы, но retrieval и generation ещё не диагностируются как разные причины ошибки. |
| Надёжность | **8/10** | Полный suite и packaged smoke зелёные; новый главный контур имеет настоящий сквозной тест. Три Docker-daemon теста пропущены средой. |
| Поставка | **5/10** | Clean tarball install проверен, но публичной установки и production operating model пока нет. |
| Wow-эффект | **8/10** | Автопоиск и one-command gated ship уже впечатляют; executive result card и RAG X-ray доведут продукт до уровня, который понятен без автора проекта рядом. |

## Что было исправлено

1. **Замкнут automatic search-to-ship.** Development-only automated winner теперь сначала переводится в release verification. `ship` на этой стадии выполняет sealed проверку, review, promotion, adoption и открывает следующий цикл.
2. **Усилен blind provenance.** Перед impact/review/promotion система повторно читает experiment design, сверяет hash/path, authoring и validation corpus identity, task membership и способ запуска evidence. Изменённый design или evidence больше нельзя тихо подменить.
3. **Нормализован lifecycle нескольких гипотез.** Selected candidate отделяется от screened-out/superseded веток; они больше не создают ложную неоднозначность release-кандидата.
4. **Добавлен сквозной acceptance test.** Тест реально проходит две гипотезы, blind validation, Pareto selection, один `ship`, sealed gate, review, tag/promotion, adoption и continuation.
5. **Исправлен Python CLI путь.** `tool try --fixtures` теперь распознаётся как boolean flag. README начинает с `templates/python-agent`, а help честно различает Builder auto-author и standalone CLI с подготовленными proposals.

## Проверки после исправлений

| Проверка | Результат |
|---|---|
| `npm run check` | **PASS:** 128/128 test files, 2116 passed, 3 skipped Docker-daemon tests, 145.25s. Worker/report timeout исходного запуска больше не воспроизвёлся. |
| Новый automatic acceptance | **PASS:** две гипотезы → blind validation → winner → sealed verification → review → promotion/tag → adoption → continuation. |
| `npm run verify:package` | **PASS:** pack → clean install → init → validate → Builder startup → sandboxed Target tool → container argv/matrix → live/final Evidence HTTP → token-gated API → canonical promotion. |
| `npm run demo` | **PASS:** baseline 0/2 → development +100 pp → sealed 15×2 → `v0.2.0` → adoption → next cycle. |
| Evidence report UX | **PASS:** визуально проверены summary, 4/4, zero errors, matched +100 pp; клик по run обновляет trace inspector. |
| Python template CLI | **PASS с ограничением:** init, честный validate exit 2 для placeholders и direct tool input работают; fixtures flag исправлен, но reference Python tools пока не содержат полезных contract fixtures. |
| `git diff --check` | **PASS.** |

Docker daemon в среде недоступен (`/Users/kikov/.docker/run/docker.sock`), поэтому три real-daemon integration tests пропущены. Provider credentials не были доступны, поэтому полный auto-author acceptance с платной/внешней моделью не исполнялся. Это launch gates, а не скрытые функциональные успехи.

## Launch gates для pilot

1. **Один реальный RAG-агент и один сложный tool/world агент.** Прогнать полный цикл на исходниках заказчика, а не только на эталонном fixture.
2. **Paid/live provider acceptance.** Сохранить стоимость, latency, provider failures, число гипотез и time-to-winner; повторить минимум дважды на чистом commit.
3. **Linux + Docker acceptance.** Запустить три пропущенных daemon-теста и packaged smoke в целевом окружении.
4. **Нормальный golden/capability набор.** 10–15 золотых фраз оставить regression core, добавить capability cases по jobs, tool usage, world state, язык, failure mode и сложность; показывать покрытие development/validation/sealed частей.

## Что сделает продукт «вау»

### 1. Executive version card

После `ship` показывать одну карточку, которую можно переслать руководителю или заказчику:

- что изменено человеческим языком и exact diff по запросу;
- baseline / blind validation / sealed result;
- какие capabilities выросли и где есть регресс;
- cost, latency, stability и sample size;
- версия, hashes, passport и ссылка на воспроизводимый dataset;
- рекомендация: release, collect-more-data или fix-retrieval.

Сейчас все доказательства есть, но пользователь должен собирать вывод из нескольких инженерных экранов.

### 2. RAG X-ray

Для каждого вопроса разделить качество на две стадии:

- retrieval: исходный/rewrite query, top-k IDs, ranks/scores, expected-chunk hit@k, MRR, latency;
- generation: какие chunks реально использованы, faithfulness, unsupported claims, citation correctness;
- matched delta: что изменил candidate — retriever, KB, prompt или synthesis.

Это особенно важно для Кибы, где около 70% агентов — RAG: продукт должен говорить не просто «ответ хуже», а «правильный chunk не найден» или «chunk найден, но модель его проигнорировала».

### 3. Evidence-aware optimizer

Автоулучшение должно выбирать не только лучший общий score. Frontier надо строить по capability regressions, cost, latency и uncertainty. При слабой выборке агент должен предложить следующий самый информативный case, а при плато — остановиться и объяснить, какое ограничение мешает: данных мало, retrieval broken, grader нестабилен или prompt уже не bottleneck.

### 4. Production-to-eval flywheel

Импортировать обезличенные production traces, кластеризовать неизвестные failure modes, предлагать новые cases на review и добавлять одобренные примеры в regression/capability baskets. Тогда AHDE становится не одноразовым prompt optimizer, а системой, которая непрерывно выращивает собственную спецификацию поведения.

### 5. Магический первый час

Идеальный путь:

1. Пользователь запускает `ahde` в папке обычного Python-агента.
2. Builder сам находит entrypoint, tools и KB, затем показывает короткий adoption review.
3. После 10–15 разговоров появляется baseline и карта capability gaps.
4. Команда «попробуй три улучшения» создаёт изолированные гипотезы и один blind frontier.
5. Выбор строки запускает sealed exam; итоговая карточка создаёт версию и следующий наблюдаемый цикл.

Цель UX: **от незнакомого Python/RAG агента до проверенной версии за один час, без ручного переноса prompt, traces и spreadsheet-метрик между системами.**

## Идеи из актуальных практик

- Anthropic рекомендует оценивать конечное состояние среды, а transcript grading использовать как дополнительный диагностический слой. AHDE уже хорошо совпадает с этой моделью за счёт world state, tool traces и outcome evidence; следующий шаг — capability coverage и production-derived cases. Источник: [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- OpenAI Evals разделяет dataset schema и graders и позволяет повторно запускать одну evaluation structure на разных моделях и параметрах. Для AHDE это аргумент в пользу переносимого version card и model/provider matrix поверх одного sealed corpus. Источник: [OpenAI Evals API](https://platform.openai.com/docs/api-reference/evals).
- LangSmith связывает offline evaluation с online traces и отдельно рекомендует component-level evals; для RAG выделяет document relevance, faithfulness, helpfulness и correctness. Это прямо поддерживает RAG X-ray и production-to-eval flywheel. Источники: [Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts), [Evaluation approaches](https://docs.langchain.com/langsmith/evaluation-approaches).
- DSPy формулирует prompt improvement как оптимизацию программы по заданной метрике, а не ручное редактирование строк. AHDE может занять более сильную продуктовую позицию: optimizer плюс независимый blind/sealed release harness и воспроизводимый passport. Источники: [DSPy](https://dspy.ai/), [исходная работа DSPy](https://arxiv.org/abs/2310.03714).

## Остаточный backlog

### P1

- RAG X-ray и отдельные retrieval/generation metrics.
- Стратифицированный split и явная маркировка weak evidence на маленьких baskets.
- Executive version card в report/Builder.
- Скрыть внутренние split-corpora из обычного UX и убрать предупреждения о том, что они не receipt-backed.
- Добавить Python contract fixtures с контролируемым `AHDE_WORLD`.
- Расширить package verification новым automatic selected-winner flow.
- Сжать package footprint: текущая приёмка измерила около 34.4 MB compressed, 123.6 MB unpacked и 14,311 files — близко к установленным бюджетам.

### P2

- Публичная версионированная установка и upgrade path.
- Production operating model: credentials, retention, backup/restore, cancellation/recovery, concurrent operators и compatibility policy.
- Online trace ingestion, drift detection и автоматическое предложение новых regression cases.
- SLO продукта: time-to-first-baseline, time-to-reviewed-winner, cost per validated hypothesis, infra-error rate и доля циклов, дошедших до sealed decision.

Текущий продукт уже доказывает главное инженерное обещание: он может автоматически найти несколько улучшений, выбрать победителя на невидимой выборке и безопасно довести точную версию до выпуска. Следующий рывок нужен не в количестве внутренних абстракций, а в объяснимости результата, RAG-диагностике и проверке на двух настоящих агентах.
