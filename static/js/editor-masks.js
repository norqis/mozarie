function candidateLabel({ labelToken }) {
  return t(`candidateLabel.${labelToken}`);
}

function manualLayerPresence() {
  return {
    hasManualExclude: canvasHasPixels(exclusionCtx, exclusionCanvas),
    hasManualExclusionErase: canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas),
  };
}

let candidatePaddingSession = null;

function candidatePaddingLimit() {
  const record = currentRecord();
  return Math.max(0, Math.ceil(Math.hypot((Number(record?.width) || 1) - 1, (Number(record?.height) || 1) - 1)));
}

function candidatePaddingValue(input = $("#candidatePaddingInput")) {
  const text = String(input.value).trim();
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) && value <= Number(input.max) ? value : null;
}

function validateCandidatePadding() {
  const input = $("#candidatePaddingInput");
  const value = candidatePaddingValue(input);
  input.setAttribute("aria-invalid", String(value === null));
  $("#candidatePaddingValidation").textContent = value === null ? t("candidates.paddingInvalid", { max: input.max }) : "";
  return value;
}

function closeCandidatePadding({ restoreFocus = false } = {}) {
  const session = candidatePaddingSession;
  candidatePaddingSession = null;
  const popover = $("#candidatePaddingPopover");
  if (popover.matches?.(":popover-open")) popover.hidePopover();
  if (restoreFocus && session?.trigger?.isConnected) session.trigger.focus();
}

function positionCandidatePadding(trigger) {
  const popover = $("#candidatePaddingPopover");
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - popoverRect.width - 8, triggerRect.right - popoverRect.width));
  const below = triggerRect.bottom + 5;
  const top = below + popoverRect.height <= innerHeight - 8 ? below : Math.max(8, triggerRect.top - popoverRect.height - 5);
  popover.style.left = `${left}px`; popover.style.top = `${top}px`;
}

function openCandidatePadding(candidateId, trigger) {
  if (trigger.disabled) return;
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) return;
  closeCandidatePadding();
  const input = $("#candidatePaddingInput");
  const value = candidate.expandPx || 0;
  input.max = String(candidatePaddingLimit()); input.value = String(value); input.placeholder = "";
  input.setAttribute("aria-invalid", "false"); $("#candidatePaddingValidation").textContent = "";
  candidatePaddingSession = { mode: "single", imageId: state.currentId, candidateId, original: value, trigger, committing: false };
  const popover = $("#candidatePaddingPopover"); popover.showPopover(); positionCandidatePadding(trigger);
  input.focus(); input.select();
}

function openBatchCandidatePadding(role, trigger) {
  if (trigger.disabled) return;
  const candidates = state.candidates.filter((candidate) => candidate.role === role && !state.removedCandidateIds.has(candidate.id));
  if (!candidates.length) return;
  closeCandidatePadding();
  const values = new Set(candidates.map((candidate) => candidate.expandPx || 0));
  const input = $("#candidatePaddingInput");
  input.max = String(candidatePaddingLimit()); input.value = values.size === 1 ? String(values.values().next().value) : "";
  input.placeholder = values.size === 1 ? "" : t("candidates.paddingMixed");
  input.setAttribute("aria-invalid", "false"); $("#candidatePaddingValidation").textContent = "";
  candidatePaddingSession = { mode: "batch", imageId: state.currentId, role, original: values.size === 1 ? values.values().next().value : null, trigger, committing: false };
  const popover = $("#candidatePaddingPopover"); popover.showPopover(); positionCandidatePadding(trigger);
  input.focus(); input.select();
}

async function commitCandidatePadding() {
  const session = candidatePaddingSession;
  if (!session || session.committing) return false;
  const value = validateCandidatePadding();
  if (value === null) { $("#candidatePaddingInput").focus(); return false; }
  if (session.imageId !== state.currentId || state.projectReadOnly || isBusy() || state.importing || state.candidateBatchPending.has(state.currentId)) {
    closeCandidatePadding({ restoreFocus: true }); return false;
  }
  if (session.mode === "batch") return commitBatchCandidatePadding(session, value);
  const candidate = state.candidates.find((item) => item.id === session.candidateId);
  if (value === session.original) { closeCandidatePadding({ restoreFocus: true }); return true; }
  session.committing = true;
  const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
  candidate.expandPx = value; markMaskDirty(); setReviewed(currentRecord(), false);
  syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); render();
  closeCandidatePadding();
  await updateCandidate(candidate, candidate.enabled, previousMaskStatus, candidate.forced, session.original);
  return true;
}

async function commitBatchCandidatePadding(session, value) {
  const changed = state.candidates.filter((candidate) => candidate.role === session.role && !state.removedCandidateIds.has(candidate.id));
  if (!changed.length || changed.every((candidate) => (candidate.expandPx || 0) === value)) {
    closeCandidatePadding({ restoreFocus: true }); return true;
  }
  session.committing = true;
  const imageId = session.imageId; const generation = state.imageGeneration;
  state.candidateBatchPending.add(imageId); closeCandidatePadding(); renderCandidates();
  try {
    const result = await api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageId, role: session.role, operation: "set_padding", expandPx: value }) });
    if (state.currentId === imageId && isCurrentGeneration(generation)) {
      await reconcileCurrentCandidates(imageId, generation);
      retainCurrentCandidateBundle(imageId, result.candidateRevision);
      markMaskDirty(); setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); render();
    } else await refreshCandidateRecord(imageId, true);
    return true;
  } catch (error) {
    if (state.currentId === imageId && isCurrentGeneration(generation)) {
      try { await reconcileCurrentCandidates(imageId, generation); } catch { /* Existing visible state remains usable. */ }
      showUserError(error);
    }
    return false;
  } finally {
    state.candidateBatchPending.delete(imageId);
    if (state.currentId === imageId && isCurrentGeneration(generation)) renderCandidates();
    updateActionButtons();
  }
}

function changeCandidatePaddingDraft(delta) {
  const input = $("#candidatePaddingInput");
  const value = candidatePaddingValue(input);
  const base = value === null ? candidatePaddingSession?.original || 0 : value;
  input.value = String(Math.max(0, Math.min(Number(input.max), base + delta)));
  validateCandidatePadding(); input.focus(); input.select();
}

function handleCandidatePaddingKeydown(event) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault(); event.stopPropagation();
  changeCandidatePaddingDraft(event.key === "ArrowUp" ? 1 : -1);
}

