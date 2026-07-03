import { performance } from "node:perf_hooks";

async function requestJson(url, { timeoutMs, method = "GET", body = undefined } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const headers = body === undefined ? undefined : { "content-type": "application/json" };
    const response = await fetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return {
      data: await response.json(),
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson(url, timeoutMs) {
  return requestJson(url, { timeoutMs });
}

export async function postJson(url, body, timeoutMs) {
  return requestJson(url, { timeoutMs, method: "POST", body });
}