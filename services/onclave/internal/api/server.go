package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

var errDependencyUnavailable = errors.New("dependency unavailable")

type Config struct {
	Address string
}

type ReadinessCheck func() error

type Server struct {
	config     Config
	readiness  ReadinessCheck
	admission  *admission.Service
	messaging  *messaging.Service
	subscriber agentSubscriber
}

func NewServer(config Config, readiness ReadinessCheck) *Server {
	if config.Address == "" {
		config.Address = ":8080"
	}
	if readiness == nil {
		readiness = func() error { return nil }
	}
	return &Server{config: config, readiness: readiness}
}

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	writeStatus(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) ready(writer http.ResponseWriter, _ *http.Request) {
	if err := s.readiness(); err != nil {
		writeStatus(writer, http.StatusServiceUnavailable, map[string]string{
			"status": "not_ready",
			"error":  err.Error(),
		})
		return
	}
	writeStatus(writer, http.StatusOK, map[string]string{"status": "ready"})
}

func writeStatus(writer http.ResponseWriter, status int, payload map[string]string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}
