# Atualização da Gabi para a versão 4

Tempo estimado: 15 minutos. Nada muda no número de WhatsApp nem na Z-API.

## O que muda para o cliente

| Antes (v3) | Agora (v4) |
|---|---|
| Imóveis em texto, até 3 | Até 4 imóveis, cada um em uma mensagem com **foto de capa**, dados e link do mafuz.site |
| Várias mensagens por resposta | No máximo **2 mensagens** por vez, com "digitando" de 2 a 6 s e pausa natural antes de responder |
| Oferecia horários prontos | Pergunta **"Qual o melhor dia e horário para você?"** e só reserva com a resposta do cliente |
| Sem retomada | **Cutucada** leve após 15 min parado no meio da conversa; **follow-up** com novidade em 3 dias; último toque em 7 dias |
| Mercado genérico | Preço por m² e movimento da região com **fonte**: carteira ativa da Mafuz e Índice FipeZap (BH) |
| Silêncio de 12 h quando o corretor entra | Silêncio de **60 min**: sem nova mensagem do corretor, a Gabi volta sozinha |
| Alertas para um número só | Alertas **por carteira**: venda para Marcella e Thais, locação para Raina, Ana Flavia e Catia |

Os follow-ups respeitam: nada entre 21h e 8h nem aos domingos; param se o cliente pedir, se um corretor assumir ou se houver visita marcada.

## Passo 1 · GitHub (repositório `mafuz-agente`)

1. Abra o repositório no GitHub.
2. **Add file › Upload files** e arraste: as pastas `src`, `conhecimento` e `test`, e os arquivos `package.json`, `README.md`, `.env.example` e `ATUALIZACAO-V4.md`.
3. Mensagem do commit: `Gabi v4`. Clique em **Commit changes**.

A Railway publica sozinha em 1 a 2 minutos.

## Passo 2 · Railway › Variables

Obrigatória:

| Variável | Valor |
|---|---|
| `SITE_URL` | `https://mafuz.site` |

Já vêm com o valor certo no código. Só crie se precisar mudar:

| Variável | Padrão |
|---|---|
| `TEAM_VENDA` | `5531989097232,5531988093993` (Marcella, Thais) |
| `TEAM_LOCACAO` | `5531987176953,5531994099755,5531999549025` (Raina, Ana Flavia, Catia) |
| `PAUSA_HUMANO_MIN` | `60` |
| `CUTUCADA_MIN` / `FOLLOWUP_DIAS` | `15` / `3,7` |
| `JANELA_ENVIO` | `1-6 08:00-21:00` (seg a sáb, 8h às 21h) |
| `SITE_CHAT_ORIGINS` | `https://mafuz.site,https://www.mafuz.site` |

- `TEAM_PHONES` continua sendo a **gestão** (recebe todos os alertas). Mantenha o seu número.
- `PAUSA_HUMANO_HORAS` deixou de ser usada e pode ser apagada.

## Passo 3 · Conferir em 1 minuto

1. `https://mafuz-agente-production.up.railway.app/health` mostra `"versao": "2.0.0"`, a carteira carregada e o WhatsApp `conectado`.
2. `…/admin/simular?token=SEU_ADMIN_TOKEN&conversa=v4&reset=1&texto=Procuro casa em condomínio no Alphaville` mostra:
   - `mensagens`: no máximo 2, sem travessão;
   - `imoveis_com_foto`: as legendas com link `mafuz.site/imovel/…`.
3. No seu WhatsApp, mande `#teste` para o número da Mafuz e converse como cliente. Confira:
   - os imóveis chegam com foto;
   - ao pedir um corretor, o alerta chega para a gestão e para a carteira certa;
   - ao marcar visita, ela pergunta o melhor dia e horário;
   - `#reset` recomeça a conversa de teste.
4. Teste de retomada, que envia de verdade para o número informado:
   `…/admin/reengajar?token=SEU_ADMIN_TOKEN&fone=5531991831514&tipo=cutucada`
   Os tipos são `cutucada`, `followup3` e `followup7`.

## Passo 4 · Gabi no site

Na **Netlify** do site, em *Site configuration › Environment variables*, crie a variável abaixo e faça um novo deploy:

```
VITE_GABI_CHAT_URL = https://mafuz-agente-production.up.railway.app/site/chat
```

A partir daí, a Gabi IA do site responde pelo mesmo cérebro do WhatsApp, com os imóveis em cartões com foto.

## Avisar a equipe

- Os cinco corretores passam a receber alertas no WhatsApp pessoal. Peça que salvem o número da Mafuz.
- Mensagens que esses números enviam para o número da Mafuz são tratadas como equipe, não como cliente. Para testar como cliente, o corretor manda `#teste`.
- Quando um corretor responde o cliente pelo número da Mafuz, a Gabi fica em silêncio por 60 minutos. Cada nova mensagem do corretor renova esse prazo.

## Atualizar os dados de mercado

Uma vez por mês, atualize `conhecimento/mercado.md` com o relatório FipeZap novo (fipe.org.br) e faça o upload no GitHub. A Gabi só cita número que estiver nesse arquivo ou na carteira da Mafuz.

## Voltar para a versão anterior

Railway › *Deployments* › deploy anterior › **Redeploy**. As conversas continuam no volume `/app/data`.

## Testes automáticos

`IMOVIEW_API_KEY=… npm test` roda 65 verificações ponta a ponta: fotos, limite de mensagens, visita, roteamento venda e locação, pausa de 60 min, cutucada, follow-ups, chat do site e ausência de travessões. As 65 passaram na entrega.
