import pg from "pg";
const url=new URL(process.env.DATABASE_URL||"");
if(!["localhost","127.0.0.1","::1"].includes(url.hostname))throw new Error("History query-plan verification requires a local fixture database.");
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
try{
  // Connection-local synthetic data; no application tables or real student records are changed.
  await client.query("CREATE TEMP TABLE browsing_history_plan(id text,school_id text,student_id text,device_id text,timestamp timestamp,active_tab_url text)");
  await client.query("INSERT INTO browsing_history_plan SELECT lpad(n::text,8,'0'),'school-'||(n%5),'student-'||(n%100),'device-'||(n%1000),timestamp '2026-09-01 00:00:00'+((n/100)::int*interval '5 seconds'),'https://school.example/page' FROM generate_series(1,500000) n");
  await client.query("CREATE INDEX plan_student_timestamp ON browsing_history_plan(student_id,timestamp)");
  await client.query("CREATE INDEX plan_school_device_student_timestamp ON browsing_history_plan(school_id,device_id,student_id,timestamp DESC)");
  await client.query("ANALYZE browsing_history_plan");
  const query="EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,timestamp,active_tab_url FROM browsing_history_plan WHERE school_id='school-0' AND student_id='student-0' AND timestamp>=timestamp '2026-09-01' AND timestamp<timestamp '2026-09-02' AND (timestamp,id)<(timestamp '2026-09-01 03:00:00','99999999') ORDER BY timestamp DESC,id DESC LIMIT 101";
  async function explain(label:string){const result=await client.query(query);const plan=result.rows[0]["QUERY PLAN"][0];const nodes:unknown[]=[];const walk=(node:Record<string,any>)=>{nodes.push({node:node["Node Type"],index:node["Index Name"],rows:node["Actual Rows"],removed:node["Rows Removed by Filter"],localHitBlocks:node["Local Hit Blocks"],localReadBlocks:node["Local Read Blocks"],sort:node["Sort Method"]});for(const child of node.Plans||[])walk(child);};walk(plan.Plan);console.log(JSON.stringify({label,syntheticRows:500000,executionMs:plan["Execution Time"],nodes}));}
  await explain("existing indexes");
  await client.query("CREATE INDEX plan_school_student_cursor ON browsing_history_plan(school_id,student_id,timestamp DESC,id DESC)");
  await client.query("ANALYZE browsing_history_plan");
  await explain("student cursor index");
}finally{await client.end();}
