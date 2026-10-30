package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/wowsims/forever/sim"
	"github.com/wowsims/forever/sim/core"
	"github.com/wowsims/forever/sim/core/proto"
	"google.golang.org/protobuf/encoding/protojson"
)

type job struct {
	Key     string `json:"key"`
	Request string `json:"request"`
	Result  string `json:"result"`
	Stats   string `json:"stats"`
}

func writeJSON(file string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(file+".pending", data, 0644); err != nil {
		return err
	}
	return os.Rename(file+".pending", file)
}

func runJob(j job) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%s: %v", j.Key, r)
		}
	}()
	data, err := os.ReadFile(j.Request)
	if err != nil {
		return err
	}
	request := &proto.RaidSimRequest{}
	if err = protojson.Unmarshal(data, request); err != nil {
		return err
	}
	if request.Raid == nil || request.Encounter == nil || request.SimOptions == nil {
		return fmt.Errorf("%s: incomplete request", j.Key)
	}
	if j.Stats != "" {
		stats := core.ComputeStats(&proto.ComputeStatsRequest{Raid: request.Raid, Encounter: request.Encounter})
		if stats.ErrorResult != "" {
			return fmt.Errorf("%s: %s", j.Key, stats.ErrorResult)
		}
		encoded, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(stats)
		if err != nil {
			return err
		}
		if err = writeJSON(j.Stats, encoded); err != nil {
			return err
		}
	}
	result := core.RunRaidSim(request)
	if result.Error != nil && result.Error.Message != "" {
		return fmt.Errorf("%s: %s", j.Key, result.Error.Message)
	}
	if result.IterationsDone != request.SimOptions.Iterations {
		return fmt.Errorf("%s: incomplete iterations", j.Key)
	}
	encoded, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(result)
	if err != nil {
		return err
	}
	return writeJSON(j.Result, encoded)
}

func run() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: robust-sim jobs.json workers")
	}
	workers, err := strconv.Atoi(os.Args[2])
	if err != nil || workers < 1 || workers > 32 {
		return fmt.Errorf("workers must be between 1 and 32")
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	var jobs []job
	if err = json.Unmarshal(data, &jobs); err != nil {
		return err
	}
	sim.RegisterAll()
	queue := make(chan job)
	var wg sync.WaitGroup
	var mu sync.Mutex
	completed, failed := 0, 0
	started := time.Now()
	for range workers {
		wg.Go(func() {
			for j := range queue {
				err := runJob(j)
				mu.Lock()
				completed++
				if err != nil {
					failed++
					fmt.Fprintf(os.Stderr, "FAILED %s: %v\n", j.Key, err)
				}
				if completed%250 == 0 || completed == len(jobs) {
					fmt.Printf("%d/%d completed, %d failed, %.1fs\n", completed, len(jobs), failed, time.Since(started).Seconds())
				}
				mu.Unlock()
			}
		})
	}
	for _, j := range jobs {
		queue <- j
	}
	close(queue)
	wg.Wait()
	if failed > 0 {
		return fmt.Errorf("%d of %d jobs failed", failed, len(jobs))
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
