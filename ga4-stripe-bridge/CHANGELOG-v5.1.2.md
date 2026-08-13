# v5.1.2 — 13/08/2026 21:35 UTC

Revisão `seshdx-tracking-webhook-00052-v512`
imagem `sha256:f94bc05345f9964fe0169c88659c6268402a8ca78a15fd9c23795e0d7efc69e8`

Fecha as duas pendências que sobraram da validação da v5.1.1.

---

## 1. Timeout de fan-out — falso alarme eliminado

**Sintoma:** `background_dispatch_failed dispatch_timeout_15000ms` nos dois testes
de 13/08, seguido segundos depois por um `*_dispatched` com os quatro destinos em
200/204. Erro registrado para trabalho que deu certo.

**Causa:** `Promise.race` não cancela o que perde a corrida. O fan-out continuava e
concluía, mas o `withTimeout` já havia rejeitado e o chamador logava erro.

**Correção** (`src/services/tasks.js`): o limite continua existindo — ele impede que
um job travado prenda a requisição — mas estourá-lo virou **aviso de lentidão**, não
falha. O resultado verdadeiro é sempre registrado quando chega:

| Situação | Antes | Agora |
|---|---|---|
| Termina dentro do prazo | valor real | valor real, sem log |
| Falha dentro do prazo | erro propagado | erro propagado |
| Demora e **conclui** | `[ERRO] dispatch_failed` | `[warn] background_dispatch_slow` e depois `background_dispatch_late_success` |
| Demora e **falha** | `[ERRO] dispatch_failed` | `[warn]` e depois `[ERRO] background_dispatch_failed` com o erro real |

A última linha é a que importa: falha de verdade **continua** virando erro. O aviso
não esconde problema, só para de inventar um.

**E o limite subiu para 90s** (`config.js` e `DESTINATION_TIMEOUT_MS`), medido e não
chutado: o fan-out do reembolso levou 40s (First Promoter sozinho responde em 9–12s,
mais três escritas no Firestore). O padrão anterior era 3500ms.

## 2. `invoice.payment_succeeded` — erro que não era erro

**Sintoma:** `[ERRO] stripe_purchase_missing_payment_intent` em toda compra.

**Causa:** o Stripe removeu `payment_intent` e `charge` do topo do Invoice na
Invoice Payments API de 2025 e moveu para `payments`, uma sub-lista que o webhook
**não expande por padrão**. Nesta conta a invoice chega sem os três.

**O que não dá para fazer:** buscar na API do Stripe. O serviço tem apenas a chave
**publicável** — não há `STRIPE_SECRET_KEY` nas 24 variáveis. O cliente Stripe só
serve para validar assinatura.

**Correção** (`src/handlers/stripe.js`):

- `getPaymentIntentIdFromInvoice` passou a cobrir todos os formatos documentados:
  campo direto, charge expandido, `payments[].payment`, `payments[].payment_details`
  e `lines[]`. 14 testes cobrem cada um, incluindo o payload real de 13/08.
- Quando mesmo assim não há payment intent, isso deixou de ser `logError` e virou
  `logInfo('stripe_purchase_deferred')` com o campo `handoff`. **É um repasse
  projetado, não uma falha:** o `payment_intent.succeeded` chega logo depois e
  registra a compra. O código já se recusava, corretamente, a mandar uma compra sem
  `transaction_id` — só estava gritando errado.

O comportamento de captura **não mudou**. O que mudou é que uma revisão de log
deixa de mostrar erro num fluxo saudável.

---

## Testes

```bash
cd serverless-v5
node test/timeout.test.mjs         # 10/10
node test/payment-intent.test.mjs  # 14/14
```

## Validação em produção

```
/health  ->  200  {"ok":true,"version":"5.1.2", todas as dependencias true}
logs da revisao 00052-v512  ->  0 erros, server_started limpo
```

## Rollback

```bash
gcloud run services update-traffic seshdx-tracking-webhook \
  --region=us-central1 --project=seshdx-tracking \
  --to-revisions=seshdx-tracking-webhook-00051-sfx=100
```

`00051-sfx` é o estado **comprovado com tráfego real** (compra + reembolso
ingeridos). A v5.1.2 mudou apenas semântica de log e um limite de tempo — não
tocou no caminho de entrega — mas o alvo de rollback continua sendo ela.
