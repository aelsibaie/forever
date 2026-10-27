"""Render the native audit and explicitly scoped cross-engine diagnostics."""
import argparse
import csv
import html
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument("audit", type=Path)
parser.add_argument("--comparison", type=Path)
parser.add_argument("--probes", type=Path)
parser.add_argument("--primary-run", type=Path)
args = parser.parse_args()
read = lambda p: json.loads(p.read_text(encoding="utf-8"))
audit = read(args.audit / "audit.json")
provenance = read(args.audit / "provenance.json")
completion = read(args.audit / "completion.json")
assert completion["profiles"] == len(audit["profiles"])
assert all(c["equivalent"] for c in audit["controls"]), "Investigate non-equivalent guard controls before reporting."
e = lambda v: html.escape(str(v), quote=True)

def write_csv(path, rows):
    if not rows:
        return
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in row.items()} for row in rows)

write_csv(args.audit / "variants.csv", audit["variants"])
gear_scale = []
if args.primary_run:
    primary_provenance = read(args.primary_run / "provenance.json")
    assert primary_provenance["engine"]["sha256"] == audit["settings"]["sourceEngine"]
    cells = read(args.primary_run / "cells.json")
    for row in audit["variants"]:
        if row["kind"] != "revelation-enchant":
            continue
        peers = [c["meanDps"] for c in cells if c["profileId"] == row["profileId"] and c["faction"] == row["faction"] and c["duration"] == row["duration"] and c["key"].endswith("--developer")]
        gear_scale.append({"profileId": row["profileId"], "faction": row["faction"], "race": row["race"], "duration": row["duration"], "enchantGainPercent": row["gainPercent"], "observedRacialSpreadPercent": 100 * (max(peers) / min(peers) - 1), "scope": "Full-support baseline race spread within this same developer build; model uncertainty excluded."})
    write_csv(args.audit / "gear-vs-racial.csv", gear_scale)
write_csv(args.audit / "coverage.csv", [{"faction": p["faction"], "profileId": p["id"], "class": p["className"], "races": p["races"], "missingWeaponEnchants": len(p["gearGaps"]), "manaCases": p["manaCases"], "warnings": p["findings"], "controls": len(p["controls"])} for p in audit["profiles"]])
charts = args.audit / "charts"
charts.mkdir(exist_ok=True)
plt.rcParams.update({"figure.facecolor": "#0b1220", "axes.facecolor": "#111e31", "text.color": "#edf3fc", "axes.labelcolor": "#b4c6df", "xtick.color": "#b4c6df", "ytick.color": "#d4e2f4", "axes.edgecolor": "#30415c", "font.family": "DejaVu Sans", "font.size": 10, "savefig.facecolor": "#0b1220"})
figures = []
for kind, title in [("revelation-enchant", "One missing enchant can outweigh a racial difference"), ("read-leyline", "Adding Read Leyline is not automatically a DPS improvement")]:
    rows = [r for r in audit["variants"] if r["kind"] == kind]
    if not rows:
        continue
    ids = sorted(set(r["profileId"] for r in rows))
    fig, axes = plt.subplots(1, 3, figsize=(17, max(4.8, len(ids) * .4 + 2.5)), sharey=True, sharex=True)
    for ax, duration in zip(axes, [60, 180, 300]):
        for i, pid in enumerate(ids):
            values = [r["gainPercent"] for r in rows if r["profileId"] == pid and r["duration"] == duration]
            ax.plot([min(values), max(values)], [i, i], color="#79c9ff", lw=5, solid_capstyle="round")
            for value in values:
                ax.scatter(value, i, s=18, color="#9edaff", alpha=.6)
        ax.axvline(0, color="#92a5c3", lw=1)
        ax.set_title(f"{duration} seconds", fontweight="bold", pad=15)
        ax.set_xlabel("DPS change (%)")
        ax.grid(axis="x", alpha=.12)
        ax.spines[["top", "right"]].set_visible(False)
    names = {p["id"]: p["className"] + " · " + p["name"] for p in audit["profiles"]}
    axes[0].set_yticks(range(len(ids)), [names[p] for p in ids])
    axes[0].invert_yaxis()
    fig.suptitle(title, x=.03, ha="left", fontsize=20, fontweight="bold")
    sample_sizes = "/".join(f'{n:,}' for n in sorted(set(r["iterations"] for r in rows)))
    fig.text(.03, .025, "Each dot is a race/build case; lines span races, not confidence intervals. Exact paired 95% intervals are in the table and CSV.\nWoWSims " + audit["settings"]["sourceCommit"][:12] + " · native engine " + audit["settings"]["sourceEngine"][:12] + " · " + sample_sizes + " iterations/case · seed 2026102707 · provisional Revelation model", fontsize=9, color="#9cafca")
    fig.tight_layout(rect=(0, .11, 1, .93))
    for ext in ["png", "svg"]:
        fig.savefig(charts / (kind + "." + ext), dpi=160)
    plt.close(fig)
    figures.append(f'<figure><img src="charts/{kind}.png" alt="{e(title)}"><figcaption>{e(title)}. These are explicit sensitivity experiments, not optimized gear sets.</figcaption></figure>')

