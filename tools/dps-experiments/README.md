# DPS experiments

Runs the repository's DPS presets through the native simulator and saves the full requests, results and provenance. The runner uses the UI's `Player`, preset application and rotation resolution code. It adds no sim or UI hooks.

## Setup

Install the repository's Go and npm dependencies, then generate the Go protos, TypeScript protos and constants:

```sh
npm ci
make proto go-to-ts
python -m pip install -r tools/dps-experiments/requirements.txt
```

`make proto` requires protoc and protoc-gen-go. See `docs/installation.md` and the pinned protoc release in `.github/actions/setup-protoc/action.yml`. The runner itself needs no web server, game install or database extraction; it uses the checked-in game files data.

## Refresh developer-preset analytics

Keep upstream `master` free of analytics commits. Work on `codex/analytics` in its own worktree, with `origin` pointing to `wowsims/forever` and `personal` pointing to the personal fork. Merge `origin/master` into the analytics branch when updating. Commit by path; full simulation results stay under ignored `tmp/`.

The protocol and constants generator also works without Make:

```sh
node tools/dps-experiments/prepare.mjs
node tools/dps-experiments/refresh.mjs --update --reference /absolute/path/to/previous/developer-presets
```

`--update` requires a clean `codex/analytics` branch, fetches upstream and merges `origin/master`. Resolve a merge conflict before rerunning. Install changed npm dependencies if the lockfile changes. The refresh generates protocol sources and constants, runs the analytics tests, builds a native simulator, runs the full developer matrix and renders the report. `--reference` adds the saved-input matrix and an update comparison. `--prepared` skips generation. `--python executable`, `PYTHON_BINARY`, `GO_BINARY` and the usual `GOCACHE`, `GOMODCACHE`, `PYTHONPATH` and `MPLCONFIGDIR` variables support local runtimes.

On Windows, put Go, protoc-gen-go and protoc on PATH. When protoc is absent, the npm wrapper installs it. A local protoc installation should include its sibling `include/` folder. The Python environment needs the packages in `requirements.txt`.

The output contains `developer-presets/report.html`, optional `frozen-inputs/report.html`, and a top-level update report. Each directory has exact requests, raw results, summaries, charts, a preset audit and provenance. Historical profiles whose equipment IDs have been removed are listed in `unavailable-profiles.json` and omitted from the replay; no items are substituted. Saved-input comparisons reject changed gameplay fields and require identical requests before rendering the update comparison. They measure engine and game-data changes with fixed inputs. Refreshed-preset changes can include equipment, talents, rotations, consumables and professions.

Charts and tables compare matching documented developer gear tiers only. Pre-raid and P1 each have independent orderings at 60, 180 and 300 seconds. The table selects one tier and has no combined view. tier-comparison.csv and tier-comparison.json contain only tier-comparable builds; withinTierOrder resets for each tier and duration. summary.csv retains all raw profile metrics. Testing and placeholder labels do not establish a common progression tier; these profiles are listed outside comparisons, with raw results retained in the saved summaries. The update comparison requires the same documented tier on both sides.

Families follow the talent trees, with hybrid labels and variant names retained. A pre-raid label means the developer calls the set pre-raid or Pre-BiS; acquisition rules and stat budgets can still differ. The profile's rankEligible field records rotation/model support; the report also requires a documented progression tier. Unsupported rotations remain diagnostic within their own tier. The tier grouping rule is shared by the report and update comparison in tier_groups.py.

To save compact results in Git:

```sh
node tools/dps-experiments/publish.mjs tmp/dps-experiments/RUN reports/dps/RUN
```

Publication includes charts, reports, summaries, preset metadata, provenance and requests. Raw result distributions, debug logs and binaries remain local; `raw-data-location.json` records their location. The published report's raw-result links require that local archive. Use a new destination for every publication. Commit the report directory after the tooling commit so its provenance identifies the code that produced it.

Healing and raid composition follow the [experiment groundwork](../../docs/analytics/healing-and-raid-composition.md) and its [machine-readable plan](../../docs/analytics/experiment-plan.json). They define metrics, scenarios, readiness checks and a staged twenty-player roster search. No healer benchmark or roster optimization runs from that plan.

## Run

From the repository root:

```sh
node tools/dps-experiments/run.mjs --out tmp/dps-experiments/baseline
python tools/dps-experiments/report.py tmp/dps-experiments/baseline
node tools/dps-experiments/verify_report.mjs tmp/dps-experiments/baseline
```

Open `tmp/dps-experiments/baseline/report.html`. Its charts, table, filters and profile details work offline. PNG and SVG charts are in `charts/`; CSV and JSON summaries sit beside the report. Full requests, results and debug logs remain in the run directory. The existing `tmp/` ignore rule keeps the generated data out of Git.

