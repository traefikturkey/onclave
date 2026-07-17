package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
