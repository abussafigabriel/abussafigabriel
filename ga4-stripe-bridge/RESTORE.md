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

Esperado: `"version":"5.1.2"` e `"ga4":true` (ou `5.1.1`, se você tiver voltado para a `00051-sfx`).

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

---

# Revogar a chave `claude-debug` — faça isto ao fim do projeto

A conta de serviço `claude-debug@seshdx-tracking.iam.gserviceaccount.com` foi
criada para este diagnóstico e tem poderes altos (Cloud Run Admin, Datastore
Owner). A chave dela circulou em conversa. **Precisa ser apagada.**

Não é urgente ao ponto de derrubar nada: apagar a chave não afeta o serviço em
produção, que roda com outra identidade (`869202251383-compute@developer...`).

## Pelo console, sem comando

1. Abrir **https://console.cloud.google.com/iam-admin/serviceaccounts?project=seshdx-tracking**
2. Clicar em **claude-debug@seshdx-tracking.iam.gserviceaccount.com**
3. Aba **KEYS** → localizar a chave de id `0fb61f39ce239dcda3b220ffd2b52d3f7f7bf441`
   → ícone de lixeira → **Delete**
4. Opcional, mais seguro ainda: voltar à lista e **excluir a conta de serviço
   inteira**, já que ela não é usada por nada em produção.

## Também vale apagar

- O arquivo da chave em `_INTERNO_NAO_COMPARTILHAR/` na sua máquina.
- O acesso dessa conta ao GA4: **GA4 → Admin → Property access management** →
  remover `claude-debug@seshdx-tracking.iam.gserviceaccount.com`.

## Como confirmar que deu certo

Depois de apagar, qualquer script deste pacote que use a chave deve falhar com
erro de credencial inválida. Se falhar, está revogada.
