# Runbook — validar e provar o tracking do SeshDx no GA4

Sequência para a compra de validação final, desenhada para que **nenhum passo dependa
do anterior ter dado certo por sorte**, e para gerar as evidências que fecham o aceite.

**Regra do projeto:** `204` do GA4 nunca prova entrega. Só conta painel de terceiro
ou log do próprio sistema.

---

## FASE 0 — Provar que o GA4 aceita um `purchase`, sem gastar nada

**Não pule e não faça a compra real antes disto.** Se `purchase` não existe hoje na
lista de eventos da propriedade, existe uma chance concreta de o GA4 estar
descartando esse evento especificamente — e nesse caso a compra real seria mais um
teste queimado sem resposta.

### 0.1 Ler a senha que o worker usa

```bash
gcloud run revisions describe seshdx-tracking-webhook-00050-vid \
  --region=us-central1 --project=seshdx-tracking --format=json
```

Procure `GA4_API_SECRET` e `GA4_MEASUREMENT_ID` na saída.

### 0.2 Disparar um `purchase` sintético

```bash
node diagnose.mjs --measurement-id G-WHP0DJ703Q --api-secret <valor>
```

### 0.3 Olhar o DebugView

**GA4 → Admin → DebugView**, dentro de ~30 segundos.

Atenção ao seletor de dispositivo no canto superior esquerdo: eventos de
Measurement Protocol entram como um dispositivo separado. Se a tela parecer vazia,
troque o dispositivo antes de concluir que falhou.

| Resultado | Significado | O que fazer |
|---|---|---|
| `purchase` aparece | O GA4 aceita compras com essas credenciais | Siga para a FASE 1 |
| Não aparece | Credencial, propriedade ou filtro | **Pare.** Vá para "Se a FASE 0 falhar" |

### 0.4 Confirmar pela API

```bash
node ga4-query.mjs --key C:/caminho/claude-debug.json --days 90
```

Isto responde de forma definitiva se `purchase` já existiu alguma vez na
propriedade, sem depender de rolar dropdown.

---

## ⚠️ A armadilha do `debug_mode`

O `debug_mode` serve para **ver o evento no DebugView**. Mas se a propriedade tiver
um filtro de **Developer traffic** ativo (Admin → Data Settings → Data Filters),
todo evento marcado como debug é **excluído dos relatórios** — ele aparece no
DebugView e nunca chega em Transactions.

Por isso a compra de validação da FASE 2 tem que sair **sem** `debug_mode`.
Confirme antes que `GA4_DEBUG_MODE` não ficou ligado no Cloud Run.

E confira os dois lugares de filtro, porque um filtro em estado *Active* descarta
dados de forma permanente e irreversível:

- Admin → Data Settings → **Data Filters** (nível de propriedade)
- Admin → Data Streams → o stream → **more tagging settings** (tráfego interno)

---

## FASE 1 — Confirmar o que está no ar

```bash
curl -s https://seshdx-tracking-webhook-869202251383.us-central1.run.app/health
```

Tem que responder **5.1.1**. Se responder outra coisa, a Hana publicou por cima —
não siga sem alinhar com ela, senão você valida uma versão que não é a sua.

---

## FASE 2 — A compra de validação

1. Abrir o site **pelo link de afiliado** (`?fpr=testnozgbztg`), em aba anônima.
   Entrar por link é o que exercita a atribuição — sem isso a correção 7.1 não é testada.
2. Aceitar o banner de consentimento.
3. Percorrer o funil normalmente e concluir a compra com o cupom `testseshdx`.
4. **Anotar o horário exato em UTC.**
5. **NÃO REEMBOLSAR.** Mínimo de 60 minutos parado.

> Foi exatamente esse passo que invalidou o teste de 13/08: o reembolso veio 115
> segundos depois, com o mesmo `transaction_id`, e o GA4 trata isso como reembolso
> total e subtrai a receita. O teste apagou a própria evidência.

---

## FASE 3 — Colher evidência, hop a hop

Na ordem, porque cada uma prova um trecho diferente do caminho:

