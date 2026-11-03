# Gera public/index.html a partir de ../madrasta/index.html (a mesma página publicada no Claude),
# com o cabeçalho HTML completo e a ponte para o banco do Netlify.
import pathlib
aqui = pathlib.Path(__file__).parent
pag = (aqui.parent / "madrasta" / "index.html").read_text()
cab = ('<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%2215%22 fill=%22%23ff6a13%22/%3E%3Ctext x=%2216%22 y=%2221%22 font-size=%2214%22 font-family=%22Impact,sans-serif%22 text-anchor=%22middle%22 fill=%22%23000%22%3EM%3C/text%3E%3C/svg%3E">\n'
       '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n')
i = pag.index("<script>")
html = cab + pag[:pag.index("<header")] + "</head>\n<body>\n" + pag[pag.index("<header"):i] + '<script src="/ponte.js"></script>\n' + pag[i:] + "\n</body>\n</html>\n"
(aqui / "public" / "index.html").write_text(html)
print("public/index.html", len(html))
