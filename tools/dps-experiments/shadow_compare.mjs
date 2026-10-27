import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadProfiles } from './export.mjs';
import { hash, signature } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { translateRequest, expandRotation, statIndexes } from './shadow_translation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2),
	option = (name, fallback) => (args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : fallback);
if (args.includes('--help')) {
	console.log(
		'Usage: node tools/dps-experiments/shadow_compare.mjs --primary-run directory --gunba-source directory [--out directory] [--iterations 20000] [--durations 60,180,300] [--resume]',
	);
	process.exit(0);
}
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--resume') continue;
	assert(
		['--primary-run', '--gunba-source', '--out', '--iterations', '--durations'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
		'Unknown or incomplete option: ' + args[i],
	);
	i++;
}
const primary = path.resolve(root, option('primary-run', 'tmp/racial-experiments/2026-10-27-both-final'));
const source = path.resolve(root, option('gunba-source', 'tmp/engine-comparisons/gunba'));
const out = path.resolve(root, option('out', 'tmp/engine-comparisons/' + new Date().toISOString().replace(/[:.]/g, '-')));
const iterations = Number(option('iterations', 20000)),
	durations = option('durations', '60,180,300').split(',').map(Number);
assert(Number.isSafeInteger(iterations) && iterations > 1 && durations.every(x => x > 0 && Number.isFinite(x)), 'Invalid sampling.');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2));
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const old = read(path.join(primary, 'provenance.json'));
const primaryExe = path.join(primary, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim');
assert.equal(hash(fs.readFileSync(primaryExe)), old.engine.sha256, 'Primary binary differs from its provenance.');
const tracked = old.sourceFiles;
for (const [file, expected] of Object.entries(tracked))
	assert.equal(hash(fs.readFileSync(path.join(root, file))), expected, 'Primary simulator source differs: ' + file);
const revision = run('git', ['rev-parse', 'HEAD'], source).trim();
assert.equal(revision, '92120c303d5ef4c4d4840df19818a65f8acb40b3', 'Review and pin a changed Gunba source before comparing.');
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], source).trim(), '', 'Gunba source must be clean.');
assert(!fs.existsSync(out) || args.includes('--resume'), 'Output exists; use --resume for an identical comparison.');
fs.mkdirSync(out, { recursive: true });
for (const folder of ['engine', 'requests', 'results', 'stats', 'logs']) fs.mkdirSync(path.join(out, folder), { recursive: true });
const toolFiles = [
	'shadow_compare.mjs',
	'shadow_translation.mjs',
	'gunba_driver.go.txt',
	'stats/main.go',
	'export_profiles.mts',
	'export.mjs',
	'statistics.mjs',
	'racial_helpers.mjs',
];
const toolHashes = Object.fromEntries(toolFiles.map(f => [f, hash(fs.readFileSync(path.join(root, 'tools/dps-experiments', f)))]));
const generated = Object.fromEntries(
	fs
		.readdirSync(path.join(source, 'sim/core/proto'))
		.filter(f => f.endsWith('.pb.go'))
		.sort()
		.map(f => [f, hash(fs.readFileSync(path.join(source, 'sim/core/proto', f)))]),
);
assert(Object.keys(generated).length > 0, 'Prepare the pinned Gunba checkout first.');
const settings = {
	iterations,
	durations,
	seed: 2026102707,
	primaryEngine: old.engine.sha256,
	primarySource: old.snapshot.upstreamSourceCommit,
	gunbaRevision: revision,
	gunbaGenerated: generated,
	goVersion: run(go, ['version']).trim(),
	toolHashes,
};
const fingerprint = hash(signature(settings));
let previous;
const resumableKeys = new Set();
if (args.includes('--resume')) {
	previous = read(path.join(out, 'provenance.json'));
	assert.equal(previous.fingerprint, fingerprint, 'Comparison settings or tools changed.');
	for (const row of read(path.join(out, 'results.json')).rows) {
		assert.equal(hash(fs.readFileSync(path.join(out, 'requests', row.key + '.json'))), row.requestSha256, 'Saved request changed: ' + row.key);
		assert.equal(hash(fs.readFileSync(path.join(out, 'results', row.key + '.json'))), row.resultSha256, 'Saved result changed: ' + row.key);
		resumableKeys.add(row.key);
	}
}
write('provenance.json', {
	fingerprint,
	settings,
	startedAt: new Date().toISOString(),
	gearPolicy: 'Unchanged WoWSims developer equipment IDs. Rolled suffix stats are resolved by WoWSims and embedded in the Gunba request.',
	assumptions: [
		'No synthetic gear selection or forced Tier 1.',
		'Named talents are translated by declaration order, not copied as a string.',
		'Variables are expanded with hidden actions removed. WoWSims equivalence controls verify the normalized rotation.',
		'Elixir of Sages Spirit is represented by 25 bonus Spirit; its shared crit is supplied by Owl. Greater Mageblood is represented by Mageblood plus 8 MP5.',
		'Gunba uses the WoWSims flat Revelation chance with exponent zero, an explicit provisional model.',
		'Gunba enters Shadowform at -60 seconds to replenish its prepull cost.',
		'Salvation is absent from Gunba support; this comparison has no threat-limited rotation.',
		'Per-engine paired racial errors are valid; cross-engine DPS errors are independent.',
	],
});
write('primary-provenance.json', old);
const statsExe = path.join(out, 'engine', process.platform === 'win32' ? 'stats.exe' : 'stats');
run(go, ['build', '-tags=with_db', '-buildvcs=false', '-o', statsExe, './tools/dps-experiments/stats']);
const driver = path.join(out, 'engine', 'gunba_driver.go');
fs.copyFileSync(path.join(root, 'tools/dps-experiments/gunba_driver.go.txt'), driver);
const gunba = path.join(out, 'engine', process.platform === 'win32' ? 'gunba.exe' : 'gunba');
if (!fs.existsSync(path.join(source, 'sim/core/proto/api.pb.go')))
	throw new Error('Generate Gunba Go protos in its temporary checkout before running. See README.');
