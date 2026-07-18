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
	var publisher messaging.Publisher
	var subscriber *messaging.RabbitMQPublisher
	if serviceConfig.RabbitMQURL != "" {
		rabbitPublisher, err := messaging.NewRabbitMQPublisher(serviceConfig.RabbitMQURL, serviceConfig.RabbitMQExchange)
		if err != nil {
			log.Fatal(err)
		}
		defer rabbitPublisher.Close()
		publisher = messaging.NewRetryingPublisher(rabbitPublisher, 3, 100*time.Millisecond)
		subscriber = rabbitPublisher
	}
	store, err := persistence.Open(filepath.Join(serviceConfig.StateDir, "onclave.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	admissionService, err := admission.NewServiceWithStore(admission.Policy{}, store)
	if err != nil {
		log.Fatal(err)
	}
	messagingService := messaging.NewServiceWithPublisherAndStore(time.Now, publisher, store)
	server := api.NewApplicationServerWithBroker(api.Config{Address: serviceConfig.Address}, admissionService, messagingService, subscriber, func() error {
		return nil
	})

	log.Printf("Onclave API listening on %s", serviceConfig.Address)
	if err := http.ListenAndServe(serviceConfig.Address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
