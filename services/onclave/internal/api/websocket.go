package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

type agentSubscriber interface {
	SubscribeAgent(context.Context, string, messaging.DeliveryHandler) (*messaging.Subscription, error)
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
	var writeMu sync.Mutex
	write := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeWebSocketJSON(ctx, connection, value)
	}

	if err := write(map[string]string{"type": "session.ready", "agentId": agentID}); err != nil {
		return
	}
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
		if err := json.Unmarshal(payload, &message); err != nil {
			_ = write(map[string]string{"type": "error", "error": "invalid JSON message"})
			continue
		}
		switch message.Type {
		case "heartbeat":
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
