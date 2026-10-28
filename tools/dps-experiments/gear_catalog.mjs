import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, signature } from './racial_helpers.mjs';
import { statIndexes } from './shadow_translation.mjs';

const slots = [
	'head',
	'neck',
	'shoulder',
	'back',
	'chest',
	'wrist',
	'hands',
	'waist',
	'legs',
	'feet',
	'finger1',
	'finger2',
	'trinket1',
	'trinket2',
	'mainhand',
	'offhand',
	'ranged',
];
const slotTypes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12, 12, 13, 13, 14];
const classes = { Warrior: 1, Paladin: 2, Hunter: 3, Rogue: 4, Priest: 5, Shaman: 7, Mage: 8, Warlock: 9, Druid: 11 };

export function equipmentCapabilities(root) {
	const source = fs.readFileSync(path.join(root, 'ui/sim/player/classes/capabilities_auto_gen.ts'), 'utf8');
	const common = fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8');
	const armor = statIndexes(common, 'ArmorType'),
		weapon = statIndexes(common, 'WeaponType'),
		ranged = statIndexes(common, 'RangedWeaponType');
	const result = {};
	for (const name of Object.keys(classes)) {
		const block = label =>
			source
				.split('export const ' + label + ':')[1]
				?.split('\n};')[0]
				.match(new RegExp('\\[Class.Class' + name + '\\]: \\[(.*)\\]'))?.[1];
		const a = block('CLASS_ARMOR_TYPES'),
			w = block('CLASS_WEAPON_TYPES');
		if (!a || !w) throw new Error(`Missing generated equipment capabilities for ${name}.`);
		result[name] = {
			armor: [...a.matchAll(/ArmorType\.ArmorType(\w+)/g)].map(m => armor[m[1]]),
			weapons: [...w.matchAll(/weaponType: WeaponType\.WeaponType(\w+), canUseTwoHand: (true|false)/g)].map(m => ({
				type: weapon[m[1]],
				twoHand: m[2] === 'true',
			})),
			ranged: [...(block('CLASS_RANGED_WEAPON_TYPES') ?? '').matchAll(/RangedWeaponType\.RangedWeaponType(\w+)/g)].map(m => ranged[m[1]]),
		};
	}
	return result;
}

function itemFits(item, slot, { className, faction, capabilities }) {
	if (!item || item.type !== slotTypes[slot]) return false;
	if (item.classAllowlist?.length && !item.classAllowlist.includes(classes[className])) return false;
	if (item.factionRestriction === (faction === 'alliance' ? 2 : 1)) return false;
	const allowed = capabilities?.[className];
	if (item.armorType && allowed && !allowed.armor.includes(item.armorType)) return false;
	if (item.type === 13 && allowed && !allowed.weapons.some(w => w.type === item.weaponType && (item.handType !== 4 || w.twoHand))) return false;
	if (item.type === 14 && allowed && !allowed.ranged.includes(item.rangedWeaponType)) return false;
	return true;
}

export function compatiblePublishedList(original, options) {
	const list = structuredClone(original),
		substitutions = [],
		items = new Map(options.database.items.map(i => [i.id, i]));
	const used = new Set();
	for (const record of list.slots) {
		if (['ammo', 'quiver', 'pouch'].includes(record.slot)) continue;
		const slot = slots.indexOf(record.slot === 'relic' ? 'ranged' : record.slot);
		if (slot < 0) throw new Error(`Unknown published slot ${record.slot}.`);
		const candidates = [record.item, ...(record.alternatives ?? [])];
		const chosen = candidates.findIndex(candidate => {
			const native = items.get(candidate.id);
			if (!itemFits(native, slot, options) || (native.unique && used.has(native.id))) return false;
			if (slot === 14 && native.handType === 4 && list.slots.some(s => s.slot === 'offhand')) return false;
			return !options.daggerPair || ![14, 15].includes(slot) || native.weaponType === 2;
		});
		if (chosen < 0) throw new Error(`No compatible published candidate for ${record.slot}; original item ${record.item.id}.`);
		if (chosen)
			substitutions.push({
				slot: record.slot,
				from: record.item.id,
				to: candidates[chosen].id,
				publishedAlternativeRank: chosen,
				publishedEpDelta: candidates[chosen].delta,
				reason: 'First published alternative compatible with the current WoWSims database, class, faction and occupied slots.',
			});
		record.item = candidates[chosen];
		used.add(record.item.id);
	}
	return { list, substitutions };
}

