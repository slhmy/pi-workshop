import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

const port = Number(process.env.PORT || 3000);
const workspaceDir = resolve(process.env.WORKSPACE_DIR || "/agent-data/workspace");
const webDir = resolve(workspaceDir, "web");
const sessionDir = resolve(process.env.PI_CODING_AGENT_SESSION_DIR || "/agent-data/sessions");
const provider = process.env.PI_PROVIDER?.trim() || "";
const model = process.env.PI_MODEL?.trim() || "";
const thinking = process.env.PI_THINKING || "high";
const sessionName = process.env.PI_SESSION_NAME?.trim() || "pi-workshop";
const corePrompt = "/opt/pi-control/CORE.md";
const allowedHosts = new Set(
  (process.env.PI_ALLOWED_HOSTS || "localhost,127.0.0.1,[::1]")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const clients = new Set();
const pending = new Map();
let requestSequence = 0;
let rpcBuffer = "";
let agent = null;
let agentReady = false;
let restartTimer = null;
let shuttingDown = false;

function broadcast(payload) {
  const frame = `event: rpc\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(frame);
}

function settlePending(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

function handleRpcLine(line) {
  if (!line) return;

  let event;
  try {
    event = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
  } catch {
    broadcast({ type: "control_error", message: "Pi emitted an invalid RPC record." });
    return;
  }
  agentReady = true;

  if (event.type === "response" && event.id && pending.has(event.id)) {
    const waiter = pending.get(event.id);
    clearTimeout(waiter.timer);
    pending.delete(event.id);
    event.success ? waiter.resolve(event) : waiter.reject(new Error(event.error || "Pi command failed"));
  }

  broadcast(event);
}

function consumeRpcOutput(chunk) {
  rpcBuffer += chunk.toString("utf8");

  while (true) {
    const newline = rpcBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = rpcBuffer.slice(0, newline);
    rpcBuffer = rpcBuffer.slice(newline + 1);
    handleRpcLine(line);
  }
}

function startAgent() {
  if (agent || shuttingDown) return;
  agentReady = false;

  const args = [
    "--mode",
    "rpc",
    "--continue",
    "--approve",
    "--thinking",
    thinking,
    "--session-dir",
    sessionDir,
    "--name",
    sessionName,
    "--append-system-prompt",
    `Follow the immutable operating policy in ${corePrompt}. Read that file before changing the workspace.`,
  ];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);

  agent = spawn("pi", args, {
    cwd: workspaceDir,
    env: {
      ...process.env,
      HOME: "/agent-data",
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || "/agent-data/config",
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  agent.stdout.on("data", consumeRpcOutput);
  agent.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) broadcast({ type: "control_log", message });
  });
  agent.on("error", (error) => {
    broadcast({ type: "control_error", message: `Unable to start Pi: ${error.message}` });
  });
  agent.on("exit", (code, signal) => {
    agent = null;
    agentReady = false;
    rpcBuffer = "";
    settlePending(new Error("Pi process stopped"));
    broadcast({ type: "control_status", status: "stopped", code, signal });
    if (!shuttingDown) restartTimer = setTimeout(startAgent, 1500);
  });
  broadcast({ type: "control_status", status: "starting", provider: provider || "auto", model: model || "auto" });
  setTimeout(() => sendRpc({ type: "get_state" }, 5000).catch(() => {}), 250).unref();
}

function sendRpc(command, timeoutMs = 15_000) {
  if (!agent || agent.exitCode !== null || !agent.stdin.writable) {
    return Promise.reject(new Error("Pi is not running"));
  }

  const id = `web-${Date.now()}-${++requestSequence}`;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Pi command timed out"));
    }, timeoutMs);

    pending.set(id, { resolve: resolveRequest, reject, timer });
    agent.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: rpc\ndata: ${JSON.stringify({ type: "control_status", status: agent ? "running" : "starting", provider: provider || "auto", model: model || "auto" })}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(response);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const result = await sendRpc({ type: "get_state" });
    sendJson(response, 200, result.data);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/messages") {
    const result = await sendRpc({ type: "get_messages" });
    sendJson(response, 200, result.data);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prompt") {
    const body = await readJsonBody(request);
    if (typeof body.message !== "string" || !body.message.trim()) {
      sendJson(response, 400, { error: "message is required" });
      return;
    }

    const command = { type: "prompt", message: body.message.trim() };
    if (body.streamingBehavior === "steer" || body.streamingBehavior === "followUp") {
      command.streamingBehavior = body.streamingBehavior;
    }
    await sendRpc(command);
    sendJson(response, 202, { accepted: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/abort") {
    await sendRpc({ type: "abort" }, 30_000);
    sendJson(response, 200, { aborted: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/new-session") {
    await sendRpc({ type: "new_session" }, 30_000);
    sendJson(response, 200, { created: true });
    return;
  }

  sendJson(response, 404, { error: "API route not found" });
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function serveStatic(response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid path" });
    return;
  }

  const requested = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let candidate = resolve(webDir, requested);
  if (relative(webDir, candidate).startsWith(`..${sep}`) || relative(webDir, candidate) === "..") {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(candidate);
    if (fileStat.isDirectory()) candidate = join(candidate, "index.html");
  } catch {
    if (!extname(requested)) candidate = join(webDir, "index.html");
  }

  try {
    const [realRoot, realFile] = await Promise.all([realpath(webDir), realpath(candidate)]);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }

    const fileStat = await stat(realFile);
    if (!fileStat.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": fileStat.size,
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Content-Type": contentTypes[extname(realFile).toLowerCase()] || "application/octet-stream",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(realFile).pipe(response);
  } catch {
    sendJson(response, 404, { error: "File not found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");

  let requestHostname;
  try {
    requestHostname = new URL(`http://${request.headers.host || ""}`).hostname.toLowerCase();
  } catch {
    sendJson(response, 400, { error: "Invalid Host header" });
    return;
  }
  const requestHost = (request.headers.host || "").toLowerCase();
  if (!allowedHosts.has(requestHost) && !allowedHosts.has(requestHostname)) {
    sendJson(response, 421, { error: "Host is not allowed" });
    return;
  }

  if (request.method === "POST" && request.headers.origin) {
    let originHost;
    try {
      originHost = new URL(request.headers.origin).host;
    } catch {
      sendJson(response, 403, { error: "Invalid request origin" });
      return;
    }
    if (originHost !== request.headers.host) {
      sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, agentReady ? 200 : 503, {
      status: agentReady ? "ok" : "starting",
      agent: agentReady ? "running" : "starting",
    });
    return;
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 503, { error: error instanceof Error ? error.message : "Request failed" });
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const client of clients) client.end();
  server.close();
  if (agent && agent.exitCode === null) agent.kill("SIGTERM");
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startAgent();
server.listen(port, "0.0.0.0", () => {
  console.log(`Pi control server listening on :${port}; workspace=${workspaceDir}`);
});
