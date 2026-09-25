import { join } from "node:path";

const root = join(import.meta.dir, "..");

const processes = [
  {
    name: "web",
    cmd: ["bun", "run", "--filter", "web", "dev"],
    color: "\x1b[36m",
  },
  {
    name: "api",
    cmd: ["bun", "run", "--filter", "api", "start:dev"],
    color: "\x1b[33m",
  },
  {
    name: "test",
    cmd: ["bun", "test", "--watch", "--timeout", "15000", "--max-concurrency", "8"],
    color: "\x1b[32m",
  },
] as const;

const reset = "\x1b[0m";
const children: ReturnType<typeof Bun.spawn>[] = [];
let shuttingDown = false;

function prefixLine(name: string, color: string, line: string) {
  return `${color}[${name}]${reset} ${line}`;
}

function pipeOutput(
  name: string,
  color: string,
  stream: ReadableStream<Uint8Array> | null,
  writer: typeof Bun.stdout | typeof Bun.stderr,
) {
  if (!stream) return;

  const decoder = new TextDecoder();
  let leftover = "";

  void (async () => {
    for await (const chunk of stream) {
      leftover += decoder.decode(chunk, { stream: true });
      const lines = leftover.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        writer.write(prefixLine(name, color, `${line}\n`));
      }
    }
    if (leftover.length > 0) {
      writer.write(prefixLine(name, color, `${leftover}\n`));
    }
  })();
}

function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (const proc of processes) {
  const child = Bun.spawn({
    cmd: proc.cmd,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });

  children.push(child);
  pipeOutput(proc.name, proc.color, child.stdout, Bun.stdout);
  pipeOutput(proc.name, proc.color, child.stderr, Bun.stderr);
}

const exitCodes = await Promise.all(children.map((child) => child.exited));

if (!shuttingDown) {
  const failed = exitCodes.find((code) => code !== 0);
  process.exit(failed ?? 0);
}
