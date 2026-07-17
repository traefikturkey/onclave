package config

import "testing"

func TestFromEnvironmentUsesSafeDefaults(t *testing.T) {
	t.Setenv("ONCLAVE_API_ADDRESS", "")
	t.Setenv("ONCLAVE_STATE_DIR", "")

	config := FromEnvironment()

	if config.Address != ":8080" {
		t.Fatalf("expected default address, got %q", config.Address)
	}
	if config.StateDir != "/data/onclave" {
		t.Fatalf("expected default state directory, got %q", config.StateDir)
	}
}

func TestFromEnvironmentReadsOverrides(t *testing.T) {
	t.Setenv("ONCLAVE_API_ADDRESS", "127.0.0.1:9090")
	t.Setenv("ONCLAVE_STATE_DIR", "/tmp/onclave")

	config := FromEnvironment()

	if config.Address != "127.0.0.1:9090" || config.StateDir != "/tmp/onclave" {
		t.Fatalf("unexpected environment config: %+v", config)
	}
}
