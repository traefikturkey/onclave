package admission

import (
	"crypto/ed25519"
	"testing"
	"time"
)

func TestEnrollmentRequiresApprovalBeforeAuthentication(t *testing.T) {
	service := NewService(Policy{AllowedCapabilities: map[string]map[string]bool{
		"reference": {"message.receive": true},
	}})
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := service.Enroll(EnrollmentRequest{
		AgentID: "agent-1", RuntimeType: "reference", PublicKey: publicKey,
	}); err != nil {
		t.Fatal(err)
	}
	nonce, err := service.IssueChallenge("agent-1")
	if err != ErrNotApproved {
		t.Fatalf("expected ErrNotApproved, got %v", err)
	}
	if nonce != nil {
		t.Fatal("expected no challenge for unapproved agent")
	}

	if err := service.Approve("agent-1"); err != nil {
		t.Fatal(err)
	}
	nonce, err = service.IssueChallenge("agent-1")
	if err != nil || len(nonce) == 0 {
		t.Fatalf("expected challenge after approval, nonce=%x err=%v", nonce, err)
	}
	if err := service.Authenticate("agent-1", ed25519.Sign(privateKey, nonce)); err != nil {
		t.Fatal(err)
	}
}

func TestAuthenticationRejectsReplayAndWrongSignature(t *testing.T) {
	service, privateKey := approvedService(t, "agent-2")
	nonce, err := service.IssueChallenge("agent-2")
	if err != nil {
		t.Fatal(err)
	}
	wrongSignature := make([]byte, ed25519.SignatureSize)
	if err := service.Authenticate("agent-2", wrongSignature); err != ErrInvalidSignature {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
	if err := service.Authenticate("agent-2", ed25519.Sign(privateKey, nonce)); err != nil {
		t.Fatal(err)
	}
	if err := service.Authenticate("agent-2", ed25519.Sign(privateKey, nonce)); err != ErrChallengeConsumed {
		t.Fatalf("expected ErrChallengeConsumed, got %v", err)
	}
}

func TestCapabilityDeclarationIsNonceBoundAndPolicyFiltered(t *testing.T) {
	service, privateKey := approvedService(t, "agent-3")
	nonce, err := service.IssueChallenge("agent-3")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Authenticate("agent-3", ed25519.Sign(privateKey, nonce)); err != nil {
		t.Fatal(err)
	}
	requestID, capabilityNonce, err := service.RequestCapabilities("agent-3")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AcceptCapabilities("agent-3", requestID, "wrong", []string{"message.receive"}); err != ErrCapabilityNonceMismatch {
		t.Fatalf("expected ErrCapabilityNonceMismatch, got %v", err)
	}
	if err := service.AcceptCapabilities("agent-3", requestID, capabilityNonce, []string{"message.receive", "admin.shutdown"}); err != nil {
		t.Fatal(err)
	}
	capabilities, err := service.EffectiveCapabilities("agent-3")
	if err != nil {
		t.Fatal(err)
	}
	if len(capabilities) != 1 || capabilities[0] != "message.receive" {
		t.Fatalf("unexpected effective capabilities: %#v", capabilities)
	}
}

func TestRevokedAgentCannotAuthenticateOrUseCapabilities(t *testing.T) {
	service, privateKey := approvedService(t, "agent-4")
	if err := service.Revoke("agent-4"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.IssueChallenge("agent-4"); err != ErrRevoked {
		t.Fatalf("expected ErrRevoked, got %v", err)
	}
	_ = privateKey
}

func approvedService(t *testing.T, agentID string) (*Service, ed25519.PrivateKey) {
	t.Helper()
	service := NewService(Policy{AllowedCapabilities: map[string]map[string]bool{
		"reference": {"message.receive": true},
	}})
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Enroll(EnrollmentRequest{AgentID: agentID, RuntimeType: "reference", PublicKey: publicKey}); err != nil {
		t.Fatal(err)
	}
	if err := service.Approve(agentID); err != nil {
		t.Fatal(err)
	}
	return service, privateKey
}

func TestSessionLeaseExpires(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service, err := NewServiceWithStoreAndClock(Policy{SessionTTL: time.Hour}, nil, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Enroll(EnrollmentRequest{AgentID: "lease-agent", RuntimeType: "reference", PublicKey: publicKey}); err != nil {
		t.Fatal(err)
	}
	if err := service.Approve("lease-agent"); err != nil {
		t.Fatal(err)
	}
	nonce, err := service.IssueChallenge("lease-agent")
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.AuthenticateSession("lease-agent", ed25519.Sign(privateKey, nonce))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AuthorizeSession("lease-agent", token); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	if err := service.AuthorizeSession("lease-agent", token); err != ErrInvalidSession {
		t.Fatalf("expected expired session, got %v", err)
	}
}
