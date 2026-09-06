# Ponytail Audit — AHDE, 6 сентября 2026

`delete:` убрать старый `real-loop.mjs`: сценарий августа подставляет заранее известный diff и сам вызывает promotion/adoption; текущие Python/Pi pilots и package acceptance уже проверяют этот жизненный цикл. История остаётся в Git. [scripts/real-loop.mjs](../../scripts/real-loop.mjs)

`shrink:` убрать второй сборщик системного промпта из `prompt-size.mjs`; измерять результат `resolveBuilderAssets`, которым действительно пользуется Builder. Сейчас диагностический скрипт ищет skills на диске, хотя production использует пустой `BUILDER_SKILLS`. [scripts/prompt-size.mjs](../../scripts/prompt-size.mjs), [runtime.ts](../../src/builder/runtime.ts)

`shrink:` заменить четыре одинаковых `candidateIds` одним чтением каталога в существующем модуле артефактов кандидата; не менять правила проверки самих записей и не скрывать новые ошибки. [agent-log.ts](../../src/application/agent-log.ts), [experiment-history.ts](../../src/application/experiment-history.ts), [version-passport.ts](../../src/application/version-passport.ts), [watch.ts](../../src/application/watch.ts)

Кандидаты ниже требуют отдельного разбора корректности, поэтому не входят в обещанное сокращение:

`shrink:` физическое чтение dataset повторено в двух импортерах: inode, NOFOLLOW, лимит, UTF-8. Один проверенный reader с двумя существующими лимитами может убрать повтор; ограничения source path, private roots и формата должны остаться на своих местах. [builder-corpus-import.ts](../../src/application/builder-corpus-import.ts), [dataset-source.ts](../../src/application/dataset-source.ts)

`shrink:` три копии sealed-corpus hash lookup следует свести в существующий corpus module после проверки `catch → empty Set`: пустой набор при повреждении хранилища может означать ошибочное разрешение чтения. [cli.ts](../../src/cli.ts), [label-session.ts](../../src/builder/label-session.ts), [export-dataset.ts](../../src/application/export-dataset.ts)

Крупные Workbench/eval файлы сами по себе не основание переносить код. TypeBox обеспечивает контракт Pi, Zod — валидацию AHDE, YAML — пользовательский manifest; удаление этих зависимостей переносит сложность в собственные реализации. Pi runtime, sandbox checks, immutable receipts и sealed gates оставлены: это работающие обязанности, а не запас на будущее.

net: ~-300 lines, -0 deps possible.
