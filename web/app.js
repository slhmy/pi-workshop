import { renderMarkdown } from "./markdown.js?v=4";

const transcript = document.querySelector("[data-transcript]");
const messageList = document.querySelector("[data-message-list]");
const emptyState = document.querySelector("[data-empty-state]");
const composer = document.querySelector("[data-composer]");
const promptInput = document.querySelector("[data-prompt]");
const sendButton = document.querySelector("[data-send]");
const sendLabel = document.querySelector("[data-send-label]");
const abortButton = document.querySelector("[data-abort]");
const abortLabel = document.querySelector("[data-abort-label]");
const newSessionButton = document.querySelector("[data-new-session]");
const newSessionLabel = document.querySelector("[data-new-session-label]");
const statusElement = document.querySelector("[data-agent-status]");
const statusLabel = document.querySelector("[data-status-label]");
const queueStatus = document.querySelector("[data-queue-status]");
const queueHint = document.querySelector("[data-queue-hint]");
const voiceInputButton = document.querySelector("[data-voice-input]");
const voiceStatus = document.querySelector("[data-voice-status]");
const activityPanel = document.querySelector("[data-activity-panel]");
const activityToggle = document.querySelector("[data-activity-toggle]");
const activityList = document.querySelector("[data-activity-list]");
const activityCount = document.querySelector("[data-activity-count]");
const traceStage = document.querySelector("[data-trace-stage]");
const traceTitle = document.querySelector("[data-trace-title]");
const traceDetail = document.querySelector("[data-trace-detail]");
const traceTurns = document.querySelector("[data-trace-turns]");
const traceTools = document.querySelector("[data-trace-tools]");
const traceTokens = document.querySelector("[data-trace-tokens]");
const traceElapsed = document.querySelector("[data-trace-elapsed]");
const jumpButton = document.querySelector("[data-jump-latest]");
const notice = document.querySelector("[data-notice]");
const noticeText = document.querySelector("[data-notice-text]");
const dismissNotice = document.querySelector("[data-dismiss-notice]");
const announcer = document.querySelector("[data-announcer]");
const hardRefreshButton = document.querySelector("[data-hard-refresh]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const themeIcon = document.querySelector("[data-theme-icon]");
const themeColorMeta = document.querySelector("[data-theme-color]");
const messageTemplate = document.querySelector("#message-template");

const agent = {
  connection: "connecting",
  lifecycle: "unknown",
  streaming: false,
  pending: 0,
  stopping: false,
  error: "",
};

let promptSending = false;
let sessionChanging = false;
let sessionVersion = 0;
let messagesRequest = 0;
let appliedMessagesRequest = 0;
let activeLiveMessage = null;
let activeConversationStatus = null;
let liveParts = new Map();
let transientMessages = [];
let activityEntries = 0;
let activitySequence = 0;
let activityWasManuallyToggled = false;
let autoFollow = true;
let networkNoticeVisible = false;
let lastQueueCount = 0;
let speechRecognition = null;
let voiceListening = false;
let voiceStarting = false;
let voiceStopping = false;
let voiceAcceptResults = false;
let voiceBaseText = "";
let voiceLastError = "";
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceInputSupported = Boolean(
  typeof SpeechRecognitionApi === "function"
  && window.isSecureContext
  && SpeechRecognitionApi.prototype
  && "processLocally" in SpeechRecognitionApi.prototype
);
const generatedImageMimeTypes = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const maximumGeneratedImageLength = 24 * 1024 * 1024;
const activeTools = new Map();
const observedToolCallIds = new Set();
const persistedToolElements = new Map();
const runTrace = {
  startedAt: null,
  elapsed: null,
  turns: 0,
  tools: 0,
  tokens: null,
  title: "Ready",
  detail: "Waiting for an instruction",
  kind: "idle",
};
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function storedColorTheme() {
  try {
    const theme = window.localStorage.getItem("pi-color-theme");
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

function applyColorTheme(theme, persist = false) {
  const resolvedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  themeIcon.setAttribute("href", `/icons.svg?v=1#${resolvedTheme === "dark" ? "sun" : "moon"}`);
  const label = `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`;
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
  themeColorMeta.content = resolvedTheme === "dark" ? "#09090b" : "#f8fafc";

  if (persist) {
    try {
      window.localStorage.setItem("pi-color-theme", resolvedTheme);
    } catch {
      // The active theme still works when storage is unavailable.
    }
  }
}

function listenForMediaChange(query, listener) {
  if (typeof query.addEventListener === "function") query.addEventListener("change", listener);
  else if (typeof query.addListener === "function") query.addListener(listener);
}

function createUiIcon(name, className = "") {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  const use = document.createElementNS(namespace, "use");
  icon.setAttribute("class", `ui-icon ${className}`.trim());
  icon.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `/icons.svg?v=4#${name}`);
  icon.append(use);
  return icon;
}

function announce(message) {
  announcer.textContent = "";
  window.setTimeout(() => {
    announcer.textContent = message;
  }, 20);
}

function setNotice(message, kind = "error", isNetwork = false) {
  notice.hidden = false;
  notice.dataset.kind = kind;
  noticeText.textContent = message;
  networkNoticeVisible = isNetwork;
}

function clearNotice(networkOnly = false) {
  if (networkOnly && !networkNoticeVisible) return;
  notice.hidden = true;
  noticeText.textContent = "";
  networkNoticeVisible = false;
}

function renderAgentState() {
  let state = "idle";
  let label = "Pi is ready";

  if (navigator.onLine === false) {
    state = "disconnected";
    label = "Offline";
  } else if (agent.connection !== "connected") {
    state = agent.connection === "connecting" ? "connecting" : "disconnected";
    label = agent.connection === "connecting" ? "Connecting" : "Reconnecting";
  } else if (agent.lifecycle === "restarting") {
    state = "error";
    label = "Pi is restarting";
  } else if (agent.lifecycle === "starting") {
    state = "connecting";
    label = "Pi is starting";
  } else if (agent.error) {
    state = "error";
    label = "Agent error";
  } else if (agent.stopping) {
    state = "running";
    label = "Stopping Pi";
  } else if (agent.streaming) {
    state = "running";
    label = "Pi is working";
  }

  statusElement.dataset.state = state;
  statusLabel.textContent = label;
  statusElement.title = agent.error || label;

  const pending = Math.max(0, Number(agent.pending) || 0);
  queueStatus.hidden = pending === 0;
  queueStatus.textContent = pending === 1 ? "1 queued" : `${pending} queued`;

  if (pending > 0) {
    queueHint.hidden = false;
    queueHint.textContent = `${pending} follow-up${pending === 1 ? " is" : "s are"} queued. New instructions join the queue.`;
  } else if (agent.streaming) {
    queueHint.hidden = false;
    queueHint.textContent = "Pi is working. Send now to queue a follow-up.";
  } else {
    queueHint.hidden = true;
    queueHint.textContent = "";
  }

  const unavailable = agent.lifecycle === "restarting" || agent.lifecycle === "starting" || navigator.onLine === false;
  sendButton.disabled = promptSending || unavailable;
  sendLabel.textContent = agent.streaming ? "Queue follow-up" : "Send instruction";
  composer.dataset.mode = agent.streaming ? "queue" : "ready";

  abortButton.hidden = !agent.streaming && !agent.stopping;
  abortButton.disabled = agent.stopping || unavailable;
  abortLabel.textContent = agent.stopping ? "Stopping…" : "Stop run";

  newSessionButton.disabled = sessionChanging || unavailable;
  newSessionLabel.textContent = sessionChanging ? "Starting…" : "New session";
  voiceInputButton.disabled = !voiceInputSupported || sessionChanging || promptSending || unavailable;
  updateTraceOverview();
}

function isNearTranscriptEnd() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
}

function updateJumpButton() {
  jumpButton.hidden = autoFollow || messageList.children.length === 0;
}

function scrollTranscript(force = false, smooth = false) {
  if (!force && !autoFollow) return;
  window.requestAnimationFrame(() => {
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    autoFollow = true;
    updateJumpButton();
  });
}

function errorMessage(error, fallback = "Request failed") {
  return error instanceof Error && error.message ? error.message : fallback;
}

function contentText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n");
}

