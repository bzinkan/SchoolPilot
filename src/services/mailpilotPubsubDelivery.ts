import type { RequestHandler } from "express";
import { safeCompare } from "../util/safeCompare.js";
import { validMailpilotHistoryId } from "./mailpilotNotification.js";

/** Injectable transport boundary: production acknowledgement and retry behavior are tested directly. */
export function createMailpilotPubsubPushHandler(options:{
  processNotification:(studentEmail:string,historyId:string)=>Promise<void>;
  verificationToken?:()=>string|undefined;
  onProcessingFailure?:()=>void;
}):RequestHandler {
  return async(req,res)=>{
    const verifyToken=(options.verificationToken??(()=>process.env.MAILPILOT_PUBSUB_VERIFY_TOKEN))();
    if(!verifyToken)return res.status(503).json({error:"not configured"});
    const header=req.header("authorization")||"";
    const headerOk=header.startsWith("Bearer ")&&safeCompare(header.slice(7),verifyToken);
    const queryToken=Array.isArray(req.query.token)?req.query.token[0]:req.query.token;
    const queryOk=typeof queryToken==="string"&&safeCompare(queryToken,verifyToken);
    if(!headerOk&&!queryOk)return res.status(401).json({error:"unauthorized"});
    const messageData=req.body?.message?.data;
    if(typeof messageData!=="string"||!messageData||messageData.length>65_536)return res.status(204).end();
    let decoded:{emailAddress?:unknown;historyId?:unknown}|null;
    try{decoded=JSON.parse(Buffer.from(messageData,"base64").toString("utf8"));}catch{return res.status(204).end();}
    const studentEmail=typeof decoded?.emailAddress==="string"?decoded.emailAddress.trim().toLowerCase():"";
    const historyId=typeof decoded?.historyId==="string"?decoded.historyId:
      typeof decoded?.historyId==="number"&&Number.isSafeInteger(decoded.historyId)?String(decoded.historyId):null;
    if(!studentEmail||studentEmail.length>254||!studentEmail.includes("@")||!validMailpilotHistoryId(historyId))return res.status(204).end();
    try{
      await options.processNotification(studentEmail,historyId);
      return res.status(204).end();
    }catch{
      // Diagnostics must neither leak provider details nor change retry delivery.
      try{options.onProcessingFailure?.();}catch{}
      return res.status(503).json({error:"processing incomplete",code:"MAILPILOT_RETRY_REQUIRED"});
    }
  };
}
