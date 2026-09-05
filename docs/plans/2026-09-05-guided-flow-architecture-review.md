# AHDE: архитектура управляемого терминального цикла

Дата: 2026-09-05. Основа: HEAD `78690e5` и отдельно просмотренный dirty WIP. Метод: `improve-codebase-architecture`, `codebase-design`, deletion test, независимые вопросы параллельным engineering/quality reviewers. Это план: исходники не изменены, новые тесты не запускались.

Выбран **один расчёт следующего действия и восстановления в Workbench**. Он даёт наибольший product leverage: Builder, терминальный статус и HTTP должны описывать одну и ту же доступную работу после запуска, отказа, прерывания и следующего цикла. До расширения composite-flow также нужно устранить конкретный разрыв между тем, что человек подтвердил в `ship`, и тем, что дочерний шаг может принять автоматически.

Терминал остаётся главным. HTTP — существующий второй adapter Workbench и seam для интеграций; эта работа не создаёт browser Builder или Studio. Локальный веб для Evidence остаётся отдельной проекцией.

## Основа и ограничения проверки

Прочитаны предыдущие architecture/engineering/quality reviews и текущие участки Workbench, inventory, transition policy, next actions, run-current, composites, Builder jobs, оба терминальных входа и HTTP adapter. Нового полного аудита репозитория, live provider calls, build или test run здесь нет. Указанные строки относятся к просмотренному рабочему дереву; Workbench/serve не имеют исходных WIP-изменений, у Builder небольшие незавершённые правки относительно HEAD.

Предыдущий сильный кандидат «verified Run evidence» уже реализован в HEAD; повторно выделять его как отсутствующую архитектуру неправильно. Предыдущая рекомендация объединить guidance всё ещё актуальна и теперь имеет конкретную несовместимость поведения. Validation split тоже уже существует; не следует вновь проектировать его с нуля.

Dirty WIP нельзя считать проверенным продуктом: rejected `src/studio/`, незавершённый Evidence, resource/watch/regression-guard fixes и связанные тесты. Последняя известная проверка типов останавливалась на семи ошибках Evidence; это контекст предыдущей проверки, а не новый результат этого review. До реализации нужно отделить принятую работу от отвергнутой и восстановить зелёную исходную точку либо явно вести отдельные ошибки WIP.

`CONTEXT.md` и `docs/adr/` не найдены. Используется существующий язык README: Target, Spec, Corpus, Run, Eval Run, Diagnosis, Proposal, Candidate, Promotion, Adoption, Evidence. Нового domain aggregate или журнала workflow не предлагается.

## Что сохраняем

- `Workbench.view / submit / decide` — уже хороший внешний interface: [workbench.ts:2852](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:2852), [workbench.ts:3053](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:3053), [workbench.ts:3440](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:3440).
- Стадия восстанавливается из проверенных durable artifacts, не из беседы. Existing focus, Candidate events, adoption/continuation receipts и workshop note — достаточная основа restart: [inventory.ts:984](/Users/kikov/Desktop/harness/src/workbench/inventory.ts:984), [workbench.ts:2862](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:2862).
- Direct decisions уже делают свежую проверку exact subject после human gate. Например, публикация сверяет draft hash, review — Candidate hash, adoption — полный subject: [decisions/corpus.ts:50](/Users/kikov/Desktop/harness/src/workbench/decisions/corpus.ts:50), [decisions/release.ts:22](/Users/kikov/Desktop/harness/src/workbench/decisions/release.ts:22), [decisions/release.ts:101](/Users/kikov/Desktop/harness/src/workbench/decisions/release.ts:101).
- У Workbench два реальных adapter: TUI и HTTP. HTTP уже вызывает тот же `decide` и использует host-owned confirmation registry: [serve/server.ts:249](/Users/kikov/Desktop/harness/src/serve/server.ts:249). HTTP не должен импортировать терминальные jobs или получать право авторизовать действия из текста модели.
- `run-current`, `start-testing` и `ship` уже дают человеку намерение вместо длинной последовательности команд; сохраняем их receipts и вызовы существующих решений.

