<script>
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

  function fmtSize(b){
    if(b<1024) return b+' B'
    if(b<1024*1024) return (b/1024).toFixed(1)+' KB'
    return (b/1024/1024).toFixed(2)+' MB'
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
  async function doUpload(){
    if(!picked) return
    progress='Uploading…'; result=null
    const fd=new FormData()
    fd.append('file', picked)
    if(title.trim()) fd.append('title', title.trim())
    try{
      const r=await fetch('/api/upload',{method:'POST', body:fd, headers:authHeaders()})
      if(r.status===401){ locked=true; throw new Error('Locked — enter access token') }
      const j=await r.json()
      if(!r.ok) throw new Error(j.error||'Upload failed')
      result={ url: location.origin+'/p/'+j.id, filename:j.filename, size:j.size }
      progress='✓ Uploaded'; picked=null; if(fileInput) fileInput.value=''; title=''
      load(); setTimeout(()=>progress='',2000)
    }catch(e){ progress='✕ '+(e.message||'Failed') }
  }
  let flashTimer
  function flash(msg){
    if(progress === 'Uploading…') return
    progress = msg
    clearTimeout(flashTimer)
    flashTimer = setTimeout(()=>{ if(progress === msg) progress = '' }, 1500)
  }
  async function copy(t){
    try{ await navigator.clipboard.writeText(t); flash('Copied ✓') }catch{ prompt('Copy',t) }
  }
  async function del(id){
    if(!confirm('Delete '+id+'?')) return
    const r=await fetch('/api/delete/'+encodeURIComponent(id),{method:'DELETE', headers:authHeaders()})
    if(r.status===401){ locked=true; progress='Locked — enter access token'; return }
    load()
  }
</script>

<div class="h-screen flex bg-[#fcfcfd] dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 overflow-hidden transition-colors" style="height:100vh;height:100dvh">
  <!-- sidebar -->
  <aside class="hidden md:flex w-[220px] shrink-0 bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 flex-col">
    <div class="h-[56px] px-5 flex items-center gap-2.5 border-b border-zinc-200 dark:border-zinc-800">
      <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 text-white grid place-items-center font-bold text-[13px] shadow-sm" aria-hidden="true">f</div>
      <div class="font-bold text-[19px] tracking-tight leading-none">filo</div>
    </div>
    <nav class="p-3 flex-1 space-y-1">
      <div class="text-[11px] font-bold tracking-widest text-zinc-500 px-2 py-2">MENU</div>
      <button onclick={()=>q=''} aria-current="true" class="w-full text-left px-3 py-2 rounded-xl text-[13px] font-bold flex items-center gap-2 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"><span aria-hidden="true">▦</span> All files <span class="ml-auto text-[11px] opacity-60">{docs.length}</span></button>
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
        <button onclick={clearToken} title="Forget access token" class="text-[11px] font-bold text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 shrink-0">Lock</button>
      {/if}
      <button onclick={()=>theme=theme==='dark'?'light':'dark'} title="Toggle theme" aria-label="Toggle dark mode" class="w-8 h-8 shrink-0 rounded-full border border-zinc-200 dark:border-zinc-700 grid place-items-center text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800">{theme==='dark'?'☀':'🌙'}</button>
    </header>

    <!-- content -->
    <div class="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6 bg-[#fcfcfd] dark:bg-zinc-950">
      <!-- upload : compact, files panel gets the room -->
      <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-panel overflow-hidden shadow-sm shrink-0">
        <div class="px-5 py-4 md:px-6">
          <div class="text-center">
            <h1 class="text-[19px] font-bold tracking-[-0.02em] leading-tight">Upload once, <span class="text-zinc-500 dark:text-zinc-400 font-semibold">link forever.</span></h1>
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
              <div class="w-9 h-9 shrink-0 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-sm grid place-items-center text-base transition-transform duration-150 {drag?'scale-110 -translate-y-0.5':''}" aria-hidden="true">⬆</div>
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
              {#if progress==='Uploading…'}<span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>{/if}
              Upload
            </button>
            <input bind:value={title} placeholder="Title (optional)" aria-label="Title (optional)" class="flex-1 min-w-0 h-11 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-900 dark:focus:border-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-600 text-[13px] text-center" />
          </div>
          <div class="mt-2 min-h-[22px] text-center text-[12px] font-bold {progress.startsWith('✓')?'text-emerald-600 dark:text-emerald-400':'text-zinc-500 dark:text-zinc-400'}" role="status" aria-live="polite">{#if progress && progress!=='Uploading…'}{progress}{/if}</div>
          {#if result}
            <div class="mt-1 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-center animate-rise" role="status">
              <div class="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">✓ Permanent link ready — {result.filename}</div>
              <a href={result.url} target="_blank" class="font-mono text-[13px] font-bold break-all text-emerald-800 dark:text-emerald-200 underline decoration-emerald-300 dark:decoration-emerald-800">{result.url}</a>
              <div class="flex gap-2 mt-2">
                <button onclick={()=>copy(result.url)} class="flex-1 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 active:scale-[.99] transition text-white font-bold text-[12px]">Copy link</button>
                <a href={result.url} target="_blank" class="py-2 px-4 rounded-full text-emerald-700 dark:text-emerald-300 font-bold text-[12px] hover:underline">Open ↗</a>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- files : gets the room — tall viewport-relative list -->
      <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-panel overflow-hidden flex-1 min-h-[280px] flex flex-col">
        <div class="overflow-auto max-h-[62vh] flex-1">
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
              {#if loading && !docs.length}
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
                  <tr class="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td class="px-4 py-[14px]">
                      <div class="flex gap-2.5 items-center">
                        <span aria-hidden="true" class="w-8 h-8 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-700/60 grid place-items-center text-[15px]">{fileIcon(d.filename)}</span>
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
                        <button onclick={()=>copy(location.origin+'/p/'+d.id)} class="font-mono text-[11px] font-bold text-indigo-600 dark:text-indigo-400 border-b border-dashed border-indigo-300 dark:border-indigo-800 hover:border-indigo-600 dark:hover:border-indigo-400 transition-colors">{location.host}/p/{d.id}</button>
                        <button onclick={()=>copy(location.origin+'/p/'+d.id)} class="px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-full text-[11px] font-bold bg-white dark:bg-transparent min-h-[32px] hover:bg-zinc-100 dark:hover:bg-zinc-800 active:scale-[.97] transition">Copy</button>
                        <a href={location.origin+'/p/'+d.id} target="_blank" class="px-3 py-1.5 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[11px] font-bold min-h-[32px] inline-flex items-center hover:bg-black dark:hover:bg-white active:scale-[.97] transition">View</a>
                        <button onclick={()=>del(d.id)} aria-label="Delete {d.filename}" class="px-2.5 py-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold min-h-[32px] hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400 active:scale-[.97] transition">Del</button>
                      </div>
                    </td>
                  </tr>
                {:else}
                  <tr><td colspan="4" class="px-4 py-10 text-center">
                    {#if locked}
                      <div class="mx-auto w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-lg" aria-hidden="true">🔒</div>
                      <div class="mt-2 text-[13px] font-bold">Locked</div>
                      <div class="text-[12px] text-zinc-500 dark:text-zinc-400">Enter your access token above.</div>
                    {:else if q}
                      <div class="mx-auto w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-lg" aria-hidden="true">⌕</div>
                      <div class="mt-2 text-[13px] font-bold">No matches for “{q}”.</div>
                      <button onclick={()=>q=''} class="mt-2 px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 text-[12px] font-bold">Clear search</button>
                    {:else}
                      <div class="mx-auto w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 grid place-items-center text-lg" aria-hidden="true">⬆</div>
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
</div>