function initCandidatePaddingPopover() {
  for (const selector of ["#candidateList", "#exclusionList"]) {
    $(selector).addEventListener("click", (event) => {
      const trigger = event.target.closest?.("[data-candidate-padding-id]");
      if (trigger) openCandidatePadding(trigger.dataset.candidatePaddingId, trigger);
    });
  }
  document.querySelectorAll("[data-candidate-padding-batch]").forEach((trigger) => trigger.addEventListener("click", () => openBatchCandidatePadding(trigger.dataset.candidatePaddingBatch, trigger)));
  $("#candidatePaddingInput").addEventListener("input", validateCandidatePadding);
  $("#candidatePaddingInput").addEventListener("keydown", handleCandidatePaddingKeydown);
  $("#candidatePaddingForm").addEventListener("submit", (event) => { event.preventDefault(); void commitCandidatePadding(); });
  $("#candidatePaddingDecrease").addEventListener("click", () => changeCandidatePaddingDraft(-1));
  $("#candidatePaddingIncrease").addEventListener("click", () => changeCandidatePaddingDraft(1));
  $("#candidatePaddingReset").addEventListener("click", () => { $("#candidatePaddingInput").value = "0"; validateCandidatePadding(); $("#candidatePaddingInput").focus(); });
  $("#candidatePaddingPopover").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeCandidatePadding({ restoreFocus: true }); }
  });
  document.addEventListener("pointerdown", (event) => {
    const popover = $("#candidatePaddingPopover");
    if (!candidatePaddingSession || popover.contains(event.target) || candidatePaddingSession.trigger === event.target) return;
    if (validateCandidatePadding() === null) { event.preventDefault(); event.stopPropagation(); $("#candidatePaddingInput").focus(); return; }
    const nextTrigger = event.target.closest?.("[data-candidate-padding-id]");
    if (nextTrigger) {
      const nextId = nextTrigger.dataset.candidatePaddingId;
      event.preventDefault(); event.stopPropagation();
      void commitCandidatePadding().then(() => {
        const replacement = document.querySelector(`[data-candidate-padding-id="${CSS.escape(nextId)}"]`);
        if (replacement) openCandidatePadding(nextId, replacement);
      });
      return;
    }
    void commitCandidatePadding();
  }, true);
}

function renderCandidates() {
  const applyList = $("#candidateList");
  const excludeList = $("#exclusionList");
  applyList.textContent = ""; excludeList.textContent = "";
  if (!state.currentId) { syncCandidateDisplayButtons(); updateCandidateBatchButtons(false); return; }
  const presence = manualLayerPresence();
  if (!state.candidates.length && !state.manualMaskPresent && !presence.hasManualExclude && !presence.hasManualExclusionErase) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); applyList.append(empty); syncCandidateDisplayButtons(presence); updateCandidateBatchButtons(undefined, undefined, presence); return;
  }
  const appendEmpty = (list) => {
    if (list.children.length) return;
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); list.append(empty);
  };
  const makeToggle = (enabled, label, onChange, disabled = false) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "candidate-toggle";
    button.disabled = disabled; button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", String(enabled));
    button.textContent = t(enabled ? "settings.on" : "settings.off");
    button.addEventListener("click", onChange); return button;
  };
  const makeForceToggle = (forced, onChange, disabled = false) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "candidate-forced";
    const text = `${t("candidates.forced")} ${t(forced ? "settings.on" : "settings.off")}`;
    button.disabled = disabled; button.setAttribute("aria-pressed", String(forced)); button.setAttribute("aria-label", text);
    button.textContent = text; button.addEventListener("click", onChange); return button;
  };
  const makeDisplay = (id) => candidateDisplayToggle(id);
  const makeExpandButton = (candidate, disabled, labelText) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "candidate-padding-button";
    const value = candidate.expandPx || 0;
    button.dataset.candidatePaddingId = candidate.id; button.disabled = disabled;
    button.textContent = t("candidates.paddingButton", { value });
    const accessibleLabel = t("candidates.paddingButtonLabel", { label: labelText, value });
    button.title = accessibleLabel; button.setAttribute("aria-label", accessibleLabel);
    return button;
  };
  const appendRow = (row, label, enabled, actions) => {
    const heading = document.createElement("div"); heading.className = "candidate-row-heading"; heading.append(label, enabled);
    const actionRow = document.createElement("div"); actionRow.className = "candidate-row-actions"; actionRow.append(...actions);
    row.append(heading, actionRow);
  };
  const appendManual = (list, role) => {
    const isApply = role === "apply";
    const exists = isApply ? state.manualMaskPresent : presence.hasManualExclude;
    if (!exists) return;
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-manual ${isApply ? "candidate-row-manual-apply" : "candidate-row-manual-exclude"}`;
    const isEnabled = isApply ? state.manualEnabled : state.manualExclusionEnabled;
    row.classList.toggle("enabled", isEnabled);
    const enabled = makeToggle(isEnabled, isApply ? t("candidates.manualToggle") : t("candidates.manualExcludeToggle"), () => {
      if (isBusy() || state.importing) return;
      if (isApply) state.manualEnabled = !state.manualEnabled; else state.manualExclusionEnabled = !state.manualExclusionEnabled;
      markMaskDirty(); saveDraft();
      setReviewed(currentRecord(), false);
      refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
    }, state.projectReadOnly);
    const blinkId = `manual:${role}`;
    const blink = makeDisplay(blinkId);
    row.dataset.candidateBlinkId = blinkId; row.dataset.candidateBlinkRole = role;
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = t("candidates.manual");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×"; remove.disabled = state.projectReadOnly;
    remove.title = isApply ? t("candidates.deleteManual") : t("candidates.deleteManualExclude");
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", isApply ? deleteManualMask : deleteManualExclusion);
    if (!isApply) {
      const forced = makeForceToggle(state.manualExclusionForced, () => {
        if (isBusy() || state.importing) return;
        state.manualExclusionForced = !state.manualExclusionForced; markMaskDirty(); saveDraft();
        setReviewed(currentRecord(), false); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
      }, state.projectReadOnly);
      appendRow(row, label, enabled, [blink, candidateEffectiveToggle(blinkId), forced, remove]);
    } else appendRow(row, label, enabled, [blink, candidateEffectiveToggle(blinkId), remove]);
    list.append(row);
  };
  appendManual(applyList, "apply");
  appendManual(excludeList, "exclude");
  if (presence.hasManualExclusionErase) {
    const blinkId = "manual:excludeErase";
    const row = document.createElement("div"); row.className = "candidate-row candidate-row-manual candidate-row-manual-exclude-erase";
    row.classList.toggle("enabled", state.manualExclusionEraseEnabled);
    const enabled = makeToggle(state.manualExclusionEraseEnabled, t("candidates.manualExcludeEraseToggle"), () => {
      if (isBusy() || state.importing) return;
      state.manualExclusionEraseEnabled = !state.manualExclusionEraseEnabled; markMaskDirty();
      saveDraft();
      setReviewed(currentRecord(), false); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
    }, state.projectReadOnly);
    const blink = makeDisplay(blinkId);
    row.dataset.candidateBlinkId = blinkId; row.dataset.candidateBlinkRole = "exclude";
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = t("candidates.manual");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×"; remove.disabled = state.projectReadOnly;
    remove.title = t("candidates.deleteManualExcludeErase"); remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", deleteManualExclusionErase);
    appendRow(row, label, enabled, [blink, candidateEffectiveToggle(blinkId), remove]); excludeList.append(row);
  }
  for (const candidate of state.candidates) {
    if (state.removedCandidateIds.has(candidate.id)) continue;
    const key = candidateMutationKey(state.currentId, candidate.id);
    const deleting = state.candidateDeleting.has(key);
    const role = candidate.role === "exclude" ? "exclude" : "apply";
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-${role}`;
    row.classList.toggle("enabled", candidate.enabled);
    const labelText = candidateLabel(candidate);
    const enabled = makeToggle(candidate.enabled, t("candidates.toggle", { label: labelText }), async () => {
      if (isBusy() || state.importing) return;
      const previousEnabled = candidate.enabled;
      const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
      candidate.enabled = !candidate.enabled;
      markMaskDirty();
      setReviewed(currentRecord(), false);
      syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); render(); await updateCandidate(candidate, previousEnabled, previousMaskStatus);
    }, deleting || state.projectReadOnly || state.candidateBatchPending.has(state.currentId));
    const blink = makeDisplay(candidate.id);
    row.dataset.candidateBlinkId = candidate.id; row.dataset.candidateBlinkRole = role;
    const label = document.createElement("span"); label.className = "candidate-label";
    const name = document.createElement("span"); name.className = "candidate-class"; name.textContent = labelText;
    const confidence = document.createElement("span"); confidence.className = "candidate-conf";
    confidence.textContent = Number.isFinite(candidate.confidence) ? `${Math.round(candidate.confidence * 100)}%` : "";
    label.append(name, confidence);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×"; remove.disabled = deleting || state.projectReadOnly || state.candidateBatchPending.has(state.currentId);
    const deleteLabel = t("candidates.delete", { label: labelText });
    remove.title = deleteLabel; remove.setAttribute("aria-label", deleteLabel);
    remove.addEventListener("click", () => deleteCandidate(candidate));
    if (role === "exclude") {
      const forced = makeForceToggle(candidate.forced !== false, async () => {
        if (isBusy() || state.importing) return;
        const previousForced = candidate.forced !== false;
        const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
        candidate.forced = !previousForced; setReviewed(currentRecord(), false);
        markMaskDirty();
        syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); render();
        await updateCandidate(candidate, candidate.enabled, previousMaskStatus, previousForced);
      }, deleting || state.projectReadOnly || state.candidateBatchPending.has(state.currentId));
      appendRow(row, label, enabled, [blink, candidateEffectiveToggle(candidate.id), makeExpandButton(candidate, deleting || state.projectReadOnly || isBusy() || state.importing || state.candidateBatchPending.has(state.currentId), labelText), forced, remove]);
    } else appendRow(row, label, enabled, [blink, candidateEffectiveToggle(candidate.id), makeExpandButton(candidate, deleting || state.projectReadOnly || isBusy() || state.importing || state.candidateBatchPending.has(state.currentId), labelText), remove]);
    (role === "apply" ? applyList : excludeList).append(row);
  }
  appendEmpty(applyList); appendEmpty(excludeList);
  syncCandidateDisplayButtons(presence); updateCandidateBatchButtons(undefined, undefined, presence);
}

