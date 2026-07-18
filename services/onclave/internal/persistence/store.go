package persistence

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if path != ":memory:" && path != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create state directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (store *Store) Close() error {
	return store.db.Close()
}

func (store *Store) Ping(ctx context.Context) error {
	if err := store.db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping SQLite database: %w", err)
	}
	return nil
}

func (store *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL,
  progress INTEGER NOT NULL,
  progress_note TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  at TEXT NOT NULL,
  progress INTEGER NOT NULL,
  note TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(task_id, sequence)
);
CREATE TABLE IF NOT EXISTS event_outbox (
  message_id TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS command_outbox (
  message_id TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS admission_agents (
  agent_id TEXT PRIMARY KEY,
  runtime_type TEXT NOT NULL,
  public_key BLOB NOT NULL,
  status TEXT NOT NULL,
  challenge BLOB NOT NULL,
  capability_request_id TEXT NOT NULL,
  capability_nonce TEXT NOT NULL,
  session_token TEXT NOT NULL,
  declared_json TEXT NOT NULL,
  effective_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admission_session_leases (
  agent_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  message_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  details_json TEXT NOT NULL
);`
	if _, err := store.db.Exec(schema); err != nil {
		return fmt.Errorf("migrate SQLite schema: %w", err)
	}
	_, err := store.db.Exec(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)`, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("record SQLite migration: %w", err)
	}
	return nil
}

func (store *Store) SaveTask(task messaging.Task) error {
	payload, err := json.Marshal(task.Payload)
	if err != nil {
		return fmt.Errorf("encode task payload: %w", err)
	}
	result, err := json.Marshal(task.Result)
	if err != nil {
		return fmt.Errorf("encode task result: %w", err)
	}
	_, err = store.db.Exec(`
INSERT INTO tasks(task_id, message_id, correlation_id, source_agent_id, target_agent_id, message_type, expires_at, state, progress, progress_note, payload_json, result_json, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(task_id) DO UPDATE SET
  message_id=excluded.message_id, correlation_id=excluded.correlation_id,
  source_agent_id=excluded.source_agent_id, target_agent_id=excluded.target_agent_id,
  message_type=excluded.message_type, expires_at=excluded.expires_at, state=excluded.state,
  progress=excluded.progress, progress_note=excluded.progress_note, payload_json=excluded.payload_json,
  result_json=excluded.result_json, updated_at=excluded.updated_at`,
		task.TaskID, task.MessageID, task.CorrelationID, task.SourceAgentID, task.TargetAgentID, task.Type,
		task.ExpiresAt.UTC().Format(time.RFC3339Nano), task.State, task.Progress, task.ProgressNote,
		string(payload), string(result), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("save task: %w", err)
	}
	return nil
}

func (store *Store) GetTask(taskID string) (messaging.Task, error) {
	var task messaging.Task
	var expiresAt, payloadJSON, resultJSON string
	err := store.db.QueryRow(`SELECT message_id, correlation_id, source_agent_id, target_agent_id, message_type, expires_at, state, progress, progress_note, payload_json, result_json FROM tasks WHERE task_id = ?`, taskID).Scan(
		&task.MessageID, &task.CorrelationID, &task.SourceAgentID, &task.TargetAgentID, &task.Type,
		&expiresAt, &task.State, &task.Progress, &task.ProgressNote, &payloadJSON, &resultJSON)
	if err == sql.ErrNoRows {
		return messaging.Task{}, messaging.ErrTaskNotFound
	}
	if err != nil {
		return messaging.Task{}, fmt.Errorf("load task: %w", err)
	}
	task.TaskID = taskID
	task.ExpiresAt, err = time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return messaging.Task{}, fmt.Errorf("parse task expiration: %w", err)
	}
	if err := json.Unmarshal([]byte(payloadJSON), &task.Payload); err != nil {
		return messaging.Task{}, fmt.Errorf("decode task payload: %w", err)
	}
	if err := json.Unmarshal([]byte(resultJSON), &task.Result); err != nil {
		return messaging.Task{}, fmt.Errorf("decode task result: %w", err)
	}
	return task, nil
}

