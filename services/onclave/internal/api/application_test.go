package api

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func TestAgentAdmissionAndTaskSubmissionFlow(t *testing.T) {
	admissionService := admission.NewService(admission.Policy{AllowedCapabilities: map[string]map[string]bool{
		"reference": {"message.receive": true},
	}})
	messagingService := messaging.NewService(time.Now)
	server := NewApplicationServer(Config{}, admissionService, messagingService, func() error { return nil })

	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	postJSON(t, server.Handler(), "/v1/enroll", map[string]any{
		"agentId":     "agent-api",
		"runtimeType": "reference",
		"publicKey":   base64.StdEncoding.EncodeToString(publicKey),
	}, http.StatusCreated)
	postJSON(t, server.Handler(), "/v1/agents/agent-api/approve", map[string]any{}, http.StatusNoContent)

	challengeResponse := postJSON(t, server.Handler(), "/v1/agents/agent-api/challenge", map[string]any{}, http.StatusOK)
	var challenge struct {
		Nonce string `json:"nonce"`
	}
	decodeBody(t, challengeResponse, &challenge)
	nonce, err := base64.StdEncoding.DecodeString(challenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	authResponse := postJSON(t, server.Handler(), "/v1/agents/agent-api/authenticate", map[string]any{
		"signature": base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, nonce)),
	}, http.StatusOK)
	var auth struct {
		SessionToken string `json:"sessionToken"`
	}
	decodeBody(t, authResponse, &auth)
	if auth.SessionToken == "" {
		t.Fatal("expected session token")
	}

	capabilityResponse := postJSONWithAuth(t, server.Handler(), "/v1/agents/agent-api/capabilities/request", map[string]any{}, auth.SessionToken, http.StatusOK)
	var capabilityRequest struct {
		RequestID string `json:"requestId"`
		Nonce     string `json:"nonce"`
	}
	decodeBody(t, capabilityResponse, &capabilityRequest)
	postJSONWithAuth(t, server.Handler(), "/v1/agents/agent-api/capabilities", map[string]any{
		"requestId":    capabilityRequest.RequestID,
		"nonce":        capabilityRequest.Nonce,
		"capabilities": []string{"message.receive"},
	}, auth.SessionToken, http.StatusNoContent)

	taskResponse := postJSONWithAuth(t, server.Handler(), "/v1/commands", map[string]any{
		"messageId":     "message-api-1",
		"taskId":        "task-api-1",
		"correlationId": "correlation-api-1",
		"sourceAgentId": "agent-api",
		"targetAgentId": "agent-api",
		"type":          "task.assign",
		"expiresAt":     time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"payload":       map[string]any{"instruction": "run tests"},
	}, auth.SessionToken, http.StatusAccepted)
	var task messaging.Task
	decodeBody(t, taskResponse, &task)
	if task.State != messaging.StateAccepted {
		t.Fatalf("expected accepted task, got %+v", task)
	}

	statusResponse := getWithAuth(t, server.Handler(), "/v1/tasks/task-api-1", auth.SessionToken, http.StatusOK)
	var status messaging.Task
	decodeBody(t, statusResponse, &status)
	if status.TaskID != "task-api-1" || status.State != messaging.StateAccepted {
		t.Fatalf("unexpected task status: %+v", status)
	}
}

func postJSON(t *testing.T, handler http.Handler, path string, body any, expectedStatus int) *httptest.ResponseRecorder {
	return postJSONWithAuth(t, handler, path, body, "", expectedStatus)
}

func postJSONWithAuth(t *testing.T, handler http.Handler, path string, body any, token string, expectedStatus int) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("POST %s: expected %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	return response
}

func getWithAuth(t *testing.T, handler http.Handler, path, token string, expectedStatus int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("GET %s: expected %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	return response
}

func get(t *testing.T, handler http.Handler, path string, expectedStatus int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("GET %s: expected %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	return response
}

func decodeBody(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatal(err)
	}
}
