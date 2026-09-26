import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{MyDeskNotebook}from'/src/products/classpilot/pages/MyDesk.jsx';import{StudentDirectory,StudentHistory}from'/src/products/classpilot/pages/StudentLogs.jsx';import{ImportUpload}from'/src/products/classpilot/pages/Imports.jsx';import'/src/index.css';const h=React.createElement;window.refreshWorkspace=()=>queryClient.invalidateQueries({queryKey:['mydesk-private']});function Harness(){const[viewerId,setViewer]=useState('teacher-a');const access={schoolId:'school-a',viewerId,enabled:true,eligible:true,schoolDate:'2026-09-26'};const mode=new URLSearchParams(location.search).get('mode');const C=mode==='directory'?StudentDirectory:mode==='history'?StudentHistory:mode==='source'?ImportUpload:MyDeskNotebook;return h(React.Fragment,null,h('button',{onClick:()=>{window.__viewer='teacher-b';setViewer('teacher-b')}},'Switch author'),h(C,{key:viewerId,access,...access,studentId:'student-a',today:access.schoolDate,source:mode==='source'?{noteId:'note-a',attachmentId:'file-a'}:undefined,initialGroupId:mode==='source'?'class-a':undefined,onClose:()=>{window.__closed=true},onStarted:batch=>{window.__started=batch.id}}));}createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(MemoryRouter,null,h(Harness))));`;
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-workspace-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'workspace-browser', configureServer(server) { server.middlewares.use(async (req,res,next) => {
    if (!req.url?.startsWith('/__workspace?')) return next(); res.setHeader('Content-Type','text/html'); res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__workspace-entry.jsx"></script></body></html>'));
  }); }, resolveId(id) { if(id==='/__workspace-entry.jsx')return '\0workspace-entry'; }, load(id) { if(id==='\0workspace-entry')return entry; } }] });
  await vite.listen(); base=`http://127.0.0.1:${vite.httpServer.address().port}`; browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();await vite?.close();});

async function setup(mode) {
  const page=await browser.newPage({viewport:{width:430,height:932}}); const requests=[],errors=[];
  const state={revision:0,defaults:{},copies:[],failCopy:true,stale:false,historyStatus:200};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.__viewer='teacher-a';localStorage.setItem('sp_activeSchoolId','school-a');});
  const classes=[{id:'class-a',name:'Science',gradeLevel:'5',personal:true},{id:'class-b',name:'Reading',gradeLevel:'5',personal:true},{id:'other',name:'Other authorized',gradeLevel:'6',personal:false}];
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method(),body=method==='GET'?undefined:request.postDataJSON();
    requests.push({path:url.pathname,search:url.search,method,body}); const json=(value,status=200)=>route.fulfill({json:value,status});
    if(url.pathname.endsWith('/csrf'))return json({csrfToken:'synthetic'});
    if(url.pathname.endsWith('/capabilities'))return json({canSubmit:false,canReview:false});
    if(url.pathname.endsWith('/classes'))return json({current:classes,past:[],preferences:{revision:state.revision,preferredClasses:state.defaults},personalByGrade:[{gradeLevel:'5',classes:state.stale?classes.slice(0,1):classes.slice(0,2),preferredClassId:state.stale&&state.defaults['5']!=='class-a'?null:state.defaults['5']||null,preferenceStale:state.stale&&state.defaults['5']!=='class-a'}],otherCurrent:[classes[2]]});
    if(url.pathname.endsWith('/preferences')){assert.equal(method,'PATCH');assert.equal(body.revision,state.revision);state.revision++;state.defaults=body.preferredClasses;return json({revision:state.revision,preferredClasses:state.defaults});}
    if(url.pathname.endsWith('/categories'))return json({categories:[{key:'note',label:'Note'},{key:'positive',label:'Positive'}]});
    if(url.pathname.endsWith('/notes/search'))return json({notes:[],nextCursor:null});
    if(url.pathname.endsWith('/students/search'))return json({students:[{id:'student-a',name:'Zero Notes',noteCount:0,classes:classes.slice(0,2)}],nextCursor:null});
    if(url.pathname.endsWith('/history')){if(state.historyStatus!==200)return json({error:'Access revoked'},state.historyStatus);const viewer=await page.evaluate(()=>window.__viewer);return json({student:{id:'student-a',name:viewer==='teacher-a'?'Historical Person':'New owner student',current:false},notes:viewer==='teacher-a'?[{id:'old',targetKind:'student',status:'active',groupName:'Grade five last year',studentName:'Saved student label',title:'My historical note',body:'Private saved observation',category:'positive',entryDate:'2025-09-20',pinned:false,revision:1,attachments:[]}]:[],nextCursor:null});}
    if(url.pathname.endsWith('/export'))return route.fulfill({contentType:'text/csv',body:'title\nprivate history'});
    if(url.pathname.endsWith('/imports/from-attachment')){state.copies.push(body);if(state.failCopy){state.failCopy=false;return json({error:'Temporary synthetic interruption'},503);}return json({import:{id:'copy-a',revision:2,status:'uploading'}});}
    if(url.pathname.endsWith('/imports/copy-a/process'))return json({import:{id:'copy-a',revision:3,status:'queued'}});
    if(url.pathname.endsWith('/imports/copy-a'))return json({import:{id:'copy-a',revision:2,status:'uploading'}});
    return json({error:'Unexpected fixture request'},404);
  });
  await page.goto(`${base}/__workspace?mode=${mode}`);return{page,requests,errors,state};
}

