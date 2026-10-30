import { offensiveRacial, signature } from './racial_helpers.mjs';

export function rotationInputPath(file) {
	return (
		/^ui\/specs\/.+\/(?:apls\/[^/]+\.apl\.json|builds\/[^/]+\.build\.json)$/.test(file) ||
		/^sim\/.+\.results$/.test(file) ||
		/^\.github\/skills\/.+\.(?:md|sh)$/.test(file) ||
		file === 'skills-lock.json'
	);
}

export function walkObjects(value, callback) {
	if (!value || typeof value !== 'object') return;
	callback(value);
	for (const child of Object.values(value)) walkObjects(child, callback);
}

export function resolveUnavailableReferences(rotation, stats) {
	const result = structuredClone(rotation),
		changes = [];
	const sheet = stats.raidStats.parties[0].players[0];
	const id = action =>
		action?.spellId
			? `s${action.spellId}:${action.tag ?? 0}`
			: action?.itemId
				? `i${action.itemId}:${action.tag ?? 0}`
				: `o${action?.otherId}:${action?.tag ?? 0}`;
	const spells = new Set(sheet.metadata.spells.map(s => id(s.id)));
	const auras = new Set(sheet.metadata.auras.map(a => id(a.id)));
	const targetAuras = new Set(stats.encounterStats.targets[0].metadata.auras.map(a => id(a.id)));
	const vars = new Map((result.valueVariables ?? []).map(v => [v.name, v.value])),
		cache = new Map();
	const constant = value => ({ const: { val: String(value) } });
	const truth = value => (value?.const?.val === 'true' ? true : value?.const?.val === 'false' ? false : null);
	function resolve(value, trail = []) {
		if (!value || typeof value !== 'object') return value;
		if (value.variableRef) {
			const name = value.variableRef.name;
			if (!vars.has(name) || trail.includes(name)) return { missingNumeric: true };
			if (!cache.has(name)) cache.set(name, resolve(vars.get(name), [...trail, name]));
			return cache.get(name);
		}
		for (const [kind, record] of Object.entries(value)) {
			if (kind.startsWith('aura') && record?.auraId) {
				const known = (['Target', 'CurrentTarget'].includes(record.sourceUnit?.type) ? targetAuras : auras).has(id(record.auraId));
				if (kind === 'auraIsKnown') return constant(known);
				if (!known) {
					changes.push({ kind, id: record.auraId, sourceUnit: record.sourceUnit });
					if (kind === 'auraIsActive' || kind === 'auraShouldRefresh') return constant(false);
					if (kind === 'auraIsInactive') return constant(true);
					if (kind === 'auraNumStacks' || kind === 'auraRemainingTime') return constant(0);
					return { missingNumeric: true };
				}
			}
			if (kind.startsWith('spell') && kind !== 'spellId' && record?.spellId && typeof record.spellId === 'object') {
				const known = spells.has(id(record.spellId)) || (record.spellId.spellId && [...spells].some(s => s.startsWith(`s${record.spellId.spellId}:`)));
				if (kind === 'spellIsKnown') return constant(known);
				if (!known) {
					changes.push({ kind, id: record.spellId });
					if (['spellIsReady', 'spellIsCasting', 'spellCanCast', 'spellIsChanneling'].includes(kind)) return constant(false);
					return { missingNumeric: true };
				}
			}
		}
		if (value.and || value.or) {
			const and = !!value.and,
				parts = (value.and ?? value.or).vals.map(v => resolve(v, trail));
			if (parts.some(v => truth(v) === !and)) return constant(!and);
			const remaining = parts.filter(v => truth(v) !== and);
			if (!remaining.length) return constant(and);
			if (and && remaining.some(v => v.missingNumeric)) return { missingNumeric: true };
			const usable = remaining.filter(v => !v.missingNumeric);
			if (!usable.length) return { missingNumeric: true };
			return usable.length === 1 ? usable[0] : { [and ? 'and' : 'or']: { vals: usable } };
		}
		if (value.not) {
			const part = resolve(value.not.val, trail);
			return truth(part) === null ? (part.missingNumeric ? part : { not: { val: part } }) : constant(!truth(part));
		}
		const copy = Array.isArray(value)
			? value.map(v => resolve(v, trail))
			: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, trail)]));
		let missing = false;
		walkObjects(copy, node => {
			if (node.missingNumeric) missing = true;
		});
		return missing ? { missingNumeric: true } : copy;
	}
	// An absent aura is inactive with zero stacks; it does not erase its Boolean branch.
	walkObjects(result, node => {
		if (node.condition) {
			const resolved = resolve(node.condition);
			node.condition = resolved.missingNumeric ? constant(false) : resolved;
		}
		if (node.castSpell?.spellId) {
			const action = node.castSpell.spellId;
			if (!spells.has(id(action)) && !(action.spellId && [...spells].some(s => s.startsWith(`s${action.spellId}:`)))) node.condition = constant(false);
		}
	});
	for (const v of result.valueVariables ?? []) {
		const resolved = resolve(v.value);
		v.value = resolved.missingNumeric ? constant(0) : resolved;
	}
	return { rotation: result, changes: [...new Map(changes.map(c => [JSON.stringify(c), c])).values()] };
}

