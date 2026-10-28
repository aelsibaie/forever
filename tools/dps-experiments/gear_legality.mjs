import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, racialMetrics } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';
import { rankRaceSamples } from './robust_logic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] ?? '');
const toolBytes = fs.readFileSync(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node tools/dps-experiments/gear_legality.mjs study-directory');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
const profiles = read(path.join(out, 'profiles.json')),
	analysis = read(path.join(out, 'analysis.json')),
	cells = read(path.join(out, 'cells.json'));
const provenance = read(path.join(out, 'provenance.json'));
const engine = path.join(out, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch');
if (hash(fs.readFileSync(engine)) !== provenance.engineSha256) throw new Error('The native engine changed.');
for (const file of ['assets/database/db.json', 'assets/database/leftover_db.json'])
	if (hash(fs.readFileSync(path.join(root, file))) !== provenance.sourceFiles[file]) throw new Error('Native item data changed: ' + file);
const database = new Map(['db.json', 'leftover_db.json'].flatMap(file => read(path.join(root, 'assets/database', file)).items).map(item => [item.id, item]));
const conflicts = [];
for (const profile of profiles.profiles)
	for (const gear of profile.sets) {
		const categories = new Map();
		for (const item of gear.equipment.items) {
			const native = database.get(item.id);
			if (!native?.limitCategory) continue;
			if (!categories.has(native.limitCategory)) categories.set(native.limitCategory, []);
			categories.get(native.limitCategory).push({ id: native.id, name: native.name });
		}
		gear.categoryConflicts = [...categories].filter(([, items]) => items.length > 1).map(([category, items]) => ({ category, items }));
		if (!gear.categoryConflicts.length) continue;
		if (gear.tier === 'Published pre-raid') throw new Error(`Published set has a unique-equipped category conflict: ${gear.id}`);
		gear.diagnosticOnly = true;
		conflicts.push({ profileId: profile.id, faction: profile.faction, setId: gear.id, conflicts: gear.categoryConflicts });
	}
const affected = analysis.groups.filter(
	group =>
		group.mode.startsWith('pool:') &&
		group.rows.some(
			row => profiles.profiles.find(p => p.id === group.profileId && p.faction === group.faction).sets.find(g => g.id === row.setId).diagnosticOnly,
		),
);
for (const group of analysis.groups)
	if (group.setId && profiles.profiles.find(p => p.id === group.profileId && p.faction === group.faction).sets.find(g => g.id === group.setId).diagnosticOnly)
		group.diagnosticOnly = true;
if (affected.length) {
	fs.mkdirSync(path.join(out, 'prior-method'), { recursive: true });
	for (const name of ['profiles.json', 'analysis.json', 'cells.json']) {
		const target = path.join(out, 'prior-method', 'before-category-audit-' + name);
		if (!fs.existsSync(target)) fs.copyFileSync(path.join(out, name), target);
	}
}
const jobs = [],
	replacements = [];
for (const group of affected) {
	const profile = profiles.profiles.find(p => p.id === group.profileId && p.faction === group.faction);
	const valid = new Set(
		profile.sets
			.filter(
				gear =>
					!gear.diagnosticOnly &&
					[gear, ...gear.aliases].some(g =>
						group.mode === 'pool:published-pre-raid' ? g.tier === 'Published pre-raid' : g.origin === 'WoWSims developer',
					),
			)
			.map(g => g.id),
	);
	if (!valid.size) throw new Error('No valid reference equipment remains for ' + group.key);
	const members = [];
	for (const race of profile.races) {
		const selected = cells
			.filter(
				row =>
					row.phase === 'validation' &&
					row.profileId === profile.id &&
					row.faction === profile.faction &&
					row.duration === group.duration &&
					row.support === group.support &&
					row.referencePolicy === group.referencePolicy &&
					row.race === race &&
					valid.has(row.setId),
			)
			.sort((a, b) => b.meanDps - a.meanDps)[0];
		if (!selected) throw new Error('No valid validation selection for ' + group.key);
		const sourceFile = path.join(out, 'requests', selected.key + '.json');
		if (hash(fs.readFileSync(sourceFile)) !== selected.requestSha256) throw new Error('Validation source changed.');
		const request = read(sourceFile),
			key = 'precision--category-audit--' + hash(group.key + '--' + race).slice(0, 24);
		request.simOptions.iterations = provenance.settings.precisionIterations;
		request.simOptions.randomSeed = String(provenance.settings.precisionSeed);
		const row = {
			...selected,
			key,
			phase: 'precision',
			seed: provenance.settings.precisionSeed,
			iterations: provenance.settings.precisionIterations,
			pools: [group.mode.split(':')[1]],
			selectionReason: 'Independent confirmation after excluding mutually exclusive equipment categories.',
		};
		delete row.sameRequestAs;
		delete row.reusedInputFrom;
		const input = path.join(out, 'requests', key + '.json');
		fs.writeFileSync(input, JSON.stringify(request));
		row.requestSha256 = hash(fs.readFileSync(input));
		jobs.push({ key, request: input, result: path.join(out, 'results', key + '.json'), stats: path.join(out, 'stats', key + '.json') });
		members.push(row);
	}
	replacements.push({ group, members });
}
if (jobs.length) {
	save('jobs-category-audit.json', jobs);
	execFileSync(engine, [path.join(out, 'jobs-category-audit.json'), '4'], { stdio: 'inherit' });
}
for (const { group, members } of replacements) {
	const samples = new Map();
	for (const row of members) {
		const file = path.join(out, 'results', row.key + '.json'),
			raw = read(file);
		Object.assign(row, summarizeResult(raw, row.iterations));
		row.racial = racialMetrics(raw, row.race, row.className, row.iterations);
		row.resultSha256 = hash(fs.readFileSync(file));
		row.statsSha256 = hash(fs.readFileSync(path.join(out, 'stats', row.key + '.json')));
		samples.set(row.key, raw.raidMetrics.parties[0].players[0].dps.allValues);
		cells.push(row);
	}
	Object.assign(
		group,
		rankRaceSamples(members, row => samples.get(row.key)),
		{ rows: members },
	);
}
save('profiles.json', profiles);
save('analysis.json', analysis);
save('cells.json', cells);
const coverage = read(path.join(out, 'coverage.json'));
coverage.validEquipmentSets = profiles.profiles.reduce((sum, p) => sum + p.sets.filter(g => !g.diagnosticOnly).length, 0);
coverage.diagnosticOnlySets = conflicts;
coverage.cells = cells.length;
save('coverage.json', coverage);
const existing = fs.existsSync(path.join(out, 'gear-legality.json')) ? read(path.join(out, 'gear-legality.json')) : null;
save('gear-legality.json', {
	engineSha256: provenance.engineSha256,
	toolSha256: hash(toolBytes),
	rule: 'The native UI removes an equipped item when another item has the same nonzero limitCategory (ui/sim/proto/gear.ts). Conflicting developer inputs remain diagnostics and are excluded from recommendation pools. Published conflicts fail the audit.',
	conflicts,
	replacedGroups: [...new Set([...(existing?.replacedGroups ?? []), ...affected.map(g => g.key)])],
	confirmationCases: (existing?.confirmationCases ?? 0) + jobs.length,
});
fs.writeFileSync(path.join(out, 'gear-legality-tool.mjs'), toolBytes);
console.log(JSON.stringify({ diagnosticSets: conflicts.length, replacementGroups: affected.length, newConfirmations: jobs.length }));
