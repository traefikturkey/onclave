package messaging

import (
	"context"
	"testing"
	"time"
)

type recordingPublisher struct {
	envelopes []Envelope
	err       error
}

func (publisher *recordingPublisher) Publish(_ context.Context, envelope Envelope) error {
	if publisher.err != nil {
		return publisher.err
	}
	publisher.envelopes = append(publisher.envelopes, envelope)
	return nil
}

func TestSubmitPublishesDurableCommandEnvelope(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	publisher := &recordingPublisher{}
	service := NewServiceWithPublisher(func() time.Time { return now }, publisher)

	_, err := service.Submit(Command{
		MessageID: "message-1", TaskID: "task-1", CorrelationID: "correlation-1",
		SourceAgentID: "source", TargetAgentID: "target", Type: "task.assign",
		ExpiresAt: now.Add(time.Hour), Payload: map[string]any{"instruction": "build"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.envelopes) != 1 {
		t.Fatalf("expected one published envelope, got %d", len(publisher.envelopes))
	}
	envelope := publisher.envelopes[0]
	if envelope.RoutingKey != "task.assign.target" || !envelope.Persistent || envelope.TaskID != "task-1" {
		t.Fatalf("unexpected envelope: %+v", envelope)
	}
}
