import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { PDFDocument, StandardFonts } from "pdf-lib";

export type PaperworkBenchmarkOptions = { transport: "synthetic" | "live"; pairs: number; syntheticDelayMs: number; imageDigest: string | null };
export type PaperworkBenchmarkSample = {
  pair: number; protocol: 1 | 2; queueMs: number; preparationMs: number; firstReadyMs: number | null;
  pages: number; forms: number; readyForms: number; providerRequests: number; providerPeak: number;
  failures: number; unreviewedWrites: number; expectedFieldsCorrect: number;
  retryDispatches?: number; errorCode?: string | null;
};
export function parsePaperworkBenchmarkArgs(args: string[]): PaperworkBenchmarkOptions {
  const result: PaperworkBenchmarkOptions = { transport:"synthetic",pairs:3,syntheticDelayMs:500,imageDigest:null };
  const seen = new Set<string>();
  for(let i=0;i<args.length;i+=2) {
    const key=args[i], value=args[i+1];
    if(!key || value===undefined || seen.has(key)) throw new Error("PAPERWORK_BENCHMARK_ARGUMENTS");
    seen.add(key);
    if(key==="--transport" && ["synthetic","live"].includes(value)) result.transport=value as "synthetic"|"live";
    else if(key==="--pairs" && /^[3-5]$/.test(value)) result.pairs=Number(value);
    else if(key==="--synthetic-delay-ms" && /^\d+$/.test(value) && Number(value)>=100 && Number(value)<=10_000) result.syntheticDelayMs=Number(value);
    else if(key==="--image-digest" && /^sha256:[a-f0-9]{64}$/.test(value)) result.imageDigest=value;
    else throw new Error("PAPERWORK_BENCHMARK_ARGUMENTS");
  }
  return result;
}
const median = (numbers:number[]) => {const ordered=[...numbers].sort((a,b)=>a-b);return ordered.length%2?ordered[(ordered.length-1)/2]!:((ordered[ordered.length/2-1]??0)+(ordered[ordered.length/2]??0))/2;};
export function summarizePaperworkBenchmark(samples: PaperworkBenchmarkSample[]) {
  const baseline=samples.filter(s=>s.protocol===1),optimized=samples.filter(s=>s.protocol===2);
  const paired=baseline.length>=3 && baseline.length===optimized.length
    && new Set(baseline.map(s=>s.pair)).size===baseline.length && new Set(optimized.map(s=>s.pair)).size===optimized.length
    && baseline.every(b=>optimized.some(o=>o.pair===b.pair));
  const baselineMedianMs=baseline.length?median(baseline.map(s=>s.preparationMs)):null;
  const optimizedMedianMs=optimized.length?median(optimized.map(s=>s.preparationMs)):null;
  const reduction=baselineMedianMs && optimizedMedianMs!==null ? 1-optimizedMedianMs/baselineMedianMs : null;
  const noPreparationFailures=samples.length>0 && samples.every(s=>s.failures===0 && s.pages===15 && s.forms===15 && s.readyForms===15 && s.unreviewedWrites===0 && s.expectedFieldsCorrect===15 && s.providerPeak<=2);
  const earlyReview=optimized.length>0 && optimized.every(s=>s.firstReadyMs!==null && s.firstReadyMs<s.preparationMs);
  return {paired,baselineMedianMs,optimizedMedianMs,medianReductionFraction:reduction,targetReductionFraction:0.25,
    targetMet:paired && reduction!==null && reduction>=0.25,noPreparationFailures,earlyReview,
    accepted:paired && reduction!==null && reduction>=0.25 && noPreparationFailures && earlyReview};
}

