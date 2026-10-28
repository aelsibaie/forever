import csv
import hashlib
import html
import json
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


RACE_NAMES = {'RaceOrc': 'Orc', 'RaceTroll': 'Troll', 'RaceUndead': 'Undead', 'RaceTauren': 'Tauren', 'RaceWindshaperSkyborne': 'Skyborne', 'RaceHighOrderSkyborne': 'Skyborne', 'RaceHuman': 'Human', 'RaceDwarf': 'Dwarf', 'RaceNightElf': 'Night Elf', 'RaceGnome': 'Gnome'}
RACE_COLORS = {'Orc': '#8fc66b', 'Troll': '#4bd2c5', 'Undead': '#c3a0eb', 'Tauren': '#cbb683', 'Skyborne': '#72b8ff', 'Human': '#e4c27a', 'Dwarf': '#d69b72', 'Night Elf': '#91a4f2', 'Gnome': '#edacbf'}
CLASS_COLORS = {'Druid': '#f29b5e', 'Hunter': '#a3ce77', 'Mage': '#82ceee', 'Paladin': '#ec9fc6', 'Priest': '#e5e6ef', 'Rogue': '#e4ce71', 'Shaman': '#71a6ed', 'Warlock': '#b4a1e8', 'Warrior': '#c7a489'}
SPEC_LABELS = {
    'druid/balance': 'Balance Druid', 'druid/feral-dps': 'Feral Druid',
    'hunter/sv-weave': 'Survival Hunter', 'hunter/survival': 'Survival Hunter', 'hunter/survival-melee': 'Survival Hunter',
    'hunter/mm-weave': 'Marksmanship Hunter', 'hunter/marksmanship': 'Marksmanship Hunter',
    'hunter/bm-weave': 'Beast Mastery Hunter', 'hunter/beast-mastery': 'Beast Mastery Hunter',
    'mage/arcane': 'Arcane Mage', 'mage/arcane-fire': 'Arcane Mage', 'mage/frostfire': 'Frostfire Mage', 'mage/fire': 'Fire Mage', 'mage/frost': 'Frost Mage',
    'paladin/retribution': 'Retribution Paladin', 'paladin/holy-shock': 'Holy Shock DPS Paladin',
    'priest/shadow': 'Shadow Priest', 'priest/smite': 'Smite Priest',
    'rogue/assassination': 'Assassination Rogue', 'rogue/combat-mutilate': 'Combat Rogue', 'rogue/combat': 'Combat Rogue', 'rogue/combat-daggers': 'Combat Rogue',
    'rogue/subtlety': 'Subtlety Rogue', 'rogue/subtlety-backstab': 'Subtlety Rogue',
    'shaman/elemental': 'Elemental Shaman', 'shaman/enhancement': 'Enhancement Shaman',
    'warlock/demonology': 'Demonology Warlock', 'warlock/demonology-shadow': 'Demonology Warlock', 'warlock/destruction': 'Destruction Warlock',
    'warlock/sm-ruin': 'Affliction Warlock', 'warlock/affliction': 'Affliction Warlock',
    'warrior/fury': 'Fury Warrior', 'warrior/arms': 'Arms Warrior',
}
SLOTS = ['Head', 'Neck', 'Shoulder', 'Back', 'Chest', 'Wrist', 'Hands', 'Waist', 'Legs', 'Feet', 'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Main hand', 'Off hand', 'Ranged / relic']
BG, PANEL, INK, MUTED = '#0b1220', '#141f31', '#e7edf5', '#9fadc3'
plt.rcParams.update({'font.family': 'DejaVu Sans', 'text.color': INK, 'axes.labelcolor': MUTED, 'xtick.color': MUTED, 'ytick.color': MUTED, 'axes.edgecolor': '#34435a', 'savefig.facecolor': BG, 'font.size': 10})


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def e(value):
    return html.escape(str(value), quote=True)


def profile_title(profile):
    return SPEC_LABELS.get(profile['spec'], profile['className']) + ' · ' + profile['name']


def confidence_notes(profile, groups, mechanics, resolution):
    notes = []
    if any(g.get('diagnosticOnly') for g in profile['sets']):
        notes.append('Conflicting unique-equipped developer items excluded from recommendations')
    entry = next(p for p in mechanics['profiles'] if p['profileId'] == profile['id'] and p['faction'] == profile['faction'])
    missing = [s for s in entry['sets'] if s['missingItems']]
    if missing:
        notes.append('Some equipment has unimplemented item effects')
    if any(s['missingEnchants'] or s['missingSets'] for s in entry['sets']):
        notes.append('Some equipment has unimplemented enchant or set effects')
    if any(s['unvalidatedRates'] for s in entry['sets']):
        notes.append('Some equipment uses unmeasured proc rates')
    if any(s['revelation'] for s in entry['sets']):
        notes.append('Revelation uses a provisional proc model')
    if entry['mutilateProcCaveat']:
        notes.append('Mutilate works; poison and Eureka interactions still carry upstream verification TODOs')
    if any(gear.get('hunterCompatibilityMapping') for gear in profile['sets']):
        notes.append('Melee Hunter uses a documented ammo/container effect translation')
    if profile['className'] == 'Hunter' and profile['player']['hunter']['options']['classOptions'].get('petType') in [None, 'PetNone']:
        notes.append('Intentional Lone Wolf petless build; pet-choice sensitivity is separate')
    effects = [r for r in resolution if r['profileId'] == profile['id'] and r['faction'] == profile['faction']]
    if any(abs(r['differencePercent']) > 1 for r in effects):
        notes.append('Sensitive to unavailable rotation references')
    fixed = [g for g in groups if g['mode'] == 'fixed-set' and g['profileId'] == profile['id'] and g['faction'] == profile['faction'] and g['duration'] == 180 and g['support'] == 'full' and g['referencePolicy'] == 'developer' and not g.get('diagnosticOnly')]
    physical = profile['className'] in ['Warrior', 'Rogue', 'Hunter'] or any(s in profile['spec'] for s in ['feral', 'enhancement', 'retribution'])
    stat = 'MeleeHitPercent' if physical else 'SpellHitPercent'
    hits = [g['rows'][0]['stats'][stat] for g in fixed]
    if hits and max(hits) - min(hits) < 1:
        notes.append('Narrow actual equipment hit range')
    return notes


