package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func TestHealthEndpointReportsProcessHealth(t *testing.T) {
	handler := NewServer(Config{}, func() error { return nil }).Handler()
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected health status 200, got %d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected JSON content type, got %q", got)
	}
}

func TestReadinessEndpointRejectsUnavailableDependencies(t *testing.T) {
	handler := NewServer(Config{}, func() error { return errDependencyUnavailable }).Handler()
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected readiness status 503, got %d", response.Code)
	}
}

func TestReadinessEndpointAcceptsReadyDependencies(t *testing.T) {
	handler := NewServer(Config{}, func() error { return nil }).Handler()
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected readiness status 200, got %d", response.Code)
	}
}

func TestMetricsEndpointReportsCoreState(t *testing.T) {
	server := NewApplicationServer(Config{}, nil, messaging.NewService(nil), nil)
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected metrics status 200, got %d", response.Code)
	}
	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("expected JSON metrics content type, got %q", response.Header().Get("Content-Type"))
	}
}
