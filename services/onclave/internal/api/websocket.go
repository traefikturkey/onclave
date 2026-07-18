package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

type agentSubscriber interface {
	SubscribeAgent(context.Context, string, messaging.DeliveryHandler) (*messaging.Subscription, error)
}

type eventSubscriber interface {
	SubscribeEvents(context.Context, string, string, messaging.DeliveryHandler) (*messaging.Subscription, error)
}

func (s *Server) agentSession(writer http.ResponseWriter, request *http.Request) {
	agentID := request.PathValue("agentID")
	if !s.authorizeRequest(request, agentID) {
		writeError(writer, http.StatusUnauthorized, "Bearer session token required")
		return
	}
	connection, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "session closed")

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	sessionToken := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	var writeMu sync.Mutex
	write := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeWebSocketJSON(ctx, connection, value)
	}
	connection.SetReadLimit(1 << 20)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				writeMu.Lock()
				err := connection.Ping(ctx)
				writeMu.Unlock()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	if err := write(map[string]string{"type": "session.ready", "agentId": agentID}); err != nil {
		return
	}
	var storedEventSubscription *messaging.StoredSubscription
	var subscription *messaging.Subscription
	if s.subscriber != nil {
		subscription, err = s.subscriber.SubscribeAgent(ctx, agentID, func(envelope messaging.Envelope) error {
			return write(map[string]any{
				"type":          "command.delivery",
				"messageId":     envelope.MessageID,
				"taskId":        envelope.TaskID,
				"correlationId": envelope.CorrelationID,
				"sourceAgentId": envelope.SourceAgentID,
				"targetAgentId": envelope.TargetAgentID,
				"messageType":   envelope.MessageType,
				"issuedAt":      envelope.IssuedAt,
				"expiresAt":     envelope.ExpiresAt,
				"payload":       json.RawMessage(envelope.Payload),
			})
		})
		if err != nil {
			_ = write(map[string]string{"type": "error", "error": "agent queue unavailable"})
			return
		}
		defer subscription.Close()
	}
	if s.events != nil {
		pattern, filters, patternErr := s.resolveEventSubscription(request, agentID)
		if patternErr != nil {
			_ = write(errMessage(patternErr, "event.subscription.invalid"))
			return
		}
		if subscriptionID := request.URL.Query().Get("subscriptionId"); subscriptionID != "" {
			stored, err := s.messaging.GetSubscription(subscriptionID)
			if err != nil || stored.AgentID != agentID {
				if err == nil {
					err = errors.New("agent is not authorized for this subscription")
				}
				_ = write(errMessage(err, "event.subscription.invalid"))
				return
			}
			storedEventSubscription = &stored
			pattern = stored.Pattern
			filters = eventSubscriptionFilter{correlationID: stored.CorrelationID, taskID: stored.TaskID}
			if stored.TaskID != "" {
				for _, event := range s.messaging.EventsAfter(stored.TaskID, stored.Cursor) {
					if err := write(map[string]any{
						"type": "task.event", "taskId": event.TaskID, "messageType": event.Type,
						"issuedAt": event.At, "payload": event.Payload, "progress": event.Progress, "note": event.Note,
					}); err != nil {
						return
					}
					stored.Cursor++
				}
				if _, err := s.messaging.UpdateSubscriptionCursor(stored.SubscriptionID, agentID, stored.Cursor); err != nil {
					_ = write(errMessage(err, "event.subscription.cursor.failed"))
					return
				}
			} else {
				for _, event := range s.messaging.GlobalEventsAfter(int64(stored.Cursor)) {
					if err := write(map[string]any{
						"type": "task.event", "sequence": event.Sequence, "taskId": event.TaskID, "messageType": event.Type,
						"issuedAt": event.At, "payload": event.Payload, "progress": event.Progress, "note": event.Note,
					}); err != nil {
						return
					}
					stored.Cursor = int(event.Sequence)
				}
				if _, err := s.messaging.UpdateSubscriptionCursor(stored.SubscriptionID, agentID, stored.Cursor); err != nil {
					_ = write(errMessage(err, "event.subscription.cursor.failed"))
					return
				}
			}
		}
		eventSubscription, eventErr := s.events.SubscribeEvents(ctx, "agent-events-"+agentID, pattern, func(envelope messaging.Envelope) error {
			if filters.correlationID != "" && envelope.CorrelationID != filters.correlationID {
				return nil
			}
			if filters.taskID != "" && envelope.TaskID != filters.taskID {
				return nil
			}
			if err := write(map[string]any{
				"type":          "task.event",
				"messageId":     envelope.MessageID,
				"taskId":        envelope.TaskID,
				"correlationId": envelope.CorrelationID,
				"sourceAgentId": envelope.SourceAgentID,
				"targetAgentId": envelope.TargetAgentID,
				"messageType":   envelope.MessageType,
				"issuedAt":      envelope.IssuedAt,
				"expiresAt":     envelope.ExpiresAt,
				"payload":       json.RawMessage(envelope.Payload),
			}); err != nil {
				return err
			}
			if storedEventSubscription != nil && (storedEventSubscription.TaskID == "" || storedEventSubscription.TaskID == envelope.TaskID) {
				sequence := int64(storedEventSubscription.Cursor + 1)
				var eventPayload struct {
					Sequence int64 `json:"sequence"`
				}
				if json.Unmarshal(envelope.Payload, &eventPayload) == nil && eventPayload.Sequence > 0 {
					sequence = eventPayload.Sequence
				}
				storedEventSubscription.Cursor = int(sequence)
				if _, err := s.messaging.UpdateSubscriptionCursor(storedEventSubscription.SubscriptionID, agentID, storedEventSubscription.Cursor); err != nil {
					return err
				}
			}
			return nil
		})
		if eventErr != nil {
			_ = write(map[string]string{"type": "error", "error": "event queue unavailable"})
			return
		}
		defer eventSubscription.Close()
	}

	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			return
		}
		var message struct {
			Type     string         `json:"type"`
			TaskID   string         `json:"taskId,omitempty"`
			Progress int            `json:"progress,omitempty"`
			Note     string         `json:"note,omitempty"`
			Result   map[string]any `json:"result,omitempty"`
		}
		if messageErr := json.Unmarshal(payload, &message); messageErr != nil {
			_ = write(map[string]string{"type": "error", "error": "invalid JSON message"})
			continue
		}
		if message.TaskID != "" && message.Type != "heartbeat" {
			if taskErr := s.authorizeTaskAgent(agentID, message.TaskID, message.Type == "task.cancelled"); taskErr != nil {
				if write(errMessage(taskErr, "task.authorization.failed")) != nil {
					return
				}
				continue
			}
		}
		switch message.Type {
		case "heartbeat":
			if err := s.admission.RenewSession(agentID, sessionToken); err != nil {
				_ = write(errMessage(err, "session.renew.failed"))
				return
			}
			if err := write(map[string]string{"type": "heartbeat.ack"}); err != nil {
				return
			}
		case "task.ack":
			if err := s.messaging.Acknowledge(message.TaskID); err != nil {
				if write(errMessage(err, "task.ack.failed")) != nil {
					return
				}
				continue
			}
			if err := write(map[string]string{"type": "task.acknowledged", "taskId": message.TaskID}); err != nil {
				return
			}
		case "task.started":
			if err := s.messaging.Start(message.TaskID); err != nil {
				if write(errMessage(err, "task.start.failed")) != nil {
					return
				}
				continue
			}
		case "task.progress":
			if err := s.messaging.Progress(message.TaskID, message.Progress, message.Note); err != nil {
				if write(errMessage(err, "task.progress.failed")) != nil {
					return
				}
				continue
			}
		case "task.completed":
			if err := s.messaging.Complete(message.TaskID, message.Result); err != nil {
				if write(errMessage(err, "task.complete.failed")) != nil {
					return
				}
				continue
			}
		case "task.failed":
			if err := s.messaging.Fail(message.TaskID, message.Result); err != nil {
				if write(errMessage(err, "task.fail.failed")) != nil {
					return
				}
				continue
			}
		case "task.cancelled":
			if err := s.messaging.Cancel(message.TaskID); err != nil {
				if write(errMessage(err, "task.cancel.failed")) != nil {
					return
				}
				continue
			}
		default:
			if err := write(map[string]string{"type": "error", "error": "unsupported session message"}); err != nil {
				return
			}
		}
	}
}

