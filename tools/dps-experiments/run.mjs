import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfiles } from './export.mjs';
import { summarizeResult, csv, resolvedRequestKey } from './statistics.mjs';
import { auditProfiles, changedPaths } from './preset_audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log(
		'Usage: node tools/dps-experiments/run.mjs [--out directory] [--config file] [--iterations count] [--seed integer] [--profiles id,id] [--durations 60,180,300] [--sim binary] [--engine-provenance file] [--frozen saved-run]\n\nBuilds the native simulator with with_db, exports UI DPS presets, and saves requests, results, summaries, debug logs, and provenance. The output directory must be empty. --sim reuses a binary and records its build metadata. --engine-provenance checks that binary and its source hashes and carries its named model into the report. --frozen uses saved requests on the current simulator.',
	);
	process.exit(0);
}
const option = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return fallback;
	if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${name} requires a value`);
	return args[i + 1];
};
const allowed = new Set(['--out', '--config', '--iterations', '--seed', '--sim', '--engine-provenance', '--profiles', '--durations', '--frozen']);
for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}`);
const configPath = path.resolve(option('config', path.join(root, 'tools/dps-experiments/baseline.json')));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (args.includes('--frozen')) config.frozenRun = path.resolve(option('frozen'));
config.iterations = Number(option('iterations', config.iterations));
config.seed = Number(option('seed', config.seed));
config.durations = String(option('durations', config.durations.join(',')))
	.split(',')
	.map(Number);
if (
	!Number.isSafeInteger(config.seed) ||
	config.seed <= 0 ||
	!Number.isSafeInteger(config.iterations) ||
	config.iterations < 2 ||
	config.durations.some(n => !Number.isFinite(n) || n <= 0) ||
	new Set(config.durations).size !== config.durations.length
)
	throw new Error('Use a positive integer seed, at least two iterations, and unique positive durations.');
