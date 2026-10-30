import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadProfiles } from './export.mjs';

export function verifyDetails(directory, { allowedRoot = directory } = {}) {
	const root = path.resolve(directory);
	const boundary = path.resolve(allowedRoot);
	const index = JSON.parse(fs.readFileSync(path.join(root, 'profile-index.json'), 'utf8'));
	assert(index.length > 0, 'Missing build inspection pages.');
	assert.equal(new Set(index.map(x => x.href)).size, index.length, 'Duplicate build page.');
	let links = 0;
	for (const row of index) {
		const file = path.join(root, row.href),
			html = fs.readFileSync(file, 'utf8');
		const data = JSON.parse(fs.readFileSync(file.replace(/\.html$/, '.json'), 'utf8'));
		assert.equal(data.profile.id, row.profileId, 'Build data and index differ.');
		for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
			if (/^https?:|^#/.test(match[1])) continue;
			const target = path.resolve(path.dirname(file), match[1]);
			assert(target.startsWith(boundary + path.sep), 'Build page escapes its archive.');
			assert(fs.existsSync(target), 'Missing build artifact: ' + match[1]);
			links++;
		}
		for (const pair of data.comparisons)
			if (pair.confirmation) {
				assert.equal(pair.primary.profileId, pair.confirmation.profileId);
				assert.equal(pair.primary.faction, pair.confirmation.faction);
				assert.equal(pair.primary.duration, pair.confirmation.duration);
			}
	}
	return { profiles: index.length, links };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const directory = path.resolve(process.argv[2]);
	const result = verifyDetails(directory);
	if (process.argv.includes('--schema')) {
		const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
		const loaded = await loadProfiles(repository);
		let checked = 0;
		for (const entry of fs.readdirSync(path.join(directory, 'profiles')).filter(f => f.endsWith('.website.json'))) {
			const json = JSON.parse(fs.readFileSync(path.join(directory, 'profiles', entry), 'utf8'));
			const normalized = loaded.validateWebsite(json);
			assert.deepEqual(normalized.player, json.player, 'Website export changes player fields.');
			assert.deepEqual(normalized.encounter, json.encounter, 'Website export changes encounter.');
			for (const field of ['raidBuffs', 'partyBuffs', 'debuffs', 'tanks'])
				assert.deepEqual(normalized[field] ?? (field === 'tanks' ? [] : {}), json[field], 'Website export changes ' + field + '.');
			for (const field of ['iterations', 'fixedRngSeed'])
				assert.equal(normalized.settings[field], json.settings[field], 'Website export changes ' + field + '.');
			checked++;
		}
		assert(checked > 0, 'No schema-validated website exports.');
		result.websiteExports = checked;
	}
	console.log(JSON.stringify(result));
}
