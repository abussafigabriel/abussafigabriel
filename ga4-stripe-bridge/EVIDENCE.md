# Evidência da compra de validação — 13/08/2026

Transação **`pi_3U43tT7nPZQ9eEGQ1oRWPnaB`**, $4,18 USD, `livemode: true`.
Compra às **19:02:36 UTC**. Revisão `00051-sfx` (v5.1.1 + segredo corrigido).

Toda a evidência abaixo foi lida por API — Cloud Logging e GA4 Data/Realtime API —
e conferida contra as capturas do Realtime tiradas às 19:06 UTC.

---

## 1. O funil inteiro entrou no GA4

Todos com o **mesmo `client_id` real** `361179969.1786647438`:

| Hora UTC | Evento | Envio | Realtime GA4 |
|---|---|---|---|
| 18:58:14 | `intake_start` | `204` | ✅ presente |
| 18:59:57 | `generate_lead` | `204` | ✅ presente, **key event** |
| 19:02:19 | `begin_checkout` | `204` | ✅ presente, **key event** |
| 19:02:36 | **`purchase`** | `204` | ✅ **presente, key event** |

Confirmação pela Realtime API:

```
purchase         eventCount=1   keyEvents=1
generate_lead    eventCount=1   keyEvents=1
begin_checkout   eventCount=3   keyEvents=2
intake_start     eventCount=1
```

E o parâmetro de receita chegou junto: `value = 4.18`, event count 1 (100%).
A audiência **Purchasers** passou a ter 1 usuário.

Esta é a **primeira transação com prefixo `pi_`** a entrar nesta propriedade.

---

## 2. Correção 7.1 (corrida de atribuição): PASSOU

```
19:02:36  openloop_attribution_saved
19:02:36  ga4_purchase_outbound  clientIdPresent=true  361179969.1786647438
```

No teste de 15:50 era `clientIdPresent=false` com `client_id` fantasma
`2927675193.981011370`. Agora a compra está colada na **mesma sessão** que fez o
intake e o checkout. A janela ampliada (3×600ms → 8×1200ms) pegou a atribuição da
OpenLoop a tempo — a corrida perdida por 8 segundos está resolvida.

## 3. Fan-out completo

```
19:02:53  purchase_dispatched  ga4:204, meta:200, tiktok:200, first_promoter:200
```

Os quatro destinos aceitaram. `first_promoter_sale_outbound status=200` às 19:02:45.

---

## 4. Latência de relatório — leia antes de mostrar ao cliente

No mesmo instante em que o Realtime mostra a compra, a **Data API processada**
ainda não mostra:

```
DATA API hoje - eventos do funil   ->  begin_checkout 3
DATA API hoje - transacoes         ->  (sem linhas)
```

Isso é **esperado e não é defeito**. O Realtime é a fonte imediata; as tabelas
processadas (Transactions, Reports snapshot, receita por transação) levam de horas
até 24–48h. A compra está ingerida — o print do Realtime é a prova.

**Não conclua que quebrou de novo** se abrir Transactions hoje e não vir nada.
A conferência definitiva das tabelas processadas fica para 14/08.

---

## 5. Pendências abertas

### 5.1 Timeout de fan-out voltou, agora em 15s

```
19:02:52  [ERRO] background_dispatch_failed  dispatch_timeout_15000ms
```

O handoff media ~8s de fan-out e a correção 7.3 subiu `DESTINATION_TIMEOUT_MS` para
15000. Estourou mesmo assim. **A conversão principal não se perdeu** — o
`purchase_dispatched` às 19:02:53 confirma os quatro destinos entregues. É um
despacho secundário morrendo por tempo.

Não bloqueia o aceite. Mas a causa provável é o fan-out inline: a API do Cloud Tasks
está desabilitada, então tudo roda dentro da requisição. Habilitar Cloud Tasks é a
correção estrutural.

### 5.2 Caminho do `invoice.payment_succeeded` continua quebrado

```
19:02:34  [ERRO] stripe_purchase_missing_payment_intent
```

Reapareceu exatamente como no teste anterior. A compra passou porque o
`payment_intent.succeeded` chegou logo depois. **A captura da compra depende hoje de
um caminho único** — se a OpenLoop mudar a ordem dos webhooks, a compra some sem
erro visível no relatório.

### 5.3 Atribuição de afiliado no GA4 — a conferir em 14/08

