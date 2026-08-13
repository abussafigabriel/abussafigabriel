# SeshDx — por que o GA4 mostra $0,00 na compra de 13/08

**Resposta curta: o pipeline provavelmente funcionou. O relatório mostra zero porque
o teste apagou a própria evidência ao reembolsar 115 segundos depois.**

Este documento corrige a hipótese nº 1 da seção 6 do handoff.

---

## 1. O que aconteceu

```
15:50:43 UTC   purchase   $4,18   transaction_id = pi_3U40tr7nPZQ9eEGQ1xMtBxbP
15:52:38 UTC   refund     $4,18   transaction_id = pi_3U40tr7nPZQ9eEGQ1xMtBxbP
                                  ^^^^^^^^^^^^^^ o MESMO id, 115 segundos depois
```

No GA4, um evento `refund` que traz **o mesmo `transaction_id`** e **o valor cheio**
não é "mais um evento". É a definição de **reembolso total**: o GA4 usa o
`transaction_id` para localizar a compra original e **subtrair a receita dela**.

Resultado aritmético: `+4,18 − 4,18 = 0,00`.

É exatamente o que as quatro capturas de tela mostram:

| Relatório | Mostra | Por quê |
|---|---|---|
| Purchase revenue | `$0,00` | receita da compra menos a do reembolso |
| Purchases / Ecommerce purchases | `0` | a transação foi revertida |
| Transactions | vazio | idem |
| Best sellers | "No data available" | receita por item também zerou |

Somado à latência de 24–48h dos relatórios processados, **as capturas são
compatíveis com um pipeline 100% funcional**. Elas não provam defeito nenhum.

### Correção ao que eu mesmo afirmei antes

Numa versão anterior deste documento eu escrevi que "um `refund` nunca apaga um
`purchase`". Isso vale para a **contagem do evento**, e é falso para as **métricas
de receita**. A distinção é justamente o que resolve este caso — ver seção 2.

---

## 2. O único lugar que dá a resposta: contagem de evento, não receita

O reembolso zera a **receita**. Ele **não apaga o evento `purchase` da contagem**.

Então o discriminador é:

> **GA4 → Reports → Engagement → Events**, data de hoje.
> Procurar as linhas `purchase` e `refund` na coluna **Event count**.

- **Aparecem com contagem ≥ 1** → o GA4 recebeu tudo. O `$0,00` está **correto**,
  o pipeline está provado, e o problema nº 1 do handoff não existe.
- **Não aparecem depois de 48h** → aí sim o evento foi descartado apesar do `204`.

Não adianta olhar Transactions nem Reports snapshot: os dois medem receita, e
receita reembolsada é zero por definição.

*Observação:* o Realtime tem janela de **30 minutos**. A compra foi 15:50 e o
handoff é 16:10 — essa janela já fechou. Realtime não serve mais para esta compra.

---

## 3. Prova imediata, sem esperar 48h e sem gastar nada

`diagnose.mjs` manda um `purchase` sintético com `debug_mode: 1` pelas **mesmas
credenciais do worker** e ele aparece no **DebugView em ~30 segundos**.

Isso separa em definitivo as duas únicas explicações que restam:
"GA4 não ingere o que o worker manda" contra "GA4 ingeriu e o relatório está certo".

```bash
# 1. Ler o api_secret da revisão viva (não está neste repositório):
gcloud run revisions describe seshdx-tracking-webhook-00050-vid \
  --region=us-central1 --project=seshdx-tracking --format=json

# 2. Rodar a escada de diagnóstico:
node diagnose.mjs --measurement-id G-WHP0DJ703Q --api-secret <valor_do_env>
```

Os três passos:

1. **Validação de schema** em `/debug/mp/collect` — não escreve nada. (Este
   endpoint **não** confere o `api_secret`, então passar aqui não prova credencial.)
2. **Prova de credencial** — `purchase` com `debug_mode: 1`. Abrir
   **GA4 → Admin → DebugView**. Apareceu em ~30s: measurement ID, API secret e
   propriedade estão certos, e o worker consegue escrever nesta propriedade.
   Ficou vazio: achamos o defeito.
3. **A/B de `session_id`** — dois `purchase` que diferem só nesse parâmetro.

Leitura do resultado:

