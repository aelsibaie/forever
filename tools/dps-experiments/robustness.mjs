import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfiles } from './export.mjs';
import { hash, signature, factionPlayer, eligibleRaces, racialMetrics, offensiveRacial } from './racial_helpers.mjs';
import { summarizeResult, resolvedRequestKey } from './statistics.mjs';
import { equipmentCapabilities, validateEquipment, externalLoadoutFromList } from './gear_catalog.mjs';
import { statIndexes } from './shadow_translation.mjs';
import { makeRobustRequest, prepareRobustPlayer, rankRaceSamples, walkObjects, resolveUnavailableReferences, referenceEquipmentSet } from './robust_logic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2),
	opts = {};
const flags = new Set(['resume', 'preflight-only']);
const valued = new Set([
	'source-racials',
	'gear-catalog',
	'gunba-source',
	'out',
	'workers',
	'screen-iterations',
	'validation-iterations',
	'confirmation-iterations',
	'precision-iterations',
	'profiles-file',
]);
for (let i = 0; i < args.length; i++) {
	const name = args[i].replace(/^--/, '');
	if (flags.has(name)) opts[name] = true;
	else if (valued.has(name) && args[i + 1] && !args[i + 1].startsWith('--')) opts[name] = args[++i];
	else throw new Error(`Unknown or incomplete option ${args[i]}`);
}
if (!opts['source-racials'] || !opts['gear-catalog'] || !opts.out)
	throw new Error(
		'Usage: node tools/dps-experiments/robustness.mjs --source-racials saved-run/racials --gear-catalog catalog.json --out new-directory [--resume] [--gunba-source directory] [--preflight-only]',
	);
const source = path.resolve(opts['source-racials']),
	out = path.resolve(opts.out);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fileHash = file => hash(fs.readFileSync(file));
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const settings = {
	workers: Number(opts.workers ?? 8),
	screenIterations: Number(opts['screen-iterations'] ?? 250),
	validationIterations: Number(opts['validation-iterations'] ?? 1000),
	confirmationIterations: Number(opts['confirmation-iterations'] ?? 5000),
	precisionIterations: Number(opts['precision-iterations'] ?? 20000),
	screenSeed: 2026102801,
	validationSeed: 3026102801,
	confirmationSeed: 4026102801,
	precisionSeed: 5026102801,
	durations: [60, 180, 300],
	supports: ['full', 'self'],
	referencePolicies: ['developer', 'explicit'],
	tolerancePercent: 0.2,
};
for (const key of ['workers', 'screenIterations', 'validationIterations', 'confirmationIterations', 'precisionIterations'])
	if (!Number.isSafeInteger(settings[key]) || settings[key] < (key === 'workers' ? 1 : 2)) throw new Error(`Invalid ${key}.`);
if (
	settings.workers > 32 ||
	Math.max(settings.screenIterations, settings.validationIterations, settings.confirmationIterations, settings.precisionIterations) >= 1e9
)
	throw new Error('Worker count or seed range is out of bounds.');
