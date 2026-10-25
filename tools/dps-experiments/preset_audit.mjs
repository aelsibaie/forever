import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function changedPaths(before, after, prefix = '') {
	if (Object.is(before, after)) return [];
	if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [prefix];
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
		changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key),
	);
}

export function classifyProfile(profile) {
	const { specPath, name, gearName, gearTooltip = '', talentPoints = [] } = profile;
	const family = {
		'druid/balance': 'Balance Druid',
		'druid/feralcat': 'Feral Cat',
		'shaman/elemental': 'Elemental Shaman',
		'shaman/enhancement': 'Enhancement Shaman',
		'paladin/retribution': /holy shock/i.test(name) ? 'Holy Shock DPS Paladin' : 'Retribution Paladin',
		'priest/dps': /smite/i.test(name) ? 'Smite Priest' : 'Shadow Priest',
	};
	const tree = talentPoints.indexOf(Math.max(...talentPoints));
	const trees = {
		'hunter/dps': ['Beast Mastery Hunter', 'Marksmanship Hunter', 'Survival Hunter'],
		'mage/dps': ['Arcane Mage', 'Fire Mage', 'Frost Mage'],
		'rogue/dps': ['Assassination Rogue', 'Combat Rogue', 'Subtlety Rogue'],
		'warlock/dps': ['Affliction Warlock', 'Demonology Warlock', 'Destruction Warlock'],
		'warrior/dps': ['Arms Warrior', 'Fury Warrior', 'Protection DPS Warrior'],
	};
	const specLabel = /ffb/i.test(name) && specPath === 'mage/dps' ? 'Fire / Frost Mage' : (family[specPath] ?? trees[specPath]?.[tree]);
	if (!specLabel) throw new Error(`No spec family for ${profile.id}`);
	let gearTier = 'Developer testing';
	if (/pre.?raid|pre.?bis/i.test(gearName)) gearTier = 'Developer pre-raid';
	else if (/placeholder/i.test(gearTooltip)) gearTier = 'Pre-raid placeholder';
	else {
		const phase = [gearName, ...(profile.gearSources ?? []).map(source => path.basename(source.path))].join(' ').match(/\bp(\d+)/i);
		if (phase) gearTier = `Developer P${phase[1]}`;
	}
	return { specLabel, gearTier, documentedPreRaid: gearTier === 'Developer pre-raid' };
}

const identity = equipment => JSON.stringify(equipment?.items?.map(item => [item.id ?? 0, item.enchant ?? 0, item.randomSuffix ?? 0]));

export function auditProfiles(profiles, root, config) {
	const sources = new Map();
	for (const profile of profiles) {
		if (!sources.has(profile.specPath)) {
			const files = [];
			for (const folder of ['gear_sets', 'builds']) {
				const dir = path.join(root, 'ui/specs', profile.specPath, folder);
				if (!fs.existsSync(dir)) continue;
				for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
					const filename = path.join(dir, file);
					const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
					files.push({
						path: path.relative(root, filename).replaceAll('\\', '/'),
						identity: identity(data.player?.equipment ?? data),
						sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
					});
				}
			}
			sources.set(profile.specPath, files);
		}
		profile.gearSources = sources
			.get(profile.specPath)
			.filter(file => file.identity === identity(profile.player.equipment))
			.map(({ identity: _, ...file }) => file);
		Object.assign(profile, classifyProfile(profile));
		if (config.gearPolicy) Object.assign(profile, { gearTier: 'Custom gear experiment', documentedPreRaid: false });
		profile.gearSelection = config.frozenRun
			? 'Saved reference equipment'
			: profile.fallbackGearSource
				? 'Repository gear file supplied for an empty preset'
				: 'Developer preset equipment';
	}
	return {
		policy: 'Use developer equipment, enchants, swaps, professions and rotations. No item scoring or gear optimization. Pre-raid means the developer labels the set pre-raid or Pre-BiS; source caveats and unequal budgets remain.',
		profiles: profiles.map(({ id, specLabel, gearName, gearTier, gearSelection, gearSources, gearTooltip, documentedPreRaid, rankEligible, warnings }) => ({
			id,
			specLabel,
			gearName,
			gearTier,
			gearSelection,
			gearSources,
			gearTooltip,
			documentedPreRaid,
			rankEligible,
			warnings,
		})),
		futureRoles: [
			{ spec: 'Holy Paladin', status: 'Gear planner; no default healing rotation' },
			{ spec: 'Restoration Druid', status: 'Gear planner; no default healing rotation' },
			{ spec: 'Restoration Shaman', status: 'Gear planner; no default healing rotation' },
			{ spec: 'Discipline / Holy Priest', status: 'Healing spells and talents exist; no default healing rotation' },
			{ spec: 'Protection Warrior / Protection Paladin / Feral Bear', status: 'Tank role; outside this DPS experiment' },
		],
	};
}
