import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base='http://127.0.0.1:4187';
const server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','4187','--strictPort'],{cwd:root,stdio:'pipe',windowsHide:true});
let browser;
try {
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(ready,'Vite started');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100},serviceWorkers:'block'});
  const actions=[];const errors=[];let rules=[];let denied=false;
  page.on('pageerror',error=>errors.push(error.message));
  const report={case:{id:'case-a',student_id:'student-a',first_name:'Sample',last_name:'Student',status:'open',revision:1,opened_at:'2026-09-05T14:00:00Z',assigned_to:null},timezone:'America/New_York',administrators:[{id:'admin-a',first_name:'School',last_name:'Admin',email:'admin@example.test'}],events:[],notifications:[{alert_id:'alert-a',recipient:'admin@example.test',kind:'initial',status:'sent',completed_at:'2026-09-05T14:01:00Z'}],alerts:[
    {id:'alert-a',revision:0,concern:'self-harm',severity:'high',classification_source:'search',matched_term:'sample rule',reason:'A reviewed search rule matched this observation.',confidence:null,first_seen_at:'2026-09-05T14:00:00Z',last_seen_at:'2026-09-05T14:04:00Z',observation_count:12,url:'https://example.test/search?q=sample&x=1#one',domain:'example.test',websitePolicy:{policyRevision:7,blocked:false,enforcement:{pending:2}}},
    {id:'alert-b',revision:0,concern:'bullying',severity:'low',source_type:'mailpilot',confidence:null,first_seen_at:'2026-09-05T14:03:00Z',last_seen_at:'2026-09-05T14:03:00Z',observation_count:1,url:null,domain:null},
  ]};
  await page.route('https://fonts.**/**',route=>route.fulfill({body:''}));
  await page.route('**/api/**',async route=>{
    const request=route.request();const url=new URL(request.url());let body={};let status=200;
    if(request.method()==='GET'){
      if(url.pathname.endsWith('/cases'))body={items:[{...report.case,unreviewed_count:2}],nextCursor:null};
      else if(url.pathname.endsWith('/cases/case-a')){
        const olderAlerts=url.searchParams.has('alertCursor'),olderEvents=url.searchParams.has('eventCursor');
        body=denied?{error:'Forbidden'}:{...report,
          alerts:olderAlerts?[{...report.alerts[1],id:'alert-older',reason:'An older retained concern.'}]:report.alerts,
          alertPage:{nextCursor:olderAlerts?null:'alert-page-two'},
          events:[{id:olderEvents?'event-older':'event-newer',kind:'case_note',actor_id:'admin-a',created_at:'2026-09-05T14:04:00Z',note:olderEvents?'Older administrator note.':'Latest administrator note.'}],
          eventPage:{nextCursor:olderEvents?null:'event-page-two'},
        };status=denied?403:200;
      }
      else if(url.pathname.endsWith('/approved-urls'))body={items:rules};
      else body={csrfToken:'fixture-token'};
    } else {
      const submitted=request.postDataJSON()||{};actions.push({path:url.pathname,method:request.method(),body:submitted});
      if(url.pathname.endsWith('/actions') && submitted.action==='acknowledge'){
        report.case.revision++;
        for(const alert of report.alerts){alert.acknowledged_at=new Date().toISOString();alert.revision++;}
      }
      if(url.pathname.endsWith('/review')){report.alerts[0].reviewed_at=new Date().toISOString();report.alerts[0].revision++;if(submitted.action==='suppress'){report.alerts[0].suppressed=true;rules=[{id:'rule-a',url:report.alerts[0].url,created_at:new Date().toISOString()}];}}
      if(request.method()==='DELETE'){rules=[];report.alerts[0].suppressed=false;}
      if(url.pathname.endsWith('/block-website')){report.alerts[0].websitePolicy.blocked=true;}
      body={ok:true};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${base}/safety-center-regression.html?case=case-a`,{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Sample Student',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Block website',exact:true}).isDisabled(),true,'Mail alert cannot invent a browser URL');
  assert.equal(await page.getByRole('button',{name:'Stop alerts for this URL',exact:true}).nth(1).isDisabled(),true);
  await page.getByRole('button',{name:'Acknowledge current alerts',exact:true}).click();
  await page.getByText(/Follow-up stopped · Assessment still pending/).nth(1).waitFor();
  assert.equal(actions.at(-1).body.action,'acknowledge');
  assert.equal(actions.at(-1).body.revision,1);
  assert.equal(await page.getByRole('button',{name:'Mark reviewed',exact:true}).count(),2,'Acknowledgment must leave both assessments available for review');
  assert(report.alerts.every(alert=>!alert.reviewed_at),'Acknowledgment does not classify or review alerts');
  await page.getByRole('button',{name:'Mark reviewed',exact:true}).first().click();
  await page.waitForFunction(()=>document.body.textContent.includes('Reviewed'));
  assert.equal(actions.at(-1).body.action,'review');
  await page.getByRole('button',{name:'Stop alerts for this URL',exact:true}).first().click();
  await page.getByRole('alertdialog').waitFor();
  assert.match(await page.getByRole('alertdialog').innerText(),/search\?q=sample&x=1#one/);
  await page.getByRole('button',{name:'Approve exact URL',exact:true}).click();
  await page.getByText('URL approved',{exact:true}).waitFor();
  assert.equal(actions.at(-1).body.action,'suppress');
  assert.equal('url' in actions.at(-1).body,false,'server derives URL from alert');
  await page.getByRole('button',{name:'Approved URLs',exact:true}).click();
  await page.getByRole('button',{name:'Revoke approval',exact:true}).click();
  await page.getByText('No approved URLs.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Student reports',exact:true}).click();
  await page.getByRole('button',{name:'Block website: example.test',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'Block website',exact:true}).click();
  await page.getByText(/Block saved/).waitFor();
  assert.equal(actions.at(-1).body.policyRevision,7);
  await page.getByRole('button',{name:'Older alerts',exact:true}).click();
  await page.getByText('An older retained concern.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('alertCursor'),'alert-page-two');
  await page.getByRole('button',{name:'Older actions',exact:true}).click();
  await page.getByText('Older administrator note.',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('alertCursor'),'alert-page-two','action pagination preserves alert context');
  await page.getByRole('button',{name:'Newest alerts',exact:true}).click();
  await page.getByRole('button',{name:'Block website: example.test',exact:true}).waitFor();
  await page.getByRole('button',{name:'Newest actions',exact:true}).click();
  await page.getByText('Latest administrator note.',{exact:true}).waitFor();
  const hours=page.getByRole('region',{name:'Monitoring hours',exact:true});
  const timezone=hours.getByRole('textbox',{name:'School timezone',exact:true});
  assert.equal(await timezone.inputValue(),'America/Chicago','Show the canonical timezone supplied by the school settings DTO');
  assert.equal(await timezone.isEditable(),false,'Monitoring hours cannot edit the canonical school clock');
  assert.equal(await timezone.getAttribute('readonly'),'');
  await hours.getByText('The school profile timezone also controls class schedules. Update it through school administration.',{exact:true}).waitFor();
  await hours.getByLabel('Start',{exact:true}).fill('08:30');
  const savedHours=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/settings'&&response.request().method()==='POST');
  await hours.getByRole('button',{name:'Save monitoring hours',exact:true}).click();await savedHours;
  assert.equal(actions.at(-1).path,'/api/settings');
  assert.equal(actions.at(-1).body.trackingStartTime,'08:30');
  assert.equal('schoolTimezone' in actions.at(-1).body,false,'Saving monitoring hours cannot submit a separate timezone override');
  assert.equal(await timezone.inputValue(),'America/Chicago');
  await mkdir(path.join(root,'artifacts/classpilot-roadmap'),{recursive:true});
  await page.screenshot({path:path.join(root,'artifacts/classpilot-roadmap/safety-center.png'),fullPage:true});
  denied=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'unavailable'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Safety Center browser: acknowledgment stops follow-up without assessment, review, exact approval/revoke, website block, independent alert/action pagination, unavailable URL, denied report, and Monitoring Hours readonly canonical timezone/save payload passed.');
} finally {await browser?.close();server.kill();}
