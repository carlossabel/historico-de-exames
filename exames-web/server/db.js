import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const pdfDir = path.join(dataDir, "pdfs");
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

const db = new Database(path.join(dataDir, "db.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color_idx INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  date TEXT,
  lab TEXT,
  file_hash TEXT,
  pdf_filename TEXT,
  has_pdf INTEGER NOT NULL DEFAULT 0,
  saved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  name TEXT,
  value TEXT,
  unit TEXT,
  ref TEXT,
  status TEXT,
  category TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  profile_id TEXT PRIMARY KEY,
  based_on_batch_id TEXT,
  has_suggestions INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS body_entries (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  date TEXT,
  weight_kg REAL,
  height_cm REAL,
  body_fat_pct REAL,
  muscle_mass_kg REAL,
  visceral_fat REAL,
  bone_mass_kg REAL,
  body_water_pct REAL,
  bmr_kcal REAL,
  notes TEXT,
  saved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symptoms (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  date TEXT,
  description TEXT NOT NULL,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batches_profile ON batches(profile_id);
CREATE INDEX IF NOT EXISTS idx_results_batch ON results(batch_id);
CREATE INDEX IF NOT EXISTS idx_body_entries_profile ON body_entries(profile_id);
CREATE INDEX IF NOT EXISTS idx_symptoms_profile ON symptoms(profile_id);
`);

// Migração leve: bancos criados antes dos sintomas/composição corporal só tinham
// based_on_batch_id na tabela alerts. Adiciona a coluna de assinatura combinada
// (exames + composição corporal + sintomas) se ainda não existir.
const alertsCols = db.prepare("PRAGMA table_info(alerts)").all().map((c) => c.name);
if (!alertsCols.includes("based_on_signature")) {
  db.exec("ALTER TABLE alerts ADD COLUMN based_on_signature TEXT");
}

export default db;
export { pdfDir };
