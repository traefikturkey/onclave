package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

type Envelope struct {
	RoutingKey    string
	MessageID     string          `json:"messageId"`
	TaskID        string          `json:"taskId"`
	CorrelationID string          `json:"correlationId,omitempty"`
	SourceAgentID string          `json:"sourceAgentId,omitempty"`
	TargetAgentID string          `json:"targetAgentId,omitempty"`
	MessageType   string          `json:"messageType"`
	IssuedAt      string          `json:"issuedAt"`
	ExpiresAt     string          `json:"expiresAt"`
	Payload       json.RawMessage `json:"payload"`
	Persistent    bool
}

type Publisher interface {
	Publish(context.Context, Envelope) error
}

type EventPublisher interface {
	PublishEvent(context.Context, Envelope) error
}

type DeliveryHandler func(Envelope) error

type subscriptionSetup func() (*amqp.Channel, string, <-chan amqp.Delivery, error)

type Subscription struct {
	mu          sync.Mutex
	channel     *amqp.Channel
	consumerTag string
	stop        chan struct{}
	done        chan struct{}
	once        sync.Once
}

func newResilientSubscription(ctx context.Context, setup subscriptionSetup, handler DeliveryHandler) (*Subscription, error) {
	channel, consumerTag, deliveries, err := setup()
	if err != nil {
		return nil, err
	}
	subscription := &Subscription{
		channel: channel, consumerTag: consumerTag,
		stop: make(chan struct{}), done: make(chan struct{}),
	}
	go subscription.run(ctx, setup, handler, deliveries)
	return subscription, nil
}

func (subscription *Subscription) run(ctx context.Context, setup subscriptionSetup, handler DeliveryHandler, deliveries <-chan amqp.Delivery) {
	defer close(subscription.done)
	backoff := 100 * time.Millisecond
	for {
		closed := false
		for {
			select {
			case <-ctx.Done():
				subscription.closeCurrent()
				return
			case <-subscription.stop:
				subscription.closeCurrent()
				return
			case delivery, ok := <-deliveries:
				if !ok {
					closed = true
				} else {
					var envelope Envelope
					if err := json.Unmarshal(delivery.Body, &envelope); err != nil {
						_ = delivery.Nack(false, false)
						continue
					}
					envelope.RoutingKey = delivery.RoutingKey
					if err := handler(envelope); err != nil {
						_ = delivery.Nack(false, true)
						continue
					}
					_ = delivery.Ack(false)
					continue
				}
			}
			if closed {
				break
			}
		}
		subscription.closeCurrent()
		select {
		case <-ctx.Done():
			return
		case <-subscription.stop:
			return
		case <-time.After(backoff):
		}
		channel, consumerTag, nextDeliveries, err := setup()
		if err != nil {
			if backoff < 2*time.Second {
				backoff *= 2
			}
			continue
		}
		subscription.mu.Lock()
		subscription.channel = channel
		subscription.consumerTag = consumerTag
		subscription.mu.Unlock()
		deliveries = nextDeliveries
		backoff = 100 * time.Millisecond
	}
}

func (subscription *Subscription) closeCurrent() {
	subscription.mu.Lock()
	channel := subscription.channel
	consumerTag := subscription.consumerTag
	subscription.channel = nil
	subscription.consumerTag = ""
	subscription.mu.Unlock()
	if channel != nil {
		_ = channel.Cancel(consumerTag, false)
		_ = channel.Close()
	}
}

func (subscription *Subscription) Close() error {
	subscription.once.Do(func() {
		close(subscription.stop)
		subscription.closeCurrent()
	})
	<-subscription.done
	return nil
}

type RabbitMQPublisher struct {
	connection    *amqp.Connection
	channel       *amqp.Channel
	url           string
	exchange      string
	eventExchange string
	deadExchange  string
	confirmations chan amqp.Confirmation
	publishMu     sync.Mutex
	connectionMu  sync.Mutex
}

