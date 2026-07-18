package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/api"
	"github.com/traefikturkey/onclave/services/onclave/internal/config"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
	"github.com/traefikturkey/onclave/services/onclave/internal/persistence"
)

func main() {
	serviceConfig := config.FromEnvironment()
	runContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
	if publisher != nil {
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-runContext.Done():
					return
				case <-ticker.C:
					if err := messagingService.ReplayPendingCommands(runContext); err != nil {
						log.Printf("command outbox replay failed: %v", err)
					}
					if err := messagingService.ReplayPendingEvents(runContext); err != nil {
						log.Printf("event outbox replay failed: %v", err)
					}
				}
			}
		}()
	}
	server := api.NewApplicationServerWithBroker(api.Config{Address: serviceConfig.Address}, admissionService, messagingService, subscriber, func() error {
		return nil
	})

	log.Printf("Onclave API listening on %s", serviceConfig.Address)
	httpServer := &http.Server{Addr: serviceConfig.Address, Handler: server.Handler()}
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- httpServer.ListenAndServe()
	}()
	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-runContext.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownContext); err != nil {
			log.Printf("HTTP shutdown failed: %v", err)
		}
	}
}
