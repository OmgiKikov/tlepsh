# AHDE — архитектурное ревью, 6 сентября 2026

Метод: `improve-codebase-architecture` и `codebase-design`; независимое чтение текущего рабочего дерева, последних 15 изменений, публичного флоу и `docs/INVARIANTS_V1.md`. Код не изменялся. Параллельное независимое чтение выполняют инженерный и quality reviewers; дополнительные агенты не создавались из-за лимита слотов. Пользователь уже поручил самостоятельно выбрать и реализовать итоговый план: дополнительный выбор кандидата не требуется.

В проекте нет `CONTEXT.md` и `docs/adr/`. Имена предметной области взяты из README и 44 инвариантов: Target, Spec, Corpus Draft, development corpus, Eval Run, Proposal, Candidate. Здесь **module** — поведение за **interface**, **seam** — место его подмены, **adapter** — конкретная реализация. **Depth** даёт **leverage** вызывающему коду и **locality** изменений. Размер файла сам по себе ничего из этого не доказывает.

## 1. Разделить доступ к истории и право улучшать Target

**Strong · P1 · in-process**

Файлы: `src/workbench/resolution.ts:396`, `src/workbench/inventory.ts:819`, `src/workbench/run-inspection.ts:110`, `src/workbench/workbench.ts:1818`.

`readableDevelopmentEvals` заявляет read-only назначение, но требует approved Spec и опубликованный dataset hash. CLI может создать нормальный development Eval Run раньше этих действий; summary и Evidence показывают его, а `/traces` не находит. Причина — семантика interface чтения смешана с authority будущего изменения.

**До:** CLI run → development inventory → требование публикации → «нет прогонов».

**После:** CLI run → development inventory → Target identity → read-only traces. Proposal → прежняя строгая совместимость Spec/corpus/revision/suite.

Минимальное изменение: `readableDevelopmentEvals` выбирает историю текущего Target из уже отфильтрованного `developmentEvals`. Параметр approved Spec, если нужен вызывающим сторонам, не должен неявно становиться условием чтения всей истории. `compatibleDevelopmentEvals` и проверки решений сохраняются. Точное открытие Run по-прежнему идёт через `loadVerifiedEvalRun` и `inspectSelectedDevelopmentRun`.

Deletion test: удаление фильтра опубликованного corpus из read module убирает лишнее продуктовое ограничение; удаление строгого decision module размножит существенные правила по мутациям. Углублять нужно existing read seam, а не добавлять новый режим в каждый renderer. Это даёт locality одной правке и leverage терминальному и модельному adapter.

Приёмка через публичный Workbench interface: CLI-подобный development Run читается без Spec/публикации и после нового Target commit; другой Target, sealed и screen не читаются; altered indexed trace отказывается; тот же неопубликованный/устаревший Run не допускается как основание Proposal или regression case.

## 2. Принять уже существующую тестовую корзину самим хостом

**Strong · P1 · local-substitutable**

Файлы: `src/workbench/types.ts:676`, `src/workbench/workbench.ts:3089`, `src/builder/workbench-adapter.ts:503`, `src/application/builder-corpus-draft.ts:222`, `src/application/corpus-target.ts:74`, `src/manifest.ts:511`.

В репозитории Target уже могут быть валидные `evals/development.jsonl` и suite defaults. Но Workbench предлагает только модельный `corpus-draft`, JSONL из `imports/` и recipe из `imports/`. Builder вынужден просить человека копировать файл либо пересочинять cases. Это потеря содержимого при пересказе и лишняя работа с файлами в основном пути.

**До:** manifest dataset → человек копирует в imports → модель задаёт форму → host draft → review.

**После:** manifest dataset → host-owned current-dataset submission → existing Spec-bound draft → existing review/publication.

Минимальный контракт для реализации:

1. Один новый вид существующего `submit`, без model-supplied path, tasks, source hash или authority. Хост берёт только dataset текущего Target и exact approved Spec; модель может дать название и краткое описание.
2. Повторно использовать текущие `ResolvedTarget`, `createBuilderCorpusDraft`, publication и lineage modules. Для каждого case переносить исходные `input`, `expected`, `messages`, `simulatedUser`, `world`, `metadata`; передать `task.graders ?? target.graderDefaults`. `world.expect` остаётся на case и добавляется к effective graders ровно один раз. Копирование всех `effectiveGraders` вместе с `world.expect` удвоит проверки в `targetWithCorpus`.
3. Host-derived Spec-bound ids остаются каноническими. Сохранить точную связь `sourceTaskId → derivedTaskId` и source identity (Target id/revision, declared dataset, dataset hash и suite hash) в immutable provenance. Provenance не должна зависеть только от model-authored coverage notes. Ревизии draft наследуют source lineage; проверка root должна пережить restart и отказываться при подмене.
4. Лимиты уже существующего draft: максимум 100 cases, 2 MiB суммарно и 64 KiB на case. Не делать скрытую выборку или усечение. Проверять protected roots, symlink components и sealed provenance до передачи содержимого в model-visible draft; не расширять imports allowlist. Если manifest dataset совпал с известным sealed content или лежит в private state/runs, отказать.
5. При review/publication перепроверить выбранный Target/Spec и источники draft. Изменившиеся dataset/default graders требуют нового draft и review. Смена обычного focus не может перепривязать уже подготовленный draft. Source basket и агент остаются побайтово неизменными.
6. Никакой auto-publication: текущий host-confirmed `run-current`/публикация остаётся единственным переходом в development evidence. Imported native draft не является доказательством, что прежний ad-hoc Run принадлежит опубликованному corpus; первый опубликованный прогон получает новую точную surface identity.

