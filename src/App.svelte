<script>
  // ---- upload queue / progress ------------------------------------------------
  let queue = $state([])          // files waiting to be uploaded
  let uploading = $state(false)
  let pct = $state(-1)            // overall batch progress %, -1 = idle
  let results = $state([])        // links from the last completed batch
  let title = $state('')
  let category = $state('')
  let drag = $state(false)
  let fileInput
  let currentXhr = null           // for the Cancel button

  // ---- list state -------------------------------------------------------------
  let docs = $state([])
  let total = $state(0)          // true count of matching rows (server)
  let q = $state('')
  let cat = $state('')            // selected category filter
  let sortBy = $state('date')     // date | name | size
  let sortDir = $state('desc')
  let loading = $state(false)

  // ---- selection / rename / activity -----------------------------------------
  let selectMode = $state(false)
  let selected = $state([])       // ids
  let editingId = $state('')
  let editTitle = $state('')
  let activity = $state([])
  let notice = $state('')        // transient status line under the upload card

  // ---- auth / theme / clock --------------------------------------------------
  let needToken = $state(false)
  let openMode = $state(false)
  let tokenInput = $state('')
  let token = ''
  try{ token = localStorage.getItem('filo_token') || '' }catch{}
  function authHeaders(){ return token ? { 'x-upload-token': token } : {} }
  let now = $state(new Date())
  $effect(()=>{
    const t=setInterval(()=>now=new Date(),1000)
    return ()=>clearInterval(t)
  })

  let theme = $state('light')
  try{ theme = localStorage.getItem('filo_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') }catch{}
  $effect(()=>{ document.documentElement.classList.toggle('dark', theme==='dark'); try{ localStorage.setItem('filo_theme',theme) }catch{} })

  // ---- helpers ----------------------------------------------------------------
  function fmtSize(b){
    if(b<1024) return b+' B'
    if(b<1024*1024) return (b/1024).toFixed(1)+' KB'
    if(b<1024*1024*1024) return (b/1024/1024).toFixed(2)+' MB'
    return (b/1024/1024/1024).toFixed(2)+' GB'
  }
  function fmtRel(ts){
    const s=(Date.now()-ts)/1000
    if(s<60) return 'just now'
    if(s<3600) return Math.floor(s/60)+'m ago'
    if(s<86400) return Math.floor(s/3600)+'h ago'
    if(s<604800) return Math.floor(s/86400)+'d ago'
    return new Date(ts).toLocaleDateString()
  }
  function isSafeId(id){ return /^[A-Za-z0-9]{6,12}$/.test(id) }
  const IMG_EXT=['jpg','jpeg','png','webp','gif','bmp']
  function isImage(name){ return IMG_EXT.includes((name.split('.').pop()||'').toLowerCase()) }
  function fileIcon(name){
    const ext=(name.split('.').pop()||'').toLowerCase()
    if(IMG_EXT.includes(ext)||ext==='svg') return '🖼️'
    if(['mp4','mov','webm'].includes(ext)) return '🎬'
    if(['mp3','wav'].includes(ext)) return '🎵'
    if(ext==='pdf') return '📄'
    if(['doc','docx'].includes(ext)) return '📝'
    if(['xls','xlsx','csv'].includes(ext)) return '📊'
    if(['zip','rar','7z'].includes(ext)) return '🗜️'
    return '📄'
  }

  // ---- data loading -----------------------------------------------------------
  let storage = $state({ total:0, count:0, quota: 10*1024*1024*1024 })
  let cats = $derived([...new Set(docs.map(d=>d.category).filter(Boolean))])

  function listUrl(offset){
    const p=new URLSearchParams()
    if(q) p.set('q',q)
    if(cat) p.set('category',cat)
    p.set('sort',sortBy); p.set('dir',sortDir)
    if(offset) p.set('offset',String(offset))
    return '/api/list'+(p.toString()?'?'+p:'')
  }
  async function load(reset=true){
    loading=true
    try{
      const r=await fetch(listUrl(reset?0:docs.length),{headers:authHeaders()})
      if(r.status===401){
        needToken=true; token=''
        try{ localStorage.removeItem('filo_token') }catch{}
        notice='✕ Access token required'; setTimeout(()=>notice='',3000)
        return
      }
      needToken=false
      const j=await r.json()
      const page=(j.docs||[]).filter(d=>isSafeId(d.id))
      total=j.total||0
      if(reset){ docs=page }
      else{
        const seen=new Set(docs.map(d=>d.id))
        docs=[...docs, ...page.filter(d=>!seen.has(d.id))]
        if(total<docs.length) total=docs.length
      }
    }catch{ notice='Failed to load'; setTimeout(()=>notice='',3000) }
    finally{ loading=false }
    try{
      const r=await fetch('/api/storage',{headers:authHeaders()})
      const j=await r.json()
      if(j.total!=null) storage={ total:j.total, count:j.count||0, quota:j.quota||storage.quota }
    }catch{}
    try{
      const r=await fetch('/api/activity',{headers:authHeaders()})
      const j=await r.json()
      activity=j.actions||[]
    }catch{}
  }

  // server-side search: debounce the query box; also react to sort/category
  let searchTimer
  $effect(()=>{
    q; cat; sortBy; sortDir      // track these
    clearTimeout(searchTimer)
    searchTimer=setTimeout(()=>load(true), q?400:0)
    return ()=>clearTimeout(searchTimer)
  })
  $effect(()=>{
    fetch('/api/health').then(r=>r.json()).then(j=>{ openMode = j.auth===false }).catch(()=>{})
  })

  function saveToken(){
    token=tokenInput.trim()
    try{ token ? localStorage.setItem('filo_token',token) : localStorage.removeItem('filo_token') }catch{}
    tokenInput=''
    load(true)
  }

  // ---- upload -----------------------------------------------------------------
  function addFiles(list){
    const files=[...list].filter(f=>f && f.size>0)
    if(files.length) queue=[...queue, ...files]
  }
  function removeQueued(i){ queue=queue.filter((_,idx)=>idx!==i) }
  function uploadViaXHR(fd, onFilePct){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest()
      currentXhr=xhr
      xhr.open('POST','/api/upload')
      for(const [k,v] of Object.entries(authHeaders())) xhr.setRequestHeader(k,v)
      xhr.upload.onprogress=(e)=>{ if(e.lengthComputable) onFilePct(Math.round(e.loaded/e.total*100)) }
      xhr.onload=()=>{
        let j={}
        try{ j=JSON.parse(xhr.responseText) }catch{}
        if(xhr.status===401){ needToken=true; return reject(new Error('Access token required')) }
        if(xhr.status<200||xhr.status>=300) return reject(new Error(j.error||`Upload failed (HTTP ${xhr.status})`))
        resolve(j)
      }
      xhr.onerror=()=>reject(new Error('Network error during upload'))
      xhr.onabort=()=>reject(new Error('Cancelled'))
      xhr.send(fd)
    })
  }
  function cancelUpload(){ if(currentXhr){ currentXhr.abort(); currentXhr=null } }
  async function uploadAll(){
    if(!queue.length) return
    uploading=true; results=[]; pct=0
    const batch=[...queue]
    let ok=0, failed=0, firstErr=null
    for(let i=0;i<batch.length;i++){
      const fd=new FormData()
      fd.append('file', batch[i])
      if(title.trim()) fd.append('title', title.trim())
      if(category.trim()) fd.append('category', category.trim())
      try{
        const j=await uploadViaXHR(fd,(fp)=>{ pct=Math.round(((i+fp/100)/batch.length)*100) })
        results=[...results, { url: location.origin+'/p/'+j.id, filename:j.filename, size:j.size, etag:j.etag }]
        ok++
      }catch(e){
        if(e.message==='Cancelled') break
        if(e.message==='Access token required'){ firstErr=e.message; break } // stop the batch
        failed++
        if(!firstErr) firstErr=e.message
      }
    }
    uploading=false; pct=-1; currentXhr=null
    if(ok){ queue=[]; if(fileInput) fileInput.value=''; title='' }
    const summary=[ok?`✓ ${ok} uploaded`:'', failed?`✕ ${failed} failed`:'', firstErr?`✕ ${firstErr}`:''].filter(Boolean).join(' — ')
    notice=summary||'✓ Uploaded'; setTimeout(()=>notice='',4000)
    load(true)
  }
  async function copy(t){ try{ await navigator.clipboard.writeText(t) }catch{ prompt('Copy',t) } }

  // ---- delete / rename / bulk -------------------------------------------------
  async function del(id){
    if(!confirm('Delete '+id+'? This cannot be undone.')) return
    try{
      const r=await fetch('/api/delete/'+encodeURIComponent(id),{method:'DELETE', headers:authHeaders()})
      const j=await r.json().catch(()=>({}))
      if(r.status===401){ needToken=true; throw new Error('Access token required') }
      if(!r.ok) throw new Error(j.error||'Delete failed')
      load(true)
    }catch(e){ notice='✕ '+(e.message||'Delete failed'); setTimeout(()=>notice='',3000) }
  }
  async function delSelected(){
    if(!selected.length) return
    if(!confirm(`Delete ${selected.length} file${selected.length>1?'s':''}? This cannot be undone.`)) return
    const ids=[...selected]
    for(const id of ids){
      try{ await fetch('/api/delete/'+encodeURIComponent(id),{method:'DELETE', headers:authHeaders()}) }catch{}
    }
    selected=[]; selectMode=false
    load(true)
  }
  function toggleSel(id){
    selected=selected.includes(id) ? selected.filter(x=>x!==id) : [...selected,id]
  }
  function startRename(d){ editingId=d.id; editTitle=d.title||d.filename.replace(/\.[^.]*$/,'') }
  async function saveRename(id){
    try{
      const r=await fetch('/api/rename/'+encodeURIComponent(id),{
        method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()},
        body: JSON.stringify({ title: editTitle.trim() })
      })
      if(!r.ok) throw new Error()
      editingId=''; load(true)
    }catch{ notice='✕ Rename failed'; setTimeout(()=>notice='',3000) }
  }

  // ---- maintenance ------------------------------------------------------------
  async function reconcile(){
    notice='Running cleanup…'
    try{
      const r=await fetch('/api/reconcile',{method:'POST', headers:authHeaders()})
      const j=await r.json()
      const rep=j.report||{}
      notice=`Cleanup: ${rep.checked} checked, ${rep.droppedRows} rows dropped, ${rep.migrated} migrated, ${rep.errors} errors`
      load(true)
    }catch{ notice='✕ Cleanup failed'; setTimeout(()=>notice='',3000) }
    setTimeout(()=>notice='',6000)
  }

  // table sorting
  function setSort(col){
    if(sortBy===col) sortDir = sortDir==='asc' ? 'desc' : 'asc'
    else { sortBy=col; sortDir=col==='name'?'asc':'desc' }
  }
  function arrow(col){ return sortBy===col ? (sortDir==='asc'?'▲':'▼') : '' }
