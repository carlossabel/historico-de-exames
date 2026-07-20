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
{"d":"YYYY-MM-DD","l":"nome do laboratorio ou null","e":[{"n":"nome do exame","v":"valor","u":"unidade ou vazio","r":"faixa de referencia como texto","s":"N|A|F","c":"categoria curta"}]}

Regras:
- "d" e a data de coleta ou emissao do laudo (formato YYYY-MM-DD). Se nao encontrar, use null.
- "s" (status): "N" se o valor esta dentro da faixa ideal/referencia, "A" se esta no limite/borderline (proximo do limite, ou o laudo already sinaliza atencao), "F" se esta fora da faixa de referencia (alto ou baixo).
- Inclua TODOS os exames encontrados no laudo, mas seja extremamente conciso: nomes curtos, sem repetir unidades no texto de referencia.
- "c" categoria curta (ex: Hematologia, Bioquimica, Hormonios, Lipidograma, Vitaminas, Urina, Outro).
- Nao invente valores. Se um campo nao existir, use string vazia.
- Responda em portugues.`;

export function buildAlertsPrompt(examHistoryText, bodyHistoryText, symptomsText) {
  return `Você é um assistente clínico de apoio (não substitui um médico e NÃO faz diagnóstico) analisando três fontes de dados de uma pessoa, em conjunto, para decidir se faz sentido sugerir que ela peça exames complementares novos.

1) Histórico de exames laboratoriais (cada bloco é um laudo, do mais antigo para o mais recente):
${examHistoryText || "Nenhum exame laboratorial registrado ainda."}

2) Histórico de composição corporal (peso, IMC, % de gordura, massa muscular etc., do mais antigo para o mais recente):
${bodyHistoryText || "Nenhuma medição de composição corporal registrada ainda."}

3) Sintomas relatados pela pessoa (podem estar ativos ou já resolvidos):
${symptomsText || "Nenhum sintoma relatado."}

Seu trabalho é CRUZAR essas três fontes — por exemplo: um sintoma relatado (ex.: cansaço, queda de cabelo, palpitação) combinado com um exame em atenção/fora do ideal ou uma tendência de piora na composição corporal é um motivo bem mais forte para sugerir um exame do que qualquer uma das três fontes isolada. Use essa combinação para tornar as sugestões mais direcionadas e precisas, mas o resultado continua sendo uma SUGESTÃO DE EXAME, nunca um diagnóstico de doença.

Seu critério deve ser rigoroso e conservador:
- SÓ sugira um exame novo/complementar se houver um motivo concreto: um resultado fora da faixa (F) que pede confirmação, uma tendência de piora ao longo do tempo (exames ou composição corporal), um sintoma que persiste/agrava e que faz sentido investigar junto com os dados disponíveis, ou uma combinação relevante entre sintoma(s) e os dados numéricos.
- NÃO sugira exames "de rotina" genéricos, exames já feitos recentemente sem motivo de repetir, nem sugestões vagas tipo "faça check-up completo". Sintomas isolados sem nenhum apoio nos dados numéricos e sem persistência também não bastam sozinhos, a menos que sejam claramente compatíveis com uma investigação específica.
- Se os dados não justificarem nenhum exame novo agora, retorne temSugestoes:false — isso é o resultado esperado na maioria das vezes, não force sugestões para parecer útil.
- Cada sugestão precisa citar o dado concreto que a motiva (exame, valor, data, medição corporal ou sintoma), mas em UMA frase curta (até ~25 palavras) — sem repetir o histórico inteiro.
- Nunca diagnostique doenças, nunca nomeie uma condição médica como conclusão, nunca cite nomes de medicamentos. Nunca use tom alarmista.
- No máximo 4 sugestões. Seja extremamente conciso: essa resposta tem um limite curto de tamanho.

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois, no formato exato (resumo com no máximo 2 frases curtas, motivo com no máximo 1 frase curta):
{"temSugestoes": true|false, "resumo": "1-2 frases curtas explicando a conclusão geral, mencionando se sintomas influenciaram", "sugestoes": [{"exame": "nome do exame sugerido", "motivo": "1 frase curta baseada em dado(s) concreto(s) — pode combinar exame/corpo/sintoma", "urgencia": "baixa|media|alta"}]}

Responda em português.`;
}