function candidateDisplayMode(id) {
  return state.blinkModes.get(id) || (state.blinkCandidateIds.has(id) ? "normal" : "off");
}

function candidateDisplayIdsForRole(role, presence) {
  const ids = state.candidates.filter((candidate) => candidate.role === role && !state.removedCandidateIds.has(candidate.id)).map((candidate) => candidate.id);
  if (role === "apply" && state.manualMaskPresent) ids.push("manual:apply");
  if (role === "exclude" && (presence ? presence.hasManualExclude : canvasHasPixels(exclusionCtx, exclusionCanvas))) ids.push("manual:exclude");
  if (role === "exclude" && (presence ? presence.hasManualExclusionErase : canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas))) ids.push("manual:excludeErase");
  return ids;
}

function syncCandidateDisplayButtons(presence) {
  document.querySelectorAll("[data-candidate-display-toggle]").forEach((button) => {
    const ids = candidateDisplayIdsForRole(button.dataset.candidateDisplayToggle, presence);
    const normalCount = ids.filter((id) => candidateDisplayMode(id) === "normal").length;
    button.setAttribute("aria-pressed", normalCount === ids.length && ids.length ? "true" : normalCount ? "mixed" : "false");
  });
  document.querySelectorAll("[data-candidate-effective-toggle]").forEach((button) => {
    const ids = candidateDisplayIdsForRole(button.dataset.candidateEffectiveToggle, presence);
    const effectiveCount = ids.filter((id) => candidateDisplayMode(id) === "effective").length;
    button.setAttribute("aria-pressed", effectiveCount === ids.length && ids.length ? "true" : effectiveCount ? "mixed" : "false");
  });
  document.querySelectorAll("[data-candidate-display-id]").forEach((button) => {
    button.setAttribute("aria-pressed", String(candidateDisplayMode(button.dataset.candidateDisplayId) === "normal"));
  });
  document.querySelectorAll("[data-candidate-effective-id]").forEach((button) => {
    button.setAttribute("aria-pressed", String(candidateDisplayMode(button.dataset.candidateEffectiveId) === "effective"));
  });
  const pane = $("#candidatePane");
  pane.classList.toggle("blink-active", state.blinkCandidateIds.size > 0);
  pane.classList.toggle("blink-phase", state.blinkPhase);
  document.querySelectorAll("[data-candidate-blink-id]").forEach((row) => row.classList.toggle("blink-selected", candidateDisplayMode(row.dataset.candidateBlinkId) !== "off"));
}

function clearCandidateBlink() {
  state.blinkCandidateIds.clear(); state.blinkModes.clear(); state.blinkPhase = false;
  if (state.blinkTimer) { clearInterval(state.blinkTimer); state.blinkTimer = null; }
  $("#candidatePane")?.classList.remove("blink-active", "blink-phase");
}

function syncCandidateBlinkTimer() {
  if (!state.blinkCandidateIds.size) { clearCandidateBlink(); return; }
  if (!state.blinkTimer) {
    state.blinkPhase = true;
    state.blinkTimer = setInterval(() => {
      state.blinkPhase = !state.blinkPhase;
      $("#candidatePane")?.classList.toggle("blink-phase", state.blinkPhase);
      render();
    }, 200);
  }
}