## 1. Углубить guidance и разрешение `run-current`

**Strong · in-process · выбран первым.**

Файлы: `src/workbench/inventory.ts`, `next-actions.ts`, `transition-policy.ts`, `decisions/run-current.ts`, `types.ts`, `workbench.ts`; consumers: `src/builder/render/stage.ts`, `workbench-adapter.ts`, `src/serve/server.ts`.

### Подтверждённая проблема

Одно намерение сейчас получает несколько независимых трактовок:

1. `inventory.stageFor` различает обычную verification и interrupted Candidate, но оба случая имеют стадию `candidate-verification`; interrupted возвращает `review / abandon-candidate`: [inventory.ts:1302](/Users/kikov/Desktop/harness/src/workbench/inventory.ts:1302).
2. `next-actions` не принимает Candidate/focus/blocker facts и рекламирует `run-current` по одной стадии: [next-actions.ts:120](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:120), [next-actions.ts:144](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:144).
3. Исполнитель сначала отказывается при любом незавершённом Candidate проекта: [decisions/run-current.ts:56](/Users/kikov/Desktop/harness/src/workbench/decisions/run-current.ts:56).
4. TUI понимает прерывание только если открыт `detail.aspect === "review"`: [render/stage.ts:69](/Users/kikov/Desktop/harness/src/builder/render/stage.ts:69). Summary той же durable ситуации получает другую подсказку.
5. HTTP забирает model projection из TUI adapter, который заново вызывает `workbenchNext`: [serve/server.ts:5](/Users/kikov/Desktop/harness/src/serve/server.ts:5), [workbench-adapter.ts:324](/Users/kikov/Desktop/harness/src/builder/workbench-adapter.ts:324).

Это подтверждено чтением вызовов, а не новым runtime-тестом. Ещё один различимый случай: integrity failure маскируется под `selection-required`, хотя выбор артефакта не восстанавливает целостность: [inventory.ts:1200](/Users/kikov/Desktop/harness/src/workbench/inventory.ts:1200).

### Before → after

```text
BEFORE
inventory → stage + loose hints
stage → next-actions → Builder/HTTP suggestions
stage + detail → TUI nextStep
inventory → decideRunCurrent → separate selection/refusal

AFTER
verified inventory + host facts
       ↓
Workbench guidance module
  action resolution · blocker precedence · recovery · selected subject
       ├─ WorkbenchView guidance → TUI / model projection / HTTP
       └─ fresh action resolution → existing decide → existing human gate
```

Guidance — производная проекция, не authority. Перед выполнением Workbench перечитывает inventory и вызывает тот же resolver; клиентская подсказка не является разрешением и не хранится как новый workflow state.

### Deletion test

Если удалить отдельную stage-based таблицу `RUN_CURRENT_RESOLUTIONS` и conditionals `nextStep`, исчезает дублирование, а полезная сложность концентрируется в Workbench. Если удалить получившийся module, выбор Candidate, blocker precedence и recovery вновь разойдутся по TUI, HTTP и execution. Значит module зарабатывает depth. Переместить старые функции в новый файл, оставив три расчёта, тест не проходит.

### Interface и test seam

Остаётся внешний interface `view / submit / decide`. Внутри нужен resolver со строгим discriminated результатом: разрешённый маршрут (`start-testing`, `run-eval` с Corpus, `verify-candidate` с Builder run) либо typed blocker и допустимое recovery. Не `boolean`, `unknown` bag или exception-as-normal-selection. Reason/repetitions пользователя добавляются при вызове существующего решения; guidance не выдумывает их и не заполняет version за человека.

View получает model-safe guidance: recommended action, объяснение с typed code, доступные решения/authoring moves, recovery с нужным artifact id. Для рекомендованного действия допускаются также `inspect` и `select`: они не должны изображать write decision. Указание human attention различает обычную политику и возможный cost guard; статическое `asks: false` не должно обещать отсутствие вопроса при неизвестной цене.

