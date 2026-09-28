import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{MemoryRouter,Routes,Route,useLocation,useParams}from'react-router-dom';
import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';
import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import AdminNavigationProvider from'/src/products/classpilot/components/admin/AdminNavigationProvider.jsx';import{AdminShellFrame}from'/src/products/classpilot/components/admin/ClassPilotAdminShell.jsx';
import{DisciplineShell,DisciplineLibrary,RecordLoader}from'/src/products/classpilot/pages/DisciplineRecords.jsx';
import DisciplineSubmitButton,{SubmissionReview}from'/src/products/classpilot/components/DisciplineSubmitButton.jsx';
import DisciplineIncidentComposer from'/src/products/classpilot/components/DisciplineIncidentComposer.jsx';
import{clearMyDeskQueries}from'/src/products/classpilot/lib/myDeskModel.js';
import{useDisciplineCapabilities}from'/src/products/classpilot/hooks/useDiscipline.js';import'/src/index.css';
const h=React.createElement;const fixtureParams=new URLSearchParams(location.search);
window.refreshDiscipline=()=>queryClient.invalidateQueries({queryKey:['mydesk-private']});
function RoutedRecord({access}){const {recordId}=useParams();return h(DisciplineShell,null,h(RecordLoader,{access,recordId}));}
function Navigation({access}){const route=useLocation();return h(React.Fragment,null,h('output',{'aria-label':'Current route'},route.pathname+route.search),h(Routes,null,
  h(Route,{path:'/classpilot/discipline-records',element:h(DisciplineShell,null,h(DisciplineLibrary,{access}))}),
  h(Route,{path:'/classpilot/discipline-records/:recordId',element:h(RoutedRecord,{access})}),
  h(Route,{path:'/classpilot',element:h('h1',null,'ClassPilot destination')}),
  h(Route,{path:'/classpilot/admin',element:h('h1',null,'Admin destination')}),
  h(Route,{path:'/classpilot/my-desk',element:h('h1',null,'My Desk destination')}),
  h(Route,{path:'/classpilot/my-desk/imports',element:h('h1',null,'Paperwork destination')})
));}
function Harness(){const[viewerId,setViewer]=useState('teacher-a');const identity={schoolId:'school-a',viewerId,enabled:true,eligible:true};const capability=useDisciplineCapabilities(identity);const access={...identity,importsEnabled:true,capabilities:capability.data||{canSubmit:false,canViewSchool:false,canManageAccess:false}};
const mode=fixtureParams.get('mode');const C=mode==='navigation'?Navigation:mode==='library'||mode==='admin'?DisciplineLibrary:mode==='composer'?DisciplineIncidentComposer:mode==='limit'?SubmissionReview:mode==='record'?RecordLoader:DisciplineSubmitButton;
return h(React.Fragment,null,h('button',{onClick:()=>{clearMyDeskQueries(queryClient);window.__viewer='teacher-b';setViewer('teacher-b')}},'Switch author'),h('div',{className:'mydesk-page discipline-page'},capability.usable?h(C,{key:viewerId+':'+access.capabilities.canViewSchool,access,onSaved:id=>{window.__saved=id},recordId:'record-a',noteIds:mode==='limit'?Array.from({length:51},(_,i)=>'note-'+i):['note-a','note-b'],onClose:()=>{window.__closed=true}}):h('p',null,'Access unavailable')));}
function AdminHarness(){return h(AdminNavigationProvider,{scopeKey:'school-a:teacher-a'},h(AdminShellFrame,{route:{id:'discipline',title:'Discipline logs'},schoolName:'Synthetic School'},h(Harness)));}createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(MemoryRouter,{initialEntries:[fixtureParams.get('route')||(fixtureParams.get('mode')==='admin'?'/classpilot/discipline-records?entry=admin':'/classpilot/discipline-records')]},h(ThemeProvider,null,fixtureParams.get('shell')?h(AdminHarness):h(Harness)))));
`;
before(async () => {
  vite=await createServer({root,logLevel:'error',cacheDir:`node_modules/.vite-discipline-${process.pid}`,server:{host:'127.0.0.1',port:0},plugins:[{name:'discipline-browser',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(!req.url?.startsWith('/__discipline?'))return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__discipline-entry.jsx"></script></body></html>'));});},resolveId(id){if(id==='/__discipline-entry.jsx')return '\0discipline-entry';},load(id){if(id==='\0discipline-entry')return entry;}}]});
  await vite.listen();base=`http://127.0.0.1:${vite.httpServer.address().port}`;browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();await vite?.close();});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const version=(number,title=`Version ${number}`)=>({id:`version-${number}`,number,kind:number===1?'submission':'correction',studentId:'student-a',studentName:'Synthetic Student',classId:'class-a',className:'Grade five',category:'referral',entryDate:'2026-09-26',title,body:'Synthetic submitted summary.',reason:number===1?'':'Correction history',createdAt:'2026-09-26T12:00:00.000Z',attachments:[{id:`evidence-${number}`,filename:'synthetic.png',contentType:'image/png'}]});
