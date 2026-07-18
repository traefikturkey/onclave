package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func NewApplicationServer(config Config, admissionService *admission.Service, messagingService *messaging.Service, readiness ReadinessCheck) *Server {
	return NewApplicationServerWithBroker(config, admissionService, messagingService, nil, readiness)
}

func NewApplicationServerWithBroker(config Config, admissionService *admission.Service, messagingService *messaging.Service, subscriber agentSubscriber, readiness ReadinessCheck) *Server {
	server := NewServer(config, readiness)
	server.admission = admissionService
	server.messaging = messagingService
	server.subscriber = subscriber
	if eventSource, ok := subscriber.(eventSubscriber); ok {
		server.events = eventSource
	}
	return server
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("POST /v1/enroll", s.enroll)
	mux.HandleFunc("POST /v1/agents/{agentID}/approve", s.approve)
	mux.HandleFunc("POST /v1/agents/{agentID}/revoke", s.revoke)
	mux.HandleFunc("POST /v1/agents/{agentID}/challenge", s.challenge)
	mux.HandleFunc("POST /v1/agents/{agentID}/authenticate", s.authenticate)
	mux.HandleFunc("POST /v1/agents/{agentID}/capabilities/request", s.requestCapabilities)
	mux.HandleFunc("POST /v1/agents/{agentID}/capabilities", s.acceptCapabilities)
	mux.HandleFunc("GET /v1/agents/{agentID}/session", s.agentSession)
	mux.HandleFunc("POST /v1/subscriptions", s.createSubscription)
	mux.HandleFunc("GET /v1/subscriptions/{subscriptionID}", s.getSubscription)
	mux.HandleFunc("POST /v1/subscriptions/{subscriptionID}/renew", s.renewSubscription)
	mux.HandleFunc("POST /v1/subscriptions/{subscriptionID}/cursor", s.updateSubscriptionCursor)
	mux.HandleFunc("DELETE /v1/subscriptions/{subscriptionID}", s.deleteSubscription)
	mux.HandleFunc("POST /v1/commands", s.submitCommand)
	mux.HandleFunc("GET /v1/tasks/{taskID}", s.taskStatus)
	mux.HandleFunc("GET /v1/tasks/{taskID}/events", s.taskEvents)
	mux.HandleFunc("POST /v1/tasks/{taskID}/ack", s.acknowledgeTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/start", s.startTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/progress", s.progressTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/complete", s.completeTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/fail", s.failTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/cancel", s.cancelTask)
	return mux
}

type enrollRequest struct {
	AgentID     string `json:"agentId"`
	RuntimeType string `json:"runtimeType"`
	PublicKey   string `json:"publicKey"`
}

func (s *Server) enroll(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	var body enrollRequest
	if !decodeJSON(writer, request, &body) {
		return
	}
	publicKey, err := base64.StdEncoding.DecodeString(body.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		writeError(writer, http.StatusBadRequest, "publicKey must be base64 encoded Ed25519 public key")
		return
	}
	if err := s.admission.Enroll(admission.EnrollmentRequest{AgentID: body.AgentID, RuntimeType: body.RuntimeType, PublicKey: ed25519.PublicKey(publicKey)}); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusCreated)
}

func (s *Server) approve(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	if err := s.admission.Approve(request.PathValue("agentID")); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) revoke(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	if err := s.admission.Revoke(request.PathValue("agentID")); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) challenge(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	nonce, err := s.admission.IssueChallenge(request.PathValue("agentID"))
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"nonce": base64.StdEncoding.EncodeToString(nonce)})
}

