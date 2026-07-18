package config

import (
	"os"
	"time"
)

type Config struct {
	Address          string
	StateDir         string
	RabbitMQURL      string
	RabbitMQExchange string
	SessionTTL       time.Duration
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
	return Config{
		Address: address, StateDir: stateDir,
		RabbitMQURL: os.Getenv("ONCLAVE_RABBITMQ_URL"), RabbitMQExchange: exchange,
		SessionTTL: sessionTTL,
	}
}
