package messaging

import (
	"errors"
	"testing"
	"time"
)

type subscriptionTestStore struct {
	subscriptions map[string]StoredSubscription
}

func (store *subscriptionTestStore) SaveTask(Task) error          { return nil }
func (store *subscriptionTestStore) GetTask(string) (Task, error) { return Task{}, ErrTaskNotFound }
func (store *subscriptionTestStore) SaveSubscription(subscription StoredSubscription) error {
	if store.subscriptions == nil {
		store.subscriptions = make(map[string]StoredSubscription)
	}
	store.subscriptions[subscription.SubscriptionID] = subscription
	return nil
}
func (store *subscriptionTestStore) GetSubscription(id string) (StoredSubscription, error) {
	subscription, ok := store.subscriptions[id]
	if !ok {
		return StoredSubscription{}, ErrSubscriptionNotFound
	}
	return subscription, nil
}
func (store *subscriptionTestStore) DeleteSubscription(id string) error {
	delete(store.subscriptions, id)
	return nil
}
func (store *subscriptionTestStore) DeleteExpiredSubscriptions(now time.Time) error {
	for id, subscription := range store.subscriptions {
		if !now.Before(subscription.ExpiresAt) {
			delete(store.subscriptions, id)
		}
	}
	return nil
}

func TestSubscriptionLifecyclePersistsLeaseAndCursor(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	store := &subscriptionTestStore{}
	service := NewServiceWithPublisherAndStore(func() time.Time { return now }, nil, store)

	subscription, err := service.CreateSubscription("agent-target", "task.*.agent-target", "correlation-1", "task-1", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if subscription.SubscriptionID == "" || subscription.Cursor != 0 {
		t.Fatalf("unexpected subscription: %+v", subscription)
	}
	if _, err := service.UpdateSubscriptionCursor(subscription.SubscriptionID, "agent-target", 3); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateSubscriptionCursor(subscription.SubscriptionID, "agent-target", 2); !errors.Is(err, ErrInvalidSubscription) {
		t.Fatalf("expected backwards cursor rejection, got %v", err)
	}
	loaded, err := service.GetSubscription(subscription.SubscriptionID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Cursor != 3 {
		t.Fatalf("expected persisted cursor 3, got %d", loaded.Cursor)
	}
	if _, err := service.RenewSubscription(subscription.SubscriptionID, "other-agent", now.Add(2*time.Hour)); err != ErrSubscriptionUnauthorized {
		t.Fatalf("expected ownership rejection, got %v", err)
	}
	if err := service.DeleteSubscription(subscription.SubscriptionID, "agent-target"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetSubscription(subscription.SubscriptionID); err != ErrSubscriptionNotFound {
		t.Fatalf("expected deleted subscription, got %v", err)
	}
}

func TestSubscriptionPatternMustBeAgentScoped(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	service := NewServiceWithPublisherAndStore(func() time.Time { return now }, nil, &subscriptionTestStore{})
	_, err := service.CreateSubscription("agent-target", "task.*.other-agent", "", "", now.Add(time.Hour))
	if !errors.Is(err, ErrInvalidSubscription) {
		t.Fatalf("expected scoped pattern rejection, got %v", err)
	}
}
