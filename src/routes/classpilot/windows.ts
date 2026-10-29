import { windowsRequestDiagnostics } from "../../services/classpilotWindowsDiagnostics.js";
import { Router, type Request, type Response, type RequestHandler } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { runWithoutTenantContext } from "../../db/tenantContext.js";
import { ClasspilotNativeError } from "../../services/classpilotNativeProtocol.js";
import { ClasspilotWindowsError, windowsPairProofSchema, windowsPairSchema, windowsTileSchema, windowsCommandSchema, windowsSourceSchema } from "../../services/classpilotWindowsProtocol.js";
import { issueWindowsEnrollment,enrollWindowsInstallation,signInWindowsGuard,renewWindowsGuard,signOutWindowsGuard,issueWindowsPairingProof,pairWindowsBrowser,windowsHeartbeat,acceptWindowsScreenshot,windowsTiles,dispatchWindowsCommand,windowsCommandOutcome,windowsCommandAcks } from "../../services/classpilotWindows.js";
import { windowsBrowserAction } from "../../services/classpilotWindowsActions.js";
import { scheduleWindowsClassification } from "../../services/classpilotWindowsClassification.js";
import { revokeWindowsInstallation } from "../../services/classpilotWindows.js";

import windowsHistoryRouter from "./windowsHistory.js";
const router=Router();
router.use(windowsRequestDiagnostics);
router.use(windowsHistoryRouter);
const releaseStaffContext:RequestHandler=(_req,res,next)=>{void Promise.resolve(res.locals.releaseTenantContext?.()).then(()=>runWithoutTenantContext(()=>next()),next);};
const staff=[authenticate,requireSchoolContext,requireActiveSchool,requireClasspilotEntitlement,requireRole("admin","school_admin","teacher","office_staff"),releaseStaffContext] as const;
const scope=(req:Request,res:Response)=>({schoolId:res.locals.schoolId!,actorId:req.authUser!.id,authVersion:req.authUser!.authVersion,contextAuthorityRevision:req.get("X-ClassPilot-Context-Authority-Revision")});
function bearer(req:Request){const value=req.get("Authorization");if(!value||!/^Bearer [^\s]+$/i.test(value))throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);return value.slice(7);}
function endpoint(action:RequestHandler):RequestHandler{return(req,res,next)=>{void Promise.resolve().then(()=>action(req,res,next)).catch(error=>{
  if(res.headersSent||res.writableEnded||res.destroyed)return next(error);
  if(error instanceof z.ZodError)return res.status(400).json({code:"WINDOWS_INVALID_REQUEST",error:"Invalid Windows browser request"});
  if(error instanceof ClasspilotWindowsError||error instanceof ClasspilotNativeError)return res.status(error.status).json({code:error.code,error:error.message});
  if(error?.status&&error?.code)return res.status(error.status).json({code:error.code,error:"Windows browser operation refused"});
  return next(error);
}).catch(next);};}
router.use((_req,res,next)=>{res.set({"Cache-Control":"no-store",Pragma:"no-cache"});next();});
router.post("/enrollment-tokens",...staff,requireRole("admin","school_admin"),endpoint(async(req,res)=>{z.object({}).strict().parse(req.body??{});res.status(201).json(await issueWindowsEnrollment(scope(req,res)));}));
router.delete("/installations/:installationId",...staff,requireRole("admin","school_admin"),endpoint(async(req,res)=>{await revokeWindowsInstallation(scope(req,res),z.string().uuid().parse(req.params.installationId));res.status(204).end();}));
router.post("/enroll",endpoint(async(req,res)=>{const input=z.object({enrollmentToken:z.string().max(600),clientVersion:z.string().min(1).max(40).regex(/^[A-Za-z0-9_.+-]+$/)}).strict().parse(req.body);res.status(201).json(await enrollWindowsInstallation(input,req.ip??"unknown"));}));
router.post("/guards",endpoint(async(req,res)=>{const input=z.object({identifier:z.string().trim().min(1).max(200),pin:z.string().regex(/^\d{4}$/),osSessionNonce:z.string().uuid()}).strict().parse(req.body);res.status(201).json(await signInWindowsGuard(bearer(req),input,req.ip??"unknown"));}));
router.post("/guards/renew",endpoint(async(req,res)=>{const input=z.object({osSessionNonce:z.string().uuid()}).strict().parse(req.body);res.json(await renewWindowsGuard(bearer(req),input.osSessionNonce));}));
router.delete("/guards",endpoint(async(req,res)=>{z.object({}).strict().parse(req.body??{});await signOutWindowsGuard(bearer(req));res.status(204).end();}));
router.post("/guards/pairing-proofs",endpoint(async(req,res)=>{res.status(201).json(await issueWindowsPairingProof(bearer(req),windowsPairProofSchema.parse(req.body)));}));
router.post("/browser/pair",endpoint(async(req,res)=>{res.status(201).json(await pairWindowsBrowser(windowsPairSchema.parse(req.body),req.ip??"unknown"));}));
router.post("/browser/heartbeat",endpoint(async(req,res)=>{if(Buffer.byteLength(JSON.stringify(req.body))>131_072)throw new ClasspilotWindowsError("WINDOWS_PAYLOAD_TOO_LARGE",413);const token=bearer(req),input=z.record(z.string(),z.unknown()).parse(req.body);res.json(await windowsHeartbeat(token,input));scheduleWindowsClassification(token,input);}));
router.post("/browser/screenshot",endpoint(async(req,res)=>{if(Buffer.byteLength(JSON.stringify(req.body))>365_000)throw new ClasspilotWindowsError("WINDOWS_PAYLOAD_TOO_LARGE",413);res.json(await acceptWindowsScreenshot(bearer(req),z.record(z.string(),z.unknown()).parse(req.body)));}));
router.post("/browser/command-acks",endpoint(async(req,res)=>{if(Buffer.byteLength(JSON.stringify(req.body))>32_768)throw new ClasspilotWindowsError("WINDOWS_PAYLOAD_TOO_LARGE",413);res.json(await windowsCommandAcks(bearer(req),z.record(z.string(),z.unknown()).parse(req.body)));}));
router.post("/browser/action",endpoint(async(req,res)=>{if(Buffer.byteLength(JSON.stringify(req.body))>131_072)throw new ClasspilotWindowsError("WINDOWS_PAYLOAD_TOO_LARGE",413);const input=windowsSourceSchema.extend({operation:z.string().min(1).max(80),payload:z.record(z.string(),z.unknown())}).strict().parse(req.body);res.json(await windowsBrowserAction(bearer(req),input));}));
router.post("/tiles",...staff,endpoint(async(req,res)=>{res.json(await windowsTiles(scope(req,res),windowsTileSchema.parse(req.body)));}));
router.post("/commands",...staff,endpoint(async(req,res)=>{res.status(201).json(await dispatchWindowsCommand(scope(req,res),windowsCommandSchema.parse(req.body)));}));
router.get("/commands/:commandId",...staff,endpoint(async(req,res)=>{const input=z.object({teachingSessionId:z.string().min(1).max(200).optional(),supervisionContextId:z.string().min(1).max(200).optional()}).strict().refine(x=>Boolean(x.teachingSessionId)!==Boolean(x.supervisionContextId)).parse(req.query);res.json(await windowsCommandOutcome(scope(req,res),z.string().uuid().parse(req.params.commandId),input));}));
export default router;
