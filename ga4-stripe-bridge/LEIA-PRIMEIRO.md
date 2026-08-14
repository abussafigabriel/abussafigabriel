# SeshDx Analytics — pacote de entrega

Tudo do projeto de tracking, fechado em **14/08/2026**.
Os números vieram da API do Google Analytics e dos logs do serviço, não de
captura de tela.

---

## Comece por aqui

| Se você quer… | Abra |
|---|---|
| Entender o que estava quebrado e por quê | `01-DIAGNOSTICO.md` |
| Ver a prova de que funciona | `02-EVIDENCIAS.md` |
| Saber o que mudou na última versão | `03-CORRECOES-v5.1.2.md` |
| Repetir o teste de compra no futuro | `04-RUNBOOK.md` |
| **Consertar algo que quebrou** | `05-RESTAURAR.md` |
| Corrigir uma frase no relatório da cliente | `06-CORRECAO-DOCUMENTO-CLIENTE.md` |

**Página para a Hillary** (em inglês, link privado — só ela vê se você
compartilhar): https://claude.ai/code/artifact/ef430dee-2f50-43b6-bc80-fba64a4ba4a7

---

## O resumo em cinco linhas

O Google Analytics não recebia compra nenhuma porque o segredo de autenticação
tinha sido trocado do lado do Google, e o serviço continuava assinando com o
valor antigo. O Google respondia "recebido" e descartava tudo — por isso os logs
mostravam sucesso e os relatórios mostravam zero.

Corrigido em 13/08. Desde então: uma compra de teste, um reembolso e **uma compra
de cliente real de US$ 145** entraram corretamente, sem nenhum erro.

---

## O que está em produção agora

```
serviço  seshdx-tracking-webhook   (Google Cloud Run, us-central1)
revisão  seshdx-tracking-webhook-00052-v512
versão   5.1.2
estado   sem erros desde 13/08 21:35 UTC
```

**Se algo quebrar, abra `05-RESTAURAR.md`.** É um comando só, e a versão boa
anterior continua guardada e intacta no Google Cloud.

---

## As pastas

### `codigo-fonte/`

O código que roda em produção. **Esta é a única cópia versionável** — a
freelancer nunca entregou o fonte, e isto foi recuperado de dentro da imagem do
container. Não perca.

```
src/          o serviço
test/         24 testes automáticos
```

Para rodar os testes (precisa do Node.js instalado):

```
cd codigo-fonte
node test/timeout.test.mjs         → 10/10
node test/payment-intent.test.mjs  → 14/14
```

### `ferramentas/`

Scripts de diagnóstico, para o dia em que desconfiar do tracking de novo:

- **`ga4-query.mjs`** — pergunta direto à API do Google se um evento ou uma
  transação chegou. É o que responde "chegou ou não chegou" sem depender de
  relatório.
- **`diagnose.mjs`** — testa se o Google Analytics está aceitando compras, sem
  precisar comprar nada.
- **`dry-run.mjs`** — mostra o que um evento do Stripe vira antes de mandar.

Cada arquivo explica o uso no topo.

### `KNOWN-GOOD-SNAPSHOT.json`

Fotografia da configuração que está funcionando. Os 9 valores sensíveis estão
substituídos por impressão digital — **não há nenhuma senha neste pacote.**

---

## Três coisas para não esquecer

**1. Revogue a chave `claude-debug`.** Ela foi criada para este diagnóstico e
precisa ser apagada. Passo-a-passo no fim do `05-RESTAURAR.md`.

**2. As transações de teste continuam no histórico.** O Google Analytics não
apaga uma transação específica — só por intervalo de datas, o que levaria dado
real junto. A lista de IDs para ignorar nos relatórios está no `04-RUNBOOK.md`.

**3. Nunca use `--set-env-vars` em deploy.** Foi assim que 23 das 24
configurações do serviço foram apagadas em 11/08. Use `--update-env-vars`.