As sessões de hoje ainda não têm compra associada nas tabelas processadas, então
não dá para afirmar por qual origem a compra foi atribuída. O First Promoter
registrou a venda (`status=200`), que é a fonte de verdade da comissão.

Conferir amanhã: **Data API → transactionId × sessionSource**. Se vier
`(direct)/(none)`, a receita está no GA4 mas sem crédito de campanha, e aí o alvo é
o handoff cross-domain, não o worker.

---

## 6. Próximos passos

1. Reembolsar **após 60 minutos** (a partir de ~20:02 UTC) e confirmar a
   correção 7.2: tem que sair **um** `refund_dispatched`, não dois.
2. Em 14/08, conferir as tabelas processadas: `purchase` na contagem de eventos,
   a transação em Transactions, e a atribuição por sessão.
3. **Marcar** as transações de teste para ignorar na análise. O GA4 não apaga uma
   transação específica — a exclusão existente é por intervalo de datas e levaria
   dados legítimos junto. IDs a excluir em relatórios e explorações:
   - `pi_3U43tT7nPZQ9eEGQ1oRWPnaB` (teste de 13/08, reembolsado, receita 0)
   - `diag-alt-1786646097511` e eventos `diag_ping` / `diag_ping2` (probes)
   - `test-verify-2026` e `cus_V3P8ZJcdgo3qcK` (11/08)
   - receita antiga ~US$1.500 (múltiplos de $229)
   - `pi_3U40tr7nPZQ9eEGQ1xMtBxbP` **não** precisa: nunca entrou.
4. Revogar a chave `claude-debug`.

---

# Reembolso — 13/08 20:14 UTC — correção 7.2 PROVADA

Reembolso de USD 4,18 em `ch_3U43tT7nPZQ9eEGQ1peMnjEr` / `pi_3U43tT7nPZQ9eEGQ1oRWPnaB`,
71 minutos após a compra (janela de espera cumprida).

```
20:14:03  ga4_refund_outbound   clientIdPresent=true  361179969.1786647438
20:14:03  ga4_send_result       refund  status=204    361179969.1786647438
20:14:03  meta_refund_outbound  status=200
20:14:15  first_promoter_refund_outbound  status=200
20:14:30  [ERRO] background_dispatch_failed  dispatch_timeout_15000ms
20:14:43  refund_dispatched  ga4:204, meta:200, tiktok:200, first_promoter:200
```

GA4 Realtime confirmou a ingestão: `refund` eventCount=1.

## Antes e depois, no mesmo cenário

| | 15:52 (v5.1.0, segredo morto) | 20:14 (v5.1.1 + segredo correto) |
|---|---|---|
| `ga4_refund_outbound` | 2 | **1** |
| `refund_dispatched` | 2 | **1** |
| `client_id` | dois, um deles fantasma | **um, o real** |
| Ingerido no GA4 | não | **sim** |

O `client_id` do reembolso é idêntico ao da compra — receita e estorno no mesmo
usuário, que é o que faz a receita líquida fechar corretamente.

## Placar das correções da v5.1.1

| Correção | Status | Evidência |
|---|---|---|
| 7.1 janela de atribuição | **PASSOU** | `clientIdPresent=true` na compra |
| 7.2 dedup de reembolso | **PASSOU** | 1 `refund_dispatched` em vez de 2 |
| 7.3 timeout de entrega | **FALHOU** | `dispatch_timeout_15000ms` nos dois testes |

### Sobre a 7.3 — o handoff subestimou o tempo

O `refund_dispatched` completo saiu às 20:14:43, **40 segundos** após o início. O
handoff media ~8s e a correção subiu o limite para 15s. O fan-out real leva ~40s.

Nenhuma conversão se perdeu em nenhum dos dois testes — o fan-out continua após o
timeout e entrega. Mas subir o limite de novo é remendo. A correção estrutural é
**habilitar a API do Cloud Tasks** e tirar o fan-out de dentro da requisição.

Sintoma visível no próprio Stripe: dos quatro endpoints, três responderam às
20:13:59 e o worker às 20:14:03.

---

# Estado final do projeto

| Item | Status |
|---|---|
| GA4 recebe `purchase` | ✅ provado por API |
| GA4 recebe `refund` | ✅ provado por API |
| Atribuição colada na sessão real | ✅ mesmo `client_id` em ambos |
| Meta CAPI / TikTok / First Promoter | ✅ 200 nos dois ciclos |
| Dedup de reembolso | ✅ |
| Timeout de fan-out | ✅ **corrigido na v5.1.2** |
| `invoice.payment_succeeded` | ✅ **corrigido na v5.1.2** |
| Tabelas processadas do GA4 | ⏳ conferir em 14/08 |