func (store *Store) SaveAdmissionAgent(snapshot admission.Snapshot) error {
	declared, err := json.Marshal(snapshot.Declared)
	if err != nil {
		return fmt.Errorf("encode declared capabilities: %w", err)
	}
	effective, err := json.Marshal(snapshot.Effective)
	if err != nil {
		return fmt.Errorf("encode effective capabilities: %w", err)
	}
	_, err = store.db.Exec(`
INSERT INTO admission_agents(agent_id, runtime_type, public_key, status, challenge, capability_request_id, capability_nonce, session_token, declared_json, effective_json, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(agent_id) DO UPDATE SET runtime_type=excluded.runtime_type, public_key=excluded.public_key, status=excluded.status,
  challenge=excluded.challenge, capability_request_id=excluded.capability_request_id, capability_nonce=excluded.capability_nonce,
  session_token=excluded.session_token, declared_json=excluded.declared_json, effective_json=excluded.effective_json, updated_at=excluded.updated_at`,
		snapshot.AgentID, snapshot.RuntimeType, nonNilBytes(snapshot.PublicKey), snapshot.Status, nonNilBytes(snapshot.Challenge),
		snapshot.CapabilityRequestID, snapshot.CapabilityNonce, snapshot.SessionToken, string(declared), string(effective), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("save admission agent: %w", err)
	}
	if snapshot.SessionExpiresAt == "" {
		_, err = store.db.Exec(`DELETE FROM admission_session_leases WHERE agent_id = ?`, snapshot.AgentID)
	} else {
		_, err = store.db.Exec(`INSERT INTO admission_session_leases(agent_id, expires_at) VALUES(?, ?)
ON CONFLICT(agent_id) DO UPDATE SET expires_at=excluded.expires_at`, snapshot.AgentID, snapshot.SessionExpiresAt)
	}
	if err != nil {
		return fmt.Errorf("save admission session lease: %w", err)
	}
	return nil
}

func (store *Store) LoadAdmissionAgents() ([]admission.Snapshot, error) {
	rows, err := store.db.Query(`SELECT a.agent_id, a.runtime_type, a.public_key, a.status, a.challenge, a.capability_request_id, a.capability_nonce, a.session_token, l.expires_at, a.declared_json, a.effective_json
FROM admission_agents a LEFT JOIN admission_session_leases l ON l.agent_id = a.agent_id ORDER BY a.agent_id`)
	if err != nil {
		return nil, fmt.Errorf("query admission agents: %w", err)
	}
	defer rows.Close()
	var snapshots []admission.Snapshot
	for rows.Next() {
		var snapshot admission.Snapshot
		var declared, effective string
		var sessionExpiresAt sql.NullString
		if err := rows.Scan(&snapshot.AgentID, &snapshot.RuntimeType, &snapshot.PublicKey, &snapshot.Status, &snapshot.Challenge, &snapshot.CapabilityRequestID, &snapshot.CapabilityNonce, &snapshot.SessionToken, &sessionExpiresAt, &declared, &effective); err != nil {
			return nil, fmt.Errorf("scan admission agent: %w", err)
		}
		if sessionExpiresAt.Valid {
			snapshot.SessionExpiresAt = sessionExpiresAt.String
		}
		if err := json.Unmarshal([]byte(declared), &snapshot.Declared); err != nil {
			return nil, fmt.Errorf("decode declared capabilities: %w", err)
		}
		if err := json.Unmarshal([]byte(effective), &snapshot.Effective); err != nil {
			return nil, fmt.Errorf("decode effective capabilities: %w", err)
		}
		snapshots = append(snapshots, snapshot)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate admission agents: %w", err)
	}
	return snapshots, nil
}

func (store *Store) SaveEvent(taskID string, event messaging.Event) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return fmt.Errorf("encode event payload: %w", err)
	}
	_, err = store.db.Exec(`INSERT INTO task_events(task_id, sequence, event_type, at, progress, note, payload_json)
SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ? FROM task_events WHERE task_id = ?`,
		taskID, event.Type, event.At.UTC().Format(time.RFC3339Nano), event.Progress, event.Note, string(payload), taskID)
	if err != nil {
		return fmt.Errorf("save task event: %w", err)
	}
	return nil
}

