import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import db, { pdfDir, bodyPhotoDir, invoiceDir, whatsappDir } from "./db.js";
import { callClaude, parseExamJson, repairJson, extractJsonBlock, EXTRACTION_PROMPT, INVOICE_EXTRACTION_PROMPT, buildAlertsPrompt, buildTipsPrompt, buildExamInfoPrompt, buildBodyAgePrompt, buildBodyMetricInfoPrompt, BODY_PHOTO_EXTRACTION_PROMPT, buildExamMatchPrompt, buildExamGroupingPrompt, parseRefBounds, computeStatusFromRef } from "./anthropic.js";
import { verifyWebhook, handleWebhook, normalizePhone } from "./whatsapp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // necessário pra montar a URL de callback do Strava corretamente atrás do proxy do Railway
app.use(cors());
app.use(express.json({ limit: "60mb", verify: (req, res, buf) => { req.rawBody = buf; } }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

// ---------- Catálogo de exames padrão ----------
// Unifica nomes de exames diferentes entre laboratórios (ex: "Hemoglobina" vs "Hb") e
// garante uma única referência/unidade por exame, independente de qual laudo trouxe o
// resultado.
function normalizeExamName(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function listCatalog() {
  return db.prepare("SELECT id, name, unit, ref, category FROM exam_catalog ORDER BY name ASC").all();
}

function findAlias(rawName) {
  const row = db.prepare("SELECT catalog_id FROM exam_aliases WHERE raw_name = ?").get(normalizeExamName(rawName));
  return row ? row.catalog_id : null;
}

function saveAlias(rawName, catalogId) {
  const norm = normalizeExamName(rawName);
  if (!norm) return;
  const existing = db.prepare("SELECT id FROM exam_aliases WHERE raw_name = ?").get(norm);
  if (existing) {
    db.prepare("UPDATE exam_aliases SET catalog_id = ? WHERE raw_name = ?").run(catalogId, norm);
  } else {
    db.prepare("INSERT INTO exam_aliases (id, raw_name, catalog_id, created_at) VALUES (?,?,?,?)").run(uid(), norm, catalogId, Date.now());
  }
}

// Para cada nome de exame extraído de um laudo, tenta achar automaticamente um exame
// já cadastrado no catálogo: primeiro por apelido exato conhecido (grátis, sem IA); o
// que sobrar vai numa única chamada de IA junto com a lista do catálogo. Retorna os
// mesmos itens recebidos, acrescidos de catalogId/catalogName/catalogUnit/catalogRef
// (quando achou) e matchStatus: "alias" | "ai" | "new".
// Reservada para quando a padronização automática na importação for ativada de novo —
// hoje não é chamada em nenhum lugar: a decisão de nome/referência padrão só acontece
// manualmente na tela de reconciliação (ver rotas /api/exam-catalog/* mais abaixo).
async function matchExamsToCatalog(examItems) {
  const catalog = listCatalog();
  const byId = Object.fromEntries(catalog.map((c) => [c.id, c]));
  const results = examItems.map((item) => ({ ...item }));

  const pending = [];
  results.forEach((item, idx) => {
    const aliasId = findAlias(item.n || item.name);
    if (aliasId && byId[aliasId]) {
      Object.assign(item, {
        catalogId: aliasId, catalogName: byId[aliasId].name, catalogUnit: byId[aliasId].unit,
        catalogRef: byId[aliasId].ref, matchStatus: "alias",
      });
    } else {
      pending.push(idx);
    }
  });

  if (pending.length > 0) {
    try {
      const rawNames = pending.map((idx) => results[idx].n || results[idx].name || "");
      const prompt = buildExamMatchPrompt(catalog, rawNames);
      const text = await callClaude([{ role: "user", content: prompt }], 2000);
      const parsed = parseExamJson(text);
      const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
      matches.forEach((m) => {
        const idx = pending[m.i];
        if (idx === undefined) return;
        const item = results[idx];
        if (m.id && byId[m.id]) {
          Object.assign(item, {
            catalogId: byId[m.id].id, catalogName: byId[m.id].name, catalogUnit: byId[m.id].unit,
            catalogRef: byId[m.id].ref, matchStatus: "ai",
          });
        } else {
          Object.assign(item, {
            catalogId: null, catalogName: m.nomePadrao || item.n || item.name || "",
            catalogUnit: item.u || item.unit || "", catalogRef: item.r || item.ref || "", matchStatus: "new",
          });
        }
      });
    } catch (e) {
      console.error("Falha ao casar exames com o catálogo (seguindo sem sugestão):", e.message);
      pending.forEach((idx) => {
        const item = results[idx];
        Object.assign(item, {
          catalogId: null, catalogName: item.n || item.name || "",
          catalogUnit: item.u || item.unit || "", catalogRef: item.r || item.ref || "", matchStatus: "new",
        });
      });
    }
  }

  return results;
}

// Resolve o exame final (nome/unidade/referência padronizados) de um resultado que já
// passou pela tela de revisão, criando uma nova entrada no catálogo se for a primeira
// vez que esse exame aparece, e sempre gravando o apelido pra reconhecer esse laudo
// automaticamente da próxima vez.
function resolveCatalogForResult(r) {
  let catalogRow = null;
  if (r.catalogId) {
    catalogRow = db.prepare("SELECT id, name, unit, ref, category FROM exam_catalog WHERE id = ?").get(r.catalogId);
  }
  if (!catalogRow && r.catalogName && r.catalogName.trim()) {
    // Nova entrada de catálogo (usuário confirmou um exame ainda não cadastrado).
    const id = uid();
    const now = Date.now();
    db.prepare("INSERT INTO exam_catalog (id, name, unit, ref, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      id, r.catalogName.trim(), r.catalogUnit || r.unit || "", r.catalogRef || r.ref || "", r.category || "Outro", now, now
    );
    catalogRow = { id, name: r.catalogName.trim(), unit: r.catalogUnit || r.unit || "", ref: r.catalogRef || r.ref || "", category: r.category || "Outro" };
  }
  if (catalogRow) {
    saveAlias(r.name, catalogRow.id);
    const bounds = parseRefBounds(catalogRow.ref);
    const status = computeStatusFromRef(r.value, bounds, r.status);
    return {
      name: catalogRow.name, unit: catalogRow.unit || r.unit || "", ref: catalogRow.ref || r.ref || "",
      status, catalogId: catalogRow.id, rawName: r.name || "", rawRef: r.ref || "",
    };
  }
  // Sem padronização (usuário optou por não padronizar essa linha): mantém como veio.
  return { name: r.name || "", unit: r.unit || "", ref: r.ref || "", status: r.status || "N", catalogId: null, rawName: r.name || "", rawRef: r.ref || "" };
}

// ---------- Profiles ----------
function parseHereditary(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

app.get("/api/profiles", (req, res) => {
  const rows = db
    .prepare("SELECT id, name, color_idx as colorIdx, birth_date as birthDate, gender, height_cm as heightCm, whatsapp, hereditary_conditions as hereditaryConditions, pin, created_at as createdAt FROM profiles ORDER BY created_at ASC")
    .all()
    .map((r) => {
      const { pin, ...rest } = r;
      return { ...rest, hereditaryConditions: parseHereditary(r.hereditaryConditions), hasPin: !!pin };
    });
  res.json(rows);
});

function validatePin(pin) {
  if (pin === undefined) return { ok: true, skip: true };
  if (pin === null || pin === "") return { ok: true, value: null };
  if (!/^\d{4}$/.test(String(pin))) return { ok: false };
  return { ok: true, value: String(pin) };
}

app.post("/api/profiles", (req, res) => {
  const { name, birthDate, gender, heightCm, whatsapp, hereditaryConditions, pin } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome obrigatório" });
  const pinCheck = validatePin(pin);
  if (!pinCheck.ok) return res.status(400).json({ error: "A senha precisa ter exatamente 4 números." });
  const count = db.prepare("SELECT COUNT(*) as c FROM profiles").get().c;
  const id = uid();
  const colorIdx = count % 8;
  const createdAt = Date.now();
  const hereditaryJson = JSON.stringify(Array.isArray(hereditaryConditions) ? hereditaryConditions : []);
  const whatsappNormalized = whatsapp ? normalizePhone(whatsapp) : null;
  const pinValue = pinCheck.skip ? null : pinCheck.value;
  db.prepare("INSERT INTO profiles (id, name, color_idx, birth_date, gender, height_cm, whatsapp, hereditary_conditions, pin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, name.trim(), colorIdx, birthDate || null, gender || null, numOrNull(heightCm), whatsappNormalized, hereditaryJson, pinValue, createdAt
  );
  res.json({
    id, name: name.trim(), colorIdx, birthDate: birthDate || null, gender: gender || null, heightCm: numOrNull(heightCm),
    whatsapp: whatsappNormalized, hereditaryConditions: Array.isArray(hereditaryConditions) ? hereditaryConditions : [],
    hasPin: !!pinValue, createdAt,
  });
});

app.put("/api/profiles/:id", (req, res) => {
  const { id } = req.params;
  const existing = db.prepare("SELECT id, pin FROM profiles WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Perfil não encontrado" });
  const { name, birthDate, gender, heightCm, whatsapp, hereditaryConditions, pin } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome obrigatório" });
  const pinCheck = validatePin(pin);
  if (!pinCheck.ok) return res.status(400).json({ error: "A senha precisa ter exatamente 4 números." });
  const hereditaryJson = JSON.stringify(Array.isArray(hereditaryConditions) ? hereditaryConditions : []);
  const whatsappNormalized = whatsapp ? normalizePhone(whatsapp) : null;
  const pinValue = pinCheck.skip ? existing.pin : pinCheck.value;
  db.prepare("UPDATE profiles SET name = ?, birth_date = ?, gender = ?, height_cm = ?, whatsapp = ?, hereditary_conditions = ?, pin = ? WHERE id = ?").run(
    name.trim(), birthDate || null, gender || null, numOrNull(heightCm), whatsappNormalized, hereditaryJson, pinValue, id
  );
  const row = db.prepare("SELECT id, name, color_idx as colorIdx, birth_date as birthDate, gender, height_cm as heightCm, whatsapp, hereditary_conditions as hereditaryConditions, pin, created_at as createdAt FROM profiles WHERE id = ?").get(id);
  const { pin: _pin, ...rest } = row;
  res.json({ ...rest, hereditaryConditions: parseHereditary(row.hereditaryConditions), hasPin: !!_pin });
});

app.delete("/api/profiles/:id", (req, res) => {
  const { id } = req.params;
  const batches = db.prepare("SELECT id FROM batches WHERE profile_id = ?").all(id);
  for (const b of batches) {
    const pdfPath = path.join(pdfDir, `${b.id}.pdf`);
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    db.prepare("DELETE FROM results WHERE batch_id = ?").run(b.id);
  }
  db.prepare("DELETE FROM batches WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM alerts WHERE profile_id = ?").run(id);
  const bodyEntryRows = db.prepare("SELECT id FROM body_entries WHERE profile_id = ?").all(id);
  for (const e of bodyEntryRows) {
    const photoPath = path.join(bodyPhotoDir, e.id);
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
  db.prepare("DELETE FROM body_entries WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM symptoms WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM tips_history WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM activities WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM strava_tokens WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM activity_webhooks WHERE profile_id = ?").run(id);
  const invoiceRows = db.prepare("SELECT id FROM invoices WHERE profile_id = ?").all(id);
  for (const inv of invoiceRows) {
    const invoicePath = path.join(invoiceDir, `${inv.id}.pdf`);
    if (fs.existsSync(invoicePath)) fs.unlinkSync(invoicePath);
  }
  db.prepare("DELETE FROM invoices WHERE profile_id = ?").run(id);
  const waUploadRows = db.prepare("SELECT id, extracted_json FROM whatsapp_uploads WHERE profile_id = ?").all(id);
  for (const u of waUploadRows) {
    let ext = "pdf";
    try { ext = JSON.parse(u.extracted_json)?._ext || "pdf"; } catch (e) {}
    const filePath = path.join(whatsappDir, `${u.id}.${ext}`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare("DELETE FROM whatsapp_uploads WHERE profile_id = ?").run(id);
  db.prepare("UPDATE whatsapp_sessions SET profile_id = NULL WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------- Batches ----------
app.get("/api/profiles/:profileId/batches", (req, res) => {
  const { profileId } = req.params;
  const rows = db
    .prepare(
      `SELECT id as batchId, date, lab, doctor, file_hash as hash, has_pdf as hasPdf, pdf_filename as fileName, saved_at as savedAt,
              (SELECT COUNT(*) FROM results WHERE results.batch_id = batches.id) as count
       FROM batches WHERE profile_id = ? ORDER BY date DESC`
    )
    .all(profileId);
  res.json(rows);
});

app.get("/api/profiles/:profileId/batches/:batchId", (req, res) => {
  const { batchId } = req.params;
  const batch = db.prepare("SELECT id, date, lab, doctor FROM batches WHERE id = ?").get(batchId);
  if (!batch) return res.status(404).json({ error: "Não encontrado" });
  const results = db
    .prepare("SELECT id, name, value, unit, ref, status, category, catalog_id as catalogId, raw_name as rawName FROM results WHERE batch_id = ?")
    .all(batchId);
  res.json({ ...batch, results });
});

app.get("/api/profiles/:profileId/batches/:batchId/pdf", (req, res) => {
  const { batchId } = req.params;
  const batch = db.prepare("SELECT pdf_filename as fileName FROM batches WHERE id = ?").get(batchId);
  const pdfPath = path.join(pdfDir, `${batchId}.pdf`);
  if (!batch || !fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF não encontrado" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${(batch.fileName || "exame.pdf").replace(/"/g, "")}"`);
  fs.createReadStream(pdfPath).pipe(res);
});

app.put("/api/profiles/:profileId/batches/:batchId", (req, res) => {
  try {
    const { batchId } = req.params;
    const b = req.body || {};
    const existing = db.prepare("SELECT id FROM batches WHERE id = ?").get(batchId);
    if (!existing) return res.status(404).json({ error: "Laudo não encontrado" });
    if (!b.date) return res.status(400).json({ error: "Data é obrigatória" });
    db.prepare("UPDATE batches SET date=?, lab=?, doctor=? WHERE id=?").run(
      b.date, b.lab || "", b.doctor || "", batchId
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar laudo" });
  }
});

app.delete("/api/profiles/:profileId/batches/:batchId", (req, res) => {
  const { batchId } = req.params;
  const pdfPath = path.join(pdfDir, `${batchId}.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  db.prepare("DELETE FROM results WHERE batch_id = ?").run(batchId);
  db.prepare("DELETE FROM batches WHERE id = ?").run(batchId);
  res.json({ ok: true });
});

// ---------- Catálogo de exames padrão ----------
// Lista o catálogo com quantos resultados salvos usam cada entrada e quantos apelidos
// (redações de laboratório) já foram aprendidos para ela.
app.get("/api/exam-catalog", (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.unit, c.ref, c.category,
              (SELECT COUNT(*) FROM results r WHERE r.catalog_id = c.id) as resultCount,
              (SELECT COUNT(*) FROM exam_aliases a WHERE a.catalog_id = c.id) as aliasCount
       FROM exam_catalog c ORDER BY c.name ASC`
    )
    .all();
  res.json(rows);
});

// Nomes distintos já salvos em `results` que ainda não estão ligados a nenhuma entrada
// do catálogo — candidatos a serem unificados manualmente (útil para o histórico salvo
// antes desse recurso existir). Agrupa por nome normalizado e mostra quantas vezes cada
// grafia aparece.
app.get("/api/exam-catalog/unmatched", (req, res) => {
  const rows = db
    .prepare(
      `SELECT name, COUNT(*) as count, MIN(unit) as unit, MIN(ref) as ref
       FROM results WHERE catalog_id IS NULL AND name IS NOT NULL AND TRIM(name) != ''
       GROUP BY LOWER(TRIM(name)) ORDER BY name ASC`
    )
    .all();
  res.json(rows);
});

// Edita uma entrada do catálogo (nome, unidade, referência). Isso é propagado (cascata)
// para todos os resultados já salvos que apontam pra essa entrada, incluindo recálculo
// do status (N/A/F) se a referência mudou.
app.put("/api/exam-catalog/:id", (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare("SELECT * FROM exam_catalog WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Exame não encontrado no catálogo" });
    const name = (req.body?.name ?? existing.name).trim();
    const unit = req.body?.unit ?? existing.unit ?? "";
    const ref = req.body?.ref ?? existing.ref ?? "";
    const category = req.body?.category ?? existing.category ?? "Outro";
    if (!name) return res.status(400).json({ error: "Nome não pode ficar vazio" });
    db.prepare("UPDATE exam_catalog SET name=?, unit=?, ref=?, category=?, updated_at=? WHERE id=?").run(name, unit, ref, category, Date.now(), id);

    const bounds = parseRefBounds(ref);
    const affected = db.prepare("SELECT id, value, status FROM results WHERE catalog_id = ?").all(id);
    const updateResult = db.prepare("UPDATE results SET name=?, unit=?, ref=?, status=? WHERE id=?");
    for (const r of affected) {
      const status = computeStatusFromRef(r.value, bounds, r.status);
      updateResult.run(name, unit, ref, status, r.id);
    }
    res.json({ ok: true, affected: affected.length });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar exame do catálogo" });
  }
});

// Remove uma entrada do catálogo. Os resultados que apontavam pra ela voltam a ficar
// "sem padronização" (mantêm o nome/unidade/referência que já tinham, só perdem o vínculo).
app.delete("/api/exam-catalog/:id", (req, res) => {
  const { id } = req.params;
  db.prepare("UPDATE results SET catalog_id = NULL WHERE catalog_id = ?").run(id);
  db.prepare("DELETE FROM exam_aliases WHERE catalog_id = ?").run(id);
  db.prepare("DELETE FROM exam_catalog WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Reconciliação em lote: junta um conjunto de nomes já salvos (ex: "Hemoglobina", "Hb",
// "HGB") — que hoje aparecem como exames separados — numa única entrada do catálogo,
// criando-a se preciso, atualizando todos os resultados já salvos com esses nomes e
// registrando os apelidos correspondentes.
app.post("/api/exam-catalog/reconcile", (req, res) => {
  try {
    const { names, catalogId, newName, unit, ref, category } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) return res.status(400).json({ error: "Selecione ao menos um nome" });

    let catalogRow;
    if (catalogId) {
      catalogRow = db.prepare("SELECT * FROM exam_catalog WHERE id = ?").get(catalogId);
      if (!catalogRow) return res.status(404).json({ error: "Exame padrão não encontrado" });
      if (unit !== undefined || ref !== undefined) {
        db.prepare("UPDATE exam_catalog SET unit=?, ref=?, updated_at=? WHERE id=?").run(unit ?? catalogRow.unit, ref ?? catalogRow.ref, Date.now(), catalogId);
        catalogRow = { ...catalogRow, unit: unit ?? catalogRow.unit, ref: ref ?? catalogRow.ref };
      }
    } else {
      if (!newName || !newName.trim()) return res.status(400).json({ error: "Informe o nome padrão" });
      const id = uid();
      const now = Date.now();
      db.prepare("INSERT INTO exam_catalog (id, name, unit, ref, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
        id, newName.trim(), unit || "", ref || "", category || "Outro", now, now
      );
      catalogRow = { id, name: newName.trim(), unit: unit || "", ref: ref || "" };
    }

    const bounds = parseRefBounds(catalogRow.ref);
    let totalAffected = 0;
    for (const rawName of names) {
      const norm = normalizeExamName(rawName);
      if (!norm) continue;
      const rows = db.prepare("SELECT id, value, status FROM results WHERE LOWER(TRIM(name)) = ?").all(norm);
      for (const r of rows) {
        const status = computeStatusFromRef(r.value, bounds, r.status);
        db.prepare("UPDATE results SET name=?, unit=?, ref=?, status=?, catalog_id=? WHERE id=?").run(catalogRow.name, catalogRow.unit || "", catalogRow.ref || "", status, catalogRow.id, r.id);
      }
      totalAffected += rows.length;
      saveAlias(rawName, catalogRow.id);
    }
    res.json({ ok: true, catalogId: catalogRow.id, affected: totalAffected });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao unificar exames" });
  }
});

// Sugere agrupamentos (via IA) dos nomes ainda não padronizados, pra tela de reconciliação
// não precisar que o usuário identifique manualmente quais nomes são o mesmo exame.
app.post("/api/exam-catalog/suggest-groups", async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) return res.status(400).json({ error: "Nenhum nome para agrupar" });
    const text = await callClaude([{ role: "user", content: buildExamGroupingPrompt(names) }], 3000);
    const parsed = parseExamJson(text);
    const grupos = Array.isArray(parsed.grupos) ? parsed.grupos : [];
    const groups = grupos
      .map((g) => ({
        names: (Array.isArray(g.indices) ? g.indices : []).map((i) => names[i]).filter(Boolean),
        suggestedName: g.nomePadrao || "",
      }))
      .filter((g) => g.names.length > 0);
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao sugerir agrupamentos" });
  }
});

// ---------- Body composition (composição corporal) ----------
function rowToBodyEntry(r) {
  return {
    id: r.id,
    date: r.date,
    weightKg: r.weight_kg,
    heightCm: r.height_cm,
    bodyFatPct: r.body_fat_pct,
    muscleMassKg: r.muscle_mass_kg,
    visceralFat: r.visceral_fat,
    boneMassKg: r.bone_mass_kg,
    bodyWaterPct: r.body_water_pct,
    bmrKcal: r.bmr_kcal,
    systolicBp: r.systolic_bp,
    diastolicBp: r.diastolic_bp,
    restingHeartRate: r.resting_heart_rate,
    proteinPct: r.protein_pct,
    bodyAge: r.body_age,
    hasPhoto: !!r.has_photo,
    notes: r.notes,
    savedAt: r.saved_at,
  };
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Idade cronológica a partir da data de nascimento (anos completos).
function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const hasHadBirthdayThisYear = now.getMonth() > b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() >= b.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

// Calcula (via IA) a "idade corporal" estimada pra uma medição, usando a altura do PERFIL
// (fallback pra altura antiga gravada na própria medição, se existir, pra não perder dados de
// quem já tinha altura por medição antes dessa mudança). Não grava nada no banco sozinha —
// quem chama decide o que fazer com o resultado. Lança erro se a chamada de IA falhar de
// verdade (usado pelo endpoint de recálculo manual, que quer mostrar o motivo pro usuário);
// retorna { skippedReason } quando falta pré-requisito (idade/dado nenhum), sem precisar de IA.
async function computeBodyAge(profile, entryRow) {
  if (!profile || !profile.birth_date) {
    return { bodyAge: null, skippedReason: "Defina a data de nascimento no perfil (botão de editar perfil) para calcular a idade metabólica." };
  }
  const chronologicalAge = ageFromBirthDate(profile.birth_date);
  if (chronologicalAge === null) {
    return { bodyAge: null, skippedReason: "A data de nascimento salva no perfil é inválida." };
  }

  const heightCm = profile.height_cm ?? entryRow.height_cm ?? null;
  const imc = entryRow.weight_kg && heightCm ? Math.round((entryRow.weight_kg / ((heightCm / 100) ** 2)) * 10) / 10 : null;

  const metrics = {
    weightKg: entryRow.weight_kg, heightCm, bodyFatPct: entryRow.body_fat_pct,
    muscleMassKg: entryRow.muscle_mass_kg, visceralFat: entryRow.visceral_fat, bodyWaterPct: entryRow.body_water_pct,
    proteinPct: entryRow.protein_pct, bmrKcal: entryRow.bmr_kcal, restingHeartRate: entryRow.resting_heart_rate, imc,
  };
  if (Object.values(metrics).every((v) => v === null || v === undefined)) {
    return { bodyAge: null, skippedReason: "Essa medição não tem nenhum dado de composição corporal (peso, %gordura, músculo etc.) para basear a estimativa." };
  }

  const prompt = buildBodyAgePrompt(chronologicalAge, profile.gender, metrics);
  const text = await callClaude([{ role: "user", content: prompt }], 400);
  const parsed = repairJson(text);
  const diffYears = numOrNull(parsed.diferenca_anos);
  if (diffYears === null) {
    return { bodyAge: null, skippedReason: `A IA respondeu, mas sem um número de diferença de idade válido: ${text.slice(0, 200)}` };
  }
  const bodyAge = Math.max(0, Math.round(chronologicalAge + diffYears));
  return { bodyAge, explicacao: parsed.explicacao || null };
}

// Usado no salvamento automático (POST/PUT de medição): silenciosa de propósito, pra não
// travar o salvamento da medição por causa de um problema no cálculo de idade corporal.
async function computeAndStoreBodyAge(profileId, entryId, entryRow) {
  try {
    const profile = db.prepare("SELECT birth_date, gender, height_cm FROM profiles WHERE id = ?").get(profileId);
    const { bodyAge, skippedReason } = await computeBodyAge(profile, entryRow);
    if (skippedReason) {
      console.warn(`Idade metabólica não calculada para a medição ${entryId}: ${skippedReason}`);
      return;
    }
    db.prepare("UPDATE body_entries SET body_age = ? WHERE id = ?").run(bodyAge, entryId);
  } catch (e) {
    console.warn("Não foi possível calcular a idade metabólica para a medição", entryId, ":", e.message);
  }
}

app.get("/api/profiles/:profileId/body-entries", (req, res) => {
  const { profileId } = req.params;
  const rows = db
    .prepare("SELECT * FROM body_entries WHERE profile_id = ? ORDER BY date ASC, saved_at ASC")
    .all(profileId);
  res.json(rows.map(rowToBodyEntry));
});

app.post("/api/profiles/:profileId/body-entries", async (req, res) => {
  try {
    const { profileId } = req.params;
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "Data da medição é obrigatória" });
    const id = uid();
    let hasPhoto = 0;
    if (b.photoBase64) {
      try {
        fs.writeFileSync(path.join(bodyPhotoDir, id), Buffer.from(b.photoBase64, "base64"));
        hasPhoto = 1;
      } catch (e) {}
    }
    db.prepare(
      `INSERT INTO body_entries
        (id, profile_id, date, weight_kg, height_cm, body_fat_pct, muscle_mass_kg, visceral_fat, bone_mass_kg, body_water_pct, bmr_kcal, systolic_bp, diastolic_bp, resting_heart_rate, protein_pct, photo_mime, has_photo, notes, saved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, profileId, b.date,
      numOrNull(b.weightKg), numOrNull(b.heightCm), numOrNull(b.bodyFatPct), numOrNull(b.muscleMassKg),
      numOrNull(b.visceralFat), numOrNull(b.boneMassKg), numOrNull(b.bodyWaterPct), numOrNull(b.bmrKcal),
      numOrNull(b.systolicBp), numOrNull(b.diastolicBp), numOrNull(b.restingHeartRate), numOrNull(b.proteinPct),
      hasPhoto ? (b.photoMime || "image/jpeg") : null, hasPhoto,
      b.notes || "", Date.now()
    );
    let row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(id);
    await computeAndStoreBodyAge(profileId, id, row);
    row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(id);
    res.json(rowToBodyEntry(row));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao salvar medição" });
  }
});

app.put("/api/profiles/:profileId/body-entries/:entryId", async (req, res) => {
  try {
    const { profileId, entryId } = req.params;
    const b = req.body || {};
    const existing = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(entryId);
    if (!existing) return res.status(404).json({ error: "Medição não encontrada" });
    if (!b.date) return res.status(400).json({ error: "Data da medição é obrigatória" });

    // Edição normal (via lápis) não manda foto — preserva a que já existia, se houver.
    // Só troca a foto se vier uma nova (photoBase64) explicitamente.
    let hasPhoto = existing.has_photo;
    let photoMime = existing.photo_mime;
    if (b.photoBase64) {
      try {
        fs.writeFileSync(path.join(bodyPhotoDir, entryId), Buffer.from(b.photoBase64, "base64"));
        hasPhoto = 1;
        photoMime = b.photoMime || "image/jpeg";
      } catch (e) {}
    }

    db.prepare(
      `UPDATE body_entries SET date=?, weight_kg=?, height_cm=?, body_fat_pct=?, muscle_mass_kg=?, visceral_fat=?, bone_mass_kg=?, body_water_pct=?, bmr_kcal=?, systolic_bp=?, diastolic_bp=?, resting_heart_rate=?, protein_pct=?, photo_mime=?, has_photo=?, notes=? WHERE id=?`
    ).run(
      b.date,
      numOrNull(b.weightKg), numOrNull(b.heightCm), numOrNull(b.bodyFatPct), numOrNull(b.muscleMassKg),
      numOrNull(b.visceralFat), numOrNull(b.boneMassKg), numOrNull(b.bodyWaterPct), numOrNull(b.bmrKcal),
      numOrNull(b.systolicBp), numOrNull(b.diastolicBp), numOrNull(b.restingHeartRate), numOrNull(b.proteinPct),
      photoMime, hasPhoto,
      b.notes || "", entryId
    );
    let row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(entryId);
    await computeAndStoreBodyAge(profileId, entryId, row);
    row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(entryId);
    res.json(rowToBodyEntry(row));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar medição" });
  }
});

app.get("/api/profiles/:profileId/body-entries/:entryId/photo", (req, res) => {
  const { entryId } = req.params;
  const entry = db.prepare("SELECT photo_mime, has_photo FROM body_entries WHERE id = ?").get(entryId);
  const photoPath = path.join(bodyPhotoDir, entryId);
  if (!entry || !entry.has_photo || !fs.existsSync(photoPath)) {
    return res.status(404).json({ error: "Foto não encontrada" });
  }
  res.setHeader("Content-Type", entry.photo_mime || "image/jpeg");
  fs.createReadStream(photoPath).pipe(res);
});

app.post("/api/profiles/:profileId/body-entries/:entryId/recalc-body-age", async (req, res) => {
  try {
    const { profileId, entryId } = req.params;
    const entryRow = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(entryId);
    if (!entryRow) return res.status(404).json({ error: "Medição não encontrada" });
    const profile = db.prepare("SELECT birth_date, gender, height_cm FROM profiles WHERE id = ?").get(profileId);

    const { bodyAge, skippedReason, explicacao } = await computeBodyAge(profile, entryRow);
    if (skippedReason) {
      return res.status(400).json({ error: skippedReason });
    }
    db.prepare("UPDATE body_entries SET body_age = ? WHERE id = ?").run(bodyAge, entryId);
    const row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(entryId);
    res.json({ ...rowToBodyEntry(row), explicacao });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao calcular idade metabólica" });
  }
});

// Explicação sob demanda (botão de IA nos cards fora do ideal da aba Saúde física): não
// grava nada no banco, é gerada na hora a cada clique — o card já mostra o dado, isso só
// explica o que seria um valor adequado e o que fazer.
app.post("/api/profiles/:profileId/body-metric-info", async (req, res) => {
  try {
    const { metricLabel, value, unit, statusLabel, context } = req.body || {};
    if (!metricLabel || value === undefined || value === null) {
      return res.status(400).json({ error: "Dados da métrica incompletos" });
    }
    const prompt = buildBodyMetricInfoPrompt(metricLabel, value, unit, statusLabel || "", context || {});
    const text = await callClaude([{ role: "user", content: prompt }], 500);
    const parsed = repairJson(text);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao gerar análise" });
  }
});

app.post("/api/profiles/:profileId/body-entries/extract-photo", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhuma imagem enviada" });
    if (!req.file.mimetype || !req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Envie uma imagem (foto da balança ou do app)." });
    }
    const base64 = req.file.buffer.toString("base64");
    const text = await callClaude(
      [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: req.file.mimetype, data: base64 } },
            { type: "text", text: BODY_PHOTO_EXTRACTION_PROMPT },
          ],
        },
      ],
      500
    );
    const parsed = repairJson(text);
    res.json({ ...parsed, photoBase64: base64, photoMime: req.file.mimetype });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao ler a imagem" });
  }
});

app.delete("/api/profiles/:profileId/body-entries/:entryId", (req, res) => {
  const { entryId } = req.params;
  const photoPath = path.join(bodyPhotoDir, entryId);
  if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  db.prepare("DELETE FROM body_entries WHERE id = ?").run(entryId);
  res.json({ ok: true });
});

// ---------- Physical activities (atividades físicas) ----------
function rowToActivity(r) {
  return {
    id: r.id,
    date: r.date,
    activityType: r.activity_type,
    durationMin: r.duration_min,
    intensity: r.intensity,
    distanceKm: r.distance_km,
    caloriesKcal: r.calories_kcal,
    notes: r.notes,
    source: r.source || "manual",
    externalId: r.external_id || null,
    createdAt: r.created_at,
  };
}

app.get("/api/profiles/:profileId/activities", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM activities WHERE profile_id = ? ORDER BY date ASC, created_at ASC")
    .all(req.params.profileId);
  res.json(rows.map(rowToActivity));
});

app.post("/api/profiles/:profileId/activities", (req, res) => {
  try {
    const { profileId } = req.params;
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "Data é obrigatória" });
    if (!b.activityType || !b.activityType.trim()) return res.status(400).json({ error: "Informe o tipo de atividade" });
    const id = uid();
    db.prepare(
      `INSERT INTO activities (id, profile_id, date, activity_type, duration_min, intensity, distance_km, calories_kcal, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, profileId, b.date, b.activityType.trim(),
      numOrNull(b.durationMin), b.intensity || null, numOrNull(b.distanceKm), numOrNull(b.caloriesKcal),
      b.notes || "", Date.now()
    );
    res.json(rowToActivity(db.prepare("SELECT * FROM activities WHERE id = ?").get(id)));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao salvar atividade" });
  }
});

app.put("/api/profiles/:profileId/activities/:activityId", (req, res) => {
  try {
    const { activityId } = req.params;
    const b = req.body || {};
    const existing = db.prepare("SELECT id FROM activities WHERE id = ?").get(activityId);
    if (!existing) return res.status(404).json({ error: "Atividade não encontrada" });
    if (!b.date) return res.status(400).json({ error: "Data é obrigatória" });
    if (!b.activityType || !b.activityType.trim()) return res.status(400).json({ error: "Informe o tipo de atividade" });
    db.prepare(
      `UPDATE activities SET date=?, activity_type=?, duration_min=?, intensity=?, distance_km=?, calories_kcal=?, notes=? WHERE id=?`
    ).run(
      b.date, b.activityType.trim(), numOrNull(b.durationMin), b.intensity || null,
      numOrNull(b.distanceKm), numOrNull(b.caloriesKcal), b.notes || "", activityId
    );
    res.json(rowToActivity(db.prepare("SELECT * FROM activities WHERE id = ?").get(activityId)));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar atividade" });
  }
});

app.delete("/api/profiles/:profileId/activities/:activityId", (req, res) => {
  db.prepare("DELETE FROM activities WHERE id = ?").run(req.params.activityId);
  res.json({ ok: true });
});

// ---------- Strava (integração via OAuth2, sincronização de atividades) ----------
function getBaseUrl(req) {
  return process.env.STRAVA_REDIRECT_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

const STRAVA_TYPE_LABELS = {
  Run: "Corrida", VirtualRun: "Corrida (virtual)", TrailRun: "Corrida em trilha",
  Ride: "Pedalada", VirtualRide: "Pedalada (virtual)", MountainBikeRide: "Mountain bike",
  Swim: "Natação", Walk: "Caminhada", Hike: "Trilha", WeightTraining: "Musculação",
  Yoga: "Yoga", Workout: "Treino", Crossfit: "Crossfit", Elliptical: "Elíptico",
  StairStepper: "Escada (stepper)", RowingMachine: "Remo (máquina)", Rowing: "Remo",
};

app.get("/api/profiles/:profileId/strava/connect", (req, res) => {
  const { profileId } = req.params;
  if (!process.env.STRAVA_CLIENT_ID) {
    return res.status(500).send("STRAVA_CLIENT_ID não configurado no servidor. Peça pro administrador configurar as variáveis de ambiente do Strava.");
  }
  const redirectUri = `${getBaseUrl(req)}/api/strava/callback`;
  const url = `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(process.env.STRAVA_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&approval_prompt=auto&scope=activity:read_all&state=${encodeURIComponent(profileId)}`;
  res.redirect(url);
});

app.get("/api/strava/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const profileId = state;
  if (error || !code) {
    return res.redirect(`/?strava=error`);
  }
  try {
    const resp = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      console.error("Erro ao trocar código do Strava:", data);
      return res.redirect(`/?strava=error`);
    }
    db.prepare(
      `INSERT INTO strava_tokens (profile_id, athlete_id, access_token, refresh_token, expires_at, connected_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(profile_id) DO UPDATE SET athlete_id=excluded.athlete_id, access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, connected_at=excluded.connected_at`
    ).run(profileId, String(data.athlete?.id || ""), data.access_token, data.refresh_token, data.expires_at, Date.now());
    res.redirect(`/?connectedProfile=${encodeURIComponent(profileId)}&provider=strava`);
  } catch (e) {
    console.error("Erro no callback do Strava:", e);
    res.redirect(`/?strava=error`);
  }
});

app.get("/api/profiles/:profileId/strava/status", (req, res) => {
  const row = db.prepare("SELECT athlete_id, connected_at FROM strava_tokens WHERE profile_id = ?").get(req.params.profileId);
  res.json({ connected: !!row, athleteId: row?.athlete_id || null, connectedAt: row?.connected_at || null });
});

app.delete("/api/profiles/:profileId/strava/disconnect", (req, res) => {
  db.prepare("DELETE FROM strava_tokens WHERE profile_id = ?").run(req.params.profileId);
  res.json({ ok: true });
});

async function getValidStravaToken(profileId) {
  const row = db.prepare("SELECT * FROM strava_tokens WHERE profile_id = ?").get(profileId);
  if (!row) return null;
  if (row.expires_at && row.expires_at > Math.floor(Date.now() / 1000) + 60) {
    return row.access_token;
  }
  // token expirado ou perto de expirar — renova com o refresh_token
  const resp = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error("Não consegui renovar o acesso ao Strava. Talvez seja necessário reconectar.");
  }
  db.prepare("UPDATE strava_tokens SET access_token=?, refresh_token=?, expires_at=? WHERE profile_id=?").run(
    data.access_token, data.refresh_token, data.expires_at, profileId
  );
  return data.access_token;
}

app.post("/api/profiles/:profileId/strava/sync", async (req, res) => {
  try {
    const { profileId } = req.params;
    const token = await getValidStravaToken(profileId);
    if (!token) return res.status(400).json({ error: "Perfil não está conectado ao Strava." });

    const resp = await fetch("https://www.strava.com/api/v3/athlete/activities?per_page=50", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await resp.json();
    if (!resp.ok || !Array.isArray(list)) {
      console.error("Erro ao listar atividades do Strava:", list);
      return res.status(502).json({ error: "Não consegui buscar as atividades do Strava agora." });
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO activities (id, profile_id, date, activity_type, duration_min, intensity, distance_km, calories_kcal, notes, source, external_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    let imported = 0;
    for (const a of list) {
      const label = STRAVA_TYPE_LABELS[a.type] || STRAVA_TYPE_LABELS[a.sport_type] || a.sport_type || a.type || "Atividade";
      const durationMin = a.moving_time ? Math.round(a.moving_time / 60) : null;
      const distanceKm = a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null;
      const caloriesKcal = a.kilojoules ? Math.round(a.kilojoules * 0.239) : null;
      const date = a.start_date_local ? a.start_date_local.slice(0, 10) : null;
      const result = insert.run(
        uid(), profileId, date, label, durationMin, null, distanceKm, caloriesKcal,
        `${a.name || ""} (Strava)`.trim(), "strava", String(a.id), Date.now()
      );
      if (result.changes > 0) imported++;
    }
    res.json({ imported, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao sincronizar com o Strava" });
  }
});

// ---------- Apple Watch (webhook alimentado por um Atalho do iPhone) ----------
app.get("/api/profiles/:profileId/activity-webhook", (req, res) => {
  const { profileId } = req.params;
  let row = db.prepare("SELECT token FROM activity_webhooks WHERE profile_id = ?").get(profileId);
  if (!row) {
    const token = crypto.randomBytes(20).toString("hex");
    db.prepare("INSERT INTO activity_webhooks (profile_id, token, created_at) VALUES (?,?,?)").run(profileId, token, Date.now());
    row = { token };
  }
  res.json({ url: `${getBaseUrl(req)}/api/webhooks/activities/${row.token}` });
});

app.post("/api/profiles/:profileId/activity-webhook/reset", (req, res) => {
  const { profileId } = req.params;
  const token = crypto.randomBytes(20).toString("hex");
  db.prepare(
    `INSERT INTO activity_webhooks (profile_id, token, created_at) VALUES (?,?,?)
     ON CONFLICT(profile_id) DO UPDATE SET token=excluded.token, created_at=excluded.created_at`
  ).run(profileId, token, Date.now());
  res.json({ url: `${getBaseUrl(req)}/api/webhooks/activities/${token}` });
});

// Endpoint público (autenticado só pelo token na URL) que o Atalho do iPhone chama
app.post("/api/webhooks/activities/:token", (req, res) => {
  try {
    const { token } = req.params;
    const owner = db.prepare("SELECT profile_id FROM activity_webhooks WHERE token = ?").get(token);
    if (!owner) return res.status(404).json({ error: "Link inválido." });
    const b = req.body || {};
    const activityType = (b.activityType || b.type || "Treino").toString();
    const date = (b.date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
    const externalId = b.externalId ? String(b.externalId) : `applewatch:${date}:${activityType}:${Date.now()}`;
    db.prepare(
      `INSERT OR IGNORE INTO activities (id, profile_id, date, activity_type, duration_min, intensity, distance_km, calories_kcal, notes, source, external_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      uid(), owner.profile_id, date, activityType,
      numOrNull(b.durationMin), b.intensity || null, numOrNull(b.distanceKm), numOrNull(b.caloriesKcal),
      (b.notes || "Sincronizado do Apple Watch").toString(), "apple_watch", externalId, Date.now()
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao registrar atividade" });
  }
});

// ---------- AI extraction ----------
app.post("/api/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
    const { profileId } = req.body || {};
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    if (profileId) {
      const dup = db.prepare("SELECT date, lab FROM batches WHERE profile_id = ? AND file_hash = ?").get(profileId, hash);
      if (dup) {
        return res.status(409).json({ error: "duplicate", date: dup.date, lab: dup.lab });
      }
    }

    const base64 = req.file.buffer.toString("base64");
    const text = await callClaude(
      [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
      8000
    );
    const parsed = parseExamJson(text);
    // Nota: a padronização (nome/referência únicos) não é sugerida automaticamente aqui —
    // por enquanto isso fica só na tela de reconciliação (dentro do perfil), pra decidir
    // manualmente e ganhar confiança antes de automatizar.
    res.json({ ...parsed, hash, base64, fileName: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao processar PDF" });
  }
});

// ---------- Save batch ----------
app.post("/api/profiles/:profileId/batches", (req, res) => {
  try {
    const { profileId } = req.params;
    const { date, lab, doctor, results, base64, fileName, hash } = req.body || {};
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: "Nenhum resultado para salvar" });
    }
    const batchId = uid();
    let hasPdf = 0;
    if (base64) {
      try {
        fs.writeFileSync(path.join(pdfDir, `${batchId}.pdf`), Buffer.from(base64, "base64"));
        hasPdf = 1;
      } catch (e) {}
    }
    db.prepare(
      "INSERT INTO batches (id, profile_id, date, lab, doctor, file_hash, pdf_filename, has_pdf, saved_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(batchId, profileId, date || null, lab || "", doctor || "", hash || null, fileName || "exame.pdf", hasPdf, Date.now());

    const insertResult = db.prepare(
      "INSERT INTO results (id, batch_id, name, value, unit, ref, status, category, catalog_id, raw_name, raw_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    );
    for (const r of results) {
      const resolved = resolveCatalogForResult(r);
      insertResult.run(
        uid(), batchId, resolved.name, r.value ?? "", resolved.unit, resolved.ref, resolved.status,
        r.category || "Outro", resolved.catalogId, resolved.rawName, resolved.rawRef
      );
    }
    res.json({ batchId });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao salvar" });
  }
});

// ---------- Tips ----------
// ---------- Tips (dicas de saúde combinando exames + composição corporal + sintomas) ----------
// Guardadas em histórico (tips_history) e só regeneradas quando pedido explicitamente,
// pra não consumir tokens da API toda vez que a pessoa abrir a tela.
function getLatestExamSummaryText(profileId) {
  const batch = db
    .prepare("SELECT id FROM batches WHERE profile_id = ? ORDER BY date DESC, saved_at DESC LIMIT 1")
    .get(profileId);
  if (!batch) return "";
  const results = db.prepare("SELECT name, value, unit, ref, status FROM results WHERE batch_id = ?").all(batch.id);
  const altered = results
    .filter((r) => r.status !== "N")
    .map((r) => `${r.name}: ${r.value} ${r.unit} (ref ${r.ref || "n/d"}) - status ${r.status === "F" ? "fora do ideal" : "atenção"}`);
  return altered.join("\n");
}

app.get("/api/profiles/:profileId/tips", (req, res) => {
  const { profileId } = req.params;
  if (!hasAnyData(profileId)) return res.json({ data: null, stale: false, hasData: false });
  const latest = db
    .prepare("SELECT * FROM tips_history WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(profileId);
  if (!latest) return res.json({ data: null, stale: true, hasData: true });
  const stale = latest.signature !== computeSignature(profileId);
  res.json({
    data: { resumo: latest.resumo, dicas: JSON.parse(latest.dicas) },
    stale, hasData: true, createdAt: latest.created_at,
  });
});

app.post("/api/profiles/:profileId/tips/generate", async (req, res) => {
  try {
    const { profileId } = req.params;
    if (!hasAnyData(profileId)) {
      return res.status(400).json({ error: "Adicione ao menos um exame, uma medição de composição corporal, um sintoma ou uma atividade física antes de gerar dicas." });
    }
    const examSummaryText = getLatestExamSummaryText(profileId);
    const bodyHistoryText = buildBodyHistoryText(profileId, 5);
    const symptomsText = buildSymptomsText(profileId, 15);
    const activitiesText = buildActivitiesText(profileId, 15);
    const signature = computeSignature(profileId);

    const prompt = buildTipsPrompt(examSummaryText, bodyHistoryText, symptomsText, activitiesText);
    const text = await callClaude([{ role: "user", content: prompt }], 1200);
    const parsed = repairJson(text);

    const id = uid();
    db.prepare(
      "INSERT INTO tips_history (id, profile_id, signature, resumo, dicas, created_at) VALUES (?,?,?,?,?,?)"
    ).run(id, profileId, signature, parsed.resumo || "", JSON.stringify(parsed.dicas || []), Date.now());

    res.json({ data: parsed, stale: false, hasData: true, createdAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao gerar dicas" });
  }
});

app.get("/api/profiles/:profileId/tips/history", (req, res) => {
  const rows = db
    .prepare("SELECT id, resumo, dicas, created_at FROM tips_history WHERE profile_id = ? ORDER BY created_at DESC")
    .all(req.params.profileId);
  res.json(rows.map((r) => ({ id: r.id, resumo: r.resumo, dicas: JSON.parse(r.dicas), createdAt: r.created_at })));
});

// ---------- Explicação de um exame específico via IA (o que significa, o que fazer) ----------
function examInfoSignature(latest) {
  return `${latest.value}|${latest.unit || ""}|${latest.ref || ""}|${latest.status || ""}`;
}

// Leitura rápida (sem custo de IA) — devolve a última explicação já gerada para esse exame,
// e avisa se ela ficou desatualizada (o valor mais recente do exame mudou desde então).
app.get("/api/profiles/:profileId/exam-info", (req, res) => {
  const { profileId } = req.params;
  const examName = (req.query.exam || "").toString().trim();
  if (!examName) return res.status(400).json({ error: "Parâmetro 'exam' obrigatório" });

  const row = db
    .prepare("SELECT * FROM exam_explanations WHERE profile_id = ? AND exam_name = ? ORDER BY created_at DESC LIMIT 1")
    .get(profileId, examName);
  if (!row) return res.json({ data: null, stale: false, hasData: false });

  const currentSignature = req.query.signature ? String(req.query.signature) : null;
  const stale = currentSignature !== null && currentSignature !== row.signature;
  res.json({ data: JSON.parse(row.explicacao), stale, hasData: true, createdAt: row.created_at });
});

app.post("/api/profiles/:profileId/exam-info/generate", async (req, res) => {
  try {
    const { profileId } = req.params;
    const { examName, latest, history } = req.body || {};
    if (!examName || !latest || latest.value === undefined) {
      return res.status(400).json({ error: "Dados do exame incompletos para gerar a explicação." });
    }

    const signature = examInfoSignature(latest);
    const historyText = Array.isArray(history)
      ? history
          .map((h) => {
            const statusLabel = h.status === "F" ? "fora do ideal" : h.status === "A" ? "atenção" : "ideal";
            return `- ${h.date || "data não informada"}: ${h.raw ?? h.value} ${h.unit || ""} [${statusLabel}]`;
          })
          .join("\n")
      : "";

    const prompt = buildExamInfoPrompt(examName, latest, historyText);
    const text = await callClaude([{ role: "user", content: prompt }], 1000);
    const parsed = repairJson(text);

    const id = uid();
    db.prepare(
      "INSERT INTO exam_explanations (id, profile_id, exam_name, signature, explicacao, created_at) VALUES (?,?,?,?,?,?)"
    ).run(id, profileId, examName, signature, JSON.stringify(parsed), Date.now());

    res.json({ data: parsed, stale: false, hasData: true, createdAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao gerar explicação do exame" });
  }
});

// ---------- Alerts (sugestões de novos exames via IA, combinando exames + composição corporal + sintomas) ----------
function latestBatchId(profileId) {
  const row = db
    .prepare("SELECT id FROM batches WHERE profile_id = ? ORDER BY date DESC, saved_at DESC LIMIT 1")
    .get(profileId);
  return row ? row.id : null;
}

function computeSignature(profileId) {
  const batch = latestBatchId(profileId);
  const body = db.prepare("SELECT COUNT(*) c, MAX(saved_at) t FROM body_entries WHERE profile_id = ?").get(profileId);
  const sym = db.prepare("SELECT COUNT(*) c, MAX(created_at) t FROM symptoms WHERE profile_id = ?").get(profileId);
  const act = db.prepare("SELECT COUNT(*) c, MAX(created_at) t FROM activities WHERE profile_id = ?").get(profileId);
  return `b:${batch || "-"}|body:${body.c}:${body.t || "-"}|sym:${sym.c}:${sym.t || "-"}|act:${act.c}:${act.t || "-"}`;
}

function hasAnyData(profileId) {
  const batch = db.prepare("SELECT 1 FROM batches WHERE profile_id = ? LIMIT 1").get(profileId);
  if (batch) return true;
  const body = db.prepare("SELECT 1 FROM body_entries WHERE profile_id = ? LIMIT 1").get(profileId);
  if (body) return true;
  const sym = db.prepare("SELECT 1 FROM symptoms WHERE profile_id = ? LIMIT 1").get(profileId);
  if (sym) return true;
  const act = db.prepare("SELECT 1 FROM activities WHERE profile_id = ? LIMIT 1").get(profileId);
  return !!act;
}

function buildActivitiesText(profileId, maxEntries = 20) {
  const rows = db
    .prepare("SELECT date, activity_type, duration_min, intensity, distance_km, calories_kcal FROM activities WHERE profile_id = ? ORDER BY date ASC, created_at ASC")
    .all(profileId);
  const recent = rows.slice(-maxEntries);
  return recent
    .map((a) => {
      const parts = [];
      if (a.duration_min !== null && a.duration_min !== undefined) parts.push(`${a.duration_min} min`);
      if (a.intensity) parts.push(`intensidade ${a.intensity}`);
      if (a.distance_km !== null && a.distance_km !== undefined) parts.push(`${a.distance_km} km`);
      if (a.calories_kcal !== null && a.calories_kcal !== undefined) parts.push(`${a.calories_kcal} kcal`);
      return `- ${a.date || "data não informada"}: ${a.activity_type}${parts.length ? " (" + parts.join(", ") + ")" : ""}`;
    })
    .join("\n");
}

function buildExamHistoryText(profileId, maxBatches = 10) {
  const batchRows = db
    .prepare("SELECT id, date, lab FROM batches WHERE profile_id = ? ORDER BY date ASC, saved_at ASC")
    .all(profileId);
  const recent = batchRows.slice(-maxBatches);
  return recent
    .map((b) => {
      const results = db
        .prepare("SELECT name, value, unit, ref, status FROM results WHERE batch_id = ?")
        .all(b.id);
      const lines = results.map((r) => {
        const statusLabel = r.status === "F" ? "fora do ideal" : r.status === "A" ? "atenção" : "ideal";
        return `- ${r.name}: ${r.value} ${r.unit || ""} (ref: ${r.ref || "n/d"}) [${statusLabel}]`;
      });
      return `Laudo de ${b.date || "data não informada"} (${b.lab || "lab não informado"}):\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function buildBodyHistoryText(profileId, maxEntries = 10) {
  const rows = db
    .prepare("SELECT * FROM body_entries WHERE profile_id = ? ORDER BY date ASC, saved_at ASC")
    .all(profileId);
  const recent = rows.slice(-maxEntries);
  const fieldLabels = [
    ["weight_kg", "peso", "kg"], ["height_cm", "altura", "cm"], ["body_fat_pct", "gordura corporal", "%"],
    ["muscle_mass_kg", "massa muscular", "kg"], ["visceral_fat", "gordura visceral", ""],
    ["bone_mass_kg", "massa óssea", "kg"], ["body_water_pct", "água corporal", "%"], ["bmr_kcal", "TMB", "kcal"],
    ["resting_heart_rate", "frequência cardíaca de repouso", "bpm"],
  ];
  return recent
    .map((e) => {
      const parts = fieldLabels
        .filter(([col]) => e[col] !== null && e[col] !== undefined)
        .map(([col, label, unit]) => `${label}: ${e[col]}${unit}`);
      if (e.systolic_bp !== null && e.systolic_bp !== undefined && e.diastolic_bp !== null && e.diastolic_bp !== undefined) {
        parts.unshift(`pressão arterial: ${e.systolic_bp}/${e.diastolic_bp} mmHg`);
      }
      return `Medição de ${e.date || "data não informada"}: ${parts.join(", ") || "sem dados"}`;
    })
    .join("\n");
}

function buildSymptomsText(profileId, maxSymptoms = 20) {
  const rows = db
    .prepare("SELECT date, description, severity, status FROM symptoms WHERE profile_id = ? ORDER BY date ASC, created_at ASC")
    .all(profileId);
  const recent = rows.slice(-maxSymptoms);
  return recent
    .map((s) => {
      const sev = s.severity ? ` (intensidade: ${s.severity})` : "";
      return `- ${s.date || "data não informada"}: ${s.description}${sev} [${s.status === "resolvido" ? "resolvido" : "ativo"}]`;
    })
    .join("\n");
}

// Leitura rápida (sem custo de IA) — usada para mostrar o aviso e decidir se precisa reanalisar
app.get("/api/profiles/:profileId/alerts", (req, res) => {
  const { profileId } = req.params;
  if (!hasAnyData(profileId)) return res.json({ data: null, stale: false, hasData: false });
  const stored = db.prepare("SELECT * FROM alerts WHERE profile_id = ?").get(profileId);
  if (!stored) return res.json({ data: null, stale: true, hasData: true });
  const stale = stored.based_on_signature !== computeSignature(profileId);
  res.json({ data: JSON.parse(stored.data), stale, hasData: true, createdAt: stored.created_at });
});

// Roda a análise de IA de fato (chamada explícita, não automática, pra não gastar API à toa)
app.post("/api/profiles/:profileId/alerts/analyze", async (req, res) => {
  try {
    const { profileId } = req.params;
    if (!hasAnyData(profileId)) {
      return res.status(400).json({ error: "Adicione ao menos um exame, uma medição de composição corporal, um sintoma ou uma atividade física antes de analisar." });
    }

    const examHistoryText = buildExamHistoryText(profileId);
    const bodyHistoryText = buildBodyHistoryText(profileId);
    const symptomsText = buildSymptomsText(profileId);
    const activitiesText = buildActivitiesText(profileId);
    const signature = computeSignature(profileId);

    const prompt = buildAlertsPrompt(examHistoryText, bodyHistoryText, symptomsText, activitiesText);
    const text = await callClaude([{ role: "user", content: prompt }], 2000);
    const parsed = repairJson(text);

    const dataStr = JSON.stringify(parsed);
    db.prepare(
      `INSERT INTO alerts (profile_id, based_on_signature, has_suggestions, data, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET based_on_signature = excluded.based_on_signature, has_suggestions = excluded.has_suggestions, data = excluded.data, created_at = excluded.created_at`
    ).run(profileId, signature, parsed.temSugestoes ? 1 : 0, dataStr, Date.now());

    res.json({ data: parsed, stale: false, hasData: true, createdAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao analisar histórico" });
  }
});

// ---------- Symptoms (sintomas relatados pela pessoa) ----------
function rowToSymptom(r) {
  return { id: r.id, date: r.date, description: r.description, severity: r.severity, status: r.status, createdAt: r.created_at };
}

app.get("/api/profiles/:profileId/symptoms", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM symptoms WHERE profile_id = ? ORDER BY date ASC, created_at ASC")
    .all(req.params.profileId);
  res.json(rows.map(rowToSymptom));
});

app.post("/api/profiles/:profileId/symptoms", (req, res) => {
  try {
    const { profileId } = req.params;
    const b = req.body || {};
    if (!b.description || !b.description.trim()) return res.status(400).json({ error: "Descreva o sintoma" });
    if (!b.date) return res.status(400).json({ error: "Data é obrigatória" });
    const id = uid();
    db.prepare(
      "INSERT INTO symptoms (id, profile_id, date, description, severity, status, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run(id, profileId, b.date, b.description.trim(), b.severity || null, b.status === "resolvido" ? "resolvido" : "ativo", Date.now());
    res.json(rowToSymptom(db.prepare("SELECT * FROM symptoms WHERE id = ?").get(id)));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao salvar sintoma" });
  }
});

app.put("/api/profiles/:profileId/symptoms/:symptomId", (req, res) => {
  try {
    const { symptomId } = req.params;
    const b = req.body || {};
    const existing = db.prepare("SELECT id FROM symptoms WHERE id = ?").get(symptomId);
    if (!existing) return res.status(404).json({ error: "Sintoma não encontrado" });
    if (!b.description || !b.description.trim()) return res.status(400).json({ error: "Descreva o sintoma" });
    if (!b.date) return res.status(400).json({ error: "Data é obrigatória" });
    db.prepare(
      "UPDATE symptoms SET date=?, description=?, severity=?, status=? WHERE id=?"
    ).run(b.date, b.description.trim(), b.severity || null, b.status === "resolvido" ? "resolvido" : "ativo", symptomId);
    res.json(rowToSymptom(db.prepare("SELECT * FROM symptoms WHERE id = ?").get(symptomId)));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar sintoma" });
  }
});

app.delete("/api/profiles/:profileId/symptoms/:symptomId", (req, res) => {
  db.prepare("DELETE FROM symptoms WHERE id = ?").run(req.params.symptomId);
  res.json({ ok: true });
});

// ---------- Invoices (Notas fiscais / IR) ----------
function rowToInvoice(r) {
  return {
    id: r.id,
    date: r.date,
    provider: r.provider,
    doc: r.doc,
    value: r.value,
    category: r.category,
    description: r.description,
    deduct: !!r.deduct,
    hash: r.file_hash,
    fileName: r.pdf_filename,
    hasPdf: !!r.has_pdf,
    savedAt: r.saved_at,
  };
}

app.get("/api/profiles/:profileId/invoices", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM invoices WHERE profile_id = ? ORDER BY date DESC, saved_at DESC")
    .all(req.params.profileId);
  res.json(rows.map(rowToInvoice));
});

app.post("/api/extract-invoice", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
    const { profileId } = req.body || {};
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    if (profileId) {
      const dup = db.prepare("SELECT date, provider FROM invoices WHERE profile_id = ? AND file_hash = ?").get(profileId, hash);
      if (dup) {
        return res.status(409).json({ error: "duplicate", date: dup.date, provider: dup.provider });
      }
    }

    const base64 = req.file.buffer.toString("base64");
    const text = await callClaude(
      [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: INVOICE_EXTRACTION_PROMPT },
          ],
        },
      ],
      8000
    );
    const parsed = parseExamJson(text);
    if (parsed && parsed.valid === false) {
      return res.status(422).json({
        error: "not_invoice",
        message: "Esse arquivo não parece ser uma nota fiscal, NFS-e, recibo ou fatura de despesa médica/odontológica.",
      });
    }
    res.json({ ...parsed, hash, base64, fileName: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao processar a nota fiscal" });
  }
});

app.post("/api/profiles/:profileId/invoices", (req, res) => {
  try {
    const { profileId } = req.params;
    const { date, provider, doc, value, category, description, base64, fileName, hash } = req.body || {};
    if (!date || value === undefined || value === null || value === "") {
      return res.status(400).json({ error: "Data e valor são obrigatórios" });
    }
    if (hash) {
      const dup = db.prepare("SELECT date, provider FROM invoices WHERE profile_id = ? AND file_hash = ?").get(profileId, hash);
      if (dup) {
        return res.status(409).json({ error: "duplicate", date: dup.date, provider: dup.provider });
      }
    }
    const invoiceId = uid();
    let hasPdf = 0;
    if (base64) {
      try {
        fs.writeFileSync(path.join(invoiceDir, `${invoiceId}.pdf`), Buffer.from(base64, "base64"));
        hasPdf = 1;
      } catch (e) {}
    }
    db.prepare(
      `INSERT INTO invoices (id, profile_id, date, provider, doc, value, category, description, deduct, file_hash, pdf_filename, has_pdf, saved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      invoiceId,
      profileId,
      date,
      provider || "",
      doc || "",
      Number(value) || 0,
      category || "Outro",
      description || "",
      1,
      hash || null,
      fileName || "nota.pdf",
      hasPdf,
      Date.now()
    );
    res.json(rowToInvoice(db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId)));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao salvar nota fiscal" });
  }
});

app.get("/api/profiles/:profileId/invoices/:invoiceId/pdf", (req, res) => {
  const { invoiceId } = req.params;
  const invoice = db.prepare("SELECT pdf_filename as fileName FROM invoices WHERE id = ?").get(invoiceId);
  const pdfPath = path.join(invoiceDir, `${invoiceId}.pdf`);
  if (!invoice || !fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF não encontrado" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${(invoice.fileName || "nota.pdf").replace(/"/g, "")}"`);
  fs.createReadStream(pdfPath).pipe(res);
});

app.delete("/api/profiles/:profileId/invoices/:invoiceId", (req, res) => {
  const { invoiceId } = req.params;
  const pdfPath = path.join(invoiceDir, `${invoiceId}.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  db.prepare("DELETE FROM invoices WHERE id = ?").run(invoiceId);
  res.json({ ok: true });
});

// ---------- WhatsApp: webhook ----------
app.get("/api/whatsapp/webhook", verifyWebhook);
app.post("/api/whatsapp/webhook", handleWebhook);

// ---------- WhatsApp: fila de pendências (arquivos recebidos, aguardando revisão) ----------
function previewFromExtracted(kind, extracted) {
  if (kind === "exame") {
    return { date: extracted?.d || null, lab: extracted?.l || null, count: Array.isArray(extracted?.e) ? extracted.e.length : 0 };
  }
  return { date: extracted?.d || null, provider: extracted?.prov || null, value: extracted?.v ?? null };
}

app.get("/api/profiles/:profileId/whatsapp-uploads", (req, res) => {
  const rows = db
    .prepare("SELECT id, kind, extracted_json, received_at as receivedAt FROM whatsapp_uploads WHERE profile_id = ? ORDER BY received_at DESC")
    .all(req.params.profileId);
  res.json(
    rows.map((r) => {
      let extracted = {};
      try { extracted = JSON.parse(r.extracted_json); } catch (e) {}
      return { id: r.id, kind: r.kind, receivedAt: r.receivedAt, preview: previewFromExtracted(r.kind, extracted) };
    })
  );
});

app.get("/api/profiles/:profileId/whatsapp-uploads/:uploadId", (req, res) => {
  const row = db.prepare("SELECT * FROM whatsapp_uploads WHERE id = ? AND profile_id = ?").get(req.params.uploadId, req.params.profileId);
  if (!row) return res.status(404).json({ error: "Não encontrado" });
  let extracted = {};
  try { extracted = JSON.parse(row.extracted_json); } catch (e) {}
  const ext = extracted._ext || "pdf";
  const filePath = path.join(whatsappDir, `${row.id}.${ext}`);
  let base64 = null;
  if (fs.existsSync(filePath)) base64 = fs.readFileSync(filePath).toString("base64");
  const { _ext, ...cleanExtracted } = extracted;
  res.json({
    id: row.id,
    kind: row.kind,
    extracted: cleanExtracted,
    base64,
    fileName: row.pdf_filename,
    hash: row.file_hash,
    isPdf: ext === "pdf",
  });
});

app.delete("/api/profiles/:profileId/whatsapp-uploads/:uploadId", (req, res) => {
  const row = db.prepare("SELECT extracted_json FROM whatsapp_uploads WHERE id = ? AND profile_id = ?").get(req.params.uploadId, req.params.profileId);
  if (row) {
    let ext = "pdf";
    try { ext = JSON.parse(row.extracted_json)?._ext || "pdf"; } catch (e) {}
    const filePath = path.join(whatsappDir, `${req.params.uploadId}.${ext}`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare("DELETE FROM whatsapp_uploads WHERE id = ? AND profile_id = ?").run(req.params.uploadId, req.params.profileId);
  res.json({ ok: true });
});

// ---------- Export backup ----------
app.get("/api/export", (req, res) => {
  try {
    const profiles = db.prepare("SELECT id, name, color_idx as colorIdx, birth_date as birthDate, gender, height_cm as heightCm, whatsapp, hereditary_conditions as hereditaryConditions, pin, created_at as createdAt FROM profiles").all()
      .map((p) => ({ ...p, hereditaryConditions: parseHereditary(p.hereditaryConditions) }));
    const backup = { version: 9, exportedAt: new Date().toISOString(), profiles, batches: {}, bodyEntries: {}, symptoms: {}, activities: {}, invoices: {} };
    for (const p of profiles) {
      const invoiceRows = db
        .prepare("SELECT * FROM invoices WHERE profile_id = ? ORDER BY date ASC, saved_at ASC")
        .all(p.id);
      backup.invoices[p.id] = invoiceRows.map((r) => {
        const inv = rowToInvoice(r);
        const pdfPath = path.join(invoiceDir, `${r.id}.pdf`);
        if (r.has_pdf && fs.existsSync(pdfPath)) {
          inv.pdfBase64 = fs.readFileSync(pdfPath).toString("base64");
        }
        return inv;
      });
      const activityRows = db
        .prepare("SELECT * FROM activities WHERE profile_id = ? ORDER BY date ASC, created_at ASC")
        .all(p.id);
      backup.activities[p.id] = activityRows.map(rowToActivity);
      const symptomRows = db
        .prepare("SELECT * FROM symptoms WHERE profile_id = ? ORDER BY date ASC, created_at ASC")
        .all(p.id);
      backup.symptoms[p.id] = symptomRows.map(rowToSymptom);
      const bodyRows = db
        .prepare("SELECT * FROM body_entries WHERE profile_id = ? ORDER BY date ASC, saved_at ASC")
        .all(p.id);
      backup.bodyEntries[p.id] = bodyRows.map((r) => {
        const entry = rowToBodyEntry(r);
        if (r.has_photo) {
          const photoPath = path.join(bodyPhotoDir, r.id);
          if (fs.existsSync(photoPath)) {
            entry.photoBase64 = fs.readFileSync(photoPath).toString("base64");
            entry.photoMime = r.photo_mime;
          }
        }
        return entry;
      });
      const batchRows = db
        .prepare("SELECT id as batchId, date, lab, doctor, file_hash as hash, pdf_filename as fileName FROM batches WHERE profile_id = ?")
        .all(p.id);
      const list = [];
      for (const b of batchRows) {
        const results = db
          .prepare("SELECT name, value, unit, ref, status, category FROM results WHERE batch_id = ?")
          .all(b.batchId);
        const pdfPath = path.join(pdfDir, `${b.batchId}.pdf`);
        let pdfBase64 = null;
        if (fs.existsSync(pdfPath)) {
          pdfBase64 = fs.readFileSync(pdfPath).toString("base64");
        }
        list.push({ batchId: b.batchId, date: b.date, lab: b.lab, doctor: b.doctor, hash: b.hash, fileName: b.fileName, results, pdfBase64 });
      }
      backup.batches[p.id] = list;
    }
    res.json(backup);
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao gerar backup" });
  }
});

// ---------- Import backup ----------
app.post("/api/import", (req, res) => {
  try {
    const { profiles, batches, bodyEntries, symptoms, activities, invoices } = req.body || {};
    if (!Array.isArray(profiles)) return res.status(400).json({ error: "Formato de backup inválido." });

    let importedProfiles = 0;
    let importedBatches = 0;
    let importedResults = 0;
    let importedBodyEntries = 0;
    let importedSymptoms = 0;
    let importedActivities = 0;
    let importedInvoices = 0;

    const existingNames = new Set(db.prepare("SELECT name FROM profiles").all().map((r) => r.name));

    for (const p of profiles) {
      let profileId = p.id;
      const already = db.prepare("SELECT id FROM profiles WHERE id = ?").get(profileId);
      if (already) {
        profileId = uid(); // avoid id collision with existing data
      }
      const count = db.prepare("SELECT COUNT(*) as c FROM profiles").get().c;
      db.prepare("INSERT INTO profiles (id, name, color_idx, birth_date, gender, height_cm, whatsapp, hereditary_conditions, pin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        profileId,
        p.name || "Sem nome",
        typeof p.colorIdx === "number" ? p.colorIdx : count % 8,
        p.birthDate || null,
        p.gender || null,
        numOrNull(p.heightCm),
        p.whatsapp ? normalizePhone(p.whatsapp) : null,
        JSON.stringify(Array.isArray(p.hereditaryConditions) ? p.hereditaryConditions : []),
        /^\d{4}$/.test(String(p.pin || "")) ? String(p.pin) : null,
        p.createdAt || Date.now()
      );
      importedProfiles++;

      const batchList = (batches && batches[p.id]) || [];
      for (const b of batchList) {
        const batchId = uid();
        let hasPdf = 0;
        if (b.pdfBase64) {
          try {
            fs.writeFileSync(path.join(pdfDir, `${batchId}.pdf`), Buffer.from(b.pdfBase64, "base64"));
            hasPdf = 1;
          } catch (e) {}
        }
        db.prepare(
          "INSERT INTO batches (id, profile_id, date, lab, doctor, file_hash, pdf_filename, has_pdf, saved_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(batchId, profileId, b.date || null, b.lab || "", b.doctor || "", b.hash || null, b.fileName || "exame.pdf", hasPdf, Date.now());
        importedBatches++;

        const insertResult = db.prepare(
          "INSERT INTO results (id, batch_id, name, value, unit, ref, status, category) VALUES (?,?,?,?,?,?,?,?)"
        );
        for (const r of b.results || []) {
          insertResult.run(uid(), batchId, r.name || "", r.value ?? "", r.unit || "", r.ref || "", r.status || "N", r.category || "Outro");
          importedResults++;
        }
      }
      const bodyList = (bodyEntries && bodyEntries[p.id]) || [];
      for (const e of bodyList) {
        const bodyEntryId = uid();
        let hasPhoto = 0;
        if (e.photoBase64) {
          try {
            fs.writeFileSync(path.join(bodyPhotoDir, bodyEntryId), Buffer.from(e.photoBase64, "base64"));
            hasPhoto = 1;
          } catch (err) {}
        }
        db.prepare(
          `INSERT INTO body_entries
            (id, profile_id, date, weight_kg, height_cm, body_fat_pct, muscle_mass_kg, visceral_fat, bone_mass_kg, body_water_pct, bmr_kcal, systolic_bp, diastolic_bp, resting_heart_rate, protein_pct, body_age, photo_mime, has_photo, notes, saved_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          bodyEntryId, profileId, e.date || null,
          numOrNull(e.weightKg), numOrNull(e.heightCm), numOrNull(e.bodyFatPct), numOrNull(e.muscleMassKg),
          numOrNull(e.visceralFat), numOrNull(e.boneMassKg), numOrNull(e.bodyWaterPct), numOrNull(e.bmrKcal),
          numOrNull(e.systolicBp), numOrNull(e.diastolicBp), numOrNull(e.restingHeartRate),
          numOrNull(e.proteinPct), numOrNull(e.bodyAge),
          hasPhoto ? (e.photoMime || "image/jpeg") : null, hasPhoto,
          e.notes || "", Date.now()
        );
        importedBodyEntries++;
      }
      const symptomList = (symptoms && symptoms[p.id]) || [];
      for (const s of symptomList) {
        db.prepare(
          "INSERT INTO symptoms (id, profile_id, date, description, severity, status, created_at) VALUES (?,?,?,?,?,?,?)"
        ).run(uid(), profileId, s.date || null, s.description || "", s.severity || null, s.status === "resolvido" ? "resolvido" : "ativo", Date.now());
        importedSymptoms++;
      }
      const activityList = (activities && activities[p.id]) || [];
      for (const a of activityList) {
        db.prepare(
          `INSERT OR IGNORE INTO activities (id, profile_id, date, activity_type, duration_min, intensity, distance_km, calories_kcal, notes, source, external_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          uid(), profileId, a.date || null, a.activityType || "",
          numOrNull(a.durationMin), a.intensity || null, numOrNull(a.distanceKm), numOrNull(a.caloriesKcal),
          a.notes || "", a.source || "manual", a.externalId || null, Date.now()
        );
        importedActivities++;
      }
      const invoiceList = (invoices && invoices[p.id]) || [];
      for (const inv of invoiceList) {
        const invoiceId = uid();
        let hasPdf = 0;
        if (inv.pdfBase64) {
          try {
            fs.writeFileSync(path.join(invoiceDir, `${invoiceId}.pdf`), Buffer.from(inv.pdfBase64, "base64"));
            hasPdf = 1;
          } catch (e) {}
        }
        db.prepare(
          `INSERT INTO invoices (id, profile_id, date, provider, doc, value, category, description, deduct, file_hash, pdf_filename, has_pdf, saved_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          invoiceId,
          profileId,
          inv.date || null,
          inv.provider || "",
          inv.doc || "",
          Number(inv.value) || 0,
          inv.category || "Outro",
          inv.description || "",
          inv.deduct === false ? 0 : 1,
          inv.hash || null,
          inv.fileName || "nota.pdf",
          hasPdf,
          Date.now()
        );
        importedInvoices++;
      }
    }

    res.json({ ok: true, importedProfiles, importedBatches, importedResults, importedBodyEntries, importedSymptoms, importedActivities, importedInvoices });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao importar backup" });
  }
});

// ---------- Serve frontend build ----------
const clientDist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const PORT = process.env.PORT || 3000;

// ---------- Error handler (always return JSON, never HTML) ----------
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      error: "O arquivo enviado é grande demais para importar de uma vez. Se o backup tem muitos PDFs, tente importar os perfis em grupos menores.",
    });
  }
  console.error("Erro não tratado:", err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Aviso: ANTHROPIC_API_KEY não definida. A extração automática e as dicas não vão funcionar.");
  }
});
