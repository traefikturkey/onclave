package main

import (
	"log"
	"net/http"

	"github.com/traefikturkey/onclave/services/onclave/internal/api"
	"github.com/traefikturkey/onclave/services/onclave/internal/config"
)

func main() {
	serviceConfig := config.FromEnvironment()
	server := api.NewServer(api.Config{Address: serviceConfig.Address}, func() error {
		return nil
	})

	log.Printf("Onclave API listening on %s", serviceConfig.Address)
	if err := http.ListenAndServe(serviceConfig.Address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
