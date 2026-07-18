package messaging

import (
	"context"
	"testing"
	"time"
)

type recordingPublisher struct {
	envelopes      []Envelope
	eventEnvelopes []Envelope
	err            error
}

func (publisher *recordingPublisher) Publish(_ context.Context, envelope Envelope) error {
	if publisher.err != nil {
		return publisher.err
	}
	publisher.envelopes = append(publisher.envelopes, envelope)
	return nil
}

func (publisher *recordingPublisher) PublishEvent(_ context.Context, envelope Envelope) error {
	publisher.eventEnvelopes = append(publisher.eventEnvelopes, envelope)
	return nil
}

func TestMessageExpiration(t *testing.T) {
	if got := messageExpiration(""); got != "" {
		t.Fatalf("expected empty expiration, got %q", got)
	}
	if got := messageExpiration("not-a-time"); got != "" {
		t.Fatalf("expected empty expiration for invalid timestamp, got %q", got)
	}
	future := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	if got := messageExpiration(future); got == "" {
		t.Fatal("expected expiration for future timestamp")
	}
	if got := messageExpiration(time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)); got != "1" {
		t.Fatalf("expected immediate expiration of 1ms, got %q", got)
	}
}

func TestDeadLetterArgs(t *testing.T) {
	args := deadLetterArgs("onclave.dead", "dead.command.agent")
	if args["x-dead-letter-exchange"] != "onclave.dead" || args["x-dead-letter-routing-key"] != "dead.command.agent" {
		t.Fatalf("unexpected dead-letter args: %#v", args)
	}
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
	if len(publisher.eventEnvelopes) != 2 {
		t.Fatalf("expected target and source lifecycle events, got %d", len(publisher.eventEnvelopes))
	}
	if event := publisher.eventEnvelopes[0]; event.RoutingKey != "task.accepted.target" || event.MessageType != string(EventAccepted) {
		t.Fatalf("unexpected target lifecycle event: %+v", event)
	}
	if event := publisher.eventEnvelopes[1]; event.RoutingKey != "task.accepted.source" || event.TargetAgentID != "source" || event.MessageType != string(EventAccepted) {
		t.Fatalf("unexpected source lifecycle event: %+v", event)
	}
}
