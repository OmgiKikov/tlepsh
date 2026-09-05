# Engineering review: guided terminal flow AHDE

Дата: 2026-09-05. База: HEAD `78690e5` плюс незавершённое рабочее дерево. Автор: engineering planner, параллельный `gstack-plan-eng-review`.

**Решение: завершить существующий терминальный продукт через три небольших архитектурных шва — общий исполнитель действий, актуальная проекция следующего шага, типизированные вызовы функций хоста. Не создавать второй workflow engine или Studio.**

Это план реализации, а не утверждение о готовности текущей сборки. Код и проверки в рамках этого review не менялись/не запускались. Полностью прочитан `/Users/kikov/.codex/skills/gstack-plan-eng-review/SKILL.md`; substantive architecture, quality, tests и performance review выполнены. Обычные решения приняты автоматически по явному делегированию пользователя. Setup, telemetry, routing, дополнительные агенты, публикация и вспомогательные файлы skill пропущены по ограничениям задачи; единственная запись — этот отчёт.

**Финальное ограничение scope от root (имеет приоритет над расширенным inventory ниже):** реализовать основной guided loop и bounded host actions **jobs/status/stop/passport/dataset/judge-label/sealed-import**, сохранив read aliases через existing view. Full CLI parity, watch/serve bridge и переписывание native-login lifecycle — backlog, не blockers. Итоговый объединённый план — `docs/plans/2026-09-05-guided-flow-implementation.md`. Проверки текущего этапа не требуют новых watch/serve host routes и не дают оснований объявлять полную CLI parity.

## Step 0: scope challenge и существующие механизмы

Пользователь хочет один разговор: описать цель, создать или подключить агента, проверить, понять ошибку, подготовить изменение, проверить его, принять или продолжить. Можно менять направление, остановить работу и вернуться после restart. Нужны все существующие возможности, а не только красивый happy path. Slash-команды остаются совместимым экспертным интерфейсом.

План затрагивает больше восьми файлов из-за уже существующих раздельных адаптеров и локализации. Scope smell рассмотрен: уменьшать число функций вопреки запросу не следует; сокращаем **новые механизмы**, а не пользовательскую полноту. Рекомендация — не более двух новых production modules: `src/builder/execution.ts` и `src/builder/host-actions.ts`. Guidance расширяет существующие `next-actions.ts`, `render/plan.ts`, `product-shell.ts`. Конкретное размещение разделяемой функции может измениться при интеграции, но новый слой состояния этапов не нужен.

| Что уже есть | Где | Как использовать |
|---|---|---|
| Canonical legal actions, stages и gate classes | `src/workbench/next-actions.ts`, `transition-policy.ts` | Единственный источник допустимых переходов; не переносить stage switch в persona или новый orchestrator. |
| `run-current`, `start-testing`, `ship`, apply+verify | `src/workbench/workbench.ts:3459`, `decisions/run-current.ts`, `decisions/proposal.ts` | Одно намерение, существующие точные подтверждения и receipts; не склеивать отдельные команды текстом. |
| Scoped authority, schema validation, subject hashes и stale checks | `workbench.ts:1111`, `workbench-transport.ts`, `workbench-gate.ts` | Handoff никогда не превращается в model-supplied approval. |
| Workshop descriptor и повторное подключение | `workbench.ts:1996`, `:2108`, `next-actions.ts:192` | Продолжать точный worktree; восстановление не возвращает runtime grants. |
| Durable candidate/adoption/continuation и unfinished improve loops | `cycle-continuation.ts`, `decisions/improve.ts:26` | На restart читать существующие артефакты; не делать новый checkpoint database. |
| Private Pi conversations и continue/resume | `builder/runtime.ts:319`, vendor `session-manager.ts:1558` | Сохранять разговор штатным SessionManager; свежие artifacts важнее старого текста. |
| Jobs, AbortController, observations и completion notes | `builder/jobs.ts`, `commands.ts:879` | Извлечь общую интеграцию, не изобретать очередь или event bus. |
| План и header из одного view | `builder/render/plan.ts`, `product-shell.ts:300` | Сохранить bounded rendering и coalescing, добавить понятное состояние ожидания/работы. |
| Native pre-turn hook | vendor `docs/extensions.md:530`, `extensions/types.ts:717` | `before_agent_start` поддерживает per-turn system prompt: готовый механизм актуального контекста. |
| Реальные Pi/Git/sandbox E2E с бесплатным model fixture | `tests/builder-pi-*.test.ts`, `workbench-composites.test.ts` | Расширить реальными ветками исполнения вместо переписывания тестовой системы. |

