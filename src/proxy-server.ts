/**
 * proxy-server.ts — Embedded HTTP proxy server that runs inside the extension process.
 *
 * Starts a lightweight Node.js HTTP server on a configurable local port.
 * Every POST /v1/chat/completions is intercepted, run through the CC2 pipeline,
 * then forwarded to the real GitHub Copilot API endpoint using VS Code's own token.
 *
 * VS Code is told to route all Copilot requests through this proxy via:
 *   github.copilot.advanced.debug.overrideProxyUrl = "http://localhost:<port>"
 *
 * No Copilot Proxy (Python sidecar) is needed. VS Code's built-in GitHub
 * authentication is used — no OAuth flow required from the extension.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { Message } from 'context-compiler-typescript';
import { runPipeline } from 'context-compiler-typescript';
import { record } from 'context-compiler-typescript';
import { makeVscodeLLMCaller } from './llm-caller';
import { getCopilotToken } from './copilot-auth';

// ── Compilation store ─────────────────────────────────────────────────────────
interface CompilationEntry {
  request_id: string;
  model: string;
  mode: string;
  original: string;
  compiled: string;
  raw_tokens: number;
  compiled_tokens: number;
  reduction_pct: number;
  timestamp: string;
  latency_ms: number;
}

interface CopilotEntry {
  request_id: string;
  model: string;
  input: string;
  output: string;
  prompt_tokens: number;
  timestamp: string;
}

const MAX_STORE = 10000;
const _compilationStore: CompilationEntry[] = [];
const _copilotStore: CopilotEntry[] = [];

function _getCopilotStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'ccc_copilot_exchanges.jsonl');
}

function _loadCopilotStoreFromDisk(): void {
  try {
    const p = _getCopilotStorePath();
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-MAX_STORE);
    for (const line of lines) {
      try { _copilotStore.unshift(JSON.parse(line)); } catch { /* skip */ }
    }
    if (_copilotStore.length > MAX_STORE) _copilotStore.splice(MAX_STORE);
  } catch { /* ignore */ }
}
_loadCopilotStoreFromDisk();

function storeCopilotExchange(requestId: string, model: string, input: string, output: string, promptTokens: number): void {
  const entry: CopilotEntry = {
    request_id: requestId,
    model,
    input,
    output,
    prompt_tokens: promptTokens,
    timestamp: new Date().toISOString(),
  };
  _copilotStore.unshift(entry);
  if (_copilotStore.length > MAX_STORE) _copilotStore.pop();
  try {
    fs.appendFileSync(_getCopilotStorePath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** Parse SSE stream chunks to extract assistant text content */
function extractSseContent(chunks: string[]): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        const content = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.message?.content;
        if (typeof content === 'string') parts.push(content);
      } catch { /* skip */ }
    }
  }
  return parts.join('');
}

function _getExchangesPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'ccc_exchanges.jsonl');
}

function _loadExchangesFromDisk(): void {
  try {
    const p = _getExchangesPath();
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-MAX_STORE);
    for (const line of lines) {
      try { _compilationStore.unshift(JSON.parse(line)); } catch { /* skip */ }
    }
    if (_compilationStore.length > MAX_STORE) _compilationStore.splice(MAX_STORE);
  } catch { /* ignore */ }
}
_loadExchangesFromDisk();

function _bodyToText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  for (const m of msgs) {
    const role = m.role ?? '?';
    const content = m.content;
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: Record<string, unknown>) => b.type === 'text')
        .map((b: Record<string, unknown>) => b.text ?? '')
        .join(' ');
    } else {
      text = String(content ?? '');
    }
    parts.push(`[${role.toUpperCase()}]\n${text}`);
  }
  return parts.join('\n\n');
}

function storeCompilation(
  requestId: string, model: string, mode: string,
  originalBody: Record<string, unknown>, compiledBody: Record<string, unknown>,
  rawTokens: number, compiledTokens: number, latencyMs: number,
  pipelineResult?: { removedSections: string[]; extractionUsage: { inputTokens: number; outputTokens: number } },
  extractionModel?: string,
): void {
  const reductionPct = rawTokens > 0 ? parseFloat(((1 - compiledTokens / rawTokens) * 100).toFixed(1)) : 0;
  const tokensSaved = rawTokens - compiledTokens;
  const entry: CompilationEntry = {
    request_id: requestId,
    model,
    mode,
    original: _bodyToText(originalBody),
    compiled: _bodyToText(compiledBody),
    raw_tokens: rawTokens,
    compiled_tokens: compiledTokens,
    reduction_pct: reductionPct,
    timestamp: new Date().toISOString(),
    latency_ms: latencyMs,
  };
  _compilationStore.unshift(entry);
  if (_compilationStore.length > MAX_STORE) _compilationStore.pop();
  // Persist in a format compatible with both the web dashboard and computeStats()
  const persistEntry = {
    ...entry,
    ts: entry.timestamp,
    tokens_before: rawTokens,
    tokens_after: compiledTokens,
    tokens_saved: tokensSaved,
    removed_sections: pipelineResult?.removedSections ?? [],
    haiku_input_tokens: pipelineResult?.extractionUsage?.inputTokens ?? 0,
    haiku_output_tokens: pipelineResult?.extractionUsage?.outputTokens ?? 0,
    extraction_model: extractionModel ?? '',
  };
  try {
    fs.appendFileSync(_getExchangesPath(), JSON.stringify(persistEntry) + '\n', 'utf8');
  } catch { /* ignore */ }
}

