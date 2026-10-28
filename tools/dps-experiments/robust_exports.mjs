import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { loadProfiles } from './export.mjs';
import { hash, signature } from './racial_helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node tools/dps-experiments/robust_exports.mjs study-directory');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const analysis = read(path.join(out, 'analysis.json')),
	catalog = read(path.join(out, 'profiles.json'));
const nativeProvenance = read(path.join(out, 'provenance.json'));
const { apiVersion, validateWebsite } = await loadProfiles(root);
const exported = new Map(),
	proofInputs = [],
	proofCases = new Set();
const proofDir = path.join(out, 'exports/proof');
fs.mkdirSync(proofDir, { recursive: true });
function assertRetained(expected, actual, at = '') {
	// The public schema omits the zero-valued ProfessionUnknown enum.
	if (
		actual === undefined &&
		(expected === null ||
			expected === false ||
			expected === 0 ||
			(expected === 'ProfessionUnknown' && ['.player.profession1', '.player.profession2'].includes(at)) ||
			expected === '' ||
			(Array.isArray(expected) && expected.length === 0) ||
			(expected && typeof expected === 'object' && Object.keys(expected).length === 0))
	)
		return;
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`Website export changed array ${at}`);
		for (let i = 0; i < expected.length; i++) assertRetained(expected[i], actual[i], at + '[' + i + ']');
	} else if (expected && typeof expected === 'object') {
		for (const [key, value] of Object.entries(expected)) assertRetained(value, actual?.[key], at + '.' + key);
	} else if (expected !== actual) throw new Error(`Website export changed ${at}: ${expected} / ${actual}`);
}
for (const group of analysis.groups.filter(
	g =>
		(g.mode.startsWith('pool:') || g.mode === 'fixed-set') &&
		!g.diagnosticOnly &&
		g.duration === 180 &&
		g.support === 'full' &&
		g.referencePolicy === 'developer',
))
	for (const row of group.rows) {
		if (exported.has(row.key)) continue;
		const q = read(path.join(out, 'requests', row.key + '.json'));
		const player = structuredClone(q.raid.parties[0].players[0]);
		player.rotation.type = 'TypeAPL';
		delete player.rotation.simple;
		const website = {
			apiVersion,
			player,
			encounter: q.encounter,
			raidBuffs: q.raid.buffs,
			partyBuffs: q.raid.parties[0].buffs,
			debuffs: q.raid.debuffs,
			tanks: q.raid.tanks,
			settings: {
				iterations: q.simOptions.iterations,
				fixedRngSeed: q.simOptions.randomSeed,
				phase: 1,
				showDamageMetrics: true,
				showExperimental: true,
				faction: group.faction === 'horde' ? 'Horde' : 'Alliance',
			},
		};
		const normalized = validateWebsite(website);
		assertRetained(website, normalized);
		if (signature(validateWebsite(normalized)) !== signature(normalized)) throw new Error(`Unstable website schema round trip: ${row.key}`);
		const file = path.join(out, 'exports', row.key + '.website.json');
		fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
		exported.set(row.key, {
			key: row.key,
			sha256: hash(fs.readFileSync(file)),
			nativeRequestSha256: hash(fs.readFileSync(path.join(out, 'requests', row.key + '.json'))),
		});
		const profile = catalog.profiles.find(p => p.id === group.profileId && p.faction === group.faction);
		const controlName = [group.faction, profile.id, row.race].join('--');
		if (!proofCases.has(controlName)) {
			proofCases.add(controlName);
			for (const frozen of [false, true]) {
				const request = structuredClone(q);
				request.simOptions.iterations = 100;
				if (frozen) {
					request.raid.parties[0].players[0].rotation.type = 'TypeAPL';
					delete request.raid.parties[0].players[0].rotation.simple;
				}
				const key = hash(controlName).slice(0, 24) + (frozen ? '--apl' : '--original');
				const input = path.join(proofDir, key + '.input.json');
				fs.writeFileSync(input, JSON.stringify(request));
				proofInputs.push({ key, request: input, result: path.join(proofDir, key + '.result.json') });
			}
		}
	}
if (proofCases.size !== catalog.profiles.reduce((sum, profile) => sum + profile.races.length, 0))
	throw new Error('Website controls do not cover every race/build pair.');