Корневого `TODOS.md` при осмотре нет. Предыдущие решения и ограничения сверены с `docs/reviews/2026-09-05-comprehensive-product-audit.md`, `2026-09-05-research-backed-product-verdict.md` и live acceptance. Их прежние зелёные прогоны не засчитаны для текущего dirty tree.

**Layer 1 / unfamiliar-pattern check:** новый runtime и новая зависимость не предлагаются. Доступность native Pi hook и `SessionManager.continueRecent` проверена в pinned vendor source, а не предположена по текущей интернет-документации другой версии. Важный footgun: injected `message` из `before_agent_start` сохраняется в session; компактное изменяемое состояние лучше добавлять в per-turn `systemPrompt`, чтобы оно не разрасталось и не воспринималось как старое разрешение. Не читать полный inventory на каждый token или SSE event.

## 1. Architecture review: конкретные находки

### F1 — Два пути исполнения дают разное управление одной работой. P1, confidence 10/10

`src/builder/commands.ts:894`:

```ts
await jobs.start({
```

`src/builder/workbench-adapter.ts:657`:

```ts
const result = await workbench.decide(params, reporting, { signal, ... });
```

Второй фрагмент сокращён только в аргументах; оба вызова проверены в исходнике. `jobs` создаётся внутри `registerAhdeBuilderCommands` (`commands.ts:641`) и не передаётся tools (`extension.ts:277`). `/stop` обращается к этому command-local экземпляру. Модельный `run-current` имеет live progress, но минует background handoff, busy policy и command jobs. Пользователь получает разные возможности продолжать разговор в зависимости от того, написал ли он slash-команду.

**Выбор A:** один session-scoped execution coordinator, внедряемый в commands и tools. **Отклонён B:** копирование jobs logic в adapter — сохраняет два active jobs и допускает гонки. **Отклонён C:** заставить модель печатать `/test` — нарушает цель и authority boundary.

Контракт coordinator: короткая операция возвращает `completed` с реальным `WorkbenchDecisionResult`; длинная — `running` с настоящим job id, видом работы и fresh view. После завершения публикуется ровно один результат и один continuation note. Нельзя подделывать completed result, пока работа идёт. Commands могут игнорировать возврат, tools должны различать оба варианта. `view`, безопасное обсуждение и остановка доступны во время работы; вторая конфликтующая mutation от обоих входов получает одну понятную причину отказа.

### F2 — Host-only функции недоступны через свободное намерение. P1, confidence 10/10

`src/builder/workbench-transport.ts:434`:

```ts
export type WorkbenchDecisionToolInput = WorkbenchDecisionInput | z.output<typeof TalkToAgentInputSchema>;
```

`src/workbench/next-actions.ts:79`:

```ts
label: "not a call — something to SAY: ..."
// следующая строка: "and the operator answers with /label"
```

`label`, импорт личного экзамена, паспорт и recorded dataset export реализованы в command closures (`commands.ts:1387`, `:1670`, `:1784`, `:1901`). Domain workflows уже callable; названные хостовые действия — нет.

**Выбор A:** узкий discriminated host-action union по аналогии с уже существующим `talk-to-agent`, вызывающий те же application functions и native dialogs. **Отклонён B:** универсальный `{command:string}`/shell/argv bridge: не даёт проверяемой capability boundary. **Отклонён C:** оставить подсказки про slash в happy path: не выполняет запрос.

Не передавать `ExtensionCommandContext` целиком в новый модуль: tools не должны вызывать command-only `waitForIdle()` изнутри текущего agent turn — это может ждать само себя. Передавать узкие host callbacks, gate, presenter и signal. Host-only ответы labels, credential values и sealed paths/contents не должны попасть в модельный контекст.

### F3 — Fresh guidance существует, но получение свежего состояния оставлено модели. P2, confidence 9/10

`src/builder/commands.ts:810`:

```ts
"Call ahde_workbench_view before relying on any earlier state."
```

`src/builder/product-shell.ts:308`:

```ts
state.view = await workbench.view();
state.plan = compilePlan(state.view);
```

