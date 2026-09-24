'use strict';
// O cérebro da conversa: monta o contexto, conversa com o modelo, executa as
// ferramentas contra o Imoview e aplica as barreiras de saída (guardrails em código).

const { montarSistema } = require('./prompt');
const {
  log,
  formatarBRL,
  foneExibicao,
  proximosDiasVisita,
  validarHorarioVisita,
  rotuloData,
} = require('./util');

const FERRAMENTAS = [
  {
    name: 'buscar_imoveis',
    description:
      'Busca imóveis REAIS e disponíveis no estoque da MAFUZ (Imoview), ao vivo. Use sempre que o cliente descrever o que procura ou pedir outro recorte. Retorna até 5 imóveis com código, dados e link do site; apresente no máximo 3.',
    parameters: {
      type: 'object',
      properties: {
        finalidade: { type: 'string', enum: ['venda', 'locacao'], description: 'venda (comprar ou investir) ou locacao (alugar)' },
        cidade: { type: 'string', description: 'Cidade, ex.: Nova Lima, Belo Horizonte, Lagoa Santa' },
        bairros: { type: 'array', items: { type: 'string' }, description: 'Bairros ou condomínios, ex.: ["Vila da Serra", "Vale do Sereno"]' },
        tipo: { type: 'string', description: 'apartamento | casa | cobertura | lote | comercial | rural' },
        preco_min: { type: 'number', description: 'Valor mínimo em reais (número inteiro)' },
        preco_max: { type: 'number', description: 'Valor máximo em reais (número inteiro), ex.: 3000000' },
        dormitorios_min: { type: 'integer' },
        suites_min: { type: 'integer' },
        vagas_min: { type: 'integer' },
        area_min: { type: 'number', description: 'Área mínima em m²' },
        texto_livre: { type: 'string', description: 'Desejos qualitativos: "piscina", "vista para a serra", "aceita pet", "varanda gourmet"' },
        codigo: { type: 'string', description: 'Código do imóvel, quando o cliente citar um código' },
        limite: { type: 'integer', description: 'Máximo de resultados (até 5)' },
      },
    },
  },
  {
    name: 'detalhar_imovel',
    description:
      'Traz a ficha completa de um imóvel pelo código: descrição, diferenciais, condomínio, IPTU, áreas, se aceita financiamento/permuta/pets e link. Use para qualquer pergunta sobre um imóvel específico.',
    parameters: {
      type: 'object',
      properties: { codigo: { type: 'string', description: 'Código do imóvel (vem de buscar_imoveis)' } },
      required: ['codigo'],
    },
  },
  {
    name: 'registrar_lead',
    description:
      'Cria ou atualiza o lead do cliente para a equipe comercial. Chame assim que tiver 4 campos de qualificação, e de novo quando surgirem campos novos relevantes.',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        email: { type: 'string' },
        finalidade: { type: 'string', enum: ['comprar', 'alugar', 'investir'] },
        cidade: { type: 'string' },
        bairros: { type: 'array', items: { type: 'string' } },
        tipo: { type: 'string' },
        preco_min: { type: 'number' },
        preco_max: { type: 'number' },
        dormitorios: { type: 'integer' },
        suites: { type: 'integer' },
        vagas: { type: 'integer' },
        prazo: { type: 'string', enum: ['ate_30d', '30_90d', 'acima_90d'] },
        pagamento: { type: 'string', enum: ['a_vista', 'financiamento', 'permuta', 'avaliando'] },
        codigo_imovel_interesse: { type: 'string' },
        observacoes: { type: 'string', description: 'Resumo curto do que o cliente procura, nas palavras dele' },
      },
    },
  },
  {
    name: 'agendar_visita',
    description:
      'Reserva a visita a um imóvel no dia e horário aceitos pelo cliente e avisa a equipe, que confirma com o cliente. Use só depois que o cliente escolher um horário.',
    parameters: {
      type: 'object',
      properties: {
        codigo_imovel: { type: 'string' },
        data: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:mm' },
        nome: { type: 'string', description: 'Nome do cliente' },
        observacoes: { type: 'string' },
      },
      required: ['codigo_imovel', 'data', 'hora', 'nome'],
    },
  },
  {
    name: 'transferir_humano',
    description:
      'Passa a conversa para um corretor, com resumo. O assistente para de responder este cliente depois disso. Use nos gatilhos de transferência.',
    parameters: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          enum: [
            'pedido_do_cliente',
            'negociacao',
            'juridico',
            'reclamacao',
            'alto_ticket',
            'parceiro',
            'venda_do_imovel',
            'lgpd',
            'sem_progresso',
            'busca_dedicada',
            'falha_tecnica',
            'outro',
          ],
        },
        urgencia: { type: 'string', enum: ['normal', 'alta'] },
        resumo: { type: 'string', description: 'Resumo objetivo: quem é, o que procura, imóveis vistos, o que pediu' },
      },
      required: ['motivo', 'resumo'],
    },
  },
];

