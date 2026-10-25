import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
if (args.includes('--help')) {
	console.log(
		'Usage: node tools/dps-experiments/refresh.mjs [--update] [--prepared] [--reference saved-run] [--out directory] [--python executable]\nRequires installed npm/Go/Python dependencies and protoc-gen-go on PATH. --update merges origin/master into the clean analytics branch. --prepared skips source generation. Existing outputs are never overwritten.',
	);
	process.exit(0);
}
for (let i = 0; i < args.length; i++) {
	if (['--update', '--prepared'].includes(args[i])) continue;
	if (!['--reference', '--out', '--python'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
		throw new Error(`Unknown or incomplete option: ${args[i]}`);
	i++;
}
const run = (command, argv) => {
	const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', env: process.env });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
};
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
if (args.includes('--update')) {
	if (git('branch', '--show-current') !== 'codex/analytics') throw new Error('--update requires codex/analytics.');
	if (git('status', '--porcelain')) throw new Error('Commit or preserve working-tree changes before updating.');
	run('git', ['fetch', 'origin']);
	run('git', ['merge', '--no-edit', 'origin/master']);
}
const out = path.resolve(
	root,
	value('--out', `tmp/dps-experiments/${new Date().toISOString().replace(/[:.]/g, '-')}-${git('rev-parse', '--short', 'origin/master')}`),
);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`Output directory is not empty: ${out}`);
const python = value('--python', process.env.PYTHON_BINARY ?? 'python');
if (!args.includes('--prepared')) run(process.execPath, ['tools/dps-experiments/prepare.mjs']);
run(process.execPath, ['--test', 'tools/dps-experiments/statistics.test.mjs', 'tools/dps-experiments/preset_audit.test.mjs']);
run(process.execPath, ['tools/dps-experiments/run.mjs', '--out', path.join(out, 'developer-presets')]);
run(python, ['tools/dps-experiments/report.py', path.join(out, 'developer-presets')]);
run(process.execPath, ['tools/dps-experiments/verify_report.mjs', path.join(out, 'developer-presets')]);
run(process.execPath, ['tools/dps-experiments/verify_run.mjs', path.join(out, 'developer-presets')]);
if (args.includes('--reference')) {
	run(process.execPath, [
		'tools/dps-experiments/run.mjs',
		'--frozen',
		path.resolve(root, value('--reference')),
		'--out',
		path.join(out, 'frozen-inputs'),
		'--sim',
		path.join(out, 'developer-presets/engine', process.platform === 'win32' ? 'wowsimcli.exe' : 'wowsimcli'),
	]);
	run(python, ['tools/dps-experiments/report.py', path.join(out, 'frozen-inputs')]);
	run(process.execPath, ['tools/dps-experiments/verify_report.mjs', path.join(out, 'frozen-inputs')]);
	run(process.execPath, ['tools/dps-experiments/verify_run.mjs', path.join(out, 'frozen-inputs')]);
	run(python, ['tools/dps-experiments/compare_updates.py', out]);
}
console.log(`Completed analytics refresh: ${out}`);
