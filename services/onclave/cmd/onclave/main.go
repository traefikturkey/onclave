package main

import (
	"log"
	"net/http"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/api"
	"github.com/traefikturkey/onclave/services/onclave/internal/config"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
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
	messagingService := messaging.NewServiceWithPublisher(time.Now, publisher)
	server := api.NewApplicationServer(api.Config{Address: serviceConfig.Address}, admissionService, messagingService, func() error {
		return nil
	})

	log.Printf("Onclave API listening on %s", serviceConfig.Address)
	if err := http.ListenAndServe(serviceConfig.Address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
