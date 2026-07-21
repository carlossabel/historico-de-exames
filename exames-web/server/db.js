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
  birth_date TEXT,
  gender TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  date TEXT,
  lab TEXT,
  doctor TEXT,
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
  systolic_bp REAL,
  diastolic_bp REAL,
  resting_heart_rate REAL,
  protein_pct REAL,
  body_age REAL,
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

CREATE TABLE IF NOT EXISTS tips_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  signature TEXT,
  resumo TEXT,
  dicas TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  date TEXT,
  activity_type TEXT NOT NULL,
  duration_min REAL,
  intensity TEXT,
  distance_km REAL,
  calories_kcal REAL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_explanations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  exam_name TEXT NOT NULL,
  signature TEXT,
  explicacao TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strava_tokens (
  profile_id TEXT PRIMARY KEY,
  athlete_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  connected_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity_webhooks (
  profile_id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batches_profile ON batches(profile_id);
CREATE INDEX IF NOT EXISTS idx_results_batch ON results(batch_id);
CREATE INDEX IF NOT EXISTS idx_body_entries_profile ON body_entries(profile_id);
CREATE INDEX IF NOT EXISTS idx_symptoms_profile ON symptoms(profile_id);
CREATE INDEX IF NOT EXISTS idx_tips_history_profile ON tips_history(profile_id);
CREATE INDEX IF NOT EXISTS idx_activities_profile ON activities(profile_id);
CREATE INDEX IF NOT EXISTS idx_exam_explanations_profile_exam ON exam_explanations(profile_id, exam_name);
`);

// Migração leve: bancos criados antes do Strava/Apple Watch só tinham as colunas
// originais de activities (sem source/external_id). Adiciona se ainda não existirem,
// e cria o índice único parcial que evita duplicar atividades sincronizadas.
const activitiesCols = db.prepare("PRAGMA table_info(activities)").all().map((c) => c.name);
if (!activitiesCols.includes("source")) {
  db.exec("ALTER TABLE activities ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
}
if (!activitiesCols.includes("external_id")) {
  db.exec("ALTER TABLE activities ADD COLUMN external_id TEXT");
}
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_external ON activities(profile_id, source, external_id) WHERE external_id IS NOT NULL"
);

const batchesCols = db.prepare("PRAGMA table_info(batches)").all().map((c) => c.name);
if (!batchesCols.includes("doctor")) {
  db.exec("ALTER TABLE batches ADD COLUMN doctor TEXT");
}

const bodyEntriesCols = db.prepare("PRAGMA table_info(body_entries)").all().map((c) => c.name);
if (!bodyEntriesCols.includes("systolic_bp")) {
  db.exec("ALTER TABLE body_entries ADD COLUMN systolic_bp REAL");
}
if (!bodyEntriesCols.includes("diastolic_bp")) {
  db.exec("ALTER TABLE body_entries ADD COLUMN diastolic_bp REAL");
}
if (!bodyEntriesCols.includes("resting_heart_rate")) {
  db.exec("ALTER TABLE body_entries ADD COLUMN resting_heart_rate REAL");
}
if (!bodyEntriesCols.includes("protein_pct")) {
  db.exec("ALTER TABLE body_entries ADD COLUMN protein_pct REAL");
}
if (!bodyEntriesCols.includes("body_age")) {
  db.exec("ALTER TABLE body_entries ADD COLUMN body_age REAL");
}

// Migração leve: perfis criados antes de existir "idade corporal" não tinham data de
// nascimento nem sexo — necessários pra IA estimar a idade corporal com alguma referência.
const profilesCols = db.prepare("PRAGMA table_info(profiles)").all().map((c) => c.name);
if (!profilesCols.includes("birth_date")) {
  db.exec("ALTER TABLE profiles ADD COLUMN birth_date TEXT");
}
if (!profilesCols.includes("gender")) {
  db.exec("ALTER TABLE profiles ADD COLUMN gender TEXT");
}

// Migração leve: bancos criados antes dos sintomas/composição corporal só tinham
// based_on_batch_id na tabela alerts. Adiciona a coluna de assinatura combinada
// (exames + composição corporal + sintomas) se ainda não existir.
const alertsCols = db.prepare("PRAGMA table_info(alerts)").all().map((c) => c.name);
if (!alertsCols.includes("based_on_signature")) {
  db.exec("ALTER TABLE alerts ADD COLUMN based_on_signature TEXT");
}

export default db;
export { pdfDir };
