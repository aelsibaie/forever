import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { prepareRobustPlayer, resolveUnavailableReferences, walkObjects } from './robust_logic.mjs';
import { statIndexes } from './shadow_translation.mjs';
import { offensiveRacial, compareSamples } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
	assert(
		['--source-readiness', '--out', '--iterations', '--seed', '--profiles'].includes(args[i]) && args[i + 1],
		'Use --source-readiness directory --out new-directory [--iterations 128] [--seed number] [--profiles ids].',
	);
	options[args[i].slice(2)] = args[i + 1];
}
assert(options.out && options['source-readiness'], 'Supply readiness inputs and a new output directory.');
const out = path.resolve(options.out),
	source = path.resolve(options['source-readiness']);
assert(!fs.existsSync(out), 'Use a new output directory.');
const iterations = Number(options.iterations ?? 128),
	seed = Number(options.seed ?? 7026102801);
assert(Number.isInteger(iterations) && iterations >= 2 && Number.isSafeInteger(seed) && seed > 0);
for (const d of ['engine', 'requests', 'results', 'stats', 'snapshots', 'logs']) fs.mkdirSync(path.join(out, d), { recursive: true });
const read = f => JSON.parse(fs.readFileSync(f, 'utf8')),
	write = (f, v) => fs.writeFileSync(path.join(out, f), JSON.stringify(v, null, 2));
const hash = v => createHash('sha256').update(v).digest('hex');
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const ready = read(path.join(source, 'readiness.json'));
assert.equal(ready.databaseSha256, hash(fs.readFileSync(path.join(root, 'assets/database/db.json'))), 'Readiness item data is stale.');
assert.equal(ready.upstream, run('git', ['merge-base', 'HEAD', 'origin/master']).trim(), 'Readiness uses a different primary source.');
const selected = options.profiles?.split(',');
if (selected)
	for (const name of selected)
		assert(
			ready.rows.some(r => r.profile === name),
			'Unknown profile: ' + name,
		);
const inputs = ready.rows.filter(r => !selected || selected.includes(r.profile));
const proto = fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8'),
	stats = statIndexes(proto),
	pseudo = statIndexes(proto, 'PseudoStat');
const constants = fs.readFileSync(path.join(root, 'sim/core/base_stats_auto_gen.go'), 'utf8');
const conversion = n => Number(constants.match(new RegExp('const ' + n + ' = ([0-9.]+)'))?.[1]);
const hit = conversion('HitRatingPerHitPercent'),
	crit = conversion('CritRatingPerCritPercent');
assert(hit > 0 && crit > 0);
for (const file of [
	'mechanics_audit.mjs',
	'mechanics-snapshot/main.go',
	'robust-sim/main.go',
	'robust_logic.mjs',
	'racial_helpers.mjs',
	'shadow_translation.mjs',
	'statistics.mjs',
]) {
	const target = path.join(out, 'tooling', file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(root, 'tools/dps-experiments', file), target);
}
const variants = ['developer', 'explicit', 'resolved', 'hit1', 'crit1', 'hit50', 'crit200'];
const jobs = [],
	snapshots = [],
	cases = [];
for (const row of inputs) {
	const key = [row.faction, row.profile, row.race].join('--'),
		src = path.join(source, 'requests', key + '.json');
	assert.equal(hash(fs.readFileSync(src)), row.requestSha256, 'A source request changed.');
	const original = read(src),
		p = original.raid.parties[0].players[0];
	const className = p.class.replace('Class', '');
	const sheetFile = path.join(source, 'stats', key + '.json');
	assert.equal(hash(fs.readFileSync(sheetFile)), row.statsSha256, 'Source metadata changed.');
	const prepared = prepareRobustPlayer(p, { race: row.race, className, gear: { equipment: p.equipment }, timing: 'immediate', mana: 'leyline65-guarded' });
	const normalized = resolveUnavailableReferences(prepared.player.rotation, read(sheetFile));
	const resolved = structuredClone(prepared.player);
	resolved.rotation = normalized.rotation;
	for (const variant of variants) {
		const q = structuredClone(original);
		q.raid.parties[0].players[0] = structuredClone(variant === 'developer' ? p : variant === 'explicit' ? prepared.player : resolved);
		q.encounter.duration = 180;
		q.encounter.durationVariation = 0;
		q.simOptions = { iterations, randomSeed: String(seed), saveAllValues: true, useLabeledRands: true };
		const player = q.raid.parties[0].players[0];
		player.bonusStats ??= {};
		player.bonusStats.stats ??= [];
		while (player.bonusStats.stats.length < Math.max(...Object.values(stats)) + 1) player.bonusStats.stats.push(0);
		if (variant.startsWith('hit'))
			player.bonusStats.stats[stats.HitRating] = (player.bonusStats.stats[stats.HitRating] ?? 0) + hit * Number(variant.slice(3));
		if (variant.startsWith('crit'))
			player.bonusStats.stats[stats.CritRating] = (player.bonusStats.stats[stats.CritRating] ?? 0) + crit * Number(variant.slice(4));
		const id = key + '--' + variant,
			request = path.join(out, 'requests', id + '.json'),
			result = path.join(out, 'results', id + '.json'),
			sheet = path.join(out, 'stats', id + '.json');
		fs.writeFileSync(request, JSON.stringify(q));
		jobs.push({ key: id, request, result, stats: sheet });
		cases.push({
			...row,
			key: id,
			baseKey: key,
			className,
			variant,
			changes: variant === 'developer' ? [] : prepared.changes,
			referenceChanges: ['developer', 'explicit'].includes(variant) ? [] : normalized.changes,
			requestSha256: hash(fs.readFileSync(request)),
		});
		if (['resolved', 'hit1', 'crit1', 'hit50', 'crit200'].includes(variant))
			snapshots.push({ key: id, request, output: path.join(out, 'snapshots', id + '.json') });
	}
}
write('jobs.json', jobs);
write('snapshot-jobs.json', snapshots);
for (const [name, pkg] of [
	['batch', 'robust-sim'],
	['snapshot', 'mechanics-snapshot'],
])
	run(go, [
		'build',
		'-tags=with_db',
		'-trimpath',
		'-buildvcs=false',
		'-o',
		path.join(out, 'engine', name + (process.platform === 'win32' ? '.exe' : '')),
		'./tools/dps-experiments/' + pkg,
	]);
