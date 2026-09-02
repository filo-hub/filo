const $ = s => document.querySelector(s);
const drop = $("#drop"), fileInput = $("#file"), uploadBtn = $("#uploadBtn");
const tbody = $("#tbody"), grid = $("#grid"), empty = $("#empty"), tableWrap = $("#tableWrap");
const result = $("#result"), progress = $("#progress"), uploadInfo = $("#uploadInfo");
const search = $("#search"), filterCategory = $("#filterCategory"), viewToggle = $("#viewToggle");
const statCount = $("#statCount"), statSize = $("#statSize"), toastEl = $("#toast");

let pickedFile = null;
let allDocs = [];
let view = localStorage.getItem("filo:view") || "table";

// helpers
function fmtSize(b){ if(b<1024) return b+" B"; if(b<1024*1024) return (b/1024).toFixed(1)+" KB"; return (b/1024/1024).toFixed(2)+" MB"; }
function fmtDate(ts){ return new Date(ts).toLocaleString(); }
function isSafeId(id){ return /^[A-Za-z0-9]{6,12}$/.test(id); }
function fileIcon(name){
  const ext=(name.split(".").pop()||"").toLowerCase();
  if(["jpg","jpeg","png","webp","gif","svg"].includes(ext)) return "🖼️";
  if(["mp4","mov","avi","mkv","webm"].includes(ext)) return "🎬";
  if(["mp3","wav","ogg","m4a","flac"].includes(ext)) return "🎵";
  if(["pdf"].includes(ext)) return "📄";
  if(["doc","docx"].includes(ext)) return "📝";
  if(["xls","xlsx","csv"].includes(ext)) return "📊";
  if(["ppt","pptx"].includes(ext)) return "📈";
  if(["zip","rar","7z","tar","gz"].includes(ext)) return "🗜️";
  if(["json","js","ts","html","css"].includes(ext)) return "🧩";
  return "⬡";
}
function pillClass(cat){
  const c=(cat||"").toLowerCase();
  if(!c) return "pill-slate";
  if(c.includes("pci")||c.includes("circular")||c.includes("report")||c.includes("doc")) return "pill-indigo";
  if(c.includes("image")||c.includes("photo")||c.includes("png")||c.includes("jpg")) return "pill-amber";
  if(c.includes("video")||c.includes("mp4")) return "pill-rose";
  if(c.includes("pdf")||c.includes("archive")) return "pill-teal";
  return "pill-slate";
}
function toast(msg, ok=true){
  const d=document.createElement("div");
  d.textContent=(ok?"✓ ":"✕ ")+msg;
  d.style.background= ok ? "#0f172a" : "#9f1239";
  toastEl.appendChild(d);
  setTimeout(()=>{ d.style.opacity="0"; d.style.transform="translateY(4px)"; setTimeout(()=>d.remove(), 300); }, 2200);
}
async function copyText(text, btn){
  try{
    await navigator.clipboard.writeText(text);
    const orig=btn.textContent; btn.textContent="Copied!"; btn.style.background="#dcfce7";
    setTimeout(()=>{btn.textContent=orig; btn.style.background="";},1200);
    toast("Link copied");
  }catch{ prompt("Copy URL:", text); }
}

// picked
function setPicked(file){
  pickedFile=file;
  uploadInfo.innerHTML="";
  if(!file){ uploadBtn.disabled=true; return; }
  const chip = (t, cls="pill-slate")=>{ const s=document.createElement("span"); s.className="chip pill "+cls; s.textContent=t; return s; };
  uploadInfo.append(
    (()=>{ const s=document.createElement("span"); s.textContent=fileIcon(file.name); s.style.fontSize="16px"; return s; })(),
    (()=>{ const b=document.createElement("b"); b.textContent=file.name; b.style.fontWeight="800"; return b; })(),
    chip(fmtSize(file.size), "pill-indigo"),
    chip(file.type||"unknown", "pill-slate")
  );
  if(file.size>25*1024*1024){
    const w=document.createElement("span"); w.className="chip pill pill-rose"; w.textContent="⚠️ Too large (max 25MB)"; uploadInfo.appendChild(w);
  }
  uploadBtn.disabled=file.size===0||file.size>25*1024*1024;
}
drop.addEventListener("click",e=>{ if(e.target.closest("input")) return; fileInput.click(); });
fileInput.addEventListener("change",()=>setPicked(fileInput.files[0]||null));
["dragenter","dragover"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault(); drop.classList.add("drag");}));
["dragleave","drop"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault(); drop.classList.remove("drag");}));
drop.addEventListener("drop",e=>{ const f=e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) setPicked(f); });