// ── Dashboard HTML (ported from CC2) ─────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Context Compiler Copilot — Dashboard</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--yellow:#eab308;
    --red:#ef4444;--blue:#3b82f6;--purple:#a855f7;--text:#e2e8f0;--muted:#64748b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;padding:24px}
  h1{font-size:1.4rem;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:.85rem;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px}
  .card-label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
  .card-value{font-size:2rem;font-weight:800;line-height:1}
  .card-sub{font-size:.75rem;color:var(--muted);margin-top:4px}
  .green{color:var(--green)}.yellow{color:var(--yellow)}.blue{color:var(--blue)}.purple{color:var(--purple)}.red{color:var(--red)}
  .section-title{font-size:.85rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
  .bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .bar-label{width:110px;font-size:.8rem;text-align:right;color:var(--muted)}
  .bar-track{flex:1;height:10px;background:var(--border);border-radius:6px;overflow:hidden}
  .bar-fill{height:100%;border-radius:6px;transition:width .6s ease}
  .bar-pct{width:40px;font-size:.78rem;color:var(--text)}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:.8rem}
  th{text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)}
  td{padding:8px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:var(--border)}
  .refresh-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
  .refresh-info{font-size:.78rem;color:var(--muted)}
  .btn{background:var(--blue);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:.8rem;cursor:pointer}
  .btn:hover{opacity:.85}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:700}
  .nav{display:flex;gap:12px;margin-bottom:20px}
  .nav a{color:var(--blue);font-size:.85rem;text-decoration:none}
  .nav a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>⚙ Context Compiler Copilot — Dashboard</h1>
<p class="subtitle" id="subtitle">Loading…</p>
<div class="nav"><a href="/dashboard">Dashboard</a><a href="/compilation">Message Inspector</a></div>
<div class="refresh-bar">
  <span class="refresh-info" id="last-updated">Fetching…</span>
  <button class="btn" onclick="load()">↻ Refresh</button>
</div>
<div class="grid" id="kpi-grid"></div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
  <div class="card"><div class="section-title" style="margin-bottom:14px">Mode Breakdown</div><div id="mode-bars"></div></div>
  <div class="card"><div class="section-title" style="margin-bottom:14px">Token Budget</div><div id="token-bars"></div></div>
</div>
<div class="card" style="margin-bottom:24px">
  <div class="section-title" style="margin-bottom:14px">Recent Requests</div>
  <div class="table-wrap">
    <table><thead><tr>
      <th>ID</th><th>Time</th><th>Mode</th><th>Model</th><th>Raw</th><th>Compiled</th><th>Saved</th><th>Latency</th>
    </tr></thead><tbody id="req-table"></tbody></table>
  </div>
</div>
<script src="/dashboard.js"></script>
</body></html>`;

// ── Compilation Inspector HTML (ported from CC2) ──────────────────────────────
const COMPILATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>CCC \u2014 Message Inspector</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--blue:#3b82f6;
    --yellow:#eab308;--text:#e2e8f0;--muted:#64748b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;padding:24px;min-height:100vh}
  .header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
  h1{font-size:2rem;font-weight:800;color:var(--blue);display:flex;align-items:center;gap:10px}
  .btn-refresh{background:var(--green);color:#000;border:none;padding:10px 24px;border-radius:8px;font-size:.9rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:8px}
  .btn-refresh:hover{opacity:.88}
  table{width:100%;border-collapse:collapse;background:var(--surface);border-radius:12px;overflow:hidden}
  thead tr{background:var(--surface)}
  th{padding:14px 20px;text-align:left;font-size:.72rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
  td{padding:16px 20px;font-size:.88rem;border-bottom:1px solid var(--border);vertical-align:middle}
  tr.data-row:last-child td{border-bottom:none}
  tr.data-row:hover td{background:#202336}
  td.time{color:var(--muted);white-space:nowrap;font-size:.85rem}
  td.mode{font-weight:700;color:var(--green)}
  td.mode.passthrough{color:var(--muted)}
  td.tokens{color:var(--text)}
  td.saved{color:var(--green);font-weight:700}
  td.saved.zero{color:var(--muted);font-weight:400}
  tr.toggle-row td{padding:0;border-bottom:none}
  .show-toggle{color:var(--muted);font-size:.82rem;padding:10px 20px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;border-bottom:1px solid var(--border)}
  .show-toggle:hover{color:var(--text)}
  .show-toggle .tri{display:inline-block;transition:transform .2s}
  .show-toggle.open .tri{transform:rotate(90deg)}
  tr.panes-row td{padding:0}
  .panes{display:none;grid-template-columns:1fr 1fr}
  .panes.open{display:grid}
  .pane{padding:20px;overflow:auto;max-height:500px}
  .pane-orig{background:#1a1d27;border-right:1px solid var(--border)}
  .pane-comp{background:#0d1f17}
  .pane-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
  .pane-orig .pane-label{color:#94a3b8}
  .pane-comp .pane-label{color:var(--green)}
  .messages{display:flex;flex-direction:column;gap:8px}
  .bw{display:flex;flex-direction:column}
  .bw.user{align-items:flex-end}.bw.assistant{align-items:flex-start}.bw.system{align-items:stretch}
  .br{font-size:.62rem;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em;padding:0 4px}
  .bb{max-width:92%;padding:8px 12px;border-radius:12px;font-size:.78rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .pane-orig .bb.user{background:#1e3a5f;border-bottom-right-radius:3px}
  .pane-orig .bb.assistant{background:#1a1d27;border:1px solid var(--border);border-bottom-left-radius:3px}
  .pane-orig .bb.system{background:#1c1008;border:1px dashed #78350f;color:#fde68a;border-radius:7px;font-size:.74rem;max-width:100%}
  .pane-comp .bb.user{background:#1a3325;border-bottom-right-radius:3px}
  .pane-comp .bb.assistant{background:#0d1f17;border:1px solid #14532d;border-bottom-left-radius:3px}
  .pane-comp .bb.system{background:#071d11;border:1px dashed #14532d;color:#bbf7d0;border-radius:7px;font-size:.74rem;max-width:100%}
  .empty{color:var(--muted);text-align:center;padding:60px;font-size:.9rem}
</style>
</head>
<body>
<div class="header-row">
  <h1>\uD83D\uDD0D Message Inspector</h1>
  <button class="btn-refresh" onclick="load()">\u21ba Refresh</button>
</div>
<table>
  <thead><tr>
    <th>Time (Local)</th>
    <th>Mode</th>
    <th>Tokens Before</th>
    <th>Tokens After</th>
    <th>Saved</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<script src="/compilation.js"></script>
</body></html>`;

