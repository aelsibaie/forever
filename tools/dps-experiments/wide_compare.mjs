import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { flattenRotation, isolationRequest, translateIsolation } from './wide_translation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2),
	option = (k, fallback) => (args.includes(k) ? args[args.indexOf(k) + 1] : fallback);
if (args.includes('--help')) {
	console.log(
		'node tools/dps-experiments/wide_compare.mjs --primary-run racials --gunba-source checkout --gunba-engine native-driver --out new-directory [--iterations 2000] [--resume]',
	);
	process.exit(0);
}
const primary = path.resolve(option('--primary-run', 'tmp/analytics-runs/2026-10-27-14e5ca6ca4/racials'));
const source = path.resolve(option('--gunba-source', 'tmp/engine-comparisons/gunba'));
const gunba = path.resolve(option('--gunba-engine', 'tmp/analytics-runs/2026-10-27-14e5ca6ca4/shadow-comparison-independent/engine/gunba.exe'));
const out = path.resolve(option('--out', 'tmp/wide-comparison/' + Date.now()));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const commonSpellProbes = args.includes('--common-spell-probes');
const probeSpells = { 'druid/balance': 9876, 'mage/dps': 10181, 'warlock/dps': 17923 };
const native = path.join(primary, 'engine/wowsim.exe'),
	stats = path.join(primary, 'engine/stats.exe');
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const sourceProvenance = read(path.join(primary, 'provenance.json'));
assert.equal(hash(fs.readFileSync(native)), sourceProvenance.engine.sha256);
const gunbaRevision = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
assert.equal(gunbaRevision, '92120c303d5ef4c4d4840df19818a65f8acb40b3', 'Review changed Gunba source.');
assert.equal(run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no']).trim(), '');
const settings = {
	iterations: Number(option('--iterations', 2000)),
	durations: [60, 180, 300],
	seed: 2026102707,
	gunbaSeed: 3026102707,
	sourceCommit: sourceProvenance.snapshot.upstreamSourceCommit,
	primaryEngine: hash(fs.readFileSync(native)),
	statsEngine: hash(fs.readFileSync(stats)),
	gunbaRevision,
	gunbaEngine: hash(fs.readFileSync(gunba)),
	toolHashes: Object.fromEntries(
		['wide_compare.mjs', 'wide_translation.mjs', 'shadow_translation.mjs'].map(f => [
			f,
			hash(fs.readFileSync(path.join(root, 'tools/dps-experiments', f))),
		]),
	),
};
assert(Number.isInteger(settings.iterations) && settings.iterations > 1 && Math.abs(settings.gunbaSeed - settings.seed) >= settings.iterations);
settings.commonSpellProbes = commonSpellProbes;
if (commonSpellProbes) settings.probeSpells = probeSpells;
assert(!fs.existsSync(out) || args.includes('--resume'), 'Choose a new directory or resume.');
for (const d of ['requests', 'results', 'stats', 'logs']) fs.mkdirSync(path.join(out, d), { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
if (args.includes('--resume')) assert.deepEqual(read(path.join(out, 'provenance.json')).settings, settings, 'Comparison tools or settings changed.');
save('provenance.json', {
	settings,
	sourceProvenance,
	scope:
		'Engine-isolation diagnostic: same developer equipment, named talents, encounter and races. External buffs, debuffs and all consumables removed in BOTH engines. Not a replacement for the full-support baseline or a fully matched final-stat comparison. Gear suffix stats resolved by the primary engine; no forced Tier 1. Revelation .09 flat provisional in Gunba. Resource, talent and effect implementations can differ. ' +
		(commonSpellProbes
			? 'COMMON-SPELL PROBES: both engines use the same one-spell repetition instead of the developer APL; no prepull or automatic cooldown actions. This diagnoses model differences and cannot rank complete builds or active racials.'
			: 'Developer APL retained, with native equivalence controls for group expansion.'),
});
const index = args.includes('--resume') ? read(path.join(out, 'cell-index.json')) : {};
const simulate = (key, q, engine) => {
	const input = path.join(out, 'requests', key + '.json'),
		output = path.join(out, 'results', key + '.json'),
		bytes = JSON.stringify(q);
	if (index[key]) {
		assert.equal(index[key].requestSha256, hash(Buffer.from(bytes)));
		assert.equal(index[key].resultSha256, hash(fs.readFileSync(output)));
	} else {
		fs.writeFileSync(input, bytes);
		fs.writeFileSync(
			path.join(out, 'logs', key + '.log'),
			engine === 'gunba' ? run(gunba, ['sim', input, output]) : run(native, ['sim', '--infile', input, '--outfile', output]),
		);
		index[key] = { requestSha256: hash(Buffer.from(bytes)), resultSha256: hash(fs.readFileSync(output)) };
		save('cell-index.json', index);
	}
	const raw = read(output);
	return { raw, summary: summarizeResult(raw, q.simOptions.iterations), ...index[key] };
};
const catalog = read(path.join(primary, 'profiles.json')),
	cells = read(path.join(primary, 'cells.json')),
	coverage = [],
	rows = [];
for (const profile of catalog.profiles) {
	const entry = { id: profile.id, name: profile.name, className: profile.className, faction: profile.faction, races: [], status: 'Blocked', reason: '' };
	try {
		if (commonSpellProbes && !probeSpells[profile.specPath]) throw new Error('No reviewed common-spell probe for ' + profile.specPath);
		for (const cell of cells.filter(
			c => c.profileId === profile.id && c.faction === profile.faction && c.duration === 180 && c.key.endsWith('--developer'),
		)) {
			const key = profile.faction + '--' + profile.id + '--' + cell.race;
			const original = isolationRequest(read(path.join(primary, 'requests', cell.key + '.json')));
			if (commonSpellProbes)
				original.raid.parties[0].players[0].rotation = {
					type: 'TypeAPL',
					prepullActions: [],
					priorityList: [{ action: { castSpell: { spellId: { spellId: probeSpells[profile.specPath] } } } }],
				};
			original.simOptions.iterations = settings.iterations;
			original.simOptions.randomSeed = String(settings.seed);
			const normalized = structuredClone(original);
			normalized.raid.parties[0].players[0].rotation = flattenRotation(original.raid.parties[0].players[0].rotation);
			const input = path.join(out, 'stats', key + '--primary-request.json'),
				equipment = path.join(out, 'stats', key + '--equipment.json');
			fs.writeFileSync(input, JSON.stringify(original));
			run(stats, [input, equipment, 'equipment']);
			if (commonSpellProbes) {
				const primaryStats = path.join(out, 'stats', key + '--primary.json');
				run(stats, [input, primaryStats]);
				assert(
					read(primaryStats).raidStats.parties[0].players[0].metadata.spells.some(s => s.id.spellId === probeSpells[profile.specPath]),
					'Primary engine does not register the selected common spell.',
				);
			}
			const translated = translateIsolation(original, profile, read(equipment), source);
			translated.simOptions.randomSeed = String(settings.gunbaSeed);
			if (commonSpellProbes) translated.raid.parties[0].players[0].rotation = structuredClone(original.raid.parties[0].players[0].rotation);
			const gInput = path.join(out, 'stats', key + '--gunba-request.json'),
				gStats = path.join(out, 'stats', key + '--gunba.json');
			fs.writeFileSync(gInput, JSON.stringify(translated));
			run(gunba, ['stats', gInput, gStats]);
			assert(!read(gStats).errorResult, 'Gunba stats computation failed.');
			if (commonSpellProbes)
				assert(
					read(gStats).raidStats.parties[0].players[0].metadata.spells.some(s => s.id.spellId === probeSpells[profile.specPath]),
					'Gunba does not register the selected common spell.',
				);
			const controlA = structuredClone(original),
				controlB = structuredClone(normalized);
			controlA.simOptions.iterations = 250;
			controlB.simOptions.iterations = 250;
			const a = simulate(key + '--original-control', controlA, 'wowsims'),
				b = simulate(key + '--normalized-control', controlB, 'wowsims');
			assert.deepEqual(
				a.raw.raidMetrics.parties[0].players[0].dps.allValues,
				b.raw.raidMetrics.parties[0].players[0].dps.allValues,
				'APL flattening failed the native equivalence control.',
			);
			for (const duration of settings.durations) {
				const results = {};
				for (const [engine, request] of [
					['wowsims', normalized],
					['gunba', translated],
				]) {
					const q = structuredClone(request);
					q.encounter.duration = duration;
					const cellKey = key + '--' + duration + 's--' + engine,
						result = simulate(cellKey, q, engine);
					if (commonSpellProbes)
						assert(
							result.summary.damageActions.some(a => a.id.spellId === probeSpells[profile.specPath] && a.casts > 0),
							'The selected probe spell never dealt damage.',
						);
					results[engine] = result.summary;
					rows.push({
						key: cellKey,
						profileId: profile.id,
						className: profile.className,
						faction: profile.faction,
						race: cell.race,
						duration,
						engine,
						...(commonSpellProbes ? { probeSpellId: probeSpells[profile.specPath] } : {}),
						...result.summary,
						requestSha256: result.requestSha256,
						resultSha256: result.resultSha256,
					});
				}
			}
			entry.races.push(cell.race);
		}
		entry.status = 'Diagnostic completed';
	} catch (error) {
		if (entry.races.length) entry.status = 'Partially completed';
		entry.reason = String(error.stderr || error.message)
			.split('\n')
			.filter(x => !x.startsWith('goroutine'))
			.slice(0, 3)
			.join(' ')
			.slice(0, 900);
		save('logs/' + profile.faction + '--' + profile.id + '--blocked.json', { message: error.message, stderr: String(error.stderr ?? '') });
	}
	coverage.push(entry);
	save('results.json', { coverage, rows, aliases: catalog.aliases, excluded: catalog.excluded, settings });
	console.log(profile.faction + ' / ' + profile.id + ': ' + entry.status + ' ' + entry.reason.slice(0, 140));
}
save('completion.json', {
	completedAt: new Date().toISOString(),
	profiles: coverage.length,
	completed: coverage.filter(c => c.status === 'Diagnostic completed').length,
	rows: rows.length,
	settings,
});
