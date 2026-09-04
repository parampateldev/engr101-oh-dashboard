const ALLOWED_ORIGINS = new Set([
  "https://parampateldev.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
]);

const QUEUE_URL =
  "https://eecsoh.eecs.umich.edu/api/queues/1xHcWfn2KW5HHly5Y3rLA2g5kW2";

function corsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.has(origin) ||
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("http://localhost:");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://parampateldev.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    const upstream = await fetch(QUEUE_URL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
