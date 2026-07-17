package admission

import (
	"crypto/ed25519"
	"testing"
)

func TestSessionTokenResolvesToItsAgent(t *testing.T) {
	service, privateKey := approvedService(t, "agent-resolve")
	nonce, err := service.IssueChallenge("agent-resolve")
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.AuthenticateSession("agent-resolve", ed25519.Sign(privateKey, nonce))
	if err != nil {
		t.Fatal(err)
	}
	agentID, err := service.AgentForSession(token)
	if err != nil || agentID != "agent-resolve" {
		t.Fatalf("unexpected session owner: %q, %v", agentID, err)
	}
}
