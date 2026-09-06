import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { listSafetyCases,getSafetyReport,safetyUnreviewedCount,reviewSafetyAlert,updateSafetyCase,listSafetyUrlExceptions,revokeSafetyUrlException,blockSafetyWebsite } from "../../services/safetyCenter.js";

const router=Router();
router.use(authenticate,requireSchoolContext,requireClasspilotEntitlement,requireRole('admin','school_admin'));
const revision=z.number().int().nonnegative();
const actor=(req:any,res:any)=>String(res.locals.userId||req.authUser?.id||req.session?.userId||'');
const school=(res:any)=>String(res.locals.schoolId);
router.get('/count',async(_req,res,next)=>{try {res.json({count:await safetyUnreviewedCount(school(res))});}catch(e){next(e);}});
router.get('/cases',async(req,res,next)=>{try {
  const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
  const q=z.object({status:z.enum(['open','closed']).optional(),review:z.enum(['reviewed','unreviewed']).optional(),studentId:z.string().optional(),student:z.string().max(120).optional(),from:date.optional(),to:date.optional(),cursor:z.string().max(1000).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).parse(req.query);
  res.json(await listSafetyCases(school(res),q));
}catch(e){next(e);}});
router.get('/cases/:id',async(req,res,next)=>{try {
  const query=z.object({alertCursor:z.string().max(1000).optional(),eventCursor:z.string().max(1000).optional(),limit:z.coerce.number().int().min(1).max(200).optional()}).parse(req.query);
  res.json(await getSafetyReport(school(res),String(req.params.id),query));
}catch(e){next(e);}});
router.post('/cases/:id/actions',async(req,res,next)=>{try {
  const body=z.object({revision,action:z.enum(['acknowledge','assign','close','note']),assignedTo:z.string().nullable().optional(),note:z.string().max(2000).optional()}).parse(req.body);
  res.json(await updateSafetyCase({...body,schoolId:school(res),caseId:String(req.params.id),actorId:actor(req,res)}));
}catch(e){next(e);}});
router.post('/alerts/:id/review',async(req,res,next)=>{try {
  const body=z.object({revision,action:z.enum(['review','suppress']),note:z.string().max(2000).optional()}).parse(req.body);
  res.json(await reviewSafetyAlert({...body,schoolId:school(res),alertId:String(req.params.id),actorId:actor(req,res)}));
}catch(e){next(e);}});
router.post('/alerts/:id/block-website',async(req,res,next)=>{try {
  const body=z.object({revision,policyRevision:revision,note:z.string().max(2000).optional()}).parse(req.body);
  res.json(await blockSafetyWebsite({...body,schoolId:school(res),alertId:String(req.params.id),actorId:actor(req,res)}));
}catch(e){next(e);}});
router.get('/approved-urls',async(req,res,next)=>{try {const cursor=z.string().max(1000).optional().parse(req.query.cursor);res.json(await listSafetyUrlExceptions(school(res),cursor));}catch(e){next(e);}});
router.delete('/approved-urls/:id',async(req,res,next)=>{try {await revokeSafetyUrlException(school(res),String(req.params.id),actor(req,res));res.json({ok:true});}catch(e){next(e);}});
router.use(((err,_req,res,next)=>{
  if(err instanceof z.ZodError) {res.status(400).json({error:'Invalid request',issues:err.issues.map(issue=>({path:issue.path,message:issue.message}))});return;}
  next(err);
}) satisfies ErrorRequestHandler);
export default router;
