import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compareSamples } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { statIndexes } from './shadow_translation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2),
	options = {};
for (let i = 0; i < args.length; i += 2) {
	assert(
		['--input', '--out', '--iterations', '--seed', '--equipment'].includes(args[i]) && args[i + 1],
		'Use --input saved-request --out new-directory [--equipment equipment.json] [--iterations count] [--seed number].',
	);
	options[args[i].slice(2)] = args[i + 1];
}
assert(options.input && options.out, 'Both --input and --out are required.');
const out = path.resolve(options.out),
	iterations = Number(options.iterations ?? 20000),
	seed = Number(options.seed ?? 2026102801);
assert(!fs.existsSync(out), 'Use a new output directory.');
assert(Number.isInteger(iterations) && iterations >= 100 && Number.isSafeInteger(seed) && seed > 0);
for (const dir of ['engine', 'requests', 'results', 'stats', 'logs']) fs.mkdirSync(path.join(out, dir), { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const suffix = process.platform === 'win32' ? '.exe' : '';
const source = path.join(root, 'sim/priest/mind_flay.go');
const original = fs.readFileSync(source, 'utf8');
const marker = 'config := priest.periodicDamageSpellConfig(rank, PriestSpellMindFlay)';
assert.equal(original.split(marker).length, 2, 'The Mind Flay implementation changed; inspect the control before rerunning.');
// Only a missed application reserves extra time; the no-miss samples must remain identical.
const changed = original.replace('"math"', '"math"\n\t"time"').replace(
	marker,
	marker +
		`
	apply := config.ApplyEffects
	config.ApplyEffects = func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
		apply(sim, target, spell)
		if !spell.Dot(target).IsActive() {
			priest.SetGCDTimer(sim, sim.CurrentTime+priest.ApplyCastSpeed(config.Dot.TickLength*time.Duration(config.Dot.NumberOfTicks)))
		}
	}`,
);
const replacement = path.join(out, 'engine/mind_flay.fixed_occupancy.go');
fs.writeFileSync(replacement, changed);
const overlay = path.join(out, 'engine/overlay.json');
fs.writeFileSync(overlay, JSON.stringify({ Replace: { [source]: replacement } }, null, 2));
const modes = ['upstream', 'fixed-channel-occupancy'];
const binaries = {};
for (const mode of modes) {
	const binary = path.join(out, 'engine', mode + suffix);
	run(go, [
		'build',
		'-tags=with_db',
		'-buildvcs=false',
		'-trimpath',
		...(mode === 'upstream' ? [] : ['-overlay', overlay]),
		'-o',
		binary,
		'./tools/dps-experiments/robust-sim',
	]);
	binaries[mode] = binary;
}
const base = read(path.resolve(options.input));
const buildFile = path.join(root, 'ui/specs/priest/dps/builds/testing.build.json');
base.raid.parties[0].players[0].equipment = options.equipment ? read(path.resolve(options.equipment)) : read(buildFile).player.equipment;
base.encounter.duration = 180;
base.encounter.durationVariation = 0;
base.simOptions = { ...base.simOptions, iterations, randomSeed: String(seed), saveAllValues: true, useLabeledRands: true };
const jobs = [],
	cases = [];
const protoSource = fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8');
const stat = statIndexes(protoSource),
	pseudo = statIndexes(protoSource, 'PseudoStat');
const statCount = Math.max(...Object.values(stat)) + 1;
const conversionSource = fs.readFileSync(path.join(root, 'sim/core/base_stats_auto_gen.go'), 'utf8');
const rating = name => Number(conversionSource.match(new RegExp('const ' + name + ' = ([0-9.]+)'))?.[1]);
const hitRating = rating('HitRatingPerHitPercent'),
	critRating = rating('CritRatingPerCritPercent');
assert(hitRating > 0 && critRating > 0, 'Missing native rating conversions.');
for (const mode of modes)
	for (const rotation of ['developer', 'mind-flay-only'])
		for (const variant of ['human', 'dwarf', 'human-plus-hit', 'human-plus-crit', 'human-hit-capped']) {
			const request = structuredClone(base),
				player = request.raid.parties[0].players[0];
			player.race = variant === 'dwarf' ? 'RaceDwarf' : 'RaceHuman';
			player.bonusStats ??= {};
			player.bonusStats.stats ??= Array(statCount).fill(0);
			while (player.bonusStats.stats.length < statCount) player.bonusStats.stats.push(0);
			if (variant === 'human-plus-hit') player.bonusStats.stats[stat.HitRating] += hitRating;
			if (variant === 'human-plus-crit') player.bonusStats.stats[stat.CritRating] += critRating;
			if (variant === 'human-hit-capped') player.bonusStats.stats[stat.HitRating] += 50 * hitRating;
			if (rotation === 'mind-flay-only') {
				player.bonusStats.stats[stat.MP5] += 5000;
				player.rotation = {
					type: 'TypeAPL',
					prepullActions: [],
					priorityList: [
						{
							action: {
								condition: { not: { val: { auraIsActive: { auraId: { spellId: 15473 } } } } },
								castSpell: { spellId: { spellId: 15473 } },
							},
						},
						{ action: { castSpell: { spellId: { spellId: 18807 } } } },
					],
				};
			}
			const key = [mode, rotation, variant].join('--');
			const input = path.join(out, 'requests', key + '.json'),
				result = path.join(out, 'results', key + '.json'),
				stats = path.join(out, 'stats', key + '.json');
			fs.writeFileSync(input, JSON.stringify(request));
			jobs.push({ key, request: input, result, stats });
			cases.push({ key, mode, rotation, variant, requestSha256: hash(fs.readFileSync(input)) });
		}
for (const mode of modes) {
	const file = mode + '.jobs.json';
	write(
		file,
		jobs.filter(j => j.key.startsWith(mode + '--')),
	);
	console.log(run(binaries[mode], [path.join(out, file), '4']));
}
const rows = cases.map(item => {
	const job = jobs.find(j => j.key === item.key),
		result = read(job.result),
		stats = read(job.stats);
	const summary = summarizeResult(result, iterations),
		ids = new Set(result.encounterMetrics.targets.map(t => t.unitIndex));
	const flay = result.raidMetrics.parties[0].players[0].actions.find(a => a.id.spellId === 18807)?.targets.find(t => ids.has(t.unitIndex));
	const sheet = stats.raidStats.parties[0].players[0].finalStats;
	return {
		...item,
		resultSha256: hash(fs.readFileSync(job.result)),
		statsSha256: hash(fs.readFileSync(job.stats)),
		meanDps: summary.meanDps,
		secondsOom: summary.secondsOomAvg,
		shadowHit: sheet.pseudoStats[pseudo.SchoolHitPercentShadow],
		spellCrit: sheet.pseudoStats[pseudo.SpellCritPercent],
		flay: flay ? { casts: flay.casts / iterations, misses: flay.misses / iterations, castTimeMs: flay.castTimeMs / iterations } : null,
	};
});
const comparisons = [];
for (const mode of modes)
	for (const rotation of ['developer', 'mind-flay-only']) {
		const selected = rows.filter(r => r.mode === mode && r.rotation === rotation),
			human = selected.find(r => r.variant === 'human');
		const values = row => read(path.join(out, 'results', row.key + '.json')).raidMetrics.parties[0].players[0].dps.allValues;
		for (const variant of ['dwarf', 'human-plus-hit', 'human-plus-crit']) {
			const candidate = selected.find(r => r.variant === variant);
			comparisons.push({ mode, rotation, comparison: variant + ' versus human', ...compareSamples(values(candidate), values(human)) });
		}
	}
for (const rotation of ['developer', 'mind-flay-only']) {
	const selected = rows.filter(r => r.rotation === rotation && r.variant === 'human-hit-capped');
	assert(
		selected.every(r => r.flay.misses === 0),
		'The hit-capped control still missed.',
	);
	const values = row => read(path.join(out, 'results', row.key + '.json')).raidMetrics.parties[0].players[0].dps.allValues;
	assert.deepEqual(values(selected[0]), values(selected[1]), 'The control changed a condition with no missed channels.');
}
for (const mode of modes)
	for (const rotation of ['developer', 'mind-flay-only']) {
		const selected = rows.filter(r => r.mode === mode && r.rotation === rotation),
			human = selected.find(r => r.variant === 'human');
		assert(Math.abs(selected.find(r => r.variant === 'human-plus-hit').shadowHit - human.shadowHit - 1) < 1e-9);
		assert(Math.abs(selected.find(r => r.variant === 'human-plus-crit').spellCrit - human.spellCrit - 1) < 1e-9);
	}
write('results.json', { rows, comparisons, controls: { noMissSamplesIdentical: true, bonusHitPercent: 1, bonusCritPercent: 1 } });
write('provenance.json', {
	createdAt: new Date().toISOString(),
	head: run('git', ['rev-parse', 'HEAD']).trim(),
	upstream: run('git', ['rev-parse', 'origin/master']).trim(),
	status: run('git', ['status', '--porcelain']),
	diffSha256: hash(run('git', ['diff', 'HEAD'])),
	gameInputsSha256: hash(fs.readFileSync(path.join(root, 'assets/db_inputs/spell_store_inputs.json'))),
	nativeSourceSha256: hash(original),
	controlSourceSha256: hash(changed),
	binaries: Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, hash(fs.readFileSync(v))])),
	inputSourceSha256: hash(fs.readFileSync(path.resolve(options.input))),
	developerGearSha256: hash(fs.readFileSync(buildFile)),
	equipmentSha256: hash(JSON.stringify(base.raid.parties[0].players[0].equipment)),
	equipmentSource: options.equipment ?? path.relative(root, buildFile),
	iterations,
	seed,
	duration: 180,
	scope: 'Focused mechanism diagnostic, not a race recommendation. Full-support saved encounter and rotation with the explicitly selected equipment. The isolated channel uses extra MP5 to exclude OOM. The counterfactual reserves a full channel duration even on a missed application; it is not a correction to the primary simulator or a claim about Finsemble source.',
});
assert.equal(fs.readFileSync(source, 'utf8'), original, 'A primary simulator source file changed.');
console.log(JSON.stringify({ comparisons, output: out }, null, 2));
