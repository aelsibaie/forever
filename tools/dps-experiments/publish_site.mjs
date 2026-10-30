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

export function compactPublishedStats(directory) {
	const site = path.resolve(directory);
	verifySite(site);
	const manifest = read(path.join(site, 'publication-manifest.json'));
	const origins = new Map();
	const withoutMetadata = value =>
		Array.isArray(value)
			? value.map(withoutMetadata)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.entries(value)
							.filter(([key]) => key !== 'metadata')
							.map(([key, item]) => [key, withoutMetadata(item)]),
					)
				: value;
	for (const file of Object.keys(manifest.files).filter(file => file.includes('/stats/') && file.endsWith('.json'))) {
		const target = path.join(site, file),
			bytes = fs.readFileSync(target),
			data = JSON.parse(bytes);
		if (data.publication?.completeStatsGzip) continue;
		const compressed = file.replace(/\.json$/, '.full.json.gz'),
			packed = gzipSync(bytes);
		fs.writeFileSync(path.join(site, compressed), packed);
		const summary = withoutMetadata(data);
		summary.publication = {
			representation: 'Pre-combat stats; spell and aura metadata remains in the complete portable gzip output and raw archive.',
			completeStatsGzip: path.posix.basename(compressed),
			completePortableSha256: hash(bytes),
		};
		fs.writeFileSync(target, JSON.stringify(summary));
		manifest.files[file] = hash(fs.readFileSync(target));
		manifest.files[compressed] = hash(packed);
		const originFile = path.posix.join(...file.split('/').slice(0, 2), 'origins.json');
		if (!origins.has(originFile)) origins.set(originFile, read(path.join(site, originFile)));
		const records = origins.get(originFile),
			original = records[file];
		assert(original, 'Published stats have no source receipt: ' + file);
		records[file] = { ...original, publishedSha256: manifest.files[file], representation: 'Pre-combat stats summary' };
		records[compressed] = { ...original, publishedSha256: manifest.files[compressed], representation: 'Complete portable stats and metadata (gzip)' };
	}
	for (const [file, records] of origins) {
		fs.writeFileSync(path.join(site, file), JSON.stringify(records));
		manifest.files[file] = hash(fs.readFileSync(path.join(site, file)));
	}
	fs.writeFileSync(path.join(site, 'publication-manifest.json'), JSON.stringify(manifest, null, 2));
	return verifySite(site);
}

