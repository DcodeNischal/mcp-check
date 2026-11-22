// cli/src/action.ts
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// src/mcp/sse.ts
var SizeLimitError = class extends Error {
  constructor(limit) {
    super(`Response exceeded ${Math.round(limit / 1024)} KB`);
  }
};
async function* readSse(body, maxBytes, signal) {
  const reader = body.getReader();
  signal?.addEventListener("abort", () => reader.cancel().catch(() => {
  }), { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let event = "message";
  let data = [];
  let id;
  const flush = () => {
    if (!data.length) {
      event = "message";
      return null;
    }
    const out = { event, data: data.join("\n"), ...id !== void 0 ? { id } : {} };
    event = "message";
    data = [];
    return out;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new SizeLimitError(maxBytes);
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
        if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
        const line = buffer.slice(0, newline);
        const sepLength = buffer.startsWith("\r\n", newline) ? 2 : 1;
        buffer = buffer.slice(newline + sepLength);
        if (line === "") {
          const out = flush();
          if (out) yield out;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value2 = colon < 0 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") event = value2;
        else if (field === "data") data.push(value2);
        else if (field === "id") id = value2;
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => {
    });
  }
}

// src/mcp/types.ts
var MODERN_VERSION = "2026-07-28";
var LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
var SSE_VERSION = "2024-11-05";
var ALL_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS, SSE_VERSION];
var META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  serverInfo: "io.modelcontextprotocol/serverInfo"
};
var ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  missingCapability: -32021,
  unsupportedVersion: -32022
};

