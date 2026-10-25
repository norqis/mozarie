// Filename rotations keep every original and rendered image on disk until
// the server has committed the complete catalogue mapping.
const numberedSavePrefix = "mozarie.numbered-save.";
let numberedSaveWriteChain = Promise.resolve();

async function numberedSaveDirectory(name, create = false) {
  const root = await navigator.storage.getDirectory();
  const batches = await root.getDirectoryHandle("mozarie-numbered-saves", { create });
  return batches.getDirectoryHandle(name, { create });
}

async function numberedSaveFile(directory, name, readable) {
  const handle = await directory.getFileHandle(name, { create: true });
  await readable.pipeTo(await handle.createWritable());
}

async function numberedFileBytesMatch(left, right) {
  if (left.size !== right.size) return false;
  // Only recovery of an interrupted close needs content evidence. Normal
  // saves keep the existing metadata checks and never hash/read files twice.
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < left.size; offset += chunkSize) {
    const [a, b] = await Promise.all([left.slice(offset, offset + chunkSize).arrayBuffer(), right.slice(offset, offset + chunkSize).arrayBuffer()]);
    const bytes = new Uint8Array(a); const expected = new Uint8Array(b);
    for (let index = 0; index < bytes.length; index++) if (bytes[index] !== expected[index]) return false;
  }
  return true;
}

function storeNumberedSave(batch, member = null) {
  const write = numberedSaveWriteChain.catch(() => {}).then(async () => {
    if (member) await browserOverwriteStore(`numbered-member:${batch.id}:${member.entry.imageId}`, member);
    else {
      await browserOverwriteStore(`numbered:${batch.id}`, { ...batch, browser: [] });
      localStorage.setItem(`${numberedSavePrefix}${batch.id}`, JSON.stringify(batch.entries));
    }
  });
  numberedSaveWriteChain = write;
  return write;
}

async function numberedBatchStatus(batch) {
  return api("/api/save/status", { method: "POST", body: JSON.stringify({
    ...batch.entries[0], sourceAction: "overwrite",
  }), resyncOnStale: false });
}

async function cleanupNumberedSave(batch, committed = true) {
  try {
    const root = await navigator.storage.getDirectory();
    const batches = await root.getDirectoryHandle("mozarie-numbered-saves");
    await batches.removeEntry(batch.id, { recursive: true });
  } catch (error) { if (error?.name !== "NotFoundError") throw error; }
  await deleteNumberedSaveBatch(batch.id);
  localStorage.removeItem(`${numberedSavePrefix}${batch.id}`);
  // The first receipt decides recovery for the entire batch. Keep it until
  // both the browser journal and the on-disk backups have been removed.
  for (const entry of committed ? [...batch.entries.slice(1), batch.entries[0]] : []) {
    if (!await acknowledgePendingBrowserSave(entry.saveToken)) throw codedError("save_recovery_pending");
  }
}

async function finishNumberedSave(batch) {
  for (const member of batch.browser) {
    const file = await member.target.fileHandle.getFile();
    if (!sourceFileMatches(file, member.written?.sourceMtimeMs, member.written?.sourceSizeBytes)) throw codedError("save_recovery_pending");
    const replacement = { ...member.target, size: file.size, lastModified: file.lastModified };
    if (batch.projectId && replacement.sourceKind === "browser-files") {
      await rememberProjectSource(batch.projectId, replacement.fileHandle, member.entry.imageId,
        replacement.rememberedSourceId || replacement.sourceId, replacement.clientKey,
        replacement.relativePath, replacement.parentHandle);
    }
    const live = state.sourceAccess.get(member.entry.imageId);
    if (live) Object.assign(live, replacement);
    else state.sourceAccess.set(member.entry.imageId, replacement);
  }
  // A chain can leave an old source name outside the final target set. A
  // cycle leaves none. Compare physical handles, not just the basenames.
  const reusedSources = new Set(batch.browser.map((member) => member.existingOwner));
  for (const member of batch.browser) {
    if (reusedSources.has(member.entry.imageId)) continue;
    try {
      const current = await member.access.parentHandle.getFileHandle(member.access.fileHandle.name);
      const file = await current.getFile();
      if (!await current.isSameEntry(member.access.fileHandle)
        || !sourceFileMatches(file, member.original.sourceMtimeMs, member.original.sourceSizeBytes)) throw codedError("save_recovery_pending");
      await member.access.parentHandle.removeEntry(member.access.fileHandle.name);
    } catch (error) { if (error?.name !== "NotFoundError") throw error; }
  }
  await cleanupNumberedSave(batch);
}

