package config

import (
	"testing"
	"time"
)

func TestFromEnvironmentUsesSafeDefaults(t *testing.T) {
	t.Setenv("ONCLAVE_API_ADDRESS", "")
	t.Setenv("ONCLAVE_STATE_DIR", "")
	t.Setenv("ONCLAVE_SESSION_TTL", "")

	config := FromEnvironment()

	if config.Address != ":8080" {
		t.Fatalf("expected default address, got %q", config.Address)
	}
	if config.StateDir != "/data/onclave" {
		t.Fatalf("expected default state directory, got %q", config.StateDir)
	}
	if config.RabbitMQExchange != "onclave.commands" {
		t.Fatalf("expected default RabbitMQ exchange, got %q", config.RabbitMQExchange)
	}
	if config.SessionTTL != 24*time.Hour {
		t.Fatalf("expected 24-hour default session TTL, got %s", config.SessionTTL)
	}
}

func TestFromEnvironmentReadsOverrides(t *testing.T) {
	t.Setenv("ONCLAVE_API_ADDRESS", "127.0.0.1:9090")
	t.Setenv("ONCLAVE_STATE_DIR", "/tmp/onclave")
	t.Setenv("ONCLAVE_RABBITMQ_URL", "amqp://user:pass@rabbitmq:5672/%2Fonclave")
	t.Setenv("ONCLAVE_RABBITMQ_EXCHANGE", "custom.commands")
	t.Setenv("ONCLAVE_SESSION_TTL", "45m")

	config := FromEnvironment()

	if config.Address != "127.0.0.1:9090" || config.StateDir != "/tmp/onclave" || config.RabbitMQURL == "" || config.RabbitMQExchange != "custom.commands" || config.SessionTTL != 45*time.Minute {
		t.Fatalf("unexpected environment config: %+v", config)
	}
}

func TestFromEnvironmentFallsBackForInvalidSessionTTL(t *testing.T) {
	t.Setenv("ONCLAVE_SESSION_TTL", "not-a-duration")
	config := FromEnvironment()
	if config.SessionTTL != 24*time.Hour {
		t.Fatalf("expected safe session TTL fallback, got %s", config.SessionTTL)
	}
}
