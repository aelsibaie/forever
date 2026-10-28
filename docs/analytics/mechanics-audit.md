# DPS race study: mechanics audit and rerun readiness

WoWSims remains the primary simulator. The updated source is `20277619eb440205122d174e749080c280075edd`, game build **1.60.1.70658**, hotfix **113378**. This pass audits all exported DPS builds and both factions. It does not replace the published 60/180/300-second study.

## What changed

- The equipment catalogue now maps the renamed Mage builds and the Rogue and Warrior defaults. All 42 exported builds have a reviewed source mapping.
- The Mutilate coverage check reads the serialized APL. TypeScript protobuf oneof wrappers hid the cast action from the old inspection. Both Mutilate builds cast and deal Mutilate damage in native execution; neither receives the old missing-action exclusion.
- The Read Leyline mana policy applies only to mana users. It adds no mana condition or cast to Warriors or Rogues. The previous policy could turn an invalid mana check into an unconditional, time-consuming cast.
- Equipment validation rejects different items from the same unique-equipped category before simulations. Published alternatives retain source order. No replacement item is invented.
- Reference controls select legal developer equipment. If the default is invalid, a supplied developer alternative can serve as the named reference; the run refuses an unsourced replacement. The report names that reference.
- Readiness exports every build, legal race, equipment tier, developer legality result, published-source gap and native request. The mechanics runner records full results, validations, owner and pet stats, spell properties and paired controls.

These are analytics changes. No ability, racial or damage formula under `sim/`, and no frontend code under `ui/`, changes in this pass.

## Native diagnostics

The final audit ran **1,939 cells across 42 builds and 277 legal race/build cases**, at 180 seconds, 128 iterations per cell, seed `7026102801`. All cells completed. The implemented automatic checks raised no flags after the fixes.

Each race/build has the developer rotation, an explicit racial policy, the same policy with unavailable references resolved from native metadata, and four synthetic stat controls. The controls add one percentage point of hit or crit, 50 points of hit, or 200 points of crit. The large additions are diagnostic inputs, not proposed equipment.

The checks verify owner stat increments, offensive racial use, owner and pet misses under high hit, observed Mutilate damage, unresolved condition fallbacks, and missing periodic critical hits where the active spell's row permits them. They cover exercised actions. They do not validate every ability, prove game behavior, measure utility, or supply new race rankings. The individual paired intervals have no simultaneous guarantee across the whole audit.

| Class or build family                  | Finding and consequence                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mage                                   | Arcane Missiles rolls damage on its missiles and retains channel time when they miss. Blizzard also retains its channel. The Shadow failed-application assumption cannot be copied onto these spells. All five renamed Mage builds have equipment-source mappings.                                                                   |
| Rogue                                  | Both Mutilate presets produce the expected damaging action. Shared talent/racial conditions remain consequential: resolving unavailable references changes some paired means by several percent, with an observed 5.8% difference for one Combat case. The full rerun must retain both rotation treatments and show the sensitivity. |
| Warlock                                | Drain Life and Drain Soul share Mind Flay's failed-application recovery pattern in the native engine. Active demon stats respond to owner hit and crit; the recorded deltas distinguish physical and spell inheritance. No universal inference follows from a pet being absent from a particular build.                              |
| Warrior                                | The mana-policy bug affected a class without mana. The native crit-cap sheet and action outcomes are preserved; this pass does not establish that every rage or avoidance rule matches the game.                                                                                                                                     |
| Hunter                                 | Five exported presets currently have no damaging pet: SV Weave, MM Weave, MM, SV and Default. BM, BM Weave and SV Melee have pet damage. These are build choices in the inputs, and matter to race value. The Raptor gains 1 point of physical hit and 2.125 points of spell hit per owner hit point in the recorded control.        |
| Shadow and Smite Priest                | The prior Human/Dwarf reversal remains reproducible as a failed-channel counterfactual. Mind Flay's native miss recovery is confirmed again. Penance retains its channel after missed bolts; the next Smite starts at 2.10 seconds in the diagnostic.                                                                                |
| Balance Druid                          | The default/pre-BiS gear equips items 272438 and 272439 together, both category 707. The native gear picker treats them as mutually exclusive. The developer P1 alternative is legal and can be the explicit reference. Hurricane retains channel occupancy when ticks miss.                                                         |
| Feral Druid                            | Developer equipment passes the checked legality rules. Resolving shared unavailable references changes some sampled means, so the original and resolved policies remain separate cases.                                                                                                                                              |
| Elemental and Enhancement Shaman       | Every legal race/build case completed the stat, racial and action checks. Published equipment coverage remains incomplete for Enhancement. Successful controls do not certify every talent or proc.                                                                                                                                  |
| Retribution and Holy Shock DPS Paladin | Every legal race/build case completed the controls. Horde's single eligible race is an eligibility result, not a competitive racial recommendation.                                                                                                                                                                                  |

Full build-level evidence, warnings, channel registrations, pet stat deltas and equipment coverage are in [the evidence JSON](mechanics-audit-2026-10-28.json). Complete requests, distributions and binaries remain locally under `tmp/mechanics-audit/release-2026-10-28/`.

## Channel timing is a class-specific modeling question

Eight isolated native probes use forced misses and ample mana. With a single spell in the priority list, failed Mind Flay, Drain Life, Drain Soul and Shadow Word: Pain are attempted again at **1.50 seconds**. Arcane Missiles repeats at **5 seconds**, Blizzard at **8 seconds**, and Hurricane at **10 seconds**. Penance uses a Smite fallback to separate channel occupancy from its cooldown; the accepted Smite begins at **2.10 seconds**. These times belong to the exact saved inputs, including reaction and channel settings.

