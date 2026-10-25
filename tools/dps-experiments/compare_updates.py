"""Compare saved inputs and refreshed presets across an upstream update."""

import argparse
import csv
import hashlib
import html
import json
from pathlib import Path
from datetime import datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import TwoSlopeNorm, LinearSegmentedColormap
import numpy as np
from report import BG, PANEL, TEXT, MUTED


def load(directory, filename):
    return json.loads((directory / filename).read_text(encoding='utf-8'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    directory = parser.parse_args().directory.resolve()
    frozen, current = directory / 'frozen-inputs', directory / 'developer-presets'
    fm, cm = load(frozen, 'provenance.json'), load(current, 'provenance.json')
    reference = Path(fm['frozenReference']['directory'])
    old_manifest = load(reference, 'provenance.json')
    if fm['sourceSha256'] != cm['sourceSha256'] or fm['schemaChanges']:
        raise ValueError('Source mismatch or changed frozen request schema; comparison needs explicit review.')
    if hashlib.sha256((reference / 'provenance.json').read_bytes()).hexdigest() != fm['frozenReference']['provenanceSha256']:
        raise ValueError('The saved reference provenance changed.')
    summaries = [load(root, 'summary.json') for root in [reference, frozen, current]]
    if any(s['failures'] for s in summaries):
        raise ValueError('A compared run has simulation failures.')
    old, saved, fresh = [{(r['profileId'], r['duration']): r for r in s['rows']} for s in summaries]
    unavailable = fm.get('frozenUnavailable', [])
    omitted = {p['id'] for p in unavailable}
    if not saved.keys() <= old.keys() or any(key[0] not in omitted for key in old.keys() - saved.keys()):
        raise ValueError('Frozen coverage differs without a recorded compatibility reason.')
    profiles = {p['id']: p for p in load(frozen, 'profiles.json')['profiles']}
    rows = []
    for key in saved:
        before = old[key]
        filename = f'{key[0]}--{key[1]}s.json'
        if load(reference / 'requests', filename) != load(frozen / 'requests', filename):
            raise ValueError(f'Frozen request differs: {filename}')
        a, b = saved[key], fresh.get(key)
        values = [load(root / 'results', filename)['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'] for root in [reference, frozen]]
        if len(values[0]) != len(values[1]) or before['iterations'] != a['iterations']:
            raise ValueError('Iteration counts differ.')
        delta = np.asarray(values[1]) - np.asarray(values[0])
        rows.append({'profileId': key[0], 'duration': key[1], 'spec': profiles[key[0]]['specLabel'], 'build': before['buildName'], 'rankEligible': before['rankEligible'] and a['rankEligible'], 'previousDps': before['meanDps'], 'frozenDps': a['meanDps'], 'currentDps': b['meanDps'] if b else None, 'enginePercent': 100 * (a['meanDps'] / before['meanDps'] - 1), 'engineDeltaCi95': float(1.959963984540054 * delta.std(ddof=1) / np.sqrt(len(delta))), 'presetPercent': 100 * (b['meanDps'] / a['meanDps'] - 1) if b else None})
    (directory / 'update-comparison.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')
    with (directory / 'update-comparison.csv').open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    selected = sorted([r for r in rows if r['duration'] == 180 and r['rankEligible']], key=lambda r: r['frozenDps'], reverse=True)
    values = np.array([[r['enginePercent'], r['presetPercent'] if r['presetPercent'] is not None else np.nan] for r in selected])
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'figure.facecolor': BG, 'axes.facecolor': PANEL, 'text.color': TEXT, 'xtick.color': TEXT, 'ytick.color': TEXT, 'savefig.facecolor': BG, 'svg.fonttype': 'none'})
    fig, ax = plt.subplots(figsize=(13.5, max(11, len(selected) * .32 + 3)))
    fig.subplots_adjust(left=.44, right=.87, top=.86, bottom=.11)
    limit = max(5, np.ceil(np.nanmax(np.abs(values)) / 5) * 5)
    im = ax.imshow(values, aspect='auto', cmap=LinearSegmentedColormap.from_list('change', ['#D97581', '#17253A', '#7CDDC5']), norm=TwoSlopeNorm(vmin=-limit, vcenter=0, vmax=limit))
    ax.set_yticks(range(len(selected)), [r['spec'] + ' / ' + r['build'] for r in selected], fontsize=9)
    ax.set_xticks([0, 1], ['Saved inputs\non new engine', 'Updated presets\non new engine'], fontsize=11)
    ax.tick_params(length=0, pad=12)
    for i, row in enumerate(values):
        for j, value in enumerate(row):
            ax.text(j, i, f'{value:+.1f}%' if np.isfinite(value) else 'No matching ID', ha='center', va='center', fontsize=9)
    fig.colorbar(im, ax=ax, fraction=.04, pad=.06).set_label('Change in mean DPS (%)', color=MUTED)
    upstream = cm['git']['upstreamSourceCommit']
    fig.text(.05, .97, 'WOWSIMS FOREVER / UPSTREAM UPDATE', color='#81DDCA', fontsize=11, weight='bold', va='top')
    fig.text(.05, .937, 'What changed after the update?', fontsize=25, weight='bold', va='top')
    fig.text(.05, .90, '180 seconds. Engine changes and preset changes are measured in separate steps.', color=MUTED, fontsize=11, va='top')
    fig.text(.05, .035, f"SIM {old_manifest['git']['commit'][:12]} → {upstream[:12]} | ANALYTICS {cm['git']['commit'][:12]} | 10,000 iterations / cell", color=MUTED, fontsize=8)
    fig.text(.05, .018, 'Frozen requests are identical. Updated presets can change gear, talents, rotations and other player settings. All models are Alpha.', color=MUTED, fontsize=8)
    for ext in ['png', 'svg']:
        fig.savefig(directory / f'update-impact.{ext}', dpi=180)
    plt.close(fig)
    svg = (directory / 'update-impact.svg').read_text(encoding='utf-8')
    svg = svg[svg.index('<svg'):]
    table = ''.join(f"<tr><td>{html.escape(r['spec'] + ' / ' + r['build'])}</td><td>{r['previousDps']:.1f}</td><td>{r['frozenDps']:.1f}</td><td>{r['currentDps']:.1f}</td><td>{r['enginePercent']:+.1f}%</td><td>{r['presetPercent']:+.1f}%</td></tr>" for r in selected if r['currentDps'] is not None)
    report = f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>WoWSims update comparison</title><style>body{{margin:40px auto;max-width:1200px;background:{BG};color:{TEXT};font:16px system-ui;line-height:1.6}}a{{color:#81DDCA}}svg{{width:100%;height:auto}}table{{width:100%;border-collapse:collapse}}td,th{{padding:10px;text-align:right;border-bottom:1px solid #29374D}}td:first-child,th:first-child{{text-align:left}}code{{color:#81DDCA}}.note{{padding:20px;background:{PANEL}}}</style><h1>Every spec, across the update.</h1><p>Simulator <code>{upstream}</code> · Analytics <code>{cm['git']['commit']}</code></p><p><a href="developer-presets/report.html">All current developer specs and builds: 60 / 180 / 300 seconds</a> · <a href="frozen-inputs/report.html">Saved profiles on the updated simulator</a> · <a href="update-comparison.csv">Comparison CSV</a></p><div class="note">{len(saved)} compatible frozen requests are identical to the saved baseline. {len(unavailable)} historical profiles could not be replayed because upstream removed equipment IDs; their reasons are in the saved-input report. The first comparison measures engine and game-data changes; the second measures refreshed presets on that same engine. Developer presets have different gear tiers. A developer-labeled pre-raid subset is available in the full report.</div>{svg}<h2>180-second comparison</h2><table><thead><tr><th>Spec / build</th><th>Previous</th><th>Frozen</th><th>Current</th><th>Engine change</th><th>Preset change</th></tr></thead><tbody>{table}</tbody></table><p>Other durations and paired uncertainty for engine changes are included in the CSV. New or removed preset IDs remain in their respective full reports. Healing and raid optimization are outside this DPS experiment.</p></html>'''
    (directory / 'report.html').write_text(report, encoding='utf-8')
    files = ['report.html', 'update-comparison.json', 'update-comparison.csv', 'update-impact.png', 'update-impact.svg']
    (directory / 'comparison-provenance.json').write_text(json.dumps({'generatedAt': datetime.now().astimezone().isoformat(), 'identicalFrozenRequests': len(saved), 'unavailableProfiles': unavailable, 'source': upstream, 'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'artifacts': {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in files}}, indent=2), encoding='utf-8')
    print(f'Verified {len(saved)} identical frozen requests; rendered {directory / "report.html"}')


if __name__ == '__main__':
    main()
