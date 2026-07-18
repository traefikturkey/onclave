package admission

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	ErrAlreadyEnrolled          = errors.New("agent is already enrolled")
	ErrUnknownAgent             = errors.New("unknown agent")
	ErrNotApproved              = errors.New("agent is not approved")
	ErrRevoked                  = errors.New("agent is revoked")
	ErrInvalidSignature         = errors.New("invalid authentication signature")
	ErrChallengeConsumed        = errors.New("authentication challenge is missing or already consumed")
	ErrNotAuthenticated         = errors.New("agent is not authenticated")
	ErrCapabilityRequestMissing = errors.New("capability request is missing or already consumed")
	ErrCapabilityNonceMismatch  = errors.New("capability nonce does not match request")
	ErrCapabilityNotGranted     = errors.New("required capability is not granted")
	ErrInvalidSession           = errors.New("invalid agent session")
)

type Status string

const (
	StatusEnrollmentPending Status = "enrollment_pending"
	StatusApproved          Status = "approved"
	StatusAuthenticated     Status = "authenticated"
	StatusRegistered        Status = "registered"
	StatusRevoked           Status = "revoked"
)

type EnrollmentRequest struct {
	AgentID     string
	RuntimeType string
	PublicKey   ed25519.PublicKey
}

type Policy struct {
	AllowedCapabilities map[string]map[string]bool
	SessionTTL          time.Duration
}

type Snapshot struct {
	AgentID             string
	RuntimeType         string
	PublicKey           []byte
	Status              Status
	Challenge           []byte
	CapabilityRequestID string
	CapabilityNonce     string
	SessionToken        string
	SessionExpiresAt    string
	Declared            []string
	Effective           []string
}

type Store interface {
	LoadAdmissionAgents() ([]Snapshot, error)
	SaveAdmissionAgent(Snapshot) error
}

type record struct {
	agentID             string
	runtimeType         string
	publicKey           ed25519.PublicKey
	status              Status
	challenge           []byte
	capabilityRequestID string
	capabilityNonce     string
	sessionToken        string
	sessionExpiresAt    time.Time
	declared            []string
	effective           []string
}

type Service struct {
	mu      sync.Mutex
	policy  Policy
	agents  map[string]*record
	counter uint64
	store   Store
	now     func() time.Time
}

func NewService(policy Policy) *Service {
	service, err := NewServiceWithStore(policy, nil)
	if err != nil {
		panic(err)
	}
	return service
}

func NewServiceWithStore(policy Policy, store Store) (*Service, error) {
	return NewServiceWithStoreAndClock(policy, store, time.Now)
}

func NewServiceWithStoreAndClock(policy Policy, store Store, now func() time.Time) (*Service, error) {
	if now == nil {
		now = time.Now
	}
	service := &Service{policy: policy, agents: make(map[string]*record), store: store, now: now}
	if store != nil {
		snapshots, err := store.LoadAdmissionAgents()
		if err != nil {
			return nil, fmt.Errorf("load admission state: %w", err)
		}
		for _, snapshot := range snapshots {
			service.agents[snapshot.AgentID] = recordFromSnapshot(snapshot)
		}
	}
	return service, nil
}

func (s *Service) Enroll(request EnrollmentRequest) error {
	if request.AgentID == "" || request.RuntimeType == "" || len(request.PublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid enrollment request")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.agents[request.AgentID]; exists {
		return ErrAlreadyEnrolled
	}
	agent := &record{
		agentID:     request.AgentID,
		runtimeType: request.RuntimeType,
		publicKey:   append(ed25519.PublicKey(nil), request.PublicKey...),
		status:      StatusEnrollmentPending,
	}
	s.agents[request.AgentID] = agent
	if err := s.save(agent); err != nil {
		delete(s.agents, request.AgentID)
		return fmt.Errorf("persist enrollment: %w", err)
	}
	return nil
}

