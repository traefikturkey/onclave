package persistence

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func TestOpenMigratesAndPersistsTaskMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "onclave.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	original := messaging.Task{
		MessageID: "message-1", TaskID: "task-1", CorrelationID: "correlation-1",
		SourceAgentID: "source", TargetAgentID: "target", Type: "task.assign",
		ExpiresAt: time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC), State: messaging.StateRunning, Progress: 50,
	}
	if err := store.SaveTask(original); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetTask("task-1")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.TaskID != original.TaskID || loaded.State != original.State || loaded.Progress != original.Progress {
		t.Fatalf("unexpected persisted task: %+v", loaded)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	loaded, err = store.GetTask("task-1")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.TaskID != "task-1" {
		t.Fatalf("task was not preserved across reopen: %+v", loaded)
	}
}

func TestStorePingChecksSQLiteAvailability(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(context.Background()); err != nil {
		t.Fatalf("expected SQLite ping to succeed: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(context.Background()); err == nil {
		t.Fatal("expected SQLite ping to fail after close")
	}
}

func TestMessagingServiceReloadsTaskAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "onclave.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := messaging.NewServiceWithPublisherAndStore(func() time.Time { return now }, nil, store)
	if _, err := service.Submit(messaging.Command{TaskID: "task-restart", MessageID: "message-restart", ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	restarted := messaging.NewServiceWithPublisherAndStore(func() time.Time { return now }, nil, store)
	loaded, err := restarted.Status("task-restart")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.TaskID != "task-restart" || loaded.State != messaging.StateAccepted {
		t.Fatalf("unexpected restarted task: %+v", loaded)
	}
}

func TestMessagingServiceReloadsTaskEventsAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "onclave.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := messaging.NewServiceWithPublisherAndStore(func() time.Time { return now }, nil, store)
	if _, err := service.Submit(messaging.Command{TaskID: "task-events", MessageID: "message-events", ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := service.Acknowledge("task-events"); err != nil {
		t.Fatal(err)
	}
	if err := service.Start("task-events"); err != nil {
		t.Fatal(err)
	}
	if err := service.Fail("task-events", map[string]any{"error": "restart-test"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	restarted := messaging.NewServiceWithPublisherAndStore(func() time.Time { return now }, nil, store)
	events := restarted.Events("task-events")
	if len(events) != 4 || events[0].Type != messaging.EventAccepted || events[3].Type != messaging.EventFailed {
		t.Fatalf("unexpected restarted events: %+v", events)
	}
}

func TestAdmissionSessionLeaseSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "onclave.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := store.SaveAdmissionAgent(admission.Snapshot{AgentID: "lease-agent", RuntimeType: "reference", Status: admission.StatusAuthenticated, SessionToken: "persisted-token", SessionExpiresAt: expiresAt}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	snapshots, err := store.LoadAdmissionAgents()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].SessionExpiresAt != expiresAt {
		t.Fatalf("unexpected persisted lease: %+v", snapshots)
	}
}

func TestEventOutboxSurvivesReopenAndMarksPublished(t *testing.T) {
	path := filepath.Join(t.TempDir(), "onclave.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	envelope := messaging.Envelope{MessageID: "event-message-1", RoutingKey: "task.completed.target", TaskID: "task-1", MessageType: "task.completed", Payload: []byte(`{"ok":true}`), Persistent: true}
	if err := store.EnqueueEvent(envelope); err != nil {
		t.Fatal(err)
	}
	if err := store.EnqueueEvent(envelope); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := store.PendingEvents()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].MessageID != envelope.MessageID {
		t.Fatalf("unexpected pending events: %+v", pending)
	}
	if err := store.MarkEventPublished(envelope.MessageID); err != nil {
		t.Fatal(err)
	}
	pending, err = store.PendingEvents()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no pending events after publish, got %+v", pending)
	}
	if err := store.PrunePublishedOutbox(time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.EnqueueEvent(envelope); err != nil {
		t.Fatal(err)
	}
	pending, err = store.PendingEvents()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].MessageID != envelope.MessageID {
		t.Fatalf("expected pruned event to be re-enqueueable, got %+v", pending)
	}
	_ = store.Close()
}

func TestCommandOutboxSurvivesReopenAndMarksPublished(t *testing.T) {
	path := filepath.Join(t.TempDir(), "onclave.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	envelope := messaging.Envelope{MessageID: "command-message-1", RoutingKey: "task.assign.target", TaskID: "task-1", MessageType: "task.assign", Payload: []byte(`{"instruction":"run"}`), Persistent: true}
	if err := store.EnqueueCommand(envelope); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := store.PendingCommands()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].MessageID != envelope.MessageID {
		t.Fatalf("unexpected pending commands: %+v", pending)
	}
	if err := store.MarkCommandPublished(envelope.MessageID); err != nil {
		t.Fatal(err)
	}
	pending, err = store.PendingCommands()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no pending commands after publish, got %+v", pending)
	}
	_ = store.Close()
}
