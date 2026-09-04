<script>
  let picked = $state(null)
  let title = $state('')
  let progress = $state('')
  let pct = $state(-1)          // real upload % (XHR), -1 = not uploading
  let result = $state(null)
  let docs = $state([])
  let total = $state(0)         // true file count from the server (not just the loaded page)
  let q = $state('')
  let drag = $state(false)
  let fileInput
  let needToken = $state(false)
  let openMode = $state(false)   // server has no UPLOAD_TOKEN set
  let tokenInput = $state('')
  let token = ''
  try{ token = localStorage.getItem('filo_token') || '' }catch{}
  function authHeaders(){ return token ? { 'x-upload-token': token } : {} }
  let now = $state(new Date())
  $effect(()=>{
    const t=setInterval(()=>now=new Date(),1000)
    return ()=>clearInterval(t)
  })

  function fmtSize(b){
    if(b<1024) return b+' B'
    if(b<1024*1024) return (b/1024).toFixed(1)+' KB'
    if(b<1024*1024*1024) return (b/1024/1024).toFixed(2)+' MB'
    return (b/1024/1024/1024).toFixed(2)+' GB'
  }
  function fmtDate(ts){ return new Date(ts).toLocaleDateString() }
  function isSafeId(id){ return /^[A-Za-z0-9]{6,12}$/.test(id) }
  function fileIcon(name){
    const ext=(name.split('.').pop()||'').toLowerCase()
    if(['jpg','jpeg','png','webp','gif','svg'].includes(ext)) return '🖼️'
    if(['mp4','mov','webm'].includes(ext)) return '🎬'
    if(['mp3','wav'].includes(ext)) return '🎵'
    if(ext==='pdf') return '📄'
    if(['doc','docx'].includes(ext)) return '📝'
    if(['xls','xlsx','csv'].includes(ext)) return '📊'
    if(['zip','rar','7z'].includes(ext)) return '🗜️'
    return '📄'
  }

  let storage = $state({ total:0, count:0, quota: 10*1024*1024*1024 }) // quota = server-configured (MAX_STORAGE_MB), default R2 free tier
  let filtered = $derived(docs.filter(d=>{
    if(!q) return true
    const hay=[d.filename,d.title,d.id].join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  }))

  async function load(reset=true){
    try{
      // reset=true → first page; reset=false → append the next 200 (Load more)
      const r=await fetch(reset?'/api/list':`/api/list?offset=${docs.length}`,{headers:authHeaders()})
      if(r.status===401){
        needToken=true; token=''
        try{ localStorage.removeItem('filo_token') }catch{}
        progress='✕ Access token required'; setTimeout(()=>progress='',3000)
        return
      }
      needToken=false
      const j=await r.json()
      const page=(j.docs||[]).filter(d=>isSafeId(d.id))
      total=j.total||0
      if(reset){ docs=page }
      else{
        // offset shifts as files come and go — dedupe by id when appending
        const seen=new Set(docs.map(d=>d.id))
        docs=[...docs, ...page.filter(d=>!seen.has(d.id))]
        if(total<docs.length) total=docs.length
      }
    }catch(e){ progress='Failed to load'; setTimeout(()=>progress='',3000) }
    try{
      const r=await fetch('/api/storage',{headers:authHeaders()})
      const j=await r.json()
      if(j.total!=null) storage={ total:j.total, count:j.count||0, quota:j.quota||storage.quota }
    }catch{}
  }
  function saveToken(){
    token=tokenInput.trim()
    try{ token ? localStorage.setItem('filo_token',token) : localStorage.removeItem('filo_token') }catch{}
    tokenInput=''
    load()
  }
  $effect(()=>{ load(true) })
  $effect(()=>{
    // health is public and reports whether the token gate is on —
    // lets us show the open-mode warning without an auth round-trip
    fetch('/api/health').then(r=>r.json()).then(j=>{ openMode = j.auth===false }).catch(()=>{})
  })
  function onPick(f){ if(!f){ picked=null; return } picked=f }
  function uploadViaXHR(fd){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest()
      xhr.open('POST','/api/upload')
      for(const [k,v] of Object.entries(authHeaders())) xhr.setRequestHeader(k,v)
      xhr.upload.onprogress=(e)=>{ if(e.lengthComputable) pct=Math.round(e.loaded/e.total*100) }
      xhr.onload=()=>{
        let j={}
        try{ j=JSON.parse(xhr.responseText) }catch{}
        if(xhr.status===401){ needToken=true; return reject(new Error('Access token required')) }
        if(xhr.status<200||xhr.status>=300) return reject(new Error(j.error||`Upload failed (HTTP ${xhr.status})`))
        resolve(j)
      }
      xhr.onerror=()=>reject(new Error('Network error during upload'))
      xhr.send(fd)
    })
  }
  async function doUpload(){
    if(!picked) return
    progress='Uploading…'; pct=0; result=null
    const fd=new FormData()
    fd.append('file', picked)
    if(title.trim()) fd.append('title', title.trim())
    try{
      const j=await uploadViaXHR(fd)
      result={ url: location.origin+'/p/'+j.id, filename:j.filename, size:j.size }
      progress='✓ Uploaded'; picked=null; if(fileInput) fileInput.value=''; title=''
      load(true); setTimeout(()=>{ progress=''; pct=-1 },2000)
    }catch(e){ progress='✕ '+(e.message||'Failed'); setTimeout(()=>{ progress=''; pct=-1 },3000) }
  }
  async function copy(t){ try{ await navigator.clipboard.writeText(t) }catch{ prompt('Copy',t) } }
  async function del(id){
    if(!confirm('Delete '+id+'?')) return
    try{
      const r=await fetch('/api/delete/'+encodeURIComponent(id),{method:'DELETE', headers:authHeaders()})
      const j=await r.json().catch(()=>({}))
      if(r.status===401){ needToken=true; throw new Error('Access token required') }
      if(!r.ok) throw new Error(j.error||'Delete failed')
      load()
    }catch(e){ progress='✕ '+(e.message||'Delete failed'); setTimeout(()=>progress='',3000) }
  }