function generatedImages(message) {
  if (!message || message.role !== "toolResult" || message.toolName !== "generate_image" || !Array.isArray(message.content)) {
    return [];
  }

  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object" || part.type !== "image" || typeof part.data !== "string") return [];
    const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
    const extension = generatedImageMimeTypes.get(mimeType);
    const data = part.data;
    if (
      !extension
      || !data
      || data.length > maximumGeneratedImageLength
      || data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
    ) {
      return [];
    }
    return [{ data, mimeType, extension }];
  });
}

function normalizedMessage(message) {
  const images = generatedImages(message);
  if (images.length > 0) {
    return {
      role: "assistant",
      text: "",
      timestamp: message.timestamp,
      failed: false,
      generatedMedia: true,
      images,
    };
  }
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;

  let text = contentText(message);
  let failed = false;
  if (!text && message.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage) {
    text = `Response stopped: ${message.errorMessage}`;
    failed = true;
  }
  if (!text) return null;

  return {
    role: message.role,
    text,
    timestamp: message.timestamp,
    failed,
    generatedMedia: false,
    images: [],
  };
}

function formattedTime(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date),
  };
}

function renderMessageBody(body, text, markdown = true) {
  body.dataset.markdown = String(markdown);
  if (markdown) renderMarkdown(body, text);
  else {
    body.textContent = "";
    body.append(document.createTextNode(text));
  }
}

function appendGeneratedImages(body, images) {
  const gallery = document.createElement("div");
  gallery.className = "generated-image-gallery";

  for (const [index, image] of images.entries()) {
    const dataUrl = `data:${image.mimeType};base64,${image.data}`;
    const figure = document.createElement("figure");
    const preview = document.createElement("a");
    const picture = document.createElement("img");
    const caption = document.createElement("figcaption");
    const label = document.createElement("span");
    const download = document.createElement("a");

    figure.className = "generated-image";
    preview.className = "generated-image-preview";
    preview.href = dataUrl;
    preview.target = "_blank";
    preview.rel = "noopener noreferrer";
    preview.setAttribute("aria-label", "Open generated image in a new tab");
    picture.src = dataUrl;
    picture.alt = "Image generated by Pi";
    picture.loading = "lazy";
    picture.decoding = "async";
    label.textContent = images.length === 1 ? "Generated image" : `Generated image ${index + 1}`;
    download.className = "generated-image-action";
    download.href = dataUrl;
    download.download = `pi-generated-image-${index + 1}.${image.extension}`;
    download.append(createUiIcon("download"), document.createTextNode(`Download ${image.extension.toUpperCase()}`));
    preview.append(picture);
    caption.append(label, download);
    figure.append(preview, caption);
    gallery.append(figure);
  }

  body.append(gallery);
}

function createMessageElement(message, { streaming = false, persisted = false } = {}) {
  const fragment = messageTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".message");
  const author = fragment.querySelector(".message-author");
  const time = fragment.querySelector(".message-time");
  const body = fragment.querySelector(".message-body");

  article.dataset.role = message.role;
  article.dataset.streaming = String(streaming);
  if (persisted) article.dataset.persisted = "true";
  if (message.failed) article.dataset.kind = "error";
  if (message.generatedMedia) article.dataset.kind = "media";
  author.textContent = message.role === "user"
    ? "You / instruction"
    : message.generatedMedia ? "Pi / generated image" : "Pi / response";
  renderMessageBody(body, message.text, !message.generatedMedia);
  if (message.generatedMedia) appendGeneratedImages(body, message.images);

  const displayTime = formattedTime(message.timestamp);
  if (displayTime) {
    time.hidden = false;
    time.dateTime = displayTime.dateTime;
    time.textContent = displayTime.label;
  }

  return article;
}

function reconcileTransientMessages(messages) {
  const assistantTexts = new Set(
    messages
      .filter((message) => message.role === "assistant" && !message.generatedMedia)
      .map((message) => message.text),
  );
  const remaining = [];

  for (const transient of transientMessages) {
    const canRemove = transient.complete && (!transient.text || assistantTexts.has(transient.text));
    if (canRemove) {
      transient.element.remove();
    } else {
      remaining.push(transient);
    }
  }
  transientMessages = remaining;
}

function renderMessages(messages) {
  const follow = autoFollow;
  const normalized = Array.isArray(messages) ? messages.map(normalizedMessage).filter(Boolean) : [];

  messageList.querySelectorAll("[data-persisted]").forEach((element) => element.remove());
  const firstTransient = messageList.querySelector(".message:not([data-persisted])");
  for (const message of normalized) {
    messageList.insertBefore(createMessageElement(message, { persisted: true }), firstTransient);
  }

  reconcileTransientMessages(normalized);
  emptyState.hidden = normalized.length > 0 || transientMessages.length > 0 || Boolean(activeConversationStatus);
  if (follow) scrollTranscript(true);
  else updateJumpButton();
}

function updateConversationStatusMetrics() {
  if (!activeConversationStatus) return;
  const elapsed = runTrace.startedAt === null
    ? Date.now() - activeConversationStatus.startedAt
    : performance.now() - runTrace.startedAt;
  const parts = [];
  if (runTrace.turns > 0) parts.push(`Turn ${runTrace.turns}`);
  parts.push(`${runTrace.tools} tool${runTrace.tools === 1 ? "" : "s"}`);
  parts.push(formatDuration(Math.max(0, elapsed)));
  activeConversationStatus.metrics.textContent = parts.join(" · ");
}

function showConversationStatus(title, detail = "") {
  if (activeLiveMessage && !activeLiveMessage.complete) return;
  if (!activeConversationStatus) {
    const startedAt = Date.now();
    const element = createMessageElement(
      { role: "assistant", text: "", timestamp: startedAt },
      { streaming: true },
    );
    const author = element.querySelector(".message-author");
    const body = element.querySelector(".message-body");
    const progress = document.createElement("div");
    const indicator = document.createElement("span");
    const copy = document.createElement("span");
    const heading = document.createElement("strong");
    const secondary = document.createElement("small");
    const metrics = document.createElement("span");

    element.dataset.progress = "true";
    author.textContent = "Pi / working";
    body.dataset.markdown = "false";
    body.textContent = "";
    progress.className = "conversation-progress";
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    progress.setAttribute("aria-atomic", "true");
    indicator.className = "conversation-progress-indicator";
    indicator.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) indicator.append(document.createElement("i"));
    copy.className = "conversation-progress-copy";
    secondary.className = "conversation-progress-detail";
    metrics.className = "conversation-progress-metrics";
    metrics.setAttribute("aria-hidden", "true");
    copy.append(heading, secondary, metrics);
    progress.append(indicator, copy);
    body.append(progress);
    messageList.append(element);
    activeConversationStatus = { element, heading, secondary, metrics, startedAt };
    emptyState.hidden = true;
  }

  activeConversationStatus.heading.textContent = title;
  activeConversationStatus.secondary.textContent = detail;
  activeConversationStatus.secondary.hidden = !detail;
  updateConversationStatusMetrics();
  scrollTranscript();
}

