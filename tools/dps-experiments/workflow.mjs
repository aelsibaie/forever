import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log(
		'Usage: node tools/dps-experiments/workflow.mjs [--prepared] [--audit] [--robustness] [--allow-partial-published] [--gear-catalog file] [--refresh-gear --source-archive directory] [--python executable] [--out directory] [--model upstream|notes-2026-10-27] [--reference saved-developer-run] [--reuse-racials saved-racial-run] [--gunba-source directory]\nRuns racial and tiered developer DPS reports with the same native engine. --robustness adds shared equipment pools, hit controls and independent race recommendations. Optional Gunba comparison uses the pinned adapter. Source updates and Git commits are separate. Outputs are immutable.',
	);
	process.exit(0);
}
const flags = new Set(['--prepared', '--audit', '--robustness', '--refresh-gear', '--allow-partial-published']),
	values = new Set(['--python', '--out', '--model', '--reference', '--gunba-source', '--reuse-racials', '--gear-catalog', '--source-archive']);
const options = {};
for (let i = 0; i < args.length; i++) {
	if (flags.has(args[i])) options[args[i].slice(2)] = true;
	else if (values.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
	else throw new Error('Unknown or incomplete option: ' + args[i]);
}
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
if (options['allow-partial-published'] && !options.robustness) throw new Error('--allow-partial-published requires --robustness.');
if (options['refresh-gear'] && (!options.robustness || !options['source-archive']))
	throw new Error('--refresh-gear requires --robustness and --source-archive.');
if (options.robustness && !options['refresh-gear'] && !fs.existsSync(path.resolve(root, options['gear-catalog'] ?? 'docs/analytics/race-gear-catalog.json')))
	throw new Error('A validated gear catalogue is required before starting the study.');
if (git('branch', '--show-current') !== 'codex/analytics') throw new Error('Run analytics on codex/analytics.');
const localPython = path.join(
	root,
	'tmp/analytics-python',
	process.platform === 'win32' ? 'Scripts' : 'bin',
	process.platform === 'win32' ? 'python.exe' : 'python',
);
const python = options.python ?? process.env.PYTHON_BINARY ?? (fs.existsSync(localPython) ? localPython : 'python');
const out = path.resolve(
	root,
	options.out ?? 'tmp/analytics-runs/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + git('rev-parse', '--short', 'HEAD'),
);
if (fs.existsSync(out)) throw new Error('Output already exists: ' + out);
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(out, 'logs'));
const state = {
	startedAt: new Date().toISOString(),
	commit: git('rev-parse', 'HEAD'),
	trackedState: git('status', '--porcelain'),
	model: options.model ?? 'upstream',
	equipmentCoveragePolicy: options.robustness
		? options['allow-partial-published']
			? 'Available validated sets; published coverage gaps remain explicit.'
			: 'Complete published coverage required.'
		: 'Developer references only.',
	stages: [],
};
const save = () => fs.writeFileSync(path.join(out, 'workflow.json'), JSON.stringify(state, null, 2));
function stage(name, command, argv) {
	const item = { name, startedAt: new Date().toISOString(), state: 'running', command: [command, ...argv] };
	state.stages.push(item);
	save();
	console.log('Starting ' + name + '...');
	const fd = fs.openSync(path.join(out, 'logs', name + '.log'), 'w');
	const result = spawnSync(command, argv, { cwd: root, env: process.env, stdio: ['ignore', fd, fd] });
	fs.closeSync(fd);
	item.finishedAt = new Date().toISOString();
	item.exitCode = result.status;
	item.state = result.status === 0 ? 'passed' : 'failed';
	save();
	if (result.status !== 0) {
		state.state = 'failed';
		save();
		throw new Error(name + ' failed. Inspect ' + path.join(out, 'logs', name + '.log') + (result.error ? ' (' + result.error.message + ')' : ''));
	}
	console.log('Passed ' + name + '.');
}
const node = (name, argv) => stage(name, process.execPath, argv),
	py = (name, argv) => stage(name, python, argv);