Header обновляется, tool results содержат `next`, но `before_agent_start`/`context` hooks в Builder отсутствуют при проверке исходников. После slash action, restart или background completion старая история всё ещё может направлять модель, пока она сама не исполнит инструкцию перечитать view.

**Выбор A:** перед каждой новой репликой компактный host-derived snapshot: текущий цельный subject, stage в человеческих словах, blockers, legal next, recorded workshop/unfinished loop, active job. Содержание берет существующий WorkbenchNext; detailed evidence читает обычный view. **Отклонён B:** persist текущую фазу второго orchestrator — рассинхронизация с receipts. **Отклонён C:** только усилить persona — не решает отсутствие фактов.

Не сохранять grants в guidance; не добавлять sealed data, imports content, credentials или весь Target source. Ошибка чтения = явный unavailable snapshot и отказ consequential action до штатного повторного чтения, а не выдуманный начальный stage.

### F4 — `asks` обещает больше определённости, чем допускает cost guard. P2, confidence 10/10

`src/workbench/next-actions.ts:163` вычисляет `asks` из gate class; routine даёт `false`. `src/workbench/workbench.ts:1131`:

```ts
if (policy === "routine" && presentation.estimate) {
  const guard = routineCostGuard(presentation.estimate, process.env, presentation.authorized);
  if (guard) { policy = "one-question"; ... }
}
```

Следовательно `asks:false` не гарантирует отсутствие UI-вопроса при неизвестной/высокой стоимости. Это метаданные, не обход gate, но именно такие несоответствия рождают лишнее conversational согласие.

**Выбор:** дополнить guidance честным `confirmation: required | conditional-cost | none`, полученным из существующей policy; сохранить старое поле совместимым, перестать интерпретировать его как гарантию. Полный subject/estimate по-прежнему строится только при исполнении. Авторитет — реальный gate, не preview. Прямое намерение пользователя ведёт сразу к подготовленному host dialog; модель не спрашивает «можно ли показать вопрос».

### F5 — Остановка и dispose не должны обещать откат. P1, confidence 10/10 для наблюдаемого кода

`src/builder/jobs.ts:359`:

```ts
`The operator stopped the background ${input.command}. Nothing was decided.`
```

`jobs.ts:371`:

```ts
dispose() {
  if (running) {
    if (running.ticker) stopTimer(running.ticker);
    running = null;
  }
```

`dispose` не abort-ит controller; stopped message не читает receipts. Это не доказательство уже выполненного нежелательного внешнего действия: это проверенный gap в lifecycle и слишком сильная формулировка. Composite может успеть сохранить Spec, корпус или candidate до прерывания следующей части.

**Выбор:** coordinator.shutdown отменяет текущую работу, ограниченно дожидается settlement и оставляет существующие recovery artifacts. Stopped result сообщает «остановлено; вот что успело сохраниться и что осталось», получая состояние из Workbench. Crash resume не перезапускает расходы и не принимает решения автоматически. `jobs.ts:292` также отделить `awaiting-human` от `running`: двухсекундный grace может вернуть foreground до ответа dialog, но не означает, что оператор уже разрешил выполнение.

### F6 — Bare startup не продолжает разговор, хотя private persistence готова. P2, confidence 10/10

`src/builder/runtime.ts:319`:

```ts
let sessionMode = options.sessionMode ?? "new";
```

И `cli.ts:295` default — `"new"`. Есть штатные `ahde continue`, `ahde resume`; возврат из Runtime Pi уже использует continue (`runtime.ts:353`). Для возврата после restart пользователь сейчас должен знать режим.

**Выбор:** bare `ahde` автоматически продолжает последнюю private session **этого проекта**, если она есть; пустая директория создаёт новую. Явные new/continue/resume остаются; начать другой разговор можно через native session action обычным намерением. При возврате одна компактная строка о возобновлении и свежий snapshot из F3. Resume никогда не восстанавливает согласие/ongoing spend. Не переносить session между проектами. Для unreadable session показать причину и предложить native выбор новой/другой, не стирать историю молча.

### F7 — Неизвестная цена всё ещё превращается в ноль в оценке бюджета. P1, confidence 10/10

`src/workbench/transition-policy.ts:325`:

```ts
costUsd += (runCost(run) ?? 0)
  + (run.metrics.judge?.costUsd ?? 0)
  + (run.metrics.simulatedUser?.costUsd ?? 0);
```