function clearConversationStatus() {
  if (!activeConversationStatus) return;
  activeConversationStatus.element.remove();
  activeConversationStatus = null;
  emptyState.hidden = messageList.children.length > 0;
}

function startLiveAssistant() {
  if (activeLiveMessage) return activeLiveMessage;

  clearConversationStatus();
  const element = createMessageElement({ role: "assistant", text: "" }, { streaming: true });
  const transient = { element, role: "assistant", text: "", complete: false };
  transientMessages.push(transient);
  messageList.append(element);
  activeLiveMessage = transient;
  emptyState.hidden = true;
  scrollTranscript();
  return transient;
}

function streamedText() {
  return [...liveParts.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, text]) => text)
    .filter(Boolean)
    .join("\n\n");
}

function updateLiveAssistant(markdown = false) {
  const live = startLiveAssistant();
  live.text = streamedText();
  renderMessageBody(live.element.querySelector(".message-body"), live.text, markdown);
  scrollTranscript();
}

function completeLiveAssistant(message) {
  const finalText = contentText(message);
  if (finalText) clearConversationStatus();
  let live = activeLiveMessage;

  if (!live && finalText) {
    const element = createMessageElement({ role: "assistant", text: finalText });
    live = { element, role: "assistant", text: finalText, complete: true };
    transientMessages.push(live);
    messageList.append(element);
  } else if (live) {
    if (finalText) {
      live.text = finalText;
      renderMessageBody(live.element.querySelector(".message-body"), finalText);
    }
    live.complete = true;
    live.element.dataset.streaming = "false";
  }

  activeLiveMessage = null;
  liveParts = new Map();
  emptyState.hidden = messageList.children.length > 0;
  scrollTranscript();
}

function resetConversation() {
  messageList.replaceChildren();
  transientMessages = [];
  activeLiveMessage = null;
  activeConversationStatus = null;
  liveParts = new Map();
  emptyState.hidden = false;
  autoFollow = true;
  updateJumpButton();
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatMetric(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function updateTraceOverview() {
  const elapsed = runTrace.startedAt === null ? runTrace.elapsed : performance.now() - runTrace.startedAt;
  traceStage.dataset.kind = runTrace.kind;
  traceTitle.textContent = runTrace.title;
  traceDetail.textContent = runTrace.detail;
  traceTurns.textContent = String(runTrace.turns);
  traceTools.textContent = String(runTrace.tools);
  traceTokens.textContent = formatMetric(runTrace.tokens);
  traceElapsed.textContent = formatDuration(elapsed);
}

function setTraceStage(title, detail, kind = "active") {
  runTrace.title = title;
  runTrace.detail = detail;
  runTrace.kind = kind;
  updateTraceOverview();
  if (agent.streaming && runTrace.startedAt !== null) showConversationStatus(title, detail);
}

function startRunTrace(detail = "Processing instruction") {
  if (runTrace.startedAt === null) {
    runTrace.startedAt = performance.now();
    runTrace.elapsed = null;
    runTrace.turns = 0;
    runTrace.tools = 0;
    runTrace.tokens = null;
  }
  setTraceStage("Working", detail, "active");
}

function settleRunTrace() {
  if (runTrace.startedAt !== null) runTrace.elapsed = performance.now() - runTrace.startedAt;
  runTrace.startedAt = null;
  setTraceStage(
    "Run complete",
    `${runTrace.tools} tool${runTrace.tools === 1 ? "" : "s"} across ${runTrace.turns} turn${runTrace.turns === 1 ? "" : "s"}`,
    "done",
  );
}

function resetRunTrace() {
  runTrace.startedAt = null;
  runTrace.elapsed = null;
  runTrace.turns = 0;
  runTrace.tools = 0;
  runTrace.tokens = null;
  setTraceStage("Ready", "Waiting for an instruction", "idle");
}

function recordUsage(usage) {
  if (!usage || typeof usage !== "object") return;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total >= 0) {
    runTrace.tokens = total;
    updateTraceOverview();
  }
}

function updateActivitySummary() {
  const active = activeTools.size;
  activityCount.textContent = active > 0 ? `${active} active` : `${activityEntries} recent`;
}

function trimActivities() {
  while (activityList.children.length > 24) {
    const removed = activityList.lastElementChild;
    for (const [key, tool] of activeTools) {
      if (tool.element === removed) activeTools.delete(key);
    }
    for (const [key, element] of persistedToolElements) {
      if (element === removed) persistedToolElements.delete(key);
    }
    removed.remove();
    activityEntries -= 1;
  }
}

function activityTimestamp(value) {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 86_400_000 ? timestamp : null;
}

function detailedActivityTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

function safeShellCommand(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  if (/\/run\/secrets(?:\/|$)|private[\s_-]*key/iu.test(value)) return "Command redacted for safety";

  let command = value
    .replace(/[\r\n]+/gu, " ↵ ")
    .replace(/\s+/gu, " ")
    .trim();
  command = command
    .replace(/(\b(?:api[-_]?key|access[-_]?key|secret|token|password|passwd|credential)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/giu, "$1[redacted]")
    .replace(/((?:--?|\/)\s*(?:api[-_]?key|access[-_]?key|secret|token|password|passwd|credential)\s+)("[^"]*"|'[^']*'|\S+)/giu, "$1[redacted]")
    .replace(/(\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+)(\S+)/giu, "$1[redacted]")
    .replace(/(\bbearer\s+)(\S+)/giu, "$1[redacted]")
    .replace(/(\b(?:api[-_]?key|access[-_]?key|secret|token|password|passwd|credential)=)([^&\s]+)/giu, "$1[redacted]");
  return command.length > 240 ? `${command.slice(0, 224)}…[truncated]` : command;
}

function toolActivityMetadata(toolName, args, options = {}) {
  const metadata = [];
  const target = safeWorkspaceTarget(args);
  if (options.source) metadata.push(["Source", options.source]);
  if (target) metadata.push(["Target", target]);

  if (toolName === "edit" && Array.isArray(args?.edits)) {
    const count = args.edits.length;
    metadata.push(["Changes", `${count} replacement${count === 1 ? "" : "s"}`]);
  } else if (toolName === "read") {
    const offset = Number(args?.offset);
    const limit = Number(args?.limit);
    const hasOffset = Number.isSafeInteger(offset) && offset > 0 && offset <= 1_000_000_000;
    const hasLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000_000_000;
    if (hasOffset && hasLimit) metadata.push(["Range", `Lines ${offset}–${offset + limit - 1}`]);
    else if (hasOffset) metadata.push(["Range", `From line ${offset}`]);
    else if (hasLimit) metadata.push(["Range", `First ${limit} lines`]);
  } else if (toolName === "bash") {
    const command = safeShellCommand(args?.command);
    if (command) metadata.push(["Command", command]);
  }

  if (options.startedAt) metadata.push(["Started", detailedActivityTime(options.startedAt)]);
  if (options.endedAt) metadata.push(["Finished", detailedActivityTime(options.endedAt)]);
  if (options.duration) metadata.push(["Duration", options.duration]);
  if (options.outcome) metadata.push(["Outcome", options.outcome]);
  return metadata;
}

function collectPersistedToolActivities(messages) {
  const records = [];
  const byId = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || part.type !== "toolCall") continue;
        const id = typeof part.id === "string" ? part.id : "";
        const record = {
          id,
          toolName: typeof part.name === "string" ? part.name : "",
          args: part.arguments && typeof part.arguments === "object" ? part.arguments : null,
          startedAt: activityTimestamp(message.timestamp),
          endedAt: null,
          isError: null,
        };
        records.push(record);
        if (id) byId.set(id, record);
      }
      continue;
    }

    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      let record = id ? byId.get(id) : null;
      if (!record) {
        record = {
          id,
          toolName: typeof message.toolName === "string" ? message.toolName : "",
          args: null,
          startedAt: null,
          endedAt: null,
          isError: null,
        };
        records.push(record);
        if (id) byId.set(id, record);
      }
      record.endedAt = activityTimestamp(message.timestamp);
      record.isError = Boolean(message.isError);
    }
  }

  return records;
}

