import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import db, { pdfDir } from "./db.js";
import { callClaude, parseExamJson, extractJsonBlock, EXTRACTION_PROMPT } from "./anthropic.js";

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
app.post("/api/tips", async (req, res) => {
  try {
    const { results } = req.body || {};
    const altered = (results || [])
      .filter((r) => r.status !== "N")
      .map((r) => `${r.name}: ${r.value} ${r.unit} (ref ${r.ref || "n/d"}) - status ${r.status === "F" ? "fora do ideal" : "atenção"}`);
    const prompt = `Com base nesta lista de exames alterados ou em atenção de uma pessoa:\n${
      altered.length ? altered.join("\n") : "Nenhum exame fora do ideal — todos dentro da normalidade."
    }\n\nResponda APENAS com JSON no formato {"resumo":"1-2 frases gerais sobre o quadro","dicas":["dica 1","dica 2", "..."]}. Gere de 3 a 6 dicas práticas de estilo de vida (alimentação, sono, exercício, hidratação, acompanhamento médico) relacionadas aos exames alterados, em português, sem diagnosticar nenhuma doença, sem citar nomes de medicamentos. Seja direto e não use markdown.`;
    const text = await callClaude([{ role: "user", content: prompt }], 1000);
    const parsed = JSON.parse(extractJsonBlock(text));
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao gerar dicas" });
  }
});

// ---------- Export backup ----------
app.get("/api/export", (req, res) => {
  try {
    const profiles = db.prepare("SELECT id, name, color_idx as colorIdx, created_at as createdAt FROM profiles").all();
    const backup = { version: 1, exportedAt: new Date().toISOString(), profiles, batches: {} };
    for (const p of profiles) {
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
    const { profiles, batches } = req.body || {};
    if (!Array.isArray(profiles)) return res.status(400).json({ error: "Formato de backup inválido." });

    let importedProfiles = 0;
    let importedBatches = 0;
    let importedResults = 0;

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
    }

    res.json({ ok: true, importedProfiles, importedBatches, importedResults });
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