def assess(groups, races, tolerance=0.2):
    losses = []
    for race in races:
        comps = [next(c for c in g['comparisons'] if c['race'] == race) for g in groups]
        if not comps:
            continue
        upper_losses = []
        for group, own in zip(groups, comps):
            others = [c for c in group['comparisons'] if c['race'] != race]
            lower = max(0, 100 + own['percent'] - own['halfWidthPercent'])
            # Any competitor can be the true leader within the simultaneous ratio intervals.
            best_other_upper = max((100 + c['percent'] + c['halfWidthPercent'] for c in others), default=lower)
            upper_losses.append(max(0, 100 * (1 - lower / best_other_upper)) if best_other_upper else 0)
        worst = max(range(len(comps)), key=lambda i: upper_losses[i])
        losses.append({'race': race, 'worstMeanLoss': max(0, max(-c['percent'] for c in comps)), 'worstUpperLoss': upper_losses[worst], 'worstCondition': groups[worst]['key']})
    losses.sort(key=lambda row: (row['worstUpperLoss'], row['worstMeanLoss']))
    safe = [r['race'] for r in losses if r['worstUpperLoss'] <= tolerance]
    return {'safe': safe, 'preferred': losses[0]['race'] if losses else None, 'losses': losses, 'conditions': len(groups), 'sets': len(set(g['setId'] for g in groups if g['setId'])), 'leaders': sorted(set(g['leader'] for g in groups)), 'precisionLimited': not safe and any(r['worstMeanLoss'] <= tolerance for r in losses)}


def cell_text(assessment):
    if not assessment['preferred']:
        return 'Coverage gap', '', None
    names = assessment['safe'] or [assessment['preferred']]
    title = ' / '.join(RACE_NAMES[r] for r in names)
    bound = max(next(x['worstUpperLoss'] for x in assessment['losses'] if x['race'] == r) for r in names)
    bound_text = '>0.20%' if not assessment['safe'] and round(bound, 2) == .2 else f'{bound:.2f}%'
    subtitle = ('Consistent within 0.2%' if assessment['safe'] else 'Precision limited' if assessment['precisionLimited'] else 'Setup dependent') + ' · upper loss ' + bound_text
    return title, subtitle, RACE_COLORS[RACE_NAMES[assessment['preferred']]] if assessment['safe'] else MUTED


def assessment_groups(profile, groups, pool, duration, basis='across-gear', support='both'):
    relevant = [g for g in groups if g['profileId'] == profile['id'] and g['faction'] == profile['faction'] and g['duration'] == duration and not g.get('diagnosticOnly') and (support == 'both' or g['support'] == support)]
    if basis == 'selected-gear':
        return [g for g in relevant if g['mode'] == 'pool:' + pool]
    sets = {gear['id'] for gear in profile['sets'] if any((s.get('tier') == 'Published pre-raid' if pool == 'published-pre-raid' else s.get('origin') == 'WoWSims developer') for s in [gear, *gear['aliases']])}
    return [g for g in relevant if g['mode'] == 'fixed-set' and g['setId'] in sets]


def material_reversals(groups, mode, varying):
    matched = defaultdict(list)
    for group in groups:
        if group['mode'] == mode and group['duration'] == 180 and group['support'] == 'full' and group['referencePolicy'] == 'developer' and not group.get('diagnosticOnly'):
            matched[(group['faction'], group['profileId'])].append(group)
    findings = []
    for (faction, profile_id), cases in matched.items():
        for i, left in enumerate(cases):
            for right in cases[i + 1:]:
                if left['leader'] == right['leader']:
                    continue
                a = next(c for c in left['comparisons'] if c['race'] == right['leader'])
                b = next(c for c in right['comparisons'] if c['race'] == left['leader'])
                if a['percent'] + a['halfWidthPercent'] < -.2 and b['percent'] + b['halfWidthPercent'] < -.2:
                    findings.append({'faction': faction, 'profileId': profile_id, 'first': {'condition': left[varying], 'race': left['leader'], 'leadPercent': -a['percent'], 'intervalHalfWidth': a['halfWidthPercent']}, 'second': {'condition': right[varying], 'race': right['leader'], 'leadPercent': -b['percent'], 'intervalHalfWidth': b['halfWidthPercent']}, 'scope': '180 seconds, full support, original developer references; both race leads exceed 0.2% after their interval margins.'})
    return findings


def pet_detail(profile, pets):
    groups = [g for g in pets['groups'] if g['profileId'] == profile['id'] and g['faction'] == profile['faction']]
    if not groups:
        return ''
    rows = []
    for group in groups:
        for row in sorted(group['rows'], key=lambda r: -r['meanDps']):
            c = next(c for c in group['comparisons'] if c['race'] == row['race'])
            rows.append(f'<tr><td>{group["duration"]}</td><td>{e(group["pool"])}</td><td>{e(group["variant"])}</td><td>{RACE_NAMES[row["race"]]}</td><td>{row["meanDps"]:.2f}</td><td>{c["percent"]:+.3f}% ± {c["halfWidthPercent"]:.3f}</td><td><a href="../hunter-pet-controls/requests/{row["key"]}.json">Input</a> · <a href="../hunter-pet-controls/results/{row["key"]}.json">Result</a></td></tr>')
    return '<details><summary>Lone Wolf pet sensitivity</summary><p>Petless versus Raptor, changing only petType. Original talents and racial policy remain fixed. Developer anchor and validation-selected published gear; 1,000 independent iterations, full support and original developer references. This is a sensitivity check, without pet-family or talent optimization. Gaps compare races within that same pet choice, equipment pool and duration.</p><div class="scroll"><table><thead><tr><th>Seconds</th><th>Pool</th><th>Pet choice</th><th>Race</th><th>DPS</th><th>Gap and interval</th><th>Replay</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div></details>'


