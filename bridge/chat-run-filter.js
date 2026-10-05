function isSubagentSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return false;
  const raw = sessionKey.trim().toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("subagent:")) return true;
  const parts = raw.split(":");
  return parts[0] === "agent" && parts.length >= 3 && parts[2] === "subagent";
}

function createChatRunTracker(runId) {
  const state = {
    runId: runId || null,
    sessionKey: null,
    awaitingSuccessor: false,
  };

  const adoptAck = (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (typeof payload.runId === "string" && payload.runId) {
      state.runId = payload.runId;
    }
    if (
      typeof payload.sessionKey === "string" &&
      payload.sessionKey &&
      !state.sessionKey
    ) {
      state.sessionKey = payload.sessionKey;
    }
  };

  const classify = (payload) => {
    const event = payload || {};
    const eventRunId =
      typeof event.runId === "string" && event.runId ? event.runId : null;
    const eventSessionKey =
      typeof event.sessionKey === "string" && event.sessionKey
        ? event.sessionKey
        : null;

    if (isSubagentSessionKey(eventSessionKey) || event.spawnedBy) {
      return { action: "ignore", reason: "subagent" };
    }

    if (eventRunId && state.runId && eventRunId === state.runId) {
      if (eventSessionKey && !state.sessionKey) {
        state.sessionKey = eventSessionKey;
      }
      if (event.state === "final" && event.yielded === true) {
        state.awaitingSuccessor = true;
        return { action: "yield", reason: "yielded" };
      }
      return { action: "accept", reason: "own-run" };
    }

    if (eventRunId) {
      if (
        state.awaitingSuccessor &&
        eventSessionKey &&
        state.sessionKey &&
        eventSessionKey === state.sessionKey
      ) {
        state.runId = eventRunId;
        state.awaitingSuccessor = false;
        if (event.state === "final" && event.yielded === true) {
          state.awaitingSuccessor = true;
          return { action: "yield", reason: "yielded" };
        }
        return { action: "accept", reason: "successor-run" };
      }
      return { action: "ignore", reason: "other-run" };
    }

    if (
      eventSessionKey &&
      state.sessionKey &&
      eventSessionKey !== state.sessionKey
    ) {
      return { action: "ignore", reason: "other-session" };
    }
    return { action: "accept", reason: "no-run-id" };
  };

  return { adoptAck, classify, state };
}

module.exports = { createChatRunTracker, isSubagentSessionKey };
