// MOTOR AUTOMÁTICO — Tiger Elev  (v3)
// Lê uma Planilha Google (publicada como CSV) e gera TODAS as páginas de preview + embeds.
//
// NOVIDADE v2: as capas são detectadas e BAIXADAS a cada build, direto dos artigos do
// Google Sites, e passam a ser servidas pelo próprio Netlify em /img/<slug>.jpg.
// Motivo: as URLs do Google (lh3.googleusercontent.com/sitesv/...) EXPIRAM — usá-las
// direto no og:image faz a prévia parar de funcionar depois de alguns dias.
//
// A coluna "imagem" da planilha vira OPCIONAL:
//   - vazia  -> a capa é detectada automaticamente no artigo;
//   - URL própria (ex.: https://.../minha-capa.jpg) -> usada como está (override manual).
//   (URLs do googleusercontent são ignoradas de propósito: expiram.)

const fs = require('fs');
const path = require('path');

// === Config (variáveis de ambiente do Netlify, com defaults) ===
const SHEET_CSV = process.env.SHEET_CSV || '';
const BLOG_BASE = process.env.BLOG_BASE || 'https://www.tiger.ind.br/blog';
const DOMAIN = (process.env.URL || process.env.DOMAIN || 'https://link.tiger.ind.br').replace(/\/+$/, '');
const CONCURRENCY = 2;      // o Google bloqueia requisições em rajada — devagar é mais rápido
const PAUSA = 400;          // ms entre requisições de cada worker
const MIN_BYTES = 15000;    // abaixo disso é ícone/avatar, não capa
const MAX_REPETICOES = 2;   // imagem que aparece em >2 artigos = logo/rodapé do site

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch com repetição (o Google limita requisições em rajada)
async function tryFetch(url, opts = {}, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, opts);
      if ((r.status === 429 || r.status === 403) && i < attempts - 1) { await sleep(1500 * (i + 1)); continue; }
      return r;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error('falhou: ' + url);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Parser de CSV que respeita vírgulas dentro de aspas
function parseCSV(text) {
  const rows = []; let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function previewHtml(title, desc, img, slug, redirect) {
  const T = esc(title), D = esc(desc), U = DOMAIN + '/' + slug;
  return `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${T}</title><meta name="description" content="${D}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Tiger Elev">
<meta property="og:title" content="${T}"><meta property="og:description" content="${D}">
<meta property="og:image" content="${esc(img)}"><meta property="og:url" content="${U}">
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${T}"><meta name="twitter:description" content="${D}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="robots" content="noindex"><link rel="canonical" href="${U}">
<script>window.location.replace(${JSON.stringify(redirect)});</script>
</head><body style="font-family:Arial,Helvetica,sans-serif;text-align:center;padding:40px;color:#0A0903">
<p>Redirecionando para o artigo…</p><p><a href="${redirect}">Clique aqui</a> se não for redirecionado.</p>
</body></html>`;
}

function embed(url, titulo) {
  return `<div id="share-tiger"></div>
<script>
var url = ${JSON.stringify(url)};
var titulo = ${JSON.stringify(titulo)};
var u = encodeURIComponent(url), t = encodeURIComponent(titulo);
var links = [
  { cor: "#1877F2", href: "https://www.facebook.com/sharer/sharer.php?u=" + u, letra: "f" },
  { cor: "#000000", href: "https://twitter.com/intent/tweet?url=" + u + "&text=" + t, letra: "X" },
  { cor: "#0A66C2", href: "https://www.linkedin.com/sharing/share-offsite/?url=" + u, letra: "in" },
  { cor: "#25D366", href: "https://wa.me/?text=" + t + "%20" + u, letra: "wa" }
];
var html = '<div style="font-family:Arial,Helvetica,sans-serif;padding:14px 0;border-top:1px solid #e5e7eb;margin-top:24px">'
  + '<span style="color:#0A0903;font-weight:bold;font-size:15px;margin-right:12px">Compartilhe:</span>';
links.forEach(function(l){ html += '<a href="' + l.href + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:' + l.cor + ';color:#fff;text-decoration:none;font-weight:bold;font-size:14px;margin-right:8px;vertical-align:middle">' + l.letra + '</a>'; });
html += '</div>'; document.getElementById("share-tiger").innerHTML = html;
</script>`;
}

const isGoogleImg = (u) => /googleusercontent\.com/.test(u);
const token = (u) => u.split('=')[0]; // remove o sufixo de tamanho (=w1200)

// O Google Sites serve imagens em vários hosts: lh3, lh5, lh7-us, lh7-rt…
// (os hosts "*-atari-embeds" são widgets incorporados, não imagens do artigo)
const RE_IMG = /https:\/\/lh\d+(?:-[a-z]{2,3})?\.googleusercontent\.com\/[A-Za-z0-9_\-=./]+/g;

// Baixa a página do artigo e devolve as imagens hospedadas pelo Google.
async function imagensDoArtigo(url) {
  const r = await tryFetch(url);
  if (!r.ok) return [];
  const html = await r.text();
  const achadas = (html.match(RE_IMG) || []).map((u) => u.replace(/[.,)]+$/, ''));
  return [...new Set(achadas)];
}