async function rollbackNumberedSave(batch) {
  let directory;
  const backupFile = async (name) => {
    directory ||= await numberedSaveDirectory(batch.id);
    return (await directory.getFileHandle(name)).getFile();
  };
  const originals = new Map(batch.browser.map((member) => [member.entry.imageId, member]));
  const writers = new Map(batch.browser.filter((member) => member.started).map((member) => [member.existingOwner, member]));
  // Remove only new destination slots. Existing slots are restored below
  // from their original owner's backup, regardless of which image wrote them.
  for (const member of batch.browser) {
    if (member.creating && !member.started) {
      try { await member.target.parentHandle.getFileHandle(member.target.name); }
      catch (error) { if (error?.name === "NotFoundError") continue; throw error; }
      throw codedError("save_recovery_pending");
    }
    if (!member.started) continue;
    let file;
    try { file = await member.target.fileHandle.getFile(); }
    catch (error) { if (!member.existed && error?.name === "NotFoundError") continue; throw error; }
    const original = originals.get(member.existingOwner);
    const current = await member.target.parentHandle.getFileHandle(member.target.name);
    if (!await current.isSameEntry(member.target.fileHandle)) throw codedError("save_recovery_pending");
    if (!member.existed) { await member.target.parentHandle.removeEntry(member.target.name); continue; }
    if (original?.restoring && !original.restored) {
      const backup = await backupFile(`original-${original.entry.imageId}`);
      if (await numberedFileBytesMatch(file, backup)) {
        original.restored = sourceCommitMetadata(file);
        await storeNumberedSave(batch, original);
      }
    }
    if (original?.restored && sourceFileMatches(file, original.restored.sourceMtimeMs, original.restored.sourceSizeBytes)) continue;
    if (!member.written || !sourceFileMatches(file, member.written.sourceMtimeMs, member.written.sourceSizeBytes)) {
      if (member.before && sourceFileMatches(file, member.before.sourceMtimeMs, member.before.sourceSizeBytes)) continue;
      if (member.written) throw codedError("save_recovery_pending");
      const output = await backupFile(`rendered-${member.entry.imageId}`);
      if (!await numberedFileBytesMatch(file, output)) throw codedError("save_recovery_pending");
      member.written = sourceCommitMetadata(file);
      await storeNumberedSave(batch, member);
    }
  }
  for (const original of batch.browser) {
    const writer = writers.get(original.entry.imageId);
    if (!writer?.written || original.restored) continue;
    const current = await original.access.parentHandle.getFileHandle(original.access.fileHandle.name);
    const file = await current.getFile();
    if (!await current.isSameEntry(original.access.fileHandle)
      || !sourceFileMatches(file, writer.written.sourceMtimeMs, writer.written.sourceSizeBytes)) throw codedError("save_recovery_pending");
    const backup = await backupFile(`original-${original.entry.imageId}`);
    original.restoring = true;
    await storeNumberedSave(batch, original);
    await writeSourceHandle(original.access, new Response(backup.stream()));
    original.restored = sourceCommitMetadata(original.access);
    await storeNumberedSave(batch, original);
  }
  await api("/api/save/batch/abort", { method: "POST", body: JSON.stringify({ saveToken: batch.id }), resyncOnStale: false });
  for (const entry of batch.entries) {
    const original = originals.get(entry.imageId);
    if (original?.restored) {
      await api("/api/save/cancel", { method: "POST", body: JSON.stringify({ ...entry, restoredSource: {
        workspaceId: batch.workspaceId, sourceId: original.image.sourceId, relativePath: original.image.relativePath,
        originalMtimeMs: original.original.sourceMtimeMs, originalSizeBytes: original.original.sourceSizeBytes,
        ...original.restored,
      } }), resyncOnStale: false });
      const live = state.sourceAccess.get(entry.imageId);
      if (live) Object.assign(live, original.access);
      else state.sourceAccess.set(entry.imageId, original.access);
      const image = state.images.find((item) => item.id === entry.imageId);
      if (image) { image.mtimeNs = original.restored.sourceMtimeMs * 1000000; image.sizeBytes = original.restored.sourceSizeBytes; }
    } else if (!await cancelBrowserSave(entry, entry.saveToken)) throw codedError("save_recovery_pending");
    if (original && !state.sourceAccess.has(entry.imageId)) state.sourceAccess.set(entry.imageId, original.access);
    forgetPendingSave(entry.saveToken);
  }
  await cleanupNumberedSave(batch, false);
}