Deletion test: новый самостоятельный importer/parser будет shallow дубликатом. Нужна глубина существующего Corpus Draft module: второй реальный adapter (модельный ввод и host current dataset) пересекает один seam и использует те же review, edits и publication. Leverage — не переписывать lifecycle; locality — преобразование case и provenance проверяются в одном месте.

Приёмка: собственная native корзина без imports проходит Spec → draft review → публикацию → evaluation; defaults/per-case override/world expectations дают те же effective graders; source ids прослеживаются; после restart draft читается; stale source, forged provenance, symlink и sealed source отказаны; исходные файлы не переписаны. Отдельно пройти натуральный TUI путь реальным Builder, а не только прямым вызовом Workbench.

## 3. Убрать второе физическое чтение inbox-файлов

**Strong · P2 · local-substitutable**

Файлы: `src/application/builder-corpus-import.ts:104–239`, `src/application/dataset-source.ts:96–212`, `tests/builder-corpus-import.test.ts:133`, `tests/dataset-ingest.test.ts:577`.

Оба module независимо реализуют containment, обход symlinks, `O_NOFOLLOW`, одинаковое сравнение inode/mtime/ctime/size, ограниченное чтение, UTF-8 и SHA-256. Различаются parser и обязательный лимит: native JSONL 2 MiB/100 cases, произвольный inbox export 16 MiB. Это реальный повтор security implementation, а не два разных доменных правила.

**До:** JSONL import → свой safe reader; dataset/failure intake → другой safe reader.

**После:** JSONL parser + dataset/failure parser → существующий `readDatasetSource` с ограничением вызывающего пути.

Минимальное изменение: переиспользовать existing reader, сохранив `BuilderCorpusImportSourcePathSchema` перед чтением и собственный parser/100-case limit после него. Reader должен принимать меньший byte cap до выделения/чтения, default остаётся 16 MiB. Private roots передаются явно. Новый configurable reader framework, path provider interface и класс adapter не нужны.

Deletion test: удаление второго safe reader концентрирует проверки в уже используемом module, а не переносит их на callers. Его interface становится глубже для трёх существующих adapters; locality security fix одна, leverage тестов увеличивается.

Приёмка на существующем import interface: >2 MiB отказан до draft write; общий reader по-прежнему допускает допустимый >2 MiB export; traversal/private roots/symlinks/invalid UTF-8/меняющийся inode отказывают; import hashes и исторические receipts побайтово совместимы. Достаточно имеющихся import/dataset/failure tests и одного недостающего cap regression.

## Что сохранять и что не делать

- Pi и command Target — два реальных adapters одного execution seam; это оправданная глубина. Собственный agent runtime поверх них не нужен.
- Canonical trace, pinned evidence, sealed gates и строгая authority решений несут продуктовые гарантии. Их удаление переносит риски и сложность в callers.
- Workbench — большой module, но `view/submit/decide` уже является понятным interface. Перенос методов по файлам без исчезновения обязанностей не проходит deletion test.
- TypeBox нужен Pi tool contract, Zod — AHDE artifacts, YAML — manifest. Их замена своим кодом не упрощает продукт.
- `resolveTaskGraders` и `targetWithCorpus` повторяют часть scoring resolution. Новый native путь обязан сохранить их общую семантику; полный рефактор сейчас не требуется без отдельного подтверждённого расхождения.

## Рекомендация для единого плана

Сначала закрыть №1 и №2: они мешают оператору использовать уже выполненный прогон и свою готовую корзину. №3 выполнить как небольшое удаление дублирования с прежними защитами. Не начинать разнос крупных файлов или новые возможности, пока натуральный путь «подключил свой Python Target → выбрал существующие cases → увидел проверенный результат → подготовил изменение» не пройден.

Это анализ локальной архитектуры, не заявление о превосходстве над современными продуктами. Актуальность внешних практик проверяет root по первичным источникам отдельно. Полный натуральный пользовательский путь на момент этого read-only отчёта ещё не доказан.
