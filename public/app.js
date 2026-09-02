const $ = s => document.querySelector(s);
const drop = $("#drop"), fileInput = $("#file"), uploadBtn = $("#uploadBtn");
const tbody = $("#tbody"), result = $("#result"), progress = $("#progress");
const uploadInfo = $("#uploadInfo");

let pickedFile = null;

function fmtSize(b){ if(b<1024) return b+" B"; if(b<1024*1024) return (b/1024).toFixed(1)+" KB"; return (b/1024/1024).toFixed(2)+" MB"; }
function fmtDate(ts){ return new Date(ts).toLocaleString(); }
function isSafeId(id){ return /^[A-Za-z0-9]{6,12}$/.test(id); }

function fileIcon(name){
  const ext = (name.split(".").pop()||"").toLowerCase();
  if(["jpg","jpeg","png","webp","gif","svg"].includes(ext)) return "🖼️";
  if(["mp4","mov","avi","mkv"].includes(ext)) return "🎬";
  if(["mp3","wav","ogg","m4a"].includes(ext)) return "🎵";
  if(["pdf"].includes(ext)) return "📄";
  if(["doc","docx"].includes(ext)) return "📝";
  if(["xls","xlsx","csv"].includes(ext)) return "📊";
  if(["ppt","pptx"].includes(ext)) return "📈";
  if(["zip","rar","7z","tar","gz"].includes(ext)) return "🗜️";
  if(["json","js","ts","html","css"].includes(ext)) return "🧩";
  return "📦";
}
function pillClass(cat){
  const c=(cat||"").toLowerCase();
  if(!c) return "pill-sky";
  if(c.includes("pci")||c.includes("circular")||c.includes("report")) return "pill-indigo";
  if(c.includes("image")||c.includes("photo")||c.includes("png")||c.includes("jpg")) return "pill-amber";
  if(c.includes("video")||c.includes("mp4")) return "pill-rose";
  if(c.includes("doc")||c.includes("pdf")) return "pill-emerald";
  return "pill-sky";
}

function setPicked(file){
  pickedFile = file;
  if(!file){ uploadInfo.textContent=""; uploadInfo.className="meta"; uploadBtn.disabled=true; return; }
  uploadInfo.className="meta";
  uploadInfo.innerHTML="";
  const icon = document.createElement("span"); icon.textContent=fileIcon(file.name);
  const name = document.createElement("strong"); name.textContent=file.name;
  const size = document.createElement("span"); size.className="pill pill-indigo"; size.textContent=fmtSize(file.size);
  const type = document.createElement("span"); type.className="muted"; type.textContent=file.type || "unknown type";
  uploadInfo.append(icon, name, size, type);
  if(file.size > 25*1024*1024){
    const warn=document.createElement("span"); warn.className="pill pill-rose"; warn.textContent="⚠️ Too large (max 25MB)";
    uploadInfo.appendChild(warn);
  }
  uploadBtn.disabled = file.size === 0 || file.size > 25*1024*1024;
}

drop.addEventListener("click", (e)=>{
  if(e.target.closest("input")) return;
  fileInput.click();
});
fileInput.addEventListener("change", ()=> setPicked(fileInput.files[0] || null));

["dragenter","dragover"].forEach(ev=> drop.addEventListener(ev, e=>{e.preventDefault(); drop.classList.add("drag");}));
["dragleave","drop"].forEach(ev=> drop.addEventListener(ev, e=>{e.preventDefault(); drop.classList.remove("drag");}));
drop.addEventListener("drop", e=>{
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if(f) setPicked(f);
});

async function copyText(text, btn){
  try{
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent='Copied!';
    btn.style.background="#dcfce7";
    setTimeout(()=>{btn.textContent=orig; btn.style.background="";},1200);
  } catch{
    prompt("Copy URL:", text);
  }
}

function showResult(url, filename, size){
  result.style.display="flex";
  result.innerHTML="";
  const dot=document.createElement("span"); dot.className="progress-dot";
  const label=document.createElement("span"); label.style.fontWeight="800"; label.style.color="#065f46"; label.textContent="Permanent link:";
  const link=document.createElement("a"); link.href=url; link.target="_blank"; link.rel="noopener"; link.textContent=url;
  const copyBtn=document.createElement("button"); copyBtn.className="btn btn-secondary"; copyBtn.textContent="Copy"; copyBtn.addEventListener("click", ()=> copyText(url, copyBtn));
  const openLink=document.createElement("a"); openLink.className="btn btn-primary"; openLink.href=url; openLink.target="_blank"; openLink.textContent="Open ↗";
  const meta=document.createElement("span"); meta.className="pill pill-emerald"; meta.textContent=`${fileIcon(filename)} ${filename} • ${fmtSize(size)}`;
  result.append(dot, label, link, copyBtn, openLink, meta);
}

