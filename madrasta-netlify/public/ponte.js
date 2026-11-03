// Ponte entre a página do almoxarifado e o banco no Netlify (/api/dados).
// Oferece à página o mesmo jeito de usar que ela tem dentro do Claude: claude.use("db" | "user" | "downloads").
(() => {
  "use strict";
  const API = "/api/dados";
  const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } };
  const ouvintes = [];   // { col, next }
  let rev = "", cache = {}, timer = 0, pronto = null;

  // ---- janelinha para pedir nome e código ----
  function pedir(titulo, texto, rotulo, tipo) {
    return new Promise(res => {
      const bg = document.createElement("div");
      bg.className = "modal-bg";
      bg.innerHTML = `<form class="modal" style="max-width:420px"><h3></h3><p style="margin:0;color:var(--muted)"></p>
        <label class="field"><span></span><input id="ponteCampo" type="${tipo}" autocomplete="off" required maxlength="40"></label>
        <div class="modal-actions"><button class="btn primary" type="submit">Entrar</button></div></form>`;
      bg.querySelector("h3").textContent = titulo;
      bg.querySelector("p").textContent = texto;
      bg.querySelector("label span").textContent = rotulo;
      const f = bg.querySelector("form"), inp = bg.querySelector("input");
      f.addEventListener("submit", e => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; bg.remove(); res(v); });
      document.body.append(bg); setTimeout(() => inp.focus(), 30);
    });
  }
  async function chamar(metodo, corpo) {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const r = await fetch(API + (metodo === "GET" ? "?rev=" + encodeURIComponent(rev) : ""), {
        method: metodo, headers: { "content-type": "application/json", "x-codigo": LS("madrasta.codigo") || "" }, body: corpo ? JSON.stringify(corpo) : undefined,
      });
      if (r.status === 401) {
        LS("madrasta.codigo", null);
        LS("madrasta.codigo", await pedir("Código da bateria", tentativa ? "Esse código não confere. Tente de novo." : "Este almoxarifado é só da Bateria Madrasta. Digite o código que a diretoria passou.", "Código", "password"));
        continue;
      }
      if (!r.ok) throw { code: r.status === 404 ? "invalid_argument" : "unavailable", message: "HTTP " + r.status };
      return r.json();
    }
    throw { code: "invalid_argument", message: "código" };
  }
  // ---- leitura: busca o estado quando algo mudou e avisa quem está ouvindo ----
  const snap = col => {
    const docs = (cache[col] || []).map(d => ({ id: d.id, exists: true, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  };
  async function atualizar() {
    const r = await chamar("GET");
    if (!r.igual) {
      cache = { itens: r.itens, demandas: r.demandas, manutencoes: r.manutencoes, historico: r.historico };
      rev = r.rev;
      ouvintes.forEach(o => o.next(snap(o.col)));
    }
  }
  const atualizarDepois = () => { clearTimeout(timer); timer = setTimeout(() => atualizar().catch(() => {}), 150); };
  setInterval(() => { if (document.visibilityState === "visible") atualizar().catch(() => {}); }, 5000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") atualizarDepois(); });

  const gravar = (col, id, op, data) => chamar("POST", { col, id, op, data }).then(() => atualizarDepois());
  const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function colecao(col) {
    const q = {
      where: () => ({ limit: () => ({ get: async () => snap("__nada") }) }),   // a limpeza do histórico acontece no servidor
      orderBy: () => q, limit: () => q,
      get: async () => snap(col),
      onSnapshot(next) { const o = { col, next }; ouvintes.push(o); if (cache[col]) setTimeout(() => next(snap(col)), 0); return () => { const i = ouvintes.indexOf(o); if (i >= 0) ouvintes.splice(i, 1); }; },
      doc: id => { id = id || novoId(); return { id, path: col + "/" + id, set: d => gravar(col, id, "set", d), update: d => gravar(col, id, "update", d), delete: () => gravar(col, id, "delete") }; },
    };
    return q;
  }
  const db = { collection: colecao };

  // ---- quem está usando: o nome que a pessoa digita (aparece no histórico) ----
  const iniciais = nome => {
    const ini = (nome || "?").split(/\s+/).map(p => p[0]).join("").slice(0, 2).toUpperCase();
    let h = 0; for (const c of nome || "") h = (h * 31 + c.charCodeAt(0)) % 360;
    return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><circle cx="13" cy="13" r="13" fill="hsl(${h} 55% 38%)"/><text x="13" y="17.5" font-family="sans-serif" font-size="11" font-weight="700" text-anchor="middle" fill="#fff">${ini.replace(/[<&>]/g, "")}</text></svg>`);
  };
  let nome = LS("madrasta.nome");
  const user = {
    me: async () => ({ id: nome, name: nome, avatarUrl: iniciais(nome), color: "#ff6a13", email: null, isOwner: false, canEdit: true }),
    id: async () => nome, name: async () => nome, isOwner: async () => false, canEdit: async () => true, can: async () => true,
    profiles: async ids => Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: i, avatarUrl: iniciais(i), color: "#ff6a13", email: null, isMe: i === nome, guest: false }])),
    search: async () => [],
  };
  // ---- baixar planilha ----
  const downloads = {
    save: async ({ filename, data }) => {
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "text/csv;charset=utf-8" })); a.download = filename;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      return { status: "saved" };
    },
  };

  async function preparar() {
    if (!nome) { nome = await pedir("Bem-vindo ao almoxarifado", "Seu nome aparece no histórico ao lado do que você mudar.", "Seu nome", "text"); LS("madrasta.nome", nome); }
    await atualizar();
  }
  window.claude = {
    use: async qual => {
      if (!pronto) pronto = preparar().then(() => true, () => false);
      const ok = await pronto;
      if (qual === "db") return ok ? db : null;
      if (qual === "user") return user;
      if (qual === "downloads") return downloads;
      return null;
    },
  };
})();