const prior = read(path.join(source, 'provenance.json'));
const referenceCli = path.join(source, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim');
if (fileHash(referenceCli) !== prior.engine.sha256) throw new Error('The reference CLI binary hash does not match its archive.');
for (const [file, expected] of Object.entries(prior.sourceFiles))
	if (!file.startsWith('tools/dps-experiments/') && fileHash(path.join(root, file)) !== expected)
		throw new Error(`The source archive does not match this checkout: ${file}`);
const gearCatalog = read(path.resolve(opts['gear-catalog']));
const identity = signature({
	settings,
	nativeSource: prior.snapshot.sourceSha256,
	model: prior.model,
	gearCatalog: fileHash(path.resolve(opts['gear-catalog'])),
	gunbaSource: opts['gunba-source'] ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(opts['gunba-source']), encoding: 'utf8' }).trim() : null,
});
if (fs.existsSync(path.join(out, 'provenance.json'))) {
	if (!opts.resume) throw new Error('Output exists; use --resume for an identical study.');
	if (read(path.join(out, 'provenance.json')).identity !== identity)
		throw new Error('Study settings, source or gear catalogue changed. Use a new output directory.');
}
for (const dir of ['requests', 'results', 'stats', 'engine', 'logs', 'exports']) fs.mkdirSync(path.join(out, dir), { recursive: true });
const save = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const batch = path.join(out, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch');
if (!opts.resume || !fs.existsSync(batch)) {
	const build = ['build', '-tags=with_db', '-buildvcs=false'];
	if (fs.existsSync(path.join(source, 'engine/overlay.json'))) build.push('-overlay', path.join(source, 'engine/overlay.json'));
	const r = spawnSync(go, [...build, '-o', batch, './tools/dps-experiments/robust-sim'], { cwd: root, encoding: 'utf8' });
	fs.writeFileSync(path.join(out, 'logs/build.log'), (r.stdout ?? '') + (r.stderr ?? ''));
	if (r.status !== 0) throw new Error('Batch driver build failed.');
}
const provenance = {
	identity,
	startedAt: new Date().toISOString(),
	sourceRun: source,
	sourceCommit: prior.snapshot.upstreamSourceCommit,
	analyticsCommit: git('rev-parse', 'HEAD'),
	status: git('status', '--short'),
	model: prior.model,
	gameBuilds: prior.gameBuilds,
	hotfixes: prior.hotfixes,
	sourceSha256: prior.snapshot.sourceSha256,
	sourceFiles: prior.sourceFiles,
	engineSha256: fileHash(batch),
	referenceCliSha256: prior.engine.sha256,
	settings,
	gearCatalogSha256: fileHash(path.resolve(opts['gear-catalog'])),
	toolHashes: Object.fromEntries(
		['robustness.mjs', 'robust_logic.mjs', 'gear_catalog.mjs', 'gear-catalog-policy.json', 'robust-sim/main.go', 'hunter_ranged_probe.mjs'].map(file => [
			file,
			fileHash(path.join(root, 'tools/dps-experiments', file)),
		]),
	),
	statisticalScope:
		'Monte Carlo intervals exclude uncertainty in game rules. Racial policies use screening samples; gear selection uses validation samples. Recommendations use disjoint validation and confirmation seed ranges. Scenario counts are coverage, never estimated probabilities of being best.',
	raidRule: {
		source: 'https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-%E2%80%93-updated-october-26/2360696/8',
		rule: 'Attuned and Charged are removed on raid entry; tag-1 casts are changed to the plain racial.',
	},
};
if (opts.resume && read(path.join(out, 'provenance.json')).engineSha256 !== provenance.engineSha256) throw new Error('The batch binary changed.');
if (opts.resume && read(path.join(out, 'provenance.json')).toolHashes['robust-sim/main.go'] !== provenance.toolHashes['robust-sim/main.go'])
	throw new Error('The batch driver source changed. Build a new study.');
if (!opts.resume) save('provenance.json', provenance);
const executionRevision = { recordedAt: new Date().toISOString(), policy: 'racial-policies-v3-source-ammo', toolHashes: provenance.toolHashes };
const revisionFile = path.join(out, 'execution-revisions.json');
const revisions = fs.existsSync(revisionFile) ? read(revisionFile) : [];
if (!revisions.some(r => signature(r.toolHashes) === signature(executionRevision.toolHashes))) {
	revisions.push(executionRevision);
	save('execution-revisions.json', revisions);
}
for (const [file, expected] of Object.entries(provenance.toolHashes)) {
	const destination = path.join(out, 'tooling', expected, file);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(path.join(root, 'tools/dps-experiments', file), destination);
}
fs.copyFileSync(path.resolve(opts['gear-catalog']), path.join(out, 'gear-catalog-input.json'));
save('methodology.json', {
	policy: executionRevision.policy,
	statisticalScope: provenance.statisticalScope,
	settings,
	engineSha256: provenance.engineSha256,
	gearCatalogSha256: provenance.gearCatalogSha256,
	toolHashes: provenance.toolHashes,
});
const status = phase => {
	save('status.json', { phase, updatedAt: new Date().toISOString() });
	console.log('PHASE ' + phase);
};
const exported = opts['profiles-file']
	? read(path.resolve(opts['profiles-file']))
	: await loadProfiles(root, read(path.join(root, 'tools/dps-experiments/baseline.json')));
save('source-profiles.json', exported);
const policy = read(path.join(root, 'tools/dps-experiments/racial-policy.json'));
const mainDb = read(path.join(root, 'assets/database/db.json')),
	leftovers = read(path.join(root, 'assets/database/leftover_db.json'));
const database = { ...mainDb, items: [...mainDb.items, ...leftovers.items], enchants: [...mainDb.enchants, ...leftovers.enchants] };
const capabilities = equipmentCapabilities(root),
	profiles = [],
	aliases = [],
	rejected = [];
const baseConfig = read(path.join(root, 'tools/dps-experiments/baseline.json'));
const common = fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8'),
	statsEnum = statIndexes(common),
	pseudoEnum = statIndexes(common, 'PseudoStat');
const professionNames = Object.fromEntries(
	[
		...common
			.split('enum Profession {')[1]
			.split('\n}')[0]
			.matchAll(/\b(\w+)\s*=\s*(\d+)/g),
	].map(m => [Number(m[2]), m[1]]),
);
const nativeItems = new Map(database.items.map(item => [item.id, item]));
const hunterProto = fs.readFileSync(path.join(root, 'proto/hunter.proto'), 'utf8');
const hunterEnum = name =>
	Object.fromEntries(
		[...hunterProto.match(new RegExp('enum ' + name + '\\s*\\{([^}]+)\\}'))[1].matchAll(/\b(\w+)\s*=\s*(\d+)/g)].map(m => [Number(m[2]), m[1]]),
	);
const hunterAmmo = hunterEnum('Ammo'),
	hunterQuivers = hunterEnum('QuiverBonus');
let gunba = null;
if (opts['gunba-source']) gunba = read(path.resolve(opts['gunba-source'], 'artifacts/forever_dps_5min.json')).Results;
const gunbaKey = {
	'druid/balance': 'balance',
	'druid/feral-dps': 'feral',
	'hunter/beast-mastery': 'beast_mastery',
	'hunter/bm-weave': 'beast_mastery',
	'hunter/marksmanship': 'marksmanship',
	'hunter/mm-weave': 'marksmanship',
	'hunter/survival': 'survival',
	'hunter/sv-weave': 'pet_melee',
	'hunter/survival-melee': 'pet_melee',
	'mage/arcane': 'arcane',
	'mage/arcane-fire': 'arcane',
	'mage/frostfire': 'fire',
	'mage/fire': 'fire',
	'mage/frost': 'frost',
	'paladin/retribution': 'retribution',
	'paladin/holy-shock': 'retribution',
	'priest/shadow': 'shadow',
	'priest/smite': 'smite',
	'rogue/assassination': 'mutilate',
	'rogue/combat-mutilate': 'mutilate',
	'rogue/combat': 'combat',
	'rogue/combat-daggers': 'combat',
	'rogue/subtlety': 'subtlety',
	'rogue/subtlety-backstab': 'subtlety',
	'shaman/elemental': 'elemental',
	'shaman/enhancement': 'enhancement',
	'warlock/demonology': 'demonology',
	'warlock/demonology-shadow': 'demonology',
	'warlock/destruction': 'destruction',
	'warlock/affliction': 'affliction',
	'warlock/sm-ruin': 'ds_ruin',
	'warrior/arms': 'arms',
	'warrior/fury': 'fury',
};
for (const faction of ['horde', 'alliance']) {
	const seen = new Map();
	for (const original of exported.profiles) {
		if (original.warnings?.some(w => /Talent prerequisites/.test(w))) {
			rejected.push({ profile: original.id, faction, reason: 'Invalid talent prerequisites.' });
			continue;
		}
		let converted;
		try {
			converted = factionPlayer(original.player, faction, database, policy);
		} catch (error) {
			rejected.push({ profile: original.id, faction, reason: error.message });
			continue;
		}
		const races = eligibleRaces(original.className, faction, exported.racesByClass, policy);
		const player = converted.player;
		player.race = races[0];
		const sig = resolvedRequestKey({ raid: { parties: [{ players: [player] }] } });
		if (seen.has(sig)) {
			aliases.push({ id: original.id, faction, sameAs: seen.get(sig) });
			continue;
		}
		seen.set(sig, original.id);
		const spec = gearCatalog.policy.profiles[original.id];
		if (!spec) throw new Error(`No reviewed source mapping for ${original.id}.`);
		const p = { ...original, player, faction, races, spec, sets: [], substitutions: converted.substitutions };
		const setSeen = new Map();
		function addSet(gear) {
			try {
				const equipment = structuredClone(gear.equipment);
				while (equipment.items.length < 17) equipment.items.push({});
				const audit = validateEquipment(equipment, {
					database,
					capabilities,
					className: p.className,
					faction,
					daggerPair: /-(asn|combat)-muti$/.test(p.id),
				});
				const prepared = prepareRobustPlayer(player, { race: races[0], className: p.className, gear: { ...gear, equipment } }).player;
				const activeProfessions = new Set([prepared.profession1, prepared.profession2]);
				for (const entry of equipment.items) {
					const item = nativeItems.get(entry.id);
					if (item?.requiredProfession && !activeProfessions.has(professionNames[item.requiredProfession]))
						throw new Error(`Item ${entry.id} needs ${professionNames[item.requiredProfession] ?? 'an unknown profession'}.`);
					for (const enchant of database.enchants.filter(e => e.effectId === entry.enchant && [e.type, ...(e.extraTypes ?? [])].includes(item?.type)))
						if (enchant.requiredProfession && !activeProfessions.has(professionNames[enchant.requiredProfession]))
							throw new Error(`Enchant ${entry.enchant} needs ${professionNames[enchant.requiredProfession] ?? 'an unknown profession'}.`);
				}
				if (/rogue.*-bs$/.test(p.id) && database.items.find(x => x.id === equipment.items[14].id)?.weaponType !== 2)
					throw new Error('The Backstab build needs a main-hand dagger.');
				const k = p.className === 'Hunter' ? signature({ equipment, options: prepared.hunter.options.classOptions }) : signature(equipment);
				if (setSeen.has(k)) {
					setSeen.get(k).aliases.push({ id: gear.id, origin: gear.origin, tier: gear.tier });
					return;
				}
				const row = { ...gear, equipment, audit, aliases: [] };
				p.sets.push(row);
				setSeen.set(k, row);
			} catch (error) {
				rejected.push({ profile: p.id, faction, set: gear.id, reason: error.message });
			}
		}
		addSet({
			id: 'developer',
			origin: 'WoWSims developer',
			tier: original.gearName,
			equipment: player.equipment,
			sourceUrl: `https://github.com/wowsims/forever/blob/${provenance.sourceCommit}/${original.source}`,
		});
		for (const file of gearCatalog.policy.additionalDeveloperSets[original.id] ?? []) {
			const equipment = read(path.join(root, file));
			try {
				const c = factionPlayer({ equipment }, faction, database, policy);
				addSet({
					id: 'developer-' + path.basename(file).replace('.gear.json', ''),
					origin: 'WoWSims developer',
					tier: /pre/.test(file) ? 'Developer pre-raid' : 'Developer P1',
					equipment: c.player.equipment,
					sourceUrl: `https://github.com/wowsims/forever/blob/${provenance.sourceCommit}/${file}`,
					substitutions: c.substitutions,
				});
			} catch (error) {
				rejected.push({ profile: p.id, faction, set: file, reason: error.message });
			}
		}
		for (const gear of gearCatalog.sets.filter(g => g.spec === spec && g.faction === faction)) {
			if (p.className !== 'Hunter') {
				addSet(gear);
				continue;
			}
			let external = gear.externalAmmoAndQuiver;
			if (spec === 'hunter/survival-melee' && !external?.find(item => item.slot === 'ammo')?.alternatives) {
				const archived = gearCatalog.sources.find(record => record.sha256 === gear.sourceSha256 && record.archive);
				if (!archived || fileHash(archived.archive) !== gear.sourceSha256)
					throw new Error('Refresh the catalogue to include source ammunition alternatives.');
				external = externalLoadoutFromList(read(archived.archive));
			}
			const sourceAmmo = external?.find(item => item.slot === 'ammo'),
				sourceQuiver = external?.find(item => item.slot === 'quiver');
			if (spec === 'hunter/survival-melee' && sourceAmmo?.id === 11630) {
				const pouch = external.find(item => item.slot === 'pouch'),
					alternative = sourceAmmo.alternatives[0];
				if (pouch?.id !== 8218 || alternative?.id !== 15997 || alternative.reportedStats.ranged_dps !== 17.5)
					throw new Error('Review the changed source melee Hunter loadout.');
				const nativeAmmoData = fs.readFileSync(path.join(root, 'sim/hunter/ammo_auto_gen.go'), 'utf8');
				if (!/"ThoriumHeadedArrow":\s*\{[^}]*DPS: 17\.5\}/.test(nativeAmmoData) || !/"QuickdrawQuiver":\s*\{[^}]*Haste: 13\}/.test(nativeAmmoData))
					throw new Error('Review the changed native ammunition/container effect values.');
				addSet({ ...gear, tier: 'Published equipment with developer ranged inputs', origin: 'Published gear / developer ammo-quiver control' });
				addSet({
					...gear,
					id: gear.id + '-source-ammo',
					nativeHunterOptions: { ammo: 'ThoriumHeadedArrow', quiverBonus: 'QuickdrawQuiver' },
					externalAmmoAndQuiver: external.map(item => (item.slot === 'ammo' ? { ...alternative, slot: 'ammo' } : item)),
					hunterCompatibilityMapping: {
						sourceAmmo: sourceAmmo.id,
						selectedAmmo: alternative.id,
						selectedAmmoName: alternative.name,
						sourceAlternativeRank: 1,
						nativeAmmoDps: 17.5,
						sourceContainer: pouch.id,
						nativeRangedHastePercent: 13,
					},
					hunterRepresentation:
						'The native enums list arrows and quivers. Thorium Shells, the first source-listed alternative to Rockshard Pellets, use the native 17.5-DPS arrow control. The crafted-container scenario uses the native 13% control for the source pouch. These effect translations retain the source bullet/pouch identity; website option names differ. The ranged-input diagnostics show that these settings affect this melee preset.',
				});
				continue;
			}
			if (!hunterAmmo[sourceAmmo?.id] || !hunterQuivers[sourceQuiver?.id]) throw new Error(`Unrepresented published Hunter loadout: ${gear.id}`);
			addSet({ ...gear, tier: 'Published equipment with developer ranged inputs', origin: 'Published gear / developer ammo-quiver control' });
			addSet({
				...gear,
				id: gear.id + '-source-ammo',
				nativeHunterOptions: { ammo: hunterAmmo[sourceAmmo.id], quiverBonus: hunterQuivers[sourceQuiver.id] },
			});
		}
		if (gunba)
			for (const row of gunba.filter(g => g.Key === gunbaKey[spec] && g.Faction.toLowerCase() === faction)) {
				const foreign = row.BaselinePlayer.equipment;
				addSet({
					id: 'gunba-' + row.Race.toLowerCase().replaceAll(' ', '-'),
					origin: 'Gunba saved equipment',
					tier: 'Mixed reference; acquisition not independently established',
					equipment: foreign,
					sourceUrl: `https://github.com/gunba/wow-forever-sim/blob/${JSON.parse(identity).gunbaSource}/artifacts/forever_dps_5min.json`,
					importedFields: ['equipment'],
					excludedFields: ['bonusStats', 'foreverTier1Bonuses', 'consumes', 'rotation', 'talentsString', 'Stats', 'DPS'],
				});
			}
		if (!p.sets.length) throw new Error(`No valid sets for ${p.id} ${faction}`);
		p.referenceSetId = referenceEquipmentSet(p.sets);
		profiles.push(p);
	}
}
save('profiles.json', { profiles, aliases, rejected, sourceGearCatalog: gearCatalog });
const cells = [],
	known = new Map(),
	sampleCache = new Map(),
	normalizedRotations = new Map();