// Ready reports whether the publisher has a live connection and confirmed
// channel. A closed channel is intentionally not considered ready: the next
// publish will reconnect, but readiness should stop the gateway from claiming
// broker-backed service availability during that recovery window.
func (publisher *RabbitMQPublisher) Ready() error {
	publisher.connectionMu.Lock()
	defer publisher.connectionMu.Unlock()
	if publisher.connection == nil || publisher.connection.IsClosed() {
		return fmt.Errorf("RabbitMQ connection is closed")
	}
	if publisher.channel == nil || publisher.channel.IsClosed() {
		return fmt.Errorf("RabbitMQ publisher channel is closed")
	}
	return nil
}

func NewRabbitMQPublisher(url, exchange string) (*RabbitMQPublisher, error) {
	connection, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("connect to RabbitMQ: %w", err)
	}
	channel, err := connection.Channel()
	if err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("open RabbitMQ channel: %w", err)
	}
	if err := channel.ExchangeDeclare(exchange, "topic", true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = connection.Close()
		return nil, fmt.Errorf("declare RabbitMQ exchange: %w", err)
	}
	eventExchange := exchange + ".events"
	if err := channel.ExchangeDeclare(eventExchange, "topic", true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = connection.Close()
		return nil, fmt.Errorf("declare RabbitMQ event exchange: %w", err)
	}
	deadExchange := exchange + ".dead"
	if err := channel.ExchangeDeclare(deadExchange, "topic", true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = connection.Close()
		return nil, fmt.Errorf("declare RabbitMQ dead-letter exchange: %w", err)
	}
	if err := channel.Confirm(false); err != nil {
		_ = channel.Close()
		_ = connection.Close()
		return nil, fmt.Errorf("enable RabbitMQ publisher confirms: %w", err)
	}
	confirmations := channel.NotifyPublish(make(chan amqp.Confirmation, 1))
	return &RabbitMQPublisher{connection: connection, channel: channel, url: url, exchange: exchange, eventExchange: eventExchange, deadExchange: deadExchange, confirmations: confirmations}, nil
}

func (publisher *RabbitMQPublisher) Publish(ctx context.Context, envelope Envelope) error {
	err := publisher.publish(ctx, publisher.exchange, envelope)
	if err == nil {
		return nil
	}
	if reconnectErr := publisher.reconnect(); reconnectErr != nil {
		return err
	}
	return publisher.publish(ctx, publisher.exchange, envelope)
}

