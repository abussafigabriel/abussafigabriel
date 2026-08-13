# SeshDx — diagnóstico do GA4, com evidência da API

Investigação fechada em 13/08/2026 consultando a **GA4 Data API**, a **Cloud Run
Admin API** e o **Cloud Logging** com a conta de serviço `claude-debug`.
Nada aqui vem de captura de relatório.

---

## Resposta

**Nenhum evento de Measurement Protocol chegou ao GA4 em 13/08.** Não é problema do
evento `purchase`, não é o `client_id`, e não é o reembolso subtraindo receita.

O worker mandou **7 eventos** entre 15:46 e 15:52, todos com `204`:

| Hora UTC | Evento | client_id usado | Está no GA4? |
|---|---|---|---|
| 15:46:36 | `intake_start` | `1234833447.1786635973` (real) | **Não** |
| 15:46:47 | `intake_start` | `1234833447.1786635973` (real) | **Não** |
| 15:49:04 | `generate_lead` | `1234833447.1786635973` (real) | **Não** |
| 15:49:42 | `begin_checkout` | `1234833447.1786635973` (real) | **Não** |
| 15:50:43 | `purchase` | `2927675193.981011370` (fantasma) | **Não** |
| 15:52:38 | `refund` | `2927675193.981011370` (fantasma) | **Não** |
| 15:52:38 | `refund` | `1234833447.1786635973` (real) | **Não** |

Tudo o que o GA4 registrou em 13/08 é evento de navegador: `page_view` 100,
`session_start` 46, `first_visit` 28, `scroll` 23, `quiz_start` 20,
`view_item_list` 13, `begin_checkout` 3, `view_item` 3, `form_start` 2, `click` 1.

Como eventos com o `client_id` **correto** também sumiram, a falha é do canal
inteiro, não de um evento específico.

### Correção do que eu disse antes

Eu afirmei que o reembolso havia subtraído a receita e que o `$0,00` era o
comportamento certo. **Isso está refutado.** O evento `refund` de 13/08 nunca
chegou ao GA4, então não subtraiu nada. O `$0,00` é ausência de dado, não
aritmética de reembolso.

---

## O que ficou descartado, com prova

| Hipótese | Descartada porque |
|---|---|
| Evento `purchase` não existe na propriedade | Existe: compras em 18/05, 20/05, 26/05, 03/06, 15/06, 17/06, 23/06, 26/06, 29/06, 06/07, 12/07, 23/07, 31/07, 02/08, 03/08, 06/08, **11/08** |
| Filtro de dados descartando tráfego | O filtro *Internal Traffic* está em estado **Testing**, não Active. `testDataFilterName` retorna `(not set)` para todos os 38.512 eventos: não casa com nada |
| Credencial mudou no Cloud Run | `GA4_MEASUREMENT_ID=G-WHP0DJ703Q` e o `GA4_API_SECRET` (sha `c06192d262`) são **idênticos** na revisão viva e nas de 11/08, quando as compras entravam |
| Latência de relatório | Eventos de navegador de 13/08 já estão na API. Os do worker, do mesmo período, não |
| Defeito do `session_id` | Eventos sem `session_id` e com `client_id` real também sumiram |

---

## O buraco de configuração que explica 12/08

As revisões do Cloud Run mostram uma janela em que o serviço rodou **sem o
measurement ID**:

| Revisão | Criada | MEASUREMENT_ID | env vars |
|---|---|---|---|
| `00034-cuz` | 11/08 02:59 | `G-WHP0DJ703Q` | 24 |
| `00027-tnm` | **11/08 18:30** | **ausente** | **1** |
| `00028-tgq` | 11/08 18:30 | **ausente** | **1** |
| `00029-fz4` | 13/08 12:26 | **ausente** | 9 |
| `00030-qxj` | 13/08 12:26 | `G-WHP0DJ703Q` | 16 |
| `00050-vid` | 13/08 16:06 | `G-WHP0DJ703Q` | 24 |

