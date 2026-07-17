package persistence

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

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
