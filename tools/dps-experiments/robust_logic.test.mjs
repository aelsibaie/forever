import test from 'node:test';
import assert from 'node:assert/strict';
import { normalQuantile, sampleComparison, rankRaceSamples, resolveUnavailableReferences, prepareRobustPlayer } from './robust_logic.mjs';
import { validateEquipment, compatiblePublishedList } from './gear_catalog.mjs';

test('paired race intervals retain exact proportional changes and widen for unpaired noise', () => {
	const reference = [90, 110, 80, 120];
	const paired = sampleComparison(
		reference.map(x => x * 1.01),
		reference,
	);
	assert(Math.abs(paired.percent - 1) < 1e-10);
	assert(paired.halfWidthPercent < 1e-10);
	assert(sampleComparison([120, 80, 110, 90], reference).halfWidthPercent > 1);
	assert(Math.abs(normalQuantile(0.975) - 1.95996398454) < 1e-6);
	assert(normalQuantile(1 - 0.05 / 20) > normalQuantile(0.975));
});

test('a noisy top mean does not exclude a practically tied race', () => {
	const rows = [
		{ race: 'a', key: 'a', meanDps: 100.1 },
		{ race: 'b', key: 'b', meanDps: 100 },
	];
	const samples = { a: [90, 110.2], b: [100, 100] };
	assert.deepEqual(rankRaceSamples(rows, row => samples[row.key]).candidates, ['a', 'b']);
});

const metadata = {
	raidStats: { parties: [{ players: [{ metadata: { spells: [{ id: { spellId: 10 } }], auras: [{ id: { spellId: 20 } }] } }] }] },
	encounterStats: { targets: [{ metadata: { auras: [] } }] },
};
const rotationWith = condition => ({ priorityList: [{ action: { condition, castSpell: { spellId: { spellId: 10 } } } }] });
test('an unavailable aura stays false inside negation instead of losing its branch', () => {
	const rotation = rotationWith({ not: { val: { auraIsActive: { auraId: { spellId: 999 } } } } });
	const resolved = resolveUnavailableReferences(rotation, metadata);
	assert.deepEqual(resolved.rotation.priorityList[0].action.condition, { const: { val: 'true' } });
	assert.equal(resolved.changes[0].id.spellId, 999);
	assert(rotation.priorityList[0].action.condition.not);
});

test('a false known-spell guard safely removes an unavailable numeric branch', () => {
	const rotation = rotationWith({
		and: {
			vals: [
				{ spellIsKnown: { spellId: { spellId: 999 } } },
				{ cmp: { op: 'OpGe', lhs: { currentEnergy: {} }, rhs: { spellCurrentCost: { spellId: { spellId: 999 } } } } },
			],
		},
	});
	assert.deepEqual(resolveUnavailableReferences(rotation, metadata).rotation.priorityList[0].action.condition, { const: { val: 'false' } });
});

test('known aura conditions preserve their native dynamic evaluation', () => {
	const rotation = rotationWith({ auraIsActive: { auraId: { spellId: 20 } } });
	assert.deepEqual(resolveUnavailableReferences(rotation, metadata).rotation, rotation);
});

test('known spell cost references keep their ActionID intact', () => {
	const rotation = rotationWith({ cmp: { op: 'OpGe', lhs: { currentEnergy: {} }, rhs: { spellCurrentCost: { spellId: { spellId: 10 } } } } });
	assert.deepEqual(resolveUnavailableReferences(rotation, metadata).rotation, rotation);
});

test('indexed Target and CurrentTarget read enemy metadata', () => {
	const stats = structuredClone(metadata);
	stats.encounterStats.targets[0].metadata.auras.push({ id: { spellId: 30 } });
	for (const type of ['Target', 'CurrentTarget']) {
		const rotation = rotationWith({ auraNumStacks: { sourceUnit: { type }, auraId: { spellId: 30 } } });
		assert.deepEqual(resolveUnavailableReferences(rotation, stats).rotation, rotation);
	}
});

test('an unavailable cooldown branch does not erase a valid alternative', () => {
	const active = { auraIsActive: { auraId: { spellId: 20 } } };
	const rotation = rotationWith({
		or: { vals: [active, { cmp: { op: 'OpLe', lhs: { spellTimeToReady: { spellId: { spellId: 999 } } }, rhs: { const: { val: '10s' } } } }] },
	});
	assert.deepEqual(resolveUnavailableReferences(rotation, metadata).rotation.priorityList[0].action.condition, active);
});

test('one enchant effect may have several legal slot records', () => {
	const equipment = { items: Array.from({ length: 17 }, () => ({})) };
	equipment.items[1] = { id: 1, enchant: 904 };
	equipment.items[14] = { id: 2 };
	const database = {
		items: [
			{ id: 1, type: 2 },
			{ id: 2, type: 13, weaponType: 9, handType: 2 },
		],
		enchants: [
			{ effectId: 904, type: 2 },
			{ effectId: 904, type: 10 },
		],
	};
	assert.equal(validateEquipment(equipment, { database, className: 'Warrior', faction: 'alliance' }).length, 2);
	assert.throws(
		() => validateEquipment(equipment, { database: { ...database, enchants: [{ effectId: 904, type: 10 }] }, className: 'Warrior', faction: 'alliance' }),
		/Enchant/,
	);
});

