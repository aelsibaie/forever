export function staticCondition(value, { spells, auras, targetAuras, variables }, trail = []) {
	if (!value) return true;
	if (value.variableRef) {
		const name = value.variableRef.name;
		if (trail.includes(name) || !variables.has(name)) return null;
		return staticCondition(variables.get(name), { spells, auras, targetAuras, variables }, [...trail, name]);
	}
	if (value.const) return /^(true|1)$/i.test(value.const.val) ? true : /^(false|0)$/i.test(value.const.val) ? false : null;
	// Spell-ID metadata does not classify item-based actions.
	if (value.spellIsKnown) return value.spellIsKnown.spellId.spellId ? spells.has(value.spellIsKnown.spellId.spellId) : null;
	if (value.auraIsKnown)
		return value.auraIsKnown.auraId.spellId
			? (['Target', 'CurrentTarget'].includes(value.auraIsKnown.sourceUnit?.type) ? targetAuras : auras).has(value.auraIsKnown.auraId.spellId)
			: null;
	if (value.not) {
		const v = staticCondition(value.not.val, { spells, auras, targetAuras, variables }, trail);
		return v === null ? null : !v;
	}
	if (value.and || value.or) {
		const and = !!value.and,
			values = (value.and ?? value.or).vals.map(v => staticCondition(v, { spells, auras, targetAuras, variables }, trail));
		return values.includes(and ? false : true) ? !and : values.every(v => v === (and ? true : false)) ? and : null;
	}
	return null;
}

export function inspectRotation(player, stats) {
	const sheet = stats.raidStats.parties[0].players[0],
		rotation = structuredClone(player.rotation);
	const context = {
		spells: new Set(sheet.metadata.spells.map(s => s.id.spellId).filter(Boolean)),
		auras: new Set(sheet.metadata.auras.map(s => s.id.spellId).filter(Boolean)),
		targetAuras: new Set(stats.encounterStats.targets[0].metadata.auras.map(s => s.id.spellId).filter(Boolean)),
		variables: new Map((rotation.valueVariables ?? []).map(v => [v.name, v.value])),
	};
	const findings = [],
		replacements = [];
	const inspect = (entries, native, prefix) => {
		for (const [index, line] of entries.entries()) {
			const condition = staticCondition(line.action?.condition, context),
				cast = line.action?.castSpell?.spellId?.spellId;
			const warnings = (native?.[index]?.validations ?? []).filter(w => w.logLevel !== 'Information');
			const severity = line.hide
				? 'Disabled'
				: condition === false
					? 'Guarded inactive'
					: cast && !context.spells.has(cast)
						? 'Unknown action'
						: warnings.some(w => /always true|branch.*dropped/.test(w.validation))
							? 'Needs runtime review'
							: 'Screened';
			if (warnings.length) findings.push({ path: prefix + '[' + index + ']', severity, staticCondition: condition, castSpell: cast, warnings });
			if (condition === false && line.action?.condition && !line.action.condition.const) {
				// Pruned actions still suppress automatic cooldown use, so retain the action.
				replacements.push({ path: prefix + '[' + index + ']', original: line.action.condition });
				line.action.condition = { const: { val: 'false' } };
			}
		}
	};
	inspect(rotation.priorityList ?? [], sheet.rotationStats.priorityList, 'priorityList');
	for (const [i, group] of (rotation.groups ?? []).entries())
		inspect(group.actions ?? [], sheet.rotationStats.groups?.[i]?.actions, 'groups[' + i + '].actions');
	return { findings, replacements, rotation };
}

export function guardedManaRacial(player, spellId = 1259705) {
	const copy = structuredClone(player);
	copy.rotation.priorityList.unshift({
		action: {
			condition: {
				and: {
					vals: [
						{ spellIsKnown: { spellId: { spellId } } },
						{ cmp: { op: 'OpLe', lhs: { currentManaPercent: {} }, rhs: { const: { val: '65%' } } } },
					],
				},
			},
			castSpell: { spellId: { spellId } },
		},
	});
	return copy;
}
