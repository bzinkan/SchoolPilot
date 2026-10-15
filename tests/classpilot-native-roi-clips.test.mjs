import assert from'node:assert/strict';
import test from'node:test';
import sharp from'sharp';
import{planNativeWitnessClips,captureNativeWitnessClips,compareNativeWitnessClips,createNativeScreenshotCapture,createNativeScreenshotDecoder,assertNativeViewportOrigin,SPARSE_NATIVE_LIMITS}from'../scripts/load/run-classpilot-rendered-dashboards.mjs';
const viewport={width:400,height:180};
const origin={width:400,height:180,scrollX:0,scrollY:0,devicePixelRatio:1,visualViewport:{pageLeft:0,pageTop:0,offsetLeft:0,offsetTop:0,width:400,height:180,scale:1}};
const page={evaluate:async()=>structuredClone(origin)};
const red=[216,48,37,255],green=[24,128,57,255];
const row=(id,x,rgba)=>({studentId:id,points:[{x,y:30},{x:x+5,y:40},{x:x+10,y:50}],frame:{ordinal:1,capturedAt:1720000000000,pulseSequence:1,pulseMarker:'a'.repeat(24),jpegSha256:'a'.repeat(64)},previousFrame:null,rgba,previousRgba:null,opacity:1,opacityAnimated:false,displayed:true,decoded:true,geometry:{left:x,top:20,width:30,height:50},contributors:[]});
const rows=[row('1',30,red),row('2',230,green)];for(const card of rows)card.contributors=[card.frame];
const png=async(clip,colour)=>sharp({create:{width:clip.width,height:clip.height,channels:4,background:{r:colour[0],g:colour[1],b:colour[2],alpha:1}}}).png().toBuffer();
const fakeCapture={capture:async(_page,_viewport,clip)=>{const raw=Buffer.alloc(clip.width*clip.height*4);for(let y=0;y<clip.height;y++)for(let x=0;x<clip.width;x++){const value=x+clip.x<100?red:green;for(let channel=0;channel<4;channel++)raw[(y*clip.width+x)*4+channel]=value[channel];}try{return await sharp(raw,{raw:{width:clip.width,height:clip.height,channels:4}}).png().toBuffer();}finally{raw.fill(0);}}};
test('one native bounding ROI preserves every global witness and original margins',()=>{
 const plan=planNativeWitnessClips(rows,{kind:'capture',viewport});assert.equal(plan.clips.length,1);assert.equal(plan.witnessCount,6);
 assert.deepEqual(plan.clips[0],{x:28,y:28,width:215,height:25});
 const shared=planNativeWitnessClips([rows[0],{...rows[0],studentId:'3',points:rows[0].points.map(p=>({...p,y:p.y+90}))}],{kind:'capture',viewport});assert.equal(shared.clips.length,1);assert.equal(shared.witnessCount,6);
});
test('actual PNG decode maps integer global points back to their exact clip pixels',async()=>{
 const plan=planNativeWitnessClips(rows,{kind:'capture',viewport}),bundle=await captureNativeWitnessClips(page,plan,fakeCapture);
 const before=bundle.parts.map(part=>part.png);const result=await compareNativeWitnessClips({bundle,rows,afterRows:rows,kind:'capture',viewport,originAfter:origin},createNativeScreenshotDecoder());
 assert.equal(result.length,2);assert.ok(result.every(r=>r.matched));assert.deepEqual(result.map(r=>r.rgba),[red,green]);assert.ok(before.every(b=>b.every(v=>v===0)));
});
test('duplicated bundle fails closed, retains all planned rows, and releases every PNG',async()=>{
 const plan=planNativeWitnessClips(rows,{kind:'capture',viewport}),bundle=await captureNativeWitnessClips(page,plan,fakeCapture);
 bundle.parts.push({clip:{...bundle.parts[0].clip},png:Buffer.from(bundle.parts[0].png)});const buffers=bundle.parts.map(part=>part.png);
 await assert.rejects(compareNativeWitnessClips({bundle,rows,afterRows:rows,kind:'capture',viewport,originAfter:origin}),/strictly equal/);assert.ok(buffers.every(png=>png.every(v=>v===0)));
});
test('source and geometry changes refuse paint with identical decoded colors',async()=>{
 for(const change of[after=>after[0].frame.jpegSha256='b'.repeat(64),after=>after[0].geometry.top+=1]){
  const after=structuredClone(rows);change(after);const plan=planNativeWitnessClips(rows,{kind:'capture',viewport}),bundle=await captureNativeWitnessClips(page,plan,fakeCapture);
  const result=await compareNativeWitnessClips({bundle,rows,afterRows:after,kind:'capture',viewport,originAfter:origin});assert.equal(result[0].matched,false);
 }
});
test('glyph ROI includes all nine native pixels and fails flat-navy overlay',async()=>{
 const nav={studentId:'1',marker:'marker',matched:true,points:[{x:30,y:30,rgba:red},{x:35,y:30,rgba:red},{x:40,y:30,rgba:red},{x:35,y:45,rgba:red}],glyph:{left:34,top:34,width:3,height:3,white:[255,255,255,255],yellow:[234,179,8,255]}};
 const plan=planNativeWitnessClips([nav],{kind:'navigation',viewport});assert.equal(plan.witnessCount,13);
 const bundle=await captureNativeWitnessClips(page,plan,fakeCapture);const result=await compareNativeWitnessClips({bundle,rows:[nav],afterRows:[nav],kind:'navigation',viewport,originAfter:origin});assert.equal(result[0].matched,false);
});
test('bounds reject fractional/offscreen coordinates, duplicates and excessive columns',()=>{
 for(const value of[{...rows[0],points:[{x:2.5,y:3}]},{...rows[0],points:[{x:0,y:3}]}])assert.throws(()=>planNativeWitnessClips([value],{kind:'capture',viewport}));
 assert.throws(()=>planNativeWitnessClips([rows[0],rows[0]],{kind:'capture',viewport}));
 assert.throws(()=>planNativeWitnessClips(Array.from({length:9},(_,n)=>({...rows[0],studentId:String(n),points:[{x:n*40+10,y:30}]})),{kind:'capture',viewport}));
});
test('unsupported scroll/visual origins and scaling fail before capture',async()=>{
 for(const mutate of[o=>o.scrollY=1,o=>o.visualViewport.pageTop=1,o=>o.visualViewport.offsetLeft=1,o=>o.visualViewport.scale=2,o=>o.devicePixelRatio=2]){
  const altered=structuredClone(origin);mutate(altered);assert.throws(()=>assertNativeViewportOrigin(altered,viewport));
  let calls=0;await assert.rejects(captureNativeWitnessClips({evaluate:async()=>altered},planNativeWitnessClips(rows,{kind:'capture',viewport}),{capture:async()=>{calls++;}}));assert.equal(calls,0);
 }
});
test('whole native capture/decode batch deadline never resets per clip',async()=>{
 const plan=planNativeWitnessClips(rows,{kind:'capture',viewport});let time=0,calls=0;
 await assert.rejects(captureNativeWitnessClips(page,plan,{capture:async(...args)=>{calls++;time+=8100;return png(args[2],red);}},{now:()=>time}),/deadline/);assert.equal(calls,1);
 const bundle=await captureNativeWitnessClips(page,plan,fakeCapture);await assert.rejects(compareNativeWitnessClips({bundle,rows,afterRows:rows,kind:'capture',viewport,originAfter:origin,now:()=>bundle.deadlineAt+1}),/deadline/);
});
test('raw CDP clip is native unscaled and exact PNG dimensions are checked',async()=>{
 const seen=[],session={send:async(_name,params)=>{seen.push(params);return{data:(await png(params.clip,red)).toString('base64')};},detach:async()=>{}};
 const capture=createNativeScreenshotCapture({sessionFactory:async()=>session});const clip={x:28,y:28,width:15,height:25};const bytes=await capture.capture({},viewport,clip);assert.equal(bytes.readUInt32BE(16),15);assert.equal(bytes.readUInt32BE(20),25);assert.deepEqual(seen[0].clip,{...clip,scale:1});assert.equal(seen[0].optimizeForSpeed,true);bytes.fill(0);
 await assert.rejects(capture.capture({},viewport,{...clip,x:399}),/assertion|falsy/i);
});

test('malformed allocated native PNG is zeroed before a dimension failure escapes',async()=>{
 const encoded=(await png({width:1,height:1},red)).toString('base64'),originalFrom=Buffer.from;let allocated;
 Buffer.from=function(value,encoding,...rest){const result=originalFrom.call(Buffer,value,encoding,...rest);if(value===encoded&&encoding==='base64')allocated=result;return result;};
 const capture=createNativeScreenshotCapture({sessionFactory:async()=>({send:async()=>({data:encoded}),detach:async()=>{}})});
 try{await assert.rejects(capture.capture({},viewport,{x:20,y:20,width:2,height:2}));assert.ok(allocated&&allocated.every(value=>value===0));assert.equal(capture.summary().active,0);assert.equal(capture.summary().completed,1);assert.equal(capture.summary().timeouts,0);}finally{Buffer.from=originalFrom;}
});
