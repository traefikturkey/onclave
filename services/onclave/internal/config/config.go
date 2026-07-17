package config

import "os"

type Config struct {
	Address          string
	StateDir         string
	RabbitMQURL      string
	RabbitMQExchange string
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
	return Config{
		Address: address, StateDir: stateDir,
		RabbitMQURL: os.Getenv("ONCLAVE_RABBITMQ_URL"), RabbitMQExchange: exchange,
	}
}
