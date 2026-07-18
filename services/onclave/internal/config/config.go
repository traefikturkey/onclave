package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	Address             string
	StateDir            string
	RabbitMQURL         string
	RabbitMQExchange    string
	RabbitMQCAFile      string
	EventRetention      time.Duration
	SessionTTL          time.Duration
	TLSCertFile         string
	TLSKeyFile          string
	AllowedCapabilities map[string]map[string]bool
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
	exchange := os.Getenv("ONCLAVE_RABBITMQ_EXCHANGE")
	if exchange == "" {
		exchange = "onclave.commands"
	}
	sessionTTL := 24 * time.Hour
	if value := os.Getenv("ONCLAVE_SESSION_TTL"); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil && parsed > 0 {
			sessionTTL = parsed
		}
	}
	eventRetention := 30 * 24 * time.Hour
	if value := os.Getenv("ONCLAVE_EVENT_RETENTION"); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil && parsed > 0 {
			eventRetention = parsed
		}
	}
	allowedCapabilities := map[string]map[string]bool{"*": {}}
	for _, capability := range strings.Split(os.Getenv("ONCLAVE_ALLOWED_CAPABILITIES"), ",") {
		if capability = strings.TrimSpace(capability); capability != "" {
			allowedCapabilities["*"][capability] = true
		}
	}
	return Config{
		Address: address, StateDir: stateDir,
		RabbitMQURL: os.Getenv("ONCLAVE_RABBITMQ_URL"), RabbitMQExchange: exchange,
		RabbitMQCAFile: os.Getenv("ONCLAVE_RABBITMQ_CA_FILE"),
		SessionTTL:     sessionTTL,
		EventRetention: eventRetention,
		TLSCertFile:    os.Getenv("ONCLAVE_TLS_CERT_FILE"), TLSKeyFile: os.Getenv("ONCLAVE_TLS_KEY_FILE"),
		AllowedCapabilities: allowedCapabilities,
	}
}
