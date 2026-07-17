package main

import (
	"log"
	"net/http"
	"path/filepath"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/api"
	"github.com/traefikturkey/onclave/services/onclave/internal/config"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
	"github.com/traefikturkey/onclave/services/onclave/internal/persistence"
)

func main() {
	serviceConfig := config.FromEnvironment()
	admissionService := admission.NewService(admission.Policy{})
	var publisher messaging.Publisher
	if serviceConfig.RabbitMQURL != "" {
		rabbitPublisher, err := messaging.NewRabbitMQPublisher(serviceConfig.RabbitMQURL, serviceConfig.RabbitMQExchange)
		if err != nil {
			log.Fatal(err)
		}
		defer rabbitPublisher.Close()
		publisher = rabbitPublisher
	}
	store, err := persistence.Open(filepath.Join(serviceConfig.StateDir, "onclave.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	messagingService := messaging.NewServiceWithPublisherAndStore(time.Now, publisher, store)
	server := api.NewApplicationServer(api.Config{Address: serviceConfig.Address}, admissionService, messagingService, func() error {
		return nil
	})

	log.Printf("Onclave API listening on %s", serviceConfig.Address)
	if err := http.ListenAndServe(serviceConfig.Address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
