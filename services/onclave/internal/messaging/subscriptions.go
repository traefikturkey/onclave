package messaging

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrSubscriptionStoreUnavailable = errors.New("subscription store unavailable")
	ErrSubscriptionNotFound         = errors.New("subscription not found")
	ErrSubscriptionExpired          = errors.New("subscription has expired")
	ErrSubscriptionUnauthorized     = errors.New("agent is not authorized for this subscription")
	ErrInvalidSubscription          = errors.New("invalid subscription")
)

type StoredSubscription struct {
	SubscriptionID string    `json:"subscriptionId"`
	AgentID        string    `json:"agentId"`
	Pattern        string    `json:"pattern"`
	CorrelationID  string    `json:"correlationId,omitempty"`
	TaskID         string    `json:"taskId,omitempty"`
	Cursor         int       `json:"cursor"`
	CreatedAt      time.Time `json:"createdAt"`
	ExpiresAt      time.Time `json:"expiresAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type SubscriptionStore interface {
	SaveSubscription(StoredSubscription) error
	GetSubscription(string) (StoredSubscription, error)
	DeleteSubscription(string) error
	DeleteExpiredSubscriptions(time.Time) error
}

func (s *Service) subscriptionStore() (SubscriptionStore, error) {
	store, ok := s.store.(SubscriptionStore)
	if !ok {
		return nil, ErrSubscriptionStoreUnavailable
	}
	return store, nil
}

func (s *Service) CreateSubscription(agentID, pattern, correlationID, taskID string, expiresAt time.Time) (StoredSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, err := s.subscriptionStore()
	if err != nil {
		return StoredSubscription{}, err
	}
	if err := validateSubscriptionPattern(agentID, pattern); err != nil {
		return StoredSubscription{}, err
	}
	if strings.TrimSpace(correlationID) != correlationID || strings.TrimSpace(taskID) != taskID {
		return StoredSubscription{}, fmt.Errorf("%w: filter contains surrounding whitespace", ErrInvalidSubscription)
	}
	now := s.now().UTC()
	if !expiresAt.After(now) {
		return StoredSubscription{}, ErrSubscriptionExpired
	}
	id, err := newSubscriptionID()
	if err != nil {
		return StoredSubscription{}, fmt.Errorf("create subscription ID: %w", err)
	}
	subscription := StoredSubscription{
		SubscriptionID: id, AgentID: agentID, Pattern: pattern,
		CorrelationID: correlationID, TaskID: taskID, CreatedAt: now,
		ExpiresAt: expiresAt.UTC(), UpdatedAt: now,
	}
	if err := store.SaveSubscription(subscription); err != nil {
		return StoredSubscription{}, fmt.Errorf("persist subscription: %w", err)
	}
	if err := s.audit(AuditEvent{Type: "subscription.created", ActorAgentID: agentID, SubscriptionID: subscription.SubscriptionID, Details: map[string]any{"pattern": pattern}}); err != nil {
		return StoredSubscription{}, err
	}
	return subscription, nil
}

func (s *Service) GetSubscription(subscriptionID string) (StoredSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, err := s.subscriptionStore()
	if err != nil {
		return StoredSubscription{}, err
	}
	subscription, err := store.GetSubscription(subscriptionID)
	if err != nil {
		return StoredSubscription{}, err
	}
	if !s.now().Before(subscription.ExpiresAt) {
		if deleteErr := store.DeleteSubscription(subscriptionID); deleteErr != nil {
			return StoredSubscription{}, fmt.Errorf("expire subscription: %w", deleteErr)
		}
		return StoredSubscription{}, ErrSubscriptionExpired
	}
	return subscription, nil
}

func (s *Service) RenewSubscription(subscriptionID, agentID string, expiresAt time.Time) (StoredSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, err := s.subscriptionStore()
	if err != nil {
		return StoredSubscription{}, err
	}
	subscription, err := store.GetSubscription(subscriptionID)
	if err != nil {
		return StoredSubscription{}, err
	}
	if subscription.AgentID != agentID {
		return StoredSubscription{}, ErrSubscriptionUnauthorized
	}
	now := s.now().UTC()
	if !now.Before(subscription.ExpiresAt) || !expiresAt.After(now) {
		return StoredSubscription{}, ErrSubscriptionExpired
	}
	subscription.ExpiresAt = expiresAt.UTC()
	subscription.UpdatedAt = now
	if err := store.SaveSubscription(subscription); err != nil {
		return StoredSubscription{}, fmt.Errorf("persist subscription renewal: %w", err)
	}
	if err := s.audit(AuditEvent{Type: "subscription.renewed", ActorAgentID: agentID, SubscriptionID: subscription.SubscriptionID, Details: map[string]any{"expiresAt": subscription.ExpiresAt}}); err != nil {
		return StoredSubscription{}, err
	}
	return subscription, nil
}

func (s *Service) UpdateSubscriptionCursor(subscriptionID, agentID string, cursor int) (StoredSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, err := s.subscriptionStore()
	if err != nil {
		return StoredSubscription{}, err
	}
	subscription, err := store.GetSubscription(subscriptionID)
	if err != nil {
		return StoredSubscription{}, err
	}
	if subscription.AgentID != agentID {
		return StoredSubscription{}, ErrSubscriptionUnauthorized
	}
	if !s.now().Before(subscription.ExpiresAt) {
		return StoredSubscription{}, ErrSubscriptionExpired
	}
	if cursor < subscription.Cursor {
		return StoredSubscription{}, fmt.Errorf("%w: cursor cannot move backwards", ErrInvalidSubscription)
	}
	subscription.Cursor = cursor
	subscription.UpdatedAt = s.now().UTC()
	if err := store.SaveSubscription(subscription); err != nil {
		return StoredSubscription{}, fmt.Errorf("persist subscription cursor: %w", err)
	}
	if err := s.audit(AuditEvent{Type: "subscription.cursor.updated", ActorAgentID: agentID, SubscriptionID: subscription.SubscriptionID, Details: map[string]any{"cursor": cursor}}); err != nil {
		return StoredSubscription{}, err
	}
	return subscription, nil
}

func (s *Service) DeleteSubscription(subscriptionID, agentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, err := s.subscriptionStore()
	if err != nil {
		return err
	}
	subscription, err := store.GetSubscription(subscriptionID)
	if err != nil {
		return err
	}
	if subscription.AgentID != agentID {
		return ErrSubscriptionUnauthorized
	}
	if err := store.DeleteSubscription(subscriptionID); err != nil {
		return fmt.Errorf("delete subscription: %w", err)
	}
	if err := s.audit(AuditEvent{Type: "subscription.deleted", ActorAgentID: agentID, SubscriptionID: subscriptionID}); err != nil {
		return err
	}
	return nil
}

func (s *Service) ExpireSubscriptions() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	store, err := s.subscriptionStore()
	if err != nil {
		if errors.Is(err, ErrSubscriptionStoreUnavailable) {
			return nil
		}
		return err
	}
	return store.DeleteExpiredSubscriptions(s.now().UTC())
}

func validateSubscriptionPattern(agentID, pattern string) error {
	if strings.TrimSpace(agentID) != agentID || agentID == "" {
		return fmt.Errorf("%w: agent ID is required", ErrInvalidSubscription)
	}
	if strings.TrimSpace(pattern) != pattern || !strings.HasPrefix(pattern, "task.") || !strings.HasSuffix(pattern, "."+agentID) {
		return fmt.Errorf("%w: pattern must target the authenticated agent", ErrInvalidSubscription)
	}
	eventName := strings.TrimSuffix(strings.TrimPrefix(pattern, "task."), "."+agentID)
	switch eventName {
	case "*", "accepted", "acknowledged", "started", "progress", "completed", "failed", "cancelled", "expired":
		return nil
	default:
		return fmt.Errorf("%w: unsupported task event", ErrInvalidSubscription)
	}
}

func newSubscriptionID() (string, error) {
	var value [12]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return "sub-" + hex.EncodeToString(value[:]), nil
}
