import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleRaces, factionPlayer, notesOverlay, racialActions, compareSamples } from './racial_helpers.mjs';

const policy = { factions: { alliance: ['RaceHuman', 'RaceDwarf'], horde: ['RaceOrc'] }, counterparts: [{ alliance: 1, horde: 2 }] };
const database = {
	items: [
		{ id: 1, name: 'Alliance', factionRestriction: 1, type: 1, scalingOptions: { stats: { 4: 12 } } },
		{ id: 2, name: 'Horde', factionRestriction: 2, type: 1, scalingOptions: { stats: { 4: 12 } } },
	],
};

test('faction counterparts preserve gear fields and reject changed combat data', () => {
	const player = { equipment: { items: [{ id: 2, enchant: 4, randomSuffix: 8 }] }, itemSwap: { items: [{ id: 2 }] } };
	const result = factionPlayer(player, 'alliance', database, policy);
	assert.equal(player.equipment.items[0].id, 2);
	assert.deepEqual(result.player.equipment.items[0], { id: 1, enchant: 4, randomSuffix: 8 });
	assert.equal(result.player.itemSwap.items[0].id, 1);
	const changed = structuredClone(database);
	changed.items[0].scalingOptions.stats[4]++;
	assert.throws(() => factionPlayer(player, 'alliance', changed, policy), /No verified/);
	assert.throws(() => factionPlayer(player, 'alliance', database, { ...policy, counterparts: [] }), /No verified/);
});

test('a counterpart that could alter an active set is rejected', () => {
	const changed = structuredClone(database);
	changed.items[0].setId = 10;
	changed.items[1].setId = 20;
	assert.throws(() => factionPlayer({ equipment: { items: [{ id: 2 }, { id: 2 }] } }, 'alliance', changed, policy), /active set/);
});

test('eligibility follows the exported capabilities and rejects unknown races', () => {
	assert.deepEqual(eligibleRaces('Mage', 'alliance', { Mage: ['RaceHuman', 'RaceOrc'] }, policy), ['RaceHuman']);
	assert.throws(() => eligibleRaces('Mage', 'alliance', { Mage: ['RaceNew'] }, policy), /Review/);
});

test('racial activation inserts only the selected guarded casts', () => {
	const player = { rotation: { priorityList: [{ action: { castSpell: { spellId: { spellId: 7 } } } }] } };
	const adjusted = racialActions(player, [20554, 20554]);
	assert.equal(player.rotation.priorityList.length, 1);
	assert.equal(adjusted.rotation.priorityList.length, 2);
	assert.deepEqual(adjusted.rotation.priorityList.slice(1), player.rotation.priorityList);
	assert.deepEqual(adjusted.rotation.priorityList[0].action.condition, { spellIsKnown: { spellId: { spellId: 20554 } } });
});

test('paired uncertainty retains covariance and rejects unmatched samples', () => {
	const result = compareSamples([11, 22, 33, 44], [10, 20, 30, 40]);
	assert.ok(Math.abs(result.percent - 10) < 1e-12);
	assert.ok(result.ci95HalfWidthPercent < 1e-12);
	assert.ok(result.distinguishable);
	assert.equal(compareSamples([10, 20, 30], [10, 20, 30]).percent, 0);
	assert.throws(() => compareSamples([1, 2], [1, 2, 3]), /matching/);
});

test('the notes adapter accepts adopted changes and refuses source drift', () => {
	const original =
		'bloodFuryCD := Cooldown{\n\t\t\tTimer:    character.NewTimer(),\n\t\t\tDuration: time.Minute * 3,\nLabel:    "Berserking",\n\t\t\tActionID: actionID,\n\t\t\tDuration: time.Second * 10,\nICD:        time.Second * 25,';
	const patched = notesOverlay(original);
	assert.ok(patched.status.every(row => row.action === 'overlay'));
	assert.ok(notesOverlay(patched.text).status.every(row => row.action === 'already-upstream'));
	assert.throws(() => notesOverlay(original.replace('time.Second * 25', 'time.Second * 20')), /cannot locate/);
});
