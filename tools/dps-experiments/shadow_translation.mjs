import fs from 'node:fs';
import assert from 'node:assert/strict';

function fields(source, message) {
	const body = source.split(`message ${message} {`)[1]?.split('\n}')[0];
	if (!body) throw new Error(`Missing ${message} schema`);
	return [...body.matchAll(/^\s*(?:int32|bool)\s+(\w+)\s*=/gm)].map(x => x[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
}

export function translateTalents(allocation, gunbaProto) {
	const order = fields(gunbaProto, 'PriestTalents');
	assert.equal(order.length, 52, 'Review Gunba priest talent tree shape.');
	const values = Object.fromEntries(allocation.map(x => [x.field, x.points]));
	for (const name of Object.keys(values)) assert(order.includes(name), `Unsupported named talent: ${name}`);
	const points = order.map(name => values[name] ?? 0);
	assert.equal(
		points.reduce((a, b) => a + b, 0),
		51,
		'The matched build must spend all talent points.',
	);
	return [points.slice(0, 18), points.slice(18, 35), points.slice(35)].map(tree => tree.join('').replace(/0+$/, '')).join('-');
}

export function expandRotation(rotation) {
	const variables = new Map((rotation.valueVariables ?? []).map(x => [x.name, x.value]));
	const expand = (value, trail = []) => {
		if (!value || typeof value !== 'object') return value;
		if (value.variableRef) {
			const name = value.variableRef.name;
			assert(variables.has(name) && !trail.includes(name), `Unresolved/cyclic rotation variable: ${name}`);
			return expand(variables.get(name), [...trail, name]);
		}
		return Array.isArray(value) ? value.map(x => expand(x, trail)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, trail)]));
	};
	const result = expand(rotation);
	delete result.valueVariables;
	assert(!(result.groups ?? []).some(g => g.actions?.some(x => Object.keys(x.action ?? {}).length)), 'Review nonempty APL groups.');
	delete result.groups;
	result.priorityList = result.priorityList.filter(x => !x.hide);
	return result;
}

export function statIndexes(proto, name = 'Stat') {
	const body = proto.split('enum ' + name + ' {')[1].split('\n}')[0];
	return Object.fromEntries([...body.matchAll(new RegExp(name + '(\\w+)\\s*=\\s*(\\d+)', 'g'))].map(x => [x[1], Number(x[2])]));
}

export function translateStats(values, indexes) {
	const out = Array(Math.max(...Object.values(indexes)) + 1).fill(0);
	const aliases = {
		SpellPiercing: 'SpellPenetration',
		ShadowDamage: 'ShadowPower',
		ArcaneDamage: 'ArcanePower',
		FireDamage: 'FirePower',
		FrostDamage: 'FrostPower',
		HolyDamage: 'HolyPower',
		NatureDamage: 'NaturePower',
	};
	const add = (name, value) => {
		assert(name in indexes, `Unsupported equipped stat: ${name}`);
		out[indexes[name]] += value;
	};
	for (const [name, value] of Object.entries(values)) {
		if (!value) continue;
		if (name === 'HitRating') add('MeleeHit', value / 10);
		else if (name === 'CritRating') add('MeleeCrit', value / 14);
		else if (name === 'SpellHitPercent') add('SpellHit', value);
		else if (name === 'PhysicalHitPercent') add('MeleeHit', value);
		else if (name === 'SpellCritPercent') add('SpellCrit', value);
		else if (name === 'PhysicalCritPercent') add('MeleeCrit', value);
		else add(aliases[name] ?? name, value);
	}
	return out;
}

export function translateEquipment(resolved, indexes) {
	const items = resolved.map(x => ({
		id: x.spec.id,
		name: x.name,
		type: x.type,
		armorType: x.armorType,
		weaponType: x.weaponType,
		handType: x.handType,
		rangedWeaponType: x.rangedWeaponType,
		weaponDamageMin: x.weaponDamageMin,
		weaponDamageMax: x.weaponDamageMax,
		weaponSpeed: x.weaponSpeed,
		stats: translateStats(x.baseStats, indexes),
	}));
	const enchants = new Map();
	for (const item of resolved)
		if (item.spec.enchant) {
			const entry = { effectId: item.spec.enchant, stats: translateStats(item.enchantStats, indexes) };
			if (enchants.has(entry.effectId)) assert.deepEqual(entry, enchants.get(entry.effectId), 'Slot-dependent enchant needs an explicit mapping.');
			enchants.set(entry.effectId, entry);
		}
	return { items, enchants: [...enchants.values()] };
}

