import {randomUUID} from 'node:crypto';
import {check} from './domain.js';

const held=new Set();
const initializedPools=new WeakSet();
export async function initializeReports(store){
 if(store.pool){if(!initializedPools.has(store.pool)){await store.query('CREATE TABLE IF NOT EXISTS public.koenoha_report_records (id text PRIMARY KEY, record jsonb NOT NULL)');initializedPools.add(store.pool);}}
 else if(store.readOptional)await store.initialize(['reports']);
}
async function records(store){
 if(store.pool)return (await store.query('SELECT record FROM public.koenoha_report_records ORDER BY id')).rows.map(r=>r.record);
 return store.readOptional?store.readOptional('reports'):store.records('reports');
}
async function append(store,record){
 if(store.pool){await store.query('INSERT INTO public.koenoha_report_records (id,record) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record',[record.id,JSON.stringify(record)]);}
 else await store.append('reports',record);
}
export async function saveReport(store,report){
 await initializeReports(store);
 const version=randomUUID(),serialized=JSON.stringify(report);const chunks=[];let chunk='';
 // Keep surrogate pairs intact: PostgreSQL JSONB rejects lone surrogates.
 for(const character of serialized){if(chunk.length+character.length>24000){chunks.push(chunk);chunk='';}chunk+=character;}if(chunk)chunks.push(chunk);
 check(chunks.length<=500,'分析データが大きすぎます。');
 for(let i=0;i<chunks.length;i++)await append(store,{id:`part-${version}-${String(i).padStart(3,'0')}`,surveyId:report.surveyId,text:chunks[i],createdAt:report.createdAt});
 // Publish a pointer only after all chunks have been durably saved.
 await append(store,{id:report.id,kind:'report',surveyId:report.surveyId,version,parts:chunks.length,status:report.status,published:report.published,stage:report.stage,createdAt:report.createdAt,updatedAt:new Date().toISOString(),revision:report.revision});
}
export async function listReports(store,surveyId){
 await initializeReports(store);
 if(store.pool)return (await store.query("SELECT record FROM public.koenoha_report_records WHERE record->>'kind'='report' AND ($1::text IS NULL OR record->>'surveyId'=$1) ORDER BY record->>'createdAt' DESC",[surveyId||null])).rows.map(r=>r.record);
 return [...new Map((await records(store)).filter(r=>r.kind==='report').map(r=>[r.id,r])).values()].filter(r=>!surveyId||r.surveyId===surveyId);
}
export async function loadReport(store,id){
 await initializeReports(store);
 let all;
 if(store.pool){const pointer=(await store.query('SELECT record FROM public.koenoha_report_records WHERE id=$1',[id])).rows[0]?.record;check(pointer?.kind==='report','レポートが見つかりません。',404);all=[pointer,...(await store.query('SELECT record FROM public.koenoha_report_records WHERE id LIKE $1',[`part-${pointer.version}-%`])).rows.map(r=>r.record)];}
 else all=await records(store);
 const map=new Map(all.map(r=>[r.id,r]));const pointer=map.get(id);check(pointer?.kind==='report','レポートが見つかりません。',404);
 let json='';for(let i=0;i<pointer.parts;i++){const part=map.get(`part-${pointer.version}-${String(i).padStart(3,'0')}`);check(part,'分析結果の保存が未完了です。',503);json+=part.text;}
 return JSON.parse(json);
}
export async function withReportLock(store,id,work){
 check(!held.has(id),'処理中です。しばらく待ってください。',409);
 // Sheets lacks atomic compare-and-set. Do not pretend a process-local lock protects serverless instances.
 check(!(process.env.VERCEL&&store.readOptional),'Vercelでの分析レポート生成にはPostgreSQL保存が必要です。Sheetsのリアルタイム集計は引き続き利用できます。',503);
 held.add(id);const owner=randomUUID();let leased=false;
 try{
  if(store.pool){
   await initializeReports(store);
   const result=await store.query(`INSERT INTO public.koenoha_report_records (id,record) VALUES ($1,jsonb_build_object('owner',$2::text,'expires',$3::double precision)) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record WHERE (koenoha_report_records.record->>'expires')::double precision < $4 RETURNING id`,[`lease-${id}`,owner,Date.now()+180000,Date.now()]);
   check(result.rows.length,'別の処理が実行中です。最大3分待って再開してください。',409);leased=true;
  }
  return await work();
 }finally{
  try{if(leased)await store.query("DELETE FROM public.koenoha_report_records WHERE id=$1 AND record->>'owner'=$2",[`lease-${id}`,owner]);}finally{held.delete(id);}
 }
}
