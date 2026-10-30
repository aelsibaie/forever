export function summarizeResult(result, expectedIterations) {
	if (result.error) throw new Error(result.error.message || 'Simulation returned an error.');
	if (result.iterationsDone !== expectedIterations) throw new Error('Simulation iteration count is incomplete.');
	const player = result.raidMetrics?.parties?.[0]?.players?.[0];
	const values = player?.dps?.allValues;
	if (!values || values.length !== expectedIterations || !values.every(Number.isFinite))
		throw new Error('Simulation iteration DPS values are missing or invalid.');
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	if (Math.abs(mean - player.dps.avg) > Math.max(1, Math.abs(mean)) * 1e-10) throw new Error('Saved DPS values disagree with the reported mean.');
	const stdev = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
	const sorted = [...values].sort((a, b) => a - b);
	const quantile = p => {
		const i = (sorted.length - 1) * p;
		const low = Math.floor(i);
		return sorted[low] + (sorted[Math.ceil(i)] - sorted[low]) * (i - low);
	};
	const seconds = result.avgIterationDuration * expectedIterations;
	const enemies = new Set(result.encounterMetrics?.targets?.map(target => target.unitIndex));
	if (enemies.size === 0) throw new Error('Simulation target metrics are missing.');
	const damage = (actions = []) =>
		actions
			.map(action => ({
				id: action.id,
				damage: action.targets.filter(target => enemies.has(target.unitIndex)).reduce((sum, target) => sum + target.damage, 0),
				casts: action.targets.filter(target => enemies.has(target.unitIndex)).reduce((sum, target) => sum + target.casts, 0) / expectedIterations,
			}))
			.filter(action => action.damage > 0)
			.map(action => ({ ...action, dps: action.damage / seconds }))
			.sort((a, b) => b.dps - a.dps);
	const ci95HalfWidth = (1.959963984540054 * stdev) / Math.sqrt(values.length);
	return {
		iterations: expectedIterations,
		meanDps: mean,
		stdev,
		ci95HalfWidth,
		ci95Low: mean - ci95HalfWidth,
		ci95High: mean + ci95HalfWidth,
		p10: quantile(0.1),
		median: quantile(0.5),
		p90: quantile(0.9),
		min: sorted[0],
		max: sorted.at(-1),
		secondsOomAvg: player.secondsOomAvg,
		petDps: (player.pets ?? []).reduce((sum, pet) => sum + pet.dps.avg, 0),
		damageActions: damage(player.actions),
		petActions: (player.pets ?? []).map(pet => ({ name: pet.name, dps: pet.dps.avg, actions: damage(pet.actions) })),
	};
}

export function csv(rows) {
	const keys = [
		'profileId',
		'className',
		'specPath',
		'buildName',
		'gearName',
		'race',
		'duration',
		'iterations',
		'meanDps',
		'stdev',
		'ci95HalfWidth',
		'ci95Low',
		'ci95High',
		'p10',
		'median',
		'p90',
		'secondsOomAvg',
		'petDps',
		'rankEligible',
		'requestSha256',
		'resultSha256',
		'elapsedSeconds',
	];
	const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
	return [keys.join(','), ...rows.map(row => keys.map(key => escape(row[key])).join(','))].join('\n') + '\n';
}

export function resolvedRequestKey(request) {
	const normalized = structuredClone(request);
	for (const party of normalized.raid.parties) {
		for (const player of party.players) {
			delete player.name;
			// Simple-rotation UI settings are already expanded into the priority list.
			if (player.rotation) delete player.rotation.simple;
		}
	}
	return JSON.stringify(normalized);
}
