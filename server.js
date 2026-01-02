const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const helmet = require("helmet");
const { WebSocketServer } = require("ws");

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

const httpsKeyPath = process.env.HTTPS_KEY_PATH;
const httpsCertPath = process.env.HTTPS_CERT_PATH;
let server;
let protocol = "http";

if (httpsKeyPath && httpsCertPath) {
  try {
    const key = fs.readFileSync(httpsKeyPath);
    const cert = fs.readFileSync(httpsCertPath);
    server = https.createServer({ key, cert }, app);
    protocol = "https";
  } catch (err) {
    console.warn("Failed to load HTTPS certs, falling back to HTTP.", err);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server, path: "/ws" });
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 1000);
const clients = new Map();
let clientCounter = 1;

function broadcastToAdmins(message) {
  const payload = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.role === "admin") {
      client.ws.send(payload);
    }
  }
}

function formatPhone(client) {
  const sendingTargets = Array.from(client.sendingTo || []);
  let status = "idle";
  if (sendingTargets.length > 0 && client.receivingFrom) {
    status = "sending-receiving";
  } else if (sendingTargets.length > 0) {
    status = "sending";
  } else if (client.receivingFrom) {
    status = "receiving";
  }
  return {
    id: client.id,
    name: client.name || "Unnamed phone",
    status,
    sendingTo: sendingTargets,
    receivingFrom: client.receivingFrom,
    preview: client.previewData || null,
    localViewVisible: client.localViewVisible !== false,
    controlOverlayVisible: !!client.controlOverlayVisible
  };
}

function broadcastPhoneList() {
  const phones = [];
  for (const client of clients.values()) {
    if (client.role === "phone") {
      phones.push(formatPhone(client));
    }
  }
  broadcastToAdmins({ type: "phones", phones });
}

function broadcastPreviewUpdate(id, image) {
  const payload = JSON.stringify({ type: "preview", id, image });
  for (const client of clients.values()) {
    if (client.role === "admin") {
      client.ws.send(payload);
    }
  }
}

function clearSending(phone, targetId = null, reason = "route-updated") {
  if (!phone || phone.role !== "phone" || !phone.sendingTo || phone.sendingTo.size === 0) return;
  const targets = targetId ? [targetId] : Array.from(phone.sendingTo);
  for (const target of targets) {
    if (!phone.sendingTo.has(target)) continue;
    phone.sendingTo.delete(target);
    phone.ws.send(
      JSON.stringify({ type: "control", action: "reset-sender", peerId: target, reason })
    );
    const targetClient = clients.get(target);
    if (targetClient && targetClient.role === "phone" && targetClient.receivingFrom === phone.id) {
      targetClient.receivingFrom = null;
      targetClient.ws.send(
        JSON.stringify({ type: "control", action: "reset-receiver", peerId: phone.id, reason })
      );
    }
  }
}

function clearReceiving(phone, reason = "route-updated") {
  if (!phone || phone.role !== "phone" || !phone.receivingFrom) return;
  const sourceId = phone.receivingFrom;
  const source = clients.get(sourceId);
  phone.receivingFrom = null;
  phone.ws.send(
    JSON.stringify({ type: "control", action: "reset-receiver", peerId: sourceId, reason })
  );
  if (source && source.role === "phone" && source.sendingTo && source.sendingTo.has(phone.id)) {
    source.sendingTo.delete(phone.id);
    source.ws.send(
      JSON.stringify({ type: "control", action: "reset-sender", peerId: phone.id, reason })
    );
  }
}

function resetPeersReferencing(id) {
  for (const client of clients.values()) {
    if (client.role !== "phone") continue;
    if (client.sendingTo && client.sendingTo.has(id)) {
      clearSending(client, id, "peer-disconnected");
    }
    if (client.receivingFrom === id) {
      clearReceiving(client, "peer-disconnected");
    }
  }
}

function applyRouteByIds(fromId, toId) {
  const fromClient = clients.get(fromId);
  const toClient = clients.get(toId);
  if (!fromClient || !toClient) return;
  if (fromClient.role !== "phone" || toClient.role !== "phone") return;
  if (toClient.receivingFrom === fromClient.id) return;
  clearReceiving(toClient);
  if (!fromClient.sendingTo) {
    fromClient.sendingTo = new Set();
  }
  fromClient.sendingTo.add(toClient.id);
  toClient.receivingFrom = fromClient.id;
  fromClient.ws.send(
    JSON.stringify({ type: "control", action: "be-sender", peerId: toClient.id })
  );
  toClient.ws.send(
    JSON.stringify({ type: "control", action: "be-receiver", peerId: fromClient.id })
  );
}

