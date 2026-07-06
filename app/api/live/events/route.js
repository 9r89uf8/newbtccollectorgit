import { getSnapshotFallback, LIVE_COLLECTOR_URL, withPriceToBeatFallback } from "../liveData.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function encodeSnapshot(snapshot) {
  return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

async function encodeEnrichedEvent(eventText) {
  const data = eventText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) return `${eventText}\n\n`;

  try {
    const snapshot = await withPriceToBeatFallback(JSON.parse(data));
    return encodeSnapshot(snapshot);
  } catch {
    return `${eventText}\n\n`;
  }
}

function enrichedCollectorStream(body) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader = null;

  return new ReadableStream({
    async start(controller) {
      reader = body.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let separator = buffer.indexOf("\n\n");
          while (separator !== -1) {
            const eventText = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            controller.enqueue(encoder.encode(await encodeEnrichedEvent(eventText)));
            separator = buffer.indexOf("\n\n");
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(await encodeEnrichedEvent(buffer)));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
}

function fallbackStream(initialMessage) {
  const encoder = new TextEncoder();
  let stopped = false;
  let timer = null;

  const stream = new ReadableStream({
    async start(controller) {
      async function send() {
        if (stopped) return;
        const snapshot = await getSnapshotFallback(initialMessage);
        controller.enqueue(encoder.encode(encodeSnapshot(snapshot)));
      }

      await send();
      timer = setInterval(() => {
        send().catch((error) => {
          controller.enqueue(encoder.encode(encodeSnapshot({
            ok: false,
            degraded: true,
            error: error.message || String(error),
            collector: {
              snapshotTs: new Date().toISOString(),
              staleSources: ["collector_api"],
            },
          })));
        });
      }, 1000);
    },
    cancel() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(),
  });
}

export async function GET(request) {
  try {
    const response = await fetch(`${LIVE_COLLECTOR_URL}/events`, {
      cache: "no-store",
      headers: { accept: "text/event-stream" },
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      return fallbackStream(`collector returned HTTP ${response.status}`);
    }

    return new Response(enrichedCollectorStream(response.body), {
      status: 200,
      headers: sseHeaders(),
    });
  } catch (error) {
    return fallbackStream(error.message || String(error));
  }
}