def overview(directory, faction, profiles, groups, pool, provenance):
    data = [p for p in profiles if p['faction'] == faction]
    height = 2.8 + len(data) * .42
    fig, ax = plt.subplots(figsize=(13.5, height))
    fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
    ax.set_xlim(-.02, 3.03); ax.set_ylim(len(data) - .45, -1.2); ax.axis('off')
    fig.subplots_adjust(left=.35, right=.97, top=1 - 1.7 / height, bottom=.8 / height)
    fig.text(.055, 1 - .45 / height, 'WoWSims Forever / RACE ROBUSTNESS', color=MUTED, fontsize=11, weight='bold')
    fig.text(.055, 1 - .98 / height, faction.title() + ': choices across equipment and support', fontsize=23, weight='bold')
    fig.text(.055, 1 - 1.39 / height, f'Every accepted published pre-raid set · {provenance["settings"]["validationIterations"]:,} independent iterations per set · neutral target', color=MUTED, fontsize=10)
    for j, duration in enumerate([60, 180, 300]):
        ax.text(j + .5, -.83, f'{duration} seconds', color=MUTED, ha='center', va='center', fontsize=12)
    for i, p in enumerate(data):
        ax.text(-.07, i, profile_title(p) + (' †' if p.get('confidenceNotes') else ''), color=CLASS_COLORS[p['className']], ha='right', va='center', fontsize=8.4)
        for j, duration in enumerate([60, 180, 300]):
            matched = assessment_groups(p, groups, pool, duration)
            result = assess(matched, p['races']); title, subtitle, color = cell_text(result)
            if len(p['races']) == 1:
                title = RACE_NAMES[p['races'][0]] + ' only'; subtitle = 'No faction alternative'
            ax.add_patch(plt.Rectangle((j + .025, i - .37), .95, .74, facecolor=PANEL, edgecolor=color or '#526076', linewidth=.8))
            ax.text(j + .5, i - .085, title, color=color or MUTED, ha='center', va='center', fontsize=9.1, weight='bold')
            ax.text(j + .5, i + .16, subtitle, color=MUTED, ha='center', va='center', fontsize=6.8)
    fig.text(.055, .39 / height, f'Source {provenance["sourceCommit"][:10]} · {provenance["model"]["name"]} · 60/180/300s · full/self support · developer/explicit references', fontsize=8, color=MUTED)
    fig.text(.055, .16 / height, '† Model or equipment-coverage caveat; see report. Loss is the largest upper interval bound across shown conditions. Gear search uses a finite catalogue.', fontsize=8, color=MUTED)
    for extension in ['png', 'svg']:
        fig.savefig(directory / f'{faction}-overview.{extension}', dpi=155)
    plt.close(fig)


def detail_chart(directory, profile, groups):
    fixed = [g for g in groups if g['mode'] == 'fixed-set' and g['profileId'] == profile['id'] and g['faction'] == profile['faction'] and g['duration'] == 180 and g['support'] == 'full' and g['referencePolicy'] == 'developer' and not g.get('diagnosticOnly')]
    hit = sorted([g for g in groups if g['mode'] == 'hit-control' and g['profileId'] == profile['id'] and g['faction'] == profile['faction'] and g['duration'] == 180 and g['referencePolicy'] == 'developer' and not g.get('diagnosticOnly')], key=lambda g: g['hitOffset'])
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.6))
    fig.patch.set_facecolor(BG); fig.subplots_adjust(left=.07, right=.98, top=.72, bottom=.26, wspace=.25)
    fig.text(.055, .91, profile_title(profile), fontsize=20, weight='bold', color=CLASS_COLORS[profile['className']])
    fig.text(.055, .83, profile['faction'].title() + ' · 180 seconds · full support · developer reference handling · paired intervals', color=MUTED)
    for ax in axes:
        ax.set_facecolor(PANEL); ax.spines[['top', 'right']].set_visible(False); ax.grid(axis='y', color='#2d3c52', linewidth=.6); ax.set_axisbelow(True); ax.axhline(0, color=MUTED, linewidth=.7)
    for ri, race in enumerate(profile['races']):
        color = RACE_COLORS[RACE_NAMES[race]]
        y, err = [], []
        for group in fixed:
            c = next(c for c in group['comparisons'] if c['race'] == race); y.append(c['percent']); err.append(c['halfWidthPercent'])
        axes[0].errorbar(np.arange(len(fixed)) + (ri - (len(profile['races']) - 1) / 2) * .07, y, yerr=err, linestyle='none', marker='o', markersize=4, capsize=2, color=color, label=RACE_NAMES[race])
        y, err = [], []
        for group in hit:
            c = next(c for c in group['comparisons'] if c['race'] == race); y.append(c['percent']); err.append(c['halfWidthPercent'])
        axes[1].errorbar([g['hitOffset'] for g in hit], y, yerr=err, marker='x', linestyle='--', alpha=.85, capsize=3, color=color)
    axes[0].set_title('Actual equipment sets', color=INK); axes[0].set_ylabel('Difference from highest sampled mean (%)'); axes[0].set_xlabel('Set number; item lists are below'); axes[0].set_xticks(range(len(fixed)), range(1, len(fixed) + 1))
    axes[1].set_title('Separate hit controls on developer equipment', color=INK); axes[1].set_xlabel('Synthetic hit offset (percentage points)'); axes[1].set_xticks([-4, -2, 0, 2, 4])
    if not hit:
        axes[1].text(.5, .5, 'Original reference excluded\nUnique-equipped category conflict', transform=axes[1].transAxes, ha='center', va='center', color=MUTED)
    handles, labels = axes[0].get_legend_handles_labels(); fig.legend(handles, labels, loc='lower center', bbox_to_anchor=(.5, .10), ncol=min(5, len(labels)), frameon=False)
    fig.text(.055, .04, 'Actual set changes include their stat trade-offs. Hit controls change only HitRating and do not count as real gear evidence.', color=MUTED, fontsize=9)
    stem = profile['faction'] + '--' + profile['id']
    for ext in ['png', 'svg']:
        fig.savefig(directory / (stem + '.' + ext), dpi=145)
    plt.close(fig)
    return fixed


