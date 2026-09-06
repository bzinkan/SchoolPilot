import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { selectRequestSchoolRole } from "../../services/schoolAuthorization.js";
import { getStudentBrowsingDomains, getStudentBrowsingHistory, type BrowsingHistoryRequest } from "../../services/classpilotBrowsingHistory.js";
const router=Router();
router.use(authenticate,requireSchoolContext,requireClasspilotEntitlement,requireRole("admin","school_admin","teacher"));
for(const [path,handler] of [["/:studentId/browsing-history",getStudentBrowsingHistory],["/:studentId/browsing-history/domains",getStudentBrowsingDomains]] as const){
  router.get(path,async(req,res,next)=>{try{
    const role=selectRequestSchoolRole(req,res,["admin","school_admin","teacher"]);
    if(role!=="admin"&&role!=="school_admin"&&role!=="teacher")return res.status(403).json({state:"denied",code:"HISTORY_DENIED",error:"School staff access is required."});
    const input:BrowsingHistoryRequest={schoolId:res.locals.schoolId!,actorId:req.authUser!.id,role,studentId:String(req.params.studentId),startDate:req.query.startDate,endDate:req.query.endDate,limit:req.query.limit,cursor:req.query.cursor};
    res.setHeader("Cache-Control","private, no-store");return res.json(await handler(input));
  }catch(error){const failure=error as Error&{status?:number;code?:string};if(failure.code==="HISTORY_DENIED")return res.status(failure.status||403).json({state:"denied",code:failure.code,error:failure.message});if(failure.code==="CLASSPILOT_STUDENT_DATA_UNAVAILABLE"||["42P01","42703","57014","53300","08006"].includes(failure.code||""))return res.status(503).json({state:"unavailable",code:"HISTORY_UNAVAILABLE",error:"Browsing history is temporarily unavailable. Try again."});next(error);}});
}
export default router;
