# makefun-free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/yinzzhou99-web/makefun-free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/yinzzhou99-web/makefun-free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A live free-model aggregator in a single Node file. It registers with the trial env, serves OpenAI and Anthropic wires (JSON and streaming), and answers every prompt with a real completion from one of the brief's fourteen free OpenRouter models, dialled through the grader's gateway on the entrant's own key. Routing is rating-first: for each prompt, the free models meeting its requirements (tools, vision, JSON mode — from the brief's manifest, unioned with what the body declares) are ranked by the house rating and the best is dialled. A refusal fails over down that ranked list (at most four calls per prompt), the recovered refusals are reported in the `x-makefun-upstream-failures` header, and a model that refused once is demoted for the rest of the trial so a rate limit cannot cascade. Answers are buffered and rendered deterministically in the client's wire with the dialled model's id on every response and chunk, so a replayed trial repeats the live one exactly. The catalog is exactly the fourteen free ids — in the register body, in `--list` output and in both `/v1/models` shapes.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=fp85vftq&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
