# Demo: the AHDE loop on a real model, end to end

One coding agent (no Builder Pi, no shims) driving `skills/ahde/SKILL.md` against a
real OpenRouter model, from a deliberately weakened harness to a promoted,
sealed-gated `v0.1.0`. Every number below is copied from a run artifact.

- Agent under improvement: `ombudsman` — first line of a bank's ombudsman service, Russian.
- Target model: `openrouter/qwen/qwen3.5-9b` (thinking `low`); judge `openrouter/z-ai/glm-5.3`.
- Working copy: a scratch git repo beside this worktree; nothing here was run
  against the committed `targets/ombudsman/`.
- CLI: `ahde` = `node <worktree>/dist/cli.js`, built from this branch before the run.
- **Total model spend: $0.1885** (444 run artifacts, summed from `costUsd` in
  `runs/run_*/run.json`).

## 0. The fake order, and the weakening

The harness was copied out of `targets/ombudsman/` and then made worse on purpose,
so the fix had to be rediscovered from evidence rather than remembered:

- `AGENTS.md` replaced by three lines: *"Ты — агент службы омбудсмена банка. Отвечай кратко по-русски."*
- `skills/check-dbo/` deleted, and the `skills:` entry removed from `manifest.yaml`.
- `bin/check_dbo`, `evals/`, the model block and the judge block kept as they were.

From that point on, the original `AGENTS.md` and `skills/` were never read — not
from the worktree, not from git. The fix below was authored from `spec.md`, the
diagnosis, the graders, and raw development traces only.

```
$ git init -b main && git add -A && git commit    # cd5333a  v0 weak harness
```

## 1. Spec

`spec.md` written with the headings the reader recognizes (Purpose, Users, Jobs,
Inputs, Allowed actions, Success criteria, Constraints, Open questions), its five
success criteria written to line up 1:1 with the graders in `evals/`.

```
$ ahde spec approve --target .
spec-98eb4c441bb1cfc16a4a1872c982b9a70e504a9f25e0be8e5871d32a08778ce9  approved
title         Ombudsman Agent — spec
contract      5 success criterion(s) · 4 constraint(s) · 2 open question(s)
receipt       spec-approval-9aa931b7ccc3060615b549f988d7cf5a7297e11b62f0f55212f7b99ba2b206cd
```

```
$ ahde validate --target .
target ombudsman: structurally valid
  model: openrouter/qwen/qwen3.5-9b (thinking: low)
  key OPENROUTER_API_KEY: …<redacted> (len 73) from shell
  tasks: 30 (d4d2f3c598a3…)
  suite: ombudsman-suite (515dfcfbd20c…)
  skills: (none)
  git: 484542ed | pi: 0.84.3@5cd6a2a5
  ahde: 0.1.0@275b2dcb5bf3…
  readiness: ready to run (credential present; provider access unverified)
```

## 2. Corpora

`docs/examples/ombudsman-holdout.jsonl` is 15 lines — at the ≥15 threshold, so the
sealed exam was imported and the ship gate is powered.

```
$ ahde corpus import --project ombudsman --visibility development --name "ombudsman dev" --file evals/development.jsonl
corpus-9925b5251285b49414524abf220cd834db668fb569caf8376d6df018fc90e4f7  development  30 tasks  sha256:d4d2f3c598a3f7ec31fec17bf9329d131c6832a60e3159c382f4503be7b1eca3

$ ahde corpus import --project ombudsman --visibility sealed --name "ombudsman exam" --file <worktree>/docs/examples/ombudsman-holdout.jsonl
corpus-4cdbd52fe24d33d84ce249312315a709f81877e549ff9f084a998fc23d7185e0  sealed  15 tasks  sha256:6cf655da4f10d0ab777bfe3b2696d70b39d1533161860d2ec5b0d50dc8bbe724
```

No sealed case was read, listed, or opened at any point.

## 3. Baseline

Four baseline runs happened. Only the fourth is the evidence the proposal is bound
to; the first three are logged here because the skill says crashes and dead ends
stay in the record.

```
$ ahde run --target . --label baseline --repetitions 2 --jobs 4    # exit 2
eval run erun_mthsj71igouoey: 25/60 all-pass (34 fail, 1 error)
```
Inconclusive: one run ended with `agent run produced no assistant text`, and
`ahde diagnose` refused the gate — `proposal gate: blocked; mode suggestions are
diagnostic guidance only`. Rerun.

