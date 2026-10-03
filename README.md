<div align="center">

<img src="./assets/readme/hero.svg" width="100%"
     alt="you should know, an omp extension. The card in the image says: Heads up · two payment tests were skipped because DATABASE_URL is not set, so the transaction logic is not verified.">

<p>
<img src="https://img.shields.io/badge/typescript-1E1E22?style=flat-square" alt="TypeScript">
<img src="https://img.shields.io/badge/omp_18.4-1E1E22?style=flat-square" alt="Tested on omp 18.4.9">
<img src="https://img.shields.io/badge/0_runtime_deps-1E1E22?style=flat-square" alt="No runtime dependencies">
<img src="https://img.shields.io/badge/23_tests-1E1E22?style=flat-square" alt="23 tests">
<a href="#install"><img src="https://img.shields.io/badge/install-F97316?style=flat-square&labelColor=1E1E22" alt="Install"></a>
</p>

</div>

This omp extension adds a second, cheaper model that reads your session. After
every sixth step, the model looks for one thing that you must know and probably
do not know. Usually it finds nothing, and nothing shows. If it finds something,
one card shows above your prompt.

The extension copies the *You should know* plugin from Claude Code.

## look

<img src="./assets/readme/card-heads-up.png" width="100%"
     alt="omp in a shop API project. The agent counted 41207 order notes, ran migration 0042 on staging, and said that the migration dropped three unused columns. The card says: Heads up · Migration 0042 drops orders.customer_note, which still holds notes on 41,207 orders, and nothing backs them up before it ships. 1: Learn more, 2: Knew this already, 0: Dismiss.">

In this session, the agent counted the notes. Then it ran the migration and said
that the work was complete. The card has the same layout as the Claude Code
card: a lavender `✦`, a dim tag, the text, and the choices below the text. The
tag is always `Heads up` or `You should know`.

The model writes the explanation in the same reply as the card. Thus, `1` shows
the explanation immediately. The explanation has a maximum of 100 words, for a
person who did not follow the session. Bold words show in lavender.

<img src="./assets/readme/explanation.png" width="100%"
     alt="The open explanation for: Heads up · Checkout now retries a timed-out Stripe charge up to 3 times, but the retries carry no idempotency key. Title: A retry can charge a card twice. A short description, a two-line sketch of a charge that times out while Stripe completes it and the retry charges again, a before and now pair, and a last line that says to send an idempotency key before this ships. Choices: 1: Understood, 2: Chat in main session, 0: Dismiss.">

`2` copies the card and its explanation into your prompt box as a quote. Below
the quote is an empty line for your question. The main agent gets nothing until
you send the prompt.

<img src="./assets/readme/chat-in-main.png" width="100%"
     alt="The omp prompt box after 2. It starts with: Here is a note offered by a side agent, and then the card and its explanation as a quote.">

The model uses `Heads up` for something that occurs now. It uses `You should
know` for how a part of the system works, when the work depends on that part:

<img src="./assets/readme/card-you-should-know.png" width="100%"
     alt="A benchmark shows that product listing latency fell from 312 ms to 9 ms after the agent added a cache. The card says: You should know · Listings are now cached per region for 10 minutes, so a price edit reaches shoppers only when that region's copy expires.">

<sub>These sessions are staged. A scripted model operated omp in a sample
project, so the text is not from a real session. The screens are real omp
output, captured from a terminal.</sub>

Three more keys write the explanation again. The card does not show these keys:

- `3` uses simpler words.
- `4` keeps only the main point.
- `5` adds the real files and settings.

While the model writes, the card shows `✦ One moment…` with the omp shimmer. If
the model cannot write the first explanation, the card shows one line:

```console
✦ Couldn’t write that explanation · 0: OK
```

## install

```bash
omp plugin install github:ubranch/omp-you-should-know
```

Then, in omp:

```text
/ysk          on or off, and the side model
/ysk check    check now, not at the next sixth step
```

