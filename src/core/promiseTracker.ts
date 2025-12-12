import { createHook, AsyncHook } from 'async_hooks';
import { eventStore, EventType } from '../collector/eventStore';

export interface PromiseConfig {
  enabled: boolean;
  deadlockThreshold: number; // milliseconds before considering deadlock
  checkInterval: number; // how often to check for deadlocks
  maxTracked?: number; // Alias for compatibility with Guardian config
  maxTrackedPromises?: number;
}

export interface TrackedPromise {
  asyncId: number;
  type: string;
  triggerAsyncId: number;
  createdAt: number;
  stack: string;
  status: 'pending' | 'resolved' | 'rejected';
  file?: string;
  line?: number;
}

export class PromiseTracker {
  private hook: AsyncHook | null = null;
  private promises = new Map<number, TrackedPromise>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private config: PromiseConfig;
  private deadlockCount = 0;

  constructor(config: Partial<PromiseConfig> = {}) {
    // Support both maxTracked (Guardian config) and maxTrackedPromises
    const maxTracked = config.maxTracked || config.maxTrackedPromises || 10000;

    this.config = {
      enabled: true,
      deadlockThreshold: 30000, // 30 seconds
      checkInterval: 5000, // check every 5 seconds
      maxTrackedPromises: maxTracked,
      ...config,
    };

    // Ensure maxTrackedPromises is always set
    this.config.maxTrackedPromises = this.config.maxTracked || this.config.maxTrackedPromises || 10000;
  }

  start(): void {
    if (!this.config.enabled || this.hook) {
      return;
    }

    this.hook = createHook({
      init: (asyncId, type, triggerAsyncId, resource) => {
        try {
          this.onInit(asyncId, type, triggerAsyncId, resource);
        } catch (error) {
          console.error('[Guardian PromiseTracker] Error in init hook:', error);
        }
      },
      destroy: (asyncId) => {
        try {
          this.onDestroy(asyncId);
        } catch (error) {
          console.error('[Guardian PromiseTracker] Error in destroy hook:', error);
        }
      },
    });

    try {
      this.hook.enable();
    } catch (error) {
      console.error('[Guardian PromiseTracker] Failed to enable hooks:', error);
      this.hook = null;
      return;
    }

    // Periodically check for deadlocks
    this.intervalHandle = setInterval(() => {
      try {
        this.checkForDeadlocks();
      } catch (error) {
        console.error('[Guardian PromiseTracker] Error checking deadlocks:', error);
      }
    }, this.config.checkInterval);

    eventStore.emit(EventType.SYSTEM_INFO, {
      message: 'Promise tracking started',
      deadlockThreshold: this.config.deadlockThreshold,
    });
  }

  stop(): void {
    if (this.hook) {
      this.hook.disable();
      this.hook = null;
    }

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.promises.clear();
  }

  getPendingPromises(): TrackedPromise[] {
    return Array.from(this.promises.values())
      .filter(p => p.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getStats() {
    const pending = this.getPendingPromises();
    const now = Date.now();

    return {
      total: this.promises.size,
      pending: pending.length,
      deadlockCount: this.deadlockCount,
      oldestPending: pending.length > 0 
        ? now - pending[0].createdAt 
        : 0,
      suspiciousCount: pending.filter(
        p => now - p.createdAt > this.config.deadlockThreshold / 2
      ).length,
    };
  }

  private onInit(
    asyncId: number,
    type: string,
    triggerAsyncId: number,
    resource: any
  ): void {
    // Only track PROMISE types
    if (type !== 'PROMISE') return;

    // Get stack before any other checks
    const stack = new Error().stack || '';
    const { file, line } = this.parseStack(stack);

    // CRITICAL FIX: Don't track Guardian's own promises!
    if (file && (
      file.includes('/node-guardian/') ||
      file.includes('/dist/core/') ||
      file.includes('/dist/collector/') ||
      file.includes('/dist/dashboard/') ||
      file.includes('/dist/instrumentation/') ||
      file.includes('promiseTracker') ||
      file.includes('eventLoopMonitor') ||
      file.includes('memoryMonitor') ||
      file.includes('unawaitedPromiseDetector') ||
      file.includes('eventStore')
    )) {
      return; // Don't track Guardian's internal promises
    }

    // Limit memory usage
    if (this.promises.size >= (this.config.maxTrackedPromises || 10000)) {
      // Remove oldest resolved/rejected
      this.cleanupOldPromises();
    }

    this.promises.set(asyncId, {
      asyncId,
      type,
      triggerAsyncId,
      createdAt: Date.now(),
      stack,
      status: 'pending',
      file,
      line,
    });
  }

  private onDestroy(asyncId: number): void {
    const promise = this.promises.get(asyncId);
    if (promise && promise.status === 'pending') {
      promise.status = 'resolved';
      
      // Clean up after a delay to allow for analysis
      setTimeout(() => {
        this.promises.delete(asyncId);
      }, 60000); // keep for 1 minute
    }
  }

  private checkForDeadlocks(): void {
    const now = Date.now();
    const pending = this.getPendingPromises();

    for (const promise of pending) {
      const age = now - promise.createdAt;

      if (age > this.config.deadlockThreshold) {
        // Check if we've already reported this
        const alreadyReported = this.promises.get(promise.asyncId);
        if (alreadyReported && alreadyReported.status !== 'pending') {
          continue;
        }

        this.deadlockCount++;

        // Find related promises (circular wait)
        const relatedPromises = this.findRelatedPromises(promise);
        const isCircular = this.detectCircularWait(promise, relatedPromises);

        const suggestion = this.generateDeadlockSuggestion(
          promise,
          relatedPromises,
          isCircular
        );

        eventStore.emit(
          EventType.PROMISE_DEADLOCK,
          {
            asyncId: promise.asyncId,
            age: Math.round(age / 1000),
            file: promise.file,
            line: promise.line,
            isCircular,
            relatedCount: relatedPromises.length,
            stack: this.cleanStack(promise.stack),
          },
          {
            severity: 'critical',
            file: promise.file,
            line: promise.line,
            suggestion,
          }
        );

        // Mark as reported to avoid spam
        promise.status = 'rejected';
      }
    }
  }

  private findRelatedPromises(promise: TrackedPromise): TrackedPromise[] {
    const related: TrackedPromise[] = [];
    const visited = new Set<number>();

    const traverse = (p: TrackedPromise, depth: number = 0) => {
      if (depth > 10 || visited.has(p.asyncId)) return;
      visited.add(p.asyncId);

      // Find promises triggered by this one
      for (const other of this.promises.values()) {
        if (other.triggerAsyncId === p.asyncId && other.status === 'pending') {
          related.push(other);
          traverse(other, depth + 1);
        }
      }
    };

    traverse(promise);
    return related;
  }

  private detectCircularWait(
    promise: TrackedPromise,
    related: TrackedPromise[]
  ): boolean {
    // Simple circular detection: if any related promise's trigger leads back to original
    const visited = new Set<number>();
    
    const hasCircle = (current: TrackedPromise): boolean => {
      if (current.asyncId === promise.asyncId && visited.size > 0) {
        return true;
      }
      if (visited.has(current.asyncId)) {
        return false;
      }
      visited.add(current.asyncId);

      const trigger = this.promises.get(current.triggerAsyncId);
      if (trigger && trigger.status === 'pending') {
        return hasCircle(trigger);
      }
      return false;
    };

    return related.some(r => hasCircle(r));
  }

  private generateDeadlockSuggestion(
    promise: TrackedPromise,
    related: TrackedPromise[],
    isCircular: boolean
  ): string {
    if (isCircular) {
      return `🔴 CIRCULAR DEADLOCK DETECTED\n\n` +
        `This promise has been waiting for ${Math.round((Date.now() - promise.createdAt) / 1000)}s.\n` +
        `${related.length} related promises are also stuck in a circular wait.\n\n` +
        `Common causes:\n` +
        `- Service A calls Service B, which calls Service A\n` +
        `- Mutex/lock held while awaiting another lock\n` +
        `- Event emitter waiting for event that never fires\n\n` +
        `Action: Review the async flow in ${promise.file}:${promise.line}`;
    }

    return `⚠️ POTENTIAL DEADLOCK\n\n` +
      `Promise pending for ${Math.round((Date.now() - promise.createdAt) / 1000)}s.\n` +
      `${related.length} related promises also pending.\n\n` +
      `Possible causes:\n` +
      `- Awaiting a promise that never resolves\n` +
      `- Missing error handling\n` +
      `- External service not responding\n` +
      `- Database query hanging\n\n` +
      `Check: ${promise.file}:${promise.line}`;
  }

  private parseStack(stack: string): { file?: string; line?: number } {
    const lines = stack.split('\n');
    
    for (const line of lines) {
      // Match patterns like: at Function (/path/to/file.ts:123:45)
      const match = line.match(/\(([^)]+):(\d+):\d+\)/);
      if (match && !match[1].includes('node_modules') && !match[1].includes('node:internal')) {
        return {
          file: match[1],
          line: parseInt(match[2], 10),
        };
      }
    }

    return {};
  }

  private cleanStack(stack: string): string {
    return stack
      .split('\n')
      .filter(line => 
        !line.includes('node_modules') && 
        !line.includes('node:internal') &&
        !line.includes('async_hooks')
      )
      .slice(0, 10) // Keep top 10 lines
      .join('\n');
  }

  private cleanupOldPromises(): void {
    const sorted = Array.from(this.promises.entries())
      .filter(([_, p]) => p.status !== 'pending')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    // Remove oldest 20%
    const toRemove = Math.floor(sorted.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.promises.delete(sorted[i][0]);
    }
  }
}
