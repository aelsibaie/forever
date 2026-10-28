# Race recommendations across equipment and conditions

The race study compares every exported DPS build and every legal race in each faction at 60, 180 and 300 seconds. WoWSims supplies the mechanics, item stats, talents and rotations. Developer equipment remains a separate reference pool.

A single unchanged set can waste a racial hit bonus. The study therefore reports both fixed-set results and each race's selected equipment from the same declared pool. It measures the loss from choosing a race across the tested conditions, rather than turning one preset's highest mean into a general recommendation.

## Equipment

The derived [gear catalogue](race-gear-catalog.json) contains public pre-raid lists from [WoW Forever BiS List](https://wowforeverbislist.com/), with profession gear on and off, no PvP or raid options, and both factions' variants. Dwarf-aware sets are available to every eligible race in that faction. These are community calculations, not developer endorsements or independently established BiS.

The pre-raid label follows the publisher's content filters. Source descriptions and replacements remain available for inspection; the importer does not independently establish every item's launch availability or acquisition cost.

Only equipment IDs and enchant IDs enter the native simulator. External stat lines and EP estimates do not. The importer checks the current database, class capabilities, faction restrictions, slot types, unique items, weapon pairs, enchants and profession requirements. A missing item uses the source's first compatible ranked alternative. Every replacement is recorded. A set without a compatible candidate is rejected.

The final equipment audit also checks unique-equipped categories against the native UI's exclusivity rule. Conflicting published equipment stops the study. A conflicting developer reference remains a labeled diagnostic and is excluded from recommendations; each race selects again from the valid reference sets, with fresh 20,000-iteration confirmations. The audit preserves the earlier analysis and records every affected set and replacement.

The catalogue also includes limited hit contrasts: one source-listed item changes, retaining at least 80% of that slot's published score. Reported hit selects a contrast; native stats and simulation determine its result. These combinations are experimental candidates, not new BiS claims. Synthetic HitRating changes are a separate diagnostic and never enter the realistic equipment pools.

Gunba equipment may be inspected as a separate reference. Synthetic IDs and unsupported sets are rejected; foreign stat bundles and gear-independent Tier 1 bonuses are never injected into WoWSims.

Original public JSON captures stay in the local `wowkb` source library, separate from developer publications and Discord material. The committed catalogue contains derived inputs, source URLs and content hashes.

## Rotation and mechanics checks

Every accepted set, race and support level gets a native metadata and runtime check. Positive Mutilate casts and damage establish coverage for its two developer builds; stale known-issue text alone does not exclude them.

Racial timing includes the developer policy and immediate use, with a 15-second delay also tested for Warriors. Mana-using Skyborne test plain Read Leyline below 65% mana. [The official clarification, Blizzard topic 2360696, post 8](https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-%E2%80%93-updated-october-26/2360696/8) removes Attuned and Charged on raid entry, so enhanced tag-1 casts are changed to their plain versions.

Night Elf and Dwarf Priests also test Starshards and Chastise before the native filler, conditional on higher native expected damage per execution time. Screening chooses whether to retain that policy. Native controls check both Shadow and Smite across every accepted set, support case and duration. A racial spell that never casts must leave every iteration unchanged. Reactive spells requiring incoming attacks are outside this stationary damage encounter.

Unavailable aura and spell references can make the native APL compiler drop condition branches. The study retains the original developer rotation and separately tests explicit absent-reference handling from native metadata. Target and CurrentTarget both read enemy aura metadata. Missing active auras read false, missing inactive auras read true, and missing stacks or remaining duration read zero. An unavailable numeric predicate cannot erase the other valid branches of an Or. Before/after controls and every replacement are saved. This treatment is a model sensitivity test, not evidence that an unimplemented game mechanic is absent in game.

The shared support package and self-only external support are separate cases. Consumables, talents, movement settings, pet choices and developer swap sets remain shared across the equipment contrasts. Published Hunter candidates use their native-supported source ammunition and quiver options. Matching armor/weapon sets with the developer ranged inputs remain separately labeled controls outside the published pre-raid pool. Creature-type checks use the developer set at 180 seconds; they are not complete per-boss gear searches. No raid-composition conclusion follows from this damage study.

The melee Hunter source lists use bullets and a pouch, while the native option enums list arrows and quivers. The source's first ranked ammunition alternative, Thorium Shells, is represented by the native 17.5-DPS arrow control. The crafted-container scenario uses the native 13% control. The publisher's bag records omit haste; the [Forever pouch tooltip](https://www.wowhead.com/forever/item=8218/thick-leather-ammo-pouch) independently states 13%. The equivalent native effect mapping and the developer 15% control are visible in the report. This is an effect translation, not a new item-stat bundle.

A factorial diagnostic changes ammunition DPS and container haste separately and together for every melee Hunter validation condition. The initial assumption that these inputs were irrelevant was rejected: the preset fires a pull shot, and its sampled damage changes with the ranged loadout. These synthetic controls measure sensitivity and do not enter the realistic equipment pool.

Petless Hunter presets intentionally take Lone Wolf. A separate 1,000-iteration check changes only `petType` to the developer Raptor setting, retaining talents and racial policy. It covers every legal race and all three durations with full support, original developer references, the developer equipment anchor and each race's validation-selected published set. Both pet choices get independent samples after gear selection. This tests whether the no-pet trade-off changes on pre-raid equipment; it does not optimize pet families or talents. The primary equipment study retains each named build's original pet choice.

## Sampling and interpretation

Screening uses 250 iterations per cell to choose racial timing, mana use and the optional Priest damage racial policy within each set. Separate 1,000-iteration validation samples compare those policies across sets and choose each race's equipment from the shared pool. Independent 5,000-iteration samples confirm those selections. Conditions whose race intervals straddle the 0.2% practical-loss boundary receive fresh 20,000-iteration samples for every race and equipment pool. These replace the earlier confirmation; the samples are never pooled. Every stage has a disjoint seed range.

Race comparisons use paired samples with approximate ratio intervals and a Bonferroni adjustment over all race pairs within a condition. These are per-condition intervals, not a simultaneous confidence guarantee across the entire catalogue.

Recommendation bounds also allow for uncertainty in which race is best. Each race's lower ratio bound is compared with every competitor's upper ratio bound, using the observed highest mean as their common denominator. The resulting interval envelope is conservative. The highest sampled mean alone cannot certify a race as within the practical-loss threshold.

The default report spans every accepted actual set in the selected pool, using the independent 1,000-iteration validation results. It shows the largest upper loss bound across gear, support and reference handling at that duration. A consistent choice stays within 0.2% in those tests. Otherwise, the report gives the race with the smallest worst-case bound and labels the choice setup dependent. This conservative rule can leave a close choice unresolved at the available precision.

The support selector separates the full support case from the self-only stress test. Its combined view spans both. Printable overview charts use that combined view; the individual equipment and hit charts use full support. Hunter pet and creature-type diagnostics retain their separately stated full-support conditions.

The selected-gear view uses the separate 5,000- or 20,000-iteration confirmations after each race selects equipment from the same pool. It describes that race with its selected set; it does not establish competitiveness across the other sets. Neither view claims a global optimum or assigns real-world probabilities to an unweighted scenario catalogue.

Sampling precision and confidence in game mechanics remain separate. Provisional effects, gear-source adaptations and narrow hit coverage need visible caveats. More iterations cannot establish that the engine matches level-60 combat logs.

## Refresh and run

The workflow checks native metadata and catalogue freshness before its DPS stages. A complete robustness run stops if any declared build/faction mapping has no compatible published candidate. The [Shadow reconciliation](shadow-reconciliation.md) records the current live-data cleanup and the limits of the available source lists. Refreshing upstream never makes an old catalogue valid automatically.

After updating and validating upstream on `codex/analytics`, refresh public equipment sources when needed:

```sh
node tools/dps-experiments/gear_catalog.mjs --archive /path/to/wowkb/data/community/public_gear/source-archives/RUN --out docs/analytics/race-gear-catalog.json --compact
```

Run the full analytics workflow, including the robustness study:

```sh
node tools/dps-experiments/workflow.mjs --prepared --robustness --gear-catalog docs/analytics/race-gear-catalog.json
```

Omit `--prepared` after changes to protocol or generated inputs. The normal model is upstream; `--model notes-2026-10-27` is an explicit dated scenario. Source updates, repository gates and Git commits remain separate from simulation execution. No runner creates a merge commit.

To reuse an already validated racial engine and current matching sources:

```sh
node tools/dps-experiments/robustness.mjs --source-racials SAVED/racials --gear-catalog docs/analytics/race-gear-catalog.json --out tmp/race-robustness/NEW
node tools/dps-experiments/gear_legality.mjs tmp/race-robustness/NEW
node tools/dps-experiments/robust_exports.mjs tmp/race-robustness/NEW
node tools/dps-experiments/class_racial_probe.mjs tmp/race-robustness/NEW tmp/race-robustness/NEW/class-racial-controls
node tools/dps-experiments/hunter_pet_probe.mjs tmp/race-robustness/NEW tmp/race-robustness/NEW/hunter-pet-controls
python tools/dps-experiments/verify_robustness.py tmp/race-robustness/NEW
python tools/dps-experiments/robust_report.py tmp/race-robustness/NEW
node tools/dps-experiments/verify_robust_report.mjs tmp/race-robustness/NEW
```

An interrupted identical study resumes with the same command and `--resume`. Cached results require matching engine, request and result hashes. Exact duplicate requests share results with an explicit record. A new engine or changed catalogue requires a new output directory.

Each run retains native requests, results, pre-combat stats, equipment provenance, model and source fingerprints, stage receipts, racial activation, mana waits, rotation validations and selection decisions. Website JSON examples freeze the expanded APL and preserve equipment, talents, support, encounter, iterations and seed through the public UI schema. Native controls check that freezing the APL does not change its iteration results. The archived native binary and request reproduce the recorded model; a live website may run a different engine.

To prepare a standalone verified study for the existing Pages publisher:

```sh
node tools/dps-experiments/publish_site.mjs --robustness tmp/race-robustness/NEW --out tmp/publication-NEW --id SNAPSHOT-ID --raw-base https://github.com/aelsibaie/forever/releases/download/RELEASE-TAG --make-raw
```

This command builds and checks a local publication bundle. It preserves exact native inputs and website imports, publishes compact result summaries, and packages the full study in separate raw ZIP parts below the release asset size limit. Published stats retain the numerical fields; repeated spell and aura metadata moves into a complete portable gzip output beside each stats file. The raw ZIPs retain original native stats. Download every raw part and extract them into the same directory. Each part has its own `raw-sha256.json`. `deploy_site.mjs` publishes the checked bundle after the analytics source is committed. Existing report snapshots remain available. Deployment stops before pushing if the combined site exceeds its 1 GB publication budget; older snapshots need an explicit storage decision at that point.