run(go, ['build', '-buildvcs=false', '-o', gunba, driver], source);
const binaryHashes = { primary: hash(fs.readFileSync(primaryExe)), gunba: hash(fs.readFileSync(gunba)), stats: hash(fs.readFileSync(statsExe)) };
fs.copyFileSync(primaryExe, path.join(out, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim'));
if (previous?.binaryHashes) assert.deepEqual(binaryHashes, previous.binaryHashes, 'Rebuilt comparison binaries differ.');
const provenance = read(path.join(out, 'provenance.json'));
provenance.binaryHashes = binaryHashes;
write('provenance.json', provenance);
const loaded = await loadProfiles(root),
	profile = loaded.profiles.find(x => x.id === 'priest-dps-shadow-testing');
assert(profile?.talentAllocation?.length, 'Missing Shadow developer talent allocation.');
const catalog = read(path.join(primary, 'profiles.json'));
const primaryCells = new Map(read(path.join(primary, 'cells.json')).map(row => [row.key, row]));
const saved = catalog.profiles.find(x => x.id === profile.id && x.faction === 'alliance');
assert.equal(saved.player.talentsString, profile.player.talentsString, 'Developer talents changed since primary run.');
const rows = [];
const calibrations = [];
const primaryIndexes = statIndexes(fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8'));
const primaryPseudo = statIndexes(fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8'), 'PseudoStat');
const gunbaIndexes = statIndexes(fs.readFileSync(path.join(source, 'proto/common.proto'), 'utf8'));
for (const duration of durations)
	for (const race of ['RaceHuman', 'RaceDwarf']) {
		const originalKey = ['alliance', profile.id, race, duration + 's', 'developer'].join('--');
		assert.equal(
			hash(fs.readFileSync(path.join(primary, 'requests', originalKey + '.json'))),
			primaryCells.get(originalKey)?.requestSha256,
			'Primary request differs from its recorded hash.',
		);
		const original = read(path.join(primary, 'requests', originalKey + '.json'));
		original.simOptions.iterations = iterations;
		original.simOptions.randomSeed = String(settings.seed);
		const resolvedPath = path.join(out, 'stats', 'equipment.json');
		const originalPath = path.join(out, 'requests', originalKey + '--original.json');
		fs.writeFileSync(originalPath, JSON.stringify(original));
		run(statsExe, [originalPath, resolvedPath, 'equipment']);
		const resolved = read(resolvedPath);
		const revelation = resolved.flatMap(x => x.enchantEffects ?? []).find(x => x.buff_id === 1248806)?.Effect?.Proc?.ProcRate?.ProcChance;
		assert(Number.isFinite(revelation) && revelation > 0, 'Unknown Revelation proc model.');
		const translated = translateRequest(original, { allocation: profile.talentAllocation, resolved, source, revelationChance: revelation });
		const normalized = structuredClone(original);
		normalized.raid.parties[0].players[0].rotation = expandRotation(normalized.raid.parties[0].players[0].rotation);
		const ourStatsFile = path.join(out, 'stats', 'calibration-primary.json');
		run(statsExe, [originalPath, ourStatsFile]);
		const targetFinal = read(ourStatsFile).raidStats.parties[0].players[0].finalStats;
		const targetStats = targetFinal.stats;
		const calibrated = structuredClone(translated),
			changes = [];
		const compute = q => {
			const input = path.join(out, 'stats', 'calibration-request.json'),
				output = path.join(out, 'stats', 'calibration-result.json');
			fs.writeFileSync(input, JSON.stringify(q));
			run(gunba, ['stats', input, output], source);
			return read(output).raidStats.parties[0].players[0].finalStats.stats;
		};
		const before = compute(calibrated);
		for (const name of ['Stamina', 'Intellect', 'Spirit', 'MP5', 'Health', 'Mana']) {
			const index = gunbaIndexes[name],
				target = targetStats[primaryIndexes[name]],
				current = compute(calibrated)[index];
			if (Math.abs(current - target) < 1e-8) continue;
			const probe = structuredClone(calibrated);
			probe.raid.parties[0].players[0].bonusStats.stats[index] += 1;
			const derivative = compute(probe)[index] - current;
			assert(derivative > 0, 'Cannot calibrate ' + name);
			const delta = (target - current) / derivative;
			calibrated.raid.parties[0].players[0].bonusStats.stats[index] += delta;
			changes.push({ name, target, before: current, bonusStatDelta: delta });
		}
		const after = compute(calibrated);
		for (const name of ['Intellect', 'Spirit', 'MP5', 'Mana', 'Health', 'Stamina'])
			assert(Math.abs(after[gunbaIndexes[name]] - targetStats[primaryIndexes[name]]) < 1e-6, 'Resource stat calibration failed: ' + name);
		assert(
			Math.abs(after[gunbaIndexes.SpellPower] + after[gunbaIndexes.SpellDamage] - targetStats[primaryIndexes.SpellDamage]) < 1e-6,
			'Translated spell damage differs.',
		);
		assert(Math.abs(after[gunbaIndexes.ShadowPower] - targetStats[primaryIndexes.ShadowDamage]) < 1e-6, 'Translated Shadow damage differs.');
		assert(Math.abs(after[gunbaIndexes.SpellCrit] - targetFinal.pseudoStats[primaryPseudo.SpellCritPercent]) < 1e-6, 'Translated spell crit differs.');
		assert(
			Math.abs(
				after[gunbaIndexes.SpellHit] +
					profile.talentAllocation.find(x => x.field === 'shadowFocus').points -
					targetFinal.pseudoStats[primaryPseudo.SchoolHitPercentShadow],
			) < 1e-6,
			'Translated Shadow hit differs.',
		);
		assert.deepEqual(calibrated.raid.parties[0].players[0].equipment, translated.raid.parties[0].players[0].equipment, 'Calibration changed equipment.');
		calibrations.push({
			race,
			duration,
			before,
			after,
			changes,
			scope: 'Non-gear resource and attribute calibration. Equipment and named talents unchanged.',
		});
		write('stat-calibration.json', calibrations);
		for (const [engine, q] of [
			['wowsims', normalized],
			['gunba', translated],
			['gunba-resource-control', calibrated],
			['control', original],
		]) {
			const key = [engine, race, duration + 's'].join('--');
			const infile = path.join(out, 'requests', key + '.json'),
				outfile = path.join(out, 'results', key + '.json');
			fs.writeFileSync(infile, JSON.stringify(q));
			if (!resumableKeys.has(key)) {
				const stdout = engine.startsWith('gunba')
					? run(gunba, ['sim', infile, outfile], source)
					: run(path.join(primary, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim'), [
							'sim',
							'--infile',
							infile,
							'--outfile',
							outfile,
						]);
				fs.writeFileSync(path.join(out, 'logs', key + '.log'), stdout);
			}
			const raw = read(outfile),
				summary = summarizeResult(raw, iterations);
			rows.push({ engine, race, duration, key, ...summary, requestSha256: hash(fs.readFileSync(infile)), resultSha256: hash(fs.readFileSync(outfile)) });
			if (engine !== 'control') {
				const statsFile = path.join(out, 'stats', key + '.json');
				if (engine.startsWith('gunba')) run(gunba, ['stats', infile, statsFile], source);
				else run(statsExe, [infile, statsFile]);
				const stats = read(statsFile);
				assert(!stats.errorResult, 'Stats computation failed: ' + key);
				const warnings = JSON.stringify(stats.raidStats.parties[0].players[0].rotationStats ?? {});
				for (const warning of warnings.matchAll(/"([^"\n]*does not know spell[^"\n]*)"/g))
					assert(/SpellID: (19312|1277328|1259799|1259823)\}/.test(warning[1]), 'Unexpected missing ability: ' + warning[1]);
			}
			console.log(key + ': ' + summary.meanDps.toFixed(3));
		}
		const a = read(path.join(out, 'results', 'wowsims--' + race + '--' + duration + 's.json')).raidMetrics.parties[0].players[0].dps.allValues;
		const b = read(path.join(out, 'results', 'control--' + race + '--' + duration + 's.json')).raidMetrics.parties[0].players[0].dps.allValues;
		assert.deepEqual(a, b, 'APL normalization changes the main simulator outcome.');
		write('results.json', { rows, controls: 'Normalized WoWSims rotation equals original every iteration.' });
	}
for (const [file, expected] of Object.entries(tracked))
	assert.equal(hash(fs.readFileSync(path.join(root, file))), expected, 'Primary source changed during comparison: ' + file);
for (const [file, expected] of Object.entries(toolHashes))
	assert.equal(hash(fs.readFileSync(path.join(root, 'tools/dps-experiments', file))), expected, 'Comparison tool changed during run: ' + file);
write('completion.json', {
	completedAt: new Date().toISOString(),
	fingerprint,
	rows: rows.length,
	normalizedRotationEquivalent: true,
	primaryEngineUnchanged: hash(fs.readFileSync(primaryExe)) === settings.primaryEngine,
	gunbaBinarySha256: hash(fs.readFileSync(gunba)),
});
console.log('Matched comparison completed: ' + out);
