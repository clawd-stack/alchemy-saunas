/**
 * Claude Code Bridge Server
 * Spawns `claude` CLI sessions and streams output back via SSE.
 * Run with: node server.js
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const url = require('url');

const PORT = 3456;
const HOST = '127.0.0.1';
const WORKING_DIR = path.resolve(__dirname);

let activeProcess = null;
let activeRes = null;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function killActive() {
  if (activeProcess) {
    try { activeProcess.kill('SIGTERM'); } catch (_) {}
    activeProcess = null;
  }
  if (activeRes && !activeRes.writableEnded) {
    try { activeRes.end(); } catch (_) {}
    activeRes = null;
  }
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const { pathname } = url.parse(req.url);

  // GET /status — check if a session is currently running
  if (req.method === 'GET' && pathname === '/status') {
    return sendJson(res, 200, { running: activeProcess !== null, cwd: WORKING_DIR });
  }

  // POST /stop — cancel the active session
  if (req.method === 'POST' && pathname === '/stop') {
    const wasRunning = activeProcess !== null;
    if (wasRunning) {
      if (activeRes && !activeRes.writableEnded) {
        activeRes.write(`data: ${JSON.stringify({ type: 'stopped' })}\n\n`);
      }
      killActive();
    }
    return sendJson(res, 200, { stopped: wasRunning });
  }

  // POST /run — spawn a claude CLI session and stream output via SSE
  if (req.method === 'POST' && pathname === '/run') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let prompt;
      try {
        ({ prompt } = JSON.parse(body));
      } catch (_) {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
      }
      if (!prompt || typeof prompt !== 'string') {
        return sendJson(res, 400, { error: 'prompt (string) is required' });
      }

      // Kill any in-flight session before starting a new one
      killActive();

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send a heartbeat comment so the browser knows the connection opened
      res.write(': connected\n\n');

      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--cwd', WORKING_DIR,
        '--verbose',
      ];

      const proc = spawn('claude', args, {
        cwd: WORKING_DIR,
        shell: process.platform === 'win32',
        env: process.env,
      });

      activeProcess = proc;
      activeRes = res;

      let stdoutBuf = '';

      proc.stdout.on('data', data => {
        stdoutBuf += data.toString();
        // Flush complete newline-delimited JSON lines as SSE events
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            res.write(`data: ${trimmed}\n\n`);
          }
        }
      });

      proc.stderr.on('data', data => {
        const msg = data.toString().trim();
        if (msg) {
          // Forward stderr as a structured event (not a fatal error — Claude Code
          // sometimes writes progress messages to stderr)
          res.write(`data: ${JSON.stringify({ type: 'stderr', message: msg })}\n\n`);
        }
      });

      proc.on('close', code => {
        // Flush any remaining buffer content
        const remaining = stdoutBuf.trim();
        if (remaining) res.write(`data: ${remaining}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', exitCode: code ?? 0 })}\n\n`);
        if (!res.writableEnded) res.end();
        activeProcess = null;
        activeRes = null;
      });

      proc.on('error', err => {
        const msg = err.code === 'ENOENT'
          ? 'claude CLI not found. Is Claude Code installed and on your PATH?'
          : err.message;
        res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
        if (!res.writableEnded) res.end();
        activeProcess = null;
        activeRes = null;
      });

      // If the browser disconnects, kill the subprocess
      req.on('close', () => {
        if (activeProcess === proc) killActive();
      });
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`\nClaude Code bridge server running on http://localhost:${PORT}`);
  console.log(`Working directory: ${WORKING_DIR}`);
  console.log('\nEndpoints:');
  console.log(`  POST /run    — run a prompt via claude CLI (SSE stream)`);
  console.log(`  GET  /status — check if a session is running`);
  console.log(`  POST /stop   — cancel the active session\n`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is the server already running?\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