function setCandidateDisplayMode(ids, mode) {
  ids.forEach((id) => {
    if (mode === "off") { state.blinkCandidateIds.delete(id); state.blinkModes.delete(id); }
    else { state.blinkCandidateIds.add(id); state.blinkModes.set(id, mode); }
  });
  syncCandidateBlinkTimer(); syncCandidateDisplayButtons(); render();
}

function toggleCandidateDisplay(role) {
  const ids = candidateDisplayIdsForRole(role);
  if (!ids.length) return;
  const active = ids.every((id) => candidateDisplayMode(id) === "normal");
  setCandidateDisplayMode(ids, active ? "off" : "normal");
}

function toggleCandidateEffective(role) {
  const ids = candidateDisplayIdsForRole(role);
  if (!ids.length) return;
  const active = ids.every((id) => candidateDisplayMode(id) === "effective");
  setCandidateDisplayMode(ids, active ? "off" : "effective");
}

function candidateDisplayToggle(id) {
  const button = document.createElement("button"); button.type = "button"; button.className = "candidate-display-toggle";
  button.dataset.candidateDisplayId = id;
  button.textContent = t("candidates.show"); button.title = t("candidates.displayHelp"); button.setAttribute("aria-label", t("candidates.displayHelp")); button.setAttribute("aria-pressed", String(candidateDisplayMode(id) === "normal"));
  button.addEventListener("click", () => setCandidateDisplayMode([id], candidateDisplayMode(id) === "normal" ? "off" : "normal"));
  return button;
}

function candidateEffectiveToggle(id) {
  const button = document.createElement("button"); button.type = "button"; button.className = "candidate-effective-toggle";
  button.dataset.candidateEffectiveId = id;
  button.textContent = t("candidates.applied"); button.title = t("candidates.displayEffective"); button.setAttribute("aria-label", t("candidates.displayEffective")); button.setAttribute("aria-pressed", String(candidateDisplayMode(id) === "effective"));
  button.addEventListener("click", () => setCandidateDisplayMode([id], candidateDisplayMode(id) === "effective" ? "off" : "effective"));
  return button;
}

function candidateMutationKey(imageId, candidateId) { return `${imageId}:${candidateId}`; }
function clearCandidateMutationState(imageId) {
  state.candidateUpdateChains.delete(imageId);
  state.candidateBatchPending.delete(imageId);
  for (const key of state.candidateUpdateVersions.keys()) if (key.startsWith(`${imageId}:`)) state.candidateUpdateVersions.delete(key);
  for (const key of state.candidateDeleting) if (key.startsWith(`${imageId}:`)) state.candidateDeleting.delete(key);
}
function nextCandidateMutationVersion(key) {
  const version = (state.candidateUpdateVersions.get(key) || 0) + 1;
  state.candidateUpdateVersions.set(key, version);
  return version;
}
async function refreshCandidateBitmap(candidate, imageId, revision, generation, mutationKey, mutationVersion) {
  const bitmap = await fetchBitmap(maskUrl(imageId, candidate.id, revision));
  if (state.currentId !== imageId || !isCurrentGeneration(generation) || state.candidateUpdateVersions.get(mutationKey) !== mutationVersion) {
    closeBitmap(bitmap); return false;
  }
  const previous = state.candidateImages.get(candidate.id);
  state.candidateImages.set(candidate.id, bitmap);
  if (previous && previous !== bitmap) closeBitmap(previous);
  invalidateCandidateBundles(imageId);
  return true;
}
function enqueueCandidateMutation(imageId, send) {
  const previous = state.candidateUpdateChains.get(imageId) || Promise.resolve();
  const queued = previous.then(send, send);
  const tracked = queued.finally(() => {
    if (state.candidateUpdateChains.get(imageId) === tracked) state.candidateUpdateChains.delete(imageId);
    updateActionButtons();
  });
  state.candidateUpdateChains.set(imageId, tracked);
  updateActionButtons();
  return tracked;
}

async function waitForCandidateMutations() {
  while (state.candidateUpdateChains.size) {
    await Promise.allSettled([...state.candidateUpdateChains.values()]);
  }
}

async function updateCandidate(candidate, previousEnabled, previousMaskStatus, previousForced = candidate.forced, previousExpandPx = candidate.expandPx || 0) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  const targetCandidates = [...state.candidates];
  const mutationKey = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(mutationKey);
  const desired = candidate.enabled;
  const desiredForced = candidate.forced;
  const desiredExpandPx = candidate.expandPx || 0;
  const send = async () => {
    try {
      const result = await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, {
        method: "POST", body: JSON.stringify({ enabled: desired, color: candidate.color, ...(desiredExpandPx !== previousExpandPx ? { expandPx: desiredExpandPx } : {}), ...(candidate.role === "exclude" ? { forced: desiredForced } : {}) }),
      });
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      if (desiredExpandPx !== previousExpandPx && !await refreshCandidateBitmap(candidate, imageId, result.candidateRevision, generation, mutationKey, version)) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        const currentCandidate = state.candidates.find((item) => item.id === candidate.id);
        if (currentCandidate) { currentCandidate.enabled = desired; currentCandidate.forced = desiredForced; currentCandidate.expandPx = desiredExpandPx; }
        retainCurrentCandidateBundle(imageId, result.candidateRevision);
        syncCurrentCandidateRecord(); refreshMaskStatus(true); requestMosaicPreview(); renderCandidates(); render();
      } else {
        try { await refreshCandidateRecord(imageId, true); } catch { /* Keep the optimistic aggregate until a later refresh. */ }
        renderCatalogViews();
      }
    } catch (error) {
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        try {
          if (await reconcileCurrentCandidates(imageId, generation)) {
            showUserError(error);
            return;
          }
        } catch {
          if (state.currentId === imageId && isCurrentGeneration(generation)) {
            candidate.enabled = previousEnabled; candidate.forced = previousForced; candidate.expandPx = previousExpandPx; syncCurrentCandidateRecord(); refreshMaskStatus(true); requestMosaicPreview(); renderCandidates(); render();
            showUserError(error);
            return;
          }
        }
      }
      candidate.enabled = previousEnabled; candidate.forced = previousForced; candidate.expandPx = previousExpandPx;
      syncCandidateRecord(imageId, targetCandidates);
      if (previousMaskStatus !== undefined) state.maskStatus.set(imageId, previousMaskStatus);
      try {
        await refreshCandidateRecord(imageId, true);
      } catch { /* The local rollback already removed the optimistic aggregate. */ }
      renderCatalogViews();
    }
  };
  return enqueueCandidateMutation(imageId, send);
}

