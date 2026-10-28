// 家の中の危ない場面さがし: 回答画面(GitHub Pages 用)。
// 回答は 1 枚ごとに Google Apps Script(config.js の ENDPOINT)へ送り、スプレッドシートに 1 行ずつ追記する。
// 送れなかった回答はブラウザに溜めておき、次の送信時・次に開いたときに送り直す。
"use strict";

const PAGE_VERSION = "2026-10-28d";
const N_ITEMS = 24;
const IDS = Array.from({ length: N_ITEMS }, (_, i) => "img" + String(i + 1).padStart(2, "0"));
const CATS = ["fire", "cut", "fall", "drop", "elec", "hygiene", "other", "none"];
const MAX_MARKS = 6;
const STORE_KEY = "risk-annotation-v1";
const LANG_KEY = "risk-annotation-lang";

// ---- 言語(日本語・英語)。文言は i18n.js ----
let lang = (() => {
  try { const l = localStorage.getItem(LANG_KEY); if (l && I18N[l]) return l; } catch (e) { /* 既定に戻す */ }
  return (navigator.language || "").toLowerCase().startsWith("ja") ? "ja" : "en";
})();
function t(key, vars = {}) {
  let s = I18N[lang][key] ?? I18N.ja[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t("title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml); // 辞書の中身だけ
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll("[data-i18n-alt]")) el.alt = t(el.dataset.i18nAlt);
  $("n-items").textContent = String(IDS.length);
  for (const b of $("cats").children) {
    b.firstChild.textContent = t("cat." + b.dataset.k);
    b.querySelector("small").textContent = t("cat." + b.dataset.k + ".sub");
    b.querySelector("small").hidden = !t("cat." + b.dataset.k + ".sub");
  }
}

const $ = (id) => document.getElementById(id);
const VIEWS = ["view-loading", "view-blocked", "view-intro", "view-item", "view-done"];
function show(v) { for (const id of VIEWS) $(id).hidden = id !== v; }

let state = null; // {id, order, answers, startedAt, pending}
let pos = 0;
let draft = null; // 今の画像で選びかけの回答 {cats, desc, action, urgency, points}
let sending = false;

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ブラウザの保存領域は、プライベートウィンドウなどで使えないことがある。そのときは再開できないだけで回答はできる
function load() {
  // URL の末尾に ?reset を付けて開くと、この端末の記録を消して新しい回答者として始める(共用 PC で順番に答えてもらう用)。
  // 再読み込みでまた消えないよう、URL からは外しておく
  if (new URLSearchParams(location.search).has("reset")) {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 使えないときは元から記録がない */ }
    history.replaceState(null, "", location.pathname);
  }
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s && s.id && Array.isArray(s.order) && s.order.length === IDS.length && s.order.every((x) => IDS.includes(x))) {
      s.answers = s.answers || {}; s.pending = s.pending || [];
      return s;
    }
  } catch (e) { /* 使えないときは新しく始める */ }
  return { id: newId(), order: shuffle(IDS), answers: {}, startedAt: null, pending: [] };
}
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 再開できないだけ */ }
}

// ---- 送信 ----
// Apps Script は preflight(OPTIONS)に答えないので、Content-Type を text/plain にして単純リクエストで送る
async function flush() {
  if (sending || !state.pending.length || !window.ENDPOINT) return;
  sending = true;
  const batch = state.pending.slice();
  let ok = false;
  try {
    const res = await fetch(window.ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ rows: batch }),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || "rejected");
    state.pending = state.pending.slice(batch.length);
    persist();
    setStatus(t("sent"));
    ok = true;
  } catch (e) {
    setStatus(t("send.fail"), true);
  } finally {
    sending = false;
  }
  // 送っている間に増えた回答があれば続けて送る
  if (ok && state.pending.length) flush();
}

function setStatus(msg, err = false) {
  for (const st of [$("status"), $("done-status")]) {
    st.textContent = msg;
    st.classList.toggle("err", err);
  }
}

function answeredCount() { return state.order.filter((id) => state.answers[id]).length; }
const isRisk = (d) => d.cats.length > 0 && !d.cats.includes("none");
function complete(d) {
  if (!d || d.cats.length === 0) return false;
  if (d.cats.includes("none")) return true;
  return d.desc.trim().length > 0 && d.urgency != null && d.points.length > 0;
}

for (const k of CATS) {
  const b = document.createElement("button");
  b.className = "cat"; b.dataset.k = k; b.setAttribute("aria-pressed", "false");
  b.append(document.createTextNode(""), document.createElement("small")); // 文言は applyLang() で入れる
  b.onclick = () => toggleCat(k);
  $("cats").append(b);
}
for (let v = 1; v <= 5; v++) {
  const b = document.createElement("button");
  b.dataset.v = String(v); b.textContent = String(v); b.setAttribute("aria-pressed", "false");
  b.onclick = () => { draft.urgency = draft.urgency === v ? null : v; renderItem(); };
  $("scale").append(b);
}

function renderItem() {
  const id = state.order[pos];
  const saved = state.answers[id];
  if (!draft) draft = saved
    ? { cats: saved.cats.slice(), desc: saved.desc || "", action: saved.action || "", urgency: saved.urgency ?? null, points: (saved.points || []).map((p) => p.slice()) }
    : { cats: [], desc: "", action: "", urgency: null, points: [] };
  $("progress").textContent = `${pos + 1} / ${state.order.length}`;
  $("answered").textContent = t("answered", { n: answeredCount() });
  $("bar").style.width = `${(answeredCount() / state.order.length) * 100}%`;
  if ($("shot").dataset.id !== id) { $("shot").src = `img/${id}.jpg`; $("shot").dataset.id = id; }
  for (const b of $("cats").children) b.setAttribute("aria-pressed", String(draft.cats.includes(b.dataset.k)));
  $("desc-box").hidden = !isRisk(draft);
  $("desc").value = draft.desc;
  $("action-box").hidden = !isRisk(draft);
  $("action").value = draft.action;
  $("urgency-box").hidden = !isRisk(draft);
  for (const b of $("scale").children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === draft.urgency));
  $("markbar").hidden = !isRisk(draft);
  $("stage").classList.toggle("marking", isRisk(draft));
  renderDots();
  $("prev").disabled = pos === 0;
  $("next").textContent = pos === state.order.length - 1 ? t("finish") : t("next");
  updateNext();
  show("view-item");
}

