import { ChildProcess, spawn } from 'child_process';
import { readdirSync, readFileSync } from 'fs';

/**
 * Resource sampling for the PDF load test: peak resident memory and CPU time of THIS process plus every descendant
 * (Chromium's browser, GPU, network-service and renderer processes; a native renderer's worker threads live inside this
 * process). Test-only.
 *
 *   linux  /proc every 100 ms. Peak RSS = max over samples of Σ VmRSS of the tree. CPU = exact: this process's
 *          utime+stime+cutime+cstime delta (every Chromium process is a reaped descendant, so its CPU lands in cutime /
 *          cstime when it exits) — the Worker image case.
 *   win32  one long-lived PowerShell loop over Win32_Process (~3–4 samples / s). Peak "RSS" = max Σ WorkingSetSize of
 *          the tree (shared pages counted once per process: an OVER-estimate for Chromium's multi-process tree). Child
 *          CPU = Σ over every descendant pid ever seen of its last sampled Kernel+User time: a LOWER bound (CPU a
 *          short-lived process spends after its last sample is missed). Node's own CPU is exact (process.cpuUsage).
 */
export interface ResourceSummary {
  platform: NodeJS.Platform;
  samples: number;
  peakTreeRssMb: number;
  peakNodeRssMb: number;
  peakProcesses: number;
  nodeCpuSeconds: number;
  childCpuSeconds: number;
  childCpuIsLowerBound: boolean;
}

const MB = 1024 * 1024;

export class ResourceSampler {
  private ps: ChildProcess | null = null;
  private samples = 0;
  private peakTree = 0;
  private peakNode = 0;
  private peakProcs = 0;
  private readonly childCpu = new Map<number, number>();
  private cpuStart = process.cpuUsage();
  private linuxStart = 0;
  private buffer = '';

  start(): void {
    this.cpuStart = process.cpuUsage();
    const nodeTick = setInterval(() => {
      this.peakNode = Math.max(this.peakNode, process.memoryUsage().rss);
    }, 50);
    if (process.platform === 'linux') {
      this.linuxStart = linuxSelfCpuTicks();
      const tick = setInterval(() => this.sampleLinux(), 100);
      this.stopNode = () => {
        clearInterval(tick);
        clearInterval(nodeTick);
      };
    } else if (process.platform === 'win32') {
      const script =
        `$root=${process.pid}; while($true){ $all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime; ` +
        `$kids=@{}; foreach($p in $all){ $k=[int]$p.ParentProcessId; if(-not $kids.ContainsKey($k)){ $kids[$k]=New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }; ` +
        `$byId=@{}; foreach($p in $all){ $byId[[int]$p.ProcessId]=$p }; $q=New-Object System.Collections.Queue; $q.Enqueue($root); $rss=0; $n=0; $cpu=@(); ` +
        `while($q.Count -gt 0){ $id=$q.Dequeue(); $p=$byId[$id]; if($p){ $rss+=[int64]$p.WorkingSetSize; $n++; if($id -ne $root){ $cpu+=("{0}:{1}" -f $id,([int64]$p.KernelModeTime+[int64]$p.UserModeTime)) } }; ` +
        `if($kids.ContainsKey($id)){ foreach($c in $kids[$id]){ $q.Enqueue([int]$c.ProcessId) } } }; ` +
        `[Console]::Out.WriteLine(("S {0} {1} {2}" -f $rss,$n,($cpu -join ','))); [Console]::Out.Flush(); Start-Sleep -Milliseconds 150 }`;
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      this.ps.stdout!.setEncoding('utf8');
      this.ps.stdout!.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          const m = /^S (\d+) (\d+) ?(.*)$/.exec(line);
          if (!m) continue;
          this.samples++;
          this.peakTree = Math.max(this.peakTree, Number(m[1]));
          this.peakProcs = Math.max(this.peakProcs, Number(m[2]));
          for (const pair of (m[3] ?? '').split(',').filter(Boolean)) {
            const [pid, t] = pair.split(':');
            this.childCpu.set(Number(pid), Math.max(this.childCpu.get(Number(pid)) ?? 0, Number(t) / 1e7));
          }
        }
      });
      this.stopNode = () => clearInterval(nodeTick);
    } else {
      this.stopNode = () => clearInterval(nodeTick);
    }
  }

  private stopNode: () => void = () => undefined;

  private sampleLinux(): void {
    const tree = linuxTree(process.pid);
    let rss = 0;
    for (const pid of tree) rss += linuxRssBytes(pid);
    this.samples++;
    this.peakTree = Math.max(this.peakTree, rss);
    this.peakProcs = Math.max(this.peakProcs, tree.length);
  }

  async stop(): Promise<ResourceSummary> {
    this.stopNode();
    const cpu = process.cpuUsage(this.cpuStart);
    const nodeCpu = (cpu.user + cpu.system) / 1e6;
    let childCpu: number;
    let lowerBound = false;
    if (process.platform === 'linux') {
      const ticks = linuxSelfCpuTicks() - this.linuxStart; // utime+stime+cutime+cstime
      childCpu = Math.max(0, ticks / 100 - nodeCpu); // USER_HZ = 100
    } else {
      childCpu = [...this.childCpu.values()].reduce((a, b) => a + b, 0);
      lowerBound = true;
      this.ps?.kill();
    }
    return {
      platform: process.platform,
      samples: this.samples,
      peakTreeRssMb: Math.round(Math.max(this.peakTree, this.peakNode) / MB),
      peakNodeRssMb: Math.round(this.peakNode / MB),
      peakProcesses: this.peakProcs,
      nodeCpuSeconds: Math.round(nodeCpu * 100) / 100,
      childCpuSeconds: Math.round(childCpu * 100) / 100,
      childCpuIsLowerBound: lowerBound,
    };
  }
}

function linuxStat(pid: number): string[] | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ');
  } catch {
    return null;
  }
}
function linuxSelfCpuTicks(): number {
  const f = linuxStat(process.pid);
  return f ? Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]) : 0;
}
function linuxRssBytes(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}
function linuxTree(root: number): number[] {
  const parent = new Map<number, number[]>();
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const f = linuxStat(Number(e));
    if (!f) continue;
    const ppid = Number(f[1]);
    if (!parent.has(ppid)) parent.set(ppid, []);
    parent.get(ppid)!.push(Number(e));
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    out.push(p);
    queue.push(...(parent.get(p) ?? []));
  }
  return out;
}

export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return NaN;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))]!;
}
