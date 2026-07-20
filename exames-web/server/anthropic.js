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
  if (data.error) throw new Error(data.error.message || "Erro na API da Anthropic");
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text) throw new Error("Resposta vazia da IA");
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