func (publisher *RabbitMQPublisher) publish(ctx context.Context, exchange string, envelope Envelope) error {
	body, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode message envelope: %w", err)
	}
	publisher.publishMu.Lock()
	defer publisher.publishMu.Unlock()
	if err := publisher.channel.PublishWithContext(ctx, exchange, envelope.RoutingKey, false, false, amqp.Publishing{
		ContentType: "application/json", DeliveryMode: amqp.Persistent,
		MessageId: envelope.MessageID, CorrelationId: envelope.CorrelationID,
		Expiration: messageExpiration(envelope.ExpiresAt), Body: body,
	}); err != nil {
		return err
	}
	select {
	case confirmation, ok := <-publisher.confirmations:
		if !ok {
			return fmt.Errorf("RabbitMQ publisher confirmation channel closed")
		}
		if !confirmation.Ack {
			return fmt.Errorf("RabbitMQ broker negatively acknowledged message %q", envelope.MessageID)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (publisher *RabbitMQPublisher) PublishEvent(ctx context.Context, envelope Envelope) error {
	err := publisher.publish(ctx, publisher.eventExchange, envelope)
	if err == nil {
		return nil
	}
	if reconnectErr := publisher.reconnect(); reconnectErr != nil {
		return err
	}
	return publisher.publish(ctx, publisher.eventExchange, envelope)
}

func (publisher *RabbitMQPublisher) openChannel() (*amqp.Channel, error) {
	publisher.connectionMu.Lock()
	defer publisher.connectionMu.Unlock()
	if publisher.connection == nil {
		return nil, fmt.Errorf("RabbitMQ connection is closed")
	}
	return publisher.connection.Channel()
}

func (publisher *RabbitMQPublisher) DeclareAgentQueue(agentID string) error {
	channel, err := publisher.openChannel()
	if err != nil {
		return fmt.Errorf("open RabbitMQ queue channel: %w", err)
	}
	defer channel.Close()
	_, err = publisher.declareAgentQueue(channel, agentID)
	return err
}

func (publisher *RabbitMQPublisher) declareAgentQueue(channel *amqp.Channel, agentID string) (amqp.Queue, error) {
	queueName := "agent.command." + queueSegment(agentID)
	deadRoutingKey := "dead.command." + queueSegment(agentID)
	if err := publisher.declareDeadQueue(channel, "agent.command.dead."+queueSegment(agentID), deadRoutingKey); err != nil {
		return amqp.Queue{}, err
	}
	queue, err := channel.QueueDeclare(queueName, true, false, false, false, deadLetterArgs(publisher.deadExchange, deadRoutingKey))
	if err != nil {
		return amqp.Queue{}, fmt.Errorf("declare agent queue: %w", err)
	}
	if err := channel.QueueBind(queue.Name, "task.#."+agentID, publisher.exchange, false, nil); err != nil {
		return amqp.Queue{}, fmt.Errorf("bind agent queue: %w", err)
	}
	return queue, nil
}

func (publisher *RabbitMQPublisher) SubscribeAgent(ctx context.Context, agentID string, handler DeliveryHandler) (*Subscription, error) {
	return newResilientSubscription(ctx, func() (*amqp.Channel, string, <-chan amqp.Delivery, error) {
		channel, err := publisher.openChannel()
		if err != nil {
			return nil, "", nil, fmt.Errorf("open RabbitMQ consumer channel: %w", err)
		}
		queue, err := publisher.declareAgentQueue(channel, agentID)
		if err != nil {
			_ = channel.Close()
			return nil, "", nil, err
		}
		consumerTag := fmt.Sprintf("onclave-%s-%d", queueSegment(agentID), time.Now().UnixNano())
		deliveries, err := channel.Consume(queue.Name, consumerTag, false, false, false, false, nil)
		if err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("consume agent queue: %w", err)
		}
		return channel, consumerTag, deliveries, nil
	}, handler)
}

func (publisher *RabbitMQPublisher) SubscribeEvents(ctx context.Context, subscriberID, pattern string, handler DeliveryHandler) (*Subscription, error) {
	return newResilientSubscription(ctx, func() (*amqp.Channel, string, <-chan amqp.Delivery, error) {
		channel, err := publisher.openChannel()
		if err != nil {
			return nil, "", nil, fmt.Errorf("open RabbitMQ event channel: %w", err)
		}
		queueName := "agent.event." + queueSegment(subscriberID) + "." + queueSegment(pattern)
		deadRoutingKey := "dead.event." + queueSegment(subscriberID) + "." + queueSegment(pattern)
		if err := publisher.declareDeadQueue(channel, "agent.event.dead."+queueSegment(subscriberID)+"."+queueSegment(pattern), deadRoutingKey); err != nil {
			_ = channel.Close()
			return nil, "", nil, err
		}
		queue, err := channel.QueueDeclare(queueName, true, false, false, false, deadLetterArgs(publisher.deadExchange, deadRoutingKey))
		if err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("declare event queue: %w", err)
		}
		if err := channel.QueueBind(queue.Name, pattern, publisher.eventExchange, false, nil); err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("bind event queue: %w", err)
		}
		consumerTag := fmt.Sprintf("onclave-event-%s-%d", queueSegment(subscriberID), time.Now().UnixNano())
		deliveries, err := channel.Consume(queue.Name, consumerTag, false, false, false, false, nil)
		if err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("consume event queue: %w", err)
		}
		return channel, consumerTag, deliveries, nil
	}, handler)
}

func consumeDeliveries(ctx context.Context, subscription *Subscription, deliveries <-chan amqp.Delivery, handler DeliveryHandler) {
	for {
		select {
		case <-ctx.Done():
			_ = subscription.Close()
			return
		case delivery, ok := <-deliveries:
			if !ok {
				return
			}
			var envelope Envelope
			if err := json.Unmarshal(delivery.Body, &envelope); err != nil {
				_ = delivery.Nack(false, false)
				continue
			}
			envelope.RoutingKey = delivery.RoutingKey
			if err := handler(envelope); err != nil {
				_ = delivery.Nack(false, true)
				continue
			}
			_ = delivery.Ack(false)
		}
	}
}

