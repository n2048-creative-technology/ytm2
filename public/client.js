const connectionStatusEl = document.getElementById("connection-status");
const deviceNameInput = document.getElementById("deviceName");
const clientIdDisplay = document.getElementById("clientIdDisplay");
const roleStateEl = document.getElementById("roleState");
const errorDisplay = document.getElementById("errorDisplay");
const controlOverlay = document.getElementById("control-overlay");
const receiverSelect = document.getElementById("receiverSelect");
const remoteVideoLeft = document.getElementById("left-eye-remote-video");
const remoteVideoRight = document.getElementById("right-eye-remote-video");
const localVideoLeft = document.getElementById("left-eye-local-video");
const localVideoRight = document.getElementById("right-eye-local-video");

const DEVICE_ID_KEY = "local-vr-router-device-id";
const DEVICE_NAME_KEY = "local-vr-router-device-name";
const CAMERA_DEVICE_KEY = "local-vr-router-camera-device-id";
const PREVIEW_INTERVAL_MS = 100;

let ws;
let clientId = null;
const senderConnections = new Map(); // peerId -> RTCPeerConnection
let receiverPeerId = null;
let receiverPc = null;
let cameraStream = null;
let previewVideo = null;
let previewCanvas = null;
let previewTimer = null;
let nameUpdateTimeout = null;
let nameHeartbeatInterval = null;
let isRegistered = false;
let overlayVisible = false;
const remoteVideos = [remoteVideoLeft, remoteVideoRight].filter(Boolean);
const localVideos = [localVideoLeft, localVideoRight].filter(Boolean);
let localViewVisible = false;
let cameraRequested = false;
let vrMode = true;
const vrModeCheckbox = document.getElementById("vrModeCheckbox");
const localViewCheckbox = document.getElementById("localViewCheckbox");
let knownPhones = [];

function setVideoStream(videos, stream) {
  videos.forEach((video) => {
    if (!video) return;
    video.srcObject = stream || null;
    if (stream) {
      video.play().catch(() => {});
    }
  });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
      console.log("Service worker registered");
    } catch (err) {
      console.warn("SW registration failed", err);
    }
  }
}

function updateStatus(text) {
  connectionStatusEl.textContent = `Status: ${text}`;
}

function setError(message) {
  errorDisplay.textContent = message || "";
}

function updateRoleDisplay() {
  const sendingPeers = Array.from(senderConnections.keys());
  roleStateEl.textContent = sendingPeers.length
    ? `Sending to ${sendingPeers.join(", ")}`
    : "Not sending";
}

function getStoredDeviceId() {
  return localStorage.getItem(DEVICE_ID_KEY) || null;
}

function generateRandomId(len = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function getCurrentName() {
  const value = deviceNameInput.value.trim();
  return value.length > 0 ? value : `Phone ${clientId || ""}`;
}

function stopSendingToPeer(peerId) {
  const pc = senderConnections.get(peerId);
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    senderConnections.delete(peerId);
  }
  updateRoleDisplay();
}

function resetSender() {
  for (const peerId of Array.from(senderConnections.keys())) {
    stopSendingToPeer(peerId);
  }
}

function resetReceiver() {
  if (receiverPc) {
    receiverPc.onicecandidate = null;
    receiverPc.ontrack = null;
    receiverPc.onconnectionstatechange = null;
    receiverPc.close();
    receiverPc = null;
  }
  receiverPeerId = null;
  setVideoStream(remoteVideos, null);
  updateRoleDisplay();
}

function resetAllConnections() {
  resetSender();
  resetReceiver();
}

function setOverlayVisibility(visible) {
  const next = !!visible;
  const changed = next !== overlayVisible;
  overlayVisible = next;
  if (controlOverlay) {
    controlOverlay.classList.toggle("hidden", !overlayVisible);
  }
  if (changed) sendStateUpdate();
}

function toggleOverlayVisibility() {
  setOverlayVisibility(!overlayVisible);
}

function setLocalViewVisibility(visible) {
  const next = !!visible;
  const changed = next !== localViewVisible;
  localViewVisible = next;
  localVideos.forEach((video) => {
    if (!video) return;
    video.style.display = localViewVisible ? "" : "none";
  });
  if (localViewCheckbox) localViewCheckbox.checked = localViewVisible;
  if (changed) sendStateUpdate();
}

function setVrMode(isVr) {
  const next = !!isVr;
  const changed = next !== vrMode;
  vrMode = next;
  document.body.classList.toggle("panorama", !vrMode);
  if (vrModeCheckbox) vrModeCheckbox.checked = vrMode;
  if (changed) sendStateUpdate();
}

