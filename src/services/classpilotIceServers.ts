import crypto from "crypto";

export const CLASSPILOT_TURN_CREDENTIAL_TTL_SECONDS = 10 * 60;

export type ClasspilotIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

function configuredHosts(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(String(env.CLASSPILOT_TURN_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value)))];
}

function configuredStunUrls(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(String(env.CLASSPILOT_STUN_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^stuns?:[^\s]{1,500}$/i.test(value)))];
}

/** Creates coturn REST credentials without embedding school/student/device IDs. */
export function createClasspilotIceConfiguration(options: {
  negotiationId: string;
  negotiationExpiresAt: number;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): { expiresAt: string; iceServers: ClasspilotIceServer[] } | null {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const secret = String(env.CLASSPILOT_TURN_REST_SECRET || "");
  const hosts = configuredHosts(env);
  if (!secret || hosts.length < 2 || options.negotiationExpiresAt <= now) return null;

  const expiresAtMs = Math.min(
    options.negotiationExpiresAt,
    now + CLASSPILOT_TURN_CREDENTIAL_TTL_SECONDS * 1_000
  );
  const expiry = Math.floor(expiresAtMs / 1_000);
  const negotiationDigest = crypto
    .createHmac("sha256", secret)
    .update(options.negotiationId)
    .digest("base64url")
    .slice(0, 32);
  const username = `${expiry}:${negotiationDigest}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  const iceServers: ClasspilotIceServer[] = [];
  const stunUrls = configuredStunUrls(env);
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });
  for (const host of hosts) {
    iceServers.push({
      urls: [
        `turn:${host}:3478?transport=udp`,
        `turn:${host}:3478?transport=tcp`,
        `turns:${host}:443?transport=tcp`,
      ],
      username,
      credential,
    });
  }
  return { expiresAt: new Date(expiresAtMs).toISOString(), iceServers };
}