const record=(revision=3)=>({id:'record-a',revision,status:'submitted',canCorrect:true,canWithdraw:true,currentVersion:version(revision),versions:[version(revision),version(revision-1)],nextVersionsCursor:revision-1,submittedBy:{id:'teacher-a',name:'Synthetic Teacher'}});
async function setup(mode, options = {}) {
  const page=await browser.newPage({viewport:{width:390,height:844}}),requests=[],errors=[];
  const state={capabilityStatus:200,recordStatus:200,blobStatus:200,submitFail:true,correctionMode:'conflict',correctionCalls:[],submissions:[],grants:[],failGrant:true,revision:3,withdrawals:[],withdrawConflict:false,withdrawn:false,canViewSchool:true,recordAuthor:'teacher-a',createdDrafts:[],finalizations:[],duplicates:[],finalizeStatus:200,range:{period:'all',from:null,to:null,noticeCode:'SCHOOL_YEAR_NOT_CONFIGURED',notice:'Showing all dates because school year dates have not been configured.'},...options};
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.__viewer='teacher-a';window.__revoked=[];localStorage.setItem('sp_activeSchoolId','school-a');const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.__revoked.push(url);revoke(url)};});
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method(),body=method==='GET'||method==='PUT'&&url.pathname.endsWith('/content')?undefined:request.postDataJSON();requests.push({path:url.pathname,query:url.search,method,body});const json=(value,status=200)=>route.fulfill({json:value,status});
    if(url.pathname.endsWith('/csrf'))return json({csrfToken:'synthetic'});
    if(url.pathname.endsWith('/capabilities'))return state.capabilityStatus===200?json({canSubmit:true,canViewSchool:state.canViewSchool,canManageAccess:false}):json({error:'Capability temporarily unavailable'},state.capabilityStatus);
    if(method==='PUT'&&url.pathname.includes('/content')){state.draft.attachments[0].status='ready';return json({attachment:state.draft.attachments[0]});}
    if(url.pathname.includes('/content'))return state.blobStatus===200?route.fulfill({contentType:'image/png',body:png}):json({error:'Access revoked'},state.blobStatus);
    if(url.pathname.includes('/mydesk/notes/')){const id=url.pathname.split('/').at(-1);return json({note:{id,targetKind:'student',status:'active',revision:2,studentName:id==='note-a'?'First Synthetic':'Second Synthetic',groupName:'Grade five',title:'Private source',body:'Only explicitly selected material is shared.',category:'referral',entryDate:'2026-09-26',attachments:[{id:`${id}-file`,status:'ready',committedAt:'2026-09-26T00:00:00Z',originalFilename:'synthetic.png',contentType:'image/png'}]}});}
    if(url.pathname.includes('/mydesk/')&&url.pathname.endsWith('/students/student-a/history'))return json({student:{id:'student-a',name:'Synthetic Student',current:false},notes:[{id:'historical-note',targetKind:'student',status:'active',revision:2,entryDate:'2025-01-01',title:'Preserved past-class evidence',attachments:[]}],nextCursor:null});
    if(url.pathname.endsWith('/submit')){state.submissions.push(body);if(body.noteId==='note-b'&&state.submitFail){state.submitFail=false;return json({error:'Synthetic interrupted response'},503);}return json({record:{id:`record-${body.noteId}`}});}
    if(url.pathname.endsWith('/correct')){state.correctionCalls.push(body);if(state.correctionMode==='conflict'){state.revision=4;state.correctionMode='success';return json({error:'This record changed',code:'DISCIPLINE_REVISION_CONFLICT'},409);}return json({record:record(5)});}
    if(url.pathname.endsWith('/withdraw')){state.withdrawals.push(body);if(state.withdrawConflict){state.withdrawConflict=false;state.revision++;return json({error:'This record changed',code:'DISCIPLINE_REVISION_CONFLICT'},409);}state.withdrawn=true;return json({record:{...record(),status:'withdrawn'}});}
    if(url.pathname.endsWith('/access/teacher-a')){state.grants.push(body);if(state.failGrant){state.failGrant=false;return json({error:'Temporary permission interruption'},503);}return json({ok:true});}
    if(url.pathname.endsWith('/access'))return json({staff:[{userId:'teacher-a',name:'Synthetic Teacher',email:'synthetic@example.test',enabled:false,revision:0}]});
    if(url.pathname.endsWith('/mydesk/classes'))return json({current:[{id:'class-a',name:'Grade five',gradeLevel:'5',personal:true,groupType:'admin_class'},{id:'class-b',name:'Grade six',gradeLevel:'6',personal:false,groupType:'admin_class'}],grades:[{gradeLevel:'5',label:'Grade 5'}],preferences:{revision:0,viewBy:'grades',preferredClasses:{}}});
    const range=body?.period==='custom'?{period:'custom',from:body.from,to:body.to}:body?.period==='all'?{period:'all',from:null,to:null}:state.range;
    if(url.pathname.endsWith('/students/search'))return json({students:[{id:'student-a',name:'Synthetic Student',status:'active',gradeLevel:'5',referralCount:3,detentionCount:1,latestIncident:'2026-09-26',classes:[{id:'class-a',name:'Grade five'}]},{id:'student-b',name:'Zero Notes',status:'active',gradeLevel:'5',referralCount:0,detentionCount:0,latestIncident:null,classes:[]}],range,nextCursor:null});
    if(url.pathname.endsWith('/students/student-a/history'))return json({student:{id:'student-a',name:'Synthetic Student',status:'active',classes:[{id:'class-a',name:'Grade five'}]},records:[record()],range,nextCursor:null});
    if(url.pathname.endsWith('/drafts')){state.createdDrafts.push(body);if(!state.draft)state.draft={...body,id:'draft-a',revision:1,studentName:'Synthetic Student',className:body.groupId?'Grade five':null,attachments:[]};return json({created:true,draft:state.draft},201);}
    if(url.pathname.endsWith('/draft-a/draft')){if(method==='PATCH'){state.draft={...state.draft,...body,revision:state.draft.revision+1};}if(method==='DELETE'){if(state.failCancel){state.failCancel=false;return json({error:'Synthetic cancellation interruption'},503);}return json({cancelled:true});}return json({draft:state.draft});}
    if(url.pathname.endsWith('/draft-a/attachments')){state.draft.revision++;const attachment={id:'draft-form-a',filename:body.filename,contentType:body.contentType,status:'pending'};state.draft.attachments.push(attachment);return json({attachment,revision:state.draft.revision},201);}
    if(url.pathname.endsWith('/duplicates'))return json({candidates:state.duplicates});
    if(url.pathname.endsWith('/finalize')){state.finalizations.push(body);if(state.finalizeStatus!==200){const status=state.finalizeStatus;state.finalizeStatus=200;return json({error:'Synthetic save interruption'},status);}return json({receipt:{recordId:'record-a'},record:record()});}
    if(url.pathname.endsWith('/search'))return json({records:body.scope==='own'?[]:[record()],nextCursor:null});
    if(url.pathname.endsWith('/export'))return route.fulfill({contentType:'text/csv',body:'student\nSynthetic Student'});
    if(url.pathname.endsWith('/record-a')){if(state.recordStatus!==200)return json({error:'Record temporarily unavailable'},state.recordStatus);if(url.searchParams.has('versionsCursor'))return json({record:{...record(state.revision),versions:[version(1,'Earliest submission')],nextVersionsCursor:null}});return json({record:{...record(state.revision),submittedBy:{id:state.recordAuthor,name:'Synthetic Teacher'},...(state.withdrawn?{status:'withdrawn',canWithdraw:false}:{})}});}
    return json({error:'Unexpected synthetic endpoint'},404);
  });
  await page.goto(`${base}/__discipline?mode=${mode}${options.route ? `&route=${encodeURIComponent(options.route)}` : ''}${options.shell ? '&shell=1' : ''}`, { timeout: 30000 });await page.waitForLoadState('networkidle');assert.deepEqual(errors,[]);return{page,requests,errors,state};
}
const noOverflow=async page=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);

