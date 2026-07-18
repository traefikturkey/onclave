package messaging

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestRabbitMQAgentQueueRoundTrip(t *testing.T) {
	url := os.Getenv("ONCLAVE_RABBITMQ_TEST_URL")
	if url == "" {
		t.Skip("ONCLAVE_RABBITMQ_TEST_URL is not configured")
	}
	publisher, err := NewRabbitMQPublisher(url, "onclave.commands.test")
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	received := make(chan Envelope, 1)
	subscription, err := publisher.SubscribeAgent(ctx, "agent-roundtrip", func(envelope Envelope) error {
		received <- envelope
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()

	if err := publisher.Publish(ctx, Envelope{
		RoutingKey:  "task.assign.agent-roundtrip",
		MessageID:   "message-roundtrip",
		TaskID:      "task-roundtrip",
		MessageType: "task.assign",
		Payload:     []byte(`{"instruction":"verify"}`),
		Persistent:  true,
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case envelope := <-received:
		if envelope.TaskID != "task-roundtrip" || envelope.RoutingKey != "task.assign.agent-roundtrip" {
			t.Fatalf("unexpected received envelope: %+v", envelope)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for RabbitMQ delivery")
	}

	eventReceived := make(chan Envelope, 1)
	eventSubscription, err := publisher.SubscribeEvents(ctx, "observer-roundtrip", "task.#.agent-roundtrip", func(envelope Envelope) error {
		eventReceived <- envelope
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer eventSubscription.Close()
	if err := publisher.PublishEvent(ctx, Envelope{
		RoutingKey: "task.completed.agent-roundtrip", MessageID: "event-roundtrip", TaskID: "task-roundtrip",
		MessageType: "task.completed", ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
		Payload: []byte(`{"state":"completed"}`), Persistent: true,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case envelope := <-eventReceived:
		if envelope.TaskID != "task-roundtrip" || envelope.RoutingKey != "task.completed.agent-roundtrip" {
			t.Fatalf("unexpected event envelope: %+v", envelope)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for RabbitMQ event delivery")
	}
}
