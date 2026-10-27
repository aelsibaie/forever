import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const style =
	'body{background:#0b1220;color:#edf3fc;font:16px/1.65 system-ui;margin:0}main{max-width:1150px;margin:auto;padding:38px 24px}a{color:#80caff}section{background:#121d30;border:1px solid #25344b;border-radius:14px;padding:24px;margin:24px 0}h1{font-size:42px;line-height:1.12}small{color:#a1afc5}code{overflow-wrap:anywhere}li{margin:12px 0}table{width:100%;border-collapse:collapse}td,th{padding:12px;text-align:left;border-bottom:1px solid #293c53}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.cards a{display:block;padding:22px;background:#17263e;border-radius:12px;text-decoration:none;font-size:20px}';
const document = (title, body) =>
	'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
	escape(title) +
	'</title><style>' +
	style +
	'</style><main>' +
	body +
	'</main></html>';

function files(directory) {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap(entry => (entry.name === '.git' ? [] : entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
}

export function publicJson(value, { summary = false } = {}) {
	if (Array.isArray(value)) return value.map(x => publicJson(x, { summary }));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !((summary && ['allValues', 'hist', 'aggregatorData', 'ranges', 'logs'].includes(key)) || key === 'environment'))
				.map(([key, item]) => [key === 'artifacts' ? 'sourceArtifacts' : key, publicJson(item, { summary })]),
		);
	if (typeof value === 'string' && /^(?:[a-z]:[\\/]|file:\/\/|\/Users\/|\/home\/)/i.test(value)) return '[local path omitted]';
	return value;
}

