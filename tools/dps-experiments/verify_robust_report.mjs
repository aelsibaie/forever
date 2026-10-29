import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { hash } from './racial_helpers.mjs';

if (!process.argv[2]) throw new Error('Usage: node tools/dps-experiments/verify_robust_report.mjs study-directory');
const root = path.resolve(process.argv[2]);
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8')).profiles;
const analysis = JSON.parse(fs.readFileSync(path.join(root, 'analysis.json'), 'utf8'));
const recommendations = JSON.parse(fs.readFileSync(path.join(root, 'recommendations.json'), 'utf8')).recommendations;
assert.equal(recommendations.length, profiles.length * 2 * 2 * 3 * 3, 'Missing recommendation scopes.');
for (const r of recommendations) {
	const profile = profiles.find(p => p.faction === r.faction && p.id === r.profileId);
	const eligibleSets = new Set(
		profile.sets
			.filter(s => [s, ...s.aliases].some(g => (r.pool === 'published-pre-raid' ? g.tier === 'Published pre-raid' : g.origin === 'WoWSims developer')))
			.map(s => s.id),
	);
	const groups = analysis.groups.filter(
		g =>
			g.faction === r.faction &&
			g.profileId === r.profileId &&
			g.duration === r.duration &&
			!g.diagnosticOnly &&
			g.referencePolicy === 'developer' &&
			!g.rotationExcluded &&
			(r.supportScope === 'both' || g.support === r.supportScope) &&
			(r.basis === 'selected-gear' ? g.mode === 'pool:' + r.pool : g.mode === 'fixed-set' && eligibleSets.has(g.setId)),
	);
	assert.equal(r.conditions, groups.length, 'Recommendation condition filter differs.');
	for (const loss of r.losses) {
		const upper = Math.max(
			0,
			...groups.map(g => {
				const own = g.comparisons.find(c => c.race === loss.race);
				const lowerRatio = Math.max(0, 1 + (own.percent - own.halfWidthPercent) / 100);
				const competitors = g.comparisons.filter(c => c.race !== loss.race);
				return Math.max(0, ...competitors.map(c => 100 * (1 - lowerRatio / (1 + (c.percent + c.halfWidthPercent) / 100))));
			}),
		);
		assert(Math.abs(upper - loss.worstUpperLoss) < 1e-8, 'Recommendation upper loss differs: ' + r.profileId);
	}
	assert.deepEqual(
		[...r.safe].sort(),
		r.losses
			.filter(loss => loss.worstUpperLoss <= analysis.settings.tolerancePercent)
			.map(loss => loss.race)
			.sort(),
		'Uncertified race marked consistent.',
	);
}
const window = new Window({ settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
let cases = 0,
	links = 0;
try {
	window.document.write(fs.readFileSync(path.join(root, 'report.html'), 'utf8'));
	const visible = () => [...window.document.querySelectorAll('tr[data-basis]')].filter(row => !row.hidden);
	assert.equal(visible().length, profiles.filter(p => p.faction === 'horde').length, 'Default report view omits or mixes builds.');
	const set = (name, value) => {
		const control = window.document.getElementById(name);
		assert(control, 'Missing report control: ' + name);
		control.value = value;
		control.dispatchEvent(new window.Event('input'));
	};
	for (const faction of ['horde', 'alliance'])
		for (const pool of ['published-pre-raid', 'developer-reference'])
			for (const basis of ['across-gear', 'selected-gear'])
				for (const support of ['both', 'full', 'self']) {
					for (const [name, value] of Object.entries({ faction, pool, basis, support })) set(name, value);
					for (const search of ['', ...new Set(profiles.map(p => p.className))]) {
						set('search', search);
						const expected = profiles.filter(p => p.faction === faction && (!search || p.className === search));
						const wanted = expected.map(p => `builds/${faction}--${p.id}.html`).sort();
						assert.deepEqual(
							visible()
								.map(row => row.querySelector('th a').getAttribute('href'))
								.sort(),
							wanted,
							'Report filter omitted or mixed builds: ' + [faction, pool, basis, support, search].join('/'),
						);
						cases++;
					}
				}
	for (const file of [
		path.join(root, 'report.html'),
		...fs
			.readdirSync(path.join(root, 'builds'))
			.filter(name => name.endsWith('.html'))
			.map(name => path.join(root, 'builds', name)),
	]) {
		const html = fs.readFileSync(file, 'utf8');
		for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
			if (/^(?:https?:|mailto:|data:|#)/.test(match[1])) continue;
			const target = path.resolve(path.dirname(file), decodeURI(match[1].split('#')[0].split('?')[0]));
			assert(target.startsWith(root + path.sep), 'Report link escapes its study directory.');
			assert(fs.existsSync(target), 'Missing report artifact: ' + target);
			links++;
		}
	}
} finally {
	await window.happyDOM.close();
}
const receipt = {
	passed: true,
	recommendationScopes: recommendations.length,
	lossBoundsRecomputed: true,
	filterCases: cases,
	localLinks: links,
	factionBuilds: profiles.length,
	scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
};
fs.writeFileSync(path.join(root, 'report-ui-verification.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
