import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer } from 'vite';

export async function loadProfiles(root, config = JSON.parse(fs.readFileSync(path.join(root, 'tools/dps-experiments/baseline.json'), 'utf8'))) {
	const nodeGlobals = Object.fromEntries(
		['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'fetch', 'Response'].map(key => [
			key,
			globalThis[key],
		]),
	);
	GlobalRegistrator.register({ url: 'http://localhost/forever/' });
	Object.assign(globalThis, nodeGlobals);
	globalThis.fetch = async resource => {
		const url = new URL(String(resource), 'http://localhost');
		if (url.origin !== 'http://localhost' || !url.pathname.startsWith('/forever/assets/')) throw new Error(`Unexpected profile data request: ${url}`);
		const file = path.resolve(root, 'assets', url.pathname.slice('/forever/assets/'.length));
		if (!file.startsWith(path.resolve(root, 'assets') + path.sep)) throw new Error('Asset path is outside the repository.');
		return new Response(fs.readFileSync(file));
	};
	const typescriptConfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
	const alias = Object.fromEntries(
		Object.entries(typescriptConfig.compilerOptions.paths).map(([key, [target]]) => [key.replace('/*', ''), path.resolve(root, target.replace('/*', ''))]),
	);
	const server = await createServer({
		root,
		configFile: false,
		customLogger: {
			info() {},
			warn() {},
			warnOnce() {},
			error: message => console.error(message),
			clearScreen() {},
			hasErrorLogged: () => false,
			hasWarned: false,
		},
		resolve: { alias },
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [
			{
				name: 'experiment-locales',
				resolveId: id => (id === 'virtual:i18next-loader' ? '\0experiment-locales' : undefined),
				load: id =>
					id === '\0experiment-locales'
						? `export default ${JSON.stringify({ en: Object.fromEntries(['translation', 'talents', 'character'].map(name => [name, JSON.parse(fs.readFileSync(path.join(root, `assets/locales/en/${name}.json`), 'utf8'))])) })}`
						: undefined,
			},
		],
		server: { middlewareMode: true, watch: null, ws: false },
		oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
	});
	try {
		const module = await server.ssrLoadModule('/tools/dps-experiments/export_profiles.mts');
		if (config.frozenRun) {
			const catalog = JSON.parse(fs.readFileSync(path.resolve(root, config.frozenRun, 'profiles.json'), 'utf8'));
			return { ...catalog, validateRequest: module.validateRequest };
		}
		if (config.referenceRun) {
			const gear = await server.ssrLoadModule('/tools/dps-experiments/pre_raid_profiles.mts');
			return { ...(await gear.standardizeProfiles(root, config)), validateRequest: module.validateRequest };
		}
		return { ...(await module.exportProfiles(root, config.fallbackGear ?? {})), validateRequest: module.validateRequest };
	} finally {
		await server.close();
		await GlobalRegistrator.unregister();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
	const data = await loadProfiles(root);
	const output = path.resolve(process.argv[2] ?? 'tmp/dps-profiles.json');
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, JSON.stringify(data, null, 2));
	console.log(`Exported ${data.profiles.length} profiles to ${output}`);
}
