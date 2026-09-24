'use strict';
// Servidor da assistente de WhatsApp da Mafuz (Gabi).
// Z-API (webhook) -> fila com agrupamento de mensagens -> agente (LLM + Imoview) -> Z-API.

const http = require('http');
const { config, validar } = require('./config');
const { Store } = require('./store');
const { ZApi, mascarar } = require('./zapi');
const { SiteLinks } = require('./site');
const { Imoview } = require('./imoview');
const { LLM } = require('./llm');
const { Agente } = require('./agent');
const { Catalogo } = require('./catalogo');
const { log, digitos, dentroDoHorario, foneExibicao, sleep } = require('./util');

const VERSAO = '1.0.0';
const inicio = Date.now();

const store = new Store(config.dataDir, { conversaTtlDias: config.comportamento.conversaTtlDias });
const zapi = new ZApi(config.zapi);
const site = new SiteLinks(config.site);
const imoview = new Imoview(config.imoview, site, config.comportamento.limiteAltoTicket);
const llm = new LLM({ ...config.llm, modeloTranscricao: config.comportamento.modeloTranscricao });
const catalogo = new Catalogo({ imoview, site, config });
const agente = new Agente({ config, store, zapi, imoview, llm, catalogo });

// Rastro dos últimos webhooks recebidos e do que foi decidido com cada um (diagnóstico em /admin/estado).
const rastro = [];
function rastrear(p, decisao, extra = {}) {
  rastro.push({
    ts: new Date().toISOString(),
    fone: p && p.phone ? String(p.phone).slice(-6) : '',
    tipo: p && p.type,
    fromMe: !!(p && p.fromMe),
    fromApi: !!(p && p.fromApi),
    texto: p && p.text && p.text.message ? String(p.text.message).slice(0, 30) : '',
    decisao,
    ...extra,
  });
  if (rastro.length > 200) rastro.splice(0, rastro.length - 200);
}

// ---------------- telefones ----------------
// Compara números brasileiros ignorando 55 e o 9º dígito (o WhatsApp às vezes omite).
function chaveFone(f) {
  let d = digitos(f);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : d;
}
const mesmoFone = (a, b) => chaveFone(a) === chaveFone(b);
const internos = () => [...config.equipe.admins, ...config.equipe.alertas];
const ehInterno = (fone) => internos().some((x) => mesmoFone(x, fone));
// Modo teste: um número da equipe passa a conversar com o agente como se fosse cliente
// (comandos com # continuam funcionando). Ligado/desligado por #teste.
const emModoTeste = (fone) => !!(store.global.testers && store.global.testers[chaveFone(fone)]);

function botAtivo() {
  return store.global.botAtivo === null || store.global.botAtivo === undefined ? config.comportamento.botAtivo : store.global.botAtivo;
}

function acharConversa(foneDigitado) {
  const alvo = digitos(foneDigitado);
  if (!alvo) return null;
  const chave = Object.keys(store.conversas).find((k) => mesmoFone(k, alvo));
  if (chave) return chave;
  return alvo.length <= 11 ? '55' + alvo : alvo;
}

// ---------------- fila por cliente (agrupa mensagens quebradas) ----------------
const filas = new Map();

function enfileirar(fone, item) {
  let f = filas.get(fone);
  if (!f) {
    f = { itens: [], timer: null, rodando: false };
    filas.set(fone, f);
  }
  f.itens.push(item);
  clearTimeout(f.timer);
  f.timer = setTimeout(() => processarFila(fone), config.comportamento.debounceMs);
}

