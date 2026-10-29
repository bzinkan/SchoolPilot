import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request, type ClientRequest } from "node:http";
import { test } from "node:test";
import express, { type Request, type RequestHandler } from "express";
import { createWindowsScreenshotAdmission, WINDOWS_SCREENSHOT_JSON_BYTES } from "../src/services/classpilotWindowsScreenshotAdmission.js";
import { ClasspilotWindowsError, createWindowsCredential } from "../src/services/classpilotWindowsProtocol.js";
import { assertWindowsRequestActive, windowsRequestDiagnostics, windowsRequestRemainingMs } from "../src/services/classpilotWindowsDiagnostics.js";

const path="/api/classpilot/windows/browser/screenshot";
const body=JSON.stringify({screenshot:"data:image/jpeg;base64,/9j/2Q==",sequence:1});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

async function fixture(options:{budgetMs?:number;authGate?:ReturnType<typeof deferred>;workGate?:ReturnType<typeof deferred>;holdParser?:boolean;authDenied?:boolean}={}){
  const tokens=new Map(["a","b","c"].map(label=>[label,createWindowsCredential("browser","test-school").credential]));
  const events=new EventEmitter(),clients=new Set<ClientRequest>();
  const authenticating=new Set<string>(),parsing=new Map<string,Request>(),finished=new Set<string>();
  const buffers:Buffer[]=[],callbacks:Array<()=>void>=[],decoded:string[]=[],published:string[]=[],remaining:number[]=[];
  let generalParses=0;
  const labelFor=(req:Request)=>[...tokens].find(([,token])=>req.get("Authorization")===`Bearer ${token}`)?.[0]??"unknown";
  const app=express();
  app.use((req,res,next)=>{
    req.requestReceivedAtMs=Date.now();
    const label=labelFor(req);
    const close=()=>{finished.add(label);events.emit(`finished:${label}`);};
    res.once("close",close);res.once("finish",close);next();
  });
  const raw=express.raw({type:()=>true,inflate:false,limit:WINDOWS_SCREENSHOT_JSON_BYTES});
  const parser:RequestHandler=(req,res,next)=>{
    const label=labelFor(req);parsing.set(label,req);events.emit(`parsing:${label}`);
    raw(req,res,error=>{
      if(Buffer.isBuffer(req.body))buffers.push(req.body);
      if(options.holdParser){callbacks.push(()=>next(error));events.emit("parser-callback");}
      else next(error);
    });
  };
  app.use(createWindowsScreenshotAdmission({budgetMs:options.budgetMs,parser,authenticate:async token=>{
    const label=[...tokens].find(([,value])=>value===token)?.[0];
    if(!label)throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
    authenticating.add(label);events.emit(`auth:${label}`);
    await options.authGate?.promise;
    if(options.authDenied)throw new ClasspilotWindowsError("WINDOWS_NOT_ENABLED",404);
  }}));
  app.use(express.json({verify:(_req,_res,buffer)=>{generalParses++;buffers.push(buffer);}}));
  app.post(path,windowsRequestDiagnostics,(req,res)=>{
    void(async()=>{
      assertWindowsRequestActive();remaining.push(windowsRequestRemainingMs());
      const label=labelFor(req);decoded.push(label);events.emit(`decoded:${label}`);
      assert.equal(req.body.sequence,1);
      await options.workGate?.promise;
      assertWindowsRequestActive();published.push(label);res.status(201).json({ok:true});
    })().catch(()=>{if(!res.destroyed&&!res.writableEnded)res.status(503).json({code:"WINDOWS_REQUEST_EXPIRED"});});
  });
  app.post("/stripe",(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const port=address.port;
  function start(label="a",overrides:{token?:string;path?:string;type?:string;length?:number;encoding?:string}={}){
    let settle!:(value:{status:number;body:string})=>void;
    const done=new Promise<{status:number;body:string}>(resolve=>{settle=resolve;});
    const headers:Record<string,string>={Authorization:`Bearer ${overrides.token??tokens.get(label)}`,"Content-Type":overrides.type??"application/json"};
    if(overrides.length!==undefined)headers["Content-Length"]=String(overrides.length);else headers["Transfer-Encoding"]="chunked";
    if(overrides.encoding)headers["Content-Encoding"]=overrides.encoding;
    const client=request({hostname:"127.0.0.1",port,path:overrides.path??path,method:"POST",headers},response=>{
      let text="";response.setEncoding("utf8");response.on("data",chunk=>{text+=chunk;});
      response.on("end",()=>settle({status:response.statusCode??0,body:text}));response.on("error",()=>settle({status:0,body:""}));
    });
    client.on("error",()=>settle({status:0,body:""}));client.on("close",()=>{clients.delete(client);settle({status:0,body:""});});
    clients.add(client);return {client,done};
  }
  const wait=async(event:string,ready:()=>boolean)=>{if(!ready())await once(events,event);};
  return {tokens,authenticating,parsing,buffers,callbacks,decoded,published,remaining,start,events,
    generalParses:()=>generalParses,
    send:async(label="a",bytes=body,overrides:Parameters<typeof start>[1]={})=>{const upload=start(label,overrides);upload.client.end(bytes);return upload.done;},
    waitAuth:(label:string)=>wait(`auth:${label}`,()=>authenticating.has(label)),
    waitParsing:(label:string)=>wait(`parsing:${label}`,()=>parsing.has(label)),
    waitFinished:(label:string)=>wait(`finished:${label}`,()=>finished.has(label)),
    waitCallback:()=>wait("parser-callback",()=>callbacks.length>0),
    waitDecoded:(label:string)=>wait(`decoded:${label}`,()=>decoded.includes(label)),
    close:async()=>{
      for(const client of clients)client.destroy();options.authGate?.resolve();options.workGate?.resolve();
      for(const callback of callbacks.splice(0))callback();server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }};
}

test("Windows screenshot admission authenticates browser purpose before reading JSON and preserves other raw-body paths",{timeout:10_000},async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.send("a","not-json",{token:createWindowsCredential("guard","test-school").credential})).status,401);
    assert.equal(f.authenticating.size,0);assert.equal(f.parsing.size,0);
    assert.equal((await f.send("a","not-json",{token:createWindowsCredential("browser","test-school").credential})).status,401);
    assert.equal(f.parsing.size,0);
    assert.equal((await f.send()).status,201);assert.equal(f.generalParses(),0);
    assert.ok(f.buffers.every(buffer=>buffer.every(byte=>byte===0)));
    assert.equal(f.parsing.get("a")!.body,undefined);
    assert.equal((await f.send("a",body,{path:"/stripe"})).status,200);
    assert.equal(f.generalParses(),1);assert.equal(f.buffers.at(-1)!.toString(),body);
  }finally{await f.close();}
  const denied=await fixture({authDenied:true});
  try{assert.equal((await denied.send("a","not-json")).status,404);assert.equal(denied.parsing.size,0);}finally{await denied.close();}
});