export function publishedHitAlternatives(list, options) {
	const variants = [];
	for (const direction of [-1, 1]) {
		const candidates = [];
		for (const [slotIndex, record] of list.slots.entries())
			for (const [rank, alternative] of (record.alternatives ?? []).entries()) {
				if (alternative.id === record.item.id) continue;
				const difference = (alternative.stats?.hit ?? 0) - (record.item.stats?.hit ?? 0);
				const baseEp = record.item.ep ?? record.ep;
				if (
					!Number.isFinite(difference) ||
					direction * difference <= 0 ||
					!(baseEp > 0) ||
					!Number.isFinite(alternative.ep) ||
					alternative.ep < baseEp * 0.8
				)
					continue;
				const changed = structuredClone(list);
				changed.slots[slotIndex].item = alternative;
				try {
					const equipment = equipmentFromList(changed);
					validateEquipment(equipment.equipment, options);
					candidates.push({
						list: changed,
						slot: record.slot,
						from: record.item.id,
						to: alternative.id,
						publishedAlternativeRank: rank + 1,
						reportedHitChange: difference,
						relativePublishedEpLoss: 1 - alternative.ep / baseEp,
					});
				} catch {
					continue;
				}
			}
		candidates.sort((a, b) => direction * (b.reportedHitChange - a.reportedHitChange) || a.relativePublishedEpLoss - b.relativePublishedEpLoss);
		if (candidates.length) variants.push({ ...candidates[0], label: direction < 0 ? 'lower-hit' : 'higher-hit' });
	}
	return variants;
}

export function equipmentFromList(list) {
	if (!Array.isArray(list.slots)) throw new Error('A published gear list needs slot records.');
	const bySlot = new Map(list.slots.map(slot => [slot.slot === 'relic' ? 'ranged' : slot.slot, slot]));
	if (bySlot.size !== list.slots.length) throw new Error('A published list repeats an equipment slot.');
	const requiredProfessions = new Set();
	const items = slots.map(slot => {
		const record = bySlot.get(slot);
		if (!record) return {};
		if (!Number.isSafeInteger(record.item?.id) || record.item.id <= 0) throw new Error(`Invalid item in ${slot}.`);
		if (record.item.req > 60) throw new Error(`${record.item.id} requires a level above 60.`);
		const profession = record.item.req_skill?.match(/Requires (Engineering|Enchanting|Tailoring|Blacksmithing|Leatherworking|Alchemy)/)?.[1];
		if (profession) requiredProfessions.add(profession);
		if (record.item.req_skill && !profession) throw new Error(`Unrecognized requirement on ${record.item.id}: ${record.item.req_skill}`);
		return { id: record.item.id, ...(record.enchant?.ws ? { enchant: record.enchant.ws } : {}) };
	});
	if (requiredProfessions.size > 2) throw new Error('The published set requires more than two professions.');
	return {
		equipment: { items },
		requiredProfessions: [...requiredProfessions],
		externalAmmoAndQuiver: externalLoadoutFromList(list),
		itemSources: list.slots.map(slot => ({
			slot: slot.slot,
			id: slot.item.id,
			name: slot.item.name,
			sources: slot.item.sources,
			requiredSkill: slot.item.req_skill,
			requiredReputation: slot.item.req_rep,
		})),
	};
}

export function externalLoadoutFromList(list) {
	return list.slots
		.filter(slot => ['ammo', 'quiver', 'pouch'].includes(slot.slot))
		.map(slot => ({
			slot: slot.slot,
			id: slot.item.id,
			name: slot.item.name,
			reportedStats: slot.item.stats,
			sources: slot.item.sources,
			alternatives: (slot.alternatives ?? []).map(item => ({ id: item.id, name: item.name, reportedStats: item.stats, sources: item.sources })),
		}));
}

