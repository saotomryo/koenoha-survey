import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSurvey } from '../lib/domain.js';
import { newReport, advanceReport, publicReport, editReport, setPublication, clusterOpinions } from '../lib/reports.js';
import {createApp} from '../lib/app.js';
import {LocalStore} from '../lib/storage.js';
import {saveReport,loadReport,withReportLock} from '../lib/report-storage.js';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

process.env.ADMIN_PASSWORD='test-admin-password';
process.env.SESSION_SECRET='test-report-secret-at-least-32-characters';
async function request(app,url,{method='GET',body,cookie,origin}={}){
 const req=Readable.from(body?[JSON.stringify(body)]:[]);Object.assign(req,{url,method,headers:{host:'localhost','content-type':'application/json','x-survey-request':'1',...(cookie?{cookie}:{}),...(origin?{origin}:{})}});
 let status,headers,raw;await app(req,{writeHead(s,h){status=s;headers=h;},end(v){raw=v;}});return {status,headers,data:JSON.parse(raw)};
}

const survey=()=>normalizeSurvey({id:'event-test',title:'イベント',questions:[{id:'score',label:'満足度',type:'slider'},{id:'comment',label:'感想',type:'longText'}],report:{clusters:4,access:'password'}});
const responses=()=>Array.from({length:8},(_,i)=>({id:`private-${i}`,surveyId:'event-test',createdAt:'2026-10-03',answers:{score:4,comment:i===0?'連絡先 test@example.com':'安全な設定を学びたい'},turns:[{role:'assistant',content:'AI側の意見は使わない'}],questionInterviews:{}}));
const fake={
 async json(kind,input){
  if(kind==='privacy')return {safe:input.map((u,i)=>i)};
  if(kind==='extract')return {opinions:input.map((u,i)=>({text:u.text,sources:[i]}))};
  if(kind==='narrative')return {title:'結果',groups:input.groups.map(g=>({label:'安全設定',keywords:['設定']})),highlights:[{opinion:0,title:'注目',reason:'次回への示唆'}],summary:'要約',discussion:'考察',recommendations:['具体例を用意']};
  if(kind==='finalPrivacy')return {safe:true};
 },
 async embed(texts){return texts.map((_,i)=>[1,i+1,Math.sin(i),Math.cos(i)]);}
};
test('settings validate and default to four clusters',()=>{
 assert.equal(survey().report.clusters,4);
 assert.throws(()=>normalizeSurvey({...survey(),report:{clusters:0}}));
 assert.throws(()=>normalizeSurvey({...survey(),report:{access:'invalid'}}));
});
test('snapshot, privacy, resumed stages and reviewed publication',async()=>{
 const original=responses();let r=newReport(survey(),original);original[1].answers.comment='後から変更';
 assert.throws(()=>publicReport(r));
 let failure=true;
 const ai={...fake,json:async(kind,input)=>{if(kind==='extract'&&failure){failure=false;throw Error('upstream secret');}return fake.json(kind,input);}};
 r=await advanceReport(r,ai);assert.equal(r.excluded,1);assert.equal(r.stage,'extract');
 while(r.stage==='privacy')r=await advanceReport(r,ai);
 await assert.rejects(advanceReport(r,ai));
 assert.equal(r.stage,'extract');
 for(let i=0;i<30&&r.status!=='review';i++)r=await advanceReport(r,ai);
 assert.equal(r.status,'review');assert.equal(r.opinions.length,7);assert.equal(r.requestedClusters,4);
 assert.throws(()=>setPublication(r,{publish:true,reviewed:false}));
 assert.throws(()=>setPublication(r,{publish:true,reviewed:true,password:'short'}));
 const published=setPublication(r,{publish:true,reviewed:true,password:'report-password'});
 assert.equal(published.published,true);
 const output=JSON.stringify(publicReport(published));
 assert.ok(!output.includes('private-'));assert.ok(!output.includes('example.com'));assert.ok(!output.includes('AI側'));assert.ok(!output.includes('passwordHash'));assert.ok(!output.includes('vectors'));
 const edited=editReport(published,{title:'修正',summary:'修正版'});
 assert.equal(published.reviewed,true);assert.equal(edited.reviewed,false);
 assert.equal(edited.published,false);assert.equal(edited.status,'review');assert.equal(edited.summary,'修正版');
 assert.throws(()=>editReport(edited,{opinions:[]}));
 assert.deepEqual(r.snapshot.questions,survey().questions);
});
test('small samples and clustering are deterministic and finite',async()=>{
 const vectors=[[1,0],[.99,.01],[0,1],[.01,.99]];
 const a=await clusterOpinions(vectors,4),b=await clusterOpinions(vectors,4);
 assert.deepEqual(a,b);assert.ok(a.points.flat().every(Number.isFinite));
 const small=await clusterOpinions([[1,0]],4);assert.equal(small.k,1);
});
test('final privacy excludes flagged opinions and rebuilds all references before review',async()=>{
 let r=newReport(survey(),responses());
 for(let i=0;i<30&&r.status!=='review';i++)r=await advanceReport(r,fake);
 const snapshot=r.snapshotHash,originalCount=r.opinions.length;
 r.status='failed';r.stage='finalPrivacy';r.cursor=1;r.privacyReviewed=false;
 const rejecting={...fake,json:async(kind,input)=>kind==='finalPrivacy'?{safe:false}:kind==='privacy'?{safe:input.map((_,i)=>i).filter(i=>i!==1)}:fake.json(kind,input)};
 r=await advanceReport(r,rejecting);
 assert.equal(r.stage,'embed');assert.equal(r.cursor,0);assert.equal(r.opinions.length,originalCount-1);assert.equal(r.excluded,2);
 assert.equal(r.clustering,undefined);assert.equal(r.highlights,undefined);assert.equal(r.published,false);assert.equal(r.snapshotHash,snapshot);
 for(let i=0;i<30&&r.status!=='review';i++)r=await advanceReport(r,fake);
 assert.equal(r.status,'review');assert.equal(r.privacyReviewed,true);assert.equal(r.clustering.points.length,r.opinions.length);
 r.status='failed';r.stage='finalPrivacy';r.cursor=1;
 await assert.rejects(advanceReport(r,{...fake,json:async(kind,input)=>kind==='finalPrivacy'?{safe:false}:fake.json(kind,input)}),/特定できません/);
 r.cursor=0;await assert.rejects(advanceReport(r,rejecting),/生成を停止/);
});
test('uncertain privacy findings proceed to mandatory human review and stay admin-only',async()=>{
 let r=newReport(survey(),responses());
 for(let i=0;i<30&&r.status!=='review';i++)r=await advanceReport(r,fake);
 r.status='failed';r.stage='finalPrivacy';r.cursor=1;r.privacyReviewed=false;
 const cautious={...fake,json:async(kind,input)=>kind==='finalPrivacy'?{decision:'review',findings:[{location:'意見0',reason:'所属の記述だけでは特定可能か判断できない'}]}:fake.json(kind,input)};
 r=await advanceReport(r,cautious);assert.equal(r.status,'review');assert.equal(r.privacyWarnings.length,1);assert.equal(r.opinions.length,7);
 assert.throws(()=>setPublication(r,{publish:true,reviewed:false}));
 const published=setPublication(r,{publish:true,reviewed:true,access:'url'});
 assert.ok(!JSON.stringify(publicReport(published)).includes('privacyWarnings'));
 assert.equal(editReport(r,{summary:'修正後'}).privacyWarnings.length,0);
 r.status='failed';r.stage='finalPrivacy';r.cursor=1;
 await assert.rejects(advanceReport(r,{...fake,json:async()=>({decision:'review',findings:[]})}),/指摘が不正/);
});
test('report API protects private content, checks revision, publishes explicitly and revokes cookies',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'koenoha-report-'));
 try{
  const store=new LocalStore(dir);await store.append('surveys',survey());for(const r of responses())await store.append('responses',r);
  const app=createApp({store,reportAI:fake});
  const login=await request(app,'/api/login',{method:'POST',body:{password:process.env.ADMIN_PASSWORD}});const cookie=login.headers['set-cookie'].split(';')[0];
  const url='/api/admin/surveys/event-test/reports';
  assert.equal((await request(app,url,{cookie})).data.clusters,4);
  for(const clusters of [1,13,2.5,'4'])assert.equal((await request(app,url,{method:'POST',body:{clusters},cookie})).status,400);
  const override=await request(app,url,{method:'POST',body:{clusters:3},cookie});assert.equal(override.status,201);
  const overridden=await loadReport(store,override.data.id);assert.equal(overridden.requestedClusters,3);assert.equal(overridden.snapshot.report.clusters,3);
  assert.equal((await request(app,url,{cookie})).data.clusters,4);
  assert.equal((await request(app,url,{method:'POST',body:{}})).status,401);
  assert.equal((await request(app,url,{method:'POST',body:{},cookie,origin:'https://evil.invalid'})).status,403);
  const created=await request(app,url,{method:'POST',body:{},cookie});assert.equal(created.status,201);const id=created.data.id;
  assert.equal((await request(app,`/api/reports/${id}`)).status,404);
  assert.equal((await request(app,`/api/admin/reports/${id}/step`,{method:'POST',cookie,body:{revision:-1}})).status,409);
  let d;
  for(let i=0;i<20;i++){
   d=(await request(app,`/api/admin/reports/${id}`,{cookie})).data;if(d.status==='review')break;
   assert.equal((await request(app,`/api/admin/reports/${id}/step`,{method:'POST',cookie,body:{revision:d.revision}})).status,200);
  }
  assert.equal(d.status,'review');
  const reviewUrl=`/api/admin/reports/${id}/review`;
  assert.equal((await request(app,reviewUrl,{method:'POST',cookie,body:{revision:d.revision,reviewed:true}})).status,200);
  d=(await request(app,`/api/admin/reports/${id}`,{cookie})).data;assert.equal(d.reviewed,true);
  assert.equal((await request(app,reviewUrl,{method:'POST',cookie,body:{revision:d.revision,reviewed:false}})).status,200);
  d=(await request(app,`/api/admin/reports/${id}`,{cookie})).data;assert.equal(d.reviewed,false);
  const pub=`/api/admin/reports/${id}/publish`;
  assert.equal((await request(app,pub,{method:'POST',cookie,body:{revision:d.revision,publish:true}})).status,400);
  assert.equal((await request(app,pub,{method:'POST',cookie,body:{revision:d.revision,publish:true,reviewed:true,password:'public-report-password'}})).status,200);
  assert.deepEqual((await request(app,`/api/reports/${id}`)).data,{locked:true});
  const unlocked=await request(app,`/api/reports/${id}/unlock`,{method:'POST',body:{password:'public-report-password'}});assert.equal(unlocked.status,200);const reportCookie=unlocked.headers['set-cookie'].split(';')[0];
  const publicData=(await request(app,`/api/reports/${id}`,{cookie:reportCookie})).data;
  assert.ok(!JSON.stringify(publicData).includes('private-'));assert.ok(!JSON.stringify(publicData).includes('snapshot'));
  d=(await request(app,`/api/admin/reports/${id}`,{cookie})).data;
  assert.equal((await request(app,pub,{method:'POST',cookie,body:{revision:d.revision,publish:false}})).status,200);
  assert.equal((await request(app,`/api/reports/${id}`,{cookie:reportCookie})).status,404);
  const saved=await loadReport(store,id);assert.equal(saved.excluded,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('chunked local persistence and concurrent report guards',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'koenoha-report-chunks-'));
 try{
  const store=new LocalStore(dir);const r=newReport(survey(),responses());r.testPayload='x'.repeat(70000)+'😀'.repeat(25000);await saveReport(store,r);assert.deepEqual(await loadReport(store,r.id),r);
  let release;const gate=new Promise(resolve=>release=resolve);const running=withReportLock(store,r.id,()=>gate);
  await assert.rejects(withReportLock(store,r.id,async()=>{}));release();await running;
  await withReportLock(store,r.id,async()=>{});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed jobs persist a safe error and resume the same snapshot',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'koenoha-report-resume-'));
 try{
  const store=new LocalStore(dir);await store.append('surveys',survey());for(const r of responses())await store.append('responses',r);
  let fail=true;const app=createApp({store,reportAI:{...fake,json:async(kind,input)=>{if(fail){fail=false;throw Error('sensitive upstream payload');}return fake.json(kind,input);}}});
  const login=await request(app,'/api/login',{method:'POST',body:{password:process.env.ADMIN_PASSWORD}});const cookie=login.headers['set-cookie'].split(';')[0];
  const created=await request(app,'/api/admin/surveys/event-test/reports',{method:'POST',cookie,body:{}});const id=created.data.id;
  const before=await loadReport(store,id);
  const failed=await request(app,`/api/admin/reports/${id}/step`,{method:'POST',cookie,body:{revision:0}});assert.equal(failed.status,500);
  const saved=await loadReport(store,id);assert.equal(saved.status,'failed');assert.ok(!saved.error.includes('sensitive'));
  assert.equal((await request(app,`/api/admin/reports/${id}/step`,{method:'POST',cookie,body:{revision:0}})).status,200);
  const resumed=await loadReport(store,id);assert.equal(resumed.stage,'extract');assert.equal(resumed.snapshotHash,before.snapshotHash);assert.equal(resumed.excluded,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
