package messaging

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
	return metrics
}