wss.on("connection", (ws) => {
  console.log("WebSocket connected");
  let assignedId = null;

  // Heartbeat: track liveness via ping/pong
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      console.error("Invalid JSON", err);
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (message.type === "register") {
      if (assignedId) return;
      let requestedId = null;
      if (typeof message.id === "string" && message.id.trim().length > 0) {
        const trimmed = message.id.trim();
        // Only allow up to 6 alphanumeric characters for client-provided IDs
        const sanitized = trimmed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
        if (sanitized.length > 0) {
          requestedId = sanitized;
        }
      }
      let id = requestedId && !clients.has(requestedId)
        ? requestedId
        : `client-${clientCounter++}-${Date.now()}`;
      assignedId = id;
      const role = message.role === "admin" ? "admin" : "phone";
      clients.set(id, {
        id,
        ws,
        role,
        name: message.name || (role === "admin" ? "Admin" : "Phone"),
        sendingTo: new Set(),
        receivingFrom: null,
        previewData: null,
        localViewVisible: false,
        controlOverlayVisible: false
      });
      ws.send(JSON.stringify({ type: "registered", id }));
      console.log(`Registered ${role} ${id}`);
      if (role === "phone") {
        broadcastPhoneList();
      }
      return;
    }

    if (!assignedId) {
      ws.send(JSON.stringify({ type: "error", message: "Register first" }));
      return;
    }

    const client = clients.get(assignedId);
    if (!client) {
      ws.send(JSON.stringify({ type: "error", message: "Unknown client" }));
      return;
    }

    switch (message.type) {
      case "route": {
        if (client.role !== "admin") return;
        const toClient = clients.get(message.to);
        if (!toClient || toClient.role !== "phone") {
          ws.send(JSON.stringify({ type: "error", message: "Invalid receiver" }));
          return;
        }

        if (!message.from) {
          clearReceiving(toClient);
          broadcastPhoneList();
          break;
        }

        const fromClient = clients.get(message.from);
        if (!fromClient || fromClient.role !== "phone") {
          ws.send(JSON.stringify({ type: "error", message: "Invalid sender" }));
          return;
        }

        if (toClient.receivingFrom === fromClient.id) {
          break;
        }

        clearReceiving(toClient);
        if (!fromClient.sendingTo) {
          fromClient.sendingTo = new Set();
        }
        fromClient.sendingTo.add(toClient.id);
        toClient.receivingFrom = fromClient.id;
        fromClient.ws.send(
          JSON.stringify({ type: "control", action: "be-sender", peerId: toClient.id })
        );
        toClient.ws.send(
          JSON.stringify({ type: "control", action: "be-receiver", peerId: fromClient.id })
        );
        console.log(`Route set ${fromClient.id} -> ${toClient.id}`);
        broadcastPhoneList();
        break;
      }
      case "signal": {
        const target = clients.get(message.target);
        if (!target) {
          ws.send(JSON.stringify({ type: "error", message: "Target not found" }));
          return;
        }
        target.ws.send(
          JSON.stringify({
            type: "signal",
            from: client.id,
            signalType: message.signalType,
            payload: message.payload || null,
            targetRole: message.targetRole || null
          })
        );
        console.log(`Signal ${message.signalType} ${client.id} -> ${target.id}`);
        break;
      }
      case "client-control": {
        if (client.role !== "admin") return;
        const target = clients.get(message.target);
        if (!target || target.role !== "phone") {
          ws.send(JSON.stringify({ type: "error", message: "Invalid target" }));
          return;
        }
        const action = message.action;
        const params = message.params || {};
        // Forward as a control message to the target phone
        target.ws.send(
          JSON.stringify({
            type: "control",
            action,
            ...params
          })
        );
        break;
      }
      case "update-state": {
        if (client.role !== "phone") return;
        if (typeof message.localViewVisible === "boolean") {
          client.localViewVisible = message.localViewVisible;
        }
        if (typeof message.controlOverlayVisible === "boolean") {
          client.controlOverlayVisible = message.controlOverlayVisible;
        }
        broadcastPhoneList();
        break;
      }
      case "update-name": {
        if (client.role !== "phone") return;
        const newName =
          typeof message.name === "string" && message.name.trim().length > 0
            ? message.name.trim()
            : client.name;
        client.name = newName;
        broadcastPhoneList();
        break;
      }
      case "preview": {
        if (client.role !== "phone") return;
        if (typeof message.image === "string" && message.image.startsWith("data:")) {
          client.previewData = message.image;
          broadcastPreviewUpdate(client.id, message.image);
        }
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    }
  });

  ws.on("close", () => {
    if (!assignedId) return;
    const client = clients.get(assignedId);
    // Capture receivers that were receiving from this client before cleanup
    const affectedReceivers = [];
    if (client && client.role === "phone") {
      for (const c of clients.values()) {
        if (c.role === "phone" && c.receivingFrom === assignedId) {
          affectedReceivers.push(c.id);
        }
      }
    }
    clients.delete(assignedId);
    if (client && client.role === "phone") {
      broadcastPreviewUpdate(assignedId, null);
      resetPeersReferencing(assignedId);
      // Reassign affected receivers to a random available sender (or self if none)
      const remainingPhoneIds = Array.from(clients.values())
        .filter((c) => c.role === "phone")
        .map((c) => c.id);
      for (const rid of affectedReceivers) {
        const candidates = remainingPhoneIds.filter((id) => id !== rid);
        const newSenderId = candidates.length > 0
          ? candidates[Math.floor(Math.random() * candidates.length)]
          : rid;
        applyRouteByIds(newSenderId, rid);
      }
      broadcastPhoneList();
    }
    console.log(`Client disconnected ${assignedId}`);
  });
});

// Periodically ping all clients; terminate if no pong received
const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      try { socket.terminate(); } catch {}
      return;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch {}
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeat);
});

const defaultPort = protocol === "https" ? 8443 : 3000;
const port = process.env.PORT ? Number(process.env.PORT) : defaultPort;
server.listen(port, () => {
  console.log(`${protocol.toUpperCase()} server listening on port ${port}`);
  if (protocol !== "https") {
    console.warn("PWA install prompts require HTTPS (or localhost).");
  }
});
