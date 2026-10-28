import { applyBuild } from '@features/settings/model/apply_build';
import { applyDefaultRotation } from '@features/settings/model/apply_defaults';
import { Player as PlayerProto, RaidSimRequest } from '@generated/proto/api';
import { IndividualSimSettings } from '@generated/proto/ui';
import { APLRotation_Type } from '@generated/proto/apl';
import { Class, EquipmentSpec, Profession, Race } from '@generated/proto/common';
import { CURRENT_API_VERSION, LaunchStatus } from '@sim/constants/other';
import { Player, registerSpecConfig } from '@sim/player/player';
import { PlayerSpecs } from '@sim/player/specs';
import { CLASS_RACES } from '@sim/player/classes/capabilities_auto_gen';
import type { PresetBuild } from '@sim/presets/types';
import { Database } from '@sim/proto/database';
import { Raid } from '@sim/raid/raid';
import type { Sim } from '@sim/sim';
import type { IndividualSimHost } from '@sim/sim_host';
import type { SpecDefinition } from '@sim/spec_config';
import { createSimStore } from '@sim/state/sim_store';

const specPaths = [
	'druid/balance',
	'druid/feralcat',
	'hunter/dps',
	'mage/dps',
	'paladin/retribution',
	'priest/dps',
	'rogue/dps',
	'shaman/elemental',
	'shaman/enhancement',
	'warlock/dps',
	'warrior/dps',
];
const specModules = import.meta.glob('../../ui/specs/**/spec.ts');

const slug = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

const containsMutilate = (value: unknown): boolean => {
	if (!value || typeof value !== 'object') return false;
	const node = value as Record<string, any>;
	if (node.hide || node.condition?.const?.val === 'false') return false;
	if (node.castSpell?.spellId?.spellId === 1241584) return true;
	return Object.values(node).some(containsMutilate);
};