def render(run):
    verified = read(run / 'verification.json')
    if not verified.get('passed') or not verified.get('inputHashes'):
        raise ValueError('Run the independent archive verifier before rendering.')
    for name, expected in verified['inputHashes'].items():
        if hashlib.sha256((run / name).read_bytes()).hexdigest() != expected:
            raise ValueError('Verified input changed: ' + name)
    analysis, provenance, catalog, coverage = [read(run / f) for f in ['analysis.json', 'provenance.json', 'profiles.json', 'coverage.json']]
    profiles, groups = catalog['profiles'], analysis['groups']
    gear_reversals = material_reversals(groups, 'fixed-set', 'setId')
    hit_reversals = material_reversals(groups, 'hit-control', 'hitOffset')
    (run / 'findings.json').write_text(json.dumps({'realGearReversals': gear_reversals, 'syntheticHitReversals': hit_reversals, 'interpretation': 'Matched-condition sensitivity examples, not real-world win probabilities. Fixed-set examples may cross the separately labeled developer and published pools; the exact sets are named.'}, indent=2), encoding='utf-8')
    mechanics = read(run / 'mechanics-coverage.json')
    resolution = read(run / 'rotation-resolution-effects.json')
    pets = read(run / 'hunter-pet-controls/analysis.json')
    for profile in profiles:
        profile['confidenceNotes'] = confidence_notes(profile, groups, mechanics, resolution)
    charts = run / 'charts'; charts.mkdir(exist_ok=True)
    pages = run / 'builds'; pages.mkdir(exist_ok=True)
    summaries, target_summaries, creature_rows = [], [], []
    for faction in ['horde', 'alliance']:
        overview(charts, faction, profiles, groups, 'published-pre-raid', provenance)
    rows, pet_rows = [], []
    for p in profiles:
        pet_groups = [g for g in pets['groups'] if g['profileId'] == p['id'] and g['faction'] == p['faction'] and g['duration'] == 180 and g['pool'] == 'published-pre-raid']
        if pet_groups:
            leaders = {g['variant']: RACE_NAMES[g['leader']] for g in pet_groups}
            contrasts = [r for r in pets['contrasts'] if r['profileId'] == p['id'] and r['faction'] == p['faction'] and r['duration'] == 180 and r['pool'] == 'published-pre-raid']
            change = f'{min(r["percent"] for r in contrasts):+.2f}% to {max(r["percent"] for r in contrasts):+.2f}%'
            pet_rows.append(f'<tr data-faction="{p["faction"]}" data-aux="pets" data-search="{e(profile_title(p).lower())}"><th><a href="builds/{p["faction"]}--{p["id"]}.html">{e(profile_title(p))}</a></th><td>{leaders["petless"]}</td><td>{leaders["raptor"]}</td><td>{change}</td></tr>')
        target_cells = []
        creature_detail = []
        for target in ['beast', 'elemental']:
            matched = [g for g in groups if g['mode'] == 'creature-control' and g['profileId'] == p['id'] and g['faction'] == p['faction'] and g['target'] == target and not g.get('diagnosticOnly')]
            result = assess(matched, p['races'])
            target_summaries.append({'profileId': p['id'], 'faction': p['faction'], 'target': target, 'duration': 180, **result})
            title, subtitle, color = cell_text(result)
            if not matched:
                title, subtitle = 'Excluded reference', 'Unique-equipped item conflict'
            if len(p['races']) == 1:
                title, subtitle = RACE_NAMES[p['races'][0]] + ' only', 'No faction alternative'
            target_cells.append(f'<td><b style="color:{color or MUTED}">{e(title)}</b><small>{e(subtitle)}</small></td>')
            for group in matched:
                for row in sorted(group['rows'], key=lambda r: -r['meanDps']):
                    c = next(c for c in group['comparisons'] if c['race'] == row['race'])
                    creature_detail.append(f'<tr><td>{e(target)}</td><td>{e(group["referencePolicy"])}</td><td>{RACE_NAMES[row["race"]]}</td><td>{row["meanDps"]:.2f}</td><td>{c["percent"]:+.3f}% ± {c["halfWidthPercent"]:.3f}</td><td><a href="../requests/{row["key"]}.json">Input</a> · <a href="../results/{row["key"]}.json">Result</a></td></tr>')
        creature_rows.append(f'<tr data-faction="{p["faction"]}" data-aux="creature" data-search="{e(profile_title(p).lower())}"><th>{e(profile_title(p))}</th>{"".join(target_cells)}</tr>')
        for pool, basis, support in [(pool, basis, support) for pool in ['published-pre-raid', 'developer-reference'] for basis in ['across-gear', 'selected-gear'] for support in ['both', 'full', 'self']]:
            cells = []
            for duration in [60, 180, 300]:
                subset = assessment_groups(p, groups, pool, duration, basis, support)
                result = assess(subset, p['races']); summaries.append({'faction': p['faction'], 'profileId': p['id'], 'pool': pool, 'basis': basis, 'supportScope': support, 'duration': duration, 'confidenceNotes': p['confidenceNotes'], **result})
                title, subtitle, color = cell_text(result)
                if len(p['races']) == 1: title, subtitle = RACE_NAMES[p['races'][0]] + ' only', 'No faction alternative'
                cells.append(f'<td><b style="color:{color or MUTED}">{e(title)}</b><small>{e(subtitle)}</small></td>')
            missing = sum(bool(s.get('substitutions')) for s in p['sets'])
            valid_sets = sum(not g.get('diagnosticOnly') for g in p['sets'])
            confidence = f'{valid_sets} valid sets; {missing} use published replacements'
            if p['className'] == 'Hunter':
                confidence += ' · primary pet: ' + ('Raptor' if p['player']['hunter']['options']['classOptions'].get('petType') == 'Raptor' else 'Lone Wolf / petless')
            if p['confidenceNotes']: confidence += ' · † model / coverage caveat'
            stem = p['faction'] + '--' + p['id']
            rows.append(f'<tr data-faction="{p["faction"]}" data-pool="{pool}" data-basis="{basis}" data-support="{support}" data-search="{e(profile_title(p).lower())}"><th title="{e("; ".join(p["confidenceNotes"]))}"><a href="builds/{stem}.html" style="color:{CLASS_COLORS[p["className"]]}">{e(profile_title(p))}</a><small>{e(confidence)}</small></th>{"".join(cells)}</tr>')
        fixed = detail_chart(charts, p, groups)
        anchor = next(g for g in groups if g['mode'] == 'fixed-set' and g['profileId'] == p['id'] and g['faction'] == p['faction'] and g['setId'] == p.get('referenceSetId', 'developer') and g['duration'] == 180 and g['support'] == 'full' and g['referencePolicy'] == 'developer')['rows'][0]
        native_player = read(run / 'results' / (anchor['key'] + '.json'))['raidMetrics']['parties'][0]['players'][0]
        guardians = native_player.get('pets', [])
        pet_dps = sum(pet['dps']['avg'] for pet in guardians)
        pet_note = ('Pets / guardians: ' + ', '.join(pet['name'] for pet in guardians) + f' · {pet_dps:.1f} DPS ({100 * pet_dps / anchor["meanDps"]:.1f}% of total).' if guardians else 'No pet or guardian appears in the reference combat metrics.')
        pet_note += ' Reference: ' + RACE_NAMES[anchor['race']] + ', ' + next(g['tier'] for g in p['sets'] if g['id'] == anchor['setId']) + ', 180 seconds and full support. Pet choices remain those of the developer build.'
        gear_map = {s['id']: s for s in p['sets']}
        gear_html = []
        for gear in p['sets']:
            if gear.get('diagnosticOnly'):
                gear_html.append('<details><summary>Excluded developer reference: unique-equipped item conflict</summary><p>' + e(json.dumps(gear['categoryConflicts'])) + '</p><p>The original remains a diagnostic. It does not enter the recommendations or the actual-equipment chart.</p></details>')
        mechanics_profile = next(r for r in mechanics['profiles'] if r['profileId'] == p['id'] and r['faction'] == p['faction'])
        for number, group in enumerate(fixed, 1):
            gear = gear_map[group['setId']]
            item_rows = ''.join(f'<tr><td>{SLOTS[item["slot"]]}</td><td>{e(item["name"])}</td><td>{item["id"]}</td><td>{e(item.get("enchantName", ""))}</td></tr>' for item in gear['audit'])
            details = f'<p>{e(gear["origin"])} · {e(gear["tier"])}</p><p><a href="{e(gear.get("sourceUrl", ""))}">Equipment source</a></p>'
            if gear.get('nativeHunterOptions'): details += '<p>Source ammunition and quiver settings: ' + e(json.dumps(gear['nativeHunterOptions'])) + '</p>'
            if gear.get('hunterRepresentation'): details += '<p>' + e(gear['hunterRepresentation']) + ' <a href="../hunter-ranged-controls/analysis.json">Paired controls</a>.</p>'
            if gear.get('construction'): details += '<p>' + e(gear['construction']['rule']) + '</p>'
            if gear.get('substitutions'): details += '<p>Recorded source replacements: ' + e(json.dumps(gear['substitutions'])) + '</p>'
            gear_mechanics = next(r for r in mechanics_profile['sets'] if r['setId'] == gear['id'])
            if gear_mechanics['missingItems']: details += '<p class="caveat">Unimplemented item effects: ' + e(json.dumps(gear_mechanics['missingItems'])) + '</p>'
            if gear_mechanics['missingEnchants'] or gear_mechanics['missingSets']: details += '<p class="caveat">Unimplemented enchant or active set effects: ' + e(json.dumps(gear_mechanics['missingEnchants'] + gear_mechanics['missingSets'])) + '</p>'
            if gear_mechanics['unvalidatedRates']: details += '<p class="caveat">Unmeasured proc rates: ' + e(json.dumps(gear_mechanics['unvalidatedRates'])) + '</p>'
            race_rows = []
            for row in sorted(group['rows'], key=lambda r: -r['meanDps']):
                comparison = next(c for c in group['comparisons'] if c['race'] == row['race'])
                website = f' · <a href="../exports/{row["key"]}.website.json">Website JSON</a>' if (run / 'exports' / (row['key'] + '.website.json')).exists() else ''
                race_rows.append(f'<tr><td>{RACE_NAMES[row["race"]]}</td><td>{row["meanDps"]:.2f}</td><td>{comparison["percent"]:+.3f}% ± {comparison["halfWidthPercent"]:.3f}</td><td>{row["stats"]["MeleeHitPercent"]:.1f}% / {row["stats"]["SpellHitPercent"]:.1f}%</td><td><a href="../requests/{row["key"]}.json">Native input</a>{website}</td></tr>')
            details += '<p>180 seconds, full support and original developer references. Hit below is generic sheet melee / spell hit; school and talent bonuses can be attached directly to spells.</p><table><thead><tr><th>Race</th><th>DPS</th><th>Gap and interval</th><th>Generic hit</th><th>Replay</th></tr></thead><tbody>' + ''.join(race_rows) + '</tbody></table>'
            gear_html.append(f'<details><summary>Set {number}: {e(gear["id"])}</summary>{details}<table><thead><tr><th>Slot</th><th>Item</th><th>ID</th><th>Enchant</th></tr></thead><tbody>{item_rows}</tbody></table></details>')
        pool_rows = []
        for g in [g for g in groups if g['mode'].startswith('pool:') and g['profileId'] == p['id'] and g['faction'] == p['faction']]:
            for row in sorted(g['rows'], key=lambda r: -r['meanDps']):
                c = next(c for c in g['comparisons'] if c['race'] == row['race'])
                website = f' · <a href="../exports/{row["key"]}.website.json">Website JSON</a>' if (run / 'exports' / (row['key'] + '.website.json')).exists() else ''
                iterations = row.get('iterations', provenance['settings']['precisionIterations'] if row['key'].startswith('precision--') else provenance['settings']['confirmationIterations'])
                policy = ' / '.join([row['timing'], row['mana'], row.get('classRacial', 'developer')])
                pool_rows.append(f'<tr><td>{e(g["mode"].split(":")[1])}</td><td>{g["duration"]}</td><td>{e(g["support"])}</td><td>{e(g["referencePolicy"])}</td><td>{RACE_NAMES[row["race"]]}</td><td>{row["meanDps"]:.2f}</td><td>{c["percent"]:+.3f}% ± {c["halfWidthPercent"]:.3f}<small>{iterations:,} iterations</small></td><td>{e(policy)}<small>Mana waits {row["secondsOomAvg"]:.1f}s</small></td><td>{e(row["setId"])}</td><td>{row["stats"]["MeleeHitPercent"]:.1f}% / {row["stats"]["SpellHitPercent"]:.1f}%</td><td><a href="../requests/{row["key"]}.json">Input</a> · <a href="../results/{row["key"]}.json">Result</a> · <a href="../stats/{row["key"]}.json">Stats</a>{website}</td></tr>')
        body = f'<p><a href="../report.html">All builds</a></p><h1>{e(profile_title(p))}</h1><p>{e(p["faction"].title())} · {e(" / ".join(RACE_NAMES[r] for r in p["races"]))}</p><img src="../charts/{stem}.png" alt="Equipment sensitivity and separate hit controls"><p>{e(pet_note)}</p>{pet_detail(p, pets)}<h2>Equipment catalogue</h2>{"".join(gear_html)}<h2>Independent confirmations after equipment selection</h2><p>The same declared pool is available to every race. Each race keeps its best validation-sample set with its screening-selected racial policy. Separate samples confirm that choice, with fresh precision samples near the practical-loss boundary. Gaps use the highest sampled mean under that same duration, support and reference treatment as their reference. A zero reference gap does not certify a race; the main matrix also allows uncertainty in the leader.</p><div class="scroll"><table><thead><tr><th>Pool</th><th>Seconds</th><th>Support</th><th>References</th><th>Race</th><th>DPS</th><th>Gap and interval</th><th>Racial policies / mana</th><th>Selected set</th><th>Generic hit: melee / spell</th><th>Replay</th></tr></thead><tbody>{"".join(pool_rows)}</tbody></table></div><h2>Creature-type controls</h2><p>180 seconds, full support and the developer equipment anchor. These checks test creature sensitivity without a full gear search.</p><div class="scroll"><table><thead><tr><th>Target</th><th>References</th><th>Race</th><th>DPS</th><th>Gap and interval</th><th>Replay</th></tr></thead><tbody>{"".join(creature_detail)}</tbody></table></div><h2>Confidence notes</h2><p>{e("; ".join(p["confidenceNotes"]) or "No additional preset-specific flag; shared model limits still apply.")}</p><h2>Developer context</h2><p>{e("; ".join(p.get("knownIssues", [])))}</p><p>These known-issue notes are source context. Runtime checks establish current cast coverage, including Mutilate. They do not prove every mechanic matches the game.</p>'
        (pages / (stem + '.html')).write_text(page(profile_title(p), body), encoding='utf-8')
    summary = {'sourceCommit': provenance['sourceCommit'], 'engineSha256': provenance['engineSha256'], 'scope': analysis['scope'], 'recommendations': summaries, 'targetSensitivity': target_summaries}
    (run / 'recommendations.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    with (run / 'recommendations.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.writer(stream); writer.writerow(['faction', 'profile', 'pool', 'basis', 'support_scope', 'duration', 'race', 'worst_mean_loss_pct', 'worst_upper_loss_pct', 'within_0_2_pct_all_conditions', 'conditions'])
        for r in summaries:
            for loss in r['losses']: writer.writerow([r['faction'], r['profileId'], r['pool'], r['basis'], r['supportScope'], r['duration'], RACE_NAMES[loss['race']], loss['worstMeanLoss'], loss['worstUpperLoss'], loss['race'] in r['safe'], r['conditions']])
    gear_changed = len(set((r['faction'], r['profileId']) for r in gear_reversals))
    hit_changed = len(set((r['faction'], r['profileId']) for r in hit_reversals))
    reversal_examples = ''.join(f'<li>{e(r["faction"].title())} · {e(r["profileId"])}: {e(RACE_NAMES[r["first"]["race"]])} leads in <code>{e(r["first"]["condition"])}</code>; {e(RACE_NAMES[r["second"]["race"]])} leads in <code>{e(r["second"]["condition"])}</code>.</li>' for r in list({(r['faction'], r['profileId']): r for r in gear_reversals}.values())[:8])
    body = f'''<div class="eyebrow">WoWSims Forever / Race robustness study</div><h1>Race recommendations across equipment and conditions</h1>
<p class="intro">{coverage['uniqueBuilds']} named DPS builds, both factions and every legal race. The default view spans every accepted actual equipment set. The selected-gear view separately confirms each race after choosing equipment from the same available pool. A race receives the consistent label only when its largest upper loss bound stays within 0.2% across the selected view's gear, support and rotation-reference treatments.</p>
<div class="cards"><div><b>{coverage['validEquipmentSets']:,}</b><small>valid faction/build equipment sets</small></div><div><b>{coverage['raceBuilds']:,}</b><small>legal race/build combinations</small></div><div><b>{coverage['cells']:,}</b><small>saved simulation cells</small></div><div><b>{provenance['settings']['confirmationIterations']:,}–{provenance['settings']['precisionIterations']:,}</b><small>iterations per final confirmation</small></div></div>
<div class="notice"><b>Read the loss bound, not just the race name.</b> “Setup dependent” shows the race with the smallest worst-case upper loss bound in this finite catalogue; it has no universal lead. Scenario counts measure coverage and are not probabilities that a race is best. Statistical intervals cover simulator sampling; game rules and incomplete effects need separate evidence.</div>
<p><b>Hunter pet choice can change the practical recommendation.</b> The primary table retains each named developer build's pet choice. The separate <a href="#pet-choices">Lone Wolf / Raptor comparison</a> tests that assumption on selected pre-raid equipment; some pet configurations change both DPS and race ordering.</p>
<p>The equipment audit keeps {len(coverage['diagnosticOnlySets'])} faction/build reference sets as diagnostics because their items conflict under the native UI's unique-equipped category rule. Recommendations use valid equipment, with new independent confirmations where a selection changed. <a href="gear-legality.json">Equipment audit</a>.</p>
<p>At 180 seconds with full support and original developer references, <b>{gear_changed}</b> faction/build entries show a clear reversal between actual equipment sets, and <b>{hit_changed}</b> show one in the separate synthetic hit controls. Both directions must retain more than a 0.2% lead after their interval margins. These are conservative examples; close changes remain unresolved. <a href="findings.json">Exact conditions and margins</a>.</p><details><summary>Examples of equipment-sensitive choices</summary><ul>{reversal_examples or '<li>No reversal meets this strict rule at the available precision.</li>'}</ul></details>
<p><label>Faction <select id="faction"><option value="horde">Horde</option><option value="alliance">Alliance</option></select></label> <label>Equipment pool <select id="pool"><option value="published-pre-raid">Published pre-raid</option><option value="developer-reference">Developer reference</option></select></label> <label>Comparison <select id="basis"><option value="across-gear">Across all actual gear</option><option value="selected-gear">Selected gear per race</option></select></label> <label>Support <select id="support"><option value="both">Full + self</option><option value="full">Full support</option><option value="self">Self only</option></select></label> <label>Find a spec <input id="search" placeholder="Mage, Rogue, Shadow…"></label></p>
<p>Across-gear cells use every accepted set at {provenance["settings"]["validationIterations"]:,} independent iterations per case. Selected-gear cells use {provenance["settings"]["confirmationIterations"]:,} iterations, with fresh {provenance["settings"]["precisionIterations"]:,}-iteration samples near the practical-loss boundary. The support selector separates full support, self-only external support and their combined stress test. Each cell includes both the original developer rotation and explicit handling of unavailable aura/spell references. In the selected-gear view, selection is separate for every race, duration and condition using the same pool. This view describes a race with its selected equipment; it does not establish robustness across the other sets. Developer and pre-raid pools stay separate.</p>
<div class="scroll"><table><thead><tr><th>Spec / build</th><th>60 seconds</th><th>180 seconds</th><th>300 seconds</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<details><summary>Printable overview charts</summary><p>These charts span every accepted published pre-raid set and both support/reference treatments. † marks model or equipment-coverage caveats listed on each build page.</p><img src="charts/horde-overview.png" alt="Horde race robustness"><img src="charts/alliance-overview.png" alt="Alliance race robustness"></details>
<h2 id="pet-choices">Hunter pet choice is a separate trade-off</h2><p>The MM/SV petless presets intentionally use Lone Wolf. This sensitivity check changes only petType to Raptor, retaining talents and racial policy, with the developer's configured 100% pet uptime. It uses independently sampled, per-race validation-selected published gear at 180 seconds, full support and original developer references. Highest means below are conditional on that pet choice. The DPS change range compares Raptor with petless within each race, at the same selected gear; full paired intervals and all three durations are on each build page. These 1,000-iteration checks do not replace the primary fixed-pet equipment comparisons or optimize pet families and talents.</p><div class="scroll"><table><thead><tr><th>Spec / build</th><th>Petless highest mean</th><th>Raptor highest mean</th><th>Raptor DPS change across races</th></tr></thead><tbody>{''.join(pet_rows)}</tbody></table></div>
<h2>External comparisons remain a model check</h2><p><a href="https://finsembleforever.com/lab">Finsemble's Lab</a> reports how often races lead across its own scenario model. That quantity differs from the DPS gaps and conditional loss bounds here. Testing more gear can explain a preset-dependent reversal, but it cannot establish that either damage model predicts the game correctly. Where recommendations still differ, including the Shadow hit/crit question, that disagreement remains open pending matched inputs and evidence for the mechanics.</p>
<h2>Creature type can change the choice</h2><p>The main matrix uses a neutral Mechanical target. Beast and Elemental targets can favor different racials. The table below uses the developer equipment anchor at 180 seconds with full support and both reference treatments; it is a separate sensitivity check, without the full gear search.</p><div class="scroll"><table><thead><tr><th>Spec / build</th><th>Beast</th><th>Elemental</th></tr></thead><tbody>{"".join(creature_rows)}</tbody></table></div><h2>What changed in the approach</h2><ul><li>Developer equipment remains a reference. Public pre-raid sets and source-listed alternatives add actual gear trade-offs. Single-slot hit alternatives retain at least 80% of the source slot score and are labeled experimental combinations.</li><li>All races can select from the same faction-specific catalogue, including its Dwarf-aware sets. A hit racial can therefore change the preferred equipment.</li><li>The study compares developer timing, immediate racial use and, for Warriors, a 15-second delay. Night Elf and Dwarf Priests test their damage racial before the filler when native expected damage per execution time is higher. Skyborne mana users also test plain Read Leyline below 65% mana. Attuned and Charged are removed on raid entry, following <a href="{e(provenance['raidRule']['source'])}">the official clarification</a>.</li><li>Unavailable-reference handling is a separate sensitivity treatment, with native metadata checks and saved before/after controls. It is not presented as proof of correct game behavior.</li><li>Both developer Mutilate builds enter after runtime cast and damage checks. The old warning text was insufficient grounds to exclude them.</li><li>Synthetic hit changes and Beast/Elemental checks are diagnostics. They do not enter the realistic pre-raid equipment pool.</li></ul>
<h2>Scope and limits</h2><p>One stationary level-63 target, 3,731 armor, 60/180/300 seconds, shared consumables and developer talent builds. The full support case is an abstract buff package; the self case removes external buffs and debuffs. Developer swap sets and pet settings remain shared. Published Hunter sets use their supported source ammunition and quiver options; developer ranged inputs remain separately labeled controls. The melee Hunter uses a source-listed ammunition alternative and a 13% crafted-container scenario through the native effect controls. The source bag data omits haste; the <a href="https://www.wowhead.com/forever/item=8218/thick-leather-ammo-pouch">Forever item tooltip</a> independently confirms 13%. The native effect translation and ranged-input diagnostics are retained. This measures damage; it does not optimize a raid roster or value racial survival and utility.</p><p>Some public item IDs are absent from the native database. Their recorded replacements come from the source's ranked alternatives. No external item-stat line, EP estimate or synthetic Gunba item is injected into WoWSims. Novel procs, the provisional Revelation rate and other engine assumptions remain model uncertainties. Missing source coverage cannot be cured by more iterations.</p>
<h2>Inspect and reproduce</h2><p><a href="recommendations.csv">Recommendation CSV</a> · <a href="recommendations.json">Recommendation JSON</a> · <a href="analysis.json">Every condition</a> · <a href="verification.json">Independent verification</a> · <a href="methodology.json">Final method and tool hashes</a> · <a href="mechanics-coverage.json">Item-effect coverage</a> · <a href="profiles.json">Equipment and source catalogue</a> · <a href="coverage.json">Coverage and rejections</a> · <a href="driver-verification.json">Native driver checks</a> · <a href="rotation-resolution-effects.json">Rotation sensitivity controls</a> · <a href="provenance.json">Full provenance</a></p>
<footer>Simulator source <code>{e(provenance['sourceCommit'])}</code><br>Analytics checkout at run start <code>{e(provenance['analyticsCommit'])}</code>{" with working changes" if provenance.get("status") else ""}. Execution revisions and exact tool hashes are retained in the archive.<br>Batch engine SHA-256 <code>{e(provenance['engineSha256'])}</code><br>Model {e(provenance['model']['name'])}; build {e(next(iter(provenance['gameBuilds'].values())))}. Screening seed {provenance['settings']['screenSeed']}; validation seed {provenance['settings']['validationSeed']}; confirmation seed {provenance['settings']['confirmationSeed']}; precision seed {provenance['settings']['precisionSeed']}.<br>Primary equipment source: <a href="https://wowforeverbislist.com/">WoW Forever BiS List</a>, with originals preserved separately in the local source library. Source calculations are inputs, not independent validation of WoWSims. The pre-raid label follows the publisher's content filters; launch availability and acquisition cost are not independently established for every item.</footer>
<script>const faction=document.getElementById('faction'),pool=document.getElementById('pool'),basis=document.getElementById('basis'),support=document.getElementById('support'),search=document.getElementById('search');function filter(){{for(const row of document.querySelectorAll('tbody tr[data-faction]'))row.hidden=row.dataset.faction!==faction.value||(!row.dataset.aux&&(row.dataset.pool!==pool.value||row.dataset.basis!==basis.value||row.dataset.support!==support.value))||!row.dataset.search.includes(search.value.toLowerCase());}}for(const control of [faction,pool,basis,support,search])control.addEventListener('input',filter);filter();</script>'''
    (run / 'report.html').write_text(page('Race robustness', body), encoding='utf-8')
    artifacts = [run / 'report.html', run / 'recommendations.json', run / 'recommendations.csv', run / 'findings.json', *charts.iterdir(), *pages.iterdir()]
    (run / 'report-provenance.json').write_text(json.dumps({'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'artifacts': {str(p.relative_to(run)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts}}, indent=2), encoding='utf-8')
    print(run / 'report.html')


def page(title, body):
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(title)}</title><style>:root{{color-scheme:dark;font-family:Inter,Segoe UI,Arial,sans-serif;background:{BG};color:{INK}}}body{{max-width:1320px;margin:0 auto;padding:44px 28px 70px}}h1{{font-size:36px;letter-spacing:-.7px}}h2{{font-size:23px;margin-top:34px}}p,li{{line-height:1.7}}a{{color:#8acbff}}.intro{{font-size:19px;max-width:1100px}}.eyebrow{{color:{MUTED};letter-spacing:1.5px;font-size:12px;text-transform:uppercase}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:25px 0}}.cards div{{background:{PANEL};padding:20px;border:1px solid #31415b;border-radius:10px}}.cards b{{display:block;font-size:28px}}small{{display:block;color:{MUTED};font-size:12px;line-height:1.5;margin-top:5px}}.notice{{background:#1e293d;border-left:3px solid #d8b77e;padding:20px 24px;line-height:1.7}}table{{width:100%;border-collapse:collapse}}th,td{{padding:13px 12px;border-bottom:1px solid #2b3a50;text-align:left;vertical-align:top}}th{{font-size:14px}}td{{font-size:15px}}tbody tr:hover{{background:#141f31}}select,input{{padding:9px 12px;background:#172338;color:{INK};border:1px solid #475970;border-radius:6px;margin:8px 12px 8px 4px}}.scroll{{overflow-x:auto}}img{{width:100%;height:auto;margin:20px 0;border-radius:8px}}details{{background:#121e2f;padding:15px 20px;border:1px solid #2a3b52;border-radius:8px;margin:12px 0}}summary{{cursor:pointer}}code{{overflow-wrap:anywhere;font-size:12px}}footer{{border-top:1px solid #35435a;margin-top:35px;padding-top:22px;color:{MUTED};font-size:12px;line-height:1.8}}[hidden]{{display:none!important}}@media(max-width:800px){{body{{padding:22px 15px}}.cards{{grid-template-columns:repeat(2,1fr)}}table{{min-width:750px}}h1{{font-size:28px}}}}</style>{body}</html>'''


if __name__ == '__main__':
    render(Path(sys.argv[1]).resolve())