const requestCache = new Map();
if (opts.resume)
	for (const file of fs.readdirSync(out).filter(file => /^jobs-.*\.json$/.test(file)))
		for (const job of read(path.join(out, file))) {
			const receiptFile = path.join(out, 'results', job.key + '.receipt.json');
			if (fs.existsSync(receiptFile) || job.engineSha256 !== provenance.engineSha256 || !job.requestSha256) continue;
			if (
				job.request !== path.join(out, 'requests', job.key + '.json') ||
				job.result !== path.join(out, 'results', job.key + '.json') ||
				job.stats !== path.join(out, 'stats', job.key + '.json')
			)
				throw new Error('A cached job points outside its study paths.');
			if (![job.request, job.result, job.stats].every(file => fs.existsSync(file))) continue;
			if (fileHash(job.request) !== job.requestSha256) throw new Error(`Interrupted request changed: ${job.key}`);
			summarizeResult(read(job.result), read(job.request).simOptions.iterations);
			if (read(job.stats).errorResult) throw new Error(`Interrupted stats failed: ${job.key}`);
			fs.writeFileSync(
				receiptFile,
				JSON.stringify({
					requestSha256: job.requestSha256,
					engineSha256: provenance.engineSha256,
					resultSha256: fileHash(job.result),
					statsSha256: fileHash(job.stats),
					recoveredFromManifest: file,
				}),
			);
		}
