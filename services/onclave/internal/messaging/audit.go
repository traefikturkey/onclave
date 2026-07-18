package messaging

import "time"

type AuditEvent struct {
	EventID        string         `json:"eventId"`
	Type           string         `json:"type"`
	At             time.Time      `json:"at"`
	ActorAgentID   string         `json:"actorAgentId,omitempty"`
	MessageID      string         `json:"messageId,omitempty"`
	TaskID         string         `json:"taskId,omitempty"`
	SubscriptionID string         `json:"subscriptionId,omitempty"`
	Details        map[string]any `json:"details,omitempty"`
}

type AuditStore interface {
	RecordAudit(AuditEvent) error
}

func (s *Service) audit(event AuditEvent) error {
	store, ok := s.store.(AuditStore)
	if !ok {
		return nil
	}
	if event.At.IsZero() {
		event.At = s.now().UTC()
	}
	return store.RecordAudit(event)
}
