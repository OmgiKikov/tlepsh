# AHDE — Agent Harness Development Environment

Внутренняя платформа для разработки, наблюдения и улучшения project-specific AI agents.

```
Builder (Pi + target model)            ← улучшает
   ↓ failure bundle → патч harness-файлов
Target Harness (Pi + target model)     ← исполняет
   ↓ задачи
Run → Trace (session.jsonl) → Eval     ← доказательства
   ↓ failures
Baseline vs Candidate → promote/reject ← git tag + evolution log
```

Главный принцип: **Builder != Target**. Builder — внешний оптимизатор, который
читает traces чужого harness'а и патчит его файлы. Никакого self-improving loop.

## Цикл (доказан тестами и `npm run demo`)

```
BUILD TARGET → RUN TARGET → TRACE → EVAL → IMPROVE TARGET → VERIFY → PROMOTE
```

Демо полного цикла с mock-моделью (ноль токенов, реальные Pi-сессии):

```bash
npm run demo
# 1. Target: ombudsman, 5 задач, заложенный failure (узкий skill description)
# 2. Baseline: 2/5 all-pass
# 3. Failure bundle: markdown с трейсами, причинами, harness-файлами
# 4. Builder читает bundle → патчит skills/check-dbo/SKILL.md на ветке
# 5. Candidate: validate → smoke → suite → compare → 5/5, 3 improved, 0 regressed
# 6. Promote: git tag v0.2.0 + запись в evolution log
```

## Установка

```bash
npm install --ignore-scripts   # ставит vendored pi из vendor/tarballs/
npm run build                  # dist/cli.js
npm test                       # 39 тестов: юнит + интеграционные (mock-модель)
```

Vendored Pi живёт в `vendor/pi-mono` (pinned SHA `5cd6a2a5`, версия 0.84.3):
свой git-клон, своя сборка (`npm run vendor:build`), подключение через
tarball'ы (`npm run vendor:pack` → `file:vendor/tarballs/*.tgz`). Ноль патчей
в core; SHA-точный provenance пишется в каждый run. В git репозитория
`vendor/pi-mono` — gitlink на этот SHA (обновление vendora = отдельная
процедура: обновить клон, пересобрать, перепаковать, обновить gitlink,
прогнать все target-скважины как upgrade-gate).

## Использование

Просто поболтать с платформой — companion-агент сам водит по циклу (init →
validate → run → failures → builder → candidate → promote), запускает команды
и показывает результат; полный трейс диалога пишется в `runs/chat_*/`:

```bash
node dist/cli.js          # или: ahde chat
> собери агента для классификации тикетов
> прогони baseline
> что с фейлами? собери bundle и запусти builder
> promote 0.2.0          # human gate — companion спросит подтверждение
```

Ручной режим (то же самое, но глаголами):

Собрать своего агента с нуля (target = git-репозиторий: манифест, инструкция,
скиллы, инструменты, датасет):

```bash
node dist/cli.js init my-agent                 # скелет из рабочего шаблона
# → отредактируй my-agent/manifest.yaml (id, model, apiKeyEnv),
#   AGENTS.md, skills/, evals/*.jsonl — бенчмарк = jsonl с graders
node dist/cli.js validate --target my-agent    # 0 токенов: чек манифеста и suite
node dist/cli.js run --target my-agent --label baseline --repetitions 5
```

Дальше — цикл улучшения:

```bash
node dist/cli.js failures <evalRunId> --target my-agent      # bundle для билдера
node dist/cli.js builder --target my-agent --bundle <bundle.md>
node dist/cli.js candidate --target my-agent --branch candidate-x
node dist/cli.js compare <baselineEvalRun> <candidateEvalRun>
node dist/cli.js promote --target my-agent --eval-run <id> --to 0.2.0
node dist/cli.js reject --eval-run <id> --reason "..."
```

Текущий эксперимент через OpenRouter разделяет роли: target =
`qwen/qwen3.5-9b` (cheap/weak), builder = `z-ai/glm-5.3` (frontier).
Ключ задаётся через `apiKeyEnv`. Для внутреннего продакшена замените `baseUrl`
в обоих manifest-файлах на корпоративный OpenAI-совместимый gateway.

