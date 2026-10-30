import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, signature } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { sampleComparison } from './robust_logic.mjs';

const source = path.resolve(process.argv[2] ?? ''),
	out = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3])
	throw new Error('Usage: node tools/dps-experiments/hunter_ranged_probe.mjs study-directory output-directory [source-cells.json]');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const provenance = read(path.join(source, 'provenance.json'));
const engine = path.join(source, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch');
if (hash(fs.readFileSync(engine)) !== provenance.engineSha256) throw new Error('The native engine changed.');
const rows = read(process.argv[4] ? path.resolve(process.argv[4]) : path.join(source, 'cells.json')).filter(
	row => row.phase === 'validation' && row.profileId === 'hunter-dps-sv-melee',
);
if (!rows.length) throw new Error('The melee Hunter validation cases are missing.');
for (const directory of ['requests', 'results']) fs.mkdirSync(path.join(out, directory), { recursive: true });
const probeProvenance = path.join(out, 'probe-provenance.json');
if (fs.existsSync(probeProvenance) && read(probeProvenance).engineSha256 !== provenance.engineSha256)
	throw new Error('The cached controls belong to another engine.');
if (!fs.existsSync(probeProvenance) && fs.readdirSync(path.join(out, 'results')).length)
	throw new Error('Existing controls need their original engine provenance before reuse.');
fs.writeFileSync(
	probeProvenance,
	JSON.stringify({
		engineSha256: provenance.engineSha256,
		seed: 7026102801,
		iterations: 1000,
		scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
	}),
);
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(out, 'tool-source.mjs'));
const inputCache = new Map();
for (const file of fs.readdirSync(path.join(out, 'requests')).filter(file => file.endsWith('.json'))) {
	const result = path.join(out, 'results', file);
	if (fs.existsSync(result)) inputCache.set(hash(fs.readFileSync(path.join(out, 'requests', file))), result);
}
const cases = [],
	jobs = [],
	iterations = 1000,
	seed = 7026102801;
for (const row of rows)
	for (const variant of ['zero', 'ammo-only', 'quiver-only', 'maximum']) {
		const inputFile = path.join(source, 'requests', row.key + '.json');
		const bytes = fs.readFileSync(inputFile),
			q = JSON.parse(bytes);
		if (hash(bytes) !== row.requestSha256) throw new Error(`Source request changed: ${row.key}`);
		q.simOptions.iterations = iterations;
		q.simOptions.randomSeed = String(seed);
		const options = q.raid.parties[0].players[0].hunter.options.classOptions;
		options.ammo = ['ammo-only', 'maximum'].includes(variant) ? 'SwiftfeatherArrow' : 'AmmoNone';
		options.quiverBonus = ['quiver-only', 'maximum'].includes(variant) ? 'AncientSinewWrappedLamina' : 'QuiverNone';
		const key = variant + '--' + hash(row.key).slice(0, 24),
			request = path.join(out, 'requests', key + '.json');
		const serialized = JSON.stringify(q),
			requestSha256 = hash(serialized);
		if (fs.existsSync(request) && hash(fs.readFileSync(request)) !== requestSha256) throw new Error(`Probe request changed: ${key}`);
		fs.writeFileSync(request, serialized);
		const result = path.join(out, 'results', key + '.json');
		if (!fs.existsSync(result) && inputCache.has(requestSha256)) fs.copyFileSync(inputCache.get(requestSha256), result);
		if (!fs.existsSync(result)) jobs.push({ key, request, result });
		cases.push({
			key,
			sourceKey: row.key,
			sourceRequestSha256: row.requestSha256,
			requestSha256,
			variant,
			faction: row.faction,
			race: row.race,
			setId: row.setId,
			duration: row.duration,
			support: row.support,
			referencePolicy: row.referencePolicy,
		});
	}
const existing = path.join(out, 'analysis.json');
if (fs.existsSync(existing) && read(existing).engineSha256 !== provenance.engineSha256) throw new Error('The probe belongs to a different engine.');
fs.writeFileSync(path.join(out, 'jobs.json'), JSON.stringify(jobs));
if (jobs.length) execFileSync(engine, [path.join(out, 'jobs.json'), '4'], { stdio: 'inherit' });
const values = new Map();
for (const row of cases) {
	const file = path.join(out, 'results', row.key + '.json'),
		result = read(file);
	summarizeResult(result, iterations);
	row.resultSha256 = hash(fs.readFileSync(file));
	const player = result.raidMetrics.parties[0].players[0];
	row.autoShots =
		player.actions
			.filter(action => action.id.otherId === 'OtherActionShoot')
			.reduce((sum, action) => sum + action.targets.reduce((n, target) => n + target.casts, 0), 0) / iterations;
	values.set(row.key, player.dps.allValues);
}
const comparisons = cases
	.filter(row => row.variant !== 'zero')
	.map(row => {
		const base = cases.find(candidate => candidate.sourceKey === row.sourceKey && candidate.variant === 'zero');
		return {
			sourceKey: row.sourceKey,
			variant: row.variant,
			duration: row.duration,
			faction: row.faction,
			race: row.race,
			support: row.support,
			referencePolicy: row.referencePolicy,
			exactIterationAgreement: signature(values.get(row.key)) === signature(values.get(base.key)),
			...sampleComparison(values.get(row.key), values.get(base.key)),
		};
	});
fs.writeFileSync(
	existing,
	JSON.stringify(
		{
			passed: true,
			engineSha256: provenance.engineSha256,
			iterations,
			seed,
			scope: 'Melee Hunter ranged-input diagnostics across every validation condition. Ammo DPS and container haste change separately and together, using zero and the highest native options. These synthetic endpoints are sensitivity controls; realistic pool recommendations use source-compatible options. Source ammunition/container settings are handled explicitly; these diagnostics measure sensitivity rather than assuming zero impact.',
			cases,
			comparisons,
		},
		null,
		2,
	),
);
console.log(
	`Verified ${rows.length} melee Hunter conditions; ${comparisons.filter(row => !row.exactIterationAgreement).length} ranged-input contrasts change sampled damage.`,
);
