// Integração com o WhatsApp Cloud API (Meta) — um único número compartilhado por todos os
// perfis. Fluxo de conversa por telefone: saudação -> pede nome -> pede senha de 4 dígitos
// cadastrada no perfil -> autenticado, aceita PDFs/fotos de exames e notas fiscais/recibos.
// Cada arquivo recebido vira uma linha em whatsapp_uploads, pendente de revisão no app —
// nada é salvo direto no histórico sem o usuário conferir (mesma tela de revisão do upload manual).
import crypto from "crypto";
import path from "path";
import fs from "fs";
import db, { whatsappDir } from "./db.js";
import { callClaude, parseExamJson, EXTRACTION_PROMPT, INVOICE_EXTRACTION_PROMPT, CLASSIFY_DOCUMENT_PROMPT } from "./anthropic.js";

const GRAPH_VERSION = "v19.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// Confere a assinatura que a Meta manda em todo webhook (header X-Hub-Signature-256), pra
// garantir que a chamada realmente veio da Meta e não de alguém tentando forjar mensagens
// nessa URL pública. Só valida se WHATSAPP_APP_SECRET estiver configurado.
function isValidSignature(req) {
  if (!APP_SECRET) return true; // sem app secret configurado, não dá pra validar (avisa nos logs)
  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1h de inatividade autenticada -> pede login de novo
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000; // bloqueio temporário após muitas senhas erradas

export function normalizePhone(v) {
  return (v || "").replace(/\D/g, "");
}

// Compara dois números de telefone ignorando diferenças de código de país (ex: com/sem "55")
// e formatação. Considera igual se os últimos 8-11 dígitos batem.
export function phonesMatch(a, b) {
  const da = normalizePhone(a);
  const dbb = normalizePhone(b);
  if (!da || !dbb) return false;
  const len = Math.min(da.length, dbb.length, 11);
  if (len < 8) return false;
  return da.slice(-len) === dbb.slice(-len);
}

function greetingWord() {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).format(new Date()),
    10
  );
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

async function sendText(to, body) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.error("WhatsApp não configurado: defina WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN nas variáveis de ambiente.");
    return;
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    if (!resp.ok) {
      console.error("Erro ao enviar mensagem WhatsApp:", resp.status, await resp.text());
    }
  } catch (e) {
    console.error("Erro ao enviar mensagem WhatsApp:", e.message);
  }
}

async function downloadMedia(mediaId) {
  const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const meta = await metaResp.json();
  if (!meta.url) throw new Error("Não consegui localizar o arquivo enviado.");
  const fileResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  const arrayBuffer = await fileResp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type || "application/octet-stream" };
}

function getSession(phone) {
  const now = Date.now();
  let session = db.prepare("SELECT * FROM whatsapp_sessions WHERE phone = ?").get(phone);
  const expired = session && session.state === "authenticated" && now - session.updated_at > SESSION_TIMEOUT_MS;
  if (!session || expired) {
    db.prepare(
      `INSERT INTO whatsapp_sessions (phone, state, updated_at) VALUES (?, 'greeting', ?)
       ON CONFLICT(phone) DO UPDATE SET state='greeting', candidate_name=NULL, profile_id=NULL,
         failed_pin_attempts=0, locked_until=NULL, updated_at=excluded.updated_at`
    ).run(phone, now);
    session = db.prepare("SELECT * FROM whatsapp_sessions WHERE phone = ?").get(phone);
  }
  return session;
}

function updateSession(phone, fields) {
  const cur = db.prepare("SELECT * FROM whatsapp_sessions WHERE phone = ?").get(phone) || {};
  const merged = { ...cur, ...fields, updated_at: Date.now() };
  db.prepare(
    "UPDATE whatsapp_sessions SET state=?, candidate_name=?, profile_id=?, failed_pin_attempts=?, locked_until=? , updated_at=? WHERE phone=?"
  ).run(
    merged.state,
    merged.candidate_name || null,
    merged.profile_id || null,
    merged.failed_pin_attempts || 0,
    merged.locked_until || null,
    merged.updated_at,
    phone
  );
}

function findProfilesByPhone(fromRaw) {
  return db
    .prepare("SELECT id, name, pin FROM profiles WHERE whatsapp IS NOT NULL AND whatsapp != ''")
    .all()
    .filter((p) => phonesMatch(p.whatsapp, fromRaw));
}

// ---------- Rotas ----------

export function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