variant_rows = "".join(f'<tr><td>{e(r["faction"])}</td><td>{e(r["profileId"])}</td><td>{e(r["race"].removeprefix("Race"))}</td><td>{r["duration"]}s</td><td>{e(r["kind"])}</td><td>{r["referenceDps"]:.2f}</td><td>{r["changedDps"]:.2f}</td><td>{r["gainDps"]:+.2f} ± {r["ci95HalfWidthDps"]:.2f}</td><td>{r["gainPercent"]:+.2f}%</td><td><a href="requests/{r["key"]}.json">Input</a></td></tr>' for r in audit["variants"])
coverage_rows = "".join(f'<tr><td>{e(p["faction"])}</td><td>{e(p["className"])}</td><td>{e(p["id"])}</td><td>{len(p["races"])}</td><td>{len(p["gearGaps"])}</td><td>{len(p["manaCases"])}</td><td>{len(p["controls"])}</td><td>{sum(f["severity"] not in ["Disabled", "Guarded inactive"] for f in p["findings"])}</td></tr>' for p in audit["profiles"])
engine_sections = []
for directory, title in [(args.comparison, "Developer-rotation compatibility"), (args.probes, "Common-spell engine probes")]:
    if directory is None:
        continue
    data = read(directory / "results.json")
    scope = read(directory / "provenance.json")["scope"]
    write_csv(directory / "coverage.csv", data["coverage"])
    write_csv(directory / "summary.csv", data["rows"])
    pairs = []
    for row in data["rows"]:
        if row["engine"] != "wowsims":
            continue
        other = next((r for r in data["rows"] if r["engine"] == "gunba" and all(r[k] == row[k] for k in ["profileId", "faction", "race", "duration"])), None)
        if other:
            half = (row["ci95HalfWidth"] ** 2 + other["ci95HalfWidth"] ** 2) ** .5
            pairs.append({"profileId": row["profileId"], "faction": row["faction"], "race": row["race"], "duration": row["duration"], "wowsimsDps": row["meanDps"], "gunbaDps": other["meanDps"], "differenceDps": other["meanDps"] - row["meanDps"], "ci95HalfWidthDps": half, "scope": title})
    write_csv(directory / "differences.csv", pairs)
    coverage_table = "".join(f'<tr><td>{e(c["faction"])}</td><td>{e(c["id"])}</td><td>{e(c["status"])}; completed races: {e(", ".join(c["races"]) or "none")}</td><td>{e(c["reason"])}</td></tr>' for c in data["coverage"])
    comparisons = "".join(f'<tr><td>{e(r["profileId"])}</td><td>{e(r["race"])}</td><td>{r["duration"]}s</td><td>{r["wowsimsDps"]:.2f}</td><td>{r["gunbaDps"]:.2f}</td><td>{r["differenceDps"]:+.2f} ± {r["ci95HalfWidthDps"]:.2f}</td></tr>' for r in pairs)
    body = f'<h1>{title}</h1><p>{e(scope)}</p><p>Independent engine streams, {data["settings"]["iterations"]:,} iterations per cell. Intervals express Monte Carlo error only. Neither table establishes which engine is correct. A successful execution does not establish mechanic parity.</p><p><a href="provenance.json">Provenance</a> · <a href="coverage.csv">Coverage CSV</a> · <a href="differences.csv">Differences CSV</a> · <a href="results.json">All metrics and hashes</a></p><h2>Coverage and blockers</h2><table><tr><th>Faction</th><th>Build</th><th>Status</th><th>Reason</th></tr>{coverage_table}</table><h2>Diagnostic outputs</h2><table><tr><th>Build</th><th>Race</th><th>Duration</th><th>WoWSims DPS</th><th>Gunba DPS</th><th>Gunba − WoWSims ±95% half-width</th></tr>{comparisons}</table>'
    engine_sections.append((directory, title, body))

