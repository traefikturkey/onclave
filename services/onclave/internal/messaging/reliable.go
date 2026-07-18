package messaging

import (
	"context"
	"fmt"
	"time"
)

// RetryingPublisher retries broker failures a bounded number of times. It is
// intentionally in-process; durable acceptance still depends on publisher
// confirms and the task store.
type RetryingPublisher struct {
	publisher      Publisher
	eventPublisher EventPublisher
	attempts       int
	delay          time.Duration
}

func NewRetryingPublisher(publisher Publisher, attempts int, delay time.Duration) *RetryingPublisher {
	if attempts < 1 {
		attempts = 1
	}
	var eventPublisher EventPublisher
	if candidate, ok := publisher.(EventPublisher); ok {
		eventPublisher = candidate
	}
	return &RetryingPublisher{publisher: publisher, eventPublisher: eventPublisher, attempts: attempts, delay: delay}
}

func (publisher *RetryingPublisher) Publish(ctx context.Context, envelope Envelope) error {
	return publisher.retry(ctx, func() error { return publisher.publisher.Publish(ctx, envelope) })
}

func (publisher *RetryingPublisher) PublishEvent(ctx context.Context, envelope Envelope) error {
	if publisher.eventPublisher == nil {
		return fmt.Errorf("event publishing is not supported by wrapped publisher")
	}
	return publisher.retry(ctx, func() error { return publisher.eventPublisher.PublishEvent(ctx, envelope) })
}

func (publisher *RetryingPublisher) retry(ctx context.Context, publish func() error) error {
	var lastErr error
	for attempt := 1; attempt <= publisher.attempts; attempt++ {
		if err := publish(); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if attempt == publisher.attempts {
			break
		}
		timer := time.NewTimer(publisher.delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return ctx.Err()
		}
	}
	return fmt.Errorf("publish failed after %d attempts: %w", publisher.attempts, lastErr)
}