const RE_NEGOCIACAO =
  /\b(desconto|contra-?proposta|proposta|negoci\w*|abaix\w+ (o )?(valor|pre[cç]o)|fech[ao]\w* por|aceita\w* \d|pago \d|pagar \d|ofere[cç]o \d|oferta de \d|melhor pre[cç]o|valor final)\b/i;

const MOTIVO_LEGIVEL = {
  pedido_do_cliente: 'cliente pediu atendimento humano',
  negociacao: 'negociação de valor',
  juridico: 'assunto jurídico/documentação',
  reclamacao: 'reclamação',
  alto_ticket: 'imóvel acima de R$ 10 mi',
  parceiro: 'corretor/parceiro/incorporadora',
  venda_do_imovel: 'quer vender/anunciar imóvel',
  lgpd: 'pedido LGPD (exclusão de dados)',
  sem_progresso: 'conversa sem avanço',
  busca_dedicada: 'busca dedicada 24h',
  falha_tecnica: 'falha técnica do assistente',
  outro: 'outro',
};

const ORDEM_TEMP = { C: 1, B: 2, A: 3 };

class Agente {
  constructor({ config, store, zapi, imoview, llm }) {
    this.config = config;
    this.store = store;
    this.zapi = zapi;
    this.imoview = imoview;
    this.llm = llm;
    this.enviadosRecentes = new Map(); // fone -> [{texto, ts}]
  }

  detectarNegociacao(texto) {
    return RE_NEGOCIACAO.test(texto || '');
  }

  // ---------------- alertas para a equipe ----------------
  async alertarEquipe(texto) {
    for (const fone of this.config.equipe.alertas) {
      try {
        this.marcarEnviado(fone, texto);
        await this.zapi.enviarTexto(fone, texto);
      } catch (e) {
        log('alerta_erro', { erro: e.message });
      }
    }
    if (!this.config.equipe.alertas.length) log('alerta_sem_destino', { texto: texto.slice(0, 200) });
  }

  marcarEnviado(fone, texto) {
    const lista = this.enviadosRecentes.get(fone) || [];
    const agora = Date.now();
    lista.push({ texto: String(texto).trim(), ts: agora });
    this.enviadosRecentes.set(fone, lista.filter((x) => agora - x.ts < 180000));
  }

  foiEnviadoPorNos(fone, texto) {
    const lista = this.enviadosRecentes.get(fone) || [];
    const t = String(texto || '').trim();
    return !!t && lista.some((x) => x.texto === t && Date.now() - x.ts < 180000);
  }

  resumoBusca(q) {
    const partes = [];
    if (q.finalidade) partes.push(q.finalidade);
    if (q.tipo) partes.push(q.tipo);
    if (q.cidade || (q.bairros && q.bairros.length)) partes.push([q.cidade, q.bairros && q.bairros.length ? `(${[].concat(q.bairros).join(', ')})` : ''].filter(Boolean).join(' '));
    if (q.preco_min || q.preco_max) partes.push(`${q.preco_min ? 'de ' + formatarBRL(q.preco_min) + ' ' : ''}${q.preco_max ? 'até ' + formatarBRL(q.preco_max) : ''}`.trim());
    if (q.dormitorios || q.dormitorios_min) partes.push(`${q.dormitorios || q.dormitorios_min}+ quartos`);
    if (q.suites || q.suites_min) partes.push(`${q.suites || q.suites_min}+ suítes`);
    if (q.vagas || q.vagas_min) partes.push(`${q.vagas || q.vagas_min}+ vagas`);
    return partes.join(' · ') || 'ainda não definida';
  }

