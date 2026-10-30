"""Build inspectable profile pages from an immutable experiment archive."""

import gzip
import hashlib
import html
import json
import re
from pathlib import Path

SLOTS = ['Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrist', 'Hands', 'Waist', 'Legs', 'Feet', 'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Main hand', 'Off hand', 'Ranged']
STYLE = 'body{background:#0b1220;color:#edf3fc;font:16px/1.6 system-ui;margin:0}main{max-width:1200px;margin:auto;padding:36px 24px}a{color:#80caff}section{background:#121d30;padding:24px;border:1px solid #25344b;border-radius:14px;margin:24px 0}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:10px;border-bottom:1px solid #293c53;vertical-align:top}.scroll{overflow:auto}small,.muted{color:#a1afc5}code{font-size:12px;overflow-wrap:anywhere}summary{cursor:pointer}li{margin:8px 0}.badge{padding:4px 8px;background:#27354b;border-radius:5px;font-size:12px}h1{line-height:1.15}h2{margin-top:0}'
e = lambda value: html.escape(str(value), quote=True)


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def table(head, rows):
    return '<div class="scroll"><table><thead><tr>' + ''.join('<th>' + e(x) + '</th>' for x in head) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + str(x) + '</td>' for x in row) + '</tr>' for row in rows) + '</tbody></table></div>'


def snapshot(directory, repository, manifest):
    target = directory / 'report-inputs.json'
    if target.exists():
        existing = read(target)
        if any(manifest['sourceFiles'].get(name) != value for name, value in existing['sourceHashes'].items()):
            raise ValueError('Frozen report metadata belongs to a different simulator source.')
        return existing
    source = manifest['sourceFiles']
    files = ['assets/database/db.json', 'assets/db_inputs/spell_store_inputs.json', 'proto/common.proto']
    for name in files:
        if hashlib.sha256((repository / name).read_bytes()).hexdigest() != source[name]:
            raise ValueError('Report metadata differs from the experiment source: ' + name)
    db = read(repository / files[0])
    packed = (repository / files[1]).read_bytes()
    game = json.loads(gzip.decompress(packed) if packed[:2] == b'\x1f\x8b' else packed)
    proto = (repository / files[2]).read_text(encoding='utf-8')
    enums = {}
    for name in ['Stat', 'PseudoStat']:
        body = re.search(r'enum ' + name + r'\s*\{(.*?)\n\}', proto, re.S).group(1)
        enums[name] = {int(index): field.removeprefix(name) for field, index in re.findall(r'\b(' + name + r'\w+)\s*=\s*(\d+)', body)}
    data = {'sourceHashes': {name: source[name] for name in files}, 'items': db['items'], 'enchants': db['enchants'], 'randomSuffixes': db.get('randomSuffixes', []), 'spellNames': game['Names'], 'enums': enums, 'mechanics':read(Path(__file__).with_name('report-policy.json'))['mechanics']}
    target.write_text(json.dumps(data), encoding='utf-8')
    return data


def pair_evidence(group, confirmations):
    confirmation = next((g for g in confirmations if (g['faction'], g['profileId'], g['duration']) == (group['faction'], group['profileId'], group['duration'])), None)
    return {'primary': group, 'confirmation': confirmation, 'closeThresholdPercent': .2, 'samplingScope': 'Pointwise Monte Carlo uncertainty; model error is separate.'}


