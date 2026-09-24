'use strict';
// Catálogo local: a base INTEIRA do Imoview (venda e locação), com descrições,
// sincronizada a cada hora. Permite buscar por desejo ("vista para a lagoa", "pomar",
// "andar alto") lendo o texto de cada anúncio, e ranquear as melhores oportunidades.
// Antes de apresentar, os imóveis escolhidos são revalidados ao vivo no Imoview.

const { log, norm, parseValorBR, parseNumBR, formatarBRL, limparTitulo } = require('./util');
const { Imoview, DIFERENCIAIS, limparDescricao } = require('./imoview');

// Conceitos que o cliente costuma pedir -> como reconhecer no anúncio.
// pedido: como reconhecer o desejo na mensagem do cliente | re: como reconhecer no anúncio.
const CONCEITOS = [
  { rotulo: 'piscina', pedido: /piscin/, re: /piscin/, flags: ['piscina'] },
  { rotulo: 'espaço gourmet', pedido: /gourmet|churrasq/, re: /gourmet|churrasq/, flags: ['espacogourmet', 'varandagourmet', 'churrasqueira'] },
  { rotulo: 'vista para a lagoa', pedido: /lagoa|\blago\b/, re: /vista (para |pra |da |de )?(a |o )?(lagoa|lago)|frente (para |pra )?(a )?lagoa|beira da lagoa/, flags: ['vistalago'] },
  { rotulo: 'vista para a serra', pedido: /montanha|serra do curral|vista (para|pra|da) (a )?serra/, re: /vista (para |pra |da |de )?(a |as )?(montanha|serra)|serra do curral/, flags: ['vistamontanha'] },
  { rotulo: 'vista', pedido: /\bcom vista\b|\bvista (para|pra|da|do|bonita|linda|panoramica|livre|definitiva)/, re: /vista (para|pra|da|do|panoramica|definitiva|livre|privilegiada|linda|incrivel|espetacular|deslumbrante)/, flags: ['vistamontanha', 'vistalago', 'vistamar'] },
  { rotulo: 'aceita pets', pedido: /\bpets?\b|animal|animais|cachorr|gato/, re: /\bpets?\b|animais|aceita animal|cachorr/, flags: ['permiteanimais'] },
  { rotulo: 'mobiliado', pedido: /mobiliad/, re: /mobiliad/, flags: ['mobiliado'] },
  { rotulo: 'varanda', pedido: /varanda|sacada|terraco/, re: /varanda|sacada|terraco/, flags: ['varandagourmet'] },
  { rotulo: 'closet', pedido: /closet/, re: /closet/, flags: ['closet'] },
  { rotulo: 'lareira', pedido: /lareira/, re: /lareira/, flags: ['lareira'] },
  { rotulo: 'sauna', pedido: /sauna/, re: /sauna/, flags: ['sauna'] },
  { rotulo: 'academia', pedido: /academia|fitness/, re: /academia|fitness/, flags: ['academia'] },
  { rotulo: 'quadra', pedido: /quadra|tenis|beach/, re: /quadra (de |poliesportiva|esportiva)|beach tennis|\btenis\b/, flags: ['quadratenis', 'beachtenis', 'quadraesportiva'] },
  { rotulo: 'espaço para crianças', pedido: /crianca|filho|playground|brinquedoteca|kids/, re: /playground|brinquedoteca|crianca|kids/, flags: ['playground'] },
  { rotulo: 'andar alto', pedido: /andar alto|alto andar|ultimo andar|andares altos|bem alto/, re: /andar alto|alto andar|ultimo andar|andares altos/, flags: [] },
  { rotulo: 'sol da manhã', pedido: /sol da manha|nascente/, re: /sol da manha|nascente/, flags: ['solmanha'] },
  { rotulo: 'reformado', pedido: /reformad|retrofit/, re: /reformad|retrofit/, flags: [] },
  { rotulo: 'novo', pedido: /\bnov[oa]\b(?! lima)|primeiro morador|lancamento|na planta|construcao recente/, re: /(imovel|casa|apartamento|obra|construcao) nov[oa]|primeiro morador|lancamento|na planta|recem construid|nunca habitad/, flags: [] },
  { rotulo: 'área verde', pedido: /pomar|jardim|arvore|area verde|mata|natureza|verde|bosque/, re: /pomar|area verde|arvores|mata nativa|natureza|bosque/, flags: ['jardim', 'gramado'] },
  { rotulo: 'segurança 24h', pedido: /seguranc|portaria|condominio fechado/, re: /portaria|seguranc|condominio fechado/, flags: ['portaria24horas', 'seguranca24horas'] },
  { rotulo: 'pé-direito alto', pedido: /pe direito/, re: /pe direito (duplo|alto)/, flags: [] },
  { rotulo: 'elevador privativo', pedido: /elevador privativo/, re: /elevador privativo/, flags: [] },
  { rotulo: 'home office', pedido: /escritorio|home office|trabalho em casa/, re: /escritorio|home office/, flags: ['escritorio'] },
  { rotulo: 'adega', pedido: /adega|vinho/, re: /adega/, flags: [] },
  { rotulo: 'home cinema', pedido: /cinema/, re: /cinema/, flags: ['homecinema'] },
  { rotulo: 'suíte master', pedido: /suite master|suite principal/, re: /suite master|suite principal/, flags: [] },
  { rotulo: 'hidromassagem', pedido: /hidro|banheira|ofuro|\bspa\b/, re: /hidromassagem|banheira|ofuro|\bspa\b/, flags: ['hidromassagem'] },
  { rotulo: 'energia solar', pedido: /solar|fotovoltaic/, re: /aquecimento solar|energia solar|placas? solar|fotovoltaic/, flags: ['aquecedorsolar'] },
  { rotulo: 'automação', pedido: /automacao|automatizad|casa inteligente/, re: /automacao|automatizad/, flags: [] },
];

