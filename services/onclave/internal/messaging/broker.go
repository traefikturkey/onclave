package messaging

import (
	"context"
	"encoding/json"
	"fmt"

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

type RabbitMQPublisher struct {
	connection *amqp.Connection
	channel    *amqp.Channel
	exchange   string
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
	return &RabbitMQPublisher{connection: connection, channel: channel, exchange: exchange}, nil
}

func (publisher *RabbitMQPublisher) Publish(ctx context.Context, envelope Envelope) error {
	body, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode message envelope: %w", err)
	}
	return publisher.channel.PublishWithContext(ctx, publisher.exchange, envelope.RoutingKey, false, false, amqp.Publishing{
		ContentType:   "application/json",
		DeliveryMode:  amqp.Persistent,
		MessageId:     envelope.MessageID,
		CorrelationId: envelope.CorrelationID,
		Expiration:    "",
		Body:          body,
	})
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