```
$ ahde run --target . --label baseline --repetitions 2 --jobs 4    # exit 1
eval run erun_mthsqt6rjitkgl: 27/60 all-pass (33 fail, 0 error)
```
Conclusive, but unusable — see CAVEAT 1: the revision was recorded dirty and
`ahde propose` died on it.

```
$ ahde run --target . --label baseline --repetitions 2 --jobs 4    # exit 1
eval run erun_mthsz1ymefxjn0: 33/60 all-pass (27 fail, 0 error)
```
Clean revision this time, but `ahde propose` then discovered that the branch carried
the engine's own `.ahde/` store — see CAVEAT 2.

```
$ ahde run --target . --label baseline --repetitions 2 --jobs 4    # exit 1
eval run erun_mtht4wvdm7jns0: 25/60 all-pass (35 fail, 0 error)
```
**This is the baseline of record**, at revision `4d533f0703`, tree clean, 0 errors.

Four identical A-arm runs of the same revision scored 25, 27, 33, 25 out of 60
(41.7%, 45.0%, 55.0%, 41.7%). That spread is the reason the calibration below matters.

### Diagnosis

```
$ ahde diagnose erun_mtht4wvdm7jns0
diagnosis diagnosis-7048254cfcb9d0b970f6: actionable — 40 issue(s), 0 infrastructure error(s)
25/60 passed. Found 19 diagnosed failure mode(s); 5 repeat across tasks.
proposal gate: eligible for exact human review
  major    systemic   Required tool check failed across tasks — 12/30 task(s), medium evidence, propose-harness-change
    failure-mode-0c69a077ffac7c0766626831
  major    systemic   Output contract check failed across tasks — 5/30 task(s), medium evidence, propose-harness-change
    failure-mode-15382c324516e70cf06b55ba
  major    systemic   Output contract check failed across tasks — 3/30 task(s), medium evidence, propose-harness-change
    failure-mode-2eccc36a083a2654ee34147d
  major    systemic   Output contract check failed across tasks — 3/30 task(s), medium evidence, propose-harness-change
    failure-mode-e6fbbb38fe445ec5425474d4
  major    systemic   Output contract check failed across tasks — 2/30 task(s), medium evidence, propose-harness-change
    failure-mode-bb14010f09fefc5579ecdade
```

Five systemic modes, all deterministic-grader misses. The drill-down named the
predicates: `never called bash with args containing "check_dbo"`, and
`output does not contain "жалоба" / "вопрос" / "заявление" / "благодарность" / "ограничен"`.

### What the raw traces showed

Reading whole development traces from `runs/<run>/session.jsonl` — not summaries —
turned those predicates into a cause:

- **task_010** (`третий день не могу войти в интернет-банк, договор №15`): no tool call at
  all. The agent wrote a polite intake letter asking the client for contact details.
- **task_021** (`проверь договор №51 и лимиты на переводы`): the agent *did* reach for
  `bash`, ran `ls -la`, saw a `bin` directory, did not open it, and then answered
  *«У меня нет доступа к реальной банковской базе данных…»*.
- **task_002** (`классифицируй — жалоба на списание денежных средств`): answered
  *«Нужен текст обращения для классификации»* — it asked instead of answering.
- **task_013 / task_019**: fluent, on-topic answers that simply never contain the
  classification word the grader looks for.
- **task_017**: Chinese characters and English fragments leaking into the Russian
  answer (`填写`, `всёould`) — the 9B model's own quality floor.

So: the tool was invisible (nothing named it), and the output contract was unstated.

## 4. One fix

`git checkout -b work/call-tool-first`, one file changed: `AGENTS.md`, 59 insertions.

Three rules, in the order the traces demanded:
1. `bin/check_dbo` *is* the bank's ДБО system, it sits in the working directory,
   and when the обращение carries a `№N` the literal `bash bin/check_dbo --client N`
   runs **before** the answer — no `ls`, no "I have no access to the database".
2. The answer's first line is the literal template `Тип обращения: <слово>`, with a
   closed five-word list in the nominative; when a contract was checked, the second
   line carries `Договор №N, ограничения ДБО: <вывод>`.