const STOP = new Set('para com uma umas uns que quero queria gostaria preciso procuro tenha tenho seja sejam perto proximo proxima casa apto apartamento imovel imoveis mais muito boa bom bem onde como algum alguma'.split(' '));

class Catalogo {
  constructor({ imoview, site, config }) {
    this.imoview = imoview;
    this.site = site;
    this.config = config;
    this.itens = [];
    this.porCodigo = new Map();
    this.medianas = new Map();
    this.ultimaSync = null;
    this.sincronizando = null;
    this.erro = null;
  }

  pronto() {
    return this.itens.length > 0;
  }

  status() {
    return {
      imoveis: this.itens.length,
      venda: this.itens.filter((i) => i.finalidade === 'venda').length,
      locacao: this.itens.filter((i) => i.finalidade === 'locacao').length,
      com_pagina_no_site: this.itens.filter((i) => i.pagina).length,
      ultima_sincronizacao: this.ultimaSync,
      erro: this.erro,
    };
  }

  iniciar(minutos = 60) {
    const rodar = () => this.sincronizar().catch((e) => log('catalogo_erro', { erro: e.message }));
    rodar();
    const t = setInterval(rodar, Math.max(15, minutos) * 60000);
    t.unref();
  }

  async pagina(finalidade, numero) {
    return this.imoview.req('POST', '/Imovel/RetornarImoveisDisponiveis', {
      corpo: { finalidade, numeroPagina: numero, numeroRegistros: 20 },
    });
  }