// ── Dashboard JS ──────────────────────────────────────────────────────────────
const DASHBOARD_JS = `
const MODE_COLORS={passthrough:'#64748b',conversation:'#3b82f6',context:'#a855f7',full:'#22c55e'};
function esc(s){return s.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');}
function fmt(n){return n==null?'\u2014':n.toLocaleString();}
function modeLabel(m){return '<span class="pill" style="background:'+(MODE_COLORS[m]||'#333')+'22;color:'+(MODE_COLORS[m]||'#aaa')+'">'+m+'</span>';}
async function load(){
  try{
    const r=await fetch('/metrics/detail');
    const d=await r.json();
    render(d);
    document.getElementById('last-updated').textContent='Last updated: '+new Date().toLocaleString();
  }catch(e){document.getElementById('last-updated').textContent='Error fetching data';}
}
function render(d){
  const reqs=d.recent_requests||[];
  const total=reqs.length;
  const rawSum=reqs.reduce((a,r)=>a+r.raw_tokens,0);
  const compSum=reqs.reduce((a,r)=>a+r.compiled_tokens,0);
  const savedSum=rawSum-compSum;
  const avgPct=total>0?(reqs.reduce((a,r)=>a+r.reduction_pct,0)/total).toFixed(1):0;
  const costSaved=((savedSum/1000000)*3).toFixed(4);
  const modes={};
  reqs.forEach(r=>{modes[r.mode]=(modes[r.mode]||0)+1;});
  document.getElementById('subtitle').textContent=total+' requests captured \u2014 port 8181';
  const kpis=[
    {label:'Avg Token Saving',value:avgPct+'%',cls:'green',sub:fmt(savedSum)+' tokens saved total'},
    {label:'Requests',value:fmt(total),cls:'blue',sub:'all time'},
    {label:'Est. Cost Saved',value:'$'+costSaved,cls:'green',sub:'@ $3/1M tokens'},
    {label:'Tokens Raw',value:fmt(rawSum),cls:'yellow',sub:'before pipeline'},
    {label:'Tokens Compiled',value:fmt(compSum),cls:'blue',sub:'after pipeline'},
    {label:'Tokens Saved',value:fmt(savedSum),cls:'green',sub:'total reduction'},
  ];
  const kpiEl=document.getElementById('kpi-grid');
  kpiEl.innerHTML='';
  kpis.forEach(k=>{
    const c=document.createElement('div');c.className='card';
    c.innerHTML='<div class="card-label">'+k.label+'</div><div class="card-value '+k.cls+'">'+k.value+'</div><div class="card-sub">'+k.sub+'</div>';
    kpiEl.appendChild(c);
  });
  const modeEntries=Object.entries(modes);
  const modeBarsEl=document.getElementById('mode-bars');
  modeBarsEl.innerHTML='';
  if(modeEntries.length){
    modeEntries.forEach(function(entry){
      const m=entry[0],c=entry[1];
      const p=(c/total*100).toFixed(1);
      const row=document.createElement('div');row.className='bar-row';
      row.innerHTML='<div class="bar-label">'+m+'</div><div class="bar-track"><div class="bar-fill" style="width:'+p+'%;background:'+(MODE_COLORS[m]||'#888')+'"></div></div><div class="bar-pct">'+p+'%</div>';
      modeBarsEl.appendChild(row);
    });
  }else{modeBarsEl.textContent='No data yet';}
  const tokenBarsEl=document.getElementById('token-bars');
  tokenBarsEl.innerHTML='';
  [['Raw',rawSum,'#ef4444',100],['Compiled',compSum,'#3b82f6',rawSum>0?(compSum/rawSum*100).toFixed(1):0],['Saved',savedSum,'#22c55e',rawSum>0?(savedSum/rawSum*100).toFixed(1):0]].forEach(function(row){
    const el=document.createElement('div');el.className='bar-row';
    el.innerHTML='<div class="bar-label">'+row[0]+'</div><div class="bar-track"><div class="bar-fill" style="width:'+row[3]+'%;background:'+row[2]+'"></div></div><div class="bar-pct">'+fmt(row[1])+'</div>';
    tokenBarsEl.appendChild(el);
  });
  const tbody=document.getElementById('req-table');
  tbody.innerHTML='';
  if(!reqs.length){
    const tr=document.createElement('tr');
    const td=document.createElement('td');td.colSpan=8;td.style.cssText='color:#64748b;text-align:center;padding:20px';
    td.textContent='No requests yet';tbody.appendChild(tr);tr.appendChild(td);
  }else{
    reqs.forEach(function(r){
      const saved=r.raw_tokens-r.compiled_tokens;
      const tr=document.createElement('tr');
      const cells=[
        {text:r.request_id.slice(0,8),style:'font-family:monospace;color:#64748b;font-size:.72rem'},
        {text:new Date(r.timestamp).toLocaleString()},
        {html:modeLabel(r.mode)},
        {text:r.model,style:'color:#eab308;font-size:.78rem'},
        {text:fmt(r.raw_tokens)},
        {text:fmt(r.compiled_tokens)},
        {text:saved>0?'\u2212'+fmt(saved):'\u2014',cls:saved>0?'green':''},
        {text:r.latency_ms+'ms'},
      ];
      cells.forEach(function(c){
        const td=document.createElement('td');
        if(c.style)td.style.cssText=c.style;
        if(c.cls)td.className=c.cls;
        if(c.html)td.innerHTML=c.html;else td.textContent=c.text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }
}
load();setInterval(load,5000);
`;

