// Banco do Almoxarifado Madrasta, em Netlify Blobs.
// Cada registro é uma chave "<coleção>/<id>"; "meta/rev" muda a cada gravação, para a página saber quando buscar de novo.
// Se a variável de ambiente CODIGO_BATERIA existir, toda chamada precisa mandar o mesmo código no cabeçalho x-codigo.
import { getStore } from "@netlify/blobs"
import type { Config, Context } from "@netlify/functions"

const COLECOES = ["itens", "demandas", "manutencoes", "historico"]
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
const HIST_MAX = 300      // o histórico guarda as 300 últimas alterações
const HIST_ENVIA = 150

const store = () => getStore({ name: "almoxarifado", consistency: "strong" })
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

function mesclar(a: Record<string, unknown>, b: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
      ? mesclar(out[k] as Record<string, unknown>, v as Record<string, unknown>) : v
  }
  return out
}

async function lerColecao(col: string) {
  const s = store()
  const { blobs } = await s.list({ prefix: col + "/" })
  let keys = blobs.map(b => b.key)
  if (col === "historico") keys = keys.sort().reverse().slice(0, HIST_ENVIA)   // ids crescem com o tempo
  const docs = await Promise.all(keys.map(async key => ({ id: key.slice(col.length + 1), data: await s.get(key, { type: "json" }) })))
  return docs.filter(d => d.data !== null)
}

async function podarHistorico() {
  const s = store()
  const { blobs } = await s.list({ prefix: "historico/" })
  if (blobs.length <= HIST_MAX + 50) return
  const velhos = blobs.map(b => b.key).sort().slice(0, blobs.length - HIST_MAX)
  await Promise.all(velhos.map(k => s.delete(k)))
}

export default async (req: Request, context: Context) => {
  const codigo = Netlify.env.get("CODIGO_BATERIA")
  // tolerante: ignora maiúsculas, espaços e traços (o iPhone troca "-" por "–" sozinho)
  const limpa = (v: string | null) => (v || "").normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
  if (codigo && limpa(req.headers.get("x-codigo")) !== limpa(codigo)) return json({ erro: "codigo" }, 401)
  const s = store()
  const url = new URL(req.url)

  if (req.method === "GET") {
    const rev = (await s.get("meta/rev")) || "0"
    if (url.searchParams.get("rev") === rev) return json({ rev, igual: true })
    const [itens, demandas, manutencoes, historico] = await Promise.all(COLECOES.map(lerColecao))
    return json({ rev, itens, demandas, manutencoes, historico })
  }

  if (req.method === "POST") {
    const texto = await req.text()
    if (texto.length > 100_000) return json({ erro: "grande demais" }, 413)
    let corpo: { col?: string; id?: string; op?: string; data?: Record<string, unknown> }
    try { corpo = JSON.parse(texto) } catch { return json({ erro: "json" }, 400) }
    const { col, id, op, data } = corpo
    if (!col || !COLECOES.includes(col) || !id || !ID_OK.test(id)) return json({ erro: "caminho" }, 400)
    const key = `${col}/${id}`
    if (op === "delete") await s.delete(key)
    else if (op === "set" || op === "update") {
      if (!data || typeof data !== "object" || Array.isArray(data)) return json({ erro: "dados" }, 400)
      let novo = data
      if (op === "update") {
        const atual = await s.get(key, { type: "json" })
        if (atual === null) return json({ erro: "nao_existe" }, 404)
        novo = mesclar(atual as Record<string, unknown>, data)
      }
      await s.setJSON(key, novo)
    } else return json({ erro: "op" }, 400)
    const rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    await s.set("meta/rev", rev)
    if (col === "historico") context.waitUntil(podarHistorico())
    return json({ ok: true, rev })
  }
  return json({ erro: "metodo" }, 405)
}

export const config: Config = { path: "/api/dados", method: ["GET", "POST"] }
