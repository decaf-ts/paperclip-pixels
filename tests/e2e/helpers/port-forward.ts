/**
 * Port-forward orchestration for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231; QA-verified recipe 2026-08-23).
 *
 * The deployed stack is minikube (ns `paperclip-pixels`) with pods
 * `paperclip`, `pixel-agents`, `postgres`. From an agent sandbox the cluster
 * admin.conf lives inside the minikube VM's writable layer.
 *
 * Resolution order:
 *  1. Fast path — local ports already reachable (a runner with port-forwards
 *     already up, or env-overridden endpoints). Reuse them.
 *  2. kubectl path — a kubeconfig is resolvable (KUBECONFIG /
 *     PAPERCLIP_PIXEL_KUBECONFIG / ~/.kube/config); start port-forwards.
 *  3. Extraction path — extract admin.conf from the minikube VM writable layer
 *     (the QA recipe), rewrite the server, then start port-forwards.
 *
 * All forked port-forward processes are tracked and torn down on
 * `teardownPortForwards()`.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_PORT,
  DB_USER,
  HOST_BASE_URL,
  PIXEL_AGENTS_BASE_URL,
} from "./env";

const NAMESPACE = "paperclip-pixels";

interface ForwardSpec {
  name: string;
  svc: string;
  localPort: number;
  targetPort: number;
  healthUrl?: string;
}

const FORWARDS: ForwardSpec[] = [
  { name: "paperclip", svc: "paperclip", localPort: 13100, targetPort: 3100, healthUrl: undefined },
  { name: "pixel-agents", svc: "pixel-agents", localPort: 18080, targetPort: 8080, healthUrl: undefined },
  { name: "postgres", svc: "postgres", localPort: 15432, targetPort: 5432 },
];

const started: ChildProcess[] = [];
const scratchFiles: string[] = [];

function log(msg: string): void {
  console.log(`[e2e:port-forward] ${msg}`);
}

function localPortOf(url: string): number | null {
  try {
    return new URL(url).port ? Number.parseInt(new URL(url).port, 10) : null;
  } catch {
    return null;
  }
}

async function fetchTimeout(url: string, ms: number): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe an HTTP endpoint tolerating the shared-daemon host's transient
 * connection resets (observed: paperclip svc intermittently ECONNRESETs /
 * stalls a request for a couple of seconds before recovering, while the pod is
 * healthy with 0 restarts). Returns the first positive status or 0.
 */
async function fetchReachable(url: string, timeoutMs: number, attempts = 4): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const status = await fetchTimeout(url, timeoutMs);
    if (status > 0) return status;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return 0;
}

async function isHostReachable(): Promise<boolean> {
  // /api/health is 403 for non-loopback in authenticated/private mode, but a
  // TCP connection still returns a response; treat any HTTP response (incl 403)
  // as "reachable". A connection refusal throws → 0. Retried because the shared
  // daemon forward intermittently resets a single request.
  const status = await fetchReachable(`${HOST_BASE_URL}/api/health`, 8_000);
  return status > 0;
}