Канонический baseline после bounded final-answer recovery
(`qwen/qwen3.5-9b`, 5 задач × 2 repetitions, reasoning=low): **6/10
all-pass**, `$0.0129`, 3 recovery turns, 0 runtime errors. Recovery включается
один раз только после tool-loop с пустым final text и выполняется с отключёнными
tools. Minimal activation-trigger candidate был отклонён: 6/10 → 5/10 с
регрессиями на трёх задачах.

Eval-методология (после трёх отвергнутых prompt-кандидатов): task_004
оценивается judge-градером (frontier-модель по rubric; verdict+reason пишется
в run.json, полный обмен с judge'ом — запрос и сырой ответ — в
`runs/<run_id>/judge/<graderIndex>.json`, до парсинга, так что даже
unparseable-вердикт оставляет след; infra-ошибка judge'а валит eval run, а не
засчитывает fail), датасет разделён на development/holdout
(`--dataset evals/holdout.jsonl`), baseline пишется с `--repetitions 5`
(2 повторения давали слишком высокий шум). Judge-модель задаётся в
`evalSuite.judge` манифеста target'а.

## Архитектура (один пакет, именованные модули)

| Модуль | Ответственность |
|---|---|
| `src/provenance.ts` | RunRecord, canonical-JSON хэши, `provenanceKey`/`axisDifferences` — version-axis guard одной функцией |
| `src/manifest.ts` | strict-zod TargetManifest + dataset/graders → ResolvedTarget с хэшами |
| `src/trace.ts` | ЕДИНСТВЕННЫЙ парсер session.jsonl: toolCalls/usage/renderMarkdown |
| `src/runner.ts` | ЕДИНСТВЕННЫЙ SDK-execution importer: изолированная Pi-сессия на каждый run (паттерн pi-harness.ts), watchdog, crash-tolerant run.json |
| `src/eval.ts` | декларативные graders (tool_called / output_contains / output_matches / judge), eval_run индекс, baseline reuse |
| `src/compare.ts` | provenanceKey guard + per-task таблица лифтов |
| `src/bundle.ts` | failure bundle compiler — единственный интерфейс Builder'а |
| `src/builder.ts` | Builder-as-Target: модель берётся из target (или из builder manifest при явном override), bundle → git-ветка с diff (контракт проверяется) |
| `src/loop.ts` | кандидатный флоу (validate → smoke → suite → compare), promote (git tag + scope-гейт) / reject + evolution log |
| `src/mock-model.ts` | scriptable OpenAI-совместимый сервер: stateless-роутинг по контексту (скилл-патч меняет поведение) |

Ключевые контракты:

- **Trace = verbatim Pi session.jsonl** + run.json-обёртка с provenance
  (runId, taskId, gitSha, piSha, model, suiteHash, datasetHash, метрики из `getSessionStats()` — single writer).
- **Сравнимость** = равенство `provenanceKey` по осям pi/model/thinkingLevel/params/suite/dataset.
  gitSha target'а в ключ НЕ входит — baseline и candidate обязаны отличаться только им.
- **Suite отделён от harness**: suiteHash покрывает dataset + graders; promote
  дополнительно отказывает, если кандидат тронул `evals/**`.
- **Builder изолирован**: свой manifest, свой authPath, свой run dir; его контракт —
  «bundle на входе → git-ветка с непустым diff на выходе» — проверяется кодом.
- **Human gate**: promote — отдельная команда; автономного продвижения нет.

## Расположение

```
src/            платформа (один пакет ~1500 LOC)
targets/        target-репозитории (ombudsman — рабочий пример; каждый — свой git)
builders/       манифесты builder-агентов
vendor/         pi-mono (pinned SHA) + tarballs
docs/           evolution.jsonl — append-only журнал promote/reject
                (демо-прогоны пишут во временный лог, здесь — только реальные
                 promote/reject; файл в git пуст до первого реального promote)
runs/           артефакты прогонов (gitignored)
tests/          юнит + интеграционные (mock-модель, ноль токенов)
scripts/demo.mjs полный цикл одной командой
```

## Out of scope (сознательно)

Training/RL (stage 2: Agent Lightning), judge-кэш (при повторных
прогонах одинаковых ответов), DeepEval,
MCP, Docker-изоляция, web UI, multi-user, второй target-runtime, автономный
promote, собственный observability backend. Каждая вырезанная деталь имеет
именованный re-entry point в PLAN.md.

План и история решений (включая тройной architecture review): `PLAN.md`.
