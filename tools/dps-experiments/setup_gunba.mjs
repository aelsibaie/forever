import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pin = '92120c303d5ef4c4d4840df19818a65f8acb40b3';
const source = path.join(root, 'tmp/engine-comparisons/gunba');
const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
if (!fs.existsSync(source)) {
	fs.mkdirSync(path.dirname(source), { recursive: true });
	run('git', ['clone', '--depth', '1', '--branch', 'forever', 'https://github.com/gunba/wow-forever-sim.git', source]);
	if (run('git', ['rev-parse', 'HEAD'], source).trim() !== pin) {
		run('git', ['fetch', '--depth', '1', 'origin', pin], source);
		run('git', ['checkout', '--detach', pin], source);
	}
}
if (run('git', ['rev-parse', 'HEAD'], source).trim() !== pin || run('git', ['status', '--porcelain', '--untracked-files=no'], source).trim())
	throw new Error('The existing comparison checkout differs from the reviewed pin. Preserve it before preparing a new checkout.');
const bin = path.join(root, 'tmp/analytics-bin');
fs.mkdirSync(bin, { recursive: true });
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
run(go, ['build', '-o', path.join(bin, process.platform === 'win32' ? 'protoc-gen-go.exe' : 'protoc-gen-go'), 'google.golang.org/protobuf/cmd/protoc-gen-go']);
fs.mkdirSync(path.join(source, 'sim/core/proto'), { recursive: true });
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
run(
	process.execPath,
	[
		path.join(root, 'node_modules/@protobuf-ts/protoc/protoc.js'),
		'--proto_path=proto',
		'--go_out=sim/core',
		...fs
			.readdirSync(path.join(source, 'proto'))
			.filter(x => x.endsWith('.proto'))
			.map(x => 'proto/' + x),
	],
	source,
	env,
);
console.log('Prepared pinned comparison source: ' + source + ' @ ' + pin);
