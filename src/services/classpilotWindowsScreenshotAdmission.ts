import express, { type Request, type RequestHandler } from "express";
import { ClasspilotNativeError } from "./classpilotNativeProtocol.js";
import { ClasspilotWindowsError, parseWindowsCredential } from "./classpilotWindowsProtocol.js";
import { assertWindowsRequestActive, beginWindowsRequestDiagnostics, WINDOWS_REQUEST_BUDGET_MS, windowsRequestRemainingMs } from "./classpilotWindowsDiagnostics.js";

export const WINDOWS_SCREENSHOT_JSON_BYTES=365_000;
export function isWindowsScreenshotRequest(req:Pick<Request,"method"|"path">){
  return req.method==="POST"&&/^\/api\/classpilot\/windows\/browser\/screenshot\/?$/i.test(req.path);
}

/** Header authentication precedes bounded buffering. Both body and later work
 * share the original absolute deadline; the router must not reset it. */
export function createWindowsScreenshotAdmission(options:{
  authenticate:(token:string)=>Promise<void>;
  parser?:RequestHandler;
  budgetMs?:number;
}):RequestHandler{
  const browsers=new Set<string>(),authenticating=new Set<string>();
  const parser=options.parser??express.raw({type:()=>true,inflate:false,limit:WINDOWS_SCREENSHOT_JSON_BYTES});
  return(req,res,next)=>{
    if(!isWindowsScreenshotRequest(req)){next();return;}
    const ingressElapsed=Math.max(0,Date.now()-(req.requestReceivedAtMs??Date.now()));
    beginWindowsRequestDiagnostics(req,res,()=>{
      let active=true,owned=false,key="",timer:NodeJS.Timeout|undefined;
      const duration=Math.min(WINDOWS_REQUEST_BUDGET_MS,options.budgetMs??WINDOWS_REQUEST_BUDGET_MS,windowsRequestRemainingMs());
      const deadline=performance.now()+duration;
      const discard=()=>{if(Buffer.isBuffer(req.body))req.body.fill(0);req.body=undefined;};
      const release=()=>{
        if(!active)return;
        active=false;clearTimeout(timer);if(owned)browsers.delete(key);
        req.removeListener("aborted",release);res.removeListener("finish",release);res.removeListener("close",release);
        discard();
      };
      const expire=()=>{if(!active)return;release();req.destroy();res.destroy();};
      const isActive=()=>{
        if(!active)return false;
        if(req.aborted||res.destroyed||res.writableEnded||performance.now()>=deadline){expire();return false;}
        try{assertWindowsRequestActive();return true;}catch{expire();return false;}
      };
      const fail=(error:unknown)=>{
        if(!isActive()){discard();return;}
        const failure=error instanceof ClasspilotWindowsError||error instanceof ClasspilotNativeError?error:
          new ClasspilotWindowsError(typeof error==="object"&&error!==null&&"type"in error&&error.type==="entity.too.large"?"WINDOWS_PAYLOAD_TOO_LARGE":"WINDOWS_INVALID_REQUEST",
            typeof error==="object"&&error!==null&&"type"in error&&error.type==="entity.too.large"?413:400);
        res.set({"Cache-Control":"no-store",Connection:"close"});
        res.status(failure.status).json({code:failure.code,error:"Windows browser upload refused"});
        // Stop incomplete request input after the refusal has been flushed.
        if(!req.complete)res.once("finish",()=>req.destroy());
      };
      req.once("aborted",release);res.once("finish",release);res.once("close",release);
      if(!Number.isFinite(duration)||duration<=0){expire();return;}
      timer=setTimeout(expire,duration);timer.unref();
      void(async()=>{
        const header=req.get("Authorization");
        if(!header||!/^Bearer [^\s]+$/i.test(header))throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
        const token=header.slice(7),credential=parseWindowsCredential(token,"browser");
        key=JSON.stringify([credential.schoolId,credential.id]);
        // This path precedes the general API limiter. Bound credential/tenant
        // work as well as buffered bodies, including rejected credentials.
        if(authenticating.size>=2||authenticating.has(key))throw new ClasspilotWindowsError("WINDOWS_UPLOAD_BUSY",429);
        authenticating.add(key);
        try{await options.authenticate(token);}catch(error){
          if(error instanceof ClasspilotWindowsError||error instanceof ClasspilotNativeError)throw error;
          throw new ClasspilotWindowsError("WINDOWS_UPLOAD_UNAVAILABLE",503);
        }finally{authenticating.delete(key);}
        // Only the authentication continuation releases that gate: an expired
        // transport must not admit more work while its DB check is still live.
        if(!isActive())return;
        if(browsers.size>=2||browsers.has(key))throw new ClasspilotWindowsError("WINDOWS_UPLOAD_BUSY",429);
        if(!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(req.get("Content-Type")??"")
          ||(req.get("Content-Encoding")??"identity").toLowerCase()!=="identity")throw new ClasspilotWindowsError("WINDOWS_INVALID_REQUEST",415);
        const contentLength=req.get("Content-Length");
        if(contentLength!==undefined&&(!/^\d+$/.test(contentLength)||Number(contentLength)>WINDOWS_SCREENSHOT_JSON_BYTES))throw new ClasspilotWindowsError("WINDOWS_PAYLOAD_TOO_LARGE",413);
        browsers.add(key);owned=true;
        let settled=false;
        const parsed=(error?:unknown)=>{
          if(settled){if(!active)discard();return;}
          settled=true;
          if(!isActive()){discard();return;}
          if(error){fail(error);return;}
          const buffer:unknown=req.body;
          if(!Buffer.isBuffer(buffer)){fail(new ClasspilotWindowsError("WINDOWS_INVALID_REQUEST",400));return;}
          try{
            if(buffer.length>WINDOWS_SCREENSHOT_JSON_BYTES)throw new ClasspilotWindowsError("WINDOWS_PAYLOAD_TOO_LARGE",413);
            const value:unknown=JSON.parse(buffer.toString("utf8"));
            if(!value||typeof value!=="object"||Array.isArray(value))throw new ClasspilotWindowsError("WINDOWS_INVALID_REQUEST",400);
            req.body=value;
          }catch(error){fail(error);return;}
          finally{buffer.fill(0);}
          if(isActive())next();
        };
        try{parser(req,res,parsed);}catch(error){parsed(error);}
      })().catch(fail);
    },performance.now()-ingressElapsed);
  };
}