test('personal grade groups persist one default while other authorized classes stay collapsed and AI unavailability is explicit',async()=>{
  const {page,requests,errors,state}=await setup('notebook');
  try{await page.getByLabel('Default class for grade 5').selectOption('class-b');await page.waitForFunction(()=>document.querySelector('select[aria-label="Default class for grade 5"]')?.value==='class-b');
    await page.getByText('Other authorized classes (1)').waitFor();assert.equal(await page.getByRole('button',{name:'Other authorized',exact:true}).isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'AI import unavailable'}).isDisabled(),true);
    await page.getByText('Other authorized classes (1)').click();assert.equal(await page.getByRole('button',{name:'Other authorized',exact:true}).isVisible(),true);
    assert.deepEqual(requests.find(row=>row.path.endsWith('/preferences')).body,{revision:0,preferredClasses:{'5':'class-b'}});state.stale=true;await page.evaluate(()=>window.refreshWorkspace());await page.getByRole('option',{name:'Choose a replacement'}).waitFor({state:'attached'});await page.getByLabel('Default class for grade 5').selectOption('class-a');await page.waitForTimeout(150);assert.deepEqual(requests.filter(row=>row.path.endsWith('/preferences')).at(-1).body,{revision:1,preferredClasses:{'5':'class-a'}});assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('zero-note student directory is searchable through private request bodies',async()=>{
  const {page,requests,errors}=await setup('directory');try{await page.getByRole('heading',{name:'Zero Notes'}).waitFor();await page.getByText('0 private notes across all years').waitFor();await page.getByLabel('Find a student').fill('private search');await page.waitForTimeout(350);
    assert.ok(requests.some(row=>row.path.endsWith('/students/search')&&row.body.q==='private search'&&row.search===''));assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('history preserves saved class labels, exports identical filters and clears on same-school author switch',async()=>{
  const {page,requests,errors,state}=await setup('history');try{await page.getByText('My historical note').waitFor();await page.getByText('Grade five last year',{exact:true}).waitFor();await page.getByLabel('Category',{exact:true}).selectOption('positive');
    await page.getByRole('button',{name:'Export CSV'}).click();await page.waitForTimeout(150);assert.equal(requests.find(row=>row.path.endsWith('/export')).body.category,'positive');
    await page.getByRole('button',{name:'Edit / refile'}).click();await page.getByRole('dialog').waitFor();state.historyStatus=403;await page.evaluate(()=>window.refreshWorkspace());await page.getByRole('dialog').waitFor({state:'hidden'});state.historyStatus=200;await page.getByRole('button',{name:'Switch author'}).click();await page.getByRole('heading',{name:'New owner student'}).waitFor();assert.equal(await page.getByText('My historical note').count(),0);assert.equal(await page.getByText('Historical Person',{exact:true}).count(),0);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('saved attachment requires explicit send, retries same reservation and never deletes original',async()=>{
  const {page,requests,errors,state}=await setup('source');try{await page.getByText('Use your saved attachment',{exact:true}).waitFor();assert.equal(state.copies.length,0);await page.getByRole('button',{name:'Use saved attachment and prepare drafts'}).click();await page.getByText('Temporary synthetic interruption').waitFor();await page.getByRole('button',{name:'Retry import',exact:true}).click();await page.waitForFunction(()=>window.__started==='copy-a');
    assert.equal(state.copies.length,2);assert.deepEqual(state.copies[0],state.copies[1]);assert.deepEqual(Object.keys(state.copies[0]).sort(),['attachmentId','clientRequestId','noteId','selectedGroupIds']);
    assert.equal(requests.filter(row=>row.method==='DELETE').length,0);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
