# Restaurar o estado bom conhecido

**Estado validado em 13/08/2026 20:14 UTC.** Compra e reembolso comprovadamente
ingeridos pelo GA4, com atribuição correta e sem duplicação.

```
revisao : seshdx-tracking-webhook-00051-sfx
imagem  : ...seshdx-tracking-webhook@sha256:23fc981dc453ce07c6075cd9fafbfc6b33035b4bdda21e5cd5f8bf5a10bb6089
env     : 24 variaveis  |  GA4_API_SECRET sha 0d3a6bf767  |  G-WHP0DJ703Q
```

## Se algo quebrar — um comando

```bash
gcloud run services update-traffic seshdx-tracking-webhook \
  --region=us-central1 --project=seshdx-tracking \
  --to-revisions=seshdx-tracking-webhook-00051-sfx=100
```

Revisões do Cloud Run são **imutáveis**: `00051-sfx` continua existindo com os
segredos corretos dentro dela, aconteça o que acontecer com as revisões novas.
Por isso este arquivo não precisa guardar segredo nenhum — e não guarda.

A v5.1.2 (`00052-v512`) é a revisão atual: mesma entrega, só com correções de
log e timeout. O alvo de rollback continua sendo `00051-sfx`, que é o estado
comprovado com tráfego real.

`KNOWN-GOOD-SNAPSHOT.json` tem a configuração completa, com os 9 valores
sensíveis substituídos por impressão digital SHA-256 para conferência.

## Como confirmar que a restauração funcionou

```bash
curl -s https://seshdx-tracking-webhook-869202251383.us-central1.run.app/health
```

Esperado: `"version":"5.1.1"` e `"ga4":true` (ou `5.1.2`, se restaurar a `00052-v512`).

## Histórico de revisões relevante

| Revisão | Estado |
|---|---|
| `00052-v512` | ✅ **ATUAL** — v5.1.2. Correções de log e timeout; caminho de entrega intacto |
| `00051-sfx` | ✅ **ALVO DE ROLLBACK** — v5.1.1 + segredo correto. Estado comprovado com tráfego real |
| `00050-vid` | ❌ v5.1.1 com segredo morto — GA4 recebia 204 e descartava |
| `00048-vut` | ❌ v5.1.0, segredo morto, sem correções 7.1/7.2 |
| `00027-tnm` | ❌ 1 env var, sem measurement ID |

**Nunca use `--set-env-vars`** — substitui o conjunto inteiro. Foi assim que 23 das
24 variáveis foram apagadas em 11/08. Use `--update-env-vars`.
