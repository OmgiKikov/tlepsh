# AHDE: инженерно-продуктовое ревью

Дата: 2026-09-04  
Режим: `/plan-eng-review`, независимый spawned review  
Срез: текущее рабочее дерево, включая незакоммиченные изменения. Код продукта не изменялся.

## Вердикт

AHDE уже не прототип движка. У него есть редкая и ценная основа: неизменяемые артефакты, явная человеческая власть над apply/release, sealed exam, честное разделение поведенческих и инфраструктурных ошибок, воспроизводимый package acceptance и полноценный command Target для Python-агентов. Основной риск теперь не в отсутствии очередной функции, а в том, что продукт обещает автоматический выбор улучшения раньше, чем этот выбор стал независимым от данных, на которых улучшение было придумано.

Лучший следующий законченный срез: **trustworthy autoloop**. Builder должен видеть только authoring split, варианты должны сравниваться на отдельном validation split, sealed exam должен открываться один раз после человеческого выбора. После этого нужен один платный проход с незнакомым оператором и публично устанавливаемый релизный артефакт. До этих трех результатов расширять конструктор, UI или список типов Target не стоит.

Продуктовая формулировка, которую стоит доказать: **«Дай AHDE папку рабочего support-агента; за одну сессию он покажет, что именно не работает, предложит несколько ограниченных исправлений и отдаст проверенный кандидат с понятной ценой и доказательством».** Текущие шесть живых сессий подтверждают узкий support-wedge лучше, чем обещание универсальной среды для любых агентов.

## Факты и гипотезы

Факты из репозитория:

- Обычный путь уже прошел шесть живых сессий; одна из них провела Python Target от папки до паспорта и нашла реальные дефекты движка (`docs/ROADMAP.md:9-26`).
- Новый автоматический автор вариантов покрыт интеграционными тестами только через scripted local model и еще не проходил платную живую сессию (`README.md:109-112`).
- Несколько гипотез сейчас придумываются из failure bundle development run и сравниваются на том же development corpus (`src/application/improvement-loop.ts:1101-1127`, `1179-1196`).
- README сам точно оговаривает, что это не independent validation и не доказательство лучшего агента (`README.md:103-112`).
- Package acceptance развит, но пакет пока ставится из checkout и не опубликован в registry (`README.md:12-23`).
- CI запускает весь gate только на `macos-14` (`.github/workflows/ci.yml:7-19`). Windows объявлен non-goal, Linux non-goal не объявлен (`README.md:310-313`).
- Каждое получение Workbench inventory синхронно перечитывает все development EvalRun records и все Candidate records (`src/workbench/workbench.ts:854-863`, `src/workbench/inventory.ts:803-856`).
- `AhdeWorkbench` занимает 3,405 строк и все еще содержит inventory, projections, workshop lifecycle, composites и финальный dispatch (`src/workbench/workbench.ts:833-852`, `3260-3397`). Решения уже постепенно вынесены в `src/workbench/decisions/`, то есть направление декомпозиции существует.
- Быстрый gate на этом дереве зелен: TypeScript production/test types и 1,549 тестов в 92 quick-файлах. Полный gate запущен отдельно, потому что quick-профиль исключает Git, sandbox, server и новый auto-author (`vitest.config.ts:3-60`).

Гипотезы, которые нужно проверять продуктом, а не принимать как факты:

- Для первого узкого рынка лучше всего подходит команда, владеющая support-агентом с tools/world/knowledge base. Все опубликованные живые доказательства пока из этого класса задач.
- Целевой activation metric: незнакомый оператор доходит от `ahde` до достоверного baseline за 10 минут и до reviewable improved candidate за 20 минут, не читая `manifest.yaml` и не используя экспертные slash-команды. Это целевой порог, а не уже достигнутый результат: текущий README называет около 40 минут и менее $4 на полную сессию (`README.md:124-133`).
- При десятках циклов текущая полная синхронная инвентаризация начнет делать каждое сообщение заметно медленнее. Код гарантирует линейный рост работы, но порог пользовательски заметной задержки пока не измерен.

