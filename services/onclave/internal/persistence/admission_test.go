package persistence

import (
	"crypto/ed25519"
	"testing"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
)

func TestAdmissionStateSurvivesStoreReopen(t *testing.T) {
	path := t.TempDir() + "/onclave.db"
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	service, err := admission.NewServiceWithStore(admission.Policy{AllowedCapabilities: map[string]map[string]bool{
		"reference": {"message.receive": true},
	}}, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Enroll(admission.EnrollmentRequest{AgentID: "agent-persisted", RuntimeType: "reference", PublicKey: publicKey}); err != nil {
		t.Fatal(err)
	}
	if err := service.Approve("agent-persisted"); err != nil {
		t.Fatal(err)
	}
	nonce, err := service.IssueChallenge("agent-persisted")
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.AuthenticateSession("agent-persisted", ed25519.Sign(privateKey, nonce))
	if err != nil {
		t.Fatal(err)
	}
	requestID, capabilityNonce, err := service.RequestCapabilities("agent-persisted")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AcceptCapabilities("agent-persisted", requestID, capabilityNonce, []string{"message.receive", "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restarted, err := admission.NewServiceWithStore(admission.Policy{AllowedCapabilities: map[string]map[string]bool{
		"reference": {"message.receive": true},
	}}, reopened)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.AuthorizeSession("agent-persisted", token); err != nil {
		t.Fatalf("persisted session was not authorized: %v", err)
	}
	capabilities, err := restarted.EffectiveCapabilities("agent-persisted")
	if err != nil {
		t.Fatal(err)
	}
	if len(capabilities) != 1 || capabilities[0] != "message.receive" {
		t.Fatalf("unexpected persisted effective capabilities: %v", capabilities)
	}
}