var errTaskNotAuthorized = errors.New("agent is not authorized for this task")

func (s *Server) authorizeTaskAgent(agentID, taskID string, allowSource bool) error {
	if s.messaging == nil {
		return errors.New("messaging service unavailable")
	}
	task, err := s.messaging.Status(taskID)
	if err != nil {
		return err
	}
	if agentID != task.TargetAgentID && (!allowSource || agentID != task.SourceAgentID) {
		return errTaskNotAuthorized
	}
	return nil
}

func errMessage(err error, messageType string) map[string]string {
	return map[string]string{"type": messageType, "error": err.Error()}
}

func (s *Server) authorizeRequest(request *http.Request, agentID string) bool {
	if s.admission == nil {
		return false
	}
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if len(authorization) <= len(prefix) || authorization[:len(prefix)] != prefix {
		return false
	}
	return s.admission.AuthorizeSession(agentID, authorization[len(prefix):]) == nil
}

func writeWebSocketJSON(ctx context.Context, connection *websocket.Conn, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return connection.Write(ctx, websocket.MessageText, payload)
}

func (s *Server) resolveEventSubscription(request *http.Request, agentID string) (string, eventSubscriptionFilter, error) {
	pattern, err := eventSubscriptionPattern(request, agentID)
	if err != nil {
		return "", eventSubscriptionFilter{}, err
	}
	filters, err := eventSubscriptionFilters(request)
	if err != nil {
		return "", eventSubscriptionFilter{}, err
	}
	return pattern, filters, nil
}

func eventSubscriptionPattern(request *http.Request, agentID string) (string, error) {
	pattern := request.URL.Query().Get("events")
	if pattern == "" {
		return "task.*." + agentID, nil
	}
	if !strings.HasPrefix(pattern, "task.") || !strings.HasSuffix(pattern, "."+agentID) {
		return "", errors.New("event pattern must target the authenticated agent")
	}
	eventName := strings.TrimSuffix(strings.TrimPrefix(pattern, "task."), "."+agentID)
	if eventName == "*" {
		return pattern, nil
	}
	switch eventName {
	case "accepted", "acknowledged", "started", "progress", "completed", "failed", "cancelled", "expired":
		return pattern, nil
	default:
		return "", errors.New("event pattern contains an unsupported task event")
	}
}

type eventSubscriptionFilter struct {
	correlationID string
	taskID        string
}

func eventSubscriptionFilters(request *http.Request) (eventSubscriptionFilter, error) {
	filters := eventSubscriptionFilter{
		correlationID: request.URL.Query().Get("correlationId"),
		taskID:        request.URL.Query().Get("taskId"),
	}
	for name, value := range map[string]string{"correlationId": filters.correlationID, "taskId": filters.taskID} {
		if value == "" {
			continue
		}
		if strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n") {
			return eventSubscriptionFilter{}, fmt.Errorf("event filter %s is invalid", name)
		}
	}
	return filters, nil
}