export async function exportProfiles(root: string, fallbackGear: Record<string, string> = {}) {
	const db = await Database.get();
	const profiles: any[] = [];
	for (const specPath of specPaths) {
		const def: SpecDefinition<any> = ((await specModules[`../../ui/specs/${specPath}/spec.ts`]()) as { default: SpecDefinition<any> }).default;
		registerSpecConfig(def.spec, def);
		const playerSpec = PlayerSpecs.fromProto(def.spec);
		const candidates: { build: PresetBuild; origin: string }[] = (def.presets.builds ?? []).map(build => ({ build, origin: 'build preset' }));
		const coveredTalents = new Set(candidates.map(({ build }) => build.talents?.data.talentsString));
		for (const talents of def.presets.talents) {
			if (!coveredTalents.has(talents.data.talentsString))
				candidates.push({ build: { name: talents.name, talents }, origin: 'talent preset with spec defaults' });
		}
		candidates.push({ build: { name: specPath === 'druid/feralcat' ? 'Cat / Monocat' : 'Default' }, origin: 'spec defaults' });
		const seen = new Set<string>();
		for (const { build, origin } of candidates) {
			// The settings domain uses its real store and raid; native execution happens in the CLI.
			const sim = { store: createSimStore(), db } as unknown as Sim;
			Object.assign(sim, { raid: new Raid(sim) });
			const player = new Player(playerSpec, sim);
			sim.raid.setPlayer(0, player);
			const host = { sim, player, individualConfig: def } as unknown as IndividualSimHost<any>;
			const defaults = def.defaults;
			player.applySharedDefaults();
			applyBuild(
				{
					name: 'Spec defaults',
					gear: { name: 'Spec defaults', gear: defaults.gear },
					talents: { name: 'Spec defaults', data: defaults.talents },
					settings: {
						name: 'Spec defaults',
						race: defaults.other?.race || player.getPlayerClass().races[0],
						specOptions: defaults.specOptions,
						consumables: defaults.consumables,
						buffs: defaults.individualBuffs,
						raidBuffs: defaults.raidBuffs,
						partyBuffs: defaults.partyBuffs,
						debuffs: defaults.debuffs,
						playerOptions: {
							profession1: defaults.other?.profession1 ?? Profession.Engineering,
							profession2: defaults.other?.profession2 ?? Profession.ProfessionUnknown,
							distanceFromTarget: defaults.other?.distanceFromTarget ?? 0,
							reactionTimeMs: defaults.other?.reactionTime || 100,
							channelClipDelayMs: defaults.other?.channelClipDelay ?? 0,
						},
					},
				},
				host,
			);
			if (defaults.itemSwap) {
				player.itemSwapSettings.setItemSwapSettings(true, db.lookupItemSwap(defaults.itemSwap));
			}
			applyDefaultRotation(player, def);
			if (def.defaultBuild) applyBuild({ ...def.defaultBuild, encounter: undefined }, host);
			applyBuild({ ...build, encounter: undefined }, host);
			let fallbackSource: string | undefined;
			let fallbackEquipment: EquipmentSpec | undefined;
			if (
				!player
					.getGear()
					.asSpec()
					.items.some(item => item.id)
			) {
				fallbackSource = fallbackGear[specPath];
				if (!fallbackSource) throw new Error(`${specPath} / ${build.name}: no equipment and no explicit fallback gear.`);
				fallbackEquipment = EquipmentSpec.fromJson(JSON.parse(fs.readFileSync(path.resolve(root, fallbackSource), 'utf8')));
				await Database.loadLeftoversIfNecessary(fallbackEquipment);
				player.setGear(db.lookupEquipmentSpec(fallbackEquipment));
			}
			const id = slug(`${specPath}-${build.group ?? ''}-${build.name}`);
			player.setName(id);
			const proto = player.toProto(true, true);
			const signature = JSON.stringify(PlayerProto.toJson({ ...proto, name: '' }));
			if (seen.has(signature)) {
				player.dispose();
				continue;
			}
			seen.add(signature);
			const expectedEquipment = fallbackEquipment ?? build.gear?.gear ?? def.defaultBuild?.gear?.gear ?? defaults.gear;
			const missingItems = expectedEquipment.items.filter(item => item.id && !db.getItemById(item.id));
			if (missingItems.length) throw new Error(`${id}: missing items ${missingItems.map(item => item.id).join(', ')}`);
			const warnings: string[] = [];
			if (fallbackSource) warnings.push(`The preset has no equipment. The baseline uses ${fallbackSource}.`);
			const brokenTalents = player.getBrokenTalentNames();
			if (brokenTalents.length) warnings.push(`Talent prerequisites: ${brokenTalents.join(', ')}`);
			const knownIssues = def.knownIssues?.filter(issue => typeof issue === 'string') ?? [];
			const parsedTalents = player.getTalents();
			if (
				specPath === 'rogue/dps' &&
				'mutilate' in parsedTalents &&
				parsedTalents.mutilate &&
				knownIssues.some(issue => /mutilate.*(?:no|not).*apl/i.test(issue)) &&
				!containsMutilate(proto.rotation)
			)
				warnings.push('The supplied Rogue rotation has no Mutilate action. This profile is retained for coverage and excluded from rankings.');
			const gear = build.gear ?? def.presets.gear.find(preset => JSON.stringify(preset.gear) === JSON.stringify(expectedEquipment));
			profiles.push({
				id,
				className: player.getPlayerClass().friendlyName,
				specPath,
				name: [build.group, build.name].filter(Boolean).join(' / '),
				origin,
				source: `ui/specs/${specPath}/spec.ts`,
				launchStatus: LaunchStatus[playerSpec.launch.status],
				gearName: fallbackSource ? 'Pre-raid (baseline fallback)' : (gear?.name ?? 'Spec default'),
				fallbackGearSource: fallbackSource,
				gearTooltip: gear?.tooltip ?? '',
				devOnlyGear: gear?.devOnly ?? false,
				race: Race[player.getRace()],
				professions: [Profession[player.getProfession1()], Profession[player.getProfession2()]],
				talentAllocation: Object.entries(parsedTalents)
					.filter(([, points]) => Number(points) > 0)
					.map(([field, points]) => ({ field, points: Number(points), name: field.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()) })),
				talentPoints: player.getTalentTreePoints(),
				rotationType: APLRotation_Type[player.getRotationType()],
				warnings,
				knownIssues,
				rankEligible: !warnings.some(warning => warning.includes('excluded from rankings')) && brokenTalents.length === 0,
				player: PlayerProto.toJson(proto),
			});
			player.dispose();
		}
	}
	const racesByClass = Object.fromEntries(
		Object.entries(CLASS_RACES).map(([id, races]) => [Class[Number(id)].replace(/^Class/, ''), races.map(race => Race[race])]),
	);
	return { schemaVersion: 1, apiVersion: CURRENT_API_VERSION, profiles, specPaths, racesByClass };
}

export const validateRequest = (request: unknown) => RaidSimRequest.toJson(RaidSimRequest.fromJson(request as any));
export const validateWebsite = (settings: unknown) => IndividualSimSettings.toJson(IndividualSimSettings.fromJson(settings as any));
import fs from 'node:fs';
import path from 'node:path';
