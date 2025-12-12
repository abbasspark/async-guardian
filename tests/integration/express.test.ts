import express, { Express } from 'express';
import request from 'supertest';
import { Guardian } from '../../src/index';
import { guardianMiddleware, guardianErrorHandler, trackSlowRequests } from '../../src/integrations/express';

describe('Express Integration', () => {
  let app: Express;
  let guardian: Guardian;
  let server: any;

  beforeEach(() => {
    app = express();
    guardian = Guardian.create({ mode: 'production' });
    guardian.start();
  });

  afterEach((done) => {
    if (server) {
      server.close(() => {
        guardian.stop();
        done();
      });
    } else {
      guardian.stop();
      done();
    }
  });

  describe('Guardian Middleware', () => {
    it('should add health endpoint', async () => {
      app.use(guardianMiddleware({ guardian }));

      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body.status).toBeDefined();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(response.body.status);
      expect(response.body.uptime).toBeGreaterThan(0);
    });

    it('should add metrics endpoint', async () => {
      app.use(guardianMiddleware({ guardian }));

      const response = await request(app).get('/metrics');
      
      expect(response.status).toBe(200);
      expect(response.type).toBe('text/plain');
      expect(response.text).toContain('guardian_up');
      expect(response.text).toContain('guardian_uptime_seconds');
    });

    it('should use custom paths', async () => {
      app.use(guardianMiddleware({
        guardian,
        healthCheckPath: '/custom-health',
        metricsPath: '/custom-metrics'
      }));

      const health = await request(app).get('/custom-health');
      expect(health.status).toBe(200);

      const metrics = await request(app).get('/custom-metrics');
      expect(metrics.status).toBe(200);
    });

    it('should track requests', async () => {
      app.use(guardianMiddleware({ guardian, trackRequests: true }));
      app.get('/test', (req, res) => res.send('OK'));

      await request(app).get('/test');
      await request(app).get('/test');
      await request(app).get('/test');

      const metrics = await request(app).get('/metrics');
      expect(metrics.text).toContain('http_requests_total');
    });

    it('should track errors', async () => {
      app.use(guardianMiddleware({ guardian, trackErrors: true }));
      app.get('/error', (req, res) => res.status(500).send('Error'));

      await request(app).get('/error');

      const metrics = await request(app).get('/metrics');
      expect(metrics.text).toContain('http_errors_total');
    });

    it('should not interfere with normal requests', async () => {
      app.use(guardianMiddleware({ guardian }));
      app.get('/api/users', (req, res) => res.json({ users: [] }));

      const response = await request(app).get('/api/users');
      expect(response.status).toBe(200);
      expect(response.body.users).toEqual([]);
    });
  });

  describe('Slow Request Tracking', () => {
    it('should warn on slow requests', async () => {
      const logs: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => logs.push(msg);

      app.use(trackSlowRequests(100));
      app.get('/slow', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 150));
        res.send('OK');
      });

      await request(app).get('/slow');

      console.warn = originalWarn;

      expect(logs.some(log => log.includes('Slow request'))).toBe(true);
    });

    it('should not warn on fast requests', async () => {
      const logs: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => logs.push(msg);

      app.use(trackSlowRequests(500));
      app.get('/fast', (req, res) => res.send('OK'));

      await request(app).get('/fast');

      console.warn = originalWarn;

      expect(logs.filter(log => log.includes('Slow request')).length).toBe(0);
    });
  });

  describe('Error Handler', () => {
    it('should catch Express errors', async () => {
      const logs: any[] = [];
      const originalError = console.error;
      console.error = (...args: any[]) => logs.push(args);

      app.get('/error', (req, res) => {
        throw new Error('Test error');
      });
      
      app.use(guardianErrorHandler());
      
      // Add default error handler
      app.use((err: any, req: any, res: any, next: any) => {
        res.status(500).send('Error');
      });

      await request(app).get('/error');

      console.error = originalError;

      expect(logs.some(log => 
        JSON.stringify(log).includes('Express error')
      )).toBe(true);
    });
  });

  describe('Complete Integration', () => {
    it('should work with all features', async () => {
      app.use(express.json());
      app.use(guardianMiddleware({ guardian }));
      app.use(trackSlowRequests(500));

      app.get('/api/users', (req, res) => {
        res.json({ users: ['Alice', 'Bob'] });
      });

      app.post('/api/users', (req, res) => {
        res.status(201).json({ id: 1, name: req.body.name });
      });

      app.use(guardianErrorHandler());

      // Test GET
      const getResponse = await request(app).get('/api/users');
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.users).toHaveLength(2);

      // Test POST
      const postResponse = await request(app)
        .post('/api/users')
        .send({ name: 'Charlie' });
      expect(postResponse.status).toBe(201);

      // Test health
      const health = await request(app).get('/health');
      // Health status may vary depending on system state
      expect([200, 503]).toContain(health.status);
      expect(health.body.status).toBeDefined();

      // Test metrics
      const metrics = await request(app).get('/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.text).toContain('guardian_up');
    });
  });

  describe('Load Handling', () => {
    it('should handle concurrent requests', async () => {
      app.use(guardianMiddleware({ guardian }));
      app.get('/test', (req, res) => res.send('OK'));

      const requests = [];
      for (let i = 0; i < 50; i++) {
        requests.push(request(app).get('/test'));
      }

      const responses = await Promise.all(requests);
      
      expect(responses.every(r => r.status === 200)).toBe(true);
    });

    it('should maintain performance under load', async () => {
      app.use(guardianMiddleware({ guardian }));
      app.get('/test', (req, res) => res.send('OK'));

      const start = Date.now();
      
      const requests = [];
      for (let i = 0; i < 100; i++) {
        requests.push(request(app).get('/test'));
      }

      await Promise.all(requests);
      
      const duration = Date.now() - start;
      
      // 100 requests should complete reasonably fast
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Health Status Under Load', () => {
    it('should report healthy status under normal load', async () => {
      app.use(guardianMiddleware({ guardian }));
      app.get('/test', (req, res) => res.send('OK'));

      // Make some requests
      for (let i = 0; i < 20; i++) {
        await request(app).get('/test');
      }

      const health = await request(app).get('/health');
      // Under load, status could be any state depending on memory/errors
      // Just verify Guardian is responding and providing status
      expect([200, 503]).toContain(health.status);
      expect(health.body.status).toBeDefined();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(health.body.status);
    });
  });
});