func (store *Store) GetEvents(taskID string) ([]messaging.Event, error) {
	rows, err := store.db.Query(`SELECT event_type, at, progress, note, payload_json FROM task_events WHERE task_id = ? ORDER BY sequence`, taskID)
	if err != nil {
		return nil, fmt.Errorf("query task events: %w", err)
	}
	defer rows.Close()
	var events []messaging.Event
	for rows.Next() {
		var event messaging.Event
		var at, payload string
		if err := rows.Scan(&event.Type, &at, &event.Progress, &event.Note, &payload); err != nil {
			return nil, fmt.Errorf("scan task event: %w", err)
		}
		event.TaskID = taskID
		event.At, err = time.Parse(time.RFC3339Nano, at)
		if err != nil {
			return nil, fmt.Errorf("parse task event timestamp: %w", err)
		}
		if err := json.Unmarshal([]byte(payload), &event.Payload); err != nil {
			return nil, fmt.Errorf("decode task event payload: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate task events: %w", err)
	}
	return events, nil
}

func (store *Store) SaveSubscription(subscription messaging.StoredSubscription) error {
	_, err := store.db.Exec(`INSERT INTO subscriptions(subscription_id, agent_id, pattern, correlation_id, task_id, cursor, created_at, expires_at, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(subscription_id) DO UPDATE SET agent_id=excluded.agent_id, pattern=excluded.pattern,
  correlation_id=excluded.correlation_id, task_id=excluded.task_id, cursor=excluded.cursor,
  created_at=excluded.created_at, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
		subscription.SubscriptionID, subscription.AgentID, subscription.Pattern, subscription.CorrelationID,
		subscription.TaskID, subscription.Cursor, subscription.CreatedAt.UTC().Format(time.RFC3339Nano),
		subscription.ExpiresAt.UTC().Format(time.RFC3339Nano), subscription.UpdatedAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("save subscription: %w", err)
	}
	return nil
}

func (store *Store) GetSubscription(subscriptionID string) (messaging.StoredSubscription, error) {
	var subscription messaging.StoredSubscription
	var createdAt, expiresAt, updatedAt string
	err := store.db.QueryRow(`SELECT subscription_id, agent_id, pattern, correlation_id, task_id, cursor, created_at, expires_at, updated_at
FROM subscriptions WHERE subscription_id = ?`, subscriptionID).Scan(
		&subscription.SubscriptionID, &subscription.AgentID, &subscription.Pattern, &subscription.CorrelationID,
		&subscription.TaskID, &subscription.Cursor, &createdAt, &expiresAt, &updatedAt)
	if err == sql.ErrNoRows {
		return messaging.StoredSubscription{}, messaging.ErrSubscriptionNotFound
	}
	if err != nil {
		return messaging.StoredSubscription{}, fmt.Errorf("load subscription: %w", err)
	}
	var parseErr error
	if subscription.CreatedAt, parseErr = time.Parse(time.RFC3339Nano, createdAt); parseErr != nil {
		return messaging.StoredSubscription{}, fmt.Errorf("parse subscription creation time: %w", parseErr)
	}
	if subscription.ExpiresAt, parseErr = time.Parse(time.RFC3339Nano, expiresAt); parseErr != nil {
		return messaging.StoredSubscription{}, fmt.Errorf("parse subscription expiry: %w", parseErr)
	}
	if subscription.UpdatedAt, parseErr = time.Parse(time.RFC3339Nano, updatedAt); parseErr != nil {
		return messaging.StoredSubscription{}, fmt.Errorf("parse subscription update time: %w", parseErr)
	}
	return subscription, nil
}

func (store *Store) DeleteSubscription(subscriptionID string) error {
	if _, err := store.db.Exec(`DELETE FROM subscriptions WHERE subscription_id = ?`, subscriptionID); err != nil {
		return fmt.Errorf("delete subscription: %w", err)
	}
	return nil
}

func (store *Store) DeleteExpiredSubscriptions(now time.Time) error {
	if _, err := store.db.Exec(`DELETE FROM subscriptions WHERE expires_at <= ?`, now.UTC().Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("delete expired subscriptions: %w", err)
	}
	return nil
}

func (store *Store) EnqueueCommand(envelope messaging.Envelope) error {
	return store.enqueueOutbox("command_outbox", envelope)
}

func (store *Store) PendingCommands() ([]messaging.Envelope, error) {
	return store.pendingOutbox("command_outbox")
}

func (store *Store) MarkCommandPublished(messageID string) error {
	return store.markOutboxPublished("command_outbox", messageID)
}

func (store *Store) EnqueueEvent(envelope messaging.Envelope) error {
	return store.enqueueOutbox("event_outbox", envelope)
}

func (store *Store) PendingEvents() ([]messaging.Envelope, error) {
	return store.pendingOutbox("event_outbox")
}

func (store *Store) MarkEventPublished(messageID string) error {
	return store.markOutboxPublished("event_outbox", messageID)
}

func (store *Store) RecordDeliveryAttempt(messageID string, publishErr error) error {
	errorText := ""
	if publishErr != nil {
		errorText = publishErr.Error()
	}
	_, err := store.db.Exec(`INSERT INTO delivery_attempts(message_id, attempts, last_error, last_attempt_at)
VALUES(?, 1, ?, ?)
ON CONFLICT(message_id) DO UPDATE SET attempts=delivery_attempts.attempts + 1,
  last_error=excluded.last_error, last_attempt_at=excluded.last_attempt_at`,
		messageID, errorText, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("record delivery attempt: %w", err)
	}
	if err := store.RecordAudit(messaging.AuditEvent{Type: "delivery.attempt", MessageID: messageID, Details: map[string]any{"error": errorText}}); err != nil {
		return err
	}
	return nil
}

func (store *Store) PruneTaskEvents(before time.Time) error {
	_, err := store.db.Exec(`DELETE FROM task_events
WHERE at < ? AND task_id IN (SELECT task_id FROM tasks WHERE state IN (?, ?, ?, ?))`,
		before.UTC().Format(time.RFC3339Nano), messaging.StateCompleted, messaging.StateFailed,
		messaging.StateCancelled, messaging.StateExpired)
	if err != nil {
		return fmt.Errorf("prune task events: %w", err)
	}
	return nil
}

func (store *Store) PruneDeliveryAttempts(before time.Time) error {
	if _, err := store.db.Exec(`DELETE FROM delivery_attempts WHERE last_attempt_at < ?`, before.UTC().Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("prune delivery attempts: %w", err)
	}
	return nil
}

func (store *Store) RecordAudit(event messaging.AuditEvent) error {
	details, err := json.Marshal(event.Details)
	if err != nil {
		return fmt.Errorf("encode audit details: %w", err)
	}
	_, err = store.db.Exec(`INSERT INTO audit_events(event_type, at, actor_agent_id, message_id, task_id, subscription_id, details_json)
VALUES(?, ?, ?, ?, ?, ?, ?)`, event.Type, event.At.UTC().Format(time.RFC3339Nano), event.ActorAgentID,
		event.MessageID, event.TaskID, event.SubscriptionID, string(details))
	if err != nil {
		return fmt.Errorf("record audit event: %w", err)
	}
	return nil
}

func (store *Store) PruneAuditEvents(before time.Time) error {
	if _, err := store.db.Exec(`DELETE FROM audit_events WHERE at < ?`, before.UTC().Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("prune audit events: %w", err)
	}
	return nil
}

func (store *Store) Metrics() map[string]int64 {
	metrics := make(map[string]int64)
	queries := map[string]string{
		"onclave_tasks_persisted":         `SELECT COUNT(*) FROM tasks`,
		"onclave_subscriptions_persisted": `SELECT COUNT(*) FROM subscriptions`,
		"onclave_command_outbox_pending":  `SELECT COUNT(*) FROM command_outbox WHERE published_at IS NULL`,
		"onclave_event_outbox_pending":    `SELECT COUNT(*) FROM event_outbox WHERE published_at IS NULL`,
		"onclave_delivery_attempts":       `SELECT COALESCE(SUM(attempts), 0) FROM delivery_attempts`,
		"onclave_audit_events":            `SELECT COUNT(*) FROM audit_events`,
	}
	for name, query := range queries {
		var value int64
		if err := store.db.QueryRow(query).Scan(&value); err == nil {
			metrics[name] = value
		}
	}
	return metrics
}

func (store *Store) enqueueOutbox(table string, envelope messaging.Envelope) error {
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode outbox envelope: %w", err)
	}
	_, err = store.db.Exec(`INSERT OR IGNORE INTO `+table+`(message_id, envelope_json, created_at) VALUES(?, ?, ?)`, envelope.MessageID, string(encoded), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("enqueue %s: %w", table, err)
	}
	return nil
}

func (store *Store) pendingOutbox(table string) ([]messaging.Envelope, error) {
	rows, err := store.db.Query(`SELECT envelope_json FROM ` + table + ` WHERE published_at IS NULL ORDER BY created_at, message_id`)
	if err != nil {
		return nil, fmt.Errorf("query pending %s: %w", table, err)
	}
	defer rows.Close()
	var envelopes []messaging.Envelope
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, fmt.Errorf("scan pending %s: %w", table, err)
		}
		var envelope messaging.Envelope
		if err := json.Unmarshal([]byte(encoded), &envelope); err != nil {
			return nil, fmt.Errorf("decode pending %s: %w", table, err)
		}
		envelopes = append(envelopes, envelope)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending %s: %w", table, err)
	}
	return envelopes, nil
}

func (store *Store) markOutboxPublished(table, messageID string) error {
	_, err := store.db.Exec(`UPDATE `+table+` SET published_at = ? WHERE message_id = ?`, time.Now().UTC().Format(time.RFC3339Nano), messageID)
	if err != nil {
		return fmt.Errorf("mark %s published: %w", table, err)
	}
	return nil
}

func (store *Store) PrunePublishedOutbox(before time.Time) error {
	cutoff := before.UTC().Format(time.RFC3339Nano)
	for _, table := range []string{"command_outbox", "event_outbox"} {
		if _, err := store.db.Exec(`DELETE FROM `+table+` WHERE published_at IS NOT NULL AND published_at < ?`, cutoff); err != nil {
			return fmt.Errorf("prune %s: %w", table, err)
		}
	}
	return nil
}

func nonNilBytes(value []byte) []byte {
	if value == nil {
		return []byte{}
	}
	return value
}
