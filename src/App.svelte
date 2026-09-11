<script>
  import {
    Archive, CloudUpload, Copy, ExternalLink, File, FileText, Film,
    Image as ImageIcon, LayoutGrid, LoaderCircle, Lock, LogOut, Moon,
    Music, RotateCcw, Search, Sun, Trash2, X
  } from 'lucide-svelte'

  let picked = $state(null)
  let title = $state('')
  let progress = $state('')
  let result = $state(null)
  let docs = $state([])
  let q = $state('')
  let drag = $state(false)
  let fileInput
  let theme = $state('light')
  try{ theme = localStorage.getItem('filo_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') }catch{}
  $effect(()=>{ document.documentElement.classList.toggle('dark', theme === 'dark'); try{ localStorage.setItem('filo_theme', theme) }catch{} })
  let now = $state(new Date())
  $effect(()=>{
    const t=setInterval(()=>now=new Date(),1000)
    return ()=>clearInterval(t)
  })

  // Access token (UPLOAD_TOKEN) — persisted locally, sent as x-upload-token
  // on every API call. /p/ links stay public; only the dashboard needs it.
  let token = $state('')
  let tokenInput = $state('')
  let locked = $state(false)
  try{ token = localStorage.getItem('filo_token') || '' }catch{}
  function authHeaders(){ return token ? { 'x-upload-token': token } : {} }
  function saveToken(){
    token = tokenInput.trim()
    tokenInput = ''
    try{ token ? localStorage.setItem('filo_token', token) : localStorage.removeItem('filo_token') }catch{}
    locked = false
    load()
  }
  function clearToken(){
    token = ''
    try{ localStorage.removeItem('filo_token') }catch{}
    docs = []
  }

  // Email sign-in (magic link). No SMTP is wired up, so the login link is
  // returned in-band — clicking it sets the session cookie via redirect.
  let magicEmail = $state('')
  let magicLink = $state(null)
  let magicErr = $state('')
  let magicBusy = $state(false)
  async function requestMagicLink(){
    magicErr = ''; magicLink = null
    const email = magicEmail.trim()
    if(!email) return
    magicBusy = true
    try{
      const r = await fetch('/api/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const j = await r.json().catch(() => ({}))
      if(!r.ok) throw new Error(j.error || 'Request failed')
      magicLink = j.link
    }catch(e){ magicErr = e.message || 'Request failed' }
    finally{ magicBusy = false }
  }

  function fmtSize(b){
    if(b<1024) return b+' B'
    if(b<1024*1024) return (b/1024).toFixed(1)+' KB'
    return (b/1024/1024).toFixed(2)+' MB'
  }
  function fmtDate(ts){ return new Date(ts).toLocaleDateString() }
  function isSafeId(id){ return /^[A-Za-z0-9]{6,12}$/.test(id) }
  // File-type icon component (Lucide) — no emoji anywhere in the UI.
  function fileIcon(name){
    const ext=(name.split('.').pop()||'').toLowerCase()
    if(['jpg','jpeg','png','webp','gif','svg'].includes(ext)) return ImageIcon
    if(['mp4','mov','webm'].includes(ext)) return Film
    if(['mp3','wav'].includes(ext)) return Music
    if(ext==='pdf') return FileText
    if(['doc','docx','xls','xlsx','csv','ppt','pptx','txt'].includes(ext)) return FileText
    if(['zip','rar','7z','tar','gz'].includes(ext)) return Archive
    return File
  }
  let storage = $state({ total:0, filo:0, free:10*1024*1024*1024 })
  let filtered = $derived(docs.filter(d=>{
    if(!q) return true
    const hay=[d.filename,d.title,d.id].join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  }))

  let loading = $state(true)
  let loadError = $state('')
  async function load(){
    loading = true
    loadError = ''
    try{
      const r=await fetch('/api/list',{headers:authHeaders()})
      if(r.status===401){ locked=true; docs=[]; return }
      locked=false
      const j=await r.json()
      docs=(j.docs||[]).filter(d=>isSafeId(d.id))
    }catch(e){ loadError='Could not load files. Check your connection.' }
    finally{ loading=false }
    try{
      const r=await fetch('/api/storage',{headers:authHeaders()})
      if(r.status===401){ locked=true; return }
      const j=await r.json()
      if(j.total!=null) storage=j
    }catch{}
  }
  $effect(()=>{ load() })
  function onPick(f){ if(!f){ picked=null; return } picked=f }
  let resultTimer
  let freshId = $state(null)
  async function doUpload(){
    if(!picked) return
    progress='Uploading…'; result=null
    clearTimeout(resultTimer)
    const fd=new FormData()
    fd.append('file', picked)
    if(title.trim()) fd.append('title', title.trim())
    try{
      const r=await fetch('/api/upload',{method:'POST', body:fd, headers:authHeaders()})
      if(r.status===401){ locked=true; throw new Error('Locked — enter access token') }
      const j=await r.json()
      if(!r.ok) throw new Error(j.error||'Upload failed')
      result={ url: j.url || location.origin+'/p/'+j.id, filename:j.filename, size:j.size }
      freshId=j.id
      progress='✓ Uploaded'; picked=null; if(fileInput) fileInput.value=''; title=''
      load(); setTimeout(()=>progress='',2000)
      // result is transient — the link lives in the files table permanently
      clearTimeout(resultTimer)
      resultTimer = setTimeout(()=>{ result=null }, 10000)
    }catch(e){ progress='✕ '+(e.message||'Failed') }
  }
  // Toasts: transient confirmations (copy, delete, errors). The upload
  // progress line keeps its own status; toasts never fight it.
  let toasts = $state([])
  function toast(msg, kind = 'info'){
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    toasts = [...toasts, { id, msg, kind }]
    setTimeout(()=>{ toasts = toasts.filter((t) => t.id !== id) }, 3200)
  }
  // Delete confirmation modal state (replaces native confirm()).
  let pendingDelete = $state(null)
  // Permanent links carry the filename (/p/<id>/<filename>) so browser
  // tabs show the name instead of the bare nanoid. The serve route only
  // reads the first path segment, so old /p/<id> links keep working.
  function fileUrl(d){ return location.origin+'/p/'+d.id+'/'+encodeURIComponent(d.filename || d.id) }
  function fileHost(d){ return location.host+'/p/'+d.id+'/'+encodeURIComponent(d.filename || d.id) }
  async function copy(t){
    try{ await navigator.clipboard.writeText(t); toast('Link copied to clipboard') }
    catch{ toast('Copy failed — long-press the link to copy it', 'error') }
  }
  async function del(id){
    try{
      const r=await fetch('/api/delete/'+encodeURIComponent(id),{method:'DELETE', headers:authHeaders()})
      pendingDelete=null
      if(r.status===401){ locked=true; toast('Locked — enter access token', 'error'); return }
      if(!r.ok){ toast('Delete failed — try again', 'error'); return }
      if(freshId===id) freshId=null
      toast('File deleted')
      load()
    }catch{ pendingDelete=null; toast('Delete failed — check your connection', 'error') }
  }
</script>

<div class="h-screen flex bg-[#fcfcfd] dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 overflow-hidden transition-colors" style="height:100vh;height:100dvh">
  <!-- sidebar -->
  <aside class="hidden md:flex w-[220px] shrink-0 bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 flex-col">
    <div class="h-[56px] px-5 flex items-center gap-2.5 border-b border-zinc-200 dark:border-zinc-800">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="#4f46e5" viewBox="0 0 16 16" class="shrink-0" aria-hidden="true"><path d="m.5 3 .04.87a2 2 0 0 0-.342 1.311l.637 7A2 2 0 0 0 2.826 14H9v-1H2.826a1 1 0 0 1-.995-.91l-.637-7A1 1 0 0 1 2.19 4h11.62a1 1 0 0 1 .996 1.09L14.54 8h1.005l.256-2.819A2 2 0 0 0 13.81 3H9.828a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 6.172 1H2.5a2 2 0 0 0-2 2m5.672-1a1 1 0 0 1 .707.293L7.586 3H2.19q-.362.002-.683.12L1.5 2.98a1 1 0 0 1 1-.98z"/><path d="M15.854 10.146a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.707 0l-1.5-1.5a.5.5 0 0 1 .707-.708l1.146 1.147 2.646-2.647a.5.5 0 0 1 .708 0"/></svg>
      <div class="font-bold text-[19px] tracking-tight leading-none">filo</div>
    </div>
    <nav class="p-3 flex-1 space-y-1">
      <div class="text-[11px] font-bold tracking-widest text-zinc-500 px-2 py-2">MENU</div>
      <button onclick={()=>q=''} aria-current="true" class="w-full text-left px-3 py-2 rounded-xl text-[13px] font-bold flex items-center gap-2 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"><LayoutGrid size={15} aria-hidden="true" /> All files <span class="ml-auto text-[11px] tabular-nums opacity-60">{docs.length}</span></button>
    </nav>
    <div class="p-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0">
      <div class="shrink-0 p-3 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 overflow-hidden">
        <div class="text-[11px] leading-none opacity-60 font-semibold">Storage</div>
        <div class="mt-1 text-[13px] font-bold tabular-nums whitespace-nowrap overflow-hidden text-ellipsis">{(storage.total/1024/1024).toFixed(1)} <span class="font-medium opacity-60">/ 10GB</span></div>
        <div class="mt-2 h-1 shrink-0 rounded-full bg-white/15 dark:bg-zinc-900/10 overflow-hidden" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(Math.min(100, storage.total/1024/1024/10240*100))}><div class="h-full bg-indigo-500 rounded-full transition-all duration-500" style="width: {Math.min(100, storage.total/1024/1024/10240*100)}%"></div></div>
      </div>
    </div>
  </aside>

  <!-- main -->
  <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
    <!-- header -->
    <header class="h-[56px] shrink-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3 px-4 md:px-6">
      <div class="md:hidden font-bold text-[18px] tracking-tight leading-none shrink-0">filo</div>
      <div class="flex-1 max-w-[420px]">
        <input bind:value={q} placeholder="Search…" aria-label="Search files" class="w-full px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-600 text-[13px]" />
      </div>
      {#if !token}
        <div class="ml-auto flex items-center gap-2">
          <input bind:value={tokenInput} placeholder="Access token" aria-label="Access token" type="password" autocomplete="off" onkeydown={(e)=>{if(e.key==='Enter')saveToken()}} class="px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-600 text-[13px] w-[160px]" />
          <button onclick={saveToken} class="px-4 py-2 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[12px] font-bold shrink-0">Unlock</button>
        </div>
      {:else}
        <div class="ml-auto hidden sm:block text-[12px] text-zinc-600 dark:text-zinc-400">
          {now.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric', year:'numeric'})} — {now.toLocaleTimeString('en-US',{hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})}
        </div>
        <button onclick={clearToken} title="Forget access token (lock)" aria-label="Lock — forget access token" class="flex items-center gap-1 text-[11px] font-bold text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 shrink-0 transition-colors"><LogOut size={12} />Lock</button>
      {/if}
      <button onclick={()=>theme=theme==='dark'?'light':'dark'} title="Toggle theme" aria-label="Toggle dark mode" class="w-8 h-8 shrink-0 rounded-full border border-zinc-200 dark:border-zinc-700 grid place-items-center text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">{#if theme==='dark'}<Sun size={14} />{:else}<Moon size={14} />{/if}</button>
    </header>

    <!-- content -->
    <div class="flex-1 min-h-0 overflow-auto px-4 pt-4 pb-2 md:px-6 md:pt-6 md:pb-3 bg-[#fcfcfd] dark:bg-zinc-950 flex flex-col gap-4 md:gap-5">
      <!-- upload : compact, files panel gets the room -->
      <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-panel overflow-hidden shadow-sm shrink-0">
        <div class="px-5 py-4 md:px-6">
          <div class="relative text-center">
            <h1 class="text-[19px] font-bold tracking-[-0.02em] leading-tight">Upload once, <span class="bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-transparent">link forever.</span></h1>
            {#if result}
              <a href={result.url} target="_blank" title="{result.filename} — open" class="absolute right-0 top-1/2 -translate-y-1/2 max-w-[130px] truncate text-[11px] font-bold text-emerald-600 dark:text-emerald-400 hover:underline">✓ Uploaded</a>
            {/if}
          </div>
            <label
              ondragover={(e)=>{e.preventDefault(); drag=true}}
              ondragenter={(e)=>{e.preventDefault(); drag=true}}
              ondragleave={(e)=>{e.preventDefault(); drag=false}}
              ondrop={(e)=>{e.preventDefault(); drag=false; const f=e.dataTransfer.files[0]; if(f) onPick(f)}}
              onclick={()=>fileInput?.click()}
              onkeydown={(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault(); fileInput?.click()}}}
              tabindex="0" role="button" aria-label="Upload a file: drop, press Enter, or click to browse"
              class="mt-3 border-2 border-dashed rounded-2xl h-28 shrink-0 flex flex-col justify-center items-center gap-1.5 px-6 text-center cursor-pointer transition-all duration-150 focus-visible:outline-2 focus-visible:outline-indigo-600 focus-visible:outline-offset-2 {drag?'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 scale-[1.01] shadow-lg shadow-indigo-600/10':'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 hover:bg-white dark:hover:bg-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-500'}"
            >
              <div class="w-9 h-9 shrink-0 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-sm grid place-items-center text-zinc-400 dark:text-zinc-500 transition-transform duration-150 {drag?'scale-110 -translate-y-0.5':''}" aria-hidden="true"><CloudUpload size={18} /></div>
            <div class="min-w-0 max-w-full">
              {#if picked}
                <div class="flex items-center justify-center gap-2 min-w-0">
                  <span class="text-[13px] font-bold truncate">{picked.name}</span>
                  <button onclick={(e)=>{e.stopPropagation(); onPick(null)}} aria-label="Remove selected file" class="w-5 h-5 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 grid place-items-center text-[10px] font-bold hover:bg-zinc-300 dark:hover:bg-zinc-600">✕</button>
                </div>
                <div class="mt-0.5 text-[12px] text-zinc-500 dark:text-zinc-400 tabular-nums">{fmtSize(picked.size)} · click or drop to replace</div>
              {:else}
                <div class="text-[13px] font-bold">Drop a file here, or click to browse</div>
                <div class="mt-0.5 text-[12px] text-zinc-500 dark:text-zinc-400">any type · up to 25MB</div>
              {/if}
            </div>
            <input bind:this={fileInput} type="file" aria-label="Choose a file to upload" class="hidden" onchange={(e)=>onPick(e.target.files[0])} />
          </label>
          <div class="mt-3 flex gap-2 items-center">
            <button onclick={doUpload} disabled={!picked} class="flex-1 min-w-0 h-11 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-bold text-[13px] disabled:opacity-40 disabled:saturate-0 flex justify-center items-center gap-2 shadow-md shadow-indigo-600/20 hover:brightness-110 active:scale-[.99] transition">
              {#if progress==='Uploading…'}<LoaderCircle size={16} class="animate-spin" />{:else}<CloudUpload size={15} />{/if}
              Upload
            </button>
            <input bind:value={title} placeholder="Title (optional)" aria-label="Title (optional)" class="flex-1 min-w-0 h-11 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-600 text-[13px] text-center" />
          </div>
          <div class="mt-2 min-h-[22px] text-center text-[12px] font-bold {progress.startsWith('✓')?'text-emerald-600 dark:text-emerald-400':'text-zinc-500 dark:text-zinc-400'}" role="status" aria-live="polite">{#if progress && progress!=='Uploading…'}{progress}{/if}</div>
        </div>
      </div>

      <!-- files : fills to the bottom edge, scrolls internally -->
      <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-panel overflow-hidden flex-1 min-h-0 flex flex-col">
        <div class="overflow-auto flex-1 min-h-0">
          <table class="w-full text-[13px]">
            <thead class="sticky top-0 bg-zinc-50 dark:bg-zinc-800/80 backdrop-blur border-b border-zinc-100 dark:border-zinc-800">
              <tr class="text-[11px] tracking-wide text-zinc-500 dark:text-zinc-400">
                <th scope="col" class="text-left px-4 py-3">File</th>
                <th scope="col" class="text-left px-4 py-3 hidden sm:table-cell">Size</th>
                <th scope="col" class="text-left px-4 py-3 hidden sm:table-cell">Date</th>
                <th scope="col" class="text-left px-4 py-3">Link</th>
              </tr>
            </thead>
            <tbody>
              {#if locked}
                <tr><td colspan="4" class="px-4 py-10 text-center">
                  <div class="mx-auto w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-zinc-400 dark:text-zinc-500" aria-hidden="true"><Lock size={18} /></div>
                  <div class="mt-2 text-[13px] font-bold">Locked</div>
                  <div class="text-[12px] text-zinc-500 dark:text-zinc-400">Enter your access token above, or sign in by email.</div>
                  {#if !magicLink}
                    <div class="mt-3 mx-auto flex gap-2 max-w-[320px]">
                      <input bind:value={magicEmail} placeholder="you@example.com" aria-label="Email address" type="email" autocomplete="email" onkeydown={(e)=>{if(e.key==='Enter')requestMagicLink()}} class="flex-1 min-w-0 px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-600 text-[12px] text-left" />
                      <button onclick={requestMagicLink} disabled={magicBusy} class="px-4 py-2 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[12px] font-bold shrink-0 disabled:opacity-50">{magicBusy ? '…' : 'Email link'}</button>
                    </div>
                    {#if magicErr}<div class="mt-1.5 text-[12px] font-bold text-red-600 dark:text-red-400">{magicErr}</div>{/if}
                  {:else}
                    <a href={magicLink} class="mt-3 inline-block px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold">Open magic link →</a>
                    <div class="mt-1 text-[11px] text-zinc-400">Valid 24h, single use. Check your inbox when SMTP is wired up.</div>
                  {/if}
                </td></tr>
              {:else if loading && !docs.length}
                {#each [0,1,2] as i (i)}
                  <tr class="border-b border-zinc-100 dark:border-zinc-800" aria-hidden="true">
                    <td class="px-4 py-3"><div class="h-3 w-32 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"></div><div class="mt-1.5 h-2.5 w-20 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"></div></td>
                    <td class="px-4 py-3 hidden sm:table-cell"><div class="h-3 w-12 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"></div></td>
                    <td class="px-4 py-3 hidden sm:table-cell"><div class="h-3 w-16 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"></div></td>
                    <td class="px-4 py-3"><div class="h-3 w-24 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"></div></td>
                  </tr>
                {/each}
              {:else if loadError && !docs.length}
                <tr><td colspan="4" class="px-4 py-8 text-center">
                  <div class="text-[13px] font-bold text-zinc-700 dark:text-zinc-300">{loadError}</div>
                  <button onclick={()=>load()} class="mt-2 px-4 py-2 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[12px] font-bold">Retry</button>
                </td></tr>
              {:else}
                {#each filtered as d (d.id)}
                  {@const FileTypeIcon = fileIcon(d.filename)}
                  <tr class="border-b border-zinc-100 dark:border-zinc-800 transition-colors {d.id===freshId?'bg-emerald-50/70 dark:bg-emerald-950/30 hover:bg-emerald-100/70 dark:hover:bg-emerald-950/50':'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}">
                    <td class="px-4 py-[14px]">
                      <div class="flex gap-2.5 items-center">
                        <span class="w-8 h-8 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-700/60 grid place-items-center text-zinc-500 dark:text-zinc-400"><FileTypeIcon size={15} aria-hidden="true" /></span>
                        <span class="min-w-0">
                          <span class="block font-semibold text-[13px] truncate max-w-[160px]">{d.filename}</span>
                          {#if d.title}<span class="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[160px]">{d.title}</span>{/if}
                        </span>
                      </div>
                    </td>
                    <td class="px-4 py-[14px] text-zinc-600 dark:text-zinc-400 tabular-nums hidden sm:table-cell">{fmtSize(d.size)}</td>
                    <td class="px-4 py-[14px] text-zinc-500 dark:text-zinc-400 text-[12px] hidden sm:table-cell">{fmtDate(d.uploaded_at)}</td>
                    <td class="px-4 py-[14px]">
                      <div class="flex gap-1.5 items-center flex-wrap">
                        <button onclick={()=>copy(fileUrl(d))} class="font-mono text-[11px] font-bold text-indigo-600 dark:text-indigo-400 border-b border-dashed border-indigo-300 dark:border-indigo-800 hover:border-indigo-600 dark:hover:border-indigo-400 transition-colors">{fileHost(d)}</button>
                        <button onclick={()=>copy(fileUrl(d))} class="px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-full text-[11px] font-bold bg-white dark:bg-transparent min-h-[32px] inline-flex items-center gap-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 active:scale-[.97] transition"><Copy size={12} />Copy</button>
                        <a href={fileUrl(d)} target="_blank" class="px-3 py-1.5 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[11px] font-bold min-h-[32px] inline-flex items-center gap-1 hover:bg-black dark:hover:bg-white active:scale-[.97] transition">View<ExternalLink size={12} /></a>
                        <button onclick={()=>pendingDelete=d} aria-label="Delete {d.filename}" class="px-2.5 py-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold min-h-[32px] inline-flex items-center gap-1 hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400 active:scale-[.97] transition"><Trash2 size={12} />Del</button>
                      </div>
                    </td>
                  </tr>
                {:else}
                  <tr><td colspan="4" class="px-4 py-10 text-center">
                    {#if q}
                      <div class="mx-auto w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-zinc-400 dark:text-zinc-500" aria-hidden="true"><Search size={18} /></div>
                      <div class="mt-2 text-[13px] font-bold">No matches for “{q}”.</div>
                      <button onclick={()=>q=''} class="mt-2 px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 text-[12px] font-bold inline-flex items-center gap-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"><RotateCcw size={12} />Clear search</button>
                    {:else}
                      <div class="mx-auto w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-zinc-400 dark:text-zinc-500" aria-hidden="true"><CloudUpload size={18} /></div>
                      <div class="mt-2 text-[13px] font-bold">No files yet.</div>
                      <div class="text-[12px] text-zinc-500 dark:text-zinc-400">Upload one above — its link lives here.</div>
                    {/if}
                  </td></tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- delete confirmation -->
  {#if pendingDelete}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-zinc-950/45 p-4 backdrop-blur-[2px]"
      onclick={(e)=>{if(e.target===e.currentTarget) pendingDelete=null}}
      onkeydown={(e)=>{if(e.key==='Escape') pendingDelete=null}}
    >
      <div class="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-2xl p-5 animate-rise" role="dialog" aria-modal="true" aria-label="Delete file">
        <div class="flex items-center gap-3">
          <span class="w-9 h-9 shrink-0 rounded-xl bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 grid place-items-center"><Trash2 size={16} /></span>
          <h2 class="font-bold text-[15px] tracking-tight">Delete this file?</h2>
        </div>
        <p class="mt-2 text-[13px] text-zinc-500 dark:text-zinc-400 break-all">{pendingDelete.filename} — the permanent link stops working. This can't be undone.</p>
        <div class="mt-4 flex gap-2 justify-end">
          <button onclick={()=>pendingDelete=null} autofocus class="px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 text-[13px] font-bold hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Cancel</button>
          <button onclick={()=>del(pendingDelete.id)} class="px-4 py-2 rounded-full bg-red-600 hover:bg-red-700 active:scale-[.98] transition text-white text-[13px] font-bold">Delete</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- toasts -->
  <div class="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none" aria-live="polite">
    {#each toasts as t (t.id)}
      <div class="pointer-events-auto flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-xl text-[13px] font-bold shadow-lg border animate-rise {t.kind==='error'?'bg-red-600 border-red-600 text-white':'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-transparent'}">
        {#if t.kind==='error'}<X size={14} />{:else}<Check size={14} />{/if}
        {t.msg}
      </div>
    {/each}
  </div>
</div>
