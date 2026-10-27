#!/usr/bin/env python3
"""Corta um bloco gerado na ElevenLabs (várias falas separadas por [long pause]) em uma fala por arquivo.

Uso: python3 separar_falas.py <id do bloco> <bloco.mp3>
As falas vão para tools/.cache_vozes/el/<hash>.wav (mono 24 kHz), com o nome tirado de "quem|texto falado",
como gerar_vozes.py --montar espera. As pausas entre falas (~1,3 s) são bem mais longas que as de dentro de uma
fala (~0,3 s): o corte usa as N-1 maiores pausas e recusa o bloco se elas não forem claramente maiores.
"""
import hashlib, json, os, re, subprocess, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
SR = 24000


def chave(who, speech):
    return hashlib.sha1(f"{who}|{speech}".encode()).hexdigest()[:16]


def main():
    bid, mp3 = int(sys.argv[1]), sys.argv[2]
    bloco = next(c for c in json.load(open(os.path.join(AQUI, "blocos_elevenlabs.json"))) if c["id"] == bid)
    n = len(bloco["lines"])
    out = subprocess.run(["ffmpeg", "-v", "info", "-i", mp3, "-af", "silencedetect=noise=-40dB:d=0.25", "-f", "null", "-"], capture_output=True, text=True).stderr
    sil = [(float(a), float(b)) for a, b in re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)]
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], capture_output=True, text=True).stdout)
    inner = [(e, d) for e, d in sil if e < dur - 0.05]   # o silêncio do fim do arquivo não separa falas
    cortes = sorted(sorted(inner, key=lambda x: -x[1])[: n - 1])
    if len(cortes) != n - 1:
        sys.exit(f"bloco {bid}: {len(inner)} pausas para {n} falas")
    menor = min(d for _, d in cortes) if cortes else 9
    resto = [d for x in inner if x not in cortes for d in [x[1]]]
    if cortes and resto and menor < max(resto) * 1.3:
        sys.exit(f"bloco {bid}: pausas ambíguas (menor corte {menor:.2f}s, maior pausa interna {max(resto):.2f}s)")
    pasta = os.path.join(AQUI, ".cache_vozes", "el"); os.makedirs(pasta, exist_ok=True)
    ini = 0.0
    for k, (orig, falado) in enumerate(bloco["lines"]):
        fim = cortes[k][0] - cortes[k][1] if k < n - 1 else dur
        wav = os.path.join(pasta, chave(bloco["who"], orig) + ".wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ss", f"{max(0, ini - 0.04):.3f}", "-to", f"{fim + 0.08:.3f}", "-ac", "1", "-ar", str(SR),
                        "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,afade=t=in:d=0.01", wav], check=True)
        ini = cortes[k][0] if k < n - 1 else dur
        import wave
        with wave.open(wav) as w:
            seg = w.getnframes() / SR
        taxa = len(falado) / max(seg, 0.01)
        if not 7 <= taxa <= 28:
            print(f"  atenção: fala {k + 1} com {taxa:.1f} caracteres/s ({seg:.2f}s): {falado[:50]}")
    print(f"bloco {bid}: {n} falas, pausas de corte ≥ {menor:.2f}s" + (f", maior pausa interna {max(resto):.2f}s" if resto else ""))


if __name__ == "__main__":
    main()