// src/mcp/wire.ts
var USER_AGENT = "MCP-Check/0.1 (+https://mcp.nischaldhakal.com.np)";
var DEFAULT_TIMEOUT = 15e3;
var DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
var RAW_TEXT_LIMIT = 4e3;
var now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
var Wire = class {
  log = [];
  fetchImpl;
  timeoutMs;
  maxBytes;
  baseHeaders;
  constructor(opts = {}) {
    this.fetchImpl = opts.fetch ?? ((input2, init) => fetch(input2, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.baseHeaders = { "User-Agent": USER_AGENT, ...opts.headers ?? {} };
  }
  /** POST one JSON-RPC message. For requests, reads until the response with the same id arrives. */
  async post(url, body, headers = {}) {
    const id = body.id;
    const exchange = this.start("POST", url, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = now();
    try {
      const res = await untilAborted(
        this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...this.baseHeaders,
            ...headers
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "manual"
        }),
        controller.signal
      );
      this.record(exchange, res);
      const response = await untilAborted(this.readMessages(exchange, res, id), controller.signal);
      return { exchange, ...response ? { response } : {} };
    } catch (err) {
      exchange.error = describe(err, controller.signal.aborted, this.timeoutMs);
      return { exchange };
    } finally {
      clearTimeout(timer);
      exchange.ms = Math.round(now() - t0);
    }
  }
  /** A plain request (GET/DELETE) whose body we only peek at. */
  async request(method, url, headers = {}) {
    const exchange = this.start(method, url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = now();
    try {
      const res = await untilAborted(
        this.fetchImpl(url, {
          method,
          headers: { ...this.baseHeaders, ...headers },
          signal: controller.signal,
          redirect: "manual"
        }),
        controller.signal
      );
      this.record(exchange, res);
      return { exchange, res };
    } catch (err) {
      exchange.error = describe(err, controller.signal.aborted, this.timeoutMs);
      return { exchange };
    } finally {
      clearTimeout(timer);
      exchange.ms = Math.round(now() - t0);
    }
  }
  /** Fetch a JSON document (OAuth metadata). Not part of the MCP log. */
  async getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await untilAborted(this.fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: controller.signal, redirect: "manual" }), controller.signal);
      const text = await untilAborted(readText(res, 256 * 1024), controller.signal);
      try {
        const json = JSON.parse(text);
        return { status: res.status, ...json && typeof json === "object" && !Array.isArray(json) ? { json } : {} };
      } catch {
        return { status: res.status };
      }
    } catch (err) {
      return { error: describe(err, controller.signal.aborted, this.timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }
  start(method, url, body) {
    const exchange = {
      at: Date.now(),
      method,
      url,
      responseHeaders: {},
      messages: [],
      ms: 0,
      ...body ? { requestBody: body, rpcMethod: typeof body.method === "string" ? body.method : void 0 } : {}
    };
    this.log.push(exchange);
    return exchange;
  }
  record(exchange, res) {
    exchange.status = res.status;
    exchange.contentType = res.headers.get("content-type") ?? void 0;
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") exchange.responseHeaders[key.toLowerCase()] = value;
    });
  }
  async readMessages(exchange, res, id) {
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.body || res.status === 202 || res.status === 204) return void 0;
    if (type.includes("text/event-stream")) {
      for await (const event of readSse(res.body, this.maxBytes)) {
        const message2 = parseJson(event.data);
        if (message2 === void 0) continue;
        exchange.messages.push(message2);
        if (isResponseTo(message2, id)) return message2;
      }
      return void 0;
    }
    const text = await readText(res, this.maxBytes);
    const message = parseJson(text);
    if (message === void 0) {
      if (text) exchange.rawText = text.slice(0, RAW_TEXT_LIMIT);
      return void 0;
    }
    exchange.messages.push(message);
    return isResponseTo(message, id) ? message : void 0;
  }
};
function isResponseTo(message, id) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message;
  if (!("result" in m) && !("error" in m)) return false;
  return id === void 0 || m.id === id || m.id === null && "error" in m;
}
function parseJson(text) {
  if (!text.trim()) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
async function readText(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new SizeLimitError(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.cancel().catch(() => {
    });
  }
}
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}
function describe(err, aborted, timeoutMs) {
  if (aborted) return `Timed out after ${Math.round(timeoutMs / 1e3)}s`;
  if (err instanceof SizeLimitError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// src/mcp/client.ts
var CLIENT_INFO = { name: "mcp-check", title: "MCP Check", version: "0.1.0", websiteUrl: "https://mcp.nischaldhakal.com.np" };
var MAX_PAGES = 10;
var MAX_ITEMS = 1e3;
var McpClient = class {
  constructor(url, opts = {}) {
    this.url = url;
    this.wire = new Wire(opts);
  }
  url;
  wire;
  era;
  version;
  sessionId;
  nextId = 1;
  sse;
  get log() {
    return this.wire.log;
  }
  /** Work out which era the server speaks and connect with it. */
  async connect() {
    const steps = [];
    const modern = await this.wire.post(this.url, this.modernBody("server/discover", {}), this.modernHeaders("server/discover"));
    const status = modern.exchange.status;
    if (modern.exchange.error && status === void 0) {
      steps.push({ attempt: "modern", outcome: modern.exchange.error });
      return { ok: false, steps, error: modern.exchange.error };
    }
    if (status === 401 || status === 403) {
      steps.push({ attempt: "modern", status, outcome: "credentials required" });
      return { ok: false, steps, auth: { status, wwwAuthenticate: modern.exchange.responseHeaders["www-authenticate"] } };
    }
    const result = modern.response?.result;
    const error = modern.response?.error;
    let supported;
    if (result && Array.isArray(result.supportedVersions)) {
      supported = result.supportedVersions.filter((v) => typeof v === "string");
      if (supported.includes(MODERN_VERSION)) {
        steps.push({ attempt: "modern", status, outcome: "server/discover answered" });
        this.era = "modern";
        this.version = MODERN_VERSION;
        const meta = result._meta ?? {};
        return {
          ok: true,
          era: "modern",
          version: MODERN_VERSION,
          steps,
          ...isImplementation(meta[META.serverInfo]) ? { serverInfo: meta[META.serverInfo] } : {},
          ...isObject(result.capabilities) ? { capabilities: result.capabilities } : {},
          ...typeof result.instructions === "string" ? { instructions: result.instructions } : {}
        };
      }
      steps.push({ attempt: "modern", status, outcome: `server/discover lists ${supported.join(", ") || "no versions"}` });
    } else if (error?.code === ERROR.unsupportedVersion) {
      const data = error.data ?? {};
      supported = Array.isArray(data.supported) ? data.supported.filter((v) => typeof v === "string") : [];
      steps.push({ attempt: "modern", status, outcome: `unsupported version; server supports ${supported.join(", ") || "none listed"}` });
    } else {
      const why = error ? `JSON-RPC error ${error.code}` : status !== void 0 ? `HTTP ${status}` : "no response";
      steps.push({ attempt: "modern", status, outcome: `not a modern server (${why})` });
    }
    const wanted = supported?.find((v) => LEGACY_VERSIONS.includes(v)) ?? LEGACY_VERSIONS[0];
    const legacy = await this.legacyInitialize(wanted);
    steps.push(legacy.step);
    if (legacy.auth) return { ok: false, steps, auth: legacy.auth };
    if (legacy.ok) return { ...legacy.result, steps };
    const sse = await this.connectSse();
    steps.push(sse.step);
    if (sse.auth) return { ok: false, steps, auth: sse.auth };
    if (sse.ok) return { ...sse.result, steps };
    return { ok: false, steps, error: "The server did not respond like any MCP transport." };
  }
  /** Send a request in the connected era. */
  async request(method, params = {}, name, extraHeaders = {}) {
    let posted;
    if (this.era === "modern") {
      posted = await this.wire.post(this.url, this.modernBody(method, params), { ...this.modernHeaders(method, name), ...extraHeaders });
    } else if (this.era === "legacy-sse" && this.sse) {
      posted = await this.sse.send(this.body(method, params));
    } else {
      posted = await this.wire.post(this.url, this.body(method, params), { ...this.legacyHeaders(), ...extraHeaders });
    }
    const result = posted.response?.result;
    const error = posted.response?.error;
    return { ...posted, ...isObject(result) ? { result } : {}, ...error ? { error } : {} };
  }
  /** Send a raw body as-is (used by checks to probe error handling). */
  async raw(body, headers = {}) {
    const base = this.era === "modern" ? this.modernHeaders(String(body.method ?? "unknown")) : this.legacyHeaders();
    if (this.era === "legacy-sse" && this.sse) return this.sse.send(body);
    return this.wire.post(this.url, body, { ...base, ...headers });
  }
  /** Follow nextCursor until done, with page and item caps. */
  async listAll(method, key) {
    const items = [];
    let cursor;
    let pages = 0;
    while (pages < MAX_PAGES) {
      const res = await this.request(method, cursor ? { cursor } : {});
      pages++;
      if (res.error) return { items, pages, truncated: false, error: `${res.error.code}: ${res.error.message}` };
      if (!res.result) return { items, pages, truncated: false, error: res.exchange.error ?? `HTTP ${res.exchange.status ?? "?"}: no result` };
      const page = res.result[key];
      if (!Array.isArray(page)) return { items, pages, truncated: false, error: `result.${key} is not an array` };
      items.push(...page);
      if (items.length >= MAX_ITEMS) return { items: items.slice(0, MAX_ITEMS), pages, truncated: true };
      cursor = typeof res.result.nextCursor === "string" && res.result.nextCursor ? res.result.nextCursor : void 0;
      if (!cursor) return { items, pages, truncated: false };
    }
    return { items, pages, truncated: true };
  }
  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args }, name);
  }
  /** End the session politely (legacy streamable) or drop the stream (SSE). */
  async close() {
    if (this.era === "legacy-streamable" && this.sessionId) {
      await this.wire.request("DELETE", this.url, this.legacyHeaders());
    }
    this.sse?.close();
  }
  // --- era-specific plumbing ---------------------------------------------------------------
  id() {
    return this.nextId++;
  }
  body(method, params) {
    return { jsonrpc: "2.0", id: this.id(), method, params };
  }
  modernBody(method, params) {
    return this.body(method, {
      ...params,
      _meta: {
        [META.protocolVersion]: MODERN_VERSION,
        [META.clientCapabilities]: {},
        [META.clientInfo]: CLIENT_INFO
      }
    });
  }
  modernHeaders(method, name) {
    return { "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": method, ...name ? { "Mcp-Name": name } : {} };
  }
  legacyHeaders() {
    const headers = {};
    if (this.version && this.version >= "2025-06-18") headers["MCP-Protocol-Version"] = this.version;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }
  initializeParams(version) {
    return { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO };
  }
  async legacyInitialize(version) {
    const res = await this.wire.post(this.url, this.body("initialize", this.initializeParams(version)));
    const status = res.exchange.status;
    if (status === 401 || status === 403) {
      return { ok: false, step: { attempt: "legacy-initialize", status, outcome: "credentials required" }, auth: { status, wwwAuthenticate: res.exchange.responseHeaders["www-authenticate"] } };
    }
    const result = res.response?.result;
    if (!result || typeof result.protocolVersion !== "string") {
      const why = res.response?.error ? `JSON-RPC error ${res.response.error.code}` : res.exchange.error ?? `HTTP ${status ?? "?"}`;
      return { ok: false, step: { attempt: "legacy-initialize", ...status !== void 0 ? { status } : {}, outcome: `no initialize result (${why})` } };
    }
    this.era = "legacy-streamable";
    this.version = result.protocolVersion;
    const sessionId = res.exchange.responseHeaders["mcp-session-id"];
    if (sessionId) this.sessionId = sessionId;
    const initialized = await this.wire.post(this.url, { jsonrpc: "2.0", method: "notifications/initialized" }, this.legacyHeaders());
    return {
      ok: true,
      step: { attempt: "legacy-initialize", ...status !== void 0 ? { status } : {}, outcome: `initialize answered with ${result.protocolVersion}` },
      result: {
        ok: true,
        era: "legacy-streamable",
        version: result.protocolVersion,
        ...isImplementation(result.serverInfo) ? { serverInfo: result.serverInfo } : {},
        ...isObject(result.capabilities) ? { capabilities: result.capabilities } : {},
        ...typeof result.instructions === "string" ? { instructions: result.instructions } : {},
        ...initialized.exchange.status !== void 0 ? { initializedStatus: initialized.exchange.status } : {},
        ...sessionId ? { sessionId } : {}
      }
    };
  }
  async connectSse() {
    const channel = new SseChannel(this.wire, this.url);
    const opened = await channel.open();
    if (opened.auth) return { ok: false, step: { attempt: "sse-get", status: opened.auth.status, outcome: "credentials required" }, auth: opened.auth };
    if (!opened.ok) return { ok: false, step: { attempt: "sse-get", ...opened.status !== void 0 ? { status: opened.status } : {}, outcome: opened.reason } };
    this.sse = channel;
    this.era = "legacy-sse";
    this.version = SSE_VERSION;
    const init = await channel.send(this.body("initialize", this.initializeParams(SSE_VERSION)));
    const result = init.response?.result;
    if (!result || typeof result.protocolVersion !== "string") {
      channel.close();
      this.sse = void 0;
      this.era = void 0;
      return { ok: false, step: { attempt: "sse-get", status: opened.status, outcome: "endpoint event received, but initialize failed" } };
    }
    this.version = result.protocolVersion;
    await channel.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return {
      ok: true,
      step: { attempt: "sse-get", status: opened.status, outcome: `endpoint event received; initialize answered with ${result.protocolVersion}` },
      result: {
        ok: true,
        era: "legacy-sse",
        version: result.protocolVersion,
        ...isImplementation(result.serverInfo) ? { serverInfo: result.serverInfo } : {},
        ...isObject(result.capabilities) ? { capabilities: result.capabilities } : {},
        ...typeof result.instructions === "string" ? { instructions: result.instructions } : {}
      }
    };
  }
};
var SseChannel = class {
  constructor(wire, url) {
    this.wire = wire;
    this.url = url;
  }
  wire;
  url;
  endpoint;
  pending = /* @__PURE__ */ new Map();
  exchanges = /* @__PURE__ */ new Map();
  stop = new AbortController();
  closed = false;
  async open() {
    const { exchange, res } = await this.wire.request("GET", this.url, { Accept: "text/event-stream" });
    if (!res) return { ok: false, reason: exchange.error ?? "no response" };
    if (res.status === 401 || res.status === 403) {
      res.body?.cancel().catch(() => {
      });
      return { ok: false, status: res.status, reason: "credentials required", auth: { status: res.status, wwwAuthenticate: exchange.responseHeaders["www-authenticate"] } };
    }
    if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      res.body?.cancel().catch(() => {
      });
      return { ok: false, status: res.status, reason: `HTTP ${res.status}, not an SSE stream` };
    }
    const events = readSse(res.body, 4 * 1024 * 1024, this.stop.signal);
    const first = await withTimeout(events.next(), 1e4);
    if (!first || first.done || first.value.event !== "endpoint") {
      this.stop.abort();
      return { ok: false, status: res.status, reason: "stream opened, but no endpoint event" };
    }
    this.endpoint = new URL(first.value.data.trim(), this.url).toString();
    exchange.messages.push({ event: "endpoint", data: first.value.data });
    void this.pump(events);
    return { ok: true, status: res.status };
  }
  async pump(events) {
    try {
      for await (const event of events) {
        if (this.closed) break;
        const message = parseJson(event.data);
        if (!message || message.id === void 0 || message.id === null) continue;
        this.exchanges.get(message.id)?.messages.push(message);
        this.pending.get(message.id)?.(message);
      }
    } catch {
    }
  }
  async send(body) {
    if (!this.endpoint) throw new Error("SSE channel not open");
    const id = body.id;
    const waiting = id === void 0 ? void 0 : new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => resolve(void 0), 15e3);
    });
    const posted = await this.wire.post(this.endpoint, body);
    if (id === void 0 || !waiting) return posted;
    this.exchanges.set(id, posted.exchange);
    const response = posted.response ?? await waiting;
    this.pending.delete(id);
    return { exchange: posted.exchange, ...response ? { response } : {} };
  }
  close() {
    this.closed = true;
    this.stop.abort();
    for (const resolve of this.pending.values()) resolve(void 0);
    this.pending.clear();
  }
};
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(void 0), ms))]);
}
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isImplementation(value) {
  return isObject(value) && typeof value.name === "string";
}

