export type ApiRateLimitRequestLike = {
  method?: string;
  originalUrl?: string;
  url?: string;
  path?: string;
};

const DEVICE_SCOPED_API_LIMIT_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/(?:classpilot\/)?device\/heartbeat$/ },
  { method: "POST", path: /^\/(?:classpilot\/)?device\/screenshot$/ },
  { method: "POST", path: /^\/(?:classpilot\/)?device\/event$/ },
  { method: "GET", path: /^\/(?:classpilot\/)?device\/[^/]+\/students$/ },
  { method: "POST", path: /^\/(?:classpilot\/)?device\/[^/]+\/active-student$/ },
  { method: "POST", path: /^\/(?:classpilot\/)?extension\/runtime-error$/ },
];

function normalizedApiPath(req: ApiRateLimitRequestLike): string {
  const raw = req.originalUrl || req.url || req.path || "/";
  const path = raw.split("?")[0] || "/";
  if (path === "/api") return "/";
  if (path.startsWith("/api/")) return path.slice("/api".length);
  return path;
}

export function usesDeviceScopedApiLimit(req: ApiRateLimitRequestLike): boolean {
  const method = (req.method || "GET").toUpperCase();
  const path = normalizedApiPath(req);
  return DEVICE_SCOPED_API_LIMIT_ROUTES.some(
    (route) => route.method === method && route.path.test(path)
  );
}
