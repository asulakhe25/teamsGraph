const { useState, useEffect, useRef, useCallback, useMemo } = React;

const PROXY  = "https://teamsgraph.onrender.com";
const ORG    = "Sogolytics";
const PAGE_SIZE = 20;

// ── Microsoft Auth (MSAL) Config ──
const MSAL_CLIENT_ID = "08412c34-dfc4-422f-8920-2e597fed36f0";
const MSAL_TENANT_ID = "26d9ea9b-950a-4f75-a918-c502ccdaea32";
let msalInstance = null;
try {
  if (window.msal && window.msal.PublicClientApplication) {
    msalInstance = new msal.PublicClientApplication({
      auth: {
        clientId: MSAL_CLIENT_ID,
        authority: "https://login.microsoftonline.com/common",
        redirectUri: window.location.origin + window.location.pathname,
      },
      cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false },
    });
  }
} catch(e) { console.warn("MSAL init failed:", e); }

const AC = [{bg:"#f3f0ff",c:"#6d28d9"},{bg:"#ecfdf5",c:"#065f46"},{bg:"#fff7ed",c:"#9a3412"},{bg:"#eff6ff",c:"#1e40af"},{bg:"#fdf4ff",c:"#86198f"},{bg:"#fefce8",c:"#854d0e"}];
const CATEGORIES = [
  {id:"bug-fix",     label:"Bug Fix",      icon:"\u{1F41B}", bg:"#fef2f2", c:"#991b1b", border:"#fecaca"},
  {id:"code",        label:"Code",         icon:"\u{1F4BB}", bg:"#eff6ff", c:"#1e40af", border:"#bfdbfe"},
  {id:"ui-skill",    label:"UI Skill",     icon:"\u{1F3A8}", bg:"#f3f0ff", c:"#6d28d9", border:"#ddd6fe"},
  {id:"design-skill",label:"Design Skill", icon:"\u{2728}",  bg:"#ecfdf5", c:"#065f46", border:"#a7f3d0"},
];
const SORT_OPTS = [
  {id:"newest",label:"Newest first"},{id:"oldest",label:"Oldest first"},
  {id:"name-az",label:"Name A-Z"},{id:"name-za",label:"Name Z-A"},
  {id:"uploader",label:"Uploader A-Z"},{id:"size-desc",label:"Largest first"},
];
const catBy = id => CATEGORIES.find(x=>x.id===id);
const ac  = n => AC[(n||"").split("").reduce((a,x)=>a+x.charCodeAt(0),0)%AC.length];
const ini = n => (n||"").trim().split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
const fd  = d => new Date(d).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
const fsize = b => b<1024?b+"B":b<1048576?(b/1024).toFixed(1)+"KB":(b/1048576).toFixed(1)+"MB";

// Simple markdown renderer using marked.js
const renderMd = (text) => {
  try {
    if (window.marked) {
      window.marked.setOptions({breaks:true,gfm:true});
      return {__html: window.marked.parse(text||"")};
    }
  } catch(e) {}
  return {__html: (text||"").replace(/</g,"&lt;").replace(/\n/g,"<br/>")};
};

// ── Error Boundary ──
class ErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={hasError:false,error:null};}
  static getDerivedStateFromError(error){return {hasError:true,error};}
  render(){
    if(this.state.hasError) return (
      <div style={{padding:40,textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:16}}>⚠️</div>
        <h2 style={{fontSize:18,fontWeight:600,marginBottom:8,color:"var(--text)"}}>Something went wrong</h2>
        <p style={{fontSize:13,color:"var(--text3)",marginBottom:16}}>{this.state.error?.message}</p>
        <button className="btn btn-blue" onClick={()=>{this.setState({hasError:false,error:null});window.location.reload();}}>Reload</button>
      </div>
    );
    return this.props.children;
  }
}

// ── Modal Component ──
function Modal({open,onClose,title,children,width}){
  useEffect(()=>{
    if(!open) return;
    const h = e => {if(e.key==="Escape")onClose();};
    document.addEventListener("keydown",h);
    return ()=>document.removeEventListener("keydown",h);
  },[open,onClose]);
  if(!open) return null;
  return (
    <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modal" style={{maxWidth:width||500}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"18px 22px",borderBottom:"1px solid var(--border)"}}>
          <span style={{fontSize:15,fontWeight:600}}>{title}</span>
          <span style={{cursor:"pointer",fontSize:18,color:"var(--text4)",lineHeight:1}} onClick={onClose}>✕</span>
        </div>
        <div style={{padding:"18px 22px"}}>{children}</div>
      </div>
    </div>
  );
}

// ── Tag Input Component ──
function TagInput({tags,onChange}){
  const [input,setInput]=useState("");
  const add=()=>{const t=input.trim().toLowerCase();if(t&&!tags.includes(t)){onChange([...tags,t]);}setInput("");};
  return (
    <div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:tags.length?6:0}}>
        {tags.map(t=><span key={t} className="tag">{t}<span className="tag-rm" onClick={()=>onChange(tags.filter(x=>x!==t))}>✕</span></span>)}
      </div>
      <div style={{display:"flex",gap:6}}>
        <input className="field" value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();add();}}} placeholder="Type tag + Enter" style={{flex:1}}/>
        <button type="button" className="btn btn-ghost" onClick={add}>Add</button>
      </div>
    </div>
  );
}