py('python-environment', ['-c', 'import sys, numpy, matplotlib; print(sys.version); print("numpy", numpy.__version__, "matplotlib", matplotlib.__version__)']);
if (!options.prepared) node('prepare', ['tools/dps-experiments/prepare.mjs']);
const gearCatalog = path.resolve(root, options['gear-catalog'] ?? 'docs/analytics/race-gear-catalog.json');
if (options.robustness) {
	if (options['refresh-gear']) {
		if (!options['source-archive']) throw new Error('--refresh-gear requires --source-archive in the local source library.');
		node('gear-source-refresh', [
			'tools/dps-experiments/gear_catalog.mjs',
			'--archive',
			path.resolve(options['source-archive']),
			'--out',
			gearCatalog,
			'--compact',
		]);
	}
	if (!fs.existsSync(gearCatalog)) throw new Error('A validated gear catalogue is required. Refresh it with gear_catalog.mjs first.');
}
node('rerun-readiness', [
	'tools/dps-experiments/readiness.mjs',
	'--out',
	path.join(out, 'readiness'),
	...(options.robustness ? ['--gear-catalog', gearCatalog, ...(options['allow-partial-published'] ? [] : ['--require-full-published'])] : []),
]);
node('analytics-tests', [
	'--test',
	...fs
		.readdirSync(path.join(root, 'tools/dps-experiments'))
		.filter(x => x.endsWith('.test.mjs'))
		.map(x => 'tools/dps-experiments/' + x),
]);
py('report-tests', ['-m', 'unittest', 'discover', '-s', 'tools/dps-experiments', '-p', '*_test.py']);
const racials = path.join(out, 'racials'),
	baseline = path.join(out, 'developer-presets');