3. One message, no clarifying questions, Russian only.

```
$ ahde propose --target . --spec spec-98eb4c441bb1… --branch work/call-tool-first \
    --eval erun_mtht4wvdm7jns0 --mode failure-mode-0c69a077…,failure-mode-15382c32…,failure-mode-2eccc36a…,failure-mode-e6fbbb38…,failure-mode-bb14010f… \
    --summary "AGENTS.md: вызывать bin/check_dbo при наличии №N и называть тип обращения первой строкой"
builder run   builder-92dc0a22-d8c9-413f-9b12-0561462d13df
base          4d533f0703982a5d63ac6a5ebc1728c94da11338
branch        work/call-tool-first (b24d51364934730620598e38b7b027b1f2bbae60)
changed       AGENTS.md
evidence      erun_mtht4wvdm7jns0
applied       no — `ahde propose` never touches a branch or a checkout

$ ahde apply --target . --builder-run builder-92dc0a22-d8c9-413f-9b12-0561462d13df
branch        candidate/builder-92dc0a22-d8c9-413f-9b12-0561462d13df
candidate     5a48ce5ff53d2ec0739a485df7cdfdbcaf49c9fa
base          4d533f0703982a5d63ac6a5ebc1728c94da11338
proposal hash sha256:80b37395d409166d2cfa357edfab4442578757a5a971228d1ada79a5c92e387a
paths         AGENTS.md
checkout      unchanged — the candidate was committed in a private worktree
```

## 5. Screen, then verify

```
$ ahde check --target . --builder-run builder-92dc0a22-d8c9-413f-9b12-0561462d13df
screen promising · 23 previously failing cases × 1 · 22 improved · 0 unchanged · 1 regressed
screen eval run: erun_mthtb89ul0q6c0 (a screen — never a baseline, never evidence)
```

Not flat, so it earned the verification. The two verdict lines, verbatim:

```
$ ahde candidate --target . --builder-run builder-92dc0a22-d8c9-413f-9b12-0561462d13df \
    --project ombudsman --holdout-corpus corpus-4cdbd52f… --repetitions 2 --jobs 4
development verdict: improved +50.0pp (95% CI +35.0pp … +64.2pp) on 30 tasks × 2 repetitions
sealed guardrail: pass on 14 tasks × 2 repetitions — no regression: 95% CI +37.5pp … +73.2pp is not entirely below zero on 14 tasks × 2 repetitions
```

```
candidate eval run: erun_mthtdbgxb4s6qm (baseline: erun_mtht4wvdm7jns0)
design: sha256:8152bead9e4967df6e10f3df83f2b3362c9c1a712a1c65e2cfc91aae45c62b8c
candidate record: candidate-7a4bfa29-7ed4-4116-af10-dfb0ced3f475
sealed holdout: erun_mthtfalmrtdr28 → erun_mthtgjpf8ukjjz
```

### Is +50pp bigger than the noise?

```
$ ahde calibrate --target . --repetitions 2
Noise calibration A/A inconclusive · revision 4d533f0703
Design 30 cases × 2 repetitions · same revision on both arms · baseline 42%
Spread ±9.6pp (95% CI -9.2 pts … +10 pts) · flip 33%
Recommended 5 repetitions per run to keep noise under 10 points
calibration record: candidate-622f9c67-885e-41f7-82ae-0c252dc4706f
```

The A/A band is ±9.6pp. The candidate's lower confidence bound is +35.0pp — three
and a half noise bands clear. The engine's own advice (5 repetitions) is *not*
satisfied by this run: at 2 repetitions the per-task flip rate is 33%, which is why
the per-task table in `ahde candidate` is treated as flags for review and the
verdict is taken only from the paired interval.

## 6. Transcripts

The number is not believed until someone reads transcripts. Two, from the candidate
eval run:

- **Improved — task_021** (`проверь договор №51 и лимиты на переводы`): the agent now
  calls `bash bin/check_dbo --client 51` before writing anything, gets
  `dbo_limits: none`, and answers `Тип обращения: вопрос` / `Договор №51, ограничения
  ДБО: нет` — the exact detour into *«у меня нет доступа к банковской базе»* is gone.
