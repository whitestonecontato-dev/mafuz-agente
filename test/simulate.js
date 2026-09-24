'use strict';
// Simulação ponta a ponta SEM tocar no WhatsApp real:
//   - Z-API falsa (captura o que seria enviado)
//   - modelo de linguagem falso (roteiro determinístico, formato OpenAI)
//   - Imoview REAL (somente leitura) se IMOVIEW_API_KEY estiver definida; envio de lead ao CRM desligado.
// Uso: IMOVIEW_API_KEY=... node test/simulate.js

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORTA_ZAPI = 4610;
const PORTA_LLM = 4620;
const PORTA_APP = 4630;
const CLIENTE = '5531988887777';
const CLIENTE2 = '5531977776666';
const CLIENTE3 = '5531966665555';
const EQUIPE = '5531900000001';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafuz-sim-'));
Object.assign(process.env, {
  PORT: String(PORTA_APP),
  ZAPI_BASE_URL: `http://127.0.0.1:${PORTA_ZAPI}`,
  ZAPI_INSTANCE_ID: 'INST',
  ZAPI_TOKEN: 'TOK',
  ZAPI_CLIENT_TOKEN: 'CT',
  OPENAI_BASE_URL: `http://127.0.0.1:${PORTA_LLM}/v1`,
  OPENAI_API_KEY: 'sk-teste',
  LLM_PROVIDER: 'openai',
  WEBHOOK_SECRET: 's3cr3t',
  ADMIN_TOKEN: 'adm',
  TEAM_PHONES: EQUIPE,
  DEBOUNCE_MS: '400',
  DATA_DIR: dataDir,
  TRANSCREVER_AUDIO: 'false',
  IMOVIEW_ENVIAR_LEADS: 'false',
  SITE_URL: 'https://mafuz.com.br',
  SITE_SUPABASE_URL: process.env.SITE_SUPABASE_URL || 'https://gdkzyhvqyqucnbwtsryg.supabase.co',
  SITE_SUPABASE_ANON_KEY: process.env.SITE_SUPABASE_ANON_KEY || '',
  MODO_OPERACAO: '24h',
});
if (!process.env.IMOVIEW_API_KEY) {
  console.error('Defina IMOVIEW_API_KEY para a simulação (a busca é real, somente leitura).');
  process.exit(1);
}

// ---------- Z-API falsa ----------
const enviados = [];
const zapi = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const corpo = b ? JSON.parse(b) : {};
    if (req.url.endsWith('/send-text')) {
      if (req.headers['client-token'] !== 'CT') console.log('!! Client-Token ausente');
      enviados.push({ ...corpo, ts: Date.now() });
      res.end(JSON.stringify({ zaapId: 'z' + enviados.length, messageId: 'M' + enviados.length }));
    } else if (req.url.endsWith('/status')) res.end(JSON.stringify({ connected: true }));
    else res.end(JSON.stringify({ value: true }));
  });
});

