const statusEl = document.getElementById("admin-connection-status");
const phonesTableBody = document.querySelector("#phonesTable tbody");
const adminError = document.getElementById("adminError");
const qrCanvas = document.getElementById("qrCanvas");
const qrUrlEl = document.getElementById("qrUrl");

let ws;
let phones = [];
const previewCache = new Map();
const previewElements = new Map();

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
    nameTd.textContent = phone.name;
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

    phonesTableBody.appendChild(tr);
  });

  for (const key of Array.from(previewCache.keys())) {
    if (!seenIds.has(key)) {
      previewCache.delete(key);
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