if (opts.resume)
	for (const file of fs.readdirSync(path.join(out, 'results')).filter(file => file.endsWith('.receipt.json'))) {
		const receipt = read(path.join(out, 'results', file));
		if (receipt.engineSha256 === provenance.engineSha256)
			requestCache.set(receipt.requestSha256, { key: file.slice(0, -'.receipt.json'.length), ...receipt });
	}
const rotationKey = meta => [meta.faction, meta.profileId, meta.setId, meta.race, meta.support].join('--');
function addCell(meta, phase, iterations, seed) {
	const profile = profiles.find(p => p.id === meta.profileId && p.faction === meta.faction),
		gear = profile.sets.find(g => g.id === meta.setId);
	const suffix = hash(
		signature([
			meta.setId,
			meta.race,
			meta.duration,
			meta.support,
			meta.target,
			meta.hitOffset ?? 0,
			meta.timing ?? 'developer',
			meta.mana ?? 'developer',
			meta.referencePolicy ?? 'developer',
			...(meta.classRacial ? [meta.classRacial] : []),
		]),
	).slice(0, 20);
	const key = [phase, meta.faction, meta.profileId, suffix].join('--');
	if (known.has(key)) return known.get(key);
	const normalized = meta.referencePolicy === 'explicit' ? normalizedRotations.get(rotationKey(meta)) : null;
	const inputProfile = normalized?.changes.length ? { ...profile, player: { ...profile.player, rotation: normalized.rotation } } : profile;
	const { request, changes } = makeRobustRequest(inputProfile, meta.race, gear, baseConfig, { ...meta, iterations, seed, statEnums: statsEnum });
	if (normalized?.changes.length) changes.push('Unavailable aura/spell references resolved explicitly from native metadata; see rotation-resolution.json.');
	const parameters = Object.fromEntries(
		['profileId', 'faction', 'setId', 'race', 'duration', 'support', 'target', 'hitOffset', 'timing', 'mana', 'referencePolicy', 'classRacial']
			.filter(name => meta[name] !== undefined)
			.map(name => [name, meta[name]]),
	);
	const row = {
		...parameters,
		phase,
		key,
		iterations,
		seed,
		className: profile.className,
		buildName: profile.name,
		gearOrigin: gear.origin,
		gearTier: gear.tier,
		changes,
	};
	const input = path.join(out, 'requests', key + '.json');
	const bytes = JSON.stringify(request);
	row.requestSha256 = hash(bytes);
	if (fs.existsSync(input) && fileHash(input) !== row.requestSha256) throw new Error(`Request changed on resume: ${key}`);
	fs.writeFileSync(input, bytes);
	cells.push(row);
	known.set(key, row);
	return row;
}
function values(row) {
	if (!sampleCache.has(row.key)) {
		if (sampleCache.size >= 100) sampleCache.delete(sampleCache.keys().next().value);
		sampleCache.set(row.key, read(path.join(out, 'results', row.key + '.json')).raidMetrics.parties[0].players[0].dps.allValues);
	}
	return sampleCache.get(row.key);
}
function summarize(row) {
	const resultFile = path.join(out, 'results', row.key + '.json'),
		sheetFile = path.join(out, 'stats', row.key + '.json');
	const raw = read(resultFile),
		stats = read(sheetFile),
		sheet = stats.raidStats.parties[0].players[0];
	Object.assign(row, summarizeResult(raw, row.iterations));
	if (!(row.meanDps > 0)) throw new Error(`The build produced no damage: ${row.key}`);
	if (!row.damageActions.every(a => Number.isFinite(a.casts) && Number.isFinite(a.dps))) throw new Error(`Invalid action accounting: ${row.key}`);
	row.resultSha256 = fileHash(resultFile);
	row.statsSha256 = fileHash(sheetFile);
	row.racial = racialMetrics(raw, row.race, row.className, row.iterations);
	row.stats = Object.fromEntries(
		Object.entries(pseudoEnum)
			.filter(([k]) => /HitPercent|CritPercent|SpeedMultiplier/.test(k))
			.map(([k, i]) => [k, sheet.finalStats.pseudoStats[i]]),
	);
	// Resource totals stay separate from the mana policy carried into later stages.
	if (typeof row.mana !== 'string') throw new Error(`The mana policy was overwritten: ${row.key}`);
	row.maxMana = sheet.finalStats.stats[statsEnum.Mana];
	row.validations = [];
	walkObjects(sheet.rotationStats, node => {
		if (node.validation && node.logLevel !== 'Information') row.validations.push(node.validation);
	});
	row.validations = [...new Set(row.validations)];
	row.mutilateCasts =
		raw.raidMetrics.parties[0].players[0].actions
			.filter(a => a.id.spellId === 1241584 && !a.id.tag)
			.reduce((s, a) => s + a.targets.reduce((t, v) => t + v.casts, 0), 0) / row.iterations;
	row.classRacialCasts =
		raw.raidMetrics.parties[0].players[0].actions
			.filter(a => [19305, 1277335].includes(a.id.spellId))
			.reduce((s, a) => s + a.targets.reduce((t, v) => t + v.casts, 0), 0) / row.iterations;
	if (/-(asn|combat)-muti$/.test(row.profileId) && !(row.mutilateCasts > 0)) throw new Error(`Mutilate never casts: ${row.key}`);
	return row;
}
function runCells(rows, phase) {
	status(phase);
	const jobs = [],
		exactRequests = new Map(),
		duplicateRequests = [];
	for (const row of rows) {
		const canonical = exactRequests.get(row.requestSha256);
		if (canonical) row.sameRequestAs = canonical;
		const result = path.join(out, 'results', row.key + '.json'),
			stats = path.join(out, 'stats', row.key + '.json');
		const receipt = path.join(out, 'results', row.key + '.receipt.json');
		if (fs.existsSync(receipt)) {
			const r = read(receipt);
			if (
				r.engineSha256 !== provenance.engineSha256 ||
				r.requestSha256 !== row.requestSha256 ||
				fileHash(result) !== r.resultSha256 ||
				fileHash(stats) !== r.statsSha256
			)
				throw new Error(`Cached cell fingerprint mismatch: ${row.key}`);
			row.reused = true;
			if (!canonical) exactRequests.set(row.requestSha256, row.key);
			continue;
		}
		if (!canonical && requestCache.has(row.requestSha256)) {
			const cached = requestCache.get(row.requestSha256);
			const sourceResult = path.join(out, 'results', cached.key + '.json'),
				sourceStats = path.join(out, 'stats', cached.key + '.json');
			if (
				fileHash(path.join(out, 'requests', cached.key + '.json')) !== row.requestSha256 ||
				fileHash(sourceResult) !== cached.resultSha256 ||
				fileHash(sourceStats) !== cached.statsSha256
			)
				throw new Error(`Indexed cache fingerprint mismatch: ${cached.key}`);
			fs.copyFileSync(sourceResult, result);
			fs.copyFileSync(sourceStats, stats);
			row.reusedInputFrom = cached.key;
			row.reused = true;
			exactRequests.set(row.requestSha256, row.key);
			continue;
		}
		if (exactRequests.has(row.requestSha256)) {
			row.sameRequestAs = exactRequests.get(row.requestSha256);
			duplicateRequests.push(row);
			continue;
		}
		exactRequests.set(row.requestSha256, row.key);
		jobs.push({
			key: row.key,
			request: path.join(out, 'requests', row.key + '.json'),
			result,
			stats,
			requestSha256: row.requestSha256,
			engineSha256: provenance.engineSha256,
		});
	}
	save('jobs-' + phase + '.json', jobs);
	if (jobs.length) {
		const r = spawnSync(batch, [path.join(out, 'jobs-' + phase + '.json'), String(settings.workers)], { cwd: root, stdio: 'inherit' });
		if (r.status !== 0) throw new Error(`Simulation phase failed: ${phase}. Inspect the failures before resuming.`);
	}
	for (const row of duplicateRequests) {
		for (const dir of ['results', 'stats']) fs.copyFileSync(path.join(out, dir, row.sameRequestAs + '.json'), path.join(out, dir, row.key + '.json'));
	}
	for (const row of rows) {
		summarize(row);
		fs.writeFileSync(
			path.join(out, 'results', row.key + '.receipt.json'),
			JSON.stringify({
				requestSha256: row.requestSha256,
				resultSha256: row.resultSha256,
				statsSha256: row.statsSha256,
				engineSha256: provenance.engineSha256,
			}),
		);
	}
	save('cells.json', cells);
}
function condition(row, includeSet = true) {
	return [
		row.faction,
		row.profileId,
		...(includeSet ? [row.setId] : []),
		row.duration,
		row.support,
		row.target,
		row.hitOffset ?? 0,
		row.referencePolicy ?? 'developer',
	].join('--');
}
function best(rows, key) {
	const selected = new Map();
	for (const row of rows) {
		const k = key(row);
		if (!selected.has(k) || selected.get(k).meanDps < row.meanDps) selected.set(k, row);
	}
	return [...selected.values()];
}
const preflight = [];
for (const p of profiles)
	for (const gear of p.sets)
		for (const race of p.races)
			for (const support of settings.supports)
				preflight.push(
					addCell(
						{
							profileId: p.id,
							faction: p.faction,
							setId: gear.id,
							race,
							duration: 180,
							support,
							target: 'neutral',
							timing: 'oncd',
							mana: 'developer',
							hitOffset: 0,
						},
						'preflight',
						100,
						settings.screenSeed,
					),
				);
