import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveUnavailableReferences, rotationInputPath } from './robust_logic.mjs';

const preset = JSON.parse(fs.readFileSync(new URL('../../ui/specs/rogue/dps/apls/default.apl.json', import.meta.url)));
const lines = preset.priorityList.filter(line => {
	const action = line.action ?? {};
	return action.castSpell?.spellId?.spellId === 13750 || action.strictSequence?.actions.some(a => a.castSpell?.spellId?.spellId === 13750);
});
function value(v, ready) {
	if (v.const) return v.const.val === 'true' ? true : v.const.val === 'false' ? false : Number(v.const.val);
	if (v.and) return v.and.vals.every(x => value(x, ready));
	if (v.or) return v.or.vals.some(x => value(x, ready));
	if (v.not) return !value(v.not.val, ready);
	if (v.currentEnergy) return 30;
	if (v.auraIsActive) return true;
	if (v.spellIsReady) return ready.has(v.spellIsReady.spellId.spellId);
	if (v.cmp?.op === 'OpLe') return value(v.cmp.lhs, ready) <= value(v.cmp.rhs, ready);
	throw new Error('Unexpected cooldown condition: ' + JSON.stringify(v));
}
for (const racial of [null, 20572, 1259799]) {
	test('Adrenaline Rush remains reachable with a spent or absent racial: ' + racial, () => {
		const spells = [13750, ...(racial ? [racial] : [])].map(spellId => ({ id: { spellId } }));
		const metadata = {
			raidStats: { parties: [{ players: [{ metadata: { spells, auras: [{ id: { spellId: 6774 } }] } }] }] },
			encounterStats: { targets: [{ metadata: { auras: [] } }] },
		};
		const resolved = resolveUnavailableReferences({ priorityList: lines }, metadata).rotation;
		for (const ready of [new Set([13750]), new Set([13750, ...(racial ? [racial] : [])])]) {
			assert(
				resolved.priorityList.some(line => value(line.action.condition, ready)),
				'A known class cooldown has no usable racial-independent fallback.',
			);
		}
	});
}

test('a rotation input revision cannot admit executable simulator or database changes', () => {
	for (const file of [
		'ui/specs/rogue/dps/apls/default.apl.json',
		'sim/rogue/TestRogue.results',
		'.github/skills/wowsims-apl/references/rulings.md',
		'skills-lock.json',
	])
		assert(rotationInputPath(file));
	for (const file of ['sim/core/racials.go', 'sim/rogue/rogue_test.go', 'assets/database/db.json', 'proto/api.proto', 'ui/specs/rogue/dps/spec.ts'])
		assert(!rotationInputPath(file));
});
