package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/wowsims/forever/sim"
	"github.com/wowsims/forever/sim/core"
	"github.com/wowsims/forever/sim/core/proto"
	"github.com/wowsims/forever/sim/core/stats"
	"google.golang.org/protobuf/encoding/protojson"
)

func run() error {
	if len(os.Args) != 3 && len(os.Args) != 4 {
		return fmt.Errorf("usage: stats input.json output.json [equipment]")
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	request := &proto.RaidSimRequest{}
	if err = protojson.Unmarshal(data, request); err != nil {
		return err
	}
	sim.RegisterAll()
	if request.Raid == nil || len(request.Raid.Parties) == 0 || len(request.Raid.Parties[0].Players) == 0 {
		return fmt.Errorf("a raid request with a player is required")
	}
	if len(os.Args) == 4 {
		if os.Args[3] != "equipment" {
			return fmt.Errorf("unknown output mode: %s", os.Args[3])
		}
		named := func(values stats.Stats) map[string]float64 {
			result := map[string]float64{}
			for index, value := range values {
				if value != 0 {
					result[stats.Stat(index).StatName()] = value
				}
			}
			return result
		}
		items := []map[string]any{}
		for slot, spec := range request.Raid.Parties[0].Players[0].Equipment.Items {
			if spec.Id == 0 {
				continue
			}
			item := core.NewItem(core.ItemSpec{ID: spec.Id, Enchant: spec.Enchant, RandomSuffix: spec.RandomSuffix})
			items = append(items, map[string]any{
				"slot": slot, "spec": spec, "name": item.Name, "type": item.Type.String(),
				"armorType": item.ArmorType.String(), "weaponType": item.WeaponType.String(),
				"handType": item.HandType.String(), "rangedWeaponType": item.RangedWeaponType.String(),
				"weaponDamageMin": item.WeaponDamageMin, "weaponDamageMax": item.WeaponDamageMax,
				"weaponSpeed": item.SwingSpeed, "baseStats": named(core.ItemEquipmentBaseStats(item)),
				"enchantStats":   named(core.ItemEquipmentEnchantStats(item)),
				"enchantEffects": item.Enchant.EnchantEffects, "itemEffects": item.ItemEffects,
			})
		}
		data, err = json.MarshalIndent(items, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(os.Args[2], data, 0644)
	}
	result := core.ComputeStats(&proto.ComputeStatsRequest{Raid: request.Raid, Encounter: request.Encounter})
	if result.ErrorResult != "" {
		return fmt.Errorf("compute stats: %s", result.ErrorResult)
	}
	data, err = (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(result)
	if err != nil {
		return err
	}
	return os.WriteFile(os.Args[2], data, 0644)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