// src/security/target.ts
var BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
function checkTarget(raw, policy = {}) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }
  if (url.username || url.password) return { ok: false, reason: "URLs with embedded credentials are not allowed. Use the token field instead." };
  if (policy.allowLocal) {
    return url.protocol === "https:" || url.protocol === "http:" ? { ok: true, url } : { ok: false, reason: "Only http and https URLs are supported." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Only https:// URLs can be checked online. Use the CLI for local servers." };
  if (url.port && url.port !== "443") return { ok: false, reason: "Only the standard HTTPS port (443) can be checked online." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIpLiteral(host)) {
    return isPrivateIp(host) ? { ok: false, reason: "Private and reserved IP addresses can only be checked with the CLI." } : { ok: true, url };
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) {
    return { ok: false, reason: "Local and internal hostnames can only be checked with the CLI." };
  }
  return { ok: true, url };
}
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}
function isPrivateIp(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) ?? h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || // carrier-grade NAT
    a === 169 && b === 254 || // link-local, cloud metadata
    a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 192 && b === 0 || a === 198 && (b === 18 || b === 19);
  }
  return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:");
}

// src/checks/auth.ts
function parseChallenge(header) {
  if (!header) return { params: {} };
  const match = header.trim().match(/^(\S+)\s*(.*)$/);
  const scheme = match?.[1];
  const params = {};
  for (const m of (match?.[2] ?? "").matchAll(/([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return { ...scheme ? { scheme } : {}, params };
}
function resourceMetadataCandidates(mcpUrl, fromHeader) {
  if (fromHeader) return [fromHeader];
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/$/, "");
  return [
    ...path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : [],
    `${u.origin}/.well-known/oauth-protected-resource`
  ];
}
function authServerCandidates(issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`
  ];
}
async function discoverAuth(wire, mcpUrl, challengeHeader, guard) {
  const checks = [];
  const summary = { required: true, ...challengeHeader ? { challenge: challengeHeader } : {} };
  const challenge = parseChallenge(challengeHeader);
  if (challenge.scheme?.toLowerCase() === "bearer" && challenge.params.resource_metadata) {
    checks.push(pass("auth.challenge", "Auth challenge points to its metadata", 3, "The 401 response includes a Bearer challenge with resource_metadata."));
  } else if (challenge.scheme?.toLowerCase() === "bearer") {
    checks.push(warn(
      "auth.challenge",
      "Auth challenge points to its metadata",
      3,
      "The 401 response has a Bearer challenge but no resource_metadata, so clients must guess the metadata URL.",
      'Add resource_metadata="https://\u2026/.well-known/oauth-protected-resource" to the WWW-Authenticate header.'
    ));
  } else {
    checks.push(fail(
      "auth.challenge",
      "Auth challenge points to its metadata",
      3,
      challengeHeader ? `The WWW-Authenticate header uses "${challenge.scheme}" instead of Bearer.` : "The 401 response has no WWW-Authenticate header.",
      'Return WWW-Authenticate: Bearer resource_metadata="\u2026" with every 401.'
    ));
  }
  if (challenge.params.scope) summary.scopes = challenge.params.scope.split(/\s+/);
  let prm;
  for (const candidate of resourceMetadataCandidates(mcpUrl, challenge.params.resource_metadata)) {
    if (!guard(candidate)) continue;
    const got = await wire.getJson(candidate);
    if (got.status === 200 && got.json) {
      prm = got.json;
      summary.resourceMetadataUrl = candidate;
      break;
    }
  }
  const servers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers.filter((s) => typeof s === "string") : [];
  if (prm && servers.length) {
    summary.authorizationServers = servers;
    if (typeof prm.resource === "string" && prm.resource) summary.resource = prm.resource;
    if (!summary.scopes && Array.isArray(prm.scopes_supported)) summary.scopes = prm.scopes_supported.filter((s) => typeof s === "string");
    checks.push(pass("auth.resource-metadata", "Protected resource metadata", 3, `Found at ${summary.resourceMetadataUrl}, listing ${servers.length} authorization server${servers.length === 1 ? "" : "s"}.`));
  } else {
    checks.push(fail(
      "auth.resource-metadata",
      "Protected resource metadata",
      3,
      prm ? "The protected resource metadata has no authorization_servers." : "No protected resource metadata was found at the URL in the challenge or the well-known locations.",
      "Serve RFC 9728 metadata at /.well-known/oauth-protected-resource with an authorization_servers list."
    ));
    for (const [id, title] of [["auth.as-metadata", "Authorization server metadata"], ["auth.pkce", "PKCE with S256"], ["auth.registration", "Client registration"]]) {
      checks.push(skip(id, title, "Skipped: no authorization server to inspect."));
    }
    return { summary, checks };
  }
  const issuer = servers[0];
  let asMeta;
  let mismatch;
  for (const candidate of authServerCandidates(issuer)) {
    if (!guard(candidate)) continue;
    const got = await wire.getJson(candidate);
    if (got.status !== 200 || !got.json) continue;
    if (got.json.issuer !== issuer) {
      mismatch = String(got.json.issuer);
      continue;
    }
    asMeta = got.json;
    break;
  }
  if (!asMeta) {
    checks.push(fail(
      "auth.as-metadata",
      "Authorization server metadata",
      3,
      mismatch ? `The metadata's issuer (${mismatch}) does not match the authorization server (${issuer}), so clients must reject it.` : `No metadata found for ${issuer} at the RFC 8414 or OpenID Connect locations.`,
      'Serve /.well-known/oauth-authorization-server (or openid-configuration) whose "issuer" exactly matches the URL in authorization_servers.'
    ));
    checks.push(skip("auth.pkce", "PKCE with S256", "Skipped: authorization server metadata not available."));
    checks.push(skip("auth.registration", "Client registration", "Skipped: authorization server metadata not available."));
    return { summary, checks };
  }
  summary.issuer = issuer;
  if (typeof asMeta.authorization_endpoint === "string") summary.authorizationEndpoint = asMeta.authorization_endpoint;
  if (typeof asMeta.token_endpoint === "string") summary.tokenEndpoint = asMeta.token_endpoint;
  checks.push(pass("auth.as-metadata", "Authorization server metadata", 3, `Found for ${issuer}, and its issuer matches.`));
  const methods = Array.isArray(asMeta.code_challenge_methods_supported) ? asMeta.code_challenge_methods_supported : void 0;
  summary.pkceS256 = !!methods?.includes("S256");
  checks.push(summary.pkceS256 ? pass("auth.pkce", "PKCE with S256", 3, "The authorization server advertises S256.") : fail(
    "auth.pkce",
    "PKCE with S256",
    3,
    methods ? `code_challenge_methods_supported lists ${methods.join(", ")}, but not S256.` : "code_challenge_methods_supported is missing, so MCP clients must refuse to sign in.",
    'Support PKCE and add "code_challenge_methods_supported": ["S256"] to the metadata.'
  ));
  summary.clientIdMetadataDocuments = asMeta.client_id_metadata_document_supported === true;
  summary.dynamicRegistration = typeof asMeta.registration_endpoint === "string";
  if (summary.dynamicRegistration) summary.registrationEndpoint = asMeta.registration_endpoint;
  if (summary.clientIdMetadataDocuments) {
    checks.push(pass("auth.registration", "Client registration", 2, "Supports Client ID Metadata Documents, so any client can sign in without registering first."));
  } else if (summary.dynamicRegistration) {
    checks.push(warn(
      "auth.registration",
      "Client registration",
      2,
      "Supports Dynamic Client Registration only, which the 2026-07-28 spec deprecates.",
      'Add Client ID Metadata Document support ("client_id_metadata_document_supported": true).'
    ));
  } else {
    checks.push(warn(
      "auth.registration",
      "Client registration",
      2,
      "No self-service registration: clients must be registered by hand before users can sign in.",
      "Support Client ID Metadata Documents so new MCP clients can connect without manual setup."
    ));
  }
  return { summary, checks };
}
var make = (status) => (id, title, weight, detail, fix) => ({ id, category: "auth", title, status, weight, detail, ...fix ? { fix } : {} });
var pass = make("pass");
var warn = make("warn");
var fail = make("fail");
var skip = (id, title, detail) => ({ id, category: "auth", title, status: "skip", weight: 0, detail });

