import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import db, { pdfDir } from "./db.js";
import { callClaude, parseExamJson, repairJson, extractJsonBlock, EXTRACTION_PROMPT, buildAlertsPrompt, buildTipsPrompt } from "./anthropic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: "60mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

// ---------- Profiles ----------
app.get("/api/profiles", (req, res) => {
  const rows = db
    .prepare("SELECT id, name, color_idx as colorIdx, created_at as createdAt FROM profiles ORDER BY created_at ASC")
    .all();
  res.json(rows);
});

app.post("/api/profiles", (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome obrigatório" });
  const count = db.prepare("SELECT COUNT(*) as c FROM profiles").get().c;
  const id = uid();
  const colorIdx = count % 8;
  const createdAt = Date.now();
  db.prepare("INSERT INTO profiles (id, name, color_idx, created_at) VALUES (?, ?, ?, ?)").run(id, name.trim(), colorIdx, createdAt);
  res.json({ id, name: name.trim(), colorIdx, createdAt });
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
  db.prepare("DELETE FROM body_entries WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM symptoms WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM tips_history WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM activities WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------- Batches ----------
app.get("/api/profiles/:profileId/batches", (req, res) => {
  const { profileId } = req.params;
  const rows = db
    .prepare(
      "SELECT id as batchId, date, lab, file_hash as hash, has_pdf as hasPdf, pdf_filename as fileName, saved_at as savedAt FROM batches WHERE profile_id = ? ORDER BY date DESC"
    )
    .all(profileId);
  res.json(rows);
});

app.get("/api/profiles/:profileId/batches/:batchId", (req, res) => {
  const { batchId } = req.params;
  const batch = db.prepare("SELECT id, date, lab FROM batches WHERE id = ?").get(batchId);
  if (!batch) return res.status(404).json({ error: "Não encontrado" });
  const results = db.prepare("SELECT id, name, value, unit, ref, status, category FROM results WHERE batch_id = ?").all(batchId);
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

app.delete("/api/profiles/:profileId/batches/:batchId", (req, res) => {
  const { batchId } = req.params;
  const pdfPath = path.join(pdfDir, `${batchId}.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  db.prepare("DELETE FROM results WHERE batch_id = ?").run(batchId);
  db.prepare("DELETE FROM batches WHERE id = ?").run(batchId);
  res.json({ ok: true });
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
    notes: r.notes,
    savedAt: r.saved_at,
  };
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

app.get("/api/profiles/:profileId/body-entries", (req, res) => {
  const { profileId } = req.params;
  const rows = db
    .prepare("SELECT * FROM body_entries WHERE profile_id = ? ORDER BY date ASC, saved_at ASC")
    .all(profileId);
  res.json(rows.map(rowToBodyEntry));
});

app.post("/api/profiles/:profileId/body-entries", (req, res) => {
  try {
    const { profileId } = req.params;
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "Data da medição é obrigatória" });
    const id = uid();
    db.prepare(
      `INSERT INTO body_entries
        (id, profile_id, date, weight_kg, height_cm, body_fat_pct, muscle_mass_kg, visceral_fat, bone_mass_kg, body_water_pct, bmr_kcal, notes, saved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, profileId, b.date,
      numOrNull(b.weightKg), numOrNull(b.heightCm), numOrNull(b.bodyFatPct), numOrNull(b.muscleMassKg),
      numOrNull(b.visceralFat), numOrNull(b.boneMassKg), numOrNull(b.bodyWaterPct), numOrNull(b.bmrKcal),
      b.notes || "", Date.now()
    );
    const row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(id);
    res.json(rowToBodyEntry(row));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao salvar medição" });
  }
});

app.put("/api/profiles/:profileId/body-entries/:entryId", (req, res) => {
  try {
    const { entryId } = req.params;
    const b = req.body || {};
    const existing = db.prepare("SELECT id FROM body_entries WHERE id = ?").get(entryId);
    if (!existing) return res.status(404).json({ error: "Medição não encontrada" });
    if (!b.date) return res.status(400).json({ error: "Data da medição é obrigatória" });
    db.prepare(
      `UPDATE body_entries SET date=?, weight_kg=?, height_cm=?, body_fat_pct=?, muscle_mass_kg=?, visceral_fat=?, bone_mass_kg=?, body_water_pct=?, bmr_kcal=?, notes=? WHERE id=?`
    ).run(
      b.date,
      numOrNull(b.weightKg), numOrNull(b.heightCm), numOrNull(b.bodyFatPct), numOrNull(b.muscleMassKg),
      numOrNull(b.visceralFat), numOrNull(b.boneMassKg), numOrNull(b.bodyWaterPct), numOrNull(b.bmrKcal),
      b.notes || "", entryId
    );
    const row = db.prepare("SELECT * FROM body_entries WHERE id = ?").get(entryId);
    res.json(rowToBodyEntry(row));
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar medição" });
  }
});

app.delete("/api/profiles/:profileId/body-entries/:entryId", (req, res) => {
  db.prepare("DELETE FROM body_entries WHERE id = ?").run(req.params.entryId);
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
      1000
    );
    const parsed = parseExamJson(text);
    res.json({ ...parsed, hash, base64, fileName: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao processar PDF" });
  }
});

// ---------- Save batch ----------
app.post("/api/profiles/:profileId/batches", (req, res) => {
  try {
    const { profileId } = req.params;
    const { date, lab, results, base64, fileName, hash } = req.body || {};
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
      "INSERT INTO batches (id, profile_id, date, lab, file_hash, pdf_filename, has_pdf, saved_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(batchId, profileId, date || null, lab || "", hash || null, fileName || "exame.pdf", hasPdf, Date.now());

    const insertResult = db.prepare(
      "INSERT INTO results (id, batch_id, name, value, unit, ref, status, category) VALUES (?,?,?,?,?,?,?,?)"
    );
    for (const r of results) {
      insertResult.run(uid(), batchId, r.name || "", r.value ?? "", r.unit || "", r.ref || "", r.status || "N", r.category || "Outro");
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
  ];
  return recent
    .map((e) => {
      const parts = fieldLabels
        .filter(([col]) => e[col] !== null && e[col] !== undefined)
        .map(([col, label, unit]) => `${label}: ${e[col]}${unit}`);
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

// ---------- Export backup ----------
app.get("/api/export", (req, res) => {
  try {
    const profiles = db.prepare("SELECT id, name, color_idx as colorIdx, created_at as createdAt FROM profiles").all();
    const backup = { version: 4, exportedAt: new Date().toISOString(), profiles, batches: {}, bodyEntries: {}, symptoms: {}, activities: {} };
    for (const p of profiles) {
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
      backup.bodyEntries[p.id] = bodyRows.map(rowToBodyEntry);
      const batchRows = db
        .prepare("SELECT id as batchId, date, lab, file_hash as hash, pdf_filename as fileName FROM batches WHERE profile_id = ?")
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
        list.push({ batchId: b.batchId, date: b.date, lab: b.lab, hash: b.hash, fileName: b.fileName, results, pdfBase64 });
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
    const { profiles, batches, bodyEntries, symptoms, activities } = req.body || {};
    if (!Array.isArray(profiles)) return res.status(400).json({ error: "Formato de backup inválido." });

    let importedProfiles = 0;
    let importedBatches = 0;
    let importedResults = 0;
    let importedBodyEntries = 0;
    let importedSymptoms = 0;
    let importedActivities = 0;

    const existingNames = new Set(db.prepare("SELECT name FROM profiles").all().map((r) => r.name));

    for (const p of profiles) {
      let profileId = p.id;
      const already = db.prepare("SELECT id FROM profiles WHERE id = ?").get(profileId);
      if (already) {
        profileId = uid(); // avoid id collision with existing data
      }
      const count = db.prepare("SELECT COUNT(*) as c FROM profiles").get().c;
      db.prepare("INSERT INTO profiles (id, name, color_idx, created_at) VALUES (?,?,?,?)").run(
        profileId,
        p.name || "Sem nome",
        typeof p.colorIdx === "number" ? p.colorIdx : count % 8,
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
          "INSERT INTO batches (id, profile_id, date, lab, file_hash, pdf_filename, has_pdf, saved_at) VALUES (?,?,?,?,?,?,?,?)"
        ).run(batchId, profileId, b.date || null, b.lab || "", b.hash || null, b.fileName || "exame.pdf", hasPdf, Date.now());
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
        db.prepare(
          `INSERT INTO body_entries
            (id, profile_id, date, weight_kg, height_cm, body_fat_pct, muscle_mass_kg, visceral_fat, bone_mass_kg, body_water_pct, bmr_kcal, notes, saved_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          uid(), profileId, e.date || null,
          numOrNull(e.weightKg), numOrNull(e.heightCm), numOrNull(e.bodyFatPct), numOrNull(e.muscleMassKg),
          numOrNull(e.visceralFat), numOrNull(e.boneMassKg), numOrNull(e.bodyWaterPct), numOrNull(e.bmrKcal),
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
          `INSERT INTO activities (id, profile_id, date, activity_type, duration_min, intensity, distance_km, calories_kcal, notes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(
          uid(), profileId, a.date || null, a.activityType || "",
          numOrNull(a.durationMin), a.intensity || null, numOrNull(a.distanceKm), numOrNull(a.caloriesKcal),
          a.notes || "", Date.now()
        );
        importedActivities++;
      }
    }

    res.json({ ok: true, importedProfiles, importedBatches, importedResults, importedBodyEntries, importedSymptoms, importedActivities });
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
