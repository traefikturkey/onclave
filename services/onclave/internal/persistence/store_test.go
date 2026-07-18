package persistence

import (
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