Тесты проходят через реальные seams: один и тот же fixture → `Workbench.view(summary/review/traces)` → TUI/model/HTTP projection; затем `decide(run-current)`. На общей ситуации проверяем общий action code и отсутствие недопустимого выполнения. Pure resolver matrix оправдана, но не заменяет wiring tests.

## 2. Углубить исполнение работы в Builder

**Strong · in-process.** Независимо подтверждено engineering и quality reviewers.

Файлы: `src/builder/jobs.ts`, `commands.ts`, `workbench-adapter.ts`, `extension.ts`, `run-observation.ts`.

### Подтверждённая проблема

Slash route владеет private `jobs`, запускает measurement через `jobs.start`, соединяет signal/progress/gate и `/stop`: [commands.ts:641](/Users/kikov/Desktop/harness/src/builder/commands.ts:641), [commands.ts:878](/Users/kikov/Desktop/harness/src/builder/commands.ts:878). Natural-language tool собирает отдельный observation и напрямую вызывает `workbench.decide`: [workbench-adapter.ts:618](/Users/kikov/Desktop/harness/src/builder/workbench-adapter.ts:618), [workbench-adapter.ts:657](/Users/kikov/Desktop/harness/src/builder/workbench-adapter.ts:657). Extension создаёт их без общего исполнителя: [extension.ts:277](/Users/kikov/Desktop/harness/src/builder/extension.ts:277).

Поэтому busy/stop/background не имеют единого владельца для двух входов. Это структурный факт; поведение конкретной Pi-сессии в этом review не воспроизводилось. Дополнительно `jobs.dispose` снимает ticker, но не abort: [jobs.ts:370](/Users/kikov/Desktop/harness/src/builder/jobs.ts:370); completion ждёт `waitForIdle` до освобождения job: [jobs.ts:309](/Users/kikov/Desktop/harness/src/builder/jobs.ts:309). Фраза `Nothing was decided` при stop не соответствует composite, уже записавшему предыдущие шаги: [jobs.ts:359](/Users/kikov/Desktop/harness/src/builder/jobs.ts:359).

### Before → after

```text
BEFORE                              AFTER
/test → jobs → observe → decide      /test ───┐
“проверь” → observe → decide         tool ────┴→ Builder execution module
/stop → only slash jobs                         jobs · progress · signal · result
                                               ↓
                                           Workbench.decide
```

Один module у extension концентрирует существующие jobs/observation, не создавая второго Workbench. TUI natural и slash — два входа одного adapter, их нельзя выдавать за два транспорта. HTTP остаётся вторым adapter **Workbench**, со своим operation registry.

### Deletion test / test seam

Удаление `runObserved` и повторной observation/gate assembly из tool должно сократить caller knowledge. Если новая функция просто вызывает переданный callback, а оба callers продолжают владеть signals, busy и lifecycle, она shallow. Нужна одна проверяемая операция: start/stop/active, плюс честный discriminated результат `completed(result)` или `running(job receipt, current view)`. Текущий `jobs.start(): Promise<void>` недостаточен для model tool; выдавать fake completed result нельзя.

Проверки: natural и slash проходят одинаковые busy/stop/observation сценарии; awaiting-human не называется running; cancel до согласия ничего не пишет; cancel после durable шага сохраняет его receipt и показывает настоящее recovery; один completion note; terminal shutdown останавливает локальное исполнение без обещания rollback. Не создавать distributed job scheduler или database.

## 3. Углубить подтверждённый composite plan

**Strong · local-substitutable.** Узкое исправление freshness требуется до расширения flow.

Файлы: `src/workbench/workbench.ts` (composites), `decisions/release.ts`, существующие `describe*` functions; тест `tests/workbench-composites.test.ts`.

### Подтверждённая проблема и конкретный сценарий