Исходник inspected dirty tree. Нулевой слагаемый допустим для роли, которая не вызывалась, но не для реально вызванной роли без usage. Сводные pending trust fixes должны включить этот estimator; иначе общие показатели станут честнее, а human budget guard останется оптимистичным.

**Выбор:** missing usage при выполненной роли даёт unknown total и сохраняет известную часть/coverage; неприменимая роль даёт 0. Никогда не показывать invented precision. Regression tests: target unknown; judge unknown; simulated user unknown; unused optional role; genuinely zero-priced known call. Политика дополнительных подтверждений для unknown уже есть; её не обходить ради гладкости.

### F8 — Persona и demo способны скрыть незавершённость продукта. P2, confidence 10/10

`builders/ahde/AGENTS.md:142`:

```text
do not promise a dollar cap or independent validation.
```

В adapter описание `improve` уже обещает deterministic authoring/validation split (`workbench-adapter.ts:552`), а `decisions/improve.ts:49` действительно вызывает `planImprovementExperiment`. Требуется согласовать формулировку с реальным контрактом: validation unseen для автора, малый sample не доказывает generalization; spend ceiling ограничена именно раскрытым author budget, не всей вселенной расходов.

`tests/builder-pi-natural-language.test.ts:153` устанавливает `on: () => undefined`, а модель выбирает tools через scripted `switch` по `toolResults.length`. Тест важен, но не включает lifecycle hooks product shell и не оценивает способность настоящей модели понять неизвестную формулировку. `scripts/demo.mjs` напрямую вызывает application functions: бесплатный demo доказывает цепочку исполнения, не весь терминальный UX. Это должно быть прямо указано при показе менеджменту.

## 2. Целевая архитектура и полный parity

```text
operator free text / native dialog / optional slash command
  |
  +--> Pi SessionManager (private conversation; no authority)
  |      before_agent_start: compact fresh Workbench guidance
  |      model -> view / submit / decide (typed schema)
  |
  +--> shared Builder execution coordinator <--- commands
          | awaiting-human / running / stopping / settled
          | one conflicting job; reads and steering stay available
          +--> Workbench.decide + existing exact host gate
          |      immutable artifacts + receipts + workshop descriptor
          +--> typed host actions -> native UI / existing app functions
          |      credentials, labels, sealed file selection stay here
          +--> one observation + transcript result + completion note
                         |
                         +--> localhost read-only Evidence (optional)

restart -> private session + reread durable refs -> recovery guidance
        -> no replay of approval, grants, or provider spend
```

Coordinator is operational state of a live session, not domain state or durable queue. Domain legality остаётся в Workbench. `show` не меняет фазу; side effect всегда имеет отдельный typed action. Один маленький host capability catalog перечисляет только реально callable операции; не рекламировать command-only функции как доступные модели.

**Полнота:** сверить `CLI_COMMANDS` (`src/cli-invocation.ts:9`) и `AHDE_BUILDER_*COMMANDS` с таблицей ниже. Один CLI token не обязан становиться отдельным tool: многие низкоуровневые варианты уже покрыты composite/view. Каждая возможность получает typed route или явную объяснимую недоступность в данном host; отсутствие маршрута нельзя закрывать инструкцией «набери команду».