def render_details(directory, repository, manifest, catalog, rows, groups=None, confirmations=None):
    directory, repository = Path(directory), Path(repository)
    meta = snapshot(directory, repository, manifest)
    names, enums = meta['spellNames'], meta['enums']
    items = {i['id']: i for i in meta['items']}
    suffixes = {i['id']: i for i in meta['randomSuffixes']}
    enchants = {i['effectId']: i for i in meta['enchants']}
    pages = directory / 'profiles'
    pages.mkdir(exist_ok=True)
    groups, confirmations = groups or [], confirmations or []
    snapshot_info = manifest.get('snapshot', manifest.get('git', {}))
    commit = snapshot_info['commit']
    source = snapshot_info.get('upstreamSourceCommit', commit)
    model = manifest.get('model', {}).get('name', 'upstream')
    index = []

    def action_name(action):
        if 'spellId' in action:
            return names.get(str(action['spellId']), 'Spell ' + str(action['spellId'])) + ' [' + str(action['spellId']) + ']'
        if 'itemId' in action:
            return items.get(action['itemId'], {}).get('name', 'Item ' + str(action['itemId']))
        return str(action.get('otherId', 'Action')).removeprefix('OtherAction')

    def describe(value):
        if not isinstance(value, dict):
            return str(value)
        if 'spellId' in value:
            return action_name(value)
        if 'const' in value:
            return value['const']['val']
        if 'variableRef' in value:
            return value['variableRef']['name']
        if 'cmp' in value:
            v = value['cmp']
            return '(' + describe(v['lhs']) + ' ' + v['op'].removeprefix('Op') + ' ' + describe(v['rhs']) + ')'
        if 'and' in value or 'or' in value:
            kind = 'and' if 'and' in value else 'or'
            return '(' + (' ' + kind + ' ').join(describe(x) for x in value[kind]['vals']) + ')'
        if 'not' in value:
            return 'not ' + describe(value['not']['val'])
        if 'castSpell' in value or 'channelSpell' in value:
            kind = 'castSpell' if 'castSpell' in value else 'channelSpell'
            return ('Cast ' if kind == 'castSpell' else 'Channel ') + action_name(value[kind]['spellId'])
        if 'autocastOtherCooldowns' in value:
            return 'Use eligible automatic cooldowns'
        if 'strictSequence' in value:
            return 'Sequence: ' + ' → '.join(describe(x) for x in value['strictSequence']['actions'])
        return '; '.join(re.sub(r'([A-Z])', r' \1', k) + (': ' + describe(v) if v else '') for k, v in value.items())

    for profile in catalog['profiles']:
        selected = [r for r in rows if r['profileId'] == profile['id'] and (not profile.get('faction') or r.get('faction') == profile['faction']) and r.get('scenario', 'developer') in ['developer', 'racial-activation']]
        if not selected:
            continue
        slug = (profile.get('faction', '') + '--' + profile['id']).strip('-')
        title = profile.get('specLabel', profile['className']) + ' / ' + profile['name']
        first = selected[0]
        key = first.get('key', first['profileId'] + '--' + str(first['duration']) + 's')
        request = read(directory / 'requests' / (key + '.json'))
        player = request['raid']['parties'][0]['players'][0]
        mechanics = [m for m in meta.get('mechanics',[]) if not m.get('enchantId') or any(item.get('enchant')==m['enchantId'] for item in player['equipment']['items'])]
        facts = {'profile': profile, 'sourceCommit': source, 'analyticsCommit': commit, 'model': model, 'mechanics':mechanics, 'results': selected, 'comparisons': [pair_evidence(g, confirmations) for g in groups if g['profileId'] == profile['id'] and g['faction'] == profile.get('faction')]}
        (pages / (slug + '.json')).write_text(json.dumps(facts, indent=2), encoding='utf-8')
        gear = []
        for slot, item_spec in zip(SLOTS, player['equipment']['items']):
            item = items.get(item_spec.get('id'), {})
            suffix = suffixes.get(item_spec.get('randomSuffix'), {})
            enchant = enchants.get(item_spec.get('enchant'), {})
            gear.append([e(slot), e(item.get('name', 'Empty') + (' ' + suffix['name'] if suffix else '')), e(item_spec.get('id', '')), e(enchant.get('name', item_spec.get('enchant', '')))])
        results = []
        for row in selected:
            key = row.get('key', row['profileId'] + '--' + str(row['duration']) + 's')
            replay = '<a href="../requests/' + e(key) + '.json">Native input</a> · <a href="../results/' + e(key) + '.json">Full output</a>'
            if catalog.get('apiVersion') is not None:
                q = read(directory / 'requests' / (key + '.json'))
                faction = profile.get('faction') or ('alliance' if row['race'] in ['RaceHuman','RaceDwarf','RaceNightElf','RaceGnome','RaceHighOrderSkyborne'] else 'horde')
                website = {'apiVersion':catalog['apiVersion'],'player':q['raid']['parties'][0]['players'][0],'encounter':q['encounter'],'raidBuffs':q['raid'].get('buffs',{}),'partyBuffs':q['raid']['parties'][0].get('buffs',{}),'debuffs':q['raid'].get('debuffs',{}),'tanks':q['raid'].get('tanks',[]),'settings':{'iterations':row['iterations'],'fixedRngSeed':q['simOptions']['randomSeed'],'phase':1,'showDamageMetrics':True,'showExperimental':True,'faction':faction.title()}}
                (pages / (key + '.website.json')).write_text(json.dumps(website,indent=2),encoding='utf-8')
                replay += ' · <a href="' + e(key) + '.website.json">Website JSON</a>'
            racial = row.get('racial', {})
            results.append([e(row.get('race', profile.get('race', ''))), e(row.get('scenario','developer')), row['duration'], f"{row['meanDps']:.2f} ± {row['ci95HalfWidth']:.2f}", row['iterations'], row.get('seed', request['simOptions']['randomSeed']), f"{row['secondsOomAvg']:.2f}", e(racial.get('casts','')),e(racial.get('uptimeSeconds','')),replay])
        evidence = ''
        for pair in facts['comparisons']:
            g, c = pair['primary'], pair['confirmation']
            lead = g['leadOverSecond']
            if lead:
                evidence += '<p><b>' + str(g['duration']) + 's:</b> primary ' + e(g['winner']) + ' leads ' + e(g['rows'][1]['race']) + f" by {lead['percent']:.3f}% ± {lead['ci95HalfWidthPercent']:.3f} percentage points."
                if c:
                    cl = c['leadOverSecond']
                    evidence += ' Independent leading-pair confirmation: ' + e(c['winner']) + f" +{cl['percent']:.3f}% ± {cl['ci95HalfWidthPercent']:.3f} pp ({c['rows'][0]['iterations']:,} iterations per race, seed {c['rows'][0]['seed']})."
                evidence += ' <b>Close under the 0.2% reporting convention.</b>' if g['practicalTie'] else ''
                evidence += '</p>'
        stat_tables = ''
        for race in dict.fromkeys(r.get('race', profile.get('race')) for r in selected):
            matches = list((directory / 'stats').glob('*' + profile['id'] + '--' + race + '--*.json')) if (directory / 'stats').exists() else []
            if not matches:
                continue
            stats = read(matches[0])['raidStats']['parties'][0]['players'][0]
            values = stats['finalStats']
            entries = [[e(enums[kind].get(str(i), enums[kind].get(i, str(i)))), f'{v:.3f}'] for kind, array in [('Stat', values['stats']), ('PseudoStat', values['pseudoStats'])] for i, v in enumerate(array) if v]
            stat_tables += '<details><summary>' + e(race) + ': final pre-combat stats</summary>' + table(['Named stat / percent', 'Value'], entries) + '</details>'
        rotation = []
        for i, line in enumerate(player['rotation'].get('priorityList', [])):
            action = line.get('action', {})
            rotation.append([i + 1, 'Disabled' if line.get('hide') else 'Enabled', e(describe({k:v for k,v in action.items() if k != 'condition'})), e(describe(action.get('condition', {})))])
        allocation = profile.get('talentAllocation', [])
        talents = ', '.join(p['name'] + ' ' + str(p['points']) for p in allocation) or 'Named allocation is unavailable in this older archive; exact talent string is preserved.'
        breakdown = []
        for action in sorted(first.get('damageActions', []), key=lambda a: -a['dps']):
            breakdown.append([e(action_name(action['id'])), f"{action['dps']:.2f}", f"{action['casts']:.3f}"])
        first_key = first.get('key', first['profileId'] + '--' + str(first['duration']) + 's')
        raw = read(directory / 'results' / (first_key + '.json'))
        resources = raw['raidMetrics']['parties'][0]['players'][0].get('resources', [])
        resource_rows = [[e(action_name(r['id'])) + ' (tag ' + str(r['id'].get('tag',0)) + ')', f"{r['events']/first['iterations']:.2f}", f"{r['gain']/first['iterations']:.2f}", f"{r['actualGain']/first['iterations']:.2f}"] for r in resources if r['type']=='ResourceTypeMana']
        warnings = profile.get('knownIssues', []) + profile.get('warnings', [])
        body = '<p><a href="../report.html">← Full comparison</a></p><h1>' + e(title) + '</h1><p>' + e(profile.get('faction', '')) + ' · ' + e(profile.get('gearTier', profile['gearName'])) + ' · ' + e(profile.get('launchStatus', 'Unknown status')) + '</p>'
        body += '<section><h2>Result and sampling precision</h2>' + table(['Race','Case','Seconds','DPS ± 95% half-width','Iterations','Seed','Mana waits (s)','Racial casts','Racial uptime (s)','Replay'], results) + evidence + '<p>Intervals measure simulation sampling error. They do not measure uncertainty in game mechanics. Independent confirmations compare the selected pair only. Website JSON carries the setup; a live website can use a newer engine and different RNG. Native inputs and the archived binary reproduce the recorded model.</p></section>'
        body += '<section><h2>Equipment and talents</h2>' + table(['Slot','Developer item / suffix','Item ID','Enchant'], gear) + '<p>' + e(talents) + '</p><code>' + e(player['talentsString']) + '</code><p>' + e(' / '.join(profile.get('professions', []))) + '</p></section>'
        body += '<section><h2>Rotation</h2>' + table(['Priority','Status','Action','Condition'], rotation) + '<p>Hidden actions are shown so excluded abilities remain visible. The complete prepull actions and variable definitions are in each native input.</p></section>'
        body += '<section><h2>Final stats and damage accounting</h2>' + stat_tables + '<h3>First listed cell: ' + e(first.get('race', profile.get('race'))) + ', ' + str(first['duration']) + 's</h3>' + table(['Action','DPS','Casts per fight'], breakdown) + '<h3>Mana accounting for that cell</h3><p>Mean events and net resource changes per fight; negative amounts are costs. Actual gain reflects resource caps. Tags distinguish the engine’s resource channels.</p>' + table(['Action / channel','Events','Nominal mana','Actual mana'],resource_rows) + '</section>'
        body += '<section><h2>Confidence and model scope</h2><p><b>Preset:</b> ' + e(profile.get('gearTier', profile['gearName'])) + '. Gear is preserved; no item scoring or optimization.</p><p><b>Mechanics:</b> these are outputs of the recorded engine. Alpha status and precise sampling do not establish in-game validation.</p>' + table(['Mechanic ID','Evidence / scope','Reason'],[[e(m['id']),e(m['status']),e(m['reason'])+' <code>'+e(m['source'])+'</code>'] for m in mechanics]) + '<ul>' + ''.join('<li>' + e(w) + '</li>' for w in warnings) + '</ul></section>'
        support = {'encounter':request['encounter'],'raidBuffs':request['raid'].get('buffs'),'partyBuffs':request['raid']['parties'][0].get('buffs'),'individualBuffs':player.get('buffs'),'debuffs':request['raid'].get('debuffs'),'consumables':player.get('consumables')}
        body += '<section><h2>Exact provenance and support</h2><p>Analytics <code>' + e(commit) + '</code>; engine source <code>' + e(source) + '</code>; model <code>' + e(model) + '</code>.</p><p>Game builds ' + e(json.dumps(manifest['gameBuilds'])) + '; hotfixes ' + e(json.dumps(manifest.get('hotfixes', {}))) + '.</p><p><a href="../provenance.json">Run provenance</a> · <a href="' + e(slug) + '.json">Profile result data</a> · <a href="../report-inputs.json">Frozen item, spell and stat names</a></p><details><summary>Encounter, support and consumables</summary><pre>' + e(json.dumps(support,indent=2)) + '</pre></details></section>'
        (pages / (slug + '.html')).write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + e(title) + '</title><style>' + STYLE + '</style><main>' + body + '</main></html>', encoding='utf-8')
        index.append({'profileId':profile['id'],'faction':profile.get('faction'),'title':title,'href':'profiles/' + slug + '.html'})
    (directory / 'profile-index.json').write_text(json.dumps(index,indent=2),encoding='utf-8')
    return '<section id="profile-details"><h2>Inspect the builds</h2><p>Equipment, named talents, enabled and disabled rotation actions, final stats, raw inputs and confirmation results.</p>' + table(['Faction','Spec / preset','Inspection'], [[e(x.get('faction') or ''),e(x['title']),'<a href="' + e(x['href']) + '">Open build</a>'] for x in index]) + '</section>'