func (s *Server) authenticate(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	var body struct {
		Signature string `json:"signature"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	signature, err := base64.StdEncoding.DecodeString(body.Signature)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "signature must be base64 encoded")
		return
	}
	token, err := s.admission.AuthenticateSession(request.PathValue("agentID"), signature)
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"sessionToken": token})
}

func (s *Server) requestCapabilities(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	if !s.requireSession(writer, request, request.PathValue("agentID")) {
		return
	}
	requestID, nonce, err := s.admission.RequestCapabilities(request.PathValue("agentID"))
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"requestId": requestID, "nonce": nonce})
}

func (s *Server) acceptCapabilities(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return
	}
	if !s.requireSession(writer, request, request.PathValue("agentID")) {
		return
	}
	var body struct {
		RequestID    string   `json:"requestId"`
		Nonce        string   `json:"nonce"`
		Capabilities []string `json:"capabilities"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	if err := s.admission.AcceptCapabilities(request.PathValue("agentID"), body.RequestID, body.Nonce, body.Capabilities); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

type submitCommandRequest struct {
	MessageID     string         `json:"messageId"`
	TaskID        string         `json:"taskId"`
	CorrelationID string         `json:"correlationId"`
	SourceAgentID string         `json:"sourceAgentId"`
	TargetAgentID string         `json:"targetAgentId"`
	Type          string         `json:"type"`
	ExpiresAt     time.Time      `json:"expiresAt"`
	Payload       map[string]any `json:"payload"`
}

type subscriptionRequest struct {
	Pattern       string    `json:"pattern"`
	CorrelationID string    `json:"correlationId"`
	TaskID        string    `json:"taskId"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

func (s *Server) createSubscription(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	agentID, ok := s.authenticatedAgent(writer, request)
	if !ok || !s.requireCapability(writer, agentID, "message.receive") {
		return
	}
	var body subscriptionRequest
	if !decodeJSON(writer, request, &body) {
		return
	}
	if body.ExpiresAt.IsZero() {
		body.ExpiresAt = time.Now().Add(time.Hour)
	}
	subscription, err := s.messaging.CreateSubscription(agentID, body.Pattern, body.CorrelationID, body.TaskID, body.ExpiresAt)
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, subscription)
}

func (s *Server) getSubscription(writer http.ResponseWriter, request *http.Request) {
	agentID, ok := s.authenticatedAgent(writer, request)
	if !ok || !s.messagingAvailable(writer) {
		return
	}
	subscription, err := s.messaging.GetSubscription(request.PathValue("subscriptionID"))
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	if subscription.AgentID != agentID {
		writeError(writer, http.StatusForbidden, "agent is not authorized for this subscription")
		return
	}
	writeJSON(writer, http.StatusOK, subscription)
}

func (s *Server) renewSubscription(writer http.ResponseWriter, request *http.Request) {
	agentID, ok := s.authenticatedAgent(writer, request)
	if !ok || !s.messagingAvailable(writer) {
		return
	}
	if !s.requireCapability(writer, agentID, "message.receive") {
		return
	}
	var body struct {
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	subscription, err := s.messaging.RenewSubscription(request.PathValue("subscriptionID"), agentID, body.ExpiresAt)
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, subscription)
}

func (s *Server) updateSubscriptionCursor(writer http.ResponseWriter, request *http.Request) {
	agentID, ok := s.authenticatedAgent(writer, request)
	if !ok || !s.messagingAvailable(writer) {
		return
	}
	if !s.requireCapability(writer, agentID, "message.receive") {
		return
	}
	var body struct {
		Cursor int `json:"cursor"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	subscription, err := s.messaging.UpdateSubscriptionCursor(request.PathValue("subscriptionID"), agentID, body.Cursor)
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, subscription)
}

func (s *Server) deleteSubscription(writer http.ResponseWriter, request *http.Request) {
	agentID, ok := s.authenticatedAgent(writer, request)
	if !ok || !s.messagingAvailable(writer) {
		return
	}
	if !s.requireCapability(writer, agentID, "message.receive") {
		return
	}
	if err := s.messaging.DeleteSubscription(request.PathValue("subscriptionID"), agentID); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) messagingAvailable(writer http.ResponseWriter) bool {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return false
	}
	return true
}

func (s *Server) authenticatedAgent(writer http.ResponseWriter, request *http.Request) (string, bool) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return "", false
	}
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if len(authorization) <= len(prefix) || authorization[:len(prefix)] != prefix {
		writeError(writer, http.StatusUnauthorized, "Bearer session token required")
		return "", false
	}
	agentID, err := s.admission.AgentForSession(authorization[len(prefix):])
	if err != nil {
		writeDomainError(writer, err)
		return "", false
	}
	return agentID, true
}

func (s *Server) submitCommand(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	var body submitCommandRequest
	if !decodeJSON(writer, request, &body) {
		return
	}
	if !s.requireSession(writer, request, body.SourceAgentID) {
		return
	}
	if !s.requireCapability(writer, body.SourceAgentID, "message.send") {
		return
	}
	task, err := s.messaging.Submit(messaging.Command{
		MessageID: body.MessageID, TaskID: body.TaskID, CorrelationID: body.CorrelationID,
		SourceAgentID: body.SourceAgentID, TargetAgentID: body.TargetAgentID, Type: body.Type,
		ExpiresAt: body.ExpiresAt, Payload: body.Payload,
	})
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, task)
}

func (s *Server) taskStatus(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if _, ok := s.requireTaskSession(writer, request, request.PathValue("taskID"), true); !ok {
		return
	}
	task, err := s.messaging.Status(request.PathValue("taskID"))
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, task)
}

func (s *Server) taskEvents(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if _, ok := s.requireTaskSession(writer, request, request.PathValue("taskID"), true); !ok {
		return
	}
	events := s.messaging.Events(request.PathValue("taskID"))
	totalEvents := len(events)
	query := request.URL.Query()
	after := 0
	if value := query.Get("after"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 {
			writeError(writer, http.StatusBadRequest, "after must be a non-negative integer")
			return
		}
		after = parsed
	}
	limit := len(events)
	if value := query.Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 || parsed > 500 {
			writeError(writer, http.StatusBadRequest, "limit must be between 1 and 500")
			return
		}
		limit = parsed
	}
	if after >= len(events) {
		events = []messaging.Event{}
	} else {
		end := after + limit
		if end > len(events) {
			end = len(events)
		}
		events = events[after:end]
		if end < totalEvents {
			writer.Header().Set("X-Next-After", strconv.Itoa(end))
		}
	}
	writeJSON(writer, http.StatusOK, events)
}