// view toggle
function applyView(v){
  view=v; localStorage.setItem("filo:view", v);
  viewToggle.querySelectorAll("button").forEach(b=>b.classList.toggle("active", b.dataset.v===v));
  const isGrid=v==="grid";
  grid.classList.toggle("hidden", !isGrid);
  tableWrap.classList.toggle("hidden", isGrid);
}
viewToggle.addEventListener("click", e=>{
  const b=e.target.closest("button"); if(!b) return; applyView(b.dataset.v);
});
applyView(view);
search.addEventListener("input", render);
filterCategory.addEventListener("change", render);

// result
function showResult(url, filename, size){
  result.style.display="flex"; result.innerHTML="";
  const dot=document.createElement("span"); dot.style.width="8px"; dot.style.height="8px"; dot.style.borderRadius="99px"; dot.style.background="#10b981"; dot.style.boxShadow="0 0 0 6px rgba(16,185,129,.15)";
  const label=document.createElement("span"); label.style.fontWeight="800"; label.style.color="#065f46"; label.textContent="Permanent link:";
  const link=document.createElement("a"); link.href=url; link.target="_blank"; link.rel="noopener"; link.textContent=url;
  const copyBtn=document.createElement("button"); copyBtn.className="btn btn-ghost"; copyBtn.textContent="Copy"; copyBtn.addEventListener("click",()=>copyText(url, copyBtn));
  const open=document.createElement("a"); open.className="btn btn-primary"; open.href=url; open.target="_blank"; open.textContent="Open ↗";
  const meta=document.createElement("span"); meta.className="pill pill-teal"; meta.textContent=`${fileIcon(filename)} ${filename} • ${fmtSize(size)}`;
  result.append(dot,label,link,copyBtn,open,meta);
}

// upload
uploadBtn.addEventListener("click", async()=>{
  if(!pickedFile) return;
  uploadBtn.disabled=true;
  progress.innerHTML=`<span>Uploading…</span><span class="bar"><i style="width:45%"></i></span>`;
  progress.style.color="#4f46e5";
  result.style.display="none"; result.innerHTML="";
  const fd=new FormData(); fd.append("file", pickedFile);
  const title=$("#title").value.trim(), category=$("#category").value.trim();
  if(title) fd.append("title", title);
  if(category) fd.append("category", category);
  try{
    const r=await fetch("/api/upload",{method:"POST", body:fd});
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||"Upload failed");
    if(!j.id||!isSafeId(j.id)) throw new Error("Invalid server response");
    const safeUrl=location.origin+"/p/"+j.id;
    progress.innerHTML=`<span>✓ Uploaded — permanent</span>`;
    progress.style.color="#0d9488";
    showResult(safeUrl, j.filename||pickedFile.name, j.size||pickedFile.size);
    toast("Uploaded — link ready");
    setPicked(null); fileInput.value="";
    await loadList();
  }catch(e){
    progress.textContent="✕ "+(e.message||"Upload failed");
    progress.style.color="#e11d48";
    toast(e.message||"Upload failed", false);
  }finally{
    uploadBtn.disabled=!pickedFile;
    setTimeout(()=>{ progress.textContent=""; }, 3000);
  }
});