uploadBtn.addEventListener("click", async ()=>{
  if(!pickedFile) return;
  uploadBtn.disabled = true;
  progress.textContent = "Uploading…";
  progress.className="meta uploading";
  result.style.display="none";
  result.innerHTML="";

  const fd = new FormData();
  fd.append("file", pickedFile);
  const title = $("#title").value.trim();
  const category = $("#category").value.trim();
  if(title) fd.append("title", title);
  if(category) fd.append("category", category);

  try{
    const r = await fetch("/api/upload", { method:"POST", body: fd });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || "Upload failed");
    if(!j.id || !isSafeId(j.id)) throw new Error("Invalid server response");
    const safeUrl = location.origin + "/p/" + j.id;
    progress.textContent = "✓ Uploaded — permanent";
    progress.className="meta success";
    showResult(safeUrl, j.filename || pickedFile.name, j.size || pickedFile.size);
    setPicked(null);
    fileInput.value="";
    loadList();
  }catch(e){
    progress.textContent = "✗ " + (e.message || "Upload failed");
    progress.className="meta error";
  } finally {
    uploadBtn.disabled = !pickedFile;
  }
});

async function loadList(){
  tbody.innerHTML = `<tr><td colspan="5" class="muted" style="padding:18px;text-align:center">Loading…</td></tr>`;
  try{
    const r = await fetch("/api/list");
    if(!r.ok) throw new Error("Failed to load: " + r.status);
    const j = await r.json();
    const docs = j.docs || [];
    if(docs.length===0){
      tbody.innerHTML = `<tr><td colspan="5" class="muted" style="padding:18px;text-align:center">No files yet — upload one above. Permanent links will appear here. 🌈</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    for(const d of docs){
      if(!d.id || !isSafeId(d.id)) continue;
      const url = location.origin + "/p/" + d.id;
      const tr = document.createElement("tr");

      const tdFile = document.createElement("td");
      const titleRow=document.createElement("div"); titleRow.style.display="flex"; titleRow.style.alignItems="center"; titleRow.style.gap="8px";
      const ic=document.createElement("span"); ic.textContent=fileIcon(d.filename||d.id); ic.style.fontSize="16px";
      const mono = document.createElement("div"); mono.className = "mono"; mono.style.fontWeight="700"; mono.textContent = d.filename || d.id;
      titleRow.append(ic, mono);
      const small = document.createElement("div"); small.style.marginTop="4px"; small.style.display="flex"; small.style.gap="6px"; small.style.flexWrap="wrap";
      if(d.title){ const t=document.createElement("span"); t.className="pill pill-indigo"; t.textContent=d.title; small.appendChild(t); }
      if(d.category){ const c=document.createElement("span"); c.className="pill "+pillClass(d.category); c.textContent=d.category; small.appendChild(c); }
      if(!d.title && !d.category){ const e=document.createElement("span"); e.className="muted"; e.textContent="—"; small.appendChild(e); }
      tdFile.append(titleRow, small);

      const tdUrl = document.createElement("td");
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.className = "mono";
      a.style.color="#4338ca"; a.style.fontWeight="700"; a.style.textDecoration="none"; a.style.borderBottom="1px dashed #c7d2fe";
      a.textContent = location.host + "/p/" + d.id;
      const br = document.createElement("br");
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost";
      copyBtn.style.cssText = "padding:6px 10px;margin-top:8px;font-size:12px";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", ()=> copyText(url, copyBtn));
      tdUrl.append(a, br, copyBtn);

      const tdSize = document.createElement("td");
      const sz=document.createElement("span"); sz.className="pill pill-sky"; sz.textContent=fmtSize(d.size || 0);
      tdSize.appendChild(sz);

      const tdDate = document.createElement("td");
      tdDate.className = "muted";
      tdDate.style.fontSize="12px";
      tdDate.textContent = d.uploaded_at ? fmtDate(d.uploaded_at) : "";

      const tdActions = document.createElement("td");
      tdActions.className = "actions";
      const view = document.createElement("a");
      view.className = "btn btn-secondary";
      view.href = url;
      view.target = "_blank";
      view.style.cssText = "text-decoration:none;padding:7px 10px;font-size:12px;background:#eef2ff;color:#4338ca;border-color:#c7d2fe";
      view.textContent = "View";
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-ghost";
      delBtn.style.padding="7px 10px"; delBtn.style.fontSize="12px";
      delBtn.textContent="Delete";
      delBtn.addEventListener("click", ()=> delDoc(d.id));
      tdActions.append(view, delBtn);

      tr.append(tdFile, tdUrl, tdSize, tdDate, tdActions);
      tbody.appendChild(tr);
    }
    if(!tbody.children.length){
      tbody.innerHTML = `<tr><td colspan="5" class="muted" style="padding:18px;text-align:center">No valid files</td></tr>`;
    }
  }catch(e){
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.style.cssText = "color:#dc2626;padding:16px;font-weight:700";
    td.textContent = e.message || "Failed to load";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function delDoc(id){
  if(!isSafeId(id)) { alert("Invalid id"); return; }
  if(!confirm("Delete "+id+" ? This removes the file and the permanent link.")) return;
  try{
    const r = await fetch("/api/delete/"+ encodeURIComponent(id), { method:"DELETE" });
    const j = await r.json().catch(()=> ({}));
    if(!r.ok) alert(j.error||"Delete failed");
  } catch(e){
    alert(e.message || "Delete failed");
  }
  loadList();
}
window.delDoc = delDoc;
window.loadList = loadList;

loadList();
