import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeResult, csv, resolvedRequestKey } from './statistics.mjs';

const result = () => ({
	iterationsDone: 3,
	avgIterationDuration: 10,
	encounterMetrics: { targets: [{ unitIndex: 0 }] },
	raidMetrics: {
		parties: [
			{
				players: [
					{
						dps: { avg: 20, allValues: [10, 20, 30] },
						secondsOomAvg: 0,
						actions: [
							{
								id: { spellId: 1 },
								targets: [
									{ unitIndex: 0, damage: 450, casts: 6 },
									{ unitIndex: 1, damage: 300, casts: 3 },
								],
							},
						],
						pets: [{ name: 'Pet', dps: { avg: 5 }, actions: [] }],
					},
				],
			},
		],
	},
});

test('aggregates iteration samples and keeps pet damage inside owner DPS', () => {
	const summary = summarizeResult(result(), 3);
	assert.equal(summary.meanDps, 20);
	assert.equal(summary.stdev, 10);
	assert.equal(summary.damageActions[0].dps + summary.petDps, summary.meanDps);
	assert.equal(summary.damageActions[0].casts, 2);
});

test('rejects failed, incomplete, and inconsistent results', () => {
	assert.throws(() => summarizeResult({ error: { message: 'Stopped' } }, 3), /Stopped/);
	assert.throws(() => summarizeResult(result(), 4), /incomplete/);
	const inconsistent = result();
	inconsistent.raidMetrics.parties[0].players[0].dps.avg = 50;
	assert.throws(() => summarizeResult(inconsistent, 3), /disagree/);
});

test('escapes quoted labels in CSV output', () => {
	assert.match(csv([{ buildName: 'A "quoted", build' }]), /"A ""quoted"", build"/);
});

test('deduplicates resolved rotations without discarding changed priorities', () => {
	const a = { raid: { parties: [{ players: [{ name: 'A', rotation: { simple: { cooldowns: {} }, priorityList: [{ cast: 'A' }] } }] }] } };
	const b = structuredClone(a);
	b.raid.parties[0].players[0].name = 'B';
	delete b.raid.parties[0].players[0].rotation.simple;
	assert.equal(resolvedRequestKey(a), resolvedRequestKey(b));
	b.raid.parties[0].players[0].rotation.priorityList[0].cast = 'B';
	assert.notEqual(resolvedRequestKey(a), resolvedRequestKey(b));
});
