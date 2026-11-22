// firebase-auth-compat stub: signed-in user comes from localStorage "__stubAuth" (persists like real Auth);
// signInWithCredential signs in as window.__stubLoginEmail (default info-manager@groove-works.jp)
(function(){
  const KEY = "__stubAuth", get = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch(e){ return null; } };
  let user = get(); const subs = [];
  const set = u => { user = u; if (u) localStorage.setItem(KEY, JSON.stringify(u)); else localStorage.removeItem(KEY); subs.forEach(f => f(u)); };
  const A = {
    get currentUser(){ return user; },
    onAuthStateChanged(cb){ subs.push(cb); setTimeout(() => cb(user), 5); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
    async signInWithCredential(c){ window.__credToken = c && c.accessToken; const u = { email: window.__stubLoginEmail || "info-manager@groove-works.jp" }; set(u); return { user: u }; },
    async signOut(){ set(null); }
  };
  firebase.auth = () => A;
  firebase.auth.GoogleAuthProvider = { credential: (idToken, accessToken) => ({ idToken, accessToken }) };
})();
