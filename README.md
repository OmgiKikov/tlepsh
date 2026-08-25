# AHDE — Agent Harness Development Environment

Внутренняя платформа для разработки, наблюдения и улучшения project-specific AI agents.

```
Builder (Pi + frontier model)          ← улучшает
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
в core; SHA-точный provenance пишется в каждый run.

## Использование

```bash
node dist/cli.js validate --target targets/ombudsman
node dist/cli.js run --target targets/ombudsman --label baseline
node dist/cli.js failures <evalRunId> --target targets/ombudsman
node dist/cli.js builder --target targets/ombudsman --bundle <bundle.md>
node dist/cli.js candidate --target targets/ombudsman --branch candidate-x
node dist/cli.js compare <baselineEvalRun> <candidateEvalRun>
node dist/cli.js promote --target targets/ombudsman --eval-run <id> --to 0.2.0
node dist/cli.js reject --eval-run <id> --reason "..."
```

Подключение реальной модели: `targets/<t>/manifest.yaml` → `baseUrl` на
внутренний gateway (OpenAI-совместимый), ключ через `apiKeyEnv`. Для builder'а —
`builders/default/manifest.yaml` на frontier-модель. Всё остальное без изменений.

## Архитектура (один пакет, именованные модули)

| Модуль | Ответственность |
|---|---|
| `src/provenance.ts` | RunRecord, canonical-JSON хэши, `provenanceKey`/`axisDifferences` — version-axis guard одной функцией |
| `src/manifest.ts` | strict-zod TargetManifest + dataset/graders → ResolvedTarget с хэшами |
| `src/trace.ts` | ЕДИНСТВЕННЫЙ парсер session.jsonl: toolCalls/usage/renderMarkdown |
| `src/runner.ts` | ЕДИНСТВЕННЫЙ SDK-execution importer: изолированная Pi-сессия на каждый run (паттерн pi-harness.ts), watchdog, crash-tolerant run.json |
| `src/eval.ts` | декларативные graders (tool_called / output_contains / output_matches), eval_run индекс, baseline reuse |
| `src/compare.ts` | provenanceKey guard + per-task таблица лифтов |
| `src/bundle.ts` | failure bundle compiler — единственный интерфейс Builder'а |
| `src/builder.ts` | Builder-as-Target: frontier-манифест, bundle → git-ветка с diff (контракт проверяется) |
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
runs/           артефакты прогонов (gitignored)
tests/          юнит + интеграционные (mock-модель, ноль токенов)
scripts/demo.mjs полный цикл одной командой
```

## Out of scope (сознательно)

Training/RL (stage 2: Agent Lightning), judge-градеры (Phase 2.5), DeepEval,
MCP, Docker-изоляция, web UI, multi-user, второй target-runtime, автономный
promote, собственный observability backend. Каждая вырезанная деталь имеет
именованный re-entry point в PLAN.md.

План и история решений (включая тройной architecture review): `PLAN.md`.
