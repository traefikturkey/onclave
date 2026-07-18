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

type Subscription struct {
	channel     *amqp.Channel
	consumerTag string
	once        sync.Once
}

func (subscription *Subscription) Close() error {
	var err error
	subscription.once.Do(func() {
		if subscription.channel != nil {
			if cancelErr := subscription.channel.Cancel(subscription.consumerTag, false); cancelErr != nil {
				err = cancelErr
			}
			err = subscription.channel.Close()
		}
	})
	return err
}

type RabbitMQPublisher struct {
	connection    *amqp.Connection
	channel       *amqp.Channel
	exchange      string
	eventExchange string
	deadExchange  string
	confirmations chan amqp.Confirmation
	publishMu     sync.Mutex
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
	return &RabbitMQPublisher{connection: connection, channel: channel, exchange: exchange, eventExchange: eventExchange, deadExchange: deadExchange, confirmations: confirmations}, nil
}

func (publisher *RabbitMQPublisher) Publish(ctx context.Context, envelope Envelope) error {
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
	return publisher.publish(ctx, publisher.eventExchange, envelope)
}

func (publisher *RabbitMQPublisher) DeclareAgentQueue(agentID string) error {
	channel, err := publisher.connection.Channel()
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
	channel, err := publisher.connection.Channel()
	if err != nil {
		return nil, fmt.Errorf("open RabbitMQ consumer channel: %w", err)
	}
	queue, err := publisher.declareAgentQueue(channel, agentID)
	if err != nil {
		_ = channel.Close()
		return nil, err
	}
	consumerTag := fmt.Sprintf("onclave-%s-%d", queueSegment(agentID), time.Now().UnixNano())
	deliveries, err := channel.Consume(queue.Name, consumerTag, false, false, false, false, nil)
	if err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("consume agent queue: %w", err)
	}
	subscription := &Subscription{channel: channel, consumerTag: consumerTag}
	go consumeDeliveries(ctx, subscription, deliveries, handler)
	return subscription, nil
}

func (publisher *RabbitMQPublisher) SubscribeEvents(ctx context.Context, subscriberID, pattern string, handler DeliveryHandler) (*Subscription, error) {
	channel, err := publisher.connection.Channel()
	if err != nil {
		return nil, fmt.Errorf("open RabbitMQ event channel: %w", err)
	}
	queueName := "agent.event." + queueSegment(subscriberID) + "." + queueSegment(pattern)
	deadRoutingKey := "dead.event." + queueSegment(subscriberID) + "." + queueSegment(pattern)
	if err := publisher.declareDeadQueue(channel, "agent.event.dead."+queueSegment(subscriberID)+"."+queueSegment(pattern), deadRoutingKey); err != nil {
		_ = channel.Close()
		return nil, err
	}
	queue, err := channel.QueueDeclare(queueName, true, false, false, false, deadLetterArgs(publisher.deadExchange, deadRoutingKey))
	if err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("declare event queue: %w", err)
	}
	if err := channel.QueueBind(queue.Name, pattern, publisher.eventExchange, false, nil); err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("bind event queue: %w", err)
	}
	consumerTag := fmt.Sprintf("onclave-event-%s-%d", queueSegment(subscriberID), time.Now().UnixNano())
	deliveries, err := channel.Consume(queue.Name, consumerTag, false, false, false, false, nil)
	if err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("consume event queue: %w", err)
	}
	subscription := &Subscription{channel: channel, consumerTag: consumerTag}
	go consumeDeliveries(ctx, subscription, deliveries, handler)
	return subscription, nil
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

func (publisher *RabbitMQPublisher) SubscribeDeadLetters(ctx context.Context, handler DeliveryHandler) (*Subscription, error) {
	channel, err := publisher.connection.Channel()
	if err != nil {
		return nil, fmt.Errorf("open RabbitMQ dead-letter channel: %w", err)
	}
	queue, err := channel.QueueDeclare("onclave.dead-letter", true, false, false, false, nil)
	if err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("declare dead-letter observer queue: %w", err)
	}
	if err := channel.QueueBind(queue.Name, "#", publisher.deadExchange, false, nil); err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("bind dead-letter observer queue: %w", err)
	}
	consumerTag := fmt.Sprintf("onclave-dead-letter-%d", time.Now().UnixNano())
	deliveries, err := channel.Consume(queue.Name, consumerTag, false, false, false, false, nil)
	if err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("consume dead-letter observer queue: %w", err)
	}
	subscription := &Subscription{channel: channel, consumerTag: consumerTag}
	go consumeDeliveries(ctx, subscription, deliveries, handler)
	return subscription, nil
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