runCells(preflight, 'preflight');
const proof = [];
for (const specPath of [...new Set(profiles.map(p => p.specPath))]) {
	const p = profiles.find(p => p.specPath === specPath),
		row = preflight.find(r => r.profileId === p.id && r.faction === p.faction && r.setId === p.referenceSetId);
	const requestFile = path.join(out, 'requests', row.key + '.json'),
		resultFile = path.join(out, 'logs', 'cli-' + p.id + '.json');
	execFileSync(
		path.join(source, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim'),
		['sim', '--infile', requestFile, '--outfile', resultFile],
		{ stdio: 'pipe' },
	);
	const expected = read(resultFile).raidMetrics.parties[0].players[0].dps.allValues;
	if (signature(values(row)) !== signature(expected)) throw new Error(`Batch/CLI iteration mismatch: ${p.id}`);
	proof.push({ profileId: p.id, requestSha256: row.requestSha256, exactIterationAgreement: true });
}
save('driver-verification.json', { engineSha256: provenance.engineSha256, cliSha256: provenance.referenceCliSha256, cases: proof });
for (const row of preflight) {
	const p = profiles.find(p => p.id === row.profileId && p.faction === row.faction);
	const metadata = read(path.join(out, 'stats', row.key + '.json'));
	normalizedRotations.set(rotationKey(row), resolveUnavailableReferences(p.player.rotation, metadata));
}
save('rotation-resolution.json', Object.fromEntries(normalizedRotations));
const resolvedPreflight = preflight.map(row => addCell({ ...row, referencePolicy: 'explicit' }, 'resolved-preflight', 100, settings.screenSeed));
runCells(resolvedPreflight, 'resolved-preflight');
save(
	'rotation-resolution-effects.json',
	resolvedPreflight.map(row => {
		const raw = preflight.find(p => rotationKey(p) === rotationKey(row));
		return {
			profileId: row.profileId,
			faction: row.faction,
			race: row.race,
			setId: row.setId,
			support: row.support,
			originalMeanDps: raw.meanDps,
			resolvedMeanDps: row.meanDps,
			differencePercent: 100 * (row.meanDps / raw.meanDps - 1),
			rawKey: raw.key,
			resolvedKey: row.key,
			rawWarnings: raw.validations,
			resolvedWarnings: row.validations,
		};
	}),
);
if (opts['preflight-only']) {
	status('preflight-complete');
	process.exit(0);
}
const screen = [];
for (const p of profiles)
	for (const gear of p.sets)
		for (const duration of settings.durations)
			for (const support of settings.supports)
				for (const race of p.races)
					for (const referencePolicy of settings.referencePolicies) {
						const timings = offensiveRacial(race, p.className)
							? ['developer', 'oncd', ...(p.className === 'Warrior' ? ['delay15'] : [])]
							: ['developer'];
						const manaModes =
							race === 'RaceHighOrderSkyborne' && !['Warrior', 'Rogue'].includes(p.className)
								? ['developer', 'leyline65-guarded']
								: ['developer'];
						const classRacials =
							p.className === 'Priest' && ['RaceNightElf', 'RaceDwarf'].includes(race) ? [undefined, 'damage-dpet'] : [undefined];
						for (const timing of timings)
							for (const mana of manaModes)
								for (const classRacial of classRacials)
									screen.push(
										addCell(
											{
												profileId: p.id,
												faction: p.faction,
												setId: gear.id,
												race,
												duration,
												support,
												target: 'neutral',
												hitOffset: 0,
												timing,
												mana,
												referencePolicy,
												...(classRacial ? { classRacial } : {}),
											},
											'screen',
											settings.screenIterations,
											settings.screenSeed,
										),
									);
					}
runCells(screen, 'screen');
const selectedPolicies = best(screen, row => condition(row) + '--' + row.race);
const validation = selectedPolicies.map(row => addCell(row, 'validation', settings.validationIterations, settings.validationSeed));
runCells(validation, 'validation');
execFileSync(process.execPath, [path.join(root, 'tools/dps-experiments/hunter_ranged_probe.mjs'), out, path.join(out, 'hunter-ranged-controls')], {
	cwd: root,
	stdio: 'inherit',
});
const diagnostics = [];
for (const p of profiles)
	for (const duration of settings.durations)
		for (const race of p.races)
			for (const referencePolicy of settings.referencePolicies)
				for (const hitOffset of [-4, -2, 0, 2, 4])
					diagnostics.push(
						addCell(
							{
								profileId: p.id,
								faction: p.faction,
								setId: p.referenceSetId,
								race,
								duration,
								support: 'full',
								target: 'neutral',
								hitOffset,
								timing: 'oncd',
								mana: 'developer',
								referencePolicy,
							},
							'hit-control',
							settings.validationIterations,
							settings.validationSeed,
						),
					);
for (const p of profiles)
	for (const race of p.races)
		for (const referencePolicy of settings.referencePolicies)
			for (const target of ['beast', 'elemental'])
				diagnostics.push(
					addCell(
						{
							profileId: p.id,
							faction: p.faction,
							setId: p.referenceSetId,
							race,
							duration: 180,
							support: 'full',
							target,
							hitOffset: 0,
							timing: 'oncd',
							mana: 'developer',
							referencePolicy,
						},
						'creature-control',
						settings.validationIterations,
						settings.validationSeed,
					),
				);
runCells(diagnostics, 'diagnostics');
const pools = ['published-pre-raid', 'developer-reference'];
const confirmation = [];
for (const pool of pools) {
	const selected = best(
		validation.filter(row => {
			const gear = profiles.find(p => p.id === row.profileId && p.faction === row.faction).sets.find(s => s.id === row.setId);
			return [gear, ...gear.aliases].some(g => (pool === 'published-pre-raid' ? g.tier === 'Published pre-raid' : g.origin === 'WoWSims developer'));
		}),
		row => condition(row, false) + '--' + row.race,
	);
	for (const row of selected) {
		const c = addCell(row, 'confirmation', settings.confirmationIterations, settings.confirmationSeed);
		c.pools ??= [];
		if (!c.pools.includes(pool)) c.pools.push(pool);
		if (!confirmation.includes(c)) confirmation.push(c);
	}
}
runCells(confirmation, 'confirmation');
const ambiguousConditions = new Set();
for (const pool of pools) {
	const grouped = new Map();
	for (const row of confirmation.filter(r => r.pools.includes(pool))) {
		const key = condition(row, false);
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key).push(row);
	}
	for (const [key, rows] of grouped) {
		const ranked = rankRaceSamples(rows, values, settings.tolerancePercent);
		if (
			ranked.comparisons.some(
				c => c.percent - c.halfWidthPercent < -settings.tolerancePercent && c.percent + c.halfWidthPercent >= -settings.tolerancePercent,
			)
		)
			ambiguousConditions.add(key);
	}
}
const precision = [],
	preciseRows = new Map();
