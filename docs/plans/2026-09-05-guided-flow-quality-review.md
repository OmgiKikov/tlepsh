# Строгий review качества реализации terminal guided flow

Дата: 2026-09-05. База: `78690e5`, ветка `codex/product-wow`, текущие tracked и untracked WIP. Применён полностью прочитанный [thermo-nuclear-code-quality-review/SKILL.md](/Users/kikov/.agents/skills/thermo-nuclear-code-quality-review/SKILL.md). Пользователь делегировал обычные решения: ниже выбран сильный default без дополнительных вопросов.

Это статический review и план. Код продукта не изменён, новые тесты и платные модельные вызовы не запускались. Предыдущие проверки не выдаются за проверки будущей реализации. Дефекты, выведенные из кода, отделены от гонок, которые ещё нужно воспроизвести.

## Решение

**Текущий WIP не готов к приёмке.** Движок уже содержит ценные границы: проверяемые артефакты, независимый sealed exam, reviewed apply, повторяемые application decisions, ограниченный workshop. Основной structural blocker для обещанного Codex-подобного продукта — несколько владельцев одного сценария в Builder. Нельзя исправлять это ещё одним orchestration layer поверх `commands.ts`, адаптера и Workbench.

Сильный default: удалить отвергнутый Studio, объединить выполнение операций в одном узком Builder host module; дать модели и TUI одну проекцию доступного следующего действия; сохранить точную, ограниченную авторизацию composite; закончить только полезный read-only Evidence. Не вводить новую workflow framework, DI-контейнер, agent state store или браузерный Builder.

## 1. P1 — естественная речь и команды имеют разных владельцев выполнения

**Подтверждено кодом.** [extension.ts:277](/Users/kikov/Desktop/harness/src/builder/extension.ts:277) создаёт модельные tools без jobs, а [commands.ts:641](/Users/kikov/Desktop/harness/src/builder/commands.ts:641) создаёт собственный `BuilderJobs`. Командный `runObserved` проверяет занятость, связывает отмену, запускает job, собирает progress и показывает результат ([commands.ts:878](/Users/kikov/Desktop/harness/src/builder/commands.ts:878)). Модельный `ahde_workbench_decide` вызывает `workbench.decide` напрямую ([workbench-adapter.ts:657](/Users/kikov/Desktop/harness/src/builder/workbench-adapter.ts:657)). `/jobs`, `/plan`, `/stop` видят только командный объект jobs ([commands.ts:1864](/Users/kikov/Desktop/harness/src/builder/commands.ts:1864)). Это не означает, что natural tool вообще нельзя прервать: ему уже передаётся `signal`. Но единая операция, видимая из обоих входов, отсутствует.

Ещё один симптом: адаптер вручную перечисляет операции с progress ([workbench-adapter.ts:618](/Users/kikov/Desktop/harness/src/builder/workbench-adapter.ts:618)), забывая явно доступный `start-testing` и `regrade`. Команды и адаптер независимо строят completion presentation, включая passport и agent log. Добавление естественного «остановись», «переделай» или «продолжай» в каждый из этих путей умножит расхождения.

**Code judo:** сделать один хозяин выполнения в Builder extension и передать его командам и tools. Он владеет single-flight, cancellation, observation, авторизационными событиями и однократной публикацией результата. Workbench продолжает владеть решениями и доказательствами. Команды разбирают сокращения, tools принимают typed inputs; обе поверхности запускают одинаковую операцию. Вынести общий substantive result presenter, удалив дублированный ship/passport/log branch.

Не скрывать разницу протоколов: command может вернуть управление после backgrounding, tool должен вернуть правдивый результат/статус принятой операции. Общая семантика и владелец важнее одинаковой сигнатуры. Не передавать `ExtensionCommandContext` везде через cast и не превращать небольшое различие в набор host-mode флагов.

**Проверить:** natural run отражается в `/jobs`; `/stop` останавливает его; одновременно пришедший slash/natural run не запускает второй engine operation; одинаковые типы решений получают одинаковые progress и завершение; результат и model continuation появляются ровно один раз. Отдельно проверить natural tool foreground cancellation: сигнал последующего пользовательского сообщения не должен случайно отменять уже осознанно оставленную фоновую работу.

