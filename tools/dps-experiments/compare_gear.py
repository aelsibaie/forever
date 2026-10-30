"""Compare matched experiments whose requests differ only in equipment."""

import argparse
import csv
import hashlib
import html
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm
import numpy as np
from report import COLORS, SPECS, BG, PANEL, TEXT, MUTED, GRID


def load(directory, filename):
    return json.loads((directory / filename).read_text(encoding='utf-8'))


def without_gear(request):
    result = json.loads(json.dumps(request))
    for party in result['raid']['parties']:
        for player in party['players']:
            player.pop('equipment', None)
            if player.get('itemSwap'):
                player['itemSwap'].pop('items', None)
    return result


def compare(directory):
    provenance = load(directory, 'provenance.json')
    reference = Path(provenance['reference']['directory'])
    old_provenance = load(reference, 'provenance.json')
    if provenance['sourceSha256'] != old_provenance['sourceSha256']:
        raise ValueError('Simulator source snapshots differ.')
    previous = {(r['profileId'], r['duration']): r for r in load(reference, 'summary.json')['rows']}
    current = load(directory, 'summary.json')
    if current['failures']:
        raise ValueError('The current experiment contains failed runs.')
    profiles = {p['id']: p for p in load(directory, 'profiles.json')['profiles']}
    rows = []
    durations = provenance['config']['durations']
    for row in current['rows']:
        key = row['profileId'], row['duration']
        old = previous[key]
        filename = f'{key[0]}--{key[1]}s.json'
        old_request, new_request = load(reference / 'requests', filename), load(directory / 'requests', filename)
        if without_gear(old_request) != without_gear(new_request):
            raise ValueError(f'Non-gear settings differ: {filename}')
        if old['iterations'] != row['iterations']:
            raise ValueError('Matched iteration counts differ.')
        old_values = load(reference / 'results', filename)['raidMetrics']['parties'][0]['players'][0]['dps']['allValues']
        new_values = load(directory / 'results', filename)['raidMetrics']['parties'][0]['players'][0]['dps']['allValues']
        differences = np.asarray(new_values) - np.asarray(old_values)
        paired_ci = 1.959963984540054 * differences.std(ddof=1) / np.sqrt(len(differences))
        delta = row['meanDps'] - old['meanDps']
        rows.append({**row, 'oldMeanDps': old['meanDps'], 'oldCi95HalfWidth': old['ci95HalfWidth'], 'dpsDelta': delta, 'percentDelta': 100 * delta / old['meanDps'], 'pairedDeltaCi95': float(paired_ci), 'newGearMeanIlvl': profiles[key[0]]['gearMeanIlvl']})
    for duration in durations:
        selected = [r for r in rows if r['duration'] == duration and r['rankEligible']]
        old_ranks = {r['profileId']: i + 1 for i, r in enumerate(sorted(selected, key=lambda r: r['oldMeanDps'], reverse=True))}
        new_ranks = {r['profileId']: i + 1 for i, r in enumerate(sorted(selected, key=lambda r: r['meanDps'], reverse=True))}
        for row in rows:
            if row['duration'] == duration:
                row.update(oldRank=old_ranks.get(row['profileId']), newRank=new_ranks.get(row['profileId']))
    return provenance, profiles, rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    manifest, profiles, rows = compare(directory)
    durations = manifest['config']['durations']
    ref_duration = 180
    lookup = {(r['profileId'], r['duration']): r for r in rows}
    ranked = sorted([r for r in rows if r['duration'] == ref_duration and r['rankEligible']], key=lambda r: r['meanDps'], reverse=True)
    commit = manifest['git']['commit']
    game_build = ', '.join(sorted(set(manifest['gameBuilds'].values())))
    stamp = datetime.fromisoformat(manifest['startedAt'].replace('Z', '+00:00')).astimezone(ZoneInfo('America/New_York'))
    footer = f"SOURCE {commit[:12]} | GAME {game_build} | {manifest['config']['iterations']:,} ITERATIONS / CELL | SEED {manifest['config']['seed']} | {stamp:%b %d, %Y %H:%M %Z}"
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'figure.facecolor': BG, 'axes.facecolor': PANEL, 'text.color': TEXT, 'axes.labelcolor': MUTED, 'xtick.color': MUTED, 'ytick.color': TEXT, 'axes.edgecolor': GRID, 'savefig.facecolor': BG, 'svg.fonttype': 'none'})
    charts = directory / 'charts'
    charts.mkdir(exist_ok=True)

    def title(fig, heading, sub):
        fig.text(.055, .976, 'WOWSIMS FOREVER / MATCHED GEAR EXPERIMENT', size=10, color='#81DDCA', weight='bold', va='top')
        fig.text(.055, .944, heading, size=24, weight='bold', va='top')
        fig.text(.055, .908, sub, size=10, color=MUTED, va='top')

    def finish(fig, name):
        fig.text(.055, .032, footer, size=7.3, color=MUTED)
        fig.text(.055, .015, 'Conservative acquisition and item-level policy; no permanent enchants. Static role selection, not optimized BiS. All models are Alpha.', size=8, color=MUTED)
        for extension in ['png', 'svg']:
            fig.savefig(charts / f'{name}.{extension}', dpi=180)
        plt.close(fig)

    best, seen = [], set()
    for row in ranked:
        if row['specPath'] not in seen:
            best.append(row)
            seen.add(row['specPath'])
    fig, axs = plt.subplots(1, 3, figsize=(17.4, 8.8), sharex=True, sharey=True)
    fig.subplots_adjust(left=.29, right=.96, top=.83, bottom=.15, wspace=.13)
    max_dps = max(lookup[r['profileId'], d]['meanDps'] for r in best for d in durations) * 1.17
    for ax, duration in zip(axs, durations):
        data = [lookup[r['profileId'], duration] for r in best]
        ax.barh(range(len(best)), [r['meanDps'] for r in data], color=[COLORS[r['className']] for r in data], height=.58, alpha=.9, zorder=2)
        ax.errorbar([r['meanDps'] for r in data], range(len(best)), xerr=[r['ci95HalfWidth'] for r in data], fmt='none', ecolor='#24334C', capsize=2.5, zorder=3)
        for i, row in enumerate(data):
            ax.text(row['meanDps'] + max_dps * .018, i, f"{row['meanDps']:,.0f}", va='center', size=9, weight='bold')
        ax.set_yticks(range(len(best)), [f"{SPECS[r['specPath']]} / {r['buildName']}" for r in best], size=9.5)
        ax.set_ylim(len(best) - .3, -.7)
        ax.set_xlim(0, max_dps)
        ax.set_title(f'{duration} seconds', loc='left', pad=16, size=15, weight='bold', color='#81DDCA' if duration == 180 else TEXT)
        ax.set_axisbelow(True)
        ax.grid(axis='x', color=GRID, alpha=.7)
        for spine in ax.spines.values(): spine.set_visible(False)
        ax.tick_params(length=0, pad=10)
        ax.set_xlabel('Mean damage per second', labelpad=12, size=9)
    title(fig, 'The conservative pre-raid comparison', 'Highest new 180s profile per DPS simulator; the same build appears at every duration. Bars show pointwise 95% Monte Carlo CI.')
    finish(fig, 'pre-raid-overview')

    fig, ax = plt.subplots(figsize=(15.5, len(ranked) * .34 + 3))
    fig.subplots_adjust(left=.32, right=.83, top=.85, bottom=.10)
    maximum = max(max(r['oldMeanDps'], r['meanDps']) for r in ranked) * 1.12
    for y, row in enumerate(ranked):
        ax.plot([row['oldMeanDps'], row['meanDps']], [y, y], color=COLORS[row['className']], lw=2, alpha=.55)
        ax.scatter(row['oldMeanDps'], y, s=35, facecolor=BG, edgecolor=MUTED, zorder=3)
        ax.scatter(row['meanDps'], y, s=32, marker='D', color=COLORS[row['className']], zorder=4)
        ax.errorbar(row['meanDps'], y, xerr=row['ci95HalfWidth'], fmt='none', ecolor=TEXT, capsize=2)
        ax.text(maximum * 1.025, y, f"{row['percentDelta']:+.1f}%", va='center', size=9, color='#82DDCA' if row['percentDelta'] > 0 else '#E2A0AA')
    ax.set_yticks(range(len(ranked)), [f"{SPECS[r['specPath']]} / {r['buildName']}" for r in ranked], size=9)
    ax.set_ylim(len(ranked) - .3, -.7)
    ax.set_xlim(0, maximum)
    ax.grid(axis='x', color=GRID, alpha=.6)
    ax.set_xlabel('Mean DPS at 180 seconds', labelpad=12)
    ax.tick_params(length=0, pad=10)
    for spine in ax.spines.values(): spine.set_visible(False)
    title(fig, 'What changed when the gear changed?', 'Hollow circle = previous preset gear. Colored diamond = pre-raid policy. All non-gear request fields are identical.')
    finish(fig, 'gear-impact')

    effects = sorted(ranked, key=lambda r: r['percentDelta'], reverse=True)
    values = np.array([[lookup[r['profileId'], d]['percentDelta'] for d in durations] for r in effects])
    limit = max(10, np.ceil(np.abs(values).max() / 10) * 10)
    fig, ax = plt.subplots(figsize=(13.5, len(effects) * .3 + 3))
    fig.subplots_adjust(left=.40, right=.88, top=.85, bottom=.11)
    cmap = LinearSegmentedColormap.from_list('gear', ['#D97581', '#17253A', '#7CDDC5'])
    image = ax.imshow(values, aspect='auto', cmap=cmap, norm=TwoSlopeNorm(vmin=-limit, vcenter=0, vmax=limit))
    ax.set_yticks(range(len(effects)), [f"{SPECS[r['specPath']]} / {r['buildName']}" for r in effects], size=9)
    ax.set_xticks(range(3), [f'{d} seconds' for d in durations], size=12)
    ax.tick_params(length=0, pad=10)
    for i in range(len(effects)):
        for j in range(3): ax.text(j, i, f'{values[i,j]:+.1f}%', ha='center', va='center', size=9)
    fig.colorbar(image, ax=ax, fraction=.035, pad=.05).set_label('DPS change from previous gear (%)', size=9)
    title(fig, 'Gear sensitivity across fight lengths', 'Each cell compares the same saved build, rotation, support and encounter. Percentages are relative to its previous gear.')
    finish(fig, 'gear-impact-by-duration')

    fields = ['profileId', 'className', 'buildName', 'duration', 'iterations', 'oldMeanDps', 'meanDps', 'dpsDelta', 'percentDelta', 'pairedDeltaCi95', 'oldRank', 'newRank', 'newGearMeanIlvl', 'rankEligible']
    with (directory / 'gear-comparison.csv').open('w', newline='', encoding='utf-8') as file:
        writer = csv.DictWriter(file, fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    (directory / 'gear-comparison.json').write_text(json.dumps({'rows': rows, 'nonGearFieldsIdentical': True, 'matchedSeed': manifest['config']['seed']}, indent=2), encoding='utf-8')

    def svg(name):
        text = (charts / f'{name}.svg').read_text(encoding='utf-8')
        return text[text.index('<svg'):]
    def definition(label, value): return f'<dt>{html.escape(label)}</dt><dd>{html.escape(str(value))}</dd>'
    policy = manifest['gearPolicy']
    statistics = []
    for duration in durations:
        subset = [r for r in rows if r['duration'] == duration and r['rankEligible']]
        a, b = np.array([r['oldRank'] for r in subset]), np.array([r['newRank'] for r in subset])
        statistics.append({'duration': duration, 'rankCorrelation': float(np.corrcoef(a, b)[0,1]), 'medianPercentDelta': float(np.median([r['percentDelta'] for r in subset])), 'largestRankMove': max(abs(r['oldRank']-r['newRank']) for r in subset)})
    stat180 = next(s for s in statistics if s['duration'] == 180)
    research = ''.join(f"<li><a href='{html.escape(s['url'])}'>{html.escape(s.get('title', 'Acquisition reference'))}</a>: {html.escape(s.get('note',''))}</li>" for s in policy['research'] if 'url' in s)
    notes = ''.join(f'<li>{html.escape(n)}</li>' for n in policy['notes'])
    record = ''.join(definition(k,v) for k,v in [('Source commit',commit),('Game build',game_build),('Started, America/New_York',stamp.strftime('%Y-%m-%d %H:%M %Z')),('Native Go',manifest['environment']['go']),('Node',manifest['environment']['node']),('Seed / iterations per cell',f"{manifest['config']['seed']} / {manifest['config']['iterations']:,}"),('Eligible item pool',manifest['eligiblePoolSize']),('Gear policy SHA-256',manifest['gearPolicySha256']),('Source SHA-256',manifest['sourceSha256']),('Sources unchanged during run',manifest['sourceUnchangedDuringRun'])])
    payload = json.dumps({'durations': durations, 'rows': [{k:r.get(k) for k in fields} for r in rows], 'profiles': [{k:p.get(k) for k in ['id','name','className','specPath','gearMeanIlvl','gearAudit']} for p in profiles.values()], 'colors':COLORS, 'specs':SPECS}).replace('<','\\u003c')
    template = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WoWSims Forever · Pre-raid gear comparison</title><style>
    :root{color-scheme:dark;--bg:#0c1423;--panel:#121e30;--line:#29374d;--text:#edf2fa;--muted:#a3b3cc;--mint:#81ddca}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:46px 5vw 70px}.eyebrow{color:var(--mint);font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:750}h1{font-size:clamp(38px,5vw,64px);line-height:1.08;letter-spacing:-.045em;max-width:950px;margin:16px 0}h2{font-size:27px;line-height:1.3;letter-spacing:-.025em}p,li{color:var(--muted)}b,strong{color:var(--text)}a{color:var(--mint);text-decoration:none}a:hover{text-decoration:underline}.meta,.links,.controls{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}.chip{border:1px solid var(--line);border-radius:30px;padding:6px 13px;font-size:12px;color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}.card{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:22px}.card strong{font-size:29px;display:block}.card span{font-size:12px;color:var(--muted)}.note{border-left:3px solid #e8b57e;background:#1b2230;padding:15px 20px;border-radius:0 10px 10px 0;color:#e4d0b6}.section{margin-top:48px}.chart{border:1px solid var(--line);border-radius:16px;overflow:hidden;margin-top:20px}.chart svg{display:block;width:100%;height:auto}input,select,button{background:#17253a;color:var(--text);font:inherit;border:1px solid #34455d;border-radius:8px;padding:9px 12px}button{cursor:pointer}.scroll{overflow:auto;border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}td,th{padding:12px 14px;border-bottom:1px solid var(--line)}th{text-transform:uppercase;letter-spacing:.05em;font-size:10px;color:var(--muted);text-align:left;white-space:nowrap;background:#17253a}.num{text-align:right}td small{display:block;color:var(--muted);font-size:11px}.gain{color:#81ddca}.loss{color:#e4a2ac}details{padding:17px 22px;border:1px solid var(--line);border-radius:14px;margin:20px 0}summary{cursor:pointer;font-weight:650}li{margin:12px 0}dl{background:var(--panel);padding:25px;border:1px solid var(--line);border-radius:14px}dt{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:12px}dd{margin:4px 0 0;overflow-wrap:anywhere;font-size:13px}pre{white-space:pre-wrap;color:var(--muted);font-size:12px}footer{border-top:1px solid var(--line);margin-top:40px;padding-top:20px;color:var(--muted);font-size:12px}@media(max-width:800px){main{padding:26px 18px}.cards{grid-template-columns:repeat(2,1fr)}.chart{overflow:auto}.chart svg{min-width:800px}.controls>*{width:100%}}
    </style><main><div class="eyebrow">WoWSims Forever / matched experiment 002</div><h1>Same builds.<br>A shared pre-raid policy.</h1><p>40 saved profiles, three fight lengths and 1.2 million simulated fights. The previous requests are frozen; only equipment and swap equipment change.</p><div class="meta">__META__</div><div class="cards">__CARDS__</div><div class="note"><b>What this measures:</b> the effect of replacing each previous kit with the documented conservative gear policy, including removal of permanent enchants. It is not a percentage decomposition of class strength. Remaining differences include talents, rotations, consumables, professions, gear fit and Alpha model behavior.</div>
    <section class="section"><h2>The new 60 / 180 / 300-second comparison</h2><p>Highest new 180-second build per DPS simulator, held fixed across durations. The full matrix below includes every supported build.</p><div class="chart" role="img" aria-label="Pre-raid mean DPS comparison at three durations">__OVERVIEW__</div><div class="links"><a href="charts/pre-raid-overview.png">PNG</a><a href="charts/pre-raid-overview.svg">SVG</a><a href="gear-comparison.csv">Comparison CSV</a></div></section>
    <section class="section"><h2>How much did changing gear move each build?</h2><p>The grey circles show the previous gear and colored diamonds show the pre-raid policy. Profiles are ordered by new 180-second DPS.</p><div class="chart" role="img" aria-label="Previous versus pre-raid DPS for every supported build">__IMPACT__</div><div class="links"><a href="charts/gear-impact.png">PNG</a><a href="charts/gear-impact.svg">SVG</a></div></section>
    <section class="section"><h2>Inspect the results</h2><div class="controls"><input id="search" aria-label="Search profiles" placeholder="Search class or build…"><select id="duration" aria-label="Duration"></select><label><input type="checkbox" id="diagnostic"> Include diagnostic Mutilate profiles</label></div><div class="scroll"><table><thead><tr><th>Build</th><th class="num">Previous DPS</th><th class="num">Pre-raid DPS</th><th class="num">Change ± paired 95% CI</th><th class="num">Change %</th><th class="num">Rank before → after</th><th class="num">Mean equipped ilvl</th></tr></thead><tbody id="matrix"></tbody></table></div><p>Rank numbers are descriptive ordering of estimated means. Confidence intervals on differences pair the same iteration seeds within the same build. They do not correct for multiple comparisons.</p></section>
    <section class="section"><h2>Gear sensitivity by fight duration</h2><div class="chart" role="img" aria-label="Percent DPS changes from replacing gear at each duration">__HEATMAP__</div><div class="links"><a href="charts/gear-impact-by-duration.png">PNG</a><a href="charts/gear-impact-by-duration.svg">SVG</a></div></section>
    <section class="section"><h2>Every item, with its source decision</h2><p>The pool is restricted by acquisition, quality and item level. Item level is a budget ceiling, not a guarantee of equal power. Caster weapons share one kit; other weapon families preserve their talent and rotation requirements.</p><select id="gearprofile" aria-label="Gear profile"></select><div class="scroll" style="margin-top:18px"><table><thead><tr><th>Slot</th><th>Previous item</th><th>Pre-raid item</th><th class="num">Old → new ilvl</th><th>Source / decision</th></tr></thead><tbody id="gearrows"></tbody></table></div></section>
    <section class="section"><h2>Policy, evidence and limitations</h2><ul>__NOTES__</ul><p>__CRAFTING__</p><p>Some formula acquisition records are provisional in beta. This is a reproducible known-source baseline, not a claim that the pool includes every obtainable pre-raid item. Missing legal relic options stay empty and are shown above. Available crafting professions are frozen from the original profiles.</p><p>Recipe materials matter: raid-material crafted sets are excluded even if their item level or rarity fits the budget. All gear statistics come from the same local game files snapshot as the reference run; web sources inform acquisition review only.</p><details><summary>Acquisition research</summary><ul>__RESEARCH__</ul></details><details><summary>Exact policy and static role weights</summary><pre>__POLICY__</pre></details></section>
    <section class="section"><h2>Provenance</h2><dl>__RECORD__</dl><div class="links"><a href="provenance.json">Complete provenance</a><a href="gear-audit.json">Gear audit JSON</a><a href="gear-comparison.json">Matched comparisons</a><a href="summary.csv">New-run CSV</a><a href="../baseline-2026-10-24-reviewed/report.html">Previous report</a></div></section><footer>Every compared request was checked for identical non-gear fields. Raw requests and results remain beside this report. Two unsupported Mutilate rotations remain diagnostic only. This report loads no external scripts or assets.</footer></main><script>const DATA=__DATA__;
    const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const fmt=(x,n=1)=>Number(x).toLocaleString('en-US',{minimumFractionDigits:n,maximumFractionDigits:n});const duration=document.querySelector('#duration');DATA.durations.forEach((d,i)=>{const o=document.createElement('option');o.textContent=d+' seconds';o.value=i;duration.append(o);if(d===180)duration.value=i});
    function render(){const d=DATA.durations[+duration.value],q=document.querySelector('#search').value.toLowerCase(),show=document.querySelector('#diagnostic').checked;const rows=DATA.rows.filter(r=>r.duration===d&&(show||r.rankEligible)&&[r.className,r.buildName,r.profileId].join(' ').toLowerCase().includes(q)).sort((a,b)=>b.meanDps-a.meanDps);document.querySelector('#matrix').innerHTML=rows.map(r=>`<tr><td><b>${esc(DATA.specs[DATA.profiles.find(p=>p.id===r.profileId).specPath])}</b><small>${esc(r.buildName)}${r.rankEligible?'':' · diagnostic'}</small></td><td class="num">${fmt(r.oldMeanDps)}</td><td class="num"><b>${fmt(r.meanDps)}</b></td><td class="num ${r.dpsDelta>=0?'gain':'loss'}">${r.dpsDelta>=0?'+':''}${fmt(r.dpsDelta)}<small>± ${fmt(r.pairedDeltaCi95,2)}</small></td><td class="num">${r.percentDelta>=0?'+':''}${fmt(r.percentDelta)}%</td><td class="num">${r.oldRank??'—'} → ${r.newRank??'—'}</td><td class="num">${fmt(r.newGearMeanIlvl)}</td></tr>`).join('')}
    for(const id of ['search','duration','diagnostic'])document.querySelector('#'+id).addEventListener(id==='search'?'input':'change',render);const gp=document.querySelector('#gearprofile');DATA.profiles.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=DATA.specs[p.specPath]+' / '+p.name;gp.append(o)});function gear(){const p=DATA.profiles.find(p=>p.id===gp.value);document.querySelector('#gearrows').innerHTML=p.gearAudit.map(a=>`<tr><td>${esc(a.slot.replace('ItemSlot',''))}${a.swap?' (swap)':''}</td><td>${esc(a.oldName)}<small>${a.oldId}</small></td><td>${esc(a.name)}<small>${a.id||'Empty'}${a.preservedForRotation?' · rotation requirement':''}</small></td><td class="num">${a.oldIlvl??'—'} → ${a.ilvl||'—'}</td><td>${esc(a.reason)}<small>${esc(a.source?JSON.stringify(a.source):'No approved option')}</small></td></tr>`).join('')}gp.addEventListener('change',gear);render();gear();</script></html>'''
    replacements={'__META__':f'<span class="chip">Source <b>{commit[:12]}</b></span><span class="chip">Game <b>{game_build}</b></span><span class="chip">{stamp:%b %d, %Y · %H:%M %Z}</span>', '__CARDS__': ''.join(f'<div class="card"><strong>{value}</strong><span>{label}</span></div>' for value,label in [(len(profiles),'saved profiles'),(len(rows),'completed comparisons'),(f"{stat180['rankCorrelation']:.2f}",'rank correlation before / after at 180s'),(f"{stat180['medianPercentDelta']:+.1f}%",'median gear-change effect at 180s')]),'__OVERVIEW__':svg('pre-raid-overview'),'__IMPACT__':svg('gear-impact'),'__HEATMAP__':svg('gear-impact-by-duration'),'__NOTES__':notes,'__CRAFTING__':html.escape(policy['craftingNotes']),'__RESEARCH__':research,'__POLICY__':html.escape(json.dumps({'policy':policy,'roleWeights':manifest['gearRoleWeights']},indent=2)),'__RECORD__':record,'__DATA__':payload}
    for key,value in replacements.items(): template=template.replace(key,value)
    (directory/'report.html').write_text(template,encoding='utf-8')
    verification={'generatedAt':datetime.now().astimezone().isoformat(),'comparedRuns':len(rows),'nonGearFieldsIdentical':True,'statistics':statistics,'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'matplotlib':matplotlib.__version__,'numpy':np.__version__,'artifacts':{str(file.relative_to(directory)):hashlib.sha256(file.read_bytes()).hexdigest() for file in [directory/'report.html',directory/'gear-comparison.csv',directory/'gear-comparison.json',*sorted(charts.glob('*'))]}}
    (directory/'comparison-provenance.json').write_text(json.dumps(verification,indent=2),encoding='utf-8')
    print(json.dumps({'runs':len(rows),'statistics':statistics,'report':str(directory/'report.html')},indent=2))


if __name__=='__main__': main()
