const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export async function callClaude(messages, maxTokens = 1000) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY não configurada no servidor. Defina essa variável de ambiente.");
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) {
    console.error("Erro da API Anthropic:", resp.status, JSON.stringify(data));
    throw new Error(data?.error?.message || `Erro na API da Anthropic (status ${resp.status}). Veja os logs do servidor no Railway para mais detalhes.`);
  }
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text) {
    console.error("Resposta da Anthropic sem texto. stop_reason:", data.stop_reason, "content:", JSON.stringify(data.content));
    throw new Error(`A IA não retornou texto (stop_reason: ${data.stop_reason || "desconhecido"}). Veja os logs do servidor no Railway para mais detalhes.`);
  }
  return text;
}

export function extractJsonBlock(text) {
  let t = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  if (start > 0) t = t.slice(start);
  return t;
}

// Repara JSON truncado por corte de max_tokens (bracket-balancing genérico).
// Reaproveitado tanto na extração de exames quanto na análise de alertas.
export function repairJson(text) {
  return parseExamJson(text);
}

// Percorre o texto caractere a caractere, respeitando strings/escapes, e acha o
// último ponto em que uma estrutura ({...} ou [...]) foi fechada por completo.
// Isso é bem mais confiável do que procurar a última ocorrência literal de "},",
// que pode aparecer dentro de um valor de texto e cortar a estrutura errada.
function findLastSafeJsonCut(t) {
  let inString = false;
  let escape = false;
  let lastSafeCut = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "}" || ch === "]") lastSafeCut = i + 1;
  }
  return lastSafeCut;
}

function closeOpenBrackets(t) {
  let inString = false;
  let escape = false;
  const stack = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = t;
  while (stack.length) {
    out += stack.pop() === "{" ? "}" : "]";
  }
  return out;
}

export function parseExamJson(text) {
  const t = extractJsonBlock(text);
  try {
    return JSON.parse(t);
  } catch (e) {
    const cut = findLastSafeJsonCut(t);
    if (cut === -1) throw e;
    let repaired = t.slice(0, cut).replace(/,\s*$/, "");
    repaired = closeOpenBrackets(repaired);
    try {
      return JSON.parse(repaired);
    } catch (e2) {
      throw e;
    }
  }
}

export const EXTRACTION_PROMPT = `Você é um assistente que le laudos de exames laboratoriais em PDF (de qualquer laboratório) e extrai os resultados em JSON compacto. Responda APENAS com JSON valido, sem markdown, sem comentarios, sem texto antes ou depois.

Formato exato:
{"d":"YYYY-MM-DD","l":"nome do laboratorio ou null","m":"nome do medico solicitante/responsavel ou null","e":[{"n":"nome do exame","v":"valor","u":"unidade ou vazio","r":"faixa de referencia como texto","s":"N|A|F","c":"categoria curta"}]}

Regras:
- "d" e a data de coleta ou emissao do laudo (formato YYYY-MM-DD). Se nao encontrar, use null.
- "m" e o nome do medico que solicitou o exame ou e responsavel tecnico pelo laudo, se estiver escrito no documento (ex: "Dr. Fulano de Tal"). Nao inclua CRM/registro, so o nome. Se nao encontrar nenhum nome de medico, use null.
- "s" (status): "N" se o valor esta dentro da faixa ideal/referencia, "A" se esta no limite/borderline (proximo do limite, ou o laudo already sinaliza atencao), "F" se esta fora da faixa de referencia (alto ou baixo).
- Inclua TODOS os exames encontrados no laudo, mas seja extremamente conciso: nomes curtos, sem repetir unidades no texto de referencia.
- "c" categoria curta (ex: Hematologia, Bioquimica, Hormonios, Lipidograma, Vitaminas, Urina, Outro).
- Nao invente valores. Se um campo nao existir, use string vazia.
- Responda em portugues.`;

