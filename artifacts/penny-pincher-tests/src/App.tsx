import { useState, useEffect, useRef, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";

type LogLevel = "info" | "success" | "warn" | "error" | "header" | "section" | "divider";

interface LogEvent { type: "log"; level: LogLevel; message: string; }
interface StageStartEvent { type: "stage-start"; stage: number; name: string; }
interface StageEndEvent {
  type: "stage-end";
  stage: number;
  name: string;
  success: boolean;
  duration: number;
  errors: string[];
  details?: Record<string, unknown>;
}
interface SyntaxResultEvent { type: "syntax-result"; provider: string; method: string; passed: boolean; error?: string; }
interface CompleteEvent { type: "complete"; totalDuration: number; passed: number; failed: number; results?: unknown[]; }
interface ServerCompleteEvent { type: "server-complete"; reportPath: string | null; }
interface ServerErrorEvent { type: "server-error"; error: string; }

type RunEvent = LogEvent | StageStartEvent | StageEndEvent | SyntaxResultEvent | CompleteEvent | ServerCompleteEvent | ServerErrorEvent;

interface BatchStep {
  n: number;
  strategy: "additive" | "unsub-resub";
  result: "ok" | "ack-no-trade" | "fail" | "skip";
  ackMs?: number;
  tradeMs?: number;
  note?: string;
}

interface StageState {
  name: string;
  status: "pending" | "running" | "passed" | "failed";
  duration?: number;
  errors: string[];
  details?: Record<string, unknown>;
}

interface LogLine {
  id: number;
  level: LogLevel;
  message: string;
}

// Dynamic stage definitions — will grow as stage-start events arrive
const INITIAL_STAGES: StageState[] = [];

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

// Resolve the API base URL — in development, the API server is proxied at /api
// In production (deployed), same path routing applies
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
// The API server lives at /api regardless of the frontend's base path
const API = "/api";

function BatchTable({ steps, label }: { steps: BatchStep[]; label: string }) {
  const unsubSteps = steps.filter((s) => s.strategy === "unsub-resub");
  const addSteps = steps.filter((s) => s.strategy === "additive");
  if (unsubSteps.length === 0 && addSteps.length === 0) return null;

  const resultCell = (r: BatchStep) => {
    if (r.result === "ok") return <td className="text-green-400 font-semibold">✓ trade {r.tradeMs}ms</td>;
    if (r.result === "ack-no-trade") return <td className="text-yellow-400">⚠ ack-only {r.ackMs}ms</td>;
    if (r.result === "fail") return <td className="text-red-400">✗ fail</td>;
    return <td className="text-gray-500">— skip</td>;
  };

  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-blue-300 mb-1">{label}</div>
      <div className="overflow-x-auto">
        <table className="text-xs w-full border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-700">
              <th className="text-left pr-3 py-1">N</th>
              <th className="text-left pr-3 py-1">unsub+resub</th>
              <th className="text-left py-1">additive</th>
            </tr>
          </thead>
          <tbody>
            {[...new Set([...unsubSteps, ...addSteps].map((s) => s.n))].map((n) => {
              const u = unsubSteps.find((s) => s.n === n);
              const a = addSteps.find((s) => s.n === n);
              return (
                <tr key={n} className="border-b border-gray-800">
                  <td className="pr-3 py-0.5 text-gray-400">{n}</td>
                  {u ? resultCell(u) : <td className="text-gray-600">—</td>}
                  {a ? resultCell(a) : <td className="text-gray-600">—</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stage4Details({ details }: { details: Record<string, unknown> }) {
  const tokenSteps = (details.tokenSteps ?? []) as BatchStep[];
  const walletSteps = (details.walletSteps ?? []) as BatchStep[];
  const maxToken = details.maxTokenBatchConfirmed as number | undefined;
  const maxWallet = details.maxWalletBatchConfirmed as number | undefined;

  return (
    <div className="mt-3 space-y-1 text-xs text-gray-400">
      <div>Pool: {details.mintPoolSize as number} mints ({details.sentinelMints as number} sentinels), {details.walletPoolSize as number} wallets</div>
      {maxToken !== undefined && <div>Max token trade-confirmed: <span className="text-green-400 font-semibold">{maxToken}</span> keys</div>}
      {maxWallet !== undefined && <div>Max wallet trade-confirmed: <span className="text-green-400 font-semibold">{maxWallet}</span> keys</div>}
      <BatchTable steps={tokenSteps} label="subscribeTokenTrade" />
      <BatchTable steps={walletSteps} label="subscribeAccountTrade" />
    </div>
  );
}

function Stage5Details({ details }: { details: Record<string, unknown> }) {
  const sample = details.topTokenSample as string[] | undefined;
  return (
    <div className="mt-2 space-y-0.5 text-xs text-gray-400">
      <div>
        Health: <span className={(details.healthOk as boolean) ? "text-green-400" : "text-red-400"}>{(details.healthOk as boolean) ? "✓ up" : "✗ unreachable"}</span>
        {" · "}Top tokens HTTP: {details.topTokensHttpStatus as number ?? "—"}
      </div>
      <div>
        Top Solana tokens: <span className={`font-semibold ${(details.topTokenCount as number) > 0 ? "text-green-400" : "text-yellow-400"}`}>{details.topTokenCount as number ?? 0}</span>
      </div>
      {sample && sample.length > 0 && <div className="truncate">Sample: {sample.join(", ")}</div>}
      <div>
        Bonding mints queried: {details.bondingMintsQueried as number ?? 0} · Found on DexPaprika: {details.bondingMintsFoundOnDexPaprika as number ?? 0}
      </div>
      {details.note && <div className="text-yellow-400">{details.note as string}</div>}
    </div>
  );
}

function Stage6Details({ details }: { details: Record<string, unknown> }) {
  type ProvResult = { connected: boolean; ackReceived: boolean; tradeReceived: boolean; firstTradeMs?: number; note?: string };
  const pp = details.pumpportal as ProvResult | undefined;
  const pd = details.pumpdev as ProvResult | undefined;

  const row = (name: string, r: ProvResult | undefined) => {
    if (!r) return null;
    return (
      <tr key={name} className="border-b border-gray-800">
        <td className="pr-3 py-0.5 text-gray-300">{name}</td>
        <td className={`pr-3 ${r.connected ? "text-green-400" : "text-red-400"}`}>{r.connected ? "✓" : "✗"}</td>
        <td className={`pr-3 ${r.ackReceived ? "text-green-400" : "text-yellow-400"}`}>{r.ackReceived ? "✓" : "—"}</td>
        <td className={r.tradeReceived ? "text-green-400 font-semibold" : "text-yellow-400"}>
          {r.tradeReceived ? `✓ ${r.firstTradeMs}ms` : "—"}
        </td>
      </tr>
    );
  };

  return (
    <div className="mt-3 space-y-1 text-xs text-gray-400">
      <div>Graduated mints from DexScreener: {details.graduatedMintCount as number ?? 0}</div>
      <table className="text-xs w-full border-collapse mt-2">
        <thead>
          <tr className="text-gray-500 border-b border-gray-700">
            <th className="text-left pr-3 py-1">Provider</th>
            <th className="text-left pr-3 py-1">Connected</th>
            <th className="text-left pr-3 py-1">Ack</th>
            <th className="text-left py-1">Trade Event</th>
          </tr>
        </thead>
        <tbody>
          {row("PumpPortal", pp)}
          {row("PumpDev", pd)}
        </tbody>
      </table>
    </div>
  );
}

function StageCard({ stage, index }: { stage: StageState; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = stage.details && Object.keys(stage.details).length > 0;

  return (
    <div className={`rounded-xl border p-4 transition-all ${
      stage.status === "running" ? "border-yellow-500/60 bg-yellow-500/5 animate-pulse" :
      stage.status === "passed" ? "border-green-500/60 bg-green-500/5" :
      stage.status === "failed" ? "border-red-500/60 bg-red-500/5" :
      "border-border bg-card"
    }`}>
      <div className="text-xs text-muted-foreground mb-1">Stage {index + 1}</div>
      <div className="text-sm font-semibold leading-tight">{stage.name}</div>
      <div className={`text-xs mt-2 font-mono ${
        stage.status === "running" ? "text-yellow-400" :
        stage.status === "passed" ? "text-green-400" :
        stage.status === "failed" ? "text-red-400" :
        "text-muted-foreground"
      }`}>
        {stage.status === "pending" && "· pending"}
        {stage.status === "running" && "▶ running"}
        {stage.status === "passed" && `✓ ${stage.duration ? (stage.duration / 1000).toFixed(1) + "s" : "passed"}`}
        {stage.status === "failed" && "✗ failed"}
      </div>
      {stage.errors.length > 0 && (
        <div className="mt-1 text-xs text-red-400 line-clamp-2">{stage.errors[0]}</div>
      )}
      {hasDetails && (stage.status === "passed" || stage.status === "failed") && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          {expanded ? "▲ hide details" : "▼ show details"}
        </button>
      )}
      {expanded && stage.details && (
        <div className="mt-1">
          {index === 3 && <Stage4Details details={stage.details} />}
          {index === 4 && <Stage5Details details={stage.details} />}
          {index === 5 && <Stage6Details details={stage.details} />}
          {index < 3 && (
            <div className="mt-2 text-xs text-gray-400 space-y-0.5">
              {Object.entries(stage.details).map(([k, v]) => (
                <div key={k}>{k}: <span className="text-gray-300">{String(v)}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Dashboard() {
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"all" | "syntax">("all");
  const [stages, setStages] = useState<StageState[]>(INITIAL_STAGES);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [syntaxResults, setSyntaxResults] = useState<{ passed: number; failed: number }>({ passed: 0, failed: 0 });
  const [complete, setComplete] = useState<{ passed: number; failed: number; duration: number } | null>(null);
  const [hasReport, setHasReport] = useState(false);
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
    setStages([]);

    try {
      const res = await fetch(`${API}/tests/run/${m}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      const { runId: rid } = await res.json() as { runId: string };

      const sse = new EventSource(`${API}/tests/stream?runId=${rid}`);

      sse.onmessage = (ev) => {
        const event: RunEvent = JSON.parse(ev.data as string);

        if (event.type === "log") {
          addLog(event.level, event.message);
        } else if (event.type === "stage-start") {
          setStages(prev => {
            const idx = event.stage - 1;
            const next = [...prev];
            while (next.length <= idx) next.push({ name: "", status: "pending", errors: [] });
            next[idx] = { ...next[idx], name: event.name, status: "running" };
            return next;
          });
        } else if (event.type === "stage-end") {
          setStages(prev => {
            const idx = event.stage - 1;
            const next = [...prev];
            while (next.length <= idx) next.push({ name: "", status: "pending", errors: [] });
            next[idx] = {
              name: event.name,
              status: event.success ? "passed" : "failed",
              duration: event.duration,
              errors: event.errors,
              details: event.details,
            };
            return next;
          });
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

  const downloadReport = () => {
    window.open(`${API}/tests/report/download`, "_blank");
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
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
            {running && mode === "syntax" ? "⏳ Running Health Check..." : "🔍 Quick Health Check"}
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

        {/* Stage Cards — dynamic, grows as stages appear */}
        {mode === "all" && stages.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {stages.map((s, i) => (
              <StageCard key={i} stage={s} index={i} />
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
    <WouterRouter base={BASE}>
      <Switch>
        <Route path="/" component={Dashboard} />
      </Switch>
    </WouterRouter>
  );
}

export default App;
