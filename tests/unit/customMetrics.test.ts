import { CustomMetrics } from '../../src/utils/customMetrics';

describe('CustomMetrics', () => {
  let metrics: CustomMetrics;

  beforeEach(() => {
    metrics = new CustomMetrics();
  });

  describe('Counter Metrics', () => {
    it('should increment counter', () => {
      metrics.incrementCounter('test_counter', 1);
      expect(metrics.getCounter('test_counter')).toBe(1);
    });

    it('should accumulate counter values', () => {
      metrics.incrementCounter('test_counter', 5);
      metrics.incrementCounter('test_counter', 3);
      metrics.incrementCounter('test_counter', 2);
      expect(metrics.getCounter('test_counter')).toBe(10);
    });

    it('should support labels', () => {
      metrics.incrementCounter('requests', 1, { endpoint: '/api' });
      metrics.incrementCounter('requests', 1, { endpoint: '/users' });
      metrics.incrementCounter('requests', 1, { endpoint: '/api' });
      
      expect(metrics.getCounter('requests', { endpoint: '/api' })).toBe(2);
      expect(metrics.getCounter('requests', { endpoint: '/users' })).toBe(1);
    });

    it('should default to increment by 1', () => {
      metrics.incrementCounter('default_counter');
      expect(metrics.getCounter('default_counter')).toBe(1);
    });

    it('should handle multiple labels', () => {
      metrics.incrementCounter('requests', 1, { 
        endpoint: '/api', 
        method: 'GET',
        status: '200'
      });
      
      expect(metrics.getCounter('requests', { 
        endpoint: '/api', 
        method: 'GET',
        status: '200'
      })).toBe(1);
    });
  });

  describe('Gauge Metrics', () => {
    it('should set gauge value', () => {
      metrics.setGauge('connections', 42);
      expect(metrics.getGauge('connections')).toBe(42);
    });

    it('should overwrite previous value', () => {
      metrics.setGauge('connections', 10);
      metrics.setGauge('connections', 20);
      expect(metrics.getGauge('connections')).toBe(20);
    });

    it('should support labels', () => {
      metrics.setGauge('queue_size', 100, { queue: 'high' });
      metrics.setGauge('queue_size', 50, { queue: 'low' });
      
      expect(metrics.getGauge('queue_size', { queue: 'high' })).toBe(100);
      expect(metrics.getGauge('queue_size', { queue: 'low' })).toBe(50);
    });

    it('should return 0 for non-existent gauge', () => {
      expect(metrics.getGauge('nonexistent')).toBe(0);
    });
  });

  describe('Histogram Metrics', () => {
    it('should record histogram values', () => {
      metrics.recordHistogram('duration', 100);
      metrics.recordHistogram('duration', 200);
      metrics.recordHistogram('duration', 150);
      
      const stats = metrics.getHistogramStats('duration');
      expect(stats).toBeDefined();
      expect(stats!.count).toBe(3);
      expect(stats!.min).toBe(100);
      expect(stats!.max).toBe(200);
    });

    it('should calculate correct statistics', () => {
      for (let i = 1; i <= 100; i++) {
        metrics.recordHistogram('test', i);
      }

      const stats = metrics.getHistogramStats('test');
      expect(stats!.count).toBe(100);
      expect(stats!.min).toBe(1);
      expect(stats!.max).toBe(100);
      expect(stats!.avg).toBe(50.5);
      // p50 uses nearest rank method: sorted[floor(100 * 0.5)] = sorted[50] = 51
      expect(stats!.p50).toBe(51);
    });

    it('should calculate percentiles', () => {
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      values.forEach(v => metrics.recordHistogram('test', v));

      const stats = metrics.getHistogramStats('test');
      // Using nearest rank method on sorted array [10,20,30,40,50,60,70,80,90,100]
      // p50 = sorted[floor(10 * 0.5)] = sorted[5] = 60
      // p95 = sorted[floor(10 * 0.95)] = sorted[9] = 100
      // p99 = sorted[floor(10 * 0.99)] = sorted[9] = 100
      expect(stats!.p50).toBe(60);
      expect(stats!.p95).toBe(100);
      expect(stats!.p99).toBe(100);
    });

    it('should limit histogram size to 1000', () => {
      for (let i = 0; i < 1500; i++) {
        metrics.recordHistogram('test', i);
      }
      
      const stats = metrics.getHistogramStats('test');
      expect(stats!.count).toBeLessThanOrEqual(1000);
    });

    it('should support labels', () => {
      metrics.recordHistogram('latency', 100, { endpoint: '/api' });
      metrics.recordHistogram('latency', 200, { endpoint: '/users' });
      
      const apiStats = metrics.getHistogramStats('latency', { endpoint: '/api' });
      const usersStats = metrics.getHistogramStats('latency', { endpoint: '/users' });
      
      expect(apiStats!.avg).toBe(100);
      expect(usersStats!.avg).toBe(200);
    });

    it('should return null for non-existent histogram', () => {
      expect(metrics.getHistogramStats('nonexistent')).toBeNull();
    });
  });

  describe('getAllMetrics', () => {
    it('should return all metrics', () => {
      metrics.incrementCounter('counter1', 5);
      metrics.setGauge('gauge1', 42);
      metrics.recordHistogram('hist1', 100);
      
      const all = metrics.getAllMetrics();
      expect(all.length).toBeGreaterThan(0);
      
      const types = all.map(m => m.type);
      expect(types).toContain('counter');
      expect(types).toContain('gauge');
      expect(types).toContain('summary'); // histograms are exported as summary
    });

    it('should include timestamps', () => {
      metrics.incrementCounter('test', 1);
      const all = metrics.getAllMetrics();
      
      expect(all[0].timestamp).toBeDefined();
      expect(all[0].timestamp).toBeGreaterThan(0);
    });
  });

  describe('Prometheus Export', () => {
    it('should export counters in Prometheus format', () => {
      metrics.incrementCounter('http_requests_total', 100);
      const prom = metrics.toPrometheus();
      
      expect(prom).toContain('# HELP http_requests_total');
      expect(prom).toContain('# TYPE http_requests_total counter');
      expect(prom).toContain('http_requests_total 100');
    });

    it('should export gauges in Prometheus format', () => {
      metrics.setGauge('active_connections', 42);
      const prom = metrics.toPrometheus();
      
      expect(prom).toContain('# HELP active_connections');
      expect(prom).toContain('# TYPE active_connections gauge');
      expect(prom).toContain('active_connections 42');
    });

    it('should export histograms in Prometheus format', () => {
      metrics.recordHistogram('request_duration_ms', 100);
      metrics.recordHistogram('request_duration_ms', 200);
      
      const prom = metrics.toPrometheus();
      
      expect(prom).toContain('# HELP request_duration_ms');
      expect(prom).toContain('# TYPE request_duration_ms histogram');
      expect(prom).toContain('request_duration_ms_bucket');
      expect(prom).toContain('request_duration_ms_sum');
      expect(prom).toContain('request_duration_ms_count');
    });

    it('should include labels in Prometheus format', () => {
      metrics.incrementCounter('requests', 1, { method: 'GET', status: '200' });
      const prom = metrics.toPrometheus();
      
      expect(prom).toContain('requests{');
      expect(prom).toContain('method="GET"');
      expect(prom).toContain('status="200"');
    });

    it('should be valid Prometheus format', () => {
      metrics.incrementCounter('test', 1);
      const prom = metrics.toPrometheus();
      
      // Should end with newline
      expect(prom.endsWith('\n')).toBe(true);
      
      // Should have metric names that are valid
      const lines = prom.split('\n').filter(l => !l.startsWith('#') && l.trim());
      lines.forEach(line => {
        expect(/^[a-z_]+/.test(line)).toBe(true);
      });
    });
  });

  describe('clear', () => {
    it('should clear all metrics', () => {
      metrics.incrementCounter('counter', 10);
      metrics.setGauge('gauge', 20);
      metrics.recordHistogram('hist', 30);
      
      metrics.clear();
      
      expect(metrics.getCounter('counter')).toBe(0);
      expect(metrics.getGauge('gauge')).toBe(0);
      expect(metrics.getHistogramStats('hist')).toBeNull();
    });
  });

  describe('Label Handling', () => {
    it('should sort labels consistently', () => {
      metrics.incrementCounter('test', 1, { b: '2', a: '1' });
      metrics.incrementCounter('test', 1, { a: '1', b: '2' });
      
      expect(metrics.getCounter('test', { a: '1', b: '2' })).toBe(2);
      expect(metrics.getCounter('test', { b: '2', a: '1' })).toBe(2);
    });

    it('should handle empty labels', () => {
      metrics.incrementCounter('test', 1);
      metrics.incrementCounter('test', 1, {});
      
      expect(metrics.getCounter('test')).toBe(2);
    });
  });

  describe('Performance', () => {
    it('should handle many metrics efficiently', () => {
      const start = Date.now();
      
      for (let i = 0; i < 1000; i++) {
        metrics.incrementCounter('test', 1);
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // Should be very fast
    });

    it('should handle many labels efficiently', () => {
      const start = Date.now();
      
      for (let i = 0; i < 100; i++) {
        metrics.incrementCounter('test', 1, {
          label1: `value${i}`,
          label2: `value${i}`,
          label3: `value${i}`
        });
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100);
    });
  });
});
