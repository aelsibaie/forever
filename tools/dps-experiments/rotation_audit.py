"""Audit saved race comparisons for missing shared cooldowns and damaging actions."""
import argparse
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def action_counts(result):
    player = result['raidMetrics']['parties'][0]['players'][0]
    iterations = result['iterationsDone']
    counts = {}
    for action in player['actions']:
        spell = action['id'].get('spellId')
        if spell:
            counts[spell] = counts.get(spell, 0) + sum(t['casts'] for t in action['targets']) / iterations
    return counts


def missing_shared_actions(rows, counts, cooldowns, castable, damage):
    findings = []
    for spell in sorted(cooldowns):
        values = [{'race': r['race'], 'casts': counts[r['key']].get(spell, 0)} for r in rows]
        if len(values) > 1 and min(r['casts'] for r in values) == 0 and max(r['casts'] for r in values) >= .5:
            findings.append({'kind': 'missing-shared-cooldown', 'spellId': spell, 'values': values})
    for spell in sorted(castable - cooldowns):
        values = [{'race': r['race'], 'casts': counts[r['key']].get(spell, 0)} for r in rows]
        shares = [sum(a['dps'] for a in damage[r['key']] if a['id'].get('spellId') == spell) / r['meanDps'] for r in rows]
        if len(values) > 1 and min(r['casts'] for r in values) == 0 and max(r['casts'] for r in values) >= 3 and max(shares) >= .1:
            findings.append({'kind': 'missing-shared-damage-action', 'spellId': spell, 'values': values, 'maximumDamageShare': max(shares)})
    return findings


def scheduling_disparities(rows, counts, cooldowns):
    reviews = []
    for spell in sorted(cooldowns):
        values = [{'race': r['race'], 'casts': counts[r['key']].get(spell, 0)} for r in rows]
        if values and min(v['casts'] for v in values) > 0 and max(v['casts'] for v in values) - min(v['casts'] for v in values) >= .5:
            reviews.append({'spellId': spell, 'values': values})
    return reviews


def rotation_suitable(group):
    return (group.get('referencePolicy', 'developer') == 'developer'
            and not group.get('diagnosticOnly') and not group.get('rotationExcluded'))


def scan_result(item):
    key, file, expected, iterations = item
    raw = Path(file).read_bytes()
    if digest(raw) != expected:
        raise ValueError('Result hash mismatch: ' + key)
    result = json.loads(raw)
    if result['iterationsDone'] != iterations or (result.get('error') or {}).get('message'):
        raise ValueError('Incomplete or failed result: ' + key)
    return key, action_counts(result)


