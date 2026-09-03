const baseUrl = process.argv[2] || "http://127.0.0.1:3000";

const healthResponse = await fetch(`${baseUrl}/healthz`);
if (!healthResponse.ok) throw new Error(`health check failed: ${healthResponse.status}`);

const health = await healthResponse.json();
if (health.status !== "ok") throw new Error("health response is not ok");

const pageResponse = await fetch(`${baseUrl}/`);
if (!pageResponse.ok) throw new Error(`page request failed: ${pageResponse.status}`);

const page = await pageResponse.text();
for (const marker of ["data-transcript", "data-composer", "data-send", "data-agent-status"]) {
  if (!page.includes(marker)) throw new Error(`required UI marker missing: ${marker}`);
}

const stateResponse = await fetch(`${baseUrl}/api/state`);
if (!stateResponse.ok) throw new Error(`Pi state request failed: ${stateResponse.status}`);

const state = await stateResponse.json();
if (!Object.hasOwn(state, "isStreaming")) throw new Error("Pi state is missing isStreaming");

console.log("Pi control and Web UI acceptance checks passed.");
