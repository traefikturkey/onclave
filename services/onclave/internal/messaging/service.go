package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	ErrExpired           = errors.New("command has expired")
	ErrTaskNotFound      = errors.New("task not found")
	ErrInvalidTransition = errors.New("invalid task state transition")
	ErrInvalidProgress   = errors.New("progress must be between 0 and 100")
)

type State string

const (
	StateAccepted     State = "accepted"
	StateAcknowledged State = "acknowledged"
	StateRunning      State = "running"
	StateCompleted    State = "completed"
	StateFailed       State = "failed"
	StateCancelled    State = "cancelled"
	StateExpired      State = "expired"
)

type EventType string

const (
	EventAccepted     EventType = "task.accepted"
	EventAcknowledged EventType = "task.acknowledged"
	EventStarted      EventType = "task.started"
	EventProgress     EventType = "task.progress"
	EventCompleted    EventType = "task.completed"
	EventFailed       EventType = "task.failed"
	EventCancelled    EventType = "task.cancelled"
	EventExpired      EventType = "task.expired"
)

type Command struct {
	MessageID     string
	TaskID        string
	CorrelationID string
	SourceAgentID string
	TargetAgentID string
	Type          string
	ExpiresAt     time.Time
	Payload       map[string]any
}

type Task struct {
	MessageID     string
	TaskID        string
	CorrelationID string
	SourceAgentID string
	TargetAgentID string
	Type          string
	ExpiresAt     time.Time
	State         State
	Progress      int
	ProgressNote  string
	Payload       map[string]any
	Result        map[string]any
}

type Event struct {
	Type     EventType      `json:"type"`
	TaskID   string         `json:"taskId"`
	At       time.Time      `json:"at"`
	Progress int            `json:"progress,omitempty"`
	Note     string         `json:"note,omitempty"`
	Payload  map[string]any `json:"payload,omitempty"`
}

type Service struct {
	mu             sync.Mutex
	now            func() time.Time
	tasks          map[string]*Task
	events         map[string][]Event
	publisher      Publisher
	eventPublisher EventPublisher
	store          TaskStore
}

type TaskStore interface {
	SaveTask(Task) error
	GetTask(string) (Task, error)
}

type EventStore interface {
	SaveEvent(string, Event) error
	GetEvents(string) ([]Event, error)
}

type EventOutbox interface {
	EnqueueEvent(Envelope) error
	PendingEvents() ([]Envelope, error)
	MarkEventPublished(string) error
}

type CommandOutbox interface {
	EnqueueCommand(Envelope) error
	PendingCommands() ([]Envelope, error)
	MarkCommandPublished(string) error
}

func NewService(now func() time.Time) *Service {
	return NewServiceWithPublisher(now, nil)
}

func NewServiceWithPublisher(now func() time.Time, publisher Publisher) *Service {
	return NewServiceWithPublisherAndStore(now, publisher, nil)
}

func NewServiceWithPublisherAndStore(now func() time.Time, publisher Publisher, store TaskStore) *Service {
	if now == nil {
		now = time.Now
	}
	var eventPublisher EventPublisher
	if candidate, ok := publisher.(EventPublisher); ok {
		eventPublisher = candidate
	}
	return &Service{now: now, tasks: make(map[string]*Task), events: make(map[string][]Event), publisher: publisher, eventPublisher: eventPublisher, store: store}
}

func (s *Service) Submit(command Command) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.tasks[command.TaskID]; ok {
		return cloneTask(existing), nil
	}
	if command.ExpiresAt.IsZero() || !command.ExpiresAt.After(s.now()) {
		return Task{}, ErrExpired
	}
	task := &Task{
		MessageID: command.MessageID, TaskID: command.TaskID, CorrelationID: command.CorrelationID,
		SourceAgentID: command.SourceAgentID, TargetAgentID: command.TargetAgentID, Type: command.Type,
		ExpiresAt: command.ExpiresAt, State: StateAccepted, Payload: cloneMap(command.Payload),
	}
	s.tasks[task.TaskID] = task
	if s.store != nil {
		if err := s.store.SaveTask(*task); err != nil {
			delete(s.tasks, task.TaskID)
			return Task{}, fmt.Errorf("persist task: %w", err)
		}
	}
	payload, err := json.Marshal(command.Payload)
	if err != nil {
		delete(s.tasks, task.TaskID)
		return Task{}, fmt.Errorf("encode command payload: %w", err)
	}
	envelope := Envelope{
		RoutingKey: command.Type + "." + command.TargetAgentID,
		MessageID:  command.MessageID, TaskID: command.TaskID, CorrelationID: command.CorrelationID,
		SourceAgentID: command.SourceAgentID, TargetAgentID: command.TargetAgentID, MessageType: command.Type,
		IssuedAt: s.now().UTC().Format(time.RFC3339Nano), ExpiresAt: command.ExpiresAt.UTC().Format(time.RFC3339Nano),
		Payload: payload, Persistent: true,
	}
	if outbox, ok := s.store.(CommandOutbox); ok {
		if err := outbox.EnqueueCommand(envelope); err != nil {
			delete(s.tasks, task.TaskID)
			return Task{}, fmt.Errorf("enqueue command: %w", err)
		}
	}
	if s.publisher != nil {
		if err := s.publisher.Publish(context.Background(), envelope); err != nil {
			return Task{}, fmt.Errorf("publish command: %w", err)
		}
		if outbox, ok := s.store.(CommandOutbox); ok {
			if err := outbox.MarkCommandPublished(envelope.MessageID); err != nil {
				return Task{}, fmt.Errorf("mark command published: %w", err)
			}
		}
	}
	s.record(task, Event{Type: EventAccepted, TaskID: task.TaskID})
	return cloneTask(task), nil
}

func (s *Service) Acknowledge(taskID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, err := s.task(taskID)
	if err != nil {
		return err
	}
	if task.State == StateAcknowledged || task.State == StateRunning {
		return nil
	}
	if task.State != StateAccepted {
		return ErrInvalidTransition
	}
	task.State = StateAcknowledged
	if err := s.persist(task); err != nil {
		return err
	}
	s.record(task, Event{Type: EventAcknowledged, TaskID: taskID})
	return nil
}

func (s *Service) Start(taskID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, err := s.task(taskID)
	if err != nil {
		return err
	}
	if task.State == StateRunning {
		return nil
	}
	if task.State != StateAcknowledged {
		return ErrInvalidTransition
	}
	task.State = StateRunning
	if err := s.persist(task); err != nil {
		return err
	}
	s.record(task, Event{Type: EventStarted, TaskID: taskID})
	return nil
}

func (s *Service) Progress(taskID string, progress int, note string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if progress < 0 || progress > 100 {
		return ErrInvalidProgress
	}
	task, err := s.task(taskID)
	if err != nil {
		return err
	}
	if task.State != StateRunning {
		return ErrInvalidTransition
	}
	task.Progress = progress
	task.ProgressNote = note
	if err := s.persist(task); err != nil {
		return err
	}
	s.record(task, Event{Type: EventProgress, TaskID: taskID, Progress: progress, Note: note})
	return nil
}

func (s *Service) Complete(taskID string, result map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, err := s.task(taskID)
	if err != nil {
		return err
	}
	if task.State == StateCompleted {
		return nil
	}
	if task.State != StateRunning {
		return ErrInvalidTransition
	}
	task.State = StateCompleted
	task.Progress = 100
	task.Result = cloneMap(result)
	if err := s.persist(task); err != nil {
		return err
	}
	s.record(task, Event{Type: EventCompleted, TaskID: taskID, Progress: 100, Payload: cloneMap(result)})
	return nil
}

func (s *Service) Fail(taskID string, result map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, err := s.task(taskID)
	if err != nil {
		return err
	}
	if task.State == StateFailed {
		return nil
	}
	if task.State != StateRunning {
		return ErrInvalidTransition
	}
	task.State = StateFailed
	task.Result = cloneMap(result)
	if err := s.persist(task); err != nil {
		return err
	}
	s.record(task, Event{Type: EventFailed, TaskID: taskID, Payload: cloneMap(result)})
	return nil
}

func (s *Service) Cancel(taskID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, err := s.task(taskID)
	if err != nil {
		return err
	}
	if task.State == StateCancelled {
		return nil
	}
	if task.State == StateCompleted || task.State == StateFailed || task.State == StateExpired {
		return ErrInvalidTransition
	}
	task.State = StateCancelled
	if err := s.persist(task); err != nil {
		return err
	}
	s.record(task, Event{Type: EventCancelled, TaskID: taskID})
	return nil
}

func (s *Service) Status(taskID string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, err := s.task(taskID)
	if err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (s *Service) Events(taskID string) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, loaded := s.events[taskID]; !loaded {
		if eventStore, ok := s.store.(EventStore); ok {
			if events, err := eventStore.GetEvents(taskID); err == nil {
				s.events[taskID] = events
			}
		}
	}
	events := append([]Event(nil), s.events[taskID]...)
	return events
}

