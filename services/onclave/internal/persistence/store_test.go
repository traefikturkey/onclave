package persistence

import (
	"context"
	"errors"
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

func TestSubscriptionRoundTripAndExpiryCleanup(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	subscription := messaging.StoredSubscription{
		SubscriptionID: "sub-1", AgentID: "agent-1", Pattern: "task.*.agent-1",
		CorrelationID: "correlation-1", TaskID: "task-1", Cursor: 4,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour), UpdatedAt: now,
	}
	if err := store.SaveSubscription(subscription); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetSubscription(subscription.SubscriptionID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != subscription {
		t.Fatalf("subscription round trip mismatch: got %+v want %+v", loaded, subscription)
	}
	if err := store.DeleteExpiredSubscriptions(now.Add(2 * time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetSubscription(subscription.SubscriptionID); err != messaging.ErrSubscriptionNotFound {
		t.Fatalf("expected expired subscription cleanup, got %v", err)
	}
}

func TestDeliveryAttemptsAccumulateAndRetainLastError(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.RecordDeliveryAttempt("message-1", errors.New("broker unavailable")); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordDeliveryAttempt("message-1", nil); err != nil {
		t.Fatal(err)
	}
	var attempts int
	var lastError string
	if err := store.db.QueryRow(`SELECT attempts, last_error FROM delivery_attempts WHERE message_id = ?`, "message-1").Scan(&attempts, &lastError); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || lastError != "" {
		t.Fatalf("unexpected delivery attempt record: attempts=%d error=%q", attempts, lastError)
	}
}

func TestRetentionPrunesTerminalTaskEvents(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	if err := store.SaveTask(messaging.Task{TaskID: "task-retention", State: messaging.StateCompleted, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveEvent("task-retention", messaging.Event{Type: messaging.EventCompleted, TaskID: "task-retention", At: now.Add(-2 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := store.PruneTaskEvents(now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	events, err := store.GetEvents("task-retention")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("expected old terminal event to be pruned, got %+v", events)
	}
}

func TestAuditEventsPersistAndPrune(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	if err := store.RecordAudit(messaging.AuditEvent{Type: "subscription.created", At: now, ActorAgentID: "agent-1", SubscriptionID: "sub-1", Details: map[string]any{"pattern": "task.*.agent-1"}}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM audit_events WHERE event_type = ?`, "subscription.created").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one audit event, got %d", count)
	}
	if metrics := store.Metrics(); metrics["onclave_audit_events"] != 1 {
		t.Fatalf("expected metrics to report one audit event, got %+v", metrics)
	}
	if err := store.PruneAuditEvents(now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM audit_events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected audit event pruning, got %d rows", count)
	}
}

func TestGlobalEventSequenceOrdersEventsAcrossTasks(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	first, err := store.AppendEvent("task-a", messaging.Event{Type: messaging.EventAccepted, TaskID: "task-a", At: now})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.AppendEvent("task-b", messaging.Event{Type: messaging.EventStarted, TaskID: "task-b", At: now.Add(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if second <= first {
		t.Fatalf("expected global sequence to increase, got %d then %d", first, second)
	}
	events, err := store.GetGlobalEvents(first)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].TaskID != "task-b" || events[0].Sequence != second {
		t.Fatalf("unexpected global replay: %+v", events)
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
