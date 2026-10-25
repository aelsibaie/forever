import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProfile, changedPaths } from './preset_audit.mjs';

test('schema comparison ignores key order and reports removed gameplay fields', () => {
	assert.deepEqual(changedPaths({ x: 1, y: 2 }, { y: 2, x: 1 }), []);
	assert.deepEqual(changedPaths({ player: { race: 1, rotation: { simple: 'x' } } }, { player: { race: 2, rotation: {} } }), [
		'player.race',
		'player.rotation.simple',
	]);
});

test('spec families retain distinct talent trees and gear evidence', () => {
	const profile = { id: 'mage-fire', specPath: 'mage/dps', name: 'Fire', talentPoints: [10, 41, 0], gearName: 'P1 Arcane' };
	assert.deepEqual(classifyProfile(profile), { specLabel: 'Fire Mage', gearTier: 'Developer P1', documentedPreRaid: false });
	assert.equal(classifyProfile({ ...profile, specPath: 'warrior/dps', talentPoints: [17, 34, 0], gearName: 'Pre-BiS' }).documentedPreRaid, true);
	assert.equal(
		classifyProfile({ ...profile, specPath: 'paladin/retribution', gearName: 'Default', gearTooltip: 'A placeholder until Phase 1.' }).gearTier,
		'Pre-raid placeholder',
	);
});