async function getCameraStream() {
  if (cameraStream) return cameraStream;
  const savedDeviceId = localStorage.getItem(CAMERA_DEVICE_KEY);
  const attempts = [
    { video: { facingMode: { exact: "environment" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20 } }, audio: false },
    { video: { facingMode: { exact: "environment" } }, audio: false },
    savedDeviceId ? { video: { deviceId: { exact: savedDeviceId } }, audio: false } : null,
    { video: { facingMode: { ideal: "environment" } }, audio: false },
    { video: true, audio: false }
  ].filter(Boolean);
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      setVideoStream(localVideos, cameraStream);
      setupPreviewPipeline();
      setError("");
      // Try to ensure we use the back camera; if not, switch to one labeled back/rear
      try {
        await maybeSwitchToBackCamera();
      } catch (e) {
        console.warn("Back-camera switch attempt failed", e && e.name, e && e.message);
      }
      return cameraStream;
    } catch (err) {
      lastErr = err;
      console.warn("getUserMedia failed", err && err.name, err && err.message);
    }
  }
  const detail = lastErr && lastErr.name ? ` (${lastErr.name})` : "";
  setError(`Camera access failed${detail}. Tap the screen and try again.`);
  throw lastErr || new Error("getUserMedia failed");
}

async function maybeSwitchToBackCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  // Ensure labels are available (requires permission first)
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter((d) => d.kind === "videoinput");
  if (videos.length === 0) return;
  const backRegex = /(back|rear|environment)/i;
  const frontRegex = /(front|user|selfie)/i;
  const currentTrack = cameraStream && cameraStream.getVideoTracks()[0];
  const currentSettings = currentTrack ? currentTrack.getSettings && currentTrack.getSettings() : null;
  const currentDeviceId = (currentSettings && currentSettings.deviceId) || null;
  const looksFront = currentTrack && frontRegex.test(currentTrack.label || "");
  const looksBack = currentTrack && backRegex.test(currentTrack.label || "");

  let target = videos.find((d) => backRegex.test(d.label || ""));
  if (!target && videos.length === 1) {
    // Single camera; assume it's the back if unknown
    target = videos[0];
  }
  if (!target) return; // No clear back camera
  if (currentDeviceId && target.deviceId === currentDeviceId && (looksBack || !looksFront)) {
    // Already on the desired device (or ambiguous but not front)
    localStorage.setItem(CAMERA_DEVICE_KEY, target.deviceId);
    return;
  }
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: target.deviceId } }, audio: false });
    // Swap streams
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
    }
    cameraStream = newStream;
    setVideoStream(localVideos, cameraStream);
    if (previewVideo) {
      previewVideo.srcObject = cameraStream;
    }
    localStorage.setItem(CAMERA_DEVICE_KEY, target.deviceId);
  } catch (err) {
    console.warn("Unable to switch to back camera", err && err.name, err && err.message);
  }
}

function setupPreviewPipeline() {
  if (!cameraStream || previewVideo) return;
  previewVideo = document.createElement("video");
  previewVideo.muted = true;
  previewVideo.playsInline = true;
  previewVideo.srcObject = cameraStream;
  previewVideo.addEventListener("loadedmetadata", () => {
    previewVideo.play().catch((err) => console.warn("Preview play blocked", err));
  });
  previewCanvas = document.createElement("canvas");
  previewCanvas.width = 320;
  previewCanvas.height = 180;
  previewTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !isRegistered) return;
    if (!previewCanvas || !previewVideo || previewVideo.readyState < 2) return;
    const ctx = previewCanvas.getContext("2d");
    ctx.drawImage(previewVideo, 0, 0, previewCanvas.width, previewCanvas.height);
    const image = previewCanvas.toDataURL("image/jpeg", 0.5);
    ws.send(
      JSON.stringify({
        type: "preview",
        image
      })
    );
  }, PREVIEW_INTERVAL_MS);
}

function createSenderConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(peerId, "ice-candidate", event.candidate, "receiver");
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      stopSendingToPeer(peerId);
    }
  };
  return pc;
}

async function startSending(peerId) {
  if (!peerId) return;
  if (senderConnections.has(peerId)) {
    stopSendingToPeer(peerId);
  }
  const pc = createSenderConnection(peerId);
  senderConnections.set(peerId, pc);
  updateRoleDisplay();
  try {
    const stream = await getCameraStream();
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peerId, "offer", offer, "receiver");
    setError("");
  } catch (err) {
    console.error("Failed to start sender", err);
    stopSendingToPeer(peerId);
  }
}

