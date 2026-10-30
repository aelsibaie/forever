import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const go = process.env.GO_BINARY ?? (process.platform === 'win32' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const env = { ...process.env, PATH: path.join(root, 'node_modules/.bin') + path.delimiter + process.env.PATH };
const run = (command, args) => {
	const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
};
const wrapper = path.join(root, 'node_modules/@protobuf-ts/protoc/protoc.js');
const includes = ['--proto_path=proto'];
try {
	const located = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['protoc'], { env, encoding: 'utf8' })
		.trim()
		.split(/\r?\n/)[0];
	const include = path.resolve(path.dirname(located), '../include');
	if (fs.existsSync(path.join(include, 'google/protobuf/descriptor.proto'))) includes.push(`--proto_path=${include}`);
} catch {
	// The npm wrapper installs protoc when none is available on PATH.
}
fs.mkdirSync(path.join(root, 'sim/core/proto'), { recursive: true });
fs.mkdirSync(path.join(root, 'ui/generated/proto'), { recursive: true });
run(process.execPath, [
	wrapper,
	...includes,
	'--go_opt=Mgoogle/protobuf/descriptor.proto=google.golang.org/protobuf/types/descriptorpb',
	'--go_out=sim/core',
	...fs
		.readdirSync(path.join(root, 'proto'))
		.filter(file => file.endsWith('.proto'))
		.map(file => `proto/${file}`),
]);
run(process.execPath, [wrapper, ...includes, '--ts_opt=generate_dependencies', '--ts_out=ui/generated/proto', 'proto/api.proto']);
for (const name of ['test', 'ui']) run(process.execPath, [wrapper, ...includes, '--ts_out=ui/generated/proto', `proto/${name}.proto`]);
fs.mkdirSync(path.join(root, 'binary_dist/forever'), { recursive: true });
fs.copyFileSync(path.join(root, 'sim/web/dist.go.tmpl'), path.join(root, 'binary_dist/dist.go'));
fs.writeFileSync(path.join(root, 'binary_dist/forever/embedded'), '');
run(go, ['run', './tools/database/gen_db', '-gen=go-to-ts']);

fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
run(go, ['build', '-tags=with_db', '-o', path.join(root, 'bin', process.platform === 'win32' ? 'wowsimcli.exe' : 'wowsimcli'), './cmd/wowsimcli']);