</script>

<div class="h-screen flex bg-[#fcfcfd] text-zinc-900 overflow-hidden">
  <!-- sidebar -->
  <aside class="hidden md:flex w-[160px] shrink-0 bg-white border-r border-zinc-200 flex-col">
    <div class="h-[56px] px-5 flex items-center border-b border-zinc-200">
      <div class="font-bold text-[22px] tracking-tight leading-none">filo</div>
    </div>
    <nav class="p-3 flex-1 space-y-1">
      <div class="text-[11px] font-bold tracking-widest text-zinc-400 px-2 py-2">MENU</div>
      <button onclick={()=>q=''} class="w-full text-left px-3 py-2 rounded-xl text-[13px] font-bold flex items-center gap-2 bg-zinc-900 text-white"><span>▦</span> All files <span class="ml-auto text-[11px] opacity-60">{total}</span></button>
    </nav>
    <div class="p-3 border-t border-zinc-100">
      <div class="p-3 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
        <div class="text-[11px] opacity-80">Used</div>
        <div class="text-[13px] font-bold">{fmtSize(storage.total)} / {fmtSize(storage.quota)}</div>
        <div class="mt-2 h-1.5 rounded-full bg-white/20 overflow-hidden"><div class="h-full bg-white rounded-full" style="width: {Math.min(100, storage.total/storage.quota*100)}%"></div></div>
      </div>
    </div>
  </aside>

  <!-- main -->
  <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
    <!-- header -->
    <header class="h-[56px] shrink-0 bg-white/80 backdrop-blur border-b border-zinc-200 flex items-center gap-3 px-4 md:px-6">
      <div class="flex-1 max-w-[420px]">
        <input bind:value={q} placeholder="Search…" class="w-full px-3 py-2 rounded-full bg-zinc-100 border border-transparent focus:bg-white focus:border-zinc-900 focus:outline-none text-[13px]" />
      </div>
      {#if needToken}
        <div class="ml-auto flex items-center gap-2">
          <input bind:value={tokenInput} placeholder="Access token" type="password" onkeydown={(e)=>{if(e.key==='Enter')saveToken()}} class="px-3 py-2 rounded-full bg-zinc-100 border border-transparent focus:bg-white focus:border-zinc-900 focus:outline-none text-[13px] w-[180px]" />
          <button onclick={saveToken} class="px-4 py-2 rounded-full bg-zinc-900 text-white text-[12px] font-bold">Save</button>
        </div>
      {:else}
        <div class="ml-auto hidden sm:block text-[12px] text-zinc-600">
          {now.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric', year:'numeric'})} — {now.toLocaleTimeString('en-US',{hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})}
        </div>
      {/if}
    </header>

    <!-- content -->
    <div class="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6 bg-[#fcfcfd]">
      {#if openMode && !needToken}
        <div class="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-[12px]">
          <span class="shrink-0 mt-px">⚠</span>
          <div>Open mode — anyone who finds this URL can upload or delete files. Set an <code class="font-mono text-[11px] bg-amber-100 px-1 rounded">UPLOAD_TOKEN</code> secret on the server to lock it down.</div>
        </div>
      {/if}
      <!-- upload — one box split in two, drop as reference -->
      <div class="bg-white border border-zinc-200 rounded-[20px] overflow-hidden shadow-sm">
        <div class="p-5 md:p-6">
          <h1 class="text-[22px] font-bold tracking-tight leading-none">Upload once,<br><span class="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">link forever.</span></h1>
          <div class="mt-4 flex flex-col lg:flex-row gap-4">
            <!-- left — drop reference -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <label
              ondragover={(e)=>{e.preventDefault(); drag=true}}
              ondragenter={(e)=>{e.preventDefault(); drag=true}}
              ondragleave={(e)=>{e.preventDefault(); drag=false}}
              ondrop={(e)=>{e.preventDefault(); drag=false; const f=e.dataTransfer.files[0]; if(f) onPick(f)}}
              onclick={()=>fileInput?.click()}
              class="flex-1 border-2 border-dashed rounded-2xl h-[200px] flex flex-col justify-center items-center gap-2 text-center cursor-pointer transition {drag?'border-indigo-500 bg-indigo-50':'border-zinc-200 bg-zinc-50 hover:bg-white hover:border-zinc-900'}"
            >
              <div class="w-10 h-10 rounded-xl bg-white border shadow-sm grid place-items-center">⬆</div>
              <div class="text-[13px] font-bold">Drop file or click</div>
              <input bind:this={fileInput} type="file" class="hidden" onchange={(e)=>onPick(e.target.files[0])} />
            </label>
            <!-- right — Title + Upload, same 200px, parallel -->
            <div class="flex-1 h-[200px] flex flex-col justify-center gap-3">
              <input bind:value={title} placeholder="Title" class="w-full h-[42px] px-3 border border-zinc-200 rounded-xl bg-zinc-50 focus:bg-white focus:border-zinc-900 outline-none text-[13px] shrink-0" />
              <button onclick={doUpload} disabled={!picked} class="w-full h-[44px] rounded-xl bg-zinc-900 text-white font-bold text-[13px] disabled:opacity-40 flex justify-center items-center gap-2 hover:bg-black shrink-0">
                {#if progress==='Uploading…'}
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  {#if pct>=0}<span>{pct}%</span>{:else}<span>Uploading…</span>{/if}
                {:else}
                  Upload
                {/if}
              </button>
              {#if progress==='Uploading…' && pct>=0}
                <div class="h-1.5 rounded-full bg-zinc-100 overflow-hidden"><div class="h-full bg-indigo-600 rounded-full transition-all" style="width:{pct}%"></div></div>
              {/if}
            {#if picked}
              <div class="flex items-center gap-2 text-[12px] p-2.5 rounded-xl bg-zinc-50 border">
                <span>{fileIcon(picked.name)}</span>
                <span class="font-bold truncate flex-1">{picked.name}</span>
                <span class="px-2 py-1 rounded-full bg-white border text-[11px] font-bold">{fmtSize(picked.size)}</span>
              </div>
            {/if}
            {#if progress && progress!=='Uploading…' }<div class="text-[12px] font-bold {progress.startsWith('✓')?'text-emerald-600':'text-zinc-500'}">{progress}</div>{/if}
            {#if result}
              <div class="p-3 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
                <div class="text-[11px] opacity-80">Permanent link</div>
                <a href={result.url} target="_blank" class="font-mono text-[13px] font-bold break-all underline decoration-white/30">{result.url}</a>
                <div class="flex gap-2 mt-2">
                  <button onclick={()=>copy(result.url)} class="flex-1 py-2 rounded-full bg-white text-zinc-900 font-bold text-[12px]">Copy</button>
                  <a href={result.url} target="_blank" class="flex-1 py-2 rounded-full bg-black/20 text-white font-bold text-[12px] text-center">Open</a>
                </div>
              </div>
            {/if}
            </div>
          </div>
        </div>
      </div>

      <!-- files -->
      <div class="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
        <div class="overflow-auto max-h-[420px]">
          <table class="w-full text-[13px]">
            <thead class="sticky top-0 bg-zinc-50 border-b">
              <tr class="text-[11px] tracking-wide text-zinc-500">
                <th class="text-left px-4 py-3">File</th>
                <th class="text-left px-4 py-3">Size</th>
                <th class="text-left px-4 py-3">Date</th>
                <th class="text-left px-4 py-3">Link</th>
              </tr>
            </thead>
            <tbody>
              {#each filtered as d (d.id)}
                <tr class="border-b border-zinc-100 hover:bg-zinc-50">
                  <td class="px-4 py-3">
                    <div class="flex gap-2 items-center"><span>{fileIcon(d.filename)}</span><span class="font-bold text-[12px] truncate max-w-[160px]">{d.filename}</span></div>
                    {#if d.title}<div class="text-[11px] text-zinc-500 truncate max-w-[160px]">{d.title}</div>{/if}
                  </td>
                  <td class="px-4 py-3 text-zinc-600">{fmtSize(d.size)}</td>
                  <td class="px-4 py-3 text-zinc-500 text-[12px]">{fmtDate(d.uploaded_at)}</td>
                  <td class="px-4 py-3">
                    <div class="flex gap-1 items-center flex-wrap">
                      <button onclick={()=>copy(location.origin+'/p/'+d.id)} class="font-mono text-[11px] font-bold text-indigo-600 border-b border-dashed">{location.host}/p/{d.id}</button>
                      <button onclick={()=>copy(location.origin+'/p/'+d.id)} class="px-2 py-1 border rounded-full text-[11px] font-bold bg-white">Copy</button>
                      <a href={location.origin+'/p/'+d.id} target="_blank" class="px-2.5 py-1 rounded-full bg-zinc-900 text-white text-[11px] font-bold">View</a>
                      <button onclick={()=>del(d.id)} class="px-2 py-1 rounded-full border text-[11px] font-bold">Del</button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="4" class="px-4 py-8 text-center text-zinc-500">No files yet.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if total>docs.length}
          <div class="p-3 border-t border-zinc-100 text-center">
            <button onclick={()=>load(false)} class="px-4 py-2 rounded-full border border-zinc-300 bg-white text-[12px] font-bold hover:bg-zinc-50">Load more ({docs.length} of {total})</button>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

