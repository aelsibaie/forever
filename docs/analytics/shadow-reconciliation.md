# Shadow Priest: reconciling the value of hit

The updated primary simulator is WoWSims `20277619eb440205122d174e749080c280075edd`, with game build 1.60.1.70658 and hotfix 113378. The published race report used `5a407cfbb7924f8e03ce732437b6d61ac1ded8bb`, build 1.60.1.70630 and hotfix 113205. This investigation runs focused controls, not the full race matrix. Its [derived evidence](shadow-reconciliation-2026-10-28.json) retains engine, input, output and source hashes.

## What changes the ordering

The value of Dwarf's hit depends on what a miss costs. WoWSims rolls Mind Flay's application once. A failed application produces no channel, so the next action can follow the ordinary global cooldown. A successful channel occupies its full duration. More hit therefore buys damage and also commits more time to successful channels.

A fixed-time calculation that applies hit chance to a full channel's damage gives hit more value. The diagnostic reserves the full channel duration only after a failed Mind Flay application. It changes no damage, racial, item, talent or landed-channel handling. This counterfactual is built through a Go overlay; the primary simulator source stays untouched.

At 180 seconds, with full support and 20,000 independent confirmation iterations per case:

| Actual equipment                                                 | Native WoWSims        | Full channel time reserved after misses |
| ---------------------------------------------------------------- | --------------------- | --------------------------------------- |
| Current developer Shadow set                                     | Human leads by 0.051% | Dwarf leads by 0.098%                   |
| Published pre-raid set, using its compatible ranked alternatives | Human leads by 0.086% | Dwarf leads by 0.102%                   |

The approximate paired 95% half-widths are 0.021 to 0.022 percentage points. These are individual diagnostic intervals, without a simultaneous guarantee across all experiments. Both native leads are below the study's 0.2% practical threshold.

On the developer set, an extra percentage point of hit adds 0.762% DPS in the native full rotation, while an extra percentage point of crit adds 0.791%. Reserving the lost channel time changes those values to 0.905% and 0.788%. The same change reverses the racial ordering on the published set. These stat controls use the native rating conversions, checked against native character stats.

An isolated Mind Flay rotation makes the mechanism easier to see. Its extra percentage point of hit adds 0.577% DPS natively and 1.084% with fixed channel occupancy. Crit adds approximately 0.85% in both. Extra MP5 excludes mana exhaustion from this isolated diagnostic; it is not a proposed gear set.

For a channel with hit probability `h`, duration `T` and miss penalty `G`, the simple long-run damage rate is proportional to `h / (h*T + (1-h)*G)`. A fixed-time model instead uses `h / T`. At roughly 90% hit and `G = T/2`, the first has about half the hit sensitivity of the second. This formula illustrates the isolated mechanism; it does not replace the full simulator.

A single-iteration trace also records the missed channel and the next cast in each model; both start from the same events before the miss. The exact log lines are retained in the evidence JSON.

Two independent seeds were used for the pilot and developer confirmation. The published set uses a third seed. The final controls prove that every individual iteration is identical between native and counterfactual engines when no channels miss. Both gear replications have zero sampled OOM time in the relevant cases.

## What this establishes about Finsemble

[Finsemble's Shadow method](https://finsembleforever.com/lab/shadow-priest) describes expected-hit damage and gives median racial values of 1.04% for Dwarf and 0.87% for Human. Its published JSON records aggregate rankings, racial values and fight-length shares. The delivered page exposes no executable calculator or individual scenario replay, and a public code search found no matching source. Original captures stay in the separate source library, with their source type and hashes preserved.

Its reported hit value is consistent with a fixed-time expected-hit treatment. The native controls demonstrate that this scheduling assumption is sufficient to turn a small Human lead into a small Dwarf lead, even with uncapped hit and identical equipment. A hit-cap explanation alone was inadequate.

The exact implementation attribution remains an inference. The available material does not prove that Finsemble fails to recover missed channels, and it does not permit reproducing its 10,000 scenario draws or exact 50.66% Dwarf share. That share also depends on scenario weights, fight lengths, gear stats and other model choices. Agreement between WoWSims and Gunba never established agreement with Finsemble's separate calculator.

Keep WoWSims as the primary engine. For the tested setups, report Human and Dwarf as close choices. The evidence does not justify changing the primary simulator to make it agree with a published winner, or treating either small lead as a universal race recommendation. In-game evidence for failed-channel timing would test the assumption directly.

## Upstream changes and rerun readiness

The upstream merge includes the live-only item and spell-data update, replacement developer gear, Hunter weaving and ammo changes, Mage default party support, Warlock rotation changes and melee avoidance/crit-cap work. Orc Blood Fury now has a two-minute cooldown, Troll Berserking lasts 15 seconds and Undead Touch of the Grave has a 15-second internal cooldown. The prior dated scenario already overlaid those three racial adjustments; they must not be counted twice as a new result. Future runs use the updated upstream model directly.

All 42 exported presets and 277 legal race/build cases pass native metadata preparation. This is schema and metadata coverage, including presets with existing eligibility caveats; it is not a new DPS ranking or runtime proof for every rotation.

The refreshed published catalogue contains 162 accepted sets and 93 rejected source combinations. Some melee and Hunter mappings have no compatible published set after the live-data cleanup. They are named in the evidence JSON. Developer runs are prepared; a complete published-pool rerun is blocked on compatible human-published candidates for those mappings. The workflow checks this before starting DPS simulations, rather than silently omitting them or retaining unavailable items.

## Repeat the checks

After merging upstream, generate matching protocols and constants. On Windows, include Go and the local `protoc-gen-go` directory on PATH. Refresh the source catalogue against the current database before a robustness run.

```sh
node tools/dps-experiments/prepare.mjs
node tools/dps-experiments/gear_catalog.mjs --archive /path/to/wowkb/source-archive/NEW --out docs/analytics/race-gear-catalog.json --compact
node tools/dps-experiments/readiness.mjs --out tmp/readiness/NEW --gear-catalog docs/analytics/race-gear-catalog.json
node tools/dps-experiments/reconcile_shadow.mjs --input /path/to/saved/shadow-request.json --out tmp/reconciliation/NEW --iterations 20000 --seed 2026102801
```

The reconciliation tool uses the current developer equipment by default. For a sourced alternative, supply `--equipment equipment.json`, containing its native `items` array. The exact equipment hash is recorded. Use a new output directory and a disjoint seed for an independent confirmation. Full requests, native results, stats, binary hashes and the overlay remain in the output directory.

`workflow.mjs` runs the native readiness check before its DPS stages. With `--robustness`, it also requires fresh equipment metadata and complete published-pool coverage. A source refresh runs before that check when requested. The developer-only workflow can run while published coverage is incomplete. No full study or public report is replaced by these diagnostics.

## Validation

The full native simulator and generator suites, Go vet, all 4,186 UI tests, TypeScript, JS/CSS lint, locale and skill checks, Storybook, UI/workers and WASM builds pass. All 38 Node and 10 Python analytics tests pass. The full workflow was exercised with incomplete published coverage and stopped at readiness before every DPS stage.

The extra spell-hover tool suite retains three upstream Windows path/buffer failures in unchanged code. A local game-files SQL database is absent, so its independent regeneration check was unavailable; regeneration from the committed store capture is covered by the passing database suite. These limitations are separate from the native simulator tests and diagnostic controls.
