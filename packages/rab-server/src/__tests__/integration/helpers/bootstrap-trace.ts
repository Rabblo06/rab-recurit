/**
 * TEST-ONLY timing of a suite's Nest bootstrap (HWS final stability pass). Measures wall-clock time between named marks and prints one
 * BOOTSTRAP-TRACE line. Never touches application runtime behaviour, pool size, or any timeout — this only reads Date.now().
 */
export class BootstrapTimer {
  private readonly marks: Array<{ name: string; at: number }> = [];

  constructor(private readonly label: string) {
    this.marks.push({ name: 'start', at: Date.now() });
  }

  mark(name: string): void {
    this.marks.push({ name, at: Date.now() });
  }

  log(): void {
    const segments = this.marks.slice(1).map((m, i) => `${m.name}=${m.at - this.marks[i]!.at}ms`);
    const total = this.marks.at(-1)!.at - this.marks[0]!.at;
    // eslint-disable-next-line no-console
    console.log(`BOOTSTRAP-TRACE ${this.label}: ${segments.join(' ')} total=${total}ms`);
  }
}
