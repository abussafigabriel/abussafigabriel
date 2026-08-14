# Correção a fazer no "SeshDx Analytics Progress Report"

Documento no Drive: **SeshDx Analytics Progress Report** (23/07/2026)
https://docs.google.com/document/d/1iNrNrFg6bx4p8w6wnxp_Mtx9bmewZA7V5z4tyhPYl08/edit

**Isto é ajuste interno de precisão. Não vai para a cliente como "erramos".**
A configuração está certa e foi aprovada por ela — só a frase que descreve está
imprecisa. Corrija na próxima revisão do documento, sem alarde.

---

## Onde está

Seção **"What's Built and Confirmed Working"** → subseção
**"Consent and cookie banner — already solid"**.

## Frase atual (imprecisa)

> Good news here: your existing cookie consent setup (Google's Consent Mode v2)
> was already correctly implemented before we started. **Tracking tools stay off
> until a visitor accepts cookies, and switch on immediately after.** Our new
> tracking code follows this exact same pattern, so nothing we add changes your
> compliance posture.

## Frase corrigida

> Good news here: your existing cookie consent setup (Google's Consent Mode v2)
> was already correctly implemented before we started. **Advertising and
> marketing tags stay off until a visitor accepts cookies. Analytics measurement
> runs by default — the configuration you approved so the Humblytics A/B tests
> keep collecting data — and the banner governs everything else.** Our new
> tracking code follows this exact same pattern, so nothing we add changes your
> compliance posture.

## Por que a frase original está errada

O texto diz que **nenhuma** ferramenta dispara antes do aceite. Na prática:

| Sinal de consentimento | Estado antes do aceite |
|---|---|
| `analytics_storage` | **`granted`** — o cookie `_ga` é gravado no carregamento |
| `ad_storage` / `ad_user_data` / `ad_personalization` | `denied` |
| `functionality_storage`, `personalization_storage` | `granted` |
| `security_storage` | `granted` |

Ou seja: **publicidade** realmente espera o aceite; **medição** não. Isso foi
decisão da Hillary, para os testes A/B do Humblytics continuarem funcionando —
sem `analytics_storage` liberado por padrão, o Humblytics perde a amostra.

O comportamento está correto e é intencional. O que estava errado era o resumo
generalizar "tracking tools" quando o certo é distinguir publicidade de medição.

## Risco de deixar como está

Baixo, mas real: se alguém da equipe de compliance ou jurídico da SeshDx ler o
relatório e depois auditar o site, vai encontrar `_ga` gravado antes do aceite e
concluir que o relatório não bate com a implementação. É melhor a frase estar
precisa antes que essa pergunta apareça de outra pessoa.
