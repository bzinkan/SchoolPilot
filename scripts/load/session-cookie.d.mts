export function loadSessionCookieName(env?: NodeJS.ProcessEnv): string;
export function hasLoadSessionCookie(header: unknown, name?: string): boolean;
export function loadSessionCookieFromHeaders(headers: { getSetCookie?(): string[]; get(name: string): string | null }, name?: string): string;