- **Not improved — task_029** (`вопрос о графике платежей по кредиту`, 100% → 50%): on
  one of two repetitions the agent latched onto the new "no contract number → don't
  call the tool" branch and replied *«Текст обращения не содержит номера договора…
  пожалуйста, уточните»* — dropping the `Тип обращения:` line entirely, i.e. the
  no-clarifying-questions constraint is the weak seam in the new instructions.

## 7. Ship

```
$ ahde review --candidate candidate-7a4bfa29-7ed4-4116-af10-dfb0ced3f475 --recommend promote --reason "…"
reviewed candidate candidate-7a4bfa29-7ed4-4116-af10-dfb0ced3f475: promote

$ ahde promote --target . --candidate candidate-7a4bfa29-… --to 0.1.0 --reason "…"
promoted candidate candidate-7a4bfa29-7ed4-4116-af10-dfb0ced3f475: tag v0.1.0 at 5a48ce5ff53d2ec0739a485df7cdfdbcaf49c9fa

$ ahde adopt --target . --candidate candidate-7a4bfa29-…
adopted main: 4d533f0703982a5d63ac6a5ebc1728c94da11338 → 5a48ce5ff53d2ec0739a485df7cdfdbcaf49c9fa (v0.1.0)
changed       AGENTS.md
receipt       target-adoption-receipt-ba3648dcc122e326d71ef3225d7bbf5ed8ad803a5fa3b680f359945b5262b5ad

$ ahde passport --target . --out passport-v0.1.0.md
passport written to …/passport-v0.1.0.md
```

The diff was shown before `ahde review` was called, since `review` records the
recommendation on its first call and prints no diff of its own.

## attempts.tsv

```
branch	builder_run	screen	dev	sealed	cost_usd	status	description
work/call-tool-first	builder-92dc0a22	22/23	improved +50.0pp	pass 14x2	0.16	keep	AGENTS.md: call bin/check_dbo first when a contract number appears; first line names the request type
```

One attempt, one keep. No discards: the screen was promising on the first author,
so no second change was needed and nothing had to be reverted.

## The passport, verbatim

```markdown
# Version passport — ombudsman v0.1.0

- agent: ombudsman
- version: v0.1.0
- date: 2026-08-31
- revision: 4d533f0703 → 5a48ce5ff5
- model: openrouter/qwen/qwen3.5-9b

## Promised — spec-98eb4c441bb1…

*Ombudsman Agent — spec*

Success criteria
- Ответ называет тип обращения словом «жалоба», «вопрос», «заявление», «предложение» или «благодарность» и это слово стоит в начале ответа.
- Если в обращении есть номер договора №N, агент вызывает bash с `check_dbo` до того, как ответить.
- Для обращений о договоре ответ содержит слово «договор» или «ограничен» (ограничения ДБО названы явно).
- Ответ по существу раскрывает тему обращения, а не только называет его тип.
- Ответ написан по-русски и умещается в одно сообщение.

Constraints
- Только русский язык в ответе клиенту.
- Одно сообщение на обращение, без уточняющих вопросов к клиенту.
- Ограничения ДБО берутся только из вывода `bin/check_dbo`, не выдумываются.
- Ни персональные данные, ни ключи не попадают в ответ.

## Measured

- development: **improved** — pass rate 41.7% → 98.3% · mean score 0.48 → 0.98 (+50.0pp, 95% CI +35.0pp … +64.2pp) on 30 tasks × 2 repetitions
- sealed guardrail: **pass** on 14 tasks × 2 repetitions
- per answer, candidate over baseline: cost ×0.72 · latency ×0.42 · tokens ×0.72

## Judge

judge not calibrated — this judge has no human labels; run `ahde label <evalRunId> --target <dir>`

## Known limits

- improved: failure-mode-2eccc36a083a… (output-contract) — failure rate 50% → 10%
- calibrated noise band: 95% CI -9.2pp … +10.0pp from an A/A run of 4d533f0703 on 30 tasks × 2 repetitions
- data: development evidence (no published corpus, 30 cases); sealed exam (14 cases)

## Provenance

- spec: spec-98eb4c441bb1…
- proposal: sha256:80b37395d409…
- gate policies: development-ci-v4, sealed-guardrail-v4
- eval runs: development erun_mtht4wvdm7jns0 → erun_mthtdbgxb4s6qm; sealed erun_mthtfalmrtdr28 → erun_mthtgjpf8ukjjz
- applied by: local-user — Applied at the terminal by the operator running `ahde apply`.
- candidate record: candidate-7a4bfa29-7ed4-4116-af10-dfb0ced3f475
```

