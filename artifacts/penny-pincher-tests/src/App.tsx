import { useState, useEffect, useRef, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";

type LogLevel = "info" | "success" | "warn" | "error" | "header" | "section" | "divider";

interface LogEvent { type: "log"; level: LogLevel; message: string; }
interface StageStartEvent { type: "stage-start"; stage: number; name: string; }
interface StageEndEvent { type: "stage-end"; stage: number; name: string; success: boolean; duration: number; errors: string[]; }
interface SyntaxResultEvent { type: "syntax-result"; provider: string; method: string; passed: boolean; error?: string; }
interface CompleteEvent { type: "complete"; totalDuration: number; passed: number; failed: number; reportPath?: string; }
interface ServerCompleteEvent { type: "server-complete"; reportPath: string | null; }
interface ServerErrorEvent { type: "server-error"; error: string; }

type RunEvent = LogEvent | StageStartEvent | StageEndEvent | SyntaxResultEvent | CompleteEvent | ServerCompleteEvent | ServerErrorEvent;

interface StageState {
  name: string;
  status: "pending" | "running" | "passed" | "failed";
  duration?: number;
  errors: string[];
}

interface LogLine {
  id: number;
  level: LogLevel;
  message: string;
}

const STAGE_NAMES = ["Token Resolution", "Balance Checks", "Swap Quotes", "Transaction Simulation"];

function levelColor(level: LogLevel): string {
  switch (level) {
    case "success": return "text-green-400";
    case "error": return "text-red-400";
    case "warn": return "text-yellow-400";
    case "header": return "text-purple-300 font-bold";
    case "section": return "text-blue-300 font-semibold";
    case "divider": return "text-gray-600";
    default: return "text-gray-300";
  }
}

function Dashboard() {
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"all" | "syntax">("all");
  const [stages, setStages] = useState<StageState[]>(
    STAGE_NAMES.map(name => ({ name, status: "pending", errors: [] }))
  );
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [syntaxResults, setSyntaxResults] = useState<{ passed: number; failed: number }>({ passed: 0, failed: 0 });
  const [complete, setComplete] = useState<{ passed: number; failed: number; duration: number } | null>(null);
  const [hasReport, setHasReport] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  const addLog = useCallback((level: LogLevel, message: string) => {
    const id = ++logIdRef.current;
    setLogs(prev => [...prev.slice(-499), { id, level, message }]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const startRun = useCallback(async (m: "all" | "syntax") => {
    setMode(m);
    setRunning(true);
    setError(null);
    setComplete(null);
    setHasReport(false);
    setLogs([]);
    setSyntaxResults({ passed: 0, failed: 0 });
    setStages(STAGE_NAMES.map(name => ({ name, status: "pending", errors: [] })));

    try {
      const res = await fetch(`/api/tests/run/${m}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const { runId: rid } = await res.json();
      setRunId(rid);

      const sse = new EventSource(`/api/tests/stream?runId=${rid}`);

      sse.onmessage = (ev) => {
        const event: RunEvent = JSON.parse(ev.data);

        if (event.type === "log") {
          addLog(event.level, event.message);
        } else if (event.type === "stage-start") {
          setStages(prev => prev.map((s, i) =>
            i === event.stage - 1 ? { ...s, status: "running" } : s
          ));
        } else if (event.type === "stage-end") {
          setStages(prev => prev.map((s, i) =>
            i === event.stage - 1 ? { ...s, status: event.success ? "passed" : "failed", duration: event.duration, errors: event.errors } : s
          ));
        } else if (event.type === "syntax-result") {
          setSyntaxResults(prev => ({
            passed: prev.passed + (event.passed ? 1 : 0),
            failed: prev.failed + (event.passed ? 0 : 1),
          }));
          addLog(event.passed ? "success" : "error",
            `${event.passed ? "✓" : "✗"} ${event.provider}/${event.method}${event.error ? `: ${event.error}` : ""}`
          );
        } else if (event.type === "complete") {
          setComplete({ passed: event.passed, failed: event.failed, duration: event.totalDuration });
          setRunning(false);
          sse.close();
        } else if (event.type === "server-complete") {
          setHasReport(!!event.reportPath);
          setRunning(false);
          sse.close();
        } else if (event.type === "server-error") {
          setError(event.error);
          setRunning(false);
          sse.close();
        }
      };

      sse.onerror = () => {
        setRunning(false);
        sse.close();
      };

    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
    }
  }, [addLog]);

  const downloadReport = async () => {
    window.open("/api/tests/report/download", "_blank");
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-primary">🪙 Penny Pincher API Tests</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Solana DEX API validation suite</p>
        </div>
        {complete && (
          <div className={`text-sm font-semibold px-3 py-1 rounded-full ${complete.failed === 0 ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
            {complete.passed}/{complete.passed + complete.failed} passed · {(complete.duration / 1000).toFixed(1)}s
          </div>
        )}
      </div>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Controls */}
        <div className="flex flex-wrap gap-3 items-center">
          <button
            onClick={() => startRun("all")}
            disabled={running}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {running && mode === "all" ? "⏳ Running All Stages..." : "▶ Run All Stages"}
          </button>
          <button
            onClick={() => startRun("syntax")}
            disabled={running}
            className="px-5 py-2 rounded-lg bg-secondary text-secondary-foreground font-semibold text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {running && mode === "syntax" ? "⏳ Running Syntax..." : "🔍 Syntax Tests Only"}
          </button>
          {hasReport && (
            <button
              onClick={downloadReport}
              className="px-5 py-2 rounded-lg bg-accent text-accent-foreground font-semibold text-sm hover:opacity-90 transition-opacity"
            >
              ⬇ Download Report
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-500/40 text-red-300 px-4 py-3 rounded-lg text-sm">
            ✗ Error: {error}
          </div>
        )}

        {/* Stage Cards (All Stages mode) */}
        {mode === "all" && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {stages.map((s, i) => (
              <div
                key={i}
                className={`rounded-xl border p-4 transition-all ${
                  s.status === "running" ? "border-yellow-500/60 bg-yellow-500/5 animate-pulse" :
                  s.status === "passed" ? "border-green-500/60 bg-green-500/5" :
                  s.status === "failed" ? "border-red-500/60 bg-red-500/5" :
                  "border-border bg-card"
                }`}
              >
                <div className="text-xs text-muted-foreground mb-1">Stage {i + 1}</div>
                <div className="text-sm font-semibold leading-tight">{s.name}</div>
                <div className={`text-xs mt-2 font-mono ${
                  s.status === "running" ? "text-yellow-400" :
                  s.status === "passed" ? "text-green-400" :
                  s.status === "failed" ? "text-red-400" :
                  "text-muted-foreground"
                }`}>
                  {s.status === "pending" && "· pending"}
                  {s.status === "running" && "▶ running"}
                  {s.status === "passed" && `✓ ${s.duration ? (s.duration / 1000).toFixed(1) + "s" : "passed"}`}
                  {s.status === "failed" && "✗ failed"}
                </div>
                {s.errors.length > 0 && (
                  <div className="mt-1 text-xs text-red-400 line-clamp-2">{s.errors[0]}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Syntax Results Summary */}
        {mode === "syntax" && (syntaxResults.passed > 0 || syntaxResults.failed > 0) && (
          <div className="flex gap-4">
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3 text-center">
              <div className="text-2xl font-bold text-green-400">{syntaxResults.passed}</div>
              <div className="text-xs text-muted-foreground">passed</div>
            </div>
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-center">
              <div className="text-2xl font-bold text-red-400">{syntaxResults.failed}</div>
              <div className="text-xs text-muted-foreground">failed</div>
            </div>
          </div>
        )}

        {/* Live Log */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Live Log</span>
            {running && <span className="text-xs text-yellow-400 animate-pulse">● streaming</span>}
          </div>
          <div className="h-96 overflow-y-auto p-4 space-y-0.5 text-xs font-mono">
            {logs.length === 0 && !running && (
              <div className="text-muted-foreground text-center pt-8">
                Press a button above to start a test run
              </div>
            )}
            {logs.map(line => (
              <div key={line.id} className={levelColor(line.level)}>
                {line.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Switch>
        <Route path="/" component={Dashboard} />
      </Switch>
    </WouterRouter>
  );
}

export default App;