func (publisher *RabbitMQPublisher) SubscribeDeadLetters(ctx context.Context, subscriberID string, handler DeliveryHandler) (*Subscription, error) {
	return newResilientSubscription(ctx, func() (*amqp.Channel, string, <-chan amqp.Delivery, error) {
		channel, err := publisher.openChannel()
		if err != nil {
			return nil, "", nil, fmt.Errorf("open RabbitMQ dead-letter channel: %w", err)
		}
		queue, err := channel.QueueDeclare("onclave.dead-letter."+queueSegment(subscriberID), true, false, false, false, nil)
		if err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("declare dead-letter observer queue: %w", err)
		}
		if err := channel.QueueBind(queue.Name, "#", publisher.deadExchange, false, nil); err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("bind dead-letter observer queue: %w", err)
		}
		consumerTag := fmt.Sprintf("onclave-dead-letter-%d", time.Now().UnixNano())
		deliveries, err := channel.Consume(queue.Name, consumerTag, false, false, false, false, nil)
		if err != nil {
			_ = channel.Close()
			return nil, "", nil, fmt.Errorf("consume dead-letter observer queue: %w", err)
		}
		return channel, consumerTag, deliveries, nil
	}, handler)
}

func (publisher *RabbitMQPublisher) declareDeadQueue(channel *amqp.Channel, queueName, routingKey string) error {
	queue, err := channel.QueueDeclare(queueName, true, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("declare dead-letter queue: %w", err)
	}
	if err := channel.QueueBind(queue.Name, routingKey, publisher.deadExchange, false, nil); err != nil {
		return fmt.Errorf("bind dead-letter queue: %w", err)
	}
	return nil
}

func deadLetterArgs(exchange, routingKey string) amqp.Table {
	return amqp.Table{"x-dead-letter-exchange": exchange, "x-dead-letter-routing-key": routingKey}
}

func messageExpiration(expiresAt string) string {
	if expiresAt == "" {
		return ""
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return ""
	}
	milliseconds := time.Until(expires).Milliseconds()
	if milliseconds < 1 {
		milliseconds = 1
	}
	return fmt.Sprintf("%d", milliseconds)
}

func queueSegment(agentID string) string {
	return strings.NewReplacer("/", "_", "\\", "_", " ", "_").Replace(agentID)
}

func (publisher *RabbitMQPublisher) reconnect() error {
	publisher.connectionMu.Lock()
	defer publisher.connectionMu.Unlock()
	connection, err := amqp.Dial(publisher.url)
	if err != nil {
		return fmt.Errorf("reconnect to RabbitMQ: %w", err)
	}
	channel, err := connection.Channel()
	if err != nil {
		_ = connection.Close()
		return fmt.Errorf("open RabbitMQ reconnect channel: %w", err)
	}
	for name, kind := range map[string]string{
		publisher.exchange:      "topic",
		publisher.eventExchange: "topic",
		publisher.deadExchange:  "topic",
	} {
		if err := channel.ExchangeDeclare(name, kind, true, false, false, false, nil); err != nil {
			_ = channel.Close()
			_ = connection.Close()
			return fmt.Errorf("declare RabbitMQ reconnect exchange: %w", err)
		}
	}
	if err := channel.Confirm(false); err != nil {
		_ = channel.Close()
		_ = connection.Close()
		return fmt.Errorf("enable RabbitMQ reconnect confirms: %w", err)
	}
	confirmations := channel.NotifyPublish(make(chan amqp.Confirmation, 1))
	oldConnection := publisher.connection
	oldChannel := publisher.channel
	publisher.connection = connection
	publisher.channel = channel
	publisher.confirmations = confirmations
	if oldChannel != nil {
		_ = oldChannel.Close()
	}
	if oldConnection != nil {
		_ = oldConnection.Close()
	}
	return nil
}

func (publisher *RabbitMQPublisher) Close() error {
	if publisher.channel != nil {
		if err := publisher.channel.Close(); err != nil {
			_ = publisher.connection.Close()
			return err
		}
	}
	if publisher.connection != nil {
		return publisher.connection.Close()
	}
	return nil
}