export function validateEquipment(equipment, { database, className, faction, daggerPair = false, capabilities }) {
	const items = new Map(database.items.map(item => [item.id, item]));
	const enchants = database.enchants;
	if (equipment.items.length !== 17) throw new Error('Equipment needs all 17 slot positions, including empty slots.');
	const seen = new Set();
	const audit = [];
	for (const [slot, entry] of equipment.items.entries()) {
		if (!entry.id) continue;
		const item = items.get(entry.id);
		if (!item) throw new Error(`Item ${entry.id} is absent from WoWSims.`);
		if (item.type !== slotTypes[slot]) throw new Error(`Item ${entry.id} does not fit ${slots[slot]}.`);
		if (item.classAllowlist?.length && !item.classAllowlist.includes(classes[className])) throw new Error(`Item ${entry.id} excludes ${className}.`);
		if (item.factionRestriction === (faction === 'alliance' ? 2 : 1)) throw new Error(`Item ${entry.id} excludes ${faction}.`);
		if (!itemFits(item, slot, { className, faction, capabilities })) throw new Error(`Item ${entry.id} is not compatible with ${className}.`);
		if (item.unique && seen.has(entry.id)) throw new Error(`Unique item ${entry.id} is equipped twice.`);
		seen.add(entry.id);
		// One effect id can have separate picker records for several equipment slots.
		const enchant = entry.enchant ? enchants.find(e => e.effectId === entry.enchant && [e.type, ...(e.extraTypes ?? [])].includes(item.type)) : null;
		if (entry.enchant && !enchant) throw new Error(`Enchant ${entry.enchant} is absent from WoWSims.`);
		audit.push({ slot, ...entry, name: item.name, itemType: item.type, weaponType: item.weaponType, handType: item.handType, enchantName: enchant?.name });
	}
	const mh = items.get(equipment.items[14].id),
		oh = items.get(equipment.items[15].id);
	if (!mh) throw new Error('A DPS set needs a main-hand weapon.');
	if (mh.handType === 4 && oh) throw new Error('A two-handed weapon cannot accompany an off hand.');
	if (mh.handType === 3) throw new Error('An off-hand item cannot be a main hand.');
	if (oh && oh.handType === 1) throw new Error('A main-hand-only weapon cannot be an off hand.');
	if (oh && ![5, 7].includes(oh.weaponType) && !['Warrior', 'Rogue', 'Hunter'].includes(className))
		throw new Error(`${className} cannot dual wield this weapon pair.`);
	if (daggerPair && (mh.weaponType !== 2 || oh?.weaponType !== 2)) throw new Error('Mutilate requires two daggers.');
	if (['Mage', 'Priest', 'Warlock'].includes(className) && audit.some(item => items.get(item.id).armorType > 1))
		throw new Error('A cloth class cannot equip this armor.');
	return audit;
}

