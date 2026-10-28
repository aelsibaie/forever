import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadProfiles } from './export.mjs';
import { eligibleRaces, factionPlayer } from './racial_helpers.mjs';
import { equipmentCapabilities, validateEquipment } from './gear_catalog.mjs';
import { auditProfiles } from './preset_audit.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2),
	opts = {};
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--require-full-published') {
		opts.requireFullPublished = true;
		continue;
	}
	assert(['--out', '--gear-catalog'].includes(args[i]) && args[i + 1], 'Use --out new-directory [--gear-catalog file] [--require-full-published].');
	opts[args[i].slice(2)] = args[++i];
}
assert(opts.out, 'Supply --out with a new output directory.');
const out = path.resolve(opts.out);
assert(!fs.existsSync(out), 'Use a new output directory.');
for (const dir of ['requests', 'stats']) fs.mkdirSync(path.join(out, dir), { recursive: true });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const binary = path.join(out, process.platform === 'win32' ? 'stats.exe' : 'stats');
run(go, ['build', '-tags=with_db', '-buildvcs=false', '-trimpath', '-o', binary, './tools/dps-experiments/stats']);
const loaded = await loadProfiles(root),
	policy = read(path.join(root, 'tools/dps-experiments/racial-policy.json'));
const config = read(path.join(root, 'tools/dps-experiments/baseline.json'));
const databaseFile = path.join(root, 'assets/database/db.json'),
	database = read(databaseFile),
	databaseSha256 = hash(fs.readFileSync(databaseFile));
const catalog = opts['gear-catalog'] ? read(path.resolve(opts['gear-catalog'])) : null;
if (catalog)
	assert.deepEqual(
		catalog.policy,
		read(path.join(root, 'tools/dps-experiments/gear-catalog-policy.json')),
		'Gear-source mappings changed; refresh the catalogue.',
	);
if (catalog)
	assert.equal(catalog.databaseSha256, databaseSha256, 'The equipment catalogue is stale. Refresh it against the current native database before running.');
const equipmentDatabase = {
	...database,
	items: [...database.items, ...read(path.join(root, 'assets/database/leftover_db.json')).items],
	enchants: [...database.enchants, ...read(path.join(root, 'assets/database/leftover_db.json')).enchants],
};
const capabilities = equipmentCapabilities(root);
const profileAudit = auditProfiles(loaded.profiles, root, config);
fs.writeFileSync(path.join(out, 'profiles.json'), JSON.stringify(loaded, null, 2));
fs.writeFileSync(path.join(out, 'preset-audit.json'), JSON.stringify(profileAudit, null, 2));
const equipmentCoverage = [];
const rows = [],
	errors = [],
	missingPublished = [];
