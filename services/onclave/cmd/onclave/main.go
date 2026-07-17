package main

import (
	"log"
	"net/http"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/api"
	"github.com/traefikturkey/onclave/services/onclave/internal/config"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func main() {
	serviceConfig := config.FromEnvironment()
	admissionService := admission.NewService(admission.Policy{})
	messagingService := messaging.NewService(nil)
	server := api.NewApplicationServer(api.Config{Address: serviceConfig.Address}, admissionService, messagingService, func() error {
		return nil
	})

	log.Printf("Onclave API listening on %s", serviceConfig.Address)
	if err := http.ListenAndServe(serviceConfig.Address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
