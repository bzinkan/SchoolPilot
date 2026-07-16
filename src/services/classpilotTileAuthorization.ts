import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getTileAuthorizationScopeForStaff,
  type ClassPilotHistoryTileAccess,
  type ClassPilotTileAuthorizationScope,
  type ClassPilotTileReadRole,
  type ClassPilotTileScopeOptions,
} from "./storage.js";
import {
  recordHeartbeatHotPathCounter,
  recordHeartbeatHotPathTiming,
} from "./heartbeatHotPathMetrics.js";

export const CLASSPILOT_TILE_AUTHORIZATION_TTL_MS = 2_000;
const MAX_AUTHORIZATION_SNAPSHOTS = 1_000;

export type TileAuthorizationMode = "live" | "history";

export type TileAuthorizationRequest = ClassPilotTileScopeOptions & {
  sessionScope: string;
};

type ScopeLoader = (
  request: TileAuthorizationRequest,
  mode: TileAuthorizationMode
) => Promise<ClassPilotTileAuthorizationScope>;

type CachedScope = {
  expiresAt: number;
  promise: Promise<ClassPilotTileAuthorizationScope>;
};

function authorizationKey(
  request: TileAuthorizationRequest,
  mode: TileAuthorizationMode
): string {
  return [
    request.schoolId,
    request.staffId,
    request.role,
    request.isSuperAdmin ? "super" : "member",
    request.sessionScope,
    mode,
  ].join("\u0000");
}

export function createClassPilotTileAuthorizationCoalescer(
  loader: ScopeLoader,
  options: { ttlMs?: number; now?: () => number } = {}
) {
  const ttlMs = options.ttlMs ?? CLASSPILOT_TILE_AUTHORIZATION_TTL_MS;
  const now = options.now ?? Date.now;
  const cachedScopes = new Map<string, CachedScope>();

  async function authorize(
    request: TileAuthorizationRequest,
    deviceId: string,
    mode: TileAuthorizationMode
  ): Promise<ClassPilotHistoryTileAccess | undefined> {
    const key = authorizationKey(request, mode);
    const currentTime = now();
    let cached = cachedScopes.get(key);
    if (cached && cached.expiresAt > currentTime) {
      recordHeartbeatHotPathCounter(
        mode === "live" ? "tileAuthCoalescedLive" : "tileAuthCoalescedHistory"
      );
      return (await cached.promise).get(deviceId);
    }
    if (cached) cachedScopes.delete(key);

    if (cachedScopes.size >= MAX_AUTHORIZATION_SNAPSHOTS) {
      const oldestKey = cachedScopes.keys().next().value;
      if (oldestKey) cachedScopes.delete(oldestKey);
    }
    const startedAt = now();
    const promise = loader(request, mode)
      .then((scope) => {
        recordHeartbeatHotPathCounter(
          mode === "live" ? "tileAuthScopeLoadsLive" : "tileAuthScopeLoadsHistory"
        );
        recordHeartbeatHotPathTiming(
          mode === "live" ? "tileAuthLiveMs" : "tileAuthHistoryMs",
          Math.max(0, now() - startedAt)
        );
        return scope;
      })
      .catch((error) => {
        cachedScopes.delete(key);
        throw error;
      });
    cached = { expiresAt: currentTime + ttlMs, promise };
    cachedScopes.set(key, cached);
    return (await promise).get(deviceId);
  }

  return { authorize };
}

const tileAuthorizationCoalescer = createClassPilotTileAuthorizationCoalescer(
  (request, mode) =>
    runWithTenantContext({ schoolId: request.schoolId }, () =>
      getTileAuthorizationScopeForStaff(
        {
          schoolId: request.schoolId,
          staffId: request.staffId,
          role: request.role,
          isSuperAdmin: request.isSuperAdmin,
        },
        mode
      )
    )
);

export async function getCoalescedTileAuthorization(
  request: {
    schoolId: string;
    staffId: string;
    role: ClassPilotTileReadRole;
    isSuperAdmin?: boolean;
    sessionScope: string;
  },
  deviceId: string,
  mode: TileAuthorizationMode
): Promise<ClassPilotHistoryTileAccess | undefined> {
  return tileAuthorizationCoalescer.authorize(request, deviceId, mode);
}
