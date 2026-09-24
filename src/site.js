'use strict';
// Gera o link público do imóvel no site da MAFUZ.
// A página do imóvel no site usa o id interno da plataforma (/imovel/<uuid>), e cada
// imóvel sincronizado guarda o código do Imoview em "external_id". Consultamos a mesma
// API pública (somente leitura, chave "anon") que o próprio site usa no navegador.

const { log } = require('./util');

const TTL_MS = 6 * 3600000;

class SiteLinks {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map();
  }

  fallback(codigo) {
    return `${this.cfg.url}/imoveis?q=${encodeURIComponent(codigo)}`;
  }

  // Retorna Map codigo -> { url, pagina } (pagina=false quando o imóvel ainda não tem ficha no site).
  async resolver(codigos) {
    const saida = new Map();
    const faltam = [];
    const agora = Date.now();
    for (const c of codigos.map(String)) {
      const hit = this.cache.get(c);
      if (hit && agora - hit.ts < TTL_MS) saida.set(c, { url: hit.url, pagina: true });
      else faltam.push(c);
    }
    if (faltam.length && this.cfg.supabaseUrl && this.cfg.supabaseAnonKey) {
      try {
        const lista = faltam.map((c) => `"${c.replace(/"/g, '')}"`).join(',');
        const url =
          `${this.cfg.supabaseUrl}/rest/v1/properties?select=id,external_id` +
          `&status=eq.published&external_id=in.(${encodeURIComponent(lista)})`;
        const r = await fetch(url, {
          headers: { apikey: this.cfg.supabaseAnonKey, Authorization: `Bearer ${this.cfg.supabaseAnonKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          for (const row of await r.json()) {
            const link = `${this.cfg.url}/imovel/${row.id}`;
            this.cache.set(String(row.external_id), { url: link, ts: agora });
            saida.set(String(row.external_id), { url: link, pagina: true });
          }
        } else {
          log('site_links_http', { status: r.status });
        }
      } catch (e) {
        log('site_links_erro', { erro: e.message });
      }
    }
    for (const c of codigos.map(String)) if (!saida.has(c)) saida.set(c, { url: this.fallback(c), pagina: false });
    return saida;
  }
}

module.exports = { SiteLinks };
