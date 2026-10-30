import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { hash } from './racial_helpers.mjs';
import { buildSite, verifySite, compactPublishedStats } from './publish_site.mjs';

test('public reports preserve native inputs and metrics while separating raw distributions', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-publication-'));
	try {
		const run = path.join(fixture, 'source'),
			out = path.join(fixture, 'output');
		fs.mkdirSync(run);
		fs.writeFileSync(path.join(run, 'workflow.json'), JSON.stringify({ state: 'passed', commit: 'analytics', model: 'upstream' }));
		const input = Buffer.from('{"player":{"name":"Developer preset"}}\r\n');
		for (const name of ['racials', 'developer-presets', 'shadow-comparison']) {
			const dir = path.join(run, name);
			fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
			fs.mkdirSync(path.join(dir, 'results'));
			fs.writeFileSync(path.join(dir, 'report.html'), '<main><a href="requests/case.json">Input</a><a href="results/case.json">Raw result</a></main>');
			fs.writeFileSync(path.join(dir, 'requests/case.json'), input);
			fs.writeFileSync(
				path.join(dir, 'results/case.json'),
				JSON.stringify({ metrics: { avg: 123, allValues: [100, 146], crits: 4 }, logs: 'raw trace' }),
			);
			fs.writeFileSync(
				path.join(dir, 'provenance.json'),
				JSON.stringify({ settings: { primarySource: 'source', analyticsCommit: 'tooling' }, path: 'C:\\Users\\Example\\private' }),
			);
			fs.writeFileSync(
				path.join(dir, 'cell-index.json'),
				JSON.stringify({ case: { requestSha256: hash(input), resultSha256: hash(fs.readFileSync(path.join(dir, 'results/case.json'))) } }),
			);
		}
		const result = buildSite({ run, out, id: 'test-snapshot', rawBase: 'https://example.org/download' });
		assert(result.htmlLinks > 0);
		const published = path.join(out, 'site/runs/test-snapshot/racials');
		assert.deepEqual(fs.readFileSync(path.join(published, 'requests/case.json')), input);
		const site = path.join(out, 'site');
		execFileSync('git', ['init', '--initial-branch', 'codex/report-site'], { cwd: site, stdio: 'pipe' });
		execFileSync('git', ['-c', 'core.autocrlf=true', 'add', '.'], { cwd: site, stdio: 'pipe' });
		assert.deepEqual(execFileSync('git', ['show', ':runs/test-snapshot/racials/requests/case.json'], { cwd: site }), input);
		const summary = JSON.parse(gunzipSync(fs.readFileSync(path.join(published, 'results/case.summary.json.gz'))).toString());
		assert.equal(summary.metrics.avg, 123);
		assert.equal(summary.metrics.crits, 4);
		assert.equal(summary.metrics.allValues, undefined);
		assert(summary.publication.rawArchive.endsWith('test-snapshot-racials-raw.zip'));
		assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'racials/results/case.json'), 'utf8')).metrics.allValues.length, 2);
		assert(!fs.readFileSync(path.join(published, 'provenance.json'), 'utf8').includes('Example'));
		fs.appendFileSync(path.join(published, 'requests/case.json'), 'changed');
		assert.throws(() => verifySite(path.join(out, 'site')), /Changed public artifact/);
		fs.appendFileSync(path.join(run, 'racials/results/case.json'), 'changed');
		assert.throws(
			() => buildSite({ run, out: path.join(fixture, 'changed-source'), id: 'test-snapshot', rawBase: 'https://example.org/download' }),
			/Source archive changed/,
		);
	} finally {
		assert(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fixture).startsWith('wow-publication-'));
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

