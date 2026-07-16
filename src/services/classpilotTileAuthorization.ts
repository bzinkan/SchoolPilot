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

export const CLASSPILOT_TILE_AUTHORIZATION_MAX_PENDING_MS = 2_000;
const MAX_AUTHORIZATION_SNAPSHOTS = 1_000;

export type TileAuthorizationMode = "live" | "history";

export type TileAuthorizationRequest = ClassPilotTileScopeOptions & {
  sessionScope: string;
};

type ScopeLoader = (
  request: TileAuthorizationRequest,
  mode: TileAuthorizationMode
) => Promise<ClassPilotTileAuthorizationScope>;

type PendingScope = {
  deadlineAt: number;
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
  options: { maxPendingMs?: number; now?: () => number } = {}
) {
  const maxPendingMs =
    options.maxPendingMs ?? CLASSPILOT_TILE_AUTHORIZATION_MAX_PENDING_MS;
  const now = options.now ?? Date.now;
  const pendingScopes = new Map<string, PendingScope>();

  async function authorize(
    request: TileAuthorizationRequest,
    deviceId: string,
    mode: TileAuthorizationMode
  ): Promise<ClassPilotHistoryTileAccess | undefined> {
    const key = authorizationKey(request, mode);
    const currentTime = now();
    const pending = pendingScopes.get(key);
    if (pending && pending.deadlineAt > currentTime) {
      recordHeartbeatHotPathCounter(
        mode === "live" ? "tileAuthCoalescedLive" : "tileAuthCoalescedHistory"
      );
      return (await pending.promise).get(deviceId);
    }
    if (pending && pendingScopes.get(key) === pending) pendingScopes.delete(key);

    if (pendingScopes.size >= MAX_AUTHORIZATION_SNAPSHOTS) {
      const oldestKey = pendingScopes.keys().next().value;
      if (oldestKey) pendingScopes.delete(oldestKey);
    }
    const startedAt = now();
    const promise = Promise.resolve()
      .then(() => loader(request, mode))
      .then((scope) => {
        recordHeartbeatHotPathCounter(
          mode === "live" ? "tileAuthScopeLoadsLive" : "tileAuthScopeLoadsHistory"
        );
        recordHeartbeatHotPathTiming(
          mode === "live" ? "tileAuthLiveMs" : "tileAuthHistoryMs",
          Math.max(0, now() - startedAt)
        );
        return scope;
      });
    const pendingLoad = {
      deadlineAt: currentTime + maxPendingMs,
      promise,
    };
    pendingScopes.set(key, pendingLoad);
    void promise.then(
      () => {
        if (pendingScopes.get(key) === pendingLoad) pendingScopes.delete(key);
      },
      () => {
        if (pendingScopes.get(key) === pendingLoad) pendingScopes.delete(key);
      }
    );
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
