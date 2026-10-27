#!/usr/bin/env python3
"""Gera as vozes da Ritma e do Tuco na ElevenLabs e monta um pacote de áudio por breque.

Entrada:  surdos3d/voz/falas.json  (node surdos3d/tools/falas.js)
Saída:    surdos3d/voz/<breque>.mp3 + <breque>.json (onde cada fala começa e quanto dura) e voz/index.json

Variáveis de ambiente:
  ELEVENLABS_API_KEY   chave da API (obrigatória, salvo com --teste)
  ELEVEN_VOZ_RITMA     voice_id da Ritma (opcional: sem ela, procura uma voz feminina do Brasil na biblioteca)
  ELEVEN_VOZ_TUCO      voice_id do Tuco  (opcional: idem, masculina)
  ELEVEN_MODELO        modelo (padrão eleven_multilingual_v2)

Cada fala gerada fica guardada em tools/.cache_vozes, então rodar de novo só gera o que mudou.
--teste troca a ElevenLabs por bipes do tamanho da fala, para conferir a montagem sem gastar créditos.
"""
import argparse, hashlib, json, os, subprocess, sys, tempfile, urllib.parse, urllib.request, wave

AQUI = os.path.dirname(os.path.abspath(__file__))
VOZ = os.path.join(AQUI, "..", "voz")
CACHE = os.path.join(AQUI, ".cache_vozes")
API = "https://api.elevenlabs.io"
SR = 24000            # áudio do pacote: mono 24 kHz
LEAD, TAIL = 0.06, 0.3  # silêncio antes e depois de cada fala no pacote


