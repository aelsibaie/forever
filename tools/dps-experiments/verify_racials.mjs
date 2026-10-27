import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, racialActions } from './racial_helpers.mjs';
import { changedPaths } from './preset_audit.mjs';
import { verifyDetails } from './verify_details.mjs';

export function verifyRacialRun(directory, { checkArtifacts = true } = {}) {
	const out = path.resolve(directory),
		read = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8').replace(/^\uFEFF/, ''));
	const assert = (test, message) => {
		if (!test) throw new Error(message);
	};
	const p = read('provenance.json'),
		catalog = read('profiles.json'),
		a = read('analysis.json'),
		cells = read('cells.json'),
		controls = read('controls.json');
	const requests = new Map(),
		arrays = new Map();
	const engine = path.join(out, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim');
	assert(hash(fs.readFileSync(engine)) === p.engine.sha256, 'Engine binary hash mismatch');
	const currentDatabase = read('equipment-audit.json');
	const items = new Map(currentDatabase.items.map(item => [item.id, item]));
	for (const row of cells) {
		const req = fs.readFileSync(path.join(out, 'requests', row.key + '.json')),
			raw = fs.readFileSync(path.join(out, 'results', row.key + '.json'));
		assert(hash(req) === row.requestSha256 && hash(raw) === row.resultSha256, 'Cell hash mismatch: ' + row.key);
		const q = JSON.parse(req),
			r = JSON.parse(raw),
			player = q.raid.parties[0].players[0],
			values = r.raidMetrics.parties[0].players[0].dps.allValues;
		requests.set(row.key, q);
		arrays.set(row.key, values);
		assert(
			values.length === row.iterations && r.iterationsDone === row.iterations && q.simOptions.iterations === row.iterations,
			'Incomplete iterations: ' + row.key,
		);
		assert(values.every(Number.isFinite), 'Non-finite damage sample: ' + row.key);
		const mean = values.reduce((s, v) => s + v, 0) / values.length;
		assert(Math.abs(mean - row.meanDps) < 1e-8, 'Mean mismatch: ' + row.key);
		assert(
			Number(q.simOptions.randomSeed) === row.seed && q.encounter.duration === row.duration && (q.encounter.durationVariation ?? 0) === 0,
			'Seed/duration mismatch: ' + row.key,
		);
		const profile = catalog.profiles.find(profile => profile.id === row.profileId && profile.faction === row.faction);
		assert(profile?.races.includes(player.race) && player.race === row.race, 'Race eligibility mismatch: ' + row.key);
		if (row.scenario !== 'mirror-control')
			for (const item of [...player.equipment.items, ...(player.itemSwap?.items ?? [])])
				if (item.id) {
					assert(items.has(item.id), 'Unknown equipment ID: ' + item.id);
					assert(items.get(item.id).factionRestriction !== (row.faction === 'alliance' ? 2 : 1), 'Opposing-faction item: ' + row.key);
				}
	}
	for (const g of [...a.primary, ...a.baseline, ...a.confirmations, ...a.sensitivity]) {
		const first = requests.get(g.rows[0].key);
		for (const row of g.rows.slice(1))
			assert(
				changedPaths(first, requests.get(row.key)).every(key => key === 'raid.parties.0.players.0.race'),
				'Comparison changes non-race inputs: ' + row.key,
			);
	}
	for (const control of controls) {
		const x = arrays.get(control.key),
			y = arrays.get(control.reference);
		assert(x.length === y.length && x.every((value, i) => value === y[i]), 'Control differs: ' + control.key);
	}
	for (const g of a.primary.filter(g => g.scenario === 'racial-activation')) {
		const adjustment = read('adjustments.json').find(row => row.id === g.faction + '--' + g.profileId);
		for (const row of g.rows) {
			const baseline = cells.find(
					other =>
						other.faction === g.faction &&
						other.profileId === g.profileId &&
						other.race === row.race &&
						other.duration === row.duration &&
						other.scenario === 'developer',
				),
				original = structuredClone(requests.get(baseline.key));
			original.raid.parties[0].players[0] = racialActions(original.raid.parties[0].players[0], adjustment.spellIds);
			assert(changedPaths(original, requests.get(row.key)).length === 0, 'Unexpected activation-check change: ' + row.key);
		}
	}
	const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
	const details = p.toolFiles?.['tools/dps-experiments/report_details.py'] || fs.existsSync(path.join(out, 'profile-index.json')) ? verifyDetails(out) : null;
	let links = 0;
	for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g))
		if (!/^https?:|^#/.test(match[1])) {
			assert(fs.existsSync(path.resolve(out, match[1])), 'Missing report artifact: ' + match[1]);
			links++;
		}
	if (checkArtifacts) {
		const manifest = read('artifact-hashes.json');
		assert(Object.keys(manifest).length > 0, 'Missing artifact hashes');
		for (const [file, expected] of Object.entries(manifest))
			assert(hash(fs.readFileSync(path.join(out, file))) === expected, 'Changed report artifact: ' + file);
	}
	return {
		passed: true,
		profilePages: details,
		cells: cells.length,
		controls: controls.length,
		raceOnlyInputs: true,
		factionEquipment: true,
		activationChangesOnly: true,
		hashes: true,
		reportLinks: links,
	};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyRacialRun(process.argv[2]), null, 2));