function App() {
  // ── State ──
  // ── Auth state ──
  const [authUser,   setAuthUser]   = useState(null);  // {name, email}
  const [authLoading,setAuthLoading]= useState(true);

  const [tab,        setTab]        = useState("browse");
  const [files,      setFiles]      = useState([]);
  const [members,    setMembers]    = useState(()=> JSON.parse(localStorage.getItem("sm")||"[]"));
  const [teams,      setTeams]      = useState(()=> JSON.parse(localStorage.getItem("st")||"[]"));
  const [fetching,   setFetching]   = useState(false);
  const [loadingFiles,setLoadingFiles]= useState(true);
  const [search,     setSearch]     = useState("");
  const [preview,    setPreview]    = useState(null);
  const [toast,      setToast]      = useState(null);
  const [selMem,     setSelMem]     = useState(null);
  const [memSearch,  setMemSearch]  = useState("");
  const [memDrop,    setMemDrop]    = useState(false);
  const [selTeam,    setSelTeam]    = useState("");
  const [teamSearch, setTeamSearch] = useState("");
  const [teamDrop,   setTeamDrop]   = useState(false);
  const [customFolder,setCustomFolder]=useState("");
  const [browseFolder,setBrowseFolder]=useState("All");
  const [selCategory,setSelCategory]= useState("");
  const [browseCategory,setBrowseCategory]=useState("All");
  const [title,      setTitle]      = useState("");
  const [desc,       setDesc]       = useState("");
  const [selFile,    setSelFile]    = useState(null);
  const [dragOver,   setDragOver]   = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [vscodePanel,setVscodePanel]= useState(null);
  const [darkMode,   setDarkMode]   = useState(()=>localStorage.getItem("theme")==="dark");
  const [sortBy,     setSortBy]     = useState("newest");
  const [visibleCount,setVisibleCount]=useState(PAGE_SIZE);
  const [editModal,  setEditModal]  = useState(null);
  const [deleteModal,setDeleteModal]= useState(null);
  const [deletePwd,  setDeletePwd]  = useState("");
  const [deleting,   setDeleting]   = useState(false);
  const [editData,   setEditData]   = useState({});
  const [saving,     setSaving]     = useState(false);
  const [memberView, setMemberView] = useState(null);
  const [previewMode,setPreviewMode]= useState("rendered");
  const [uploadTags, setUploadTags] = useState([]);
  const [newCount,   setNewCount]   = useState(0);
  const prevFileCount = useRef(0);
  const fileRef = useRef();
  const memRef  = useRef();
  const teamRef = useRef();
  const searchRef = useRef();

  // ── Microsoft Auth ──
  useEffect(()=>{
    if (!msalInstance) { setAuthLoading(false); return; }
    msalInstance.initialize().then(()=>{
      msalInstance.handleRedirectPromise().then(resp=>{
        if (resp?.account) {
          setAuthUser({name:resp.account.name,email:(resp.account.username||"").toLowerCase()});
        } else {
          const accounts = msalInstance.getAllAccounts();
          if (accounts.length>0) {
            setAuthUser({name:accounts[0].name,email:(accounts[0].username||"").toLowerCase()});
          }
        }
      }).catch(()=>{}).finally(()=>setAuthLoading(false));
    }).catch(()=>setAuthLoading(false));
  },[]);

  const login = async () => {
    if (!msalInstance) { toast_("Microsoft Auth library not loaded. Check your internet connection and reload.","error"); return; }
    try {
      const resp = await msalInstance.loginPopup({scopes:["User.Read"]});
      if (resp?.account) {
        setAuthUser({name:resp.account.name,email:(resp.account.username||"").toLowerCase()});
        toast_(`Signed in as ${resp.account.name}`);
      }
    } catch(e) { if(e.name!=="BrowserAuthError") toast_(`Login failed: ${e.message}`,"error"); }
  };

  const logout = () => {
    if (!msalInstance) return;
    msalInstance.logoutPopup().then(()=>{setAuthUser(null);toast_("Signed out","info");}).catch(()=>{});
  };

  const getAccessToken = async () => {
    if (!msalInstance||!authUser) return null;
    try {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length===0) return null;
      const resp = await msalInstance.acquireTokenSilent({scopes:["User.Read"],account:accounts[0]});
      return resp.accessToken;
    } catch(e) {
      try {
        const resp = await msalInstance.acquireTokenPopup({scopes:["User.Read"]});
        return resp.accessToken;
      } catch(e2) { return null; }
    }
  };

  // Check if logged-in user owns a file (by email match)
  const isOwner = f => authUser && f.email && authUser.email === (f.email||"").toLowerCase();

  // Auto-select member when logged in via Outlook
  useEffect(()=>{
    if (authUser && members.length>0 && !selMem) {
      const match = members.find(m=>(m.email||"").toLowerCase()===authUser.email);
      if (match) setSelMem(match);
    }
  },[authUser,members]);

  // ── Dark mode ──
  useEffect(()=>{
    document.documentElement.setAttribute("data-theme",darkMode?"dark":"light");
    localStorage.setItem("theme",darkMode?"dark":"light");
  },[darkMode]);

  // ── Keyboard shortcuts ──
  useEffect(()=>{
    const h = e => {
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
      if(e.key==="/"){e.preventDefault();searchRef.current?.focus();}
      if(e.key==="Escape"){setPreview(null);setVscodePanel(null);setEditModal(null);setDeleteModal(null);setMemberView(null);}
    };
    document.addEventListener("keydown",h);
    return ()=>document.removeEventListener("keydown",h);
  },[]);

  const filteredMembers = members.filter(m=>{
    const q=memSearch.toLowerCase();
    return !q||m.displayName.toLowerCase().includes(q)||(m.email||"").toLowerCase().includes(q);
  });

  const existingFolders = [...new Set(files.map(f=>f.folder).filter(f=>f&&f!=="General"&&!teams.some(t=>t.name===f)))];
  const allFolderOptions = [
    ...teams.map(t=>({id:t.id,name:t.name,label:t.name+(t.project?` (${t.project})`:""),type:"team"})),
    ...existingFolders.map(f=>({id:f,name:f,label:f,type:"folder"})),
  ];
  const filteredFolders = allFolderOptions.filter(f=>{
    const q=teamSearch.toLowerCase();
    return !q||f.label.toLowerCase().includes(q);
  });

  useEffect(()=>{
    const handler = e=>{
      if (memRef.current && !memRef.current.contains(e.target)) setMemDrop(false);
      if (teamRef.current && !teamRef.current.contains(e.target)) setTeamDrop(false);
    };
    document.addEventListener("mousedown",handler);
    return ()=>document.removeEventListener("mousedown",handler);
  },[]);

  const toast_ = useCallback((msg, sev="success") => {
    setToast({msg,sev}); setTimeout(()=>setToast(null),3500);
  }, []);

  const loadMembers = useCallback(async () => {
    setFetching(true);
    try {
      const r = await fetch(`${PROXY}/members?org=${ORG}`);
      if (!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
      const d = await r.json();
      const m = d.members||[];
      setMembers(m);
      localStorage.setItem("sm", JSON.stringify(m));
      localStorage.setItem("sm_ts", Date.now().toString());
      toast_(`${m.length} members loaded`,"info");
    } catch(e){ toast_(`Error: ${e.message}`,"error"); }
    setFetching(false);
  }, [toast_]);

  const loadTeams = useCallback(async () => {
    try {
      const r = await fetch(`${PROXY}/teams?org=${ORG}`);
      if (!r.ok) return;
      const d = await r.json();
      const t = d.teams||[];
      setTeams(t);
      localStorage.setItem("st", JSON.stringify(t));
      localStorage.setItem("st_ts", Date.now().toString());
    } catch(e){}
  }, []);

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const r = await fetch(`${PROXY}/files`);
      if (!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
      const d = await r.json();
      const loaded = (d.files||[]).map(f=>({
        id:f.id, filename:f.filename, title:f.title, desc:f.description,
        uploader:f.uploader, email:f.email, size:f.size, ts:f.uploaded_at, content:f.content,
        folder:f.folder||"General", category:f.category||"",
        tags:f.tags?f.tags.split(",").filter(Boolean):[],
        version:f.version||1, updatedAt:f.updated_at
      }));
      if (prevFileCount.current > 0 && loaded.length > prevFileCount.current) {
        const diff = loaded.length - prevFileCount.current;
        setNewCount(diff);
        setTimeout(()=>setNewCount(0), 5000);
      }
      prevFileCount.current = loaded.length;
      setFiles(loaded);
    } catch(e){ toast_(`Files: ${e.message}`,"error"); }
    setLoadingFiles(false);
  }, [toast_]);

  // Initial load + cache expiry (1 hour)
  useEffect(()=>{
    const HOUR = 3600000;
    const smTs = Number(localStorage.getItem("sm_ts")||0);
    const stTs = Number(localStorage.getItem("st_ts")||0);
    if (members.length === 0 || Date.now()-smTs > HOUR) loadMembers();
    if (teams.length === 0 || Date.now()-stTs > HOUR) loadTeams();
    loadFiles();
    const interval = setInterval(loadFiles, 60000);
    return ()=>clearInterval(interval);
  }, []);  // eslint-disable-line

  const pickFile = f => {
    if (!f) return;
    if (!f.name.endsWith(".md")){ toast_("Only .md files allowed","error"); return; }
    setSelFile(f);
  };

  const upload = async () => {
    if (!selFile||!selMem||uploading) return;
    setUploading(true);
    try {
      const content = await selFile.text();
      const body = {
        id:`${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename:selFile.name, title:title.trim()||selFile.name.replace(".md",""),
        description:desc.trim(), uploader:selMem.displayName,
        email:selMem.email||"", size:selFile.size, uploaded_at:Date.now(), content,
        folder:(selTeam==="__new__"?customFolder.trim():selTeam)||"General",
        category:selCategory||"",
        tags:uploadTags.join(",")
      };
      const r = await fetch(`${PROXY}/files`,{
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
      });
      if (!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
      await loadFiles();
      setTab("browse"); setTitle(""); setDesc(""); setSelFile(null); setSelMem(null);
      setSelTeam(""); setCustomFolder(""); setSelCategory(""); setUploadTags([]);
      toast_(`${selFile.name} uploaded`);
    } catch(e){ toast_(`Upload failed: ${e.message}`,"error"); }
    setUploading(false);
  };

  const download = f => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([f.content],{type:"text/markdown"}));
    a.download = f.filename; a.click();
    toast_(`Downloaded ${f.filename}`);
  };

  // ── VS Code actions ──
  const openInVSCode = async f => {
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({suggestedName:f.filename,types:[{description:"Markdown",accept:{"text/markdown":[".md"]}}]});
        const writable = await handle.createWritable();
        await writable.write(f.content);
        await writable.close();
        window.open(`vscode://file/${handle.name}`, "_self");
        toast_(`Saved & opening in VS Code...`);
      } else {
        download(f);
        setTimeout(()=>{ window.location.href = `vscode://file/${f.filename}`; }, 600);
        toast_(`Downloaded — attempting to open VS Code...`);
      }
    } catch(e) {
      if(e.name!=="AbortError") toast_("Could not open VS Code. Is it installed?","error");
    }
  };

  const copyToClipboard = async f => {
    try {
      await navigator.clipboard.writeText(f.content);
      toast_(`Copied to clipboard — paste in VS Code with Ctrl+V`);
    } catch(e) { toast_("Clipboard copy failed","error"); }
  };

  const saveToWorkspace = async f => {
    try {
      if (window.showDirectoryPicker) {
        const dirHandle = await window.showDirectoryPicker();
        const fileHandle = await dirHandle.getFileHandle(f.filename, {create:true});
        const writable = await fileHandle.createWritable();
        await writable.write(f.content);
        await writable.close();
        toast_(`Saved ${f.filename} to ${dirHandle.name}/`);
      } else {
        download(f);
        toast_("Folder picker not supported — file downloaded instead");
      }
    } catch(e) {
      if (e.name !== "AbortError") toast_(`Save failed: ${e.message}`,"error");
    }
  };

  const saveToMCPFolder = async f => {
    try {
      if (window.showDirectoryPicker) {
        const dirHandle = await window.showDirectoryPicker({id:"claude-mcp",startIn:"documents"});
        let target = dirHandle;
        try { target = await dirHandle.getDirectoryHandle(".claude",{create:true}); } catch(e){}
        const fileHandle = await target.getFileHandle(f.filename, {create:true});
        const writable = await fileHandle.createWritable();
        await writable.write(f.content);
        await writable.close();
        toast_(`Saved to ${dirHandle.name}/.claude/${f.filename}`);
      } else {
        download(f);
        toast_("Folder picker not supported — file downloaded instead");
      }
    } catch(e) {
      if (e.name !== "AbortError") toast_(`Save failed: ${e.message}`,"error");
    }
  };

  // ── Delete (server-side auth) ──
  const deleteFile = async () => {
    if (!deleteModal||deleting) return;
    setDeleting(true);
    try {
      const token = await getAccessToken();
      if (!token){ toast_("Please sign in with Outlook to delete files","error"); setDeleting(false); return; }
      const r = await fetch(`${PROXY}/files/${deleteModal.id}`,{
        method:"DELETE", headers:{"x-delete-password":deletePwd,"Authorization":`Bearer ${token}`}
      });
      if (!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
      if (preview?.id===deleteModal.id) setPreview(null);
      setDeleteModal(null); setDeletePwd("");
      await loadFiles();
      toast_(`Deleted ${deleteModal.filename}`);
    } catch(e){ toast_(`Delete failed: ${e.message}`,"error"); }
    setDeleting(false);
  };

  // ── Edit file ──
  const editFileRef = useRef();
  const openEdit = f => {
    setEditData({title:f.title||"",description:f.desc||"",category:f.category||"",folder:f.folder||"General",tags:f.tags||[],replaceFile:null});
    setEditModal(f);
  };
  const pickReplaceFile = f => {
    if (!f) return;
    if (!f.name.endsWith(".md")){ toast_("Only .md files allowed","error"); return; }
    setEditData(d=>({...d,replaceFile:f}));
  };
  const saveEdit = async () => {
    if (!editModal||saving) return;
    setSaving(true);
    try {
      const payload = {...editData,tags:editData.tags?.join(",")||""};
      if (editData.replaceFile) {
        const content = await editData.replaceFile.text();
        payload.content = content;
        payload.filename = editData.replaceFile.name;
        payload.size = editData.replaceFile.size;
      }
      delete payload.replaceFile;
      const token = await getAccessToken();
      if (!token){ toast_("Please sign in with Outlook to edit files","error"); setSaving(false); return; }
      const r = await fetch(`${PROXY}/files/${editModal.id}`,{
        method:"PUT", headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
        body:JSON.stringify(payload)
      });
      if (!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
      setEditModal(null);
      await loadFiles();
      toast_(editData.replaceFile ? "File replaced & updated" : "File updated");
    } catch(e){ toast_(`Update failed: ${e.message}`,"error"); }
    setSaving(false);
  };

  // ── Bulk download as ZIP ──
  const bulkDownload = async (filesToZip) => {
    if(!window.JSZip){toast_("JSZip not loaded","error");return;}
    toast_("Creating ZIP...","info");
    const zip = new JSZip();
    filesToZip.forEach(f=>zip.file(f.filename,f.content));
    const blob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `skills-${browseFolder!=="All"?browseFolder:"all"}.zip`;
    a.click();
    toast_(`Downloaded ${filesToZip.length} files as ZIP`);
  };

  // ── Export to PDF (print) ──
  const exportPdf = f => {
    const w = window.open("","_blank");
    const html = renderMd(f.content).__html;
    w.document.write(`<!DOCTYPE html><html><head><title>${f.title||f.filename}</title>
      <style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.7;font-size:14px;color:#1e293b;}
      h1{font-size:22px;border-bottom:1px solid #e2e8f0;padding-bottom:8px;} h2{font-size:17px;} h3{font-size:14px;}
      code{background:#f1f5f9;padding:2px 5px;border-radius:3px;font-size:12px;}
      pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;overflow-x:auto;}
      blockquote{border-left:3px solid #0078d4;padding:4px 12px;margin:10px 0;color:#475569;background:#eff6ff;}
      table{border-collapse:collapse;width:100%;} th,td{border:1px solid #e2e8f0;padding:6px 10px;font-size:12px;} th{background:#f8fafc;}
      @media print{body{margin:0;}} </style></head><body>
      <h1>${f.title||f.filename}</h1>
      <p style="color:#64748b;font-size:12px;margin-bottom:20px;">By ${f.uploader} · ${fd(f.ts)}</p>
      ${html}</body></html>`);
    w.document.close();
    setTimeout(()=>w.print(),300);
  };

  // ── Filtering + sorting ──
  const filtered = useMemo(()=>{
    let list = files.filter(f=>{
      if (browseFolder!=="All" && f.folder!==browseFolder) return false;
      if (browseCategory!=="All" && f.category!==browseCategory) return false;
      if (memberView && f.uploader!==memberView) return false;
      const q=search.toLowerCase();
      return !q||[f.filename,f.uploader,f.content,f.title||"",f.desc||"",f.folder||"",
        catBy(f.category)?.label||"",...(f.tags||[])].some(s=>s.toLowerCase().includes(q));
    });
    switch(sortBy){
      case "oldest":  list.sort((a,b)=>a.ts-b.ts); break;
      case "name-az": list.sort((a,b)=>(a.title||a.filename).localeCompare(b.title||b.filename)); break;
      case "name-za": list.sort((a,b)=>(b.title||b.filename).localeCompare(a.title||a.filename)); break;
      case "uploader":list.sort((a,b)=>a.uploader.localeCompare(b.uploader)); break;
      case "size-desc":list.sort((a,b)=>b.size-a.size); break;
      default: list.sort((a,b)=>b.ts-a.ts);
    }
    return list;
  },[files,browseFolder,browseCategory,search,sortBy,memberView]);

  const paged = filtered.slice(0,visibleCount);
  const folders = ["All",...[...new Set(files.map(f=>f.folder||"General"))].sort()];
  const uniq = new Set(files.map(f=>f.uploader)).size;
  const ready = selMem && selFile;

  useEffect(()=>setVisibleCount(PAGE_SIZE),[browseFolder,browseCategory,search,sortBy,memberView]);

  return (
    <div className="wrap">
      {toast && <div className={`toast ${toast.sev==="error"?"t-err":toast.sev==="info"?"t-inf":"t-ok"}`}>{toast.msg}</div>}

      {/* New file notification banner */}
      {newCount>0&&(
        <div style={{background:"var(--green-bg)",border:"1.5px solid var(--green-border)",borderRadius:10,padding:"10px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",animation:"up .25s ease"}}>
          <span style={{fontSize:13,fontWeight:500,color:"var(--green)"}}>{newCount} new file{newCount>1?"s":""} uploaded!</span>
          <span style={{fontSize:12,color:"var(--text4)",cursor:"pointer"}} onClick={()=>setNewCount(0)}>Dismiss</span>
        </div>
      )}

      {/* Header */}
      <div className="header-card">
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14,flexWrap:"wrap"}}>
          <div style={{width:46,height:46,borderRadius:12,background:"rgba(255,255,255,.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>📂</div>
          <div style={{flex:1}}>
            <h1 style={{fontSize:22,fontWeight:600,color:"#fff",margin:0}}>Team Skills Directory</h1>
            <p style={{fontSize:13,color:"rgba(255,255,255,.8)",margin:0}}>dev.azure.com / <b>Sogolytics</b></p>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {/* Outlook Login/User */}
            {authUser ? (
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:20,background:"rgba(255,255,255,.2)",border:"1px solid rgba(255,255,255,.3)"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:"#4ade80",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:"#065f46"}}>{ini(authUser.name)}</div>
                  <span style={{fontSize:11,color:"#fff",fontWeight:500,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{authUser.name}</span>
                </div>
                <div onClick={logout} title="Sign out"
                  style={{display:"flex",alignItems:"center",gap:4,fontSize:11,padding:"5px 10px",borderRadius:20,background:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.7)",border:"1px solid rgba(255,255,255,.2)",cursor:"pointer",fontWeight:500}}>
                  Sign out
                </div>
              </div>
            ) : (
              <div onClick={login}
                style={{display:"flex",alignItems:"center",gap:6,fontSize:11,padding:"5px 14px",borderRadius:20,background:"rgba(255,255,255,.2)",color:"#fff",border:"1px solid rgba(255,255,255,.3)",cursor:"pointer",fontWeight:600}}>
                <svg width="14" height="14" viewBox="0 0 23 23" fill="none"><path d="M1 1h10v10H1z" fill="#f25022"/><path d="M12 1h10v10H12z" fill="#7fba00"/><path d="M1 12h10v10H1z" fill="#00a4ef"/><path d="M12 12h10v10H12z" fill="#ffb900"/></svg>
                Sign in with Outlook
              </div>
            )}
            <div onClick={()=>setDarkMode(!darkMode)} title={darkMode?"Light mode":"Dark mode"}
              style={{display:"flex",alignItems:"center",gap:5,fontSize:11,padding:"5px 12px",borderRadius:20,background:"rgba(255,255,255,.15)",color:"#fff",border:"1px solid rgba(255,255,255,.25)",cursor:"pointer",fontWeight:500}}>
              <span style={{fontSize:14,lineHeight:1}}>{darkMode?"☀️":"🌙"}</span> {darkMode?"Light":"Dark"}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5,fontSize:11,padding:"5px 12px",borderRadius:20,background:"rgba(255,255,255,.15)",color:"#fff",border:"1px solid rgba(255,255,255,.25)",cursor:"pointer",fontWeight:500}} onClick={loadMembers}>
              {fetching
                ? <><svg className="spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Loading…</>
                : <><span style={{width:6,height:6,borderRadius:"50%",background:"#4ade80",display:"inline-block"}}></span> {members.length} members ↻</>}
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {[["📄",files.length,"Total files"],["👥",uniq,"Contributors"]].map(([ic,v,l])=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:8,background:"rgba(255,255,255,.15)",borderRadius:10,padding:"8px 14px"}}>
              <span>{ic}</span>
              <div><p style={{margin:0,fontSize:18,fontWeight:600,color:"#fff",lineHeight:1}}>{v}</p><p style={{margin:0,fontSize:11,color:"rgba(255,255,255,.7)"}}>{l}</p></div>
            </div>
          ))}
          <div style={{marginLeft:"auto",fontSize:10,color:"rgba(255,255,255,.5)",alignSelf:"flex-end"}}>Press / to search · Esc to close</div>
        </div>
      </div>

      {/* Tabs + Search */}
      <div className="card">
        <div className="section" style={{paddingBottom:0}}>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <div className="tab-bar" style={{marginBottom:0}}>
              {[["upload","Upload","M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M17 8l-5-5-5 5|M12 3v12"],["browse",`Browse (${files.length})`,"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22V12h6v10"]].map(([t,l,paths])=>(
                <button key={t} className={`tab-btn ${tab===t?"tab-active":"tab-inactive"}`} onClick={()=>setTab(t)} style={{display:"inline-flex",alignItems:"center",gap:6}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {paths.split("|").map((d,i)=><path key={i} d={d}/>)}
                  </svg>
                  {l}
                </button>
              ))}
            </div>
            {tab==="browse"&&(
              <div style={{position:"relative",flex:1,minWidth:180}}>
                <svg style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text4)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input ref={searchRef} className="field" value={search} onChange={e=>setSearch(e.target.value)}
                  placeholder="Search files…" style={{paddingLeft:34,paddingRight:search?34:12,fontSize:13,padding:"8px 12px 8px 34px",borderRadius:8}}/>
                {search&&(
                  <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",cursor:"pointer",color:"var(--text4)",fontSize:12,fontWeight:500,
                    background:"var(--border)",borderRadius:4,padding:"1px 6px",lineHeight:1.3}}
                    onClick={()=>{setSearch("");searchRef.current?.focus();}}>✕</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ════════ Upload Tab ════════ */}
        {tab==="upload"&&(
          <div className="section">
            {members.length===0?(
              <div className="empty">
                {fetching
                  ? <><div className="bar"><div className="bar-fill"/></div><p style={{marginTop:12,fontSize:13,color:"var(--text3)"}}>Loading Azure DevOps members…</p></>
                  : <><p style={{fontSize:14,fontWeight:600,marginBottom:8}}>Could not load members</p><button className="btn btn-blue" onClick={loadMembers}>Retry</button></>}
              </div>
            ):(
              <>
                {/* ── Row 1: Member + Team (side by side) ── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
                  {/* Member picker */}
                  <div ref={memRef}>
                    <span className="lbl">Team member</span>
                    <div style={{position:"relative"}}>
                      <input className="field" placeholder="Search members…"
                        value={selMem&&!memDrop ? selMem.displayName : memSearch}
                        onFocus={()=>{setMemDrop(true);if(selMem)setMemSearch("");}}
                        onChange={e=>{setMemSearch(e.target.value);setMemDrop(true);if(selMem){setSelMem(null);}}}
                        style={{paddingRight:selMem?36:14}}/>
                      {selMem&&!memDrop&&(
                        <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",cursor:"pointer",fontSize:14,color:"var(--text4)"}}
                          onClick={()=>{setSelMem(null);setMemSearch("");setMemDrop(true);}}>✕</span>
                      )}
                      {memDrop&&(
                        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--card)",border:"1.5px solid var(--border)",borderRadius:10,marginTop:4,maxHeight:220,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,.15)"}}>
                          {filteredMembers.length===0&&<div style={{padding:"12px 14px",fontSize:13,color:"var(--text4)"}}>No members found</div>}
                          {filteredMembers.map(m=>{
                            const {bg,c}=ac(m.displayName);
                            return (
                              <div key={m.id} onClick={()=>{setSelMem(m);setMemSearch("");setMemDrop(false);}}
                                style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",cursor:"pointer",transition:"background .1s",borderBottom:"1px solid var(--border2)"}}
                                onMouseEnter={e=>e.currentTarget.style.background="var(--blue-bg)"}
                                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                                <div className="avatar" style={{width:28,height:28,fontSize:10,background:bg,color:c}}>{ini(m.displayName)}</div>
                                <div style={{flex:1,minWidth:0}}>
                                  <p style={{margin:0,fontSize:12,fontWeight:600,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.displayName}</p>
                                  {m.email&&<p style={{margin:0,fontSize:10,color:"var(--text3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.email}</p>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {selMem&&!memDrop&&(
                      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,padding:"8px 12px",background:"var(--blue-bg)",borderRadius:8,border:"1.5px solid var(--blue-border)"}}>
                        <div className="avatar" style={{width:28,height:28,fontSize:10,background:ac(selMem.displayName).bg,color:ac(selMem.displayName).c}}>{ini(selMem.displayName)}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <p style={{margin:0,fontSize:12,fontWeight:600,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selMem.displayName}</p>
                          <p style={{margin:0,fontSize:10,color:"var(--blue)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selMem.email||"Azure DevOps member"}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Team/folder picker */}
                  <div ref={teamRef}>
                    <span className="lbl">Team / Folder</span>
                    <div style={{position:"relative"}}>
                      <input className="field" placeholder="Search teams…"
                        value={selTeam&&selTeam!=="__new__"&&!teamDrop ? selTeam : teamSearch}
                        onFocus={()=>{setTeamDrop(true);if(selTeam&&selTeam!=="__new__")setTeamSearch("");}}
                        onChange={e=>{setTeamSearch(e.target.value);setTeamDrop(true);if(selTeam&&selTeam!=="__new__"){setSelTeam("");setCustomFolder("");}}}
                        style={{paddingRight:selTeam&&selTeam!=="__new__"?36:14}}/>
                      {selTeam&&selTeam!=="__new__"&&!teamDrop&&(
                        <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",cursor:"pointer",fontSize:14,color:"var(--text4)"}}
                          onClick={()=>{setSelTeam("");setTeamSearch("");setTeamDrop(true);}}>✕</span>
                      )}
                      {teamDrop&&(
                        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--card)",border:"1.5px solid var(--border)",borderRadius:10,marginTop:4,maxHeight:220,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,.15)"}}>
                          <div onClick={()=>{setSelTeam("");setTeamSearch("");setTeamDrop(false);setCustomFolder("");}}
                            style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",cursor:"pointer",borderBottom:"1px solid var(--border2)"}}
                            onMouseEnter={e=>e.currentTarget.style.background="var(--bg)"}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <span style={{fontSize:14}}>📂</span>
                            <span style={{fontSize:13,fontWeight:500,color:"var(--text3)"}}>General (default)</span>
                          </div>
                          {filteredFolders.map(f=>(
                            <div key={f.id} onClick={()=>{setSelTeam(f.name);setTeamSearch("");setTeamDrop(false);setCustomFolder("");}}
                              style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",cursor:"pointer",borderBottom:"1px solid var(--border2)"}}
                              onMouseEnter={e=>e.currentTarget.style.background="var(--blue-bg)"}
                              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                              <span style={{fontSize:14}}>{f.type==="team"?"👥":"📁"}</span>
                              <div style={{flex:1,minWidth:0}}>
                                <p style={{margin:0,fontSize:13,fontWeight:600,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.label}</p>
                              </div>
                            </div>
                          ))}
                          {filteredFolders.length===0&&!teamSearch&&<div style={{padding:"10px 14px",fontSize:12,color:"var(--text4)"}}>No teams loaded</div>}
                          <div onClick={()=>{setSelTeam("__new__");setTeamSearch("");setTeamDrop(false);}}
                            style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",cursor:"pointer",borderTop:"1.5px solid var(--border)",background:"var(--bg)"}}
                            onMouseEnter={e=>e.currentTarget.style.background="var(--blue-bg)"}
                            onMouseLeave={e=>e.currentTarget.style.background="var(--bg)"}>
                            <span style={{fontSize:14,color:"var(--blue)"}}>+</span>
                            <span style={{fontSize:13,fontWeight:600,color:"var(--blue)"}}>Create new folder</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {selTeam==="__new__"&&(
                      <input className="field" style={{marginTop:8}} value={customFolder} onChange={e=>setCustomFolder(e.target.value)} placeholder="New folder name…" autoFocus/>
                    )}
                    {selTeam&&selTeam!=="__new__"&&!teamDrop&&(
                      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,padding:"8px 12px",background:"var(--yellow-bg)",borderRadius:8,border:"1.5px solid var(--yellow-border)"}}>
                        <span style={{fontSize:14}}>📁</span>
                        <span style={{fontSize:12,fontWeight:600,color:"var(--yellow-c)"}}>{selTeam}</span>
                      </div>
                    )}
                    {selTeam==="__new__"&&customFolder.trim()&&(
                      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,padding:"8px 12px",background:"var(--green-bg)",borderRadius:8,border:"1.5px solid var(--green-border)"}}>
                        <span style={{fontSize:14}}>📁</span>
                        <span style={{fontSize:12,fontWeight:600,color:"var(--green)"}}>{customFolder.trim()} (new)</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Row 2: Title + Category (side by side) ── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
                  <div>
                    <span className="lbl">File title</span>
                    <input className="field" value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Frontend & React Skills"/>
                  </div>
                  <div>
                    <span className="lbl">Skill category</span>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {CATEGORIES.map(cat=>{
                        const active = selCategory===cat.id;
                        return (
                          <button key={cat.id} type="button" onClick={()=>setSelCategory(active?"":cat.id)}
                            style={{display:"inline-flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:20,
                              border:`1.5px solid ${active?cat.c:cat.border}`,background:active?cat.bg:"var(--card)",
                              color:active?cat.c:"var(--text3)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Inter,sans-serif",transition:"all .15s"}}>
                            <span>{cat.icon}</span>{cat.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* ── Row 3: Tags (full width) ── */}
                <div style={{marginBottom:16}}>
                  <span className="lbl">Tags</span>
                  <TagInput tags={uploadTags} onChange={setUploadTags}/>
                </div>

                {/* ── Row 4: Description (full width) ── */}
                <div style={{marginBottom:16}}>
                  <span className="lbl">Short description</span>
                  <textarea className="field" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Brief summary of skills covered" rows={2} style={{resize:"vertical",lineHeight:1.6}}/>
                </div>

                {/* ── Row 4: File drop (full width) ── */}
                <div style={{marginBottom:18}}>
                  <span className="lbl">skill.md file</span>
                  <div className={`drop${dragOver?" drop-over":""}`}
                    onDragOver={e=>{e.preventDefault();setDragOver(true)}}
                    onDragLeave={()=>setDragOver(false)}
                    onDrop={e=>{e.preventDefault();setDragOver(false);pickFile(e.dataTransfer.files[0]);}}
                    onClick={()=>fileRef.current.click()}
                    style={{padding:24}}>
                    {selFile?(
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
                        <span style={{fontSize:24}}>📄</span>
                        <div style={{textAlign:"left"}}>
                          <p style={{margin:0,fontSize:13,fontWeight:600,color:"var(--text)"}}>{selFile.name}</p>
                          <p style={{margin:"2px 0 0",fontSize:11,color:"var(--text3)"}}>
                            {(selFile.size/1024).toFixed(1)} KB ·{" "}
                            <span style={{color:"var(--blue)",cursor:"pointer"}} onClick={e=>{e.stopPropagation();setSelFile(null);fileRef.current.value="";}}>Remove</span>
                          </p>
                        </div>
                      </div>
                    ):(
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
                        <span style={{fontSize:28}}>☁️</span>
                        <div>
                          <p style={{fontSize:13,fontWeight:600,color:"var(--text)",margin:0}}>Drop your <code style={{background:"#dbeafe",color:"#1e40af",padding:"1px 6px",borderRadius:4,fontSize:11}}>skill.md</code> here</p>
                          <p style={{fontSize:11,color:"var(--text4)",margin:"2px 0 0"}}>or click to browse · .md files only</p>
                        </div>
                      </div>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept=".md" style={{display:"none"}} onChange={e=>pickFile(e.target.files[0])}/>
                </div>

                {/* ── Upload button ── */}
                <button onClick={upload} disabled={!ready||uploading}
                  style={{width:"100%",padding:"12px",borderRadius:10,border:"none",fontFamily:"Inter,sans-serif",
                    background:ready&&!uploading?"var(--blue)":"var(--border)",
                    color:ready&&!uploading?"#fff":"var(--text4)",fontSize:14,fontWeight:600,
                    cursor:ready&&!uploading?"pointer":"not-allowed"}}>
                  {uploading?"Uploading…":"Upload skill file"}
                </button>
                {!ready&&<p style={{fontSize:11,color:"var(--text4)",textAlign:"center",marginTop:8}}>
                  {!selMem&&!selFile?"Select a member and .md file":!selMem?"Select a team member":"Select a .md file"}
                </p>}
              </>
            )}
          </div>
        )}

        {/* ════════ Browse Tab ════════ */}
        {tab==="browse"&&(
          <div className="section">
            {memberView&&(
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"var(--blue-bg)",borderRadius:10,border:"1.5px solid var(--blue-border)",marginBottom:14}}>
                <div className="avatar" style={{width:32,height:32,fontSize:11,background:ac(memberView).bg,color:ac(memberView).c}}>{ini(memberView)}</div>
                <div style={{flex:1}}>
                  <span style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>{memberView}</span>
                  <span style={{fontSize:12,color:"var(--text3)",marginLeft:8}}>{files.filter(f=>f.uploader===memberView).length} files</span>
                </div>
                <span style={{cursor:"pointer",fontSize:12,color:"var(--blue)",fontWeight:500}} onClick={()=>setMemberView(null)}>Clear filter ✕</span>
              </div>
            )}

            {/* Filter bar */}
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
              {folders.length>2&&(
                <select className="field" value={browseFolder} onChange={e=>setBrowseFolder(e.target.value)}
                  style={{width:"auto",minWidth:0,cursor:"pointer",fontSize:12,fontWeight:600,padding:"6px 28px 6px 10px",borderRadius:8,color:browseFolder!=="All"?"var(--blue)":"var(--text3)",
                    borderColor:browseFolder!=="All"?"var(--blue)":"var(--border)",background:browseFolder!=="All"?"var(--blue-bg)":"var(--card)"}}>
                  <option value="All">📁 All folders ({files.length})</option>
                  {folders.filter(f=>f!=="All").map(f=><option key={f} value={f}>📁 {f}</option>)}
                </select>
              )}
              <select className="field" value={browseCategory} onChange={e=>setBrowseCategory(e.target.value)}
                style={{width:"auto",minWidth:0,cursor:"pointer",fontSize:12,fontWeight:600,padding:"6px 28px 6px 10px",borderRadius:8,color:browseCategory!=="All"?"var(--blue)":"var(--text3)",
                  borderColor:browseCategory!=="All"?"var(--blue)":"var(--border)",background:browseCategory!=="All"?"var(--blue-bg)":"var(--card)"}}>
                <option value="All">All categories</option>
                {CATEGORIES.map(cat=>{
                  const count=files.filter(f=>f.category===cat.id).length;
                  return <option key={cat.id} value={cat.id}>{cat.icon} {cat.label}{count?` (${count})`:""}</option>;
                })}
              </select>
              <select className="field" value={sortBy} onChange={e=>setSortBy(e.target.value)}
                style={{width:"auto",minWidth:0,cursor:"pointer",fontSize:12,fontWeight:600,padding:"6px 28px 6px 10px",borderRadius:8,color:"var(--text3)"}}>
                {SORT_OPTS.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <div style={{flex:1}}/>
              {(browseFolder!=="All"||browseCategory!=="All"||search)&&(
                <button onClick={()=>{setBrowseFolder("All");setBrowseCategory("All");setSearch("");}}
                  style={{display:"inline-flex",alignItems:"center",gap:4,padding:"5px 10px",borderRadius:6,border:"1.5px solid var(--red-border)",
                    background:"var(--red-bg)",color:"var(--red)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>
                  Clear filters ✕
                </button>
              )}
              {filtered.length>1&&(
                <button className="btn btn-ghost" onClick={()=>bulkDownload(filtered)} title={`Download ${filtered.length} files as ZIP`}
                  style={{padding:"6px 10px",fontSize:11}}>
                  📦 ZIP
                </button>
              )}
            </div>

            {/* Loading skeleton */}
            {loadingFiles&&files.length===0&&(
              <div>
                {[1,2,3].map(i=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:14,padding:"16px 18px",border:"1.5px solid var(--border)",borderRadius:14,marginBottom:10}}>
                    <div className="skel" style={{width:42,height:42,borderRadius:"50%"}}/>
                    <div style={{flex:1}}>
                      <div className="skel" style={{width:"60%",height:14,marginBottom:8}}/>
                      <div className="skel" style={{width:"40%",height:10}}/>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loadingFiles&&files.length===0&&(
              <div className="empty">
                <p style={{fontSize:15,fontWeight:600,marginBottom:6}}>No files yet</p>
                <p style={{fontSize:13,color:"var(--text3)",marginBottom:16}}>Upload your first skill.md</p>
                <button className="btn btn-blue" onClick={()=>setTab("upload")}>Upload now</button>
              </div>
            )}
            {files.length>0&&filtered.length===0&&<p style={{textAlign:"center",color:"var(--text4)",fontSize:13,padding:"2rem"}}>No results.</p>}

            {/* File cards */}
            {paged.map(f=>{
              const {bg,c} = ac(f.uploader);
              const open = preview?.id===f.id;
              return (
                <div key={f.id} className={`file-card${open?" file-card-open":""}`}>
                  <div style={{display:"flex",alignItems:"center",gap:14,padding:"16px 18px"}}>
                    <div className="avatar" style={{width:42,height:42,fontSize:13,background:bg,color:c,cursor:"pointer"}}
                      onClick={()=>setMemberView(f.uploader)} title={`View all by ${f.uploader}`}>{ini(f.uploader)}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontSize:14,fontWeight:600,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.title||f.filename}</span>
                        <span className="badge">MD</span>
                        {f.version>1&&<span style={{fontSize:10,padding:"1px 6px",borderRadius:10,fontWeight:600,background:"var(--yellow-bg)",color:"var(--yellow-c)"}}>v{f.version}</span>}
                        {(() => { const cat=catBy(f.category); return cat&&(
                          <span style={{fontSize:11,padding:"2px 8px",borderRadius:20,fontWeight:600,background:cat.bg,color:cat.c,border:`1px solid ${cat.border}`,display:"inline-flex",alignItems:"center",gap:3}}>
                            <span>{cat.icon}</span>{cat.label}
                          </span>
                        ); })()}
                        {f.folder&&f.folder!=="General"&&<span style={{fontSize:11,padding:"2px 8px",borderRadius:20,fontWeight:600,background:"var(--yellow-bg)",color:"var(--yellow-c)"}}>📁 {f.folder}</span>}
                      </div>
                      {f.desc&&<p style={{fontSize:12,color:"var(--text2)",margin:"0 0 3px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.desc}</p>}
                      {f.tags&&f.tags.length>0&&(
                        <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:3}}>
                          {f.tags.map(t=><span key={t} className="tag">{t}</span>)}
                        </div>
                      )}
                      <div className="meta">
                        <span style={{fontWeight:500,color:"var(--text2)",cursor:"pointer"}} onClick={()=>setMemberView(f.uploader)}>{f.uploader}</span>
                        {f.email&&<><span className="dot"/><span>{f.email}</span></>}
                        <span className="dot"/><span>{fd(f.ts)}</span>
                        <span className="dot"/><span>{fsize(f.size)}</span>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:6,flexShrink:0,flexWrap:"wrap"}}>
                      <button className={`btn ${open?"btn-outline":"btn-ghost"}`} onClick={()=>setPreview(open?null:f)} title={open?"Hide preview":"Preview"}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {open
                            ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
                            : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
                        </svg>
                      </button>
                      <button className={`btn ${vscodePanel===f.id?"btn-outline":"btn-ghost"}`}
                        onClick={()=>setVscodePanel(vscodePanel===f.id?null:f.id)} title="Open in VS Code"
                        style={vscodePanel===f.id?{borderColor:"var(--blue)",background:"var(--blue-bg)",color:"var(--blue)"}:{}}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16 3l5 2.5v13L16 21l-11-5.5L16 3z"/><path d="M5 15.5L10 12 5 8.5"/><path d="M16 3v18"/>
                        </svg>
                      </button>
                      {isOwner(f)&&(
                      <button className="btn btn-ghost" onClick={()=>openEdit(f)} title="Edit">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      )}
                      <button className="btn btn-ghost" onClick={()=>download(f)} title="Download">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                      </button>
                      <button className="btn btn-ghost" onClick={()=>exportPdf(f)} title="Export as PDF">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                      </button>
                      {isOwner(f)&&(
                      <button className="btn btn-ghost" onClick={()=>{setDeleteModal(f);setDeletePwd("");}} title="Delete"
                        style={{borderColor:"var(--red-border)",color:"var(--red)"}}
                        onMouseEnter={e=>{e.currentTarget.style.background="var(--red-bg)";e.currentTarget.style.borderColor="#f87171";}}
                        onMouseLeave={e=>{e.currentTarget.style.background="var(--bg)";e.currentTarget.style.borderColor="var(--red-border)";}}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      </button>
                      )}
                    </div>
                  </div>

                  {/* VS Code Panel */}
                  {vscodePanel===f.id&&(
                    <div style={{padding:"0 18px 16px"}}>
                      <div style={{borderRadius:12,overflow:"hidden",border:"1.5px solid var(--green-border)"}}>
                        <div style={{background:"linear-gradient(90deg,#ecfdf5,#f0fdf4)",padding:"14px 18px",borderLeft:"4px solid #10b981",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:13,color:"#065f46"}}>Save</span>
                            <code style={{background:"#d1fae5",color:"#065f46",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600}}>{f.filename}</code>
                            <span style={{fontSize:13,color:"#065f46"}}>to your local environment</span>
                          </div>
                          <span style={{fontSize:13,color:"#6b7280",cursor:"pointer",fontWeight:500}} onClick={()=>setVscodePanel(null)}>✕</span>
                        </div>
                        <div style={{background:"#1a1a2e",padding:18}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0078d4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M16 3l5 2.5v13L16 21l-11-5.5L16 3z"/><path d="M5 15.5L10 12 5 8.5"/><path d="M16 3v18"/>
                              </svg>
                              <span style={{fontSize:14,fontWeight:600,color:"#fff"}}>VS Code Actions</span>
                            </div>
                            <span style={{fontSize:10,fontWeight:600,color:"#10b981",background:"rgba(16,185,129,.15)",padding:"3px 10px",borderRadius:20,border:"1px solid rgba(16,185,129,.3)"}}>Recommended</span>
                          </div>
                          {[
                            {icon:"📂",iconBg:"#f59e0b",label:"Open in VS Code",sub:"Save file + launches VS Code via vscode:// protocol",action:()=>openInVSCode(f)},
                            {icon:"📋",iconBg:"#f97316",label:"Copy content to clipboard",sub:"Paste into a new file in VS Code with Ctrl+V",action:()=>copyToClipboard(f)},
                            {icon:"📁",iconBg:"#10b981",label:"Save to workspace folder",sub:"Pick your VS Code project folder — file saves directly",action:()=>saveToWorkspace(f)},
                          ].map((item,i)=>(
                            <button key={i} onClick={item.action}
                              style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:10,border:"1px solid #2a2a40",background:"#222238",color:"#e2e8f0",cursor:"pointer",fontFamily:"Inter,sans-serif",marginBottom:8,transition:"all .15s",textAlign:"left"}}
                              onMouseEnter={e=>{e.currentTarget.style.background="#2d2d48";e.currentTarget.style.borderColor="#0078d4";}}
                              onMouseLeave={e=>{e.currentTarget.style.background="#222238";e.currentTarget.style.borderColor="#2a2a40";}}>
                              <div style={{width:36,height:36,borderRadius:8,background:item.iconBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{item.icon}</div>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{fontSize:13,fontWeight:600,color:"#fff"}}>{item.label}</div>
                                <div style={{fontSize:11,color:"#8b8fa3",marginTop:2}}>{item.sub}</div>
                              </div>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><polyline points="9 18 15 12 9 6"/></svg>
                            </button>
                          ))}
                          <div style={{marginTop:12}}>
                            <span style={{fontSize:10,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".06em"}}>Or run in terminal</span>
                            <div style={{background:"#111122",borderRadius:8,padding:"10px 14px",marginTop:6,fontFamily:"'Cascadia Code',Consolas,monospace",fontSize:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                              <span><span style={{color:"#6b7280"}}>$ </span><span style={{color:"#fff"}}>code --add </span><span style={{color:"#10b981"}}>{f.filename}</span></span>
                              <span style={{color:"#6b7280",cursor:"pointer",fontSize:11,fontFamily:"Inter,sans-serif"}}
                                onClick={()=>{navigator.clipboard.writeText(`code --add ${f.filename}`);toast_("Command copied!");}}>Copy</span>
                            </div>
                          </div>
                        </div>
                        <div style={{background:"#f0fdf4",padding:"12px 18px",display:"flex",gap:10}}>
                          <button onClick={()=>saveToMCPFolder(f)}
                            style={{flex:1,display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:10,border:"1.5px solid #d1fae5",background:"#fff",cursor:"pointer",fontFamily:"Inter,sans-serif",transition:"all .15s"}}
                            onMouseEnter={e=>e.currentTarget.style.borderColor="#10b981"}
                            onMouseLeave={e=>e.currentTarget.style.borderColor="#d1fae5"}>
                            <span style={{fontSize:20}}>🤖</span>
                            <div style={{textAlign:"left"}}>
                              <div style={{fontSize:12,fontWeight:600,color:"#1e293b"}}>Claude MCP folder</div>
                              <div style={{fontSize:10,color:"#6b7280",marginTop:1}}>Saves to .claude/ subfolder</div>
                            </div>
                          </button>
                          <button onClick={()=>saveToWorkspace(f)}
                            style={{flex:1,display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:10,border:"1.5px solid #d1fae5",background:"#fff",cursor:"pointer",fontFamily:"Inter,sans-serif",transition:"all .15s"}}
                            onMouseEnter={e=>e.currentTarget.style.borderColor="#10b981"}
                            onMouseLeave={e=>e.currentTarget.style.borderColor="#d1fae5"}>
                            <span style={{fontSize:20}}>📁</span>
                            <div style={{textAlign:"left"}}>
                              <div style={{fontSize:12,fontWeight:600,color:"#1e293b"}}>Custom folder</div>
                              <div style={{fontSize:10,color:"#6b7280",marginTop:1}}>Pick any location</div>
                            </div>
                          </button>
                        </div>
                        <div style={{background:"#f0fdf4",padding:"0 18px 12px",display:"flex",alignItems:"center",gap:6}}>
                          <span style={{color:"#f59e0b",fontSize:12}}>⚡</span>
                          <span style={{fontSize:10.5,color:"#6b7280"}}>"Open in VS Code" requires VS Code installed. "Save to folder" requires Chrome or Edge.</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Preview panel */}
                  {open&&(
                    <div style={{padding:"0 18px 16px"}}>
                      <div style={{display:"flex",gap:6,marginBottom:4}}>
                        <button className={`btn ${previewMode==="rendered"?"btn-outline":"btn-ghost"}`} onClick={()=>setPreviewMode("rendered")} style={{padding:"4px 10px",fontSize:11}}>Rendered</button>
                        <button className={`btn ${previewMode==="raw"?"btn-outline":"btn-ghost"}`} onClick={()=>setPreviewMode("raw")} style={{padding:"4px 10px",fontSize:11}}>Raw</button>
                      </div>
                      {previewMode==="rendered"
                        ? <div className="md-body" style={{background:"var(--bg)",border:"1px solid var(--border)",borderRadius:10}} dangerouslySetInnerHTML={renderMd(f.content)}/>
                        : <pre className="pre">{f.content}</pre>}
                    </div>
                  )}
                </div>
              );
            })}

            {filtered.length > visibleCount && (
              <div style={{textAlign:"center",padding:"16px 0"}}>
                <button className="btn btn-outline" onClick={()=>setVisibleCount(v=>v+PAGE_SIZE)}>
                  Load more ({filtered.length - visibleCount} remaining)
                </button>
              </div>
            )}

            {files.length>0&&(
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:"1px solid var(--border2)",paddingTop:14,marginTop:8}}>
                <span style={{fontSize:12,color:"var(--text4)"}}>{filtered.length} file{filtered.length!==1?"s":""} · {uniq} contributor{uniq!==1?"s":""}</span>
                <button className="btn btn-outline" onClick={()=>setTab("upload")}>+ Upload yours</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Modal open={!!editModal} onClose={()=>setEditModal(null)} title={`Edit: ${editModal?.title||editModal?.filename||""}`}>
        <div style={{marginBottom:14}}>
          <span className="lbl">Title</span>
          <input className="field" value={editData.title||""} onChange={e=>setEditData(d=>({...d,title:e.target.value}))}/>
        </div>
        <div style={{marginBottom:14}}>
          <span className="lbl">Description</span>
          <textarea className="field" value={editData.description||""} onChange={e=>setEditData(d=>({...d,description:e.target.value}))} rows={2} style={{resize:"vertical",lineHeight:1.6}}/>
        </div>
        <div style={{marginBottom:14}}>
          <span className="lbl">Folder</span>
          <input className="field" value={editData.folder||""} onChange={e=>setEditData(d=>({...d,folder:e.target.value}))}/>
        </div>
        <div style={{marginBottom:14}}>
          <span className="lbl">Category</span>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {CATEGORIES.map(cat=>{
              const active = editData.category===cat.id;
              return (
                <button key={cat.id} type="button" onClick={()=>setEditData(d=>({...d,category:active?"":cat.id}))}
                  style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:20,
                    border:`1.5px solid ${active?cat.c:cat.border}`,background:active?cat.bg:"var(--card)",
                    color:active?cat.c:"var(--text3)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>
                  <span>{cat.icon}</span>{cat.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{marginBottom:18}}>
          <span className="lbl">Tags</span>
          <TagInput tags={editData.tags||[]} onChange={tags=>setEditData(d=>({...d,tags}))}/>
        </div>
        <div style={{marginBottom:18}}>
          <span className="lbl">Replace .md file</span>
          <div style={{border:"1.5px dashed var(--border)",borderRadius:10,padding:16,textAlign:"center",cursor:"pointer",transition:"all .15s",
            background:editData.replaceFile?"var(--green-bg)":"var(--bg)",borderColor:editData.replaceFile?"var(--green-border)":"var(--border)"}}
            onClick={()=>editFileRef.current.click()}
            onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor="var(--blue)";e.currentTarget.style.background="var(--blue-bg)";}}
            onDragLeave={e=>{e.currentTarget.style.borderColor=editData.replaceFile?"var(--green-border)":"var(--border)";e.currentTarget.style.background=editData.replaceFile?"var(--green-bg)":"var(--bg)";}}
            onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor=editData.replaceFile?"var(--green-border)":"var(--border)";e.currentTarget.style.background=editData.replaceFile?"var(--green-bg)":"var(--bg)";pickReplaceFile(e.dataTransfer.files[0]);}}>
            {editData.replaceFile?(
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
                <span style={{fontSize:20}}>📄</span>
                <div style={{textAlign:"left"}}>
                  <p style={{margin:0,fontSize:12,fontWeight:600,color:"var(--text)"}}>{editData.replaceFile.name}</p>
                  <p style={{margin:"2px 0 0",fontSize:11,color:"var(--text3)"}}>
                    {(editData.replaceFile.size/1024).toFixed(1)} KB ·{" "}
                    <span style={{color:"var(--red)",cursor:"pointer"}} onClick={e=>{e.stopPropagation();setEditData(d=>({...d,replaceFile:null}));editFileRef.current.value="";}}>Remove</span>
                  </p>
                </div>
              </div>
            ):(
              <div>
                <p style={{fontSize:12,fontWeight:500,color:"var(--text3)",margin:0}}>Drop a new .md file here or click to browse</p>
                <p style={{fontSize:10,color:"var(--text4)",margin:"4px 0 0"}}>Optional — leave empty to keep current file</p>
              </div>
            )}
          </div>
          <input ref={editFileRef} type="file" accept=".md" style={{display:"none"}} onChange={e=>pickReplaceFile(e.target.files[0])}/>
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button className="btn btn-ghost" onClick={()=>setEditModal(null)}>Cancel</button>
          <button className="btn btn-blue" onClick={saveEdit} disabled={saving}>{saving?"Saving…":"Save changes"}</button>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal open={!!deleteModal} onClose={()=>setDeleteModal(null)} title="Delete file" width={420}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{width:48,height:48,borderRadius:"50%",background:"var(--red-bg)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:12,border:"1.5px solid var(--red-border)"}}>🗑️</div>
          <p style={{fontSize:14,fontWeight:600,color:"var(--text)",marginBottom:4}}>Delete "{deleteModal?.title||deleteModal?.filename}"?</p>
          <p style={{fontSize:12,color:"var(--text3)"}}>This action cannot be undone.</p>
        </div>
        <div style={{marginBottom:16}}>
          <span className="lbl">Enter password to confirm</span>
          <input className="field" type="password" value={deletePwd} onChange={e=>setDeletePwd(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter")deleteFile();}} placeholder="Delete password" autoFocus/>
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button className="btn btn-ghost" onClick={()=>setDeleteModal(null)}>Cancel</button>
          <button className="btn btn-red" onClick={deleteFile} disabled={!deletePwd||deleting}>{deleting?"Deleting…":"Delete"}</button>
        </div>
      </Modal>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<ErrorBoundary><App/></ErrorBoundary>);
