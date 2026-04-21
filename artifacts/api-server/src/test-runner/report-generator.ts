import * as fs from "fs";
import * as path from "path";
import type { StageResult } from "./runner.js";

// ─── Types ─────────────────────────────────────────────────────────────────

interface BatchStep {
  n: number;
  strategy: "additive" | "unsub-resub";
  result: "ok" | "fail" | "skip";
  ackMs?: number;
  note?: string;
}

export interface RunData {
  startedAt: Date;
  logLines: string[];
  stages: StageResult[];
}

// ─── Public API ────────────────────────────────────────────────────────────

export function createRunData(): RunData {
  return { startedAt: new Date(), logLines: [], stages: [] };
}

export function feedEvent(data: RunData, event: Record<string, unknown>): void {
  if (event.type === "log") {
    data.logLines.push(`[${event.level}] ${event.message}`);
  } else if (event.type === "stage-end") {
    data.stages.push(event as unknown as StageResult);
  }
}

export function saveReport(data: RunData, dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = data.startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(dir, `test-run-${ts}.md`);
  fs.writeFileSync(filePath, buildMarkdown(data));
  return filePath;
}

// ─── Markdown builder ──────────────────────────────────────────────────────

function buildMarkdown(data: RunData): string {
  const passed = data.stages.filter((s) => s.success).length;
  const failed = data.stages.filter((s) => !s.success).length;
  const totalMs = data.stages.reduce((acc, s) => acc + s.duration, 0);
  const lines: string[] = [];

  const pad = (s: string, w: number) => s.slice(0, w).padEnd(w);

  lines.push("# Penny Pincher API Test Report");
  lines.push(`**Run started:** ${data.startedAt.toISOString()}`);
  lines.push(`**Result:** ${passed} passed, ${failed} failed — ${(totalMs / 1000).toFixed(1)}s total`);
  lines.push("");

  // Stage summary table
  lines.push("## Stage Summary");
  lines.push("");
  lines.push("| Stage | Name | Result | Duration |");
  lines.push("|-------|------|--------|----------|");
  for (const s of data.stages) {
    const icon = s.success ? "✅" : "❌";
    lines.push(`| ${s.stage} | ${s.name} | ${icon} ${s.success ? "passed" : "failed"} | ${(s.duration / 1000).toFixed(2)}s |`);
  }
  lines.push("");

  // Per-stage details
  for (const s of data.stages) {
    lines.push(`## Stage ${s.stage}: ${s.name}`);
    lines.push("");

    if (s.errors.length > 0) {
      lines.push("**Errors:**");
      s.errors.forEach((e) => lines.push(`- ${e}`));
      lines.push("");
    }

    // Stage 4: batch capacity tables
    if (s.stage === 4) {
      const d = s.details as {
        mintPoolSize?: number;
        walletPoolSize?: number;
        maxTokenBatchConfirmed?: number;
        maxWalletBatchConfirmed?: number;
        tokenSteps?: BatchStep[];
        walletSteps?: BatchStep[];
      };

      lines.push(`**Address pool:** ${d.mintPoolSize ?? 0} mints, ${d.walletPoolSize ?? 0} wallets`);
      lines.push(`**Max token subscription confirmed:** ${d.maxTokenBatchConfirmed ?? 0} keys`);
      lines.push(`**Max wallet subscription confirmed:** ${d.maxWalletBatchConfirmed ?? 0} keys`);
      lines.push("");

      if (d.tokenSteps && d.tokenSteps.length > 0) {
        lines.push("### subscribeTokenTrade Ramp");
        lines.push("");
        lines.push(`| ${pad("N", 5)} | ${pad("Strategy", 12)} | ${pad("Result", 8)} | Ack ms | Note |`);
        lines.push(`|${"-".repeat(7)}|${"-".repeat(14)}|${"-".repeat(10)}|--------|------|`);
        for (const step of d.tokenSteps) {
          lines.push(
            `| ${pad(String(step.n), 5)} | ${pad(step.strategy, 12)} | ${pad(step.result, 8)} | ${step.ackMs ?? "-"} | ${step.note ?? ""} |`
          );
        }
        lines.push("");
      }

      if (d.walletSteps && d.walletSteps.length > 0) {
        lines.push("### subscribeAccountTrade Ramp");
        lines.push("");
        lines.push(`| ${pad("N", 5)} | ${pad("Strategy", 12)} | ${pad("Result", 8)} | Ack ms | Note |`);
        lines.push(`|${"-".repeat(7)}|${"-".repeat(14)}|${"-".repeat(10)}|--------|------|`);
        for (const step of d.walletSteps) {
          lines.push(
            `| ${pad(String(step.n), 5)} | ${pad(step.strategy, 12)} | ${pad(step.result, 8)} | ${step.ackMs ?? "-"} | ${step.note ?? ""} |`
          );
        }
        lines.push("");
      }
    } else {
      // Generic details
      const detailEntries = Object.entries(s.details).filter(
        ([, v]) => !Array.isArray(v) && typeof v !== "object"
      );
      if (detailEntries.length > 0) {
        detailEntries.forEach(([k, v]) => lines.push(`- **${k}:** ${v}`));
        lines.push("");
      }
    }
  }

  // Full log
  lines.push("## Full Log");
  lines.push("");
  lines.push("```");
  data.logLines.forEach((l) => lines.push(l));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}
