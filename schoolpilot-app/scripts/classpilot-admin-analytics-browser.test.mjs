import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer, transformWithEsbuild } from 'vite';

test('adoption health distinguishes failures from unknown availability and isolates school/viewer reads', {timeout:120_000},async context => {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const authModule=`import {createContext,useContext} from 'react'; export const FixtureAuthContext=createContext(null); export const useAuth=()=>useContext(FixtureAuthContext);`;
  const entry=`
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
    import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';
    import{FixtureAuthContext}from'/src/contexts/AuthContext.jsx';import{AdminNavigationContext}from'/src/products/classpilot/hooks/useAdminNavigation.js';
    import AdminAnalytics from'/src/products/classpilot/pages/AdminAnalytics.jsx';import'/src/index.css';
    const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
    function Fixture(){const[school,setSchool]=useState('school-a'),[viewer,setViewer]=useState('viewer-a'),[role,setRole]=useState('admin');
      const value={user:{id:viewer,email:'admin@school.example',firstName:'Fixture',lastName:'Admin',authVersion:1},loading:false,activeSchoolId:school,
        activeMembership:{schoolId:school,schoolName:school,schoolTimezone:'America/New_York',status:'active',role,roles:[role]}};
      return <FixtureAuthContext.Provider value={value}><div><button onClick={()=>setSchool(s=>s==='school-a'?'school-b':'school-a')}>Switch school</button><button onClick={()=>setViewer('viewer-b')}>Switch viewer</button><button onClick={()=>setRole('teacher')}>Revoke admin role</button></div><AdminNavigationContext.Provider value={{shell:true}}><AdminAnalytics/></AdminNavigationContext.Provider></FixtureAuthContext.Provider>;
    }createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><ThemeProvider><MemoryRouter><Fixture/></MemoryRouter></ThemeProvider></QueryClientProvider>);
  `;
  const vite=await createServer({root,cacheDir:path.join(root,'node_modules',`.vite-adoption-${process.pid}`),logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
    name:'adoption-fixture',enforce:'pre',transform(_code,id){if(id.replaceAll('\\','/').endsWith('/src/contexts/AuthContext.jsx'))return{code:authModule,map:null};},
    configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__adoption-test')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__adoption-entry.jsx"></script></body></html>'));});},
    resolveId(id){if(id==='/__adoption-entry.jsx')return'\0adoption-fixture.jsx';},async load(id){if(id==='\0adoption-fixture.jsx')return (await transformWithEsbuild(entry,'adoption-fixture.jsx',{loader:'jsx',jsx:'transform'})).code;}
  }]});
  let browser;context.after(async()=>{await browser?.close();await vite.close();});await vite.listen();browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1365,height:950}});page.setDefaultTimeout(12_000);
  const errors=[],reads=[];let failureError=false,malformedOverview=false,shrinkFailureTotal=false;page.on('pageerror',error=>errors.push(error.message));
  const period=key=>({period:key,timeZone:'America/New_York',startLocalDate:key==='today'?'2026-11-01':key==='30d'?'2026-10-03':'2026-10-26',todayLocalDate:'2026-11-01',rangeStartUtc:'2026-10-26T04:00:00Z',rangeEndUtc:'2026-11-01T18:00:00Z'});
  const counts={completed:4,ready:2,preparing:1,failed:1,unavailable:0};
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),key=url.searchParams.get('period')||'7d',school=route.request().headers()['x-school-id'];
    if(url.pathname.includes('/adoption-health/')){
      const section=url.pathname.split('/').at(-1);reads.push({section,key,school,page:url.searchParams.get('page')});
      if(!school)return route.fulfill({status:400,json:{error:'Active school header missing'}});
      const empty=school==='school-b'||key==='today',common={period:period(key),range:{timeZone:'America/New_York',retainedFrom:'2026-10-03',partiallyRetained:false,asOf:'2026-11-01T18:00:00Z'},basis:'completed_sessions'};
      if(section==='overview'&&malformedOverview)return route.fulfill({json:{...common,summary:{}}});
      if(section==='overview')return route.fulfill({json:{...common,dataState:empty?'empty':'partial',summary:{totalClasses:3,classesWithObservations:empty?0:1,studentsObserved:empty?0:24,totalStudents:135,teachersWithLiveSessions:empty?0:1,completedSessions:empty?0:4,readySummaries:empty?0:2},reportCounts:empty?{completed:0,ready:0,preparing:0,failed:0,unavailable:0}:counts,classes:empty?[]:[{groupId:'math',groupName:'Grade 5 Math',teacherName:'Teacher A',sessionCount:3,daysWithObservations:2,lastObservedAt:'2026-10-30T14:00:00Z',readySummaryCount:2},{groupId:'pending',groupName:'Pending class',teacherName:'Teacher B',sessionCount:1,daysWithObservations:null,lastObservedAt:null,readySummaryCount:0},{groupId:'unused',groupName:'Unused class',teacherName:'Teacher A',sessionCount:0,daysWithObservations:0,lastObservedAt:null,readySummaryCount:0}]}});
      if(section==='failures'){if(failureError)return route.fulfill({status:503,json:{error:'Read unavailable'}});const second=url.searchParams.get('page')==='2';return route.fulfill({json:{...common,total:empty?0:shrinkFailureTotal?20:21,page:second?2:1,pageSize:20,failures:empty||(shrinkFailureTotal&&second)?[]:[{teachingSessionId:second?'failed-second':'failed-first',groupId:'math',className:second?'Archived science':'Grade 5 Math',teacherName:'Teacher A',windowEnd:'2026-10-29T15:00:00Z',failedAt:'2026-10-29T15:05:00Z',attemptCount:second?1:5,reason:'Session summary could not be generated.'}]}});}
      if(section==='availability')return route.fulfill({json:{...common,reportCounts:counts,coveragePercent:54,summariesWithMissingObservations:2,notExpectedStudentRecords:3,unavailableStudentRecords:1,classes:[{groupId:'math',className:'Grade 5 Math',teacherName:'Teacher A',readySummaryCount:2,summariesWithMissingObservations:2,coveragePercent:54,latestReadySessionId:'ready-math',lastSessionEnd:'2026-10-30T15:00:00Z'}]}});
      if(section==='tools')return route.fulfill({json:{...common,totalActions:2,tools:[{commandType:'open-tab',count:2}]}});
      if(section==='clients')return route.fulfill({json:{...common,totalClients:2,versions:[{version:'2.9.7',count:1},{version:null,count:1}]}});
    }
    if(url.pathname.endsWith('/report'))return route.fulfill({json:{state:'failed',error:'Session summary could not be generated'}});
    return route.fulfill({status:404,json:{error:'Not found'}});
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__adoption-test`);
  await page.getByRole('heading',{name:'Needs attention',exact:true}).waitFor().catch(async error=>{console.log(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,1600)}));throw error;});
  await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();
  assert.ok(reads.every(read=>read.key==='7d'&&read.school==='school-a'));
  assert.ok(reads.some(read=>read.section==='overview')&&reads.some(read=>read.section==='failures'));
  assert.equal(reads.some(read=>['availability','tools','clients'].includes(read.section)),false);
  const attention=page.getByRole('region',{name:'Needs attention',exact:true});
  assert.equal(await attention.getByText(/missing observations|coverage|gaps/i).count(),0);
  assert.equal(await page.getByText('Sessions with reporting gaps',{exact:true}).count(),0);
  await page.getByRole('cell',{name:'Unused class',exact:false}).waitFor();
  assert.equal(await page.getByRole('row').filter({hasText:'Pending class'}).getByRole('cell').nth(2).innerText(),'—');
  const availability=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Reporting availability'})});
  assert.equal(await availability.getAttribute('open'),null);
  await availability.locator('summary').focus();await page.keyboard.press('Enter');await page.getByText('54%',{exact:true}).first().waitFor();
  assert.equal(await availability.getByRole('alert').count(),0);assert.ok((await availability.innerText()).includes('unknown cause'));
  await availability.getByRole('button',{name:'View latest summary',exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('Grade 5 Math'));await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'View status',exact:true}).click();await page.getByRole('dialog').waitFor();await page.locator('button').filter({hasText:'Switch viewer'}).evaluate(button=>button.click());
  assert.equal(await page.getByRole('dialog').count(),0,'Viewer change must close the selected report');await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Next failures',exact:true}).click();await page.getByText('Session summary unavailable for Archived science',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Previous failures',exact:true}).click();await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();
  shrinkFailureTotal=true;await page.getByRole('button',{name:'Next failures',exact:true}).click();
  await page.getByText('20 confirmed failures',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Previous failures',exact:true}).isEnabled(),true,'An expired failure must not strand an empty page');
  shrinkFailureTotal=false;await page.getByRole('button',{name:'Previous failures',exact:true}).click();await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();
  await page.getByRole('combobox',{name:'Reporting period',exact:true}).selectOption('today');await page.getByText('No confirmed failures recorded',{exact:true}).waitFor();assert.ok(reads.some(read=>read.key==='today'&&read.section==='overview'));
  failureError=true;await page.getByRole('combobox',{name:'Reporting period',exact:true}).selectOption('30d');await page.getByText('Could not load confirmed failures.',{exact:false}).waitFor();assert.equal(await page.getByText('No confirmed failures recorded',{exact:true}).count(),0);
  failureError=false;malformedOverview=true;await page.getByRole('combobox',{name:'Reporting period',exact:true}).selectOption('today');await page.getByText('Could not load adoption overview.',{exact:true}).waitFor();assert.equal(await page.getByText('Students observed',{exact:true}).count(),0);
  malformedOverview=false;await page.getByRole('combobox',{name:'Reporting period',exact:true}).selectOption('7d');await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Switch school',exact:true}).click();await page.getByText('No confirmed failures recorded',{exact:true}).waitFor();assert.equal(await page.getByText('Grade 5 Math',{exact:true}).count(),0);assert.ok(reads.some(read=>read.school==='school-b'));
  await page.getByRole('button',{name:'Switch school',exact:true}).click();await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();
  await page.locator('details summary').filter({hasText:'Classroom tools used'}).click();await page.getByText('Open tabs',{exact:true}).waitFor();await page.locator('details summary').filter({hasText:'Chromebook reporting details'}).click();await page.getByText('2.9.7',{exact:true}).waitFor();
  assert.ok(reads.some(read=>read.section==='tools')&&reads.some(read=>read.section==='clients'));
  const artifacts=path.join(root,'artifacts','adoption-health');await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'app-desktop.png'),fullPage:true});
  for(const width of [736,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);}
  const mobileTitle=await page.getByText('Session summary unavailable for Grade 5 Math',{exact:true}).boundingBox();assert.ok(mobileTitle.width>=160,'Mobile failure evidence must retain a readable column instead of being squeezed beside its action');
  await page.screenshot({path:path.join(artifacts,'app-mobile.png'),fullPage:true});
  await page.evaluate(()=>localStorage.setItem('sp_theme','dark'));await page.setViewportSize({width:1365,height:950});await page.reload();await page.getByText('Summary generation failed after 5 attempts.',{exact:true}).waitFor();await page.locator('details summary').filter({hasText:'Reporting availability'}).click();await page.getByText('54%',{exact:true}).first().waitFor();await page.screenshot({path:path.join(artifacts,'app-desktop-dark.png'),fullPage:true});
  await page.getByRole('button',{name:'Revoke admin role',exact:true}).click();await page.getByText('Administrator access is required for adoption and reporting health.',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Needs attention',exact:true}).count(),0);assert.deepEqual(errors,[]);
});
