import { randomUUID, createHash, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { UMAP } from 'umap-js';
import { kmeans } from 'ml-kmeans';
import { check, buildResults } from './domain.js';

export const REPORT_STAGES = ['privacy', 'extract', 'embed', 'cluster', 'narrative', 'finalPrivacy'];
export const STAGE_NAMES = { privacy:'個人情報チェック', extract:'意見抽出', embed:'類似度の計算', cluster:'クラスタリング', narrative:'注目意見・考察の作成', finalPrivacy:'公開文面の個人情報チェック', complete:'管理者レビュー待ち' };
const pii = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:https?:\/\/|www\.)\S+|(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{2,4}[-\s]?\d{3,4}|〒\s*\d{3}-?\d{4}/i;
function containsPII(value){return typeof value==='string'?pii.test(value):Array.isArray(value)?value.some(containsPII):value&&typeof value==='object'?Object.values(value).some(containsPII):false;}
const norm = v => { const length=Math.hypot(...v);return length?v.map(x=>x/length):v.map(()=>0); };
const distance = (a,b) => a.reduce((s,v,i)=>s+(v-b[i])**2,0);
const cleanString = (v,max=3000) => { check(typeof v==='string'&&v.length<=max,'AIの出力形式が不正です。',502); return v.trim(); };
export function reportPassword(password, stored) {
  if (!stored) { check(typeof password==='string'&&password.length>=12&&password.length<=128,'レポート用パスワードは12〜128文字です。');const salt=randomBytes(16).toString('hex');return {salt,hash:scryptSync(password,salt,32).toString('hex')}; }
  if(typeof password!=='string'||password.length>128)return false;
  return timingSafeEqual(scryptSync(password,stored.salt,32),Buffer.from(stored.hash,'hex'));
}
export function newReport(survey,responses){
 check(responses.length>0,'回答がありません。');
 check(responses.length<=1000,'初期実装の分析上限は1000回答です。対象を分けてください。');
 const units=[];
 for(const r of responses){
  for(const q of survey.questions){
   if(['text','longText','aiInterview'].includes(q.type)&&typeof r.answers?.[q.id]==='string'&&r.answers[q.id].trim())units.push({text:r.answers[q.id],question:q.label});
   if(r.reasons?.[q.id]?.trim())units.push({text:r.reasons[q.id],question:q.label});
   for(const t of r.questionInterviews?.[q.id]?.turns||[])if(t.role==='user'&&t.content.trim())units.push({text:t.content,question:q.label});
  }
  for(const t of r.turns||[])if(t.role==='user'&&t.content.trim())units.push({text:t.content,question:'アンケート全体'});
 }
 check(units.length<=5000,'分析対象の発言が多すぎます。');
 const stats=buildResults(survey,responses);
 // Never include free text, response IDs or transcripts in public aggregate data.
 const fields=stats.fields.filter(f=>f.rows.length).map(({label,type,answered,average,rows})=>({label,type,answered,average,rows}));
 check(!containsPII(fields),'設問名や選択肢に個人情報の可能性があります。設定を確認してください。');
 return {id:randomUUID(),surveyId:survey.id,createdAt:new Date().toISOString(),snapshotHash:createHash('sha256').update(JSON.stringify(responses)).digest('hex'),snapshot:structuredClone(survey),stats:{count:stats.count,interviewCount:stats.interviewCount,fields},units,safeUnits:[],opinions:[],vectors:[],stage:'privacy',cursor:0,status:'running',published:false,requestedClusters:survey.report?.clusters??4,access:survey.report?.access??'password',excluded:0,revision:0,model:(survey.interview.provider==='openai'?survey.interview.model:'')||process.env.OPENAI_MODEL||'gpt-6-luna',embeddingModel:'text-embedding-3-small',usage:[],title:survey.title};
}
export async function clusterOpinions(vectors,requested){
 check(vectors.length>0,'個人情報チェック・意見抽出後に分析可能な意見がありません。');
 check(vectors.length<=500,'初期実装のクラスタリング上限は500意見です。');
 check(vectors.every(v=>Array.isArray(v)&&v.length===vectors[0].length&&v.every(Number.isFinite)),'埋め込みが不正です。',502);
 const x=vectors.map(norm);const k=Math.min(requested,Math.max(1,Math.floor(x.length/2)));
 let points;
 if(x.length<4)points=x.map((_,i)=>[i,0]);
 else {let seed=42;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};const u=new UMAP({nComponents:2,nNeighbors:Math.min(15,x.length-1),nEpochs:200,random});points=await u.fitAsync(x);}
 check(points.length===vectors.length&&points.every(p=>p.length===2&&p.every(Number.isFinite)),'配置を計算できませんでした。',502);
 let labels=Array(points.length).fill(0);
 if(k>1)labels=kmeans(points,k,{seed:42,maxIterations:100}).clusters;
 const distinct=[...new Set(labels)].sort((a,b)=>a-b);labels=labels.map(l=>distinct.indexOf(l));
 const groups=distinct.map((_,id)=>{
  const members=labels.map((l,i)=>l===id?i:-1).filter(i=>i>=0);
  const mean=norm(x[0].map((_,j)=>members.reduce((s,i)=>s+x[i][j],0)/members.length));
  const center=[0,1].map(j=>members.reduce((s,i)=>s+points[i][j],0)/members.length);
  const central=members.slice().sort((a,b)=>distance(x[a],mean)-distance(x[b],mean)).slice(0,5);
  return {members,central,center,label:`グループ${id+1}`,keywords:[]};
 });
 return {points,labels,groups,k:distinct.length,method:'L2 embeddings → UMAP-js (seed42, neighbors15, epochs200) → ml-kmeans'};
}
export async function advanceReport(original,ai){
 const r=structuredClone(original);check(!['review','published'].includes(r.status),'生成済みです。',409);r.status='running';r.reviewed=false;delete r.error;
 const next=()=>{r.stage=REPORT_STAGES[REPORT_STAGES.indexOf(r.stage)+1]||'complete';r.cursor=0;};
 if(r.stage==='privacy'){
  const batch=r.units.slice(r.cursor,r.cursor+10);const eligible=batch.filter(u=>!pii.test(u.text)&&!pii.test(u.question));r.excluded+=batch.length-eligible.length;
  if(eligible.length){const result=await ai.json('privacy',eligible,r);check(Array.isArray(result.safe)&&new Set(result.safe).size===result.safe.length&&result.safe.every(i=>Number.isInteger(i)&&i>=0&&i<eligible.length),'個人情報チェックの結果が不正です。',502);r.safeUnits.push(...result.safe.map(i=>eligible[i]));r.excluded+=eligible.length-result.safe.length;}
  r.cursor+=batch.length;if(r.cursor>=r.units.length){r.units=[];next();}
 }else if(r.stage==='extract'){
  const batch=r.safeUnits.slice(r.cursor,r.cursor+10);
  if(batch.length){const result=await ai.json('extract',batch,r);check(Array.isArray(result.opinions)&&result.opinions.length<=30,'意見抽出の結果が不正です。',502);
   for(const o of result.opinions){const text=cleanString(o.text);check(text&&Array.isArray(o.sources)&&o.sources.length===1&&o.sources.every(i=>Number.isInteger(i)&&batch[i]),'根拠の対応が不正です。',502);if(pii.test(text)){r.excluded++;continue;}r.opinions.push({text,sources:o.sources.map(i=>batch[i].text)});}
   check(r.opinions.length<=500,'初期実装は500意見までです。');
  }r.cursor+=batch.length;if(r.cursor>=r.safeUnits.length){r.safeUnits=[];next();}
 }else if(r.stage==='embed'){
  const batch=r.opinions.slice(r.cursor,r.cursor+32);check(r.opinions.length,'分析可能な意見がありません。');
  const vectors=await ai.embed(batch.map(o=>o.text),r);check(vectors.length===batch.length,'埋め込み件数が一致しません。',502);r.vectors.push(...vectors);r.cursor+=batch.length;if(r.cursor>=r.opinions.length)next();
 }else if(r.stage==='cluster'){
  r.clustering=await clusterOpinions(r.vectors,r.requestedClusters);r.vectors=[];next();
 }else if(r.stage==='narrative'){
  const input={stats:r.stats,groups:r.clustering.groups.map(g=>({central:g.central.map(i=>r.opinions[i].text)})),opinions:r.opinions.map((o,i)=>({index:i,text:o.text}))};
  const result=await ai.json('narrative',input,r);
  check(Array.isArray(result.groups)&&result.groups.length===r.clustering.k&&Array.isArray(result.highlights)&&result.highlights.length<=10&&Array.isArray(result.recommendations)&&result.recommendations.length<=10,'レポートの形式が不正です。',502);
  r.title=cleanString(result.title,200);r.summary=cleanString(result.summary,3000);r.discussion=cleanString(result.discussion,3000);r.recommendations=result.recommendations.map(v=>cleanString(v,1000));
  r.clustering.groups.forEach((g,i)=>{g.label=cleanString(result.groups[i].label,80);check(Array.isArray(result.groups[i].keywords)&&result.groups[i].keywords.length<=6,'キーワードが不正です。',502);g.keywords=result.groups[i].keywords.map(v=>cleanString(v,40));});
  r.highlights=result.highlights.map(h=>{check(Number.isInteger(h.opinion)&&r.opinions[h.opinion],'注目意見の根拠が不正です。',502);return {opinion:h.opinion,title:cleanString(h.title,120),reason:cleanString(h.reason,1500)};});next();
 }else if(r.stage==='finalPrivacy'){
  const output=r.cursor===0?{title:r.title,stats:r.stats,groups:r.clustering.groups.map(({label,keywords})=>({label,keywords})),highlights:r.highlights,summary:r.summary,discussion:r.discussion,recommendations:r.recommendations}:r.opinions.slice((r.cursor-1)*10,r.cursor*10);
  const result=containsPII(output)?{safe:false}:await ai.json('finalPrivacy',output,r);
  const decision=result.decision??(result.safe===true?'safe':result.safe===false?'unsafe':undefined);
  check(['safe','review','unsafe'].includes(decision),'個人情報チェックの結果が不正です。',502);
  if(result.decision&&decision!=='safe'){
   check(Array.isArray(result.findings)&&result.findings.length>0&&result.findings.length<=20,'個人情報チェックの指摘が不正です。',502);
   const findings=result.findings.map(f=>({location:cleanString(f.location,300),reason:cleanString(f.reason,1000)}));
   check(findings.every(f=>f.location&&f.reason),'個人情報チェックの指摘が不正です。',502);
   if(decision==='review'){
    r.privacyWarnings??=[];r.privacyWarnings=r.privacyWarnings.filter(w=>w.batch!==r.cursor);
    r.privacyWarnings.push({batch:r.cursor,findings});
   }
  }
  if(decision==='unsafe'&&r.cursor>0){
   const start=(r.cursor-1)*10,batch=r.opinions.slice(start,start+10);
   const eligible=batch.map((o,i)=>({i,text:[o.text,...o.sources].join('\n')})).filter(o=>!containsPII(o.text));
   const verdict=eligible.length?await ai.json('privacy',eligible.map(o=>({text:o.text,question:'公開候補の意見と根拠原文'})),r):{safe:[]};
   check(Array.isArray(verdict.safe)&&new Set(verdict.safe).size===verdict.safe.length&&verdict.safe.every(i=>Number.isInteger(i)&&i>=0&&i<eligible.length),'個人情報チェックの結果が不正です。',502);
   const safe=new Set(verdict.safe.map(i=>eligible[i].i));
   const removed=batch.map((_,i)=>safe.has(i)?-1:start+i).filter(i=>i>=0);
   check(removed.length>0,'個人情報の疑いがある箇所を特定できませんでした。安全確認のため停止しました。');
   const excluded=new Set(removed);r.opinions=r.opinions.filter((_,i)=>!excluded.has(i));r.excluded+=removed.length;
   check(r.opinions.length>0,'個人情報の除外後に分析可能な意見がありません。');
   // Recompute every opinion-index reference after exclusion rather than retaining stale labels or highlights.
   r.vectors=[];delete r.clustering;delete r.highlights;delete r.summary;delete r.discussion;delete r.recommendations;
   r.title=r.snapshot.title;r.stage='embed';r.cursor=0;r.privacyReviewed=false;r.published=false;r.privacyWarnings=[];
  }else{
   check(decision!=='unsafe','公開文面に明確な個人情報があるため生成を停止しました。');r.cursor++;
  if((r.cursor-1)*10>=r.opinions.length){r.privacyReviewed=true;next();r.status='review';}
  }
 }else check(false,'不明な生成工程です。');
 r.revision++;r.updatedAt=new Date().toISOString();return r;
}
function reportContent(r){return {title:r.title,stats:r.stats,opinions:r.opinions.map(o=>({text:o.text,sources:o.sources})),clustering:r.clustering,highlights:r.highlights,summary:r.summary,discussion:r.discussion,recommendations:r.recommendations};}
export function publicReport(r,admin=false){
 check(admin||r.published,'レポートが見つかりません。',404);
 return {...reportContent(r),createdAt:r.createdAt,model:r.model,embeddingModel:r.embeddingModel,requestedClusters:r.requestedClusters,excluded:admin?r.excluded:undefined};
}
export function editReport(original,changes){
 check(['review','published'].includes(original.status),'生成後に編集できます。',409);
 check(changes&&typeof changes==='object'&&!Array.isArray(changes),'編集内容が不正です。');
 check(Object.keys(changes).every(k=>['title','summary','discussion','recommendations','groups','highlights'].includes(k)),'分析結果や原文は編集できません。');
 const r=structuredClone(original);
 for(const key of ['title','summary','discussion'])if(key in changes)r[key]=cleanString(changes[key],key==='title'?200:3000);
 if(changes.recommendations){check(Array.isArray(changes.recommendations)&&changes.recommendations.length<=10,'提言が不正です。');r.recommendations=changes.recommendations.map(v=>cleanString(v,1000));}
 if(changes.groups){check(Array.isArray(changes.groups)&&changes.groups.length===r.clustering.groups.length,'ラベル数が不正です。');r.clustering.groups.forEach((g,i)=>{g.label=cleanString(changes.groups[i],80);});}
 if(changes.highlights){check(Array.isArray(changes.highlights)&&changes.highlights.length===r.highlights.length,'注目意見数が不正です。');r.highlights.forEach((h,i)=>{h.title=cleanString(changes.highlights[i].title,120);h.reason=cleanString(changes.highlights[i].reason,1500);});}
 check(!containsPII(reportContent(r)),'編集文面に個人情報の可能性があります。');
 r.published=false;r.status='review';r.reviewed=false;r.privacyReviewed=false;r.privacyWarnings=[];r.revision++;return r;
}
export function setPublication(original,{publish,reviewed,password,access}){
 const r=structuredClone(original);
 if(!publish){r.published=false;r.revision++;return r;}
 check(['review','published'].includes(r.status)&&r.privacyReviewed,'個人情報チェックを完了してください。',409);
 check(reviewed===true,'内容をレビューした確認が必要です。');
 if(access!==undefined){check(['password','url'].includes(access),'閲覧方式が不正です。');r.access=access;}
 if(r.access==='password'){if(password)r.passwordHash=reportPassword(password);check(r.passwordHash,'レポート用パスワードを設定してください。');}else delete r.passwordHash;
 r.published=true;r.status='published';r.reviewed=true;r.revision++;return r;
}
