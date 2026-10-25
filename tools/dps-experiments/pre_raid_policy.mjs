export function itemEligibility(item, policy) {
	if (!item) return { eligible: false, reason: 'Missing item' };
	if (item.quality < 2 || item.quality > policy.maxQuality) return { eligible: false, reason: 'Quality outside policy' };
	if (!item.ilvl || item.ilvl > policy.maxItemLevel) return { eligible: false, reason: 'Item level outside policy' };
	if (/artisan|gladiator|grand marshal|high warlord|dark iron|flarecore|fiery chain/i.test(`${item.name} ${item.nameDescription ?? ''}`))
		return { eligible: false, reason: 'Raid crafting or PvP family' };
	const sources = (item.sources ?? []).map(source =>
		source.source?.oneofKind ? { [source.source.oneofKind]: source.source[source.source.oneofKind] } : source,
	);
	if (sources.some(source => source.rep)) return { eligible: false, reason: 'Reputation reward' };
	if (policy.reviewedSources?.[item.id]) return { eligible: true, reason: 'Reviewed non-raid acquisition', source: policy.reviewedSources[item.id] };
	const drop = sources.find(source => source.drop && policy.dungeonZones.some(zone => zone.id === source.drop.zoneId));
	if (drop) return { eligible: true, reason: 'Recorded dungeon drop', source: drop };
	const crafted = sources.find(source => source.crafted);
	if (crafted && (policy.reviewedCraftedIds === null || policy.reviewedCraftedIds.includes(item.id)))
		return { eligible: true, reason: 'Reviewed crafted item', source: crafted };
	return { eligible: false, reason: crafted ? 'Crafting not reviewed' : 'No approved non-raid source' };
}

export const ROLE_WEIGHTS = {
	caster: { 3: 0.25, 5: 1, 13: 0.02, 17: 1.2, 18: 0.6, 19: 1, 31: 0.15 },
	physical: { 0: 2, 1: 2, 14: 1, 15: 0, 16: 1, 17: 2.5, 18: 2, 19: 2, 20: 0.4, 21: 2 },
	hunter: { 0: 0.5, 1: 2, 3: 0.15, 14: 0.6, 15: 1, 17: 2.5, 18: 2, 19: 2, 20: 0.4, 21: 0.5 },
	holyShock: { 0: 0.7, 1: 0.7, 3: 1, 5: 1.8, 9: 1.8, 14: 0.35, 17: 1.5, 18: 1.5, 19: 1.5, 21: 0.8, 31: 0.2 },
};

export function roleFor(profile) {
	if (profile.specPath === 'hunter/dps') return 'hunter';
	if (profile.id === 'paladin-retribution-holy-shock') return 'holyShock';
	if (['druid/balance', 'mage/dps', 'priest/dps', 'shaman/elemental', 'warlock/dps'].includes(profile.specPath)) return 'caster';
	return 'physical';
}

export function itemScore(item, role, slot, specPath) {
	const weights = ROLE_WEIGHTS[role];
	let score = Object.entries(weights).reduce((sum, [stat, weight]) => sum + (item.stats?.[stat] ?? 0) * weight, 0);
	if (item.type === 13 && item.weaponSpeed > 0 && role !== 'caster') {
		const dps = (item.weaponDamageMin + item.weaponDamageMax) / (2 * item.weaponSpeed);
		let factor = slot === 15 ? 4 : item.handType === 4 ? 14 : 8;
		if (role === 'hunter') factor = slot === 15 ? 2 : 4;
		if (specPath === 'druid/feralcat') factor = 0;
		score += dps * factor;
	}
	if (item.type === 14 && role === 'hunter' && item.weaponSpeed > 0) score += ((item.weaponDamageMin + item.weaponDamageMax) / (2 * item.weaponSpeed)) * 8;
	return score;
}