test('a standalone verified race study publishes its linked build artifacts', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-publication-'));
	try {
		const source = path.join(fixture, 'source'),
			out = path.join(fixture, 'output');
		for (const folder of ['builds', 'requests', 'results', 'exports', 'stats']) fs.mkdirSync(path.join(source, folder), { recursive: true });
		const input = '{"player":{"race":"RaceDwarf"}}\r\n';
		fs.writeFileSync(path.join(source, 'requests/case.json'), input);
		fs.writeFileSync(path.join(source, 'requests/unlinked.json'), '{"large":"kept in the complete raw archive"}');
		fs.writeFileSync(path.join(source, 'exports/case.website.json'), input);
		const stats = { raidStats: { players: [{ finalStats: { stats: [12, 0, 3.5] }, metadata: { spells: [{ id: 42 }] } }] } };
		fs.writeFileSync(path.join(source, 'stats/case.json'), JSON.stringify(stats));
		fs.writeFileSync(path.join(source, 'results/case.json'), JSON.stringify({ metrics: { avg: 42, allValues: [40, 44] } }));
		fs.mkdirSync(path.join(source, 'hunter-pet-controls/results'), { recursive: true });
		fs.mkdirSync(path.join(source, 'hunter-pet-controls/requests'));
		fs.writeFileSync(path.join(source, 'hunter-pet-controls/requests/pet.json'), input);
		fs.writeFileSync(path.join(source, 'hunter-pet-controls/results/pet.json'), JSON.stringify({ metrics: { avg: 50, allValues: [48, 52] } }));
		fs.writeFileSync(path.join(source, 'report.html'), '<main><a href="builds/case.html">Build</a><a href="verification.json">Checks</a></main>');
		fs.writeFileSync(
			path.join(source, 'builds/case.html'),
			'<main><a href="../requests/case.json">Input</a><a href="../results/case.json">Result</a><a href="../stats/case.json">Stats</a><a href="../exports/case.website.json">Website</a><a href="../hunter-pet-controls/results/pet.json">Pet result</a><a href="../hunter-pet-controls/requests/pet.json">Pet input</a></main>',
		);
		fs.writeFileSync(
			path.join(source, 'provenance.json'),
			JSON.stringify({ analyticsCommit: 'tooling', sourceCommit: 'engine', model: { name: 'upstream' } }),
		);
		fs.writeFileSync(
			path.join(source, 'verification.json'),
			JSON.stringify({ passed: true, inputHashes: { 'provenance.json': hash(fs.readFileSync(path.join(source, 'provenance.json'))) } }),
		);
		buildSite({ robustness: source, out, id: 'race-study', rawBase: 'https://example.org/release' });
		const published = path.join(out, 'site/runs/race-study/race-robustness');
		assert.equal(fs.readFileSync(path.join(published, 'requests/case.json'), 'utf8'), input);
		assert.equal(fs.readFileSync(path.join(published, 'exports/case.website.json'), 'utf8'), input);
		assert(fs.existsSync(path.join(published, 'results/case.html')));
		assert(fs.existsSync(path.join(published, 'hunter-pet-controls/results/pet.html')));
		assert.equal(fs.readFileSync(path.join(published, 'hunter-pet-controls/requests/pet.json'), 'utf8'), input);
		const petSummary = JSON.parse(gunzipSync(fs.readFileSync(path.join(published, 'hunter-pet-controls/results/pet.summary.json.gz'))));
		assert.equal(petSummary.metrics.avg, 50);
		assert.equal(petSummary.metrics.allValues, undefined);
		assert(!fs.existsSync(path.join(published, 'requests/unlinked.json')));
		assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'raw-archives.json')))[0].complete, true);
		const statSummary = JSON.parse(fs.readFileSync(path.join(published, 'stats/case.json')));
		assert.deepEqual(statSummary.raidStats.players[0].finalStats, stats.raidStats.players[0].finalStats);
		assert.equal(statSummary.raidStats.players[0].metadata, undefined);
		const completeStats = gunzipSync(fs.readFileSync(path.join(published, 'stats', statSummary.publication.completeStatsGzip)));
		assert.deepEqual(JSON.parse(completeStats), stats);
		assert.equal(hash(completeStats), statSummary.publication.completePortableSha256);
		const before = fs.readFileSync(path.join(out, 'site/publication-manifest.json'));
		compactPublishedStats(path.join(out, 'site'));
		assert.deepEqual(fs.readFileSync(path.join(out, 'site/publication-manifest.json')), before);
		assert(verifySite(path.join(out, 'site')).htmlLinks > 0);
	} finally {
		assert(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fixture).startsWith('wow-publication-'));
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});
