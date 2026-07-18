package messaging

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestRabbitMQPublisherReconnectsAfterChannelClose(t *testing.T) {
	url := os.Getenv("ONCLAVE_RABBITMQ_TEST_URL")
	if url == "" {
		t.Skip("ONCLAVE_RABBITMQ_TEST_URL is not configured")
	}
	publisher, err := NewRabbitMQPublisher(url, "onclave.commands.reconnect-test")
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()
	if err := publisher.channel.Close(); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(context.Background(), Envelope{
		RoutingKey: "task.reconnect.agent", MessageID: "message-reconnect", TaskID: "task-reconnect",
		MessageType: "task.assign", Payload: []byte(`{"instruction":"reconnect"}`), Persistent: true,
	}); err != nil {
		t.Fatalf("publish after channel close: %v", err)
	}
}

func TestRabbitMQDeadLetterObserver(t *testing.T) {
	url := os.Getenv("ONCLAVE_RABBITMQ_TEST_URL")
	if url == "" {
		t.Skip("ONCLAVE_RABBITMQ_TEST_URL is not configured")
	}
	publisher, err := NewRabbitMQPublisher(url, "onclave.commands.deadletter-test")
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := publisher.DeclareAgentQueue("agent-dead-letter"); err != nil {
		t.Fatal(err)
	}

	deadLetters := make(chan Envelope, 1)
	deadLetterSubscription, err := publisher.SubscribeDeadLetters(ctx, func(envelope Envelope) error {
		deadLetters <- envelope
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer deadLetterSubscription.Close()

	if err := publisher.Publish(ctx, Envelope{
		RoutingKey: "task.assign.agent-dead-letter", MessageID: "message-dead-letter", TaskID: "task-dead-letter",
		SourceAgentID: "agent-origin", TargetAgentID: "agent-dead-letter", MessageType: "task.assign",
		IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpiresAt: time.Now().Add(200 * time.Millisecond).UTC().Format(time.RFC3339Nano),
		Payload: []byte(`{"instruction":"expire"}`), Persistent: true,
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case envelope := <-deadLetters:
		if envelope.MessageID != "message-dead-letter" || envelope.TaskID != "task-dead-letter" {
			t.Fatalf("unexpected dead-letter envelope: %+v", envelope)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for dead-letter delivery")
	}
}

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
	received := make(chan Envelope, 2)
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

	subscription.mu.Lock()
	consumerChannel := subscription.channel
	subscription.mu.Unlock()
	if err := consumerChannel.Close(); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(ctx, Envelope{
		RoutingKey: "task.assign.agent-roundtrip", MessageID: "message-roundtrip-reconnect", TaskID: "task-roundtrip-reconnect",
		MessageType: "task.assign", Payload: []byte(`{"instruction":"reconnected"}`), Persistent: true,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case envelope := <-received:
		if envelope.TaskID != "task-roundtrip-reconnect" {
			t.Fatalf("unexpected reconnected envelope: %+v", envelope)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for recovered RabbitMQ subscription")
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
