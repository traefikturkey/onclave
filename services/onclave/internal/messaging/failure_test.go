package messaging

import (
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func TestDeliveryRedeliveryCountReadsRabbitDeathHeaders(t *testing.T) {
	headers := amqp.Table{"x-death": []interface{}{
		amqp.Table{"count": int64(2)},
		amqp.Table{"count": int64(1)},
	}}
	if got := deliveryRedeliveryCount(headers); got != 3 {
		t.Fatalf("expected three redeliveries, got %d", got)
	}
}

func TestRabbitMQDialRequiresAMQPSForCustomCA(t *testing.T) {
	if _, err := dialRabbitMQ("amqp://onclave@rabbitmq:5672/%2Fonclave", "ca.pem"); err == nil {
		t.Fatal("expected custom CA to require amqps")
	}
	if _, err := dialRabbitMQ("https://rabbitmq:5671/", ""); err == nil {
		t.Fatal("expected unsupported RabbitMQ URL scheme to be rejected")
	}
}

func TestTaskFailureIsTerminalAndEmitsFailureEvent(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewService(func() time.Time { return now })
	mustSubmit(t, service, now)
	if err := service.Acknowledge("task-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Start("task-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Fail("task-1", map[string]any{"error": "tool failed"}); err != nil {
		t.Fatal(err)
	}
	if err := service.Fail("task-1", map[string]any{"error": "duplicate"}); err != nil {
		t.Fatal(err)
	}
	task, err := service.Status("task-1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != StateFailed || task.Result["error"] != "tool failed" {
		t.Fatalf("unexpected failed task: %+v", task)
	}
	events := service.Events("task-1")
	if len(events) != 4 || events[3].Type != EventFailed {
		t.Fatalf("unexpected failure events: %+v", events)
	}
	if err := service.Complete("task-1", nil); err != ErrInvalidTransition {
		t.Fatalf("expected failed task to reject completion, got %v", err)
	}
}