  cabecalhoCliente(conv) {
    return `Cliente: ${conv.nome || 'sem nome'} · ${foneExibicao(conv.fone)}\nhttps://wa.me/${conv.fone}`;
  }

  imoveisVistos(conv) {
    const l = Object.values(conv.imoveis).filter((i) => i.apresentado);
    return l.length ? l.map((i) => `${i.codigo} (${i.tipo}, ${i.bairro}, ${i.preco_formatado})`).join('; ') : 'nenhum';
  }

  async enviarLeadImoview(conv, anotacoesExtras = '') {
    if (!this.config.imoview.enviarLeads || conv.leadEnviadoImoview) return;
    const q = conv.qualificacao;
    const anotacoes = [
      'Lead qualificado pela Mafuz IA (WhatsApp).',
      `Busca: ${this.resumoBusca(q)}`,
      q.prazo ? `Prazo: ${q.prazo}` : '',
      q.pagamento ? `Pagamento: ${q.pagamento}` : '',
      conv.temperatura ? `Temperatura: ${conv.temperatura}` : '',
      `Imóveis apresentados: ${this.imoveisVistos(conv)}`,
      q.observacoes ? `Obs.: ${q.observacoes}` : '',
      anotacoesExtras,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const r = await this.imoview.incluirLead({
        nome: conv.nome,
        telefone: conv.fone,
        email: q.email,
        finalidade: q.finalidade === 'alugar' ? 'locacao' : 'venda',
        codigoImovel: q.codigo_imovel_interesse || (conv.origem && conv.origem.codigo),
        anotacoes,
      });
      conv.leadEnviadoImoview = true;
      this.store.evento('lead_imoview', { fone: conv.fone, retorno: JSON.stringify(r).slice(0, 300) });
      log('lead_imoview_ok', { retorno: JSON.stringify(r).slice(0, 200) });
    } catch (e) {
      this.store.evento('lead_imoview_erro', { fone: conv.fone, erro: e.message });
      log('lead_imoview_erro', { erro: e.message });
    }
  }

  registrarImoveis(conv, lista) {
    for (const i of lista) {
      if (!i || !i.codigo) continue;
      conv.imoveis[i.codigo] = {
        ...(conv.imoveis[i.codigo] || {}),
        codigo: i.codigo,
        tipo: i.tipo,
        bairro: i.bairro,
        cidade: i.cidade,
        preco: i.preco,
        preco_formatado: i.preco_formatado,
        url: i.url,
        unidade: i.unidade_responsavel || (conv.imoveis[i.codigo] || {}).unidade,
      };
      if (i.url && !conv.urlsPermitidas.includes(i.url)) conv.urlsPermitidas.push(i.url);
    }
    const chaves = Object.keys(conv.imoveis);
    if (chaves.length > 40) for (const k of chaves.slice(0, chaves.length - 40)) delete conv.imoveis[k];
    if (conv.urlsPermitidas.length > 80) conv.urlsPermitidas.splice(0, conv.urlsPermitidas.length - 80);
  }