  async sincronizar() {
    if (this.sincronizando) return this.sincronizando;
    this.sincronizando = (async () => {
      const t0 = Date.now();
      try {
        await this.imoview.garantirListas();
        try {
          await this.site.carregarTodos();
        } catch (e) {
          log('catalogo_links_erro', { erro: e.message });
        }
        const brutos = [];
        for (const fin of [2, 1]) {
          const p1 = await this.pagina(fin, 1);
          brutos.push(...(p1.lista || []));
          const paginas = Math.ceil((p1.quantidade || 0) / 20);
          const fila = [];
          for (let n = 2; n <= paginas; n++) fila.push(n);
          const worker = async () => {
            while (fila.length) {
              const n = fila.shift();
              try {
                const d = await this.pagina(fin, n);
                brutos.push(...(d.lista || []));
              } catch (e) {
                log('catalogo_pagina_erro', { finalidade: fin, pagina: n, erro: e.message });
              }
            }
          };
          await Promise.all(Array.from({ length: 5 }, worker));
        }
        if (brutos.length < 100) throw new Error(`sincronização trouxe só ${brutos.length} imóveis`);
        const itens = [];
        const vistos = new Set();
        for (const b of brutos) {
          if (vistos.has(b.codigo)) continue;
          vistos.add(b.codigo);
          itens.push(this.compactar(b));
        }
        this.itens = itens;
        this.porCodigo = new Map(itens.map((i) => [i.codigo, i]));
        this.calcularMedianas();
        this.ultimaSync = new Date().toISOString();
        this.erro = null;
        log('catalogo_sincronizado', { imoveis: itens.length, segundos: Math.round((Date.now() - t0) / 1000) });
      } catch (e) {
        this.erro = e.message;
        log('catalogo_erro', { erro: e.message });
      } finally {
        this.sincronizando = null;
      }
    })();
    return this.sincronizando;
  }

  compactar(b) {
    const r = this.imoview.resumo(b);
    const descricao = limparDescricao(b.descricao).slice(0, 2500);
    const flags = Object.keys(DIFERENCIAIS).filter((k) => b[k] === true);
    const link = this.site.linkLocal(r.codigo);
    const cadastro = String(b.datahoracadastro || '').split(' ')[0].split('/').reverse().join('-');
    return {
      ...r,
      finalidade: /alug|loca/i.test(b.finalidade) ? 'locacao' : 'venda',
      grupo: Imoview.grupoTipo(r.tipo),
      codigoCidade: b.codigocidade,
      codigoBairro: b.codigobairro,
      bairroNorm: norm(r.bairro),
      precoAnterior: parseValorBR(b.valoranterior),
      titulo: limparTitulo(b.titulo),
      descricao,
      texto: norm(`${b.titulo} ${descricao} ${r.condominio || ''}`),
      flags,
      destaque: b.destaque || '',
      cadastro,
      unidade: String(b.nomeunidade || '').trim(),
      url: link.url,
      pagina: link.pagina,
      area_m2: r.area_m2 || parseNumBR(b.areainterna) || null,
    };
  }

  calcularMedianas() {
    const grupos = new Map();
    for (const i of this.itens) {
      if (!i.preco || !i.area_m2 || i.area_m2 < 20) continue;
      const k = `${i.finalidade}|${i.grupo}|${i.bairroNorm}`;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(i.preco / i.area_m2);
    }
    this.medianas = new Map();
    for (const [k, v] of grupos) {
      if (v.length < 8) continue;
      v.sort((a, b) => a - b);
      this.medianas.set(k, v[Math.floor(v.length / 2)]);
    }
  }