test("trickled Windows bodies expire at the absolute four-second deadline and recover both global slots",{timeout:12_000},async()=>{
  const f=await fixture();const a=f.start("a"),b=f.start("b");let chunks=0;
  const started=performance.now();
  const trickle=setInterval(()=>{chunks++;for(const upload of [a,b])if(!upload.client.destroyed)upload.client.write(" ");},20);
  try{
    a.client.write('{"screenshot":"');b.client.write('{"screenshot":"');
    await Promise.all([f.waitParsing("a"),f.waitParsing("b")]);
    assert.equal((await f.send("a")).status,429);assert.equal((await f.send("c")).status,429);
    assert.deepEqual((await Promise.all([a.done,b.done])).map(result=>result.status),[0,0]);
    assert.ok(chunks>=2);assert.ok(performance.now()-started<8_000);
    assert.deepEqual(f.decoded,[]);assert.deepEqual(f.published,[]);
    assert.equal((await f.send("c")).status,201);assert.equal((await f.send("a")).status,201);
    assert.deepEqual(f.published,["c","a"]);
  }finally{clearInterval(trickle);await f.close();}
});

test("authentication delay and disconnect consume the same deadline without admitting a late body",{timeout:8_000},async()=>{
  const gate=deferred();const f=await fixture({budgetMs:1_000,authGate:gate});
  try{
    const a=f.start();a.client.write('{"sequence":');await f.waitAuth("a");
    assert.equal(f.parsing.size,0);assert.equal((await a.done).status,0);
    gate.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.parsing.size,0);assert.deepEqual(f.published,[]);
    assert.equal((await f.send()).status,201);
  }finally{await f.close();}
});