for (const profile of loaded.profiles)
	for (const faction of ['horde', 'alliance']) {
		let player, races;
		try {
			({ player } = factionPlayer(profile.player, faction, database, policy));
			races = eligibleRaces(profile.className, faction, loaded.racesByClass, policy);
		} catch (error) {
			errors.push({ profile: profile.id, faction, error: error.message });
			continue;
		}
		const spec = catalog?.policy.profiles[profile.id];
		if (catalog && !spec) errors.push({ profile: profile.id, faction, error: 'No reviewed equipment-source mapping.' });
		const gearOptions = {
			database: equipmentDatabase,
			capabilities,
			className: profile.className,
			faction,
			daggerPair: /-(asn|combat)-muti$/.test(profile.id),
		};
		const check = equipment => {
			try {
				const padded = structuredClone(equipment);
				while (padded.items.length < 17) padded.items.push({});
				validateEquipment(padded, gearOptions);
				return { valid: true };
			} catch (error) {
				return { valid: false, reason: error.message };
			}
		};
		const developer = check(player.equipment);
		const published = catalog?.sets.filter(s => s.spec === spec && s.faction === faction).map(s => ({ id: s.id, ...check(s.equipment) })) ?? [];
		const alternatives = [];
		for (const source of catalog?.policy.additionalDeveloperSets?.[profile.id] ?? []) {
			const bytes = fs.readFileSync(path.join(root, source));
			try {
				const equipment = JSON.parse(bytes);
				const converted = factionPlayer({ ...profile.player, equipment }, faction, equipmentDatabase, policy);
				alternatives.push({ source, sha256: hash(bytes), ...check(converted.player.equipment) });
			} catch (error) {
				alternatives.push({ source, sha256: hash(bytes), valid: false, reason: error.message });
			}
		}
		if (catalog && !developer.valid && !alternatives.some(s => s.valid))
			errors.push({ profile: profile.id, faction, error: 'No legal developer reference; supply a reviewed developer alternative.' });
		equipmentCoverage.push({
			profile: profile.id,
			className: profile.className,
			specLabel: profile.specLabel,
			faction,
			legalRaces: races,
			gearName: profile.gearName,
			gearTier: profile.gearTier,
			developer,
			spec: spec ?? null,
			published,
			additionalDeveloper: alternatives,
			sourceRejections: catalog?.rejected.filter(s => s.spec === spec && s.faction === faction) ?? [],
		});
		if (catalog && !published.some(s => s.valid))
			missingPublished.push({
				profile: profile.id,
				faction,
				spec: spec ?? null,
				reason: spec ? 'No compatible published equipment.' : 'Source mapping missing.',
			});
		for (const race of races) {
			const p = structuredClone(player);
			p.race = race;
			p.buffs = { ...p.buffs, ...config.individualBuffs };
			const q = loaded.validateRequest({
				raid: { buffs: config.raidBuffs, debuffs: config.debuffs, parties: [{ buffs: config.partyBuffs, players: [p] }] },
				encounter: { duration: 180, targets: [{ level: 63, mobType: 'MobTypeMechanical', stats: [...Array(27).fill(0), 3731], tankIndex: -1 }] },
				simOptions: { iterations: 1, randomSeed: '2026102801' },
			});
			const key = [faction, profile.id, race].join('--'),
				input = path.join(out, 'requests', key + '.json'),
				result = path.join(out, 'stats', key + '.json');
			fs.writeFileSync(input, JSON.stringify(q));
			try {
				run(binary, [input, result]);
				const stats = read(result);
				rows.push({
					profile: profile.id,
					faction,
					race,
					developerRankEligible: profile.rankEligible,
					requestSha256: hash(fs.readFileSync(input)),
					statsSha256: hash(fs.readFileSync(result)),
					playerStatsKeys: Object.keys(stats.raidStats.parties[0].players[0]),
				});
			} catch (error) {
				errors.push({ profile: profile.id, faction, race, error: error.message.slice(0, 1000) });
			}
		}
	}
const report = {
	createdAt: new Date().toISOString(),
	head: run('git', ['rev-parse', 'HEAD']).trim(),
	upstream: run('git', ['rev-parse', 'origin/master']).trim(),
	workingTree: run('git', ['status', '--porcelain']),
	databaseSha256,
	profiles: loaded.profiles.length,
	nativeMetadataCases: rows.length,
	readyForDeveloperRun: errors.length === 0,
	readyForLegalDeveloperBaseline: errors.length === 0 && equipmentCoverage.every(r => r.developer.valid),
	equipmentCoverage,
	readyForCompletePublishedPool: !!catalog && errors.length === 0 && missingPublished.length === 0,
	missingPublished,
	errors,
	rows,
	scope: 'Schema, faction gear, equipment legality and native metadata coverage. Invalid developer equipment remains diagnostic and is listed. No DPS iterations or ranking estimates; runtime rotation validation and independent samples remain required.',
};
fs.writeFileSync(path.join(out, 'readiness.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rows: undefined, equipmentCoverage: undefined, workingTree: undefined }, null, 2));
if (errors.length || (opts.requireFullPublished && !report.readyForCompletePublishedPool)) process.exitCode = 1;