// src/checks/grade.ts
var POINTS = { pass: 1, warn: 0.5, fail: 0 };
function score(checks) {
  let earned = 0;
  let possible = 0;
  for (const c of checks) {
    if (c.status === "info" || c.status === "skip") continue;
    earned += POINTS[c.status] * c.weight;
    possible += c.weight;
  }
  return possible === 0 ? 0 : Math.round(earned / possible * 100);
}
function grade(value) {
  if (value >= 90) return "A";
  if (value >= 80) return "B";
  if (value >= 70) return "C";
  if (value >= 60) return "D";
  return "F";
}

// src/checks/tools.ts
var NAME = /^[A-Za-z0-9_.-]{1,128}$/;
var MIN_DESCRIPTION = 20;
var JSON_TYPES = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
function toolChecks(tools) {
  return [descriptions(tools), schemas(tools), paramDescriptions(tools), names(tools), annotations(tools), outputSchemas(tools), size(tools)];
}
function descriptions(tools) {
  const missing = tools.filter((t) => !t.description?.trim());
  const short = tools.filter((t) => t.description?.trim() && t.description.trim().length < MIN_DESCRIPTION);
  const base = { id: "tools.descriptions", category: "tools", title: "Every tool is described", weight: 3 };
  const fix = "Give every tool a description that says what it does, when to use it, and what it returns.";
  if (!missing.length && !short.length) return { ...base, status: "pass", detail: `All ${tools.length} tools have descriptions.` };
  if (missing.length > tools.length / 2) return { ...base, status: "fail", detail: `${missing.length} of ${tools.length} tools have no description: ${list(missing)}.`, fix };
  return {
    ...base,
    status: "warn",
    detail: [missing.length && `${missing.length} without a description (${list(missing)})`, short.length && `${short.length} with a very short one (${list(short)})`].filter(Boolean).join("; ") + ".",
    fix
  };
}
function schemaProblems(schema, path = "inputSchema", root = true) {
  if (schema === void 0) return [`${path} is missing`];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path} is not an object`];
  const s = schema;
  const problems = [];
  if (root && s.type !== "object") problems.push(`${path}.type must be "object" (found ${JSON.stringify(s.type)})`);
  if (s.type !== void 0) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) if (typeof t !== "string" || !JSON_TYPES.has(t)) problems.push(`${path}.type ${JSON.stringify(t)} is not a JSON Schema type`);
  }
  if (s.properties !== void 0) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) problems.push(`${path}.properties is not an object`);
    else for (const [key, sub] of Object.entries(s.properties)) problems.push(...schemaProblems(sub, `${path}.properties.${key}`, false));
  }
  if (s.required !== void 0) {
    if (!Array.isArray(s.required)) problems.push(`${path}.required is not an array`);
    else {
      const props = s.properties && typeof s.properties === "object" ? Object.keys(s.properties) : [];
      for (const r of s.required) if (typeof r !== "string" || props.length && !props.includes(r)) problems.push(`${path}.required lists "${String(r)}", which isn't a property`);
    }
  }
  if (s.items !== void 0 && !Array.isArray(s.items)) problems.push(...schemaProblems(s.items, `${path}.items`, false));
  return problems;
}
function schemas(tools) {
  const broken = tools.map((t) => ({ t, problems: schemaProblems(t.inputSchema) })).filter((x) => x.problems.length);
  const base = { id: "tools.schemas", category: "tools", title: "Input schemas are valid", weight: 3 };
  if (!broken.length) return { ...base, status: "pass", detail: `All ${tools.length} input schemas are valid JSON Schema objects.` };
  const sample = broken.slice(0, 3).map((x) => `${x.t.name}: ${x.problems[0]}`).join("; ");
  return {
    ...base,
    status: broken.length > tools.length / 2 ? "fail" : "warn",
    detail: `${broken.length} of ${tools.length} tools have schema problems. ${sample}${broken.length > 3 ? "; \u2026" : ""}`,
    fix: 'Each inputSchema must be a JSON Schema with "type": "object" at the root; for no parameters use {"type":"object","additionalProperties":false}.'
  };
}
function paramDescriptions(tools) {
  let total = 0;
  let described = 0;
  const offenders = /* @__PURE__ */ new Set();
  for (const t of tools) {
    const props = t.inputSchema?.properties ?? {};
    if (!props || typeof props !== "object") continue;
    for (const p of Object.values(props)) {
      total++;
      if (p && typeof p === "object" && typeof p.description === "string" && p.description.trim()) described++;
      else offenders.add(t.name);
    }
  }
  const base = { id: "tools.param-descriptions", category: "tools", title: "Parameters are described", weight: 2 };
  if (total === 0) return { ...base, status: "info", detail: "No tool takes parameters." };
  const ratio = described / total;
  const detail = `${described} of ${total} parameters have descriptions.`;
  if (ratio >= 0.9) return { ...base, status: "pass", detail };
  return {
    ...base,
    status: ratio >= 0.5 ? "warn" : "fail",
    detail: `${detail} Missing in: ${[...offenders].slice(0, 5).join(", ")}${offenders.size > 5 ? ", \u2026" : ""}.`,
    fix: 'Add a "description" to every property, with the format and an example ("City name, for example Kathmandu").'
  };
}
function names(tools) {
  const invalid = tools.filter((t) => !NAME.test(t.name));
  const seen = /* @__PURE__ */ new Map();
  for (const t of tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  const base = { id: "tools.names", category: "tools", title: "Tool names are valid and unique", weight: 2 };
  if (!invalid.length && !dupes.length) return { ...base, status: "pass", detail: "All names use A\u2013Z, 0\u20139, _ - . and are unique." };
  return {
    ...base,
    status: dupes.length ? "fail" : "warn",
    detail: [invalid.length && `Invalid names: ${invalid.map((t) => JSON.stringify(t.name)).slice(0, 5).join(", ")}`, dupes.length && `Duplicates: ${dupes.join(", ")}`].filter(Boolean).join(". ") + ".",
    fix: "Use 1\u2013128 characters from A\u2013Z, a\u2013z, 0\u20139, _, - and ., and give every tool a unique name."
  };
}
function annotations(tools) {
  const annotated = tools.filter((t) => t.annotations && (typeof t.annotations.readOnlyHint === "boolean" || typeof t.annotations.destructiveHint === "boolean"));
  const base = { id: "tools.annotations", category: "tools", title: "Tools say whether they change things", weight: 2 };
  const detail = `${annotated.length} of ${tools.length} tools declare readOnlyHint or destructiveHint.`;
  if (annotated.length === tools.length) return { ...base, status: "pass", detail };
  return {
    ...base,
    status: "warn",
    detail: `${detail} Without them, clients must assume every tool may be destructive and ask users to confirm each call.`,
    fix: "Add annotations: { readOnlyHint: true } to tools that only read, and destructiveHint to tools that delete or overwrite."
  };
}
function outputSchemas(tools) {
  const withOutput = tools.filter((t) => t.outputSchema !== void 0);
  const base = { id: "tools.output-schema", category: "tools", title: "Output schemas are valid", weight: 1 };
  if (!withOutput.length) return { ...base, status: "info", detail: "No tool declares an outputSchema (optional; it helps clients use structured results)." };
  const broken = withOutput.filter((t) => schemaProblems(t.outputSchema, "outputSchema", false).length);
  if (!broken.length) return { ...base, status: "pass", detail: withOutput.length === 1 ? "1 tool declares a valid outputSchema." : `${withOutput.length} tools declare a valid outputSchema.` };
  return { ...base, status: "warn", detail: `Invalid outputSchema in: ${list(broken)}.`, fix: "Make each outputSchema a valid JSON Schema." };
}
function size(tools) {
  const bytes = new TextEncoder().encode(JSON.stringify(tools)).byteLength;
  const kb = Math.round(bytes / 1024);
  const tokens = Math.round(bytes / 4);
  const base = { id: "tools.size", category: "tools", title: "Tool list fits in an agent's context", weight: 1 };
  const detail = `The tool definitions are about ${kb} KB (roughly ${tokens.toLocaleString("en-US")} tokens), loaded into every conversation that uses this server.`;
  if (bytes <= 30 * 1024) return { ...base, status: "pass", detail };
  return {
    ...base,
    status: bytes <= 100 * 1024 ? "warn" : "fail",
    detail,
    fix: "Trim long descriptions, merge overlapping tools, or split rarely used tools into a separate server."
  };
}
function list(tools) {
  const names2 = tools.map((t) => t.name);
  return names2.slice(0, 5).join(", ") + (names2.length > 5 ? ", \u2026" : "");
}

// src/checks/run.ts
var PROBE_TOOL = "mcp_check_probe_nonexistent_tool";
var FOREIGN_ORIGIN = "https://mcp-check.invalid";
async function runCheck(rawUrl, opts = {}) {
  const started = Date.now();
  const vantage = opts.vantage ?? "the checker";
  const target = checkTarget(rawUrl, opts);
  const authenticated = Object.keys(opts.headers ?? {}).some((h) => h.toLowerCase() === "authorization");
  const base = { url: rawUrl, checkedAt: new Date(started).toISOString(), authenticated, steps: [], tools: [], prompts: [], resources: [], resourceTemplates: [] };
  if (!target.ok) {
    return { ...base, durationMs: 0, connected: false, checks: [], score: 0, grade: "F", error: target.reason };
  }
  const url = target.url.toString();
  const guard = (u) => checkTarget(u, opts).ok;
  const client = new McpClient(url, { ...opts.fetch ? { fetch: opts.fetch } : {}, ...opts.headers ? { headers: opts.headers } : {}, ...opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {} });
  const checks = [httpsCheck(target.url)];
  try {
    const conn = await client.connect();
    const report = {
      ...base,
      url,
      durationMs: 0,
      connected: conn.ok,
      steps: conn.steps,
      checks,
      score: 0,
      grade: "F",
      ...conn.era ? { era: conn.era } : {},
      ...conn.version ? { version: conn.version } : {},
      ...conn.serverInfo ? { serverInfo: conn.serverInfo } : {},
      ...conn.capabilities ? { capabilities: conn.capabilities } : {},
      ...conn.instructions ? { instructions: conn.instructions } : {}
    };
    if (!conn.ok && conn.auth) {
      const auth = await discoverAuth(client.wire, url, conn.auth.wwwAuthenticate, guard);
      report.auth = auth.summary;
      checks.push(...auth.checks);
      checks.push(info("tools.listed", "tools", "Tools listed", "This server requires sign-in. Sign in to inspect and grade its tools."));
      checks.push(...leakCheck(client.log), speedCheck("performance.connect", "Connection speed", client.log[0], vantage));
      report.partial = true;
      return finish(report, checks, started);
    }
    if (!conn.ok) {
      checks.push({ id: "protocol.connect", category: "protocol", title: "Speaks MCP", status: "fail", weight: 10, detail: conn.error ?? "Could not connect.", fix: "Check the URL points at the MCP endpoint (often /mcp) and that the server is running." });
      report.error = conn.error ?? "Could not connect.";
      return { ...finish(report, checks, started), score: 0, grade: "F" };
    }
    checks.push(...protocolChecks(conn, client.log));
    const connected = conn.era === "modern" ? client.log.find((e) => e.rpcMethod === "server/discover" && e.status === 200) : client.log.find((e) => e.rpcMethod === "initialize" && !e.error);
    checks.push(speedCheck("performance.connect", "Connection speed", connected, vantage));
    const caps = conn.capabilities;
    const declares = (key) => !caps || key in caps;
    if (declares("tools")) {
      const tools = await client.listAll("tools/list", "tools");
      report.tools = tools.items.filter(isObject).map(summarizeTool);
      if (tools.error) {
        checks.push({ id: "tools.listed", category: "tools", title: "Tools listed", status: "fail", weight: 3, detail: `tools/list failed: ${tools.error}`, fix: "Make tools/list return { tools: [...] }." });
      } else {
        checks.push({ id: "tools.listed", category: "tools", title: "Tools listed", status: report.tools.length ? "pass" : "warn", weight: 3, detail: report.tools.length ? `${report.tools.length} tool${report.tools.length === 1 ? "" : "s"} across ${tools.pages} page${tools.pages === 1 ? "" : "s"}${tools.truncated ? " (stopped at the limit)" : ""}.` : "The server declares tools but lists none." });
        if (report.tools.length) checks.push(...toolChecks(report.tools));
      }
      const listExchange = client.log.find((e) => e.rpcMethod === "tools/list" && e.status === 200);
      if (listExchange) checks.push(speedCheck("performance.list", "tools/list speed", listExchange, vantage));
    } else {
      checks.push(info("tools.listed", "tools", "Tools listed", "The server does not declare the tools capability."));
    }
    if (declares("prompts")) {
      const prompts = await client.listAll("prompts/list", "prompts");
      report.prompts = prompts.items.filter(isObject).map((p) => pick(p, ["name", "title", "description"]));
    }
    if (declares("resources")) {
      const resources = await client.listAll("resources/list", "resources");
      report.resources = resources.items.filter(isObject).map((r) => pick(r, ["uri", "name", "description", "mimeType"]));
      const templates = await client.listAll("resources/templates/list", "resourceTemplates");
      report.resourceTemplates = templates.items.filter(isObject).map((r) => pick(r, ["uriTemplate", "name", "description"]));
    }
    checks.push(...await probeChecks(client));
    checks.push(...leakCheck(client.log));
    checks.push(info("auth.public", "auth", "Sign-in", authenticated ? "Checked with the credentials you provided." : "No sign-in required: anyone with the URL can use this server."));
    return finish(report, checks, started);
  } finally {
    await client.close().catch(() => {
    });
    opts.logSink?.push(...client.log);
  }
}
function finish(report, checks, started) {
  const value = score(checks);
  return { ...report, checks, score: value, grade: grade(value), durationMs: Date.now() - started };
}
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function httpsCheck(url) {
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) {
    return { id: "security.https", category: "security", title: "Served over HTTPS", status: "info", weight: 0, detail: "Not checked: the server is on this machine. Serve it over HTTPS when you deploy it." };
  }
  return url.protocol === "https:" ? { id: "security.https", category: "security", title: "Served over HTTPS", status: "pass", weight: 3, detail: "The endpoint uses HTTPS." } : { id: "security.https", category: "security", title: "Served over HTTPS", status: "fail", weight: 3, detail: "The endpoint uses plain HTTP, so tokens and tool data travel unencrypted.", fix: "Serve the MCP endpoint over HTTPS." };
}
function protocolChecks(conn, log) {
  const out = [];
  const era = conn.era;
  if (era === "modern") {
    out.push({ id: "protocol.era", category: "protocol", title: "Speaks the current spec", status: "pass", weight: 3, detail: `Speaks ${MODERN_VERSION}, the current MCP revision.` });
  } else if (era === "legacy-streamable") {
    const latestLegacy = conn.version === LEGACY_VERSIONS[0];
    out.push({
      id: "protocol.era",
      category: "protocol",
      title: "Speaks the current spec",
      status: "warn",
      weight: 3,
      detail: `Speaks ${conn.version} over Streamable HTTP. ${latestLegacy ? "That was the previous revision" : "That is an older revision"}; current clients expect ${MODERN_VERSION} (stateless, no initialize handshake).`,
      fix: `Upgrade your MCP SDK to one that supports ${MODERN_VERSION}, keeping ${LEGACY_VERSIONS[0]} for older clients.`
    });
  } else {
    out.push({
      id: "protocol.era",
      category: "protocol",
      title: "Speaks the current spec",
      status: "fail",
      weight: 3,
      detail: `Uses the deprecated HTTP+SSE transport (${conn.version}). Many current clients can't connect to it.`,
      fix: "Move to Streamable HTTP and the current spec revision."
    });
  }
  const info_ = conn.serverInfo;
  out.push(info_?.name && info_.version ? { id: "protocol.server-info", category: "protocol", title: "Identifies itself", status: "pass", weight: 2, detail: `${info_.name} ${info_.version}.` } : { id: "protocol.server-info", category: "protocol", title: "Identifies itself", status: "warn", weight: 2, detail: info_?.name ? `Gives a name (${info_.name}) but no version.` : "Sends no serverInfo.", fix: era === "modern" ? 'Include _meta["io.modelcontextprotocol/serverInfo"] with name and version in server/discover.' : "Include serverInfo { name, version } in the initialize result." });
  const known = [MODERN_VERSION, ...LEGACY_VERSIONS, "2024-11-05"];
  out.push(conn.version && known.includes(conn.version) ? { id: "protocol.version", category: "protocol", title: "Negotiates a real version", status: "pass", weight: 2, detail: `Agreed on ${conn.version}.` } : { id: "protocol.version", category: "protocol", title: "Negotiates a real version", status: "fail", weight: 2, detail: `Answered with "${conn.version}", which isn't a published revision.`, fix: "Return one of the published protocol versions." });
  const posts = log.filter((e) => e.method === "POST" && e.status !== void 0 && e.status >= 200 && e.status < 300 && e.status !== 202);
  const wrong = posts.filter((e) => !/application\/json|text\/event-stream/i.test(e.contentType ?? ""));
  out.push(wrong.length ? { id: "protocol.content-type", category: "protocol", title: "Correct response content types", status: "fail", weight: 1, detail: `${wrong.length} response${wrong.length === 1 ? "" : "s"} used ${wrong[0]?.contentType ?? "no content type"}.`, fix: "Respond with application/json or text/event-stream." } : { id: "protocol.content-type", category: "protocol", title: "Correct response content types", status: "pass", weight: 1, detail: "Responses use application/json or text/event-stream." });
  if (era === "legacy-streamable") {
    const s = conn.initializedStatus;
    out.push(s === 202 ? { id: "protocol.notifications", category: "protocol", title: "Accepts notifications", status: "pass", weight: 1, detail: "notifications/initialized was accepted with 202." } : { id: "protocol.notifications", category: "protocol", title: "Accepts notifications", status: s !== void 0 && s >= 200 && s < 300 ? "warn" : "fail", weight: 1, detail: `notifications/initialized got HTTP ${s ?? "no response"} (expected 202).`, fix: "Answer notifications with 202 Accepted and no body." });
  }
  if (era === "modern") {
    const results = log.flatMap((e) => e.messages).filter((m) => isObject(m) && isObject(m.result));
    const missing = results.filter((m) => typeof m.result.resultType !== "string");
    out.push(missing.length ? { id: "protocol.result-type", category: "protocol", title: "Results declare resultType", status: "warn", weight: 1, detail: `${missing.length} result${missing.length === 1 ? "" : "s"} had no resultType.`, fix: 'Add resultType: "complete" to every result (required in 2026-07-28).' } : { id: "protocol.result-type", category: "protocol", title: "Results declare resultType", status: "pass", weight: 1, detail: "Every result declares resultType." });
  }
  return out;
}
async function probeChecks(client) {
  const out = [];
  const unknown = await client.request("mcp-check/unknown-method");
  if (unknown.error?.code === ERROR.methodNotFound) {
    out.push({ id: "protocol.unknown-method", category: "protocol", title: "Rejects unknown methods properly", status: "pass", weight: 2, detail: "An unknown method gets JSON-RPC error -32601." });
  } else if (unknown.error) {
    out.push({ id: "protocol.unknown-method", category: "protocol", title: "Rejects unknown methods properly", status: "warn", weight: 2, detail: `An unknown method gets error ${unknown.error.code} instead of -32601.`, fix: "Return -32601 (Method not found) for methods you don't implement." });
  } else {
    out.push({ id: "protocol.unknown-method", category: "protocol", title: "Rejects unknown methods properly", status: "fail", weight: 2, detail: unknown.result ? "An unknown method returned a result instead of an error." : `An unknown method got ${describeExchange(unknown.exchange)} instead of a JSON-RPC error.`, fix: "Return a JSON-RPC error -32601 (Method not found)." });
  }
  const call = await client.callTool(PROBE_TOOL, {});
  const isErrorResult = call.result?.isError === true;
  if (call.error?.code === ERROR.invalidParams || isErrorResult) {
    out.push({ id: "tools.unknown-tool", category: "tools", title: "Handles calls to unknown tools", status: "pass", weight: 1, detail: call.error ? "Calling a tool that doesn't exist returns error -32602." : "Calling a tool that doesn't exist returns an isError result." });
  } else if (call.error) {
    out.push({ id: "tools.unknown-tool", category: "tools", title: "Handles calls to unknown tools", status: "warn", weight: 1, detail: `Calling a tool that doesn't exist returns error ${call.error.code} (the spec uses -32602).`, fix: "Return -32602 for unknown tool names." });
  } else {
    out.push({ id: "tools.unknown-tool", category: "tools", title: "Handles calls to unknown tools", status: "fail", weight: 1, detail: call.result ? `Calling a tool that doesn't exist "succeeded".` : `Calling a tool that doesn't exist got ${describeExchange(call.exchange)}.`, fix: "Return a JSON-RPC error -32602 for unknown tool names." });
  }
  if (client.era !== "legacy-sse") {
    const method = client.era === "modern" ? "server/discover" : "tools/list";
    const foreign = await client.request(method, {}, void 0, { Origin: FOREIGN_ORIGIN });
    const s = foreign.exchange.status;
    out.push(s === 403 ? { id: "security.origin", category: "security", title: "Rejects requests from other websites", status: "pass", weight: 1, detail: "A request with a foreign Origin header was refused with 403." } : { id: "security.origin", category: "security", title: "Rejects requests from other websites", status: s !== void 0 && s >= 400 ? "pass" : "warn", weight: 1, detail: s !== void 0 && s >= 400 ? `A request with a foreign Origin header was refused (HTTP ${s}).` : "A request with a foreign Origin header was accepted. Browsers on any website could send requests to this server.", ...s !== void 0 && s < 400 ? { fix: "Validate the Origin header and return 403 when it isn't an origin you trust." } : {} });
  }
  return out;
}
var LEAK_PATTERNS = [
  [/\n\s+at\s+\S.*\(.*:\d+:\d+\)/, "a JavaScript stack trace"],
  [/Traceback \(most recent call last\)/, "a Python traceback"],
  [/node:internal\//, "Node.js internals"],
  [/(?:^|[\s"'(])(?:\/home|\/usr|\/var|\/srv|\/opt|\/app)\/[\w./-]+\.(?:js|ts|py|go|rb|java|php)\b/, "a server file path"],
  [/[A-Z]:\\(?:Users|inetpub|Program Files)\\/i, "a Windows file path"],
  [/\bat [\w$.]+\.java:\d+\)|Exception in thread/, "a Java stack trace"],
  [/goroutine \d+ \[running\]/, "a Go panic trace"]
];
function leakCheck(log) {
  const texts = [];
  for (const e of log) {
    if (e.rawText && (e.status ?? 0) >= 400) texts.push(e.rawText);
    for (const m of e.messages) {
      const err = isObject(m) && isObject(m.error) ? m.error : void 0;
      if (err) texts.push(`${String(err.message ?? "")}
${typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? "")}`);
    }
  }
  const hits = /* @__PURE__ */ new Set();
  for (const t of texts) for (const [re, label] of LEAK_PATTERNS) if (re.test(t)) hits.add(label);
  if (!texts.length) return [info("security.error-leaks", "security", "Errors don't leak internals", "No error responses to inspect.")];
  return [hits.size ? { id: "security.error-leaks", category: "security", title: "Errors don't leak internals", status: "fail", weight: 2, detail: `Error responses expose ${[...hits].join(", ")}.`, fix: "Return short error messages to clients and log the details on the server." } : { id: "security.error-leaks", category: "security", title: "Errors don't leak internals", status: "pass", weight: 2, detail: `${texts.length} error response${texts.length === 1 ? "" : "s"} checked; none expose stack traces or file paths.` }];
}
function speedCheck(id, title, exchange, vantage) {
  if (!exchange || exchange.status === void 0) return info(id, "performance", title, "Not measured.");
  const ms = exchange.ms;
  const status = ms < 1e3 ? "pass" : ms < 3e3 ? "warn" : "fail";
  return { id, category: "performance", title, status, weight: id === "performance.connect" ? 2 : 1, detail: `${ms} ms, measured from ${vantage}.`, ...status !== "pass" ? { fix: "Responses over a second slow down every agent turn that uses this server." } : {} };
}
function info(id, category, title, detail) {
  return { id, category, title, status: "info", weight: 0, detail };
}
function describeExchange(e) {
  if (e.error) return e.error;
  if (e.status === void 0) return "no response";
  return `HTTP ${e.status}${e.rawText ? " with a non-JSON body" : ""}`;
}
function summarizeTool(t) {
  const tool = pick(t, ["title", "description", "inputSchema", "outputSchema", "annotations"]);
  return { name: typeof t.name === "string" ? t.name : String(t.name ?? ""), ...tool };
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== void 0) out[k] = obj[k];
  return out;
}

// cli/src/format.ts
var WEB = "https://mcp.nischaldhakal.com.np";
var GRADES = ["A", "B", "C", "D", "F"];
function verdict(report, o) {
  if (!report.connected && !report.auth) return { exitCode: 2, message: `Couldn't check the server: ${report.error ?? "it did not respond as an MCP server."}` };
  const problems = [];
  if (o.minGrade && GRADES.indexOf(report.grade) > GRADES.indexOf(o.minGrade)) problems.push(`grade ${report.grade} is below the minimum ${o.minGrade}`);
  if (o.minScore !== void 0 && report.score < o.minScore) problems.push(`score ${report.score} is below the minimum ${o.minScore}`);
  if (problems.length) return { exitCode: 1, message: `Failed: ${problems.join(" and ")}.` };
  const threshold = [o.minGrade && `grade ${o.minGrade}`, o.minScore !== void 0 && `score ${o.minScore}`].filter(Boolean).join(" and ");
  return { exitCode: 0, message: threshold ? `Passed: meets the minimum ${threshold}.` : "Done." };
}
var CATEGORY_ORDER = ["protocol", "tools", "auth", "security", "performance"];
var CATEGORY_LABEL = { protocol: "Protocol", tools: "Tools", auth: "Authentication", security: "Security", performance: "Speed" };
var ERA_LABEL = { modern: "stateless HTTP", "legacy-streamable": "Streamable HTTP", "legacy-sse": "HTTP+SSE (deprecated)" };
var SYMBOL = { pass: "\u2713", warn: "!", fail: "\u2717", info: "i", skip: "\u2013" };
var EMOJI = { pass: "\u2705", warn: "\u26A0\uFE0F", fail: "\u274C", info: "\u2139\uFE0F", skip: "\u2796" };
var STATUS_ORDER = { fail: 0, warn: 1, info: 2, pass: 3, skip: 4 };
function webLink(url) {
  return checkTarget(url).ok ? `${WEB}/?url=${encodeURIComponent(url)}` : void 0;
}
function summaryLine(report) {
  const parts = [
    report.version && `spec ${report.version}${report.era ? ` (${ERA_LABEL[report.era] ?? report.era})` : ""}`,
    report.connected && !report.partial && `${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`,
    `checked in ${(report.durationMs / 1e3).toFixed(1)}s`
  ];
  return parts.filter(Boolean).join(" \xB7 ");
}
function counts(checks) {
  const n = (s) => checks.filter((c) => c.status === s).length;
  return { pass: n("pass"), warn: n("warn"), fail: n("fail") };
}
var sorted = (checks) => [...checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
function renderText(report, o, v) {
  const paint = (code) => (s) => o.color ? `\x1B[${code}m${s}\x1B[0m` : s;
  const bold = paint("1");
  const dim = paint("2");
  const tone = { pass: paint("32"), warn: paint("33"), fail: paint("31"), info: paint("36"), skip: dim };
  const gradeTone = report.grade === "A" || report.grade === "B" ? tone.pass : report.grade === "C" ? tone.warn : tone.fail;
  const out = ["", `${bold("MCP Check")}  ${report.url}`, ""];
  if (!report.connected && !report.auth) {
    out.push(`  ${tone.fail("\u2717")} ${report.error ?? "The server did not respond as an MCP server."}`, "");
    if (v) out.push(tone.fail(v.message), "");
    return out.join("\n");
  }
  out.push(`  ${gradeTone(bold(`Grade ${report.grade}`))}  ${bold(`${report.score}/100`)}  ${dim(summaryLine(report))}`);
  if (report.partial) out.push(`  ${tone.warn("Partial grade:")} the server requires sign-in. Pass --token to grade its tools.`);
  out.push("");
  for (const c of sorted(report.checks)) {
    if (!o.verbose && (c.status === "pass" || c.status === "skip" || c.status === "info")) continue;
    out.push(`  ${tone[c.status](SYMBOL[c.status])} ${bold(c.title)} ${dim(`(${CATEGORY_LABEL[c.category]})`)}`);
    out.push(`    ${c.detail}`);
    if (c.fix && c.status !== "pass") out.push(`    ${dim("Fix:")} ${c.fix}`);
  }
  const n = counts(report.checks);
  out.push("", `  ${tone.pass(`${n.pass} passed`)} \xB7 ${tone.warn(`${n.warn} warning${n.warn === 1 ? "" : "s"}`)} \xB7 ${tone.fail(`${n.fail} failed`)}${o.verbose ? "" : dim("  (-v lists passing checks)")}`);
  const link = webLink(report.url);
  if (link) out.push(`  ${dim("On the web:")} ${link}`);
  out.push("");
  if (v && v.message !== "Done.") out.push(v.exitCode === 0 ? tone.pass(v.message) : tone.fail(v.message), "");
  return out.join("\n");
}
var cell = (s) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
function renderMarkdown(report, v) {
  const out = [];
  if (!report.connected && !report.auth) {
    out.push(`### \u274C MCP Check: couldn't reach the server`, "", `\`${report.url}\``, "", report.error ?? "The server did not respond as an MCP server.");
    return out.join("\n") + "\n";
  }
  const mark = v ? v.exitCode === 0 ? " \u2705" : " \u274C" : "";
  out.push(`### MCP Check: grade ${report.grade} (${report.score}/100)${mark}`, "", `\`${report.url}\` \xB7 ${summaryLine(report)}`, "");
  if (v && v.message !== "Done.") out.push(`**${v.message}**`, "");
  if (report.partial) out.push("> Partial grade: the server requires sign-in, so its tools were not graded. Pass a token to grade them.", "");
  const issues = sorted(report.checks).filter((c) => c.status === "fail" || c.status === "warn");
  if (issues.length) {
    out.push("| | Check | What we found | How to fix |", "|---|---|---|---|");
    for (const c of issues) out.push(`| ${EMOJI[c.status]} | ${cell(c.title)} | ${cell(c.detail)} | ${cell(c.fix ?? "")} |`);
    out.push("");
  } else {
    out.push("No warnings or failures. \u{1F389}", "");
  }
  const passed = sorted(report.checks).filter((c) => c.status === "pass");
  if (passed.length) {
    out.push(`<details><summary>${passed.length} passed check${passed.length === 1 ? "" : "s"}</summary>`, "");
    for (const c of passed) out.push(`- \u2705 **${c.title}**: ${c.detail.replace(/\r?\n/g, " ")}`);
    out.push("", "</details>", "");
  }
  const link = webLink(report.url);
  out.push(`Checked with [MCP Check](${WEB})${link ? ` \xB7 [open this check on the web](${link})` : ""}.`);
  return out.join("\n") + "\n";
}

// cli/src/action.ts
var input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
var setOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
};
var escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
async function run() {
  const url = input("url");
  if (!url) throw new Error('The "url" input is required.');
  const headers = {};
  const token = input("token");
  if (token) {
    process.stdout.write(`::add-mask::${token}
`);
    headers.Authorization = `Bearer ${token}`;
  }
  for (const line of input("headers").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z0-9-]+)\s*:\s*(.*)$/);
    if (!m) throw new Error(`Each line of "headers" must be "Name: value", got ${JSON.stringify(line.trim())}.`);
    headers[m[1]] = m[2];
    if (m[2]) process.stdout.write(`::add-mask::${m[2]}
`);
  }
  const minGrade = input("min-grade").toUpperCase();
  if (minGrade && !/^[ABCDF]$/.test(minGrade)) throw new Error('"min-grade" must be one of A, B, C, D, F.');
  const minScoreRaw = input("min-score");
  const minScore = minScoreRaw ? Number(minScoreRaw) : void 0;
  if (minScore !== void 0 && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) throw new Error('"min-score" must be a number from 0 to 100.');
  const timeout = Number(input("timeout") || 15);
  const report = await runCheck(url, { allowLocal: true, headers, vantage: "GitHub Actions", timeoutMs: Math.round(timeout * 1e3) });
  const v = verdict(report, { ...minGrade ? { minGrade } : {}, ...minScore !== void 0 ? { minScore } : {} });
  process.stdout.write(renderText(report, { color: true, verbose: false }, v) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report, v));
  const reportPath = join(process.env.RUNNER_TEMP ?? ".", "mcp-check-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  setOutput("grade", report.connected || report.auth ? report.grade : "");
  setOutput("score", report.connected || report.auth ? String(report.score) : "");
  setOutput("passed", String(v.exitCode === 0));
  setOutput("report", reportPath);
  for (const c of report.checks.filter((c2) => c2.status === "fail")) {
    process.stdout.write(`::warning title=${escapeData(`MCP Check: ${c.title}`)}::${escapeData(c.fix ? `${c.detail} Fix: ${c.fix}` : c.detail)}
`);
  }
  if (v.exitCode !== 0) {
    process.stdout.write(`::error title=MCP Check::${escapeData(v.message)}
`);
    process.exitCode = 1;
  }
}
run().catch((err) => {
  process.stdout.write(`::error title=MCP Check::${escapeData(err instanceof Error ? err.message : String(err))}
`);
  process.exitCode = 1;
});
