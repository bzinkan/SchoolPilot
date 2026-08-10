import type { CookieOptions, Response } from "express";

export const SESSION_COOKIE_NAME = "schoolpilot.sid";
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionCookieOptions(
  env: NodeJS.ProcessEnv = process.env
): CookieOptions {
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
  res.clearCookie(SESSION_COOKIE_NAME, options);
}
