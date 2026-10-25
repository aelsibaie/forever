import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3] ?? 'reports/dps/latest');
if (fs.existsSync(destination)) throw new Error(`Publication directory already exists: ${destination}`);
fs.mkdirSync(destination, { recursive: true });
const copy = (from, to, names) => {
	fs.mkdirSync(to, { recursive: true });
	for (const name of names) if (fs.existsSync(path.join(from, name))) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
};
copy(source, destination, [
	'report.html',
	'update-comparison.csv',
	'update-comparison.json',
	'update-impact.png',
	'update-impact.svg',
	'comparison-provenance.json',
]);
for (const name of ['developer-presets', 'frozen-inputs']) {
	const dir = path.join(source, name);
	if (!fs.existsSync(dir)) continue;
	copy(dir, path.join(destination, name), [
		'report.html',
		'charts',
		'summary.json',
		'summary.csv',
		'profiles.json',
		'preset-audit.json',
		'provenance.json',
		'report-provenance.json',
		'verification.json',
		'requests',
		'unavailable-profiles.json',
	]);
}
fs.writeFileSync(
	path.join(destination, 'raw-data-location.json'),
	JSON.stringify(
		{
			directory: source,
			note: 'Raw results, debug logs and binaries are local. Published reports include inputs, charts and summary data. Raw-result links require the local run archive.',
		},
		null,
		2,
	),
);
console.log(`Published compact reports to ${destination}`);
