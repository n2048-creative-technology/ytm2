const statusEl = document.getElementById("admin-connection-status");
const phonesTableBody = document.querySelector("#phonesTable tbody");
const adminError = document.getElementById("adminError");
const qrCanvas = document.getElementById("qrCanvas");
const qrUrlEl = document.getElementById("qrUrl");
const globalLocalView = document.getElementById("globalLocalView");
const globalOverlay = document.getElementById("globalOverlay");
const btnRandomizeSenders = document.getElementById("btnRandomizeSenders");
const btnSelfRouteAll = document.getElementById("btnSelfRouteAll");
const globalBroadcastSelect = document.getElementById("globalBroadcastSelect");
const btnBroadcastRandom = document.getElementById("btnBroadcastRandom");

let ws;
let phones = [];
const previewCache = new Map();
const previewElements = new Map();
const editingNameIds = new Set(); // ids currently being edited
const pendingNameEdits = new Map(); // id -> pending string value
const editingNameCursors = new Map(); // id -> { start, end }
let focusedEditId = null; // last-focused editing name input id
const selfRoutedIds = new Set(); // ids that were auto self-routed by this admin session
const globalVrMode = document.getElementById("globalVrMode");

function updateStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function setAdminError(message) {
  adminError.textContent = message || "";
}