`compositeGate` обещает exact subject, но принимает predicates над `unknown`: [workbench.ts:1338](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1338). `start-testing` сопоставляет ID draft, run operation/repetitions, отдельные model IDs: [workbench.ts:1393](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1393), [workbench.ts:1455](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1455). `ship` сопоставляет Candidate ID и version: [workbench.ts:1686](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1686), хотя показывает точную ветку: [workbench.ts:1699](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1699).

Статически прослеженный сценарий без подделки артефактов:

1. Existing `terminalCandidateFixture("promoted")`, активная ветка A на baseline; Candidate готов к adoption.
2. `ship` строит human subject с `fastForward: A baseline → candidate` и ждёт `gate.confirm`.
3. Пока gate открыт, человек/другой процесс создаёт и выбирает ветку B **на том же baseline HEAD**, затем отвечает «да» исходному вопросу.
4. Дочерний `adopt-candidate` впервые строит свой before уже для B. Composite принимает его по Candidate ID; дочерняя before/after freshness сравнивает B с B.
5. `describeTargetAdoption` разрешает текущую локальную ветку на baseline, не требует baseline branch name: [target-adoption.ts:400](/Users/kikov/Desktop/harness/src/application/target-adoption.ts:400), [target-adoption.ts:414](/Users/kikov/Desktop/harness/src/application/target-adoption.ts:414). В результате consent для A может оплатить adoption B.

Это причинный анализ исходников, **не выполненный exploit test**. Нижний adoption module уже защищает свой exact subject; ошибка находится между внешним composite consent и дочерним consent.

### Before → after

```text
BEFORE
human sees A + hashes → approves
   child builds current B → predicate(candidateId) → automatic yes

AFTER
host prepares exact composite plan → human approves plan
   fresh pinned facts must still match
   child subject must match reviewed branch/revision/evidence
   expected own lifecycle steps advance pins explicitly
```

### Минимальное исправление и test seam

Для первого среза не нужен generic plan engine. `ship` хранит host-only reviewed pins: current branch/ref/HEAD, Candidate record, exact Proposal evidence, version/tag и решение об adoption. Сразу после внешнего confirm перечитывает релевантные факты, отказывается при внешней смене. Matching дочернего adoption связывает exact branch/subject с планом, а не только Candidate ID. Аналогично `start-testing` связывает Spec/Corpus hashes и execution surface, а не ID.

Нельзя сравнивать весь Candidate record с начальным hash перед каждым шагом: собственные `review → promote` закономерно меняют его. Различаем внешнюю freshness и допустимую собственную progression; pins после шага берём из его реального результата. Workshop grants и tool authoring по-прежнему не наследуют composite consent. Restart не восстанавливает in-memory approval; новое «продолжи» строит новый план из оставшихся receipts.

Точный regression test: в outer `ship` gate callback переключить на B с тем же SHA, затем approve; ожидать stale refusal **до adoption**, обе ветки всё ещё baseline, нет adoption/continuation receipts, только один human question. Контроль: неизменный plan делает один вопрос и сохраняет те же receipts, что отдельные решения. Дополнительно mutation между шагами, отмена, повтор after restart, действительно ожидаемые review/promote mutations. Реальный временный Git repository и реальные receipt loaders, scripted gate; никаких provider mocks ради этой проверки.

### Deletion test

Полезная сложность — exact subject preparation, freshness, ожидаемая progression и stop-on-refusal — должна концентрироваться рядом с composite. Удаление ID-only predicates уменьшает неоднозначность. Создание универсального `Plan<T>` с hook на каждый шаг лишь перенесёт те же casts в callers и не добавит depth.

## 4. Сузить внутренний interface решений Workbench

**Worth exploring · in-process.** Делать только рядом с реально изменяемыми решениями.

