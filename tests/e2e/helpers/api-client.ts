/**
 * Paperclip REST API client for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * Authenticated with the board user's Better Auth session cookie, captured
 * from the Playwright browser context after a real UI login (so the browser
 * session path is exercised, not just API cookies). Uses Node's built-in
 * fetch — no extra HTTP dependency.
 */

import { HOST_BASE_URL, SESSION_COOKIE } from "./env";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(`[${status}] ${message}`);
    this.name = "ApiError";
  }
}

export interface Company {
  id: string;
  name: string;
  status?: string;
}
export interface Agent {
  id: string;
  name?: string;
  role?: string;
  status?: string;
  adapterType?: string;
}
export interface Issue {
  id: string;
  identifier?: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
}
export interface UiContributionSlot {
  id: string;
  placementZone?: string;
  exportName?: string;
  [k: string]: unknown;
}
export interface UiContribution {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  uiEntryFile?: string;
  slots: UiContributionSlot[];
  launchers: unknown[];
}

export class PaperclipApi {
  private cookie: string;

  constructor(sessionCookieValue: string) {
    this.cookie = `${SESSION_COOKIE}=${sessionCookieValue}`;
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookie);
    // Mutating board routes demand a trusted browser origin (board mutation
    // CSRF gate). Node fetch sends no Origin by default, so all POSTs would
    // 403; derive it from the forwarded host base URL like a real browser page.
    headers.set("origin", HOST_BASE_URL);
    headers.set("referer", `${HOST_BASE_URL}/`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(`${HOST_BASE_URL}${path}`, { ...init, headers, redirect: "manual" });
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.req(path, init);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new ApiError(res.status, `GET/POST ${path}`, body);
    }
    return body as T;
  }

  async getSession(): Promise<{ user?: { id?: string; email?: string } }> {
    return this.json("/api/auth/get-session");
  }

  async listCompanies(): Promise<Company[]> {
    return this.json("/api/companies");
  }

  async createCompany(name: string): Promise<Company> {
    return this.json("/api/companies", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async findOrCreateCompany(name: string): Promise<Company> {
    const existing = (await this.listCompanies()).find((c) => c.name === name);
    if (existing) return existing;
    return this.createCompany(name);
  }

  async listAgents(companyId: string): Promise<Agent[]> {
    return this.json(`/api/companies/${companyId}/agents`);
  }

  async createAgent(
    companyId: string,
    input: { name: string; adapterType: string; role?: string; adapterConfig?: Record<string, unknown> },
  ): Promise<Agent> {
    return this.json(`/api/companies/${companyId}/agents`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** PATCH an agent (used to force a deterministic long-lived adapter config). */
  async updateAgent(agentId: string, patch: { adapterConfig?: Record<string, unknown> }): Promise<Agent> {
    return this.json(`/api/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** DELETE an agent (used only to recreate a stale deterministic helper agent). */
  async deleteAgent(agentId: string): Promise<unknown> {
    return this.json(`/api/agents/${agentId}`, { method: "DELETE" });
  }

  async findOrCreateAgent(companyId: string, name: string, adapterType: string): Promise<Agent> {
    const existing = (await this.listAgents(companyId)).find((a) => (a.name ?? "") === name);
    if (existing) return existing;
    return this.createAgent(companyId, { name, adapterType });
  }

  async listIssues(companyId: string): Promise<Issue[]> {
    return this.json(`/api/companies/${companyId}/issues?limit=1000`);
  }

  async issueCount(companyId: string): Promise<number> {
    const data = await this.json<{ count?: number }>(`/api/companies/${companyId}/issues/count`);
    return data.count ?? (await this.listIssues(companyId)).length;
  }

  async createIssue(companyId: string, input: { title: string; description?: string; assigneeAgentId?: string; status?: string }): Promise<Issue> {
    return this.json(`/api/companies/${companyId}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getIssue(issueId: string): Promise<Issue & { comments?: unknown[] }> {
    return this.json(`/api/issues/${issueId}`);
  }

  /** PATCH an issue (fires an `issue.updated` event the bridge subscribes to). */
  async updateIssue(issueId: string, patch: { status?: string; title?: string; assigneeAgentId?: string | null }): Promise<Issue> {
    return this.json(`/api/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async listComments(issueId: string): Promise<Array<{ id: string; body?: string }>> {
    return this.json(`/api/issues/${issueId}/comments`);
  }

  async createComment(issueId: string, body: string, companyId: string): Promise<unknown> {
    return this.json(`/api/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, companyId }),
    });
  }

  async uiContributions(): Promise<UiContribution[]> {
    return this.json("/api/plugins/ui-contributions");
  }

  /** Pixel Office UI contribution (slot wired by SAA-230), or null if absent. */
  async pixelOfficeContribution(pluginKeyHint = "paperclip-pixel"): Promise<UiContribution | null> {
    const all = await this.uiContributions();
    return all.find((c) => c.pluginKey.includes(pluginKeyHint) || c.displayName.toLowerCase().includes("pixel")) ?? null;
  }

  async listPlugins(): Promise<Array<{ id: string; pluginKey: string; status: string; manifestJson?: { ui?: unknown } }>> {
    return this.json("/api/plugins");
  }

  /** The registered Pixel bridge plugin record, or null when absent. */
  async pixelPluginRecord(): Promise<{ id: string; pluginKey: string } | null> {
    const plugins = await this.listPlugins();
    return plugins.find((p) => p.pluginKey.includes("paperclip-pixel")) ?? null;
  }

  /**
   * Read the bridge company snapshot exactly as the Pixel Office UI consumes it
   * (POST /api/plugins/:id/data/bridge-snapshot, SAA-306 BridgeCompanySnapshot).
   * This is the UI's own vantage — counts rendered by `company-overview` come
   * straight from `data.summary`, so read-backs against it match the UI.
   */
  async bridgeSnapshot(companyId: string): Promise<{ summary?: Record<string, number | string | undefined>; agents?: unknown[]; feedback?: unknown[]; [k: string]: unknown }> {
    const plugin = await this.pixelPluginRecord();
    if (!plugin) throw new ApiError(404, "pixel plugin not registered");
    const res = await this.req(`/api/plugins/${plugin.id}/data/bridge-snapshot`, {
      method: "POST",
      body: JSON.stringify({ companyId }),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new ApiError(res.status, "GET/POST bridge-snapshot", body);
    }
    const data = (body as { data?: unknown })?.data ?? body;
    return data as ReturnType<PaperclipApi["bridgeSnapshot"]>;
  }

  async disablePlugin(pluginId: string): Promise<unknown> {
    return this.json(`/api/plugins/${pluginId}/disable`, { method: "POST" });
  }

  async enablePlugin(pluginId: string): Promise<unknown> {
    return this.json(`/api/plugins/${pluginId}/enable`, { method: "POST" });
  }

  /** Trigger a real state change: assign + (best-effort) wake the agent on the issue. */
  async wakeupAgent(agentId: string, body: { issueId?: string; reason?: string }): Promise<unknown> {
    return this.json(`/api/agents/${agentId}/wakeup`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Live (queued/running) heartbeat runs for a company, optionally filtered by
   * agent. Only genuinely live runs are returned — a wakeup that is accepted
   * but whose run immediately fails never appears here (deployed stack runs
   * fail with "Authentication required" in ~1s).
   */
  async liveRuns(companyId: string, agentId?: string): Promise<Array<{ id: string; status: string; agentId?: string; error?: string }>> {
    const path = `/api/companies/${companyId}/live-runs${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`;
    const res = await this.req(path);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) throw new ApiError(res.status, `GET ${path}`, body);
    const arr = body as Array<{ id: string; status: string; agentId?: string; error?: string }>;
    return (arr ?? []).filter((r) => r.status === "queued" || r.status === "running");
  }

  /** Recent heartbeat runs for a company (includes terminal statuses + last error). */
  async listHeartbeatRuns(companyId: string, agentId?: string, limit = 5): Promise<Array<{ id: string; status: string; error?: string; agentId?: string }>> {
    const path = `/api/companies/${companyId}/heartbeat-runs${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}&limit=${limit}`;
    return this.json(path);
  }

  /**
   * Invoke a plugin worker action exactly as the plugin UI does (the same
   * `POST /api/plugins/:pluginId/bridge/action` proxy the `usePluginAction`
   * bridge hook uses). Raw response surface is returned so specs can
   * distinguish a genuinely accepted action from a worker-level rejection.
   */
  async pluginAction(
    pluginId: string,
    key: string,
    params: Record<string, unknown>,
    companyId?: string,
  ): Promise<{ status: number; ok: boolean; data?: unknown; error?: unknown }> {
    const res = await this.req(`/api/plugins/${pluginId}/bridge/action`, {
      method: "POST",
      body: JSON.stringify({ key, companyId, params }),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const wrapped = body as { data?: unknown } | undefined;
    const data = wrapped?.data;
    const bridge = body as { code?: unknown; message?: unknown; error?: unknown };
    const workerError = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
    return {
      status: res.status,
      ok: res.ok && !!data && typeof data === "object" && (data as { ok?: boolean }).ok !== false,
      data,
      error: bridge.code ?? workerError ?? bridge.error,
    };
  }
}
