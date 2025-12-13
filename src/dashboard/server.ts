import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import path from 'path';
import { Guardian } from '../index';
import { eventStore } from '../collector/eventStore';

export interface DashboardConfig {
    port: number;
    host: string;
}

export class DashboardServer {
    private app: express.Application;
    private server: Server | null = null;
    private wss: WebSocketServer | null = null;
    private config: DashboardConfig;
    private guardian: Guardian;
    private clients = new Set<WebSocket>();

    constructor(guardian: Guardian, config: Partial<DashboardConfig> = {}) {
        this.guardian = guardian;
        this.config = {
            port: config.port || 4600,
            host: config.host || 'localhost',
        };

        this.app = express();
        this.setupRoutes();
    }

    start(): Promise<void> {
        return new Promise((resolve) => {
            this.server = this.app.listen(this.config.port, this.config.host, () => {
                console.log(`\n🎯 Guardian Dashboard: http://${this.config.host}:${this.config.port}`);
                resolve();
            });

            // Setup WebSocket
            this.wss = new WebSocketServer({ server: this.server });
            this.setupWebSocket();
        });
    }

    stop(): void {
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }

        if (this.server) {
            this.server.close();
            this.server = null;
        }

        this.clients.clear();
    }

    private setupRoutes(): void {
        // API routes
        this.app.get('/api/status', (req, res) => {
            res.json(this.guardian.getStatus());
        });

        this.app.get('/api/events', (req, res) => {
            const { type, severity, since } = req.query;

            const events = this.guardian.getEvents({
                type: type as any,
                severity: severity as string,
                since: since ? parseInt(since as string) : undefined,
            });

            res.json(events);
        });

        this.app.get('/api/promises', (req, res) => {
            res.json(this.guardian.getPendingPromises());
        });

        this.app.get('/api/memory', (req, res) => {
            res.json(this.guardian.getMemorySnapshots());
        });

        this.app.post('/api/gc', (req, res) => {
            const success = this.guardian.forceGC();
            res.json({ success, message: success ? 'GC triggered' : 'GC not available. Run with --expose-gc' });
        });

        // Serve static files (dashboard UI)
        this.app.get('/', (req, res) => {
            res.send(this.getIndexHTML());
        });
    }

    private setupWebSocket(): void {
        if (!this.wss) return;

        this.wss.on('connection', (ws: WebSocket) => {
            this.clients.add(ws);

            // Send current status on connection
            ws.send(JSON.stringify({
                type: 'status',
                data: this.guardian.getStatus(),
            }));

            ws.on('close', () => {
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
            });
        });

        // Listen to event store and broadcast to all clients
        eventStore.on('event', (event) => {
            this.broadcast({
                type: 'event',
                data: event,
            });
        });

        // Send status updates every 2 seconds
        setInterval(() => {
            this.broadcast({
                type: 'status',
                data: this.guardian.getStatus(),
            });
        }, 2000);
    }

    private broadcast(message: any): void {
        const data = JSON.stringify(message);

        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    private getIndexHTML(): string {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Guardian Pro Dashboard</title>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        :root {
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --bg-tertiary: #334155;
            --text-primary: #f1f5f9;
            --text-secondary: #cbd5e1;
            --text-muted: #64748b;
            --accent-blue: #3b82f6;
            --accent-purple: #8b5cf6;
            --accent-green: #10b981;
            --accent-yellow: #f59e0b;
            --accent-red: #ef4444;
            --border-color: #334155;
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
        }

        .dashboard {
            display: flex;
            height: 100vh;
        }

        /* Sidebar */
        .sidebar {
            width: 260px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border-color);
            padding: 24px 0;
            display: flex;
            flex-direction: column;
        }

        .logo {
            padding: 0 24px 24px;
            border-bottom: 1px solid var(--border-color);
        }

        .logo h1 {
            font-size: 24px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .logo .status-indicator {
            width: 8px;
            height: 8px;
            background: var(--accent-green);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.95); }
        }

        .nav {
            flex: 1;
            padding: 24px 0;
        }

        .nav-item {
            padding: 12px 24px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 12px;
            color: var(--text-secondary);
        }

        .nav-item:hover {
            background: var(--bg-tertiary);
            color: var(--text-primary);
        }

        .nav-item.active {
            background: var(--bg-tertiary);
            color: var(--accent-blue);
            border-left: 3px solid var(--accent-blue);
        }

        .nav-icon {
            font-size: 20px;
        }

        /* Main Content */
        .main-content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .topbar {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            padding: 16px 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .topbar-left {
            display: flex;
            gap: 16px;
            align-items: center;
        }

        .search-box {
            position: relative;
        }

        .search-box input {
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 8px 16px 8px 40px;
            color: var(--text-primary);
            width: 300px;
        }

        .search-box::before {
            content: '🔍';
            position: absolute;
            left: 12px;
            top: 50%;
            transform: translateY(-50%);
        }

        .filter-btn, .export-btn, .settings-btn {
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 8px 16px;
            color: var(--text-primary);
            cursor: pointer;
            transition: all 0.2s;
        }

        .filter-btn:hover, .export-btn:hover, .settings-btn:hover {
            background: var(--bg-primary);
        }

        .theme-toggle {
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 8px 12px;
            color: var(--text-primary);
            cursor: pointer;
        }

        /* Content Area */
        .content {
            flex: 1;
            overflow-y: auto;
            padding: 24px 32px;
            max-width: 1600px;
            margin: 0 auto;
            width: 100%;
        }

        .content-section {
            display: none;
        }

        .content-section.active {
            display: block;
        }

        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 32px;
        }

        .stat-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 24px;
            transition: all 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow);
        }

        .stat-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }

        .stat-title {
            color: var(--text-secondary);
            font-size: 14px;
            font-weight: 500;
        }

        .stat-icon {
            font-size: 24px;
        }

        .stat-value {
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .stat-value.good { color: var(--accent-green); }
        .stat-value.warning { color: var(--accent-yellow); }
        .stat-value.critical { color: var(--accent-red); }

        .stat-change {
            font-size: 14px;
            color: var(--text-muted);
        }

        /* Charts */
        .chart-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 20px;
            margin-bottom: 32px;
        }

        .chart-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 24px;
            height: 350px;
        }

        .chart-container {
            position: relative;
            height: 250px;
            width: 100%;
        }

        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .chart-title {
            font-size: 18px;
            font-weight: 600;
        }

        .chart-controls {
            display: flex;
            gap: 8px;
        }

        .chart-btn {
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 4px 12px;
            font-size: 12px;
            color: var(--text-secondary);
            cursor: pointer;
        }

        .chart-btn.active {
            background: var(--accent-blue);
            color: white;
        }

        /* Events Table */
        .events-table {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            overflow: hidden;
        }

        .table-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .table-title {
            font-size: 18px;
            font-weight: 600;
        }

        .table-filters {
            display: flex;
            gap: 12px;
        }

        .filter-tag {
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .filter-tag.all { background: var(--bg-tertiary); color: var(--text-primary); }
        .filter-tag.critical { background: rgba(239, 68, 68, 0.1); color: var(--accent-red); }
        .filter-tag.error { background: rgba(245, 158, 11, 0.1); color: var(--accent-yellow); }
        .filter-tag.warning { background: rgba(59, 130, 246, 0.1); color: var(--accent-blue); }

        .filter-tag:hover {
            opacity: 0.8;
        }

        .event-row {
            padding: 16px 24px;
            border-bottom: 1px solid var(--border-color);
            transition: all 0.2s;
            cursor: pointer;
        }

        .event-row:hover {
            background: var(--bg-tertiary);
        }

        .event-row:last-child {
            border-bottom: none;
        }

        .event-main {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .event-type {
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .event-badge {
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .event-badge.critical { background: var(--accent-red); color: white; }
        .event-badge.error { background: var(--accent-yellow); color: white; }
        .event-badge.warning { background: var(--accent-blue); color: white; }
        .event-badge.info { background: var(--bg-tertiary); color: var(--text-secondary); }

        .event-time {
            color: var(--text-muted);
            font-size: 14px;
        }

        .event-details {
            color: var(--text-secondary);
            font-size: 14px;
            line-height: 1.6;
        }

        .event-file {
            color: var(--accent-blue);
            font-family: 'Courier New', monospace;
            font-size: 12px;
        }

        /* Promises View */
        .promises-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .promise-item {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-left: 4px solid var(--accent-yellow);
            border-radius: 8px;
            padding: 20px;
        }

        .promise-item.critical {
            border-left-color: var(--accent-red);
        }

        .promise-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 12px;
        }

        .promise-id {
            font-family: 'Courier New', monospace;
            color: var(--text-secondary);
        }

        .promise-age {
            font-weight: 600;
        }

        .promise-age.warning { color: var(--accent-yellow); }
        .promise-age.critical { color: var(--accent-red); }

        /* Modal */
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 32px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }

        .modal-title {
            font-size: 24px;
            font-weight: 600;
        }

        .modal-close {
            background: none;
            border: none;
            font-size: 24px;
            color: var(--text-secondary);
            cursor: pointer;
        }

        /* Badges */
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
        }

        .badge.success { background: var(--accent-green); color: white; }
        .badge.danger { background: var(--accent-red); color: white; }
        .badge.warning { background: var(--accent-yellow); color: white; }

        /* Responsive */
        @media (max-width: 1200px) {
            .chart-row {
                grid-template-columns: 1fr;
            }
        }

        @media (max-width: 1024px) {
            .sidebar {
                width: 200px;
            }
            
            .stats-grid {
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            }
        }

        @media (max-width: 768px) {
            .sidebar {
                display: none;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            .search-box input {
                width: 200px;
            }
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <!-- Sidebar -->
        <div class="sidebar">
            <div class="logo">
                <h1>
                    🛡️ Guardian
                    <span class="status-indicator"></span>
                </h1>
            </div>

            <div class="nav">
                <div class="nav-item active" data-section="overview">
                    <span class="nav-icon">📊</span>
                    <span>Overview</span>
                </div>
                <div class="nav-item" data-section="events">
                    <span class="nav-icon">⚡</span>
                    <span>Events</span>
                </div>
                <div class="nav-item" data-section="promises">
                    <span class="nav-icon">🔄</span>
                    <span>Promises</span>
                </div>
                <div class="nav-item" data-section="memory">
                    <span class="nav-icon">💾</span>
                    <span>Memory</span>
                </div>
                <div class="nav-item" data-section="analytics">
                    <span class="nav-icon">📈</span>
                    <span>Analytics</span>
                </div>
            </div>
        </div>

        <!-- Main Content -->
        <div class="main-content">
            <!-- Topbar -->
            <div class="topbar">
                <div class="topbar-left">
                    <div class="search-box">
                        <input type="text" id="search" placeholder="Search events...">
                    </div>
                    <button class="filter-btn" onclick="openFilterModal()">🔽 Filters</button>
                </div>
                <div style="display: flex; gap: 12px;">
                    <button class="export-btn" onclick="exportData()">📥 Export</button>
                    <button class="settings-btn" onclick="openSettings()">⚙️ Settings</button>
                    <button class="theme-toggle" onclick="toggleTheme()">🌙</button>
                </div>
            </div>

            <!-- Content -->
            <div class="content">
                <!-- Overview Section -->
                <div class="content-section active" id="overview-section">
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Event Loop</span>
                                <span class="stat-icon">⚡</span>
                            </div>
                            <div class="stat-value" id="stat-event-loop">-</div>
                            <div class="stat-change" id="stat-event-loop-change">-</div>
                        </div>

                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Pending Promises</span>
                                <span class="stat-icon">🔄</span>
                            </div>
                            <div class="stat-value" id="stat-promises">-</div>
                            <div class="stat-change" id="stat-promises-change">-</div>
                        </div>

                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Memory Usage</span>
                                <span class="stat-icon">💾</span>
                            </div>
                            <div class="stat-value" id="stat-memory">-</div>
                            <div class="stat-change" id="stat-memory-change">-</div>
                        </div>

                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Total Events</span>
                                <span class="stat-icon">📊</span>
                            </div>
                            <div class="stat-value" id="stat-events">-</div>
                            <div class="stat-change" id="stat-events-change">-</div>
                        </div>
                    </div>

                    <!-- Charts -->
                    <div class="chart-row">
                        <div class="chart-card">
                            <div class="chart-header">
                                <div class="chart-title">Memory Trend</div>
                                <div class="chart-controls">
                                    <button class="chart-btn active">1H</button>
                                    <button class="chart-btn">6H</button>
                                    <button class="chart-btn">24H</button>
                                </div>
                            </div>
                            <div class="chart-container">
                                <canvas id="memory-chart"></canvas>
                            </div>
                        </div>

                        <div class="chart-card">
                            <div class="chart-header">
                                <div class="chart-title">Event Loop Delay</div>
                                <div class="chart-controls">
                                    <button class="chart-btn active">1H</button>
                                    <button class="chart-btn">6H</button>
                                    <button class="chart-btn">24H</button>
                                </div>
                            </div>
                            <div class="chart-container">
                                <canvas id="eventloop-chart"></canvas>
                            </div>
                        </div>
                    </div>

                    <!-- Recent Events -->
                    <div class="events-table">
                        <div class="table-header">
                            <div class="table-title">Recent Events</div>
                            <div class="table-filters">
                                <span class="filter-tag all active" data-filter="all">All</span>
                                <span class="filter-tag critical" data-filter="critical">Critical</span>
                                <span class="filter-tag error" data-filter="error">Error</span>
                                <span class="filter-tag warning" data-filter="warning">Warning</span>
                            </div>
                        </div>
                        <div id="events-container"></div>
                    </div>
                </div>

                <!-- Events Section -->
                <div class="content-section" id="events-section">
                    <div class="events-table">
                        <div class="table-header">
                            <div class="table-title">All Events</div>
                        </div>
                        <div id="all-events-container"></div>
                    </div>
                </div>

                <!-- Promises Section -->
                <div class="content-section" id="promises-section">
                    <h2 style="margin-bottom: 24px;">Pending Promises</h2>
                    <div class="promises-list" id="promises-list"></div>
                </div>

                <!-- Memory Section -->
                <div class="content-section" id="memory-section">
                    <div class="chart-card" style="margin-bottom: 24px; height: 450px;">
                        <div class="chart-header">
                            <div class="chart-title">Memory Analysis</div>
                        </div>
                        <div class="chart-container" style="height: 350px;">
                            <canvas id="memory-detail-chart"></canvas>
                        </div>
                    </div>
                </div>

                <!-- Analytics Section -->
                <div class="content-section" id="analytics-section">
                    <h2 style="margin-bottom: 24px;">System Analytics</h2>
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Uptime</span>
                                <span class="stat-icon">⏱️</span>
                            </div>
                            <div class="stat-value" id="uptime">-</div>
                            <div class="stat-change">Since last restart</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Node Version</span>
                                <span class="stat-icon">🟢</span>
                            </div>
                            <div class="stat-value" id="node-version" style="font-size: 24px;">-</div>
                            <div class="stat-change">Runtime version</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Process ID</span>
                                <span class="stat-icon">🔢</span>
                            </div>
                            <div class="stat-value" id="pid" style="font-size: 24px;">-</div>
                            <div class="stat-change">Current PID</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-header">
                                <span class="stat-title">Monitoring</span>
                                <span class="stat-icon">🛡️</span>
                            </div>
                            <div class="stat-value good">Active</div>
                            <div class="stat-change">All monitors running</div>
                        </div>
                    </div>

                    <div class="chart-card" style="margin-top: 24px;">
                        <div class="chart-header">
                            <div class="chart-title">System Overview</div>
                        </div>
                        <div style="padding: 20px; color: var(--text-secondary);">
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
                                <div>
                                    <div style="font-weight: 600; margin-bottom: 8px;">Active Monitors</div>
                                    <div>✅ Event Loop Monitor</div>
                                    <div>✅ Promise Tracker</div>
                                    <div>✅ Memory Monitor</div>
                                    <div>✅ Unawaited Promise Detector</div>
                                </div>
                                <div>
                                    <div style="font-weight: 600; margin-bottom: 8px;">Detection Rules</div>
                                    <div>Event Loop: >100ms</div>
                                    <div>Deadlock: >30s</div>
                                    <div>Memory Leak: +10MB</div>
                                    <div>Unawaited: >5s</div>
                                </div>
                                <div>
                                    <div style="font-weight: 600; margin-bottom: 8px;">Platform</div>
                                    <div id="platform-info">Loading...</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Settings Modal -->
    <div class="modal" id="settings-modal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">⚙️ Settings</div>
                <button class="modal-close" onclick="closeSettings()">×</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 24px;">
                <div>
                    <label style="display: block; margin-bottom: 8px; color: var(--text-secondary); font-weight: 500;">
                        Dashboard Refresh Rate
                    </label>
                    <select id="setting-refresh" style="width: 100%; padding: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary);">
                        <option value="1">1 second</option>
                        <option value="2" selected>2 seconds</option>
                        <option value="5">5 seconds</option>
                        <option value="10">10 seconds</option>
                    </select>
                </div>

                <div>
                    <label style="display: block; margin-bottom: 8px; color: var(--text-secondary); font-weight: 500;">
                        Max Events Display
                    </label>
                    <select id="setting-max-events" style="width: 100%; padding: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary);">
                        <option value="25">25 events</option>
                        <option value="50" selected>50 events</option>
                        <option value="100">100 events</option>
                        <option value="200">200 events</option>
                    </select>
                </div>

                <div>
                    <label style="display: block; margin-bottom: 8px; color: var(--text-secondary); font-weight: 500;">
                        Theme
                    </label>
                    <select id="setting-theme" style="width: 100%; padding: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary);">
                        <option value="dark" selected>Dark</option>
                        <option value="light">Light</option>
                    </select>
                </div>

                <div>
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="setting-auto-refresh" checked style="width: 18px; height: 18px;">
                        <span style="color: var(--text-secondary);">Auto-refresh data</span>
                    </label>
                </div>

                <div>
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="setting-sound" style="width: 18px; height: 18px;">
                        <span style="color: var(--text-secondary);">Sound alerts for critical events</span>
                    </label>
                </div>

                <div style="display: flex; gap: 12px; margin-top: 12px;">
                    <button onclick="saveSettings()" style="flex: 1; padding: 10px; background: var(--accent-blue); color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
                        Save Settings
                    </button>
                    <button onclick="closeSettings()" style="flex: 1; padding: 10px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px; font-weight: 600; cursor: pointer;">
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        // WebSocket Connection
        const ws = new WebSocket('ws://' + window.location.host);
        let allEvents = [];

        // PERFORMANCE LIMITS
        const MAX_EVENTS = 30;
        const MAX_CHART_POINTS = 20;
        const MAX_DOM_EVENTS = 20;
        let updateCounter = 0;
        let pendingPromises = [];
        let memorySnapshots = [];
        let eventLoopData = [];
        let currentFilter = 'all';
        let currentTheme = 'dark';
        let lastStatus = null;

        // Charts
        let memoryChart, eventLoopChart, memoryDetailChart;

        ws.onopen = () => {
            console.log('Connected to Guardian');
            // Fetch initial promises data
            fetch('/api/promises')
                .then(r => r.json())
                .then(data => {
                    pendingPromises = data;
                    updatePromisesView();
                });
        };

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'status') {
                lastStatus = message.data;
                updateStatus(message.data);
            } else if (message.type === 'event') {
                addEvent(message.data);
            }
        };

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                
                const section = item.dataset.section;
                document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
                document.getElementById(section + '-section').classList.add('active');
                
                // Refresh data when switching sections
                if (section === 'promises') {
                    refreshPromises();
                } else if (section === 'memory') {
                    refreshMemory();
                }
            });
        });

        // Initialize Charts
        function initCharts() {
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { 
                        grid: { color: '#334155' },
                        ticks: { color: '#cbd5e1' }
                    },
                    y: { 
                        grid: { color: '#334155' },
                        ticks: { color: '#cbd5e1' }
                    }
                }
            };

            memoryChart = new Chart(document.getElementById('memory-chart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Heap Used (MB)',
                        data: [],
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        tension: 0.4,
                        pointRadius: 0,
                        fill: true
                    }]
                },
                options: chartOptions
            });

            eventLoopChart = new Chart(document.getElementById('eventloop-chart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Delay (ms)',
                        data: [],
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139, 92, 246, 0.1)',
                        tension: 0.4,
                        pointRadius: 0,
                        fill: true
                    }]
                },
                options: chartOptions
            });

            memoryDetailChart = new Chart(document.getElementById('memory-detail-chart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Heap Used',
                            data: [],
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59, 130, 246, 0.1)',
                            tension: 0.4,
                        pointRadius: 0,
                            fill: true
                        },
                        {
                            label: 'Heap Total',
                            data: [],
                            borderColor: '#8b5cf6',
                            backgroundColor: 'rgba(139, 92, 246, 0.1)',
                            tension: 0.4,
                        pointRadius: 0,
                            fill: false
                        },
                        {
                            label: 'RSS',
                            data: [],
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.1)',
                            tension: 0.4,
                        pointRadius: 0,
                            fill: false
                        }
                    ]
                },
                options: {
                    ...chartOptions,
                    plugins: {
                        legend: { 
                            display: true,
                            labels: { color: '#cbd5e1' }
                        }
                    }
                }
            });
        }

        // Update Status
        function updateStatus(status) {
            updateCounter++;
            if (updateCounter % 3 !== 0) return;
            const monitors = status.monitors;

            // Update stat cards
            if (monitors.eventLoop) {
                const mean = monitors.eventLoop.mean?.toFixed(1) || 0;
                document.getElementById('stat-event-loop').textContent = mean + 'ms';
                document.getElementById('stat-event-loop').className = 'stat-value ' + (mean > 100 ? 'critical' : mean > 50 ? 'warning' : 'good');
                document.getElementById('stat-event-loop-change').textContent = monitors.eventLoop.stallCount + ' stalls detected';

                // Update chart
                const now = new Date().toLocaleTimeString();
                if (eventLoopChart.data.labels.length > 20) {
                    eventLoopChart.data.labels.shift();
                    eventLoopChart.data.datasets[0].data.shift();
                }
                eventLoopChart.data.labels.push(now);
                eventLoopChart.data.datasets[0].data.push(mean);
                eventLoopChart.update('none');
            }

            if (monitors.promises) {
                const pending = monitors.promises.pending || 0;
                document.getElementById('stat-promises').textContent = pending;
                document.getElementById('stat-promises').className = 'stat-value ' + (pending > 10 ? 'critical' : pending > 5 ? 'warning' : 'good');
                document.getElementById('stat-promises-change').textContent = monitors.promises.deadlockCount + ' deadlocks';
                
                // Fetch fresh promise data
                if (pending > 0) {
                    refreshPromises();
                }
            }

            if (monitors.memory) {
                const heapUsed = monitors.memory.current.heapUsed;
                document.getElementById('stat-memory').textContent = heapUsed + 'MB';
                document.getElementById('stat-memory').className = 'stat-value ' + (heapUsed > 500 ? 'critical' : heapUsed > 200 ? 'warning' : 'good');
                const growth = monitors.memory.growth || 0;
                document.getElementById('stat-memory-change').textContent = (growth > 0 ? '+' : '') + growth + 'MB growth';

                // Update charts
                const now = new Date().toLocaleTimeString();
                if (memoryChart.data.labels.length > 20) {
                    memoryChart.data.labels.shift();
                    memoryChart.data.datasets[0].data.shift();
                }
                memoryChart.data.labels.push(now);
                memoryChart.data.datasets[0].data.push(heapUsed);
                memoryChart.update('none');

                // Update detail chart
                if (memoryDetailChart.data.labels.length > 30) {
                    memoryDetailChart.data.labels.shift();
                    memoryDetailChart.data.datasets.forEach(ds => ds.data.shift());
                }
                memoryDetailChart.data.labels.push(now);
                memoryDetailChart.data.datasets[0].data.push(monitors.memory.current.heapUsed);
                memoryDetailChart.data.datasets[1].data.push(monitors.memory.current.heapTotal);
                memoryDetailChart.data.datasets[2].data.push(monitors.memory.current.rss);
                memoryDetailChart.update('none');
            }

            document.getElementById('stat-events').textContent = status.events.total || 0;
            document.getElementById('stat-events-change').textContent = 'Last update: ' + new Date().toLocaleTimeString();

            // Analytics
            if (status.uptime) {
                const seconds = Math.floor(status.uptime / 1000);
                const minutes = Math.floor(seconds / 60);
                const hours = Math.floor(minutes / 60);
                document.getElementById('uptime').textContent = hours + 'h ' + (minutes % 60) + 'm';
            }
            if (status.nodeVersion) {
                document.getElementById('node-version').textContent = status.nodeVersion;
            }
            if (status.pid) {
                const pidEl = document.getElementById('pid');
                if (pidEl) pidEl.textContent = status.pid;
            }
            
            // Platform info (static, set once)
            const platformEl = document.getElementById('platform-info');
            if (platformEl && platformEl.textContent === 'Loading...') {
                platformEl.innerHTML = 'OS: ' + navigator.platform + '<br>Browser: ' + navigator.userAgent.split(' ').slice(-1)[0];
            }
        }

        // Refresh Promises
        function refreshPromises() {
            fetch('/api/promises')
                .then(r => r.json())
                .then(data => {
                    pendingPromises = data;
                    updatePromisesView();
                })
                .catch(err => console.error('Error fetching promises:', err));
        }

        // Update Promises View
        function updatePromisesView() {
            const container = document.getElementById('promises-list');
            container.innerHTML = '';

            if (pendingPromises.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-secondary);">✅ No pending promises - all clear!</div>';
                return;
            }

            pendingPromises.forEach(promise => {
                const age = Math.floor((Date.now() - promise.createdAt) / 1000);
                const isCritical = age > 30;
                
                const div = document.createElement('div');
                div.className = 'promise-item' + (isCritical ? ' critical' : '');
                div.innerHTML = \`
                    <div class="promise-header">
                        <span class="promise-id">Promise #\${promise.asyncId}</span>
                        <span class="promise-age \${isCritical ? 'critical' : 'warning'}">\${age}s old</span>
                    </div>
                    <div style="color: var(--text-secondary); margin-bottom: 8px;">
                        Status: \${promise.status}
                    </div>
                    \${promise.file ? '<div class="event-file">📍 ' + promise.file + ':' + promise.line + '</div>' : ''}
                    \${isCritical ? '<div style="margin-top: 12px; padding: 12px; background: rgba(239, 68, 68, 0.1); border-radius: 6px; color: var(--accent-red);">⚠️ Warning: This promise has been pending for a long time. Possible deadlock!</div>' : ''}
                \`;
                container.appendChild(div);
            });
        }

        // Refresh Memory
        function refreshMemory() {
            fetch('/api/memory')
                .then(r => r.json())
                .then(data => {
                    memorySnapshots = data;
                    // Memory chart already updates via status updates
                })
                .catch(err => console.error('Error fetching memory:', err));
        }

        // Add Event
        function addEvent(event) {
            allEvents.unshift(event);
            if (allEvents.length > MAX_EVENTS) allEvents = allEvents.slice(0, MAX_EVENTS);

            if (currentFilter === 'all' || currentFilter === event.severity) {
                renderEvent(event, 'events-container');
            }
            renderEvent(event, 'all-events-container');
        }

        function renderEvent(event, containerId) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const time = new Date(event.timestamp).toLocaleTimeString();

            const div = document.createElement('div');
            div.className = 'event-row';
            div.style.cursor = 'pointer';

            // Format event data for display
            const dataDetails = event.data ? Object.entries(event.data)
                .map(([key, value]) => {
                    if (key === 'stack') {
                        return \`<div style="margin-top: 8px;"><strong>\${key}:</strong><pre style="margin: 4px 0; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 4px; overflow-x: auto; font-size: 11px;">\${value}</pre></div>\`;
                    }
                    return \`<div><strong>\${key}:</strong> \${JSON.stringify(value)}</div>\`;
                }).join('') : '';

            div.innerHTML = \`
                <div class="event-main">
                    <div class="event-type">
                        <span class="event-badge \${event.severity}">\${event.severity}</span>
                        \${event.type}
                    </div>
                    <span class="event-time">\${time}</span>
                </div>
                <div class="event-details">
                    <div style="font-weight: 500; margin-bottom: 8px;">\${event.message || ''}</div>
                    \${event.file ? '<div class="event-file">📍 ' + event.file + (event.line ? ':' + event.line : '') + '</div>' : ''}
                    \${event.data?.function ? '<div style="margin-top: 4px;"><strong>Function:</strong> ' + event.data.function + '</div>' : ''}
                    \${event.data?.duration ? '<div><strong>Duration:</strong> ' + event.data.duration + 'ms</div>' : ''}
                    <div class="event-data-toggle" style="margin-top: 8px; display: none;">
                        \${dataDetails}
                    </div>
                    \${event.suggestion ? '<div style="margin-top: 8px; padding: 8px; background: rgba(59, 130, 246, 0.1); border-left: 3px solid #3b82f6; border-radius: 4px;"><strong>💡 Suggestion:</strong><br>' + event.suggestion + '</div>' : ''}
                </div>
            \`;

            // Click to toggle details
            div.addEventListener('click', () => {
                const toggle = div.querySelector('.event-data-toggle');
                if (toggle) {
                    toggle.style.display = toggle.style.display === 'none' ? 'block' : 'none';
                }
            });

            container.insertBefore(div, container.firstChild);

            // Keep only last 50 events
            while (container.children.length > MAX_DOM_EVENTS) {
                container.removeChild(container.lastChild);
            }
        }

        // Filter events
        document.querySelectorAll('.filter-tag').forEach(tag => {
            tag.addEventListener('click', () => {
                document.querySelectorAll('.filter-tag').forEach(t => t.classList.remove('active'));
                tag.classList.add('active');
                
                currentFilter = tag.dataset.filter;
                const container = document.getElementById('events-container');
                container.innerHTML = '';

                allEvents.forEach(event => {
                    if (currentFilter === 'all' || currentFilter === event.severity) {
                        renderEvent(event, 'events-container');
                    }
                });
            });
        });

        // Search
        document.getElementById('search').addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            if (!query) {
                // Show all
                document.querySelectorAll('.event-row').forEach(row => row.style.display = '');
                return;
            }

            document.querySelectorAll('.event-row').forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(query) ? '' : 'none';
            });
        });

        // Export Data
        function exportData() {
            const exportData = {
                timestamp: new Date().toISOString(),
                events: allEvents,
                promises: pendingPromises,
                memory: memorySnapshots,
                status: lastStatus
            };
            
            const data = JSON.stringify(exportData, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'guardian-report-' + Date.now() + '.json';
            a.click();
            URL.revokeObjectURL(url);
        }

        // Settings Modal
        function openSettings() {
            document.getElementById('settings-modal').classList.add('active');
        }

        function closeSettings() {
            document.getElementById('settings-modal').classList.remove('active');
        }

        function saveSettings() {
            // Get settings values
            const refreshRate = document.getElementById('setting-refresh').value;
            const maxEvents = document.getElementById('setting-max-events').value;
            const theme = document.getElementById('setting-theme').value;
            
            // Apply settings
            alert('Settings saved!\\nRefresh: ' + refreshRate + 's\\nMax Events: ' + maxEvents + '\\nTheme: ' + theme);
            
            if (theme !== currentTheme) {
                toggleTheme();
            }
            
            closeSettings();
        }

        // Theme Toggle
        function toggleTheme() {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            if (currentTheme === 'light') {
                document.documentElement.style.setProperty('--bg-primary', '#f1f5f9');
                document.documentElement.style.setProperty('--bg-secondary', '#ffffff');
                document.documentElement.style.setProperty('--bg-tertiary', '#e2e8f0');
                document.documentElement.style.setProperty('--text-primary', '#0f172a');
                document.documentElement.style.setProperty('--text-secondary', '#475569');
                document.documentElement.style.setProperty('--border-color', '#e2e8f0');
                document.querySelector('.theme-toggle').textContent = '☀️';
            } else {
                document.documentElement.style.setProperty('--bg-primary', '#0f172a');
                document.documentElement.style.setProperty('--bg-secondary', '#1e293b');
                document.documentElement.style.setProperty('--bg-tertiary', '#334155');
                document.documentElement.style.setProperty('--text-primary', '#f1f5f9');
                document.documentElement.style.setProperty('--text-secondary', '#cbd5e1');
                document.documentElement.style.setProperty('--border-color', '#334155');
                document.querySelector('.theme-toggle').textContent = '🌙';
            }
        }

        // Filter Modal
        function openFilterModal() {
            const filters = prompt('Enter filter (e.g., "critical", "memory", "deadlock"):');
            if (filters) {
                document.getElementById('search').value = filters;
                document.getElementById('search').dispatchEvent(new Event('input'));
            }
        }

        // Initialize
        initCharts();
        
        // Refresh promises every 5 seconds
        setInterval(refreshPromises, 10000);

        // Periodic cleanup
        setInterval(() => {
            if (allEvents.length > MAX_EVENTS) {
                allEvents = allEvents.slice(0, MAX_EVENTS);
            }
            updateCounter = 0;
        }, 30000);
    </script>
</body>
</html>
    `;
    }
}