| Пользовательское намерение / capability | Route и граница |
|---|---|
| Описать агента, уточнить Spec, создать/подключить Pi/Python/existing command agent | Existing spec submits + scaffold/wrap/configure decisions; шаблоны через готовый resolver. Контекст до второстепенных технических вопросов. |
| Изменить модель/судью/simulated user, подключить ключ | Existing configure-target/evaluators + native private login/model UI. Ключи и exact credential input не отдавать модели. |
| Посмотреть/настроить tools, skills, данные; попробовать инструмент | Existing target view/workshop tools и tool-authoring flow. `tool list/inspect/try` проектируется через эти границы, не через ambient shell или live unreviewed action. |
| Поговорить с агентом, записать замечание, продолжить улучшение | Existing talk-to-agent handoff + feedback application. Feedback ingest/list/inspect/clear через typed host actions; clear требует конкретный host review. |
| Cases: создать/править/импортировать/предпросмотреть, выбрать корпус | Existing corpus submits/view(dataset)/select/import-dataset; IDs host-derived. Не делать second import pipeline. |
| Превратить incident/feedback в regression | Existing production-failure submit, затем composite run-current; сохранить world/simulated user/provenance через pending trust fix. |
| Добавить собственный закрытый экзамен или сгенерировать draft/seal | Existing generate-holdout; новый host import-holdout вызывает existing sealed import UI. Модели только количество и тип происхождения, без file contents/path. |
| Проверить baseline, шум, кандидат; пересчитать старые ответы | Existing run-current/calibrate/regrade/verify через coordinator. Экран cheap-check не становится доказательством выпуска. |
| Диагноз, один trace, world outcome, сравнение и доказательства | Existing view(traces/target/history/review) + typed show-action для native panels/localhost Evidence, переиспользующий existing renderers. |
| Исправить проблему; попробовать несколько гипотез | Existing workshop/structured-proposal/improve/search contracts. Pareto table, exact selection; zero auto-promote. |
| Применить и проверить; принять/отклонить/продолжить | Existing apply-proposal+verify, ship/reject/discard/abandon/continue composites. Не требовать отдельного ручного переключения этапов. |
| Показать план/статус/проблемы окружения/что сейчас работает | Existing compilePlan, doctor, shared active job snapshot; model-facing summary и user panel используют одинаковые факты. |
| Остановить; поправить цель, пока идёт проверка | Typed stop-action + native interrupt; never waits for own agent turn. Steering записывается в conversation и учитывается после безопасного boundary; не редактирует immutable запущенный эксперимент. |
| Вернуться после restart, новая/предыдущая conversation | Native private SessionManager and host session dialogs, fresh guidance. Не новый storage. |
| Паспорт/лог версий/HTML report/экспорт recorded dataset | Existing application exporters + typed read/show/export actions. Показать точный local output path; не external publish. Sealed rows всегда исключены. |
| Watch: проверять drift; посмотреть/остановить monitoring | Typed bounded watch start/status/stop над existing application/watch. Один понятный lifecycle, расходы раскрыты; не новый OS scheduler. После restart явно остановлен/прерван, без скрытого auto-spend. |
| Локальный serve API / Evidence открыть, статус, закрыть | Existing localhost servers через scoped host action. Evidence read-only; serve token остаётся у host, не в tools/model transcript. Никакого remote deployment или Studio. |
| init/validate/list/низкоуровневые candidate operations | Existing lifecycle/views/doctor/composites покрывают обычный intent. CLI сохраняется для automation/recovery; не duplicative tool per subcommand. |

UI обозначает одну текущую цель, что уже известно, что делается сейчас и что пользователь сможет решить следующим. Progress — выполненные observations/total или «объём уточняется», не fake percent. Одна human confirmation на подготовленный subject; отдельный новый вопрос только если меняется scope/цена/authority или subject устарел. Отказ и отмена не запускают повторный dialog сами собой.

## 3. Code quality и failure modes

Новые dependency-free functions предпочтительнее class hierarchy. `execution.ts` скрывает timer, controller, busy checks, observation и result delivery; public interface — execute/readActive/stop/dispose. `host-actions.ts` скрывает UI-specific prompts и exports; typed union без stringly dispatch и casts `as never`. Command parsing остаётся в commands, model decoding в transport. Из обоих удаляется перенесённый дубль, а не оставляется fallback copy.