async function processarFila(fone) {
  const f = filas.get(fone);
  if (!f) return;
  f.timer = null;
  if (f.rodando) return; // o término da rodada atual reagenda
  const itens = f.itens.splice(0);
  if (!itens.length) return filas.delete(fone);
  f.rodando = true;
  try {
    await atender(fone, itens);
  } catch (e) {
    log('atender_erro', { fone: mascarar(fone), erro: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
  } finally {
    f.rodando = false;
    if (f.itens.length && !f.timer) f.timer = setTimeout(() => processarFila(fone), 1500);
    else if (!f.itens.length && !f.timer) filas.delete(fone);
  }
}

async function montarTexto(itens, conv) {
  const partes = [];
  let audio = false;
  for (const it of itens) {
    if (it.nome && !conv.nome) conv.nome = limparNome(it.nome);
    if (it.audioUrl) {
      audio = true;
      let transcrito = null;
      if (config.comportamento.transcreverAudio) {
        try {
          const r = await fetch(it.audioUrl, { signal: AbortSignal.timeout(30000) });
          if (r.ok) transcrito = await llm.transcrever(Buffer.from(await r.arrayBuffer()), it.mime || 'audio/ogg');
        } catch (e) {
          log('transcricao_erro', { erro: e.message });
        }
      }
      partes.push(transcrito ? `[áudio] ${transcrito}` : '[o cliente enviou um áudio que não pôde ser transcrito; peça com gentileza que escreva]');
    } else if (it.midia && !it.texto) {
      partes.push(`[o cliente enviou ${it.midia} sem texto]`);
    } else if (it.texto) {
      partes.push(it.texto);
    }
  }
  return { texto: partes.join('\n').trim(), audio };
}

function limparNome(n) {
  const s = String(n || '')
    .replace(/[^\p{L}\s'.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 ? s.split(' ').slice(0, 3).join(' ').slice(0, 60) : '';
}

async function detectarOrigem(conv, texto) {
  // Mensagem padrão do site: "Sou {nome} e tenho interesse neste imóvel: ... 🔖 Código: 17095"
  const nome = texto.match(/\bSou ([A-ZÀ-Ý][\p{L}'-]+(?: [A-ZÀ-Ý][\p{L}'-]+){0,3})/u);
  if (nome) conv.nome = limparNome(nome[1]);
  const m = texto.match(/c[óo]d(?:igo|\.)?\s*[:#]?\s*(\d{2,7})\b/i);
  if (!m || (conv.origem && conv.origem.codigo === m[1])) return;
  try {
    const ficha = await imoview.detalhar(m[1]);
    if (ficha) {
      conv.origem = { codigo: ficha.codigo, titulo: `${ficha.tipo}, ${ficha.bairro}, ${ficha.preco_formatado}`, url: ficha.url };
      agente.registrarImoveis(conv, [ficha]);
      conv.qualificacao.codigo_imovel_interesse = conv.qualificacao.codigo_imovel_interesse || ficha.codigo;
      if (ficha.finalidade) conv.qualificacao.finalidade = conv.qualificacao.finalidade || (/loca/i.test(ficha.finalidade) ? 'alugar' : 'comprar');
    }
  } catch (e) {
    log('origem_erro', { erro: e.message });
  }
}

async function enviarResposta(fone, texto) {
  let partes = texto.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (partes.length > 6) partes = [...partes.slice(0, 5), partes.slice(5).join('\n\n')];
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i];
    agente.marcarEnviado(fone, p);
    const digitando = i === 0 ? 2 : Math.min(6, 1 + Math.round(p.length / 90));
    await zapi.enviarTexto(fone, p, { delayTyping: digitando });
  }
}

async function atender(fone, itens) {
  const conv = store.conversa(fone);
  const { texto, audio } = await montarTexto(itens, conv);
  if (!texto) return;
  if (store.pausado(fone) || !botAtivo()) {
    store.adicionarHistorico(conv, 'cliente', texto);
    return;
  }

  const primeira = conv.historico.length === 0;
  await detectarOrigem(conv, texto);
  conv.turnosCliente += 1;
  conv.turnosSemAvanco += 1;
  const sinais = {
    primeiraMensagem: primeira,
    audio,
    negociacao: agente.detectarNegociacao(texto),
    limiteTurnos: conv.turnosSemAvanco >= config.comportamento.maxTurnosSemAvanco,
  };

  // Falha do modelo: tenta de novo em silêncio; se falhar outra vez, avisa o cliente com gentileza,
  // alerta a equipe e segue disponível (o agente nunca fica mudo por conta de um erro).
  let resposta;
  for (let tentativa = 1; tentativa <= 3 && !resposta; tentativa++) {
    try {
      resposta = await agente.responder(conv, texto, sinais);
    } catch (e) {
      log('llm_erro', { fone: mascarar(fone), tentativa, erro: e.message });
      if (tentativa < 3) await sleep(2500 * tentativa);
    }
  }
  store.adicionarHistorico(conv, 'cliente', texto);

  if (!resposta) {
    const msg = 'Me dá só um minutinho, estou confirmando isso para você e já te respondo por aqui.';
    await enviarResposta(fone, msg).catch(() => {});
    store.adicionarHistorico(conv, 'agente', msg);
    await agente
      .alertarEquipe(`⚠️ FALHA TÉCNICA: a ${config.agente.nome} não conseguiu responder agora.\nCliente: ${conv.nome || 'sem nome'} · ${foneExibicao(fone)}\nhttps://wa.me/${fone}\nÚltima mensagem: "${texto.slice(0, 300)}"\nSe puder, responda o cliente pelo WhatsApp da Mafuz.`)
      .catch(() => {});
    return;
  }

  const enviarAlertas = async () => {
    for (const montar of resposta.turno.alertas || []) {
      try {
        await agente.alertarEquipe(montar());
      } catch (e) {
        log('alerta_erro', { erro: e.message });
      }
    }
  };

  // Se alguém da equipe assumiu enquanto o modelo pensava, não envia ao cliente.
  if (store.pausado(fone) && !resposta.turno.transferiu) {
    log('resposta_descartada_humano_assumiu', { fone: mascarar(fone) });
    return enviarAlertas();
  }
  if (resposta.texto) {
    store.adicionarHistorico(conv, 'agente', resposta.texto);
    await enviarResposta(fone, resposta.texto);
  }
  await enviarAlertas();
  store.evento('resposta', { fone, ferramentas: resposta.turno.ferramentas });
}

// ---------------- comandos da equipe ----------------
async function comando(fone, texto) {
  const [cmd, ...resto] = texto.trim().split(/\s+/);
  const arg = resto.join(' ');
  let r;
  switch (cmd.toLowerCase()) {
    case '#status': {
      const dia = Date.now() - 86400000;
      const ativas = Object.values(store.conversas).filter((c) => c.atualizadaEm > dia).length;
      const pausadas = Object.values(store.conversas).filter((c) => c.pausadoAte > Date.now());
      const leadsHoje = Object.values(store.leads).filter((l) => Date.parse(l.atualizadoEm) > dia).length;
      const visitas = store.visitas.filter((v) => v.status === 'aguardando_confirmacao').length;
      r = [
        `${config.agente.nome} ${botAtivo() ? 'LIGADA' : 'DESLIGADA'} · modo ${config.comportamento.modo}${emModoTeste(fone) ? ' · você está em MODO TESTE' : ''}`,
        `Carteira carregada: ${catalogo.itens.length} imóveis`,
        `Conversas nas últimas 24h: ${ativas}`,
        `Leads atualizados nas últimas 24h: ${leadsHoje}`,
        `Pedidos de visita registrados: ${visitas}`,
        `Em silêncio (humano atendendo): ${pausadas.length}${pausadas.length ? '\n' + pausadas.slice(0, 10).map((c) => `- ${c.nome || ''} ${foneExibicao(c.fone)}`).join('\n') : ''}`,
      ].join('\n');
      break;
    }
    case '#pausar': {
      const alvo = acharConversa(arg);
      if (!alvo) r = 'Use: #pausar 5531999999999';
      else {
        store.pausar(alvo, 24 * 30, 'pausado_pela_equipe');
        r = `Ok. O assistente não responde mais ${foneExibicao(alvo)} até alguém mandar #retomar ${alvo}.`;
      }
      break;
    }
    case '#retomar': {
      const alvo = acharConversa(arg);
      if (!alvo) r = 'Use: #retomar 5531999999999';
      else {
        store.conversa(alvo);
        store.retomar(alvo);
        r = `Ok. O assistente volta a responder ${foneExibicao(alvo)} na próxima mensagem do cliente.`;
      }
      break;
    }
    case '#teste': {
      store.global.testers = store.global.testers || {};
      const chave = chaveFone(fone);
      const ligar = /off|desliga|sair|parar/i.test(arg) ? false : /on|liga/i.test(arg) ? true : !store.global.testers[chave];
      if (ligar) store.global.testers[chave] = true;
      else delete store.global.testers[chave];
      store.tocar();
      r = ligar
        ? `Modo teste LIGADO: a partir de agora você conversa com a ${config.agente.nome} como se fosse um cliente (os alertas também chegam aqui). Para recomeçar do zero: #reset. Para sair: #teste off`
        : 'Modo teste DESLIGADO: este número volta a ser só da equipe (alertas e comandos).';
      break;
    }
    case '#reset': {
      const alvo = arg ? acharConversa(arg) : Object.keys(store.conversas).find((k) => mesmoFone(k, fone)) || fone;
      delete store.conversas[alvo];
      delete store.leads[alvo];
      store.visitas = store.visitas.filter((v) => !mesmoFone(v.fone, alvo));
      store.tocar();
      r = `Conversa de ${foneExibicao(alvo)} apagada. A próxima mensagem começa um atendimento novo.`;
      break;
    }
    case '#desligar':
      store.global.botAtivo = false;
      store.tocar();
      r = 'Assistente DESLIGADO para todos os clientes. O número segue funcionando normalmente para a equipe. Para religar: #ligar';
      break;
    case '#ligar':
      store.global.botAtivo = true;
      store.tocar();
      r = 'Assistente LIGADO.';
      break;
    case '#leads': {
      const l = Object.values(store.leads)
        .sort((a, b) => Date.parse(b.atualizadoEm) - Date.parse(a.atualizadoEm))
        .slice(0, 8);
      r = l.length
        ? l.map((x) => `${x.temperatura || '-'} · ${x.nome || 'sem nome'} · ${foneExibicao(x.fone)} · ${agente.resumoBusca(x.qualificacao || {})}`).join('\n')
        : 'Nenhum lead ainda.';
      break;
    }
    default:
      r = 'Comandos: #status · #leads · #pausar <número> · #retomar <número> · #desligar · #ligar · #teste (conversar com o agente como cliente) · #reset (apagar sua conversa de teste)';
  }
  agente.marcarEnviado(fone, r);
  await zapi.enviarTexto(fone, r).catch((e) => log('comando_erro', { erro: e.message }));
  store.evento('comando', { de: fone, cmd });
}

// ---------------- webhook Z-API ----------------
async function processarWebhook(p) {
  if (!p || typeof p !== 'object') return;
  if (p.type && p.type !== 'ReceivedCallback') return; // status, presença etc.
  if (p.isGroup || p.isNewsletter || p.broadcast || p.isStatusReply) return rastrear(p, 'ignorado: grupo/canal/status');
  if (p.isEdit) return rastrear(p, 'ignorado: mensagem editada');
  if (p.reaction || p.notification) return rastrear(p, 'ignorado: reação/notificação');
  const fone = digitos(p.phone);
  if (!fone || fone.length < 10) return rastrear(p, 'ignorado: telefone inválido');
  if (store.jaProcessado(p.messageId)) return rastrear(p, 'ignorado: repetida');

  const texto = (
    (p.text && p.text.message) ||
    (p.image && p.image.caption) ||
    (p.video && p.video.caption) ||
    (p.document && p.document.caption) ||
    (p.buttonsResponseMessage && p.buttonsResponseMessage.message) ||
    (p.listResponseMessage && (p.listResponseMessage.title || p.listResponseMessage.message)) ||
    (p.hydratedTemplate && p.hydratedTemplate.message) ||
    ''
  ).trim();

  // Mensagem que saiu do próprio número da Mafuz.
  if (p.fromMe) {
    if (p.fromApi || agente.foiEnviadoPorNos(fone, texto)) return rastrear(p, 'enviada pela assistente');
    if (ehInterno(fone)) return rastrear(p, 'enviada para a equipe');
    // Alguém da equipe respondeu pelo celular / WhatsApp Web: a assistente se cala nesta conversa.
    store.pausar(fone, config.comportamento.pausaHumanoHoras, 'humano_assumiu');
    const f = filas.get(fone);
    if (f) {
      clearTimeout(f.timer);
      f.itens = [];
    }
    log('humano_assumiu', { fone: mascarar(fone) });
    store.evento('humano_assumiu', { fone });
    return rastrear(p, 'corretor assumiu: assistente em silêncio');
  }

  if (ehInterno(fone)) {
    if (texto.startsWith('#')) {
      rastrear(p, 'comando da equipe');
      return comando(fone, texto);
    }
    if (!emModoTeste(fone)) return rastrear(p, 'ignorado: número da equipe (use #teste para conversar)');
  }

  const item = { texto, nome: p.senderName || p.chatName || '', ts: p.momment || Date.now() };
  if (p.audio && p.audio.audioUrl) Object.assign(item, { audioUrl: p.audio.audioUrl, mime: p.audio.mimeType });
  else if (!texto) {
    if (p.image) item.midia = 'uma imagem';
    else if (p.video) item.midia = 'um vídeo';
    else if (p.document) item.midia = 'um documento';
    else if (p.sticker) item.midia = 'uma figurinha';
    else if (p.location) item.midia = 'uma localização';
    else if (p.contact) item.midia = 'um contato';
    else return rastrear(p, p.waitingMessage ? 'ignorado: WhatsApp ainda aguardando a mensagem' : 'ignorado: sem texto');
  }

  if (!botAtivo()) return rastrear(p, 'ignorado: assistente desligada');
  if (config.comportamento.modo === 'fora_do_horario' && dentroDoHorario(config.comportamento.horario)) {
    return rastrear(p, 'ignorado: horário comercial');
  }
  if (store.pausado(fone)) {
    const conv = store.conversa(fone);
    if (item.texto) store.adicionarHistorico(conv, 'cliente', item.texto);
    return rastrear(p, 'ignorado: corretor atendendo');
  }
  rastrear(p, 'na fila para responder');
  enfileirar(fone, item);
}

// Situação da conexão do WhatsApp na Z-API (consultada no máximo a cada 60 s).
let statusWhats = { valor: 'não verificado', ts: 0 };
async function situacaoWhatsApp() {
  if (Date.now() - statusWhats.ts < 60000) return statusWhats.valor;
  try {
    const st = await zapi.status();
    statusWhats = { valor: st && st.connected && st.smartphoneConnected !== false ? 'conectado' : 'DESCONECTADO: reconecte pelo QR Code na Z-API', ts: Date.now() };
  } catch (e) {
    statusWhats = { valor: `erro ao consultar a Z-API: ${e.message.slice(0, 120)}`, ts: Date.now() };
  }
  if (!/^conectado/.test(statusWhats.valor)) log('whatsapp_desconectado', { situacao: statusWhats.valor });
  return statusWhats.valor;
}

// ---------------- HTTP ----------------
function lerCorpo(req, limite = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > limite) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

function responderJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

function autorizadoAdmin(url) {
  return !!config.adminToken && url.searchParams.get('token') === config.adminToken;
}

function csv(linhas) {
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  return linhas.map((l) => l.map(esc).join(';')).join('\n');
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return responderJson(res, 200, {
        ok: true,
        servico: `${config.agente.nome} (${config.agente.empresa}): agente WhatsApp`,
        carteira: catalogo.itens.length,
        whatsapp: await situacaoWhatsApp(),
        versao: VERSAO,
        assistente: botAtivo() ? 'ligado' : 'desligado',
        modo: config.comportamento.modo,
        provedor_llm: config.llm.provedor,
        conversas: Object.keys(store.conversas).length,
        no_ar_ha_min: Math.round((Date.now() - inicio) / 60000),
        config_faltando: validar(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/webhook/zapi') {
      if (!config.webhookSecret || url.searchParams.get('secret') !== config.webhookSecret) {
        return responderJson(res, 401, { erro: 'secret inválido' });
      }
      const corpo = await lerCorpo(req);
      responderJson(res, 200, { recebido: true });
      let p;
      try {
        p = JSON.parse(corpo || '{}');
      } catch {
        return;
      }
      processarWebhook(p).catch((e) => log('webhook_erro', { erro: e.message }));
      return;
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!autorizadoAdmin(url)) return responderJson(res, 401, { erro: 'token inválido' });

      if (url.pathname === '/admin/configurar-webhook') {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const destino = `${proto}://${host}/webhook/zapi?secret=${encodeURIComponent(config.webhookSecret)}`;
        const r = await zapi.configurarWebhook(destino, { notificarEnviadasPorMim: true });
        return responderJson(res, 200, { ok: true, webhook: destino.replace(config.webhookSecret, '••••'), zapi: r });
      }

      if (url.pathname === '/admin/diagnostico') {
        const out = {};
        try {
          out.zapi = await zapi.status();
        } catch (e) {
          out.zapi = { erro: e.message };
        }
        try {
          const r = await imoview.buscar({ finalidade: 'venda', cidade: 'Nova Lima', limite: 1 });
          out.imoview = { ok: true, total_venda_nova_lima: r.total_encontrado, exemplo: r.imoveis[0] && { codigo: r.imoveis[0].codigo, url: r.imoveis[0].url } };
        } catch (e) {
          out.imoview = { erro: e.message };
        }
        try {
          const r = await llm.conversar({ sistema: 'Responda apenas: ok', mensagens: [{ role: 'user', content: 'teste' }], ferramentas: [] });
          out.llm = { ok: true, provedor: config.llm.provedor, resposta: r.texto.slice(0, 40) };
        } catch (e) {
          out.llm = { erro: e.message };
        }
        return responderJson(res, 200, out);
      }

      // Conversa de teste com o modelo real, sem enviar nada pelo WhatsApp e sem alertar a equipe.
      // Ex.: /admin/simular?token=...&conversa=1&texto=oi   (&reset=1 apaga a conversa de teste)
      if (url.pathname === '/admin/simular') {
        const chave = 'simulacao-' + String(url.searchParams.get('conversa') || '1').replace(/\W/g, '').slice(0, 20);
        if (url.searchParams.get('reset')) delete store.conversas[chave];
        const texto = String(url.searchParams.get('texto') || '').trim();
        if (!texto) return responderJson(res, 200, { ok: true, conversa: chave, apagada: !!url.searchParams.get('reset') });
        const conv = store.conversa(chave);
        if (!conv.nome) conv.nome = String(url.searchParams.get('nome') || 'Cliente Teste');
        await detectarOrigem(conv, texto);
        const sinais = { primeiraMensagem: conv.historico.length === 0, negociacao: agente.detectarNegociacao(texto), simulacao: true };
        const t0 = Date.now();
        const r = await agente.responder(conv, texto, sinais);
        store.adicionarHistorico(conv, 'cliente', texto);
        store.adicionarHistorico(conv, 'agente', r.texto);
        delete store.leads[chave];
        store.visitas = store.visitas.filter((v) => v.fone !== chave);
        return responderJson(res, 200, {
          conversa: chave,
          segundos: Math.round((Date.now() - t0) / 100) / 10,
          mensagens: r.texto.split(/\n\s*\n/).map((m) => m.trim()).filter(Boolean),
          ferramentas: r.turno.ferramentas,
          alertas_para_equipe: (r.turno.alertas || []).map((f) => f()),
        });
      }

      if (url.pathname === '/admin/leads.csv') {
        const linhas = [['atualizado_em', 'nome', 'telefone', 'temperatura', 'finalidade', 'tipo', 'cidade', 'bairros', 'preco_min', 'preco_max', 'quartos', 'prazo', 'pagamento', 'imovel_interesse', 'observacoes']];
        for (const l of Object.values(store.leads)) {
          const q = l.qualificacao || {};
          linhas.push([l.atualizadoEm, l.nome, l.fone, l.temperatura, q.finalidade, q.tipo, q.cidade, [].concat(q.bairros || []).join(', '), q.preco_min, q.preco_max, q.dormitorios, q.prazo, q.pagamento, q.codigo_imovel_interesse, q.observacoes]);
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads-mafuz-ia.csv"' });
        return res.end('﻿' + csv(linhas));
      }

      if (url.pathname === '/admin/conversa') {
        const alvo = acharConversa(url.searchParams.get('fone') || '');
        const c = alvo && store.conversas[alvo];
        return responderJson(res, c ? 200 : 404, c || { erro: 'conversa não encontrada' });
      }

      if (url.pathname === '/admin/estado') {
        return responderJson(res, 200, {
          config: {
            assistente: config.agente.nome,
            site: config.site.url,
            modelo: config.llm.provedor === 'openai' ? config.llm.openaiModelo : config.llm.anthropicModelo,
            numeros_equipe: config.equipe.alertas.map((n) => '••' + n.slice(-4)),
            em_modo_teste: Object.keys(store.global.testers || {}).map((n) => '••' + n.slice(-4)),
          },
          catalogo: catalogo.status(),
          webhooks_recentes: rastro.slice(-40),
          assistente: botAtivo() ? 'ligado' : 'desligado',
          conversas: Object.values(store.conversas)
            .sort((a, b) => b.atualizadaEm - a.atualizadaEm)
            .slice(0, 50)
            .map((c) => ({
              fone: c.fone,
              nome: c.nome,
              atualizada: new Date(c.atualizadaEm).toISOString(),
              mensagens: c.historico.length,
              temperatura: c.temperatura,
              em_silencio: c.pausadoAte > Date.now() ? c.motivoPausa : false,
            })),
          visitas: store.visitas.slice(-30),
          eventos: store.eventos.slice(-100),
        });
      }
    }

    responderJson(res, 404, { erro: 'rota não encontrada' });
  } catch (e) {
    log('http_erro', { rota: url.pathname, erro: e.message });
    if (!res.headersSent) responderJson(res, 500, { erro: 'erro interno' });
  }
});

function iniciar() {
  const faltando = validar();
  if (faltando.length) log('config_incompleta', { faltando });
  servidor.listen(config.porta, () => {
    log('servidor_no_ar', { porta: config.porta, versao: VERSAO, modo: config.comportamento.modo, llm: config.llm.provedor });
  });
  if (config.imoview.chave) {
    imoview.garantirListas().catch(() => {});
    catalogo.iniciar(config.catalogo.sincronizarACadaMin);
  }
  const encerrar = () => {
    store.salvar(true);
    process.exit(0);
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}

if (require.main === module) iniciar();

module.exports = { servidor, processarWebhook, store, agente, imoview, catalogo, filas, iniciar, chaveFone, rastro };