// ── Compilation JS ────────────────────────────────────────────────────────────
const COMPILATION_JS = `
let _data=[];
const _open=new Set();
function esc(s){return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');}
function fmt(n){return(n||0).toLocaleString();}
function parseMessages(txt){
  const parts=[];let cur='';
  const lines=(txt||'').split('\\n');
  for(let i=0;i<lines.length;i++){
    const l=lines[i];
    if((l==='[USER]'||l==='[ASSISTANT]'||l==='[SYSTEM]')&&cur.trim()){parts.push(cur.trim());cur=l;}
    else{cur+=(cur?'\\n':'')+l;}
  }
  if(cur.trim())parts.push(cur.trim());
  return parts.map(function(b){
    const nl=b.indexOf('\\n');
    const role=nl>-1?b.slice(1,nl-1).toLowerCase():'text';
    const text=nl>-1?b.slice(nl+1).trim():b.trim();
    return{role,text};
  }).filter(function(m){return m.text;});
}
function renderBubbles(txt){
  const msgs=parseMessages(txt);
  if(!msgs.length) return '<div style="color:#64748b;font-size:.8rem;padding:8px">No messages</div>';
  const wrap=document.createElement('div');wrap.className='messages';
  msgs.forEach(function(m){
    const bw=document.createElement('div');bw.className='bw '+m.role;
    const br=document.createElement('div');br.className='br';br.textContent=m.role;
    const bb=document.createElement('div');bb.className='bb '+m.role;bb.textContent=m.text;
    bw.appendChild(br);bw.appendChild(bb);wrap.appendChild(bw);
  });
  return wrap.outerHTML;
}
async function load(){
  try{
    const r=await fetch('/compilation/data');
    _data=await r.json();
    render();
  }catch(e){document.getElementById('tbody').innerHTML='<tr><td colspan="5" class="empty">Error loading data</td></tr>';}
}
function toggle(id){
  if(_open.has(id))_open.delete(id);else _open.add(id);
  render();
}
function render(){
  const tbody=document.getElementById('tbody');
  tbody.innerHTML='';
  if(!_data.length){
    const tr=document.createElement('tr');
    const td=document.createElement('td');td.colSpan=5;td.className='empty';
    td.textContent='No requests yet \u2014 send a message through ContextCompilerCopilot.';
    tr.appendChild(td);tbody.appendChild(tr);return;
  }
  _data.forEach(function(d){
    const saved=d.raw_tokens-d.compiled_tokens;
    const pct=d.raw_tokens>0?(saved/d.raw_tokens*100).toFixed(1):0;
    const id='row-'+d.request_id;
    const isOpen=_open.has(id);
    // Data row
    const tr=document.createElement('tr');tr.className='data-row';
    tr.style.cursor='pointer';
    tr.onclick=function(){toggle(id);};
    const tdTime=document.createElement('td');tdTime.className='time';
    tdTime.textContent=new Date(d.timestamp).toLocaleString();
    const tdMode=document.createElement('td');tdMode.className='mode'+(d.mode==='passthrough'?' passthrough':'');
    tdMode.textContent=d.mode||'unknown';
    const tdBefore=document.createElement('td');tdBefore.className='tokens';tdBefore.textContent=fmt(d.raw_tokens);
    const tdAfter=document.createElement('td');tdAfter.className='tokens';tdAfter.textContent=fmt(d.compiled_tokens);
    const tdSaved=document.createElement('td');
    if(saved>0){tdSaved.className='saved';tdSaved.textContent=fmt(saved)+' ('+pct+'%)';}
    else{tdSaved.className='saved zero';tdSaved.textContent='\u2014';}
    tr.appendChild(tdTime);tr.appendChild(tdMode);tr.appendChild(tdBefore);tr.appendChild(tdAfter);tr.appendChild(tdSaved);
    tbody.appendChild(tr);
    // Toggle row
    const trToggle=document.createElement('tr');trToggle.className='toggle-row';
    const tdToggle=document.createElement('td');tdToggle.colSpan=5;
    const toggleDiv=document.createElement('div');toggleDiv.className='show-toggle'+(isOpen?' open':'');
    toggleDiv.onclick=function(e){e.stopPropagation();toggle(id);};
    toggleDiv.innerHTML='<span class="tri">\u25bc</span> Show messages';
    tdToggle.appendChild(toggleDiv);trToggle.appendChild(tdToggle);tbody.appendChild(trToggle);
    // Panes row
    const trPanes=document.createElement('tr');trPanes.className='panes-row';
    const tdPanes=document.createElement('td');tdPanes.colSpan=5;
    const panesDiv=document.createElement('div');panesDiv.className='panes'+(isOpen?' open':'');
    const origPane=document.createElement('div');origPane.className='pane pane-orig';
    origPane.innerHTML='<div class="pane-label">ORIGINAL</div>'+renderBubbles(d.original||'');
    const compPane=document.createElement('div');compPane.className='pane pane-comp';
    compPane.innerHTML='<div class="pane-label">COMPILED</div>'+renderBubbles(d.compiled||'');
    panesDiv.appendChild(origPane);panesDiv.appendChild(compPane);
    tdPanes.appendChild(panesDiv);trPanes.appendChild(tdPanes);tbody.appendChild(trPanes);
  });
}
load();setInterval(load,10000);
`;