De **11/08 18:30 até 13/08 12:26** o serviço rodou com **1 variável de ambiente** e
sem measurement ID. Isso explica inteiramente por que a compra de teste de 12/08 —
que o First Promoter registrou — nunca apareceu no GA4.

É exatamente o acidente contra o qual o handoff avisa: `--set-env-vars` substitui o
conjunto inteiro. Alguém publicou com essa flag e apagou 23 das 24 variáveis.

**Mas em 13/08 15:50 a configuração já estava correta de novo.** Então o buraco
explica 12/08 e **não** explica 13/08.

---

## O que falta checar — 1 clique

Sobra uma hipótese, e ela é a mais provável: **o segredo guardado no Cloud Run pode
não valer mais do lado do GA4.** Provei que o valor *armazenado* não mudou; não
provei que o GA4 ainda o aceita. Se o segredo foi apagado ou rotacionado em
GA4 → Admin → Data Streams depois de 11/08, todo envio passa a receber `204` e
desaparecer — que é exatamente o sintoma.

Para eu confirmar daqui, falta habilitar uma API:

**https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=869202251383**

Clicar em **Enable**, esperar 2 minutos, avisar. Eu comparo os segredos que existem
hoje no stream com o `sha c06192d262` do Cloud Run e fecho o diagnóstico.

Sem isso, o caminho manual é **GA4 → Admin → Data Streams → o stream →
Measurement Protocol API secrets** e conferir quantos existem.

---

## Dois defeitos confirmados na compra de teste

Ambos apareceram nos logs de 15:50–15:52 e estão consistentes com as seções 7.2 e
7.3 do handoff. Confirmam que as correções da v5.1.1 eram necessárias — e que **não
foram exercitadas**, porque a v5.1.1 só subiu às 16:06, depois do teste.

**Reembolso em dobro, com `client_id` diferente em cada um:**

```
15:52:38  ga4_refund_outbound  clientIdPresent=false  2927675193.981011370
15:52:38  ga4_refund_outbound  clientIdPresent=true   1234833447.1786635973
15:52:47  refund_dispatched   (4 destinos)
15:52:49  refund_dispatched   (4 destinos)
```

Se o canal estivesse funcionando, isso teria gravado **um reembolso a mais do que a
compra**, num usuário que nunca comprou — receita negativa órfã.

**Timeout de entrega:**

```
15:52:41  background_dispatch_failed  dispatch_timeout_2500ms  refund.created
15:52:42  background_dispatch_failed  dispatch_timeout_2500ms  charge.refunded
```

---

## Defeito novo, que não está no handoff

```
15:50:42  level=error  event=stripe_purchase_missing_payment_intent
          eventType=invoice.payment_succeeded  chargeId=""  amountPaid=4.18
```

O caminho do `invoice.payment_succeeded` **não consegue extrair o payment intent** e
falha. A compra só passou porque o evento `payment_intent.succeeded` chegou
separado, um segundo depois, e esse funcionou.

Ou seja: hoje a captura da compra depende de um único caminho. Se a OpenLoop mudar a
ordem ou parar de emitir `payment_intent.succeeded`, a compra some — sem erro visível
para quem olha só o relatório.

---

## Um dado que merece atenção

Nenhuma transação com prefixo `pi_` jamais entrou no GA4. Os `transaction_id`
históricos são:

```
ch_3TePnpAWBcytp9Oj30VO3fKD    506.96
ch_3U1bWmAWBcytp9Oj2Z9nLfgS   1495.00
py_3TbSUhAWBcytp9Oj3Y7zgnhh    476.76
cus_V3P8ZJcdgo3qcK               2.17   <- ID de CLIENTE usado como transação
test-verify-2026                 0.01   <- teste manual de 11/08
```

A arquitetura atual usa `transaction_id = payment_intent` (`pi_`). O histórico usa
`ch_`, `py_` e — em 11/08 — até um `cus_`. Quando o canal voltar, os relatórios vão
misturar dois esquemas de identificação, e a receita antiga de ~US$1.500 continua lá
para ser excluída.