export function buildSite({ run, out, id, rawBase, assessment, robustness }) {
	assert(/^[a-z0-9][a-z0-9-]+$/.test(id), 'Use a portable snapshot ID.');
	assert(!fs.existsSync(out), 'Publication output already exists.');
	const standalone = !!robustness && !run;
	const robustnessRoot = robustness ?? (run && path.join(run, 'race-robustness'));
	let receipt;
	if (standalone) {
		const verified = read(path.join(robustnessRoot, 'verification.json'));
		assert(verified.passed && verified.inputHashes, 'Publish an independently verified robustness study.');
		for (const [file, expected] of Object.entries(verified.inputHashes))
			assert.equal(hash(fs.readFileSync(path.join(robustnessRoot, file))), expected, 'Verified study input changed: ' + file);
		const p = read(path.join(robustnessRoot, 'provenance.json'));
		receipt = {
			kind: 'verified-race-robustness',
			state: 'passed',
			commit: p.analyticsCommit,
			model: p.model.name,
			sourceCommit: p.sourceCommit,
			verificationSha256: hash(fs.readFileSync(path.join(robustnessRoot, 'verification.json'))),
		};
	} else receipt = read(path.join(run, 'workflow.json'));
	assert.equal(receipt.state, 'passed', 'Publish a completed workflow.');
	const corrected = receipt.correction?.comparison?.split('/')[0] ?? 'shadow-comparison';
	const sections = (
		standalone
			? []
			: [
					['racials', 'Races: Horde and Alliance'],
					['developer-presets', 'DPS by gear tier'],
					[corrected, 'Matched Shadow engine comparison'],
				]
	).filter(([name]) => fs.existsSync(path.join(run, name, 'report.html')));
	if (robustnessRoot && fs.existsSync(path.join(robustnessRoot, 'report.html')))
		sections.unshift(['race-robustness', 'Race choices across gear and conditions']);
	const assessmentRoot = assessment ?? path.join(run ?? robustnessRoot, 'assessment');
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
		const source =
				name === 'race-robustness'
					? robustnessRoot
					: path.join(['spec-audit', 'engine-compatibility', 'common-spell-probes'].includes(name) ? assessmentRoot : run, name),
			destination = path.join(snapshot, name);
		fs.mkdirSync(destination, { recursive: true });
		const recorded = fs.existsSync(path.join(source, 'cells.json'))
			? read(path.join(source, 'cells.json'))
			: fs.existsSync(path.join(source, 'summary.json'))
				? read(path.join(source, 'summary.json')).rows
				: fs.existsSync(path.join(source, 'results.json'))
					? read(path.join(source, 'results.json')).rows
					: [];
		const indexed = fs.existsSync(path.join(source, 'cell-index.json'))
			? Object.entries(read(path.join(source, 'cell-index.json'))).map(([key, value]) => ({ key, ...value }))
			: [];
		for (const row of [...(recorded ?? []), ...indexed])
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
		const assetUrl = rawBase + '/' + id + '-' + name + '-raw.zip';
		const rawUrl = name === 'race-robustness' ? rawBase.replace('/releases/download/', '/releases/tag/') : assetUrl;
		downloads.push({ name, title, url: assetUrl, reportUrl: rawUrl, source, complete: name === 'race-robustness' });
		const selected = name === 'race-robustness' ? new Set() : null;
		if (selected) {
			for (const file of files(source).filter(
				file => file === path.join(source, 'report.html') || (path.relative(source, file).startsWith('builds' + path.sep) && file.endsWith('.html')),
			)) {
				selected.add(path.resolve(file));
				for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:href|src)="([^"]+)"/g)) {
					if (/^(?:https?:|mailto:|data:|#)/.test(match[1])) continue;
					const target = path.resolve(path.dirname(file), decodeURI(match[1].split('#')[0].split('?')[0]));
					assert(target.startsWith(path.resolve(source) + path.sep), 'Study link escapes its archive.');
					selected.add(target);
				}
			}
		}
		for (const file of files(source)) {
			const relative = path.relative(source, file).replaceAll('\\', '/'),
				first = relative.split('/')[0];
			if (selected && !selected.has(path.resolve(file))) continue;
			if (
				!selected &&
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
			const dataFolder = relative.split('/').at(-2);
			const untouched = dataFolder === 'requests' || relative.endsWith('.website.json');
			if (['results', 'debug'].includes(dataFolder) && relative.endsWith('.json')) {
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
				const summary = ['results', 'debug'].includes(dataFolder),
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
					.replace(/(href="[^":\n]*\b(?:results|debug)\/[^"\n]+)\.json"/g, '$1.html"');
				html = html.includes('<body>')
					? html.replace('<body>', '<body>' + banner)
					: html.includes('<main>')
						? html.replace('<main>', banner + '<main>')
						: html.replace('</style>', '</style>' + banner);
				bytes = Buffer.from(html);
			}
			fs.writeFileSync(target, bytes);
			origins[path.relative(site, target).replaceAll('\\', '/')] = {
				originalSha256: hash(fs.readFileSync(file)),
				publishedSha256: hash(bytes),
				representation: untouched ? 'Exact input' : ['results', 'debug'].includes(dataFolder) ? 'Result summary' : 'Portable report artifact',
			};
		}
	}
	fs.writeFileSync(path.join(snapshot, 'workflow.json'), JSON.stringify(publicJson(receipt), null, 2));
	const latest = read(standalone ? path.join(robustnessRoot, 'provenance.json') : path.join(run, corrected, 'provenance.json'));
	const sourceCommit = standalone ? latest.sourceCommit : latest.settings.primarySource;
	const analyticsCommit = standalone ? latest.analyticsCommit : latest.settings.analyticsCommit;
	const body =
		'<small>INDEPENDENT WOWSIMS FOREVER ANALYTICS</small><h1>Races, builds and fight length</h1><p>WoWSims is the primary simulator. Baselines preserve developer gear; sensitivity experiments identify each explicit change.</p><p>60 / 180 / 300 seconds · Horde and Alliance · Snapshot <code>' +
		escape(id) +
		'</code></p><div class="cards">' +
		sections.map(([name, title]) => '<a href="' + name + '/report.html">' + escape(title) + '</a>').join('') +
		'</div><section><h2>What these comparisons mean</h2><p>' +
		(standalone
			? 'Fixed-set comparisons hold equipment constant. Selected-gear comparisons let each race choose from the same declared catalogue, then confirm its selection with independent samples. The report keeps developer and published pre-raid pools separate.'
			: 'Races are compared within the same build and gear. Cross-spec rankings are separated by documented gear tier.') +
		' Testing presets and unsupported mechanics have explicit caveats. Sampling intervals do not measure model uncertainty.</p><p>Main model: <code>' +
		escape(receipt.model) +
		'</code>. Engine source <code>' +
		escape(sourceCommit) +
		(standalone ? '</code>; analytics checkout at run start <code>' : '</code>; matched comparison tooling <code>') +
		escape(analyticsCommit) +
		'</code>.</p><p><a href="workflow.json">Portable workflow receipt</a> · <a href="origins.json">Source and public artifact checksums</a> · <a href="https://github.com/aelsibaie/forever/tree/codex/analytics/tools/dps-experiments">Methods and rerun tools</a></p></section><section><h2>Complete raw outputs</h2><p>The site includes readable result summaries, exact native inputs, website imports and charts. These ZIPs retain the original result JSON and debug files. The robustness archive also includes the original inputs, stats, metadata and tooling. Engine binaries remain in the local experiment archive; pinned source and model details are recorded.</p><ul>' +
		downloads
			.map(
				d => '<li><a href="' + d.reportUrl + '">' + escape(d.title) + (d.complete ? ' raw archive parts (download all)' : ' raw archive') + '</a></li>',
			)
			.join('') +
		'</ul></section>';
	fs.writeFileSync(path.join(snapshot, 'report.html'), document('WoWSims Forever analytics', body));
	fs.writeFileSync(path.join(snapshot, 'origins.json'), JSON.stringify(origins));
	fs.writeFileSync(path.join(site, '.nojekyll'), '');
	// Artifact checksums describe stored bytes, so Git text normalization stays off.
	fs.writeFileSync(path.join(site, '.gitattributes'), '* -text\n');
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
		comparisonAnalyticsCommit: analyticsCommit,
		rawDownloads: downloads.map(({ source, ...item }) => ({ ...item, url: item.reportUrl })),
		files: Object.fromEntries(files(site).map(file => [path.relative(site, file).replaceAll('\\', '/'), hash(fs.readFileSync(file))])),
	};
	fs.writeFileSync(path.join(site, 'publication-manifest.json'), JSON.stringify(manifest, null, 2));
	fs.writeFileSync(
		path.join(out, 'raw-archives.json'),
		JSON.stringify(
			downloads.map(d => ({ source: d.source, output: path.join(out, 'downloads', id + '-' + d.name + '-raw.zip'), url: d.url, complete: d.complete })),
			null,
			2,
		),
	);
	return compactPublishedStats(site);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2),
		option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
	if (args.includes('--help')) {
		console.log(
			'node tools/dps-experiments/publish_site.mjs (--run archive | --robustness verified-study) --out new-directory --id snapshot-id --raw-base release-download-url [--make-raw] [--python executable]\nUse --verify site-directory to verify an existing publication.',
		);
		process.exit(0);
	}
	if (args.includes('--compact-stats')) {
		console.log(JSON.stringify(compactPublishedStats(path.resolve(option('--compact-stats')))));
		process.exit(0);
	}
	if (args.includes('--verify')) {
		console.log(JSON.stringify(verifySite(path.resolve(option('--verify')))));
		process.exit(0);
	}
	for (const key of ['--out', '--id', '--raw-base']) assert(option(key), 'Missing ' + key);
	assert(option('--run') || option('--robustness'), 'Supply --run or --robustness.');
	const out = path.resolve(option('--out'));
	const result = buildSite({
		run: option('--run') ? path.resolve(option('--run')) : undefined,
		robustness: option('--robustness') ? path.resolve(option('--robustness')) : undefined,
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