## 2. P1 — lifecycle jobs смешивает ожидание разрешения, выполнение и доставку сообщения

**Подтверждено кодом:** `AUTHORIZATION_GRACE_MS` через две секунды вызывает `goBackground(null)` и печатает started, даже если gate ещё не ответил ([jobs.ts:43](/Users/kikov/Desktop/harness/src/builder/jobs.ts:43), [jobs.ts:274](/Users/kikov/Desktop/harness/src/builder/jobs.ts:274), [jobs.ts:293](/Users/kikov/Desktop/harness/src/builder/jobs.ts:293)). Это **не обход разрешения Workbench**: его gate остаётся ждать. Но возвращается command handler, и снимается связка его abort с job ([commands.ts:940](/Users/kikov/Desktop/harness/src/builder/commands.ts:940)). Поэтому состояние, которое видит оператор, уже неправдиво; конкретное поведение Esc при ещё открытом диалоге необходимо проверить в TUI.

`settle` ждёт `host.waitForIdle()` до `finish(job)` ([jobs.ts:310](/Users/kikov/Desktop/harness/src/builder/jobs.ts:310), [jobs.ts:364](/Users/kikov/Desktop/harness/src/builder/jobs.ts:364)). Статически доказано, что busy остаётся выставленным после завершения engine execution; риск лишнего busy-refusal или задержки при новом ходе требует сценарного теста. `dispose` забывает job, не abort-ит controller ([jobs.ts:370](/Users/kikov/Desktop/harness/src/builder/jobs.ts:370)); production caller для dispose отсутствует, а shutdown extension только suspends workshop ([extension.ts:288](/Users/kikov/Desktop/harness/src/builder/extension.ts:288)).

Ещё хуже смысловая неточность: stopped-note сообщает `Nothing was decided` ([jobs.ts:359](/Users/kikov/Desktop/harness/src/builder/jobs.ts:359)). У `startTesting` approve/configure/publish последовательно сохраняются **до** запуска eval ([workbench.ts:1535](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1535)); отмена eval не отменяет предыдущие шаги. Уже существующий `decideApplyProposal` правильно возвращает verification blocker после durable apply ([proposal.ts:52](/Users/kikov/Desktop/harness/src/workbench/decisions/proposal.ts:52)); эту семантику нужно распространить, а не стереть catch-all сообщением.

**Code judo:** убрать timer, который угадывает разрешение; background разрешать по явному событию разрешённого выполнения. Отделить окончание engine operation от очереди доставки сообщения: освободить single-flight до ожидания idle, но не разрешать старому callback очистить новую operation. Остановка означает «запрошена отмена», затем даёт actual refreshed state с тем, что осталось сохранено. В shutdown отменять принадлежащую сессии работу и подавлять поздние callbacks. Использовать небольшой discriminated lifecycle/identity guard там, где он действительно удаляет комбинации `background/stopping/running`; не вводить persistent job scheduler.

**Проверить:** неотвеченный consequential dialog дольше двух секунд; decline; stop до первого run event; stop после публикации корпуса; completion пока модель занята; новая operation до доставки старого completion; shutdown с активным job; late completion после shutdown; отсутствие unhandled rejection и двойных notes.

## 3. P1 — «что дальше», legal tools и реальный run-current расходятся

`next-actions.ts` прямо описывает свой resolver как mirror другой ветки ([next-actions.ts:66](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:66)). Его `NextView` не содержит interrupted-candidate/focus/blocker facts ([next-actions.ts:120](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:120)); legal `run-current` определяется стадией ([next-actions.ts:144](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:144)). Реальный `run-current` сначала отказывает при частичном candidate ([run-current.ts:56](/Users/kikov/Desktop/harness/src/workbench/decisions/run-current.ts:56)). TUI special case узнаёт interruption только при открытом `review` aspect ([stage.ts:69](/Users/kikov/Desktop/harness/src/builder/render/stage.ts:69)). Одинаковое состояние проекта может обещать разные следующие шаги в зависимости от просмотренного экрана.