The side model is your `smol` role. If `modelRoles.smol` is not set, omp selects
a fast model from the providers that you are logged in to. To select a model,
set it in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  smol: <provider>/<model>
```

## how it works

1. After steps 6, 12, 18, and so on, the extension sends the session to the
   `smol` model. The transcript has your first request and the newest steps,
   tool calls, and results. It starts at the last compaction and has a maximum
   of 48,000 characters.
2. The model replies `learn: none`, or it gives a tag, one or two sentences of
   approximately 20 words, and an explanation. Most checks end with `none`.
3. The sentence becomes the card. The card does not start an agent turn and
   does not write to the session.
4. The extension keeps each shown topic for three days. The model gets this
   list, and the extension drops a new card that has the same topic.
5. Two of your prompts clear an unanswered card. Slash commands and `!` shell
   lines do not count. An open explanation stays until you close it.
6. If your prompts clear three cards in a row, the extension skips the next
   automatic check. Each next card that your prompts clear doubles the skip, to
   a maximum of 16 checks. An answer to a card stops the skips. `/ysk check`
   always runs.
7. `Knew this already`, `Understood`, and `Chat in main session` record the
   topic as known. The extension keeps the last 50 known topics, with no time
   limit. The model gets this list, and the extension drops these topics.

## keys

Digits go to the card only when the prompt box has focus, the prompt box is
empty, and no dialog is open. Thus, typed text and approval prompts keep their
keys.

| card | keys |
| :-- | :-- |
| card | `1` learn more · `2` knew this already · `0` dismiss |
| one moment… | `0` cancel |
| explanation | `1` understood · `2` chat in main session · `0` dismiss · not shown: `3` simpler · `4` shorter · `5` more detail |
| couldn’t write | `0` ok |

## reference

<details>
<summary><b>commands, environment, files</b></summary>

<br>

| Command | What it does |
| :-- | :-- |
| `/ysk` | Shows on or off, the side model, the current card, and the checks that it will skip |
| `/ysk check` | Runs a check now. It tells you if it finds nothing |
| `/ysk on` · `/ysk off` | Turns checks on or off. The setting stays for all sessions |
| `/ysk 1` … `/ysk 5` · `/ysk 0` | Selects a card choice. Use it when the prompt box has text |

| Variable | Meaning |
| :-- | :-- |
| `OMP_YSK_DEBUG=1` | Automatic checks also tell you when they find nothing or when they skip |

| File | Holds |
| :-- | :-- |
| `~/.omp/agent/you-should-know.json` | On or off, the topics from the last three days, the known topics, and the count of ignored cards |

The extension logs each failed side request. omp sends a request again after a
server error. A request fails if it gets no reply in 90 seconds. An automatic
check shows its error one time in each session. `/ysk check` shows all errors.
If the first explanation fails, the card shows the one line above. If a rewrite
fails, omp shows the error, and the card keeps the current explanation.

</details>

## why

Claude Code 2.1.287 added a built-in plugin, *You should know*. It is a second
agent that watches a long task and tells you about things that you possibly did
not see. omp has an advisor, but the advisor reviews the work of the agent and
talks to the agent, not to you.

This extension adds the same behaviour to omp. It has the same six-step
interval, the same card and choices, and the same word limits: 100, 45, and 160.
Claude Code is not open source, so the prompts here are new text. Only the fixed
text on the card (tags, choices, and status lines) is the same as in Claude Code.

## limits

- The extension works only in the interactive TUI and only for the main agent.
  It does not watch subagents.
- When a card shows, a digit that you type first into an empty prompt goes to
  the card. Close the card first, or start the message with a different
  character.
- Each check is one `smol` call with a maximum of 48,000 characters of
  transcript, approximately 12k tokens. Each explanation is one more call.
- The side model can be wrong. A card is a reason to examine the work. It is not
  a decision.

## development

```bash
bun install
bun test
bun x tsc --noEmit
omp --extension=./src/index.ts
```

Keep the `=`. omp 18.4.9 reads `-e ./src/index.ts` as a chat message.
`src/core.ts` has the testable logic, `src/prompts.ts` has the two prompts, and
`src/index.ts` connects the extension to omp.