`DecisionHost = AhdeWorkbench` отдаёт всем handlers весь class: [decisions/shared.ts:6](/Users/kikov/Desktop/harness/src/workbench/decisions/shared.ts:6). Семь семей импортируют runtime helpers обратно из `workbench.ts`, который импортирует эти семьи: например [decisions/release.ts:10](/Users/kikov/Desktop/harness/src/workbench/decisions/release.ts:10), [decisions/evaluation.ts:23](/Users/kikov/Desktop/harness/src/workbench/decisions/evaluation.ts:23).

Before: каждый decision module знает весь Workbench и возвращается в него за helpers. After: внешний `view / submit / decide` неизменен; внутри узкий family-specific interface для inventory refresh, подтверждения, receipts, selections и конкретных execution dependencies. Common pure helpers живут вне facade. Не строить один огромный новый `DecisionRuntime`, повторяющий class.

Deletion test: удалить сами decision modules — их ~1,600 строк вернутся в facade, полезная locality исчезнет. Удалить full-class type dependency — исчезнет лишнее знание, поведение останется. Это нужное углубление; число файлов или строк само по себе не является целью.

Test seam: существующие `workbench.decide` integration tests остаются. Типы должны запрещать обработчику доступ к несвязанным методам. Не добавлять тест на каждую перенесённую helper function; чистый перенос отдельно от изменения поведения.

## План выбранного среза

### Продуктовый контракт

Пользователь описывает задачу → обсуждает Spec → строит/улучшает Target → собирает и проверяет кейсы → читает failure → рассматривает exact Proposal → проверяет Candidate → подтверждает версию → продолжает цикл. На каждом durable состоянии host показывает одну рекомендуемую следующую работу и конкретное препятствие. После interruption/restart он ссылается на существующий artifact, а не предлагает всё начать сначала.

`Looks good / needs improvement` не должны автоматически означать promotion или утверждение, что production outcome доказан. Для текущего среза используем существующие production-failure import, Corpus review, Proposal и Candidate receipts; полноценную новую identity `review event → regression case → learned behavior` проектировать отдельно. Нельзя обещать её одной новой строкой guidance.

### Порядок реализации

| Шаг | Файлы / задача | Проверяемый результат |
|---|---|---|
| 0 | Инвентаризировать и отделить rejected Studio и pending Evidence/trust WIP | Известен baseline; новые ошибки не смешаны со старыми |
| 1 | `workbench/types.ts`, `inventory.ts`, новый внутренний `run-resolution.ts` либо углубление `next-actions.ts` | Typed ready/blocked route использует проверенные project/focus/Candidate/Proposal facts; sidecar чтение остаётся в verified inventory implementation |
| 2 | `decisions/run-current.ts` | Удалён отдельный stage dispatch/selection; execution вызывает общий resolver на свежем inventory, затем существующий direct decision |
| 3 | `workbench.ts:viewOf`, `next-actions.ts`, `transition-policy.ts` | Guidance вычисляется один раз до выбора detail aspect; stage tables остаются enforcement policy; есть typed recovery без возможности принять authority из view |
| 4 | `builder/render/stage.ts`, `render/view.ts`, `workbench-adapter.ts`, `serve/server.ts` | Model и TUI читают ready guidance; удалены дублирующие run routing и blocker conditionals. Общий model projection вынесен из TUI module только настолько, чтобы HTTP не зависел от терминального adapter |
| 5 | `tests/workbench-*`, `tests/workbench-adapter-projection.test.ts`, существующие render/serve fixtures | Общая matrix state→guidance→actual decision; один wiring test для TUI и HTTP; sealed/credential-safe projection сохранена |
| 6 | `workbench.ts:ship`, `tests/workbench-composites.test.ts` | Branch-switch consent regression закрыта узкими pins; один вопрос на неизменный composite, no stale automatic adoption |
| 7 | Focused tests, production/test typecheck, затем общий gate владельцем root | Исходные invariant/receipt/restart tests зелёные; новый flow не расширяет permission и не ломает legacy evidence |