function persistedToolDuration(record) {
  return record.startedAt && record.endedAt && record.endedAt >= record.startedAt
    ? formatDuration(record.endedAt - record.startedAt)
    : "";
}

function persistedToolDetail(record) {
  const target = safeWorkspaceTarget(record.args);
  const finished = record.isError !== null;
  const parts = [finished ? record.isError ? "Failed" : "Completed" : "Recorded in Pi session"];
  const duration = persistedToolDuration(record);
  if (duration) parts.push(duration);
  if (target) parts.push(target);
  else if (record.toolName === "bash") parts.push("Workspace command");
  return parts.join(" · ");
}

function renderPersistedActivities(messages) {
  const previous = [...activityList.querySelectorAll('[data-activity-source="session"]')];
  for (const item of previous) item.remove();
  persistedToolElements.clear();
  activityEntries = Math.max(0, activityEntries - previous.length);

  const records = collectPersistedToolActivities(messages)
    .filter((record) => !record.id || !observedToolCallIds.has(record.id))
    .slice(-16)
    .reverse();

  for (const record of records) {
    const kind = record.isError === null ? "history" : record.isError ? "error" : "done";
    const item = addActivity(
      friendlyToolName(record.toolName),
      kind,
      persistedToolDetail(record),
      toolIcon(record.toolName),
      {
        placement: "append",
        source: "session",
        timestamp: record.endedAt || record.startedAt || Date.now(),
        metadata: toolActivityMetadata(record.toolName, record.args, {
          source: "Pi session",
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          duration: persistedToolDuration(record),
          outcome: record.isError === null ? "No result recorded" : record.isError ? "Failed" : "Completed",
        }),
      },
    );
    if (record.id) persistedToolElements.set(record.id, item);
  }

  if (activityList.children.length === 0) {
    const placeholder = document.createElement("li");
    placeholder.className = "activity-placeholder";
    placeholder.textContent = "Tool calls and run events will appear here without interrupting the conversation.";
    activityList.append(placeholder);
  }
  updateActivitySummary();
}

function activityStatus(kind) {
  if (kind === "error") return "Failed";
  if (kind === "done") return "Done";
  if (kind === "history") return "Previous";
  return "Running";
}

function activityIcon(kind) {
  if (kind === "error") return "triangle-alert";
  if (kind === "done") return "circle-check";
  return "circle-dot";
}

function highlightShellCommand(container, value) {
  const tokens = value.match(/(?:'[^']*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`|#[^\n]*|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z0-9][A-Za-z0-9_-]*|&&|\|\||>>|[|;&><]|\b\d+(?:\.\d+)?\b|\s+|.)/gu) || [];
  let firstWord = true;
  for (const token of tokens) {
    if (/^\s+$/u.test(token)) {
      container.append(document.createTextNode(token));
      continue;
    }

    let kind = "argument";
    if (token.startsWith("#")) kind = "comment";
    else if (/^(?:'|\"|`)/u.test(token)) kind = "string";
    else if (token.startsWith("$")) kind = "variable";
    else if (/^(?:--?|\/)[A-Za-z0-9]/u.test(token)) kind = "flag";
    else if (/^(?:&&|\|\||>>|[|;&><])$/u.test(token)) kind = "operator";
    else if (/^\d/u.test(token)) kind = "number";
    else if (token === "[redacted]") kind = "redacted";
    else if (firstWord) kind = "command";

    const part = document.createElement("span");
    part.className = `shell-token shell-token-${kind}`;
    part.textContent = token;
    container.append(part);
    if (kind !== "comment") firstWord = false;
  }
}

function setActivityMetadata(item, entries) {
  const copy = item.querySelector(".activity-copy");
  const existing = copy.querySelector(".activity-details");
  const wasOpen = Boolean(existing?.open);
  existing?.remove();

  const metadata = (Array.isArray(entries) ? entries : [])
    .filter((entry) => Array.isArray(entry) && entry.length === 2 && entry[0] && entry[1] !== undefined && entry[1] !== null && entry[1] !== "")
    .map(([label, value]) => [String(label), String(value)]);
  if (metadata.length === 0) return;

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const list = document.createElement("dl");
  details.className = "activity-details";
  details.open = wasOpen || metadata.some(([label]) => label === "Command");
  summary.textContent = "Details";
  list.className = "activity-metadata";

  for (const [label, value] of metadata) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    if (label === "Command") {
      const command = document.createElement("code");
      command.className = "activity-command";
      highlightShellCommand(command, value);
      description.append(command);
    } else {
      description.textContent = value;
    }
    list.append(term, description);
  }

  details.append(summary, list);
  copy.append(details);
}

function appendActivityMetadata(item, additions) {
  const current = [];
  const list = item.querySelector(".activity-metadata");
  if (list) {
    const children = [...list.children];
    for (let index = 0; index < children.length - 1; index += 2) {
      current.push([children[index].textContent, children[index + 1].textContent]);
    }
  }
  const replacementLabels = new Set(additions.map(([label]) => String(label)));
  setActivityMetadata(item, [
    ...current.filter(([label]) => !replacementLabels.has(label)),
    ...additions,
  ]);
}

function addActivity(title, kind = "active", detail = "", iconName = "", options = {}) {
  activityList.querySelector(".activity-placeholder")?.remove();

  const resolvedIcon = iconName || activityIcon(kind);
  const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
  const item = document.createElement("li");
  const icon = createUiIcon(resolvedIcon, "activity-icon");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  const secondary = document.createElement("small");
  const side = document.createElement("span");
  const status = document.createElement("span");
  const time = document.createElement("time");
  const now = new Date(timestamp);

  item.className = "activity-item";
  item.dataset.kind = kind;
  if (options.source) item.dataset.activitySource = options.source;
  copy.className = "activity-copy";
  heading.textContent = title;
  secondary.textContent = detail;
  secondary.hidden = !detail;
  side.className = "activity-side";
  status.className = "activity-status";
  status.textContent = activityStatus(kind);
  time.dateTime = now.toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now);
  copy.append(heading, secondary);
  side.append(status, time);
  item.append(icon, copy, side);
  setActivityMetadata(item, options.metadata);
  if (options.placement === "append") activityList.append(item);
  else activityList.prepend(item);

  activityEntries += 1;
  trimActivities();
  updateActivitySummary();
  return item;
}

