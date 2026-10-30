import hashlib
import json
import math
import sys
from collections import defaultdict
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from statistics import NormalDist

import numpy as np


def read(file):
    return json.loads(file.read_text(encoding='utf-8'))


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def ratio_interval(left, right, z=NormalDist().inv_cdf(.975)):
    ratio = left.mean() / right.mean()
    half = 100 * z * (left - ratio * right).std(ddof=1) / math.sqrt(len(left)) / right.mean()
    return 100 * (ratio - 1), half


def verify(run):
    provenance, catalog, analysis, cells = [read(run / name) for name in ['provenance.json', 'profiles.json', 'analysis.json', 'cells.json']]
    engine = run / 'engine' / ('batch.exe' if (run / 'engine/batch.exe').exists() else 'batch')
    assert digest(engine) == provenance['engineSha256'], 'Engine hash mismatch'
    assert digest(run / 'gear-catalog-input.json') == provenance['gearCatalogSha256'], 'Gear catalogue hash mismatch'
    method = read(run / 'methodology.json')
    assert method['engineSha256'] == provenance['engineSha256'], 'Method engine mismatch'
    for file, checksum in method['toolHashes'].items():
        assert digest(run / 'tooling' / checksum / file) == checksum, 'Archived execution tool changed: ' + file
    cell_map = {row['key']: row for row in cells}
    assert len(cell_map) == len(cells), 'Repeated cell keys'
    profile_map = {(p['faction'], p['id']): p for p in catalog['profiles']}
    mechanics = read(run / 'mechanics-coverage.json')
    for file, checksum in mechanics.get('classSources', {}).items():
        assert checksum == provenance['sourceFiles'][file], 'Class confidence metadata differs from the compiled source'
    legality = read(run / 'gear-legality.json')
    assert legality['engineSha256'] == provenance['engineSha256'] and digest(run / 'gear-legality-tool.mjs') == legality['toolSha256'], 'Equipment audit provenance differs'
    repo = Path(__file__).resolve().parents[2]
    database = {}
    for name in ['db.json', 'leftover_db.json']:
        file = repo / 'assets/database' / name
        assert digest(file) == provenance['sourceFiles']['assets/database/' + name], 'Equipment audit database changed'
        database.update({item['id']: item for item in read(file)['items']})
    for profile in catalog['profiles']:
        for gear in profile['sets']:
            categories = defaultdict(int)
            for item in gear['equipment']['items']:
                category = database.get(item.get('id'), {}).get('limitCategory')
                if category:
                    categories[category] += 1
            invalid = any(count > 1 for count in categories.values())
            assert bool(gear.get('diagnosticOnly')) == invalid, 'Incorrect unique-equipped audit: ' + gear['id']
            assert not (invalid and gear['tier'] == 'Published pre-raid'), 'Published gear has conflicting categories'
    settings = provenance['settings']
    assert analysis['settings'] == settings, 'Analysis settings differ from execution'
    expected_groups = set()
    for profile in catalog['profiles']:
        for duration in settings['durations']:
            for reference in settings['referencePolicies']:
                for support in settings['supports']:
                    for gear in profile['sets']:
                        expected_groups.add(('fixed-set', profile['faction'], profile['id'], gear['id'], duration, support, reference, 'neutral', 0))
                    for pool in ['published-pre-raid', 'developer-reference']:
                        available = any(a.get('tier') == 'Published pre-raid' if pool == 'published-pre-raid' else a.get('origin') == 'WoWSims developer' for g in profile['sets'] for a in [g, *g['aliases']])
                        if not available:
                            continue
                        expected_groups.add(('pool:' + pool, profile['faction'], profile['id'], None, duration, support, reference, 'neutral', 0))
                for offset in [-4, -2, 0, 2, 4]:
                    expected_groups.add(('hit-control', profile['faction'], profile['id'], profile.get('referenceSetId', 'developer'), duration, 'full', reference, 'neutral', offset))
        for reference in settings['referencePolicies']:
            for target in ['beast', 'elemental']:
                expected_groups.add(('creature-control', profile['faction'], profile['id'], profile.get('referenceSetId', 'developer'), 180, 'full', reference, target, 0))
    actual_groups = {(g['mode'], g['faction'], g['profileId'], g['setId'], g['duration'], g['support'], g['referencePolicy'], g['target'], g['hitOffset']) for g in analysis['groups']}
    assert len(actual_groups) == len(analysis['groups']), 'Duplicate condition groups'
    assert actual_groups == expected_groups, f'Condition coverage mismatch: {len(expected_groups - actual_groups)} missing, {len(actual_groups - expected_groups)} unexpected'
    for i, row in enumerate(cells):
        request_file, result_file, stats_file = [run / directory / (row['key'] + '.json') for directory in ['requests', 'results', 'stats']]
        assert digest(request_file) == row['requestSha256'], row['key'] + ': request hash'
        assert digest(result_file) == row['resultSha256'], row['key'] + ': result hash'
        assert digest(stats_file) == row['statsSha256'], row['key'] + ': stats hash'
        request, result = read(request_file), read(result_file)
        assert result['iterationsDone'] == row['iterations'], row['key'] + ': iterations'
        values = np.asarray(result['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'], dtype=float)
        assert len(values) == row['iterations'] and np.isfinite(values).all(), row['key'] + ': samples'
        assert math.isclose(float(values.mean()), row['meanDps'], rel_tol=1e-10, abs_tol=1e-9), row['key'] + ': mean'
        assert math.isclose(float(values.std(ddof=1)), row['stdev'], rel_tol=1e-9, abs_tol=1e-8), row['key'] + ': standard deviation'
        player = request['raid']['parties'][0]['players'][0]
        assert player['race'] == row['race'], row['key'] + ': race'
        assert request['encounter']['duration'] == row['duration'], row['key'] + ': duration'
        assert int(request['simOptions']['randomSeed']) == row['seed'], row['key'] + ': seed'
        assert row['iterations'] == request['simOptions']['iterations'], row['key'] + ': request iterations'
        profile = profile_map[(row['faction'], row['profileId'])]
        assert row['race'] in profile['races'], row['key'] + ': illegal race'
        gear = next(g for g in profile['sets'] if g['id'] == row['setId'])
        assert player['equipment'] == gear['equipment'], row['key'] + ': gear changed'
        assert player['talentsString'] == profile['player']['talentsString'], row['key'] + ': talents changed'
        mutable = {'race', 'equipment', 'buffs', 'bonusStats', 'profession1', 'profession2', 'name', 'rotation'}
        if profile['className'] == 'Hunter':
            mutable.add('hunter')
            hunter = deepcopy(profile['player']['hunter'])
            hunter['options']['classOptions'].update(gear.get('nativeHunterOptions', {}))
            assert player['hunter'] == hunter, row['key'] + ': Hunter settings changed beyond source ammo/quiver'
        for field, expected in profile['player'].items():
            if field not in mutable:
                assert player.get(field) == expected, row['key'] + ': baseline field changed: ' + field
        if row['phase'] != 'hit-control':
            assert not any(player.get('bonusStats', {}).get('stats', [])), row['key'] + ': injected stats'
            assert not any(player.get('bonusStats', {}).get('pseudoStats', [])), row['key'] + ': injected pseudo stats'
        else:
            nonzero = [value for value in player.get('bonusStats', {}).get('stats', []) if value]
            assert nonzero == ([row['hitOffset'] * 10] if row['hitOffset'] else []), row['key'] + ': hit control changed other stats'
            assert not any(player.get('bonusStats', {}).get('pseudoStats', [])), row['key'] + ': hit control injected pseudo stats'
        if row['profileId'].endswith(('-asn-muti', '-combat-muti')):
            assert row['mutilateCasts'] > 0, row['key'] + ': Mutilate missing'
        if row.get('sameRequestAs'):
            assert row['requestSha256'] == cell_map[row['sameRequestAs']]['requestSha256'], row['key'] + ': invalid exact-request reuse'
        if row.get('reusedInputFrom'):
            source_key = row['reusedInputFrom']
            for directory, field in [('requests', 'requestSha256'), ('results', 'resultSha256'), ('stats', 'statsSha256')]:
                assert digest(run / directory / (source_key + '.json')) == row[field], row['key'] + ': indexed cache mismatch'
        assert row['mana'] in ['developer', 'leyline65-guarded'], row['key'] + ': mana policy overwritten'
        if i and i % 5000 == 0:
            print(f'Checked {i}/{len(cells)} cells', flush=True)

    @lru_cache(maxsize=64)
    def samples(key):
        result = read(run / 'results' / (key + '.json'))
        return np.asarray(result['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'], dtype=float)

    for group in analysis['groups']:
        profile = profile_map[(group['faction'], group['profileId'])]
        assert sorted(row['race'] for row in group['rows']) == sorted(profile['races']), group['key'] + ': incomplete race coverage'
        leader = max(group['rows'], key=lambda row: row['meanDps'])
        assert group['leader'] == leader['race'], group['key'] + ': leader'
        base = samples(leader['key'])
        pair_count = max(1, len(group['rows']) * (len(group['rows']) - 1) // 2)
        z = NormalDist().inv_cdf(1 - 0.05 / (2 * pair_count))
        seeds = {cell_map[row['key']]['seed'] for row in group['rows']}
        lengths = {len(samples(row['key'])) for row in group['rows']}
        assert len(seeds) == len(lengths) == 1, group['key'] + ': mismatched paired samples'
        for row in group['rows']:
            values = samples(row['key'])
            percent, half = ratio_interval(values, base, z)
            recorded = next(c for c in group['comparisons'] if c['race'] == row['race'])
            assert abs(percent - recorded['percent']) < 1e-8, group['key'] + ': relative mean'
            assert abs(half - recorded['halfWidthPercent']) < 1e-6, group['key'] + ': paired interval'
            if group['mode'].startswith('pool:'):
                assert cell_map[row['key']]['phase'] in ['confirmation', 'precision'], group['key'] + ': training data in final recommendation'
        if group['mode'] in ['fixed-set', 'hit-control']:
            dwarf = next((row for row in group['rows'] if row['race'] == 'RaceDwarf'), None)
            other = next((row for row in group['rows'] if row['race'] != 'RaceDwarf'), None)
            if dwarf and other:
                for stat in ['MeleeHitPercent', 'SpellHitPercent']:
                    assert abs(dwarf['stats'][stat] - other['stats'][stat] - 1) < 1e-8, group['key'] + ': Dwarf hit bonus'
        if group['mode'].startswith('pool:'):
            assert all(not next(g for g in profile['sets'] if g['id'] == row['setId']).get('diagnosticOnly') for row in group['rows']), group['key'] + ': illegal diagnostic gear entered recommendations'

    hit_groups = defaultdict(dict)
    for row in cells:
        if row['phase'] == 'hit-control':
            key = (row['faction'], row['profileId'], row['race'], row['duration'], row['referencePolicy'])
            hit_groups[key][row['hitOffset']] = row
    for key, controls in hit_groups.items():
        assert 0 in controls, str(key) + ': missing zero-offset control'
        for offset, row in controls.items():
            for stat in ['MeleeHitPercent', 'SpellHitPercent']:
                assert abs(row['stats'][stat] - controls[0]['stats'][stat] - offset) < 1e-8, str(key) + ': hit-control units changed'

    ranged = read(run / 'hunter-ranged-controls/analysis.json')
    assert ranged['passed'] and ranged['engineSha256'] == provenance['engineSha256'], 'Melee Hunter ranged-input controls failed'
    expected = {row['key'] for row in cells if row['phase'] == 'validation' and row['profileId'] == 'hunter-dps-sv-melee'}
    observed = defaultdict(dict)
    for row in ranged['cases']:
        assert row['sourceKey'] in expected and row['sourceRequestSha256'] == cell_map[row['sourceKey']]['requestSha256'], 'Ranged control source mismatch'
        for directory, field in [('requests', 'requestSha256'), ('results', 'resultSha256')]:
            assert digest(run / 'hunter-ranged-controls' / directory / (row['key'] + '.json')) == row[field], 'Ranged control hash mismatch'
        request = deepcopy(read(run / 'requests' / (row['sourceKey'] + '.json')))
        request['simOptions']['iterations'] = ranged['iterations']
        request['simOptions']['randomSeed'] = str(ranged['seed'])
        options = request['raid']['parties'][0]['players'][0]['hunter']['options']['classOptions']
        options['ammo'] = 'SwiftfeatherArrow' if row['variant'] in ['ammo-only', 'maximum'] else 'AmmoNone'
        options['quiverBonus'] = 'AncientSinewWrappedLamina' if row['variant'] in ['quiver-only', 'maximum'] else 'QuiverNone'
        assert request == read(run / 'hunter-ranged-controls/requests' / (row['key'] + '.json')), 'Ranged control changed other inputs'
        raw = read(run / 'hunter-ranged-controls/results' / (row['key'] + '.json'))
        assert raw['iterationsDone'] == ranged['iterations'], 'Incomplete ranged control'
        observed[row['sourceKey']][row['variant']] = raw['raidMetrics']['parties'][0]['players'][0]['dps']['allValues']
    assert set(observed) == expected, 'Incomplete melee Hunter ranged-input controls'
    assert all(set(variants) == {'zero', 'ammo-only', 'quiver-only', 'maximum'} for variants in observed.values()), 'Incomplete factorial ranged-input controls'
    for comparison in ranged['comparisons']:
        variants = observed[comparison['sourceKey']]
        left, right = [np.asarray(variants[name], dtype=float) for name in [comparison['variant'], 'zero']]
        assert len(left) == len(right) == ranged['iterations'] and np.isfinite(left).all() and np.isfinite(right).all(), 'Invalid ranged samples'
        percent, half = ratio_interval(left, right)
        assert abs(percent - comparison['percent']) < 1e-8 and abs(half - comparison['halfWidthPercent']) < 1e-6, 'Ranged diagnostic interval mismatch'

    exports = read(run / 'exports/verification.json')
    expected_pairs = {(p['faction'], p['id'], race) for p in catalog['profiles'] for race in p['races']}
    assert set(exports['exactNativeAplControls']) == {'--'.join(pair) for pair in expected_pairs}, 'Website controls omit a race/build pair'
    for entry in exports['exports']:
        assert digest(run / 'exports' / (entry['key'] + '.website.json')) == entry['sha256'], 'Website export changed'
        assert digest(run / 'requests' / (entry['key'] + '.json')) == entry['nativeRequestSha256'], 'Website source request changed'
    for faction, profile_id, race in expected_pairs:
        key = hashlib.sha256('--'.join([faction, profile_id, race]).encode()).hexdigest()[:24]
        a, b = [read(run / 'exports/proof' / (key + suffix + '.result.json')) for suffix in ['--apl', '--original']]
        assert a['iterationsDone'] == b['iterationsDone'] == 100, 'Website control iterations differ'
        assert a['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'] == b['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'], 'Website APL freeze changed results'

    class_probe = read(run / 'class-racial-controls/analysis.json')
    assert class_probe['engineSha256'] == provenance['engineSha256'], 'Class racial controls use another engine'
    class_sources = {row['key'] for row in cells if row['phase'] in ['preflight', 'resolved-preflight'] and row['className'] == 'Priest' and row['race'] in ['RaceDwarf', 'RaceNightElf']}
    expected_controls = {(key, duration) for key in class_sources for duration in settings['durations']}
    assert {(row['sourceKey'], row['duration']) for row in class_probe['rows']} == expected_controls, 'Class racial control coverage differs'
    assert len(class_probe['rows']) == 2 * len(expected_controls) and len(class_probe['comparisons']) == len(expected_controls), 'Incomplete paired class racial controls'
    probe_samples = {}
    for row in class_probe['rows']:
        for directory, field in [('requests', 'requestSha256'), ('results', 'resultSha256')]:
            assert digest(run / 'class-racial-controls' / directory / (row['key'] + '.json')) == row[field], 'Class racial artifact changed'
        raw = read(run / 'class-racial-controls/results' / (row['key'] + '.json'))
        assert raw['iterationsDone'] == class_probe['iterations'], 'Class racial sample incomplete'
        probe_samples[row['key']] = np.asarray(raw['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'], dtype=float)
    for comparison in class_probe['comparisons']:
        left, right = [probe_samples[comparison[key]] for key in ['probeKey', 'baselineKey']]
        assert len(left) == len(right) == class_probe['iterations'] and np.isfinite(left).all() and np.isfinite(right).all(), 'Invalid class racial samples'
        percent, half = ratio_interval(left, right)
        assert abs(percent - comparison['percent']) < 1e-8 and abs(half - comparison['halfWidthPercent']) < 1e-6, 'Class racial interval differs'
        if comparison['classRacialCasts'] == 0:
            assert np.array_equal(left, right), 'Non-casting class racial changed a sample'

    pets = read(run / 'hunter-pet-controls/analysis.json')
    assert pets['engineSha256'] == provenance['engineSha256'], 'Pet controls use another engine'
    no_pet_profiles = [p for p in catalog['profiles'] if p['className'] == 'Hunter' and p['player']['hunter']['options']['classOptions'].get('petType') in [None, 'PetNone']]
    expected_pets, expected_pet_gaps = set(), set()
    for p in no_pet_profiles:
        for pool in ['developer', 'published-pre-raid']:
            available = any(g['id'] == p.get('referenceSetId', 'developer') if pool == 'developer' else any(a.get('tier') == 'Published pre-raid' for a in [g, *g['aliases']]) for g in p['sets'])
            if not available:
                expected_pet_gaps.add((p['faction'], p['id'], pool))
                continue
            expected_pets.update((p['faction'], p['id'], race, duration, pool, variant) for race in p['races'] for duration in settings['durations'] for variant in ['petless', 'raptor'])
    actual_pet_gaps = {(g['faction'], g['profileId'], g['pool']) for g in pets.get('coverageGaps', [])}
    assert actual_pet_gaps == expected_pet_gaps and len(pets.get('coverageGaps', [])) == len(expected_pet_gaps), 'Pet equipment gaps differ from the catalogue'
    assert {(r['faction'], r['profileId'], r['race'], r['duration'], r['pool'], r['variant']) for r in pets['rows']} == expected_pets and len(pets['rows']) == len(expected_pets), 'Pet controls omit a condition'
    pet_samples = {}
    for row in pets['rows']:
        assert row['sourceRequestSha256'] == cell_map[row['sourceKey']]['requestSha256'], 'Pet source request differs'
        for directory, field in [('requests', 'requestSha256'), ('results', 'resultSha256')]:
            assert digest(run / 'hunter-pet-controls' / directory / (row['key'] + '.json')) == row[field], 'Pet control artifact changed'
        expected_request = deepcopy(read(run / 'requests' / (row['sourceKey'] + '.json')))
        expected_request['simOptions'].update(iterations=pets['iterations'], randomSeed=str(pets['seed']))
        if row['variant'] == 'raptor':
            expected_request['raid']['parties'][0]['players'][0]['hunter']['options']['classOptions']['petType'] = 'Raptor'
        assert expected_request == read(run / 'hunter-pet-controls/requests' / (row['key'] + '.json')), 'Pet control changes fields beyond petType'
        raw = read(run / 'hunter-pet-controls/results' / (row['key'] + '.json'))
        assert raw['iterationsDone'] == pets['iterations'], 'Pet control iterations differ'
        player = raw['raidMetrics']['parties'][0]['players'][0]
        raptors = [pet for pet in player['pets'] if 'raptor' in pet['name'].lower() and pet['dps']['avg'] > 0]
        assert bool(raptors) == (row['variant'] == 'raptor'), 'Pet control runtime coverage differs'
        pet_samples[row['key']] = np.asarray(player['dps']['allValues'], dtype=float)
    for contrast in pets['contrasts']:
        left, right = [pet_samples[contrast[key]] for key in ['probeKey', 'baselineKey']]
        assert len(left) == len(right) == pets['iterations'] and np.isfinite(left).all() and np.isfinite(right).all(), 'Invalid pet control samples'
        percent, half = ratio_interval(left, right)
        assert abs(percent - contrast['percent']) < 1e-8 and abs(half - contrast['halfWidthPercent']) < 1e-6, 'Pet contrast interval differs'

    ranges = [(settings[name + 'Seed'], settings[name + 'Seed'] + settings[name + 'Iterations']) for name in ['screen', 'validation', 'confirmation', 'precision']]
    assert all(a[1] < b[0] for a, b in zip(ranges, ranges[1:])), 'Stage seed ranges overlap'
    receipt = {'passed': True, 'cells': len(cells), 'raceComparisons': len(analysis['groups']), 'factionBuilds': len(profile_map), 'checks': ['engine and all input/result/stats hashes', 'independent NumPy means and sample deviations', 'independent NormalDist and NumPy paired intervals', 'complete legal race membership', 'real gear and unchanged talents', 'no injected stats in realistic cases', 'positive Mutilate usage', 'Dwarf hit bonus on identical sets', 'synthetic hit units against zero-offset controls', 'disjoint stage seed ranges', 'no training samples used as final recommendations']}
    receipt['checks'].extend(['archived execution tool hashes', 'website export hashes and every race/build APL control', 'factorial Hunter ranged-input controls', 'complete Priest racial controls and independently recomputed intervals'])
    receipt['checks'].append('complete Hunter pet controls for available pools, explicit gear gaps, unchanged other inputs and independently recomputed intervals')
    receipt['inputHashes'] = {name: digest(run / name) for name in ['analysis.json', 'cells.json', 'provenance.json', 'profiles.json', 'coverage.json', 'gear-legality.json', 'methodology.json', 'mechanics-coverage.json', 'driver-verification.json', 'rotation-resolution-effects.json', 'execution-revisions.json', 'exports/verification.json', 'hunter-ranged-controls/analysis.json', 'class-racial-controls/analysis.json', 'hunter-pet-controls/analysis.json']}
    (run / 'verification.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    verify(Path(sys.argv[1]).resolve())