Слой инструкции тоже расходится: `DECIDE_WHEN` говорит модели, что оператор должен ответить `/label`, и описывает improve как остановку на первом verified candidate ([next-actions.ts:78](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:78), [next-actions.ts:90](/Users/kikov/Desktop/harness/src/workbench/next-actions.ts:90)). Это старое знание в новом канале рекомендаций.

**Code judo:** один pure resolver из достаточных inventory facts возвращает либо конкретный допустимый run request, либо typed blocker с recovery. Execution и `WorkbenchView` используют его результат. Модель и TUI читают одну guidance-проекцию; `detail.aspect` меняет глубину чтения, не разрешённые действия. Удалить зеркальный resolver и локальные interruption special cases. Стадии можно оставить внутренним доменным языком; пользователь читает конкретное продолжение намерения, без обязательных глав Spec/bench.

Не превращать все доменные решения в универсальный state machine. Не объединять availability и authority: видимый next action не является разрешением на exact apply/release или новый spend.

**Проверить:** таблица реальных inventory fixtures: свежий проект, готовый baseline, partially built candidate, verified development candidate, missing sealed gate, stale evidence, promoted but not adopted, completed cycle. Во всех aspect views next resolution одинаков; предлагаемая routine operation выполняется либо возвращает именно заявленный blocker. Restart выводит continuation из receipts, не из памяти разговора.

## 4. P1 — «один вопрос» нуждается в точном типизированном плане

Это зона совместной проверки с eng/architecture, не предложение ослабить gate. `compositeGate` принимает `Map<kind, (subject: unknown) => boolean>` и вручную cast-ит subject ([workbench.ts:1344](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1344)). В `startTesting` matcher approve/publish проверяет ID, хотя верхний dialog хранит snapshot hashes ([workbench.ts:1393](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1393), [workbench.ts:1455](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1455), [workbench.ts:1520](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1520)). `ship` использует candidate ID и version/recommendation ([workbench.ts:1686](/Users/kikov/Desktop/harness/src/workbench/workbench.ts:1686)).

**Статический риск:** fine-grained decision проверяет свежесть собственного before/after, но его before может быть построен уже после composite approval. Совпадения ID недостаточно для доказательства, что это ровно ранее прочитанное содержание. Конкретные mutation windows и воспроизводимость должен подтвердить targeted stale test; утверждать успешный exploit без него нельзя.

**Code judo:** bounded typed composite plan с точными subject identities/hashes, теми же constructors, которыми пользуются steps. Удалить weak subject matchers. Revalidate перед первым durable effect и на зависимых границах. План не получает общую власть, workshop permissions остаются отдельной авторизацией. Restart не восстанавливает прошлое подтверждение как grant. Сохранить один вопрос на неизменившийся план и существующие receipts/recovery; не эмулировать невозможную транзакцию rollback над Git, артефактами и внешним model spend.

**Проверить:** подмена содержимого spec/corpus под тем же ID между вопросом и ответом, revision/manifest change, изменение кандидата/выбранной ветки; неизменный план не спрашивает повторно; изменившийся не получает старый grant; resume не дублирует approve/publish/adopt.

## 5. P1 — удалить отвергнутую архитектурную ветку Studio, закончить Evidence без второй семантики

**Удалить из WIP:** `src/studio/session.ts`, `src/studio/worker.ts`, `src/builder/interactive-host.ts` и связанные изменения guards/onboarding в commands, adapter, workshop-tools, product-shell. Studio не соответствует принятому продукту. WeakSet trusted RPC hosts создаёт новую authority ветку; `setImmediate(() => void runOnboarding(...))` создаёт новую lifecycle ветку исключительно для неё ([product-shell.ts:460](/Users/kikov/Desktop/harness/src/builder/product-shell.ts:460)). В Studio добавлен собственный process/RPC reducer с `Record<string, any>`, timers, dialogs и session states. Это не reusable foundation, которое нужно сохранять «на будущее».

README уже обещает `ahde studio` ([README.md:8](/Users/kikov/Desktop/harness/README.md:8)), CLI его не реализует. Удалить эти обещания из README/ROADMAP. Сохранить реально существующие localhost Evidence и внешнюю `serve` API.