async function deleteCandidate(candidate) {
  if (!state.currentId || isBusy() || state.importing) return;
  if (confirmationRequired("candidateDelete") && !await confirmAction(t("confirm.candidateDelete.title"), t("confirm.candidateDelete.message"), "candidateDelete")) return;
  state.removedCandidateIds.add(candidate.id);
  setCandidateDisplayMode([candidate.id], "off");
  recordHistoryOperation({ kind: "removeCandidates", ids: [candidate.id] });
  markMaskDirty(); setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); saveDraft(); renderCandidates(); render(); renderCatalogViews();
}

function deleteManualMask() {
  if (!state.manualMaskPresent || isBusy() || state.importing) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  state.manualMaskPresent = false; state.manualEnabled = true;
  setCandidateDisplayMode(["manual:apply"], "off");
  setReviewed(currentRecord(), false);
  recordHistoryOperation({ kind: "clearManual", role: "apply" }); markMaskDirty(); markDraftDirty("add"); saveDraft(); requestMosaicPreview(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function deleteManualExclusion() {
  if (!canvasHasPixels(exclusionCtx, exclusionCanvas) || isBusy() || state.importing) return;
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  state.manualExclusionEnabled = true;
  setCandidateDisplayMode(["manual:exclude"], "off");
  setReviewed(currentRecord(), false);
  recordHistoryOperation({ kind: "clearManual", role: "exclude" }); markMaskDirty(); markDraftDirty("exclusion"); saveDraft(); requestMosaicPreview(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function deleteManualExclusionErase() {
  if (!canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas) || isBusy() || state.importing) return;
  exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
  state.manualExclusionEraseEnabled = true;
  setCandidateDisplayMode(["manual:excludeErase"], "off");
  setReviewed(currentRecord(), false);
  recordHistoryOperation({ kind: "clearManual", role: "excludeErase" }); markMaskDirty(); markDraftDirty("exclusionErase"); saveDraft(); requestMosaicPreview(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function shouldBlinkNewManual(role) {
  const ids = state.candidates.filter((candidate) => candidate.role === role && !state.removedCandidateIds.has(candidate.id)).map((candidate) => candidate.id);
  return ids.length > 0 && ids.every((id) => state.blinkCandidateIds.has(id));
}

async function batchCandidateOperation(spec) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  if (!imageId || isBusy() || state.importing || state.candidateBatchPending.has(imageId)) return;
  let [role, operation] = spec.split(":");
  const manual = role === "apply" ? state.manualMaskPresent : canvasHasPixels(exclusionCtx, exclusionCanvas);
  const manualErase = role === "exclude" && canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas);
  if (operation === "toggle") {
    const enabled = state.candidates.filter((item) => item.role === role && !state.removedCandidateIds.has(item.id)).map((item) => item.enabled);
    if (manual) enabled.push(role === "apply" ? state.manualEnabled : state.manualExclusionEnabled);
    if (manualErase) enabled.push(state.manualExclusionEraseEnabled);
    operation = enabled.length && enabled.every(Boolean) ? "disable" : "enable";
  }
  if (operation === "delete" && confirmationRequired("candidateRoleDelete") && !await confirmAction(t("confirm.candidateRoleDelete.title"), t("confirm.candidateRoleDelete.message"), "candidateRoleDelete")) return;
  if (state.currentId !== imageId || !isCurrentGeneration(generation) || state.candidateBatchPending.has(imageId)) return;
  const changed = state.candidates.filter((item) => item.role === role && !state.removedCandidateIds.has(item.id));
  if (operation === "delete") {
    const ids = changed.map((item) => item.id);
    setCandidateDisplayMode(ids, "off");
    ids.forEach((id) => state.removedCandidateIds.add(id));
    if (ids.length) recordHistoryOperation({ kind: "removeCandidates", ids });
    markMaskDirty(); setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); saveDraft(); renderCandidates(); render(); renderCatalogViews();
    return;
  }
  state.candidateBatchPending.add(imageId);
  const send = async () => {
    try {
      const result = await api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageId, role, operation }) });
      if (state.currentId !== imageId || !isCurrentGeneration(generation)) {
        await refreshCandidateRecord(imageId, true);
        renderCatalogViews();
        return;
      }
      changed.forEach((item) => { item.enabled = operation === "enable"; });
      markMaskDirty();
      if (manual) {
        if (role === "apply") state.manualEnabled = operation === "enable";
        else state.manualExclusionEnabled = operation === "enable";
        markMaskDirty();
      }
      if (manualErase) { state.manualExclusionEraseEnabled = operation === "enable"; markMaskDirty(); }
      if (manual || manualErase) saveDraft();
      retainCurrentCandidateBundle(imageId, result.candidateRevision);
      setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
    } catch (error) {
      if (state.currentId === imageId && isCurrentGeneration(generation)) showUserError(error);
    } finally {
      state.candidateBatchPending.delete(imageId);
      if (state.currentId === imageId && isCurrentGeneration(generation)) renderCandidates();
      updateActionButtons();
    }
  };
  const queued = enqueueCandidateMutation(imageId, send);
  renderCandidates();
  return queued;
}