export const INVOICE_EXTRACTION_PROMPT = `Você é um assistente que lê notas fiscais, recibos e faturas de despesas médicas/odontológicas em PDF (nota fiscal de produto, NFS-e de serviço de qualquer prefeitura, recibo de profissional liberal, fatura de plano de saúde) e extrai os dados relevantes para a declaração de Imposto de Renda no Brasil. Responda APENAS com JSON válido, sem markdown, sem comentários, sem texto antes ou depois.

Formato exato:
{"d":"YYYY-MM-DD","prov":"nome do prestador ou estabelecimento","doc":"CNPJ ou CPF do prestador, somente numeros, ou vazio","v":123.45,"desc":"descricao curta do servico ou produto","cat":"categoria","deduct":true}

Regras:
- "d": data de emissao do documento (YYYY-MM-DD). Se nao encontrar, use null.
- "v": valor total pago, como numero (ponto decimal, sem separador de milhar, sem simbolo de moeda).
- "cat": uma destas categorias curtas: "Consulta medica", "Exame", "Odontologico", "Hospital", "Plano de saude", "Fisioterapia", "Psicologo", "Terapia ocupacional", "Fonoaudiologia", "Medicamento", "Outro".
- "deduct": true se, pelas regras gerais do Imposto de Renda no Brasil, esse tipo de despesa costuma ser dedutivel como despesa medica (consultas, exames, hospital, plano de saude, dentista, fisioterapia, fonoaudiologia, terapia ocupacional, psicologo, com CNPJ/CPF do prestador identificado). Use false para farmacia/medicamento comprado avulso, academia, suplemento, estetica, ou quando nao houver CNPJ/CPF do prestador identificado no documento.
- Nao invente valores. Se um campo nao existir, use string vazia (ou null para "d").
- Responda em portugues.`;

export function buildAlertsPrompt(examHistoryText, bodyHistoryText, symptomsText, activitiesText) {
  return `Você é um assistente clínico de apoio (não substitui um médico e NÃO faz diagnóstico) analisando quatro fontes de dados de uma pessoa, em conjunto, para decidir se faz sentido sugerir que ela peça exames complementares novos.

1) Histórico de exames laboratoriais (cada bloco é um laudo, do mais antigo para o mais recente):
${examHistoryText || "Nenhum exame laboratorial registrado ainda."}

2) Histórico de composição corporal e saúde física (peso, IMC, % de gordura, massa muscular, pressão arterial, frequência cardíaca etc., do mais antigo para o mais recente):
${bodyHistoryText || "Nenhuma medição de composição corporal registrada ainda."}

3) Sintomas relatados pela pessoa (podem estar ativos ou já resolvidos):
${symptomsText || "Nenhum sintoma relatado."}

4) Atividades físicas registradas (do mais antigo para o mais recente):
${activitiesText || "Nenhuma atividade física registrada."}

Seu trabalho é CRUZAR essas quatro fontes — por exemplo: um sintoma relatado (ex.: cansaço, queda de cabelo, palpitação) combinado com um exame em atenção/fora do ideal, uma tendência de piora na composição corporal, ou um padrão de atividade física (excesso, ausência total, ou intensidade alta com sintomas associados) é um motivo bem mais forte para sugerir um exame do que qualquer uma das fontes isolada. Use essa combinação para tornar as sugestões mais direcionadas e precisas, mas o resultado continua sendo uma SUGESTÃO DE EXAME, nunca um diagnóstico de doença.

Seu critério deve ser rigoroso e conservador:
- SÓ sugira um exame novo/complementar se houver um motivo concreto: um resultado fora da faixa (F) que pede confirmação, uma tendência de piora ao longo do tempo (exames, composição corporal ou sinais cardiovasculares como pressão arterial e frequência cardíaca), um sintoma que persiste/agrava e que faz sentido investigar junto com os dados disponíveis, um padrão de atividade física relevante combinado com outros dados, ou uma combinação relevante entre essas fontes.
- NÃO sugira exames "de rotina" genéricos, exames já feitos recentemente sem motivo de repetir, nem sugestões vagas tipo "faça check-up completo". Sintomas ou padrões de atividade isolados, sem nenhum apoio nos dados numéricos e sem persistência, também não bastam sozinhos, a menos que sejam claramente compatíveis com uma investigação específica.
- Se os dados não justificarem nenhum exame novo agora, retorne temSugestoes:false — isso é o resultado esperado na maioria das vezes, não force sugestões para parecer útil.
- Cada sugestão precisa citar o dado concreto que a motiva (exame, valor, data, medição corporal, sintoma ou atividade), mas em UMA frase curta (até ~25 palavras) — sem repetir o histórico inteiro.
- Nunca diagnostique doenças, nunca nomeie uma condição médica como conclusão, nunca cite nomes de medicamentos. Nunca use tom alarmista.
- No máximo 4 sugestões. Seja extremamente conciso: essa resposta tem um limite curto de tamanho.

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois, no formato exato (resumo com no máximo 2 frases curtas, motivo com no máximo 1 frase curta):
{"temSugestoes": true|false, "resumo": "1-2 frases curtas explicando a conclusão geral, mencionando se sintomas ou atividades influenciaram", "sugestoes": [{"exame": "nome do exame sugerido", "motivo": "1 frase curta baseada em dado(s) concreto(s) — pode combinar exame/corpo/sintoma/atividade", "urgencia": "baixa|media|alta"}]}

Responda em português.`;
}