**Evidence WIP не готов.** Model импортирует ещё не объявленные page types `CompareCasePreview`/`CompareRunPreview` и отдаёт ещё не объявленный `examples`; pages вызывает `flipSubject` после удаления его import ([model.ts:42](/Users/kikov/Desktop/harness/src/evidence/model.ts:42), [model.ts:559](/Users/kikov/Desktop/harness/src/evidence/model.ts:559), [pages.ts:547](/Users/kikov/Desktop/harness/src/evidence/pages.ts:547)). Root сообщил семь TS errors на предыдущей проверке; здесь typecheck повторно не запускался.

Сохранить полезное направление: bounded baseline/candidate example из hash-verified **development** traces, видимый выбор matching repetition, regressions-first order, различие executed/reported tools, honest missing data, read-only compare. Дописать renderer/types и focused tests либо удалить незавершённую feature целиком до приёмки. Не считать один input/final answer полным многоходовым диалогом и не называть это verified world diff: preview сейчас показывает записанные checks, не полное before/after world.

**Code judo:** HTML `renderWhy` повторно собирает английское объяснение и теряет часть canonical logic ([pages.ts:533](/Users/kikov/Desktop/harness/src/evidence/pages.ts:533)). Удалить это сочинение; рендерить готовые `RunExplanation.sentences`, которые уже покрывают error, abstention, jury и локализацию ([run-explanation.ts:1150](/Users/kikov/Desktop/harness/src/application/run-explanation.ts:1150)). Новый `evidence/copy.ts` вводит второй переводчик с собственной regex interpolation; объединить его сообщения с существующим `t`/`tokenLabel`, без нового localization runtime. Не переносить доменные verdict правила в HTML.

**Проверить:** неизменные canonical explanation facts в TUI/HTML; RU/EN; unknown costs/tokens; отсутствующий или tampered trace; все previews bounded; нет sealed cases/traces в HTML, API и ссылках; escaping записанного текста; адаптивность 390/1280 px и light/dark. CSS snapshot не заменяет эти проверки.

## 6. Размер файлов: не добавлять guided flow внутрь нынешних монолитов

Подсчёт tracked `src` и `tests` дал **39 файлов от 1000 строк**. В текущем diff ни один файл не перешёл порог снизу: это существующий долг, а не повод отвергнуть все изменения сразу. Крупные структуры в области работы:

| Файл | HEAD → WIP, строк | Решение сейчас |
| --- | ---: | --- |
| `src/workbench/workbench.ts` | 3519 → 3519 | Новый resolver/guidance/composite plan вне класса; не добавлять ещё одну крупную orchestration ветку |
| `src/builder/commands.ts` | 1962 → 1963 | Shared execution/presentation должны уменьшить файл, а не добавить ещё handlers/helper clusters |
| `src/workbench/inventory.ts` | 1720 → 1720 | Inventory остаётся источником фактов; guidance — отдельная чистая проекция |
| `src/workbench/types.ts` | 1533 → 1533 | Новый контракт узкий; не копировать весь Workbench в новые интерфейсы |
| `src/builder/render/view.ts` | 1282 → 1282 | Только представление canonical guidance, без собственной recovery policy |
| `src/i18n.ts` | 3728 → 3728 | Если понадобится bundle extraction, сохранить один переводчик и единый contract |
| `src/evidence/pages.ts` | 721 → 749 | Compare renderer отделить по настоящей странице/компоненту до дальнейшего разрастания |

`DecisionHost = AhdeWorkbench` ([shared.ts:6](/Users/kikov/Desktop/harness/src/workbench/decisions/shared.ts:6)) показывает предел старого механического разбиения: вынесенные handlers всё ещё видят весь класс и импортируют runtime helpers обратно из него. Не повторять такую extraction для новых seams. Но полное развязывание всего Workbench сейчас расширит задачу без пользы для первого законченного сценария; достаточно узких входов/выходов новых модулей и удаления дублей.

## Что сохранять из WIP