  // ---------------- ferramentas ----------------
  async executar(nome, args, conv, turno) {
    args = args || {};
    switch (nome) {
      case 'buscar_imoveis': {
        const r = await this.imoview.buscar(args);
        this.registrarImoveis(conv, r.imoveis);
        const q = conv.qualificacao;
        if (args.finalidade) q.finalidade = q.finalidade || (args.finalidade === 'locacao' ? 'alugar' : 'comprar');
        if (args.cidade) q.cidade = args.cidade;
        if (args.bairros && args.bairros.length) q.bairros = args.bairros;
        if (args.tipo) q.tipo = args.tipo;
        if (args.preco_min) q.preco_min = args.preco_min;
        if (args.preco_max) q.preco_max = args.preco_max;
        if (args.dormitorios_min) q.dormitorios = args.dormitorios_min;
        if (args.suites_min) q.suites = args.suites_min;
        if (args.vagas_min) q.vagas = args.vagas_min;
        turno.buscou = true;
        this.store.evento('busca', { fone: conv.fone, filtros: args, total: r.total_encontrado, codigos: r.imoveis.map((i) => i.codigo) });
        return r;
      }

      case 'detalhar_imovel': {
        const ficha = await this.imoview.detalhar(args.codigo);
        if (!ficha) return { erro: 'Este imóvel não está disponível/publicado no momento. Não o cite; ofereça alternativas.' };
        this.registrarImoveis(conv, [ficha]);
        const { codigo_unidade, ...publica } = ficha;
        return publica;
      }

      case 'registrar_lead': {
        const q = conv.qualificacao;
        for (const k of ['email', 'finalidade', 'cidade', 'bairros', 'tipo', 'preco_min', 'preco_max', 'dormitorios', 'suites', 'vagas', 'prazo', 'pagamento', 'codigo_imovel_interesse', 'observacoes']) {
          if (args[k] !== undefined && args[k] !== null && args[k] !== '') q[k] = args[k];
        }
        if (args.nome) conv.nome = String(args.nome).slice(0, 80);
        const temp = { ate_30d: 'A', '30_90d': 'B', acima_90d: 'C' }[q.prazo] || conv.temperatura || null;
        const anterior = this.store.leads[conv.fone];
        const tempAnterior = conv.temperatura;
        conv.temperatura = temp;
        const lead = {
          ...(anterior || { criadoEm: new Date().toISOString(), origem: conv.origem ? 'site' : 'whatsapp' }),
          fone: conv.fone,
          nome: conv.nome,
          temperatura: temp,
          qualificacao: { ...q },
          imovel_origem: conv.origem ? conv.origem.codigo : null,
          imoveis_apresentados: Object.values(conv.imoveis).filter((i) => i.apresentado).map((i) => i.codigo),
          atualizadoEm: new Date().toISOString(),
        };
        this.store.leads[conv.fone] = lead;
        this.store.tocar();
        conv.turnosSemAvanco = 0;
        turno.registrou = true;

        const subiu = temp && (!tempAnterior || ORDEM_TEMP[temp] > ORDEM_TEMP[tempAnterior]);
        if (!anterior || subiu) {
          const titulo = !anterior ? '🟢 NOVO LEAD — Mafuz IA' : `🔥 LEAD ESQUENTOU (${tempAnterior || '-'} → ${temp})`;
          const interesse = q.codigo_imovel_interesse && conv.imoveis[q.codigo_imovel_interesse];
          await this.alertarEquipe(
            [
              titulo,
              this.cabecalhoCliente(conv),
              `Busca: ${this.resumoBusca(q)}`,
              `Prazo: ${q.prazo || 'não informado'}${temp ? ` (lead ${temp})` : ''} · Pagamento: ${q.pagamento || 'não informado'}`,
              interesse ? `Interesse: ${interesse.tipo} no ${interesse.bairro} — ${interesse.preco_formatado}\n${interesse.url}` : '',
              conv.origem ? `Veio do site pelo imóvel ${conv.origem.codigo}` : '',
              `Imóveis apresentados: ${this.imoveisVistos(conv)}`,
              q.observacoes ? `Obs.: ${q.observacoes}` : '',
            ]
              .filter(Boolean)
              .join('\n')
          );
        }
        await this.enviarLeadImoview(conv);
        this.store.evento('lead', { fone: conv.fone, temperatura: temp });
        return { lead_id: `WA-${conv.fone.slice(-6)}`, etapa: 'qualificacao', temperatura: temp || 'indefinida' };
      }

      case 'agendar_visita': {
        const regras = this.config.comportamento.horarioVisitas;
        const erro = validarHorarioVisita(regras, args.data, args.hora);
        if (erro) {
          return {
            erro: `Horário inválido: ${erro}. Ofereça duas opções dentro das janelas abaixo.`,
            janelas: proximosDiasVisita(regras, 4).map((d) => `${d.rotulo} [${d.data}] ${d.janela}`),
          };
        }
        const ficha = await this.imoview.detalhar(args.codigo_imovel);
        if (!ficha) return { erro: 'Imóvel não está mais disponível. Não reserve; avise o cliente e ofereça alternativas.' };
        this.registrarImoveis(conv, [ficha]);
        if (args.nome) conv.nome = String(args.nome).slice(0, 80);
        const visita = {
          id: 'V' + Date.now().toString(36).toUpperCase(),
          fone: conv.fone,
          nome: conv.nome,
          codigo: ficha.codigo,
          url: ficha.url,
          bairro: ficha.bairro,
          data: args.data,
          hora: args.hora,
          observacoes: args.observacoes || '',
          status: 'aguardando_confirmacao',
          criadaEm: new Date().toISOString(),
        };
        this.store.visitas.push(visita);
        conv.visitas.push(visita.id);
        conv.qualificacao.codigo_imovel_interesse = ficha.codigo;
        conv.turnosSemAvanco = 0;
        turno.agendou = true;
        await this.alertarEquipe(
          [
            '📅 PEDIDO DE VISITA — confirmar com o cliente',
            this.cabecalhoCliente(conv),
            `Quando: ${rotuloData(args.data)} às ${args.hora}`,
            `Imóvel ${ficha.codigo}: ${ficha.tipo} no ${ficha.bairro}${ficha.condominio ? ` (${ficha.condominio})` : ''} — ${ficha.preco_formatado}`,
            ficha.url,
            ficha.unidade_responsavel ? `Unidade: ${ficha.unidade_responsavel}` : '',
            visita.observacoes ? `Obs.: ${visita.observacoes}` : '',
            'Responda o cliente pelo WhatsApp da MAFUZ para confirmar — o assistente se cala nesta conversa assim que alguém da equipe escrever.',
          ]
            .filter(Boolean)
            .join('\n')
        );
        await this.enviarLeadImoview(conv, `Visita solicitada: ${rotuloData(args.data)} às ${args.hora} — imóvel ${ficha.codigo}`);
        this.store.evento('visita', { fone: conv.fone, id: visita.id, codigo: ficha.codigo, data: args.data, hora: args.hora });
        return {
          agendamento_id: visita.id,
          status: 'reservado_aguardando_confirmacao',
          quando: `${rotuloData(args.data)} às ${args.hora}`,
          bairro: ficha.bairro,
          condominio: ficha.condominio,
          url: ficha.url,
          proximo_passo: 'Um corretor da MAFUZ confirma a visita com o cliente por este WhatsApp e informa o endereço.',
        };
      }

      case 'transferir_humano': {
        const motivo = args.motivo || 'outro';
        const urgencia = args.urgencia || (['negociacao', 'alto_ticket', 'reclamacao', 'lgpd'].includes(motivo) ? 'alta' : 'normal');
        const horas = this.config.comportamento.pausaHumanoHoras;
        this.store.pausar(conv.fone, horas, `transferido:${motivo}`);
        conv.transferencias.push({ motivo, urgencia, resumo: args.resumo, ts: Date.now() });
        conv.turnosSemAvanco = 0;
        turno.transferiu = true;
        await this.alertarEquipe(
          [
            `${urgencia === 'alta' ? '🔴' : '🟠'} ATENDIMENTO HUMANO — ${MOTIVO_LEGIVEL[motivo] || motivo}${urgencia === 'alta' ? ' (URGENTE)' : ''}`,
            this.cabecalhoCliente(conv),
            `Resumo: ${args.resumo || '-'}`,
            `Busca: ${this.resumoBusca(conv.qualificacao)}`,
            `Imóveis apresentados: ${this.imoveisVistos(conv)}`,
            `O assistente ficou em silêncio nesta conversa por ${horas}h. Para devolver a ele: #retomar ${conv.fone}`,
          ].join('\n')
        );
        if (motivo !== 'lgpd') await this.enviarLeadImoview(conv, `Transferido para humano: ${MOTIVO_LEGIVEL[motivo] || motivo}. ${args.resumo || ''}`);
        this.store.evento('transferencia', { fone: conv.fone, motivo, urgencia });
        return { encaminhado: true, protocolo: `T${Date.now().toString(36).toUpperCase()}` };
      }

      default:
        return { erro: `Ferramenta desconhecida: ${nome}` };
    }
  }