export function assertIsolatedPaperworkBenchmarkDatabase(raw:string|undefined) {
  const url=new URL(raw??"");
  if(!["postgres:","postgresql:"].includes(url.protocol) || !["127.0.0.1","localhost","[::1]","host.docker.internal"].includes(url.hostname)
    || !/^\/schoolpilot_(paperwork|benchmark)[a-z0-9_]*$/i.test(url.pathname)) throw new Error("PAPERWORK_BENCHMARK_ISOLATED_DATABASE_REQUIRED");
  return url;
}

async function syntheticPacket() {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setCreationDate(new Date(0));pdf.setModificationDate(new Date(0));
  for(let i=0;i<15;i++) {
    const page=pdf.addPage([612,792]);
    ["SYNTHETIC TEST ONLY - Discipline referral", "Student: First Student", "Incident date: September 20, 2026",
      `Form number: ${i+1}`, "Teacher reported that the student talked during independent work.",
      "Referral recorded: Yes.", "No detention assignment is recorded on this form.",
      "This is fictional data, not a real student."].forEach((line,index)=>page.drawText(line,{x:36,y:740-index*48,size:13,font}));
  }
  return Buffer.from(await pdf.save({useObjectStreams:false}));
}

async function benchmarkSourceHashes() {
  const files = ["./benchmarkPaperworkPreparation.js", "../services/mydeskImportWorker.js", "../services/mydeskImportPipeline.js",
    "../services/importProcessingStages.js", "../services/mydeskImportProcessing.js", "../config/paperworkProcessing.js",
    "../services/mydeskFiles.js", "../services/mydeskImportsValidation.js"];
  const hashes:Record<string,string> = {};
  for(const file of files) {
    let bytes:Buffer;
    try {bytes=await readFile(new URL(file,import.meta.url));}
    catch(error) {
      if(!(error && typeof error==="object" && "code" in error && error.code==="ENOENT")) throw error;
      bytes=await readFile(new URL(file.replace(/\.js$/,".ts"),import.meta.url));
    }
    hashes[file]=createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

/** Real worker/database/native pipeline; synthetic fixture and local files only. Never imports the app or starts its scheduler. */
export async function runPaperworkBenchmark(options:PaperworkBenchmarkOptions, onSample:(sample:PaperworkBenchmarkSample)=>void = ()=>{}) {
  if(process.env.PAPERWORK_BENCHMARK_ISOLATED!=="1") throw new Error("PAPERWORK_BENCHMARK_ISOLATED_OPT_IN_REQUIRED");
  const databaseUrl=assertIsolatedPaperworkBenchmarkDatabase(process.env.DATABASE_URL);
  if(process.env.DATABASE_URL_PRIVILEGED) {
    const privileged=assertIsolatedPaperworkBenchmarkDatabase(process.env.DATABASE_URL_PRIVILEGED);
    if(privileged.host!==databaseUrl.host || privileged.pathname!==databaseUrl.pathname) throw new Error("PAPERWORK_BENCHMARK_DATABASE_MISMATCH");
  }
  if(options.transport==="live" && (process.env.PAPERWORK_BENCHMARK_LIVE_PROVIDER!=="1" || !process.env.ANTHROPIC_API_KEY))
    throw new Error("PAPERWORK_BENCHMARK_LIVE_OPT_IN_REQUIRED");
  const sourceHashes=await benchmarkSourceHashes();
  const sourceRevision=/^[a-f0-9]{40}$/.test(process.env.PAPERWORK_BENCHMARK_SOURCE_REVISION??"") ? process.env.PAPERWORK_BENCHMARK_SOURCE_REVISION : null;
  // Only the explicitly validated disposable process is configured. No runtime service settings are changed.
  process.env.SCHEDULER_ENABLED="true";process.env.MYDESK_MODE="on";process.env.MYDESK_AI_IMPORT_MODE="on";
  process.env.STUDENT_INFORMATION_AI_IMPORT_MODE="off";process.env.REDIS_URL="";
  const [{pool,sessionPool},{schedulerDb,schedulerPool,schedulerLockPool},processing,files,worker,{mydeskImports:runs},{eq},memory] = await Promise.all([
    import("../db.js"),import("../services/schedulerDb.js"),import("../services/mydeskImportProcessing.js"),import("../services/mydeskFiles.js"),
    import("../services/mydeskImportWorker.js"),import("../schema/mydeskImports.js"),import("drizzle-orm"),import("./measureMyDeskProcessing.js"),
  ]);
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL_PRIVILEGED || process.env.DATABASE_URL,max:2,options:"-c app.is_super=on"});
  const directory=await mkdtemp(join(tmpdir(),"paperwork-benchmark-"));
  const schoolId=randomUUID(),teacherId=randomUUID(),groupId=randomUUID(),studentId=randomUUID();
  const controller=new AbortController();const stop=()=>controller.abort();
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  const deadline=setTimeout(()=>controller.abort(),options.transport==="live"?7_200_000:1_800_000);
  const samples:PaperworkBenchmarkSample[]=[];
  let memoryPeak=0,memoryLimit:number|null=null,memorySamples=0,memoryCurrentSamples=0,memoryRead:Promise<void>|undefined;
  const taskMemory=await memory.readMeasurementTaskMemory();
  const sampleMemory=async()=>{
    const reading=await memory.readMeasurementCgroup();memorySamples++;
    const limits=[reading.limit,taskMemory].filter((value):value is number=>value!==null && Number.isFinite(value) && value>0);
    memoryLimit=limits.length?Math.min(...limits):null;
    if(reading.current!==null && Number.isFinite(reading.current) && reading.current>0) memoryCurrentSamples++;
    memoryPeak=Math.max(memoryPeak,reading.current??0,reading.peak??0);
    if(reading.current!==null && memoryLimit!==null && reading.current/memoryLimit>=.85) controller.abort(new Error("PAPERWORK_BENCHMARK_MEMORY_STOP"));
  };
  const memoryTimer=setInterval(()=>{if(!memoryRead)memoryRead=sampleMemory().finally(()=>{memoryRead=undefined;});},100);
  const filename=(key:string)=>join(directory,createHash("sha256").update(key).digest("hex"));
  const store:import("../services/mydeskFiles.js").MyDeskObjectStore={
    put:async(key,bytes)=>{controller.signal.throwIfAborted();await writeFile(filename(key),bytes,{mode:0o600});},
    get:async key=>{controller.signal.throwIfAborted();return readFile(filename(key));},
    delete:async key=>{await rm(filename(key),{force:true});},
  };
  let insertedSchool=false,insertedUser=false;
  try {
    const active=await admin.query("SELECT (SELECT count(*) FROM mydesk_imports WHERE status IN ('queued','processing'))+(SELECT count(*) FROM student_information_imports WHERE status IN ('queued','processing')) AS count");
    if(Number(active.rows[0].count)!==0) throw new Error("PAPERWORK_BENCHMARK_DATABASE_BUSY");
    const model=processing.myDeskImportModel(),promptVersion=processing.MYDESK_IMPORT_PROMPT_VERSION;
    const fixture=await admin.connect();
    try {
      await fixture.query("BEGIN");
      await fixture.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Synthetic paperwork benchmark','active',true,'active','UTC')",[schoolId]);
      await fixture.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Teacher')",[teacherId,`${teacherId}@example.test`]);
      await fixture.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",[schoolId]);
      await fixture.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')",[schoolId,teacherId]);
      await fixture.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Synthetic class','admin_class','active')",[groupId,schoolId,teacherId]);
      await fixture.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')",[groupId,teacherId]);
      await fixture.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')",[studentId,schoolId]);
      await fixture.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",[groupId,studentId]);
      await fixture.query("COMMIT");insertedSchool=true;insertedUser=true;
    } catch(error) {await fixture.query("ROLLBACK");throw error;}
    finally {fixture.release();}
    const bytes=await syntheticPacket(),fixtureHash=files.myDeskSha256(bytes);
    const source=await processing.prepareImportSource(bytes,"application/pdf",{signal:controller.signal});
    for(let pair=0;pair<options.pairs;pair++) for(const protocol of (pair%2?[2,1]:[1,2]) as Array<1|2>) {
      controller.signal.throwIfAborted();process.env.MYDESK_IMPORT_PIPELINE_VERSION=String(protocol);process.env.MYDESK_IMPORT_PIPELINE_WIDTH="2";
      const runId=randomUUID(),assetId=randomUUID(),key=`mydesk/${schoolId}/${teacherId}/imports/${runId}/${assetId}`;
      await store.put(key,source.bytes,source.contentType);
      await admin.query(`INSERT INTO mydesk_imports(id,school_id,author_id,client_request_id,request_fingerprint,status,destination,expected_source_count,selected_group_ids,page_count,expires_at,upload_expires_at,model_version,prompt_version)
        VALUES($1,$2,$3,$4,$5,'queued','discipline',1,$6::jsonb,15,now()+interval '7 days',now()+interval '24 hours',$7,$8)`,[runId,schoolId,teacherId,randomUUID(),fixtureHash,JSON.stringify([groupId]),model,promptVersion]);
      await admin.query(`INSERT INTO mydesk_import_assets(id,school_id,author_id,import_id,kind,client_request_id,request_fingerprint,storage_key,content_type,input_sha256,sha256,byte_size,page_count,status)
        VALUES($1,$2,$3,$4,'source',$5,$6,$7,$8,$6,$6,$9,15,'ready')`,[assetId,schoolId,teacherId,runId,randomUUID(),fixtureHash,key,source.contentType,source.bytes.length]);
      const queued=performance.now();
      const claims=await worker.claimMyDeskImportJobs({database:schedulerDb,signal:controller.signal});
      const claim=claims.find(candidate=>candidate.id===runId);
      if(claims.length!==1 || !claim) throw new Error("PAPERWORK_BENCHMARK_CLAIM_MISMATCH");
      const claimed=performance.now();
      let providerRequests=0,providerActive=0,providerPeak=0,firstReadyMs:number|null=null;
      const ai=processing.createImportAiProcessor(options.transport==="live"?undefined:async(request,signal)=>{
        await new Promise<void>((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(new Error("PAPERWORK_BENCHMARK_ABORTED"));};
          const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},options.syntheticDelayMs);
          signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
        });
        const detection=JSON.stringify(request.output_config).includes('"regions"');
        const result=detection?{regions:[{x:0,y:0,width:1,height:1,rotation:0}]}:{subjectNames:["First Student"],entryDate:"2026-09-20",category:"referral",title:"Synthetic referral",body:"Teacher reported talking during independent work.",warnings:[],disciplineFields:{referral:true,detentionAssignment:null}};
        return {stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(result)}]};
      },{model,promptVersion});
      const counted = async<T>(operation:()=>Promise<T>)=>{providerRequests++;providerActive++;providerPeak=Math.max(providerPeak,providerActive);try{return await operation();}finally{providerActive--;}};
      const processor={renderImportSource:processing.renderImportSource,cropImportRegion:processing.cropImportRegion,buildImportAttachment:processing.buildImportAttachment,
        prepareImportImages:ai.prepareImportImages,
        detectImportForms:((...args:Parameters<typeof ai.detectImportForms>)=>counted(()=>ai.detectImportForms(...args))),
        extractImportForm:((...args:Parameters<typeof ai.extractImportForm>)=>counted(()=>ai.extractImportForm(...args))),
      };
      let observation:Promise<void>|undefined,observationFailed=false,workerFinishedAt:number|null=null,retryDispatches=0;
      const poll=setInterval(()=>{if(!observation)observation=admin.query("SELECT count(*)::int count FROM mydesk_import_items i JOIN mydesk_import_assets a ON a.id=i.approved_asset_id AND a.school_id=i.school_id AND a.author_id=i.author_id AND a.import_id=i.import_id WHERE i.import_id=$1 AND i.extraction_status='ready' AND a.status='ready'",[runId]).then(result=>{if(result.rows[0].count>0 && firstReadyMs===null && workerFinishedAt===null)firstReadyMs=performance.now()-claimed;}).catch(()=>{observationFailed=true;controller.abort(new Error("PAPERWORK_BENCHMARK_OBSERVATION_FAILED"));}).finally(()=>{observation=undefined;});},50);
      try {
        let currentClaim=claim;
        for(;;) {
          await worker.processClaimedMyDeskImport(currentClaim,{database:schedulerDb,store,processor,signal:controller.signal});
          const [state]=await schedulerDb.select().from(runs).where(eq(runs.id,runId));
          if(state?.status!=="queued") {workerFinishedAt=performance.now();break;}
          // Preserve real stage backoff and the five-second scheduler cadence; retries are part of preparation time.
          let nextClaim:typeof claim|undefined;
          while(!nextClaim) {
            controller.signal.throwIfAborted();
            await new Promise<void>(resolve=>{
              const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener("abort",finish);resolve();};
              const timer=setTimeout(finish,5_000);controller.signal.addEventListener("abort",finish,{once:true});
              if(controller.signal.aborted) finish();
            });
            controller.signal.throwIfAborted();
            const retryClaims=await worker.claimMyDeskImportJobs({database:schedulerDb,signal:controller.signal});
            if(retryClaims.some(candidate=>candidate.id!==runId)) throw new Error("PAPERWORK_BENCHMARK_CLAIM_MISMATCH");
            nextClaim=retryClaims.find(candidate=>candidate.id===runId);
          }
          currentClaim=nextClaim;retryDispatches++;
        }
      }
      finally {clearInterval(poll);await observation;}
      if(observationFailed) throw new Error("PAPERWORK_BENCHMARK_OBSERVATION_FAILED");
      const preparationMs=workerFinishedAt!-claimed;
      const [finished]=await schedulerDb.select().from(runs).where(eq(runs.id,runId));
      const values=await admin.query("SELECT count(*)::int forms,count(*) FILTER(WHERE extraction_status='ready' AND approved_asset_id IS NOT NULL)::int ready,count(*) FILTER(WHERE student_id=$2 AND entry_date='2026-09-20' AND discipline_fields->>'referral'='true' AND discipline_fields->'detentionAssignment'='null'::jsonb)::int correct FROM mydesk_import_items WHERE import_id=$1",[runId,studentId]);
      const published=await admin.query("SELECT count(*)::int count FROM school_discipline_records WHERE school_id=$1",[schoolId]);
      const result=values.rows[0];
      samples.push({pair:pair+1,protocol,queueMs:claimed-queued,preparationMs,firstReadyMs:firstReadyMs??(result.ready>0?preparationMs:null),pages:finished!.pageCount,forms:result.forms,readyForms:result.ready,
        providerRequests,providerPeak,failures:finished?.status==='review'?0:1,unreviewedWrites:published.rows[0].count,expectedFieldsCorrect:result.correct,retryDispatches,errorCode:finished?.lastErrorCode??null});
      onSample(samples.at(-1)!);
      // Stop failed comparisons before later calls can spend more provider capacity.
      if(finished?.status!=="review") throw new Error("PAPERWORK_BENCHMARK_PREPARATION_FAILED");
    }
    await sampleMemory();
    if(JSON.stringify(await benchmarkSourceHashes())!==JSON.stringify(sourceHashes)) throw new Error("PAPERWORK_BENCHMARK_SOURCE_CHANGED");
    return {schemaVersion:1,measurement:"synthetic_packet_actual_worker_paired",transport:options.transport,syntheticOnly:true,
      model,promptVersion,fixtureSha256:fixtureHash,sourcePages:15,imageDigest:options.imageDigest,imageDigestVerified:false,sourceRevision,sourceHashes,pipelineWidth:2,
      samples,summary:summarizePaperworkBenchmark(samples),memory:{peakBytes:memoryPeak||null,limitBytes:memoryLimit,samples:memorySamples,currentSamples:memoryCurrentSamples,below70Percent:memoryLimit && memoryCurrentSamples>0?memoryPeak/memoryLimit<.7:null},
      limitations:["immediate_dispatch_measures_claim_delay_not_serving_scheduler_queue","local_fixture_database_and_file_store_not_production_network","single_worker_pairing_is_not_two_packet_capacity_or_api_latency_evidence","synthetic_typed_forms_do_not_replace_full_quality_evaluation","image_digest_requires_external_container_identity_verification"]};
  } finally {
    controller.abort();clearTimeout(deadline);clearInterval(memoryTimer);await memoryRead;process.off("SIGINT",stop);process.off("SIGTERM",stop);
    try {
      if(insertedSchool) {
        await admin.query("UPDATE schools SET deleted_at=now(),is_active=false WHERE id=$1",[schoolId]);
        for(const table of ["import_processing_stages","mydesk_import_items","mydesk_import_assets","mydesk_imports","audit_logs"]) await admin.query(`DELETE FROM ${table} WHERE school_id=$1`,[schoolId]);
        for(const table of ["group_students","group_teachers"]) await admin.query(`DELETE FROM ${table} WHERE group_id=$1`,[groupId]);
        for(const table of ["groups","students","settings","school_memberships","product_licenses"]) await admin.query(`DELETE FROM ${table} WHERE school_id=$1`,[schoolId]);
      }
      // Preserve database staff-history guards. These credential-free identity roots disappear when the disposable database is removed.
      if(insertedUser) await admin.query("UPDATE users SET auth_version=auth_version+1 WHERE id=$1",[teacherId]);
    } finally {
      await rm(directory,{recursive:true,force:true});
      await Promise.all([pool.end(),sessionPool.end(),schedulerPool.end(),schedulerLockPool.end(),admin.end()]);
    }
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.includes("--help")) process.stdout.write("Usage: node dist/cli/benchmarkPaperworkPreparation.js [--transport synthetic|live] [--pairs 3..5] [--synthetic-delay-ms 100..10000] [--image-digest sha256:<digest>]\nRequires a disposable bootstrapped schoolpilot_paperwork*/schoolpilot_benchmark* local database and PAPERWORK_BENCHMARK_ISOLATED=1. Live mode additionally requires PAPERWORK_BENCHMARK_LIVE_PROVIDER=1 and ANTHROPIC_API_KEY in the process environment. Never supply keys in arguments. Output contains metrics only.\n");
  else try {
    const options=parsePaperworkBenchmarkArgs(process.argv.slice(2));
    const report=await runPaperworkBenchmark(options,sample=>process.stdout.write(`${JSON.stringify({event:"paperwork_benchmark_sample",...sample})}\n`));process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode=report.summary.accepted?0:1;
  } catch(error) {
    const safe=error instanceof Error && /^PAPERWORK_BENCHMARK_[A-Z_]+$/.test(error.message)?error.message:
      error && typeof error==="object" && "code" in error && /^[A-Za-z0-9_]{1,64}$/.test(String(error.code))?String(error.code):"PAPERWORK_BENCHMARK_FAILED";
    const constraint=error && typeof error==="object" && "constraint" in error && /^[A-Za-z0-9_]{1,128}$/.test(String(error.constraint))?String(error.constraint):undefined;
    const errorType=error instanceof TypeError?"TypeError":error instanceof SyntaxError?"SyntaxError":error instanceof RangeError?"RangeError":"Error";
    process.stderr.write(`${JSON.stringify({status:"failed",failureCode:safe,errorType,...(constraint?{constraint}:{})})}\n`);process.exitCode=1;
  }
}
