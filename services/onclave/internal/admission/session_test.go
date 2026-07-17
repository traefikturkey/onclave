package admission

import (
	"crypto/ed25519"
	"testing"
)

func TestAuthenticatedSessionTokenAuthorizesAgentOperations(t *testing.T) {
	service, privateKey := approvedService(t, "agent-session")
	nonce, err := service.IssueChallenge("agent-session")
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.AuthenticateSession("agent-session", ed25519.Sign(privateKey, nonce))
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("expected non-empty session token")
	}
	if err := service.AuthorizeSession("agent-session", token); err != nil {
		t.Fatal(err)
	}
	if err := service.AuthorizeSession("agent-session", "wrong-token"); err != ErrInvalidSession {
		t.Fatalf("expected ErrInvalidSession, got %v", err)
	}
	if err := service.Revoke("agent-session"); err != nil {
		t.Fatal(err)
	}
	if err := service.AuthorizeSession("agent-session", token); err != ErrRevoked {
		t.Fatalf("expected ErrRevoked, got %v", err)
	}
}