for (const row of confirmation.filter(r => ambiguousConditions.has(condition(r, false)))) {
	const precise = addCell(row, 'precision', settings.precisionIterations, settings.precisionSeed);
	precise.pools = [...row.pools];
	preciseRows.set(row.key, precise);
	if (!precision.includes(precise)) precision.push(precise);
}
runCells(precision, 'precision');
const finalConfirmation = confirmation.map(row => preciseRows.get(row.key) ?? row);
save('precision-selection.json', {
	selection:
		'Expand every race and equipment pool in a condition when any race interval straddles the 0.2% practical-loss boundary. Precision samples use a disjoint seed range and replace the initial confirmation; samples are never pooled.',
	conditions: [...ambiguousConditions],
	cases: precision.length,
	iterations: settings.precisionIterations,
});
const groups = [];
function ranked(rows, mode) {
	const grouped = new Map();
	for (const row of rows) {
		const k = mode.startsWith('pool:') ? condition(row, false) : condition(row);
		if (!grouped.has(k)) grouped.set(k, []);
		grouped.get(k).push(row);
	}
	for (const [key, members] of grouped) {
		const p = profiles.find(p => p.id === members[0].profileId && p.faction === members[0].faction);
		if (members.length !== p.races.length) throw new Error(`Incomplete race coverage: ${mode} ${key}`);
		const rank = rankRaceSamples(members, values, settings.tolerancePercent);
		groups.push({
			key: mode + '--' + key,
			mode,
			profileId: p.id,
			faction: p.faction,
			className: p.className,
			buildName: p.name,
			duration: members[0].duration,
			support: members[0].support,
			referencePolicy: members[0].referencePolicy ?? 'developer',
			target: members[0].target,
			hitOffset: members[0].hitOffset ?? 0,
			setId: mode.startsWith('pool:') ? null : members[0].setId,
			...rank,
			rows: members.map(row => ({
				key: row.key,
				race: row.race,
				setId: row.setId,
				meanDps: row.meanDps,
				stats: row.stats,
				racial: row.racial,
				secondsOomAvg: row.secondsOomAvg,
				timing: row.timing,
				mana: row.mana,
				classRacial: row.classRacial ?? 'developer',
				classRacialCasts: row.classRacialCasts,
				iterations: row.iterations,
				validations: row.validations,
			})),
		});
	}
}
ranked(validation, 'fixed-set');
ranked(
	diagnostics.filter(r => r.phase === 'hit-control'),
	'hit-control',
);
ranked(
	diagnostics.filter(r => r.phase === 'creature-control'),
	'creature-control',
);
for (const pool of pools)
	ranked(
		finalConfirmation.filter(r => r.pools.includes(pool)),
		'pool:' + pool,
	);
