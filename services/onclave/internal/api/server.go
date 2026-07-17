package api

import (
	"encoding/json"
	"errors"
	"net/http"
)

var errDependencyUnavailable = errors.New("dependency unavailable")

type Config struct {
	Address string
}

type ReadinessCheck func() error

type Server struct {
	config    Config
	readiness ReadinessCheck
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

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	return mux
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
