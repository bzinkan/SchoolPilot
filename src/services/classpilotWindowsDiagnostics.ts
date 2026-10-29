import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler, Response, NextFunction } from "express";
import { ClasspilotWindowsError } from "./classpilotWindowsProtocol.js";
export const WINDOWS_REQUEST_BUDGET_MS=4_000;
type RequestState={started:number;disconnected:boolean};
const context=new AsyncLocalStorage<RequestState>();
const requests=new WeakMap<Request,RequestState>();
export function withoutWindowsRequest<T>(action:()=>T):T{return context.exit(action);}
export function windowsRequestRemainingMs(){const state=context.getStore();return state?Math.max(0,WINDOWS_REQUEST_BUDGET_MS-(performance.now()-state.started)):WINDOWS_REQUEST_BUDGET_MS;}
export function assertWindowsRequestActive(){if(context.getStore()?.disconnected||windowsRequestRemainingMs()<=0)throw new ClasspilotWindowsError("WINDOWS_REQUEST_EXPIRED",503);}
/** Bounded work and content-free diagnostics; never log credentials or paths. */
export function beginWindowsRequestDiagnostics(req:Request,res:Response,next:NextFunction,started=performance.now()){
  const previous=requests.get(req);if(previous){context.run(previous,next);return;}
  const state={started,disconnected:false};requests.set(req,state);let finished=false;
  const complete=()=>{if(finished)return;finished=true;state.disconnected=!res.writableFinished;const elapsed=Math.round(performance.now()-state.started);
    if(res.statusCode>=500||elapsed>=1000)console.info(JSON.stringify({event:"classpilot_windows_request",status:res.statusCode,milliseconds:elapsed,outcome:state.disconnected?"disconnected":"completed"}));};
  res.once("finish",complete);res.once("close",complete);context.run(state,next);
}
export const windowsRequestDiagnostics:RequestHandler=(req,res,next)=>beginWindowsRequestDiagnostics(req,res,next);
