package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"ember/internal/edgeproto"
)

const taskTimeout = 10 * time.Second

// fanOut sends a task to every edge server it names, concurrently. One connector failing does not
// stop the others; each gets its own result, in the task's order.
func (m *Manager) fanOut(ctx context.Context, task edgeproto.EdgeTask) edgeproto.EdgeTaskResult {
	out := edgeproto.EdgeTaskResult{RunID: task.RunID, Results: make([]edgeproto.EdgeServerTaskResult, len(task.EdgeServers))}
	var wg sync.WaitGroup
	for i, site := range task.EdgeServers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := edgeproto.EdgeServerTaskResult{EdgeServerID: site.EdgeServerID}
			drones, err := m.sendTask(ctx, site.URL, task.ConnectorTaskFor(site))
			if err != nil {
				res.Error = fmt.Sprintf("edge server %s: %v", site.EdgeServerID, err)
				m.log.Warn("task not taken", "kind", task.Kind, "run", task.RunID, "edgeServer", site.EdgeServerID, "err", err)
			} else {
				res.OK, res.Drones = true, drones
			}
			out.Results[i] = res
		}()
	}
	wg.Wait()
	return out
}

func (m *Manager) sendTask(ctx context.Context, connectorURL string, task edgeproto.ConnectorTask) ([]string, error) {
	body, err := json.Marshal(task)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, taskTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(connectorURL, "/")+edgeproto.TaskPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	edgeproto.SetKey(req.Header, m.key)
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var e edgeproto.ErrorBody
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			return nil, fmt.Errorf("%d: %s", resp.StatusCode, e.Error)
		}
		return nil, fmt.Errorf("%d", resp.StatusCode)
	}
	var res edgeproto.ConnectorTaskResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("answer: %w", err)
	}
	return res.Drones, nil
}
