import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { rankRaceSamples, sampleComparison } from './robust_logic.mjs';

const source = path.resolve(process.argv[2] ?? ''),
	out = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node tools/dps-experiments/hunter_pet_probe.mjs study-directory new-output-directory');
if (fs.existsSync(out)) throw new Error('Use a new pet-control directory.');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const provenance = read(path.join(source, 'provenance.json'));
const engine = path.join(source, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch');
if (hash(fs.readFileSync(engine)) !== provenance.engineSha256) throw new Error('The native engine changed.');
const profiles = read(path.join(source, 'profiles.json')).profiles.filter(
	p => p.className === 'Hunter' && [undefined, 'PetNone'].includes(p.player.hunter.options.classOptions.petType),
);
const cells = read(path.join(source, 'cells.json')).filter(row => row.phase === 'validation' && row.support === 'full' && row.referencePolicy === 'developer');
const inputs = [],
	jobs = [],
	samples = new Map(),
	iterations = 1000,
	seed = 8026102801;
for (const directory of ['requests', 'results', 'stats']) fs.mkdirSync(path.join(out, directory), { recursive: true });
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(out, 'tool-source.mjs'));
for (const profile of profiles)
	for (const duration of [60, 180, 300])
		for (const race of profile.races)
			for (const pool of ['developer', 'published-pre-raid']) {
				const sets = new Set(
					profile.sets
						.filter(gear => (pool === 'developer' ? gear.id === 'developer' : [gear, ...gear.aliases].some(g => g.tier === 'Published pre-raid')))
						.map(g => g.id),
				);
				const selected = cells
					.filter(
						row =>
							row.profileId === profile.id &&
							row.faction === profile.faction &&
							row.race === race &&
							row.duration === duration &&
							sets.has(row.setId),
					)
					.sort((a, b) => b.meanDps - a.meanDps)[0];
				if (!selected) throw new Error('Missing Hunter selection: ' + profile.id);
				const sourceFile = path.join(source, 'requests', selected.key + '.json');
				if (hash(fs.readFileSync(sourceFile)) !== selected.requestSha256) throw new Error('Hunter source request changed.');
				for (const variant of ['petless', 'raptor']) {
					const request = read(sourceFile);
					request.simOptions.iterations = iterations;
					request.simOptions.randomSeed = String(seed);
					if (variant === 'raptor') request.raid.parties[0].players[0].hunter.options.classOptions.petType = 'Raptor';
					const key = variant + '--' + hash([profile.faction, profile.id, duration, race, pool].join('--')).slice(0, 24);
					const input = path.join(out, 'requests', key + '.json');
					fs.writeFileSync(input, JSON.stringify(request));
					inputs.push({
						key,
						profileId: profile.id,
						faction: profile.faction,
						race,
						duration,
						pool,
						variant,
						setId: selected.setId,
						sourceKey: selected.key,
						sourceRequestSha256: selected.requestSha256,
						requestSha256: hash(fs.readFileSync(input)),
					});
					jobs.push({ key, request: input, result: path.join(out, 'results', key + '.json'), stats: path.join(out, 'stats', key + '.json') });
				}
			}
fs.writeFileSync(path.join(out, 'jobs.json'), JSON.stringify(jobs));
execFileSync(engine, [path.join(out, 'jobs.json'), '2'], { stdio: 'inherit' });
const rows = inputs.map(row => {
	const file = path.join(out, 'results', row.key + '.json'),
		raw = read(file),
		player = raw.raidMetrics.parties[0].players[0];
	const petDps = player.pets.reduce((sum, pet) => sum + pet.dps.avg, 0);
	if (row.variant === 'raptor' && !player.pets.some(pet => /raptor/i.test(pet.name) && pet.dps.avg > 0))
		throw new Error('The requested Raptor did not deal damage.');
	if (row.variant === 'petless' && player.pets.some(pet => /raptor/i.test(pet.name))) throw new Error('A baseline unexpectedly has a Raptor.');
	samples.set(row.key, player.dps.allValues);
	return { ...row, ...summarizeResult(raw, iterations), petDps, petNames: player.pets.map(pet => pet.name), resultSha256: hash(fs.readFileSync(file)) };
});
const contrasts = rows
	.filter(row => row.variant === 'raptor')
	.map(row => {
		const base = rows.find(b => b.sourceKey === row.sourceKey && b.pool === row.pool && b.variant === 'petless');
		return {
			profileId: row.profileId,
			faction: row.faction,
			race: row.race,
			duration: row.duration,
			pool: row.pool,
			sourceKey: row.sourceKey,
			probeKey: row.key,
			baselineKey: base.key,
			...sampleComparison(samples.get(row.key), samples.get(base.key)),
		};
	});
const grouped = new Map();
for (const row of rows) {
	const key = [row.faction, row.profileId, row.duration, row.pool, row.variant].join('--');
	if (!grouped.has(key)) grouped.set(key, []);
	grouped.get(key).push(row);
}
const groups = [...grouped].map(([key, rows]) => ({
	key,
	profileId: rows[0].profileId,
	faction: rows[0].faction,
	duration: rows[0].duration,
	pool: rows[0].pool,
	variant: rows[0].variant,
	...rankRaceSamples(rows, row => samples.get(row.key)),
	rows,
}));
const result = {
	sourceCommit: provenance.sourceCommit,
	engineSha256: provenance.engineSha256,
	iterations,
	seed,
	scope: 'Intentional Lone Wolf petless builds versus the developer Raptor settings, changing only petType. Original talents and racial policy retained. Developer anchor and independently retested per-race validation-selected published gear; 60/180/300 seconds, full support, neutral target and original developer references. This is a sensitivity check, not a pet or talent optimizer.',
	rows,
	contrasts,
	groups,
};
fs.writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(result, null, 2));
console.log(
	JSON.stringify({
		cases: rows.length,
		contrasts: contrasts.length,
		petBetter: contrasts.filter(c => c.percent - c.halfWidthPercent > 0.2).length,
		petWorse: contrasts.filter(c => c.percent + c.halfWidthPercent < -0.2).length,
	}),
);
