const AREA_FILL_TOOLS = new Set(['area_bucket', 'area_enclose', 'exclude_area_bucket', 'exclude_area_enclose']);
function isAreaFillTool(tool = state.tool) { return AREA_FILL_TOOLS.has(tool); }
function areaFillRole(tool = state.tool) { return tool.startsWith('exclude_') ? 'exclude' : 'apply'; }
function syncAreaFillOptions() {
  $('#areaFillOptions').hidden = !isAreaFillTool();
  $('#areaReplaceExisting').checked = state.settings?.editing?.area_replace_existing === true;
}
let areaFillPreferenceSave = Promise.resolve();
let areaFillPreferencePending = 0;
let areaFillPreferenceSaved = false;
let areaFillPreferenceVersion = 0;
function saveAreaFillPreference(value) {
  if (!areaFillPreferencePending) areaFillPreferenceSaved = state.settings.editing.area_replace_existing === true;
  const version = ++areaFillPreferenceVersion;
  areaFillPreferencePending++;
  state.settings.editing.area_replace_existing = value;
  areaFillPreferenceSave = areaFillPreferenceSave.then(async () => {
    try {
      await api('/api/settings?status=0', { method: 'POST', body: JSON.stringify({ editing: { area_replace_existing: value } }) });
      areaFillPreferenceSaved = value;
    } catch (error) {
      if (version === areaFillPreferenceVersion) { state.settings.editing.area_replace_existing = areaFillPreferenceSaved; syncAreaFillOptions(); }
      showUserError(error);
    } finally { areaFillPreferencePending--; }
  });
}
function cancelAreaFill() {
  state.areaFill = null;
  const operation = state.areaFillOperation;
  if (operation?.phase === 'committing') return false;
  if (operation) {
    operation.cancelled = true; operation.worker?.terminate(); operation.resolve?.(null);
    state.areaFillOperation = null; state.fillPending = false;
    renderCandidates(); updateActionButtons();
  }
  state.drawing = false; state.gestureDisplaySide = null; render();
  return true;
}
function beginAreaEnclosure(point) {
  state.areaFill = { points: [point], side: state.gestureDisplaySide };
}
function appendAreaEnclosure(point) {
  const points = state.areaFill?.points;
  if (points && (points.at(-1).x !== point.x || points.at(-1).y !== point.y)) points.push(point);
}
function drawAreaEnclosure() {
  const draft = state.areaFill; if (!draft?.points.length) return;
  const offset = compareSideOffset(draft.side);
  ctx.save(); clipRenderPane(ctx, offset); ctx.beginPath();
  draft.points.forEach((point, index) => {
    const transformed = transformImagePoint(point);
    const x = offset + state.view.x + transformed.x * state.view.scale;
    const y = state.view.y + transformed.y * state.view.scale;
    if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath(); ctx.fillStyle = areaFillRole() === 'apply' ? 'rgba(80,213,137,0.25)' : 'rgba(240,186,98,0.25)';
  ctx.fill('evenodd'); ctx.strokeStyle = areaFillRole() === 'apply' ? '#50d589' : '#f0ba62'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
}
async function applyAreaFill({ point = null, points = null } = {}) {
  const imageId = state.currentId; const record = currentRecord();
  if (!record || !state.currentImage || isBusy() || state.projectReadOnly || !isProcessableImage(record)) return;
  const operation = { phase: 'preparing', cancelled: false };
  const tool = state.tool; const role = areaFillRole(tool); const replaceExisting = state.settings.editing.area_replace_existing === true;
  const epoch = state.catalogEpoch; const generation = state.imageGeneration;
  state.areaFillOperation = operation; state.fillPending = true; renderCandidates(); updateActionButtons();
  const stillCurrent = () => !operation.cancelled && state.areaFillOperation === operation && state.currentId === imageId && state.catalogEpoch === epoch && state.imageGeneration === generation;
  try {
    await flushWorkspaceDraft(imageId);
    while (state.imageMutationChains.has(imageId)) await state.imageMutationChains.get(imageId);
    if (!stillCurrent()) return;
    flushMaskComposition();
    const expectedRevision = Number(record.candidateRevision || 0);
    const expectedManualRevision = Number(state.workspaceDraftRevisions.get(imageId) ?? record.manualRevision ?? 0);
    const width = state.currentImage.width; const height = state.currentImage.height;
    operation.phase = 'calculating';
    const payload = { width, height, points };
    if (!points) {
      const bitmap = await createImageBitmap(role === 'apply' ? combinedCanvas : effectiveExclusionCanvas);
      if (!stillCurrent()) { bitmap.close(); return; }
      Object.assign(payload, { bitmap, x: Math.floor(point.x), y: Math.floor(point.y) });
    }
    const result = await new Promise((resolve, reject) => {
      operation.resolve = resolve;
      let worker;
      try { worker = operation.worker = new Worker('/js/area-fill-worker.js'); }
      catch (error) { payload.bitmap?.close(); reject(error); return; }
      worker.onmessage = ({ data }) => data.failure ? reject(new Error(data.failure)) : resolve(data);
      worker.onerror = reject;
      try { worker.postMessage(payload, payload.bitmap ? [payload.bitmap] : []); }
      catch (error) { payload.bitmap?.close(); reject(error); }
    });
    operation.worker?.terminate(); operation.worker = null; operation.resolve = null;
    if (!stillCurrent() || !result) return;
    if (result.open) { setStatusKey('editor.areaNotClosed', {}, 'warning'); return; }
    if (!result.spans.length) return;
    operation.phase = 'committing';
    const saved = await api(`/api/images/${encodeURIComponent(imageId)}/area-fill`, { method: 'POST', body: JSON.stringify({ role, spans: Array.from(result.spans), replaceExisting, expectedRevision, expectedManualRevision }) });
    if (!saved.changed || !stillCurrent()) return;
    record.candidateRevision = saved.candidateRevision; record.manualRevision = saved.manualRevision;
    state.drafts.delete(imageId); state.workspaceDraftRevisions.set(imageId, saved.manualRevision);
    invalidateCandidateBundles(imageId);
    state.areaFillOperation = null; state.fillPending = false;
    await selectImage(imageId, true, { saveCurrentDraft: false, preserveView: true });
    if (shouldBlinkNewManual(role)) inheritRoleCandidateDisplayMode(role, [role === 'apply' ? 'manual:apply' : 'manual:exclude']);
    refreshCurrentReviewAndMask(); render();
  } catch (error) { if (!operation.cancelled) showUserError(error); }
  finally {
    operation.worker?.terminate();
    if (state.areaFillOperation === operation) { state.areaFillOperation = null; state.fillPending = false; }
    renderCandidates(); updateActionButtons(); updateHistoryButtons();
  }
}