export function buildTipsPrompt(examSummaryText, bodyHistoryText, symptomsText, activitiesText) {
  return `Você é um assistente de bem-estar (não substitui um médico e NÃO faz diagnóstico) gerando dicas gerais de estilo de vida para uma pessoa, com base em quatro fontes de dados combinadas:

1) Exames alterados ou em atenção nesse laudo:
${examSummaryText || "Nenhum exame fora do ideal — todos dentro da normalidade."}

2) Histórico recente de composição corporal e saúde física (peso, IMC, % de gordura, massa muscular, pressão arterial, frequência cardíaca etc.):
${bodyHistoryText || "Nenhuma medição de composição corporal registrada ainda."}

3) Sintomas relatados pela pessoa (ativos ou já resolvidos):
${symptomsText || "Nenhum sintoma relatado."}

4) Atividades físicas recentes:
${activitiesText || "Nenhuma atividade física registrada."}

Cruze essas quatro fontes ao montar as dicas — por exemplo, uma tendência de ganho de peso combinada com um exame alterado, um sintoma relatado que se conecta a um valor de exame, ou pouca/nenhuma atividade física registrada apesar de um quadro que se beneficiaria de exercício, tornam a dica mais relevante e específica do que olhar cada fonte isoladamente. Se a pessoa já pratica atividade física com frequência, reconheça isso e ajuste as dicas de acordo (não repita "comece a se exercitar" para quem já treina regularmente).

Regras:
- Gere de 3 a 6 dicas práticas de estilo de vida (alimentação, sono, exercício, hidratação, acompanhamento médico) em português.
- Nunca diagnostique doenças, nunca nomeie uma condição médica como conclusão, nunca cite nomes de medicamentos.
- Seja direto, sem markdown.

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois, no formato exato:
{"resumo":"1-2 frases gerais sobre o quadro, mencionando se sintomas, composição corporal ou atividade física influenciaram","dicas":["dica 1","dica 2", "..."]}`;
}

export const BODY_PHOTO_EXTRACTION_PROMPT = `Você recebe uma foto de uma balança de bioimpedância, de um aparelho de pressão arterial, da tela de um smartwatch, ou do app de saúde/composição corporal de algum desses aparelhos (ex: Mi Fit/Zepp, Renpho, Withings, InBody, Omron, Apple Saúde, etc). Extraia os valores visíveis na imagem.

Responda APENAS com JSON válido, sem markdown, sem comentários, sem texto antes ou depois, no formato exato:
{"date":"YYYY-MM-DD ou null","weightKg":numero ou null,"heightCm":numero ou null,"bodyFatPct":numero ou null,"muscleMassKg":numero ou null,"visceralFat":numero ou null,"boneMassKg":numero ou null,"bodyWaterPct":numero ou null,"proteinPct":numero ou null,"bmrKcal":numero ou null,"systolicBp":numero ou null,"diastolicBp":numero ou null,"restingHeartRate":numero ou null}

Regras:
- Só preencha um campo se o valor estiver claramente legível na imagem. Se não aparecer ou estiver ilegível, use null — NUNCA invente ou estime um valor.
- "date": use a data mostrada na tela do app, se houver. Se não houver nenhuma data visível, use null (não assuma a data de hoje).
- "proteinPct" é o percentual de proteína corporal (bioimpedância), se o aparelho mostrar essa métrica.
- "systolicBp" e "diastolicBp" são a pressão arterial sistólica e diastólica em mmHg (ex: em "120/80 mmHg", sistólica=120, diastólica=80).
- "restingHeartRate" é a frequência cardíaca em bpm (batimentos por minuto).
- Números sempre em kg, cm, %, kcal, mmHg ou bpm conforme o campo (converta se a imagem mostrar outra unidade, ex: libras para kg).
- Se a imagem não for de nenhum desses aparelhos/apps, ou nenhum valor estiver legível, retorne todos os campos como null.`;

