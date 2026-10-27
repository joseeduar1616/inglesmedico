// Gera surdos3d/voz/falas.json: todas as falas das aulas dos robôs, breque por breque, como a página monta.
// Uso: node surdos3d/tools/falas.js   (precisa do Playwright; as bibliotecas 3D podem vir de node_modules com NM=...)
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const page = path.resolve(__dirname, "..", "index.html"), out = path.resolve(__dirname, "..", "voz", "falas.json");
const NM = process.env.NM;   // pasta node_modules com three@0.128.0, se a rede não alcança os CDNs
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  if (NM) {
    await p.route("**/three.js/r128/three.min.js", r => r.fulfill({ body: fs.readFileSync(NM + "/three/build/three.min.js"), contentType: "application/javascript" }));
    await p.route("**/three@0.128.0/examples/js/controls/OrbitControls.js", r => r.fulfill({ body: fs.readFileSync(NM + "/three/examples/js/controls/OrbitControls.js"), contentType: "application/javascript" }));
  }
  await p.route("**/mp4-muxer**", r => r.fulfill({ body: "", contentType: "application/javascript" }));
  await p.goto("file://" + page); await p.waitForFunction(() => window.__s3d && window.__s3d.buildLesson);
  const ids = await p.$$eval("#bqSel option", os => os.map(o => [o.value, o.textContent]));
  const res = { breques: {} };
  for (const [id, name] of ids) {
    await p.selectOption("#bqSel", id);
    const lines = await p.evaluate(() => {
      const s3 = window.__s3d, box = document.getElementById("lsSlow"), seen = new Set(), out = [];
      for (const slow of [true, false]) {   // as duas versões da aula (com e sem "mostrar devagar antes")
        box.checked = slow;
        for (const st of s3.buildLesson()) if (st.say && !seen.has(st.who + "|" + st.say)) { seen.add(st.who + "|" + st.say); out.push({ who: st.who, text: st.say, speech: s3.speakable(st.say) }); }
      }
      box.checked = true;
      return out;
    });
    res.breques[id] = { name, lines };
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  const all = Object.values(res.breques).flatMap(b => b.lines), uniq = new Map(all.map(l => [l.who + "|" + l.speech, l]));
  console.log(`falas: ${all.length} (${uniq.size} diferentes), caracteres a gerar: ${[...uniq.values()].reduce((a, l) => a + l.speech.length, 0)}`);
  await b.close();
})();
