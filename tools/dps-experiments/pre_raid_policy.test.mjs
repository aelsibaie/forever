import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemEligibility, itemScore } from './pre_raid_policy.mjs';

const policy = { maxQuality: 3, maxItemLevel: 65, dungeonZones: [{ id: 1 }], reviewedCraftedIds: [2] };
test('source zones reject raid drops even when difficulty is normal', () => {
	const item = { id: 1, name: 'Item', quality: 3, ilvl: 60, sources: [{ drop: { zoneId: 2, difficulty: 1 } }] };
	assert.equal(itemEligibility(item, policy).eligible, false);
	item.sources[0].drop.zoneId = 1;
	assert.equal(itemEligibility(item, policy).eligible, true);
});
test('crafting requires a reviewed recipe and the quality budget', () => {
	const item = { id: 2, name: 'Crafted', quality: 3, ilvl: 60, sources: [{ crafted: { spellId: 1 } }] };
	assert.equal(itemEligibility(item, policy).eligible, true);
	assert.equal(itemEligibility({ ...item, id: 3 }, policy).eligible, false);
	assert.equal(itemEligibility({ ...item, quality: 4 }, policy).eligible, false);
});
test('source checks accept protobuf oneof objects', () => {
	const item = { id: 1, name: 'Item', quality: 3, ilvl: 60, sources: [{ source: { oneofKind: 'drop', drop: { zoneId: 1 } } }] };
	assert.equal(itemEligibility(item, policy).eligible, true);
});
test('a shared caster score ignores school-specific bonuses', () => {
	const item = { type: 1, stats: [0, 0, 0, 0, 0, 10, 0, 20] };
	assert.equal(itemScore(item, 'caster', 0, 'mage/dps'), 10);
});
