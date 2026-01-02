const statusEl = document.getElementById("admin-connection-status");
const phonesTableBody = document.querySelector("#phonesTable tbody");
const adminError = document.getElementById("adminError");
const qrCanvas = document.getElementById("qrCanvas");
const qrUrlEl = document.getElementById("qrUrl");

let ws;
let phones = [];
const previewCache = new Map();
const previewElements = new Map();
const editingNameIds = new Set(); // ids currently being edited
const pendingNameEdits = new Map(); // id -> pending string value
const editingNameCursors = new Map(); // id -> { start, end }
let focusedEditId = null; // last-focused editing name input id

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