  // ---------------- barreiras de saída ----------------
  guardar(texto, conv) {
    let t = String(texto || '').replace(/\r/g, '');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    t = t.replace(/^#{1,6}\s*/gm, '');
    t = t.replace(/^\s*[-•]\s+/gm, '');

    const permitidas = new Set(conv.urlsPermitidas);
    let hostSite = '';
    try {
      hostSite = new URL(this.config.site.url).host.replace(/^www\./, '');
    } catch {}
    let links = 0;
    const linhas = [];
    for (const linha of t.split('\n')) {
      const urls = linha.match(/https?:\/\/[^\s]+/g) || [];
      let ok = true;
      for (const bruto of urls) {
        const u = bruto.replace(/[.,;:!?)]+$/, '');
        if (/\/imovel\/|\/imoveis\?q=/.test(u)) {
          if (!permitidas.has(u)) {
            ok = false;
            log('guard_link_bloqueado', { url: u });
          } else if (++links > 3) ok = false;
        } else if (!(hostSite && u.includes(hostSite)) && !/wa\.me\//.test(u)) {
          ok = false;
          log('guard_link_externo_bloqueado', { url: u });
        }
      }
      if (ok) linhas.push(linha);
    }
    t = linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    for (const u of permitidas) {
      if (t.includes(u)) for (const i of Object.values(conv.imoveis)) if (i.url === u) i.apresentado = true;
    }
    if (/pol[ií]tica de privacidade/i.test(t)) conv.lgpdAvisado = true;
    return t;
  }