function updateActivityItem(item, kind, detail) {
  item.dataset.kind = kind;
  const secondary = item.querySelector(".activity-copy small");
  secondary.hidden = !detail;
  secondary.textContent = detail;
  item.querySelector(".activity-status").textContent = activityStatus(kind);
}

function clearActivities() {
  activityList.replaceChildren();
  const placeholder = document.createElement("li");
  placeholder.className = "activity-placeholder";
  placeholder.textContent = "Tool calls and run events will appear here without interrupting the conversation.";
  activityList.append(placeholder);
  activeTools.clear();
  observedToolCallIds.clear();
  persistedToolElements.clear();
  activityEntries = 0;
  lastQueueCount = 0;
  resetRunTrace();
  updateActivitySummary();
}

function friendlyToolName(name) {
  const names = {
    bash: "Terminal command",
    edit: "Edit file",
    generate_image: "Generate image",
    read: "Read file",
    write: "Write file",
  };
  if (typeof name !== "string" || !name.trim()) return "Tool";
  return names[name] || name.replace(/_/gu, " ");
}

function toolIcon(name) {
  const icons = {
    bash: "terminal",
    edit: "file-pen",
    generate_image: "image",
    read: "file-text",
    write: "file-plus",
  };
  return icons[name] || "wrench";
}