| Failure / edge | Текущий сигнал | Требуемое поведение / проверка |
|---|---|---|
| Dialog отменён; модель снова требует действие | WorkbenchDecisionDeclinedError | Один refusal result, никаких automatic retries/prompts/spend; changed intent может подготовить новый subject. |
| Unknown/высокая стоимость; цена уже одобрена apply receipt | Existing cost guard + authorizedRunCovers | Conditional confirmation; штатный matching-budget reuse, изменившийся scope требует нового review. |
| Branch/HEAD/corpus изменились, пока открыто подтверждение | Existing stale checks; соседний architecture review нашёл branch-identity риск в ship composition | Recheck exact reviewed subject перед side effect. Обязательный regression на switch branch с тем же HEAD; не ослаблять ради одного вопроса. |
| Tool decide и slash test вызваны одновременно | Сейчас separate jobs path | Один coordinator не допускает второй конфликтующий run/mutation; view и stop работают. |
| Медленный dialog более 2 s | Сейчас grace может показать background | `awaiting-human`, нулевое исполнение до approve, cancel убирает pending job. |
| Stop до/после apply или публикации | Сигнал есть, generic stopped note | Сохранённые receipts показаны честно; неполная measurement не считается finished quality evidence. |
| Shutdown во время run или Workshop | Workshop persist зрелый; jobs dispose без abort | Bounded abort/settle, сохранённые refs доступны после restart; grants не восстановлены. |
| Убит процесс / missing worktree / unreadable artifact | Existing recorded/stale workshop, unfinished loop detection | Явный recovery path exact reattach/resume/abandon; не молчаливое пересоздание. |
| Новый пользовательский intent во время background | Native Pi queue + host note | Steering не потерян; completion сообщает факты, не перетирает новую цель; один wake-up. |
| Completion error/renderer падает | Existing observation survives presentation | Execution outcome сохраняется; fallback короткое сообщение, без повторной mutation. |
| Restart с другой branch/model/project | Private session + fresh view | Старое conversational ожидание не может подменить actual Target subject/model; никаких cross-project refs. |
| Provider error/нет ключа/отменён login | Pending first text logic + sanitized failure | Идея возвращается в editor или replay ровно один раз; реальные ошибки onboarding не проглатываются. |
| Export/label/holdout не имеют входных данных | Existing typed application errors | «Сначала нужны ...» + доступное действие, без stacktrace и invented output path. |
| Sealed/credentials через expanded host bridge | До расширения host-only | Tests assert отсутствуют в tool results, guidance, transcript, export; роль человека нельзя заменить model value. |
| Evidence упал/порт занят | Не должен блокировать domain | Терминальный результат и артефакты доступны; ссылка только после successful listen. |

Каждая строка этой таблицы должна получить regression test либо быть явно помечена как незавершённая при финальном gate. До этого demo-ready verdict невозможен.

## 4. Test coverage diagram и acceptance

Использовать существующий Vitest 3.2 и два проекта quick/heavy (`vitest.config.ts`). Тесты, создающие процессы/Git/HTTP, включать в HEAVY. Не добавлять второй framework или tests, которые лишь дублируют список полей реализации.

```text
[E2E] first free intent
  + no credentials -> native connect -> cancel | connect -> replay exactly once
  + existing project -> fresh state -> continue | new session
  + new project -> spec/create -> reviewed cases
                          |
                [HOST GATE] decline | approve | stale-while-open
                          |
              run-current via TOOL or COMMAND [PARITY]
                + short -> actual completed result
                + long -> awaiting-human -> running
                             + read / steer / stop / conflicting mutation
                             + completion / failure / shutdown / crash
                                      |
                               fresh view + one continuation
                                      |
 diagnosis -> workshop -> exact diff review -> apply+verify
              | restart reattach          | reject / underpowered / pass
              | no grants restored        |
                    ship exact subject -> passport -> next cycle

[E2E BRANCHES] label, private holdout, imported incident+world,
               dataset export, watch lifecycle, serve/Evidence, session switch
[EVAL] unseen free-text phrasings, model variation, no command coaching,
       report-only obeyed, changed intent obeyed, no fictional claims
```

**Unit/contract tests:** canonical guidance for every WorkbenchStage and conditional gate; no sealed values; bounded size; idempotent repeated refresh. Coordinator outcomes, late authorization, decline, one observation/completion, abort/dispose, concurrent callers. Typed host union refuses unknown kinds/authority fields and routes allowed kinds without invoking a shell. Price unknown tests from F7.

**Integration tests:** use actual registered extension with lifecycle event handlers, SessionManager, real Workbench and local mock provider. Existing natural-language test's `on:()=>undefined` is insufficient for this new wiring. Exercise both adapters with the same command/decision input and assert identical exact receipts, counts and cancellation semantics. Existing composites, workshop restart and candidate continuation tests remain authoritative domain regressions.

**Terminal E2E acceptance (new guided suite):** operator sends only natural language; fixture Builder can be scripted to make deterministic tool choices, but tool/job/host/lifecycle code is real. Includes long-running measurement with a second operator message, stop, restart, workshop reattach, candidate verification, declined/stale shipping, accepted version and next cycle. No direct calls to application functions to skip a required product step. Check transcript requires no `/command` coaching and does not expose credentials/sealed cases. Verify labels/export/watch/serve host action branches separately; they must not silently be omitted from “all functionality”.

