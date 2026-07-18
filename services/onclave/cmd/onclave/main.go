package main

import (
	"context"
	"encoding/json"
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
	if (serviceConfig.TLSCertFile == "") != (serviceConfig.TLSKeyFile == "") {
		log.Fatal("ONCLAVE_TLS_CERT_FILE and ONCLAVE_TLS_KEY_FILE must be configured together")
	}
	runContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var publisher messaging.Publisher
	var subscriber *messaging.RabbitMQPublisher
	if serviceConfig.RabbitMQURL != "" {
		rabbitPublisher, err := messaging.NewRabbitMQPublisherWithTLS(serviceConfig.RabbitMQURL, serviceConfig.RabbitMQExchange, serviceConfig.RabbitMQCAFile)
		if err != nil {
			log.Fatal(err)
		}
		defer rabbitPublisher.Close()
		publisher = messaging.NewRetryingPublisher(rabbitPublisher, 3, 100*time.Millisecond)
		subscriber = rabbitPublisher
	}
	if subscriber != nil {
		eventPublisher, _ := publisher.(messaging.EventPublisher)
		deadLetterSubscription, err := subscriber.SubscribeDeadLetters(runContext, "gateway-core", func(envelope messaging.Envelope) error {
			log.Printf("dead-lettered delivery message=%s task=%s routing=%s", envelope.MessageID, envelope.TaskID, envelope.RoutingKey)
			if eventPublisher == nil || envelope.SourceAgentID == "" {
				return nil
			}
			payload, err := json.Marshal(map[string]any{
				"eventType":  "task.delivery.failed",
				"messageId":  envelope.MessageID,
				"taskId":     envelope.TaskID,
				"routingKey": envelope.RoutingKey,
			})
			if err != nil {
				return err
			}
			return eventPublisher.PublishEvent(runContext, messaging.Envelope{
				RoutingKey: "task.delivery.failed." + envelope.SourceAgentID,
				MessageID:  envelope.MessageID + ":delivery-failed", TaskID: envelope.TaskID,
				SourceAgentID: "onclave", TargetAgentID: envelope.SourceAgentID,
				MessageType: "task.delivery.failed", IssuedAt: time.Now().UTC().Format(time.RFC3339Nano),
				ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), Payload: payload, Persistent: true,
			})
		})
		if err != nil {
			log.Printf("dead-letter observer unavailable: %v", err)
		} else {
			defer deadLetterSubscription.Close()
		}
	}
	store, err := persistence.Open(filepath.Join(serviceConfig.StateDir, "onclave.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	admissionService, err := admission.NewServiceWithStore(admission.Policy{SessionTTL: serviceConfig.SessionTTL, AllowedCapabilities: serviceConfig.AllowedCapabilities}, store)
	if err != nil {
		log.Fatal(err)
	}
	messagingService := messaging.NewServiceWithPublisherAndStore(time.Now, publisher, store)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-runContext.Done():
				return
			case <-ticker.C:
				if publisher != nil {
					if err := messagingService.ReplayPendingCommands(runContext); err != nil {
						log.Printf("command outbox replay failed: %v", err)
					}
					if err := messagingService.ReplayPendingEvents(runContext); err != nil {
						log.Printf("event outbox replay failed: %v", err)
					}
					if err := store.PrunePublishedOutbox(time.Now().Add(-7 * 24 * time.Hour)); err != nil {
						log.Printf("outbox cleanup failed: %v", err)
					}
				}
				if err := messagingService.ExpireSubscriptions(); err != nil {
					log.Printf("subscription cleanup failed: %v", err)
				}
			}
		}
	}()
	readiness := func() error {
		if err := store.Ping(runContext); err != nil {
			return err
		}
		if subscriber == nil {
			return nil
		}
		return subscriber.Ready()
	}
	server := api.NewApplicationServerWithBroker(api.Config{Address: serviceConfig.Address}, admissionService, messagingService, subscriber, readiness)

	protocol := "http"
	if serviceConfig.TLSCertFile != "" {
		protocol = "https"
	}
	log.Printf("Onclave API listening on %s://%s", protocol, serviceConfig.Address)
	httpServer := &http.Server{
		Addr:              serviceConfig.Address,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() {
		if serviceConfig.TLSCertFile != "" {
			serverErrors <- httpServer.ListenAndServeTLS(serviceConfig.TLSCertFile, serviceConfig.TLSKeyFile)
			return
		}
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