export async function handleWebhook(req, res) {
  if (!isValidSignature(req)) {
    console.error("Webhook do WhatsApp com assinatura inválida — ignorando.");
    return res.sendStatus(403);
  }
  // Responde 200 já de cara: a Meta reenvia o webhook se não receber 2xx rápido.
  res.sendStatus(200);
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // pode ser um evento de status (entregue/lido) — ignora

    const fromRaw = message.from;
    const phone = normalizePhone(fromRaw);
    const session = getSession(phone);

    if (session.locked_until && Date.now() < session.locked_until) {
      const mins = Math.ceil((session.locked_until - Date.now()) / 60000);
      await sendText(fromRaw, `Muitas tentativas de senha erradas. Tenta de novo em ${mins} minuto(s).`);
      return;
    }

    const textBody = (message.text?.body || message.button?.text || "").trim();

    // ---- saudação inicial ----
    if (session.state === "greeting") {
      await sendText(fromRaw, `${greetingWord()}! 👋 Aqui é o assistente do seu histórico de exames e notas fiscais. Qual é o seu nome?`);
      updateSession(phone, { state: "awaiting_name" });
      return;
    }

    // ---- aguardando nome ----
    if (session.state === "awaiting_name") {
      const name = textBody.slice(0, 80) || "";
      const matches = findProfilesByPhone(fromRaw);
      if (!matches.length) {
        await sendText(
          fromRaw,
          `Não encontrei nenhum perfil com esse número de WhatsApp cadastrado. Abra o app, edite o perfil da pessoa e adicione esse número no campo "WhatsApp" — depois manda uma mensagem de novo.`
        );
        return;
      }
      await sendText(fromRaw, `Prazer, ${name || "tudo bem"}! Agora me manda a senha de 4 dígitos cadastrada no perfil.`);
      updateSession(phone, { state: "awaiting_pin", candidate_name: name });
      return;
    }

    // ---- aguardando senha ----
    if (session.state === "awaiting_pin") {
      const pinInput = textBody.replace(/\D/g, "");
      const matches = findProfilesByPhone(fromRaw);
      const matched = matches.find((p) => p.pin && pinInput.length === 4 && p.pin === pinInput);
      if (!matched) {
        const attempts = (session.failed_pin_attempts || 0) + 1;
        if (attempts >= MAX_PIN_ATTEMPTS) {
          updateSession(phone, { state: "awaiting_pin", failed_pin_attempts: 0, locked_until: Date.now() + LOCK_MS });
          await sendText(fromRaw, "Muitas tentativas erradas — vou bloquear por 15 minutos por segurança.");
        } else {
          updateSession(phone, { state: "awaiting_pin", failed_pin_attempts: attempts });
          await sendText(fromRaw, "Senha incorreta. Confere no app (editar perfil) e manda os 4 dígitos de novo.");
        }
        return;
      }
      updateSession(phone, { state: "authenticated", profile_id: matched.id, failed_pin_attempts: 0, locked_until: null });
      await sendText(fromRaw, "Perfeito! ✅ Agora manda o PDF ou foto do exame, nota fiscal ou recibo — um de cada vez. Aviso quando processar.");
      return;
    }

    // ---- autenticado: aceita arquivos ----
    if (session.state === "authenticated") {
      const media = message.image || message.document;
      if (!media) {
        await sendText(fromRaw, "Pode mandar o PDF ou foto do exame, nota fiscal ou recibo que eu processo.");
        return;
      }
      const profile = db.prepare("SELECT id, name FROM profiles WHERE id = ?").get(session.profile_id);
      if (!profile) {
        await sendText(fromRaw, 'Não encontrei mais esse perfil no app. Manda "oi" pra começar de novo.');
        updateSession(phone, { state: "greeting", profile_id: null });
        return;
      }

      await sendText(fromRaw, "Recebi! Processando...");
      try {
        const { buffer, mimeType } = await downloadMedia(media.id);
        const isPdf = mimeType.includes("pdf");
        const isImage = mimeType.startsWith("image/");
        if (!isPdf && !isImage) {
          await sendText(fromRaw, "Só consigo ler PDF ou foto (imagem). Manda nesse formato.");
          return;
        }
        const base64 = buffer.toString("base64");
        const blockType = isPdf ? "document" : "image";

        const classifyText = await callClaude(
          [
            {
              role: "user",
              content: [
                { type: blockType, source: { type: "base64", media_type: mimeType, data: base64 } },
                { type: "text", text: CLASSIFY_DOCUMENT_PROMPT },
              ],
            },
          ],
          50
        );
        const tipo = parseExamJson(classifyText)?.tipo;

        if (tipo !== "exame" && tipo !== "nota_fiscal") {
          await sendText(fromRaw, "Não consegui identificar isso como exame ou nota fiscal/recibo. Manda um PDF ou foto mais nítida.");
          return;
        }

        const prompt = tipo === "exame" ? EXTRACTION_PROMPT : INVOICE_EXTRACTION_PROMPT;
        const text = await callClaude(
          [
            {
              role: "user",
              content: [
                { type: blockType, source: { type: "base64", media_type: mimeType, data: base64 } },
                { type: "text", text: prompt },
              ],
            },
          ],
          8000
        );
        const parsed = parseExamJson(text);

        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        const uploadId = crypto.randomBytes(8).toString("hex");
        const ext = isPdf ? "pdf" : "jpg";
        fs.writeFileSync(path.join(whatsappDir, `${uploadId}.${ext}`), buffer);

        db.prepare(
          `INSERT INTO whatsapp_uploads (id, profile_id, kind, extracted_json, file_hash, pdf_filename, has_pdf, from_phone, received_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(uploadId, profile.id, tipo, JSON.stringify({ ...parsed, _ext: ext }), hash, media.filename || `whatsapp.${ext}`, 1, fromRaw, Date.now());

        await sendText(
          fromRaw,
          tipo === "exame"
            ? "✅ Exame recebido! Abra o app pra revisar e confirmar antes de salvar no histórico."
            : "✅ Nota fiscal/recibo recebido! Abra o app pra revisar e confirmar antes de salvar."
        );
      } catch (e) {
        console.error("Erro ao processar mídia do WhatsApp:", e);
        await sendText(fromRaw, "Não consegui processar esse arquivo agora. Tenta de novo em alguns instantes.");
      }
      return;
    }
  } catch (e) {
    console.error("Erro no webhook do WhatsApp:", e);
  }
}
