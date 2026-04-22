import { Router, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import { runAllStages, runSyntaxTests, type EmitFn } from "../test-runner/runner.js";
import { createRunData, feedEvent, saveReport } from "../test-runner/report-generator.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, "../reports");

interface RunState {
  clients: Response[];
  buffer: string[];
  done: boolean;
}

const sseRuns = new Map<string, RunState>();
let activeRunId: string | null = null;
let lastReportPath: string | null = null;

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Penny Pincher API Tests</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:'JetBrains Mono','Fira Code','Consolas',monospace;font-size:13px;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#3fb950;font-size:16px;font-weight:700;letter-spacing:-0.5px}
.subtitle{color:#8b949e;font-size:12px;margin-top:2px}
.status-badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.status-pass{background:rgba(63,185,80,.15);color:#3fb950}
.status-fail{background:rgba(248,81,73,.15);color:#f85149}
.main{max-width:1100px;margin:0 auto;padding:24px}
.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:24px}
.btn{padding:8px 18px;border-radius:8px;border:none;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:#3fb950;color:#000}
.btn-secondary{background:#21262d;color:#c9d1d9;border:1px solid #30363d}
.btn-download{background:#1f6feb;color:#fff}
.btn:not(:disabled):hover{opacity:.85}
.error-box{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.4);color:#f85149;padding:12px 16px;border-radius:8px;margin-bottom:20px;font-size:12px}
.stages{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.stage-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:14px;transition:border-color .2s}
.stage-card.running{border-color:#e3b341;background:rgba(227,179,65,.04)}
.stage-card.passed{border-color:#3fb950;background:rgba(63,185,80,.04)}
.stage-card.failed{border-color:#f85149;background:rgba(248,81,73,.04)}
.stage-num{color:#8b949e;font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.stage-name{font-weight:600;font-size:12px;line-height:1.4}
.stage-status{font-size:11px;margin-top:8px}
.stage-status.running{color:#e3b341}
.stage-status.passed{color:#3fb950}
.stage-status.failed{color:#f85149}
.stage-status.pending{color:#6e7681}
.stage-err{color:#f85149;font-size:10px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.syntax-results{display:flex;gap:12px;margin-bottom:24px}
.syntax-card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 18px;text-align:center}
.syntax-num{font-size:26px;font-weight:700}
.syntax-label{font-size:11px;color:#8b949e;margin-top:2px}
.syntax-card.passed .syntax-num{color:#3fb950}
.syntax-card.failed .syntax-num{color:#f85149}
.log-panel{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden}
.log-header{background:#161b22;border-bottom:1px solid #30363d;padding:10px 16px;display:flex;align-items:center;justify-content:space-between}
.log-title{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8b949e;font-weight:600}
.streaming-dot{color:#e3b341;font-size:10px;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.log-body{height:500px;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:1px}
.log-empty{color:#6e7681;text-align:center;padding-top:60px}
.log-line.info{color:#c9d1d9}
.log-line.success{color:#3fb950}
.log-line.error{color:#f85149}
.log-line.warn{color:#e3b341}
.log-line.header{color:#d2a8ff;font-weight:700}
.log-line.section{color:#79c0ff;font-weight:600}
.log-line.divider{color:#30363d}
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">🪙 Penny Pincher API Tests</div>
    <div class="subtitle">Solana DEX API validation suite</div>
  </div>
  <div id="summary-badge"></div>
</div>
<div class="main">
  <div class="controls">
    <button class="btn btn-primary" id="btn-all" onclick="startRun('all')">▶ Run All Stages</button>
    <button class="btn btn-secondary" id="btn-syntax" onclick="startRun('syntax')">🔍 Quick Health Check</button>
    <button class="btn btn-download" id="btn-download" style="display:none" onclick="downloadReport()">⬇ Download Report</button>
  </div>
  <div id="error-box" class="error-box" style="display:none"></div>
  <div id="stages" class="stages" style="display:none">
    <div class="stage-card" id="stage-1">
      <div class="stage-num">Stage 1</div>
      <div class="stage-name">Mint Collection</div>
      <div class="stage-status pending">· pending</div>
    </div>
    <div class="stage-card" id="stage-2">
      <div class="stage-num">Stage 2</div>
      <div class="stage-name">Trade Wallet Collection</div>
      <div class="stage-status pending">· pending</div>
    </div>
    <div class="stage-card" id="stage-3">
      <div class="stage-num">Stage 3</div>
      <div class="stage-name">Wallet History (Chainstack + Shyft)</div>
      <div class="stage-status pending">· pending</div>
    </div>
    <div class="stage-card" id="stage-4">
      <div class="stage-num">Stage 4</div>
      <div class="stage-name">Batch Subscription Capacity</div>
      <div class="stage-status pending">· pending</div>
    </div>
  </div>
  <div id="syntax-results" class="syntax-results" style="display:none">
    <div class="syntax-card passed"><div class="syntax-num" id="syntax-pass">0</div><div class="syntax-label">passed</div></div>
    <div class="syntax-card failed"><div class="syntax-num" id="syntax-fail">0</div><div class="syntax-label">failed</div></div>
  </div>
  <div class="log-panel">
    <div class="log-header">
      <div class="log-title">Live Log</div>
      <div id="streaming-indicator" style="display:none" class="streaming-dot">● streaming</div>
    </div>
    <div class="log-body" id="log-body">
      <div class="log-empty" id="log-empty">Press a button above to start a test run</div>
    </div>
  </div>
</div>
<script>
let running = false;
let syntaxPass = 0, syntaxFail = 0;

function setRunning(val) {
  running = val;
  document.getElementById('btn-all').disabled = val;
  document.getElementById('btn-syntax').disabled = val;
  document.getElementById('streaming-indicator').style.display = val ? 'block' : 'none';
}

function showError(msg) {
  const el = document.getElementById('error-box');
  el.textContent = '✗ ' + msg;
  el.style.display = 'block';
}

function hideError() { document.getElementById('error-box').style.display = 'none'; }

function addLog(level, message) {
  const body = document.getElementById('log-body');
  const empty = document.getElementById('log-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'log-line ' + level;
  div.textContent = message;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

function resetUI() {
  document.getElementById('log-body').innerHTML = '';
  syntaxPass = 0; syntaxFail = 0;
  document.getElementById('syntax-pass').textContent = '0';
  document.getElementById('syntax-fail').textContent = '0';
  document.getElementById('summary-badge').innerHTML = '';
  document.getElementById('btn-download').style.display = 'none';
  hideError();
  ['stage-1','stage-2','stage-3','stage-4'].forEach(id => {
    const el = document.getElementById(id);
    el.className = 'stage-card';
    el.querySelector('.stage-status').className = 'stage-status pending';
    el.querySelector('.stage-status').textContent = '· pending';
    const err = el.querySelector('.stage-err');
    if (err) err.remove();
  });
}

async function startRun(m) {
  if (running) return;
  resetUI();
  document.getElementById('stages').style.display = m === 'all' ? 'grid' : 'none';
  document.getElementById('syntax-results').style.display = m === 'syntax' ? 'flex' : 'none';
  setRunning(true);

  try {
    const res = await fetch('/api/tests/run/' + m, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'HTTP ' + res.status);
    }
    const { runId } = await res.json();

    const sse = new EventSource('/api/tests/stream?runId=' + runId);
    sse.onmessage = (ev) => {
      const event = JSON.parse(ev.data);
      if (event.type === 'log') {
        addLog(event.level, event.message);
      } else if (event.type === 'stage-start') {
        const el = document.getElementById('stage-' + event.stage);
        if (el) {
          el.className = 'stage-card running';
          el.querySelector('.stage-status').className = 'stage-status running';
          el.querySelector('.stage-status').textContent = '▶ running';
        }
      } else if (event.type === 'stage-end') {
        const el = document.getElementById('stage-' + event.stage);
        if (el) {
          el.className = 'stage-card ' + (event.success ? 'passed' : 'failed');
          const st = el.querySelector('.stage-status');
          st.className = 'stage-status ' + (event.success ? 'passed' : 'failed');
          st.textContent = event.success
            ? '✓ ' + (event.duration ? (event.duration/1000).toFixed(1) + 's' : 'passed')
            : '✗ failed';
          if (!event.success && event.errors && event.errors[0]) {
            const err = document.createElement('div');
            err.className = 'stage-err';
            err.textContent = event.errors[0];
            el.appendChild(err);
          }
        }
      } else if (event.type === 'syntax-result') {
        if (event.passed) syntaxPass++; else syntaxFail++;
        document.getElementById('syntax-pass').textContent = syntaxPass;
        document.getElementById('syntax-fail').textContent = syntaxFail;
        addLog(event.passed ? 'success' : 'error',
          (event.passed ? '✓' : '✗') + ' ' + event.provider + '/' + event.method + (event.error ? ': ' + event.error : ''));
      } else if (event.type === 'complete') {
        const ok = event.failed === 0;
        const badge = document.getElementById('summary-badge');
        badge.innerHTML = '<span class="status-badge ' + (ok ? 'status-pass' : 'status-fail') + '">' +
          event.passed + '/' + (event.passed + event.failed) + ' passed · ' + (event.totalDuration/1000).toFixed(1) + 's</span>';
        setRunning(false);
        sse.close();
      } else if (event.type === 'server-complete') {
        if (event.reportPath) document.getElementById('btn-download').style.display = 'inline-block';
        setRunning(false);
        sse.close();
      } else if (event.type === 'server-error') {
        showError(event.error);
        setRunning(false);
        sse.close();
      }
    };
    sse.onerror = () => { setRunning(false); sse.close(); };
  } catch(e) {
    showError(e.message);
    setRunning(false);
  }
}

function downloadReport() {
  window.open('/api/tests/report/download', '_blank');
}
</script>
</body>
</html>`;

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD_HTML);
});

router.post("/run/:mode", async (req: Request, res: Response) => {
  if (activeRunId) {
    res.status(409).json({ error: "A test run is already in progress" });
    return;
  }

  const mode = req.params.mode as "all" | "syntax";
  if (mode !== "all" && mode !== "syntax") {
    res.status(400).json({ error: 'Mode must be "all" or "syntax"' });
    return;
  }

  const runId = Date.now().toString();
  activeRunId = runId;
  lastReportPath = null;

  const state: RunState = { clients: [], buffer: [], done: false };
  sseRuns.set(runId, state);

  res.json({ runId });

  const runData = createRunData();

  const emit: EmitFn = (event) => {
    feedEvent(runData, event as Record<string, unknown>);
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    state.buffer.push(msg);
    for (const c of state.clients) {
      try { c.write(msg); } catch { /* disconnected */ }
    }
  };

  const runFn = mode === "all" ? runAllStages : runSyntaxTests;

  runFn(emit)
    .then(() => {
      lastReportPath = saveReport(runData, REPORTS_DIR);
      const doneMsg = `data: ${JSON.stringify({ type: "server-complete", reportPath: lastReportPath })}\n\n`;
      state.buffer.push(doneMsg);
      state.done = true;
      for (const c of state.clients) {
        try { c.write(doneMsg); c.end(); } catch {}
      }
    })
    .catch((err: Error) => {
      const errMsg = `data: ${JSON.stringify({ type: "server-error", error: err.message })}\n\n`;
      state.buffer.push(errMsg);
      state.done = true;
      for (const c of state.clients) {
        try { c.write(errMsg); c.end(); } catch {}
      }
    })
    .finally(() => {
      activeRunId = null;
      setTimeout(() => sseRuns.delete(runId), 60_000);
    });
});

router.get("/stream", (req: Request, res: Response) => {
  const runId = (req.query.runId as string) || activeRunId;
  if (!runId) {
    res.status(404).json({ error: "No active run" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const state = sseRuns.get(runId);
  if (!state) {
    res.write('data: {"type":"server-error","error":"Run not found or already expired"}\n\n');
    res.end();
    return;
  }

  for (const msg of state.buffer) {
    try { res.write(msg); } catch { /* gone */ }
  }

  if (state.done) { res.end(); return; }

  state.clients.push(res);
  req.on("close", () => {
    const idx = state.clients.indexOf(res);
    if (idx !== -1) state.clients.splice(idx, 1);
  });
});

router.get("/report/download", (_req: Request, res: Response) => {
  if (!lastReportPath || !fs.existsSync(lastReportPath)) {
    res.status(404).json({ error: "No report available. Run the tests first." });
    return;
  }
  res.download(lastReportPath);
});

router.get("/reports", (_req: Request, res: Response) => {
  if (!fs.existsSync(REPORTS_DIR)) { res.json([]); return; }
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
  res.json(files);
});

router.get("/reports/:name", (req: Request, res: Response) => {
  const filePath = path.join(REPORTS_DIR, path.basename(req.params.name));
  if (!fs.existsSync(filePath) || !filePath.startsWith(REPORTS_DIR)) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  res.download(filePath);
});

export default router;
