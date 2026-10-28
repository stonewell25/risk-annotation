// 家の中の危ない場面さがし: 回答画面(GitHub Pages 用)。
// 回答は 1 枚ごとに Google Apps Script(config.js の ENDPOINT)へ送り、スプレッドシートに 1 行ずつ追記する。
// 送れなかった回答はブラウザに溜めておき、次の送信時・次に開いたときに送り直す。
"use strict";

const PAGE_VERSION = "2026-10-28";
const N_ITEMS = 24;
const IDS = Array.from({ length: N_ITEMS }, (_, i) => "img" + String(i + 1).padStart(2, "0"));
const CATS = [
  ["fire", "火事・やけど", "火や熱いもの"],
  ["cut", "切り傷・刺し傷", "刃物や割れ物"],
  ["fall", "転倒", "つまずく・滑る"],
  ["drop", "物の落下", "落ちてきて当たる・割れる"],
  ["elec", "感電・水濡れ", "電気製品と水"],
  ["hygiene", "不衛生", "ゴミ・汚れ"],
  ["other", "その他", "下の説明に書いてください"],
  ["none", "危ないところはない", ""],
];
const MAX_MARKS = 6;
const STORE_KEY = "risk-annotation-v1";

const $ = (id) => document.getElementById(id);
const VIEWS = ["view-loading", "view-blocked", "view-intro", "view-item", "view-done"];
function show(v) { for (const id of VIEWS) $(id).hidden = id !== v; }

let state = null; // {id, order, answers, startedAt, pending}
let pos = 0;
let draft = null; // 今の画像で選びかけの回答 {cats, desc, urgency, points}
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
    setStatus("送信しました");
    ok = true;
  } catch (e) {
    setStatus("送信できませんでした。通信が戻ったら次の回答と一緒に送り直します。", true);
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

for (const [k, label, sub] of CATS) {
  const b = document.createElement("button");
  b.className = "cat"; b.dataset.k = k; b.setAttribute("aria-pressed", "false");
  b.textContent = label;
  if (sub) { const s = document.createElement("small"); s.textContent = sub; b.append(s); }
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
    ? { cats: saved.cats.slice(), desc: saved.desc || "", urgency: saved.urgency ?? null, points: (saved.points || []).map((p) => p.slice()) }
    : { cats: [], desc: "", urgency: null, points: [] };
  $("progress").textContent = `${pos + 1} / ${state.order.length}`;
  $("answered").textContent = `回答済み ${answeredCount()}`;
  $("bar").style.width = `${(answeredCount() / state.order.length) * 100}%`;
  if ($("shot").dataset.id !== id) { $("shot").src = `img/${id}.jpg`; $("shot").dataset.id = id; }
  for (const b of $("cats").children) b.setAttribute("aria-pressed", String(draft.cats.includes(b.dataset.k)));
  $("desc-box").hidden = !isRisk(draft);
  $("desc").value = draft.desc;
  $("urgency-box").hidden = !isRisk(draft);
  for (const b of $("scale").children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === draft.urgency));
  $("markbar").hidden = !isRisk(draft);
  $("stage").classList.toggle("marking", isRisk(draft));
  renderDots();
  $("prev").disabled = pos === 0;
  $("next").textContent = pos === state.order.length - 1 ? "回答を終える" : "次へ";
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
  else if (isRisk(draft) && !draft.desc.trim() && draft.points.length === 0) st.textContent = "危険の説明を書き、画像の上で危ない場所に印を付けると次へ進めます";
  else if (isRisk(draft) && !draft.desc.trim()) st.textContent = "どんな危険かを書くと次へ進めます";
  else if (isRisk(draft) && draft.urgency == null) st.textContent = "緊急度を 1〜5 で選ぶと次へ進めます";
  else if (isRisk(draft) && draft.points.length === 0) st.textContent = "画像の上で危ない場所に印を付けると次へ進めます";
  else st.textContent = "";
}

function toggleCat(k) {
  if (k === "none") {
    // 「ない」は他の選択と両立しないので、選んだら他と印を消す
    draft.cats = draft.cats.includes("none") ? [] : ["none"];
    draft.points = []; draft.desc = ""; draft.urgency = null;
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
  else { $("status").textContent = `印は ${MAX_MARKS} か所までです`; return; }
  renderDots(); updateNext();
});

function commitAndGo(delta) {
  const id = state.order[pos];
  if (complete(draft)) {
    const next = { cats: draft.cats.slice(), desc: draft.desc.trim(), urgency: draft.urgency, points: draft.points.map((p) => p.slice()) };
    const prev = state.answers[id];
    const same = prev && JSON.stringify([prev.cats, prev.desc, prev.urgency, prev.points]) ===
      JSON.stringify([next.cats, next.desc, next.urgency, next.points]);
    if (!same) {
      const at = new Date().toISOString();
      state.answers[id] = { ...next, at };
      // 直した回答も新しい行として送る(集計では回答 ID・画像ごとに最後の行を使う)
      state.pending.push({
        annotator_id: state.id, image: id, cats: next.cats.join("|"), desc: next.desc,
        urgency: next.urgency ?? "", points: JSON.stringify(next.points), answered_at: at,
        started_at: state.startedAt, position: state.order.indexOf(id) + 1, revision: prev ? 1 : 0,
        page_version: PAGE_VERSION,
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
  $("my-id").textContent = state.id.slice(0, 8);
  show("view-done");
  flush();
}

function resume() {
  if (answeredCount() === state.order.length) { showDone(); return; }
  if (answeredCount() === 0) { show("view-intro"); return; }
  pos = state.order.findIndex((x) => !state.answers[x]);
  draft = null; renderItem();
}

$("n-items").textContent = String(IDS.length);
$("start").onclick = () => {
  state.startedAt = state.startedAt || new Date().toISOString();
  persist(); pos = 0; draft = null; renderItem();
};
$("review").onclick = () => { pos = 0; draft = null; renderItem(); };
$("desc").addEventListener("input", (e) => { draft.desc = e.target.value; updateNext(); });
$("clear-marks").onclick = () => { draft.points = []; renderDots(); updateNext(); };
$("next").onclick = () => commitAndGo(1);
$("prev").onclick = () => commitAndGo(-1);
window.addEventListener("online", flush);

state = load();
persist();
if (!window.ENDPOINT) show("view-blocked");
else { resume(); flush(); }
