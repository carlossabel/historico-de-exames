export async function getProfiles() {
  const r = await fetch("/api/profiles");
  return r.json();
}

export async function createProfile(name) {
  const r = await fetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return r.json();
}

export async function deleteProfile(id) {
  await fetch(`/api/profiles/${id}`, { method: "DELETE" });
}

export async function getBatchIndex(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/batches`);
  return r.json();
}

export async function getBatch(profileId, batchId) {
  const r = await fetch(`/api/profiles/${profileId}/batches/${batchId}`);
  return r.json();
}

export async function extractPdf(profileId, file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("profileId", profileId);
  const r = await fetch("/api/extract", { method: "POST", body: fd });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data.error || "Erro ao processar o PDF");
    err.duplicate = data.error === "duplicate";
    err.dupInfo = data;
    throw err;
  }
  return data;
}

export async function saveBatch(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

export async function deleteBatch(profileId, batchId) {
  await fetch(`/api/profiles/${profileId}/batches/${batchId}`, { method: "DELETE" });
}

export function pdfUrl(profileId, batchId) {
  return `/api/profiles/${profileId}/batches/${batchId}/pdf`;
}

export async function importBackup(secret, backupData) {
  const r = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-import-secret": secret },
    body: JSON.stringify(backupData),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao importar backup");
  return data;
}

export async function getTips(results) {
  const r = await fetch("/api/tips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao gerar dicas");
  return data;
}
