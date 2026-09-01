# <REPLACE-ME: Agent name> — spec

<!--
  Builder Pi reads only the headings below (English or Russian spellings both
  work) and one bullet per line when it turns this file into the typed Spec the
  ship gate needs. Anything else in the file stays yours.

  The rule that matters: every bullet under "Success criteria" must map 1:1
  onto a grader in evals/. If a criterion has no grader, it is a wish; if a
  grader has no criterion, the ship gate is measuring something nobody
  promised.
-->

## Purpose

<REPLACE-ME: одно-два предложения: кого обслуживает агент и что он делает
с каждым входящим обращением.>

## Users

- <REPLACE-ME: кто пишет агенту, в какой форме.>
- <REPLACE-ME: кто читает ответ агента перед отправкой, если такой человек есть.>

## Jobs

- <REPLACE-ME: классифицировать обращение одним из типов: …>
- <REPLACE-ME: при наличии <триггера> — проверить данные через bin/check_account.>
- <REPLACE-ME: ответить по существу одним сообщением на русском языке.>

## Inputs

- <REPLACE-ME: текст обращения, одна реплика, поле `input` кейса.>
- <REPLACE-ME: триггер внутри текста — если он там есть.>

## Allowed actions

- <REPLACE-ME: запуск `bash bin/check_account --id <N>`.>
- Ответ клиенту текстом на русском языке.
- <REPLACE-ME: явный запрет на всё остальное — никаких других вызовов, никаких изменений в системах.>

## Success criteria

<!-- One checkable line per grader. Name the literal words the graders match. -->

- <REPLACE-ME: ответ называет тип обращения словом «…» и это слово стоит в начале ответа.>
- <REPLACE-ME: при наличии <триггера> агент вызывает bash с `check_account` до того, как ответить.>
- <REPLACE-ME: ответ содержит слово «…».>
- <REPLACE-ME: ответ по существу раскрывает тему обращения, а не только называет его тип.>
- <REPLACE-ME: ответ написан по-русски и умещается в одно сообщение.>

## Constraints

- Только русский язык в ответе клиенту.
- Одно сообщение на обращение, без уточняющих вопросов к клиенту.
- <REPLACE-ME: данные берутся только из вывода инструмента, не выдумываются.>
- Ни персональные данные, ни ключи не попадают в ответ.

## Open questions

- <REPLACE-ME: что ещё не решено — например, недостающий класс обращений.>
- <REPLACE-ME: что делать, если инструмент недоступен.>