function renderDots() {
  for (const d of $("stage").querySelectorAll(".dot")) d.remove();
  for (const [x, y] of draft.points) {
    const d = document.createElement("span"); d.className = "dot";
    d.style.left = `${x * 100}%`; d.style.top = `${y * 100}%`;
    $("stage").append(d);
  }
  $("clear-marks").disabled = draft.points.length === 0;
}

function updateNext() {
  $("next").disabled = !complete(draft);
  const st = $("status");
  if (st.classList.contains("err")) return;
  if (draft.cats.length === 0) st.textContent = "";
  else if (isRisk(draft) && !draft.desc.trim() && draft.points.length === 0) st.textContent = t("need.desc_mark");
  else if (isRisk(draft) && !draft.desc.trim()) st.textContent = t("need.desc");
  else if (isRisk(draft) && draft.urgency == null) st.textContent = t("need.urgency");
  else if (isRisk(draft) && draft.points.length === 0) st.textContent = t("need.mark");
  else st.textContent = "";
}

function toggleCat(k) {
  if (k === "none") {
    // 「ない」は他の選択と両立しないので、選んだら他と印を消す
    draft.cats = draft.cats.includes("none") ? [] : ["none"];
    draft.points = []; draft.desc = ""; draft.action = ""; draft.urgency = null;
  } else {
    draft.cats = draft.cats.filter((c) => c !== "none");
    draft.cats = draft.cats.includes(k) ? draft.cats.filter((c) => c !== k) : [...draft.cats, k];
  }
  if (!isRisk(draft)) { draft.points = []; draft.urgency = null; }
  renderItem();
  if (isRisk(draft) && !draft.desc.trim() && k !== "none") $("desc").focus({ preventScroll: true });
}

$("stage").addEventListener("click", (e) => {
  if (!draft || !isRisk(draft)) return;
  const r = $("stage").getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  // 既存の印の近く(画像幅の 4% 以内)を押したら消す
  const near = draft.points.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < r.width * 0.04);
  if (near >= 0) draft.points.splice(near, 1);
  else if (draft.points.length < MAX_MARKS) draft.points.push([+x.toFixed(4), +y.toFixed(4)]);
  else { $("status").textContent = t("mark.max", { n: MAX_MARKS }); return; }
  renderDots(); updateNext();
});

function commitAndGo(delta) {
  const id = state.order[pos];
  if (complete(draft)) {
    const next = { cats: draft.cats.slice(), desc: draft.desc.trim(), action: draft.action.trim(), urgency: draft.urgency, points: draft.points.map((p) => p.slice()) };
    const prev = state.answers[id];
    const same = prev && JSON.stringify([prev.cats, prev.desc, prev.action || "", prev.urgency, prev.points]) ===
      JSON.stringify([next.cats, next.desc, next.action, next.urgency, next.points]);
    if (!same) {
      const at = new Date().toISOString();
      state.answers[id] = { ...next, at };
      // 直した回答も新しい行として送る(集計では回答 ID・画像ごとに最後の行を使う)
      state.pending.push({
        annotator_id: state.id, image: id, cats: next.cats.join("|"), desc: next.desc,
        urgency: next.urgency ?? "", points: JSON.stringify(next.points), answered_at: at,
        started_at: state.startedAt, position: state.order.indexOf(id) + 1, revision: prev ? 1 : 0,
        page_version: PAGE_VERSION, action: next.action, lang,
      });
      persist();
      flush();
    }
  }
  draft = null;
  const np = pos + delta;
  if (np >= state.order.length) {
    if (answeredCount() === state.order.length) { showDone(); return; }
    pos = state.order.findIndex((x) => !state.answers[x]);
  } else pos = Math.max(0, np);
  renderItem();
  window.scrollTo({ top: 0 });
}

function showDone() {
  $("my-id").textContent = state.id;
  show("view-done");
  flush();
}

function resume() {
  if (answeredCount() === state.order.length) { showDone(); return; }
  if (answeredCount() === 0) { show("view-intro"); return; }
  pos = state.order.findIndex((x) => !state.answers[x]);
  draft = null; renderItem();
}

$("start").onclick = () => {
  state.startedAt = state.startedAt || new Date().toISOString();
  persist(); pos = 0; draft = null; renderItem();
};
$("review").onclick = () => { pos = 0; draft = null; renderItem(); };
$("desc").addEventListener("input", (e) => { draft.desc = e.target.value; updateNext(); });
$("action").addEventListener("input", (e) => { draft.action = e.target.value; });
$("clear-marks").onclick = () => { draft.points = []; renderDots(); updateNext(); };
$("next").onclick = () => commitAndGo(1);
$("prev").onclick = () => commitAndGo(-1);
window.addEventListener("online", flush);
$("lang").onclick = () => {
  lang = lang === "ja" ? "en" : "ja";
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* 次に開いたときは既定に戻るだけ */ }
  applyLang();
  if (!$("view-item").hidden) renderItem();
};
applyLang();

state = load();
persist();
if (!window.ENDPOINT) show("view-blocked");
else { resume(); flush(); }