The traces agree with the implementation: Priest periodic applications and Warlock drains only apply their dot/channel after a landed application. Arcane Missiles, Blizzard, Hurricane and Penance establish the channel and resolve damage separately. Native logs and request hashes for all eight probes are embedded in the evidence JSON.

This supports a broader audit than Shadow alone. It still does not establish how the actual game handles a failed channel.

## What remains unresolved with Finsemble

[Finsemble's Shadow page](https://finsembleforever.com/lab/shadow-priest) describes paired scenario draws evaluated with expected hit and crit values. Its public aggregate results and written method still do not expose enough information to replay individual scenarios or attribute their handling of a failed channel. I did not locate an executable calculator or those inputs in the public pages and linked data examined.

The [earlier controlled comparison](shadow-reconciliation.md) proves that reserving full channel time after a missed Mind Flay is sufficient to reverse Human and Dwarf on two equipment sets. It is not proof that Finsemble makes that assumption. Scenario weighting, target and resistance assumptions, stat distributions, hit caps and class racial policies also need to match before winner shares can be reconciled numerically. A share of scenarios won is different from a DPS advantage.

I also examined [MythicSim's open engine](https://github.com/sage3648/mythicsim-forever-engine/tree/76ef1a3663ac24c7a0b16b8886d1c54d341aa7b6). Its README describes a Rust port of a frozen Go fork with WoWSims ancestry. Its beta-log and pet-inheritance statements are author reports; the repository's simulator fixtures are not gameplay logs. This is useful implementation evidence, but does not independently decide game behavior. Public report access through [Forever Logs](https://foreverlogs.gg/reports) did not yield an identified current-build report. I could not establish the provenance of a matching raw beta log from those pages.

No raw in-game evidence settling missed Mind Flay occupancy was retrieved. WoWSims-versus-Gunba agreement, another related engine, or a spell row alone cannot fill that gap. The native 100% hit endpoint versus Finsemble's documented 99% ceiling also remains a model difference requiring game evidence.

Public originals, retrieval times, source classifications and hashes are preserved separately in the local source library under `data/community/public_theorycraft/channel-audit/2026-10-28/`. Source code, published methods and gameplay evidence remain distinct. No live Discord collection was performed.

## A decisive in-game test

Record the game build, character and target levels, spell rank, talents, gear hit/haste, buffs, latency and raw combat-log hash. Record channel start/stop events or video as well when available. Queue a normal GCD-dependent cast continuously behind Mind Flay, and retain several missed applications alongside landed controls.

For each miss, measure the first accepted following cast against both the actual GCD endpoint and the landed-channel duration. An accepted cast before the full channel endpoint disproves full-duration occupancy for that observation. A later cast alone cannot prove full-duration occupancy: player delay, latency or a different cooldown can explain it. Exclude pet events, off-GCD actions and failed cast attempts. Repeat for Drain Life and Drain Soul separately. Use a different hit-cap experiment to test the hit ceiling; do not conflate it with channel recovery.

## Equipment readiness and the next full study

The checked developer sets are legal in **82 of 84 build/faction groups**. The two exceptions are the same Balance default on both factions; a legal developer P1 alternative exists. All builds remain listed. The catalogue contains **162 accepted published candidate sets**, covering **43 of 84 groups**, plus **93 explicit rejected source combinations**. Published candidate sets are community-computed gear suggestions, not independently proven BiS.

The remaining 41 groups lack a compatible published pool. Their missing mappings are repaired; these are actual equipment-source gaps. A complete published pre-raid comparison remains blocked. Developer reference comparisons can use legal named alternatives and retain unequal-tier caveats. We should not fill the holes with invented itemization or quietly call P1 equipment pre-raid.

Before the full study, keep the original/resolved rotation distinction, developer and published equipment pools, realistic source-listed hit alternatives, independent selection/confirmation samples, and practical ties. Include class-specific uncertainty where game evidence is absent. No new universal Human/Dwarf recommendation is justified by this audit.

## Repeat this pass

From the repository root, after updating upstream and generating the matching protocols/constants:

```sh
node tools/dps-experiments/readiness.mjs --out tmp/readiness/NEW --gear-catalog docs/analytics/race-gear-catalog.json
node tools/dps-experiments/mechanics_audit.mjs --source-readiness tmp/readiness/NEW --out tmp/mechanics/NEW --iterations 128 --seed 7026102801
node tools/dps-experiments/mechanics_report.mjs tmp/mechanics/NEW tmp/mechanics-review/NEW
node tools/dps-experiments/channel_probes.mjs tmp/mechanics/NEW tmp/channel-probes/NEW
```

Refresh the gear catalogue against the updated database and source policy first. The readiness check rejects stale metadata or mappings. Use new directories so previous evidence stays intact. The mechanics runner preserves its own tooling and hashes and uses the current native engine without a spell overlay. Use disjoint seeds for a new independent confirmation; repeating the same seed is a replay.

The full workflow continues to stop before DPS when `--robustness` lacks complete published coverage. This pass deliberately leaves the full 60/180/300 run and public report unchanged.

## Validation

The native simulator, generator and analytics Go packages, Go vet, all 4,186 UI tests, TypeScript, JS/CSS lint, locales, 15 skill checks, formatting, protocol/constants generation, Storybook, UI/workers and WASM builds pass. All 41 Node analytics tests and 10 Python report tests pass. A separate Balance integration check rejects the invalid default, selects the legal developer P1 reference on both factions, passes 40 native preflight cells and 40 resolved cells, and reproduces the reference CLI iterations exactly. That check stops at preflight.

A local game-files SQL database is unavailable; regeneration from committed inputs is covered by the generator suite. The three Windows spell-hover failures recorded in the prior reconciliation are in unchanged tooling and are separate from these passing CI gates.