## Находки

### 1. [P1] (confidence: 10/10) Автоматический выбор оптимизируется на данных, по которым придумано изменение

Мотивирующий код:

```ts
// src/application/improvement-loop.ts:1104-1108
const failureBundlePath = dependencies.compileFailureBundle(target, evaluation.record, runsRoot);
...
const decision = await options.author({
```

```ts
// src/application/improvement-loop.ts:1179-1189
const search = await dependencies.runProposalSearch({
  ...
  ...(options.developmentCorpus ? { developmentCorpus: options.developmentCorpus } : {}),
  developmentTasks: Math.round(evaluation.record.summary.total / options.repetitions),
```

Один и тот же development surface формирует диагноз и выбирает вариант. При 2–4 вариантах и нескольких циклах лучший observed delta неизбежно получает selection bias. Sealed gate защищает от явной регрессии, но текущая политика `pass` не доказывает, что улучшение переносится на невидимые задачи. Для продукта, продающего доказательство, это главный разрыв доверия.

Рекомендация [Layer 3]: ввести persisted `ImprovementExperimentDesign` с `authoringTaskIds`, `validationTaskIds`, seed и хешами. Диагноз и failure bundle видят authoring IDs; cheap check, full comparison и frontier используют только validation IDs; sealed IDs остаются недоступны до ship. При слишком маленькой корзине multi-hypothesis flow должен отказаться до model spend и предложить обычный single-change review либо попросить больше кейсов.

Не делать скрытый random split на каждом запуске: он разрушит воспроизводимость и позволит случайно переигрывать выбор. Split является частью evidence identity.

### 2. [P1] (confidence: 10/10) Флагманский auto-author еще не прошел реальный provider loop

Мотивирующая строка:

```md
<!-- README.md:111-112 -->
Integration tests cover this path with scripted local models; this
new automatic-author path has not yet been tested in a paid live session.
```

Тесты хорошо проверяют ограничения, receipts, cancellation и отсутствие sealed leakage. Они не отвечают на продуктовые вопросы: умеет ли реальная выбранная Builder model за 8 turns стабильно прочитать unfamiliar harness, выдвинуть разные гипотезы, уложиться в контекст и оставить оператору понятный итог.

Рекомендация: после validation split провести одну acceptance-сессию на реальном Python support Target, с 2–3 вариантами и настоящими Target/judge/Builder моделями. Сохранить redacted transcript, receipt totals, время по стадиям и все моменты ручного вмешательства. Любое вмешательство, кроме выбора модели, согласия на бюджет и финального ship/reject, считается дефектом продукта.

### 3. [P1] (confidence: 10/10) Работающий продукт пока нельзя нормально получить

Мотивирующие строки:

```md
<!-- README.md:14-20 -->
Node.js ≥ 22.19 and Git. The package carries its pinned Pi runtime and is
not on the npm registry yet, so install it from a checkout:
...
npm ci --ignore-scripts && npm run build && npm link
```

Package verification уже делает тяжелую часть: pack, clean global/local install и вертикальный cycle. Но нет publish job и versioned download surface. Для внешнего пользователя checkout, build и `npm link` превращают продукт в репозиторий для разработчика.

Рекомендация [Layer 1]: после живого acceptance добавить GitHub Release workflow, который на теге выполняет полный gate, строит единственный tarball, проверяет его через `verify:package`, публикует tarball и SHA-256 checksum. README должен устанавливать именно опубликованный артефакт. Публикацию в npm можно добавить, когда подтверждены ownership имени и политика provenance; отсутствие registry не должно блокировать первый нормальный install.

### 4. [P1] (confidence: 9/10) Linux входит в фактическое обещание, но CI проверяет только macOS

Мотивирующий код:

```yaml
# .github/workflows/ci.yml:7-10
jobs:
  test:
    runs-on: macos-14
```