function renderPhones() {
  phonesTableBody.innerHTML = "";
  previewElements.clear();
  const seenIds = new Set();

  phones.forEach((phone) => {
    seenIds.add(phone.id);
    if (phone.preview) {
      previewCache.set(phone.id, phone.preview);
    }
    const tr = document.createElement("tr");
    if (phone.status.includes("sending")) tr.classList.add("sending");
    if (phone.status.includes("receiving")) tr.classList.add("receiving");

    const previewTd = document.createElement("td");
    const previewImg = document.createElement("img");
    previewImg.className = "phone-preview";
    previewImg.alt = `${phone.name} preview`;
    const cachedPreview = previewCache.get(phone.id) || phone.preview;
    if (cachedPreview) previewImg.src = cachedPreview;
    previewTd.appendChild(previewImg);
    previewElements.set(phone.id, previewImg);
    tr.appendChild(previewTd);

    const idTd = document.createElement("td");
    idTd.textContent = phone.id;
    tr.appendChild(idTd);

    const nameTd = document.createElement("td");
    if (editingNameIds.has(phone.id)) {
      const current = pendingNameEdits.has(phone.id)
        ? pendingNameEdits.get(phone.id)
        : (phone.name || "");
      const input = document.createElement("input");
      input.type = "text";
      input.value = current;
      input.size = 14;
      input.id = `name-input-${phone.id}`;
      input.dataset.role = "name-edit";
      input.addEventListener("focus", () => {
        focusedEditId = phone.id;
      });
      input.addEventListener("input", () => {
        pendingNameEdits.set(phone.id, input.value);
        try {
          editingNameCursors.set(phone.id, {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length
          });
        } catch {}
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          okBtn.click();
        }
      });
      const okBtn = document.createElement("button");
      okBtn.textContent = "OK";
      okBtn.style.marginLeft = "6px";
      okBtn.addEventListener("click", () => {
        const newName = (input.value || "").trim();
        if (!newName) return;
        // send change to client
        sendClientControl(phone.id, "set-name", { name: newName });
        // optimistically update local list
        const idx = phones.findIndex((p) => p.id === phone.id);
        if (idx >= 0) phones[idx].name = newName;
        // exit edit mode
        editingNameIds.delete(phone.id);
        pendingNameEdits.delete(phone.id);
        editingNameCursors.delete(phone.id);
        if (focusedEditId === phone.id) focusedEditId = null;
        renderPhones();
      });
      nameTd.appendChild(input);
      nameTd.appendChild(okBtn);
    } else {
      const label = document.createElement("span");
      label.textContent = phone.name || "";
      label.style.cursor = "pointer";
      label.title = "Click to edit name";
      label.addEventListener("click", () => {
        editingNameIds.add(phone.id);
        pendingNameEdits.set(phone.id, phone.name || "");
        renderPhones();
      });
      nameTd.appendChild(label);
    }
    tr.appendChild(nameTd);

    const statusTd = document.createElement("td");
    statusTd.textContent = phone.status;
    tr.appendChild(statusTd);

    const sendingTd = document.createElement("td");
    if (Array.isArray(phone.sendingTo) && phone.sendingTo.length > 0) {
      sendingTd.textContent = phone.sendingTo.join(", ");
    } else {
      sendingTd.textContent = "-";
    }
    tr.appendChild(sendingTd);

    const receivingTd = document.createElement("td");
    receivingTd.textContent = phone.receivingFrom || "-";
    tr.appendChild(receivingTd);

    const controlTd = document.createElement("td");
    const select = document.createElement("select");
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "None";
    select.appendChild(noneOption);

    phones.forEach((candidate) => {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = `${candidate.name} (${candidate.id})`;
      if (phone.receivingFrom === candidate.id) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    select.value = phone.receivingFrom || "";
    select.addEventListener("change", () => {
      handleRouteSelection(phone.id, select.value);
    });
    controlTd.appendChild(select);
    tr.appendChild(controlTd);

    const localViewTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!phone.localViewVisible;
    checkbox.title = "Toggle local view visibility";
    checkbox.addEventListener("change", () => {
      sendClientControl(phone.id, "set-local-view", { visible: checkbox.checked });
    });
    localViewTd.appendChild(checkbox);
    tr.appendChild(localViewTd);

    const overlayTd = document.createElement("td");
    const overlayCheckbox = document.createElement("input");
    overlayCheckbox.type = "checkbox";
    overlayCheckbox.checked = !!phone.controlOverlayVisible;
    overlayCheckbox.title = "Toggle control overlay";
    overlayCheckbox.addEventListener("change", () => {
      sendClientControl(phone.id, "set-overlay", { visible: overlayCheckbox.checked });
    });
    overlayTd.appendChild(overlayCheckbox);
    tr.appendChild(overlayTd);

    const vrTd = document.createElement("td");
    const vrCheckbox = document.createElement("input");
    vrCheckbox.type = "checkbox";
    vrCheckbox.checked = phone.vrMode !== false; // default true
    vrCheckbox.title = "Toggle VR (split) mode";
    vrCheckbox.addEventListener("change", () => {
      sendClientControl(phone.id, "set-vr-mode", { vr: vrCheckbox.checked });
    });
    vrTd.appendChild(vrCheckbox);
    tr.appendChild(vrTd);

    phonesTableBody.appendChild(tr);
  });

  for (const key of Array.from(previewCache.keys())) {
    if (!seenIds.has(key)) {
      previewCache.delete(key);
    }
  }

  // Restore focus and caret for editing inputs after rendering
  if (editingNameIds.size > 0) {
    const ids = Array.from(editingNameIds);
    const idToFocus = focusedEditId && editingNameIds.has(focusedEditId) ? focusedEditId : ids[0];
    const input = document.getElementById(`name-input-${idToFocus}`);
    if (input) {
      input.focus();
      const cur = editingNameCursors.get(idToFocus);
      try {
        if (cur && typeof cur.start === "number" && typeof cur.end === "number") {
          input.setSelectionRange(cur.start, cur.end);
        } else {
          const end = input.value.length;
          input.setSelectionRange(end, end);
        }
      } catch {}
    }
  }

  // Update global toggles to reflect aggregate state
  if (globalLocalView) {
    const any = phones.some((p) => !!p.localViewVisible);
    const all = phones.length > 0 && phones.every((p) => !!p.localViewVisible);
    globalLocalView.indeterminate = any && !all;
    globalLocalView.checked = all;
    globalLocalView.disabled = phones.length === 0;
  }
  if (globalOverlay) {
    const any = phones.some((p) => !!p.controlOverlayVisible);
    const all = phones.length > 0 && phones.every((p) => !!p.controlOverlayVisible);
    globalOverlay.indeterminate = any && !all;
    globalOverlay.checked = all;
    globalOverlay.disabled = phones.length === 0;
  }
  if (globalVrMode) {
    const any = phones.some((p) => p.vrMode !== false);
    const all = phones.length > 0 && phones.every((p) => p.vrMode !== false);
    globalVrMode.indeterminate = any && !all;
    globalVrMode.checked = all;
    globalVrMode.disabled = phones.length === 0;
  }
  if (btnRandomizeSenders) {
    btnRandomizeSenders.disabled = phones.length < 2;
  }
  if (btnSelfRouteAll) {
    btnSelfRouteAll.disabled = phones.length === 0;
  }
  if (globalBroadcastSelect) {
    // Rebuild options while preserving selection if still present
    const prev = globalBroadcastSelect.value;
    globalBroadcastSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = phones.length ? "Select sender" : "No clients";
    globalBroadcastSelect.appendChild(placeholder);
    phones.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.id})`;
      globalBroadcastSelect.appendChild(opt);
    });
    if (prev && phones.some((p) => p.id === prev)) {
      globalBroadcastSelect.value = prev;
    }
    globalBroadcastSelect.disabled = phones.length === 0;
  }
  if (btnBroadcastRandom) {
    btnBroadcastRandom.disabled = phones.length === 0;
  }
}

function handleRouteSelection(receiverId, senderId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setAdminError("WebSocket not connected");
    return;
  }
  ws.send(
    JSON.stringify({
      type: "route",
      from: senderId || null,
      to: receiverId
    })
  );
  setAdminError("");
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(protocol + location.host + "/ws");
  updateStatus("Connecting...");

  ws.addEventListener("open", () => {
    updateStatus("Connected");
    ws.send(JSON.stringify({ type: "register", role: "admin", name: "Admin" }));
  });

  ws.addEventListener("close", () => {
    updateStatus("Disconnected");
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "registered") {
      setAdminError("");
    } else if (data.type === "phones") {
      phones = data.phones || [];
      // Cleanup selfRoutedIds entries for disconnected phones
      const connectedIds = new Set(phones.map((p) => p.id));
      for (const id of Array.from(selfRoutedIds)) {
        if (!connectedIds.has(id)) selfRoutedIds.delete(id);
      }
      // Auto-route new phones to themselves so they see own video
      phones.forEach((phone) => {
        if (!selfRoutedIds.has(phone.id) && !phone.receivingFrom) {
          handleRouteSelection(phone.id, phone.id);
          selfRoutedIds.add(phone.id);
        }
      });
      phones.forEach((phone) => {
        if (phone.preview) {
          previewCache.set(phone.id, phone.preview);
        }
      });
      renderPhones();
    } else if (data.type === "preview") {
      if (data.id) {
        if (data.image) {
          previewCache.set(data.id, data.image);
        } else {
          previewCache.delete(data.id);
        }
        const img = previewElements.get(data.id);
        if (img) {
          img.src = data.image || "";
        }
      }
    } else if (data.type === "error") {
      setAdminError(data.message || "Unknown error");
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("Admin WS error", err);
    setAdminError("WebSocket error");
  });
}

connectWebSocket();

function determineBaseUrl() {
  return location.origin;
}

function drawQrCode(url) {
  if (!qrCanvas || typeof window.QRCode !== "function") return;
  const qr = new window.QRCode(-1, 1); // auto size, low ECC
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const cellSize = Math.max(Math.floor(qrCanvas.width / count), 2);
  const size = count * cellSize;
  if (qrCanvas.width !== size) {
    qrCanvas.width = qrCanvas.height = size;
  }
  const ctx = qrCanvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  }
}

function initQrDisplay() {
  const url = determineBaseUrl();
  if (qrUrlEl) {
    qrUrlEl.textContent = url;
  }
  drawQrCode(url);
}

initQrDisplay();

function sendClientControl(targetId, action, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setAdminError("WebSocket not connected");
    return;
  }
  ws.send(
    JSON.stringify({
      type: "client-control",
      target: targetId,
      action,
      params
    })
  );
}

function sendClientControlAll(action, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setAdminError("WebSocket not connected");
    return;
  }
  phones.forEach((p) => {
    ws.send(
      JSON.stringify({
        type: "client-control",
        target: p.id,
        action,
        params
      })
    );
  });
}

if (globalLocalView) {
  globalLocalView.addEventListener("change", () => {
    sendClientControlAll("set-local-view", { visible: globalLocalView.checked });
  });
}

if (globalOverlay) {
  globalOverlay.addEventListener("change", () => {
    sendClientControlAll("set-overlay", { visible: globalOverlay.checked });
  });
}

if (globalVrMode) {
  globalVrMode.addEventListener("change", () => {
    sendClientControlAll("set-vr-mode", { vr: globalVrMode.checked });
  });
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function computeDerangement(ids) {
  const n = ids.length;
  if (n < 2) return null;
  const perm = shuffle([...Array(n).keys()]);
  for (let i = 0; i < n; i++) {
    if (perm[i] === i) {
      const j = (i + 1) % n;
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
  }
  // Validate no fixed points
  for (let i = 0; i < n; i++) {
    if (perm[i] === i) return computeDerangement(ids); // rare, but retry
  }
  return perm.map((k) => ids[k]);
}

function randomizeSenders() {
  if (phones.length < 2) {
    setAdminError("Need at least 2 phones to randomize");
    return;
  }
  setAdminError("");
  const ids = phones.map((p) => p.id);
  const senders = computeDerangement(ids);
  if (!senders) return;
  // First clear all receiving routes to ensure one-to-one mapping
  ids.forEach((rid) => {
    handleRouteSelection(rid, "");
  });
  // After a short delay, apply new mapping
  setTimeout(() => {
    ids.forEach((rid, idx) => {
      const sid = senders[idx];
      handleRouteSelection(rid, sid);
    });
  }, 150);
}

if (btnRandomizeSenders) {
  btnRandomizeSenders.addEventListener("click", randomizeSenders);
}

function selfRouteAll() {
  if (phones.length === 0) return;
  setAdminError("");
  phones.forEach((p) => {
    handleRouteSelection(p.id, p.id);
  });
}

if (btnSelfRouteAll) {
  btnSelfRouteAll.addEventListener("click", selfRouteAll);
}

function broadcastFrom(senderId) {
  if (!senderId) return;
  setAdminError("");
  // Route selected sender to every phone (including itself)
  phones.forEach((p) => {
    handleRouteSelection(p.id, senderId);
  });
}

if (globalBroadcastSelect) {
  globalBroadcastSelect.addEventListener("change", () => {
    if (!globalBroadcastSelect.value) return;
    broadcastFrom(globalBroadcastSelect.value);
  });
}

if (btnBroadcastRandom) {
  btnBroadcastRandom.addEventListener("click", () => {
    if (phones.length === 0) return;
    const idx = Math.floor(Math.random() * phones.length);
    const id = phones[idx].id;
    if (globalBroadcastSelect) globalBroadcastSelect.value = id;
    broadcastFrom(id);
  });
}
