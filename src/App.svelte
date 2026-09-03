<script>
  let picked = $state(null)
  let title = $state('')
  let progress = $state('')
  let result = $state(null)
  let docs = $state([])
  let q = $state('')
  let drag = $state(false)
  let fileInput
  let now = $state(new Date())
  $effect(()=>{
    const t=setInterval(()=>now=new Date(),1000)
    return ()=>clearInterval(t)
  })

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
  function fileColor(ext){
    ext=(ext||'').toLowerCase()
    if(['jpg','jpeg','png','gif','svg','webp'].includes(ext)) return 'from-violet-500 to-indigo-500'
    if(['pdf'].includes(ext)) return 'from-rose-500 to-orange-500'
    if(['doc','docx'].includes(ext)) return 'from-blue-500 to-cyan-500'
    if(['xls','xlsx','csv'].includes(ext)) return 'from-emerald-500 to-teal-500'
    if(['zip','rar','7z'].includes(ext)) return 'from-amber-500 to-yellow-500'
    if(['mp4','mov'].includes(ext)) return 'from-pink-500 to-rose-500'
    return 'from-zinc-700 to-zinc-900'
  }

  let storage = $state({ total:0, filo:0, free:10*1024*1024*1024 })
  let filtered = $derived(docs.filter(d=>{
    if(!q) return true
    const hay=[d.filename,d.title,d.id].join(' ').toLowerCase()
    return hay.includes(q.toLowerCase())
  }))

  async function load(){
    try{
      const r=await fetch('/api/list')
      const j=await r.json()
      docs=(j.docs||[]).filter(d=>isSafeId(d.id))
    }catch(e){ progress='Failed to load' }
    try{
      const r=await fetch('/api/storage')
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
      const r=await fetch('/api/upload',{method:'POST', body:fd})
      const j=await r.json()
      if(!r.ok) throw new Error(j.error||'Upload failed')
      result={ url: location.origin+'/p/'+j.id, filename:j.filename, size:j.size }
      progress='✓ Uploaded'; picked=null; if(fileInput) fileInput.value=''; title=''
      load(); setTimeout(()=>progress='',2000)
    }catch(e){ progress='✕ '+(e.message||'Failed') }
  }
  async function copy(t){ try{ await navigator.clipboard.writeText(t) }catch{ prompt('Copy',t) } }
  async function del(id){ if(!confirm('Delete '+id+'?')) return; await fetch('/api/delete/'+encodeURIComponent(id),{method:'DELETE'}); load() }
</script>

<div class="h-screen flex bg-[#fcfcfd] text-zinc-900 overflow-hidden">
  <!-- sidebar -->
  <aside class="hidden md:flex w-[160px] shrink-0 bg-white border-r border-zinc-200 flex-col">
    <div class="h-[56px] px-5 flex items-center border-b border-zinc-200">
      <div class="font-bold text-[22px] tracking-tight leading-none">filo</div>
    </div>
    <nav class="p-3 flex-1 space-y-1">
      <div class="text-[11px] font-bold tracking-widest text-zinc-400 px-2 py-2">MENU</div>
      <button onclick={()=>q=''} class="w-full text-left px-3 py-2 rounded-xl text-[13px] font-bold flex items-center gap-2 bg-zinc-900 text-white"><span>▦</span> All files <span class="ml-auto text-[11px] opacity-60">{docs.length}</span></button>
    </nav>
    <div class="p-3 border-t border-zinc-100">
      <div class="p-3 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
        <div class="text-[11px] opacity-80">Used</div>
        <div class="text-[13px] font-bold">{(storage.total/1024/1024).toFixed(1)} MB / 10GB</div>
        <div class="mt-2 h-1.5 rounded-full bg-white/20 overflow-hidden"><div class="h-full bg-white rounded-full" style="width: {Math.min(100, storage.total/1024/1024/10240*100)}%"></div></div>
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
      <div class="ml-auto hidden sm:block text-[12px] text-zinc-600">
        {now.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric', year:'numeric'})} — {now.toLocaleTimeString('en-US',{hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})}
      </div>
    </header>

    <!-- content -->
    <div class="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6 bg-[#fcfcfd]">
      <!-- upload -->
      <div class="bg-white border border-zinc-200 rounded-[20px] overflow-hidden shadow-sm">
        <div class="p-5 md:p-6 grid grid-cols-1 lg:grid-cols-[1.1fr_.9fr] gap-6 items-center">
          <div>
            <h1 class="text-[22px] font-bold tracking-tight leading-none">Upload once,<br><span class="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">link forever.</span></h1>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <label
              ondragover={(e)=>{e.preventDefault(); drag=true}}
              ondragenter={(e)=>{e.preventDefault(); drag=true}}
              ondragleave={(e)=>{e.preventDefault(); drag=false}}
              ondrop={(e)=>{e.preventDefault(); drag=false; const f=e.dataTransfer.files[0]; if(f) onPick(f)}}
              onclick={()=>fileInput?.click()}
              class="mt-4 border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition flex flex-col items-center gap-2 {drag?'border-indigo-500 bg-indigo-50':'border-zinc-200 bg-zinc-50 hover:bg-white hover:border-zinc-900'}"
            >
              <div class="w-10 h-10 rounded-xl bg-white border shadow-sm grid place-items-center">⬆</div>
              <div class="text-[13px] font-bold">Drop file or click</div>
              <input bind:this={fileInput} type="file" class="hidden" onchange={(e)=>onPick(e.target.files[0])} />
            </label>
          </div>
          <div class="space-y-3">
              <input bind:value={title} placeholder="Title" class="w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-zinc-50 focus:bg-white focus:border-zinc-900 outline-none text-[13px]" />
            <button onclick={doUpload} disabled={!picked} class="w-full py-3 rounded-xl bg-zinc-900 text-white font-bold text-[13px] disabled:opacity-40 flex justify-center items-center gap-2 hover:bg-black">
              {#if progress==='Uploading…'}<span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>{/if}
              {picked ? `Upload ${picked.name.slice(0,18)}` : 'Upload'}
            </button>
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
      </div>
    </div>
  </div>
</div>