save('analysis.json', {
	settings,
	groups,
	scope: "Every legal race shares the same faction-specific equipment catalogue. Fixed-set comparisons choose racial timing with screening samples. Pool comparisons select each race's equipment from the same declared catalogue on validation samples, then confirm on a disjoint seed range. Synthetic hit controls never count as realistic gear evidence. Gunba equipment is a mixed-tier diagnostic reference and does not enter the pre-raid or developer selection pools.",
});
save('coverage.json', {
	factionProfiles: profiles.length,
	uniqueBuilds: new Set(profiles.map(p => p.id)).size,
	raceBuilds: profiles.reduce((s, p) => s + p.races.length, 0),
	completeSets: profiles.reduce((s, p) => s + p.sets.length, 0),
	cells: cells.length,
	groups: groups.length,
	aliases,
	rejected,
	mutilateMinimumCasts: Math.min(...cells.filter(c => /-(asn|combat)-muti$/.test(c.profileId)).map(c => c.mutilateCasts)),
	realSetCoverage: profiles.map(p => ({
		profileId: p.id,
		faction: p.faction,
		sets: p.sets.length,
		publishedSets: p.sets.filter(s => s.tier === 'Published pre-raid').length,
		origins: [...new Set(p.sets.map(s => s.origin))],
	})),
});
status('simulation-complete');
console.log(`Saved ${cells.length} cells and ${groups.length} complete race comparisons to ${out}`);