test('admin origin survives student and record drilldowns, errors and return to the Admin Panel',async()=>{
 const {page,state,errors}=await setup('navigation',{route:'/classpilot/discipline-records?entry=admin'});try{
  await page.getByRole('button',{name:'Admin Panel',exact:true}).waitFor();
  await page.getByRole('button',{name:'Synthetic Student',exact:true}).click();
  await page.getByRole('link').filter({has:page.getByRole('heading',{name:'Version 3'})}).click();
  await page.getByRole('link',{name:'All discipline records',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Current route').textContent(),'/classpilot/discipline-records/record-a?entry=admin');
  await page.getByRole('link',{name:'All discipline records',exact:true}).click();
  await page.getByRole('heading',{name:'Discipline logs',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Current route').textContent(),'/classpilot/discipline-records?entry=admin');
  state.recordStatus=404;await page.getByRole('button',{name:'Synthetic Student',exact:true}).click();
  await page.getByRole('link').filter({has:page.getByRole('heading',{name:'Version 3'})}).click();
  await page.getByRole('heading',{name:'Record unavailable'}).waitFor();
  assert.equal(await page.getByRole('link',{name:'All records',exact:true}).getAttribute('href'),'/classpilot/discipline-records?entry=admin');
  await page.getByRole('button',{name:'Admin Panel',exact:true}).click();
  await page.getByRole('heading',{name:'Admin destination'}).waitFor();assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

test('manual composer links and saved records retain admin origin and paperwork starts with the same origin',async()=>{
 const {page,state,errors}=await setup('navigation',{route:'/classpilot/discipline-records?entry=admin',duplicates:[{id:'record-a',revision:4,entryDate:'2026-09-26',title:'Existing incident',canAddEvidence:true}]});try{
  await page.getByRole('button',{name:'Add incident',exact:true}).click();await page.getByLabel('Student',{exact:true}).selectOption('student-a');await page.getByLabel('Incident date',{exact:true}).fill('2026-09-26');await page.getByLabel('Factual information').fill('Synthetic incident.');
  await page.getByRole('button',{name:'Review incident',exact:true}).click();await page.getByRole('heading',{name:'Possible existing incidents'}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Review existing record'}).getAttribute('href'),'/classpilot/discipline-records/record-a?entry=admin');
  await page.getByLabel('How should this form be saved?').selectOption('separate');await page.getByLabel('I reviewed the student, date, factual information, and selected forms.').check();await page.getByRole('button',{name:'Save disciplinary record'}).click();
  await page.getByRole('link',{name:'All discipline records',exact:true}).waitFor();assert.equal(state.finalizations.length,1);assert.equal(await page.getByLabel('Current route').textContent(),'/classpilot/discipline-records/record-a?entry=admin');
  await page.getByRole('link',{name:'All discipline records',exact:true}).click();await page.getByRole('button',{name:'Add from paperwork',exact:true}).click();await page.getByRole('heading',{name:'Paperwork destination'}).waitFor();
  assert.equal(await page.getByLabel('Current route').textContent(),'/classpilot/my-desk/imports?destination=discipline&entry=admin');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

test('teacher and unknown origins return to ClassPilot; an admin marker never grants school scope',async()=>{
 for(const route of ['/classpilot/discipline-records','/classpilot/discipline-records?entry=https%3A%2F%2Fexample.invalid&returnTo=https%3A%2F%2Fexample.invalid']){
  const {page,requests,errors}=await setup('navigation',{route,canViewSchool:false});try{
   await page.getByRole('button',{name:'ClassPilot',exact:true}).waitFor();assert.equal(await page.getByText('My Desk',{exact:true}).count(),1);await page.getByRole('button',{name:'Synthetic Student',exact:true}).click();await page.getByRole('link').filter({has:page.getByRole('heading',{name:'Version 3'})}).click();
   assert.equal(await page.getByRole('link',{name:'All discipline records',exact:true}).getAttribute('href'),'/classpilot/discipline-records');
   assert.ok(requests.filter(row=>row.path.endsWith('/students/search')).every(row=>row.body.scope==='assigned'));
   await page.getByRole('button',{name:'ClassPilot',exact:true}).click();await page.getByRole('heading',{name:'ClassPilot destination'}).waitFor();assert.deepEqual(errors,[]);
  }finally{await page.close();}
 }
 const forged=await setup('navigation',{route:'/classpilot/discipline-records?entry=admin',canViewSchool:false});try{assert.equal(forged.requests.find(row=>row.path.endsWith('/students/search')).body.scope,'assigned');assert.equal(await forged.page.getByRole('option',{name:'All my grades',exact:true}).count(),1);}finally{await forged.page.close();}
});

test('school-year fallbacks show effective all dates with accurate admin settings actions and matched exports',async()=>{
 for(const range of [
  {period:'all',from:null,to:null,noticeCode:'SCHOOL_YEAR_NOT_CONFIGURED',notice:'Showing all dates because school year dates have not been configured.'},
  {period:'all',from:null,to:null,noticeCode:'SCHOOL_YEAR_OUTSIDE_RANGE',notice:'Showing all dates because today is outside the configured school year.',configuredSchoolYear:{from:'2025-08-01',to:'2026-06-30'}},
 ]){
  const {page,requests,errors}=await setup('admin',{range});try{
   assert.equal(await page.getByLabel('Period',{exact:true}).inputValue(),'all');await page.getByText(range.notice,{exact:true}).waitFor();
   const action=page.getByRole('link',{name:range.noticeCode==='SCHOOL_YEAR_NOT_CONFIGURED'?'Set school year dates':'Review school year dates',exact:true});assert.equal(await action.getAttribute('href'),'/classpilot/admin/classes/scheduling?section=bells');
   if(range.configuredSchoolYear)await page.getByText('Configured school year: 2025-08-01 to 2026-06-30.',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Export student summary CSV'}).click();await page.waitForTimeout(100);const exported=requests.find(row=>row.path.endsWith('/students/export'));assert.equal(exported.body.period,'all');assert.equal(exported.body.from,undefined);assert.equal(exported.body.to,undefined);assert.deepEqual(errors,[]);
  }finally{await page.close();}
 }
});

test('teachers get school-year guidance and custom ranges remain explicit; valid years export the displayed dates',async()=>{
 const {page,requests,errors}=await setup('library',{canViewSchool:false});try{
  await page.getByText('Ask a school administrator to set the school year dates.',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Set school year dates'}).count(),0);
  const before=requests.filter(row=>row.path.endsWith('/students/search')).length;await page.getByLabel('Period',{exact:true}).selectOption('custom');await page.getByLabel('From',{exact:true}).fill('2026-09-01');await page.waitForTimeout(100);assert.equal(requests.filter(row=>row.path.endsWith('/students/search')).length,before);
  await page.getByLabel('To',{exact:true}).fill('2026-09-30');await page.getByRole('button',{name:'Synthetic Student',exact:true}).waitFor();assert.equal(await page.getByLabel('Period',{exact:true}).inputValue(),'custom');await page.getByRole('button',{name:'Export student summary CSV'}).click();await page.waitForTimeout(100);
  const exported=requests.find(row=>row.path.endsWith('/students/export'));assert.equal(exported.body.period,'custom');assert.equal(exported.body.from,'2026-09-01');assert.equal(exported.body.to,'2026-09-30');assert.deepEqual(errors,[]);
 }finally{await page.close();}
 const active=await setup('library',{range:{period:'school_year',from:'2026-08-01',to:'2027-06-30'}});try{
  assert.equal(await active.page.getByLabel('Period',{exact:true}).inputValue(),'school_year');assert.equal(await active.page.getByRole('link',{name:'Set school year dates'}).count(),0);
  await active.page.getByRole('button',{name:'Export student summary CSV'}).click();await active.page.waitForTimeout(100);const exported=active.requests.find(row=>row.path.endsWith('/students/export'));assert.equal(exported.body.period,'custom');assert.equal(exported.body.from,'2026-08-01');assert.equal(exported.body.to,'2027-06-30');
 }finally{await active.page.close();}
});

test('explicit school submission shares only selected forms and retries unfinished entries with stable keys',async()=>{
  const {page,state,errors}=await setup('submit');try{
    await page.getByRole('button',{name:'Add to discipline log',exact:true}).click();await page.getByRole('heading',{name:'Review school log submission'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Submit 2 entries to school log'}).isDisabled(),true);
    await page.getByLabel('Include synthetic.png').first().uncheck();await page.getByLabel('I reviewed the selected entries and forms for submission.').check();
    await page.getByRole('button',{name:'Submit 2 entries to school log'}).click();await page.getByText(/Synthetic interrupted response/).waitFor();
    assert.equal(state.submissions[0].attachmentIds.length,0);assert.equal(state.submissions[1].attachmentIds.length,1);
    await page.getByRole('button',{name:'Retry 1 remaining'}).click();await page.getByText('2 school records submitted. Your private notes are unchanged.').waitFor();
    assert.deepEqual(state.submissions[1],state.submissions[2]);assert.equal(state.submissions.filter(row=>row.noteId==='note-a').length,1);await noOverflow(page);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('capability refresh503 preserves reviewed selections,403 removes private review, and more than50 is never truncated',async()=>{
  const {page,state,errors}=await setup('submit');try{await page.getByRole('button',{name:'Add to discipline log',exact:true}).click();await page.getByLabel('I reviewed the selected entries and forms for submission.').check();state.capabilityStatus=503;await page.evaluate(()=>window.refreshDiscipline());assert.equal(await page.getByLabel('I reviewed the selected entries and forms for submission.').isChecked(),true);state.capabilityStatus=403;await page.evaluate(()=>window.refreshDiscipline());await page.getByRole('heading',{name:'Review school log submission'}).waitFor({state:'hidden'});assert.deepEqual(errors,[]);}finally{await page.close();}
  const limited=await setup('limit');try{await limited.page.getByText(/None of these 51 notes were submitted/).waitFor();assert.equal(limited.requests.filter(row=>row.path.includes('/mydesk/notes/')).length,0);assert.equal(limited.state.submissions.length,0);}finally{await limited.page.close();}
});
test('student-first directory displays complete totals and zero-note students with matched private POST exports',async()=>{
 const {page,requests,errors}=await setup('library');try{
  await page.getByRole('heading',{name:'Discipline logs',exact:true}).waitFor();const row=page.getByRole('row').filter({has:page.getByRole('button',{name:'Synthetic Student',exact:true})});assert.match(await row.innerText(),/3\s+1/);await page.getByRole('button',{name:'Zero Notes'}).waitFor();
  await page.getByLabel('Incident type',{exact:true}).selectOption('detention');await page.getByLabel('Recording teacher').fill('Synthetic');await page.waitForTimeout(150);await page.getByRole('button',{name:'Export student summary CSV'}).click();await page.waitForTimeout(100);
  const exported=requests.find(row=>row.path.endsWith('/students/export'));assert.equal(exported.body.incidentType,'detention');assert.equal(exported.body.submitterName,'Synthetic');assert.equal(exported.body.scope,'assigned');assert.equal(exported.query,'');
  await page.getByRole('button',{name:'Synthetic Student',exact:true}).click();await page.getByRole('heading',{name:'Version 3'}).waitFor();await page.getByRole('button',{name:'Export incidents CSV'}).click();await page.waitForTimeout(100);const incident=requests.filter(row=>row.path.endsWith('/export')&&!row.path.endsWith('/students/export')).at(-1);assert.equal(incident.body.studentId,'student-a');assert.equal(incident.body.incidentType,'detention');await noOverflow(page);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

test('correction conflict retains draft, requires latest-version review, and hides unsaved text when printing',async()=>{
  const {page,state,errors}=await setup('record');try{await page.getByRole('button',{name:'Correct submission',exact:true}).click();await page.waitForTimeout(100);assert.deepEqual(errors,[]);await page.getByLabel('Title',{exact:true}).fill('Unsaved private correction');await page.getByLabel('Reason for correction').fill('Synthetic reason');await page.getByLabel('I reviewed the corrected entry and selected forms.').check();await page.getByRole('button',{name:'Submit correction',exact:true}).click();await page.getByRole('button',{name:'Review latest saved version'}).click();await page.getByRole('heading',{name:'Latest saved submission'}).waitFor();assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Unsaved private correction');await page.getByRole('button',{name:'Keep my draft against this version'}).click();assert.equal(await page.getByLabel('I reviewed the corrected entry and selected forms.').isChecked(),false);
    state.recordStatus=503;await page.evaluate(()=>window.refreshDiscipline());assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Unsaved private correction');state.recordStatus=200;
    await page.screenshot({path:path.join(os.tmpdir(),'schoolpilot-discipline-correction-phone.png'),fullPage:true});await page.emulateMedia({media:'print'});assert.equal(await page.getByRole('dialog').isVisible(),false);assert.equal(await page.locator('body > .fixed.inset-0[data-state=open]').isVisible(),false);await page.screenshot({path:path.join(os.tmpdir(),'schoolpilot-discipline-print.png'),fullPage:true});await page.emulateMedia({media:'screen'});
    await page.getByLabel('I reviewed the corrected entry and selected forms.').check();await page.getByRole('button',{name:'Submit correction',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(state.correctionCalls[1].revision,4);assert.equal(state.correctionCalls[1].title,'Unsaved private correction');assert.deepEqual(state.correctionCalls[1].attachmentIds,[]);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('history loads older version pages; revoked attachment URLs and switched owner content clear',async()=>{
  const {page,state,requests,errors}=await setup('record');try{await page.getByRole('button',{name:'Show version history'}).click();await page.getByRole('button',{name:'Older versions'}).click();await page.getByRole('heading',{name:'Earliest submission'}).waitFor();assert.ok(requests.some(row=>row.query==='?versionsCursor=2'));await page.getByRole('button',{name:'View submitted forms (1)'}).first().click();await page.getByRole('img',{name:'synthetic.png'}).waitFor();state.blobStatus=403;await page.evaluate(()=>window.refreshDiscipline());await page.getByRole('img',{name:'synthetic.png'}).waitFor({state:'hidden'});assert.ok(await page.evaluate(()=>window.__revoked.length>0));state.recordStatus=403;await page.getByRole('button',{name:'Switch author'}).click();await page.getByRole('heading',{name:'Record unavailable'}).waitFor();assert.equal(await page.getByText('Synthetic submitted summary.').count(),0);assert.deepEqual(errors,[]);}finally{await page.close();}
});
test('administrator entry defaults to all grades and automatic school scope without a grant control',async()=>{
 const {page,requests,errors}=await setup('admin');try{await page.getByRole('heading',{name:'Discipline logs'}).waitFor();assert.equal(await page.getByLabel('Grade filter').inputValue(),'');assert.equal(await page.getByRole('option',{name:'All grades'}).count(),1);assert.equal(await page.getByRole('group',{name:'View by'}).count(),0);assert.equal(requests.find(row=>row.path.endsWith('/students/search')).body.scope,'school');assert.equal(requests.some(row=>row.path.includes('/access')),false);await noOverflow(page);assert.deepEqual(errors,[]);}finally{await page.close();}
});

test('withdrawal conflict preserves reason and requires refreshed record before retry',async()=>{
  const {page,state,errors}=await setup('record');try{state.withdrawConflict=true;await page.getByRole('button',{name:'Withdraw submission',exact:true}).click();await page.getByLabel('Withdrawal reason',{exact:true}).fill('Synthetic withdrawal reason');await page.getByRole('button',{name:'Confirm withdrawal'}).click();await page.getByRole('button',{name:'Review latest before withdrawal'}).waitFor();assert.equal(await page.getByRole('button',{name:'Confirm withdrawal'}).isDisabled(),true);await page.getByRole('button',{name:'Review latest before withdrawal'}).click();await page.getByText('Review the latest saved entry above before confirming withdrawal. Your reason is preserved.').waitFor();assert.equal(await page.getByLabel('Withdrawal reason',{exact:true}).inputValue(),'Synthetic withdrawal reason');await page.getByRole('button',{name:'Confirm withdrawal'}).click();await page.getByText('This submission was withdrawn and is retained as history. It is not an active incident record.').waitFor();assert.equal(state.withdrawals[1].revision,4);assert.equal(state.withdrawals[1].reason,'Synthetic withdrawal reason');assert.deepEqual(errors,[]);}finally{await page.close();}
});


test('administrator demotion rechecks a cached record and removes content denied by current assignment',async()=>{
 const {page,state,errors}=await setup('record',{recordAuthor:'another-author'});try{await page.getByRole('heading',{name:'Synthetic Student'}).waitFor();state.canViewSchool=false;state.recordStatus=404;await page.evaluate(()=>window.refreshDiscipline());await page.getByRole('heading',{name:'Record unavailable'}).waitFor();assert.equal(await page.getByText('Synthetic submitted summary.').count(),0);assert.deepEqual(errors,[]);}finally{await page.close();}
});

test('correcting past-class evidence uses only private student history with its exact class filter',async()=>{
  const {page,requests,errors}=await setup('record');try{await page.getByRole('button',{name:'Correct submission',exact:true}).click();await page.getByLabel('Replace forms with attachments from a private note').check();await page.getByRole('option',{name:'2025-01-01 — Preserved past-class evidence'}).waitFor({state:'attached'});const history=requests.find(row=>row.path.endsWith('/students/student-a/history'));assert.equal(history.method,'POST');assert.equal(history.query,'');assert.equal(history.body.classId,'class-a');assert.equal(requests.filter(row=>row.path.endsWith('/notes/search')).length,0);assert.deepEqual(errors,[]);}finally{await page.close();}
});


test('manual entry reviews student, optional class, both counts and uploaded evidence without creating a private note',async()=>{
 const {page,state,requests,errors}=await setup('composer',{finalizeStatus:503});try{
  await page.getByLabel('Student',{exact:true}).selectOption('student-a');await page.getByLabel('Class (optional)').selectOption('class-a');await page.getByLabel('Incident date',{exact:true}).fill('2026-09-26');await page.getByLabel('Detention assigned',{exact:true}).check();await page.getByLabel('Detention dates, if specified').fill('2026-09-27\n2026-09-28');await page.getByLabel('Factual information').fill('Teacher observed the event; detention assigned.');
  await page.locator('input[type=file][multiple]').setInputFiles({name:'reviewed.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'Review incident',exact:true}).click();await page.getByRole('heading',{name:'Review the record'}).waitFor();await page.getByRole('img',{name:'reviewed.png'}).waitFor();assert.equal(await page.getByRole('button',{name:'Save disciplinary record'}).isDisabled(),true);await page.getByLabel('I reviewed the student, date, factual information, and selected forms.').check();await page.getByRole('button',{name:'Save disciplinary record'}).click();await page.getByText(/Synthetic save interruption/).waitFor();await page.getByRole('button',{name:'Retry save'}).click();await page.waitForFunction(()=>window.__saved==='record-a');
  assert.equal(state.createdDrafts.length,1);assert.equal(state.createdDrafts[0].referralRecorded,true);assert.equal(state.createdDrafts[0].detentionAssigned,true);assert.deepEqual(state.createdDrafts[0].detentionDates,['2026-09-27','2026-09-28']);assert.equal(state.finalizations[0].revision,2);assert.deepEqual(state.finalizations[0],state.finalizations[1]);assert.equal(requests.some(row=>row.path.includes('/mydesk/notes')),false);await noOverflow(page);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

test('manual duplicate review acknowledges exact revisions and changing fields invalidates review',async()=>{
 const {page,state,errors}=await setup('composer',{duplicates:[{id:'record-a',revision:4,entryDate:'2026-09-26',title:'Existing incident',canAddEvidence:true}]});try{
  await page.getByLabel('Student',{exact:true}).selectOption('student-a');await page.getByLabel('Incident date',{exact:true}).fill('2026-09-26');await page.getByLabel('Factual information').fill('Separate synthetic event.');await page.getByRole('button',{name:'Review incident',exact:true}).click();await page.getByRole('heading',{name:'Possible existing incidents'}).waitFor();await page.getByLabel('I reviewed the student, date, factual information, and selected forms.').check();assert.equal(await page.getByRole('button',{name:'Save disciplinary record'}).isDisabled(),true);await page.getByLabel('How should this form be saved?').selectOption('separate');assert.equal(await page.getByLabel('I reviewed the student, date, factual information, and selected forms.').isChecked(),false);await page.getByLabel('I reviewed the student, date, factual information, and selected forms.').check();await page.getByRole('button',{name:'Save disciplinary record'}).click();await page.waitForFunction(()=>window.__saved==='record-a');assert.deepEqual(state.finalizations[0].acknowledgedDuplicates,[{id:'record-a',revision:4}]);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});


test('admin incident composer uses one discard prompt and retains the draft if cleanup fails', async () => {
  const { page, requests, errors } = await setup('navigation', { shell: true, route: '/classpilot/discipline-records?entry=admin', failCancel: true });
  try {
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
    await page.getByRole('button', { name: 'Add incident', exact: true }).click();
    await page.getByLabel('Student', { exact: true }).selectOption('student-a');
    await page.getByLabel('Incident date', { exact: true }).fill('2026-09-26');
    await page.getByLabel('Factual information').fill('Retain this unfinished incident');
    await page.getByRole('button', { name: 'Review incident', exact: true }).click();
    await page.getByRole('heading', { name: 'Review the record' }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').waitFor(); assert.equal(await page.getByRole('alertdialog').count(), 1);
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(requests.filter(row => row.method === 'DELETE').length, 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByText('Synthetic cancellation interruption', { exact: false }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Add incident' }).count(), 1);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByRole('dialog', { name: 'Add incident' }).waitFor({ state: 'hidden' });
    const deletions = requests.filter(row => row.method === 'DELETE'); assert.equal(deletions.length, 2); assert.deepEqual(deletions[0].body, deletions[1].body);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('admin incident save navigates to its record with origin and no stale draft prompt', async () => {
  const { page, state, errors } = await setup('navigation', { shell: true, route: '/classpilot/discipline-records?entry=admin' });
  try {
    await page.getByRole('button', { name: 'Add incident', exact: true }).click();
    await page.getByLabel('Student', { exact: true }).selectOption('student-a');
    await page.getByLabel('Incident date', { exact: true }).fill('2026-09-26');
    await page.getByLabel('Factual information').fill('Reviewed incident');
    await page.getByRole('button', { name: 'Review incident', exact: true }).click();
    await page.getByLabel('I reviewed the student, date, factual information, and selected forms.').check();
    await page.getByRole('button', { name: 'Save disciplinary record' }).click();
    await page.getByRole('link', { name: 'All discipline records', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Current route').textContent(), '/classpilot/discipline-records/record-a?entry=admin');
    assert.equal(await page.getByRole('alertdialog').count(), 0); assert.equal(state.finalizations.length, 1); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
