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
    const url = j.url;
    progress.textContent = "✓ Uploaded";
    result.style.display="flex";
    result.innerHTML = `
      <span>Permanent link:</span>
      <a href="${url}" target="_blank" rel="noopener">${url}</a>
      <button class="btn secondary" onclick="navigator.clipboard.writeText('${url}').then(()=>{this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy',1200)})">Copy</button>
      <a class="btn secondary" href="${url}" target="_blank" style="text-decoration:none">Open file</a>
      <span class="small">${j.filename} • ${fmtSize(j.size)}</span>
    `;
    setPicked(null);
    fileInput.value="";
    loadList();
  }catch(e){
    progress.textContent = "✗ " + e.message;
  } finally {
    uploadBtn.disabled = !pickedFile;
  }
});

async function loadList(){
  tbody.innerHTML = `<tr><td colspan="5" class="small" style="padding:16px;text-align:center">Loading…</td></tr>`;
  try{
    const r = await fetch("/api/list");
    const j = await r.json();
    const docs = j.docs || [];
    if(docs.length===0){
      tbody.innerHTML = `<tr><td colspan="5" class="small" style="padding:16px;text-align:center">No files yet — upload one above. Permanent links will appear here.</td></tr>`;
      return;
    }
    tbody.innerHTML = docs.map(d=>{
      const url = location.origin + "/p/" + d.id;
      return `<tr>
        <td><div class="mono">${esc(d.filename)}</div><div class="small">${esc(d.title||"")}${d.category? " • "+esc(d.category):""}</div></td>
        <td><a href="${url}" target="_blank" class="mono">${location.host}/p/${d.id}</a><br><button class="btn secondary" style="padding:4px 8px;margin-top:6px" onclick="navigator.clipboard.writeText('${url}')">Copy</button></td>
        <td>${fmtSize(d.size)}</td>
        <td class="small">${fmtDate(d.uploaded_at)}</td>
        <td class="actions"><a class="btn secondary" href="${url}" target="_blank" style="text-decoration:none;padding:6px 8px">View</a>
        <button class="btn secondary" style="padding:6px 8px" onclick="delDoc('${d.id}')">Delete</button></td>
      </tr>`;
    }).join("");
  }catch(e){
    tbody.innerHTML = `<tr><td colspan="5" style="color:#dc2626;padding:16px">${esc(e.message)}</td></tr>`;
  }
}

function esc(s){ return String(s).replace(/[&<>"']/g, m=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function delDoc(id){
  if(!confirm("Delete "+id+" ? This removes the file and the permanent link.")) return;
  const r = await fetch("/api/delete/"+id, { method:"DELETE" });
  const j = await r.json();
  if(!r.ok) alert(j.error||"Delete failed");
  loadList();
}
window.delDoc = delDoc;
window.loadList = loadList;

loadList();