export function prepareRobustPlayer(original, { race, className, gear, timing = 'developer', mana = 'developer', classRacial = 'developer' }) {
	const player = structuredClone(original),
		changes = [];
	player.race = race;
	player.equipment = structuredClone(gear.equipment);
	if (gear.nativeHunterOptions) {
		if (className !== 'Hunter' || !player.hunter?.options?.classOptions) throw new Error('Source ammunition needs the native Hunter options.');
		if (Object.keys(gear.nativeHunterOptions).some(key => !['ammo', 'quiverBonus'].includes(key)))
			throw new Error('A gear source cannot change other Hunter options.');
		Object.assign(player.hunter.options.classOptions, gear.nativeHunterOptions);
		changes.push('Published ammunition and quiver IDs resolved through the native Hunter option enums.');
	}
	const required = new Set(gear.requiredProfessions ?? []);
	for (const profession of [player.profession1, player.profession2]) if (profession && profession !== 'ProfessionUnknown') required.add(profession);
	if (required.size > 2) throw new Error('The gear and baseline consumables require more than two professions.');
	[player.profession1, player.profession2] = [...required, 'ProfessionUnknown', 'ProfessionUnknown'];
	if (signature(player.equipment) !== signature(original.equipment))
		changes.push('Equipment replaced by the named complete set; developer swap sets and consumables retained.');
	walkObjects(player.rotation, node => {
		if ([1259705, 1259686].includes(node.spellId) && node.tag === 1) {
			delete node.tag;
			changes.push('Attuned/Charged cast changed to the plain racial: the enhanced buff is removed on raid entry.');
		}
	});
	const racial = offensiveRacial(race, className);
	if (racial) {
		if (timing === 'delay15')
			walkObjects(player.rotation, node => {
				if (node.castSpell?.spellId?.spellId === racial)
					node.condition = {
						and: {
							vals: [
								...(node.condition ? [node.condition] : []),
								{ cmp: { op: 'OpGe', lhs: { currentTime: {} }, rhs: { const: { val: '15s' } } } },
							],
						},
					};
			});
		const condition = {
			and: {
				vals: [
					{ spellIsKnown: { spellId: { spellId: racial } } },
					...(timing === 'delay15' ? [{ cmp: { op: 'OpGe', lhs: { currentTime: {} }, rhs: { const: { val: '15s' } } } }] : []),
				],
			},
		};
		// A named cooldown stays out of automatic cooldown selection, even when its line is pruned.
		if (timing !== 'developer') {
			player.rotation.priorityList.unshift({ action: { condition, castSpell: { spellId: { spellId: racial } } } });
			changes.push('Offensive racial tested with the ' + timing + ' timing policy.');
		} else {
			let explicit = false,
				automatic = false;
			walkObjects(player.rotation, node => {
				if (node.castSpell?.spellId?.spellId === racial && !node.hide) explicit = true;
				if (node.autocastOtherCooldowns) automatic = true;
			});
			if (!explicit && !automatic) {
				player.rotation.priorityList.unshift({ action: { condition, castSpell: { spellId: { spellId: racial } } } });
				changes.push('Missing offensive racial added behind Spell Is Known.');
			}
		}
	}
	if (mana === 'leyline65-guarded' && race === 'RaceHighOrderSkyborne' && !['Rogue', 'Warrior'].includes(className)) {
		const threshold = { cmp: { op: 'OpLe', lhs: { currentManaPercent: {} }, rhs: { const: { val: '65%' } } } };
		walkObjects(player.rotation, node => {
			if (node.castSpell?.spellId?.spellId === 1259705)
				node.condition = { and: { vals: [...(node.condition ? [node.condition] : []), structuredClone(threshold)] } };
		});
		player.rotation.priorityList.unshift({
			action: {
				condition: {
					and: {
						vals: [
							{ spellIsKnown: { spellId: { spellId: 1259705 } } },
							{ cmp: { op: 'OpLe', lhs: { currentManaPercent: {} }, rhs: { const: { val: '65%' } } } },
						],
					},
				},
				castSpell: { spellId: { spellId: 1259705 } },
			},
		});
		changes.push('Plain Read Leyline tested below 65% mana.');
	}
	if (classRacial === 'damage-dpet') {
		if (className !== 'Priest' || !['RaceNightElf', 'RaceDwarf'].includes(race)) throw new Error('No damage class racial policy for this race and class.');
		const spellId = race === 'RaceNightElf' ? 19305 : 1277335;
		const filler = player.rotation.priorityList.findIndex(line =>
			[10934, 18807].includes((line.action?.castSpell ?? line.action?.channelSpell)?.spellId?.spellId),
		);
		if (filler < 0) throw new Error('The Priest class racial policy needs a native filler action.');
		const fillerId = (player.rotation.priorityList[filler].action.castSpell ?? player.rotation.priorityList[filler].action.channelSpell).spellId.spellId;
		player.rotation.priorityList.splice(filler, 0, {
			action: {
				condition: {
					and: {
						vals: [
							{ spellIsKnown: { spellId: { spellId } } },
							{
								cmp: {
									op: 'OpGt',
									lhs: { spellExpectedDpet: { spellId: { spellId } } },
									rhs: { spellExpectedDpet: { spellId: { spellId: fillerId } } },
								},
							},
						],
					},
				},
				castSpell: { spellId: { spellId } },
			},
		});
		changes.push('Priest damage racial tested before the filler when native expected damage per execution time is higher.');
	}
	return { player, changes: [...new Set(changes)] };
}

