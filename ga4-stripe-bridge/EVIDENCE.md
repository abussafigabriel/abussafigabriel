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
3. Excluir do GA4 as transações de teste:
   - `pi_3U43tT7nPZQ9eEGQ1oRWPnaB` (esta)
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
| Timeout de fan-out | ⚠️ aberto, sem perda de conversão |
| `invoice.payment_succeeded` | ⚠️ aberto, caminho único de captura |
| Tabelas processadas do GA4 | ⏳ conferir em 14/08 |