## CAVEATS

Everything below is a deviation from the skill, an engine rough edge, or a limit on
what the numbers above can carry.

**0. `targets/ombudsman/` is not committed anywhere.** The order said to copy the
*committed* harness from `<worktree>/targets/ombudsman/`; that path does not exist on
this branch, and `git log --all -- 'targets/ombudsman/*'` returns nothing on any
branch. The directory exists only as an untracked working-tree folder in the
operator's main checkout, so the copy was taken from there (read-only; nothing was
written to it). Only `docs/examples/ombudsman-holdout.jsonl` is under version control.

**1. `ahde propose` dies on a dirty baseline revision with a raw git error.**
The second baseline recorded its revision as
`484542ed9b44fd5d52d42692fcea33bc80d012e5-dirty-45d90abb4ce4`, and `propose` then
tried to `rev-parse` that string literally:

```
error: git rev-parse --verify 484542ed9b44fd5d52d42692fcea33bc80d012e5-dirty-45d90abb4ce4^{commit} failed: fatal: Needed a single revision
```

The skill does warn that "a dirty revision cannot seed a proposal", so the
*behaviour* is intended; the *message* is not — it names a git plumbing failure
instead of saying "the baseline was run on a dirty tree, re-run it clean".
Workaround: commit everything, re-run the baseline, propose against the new run.

**2. The engine's own store lives inside the target, is not git-ignored, and holds
the sealed corpus.** `ahde corpus import` writes to `<target>/.ahde/projects/<id>/corpora/…`
(and spec approvals to `<target>/.ahde/projects/<id>/specs/…`). Neither
`templates/basic-agent/` nor `targets/ombudsman/` ships a `.gitignore`, so a routine
`git add -A` on the work branch swept the **sealed exam's `corpus.jsonl`** into a
commit. `ahde propose` caught it — correctly, and by name:

```
error: branch work/call-tool-first did not produce a proposal (failed): branch change is outside the allowed harness scope: .ahde/projects/ombudsman-demo/corpora/corpus-70bb00e3…/corpus.jsonl (allowed: AGENTS.md, manifest.yaml, skills/**, bin/**, tools/**, data/**)
```

— but only after the sealed content was already in a git object, and the subsequent
`git checkout main` deleted `.ahde/` from the working tree, which silently emptied
the corpus registry (`ahde corpus list` → `no corpora`) and lost the recorded spec
approval until the directory was restored. Recovery: restore `.ahde/`, add `.ahde/`
to `.gitignore`, delete and re-cut the branch, re-baseline. **Suggested fix: ship a
`.gitignore` with `.ahde/`, `runs/`, `imports/` in `ahde init` and in every template**
— `templates/support-agent/` in this commit does exactly that.

**3. `ahde corpus import --project <id>` accepts a project id the rest of the flow
will later reject.** The corpora were first imported under `--project ombudsman-demo`
as instructed. `ahde candidate` refused, because a builder run's project is the
manifest's `id`:

```
error: builder run builder-92dc0a22-d8c9-413f-9b12-0561462d13df belongs to project ombudsman
```

Deviation from the order: both corpora were re-imported under `--project ombudsman`,
which is why the corpus ids in this log are `corpus-9925b525…` / `corpus-4cdbd52f…`
and not the ids the first import printed. `corpus import` could validate the project
against the target's manifest at import time instead.

**4. `ahde candidate` refuses `--development-corpus` for a builder run.**

```
error: candidate cannot replace the Builder's manifest development surface with a corpus
```

So the "dev + sealed corpus ids" shape in the order is not available on this path:
the development arm is fixed to `evalSuite.dataset`, and only `--holdout-corpus` is
passed. The imported development corpus is therefore registered but unused by the
verification.

**5. Flag drift between the skill's crib and the CLI.** `ahde report <erun> --target .`
→ `usage error: unknown flag --target for report` (it takes no `--target`).
`ahde calibrate … --jobs 4` → `usage error: unknown flag --jobs for calibrate` (so the
calibration alone ran at the default job count, not the `--jobs 4` the order asked
for). `ahde check` is documented as `--candidate <id>` in `ahde --help` but takes
`--builder-run <id>`, as the skill says.