async function addBoundaryCandidate() {
  if (!canDetectBoundary()) return;
  const imageId = state.currentId;
  const viewGeneration = state.imageGeneration;
  const requests = boundaryRequests();
  let catalogChanged = false;
  const createdCandidateIds = [];
  state.boundaryPending = true; updateBoundaryActions(); updateActionButtons(); setStatusKey("status.boundaryDetecting", {}, "running");
  try {
    for (const request of requests) {
      const body = request.draft.type === "polygon"
        ? { imageId, points: request.draft.points.map((point) => ({ ...point })) }
        : { imageId, roi: request.draft.roi, point: request.draft.point || pointForRoi(request.draft.roi) };
      let data;
      try {
        data = await api("/api/boundary", { method: "POST", body: JSON.stringify(body) });
      } catch (error) {
        if (state.currentId === imageId && state.imageGeneration === viewGeneration) showUserError(error);
        break;
      }
      const created = Array.isArray(data.candidates) ? data.candidates : [];
      if (!created.length || !Number.isInteger(data.candidateRevision)) {
        if (state.currentId === imageId && state.imageGeneration === viewGeneration) showUserError("internal_error");
        break;
      }
      createdCandidateIds.push(...created.map((candidate) => candidate.id));
      const record = state.images.find((item) => item.id === imageId);
      if (record) {
        record.candidateCount = (record.candidateCount || 0) + created.length;
        record.enabledCandidateCount = (record.enabledCandidateCount || 0) + created.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
        record.candidateRevision = data.candidateRevision;
        state.maskStatus.set(imageId, true);
      }
      state.boundaryDrafts = state.boundaryDrafts.filter((draft) => !request.draftIds.includes(draft.id));
      state.boundaryActiveId = state.boundaryDrafts.at(-1)?.id || null;
      invalidateCandidateBundles(imageId); catalogChanged = true;
    }
    if (catalogChanged) {
      markImagesUnreviewed([imageId], false);
      if (state.currentId === imageId && state.imageGeneration === viewGeneration) {
        await reconcileCurrentCandidates(imageId, viewGeneration);
        if (createdCandidateIds.length) { recordHistoryOperation({ kind: "addCandidates", ids: createdCandidateIds }); saveDraft(); }
        if (!state.boundaryDrafts.length) setStatusKey("status.boundaryDone");
      }
    }
  } catch (error) {
    if (state.currentId === imageId && state.imageGeneration === viewGeneration) showUserError(error);
  } finally {
    state.boundaryPending = false;
    if (catalogChanged) renderCatalogViews();
    updateBoundaryActions(); updateActionButtons();
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function pointFromEvent(event) { const rect = canvas.getBoundingClientRect(); const side = state.gestureDisplaySide ?? compareEventSide(event, rect); const offset = compareSideOffset(side, rect.width); return { x: (event.clientX - rect.left - offset - state.view.x) / state.view.scale, y: (event.clientY - rect.top - state.view.y) / state.view.scale }; }
function clampPoint(point) {
  if (!state.currentImage) return point;
  return {
    x: Math.min(state.currentImage.width, Math.max(0, point.x)),
    y: Math.min(state.currentImage.height, Math.max(0, point.y)),
  };
}
function boundaryDragStarted(event) {
  return Boolean(state.boundaryStartClient) && Math.hypot(
    event.clientX - state.boundaryStartClient.x,
    event.clientY - state.boundaryStartClient.y,
  ) >= 3;
}
function polygonVertexAt(point) {
  const radius = Math.max(8, 12 / Math.max(state.view.scale, 0.1));
  return state.polygonPoints.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= radius);
}
function completedPolygonVertexAt(point) {
  const radius = Math.max(8, 12 / Math.max(state.view.scale, 0.1));
  for (const draft of [...state.boundaryDrafts].reverse()) {
    if (draft.type !== "polygon") continue;
    const index = draft.points.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= radius);
    if (index >= 0) return { draft, index };
  }
  return null;
}
function rectangleDraftAt(point) {
  return [...state.boundaryDrafts].reverse().find((draft) => draft.type === "rectangle"
    && point.x >= draft.roi.left && point.x < draft.roi.right
    && point.y >= draft.roi.top && point.y < draft.roi.bottom) || null;
}
function cancelBoundary() {
  clearBoundaryInteraction(); render();
}
function copyCanvas(source, target) {
  target.width = source.width; target.height = source.height;
  target.getContext("2d").drawImage(source, 0, 0);
}

function updateHistoryButtons() {
  if (state.project?.id) {
    const history = state.projectHistory.get(state.currentId) || {};
    $("#undoButton").disabled = state.projectReadOnly || state.projectHistoryBusy || history.canUndo !== true;
    $("#redoButton").disabled = state.projectReadOnly || state.projectHistoryBusy || history.canRedo !== true;
    return;
  }
  $("#undoButton").disabled = state.historyIndex <= 0;
  $("#redoButton").disabled = state.historyIndex >= state.history.length;
}

function resetHistoryToCurrentManualMask() {
  if (!state.currentImage) return;
  if (typeof ensureHistoryCanvases === "function") ensureHistoryCanvases();
  copyCanvas(addCanvas, historyAddCanvas); copyCanvas(exclusionCanvas, historyExclusionCanvas); copyCanvas(exclusionEraseCanvas, historyExclusionEraseCanvas);
  state.historyRemovedCandidateIds = new Set(state.removedCandidateIds || []);
  state.historyCandidateIds = new Set(state.candidates.map((candidate) => candidate.id));
  state.historyBaseDirty = true;
  state.history = []; state.historyIndex = 0; state.activeStroke = null; updateHistoryButtons();
}

function strokeLine(context, from, to, size, operation = "source-over") {
  context.save(); context.globalCompositeOperation = operation; context.strokeStyle = "#ffffff"; context.lineWidth = size; context.lineCap = "round";
  context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); context.restore();
}

function strokePath(context, points, size, operation = "source-over") {
  const [first, ...rest] = points;
  context.save(); context.globalCompositeOperation = operation; context.strokeStyle = "#ffffff"; context.lineWidth = size; context.lineCap = "round";
  context.beginPath(); context.moveTo(first.x, first.y);
  if (rest.length) for (const point of rest) context.lineTo(point.x, point.y);
  else context.lineTo(first.x, first.y);
  context.stroke(); context.restore();
}

function paintStrokeOnContexts(addContext, exclusionContext, exclusionEraseContext, from, to, tool, size) {
  if (tool === "mosaic_eraser") { strokeLine(addContext, from, to, size + 2, "destination-out"); return; }
  if (tool === "exclude_eraser") { strokeLine(exclusionEraseContext, from, to, size); return; }
  if (tool === "eraser") {
    strokeLine(exclusionContext, from, to, size);
    strokeLine(exclusionEraseContext, from, to, size, "destination-out");
    return;
  }
  strokeLine(addContext, from, to, size);
  if (!state.manualExclusionForced) strokeLine(exclusionContext, from, to, size, "destination-out");
}

function strokeDirtyRoi(points, tool, size) {
  if (!points?.length || !state.currentImage) return null;
  const radius = (tool === "mosaic_eraser" ? size + 2 : size) / 2 + 1;
  let left = points[0].x; let right = points[0].x; let top = points[0].y; let bottom = points[0].y;
  for (const point of points) { left = Math.min(left, point.x); right = Math.max(right, point.x); top = Math.min(top, point.y); bottom = Math.max(bottom, point.y); }
  const block = Math.max(1, Number(calculatedBlockSize()));
  return {
    left: Math.max(0, Math.floor((left - radius) / block) * block),
    top: Math.max(0, Math.floor((top - radius) / block) * block),
    right: Math.min(originalCanvas.width, Math.ceil((right + radius) / block) * block),
    bottom: Math.min(originalCanvas.height, Math.ceil((bottom + radius) / block) * block),
  };
}

function refreshManualStrokeRoi(roi) {
  if (!roi) return;
  composeCurrentMask(roi);
  requestMosaicPreview(roi);
}

function paintStroke(from, to, tool, size) {
  paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, from, to, tool, size);
  markStrokeDirty(tool, [from, to], size);
}

function markStrokeDirty(tool, points = null, size = Number($("#brushSize").value)) {
  const roi = points?.length ? strokeDirtyRoi(points, tool, size) : null;
  markMaskDirty();
  if (tool === "brush" || tool === "mosaic_eraser") markDraftDirtyRoi("add", roi);
  if (tool === "brush" && !state.manualExclusionForced) markDraftDirtyRoi("exclusion", roi);
  if (tool === "eraser") { markDraftDirtyRoi("exclusion", roi); markDraftDirtyRoi("exclusionErase", roi); }
  if (tool === "exclude_eraser") markDraftDirtyRoi("exclusionErase", roi);
  if (state.activeStroke) refreshManualStrokeRoi(roi);
}

