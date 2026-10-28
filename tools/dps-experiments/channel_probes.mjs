import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from './racial_helpers.mjs';
import { statIndexes } from './shadow_translation.mjs';
const [directory, output] = process.argv.slice(2).map(x => path.resolve(x));
assert(directory && output, 'Usage: node tools/dps-experiments/channel_probes.mjs mechanics-audit new-output');
assert(!fs.existsSync(output), 'Use a new output directory.');
fs.mkdirSync(output, { recursive: true });
const root = process.cwd(),
	read = f => JSON.parse(fs.readFileSync(f, 'utf8')),
	audit = read(path.join(directory, 'audit.json')),
	provenance = read(path.join(directory, 'provenance.json'));
const binary = path.join(directory, 'engine', process.platform === 'win32' ? 'batch.exe' : 'batch');
assert.equal(hash(fs.readFileSync(binary)), provenance.binaries.batch, 'The audit binary changed.');
const enums = statIndexes(fs.readFileSync(path.join(root, 'proto/common.proto'), 'utf8'));
const requested = [
	['Priest', 'Mind Flay'],
	['Priest', 'Shadow Word: Pain'],
	['Warlock', 'Drain Life'],
	['Warlock', 'Drain Soul'],
	['Mage', 'Arcane Missiles'],
	['Mage', 'Blizzard'],
	['Druid', 'Hurricane'],
	['Priest', 'Penance'],
];
const jobs = [],
	rows = [],
	skipped = [];
for (const [className, name] of requested) {
	let selected, spell, fallback;
	for (const row of audit.rows.filter(r => r.variant === 'resolved' && r.className === className)) {
		const s = read(path.join(directory, 'snapshots', row.key + '.json'));
		const matches = s.owner.spells.filter(x => x.rowName === name && x.id > 0 && !x.tag);
		if (matches.length) {
			selected = row;
			spell = matches.at(-1);
			fallback = name === 'Penance' ? s.owner.spells.filter(x => x.rowName === 'Smite' && !x.tag).at(-1) : null;
			break;
		}
	}
	if (!spell) {
		skipped.push({ className, name, reason: 'No matching registered spell in the exported builds.' });
		continue;
	}
	const source = path.join(directory, 'requests', selected.key + '.json');
	assert.equal(hash(fs.readFileSync(source)), selected.requestSha256, 'An audit request changed.');
	const q = read(source),
		p = q.raid.parties[0].players[0];
	p.rotation = { type: 'TypeAPL', priorityList: [{ action: { castSpell: { spellId: { spellId: spell.id } } } }] };
	if (fallback) p.rotation.priorityList.push({ action: { castSpell: { spellId: { spellId: fallback.id } } } });
	p.bonusStats ??= { stats: [] };
	p.bonusStats.stats ??= [];
	while (p.bonusStats.stats.length <= Math.max(...Object.values(enums))) p.bonusStats.stats.push(0);
	p.bonusStats.stats[enums.HitRating] -= 10000;
	p.bonusStats.stats[enums.Mana] += 100000;
	p.bonusStats.stats[enums.MP5] += 10000;
	q.encounter.duration = 15;
	q.simOptions = { iterations: 1, randomSeed: '8026102801', debug: true, saveAllValues: true, useLabeledRands: true };
	const key = className + '--' + spell.id,
		request = path.join(output, key + '.request.json'),
		result = path.join(output, key + '.result.json'),
		stats = path.join(output, key + '.stats.json');
	fs.writeFileSync(request, JSON.stringify(q));
	jobs.push({ key, request, result, stats });
	rows.push({
		key,
		className,
		name,
		spellId: spell.id,
		fallbackSpellId: fallback?.id,
		sourceKey: selected.key,
		requestSha256: hash(fs.readFileSync(request)),
		baseTicks: spell.baseTicks,
		baseTickSeconds: spell.baseTickSeconds,
	});
}
fs.writeFileSync(path.join(output, 'jobs.json'), JSON.stringify(jobs));
execFileSync(binary, [path.join(output, 'jobs.json'), '1'], { cwd: root, stdio: 'pipe' });
for (const row of rows) {
	const file = path.join(output, row.key + '.result.json'),
		result = read(file);
	if (result.errorResult) throw new Error(result.errorResult);
	row.resultSha256 = hash(fs.readFileSync(file));
	row.events = result.raidMetrics.parties[0].players[0].actions
		.map(a => ({
			id: a.id,
			misses: a.targets.reduce((n, t) => n + (t.misses ?? 0) + (t.tickMisses ?? 0), 0),
			damage: a.targets.reduce((n, t) => n + (t.damage ?? 0), 0),
		}))
		.filter(a => a.misses > 0 || a.damage > 0);
	row.trace = result.logs
		.split('\n')
		.filter(
			x =>
				(x.includes('{SpellID: ' + row.spellId + '}') || (row.fallbackSpellId && x.includes('{SpellID: ' + row.fallbackSpellId + '}'))) &&
				!x.includes('[DEBUG]') &&
				/Casting|Completed|Miss|Resist/i.test(x),
		)
		.slice(0, 12);
}
const report = {
	scope: 'Forced-miss timing diagnostics. Unobtainable bonus stats remove hit and mana variation. These are simulator traces, not in-game logs or DPS recommendations.',
	primarySource: provenance.primarySource,
	binarySha256: provenance.binaries.batch,
	toolSha256: hash(fs.readFileSync(new URL(import.meta.url))),
	seed: 8026102801,
	duration: 15,
	rows,
	skipped,
};
fs.writeFileSync(path.join(output, 'traces.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ channels: rows.length, skipped }));
