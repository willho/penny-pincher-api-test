/**
 * Test logger with consistent formatting and timestamps
 */

export class TestLogger {
  private verbose: boolean;

  constructor(verbose = true) {
    this.verbose = verbose;
  }

  private timestamp(): string {
    return new Date().toISOString().split("T")[1].split(".")[0];
  }

  header(text: string): void {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`  ${text}`);
    console.log(`${"=".repeat(70)}\n`);
  }

  section(text: string): void {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`  ${text}`);
    console.log(`${"─".repeat(70)}\n`);
  }

  info(text: string): void {
    console.log(`[${this.timestamp()}] ℹ️  ${text}`);
  }

  success(text: string): void {
    console.log(`[${this.timestamp()}] ✓ ${text}`);
  }

  warn(text: string): void {
    console.log(`[${this.timestamp()}] ⚠️  ${text}`);
  }

  error(text: string): void {
    console.log(`[${this.timestamp()}] ✗ ${text}`);
  }

  debug(text: string): void {
    if (this.verbose) {
      console.log(`[${this.timestamp()}] 🔍 ${text}`);
    }
  }

  table(data: Record<string, unknown>[]): void {
    console.table(data);
  }

  json(obj: unknown): void {
    if (this.verbose) {
      console.log(JSON.stringify(obj, null, 2));
    }
  }

  divider(): void {
    console.log(`\n${"─".repeat(70)}\n`);
  }
}

export const logger = new TestLogger(process.env.VERBOSE_LOGGING === "true");
