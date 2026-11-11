// Seguidor da apresentação inteira pelo som do ensaio.
// Ouvido: transforma o som do microfone em "ataques" por faixa (graves, médios-graves, médios, agudos) a cada 10 ms.
// Seguidor: compara os ataques dos últimos segundos com os da gravação de referência da apresentação (ref.bin) e diz
// em que ponto dela a bateria está, em que andamento, se parou e de onde voltou.
(function (root) {
  const FPS = 100, NB = 4, N = 1024, BANDAS = [[40, 190], [190, 700], [700, 2800], [2800, 9000]];

  // ---------- Ouvido ----------
  function Ouvido(sr) {
    const S = this; S.sr = sr; S.hop = sr / FPS; S.buf = new Float32Array(N * 8); S.n0 = 0; S.len = 0; S.nq = 0;
    S.win = new Float32Array(N); for (let i = 0; i < N; i++) S.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    S.re = new Float32Array(N); S.im = new Float32Array(N);
    S.cos = new Float32Array(N / 2); S.sin = new Float32Array(N / 2); for (let i = 0; i < N / 2; i++) { S.cos[i] = Math.cos(2 * Math.PI * i / N); S.sin[i] = Math.sin(2 * Math.PI * i / N); }
    S.rev = new Uint16Array(N); for (let i = 0, b = Math.log2(N); i < N; i++) { let r = 0; for (let k = 0; k < b; k++) r |= ((i >> k) & 1) << (b - 1 - k); S.rev[i] = r; }
    S.lim = BANDAS.map(([a, b]) => [Math.ceil(a * N / sr), Math.ceil(b * N / sr)]);   // bins com a <= freq < b
    S.ema = new Float64Array(NB); S.hist = [new Float64Array(NB), new Float64Array(NB), new Float64Array(NB)]; S.aS = 1 - Math.exp(-1 / 30); S.aD = 1 - Math.exp(-1 / 400);
  }
  // x: Float32Array com o som; quadro(q0, q1, q2, q3, nivel) é chamado para cada 10 ms prontos
  Ouvido.prototype.alimenta = function (x, quadro) {
    const S = this;
    if (S.len + x.length > S.buf.length) { const nb = new Float32Array(Math.max(S.buf.length * 2, S.len + x.length + N)); nb.set(S.buf.subarray(0, S.len)); S.buf = nb; }
    S.buf.set(x, S.len); S.len += x.length;
    for (;;) {
      const ini = Math.round(S.nq * S.hop) - S.n0;
      if (ini + N > S.len) break;
      const re = S.re, im = S.im, rev = S.rev, win = S.win, buf = S.buf;
      for (let i = 0; i < N; i++) { re[rev[i]] = buf[ini + i] * win[i]; im[rev[i]] = 0; }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = S.cos[k], s = -S.sin[k], a = i + j, b = a + half, tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      const q = [0, 0, 0, 0]; let niv = 0; const h3 = S.hist[S.nq % 3];
      for (let b = 0; b < NB; b++) {
        let e = 0; for (let k = S.lim[b][0]; k < S.lim[b][1]; k++) e += re[k] * re[k] + im[k] * im[k];
        const m = Math.sqrt(Math.sqrt(e)); niv += m;
        S.ema[b] = S.nq ? S.ema[b] + (m > S.ema[b] ? S.aS : S.aD) * (m - S.ema[b]) : m;   // sobe depressa, desce devagar
        const v = m / (S.ema[b] + 1e-4), d = S.nq >= 3 ? Math.max(0, v - h3[b]) : 0;   // subida em 30 ms
        h3[b] = v; q[b] = Math.round(Math.min(d, 3) * 85);
      }
      S.nq++; quadro(q[0], q[1], q[2], q[3], niv);
      if (ini > N * 4) { S.buf.copyWithin(0, ini, S.len); S.len -= ini; S.n0 += ini; }
    }
  };

  // ---------- Ouvido pelos surdos ----------
  // Escuta só os graves (30–400 Hz). A cada 10 ms mede o que SUBIU no espectro (ataque) e reparte entre os moldes de som
  // da 1ª, da 2ª e da 3ª (aprendidos com `aprende`, batendo em cada surdo sozinho). Saída por quadro: [1ª, 2ª, 3ª, total],
  // cada um dividido pelo seu pico recente (0..255). Sem moldes, só o total (as batidas graves) é usado.
  const NS = 4096, LAGS = 5, G0 = 30, GP = 5, NG = 75;
  function fftS(S, buf, ini) {
    const re = S.re, im = S.im, rev = S.rev, win = S.win;
    for (let i = 0; i < NS; i++) { re[rev[i]] = buf[ini + i] * win[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= NS; size <<= 1) { const half = size >> 1, step = NS / size;
      for (let i = 0; i < NS; i += size) for (let j = 0, k = 0; j < half; j++, k += step) { const c = S.cos[k], sn = -S.sin[k], a = i + j, b = a + half, tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  }
  function OuvidoSurdos(sr, moldes) {
    const S = this; S.sr = sr; S.hop = sr / FPS; S.buf = new Float32Array(NS * 4); S.n0 = 0; S.len = 0; S.nq = 0;
    S.win = new Float32Array(NS); for (let i = 0; i < NS; i++) S.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NS);
    S.re = new Float32Array(NS); S.im = new Float32Array(NS); S.cos = new Float32Array(NS / 2); S.sin = new Float32Array(NS / 2);
    for (let i = 0; i < NS / 2; i++) { S.cos[i] = Math.cos(2 * Math.PI * i / NS); S.sin[i] = Math.sin(2 * Math.PI * i / NS); }
    S.rev = new Uint16Array(NS); for (let i = 0, b = Math.log2(NS); i < NS; i++) { let r = 0; for (let k = 0; k < b; k++) r |= ((i >> k) & 1) << (b - 1 - k); S.rev[i] = r; }
    S.kmax = Math.floor(420 * NS / sr) + 2; S.mag = new Float32Array(S.kmax); S.k40 = Math.floor(40 * NS / sr); S.k9k = Math.floor(9000 * NS / sr);
    S.hist = []; for (let i = 0; i < LAGS; i++) S.hist.push(new Float32Array(NG)); S.M = new Float32Array(NG); S.D = new Float32Array(NG);
    S.pk = [0, 0, 0, 0]; S.lg = [0, 0, 0, 0]; S.d1 = Math.exp(-1 / 600); S.d2 = Math.exp(-1 / 6000);
    S.guarda = null;   // durante a calibração, guarda o espectro de cada quadro
    S.poeMoldes(moldes);
  }
  // moldes: [1ª, 2ª, 3ª], cada um um vetor de 75 números (ou null se não foi ensinado)
  OuvidoSurdos.prototype.poeMoldes = function (moldes) {
    const S = this; S.T = []; S.ix = [];
    (moldes || []).forEach((t, k) => { if (t && t.length === NG) { S.T.push(Float64Array.from(t)); S.ix.push(k); } });
    const K = S.T.length; S.G = []; for (let i = 0; i < K; i++) { S.G.push([]); for (let j = 0; j < K; j++) { let g = 0; for (let b = 0; b < NG; b++) g += S.T[i][b] * S.T[j][b]; S.G[i].push(g); } }
    // inversas de G para cada subconjunto de moldes (no máximo 7)
    S.sub = [];
    for (let m = 1; m < (1 << K); m++) { const ix = []; for (let k = 0; k < K; k++) if (m >> k & 1) ix.push(k); S.sub.push({ ix, inv: inversa(ix.map(i => ix.map(j => S.G[i][j] + (i === j ? 1e-9 : 0)))) }); }
  };
  function inversa(A) {
    const n = A.length, M = A.map((r, i) => r.concat(r.map((_, j) => i === j ? 1 : 0)));
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; } }
    return M.map(r => r.slice(n));
  }
  OuvidoSurdos.prototype.alimenta = function (x, quadro) {
    const S = this;
    if (S.len + x.length > S.buf.length) { const nb = new Float32Array(Math.max(S.buf.length * 2, S.len + x.length + NS)); nb.set(S.buf.subarray(0, S.len)); S.buf = nb; }
    S.buf.set(x, S.len); S.len += x.length;
    for (;;) {
      const ini = Math.round(S.nq * S.hop) - S.n0; if (ini + NS > S.len) break;
      fftS(S, S.buf, ini);
      const re = S.re, im = S.im; let e = 0; for (let k = S.k40; k < S.k9k; k++) e += re[k] * re[k] + im[k] * im[k];
      const niv = Math.sqrt(Math.sqrt(e)), mag = S.mag, df = S.sr / NS; for (let k = 0; k < S.kmax; k++) mag[k] = Math.fround(Math.hypot(re[k], im[k]));
      const M = S.M, D = S.D, ant = S.hist[S.nq % LAGS]; let tot = 0;
      for (let b = 0; b < NG; b++) { const f = (G0 + GP * b) / df, k = Math.floor(f), w = f - k; M[b] = Math.fround(mag[k] + (mag[k + 1] - mag[k]) * w); D[b] = S.nq >= LAGS ? Math.max(0, M[b] - ant[b]) : 0; tot += D[b]; }
      if (S.guarda) S.guarda.push(Float32Array.from(M));
      ant.set(M);
      // reparte o ataque entre os moldes (mínimos quadrados sem valores negativos: testa os subconjuntos)
      const a = [0, 0, 0, tot / Math.sqrt(NG)], K = S.T.length;
      if (K && tot > 0) {
        const bb = new Array(K); let dd = 0; for (let b = 0; b < NG; b++) dd += D[b] * D[b];
        for (let i = 0; i < K; i++) { let v = 0; for (let b = 0; b < NG; b++) v += D[b] * S.T[i][b]; bb[i] = v; }
        let best = null, berr = Infinity;
        for (const sb of S.sub) { const n = sb.ix.length, sol = new Array(n); let ok = true;
          for (let i = 0; i < n; i++) { let v = 0; for (let j = 0; j < n; j++) v += sb.inv[i][j] * bb[sb.ix[j]]; sol[i] = v; if (v < 0) ok = false; }
          if (!ok) continue; let err = dd; for (let i = 0; i < n; i++) { err -= 2 * sol[i] * bb[sb.ix[i]]; for (let j = 0; j < n; j++) err += sol[i] * S.G[sb.ix[i]][sb.ix[j]] * sol[j]; }
          if (err < berr) { berr = err; best = [sb, sol]; } }
        if (best) best[0].ix.forEach((i, j) => { a[S.ix[i]] = best[1][j]; });
      }
      const q = [0, 0, 0, 0]; for (let b = 0; b < 4; b++) { S.pk[b] = Math.max(S.pk[b] * S.d1, a[b]); S.lg[b] = Math.max(S.lg[b] * S.d2, a[b]); q[b] = Math.round(Math.min(a[b] / (Math.max(S.pk[b], 0.1 * S.lg[b]) + 1e-9), 1) * 255); }
      S.nq++; quadro(q[0], q[1], q[2], q[3], niv, a[3]);
      if (ini > NS * 2) { S.buf.copyWithin(0, ini, S.len); S.len -= ini; S.n0 += ini; }
    }
  };
  // aprende o som de um surdo: `x` é uma gravação com alguns toques só dele. Devolve { molde, toques, hz } ou null.
  OuvidoSurdos.aprende = function (x, sr) {
    const o = new OuvidoSurdos(sr, []), tot = []; o.guarda = [];
    for (let a = 0; a < x.length; a += 4096) o.alimenta(x.subarray(a, Math.min(x.length, a + 4096)), (q0, q1, q2, q3, niv, t) => tot.push(t));
    const mx = tot.reduce((p, v) => Math.max(p, v), 0); if (!(mx > 0)) return null;
    const picos = []; for (let n = 4; n < tot.length - 8; n++) if (tot[n] >= 0.35 * mx && tot[n] >= tot[n - 1] && tot[n] > tot[n + 1] && (!picos.length || n - picos[picos.length - 1] > 20)) picos.push(n);
    if (!picos.length) return null;
    const t = new Float64Array(NG);
    for (const n of picos) { const d = new Float64Array(NG); let nr = 0; for (let b = 0; b < NG; b++) { d[b] = Math.max(0, o.guarda[n + 7][b] - o.guarda[n - 3][b]); nr += d[b] * d[b]; } nr = Math.sqrt(nr) + 1e-9; for (let b = 0; b < NG; b++) t[b] += d[b] / nr; }
    let nr = 0, im = 0; for (let b = 0; b < NG; b++) { nr += t[b] * t[b]; if (t[b] > t[im]) im = b; } nr = Math.sqrt(nr) + 1e-9;
    return { molde: Array.from(t, v => +(v / nr).toFixed(5)), toques: picos.length, hz: G0 + GP * im };
  };

  // ---------- Seguidor ----------
  // ref: Uint8Array [quadros x 4] da gravação de referência; secs: inícios dos trechos (s); dur: duração (s)
  // op: { pesos: [p0,p1,p2,p3] (peso de cada faixa; 0 = ignora), pulso: índice da faixa usada para o pulso (ou -1 = todas) }
  function Seguidor(ref0, secs, dur, tatum, op) {
    const S = this; S.pesos = (op && op.pesos) || [1, 1, 1, 1]; S.bPulso = op && op.pulso != null ? op.pulso : -1;
    const ref = new Uint8Array(ref0.length); for (let i = 0; i < ref0.length; i++) ref[i] = Math.round(ref0[i] * S.pesos[i % NB]); S.nR = Math.floor(ref.length / NB); S.dur = dur || S.nR / FPS; S.secs = secs.slice().sort((a, b) => a - b);
    S.R = new Float32Array(S.nR * NB);   // referência com folga de ±10 ms
    for (let r = 0; r < S.nR; r++) for (let k = 0; k < NB; k++) S.R[r * NB + k] = Math.max(ref[r * NB + k], r > 0 ? ref[(r - 1) * NB + k] : 0, r + 1 < S.nR ? ref[(r + 1) * NB + k] : 0);
    S.e2 = new Float64Array(S.nR + 1); for (let r = 0; r < S.nR; r++) { const b = r * NB; S.e2[r + 1] = S.e2[r] + S.R[b] * S.R[b] + S.R[b + 1] * S.R[b + 1] + S.R[b + 2] * S.R[b + 2] + S.R[b + 3] * S.R[b + 3]; }
    S.atv = new Float32Array(S.nR + 1); for (let r = 0; r < S.nR; r++) S.atv[r + 1] = S.atv[r] + ref[r * NB] + ref[r * NB + 1] + ref[r * NB + 2] + ref[r * NB + 3];
    // versão grossa (20 ms, 4 faixas, folga de ±20 ms) para procurar na música inteira
    S.nC = Math.floor(S.nR / 2); const cr = new Float32Array(S.nC * NB); for (let i = 0; i < S.nC; i++) for (let k = 0; k < NB; k++) cr[i * NB + k] = ref[i * 2 * NB + k] + ref[(i * 2 + 1) * NB + k];
    S.Rc = new Float32Array(S.nC * NB); S.c1 = new Float64Array((S.nC + 1) * NB); S.c2 = new Float64Array((S.nC + 1) * NB);
    for (let i = 0; i < S.nC; i++) for (let k = 0; k < NB; k++) { const v = Math.max(cr[i * NB + k], i > 0 ? cr[(i - 1) * NB + k] : 0, i + 1 < S.nC ? cr[(i + 1) * NB + k] : 0); S.Rc[i * NB + k] = v; S.c1[(i + 1) * NB + k] = S.c1[i * NB + k] + v; S.c2[(i + 1) * NB + k] = S.c2[i * NB + k] + v * v; }
    S.tatum = tatum || null;
    S.cap = 1600; S.live = new Uint8Array(S.cap * NB); S.zera();
  }
  const P = Seguidor.prototype;
  P.zera = function () {
    Object.assign(this, { nq: 0, lock: null, prov: 0, ult: null, forcado: null, f: 1, cand: null, baixa: 0, jaTravou: false, estado: "ouvindo", conf: 0,
      alto: 0, med: 0, temSom: false, tMus: 0, tForte: 0, eraForte: true, provLug: [], provAt: null, provOk: false, rev: null, tRev: -1e9, ultSom: 0, alt: false, calado: true, tVolta: null, tBusca: -1e9, tDir: -1e9, fim: false, tap: null });
  };
  P.agora = function () { return this.nq / FPS; };
  P.pos = function (t) { const L = this.lock; return L ? L.p + (t - L.t) * L.f : null; };
  P.quadro = function (q0, q1, q2, q3, niv) {
    const S = this, a = (S.nq % S.cap) * NB, w = S.pesos; S.live[a] = q0 * w[0]; S.live[a + 1] = q1 * w[1]; S.live[a + 2] = q2 * w[2]; S.live[a + 3] = q3 * w[3];
    // Tem bateria tocando? Depois que ela já tocou, basta o volume: perto do mais alto recente = tocando. Antes disso o
    // "mais alto" é só o ruído da sala, então espera uma ENTRADA: o volume saltar para mais de 3x a média do último
    // segundo e meio (ou, em passo(), ouvir um pulso regular, para quando o celular é ligado com a bateria já tocando).
    S.alto = Math.max(S.alto * 0.99995, niv);
    const t = S.nq / FPS, forte = niv > 0.35 * S.alto && niv > 1e-6, salto = S.nq > 150 && niv > 3 * S.med && niv > 1e-6;
    S.med += (niv - S.med) / 150;
    if ((forte && !S.eraForte && t - S.tForte > 0.8) || (salto && !S.temSom)) { if (S.calado) S.tVolta = t; S.temSom = true; }   // voltou depois de pelo menos 0,8 s baixo
    if (forte) S.tForte = t; S.eraForte = forte;
    if (forte && S.temSom) { S.ultSom = t; S.calado = false; } else if (!S.temSom || t - S.ultSom > 1.2) S.calado = true;
    S.nq++;
  };
  P.inicioDoTrecho = function (p) { let s = this.secs[0]; for (const x of this.secs) if (x <= p + 0.05) s = x; return s; };
  // primeiro ataque forte da referência a partir de p (os trechos podem começar com contagem)
  P.primeiroAtaque = function (p) { for (let r = Math.max(0, Math.round(p * FPS) - 5); r < this.nR - 1; r++) if (this.atv[r + 1] - this.atv[r] >= 150) return r / FPS - 0.02; return p; };
  P.ativRef = function (p0, p1) { const a = Math.max(0, Math.min(this.nR, Math.round(p0 * FPS))), b = Math.max(a, Math.min(this.nR, Math.round(p1 * FPS))); return b > a ? (this.atv[b] - this.atv[a]) / (b - a) : 0; };

  // janela ao vivo: os quadros com ataque dos últimos nW quadros (para comparar depressa com muitos lugares)
  P.janela = function (nW, fim) {
    const S = this, n1 = fim != null ? Math.min(S.nq, fim) : S.nq, n0 = Math.max(0, n1 - nW), idx = [], val = []; let e = 0;
    for (let n = n0; n < n1; n++) { const a = (n % S.cap) * NB, l = S.live; if (l[a] + l[a + 1] + l[a + 2] + l[a + 3] < 24) continue; idx.push(n1 - n); val.push(l[a], l[a + 1], l[a + 2], l[a + 3]); e += l[a] * l[a] + l[a + 1] * l[a + 1] + l[a + 2] * l[a + 2] + l[a + 3] * l[a + 3]; }
    return { idx, val, e, n: n1 - n0 };
  };
  // semelhança (0 a 1) entre a janela e a referência, se o fim da janela estiver em pE com andamento f
  P.sim = function (J, pE, f) {
    const S = this, R = S.R, idx = J.idx, val = J.val, nR = S.nR; let dot = 0, eR = 0;
    const r1 = Math.round(pE * FPS), r0 = Math.round((pE - J.n / FPS * f) * FPS);
    if (r0 < -50 || r1 > nR + 50) return 0;
    for (let i = 0, k = 0; i < idx.length; i++, k += 4) { const r = Math.round((pE - idx[i] / FPS * f) * FPS); if (r < 0 || r >= nR) continue; const b = r * NB; dot += val[k] * R[b] + val[k + 1] * R[b + 1] + val[k + 2] * R[b + 2] + val[k + 3] * R[b + 3]; }
    // energia da referência no trecho todo (inclui o que a referência toca e o ensaio não tocou)
    const a = Math.max(0, r0), b = Math.min(nR, r1); if (b > a) eR = S.e2[b] - S.e2[a];
    return dot / Math.sqrt(J.e * eR + 1e-9);
  };
  // melhor ajuste perto de (pE, f): desloca até ±dpMax e muda o andamento até ±dfMax
  P.ajuste = function (J, pE, f, dpMax, dpPasso, dfMax, dfPasso) {
    let best = { c: -1, p: pE, f };
    for (let df = -dfMax; df <= dfMax + 1e-9; df += dfPasso) for (let dp = -dpMax; dp <= dpMax + 1e-9; dp += dpPasso) {
      const c = this.sim(J, pE + dp, f * (1 + df)) - 0.02 * Math.abs(dp) / (dpMax || 1) - 0.01 * Math.abs(df) / (dfMax || 1);
      if (c > best.c) best = { c, p: pE + dp, f: f * (1 + df) };
    }
    return best;
  };

  // pulso mais forte dos ataques (a "semicolcheia") nos últimos nW quadros: o maior período com coerência >= 85% da máxima
  P.pulso = function (nW, fim) {
    const S = this, n1 = fim != null ? Math.min(S.nq, fim) : S.nq, n0 = Math.max(0, n1 - nW), o = new Float32Array(n1 - n0);
    for (let n = n0; n < n1; n++) { const a = (n % S.cap) * NB; o[n - n0] = S.bPulso >= 0 ? S.live[a + S.bPulso] : S.live[a] + S.live[a + 1] + S.live[a + 2] + S.live[a + 3]; }
    return pulsoDe(o);
  };
  function pulsoDe(o) {
    const c = new Float64Array(301); let mx = 0;
    for (let i = 0; i <= 300; i++) { const w = 2 * Math.PI / ((140 + i) * 0.0005) / FPS; let re = 0, im = 0; for (let n = 0; n < o.length; n++) if (o[n]) { re += o[n] * Math.cos(w * n); im += o[n] * Math.sin(w * n); } c[i] = Math.hypot(re, im); if (c[i] > mx) mx = c[i]; }
    let j = 300; while (j > 0 && c[j] < 0.85 * mx) j--;
    while (j < 300 && c[j + 1] > c[j]) j++; while (j > 0 && c[j - 1] > c[j]) j--;
    pulsoDe.coer = mx / (o.reduce((x, y) => x + y, 0) + 1e-9);   // 0 = sem pulso, 1 = todos os ataques no pulso
    return (140 + j) * 0.0005;
  }
  const HARM = [1, 0.5, 2, 2 / 3, 1.5, 0.75, 4 / 3];
  // procura na música inteira. O pulso do ensaio, comparado com o pulso de cada trecho da referência, diz em que
  // andamento cada trecho estaria sendo tocado; com isso compara (20 ms, 4 faixas) os últimos 8 s com cada lugar.
  P.busca = function (todosHarm) {
    const S = this, nW = Math.min(S.nq, 800); if (nW < 400 || !S.tatum) return null;
    const n1 = S.nq, n0 = n1 - nW, Tl = S.pulso(nW), nB = S.tatum.length + 2, bal = new Float32Array(nB), balF = new Float32Array(nB);
    // segundos da referência agrupados pelo andamento que teriam
    const grupos = new Map(), hs = todosHarm ? HARM : HARM.slice(0, 1);
    for (let k = 0; k < S.tatum.length; k++) for (const h of hs) { const f = S.tatum[k] / Tl * h; if (f < 0.6 || f > 1.3) continue; const key = Math.round(f / 0.004); if (!grupos.has(key)) grupos.set(key, []); grupos.get(key).push(k); }
    const Rc = S.Rc, c1 = S.c1, c2 = S.c2, nC = S.nC, marca = new Uint8Array(nC + 1);
    for (const [key, ks] of grupos) {
      const f = key * 0.004, M = Math.floor(nW * f / 2); if (M < 60) continue;
      const Lf = new Float32Array(M * NB), m = [0, 0, 0, 0];
      for (let n = n0; n < n1; n++) { const a = (n % S.cap) * NB, j = Math.min(M - 1, Math.floor((n - n0) * f / 2)) * NB; for (let b = 0; b < NB; b++) Lf[j + b] += S.live[a + b]; }
      for (let j = 0; j < M; j++) for (let b = 0; b < NB; b++) m[b] += Lf[j * NB + b];
      let eL = 0; for (let j = 0; j < M; j++) for (let b = 0; b < NB; b++) { const v = (Lf[j * NB + b] -= m[b] / M); eL += v * v; }
      if (eL < 1e-6) continue;
      marca.fill(0);
      for (const k of ks) for (let e = Math.max(M, k * 50 - 20); e <= Math.min(nC, k * 50 + 70); e++) {
        if (marca[e]) continue; marca[e] = 1;
        const s = e - M; let dot = 0; for (let j = 0, a = s * NB; j < M * NB; j++, a++) dot += Lf[j] * Rc[a];
        let eR = 0; for (let b = 0; b < NB; b++) { const sm = c1[e * NB + b] - c1[s * NB + b]; eR += c2[e * NB + b] - c2[s * NB + b] - sm * sm / M; }
        if (eR < 1e-6) continue;
        const c = dot / Math.sqrt(eL * eR), kk = Math.min(nB - 1, Math.floor(e / 50)); if (c > bal[kk]) { bal[kk] = c; balF[kk] = f; }
      }
    }
    // os melhores segundos, sem vizinhos, refinados no detalhe (10 ms)
    const ord = Array.from(bal.keys()).sort((a, b) => bal[b] - bal[a]), top = [];
    for (const k of ord) { if (top.length >= 8 || bal[k] <= 0) break; if (top.every(q => Math.abs(q - k) > 1)) top.push(k); }
    const J = S.janela(600), pref = S.preferidos(), res = [];
    for (const k of top) {
      let b = S.ajuste(J, k + 0.5, balF[k], 0.8, 0.02, 0.02, 0.005); b = S.ajuste(J, b.p, b.f, 0.03, 0.01, 0.008, 0.004);
      b.c = S.sim(J, b.p, b.f); b.dica = pref.some(q => Math.abs(q + (S.tVolta != null ? (S.agora() - S.tVolta) * b.f : 0) - b.p) < 1.0) ? 1 : 0;
      res.push(b);
    }
    res.sort((a, b) => (b.c + 0.05 * b.dica) - (a.c + 0.05 * a.dica));
    const mm = res[0]; if (!mm) return null;
    let rival = 0; for (const r of res) if (Math.abs(r.p - mm.p) > 1 && r.c > rival) rival = r.c;
    mm.margem = mm.c - rival; mm.t = S.agora(); return mm;
  };
  // lugares onde é mais provável a bateria (re)começar: o combinado; o começo do trecho onde parou e o ponto onde parou;
  // ou o começo de tudo, se ainda não tocou nada
  P.preferidos = function () {
    const S = this, L = [];
    if (S.forcado != null) L.push(S.primeiroAtaque(S.forcado));
    if (S.ult) { L.push(S.primeiroAtaque(S.inicioDoTrecho(S.ult.p))); L.push(S.ult.p); }
    if (!S.jaTravou && S.forcado == null) L.push(S.primeiroAtaque(0));
    return L;
  };
  // todos os lugares onde a bateria pode entrar: os preferidos (sem desconto) e o começo de cada breque e de cada parte
  // (tanto o instante em que o trecho começa quanto o primeiro toque forte dele, para o caso de a contagem ser em silêncio)
  P.lugares = function () {
    const S = this, L = [];
    const poe = (p, pen) => { if (!L.some(q => Math.abs(q.p - p) < 0.4)) L.push({ p, pen }); };
    if (S.forcado != null) { poe(S.primeiroAtaque(S.forcado), 0); poe(S.forcado, 0); }
    if (S.ult) { const i = S.inicioDoTrecho(S.ult.p); poe(S.primeiroAtaque(i), 0); poe(i, 0); poe(S.ult.p, 0.02); }
    const pen = S.forcado != null ? 0.08 : 0.03;
    for (const x of S.secs) { poe(S.primeiroAtaque(x), pen); poe(Math.max(0, x), pen); }
    return L;
  };
  // a bateria (re)começou em tV: entre esses lugares, qual explica melhor o som desde então (e em que andamento)?
  // 1º: compara só os primeiros 2,6 s (rápido, todos os lugares e andamentos); 2º: confere os 6 melhores com tudo o que
  // já ouviu. `atual`: lugar em que já está apostando (só troca se outro for claramente melhor).
  P.dirigida = function (tV, lugares, atual, fAtual) {
    const S = this, n0 = Math.round(tV * FPS), nT = Math.min(800, S.nq - n0); if (nT < 150) return null;
    const nC = Math.min(nT, 260), Jc = S.janela(nC, n0 + nC), dc = nC / FPS, tops = [];
    for (const L of lugares) {
      const bonus = (atual != null && Math.abs(L.p - atual) < 0.4 ? 0.03 : 0) - L.pen; let m = null;
      for (let f = 0.62; f <= 1.28; f += 0.02) for (let d = -0.5; d <= 0.5001; d += 0.03) {
        const c = S.sim(Jc, L.p + d + dc * f, f) - 0.03 * Math.abs(f - S.f);
        if (!m || c > m.c) m = { c, d, f, lugar: L.p, bonus };
      }
      if (m) { m.c += bonus; tops.push(m); }
    }
    // com mais de 3,5 s ouvidos: compara também a janela maior (até 5 s), nos andamentos que o pulso do ensaio indica para
    // cada lugar (o começo de alguns breques, como uma contagem, só fica claro depois de alguns segundos)
    if (nT >= 350 && S.tatum) {
      const nL = Math.min(nT, 500), JL = S.janela(nL, n0 + nL), dl = nL / FPS, Tl = S.pulso(nL, n0 + nL), passo = 0.05 / dl;
      lugares.forEach((L, i) => {
        const m = tops[i], Tr = S.tatum[Math.max(0, Math.min(S.tatum.length - 1, Math.floor(L.p + dl / 2)))];
        for (const h of HARM) { const f0 = Tr / Tl * h; if (f0 < 0.6 || f0 > 1.3) continue;
          for (let f = f0 - 0.03; f <= f0 + 0.0301; f += passo) for (let d = -0.5; d <= 0.5001; d += 0.03) {
            const c = S.sim(JL, L.p + d + dl * f, f) - 0.03 * Math.abs(f - S.f) + m.bonus + 0.02;   // janela maior vale um pouco mais
            if (c > m.c) { m.c = c; m.d = d; m.f = f; }
          } }
      });
    }
    tops.sort((a, b) => b.c - a.c);
    const J = S.janela(nT), dt = nT / FPS; let best = null, rival = 0;
    const lista = tops.slice(0, 6), mAt = atual != null ? tops.find(m => Math.abs(m.lugar - atual) < 0.4) : null;
    if (mAt && !lista.includes(mAt)) lista.push(mAt);   // o lugar em que já está apostando é sempre conferido de novo
    for (const m of lista) {
      let q = null;
      if (m === mAt && fAtual) for (let f = fAtual - 0.03; f <= fAtual + 0.0301; f += 0.003) for (let d = -0.3; d <= 0.3001; d += 0.01) { const c = S.sim(J, m.lugar + d + dt * f, f); if (!q || c > q.c) q = { c, p: m.lugar + d + dt * f, f }; }
      for (let f = m.f - 0.03; f <= m.f + 0.0301; f += 0.003) for (let d = m.d - 0.06; d <= m.d + 0.0601; d += 0.01) { const c = S.sim(J, m.lugar + d + dt * f, f); if (!q || c > q.c) q = { c, p: m.lugar + d + dt * f, f }; }
      q.lugar = m.lugar; q.bonus = m.bonus; q.tot = q.c + m.bonus;
      if (!best || q.tot > best.tot) { if (best) rival = Math.max(rival, best.tot); best = q; } else rival = Math.max(rival, q.tot);
    }
    if (best) best.margem = best.tot - rival;
    return best;
  };
  P.trava = function (p, f, prov) {
    const S = this, t = S.agora(); S.lock = { p, t, f, desde: t }; S.prov = prov ? t : 0; S.baixa = 0; S.cand = null; S.jaTravou = true; S.fim = false; S.f = f;
    if (!prov) { S.forcado = null; S.ult = null; }
  };
  // "Começou!": a bateria entrou agora no lugar combinado (ou no começo do trecho onde parou, ou no começo de tudo)
  P.comecou = function (p) {
    const S = this, alvo = p != null ? p : S.forcado != null ? S.forcado : S.ult ? S.inicioDoTrecho(S.ult.p) : S.lock ? S.inicioDoTrecho(S.pos(S.agora())) : 0;
    S.tap = { t: S.agora() - 0.15, lugar: S.primeiroAtaque(alvo), prox: S.agora() + 2.2 };
    S.lock = { p: S.tap.lugar + 0.15 * S.f, t: S.agora(), f: S.f, desde: S.agora() }; S.prov = S.agora(); S.estado = "conferindo"; S.jaTravou = true; S.cand = null; S.baixa = 0;
  };
  P.combinar = function (p) { this.forcado = p; this.ult = null; this.lock = null; this.tap = null; this.estado = "ouvindo"; this.tVolta = null; };
  P.empurra = function (dp) { const L = this.lock; if (L) { const t = this.agora(); L.p = this.pos(t) + dp; L.t = t; this.baixa = 0; this.tap = null; L.firme = t + 5; } };

  // chamar a cada ~0,2 s
  P.passo = function () {
    const S = this, t = S.agora();
    // celular ligado com a bateria já tocando: não houve entrada, mas dá para ouvir um pulso regular
    if (!S.temSom && S.nq >= 400 && t - S.tMus >= 1) { S.tMus = t; S.pulso(400); if (pulsoDe.coer >= 0.19) { S.temSom = true; S.ultSom = t; S.calado = false; } }
    // toque em "Começou!": confere o lugar exato e o andamento com o som que veio depois do toque
    if (S.tap && t >= S.tap.prox) {
      const b = S.dirigida(S.tap.t, [{ p: S.tap.lugar, pen: 0 }], null);
      if (b && b.c > 0.12) { S.lock = { p: b.p, t, f: b.f, desde: S.lock ? S.lock.desde : t, firme: t + 6 }; S.f = b.f; }
      if (t - S.tap.t > 7) { S.tap = null; S.prov = 0; S.forcado = null; S.ult = null; } else S.tap.prox = t + 1.5;
    }
    if (!S.lock) {
      if (S.calado) { S.estado = S.ult ? "parado" : "ouvindo"; S.cand = null; return; }
      // a bateria entrou (voltou do silêncio). Com lugar combinado, aposta nele já. Sem combinar, ouve 2,6 s e escolhe,
      // entre o começo de todos os breques e partes, o que bate com o som (em vez de chutar o primeiro breque).
      if (S.tVolta != null && t - S.tVolta < 6) {
        if (S.forcado != null && t - S.tVolta < 1.0) { S.lock = { p: S.primeiroAtaque(S.forcado) + (t - S.tVolta) * S.f, t, f: S.f, desde: S.tVolta }; S.prov = t; S.provOk = false; S.provLug = S.lugares(); S.provAt = S.primeiroAtaque(S.forcado); S.tDir = S.tVolta + 2.4; S.baixa = 0; S.estado = "conferindo"; return; }
        S.estado = "entrando";
        if (t - S.tVolta >= 2.6 && t >= S.tDir) {
          S.tDir = t + 1.2; const lug = S.lugares(), bb = S.dirigida(S.tVolta, lug, null);
          if (bb && bb.c > 0.25 && bb.margem > 0) { S.lock = { p: bb.p, t, f: bb.f, desde: S.tVolta }; S.f = bb.f; S.prov = t; S.provOk = true; S.jaTravou = true; S.provLug = lug; S.provAt = bb.lugar; S.tDir = t + 1.6; S.baixa = 0; S.estado = "conferindo"; }
        }
        return;
      }
      if (t - S.tBusca < 1.2) return; S.tBusca = t;
      S.alt = !S.alt; const b = S.busca(S.alt), bom = b && b.c >= (b.dica ? 0.2 : 0.26) && b.margem >= (b.dica ? 0.03 : 0.06);
      const c0 = S.cand, conf = bom && c0 && Math.abs(c0.p + (t - c0.t) * c0.f - b.p) < 0.4;
      S.cand = bom ? b : null; S.estado = "procurando";
      if (conf) { S.trava(b.p, b.f, false); S.estado = "seguindo"; }
      return;
    }
    const L = S.lock; let p = S.pos(t);
    if (p > S.dur + 0.5) { S.lock = null; S.ult = null; S.fim = true; S.estado = "fim"; return; }
    // parou? ficou em silêncio num trecho em que a referência está tocando
    if (S.calado && t - S.ultSom > 1.6 && S.ativRef(p - 1.5, p) > 6) {
      const pPar = S.pos(S.ultSom); S.ult = { p: pPar, em: t }; S.lock = null; S.tap = null; S.estado = "parado"; S.cand = null; S.tVolta = null; return;
    }
    // logo depois de voltar do silêncio: confere entre os lugares prováveis qual é o certo e acerta o andamento
    if (S.prov && !S.tap && S.tVolta != null && t >= S.tDir && t - S.tVolta < 9) {
      S.tDir = t + 1.6; const b = S.dirigida(S.tVolta, S.provLug, S.provAt, S.provOk ? L.f : null);
      if (b && b.c > 0.2) { L.p = b.p; L.t = t; L.f = b.f; S.f = b.f; p = b.p; S.provOk = true; S.jaTravou = true; S.provAt = b.lugar; }
      else if (!S.provOk && t - S.tVolta > 3.8) { S.lock = null; S.prov = 0; S.tVolta = null; S.temSom = false; S.calado = true; S.tMus = t - 0.5; S.estado = "ouvindo"; return; }   // não era a bateria (ou não é nenhum dos lugares prováveis): volta a esperar uma entrada ou um pulso
    }
    // seguindo: procura o melhor encaixe pertinho do lugar previsto e corrige devagar
    const nW = Math.min(500, Math.max(150, Math.round((t - L.desde) * FPS)));
    if (t - L.desde >= 1.5 && !S.calado) {
      const J = S.janela(nW);
      if (J.idx.length >= 8) {
        const c0 = S.sim(J, p, L.f), b = S.ajuste(J, p, L.f, 0.2, 0.01, 0.03, 0.01);
        S.conf = Math.max(c0, b.c);
        if (b.c > 0.1 && b.c >= c0) { L.p = p + (b.p - p) * 0.6; L.f += (b.f - L.f) * 0.4; L.t = t; }
        if (S.conf >= 0.15) { S.baixa = 0; if (!S.prov) S.f = L.f; } else S.baixa++;
        if (S.prov && !S.tap && t - S.prov > 9) { S.prov = 0; S.f = L.f; }
      }
    }
    // revisão: a bateria repete muito, então de segundo em segundo compara com os compassos vizinhos (até 10 s para cada
    // lado) numa janela mais comprida; se outro lugar ganha duas vezes seguidas, pula para ele
    if (t - S.tRev >= 1 && t - L.desde >= 4 && !S.calado && !(L.firme && t < L.firme && t - L.desde < 4)) {
      S.tRev = t; const J = S.janela(Math.min(1000, Math.round((t - L.desde) * FPS))), pc = S.pos(t), c0 = S.sim(J, pc, L.f);
      let bc = c0, bd = 0;
      for (let d = -10; d <= 10.0001; d += 0.01) { if (Math.abs(d) < 0.25) continue; const c = S.sim(J, pc + d, L.f); if (c > bc) { bc = c; bd = d; } }
      const r0 = S.rev, alvo = pc + bd;
      if (bd !== 0 && bc >= c0 + 0.04) {
        if (r0 && Math.abs(r0.p + (t - r0.t) * L.f - alvo) < 0.12) { L.p = alvo; L.t = t; S.rev = null; S.baixa = 0; }
        else S.rev = { p: alvo, t };
      } else S.rev = null;
    }
    S.estado = S.prov ? "conferindo" : S.baixa >= 5 ? "no relógio" : "seguindo";
    // sem encaixe por um tempo (ou ainda conferindo): olha a música inteira; se outro lugar explica claramente melhor, vai
    const firme = L.firme && t < L.firme;
    const conferido = S.prov && S.provOk && S.tVolta != null && t - S.tVolta < 9;   // palpite já confirmado e ainda acertando o andamento
    if (!firme && !conferido && !S.calado && t - L.desde >= 4 && t - S.tBusca >= (S.cand ? 1.2 : S.prov ? 1.5 : 3)) {
      S.tBusca = t; S.alt = !S.alt; const b = S.busca(S.alt && (S.prov || S.conf < 0.3));
      if (b) {
        const J6 = S.janela(600), cur = Math.max(S.sim(J6, S.pos(t), L.f), S.ajuste(J6, S.pos(t), L.f, 0.3, 0.02, 0.06, 0.01).c), longe = Math.abs(b.p - S.pos(t)) > 0.6, melhor = longe && b.c >= cur + (S.prov ? 0.05 : 0.08) && b.margem >= 0.02;
        const c0 = S.cand, ok = melhor && c0 && Math.abs(c0.p + (t - c0.t) * c0.f - b.p) < 0.4;
        S.cand = melhor ? b : null;
        if (ok) { S.trava(b.p, b.f, false); S.estado = "seguindo"; return; }
      }
    }
    if (S.baixa >= 40 && !S.tap) { S.ult = { p: S.pos(t), em: t }; S.lock = null; S.estado = "procurando"; S.cand = null; S.tVolta = null; }
  };

  // dentro de um Worker: recebe o som do microfone, segue e devolve o estado (assim a tela não engasga com as contas)
  if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
    let ou = null, sg = null;
    const conta = () => self.postMessage({ t: "estado", estado: sg.estado, lock: sg.lock ? { p: sg.lock.p, t: sg.lock.t, f: sg.lock.f } : null, conf: sg.conf, f: sg.f, nq: sg.nq, calado: sg.calado, ult: sg.ult ? sg.ult.p : null, forcado: sg.forcado, fim: sg.fim,  alto: sg.alto, tVolta: sg.tVolta });
    self.onmessage = e => {
      const m = e.data;
      if (m.t === "ini") { sg = new Seguidor(new Uint8Array(m.ref), m.secs, m.dur, m.tatum, m.op); ou = m.surdos ? new OuvidoSurdos(m.sr, m.moldes) : new Ouvido(m.sr); conta(); }
      else if (m.t === "som" && sg) ou.alimenta(m.x, (a, b, c, d, n) => { sg.quadro(a, b, c, d, n); if (sg.nq % 20 === 0) { sg.passo(); conta(); } });
      else if (m.t === "cmd" && sg) { sg[m.nome](m.arg); conta(); }
    };
  }
  root.Ouvido = Ouvido; root.OuvidoSurdos = OuvidoSurdos; root.Seguidor = Seguidor;
  if (typeof module !== "undefined") module.exports = { Ouvido, OuvidoSurdos, Seguidor };
})(typeof window !== "undefined" ? window : globalThis);
