import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hash } from './racial_helpers.mjs';
import { summarizeResult } from './statistics.mjs';

const root = path.resolve(process.argv[2]);
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const provenance = read('provenance.json'),
	completion = read('completion.json');
assert.equal(completion.fingerprint, provenance.fingerprint);
assert(completion.normalizedRotationEquivalent && completion.primaryEngineUnchanged);
assert.notEqual(provenance.settings.seed, provenance.settings.gunbaSeed, 'Cross-engine uncertainty requires different engine seeds.');
assert(Math.abs(provenance.settings.seed - provenance.settings.gunbaSeed) >= provenance.settings.iterations, 'Engine iteration seed ranges overlap.');
const rows = read('results.json').rows;
assert.equal(rows.length, provenance.settings.durations.length * 8);
assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
for (const row of rows) {
	for (const [folder, field] of [
		['requests', 'requestSha256'],
		['results', 'resultSha256'],
	])
		assert.equal(hash(fs.readFileSync(path.join(root, folder, row.key + '.json'))), row[field]);
	const result = read('results/' + row.key + '.json'),
		metrics = summarizeResult(result, provenance.settings.iterations);
	const expectedSeed = String(row.engine.startsWith('gunba') ? provenance.settings.gunbaSeed : provenance.settings.seed);
	assert.equal(read('requests/' + row.key + '.json').simOptions.randomSeed, expectedSeed);
	assert.equal(row.seed, expectedSeed);
	assert.equal(metrics.meanDps, row.meanDps);
	if (row.engine === 'wowsims') {
		const control = read('results/' + row.key.replace(/^wowsims--/, 'control--') + '.json');
		assert.deepEqual(result.raidMetrics.parties[0].players[0].dps.allValues, control.raidMetrics.parties[0].players[0].dps.allValues);
	}
}
for (const [file, expected] of Object.entries(read('report-provenance.json').artifacts))
	assert.equal(hash(fs.readFileSync(path.join(root, file))), expected, 'Changed artifact: ' + file);
for (const match of fs.readFileSync(path.join(root, 'report.html'), 'utf8').matchAll(/(?:href|src)="([^"]+)"/g)) {
	if (/^https?:|^#/.test(match[1])) continue;
	const target = path.resolve(root, match[1]);
	assert(target.startsWith(root + path.sep) && fs.existsSync(target), 'Missing comparison link: ' + match[1]);
}
console.log(JSON.stringify({ matchedCells: rows.length, controlsEquivalent: true, hashesVerified: true }));