test('published fallback keeps source order and never imports a missing item stat line', () => {
	const original = {
		slots: [
			{
				slot: 'head',
				item: { id: 999 },
				alternatives: [
					{ id: 1, delta: -2 },
					{ id: 2, delta: -3 },
				],
			},
		],
	};
	const database = {
		items: [
			{ id: 1, type: 1, factionRestriction: 2 },
			{ id: 2, type: 1 },
		],
		enchants: [],
	};
	const result = compatiblePublishedList(original, { database, className: 'Warrior', faction: 'alliance' });
	assert.equal(result.list.slots[0].item.id, 2);
	assert.equal(result.substitutions[0].publishedAlternativeRank, 2);
	assert.equal(original.slots[0].item.id, 999);
});

test('raid preparation removes enhanced Skyborne tags and rejects three-profession sets', () => {
	const player = {
		profession1: 'Engineering',
		equipment: { items: [] },
		rotation: { priorityList: [{ action: { castSpell: { spellId: { spellId: 1259705, tag: 1 } } } }] },
	};
	const gear = { equipment: { items: [] }, requiredProfessions: ['Enchanting'] };
	const resolved = prepareRobustPlayer(player, { race: 'RaceHighOrderSkyborne', className: 'Mage', gear });
	assert.equal(resolved.player.rotation.priorityList[0].action.castSpell.spellId.tag, undefined);
	assert.equal(resolved.player.profession2, 'Engineering');
	assert.equal(player.rotation.priorityList[0].action.castSpell.spellId.tag, 1);
	assert.throws(
		() => prepareRobustPlayer(player, { race: 'RaceHuman', className: 'Mage', gear: { ...gear, requiredProfessions: ['Tailoring', 'Enchanting'] } }),
		/two professions/,
	);
});

test('Priest damage racial policies preserve maintenance actions before the filler', () => {
	const player = {
		equipment: { items: [] },
		rotation: { priorityList: [{ action: { castSpell: { spellId: { spellId: 19280 } } } }, { action: { channelSpell: { spellId: { spellId: 18807 } } } }] },
	};
	for (const [race, id] of [
		['RaceNightElf', 19305],
		['RaceDwarf', 1277335],
	]) {
		const result = prepareRobustPlayer(player, { race, className: 'Priest', gear: { equipment: player.equipment }, classRacial: 'damage-dpet' });
		const actions = result.player.rotation.priorityList.map(line => line.action);
		const at = actions.findIndex(action => action.castSpell?.spellId.spellId === id);
		assert.equal(actions[at - 1].castSpell.spellId.spellId, 19280);
		assert.equal(actions[at + 1].channelSpell.spellId.spellId, 18807);
		assert.equal(actions[at].condition.and.vals[1].cmp.rhs.spellExpectedDpet.spellId.spellId, 18807);
	}
	assert.equal(player.rotation.priorityList.length, 2);
});

test('the Leyline mana policy also guards existing cast actions', () => {
	const player = { equipment: { items: [] }, rotation: { priorityList: [{ action: { castSpell: { spellId: { spellId: 1259705 } } } }] } };
	const result = prepareRobustPlayer(player, {
		race: 'RaceHighOrderSkyborne',
		className: 'Mage',
		gear: { equipment: player.equipment },
		mana: 'leyline65-guarded',
	});
	for (const line of result.player.rotation.priorityList) assert(line.action.condition.and.vals.some(v => v.cmp?.lhs.currentManaPercent));
	assert.equal(player.rotation.priorityList[0].action.condition, undefined);
});

test('source ammunition changes preserve the Hunter pet and the original input', () => {
	const player = {
		equipment: { items: [] },
		hunter: { options: { classOptions: { ammo: 'ThoriumHeadedArrow', quiverBonus: 'AncientSinewWrappedLamina', petType: 'Raptor' } } },
		rotation: { priorityList: [] },
	};
	const gear = { equipment: player.equipment, nativeHunterOptions: { ammo: 'SwiftfeatherArrow', quiverBonus: 'QuickdrawQuiver' } };
	const result = prepareRobustPlayer(player, { race: 'RaceOrc', className: 'Hunter', gear });
	assert.equal(result.player.hunter.options.classOptions.petType, 'Raptor');
	assert.equal(result.player.hunter.options.classOptions.quiverBonus, 'QuickdrawQuiver');
	assert.equal(player.hunter.options.classOptions.quiverBonus, 'AncientSinewWrappedLamina');
	assert.throws(
		() => prepareRobustPlayer(player, { race: 'RaceOrc', className: 'Hunter', gear: { ...gear, nativeHunterOptions: { petType: 'PetNone' } } }),
		/other Hunter options/,
	);
});