  // ---------------- turno completo ----------------
  async responder(conv, textoCliente, sinais = {}) {
    const sistema = montarSistema({ conv, config: this.config, sinais });
    const historico = conv.historico.slice(-24).map((h) => ({ role: h.papel === 'cliente' ? 'user' : 'assistant', content: h.texto }));
    while (historico.length && historico[0].role !== 'user') historico.shift();
    const mensagens = [...historico, { role: 'user', content: textoCliente }];
    const turno = { buscou: false, registrou: false, agendou: false, transferiu: false, ferramentas: [] };

    let final = '';
    for (let passo = 0; passo < 6; passo++) {
      const r = await this.llm.conversar({ sistema, mensagens, ferramentas: FERRAMENTAS });
      if (r.toolCalls && r.toolCalls.length) {
        mensagens.push({ role: 'assistant', content: r.texto, toolCalls: r.toolCalls });
        for (const tc of r.toolCalls) {
          let saida;
          try {
            saida = await this.executar(tc.name, tc.args, conv, turno);
          } catch (e) {
            log('ferramenta_erro', { ferramenta: tc.name, erro: e.message });
            saida = { erro: 'Sistema de consulta indisponível no momento. Não improvise dados: diga que vai confirmar com o corretor e chame transferir_humano (motivo falha_tecnica).' };
          }
          turno.ferramentas.push(tc.name);
          log('ferramenta', { fone: conv.fone.slice(-4), nome: tc.name, args: tc.args, erro: saida && saida.erro });
          mensagens.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify(saida) });
        }
        continue;
      }
      final = r.texto;
      break;
    }

    // Barreira: negociação detectada e o modelo não transferiu -> transfere pelo código.
    if (sinais.negociacao && !turno.transferiu) {
      await this.executar('transferir_humano', { motivo: 'negociacao', urgencia: 'alta', resumo: `Cliente escreveu: "${textoCliente.slice(0, 300)}"` }, conv, turno);
      if (!/conect|corretor|equipe/i.test(final)) {
        final = `${final ? final + '\n\n' : ''}Proposta e condição de valor quem conduz é o nosso time diretamente. Vou te conectar agora com ${this.config.equipe.nomeTransferencia} — já passei todo o nosso histórico.`;
      }
    }

    if (!final) final = 'Só um instante — vou confirmar essa informação com o corretor responsável e já te retorno por aqui.';
    return { texto: this.guardar(final, conv), turno };
  }
}

module.exports = { Agente, FERRAMENTAS, RE_NEGOCIACAO };