node('racials', [
	'tools/dps-experiments/racials.mjs',
	'--prepared',
	'--faction',
	'both',
	'--model',
	state.model,
	'--python',
	python,
	'--out',
	racials,
	...(options['reuse-racials'] ? ['--reuse', path.resolve(root, options['reuse-racials'])] : []),
]);
node('racial-exports', ['tools/dps-experiments/verify_details.mjs', racials, '--schema']);
node('developer-baseline', [
	'tools/dps-experiments/run.mjs',
	'--out',
	baseline,
	'--sim',
	path.join(racials, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim'),
	'--engine-provenance',
	path.join(racials, 'provenance.json'),
]);
py('developer-report', ['tools/dps-experiments/report.py', baseline]);
node('developer-verification', ['tools/dps-experiments/verify_run.mjs', baseline]);
node('developer-dom', ['tools/dps-experiments/verify_report.mjs', baseline]);
node('developer-exports', ['tools/dps-experiments/verify_details.mjs', baseline, '--schema']);
if (options.reference) {
	const frozen = path.join(out, 'frozen-inputs');
	node('frozen-inputs', [
		'tools/dps-experiments/run.mjs',
		'--frozen',
		path.resolve(root, options.reference),
		'--out',
		frozen,
		'--sim',
		path.join(racials, 'engine', process.platform === 'win32' ? 'wowsim.exe' : 'wowsim'),
		'--engine-provenance',
		path.join(racials, 'provenance.json'),
	]);
	py('frozen-report', ['tools/dps-experiments/report.py', frozen]);
	node('frozen-verification', ['tools/dps-experiments/verify_run.mjs', frozen]);
	py('update-comparison', ['tools/dps-experiments/compare_updates.py', out]);
	fs.renameSync(path.join(out, 'report.html'), path.join(out, 'update-report.html'));
	const comparisonProvenance = JSON.parse(fs.readFileSync(path.join(out, 'comparison-provenance.json'), 'utf8'));
	comparisonProvenance.artifacts['update-report.html'] = comparisonProvenance.artifacts['report.html'];
	delete comparisonProvenance.artifacts['report.html'];
	fs.writeFileSync(path.join(out, 'comparison-provenance.json'), JSON.stringify(comparisonProvenance, null, 2));
}
if (options['gunba-source']) {
	const matched = path.join(out, 'shadow-comparison');
	node('shadow-comparison', [
		'tools/dps-experiments/shadow_compare.mjs',
		'--primary-run',
		racials,
		'--gunba-source',
		path.resolve(root, options['gunba-source']),
		'--out',
		matched,
	]);
	py('shadow-report', ['tools/dps-experiments/shadow_report.py', matched]);
	node('shadow-verification', ['tools/dps-experiments/verify_shadow.mjs', matched]);
}
if (options.audit) {
	node('preset-assessment', [
		'tools/dps-experiments/assess.mjs',
		'--primary-run',
		racials,
		'--out',
		path.join(out, 'assessment'),
		'--python',
		python,
		...(options['gunba-source']
			? [
					'--gunba-source',
					path.resolve(root, options['gunba-source']),
					'--gunba-engine',
					path.join(out, 'shadow-comparison/engine', process.platform === 'win32' ? 'gunba.exe' : 'gunba'),
				]
			: []),
	]);
}
if (options.robustness) {
	const robust = path.join(out, 'race-robustness');
	node('race-robustness', [
		'tools/dps-experiments/robustness.mjs',
		'--source-racials',
		racials,
		'--gear-catalog',
		gearCatalog,
		'--out',
		robust,
		...(options['gunba-source'] ? ['--gunba-source', path.resolve(options['gunba-source'])] : []),
	]);
	node('race-gear-legality', ['tools/dps-experiments/gear_legality.mjs', robust]);
	node('race-exports', ['tools/dps-experiments/robust_exports.mjs', robust]);
	node('priest-racial-controls', ['tools/dps-experiments/class_racial_probe.mjs', robust, path.join(robust, 'class-racial-controls')]);
	node('hunter-pet-controls', ['tools/dps-experiments/hunter_pet_probe.mjs', robust, path.join(robust, 'hunter-pet-controls')]);
	py('race-robustness-verification', ['tools/dps-experiments/verify_robustness.py', robust]);
	py('race-robustness-report', ['tools/dps-experiments/robust_report.py', robust]);
	node('race-report-controls', ['tools/dps-experiments/verify_robust_report.mjs', robust]);
}
state.completedAt = new Date().toISOString();
state.state = 'passed';
save();
const links = [
	['racials/report.html', 'Horde and Alliance racial comparisons'],
	['developer-presets/report.html', 'Developer DPS builds by documented gear tier'],
];
if (options['gunba-source']) links.push(['shadow-comparison/report.html', 'Matched Shadow engine comparison']);
if (options.reference) links.push(['update-report.html', 'Frozen-input update impact']);
if (options.audit) links.push(['assessment/report.html', 'All-spec audit and expanded engine diagnostics']);
if (options.robustness) links.unshift(['race-robustness/report.html', 'Race recommendations across gear sets and conditions']);
fs.writeFileSync(
	path.join(out, 'report.html'),
	'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WoWSims analytics</title><style>body{background:#0b1220;color:#edf3fc;font:18px/1.7 system-ui;max-width:1000px;margin:50px auto;padding:25px}a{color:#80caff}code{overflow-wrap:anywhere}</style><h1>WoWSims Forever analytics</h1><p>' +
		(options.robustness
			? 'Developer equipment is a reference; race recommendations also test validated source-listed alternatives. '
			: 'Developer equipment preserved. ') +
		'Model <code>' +
		state.model +
		'</code>; analytics <code>' +
		state.commit +
		'</code>.</p><ul>' +
		links.map(([href, title]) => '<li><a href="' + href + '">' + title + '</a></li>').join('') +
		'</ul><p><a href="workflow.json">Workflow receipt and commands</a>. Full requests, results, engine binaries and per-stage logs remain in this archive.</p>',
);
console.log('Complete: ' + path.join(out, 'report.html'));