function paintStrokePath(points, tool, size) {
  if (tool === "mosaic_eraser") strokePath(addCtx, points, size + 2, "destination-out");
  else if (tool === "exclude_eraser") strokePath(exclusionEraseCtx, points, size);
  else if (tool === "eraser") { strokePath(exclusionCtx, points, size); strokePath(exclusionEraseCtx, points, size, "destination-out"); }
  else { strokePath(addCtx, points, size); if (!state.manualExclusionForced) strokePath(exclusionCtx, points, size, "destination-out"); }
  markStrokeDirty(tool, points, size);
}

function fillAt(point, tool = state.tool) {
  if (!state.currentImage) return;
  enableManualLayerForTool(tool);
  const width = originalCanvas.width; const height = originalCanvas.height;
  const pixels = originalCtx.getImageData(0, 0, width, height).data;
  const x = Math.min(width - 1, Math.max(0, Math.floor(point.x))); const y = Math.min(height - 1, Math.max(0, Math.floor(point.y)));
  const tolerance = state.settings.editing.fill_color_tolerance;
  const generation = state.imageGeneration; const epoch = state.catalogEpoch; const imageId = state.currentId; const record = currentRecord(); const version = imageAssetVersion(record); const revision = Number(record?.candidateRevision || 0);
  const apply = (spans) => {
    if (!catalogRecordMatches(record, epoch, { version, revision }) || !isCurrentGeneration(generation) || state.currentId !== imageId) { state.fillPending = false; return; }
    applyFillSpans(spans, tool); state.history.splice(state.historyIndex); state.history.push({ tool, spans }); trimHistory();
    state.historyIndex = state.history.length;
    if (tool === "bucket") state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
    state.fillPending = false; scheduleManualWorkspaceSave(); setReviewed(currentRecord(), false); updateHistoryButtons(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
  };
  if (typeof Worker !== "function") { showUserError("internal_error"); return; }
  state.fillWorker?.terminate?.(); state.fillPending = true;
  let worker;
  try { worker = state.fillWorker = new Worker("/js/flood-fill-worker.js"); }
  catch { state.fillPending = false; showUserError("internal_error"); return; }
  worker.onmessage = ({ data }) => { if (state.fillWorker !== worker) return; state.fillWorker = null; worker.terminate(); apply(data.spans); };
  worker.onerror = () => { if (state.fillWorker === worker) { state.fillWorker = null; state.fillPending = false; showUserError("internal_error"); } worker.terminate(); };
  worker.postMessage({ pixels: pixels.buffer, width, height, x, y, tolerance }, [pixels.buffer]);
}

function paintFillSpans(addContext, exclusionContext, exclusionEraseContext, spans, tool = "bucket") {
  const target = tool === "exclude_eraser" ? exclusionEraseContext : (tool === "eraser" || tool === "exclude_bucket" ? exclusionContext : addContext);
  target.save(); target.globalCompositeOperation = "source-over"; target.fillStyle = "#ffffff";
  if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.save();
  if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.globalCompositeOperation = "destination-out";
  else if (!state.manualExclusionForced && tool === "bucket") exclusionContext.save(), exclusionContext.globalCompositeOperation = "destination-out";
  for (let index = 0; index < spans.length; index += 3) {
    const row = spans[index]; const start = spans[index + 1]; const width = spans[index + 2] - start;
    target.fillRect(start, row, width, 1);
    if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.fillRect(start, row, width, 1);
    else if (!state.manualExclusionForced && tool === "bucket") exclusionContext.fillRect(start, row, width, 1);
  }
  target.restore();
  if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.restore();
  else if (!state.manualExclusionForced && tool === "bucket") exclusionContext.restore();
  let left = originalCanvas.width, top = originalCanvas.height, right = 0, bottom = 0;
  for (let index = 0; index < spans.length; index += 3) {
    left = Math.min(left, spans[index + 1]); top = Math.min(top, spans[index]);
    right = Math.max(right, spans[index + 2]); bottom = Math.max(bottom, spans[index] + 1);
  }
  const roi = spans.length ? { left, top, right, bottom } : null;
  if (tool === "bucket") { markDraftDirtyRoi("add", roi); if (!state.manualExclusionForced) markDraftDirtyRoi("exclusion", roi); }
  if (tool === "eraser" || tool === "exclude_bucket") { markDraftDirtyRoi("exclusion", roi); markDraftDirtyRoi("exclusionErase", roi); }
  if (tool === "exclude_eraser") markDraftDirtyRoi("exclusionErase", roi);
}

function applyFillSpans(spans, tool = "bucket") {
  paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, spans, tool); markMaskDirty(); flushMaskComposition();
}

function drawStroke(from, to, tool, size = Number($("#brushSize").value)) {
  paintStroke(from, to, tool, size);
}

function enableManualLayerForTool(tool) {
  if (["brush", "mosaic_eraser", "bucket"].includes(tool) && !state.manualEnabled) state.manualEnabled = true;
  if (["eraser", "exclude_bucket"].includes(tool) && !state.manualExclusionEnabled) state.manualExclusionEnabled = true;
  if (tool === "exclude_eraser" && !state.manualExclusionEraseEnabled) state.manualExclusionEraseEnabled = true;
}

function beginManualStroke(point) {
  enableManualLayerForTool(state.tool);
  state.activeStroke = { tool: state.tool, size: Number($("#brushSize").value), points: [{ ...point }], paintedPointCount: 1 };
  state.mosaicPending = true;
  if (state.tool === "brush" && shouldBlinkNewManual("apply")) setCandidateDisplayMode(["manual:apply"], "normal");
  if (state.tool === "eraser" && shouldBlinkNewManual("exclude")) setCandidateDisplayMode(["manual:exclude"], "normal");
  const excludeDisplayIds = state.tool === "exclude_eraser" ? candidateDisplayIdsForRole("exclude") : [];
  if (state.tool === "exclude_eraser" && excludeDisplayIds.length && excludeDisplayIds.every((id) => candidateDisplayMode(id) === "normal")) setCandidateDisplayMode(["manual:excludeErase"], "normal");
  drawStroke(point, point, state.tool, state.activeStroke.size);
  requestMosaicPreview();
}

function appendManualStrokePoint(point) {
  if (!state.activeStroke) return;
  state.activeStroke.points.push({ ...point });
  if (state.manualStrokePaintFrame) return;
  state.manualStrokePaintFrame = requestAnimationFrame(() => { state.manualStrokePaintFrame = 0; paintPendingManualStroke(); });
}