func (s *Service) Approve(agentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	if agent.status == StatusRevoked {
		return ErrRevoked
	}
	agent.status = StatusApproved
	return s.save(agent)
}

func (s *Service) Revoke(agentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	agent.status = StatusRevoked
	agent.challenge = nil
	agent.capabilityRequestID = ""
	agent.capabilityNonce = ""
	agent.sessionToken = ""
	agent.sessionExpiresAt = time.Time{}
	return s.save(agent)
}

func (s *Service) IssueChallenge(agentID string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return nil, err
	}
	if agent.status == StatusRevoked {
		return nil, ErrRevoked
	}
	if agent.status == StatusEnrollmentPending {
		return nil, ErrNotApproved
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate authentication challenge: %w", err)
	}
	agent.challenge = nonce
	if err := s.save(agent); err != nil {
		agent.challenge = nil
		return nil, fmt.Errorf("persist authentication challenge: %w", err)
	}
	return append([]byte(nil), nonce...), nil
}

func (s *Service) Authenticate(agentID string, signature []byte) error {
	_, err := s.AuthenticateSession(agentID, signature)
	return err
}

func (s *Service) AuthenticateSession(agentID string, signature []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return "", err
	}
	if agent.status == StatusRevoked {
		return "", ErrRevoked
	}
	if len(agent.challenge) == 0 {
		return "", ErrChallengeConsumed
	}
	challenge := agent.challenge
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(agent.publicKey, challenge, signature) {
		return "", ErrInvalidSignature
	}
	agent.challenge = nil
	agent.status = StatusAuthenticated
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	agent.sessionToken = base64.RawURLEncoding.EncodeToString(tokenBytes)
	if s.policy.SessionTTL > 0 {
		agent.sessionExpiresAt = s.now().Add(s.policy.SessionTTL)
	} else {
		agent.sessionExpiresAt = time.Time{}
	}
	if err := s.save(agent); err != nil {
		agent.sessionToken = ""
		agent.sessionExpiresAt = time.Time{}
		return "", fmt.Errorf("persist agent session: %w", err)
	}
	return agent.sessionToken, nil
}

func (s *Service) AuthorizeSession(agentID, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	if agent.status == StatusRevoked {
		return ErrRevoked
	}
	if agent.status != StatusAuthenticated && agent.status != StatusRegistered {
		return ErrNotAuthenticated
	}
	if token == "" || token != agent.sessionToken {
		return ErrInvalidSession
	}
	if !agent.sessionExpiresAt.IsZero() && !s.now().Before(agent.sessionExpiresAt) {
		return ErrInvalidSession
	}
	return nil
}

func (s *Service) RenewSession(agentID, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	if agent.status == StatusRevoked {
		return ErrRevoked
	}
	if agent.status != StatusAuthenticated && agent.status != StatusRegistered {
		return ErrNotAuthenticated
	}
	if token == "" || token != agent.sessionToken {
		return ErrInvalidSession
	}
	if !agent.sessionExpiresAt.IsZero() && !s.now().Before(agent.sessionExpiresAt) {
		return ErrInvalidSession
	}
	if s.policy.SessionTTL <= 0 {
		return nil
	}
	agent.sessionExpiresAt = s.now().Add(s.policy.SessionTTL)
	return s.save(agent)
}

func (s *Service) AgentForSession(token string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if token == "" {
		return "", ErrInvalidSession
	}
	for agentID, agent := range s.agents {
		if agent.sessionToken == token {
			if agent.status == StatusRevoked {
				return "", ErrRevoked
			}
			if !agent.sessionExpiresAt.IsZero() && !s.now().Before(agent.sessionExpiresAt) {
				return "", ErrInvalidSession
			}
			return agentID, nil
		}
	}
	return "", ErrInvalidSession
}