def audit(root, workers=6):
    profiles = read(root / 'profiles.json')['profiles']
    analysis = read(root / 'analysis.json')
    cells = {r['key']: r for r in read(root / 'cells.json')}
    cds, casts = {}, {}
    for profile in profiles:
        per_race, per_race_castable = [], []
        for race in profile['races']:
            cell = next(c for c in cells.values() if c['profileId'] == profile['id'] and c['faction'] == profile['faction'] and c['race'] == race and c['phase'] == 'preflight' and c['setId'] == profile['referenceSetId'] and c['support'] == 'full')
            raw = (root / 'stats' / (cell['key'] + '.json')).read_bytes()
            if digest(raw) != cell['statsSha256']:
                raise ValueError('Metadata hash mismatch: ' + cell['key'])
            spells = json.loads(raw)['raidStats']['parties'][0]['players'][0]['metadata']['spells']
            available = [s for s in spells if s['id'].get('spellId') and s['isCastable'] and not s['prepullOnly'] and not s['encounterOnly']]
            per_race.append({s['id']['spellId'] for s in available if s['isMajorCooldown']})
            per_race_castable.append({s['id']['spellId'] for s in available})
        key = (profile['faction'], profile['id'])
        cds[key] = set.intersection(*per_race)
        casts[key] = set.intersection(*per_race_castable)
    groups = [g for g in analysis['groups'] if not g.get('diagnosticOnly')]
    jobs = {r['key']: r for g in groups for r in g['rows']}
    tasks = [(key, str(root / 'results' / (key + '.json')), cells[key]['resultSha256'], row['iterations']) for key, row in jobs.items()]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        counts = dict(pool.map(scan_result, tasks, chunksize=24))
    damage = {k: cells[k]['damageActions'] for k in jobs}
    findings = []
    for group in groups:
        key = (group['faction'], group['profileId'])
        for finding in missing_shared_actions(group['rows'], counts, cds[key], casts[key], damage):
            findings.append({**{k: group[k] for k in ['key', 'mode', 'profileId', 'faction', 'duration', 'support', 'referencePolicy']}, **finding})
    scheduling = []
    for group in groups:
        if group['mode'] != 'fixed-set' or group['referencePolicy'] != 'developer':
            continue
        for review in scheduling_disparities(group['rows'], counts, cds[(group['faction'], group['profileId'])]):
            scheduling.append({'profileId': group['profileId'], 'faction': group['faction'], 'condition': group['key'], **review})
    usage_review = {'scope': 'Shared cooldown cast-count ranges of at least half a cast across races are screening signals, not established defects. No additional simulation scenarios are needed for this review.', 'checkedPrimaryFixedGearGroups': sum(g['mode'] == 'fixed-set' and g['referencePolicy'] == 'developer' for g in groups), 'largeCooldownUsageDisparities': scheduling}
    (root / 'rotation-usage-review.json').write_text(json.dumps(usage_review, indent=2) + '\n', encoding='utf-8', newline='\n')
    by_key = {g['key']: g for g in groups}
    effects = []
    for group in groups:
        if group['referencePolicy'] != 'developer' or group['mode'] != 'fixed-set':
            continue
        peer = by_key.get(group['key'].removesuffix('--developer') + '--explicit')
        if not peer:
            continue
        deltas = [{'race': r['race'], 'changePercent': 100 * (next(q for q in peer['rows'] if q['race'] == r['race'])['meanDps'] / r['meanDps'] - 1)} for r in group['rows']]
        effects.append({'key': group['key'], 'profileId': group['profileId'], 'faction': group['faction'], 'maximumRaceInteractionPercent': max(d['changePercent'] for d in deltas) - min(d['changePercent'] for d in deltas), 'deltas': deltas})
    blocked = {f['key'] for f in findings}
    for group in analysis['groups']:
        group['rotationExcluded'] = group['key'] in blocked
    warnings = {r['key']: r.get('validations', []) for r in cells.values() if r['key'] in jobs and r.get('validations')}
    provenance = read(root / 'provenance.json')
    summary = {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': provenance['sourceCommit'], 'scriptSha256': digest(Path(__file__).read_bytes()),
               'coverage': {'namedBuilds': len({p['id'] for p in profiles}), 'factionBuilds': len(profiles), 'legalRaceBuilds': sum(len(p['races']) for p in profiles), 'groups': len(groups), 'results': len(jobs), 'primaryGroups': sum(rotation_suitable(g) for g in analysis['groups'])},
               'findings': findings, 'blockedGroups': sorted(blocked), 'primaryBlockedGroups': [g['key'] for g in analysis['groups'] if g['key'] in blocked and g['referencePolicy'] == 'developer'],
               'resolutionEffects': effects, 'validationWarnings': warnings,
               'publicationPolicy': 'Primary recommendations use developer-reference handling only. Alternate unavailable-reference treatments are diagnostics. Any comparison with a missing shared cooldown or major damage action is excluded as a whole until reviewed and repaired.',
               'limits': 'A structural and runtime comparison audit, not proof of game accuracy or fully optimized rotations. Shared known cooldowns and damaging actions are checked; unused abilities across every race can still reflect missing preset support. Damage-action screening requires at least three casts and ten percent of damage in a peer.'}
    (root / 'analysis.json').write_text(json.dumps(analysis, indent=2) + '\n', encoding='utf-8', newline='\n')
    summary['analysisSha256'] = digest((root / 'analysis.json').read_bytes())
    archive = root / 'tooling' / summary['scriptSha256'] / 'rotation_audit.py'
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(Path(__file__).read_bytes())
    (root / 'rotation-audit.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8', newline='\n')
    coverage = summary['coverage']
    rows = ''.join('<tr><td>' + html.escape(f['faction'] + ' / ' + f['profileId']) + '</td><td>' + html.escape(f['mode'] + ' / ' + f['referencePolicy']) + '</td><td>' + str(f['duration']) + '</td><td>' + str(f['spellId']) + '</td><td>' + html.escape(str(f['values'])) + '</td></tr>' for f in findings)
    worst = sorted(effects, key=lambda e: -e['maximumRaceInteractionPercent'])[:15]
    interactions = ''.join('<tr><td>' + html.escape(e['faction'] + ' / ' + e['profileId']) + '</td><td>' + format(e['maximumRaceInteractionPercent'], '.3f') + '%</td><td>' + html.escape(e['key']) + '</td></tr>' for e in worst)
    before = read(root / 'rotation-audit-before.json') if (root / 'rotation-audit-before.json').exists() else None
    correction = ('<p>The earlier audit found ' + str(len(before['findings'])) + ' affected comparisons, all in Combat SS or Combat Backstab. The corrected cooldown block separates the racial synchronization paths and keeps a usable class-cooldown fallback.</p>') if before else ''
    page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rotation audit</title><style>body{font:17px/1.7 system-ui;background:#0b1220;color:#e7edf5;max-width:1200px;margin:auto;padding:35px}a{color:#8acbff}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #35435b;overflow-wrap:anywhere}code{overflow-wrap:anywhere}.scroll{overflow:auto}</style><h1>Rotation audit and correction</h1><p><a href="report.html">Return to racial DPS comparisons</a></p><p>' + str(coverage['namedBuilds']) + ' named builds, ' + str(coverage['factionBuilds']) + ' faction/build groups, ' + str(coverage['legalRaceBuilds']) + ' legal race/build combinations; ' + str(coverage['groups']) + ' comparison groups and ' + str(coverage['results']) + ' checked runtime results.</p>' + correction + '<p><strong>Current findings: ' + str(len(findings)) + '; primary comparisons excluded: ' + str(len(summary['primaryBlockedGroups'])) + '.</strong> Any failing group is excluded as a complete race comparison. Alternate unavailable-reference handling is diagnostic and does not enter the headline race gaps or confidence summaries.</p><h2>Missing shared actions</h2><div class="scroll"><table><tr><th>Build</th><th>Treatment</th><th>Seconds</th><th>Spell</th><th>Casts per race</th></tr>' + rows + '</table></div><h2>Rotation-treatment sensitivity</h2><p>The largest race-dependent differences between original and explicit-reference handling are listed below. These are model and rotation diagnostics, not racial bonuses. A nonzero value can include sampling variation, timing choices and resource interactions.</p><div class="scroll"><table><tr><th>Build</th><th>Spread of treatment effects</th><th>Condition</th></tr>' + interactions + '</table></div><h2>Cooldown scheduling</h2><p>Nonzero cooldown usage can still differ materially between races. These cases are advisory, not proven bugs: <a href="rotation-usage-review.json">inspect the saved cast-count ranges</a>. Related build rows carry a rotation-scheduling caveat; their numbers remain conditional on that preset.</p><h2>Checks and limits</h2><p>' + html.escape(summary['limits']) + '</p><p>Native spell metadata supplies the intersection of castable spells and major cooldowns known by every legal race. Result hashes, iteration counts and actual cast totals are checked. Damaging-action checks use the same saved per-action damage accounting as the study. Validation warnings remain in the audit data; unavailable spells from unselected talents are not automatically treated as defects.</p><p><a href="rotation-audit.json">Complete audit data and validation warnings</a></p><p>Simulator <code>' + provenance['sourceCommit'] + '</code>. This audit does not establish correct game behavior or a perfectly optimized rotation.</p></html>'
    (root / 'rotation-audit.html').write_text(page, encoding='utf-8', newline='\n')
    print(json.dumps({'coverage': coverage, 'findings': len(findings), 'primaryBlockedGroups': len(summary['primaryBlockedGroups'])}))
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('study', type=Path)
    parser.add_argument('--workers', type=int, default=6)
    args = parser.parse_args()
    audit(args.study.resolve(), args.workers)