README требует только Node и Git и отдельно исключает Windows. Значит Linux-пользователь разумно считает себя поддержанным. Между тем главные риски AHDE именно платформенные: process spawning, filesystem modes, Git worktrees, sandbox detection, container invocation и signal handling.

Рекомендация [Layer 1]: сделать matrix `macos-14` + `ubuntu-24.04` для `npm run check` и `npm run verify:package`. Platform-specific sandbox tests должны либо доказывать реальное confinement, либо проверять честный `best-effort/required` отказ. Не эмулировать macOS sandbox на Linux.

### 5. [P2] (confidence: 8/10) Продукт доказан автором, но еще не измерен на незнакомом операторе

Мотивирующие строки:

```md
<!-- docs/ROADMAP.md:82-84 -->
Then the stranger's session:
an operator who has never seen AHDE, on the Python agent, timed from
`ahde` to passport.
```

Roadmap правильно называет недостающий тест, но текущий diff уже двигается к Stage 3. Без stranger session неизвестно, что ограничивает activation: установка, выбор трех ролей моделей, подготовка кейсов, понимание evidence или trust в ship dialog.

Рекомендация: принять один продуктовый SLO и сделать его acceptance gate: `time_to_baseline`, `time_to_reviewable_candidate`, число неожиданных вопросов, ручных команд, provider retries и полная стоимость по ролям. Не добавлять внешнюю телеметрию: эти числа уже выводятся из локальных immutable receipts и timestamps. Нужен read-only session summary/export, пригодный для пользовательского исследования.

### 6. [P2] (confidence: 8/10) Workbench перечитывает всю историю на каждом view/decision без latency budget

Мотивирующий код:

```ts
// src/workbench/workbench.ts:854-862
inventory(): WorkbenchInventory {
  return this.dependencies.loadInventory({ ... });
}
```

```ts
// src/workbench/inventory.ts:803-820
const listed = listEvalRunIndexesLenient(options.runsRoot);
...
.map((run) => loadEvalRun(options.runsRoot, run.evalRunId))
```

```ts
// src/workbench/inventory.ts:842-856
const listedCandidates = listCandidates(options.runsRoot, warnings, integrityBlockers);
const candidates = validateProjectCandidates({ ... });
```

Целостность важнее скорости, и нельзя заменять ее слепым mutable cache. Но продукт прямо ведет многоверсионную историю; линейное полное чтение на каждом model tool call со временем ударит по диалогу.

Рекомендация: сначала benchmark на 10/100/1,000 EvalRuns и 10/100 Candidates с бюджетом p95 для `/status` и `workbench_view`. Только после измерения добавить content-addressed verified summaries или append-only project index с fail-closed revalidation изменившихся файлов. Не делать database rewrite.

### 7. [P2] (confidence: 10/10) Главный orchestration boundary остается слишком большим для безопасной скорости изменений

Мотивирующий код:

```ts
// src/workbench/workbench.ts:833-852
export class AhdeWorkbench {
  ...
  readonly dependencies: AhdeWorkbenchDependencies;
  private workshop: BuilderWorkshop | null = null;
```

```ts
// src/workbench/workbench.ts:3347-3395
if (input.kind === "start-testing") return await this.startTesting(...);
if (input.kind === "ship") return await this.ship(...);
...
if (input.kind === "improve") return decideImprove(this, input, ctx);
```

`AhdeWorkbench` одновременно является facade, dependency container, projection service, workshop session owner и composite coordinator. Уже вынесенные decision handlers показывают правильное направление, но новые продуктовые изменения все еще имеют высокий blast radius через общий класс и широкий `AhdeWorkbenchDependencies` contract.

Рекомендация: не переписывать Workbench. При реализации split вынести ровно один новый глубокий модуль: pure `ImprovementExperimentDesign` + валидация переходов. Оставить `AhdeWorkbench` публичным facade. Следующими касаниями вынести `startTesting`, `ship` и workshop lifecycle в существующий стиль handlers; каждый перенос отдельно от изменения поведения. Полный DI/framework или новая event architecture здесь только ухудшат продукт.