async function reconcileNumberedSaves() {
  const skipped = new Set();
  const batches = await numberedSaveBatches();
  const recover = async () => { for (const batch of batches) {
    const entries = batch.entries;
    entries.forEach((entry) => skipped.add(entry.saveToken));
    try {
      const status = await numberedBatchStatus(batch);
      if (status.state === "committed") await finishNumberedSave(batch);
      else await rollbackNumberedSave(batch);
      entries.forEach((entry) => skipped.delete(entry.saveToken));
    } catch { /* Keep the complete recovery record when permissions or the server are unavailable. */ }
  } };
  if (navigator.locks?.request) {
    await navigator.locks.request(browserSaveOwnershipLock, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (lock) await recover();
      else batches.forEach((batch) => batch.entries.forEach((entry) => skipped.add(entry.saveToken)));
    });
  } else if (!state.saving) await recover();
  return skipped;
}

async function runNumberedOverwriteBatch(inputs, save) {
  const entries = save.entries.map((entry) => ({ ...entry, saveToken: newClientSaveToken() }));
  const batch = { id: entries[0].saveToken, projectId: inputs.projectId, workspaceId: state.workspaceId, entries, browser: [] };
  let directory = null;
  let index = 0;
  try {
    await storeNumberedSave(batch);
    const rendered = await Promise.allSettled(Array.from({ length: Math.min(inputs.parallelism, save.entries.length) }, async () => {
      while (await waitForBrowserSave(save)) {
        const entry = batch.entries[index++];
        if (!entry) return;
        const source = inputs.sources.get(entry.imageId);
        showBrowserSaveProgress(save, entry);
        const response = await renderStreamedSave(entry, {
          imageId: entry.imageId, candidateRevision: entry.candidateRevision, expectedManualRevision: source.manualRevision,
          divisor: inputs.divisor, draft: inputs.drafts.get(entry.imageId) || null,
          format: inputs.format, keepMetadata: inputs.keepMetadata, batchOverwrite: true, streamImage: Boolean(source.access?.fileHandle),
        }, entry.saveToken);
        if (source.access?.fileHandle) {
          directory ||= await numberedSaveDirectory(batch.id, true);
          await numberedSaveFile(directory, `rendered-${entry.imageId}`, response.body);
          await ensureHandlePermission(source.access, true);
          const original = await source.access.fileHandle.getFile();
          if (!sourceFileMatches(original, sourceCommitMetadata(source.access).sourceMtimeMs, source.access.size)) throw codedError("save_state_changed");
          await numberedSaveFile(directory, `original-${entry.imageId}`, original.stream());
          const after = await source.access.fileHandle.getFile();
          if (!sourceFileMatches(after, Math.round(original.lastModified), original.size)) throw codedError("save_state_changed");
          const member = { entry, image: source.image, access: { ...source.access }, original: sourceCommitMetadata(after) };
          batch.browser.push(member);
          await storeNumberedSave(batch, member);
        }
      }
    }));
    const failed = rendered.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    if (save.cancelled) { await storeNumberedSave(batch); await rollbackNumberedSave(batch); return; }
    // Keep API order stable even when rendering workers finish out of order.
    const originalsByName = new Map();
    for (const original of batch.browser) {
      const name = original.access.fileHandle.name.toLowerCase();
      const bucket = originalsByName.get(name) || [];
      bucket.push(original); originalsByName.set(name, bucket);
    }
    for (const member of batch.browser) {
      const name = member.entry.outputFilename;
      let handle;
      try { handle = await member.access.parentHandle.getFileHandle(name); member.existed = true; }
      catch (error) {
        if (error?.name !== "NotFoundError") throw error;
        member.existed = false;
      }
      if (handle) {
        for (const original of originalsByName.get(name.toLowerCase()) || []) if (await handle.isSameEntry(original.access.fileHandle)) member.existingOwner = original.entry.imageId;
        if (!member.existingOwner) throw codedError("output_files_exist", { files: name });
        member.before = sourceCommitMetadata(await handle.getFile());
      }
      member.target = { ...member.access, fileHandle: handle || null, name,
        relativePath: member.access.relativePath.split("/").slice(0, -1).concat(name).join("/") };
      await storeNumberedSave(batch, member);
    }
    await storeNumberedSave(batch);
    await api("/api/save/batch/prepare", { method: "POST", body: JSON.stringify({ entries: batch.entries }) });
    // After the first source write the batch must finish or roll back; cancel
    // and pause no longer interrupt this short publication phase.
    for (const member of batch.browser) {
      if (!member.existed) {
        member.creating = true;
        await storeNumberedSave(batch, member);
        try { await member.target.parentHandle.getFileHandle(member.target.name); throw codedError("output_files_exist", { files: member.target.relativePath }); }
        catch (error) { if (error?.name !== "NotFoundError") throw error; }
        member.target.fileHandle = await member.target.parentHandle.getFileHandle(member.target.name, { create: true });
        member.before = sourceCommitMetadata(await member.target.fileHandle.getFile());
        if (member.before.sourceSizeBytes !== 0) throw codedError("output_files_exist", { files: member.target.relativePath });
      } else {
        const current = await member.target.parentHandle.getFileHandle(member.target.name);
        const file = await current.getFile();
        if (!await current.isSameEntry(member.target.fileHandle)
          || !sourceFileMatches(file, member.before.sourceMtimeMs, member.before.sourceSizeBytes)) throw codedError("save_state_changed");
      }
      member.started = true;
      await storeNumberedSave(batch, member);
      const output = await (await directory.getFileHandle(`rendered-${member.entry.imageId}`)).getFile();
      await writeSourceHandle(member.target, new Response(output.stream()));
      member.written = sourceCommitMetadata(member.target);
      member.entry.sourceMetadata = member.written;
      await storeNumberedSave(batch, member);
    }
    await api("/api/save/batch/commit", { method: "POST", body: JSON.stringify({ entries: batch.entries }) });
    await finishNumberedSave(batch);
    save.completed = save.entries.length;
    save.needsCatalogReconcile = true; save.reloadCurrent = true;
    if (inputs.removeSaved) save.entries.forEach((entry) => save.savedImageIds.add(entry.imageId));
    showBrowserSaveProgress(save, save.entries.at(-1));
  } catch (error) {
    save.failed = true;
    if (batch.id) {
      await storeNumberedSave(batch);
      const status = await numberedBatchStatus(batch).catch(() => null);
      if (!status) throw codedError("save_recovery_pending");
      if (status.state === "committed") {
        await finishNumberedSave(batch);
        save.needsCatalogReconcile = true; save.reloadCurrent = true;
      } else await rollbackNumberedSave(batch);
    }
    throw error;
  }
}