  // Por que este imóvel é uma boa oportunidade (só com base nos dados).
  oportunidade(i) {
    const motivos = [];
    let pontos = 0;
    if (i.precoAnterior && i.preco && i.precoAnterior > i.preco * 1.02) {
      const pct = Math.round((1 - i.preco / i.precoAnterior) * 100);
      motivos.push(`preço reduzido em ${pct}% (antes ${formatarBRL(i.precoAnterior)})`);
      pontos += Math.min(3, pct / 5);
    }
    const med = this.medianas.get(`${i.finalidade}|${i.grupo}|${i.bairroNorm}`);
    if (med && i.preco && i.area_m2 >= 20) {
      const m2 = i.preco / i.area_m2;
      const pct = Math.round((1 - m2 / med) * 100);
      if (pct >= 10 && pct <= 40) {
        motivos.push(`valor por m² cerca de ${pct}% abaixo da média de imóveis parecidos no bairro`);
        pontos += Math.min(3, pct / 10);
      }
    }
    if (i.cadastro) {
      const dias = (Date.now() - Date.parse(i.cadastro)) / 86400000;
      if (dias >= 0 && dias <= 30) {
        motivos.push('acabou de entrar na carteira');
        pontos += 0.5;
      }
    }
    return { pontos, motivos };
  }

  // Desejos do cliente -> conceitos + palavras soltas.
  interpretarDesejos(texto) {
    const t = norm(texto || '');
    if (!t) return { conceitos: [], palavras: [] };
    const conceitos = CONCEITOS.filter((c) => c.pedido.test(t));
    const palavras = t.split(' ').filter((p) => p.length >= 4 && !STOP.has(p) && !conceitos.some((c) => c.pedido.test(p)));
    return { conceitos, palavras };
  }

  pontuarDesejos(i, desejos) {
    let s = 0;
    const atende = [];
    for (const c of desejos.conceitos) {
      const porFlag = c.flags.some((f) => i.flags.includes(f));
      const porTexto = c.re.test(i.texto);
      if (porFlag || porTexto) {
        s += porFlag && porTexto ? 3 : 2;
        atende.push(c.rotulo);
      }
    }
    for (const p of desejos.palavras) if (i.texto.includes(p)) s += 1;
    return { s, atende };
  }

  filtrar(f, { cidade, bairros, tipos }) {
    const fin = f.finalidade === 'locacao' ? 'locacao' : 'venda';
    const setBairros = bairros && bairros.length ? new Set(bairros.map((b) => b.codigo)) : null;
    const setTipos = tipos && tipos.length ? new Set(tipos) : null;
    return this.itens.filter((i) => {
      if (i.finalidade !== fin) return false;
      if (cidade && i.codigoCidade !== cidade.codigo) return false;
      if (setBairros && !setBairros.has(i.codigoBairro)) return false;
      if (setTipos && !setTipos.has(norm(i.tipo))) return false;
      if (f.preco_min && (!i.preco || i.preco < f.preco_min)) return false;
      if (f.preco_max && (!i.preco || i.preco > f.preco_max)) return false;
      if (f.dormitorios_min && i.dormitorios < f.dormitorios_min) return false;
      if (f.suites_min && i.suites < f.suites_min) return false;
      if (f.vagas_min && i.vagas < f.vagas_min) return false;
      if (f.area_min && (!i.area_m2 || i.area_m2 < f.area_min)) return false;
      if (f.codigo && i.codigo !== String(f.codigo).replace(/\D/g, '')) return false;
      return true;
    });
  }

  tiposDoPedido(tipo) {
    if (!tipo) return null;
    const q = norm(tipo);
    const { GRUPOS_TIPO } = require('./imoview');
    const g = GRUPOS_TIPO[q] || Object.entries(GRUPOS_TIPO).find(([k]) => q.startsWith(k))?.[1];
    return g || [q];
  }

  resumoTexto(i) {
    const linhas = i.descricao.split('\n').map((l) => l.trim()).filter(Boolean);
    const corpo = linhas.filter((l) => !/bairro:|a venda|à venda|para alugar|^area construida|^área construída/i.test(l)).join(' ');
    const base = corpo || linhas.join(' ');
    if (base.length <= 260) return base;
    const corte = base.slice(0, 260);
    return corte.slice(0, corte.lastIndexOf(' ')) + '...';
  }

