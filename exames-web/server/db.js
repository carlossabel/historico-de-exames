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

CREATE INDEX IF NOT EXISTS idx_batches_profile ON batches(profile_id);
CREATE INDEX IF NOT EXISTS idx_results_batch ON results(batch_id);
`);

export default db;
export { pdfDir };
