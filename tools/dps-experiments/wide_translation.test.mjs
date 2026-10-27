import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenRotation } from './wide_translation.mjs';

test('group expansion preserves parent conditions and local variable scope', () => {
	const root = { const: { val: 'true' } },
		local = { const: { val: 'false' } };
	const rotation = {
		valueVariables: [{ name: 'flag', value: root }],
		groups: [
			{
				name: 'g',
				valueVariables: [{ name: 'flag', value: local }],
				actions: [{ action: { condition: { variableRef: { name: 'flag' } }, castSpell: { spellId: { spellId: 7 } } } }],
			},
		],
		priorityList: [{ action: { condition: { variableRef: { name: 'flag' } }, groupReference: { groupName: 'g' } } }],
	};
	assert.deepEqual(flattenRotation(rotation).priorityList[0].action.condition, { and: { vals: [root, local] } });
	assert.deepEqual(rotation.priorityList[0].action.groupReference, { groupName: 'g' });
});
