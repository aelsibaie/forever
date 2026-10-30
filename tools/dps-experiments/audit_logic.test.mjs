import test from 'node:test';
import assert from 'node:assert/strict';
import { staticCondition } from './audit_logic.mjs';

test('an absent known-aura guard disables its whole conjunction despite dynamic siblings', () => {
	const context = { spells: new Set(), auras: new Set(), targetAuras: new Set([7]), variables: new Map() };
	assert.equal(staticCondition({ and: { vals: [{ auraIsKnown: { auraId: { spellId: 7 } } }, { currentManaPercent: {} }] } }, context), false);
	assert.equal(staticCondition({ auraIsKnown: { sourceUnit: { type: 'CurrentTarget' }, auraId: { spellId: 7 } } }, context), true);
	assert.equal(staticCondition({ or: { vals: [{ auraIsKnown: { auraId: { spellId: 7 } } }, { currentManaPercent: {} }] } }, context), null);
	assert.equal(staticCondition({ spellIsKnown: { spellId: { itemId: 9449 } } }, context), null);
});
