package messaging

import (
	"context"
	"errors"
	"testing"
	"time"
)

type flakyPublisher struct {
	failures int
	calls    int
}

func (publisher *flakyPublisher) Publish(context.Context, Envelope) error {
	publisher.calls++
	if publisher.calls <= publisher.failures {
		return errors.New("temporary broker failure")
	}
	return nil
}

func (publisher *flakyPublisher) PublishEvent(ctx context.Context, envelope Envelope) error {
	return publisher.Publish(ctx, envelope)
}

func TestRetryingPublisherRetriesTransientFailures(t *testing.T) {
	wrapped := &flakyPublisher{failures: 2}
	publisher := NewRetryingPublisher(wrapped, 3, time.Millisecond)
	if err := publisher.Publish(context.Background(), Envelope{MessageID: "message-retry"}); err != nil {
		t.Fatal(err)
	}
	if wrapped.calls != 3 {
		t.Fatalf("expected three attempts, got %d", wrapped.calls)
	}
}

func TestRetryingPublisherStopsAtAttemptLimit(t *testing.T) {
	wrapped := &flakyPublisher{failures: 4}
	publisher := NewRetryingPublisher(wrapped, 3, time.Millisecond)
	if err := publisher.Publish(context.Background(), Envelope{MessageID: "message-fail"}); err == nil {
		t.Fatal("expected bounded retry failure")
	}
	if wrapped.calls != 3 {
		t.Fatalf("expected three attempts, got %d", wrapped.calls)
	}
}

func TestRetryingPublisherHonorsCancellation(t *testing.T) {
	wrapped := &flakyPublisher{failures: 2}
	publisher := NewRetryingPublisher(wrapped, 3, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := publisher.Publish(ctx, Envelope{MessageID: "message-cancel"}); err == nil {
		t.Fatal("expected cancellation error")
	}
}