function ensureReceiverPc() {
  if (receiverPc) return receiverPc;
  receiverPc = new RTCPeerConnection({ iceServers: [] });
  receiverPc.onicecandidate = (event) => {
    if (event.candidate && receiverPeerId) {
      sendSignal(receiverPeerId, "ice-candidate", event.candidate, "sender");
    }
  };
  receiverPc.ontrack = (event) => {
    const [remoteStream] = event.streams;
    setVideoStream(remoteVideos, remoteStream);
  };
  receiverPc.onconnectionstatechange = () => {
    if (
      receiverPc &&
      (receiverPc.connectionState === "failed" || receiverPc.connectionState === "disconnected")
    ) {
      resetReceiver();
    }
  };
  return receiverPc;
}

function prepareReceiver(peerId) {
  if (!peerId) {
    resetReceiver();
    return;
  }
  if (receiverPeerId && receiverPeerId !== peerId) {
    resetReceiver();
  }
  receiverPeerId = peerId;
  ensureReceiverPc();
  updateRoleDisplay();
  // Reflect selection in UI
  if (receiverSelect) {
    receiverSelect.value = peerId || "";
  }
}

async function handleReceiverOffer(fromId, offer) {
  receiverPeerId = fromId;
  const pc = ensureReceiverPc();
  updateRoleDisplay();
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(fromId, "answer", answer, "sender");
  } catch (err) {
    console.error("Receiver failed to handle offer", err);
    setError("Unable to handle offer.");
    resetReceiver();
  }
}

async function handleReceiverCandidate(fromId, candidate) {
  if (!receiverPc || receiverPeerId !== fromId) {
    receiverPeerId = fromId;
    ensureReceiverPc();
  }
  try {
    await receiverPc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error("Receiver ICE error", err);
  }
}

async function handleSenderAnswer(fromId, answer) {
  const pc = senderConnections.get(fromId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error("Sender failed to set answer", err);
  }
}

async function handleSenderCandidate(fromId, candidate) {
  const pc = senderConnections.get(fromId);
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error("Sender ICE error", err);
  }
}

function sendSignal(targetId, signalType, payload, targetRole) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "signal",
      target: targetId,
      signalType,
      payload,
      targetRole
    })
  );
}

function registerPhone() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = {
    type: "register",
    role: "phone",
    name: getCurrentName()
  };
  let savedId = getStoredDeviceId();
  if (!savedId || !/^[A-Za-z0-9]{6}$/.test(savedId)) {
    savedId = generateRandomId(6);
    localStorage.setItem(DEVICE_ID_KEY, savedId);
  }
  payload.id = savedId;
  ws.send(JSON.stringify(payload));
}

function sendNameUpdate() {
  if (!clientId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "update-name",
      name: getCurrentName()
    })
  );
}

function scheduleNameUpdate() {
  if (nameUpdateTimeout) clearTimeout(nameUpdateTimeout);
  nameUpdateTimeout = setTimeout(sendNameUpdate, 400);
}

function startNameHeartbeat() {
  if (nameHeartbeatInterval) clearInterval(nameHeartbeatInterval);
  nameHeartbeatInterval = setInterval(() => {
    if (!isRegistered || !ws || ws.readyState !== WebSocket.OPEN) return;
    sendNameUpdate();
    sendStateUpdate();
  }, 5000);
}

