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

export function buildAlertsPrompt(historyText) {
  return `Você é um assistente clínico de apoio (não substitui um médico) analisando o HISTÓRICO COMPLETO de exames laboratoriais de uma pessoa, em ordem cronológica, para decidir se faz sentido sugerir a ela que peça exames complementares novos.

Histórico (cada bloco é um laudo, do mais antigo para o mais recente):
${historyText}

Seu critério deve ser rigoroso e conservador:
- SÓ sugira um exame novo/complementar se houver um motivo concreto nos dados: um resultado fora da faixa (F) que normalmente pede confirmação ou investigação complementar, uma tendência de piora ao longo do tempo (mesmo dentro da faixa), um valor em atenção (A) que persiste ou piora em mais de uma coleta, ou uma combinação de resultados que sugere investigar algo específico.
- NÃO sugira exames "de rotina" genéricos, exames que já aparecem recentemente no histórico sem motivo de repetir, ou sugestões vagas tipo "faça check-up completo".
- Se os dados não justificarem nenhum exame novo agora, retorne temSugestoes:false — isso é o resultado esperado na maioria das vezes, não force sugestões para parecer útil.
- Cada sugestão precisa citar o dado concreto do histórico que a motiva (nome do exame já feito, valores, datas).
- Nunca diagnostique doenças nem cite nomes de medicamentos. Nunca use tom alarmista.
- No máximo 5 sugestões.

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois, no formato exato:
{"temSugestoes": true|false, "resumo": "1-2 frases explicando a conclusão geral", "sugestoes": [{"exame": "nome do exame sugerido", "motivo": "explicação curta baseada nos dados concretos do histórico", "urgencia": "baixa|media|alta"}]}

Responda em português.`;
}