Общий projection перенос не означает переписать все `unknown` функции разом. Новый core guidance получает строгий тип; совместимость legacy serialized views держится в одном ingress fallback. Production view всегда содержит новое поле. Не делать `guidance?` во всех новых callers только ради старых hand-built fixtures.

Если extraction требует читать application receipt в pure resolver, дополнить **существующий verified inventory** минимальными фактами (например `apply.via`), а не создать второй loader. Это особенно важно для `appliedWithoutCandidate` и исключения proposal-search origins.

### Acceptance matrix

- Missing Target → create/wrap; placeholder model → configure; различимые action/reason.
- Неясный focus → select конкретного типа; integrity failure → inspect/repair, никакое consequential действие не рекламируется как готовое.
- Spec review → `run-current` действительно разрешается в start-testing; без Corpus честно заканчивается после approval с corpus-authoring next action.
- Corpus review → publish/run; ready/improvement → evaluation выбранного Corpus.
- Applied Proposal → verify exact Builder run; несколько кандидатов → выбрать; partial Candidate → inspect/explicit abandon или реально поддерживаемое recovery, без предложения нового run.
- Recorded workshop после restart → reattach с тем же `workshopId`; live grants не возвращаются автоматически.
- Candidate review/release/adoption → нужный оставшийся шаг; rejected terminal Candidate → continue-cycle, не ship.
- Успешный next-cycle → новый stage из receipts; никакого replay уже совершённого adoption.
- Summary, review и traces показывают один recommended action для одинаковых фактов; TUI и HTTP model projection не расходятся.
- Смена branch после ship consent → stale до side effects; unchanged composite → один вопрос, прежние durable receipts.
- Модель не получает sealed identities/content, credential references и host approval capability через guidance.

### Решения, принятые вместо дополнительных вопросов

1. **Состояние — artifacts.** Новый mutable workflow store, session-plan journal и «истина в чате» отвергнуты: удваивают recovery logic.
2. **Resolver внутри Workbench.** Рассмотрены два interface: расширить `workbenchNext(view)` новыми флагами или вычислять route из verified inventory. Выбран второй: view теряет обязательные факты и зависит от выбранного aspect; обратно восстанавливать inventory из view нельзя.
3. **Клиенты читают, host решает.** TUI/HTTP не рассчитывают availability и не исполняют переданный guidance без fresh resolve.
4. **Восстановление ограничено реальными возможностями.** Не добавляем универсальную кнопку resume для Candidate, если ядро умеет только inspect/abandon; для workshop existing reattach используется полностью.
5. **Consent узкий.** Сначала закрывается конкретная смена subject. Общий generic plan runtime и механический перенос всех composites откладываются.
6. **Jobs — следующая отдельная задача.** Единый terminal executor нужен для Codex-подобного ощущения, но не смешивается с domain routing. Root может вести его параллельно после согласования interface.

## Исключено из этого среза

Browser Builder/Studio; новый runner; смена gate statistics; новая event-sourcing архитектура; task scheduler/database; PRD graph; полный redesign feedback/guard identity; first-class production rollback; глобальная миграция всех типов; механическое дробление `eval.ts`, `i18n.ts` или Workbench по размеру.

Ожидаемый результат — меньше мест, где разработчик или модель должны помнить правила цикла. Не обещание «агент стал лучше», а надёжный interface для работы, которая уже умеет создавать, измерять, проверять и принимать изменение.


## Реализация lane B и фактические проверки

После отдельного подтверждения реализации выполнены Candidate 1 и узкий consent-срез Candidate 3. Candidate 2 реализует параллельная lane A; Candidate 4 не выполнялся механически.

Изменения lane B:

- `src/workbench/run-resolution.ts` — единое typed разрешение `run-current` из verified inventory; `decisions/run-current.ts` использует его вместо второго выбора/dispatch. Verified origin apply receipt сохраняется в inventory, resolver не перечитывает sidecar.
- `next-actions.ts`, `types.ts`, `workbench.ts:viewOf` — guidance строится до выбора detail aspect. Interrupted Candidate и integrity failure перестают рекламировать недопустимый run; recorded workshop получает exact reattach. `workbenchGuidanceContext` передан lane A для нативного before-agent-start hook.
- `builder/render/stage.ts` — актуальные views используют host operator code. Старый fallback сохранён только для pre-guidance serialized/hand-built views. Model adapter читает ту же guidance через существующий `workbenchNext`.
- `composite-consent.ts` — typed exact subject matching, revalidation reviewed facts и ограниченная собственная progression. `ship` связывает Candidate, Proposal, version, ветку и HEAD; `start-testing` связывает Spec/Corpus hashes, exact evaluator configuration, опубликованный Corpus и измеряемый Target.
- Внешняя смена subject даёт stale refusal. Собственные durable шаги не откатываются и не считаются новым consent после restart. Неизменный composite сохраняет один вопрос и прежние receipts.
- `workbench.ts` уменьшился с 3519 до 3493 строк; `decisions/run-current.ts` — со 120 до 67. Два новых модуля содержат 74 и 136 строк. Это локальная concentration, не переписывание facade.

Проверено: production и test TypeScript прошли. Focused Workbench suite — 35 passed; composite suite — 17 passed, включая Git branch-switch во время outer Ship gate и изменения точных Spec/Corpus snapshot bytes в dialog; model projection + transition policy + Builder renderer — 156 passed. Отдельно прошёл существующий полный offline HTTP cycle `spec → tests → run → propose → apply → verify → ship` с сопоставлением TUI receipts. При выборе этого одного HTTP теста остальные HTTP тесты намеренно не запускались.

Первая focused попытка выявила только ожидаемое несовпадение projection assertion после добавления `operatorNext`; assertion обновлён, повторная проверка зелёная. Тест с изменением `createdAt` проверяет особенно важный случай: content-derived ID остаётся валиден, но exact snapshot hash уже другой. Семантические изменения самого content по прежнему отсекаются его content identity и теперь также свежим composite revalidation.

Полный интеграционный gate, package verification и итоговый demo принадлежат root/delivery; этот раздел не утверждает их завершения. Код не коммитился.

## Финальная проверка границ и ресурсов

Независимая проверка delivery-lane обнаружила несовпадение выбора сессии: `SessionManager.listAll` сортировал историю по timestamp последнего сообщения, native `--continue` — по filesystem mtime. Delivery исправила выбор и закрепила запуск за точным проверенным файлом через host-owned `--session`. Автоматическое продолжение фильтрует `cwd`; чтение сохранённого разговора само по себе не отправляет prompt провайдеру. Before-agent-start hook заново получает текущие host facts, а не продолжает старое решение из истории.

По дополнительному поручению root исправлены `builder/spend.ts`, `builder/render/receipt.ts` и nullable consumer в `builder/product-shell.ts`: неизвестная стоимость любого member/arm остаётся неизвестной в сумме; недоступные записи и обрезанный bounded scan не дают частичный total. Это относится и к judge-cost, в том числе judge-only receipt. Измеренный ноль сохранён, sealed runs не раскрываются. Добавлен `tests/builder-spend.test.ts`, дополнены receipt и footer tests. Финальный focused batch: 80 passed (`builder-spend`, `builder-plan`, `builder-product-shell`, `builder-regrade`); production/test TypeScript и `git diff --check` прошли.

Граница совместимости: старые полностью измеренные numeric v4 summaries сохраняют прежние вычисления и shape. Старый v4 artifact, в котором отсутствующие Target metrics ранее были сведены к нулю, остаётся читаемым, но новое exact recomputation даёт `null` и отказывает в promotion из-за hash mismatch; для нового promotion требуется повторная проверка. Старые judge/simulated-user receipts всё ещё обозначают отсутствие declared rates числом `0` (`provenance.ts:JudgeMetricsSchema`). Эти historical zero нельзя задним числом отличить от измеренного нуля без отдельного признака completeness; durable schema в этом срезе не менялась.