fs.writeFileSync(path.join(proofDir, 'jobs.json'), JSON.stringify(proofInputs));
execFileSync(path.join(out, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch'), [path.join(proofDir, 'jobs.json'), '4'], { stdio: 'inherit' });
for (const spec of proofCases) {
	const key = hash(spec).slice(0, 24);
	const a = read(path.join(proofDir, key + '--apl.result.json')).raidMetrics.parties[0].players[0].dps.allValues;
	const b = read(path.join(proofDir, key + '--original.result.json')).raidMetrics.parties[0].players[0].dps.allValues;
	if (signature(a) !== signature(b)) throw new Error(`Freezing the website rotation changed native results: ${spec}`);
}
const source = fs.readFileSync(path.join(root, 'ui/sim/constants/missing_effects_auto_gen.ts'), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
const missing = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
for (const name of [
	'MISSING_ITEM_EFFECTS',
	'MISSING_ENCHANT_EFFECTS',
	'MISSING_SET_BONUSES',
	'UNVALIDATED_RATE_ITEMS',
	'UNVALIDATED_RATE_ENCHANTS',
	'UNVALIDATED_RATE_SET_BONUSES',
])
	if (!(missing[name] instanceof Map)) throw new Error(`Missing generated mechanics map: ${name}`);
const items = new Map(['db.json', 'leftover_db.json'].flatMap(file => read(path.join(root, 'assets/database', file)).items).map(item => [item.id, item]));
const rogueSourceFile = 'sim/rogue/talents_assassination.go';
const rogueSource = fs.readFileSync(path.join(root, rogueSourceFile), 'utf8');
const mutilateNotes = rogueSource
	.split('\n')
	.filter(line => /TODO:.*(?:Mutilate.*poison|Eureka.*Mutilate)/i.test(line))
	.map(line => line.replace(/^\s*\/\/\s*/, '').trim());
const coverage = catalog.profiles.map(profile => ({
	profileId: profile.id,
	faction: profile.faction,
	sets: profile.sets.map(gear => {
		const setCounts = new Map();
		for (const item of gear.audit) {
			const setId = items.get(item.id)?.setId;
			if (setId) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
		}
		const missingSets = [],
			unvalidatedRates = [];
		for (const [id, count] of setCounts) {
			for (const [pieces, effects] of missing.MISSING_SET_BONUSES.get(id) ?? []) if (count >= pieces) missingSets.push({ id, pieces, effects });
			for (const [pieces, rate] of missing.UNVALIDATED_RATE_SET_BONUSES.get(id) ?? [])
				if (count >= pieces) unvalidatedRates.push({ source: 'set', id, pieces, ...rate });
		}
		for (const item of gear.audit) {
			if (missing.UNVALIDATED_RATE_ITEMS.has(item.id))
				unvalidatedRates.push({ source: 'item', id: item.id, name: item.name, ...missing.UNVALIDATED_RATE_ITEMS.get(item.id) });
			if (missing.UNVALIDATED_RATE_ENCHANTS.has(item.enchant))
				unvalidatedRates.push({ source: 'enchant', id: item.enchant, name: item.enchantName, ...missing.UNVALIDATED_RATE_ENCHANTS.get(item.enchant) });
		}
		return {
			setId: gear.id,
			missingItems: gear.audit
				.filter(item => missing.MISSING_ITEM_EFFECTS.has(item.id))
				.map(item => ({ id: item.id, name: item.name, effects: missing.MISSING_ITEM_EFFECTS.get(item.id) })),
			missingEnchants: gear.audit
				.filter(item => missing.MISSING_ENCHANT_EFFECTS.has(item.enchant))
				.map(item => ({ id: item.enchant, name: item.enchantName, effects: missing.MISSING_ENCHANT_EFFECTS.get(item.enchant) })),
			missingSets,
			unvalidatedRates,
			revelation: gear.equipment.items.some(item => item.enchant === 8217),
		};
	}),
	mutilateProcCaveat: /-(asn|combat)-muti$/.test(profile.id) && mutilateNotes.length > 0,
	classMechanicNotes: /-(asn|combat)-muti$/.test(profile.id) ? mutilateNotes : [],
}));
fs.writeFileSync(
	path.join(out, 'mechanics-coverage.json'),
	JSON.stringify(
		{ sourceSha256: hash(source), sourceCommit: nativeProvenance.sourceCommit, classSources: { [rogueSourceFile]: hash(rogueSource) }, profiles: coverage },
		null,
		2,
	),
);
fs.writeFileSync(
	path.join(out, 'exports/verification.json'),
	JSON.stringify(
		{
			apiVersion,
			exports: [...exported.values()],
			schemaRoundTrip: true,
			exactNativeAplControls: [...proofCases],
			rotationExport: 'TypeAPL freezes the expanded priority list; simple UI settings are removed. The native experiment requests remain unchanged.',
			fields: 'Equipment, enchants, talents, rotation, buffs, encounter, iterations and RNG seed retained through the public UI schema.',
		},
		null,
		2,
	),
);
console.log(`Verified ${exported.size} website exports and ${proofCases.size} native rotation-freeze controls.`);
