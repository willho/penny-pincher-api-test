/**
 * Report generator
 * Accumulates events from a test run and produces a markdown report.
 *
 * Exports: createRunData(), feedEvent(data, event), saveReport(data, dir)
 */

import * as fs from "fs";
import * as path from "path";

export interface RunEvent {
  type: string;
  [key: string]: unknown;
}

export interface StageResult {
  stage: number;
  name: string;
  success: boolean;
  duration: number;
  details: Record<string, unknown>;
  errors: string[];
}

export interface SyntaxResult {
  provider: string;
  method: string;
  passed: boolean;
  error?: string;
}

export interface RunData {
  startTime: Date;
  logs: Array<{ level: string; message: string }>;
  stageResults: StageResult[];
  syntaxResults: SyntaxResult[];
  complete: {
    passed: number;
    failed: number;
    totalDuration: number;
  } | null;
  errors: Array<{ context: string; message: string }>;
}

export function createRunData(): RunData {
  return {
    startTime: new Date(),
    logs: [],
    stageResults: [],
    syntaxResults: [],
    complete: null,
    errors: [],
  };
}

export function feedEvent(data: RunData, event: RunEvent): void {
  if (event.type === "log") {
    data.logs.push({
      level: event.level as string,
      message: event.message as string,
    });
    if (event.level === "error") {
      data.errors.push({ context: "run", message: event.message as string });
    }
  } else if (event.type === "stage-end") {
    data.stageResults.push({
      stage: event.stage as number,
      name: event.name as string,
      success: event.success as boolean,
      duration: event.duration as number,
      details: (event.details as Record<string, unknown>) || {},
      errors: (event.errors as string[]) || [],
    });
  } else if (event.type === "syntax-result") {
    data.syntaxResults.push({
      provider: event.provider as string,
      method: event.method as string,
      passed: event.passed as boolean,
      error: event.error as string | undefined,
    });
  } else if (event.type === "complete") {
    data.complete = {
      passed: event.passed as number,
      failed: event.failed as number,
      totalDuration: event.totalDuration as number,
    };
  }
}

export function saveReport(data: RunData, dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const timestamp = data.startTime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `test-run-${timestamp}.md`;
  const filePath = path.join(dir, filename);

  const md = generateMarkdown(data);
  fs.writeFileSync(filePath, md, "utf-8");
  return filePath;
}

function generateMarkdown(data: RunData): string {
  const ts = data.startTime.toISOString();
  const total = data.complete;
  const hasSyntax = data.syntaxResults.length > 0;
  const hasStages = data.stageResults.length > 0;

  let md = `# Penny Pincher API Test Report\n\n`;
  md += `**Run started:** ${ts}  \n`;
  if (total) {
    md += `**Duration:** ${(total.totalDuration / 1000).toFixed(2)}s  \n`;
    md += `**Result:** ${total.passed} passed, ${total.failed} failed\n\n`;
  }
  md += `---\n\n`;

  // Stage results
  if (hasStages) {
    md += `## Stage Results\n\n`;
    md += `| Stage | Name | Result | Duration | Errors |\n`;
    md += `|-------|------|--------|----------|--------|\n`;
    for (const s of data.stageResults) {
      const icon = s.success ? "✓ PASS" : "✗ FAIL";
      const dur = `${(s.duration / 1000).toFixed(2)}s`;
      const errs = s.errors.length ? s.errors.join("; ") : "—";
      md += `| ${s.stage} | ${s.name} | ${icon} | ${dur} | ${errs} |\n`;
    }
    md += `\n`;

    for (const s of data.stageResults) {
      md += `### Stage ${s.stage}: ${s.name}\n\n`;
      md += `**Result:** ${s.success ? "PASSED" : "FAILED"}  \n`;
      md += `**Duration:** ${(s.duration / 1000).toFixed(2)}s\n\n`;
      if (Object.keys(s.details).length > 0) {
        md += `**Details:**\n\`\`\`json\n${JSON.stringify(s.details, null, 2)}\n\`\`\`\n\n`;
      }
      if (s.errors.length > 0) {
        md += `**Errors:**\n`;
        for (const e of s.errors) {
          md += `- ${e}\n`;
        }
        md += `\n`;
      }
    }
  }

  // Syntax results
  if (hasSyntax) {
    md += `## Syntax Test Results\n\n`;
    const syntaxByProvider: Record<string, SyntaxResult[]> = {};
    for (const r of data.syntaxResults) {
      if (!syntaxByProvider[r.provider]) syntaxByProvider[r.provider] = [];
      syntaxByProvider[r.provider].push(r);
    }

    for (const [provider, tests] of Object.entries(syntaxByProvider)) {
      const passed = tests.filter((t) => t.passed).length;
      md += `### ${provider} (${passed}/${tests.length} passed)\n\n`;
      md += `| Test | Result | Error |\n`;
      md += `|------|--------|-------|\n`;
      for (const t of tests) {
        const icon = t.passed ? "✓" : "✗";
        md += `| ${t.method} | ${icon} ${t.passed ? "PASS" : "FAIL"} | ${t.error ?? "—"} |\n`;
      }
      md += `\n`;
    }
  }

  // Rate limits section
  md += `## API Rate Limits\n\n`;
  md += `| Provider | Limit | Notes |\n`;
  md += `|----------|-------|-------|\n`;
  md += `| PumpPortal WebSocket | 200 msg/sec | No auth required |\n`;
  md += `| DexPaprika SSE | 200 req/min | No auth required |\n`;
  md += `| DexScreener | 300 req/min | No auth required |\n`;
  md += `| Chainstack RPC | ~2,500 calls/day | Requires CHAINSTACK_API_KEY |\n`;
  md += `| Shyft HTTP | Unlimited | Requires SHYFT_API_KEY |\n`;
  md += `\n`;

  // Error log section
  const uniqueErrors = deduplicateErrors(data.errors);
  md += `## Error Log\n\n`;
  if (uniqueErrors.length === 0) {
    md += `No errors recorded during this run.\n\n`;
  } else {
    for (const e of uniqueErrors) {
      md += `- **${e.context}**: ${e.message}\n`;
    }
    md += `\n`;
  }

  md += `---\n*Generated by Penny Pincher API Test Suite*\n`;
  return md;
}

function deduplicateErrors(
  errors: Array<{ context: string; message: string }>
): Array<{ context: string; message: string }> {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.context}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