export function verifySite(directory) {
	const site = path.resolve(directory),
		manifest = read(path.join(site, 'publication-manifest.json'));
	for (const [file, expected] of Object.entries(manifest.files))
		assert.equal(hash(fs.readFileSync(path.join(site, file))), expected, 'Changed public artifact: ' + file);
	let links = 0;
	for (const file of files(site).filter(f => f.endsWith('.html'))) {
		const html = fs.readFileSync(file, 'utf8');
		assert(!/file:\/\/|[a-z]:\\Users\\/i.test(html), 'Local path in public HTML: ' + file);
		for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
			const href = match[1];
			if (/^(?:https?:|mailto:|data:|#)/.test(href) || href.includes('${')) continue;
			const target = path.resolve(path.dirname(file), decodeURI(href.split('#')[0].split('?')[0]));
			assert(target === site || target.startsWith(site + path.sep), 'Public link escapes site: ' + href);
			assert(fs.existsSync(target), 'Missing public link: ' + path.relative(site, file) + ' → ' + href);
			links++;
		}
	}
	return { files: Object.keys(manifest.files).length, htmlLinks: links, bytes: files(site).reduce((sum, file) => sum + fs.statSync(file).size, 0) };
}

export function buildSite({ run, out, id, rawBase, assessment }) {
	assert(/^[a-z0-9][a-z0-9-]+$/.test(id), 'Use a portable snapshot ID.');
	assert(!fs.existsSync(out), 'Publication output already exists.');
	const receipt = read(path.join(run, 'workflow.json'));
	assert.equal(receipt.state, 'passed', 'Publish a completed workflow.');
	const corrected = receipt.correction?.comparison?.split('/')[0] ?? 'shadow-comparison';
	const sections = [
		['racials', 'Races: Horde and Alliance'],
		['developer-presets', 'DPS by gear tier'],
		[corrected, 'Matched Shadow engine comparison'],
	].filter(([name]) => fs.existsSync(path.join(run, name, 'report.html')));
	const assessmentRoot = assessment ?? path.join(run, 'assessment');
	for (const [name, title] of [
		['spec-audit', 'All-spec audit and gear sensitivities'],
		['engine-compatibility', 'Developer-rotation engine compatibility'],
		['common-spell-probes', 'Common-spell engine diagnostics'],
	])
		if (fs.existsSync(path.join(assessmentRoot, name, 'report.html'))) sections.push([name, title]);
	const site = path.join(out, 'site'),
		snapshot = path.join(site, 'runs', id);
	fs.mkdirSync(snapshot, { recursive: true });
	const origins = {},
		downloads = [];
	const publicFiles = new Set([
		'report.html',
		'summary.json',
		'summary.csv',
		'tier-comparison.json',
		'tier-comparison.csv',
		'profiles.json',
		'profile-index.json',
		'report-inputs.json',
		'preset-audit.json',
		'provenance.json',
		'report-provenance.json',
		'artifact-hashes.json',
		'analysis.json',
		'cells.json',
		'race-comparison.csv',
		'equipment-audit.json',
		'faction-controls.json',
		'activation-controls.json',
		'numerical-review.json',
		'plot-environment.json',
		'completion.json',
		'results.json',
		'comparison.json',
		'stat-calibration.json',
	]);
	for (const [name, title] of sections) {
		const source = path.join(['spec-audit', 'engine-compatibility', 'common-spell-probes'].includes(name) ? assessmentRoot : run, name),
			destination = path.join(snapshot, name);
		fs.mkdirSync(destination, { recursive: true });
		const recorded = fs.existsSync(path.join(source, 'cells.json'))
			? read(path.join(source, 'cells.json'))
			: fs.existsSync(path.join(source, 'summary.json'))
				? read(path.join(source, 'summary.json')).rows
				: fs.existsSync(path.join(source, 'results.json'))
					? read(path.join(source, 'results.json')).rows
					: [];
		for (const row of recorded ?? [])
			for (const [folder, key] of [
				['requests', 'requestSha256'],
				['results', 'resultSha256'],
			]) {
				if (!row[key]) continue;
				const name = row.key ?? row.profileId + '--' + row.duration + 's';
				assert.equal(hash(fs.readFileSync(path.join(source, folder, name + '.json'))), row[key], 'Source archive changed: ' + name);
			}
		for (const filename of ['artifact-hashes.json', 'report-provenance.json'])
			if (fs.existsSync(path.join(source, filename))) {
				const value = read(path.join(source, filename));
				for (const [relative, expected] of Object.entries(filename === 'artifact-hashes.json' ? value : (value.artifacts ?? {}))) {
					const file = path.resolve(source, relative);
					assert(file.startsWith(path.resolve(source) + path.sep), 'Source manifest escapes archive.');
					assert.equal(hash(fs.readFileSync(file)), expected, 'Source report changed: ' + relative);
				}
			}
		const rawUrl = rawBase + '/' + id + '-' + name + '-raw.zip';
		downloads.push({ name, title, url: rawUrl, source });
		for (const file of files(source)) {
			const relative = path.relative(source, file).replaceAll('\\', '/'),
				first = relative.split('/')[0];
			if (
				!['profiles', 'charts', 'requests', 'results', 'stats', 'debug'].includes(first) &&
				!publicFiles.has(relative) &&
				!(first === relative && /\.(?:json|csv|png|svg)$/.test(relative))
			)
				continue;
			if (first === 'debug' && !relative.endsWith('.json')) continue;
			if (!/\.(?:html|json|csv|png|svg)$/.test(relative)) continue;
			const target = path.join(destination, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			let bytes = fs.readFileSync(file);
			const untouched = first === 'requests' || relative.endsWith('.website.json');
			if (['results', 'debug'].includes(first) && relative.endsWith('.json')) {
				const data = read(file),
					summary = publicJson(data, { summary: true }),
					originalSha256 = hash(bytes),
					count = data.iterationsDone || 1;
				const compressed = target.replace(/\.json$/, '.summary.json.gz'),
					htmlFile = target.replace(/\.json$/, '.html');
				summary.publication = {
					representation: 'Summary metrics; the raw archive preserves all original JSON fields.',
					rawArchive: rawUrl,
					archivePath: relative,
					originalSha256,
				};
				fs.writeFileSync(compressed, gzipSync(JSON.stringify(summary)));
				const player = data.raidMetrics?.parties?.[0]?.players?.[0];
				const metrics = player
					? '<p>' +
						Number(player.dps.avg).toFixed(3) +
						' native player DPS · ' +
						count.toLocaleString() +
						' iterations · ' +
						Number(player.secondsOomAvg || 0).toFixed(3) +
						' seconds recorded OOM.</p>'
					: '<p>Native result summary.</p>';
				const actors = player ? [player, ...(player.pets ?? [])] : [];
				const rows = actors
					.flatMap(actor =>
						(actor.actions ?? []).map(action => {
							const t = action.targets?.[0] ?? {};
							return (
								'<tr><td>' +
								escape(actor.name) +
								' / ' +
								escape(JSON.stringify(action.id)) +
								'</td><td>' +
								((t.damage || 0) / count).toFixed(2) +
								'</td><td>' +
								((t.casts || 0) / count).toFixed(3) +
								'</td><td>' +
								(((t.crits || 0) + (t.critTicks || 0)) / count).toFixed(3) +
								'</td></tr>'
							);
						}),
					)
					.join('');
				const back = path.relative(path.dirname(htmlFile), snapshot).replaceAll('\\', '/') + '/report.html';
				const page = document(
					'Simulation result summary',
					'<p><a href="' +
						back +
						'">All reports</a></p><h1>Result summary</h1><code>' +
						escape(relative) +
						'</code>' +
						metrics +
						'<p><a href="' +
						escape(path.basename(compressed)) +
						'">Download summary counters (gzip JSON)</a> · <a href="' +
						rawUrl +
						'">Complete original outputs (ZIP)</a></p><p>Original JSON SHA-256: <code>' +
						originalSha256 +
						'</code>. The ZIP entry is <code>' +
						escape(relative) +
						'</code>.</p><table><thead><tr><th>Actor / action ID</th><th>Damage per fight</th><th>Casts per fight</th><th>Crits per fight</th></tr></thead><tbody>' +
						rows +
						'</tbody></table>',
				);
				fs.writeFileSync(htmlFile, page);
				for (const output of [compressed, htmlFile])
					origins[path.relative(site, output).replaceAll('\\', '/')] = {
						originalSha256,
						publishedSha256: hash(fs.readFileSync(output)),
						representation: 'Result summary; original JSON in raw release archive',
					};
				continue;
			}
			if (relative.endsWith('.json') && !untouched) {
				const summary = ['results', 'debug'].includes(first),
					data = publicJson(read(file), { summary });
				if (summary)
					data.publication = {
						representation: 'Result summary; distributions, histograms, ranges and logs are in the raw archive.',
						rawArchive: rawUrl,
						archivePath: relative,
						originalSha256: hash(bytes),
					};
				bytes = Buffer.from(JSON.stringify(data));
			}
			if (relative.endsWith('.html')) {
				const prefix = path.relative(path.dirname(target), snapshot).replaceAll('\\', '/') || '.';
				const auditNotice =
					name === 'racials' && sections.some(([name]) => name === 'spec-audit')
						? ' · <a style="color:#80caff" href="' +
							prefix +
							'/spec-audit/report.html">Later all-spec audit: warning review and gear/mana sensitivities</a>'
						: '';
				const banner =
					'<aside style="padding:14px 24px;background:#17263e;font:14px/1.5 system-ui;color:#edf3fc"><a style="color:#80caff" href="' +
					prefix +
					'/report.html">All reports</a> · Public result files are summaries. <a style="color:#80caff" href="' +
					rawUrl +
					'">Download complete raw outputs</a>. Inputs and website exports are unchanged.' +
					auditNotice +
					'</aside>';
				let html = bytes
					.toString('utf8')
					.replaceAll('>Full output</a>', '>Result summary</a>')
					.replaceAll('>Raw result</a>', '>Result summary</a>')
					.replaceAll('>Debug result</a>', '>Debug summary</a>')
					.replace(/(href="(?:\.\.\/)*(?:results|debug)\/[^"\n]+)\.json"/g, '$1.html"');
				html = html.includes('<body>') ? html.replace('<body>', '<body>' + banner) : html.replace('<main>', banner + '<main>');
				bytes = Buffer.from(html);
			}
			fs.writeFileSync(target, bytes);
			origins[path.relative(site, target).replaceAll('\\', '/')] = {
				originalSha256: hash(fs.readFileSync(file)),
				publishedSha256: hash(bytes),
				representation: untouched ? 'Exact input' : first === 'results' || first === 'debug' ? 'Result summary' : 'Portable report artifact',
			};
		}
	}
	fs.writeFileSync(path.join(snapshot, 'workflow.json'), JSON.stringify(publicJson(receipt), null, 2));
	const latest = read(path.join(run, corrected, 'provenance.json'));
	const body =
		'<small>INDEPENDENT WOWSIMS FOREVER ANALYTICS</small><h1>Races, builds and fight length</h1><p>WoWSims is the primary simulator. Baselines preserve developer gear; sensitivity experiments identify each explicit change.</p><p>60 / 180 / 300 seconds · Horde and Alliance · Snapshot <code>' +
		escape(id) +
		'</code></p><div class="cards">' +
		sections.map(([name, title]) => '<a href="' + name + '/report.html">' + escape(title) + '</a>').join('') +
		'</div><section><h2>What these comparisons mean</h2><p>Races are compared within the same build and gear. Cross-spec rankings are separated by documented gear tier. Testing presets and unsupported mechanics have explicit caveats. Sampling intervals do not measure model uncertainty.</p><p>Main model: <code>' +
		escape(receipt.model) +
		'</code>. Engine source <code>' +
		escape(latest.settings.primarySource) +
		'</code>; matched comparison tooling <code>' +
		escape(latest.settings.analyticsCommit) +
		'</code>.</p><p><a href="workflow.json">Portable workflow receipt</a> · <a href="origins.json">Source and public artifact checksums</a> · <a href="https://github.com/aelsibaie/forever/tree/codex/analytics/tools/dps-experiments">Methods and rerun tools</a></p></section><section><h2>Complete raw outputs</h2><p>The site includes readable result summaries, exact native inputs, website imports and charts. These ZIPs retain the complete original result JSON and debug files. Engine binaries remain in the local experiment archive; pinned source and model details are recorded.</p><ul>' +
		downloads.map(d => '<li><a href="' + d.url + '">' + escape(d.title) + ' raw archive</a></li>').join('') +
		'</ul></section>';
	fs.writeFileSync(path.join(snapshot, 'report.html'), document('WoWSims Forever analytics', body));
	fs.writeFileSync(path.join(snapshot, 'origins.json'), JSON.stringify(origins));
	fs.writeFileSync(path.join(site, '.nojekyll'), '');
	fs.writeFileSync(
		path.join(site, 'index.html'),
		document(
			'WoWSims Forever analytics',
			'<h1>WoWSims Forever analytics</h1><p>Independent, reproducible DPS and racial comparisons.</p><section><h2>Latest report</h2><p><a href="runs/' +
				id +
				'/report.html">Open the complete report</a></p><p>Snapshot ' +
				escape(id) +
				'. WoWSims remains primary; every report records gear, rotations, model and source versions.</p></section>',
		),
	);
	fs.mkdirSync(path.join(site, 'latest'));
	fs.writeFileSync(
		path.join(site, 'latest/index.html'),
		document('Latest analytics report', '<h1>Latest report</h1><a href="../runs/' + id + '/report.html">Open the latest complete report</a>'),
	);
	const manifest = {
		schemaVersion: 1,
		id,
		createdAt: new Date().toISOString(),
		sourceAnalyticsCommit: receipt.commit,
		comparisonAnalyticsCommit: latest.settings.analyticsCommit,
		rawDownloads: downloads.map(({ source, ...item }) => item),
		files: Object.fromEntries(files(site).map(file => [path.relative(site, file).replaceAll('\\', '/'), hash(fs.readFileSync(file))])),
	};
	fs.writeFileSync(path.join(site, 'publication-manifest.json'), JSON.stringify(manifest, null, 2));
	fs.writeFileSync(
		path.join(out, 'raw-archives.json'),
		JSON.stringify(
			downloads.map(d => ({ source: d.source, output: path.join(out, 'downloads', id + '-' + d.name + '-raw.zip'), url: d.url })),
			null,
			2,
		),
	);
	return verifySite(site);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2),
		option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
	if (args.includes('--help')) {
		console.log(
			'node tools/dps-experiments/publish_site.mjs --run archive --out new-directory --id snapshot-id --raw-base release-download-url [--make-raw] [--python executable]\nUse --verify site-directory to verify an existing publication.',
		);
		process.exit(0);
	}
	if (args.includes('--verify')) {
		console.log(JSON.stringify(verifySite(path.resolve(option('--verify')))));
		process.exit(0);
	}
	for (const key of ['--run', '--out', '--id', '--raw-base']) assert(option(key), 'Missing ' + key);
	const out = path.resolve(option('--out'));
	const result = buildSite({
		run: path.resolve(option('--run')),
		out,
		id: option('--id'),
		rawBase: option('--raw-base'),
		assessment: option('--assessment') ? path.resolve(option('--assessment')) : undefined,
	});
	console.log(JSON.stringify(result));
	if (args.includes('--make-raw')) {
		const python = option(
			'--python',
			process.env.PYTHON_BINARY ?? path.join(root, 'tmp/analytics-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
		);
		execFileSync(python, [path.join(root, 'tools/dps-experiments/zip_raw.py'), path.join(out, 'raw-archives.json')], { stdio: 'inherit' });
	}
}
