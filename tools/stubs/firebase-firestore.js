// firebase-firestore-compat stub: in-memory "cloud" seeded from window.__fsSeed; records calls in __fsStore.calls
(function(){
  const S = window.__fsStore = { docs: JSON.parse(JSON.stringify(window.__fsSeed || [])), sdkDelay: window.__sdkDelay || 0, calls: [] };
  const copy = v => JSON.parse(JSON.stringify(v)), wait = ms => new Promise(r => setTimeout(r, ms));
  firebase.firestore = () => ({ collection: () => ({
    orderBy: () => ({ get: async () => { S.calls.push("sdk-list"); await wait(S.sdkDelay);
      return { docs: S.docs.filter(d => typeof d.updatedAt === "number").sort((a,b) => b.updatedAt - a.updatedAt).map(d => ({ id: d.id, data: () => copy(d) })) }; } }),
    doc: id => ({
      get: async () => { const d = S.docs.find(x => x.id === id); return { exists: !!d, id, data: () => copy(d) }; },
      set: async v => { S.calls.push("set:" + id); const i = S.docs.findIndex(x => x.id === id); if (i >= 0) S.docs[i] = copy(v); else S.docs.push(copy(v)); },
      delete: async () => { S.calls.push("delete:" + id); S.docs = S.docs.filter(x => x.id !== id); },
      onSnapshot: () => () => {}
    })
  }) });
})();
