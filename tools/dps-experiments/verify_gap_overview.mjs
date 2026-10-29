import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Window } from 'happy-dom';
const root = path.resolve(process.argv[2] ?? '');
assert(process.argv[2], 'Supply a saved report directory.');
const load = name => {
	let file = path.join(root, name);
	if (!fs.existsSync(file)) file += '.gz';
	const b = fs.readFileSync(file);
	return JSON.parse(file.endsWith('.gz') ? gunzipSync(b) : b);
};
const profiles = load('profiles.json').profiles,
	groups = load('analysis.json').groups,
	scopes = load('race-dps-gaps.json').scopes;
assert.equal(scopes.length, profiles.length * 36);
const close = (a, b) => assert(Math.abs(a - b) < 1e-9, 'Mean gap arithmetic differs.');
let raceGaps = 0;
for (const scope of scopes) {
	const p = profiles.find(p => p.id === scope.profileId && p.faction === scope.faction);
	const sets = new Set(
		p.sets
			.filter(s =>
				[s, ...s.aliases].some(g => (scope.pool === 'published-pre-raid' ? g.tier === 'Published pre-raid' : g.origin === 'WoWSims developer')),
			)
			.map(s => s.id),
	);
	const matching = groups.filter(
		g =>
			g.profileId === p.id &&
			g.faction === p.faction &&
			g.duration === scope.duration &&
			!g.diagnosticOnly &&
			(scope.supportScope === 'both' || g.support === scope.supportScope) &&
			(scope.basis === 'selected-gear' ? g.mode === 'pool:' + scope.pool : g.mode === 'fixed-set' && sets.has(g.setId)),
	);
	assert.equal(scope.conditions, matching.length);
	const runners = [],
		spreads = [],
		leaders = new Set(),
		leaderSets = new Set(),
		losses = new Map(p.races.map(r => [r, []]));
	for (const g of matching) {
		const rows = [...g.rows].sort((a, b) => b.meanDps - a.meanDps),
			best = rows[0].meanDps;
		assert.deepEqual(rows.map(r => r.race).sort(), [...p.races].sort());
		const local = rows
			.filter(r => r.meanDps === best)
			.map(r => r.race)
			.sort();
		local.forEach(r => leaders.add(r));
		leaderSets.add(local.join('|'));
		for (const row of rows) losses.get(row.race).push(Math.max(0, 100 * (1 - row.meanDps / best)));
		if (rows.length > 1) {
			runners.push(100 * (1 - rows[1].meanDps / best));
			spreads.push(100 * (1 - rows.at(-1).meanDps / best));
		}
	}
	assert.deepEqual(scope.leaders, [...leaders].sort());
	assert.equal(scope.leaderChanges, leaderSets.size > 1);
	for (const [values, range] of [
		[runners, scope.runnerUpGapPercent],
		[spreads, scope.fullSpreadPercent],
	]) {
		if (!values.length) assert.equal(range, null);
		else {
			close(range.min, Math.min(...values));
			close(range.max, Math.max(...values));
		}
	}
	for (const r of scope.races) {
		const values = losses.get(r.race);
		if (!values.length) assert.equal(r.gapPercent, null);
		else {
			close(r.gapPercent.min, Math.min(...values));
			close(r.gapPercent.max, Math.max(...values));
		}
		raceGaps++;
	}
}
const window = new Window({ settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
let filterCases = 0;
try {
	window.document.write(fs.readFileSync(path.join(root, 'report.html'), 'utf8'));
	const rows = [...window.document.querySelectorAll('tr[data-basis]')];
	assert.equal(rows.length, profiles.length * 12);
	for (const row of rows) {
		assert.equal(row.querySelectorAll('td').length, 3);
		for (const cell of row.querySelectorAll('td')) {
			const confidence = cell.querySelector('.gap-confidence');
			if (confidence) assert(!confidence.hasAttribute('open'));
			if (cell.querySelector('.gap-metric')) {
				assert(cell.textContent.includes('Runner-up gap') && cell.textContent.includes('Full racial spread'));
				assert(cell.querySelector('.race-gaps'));
			}
		}
	}
	for (const faction of ['horde', 'alliance'])
		for (const pool of ['published-pre-raid', 'developer-reference'])
			for (const basis of ['across-gear', 'selected-gear'])
				for (const support of ['both', 'full', 'self'])
					for (const term of ['', ...new Set(profiles.map(p => p.className))]) {
						for (const [id, value] of Object.entries({ faction, pool, basis, support, search: term })) {
							const c = window.document.getElementById(id);
							c.value = value;
							c.dispatchEvent(new window.Event('input'));
						}
						const visible = rows.filter(r => !r.hidden),
							expected = profiles.filter(p => p.faction === faction && (!term || p.className === term));
						assert.equal(visible.length, expected.length);
						filterCases++;
					}
} finally {
	await window.happyDOM.close();
}
console.log(JSON.stringify({ passed: true, scopes: scopes.length, raceGapRanges: raceGaps, filterCases, confidenceSecondary: true, simulationsRun: 0 }));
