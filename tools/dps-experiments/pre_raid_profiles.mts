import fs from 'node:fs';
import path from 'node:path';
import { Player as PlayerProto } from '@generated/proto/api';
import { ItemSlot, ItemSpec } from '@generated/proto/common';
import { Database } from '@sim/proto/database';
import { canEquipItem, getEligibleItemSlots } from '@sim/proto/items';
import { getPlayerSpecFromPlayer, raceToFaction } from '@sim/proto/utils';
import { itemEligibility, itemScore, roleFor, ROLE_WEIGHTS } from './pre_raid_policy.mjs';

export async function standardizeProfiles(root: string, config: any) {
	const reference = JSON.parse(fs.readFileSync(path.resolve(root, config.referenceRun, 'profiles.json'), 'utf8'));
	const policy = JSON.parse(fs.readFileSync(path.resolve(root, config.gearPolicy), 'utf8'));
	const db = await Database.get();
	const all = db.getAllItems();
	const pool = all.filter(item => itemEligibility(item, policy).eligible);
	const profiles = reference.profiles.map((original: any) => {
		const profile = structuredClone(original);
		const proto = PlayerProto.fromJson(original.player);
		const spec = getPlayerSpecFromPlayer(proto);
		const role = roleFor(profile);
		const used: any[] = [];
		const audit: any[] = [];
		const professions = [proto.profession1, proto.profession2];
		const faction = raceToFaction[proto.race];
		const choose = (slot: number, oldSpec: any, swap = false) => {
			if (role === 'caster' && slot === 15 && !swap) return {};
			if (!oldSpec?.id) return {};
			const old = db.getItemById(oldSpec.id);
			if (!old) throw new Error(`${profile.id}: missing original item ${oldSpec.id}`);
			const allowed = pool.filter(item => {
				if (!canEquipItem(item, spec, slot) || !getEligibleItemSlots(item).includes(slot)) return false;
				if (item.requiredProfession && !professions.includes(item.requiredProfession)) return false;
				const proof = itemEligibility(item, policy);
				if (
					proof.source?.crafted &&
					(slot === 12 || slot === 13 || (slot === 16 && item.rangedWeaponType >= 6)) &&
					!professions.includes(proof.source.crafted.profession)
				)
					return false;
				if (item.factionRestriction && Number(item.factionRestriction) !== Number(faction)) return false;
				if (role === 'caster' && slot === 14) {
					if (item.id !== policy.casterWeaponId) return false;
				} else if (item.weaponType !== old.weaponType || item.handType !== old.handType || item.rangedWeaponType !== old.rangedWeaponType) return false;
				if (!swap && used.some(other => other.id === item.id && item.unique)) return false;
				if (!swap && item.limitCategory && used.some(other => other.limitCategory === item.limitCategory)) return false;
				return true;
			});
			const requiredId = !swap ? (policy.requiredItems[profile.id]?.[slot] ?? policy.requiredItems[profile.specPath]?.[slot]) : undefined;
			const selected = requiredId
				? allowed.find(item => item.id === requiredId)
				: allowed.sort(
						(a, b) => itemScore(b, role, slot, profile.specPath) - itemScore(a, role, slot, profile.specPath) || b.ilvl - a.ilvl || a.id - b.id,
					)[0];
			if (!selected && (slot === 12 || slot === 13 || (slot === 16 && old.rangedWeaponType >= 6))) {
				audit.push({
					slot: ItemSlot[slot],
					slotIndex: slot,
					swap,
					oldId: old.id,
					oldName: old.name,
					id: 0,
					name: 'Empty: no approved item under profession policy',
					ilvl: 0,
					reason: 'No approved item',
				});
				return {};
			}
			if (!selected)
				throw new Error(`${profile.id}: no approved item for ${ItemSlot[slot]} (${old.name})${requiredId ? `; required ${requiredId}` : ''}`);
			const suffix = selected.randomSuffixOptions
				.map(id => {
					const equipped = db.lookupItemSpec(ItemSpec.create({ id: selected.id, randomSuffix: id }))!.withDynamicStats();
					return { id, name: db.getRandomSuffixById(id)!.name, score: itemScore(equipped.item, role, slot, profile.specPath) };
				})
				.sort((a, b) => b.score - a.score || a.id - b.id)[0];
			if (!swap) used.push(selected);
			const eligibility = itemEligibility(selected, policy);
			audit.push({
				slot: ItemSlot[slot],
				slotIndex: slot,
				swap,
				oldId: old.id,
				oldName: old.name,
				oldIlvl: old.ilvl,
				oldQuality: old.quality,
				oldEligibility: itemEligibility(old, policy),
				id: selected.id,
				name: selected.name,
				ilvl: selected.ilvl,
				quality: selected.quality,
				reason: eligibility.reason,
				source: eligibility.source,
				score: itemScore(selected, role, slot, profile.specPath),
				preservedForRotation: !!requiredId,
			});
			if (suffix) Object.assign(audit[audit.length - 1], { randomSuffix: suffix.id, name: `${selected.name} ${suffix.name}`, score: suffix.score });
			return suffix ? { id: selected.id, randomSuffix: suffix.id } : { id: selected.id };
		};
		profile.player.equipment.items = original.player.equipment.items.map((item: any, slot: number) => choose(slot, item));
		if (original.player.enableItemSwap)
			profile.player.itemSwap.items = original.player.itemSwap.items.map((item: any, slot: number) => choose(slot, item, true));
		profile.originalGearName = original.gearName;
		profile.gearName = `Pre-raid ≤${policy.maxItemLevel} / ${role}`;
		profile.gearTooltip = policy.notes.join(' ');
		profile.gearAudit = audit;
		profile.gearRole = role;
		profile.gearMeanIlvl = used.reduce((sum, item) => sum + item.ilvl, 0) / used.length;
		profile.warnings = original.warnings.filter(
			(warning: string) => !warning.includes('P1 Arcane gear') && !warning.includes('preset has no equipment') && !warning.includes('Default feral gear'),
		);
		profile.warnings.push(
			'Permanent enchants are removed. The previous resolved rotation and consumables are frozen; gear is selected by a static role score, not DPS optimization.',
		);
		if (profile.specPath === 'druid/feralcat') profile.warnings.push('The original external-bleed assumption is retained.');
		return profile;
	});
	return {
		schemaVersion: 1,
		profiles,
		specPaths: reference.specPaths,
		gearPolicy: policy,
		gearRoleWeights: ROLE_WEIGHTS,
		eligiblePoolSize: pool.length,
		referenceRun: config.referenceRun,
	};
}