const startedAt = new Date().toISOString();
const out = path.resolve(option('out', path.join(root, 'tmp/dps-experiments', startedAt.replace(/[:.]/g, '-'))));
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`Output directory must be empty: ${out}`);
for (const name of ['requests', 'results', 'logs', 'debug', 'engine', 'stats']) fs.mkdirSync(path.join(out, name), { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourcePaths = git(
	'ls-files',
	'-z',
	'--',
	'sim',
	'proto',
	'ui',
	'assets/database',
	'assets/db_inputs/spell_store_inputs.json',
	'go.mod',
	'go.sum',
	'package.json',
	'package-lock.json',
	'tsconfig.json',
)
	.split('\0')
	.filter(Boolean)
	.sort();
const sourceFiles = Object.fromEntries(sourcePaths.map(file => [file, fileHash(path.join(root, file))]));
const runnerPaths = fs
	.readdirSync(path.join(root, 'tools/dps-experiments'))
	.filter(name => fs.statSync(path.join(root, 'tools/dps-experiments', name)).isFile())
	.sort();
const runnerFiles = Object.fromEntries(runnerPaths.map(name => [name, fileHash(path.join(root, 'tools/dps-experiments', name))]));
const packed = fs.readFileSync(path.join(root, 'assets/db_inputs/spell_store_inputs.json'));
const spellInputs = JSON.parse(packed[0] === 31 ? gunzipSync(packed) : packed);
const go = process.env.GO_BINARY ?? (process.platform === 'win32' && fs.existsSync('C:/Program Files/Go/bin/go.exe') ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const native = path.resolve(option('sim', path.join(out, 'engine', process.platform === 'win32' ? 'wowsimcli.exe' : 'wowsimcli')));
if (!args.includes('--sim')) {
	console.log('Building the native simulator with with_db...');
	const built = spawnSync(go, ['build', '-tags', 'with_db', '-o', native, './cmd/wowsimcli'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	fs.writeFileSync(path.join(out, 'logs/build.log'), `${built.stdout ?? ''}${built.stderr ?? ''}`);
	if (built.status !== 0) throw new Error(`Build failed; see ${path.join(out, 'logs/build.log')}`);
}
const statsDriver = path.join(out, 'engine', process.platform === 'win32' ? 'stats.exe' : 'stats');
execFileSync(go, ['build', '-tags=with_db', '-buildvcs=false', '-o', statsDriver, './tools/dps-experiments/stats'], { cwd: root, encoding: 'utf8' });
const provenance = {
	schemaVersion: 1,
	name: config.name,
	startedAt,
	command: process.argv.slice(1),
	git: {
		commit: git('rev-parse', 'HEAD'),
		upstreamCommit: git('rev-parse', 'origin/master'),
		upstreamSourceCommit: git('merge-base', 'HEAD', 'origin/master'),
		branch: git('branch', '--show-current'),
		subject: git('log', '-1', '--format=%s'),
		commitDate: git('log', '-1', '--format=%cI'),
		status: git('status', '--porcelain=v1'),
		diffSha256: hash(git('diff', 'HEAD', '--', 'sim', 'proto', 'ui', 'assets', 'go.mod', 'go.sum')),
	},
	gameBuilds: spellInputs.Builds,
	hotfixes: spellInputs.Hotfixes,
	environment: {
		node: process.version,
		go: execFileSync(go, ['version'], { encoding: 'utf8' }).trim(),
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model,
		logicalCpus: os.cpus().length,
		hostname: os.hostname(),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	},
	engine: {
		path: native,
		sha256: fileHash(native),
		statsSha256: fileHash(statsDriver),
		reused: args.includes('--sim'),
		buildInfo: execFileSync(go, ['version', '-m', native], { encoding: 'utf8' }),
	},
	config,
	configSha256: fileHash(configPath),
	sourceSha256: hash(JSON.stringify(sourceFiles)),
	sourceFiles,
	runnerSha256: hash(JSON.stringify(runnerFiles)),
	runnerFiles,
	method: {
		profiles:
			'Every named DPS build preset, uncovered talent presets with spec defaults, and distinct spec defaults. Settings and rotations are resolved by the UI domain code.',
		support:
			'The common buffs and debuffs in baseline.json replace profile external support. Preset gear, consumables, race, professions, self abilities, and reaction times remain.',
		seed: 'Every profile uses the same starting seed. Cross-build uncertainty is reported separately; no paired cross-class significance is assumed.',
		scope: 'One level 63 mechanical target, 3731 armor, fixed duration, no tank, no incoming boss damage. Player movement required by a preset remains enabled.',
		uncertainty:
			'Pointwise approximate 95% Monte Carlo confidence intervals for each mean. These intervals do not measure model error or correct for multiple comparisons.',
	},
};
const saveJson = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
if (args.includes('--engine-provenance')) {
	if (!args.includes('--sim')) throw new Error('--engine-provenance requires --sim.');
	const recorded = JSON.parse(fs.readFileSync(path.resolve(option('engine-provenance')), 'utf8'));
	if (recorded.engine.sha256 !== provenance.engine.sha256) throw new Error('Supplied engine differs from its provenance.');
	for (const [file, expected] of Object.entries(recorded.sourceFiles))
		if (fileHash(path.join(root, file)) !== expected) throw new Error('Supplied engine source differs: ' + file);
	provenance.model = recorded.model;
	provenance.engineSourceProvenance = path.resolve(option('engine-provenance'));
}
saveJson('provenance.json', provenance);
const loaded = await loadProfiles(root, config);
if (config.frozenRun) {
	const prior = JSON.parse(fs.readFileSync(path.join(config.frozenRun, 'provenance.json'), 'utf8'));
	if (prior.config.seed !== config.seed || prior.config.iterations !== config.iterations)
		throw new Error('A frozen comparison requires the reference seed and iteration count.');
	provenance.frozenReference = {
		directory: config.frozenRun,
		commit: prior.git.commit,
		provenanceSha256: fileHash(path.join(config.frozenRun, 'provenance.json')),
	};
	provenance.method.profiles =
		'Saved reference profiles and exact requests, validated against the current schema. The native simulator loads the current item database.';
	provenance.schemaChanges = [];
	const currentItems = new Set(JSON.parse(fs.readFileSync(path.join(root, 'assets/database/db.json'), 'utf8')).items.map(item => item.id));
	provenance.frozenUnavailable = [];
	loaded.profiles = loaded.profiles.filter(profile => {
		const player = profile.player;
		const suppliedItems = new Set((player.database?.items ?? []).map(item => item.id));
		const equipment = [...player.equipment.items, ...(player.enableItemSwap ? player.itemSwap.items : [])];
		const missingItems = [...new Set(equipment.filter(item => item.id && !currentItems.has(item.id) && !suppliedItems.has(item.id)).map(item => item.id))];
		if (!missingItems.length) return true;
		provenance.frozenUnavailable.push({
			id: profile.id,
			name: profile.name,
			missingItems,
			reason: 'Saved equipment IDs are absent from the current simulator database. No replacement gear was selected.',
		});
		return false;
	});
	if (!loaded.profiles.length) throw new Error('No saved profiles have equipment supported by the current database.');
	saveJson('unavailable-profiles.json', provenance.frozenUnavailable);
}
const presetAudit = auditProfiles(loaded.profiles, root, config);
saveJson('preset-audit.json', presetAudit);
if (config.referenceRun) {
	const referenceRoot = path.resolve(root, config.referenceRun);
	const prior = JSON.parse(fs.readFileSync(path.join(referenceRoot, 'provenance.json'), 'utf8'));
	if (prior.sourceSha256 !== provenance.sourceSha256) throw new Error('Reference simulator/UI/data sources differ from this checkout.');
	if (prior.config.seed !== config.seed || prior.config.iterations !== config.iterations)
		throw new Error('A matched gear comparison requires the reference seed and iteration count.');
	provenance.reference = {
		directory: referenceRoot,
		provenanceSha256: fileHash(path.join(referenceRoot, 'provenance.json')),
		summarySha256: fileHash(path.join(referenceRoot, 'summary.json')),
		commit: prior.git.commit,
		sourceSha256: prior.sourceSha256,
	};
	provenance.gearPolicy = loaded.gearPolicy;
	provenance.gearRoleWeights = loaded.gearRoleWeights;
	provenance.eligiblePoolSize = loaded.eligiblePoolSize;
	provenance.gearPolicySha256 = fileHash(path.resolve(root, config.gearPolicy));
	provenance.method.profiles = 'Frozen profiles and requests from the reference run; only equipment and swap equipment change.';
	provenance.method.support =
		'All non-gear player fields, resolved rotations, consumables, raid support and encounters are frozen from the reference requests.';
	saveJson('gear-audit.json', {
		policy: loaded.gearPolicy,
		roleWeights: loaded.gearRoleWeights,
		eligiblePoolSize: loaded.eligiblePoolSize,
		profiles: loaded.profiles.map(profile => ({ id: profile.id, role: profile.gearRole, meanIlvl: profile.gearMeanIlvl, slots: profile.gearAudit })),
	});
	saveJson('provenance.json', provenance);
}
let profiles = loaded.profiles;
const filter = option('profiles', '');
if (filter) {
	const ids = new Set(filter.split(','));
	profiles = profiles.filter(profile => ids.has(profile.id));
	if (profiles.length !== ids.size) throw new Error('A requested profile was not exported.');
}
if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Profile identifiers are not unique.');
const rows = [];
const failures = [];
const makeRequest = (profile, duration, iterations, debug) => {
	if (config.referenceRun || config.frozenRun) {
		const infile = path.resolve(root, config.referenceRun ?? config.frozenRun, 'requests', `${profile.id}--${duration}s.json`);
		const frozen = JSON.parse(fs.readFileSync(infile, 'utf8'));
		const request = structuredClone(frozen);
		const player = request.raid.parties[0].players[0];
		if (config.referenceRun) {
			player.equipment = structuredClone(profile.player.equipment);
			if (player.enableItemSwap) player.itemSwap.items = structuredClone(profile.player.itemSwap.items);
		}
		request.simOptions.iterations = iterations;
		request.simOptions.debug = debug;
		request.simOptions.debugFirstIteration = false;
		const validated = loaded.validateRequest(request);
		if (config.frozenRun && !debug && JSON.stringify(validated) !== JSON.stringify(frozen)) {
			// Compare parsed objects because protobuf serialization also changes key order.
			const changes = changedPaths(frozen, validated);
			if (changes.length && !debug) provenance.schemaChanges.push({ profileId: profile.id, duration, paths: changes });
			const gameplayChanges = changes.filter(key => !key.includes('.rotation.simple'));
			if (gameplayChanges.length) throw new Error(`Frozen request schema changed: ${gameplayChanges.join(', ')}`);
		}
		return validated;
	}
	const stats = Array(28).fill(0);
	stats[27] = config.target.armor;
	return loaded.validateRequest({
		type: 'SimTypeIndividual',
		raid: {
			parties: [{ players: [{ ...profile.player, buffs: config.individualBuffs }], buffs: config.partyBuffs }],
			buffs: config.raidBuffs,
			debuffs: config.debuffs,
			tanks: [],
		},
		encounter: {
			duration,
			durationVariation: 0,
			executeProportion20: config.executeProportion20,
			executeProportion35: config.executeProportion35,
			useHealth: false,
			targets: [{ level: config.target.level, name: 'Stationary baseline target', mobType: config.target.mobType, stats, tankIndex: -1 }],
		},
		simOptions: { iterations, randomSeed: String(config.seed), saveAllValues: true, debug, debugFirstIteration: false },
	});
};
const signatures = new Map();
const duplicateProfiles = [];
profiles = profiles.filter(profile => {
	const request = makeRequest(profile, config.durations[0], config.iterations, false);
	const signature = resolvedRequestKey(request);
	if (!config.frozenRun && signatures.has(signature)) {
		duplicateProfiles.push({ ...profile, duplicateOf: signatures.get(signature) });
		return false;
	}
	signatures.set(signature, profile.id);
	return true;
});
saveJson('profiles.json', { schemaVersion: 1, apiVersion: loaded.apiVersion, profiles, duplicateProfiles, specPaths: loaded.specPaths });
saveJson('provenance.json', provenance);
console.log(`${profiles.length} profiles x ${config.durations.join('/')} seconds x ${config.iterations.toLocaleString()} iterations`);
for (const profile of profiles) {
	let debugWarnings = [];
	for (const duration of config.durations) {
		const key = `${profile.id}--${duration}s`;
		try {
			if (duration === config.durations[0]) {
				const debugRequest = makeRequest(profile, Math.max(...config.durations), 1, true);
				const infile = path.join(out, 'debug', `${profile.id}.request.json`);
				const outfile = path.join(out, 'debug', `${profile.id}.result.json`);
				fs.writeFileSync(infile, JSON.stringify(debugRequest));
				const run = spawnSync(native, ['sim', '--infile', infile, '--outfile', outfile], { cwd: root, encoding: 'utf8', timeout: 120000 });
				if (run.status !== 0) throw new Error(run.error?.message ?? run.stderr);
				const debugResult = JSON.parse(fs.readFileSync(outfile, 'utf8'));
				if (debugResult.error) throw new Error(debugResult.error.message);
				debugWarnings = (debugResult.logs ?? '').split('\n').filter(line => /warning|invalid|unknown spell|not implemented|failed/i.test(line));
			}
			const request = makeRequest(profile, duration, config.iterations, false);
			const infile = path.join(out, 'requests', `${key}.json`);
			const outfile = path.join(out, 'results', `${key}.json`);
			fs.writeFileSync(infile, JSON.stringify(request));
			if (duration === config.durations[0]) {
				execFileSync(statsDriver, [infile, path.join(out, 'stats', `${profile.id}--${profile.race}--${duration}s.json`)], {
					cwd: root,
					encoding: 'utf8',
				});
			}
			const begin = performance.now();
			const run = spawnSync(native, ['sim', '--infile', infile, '--outfile', outfile], { cwd: root, encoding: 'utf8', timeout: 600000 });
			fs.writeFileSync(path.join(out, 'logs', `${key}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`);
			if (run.status !== 0) throw new Error(run.error?.message ?? run.stderr);
			const result = JSON.parse(fs.readFileSync(outfile, 'utf8'));
			const summary = summarizeResult(result, config.iterations);
			const row = {
				profileId: profile.id,
				className: profile.className,
				specPath: profile.specPath,
				buildName: profile.name,
				gearName: profile.gearName,
				race: profile.race,
				duration,
				...summary,
				rankEligible: profile.rankEligible,
				profileWarnings: profile.warnings,
				debugWarnings,
				requestSha256: fileHash(infile),
				resultSha256: fileHash(outfile),
				elapsedSeconds: (performance.now() - begin) / 1000,
			};
			rows.push(row);
			console.log(
				`[${rows.length + failures.length}/${profiles.length * config.durations.length}] ${key}: ${row.meanDps.toFixed(2)} +/- ${row.ci95HalfWidth.toFixed(2)} DPS${row.rankEligible ? '' : ' [diagnostic only]'}`,
			);
		} catch (error) {
			failures.push({ profileId: profile.id, duration, error: error.message });
			console.error(`${key}: ${error.message.split('\n')[0]}`);
		}
		saveJson('summary.json', { rows, failures });
	}
}
saveJson('summary.json', { rows, failures });
fs.writeFileSync(path.join(out, 'summary.csv'), csv(rows));
provenance.finishedAt = new Date().toISOString();
provenance.completedRuns = rows.length;
provenance.failedRuns = failures.length;
provenance.sourceUnchangedDuringRun = sourcePaths.every(file => fileHash(path.join(root, file)) === sourceFiles[file]);
saveJson('provenance.json', provenance);
console.log(`Saved ${rows.length} runs and ${failures.length} failures to ${out}`);
if (failures.length || !provenance.sourceUnchangedDuringRun) process.exitCode = 1;