| Изменение | Решение |
| --- | --- |
| Nullable resource totals, `runTotalCost`, `money(null) → —`, неизвестная цена не доказывает Pareto dominance | Сохранить. Это существенная честность продукта. Довести consumers и совместимость numeric historical artifacts; не плодить ещё новые сумматоры в страницах |
| Полный scenario в regression guard вместо ручного списка полей и cast | Сохранить: удаляет возможность тихо потерять world/simulatedUser при следующем расширении schema |
| Watch outage становится unusable evidence, не healthy/no drift | Сохранить с существующим targeted outage test |
| Именованные templates из установленного пакета | Сохранить: маленький substantive resolver, прежние относительные пути сохраняются |
| Linux CI, required Docker integration, `.gitmodules` и vendor instructions | Сохранить, но не заявлять зелёный Linux acceptance до реального CI результата |
| Evidence nullable accounting | Сохранить даже если preview откладывается |
| Evidence незавершённый preview/CSS/localization | Закончить после core flow, без второй семантики; иначе убрать незавершённую часть |
| Studio transport/host authority, его guards и docs | Удалить |

## Порядок реализации и критерий готовности

1. Удалить Studio и ложные docs; восстановить собираемость Evidence. Это ограниченная уборка WIP, не редизайн продукта.
2. Параллельно: один Builder execution lifecycle; canonical run-current/guidance; exact composite subjects. Пересечение только в явно согласованных extension/Workbench interfaces.
3. Привязать естественный разговор к этим же operations. Убрать требования знать `/label` и внутренние этапы; не добавлять жёсткий regex intent router, который будет вторым planner рядом с Builder model.
4. Довести короткий понятный результат и optional Evidence. Готовый итог должен различать measurable improvement, no proven regression, inconclusive, unusable evidence и unknown spend.
5. Выполнить focused invariant tests выше, затем общие type/build/check/package checks один раз после интеграции. Добавлять проверки поведения, а не тесты, зеркалящие dispatcher или CSS.
6. Показать фактический сценарий в установленном пакете: пустая папка или реальный Python target → обычным текстом цель → рабочий agent → тест → полезный failure → оператор перебивает и меняет направление → исправление соответствует новому намерению → проверка → exact accept → restart на следующий день с сохранённым результатом и ясным продолжением. Локальный trace открывается по желанию. В сценарии должна быть как минимум одна настоящая отмена и одна честно показанная неопределённость.

Для top management доказательство готовности — этот непрерывный сценарий с записанными артефактами, расходом и ограничениями. Зеленые unit tests и красивый HTML необходимы для своих задач, но сами по себе это обещание не подтверждают.

## Реализация lane A и фактическая проверка — 2026-09-05

Разделы выше сохраняют исходный аудит до реализации; их старые ссылки и утверждения о незавершённом WIP не описывают окончательное состояние. Ниже — только изменения и проверки моей lane. Остальные lane принимаются интеграционной проверкой root.

**Сделано:** естественный `ahde_workbench_decide` и терминальные shortcuts используют один `BuilderJobs` с общей `executeBuilderDecision`. Удалены отдельная модельная ветка исполнения, дублирующие progress/result handlers и таймер, называвший неотвеченный gate фоновой работой. Все мутации блокируются при активной операции; чтение состояния, `/jobs` и остановка доступны. Вопрос об авторизации продолжает принадлежать действительному host UI и Workbench; новый слой не выдаёт разрешения самостоятельно.

Жизненный цикл явно различает ожидание авторизации, выполнение и остановку. Сигнал текущего хода привязан к foreground operation; уже авторизованная фоновая работа переживает последующие ходы. Окончание исполнения освобождает busy до ожидания свободной модели; identity guard не позволяет старому completion стереть новую операцию. Shutdown отменяет принадлежащую сессии работу и подавляет поздние presentation/model callbacks. Отмена и ошибка сообщают о сохранённых частичных изменениях без обещания rollback. Сбой необязательной панели или callback не превращает успешное сохранение в неудачный domain result.

`ahde_host_action` предоставляет закрытое множество действий: состояние/остановка работы, паспорт, development dataset, слепая human label-сессия, приватный импорт экзамена. У tool нет произвольной slash-команды, shell, пути приватного экзамена или флага одобрения. Приватные путь и название вводятся только в host dialogs с сигналом отмены; наружу выходит безопасный итог. Ошибка обновления экрана после durable import не сообщает, что импорт не состоялся. Shortcuts используют те же реализации.