function safeWorkspaceTarget(args) {
  if (!args || typeof args !== "object" || typeof args.path !== "string") return "";
  let path = args.path.trim().replace(/\\/gu, "/");
  if (!path || path.startsWith("/run/secrets") || /(^|\/)(\.env(?:\.[^/]*)?|[^/]*(credential|secret|token|private[_-]?key)[^/]*)(\/|$)/iu.test(path)) {
    return "";
  }
  const workspacePrefix = "/agent-data/workspace/";
  if (path.startsWith(workspacePrefix)) path = path.slice(workspacePrefix.length);
  else if (path.startsWith("/")) return "";
  path = path.replace(/^\.\//u, "");
  if (!path || path.split("/").includes("..")) return "";
  return path.length > 72 ? `${path.slice(0, 32)}...${path.slice(-32)}` : path;
}

function toolActivityDetail(event) {
  const target = safeWorkspaceTarget(event.args);
  if (target) {
    if (event.toolName === "edit" && Array.isArray(event.args.edits)) {
      const count = event.args.edits.length;
      return `${target} · ${count} edit${count === 1 ? "" : "s"}`;
    }
    return target;
  }
  if (event.toolName === "bash") return safeShellCommand(event.args?.command) || "Executing in workspace";
  if (event.toolName === "generate_image") return "Creating one image";
  return "Tool running";
}

function startTool(event) {
  const key = event.toolCallId || `tool-${++activitySequence}`;
  if (activeTools.has(key)) return;
  if (typeof event.toolCallId === "string") {
    observedToolCallIds.add(event.toolCallId);
    const persisted = persistedToolElements.get(event.toolCallId);
    if (persisted) {
      persisted.remove();
      persistedToolElements.delete(event.toolCallId);
      activityEntries = Math.max(0, activityEntries - 1);
    }
  }
  const started = performance.now();
  const startedAt = Date.now();
  const target = toolActivityDetail(event);
  const metadata = toolActivityMetadata(event.toolName, event.args, { source: "Live event", startedAt });
  const element = addActivity(
    friendlyToolName(event.toolName),
    "active",
    target,
    toolIcon(event.toolName),
    { metadata },
  );
  activeTools.set(key, { element, started, startedAt, name: event.toolName, target, metadata, hasProgress: false });
  runTrace.tools += 1;
  setTraceStage(friendlyToolName(event.toolName), target, "active");
  updateActivitySummary();
}

function updateTool(event) {
  const tool = event.toolCallId ? activeTools.get(event.toolCallId) : null;
  if (!tool || tool.hasProgress) return;
  tool.hasProgress = true;
  const detail = tool.target ? `${tool.target} · receiving progress` : "Receiving progress";
  updateActivityItem(tool.element, "active", detail);
  setTraceStage(friendlyToolName(tool.name), "Receiving tool progress", "active");
}

function endTool(event) {
  const key = event.toolCallId;
  if (typeof key === "string") observedToolCallIds.add(key);
  const tool = key ? activeTools.get(key) : null;
  const failed = Boolean(event.isError);
  const state = failed ? "error" : "done";
  const label = failed ? "Failed" : "Completed";

  if (!tool) {
    runTrace.tools += 1;
    const persisted = key ? persistedToolElements.get(key) : null;
    const finishedAt = Date.now();
    if (persisted) {
      delete persisted.dataset.activitySource;
      updateActivityItem(persisted, state, label);
      appendActivityMetadata(persisted, [
        ["Finished", detailedActivityTime(finishedAt)],
        ["Outcome", label],
      ]);
      persistedToolElements.delete(key);
    } else {
      addActivity(
        friendlyToolName(event.toolName),
        state,
        label,
        toolIcon(event.toolName),
        {
          metadata: toolActivityMetadata(event.toolName, null, {
            source: "Live event",
            endedAt: finishedAt,
            outcome: label,
          }),
        },
      );
    }
    setTraceStage(friendlyToolName(event.toolName), label, state);
    updateTraceOverview();
    return;
  }

  const finishedAt = Date.now();
  const duration = formatDuration(Math.max(0, performance.now() - tool.started));
  const detail = [label, duration, tool.target].filter(Boolean).join(" · ");
  updateActivityItem(tool.element, state, detail);
  setActivityMetadata(tool.element, [
    ...tool.metadata,
    ["Finished", detailedActivityTime(finishedAt)],
    ["Duration", duration],
    ["Outcome", label],
  ]);
  activeTools.delete(key);
  setTraceStage(
    failed ? `${friendlyToolName(tool.name)} failed` : "Reviewing result",
    failed ? "Tool returned an error" : activeTools.size > 0 ? `${activeTools.size} tool${activeTools.size === 1 ? "" : "s"} still running` : "Tool completed",
    failed ? "error" : "active",
  );
  updateActivitySummary();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`);
  return payload;
}

async function loadMessages({ reportError = true } = {}) {
  const request = ++messagesRequest;
  const version = sessionVersion;

  try {
    const payload = await api("/api/messages");
    if (version !== sessionVersion || sessionChanging || request < appliedMessagesRequest) return;
    appliedMessagesRequest = request;
    const messages = payload.messages || [];
    renderMessages(messages);
    renderPersistedActivities(messages);
  } catch (error) {
    if (reportError) {
      const message = errorMessage(error, "Could not load conversation");
      setNotice(message);
      addActivity("Conversation could not be loaded", "error", message);
    }
    throw error;
  }
}

async function refreshState({ reportError = true } = {}) {
  const version = sessionVersion;
  try {
    const state = await api("/api/state");
    if (version !== sessionVersion || sessionChanging) return;
    agent.lifecycle = "ready";
    agent.error = "";
    agent.streaming = Boolean(state.isStreaming);
    agent.pending = Math.max(0, Number(state.pendingMessageCount) || 0);
    lastQueueCount = agent.pending;
    if (agent.streaming && runTrace.startedAt === null) startRunTrace("Run already in progress");
    if (!agent.streaming) {
      agent.stopping = false;
      if (runTrace.startedAt !== null) settleRunTrace();
      if (!promptSending) clearConversationStatus();
    }
    renderAgentState();
  } catch (error) {
    if (reportError) {
      agent.error = errorMessage(error, "Pi state is unavailable");
      setNotice(agent.error);
      renderAgentState();
    }
    throw error;
  }
}

function beginAssistantMessage() {
  if (activeLiveMessage) {
    activeLiveMessage.complete = true;
    activeLiveMessage.element.dataset.streaming = "false";
  }
  activeLiveMessage = null;
  liveParts = new Map();
}

function handleMessageUpdate(event) {
  recordUsage(event.usage);
  const update = event.assistantMessageEvent || {};
  const index = String(Number.isFinite(update.contentIndex) ? update.contentIndex : 0);

  if (update.type === "text_start") {
    if (!activeLiveMessage) startLiveAssistant();
    if (!liveParts.has(index)) liveParts.set(index, "");
    return;
  }

  if (update.type === "text_delta") {
    if (!liveParts.has(index)) liveParts.set(index, "");
    liveParts.set(index, liveParts.get(index) + (typeof update.delta === "string" ? update.delta : ""));
    updateLiveAssistant();
    return;
  }

  if (update.type === "text_end") {
    if (typeof update.content === "string") liveParts.set(index, update.content);
    updateLiveAssistant(true);
  }
}

function handleRpcEvent(event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "control_status") {
    if (event.status === "stopped") {
      agent.lifecycle = "restarting";
      agent.streaming = false;
      agent.stopping = false;
      clearConversationStatus();
      setNotice("Pi stopped unexpectedly. The control service is restarting it.", "warning");
      setTraceStage("Pi stopped", "Restarting automatically", "error");
      addActivity("Pi process stopped", "error", "Restarting automatically", "triangle-alert");
    } else if (event.status === "starting") {
      agent.lifecycle = "starting";
      window.setTimeout(() => {
        if (agent.connection === "connected" && agent.lifecycle === "starting") {
          refreshState({ reportError: false }).catch(() => {});
        }
      }, 800);
    } else if (event.status === "running") {
      agent.lifecycle = "ready";
      clearNotice(true);
      if (runTrace.startedAt === null && runTrace.kind === "error") resetRunTrace();
    }
    renderAgentState();
    return;
  }

  if (event.type === "control_error" || event.type === "extension_error") {
    const message = typeof event.message === "string" ? event.message : typeof event.error === "string" ? event.error : "Agent error";
    agent.error = message;
    agent.stopping = false;
    setNotice(message);
    setTraceStage("Agent error", "See the latest error below", "error");
    clearConversationStatus();
    addActivity("Agent error", "error", message, "triangle-alert");
    renderAgentState();
    return;
  }

  if (event.type === "agent_start") {
    agent.error = "";
    agent.streaming = true;
    agent.stopping = false;
    startRunTrace(agent.pending > 0 ? "Processing queued work" : "Processing instruction");
    addActivity("Agent run started", "active", agent.pending > 0 ? "Processing queued work" : "Instruction accepted", "play");
    renderAgentState();
    return;
  }

  if (event.type === "agent_settled") {
    agent.streaming = false;
    agent.stopping = false;
    agent.pending = 0;
    lastQueueCount = 0;
    settleRunTrace();
    clearConversationStatus();
    addActivity("Agent run settled", "done", `Completed in ${formatDuration(runTrace.elapsed)}`, "circle-check");
    renderAgentState();
    announce("Pi finished the run.");
    loadMessages().catch(() => {});
    return;
  }

  if (event.type === "agent_end") {
    addActivity(
      "Agent pass complete",
      "done",
      event.willRetry ? "Another pass will retry automatically" : "Pass finished",
      "circle-check",
    );
    setTraceStage(event.willRetry ? "Retrying" : "Finishing run", event.willRetry ? "Automatic retry pending" : "Settling remaining work", "active");
    return;
  }

  if (event.type === "turn_start") {
    runTrace.turns += 1;
    setTraceStage("Generating response", `Turn ${runTrace.turns}`, "active");
    return;
  }

  if (event.type === "turn_end") {
    recordUsage(event.message?.usage);
    addActivity("Turn complete", "done", `Turn ${Math.max(1, runTrace.turns)} finished`, "circle-check");
    setTraceStage("Reviewing turn", "Checking for follow-up work", "active");
    return;
  }

  if (event.type === "message_start" && event.message?.role === "assistant") {
    beginAssistantMessage();
    setTraceStage("Writing response", `Turn ${Math.max(1, runTrace.turns)}`, "active");
    return;
  }

  if (event.type === "message_update") {
    handleMessageUpdate(event);
    return;
  }

  if (event.type === "message_end") {
    recordUsage(event.message?.usage);
    if (event.message?.role === "assistant") {
      const hasText = Boolean(contentText(event.message));
      completeLiveAssistant(event.message);
      if (!hasText && agent.streaming) showConversationStatus("Preparing next step", "The assistant requested additional work");
    }
    loadMessages().catch(() => {});
    return;
  }

  if (event.type === "tool_execution_start") {
    startTool(event);
    return;
  }

  if (event.type === "tool_execution_update") {
    updateTool(event);
    return;
  }

  if (event.type === "tool_execution_end") {
    endTool(event);
    return;
  }

  if (event.type === "queue_update") {
    const steeringCount = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUpCount = Array.isArray(event.followUp) ? event.followUp.length : 0;
    const nextCount = steeringCount + followUpCount;
    if (nextCount !== lastQueueCount) {
      addActivity(
        nextCount > 0 ? "Queue updated" : "Queue cleared",
        "done",
        nextCount > 0 ? `${nextCount} instruction${nextCount === 1 ? "" : "s"} pending` : "No pending instructions",
        "list-plus",
      );
    }
    agent.pending = nextCount;
    lastQueueCount = nextCount;
    if (nextCount > 0 && runTrace.startedAt !== null) {
      setTraceStage("Working", `${nextCount} follow-up${nextCount === 1 ? "" : "s"} queued`, "active");
    }
    renderAgentState();
    return;
  }

  if (event.type === "compaction_start") {
    const reasons = {
      manual: "Manual compaction",
      threshold: "Context threshold reached",
      overflow: "Context limit reached",
    };
    const detail = reasons[event.reason] || "Compacting conversation";
    setTraceStage("Preparing context", detail, "active");
    addActivity("Preparing more context", "active", detail, "refresh-cw");
    return;
  }

  if (event.type === "compaction_end") {
    if (event.aborted) {
      setTraceStage("Compaction stopped", "Context preparation was cancelled", "done");
      addActivity("Context preparation stopped", "done", "Compaction was cancelled", "circle-check");
    } else if (typeof event.errorMessage === "string" && event.errorMessage.trim()) {
      setTraceStage("Compaction failed", "Run may require attention", "error");
      addActivity("Context preparation failed", "error", event.errorMessage.slice(0, 240), "triangle-alert");
    } else if (!event.result) {
      setTraceStage("Compaction failed", "No compaction result returned", "error");
      addActivity("Context preparation failed", "error", "Compaction returned no result", "triangle-alert");
    } else {
      const before = event.result.tokensBefore;
      const after = event.result.estimatedTokensAfter;
      const detail = Number.isFinite(before) && Number.isFinite(after)
        ? `${formatMetric(before)} to about ${formatMetric(after)} tokens`
        : event.willRetry ? "Retrying the run" : "Run continuing";
      setTraceStage(event.willRetry ? "Retrying" : "Context prepared", detail, "active");
      addActivity("Context prepared", "done", detail, "circle-check");
    }
    return;
  }

  if (event.type === "auto_retry_start") {
    const attempt = Math.max(1, Number(event.attempt) || 1);
    const maximum = Math.max(attempt, Number(event.maxAttempts) || attempt);
    const delay = Math.max(0, Number(event.delayMs) || 0);
    const detail = `Attempt ${attempt} of ${maximum}${delay ? ` · in ${formatDuration(delay)}` : ""}`;
    setTraceStage("Retry scheduled", detail, "active");
    addActivity("Automatic retry", "active", detail, "refresh-cw");
    return;
  }

  if (event.type === "auto_retry_end") {
    const success = Boolean(event.success);
    const detail = `Attempt ${Math.max(1, Number(event.attempt) || 1)} ${success ? "succeeded" : "failed"}`;
    setTraceStage(success ? "Retry succeeded" : "Retry failed", detail, success ? "active" : "error");
    addActivity("Automatic retry finished", success ? "done" : "error", detail, success ? "circle-check" : "triangle-alert");
    return;
  }

  if (event.type === "summarization_retry_scheduled") {
    const attempt = Math.max(1, Number(event.attempt) || 1);
    const maximum = Math.max(attempt, Number(event.maxAttempts) || attempt);
    const detail = `Summary attempt ${attempt} of ${maximum}`;
    setTraceStage("Context retry scheduled", detail, "active");
    addActivity("Context retry scheduled", "active", detail, "refresh-cw");
    return;
  }

  if (event.type === "summarization_retry_attempt_start") {
    setTraceStage("Retrying context summary", event.source === "compaction" ? "Compacting conversation" : "Preparing branch summary", "active");
    return;
  }

  if (event.type === "summarization_retry_finished") {
    addActivity("Context retry finished", "done", "Summary retry loop completed", "circle-check");
  }
}

function connectEvents() {
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => {
    const wasDisconnected = agent.connection === "disconnected";
    agent.connection = "connected";
    clearNotice(true);
    renderAgentState();
    if (wasDisconnected) {
      addActivity("Connection restored", "done", "Live updates resumed", "circle-check");
      setTraceStage(runTrace.startedAt === null ? "Ready" : "Working", runTrace.startedAt === null ? "Live updates restored" : "Live trace resumed", runTrace.startedAt === null ? "idle" : "active");
    }
    Promise.allSettled([refreshState(), loadMessages()]);
  });

  source.addEventListener("rpc", (message) => {
    try {
      handleRpcEvent(JSON.parse(message.data));
    } catch {
      addActivity("Unreadable agent event", "error", "Live event was ignored safely");
    }
  });

  source.addEventListener("error", () => {
    const changed = agent.connection !== "disconnected";
    agent.connection = "disconnected";
    setTraceStage("Live trace paused", "REST controls remain available", "warning");
    renderAgentState();
    if (changed) setNotice("Live connection lost. Reconnecting automatically…", "warning", true);
  });
}

function renderVoiceControl(message = "", kind = "idle") {
  const active = voiceListening || voiceStarting || voiceStopping;
  voiceInputButton.dataset.listening = String(active);
  voiceInputButton.setAttribute("aria-pressed", String(active));
  voiceInputButton.setAttribute("aria-label", active ? "Stop voice input" : "Start voice input");
  voiceInputButton.title = active
    ? "Stop voice input"
    : "Start on-device voice input. Audio is not sent by this app.";
  composer.dataset.voice = active ? "listening" : "idle";
  voiceStatus.hidden = !message;
  voiceStatus.dataset.kind = kind;
  voiceStatus.textContent = message;
}

function finishVoiceInput(message, kind = "done") {
  voiceListening = false;
  voiceStarting = false;
  voiceStopping = false;
  voiceAcceptResults = false;
  speechRecognition = null;
  renderVoiceControl(message, kind);
  renderAgentState();
}

function cancelVoiceInput(message = "") {
  const recognition = speechRecognition;
  speechRecognition = null;
  voiceListening = false;
  voiceStarting = false;
  voiceStopping = false;
  voiceAcceptResults = false;
  voiceLastError = "";
  try {
    recognition?.abort();
  } catch {
    // The browser may already have ended recognition.
  }
  renderVoiceControl(message, message ? "done" : "idle");
}

function voiceRecognitionError(code) {
  const errors = {
    "audio-capture": "No microphone is available.",
    network: "On-device voice recognition encountered a network error.",
    "language-not-supported": "The on-device language pack is not available in this browser.",
    "no-speech": "No speech was detected. Try again when ready.",
    "not-allowed": "Microphone permission was denied.",
    "service-not-allowed": "Voice recognition is blocked by this browser.",
  };
  return errors[code] || "Voice input stopped unexpectedly.";
}

function startVoiceInput() {
  if (!voiceInputSupported || voiceStarting || voiceListening || voiceStopping) return;

  const recognition = new SpeechRecognitionApi();
  speechRecognition = recognition;
  voiceStarting = true;
  voiceAcceptResults = true;
  voiceLastError = "";
  voiceBaseText = promptInput.value.trimEnd();
  recognition.lang = navigator.language || document.documentElement.lang || "en-US";
  recognition.processLocally = true;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.addEventListener("start", () => {
    if (speechRecognition !== recognition) return;
    voiceStarting = false;
    voiceListening = true;
    renderVoiceControl("Listening · speech is processed on this device", "listening");
    renderAgentState();
  });

  recognition.addEventListener("result", (event) => {
    if (speechRecognition !== recognition || !voiceAcceptResults) return;
    const finalSegments = [];
    const interimSegments = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const transcriptText = event.results[index]?.[0]?.transcript;
      if (typeof transcriptText !== "string" || !transcriptText.trim()) continue;
      if (event.results[index].isFinal) finalSegments.push(transcriptText.trim());
      else interimSegments.push(transcriptText.trim());
    }
    const spokenText = [...finalSegments, ...interimSegments].join(" ").trim();
    promptInput.value = [voiceBaseText, spokenText].filter(Boolean).join(" ");
    resizeComposer();
  });

  recognition.addEventListener("error", (event) => {
    if (speechRecognition !== recognition) return;
    voiceLastError = voiceRecognitionError(event.error);
    finishVoiceInput(voiceLastError, "error");
    announce(voiceLastError);
  });

  recognition.addEventListener("end", () => {
    if (speechRecognition !== recognition) return;
    const message = voiceLastError || "Voice input stopped. Review the text before sending.";
    finishVoiceInput(message, voiceLastError ? "error" : "done");
  });

  renderVoiceControl("Starting microphone…", "listening");
  renderAgentState();
  try {
    recognition.start();
  } catch {
    finishVoiceInput("Voice input could not be started.", "error");
  }
}

function stopVoiceInput() {
  if (!speechRecognition || voiceStopping) return;
  voiceStopping = true;
  renderVoiceControl("Finishing voice input…", "listening");
  try {
    speechRecognition.stop();
  } catch {
    finishVoiceInput("Voice input stopped. Review the text before sending.");
  }
}

function initializeVoiceInput() {
  if (!voiceInputSupported) return;
  voiceInputButton.hidden = false;
  renderVoiceControl();
}

function resizeComposer() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 220)}px`;
}

async function submitPrompt() {
  const message = promptInput.value.trim();
  if (!message || promptSending) return;

  if (voiceListening || voiceStarting || voiceStopping) cancelVoiceInput();
  const queued = agent.streaming;
  promptSending = true;
  agent.error = "";
  clearNotice();
  if (!queued) showConversationStatus("Sending instruction", "Waiting for Pi to begin");
  renderAgentState();

  try {
    await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ message, ...(queued ? { streamingBehavior: "followUp" } : {}) }),
    });
    promptInput.value = "";
    resizeComposer();
    if (queued) agent.pending = Math.max(1, agent.pending + 1);
    setTraceStage(queued ? "Follow-up queued" : "Starting run", queued ? "Runs after current work" : "Waiting for Pi", "active");
    addActivity(queued ? "Follow-up queued" : "Instruction accepted", "done", queued ? "Runs after current work" : "Sent to Pi", queued ? "list-plus" : "circle-check");
    announce(queued ? "Follow-up queued." : "Instruction sent.");
    renderAgentState();
    await Promise.allSettled([loadMessages(), refreshState()]);
  } catch (error) {
    const messageText = errorMessage(error);
    if (!queued) clearConversationStatus();
    agent.error = messageText;
    setNotice(messageText);
    addActivity("Instruction not sent", "error", messageText);
    announce("Instruction was not sent.");
  } finally {
    promptSending = false;
    renderAgentState();
    if (window.matchMedia("(pointer: fine)").matches) promptInput.focus();
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt();
});

