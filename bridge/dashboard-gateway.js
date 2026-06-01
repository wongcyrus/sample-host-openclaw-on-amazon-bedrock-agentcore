const { randomUUID } = require("crypto");

function parseGatewayMessage(data) {
  const raw = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function agentIdFromSessionKey(key) {
  if (!key) return "";
  const parts = String(key).split(":");
  return parts[0] === "agent" ? (parts[1] || "") : "";
}

function extractGatewayContent(messageData) {
  if (typeof messageData === "string") {
    return messageData;
  }
  if (!messageData || typeof messageData !== "object") {
    return "";
  }

  if (typeof messageData.content === "string") {
    return messageData.content;
  }

  if (Array.isArray(messageData.content)) {
    return messageData.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }

  if (typeof messageData.text === "string") {
    return messageData.text;
  }

  return "";
}

async function fetchGatewaySnapshot({
  token = "",
  port = 18789,
  protocolVersion = 4,
  allowProtocolFallback = true,
  timeoutMs = 15000,
  wsImpl,
} = {}) {
  const WebSocketImpl = wsImpl || require("ws");
  const wsUrl = `ws://127.0.0.1:${port}`;
  const httpOrigin = `http://127.0.0.1:${port}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl, { origin: httpOrigin });
    let settled = false;
    let closingIntentional = false;
    let requestSeq = 1;
    let connectReqId = null;
    const pending = new Map();

    const cleanupPending = (err) => {
      for (const entry of pending.values()) {
        entry.reject(err);
      }
      pending.clear();
    };

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupPending(err || new Error("Gateway request closed"));
      if (
        ws.readyState === WebSocketImpl.OPEN ||
        ws.readyState === WebSocketImpl.CONNECTING
      ) {
        closingIntentional = true;
        try {
          ws.close();
        } catch {}
      }
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    const request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = String(requestSeq++);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        ws.send(
          JSON.stringify({ type: "req", id, method, params }),
          (error) => {
            if (!error) return;
            pending.delete(id);
            rejectRequest(
              error instanceof Error ? error : new Error(String(error)),
            );
          },
        );
      });

    const timeout = setTimeout(() => {
      finish(new Error(`Gateway snapshot timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on("message", async (data) => {
      const msg = parseGatewayMessage(data);
      if (!msg) return;

      if (msg.type === "event" && msg.event === "connect.challenge") {
        connectReqId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectReqId,
            method: "connect",
            params: {
              minProtocol: protocolVersion,
              maxProtocol: protocolVersion,
              client: {
                id: "openclaw-control-ui",
                version: "agentcore-dashboard-bridge",
                platform: "linux",
                mode: "backend",
                instanceId: "agentcore-dashboard-bridge",
              },
              role: "operator",
              scopes: ["operator.read"],
              caps: ["tool-events"],
              auth: token ? { token } : {},
              userAgent: "agentcore-dashboard-bridge",
              locale: "en",
            },
          }),
        );
        return;
      }

      if (msg.type !== "res") {
        return;
      }

      if (msg.id === connectReqId) {
        if (!msg.ok) {
          const expectedProtocol = Number(
            msg.error?.details?.expectedProtocol ??
            msg.payload?.expectedProtocol ??
            msg.payload?.details?.expectedProtocol,
          );
          if (
            allowProtocolFallback &&
            msg.error?.details?.code === "PROTOCOL_MISMATCH" &&
            Number.isInteger(expectedProtocol) &&
            expectedProtocol > 0 &&
            expectedProtocol !== protocolVersion
          ) {
            closingIntentional = true;
            try {
              ws.close();
            } catch {}
            try {
              const snapshot = await fetchGatewaySnapshot({
                token,
                port,
                protocolVersion: expectedProtocol,
                allowProtocolFallback: false,
                timeoutMs,
                wsImpl: WebSocketImpl,
              });
              finish(null, snapshot);
            } catch (err) {
              finish(err instanceof Error ? err : new Error(String(err)));
            }
            return;
          }
          finish(
            new Error(msg.error?.message || "Gateway connect failed"),
          );
          return;
        }

        try {
          const [agents, sessions, presence] = await Promise.all([
            request("agents.list", {}),
            request("sessions.list", {
              includeGlobal: true,
              includeUnknown: true,
              limit: 100,
            }),
            request("system-presence", {}).catch(() => []),
          ]);

          const agentIds = ((agents?.agents) || [])
            .map((agent) => agent?.id)
            .filter((agentId) => typeof agentId === "string");

          const identityEntries = await Promise.all(
            agentIds.map(async (agentId) => {
              try {
                const identity = await request("agent.identity.get", { agentId });
                return [agentId, identity];
              } catch (error) {
                return [
                  agentId,
                  {
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                ];
              }
            }),
          );

          finish(null, {
            agents,
            sessions,
            presence,
            identities: Object.fromEntries(identityEntries),
            source: wsUrl,
            fetchedAt: Date.now(),
          });
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.payload);
      } else {
        entry.reject(
          new Error(msg.error?.message || `${msg.id} request failed`),
        );
      }
    });

    ws.on("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", () => {
      if (settled || closingIntentional) return;
      finish(new Error("Gateway WebSocket closed unexpectedly"));
    });
  });
}