- **Aparece no DebugView** → GA4 ingere normalmente. O `$0,00` é o reembolso. Fim.
- **Não aparece** → credencial ou propriedade errada, ou filtro de dados
  (Admin → Data Streams → Data filters) descartando o tráfego do worker.

---

## 4. Correção importante ao handoff: **não** adicionar `session_id`

A seção 6 lista "`session_id` ausente no payload" como suspeita nº 1. A
documentação do Google de fato diz que `session_id` e `engagement_time_msec` são
necessários para relatórios com escopo de sessão.

**Na prática, para eventos `purchase`, é o contrário.** Existe um defeito
conhecido e longo do GA4 em que `purchase` enviado por Measurement Protocol
**com** `session_id` é aceito com `204` e depois nunca processado, enquanto o
mesmo evento **sem** `session_id` entra normalmente.

O worker hoje **não** envia `session_id` — ou seja, já está no formato seguro.
Adicionar esse parâmetro para "consertar" o problema tem chance real de
**quebrar** o que está funcionando. O passo 3 do `diagnose.mjs` mede isso na
propriedade de vocês em vez de apostar.

---

## 5. O que continua sendo problema de verdade

O `$0,00` é explicável. O item da seção 7.1 do handoff **não** é, e ele é o que
de fato compromete a promessa de "GA4 como fonte única de verdade":

A compra foi ao GA4 com `clientIdPresent: false` e `client_id` derivado
`2927675193.981011370`, em vez do real `1234833447.1786635973`. A receita entra,
mas colada num **usuário fantasma**, atribuída a `(direct)/(none)` — não ao
afiliado nem à campanha.

Sintoma disso já visível nas capturas: `seshdiagnostics.co…` aparece como
**referral de si mesmo** na lista de Session source/medium. É auto-referência: o
salto para o checkout está abrindo sessão nova e descartando a origem.

A correção (janela de releitura 3×600ms → 8×1200ms) foi publicada na v5.1.1
**depois** da compra de teste e nunca viu tráfego real.

`reference/mapping.js` documenta o formato de payload correto e serve de conferência:

```bash
node dry-run.mjs --sample          # usa o pi_3U40tr… real
node dry-run.mjs evento.json
```

Ele reproduz o defeito de forma visível — com `metadata: {}` vazio, reporta
`client_id source: synthetic`. **É referência, não é para publicar.** O fonte
canônico do worker é `Support/Analytics/serverless-v5/` (seção 10 do handoff).

---

## 6. Próximo teste — o desenho que não se autodestrói

O teste de 13/08 não podia dar certo: reembolsar em 115 segundos zera a receita
antes de qualquer relatório processar. O próximo precisa ser:

1. Confirmar a versão viva: `curl -s https://seshdx-tracking-webhook-869202251383.us-central1.run.app/health` → esperar `5.1.1`.
2. Fazer a compra **chegando por link de afiliado**, para exercitar a atribuição.
3. **Não reembolsar.** Deixar parada no mínimo 60 minutos.
4. Dentro dos primeiros 30 minutos: **Realtime → Event count by Event name**,
   confirmar `purchase`. Essa é a janela em que Realtime ainda enxerga.
5. Nos logs do worker, confirmar `clientIdPresent: true` e o `client_id` real —
   é o que prova a correção 7.1.
6. Só depois disso, reembolsar — e aí confirmar a correção 7.2 (um único
   `refund_dispatched` por destino, não dois).
7. Excluir as duas transações de teste do GA4 no fim.

O passo 3 é o que faltou. Sem ele, mesmo um pipeline perfeito reporta `$0,00`.

---

## 7. Resumo do que precisa do Gabriel

| # | Ação | Tempo |
|---|---|---|
| 1 | GA4 → Reports → Engagement → Events (hoje): `purchase` e `refund` aparecem na **Event count**? | 2 min |
| 2 | Ler `GA4_API_SECRET` da revisão `00050-vid` e rodar `diagnose.mjs`, olhando o DebugView | 5 min |
| 3 | Segunda compra de teste **sem reembolsar por 60 min**, entrando por link de afiliado | 15 min |

Os itens 1 e 2 são independentes e podem ser feitos em paralelo. O item 2 é o que
dá resposta definitiva hoje, sem esperar as 48h de processamento.