## Что уже существует и должно быть переиспользовано

- `runSuite`, exact snapshots, corpus identity и task selection являются существующим execution seam; split должен ограничивать task IDs, а не создавать второй runner.
- `proposal-search.ts` уже умеет одинаково применять, screen и сравнивать 2–4 гипотезы и строить frontier; ему нужен validation surface, а не новый search engine.
- Sealed visibility и `improvementLoopGate` уже структурно запрещают loop читать экзамен или принимать release decisions.
- `ImprovementAuthorReceipt` уже хранит provider usage, unknown cost при сбое и cancellation; acceptance metric надо собирать из receipts.
- `verify:package` уже проверяет реальный packed consumer и полный цикл; release pipeline должен вызывать его без новой упаковочной системы.
- `workbench/decisions/` уже задает направление постепенной декомпозиции.

## Рекомендуемый срез реализации

### Цель

После одной человеческой авторизации AHDE может придумать 2–4 изменения, сравнить их на данных, которых автор не видел, и отдать только независимо улучшившиеся кандидаты для review. Ни одна ветка, sealed case или release decision не скрыта и не переносится между ролями.

```text
reviewed development corpus
          |
          v
  persisted split design
   |                    |
   | authoring IDs      | validation IDs
   v                    v
baseline -> diagnose    baseline snapshot
   |                        |
failure bundle              +------------------+
   |                                           |
   v                                           v
bounded Builder author -> proposal(s) -> cheap screen -> full validation compare
                                                    |
                                           Pareto/frontier + receipts
                                                    |
                                           human review / reject
                                                    |
                                      sealed exam once, during ship gate
```

Порядок:

1. Добавить immutable schema/design для split и детерминированное распределение task IDs. Persist before spend; hash into loop ledger and candidate provenance.
2. Провести authoring baseline/diagnosis только на authoring IDs. Убедиться, что ни context, ни failure bundle, ни Builder transcript не содержат validation IDs или content.
3. Передать validation selection существующим cheap-check и proposal-search paths. Таблица обязана подписывать `authoring N · validation M`, а score/delta для выбора всегда обозначать как validation.
4. Ввести preflight минимального размера. При недостатке кейсов refuse before spend с конкретным количеством недостающих кейсов и безопасным следующим действием.
5. Добавить recovery: resume читает тот же exact split hash; изменившийся corpus/seed/task membership делает loop stale и не запускает модель.
6. Запустить paid live acceptance. Исправить только обнаруженные блокеры; не расширять функцию.
7. Добавить Linux CI и versioned GitHub Release artifact.

Это затронет больше восьми файлов, но это не аргумент урезать trust boundary: split проходит через schema, runner selection, provenance, rendering и tests. Сокращать нужно количество новых абстракций, а не проверяемую поверхность.

## Граничные случаи и поведение

- 0–1 validation cases или слишком маленькая authoring часть: отказ до inference с `have/need` и предложением добавить кейсы либо запустить обычный single-change flow.
- Одинаковые/дублирующиеся task IDs: schema reject; порядок входного JSONL не должен менять split.
- Corpus изменился после consent: stale error до author request; resume не пересчитывает split.
- Один вариант не скомпилировался: receipt остается, остальные варианты можно сравнить, если minimum candidate count выполнен.
- Provider timeout/cancel: unknown cost сохраняется, workshop удаляется, loop resume не повторяет уже durable applied branch.
- Validation regression при хорошем authoring result: кандидат не попадает в frontier.
- Несколько вариантов статистически неразличимы: показать frontier и cost/latency, не объявлять победителя.
- Sealed exam отсутствует или underpowered: validation candidate можно review, ship остается заблокирован существующим gate.
- Linux без enforceable sandbox: `sandbox: required` fail closed; best-effort честно маркируется и не получает promotable evidence.
- Release job потерял bundled tarball/dependency: clean-install acceptance падает до публикации release.

## Обязательные тесты

