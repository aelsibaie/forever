"""Render the saved experiment data as standalone charts and an offline report."""

import argparse
import csv
import hashlib
import gzip
import html
import json
import math
import platform
from pathlib import Path
from report_details import render_details
from datetime import datetime
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import TwoSlopeNorm, LinearSegmentedColormap
import numpy as np
from tier_groups import comparison_tier, tier_groups, tier_slug


COLORS = {"Druid": "#F7A560", "Hunter": "#B1D98E", "Mage": "#83D1ED", "Paladin": "#F4A5CB", "Priest": "#ECEEF7", "Rogue": "#F6D879", "Shaman": "#719CFF", "Warlock": "#B5A2F5", "Warrior": "#C5A28A"}
SPECS = {"druid/balance": "Balance Druid", "druid/feralcat": "Feral Cat", "hunter/dps": "Hunter", "mage/dps": "Mage", "paladin/retribution": "DPS Paladin", "priest/dps": "DPS Priest", "rogue/dps": "Rogue", "shaman/elemental": "Elemental", "shaman/enhancement": "Enhancement", "warlock/dps": "Warlock", "warrior/dps": "DPS Warrior"}
BG, PANEL, TEXT, MUTED, GRID = "#0C1423", "#121E30", "#EDF2FA", "#A3B3CC", "#29374D"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    read = lambda name: json.loads((directory / name).read_text(encoding="utf-8"))
    manifest, catalog, summary = read("provenance.json"), read("profiles.json"), read("summary.json")
    repository = Path(__file__).resolve().parents[2]
    names_path = repository / 'assets/db_inputs/spell_store_inputs.json'
    packed_names = names_path.read_bytes()
    if hashlib.sha256(packed_names).hexdigest() != manifest['sourceFiles']['assets/db_inputs/spell_store_inputs.json']:
        raise ValueError('The spell names snapshot differs from the recorded experiment source.')
    spell_names = json.loads(gzip.decompress(packed_names) if packed_names[:2] == b'\x1f\x8b' else packed_names)['Names']
    def named_action(action):
        action_id = action['id']
        label = spell_names.get(str(action_id.get('spellId'))) if 'spellId' in action_id else None
        if not label:
            label = f"Item {action_id['itemId']}" if 'itemId' in action_id else str(action_id.get('otherId', 'Unknown action')).removeprefix('OtherAction')
        return {**action, 'label': label}
    profiles = {p["id"]: p for p in catalog["profiles"]}
    rows = summary["rows"]
    durations = manifest["config"]["durations"]
    reference = 180 if 180 in durations else durations[0]
    lookup = {(r["profileId"], r["duration"]): r for r in rows}
    eligible = [p for p in profiles.values() if p["rankEligible"] and all((p["id"], d) in lookup for d in durations)]
    groups = tier_groups(eligible, key=lambda p: lookup[p["id"], reference]["meanDps"])
    if not groups:
        raise ValueError("No documented developer gear tiers are available for comparison.")
    ordered = [p for _, items in groups for p in items]
    commit = manifest["git"].get("upstreamSourceCommit", manifest["git"]["commit"])
    analytics_commit = manifest["git"]["commit"]
    stamp = datetime.fromisoformat(manifest["startedAt"].replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
    build = ", ".join(sorted(set(manifest["gameBuilds"].values())))
    iterations = manifest["config"]["iterations"]
    footer = f"SIM {commit[:12]} / ANALYTICS {analytics_commit[:12]}  |  GAME {build}  |  {iterations:,} ITERATIONS / CELL  |  SEED {manifest['config']['seed']}  |  {stamp:%b %d, %Y %H:%M %Z}"
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "figure.facecolor": BG, "axes.facecolor": PANEL, "axes.edgecolor": GRID, "axes.labelcolor": MUTED, "text.color": TEXT, "xtick.color": MUTED, "ytick.color": TEXT, "savefig.facecolor": BG, "svg.fonttype": "none"})
    charts = directory / "charts"
    charts.mkdir(exist_ok=True)

    def title(fig, eyebrow, heading, subheading):
        fig.text(0.055, 0.973, eyebrow, color="#81DDCA", size=10, weight="bold", va="top")
        fig.text(0.055, 0.944, heading, size=25, weight="bold", va="top")
        fig.text(0.055, 0.907, subheading, size=10, color=MUTED, va="top")

    def finish(fig, filename):
        fig.text(0.055, 0.032, footer, color=MUTED, size=7.5)
        fig.text(0.055, 0.015, "Developer gear tiers only. Preset and mechanics caveats are on the inspection pages. Error bars: pointwise 95% Monte Carlo CI.", color=MUTED, size=8)
        fig.savefig(charts / f"{filename}.png", dpi=180)
        fig.savefig(charts / f"{filename}.svg")
        plt.close(fig)

    def ladder(sections, filename, heading, subheading):
        height = max(8.8, sum(max(3.0, len(items) * 0.36) for _, items in sections) + 3.0 + 0.8 * (len(sections) - 1))
        fig, axes = plt.subplots(len(sections), len(durations), figsize=(17.4, height), squeeze=False, gridspec_kw={"height_ratios": [max(3, len(items)) for _, items in sections]})
        fig.subplots_adjust(left=0.32, right=0.96, top=0.80 if height < 11 else 0.86, bottom=0.11, wspace=0.13, hspace=0.24)
        for row, (tier, items) in enumerate(sections):
            maximum = max(lookup[p["id"], d]["meanDps"] + lookup[p["id"], d]["ci95HalfWidth"] for p in items for d in durations) * 1.16
            labels = [f"{p.get('specLabel', SPECS[p['specPath']])} / {p['name']}" for p in items]
            for column, (ax, duration) in enumerate(zip(axes[row], durations)):
                ax.set_axisbelow(True)
                ax.grid(axis="x", color=GRID, alpha=0.65, linewidth=0.7)
                for spine in ax.spines.values():
                    spine.set_visible(False)
                values = [lookup[p["id"], duration]["meanDps"] for p in items]
                errors = [lookup[p["id"], duration]["ci95HalfWidth"] for p in items]
                ax.barh(np.arange(len(items)), values, color=[COLORS[p["className"]] for p in items], height=0.59, alpha=0.9, zorder=2)
                ax.errorbar(values, np.arange(len(items)), xerr=errors, fmt="none", ecolor="#24334C", elinewidth=1.1, capsize=2.7, zorder=3)
                for y, value, error in zip(range(len(items)), values, errors):
                    ax.text(value + error + maximum * 0.018, y, f"{value:,.0f}", va="center", fontsize=9, weight="bold")
                ax.set_title(f"{tier.removeprefix('Developer ')} · {duration}s", loc="left", fontsize=15, weight="bold", pad=16, color="#81DDCA" if duration == reference else TEXT)
                ax.set_xlim(0, maximum)
                ax.set_ylim(len(items) - 0.3, -0.7)
                ax.set_yticks(range(len(items)), labels)
                ax.tick_params(axis="y", length=0, pad=13, labelsize=9.5, labelleft=column == 0)
                ax.tick_params(axis="x", length=0, pad=9)
                ax.set_xlabel("Mean damage per second", labelpad=12, size=9)
        title(fig, "WOWSIMS FOREVER  /  PRESET BASELINE", heading, subheading)
        finish(fig, filename)

    ladder(groups, "overview", "DPS within developer gear tiers", "Each developer gear tier ranks independently. Rows are ordered within their tier by 180-second DPS.")
    for tier, items in groups:
        ladder([(tier, items)], "tier-" + tier_slug(tier), tier + " DPS builds", "The same developer gear tier at 60, 180 and 300 seconds. Acquisition rules and stat budgets can still differ.")
    pre_raid = [(tier, items) for tier, items in groups if tier == "Developer pre-raid"]
    if pre_raid:
        ladder(pre_raid, "all-builds", "Developer pre-raid DPS builds", "Sets explicitly labeled pre-raid or Pre-BiS. Developer source caveats remain.")

    if 60 in durations and 300 in durations:
        response_groups = tier_groups(ordered, key=lambda p: lookup[p["id"], 300]["meanDps"] / lookup[p["id"], 60]["meanDps"])
        comparison_durations = [d for d in durations if d != 60]
        arrays = [np.array([[100 * (lookup[p["id"], d]["meanDps"] / lookup[p["id"], 60]["meanDps"] - 1) for d in comparison_durations] for p in items]) for _, items in response_groups]
        fig, axes = plt.subplots(len(response_groups), 1, figsize=(12.5, max(11, len(ordered) * 0.30 + 4)), squeeze=False, gridspec_kw={"height_ratios": [len(items) for _, items in response_groups]})
        fig.subplots_adjust(left=0.44, right=0.88, top=0.84, bottom=0.10, hspace=0.28)
        limit = max(5, math.ceil(max(np.abs(data).max() for data in arrays) / 5) * 5)
        cmap = LinearSegmentedColormap.from_list("duration", ["#D97581", "#17253A", "#7CDDC5"])
        for ax, (tier, items), data in zip(axes[:, 0], response_groups, arrays):
            im = ax.imshow(data, aspect="auto", cmap=cmap, norm=TwoSlopeNorm(vmin=-limit, vcenter=0, vmax=limit))
            ax.set_title(tier, loc="left", size=13, pad=15, weight="bold")
            ax.set_yticks(range(len(items)), [f"{p.get('specLabel', SPECS[p['specPath']])} / {p['name']}" for p in items], size=9)
            ax.set_xticks(range(len(comparison_durations)), [f"{d}s vs 60s" for d in comparison_durations], size=11)
            ax.tick_params(length=0, pad=10)
            for i in range(len(items)):
                for j in range(len(comparison_durations)):
                    ax.text(j, i, f"{data[i, j]:+.1f}%", ha="center", va="center", color=TEXT, size=9)
        fig.colorbar(im, ax=list(axes[:, 0]), fraction=0.035, pad=0.05).set_label("Change in mean DPS (%)", size=9)
        title(fig, "DURATION RESPONSE BY GEAR TIER", "How each tier sustains its damage", "Each build is compared with its own 60-second mean. Rows are ordered independently inside each gear tier.")
        finish(fig, "duration-response")

    tier_rows = []
    for tier, items in groups:
        for duration in durations:
            ranked = sorted(items, key=lambda p: lookup[p['id'], duration]['meanDps'], reverse=True)
            for position, profile in enumerate(ranked, 1):
                result = lookup[profile['id'], duration]
                tier_rows.append({'gearTier': tier, 'duration': duration, 'withinTierOrder': position, 'profileId': profile['id'], 'spec': profile.get('specLabel', profile['specPath']), 'build': profile['name'], 'meanDps': result['meanDps'], 'ci95HalfWidth': result['ci95HalfWidth']})
    (directory / 'tier-comparison.json').write_text(json.dumps(tier_rows, indent=2), encoding='utf-8')
    with (directory / 'tier-comparison.csv').open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(tier_rows[0]))
        writer.writeheader()
        writer.writerows(tier_rows)

    def svg(name):
        text = (charts / f"{name}.svg").read_text(encoding="utf-8")
        return text[text.index("<svg"):]

    total_iterations = sum(row["iterations"] for row in rows)
    excluded = [p for p in profiles.values() if not p["rankEligible"]]
    warning_profiles = sorted({r["profileId"] for r in rows if r["debugWarnings"]})
    table_rows = []
    for profile in profiles.values():
        cells = [lookup.get((profile["id"], d)) for d in durations]
        table_rows.append({"id": profile["id"], "className": profile["className"], "spec": profile.get("specLabel", SPECS[profile["specPath"]]), "tier": profile.get("gearTier", "Saved reference"), "preRaid": profile.get("documentedPreRaid", False), "name": profile["name"], "gear": profile["gearName"], "race": profile["race"].removeprefix("Race"), "eligible": profile["rankEligible"], "warnings": profile["warnings"], "knownIssues": profile["knownIssues"], "talents": profile["player"].get("talentsString", ""), "professions": profile["professions"], "tooltip": profile["gearTooltip"], "cells": [{"dps": r["meanDps"], "ci": r["ci95HalfWidth"], "sd": r["stdev"], "p10": r["p10"], "p90": r["p90"], "oom": r["secondsOomAvg"], "pet": r["petDps"], "actions": [named_action(a) for a in r["damageActions"]], "petActions": [{**p, 'actions': [named_action(a) for a in p['actions']]} for p in r["petActions"]], "debug": r["debugWarnings"]} if r else None for r in cells]})
    issues = "".join(f"<li><b>{html.escape(SPECS[p['specPath']] + ' / ' + p['name'])}</b>: {html.escape('; '.join(p['warnings']))}</li>" for p in excluded)
    duplicate_text = ", ".join(p["id"] for p in catalog.get("duplicateProfiles", [])) or "None"
    notes = f"""<ul><li><b>Preset comparison:</b> gear tiers, enchants, consumables, races, professions and latency differ. This measures the supplied configurations; it does not isolate class balance or establish best possible DPS.</li>
    <li><b>Alpha models:</b> all DPS entries are Alpha. Rotation and model limitations can exceed the displayed simulation uncertainty.</li>
    <li><b>Common support:</b> every run uses the same raid, party, individual buffs and target debuffs. External Innervate, Power Infusion, Mana Tide and Atiesh support are absent; self abilities remain available when a preset uses them.</li>
    <li><b>Encounter:</b> one level {manifest['config']['target']['level']} mechanical target, {manifest['config']['target']['armor']:,} armor, fixed durations, no incoming attacks or assigned tank. No forced encounter movement; preset player movement, weaving and item swaps remain enabled. Execute phases: 20% and 35% of the fight.</li>
    <li><b>Statistics:</b> {iterations:,} iterations per cell; error bars are pointwise approximate 95% confidence intervals for the simulated mean, computed from saved samples. They describe Monte Carlo error, not model uncertainty. Small ordering differences should not be treated as proven rankings. All runs share seed {manifest['config']['seed']}; cross-class tests do not assume paired errors.</li>
    <li><b>Coverage:</b> {len(profiles)} unique profiles across 11 DPS simulators and nine classes; {len(excluded)} unsupported profiles are diagnostic only. Named build presets, uncovered talent presets and distinct defaults are included. Arbitrary talent combinations, every rotation variant and every gear combination are outside this baseline.</li>
    <li><b>Duplicate requests removed:</b> {html.escape(duplicate_text)}. Original aliases are retained in profiles.json.</li>
    <li><b>Damage accounting:</b> player DPS already includes pets. Ability damage and cast counts are aggregated over all iterations; casts in the detail view are means per fight.</li>
    <li><b>Debug screening:</b> one 300-second debug iteration per profile; {len(warning_profiles)} profiles contain rejected cast attempts, usually resource or cooldown checks. These observations are preserved in the profile details and raw logs; this is not a full mechanics audit.</li>
    <li><b>Gear policy:</b> Equipment, enchants and item swaps follow developer presets. The pre-raid subset uses sets the developers label pre-raid or Pre-BiS; their acquisition rules and source caveats differ. P1 is ranked separately. Testing and placeholder profiles remain outside comparisons and are listed below. Empty Warlock presets use the repository's pre-raid file recorded in the configuration.</li>
    <li><b>Role coverage:</b> This matrix covers DPS builds. Unsupported rotations are diagnostic. Healer and tank coverage is recorded in preset-audit.json; this report does not measure HPS or optimize a raid.</li></ul>"""
    payload = json.dumps({"rows": table_rows, "durations": durations, "colors": COLORS, "tiers": [tier for tier, _ in groups]}).replace("<", "\\u003c")
    html_report = r"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WoWSims Forever · DPS baseline</title>
    <style>
    :root{color-scheme:dark;--bg:#0c1423;--panel:#121e30;--line:#29374d;--text:#edf2fa;--muted:#a3b3cc;--mint:#81ddca}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif}main{max-width:1540px;margin:auto;padding:48px 5vw 80px}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:11px;font-weight:750;color:var(--mint)}h1{font-size:clamp(36px,5vw,65px);line-height:1.08;letter-spacing:-.05em;margin:16px 0 20px;max-width:950px}h2{font-size:27px;letter-spacing:-.025em;line-height:1.25;margin:0 0 12px}h3{font-size:18px}.lede{font-size:18px;color:var(--muted);max-width:950px}.meta{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}.chip{border:1px solid var(--line);border-radius:30px;padding:6px 13px;font-size:12px;color:var(--muted)}.chip b{color:var(--text)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:30px 0}.stat{background:var(--panel);border:1px solid var(--line);padding:21px 24px;border-radius:16px}.stat strong{display:block;font-size:30px;letter-spacing:-.04em}.stat span{font-size:12px;color:var(--muted)}.note{border-left:3px solid #e8b57e;background:#1b2230;padding:16px 20px;border-radius:0 10px 10px 0;color:#e4d0b6}.section{margin-top:52px}.chart{margin-top:22px;background:var(--panel);border:1px solid var(--line);border-radius:18px;overflow:hidden}.chart svg{display:block;width:100%;height:auto}.links{display:flex;flex-wrap:wrap;gap:18px;font-size:13px;margin:14px 0}a{color:var(--mint);text-decoration:none}a:hover{text-decoration:underline}p.sub{color:var(--muted);margin-top:0}.toolbar{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}input,select,button{font:inherit;background:#17253a;border:1px solid #34455d;border-radius:9px;color:var(--text);padding:9px 12px}input{min-width:250px}button{cursor:pointer}button:hover{border-color:var(--mint)}.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px}th{text-align:left;color:var(--muted);background:#17253a;font-size:11px;text-transform:uppercase;letter-spacing:.07em;white-space:nowrap}th,td{padding:13px 15px;border-bottom:1px solid var(--line)}td.num,th.num{text-align:right}tbody tr:hover{background:#18273d}td small{color:var(--muted);display:block;font-size:11px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}.badge{color:#e8b57e;font-size:10px;text-transform:uppercase;letter-spacing:.06em}.info{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}.box{padding:24px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}dl{margin:0}dt{font-size:11px;color:var(--muted);margin-top:14px;text-transform:uppercase;letter-spacing:.05em}dd{margin:3px 0 0;overflow-wrap:anywhere}code{font-size:12px;overflow-wrap:anywhere;color:#c8d5ee}.method{color:var(--muted);font-size:14px}.method b{color:var(--text)}li{margin:12px 0}details{border:1px solid var(--line);border-radius:14px;padding:18px 22px;margin:18px 0}summary{cursor:pointer;font-weight:650}footer{margin-top:50px;border-top:1px solid var(--line);padding-top:22px;font-size:12px;color:var(--muted)}dialog{max-width:1000px;width:94vw;max-height:88vh;background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:26px;color:var(--text)}dialog::backdrop{background:#050b16bb}pre{white-space:pre-wrap;font-size:12px;color:var(--muted)}.close{float:right}.focus:focus-visible,a:focus-visible,button:focus-visible{outline:2px solid var(--mint)}@media(max-width:800px){main{padding:28px 20px}.stats{grid-template-columns:repeat(2,1fr)}.info{grid-template-columns:1fr}.chart{overflow:auto}.chart svg{min-width:850px}.toolbar>*{width:100%}}
    </style><main><div class="eyebrow">WoWSims Forever / developer preset analytics</div>
    <h1>DPS within<br>developer gear tiers.</h1><p class="lede">A reproducible single-target baseline across the repository’s DPS presets, measured at 60, 180 and 300 seconds.</p>
    <div class="meta">__META__</div><div class="stats">__STATS__</div>
    <div class="note"><b>Rankings stay within a developer gear tier.</b> Testing and placeholder sets are excluded. Gear budgets, consumables and races can still vary within each tier. These are Alpha simulator results under the saved assumptions; the charts do not establish a class balance tier list.</div>
    <section class="section"><h2>DPS within each developer gear tier</h2><p class="sub">Each section has its own 180-second ordering and carries the same builds across all three durations. There is no mixed-tier leaderboard.</p><div class="chart" role="img" aria-label="Mean DPS at three fight durations with 95 percent confidence intervals">__OVERVIEW__</div><div class="links"><a href="charts/overview.png">Download PNG</a><a href="charts/overview.svg">Download SVG</a><a href="tier-comparison.csv">Tier comparison CSV</a></div></section>
    <section class="section"><h2>Explore one gear tier</h2><p class="sub">Search a class or build. Change duration to inspect spread, mana pressure and pet contribution. Select a profile for its ability breakdown and saved assumptions.</p>
    <div class="toolbar"><input id="search" aria-label="Filter builds" placeholder="Search class, build or gear…"><select id="duration" aria-label="Duration"></select><select id="tier" aria-label="Gear tier"></select><select id="sort" aria-label="Sort"><option value="dps">Sort by DPS</option><option value="name">Sort by class / build</option><option value="oom">Sort by time out of mana</option></select><label><input id="diagnostic" type="checkbox" style="min-width:0"> Show diagnostic profiles</label></div>
    <div class="tablewrap"><table><thead><tr><th>Profile</th><th>Gear / race</th><th class="num">DPS ± 95% CI</th><th class="num">Fight P10–P90</th><th class="num">OOM / fight</th><th class="num">Pet DPS</th><th></th></tr></thead><tbody id="matrix"></tbody></table></div>
    <details><summary>Selected tier chart</summary>__ALL__</details></section>
    <section class="section"><h2>Short fights and sustained damage</h2><p class="sub">Each tier is shown separately. Every build uses its own 60-second result as the reference.</p><div class="chart" role="img" aria-label="Percentage change in each profile's mean DPS relative to its 60 second result">__RESPONSE__</div><div class="links"><a href="charts/duration-response.png">PNG</a><a href="charts/duration-response.svg">SVG</a></div></section>
    <section class="section"><h2>Methods, coverage and limits</h2><div class="method">__NOTES__</div><details><summary>Diagnostic profiles</summary><ul>__ISSUES__</ul></details><details><summary>Exact common buffs, debuffs and encounter settings</summary><pre>__CONFIG__</pre></details></section>
    <section class="section"><h2>Source and reproducibility</h2><div class="info"><div class="box"><h3>Simulator snapshot</h3>__SOURCE__</div><div class="box"><h3>Execution record</h3>__EXECUTION__</div></div><div class="links"><a href="provenance.json">Complete provenance JSON</a><a href="preset-audit.json">Developer preset audit</a><a href="profiles.json">Resolved profiles</a><a href="summary.json">Summary and ability metrics</a><a href="tier-comparison.csv">Tier comparison CSV</a><a href="summary.csv">Raw metrics CSV</a><a href="charts/overview.png">Overview image</a></div><details><summary>Hotfix levels by data group</summary><pre>__HOTFIXES__</pre></details></section>
    <footer>Generated locally from saved requests and simulation results. Full inputs are in requests/, full results in results/, and one debug iteration per profile in debug/. The report has no external scripts, fonts or network dependencies.</footer></main>
    <dialog id="detail"><button class="close" onclick="document.querySelector('#detail').close()">Close</button><div id="detailbody"></div></dialog>
    <script>const DATA=__DATA__;
    const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const fmt=(x,n=1)=>Number(x).toLocaleString('en-US',{minimumFractionDigits:n,maximumFractionDigits:n});
    const tier=document.querySelector('#tier');DATA.tiers.forEach(t=>tier.add(new Option(t,t)));
    const duration=document.querySelector('#duration');DATA.durations.forEach((d,i)=>{const o=new Option(d+' seconds',i);duration.add(o);if(d===180)duration.value=i});
    function render(){const idx=+duration.value,q=document.querySelector('#search').value.toLowerCase(),show=document.querySelector('#diagnostic').checked,sort=document.querySelector('#sort').value;let rows=DATA.rows.filter(r=>(show||r.eligible)&&r.tier===document.querySelector('#tier').value&&[r.className,r.spec,r.name,r.gear,r.tier].join(' ').toLowerCase().includes(q)&&r.cells[idx]);rows.sort((a,b)=>sort==='name'?(a.spec+a.name).localeCompare(b.spec+b.name):sort==='oom'?b.cells[idx].oom-a.cells[idx].oom:b.cells[idx].dps-a.cells[idx].dps);document.querySelectorAll('[data-tier-chart]').forEach(node=>node.hidden=node.dataset.tierChart!==tier.value);document.querySelector('#matrix').innerHTML=rows.map(r=>{const c=r.cells[idx];return `<tr data-tier="${esc(r.tier)}"><td><span class="dot" style="background:${DATA.colors[r.className]}"></span><b>${esc(r.spec)}</b><small>${esc(r.name)} ${r.eligible?'':'<span class="badge">Diagnostic</span>'}</small></td><td>${esc(r.gear)}<small>${esc(r.tier)} · ${esc(r.race)}</small></td><td class="num"><b>${fmt(c.dps)}</b> <small>± ${fmt(c.ci,2)}</small></td><td class="num">${fmt(c.p10,0)}–${fmt(c.p90,0)}</td><td class="num">${fmt(c.oom)}s</td><td class="num">${fmt(c.pet)}</td><td><button data-profile="${esc(r.id)}">Details</button></td></tr>`}).join('')}
    for(const id of ['duration','search','sort','diagnostic','tier'])document.querySelector('#'+id).addEventListener(id==='search'?'input':'change',render);
    document.querySelector('#matrix').addEventListener('click',e=>{const id=e.target.closest('[data-profile]')?.dataset.profile;if(!id)return;const r=DATA.rows.find(r=>r.id===id),c=r.cells[+duration.value];const actions=[...c.actions.map(a=>({...a,pet:''})),...c.petActions.flatMap(p=>p.actions.map(a=>({...a,pet:p.name})))].sort((a,b)=>b.dps-a.dps);const actionRows=actions.map(a=>`<tr><td>${esc(a.pet? a.pet+' / ':'')}${esc(a.label)}<small>${esc(JSON.stringify(a.id))}</small></td><td class="num">${fmt(a.dps)}</td><td class="num">${fmt(a.casts)}</td></tr>`).join('');document.querySelector('#detailbody').innerHTML=`<div class="eyebrow">${esc(r.spec)} / ${DATA.durations[+duration.value]} seconds</div><h2>${esc(r.name)}</h2><p>${esc(r.gear)} · ${esc(r.race)} · ${esc(r.professions.join(' / '))}</p><p><b>${fmt(c.dps)} ± ${fmt(c.ci,2)} DPS</b> · Fight standard deviation ${fmt(c.sd)} · OOM ${fmt(c.oom)}s</p><p class="sub">${esc(r.tooltip)}</p><p>Talents: <code>${esc(r.talents)}</code></p><ul>${[...r.warnings,...r.knownIssues].map(w=>'<li>'+esc(w)+'</li>').join('')}</ul><div class="links"><a href="requests/${esc(r.id)}--${DATA.durations[+duration.value]}s.json">Exact request</a><a href="results/${esc(r.id)}--${DATA.durations[+duration.value]}s.json">Raw result</a><a href="debug/${esc(r.id)}.result.json">Debug result</a></div><h3>Damage sources</h3><table><thead><tr><th>Action</th><th class="num">DPS</th><th class="num">Casts / fight</th></tr></thead><tbody>${actionRows}</tbody></table><h3>One 300-second debug iteration</h3><pre>${esc(c.debug.length?c.debug.join('\n'):'No rejected cast attempts matched the debug screen.')}</pre>`;document.querySelector('#detail').showModal()});render();
    </script></html>"""

    source = f"<dl><dt>Upstream simulator commit</dt><dd><code>{commit}</code></dd><dt>Analytics revision</dt><dd><code>{analytics_commit}</code></dd><dt>Commit subject</dt><dd>{html.escape(manifest['git']['subject'])}</dd><dt>Branch</dt><dd>{html.escape(manifest['git']['branch'])}</dd><dt>Working tree at run start</dt><dd><code>{html.escape(manifest['git']['status'] or 'Clean')}</code></dd><dt>Game build</dt><dd>{build}</dd><dt>Source content SHA-256</dt><dd><code>{manifest['sourceSha256']}</code></dd><dt>Simulator sources unchanged during run</dt><dd>{manifest.get('sourceUnchangedDuringRun')}</dd></dl>"
    execution = f"<dl><dt>Started (America/New_York)</dt><dd>{stamp:%B %d, %Y · %H:%M:%S %Z}</dd><dt>Completed runs / failures</dt><dd>{len(rows)} / {len(summary['failures'])}</dd><dt>Iterations per cell / seed</dt><dd>{iterations:,} / {manifest['config']['seed']}</dd><dt>Go / Node</dt><dd>{html.escape(manifest['environment']['go'])}<br>{manifest['environment']['node']}</dd><dt>CPU</dt><dd>{html.escape(manifest['environment']['cpu'])} · {manifest['environment']['logicalCpus']} logical cores</dd><dt>Native engine SHA-256</dt><dd><code>{manifest['engine']['sha256']}</code></dd><dt>Runner source SHA-256</dt><dd><code>{manifest['runnerSha256']}</code></dd></dl>"
    tier_charts = ''.join(f'<div data-tier-chart="{html.escape(tier)}" hidden><div class="chart">{svg("tier-" + tier_slug(tier))}</div><div class="links"><a href="charts/tier-{tier_slug(tier)}.png">{html.escape(tier)} PNG</a><a href="charts/tier-{tier_slug(tier)}.svg">SVG</a></div></div>' for tier, _ in groups)
    unverified = [p for p in profiles.values() if not comparison_tier(p)]
    notes += '<p><b>Profiles outside tier comparisons:</b> testing and placeholder labels do not establish a shared progression tier. Their results remain in the saved summaries.</p><ul>' + ''.join('<li>' + html.escape(p.get('specLabel', p['specPath']) + ' / ' + p['name'] + ': ' + p.get('gearTier', 'Unverified tier')) + '</li>' for p in unverified) + '</ul>'
    if manifest.get('frozenUnavailable'):
        notes += '<p><b>Historical profiles unavailable on this engine:</b></p><ul>' + ''.join('<li>' + html.escape(p['id']) + ': removed item IDs ' + ', '.join(map(str, p['missingItems'])) + '</li>' for p in manifest['frozenUnavailable']) + '</ul><p>No replacement equipment was selected. These omissions apply only to the saved-input comparison.</p>'
    replacements = {"__META__": f'<span class="chip">Source <b>{commit[:12]}</b></span><span class="chip">Game build <b>{build}</b></span><span class="chip"><b>{stamp:%b %d, %Y}</b> · {stamp:%H:%M %Z}</span>', "__STATS__": ''.join(f'<div class="stat"><strong>{value}</strong><span>{label}</span></div>' for value, label in [(len(profiles), 'unique profiles, including diagnostics'), (len(rows), 'completed duration / profile cells'), (f'{total_iterations:,}', 'simulated fights in the matrix'), ('60 / 180 / 300s', 'fixed encounter durations')]), "__OVERVIEW__": svg('overview'), "__ALL__": tier_charts, "__RESPONSE__": svg('duration-response') if (charts / 'duration-response.svg').exists() else '', "__NOTES__": notes, "__ISSUES__": issues, "__CONFIG__": html.escape(json.dumps(manifest['config'], indent=2)), "__SOURCE__": source, "__EXECUTION__": execution, "__HOTFIXES__": html.escape(json.dumps(manifest['hotfixes'], indent=2)), "__DATA__": payload}
    for key, value in replacements.items():
        html_report = html_report.replace(key, value)
    details = render_details(directory, repository, manifest, catalog, rows)
    html_report = html_report.replace('</main>', details + '</main>')
    (directory / 'report.html').write_text(html_report, encoding='utf-8')
    artifacts = [directory / 'report.html', directory / 'tier-comparison.csv', directory / 'tier-comparison.json', directory / 'report-inputs.json', directory / 'profile-index.json', *sorted(charts.glob('*')), *sorted((directory / 'profiles').glob('*')), *sorted((directory / 'stats').glob('*'))]
    generated = {"generatedAt": datetime.now().astimezone().isoformat(), "matplotlib": matplotlib.__version__, "numpy": np.__version__, "python": platform.python_version(), "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "tierGroupsSha256": hashlib.sha256(Path(__file__).with_name("tier_groups.py").read_bytes()).hexdigest(), "comparisonGroups": {tier: [p["id"] for p in items] for tier, items in groups}, "artifacts": {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts}}
    (directory / 'report-provenance.json').write_text(json.dumps(generated, indent=2), encoding='utf-8')
    print(f"Rendered {len(list(charts.glob('*.png')))} charts and {directory / 'report.html'}")


if __name__ == '__main__':
    main()
