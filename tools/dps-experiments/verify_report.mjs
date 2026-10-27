import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { verifyDetails } from './verify_details.mjs';

if (!process.argv[2]) throw new Error('Usage: node tools/dps-experiments/verify_report.mjs run-directory');
const directory = path.resolve(process.argv[2]);
if (fs.existsSync(path.join(directory, 'profile-index.json'))) verifyDetails(directory);
const html = fs.readFileSync(path.join(directory, 'report.html'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8'));
const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'));
const eligible = catalog.profiles.filter(profile => profile.rankEligible);
const window = new Window({ settings: { enableJavaScriptEvaluation: false } });
try {
	// Interaction checks use placeholders for the independently rendered SVG charts.
	window.document.write(html.replace(/<svg[\s\S]*?<\/svg>/g, '<div>Chart placeholder</div>'));
	// The DOM implementation needs the browser's Option constructor supplied by the fixture.
	const Option = function (text, value) {
		const option = window.document.createElement('option');
		option.text = text;
		option.value = String(value);
		return option;
	};
	const context = vm.createContext({ document: window.document, Option, console });
	vm.runInContext(window.document.querySelector('script').textContent, context);
	const tableRows = () => [...window.document.querySelectorAll('#matrix tr')];
	const tier = window.document.querySelector('#tier');
	const tiered = html.includes('data-tier-chart=');
	if (tiered) {
		const tiers = [...tier.options].map(option => option.value);
		assert(!tiers.includes('all'));
		assert(tiers.every(value => value === 'Developer pre-raid' || /^Developer P[1-9][0-9]*$/.test(value)));
		for (const value of tiers) {
			tier.value = value;
			tier.dispatchEvent(new window.Event('change'));
			for (const diagnostic of [false, true]) {
				window.document.querySelector('#diagnostic').checked = diagnostic;
				window.document.querySelector('#diagnostic').dispatchEvent(new window.Event('change'));
				const expected = catalog.profiles.filter(profile => profile.gearTier === value && (diagnostic || profile.rankEligible));
				assert.equal(tableRows().length, expected.length);
				assert(tableRows().every(row => row.dataset.tier === value));
			}
			const visible = [...window.document.querySelectorAll('[data-tier-chart]')].filter(node => !node.hidden);
			assert.equal(visible.length, 1);
			assert.equal(visible[0].dataset.tierChart, value);
			window.document.querySelector('#search').value = catalog.profiles.find(profile => profile.gearTier === value).className;
			window.document.querySelector('#search').dispatchEvent(new window.Event('input'));
			assert(tableRows().every(row => row.dataset.tier === value));
			window.document.querySelector('#duration').value = String(provenance.config.durations.length - 1);
			window.document.querySelector('#duration').dispatchEvent(new window.Event('change'));
			assert(tableRows().every(row => row.dataset.tier === value));
			window.document.querySelector('#search').value = '';
			window.document.querySelector('#search').dispatchEvent(new window.Event('input'));
		}
		const comparisons = JSON.parse(fs.readFileSync(path.join(directory, 'tier-comparison.json'), 'utf8'));
		const raw = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8')).rows;
		assert.equal(comparisons.length, eligible.filter(profile => tiers.includes(profile.gearTier)).length * provenance.config.durations.length);
		for (const value of tiers) {
			for (const duration of provenance.config.durations) {
				const rows = comparisons.filter(row => row.gearTier === value && row.duration === duration);
				assert.deepEqual(
					rows.map(row => row.withinTierOrder),
					rows.map((_, index) => index + 1),
				);
				for (const row of rows) {
					assert.equal(catalog.profiles.find(profile => profile.id === row.profileId).gearTier, value);
					assert.equal(row.meanDps, raw.find(result => result.profileId === row.profileId && result.duration === duration).meanDps);
				}
			}
		}
		tier.value = tiers[0];
		tier.dispatchEvent(new window.Event('change'));
	} else {
		assert.equal(tableRows().length, eligible.length);
		const sampleClass = eligible[0].className;
		window.document.querySelector('#search').value = sampleClass;
		window.document.querySelector('#search').dispatchEvent(new window.Event('input'));
		assert.equal(tableRows().length, eligible.filter(profile => profile.className === sampleClass).length);
	}
	if (provenance.gearPolicy) {
		const gear = window.document.querySelector('#gearprofile');
		gear.value = catalog.profiles.at(-1).id;
		gear.dispatchEvent(new window.Event('change'));
		assert(window.document.querySelectorAll('#gearrows tr').length > 0);
	} else {
		tableRows()[0].querySelector('button').click();
		assert.equal(window.document.querySelector('dialog').open, true);
		assert(window.document.querySelectorAll('#detailbody tbody tr').length > 0);
	}
	assert(!html.includes('__DATA__'));
	assert(!window.document.querySelector('script[src]'));
	assert(html.includes(provenance.git.commit));
	assert.equal((html.match(/<svg\b/g) ?? []).length, tiered ? tier.options.length + 2 : 3);
	assert.equal((html.match(/<\/svg>/g) ?? []).length, tiered ? tier.options.length + 2 : 3);
	console.log(
		`Verified tier isolation, report scripts, profile details, charts and provenance: ${tiered ? eligible.filter(profile => [...tier.options].some(option => option.value === profile.gearTier)).length : eligible.length} comparable profiles, ${catalog.profiles.length} saved profiles.`,
	);
} finally {
	await window.happyDOM.close();
}
