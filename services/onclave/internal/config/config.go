package config

import "os"

type Config struct {
	Address  string
	StateDir string
}

func FromEnvironment() Config {
	address := os.Getenv("ONCLAVE_API_ADDRESS")
	if address == "" {
		address = ":8080"
	}
	stateDir := os.Getenv("ONCLAVE_STATE_DIR")
	if stateDir == "" {
		stateDir = "/data/onclave"
	}
	return Config{Address: address, StateDir: stateDir}
}
