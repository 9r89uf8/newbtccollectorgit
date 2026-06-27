import { performance } from "node:perf_hooks";

export async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, { signal: controller.signal });
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
