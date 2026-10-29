/** Only browser images from the same exact source, page and control authority can become browser evidence. */
export function windowsBrowserEvidenceEligible(image:Record<string,unknown>|null,observation:{sourceRef:string;bindingRevision:number;url:string;controlRevision:number;observedAt:number},now=Date.now()):boolean{
  if(!image||image.sourceRef!==observation.sourceRef||image.bindingRevision!==observation.bindingRevision||image.controlRevision!==observation.controlRevision||image.tabUrl!==observation.url)return false;
  const captured=Date.parse(String(image.screenshotAt)),expiry=Date.parse(String(image.expiresAt));
  return Number.isFinite(captured)&&Number.isFinite(expiry)&&captured<=now+1000&&now-captured<=45_000&&expiry>now
    &&Math.abs(captured-observation.observedAt)<=5000&&typeof image.screenshot==="string"&&image.screenshot.startsWith("data:image/jpeg;base64,");
}
