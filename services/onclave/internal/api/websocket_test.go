package api

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func TestEventSubscriptionPatternIsAgentScoped(t *testing.T) {
	request := httptest.NewRequest("GET", "/v1/agents/agent-ws/session?events=task.completed.agent-ws", nil)
	pattern, err := eventSubscriptionPattern(request, "agent-ws")
	if err != nil || pattern != "task.completed.agent-ws" {
		t.Fatalf("expected valid scoped pattern, got %q, %v", pattern, err)
	}

	for _, rawQuery := range []string{"events=task.completed.other-agent", "events=agent.#", "events=task.unknown.agent-ws"} {
		request = httptest.NewRequest("GET", "/v1/agents/agent-ws/session?"+rawQuery, nil)
		if _, err := eventSubscriptionPattern(request, "agent-ws"); err == nil {
			t.Fatalf("expected pattern %q to be rejected", rawQuery)
		}
	}

	request = httptest.NewRequest("GET", "/v1/agents/agent-ws/session", nil)
	if pattern, err := eventSubscriptionPattern(request, "agent-ws"); err != nil || pattern != "task.*.agent-ws" {
		t.Fatalf("unexpected default pattern: %q, %v", pattern, err)
	}
}

func TestEventSubscriptionFiltersValidateStructuredValues(t *testing.T) {
	request := httptest.NewRequest("GET", "/session?correlationId=workflow-1&taskId=task-1", nil)
	filters, err := eventSubscriptionFilters(request)
	if err != nil || filters.correlationID != "workflow-1" || filters.taskID != "task-1" {
		t.Fatalf("unexpected event filters: %+v, %v", filters, err)
	}

	request = httptest.NewRequest("GET", "/session?taskId=%20task-1", nil)
	if _, err := eventSubscriptionFilters(request); err == nil {
		t.Fatal("expected whitespace-padded task filter to be rejected")
	}
}

func TestAuthenticatedWebSocketSessionSupportsHeartbeat(t *testing.T) {
	admissionService := admission.NewService(admission.Policy{})
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := admissionService.Enroll(admission.EnrollmentRequest{AgentID: "agent-ws", RuntimeType: "reference", PublicKey: publicKey}); err != nil {
		t.Fatal(err)
	}
	if err := admissionService.Approve("agent-ws"); err != nil {
		t.Fatal(err)
	}
	nonce, err := admissionService.IssueChallenge("agent-ws")
	if err != nil {
		t.Fatal(err)
	}
	token, err := admissionService.AuthenticateSession("agent-ws", ed25519.Sign(privateKey, nonce))
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(NewApplicationServer(Config{}, admissionService, messaging.NewService(time.Now), func() error { return nil }).Handler())
	defer server.Close()
	wsURL := "ws" + server.URL[len("http"):]
	wsURL = wsURL + "/v1/agents/agent-ws/session"
	header := make(map[string][]string)
	header["Authorization"] = []string{"Bearer " + token}
	conn, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	_, readyBytes, err := conn.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ready map[string]any
	if err := json.Unmarshal(readyBytes, &ready); err != nil {
		t.Fatal(err)
	}
	if ready["type"] != "session.ready" || ready["agentId"] != "agent-ws" {
		t.Fatalf("unexpected ready message: %#v", ready)
	}

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"heartbeat"}`)); err != nil {
		t.Fatal(err)
	}
	_, heartbeatBytes, err := conn.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var heartbeat map[string]any
	if err := json.Unmarshal(heartbeatBytes, &heartbeat); err != nil {
		t.Fatal(err)
	}
	if heartbeat["type"] != "heartbeat.ack" {
		t.Fatalf("unexpected heartbeat response: %#v", heartbeat)
	}

}