</script>

<svelte:document onpaste={(e)=>{ if(e.clipboardData?.files?.length){ addFiles(e.clipboardData.files); notice='Pasted — ready to upload'; setTimeout(()=>notice='',2000) } }} />

<div class="h-screen flex bg-[#fcfcfd] dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 overflow-hidden transition-colors">
  <!-- sidebar -->
  <aside class="hidden md:flex w-[180px] shrink-0 bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 flex-col">
    <div class="h-[56px] px-5 flex items-center border-b border-zinc-200 dark:border-zinc-800">
      <div class="font-bold text-[22px] tracking-tight leading-none">filo</div>
    </div>
    <nav class="p-3 flex-1 space-y-1 overflow-auto">
      <div class="text-[11px] font-bold tracking-widest text-zinc-400 px-2 py-2">MENU</div>
      <button onclick={()=>{cat=''}} class="w-full text-left px-3 py-2 rounded-xl text-[13px] font-bold flex items-center gap-2 {!cat?'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900':'hover:bg-zinc-100 dark:hover:bg-zinc-800'}">
        <span>▦</span> All files <span class="ml-auto text-[11px] opacity-60">{total}</span>
      </button>
      {#if cats.length}
        <div class="text-[11px] font-bold tracking-widest text-zinc-400 px-2 pt-3 pb-1">CATEGORIES</div>
        {#each cats as c (c)}
          <button onclick={()=>{cat = cat===c ? '' : c}} class="w-full text-left px-3 py-2 rounded-xl text-[13px] font-medium flex items-center gap-2 truncate {cat===c?'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900':'hover:bg-zinc-100 dark:hover:bg-zinc-800'}">
            <span>◷</span> <span class="truncate">{c}</span>
          </button>
        {/each}
      {/if}
    </nav>
    <div class="p-3 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
      <div class="p-3 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
        <div class="text-[11px] opacity-80">Used</div>
        <div class="text-[13px] font-bold">{fmtSize(storage.total)} / {fmtSize(storage.quota)}</div>
        <div class="mt-2 h-1.5 rounded-full bg-white/20 overflow-hidden"><div class="h-full bg-white rounded-full" style="width: {Math.min(100, storage.total/storage.quota*100)}%"></div></div>
      </div>
      <button onclick={reconcile} class="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold hover:bg-zinc-100 dark:hover:bg-zinc-800">Run cleanup</button>
    </div>
  </aside>

  <!-- main -->
  <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
    <!-- header -->
    <header class="h-[56px] shrink-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3 px-4 md:px-6">
      <div class="flex-1 max-w-[420px]">
        <input bind:value={q} placeholder="Search all files…" class="w-full px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus:outline-none text-[13px]" />
      </div>
      {#if needToken}
        <div class="ml-auto flex items-center gap-2">
          <input bind:value={tokenInput} placeholder="Access token" type="password" onkeydown={(e)=>{if(e.key==='Enter')saveToken()}} class="px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus:outline-none text-[13px] w-[180px]" />
          <button onclick={saveToken} class="px-4 py-2 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[12px] font-bold">Save</button>
        </div>
      {:else}
        <div class="ml-auto flex items-center gap-3">
          <div class="hidden lg:block text-[12px] text-zinc-600 dark:text-zinc-400">
            {now.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric', year:'numeric'})} — {now.toLocaleTimeString('en-US',{hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})}
          </div>
          <button onclick={()=>theme=theme==='dark'?'light':'dark'} title="Toggle theme" class="w-8 h-8 rounded-full border border-zinc-200 dark:border-zinc-700 grid place-items-center text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800">{theme==='dark'?'☀':'🌙'}</button>
        </div>
      {/if}
    </header>

    <!-- content -->
    <div class="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6 bg-[#fcfcfd] dark:bg-zinc-950">
      {#if openMode && !needToken}
        <div class="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-[12px]">
          <span class="shrink-0 mt-px">⚠</span>
          <div>Open mode — anyone who finds this URL can upload or delete files. Set an <code class="font-mono text-[11px] bg-amber-100 dark:bg-amber-900 px-1 rounded">UPLOAD_TOKEN</code> secret on the server to lock it down.</div>
        </div>
      {/if}

      <!-- upload -->
      <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[20px] overflow-hidden shadow-sm">
        <div class="p-5 md:p-6">
          <h1 class="text-[22px] font-bold tracking-tight leading-none">Upload once,<br><span class="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">link forever.</span></h1>
          <div class="mt-4 flex flex-col lg:flex-row gap-4">
            <!-- left — drop / paste / click -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <label
              ondragover={(e)=>{e.preventDefault(); drag=true}}
              ondragenter={(e)=>{e.preventDefault(); drag=true}}
              ondragleave={(e)=>{e.preventDefault(); drag=false}}
              ondrop={(e)=>{e.preventDefault(); drag=false; addFiles(e.dataTransfer.files)}}
              onclick={()=>fileInput?.click()}
              class="flex-1 border-2 border-dashed rounded-2xl p-4 min-h-[200px] flex flex-col justify-center items-center gap-2 text-center cursor-pointer transition {drag?'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40':'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 hover:bg-white dark:hover:bg-zinc-800 hover:border-zinc-900 dark:hover:border-zinc-400'}"
            >
              <div class="w-10 h-10 rounded-xl bg-white dark:bg-zinc-900 border shadow-sm grid place-items-center">⬆</div>
              <div class="text-[13px] font-bold">Drop files, click, or paste</div>
              <div class="text-[11px] text-zinc-500 dark:text-zinc-400">any type · up to 25MB each</div>
              <input bind:this={fileInput} type="file" multiple class="hidden" onchange={(e)=>{addFiles(e.target.files); e.target.value=''}} />
            </label>
            <!-- right — title/category + upload -->
            <div class="flex-1 min-h-[200px] flex flex-col justify-center gap-3">
              <input bind:value={title} placeholder="Title (optional)" class="w-full h-[42px] px-3 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 outline-none text-[13px] shrink-0" />
              <input bind:value={category} list="filo-cats" placeholder="Category (optional)" class="w-full h-[42px] px-3 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 outline-none text-[13px] shrink-0" />
              <datalist id="filo-cats">{#each cats as c}<option value={c}></option>{/each}</datalist>
              <div class="flex gap-2">
                <button onclick={uploadAll} disabled={!queue.length || uploading} class="flex-1 h-[44px] rounded-xl bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 text-white font-bold text-[13px] disabled:opacity-40 flex justify-center items-center gap-2 hover:bg-black dark:hover:bg-white shrink-0">
                  {#if uploading}
                    <span class="w-4 h-4 border-2 border-white/30 border-t-white dark:border-zinc-500/30 dark:border-t-zinc-900 rounded-full animate-spin"></span>
                    <span>{pct>=0?pct+'%':'Uploading…'}</span>
                  {:else}
                    Upload {queue.length>1?`(${queue.length})`:''}
                  {/if}
                </button>
                {#if uploading}
                  <button onclick={cancelUpload} class="px-4 h-[44px] rounded-xl border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 font-bold text-[12px] hover:bg-red-50 dark:hover:bg-red-950/40 shrink-0">Cancel</button>
                {/if}
              </div>
              {#if uploading && pct>=0}
                <div class="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"><div class="h-full bg-indigo-600 rounded-full transition-all" style="width:{pct}%"></div></div>
              {/if}
              {#if queue.length}
                <div class="space-y-1.5 max-h-[140px] overflow-auto">
                  {#each queue as f, i (i)}
                    <div class="flex items-center gap-2 text-[12px] p-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700">
                      <span>{fileIcon(f.name)}</span>
                      <span class="font-bold truncate flex-1">{f.name}</span>
                      <span class="px-2 py-0.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold">{fmtSize(f.size)}</span>
                      {#if !uploading}<button onclick={()=>removeQueued(i)} class="text-zinc-400 hover:text-red-500 font-bold px-1">✕</button>{/if}
                    </div>
                  {/each}
                </div>
              {/if}
              {#if notice}<div class="text-[12px] font-bold {notice.startsWith('✓')?'text-emerald-600 dark:text-emerald-400':'text-zinc-500 dark:text-zinc-400'}">{notice}</div>{/if}
              {#each results as r (r.url)}
                <div class="p-3 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
                  <div class="text-[11px] opacity-80">{r.filename}</div>
                  <a href={r.url} target="_blank" class="font-mono text-[12px] font-bold break-all underline decoration-white/30">{r.url}</a>
                  <div class="flex gap-2 mt-2">
                    <button onclick={()=>copy(r.url)} class="flex-1 py-1.5 rounded-full bg-white text-zinc-900 font-bold text-[11px]">Copy</button>
                    <a href={r.url} target="_blank" class="flex-1 py-1.5 rounded-full bg-black/20 text-white font-bold text-[11px] text-center">Open</a>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </div>
      </div>

      <!-- files -->
      <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <div class="text-[13px] font-bold">{cat||'All files'} <span class="text-zinc-400 font-normal">· {total}</span></div>
          <div class="ml-auto flex items-center gap-2">
            {#if selectMode && selected.length}
              <button onclick={delSelected} class="px-3 py-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold">Delete selected ({selected.length})</button>
            {/if}
            <button onclick={()=>{selectMode=!selectMode; selected=[]}} class="px-3 py-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold {selectMode?'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900':'hover:bg-zinc-100 dark:hover:bg-zinc-800'}">{selectMode?'Done':'Select'}</button>
          </div>
        </div>
        <div class="overflow-auto max-h-[420px]">
          <table class="w-full text-[13px]">
            <thead class="sticky top-0 bg-zinc-50 dark:bg-zinc-800/80 backdrop-blur border-b border-zinc-100 dark:border-zinc-800">
              <tr class="text-[11px] tracking-wide text-zinc-500 dark:text-zinc-400">
                {#if selectMode}<th class="w-8 px-2 py-3"></th>{/if}
                <th class="text-left px-4 py-3"><button onclick={()=>setSort('name')} class="font-bold tracking-wide uppercase text-[11px] hover:text-zinc-900 dark:hover:text-zinc-100">File {arrow('name')}</button></th>
                <th class="text-left px-4 py-3 hidden sm:table-cell"><button onclick={()=>setSort('size')} class="font-bold tracking-wide uppercase text-[11px] hover:text-zinc-900 dark:hover:text-zinc-100">Size {arrow('size')}</button></th>
                <th class="text-left px-4 py-3"><button onclick={()=>setSort('date')} class="font-bold tracking-wide uppercase text-[11px] hover:text-zinc-900 dark:hover:text-zinc-100">Date {arrow('date')}</button></th>
                <th class="text-left px-4 py-3">Link</th>
              </tr>
            </thead>
            <tbody>
              {#each docs as d (d.id)}
                <tr class="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  {#if selectMode}
                    <td class="px-2 py-3"><input type="checkbox" checked={selected.includes(d.id)} onchange={()=>toggleSel(d.id)} class="w-4 h-4 accent-zinc-900 dark:accent-zinc-100" /></td>
                  {/if}
                  <td class="px-4 py-3">
                    <div class="flex gap-2 items-center min-w-0">
                      {#if isImage(d.filename)}
                        <img src={'/p/'+d.id} alt="" loading="lazy" class="w-8 h-8 rounded-lg object-cover border border-zinc-200 dark:border-zinc-700 shrink-0" />
                      {:else}
                        <span>{fileIcon(d.filename)}</span>
                      {/if}
                      {#if editingId===d.id}
                        <input bind:value={editTitle} class="flex-1 min-w-0 px-2 py-1 border border-zinc-300 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-900 text-[12px] outline-none focus:border-zinc-900 dark:focus:border-zinc-100" onkeydown={(e)=>{if(e.key==='Enter')saveRename(d.id); if(e.key==='Escape')editingId=''}} />
                        <button onclick={()=>saveRename(d.id)} class="text-[11px] font-bold text-emerald-600 px-1">Save</button>
                        <button onclick={()=>editingId=''} class="text-[11px] font-bold text-zinc-400 px-1">✕</button>
                      {:else}
                        <span class="font-bold text-[12px] truncate max-w-[160px]" title={d.filename}>{d.filename}</span>
                        <button onclick={()=>startRename(d)} title="Rename" class="text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 text-[11px] px-0.5">✎</button>
                      {/if}
                    </div>
                    {#if d.title && editingId!==d.id}<div class="text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[160px]">{d.title}</div>{/if}
                    {#if d.category && editingId!==d.id}<span class="inline-block mt-0.5 px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] font-bold text-zinc-500 dark:text-zinc-400">{d.category}</span>{/if}
                  </td>
                  <td class="px-4 py-3 text-zinc-600 dark:text-zinc-400 hidden sm:table-cell">{fmtSize(d.size)}</td>
                  <td class="px-4 py-3 text-zinc-500 dark:text-zinc-400 text-[12px]" title={new Date(d.uploaded_at).toLocaleString()}>{fmtRel(d.uploaded_at)}</td>
                  <td class="px-4 py-3">
                    <div class="flex gap-1 items-center flex-wrap">
                      <button onclick={()=>copy(location.origin+'/p/'+d.id)} class="font-mono text-[11px] font-bold text-indigo-600 dark:text-indigo-400 border-b border-dashed">{location.host}/p/{d.id}</button>
                      <a href={location.origin+'/p/'+d.id} target="_blank" class="px-2.5 py-1 rounded-full bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 text-white text-[11px] font-bold">View</a>
                      <button onclick={()=>del(d.id)} class="px-2 py-1 rounded-full border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold hover:border-red-300 hover:text-red-600">Del</button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="5" class="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">{loading?'Loading…':(q||cat?'No matches.':'No files yet.')}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if total>docs.length}
          <div class="p-3 border-t border-zinc-100 dark:border-zinc-800 text-center">
            <button onclick={()=>load(false)} class="px-4 py-2 rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-[12px] font-bold hover:bg-zinc-50 dark:hover:bg-zinc-800">Load more ({docs.length} of {total})</button>
          </div>
        {/if}
      </div>

      <!-- activity -->
      {#if activity.length}
        <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
          <div class="text-[13px] font-bold mb-2">Recent activity</div>
          <div class="space-y-1 max-h-[200px] overflow-auto">
            {#each activity.slice(0,20) as a (a.id ?? a.ts)}
              <div class="flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-400">
                <span class="w-16 shrink-0 font-bold {a.action==='delete'?'text-red-500':a.action==='upload'?'text-emerald-600 dark:text-emerald-400':'text-zinc-400'}">{a.action}</span>
                <span class="truncate flex-1" title={a.detail||''}>{a.filename || a.doc_id || a.detail || '—'}</span>
                <span class="text-zinc-400 shrink-0" title={new Date(a.ts).toLocaleString()}>{fmtRel(a.ts)}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