// Idade metabólica: não existe uma fórmula pública única para isso (cada fabricante de
// balança usa seu próprio algoritmo proprietário). Aqui pedimos pra IA estimar com base em
// referências gerais de população para idade/sexo — é uma ESTIMATIVA educativa, não uma
// medição clínica, e o prompt deixa isso explícito na explicação retornada.
// IMPORTANTE: pedimos uma DIFERENÇA (anos a mais/menos que a idade real) em vez de pedir
// direto "a idade metabólica" — isso evita que o modelo só devolva preguiçosamente a mesma
// idade cronológica que foi informada no prompt. A idade final é calculada aqui no código
// (idade real + diferença), não confiamos num número absoluto que a IA possa ter copiado.
export function buildBodyAgePrompt(chronologicalAge, gender, metrics) {
  const genderLabel = gender === "M" ? "masculino" : gender === "F" ? "feminino" : "não informado";
  const lines = [];
  if (metrics.weightKg != null) lines.push(`Peso: ${metrics.weightKg} kg`);
  if (metrics.heightCm != null) lines.push(`Altura: ${metrics.heightCm} cm`);
  if (metrics.bodyFatPct != null) lines.push(`Gordura corporal: ${metrics.bodyFatPct}%`);
  if (metrics.muscleMassKg != null) lines.push(`Massa muscular: ${metrics.muscleMassKg} kg`);
  if (metrics.visceralFat != null) lines.push(`Gordura visceral (índice): ${metrics.visceralFat}`);
  if (metrics.bodyWaterPct != null) lines.push(`Água corporal: ${metrics.bodyWaterPct}%`);
  if (metrics.proteinPct != null) lines.push(`Proteína corporal: ${metrics.proteinPct}%`);
  if (metrics.bmrKcal != null) lines.push(`Taxa metabólica basal: ${metrics.bmrKcal} kcal`);
  if (metrics.restingHeartRate != null) lines.push(`Frequência cardíaca de repouso: ${metrics.restingHeartRate} bpm`);
  if (metrics.imc != null) lines.push(`IMC: ${metrics.imc}`);

  return `Você estima "idade metabólica" de forma educativa, comparando a composição corporal de uma pessoa com médias gerais de referência para pessoas da mesma idade e sexo (não é uma medição clínica exata — cada fabricante de balança usa seu próprio algoritmo proprietário; sua estimativa é aproximada).

Idade cronológica real: ${chronologicalAge !== null ? `${chronologicalAge} anos` : "não informada"}
Sexo: ${genderLabel}

Métricas da medição atual:
${lines.join("\n") || "Nenhuma métrica numérica disponível além da idade/sexo."}

TAREFA (siga nessa ordem, não pule etapas):
1. Para CADA métrica listada acima, julgue se ela é tipicamente melhor, pior, ou média para alguém da mesma idade/sexo (ex: IMC 22 é ótimo pra qualquer idade; gordura visceral alta é pior que a média; massa muscular alta pra idade é melhor que a média).
2. Combine esses julgamentos numa única direção geral: o conjunto de métricas, no geral, sugere um corpo mais jovem, mais velho, ou na média para a idade real informada?
3. Traduza isso num número de anos de diferença — NÃO retorne 0 só porque é mais fácil; só retorne 0 se as métricas realmente indicarem uma condição física típica/mediana para a idade. Métricas visivelmente melhores que a média (ex: gordura corporal baixa, massa muscular alta, IMC ideal, TMB alta, frequência cardíaca de repouso baixa) devem gerar uma diferença NEGATIVA (corpo mais jovem que a idade real); métricas piores que a média devem gerar uma diferença POSITIVA (corpo mais velho). Quanto mais métricas apontarem na mesma direção, maior a diferença (tipicamente entre 3 e 15 anos quando há sinal claro).

Responda APENAS com JSON válido, sem markdown, sem comentários, sem texto antes ou depois, no formato exato:
{"diferenca_anos": numero inteiro (negativo, zero ou positivo), "explicacao": "1-2 frases curtas citando as métricas que mais pesaram e a direção (mais jovem/mais velho/na média) que elas indicam"}

Regras:
- "diferenca_anos" é SEMPRE relativo à idade real informada (ex: -6 significa "6 anos mais jovem que a idade real"; +4 significa "4 anos mais velho").
- Se faltarem dados demais para uma estimativa minimamente confiável, retorne diferenca_anos: 0 e deixe isso claro na explicação (não invente com base em nada).
- Nunca diagnostique doenças. Seja direto, sem markdown. Responda em português.`;
}