// Baixa uma candidata; devolve null se falhar ou for pequena demais (ícone).
async function baixarCandidata(u) {
  try {
    const r = await tryFetch(token(u) + '=w1200', { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const tipo = r.headers.get('content-type') || '';
    if (!tipo.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < MIN_BYTES) return null;
    return { buf, tipo };
  } catch { return null; }
}

(async () => {
  if (!SHEET_CSV) { console.error('ERRO: defina a variável de ambiente SHEET_CSV com a URL CSV da planilha.'); process.exit(1); }
  const res = await tryFetch(SHEET_CSV);
  if (!res.ok) { console.error('ERRO ao buscar a planilha:', res.status); process.exit(1); }

  const rows = parseCSV(await res.text()).filter((r) => r.some((c) => (c || '').trim()));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iSlug = col('slug'), iTit = col('titulo'), iDesc = col('descricao'), iImg = col('imagem'), iLink = col('link');

  const arts = rows.map((r) => ({
    slug: (r[iSlug] || '').trim(),
    titulo: (r[iTit] || '').trim(),
    desc: (r[iDesc] || '').trim(),
    imagem: iImg >= 0 ? (r[iImg] || '').trim() : '',
    redirect: (r[iLink] || '').trim(),
  })).filter((a) => a.slug);
  arts.forEach((a) => { if (!a.redirect) a.redirect = BLOG_BASE + '/' + a.slug; });

  const deploy = path.join(__dirname, 'deploy');
  fs.rmSync(deploy, { recursive: true, force: true });
  fs.mkdirSync(path.join(deploy, 'img'), { recursive: true });

  // Capas fixas opcionais versionadas no repositório (img/) — copiadas se existirem.
  const staticImg = path.join(__dirname, 'img');
  if (fs.existsSync(staticImg)) fs.cpSync(staticImg, path.join(deploy, 'img'), { recursive: true });

  // --- 1) Quem precisa de detecção automática de capa? ---
  // Prioridade: (a) arquivo fixo em img/<slug>.ext no repositório  →  (b) URL própria na
  // planilha  →  (c) detecção automática no artigo.
  let fixas = 0;
  arts.forEach((a) => {
    const ext = ['jpg', 'png', 'webp', 'jpeg'].find((e) => fs.existsSync(path.join(staticImg, a.slug + '.' + e)));
    if (ext) { a.imagem = DOMAIN + '/img/' + a.slug + '.' + ext; a.fixa = true; fixas++; }
  });

  const auto = arts.filter((a) => !a.fixa && (!a.imagem || isGoogleImg(a.imagem)));
  console.log(`Artigos: ${arts.length} | capa fixa no repo: ${fixas} | capa manual (planilha): ${arts.length - fixas - auto.length} | detecção automática: ${auto.length}`);

  console.log('1/3 lendo os artigos…');
  await pool(auto, CONCURRENCY, async (a) => {
    try { a.imgs = await imagensDoArtigo(a.redirect); } catch { a.imgs = []; }
    await sleep(PAUSA);
  });

  // Segunda tentativa, serial e lenta, para as páginas que o Google recusou.
  const semPagina = auto.filter((a) => !(a.imgs || []).length);
  if (semPagina.length) {
    console.log(`   ${semPagina.length} página(s) falharam — repetindo devagar…`);
    for (const a of semPagina) {
      try { a.imgs = await imagensDoArtigo(a.redirect); } catch { a.imgs = []; }
      await sleep(2000);
    }
  }

  // --- 2) A capa é a maior imagem EXCLUSIVA do artigo ---
  // Imagens que aparecem em muitos artigos são o logo, os ícones e o rodapé do site.
  const freq = {};
  auto.forEach((a) => [...new Set((a.imgs || []).map(token))].forEach((t) => { freq[t] = (freq[t] || 0) + 1; }));
  auto.forEach((a) => {
    const vistos = new Set();
    a.cands = (a.imgs || []).filter((u) => {
      const t = token(u);
      if (freq[t] > MAX_REPETICOES || vistos.has(t)) return false;
      vistos.add(t); return true;
    });
  });

  console.log('2/3 baixando as capas…');
  const salvar = (a, r) => {
    const ext = r.tipo.includes('png') ? 'png' : r.tipo.includes('webp') ? 'webp' : 'jpg';
    fs.writeFileSync(path.join(deploy, 'img', a.slug + '.' + ext), r.buf);
    a.imagem = DOMAIN + '/img/' + a.slug + '.' + ext;
  };

  await pool(auto, CONCURRENCY, async (a) => {
    let melhor = null;
    for (const u of a.cands) {
      const r = await baixarCandidata(u);
      if (r && (!melhor || r.buf.length > melhor.buf.length)) melhor = r;
      await sleep(PAUSA);
    }
    if (melhor) salvar(a, melhor); else a.imagem = '';
  });

  // Terceira tentativa: quem ficou sem capa tenta de novo, bem devagar.
  const faltando = auto.filter((a) => !a.imagem && a.cands.length);
  if (faltando.length) {
    console.log(`   ${faltando.length} capa(s) falharam — repetindo devagar…`);
    for (const a of faltando) {
      let melhor = null;
      for (const u of a.cands) {
        const r = await baixarCandidata(u);
        if (r && (!melhor || r.buf.length > melhor.buf.length)) melhor = r;
        await sleep(1500);
      }
      if (melhor) salvar(a, melhor);
    }
  }

  console.log('3/3 gerando as páginas…');
  const semCapa = auto.filter((a) => !a.imagem).map((a) => a.slug);

  let count = 0;
  let embedsMd = '# Embeds de compartilhamento (gerados da planilha)\n\n';
  arts.forEach((a) => {
    fs.writeFileSync(path.join(deploy, a.slug + '.html'), previewHtml(a.titulo, a.desc, a.imagem, a.slug, a.redirect));
    embedsMd += `## ${a.titulo}\n\`\`\`html\n${embed(DOMAIN + '/' + a.slug, a.titulo)}\n\`\`\`\n\n`;
    count++;
  });

  fs.writeFileSync(path.join(deploy, 'index.html'),
    `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><script>window.location.replace(${JSON.stringify(BLOG_BASE)});</script></head><body>Redirecionando…</body></html>`);
  fs.writeFileSync(path.join(deploy, 'embeds.md'), embedsMd);

  // Rede de segurança: se alguém colar o link com "/blog/" no meio (copiando o padrão do
  // Google Sites), o endereço continua funcionando em vez de dar 404.
  fs.writeFileSync(path.join(deploy, '_redirects'), '/blog/*  /:splat  301\n');

  if (semCapa.length) console.warn(`AVISO — sem capa detectada (${semCapa.length}): ${semCapa.join(', ')}`);
  console.log(`OK — ${count} páginas geradas em deploy/ | capas baixadas: ${auto.length - semCapa.length} (domínio: ${DOMAIN})`);
})();