```text
CODE PATHS                                             USER FLOWS
[+] install/package                                   [+] First result
  [★★★] local pack -> clean consumer                     [★★] internal live sessions
  [GAP] public release tarball                           [GAP] stranger: ahde -> baseline <= target

[+] target/onboarding                                  [+] Manual improve
  [★★★] fresh folder + adopted Python Target             [★★★] diagnose -> proposal -> review -> ship
  [★★★] credentials, cancellation, stale subject

[+] automatic improve                                  [+] Try a few approaches
  [★★★] scripted Pi author limits/receipts               [GAP] author sees authoring split only
  [★★★] cancellation/provider failure                    [GAP] frontier uses validation split only
  [★★★] apply/screen/compare without sealed/release       [GAP] real paid provider end-to-end
  [GAP] deterministic persisted split                    [GAP] small basket recovery UX
  [GAP] stale split/corpus refusal

[+] long history                                      [+] Returning operator
  [GAP] 10/100/1,000-run inventory benchmark            [GAP] /status p95 latency budget

[+] supported hosts                                   [+] Installation outside author machine
  [★★★] macOS full CI                                    [GAP] Ubuntu full CI + packed consumer
```

Новые обязательные тесты:

- Unit: split deterministic across order, stable seed, exact disjoint union, no duplicates, minimum size errors.
- Integration: author context and failure bundle contain only authoring cases; search and verification execute only validation cases; sealed IDs never appear.
- Regression: resume uses exact persisted split and rejects changed corpus, current Target, split schema or seed before spend.
- Integration: mixed author outcomes (proposal, no-change, provider error) preserve all receipts and compare the remaining valid minimum.
- Integration: candidate that improves authoring but regresses validation never becomes reviewable.
- Integration: equal validation frontier remains a user choice and never gets labeled «best».
- E2E: production Builder Pi with real provider, Python command Target, world/tool use, 2+ hypotheses, review and sealed ship.
- E2E: Ubuntu pack/install/validate/demo or equivalent deterministic vertical slice.
- Performance: inventory/view p50/p95 at 10, 100 and 1,000 EvalRuns; benchmark fails only against an explicit generous budget to avoid CI flakes.

## Failure modes

| Codepath | Production failure | Test now | Handling now | User result |
|---|---|---:|---:|---|
| Pi author | Provider fails or ignores abort | yes, scripted | durable receipt, bounded abort | clear no-change/unknown cost |
| Multi-hypothesis selection | Same data authors and selects | no | disclosure only | plausible but biased winner |
| Resume | Corpus/split changed | split absent | corpus lineage checks exist | needs exact split stale error |
| Public install | Published artifact misses bundled runtime | no public artifact | local `verify:package` catches pack | user cannot install normally |
| Linux execution | sandbox/process semantics differ | no Linux CI | runtime may report confinement | release risk until CI exists |
| Long project history | every view reloads all evidence | no benchmark | bounded individual artifacts | progressive latency, no budget |

Критический gap: multi-hypothesis selection имеет тесты исполнения и error handling, но не имеет независимой validation boundary; пользователь получает уверенно выглядящий результат, ограничение которого видно только в disclosure.

## NOT in scope

- Встроенный web UI: `serve` уже является правильным platform seam; он не улучшит честность выбора.
- Полный rewrite Workbench или переход на БД: слишком большой blast radius до измеренного bottleneck.
- Embedding-based case admission: полезно позже, но не блокирует validation split.
- Model comparison, production traffic ingest и transfer reports: отложить до доказанного automatic improvement flow.
- Windows: явно объявленный non-goal.
- Автономный ship: человеческая release authority является ценностью продукта, а не friction для удаления.

## Параллелизация

| Lane | Модули | Зависит от |
|---|---|---|
| A | experiment design, corpus/task selection, provenance | — |
| B | CI/release packaging | — |
| C | improvement loop, proposal search, rendering | A |
| D | integration/E2E acceptance | A + C; release acceptance also B |
| E | inventory benchmark | — |

