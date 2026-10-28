import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hash } from './racial_helpers.mjs';
import { verifySite } from './publish_site.mjs';

const args = process.argv.slice(2),
	option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
if (args.includes('--help')) {
	console.log(
		'node tools/dps-experiments/deploy_site.mjs --bundle prepared-publication --repo owner/repository --tag release-tag [--branch codex/report-site]',
	);
	process.exit(0);
}
const bundle = path.resolve(option('--bundle', '')),
	repo = option('--repo'),
	tag = option('--tag'),
	branch = option('--branch', 'codex/report-site');
assert(option('--bundle') && /^[\w.-]+\/[\w.-]+$/.test(repo ?? '') && /^[\w.-]+$/.test(tag ?? '') && /^codex\/[\w/-]+$/.test(branch));
const run = (cmd, argv, cwd = process.cwd()) =>
	execFileSync(cmd, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
const site = path.join(bundle, 'site');
verifySite(site);
const archives = JSON.parse(fs.readFileSync(path.join(bundle, 'raw-archives.json'), 'utf8'));
const remote = JSON.parse(run('gh', ['api', 'repos/' + repo]));
assert(remote.permissions?.admin, 'Pages configuration requires repository admin access.');
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Commit the reviewed analytics source before publishing.');
const head = run('git', ['rev-parse', 'HEAD']);
for (const a of archives) {
	assert.equal(hash(fs.readFileSync(a.output)), a.sha256, 'Raw ZIP differs from its receipt.');
	assert(a.url.endsWith('/' + path.basename(a.output)) && a.url.includes('/releases/download/' + tag + '/'), 'Release asset URL differs from deployment.');
}
let release;
try {
	release = JSON.parse(run('gh', ['api', 'repos/' + repo + '/releases/tags/' + tag]));
} catch (error) {
	assert(/not found|404/i.test(String(error.stderr)), 'Cannot inspect existing release.');
	const notes = path.join(bundle, 'release-notes.txt');
	fs.writeFileSync(
		notes,
		'Original native simulation results and debug JSON. The Pages report contains exact inputs, readable summaries and original/public checksums. Analytics source: ' +
			head +
			'. Each ZIP includes raw-sha256.json.',
	);
	run('gh', ['release', 'create', tag, '-R', repo, '--target', head, '--title', 'WoWSims analytics: ' + tag, '--notes-file', notes]);
	release = { assets: [] };
}
for (const a of archives) {
	const existing = release.assets.find(x => x.name === path.basename(a.output));
	if (existing) assert.equal(existing.digest, 'sha256:' + a.sha256, 'Existing release asset has another digest; choose a new snapshot tag.');
	else run('gh', ['release', 'upload', tag, a.output, '-R', repo]);
	console.log('Verified/uploaded ' + path.basename(a.output));
}
const deployment = path.join(bundle, 'deployment');
if (!fs.existsSync(deployment)) {
	fs.mkdirSync(deployment);
	run('git', ['init', '--initial-branch', branch], deployment);
	run('git', ['config', 'user.name', run('git', ['config', 'user.name'])], deployment);
	run('git', ['config', 'user.email', run('git', ['config', 'user.email'])], deployment);
	run('git', ['remote', 'add', 'origin', 'https://github.com/' + repo + '.git'], deployment);
	if (run('git', ['ls-remote', '--heads', 'origin', branch], deployment)) {
		run('git', ['fetch', '--depth=1', 'origin', branch], deployment);
		run('git', ['-c', 'core.longpaths=true', 'checkout', '-B', branch, 'FETCH_HEAD'], deployment);
	}
}
assert.equal(run('git', ['remote', 'get-url', 'origin'], deployment), 'https://github.com/' + repo + '.git');
assert.equal(run('git', ['branch', '--show-current'], deployment), branch);
// Report filenames can exceed Win32's normal path length inside a nested artifact directory.
run('git', ['config', 'core.longpaths', 'true'], deployment);
run('git', ['config', 'core.autocrlf', 'false'], deployment);
fs.cpSync(site, deployment, { recursive: true });
run('git', ['add', '.'], deployment);
run('git', ['add', '--renormalize', '.'], deployment);
const staged = new Map(
	run('git', ['ls-files', '--stage', '-z'], deployment)
		.split('\0')
		.filter(Boolean)
		.map(line => {
			const [metadata, file] = line.split('\t');
			return [file, metadata.split(' ')[1]];
		}),
);
const siteBytes = [...staged.keys()].reduce((sum, file) => sum + fs.statSync(path.join(deployment, file)).size, 0);
assert(siteBytes < 1_000_000_000, 'The combined site exceeds its 1 GB publication budget. Reduce artifacts or archive an older snapshot before publishing.');
const manifest = JSON.parse(fs.readFileSync(path.join(site, 'publication-manifest.json'), 'utf8'));
for (const file of [...Object.keys(manifest.files), 'publication-manifest.json']) {
	const bytes = fs.readFileSync(path.join(site, file)),
		expected = staged.get(file);
	assert(expected, 'Published artifact is missing from the Git index: ' + file);
	const stored = createHash(expected.length === 64 ? 'sha256' : 'sha1')
		.update('blob ' + bytes.length + '\0')
		.update(bytes)
		.digest('hex');
	assert.equal(stored, expected, 'Git altered published artifact bytes: ' + file);
}
if (run('git', ['status', '--porcelain'], deployment)) run('git', ['commit', '-m', '[Analytics] Publish ' + tag], deployment);
run('git', ['push', 'origin', branch], deployment);
const config = path.join(bundle, 'pages-config.json');
fs.writeFileSync(config, JSON.stringify({ build_type: 'legacy', source: { branch, path: '/' } }));
let existingPages = false;
try {
	run('gh', ['api', 'repos/' + repo + '/pages']);
	existingPages = true;
} catch (error) {
	assert(/404/.test(String(error.stderr)), 'Cannot inspect Pages configuration.');
}
const pages = JSON.parse(run('gh', ['api', '--method', existingPages ? 'PUT' : 'POST', 'repos/' + repo + '/pages', '--input', config]) || '{}');
const receipt = {
	sourceCommit: head,
	siteCommit: run('git', ['rev-parse', 'HEAD'], deployment),
	repo,
	branch,
	tag,
	deployedAt: new Date().toISOString(),
	url: pages.html_url ?? 'https://' + repo.split('/')[0] + '.github.io/' + repo.split('/')[1] + '/',
	status: 'pushed; Pages build must be verified',
};
fs.writeFileSync(path.join(bundle, 'deployment-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
