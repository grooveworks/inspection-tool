window.gapi = { load: (n, cb) => {
  window.google = window.google || {};
  google.picker = { ViewId:{DOCS:1}, Action:{PICKED:"picked",CANCEL:"cancel"},
    DocsView: function(){ this.setMimeTypes=()=>this; this.setIncludeFolders=()=>this; },
    PickerBuilder: function(){ const b=this; let cb; ["setAppId","setDeveloperKey","setOAuthToken","setLocale","addView","setTitle"].forEach(k=>b[k]=()=>b);
      b.setCallback=f=>{cb=f;return b}; b.build=()=>({ setVisible:()=>setTimeout(()=>cb({action:"picked",docs:[{id:"FILE123",name:"CENTER_CASING.pdf"}]}),10) }); } };
  cb(); } };
