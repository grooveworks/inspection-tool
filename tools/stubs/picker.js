window.gapi = { load: (n, cb) => {
  window.google = window.google || {};
  window.__pickerView = {};   // records how the view was configured (checked by verify.js)
  google.picker = { ViewId:{DOCS:1}, Action:{PICKED:"picked",CANCEL:"cancel"}, DocsViewMode:{LIST:"list",GRID:"grid"},
    DocsView: function(){ const v = window.__pickerView;
      this.setMimeTypes=m=>{v.mime=m;return this}; this.setIncludeFolders=f=>{v.folders=f;return this};
      this.setMode=m=>{v.mode=m;return this}; this.setQuery=q=>{v.query=q;return this}; this.setParent=p=>{v.parent=p;return this}; },
    PickerBuilder: function(){ const b=this; let cb; ["setAppId","setDeveloperKey","setOAuthToken","setLocale","addView","setTitle"].forEach(k=>b[k]=()=>b);
      b.setCallback=f=>{cb=f;return b}; b.build=()=>({ setVisible:()=>setTimeout(()=>cb({action:"picked",docs:[{id:"FILE123",name:"CENTER_CASING.pdf"}]}),10) }); } };
  cb(); } };
