import type { EmailSendResult, EmailSendOptions } from "./email.js";

/** A timeout cannot establish whether the provider accepted the message. Never retry it blindly. */
export async function sendSafetyEmailBounded(
  send:(message:EmailSendOptions)=>Promise<EmailSendResult>,message:EmailSendOptions,timeoutMs=15_000,
):Promise<EmailSendResult> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(()=>send(message)).catch(():EmailSendResult=>({status:'unknown',error:'SAFETY_EMAIL_TRANSPORT_EXCEPTION'})),
      new Promise<EmailSendResult>(resolve=>{timer=setTimeout(()=>resolve({status:'unknown',error:'SAFETY_EMAIL_TRANSPORT_TIMEOUT'}),timeoutMs);}),
    ]);
  } finally {if(timer)clearTimeout(timer);}
}