promptInput.addEventListener("input", () => {
  if (voiceListening || voiceStarting || voiceStopping) {
    cancelVoiceInput("Voice input stopped after keyboard editing.");
  } else if (!voiceStatus.hidden) {
    renderVoiceControl();
  }
  resizeComposer();
});

voiceInputButton.addEventListener("click", () => {
  if (voiceListening || voiceStarting || voiceStopping) stopVoiceInput();
  else startVoiceInput();
});
promptInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;

  if (event.key === "Escape" && agent.streaming && !abortButton.disabled) {
    event.preventDefault();
    abortButton.click();
    return;
  }

  const modifiedSend = event.key === "Enter" && (event.ctrlKey || event.metaKey);
  const plainSend = event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
  if (modifiedSend || plainSend) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

abortButton.addEventListener("click", async () => {
  if (agent.stopping) return;
  agent.stopping = true;
  setTraceStage("Stopping run", agent.pending > 0 ? "Queued follow-ups may remain" : "Waiting for Pi to stop", "warning");
  renderAgentState();

  try {
    await api("/api/abort", { method: "POST" });
    addActivity("Stop requested", "done", agent.pending > 0 ? "Queued follow-ups may still run" : "Waiting for Pi to settle", "square");
    announce("Stop requested.");
    await refreshState();
  } catch (error) {
    const message = errorMessage(error, "Could not stop the run");
    agent.stopping = false;
    agent.error = message;
    setNotice(message);
    addActivity("Stop request failed", "error", message);
    renderAgentState();
  }
});