Запустить A, B и E параллельно. После A выполнить C. Затем D на слитом срезе. A и C оба коснутся application contracts, поэтому в параллельных worktree их вести не стоит.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2–3d / CC: ~45–90m)** — Experiment design — Persist a deterministic authoring/validation split and bind it to corpus, target and loop provenance.
  - Surfaced by: finding 1.
  - Files: `src/application/`, `src/domain/`, storage schemas, focused tests.
  - Verify: split unit tests plus stale/resume integration tests.
- [ ] **T2 (P1, human: ~2d / CC: ~45–90m)** — Improvement loop — Route diagnosis/authoring and selection/verification through disjoint task sets and label every measurement surface.
  - Surfaced by: finding 1.
  - Files: `src/application/improvement-loop.ts`, `src/application/proposal-search.ts`, renderers, tests.
  - Verify: no-leak integration tests and `npm run check`.
- [ ] **T3 (P1, human: ~0.5–1d / CC: execution-bound)** — Product acceptance — Complete one paid stranger session with a real Python support agent and retain redacted timing/spend/intervention evidence.
  - Surfaced by: findings 2 and 5.
  - Files: session artifact/report; code only for bugs actually found.
  - Verify: candidate reviewed, sealed gate executed once, passport produced.
- [ ] **T4 (P1, human: ~0.5d / CC: ~15m)** — Platform support — Run the full test/package gate on macOS and Ubuntu.
  - Surfaced by: finding 4.
  - Files: `.github/workflows/ci.yml`, only platform-specific test fixes if demonstrated.
  - Verify: both matrix jobs green.
- [ ] **T5 (P1, human: ~0.5–1d / CC: ~20m)** — Distribution — Publish a verified versioned tarball and checksum from a tag.
  - Surfaced by: finding 3.
  - Files: release workflow, README install instructions.
  - Verify: download release artifact into empty consumer and execute help/validate smoke.
- [ ] **T6 (P2, human: ~1d / CC: ~30m)** — Workbench performance — Establish history-size latency benchmarks before choosing an index/cache.
  - Surfaced by: finding 6.
  - Files: benchmark fixture and inventory/view benchmark.
  - Verify: recorded p50/p95 at 10/100/1,000 runs.
- [ ] **T7 (P3, incremental only)** — Workbench architecture — Move remaining composites/lifecycle handlers when touched, preserving the facade and behavior.
  - Surfaced by: finding 7.
  - Files: `src/workbench/workbench.ts`, `src/workbench/decisions/`.
  - Verify: focused behavior-parity tests; never combine a move with a behavior change.

## Deferred work

- An indexed inventory is deferred until T6 demonstrates the latency threshold.
- npm registry publication is deferred until package-name ownership and provenance policy are settled; GitHub Releases provides a complete first distribution path.
- Case admission quality and embedding novelty are deferred until the validation contract is correct.
- Broader positioning beyond support agents is deferred until a second domain completes the same stranger acceptance without product changes.

## Completion summary

- Step 0 Scope Challenge: reuse current runner/search/gates; scope reduced to validation integrity, acceptance and distribution.
- Architecture Review: 3 issues (validation boundary, inventory scaling, Workbench boundary).
- Code Quality Review: 1 issue (oversized orchestration facade); no verified correctness bug in the inspected working tree.
- Test Review: diagram produced; 8 material gaps, of which validation leakage is critical.
- Performance Review: 1 issue (unbounded full inventory reload), benchmark required before optimization.
- What already exists: recorded above; no parallel evaluation engine recommended.
- NOT in scope: written.
- Failure modes: 1 critical trust gap flagged.
- Parallelization: 3 lanes can start independently, then loop integration and E2E are sequential.
- Lake score: complete validation/error/resume coverage recommended; no shortcut selected.

STATUS: **DONE_WITH_CONCERNS**  
REASON: core engine and quick gate are strong; automatic candidate choice lacks the independent validation boundary promised by the roadmap and has no paid live acceptance yet.  
RECOMMENDATION: implement T1+T2, run T3, then land T4+T5. Do not build Stage 4 before that sequence is green.