  saida(i, extra = {}) {
    const op = this.oportunidade(i);
    const destaques = [...new Set([...(extra.atende || []), ...i.flags.map((f) => DIFERENCIAIS[f]).filter(Boolean)])].slice(0, 6);
    return {
      codigo: i.codigo,
      tipo: i.tipo,
      bairro: i.bairro,
      cidade: i.cidade,
      condominio: i.condominio,
      preco: i.preco,
      preco_formatado: i.preco_formatado,
      dormitorios: i.dormitorios,
      suites: i.suites,
      vagas: i.vagas,
      area_m2: i.area_m2,
      area_lote_m2: i.area_lote_m2,
      resumo: this.resumoTexto(i),
      atende_ao_pedido: extra.atende && extra.atende.length ? extra.atende : undefined,
      destaques,
      oportunidade: op.motivos.length ? op.motivos : undefined,
      alto_ticket: i.alto_ticket,
      url: i.url,
      ...(i.pagina ? {} : { ficha_no_site: 'em publicação' }),
      ...(extra.alternativa ? { alternativa: true } : {}),
    };
  }

  // Confere ao vivo no Imoview (ficha de cada imóvel) se os escolhidos seguem disponíveis e com o mesmo preço.
  async revalidar(lista) {
    const checados = await Promise.all(
      lista.map(async (i) => {
        try {
          const r = await this.imoview.req('GET', '/Imovel/RetornarDetalhesImovelDisponivel', { query: { codigoImovel: i.codigo }, tentativas: 1 });
          const b = r && (r.imovel || (r.codigo ? r : null));
          if (!b || !b.codigo) {
            log('catalogo_imovel_saiu', { codigo: i.codigo });
            return null;
          }
          const preco = parseValorBR(b.valor);
          if (preco !== i.preco) Object.assign(i, { preco, preco_formatado: formatarBRL(preco) });
          return i;
        } catch (e) {
          return i; // sem resposta do CRM: mantém o dado da última sincronização
        }
      })
    );
    return checados.filter(Boolean);
  }