def api(method, path, key, body=None, accept="application/json"):
    req = urllib.request.Request(API + path, method=method, headers={"xi-api-key": key, "accept": accept, "content-type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    return json.loads(data) if accept == "application/json" else data


def escolher_voz(key, genero, nome):
    """Procura na biblioteca de vozes uma voz brasileira do gênero pedido e a adiciona à conta."""
    q = urllib.parse.urlencode({"page_size": 20, "language": "pt", "accent": "brazilian", "gender": genero, "sort": "cloned_by_count"})
    vozes = api("GET", "/v1/shared-voices?" + q, key).get("voices", [])
    if not vozes:
        sys.exit(f"Nenhuma voz brasileira ({genero}) na biblioteca; defina ELEVEN_VOZ_{nome.upper()}.")
    v = vozes[0]
    novo = api("POST", f"/v1/voices/add/{v['public_owner_id']}/{v['voice_id']}", key, {"new_name": f"{nome} (surdos 3D)"})
    print(f"{nome}: {v.get('name')} ({novo.get('voice_id')})")
    return novo["voice_id"], v.get("name")


def gerar(key, voz, modelo, texto):
    q = urllib.parse.urlencode({"output_format": "mp3_44100_128"})
    corpo = {"text": texto, "model_id": modelo, "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.3, "use_speaker_boost": True}}
    if "v2_5" in modelo or "flash" in modelo:
        corpo["language_code"] = "pt"
    return api("POST", f"/v1/text-to-speech/{voz}?{q}", key, corpo, accept="audio/mpeg")


def para_pcm(mp3, wav):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ac", "1", "-ar", str(SR), "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse", wav], check=True)


def bipe(texto, wav):
    dur = 0.4 + len(texto) * 0.055
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur:.2f}:sample_rate={SR}", "-af", "volume=0.2", wav], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--teste", action="store_true", help="bipes no lugar da ElevenLabs")
    ap.add_argument("--so", help="só estes breques (ids separados por vírgula)")
    ap.add_argument("--montar", metavar="VOZES", help="não gera nada: monta os pacotes com as falas já cortadas em .cache_vozes/el (separar_falas.py); VOZES = 'Ritma: nome; Tuco: nome' para a página mostrar")
    a = ap.parse_args()
    falas = json.load(open(os.path.join(VOZ, "falas.json")))["breques"]
    if a.so:
        falas = {k: v for k, v in falas.items() if k in a.so.split(",")}
    key, modelo = os.environ.get("ELEVENLABS_API_KEY", ""), os.environ.get("ELEVEN_MODELO", "eleven_multilingual_v2")
    if not a.teste and not a.montar and not key:
        sys.exit("Defina ELEVENLABS_API_KEY (ou use --teste).")
    os.makedirs(CACHE, exist_ok=True)
    vozes, nomes = {}, {}
    if not a.teste and not a.montar:
        for who, gen, nome, env in (("R", "female", "Ritma", "ELEVEN_VOZ_RITMA"), ("T", "male", "Tuco", "ELEVEN_VOZ_TUCO")):
            vozes[who], nomes[who] = (os.environ[env], os.environ[env]) if os.environ.get(env) else escolher_voz(key, gen, nome)
    gerados = caracteres = 0
    feitos = []
    for bid, b in falas.items():
        partes, linhas, pos = [], {}, 0
        for l in b["lines"]:
            if a.montar:
                wav = os.path.join(CACHE, "el", hashlib.sha1(f"{l['who']}|{l['speech']}".encode()).hexdigest()[:16] + ".wav")
                if not os.path.exists(wav):
                    sys.exit(f"{bid}: falta a fala {l['who']}: {l['speech'][:60]}")
            else:
                voz = "teste" if a.teste else vozes[l["who"]]
                h = hashlib.sha1(f"{voz}|{modelo}|{l['speech']}".encode()).hexdigest()[:16]
                wav = os.path.join(CACHE, h + ".wav")
            if not os.path.exists(wav):
                if a.teste:
                    bipe(l["speech"], wav)
                else:
                    mp3 = os.path.join(CACHE, h + ".mp3")
                    open(mp3, "wb").write(gerar(key, voz, modelo, l["speech"]))
                    para_pcm(mp3, wav); os.remove(mp3)
                    caracteres += len(l["speech"])
                gerados += 1
            with wave.open(wav) as w:
                n = w.getnframes()
            partes.append(wav)
            linhas[l["who"] + "|" + l["text"]] = [round(pos + LEAD, 3), round(n / SR, 3)]
            pos += LEAD + n / SR + TAIL
        # junta tudo num arquivo só, com silêncio entre as falas, e grava em MP3 mono
        with tempfile.TemporaryDirectory() as tmp:
            sil_a, sil_b = os.path.join(tmp, "a.wav"), os.path.join(tmp, "b.wav")
            for f, d in ((sil_a, LEAD), (sil_b, TAIL)):
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", str(d), "-c:a", "pcm_s16le", f], check=True)
            lista = os.path.join(tmp, "lista.txt")
            with open(lista, "w") as fh:
                for p in partes:
                    fh.write(f"file '{sil_a}'\nfile '{os.path.abspath(p)}'\nfile '{sil_b}'\n")
            junto = os.path.join(tmp, "junto.wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lista, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", junto], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", junto, "-c:a", "libmp3lame", "-b:a", "48k", os.path.join(VOZ, bid + ".mp3")], check=True)
        json.dump({"lines": linhas}, open(os.path.join(VOZ, bid + ".json"), "w"), ensure_ascii=False)
        feitos.append(bid)
        print(f"{bid}: {len(linhas)} falas, {pos / 60:.1f} min")
    idx_path = os.path.join(VOZ, "index.json")
    idx = json.load(open(idx_path)) if os.path.exists(idx_path) else {}
    idx["breques"] = sorted(set(idx.get("breques", [])) | set(feitos)) if not a.teste else feitos
    if nomes:
        idx["vozes"] = nomes
    if a.montar:
        idx["vozes"] = dict(p.split(": ", 1) for p in a.montar.split("; "))
        idx["vozes"] = {"R": idx["vozes"].get("Ritma", ""), "T": idx["vozes"].get("Tuco", "")}
    if a.teste:
        idx["teste"] = True
    json.dump(idx, open(idx_path, "w"), ensure_ascii=False)
    print(f"falas novas: {gerados}; caracteres enviados à ElevenLabs: {caracteres}")


if __name__ == "__main__":
    main()
