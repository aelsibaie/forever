"""Prepare developer rotation corrections and merge their independently rerun cases."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
from datetime import datetime, timezone


def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def cooldown_block(rotation):
    found = []
    for i, line in enumerate(rotation['priorityList']):
        action = line.get('action', {})
        direct = action.get('castSpell', {}).get('spellId', {}).get('spellId') == 13750
        sequence = any(a.get('castSpell', {}).get('spellId', {}).get('spellId') == 13750 for a in action.get('strictSequence', {}).get('actions', []))
        if direct or sequence:
            found.append(i)
    if len(found) != 3 or found != list(range(found[0], found[0] + 3)):
        raise ValueError('Review the changed developer Adrenaline Rush layout before repairing saved inputs.')
    return found


def prepare(source, preset, destination, ids):
    profiles = read(source / 'source-profiles.json')
    profiles['profiles'] = [p for p in profiles['profiles'] if p['id'] in ids]
    if {p['id'] for p in profiles['profiles']} != set(ids):
        raise ValueError('A selected source profile is missing.')
    current = read(preset)
    block = cooldown_block(current)
    replacement = deepcopy(current['priorityList'][block[0]:block[-1] + 1])
    for profile in profiles['profiles']:
        old = deepcopy(profile['player'])
        rotation = profile['player']['rotation']
        indices = cooldown_block(rotation)
        rotation['priorityList'][indices[0]:indices[-1] + 1] = deepcopy(replacement)
        old.pop('rotation')
        retained = deepcopy(profile['player'])
        retained.pop('rotation')
        if old != retained:
            raise ValueError('Rotation preparation changed another player input.')
    write(destination, profiles)
    write(destination.with_suffix('.receipt.json'), {'profiles': ids, 'presetSha256': sha(preset), 'sourceProfilesSha256': sha(source / 'source-profiles.json'), 'preparedSha256': sha(destination), 'policy': 'Replace only the three Adrenaline Rush cooldown lines with the current developer preset block.'})


def remap(value, keys):
    if isinstance(value, dict):
        return {k: remap(v, keys) for k, v in value.items()}
    if isinstance(value, list):
        return [remap(v, keys) for v in value]
    return keys.get(value, value) if isinstance(value, str) else value


def merge(base, patch, output):
    if output.resolve() == base.resolve() or not (output / 'cells.json').exists():
        raise ValueError('Prepare a separate derived study before merging.')
    previous = read(output / 'provenance.json').get('inputRevisions', [])
    if any(r['patchedAnalysisSha256'] == sha(patch / 'analysis.json') for r in previous):
        raise ValueError('This patch is already applied.')
    provenance, newer = read(base / 'provenance.json'), read(patch / 'provenance.json')
    for field in ['engineSha256', 'gearCatalogSha256']:
        if provenance[field] != newer[field]:
            raise ValueError('The patch changes simulator, equipment or sampling settings: ' + field)
    if {k: v for k, v in provenance['settings'].items() if k != 'workers'} != {k: v for k, v in newer['settings'].items() if k != 'workers'}:
        raise ValueError('The patch changes sampling settings.')
    if sha(patch / 'engine/batch.exe') != provenance['engineSha256']:
        raise ValueError('Patch engine differs from the frozen source.')
    updated = read(patch / 'profiles.json')['profiles']
    targets = {(p['faction'], p['id']) for p in updated}
    old_profiles = read(output / 'profiles.json')
    for p in updated:
        old = next(q for q in old_profiles['profiles'] if (q['faction'], q['id']) == (p['faction'], p['id']))
        comparable = lambda sets: [{k: v for k, v in gear.items() if k not in ['categoryConflicts', 'diagnosticOnly']} for gear in sets]
        if comparable(old['sets']) != comparable(p['sets']):
            raise ValueError('The patch changes the equipment catalogue: ' + p['id'])
        p['sets'] = deepcopy(old['sets'])
    belongs = lambda r: (r['faction'], r.get('profileId', r.get('id'))) in targets
    fresh_cells = read(patch / 'cells.json')
    prefix = 'rotationfix-' + newer['profilesSha256'][:12] + '--'
    keys = {row['key']: prefix + row['key'] for row in fresh_cells}
    for row in fresh_cells:
        for directory, field in [('requests', 'requestSha256'), ('results', 'resultSha256'), ('stats', 'statsSha256')]:
            original = patch / directory / (row['key'] + '.json')
            if sha(original) != row[field]:
                raise ValueError('Patch hash differs: ' + row['key'])
            target = output / directory / (keys[row['key']] + '.json')
            if target.exists():
                raise ValueError('Refusing to replace an existing raw file: ' + target.name)
            shutil.copy2(original, target)
        receipt = patch / 'results' / (row['key'] + '.receipt.json')
        if receipt.exists():
            shutil.copy2(receipt, output / 'results' / (keys[row['key']] + '.receipt.json'))
    cells = read(output / 'cells.json')
    preserved = [r for r in cells if not belongs(r)]
    write(output / 'cells.json', preserved + remap(fresh_cells, keys))
    analysis = read(output / 'analysis.json')
    analysis['groups'] = [g for g in analysis['groups'] if not belongs(g)] + remap(read(patch / 'analysis.json')['groups'], keys)
    write(output / 'analysis.json', analysis)
    replacement = {(p['faction'], p['id']): p for p in updated}
    old_profiles['profiles'] = [replacement.get((p['faction'], p['id']), p) for p in old_profiles['profiles']]
    write(output / 'profiles.json', old_profiles)
    resolution = read(output / 'rotation-resolution-effects.json')
    write(output / 'rotation-resolution-effects.json', [r for r in resolution if not belongs(r)] + remap(read(patch / 'rotation-resolution-effects.json'), keys))
    resolved = read(output / 'rotation-resolution.json')
    resolved = {k: v for k, v in resolved.items() if not any('--' + p['id'] + '--' in k for p in updated)}
    resolved.update(read(patch / 'rotation-resolution.json'))
    write(output / 'rotation-resolution.json', resolved)
    source_profiles = read(output / 'source-profiles.json')
    patch_sources = {p['id']: p for p in read(patch / 'source-profiles.json')['profiles']}
    source_profiles['profiles'] = [patch_sources.get(p['id'], p) for p in source_profiles['profiles']]
    write(output / 'source-profiles.json', source_profiles)
    coverage = read(output / 'coverage.json')
    coverage['cells'] = len(preserved) + len(fresh_cells)
    coverage['groups'] = len(analysis['groups'])
    write(output / 'coverage.json', coverage)
    for sub in (patch / 'tooling').iterdir():
        shutil.copytree(sub, output / 'tooling' / sub.name, dirs_exist_ok=True)
    revision = {'recordedAt': datetime.now(timezone.utc).isoformat(), 'sourceStudy': base.name, 'sourceAnalysisSha256': sha(base / 'analysis.json'), 'sourceCellsSha256': sha(base / 'cells.json'), 'patchedAnalysisSha256': sha(patch / 'analysis.json'), 'patchProvenance': newer, 'repairedProfiles': sorted({p['id'] for p in updated}), 'factionBuilds': len(targets), 'rerunCells': len(fresh_cells), 'preservedCells': len(preserved), 'rawKeyPrefix': prefix, 'policy': 'Fresh screening, validation, confirmation, precision and diagnostic phases replace affected builds only. Original raw cases and the base study remain preserved.'}
    revisions = previous + [revision]
    total_rerun = sum(r['rerunCells'] for r in revisions)
    combined = {'recordedAt': revision['recordedAt'], 'revisions': revisions, 'repairedProfiles': sorted({p for r in revisions for p in r['repairedProfiles']}), 'factionBuilds': sum(r['factionBuilds'] for r in revisions), 'rerunCells': total_rerun, 'preservedCells': len(preserved) + len(fresh_cells) - total_rerun}
    write(output / 'rotation-repair.json', combined)
    provenance['inputRevisions'] = revisions
    write(output / 'provenance.json', provenance)
    print(json.dumps({k: revision[k] for k in ['repairedProfiles', 'factionBuilds', 'rerunCells', 'preservedCells', 'rawKeyPrefix']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare')
    prep.add_argument('source', type=Path)
    prep.add_argument('preset', type=Path)
    prep.add_argument('destination', type=Path)
    prep.add_argument('--profiles', default='rogue-dps-combat-ss,rogue-dps-combat-bs')
    edit = commands.add_parser('merge')
    edit.add_argument('base', type=Path)
    edit.add_argument('patch', type=Path)
    edit.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.source, args.preset, args.destination, args.profiles.split(','))
    else:
        merge(args.base, args.patch, args.output)