**6. Judge cost is not in the artifacts.** The $0.1885 total is the sum of `costUsd`
over `runs/run_*/run.json`, which covers Target calls only. The judge
(`z-ai/glm-5.3`, 2 judge cases × repetitions) writes no cost field anywhere under
`runs/`, and its `spec.cost` in the manifest is zeroed, so its spend is unmeasured —
small, but genuinely unknown rather than zero.

**7. The engine gap the skill lists as open is closed in this build.** `ahde passport`
exists and produced the passport above directly; `node scripts/skill-shim-log.mjs`
was not needed. `ahde review` still records on the first call with no
`--proposal-hash`, so the diff was shown by hand, as the skill instructs.

**8. Statistical honesty.** 2 repetitions is below the 5 that `ahde calibrate`
recommends for this revision, and the sealed design is 14 tasks × 2 — the guardrail
is a no-regression test, not a precise estimate. The development verdict's own
95% CI (+35.0pp … +64.2pp) is the honest width. The judge is uncalibrated
(`ahde label` was never run), so the two `judge`-graded cases carry an unvalidated
grader, and the passport says so.

**9. The sealed exam was never opened.** No sealed case text, id, or per-case result
was read at any point; the only sealed facts stated here are the counts and verdicts
the CLI printed.

## Appendix — the promoted `AGENTS.md` (v0.1.0), verbatim

The whole of the change. One file, 59 insertions, no new skill directory, no
manifest edit.

```markdown
# Ombudsman Agent

Ты — первая линия службы омбудсмена банка. На каждое обращение ты отвечаешь
ОДНИМ сообщением на русском языке. Уточняющих вопросов клиенту не задавай:
отвечай по тому тексту, который уже есть в обращении.

## Шаг 1. Сначала инструмент, потом ответ

`bin/check_dbo` — это доступ к банковской системе ДБО. Он лежит рядом с тобой
в рабочем каталоге. Другого источника данных о договорах у тебя нет.

Если в обращении есть номер договора в форме «№N» (любое число), то ДО того,
как писать ответ, выполни ровно такую команду:

    bash bin/check_dbo --client N

Подставь вместо N номер из обращения. Не делай `ls`, не читай файлы, не ищи
базу — сразу вызывай `bin/check_dbo`. Его вывод (строка вида `dbo_limits: …`)
— единственный источник правды об ограничениях ДБО; не выдумывай ограничения
и не пиши, что у тебя нет доступа к банковской базе.

Если номера договора в обращении нет — инструмент не вызывай.

## Шаг 2. Формат ответа

Ответ всегда начинается с типа обращения. Первая строка — ровно такая:

    Тип обращения: <слово>

где `<слово>` — ровно одно из пяти, в именительном падеже, строчными буквами:

- `жалоба` — клиент недоволен: лишнее списание, блокировка, плохое
  обслуживание, спам, ошибка банка;
- `вопрос` — клиент спрашивает, как что-то устроено: тарифы, комиссии, сроки,
  документы, справки, начисления;
- `заявление` — клиент просит совершить действие: закрыть счёт, перевыпустить
  карту, сменить номер телефона, расторгнуть договор;
- `предложение` — клиент предлагает улучшить продукт или сервис;
- `благодарность` — клиент благодарит банк или сотрудника.

Если в обращении был номер договора, вторая строка — ровно такая:

    Договор №N, ограничения ДБО: <то, что вернул bin/check_dbo>

Слово «ограничения» должно быть в ответе всегда, когда договор проверялся —
даже если ограничений нет (тогда пиши «ограничения ДБО: нет»).

Дальше — 2–5 предложений по существу обращения: что именно сделает банк или
что делать клиенту. Никаких английских и китайских слов, только русский.

## Пример

Обращение: «жалоба — комиссию за перевод списали дважды, договор №13.»

Сначала вызов: `bash bin/check_dbo --client 13`. Затем ответ:

    Тип обращения: жалоба
    Договор №13, ограничения ДБО: нет
    Зарегистрировали вашу жалобу на двойное списание комиссии по договору №13.
    Проверим историю операций и вернём излишне удержанную сумму на счёт.
    О результате сообщим в течение пяти рабочих дней.
```