// list + render
function updateStats(docs){
  const total=docs.length;
  const bytes=docs.reduce((s,d)=>s+(d.size||0),0);
  statCount.textContent=String(total);
  statSize.textContent=fmtSize(bytes);
}
function populateCategories(docs){
  const cats=[...new Set(docs.map(d=>d.category).filter(Boolean))].sort();
  const cur=filterCategory.value;
  filterCategory.innerHTML='<option value="">All categories</option>';
  for(const c of cats){
    const o=document.createElement("option"); o.value=c; o.textContent=c;
    filterCategory.appendChild(o);
  }
  if([...filterCategory.options].some(o=>o.value===cur)) filterCategory.value=cur;
}
function filteredDocs(){
  const q=(search.value||"").toLowerCase().trim();
  const cat=filterCategory.value;
  return allDocs.filter(d=>{
    if(cat && d.category!==cat) return false;
    if(!q) return true;
    const hay=[d.filename,d.title,d.category,d.id].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
function render(){
  const docs=filteredDocs();
  // empty
  const hasAny=allDocs.length>0;
  empty.classList.toggle("hidden", hasAny);
  if(!hasAny){
    tbody.innerHTML=`<tr><td colspan="5" style="padding:28px; text-align:center; color:#64748b">No files yet — upload one above. ✨</td></tr>`;
    grid.innerHTML="";
    return;
  }
  if(docs.length===0){
    tbody.innerHTML=`<tr><td colspan="5" style="padding:18px; text-align:center; color:#64748b">No results for “${search.value}”</td></tr>`;
    grid.innerHTML=`<div class="empty">No results</div>`;
    return;
  }
  // table
  tbody.innerHTML="";
  grid.innerHTML="";
  for(const d of docs){
    if(!isSafeId(d.id)) continue;
    const url=location.origin+"/p/"+d.id;
    // table row
    const tr=document.createElement("tr");
    const tdFile=document.createElement("td");
    const top=document.createElement("div"); top.style.display="flex"; top.style.gap="10px"; top.style.alignItems="center";
    const ic=document.createElement("span"); ic.textContent=fileIcon(d.filename||d.id); ic.style.fontSize="16px";
    const name=document.createElement("div"); name.className="mono"; name.style.fontWeight="800"; name.textContent=d.filename||d.id;
    top.append(ic,name);
    const meta=document.createElement("div"); meta.style.display="flex"; meta.style.gap="6px"; meta.style.flexWrap="wrap"; meta.style.marginTop="6px";
    if(d.title){ const t=document.createElement("span"); t.className="pill pill-indigo"; t.textContent=d.title; meta.appendChild(t); }
    if(d.category){ const c=document.createElement("span"); c.className="pill "+pillClass(d.category); c.textContent=d.category; meta.appendChild(c); }
    if(!d.title&&!d.category){ const e=document.createElement("span"); e.style.color="#94a3b8"; e.style.fontSize="12px"; e.textContent="—"; meta.appendChild(e); }
    tdFile.append(top,meta);

    const tdUrl=document.createElement("td");
    const a=document.createElement("a"); a.href=url; a.target="_blank"; a.className="mono"; a.style.color="#4338ca"; a.style.fontWeight="800"; a.style.textDecoration="none"; a.style.borderBottom="1px dashed #c7d2fe"; a.textContent=location.host+"/p/"+d.id;
    const br=document.createElement("br");
    const copy=document.createElement("button"); copy.className="btn btn-ghost"; copy.style.padding="6px 10px"; copy.style.fontSize="12px"; copy.textContent="Copy"; copy.addEventListener("click",()=>copyText(url, copy));
    tdUrl.append(a,br,copy);

    const tdSize=document.createElement("td"); const sz=document.createElement("span"); sz.className="pill pill-slate"; sz.textContent=fmtSize(d.size||0); tdSize.appendChild(sz);
    const tdDate=document.createElement("td"); tdDate.style.color="#64748b"; tdDate.style.fontSize="12px"; tdDate.textContent=d.uploaded_at?fmtDate(d.uploaded_at):"";
    const tdAct=document.createElement("td"); tdAct.style.display="flex"; tdAct.style.gap="6px"; tdAct.style.flexWrap="wrap";
    const viewBtn=document.createElement("a"); viewBtn.className="btn btn-ghost"; viewBtn.href=url; viewBtn.target="_blank"; viewBtn.style.padding="7px 10px"; viewBtn.style.fontSize="12px"; viewBtn.style.background="#eef2ff"; viewBtn.style.color="#4338ca"; viewBtn.style.borderColor="#c7d2fe"; viewBtn.textContent="View";
    const del=document.createElement("button"); del.className="btn btn-danger"; del.style.padding="7px 10px"; del.style.fontSize="12px"; del.textContent="Delete"; del.addEventListener("click",()=>delDoc(d.id));
    tdAct.append(viewBtn,del);
    tr.append(tdFile,tdUrl,tdSize,tdDate,tdAct);
    tbody.appendChild(tr);

    // grid card
    const card=document.createElement("div"); card.className="gcard";
    const ctop=document.createElement("div"); ctop.className="top";
    const cicon=document.createElement("div"); cicon.className="icon"; cicon.textContent=fileIcon(d.filename||d.id);
    const cname=document.createElement("div"); cname.style.flex="1"; cname.style.minWidth="0";
    const cn=document.createElement("div"); cn.className="mono"; cn.style.fontWeight="800"; cn.style.whiteSpace="nowrap"; cn.style.overflow="hidden"; cn.style.textOverflow="ellipsis"; cn.textContent=d.filename||d.id;
    const cs=document.createElement("div"); cs.style.fontSize="11px"; cs.style.color="#64748b"; cs.textContent=fmtSize(d.size||0)+" • "+(d.uploaded_at?fmtDate(d.uploaded_at):"");
    cname.append(cn,cs);
    ctop.append(cicon,cname);
    const pills=document.createElement("div"); pills.style.display="flex"; pills.style.gap="6px"; pills.style.flexWrap="wrap";
    if(d.title){ const t=document.createElement("span"); t.className="pill pill-indigo"; t.textContent=d.title; pills.appendChild(t); }
    if(d.category){ const c=document.createElement("span"); c.className="pill "+pillClass(d.category); c.textContent=d.category; pills.appendChild(c); }
    const curl=document.createElement("a"); curl.className="mono"; curl.href=url; curl.target="_blank"; curl.style.color="#4338ca"; curl.style.fontWeight="800"; curl.style.fontSize="12px"; curl.style.textDecoration="none"; curl.style.borderBottom="1px dashed #c7d2fe"; curl.textContent="/p/"+d.id;
    const gact=document.createElement("div"); gact.style.display="flex"; gact.style.gap="8px"; gact.style.marginTop="2px";
    const gcopy=document.createElement("button"); gcopy.className="btn btn-ghost"; gcopy.style.flex="1"; gcopy.textContent="Copy"; gcopy.addEventListener("click",()=>copyText(url,gcopy));
    const gview=document.createElement("a"); gview.className="btn btn-primary"; gview.href=url; gview.target="_blank"; gview.style.flex="1"; gview.style.justifyContent="center"; gview.textContent="Open";
    const gdel=document.createElement("button"); gdel.className="btn btn-danger"; gdel.textContent="✕"; gdel.title="Delete"; gdel.addEventListener("click",()=>delDoc(d.id));
    gact.append(gcopy,gview,gdel);
    card.append(ctop, pills, curl, gact);
    grid.appendChild(card);
  }
}

async function loadList(){
  tbody.innerHTML=`<tr><td colspan="5"><div class="skel" style="width:60%"></div></td></tr>`;
  grid.innerHTML=`<div class="skel" style="height:90px"></div><div class="skel" style="height:90px"></div>`;
  try{
    const r=await fetch("/api/list");
    if(!r.ok) throw new Error("Failed to load: "+r.status);
    const j=await r.json();
    allDocs=(j.docs||[]).filter(d=>d.id && isSafeId(d.id));
    // sort by uploaded_at desc (server already does)
    updateStats(allDocs);
    populateCategories(allDocs);
    render();
  }catch(e){
    tbody.innerHTML=`<tr><td colspan="5" style="color:#e11d48; padding:16px; font-weight:800">${e.message||"Failed"}</td></tr>`;
    toast(e.message||"Load failed", false);
  }
}
async function delDoc(id){
  if(!isSafeId(id)) return alert("Invalid id");
  if(!confirm("Delete "+id+"? Permanent link will break.")) return;
  try{
    const r=await fetch("/api/delete/"+encodeURIComponent(id),{method:"DELETE"});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error||"Delete failed");
    toast("Deleted");
  }catch(e){ alert(e.message||"Delete failed"); toast(e.message||"Delete failed", false); }
  loadList();
}
window.delDoc=delDoc;
window.loadList=loadList;
loadList();
