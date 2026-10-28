import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hash } from './racial_helpers.mjs';
const [auditDir, output] = process.argv.slice(2).map(x => path.resolve(x));
assert(auditDir && output, 'Usage: node tools/dps-experiments/mechanics_report.mjs audit-directory new-output-directory');
assert(!fs.existsSync(output), 'Use a new output directory.');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const audit = read(path.join(auditDir, 'audit.json')),
	provenance = read(path.join(auditDir, 'provenance.json'));
const source = provenance.sourceReadiness,
	ready = read(path.join(source, 'readiness.json'));
assert.equal(hash(fs.readFileSync(path.join(source, 'readiness.json'))), provenance.sourceReadinessSha256, 'Readiness changed.');
const profiles = read(path.join(source, 'profiles.json')).profiles;
const snapshot = r => read(path.join(auditDir, 'snapshots', r.key + '.json'));
const resolved = audit.rows.filter(r => r.variant === 'resolved');
const byProfile = profiles.map(p => {
	const rows = resolved.filter(r => r.profile === p.id),
		sheets = rows.map(r => [r, snapshot(r)]);
	const control = variant => audit.comparisons.filter(r => r.variant === variant && rows.some(base => base.baseKey === r.baseKey));
	const spread = variant => {
		const x = control(variant).map(r => r.percent);
		return { min: Math.min(...x), max: Math.max(...x) };
	};
	const channels = new Map();
	for (const [row, s] of sheets)
		for (const spell of s.owner.spells.filter(s => s.channeled && row.actions.some(a => a.id.spellId === s.id))) {
			const key = spell.id + ':' + spell.tag;
			if (!channels.has(key))
				channels.set(key, {
					id: spell.id,
					name: spell.rowName,
					baseTickSeconds: spell.baseTickSeconds,
					baseTicks: spell.baseTicks,
					periodicCanCrit: spell.rowPeriodicCanCrit,
				});
		}
	const warnings = [...new Set(rows.flatMap(r => r.validations.map(v => v.replaceAll(p.id + ' (#1)', 'PLAYER'))))];
	const petInheritance = [];
	for (const [row, s] of sheets) {
		for (const pet of s.pets.filter(p => row.pets.some(x => x.name && p.name.endsWith(x.name) && x.dps > 0))) {
			const deltas = {};
			for (const variant of ['hit1', 'crit1']) {
				const key = row.baseKey + '--' + variant;
				const other = read(path.join(auditDir, 'snapshots', key + '.json')).pets.find(p => p.name === pet.name);
				deltas[variant] = Object.fromEntries(
					['PhysicalHitPercent', 'SpellHitPercent', 'PhysicalCritPercent', 'SpellCritPercent'].map(k => [
						k,
						(other?.stats[k] ?? 0) - (pet.stats[k] ?? 0),
					]),
				);
			}
			petInheritance.push({ race: row.race, pet: pet.name.split(' - ').slice(1).join(' - '), ...deltas });
		}
	}
	return {
		id: p.id,
		specLabel: p.specLabel,
		className: p.className,
		gearName: p.gearName,
		gearTier: p.gearTier,
		developerRankEligible: p.rankEligible,
		legalCases: rows.length,
		sourceWarnings: p.warnings,
		knownIssues: p.knownIssues,
		channels: [...channels.values()],
		periodicCritObserved: rows.some(r => r.actions.some(a => a.critTicks > 0)),
		withPetDamage: rows.filter(r => r.pets.some(p => p.dps > 0)).length,
		petInheritance,
		warnings,
		hitSensitivityPercent: spread('hit1'),
		critSensitivityPercent: spread('crit1'),
		rotationSensitivity: control('explicit').filter(r => Math.abs(r.percent) > Math.max(0.2, r.ci95HalfWidthPercent)),
		equipment: ready.equipmentCoverage
			.filter(r => r.profile === p.id)
			.map(({ sourceRejections, ...row }) => ({ ...row, rejectedSourceCombinations: sourceRejections.length })),
	};
});
const report = {
	createdAt: new Date().toISOString(),
	scope: audit.scope,
	primarySource: provenance.primarySource,
	analyticsHead: provenance.head,
	databaseSha256: provenance.databaseSha256,
	iterations: audit.iterations,
	seed: audit.seed,
	duration: audit.duration,
	profiles: audit.namedProfiles,
	legalCases: audit.legalCases,
	simulationCells: audit.rows.length,
	nativeFailures: audit.errors,
	flags: audit.flags,
	gearCoverage: {
		validDeveloperGroups: ready.equipmentCoverage.filter(r => r.developer.valid).length,
		developerGroups: ready.equipmentCoverage.length,
		publishedCoveredGroups: ready.equipmentCoverage.filter(r => r.published.some(s => s.valid)).length,
		missingPublished: ready.missingPublished,
	},
	evidence: {
		auditSha256: hash(fs.readFileSync(path.join(auditDir, 'audit.json'))),
		readinessSha256: provenance.sourceReadinessSha256,
		provenanceSha256: hash(fs.readFileSync(path.join(auditDir, 'provenance.json'))),
		binaries: provenance.binaries,
		toolSha256: provenance.toolSha256,
		inspectorSha256: provenance.inspectorSha256,
		toolDependencies: provenance.toolDependencies,
		gameInputs: provenance.gameInputs,
	},
	builds: byProfile,
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
const lines = [
	'# DPS mechanics readiness audit',
	'',
	report.scope,
	'',
	`Primary WoWSims source: ${report.primarySource}. Analytics head: ${report.analyticsHead}.`,
	`180 seconds; ${report.iterations} paired iterations per cell; seed ${report.seed}. Synthetic hit and crit controls are diagnostic inputs.`,
	`All ${report.profiles} exported builds and ${report.legalCases} legal race/build cases: ${report.simulationCells} cells, ${report.nativeFailures.length} native failures, ${report.flags.length} review flags.`,
	'',
	'| Developer build | Gear label | Cases | Pet damage | Crit ticks seen | Published sets (H / A) |',
	'| --- | --- | ---: | ---: | --- | --- |',
];
for (const p of byProfile) {
	const count = f => p.equipment.find(x => x.faction === f)?.published.filter(s => s.valid).length ?? 0;
	lines.push(
		`| ${p.id} | ${p.gearTier} | ${p.legalCases} | ${p.withPetDamage}/${p.legalCases} | ${p.periodicCritObserved ? 'yes' : 'not observed'} | ${count('horde')} / ${count('alliance')} |`,
	);
}
lines.push(
	'',
	'Pet damage and crit ticks are observations in these particular rotations. Their absence does not establish that a mechanic is unsupported. Full warnings, channels, pet stat deltas, gear legality and source gaps are in summary.json. The paired intervals are individual diagnostics, without a simultaneous guarantee across the audit.',
	'',
	`Legal developer equipment: ${report.gearCoverage.validDeveloperGroups}/${report.gearCoverage.developerGroups} build/faction groups. Published coverage: ${report.gearCoverage.publishedCoveredGroups}/${report.gearCoverage.developerGroups}.`,
	'',
	'## Review flags',
	'',
);
for (const flag of report.flags) lines.push('- ' + flag.baseKey + ': ' + flag.kind);
if (!report.flags.length) lines.push('The implemented automatic checks raised no flags. This does not validate every ability or establish game behavior.');
fs.writeFileSync(path.join(output, 'report.md'), lines.join('\n') + '\n');
console.log(
	JSON.stringify({
		profiles: report.profiles,
		cases: report.legalCases,
		flags: report.flags.length,
		publishedGroups: report.gearCoverage.publishedCoveredGroups,
	}),
);