function streamGatewayEvents({
  token = "",
  port = 18789,
  protocolVersion = 4,
  allowProtocolFallback = true,
  wsImpl,
  onEvent = () => {},
  onStatus = () => {},
  onError = () => {},
} = {}) {
  const WebSocketImpl = wsImpl || require("ws");
  const wsUrl = `ws://127.0.0.1:${port}`;
  const httpOrigin = `http://127.0.0.1:${port}`;
  const runRoles = new Map();

  let ws = null;
  let stopped = false;
  let connectReqId = null;
  let intentionalClose = false;

  const emitStatus = (status, extra = {}) => {
    onStatus({
      type: "dashboard-status",
      status,
      source: wsUrl,
      ...extra,
    });
  };

  const open = (activeProtocolVersion, canFallback) => {
    if (stopped) return;
    ws = new WebSocketImpl(wsUrl, { origin: httpOrigin });
    intentionalClose = false;
    connectReqId = null;

    ws.on("open", () => {
      emitStatus("connecting", { protocolVersion: activeProtocolVersion });
    });

    ws.on("message", (data) => {
      const message = parseGatewayMessage(data);
      if (!message) return;

      if (message.type === "event" && message.event === "connect.challenge") {
        connectReqId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectReqId,
            method: "connect",
            params: {
              minProtocol: activeProtocolVersion,
              maxProtocol: activeProtocolVersion,
              client: {
                id: "openclaw-control-ui",
                version: "agentcore-dashboard-bridge",
                platform: "linux",
                mode: "backend",
                instanceId: "agentcore-dashboard-bridge",
              },
              role: "operator",
              scopes: ["operator.read"],
              caps: ["tool-events"],
              auth: token ? { token } : {},
              userAgent: "agentcore-dashboard-bridge",
              locale: "en",
            },
          }),
        );
        return;
      }

      if (message.type === "res" && message.id === connectReqId) {
        if (!message.ok) {
          const expectedProtocol = Number(
            message.error?.details?.expectedProtocol ??
            message.payload?.expectedProtocol ??
            message.payload?.details?.expectedProtocol,
          );
          if (
            canFallback &&
            message.error?.details?.code === "PROTOCOL_MISMATCH" &&
            Number.isInteger(expectedProtocol) &&
            expectedProtocol > 0 &&
            expectedProtocol !== activeProtocolVersion
          ) {
            intentionalClose = true;
            try {
              ws.close();
            } catch {}
            open(expectedProtocol, false);
            return;
          }

          const err = new Error(
            message.error?.message || "Gateway event stream connect failed",
          );
          emitStatus("error", { error: err.message });
          onError(err);
          return;
        }

        emitStatus("connected", { protocolVersion: activeProtocolVersion });
        return;
      }

      if (message.type !== "event") {
        return;
      }

      const payload = message.payload || {};

      if (message.event === "chat") {
        const runId = payload.runId || "unknown";
        const messageData = payload.message || {};

        let role =
          typeof messageData.role === "string"
            ? messageData.role.toLowerCase()
            : "";
        if (role) {
          runRoles.set(runId, role);
        } else {
          role = runRoles.get(runId) || "assistant";
        }

        const content = extractGatewayContent(messageData);
        if (content) {
          onEvent({
            type: "agent-message",
            runId,
            role,
            content,
            sessionKey: payload.sessionKey,
            agentId: agentIdFromSessionKey(payload.sessionKey),
          });
        }

        if (
          payload.state === "final" ||
          payload.state === "error" ||
          payload.state === "aborted"
        ) {
          runRoles.delete(runId);
          onEvent({
            type: "agent-message-final",
            runId,
            state: payload.state,
            agentId: agentIdFromSessionKey(payload.sessionKey),
          });
        }
        return;
      }

      if (message.event === "agent") {
        const runId = payload.runId || "none";
        const stream = payload.stream || "unknown";
        if (payload.data && payload.data.chunk) {
          onEvent({
            type: "agent-stream",
            runId,
            stream,
            chunk: payload.data.chunk,
            agentId: agentIdFromSessionKey(payload.sessionKey),
          });
          return;
        }

        if (payload.data && payload.data.phase) {
          onEvent({
            type: "agent-lifecycle",
            runId,
            phase: payload.data.phase,
            agentId: agentIdFromSessionKey(payload.sessionKey),
          });
          if (
            payload.data.phase === "end" ||
            payload.data.phase === "error"
          ) {
            runRoles.delete(runId);
          }
        }
      }
    });

    ws.on("error", (err) => {
      if (stopped) return;
      emitStatus("error", { error: err.message });
      onError(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", () => {
      if (stopped || intentionalClose) return;
      emitStatus("disconnected");
    });
  };

  open(protocolVersion, allowProtocolFallback);

  return {
    close() {
      stopped = true;
      if (ws) {
        intentionalClose = true;
        try {
          ws.close();
        } catch {}
      }
    },
  };
}

module.exports = {
  fetchGatewaySnapshot,
  streamGatewayEvents,
};