В `before_agent_start` подключён свежий `workbenchGuidanceContext` от architecture lane. Snapshot дополняет временный native `systemPrompt`, не накапливается отдельными сообщениями в истории. Дополнительно передаются текущая операция и правило следовать последнему уточнению пользователя. Model projection исключает дублирующее поле `guidance`, сохраняя canonical `next`. Persona больше не отрицает существующий authoring/validation split и не требует знания `/label`.

**Границы файлов:** изменены `src/builder/jobs.ts`, `commands.ts`, `workbench-adapter.ts`, `extension.ts`, `builders/ahde/AGENTS.md` и связанные ключи `src/i18n.ts`. Добавлены узкие модули `execution.ts` (78 строк), `decision-presentation.ts` (140), `host-actions.ts` (249). `commands.ts` уменьшился с 1962 до 1582 строк, adapter — с 731 до 658; новых production-модулей от 1000 строк нет. Существующий большой command registry остаётся явным долгом, без механического распиливания на handlers с полной властью Workbench.

**Проверено:** source typecheck и test typecheck прошли. Расширенный focused прогон завершился **152/152 PASS** в девяти suites: `builder-jobs`, `builder-commands`, `builder-pi-extension`, `builder-conversation-lifecycle`, `workbench-adapter-progress`, `builder-label`, `workbench-adapter-model-selection`, `workbench-adapter-projection`, `builder-dialog`. Новый lifecycle suite вызывает реальные зарегистрированные extension handlers: ephemeral pre-turn context, natural job → `/jobs`, отказ параллельной мутации, stop, `agent_settled` completion и shutdown. Отдельные regression cases покрывают неотвеченный gate, отмену приватного ввода, отсутствие утечки приватных значений/ошибок и сохранение успешного результата при сбое панели/refresh. Финальные дополнительные regression cases вошли в 152 теста; общую интеграционную typecheck/build/test проверку выполняет root.

**Что эти проверки не доказывают:** lifecycle test использует контролируемый Workbench decision для проверки границ исполнения и не является новым сквозным платным model benchmark. Качество выбора действий моделью, экономический эффект, надёжность провайдера и субъективная плавность реального интерактивного TUI требуют отдельной живой приёмки. Background jobs принадлежат текущему процессу; перезапуск восстанавливает сохранённое состояние через существующие artifacts и guidance, не оживляет завершённый процесс и не переносит старую авторизацию. Persona/tool contracts позволяют естественный разговор, но не гарантируют, что любая модель всегда выберет лучший следующий шаг.

### Интеграционное продолжение после первого полного check

Первый полный check выявил старые ожидания tool registry и synchronous completion в интеграционных fixtures. Точные списки обновлены новым `ahde_host_action`; утверждение `executionMode === "sequential"` сохранено для каждого зарегистрированного tool. Pi mock matchers используют длину полного registry, а тесты по-прежнему проверяют его точный состав. Тест author freeze теперь ждёт настоящий completion note и дополнительно проверяет отсутствие запроса автору до подтверждения; выбранная до диалога модель остаётся той, которой отправляется запрос.

Обнаружена и исправлена общая недостающая проверка host capability: `createAhdeBuilderExtension` разрешает background только при наличии `pi.sendMessage`. Host без канала завершения получает полный typed result в текущем вызове; ему не возвращается незавершаемый для него `active-job`. Это не timeout/exception fallback и не test-only настройка. Реальный native host продолжает использовать background и `agent_settled`. Новый lifecycle case проверяет задержанное исполнение без канала: до конца работы вызов остаётся pending, затем получает полный durable result без ожидания собственного model turn. Native lifecycle case сохранён.

После исправления **63/63 теста прошли в пяти suites**: `builder-pi-closed-loop` (1), `builder-pi-workshop-loop` (2), `improvement-author` (15), `workshop` (41), `builder-conversation-lifecycle` (4). Оба TypeScript checks повторно прошли. Workshop tests по-прежнему используют production extension и проверяют реальные panels, порядок host dialogs, исполненный diff и sealed evidence boundary. Дополнительные четыре fixture/persona файла переданы delivery; их отдельный focused прогон завершился 27/27 PASS, проверки authority расширены на все шесть host actions в print/RPC. Финальный полный check выполняет root после заморозки исходников.
