import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildSite, verifySite } from './publish_site.mjs';

test('public reports preserve native inputs and metrics while separating raw distributions', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-publication-'));
	try {
		const run = path.join(fixture, 'source'),
			out = path.join(fixture, 'output');
		fs.mkdirSync(run);
		fs.writeFileSync(path.join(run, 'workflow.json'), JSON.stringify({ state: 'passed', commit: 'analytics', model: 'upstream' }));
		const input = Buffer.from('{"player":{"name":"Developer preset"}}\n');
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
		}
		const result = buildSite({ run, out, id: 'test-snapshot', rawBase: 'https://example.org/download' });
		assert(result.htmlLinks > 0);
		const published = path.join(out, 'site/runs/test-snapshot/racials');
		assert.deepEqual(fs.readFileSync(path.join(published, 'requests/case.json')), input);
		const summary = JSON.parse(gunzipSync(fs.readFileSync(path.join(published, 'results/case.summary.json.gz'))).toString());
		assert.equal(summary.metrics.avg, 123);
		assert.equal(summary.metrics.crits, 4);
		assert.equal(summary.metrics.allValues, undefined);
		assert(summary.publication.rawArchive.endsWith('test-snapshot-racials-raw.zip'));
		assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'racials/results/case.json'), 'utf8')).metrics.allValues.length, 2);
		assert(!fs.readFileSync(path.join(published, 'provenance.json'), 'utf8').includes('Example'));
		fs.appendFileSync(path.join(published, 'requests/case.json'), 'changed');
		assert.throws(() => verifySite(path.join(out, 'site')), /Changed public artifact/);
	} finally {
		assert(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fixture).startsWith('wow-publication-'));
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});