function paintPendingManualStroke() {
  const stroke = state.activeStroke;
  if (!stroke || stroke.paintedPointCount >= stroke.points.length) return;
  paintStrokePath(stroke.points.slice(stroke.paintedPointCount - 1), stroke.tool, stroke.size);
  stroke.paintedPointCount = stroke.points.length;
  requestMosaicPreview();
}

function cancelManualStroke() {
  if (!state.activeStroke) return;
  if (state.manualStrokePaintFrame) cancelAnimationFrame(state.manualStrokePaintFrame);
  state.manualStrokePaintFrame = 0;
  state.activeStroke = null;
  rebuildManualMaskFromHistory();
  requestMosaicPreview(); renderCandidates(); render();
}

function replayManualStroke(stroke, addContext = addCtx, exclusionContext = exclusionCtx, exclusionEraseContext = exclusionEraseCtx) {
  if (stroke.kind === "removeCandidates") { stroke.ids.forEach((id) => state.removedCandidateIds.add(id)); return; }
  if (stroke.kind === "restoreCandidates") { stroke.ids.forEach((id) => state.removedCandidateIds.delete(id)); return; }
  if (stroke.kind === "addCandidates") { stroke.ids.forEach((id) => state.removedCandidateIds.delete(id)); return; }
  if (stroke.kind === "clearManual") { const target = stroke.role === "apply" ? addContext : (stroke.role === "exclude" ? exclusionContext : exclusionEraseContext); target.clearRect(0, 0, target.canvas.width, target.canvas.height); return; }
  if (["bucket", "exclude_bucket"].includes(stroke.tool)) { paintFillSpans(addContext, exclusionContext, exclusionEraseContext, stroke.spans, stroke.tool); return; }
  const points = stroke.points;
  if (!points.length) return;
  paintStrokeOnContexts(addContext, exclusionContext, exclusionEraseContext, points[0], points[0], stroke.tool, stroke.size);
  for (let index = 1; index < points.length; index += 1) {
    paintStrokeOnContexts(addContext, exclusionContext, exclusionEraseContext, points[index - 1], points[index], stroke.tool, stroke.size);
  }
}

function historyWeight(stroke) { return stroke.spans?.byteLength || (stroke.spans?.length || 0) * 4 || (stroke.points?.length || 0) * 16; }
function trimHistory() {
  // Project history is durable.  The user can explicitly clear it later;
  // silently dropping older edits makes Ctrl+Z unreliable after a restart.
}

function recordHistoryOperation(operation) {
  state.history.splice(state.historyIndex);
  state.history.push(operation); trimHistory(); state.historyIndex = state.history.length;
  updateHistoryButtons();
}

function rebuildManualMaskFromHistory() {
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
  addCtx.drawImage(historyAddCanvas, 0, 0); exclusionCtx.drawImage(historyExclusionCanvas, 0, 0); exclusionEraseCtx.drawImage(historyExclusionEraseCanvas, 0, 0);
  state.removedCandidateIds = new Set(state.historyRemovedCandidateIds || []);
  for (const candidate of state.candidates) if (!(state.historyCandidateIds || new Set()).has(candidate.id)) state.removedCandidateIds.add(candidate.id);
  for (const stroke of state.history.slice(0, state.historyIndex)) replayManualStroke(stroke);
  markMaskDirty(); markDraftDirty("add", "exclusion", "exclusionErase");
}

function completeManualStroke() {
  const stroke = state.activeStroke;
  if (state.manualStrokePaintFrame) cancelAnimationFrame(state.manualStrokePaintFrame);
  state.manualStrokePaintFrame = 0;
  paintPendingManualStroke();
  state.activeStroke = null;
  if (!stroke?.points?.length) return;
  state.history.splice(state.historyIndex);
  state.history.push(stroke);
  trimHistory();
  state.historyIndex = state.history.length;
  state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
  // The live ROI previews are intentionally provisional: after pointerup,
  // rebuild the whole mask once so every exclusion and candidate is exact
  // before history/workspace persistence and the final preview.
  state.maskDirty = true;
  flushMaskComposition();
  scheduleManualWorkspaceSave();
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates();
}

async function refreshProjectHistory(imageId = state.currentId) {
  if (!state.project?.id || !imageId) return;
  try {
    const history = await api(`/api/project/history/${encodeURIComponent(imageId)}`);
    state.projectHistory.set(imageId, { canUndo: history.canUndo === true, canRedo: history.canRedo === true });
    if (imageId === state.currentId) updateHistoryButtons();
  } catch (error) { showUserError(error); }
}

async function restoreProjectHistory(direction) {
  const imageId = state.currentId;
  if (!state.project?.id || !imageId || state.projectReadOnly || state.projectHistoryBusy || isBusy() || state.importing) return;
  const history = state.projectHistory.get(imageId) || {};
  if ((direction === "undo" && !history.canUndo) || (direction === "redo" && !history.canRedo)) return;
  state.projectHistoryBusy = true; updateHistoryButtons();
  try {
    await flushWorkspaceDraft(imageId);
    const result = await api(`/api/project/history/${encodeURIComponent(imageId)}/${direction}`, { method: "POST", body: "{}" });
    const changed = new Set(result.changedImageIds || []);
    for (const changedId of changed) {
      state.drafts.delete(changedId); state.projectHistory.delete(changedId); releaseCandidateBundles(changedId);
      const record = state.images.find((image) => image.id === changedId);
      if (record && changedId === imageId && result.current) record.candidateRevision = Number(result.current.candidateRevision || 0);
    }
    state.projectHistory.set(imageId, { canUndo: result.canUndo === true, canRedo: result.canRedo === true });
    const snapshot = await api("/api/images");
    state.images = snapshot.images || state.images; applyProjectSnapshot(snapshot); if (typeof renderCatalogViews === "function") renderCatalogViews();
    if (changed.has(imageId)) await selectImage(imageId, true, { saveCurrentDraft: false });
    else updateHistoryButtons();
  } catch (error) { showUserError(error); }
  finally { state.projectHistoryBusy = false; updateHistoryButtons(); }
}

function restoreSnapshot(index) {
  if (state.project?.id) { void restoreProjectHistory(index < state.historyIndex ? "undo" : "redo"); return; }
  if (isBusy() || state.importing || index < 0 || index > state.history.length) return;
  const restoreToken = ++state.historyRestoreToken;
  state.historyIndex = index;
  rebuildManualMaskFromHistory();
  scheduleManualWorkspaceSave();
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); renderCandidates(); render();
  requestAnimationFrame(() => {
    if (restoreToken !== state.historyRestoreToken) return;
    state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
    updateCandidateStatus(); refreshCurrentReviewAndMask(); requestMosaicPreview();
  });
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  flushMaskComposition();
  return combinedCanvas.toDataURL("image/png");
}