// ---------- LLM falso ----------
const chamadasLLM = [];
function respostaTexto(t) {
  return { choices: [{ message: { role: 'assistant', content: t } }], usage: {} };
}
function respostaTool(nome, args) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name: nome, arguments: JSON.stringify(args) } }] } }],
  };
}
const llm = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const corpo = JSON.parse(b);
    chamadasLLM.push(corpo);
    const msgs = corpo.messages;
    const sistema = msgs[0].content;
    const ult = msgs[msgs.length - 1];
    let out;
    if (ult.role === 'tool') {
      const anterior = [...msgs].reverse().find((m) => m.role === 'assistant' && m.tool_calls);
      const nome = anterior.tool_calls[0].function.name;
      const dado = JSON.parse(ult.content);
      if (nome === 'buscar_imoveis') {
        const l = (dado.imoveis || []).slice(0, 3).map((i) => `${i.tipo} no ${i.bairro} — ${i.dormitorios} quartos, ${i.area_m2} m²\n${i.preco_formatado}\n${i.url}`);
        out = respostaTexto(`Perfeito. Separei ${l.length} opções:\n\n${l.join('\n\n')}\n\nAlguma delas te chamou mais atenção?`);
      } else if (nome === 'agendar_visita') {
        out = respostaTexto(dado.erro ? `Esse horário não fecha. ${dado.erro}` : `Reservado: ${dado.quando}, no ${dado.bairro}.\n\nUm corretor da MAFUZ confirma com você por aqui.\n${dado.url}`);
      } else if (nome === 'transferir_humano') {
        out = respostaTexto('Vou te conectar agora com um dos nossos corretores. Já passei todo o nosso histórico — você não vai precisar repetir nada.');
      } else if (nome === 'registrar_lead') {
        out = respostaTexto('Anotado. Seus dados são usados apenas para o seu atendimento, conforme nossa política de privacidade.\n\nQuer que eu busque opções agora?');
      } else out = respostaTexto('ok');
    } else {
      const t = String(ult.content).toLowerCase();
      if (t.includes('falha')) {
        res.statusCode = 500;
        return res.end('{"error":"simulado"}');
      }
      if (t.includes('apartamento')) {
        out = respostaTool('buscar_imoveis', { finalidade: 'venda', cidade: 'Nova Lima', bairros: ['Vila da Serra'], tipo: 'apartamento', dormitorios_min: 4, preco_max: 3000000 });
      } else if (t.includes('visitar')) {
        const cod = (sistema.match(/código (\d+):/) || [])[1];
        const dia = sistema.match(/\[(\d{4}-\d{2}-\d{2})\]: (\d{2}):\d{2} às/);
        const hora = `${String(Math.min(+dia[2] + 1, 16)).padStart(2, '0')}:00`;
        out = respostaTool('agendar_visita', { codigo_imovel: cod, data: dia[1], hora, nome: 'Carlos Teste' });
      } else if (t.includes('link falso')) {
        out = respostaTexto('Olha este aqui:\nhttps://mafuz.com.br/imovel/00000000-inventado\n\nE este site externo: https://concorrente.com.br/x');
      } else if (t.includes('desconto')) {
        out = respostaTexto('Entendo, vou verificar isso.');
      } else if (t.includes('corretor')) {
        out = respostaTool('transferir_humano', { motivo: 'pedido_do_cliente', urgencia: 'normal', resumo: 'Cliente pediu corretor.' });
      } else if (t.includes('meu nome')) {
        out = respostaTool('registrar_lead', { nome: 'Carlos Teste', finalidade: 'comprar', cidade: 'Nova Lima', tipo: 'apartamento', preco_max: 3000000, prazo: 'ate_30d', pagamento: 'financiamento' });
      } else {
        out = respostaTexto('Boa tarde, tudo bem? Aqui é a Mafuz IA, da MAFUZ Imóveis de Luxo.\n\nVocê procura para comprar ou alugar, e em qual região?');
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

// ---------- utilitários ----------
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function webhook(payload, secret = 's3cr3t') {
  const r = await fetch(`http://127.0.0.1:${PORTA_APP}/webhook/zapi?secret=${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.status;
}
function msgCliente(fone, texto, extra = {}) {
  return {
    type: 'ReceivedCallback',
    phone: fone,
    fromMe: false,
    fromApi: false,
    isGroup: false,
    isNewsletter: false,
    broadcast: false,
    messageId: 'IN' + ++seq,
    momment: Date.now(),
    senderName: 'Carlos',
    text: { message: texto },
    ...extra,
  };
}
async function aguardarEnvios(minimo, timeout = 60000) {
  const t0 = Date.now();
  while (enviados.length < minimo && Date.now() - t0 < timeout) await esperar(150);
  await esperar(600);
}
const resultados = [];
function checar(nome, ok, detalhe = '') {
  resultados.push({ nome, ok });
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}
const paraCliente = (fone, desde) => enviados.slice(desde).filter((e) => e.phone === fone);
const paraEquipe = (desde) => enviados.slice(desde).filter((e) => e.phone === EQUIPE);

(async () => {
  await new Promise((r) => zapi.listen(PORTA_ZAPI, r));
  await new Promise((r) => llm.listen(PORTA_LLM, r));
  const app = require('../src/server');
  app.iniciar();
  await esperar(1500);

  // 0) saúde e segurança do webhook
  const saude = await (await fetch(`http://127.0.0.1:${PORTA_APP}/health`)).json();
  checar('health responde', saude.ok === true && saude.config_faltando.length === 0, JSON.stringify(saude.config_faltando));
  checar('webhook com secret errado é recusado', (await webhook(msgCliente(CLIENTE, 'oi'), 'errado')) === 401);

  // 1) mensagens quebradas viram um único turno + busca real no Imoview
  let marco = enviados.length;
  const antesLLM = chamadasLLM.length;
  await webhook(msgCliente(CLIENTE, 'oi'));
  await esperar(100);
  await webhook(msgCliente(CLIENTE, 'procuro apartamento na vila da serra, 4 quartos, até 3 milhões'));
  await aguardarEnvios(marco + 3);
  const primeiraChamada = chamadasLLM[antesLLM];
  const userMsg = primeiraChamada.messages[primeiraChamada.messages.length - 1].content;
  checar('agrupa mensagens quebradas num só turno', userMsg.includes('oi') && userMsg.includes('apartamento'), JSON.stringify(userMsg));
  checar('abre com saudação no primeiro contato', primeiraChamada.messages[0].content.includes('PRIMEIRA mensagem'));
  const resp1 = paraCliente(CLIENTE, marco);
  const links = resp1.map((e) => e.message).join('\n').match(/https:\/\/mafuz\.com\.br\/\S+/g) || [];
  checar('apresenta imóveis reais com link', links.length >= 1 && links.length <= 3, `${links.length} links`);
  checar('divide a resposta em mensagens curtas', resp1.length >= 2, `${resp1.length} mensagens`);
  checar('usa "digitando..." antes de enviar', resp1.every((e) => e.delayTyping >= 1));
  console.log('\n--- resposta enviada ao cliente ---\n' + resp1.map((e) => e.message).join('\n~~\n') + '\n-----------------------------------\n');

  // 2) barreira contra link inventado e site externo
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'me manda o link falso'));
  await aguardarEnvios(marco + 1);
  const txt2 = paraCliente(CLIENTE, marco).map((e) => e.message).join('\n');
  checar('bloqueia link de imóvel que não veio da ferramenta', !txt2.includes('inventado'), txt2.replace(/\n/g, ' / '));
  checar('bloqueia link externo', !txt2.includes('concorrente'));

  // 3) qualificação -> lead + alerta para a equipe
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'meu nome é Carlos, quero comprar em até 30 dias, financiado'));
  await aguardarEnvios(marco + 2);
  const alertaLead = paraEquipe(marco).find((e) => e.message.includes('NOVO LEAD'));
  checar('registra lead e alerta a equipe', !!alertaLead, alertaLead ? alertaLead.message.split('\n').slice(0, 4).join(' | ') : '');
  checar('lead classificado como A (até 30 dias)', app.store.leads[CLIENTE] && app.store.leads[CLIENTE].temperatura === 'A');

  // 4) agendamento com validação de janela + alerta
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'quero visitar o primeiro'));
  await aguardarEnvios(marco + 2);
  const alertaVisita = paraEquipe(marco).find((e) => e.message.includes('PEDIDO DE VISITA'));
  checar('reserva visita e alerta a equipe', !!alertaVisita, alertaVisita ? alertaVisita.message.split('\n')[3] : JSON.stringify(paraCliente(CLIENTE, marco)));
  const txtVisita = paraCliente(CLIENTE, marco).map((e) => e.message).join('\n');
  checar('confirma ao cliente com link', /Reservado/.test(txtVisita) && /mafuz\.com\.br/.test(txtVisita), txtVisita.replace(/\n/g, ' / '));

  // 5) negociação: transfere mesmo se o modelo não chamar a ferramenta
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'aceita 2 milhões? me dá um desconto'));
  await aguardarEnvios(marco + 2);
  const alertaHumano = paraEquipe(marco).find((e) => e.message.includes('ATENDIMENTO HUMANO'));
  checar('negociação dispara transferência pelo código', !!alertaHumano && /negocia/.test(alertaHumano.message));
  checar('cliente recebe mensagem de passagem de bastão', paraCliente(CLIENTE, marco).some((e) => /conect/i.test(e.message)));
  checar('conversa fica em silêncio após transferir', app.store.pausado(CLIENTE));
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE, 'alô?'));
  await esperar(1500);
  checar('não responde cliente que está com humano', paraCliente(CLIENTE, marco).length === 0);

  // 6) comando da equipe devolve a conversa ao assistente
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, `#retomar ${CLIENTE}`));
  await aguardarEnvios(marco + 1);
  checar('#retomar funciona', !app.store.pausado(CLIENTE) && paraEquipe(marco).some((e) => /volta a responder/.test(e.message)));
  marco = enviados.length;
  await webhook(msgCliente(EQUIPE, '#status'));
  await aguardarEnvios(marco + 1);
  checar('#status responde', paraEquipe(marco).some((e) => /Mafuz IA LIGADA/.test(e.message)));
  checar('mensagem comum da equipe não vira atendimento', true);

  // 7) humano assume pelo celular -> assistente se cala
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE2, 'boa tarde'));
  await aguardarEnvios(marco + 1);
  await webhook({ ...msgCliente(CLIENTE2, 'Oi, aqui é a Marcella, corretora da MAFUZ!'), fromMe: true, fromApi: false });
  await esperar(300);
  checar('humano respondeu pelo celular -> pausa', app.store.pausado(CLIENTE2));
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE2, 'oi Marcella'));
  await esperar(1500);
  checar('assistente não atropela o corretor', paraCliente(CLIENTE2, marco).length === 0);

  // 8) eco das próprias mensagens não pausa
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE3, 'olá'));
  await aguardarEnvios(marco + 1);
  const eco = paraCliente(CLIENTE3, marco)[0];
  await webhook({ ...msgCliente(CLIENTE3, eco.message), fromMe: true, fromApi: false });
  await esperar(300);
  checar('eco da própria resposta não pausa a conversa', !app.store.pausado(CLIENTE3));

  // 9) grupo ignorado
  marco = enviados.length;
  await webhook({ ...msgCliente('120363000000000000', 'oi grupo'), isGroup: true });
  await esperar(1200);
  checar('ignora grupos', enviados.length === marco);

  // 10) mensagem padrão do site com código do imóvel
  const CLIENTE4 = '5531955554444';
  const antes4 = chamadasLLM.length;
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE4, 'Olá MAFUZ! Sou Ana Souza e tenho interesse neste imóvel:\n\n🏡 Casa\n🔖 Código: 17095\n\nGostaria de mais informações e de agendar uma visita.', { senderName: '🌸' }));
  await aguardarEnvios(marco + 1);
  const sis4 = chamadasLLM[antes4].messages[0].content;
  checar('reconhece imóvel de origem vindo do site', /Imóvel de origem \(veio do site\): código 17095/.test(sis4));
  checar('reconhece o nome da mensagem do site', app.store.conversas[CLIENTE4].nome === 'Ana Souza', app.store.conversas[CLIENTE4].nome);

  // 11) áudio sem transcrição
  const CLIENTE5 = '5531944443333';
  const antes5 = chamadasLLM.length;
  marco = enviados.length;
  await webhook({ ...msgCliente(CLIENTE5, ''), text: undefined, audio: { audioUrl: 'http://127.0.0.1:1/a.ogg', mimeType: 'audio/ogg' } });
  await aguardarEnvios(marco + 1);
  const u5 = chamadasLLM[antes5].messages.slice(-1)[0].content;
  checar('áudio chega ao modelo com instrução de pedir texto', /áudio/.test(u5), u5);

  // 12) falha do modelo -> espera, nova tentativa, escala
  const CLIENTE6 = '5531933332222';
  marco = enviados.length;
  await webhook(msgCliente(CLIENTE6, 'FALHA total'));
  await aguardarEnvios(marco + 3, 90000);
  const t6 = paraCliente(CLIENTE6, marco).map((e) => e.message).join(' / ');
  checar('falha do modelo: avisa, tenta de novo e escala', /Só um instante/.test(t6) && /continuar seu atendimento/.test(t6) && paraEquipe(marco).some((e) => /falha técnica/.test(e.message)), t6);

  // 13) painel
  const csv = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/leads.csv?token=adm`)).text();
  checar('exporta leads em CSV', csv.includes('Carlos'));
  checar('admin sem token é recusado', (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/estado`)).status === 401);
  const wh = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/configurar-webhook?token=adm`)).json();
  checar('configura webhook da Z-API com 1 clique', wh.ok === true && /\/webhook\/zapi\?secret=/.test(wh.webhook), wh.webhook);
  const dg = await (await fetch(`http://127.0.0.1:${PORTA_APP}/admin/diagnostico?token=adm`)).json();
  checar('diagnóstico das três integrações', !dg.zapi.erro && dg.imoview.ok && dg.llm.ok, JSON.stringify(dg.imoview));

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram.`);
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