The default matrix is 60, 180 and 300 seconds at 10,000 iterations per cell. `baseline.json` states the shared encounter, buffs and debuffs. The runner builds with `with_db`; a supplied `--sim` binary must include the database or receive complete request databases. Its build metadata and hash are recorded, but reusing it does not prove that it matches the current checkout.

```sh
node tools/dps-experiments/run.mjs --out tmp/dps-experiments/pilot --iterations 100
node tools/dps-experiments/run.mjs --help
node tools/dps-experiments/export.mjs tmp/dps-profiles.json
node --test tools/dps-experiments/statistics.test.mjs
```

`--profiles id,id` selects exported profile IDs. `--config file`, `--seed integer` and `--durations 60,180,300` override the matrix. Each run requires an empty output directory and starts fresh. The report is designed for the baseline's three durations.

## Interpretation

- Includes every named DPS build preset, talent presets not covered by a named build, and distinct spec defaults. Resolved requests that differ only in labels or simple-rotation UI metadata are deduplicated. Original profile aliases are saved.
- Retains each profile's gear, race, professions, consumables, reaction time, self abilities and item swaps. Replaces external support with the common settings. Gear tiers and consumables differ, so the output compares supplied profiles and does not isolate class balance.
- Rejects an unequipped profile unless `fallbackGear` in the experiment config names a gear file. The Warlock presets carry no equipment, so the baseline explicitly supplies the repository's Warlock pre-raid set and records that substitution on each profile.
- Uses one level 63 mechanical target with 3731 armor, fixed durations, execute proportions of 20% and 35%, no tank and no incoming damage. Player movement required by a preset remains enabled.
- Saves per-iteration DPS and validates it against the reported mean. Intervals are pointwise approximate 95% Monte Carlo confidence intervals using the sample standard deviation. They do not measure model error, correct for multiple comparisons or establish that close rankings differ.
- Keeps unsupported Rogue Mutilate presets as diagnostics and excludes them from rankings. Their supplied rotations contain no Mutilate action. The runner does not invent a rotation for them.
- Records one debug iteration at the longest duration. Rejected cast attempts remain available for inspection and do not automatically establish a mechanics defect.
- Includes pet damage in player DPS once. Ability breakdowns count damage to encounter targets; consumable damage to the player is excluded.

`provenance.json` includes Git commit, branch, working tree status, source content hashes, game builds and hotfix levels, exact settings, binary hash and build metadata, CPU, runtimes and timestamps. `report-provenance.json` records the plotting environment, report script hash and artifact hashes. The runner verifies that the recorded tracked sources remain unchanged during execution.

## Archived custom gear experiment

The custom gear experiment is kept for reproduction. It is not the default gear policy.

`pre-raid.json` points at the saved reference experiment. `pre-raid-policy.json` states the item-level and quality ceiling, dungeon zones, reviewed crafting and source exceptions, common caster weapon and required rotation items. The source snapshot, iteration count and seed must match the reference. The runner copies the original requests and replaces equipment and active swap equipment only.

```sh
node tools/dps-experiments/run.mjs --config tools/dps-experiments/pre-raid.json --out tmp/dps-experiments/pre-raid
python tools/dps-experiments/compare_gear.py tmp/dps-experiments/pre-raid
node tools/dps-experiments/verify_report.mjs tmp/dps-experiments/pre-raid
node --test tools/dps-experiments/statistics.test.mjs tools/dps-experiments/pre_raid_policy.test.mjs
```

The comparison generator rejects any non-gear request difference and computes the confidence interval of each within-build DPS difference from matching iteration seeds. `gear-audit.json` records every item replacement and its source decision. `gear-comparison.csv` and `gear-comparison.json` contain the before/after DPS, paired difference error and descriptive ranks.

This is a conservative acquisition policy with a common static role score. It is not optimized pre-raid BiS or an equal-stat character experiment. Proc values and set bonuses are not optimized. Permanent enchants are removed, crafting formula availability can be provisional, and unsupported legal relic slots remain empty. The residual ranking includes gear fit, talents, rotations, consumables, professions and simulator limitations; it does not isolate an intrinsic class-strength percentage.

## Racial comparisons for both factions

Run the complete race experiment from the repository root:

```sh
node tools/dps-experiments/racials.mjs --faction both
```

This builds the current simulator, exports current developer presets, checks faction gear counterparts and racial activation, runs 60/180/300-second comparisons, confirms close results with an independent seed, tests Beast/Elemental targets, verifies the results and renders the offline report. The default is 5,000 iterations per primary cell and 20,000 per confirmation cell. `--faction alliance` or `--faction horde` selects one faction. `--python executable`, `PYTHON_BINARY`, `GO_BINARY` and the cache/runtime variables described above apply here too.