export function makeRobustRequest(
	profile,
	race,
	gear,
	config,
	{
		duration,
		support = 'full',
		target = 'neutral',
		hitOffset = 0,
		iterations,
		seed,
		timing = 'developer',
		mana = 'developer',
		classRacial = 'developer',
		statEnums,
	},
) {
	const { player, changes } = prepareRobustPlayer(profile.player, { race, className: profile.className, gear, timing, mana, classRacial });
	player.name = profile.id;
	player.buffs = support === 'full' ? structuredClone(config.individualBuffs) : {};
	if (hitOffset) {
		player.bonusStats ??= {};
		player.bonusStats.stats ??= [];
		while (player.bonusStats.stats.length <= Math.max(...Object.values(statEnums))) player.bonusStats.stats.push(0);
		player.bonusStats.stats[statEnums.HitRating] += hitOffset * 10;
		changes.push(`${hitOffset} percentage points of hit via an explicit HitRating control; no other stat changes.`);
	}
	const stats = Array(28).fill(0);
	stats[27] = config.target.armor;
	return {
		changes,
		request: {
			type: 'SimTypeIndividual',
			raid: {
				parties: [{ players: [player], buffs: support === 'full' ? structuredClone(config.partyBuffs) : {} }],
				buffs: support === 'full' ? structuredClone(config.raidBuffs) : {},
				debuffs: support === 'full' ? structuredClone(config.debuffs) : {},
				tanks: [],
			},
			encounter: {
				duration,
				durationVariation: 0,
				executeProportion20: config.executeProportion20,
				executeProportion35: config.executeProportion35,
				targets: [
					{
						name: target + ' target',
						level: config.target.level,
						mobType: target === 'beast' ? 'MobTypeBeast' : target === 'elemental' ? 'MobTypeElemental' : config.target.mobType,
						stats,
						tankIndex: -1,
					},
				],
			},
			simOptions: { iterations, randomSeed: String(seed), saveAllValues: true, useLabeledRands: true },
		},
	};
}

export function sampleComparison(left, right, z = 1.959963984540054) {
	if (left.length !== right.length || left.length < 2) throw new Error('Paired comparison needs matching nonempty samples.');
	const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
	const lm = mean(left),
		rm = mean(right);
	if (!(rm > 0)) throw new Error('The reference damage must be positive.');
	const ratio = lm / rm,
		residual = left.map((v, i) => v - ratio * right[i]),
		center = mean(residual);
	const variance = residual.reduce((sum, v) => sum + (v - center) ** 2, 0) / (left.length - 1);
	return { percent: 100 * (ratio - 1), halfWidthPercent: (100 * z * Math.sqrt(variance / left.length)) / rm, differenceDps: lm - rm };
}

export function normalQuantile(p) {
	if (!(p > 0 && p < 1)) throw new Error('A normal quantile needs a probability between zero and one.');
	const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
	const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
	const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
	const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
	const poly = (coefficients, x) => coefficients.reduce((sum, value) => sum * x + value, 0);
	if (p < 0.02425) {
		const q = Math.sqrt(-2 * Math.log(p));
		return poly(c, q) / (poly(d, q) * q + 1);
	}
	if (p > 0.97575) return -normalQuantile(1 - p);
	const q = p - 0.5,
		r = q * q;
	return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

export function rankRaceSamples(rows, samples, tolerance = 0.2) {
	const ordered = [...rows].sort((a, b) => b.meanDps - a.meanDps);
	const pairs = Math.max(1, (ordered.length * (ordered.length - 1)) / 2),
		z = normalQuantile(1 - 0.05 / (2 * pairs));
	const comparisons = ordered.map(row => ({ race: row.race, key: row.key, ...sampleComparison(samples(row), samples(ordered[0]), z) }));
	return {
		leader: ordered[0].race,
		practicalTolerancePercent: tolerance,
		interval: 'Approximate paired ratio intervals; Bonferroni adjustment over every race pair within this condition.',
		candidates: comparisons.filter(c => c.percent + c.halfWidthPercent >= -tolerance).map(c => c.race),
		comparisons,
	};
}

export function referenceEquipmentSet(sets) {
	const valid = sets.filter(g => !g.diagnosticOnly);
	const chosen = valid.find(g => g.id === 'developer') ?? valid.find(g => [g, ...(g.aliases ?? [])].some(a => a.origin === 'WoWSims developer'));
	if (!chosen) throw new Error('No legal developer reference equipment. Supply a reviewed developer alternative.');
	return chosen.id;
}