newSessionButton.addEventListener("click", async () => {
  const activeWarning = agent.streaming || agent.pending > 0
    ? " Pi is still working or has queued follow-ups; switching sessions ends this workspace view."
    : "";
  if (!window.confirm(`Start a new empty session?${activeWarning}\n\nThe current session remains stored separately.`)) return;

  cancelVoiceInput();
  sessionChanging = true;
  renderAgentState();
  try {
    await api("/api/new-session", { method: "POST" });
    sessionVersion += 1;
    appliedMessagesRequest = messagesRequest;
    agent.streaming = false;
    agent.pending = 0;
    agent.stopping = false;
    agent.error = "";
    resetConversation();
    clearNotice();
    clearActivities();
    addActivity("New session started", "done", "Conversation is empty");
    announce("New session started.");
    sessionChanging = false;
    renderAgentState();
    await Promise.allSettled([loadMessages(), refreshState()]);
  } catch (error) {
    const message = errorMessage(error, "Could not start a new session");
    agent.error = message;
    setNotice(message);
    addActivity("New session failed", "error", message);
  } finally {
    sessionChanging = false;
    renderAgentState();
    if (window.matchMedia("(pointer: fine)").matches) promptInput.focus();
  }
});

transcript.addEventListener("scroll", () => {
  autoFollow = isNearTranscriptEnd();
  updateJumpButton();
}, { passive: true });

jumpButton.addEventListener("click", () => scrollTranscript(true, true));

dismissNotice.addEventListener("click", () => clearNotice());

hardRefreshButton.addEventListener("click", () => {
  cancelVoiceInput();
  hardRefreshButton.disabled = true;
  hardRefreshButton.dataset.refreshing = "true";
  const target = new URL(window.location.href);
  target.searchParams.set("_ui_reload", Date.now().toString(36));
  window.location.replace(target);
});

themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyColorTheme(nextTheme, true);
});

listenForMediaChange(colorSchemeQuery, (event) => {
  if (!storedColorTheme()) applyColorTheme(event.matches ? "dark" : "light");
});

function setActivityCollapsed(collapsed) {
  activityPanel.dataset.collapsed = String(collapsed);
  activityToggle.setAttribute("aria-expanded", String(!collapsed));
}

activityToggle.addEventListener("click", () => {
  activityWasManuallyToggled = true;
  setActivityCollapsed(activityPanel.dataset.collapsed !== "true");
});

const narrowLayout = window.matchMedia("(max-width: 900px)");
function syncActivityLayout(event) {
  if (!activityWasManuallyToggled) setActivityCollapsed(event.matches);
}
syncActivityLayout(narrowLayout);
listenForMediaChange(narrowLayout, syncActivityLayout);

window.addEventListener("offline", () => {
  if (voiceListening || voiceStarting || voiceStopping) cancelVoiceInput("Voice input stopped while offline.");
  agent.connection = "disconnected";
  setNotice("This device is offline. Your draft is safe in the composer.", "warning", true);
  renderAgentState();
});

window.addEventListener("online", () => {
  agent.connection = "connecting";
  renderAgentState();
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  if (event.key === "/" && !isTyping && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    promptInput.focus();
  }
  if (event.key === "Escape" && !isTyping && agent.streaming && !abortButton.disabled) abortButton.click();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && navigator.onLine !== false) {
    Promise.allSettled([refreshState({ reportError: false }), loadMessages({ reportError: false })]);
  }
});

window.setInterval(() => {
  if (document.visibilityState === "visible") {
    if (runTrace.startedAt !== null) updateTraceOverview();
    updateConversationStatusMetrics();
  }
}, 1000);

window.setInterval(() => {
  if (document.visibilityState === "visible" && navigator.onLine !== false) {
    refreshState({ reportError: false }).catch(() => {});
  }
}, 15_000);

applyColorTheme(document.documentElement.dataset.theme);
initializeVoiceInput();
renderAgentState();
Promise.allSettled([refreshState(), loadMessages()]);
connectEvents();
resizeComposer();
if (window.matchMedia("(pointer: fine)").matches) promptInput.focus();
