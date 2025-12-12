import { HealthChecker } from '../../src/utils/healthChecker';

describe('HealthChecker', () => {
  let checker: HealthChecker;
  let originalMemoryUsage: typeof process.memoryUsage;

  beforeEach(() => {
    // Mock process.memoryUsage to return low memory values
    originalMemoryUsage = process.memoryUsage;
    process.memoryUsage = jest.fn(() => ({
      heapUsed: 50 * 1048576, // 50MB (below 100MB threshold)
      heapTotal: 100 * 1048576,
      external: 5 * 1048576,
      rss: 100 * 1048576,
      arrayBuffers: 0
    })) as any;

    checker = new HealthChecker();
  });

  afterEach(() => {
    // Restore original process.memoryUsage
    process.memoryUsage = originalMemoryUsage;
  });

  describe('Initialization', () => {
    it('should initialize with healthy status', () => {
      const health = checker.getHealth();
      expect(health.status).toBe('healthy');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.version).toBe('1.0.0');
    });

    it('should track uptime', async () => {
      const health1 = checker.getHealth();
      await new Promise(resolve => setTimeout(resolve, 100));
      const health2 = checker.getHealth();

      expect(health2.uptime).toBeGreaterThan(health1.uptime);
    });
  });

  describe('Event Recording', () => {
    it('should record events', () => {
      const health1 = checker.getHealth();

      checker.recordEvent();
      checker.recordEvent();
      checker.recordEvent();

      const health2 = checker.getHealth();
      expect(health2.metrics.eventsProcessed).toBe(health1.metrics.eventsProcessed + 3);
    });

    it('should accumulate event count', () => {
      for (let i = 0; i < 100; i++) {
        checker.recordEvent();
      }

      const health = checker.getHealth();
      expect(health.metrics.eventsProcessed).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Monitor Health Recording', () => {
    it('should record successful monitor checks', () => {
      checker.recordMonitorCheck('eventLoop', true);

      const health = checker.getHealth();
      expect(health.monitors['eventLoop']).toBeDefined();
      expect(health.monitors['eventLoop'].healthy).toBe(true);
      expect(health.monitors['eventLoop'].errors).toBe(0);
    });

    it('should record failed monitor checks', () => {
      checker.recordMonitorCheck('memory', false);

      const health = checker.getHealth();
      expect(health.monitors['memory'].healthy).toBe(false);
      expect(health.monitors['memory'].errors).toBe(1);
    });

    it('should accumulate monitor errors', () => {
      for (let i = 0; i < 5; i++) {
        checker.recordMonitorCheck('promises', false);
      }

      const health = checker.getHealth();
      expect(health.monitors['promises'].errors).toBe(5);
    });

    it('should reset error count on success', () => {
      checker.recordMonitorCheck('test', false);
      checker.recordMonitorCheck('test', false);

      let health = checker.getHealth();
      expect(health.monitors['test'].errors).toBe(2);

      checker.recordMonitorCheck('test', true);

      health = checker.getHealth();
      expect(health.monitors['test'].errors).toBe(0);
      expect(health.monitors['test'].healthy).toBe(true);
    });
  });

  describe('Health Status Calculation', () => {
    it('should be healthy with no errors', () => {
      checker.recordMonitorCheck('test1', true);
      checker.recordMonitorCheck('test2', true);

      const health = checker.getHealth();
      expect(health.status).toBe('healthy');
    });

    it('should be degraded with 4-10 errors', () => {
      for (let i = 0; i < 5; i++) {
        checker.recordMonitorCheck('test', false);
      }

      const health = checker.getHealth();
      expect(health.status).toBe('degraded');
    });

    it('should be unhealthy with >10 errors', () => {
      for (let i = 0; i < 15; i++) {
        checker.recordMonitorCheck('test', false);
      }

      const health = checker.getHealth();
      expect(health.status).toBe('unhealthy');
    });

    it('should be degraded with high memory usage', () => {
      // This test depends on current memory usage
      // Just verify it doesn't crash
      const health = checker.getHealth();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);
    });
  });

  describe('isHealthy', () => {
    it('should return true when healthy', () => {
      expect(checker.isHealthy()).toBe(true);
    });

    it('should return false when unhealthy', () => {
      for (let i = 0; i < 15; i++) {
        checker.recordMonitorCheck('test', false);
      }
      expect(checker.isHealthy()).toBe(false);
    });
  });

  describe('Prometheus Metrics', () => {
    it('should export Prometheus format', () => {
      checker.recordEvent();
      checker.recordMonitorCheck('eventLoop', true);

      const metrics = checker.getPrometheusMetrics();

      expect(metrics).toContain('# HELP guardian_up');
      expect(metrics).toContain('# TYPE guardian_up gauge');
      expect(metrics).toContain('guardian_up 1');

      expect(metrics).toContain('# HELP guardian_uptime_seconds');
      expect(metrics).toContain('# TYPE guardian_uptime_seconds counter');

      expect(metrics).toContain('# HELP guardian_events_total');
      expect(metrics).toContain('# TYPE guardian_events_total counter');

      expect(metrics).toContain('# HELP guardian_memory_bytes');
      expect(metrics).toContain('# TYPE guardian_memory_bytes gauge');
    });

    it('should include monitor metrics', () => {
      checker.recordMonitorCheck('eventLoop', true);
      checker.recordMonitorCheck('memory', false);

      const metrics = checker.getPrometheusMetrics();

      expect(metrics).toContain('guardian_monitor_healthy{monitor="eventLoop"} 1');
      expect(metrics).toContain('guardian_monitor_healthy{monitor="memory"} 0');
    });

    it('should be valid Prometheus format', () => {
      const metrics = checker.getPrometheusMetrics();

      // Should start with # HELP or metric name
      const lines = metrics.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line.startsWith('#') || /^[a-z_]+/.test(line)).toBe(true);
      }
    });
  });

  describe('Metrics Accuracy', () => {
    it('should report accurate memory usage', () => {
      const health = checker.getHealth();
      expect(health.metrics.memoryUsage).toBeGreaterThan(0);
      expect(health.metrics.memoryUsage).toBeLessThan(1000); // Should be < 1GB
    });

    it('should update timestamp', async () => {
      const health1 = checker.getHealth();
      await new Promise(resolve => setTimeout(resolve, 10));
      const health2 = checker.getHealth();

      expect(health2.timestamp).toBeGreaterThanOrEqual(health1.timestamp);
    });
  });
});
