package admission

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"sort"
	"sync"
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
	AgentID    string
	RuntimeType string
	PublicKey  ed25519.PublicKey
}

type Policy struct {
	AllowedCapabilities map[string]map[string]bool
}

type record struct {
	agentID             string
	runtimeType         string
	publicKey           ed25519.PublicKey
	status              Status
	challenge           []byte
	capabilityRequestID string
	capabilityNonce     string
	declared            []string
	effective           []string
}

type Service struct {
	mu      sync.Mutex
	policy  Policy
	agents  map[string]*record
	counter uint64
}

func NewService(policy Policy) *Service {
	return &Service{policy: policy, agents: make(map[string]*record)}
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
	s.agents[request.AgentID] = &record{
		agentID:     request.AgentID,
		runtimeType: request.RuntimeType,
		publicKey:   append(ed25519.PublicKey(nil), request.PublicKey...),
		status:      StatusEnrollmentPending,
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
	return nil
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
	return nil
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
	return append([]byte(nil), nonce...), nil
}

func (s *Service) Authenticate(agentID string, signature []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return err
	}
	if agent.status == StatusRevoked {
		return ErrRevoked
	}
	if len(agent.challenge) == 0 {
		return ErrChallengeConsumed
	}
	challenge := agent.challenge
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(agent.publicKey, challenge, signature) {
		return ErrInvalidSignature
	}
	agent.challenge = nil
	agent.status = StatusAuthenticated
	return nil
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
	return nil
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

func (s *Service) Status(agentID string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, err := s.agent(agentID)
	if err != nil {
		return "", err
	}
	return agent.status, nil
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
