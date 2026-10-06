const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#17866e','#347dbb','#d18a25','#cf5778','#8459a3','#647e37','#667a89'];
function bars(field,index){return `<section class="result-field"><h3>${esc(field.label)}</h3><p class="muted">${field.answered}回答${field.average!=null?' / 平均 '+field.average.toFixed(2):''}</p><div class="chart">${field.rows.map(row=>`<div class="chart-row"><span>${esc(row.label)}</span><div class="track"><div style="width:${field.answered?row.count/field.answered*100:0}%;background:${colors[index%colors.length]}"></div></div><span>${row.count}件 / ${field.answered?Math.round(row.count/field.answered*100):0}%</span></div>`).join('')}</div><p class="muted">分母：この設問の${field.answered}回答${field.type==='multiple'?'（複数選択）':''}</p></section>`;}
function outline(points){
 const expanded=points.flatMap(p=>Array.from({length:16},(_,i)=>[p[0]+18*Math.cos(i*Math.PI/8),p[1]+18*Math.sin(i*Math.PI/8)]));
 const sorted=expanded.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 const half=ps=>{const out=[];for(const p of ps){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out;};
 const hull=half(sorted).slice(0,-1).concat(half(sorted.slice().reverse()).slice(0,-1));
 if(!hull.length)return '';
 const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
 return 'M '+mid(hull.at(-1),hull[0]).join(' ')+hull.map((p,i)=>' Q '+p.join(' ')+' '+mid(p,hull[(i+1)%hull.length]).join(' ')).join('')+' Z';
}
export function reportMarkup(r){
 return `<article class="analysis-report"><h1>${esc(r.title)}</h1><p class="muted">生成時点：${esc(new Date(r.createdAt).toLocaleString())} · ${r.stats.count}回答 · モデル ${esc(r.model)} · 指定${r.requestedClusters} / 実際${r.clustering.k}クラスタ</p>
 <section><h2>1 アンケート結果のグラフ</h2><div class="result-totals"><div><span>回答数</span><strong>${r.stats.count}</strong></div><div><span>AIインタビュー利用</span><strong>${r.stats.interviewCount}</strong></div></div><div class="results-grid">${r.stats.fields.map(bars).join('')}</div></section>
 <section><h2>2 今回のクラスタ分析</h2><div class="report-map-layout"><svg id="report-map" viewBox="0 0 800 580" role="group" aria-label="意見の散布図"></svg><aside id="report-opinion" aria-live="polite">点を選ぶと意見とチェック済みの原文を確認できます。</aside></div><div class="report-legend">${r.clustering.groups.map((g,i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${esc(g.label)}</span>`).join('')}</div><p class="muted">ラベルは「意見の中心」の解釈です。曲線は点群の表示用の囲みで、分類境界や信頼領域ではありません。縦横は配置座標で、賛否・重要度の尺度ではありません。近さや色の塊だけで明確な集団の分離を判断できません。</p>${r.clustering.k!==r.requestedClusters?'<p class="muted">意見数・計算結果に応じてクラスタ数を減らしました。</p>':''}</section>
 <section><h2>3 選択した注目意見</h2><p class="muted">多さや代表性ではなく、今後につながる示唆を基準に選定。引用は回答者の意見、説明は分析者の解釈です。</p>${r.highlights.map(h=>`<article class="report-insight"><h3>${esc(h.title)}</h3><blockquote>${esc(r.opinions[h.opinion].text)}</blockquote><p>${esc(h.reason)}</p><details><summary>チェック済みの原文</summary>${r.opinions[h.opinion].sources.map(s=>`<blockquote>${esc(s)}</blockquote>`).join('')}</details></article>`).join('')}</section>
 <section><h2>4 全体のまとめと考察、今後への提言</h2><h3>まとめ</h3><p class="report-prose">${esc(r.summary)}</p><h3>考察</h3><p class="report-prose">${esc(r.discussion)}</p><h3>今後への提言</h3><ol>${r.recommendations.map(v=>`<li>${esc(v)}</li>`).join('')}</ol></section>
 <footer class="muted">匿名回答の保存レコードを対象とした分析です。参加者総数・回答率・同一人物の重複やテスト回答の有無は未確認です。個人情報チェックは自動検出と管理者レビューによるもので、完全な除去を保証するものではありません。意見抽出・分類にはAIによる解釈と投影による歪みが含まれます。施策の効果を実証したものではありません。</footer></article>`;
}
export function drawReport(r){
 const svg=document.querySelector('#report-map');const points=r.clustering.points;
 const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const minx=Math.min(...xs),miny=Math.min(...ys),dx=Math.max(...xs)-minx||1,dy=Math.max(...ys)-miny||1;
 const project=p=>[45+(p[0]-minx)/dx*710,535-(p[1]-miny)/dy*490];const ps=points.map(project);
 let html=r.clustering.groups.map((g,i)=>`<path d="${outline(g.members.map(j=>ps[j]))}" fill="${colors[i%colors.length]}" fill-opacity=".13" stroke="none" pointer-events="none"/>`).join('');
 html+='<path d="M25 15 V555 H785" fill="none" stroke="#83958f"/><text x="740" y="575" font-size="12">配置軸 X</text><text x="8" y="18" font-size="12">配置軸 Y</text>';
 html+=ps.map((p,i)=>`<circle data-opinion="${i}" tabindex="0" role="button" aria-label="${esc(r.opinions[i].text)}" cx="${p[0]}" cy="${p[1]}" r="7" fill="${colors[r.clustering.labels[i]%colors.length]}" stroke="white" stroke-width="1.5"><title>${esc(r.opinions[i].text)}</title></circle>`).join('');
 html+=r.clustering.groups.map((g,i)=>{const p=project(g.center);const short=[...g.label].slice(0,24).join('');const lines=[short.slice(0,12),short.slice(12)].filter(Boolean);return `<text x="${p[0]}" y="${p[1]-8}" text-anchor="middle" fill="${colors[i%colors.length]}" font-weight="700" font-size="16" stroke="white" stroke-width="4" paint-order="stroke" pointer-events="none">${lines.map((s,j)=>`<tspan x="${p[0]}" dy="${j?21:0}">${esc(s)}</tspan>`).join('')}</text>`;}).join('');
 svg.innerHTML=html;
 function select(i){const o=r.opinions[i];document.querySelector('#report-opinion').innerHTML=`<h3>${esc(o.text)}</h3><p class="muted">チェック済みの原文</p>${o.sources.map(s=>`<blockquote>${esc(s)}</blockquote>`).join('')}`;}
 svg.querySelectorAll('circle').forEach(c=>{c.onclick=()=>select(Number(c.dataset.opinion));c.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select(Number(c.dataset.opinion));}};});
}
export function reportEditor(r){
 return `<form id="report-edit"><h2>文面の編集</h2><label>見出し<input name="title" maxlength="200" value="${esc(r.title)}" required></label>${r.clustering.groups.map((g,i)=>`<label>中心意見ラベル ${i+1}<input name="group-${i}" maxlength="80" value="${esc(g.label)}" required></label>`).join('')}${r.highlights.map((h,i)=>`<label>注目意見の見出し ${i+1}<input name="highlight-title-${i}" maxlength="120" value="${esc(h.title)}"></label><label>選定理由<textarea name="highlight-reason-${i}" maxlength="1500">${esc(h.reason)}</textarea></label>`).join('')}${['summary','discussion'].map((key,i)=>`<label>${i?'考察':'まとめ'}<textarea name="${key}" rows="4" maxlength="3000">${esc(r[key])}</textarea></label>`).join('')}<label>提言（1行に1つ）<textarea name="recommendations" rows="5">${esc(r.recommendations.join('\n'))}</textarea></label><button type="submit">保存して個人情報を再チェック</button></form>`;
}
