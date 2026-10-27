import fs from 'node:fs';
import assert from 'node:assert/strict';
import { statIndexes, translateEquipment } from './shadow_translation.mjs';

export function flattenRotation(rotation) {
	const groups = new Map((rotation.groups ?? []).map(g => [g.name, g]));
	const expand = (value, variables, trail = []) => {
		if (!value || typeof value !== 'object') return value;
		if (value.variableRef) {
			const name = value.variableRef.name;
			assert(variables.has(name) && !trail.includes(name), 'Unresolved rotation variable: ' + name);
			return expand(variables.get(name), variables, [...trail, name]);
		}
		return Array.isArray(value)
			? value.map(v => expand(v, variables, trail))
			: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, variables, trail)]));
	};
	const rootVariables = new Map((rotation.valueVariables ?? []).map(v => [v.name, v.value]));
	const lines = (entries, variables, parents = [], stack = []) =>
		entries
			.filter(x => !x.hide)
			.flatMap(line => {
				const action = expand(line.action, variables),
					conditions = [...parents, ...(action.condition ? [action.condition] : [])];
				if (action.groupReference) {
					const name = action.groupReference.groupName,
						group = groups.get(name);
					assert(group && !stack.includes(name), 'Missing/cyclic APL group: ' + name);
					const local = new Map([...variables, ...(group.valueVariables ?? []).map(v => [v.name, v.value])]);
					return lines(group.actions ?? [], local, conditions, [...stack, name]);
				}
				assert(!JSON.stringify(action).includes('groupReference'), 'Nested APL groups need a dedicated translation.');
				if (conditions.length) action.condition = conditions.length === 1 ? conditions[0] : { and: { vals: conditions } };
				return [{ ...line, action }];
			});
	const result = expand({ ...rotation, groups: undefined, valueVariables: undefined, priorityList: [] }, rootVariables);
	result.priorityList = lines(rotation.priorityList ?? [], rootVariables);
	delete result.groups;
	delete result.valueVariables;
	return result;
}

export function namedTalents(profile, source) {
	const name = profile.className.toLowerCase(),
		title = profile.className;
	const tree = JSON.parse(fs.readFileSync(source + '/ui/core/talents/trees/' + name + '.json', 'utf8'));
	let order;
	if (['mage', 'druid', 'warrior'].includes(name)) order = tree.map(t => t.talents.map(x => x.fieldName));
	else {
		const proto = fs.readFileSync(source + '/proto/' + name + '.proto', 'utf8');
		const body = proto.split('message ' + title + 'Talents {')[1].split('\n}')[0];
		const fields = [...body.matchAll(/^\s*(?:int32|bool)\s+(\w+)\s*=/gm)].map(x => x[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
		let offset = 0;
		order = tree.map(t => {
			const row = fields.slice(offset, offset + t.talents.length);
			offset += t.talents.length;
			return row;
		});
		assert.equal(order.flat().length, fields.length, 'Gunba talent tree shape differs.');
		assert.deepEqual(
			order.flat(),
			tree.flatMap(t => t.talents.map(x => x.fieldName)),
			'Gunba UI and native talent order differ.',
		);
	}
	const allocation = Object.fromEntries(profile.talentAllocation.map(x => [x.field, x.points]));
	for (const field of Object.keys(allocation)) assert(order.flat().includes(field), 'Gunba lacks allocated talent: ' + field);
	for (const t of tree)
		for (const node of t.talents) assert((allocation[node.fieldName] ?? 0) <= node.maxPoints, 'Gunba talent cap differs: ' + node.fieldName);
	return order
		.map(t =>
			t
				.map(f => allocation[f] ?? 0)
				.join('')
				.replace(/0+$/, ''),
		)
		.join('-');
}

export function isolationRequest(request) {
	const q = structuredClone(request),
		p = q.raid.parties[0].players[0];
	q.raid.buffs = {};
	q.raid.debuffs = {};
	q.raid.parties[0].buffs = {};
	p.buffs = {};
	p.consumables = {};
	return q;
}

export function translateIsolation(q, profile, resolved, source) {
	const original = q.raid.parties[0].players[0],
		indexes = statIndexes(fs.readFileSync(source + '/proto/common.proto', 'utf8'));
	const p = {
		name: original.name,
		race: original.race,
		class: original.class,
		level: original.level,
		equipment: { items: original.equipment.items.map(x => ({ id: x.id, ...(x.enchant ? { enchant: x.enchant } : {}) })) },
		database: translateEquipment(resolved, indexes),
		talentsString: namedTalents(profile, source),
		rotation: flattenRotation(original.rotation),
		profession1: original.profession1,
		profession2: original.profession2,
		reactionTimeMs: original.reactionTimeMs,
		channelClipDelayMs: original.channelClipDelayMs,
		distanceFromTarget: original.distanceFromTarget,
		foreverTier1Bonuses: false,
		foreverMp5PerSecond: false,
		foreverRevelationModel: { enabled: true, baseChance: 0.09, critExponent: 0 },
	};
	assert(!original.level || original.level === 60, 'Review a changed player level.');
	p.level = 60;
	const spec = profile.specPath,
		key = Object.keys(original).find(k => original[k]?.options?.classOptions);
	const opts = original[key]?.options ?? {},
		common = opts.classOptions ?? {};
	if (spec.startsWith('mage/')) p.mage = { options: { armor: common.defaultMageArmor === 'MageArmorMageArmor' ? 'MageArmor' : 'NoArmor' } };
	else if (spec.startsWith('priest/')) {
		p[profile.talentAllocation.some(t => t.field === 'shadowform' && t.points) ? 'shadowPriest' : 'smitePriest'] = {
			options: { armor: common.armor ?? 'NoArmor' },
		};
		if (common.preShadowform)
			p.rotation.prepullActions.unshift({ action: { castSpell: { spellId: { spellId: 15473 } } }, doAtValue: { const: { val: '-60s' } } });
	} else if (spec.startsWith('warlock/')) {
		assert(!common.soulShards || common.soulShards === 32, 'Review shard resource translation.');
		p.warlock = { options: { summon: common.summon, armor: common.armor, sacrifice: common.sacrificedDemon } };
	} else if (spec === 'druid/balance' || spec === 'druid/feralcat') p[spec.endsWith('balance') ? 'balanceDruid' : 'feralDruid'] = { options: common };
	else if (spec.startsWith('rogue/')) p.rogue = { options: {} };
	else if (spec.startsWith('shaman/')) p[spec.includes('enhancement') ? 'enhancementShaman' : 'elementalShaman'] = { options: {} };
	else if (spec.startsWith('paladin/')) p.retributionPaladin = { options: common };
	else throw new Error('Combat-option mapping requires review for ' + spec + ': ' + JSON.stringify(common));
	const target = structuredClone(q.encounter.targets[0]);
	delete target.name;
	target.stats = Array(Math.max(...Object.values(indexes)) + 1).fill(0);
	target.stats[indexes.Armor] = 3731;
	return {
		raid: { parties: [{ players: [p] }] },
		encounter: { ...q.encounter, targets: [target] },
		simOptions: { ...q.simOptions, ruleset: 'RulesetForever' },
	};
}
