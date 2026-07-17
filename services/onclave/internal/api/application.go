package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/traefikturkey/onclave/services/onclave/internal/admission"
	"github.com/traefikturkey/onclave/services/onclave/internal/messaging"
)

func NewApplicationServer(config Config, admissionService *admission.Service, messagingService *messaging.Service, readiness ReadinessCheck) *Server {
	server := NewServer(config, readiness)
	server.admission = admissionService
	server.messaging = messagingService
	return server
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("POST /v1/enroll", s.enroll)
	mux.HandleFunc("POST /v1/agents/{agentID}/approve", s.approve)
	mux.HandleFunc("POST /v1/agents/{agentID}/challenge", s.challenge)
	mux.HandleFunc("POST /v1/agents/{agentID}/authenticate", s.authenticate)
	mux.HandleFunc("POST /v1/agents/{agentID}/capabilities/request", s.requestCapabilities)
	mux.HandleFunc("POST /v1/agents/{agentID}/capabilities", s.acceptCapabilities)
	mux.HandleFunc("POST /v1/commands", s.submitCommand)
	mux.HandleFunc("GET /v1/tasks/{taskID}", s.taskStatus)
	mux.HandleFunc("POST /v1/tasks/{taskID}/ack", s.acknowledgeTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/start", s.startTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/progress", s.progressTask)
	mux.HandleFunc("POST /v1/tasks/{taskID}/complete", s.completeTask)
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
	if err := s.admission.Authenticate(request.PathValue("agentID"), signature); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) requestCapabilities(writer http.ResponseWriter, request *http.Request) {
	if s.admission == nil {
		writeError(writer, http.StatusServiceUnavailable, "admission service unavailable")
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

func (s *Server) submitCommand(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	var body submitCommandRequest
	if !decodeJSON(writer, request, &body) {
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
	task, err := s.messaging.Status(request.PathValue("taskID"))
	if err != nil {
		writeDomainError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, task)
}

func (s *Server) acknowledgeTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	s.taskMutation(writer, request, s.messaging.Acknowledge)
}

func (s *Server) startTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	s.taskMutation(writer, request, s.messaging.Start)
}

func (s *Server) cancelTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	s.taskMutation(writer, request, s.messaging.Cancel)
}

func (s *Server) progressTask(writer http.ResponseWriter, request *http.Request) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
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

func (s *Server) taskMutation(writer http.ResponseWriter, request *http.Request, mutate func(string) error) {
	if s.messaging == nil {
		writeError(writer, http.StatusServiceUnavailable, "messaging service unavailable")
		return
	}
	if err := mutate(request.PathValue("taskID")); err != nil {
		writeDomainError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, target any) bool {
	if err := json.NewDecoder(request.Body).Decode(target); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid JSON request")
		return false
	}
	return true
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
	case errors.Is(err, admission.ErrUnknownAgent), errors.Is(err, messaging.ErrTaskNotFound):
		status = http.StatusNotFound
	case errors.Is(err, admission.ErrNotApproved), errors.Is(err, admission.ErrRevoked), errors.Is(err, admission.ErrNotAuthenticated):
		status = http.StatusForbidden
	case errors.Is(err, admission.ErrAlreadyEnrolled):
		status = http.StatusConflict
	case errors.Is(err, messaging.ErrExpired):
		status = http.StatusUnprocessableEntity
	}
	writeError(writer, status, err.Error())
}