async function isDbReachable(): Promise<boolean> {
  // Lightweight TCP probe via a raw socket.
  return new Promise((resolve) => {
    const sock = createConnection({ host: DB_HOST, port: DB_PORT }, () => {
      sock.end();
      resolve(true);
    });
    sock.setTimeout(2_000);
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** Ensure kubectl is on PATH; download v1.31.0 if missing (internet works in sandbox). */
function ensureKubectl(): string {
  const dir = path.join(os.tmpdir(), "pixel-e2e-kubectl");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "kubectl");
  if (fs.existsSync(bin)) return bin;
  const url = "https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl";
  log(`downloading kubectl from ${url}`);
  const res = spawnSync("curl", ["-fsSL", "-o", bin, url]);
  if (res.status !== 0) throw new Error(`kubectl download failed: ${res.stderr?.toString()}`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function resolveKubeconfig(): string | null {
  const env = process.env.PAPERCLIP_PIXEL_KUBECONFIG ?? process.env.KUBECONFIG;
  if (env && fs.existsSync(env)) return env;
  const home = path.join(os.homedir(), ".kube", "config");
  if (fs.existsSync(home)) return home;
  return null;
}

/**
 * Extract the cluster admin.conf from the minikube VM's writable layer (QA
 * recipe). Returns a rewritten kubeconfig path whose server points at the
 * docker-daemon-host API with insecure TLS. Returns null if the VM layer
 * cannot be located (e.g. not running on the shared daemon host).
 */
function extractMinikubeKubeconfig(): string | null {
  try {
    // Scan host /proc for the minikube init process (root mount is an overlay,
    // cmdline is /sbin/init) by bind-mounting host /proc read-only in a container.
    const findInit = spawnSync("docker", [
      "run",
      "--rm",
      "-v",
      "/proc:/hostproc:ro",
      "alpine",
      "sh",
      "-c",
      `for pid in /hostproc/[0-9]*; do
         cmd=$(tr '\\0' ' ' < $pid/cmdline 2>/dev/null)
         case "$cmd" in *"/sbin init"*) ;; *) continue;; esac
         root=$(awk '$5=="/"{print $9; exit}' $pid/mountinfo 2>/dev/null)
         case "$root" in *overlay*) echo "$pid $root"; exit 0;; esac
       done
       exit 1`,
    ]);
    if (findInit.status !== 0) return null;
    const out = findInit.stdout.toString().trim();
    const match = out.match(/upperdir=([^\s,]+)/);
    if (!match) return null;
    const upperdir = match[1];

    const conf = spawnSync("docker", [
      "run",
      "--rm",
      "-v",
      `${upperdir}:/vm:ro`,
      "alpine",
      "base64",
      "/vm/etc/kubernetes/admin.conf",
    ]);
    if (conf.status !== 0) return null;
    const adminConf = Buffer.from(conf.stdout.toString().trim(), "base64").toString("utf8");
    const rewritten = adminConf.replace(
      /server:\s*https:\/\/[^\n]+/,
      "server: https://172.24.0.1:32801",
    );
    const kubeconfig = path.join(os.tmpdir(), `pixel-e2e-kubeconfig-${process.pid}.yaml`);
    fs.writeFileSync(kubeconfig, rewritten, { mode: 0o600 });
    scratchFiles.push(kubeconfig);
    log(`extracted minikube kubeconfig -> ${kubeconfig}`);
    return kubeconfig;
  } catch (err) {
    log(`minikube kubeconfig extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function startForward(kubeconfig: string, spec: ForwardSpec): ChildProcess {
  const kubectl = ensureKubectl();
  log(`port-forward ${spec.name} -> localhost:${spec.localPort} (svc/${spec.svc}:${spec.targetPort})`);
  const child = spawn(
    kubectl,
    [
      "--insecure-skip-tls-verify",
      "--kubeconfig",
      kubeconfig,
      "-n",
      NAMESPACE,
      "port-forward",
      `svc/${spec.svc}`,
      `${spec.localPort}:${spec.targetPort}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (d) => process.stderr.write(`[pf:${spec.name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[pf:${spec.name}] ${d}`));
  started.push(child);
  return child;
}

async function waitForForward(spec: ForwardSpec, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (spec.name === "postgres") {
      if (await isDbReachable()) return true;
    } else {
      const url = spec.name === "paperclip" ? HOST_BASE_URL : PIXEL_AGENTS_BASE_URL;
      const status = await fetchTimeout(`${url}/api/health`, 2_000);
      // 403 is fine in authenticated/private mode (non-loopback probe); any
      // HTTP response means the forward is up.
      if (status > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Ensure all required endpoints are reachable. Reuses already-forwarded ports
 * (fast path); otherwise starts port-forwards via kubectl.
 *
 * @returns a handle whose `teardown()` kills any forwards this call started.
 */
export async function ensureReachable(): Promise<{ teardown: () => void; reused: boolean }> {
  const hostUp = await isHostReachable();
  const dbUp = await isDbReachable();
  if (hostUp && dbUp) {
    log("endpoints already reachable (reusing existing port-forwards)");
    return { teardown: () => undefined, reused: true };
  }

  let kubeconfig = resolveKubeconfig();
  if (!kubeconfig) kubeconfig = extractMinikubeKubeconfig();
  if (!kubeconfig) {
    throw new Error(
      "No reachable endpoints and no kubeconfig. Either pre-forward the ports " +
        "(see deploy/README.md) or run on the shared daemon host so the minikube " +
        "kubeconfig can be extracted.",
    );
  }

  for (const spec of FORWARDS) {
    startForward(kubeconfig, spec);
  }
  for (const spec of FORWARDS) {
    const ok = await waitForForward(spec, 60_000);
    if (!ok) {
      log(`WARNING: ${spec.name} port-forward did not become reachable within 60s`);
    }
  }
  return { teardown: teardownPortForwards, reused: false };
}

export function teardownPortForwards(): void {
  for (const child of started) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  started.length = 0;
  for (const file of scratchFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
  scratchFiles.length = 0;
}

/** Quick readiness summary used by global-setup logging. */
export async function readinessReport(): Promise<Record<string, boolean | number>> {
  return {
    host: await isHostReachable(),
    db: await isDbReachable(),
    hostPort: localPortOf(HOST_BASE_URL) ?? -1,
    dbPort: DB_PORT,
  };
}

/** DB connection params (used by the db helper). */
export const DB_CONFIG = { host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME };
