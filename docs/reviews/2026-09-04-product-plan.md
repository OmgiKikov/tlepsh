# AHDE — сводное продуктовое ревью и план

Дата: 2026-09-04  
Основание: параллельные ревью `plan-eng-review`, `improve-codebase-architecture`, `thermo-nuclear-code-quality-review` и проверка текущего рабочего дерева.

## Решение

AHDE уже обладает сильным ядром продукта: он выполняет реальных Pi- и Python-агентов в изолированной среде, различает поведенческие и инфраструктурные ошибки, сохраняет проверяемые артефакты, измеряет кандидата и оставляет apply/release за человеком. Это больше, чем прототип eval runner.

Главное обещание пока шире доказательства. Multi-hypothesis autoloop придумывает и выбирает изменения на одном development-корпусе. Поэтому красивый результат поиска означает «лучше подогнался под известную корзину», пока отдельная validation-корзина не подтвердила переносимость. Платный end-to-end проход auto-author с реальными моделями также ещё не состоялся, а устанавливаемого релиза и Linux gate нет.

Лучшее позиционирование на ближайший релиз:

> Дай AHDE папку Python support-агента. За одну сессию он покажет воспроизводимый дефект, предложит несколько ограниченных исправлений, независимо сравнит их и отдаст один проверенный кандидат с понятной ценой и паспортом доказательств.

Support-агенты — правильный первый рынок: у них есть знания, состояние клиента, инструменты, диалоги и проверяемые бизнес-действия. Именно эти свойства уже покрыты world, KB, command Target, judge и recorded dataset. Обещание «IDE для любых агентов» следует расширять только после доказательства этого узкого сценария.

## Где продукт уже силён

- Один Workbench seam (`view`, `submit`, `decide`) обслуживает Builder, CLI и server transport.
- Human authority реализована в коде: setup, spend/apply и release не отданы модели.
- Run, Eval Run, Candidate и sealed exam имеют устойчивые артефакты и provenance.
- Command Target открывает путь к существующим Python-агентам без отдельного eval engine.
- Мир кейса, tool broker, judge abstention, KB и export дают содержательное evidence для support-сценария.
- Шесть живых сессий уже доказали основной ручной цикл; последняя провела Python Target до паспорта.
- Большой быстрый тестовый контур и package acceptance дают хорошую основу для дальнейших изменений.

## Что мешает идеальному продукту

### P0 — доверие к автоматическому выбору

Нужен persisted `ImprovementExperimentDesign` с тремя непересекающимися поверхностями:

1. `authoring`: Builder получает диагноз, failure bundle и только эти кейсы.
2. `validation`: cheap screen, полный compare и Pareto frontier используют только эти кейсы.
3. `sealed`: экзамен остаётся закрыт до выбранного человеком ship/reject и запускается один раз.

Тип и receipt должны связывать split с corpus hash, Target SHA, seed и точными task IDs. Совпадение IDs между поверхностями, слишком маленькая validation-часть и изменение корпуса должны давать отказ до model spend. Результаты на экране должны явно называться `authoring N · validation M`; слово «лучший» допустимо только для validation-измерения, а равный frontier остаётся выбором человека.

### P0 — доказательство реального пути

После split нужен один платный acceptance run на незнакомом Python support Target с 2–3 вариантами и настоящими Builder, Target и judge моделями. Допустимые действия оператора: выбрать/подтвердить модели, бюджет и итоговый ship/reject. Любое ручное исправление файлов, команды или состояния между ними — продуктовый дефект.

Сессия должна сохранить redacted transcript, receipt totals, длительность стадий, число вопросов и причины всех отказов. Это превратит auto-author из покрытой тестами функции в доказанный продуктовый путь.

### P1 — получение продукта

Версионированный tarball и checksum должны публиковаться из тега. Clean consumer устанавливает пакет, запускает smoke Target и воспроизводит `verify:package`. CI должен выполнять полный gate и package verification на `macos-14` и `ubuntu-24.04`. На Linux `sandbox: required` обязан fail closed, если confinement нельзя обеспечить.

### P1 — активация незнакомого пользователя

Первый экран должен вести к одному результату: «получи достоверный baseline». После него одна следующая фраза должна одинаково выводиться из transition policy во всех интерфейсах. Нужна stranger-сессия от `npm install` до первого candidate passport без знания внутренних терминов AHDE.

### P2 — скорость и сопровождаемость