func (s *Server) acknowledgeTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	s.taskMutation(writer, request, s.messaging.Acknowledge, false)
}

func (s *Server) startTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	s.taskMutation(writer, request, s.messaging.Start, false)
}

func (s *Server) cancelTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	s.taskMutation(writer, request, s.messaging.Cancel, true)
}

func (s *Server) progressTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if _, ok := s.requireTaskSession(writer, request, request.PathValue("taskID"), false); !ok {
		return
	}
	var body struct {
		Progress int    `json:"progress"`
		Note     string `json:"note"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	if err := s.messaging.Progress(request.PathValue("taskID"), body.Progress, body.Note); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) completeTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if _, ok := s.requireTaskSession(writer, request, request.PathValue("taskID"), false); !ok {
		return
	}
	var body struct {
		Result map[string]any `json:"result"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	if err := s.messaging.Complete(request.PathValue("taskID"), body.Result); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) failTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if _, ok := s.requireTaskSession(writer, request, request.PathValue("taskID"), false); !ok {
		return
	}
	var body struct {
		Result map[string]any `json:"result"`
	}
	if !decodeJSON(writer, request, &body) {
		return
	}
	if err := s.messaging.Fail(request.PathValue("taskID"), body.Result); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) taskMutation(writer http.ResponseWriter, request *http.Request, mutate func(string) error, allowSource bool) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if _, ok := s.requireTaskSession(writer, request, request.PathValue("taskID"), allowSource); !ok {
		return
	}
	if err := mutate(request.PathValue("taskID")); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, target any) bool {
	request.Body = http.MaxBytesReader(writer, request.Body, 1<<20)
	decoder := json.NewDecoder(request.Body)
	if err := decoder.Decode(target); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid JSON request")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(writer, http.StatusBadRequest, "request must contain one JSON value")
		return false
	}
	return true
}

func (s *Server) requireSession(writer http.ResponseWriter, request *http.Request, agentID string) bool {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
		return false
	}
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if len(authorization) <= len(prefix) || authorization[:len(prefix)] != prefix {
		writeError(writer, http.StatusUnauthorized, "Bearer session token required")
		return false
	}
	if err := s.admission.AuthorizeSession(agentID, authorization[len(prefix):]); err != nil {
		writeDomainError(writer, err)
		return false
	}
	return true
}

func (s *Server) requireCapability(writer http.ResponseWriter, agentID, capability string) bool {
	if err := s.admission.HasCapability(agentID, capability); err != nil {
		writeDomainError(writer, err)
		return false
	}
	return true
}

func (s *Server) requireTaskSession(writer http.ResponseWriter, request *http.Request, taskID string, allowSource bool) (messaging.Task, bool) {
	if s.admission == nil || s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "task services unavailable")
		return messaging.Task{}, false
	}
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if len(authorization) <= len(prefix) || authorization[:len(prefix)] != prefix {
		writeError(writer, http.StatusUnauthorized, "Bearer session token required")
		return messaging.Task{}, false
	}
	agentID, err := s.admission.AgentForSession(authorization[len(prefix):])
	if err != nil {
		writeDomainError(writer, err)
		return messaging.Task{}, false
	}
	task, err := s.messaging.Status(taskID)
	if err != nil {
		writeDomainError(writer, err)
		return messaging.Task{}, false
	}
	if agentID != task.TargetAgentID && (!allowSource || agentID != task.SourceAgentID) {
		writeError(writer, http.StatusForbidden, "agent is not authorized for this task")
		return messaging.Task{}, false
	}
	requiredCapability := "message.receive"
	if allowSource && agentID == task.SourceAgentID {
		requiredCapability = "message.send"
	}
	if err := s.admission.HasCapability(agentID, requiredCapability); err != nil {
		writeDomainError(writer, err)
		return messaging.Task{}, false
	}
	return task, true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}

func writeDomainError(writer http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, admission.ErrInvalidSession):
		status = http.StatusUnauthorized
	case errors.Is(err, admission.ErrUnknownAgent), errors.Is(err, messaging.ErrTaskNotFound):
		status = http.StatusNotFound
	case errors.Is(err, admission.ErrNotApproved), errors.Is(err, admission.ErrRevoked), errors.Is(err, admission.ErrNotAuthenticated):
		status = http.StatusForbidden
	case errors.Is(err, admission.ErrAlreadyEnrolled):
		status = http.StatusConflict
	case errors.Is(err, messaging.ErrExpired):
		status = http.StatusUnprocessableEntity
	case errors.Is(err, messaging.ErrSubscriptionNotFound):
		status = http.StatusNotFound
	case errors.Is(err, messaging.ErrSubscriptionUnauthorized):
		status = http.StatusForbidden
	case errors.Is(err, messaging.ErrSubscriptionStoreUnavailable):
		status = http.StatusServiceUnavailable
	case errors.Is(err, messaging.ErrSubscriptionExpired):
		status = http.StatusGone
	}
	writeError(writer, status, err.Error())
}