func (s *Service) RequestCapabilities(agentID string) (requestID, nonce string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return "", "", err
	}
	if agent.status == StatusRevoked {
		return "", "", ErrRevoked
	}
	if agent.status != StatusAuthenticated && agent.status != StatusRegistered {
		return "", "", ErrNotAuthenticated
	}
	s.counter++
	requestID = fmt.Sprintf("capability-request-%d", s.counter)
	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", "", fmt.Errorf("generate capability nonce: %w", err)
	}
	nonce = fmt.Sprintf("%x", nonceBytes)
	agent.capabilityRequestID = requestID
	agent.capabilityNonce = nonce
	if err := s.save(agent); err != nil {
		agent.capabilityRequestID = ""
		agent.capabilityNonce = ""
		return "", "", fmt.Errorf("persist capability request: %w", err)
	}
	return requestID, nonce, nil
}

func (s *Service) AcceptCapabilities(agentID, requestID, nonce string, capabilities []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	if agent.status == StatusRevoked {
		return ErrRevoked
	}
	if agent.status != StatusAuthenticated && agent.status != StatusRegistered {
		return ErrNotAuthenticated
	}
	if agent.capabilityRequestID == "" || agent.capabilityRequestID != requestID {
		return ErrCapabilityRequestMissing
	}
	if agent.capabilityNonce != nonce {
		return ErrCapabilityNonceMismatch
	}
	agent.capabilityRequestID = ""
	agent.capabilityNonce = ""
	agent.declared = uniqueSorted(capabilities)
	allowed := s.policy.AllowedCapabilities[agent.runtimeType]
	agent.effective = agent.effectiveCapabilities(allowed)
	agent.status = StatusRegistered
	return s.save(agent)
}

func (s *Service) EffectiveCapabilities(agentID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return nil, err
	}
	return append([]string(nil), agent.effective...), nil
}

func (s *Service) HasCapability(agentID, capability string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	for _, effective := range agent.effective {
		if effective == capability {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrCapabilityNotGranted, capability)
}

func (s *Service) Status(agentID string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return "", err
	}
	return agent.status, nil
}

func (s *Service) save(agent *record) error {
	if s.store == nil {
		return nil
	}
	return s.store.SaveAdmissionAgent(Snapshot{
		AgentID: agent.agentID, RuntimeType: agent.runtimeType, PublicKey: append([]byte(nil), agent.publicKey...),
		Status: agent.status, Challenge: append([]byte(nil), agent.challenge...),
		CapabilityRequestID: agent.capabilityRequestID, CapabilityNonce: agent.capabilityNonce,
		SessionToken: agent.sessionToken, SessionExpiresAt: formatSessionExpiry(agent.sessionExpiresAt),
		Declared: append([]string(nil), agent.declared...), Effective: append([]string(nil), agent.effective...),
	})
}

func recordFromSnapshot(snapshot Snapshot) *record {
	expiresAt, _ := time.Parse(time.RFC3339Nano, snapshot.SessionExpiresAt)
	return &record{
		agentID: snapshot.AgentID, runtimeType: snapshot.RuntimeType, publicKey: ed25519.PublicKey(append([]byte(nil), snapshot.PublicKey...)),
		status: snapshot.Status, challenge: append([]byte(nil), snapshot.Challenge...), capabilityRequestID: snapshot.CapabilityRequestID,
		capabilityNonce: snapshot.CapabilityNonce, sessionToken: snapshot.SessionToken, sessionExpiresAt: expiresAt,
		declared: append([]string(nil), snapshot.Declared...), effective: append([]string(nil), snapshot.Effective...),
	}
}

func formatSessionExpiry(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func (s *Service) agent(agentID string) (*record, error) {
	agent, ok := s.agents[agentID]
	if !ok {
		return nil, ErrUnknownAgent
	}
	return agent, nil
}

func (agent *record) effectiveCapabilities(allowed map[string]bool) []string {
	result := make([]string, 0, len(agent.declared))
	for _, capability := range agent.declared {
		if allowed[capability] {
			result = append(result, capability)
		}
	}
	return result
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