// ── Copilot Message Inspector HTML ───────────────────────────────────────────
const COPILOT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>CCC \u2014 Copilot Message Inspector</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--blue:#3b82f6;
    --yellow:#eab308;--text:#e2e8f0;--muted:#64748b;--purple:#a855f7}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;padding:20px}
  h1{font-size:1.3rem;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:.82rem;margin-bottom:20px}
  .nav{display:flex;gap:12px;margin-bottom:20px}
  .nav a{color:var(--blue);font-size:.85rem;text-decoration:none}
  .nav a:hover{text-decoration:underline}
  .toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .btn{background:var(--blue);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:.8rem;cursor:pointer}
  .search-box{background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 12px;font-size:.8rem;width:220px}
  .search-box:focus{outline:none;border-color:var(--blue)}
  .count-badge{color:var(--muted);font-size:.8rem;margin-left:auto}
  .req-list{display:flex;flex-direction:column;gap:10px}
  .req-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .req-header{display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;user-select:none}
  .req-header:hover{background:#202336}
  .req-id{font-family:monospace;font-size:.78rem;color:var(--muted)}
  .req-time{font-size:.75rem;color:var(--muted);margin-left:auto}
  .model-tag{font-size:.72rem;color:var(--yellow);background:#1c1008;padding:2px 8px;border-radius:6px}
  .token-tag{font-size:.72rem;color:var(--muted);background:#1e293b;padding:2px 8px;border-radius:6px}
  .chevron{color:var(--muted);font-size:.9rem;transition:transform .2s}
  .chevron.open{transform:rotate(90deg)}
  .chat-panes{display:none;grid-template-columns:1fr 1fr;gap:0}
  .chat-panes.open{display:grid}
  .pane{padding:16px;overflow:auto;max-height:600px}
  .pane-input{background:#1a1d27;border-right:1px solid var(--border)}
  .pane-output{background:#0d1f17}
  .pane-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
  .pane-input .pane-label{color:#94a3b8}
  .pane-output .pane-label{color:var(--green)}
  .messages{display:flex;flex-direction:column;gap:8px}
  .bubble-wrap{display:flex;flex-direction:column}
  .bubble-wrap.user{align-items:flex-end}
  .bubble-wrap.assistant{align-items:flex-start}
  .bubble-wrap.system{align-items:center}
  .bubble-role{font-size:.65rem;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;padding:0 6px}
  .bubble{max-width:92%;padding:10px 14px;border-radius:14px;font-size:.8rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .bubble.user{background:#1e3a5f;border-bottom-right-radius:4px}
  .bubble.assistant{background:#1a1d27;border:1px solid var(--border);border-bottom-left-radius:4px}
  .bubble.system{background:#1c1008;border:1px dashed #78350f;color:#fde68a;border-radius:8px;font-size:.75rem;max-width:100%}
  .pane-output .bubble.assistant{background:#0d1f17;border:1px solid #14532d}
  .empty-state{color:var(--muted);text-align:center;padding:60px 20px;font-size:.9rem}
</style>
</head>
<body>
<h1>\ud83d\udd0d Copilot Message Inspector</h1>
<p class="subtitle">Left: input sent to LLM \u00b7 Right: response received</p>
<div class="nav"><a href="/dashboard">Dashboard</a><a href="/compilation">Message Inspector</a><a href="/copilot">Copilot Inspector</a></div>
<div class="toolbar">
  <button class="btn" onclick="load()">&#x21bb; Refresh</button>
  <input class="search-box" id="search" placeholder="Filter by model or text\u2026" oninput="renderList()">
  <span class="count-badge" id="count-badge"></span>
</div>
<div id="req-list" class="req-list"></div>
<script src="/copilot.js"></script>
</body></html>
`;

// ── Copilot Inspector JS ──────────────────────────────────────────────────────
const COPILOT_JS = `
let _data=[];
const _open=new Set();
function parseMessages(txt){
  const parts=[];let cur='';
  const lines=txt.split('\\n');
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if((line==='[USER]'||line==='[ASSISTANT]'||line==='[SYSTEM]')&&cur.trim()){parts.push(cur.trim());cur=line;}
    else{cur+=(cur?'\\n':'')+line;}
  }
  if(cur.trim())parts.push(cur.trim());
  return parts.map(function(b){
    const nl=b.indexOf('\\n');
    const role=nl>-1?b.slice(1,nl-1).toLowerCase():'unknown';
    const text=nl>-1?b.slice(nl+1).trim():b.trim();
    return{role:role,text:text};
  }).filter(function(m){return m.text;});
}
function renderBubbles(txt){
  if(!txt||!txt.trim()){
    const d=document.createElement('div');d.style.cssText='color:#64748b;font-size:.8rem;padding:8px';d.textContent='(empty)';return d.outerHTML;
  }
  const msgs=parseMessages(txt);
  if(!msgs.length){
    const d=document.createElement('div');d.className='bubble-wrap assistant';
    const b=document.createElement('div');b.className='bubble assistant';b.textContent=txt.trim();
    d.appendChild(b);const wrap=document.createElement('div');wrap.className='messages';wrap.appendChild(d);return wrap.outerHTML;
  }
  const wrap=document.createElement('div');wrap.className='messages';
  msgs.forEach(function(m){
    const bw=document.createElement('div');bw.className='bubble-wrap '+m.role;
    const br=document.createElement('div');br.className='bubble-role';br.textContent=m.role;
    const bb=document.createElement('div');bb.className='bubble '+m.role;bb.textContent=m.text;
    bw.appendChild(br);bw.appendChild(bb);wrap.appendChild(bw);
  });
  return wrap.outerHTML;
}
async function load(){
  try{
    const r=await fetch('/copilot/data');
    _data=await r.json();
    renderList();
  }catch(e){
    const el=document.getElementById('req-list');
    el.innerHTML='';const d=document.createElement('div');d.className='empty-state';d.textContent='Error loading data';el.appendChild(d);
  }
}
function toggle(id){if(_open.has(id)){_open.delete(id);}else{_open.add(id);}renderList();}
function renderList(){
  const q=document.getElementById('search').value.toLowerCase();
  const filtered=q?_data.filter(function(d){return d.model.toLowerCase().includes(q)||(d.input||'').toLowerCase().includes(q)||(d.output||'').toLowerCase().includes(q);}):_data;
  document.getElementById('count-badge').textContent=filtered.length+' / '+_data.length+' requests';
  const listEl=document.getElementById('req-list');
  listEl.innerHTML='';
  if(!filtered.length){
    const d=document.createElement('div');d.className='empty-state';
    d.textContent=_data.length?'No matching requests.':'No requests yet \u2014 send a message through ContextCompilerCopilot.';
    listEl.appendChild(d);return;
  }
  filtered.forEach(function(d){
    const cardId='cpc-'+d.request_id;
    const isOpen=_open.has(cardId);
    const card=document.createElement('div');card.className='req-card';
    const header=document.createElement('div');header.className='req-header';
    header.onclick=function(){toggle(cardId);};
    const chev=document.createElement('span');chev.className='chevron'+(isOpen?' open':'');chev.textContent='\u25b6';
    const rid=document.createElement('span');rid.className='req-id';rid.textContent=d.request_id.slice(0,8)+'\u2026';
    const modelTag=document.createElement('span');modelTag.className='model-tag';modelTag.textContent=d.model;
    const tokTag=document.createElement('span');tokTag.className='token-tag';tokTag.textContent='~'+d.prompt_tokens+' tokens';
    const reqTime=document.createElement('span');reqTime.className='req-time';reqTime.textContent=new Date(d.timestamp).toLocaleString();
    header.appendChild(chev);header.appendChild(rid);header.appendChild(modelTag);header.appendChild(tokTag);header.appendChild(reqTime);
    const panes=document.createElement('div');panes.className='chat-panes'+(isOpen?' open':'');
    const inputPane=document.createElement('div');inputPane.className='pane pane-input';
    inputPane.innerHTML='<div class="pane-label">Input to LLM</div>'+renderBubbles(d.input||'');
    const outputPane=document.createElement('div');outputPane.className='pane pane-output';
    outputPane.innerHTML='<div class="pane-label">Response received</div>'+renderBubbles('[ASSISTANT]\\n'+(d.output||''));
    panes.appendChild(inputPane);panes.appendChild(outputPane);
    card.appendChild(header);card.appendChild(panes);listEl.appendChild(card);
  });
}
load();setInterval(load,10000);
`;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/**
 * Normalise the request path for the upstream API.
 * VS Code sends /v1/chat/completions but the enterprise/business endpoints
 * expect /chat/completions (no /v1/ prefix).
 */
function normaliseUpstreamPath(path: string, baseUrl: string): string {
  if (baseUrl.includes('enterprise') || baseUrl.includes('business')) {
    return path.replace(/^\/v1\//, '/');
  }
  return path;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('contextCompilerCopilot');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    proxyPort: cfg.get<number>('proxyPort', 8181),
    recentTurns: cfg.get<number>('recentTurns', 3),
    maxToolChars: cfg.get<number>('maxToolChars', 200),
    extractionModel: cfg.get<string>('extractionModel', 'claude-haiku-4.5'),
    logExchanges: cfg.get<boolean>('logExchanges', false),
  };
}

export class ProxyServer {
  private server: http.Server | null = null;
  private _port = 8181;
  get port(): number { return this._port; }
  private outputChannel: vscode.OutputChannel;
  private storageUri: vscode.Uri | undefined;

  constructor(outputChannel: vscode.OutputChannel, storageUri?: vscode.Uri) {
    this.outputChannel = outputChannel;
    this.storageUri = storageUri;
  }

  start(port: number): void {
    this._port = port;
    this.server = http.createServer((req, res) => {
      if (this.handleDashboardRoutes(req, res)) return;
      this.handleRequest(req, res).catch((err) => {
        this.outputChannel.appendLine(`[proxy] unhandled error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal proxy error');
        }
      });
    });

    this.server.listen(port, '127.0.0.1', () => {
      this.outputChannel.appendLine(`[cc] Proxy listening on http://127.0.0.1:${port}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  private handleDashboardRoutes(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const urlPath = req.url ?? '/';
    if (req.method !== 'GET') return false;
    const htmlHeaders = {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    };
    if (urlPath === '/dashboard') { res.writeHead(200, htmlHeaders); res.end(DASHBOARD_HTML); return true; }
    if (urlPath === '/compilation') { res.writeHead(200, htmlHeaders); res.end(COMPILATION_HTML); return true; }
    if (urlPath === '/dashboard.js') { res.writeHead(200, {'content-type':'application/javascript'}); res.end(DASHBOARD_JS); return true; }
    if (urlPath === '/compilation.js') { res.writeHead(200, {'content-type':'application/javascript'}); res.end(COMPILATION_JS); return true; }
    if (urlPath === '/copilot') { res.writeHead(200, htmlHeaders); res.end(COPILOT_HTML); return true; }
    if (urlPath === '/copilot.js') { res.writeHead(200, {'content-type':'application/javascript'}); res.end(COPILOT_JS); return true; }
    if (urlPath === '/copilot/data') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(_copilotStore)); return true; }
    if (urlPath === '/compilation/data') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(_compilationStore)); return true; }
    if (urlPath === '/metrics/detail') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({recent_requests:_compilationStore})); return true; }
    return false;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.handleDashboardRoutes(req, res)) return;

    const cfg = getConfig();

    // Collect request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const requestId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const startTime = Date.now();

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody);
    } catch {
      // non-JSON: pass through as-is
    }

    const messages = (body.messages ?? []) as Message[];
    const model = (body.model as string) ?? 'unknown';
    // Skip internal vscode.lm extraction calls that flow through the proxy
    if (model === 'unknown') {
      const optimisedBody = body;
      const upstream2 = await (async () => {
        let copilotToken2: string; let baseUrl2: string;
        try { ({ token: copilotToken2, baseUrl: baseUrl2 } = await getCopilotToken()); } catch { res.writeHead(401); res.end(); return null; }
        const fwdHeaders: Record<string,string> = {};
        for (const [k,v] of Object.entries(req.headers)) { if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') fwdHeaders[k]=v; }
        fwdHeaders['content-type']='application/json'; fwdHeaders['authorization']=`Bearer ${copilotToken2}`;
        fwdHeaders['editor-version']=fwdHeaders['editor-version']??'vscode/1.95.0';
        fwdHeaders['editor-plugin-version']=fwdHeaders['editor-plugin-version']??'copilot/1.0.0';
        fwdHeaders['user-agent']=fwdHeaders['user-agent']??'GithubCopilot/1.0.0';
        fwdHeaders['copilot-integration-id']=fwdHeaders['copilot-integration-id']??'vscode-chat';
        const pathU = req.url ?? '/v1/chat/completions';
        const upU = normaliseUpstreamPath(pathU, baseUrl2);
        return fetch(`${baseUrl2}${upU}`, { method: req.method??'POST', headers: fwdHeaders, body: JSON.stringify(optimisedBody) });
      })();
      if (!upstream2) return;
      upstream2.headers.forEach((v,k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) res.setHeader(k,v); });
      res.writeHead(upstream2.status);
      if (upstream2.body) { const r=upstream2.body.getReader(); const pump2=async():Promise<void>=>{const{done,value}=await r.read();if(done){res.end();return;}res.write(value);return pump2();}; await pump2(); } else res.end();
      return;
    }

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = v;
    }

    let pipelineResult;
    if (cfg.enabled && Array.isArray(body.messages)) {
      const cts = new vscode.CancellationTokenSource();
      const rawCallLLM = makeVscodeLLMCaller(cfg.extractionModel, cts.token, (input, output, llmModel) => {
        const haikuId = requestId + '-extraction';
        const promptTokens = Math.round(input.length / 4);
        storeCopilotExchange(haikuId, llmModel + ' (extraction)', input, output, promptTokens);
      });
      // Wrap to surface extraction errors to the output channel
      const callLLM: typeof rawCallLLM = async (sys, usr) => {
        try {
          return await rawCallLLM(sys, usr);
        } catch (err) {
          this.outputChannel.appendLine(`[cc] extraction failed (model=${cfg.extractionModel}): ${err}`);
          throw err;
        }
      };
      try {
        pipelineResult = await runPipeline({
          messages,
          headers,
          body,
          callLLM,
          recentTurns: cfg.recentTurns,
          maxToolChars: cfg.maxToolChars,
        });
      } catch (err) {
        this.outputChannel.appendLine(`[cc] pipeline error: ${err}`);
        pipelineResult = null;
      } finally {
        cts.dispose();
      }
    }

    const optimisedBody = pipelineResult
      ? { ...body, messages: pipelineResult.messages }
      : body;

    // Record for dashboard/compilation viewer and sidebar stats
    const latencyMs = Date.now() - startTime;
    const rawTokens = pipelineResult?.tokensBefore ?? 0;
    const compiledTokens = pipelineResult?.tokensAfter ?? rawTokens;
    storeCompilation(
      requestId, model,
      pipelineResult?.mode ?? 'passthrough',
      body, optimisedBody as Record<string, unknown>,
      rawTokens, compiledTokens, latencyMs,
      pipelineResult ?? undefined,
      cfg.extractionModel,
    );

    if (pipelineResult) {
      const saved = pipelineResult.tokensBefore - pipelineResult.tokensAfter;
      if (saved > 0) {
        this.outputChannel.appendLine(
          `[cc] ${pipelineResult.mode} | saved ${saved} tokens (${pipelineResult.removedSections.length} sections removed)`,
        );
      }
    }

    // Get a real Copilot token (cached, auto-refreshed from VS Code's GitHub session)
    let copilotToken: string;
    let baseUrl: string;
    try {
      ({ token: copilotToken, baseUrl } = await getCopilotToken());
    } catch (err) {
      this.outputChannel.appendLine(`[cc] auth error: ${err}`);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }

    // Forward to real Copilot API
    const path = req.url ?? '/v1/chat/completions';
    const upstreamPath = normaliseUpstreamPath(path, baseUrl);
    const targetUrl = `${baseUrl}${upstreamPath}`;

    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') {
        forwardHeaders[k] = v;
      }
    }
    // Required headers — always set, overriding whatever came in
    forwardHeaders['content-type'] = 'application/json';
    forwardHeaders['authorization'] = `Bearer ${copilotToken}`;
    forwardHeaders['editor-version'] = forwardHeaders['editor-version'] ?? 'vscode/1.95.0';
    forwardHeaders['editor-plugin-version'] = forwardHeaders['editor-plugin-version'] ?? 'copilot/1.0.0';
    forwardHeaders['user-agent'] = forwardHeaders['user-agent'] ?? 'GithubCopilot/1.0.0';
    forwardHeaders['copilot-integration-id'] = forwardHeaders['copilot-integration-id'] ?? 'vscode-chat';

    const upstream = await fetch(targetUrl, {
      method: req.method ?? 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(optimisedBody),
    });

    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.writeHead(upstream.status);

    const isStream = body.stream === true;
    const copilotInput = _bodyToText(optimisedBody as Record<string, unknown>);
    const sseChunks: string[] = [];

    if (isStream && upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          const output = extractSseContent(sseChunks);
          storeCopilotExchange(requestId, model, copilotInput, output, compiledTokens);
          return;
        }
        res.write(value);
        sseChunks.push(decoder.decode(value, { stream: true }));
        return pump();
      };
      await pump();
    } else {
      const buf = await upstream.arrayBuffer();
      const responseText = Buffer.from(buf).toString('utf8');
      res.end(Buffer.from(buf));
      try {
        const parsed = JSON.parse(responseText);
        const output = parsed?.choices?.[0]?.message?.content ?? '';
        storeCopilotExchange(requestId, model, copilotInput, output, compiledTokens);
      } catch { /* skip */ }
    }
  }
}
