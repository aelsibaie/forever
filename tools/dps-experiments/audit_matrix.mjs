import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectRotation, guardedManaRacial } from './audit_logic.mjs';
import { hash } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2),
	get = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
if (args.includes('--help')) {
	console.log('node tools/dps-experiments/audit_matrix.mjs --run racial-archive --out new-directory [--control-iterations 250] [--variants] [--resume]');
	process.exit(0);
}
const source = path.resolve(get('--run', 'tmp/analytics-runs/2026-10-27-14e5ca6ca4/racials')),
	out = path.resolve(get('--out', 'tmp/audit-matrix/' + new Date().toISOString().replaceAll(':', '-')));
assert(!fs.existsSync(out) || args.includes('--resume'), 'Choose a new audit directory or resume.');
for (const d of ['requests', 'results', 'stats', 'logs']) fs.mkdirSync(path.join(out, d), { recursive: true });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
const original = read(path.join(source, 'provenance.json')),
	catalog = read(path.join(source, 'profiles.json')),
	cells = read(path.join(source, 'cells.json'));
const engine = path.join(source, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim');
assert.equal(hash(fs.readFileSync(engine)), original.engine.sha256);
const settings = {
	sourceEngine: original.engine.sha256,
	controlIterations: Number(get('--control-iterations', 250)),
	variantIterations: 5000,
	sourceCommit: original.snapshot.upstreamSourceCommit,
	analyticsCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
	tools: Object.fromEntries(['audit_matrix.mjs', 'audit_logic.mjs'].map(f => [f, hash(fs.readFileSync(path.join(root, 'tools/dps-experiments', f)))])),
};
save('provenance.json', {
	settings,
	cacheValidation: args.includes('--resume') ? 'Every reused cell requires identical request bytes, native engine hash and saved result hash.' : null,
	sourceProvenance: original,
	gearPolicy: 'Developer reference retained; explicit sensitivity variants may add a missing caster weapon enchant. No optimal-gear claim.',
});
const profiles = [],
	controls = [],
	variants = [];
const cellIndex = fs.existsSync(path.join(out, 'cell-index.json')) ? read(path.join(out, 'cell-index.json')) : {};
const simulate = (key, q) => {
	const input = path.join(out, 'requests', key + '.json'),
		output = path.join(out, 'results', key + '.json');
	const bytes = JSON.stringify(q),
		previous = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : null;
	if (args.includes('--resume') && previous !== null) assert.equal(previous, bytes, 'Changed audit input requires a new directory.');
	const cached = cellIndex[key];
	if (args.includes('--resume') && cached) {
		assert.equal(cached.engineSha256, settings.sourceEngine);
		assert.equal(cached.requestSha256, hash(Buffer.from(bytes)));
		assert.equal(hash(fs.readFileSync(output)), cached.resultSha256, 'Changed saved audit result.');
	}
	if (!args.includes('--resume') || !cached) {
		fs.writeFileSync(input, bytes);
		const log = execFileSync(engine, ['sim', '--infile', input, '--outfile', output], {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 1024 * 1024 * 8,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		fs.writeFileSync(path.join(out, 'logs', key + '.log'), log);
	}
	cellIndex[key] = { engineSha256: settings.sourceEngine, requestSha256: hash(fs.readFileSync(input)), resultSha256: hash(fs.readFileSync(output)) };
	save('cell-index.json', cellIndex);
	const raw = read(output);
	return {
		raw,
		summary: summarizeResult(raw, q.simOptions.iterations),
		requestSha256: hash(fs.readFileSync(input)),
		resultSha256: hash(fs.readFileSync(output)),
	};
};
for (const profile of catalog.profiles) {
	const evidence = {
		id: profile.id,
		faction: profile.faction,
		className: profile.className,
		name: profile.name,
		gear: profile.gearName,
		races: [],
		findings: [],
		manaCases: [],
		gearGaps: [],
		controls: [],
		variants: [],
	};
	const raceRows = cells.filter(r => r.profileId === profile.id && r.faction === profile.faction && r.duration === 180 && r.key.endsWith('--developer'));
	for (const row of raceRows) {
		const statName = fs.readdirSync(path.join(source, 'stats')).find(f => f.includes(profile.id + '--' + row.race + '--'));
		assert(statName, 'Missing race-specific native stats.');
		const stats = read(path.join(source, 'stats', statName)),
			q = read(path.join(source, 'requests', row.key + '.json'));
		assert.equal(hash(fs.readFileSync(path.join(source, 'requests', row.key + '.json'))), row.requestSha256);
		const inspection = inspectRotation(q.raid.parties[0].players[0], stats);
		evidence.races.push(row.race);
		evidence.findings.push(...inspection.findings.map(f => ({ ...f, race: row.race })));
		for (const c of cells.filter(c => c.profileId === profile.id && c.faction === profile.faction && c.race === row.race && c.key.endsWith('--developer')))
			if (c.secondsOomAvg > c.duration * 0.05) evidence.manaCases.push({ race: row.race, duration: c.duration, secondsOom: c.secondsOomAvg });
		if (inspection.replacements.length) {
			const control = structuredClone(q);
			control.simOptions.iterations = settings.controlIterations;
			const changed = structuredClone(control);
			changed.raid.parties[0].players[0].rotation = inspection.rotation;
			const key = profile.faction + '--' + profile.id + '--' + row.race;
			const a = simulate(key + '--control', control),
				b = simulate(key + '--known-guards', changed);
			const equal =
				JSON.stringify(a.raw.raidMetrics.parties[0].players[0].dps.allValues) === JSON.stringify(b.raw.raidMetrics.parties[0].players[0].dps.allValues);
			const result = {
				profileId: profile.id,
				faction: profile.faction,
				race: row.race,
				replacedConditions: inspection.replacements.length,
				equivalent: equal,
				iterations: settings.controlIterations,
				original: a.summary.meanDps,
				changed: b.summary.meanDps,
			};
			controls.push(result);
			evidence.controls.push(result);
		}
		const player = q.raid.parties[0].players[0],
			weapon = player.equipment.items[14];
		if (
			!weapon.enchant &&
			['Mage', 'Warlock', 'Priest', 'Druid', 'Shaman', 'Paladin'].includes(profile.className) &&
			!/(feral|enhancement)/.test(profile.id)
		)
			evidence.gearGaps.push({ race: row.race, slot: 'Main hand', kind: 'Missing permanent enchant' });
		if (!args.includes('--variants')) continue;
		const proposals = [];
		if (row.race === 'RaceHighOrderSkyborne' && evidence.manaCases.some(c => c.race === row.race))
			proposals.push(['read-leyline', guardedManaRacial(player)]);
		if (evidence.gearGaps.some(g => g.race === row.race)) {
			const p = structuredClone(player);
			p.equipment.items[14].enchant = 8217;
			proposals.push(['revelation-enchant', p]);
		}
		for (const [kind, p] of proposals)
			for (const duration of [60, 180, 300]) {
				const baseline = cells.find(
					c =>
						c.profileId === profile.id &&
						c.faction === profile.faction &&
						c.race === row.race &&
						c.duration === duration &&
						c.key.endsWith('--developer'),
				);
				assert.equal(hash(fs.readFileSync(path.join(source, 'requests', baseline.key + '.json'))), baseline.requestSha256);
				assert.equal(hash(fs.readFileSync(path.join(source, 'results', baseline.key + '.json'))), baseline.resultSha256);
				const request = read(path.join(source, 'requests', baseline.key + '.json'));
				if (kind === 'read-leyline') request.raid.parties[0].players[0] = guardedManaRacial(request.raid.parties[0].players[0]);
				else request.raid.parties[0].players[0].equipment.items[14].enchant = 8217;
				const key = [profile.faction, profile.id, row.race, duration + 's', kind].join('--'),
					result = simulate(key, request);
				const reference = read(path.join(source, 'results', baseline.key + '.json'));
				const a = result.raw.raidMetrics.parties[0].players[0].dps.allValues,
					b = reference.raidMetrics.parties[0].players[0].dps.allValues;
				assert.equal(a.length, b.length, 'Paired sensitivity samples must have the same length.');
				const differences = a.map((v, i) => v - b[i]),
					mean = differences.reduce((x, y) => x + y, 0) / differences.length,
					variance = differences.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (differences.length - 1);
				const record = {
					profileId: profile.id,
					faction: profile.faction,
					race: row.race,
					duration,
					kind,
					key,
					referenceDps: baseline.meanDps,
					changedDps: result.summary.meanDps,
					gainDps: mean,
					ci95HalfWidthDps: 1.959963984540054 * Math.sqrt(variance / differences.length),
					gainPercent: (100 * mean) / baseline.meanDps,
					iterations: request.simOptions.iterations,
					requestSha256: result.requestSha256,
					resultSha256: result.resultSha256,
					scope:
						kind === 'revelation-enchant'
							? 'Analyst sensitivity: add only missing weapon enchant 8217; provisional proc law.'
							: 'Analyst APL sensitivity: guarded mana racial at or below 65% mana; all original priorities retained.',
				};
				variants.push(record);
				evidence.variants.push(record);
				save('variants.json', variants);
			}
	}
	profiles.push(evidence);
	save('audit.json', { profiles, controls, variants, excluded: catalog.excluded, aliases: catalog.aliases, settings });
	console.log(
		profile.faction +
			' / ' +
			profile.id +
			': ' +
			evidence.races.length +
			' races, ' +
			evidence.controls.length +
			' guard controls, ' +
			evidence.variants.length +
			' variants',
	);
}
save('completion.json', {
	completedAt: new Date().toISOString(),
	profiles: profiles.length,
	controls: controls.length,
	equivalent: controls.filter(c => c.equivalent).length,
	variants: variants.length,
	settings,
});
console.log('Matrix audit complete: ' + out);
