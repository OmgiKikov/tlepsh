# AHDE — Agent Harness Development Environment

Plan v2 — synthesized from three parallel reviews (eng-review, deep-modules architecture review, thermo-nuclear quality review). Supersedes v1.

## Mission

Внутренняя платформа для разработки, наблюдения и улучшения project-specific AI agents.

```
Builder (Pi + frontier model, запускется как target с builder-manifest)
   ↓ читает failure bundle, патчит target repo
Target Harness (Pi + target model + manifest)
   ↓ выполняет задачи
Run → Trace (verbatim session.jsonl) → Eval (deterministic graders)
   ↓ failures
Failure Bundle → Builder → candidate branch
   ↓ та же suite, provenanceKey guard
Baseline vs Candidate → promote (git tag) / reject (evolution log)
```

Принцип: **Builder != Target**, Builder — внешний оптимизатор. Никакого self-improving loop. Human gate на promote.

## Review synthesis — что изменилось против v1

1. **5 пакетов → 1 пакет** (`ahde`) с модульной структурой папок (термо-нюкл + архитектурное). Пакетные границы = папки; split при появлении второго потребителя.
2. **builder-bridge RPC → Builder это Target** (архитектурное ревью): builder = manifest с frontier-моделью, его task input — failure bundle. Даёт builder-trace бесплатно через тот же runner. Никакого своего RPC.
3. **Оценщик без таксономии** (термо-нюкл): graders — декларативные типы в target suite (`tool_called`, `output_contains`, `output_matches`), исполняются платформой. Judge — Phase 2.5 (через vendored vitest-evals judges), human — человек читает bundle, не тип в коде. DeepEval — вычеркнут.
4. **provenanceKey — одна функция** (все три): compare guard = равенство ключа, а не разбросанные проверки полей. Оси: pi_version+pi_sha, provider, model id, params, thinking_level, suite_hash (dataset + graders), dataset_hash. git_sha target'а НЕ входит в ключ (baseline и candidate обязаны отличаться только им).
5. **RunRecord** (eng-review поля + термо-нюкл single-writer): provenance + lifecycle + metrics. Метрики пишутся ровно один раз при финализации из `getSessionStats()`. `trace.ts` — единственный парсер session.jsonl. Оценки живут в run.json; eval_run.json — тонкий производный индекс.
6. **Промоут = git annotated tag** в target repo (message содержит JSON: eval_run_id, baseline, candidate_sha, summary) + append-only `docs/evolution.jsonl`. registry.json вычеркнут.
7. **Кандидатный флоу = meta-harness механика** (eng-review): `validate` (manifest zod, 0 токенов) → `smoke` (1 задача) → suite → compare → promote/reject. Кэш baseline: переиспользуется последний eval_run с тем же provenanceKey.
8. **Вычеркнуто из v1** (мёртвый конфиг / преждевременная абстракция): policies.yaml, runtime.pi в manifest, manifest.version (версия = git tag), tools/* JS-загрузка (MVP: bash-скрипт в target repo + tool_call grader), Docker seam (пока одна функция окружения), adapter-слой поверх SDK (runner и есть адаптер), `--jobs` параллелизм, scope.md генерация (гейт = `git diff --name-only` проверка в promote).
9. **Добавлено**: crash-tolerant run.json (`status: running` до старта, финализация после), watchdog-таймаут (`session.abort()`), `PI_OFFLINE` (банк-egress), session_id + trace sha256, `ahde list` + `ahde validate`, базовый кэш baseline, scope-проверка diff'а кандидата.

## Repo layout

```
harness/
  package.json              # один пакет "ahde", bin: ahde; deps: file:vendor/tarballs/* (или workspace-hoist)
  src/
    manifest.ts             # zod-strict TargetManifest loader → ResolvedTarget
    provenance.ts           # RunRecord schema, dataset/suite hashing, provenanceKey, comparable()
    trace.ts                # ЕДИНСТВЕННЫЙ парсер session.jsonl: open/toolCalls/usage/renderMarkdown
    runner.ts               # ЕДИНСТВЕННЫЙ SDK-execution importer; runTask → run dir (паттерн pi-harness.ts)
    eval.ts                 # dataset jsonl + декларативные graders + eval_run индекс
    compare.ts              # provenanceKey guard + markdown таблица
    bundle.ts               # failure bundle compiler → bundle.md
    builder.ts              # builder-as-target: запуск builder-manifest с bundle как task
    loop.ts                 # candidate flow: validate→smoke→suite→compare→promote/reject, evolution log
    cli.ts                  # run|list|validate|failures|compare|promote|reject|builder
  targets/ombudsman/        # demo target: свой git repo
    manifest.yaml, AGENTS.md, skills/check-dbo/SKILL.md, evals/, bin/check_dbo
  builders/default.yaml     # builder manifest (frontier model, отдельный authPath)
  vendor/pi-mono/           # клон на pinned SHA, собран один раз
  runs/                     # gitignored артефакты прогонов
  docs/evolution.jsonl      # append-only лог promote/reject
  tests/                    # unit + mock-model интеграционные
```

## Contracts

### TargetManifest (strict, без опциональных полей)

```yaml
id: ombudsman
model:
  provider: qwen-internal            # провайдер из генерируемого models.json
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: http://127.0.0.1:9901/v1  # или внутренний gateway
  apiKeyEnv: OMBUDSMAN_MODEL_KEY
  thinkingLevel: off
  timeoutMs: 600000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]           # пути от корня target repo
evalSuite:
  id: ombudsman-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
```

### Task (dataset jsonl)

```jsonc
{ "id": "task_007", "input": "Обращение: ...", "graders": [
  {"type": "tool_called", "name": "bash", "argsContains": "check_dbo"},
  {"type": "output_contains", "text": "договор"} ] }
```
Пер-task graders; suite-дефолты — в graders.yaml (применяются, если у задачи пусто).

### RunRecord (runs/<run_id>/run.json)

```jsonc
{ "schemaVersion": 1, "runId": "run_...", "taskId": "...", "repetitionIndex": 0,
  "status": "running|pass|fail|error", "error": null,
  "startedAt": "...", "finishedAt": "...",
  "target": {"id": "ombudsman", "gitSha": "..."},
  "runtime": {"piVersion": "0.84.3", "piSha": "..."},
  "model": {"provider": "qwen-internal", "id": "qwen3.5-27b", "thinkingLevel": "off", "params": {}},
  "eval": {"suiteId": "...", "suiteHash": "sha256:...", "dataset": "development", "datasetHash": "sha256:..."},
  "trace": {"path": "session.jsonl", "sessionId": "...", "sha256": "sha256:..."},
  "metrics": {"tokens": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},
              "costUsd": 0, "latencyMs": 0, "toolCalls": 0, "toolErrors": 0},
  "evalResults": {"graders": [{"name":"...","passed":true,"score":1,"reason":"..."}], "outcome": "pass|fail"},
  "parent": {"evalRunId": "...", "candidateOf": null} }
```

### Failure bundle (bundle.md, единственный интерфейс Builder'а)

Header (target, versions, baseline метрики, правило scope) → summary failed задач → по каждой: task input, grader failures, рендер трейса (только message-entries: user/assistant text, toolCall name+args, toolResult text) → приложения: AGENTS.md, все SKILL.md target'а.

### CLI

```
ahde run --target targets/ombudsman [--task id] [--repetitions N] [--label baseline|candidate]
ahde list [--target id] [--suite id]          # eval_run'ы и run'ы
ahde validate --target targets/ombudsman      # manifest+suite lint, 0 токенов
ahde failures <evalRunId> [--out bundle.md]
ahde compare <evalRunA> <evalRunB>             # provenanceKey guard + таблица
ahde builder --target targets/ombudsman --bundle <path>   # builder-as-target запуск
ahde promote --eval-run <id> --to 0.1.1        # git tag + evolution log + scope-diff проверка
ahde reject --eval-run <id> --reason "..."
```

## Vendoring

Клон pi-mono на SHA в vendor/, сборка один раз (`npm ci --ignore-scripts && npm run build:offline`, tsgo — только их дев-тулчейн). Подключение: primary — root workspaces `["src", "vendor/pi-mono/packages/*"]` (symlink, SHA-точно); fallback — `npm pack` собранных пакетов в vendor/tarballs/ + `file:` deps. Решение фиксируется Phase 0 спайком. piVersion/piSha пишутся в каждый RunRecord из vendor/pi-mono git.

## Phases

**Phase 0 (0.5d)** — scaffold: git init, package.json, tsconfig strict, vitest, biome; vendoring spike (решение workspaces vs tarballs); provenance.ts + manifest.ts + тесты (canonical JSON hashing, strict schema).

**Phase 1 (1d)** — runner.ts + trace.ts: runTask по паттерну pi-harness.ts (per-run ModelRuntime/Services/SessionManager, сгенерированный models.json с `$ENV`, watchdog, crash-tolerant run.json); mock-model SSE-сервер для тестов; `ahde run`, `ahde validate`, `ahde list`. Тесты: mock-модель end-to-end (включая tool-call сценарий и error-кейс).

**Phase 2 (1d)** — eval.ts + compare.ts: декларативные graders (tool_called / output_contains / output_matches), eval_run индекс, provenanceKey guard (table-driven тест: каждая ось → refuse), compare markdown.

**Phase 3 (1d)** — bundle.ts + builder.ts + loop.ts: bundle compiler; builder-as-target; candidate flow (validate → smoke → suite → кэш baseline → compare → promote/reject + evolution log + scope-diff гейт).

**Phase 4 (0.5–1d)** — vertical slice: targets/ombudsman с заложенным failure (узкий skill description), mock "Qwen" с контекстно-зависимым сценарием (узкое описание → не вызывает check_dbo; широкое → вызывает) — цикл честный: патч скилла реально меняет поведение. Полный прогон: baseline → bundle → builder patch → candidate → compare → promote. README с результатом. Точки подключения реальных endpoint'ов задокументированы.

## Out of scope (MVP)

training/RL, web UI, multi-user, marketplace, второй target-runtime, MCP, judge graders (Phase 2.5), DeepEval, Docker, параллельный runner, autonomous promote, own observability backend, Confident AI.

## Review provenance

- Eng-review: grader dependency inversion (graders в suite), suite_hash в provenance, validate/smoke гейты, кэш baseline, crash-tolerant run dirs, mock-model тест-стратегия, vendoring-блокер (file: депы не резолвятся), PI_OFFLINE, watchdog, missing CLI verbs.
- Architecture review: именованные модули (provenance/trace/runner/bundle/builder/loop), trace.ts как единственный парсер, Builder-is-a-Target, единый writer метрик, доверие/trust-ловушка (решено skillsOverride — без trust), pi-adapter как charter (2 файла импортируют SDK).
- Thermo-nuclear: 1 пакет ~1400 LOC вместо 5 пакетов ~3000, spawn+diff вместо RPC, git tag вместо registry, plain-function graders, вычеркнутый мёртвый конфиг, message-only trace renderer (<1000 LOC гарантия), единственный eval_results writer, minimal-slice discipline.