export async function collectGearCatalog({ root, archive, output, fetcher = fetch, cache, compact = false }) {
	const policy = JSON.parse(fs.readFileSync(path.join(root, 'tools/dps-experiments/gear-catalog-policy.json')));
	const database = JSON.parse(fs.readFileSync(path.join(root, 'assets/database/db.json')));
	const leftover = JSON.parse(fs.readFileSync(path.join(root, 'assets/database/leftover_db.json')));
	database.items.push(...leftover.items);
	database.enchants.push(...leftover.enchants);
	const capabilities = equipmentCapabilities(root);
	const cached = new Map((cache?.sources ?? []).map(record => [record.url, record]));
	const records = [],
		sets = [],
		rejected = [],
		seen = new Map();
	if (!archive) throw new Error('Supply a source archive directory in the local source library.');
	fs.mkdirSync(archive, { recursive: true });
	async function get(route) {
		const url = new URL(route, policy.source).href;
		const prior = cached.get(url);
		let bytes;
		if (prior?.archive) {
			bytes = fs.readFileSync(prior.archive);
			if (hash(bytes) !== prior.sha256) throw new Error(`Source archive hash mismatch: ${url}`);
		} else {
			const response = await fetcher(url);
			if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
			bytes = Buffer.from(await response.arrayBuffer());
		}
		const sha256 = hash(bytes);
		const file = path.join(archive, sha256 + '.json');
		if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
		records.push({
			url,
			sha256,
			bytes: bytes.length,
			archive: file,
			retrievedAt: prior?.archive ? prior.retrievedAt : new Date().toISOString(),
			category: 'community_gear_computation',
		});
		return JSON.parse(bytes);
	}
	const index = await get('/data/index.json');
	for (const spec of [...new Set(Object.values(policy.profiles))]) {
		const [className, specName] = spec.split('/');
		const specIndex = await get(`/data/bis/${className}-${specName}.json`);
		for (const faction of ['alliance', 'horde'])
			for (const option of policy.options)
				for (const dwarf of faction === 'alliance' ? [false, true] : [false]) {
					const key = option + (faction === 'horde' ? 'h' : dwarf ? 'd' : '');
					const listId = specIndex.combos[key];
					if (!listId) continue;
					const identity = spec + ':' + faction + ':' + listId;
					if (seen.has(identity)) {
						seen.get(identity).optionKeys.push(key);
						continue;
					}
					const list = await get(`/data/lists/${listId}.json`);
					try {
						const opts = {
							database,
							capabilities,
							className: className[0].toUpperCase() + className.slice(1),
							faction,
							daggerPair: className === 'rogue' && /assassination|mutilate/.test(specName),
						};
						const { list: compatible, substitutions } = compatiblePublishedList(list, opts);
						const resolved = equipmentFromList(compatible);
						const audit = validateEquipment(resolved.equipment, opts);
						const row = {
							id: `published-${spec.replace('/', '-')}-${faction}-${listId}`,
							spec,
							faction,
							tier: 'Published pre-raid',
							origin: substitutions.length ? 'Published ranked alternatives' : 'Community calculated list',
							optionKeys: [key],
							sourceUrl: new URL(`/preraid/${spec}/`, policy.source).href,
							dataUrl: records.at(-1).url,
							sourceSha256: records.at(-1).sha256,
							sourceGeneratedAt: index.generated_at,
							suppliedStatsUsed: false,
							substitutions,
							...resolved,
							audit,
						};
						seen.set(identity, row);
						sets.push(row);
						for (const variant of publishedHitAlternatives(compatible, opts)) {
							const resolvedVariant = equipmentFromList(variant.list);
							const { list: _list, ...construction } = variant;
							sets.push({
								...row,
								id: row.id + '-' + variant.label,
								origin: 'Published one-slot hit alternative',
								...resolvedVariant,
								audit: validateEquipment(resolvedVariant.equipment, opts),
								construction: {
									...construction,
									rule: 'One source-listed alternative; at least 80% of the source slot score retained. Reported hit selects the contrast; only native stats determine simulation outcomes. This is an experimental combination, not an endorsed best set.',
								},
							});
						}
					} catch (error) {
						rejected.push({ spec, faction, key, listId, reason: error.message });
					}
				}
		console.log(`${spec}: ${sets.filter(s => s.spec === spec).length} verified sets`);
	}
	const catalog = {
		schemaVersion: 1,
		collectedAt: new Date().toISOString(),
		policy,
		databaseSha256: hash(fs.readFileSync(path.join(root, 'assets/database/db.json'))),
		interpretation:
			'Published equipment candidates, not independently proven BiS. Only item IDs and enchant IDs enter WoWSims; external EP values, item stats, damage estimates and talent builds do not. Missing or invalid sets remain explicit rejections. No PvP or raid options are imported.',
		sets,
		rejected,
		sources: records,
	};
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, JSON.stringify(compact ? compactGearCatalog(catalog) : catalog, null, 2) + '\n');
	fs.writeFileSync(
		path.join(archive, 'manifest-' + hash(signature(records)).slice(0, 12) + '.json'),
		JSON.stringify({ sources: records, category: 'community_gear_computation', source: policy.source }, null, 2),
	);
	return catalog;
}

export function compactGearCatalog(catalog) {
	return {
		...catalog,
		sets: catalog.sets.map(({ audit: _audit, ...set }) => set),
		sources: catalog.sources.map(({ archive: _archive, ...source }) => source),
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
	const args = process.argv.slice(2),
		option = name => args[args.indexOf('--' + name) + 1];
	if (!args.includes('--archive') || !args.includes('--out'))
		throw new Error('Usage: node tools/dps-experiments/gear_catalog.mjs --archive source-library-directory --out derived-catalog.json');
	const result = await collectGearCatalog({
		root,
		archive: path.resolve(option('archive')),
		output: path.resolve(option('out')),
		compact: args.includes('--compact'),
	});
	console.log(JSON.stringify({ sets: result.sets.length, rejected: result.rejected.length }));
}
