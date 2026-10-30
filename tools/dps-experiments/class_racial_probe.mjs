import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, signature } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { prepareRobustPlayer, sampleComparison } from './robust_logic.mjs';

const source = path.resolve(process.argv[2] ?? ''),
	out = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node tools/dps-experiments/class_racial_probe.mjs study-directory new-output-directory');
if (fs.existsSync(out)) throw new Error('Use a new output directory.');
for (const dir of ['requests', 'results', 'stats']) fs.mkdirSync(path.join(out, dir), { recursive: true });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const provenance = read(path.join(source, 'provenance.json'));
const rows = read(path.join(source, 'cells.json')).filter(
	row => ['preflight', 'resolved-preflight'].includes(row.phase) && ['RaceNightElf', 'RaceDwarf'].includes(row.race) && row.className === 'Priest',
);
const jobs = [],
	inputs = [],
	iterations = 1000,
	seed = 6026102801;
for (const row of rows)
	for (const duration of [60, 180, 300])
		for (const variant of ['baseline', 'damage-dpet']) {
			const q = read(path.join(source, 'requests', row.key + '.json'));
			q.encounter.duration = duration;
			q.simOptions.iterations = iterations;
			q.simOptions.randomSeed = String(seed);
			const player = q.raid.parties[0].players[0],
				filler = row.profileId.includes('smite') ? 10934 : 18807;
			const metadata = read(path.join(source, 'stats', row.key + '.json')).raidStats.parties[0].players[0].metadata;
			const racialId = row.race === 'RaceNightElf' ? 19305 : 1277335;
			if (![racialId, filler].every(id => metadata.spells.some(s => s.id.spellId === id)))
				throw new Error(`Required racial or filler is absent: ${row.key}`);
			if (variant === 'damage-dpet')
				q.raid.parties[0].players[0] = prepareRobustPlayer(player, {
					race: row.race,
					className: row.className,
					gear: { equipment: player.equipment },
					classRacial: variant,
				}).player;
			const key = variant + '--' + hash(signature([row.key, duration])).slice(0, 20),
				input = path.join(out, 'requests', key + '.json');
			fs.writeFileSync(input, JSON.stringify(q));
			jobs.push({ key, request: input, result: path.join(out, 'results', key + '.json'), stats: path.join(out, 'stats', key + '.json') });
			inputs.push({
				key,
				sourceKey: row.key,
				profileId: row.profileId,
				race: row.race,
				racialId,
				support: row.support,
				referencePolicy: row.phase === 'preflight' ? 'developer' : 'explicit',
				setId: row.setId,
				duration,
				variant,
				requestSha256: hash(fs.readFileSync(input)),
			});
		}
fs.writeFileSync(path.join(out, 'jobs.json'), JSON.stringify(jobs));
const batch = path.join(source, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch');
if (hash(fs.readFileSync(batch)) !== provenance.engineSha256) throw new Error('The archived batch driver hash changed.');
execFileSync(batch, [path.join(out, 'jobs.json'), '2'], { stdio: 'inherit' });
const resultRows = inputs.map(row => {
	const raw = read(path.join(out, 'results', row.key + '.json'));
	const actions = raw.raidMetrics.parties[0].players[0].actions;
	return {
		...row,
		...summarizeResult(raw, iterations),
		classRacialCasts: actions.filter(a => a.id.spellId === row.racialId).reduce((s, a) => s + a.targets.reduce((t, v) => t + v.casts, 0), 0) / iterations,
		resultSha256: hash(fs.readFileSync(path.join(out, 'results', row.key + '.json'))),
	};
});
const comparisons = resultRows
	.filter(row => row.variant === 'damage-dpet')
	.map(row => {
		const base = resultRows.find(b => b.variant === 'baseline' && b.sourceKey === row.sourceKey && b.duration === row.duration);
		const values = r => read(path.join(out, 'results', r.key + '.json')).raidMetrics.parties[0].players[0].dps.allValues;
		const same = signature(values(row)) === signature(values(base));
		if (row.classRacialCasts === 0 && !same) throw new Error(`A non-casting racial action changed results: ${row.key}`);
		return {
			profileId: row.profileId,
			race: row.race,
			setId: row.setId,
			support: row.support,
			referencePolicy: row.referencePolicy,
			duration: row.duration,
			classRacialCasts: row.classRacialCasts,
			exactIterationAgreement: same,
			...sampleComparison(values(row), values(base)),
			baselineKey: base.key,
			probeKey: row.key,
		};
	});
fs.writeFileSync(
	path.join(out, 'analysis.json'),
	JSON.stringify(
		{
			sourceCommit: provenance.sourceCommit,
			engineSha256: provenance.engineSha256,
			iterations,
			seed,
			scope: 'Optional Night Elf and Dwarf priest damage racials before the filler only when native expected damage per execution time is higher. Both Shadow and Smite, every accepted set and support/reference treatment, at 60/180/300 seconds. This tests one explicit policy, not a globally optimized rotation.',
			comparisons,
			rows: resultRows,
		},
		null,
		2,
	),
);
console.log(
	JSON.stringify({
		comparisons: comparisons.length,
		nonzeroCasts: comparisons.filter(c => c.classRacialCasts > 0).length,
		largestGainPercent: Math.max(...comparisons.map(c => c.percent)),
	}),
);
