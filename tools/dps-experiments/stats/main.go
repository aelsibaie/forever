package main

import (
	"fmt"
	"os"

	"github.com/wowsims/forever/sim"
	"github.com/wowsims/forever/sim/core"
	"github.com/wowsims/forever/sim/core/proto"
	"google.golang.org/protobuf/encoding/protojson"
)

func run() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: stats input.json output.json")
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