**Real-model EVAL:** separate from transport E2E and explicitly costed. Fixed small RU/EN intent set spanning create/connect, baseline, report-only, fix, change direction, stop/resume, uncertain result and accept/reject. Repeat across at least two supported Builder model configurations if claiming cross-model reliability. Record model/provider, prompt hash, seed/cases, tool trace, operator approvals, failures and cost coverage. Do not call scripted model success a language-understanding eval. Parent decides whether new paid runs are authorized; historical live acceptance remains historical evidence.

**Management demonstration acceptance:**

1. Free demo cleanly installs/runs without credentials and clearly labels scripted fixture. Same packaged CLI and pinned runtime; temporary project preserved for inspection.
2. Real terminal guided demo completes user path without remembered commands; cancellation and restart are demonstrated, not merely listed in help.
3. Result card shows absolute task success, relative improvement with uncertainty/sample, infrastructure failures, and observed world outcome separately from tool-call/citation proxies. Unknown is visible, not zero.
4. Existing 15-case sealed gate is a relative policy; `pass` must not imply a useful absolute quality threshold. The live report that shipped with 23.3% sealed task correctness is retained as counterexample. Criteria required for a task are set before evaluation; lack of measurement cannot be called pass.
5. Real failure becomes regression with preserved world/dialogue; diagnostic hypothesis and exact diff lead to independently checked cases; acceptance creates exact receipts and version passport.
6. Linux+bwrap/Docker lane plus clean package install verifies advertised platform. Previous Mac-only green does not count as Linux evidence.

**Commands for root's final verification, run sequentially after integration:** `npm run check`; `npm run verify:package`; `npm run acceptance:pilot`; `npm run demo`; `git diff --check`. Package verification and demo already rebuild, so do not add redundant full builds between them. Focused lane tests precede this gate. Add guided suite to appropriate existing acceptance command. External publication, merge and push are not part of this plan.

## 5. Performance review

Главный риск изменений — лишнее чтение диска и лавина model continuations, а не медленный CSS. `product-shell.ts:300` уже coalesces refresh; сохранить это. Один fresh summary per user turn, invalidate после completed mutation, никаких repeated full detail/history reads ради status ticker. Не кешировать подтверждения/authority. Один background job и один completion note исключают polling LLM loop: модель после `running` не должна бесконечно вызывать view в ожидании результата.

Snapshot limited to next/selected refs/blockers/job/recovery; full evidence lazy through view. Не строить HTML passport на каждый header refresh. Test assertions: один completion, bounded snapshot, coalesced burst, отсутствие inventory reads на progress tick. Latency budgets измерить на existing demo и corpus с большим числом artifacts, сравнить до/после; не назначать неподтверждённое «меньше 100 ms» как факт. New context должен иметь фиксированный ceiling; overflow даёт omitted count, не silent data loss.

## 6. Sequencing и четыре исполнителя

План для root + 3 agents. Root публикует короткие согласованные interfaces до parallel edits. Один владелец каждого конфликтного файла; соседний agent отдаёт patch fragment/требования, а не правит одновременно `commands.ts`, `workbench-adapter.ts` или `extension.ts`.

| ID | Owner / files | Изменение | Depends | Готово, когда |
|---|---|---|---|---|
| T0 | Root: stopped Evidence/Studio files, CLI, README/ROADMAP | Удалить отвергнутый Studio путь и обещания, закончить 7 сообщённых TS ошибок Evidence; сохранить нужные template/vendor/trust изменения | — | Working tree имеет согласованный scope; initial tsc clean; Studio отсутствует в продуктовых инструкциях и command registry. |
| T1 | Quality lane: `builder/execution.ts`, `jobs.ts`, `workbench-adapter.ts`, integration points in commands | Общий executor, honest started/completed return, shared busy/stop/shutdown, single completion | Interface agreement | F1/F5 tests pass; no per-adapter second jobs. |
| T2 | Architecture lane: `workbench/next-actions.ts`, policy/consent projection, shell/guidance hooks | Fresh canonical next, conditional confirmation, recovery guidance; exact branch freshness regression/fix coordinated with domain trust lane | Interface agreement | Every stage covered; stale confirmation fails closed; no secondary workflow persistence. |
| T3 | Quality lane: `builder/host-actions.ts`, transport schema, command closures | Bounded jobs/status/stop/passport/dataset/judge-label/sealed-import; existing view aliases для чтения; остальной inventory — backlog | T1 contract | Все bounded routes имеют tests; sealed/private boundary не расширена. |
| T4 | Delivery/trust lane: pending `compare`, measurement/report, watch, regression guards, estimator; `.gitmodules`, template resolver, CI | Доделать и проверить существующие truth/package changes; F7; не запускать параллельно весь suite | — | Unknown/invalid never reported healthy/free; world/dialogue retained; named templates work from arbitrary cwd; focused tests green. |
| T5 | Root owns `extension.ts`, runtime/CLI launch, persona, shell integration; agents provide fragments | Single coordinator injection, auto private resume, first-intent replay, localization and compact UI; remove obsolete instructions | T1/T2/T3 | Real extension lifecycle tests include hooks and native dialogs; explicit new mode still works. |
| T6 | Root with test fragments from all lanes: guided E2E, acceptance script, docs | Guided terminal + optional Evidence management demo, truthful report, reproducible artifact links | T0–T5 | Full sequential gate, package, demo and failure branches; unresolved paid-eval limitations stated. |

