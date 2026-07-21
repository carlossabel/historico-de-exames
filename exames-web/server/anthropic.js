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

export function parseExamJson(text) {
  const t = extractJsonBlock(text);
  try {
    return JSON.parse(t);
  } catch (e) {
    const lastComplete = t.lastIndexOf("},");
    if (lastComplete === -1) throw e;
    let repaired = t.slice(0, lastComplete + 1);
    const openArr = (repaired.match(/\[/g) || []).length;
    const closeArr = (repaired.match(/\]/g) || []).length;
    const openObj = (repaired.match(/\{/g) || []).length;
    const closeObj = (repaired.match(/\}/g) || []).length;
    repaired += "]".repeat(Math.max(0, openArr - closeArr));
    repaired += "}".repeat(Math.max(0, openObj - closeObj));
    return JSON.parse(repaired);
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
{"date":"YYYY-MM-DD ou null","weightKg":numero ou null,"heightCm":numero ou null,"bodyFatPct":numero ou null,"muscleMassKg":numero ou null,"visceralFat":numero ou null,"boneMassKg":numero ou null,"bodyWaterPct":numero ou null,"bmrKcal":numero ou null,"systolicBp":numero ou null,"diastolicBp":numero ou null,"restingHeartRate":numero ou null}

Regras:
- Só preencha um campo se o valor estiver claramente legível na imagem. Se não aparecer ou estiver ilegível, use null — NUNCA invente ou estime um valor.
- "date": use a data mostrada na tela do app, se houver. Se não houver nenhuma data visível, use null (não assuma a data de hoje).
- "systolicBp" e "diastolicBp" são a pressão arterial sistólica e diastólica em mmHg (ex: em "120/80 mmHg", sistólica=120, diastólica=80).
- "restingHeartRate" é a frequência cardíaca em bpm (batimentos por minuto).
- Números sempre em kg, cm, %, kcal, mmHg ou bpm conforme o campo (converta se a imagem mostrar outra unidade, ex: libras para kg).
- Se a imagem não for de nenhum desses aparelhos/apps, ou nenhum valor estiver legível, retorne todos os campos como null.`;

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
