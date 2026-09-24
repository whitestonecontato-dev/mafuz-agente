# Mafuz IA — agente de WhatsApp

Serviço Node.js (sem dependências externas) que conecta Z-API, Imoview e um modelo de linguagem.

- Passo a passo de implantação: [GUIA-DE-IMPLANTACAO.md](GUIA-DE-IMPLANTACAO.md)
- Variáveis: [.env.example](.env.example)
- Conhecimento editável da casa: [conhecimento/casa.md](conhecimento/casa.md)

## Estrutura

| Arquivo | Função |
|---|---|
| `src/server.js` | Webhook da Z-API, fila por cliente (agrupa mensagens), comandos da equipe, painel `/admin` |
| `src/agent.js` | Ferramentas (buscar, detalhar, lead, visita, transferência) e barreiras de saída |
| `src/prompt.js` | System prompt de produção com contexto dinâmico |
| `src/imoview.js` | Cliente do Imoview com lista branca de campos |
| `src/site.js` | Link público de cada imóvel no site |
| `src/llm.js` | OpenAI ou Anthropic com chamada de ferramentas; transcrição de áudio |
| `src/zapi.js` | Envio de mensagens e configuração do webhook |
| `src/store.js` | Conversas, leads, visitas e trilha de eventos (arquivo em `DATA_DIR`) |
| `test/simulate.js` | Simulação ponta a ponta com Z-API e modelo falsos e Imoview real |

## Rodar localmente

```bash
cp .env.example .env   # preencha
npm start
IMOVIEW_API_KEY=... npm test
```