func (s *Service) task(taskID string) (*Task, error) {
	task, ok := s.tasks[taskID]
	if !ok {
		if s.store != nil {
			loaded, err := s.store.GetTask(taskID)
			if err == nil {
				s.tasks[taskID] = &loaded
				task = &loaded
				ok = true
			} else {
				return nil, ErrTaskNotFound
			}
		}
	}
	if !ok {
		return nil, ErrTaskNotFound
	}
	if !task.ExpiresAt.IsZero() && !s.now().Before(task.ExpiresAt) && !isTerminal(task.State) {
		task.State = StateExpired
		if err := s.persist(task); err != nil {
			return nil, err
		}
		s.record(task, Event{Type: EventExpired, TaskID: task.TaskID})
	}
	return task, nil
}

func isTerminal(state State) bool {
	return state == StateCompleted || state == StateFailed || state == StateCancelled || state == StateExpired
}

func (s *Service) persist(task *Task) error {
	if s.store == nil {
		return nil
	}
	return s.store.SaveTask(*task)
}

func (s *Service) record(task *Task, event Event) {
	event.At = s.now()
	s.events[task.TaskID] = append(s.events[task.TaskID], event)
	if eventStore, ok := s.store.(EventStore); ok {
		_ = eventStore.SaveEvent(task.TaskID, event)
	}
	payload, err := json.Marshal(map[string]any{
		"eventType": string(event.Type), "state": string(task.State), "progress": event.Progress,
		"note": event.Note, "payload": event.Payload,
	})
	if err != nil {
		return
	}
	envelope := Envelope{
		RoutingKey: string(event.Type) + "." + task.TargetAgentID,
		MessageID:  task.MessageID + ":" + string(event.Type) + ":" + event.At.UTC().Format(time.RFC3339Nano),
		TaskID:     task.TaskID, CorrelationID: task.CorrelationID,
		SourceAgentID: task.SourceAgentID, TargetAgentID: task.TargetAgentID,
		MessageType: string(event.Type), IssuedAt: event.At.UTC().Format(time.RFC3339Nano),
		ExpiresAt: task.ExpiresAt.UTC().Format(time.RFC3339Nano), Payload: payload, Persistent: true,
	}
	envelopes := []Envelope{envelope}
	if task.SourceAgentID != "" && task.SourceAgentID != task.TargetAgentID {
		sourceEnvelope := envelope
		sourceEnvelope.RoutingKey = string(event.Type) + "." + task.SourceAgentID
		sourceEnvelope.MessageID = envelope.MessageID + ":source"
		sourceEnvelope.TargetAgentID = task.SourceAgentID
		envelopes = append(envelopes, sourceEnvelope)
	}
	for _, eventEnvelope := range envelopes {
		if outbox, ok := s.store.(EventOutbox); ok {
			_ = outbox.EnqueueEvent(eventEnvelope)
		}
		if s.eventPublisher == nil {
			continue
		}
		if err := s.eventPublisher.PublishEvent(context.Background(), eventEnvelope); err == nil {
			if outbox, ok := s.store.(EventOutbox); ok {
				_ = outbox.MarkEventPublished(eventEnvelope.MessageID)
			}
		}
	}
}

func (s *Service) ReplayPendingCommands(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.publisher == nil {
		return nil
	}
	outbox, ok := s.store.(CommandOutbox)
	if !ok {
		return nil
	}
	pending, err := outbox.PendingCommands()
	if err != nil {
		return err
	}
	for _, envelope := range pending {
		if err := s.publisher.Publish(ctx, envelope); err != nil {
			return err
		}
		if err := outbox.MarkCommandPublished(envelope.MessageID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ReplayPendingEvents(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eventPublisher == nil {
		return nil
	}
	outbox, ok := s.store.(EventOutbox)
	if !ok {
		return nil
	}
	pending, err := outbox.PendingEvents()
	if err != nil {
		return err
	}
	for _, envelope := range pending {
		if err := s.eventPublisher.PublishEvent(ctx, envelope); err != nil {
			return err
		}
		if err := outbox.MarkEventPublished(envelope.MessageID); err != nil {
			return err
		}
	}
	return nil
}

func cloneTask(task *Task) Task {
	copy := *task
	copy.Payload = cloneMap(task.Payload)
	copy.Result = cloneMap(task.Result)
	return copy
}

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	copy := make(map[string]any, len(value))
	for key, item := range value {
		copy[key] = item
	}
	return copy
}

func sortedKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
