import * as fs from "fs";
import * as path from "path";
import type { StageResult, BatchStep } from "./runner.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RunData {
  startedAt: Date;
  logLines: string[];
  stages: StageResult[];
}

// ─── Public API ────────────────────────────────────────────────────────────

export function createRunData(): RunData {
  return { startedAt: new Date(), logLines: [], stages: [] };
}

/**
 * Feed an SSE event into the run data accumulator.
 * - "log" events are appended to logLines
 * - "complete" events populate stages from event.results (full StageResult array)
 */
export function feedEvent(data: RunData, event: Record<string, unknown>): void {
  if (event.type === "log" && typeof event.level === "string" && typeof event.message === "string") {
    data.logLines.push(`[${event.level}] ${event.message}`);
  } else if (event.type === "complete" && Array.isArray(event.results)) {
    // "complete" carries the full results array with name + details intact
    data.stages = event.results as StageResult[];
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
  const totalMs = data.stages.reduce((acc, s) => acc + (s.duration ?? 0), 0);
  const lines: string[] = [];

  const padStr = (s: string, w: number) => s.slice(0, w).padEnd(w);

  lines.push("# Penny Pincher API Test Report");
  lines.push(`**Run started:** ${data.startedAt.toISOString()}`);
  lines.push(`**Result:** ${passed} passed, ${failed} failed — ${(totalMs / 1000).toFixed(1)}s total`);
  lines.push("");

  if (data.stages.length === 0) {
    lines.push("_No stage data recorded (syntax-check run or no stages completed)._");
    lines.push("");
  } else {
    // Stage summary table
    lines.push("## Stage Summary");
    lines.push("");
    lines.push("| Stage | Name | Result | Duration |");
    lines.push("|-------|------|--------|----------|");
    for (const s of data.stages) {
      const icon = s.success ? "✅" : "❌";
      lines.push(`| ${s.stage} | ${s.name ?? "—"} | ${icon} ${s.success ? "passed" : "failed"} | ${((s.duration ?? 0) / 1000).toFixed(2)}s |`);
    }
    lines.push("");

    // Per-stage details
    for (const s of data.stages) {
      lines.push(`## Stage ${s.stage}: ${s.name ?? "—"}`);
      lines.push("");

      if (s.errors && s.errors.length > 0) {
        lines.push("**Errors:**");
        s.errors.forEach((e) => lines.push(`- ${e}`));
        lines.push("");
      }

      const det = s.details ?? {};

      // Stage 4: batch capacity tables
      if (s.stage === 4) {
        const tokenSteps = (det.tokenSteps ?? []) as BatchStep[];
        const walletSteps = (det.walletSteps ?? []) as BatchStep[];

        lines.push(`**Address pool:** ${det.mintPoolSize ?? 0} mints (${det.sentinelMints ?? 0} sentinels), ${det.walletPoolSize ?? 0} wallets`);
        lines.push(`**Max token subscription trade-confirmed:** ${det.maxTokenBatchConfirmed ?? 0} keys`);
        lines.push(`**Max wallet subscription trade-confirmed:** ${det.maxWalletBatchConfirmed ?? 0} keys`);
        lines.push("");

        if (tokenSteps.length > 0) {
          lines.push("### subscribeTokenTrade Ramp");
          lines.push("");
          lines.push(`| ${padStr("N", 5)} | ${padStr("Strategy", 12)} | ${padStr("Result", 12)} | Ack ms | Trade ms | Note |`);
          lines.push(`|${"-".repeat(7)}|${"-".repeat(14)}|${"-".repeat(14)}|--------|----------|------|`);
          for (const step of tokenSteps) {
            lines.push(
              `| ${padStr(String(step.n), 5)} | ${padStr(step.strategy, 12)} | ${padStr(step.result, 12)} | ${step.ackMs ?? "-"} | ${step.tradeMs ?? "-"} | ${step.note ?? ""} |`
            );
          }
          lines.push("");
        }

        if (walletSteps.length > 0) {
          lines.push("### subscribeAccountTrade Ramp");
          lines.push("");
          lines.push(`| ${padStr("N", 5)} | ${padStr("Strategy", 12)} | ${padStr("Result", 12)} | Ack ms | Trade ms | Note |`);
          lines.push(`|${"-".repeat(7)}|${"-".repeat(14)}|${"-".repeat(14)}|--------|----------|------|`);
          for (const step of walletSteps) {
            lines.push(
              `| ${padStr(String(step.n), 5)} | ${padStr(step.strategy, 12)} | ${padStr(step.result, 12)} | ${step.ackMs ?? "-"} | ${step.tradeMs ?? "-"} | ${step.note ?? ""} |`
            );
          }
          lines.push("");
        }
      } else {
        // Generic scalar details
        const scalars = Object.entries(det).filter(
          ([, v]) => !Array.isArray(v) && typeof v !== "object"
        );
        if (scalars.length > 0) {
          scalars.forEach(([k, v]) => lines.push(`- **${k}:** ${v}`));
          lines.push("");
        }
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