| # | Onde | O que tem que aparecer | Prova o quê |
|---|---|---|---|
| 1 | Logs do Cloud Run | `clientIdPresent: true` e o `client_id` real | Correção 7.1 funcionou |
| 2 | Logs do Cloud Run | `ga4_send_result status=204` | O worker chamou o GA4 |
| 3 | GA4 → Realtime → **Event count by Event name** | `purchase` (janela de 30 min) | O GA4 **ingeriu** |
| 4 | Stripe | pagamento `succeeded` | Fonte financeira |
| 5 | First Promoter | comissão `approved` | Atribuição de afiliado |
| 6 | GA4 → Transactions (24–48h depois) | `transaction_id` com valor | Relatório processado |

Ler os logs:

```bash
gcloud logging read 'resource.labels.service_name="seshdx-tracking-webhook"' \
  --limit=200 --freshness=2h --project=seshdx-tracking --format=json
```

O passo 3 é o mais perecível: **Realtime só enxerga 30 minutos**. Faça um print
dentro dessa janela ou a evidência mais rápida se perde.

---

## FASE 4 — Só depois de 60 minutos, o reembolso

1. Reembolsar pelo Stripe.
2. Nos logs, confirmar **um único** `refund_dispatched` por destino, não dois.
   É isso que prova a correção 7.2.
3. No First Promoter, a comissão tem que virar negativa.
4. No GA4, a receita líquida do dia volta a zero — e agora isso é o
   comportamento **correto**, documentado, não um defeito.

---

## FASE 5 — Limpeza

Excluir do GA4 as transações de teste: a de 13/08 (`pi_3U40tr7nPZQ9eEGQ1xMtBxbP`),
a nova, e a receita antiga de ~US$1.500 em múltiplos de $229.

---

## Se a FASE 0 falhar

Nessa ordem, da causa mais provável para a menos:

1. **Filtro de dados** em estado *Active* descartando o tráfego do worker.
   Ver os dois lugares listados na seção da armadilha.
2. **Propriedade ou stream errado** — o `api_secret` precisa ter sido criado no
   **mesmo** data stream do measurement ID. São coisas separadas na interface.
3. **`session_id`** — rode o passo 3 do `diagnose.mjs`. Ele manda dois `purchase`
   que diferem só nesse parâmetro. Se só o que **não** tem `session_id` aparecer,
   é o defeito conhecido do GA4, e o worker já está no formato certo ao omitir.
4. **`client_id`** — o derivado `2927675193.981011370` não corresponde a usuário
   real. Isso estraga atribuição, mas não costuma impedir ingestão. É o último
   suspeito, não o primeiro.

---

# Anexo — Proof pack for Hillary (EN)

Present it as promise → evidence. Each row is a screenshot or an API response,
never a claim.

| Promise | Evidence to show |
|---|---|
| GA4 is the single source of truth for revenue | GA4 Transactions report with the transaction ID and its value |
| Purchases are tracked end to end | `purchase` event count in Engagement → Events, plus the matching Stripe payment |
| Refunds reverse revenue correctly | `refund` event, and net revenue returning to zero for that transaction |
| Affiliate attribution works | First Promoter commission `approved`, with GA4 session source showing the affiliate |
| Ad platforms receive the conversion | Meta CAPI `200`, TikTok `code=0`, deduplicated by `event_id` |
| No PHI reaches any analytics tool | Log field list: `action, code, dest, event, level, req_id, result, status, ts, version` |

**Two things to state plainly rather than let her discover them:**

1. **A fully refunded transaction correctly reads $0.00 in GA4.** GA4 subtracts a
   refund from the original purchase when both carry the same transaction ID. Zero
   revenue on a refunded test is the system working, not failing. Say this before
   showing the reports, or the first screenshot she sees will look like a failure.

2. **Consent wording needs a correction.** The delivered document says *"no tracking
   fires before a visitor accepts"*, but `analytics_storage` is `granted` by default
   and `_ga` cookies are written on load — which Hillary approved for the Humblytics
   A/B test. The behaviour is fine; the sentence is not. Fix the sentence.
