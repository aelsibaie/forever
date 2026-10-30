import crypto from 'node:crypto';

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const stable = value =>
	!value || typeof value !== 'object'
		? value
		: Array.isArray(value)
			? value.map(stable)
			: Object.fromEntries(
					Object.keys(value)
						.sort()
						.map(key => [key, stable(value[key])]),
				);
export const signature = value => JSON.stringify(stable(value));

export function eligibleRaces(className, faction, capabilities, policy) {
	const known = new Set(Object.values(policy.factions).flat());
	const all = capabilities[className];
	if (!all?.length || all.some(race => !known.has(race))) throw new Error(`Review race eligibility and faction policy for ${className}.`);
	return policy.factions[faction].filter(race => all.includes(race));
}

export function factionPlayer(original, faction, database, policy) {
	const player = structuredClone(original),
		substitutions = [];
	const items = new Map(database.items.map(item => [item.id, item]));
	const excluded = faction === 'alliance' ? 2 : 1;
	const metadata = new Set(['id', 'name', 'icon', 'sources', 'factionRestriction', 'setId', 'setName']);
	const combat = item => signature(Object.fromEntries(Object.entries(item).filter(([key]) => !metadata.has(key))));
	for (const equipment of [player.equipment, player.itemSwap]) {
		if (!equipment?.items) continue;
		for (const entry of equipment.items) {
			if (!entry.id) continue;
			const item = items.get(entry.id);
			if (!item) throw new Error(`Equipment item ${entry.id} is absent from the current database.`);
			if (item.factionRestriction !== excluded) continue;
			const counterpart = policy.counterparts.find(pair => pair[faction === 'alliance' ? 'horde' : 'alliance'] === item.id);
			const replacement = items.get(counterpart?.[faction]);
			if (!replacement || replacement.factionRestriction === excluded || combat(item) !== combat(replacement))
				throw new Error(
					`No verified ${faction} counterpart for ${item.id} (${item.name}). Review the gear policy; no replacement is selected automatically.`,
				);
			if (
				item.setId !== replacement.setId &&
				equipment.items.some(other => other !== entry && other.id && [item.setId, replacement.setId].includes(items.get(other.id)?.setId))
			)
				throw new Error(`Faction counterpart ${item.id} changes a potentially active set bonus.`);
			substitutions.push({
				from: item.id,
				to: replacement.id,
				fromName: item.name,
				toName: replacement.name,
				setChanged: item.setId !== replacement.setId,
			});
			entry.id = replacement.id;
		}
	}
	return { player, substitutions };
}

const eureka = { Rogue: 1259812, Warrior: 1259813, Mage: 1259817, Warlock: 1259821, Priest: 1259823 };
export function offensiveRacial(race, className) {
	return { RaceOrc: 20572, RaceTroll: 20554, RaceNightElf: 1259799, RaceGnome: eureka[className] }[race];
}

export function racialActions(player, spellIds) {
	const result = structuredClone(player);
	const ids = [...new Set(spellIds)];
	result.rotation.priorityList.unshift(
		...ids.map(spellId => ({ action: { condition: { spellIsKnown: { spellId: { spellId } } }, castSpell: { spellId: { spellId } } } })),
	);
	return result;
}

export function racialMetrics(raw, race, className, iterations) {
	const id = offensiveRacial(race, className),
		player = raw.raidMetrics.parties[0].players[0];
	const casts = spellId =>
		player.actions
			.filter(action => action.id.spellId === spellId)
			.reduce((sum, action) => sum + action.targets.reduce((total, target) => total + target.casts, 0), 0) / iterations;
	return {
		spellId: id ?? null,
		casts: id ? casts(id) : null,
		uptimeSeconds: id ? (player.auras.find(aura => aura.id.spellId === id)?.uptimeSecondsAvg ?? 0) : null,
		readLeylineCasts: race === 'RaceHighOrderSkyborne' ? casts(1259705) : null,
	};
}

export function compareSamples(left, right) {
	if (left.length !== right.length || left.length < 2) throw new Error('Paired samples require matching iteration counts.');
	const n = left.length,
		mean = x => x.reduce((sum, value) => sum + value, 0) / n;
	const a = mean(left),
		b = mean(right),
		ratio = a / b;
	if (!(b > 0)) throw new Error('Cannot compare a zero-DPS reference.');
	const residual = left.map((value, i) => value - ratio * right[i]),
		z = mean(residual);
	const half = 1.959963984540054 * Math.sqrt(residual.reduce((sum, value) => sum + (value - z) ** 2, 0) / (n - 1) / n);
	return { differenceDps: a - b, percent: 100 * (ratio - 1), ci95HalfWidthPercent: (100 * half) / b, distinguishable: Math.abs(a - b) > half };
}

export function notesOverlay(source) {
	const changes = [
		[
			'Blood Fury cooldown',
			'bloodFuryCD := Cooldown{\n\t\t\tTimer:    character.NewTimer(),\n\t\t\tDuration: time.Minute * 3,',
			'bloodFuryCD := Cooldown{\n\t\t\tTimer:    character.NewTimer(),\n\t\t\tDuration: time.Minute * 2,',
		],
		[
			'Berserking duration',
			'Label:    "Berserking",\n\t\t\tActionID: actionID,\n\t\t\tDuration: time.Second * 10,',
			'Label:    "Berserking",\n\t\t\tActionID: actionID,\n\t\t\tDuration: time.Second * 15,',
		],
		['Touch of the Grave ICD', 'ICD:        time.Second * 25,', 'ICD:        time.Second * 15,'],
	];
	let text = source.replaceAll('\r\n', '\n');
	const status = [];
	for (const [name, before, after] of changes) {
		if (text.split(before).length === 2 && !text.includes(after)) {
			text = text.replace(before, after);
			status.push({ name, action: 'overlay' });
		} else if (!text.includes(before) && text.split(after).length === 2) status.push({ name, action: 'already-upstream' });
		else throw new Error(`The notes-2026-10-27 adapter cannot locate ${name} uniquely. Review it or use --model upstream.`);
	}
	return { text, status };
}

export function rotationCaveats(profileId, messages, policy) {
	const warnings = messages.filter(message => message.logLevel === 'Warning').map(message => message.validation);
	const markers = (policy.reviewedRotationCaveats ?? [])
		.filter(caveat => caveat.profileId === profileId && warnings.some(text => text.includes('No aura found') && text.includes(String(caveat.spellId))))
		.map(caveat => ({ code: 'rotation', label: caveat.label, reason: caveat.reason }));
	if (warnings.some(text => text.includes('Condition could not be resolved')))
		markers.push({ code: 'condition', label: 'Unresolved condition', reason: 'An APL condition is unresolved. See the exact validation dump.' });
	return markers;
}
