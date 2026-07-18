package messaging

type MetricsStore interface {
	Metrics() map[string]int64
}

func (s *Service) Metrics() map[string]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	metrics := map[string]int64{
		"onclave_tasks_in_memory":  int64(len(s.tasks)),
		"onclave_events_in_memory": 0,
	}
	for _, events := range s.events {
		metrics["onclave_events_in_memory"] += int64(len(events))
	}
	for _, task := range s.tasks {
		metrics["onclave_tasks_state_"+string(task.State)]++
	}
	if store, ok := s.store.(MetricsStore); ok {
		for name, value := range store.Metrics() {
			metrics[name] = value
		}
	}
	return metrics
}
