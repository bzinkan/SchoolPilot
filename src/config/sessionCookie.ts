import type { CookieOptions, Response } from "express";

export const SESSION_COOKIE_NAME = "schoolpilot.sid";
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionCookieName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.COOKIE_NAME || SESSION_COOKIE_NAME;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new Error("COOKIE_NAME must be a valid cookie name of at most 128 characters");
  }
  if (env.APP_ENV === "staging" && name === SESSION_COOKIE_NAME) {
    throw new Error("Staging sessions require a distinct COOKIE_NAME");
  }
  return name;
}

export function sessionCookieOptions(
  env: NodeJS.ProcessEnv = process.env
): CookieOptions {
  if (env.APP_ENV === "staging" && env.COOKIE_DOMAIN) {
    throw new Error("Staging session cookies must be host-only; leave COOKIE_DOMAIN empty");
  }
  return {
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/",
  };
}

export function clearSessionCookie(
  res: Pick<Response, "clearCookie">,
  env: NodeJS.ProcessEnv = process.env
): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(env);
  res.clearCookie(sessionCookieName(env), options);
}