Dependency graph: `T0 || T1 || T2 || T4`; затем `T3` на контракте T1; `T5` после общих interfaces/patches; `T6` после интеграции всех. Корневые full gates не запускать четырьмя агентами одновременно. Приёмка относится к bounded scope финального root-плана; полный inventory сохранён для следующего этапа и не блокирует текущую реализацию.

Root может распределить по одному независимому host-action family в свободный lane после T4, сохранив одного владельца transport/commands. Flat tasks выше заменяют обычный gstack JSONL artifact по ограничению единственной разрешённой записи.

## Not in scope

Studio или web Builder; новый SaaS/деплой/аккаунты; универсальный shell tool; собственный conversation store; новый durable workflow engine; перезапись Workbench/runner; автоматическая release authority; восстановление grants; расширение model-comparison axis provenance; заявление SOTA; доказательство промышленного качества на синтетическом demo; механическое слияние старой export-training ветки.

## Предлагаемые последующие TODO, не блокирующие этот goal

- Наблюдаемое usability исследование с незнакомыми владельцами настоящих агентов: время до полезного результата и число подсказок. Мотив: scripted/live synthetic acceptance не измеряет самостоятельность пользователя. Effort M; зависит от честного guided release.
- Предметные quality-policy profiles с agreed absolute outcome thresholds, calibrated judge и проверкой реальных incident distributions. Не добавлять общий «90% хорошо» как fake universal standard. Effort M; существующие Spec/graders/labels переиспользуются.
- Явные model-variation experiments с разрешённой осью изменения и matched eval conditions; strict current provenance не обходить. Effort L; отдельный experiment design.

## GSTACK REVIEW REPORT

- **Skill:** plan-eng-review; full skill read, substantive review completed; auto-decisions authorized.
- **Review status:** DONE_WITH_CONCERNS — план готов; текущий продукт не утверждён как готовый к demo/release.
- **Runs:** read-only source inspection of Workbench/Builder/domain integration, native Pi hooks/session API, focused test-source review, existing audit/acceptance documents. No builds, tests, live model calls or publications executed by this reviewer.
- **Architecture:** complete; reuse decision confirmed. Two new module seams maximum, no second workflow state.
- **Code quality:** complete; shared executor and typed host actions replace duplicated closures; authority remains host/domain-owned.
- **Tests:** coverage diagram and acceptance branches specified; scripted E2E versus real-model EVAL explicitly distinguished.
- **Performance:** bounded guidance, coalesced reads, one job/one wake-up; profiling needed after implementation, no invented baseline.
- **Findings:** F1–F8 are source-backed with quoted code and confidence 9–10; no low-confidence conjectures used as blockers. Sibling branch-freshness finding is an integration regression requirement, not claimed dynamically reproduced here.
- **Decisions:** auto-selected recommendations A/reuse throughout; rejected duplicate runtime, raw command bridge, slash coaching and fake completion.
- **Parallel review:** root synthesizes this report with architecture and product review; no additional outside agents spawned.
- **VERDICT:** implement bounded T0–T6 through the root goal; preserve mature mechanisms, complete the main guided loop and agreed host actions. Full CLI parity is explicit backlog, not a release blocker for this bounded implementation.
- **UNRESOLVED:** current WIP build/trust fixes not validated by this review; real-model conversational reliability and unseen-user usability remain empirical checks. No missing user decision blocks engineering implementation.