- Сначала измерить p95 `workbench_view`/`status` на 10, 100 и 1 000 Eval Runs и 10/100 Candidates. Индекс или cache добавлять только после превышения бюджета.
- Углубить workflow guidance: один policy projection владеет legal moves, blocker priority и следующей фразой.
- Сузить внутренний `DecisionHost`, сохранив публичный Workbench facade. Переносить decision families по мере изменения, без переписывания Workbench целиком.
- Перенести approval subject, budget и result projection внутрь improvement experiment, когда будет внедряться validation split.
- Заменить magic credential-key probe в structured redaction на явный key predicate и collision-safe projection.

## Реализованный в этом срезе фундамент

Эти изменения уже внесены в рабочее дерево:

1. **Один verified Run evidence path.** Eval loader проверяет pinned world/judge sidecars один раз и передаёт значения projection-слоям. Evidence Explorer, report и exact snapshot больше не открывают mutable sidecar после проверки. Legacy sidecars без attestations не повышаются до evidence.
2. **Независимые попытки автора.** `no-change` одного варианта не обрывает остальные. Сценарий `propose → no-change → propose` передаёт два готовых предложения в search; причины отказов агрегируются и ограничиваются.
3. **Полный spend перед подтверждением.** Production author публикует детерминированный ceiling по requests/tokens/time/cost. Confirmation показывает Target subtotal, Builder ceiling и честный total; неизвестная часть делает total unknown. Target estimate теперь действительно включает Target, judge и simulated-user cost.
4. **Lossless command argv.** Onboarding показывает и разбирает кавычки/escape без shell expansion, поддерживает пробелы и пустые аргументы, а malformed ввод возвращает пользователя к review и ничего не записывает.
5. **Executed и reported tools разделены.** `toolCalls` означает только host-brokered execution; `reportedToolCalls` хранит self-report. Trace и Evidence UI показывают оба числа отдельно.
6. **Dataset export fail closed.** Если immutable development corpus отсутствует, изменён или нечитаем, затронутые строки получают infrastructure skip. Экспорт больше не выпускает правдоподобную, но неполную training line.

## План исполнения

| Очередь | Результат | Критерий выхода |
|---|---|---|
| 0 — готово в этом срезе | Evidence и bounded autoloop надёжнее | Tamper, mixed-tools, malformed argv, missing corpus, author refusal и combined-budget регрессии проходят |
| 1 | Persisted authoring/validation/sealed design | Split воспроизводится по seed/hash; overlap и undersized baskets отклоняются до inference |
| 2 | Loop использует split end to end | Author prompt не содержит validation sentinel; frontier меняется только от validation; sealed не читается |
| 3 | Paid live acceptance | Незнакомый support Target проходит от папки до candidate passport без ручного ремонта |
| 4 | Installable release и Linux support | Tagged tarball+checksum ставятся в clean consumer; macOS/Ubuntu gates зелёные |
| 5 | Stranger activation | Незнакомый оператор доходит до достоверного baseline ≤10 минут и candidate passport ≤20 минут |
| 6 | Scale and architecture | p95 view/status остаётся в бюджете; decision handlers зависят от узкого runtime |

## Метрики продукта

North-star на первом рынке: **доля незнакомых support-агентов, для которых оператор получил независимо проверенный candidate passport за одну сессию без ручного редактирования вне AHDE**.

Поддерживающие метрики:

- time to trustworthy baseline: целевое значение ≤10 минут;
- time to reviewable candidate: целевое значение ≤20 минут;
- validation leakage: 0 case IDs/content в author context;
- unexpected operator interventions: 0 между setup/budget и ship/reject;
- reproducibility: повтор exact refs воспроизводит split и verdict либо честно объясняет drift;
- cost honesty: 100% платных model lanes входят в confirmation как сумма или unknown;
- install success: clean macOS и Ubuntu consumer проходят smoke/package acceptance;
- trust defects: 0 экранов, экспортов или отчётов, которые расходятся по одному Run evidence.

## Что сознательно отложено

- Новые типы Target, model-comparison mode, live-traffic ingestion и embedding admission.
- Большой UI внутри AHDE: платформа должна рендерить текущие host-owned decisions.
- Database rewrite ради Workbench history до появления benchmark, доказывающего необходимость.
- Механическое дробление `eval.ts` или Workbench по размеру файла.
- Автономный promotion, adoption или deploy: финальная власть остаётся у человека.

Следующий законченный продуктовый срез — пункты 1–2 таблицы: независимая validation boundary на существующих runner, proposal search, receipts и gates. После него результат auto-author можно будет продавать как проверенный выбор, а не как удобный поиск гипотез.