export function buildExamInfoPrompt(examName, latest, historyText) {
  const statusLabel =
    latest.status === "F" ? "fora da faixa de referência" : latest.status === "A" ? "em atenção/borderline" : "dentro da faixa ideal";
  return `Você é um assistente que explica exames laboratoriais de forma simples para leigos (não substitui um médico e NÃO faz diagnóstico).

Exame: ${examName}
Valor atual: ${latest.value} ${latest.unit || ""}
Faixa de referência: ${latest.ref || "não informada"}
Status atual: ${statusLabel}
Categoria: ${latest.category || "não informada"}

Histórico de medições anteriores deste exame (da mais antiga para a mais recente):
${historyText || "Sem histórico anterior — este é o único resultado registrado até agora."}

Responda APENAS com JSON válido, sem markdown, sem comentários, sem texto antes ou depois, no formato exato:
{"significado":"1-3 frases explicando o que esse exame mede e para que serve, em linguagem simples e acessível","situacao_atual":"1-2 frases explicando o que o valor atual representa, se está dentro do esperado e, se houver histórico, se está melhorando, piorando ou estável","acoes":["ação prática 1","ação prática 2","..."]}

Regras:
- "acoes": se o status atual estiver "dentro da faixa ideal", retorne um array vazio [] — não invente ações desnecessárias para algo que já está bem.
- Se o status for "atenção" ou "fora da faixa", gere de 2 a 5 ações práticas e específicas de estilo de vida (alimentação, sono, exercício, hidratação, acompanhamento médico) que ajudem a normalizar ESSE exame em especial — não dicas genéricas de saúde.
- NUNCA cite nomes de medicamentos, doses, suplementos específicos ou diagnostique uma doença/condição.
- Seja direto e conciso, sem markdown.
- Responda em português.`;
}

// Explica uma métrica de composição corporal (peso/IMC/gordura/etc) que já foi classificada
// como "atenção" ou "fora do ideal" no front-end (ver bodyMetricStatus em App.jsx) — o usuário
// só chama isso clicando no botão de IA de um card que já está fora da faixa ideal.
export function buildBodyMetricInfoPrompt(metricLabel, value, unit, statusLabel, context) {
  const lines = [];
  if (context.age != null) lines.push(`Idade: ${context.age} anos`);
  if (context.gender) lines.push(`Sexo: ${context.gender === "F" ? "feminino" : "masculino"}`);
  if (context.heightCm != null) lines.push(`Altura: ${context.heightCm} cm`);
  if (context.weightKg != null) lines.push(`Peso: ${context.weightKg} kg`);
  if (context.imc != null) lines.push(`IMC: ${context.imc}`);

  return `Você é um assistente de bem-estar (não substitui um médico e NÃO faz diagnóstico) explicando pra uma pessoa leiga uma métrica de composição corporal que está fora da faixa considerada ideal.

Métrica: ${metricLabel}
Valor atual: ${value} ${unit || ""}
Status atual: ${statusLabel}

Contexto da pessoa:
${lines.join("\n") || "Sem dados adicionais de contexto."}

Responda APENAS com JSON válido, sem markdown, sem comentários, sem texto antes ou depois, no formato exato:
{"valor_ideal":"1 frase curta dizendo qual seria a faixa ou valor considerado adequado para essa métrica, nessa pessoa","situacao_atual":"1-2 frases explicando a diferença entre o valor atual e o ideal, em termos simples","acoes":["ação prática 1","ação prática 2","..."]}

Regras:
- Gere de 2 a 5 ações práticas e específicas de estilo de vida (alimentação, sono, exercício, hidratação, acompanhamento médico) que ajudem a aproximar esse valor do adequado.
- NUNCA cite nomes de medicamentos, doses, suplementos específicos, nem diagnostique uma doença/condição.
- Seja direto e conciso, sem markdown. Responda em português.`;
}