const execute = (binary, argv, log) => {
	const fd = fs.openSync(path.join(out, 'logs', log), 'w');
	const r = spawnSync(binary, argv, { cwd: root, stdio: ['ignore', fd, fd] });
	fs.closeSync(fd);
	return r.status;
};
const snapshotExit = execute(
	path.join(out, 'engine', process.platform === 'win32' ? 'snapshot.exe' : 'snapshot'),
	[path.join(out, 'snapshot-jobs.json')],
	'snapshots.log',
);
const simulationExit = execute(
	path.join(out, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch'),
	[path.join(out, 'jobs.json'), '6'],
	'simulations.log',
);
const rows = [],
	errors = [];
for (const item of cases) {
	const j = jobs.find(j => j.key === item.key);
	try {
		const raw = read(j.result),
			summary = summarizeResult(raw, iterations),
			sheet = read(j.stats).raidStats.parties[0].players[0],
			player = raw.raidMetrics.parties[0].players[0];
		const enemies = new Set(raw.encounterMetrics.targets.map(t => t.unitIndex));
		const metrics = a => {
			const targets = a.targets.filter(t => enemies.has(t.unitIndex));
			const sum = k => targets.reduce((n, t) => n + (t[k] ?? 0), 0);
			return {
				id: a.id,
				casts: sum('casts') / iterations,
				damage: sum('damage') / (raw.avgIterationDuration * iterations),
				hits: sum('hits'),
				crits: sum('crits'),
				ticks: sum('ticks'),
				critTicks: sum('critTicks'),
				misses: sum('misses'),
				tickMisses: sum('tickMisses'),
			};
		};
		const validations = [];
		walkObjects(sheet.rotationStats, node => {
			if (node.validation && node.logLevel !== 'Information') validations.push(node.validation);
		});
		const spell = offensiveRacial(item.race, item.className);
		const casts = id => player.actions.filter(a => a.id.spellId === id).reduce((n, a) => n + a.targets.reduce((m, t) => m + t.casts, 0), 0) / iterations;
		rows.push({
			...item,
			resultSha256: hash(fs.readFileSync(j.result)),
			statsSha256: hash(fs.readFileSync(j.stats)),
			meanDps: summary.meanDps,
			secondsOom: summary.secondsOomAvg,
			finalStats: sheet.finalStats,
			meleeCritCap: sheet.meleeCritCap,
			validations: [...new Set(validations)],
			offensiveRacial: spell ? { id: spell, casts: casts(spell) } : null,
			readLeylineCasts: item.race === 'RaceHighOrderSkyborne' ? casts(1259705) : null,
			actions: player.actions.map(metrics).filter(a => a.damage > 0 || a.misses > 0),
			pets: (player.pets ?? []).map(p => ({ name: p.name, dps: p.dps.avg, actions: p.actions.map(metrics).filter(a => a.damage > 0 || a.misses > 0) })),
		});
	} catch (error) {
		errors.push({ key: item.key, error: error.message });
	}
}
const comparisons = [],
	flags = [];
const values = r => read(path.join(out, 'results', r.key + '.json')).raidMetrics.parties[0].players[0].dps.allValues;
for (const original of inputs) {
	const baseKey = [original.faction, original.profile, original.race].join('--'),
		group = rows.filter(r => r.baseKey === baseKey),
		base = group.find(r => r.variant === 'resolved');
	if (!base) continue;
	const snapshotFile = path.join(out, 'snapshots', base.key + '.json');
	const snap = fs.existsSync(snapshotFile) ? read(snapshotFile) : null;
	for (const variant of ['developer', 'explicit', 'hit1', 'crit1', 'hit50', 'crit200']) {
		const candidate = group.find(r => r.variant === variant);
		if (candidate) comparisons.push({ baseKey, variant, ...compareSamples(values(candidate), values(base)) });
	}
	for (const [variant, name, index] of [
		['hit1', 'hit', pseudo.SpellHitPercent],
		['crit1', 'crit', pseudo.SpellCritPercent],
	]) {
		const candidate = group.find(r => r.variant === variant);
		if (candidate && Math.abs(candidate.finalStats.pseudoStats[index] - base.finalStats.pseudoStats[index] - 1) > 1e-8)
			flags.push({ baseKey, kind: 'sheet-stat-delta', stat: name });
	}
	if (base.validations.some(v => /condition.*could not be resolved|branch.*dropped/i.test(v)))
		flags.push({ baseKey, kind: 'unresolved-condition-after-normalization' });
	if (/muti/.test(original.profile) && snap) {
		const ids = new Set(snap.owner.spells.filter(s => s.rowName?.includes('Mutilate')).map(s => s.id));
		if (!base.actions.some(a => ids.has(a.id.spellId) && a.damage > 0)) flags.push({ baseKey, kind: 'mutilate-damage-not-observed' });
	}
	if (base.offensiveRacial && base.offensiveRacial.casts === 0)
		flags.push({ baseKey, kind: 'offensive-racial-not-observed', spellId: base.offensiveRacial.id });
	const hitCap = group.find(r => r.variant === 'hit50');
	if (hitCap && hitCap.actions.some(a => a.misses > 0 || a.tickMisses > 0))
		flags.push({ baseKey, kind: 'owner-miss-at-high-hit', actions: hitCap.actions.filter(a => a.misses > 0 || a.tickMisses > 0).map(a => a.id) });
	if (hitCap && hitCap.pets.some(p => p.actions.some(a => a.misses > 0 || a.tickMisses > 0))) flags.push({ baseKey, kind: 'pet-miss-at-high-hit' });
	const highCrit = group.find(r => r.variant === 'crit200');
	if (highCrit && snap) {
		for (const a of highCrit.actions) {
			const declared = snap.owner.spells.find(s => s.id === a.id.spellId && s.tag === (a.id.tag ?? 0));
			if (declared?.rowPeriodicCanCrit && a.ticks > 0 && a.critTicks === 0)
				flags.push({ baseKey, kind: 'periodic-crit-needs-review', action: a.id, normalTicks: a.ticks });
		}
	}
}
const report = {
	scope: 'Mechanics diagnostics on developer equipment; one duration, small paired samples, no race winners or optimization claims.',
	iterations,
	seed,
	duration: 180,
	namedProfiles: new Set(inputs.map(r => r.profile)).size,
	legalCases: inputs.length,
	simulationExit,
	snapshotExit,
	rows,
	comparisons,
	flags,
	errors,
};
write('audit.json', report);
write('provenance.json', {
	createdAt: new Date().toISOString(),
	head: run('git', ['rev-parse', 'HEAD']).trim(),
	primarySource: run('git', ['merge-base', 'HEAD', 'origin/master']).trim(),
	status: run('git', ['status', '--porcelain']),
	databaseSha256: ready.databaseSha256,
	sourceReadiness: source,
	toolDependencies: Object.fromEntries(
		['robust_logic.mjs', 'racial_helpers.mjs', 'shadow_translation.mjs', 'statistics.mjs'].map(f => [
			f,
			hash(fs.readFileSync(path.join(root, 'tools/dps-experiments', f))),
		]),
	),
	gameInputs: Object.fromEntries(
		['assets/db_inputs/spell_store_inputs.json', 'sim/core/base_stats_auto_gen.go', 'assets/database/leftover_db.json']

			.map(f => [f, hash(fs.readFileSync(path.join(root, f)))]),
	),
	sourceReadinessSha256: hash(fs.readFileSync(path.join(source, 'readiness.json'))),
	toolSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
	inspectorSha256: hash(fs.readFileSync(path.join(root, 'tools/dps-experiments/mechanics-snapshot/main.go'))),
	binaries: Object.fromEntries(
		['batch', 'snapshot'].map(n => [n, hash(fs.readFileSync(path.join(out, 'engine', n + (process.platform === 'win32' ? '.exe' : ''))))]),
	),
});
console.log(
	JSON.stringify({
		profiles: report.namedProfiles,
		legalCases: inputs.length,
		rows: rows.length,
		flags: flags.length,
		errors: errors.length,
		simulationExit,
		snapshotExit,
	}),
);
if (errors.length || simulationExit || snapshotExit) process.exitCode = 1;
