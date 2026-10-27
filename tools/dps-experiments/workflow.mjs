import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log(
		'Usage: node tools/dps-experiments/workflow.mjs [--prepared] [--python executable] [--out directory] [--model upstream|notes-2026-10-27] [--reference saved-developer-run] [--reuse-racials saved-racial-run] [--gunba-source directory]\nRuns racial and tiered developer DPS reports with the same native engine. Optional Gunba comparison uses the pinned adapter. Source updates and Git commits are separate. Outputs are immutable.',
	);
	process.exit(0);
}
const flags = new Set(['--prepared']),
	values = new Set(['--python', '--out', '--model', '--reference', '--gunba-source', '--reuse-racials']);
const options = {};
for (let i = 0; i < args.length; i++) {
	if (flags.has(args[i])) options[args[i].slice(2)] = true;
	else if (values.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
	else throw new Error('Unknown or incomplete option: ' + args[i]);
}
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
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
state.completedAt = new Date().toISOString();
state.state = 'passed';
save();
const links = [
	['racials/report.html', 'Horde and Alliance racial comparisons'],
	['developer-presets/report.html', 'Developer DPS builds by documented gear tier'],
];
if (options['gunba-source']) links.push(['shadow-comparison/report.html', 'Matched Shadow engine comparison']);
if (options.reference) links.push(['update-report.html', 'Frozen-input update impact']);
fs.writeFileSync(
	path.join(out, 'report.html'),
	'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WoWSims analytics</title><style>body{background:#0b1220;color:#edf3fc;font:18px/1.7 system-ui;max-width:1000px;margin:50px auto;padding:25px}a{color:#80caff}code{overflow-wrap:anywhere}</style><h1>WoWSims Forever analytics</h1><p>Developer equipment preserved. Model <code>' +
		state.model +
		'</code>; analytics <code>' +
		state.commit +
		'</code>.</p><ul>' +
		links.map(([href, title]) => '<li><a href="' + href + '">' + title + '</a></li>').join('') +
		'</ul><p><a href="workflow.json">Workflow receipt and commands</a>. Full requests, results, engine binaries and per-stage logs remain in this archive.</p>',
);
console.log('Complete: ' + path.join(out, 'report.html'));
