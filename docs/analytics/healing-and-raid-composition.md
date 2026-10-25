# Healing comparisons and raid composition

This is the groundwork for the next analytics experiments. The DPS rerun stays paused. This document and [the experiment plan](experiment-plan.json) define the inputs, metrics and readiness checks; they contain no benchmark results and do not run the simulator.

Checked on 2026-10-25 against analytics commit `359c084c2696b76a906f9cdc9650fef57df80dec`, with upstream `cc61e6b628871949c33997088ac98a5f7985c2d1` in this branch. Findings below come from source inspection. Refresh them after updating upstream.

## Responsibility and current support

Upstream owns the spell, talent, item and combat models. Analytics can reuse the existing native requests, seed handling, provenance and reporting. Gear comes from maintainer presets or named class-community loadouts with recorded acquisition rules.

The upstream [Priest](https://github.com/wowsims/forever/issues/15), [Druid](https://github.com/wowsims/forever/issues/24), [Shaman](https://github.com/wowsims/forever/issues/18) and [Paladin](https://github.com/wowsims/forever/issues/9) tracking issues explicitly describe gear-planner mode with no simulated rotation. Their existence does not promise a full healer simulator or a delivery date.

There is also an open [initial healing implementation, PR #502](https://github.com/wowsims/forever/pull/502), checked on 2026-10-25 at head `5e2b947c8bfc24d16f5e6b0e9b8f1a529d95d717`. It proposes shared healing results, Priest integration and synthetic targets for 5/10/20-player groups. It explicitly excludes damage intake and overhealing modeling. It is unmerged and is not part of the analytics snapshot above; evaluate it separately before adapting a runner.

| Area                                      | Observed support                                                                                                 | What the comparison still needs                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Priest                                    | Healing spell registrations, Holy/Disc talent presets, pre-raid gear and configurable Prayer of Mending behavior | Approved healing rotation, target selection and scenario validation                        |
| Restoration Druid/Shaman and Holy Paladin | Registered agents; their UI configurations describe gear-planner mode and return empty default rotations         | Complete, validated healing behavior and usable profiles                                   |
| Core healing                              | Raw healing, shielding, health gains, mana and OOM metrics                                                       | Effective-healing and consumed-absorb attribution verified for each reporting scope        |
| Raid                                      | Parties, roster buff hooks and full-raid requests                                                                | Audited provider assignments, legal support allocation, encounter and survival constraints |

The existing `HealingModel` injects external healing for tank-survival calculations. It does not select healer spells or represent a healing team. Its configured HPS cannot establish that a candidate roster supplies that healing.

Relevant files are `ui/specs/priest/healer/{spec,presets}.ts`, the other healers' `spec.ts` files, `sim/priest/healer/healer.go`, `sim/core/{raid,health,shield,spell,spell_result,metrics_aggregator}.go` and `proto/api.proto`.

## What the example establishes

The supplied image is a presentation reference: paired HPS/EHPS bars by healer build and fight length. Its six rows include three Priest variants, so the unit of comparison is a resolved build, not just a class or a spec enum.

The original gear, rotations, incoming damage, external support and EHPS formula are unknown. Preserve labels such as Holy PoM, Holy Penance and Disc PI as unresolved references until an original build is available. Do not import the pictured numbers as evidence or reconstruct talents from the labels.

Use 60, 180 and 300 seconds to match the DPS matrix. Add an optional 360-second scenario for the image's six-minute comparison; 300 seconds is five minutes.

## Healing protocol

Keep a profile's approved gear, talents, rotation and consumables fixed across fight lengths. A separately optimized profile for each duration answers a different question and belongs in a separate report. Record race, professions, ranks, item swaps, reaction time and every external cooldown.

Compare matching documented gear tiers. A pre-raid label alone does not establish matching acquisition rules. Preserve unsupported builds in a coverage table with reasons; do not give them zero-HPS bars or silently exclude an entire class.

### Metrics

| Metric                | Definition                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Raw healing HPS       | Healing before overheal, divided by the full encounter duration                                           |
| Effective healing HPS | Health actually restored by that healer, divided by the full encounter duration                           |
| Overheal              | Raw healing minus effective healing; report its fraction of raw healing, or null when raw healing is zero |
| Applied absorb HPS    | Shield capacity applied, including capacity that expires or is replaced                                   |
| Consumed absorb HPS   | Damage actually prevented by that healer's shields                                                        |
| Effective support HPS | Effective healing plus consumed absorbs, divided by the full encounter duration                           |
| Mana                  | Gross spent, actual returns, ending mana, OOM time and time to OOM with its measurement method            |
| Survival              | Deaths, time below a defined health threshold, unhealed damage and recovery after a defined burst         |

All rates use full encounter time, including periods spent OOM. Health restored and damage prevented stay separate in the raw data. They may be combined only in the explicitly named effective-support metric.

In this snapshot, `metrics_aggregator.go` adds `TotalHealing + TotalShielding` to the native HPS metric. `spell_result.go` records the full heal before health is capped; `shield.go` records capacity when a shield is applied. Native HPS therefore cannot be relabeled EHPS.

Health resource metrics carry uncapped `gain` and capped `actual_gain`. They are a possible input for effective healing, but the exported rows do not explicitly identify the caster. Verify attribution with multiple healers using the same spell, recipient regeneration, self-healing, pets and external healing before publishing healer-level EHPS.

The native `tto` metric uses the first OOM time if OOM occurs, and extrapolates from remaining mana otherwise. An extrapolated value is not an observed event. A future event-based report should mark a fight with no observed OOM as censored.

### Scenarios

| Scenario           | What it answers                                                    | Required inputs                                                          |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Throughput ceiling | How much raw output can this build produce?                        | Unlimited missing health; explicitly synthetic and without an EHPS claim |
| Sustained tank     | Can it sustain one damaged tank?                                   | Tank health, incoming damage, mitigation and targeting                   |
| Party pulses       | How does it handle repeated damage to five players?                | Shared damage schedule, party membership, health and range               |
| Mixed raid damage  | How does it handle tank pressure and damage across twenty players? | The same roster, positioning and damage schedule for every candidate     |
| Burst recovery     | How quickly can it recover a specified health deficit?             | Spike timing/size, recovery threshold and available cooldowns            |

Damage magnitudes, frequencies and health pools remain unset in the plan. Choose them from a stated benchmark or observed encounter before running an effective-healing experiment. A synthetic benchmark must be labeled as such.

Start with one healer and controlled recipients to verify accounting. Add healing teams afterward: their effective healing overlaps, and low-demand scenarios cap everyone's output at the damage available to heal. Test steady and burst demand; a mean HPS number alone cannot establish survival.

Prayer of Mending bounces, chain-heal reach, HoT overwrites, shields, mitigation and overheal depend on the damage and target model. Count Power Infusion, Innervate and Mana Tide against actual providers and assignments. Measure the recipient's gain in the team simulation so it is credited once.

### Reports and validation

The main chart should resemble the example: paired raw/effective healing bars, one panel per duration, and a selector for encounter and gear tier. Keep consumed absorbs visible beside healing. Include mana-over-time and recovery plots when those data are available.

Each report records the Git commit and dirty state, game build/hotfixes, profile hashes, exact damage schedule, gear policy, buffs, cooldown assignments, seed/iterations and artifact hashes. Show simulation uncertainty separately from missing mechanics. Never turn an unsupported metric into zero.

Before a published run, verify a controlled overheal case, unused and consumed shields, mana accounting, target selection, same-spell caster attribution and healing conservation. Prove that changing the damage schedule changes EHPS as expected. These are future runtime checks, not checks completed by this document.

## Twenty-player raid composition

Represent twenty named player slots in four parties of five. Each slot has a build, role, gear policy, party, pet and support assignments. Encounter-specific tank requirements and the permitted healer-count range are required inputs; no universal tank/healer split is assumed.

Use three stages:

1. **Buff and utility coverage.** Validate the roster, groups and providers. Explain what each slot contributes, which effects overlap, and which required utility is missing. This can be developed before healer throughput is ready.
2. **Conditional raid DPS.** Hold tank/healer counts fixed and compare legal rosters under explicit encounter assumptions. Label survival as unvalidated when it has not been tested.
3. **Healing and survival constraints.** Simulate healing teams and tank assignments, then compare role counts. Maximize raid damage among rosters that meet the chosen survival and utility requirements.

Start from `tools/database/buffmanifest/`, generated `proto/buffs.proto`, `sim/core/buffs/` and the agents' `AddRaidBuffs`/`AddPartyBuffs` hooks. The manifest supplies fields, scopes, spells and exclusion metadata; it is not a complete provider-capacity solver.

For every effect, retain the provider player/build, spell or item ID, required talent or pet, recipient scope, range assumption, stacking rules, cooldown schedule, opportunity cost and evidence. Keep unresolved rules explicit. Audit the generated request because agents do not infer every external buff from roster membership.

The existing DPS baseline supplies an external buff package. Copying that package into a roster search would give support without proving a provider exists. Build support from the roster instead, with legal choices for blessings, auras, totem elements, curses and external cooldowns. Do not sum independently full-buffed player DPS to score a raid.

Evaluate complete roster requests. Buff interactions, target debuffs, support casting and party assignments affect the result. Mitigation can reduce the healing required; lower HPS does not automatically mean a worse raid.

Keep encounter requirements configurable: tanks, dispels, interrupts, damage schools, resistances, range and movement. A coverage requirement needs an encounter reason; collecting every possible buff is not the objective.

Use a bounded candidate search, then resimulate finalists at greater precision. Save the candidate space and stopping rule. Publish several near-best feasible rosters with uncertainty and swap costs; a heuristic search does not prove a mathematical global optimum.

## Evidence and existing projects

The local source library stays in the separate `wowkb` repository. Preserve its source ID and paragraph/timestamp locators when applying a developer statement. For example, S027's October 15 development notes describe raid-wide changes to Moonkin Aura and Leader of the Pack (paragraph-1112), Trueshot Aura (paragraph-1146), four Shaman totems (paragraph-1284), and Battle Shout (paragraph-1347). These are dated statements to reconcile with the current game build and implementation, not timeless Classic rules. [Official notes](https://us.forums.blizzard.com/en/wow/t/2360696)

The screenshot is a user reference; source inspection establishes implementation; developer publications describe intended behavior; community models and observed logs are separate evidence classes. No Discord access or collection is part of this work.

The following project pages were checked on 2026-10-25. Their claims have not been validated by running or auditing their engines.

| Project                                                                                    | Useful reference                                       | Limit                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Forever Sims healer comparison](https://foreversims.com/healer-comparison)                | Healer output across injured-target counts             | Explicitly assumes no overhealing; its homepage labels the models Alpha and uses Classic Anniversary gear                                 |
| [SixtySim methodology](https://sixtysim.com/method/)                                       | Healer scenarios and reporting structure               | Uses custom healer implementations and searched setups; states that healers heal full-health targets and several interactions are omitted |
| [RaidHype](https://raidhype.com/forever)                                                   | Ten/twenty-player grouping, buff coverage and raid DPS | Its overview describes DPS/tank sims; a roster DPS score alone does not validate healing or survival                                      |
| [WoW Forever Codex planner](https://wowforevercodex.com/tools/raid-comp?raid=hyjal-summit) | Groups, coverage display and shareable rosters         | Its published page does not establish a survival-constrained optimizer                                                                    |

Compare these tools' assumptions before reusing outputs. Reuse exported data or open code only after checking its license, version and reproducibility. Their rankings are not a replacement gear policy.

## Work to resume

The saved groundwork is the protocol, scenario catalogue, metrics contract, staged roster objective and source map.

The next implementation slice is a read-only readiness report and a roster-coverage exporter from the existing buff manifest. Then add report ingestion for validated healing results and a controlled one-healer experiment. Add team healing and composition search after those checks pass. Keep analytics under `tools/` and `reports/`; use upstream's real interfaces and add no sim/UI hooks for analytics alone.
