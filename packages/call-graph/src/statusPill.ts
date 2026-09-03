/**
 * The status pill: a small badge in the page's bottom-left corner that
 * appears only when symbol navigation is not simply working — the
 * navigation server is unreachable or shutting down, the PR is still
 * building, a language service is starting or has crashed, or a question
 * is taking a while — and says which. When things come right it turns
 * green, says so, and fades out after a few seconds. A page that never has
 * trouble never sees it.
 *
 * It learns the server's side of the story from `/status` under the PR's
 * mount: a slow heartbeat while all is well, a quick one while anything is
 * off or a question is in flight. The page's own round trips report in
 * through `window.NAV_STATUS`, so a failed fetch shows up at once rather
 * than at the next heartbeat.
 */

export const STATUS_PILL_CSS = `
  .nav-pill {
    position: fixed; left: 14px; bottom: 14px; z-index: 60;
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.4rem 0.85rem 0.4rem 0.65rem;
    border-radius: 999px;
    font: 500 0.76rem/1 var(--sans, system-ui, sans-serif);
    letter-spacing: 0.01em;
    color: var(--ink);
    --pill-tint: var(--ink-faint);
    background: color-mix(in srgb, var(--pill-tint) 14%, var(--panel));
    border: 1px solid color-mix(in srgb, var(--pill-tint) 45%, transparent);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.16);
    opacity: 0; transform: translateY(10px) scale(0.96);
    pointer-events: none;
    transition:
      opacity 0.4s ease,
      transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1),
      background-color 0.5s ease,
      border-color 0.5s ease;
  }
  .nav-pill.shown { opacity: 1; transform: none; pointer-events: auto; }
  .nav-pill[data-tone="ok"]   { --pill-tint: #16a34a; }
  .nav-pill[data-tone="busy"] { --pill-tint: var(--accent); }
  .nav-pill[data-tone="warn"] { --pill-tint: #d97706; }
  .nav-pill[data-tone="down"] { --pill-tint: #dc2626; }
  @media (prefers-color-scheme: dark) {
    .nav-pill[data-tone="ok"]   { --pill-tint: #4ade80; }
    .nav-pill[data-tone="warn"] { --pill-tint: #fbbf24; }
    .nav-pill[data-tone="down"] { --pill-tint: #f87171; }
  }
  .nav-pill .dot {
    flex: none; width: 8px; height: 8px; border-radius: 50%;
    background: var(--pill-tint);
    transition: background-color 0.5s ease;
  }
  .nav-pill[data-tone="busy"] .dot,
  .nav-pill[data-tone="warn"] .dot { animation: nav-pill-pulse 1.3s ease-in-out infinite; }
  @keyframes nav-pill-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .nav-pill .nav-pill-text { transition: opacity 0.16s ease; }
  .nav-pill .nav-pill-text.swap { opacity: 0; }
  @media (prefers-reduced-motion: reduce) {
    .nav-pill, .nav-pill .dot, .nav-pill .nav-pill-text { transition: none; animation: none; }
  }
`;

export const STATUS_PILL_JS = `
/* The status pill. Silent on a static copy: there is no server to speak of. */
(function () {
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  var HEARTBEAT = 10000;      /* how often to look while all is well */
  var FAST = 1500;            /* how often to look while something is off or in flight */
  var SLOW_ANSWER = 600;      /* a question outstanding this long is worth mentioning */
  var LINGER = 5000;          /* how long the green pill stays before fading */
  var STATES = {
    offline:  { tone: "down", label: "Navigation server unreachable" },
    gone:     { tone: "down", label: "PR not loaded on the navigation server" },
    stopping: { tone: "warn", label: "Navigation server shutting down" },
    building: { tone: "warn", label: "PR still building" },
    broken:   { tone: "down", label: "PR build failed" },
    crashed:  { tone: "down", label: "Language service crashed \\u00b7 restarting" },
    starting: { tone: "warn", label: "Starting language services" },
    busy:     { tone: "busy", label: "Resolving symbol\\u2026" },
    ok:       { tone: "ok",   label: "Navigation ready" }
  };
  var el = document.createElement("div");
  el.className = "nav-pill";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = '<span class="dot"></span><span class="nav-pill-text"></span>';
  var text = el.querySelector(".nav-pill-text");
  var state = "hidden";
  var inflight = 0;
  var pollTimer = null, hideTimer = null, slowTimer = null;
  function mount() { if (!el.parentNode) document.body.appendChild(el); }
  function setLabel(label) {
    if (text.textContent === label) return;
    if (!el.classList.contains("shown")) { text.textContent = label; return; }
    text.classList.add("swap");
    setTimeout(function () { text.textContent = label; text.classList.remove("swap"); }, 160);
  }
  /* Move to a state. "ok" is only worth showing as a recovery: a page that
     was never in trouble stays quiet, one that was turns green and fades. */
  function apply(next) {
    if (next === "ok" && (state === "hidden" || state === "ok")) return;
    if (next === state) return;
    clearTimeout(hideTimer); hideTimer = null;
    state = next;
    mount();
    el.dataset.tone = STATES[next].tone;
    setLabel(STATES[next].label);
    el.classList.add("shown");
    if (next === "ok") {
      hideTimer = setTimeout(function () { el.classList.remove("shown"); state = "hidden"; }, LINGER);
    }
  }
  function classify(s) {
    if (s.gone) return "gone";
    if (s.stopping) return "stopping";
    if (s.pr === "failed") return "broken";
    if (s.pr && s.pr !== "ready") return "building";
    if (s.services === "failed") return "crashed";
    if (s.services === "starting") return "starting";
    if (s.busy > 0 || inflight > 0) return "busy";
    return "ok";
  }
  function schedule() {
    clearTimeout(pollTimer);
    var quiet = (state === "hidden" || state === "ok") && inflight === 0;
    pollTimer = setTimeout(poll, quiet || document.hidden ? HEARTBEAT : FAST);
  }
  function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    var ctrl = window.AbortController ? new AbortController() : null;
    var deadline = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
    fetch(navUrl("/status"), { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (r.status === 404) return { gone: true };
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(function (s) { apply(classify(s)); }, function () { apply("offline"); })
      .then(function () { if (deadline) clearTimeout(deadline); schedule(); });
  }
  function pollSoon(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  window.NAV_STATUS = {
    /* A question left for the server. */
    begin: function () {
      inflight++;
      if (!slowTimer) slowTimer = setTimeout(function () { slowTimer = null; if (inflight > 0) poll(); }, SLOW_ANSWER);
    },
    /* ...and came back: fine, or not. A failure is looked into right away. */
    end: function (ok) {
      inflight = Math.max(0, inflight - 1);
      if (!ok) { pollSoon(0); return; }
      if (inflight === 0) apply("ok");
    },
    state: function () { return state; }
  };
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollSoon(200); });
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
  pollSoon(0);
})();
`;
