import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = path.resolve(process.argv[2]);
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = read('provenance.json');
const summary = read('summary.json');
const profiles = read('profiles.json').profiles;
assert.equal(summary.failures.length, 0);
assert.equal(summary.rows.length, profiles.length * manifest.config.durations.length);
assert.equal(manifest.sourceUnchangedDuringRun, true);
for (const row of summary.rows) {
	const name = `${row.profileId}--${row.duration}s.json`;
	assert.equal(hash(path.join(dir, 'requests', name)), row.requestSha256);
	assert.equal(hash(path.join(dir, 'results', name)), row.resultSha256);
	assert.equal(row.iterations, manifest.config.iterations);
}
for (const [file, expected] of Object.entries(read('report-provenance.json').artifacts)) assert.equal(hash(path.join(dir, file)), expected);
const verification = {
	verifiedAt: new Date().toISOString(),
	completedRuns: summary.rows.length,
	simulationErrors: 0,
	iterations: summary.rows.reduce((sum, row) => sum + row.iterations, 0),
	allRequestAndResultHashesVerified: true,
	allReportArtifactHashesVerified: true,
	sourceUnchangedDuringRun: true,
};
fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify(verification));