test("pre-auth concurrency stays bounded until expired credential checks actually settle",{timeout:8_000},async()=>{
  const gate=deferred();const f=await fixture({budgetMs:1_000,authGate:gate});
  try{
    const a=f.start("a"),b=f.start("b");a.client.write("{");b.client.write("{");
    await Promise.all([f.waitAuth("a"),f.waitAuth("b")]);
    assert.equal((await f.send("a")).status,429,"same browser cannot start a second credential check");
    assert.equal((await f.send("c")).status,429,"unvalidated bodies cannot exceed two credential checks");
    assert.equal(f.authenticating.size,2);assert.equal(f.parsing.size,0);
    await Promise.all([a.done,b.done]);
    assert.equal((await f.send("c")).status,429,"transport expiry cannot free a still-running credential check");
    gate.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.parsing.size,0,"expired checks never start reading their bodies");
    assert.equal((await f.send("c")).status,201);assert.equal((await f.send("a")).status,201);
    assert.deepEqual(f.published,["c","a"]);
  }finally{await f.close();}
});

test("client abort and malformed or oversized JSON release the browser slot",{timeout:10_000},async()=>{
  const f=await fixture();
  try{
    const a=f.start();a.client.write('{"sequence":');await f.waitParsing("a");a.client.destroy();await f.waitFinished("a");
    assert.equal((await f.send()).status,201);
    for(const bytes of ["{bad", "null", "[]"]){assert.equal((await f.send("a",bytes)).status,400);assert.equal((await f.send()).status,201);}
    assert.equal((await f.send("a",body,{type:"text/plain"})).status,415);
    assert.equal((await f.send("a",body,{encoding:"gzip"})).status,415);
    assert.equal((await f.send("a","",{length:WINDOWS_SCREENSHOT_JSON_BYTES+1})).status,413);
    assert.equal((await f.send("a",JSON.stringify({sequence:1,screenshot:"x".repeat(WINDOWS_SCREENSHOT_JSON_BYTES)}))).status,413);
    assert.equal((await f.send()).status,201);assert.equal(f.generalParses(),0);
  }finally{await f.close();}
});

test("late parser callback cannot decode, publish, or release a replacement browser slot",{timeout:8_000},async()=>{
  const f=await fixture({budgetMs:1_000,holdParser:true});
  try{
    const a=f.start();a.client.end(body);await f.waitCallback();const late=f.callbacks.shift()!;
    assert.equal((await a.done).status,0);assert.ok(f.buffers[0]!.every(byte=>byte===0));
    const replacement=f.start();replacement.client.end(body);await f.waitCallback();late();
    assert.deepEqual(f.decoded,[]);assert.equal((await f.send()).status,429);
    f.callbacks.shift()!();assert.equal((await replacement.done).status,201);assert.deepEqual(f.published,["a"]);
  }finally{await f.close();}
});

test("router diagnostics preserve header deadline and late processing cannot publish",{timeout:10_000},async()=>{
  const gate=deferred();const f=await fixture({workGate:gate});
  try{
    const a=f.start();a.client.write('{"sequence":1,');await f.waitParsing("a");
    await new Promise(resolve=>setTimeout(resolve,1_000));a.client.end('"screenshot":"sample"}');await f.waitDecoded("a");
    assert.ok(f.remaining[0]!<3_500,"router did not restart the four-second budget after parsing");
    assert.equal((await a.done).status,0);gate.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(f.published,[]);assert.equal(f.parsing.get("a")!.body,undefined);
    assert.equal((await f.send()).status,201);
  }finally{await f.close();}
});