As duas pendências foram fechadas na **v5.1.2** (revisão `00052-v512`, publicada
21:35 UTC). Detalhes e testes em `CHANGELOG-v5.1.2.md`; o código-fonte completo
está em `serverless-v5/`.


---

# 14/08 — Validação em produção real e fecho da atribuição

Verificado às 09:43 UTC pela GA4 Data API e pelo Cloud Logging.

## A v5.1.2 foi provada por tráfego de cliente real

Uma compra que **ninguém orquestrou** entrou às **03:07:34 UTC**, ~5h30 depois do
deploy: `pi_3U4BSo7nPZQ9eEGQ0OjYyjSN`, **US$ 145**, cliente `cus_UtonccvbF5RCIM`.

```
03:07:27  stripe_purchase_deferred    level=info   handoff=payment_intent.succeeded
03:07:34  ga4_purchase_outbound       value=145
03:07:35  ga4_send_result             204
03:07:36  meta 200 · tiktok 200
03:07:37  first_promoter 204
03:07:43  purchase_dispatched         4 destinos ok          (16s no total)
```

Isso fecha a ressalva que ficou ontem — a v5.1.2 tinha passado só por `/health`:

| Correção | Prova com dinheiro real |
|---|---|
| `invoice.payment_succeeded` | `stripe_purchase_deferred` em nível **info**, com `handoff`. O antigo `stripe_purchase_missing_payment_intent` em `ERROR` sumiu, e o repasse funcionou: a invoice adiou, o `payment_intent.succeeded` capturou 7s depois |
| Timeout de fan-out | **Nenhum** `background_dispatch_failed`. 16s contra o limite de 90s |
| Serviço inteiro | **Zero** entradas `severity>=WARNING` desde o deploy das 21:35 |

## As tabelas processadas confirmam o ciclo

```
13/08   purchase 3 · refund 1 · intake_start 5 · begin_checkout 7
        receita 145,01   reembolsado 4,18

pi_3U43tT7nPZQ9eEGQ1oRWPnaB   1 compra   receita 0     <- nosso teste, reembolsado
pi_3U4BSo7nPZQ9eEGQ0OjYyjSN   1 compra   receita 145   <- cliente real
```

O nosso teste aparece com receita **0** porque compra e reembolso entraram com o
mesmo `transaction_id` e o GA4 subtraiu. Desta vez é subtração de verdade — não
ausência de dado, como era em 13/08 antes da correção do segredo.

## Atribuição — conclusão (fecha a seção 5.3)

Todas as transações mostram `sessionSource` e `firstUserSource` como `(not set)`,
inclusive a nossa, que tinha o `client_id` correto. São duas causas distintas, e
confundi-las leva a conserto errado:

1. **Limitação do Measurement Protocol.** Compra enviada pelo servidor sem
   `session_id` não se junta a uma sessão, então dimensão de escopo de sessão fica
   vazia. Mandar `session_id` esbarra no defeito conhecido do GA4 que descarta
   `purchase` — é por isso que o worker o omite, e por isso **não** mexemos nisso.
2. **Renovação de assinatura não tem sessão para atribuir.** A compra das 03:07
   registrou `attribution_not_found_for_purchase` e não houve **nenhum** evento da
   OpenLoop na janela. Para cobrança recorrente de madrugada isso é o esperado, não
   um defeito. Compras que passam pelo funil rastreado **pegam** o `client_id`
   real — o teste das 19:02 provou (`clientIdPresent=true`).

**Posicionamento da entrega:** o GA4 é fonte de verdade de **receita e conversão**;
o **crédito de afiliado vive no First Promoter**, que registrou a venda e o estorno
nos dois ciclos. Prometer origem de campanha no GA4 para compras server-side seria
prometer o que a ferramenta não entrega.

## Estado final

| Item | Status |
|---|---|
| GA4 recebe `purchase` e `refund` | ✅ provado por API, duas vezes |
| Correções 7.1 e 7.2 | ✅ provadas com tráfego real |
| v5.1.2 (log e timeout) | ✅ provada com compra de cliente real |
| Erros em produção | ✅ zero desde 21:35 de 13/08 |
| Atribuição de afiliado | ✅ no First Promoter — limitação do GA4 documentada |