  async buscar(f = {}) {
    await this.imoview.garantirListas();
    const avisos = [];
    const aplicados = { finalidade: f.finalidade === 'locacao' ? 'locação' : 'venda' };
    let cidade = null;
    if (f.cidade) {
      cidade = this.imoview.resolverCidade(f.cidade);
      if (!cidade) {
        avisos.push(`A cidade "${f.cidade}" não tem imóveis publicados na carteira.`);
        return { total_encontrado: 0, imoveis: [], filtros_aplicados: aplicados, avisos, sugestao_alternativa: 'Pergunte se o cliente considera outra cidade da região ou ofereça a busca dedicada de 24h.' };
      }
      aplicados.cidade = cidade.nome;
    }
    let bairros = [];
    if (Array.isArray(f.bairros) && f.bairros.length) {
      const r = this.imoview.resolverBairros(f.bairros, cidade && cidade.codigo);
      bairros = r.encontrados;
      if (bairros.length) aplicados.bairros = bairros.map((b) => `${b.nome} (${b.cidade})`);
      if (r.naoEncontrados.length) avisos.push(`Sem imóveis publicados em: ${r.naoEncontrados.join(', ')}.`);
    }
    const tipos = this.tiposDoPedido(f.tipo);
    if (f.tipo) aplicados.tipo = f.tipo;
    for (const k of ['preco_min', 'preco_max', 'dormitorios_min', 'suites_min', 'vagas_min', 'area_min', 'codigo', 'texto_livre', 'ordenar']) if (f[k]) aplicados[k] = f[k];

    const desejos = this.interpretarDesejos(f.texto_livre);
    const limite = Math.min(Math.max(+f.limite || 5, 1), 5);

    const ranquear = (lista, extra = {}) => {
      const vistos = new Set();
      return lista
        .map((i, idx) => {
          const d = this.pontuarDesejos(i, desejos);
          const op = this.oportunidade(i);
          return { i, idx, d, op };
        })
        .filter(({ i }) => {
          const a = Imoview.assinatura(i);
          const d = `${i.texto.slice(0, 160)}|${Math.round(i.area_m2 || 0)}`;
          if (vistos.has(a) || (i.texto.length > 80 && vistos.has(d))) return false;
          vistos.add(a);
          vistos.add(d);
          return true;
        })
        .sort((a, b) => {
          if (f.ordenar === 'menor_preco') return (a.i.preco || 9e12) - (b.i.preco || 9e12);
          if (f.ordenar === 'maior_preco') return (b.i.preco || 0) - (a.i.preco || 0);
          if (f.ordenar === 'maior_area') return (b.i.area_m2 || 0) - (a.i.area_m2 || 0);
          return b.d.s - a.d.s || b.op.pontos - a.op.pontos || (b.i.pagina ? 1 : 0) - (a.i.pagina ? 1 : 0) || a.idx - b.idx;
        })
        .map(({ i, d }) => ({ i, extra: { ...extra, atende: d.atende } }));
    };

    const semBairroValido = f.bairros && f.bairros.length && !bairros.length;
    let achados = semBairroValido ? [] : this.filtrar(f, { cidade, bairros, tipos });
    let total = achados.length;
    let sugestao = null;
    let alternativa = false;

    if (!achados.length && !f.codigo) {
      // Recorte vizinho: outros bairros da mesma cidade, teto +20% ou uma suíte a menos.
      const cidadeRef =
        cidade || (bairros.length && bairros.every((b) => b.cidadeCodigo === bairros[0].cidadeCodigo) ? { codigo: bairros[0].cidadeCodigo, nome: bairros[0].cidade } : null);
      const tentativas = [];
      if ((bairros.length || semBairroValido) && (cidadeRef || f.tipo || f.preco_max)) tentativas.push({ f, c: cidadeRef, b: [], txt: `mesmos critérios em outros bairros${cidadeRef ? ' de ' + cidadeRef.nome : ''}` });
      if (f.preco_max) tentativas.push({ f: { ...f, preco_max: Math.round(f.preco_max * 1.2) }, c: cidade, b: bairros, txt: `teto de preço até ${formatarBRL(f.preco_max * 1.2)}` });
      if (f.suites_min > 1) tentativas.push({ f: { ...f, suites_min: f.suites_min - 1 }, c: cidade, b: bairros, txt: `com ${f.suites_min - 1} suítes ou mais` });
      for (const t of tentativas) {
        const alt = this.filtrar(t.f, { cidade: t.c, bairros: t.b, tipos });
        if (alt.length) {
          achados = alt;
          alternativa = true;
          sugestao = `Nada no recorte exato. Os imóveis listados são ALTERNATIVAS (${t.txt}). Deixe isso claro ao apresentar e ofereça também a busca dedicada de 24h.`;
          break;
        }
      }
      if (!achados.length) sugestao = 'Nada publicado nesse recorte nem em recortes vizinhos. Diga a verdade com leveza e ofereça a busca dedicada de 24h.';
    }

    let escolhidos = ranquear(achados, { alternativa }).slice(0, limite + 2);
    const vivos = await this.revalidar(escolhidos.map((x) => x.i));
    const setVivos = new Set(vivos.map((i) => i.codigo));
    escolhidos = escolhidos.filter((x) => setVivos.has(x.i.codigo)).slice(0, limite);

    return {
      total_encontrado: alternativa ? 0 : total,
      imoveis: escolhidos.map(({ i, extra }) => this.saida(i, extra)),
      filtros_aplicados: aplicados,
      avisos,
      ...(sugestao ? { sugestao_alternativa: sugestao } : {}),
      como_apresentar:
        'Use resumo, atende_ao_pedido, destaques e oportunidade para dizer em uma frase curta por que cada imóvel combina com o cliente. Não invente nada além desses dados.',
    };
  }
}

module.exports = { Catalogo, CONCEITOS };
