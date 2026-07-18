package config

import (
	"testing"
	"time"
)

func TestFromEnvironmentUsesSafeDefaults(t *testing.T) {
	t.Setenv("ONCLAVE_API_ADDRESS", "")
	t.Setenv("ONCLAVE_STATE_DIR", "")
	t.Setenv("ONCLAVE_SESSION_TTL", "")
	t.Setenv("ONCLAVE_TLS_CERT_FILE", "")
	t.Setenv("ONCLAVE_TLS_KEY_FILE", "")
	t.Setenv("ONCLAVE_EVENT_RETENTION", "")
	t.Setenv("ONCLAVE_ALLOWED_CAPABILITIES", "")

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
	if config.EventRetention != 30*24*time.Hour {
		t.Fatalf("expected 30-day event retention, got %s", config.EventRetention)
	}
	if config.AllowedCapabilities["*"]["message.send"] {
		t.Fatal("expected empty default capability allowlist")
	}
}

func TestFromEnvironmentReadsOverrides(t *testing.T) {
	t.Setenv("ONCLAVE_API_ADDRESS", "127.0.0.1:9090")
	t.Setenv("ONCLAVE_STATE_DIR", "/tmp/onclave")
	t.Setenv("ONCLAVE_RABBITMQ_URL", "amqp://user:pass@rabbitmq:5672/%2Fonclave")
	t.Setenv("ONCLAVE_RABBITMQ_EXCHANGE", "custom.commands")
	t.Setenv("ONCLAVE_RABBITMQ_CA_FILE", "/run/secrets/rabbitmq-ca.pem")
	t.Setenv("ONCLAVE_SESSION_TTL", "45m")
	t.Setenv("ONCLAVE_EVENT_RETENTION", "2h")
	t.Setenv("ONCLAVE_TLS_CERT_FILE", "/run/secrets/onclave.crt")
	t.Setenv("ONCLAVE_TLS_KEY_FILE", "/run/secrets/onclave.key")
	t.Setenv("ONCLAVE_ALLOWED_CAPABILITIES", "message.send, message.receive")

	config := FromEnvironment()

	if config.Address != "127.0.0.1:9090" || config.StateDir != "/tmp/onclave" || config.RabbitMQURL == "" || config.RabbitMQExchange != "custom.commands" || config.RabbitMQCAFile != "/run/secrets/rabbitmq-ca.pem" || config.SessionTTL != 45*time.Minute || config.EventRetention != 2*time.Hour || config.TLSCertFile == "" || config.TLSKeyFile == "" {
		t.Fatalf("unexpected environment config: %+v", config)
	}
	if !config.AllowedCapabilities["*"]["message.send"] || !config.AllowedCapabilities["*"]["message.receive"] {
		t.Fatalf("unexpected capability allowlist: %+v", config.AllowedCapabilities)
	}
}

func TestFromEnvironmentFallsBackForInvalidSessionTTL(t *testing.T) {
	t.Setenv("ONCLAVE_SESSION_TTL", "not-a-duration")
	config := FromEnvironment()
	if config.SessionTTL != 24*time.Hour {
		t.Fatalf("expected safe session TTL fallback, got %s", config.SessionTTL)
	}
}
