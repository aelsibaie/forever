import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2),
	option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
if (args.includes('--help')) {
	console.log(
		'node tools/dps-experiments/assess.mjs --primary-run racials --out new-directory [--gunba-source checkout --gunba-engine compiled-driver] [--python executable]',
	);
	process.exit(0);
}
const primary = path.resolve(option('--primary-run', '')),
	out = path.resolve(option('--out', 'tmp/assessments/' + Date.now()));
assert(option('--primary-run') && fs.existsSync(path.join(primary, 'completion.json')), 'A completed racial archive is required.');
assert(!fs.existsSync(out), 'Choose a new assessment directory.');
fs.mkdirSync(out, { recursive: true });
const python = option(
	'--python',
	process.env.PYTHON_BINARY ?? path.resolve('tmp/analytics-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
);
const stages = [],
	save = () => fs.writeFileSync(path.join(out, 'assessment.json'), JSON.stringify({ primary, stages }, null, 2));
function stage(name, command, argv) {
	const item = { name, command: [command, ...argv], startedAt: new Date().toISOString() };
	stages.push(item);
	save();
	const fd = fs.openSync(path.join(out, name + '.log'), 'w');
	const result = spawnSync(command, argv, { stdio: ['ignore', fd, fd] });
	fs.closeSync(fd);
	Object.assign(item, { finishedAt: new Date().toISOString(), exitCode: result.status });
	save();
	assert.equal(result.status, 0, name + ' failed; inspect its log.');
	console.log('Completed ' + name);
}
const audit = path.join(out, 'spec-audit'),
	comparison = path.join(out, 'engine-compatibility'),
	probes = path.join(out, 'common-spell-probes');
stage('native-audit', process.execPath, ['tools/dps-experiments/audit_matrix.mjs', '--run', primary, '--out', audit, '--variants']);
if (option('--gunba-source')) {
	assert(option('--gunba-engine'), 'Supply the driver from the completed pinned Shadow comparison.');
	const shared = [
		'--primary-run',
		primary,
		'--gunba-source',
		path.resolve(option('--gunba-source')),
		'--gunba-engine',
		path.resolve(option('--gunba-engine')),
	];
	stage('engine-compatibility', process.execPath, ['tools/dps-experiments/wide_compare.mjs', ...shared, '--out', comparison]);
	stage('common-spell-probes', process.execPath, ['tools/dps-experiments/wide_compare.mjs', ...shared, '--out', probes, '--common-spell-probes']);
}
stage('reports', python, [
	'tools/dps-experiments/assessment_report.py',
	audit,
	'--primary-run',
	primary,
	...(option('--gunba-source') ? ['--comparison', comparison, '--probes', probes] : []),
]);
fs.writeFileSync(
	path.join(out, 'report.html'),
	'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preset assessment</title><style>body{background:#0b1220;color:#edf3fc;font:18px/1.7 system-ui;padding:40px;max-width:1000px;margin:auto}a{color:#81caff}</style><h1>Preset assessment</h1><p><a href="spec-audit/report.html">All-spec and race audit, gear and mana-action sensitivities</a></p>' +
		(option('--gunba-source')
			? '<p><a href="engine-compatibility/report.html">Developer-rotation compatibility</a></p><p><a href="common-spell-probes/report.html">Shared-spell diagnostics: separate from build rankings</a></p>'
			: '') +
		'<p><a href="assessment.json">Commands and stage receipt</a></p></html>',
);
console.log('Assessment complete: ' + path.join(out, 'report.html'));
