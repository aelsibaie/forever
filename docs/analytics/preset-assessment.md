# Preset assessment and engine diagnostics

WoWSims remains the primary simulator. Preserve developer presets as references and label alternatives by their source and exact changes. Developer gear is a starting point, not a requirement for every experiment or a claim of optimal itemization. Human-authored alternatives need a source revision, acquisition tier, item IDs, enchants and modeled effects before joining tier comparisons. Hypothetical item stats remain separate.

## Rerun

After the upstream merge, preparation and gates described in the experiment README:

```sh
node tools/dps-experiments/workflow.mjs --prepared --audit --gunba-source tmp/engine-comparisons/gunba
```

The workflow runs the baseline, builds the pinned Gunba driver through the Shadow comparison and assesses all exported DPS profiles and faction-legal races. Without `--gunba-source`, `--audit` runs the native assessment only. Aliases and excluded builds remain visible. Nothing updates upstream or commits implicitly.

For an existing racial archive:

```sh
node tools/dps-experiments/assess.mjs --primary-run PATH/racials --out tmp/assessment-NEW --gunba-source tmp/engine-comparisons/gunba --gunba-engine PATH/shadow-comparison/engine/gunba.exe
```

On Unix the driver is named `gunba`. Use the driver from the pinned comparison. Individual audit and comparison stages support `--resume`, verifying request, engine and result hashes. Changed inputs require a new directory. The wrapper writes stage logs and a receipt.

## Native controls and alternatives

The rotation screen replaces statically false conditions with constant false, retains their actions and checks every iteration against the original. Retaining actions matters because pruned actions can suppress automatic cooldown use. Its 250 shared-seed iterations establish agreement for that input, not general equivalence.

Item-based action IDs are not spell IDs. Their known-action guards stay unresolved. An exploratory classifier failed eight controls by treating item IDs as absent spells; those exploratory outputs are superseded. Reports require every saved control to agree.

Warlock Shadow Brand aura 1323392 is Revelation. The unenchanted reference weapon lacks it, and the APL guards that branch with `auraIsKnown`. The warning alone does not establish a broken rotation. No simulator or developer APL changes are needed for the control.

Two sensitivities preserve the original items and talents at 60, 180 and 300 seconds:

- Add permanent enchant 8217 only to an unenchanted caster main hand. This is a missing-enchant test, with the provisional flat 9% Revelation proc model.
- Prepend guarded Read Leyline for mana-limited High Order Skyborne builds at ≤65% mana, retaining original priorities. Channel and timing costs can reduce DPS, so it is not applied automatically.

The current reference uses 5,000 paired iterations per case. Exact inputs, outputs, confidence intervals and hashes accompany the charts. Sampling error excludes model uncertainty. The local developer library records a historical Revelation shapeshift fix in S027-primary, paragraph 848, captured October 16; that publication does not verify the proc chance used here.

## Cross-engine interpretation

The full Shadow comparison retains its matched-input and resource controls. Wider diagnostics remove external buffs, debuffs and consumables in both engines, retaining developer equipment and named talents. Final stats and effects can still differ.

Developer-rotation diagnostics expand groups and variables and require iteration-identical WoWSims normalization controls. Common-spell probes replace both rotations with the same one-spell repetition: Starfire 9876, Frostbolt 10181 or Searing Pain 17923. Both engines must register and deal damage with the selected spell. These probes omit prepull and automatic cooldowns and cannot rank complete builds or active racials.

Wider diagnostics use 2,000 iterations per cell and disjoint engine seed ranges: WoWSims 2026102707, Gunba 3026102707. Absolute differences use independent errors. A successful execution does not establish mechanic parity.

Coverage lists completed races, partial profiles and blockers. Missing talents and APL fields can be source gaps; unsupported stat or option translations can be adapter limitations. Inputs are never silently dropped. Gunba's `sim/core/config.go` fixes `IncludeAQ = false`; its Warlock registration omits Shadow Bolt 25307, which the primary preset uses. The shared Warlock probe uses Searing Pain instead of altering that phase policy.

## Publication

```sh
node tools/dps-experiments/publish_site.mjs --run PATH/workflow --assessment PATH/assessment --out tmp/publication-NEW --id SNAPSHOT --raw-base https://github.com/OWNER/REPO/releases/download/TAG --make-raw
node tools/dps-experiments/deploy_site.mjs --bundle tmp/publication-NEW --repo OWNER/REPO --tag TAG
```

Omit `--assessment` when it is inside the workflow archive. Commit and push reviewed analytics source after the repository gates, then deploy with publication authorization and repository admin access. The static site uses `codex/report-site` and retains dated snapshots. GitHub Releases retain raw output ZIPs. Verify the HTTPS page after the Pages build completes.

Native requests and website imports retain their exact bytes. Result distributions and debug JSON move to ZIPs; public result pages retain readable metrics and compressed counters. Per-file checksums distinguish originals and public representations. Public JSON omits local environment paths. The publisher verifies source manifests and links before deployment.
