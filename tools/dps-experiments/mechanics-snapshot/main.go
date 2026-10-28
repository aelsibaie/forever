package main

import (
	"encoding/json"
	"fmt"
	"github.com/wowsims/forever/sim"
	"github.com/wowsims/forever/sim/core"
	"github.com/wowsims/forever/sim/core/proto"
	"github.com/wowsims/forever/sim/core/simsignals"
	"github.com/wowsims/forever/sim/core/spelldata"
	"github.com/wowsims/forever/sim/core/stats"
	"google.golang.org/protobuf/encoding/protojson"
	"os"
)

type job struct {
	Key     string `json:"key"`
	Request string `json:"request"`
	Output  string `json:"output"`
}

func named(unit *core.Unit) map[string]float64 {
	out := map[string]float64{}
	for stat, value := range unit.GetStats() {
		if value != 0 {
			out[stats.Stat(stat).StatName()] = value
		}
	}
	return out
}

func describe(unit *core.Unit, target *core.Unit) map[string]any {
	spells := []map[string]any{}
	for _, spell := range unit.Spellbook {
		row := spelldata.Find(spell.ActionID.SpellID)
		data := map[string]any{"id": spell.ActionID.SpellID, "itemId": spell.ActionID.ItemID, "tag": spell.ActionID.Tag, "flags": spell.Flags.String(), "defense": spell.DefenseType, "procMask": spell.ProcMask.String(), "gcdSeconds": spell.DefaultCast.GCD.Seconds(), "baseCastSeconds": spell.DefaultCast.CastTime.Seconds(), "channeled": spell.Flags.Matches(core.SpellFlagChanneled), "rowFound": row.ID != 0, "rowName": row.Name, "rowPeriodicCanCrit": row.PeriodicCanCrit()}
		at := unit.AttackTables[target.UnitIndex]
		if spell.DefenseType != core.DefenseTypeNone {
			data["critMultiplier"] = spell.CritDamageMultiplier(at)
		}
		if spell.DefenseType == core.DefenseTypeMagic {
			data["missChance"] = spell.SpellChanceToMiss(at)
			data["critChance"] = spell.SpellCritChance(target)
		}
		if spell.DefenseType == core.DefenseTypeMelee || spell.DefenseType == core.DefenseTypeRanged {
			data["missChance"] = spell.GetPhysicalMissChance(at)
			data["critChance"] = spell.PhysicalCritChance(at)
		}
		if dot := spell.Dot(target); dot != nil {
			data["hasDot"] = true
			data["baseTicks"] = dot.BaseTickCount
			data["baseTickSeconds"] = dot.BaseTickLength.Seconds()
			data["tickSeconds"] = dot.CalcTickPeriod().Seconds()
		}
		spells = append(spells, data)
	}
	return map[string]any{"name": unit.Label, "unitIndex": unit.UnitIndex, "stats": named(unit), "spells": spells}
}

func inspect(j job) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%s: %v", j.Key, r)
		}
	}()
	raw, err := os.ReadFile(j.Request)
	if err != nil {
		return err
	}
	request := &proto.RaidSimRequest{}
	if err = protojson.Unmarshal(raw, request); err != nil {
		return err
	}
	state := core.NewSim(request, simsignals.CreateSignals())
	state.Reset()
	for steps := 0; state.CurrentTime < 0; steps++ {
		if steps > 200000 {
			return fmt.Errorf("prepull did not finish")
		}
		if state.Step() {
			break
		}
	}
	character := state.Raid.Parties[0].Players[0].GetCharacter()
	target := state.Encounter.AllTargetUnits[0]
	owner := describe(&character.Unit, target)
	pets := []map[string]any{}
	for _, pet := range character.Pets {
		pets = append(pets, describe(&pet.Unit, target))
	}
	value := map[string]any{"key": j.Key, "capturedAtSeconds": state.CurrentTime.Seconds(), "scope": "Native state at pull after reset and prepull; transient auras can modify these values.", "owner": owner, "pets": pets}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(j.Output, encoded, 0644)
}

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: mechanics-snapshot jobs.json")
	}
	bytes, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	var jobs []job
	if err = json.Unmarshal(bytes, &jobs); err != nil {
		return err
	}
	sim.RegisterAll()
	failed := 0
	for _, j := range jobs {
		if err = inspect(j); err != nil {
			failed++
			fmt.Fprintln(os.Stderr, err)
		}
	}
	fmt.Printf("%d snapshots, %d failed\n", len(jobs), failed)
	if failed > 0 {
		return fmt.Errorf("native snapshot failures: %d", failed)
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
