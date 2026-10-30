import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRotation, translateStats, translateTalents } from './shadow_translation.mjs';

test('generic equipment ratings are shared once by the receiving engine', () => {
	const stats = translateStats({ HitRating: 30, CritRating: 28 }, { MeleeHit: 0, SpellHit: 1, MeleeCrit: 2, SpellCrit: 3 });
	assert.deepEqual(stats, [3, 0, 2, 0]);
	assert.throws(() => translateStats({ NewStat: 1 }, { MeleeHit: 0 }), /Unsupported equipped stat/);
});
test('rotation expansion preserves conditions and rejects missing or cyclic definitions', () => {
	const value = { const: { val: '5s' } };
	const rotation = {
		valueVariables: [{ name: 'threshold', value }],
		priorityList: [{ action: { condition: { variableRef: { name: 'threshold' } }, castSpell: { spellId: { spellId: 1 } } } }, { hide: true, action: {} }],
	};
	const result = expandRotation(rotation);
	assert.deepEqual(result.priorityList[0].action.condition, value);
	assert.equal(result.priorityList.length, 1);
	assert.equal(rotation.priorityList.length, 2);
	assert.throws(() => expandRotation({ valueVariables: [], priorityList: [{ action: { variableRef: { name: 'missing' } } }] }), /Unresolved/);
	assert.throws(
		() =>
			expandRotation({
				valueVariables: [{ name: 'loop', value: { variableRef: { name: 'loop' } } }],
				priorityList: [{ action: { variableRef: { name: 'loop' } } }],
			}),
		/cyclic/,
	);
});
test('talent positions follow field declarations despite wire-number gaps', () => {
	const schema = 'message PriestTalents {\n' + Array.from({ length: 52 }, (_, i) => 'int32 talent_' + i + ' = ' + (500 - i) + ';').join('\n') + '\n}';
	const allocation = Array.from({ length: 51 }, (_, i) => ({ field: 'talent_' + i, points: 1 }));
	const result = translateTalents(allocation, schema).split('-');
	assert.deepEqual(
		result.map(x => x.length),
		[18, 17, 16],
	);
	assert.throws(() => translateTalents([{ field: 'unknown', points: 51 }], schema), /Unsupported named talent/);
});
