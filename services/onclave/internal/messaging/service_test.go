package messaging

import (
	"testing"
	"time"
)

func TestSubmitReturnsImmediatelyAcceptedTask(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewService(func() time.Time { return now })

	task, err := service.Submit(Command{
		MessageID: "message-1", TaskID: "task-1", CorrelationID: "correlation-1",
		SourceAgentID: "agent-source", TargetAgentID: "agent-target", Type: "task.assign",
		ExpiresAt: now.Add(time.Hour), Payload: map[string]any{"instruction": "build"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.State != StateAccepted || task.TaskID != "task-1" {
		t.Fatalf("unexpected accepted task: %+v", task)
	}
}

func TestTaskLifecycleEmitsProgressAndCompletionEvents(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewService(func() time.Time { return now })
	mustSubmit(t, service, now)
	if err := service.Acknowledge("task-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Start("task-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Progress("task-1", 50, "halfway"); err != nil {
		t.Fatal(err)
	}
	if err := service.Complete("task-1", map[string]any{"output": "ok"}); err != nil {
		t.Fatal(err)
	}

	task, err := service.Status("task-1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != StateCompleted || task.Progress != 100 {
		t.Fatalf("unexpected completed task: %+v", task)
	}
	events := service.Events("task-1")
	if len(events) != 5 || events[2].Type != EventStarted || events[3].Type != EventProgress || events[4].Type != EventCompleted {
		t.Fatalf("unexpected lifecycle events: %+v", events)
	}
}

func TestDuplicateSubmissionIsIdempotent(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewService(func() time.Time { return now })
	first := mustSubmit(t, service, now)
	second, err := service.Submit(Command{MessageID: "different", TaskID: "task-1", ExpiresAt: now.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if first.MessageID != second.MessageID || len(service.Events("task-1")) != 1 {
		t.Fatalf("duplicate submission was not idempotent: first=%+v second=%+v", first, second)
	}
}

func TestExpiredCommandIsRejected(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewService(func() time.Time { return now })
	_, err := service.Submit(Command{TaskID: "task-expired", ExpiresAt: now.Add(-time.Second)})
	if err != ErrExpired {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

func TestCancellationIsExplicitAndIdempotent(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewService(func() time.Time { return now })
	mustSubmit(t, service, now)
	if err := service.Cancel("task-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Cancel("task-1"); err != nil {
		t.Fatal(err)
	}
	task, err := service.Status("task-1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != StateCancelled {
		t.Fatalf("expected cancelled state, got %s", task.State)
	}
}

func mustSubmit(t *testing.T, service *Service, now time.Time) Task {
	t.Helper()
	task, err := service.Submit(Command{MessageID: "message-1", TaskID: "task-1", ExpiresAt: now.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	return task
}
