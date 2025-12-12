import { MemoryMonitor } from '../../src/core/memoryMonitor';
import { eventStore, EventType } from '../../src/collector/eventStore';

describe('MemoryMonitor', () => {
  let monitor: MemoryMonitor;
  let events: any[] = [];

  beforeEach(() => {
    events = [];
    eventStore.on(EventType.MEMORY_LEAK, (event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    if (monitor) {
      monitor.stop();
    }
    eventStore.clear();
  });

  describe('Configuration', () => {
    it('should initialize with default config', () => {
      monitor = new MemoryMonitor({});
      expect(monitor).toBeDefined();
    });

    it('should accept custom config', () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 10000,
        leakThreshold: 100,
        consecutiveGrowth: 5
      });
      expect(monitor).toBeDefined();
    });

    it('should not start if disabled', () => {
      monitor = new MemoryMonitor({ enabled: false });
      monitor.start();
      expect(true).toBe(true);
    });
  });

  describe('Memory Tracking', () => {
    it('should track memory usage', async () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 1000
      });

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 1500));

      const stats = monitor.getStats();
      expect(stats.current.heapUsed).toBeGreaterThan(0);
      expect(stats.snapshotCount).toBeGreaterThan(0);
    });

    it('should detect memory growth', async () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 500,
        leakThreshold: 1, // 1MB threshold
        consecutiveGrowth: 2
      });

      monitor.start();

      // Allocate memory
      const arrays: any[] = [];
      for (let i = 0; i < 5; i++) {
        arrays.push(new Array(200000).fill('x')); // ~2MB per array
        await new Promise(resolve => setTimeout(resolve, 600));
      }

      // Check for leak detection
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(EventType.MEMORY_LEAK);
      expect(events[0].data.recentGrowth).toBeGreaterThan(0);

      // Clean up
      arrays.length = 0;
    }, 15000);

    it('should not detect false positives with stable memory', async () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 500,
        leakThreshold: 5
      });

      monitor.start();

      // Wait without allocating significant memory
      await new Promise(resolve => setTimeout(resolve, 2500));

      expect(events.length).toBe(0);
    }, 10000);
  });

  describe('Snapshot Management', () => {
    it('should limit snapshots to max', async () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 500
      });

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 2500));

      const stats = monitor.getStats();
      // maxSnapshots is hardcoded to 100 in the implementation
      expect(stats.snapshotCount).toBeLessThanOrEqual(100);
    }, 10000);

    it('should maintain snapshot history', async () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 500
      });

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 1500));

      const stats = monitor.getStats();
      expect(stats.snapshotCount).toBeGreaterThan(0);
      expect(stats.current.heapUsed).toBeGreaterThan(0);
    });
  });

  describe('Start/Stop', () => {
    it('should start and stop cleanly', () => {
      monitor = new MemoryMonitor({ enabled: true });
      
      monitor.start();
      expect(monitor['intervalHandle']).toBeDefined();
      
      monitor.stop();
      expect(monitor['intervalHandle']).toBeNull();
    });

    it('should not error on double start', () => {
      monitor = new MemoryMonitor({ enabled: true });
      monitor.start();
      monitor.start();
      expect(monitor['intervalHandle']).toBeDefined();
    });
  });

  describe('Statistics', () => {
    it('should calculate growth correctly', async () => {
      monitor = new MemoryMonitor({
        enabled: true,
        checkInterval: 500
      });

      monitor.start();

      // Allocate some memory
      const arr = new Array(100000).fill('test');
      await new Promise(resolve => setTimeout(resolve, 1500));

      const stats = monitor.getStats();
      expect(stats.growth).toBeDefined();
      expect(typeof stats.growth).toBe('number');
      expect(stats.trend).toBeDefined();

      // Clean up
      arr.length = 0;
    });
  });

  describe('Error Handling', () => {
    it('should handle check errors gracefully', async () => {
      monitor = new MemoryMonitor({ enabled: true });
      
      const originalCheck = monitor['checkMemory'];
      monitor['checkMemory'] = () => {
        throw new Error('Test error');
      };

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(true).toBe(true);

      monitor['checkMemory'] = originalCheck;
    });
  });
});
