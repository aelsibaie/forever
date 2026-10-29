"""Refresh race overviews from saved results without invoking a simulator."""
import csv
import gzip
import hashlib
import html as html_module
import json
from pathlib import Path
import re
import sys
from robust_report import (GAP_EXPLANATION, GAP_INTRO, assessment_groups, gap_cell,
                           assess, overview, page, profile_title, summarize_gaps)


def load(root, name):
    file = root / name
    if not file.exists():
        file = root / (name + '.gz')
    data = file.read_bytes()
    return json.loads(gzip.decompress(data) if file.suffix == '.gz' else data)


def refresh(root):
    profiles = load(root, 'profiles.json')['profiles']
    groups = load(root, 'analysis.json')['groups']
    recommendations = load(root, 'recommendations.json')['recommendations']
    provenance = load(root, 'provenance.json')
    confidence = {(r['faction'], r['profileId'], r['pool'], r['basis'], r['supportScope'], r['duration']): r for r in recommendations}
    profile_links = {f'builds/{p["faction"]}--{p["id"]}.html': p for p in profiles}
    summaries = {}
    for record in recommendations:
        profile = next(p for p in profiles if p['id'] == record['profileId'] and p['faction'] == record['faction'])
        key = (record['faction'], record['profileId'], record['pool'], record['basis'], record['supportScope'], record['duration'])
        subset = assessment_groups(profile, groups, record['pool'], record['duration'], record['basis'], record['supportScope'])
        summaries[key] = summarize_gaps(subset, profile['races'])
    row_count = 0
    creature_count = 0
    profile_search = {(p['faction'], profile_title(p).lower()): p for p in profiles}

    def row(match):
        nonlocal row_count, creature_count
        attributes, body = match.group(1), match.group(2)
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', attributes))
        if attrs.get('data-aux') == 'creature':
            profile = profile_search[(attrs['data-faction'], html_module.unescape(attrs['data-search']))]
            head = body[:body.index('</th>') + len('</th>')]
            cells = []
            for target in ['beast', 'elemental']:
                subset = [g for g in groups if g['mode'] == 'creature-control' and g['faction'] == profile['faction'] and g['profileId'] == profile['id'] and g['target'] == target and not g.get('diagnosticOnly')]
                cells.append(gap_cell(summarize_gaps(subset, profile['races']), assess(subset, profile['races'])))
            creature_count += 1
            return '<tr' + attributes + '>' + head + ''.join(cells) + '</tr>'
        if 'data-basis' not in attrs:
            return match.group(0)
        link = re.search(r'<a href="([^"]+)"', body).group(1)
        profile = profile_links[link]
        head = body[:body.index('</th>') + len('</th>')]
        cells = []
        for duration in [60, 180, 300]:
            key = (profile['faction'], profile['id'], attrs['data-pool'], attrs['data-basis'], attrs['data-support'], duration)
            cells.append(gap_cell(summaries[key], confidence[key]))
        row_count += 1
        return '<tr' + attributes + '>' + head + ''.join(cells) + '</tr>'

    source = root / 'report.html'
    html = source.read_text(encoding='utf-8')
    html = re.sub(r'<tr([^>]*)>([\s\S]*?)</tr>', row, html)
    expected_rows = len(profiles) * 2 * 2 * 3
    if row_count != expected_rows:
        raise ValueError(f'Overview coverage differs: {row_count} rows, expected {expected_rows}.')
    html = re.sub(r'<p class="intro">[\s\S]*?</p>', '<p class="intro">' + str(len({p['id'] for p in profiles})) + ' named DPS builds, both factions and every legal race. ' + GAP_INTRO + '</p>', html, count=1)
    html = re.sub(r'<div class="notice"><b>Read the loss bound[\s\S]*?</div>', '<div class="notice"><b>Read the DPS gaps.</b> ' + GAP_EXPLANATION + '</div>', html, count=1)
    css = re.search(r'<style>([\s\S]*?)</style>', page('', '')).group(0)
    html = re.sub(r'<style>[\s\S]*?</style>', lambda _: css, html, count=1)
    if 'Confidence, sampling and setup details' not in html:
        html = re.sub(r'(<p>Across-gear cells use[\s\S]*?</p>)', r'<details><summary>Confidence, sampling and setup details</summary>\1</details>', html, count=1)
    if 'class="overview-context"' not in html:
        html = re.sub(r'(<p><b>Hunter pet choice[\s\S]*?</ul></details>)', r'<details class="overview-context"><summary>Gear, pets and sensitivity checks</summary>\1</details>', html, count=1)
    if 'Model and equipment limits' not in html:
        html = re.sub(r'(<div class="notice">This refreshed study[\s\S]*?</div>)', r'<details><summary>Model and equipment limits</summary>\1</details>', html, count=1)
    source.write_text(html, encoding='utf-8')
    if (root / 'index.html').exists():
        (root / 'index.html').write_text(html, encoding='utf-8')
    notes = {(r['faction'], r['profileId']): r.get('confidenceNotes', []) for r in recommendations}
    for profile in profiles:
        profile['confidenceNotes'] = notes[(profile['faction'], profile['id'])]
    for faction in ['horde', 'alliance']:
        for pool, suffix in [('published-pre-raid', '-overview'), ('developer-reference', '-developer-overview')]:
            overview(root / 'charts', faction, profiles, groups, pool, provenance, stem=faction + suffix, extensions=('png',))
    rows = [{'faction': key[0], 'profileId': key[1], 'pool': key[2], 'basis': key[3], 'supportScope': key[4], 'duration': key[5], **summary} for key, summary in summaries.items()]
    export = {'sourceCommit': provenance['sourceCommit'], 'definition': GAP_EXPLANATION, 'source': 'Existing saved meanDps values; no simulation runs.', 'scopes': rows}
    (root / 'race-dps-gaps.json.gz').write_bytes(gzip.compress(json.dumps(export).encode('utf-8'), mtime=0))
    with (root / 'race-dps-gaps.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.writer(stream)
        writer.writerow(['faction', 'profile', 'pool', 'basis', 'support', 'seconds', 'race', 'minimum_mean_dps_gap_pct', 'maximum_mean_dps_gap_pct', 'matching_setups'])
        for row in rows:
            for race in row['races']:
                gap = race['gapPercent']
                writer.writerow([row['faction'], row['profileId'], row['pool'], row['basis'], row['supportScope'], row['duration'], race['race'], gap['min'] if gap else '', gap['max'] if gap else '', row['conditions']])
    for name in ['report.html', 'index.html']:
        file = root / name
        if file.exists():
            text = file.read_text(encoding='utf-8')
            if 'race-dps-gaps.csv' not in text:
                text = text.replace('<h2>Inspect and reproduce</h2>', '<h2>Inspect and reproduce</h2><p><a href="race-dps-gaps.csv">Race DPS gaps CSV</a> · <a href="race-dps-gaps.json.gz">Race DPS gaps JSON</a></p>')
            file.write_text(text, encoding='utf-8')
    sources = {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ['race_gap_summary.py', 'robust_report.py', 'refresh_race_overview.py']}
    (root / 'overview-presentation.json').write_text(json.dumps({'simulationsRun': 0, 'sourceCommit': provenance['sourceCommit'], 'scopes': len(rows), 'rows': row_count, 'sourceHashes': sources}, indent=2), encoding='utf-8')
    print(json.dumps({'simulationsRun': 0, 'factionBuilds': len(profiles), 'recommendationScopes': len(rows), 'overviewRows': row_count, 'creatureRows': creature_count}))


if __name__ == '__main__':
    refresh(Path(sys.argv[1]).resolve())