export function translateRequest(q, { allocation, resolved, source, revelationChance }) {
	const common = fs.readFileSync(source + '/proto/common.proto', 'utf8');
	const indexes = statIndexes(common);
	const original = q.raid.parties[0].players[0];
	const elixirs = [...original.consumables.elixirIds].sort((a, b) => a - b);
	assert.deepEqual(elixirs, [9264, 13454, 250328, 250337, 250338, 250341], 'Review changed developer consumes.');
	assert.equal(original.consumables.flaskId, 13512);
	assert.equal(original.consumables.foodId, 13931);
	assert.equal(original.consumables.mhImbueId, 20749);
	const database = translateEquipment(resolved, indexes);
	const player = {
		name: original.name,
		race: original.race,
		class: original.class,
		level: 60,
		equipment: { items: original.equipment.items.map(item => ({ id: item.id, ...(item.enchant ? { enchant: item.enchant } : {}) })) },
		database,
		talentsString: translateTalents(allocation, fs.readFileSync(source + '/proto/priest.proto', 'utf8')),
		profession1: original.profession1,
		profession2: original.profession2,
		reactionTimeMs: original.reactionTimeMs,
		channelClipDelayMs: original.channelClipDelayMs,
		distanceFromTarget: original.distanceFromTarget,
		rotation: expandRotation(original.rotation),
		shadowPriest: { options: { armor: 'InnerFire' } },
		consumes: {
			flask: 'FlaskOfSupremePower',
			food: 'FoodNightfinSoup',
			agilityElixir: 'ElixirOfCunning',
			intellectElixir: 'ElixirOfTheOwl',
			manaRegenElixir: 'MagebloodPotion',
			spellPowerBuff: 'GreaterArcaneElixir',
			shadowPowerBuff: 'ElixirOfShadowPower',
			mainHandImbue: 'BrilliantWizardOil',
			defaultPotion: 'MajorSpellblastingPotion',
			defaultConjured: 'ConjuredDemonicRune',
		},
		bonusStats: { stats: translateStats({ Spirit: 25, MP5: 8 }, indexes) },
		buffs: { blessingOfKings: true, blessingOfMight: 'TristateEffectRegular', blessingOfWisdom: 'TristateEffectRegular' },
		foreverTier1Bonuses: false,
		foreverMp5PerSecond: false,
		foreverRevelationModel: { enabled: true, baseChance: revelationChance, critExponent: 0 },
	};
	player.rotation.prepullActions.unshift({ action: { castSpell: { spellId: { spellId: 15473 } } }, doAtValue: { const: { val: '-60s' } } });
	const target = structuredClone(q.encounter.targets[0]);
	target.stats = Array(outStatCount(indexes)).fill(0);
	target.stats[indexes.Armor] = 3731;
	delete target.name;
	return {
		raid: {
			parties: [{ players: [player], buffs: { windfuryTotem: true } }],
			buffs: {
				arcaneBrilliance: true,
				divineSpirit: true,
				powerWordFortitude: 'TristateEffectRegular',
				giftOfTheWild: 'TristateEffectRegular',
				strengthOfEarthTotem: 'TristateEffectRegular',
				graceOfAirTotem: 'TristateEffectRegular',
				battleShout: 25289,
				trueshotAura: true,
				leaderOfThePack: true,
				moonkinAura: true,
				manaSpringTotem: 'TristateEffectImproved',
			},
			debuffs: {
				judgementOfWisdom: true,
				judgementOfTheCrusader: 'TristateEffectRegular',
				curseOfElements: true,
				curseOfRecklessness: true,
				faerieFire: true,
				exposeArmor: 'TristateEffectRegular',
				sunderArmor: true,
				huntersMark: 'TristateEffectRegular',
				giftOfArthas: true,
			},
		},
		encounter: { ...q.encounter, targets: [target] },
		simOptions: { ...q.simOptions, ruleset: 'RulesetForever' },
	};
}

const outStatCount = indexes => Math.max(...Object.values(indexes)) + 1;