style = 'body{background:#0b1220;color:#edf3fc;font:16px/1.65 system-ui;margin:0}main{max-width:1450px;margin:auto;padding:32px}a{color:#81caff}h1{font-size:38px;line-height:1.15}h2{margin-top:38px}p{max-width:1050px}img{width:100%;height:auto}figure{margin:30px 0}figcaption,small{color:#a3b5cf}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px;border-bottom:1px solid #293d59;text-align:left}th{background:#182940;position:sticky;top:0}code{overflow-wrap:anywhere}.scroll{overflow:auto}section{background:#111e31;padding:24px;border-radius:14px;margin:24px 0}'
def document(title, body):
    return f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(title)}</title><style>{style}</style><main>{body}</main></html>'
for directory, title, body in engine_sections:
    (directory / "report.html").write_text(document(title, body), encoding="utf-8")
body = f'<h1>All-spec and race audit</h1><p>{len(audit["profiles"])} faction/build entries across all nine classes. {len(audit["controls"])} native guard controls passed every iteration; {len(audit["variants"])} explicit sensitivity cases ran at 60, 180 and 300 seconds. This screens presets and measures specific alternatives; it does not validate every class mechanic.</p><section><h2>What changes the interpretation</h2><p>Several caster reference weapons lack a permanent enchant. Adding Revelation (8217) is a narrow, labeled alternative with identical items, talents and encounter. Its current flat proc model is provisional. These gains do not establish an optimal set or justify mixing gear tiers in class rankings.</p><p>The Shadow Brand warning refers to Revelation, which is absent from the unenchanted fallback weapon. Its known-aura guard disables that branch. Constant-false native controls preserve every iteration: this warning alone is not a broken rotation. Other warnings remain available for review.</p><p>Read Leyline belongs to High Order Skyborne. Prepending it at ≤65% mana can cost damage through timing and channel interactions. These cases show why a missing mana action should be tested before recommending it.</p><p>Item-based known-spell guards are left unresolved by the metadata screen. An earlier exploratory classifier treated item IDs as absent spell IDs and failed eight controls; those exploratory outputs are superseded by this corrected audit.</p></section><p><a href="coverage.csv">Coverage CSV</a> · <a href="variants.csv">Every sensitivity and 95% interval</a> · <a href="audit.json">Warnings and controls</a> · <a href="provenance.json">Exact provenance</a></p>' + ''.join(figures) + f'<h2>Complete coverage</h2><p>Counts refer to race/time cases. Warning counts include unresolved and actionable diagnostics; they are not a count of confirmed defects. The exported aliases and excluded Mutilate builds remain explicitly listed in audit.json.</p><div class="scroll"><table><tr><th>Faction</th><th>Class</th><th>Build</th><th>Races</th><th>Missing enchants</th><th>Mana cases</th><th>Exact controls</th><th>Other warning lines</th></tr>{coverage_rows}</table></div><h2>Every tested alternative</h2><p>Paired differences share seeds within WoWSims. ± denotes the 95% Monte Carlo half-width in DPS; model and gear uncertainty are larger than sampling error in some cases. Baselines are preserved.</p><div class="scroll"><table><tr><th>Faction</th><th>Build</th><th>Race</th><th>Time</th><th>Variant</th><th>Baseline</th><th>Alternative</th><th>Δ DPS ±95%</th><th>Δ %</th><th>Exact input</th></tr>{variant_rows}</table></div><p>Source simulator <code>{e(audit["settings"]["sourceCommit"])}</code>; tool hashes and archived source provenance accompany this report.</p>'
if gear_scale:
    larger = sum(r["enchantGainPercent"] > r["observedRacialSpreadPercent"] for r in gear_scale)
    body += f'<section><h2>Gear effect beside racial spread</h2><p>In {larger} of {len(gear_scale)} tested race/time cases, the measured missing-enchant gain exceeded the observed best-to-worst racial spread in the same full-support developer build. This is a scale comparison under the current model; it does not establish optimal gear or mechanic accuracy.</p><p><a href="gear-vs-racial.csv">Every enchant gain beside its build’s racial spread</a></p></section>'
(args.audit / "report.html").write_text(document("All-spec and race audit", body), encoding="utf-8")
for directory in [args.audit] + [d for d, _, _ in engine_sections]:
    artifacts = {str(p.relative_to(directory)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.rglob("*") if p.is_file() and (p.suffix in [".html", ".csv", ".png", ".svg"])}
    (directory / "report-provenance.json").write_text(json.dumps({"toolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "artifacts": artifacts}, indent=2), encoding="utf-8")
print(f'Rendered audit, {len(engine_sections)} engine reports, and standalone charts in {args.audit}')
