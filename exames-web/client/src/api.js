export async function getProfiles() {
  const r = await fetch("/api/profiles");
  return r.json();
}

export async function createProfile(name, extra = {}) {
  const r = await fetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...extra }),
  });
  return r.json();
}

export async function updateProfile(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao atualizar perfil");
  return data;
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

export async function updateBatch(profileId, batchId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/batches/${batchId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao atualizar laudo");
  return data;
}

export async function deleteBatch(profileId, batchId) {
  await fetch(`/api/profiles/${profileId}/batches/${batchId}`, { method: "DELETE" });
}

export function pdfUrl(profileId, batchId) {
  return `/api/profiles/${profileId}/batches/${batchId}/pdf`;
}

export async function exportBackup() {
  const r = await fetch("/api/export");
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao exportar backup");
  return data;
}

export async function importBackup(backupData) {
  const r = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(backupData),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao importar backup");
  return data;
}

export async function getTips(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/tips`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao buscar dicas");
  return data;
}

export async function generateTips(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/tips/generate`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao gerar dicas");
  return data;
}

export async function getTipsHistory(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/tips/history`);
  return r.json();
}

export async function getExamInfo(profileId, examName, signature) {
  const params = new URLSearchParams({ exam: examName });
  if (signature) params.set("signature", signature);
  const r = await fetch(`/api/profiles/${profileId}/exam-info?${params.toString()}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao buscar explicação do exame");
  return data;
}

export async function generateExamInfo(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/exam-info/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao gerar explicação do exame");
  return data;
}

export async function getAlerts(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/alerts`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao buscar alertas");
  return data;
}

export async function analyzeAlerts(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/alerts/analyze`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao analisar histórico de exames");
  return data;
}

export async function getBodyEntries(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/body-entries`);
  return r.json();
}

export async function createBodyEntry(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/body-entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao salvar medição");
  return data;
}

export async function updateBodyEntry(profileId, entryId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/body-entries/${entryId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao atualizar medição");
  return data;
}

export async function deleteBodyEntry(profileId, entryId) {
  await fetch(`/api/profiles/${profileId}/body-entries/${entryId}`, { method: "DELETE" });
}

export function bodyPhotoUrl(profileId, entryId) {
  return `/api/profiles/${profileId}/body-entries/${entryId}/photo`;
}

export async function recalcBodyAge(profileId, entryId) {
  const r = await fetch(`/api/profiles/${profileId}/body-entries/${entryId}/recalc-body-age`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao calcular idade corporal");
  return data;
}

export async function getBodyMetricInfo(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/body-metric-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao gerar análise");
  return data;
}

export async function getSymptoms(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/symptoms`);
  return r.json();
}

export async function createSymptom(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/symptoms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao salvar sintoma");
  return data;
}

export async function updateSymptom(profileId, symptomId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/symptoms/${symptomId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao atualizar sintoma");
  return data;
}

export async function deleteSymptom(profileId, symptomId) {
  await fetch(`/api/profiles/${profileId}/symptoms/${symptomId}`, { method: "DELETE" });
}

export async function getActivities(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/activities`);
  return r.json();
}

export async function createActivity(profileId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/activities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao salvar atividade");
  return data;
}

export async function updateActivity(profileId, activityId, payload) {
  const r = await fetch(`/api/profiles/${profileId}/activities/${activityId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao atualizar atividade");
  return data;
}

export async function deleteActivity(profileId, activityId) {
  await fetch(`/api/profiles/${profileId}/activities/${activityId}`, { method: "DELETE" });
}

export async function extractBodyPhoto(profileId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/api/profiles/${profileId}/body-entries/extract-photo`, { method: "POST", body: fd });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao ler a imagem");
  return data;
}

export async function getStravaStatus(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/strava/status`);
  return r.json();
}

export function stravaConnectUrl(profileId) {
  return `/api/profiles/${profileId}/strava/connect`;
}

export async function syncStrava(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/strava/sync`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro ao sincronizar com o Strava");
  return data;
}

export async function disconnectStrava(profileId) {
  await fetch(`/api/profiles/${profileId}/strava/disconnect`, { method: "DELETE" });
}

export async function getActivityWebhook(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/activity-webhook`);
  return r.json();
}

export async function resetActivityWebhook(profileId) {
  const r = await fetch(`/api/profiles/${profileId}/activity-webhook/reset`, { method: "POST" });
  return r.json();
}