function stopNameHeartbeat() {
  if (nameHeartbeatInterval) {
    clearInterval(nameHeartbeatInterval);
    nameHeartbeatInterval = null;
  }
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(protocol + location.host + "/ws");
  updateStatus("Connecting...");

  ws.addEventListener("open", () => {
    updateStatus("Connected");
    registerPhone();
  });

  ws.addEventListener("close", () => {
    updateStatus("Disconnected");
    isRegistered = false;
    stopNameHeartbeat();
    resetAllConnections();
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case "registered":
        clientId = data.id;
        isRegistered = true;
        localStorage.setItem(DEVICE_ID_KEY, clientId);
        clientIdDisplay.textContent = `Client ID: ${clientId}`;
        sendNameUpdate();
        sendStateUpdate();
        startNameHeartbeat();
        break;
      case "phones": {
        // Update dropdown with connected phones
        knownPhones = Array.isArray(data.phones) ? data.phones : [];
        if (receiverSelect) {
          const prev = receiverSelect.value;
          receiverSelect.innerHTML = "";
          const noneOpt = document.createElement("option");
          noneOpt.value = "";
          noneOpt.textContent = "None";
          receiverSelect.appendChild(noneOpt);
          // Self first
          const selfPhone = knownPhones.find((p) => p.id === clientId);
          if (selfPhone) {
            const selfOpt = document.createElement("option");
            selfOpt.value = selfPhone.id;
            selfOpt.textContent = `${selfPhone.name} (You)`;
            receiverSelect.appendChild(selfOpt);
          }
          // Others
          knownPhones
            .filter((p) => p.id !== clientId)
            .forEach((p) => {
              const opt = document.createElement("option");
              opt.value = p.id;
              opt.textContent = `${p.name} (${p.id})`;
              receiverSelect.appendChild(opt);
            });
          // Set selection based on current receiver or previous value
          const target = receiverPeerId || prev;
          if (typeof target === "string") {
            receiverSelect.value = target;
          }
        }
        break;
      }
      case "control":
        setError("");
        switch (data.action) {
          case "be-sender":
            await startSending(data.peerId);
            break;
          case "be-receiver":
            prepareReceiver(data.peerId);
            break;
          case "set-name":
            if (typeof data.name === "string") {
              deviceNameInput.value = data.name;
              localStorage.setItem(DEVICE_NAME_KEY, deviceNameInput.value);
              sendNameUpdate();
            }
            break;
          case "set-overlay":
            if (typeof data.visible === "boolean") {
              setOverlayVisibility(!!data.visible);
            }
            break;
          case "set-vr-mode":
            if (typeof data.vr === "boolean") {
              setVrMode(!!data.vr);
            }
            break;
          case "reset-sender":
            if (data.peerId) {
              stopSendingToPeer(data.peerId);
            } else {
              resetSender();
            }
            break;
          case "reset-receiver":
            if (!data.peerId || data.peerId === receiverPeerId) {
              resetReceiver();
            }
            break;
          case "set-local-view":
            setLocalViewVisibility(!!data.visible);
            break;
          case "reset":
            resetAllConnections();
            break;
          default:
            console.warn("Unknown control action", data);
        }
        break;
      case "signal": {
        const role = data.targetRole;
        if (role === "receiver") {
          if (data.signalType === "offer") {
            await handleReceiverOffer(data.from, data.payload);
          } else if (data.signalType === "ice-candidate") {
            await handleReceiverCandidate(data.from, data.payload);
          }
        } else if (role === "sender") {
          if (data.signalType === "answer") {
            await handleSenderAnswer(data.from, data.payload);
          } else if (data.signalType === "ice-candidate") {
            await handleSenderCandidate(data.from, data.payload);
          }
        } else {
          console.warn("Unknown signal role", data);
        }
        break;
      }
      case "error":
        setError(data.message || "Unknown error");
        break;
      default:
        console.log("Unhandled message", data);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("WebSocket error", err);
    setError("WebSocket error");
  });
}

function initFromStorage() {
  const storedName = localStorage.getItem(DEVICE_NAME_KEY);
  if (storedName) {
    deviceNameInput.value = storedName;
  }
}

deviceNameInput.addEventListener("input", () => {
  localStorage.setItem(DEVICE_NAME_KEY, deviceNameInput.value);
  scheduleNameUpdate();
});

registerServiceWorker();
initFromStorage();
connectWebSocket();
updateRoleDisplay();
setOverlayVisibility(false);
setLocalViewVisibility(false);
setVrMode(true);

function handlePointerToggle(event) {
  if (!event.isPrimary) return;
  if (!cameraRequested) {
    cameraRequested = true;
    // Request camera in response to user gesture
    getCameraStream().catch(() => {});
  }
  // If overlay is visible and the tap is inside it, do not toggle
  if (overlayVisible && controlOverlay && controlOverlay.contains(event.target)) {
    return;
  }
  toggleOverlayVisibility();
}

window.addEventListener("pointerup", handlePointerToggle);

if (vrModeCheckbox) {
  vrModeCheckbox.addEventListener("change", () => {
    setVrMode(!!vrModeCheckbox.checked);
  });
}

if (receiverSelect) {
  receiverSelect.addEventListener("change", () => {
    // Request routing for this client (self) to selected sender
    const value = receiverSelect.value;
    if (!ws || ws.readyState !== WebSocket.OPEN || !clientId) return;
    ws.send(
      JSON.stringify({ type: "route", from: value || null, to: clientId })
    );
  });
}

if (localViewCheckbox) {
  localViewCheckbox.addEventListener("change", () => {
    setLocalViewVisibility(!!localViewCheckbox.checked);
  });
}

function sendStateUpdate() {
  if (!clientId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "update-state",
      localViewVisible,
      controlOverlayVisible: overlayVisible,
      vrMode
    })
  );
}
