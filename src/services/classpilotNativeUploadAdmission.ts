import type { Request, RequestHandler, Response } from "express";
import { ClasspilotNativeError } from "./classpilotNativeProtocol.js";
import { NATIVE_REQUEST_BUDGET_MS, nativeRequestFailure } from "./classpilotNativeDiagnostics.js";

type Admission = { active: boolean; deadline: number; response: Response; expire: () => void };

/** Authenticated multipart uploads share two slots, with at most one per native session. */
export function createNativeUploadAdmission() {
  const sessions = new Set<string>();
  const admissions = new WeakMap<Request, Admission>();
  const discardImage = (req: Request) => { req.file?.buffer?.fill(0); };
  const expired = () => new ClasspilotNativeError("NATIVE_REQUEST_EXPIRED", 503);

  function admit(req: Request, res: Response, sessionKey: string, remainingMs: number): void {
    // Credential verification may have outlived the connection or request budget.
    if (req.aborted || res.destroyed || res.writableEnded || !Number.isFinite(remainingMs) || remainingMs <= 0) throw expired();
    if (sessions.size >= 2 || sessions.has(sessionKey)) throw new ClasspilotNativeError("NATIVE_UPLOAD_BUSY", 429);
    sessions.add(sessionKey);
    const duration = Math.min(NATIVE_REQUEST_BUDGET_MS, remainingMs);
    let timer: NodeJS.Timeout | undefined;
    const release = () => {
      if (!state.active) return;
      state.active = false;
      clearTimeout(timer);
      sessions.delete(sessionKey);
      req.removeListener("aborted", release);
      res.removeListener("finish", release);
      res.removeListener("close", release);
      discardImage(req);
    };
    const state: Admission = { active: true, deadline: performance.now() + duration, response: res, expire: () => {
      if (!state.active) return;
      nativeRequestFailure(expired());
      release();
      // Destroying the input makes Multer abort Busboy and its pending memory
      // storage. A socket inactivity timeout would be reset by trickled bytes.
      req.destroy();
      res.destroy();
    } };
    admissions.set(req, state);
    req.once("aborted", release);
    res.once("finish", release);
    res.once("close", release);
    timer = setTimeout(state.expire, duration);
    timer.unref();
  }

  function isActive(req: Request): boolean {
    const state = admissions.get(req);
    if (!state?.active) return false;
    if (req.aborted || state.response.destroyed || state.response.writableEnded || performance.now() >= state.deadline) {
      state.expire();
      return false;
    }
    return true;
  }

  function assertActive(req: Request): void {
    if (!isActive(req)) throw expired();
  }

  function guardParser(parser: RequestHandler): RequestHandler {
    return (req, res, next) => {
      if (!isActive(req)) return;
      let settled = false;
      const parsed = (error?: unknown) => {
        if (settled) return;
        settled = true;
        // Aborting the transport can settle Multer later. Never let that late
        // callback decode, publish, or attempt a second response.
        if (!isActive(req)) { discardImage(req); return; }
        next(error);
      };
      try { parser(req, res, parsed); } catch (error) { parsed(error); }
    };
  }

  return { admit, assertActive, guardParser };
}
