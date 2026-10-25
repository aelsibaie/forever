import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

if (!process.argv[2]) throw new Error('Usage: node tools/dps-experiments/verify_report.mjs run-directory');
const directory = path.resolve(process.argv[2]);
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
	const tableRows = () => window.document.querySelectorAll('#matrix tr');
	assert.equal(tableRows().length, eligible.length);
	const sampleClass = eligible[0].className;
	window.document.querySelector('#search').value = sampleClass;
	window.document.querySelector('#search').dispatchEvent(new window.Event('input'));
	assert.equal(tableRows().length, eligible.filter(profile => profile.className === sampleClass).length);
	window.document.querySelector('#duration').value = String(provenance.config.durations.length - 1);
	window.document.querySelector('#duration').dispatchEvent(new window.Event('change'));
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
	window.document.querySelector('#search').value = '';
	window.document.querySelector('#diagnostic').checked = true;
	window.document.querySelector('#diagnostic').dispatchEvent(new window.Event('change'));
	assert.equal(tableRows().length, catalog.profiles.length);
	const tier = window.document.querySelector('#tier');
	if (tier) {
		tier.value = 'pre';
		tier.dispatchEvent(new window.Event('change'));
		assert.equal(tableRows().length, catalog.profiles.filter(profile => profile.documentedPreRaid).length);
		tier.value = 'all';
		tier.dispatchEvent(new window.Event('change'));
	}
	assert(!html.includes('__DATA__'));
	assert(!window.document.querySelector('script[src]'));
	assert(html.includes(provenance.git.commit));
	assert.equal((html.match(/<svg\b/g) ?? []).length, 3);
	assert.equal((html.match(/<\/svg>/g) ?? []).length, 3);
	console.log(
		`Verified report scripts, filters, profile details, charts and provenance: ${eligible.length} ranked profiles, ${catalog.profiles.length} with diagnostics.`,
	);
} finally {
	await window.happyDOM.close();
}
