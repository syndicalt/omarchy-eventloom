const canvas = document.querySelector("#cloth");
const ctx = canvas.getContext("2d");
const panel = document.querySelector("#panel");
const empty = document.querySelector("#empty");
const palette = ["#8ec487", "#73b5d6", "#e0aa70", "#c38ce0", "#d58f88", "#80b9ad"];
const state = { spec:null, sessions:[], scale:1, panX:0, panY:0, drag:null, selected:null, layout:[] };
const hash = (v) => { let h=2166136261; for(const c of String(v)) h=Math.imul(h^c.charCodeAt(0),16777619); return h>>>0; };
const color = (actor) => palette[hash(actor) % palette.length];
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw();
}
function fit() {
  const ss=state.sessions; if(!ss.length) return;
  const lo=Math.min(...ss.map(s=>s.start)), hi=Math.max(...ss.map(s=>s.end));
  state.domain={lo,hi:Math.max(hi,lo+60_000)}; state.scale=1; state.panX=0; state.panY=0;
}
function base() { return { left:86, right:36, bottom:94, top:150, width:innerWidth-122, height:innerHeight-244 }; }
function columnCount() { return Math.max(1, state.spec?.columnCount || Math.max(...state.sessions.map(s => (s.column ?? 0) + 1))); }
function position(s, b) {
  const span=state.domain.hi-state.domain.lo;
  const y=(t)=>b.bottom+b.height-(t-state.domain.lo)/span*b.height*state.scale+state.panY;
  const cols=columnCount();
  return { x:b.left+((s.column ?? 0)+.5)/cols*b.width*state.scale+state.panX, y0:y(s.start), y1:y(s.end), y };
}
function strokeLine(x1,y1,x2,y2,c,a=1,w=1) { ctx.strokeStyle=c;ctx.globalAlpha=a;ctx.lineWidth=w;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.globalAlpha=1; }
function drawSession(s,b) {
  const p=position(s,b), n=s.samples.length, widths=s.samples.map(v=>7+v*29);
  const ys=Array.from({length:n+1},(_,i)=>p.y0+(p.y1-p.y0)*i/n);
  ctx.beginPath(); ctx.moveTo(p.x-widths[0],ys[0]);
  for(let i=1;i<=n;i++) ctx.lineTo(p.x-widths[Math.min(i,n-1)],ys[i]);
  for(let i=n;i>=0;i--) ctx.lineTo(p.x+widths[Math.max(0,i-1)],ys[i]);
  ctx.closePath(); const g=ctx.createLinearGradient(p.x-38,0,p.x+38,0); g.addColorStop(0,"#111820");g.addColorStop(.24,color(s.actor));g.addColorStop(.52,"#eef0cf");g.addColorStop(.78,color(s.actor));g.addColorStop(1,"#111820");
  ctx.fillStyle=g;ctx.globalAlpha=.82;ctx.fill();ctx.globalAlpha=1;
  // Material weft, denser through wide/high-activity segments.
  ctx.save();ctx.clip(); const phase=(s.seed||0)%6; for(let y=Math.min(p.y0,p.y1)+6+phase;y<Math.max(p.y0,p.y1);y+=6) strokeLine(p.x-42,y,p.x+42,y,"#f5e4c1",.19,1); ctx.restore();
  strokeLine(p.x,p.y0,p.x,p.y1,"#f5e5c5",.55,1);
  if (s.failure) { for(let i=-2;i<=2;i++) strokeLine(p.x+i*4,p.y1,p.x+i*6,p.y1-13,"#efb28a",.8,1.5); }
  if (s.completion) { ctx.fillStyle="#dcf0b9";ctx.beginPath();ctx.arc(p.x,p.y1-8,9,0,Math.PI*2);ctx.fill();strokeLine(p.x-12,p.y1,p.x+12,p.y1,"#f8e7b7",.9,2);ctx.beginPath();ctx.moveTo(p.x-4,p.y1-8);ctx.lineTo(p.x-1,p.y1-4);ctx.lineTo(p.x+5,p.y1-12);ctx.strokeStyle="#3f714d";ctx.lineWidth=1.6;ctx.stroke(); }
  else if (!s.failure) { ctx.strokeStyle="#dae8df";ctx.globalAlpha=.55;ctx.beginPath();ctx.moveTo(p.x-7,p.y1);ctx.lineTo(p.x,p.y1-8);ctx.lineTo(p.x+7,p.y1);ctx.stroke();ctx.globalAlpha=1; }
  if (Math.abs(p.y0-p.y1)>90) { ctx.save();ctx.translate(p.x-3,(p.y0+p.y1)/2);ctx.rotate(-Math.PI/2);ctx.fillStyle="#111820";ctx.globalAlpha=.8;ctx.font="10px ui-monospace";ctx.fillText(s.actor+" / "+s.sessionId.slice(0,14),0,0);ctx.restore(); }
  state.layout.push({s,p,width:Math.max(...widths)});
}
function draw() {
  ctx.clearRect(0,0,innerWidth,innerHeight); ctx.fillStyle="#101319";ctx.fillRect(0,0,innerWidth,innerHeight);
  const b=base(); ctx.fillStyle="#d0d8d4";ctx.globalAlpha=.018; for(let x=0;x<innerWidth;x+=10)ctx.fillRect(x,0,1,innerHeight);for(let y=0;y<innerHeight;y+=10)ctx.fillRect(0,y,innerWidth,1);ctx.globalAlpha=1;
  if (!state.sessions.length) return;
  state.layout=[]; const {lo,hi}=state.domain, hours=5, multi=(hi-lo)>36*60*60*1000;
  for(let i=0;i<=hours;i++){ const y=b.bottom+b.height-i/hours*b.height*state.scale+state.panY;strokeLine(b.left,y,innerWidth-b.right,y,"#d8d2c3",.12);const t=new Date(lo+(hi-lo)*i/hours);ctx.fillStyle="#87908e";ctx.font="10px ui-monospace";const label=multi?t.toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):t.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});ctx.fillText(label,18,y+3); }
  strokeLine(b.left,b.bottom,innerWidth-b.right,b.bottom,"#e7dcc5",.5,1);
  for(const s of state.sessions) drawSession(s,b);
  // resume splice
  for(const row of state.layout) if(row.s.resumed && row.s.resumeOf){const from=state.layout.find(x=>x.s.id===row.s.resumeOf);if(from){ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(from.p.x,from.p.y1);ctx.bezierCurveTo(from.p.x+35,from.p.y1-24,row.p.x-35,row.p.y0+24,row.p.x,row.p.y0);ctx.strokeStyle=color(row.s.actor);ctx.lineWidth=2;ctx.globalAlpha=.85;ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;}}
  for(const handoff of state.spec.handoffs || []) { const from=state.layout.find(r=>r.s.sessionId===handoff.fromSession && handoff.at>=r.s.start && handoff.at<=r.s.end) || state.layout.find(r=>r.s.sessionId===handoff.fromSession); const to=state.layout.find(r=>r.s.sessionId===handoff.toSession); if(from&&to){const y=from.p.y(handoff.at);ctx.setLineDash([8,6]);ctx.beginPath();ctx.moveTo(from.p.x,y);ctx.quadraticCurveTo((from.p.x+to.p.x)/2,y-38,to.p.x,to.p.y0);ctx.strokeStyle="#cf92e8";ctx.lineWidth=2;ctx.stroke();ctx.setLineDash([]);}}
}
function select(row) {
  state.selected=row.s; const s=row.s; const tools=s.toolCount ?? 0, approvals=s.approvalCount ?? 0, count=s.eventCount ?? (s.events?.length ?? 0);
  const title=s.failure && s.completion ? "completed with failures" : s.completion ? "goal/session completed" : s.status==="failed" ? "session failed" : "active session";
  panel.innerHTML="<h2>"+esc(title)+"</h2><p><b>"+esc(s.actor)+"</b> · "+esc(s.sessionId)+"</p><p>"+count+" sealed events · "+tools+" tools · "+approvals+" approvals</p><p><code>"+new Date(s.start).toLocaleString()+" → "+new Date(s.end).toLocaleString()+"</code></p>";
  panel.classList.add("show");
}
canvas.addEventListener("pointerdown",(e)=>{state.drag={x:e.clientX,y:e.clientY,px:state.panX,py:state.panY};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener("pointermove",(e)=>{if(!state.drag)return;state.panX=state.drag.px+e.clientX-state.drag.x;state.panY=state.drag.py+e.clientY-state.drag.y;draw();});
canvas.addEventListener("pointerup",(e)=>{const moved=Math.hypot(e.clientX-state.drag.x,e.clientY-state.drag.y);state.drag=null;if(moved<5){const hit=state.layout.slice().reverse().find(r=>Math.abs(e.clientX-r.p.x)<=r.width+8&&e.clientY>=Math.min(r.p.y0,r.p.y1)-12&&e.clientY<=Math.max(r.p.y0,r.p.y1)+12);if(hit)select(hit);else panel.classList.remove("show");}});
canvas.addEventListener("wheel",(e)=>{e.preventDefault();const old=state.scale;state.scale=Math.max(.55,Math.min(3,old*(e.deltaY>0?.9:1.1)));draw();},{passive:false});
async function boot(){try{state.spec=await fetch("/weave.json").then(r=>r.json());state.sessions=state.spec.sessions||[];empty.hidden=state.sessions.length>0;fit();resize();}catch{empty.hidden=false;resize();}}
addEventListener("resize",resize);boot();
