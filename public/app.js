const $ = s => document.querySelector(s);
const drop = $("#drop"), fileInput = $("#file"), uploadBtn = $("#uploadBtn");
const tbody = $("#tbody"), result = $("#result"), progress = $("#progress");
const uploadInfo = $("#uploadInfo");

let pickedFile = null;

function fmtSize(b){ if(b<1024) return b+" B"; if(b<1024*1024) return (b/1024).toFixed(1)+" KB"; return (b/1024/1024).toFixed(2)+" MB"; }
function fmtDate(ts){ return new Date(ts).toLocaleString(); }

function setPicked(file){
  pickedFile = file;
  if(!file){ uploadInfo.textContent=""; uploadBtn.disabled=true; return; }
  uploadInfo.textContent = `Selected: ${file.name} • ${fmtSize(file.size)} • ${file.type || "unknown type"}`;
  if(file.size > 25*1024*1024) uploadInfo.textContent += " ⚠️ Too large (max 25MB)";
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

function esc(s){ return String(s).replace(/[&<>"']/g, m=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function isSafeId(id){ return /^[A-Za-z0-9]{6,12}$/.test(id); }

async function copyText(text, btn){
  try{
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent='Copied!';
    setTimeout(()=>btn.textContent=orig, 1200);
  } catch{
    // Fallback: prompt
    prompt("Copy URL:", text);
  }
}

function showResult(url, filename, size){
  result.style.display="flex";
  result.innerHTML="";
  const label = document.createElement("span");
  label.textContent = "Permanent link:";
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = url;
  link.style.wordBreak = "break-all";
  link.style.color = "#0f172a";
  link.style.fontWeight = "600";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn secondary";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", ()=> copyText(url, copyBtn));
  const openLink = document.createElement("a");
  openLink.className = "btn secondary";
  openLink.href = url;
  openLink.target = "_blank";
  openLink.textContent = "Open file";
  openLink.style.textDecoration="none";
  const meta = document.createElement("span");
  meta.className = "small";
  meta.textContent = `${filename} • ${fmtSize(size)}`;
  result.append(label, link, copyBtn, openLink, meta);
}

uploadBtn.addEventListener("click", async ()=>{
  if(!pickedFile) return;
  uploadBtn.disabled = true;
  progress.textContent = "Uploading…";
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
    // Validate returned id/url before rendering
    if(!j.id || !isSafeId(j.id)) throw new Error("Invalid server response");
    // Use location.origin to avoid trusting server's host header injection
    const safeUrl = location.origin + "/p/" + j.id;
    progress.textContent = "✓ Uploaded";
    showResult(safeUrl, j.filename || pickedFile.name, j.size || pickedFile.size);
    setPicked(null);
    fileInput.value="";
    loadList();
  }catch(e){
    progress.textContent = "✗ " + (e.message || "Upload failed");
  } finally {
    uploadBtn.disabled = !pickedFile;
  }
});

async function loadList(){
  tbody.innerHTML = `<tr><td colspan="5" class="small" style="padding:16px;text-align:center">Loading…</td></tr>`;
  try{
    const r = await fetch("/api/list");
    if(!r.ok) throw new Error("Failed to load: " + r.status);
    const j = await r.json();
    const docs = j.docs || [];
    if(docs.length===0){
      tbody.innerHTML = `<tr><td colspan="5" class="small" style="padding:16px;text-align:center">No files yet — upload one above. Permanent links will appear here.</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    for(const d of docs){
      if(!d.id || !isSafeId(d.id)) continue;
      const url = location.origin + "/p/" + d.id;
      const tr = document.createElement("tr");

      const tdFile = document.createElement("td");
      const mono = document.createElement("div");
      mono.className = "mono";
      mono.textContent = d.filename || d.id;
      const small = document.createElement("div");
      small.className = "small";
      small.textContent = (d.title || "") + (d.category ? " • " + d.category : "");
      tdFile.append(mono, small);

      const tdUrl = document.createElement("td");
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.className = "mono";
      a.textContent = location.host + "/p/" + d.id;
      const br = document.createElement("br");
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn secondary";
      copyBtn.style.cssText = "padding:4px 8px;margin-top:6px";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", ()=> copyText(url, copyBtn));
      tdUrl.append(a, br, copyBtn);

      const tdSize = document.createElement("td");
      tdSize.textContent = fmtSize(d.size || 0);

      const tdDate = document.createElement("td");
      tdDate.className = "small";
      tdDate.textContent = d.uploaded_at ? fmtDate(d.uploaded_at) : "";

      const tdActions = document.createElement("td");
      tdActions.className = "actions";
      const view = document.createElement("a");
      view.className = "btn secondary";
      view.href = url;
      view.target = "_blank";
      view.style.cssText = "text-decoration:none;padding:6px 8px";
      view.textContent = "View";
      const delBtn = document.createElement("button");
      delBtn.className = "btn secondary";
      delBtn.style.padding="6px 8px";
      delBtn.textContent="Delete";
      delBtn.addEventListener("click", ()=> delDoc(d.id));
      tdActions.append(view, delBtn);

      tr.append(tdFile, tdUrl, tdSize, tdDate, tdActions);
      tbody.appendChild(tr);
    }
    if(!tbody.children.length){
      tbody.innerHTML = `<tr><td colspan="5" class="small" style="padding:16px;text-align:center">No valid files</td></tr>`;
    }
  }catch(e){
    // Use textContent to avoid XSS
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.style.cssText = "color:#dc2626;padding:16px";
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
