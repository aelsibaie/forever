import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { loadProfiles } from './export.mjs';
import { auditProfiles, changedPaths } from './preset_audit.mjs';
import { summarizeResult, resolvedRequestKey } from './statistics.mjs';
import {
	hash,
	signature,
	eligibleRaces,
	factionPlayer,
	offensiveRacial,
	racialActions,
	racialMetrics,
	compareSamples,
	notesOverlay,
	rotationCaveats,
} from './racial_helpers.mjs';
import { verifyRacialRun } from './verify_racials.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log(
		'Usage: node tools/dps-experiments/racials.mjs [--faction both|alliance|horde] [--model upstream|notes-2026-10-27] [--out directory] [--resume] [--reuse previous-run] [--prepared] [--python executable] [--iterations 5000] [--confirmation-iterations 20000] [--seed 2026102707] [--durations 60,180,300] [--profiles id,id] [--sensitivity types|none]\n\nExports developer presets, builds the current engine, checks racial activation and faction counterparts, runs paired race comparisons and renders offline reports. --resume requires the same source snapshot and settings. --reuse verifies exact engine/request/result hashes. The default model is upstream.',
	);
	process.exit(0);
}
const boolean = new Set(['--resume', '--prepared']);
const valued = new Set([
	'--faction',
	'--model',
	'--out',
	'--reuse',
	'--python',
	'--iterations',
	'--confirmation-iterations',
	'--seed',
	'--durations',
	'--profiles',
	'--sensitivity',
]);
const options = {};
for (let i = 0; i < args.length; i++) {
	if (boolean.has(args[i])) options[args[i].slice(2)] = true;
	else if (valued.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
	else throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const run = (command, argv, log) => {
	const result = spawnSync(command, argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	if (log) fs.writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''));
	if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}${log ? ' (see ' + log + ')' : ''}`);
	return result.stdout;
};
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fileHash = file => hash(fs.readFileSync(file));
if (!options.prepared) {
	console.log('Generating protocol sources and constants...');
	console.log(run(process.execPath, ['tools/dps-experiments/prepare.mjs']));
}
const policy = read(path.join(root, 'tools/dps-experiments/racial-policy.json'));
const settings = {
	faction: options.faction ?? 'both',
	model: options.model ?? 'upstream',
	iterations: Number(options.iterations ?? 5000),
	confirmationIterations: Number(options['confirmation-iterations'] ?? 20000),
	seed: Number(options.seed ?? 2026102707),
	durations: (options.durations ?? '60,180,300').split(',').map(Number),
	profiles: options.profiles?.split(',').sort() ?? null,
	sensitivity: options.sensitivity ?? 'types',
};
if (
	!['both', 'alliance', 'horde'].includes(settings.faction) ||
	!['upstream', 'notes-2026-10-27'].includes(settings.model) ||
	!['types', 'none'].includes(settings.sensitivity) ||
	!Number.isSafeInteger(settings.iterations) ||
	settings.iterations < 2 ||
	!Number.isSafeInteger(settings.confirmationIterations) ||
	(settings.confirmationIterations !== 0 && settings.confirmationIterations < 2) ||
	!Number.isSafeInteger(settings.seed) ||
	settings.seed <= 0 ||
	settings.seed + Math.max(settings.iterations, settings.confirmationIterations) + settings.confirmationIterations + 1000000 > Number.MAX_SAFE_INTEGER ||
	settings.durations.some(x => !Number.isFinite(x) || x <= 0) ||
	new Set(settings.durations).size !== settings.durations.length
)
	throw new Error('Invalid faction, model, sampling or scenario settings.');
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const python = options.python ?? process.env.PYTHON_BINARY ?? 'python';
const out = path.resolve(
	root,
	options.out ?? `tmp/racial-experiments/${new Date().toISOString().replace(/[:.]/g, '-')}-${settings.faction}-${git('rev-parse', '--short', 'HEAD')}`,
);
const existed = fs.existsSync(out) && fs.readdirSync(out).length > 0;
if (existed && !options.resume) throw new Error(`Output exists; use --resume for an interrupted identical run: ${out}`);
if (options.resume && !existed) throw new Error('--resume requires an existing run.');
const tracked = git(
	'ls-files',
	'-z',
	'--',
	'sim',
	'proto',
	'ui',
	'assets/database',
	'assets/db_inputs/spell_store_inputs.json',
	'cmd',
	'tools/database',
	'go.mod',
	'go.sum',
	'package.json',
	'package-lock.json',
	'tsconfig.json',
)
	.split('\0')
	.filter(Boolean)
	.sort();
const walk = folder =>
	fs
		.readdirSync(folder, { withFileTypes: true })
		.flatMap(entry => (entry.name === '__pycache__' ? [] : entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]));
const toolPaths = walk(path.join(root, 'tools/dps-experiments'))
	.filter(file => /\.(mjs|mts|json|py|go|md|txt)$/.test(file))
	.sort();
const sourceFiles = Object.fromEntries(tracked.map(file => [file, fileHash(path.join(root, file))]));
const toolFiles = Object.fromEntries(toolPaths.map(file => [path.relative(root, file).replaceAll('\\', '/'), fileHash(file)]));
const snapshot = {
	commit: git('rev-parse', 'HEAD'),
	upstreamCommit: git('rev-parse', 'origin/master'),
	upstreamSourceCommit: git('merge-base', 'HEAD', 'origin/master'),
	branch: git('branch', '--show-current'),
	status: git('status', '--porcelain'),
	diffSha256: hash(git('diff', 'HEAD')),
	sourceSha256: hash(signature(sourceFiles)),
	toolSha256: hash(signature(toolFiles)),
	go: run(go, ['version']).trim(),
};
const fingerprint = hash(signature({ snapshot, settings }));
const save = (name, data) => {
	const target = path.join(out, name);
	fs.writeFileSync(target + '.tmp', JSON.stringify(data, null, 2));
	fs.renameSync(target + '.tmp', target);
};
for (const dir of ['engine', 'requests', 'results', 'stats', 'logs', 'charts']) fs.mkdirSync(path.join(out, dir), { recursive: true });
let provenance;
const native = path.join(out, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim'),
	stats = path.join(out, 'engine', process.platform === 'win32' ? 'stats.exe' : 'stats');
if (options.resume) {
	provenance = read(path.join(out, 'provenance.json'));
	if (provenance.fingerprint !== fingerprint)
		throw new Error('Source, tool, Git state or settings changed. Start a new output and optionally --reuse this run.');
	if (fileHash(native) !== provenance.engine.sha256 || fileHash(stats) !== provenance.engine.statsSha256) throw new Error('Stored native binary changed.');
} else {
	const build = ['build', '-trimpath', '-buildvcs=false', '-tags=with_db'];
	let model = { name: 'upstream', experimental: false, adjustments: [] };
	if (settings.model === 'notes-2026-10-27') {
		const source = path.join(root, 'sim/core/racials.go'),
			patched = notesOverlay(fs.readFileSync(source, 'utf8')),
			replacement = path.join(out, 'engine/racials.notes.go'),
			overlay = path.join(out, 'engine/overlay.json');
		fs.writeFileSync(replacement, patched.text);
		fs.writeFileSync(overlay, JSON.stringify({ Replace: { [source]: replacement } }, null, 2));
		build.push('-overlay', overlay);
		model = {
			name: settings.model,
			experimental: patched.status.some(x => x.action === 'overlay'),
			adjustments: patched.status,
			source: policy.notesSource,
			overlaySha256: fileHash(replacement),
		};
	}
	console.log('Building the simulator and public ComputeStats driver...');
	run(go, [...build, '-o', native, './cmd/wowsimcli'], path.join(out, 'logs/build-sim.log'));
	run(go, [...build, '-o', stats, './tools/dps-experiments/stats'], path.join(out, 'logs/build-stats.log'));
	const packed = fs.readFileSync(path.join(root, 'assets/db_inputs/spell_store_inputs.json')),
		game = JSON.parse(packed[0] === 31 ? gunzipSync(packed) : packed);
	provenance = {
		schemaVersion: 1,
		startedAt: new Date().toISOString(),
		command: process.argv.slice(1),
		fingerprint,
		snapshot,
		sourceFiles,
		toolFiles,
		settings,
		model,
		gameBuilds: game.Builds,
		hotfixes: game.Hotfixes,
		engine: { sha256: fileHash(native), statsSha256: fileHash(stats), buildInfo: run(go, ['version', '-m', native]) },
		environment: {
			node: process.version,
			go: snapshot.go,
			platform: process.platform,
			cpu: os.cpus()[0]?.model,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
	};
	save('provenance.json', provenance);
}
const config = {
	...read(path.join(root, 'tools/dps-experiments/baseline.json')),
	durations: settings.durations,
	iterations: settings.iterations,
	seed: settings.seed,
};
const loaded = await loadProfiles(root, config);
const audit = auditProfiles(loaded.profiles, root, config);
let profiles = loaded.profiles.filter(profile => profile.rankEligible);
if (settings.profiles) {
	for (const id of settings.profiles) if (!profiles.some(profile => profile.id === id)) throw new Error(`Unknown or unsupported profile: ${id}`);
	profiles = profiles.filter(profile => settings.profiles.includes(profile.id));
}
const database = read(path.join(root, 'assets/database/db.json')),
	factions = settings.faction === 'both' ? ['horde', 'alliance'] : [settings.faction];
const catalog = [];
const aliases = [];
const originalPlayers = {};
for (const faction of factions) {
	const seen = new Map();
	for (const original of profiles) {
		const { player, substitutions } = factionPlayer(original.player, faction, database, policy),
			races = eligibleRaces(original.className, faction, loaded.racesByClass, policy);
		if (!races.length) throw new Error(`No ${faction} race for ${original.id}`);
		player.race = races[0];
		const identity = resolvedRequestKey({ raid: { parties: [{ players: [player] }] } });
		if (seen.has(identity)) {
			aliases.push({ faction, id: original.id, sameAs: seen.get(identity) });
			continue;
		}
		seen.set(identity, original.id);
		catalog.push({ ...original, faction, player, races, substitutions });
		originalPlayers[faction + '--' + original.id] = original.player;
	}
}
save('profiles.json', {
	profiles: catalog,
	aliases,
	excluded: loaded.profiles.filter(profile => !profile.rankEligible).map(({ player, ...rest }) => rest),
	audit,
	config,
	policy,
});
const wornIds = new Set(
	[...catalog.map(p => p.player), ...Object.values(originalPlayers)]
		.flatMap(p => [...p.equipment.items, ...(p.itemSwap?.items ?? [])])
		.map(item => item.id)
		.filter(Boolean),
);
save('equipment-audit.json', {
	databaseSha256: fileHash(path.join(root, 'assets/database/db.json')),
	items: database.items.filter(item => wornIds.has(item.id)),
});
let cells = options.resume && fs.existsSync(path.join(out, 'cells.json')) ? read(path.join(out, 'cells.json')) : [];
const existing = new Map(cells.map(row => [row.key, row]));
let reused = [];
if (options.reuse) {
	const old = path.resolve(root, options.reuse),
		prior = read(path.join(old, 'provenance.json'));
	if (prior.engine.sha256 === provenance.engine.sha256) reused = read(path.join(old, 'cells.json')).map(row => ({ ...row, directory: old }));
	else console.log('Reuse archive has a different engine hash; its results will not be reused.');
}
const reuseMap = new Map(reused.map(row => [row.requestSha256, row]));
function execute(meta, request) {
	const q = loaded.validateRequest(request),
		bytes = JSON.stringify(q),
		requestSha256 = hash(bytes),
		key = meta.key,
		infile = path.join(out, 'requests', key + '.json'),
		outfile = path.join(out, 'results', key + '.json');
	const prior = existing.get(key);
	if (prior) {
		if (prior.requestSha256 !== requestSha256 || fileHash(infile) !== requestSha256 || fileHash(outfile) !== prior.resultSha256)
			throw new Error(`Cached cell changed: ${key}`);
		return prior;
	}
	fs.writeFileSync(infile, bytes);
	const reuse = reuseMap.get(requestSha256);
	let raw;
	if (reuse) {
		const oldRequest = path.join(reuse.directory, 'requests', reuse.key + '.json'),
			oldResult = path.join(reuse.directory, 'results', reuse.key + '.json');
		if (fileHash(oldRequest) !== requestSha256 || fileHash(oldResult) !== reuse.resultSha256)
			throw new Error(`Reuse archive failed hash verification: ${reuse.key}`);
		fs.copyFileSync(oldResult, outfile);
		raw = read(outfile);
	} else {
		run(native, ['sim', '--infile', infile, '--outfile', outfile], path.join(out, 'logs', key + '.log'));
		raw = read(outfile);
	}
	const row = {
		...meta,
		...summarizeResult(raw, q.simOptions.iterations),
		seed: Number(q.simOptions.randomSeed),
		racial: racialMetrics(raw, meta.race, meta.className, q.simOptions.iterations),
		requestSha256,
		resultSha256: fileHash(outfile),
		reusedFrom: reuse ? { directory: reuse.directory, key: reuse.key } : null,
	};
	cells.push(row);
	existing.set(key, row);
	save('cells.json', cells);
	if (cells.length % 20 === 0) console.log(`${cells.length} cells saved; ${key}`);
	return row;
}
function request(profile, race, duration, scenario, iterations = settings.iterations, seed = settings.seed, player = profile.player) {
	const stats = Array(28).fill(0);
	stats[27] = config.target.armor;
	return {
		type: 'SimTypeIndividual',
		raid: {
			parties: [{ players: [{ ...player, race, buffs: config.individualBuffs }], buffs: config.partyBuffs }],
			buffs: config.raidBuffs,
			debuffs: config.debuffs,
			tanks: [],
		},
		encounter: {
			duration,
			durationVariation: 0,
			executeProportion20: config.executeProportion20,
			executeProportion35: config.executeProportion35,
			targets: [
				{
					name: scenario === 'beast' ? 'Beast target' : scenario === 'elemental' ? 'Elemental target' : 'Neutral stationary target',
					level: config.target.level,
					mobType: scenario === 'beast' ? 'MobTypeBeast' : scenario === 'elemental' ? 'MobTypeElemental' : config.target.mobType,
					stats,
					tankIndex: -1,
				},
			],
		},
		simOptions: { iterations, randomSeed: String(seed), saveAllValues: true, useLabeledRands: true },
	};
}
function cell(profile, race, duration, scenario = 'developer', iterations, seed, player) {
	const key = [profile.faction, profile.id, race, duration + 's', scenario].join('--');
	return execute(
		{
			key,
			profileId: profile.id,
			className: profile.className,
			buildName: profile.name,
			gearName: profile.gearName,
			faction: profile.faction,
			race,
			duration,
			scenario,
		},
		request(profile, race, duration, scenario, iterations, seed, player),
	);
}
const valuesCache = new Map();
function values(row) {
	if (!valuesCache.has(row.key)) valuesCache.set(row.key, read(path.join(out, 'results', row.key + '.json')).raidMetrics.parties[0].players[0].dps.allValues);
	return valuesCache.get(row.key);
}
const validations = [];
const controls = [];
const adjusted = new Map();
console.log(`Running ${catalog.length} distinct faction/preset inputs (${aliases.length} aliases hidden)...`);
for (const profile of catalog) {
	const base = [];
	for (const duration of settings.durations) for (const race of profile.races) base.push(cell(profile, race, duration));
	for (const race of profile.races) {
		const row = base.find(row => row.race === race && row.duration === (settings.durations.includes(180) ? 180 : settings.durations[0])),
			sf = path.join(out, 'stats', row.key + '.json');
		run(stats, [path.join(out, 'requests', row.key + '.json'), sf], path.join(out, 'logs', row.key + '--stats.log'));
		const messages = [];
		const collect = x => {
			if (!x || typeof x !== 'object') return;
			for (const [k, v] of Object.entries(x))
				if (k === 'validations') messages.push(...v);
				else collect(v);
		};
		collect(read(sf).raidStats.parties[0].players[0].rotationStats);
		validations.push({ faction: profile.faction, profileId: profile.id, race, messages });
		if (profile.substitutions.length) {
			const original = originalPlayers[profile.faction + '--' + profile.id],
				q = request(profile, race, row.duration, 'developer');
			q.raid.parties[0].players[0].equipment = original.equipment;
			if (q.raid.parties[0].players[0].itemSwap?.items) q.raid.parties[0].players[0].itemSwap.items = original.itemSwap.items;
			const control = execute({ ...row, key: row.key + '--mirror-control', scenario: 'mirror-control' }, q);
			if (!values(control).every((value, i) => value === values(row)[i])) throw new Error(`Faction counterpart changes damage: ${row.key}`);
			controls.push({ key: control.key, reference: row.key, type: 'faction-counterpart', identicalEveryIteration: true });
		}
	}
	const missing = profile.races.filter(
		race => offensiveRacial(race, profile.className) && base.filter(row => row.race === race).every(row => row.racial.casts === 0),
	);
	if (missing.length) {
		const ids = missing.map(race => offensiveRacial(race, profile.className)),
			player = racialActions(profile.player, ids),
			id = profile.faction + '--' + profile.id;
		adjusted.set(id, { player, missing, spellIds: ids });
		console.log(`Checking unused racial(s): ${id}: ${missing.join(', ')}`);
		for (const duration of settings.durations)
			for (const race of profile.races) {
				const row = cell(profile, race, duration, 'racial-activation', undefined, undefined, player),
					original = base.find(row => row.duration === duration && row.race === race);
				if (!missing.includes(race)) {
					if (!values(row).every((v, i) => v === values(original)[i])) throw new Error(`Unaffected-race control changed: ${row.key}`);
					controls.push({ key: row.key, reference: original.key, type: 'unaffected-race', identicalEveryIteration: true });
				}
			}
	}
}
save('rotation-validations.json', validations);
save('controls.json', controls);
save(
	'adjustments.json',
	[...adjusted].map(([id, { missing, spellIds }]) => ({
		id,
		missing,
		spellIds,
		policy: 'Prepend spell-is-known guarded casts for only the unused offensive racial IDs. All other priority entries stay fixed. No cooldown timing optimization or mana racial action is added.',
	})),
);
const effectiveScenario = profile => (adjusted.has(profile.faction + '--' + profile.id) ? 'racial-activation' : 'developer');
function group(profile, duration, scenario, source) {
	const rows = source
		.filter(row => row.profileId === profile.id && row.faction === profile.faction && row.duration === duration && row.scenario === scenario)
		.sort((a, b) => b.meanDps - a.meanDps);
	if (rows.length < 1) throw new Error('Missing group');
	const reference = rows.find(row => row.race === profile.races[0]) ?? rows[0],
		lead = rows.length > 1 ? compareSamples(values(rows[0]), values(rows[1])) : null;
	return {
		profileId: profile.id,
		faction: profile.faction,
		className: profile.className,
		buildName: profile.name,
		gearTier: profile.gearTier,
		specLabel: profile.specLabel,
		duration,
		scenario,
		referenceRace: reference.race,
		winner: rows[0].race,
		onlyChoice: rows.length === 1,
		leadOverSecond: lead,
		practicalTie: lead ? lead.percent < 0.2 || !lead.distinguishable : false,
		rows: rows.map(row => ({ ...row, vsReference: compareSamples(values(row), values(reference)) })),
	};
}
const primary = [];
for (const profile of catalog) for (const duration of settings.durations) primary.push(group(profile, duration, effectiveScenario(profile), cells));
const confirmationSeed = settings.seed + Math.max(settings.iterations, settings.confirmationIterations) + 1000000;
if (settings.confirmationIterations) {
	for (const g of primary.filter(
		g => g.leadOverSecond && (g.leadOverSecond.percent < 0.3 || g.leadOverSecond.percent < 2 * g.leadOverSecond.ci95HalfWidthPercent),
	)) {
		const p = catalog.find(p => p.id === g.profileId && p.faction === g.faction),
			player = adjusted.get(p.faction + '--' + p.id)?.player ?? p.player;
		for (const row of g.rows.slice(0, 2)) cell(p, row.race, g.duration, 'confirmation', settings.confirmationIterations, confirmationSeed, player);
	}
}
const confirmations = [];
for (const profile of catalog)
	for (const duration of settings.durations)
		if (cells.some(row => row.faction === profile.faction && row.profileId === profile.id && row.duration === duration && row.scenario === 'confirmation'))
			confirmations.push(group(profile, duration, 'confirmation', cells));
for (const g of primary) {
	const confirm = confirmations.find(c => c.faction === g.faction && c.profileId === g.profileId && c.duration === g.duration);
	if (confirm && (confirm.practicalTie || confirm.winner !== g.winner)) g.practicalTie = true;
}
const sensitivity = [];
if (settings.sensitivity === 'types') {
	const duration = settings.durations.includes(180) ? 180 : settings.durations[0];
	for (const profile of catalog)
		for (const scenario of ['beast', ...(profile.races.some(race => race.includes('Skyborne')) ? ['elemental'] : [])]) {
			for (const race of profile.races)
				cell(profile, race, duration, scenario, undefined, undefined, adjusted.get(profile.faction + '--' + profile.id)?.player ?? profile.player);
			sensitivity.push(group(profile, duration, scenario, cells));
		}
}
const confidence = catalog.map(profile => {
	const rows = primary.filter(g => g.profileId === profile.id && g.faction === profile.faction).flatMap(g => g.rows),
		markers = [];
	if (profile.gearTier === 'Developer testing')
		markers.push({
			code: 'testing',
			label: 'Testing gear',
			reason: 'Developer loadout is labelled Testing, without a documented common progression tier.',
		});
	if (profile.gearTier === 'Pre-raid placeholder')
		markers.push({ code: 'placeholder', label: 'Placeholder', reason: 'Developer gear description calls this a placeholder.' });
	if (rows.some(row => row.secondsOomAvg / row.duration > 0.05))
		markers.push({ code: 'mana', label: 'Mana-limited', reason: 'Mean recorded out-of-mana time exceeds 5% of fight length in at least one cell.' });
	if (/45s/i.test(profile.name))
		markers.push({
			code: 'specialized',
			label: '45s preset',
			reason: 'Developer rotation is named for 45-second fights; these tests include other durations.',
		});
	const messages = validations.filter(v => v.profileId === profile.id && v.faction === profile.faction).flatMap(v => v.messages);
	markers.push(...rotationCaveats(profile.id, messages, policy));
	const adjustment = adjusted.get(profile.faction + '--' + profile.id);
	if (adjustment)
		markers.push({
			code: 'racial-adjusted',
			label: 'Racial action added',
			reason: 'Minimal activation check for ' + adjustment.missing.join(', ') + '. Original developer results are preserved.',
		});
	const inactive = profile.races.filter(
		race => offensiveRacial(race, profile.className) && rows.filter(row => row.race === race).every(row => row.racial.casts === 0),
	);
	if (inactive.length)
		markers.push({
			code: 'inactive',
			label: 'Racial still unused',
			reason: 'No offensive racial casts after the activation check for ' + inactive.join(', ') + '. Ranking withheld.',
		});
	const unusedLeyline = rows.some(row => row.racial.readLeylineCasts === 0 && row.secondsOomAvg / row.duration > 0.05);
	if (unusedLeyline)
		markers.push({
			code: 'leyline',
			label: 'Mana racial unused',
			reason: 'Read Leyline is unused in a mana-limited cell. Its supplied APL is retained; no mana cooldown optimization is performed.',
		});
	return { profileId: profile.id, faction: profile.faction, markers, rankingWithheld: inactive.length > 0 };
});
for (const g of [...primary, ...sensitivity]) g.rankingWithheld = confidence.find(c => c.profileId === g.profileId && c.faction === g.faction).rankingWithheld;
const baseline = catalog.flatMap(p => settings.durations.map(t => group(p, t, 'developer', cells)));
save('analysis.json', { primary, baseline, confirmations, sensitivity, confidence, aliases, settings });
const csvRows = primary.flatMap(g =>
	g.rows.map(row => ({
		faction: g.faction,
		profileId: g.profileId,
		spec: g.specLabel,
		build: g.buildName,
		gearTier: g.gearTier,
		caveats: confidence
			.find(c => c.profileId === g.profileId && c.faction === g.faction)
			.markers.map(m => m.label)
			.join('; '),
		scenario: g.scenario,
		race: row.race,
		duration: row.duration,
		iterations: row.iterations,
		seed: row.seed,
		meanDps: row.meanDps,
		ci95HalfWidth: row.ci95HalfWidth,
		referenceRace: g.referenceRace,
		deltaPercentVsReference: row.vsReference.percent,
		pairedCi95HalfWidthPercent: row.vsReference.ci95HalfWidthPercent,
		closeResult: g.practicalTie,
		onlyChoice: g.onlyChoice,
		rankingWithheld: g.rankingWithheld,
		petDps: row.petDps,
		secondsOomAvg: row.secondsOomAvg,
		racialCasts: row.racial.casts,
		readLeylineCasts: row.racial.readLeylineCasts,
		simulatorCommit: snapshot.commit,
		gameBuilds: signature(provenance.gameBuilds),
		model: provenance.model.name,
		requestSha256: row.requestSha256,
		resultSha256: row.resultSha256,
	})),
);
const keys = Object.keys(csvRows[0]),
	quote = x => '"' + String(x ?? '').replaceAll('"', '""') + '"';
fs.writeFileSync(
	path.join(out, 'race-comparison.csv'),
	keys.join(',') + '\n' + csvRows.map(row => keys.map(key => quote(row[key])).join(',')).join('\n') + '\n',
);
run(python, ['tools/dps-experiments/racial_report.py', out], path.join(out, 'logs/report.log'));
for (const [file, h] of Object.entries(sourceFiles)) if (fileHash(path.join(root, file)) !== h) throw new Error(`Source changed while running: ${file}`);
for (const [file, h] of Object.entries(toolFiles)) if (fileHash(path.join(root, file)) !== h) throw new Error(`Tool changed while running: ${file}`);
save('completion.json', { state: 'verifying' });
save('artifact-hashes.json', {});
const verification = verifyRacialRun(out, { checkArtifacts: false });
save('completion.json', {
	completedAt: new Date().toISOString(),
	fingerprint,
	sourceUnchanged: true,
	verification,
	counts: Object.fromEntries([...new Set(cells.map(row => row.scenario))].map(name => [name, cells.filter(row => row.scenario === name).length])),
});
const artifacts = walk(out)
	.filter(
		file =>
			file.startsWith(path.join(out, 'charts') + path.sep) ||
			file.startsWith(path.join(out, 'stats') + path.sep) ||
			(file.startsWith(path.join(out, 'engine') + path.sep) && /\.(json|go)$/.test(file)) ||
			path.dirname(file) === out,
	)
	.filter(file => !file.endsWith('.tmp') && path.basename(file) !== 'artifact-hashes.json');
save('artifact-hashes.json', Object.fromEntries(artifacts.map(file => [path.relative(out, file).replaceAll('\\', '/'), fileHash(file)])));
console.log(`Completed racial comparison: ${out}\n${JSON.stringify(verification)}`);