After upstream fixes have been merged and validated on `codex/analytics`, run the same command again. The default timestamped output directory preserves earlier reports. Source updates and benchmark execution are separate: an upstream merge follows the CI-before-commit rule in [AGENTS.md](../../AGENTS.md) and [the testing gates](../../.github/skills/wowsims-testing/SKILL.md#the-gates). The racial runner does not fetch, merge, install changed dependencies or commit. This keeps a benchmark from creating an unvalidated merge commit. Install dependencies if the lockfile changed before running again.

Each report records the analytics commit, upstream source commit, working-tree status, source and tool hashes, game builds, hotfixes, engine hash, settings and exact requests. On Windows, keep protoc and protoc-gen-go on PATH as described in Setup. `--prepared` skips generation when the current checkout is already prepared.

The default model is **upstream**. To reproduce the explicit October 27 racial scenario:

```sh
node tools/dps-experiments/racials.mjs --faction both --model notes-2026-10-27 --out tmp/racial-experiments/notes-2026-10-27
```

That named adapter uses Blood Fury's 120-second cooldown, 15-second Berserking and Touch of the Grave's 15-second internal cooldown from the [official clarification](https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-%E2%80%93-updated-october-26/2360696/8). It leaves values already adopted upstream alone and stops on unrecognized source changes. It never edits `sim/`. Its overlay and per-adjustment status are saved in the archive. Future comparisons should normally use the upstream model; retaining a dated adapter is an explicit experimental choice.

An interrupted run can resume with the same settings, checkout and output path:

```sh
node tools/dps-experiments/racials.mjs --faction both --model notes-2026-10-27 --out tmp/racial-experiments/notes-2026-10-27 --resume
```

Resume validates source, tool, Git-state, request, result and engine fingerprints before accepting saved cells. Changed sources require a new output. `--reuse previous-run` can reuse an older archive only when the native engine binary and exact request hash match, with the stored result hash verified. A changed engine is simulated again. Neither option silently mixes results from different engines. Completed archives can be checked later without the original database:

```sh
node tools/dps-experiments/verify_racials.mjs tmp/racial-experiments/notes-2026-10-27
node --test tools/dps-experiments/racial_helpers.test.mjs
```

### What the racial experiment preserves and checks

- Equipment, enchants, swap sets, talents, professions, consumables and original priority entries come from developer presets. The existing Warlock fallback remains explicit. No gear optimization or item scoring is performed.
- Class/race eligibility comes from the current exported simulator capabilities. The faction assignment and reviewed counterpart IDs live in `racial-policy.json`. Unknown races, unavailable items, unreviewed faction substitutions, combat-property mismatches and potentially active set changes stop the run. Faction counterparts also require per-iteration native equivalence controls. Their original and substituted inputs remain saved.
- An unused offensive on-use racial is checked across every duration. Its absence creates a separate case that prepends only its spell-is-known guarded cast, identically for every race in that preset. All original APL entries remain. Adding Autocast Other Cooldowns would also activate unrelated cooldowns, so this check adds only the missing racial action. Unaffected races must reproduce every original DPS iteration. The report shows both cases and marks the adjusted comparison. If the racial still never casts, the ranking stays withheld.
- This activation check does not optimize cooldown timing or add mana tools. Read Leyline usage is recorded; a mana-limited cell that leaves it unused gets a specific caveat. Existing active racial timing and mana behavior remain the developer APL's choices.
- Testing, Placeholder, specialized rotations, reviewed rotation issues, unresolved conditions, recorded mana waits and racial adjustments have separate qualitative tags. The mana screen is mean recorded OOM time above 5% of fight length. A separate close-result marker uses a 0.2% reporting threshold and paired sampling intervals. Shared race/talent guard warnings stay in the validation dump and do not automatically lower preset confidence. Reviewed rotation caveats in `racial-policy.json` apply only while the corresponding native warning remains present. Neither marker establishes in-game accuracy.
- Exact-input aliases are hidden, with their mapping retained. Unsupported exported profiles remain listed. Single-race cases show eligibility only. Percentages compare races within a preset and faction; unequal gear tiers do not support cross-class rankings.
- The native `stats` tool calls the public `ComputeStats` API to preserve APL validations. It adds no sim/UI hooks. Independent NumPy calculations check DPS means and covariance-based paired uncertainty. The verifier checks hashes, faction legality, race-only comparison inputs, minimal APL changes, control equivalence and local report links.

Each archive contains `report.html`, faction overview PNG/SVG charts, class charts, `race-comparison.csv`, untouched developer results, adjusted results, confirmations, target-type sensitivity, validations, equivalence controls, an equipment audit, provenance and artifact hashes. Full requests, distributions and native binaries remain under ignored `tmp/`. Keep the entire directory for replay and verification. `--help` lists the sampling, duration, profile and scenario options for smaller diagnostic runs.
