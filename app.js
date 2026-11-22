// 家の中の危ないところさがし: 回答画面(GitHub Pages 用)。
// 流れ: 背景・同意 → 回答者の属性 → ペルソナ → 答え方 → 練習 → 本番 → 完了。
// ペルソナと画像の組は Apps Script(config.js の ENDPOINT)に、回答の少ない組み合わせから配ってもらう。
// 回答は 1 枚ごとに Apps Script へ送り、危ないところ 1 つ = 1 行でスプレッドシートに追記する。
// 送れなかった回答はブラウザに溜めておき、次の送信時・次に開いたときに送り直す。
"use strict";

const PAGE_VERSION = "2026-11-22";
// v3: 家の人ごとに答える形(2026-11-12)。答えの形が変わったので、前の版の記録は読まない
const STORE_KEY = "risk-annotation-v7"; // v7: P1 → P3(車いす)に入れ替え(2026-11-22)。v6: ペルソナ 3 種類(P1, P2, P4)・構造化プロフィール・28 枚ずつ A/B(2026-11-20)
const LANG_KEY = "risk-annotation-lang";
const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;
const VIEWS = ["view-loading", "view-blocked", "view-bg", "view-attr", "view-persona", "view-how", "view-item", "view-done"];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

// ---- 言語(日本語・英語)。文言は i18n.js、選択肢とペルソナは data.js ----
let lang = (() => {
  try { const l = localStorage.getItem(LANG_KEY); if (l && I18N[l]) return l; } catch (e) { /* 既定に戻す */ }
  return (navigator.language || "").toLowerCase().startsWith("ja") ? "ja" : "en";
})();
function t(key, vars = {}) {
  let s = I18N[lang][key] ?? I18N.ja[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  // 指で操作する端末(スマートフォン・タブレット)では「クリック」を「タップ」と書く(2026-11-22)
  if (TOUCH) s = s.replace(/クリック/g, "タップ").replace(/Click/g, "Tap").replace(/click/g, "tap");
  return s;
}
const L = (pair) => pair[lang === "ja" ? 0 : 1]; // ペルソナの [日本語, 英語]
const O = (opt) => opt[lang === "ja" ? 1 : 2]; // 選択肢の [key, 日本語, 英語]
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t("title");
  for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll("[data-i18n-html]")) e.innerHTML = t(e.dataset.i18nHtml); // 辞書の中身だけ
  for (const e of document.querySelectorAll("[data-i18n-alt]")) e.alt = t(e.dataset.i18nAlt);
}

function show(v) {
  for (const id of VIEWS) $(id).hidden = id !== v;
  $("wrap").classList.toggle("wide", v === "view-item");
  window.scrollTo({ top: 0 });
}

// ---- 保存 ----
// state: {id, consent, attrs, persona, set, order, answers, step, startedAt, pending}
//   step: いまの画面(bg / attr / persona / how / practice / main / done)。開き直したときにここから続ける
//   answers[画像 ID] = {per: {家の人の id: {answer: "yes" | "no", hz: [...]}}, actions: {物: 行動}, rev, at}
let state = null;

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
const fresh = () => ({ id: newId(), consent: false, adult: false, attrs: { age: null, gender: null, region: null, field: [] },
  persona: null, set: null, order: [], answers: {}, step: "bg", startedAt: null, pending: [] });

// ブラウザの保存領域は、プライベートウィンドウなどで使えないことがある。そのときは再開できないだけで回答はできる
function load() {
  // URL の末尾に ?reset を付けて開くと、この端末の記録を消して新しい回答者として始める(共用 PC で順番に答えてもらう用)。
  // 再読み込みでまた消えないよう、URL からは外しておく
  const q = new URLSearchParams(location.search);
  if (q.has("reset")) {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 使えないときは元から記録がない */ }
    q.delete("reset");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
  }
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s && s.id && s.attrs && Array.isArray(s.pending)) {
      // 画像の組を差し替えたあとに古い記録が残っていたら、組の割り当てからやり直す
      const set = ITEMS.sets[s.set];
      if (s.set && !(set && s.order.length === set.length && s.order.every((x) => set.includes(x)))) {
        Object.assign(s, { persona: null, set: null, order: [], answers: {}, step: s.step === "bg" ? "bg" : "attr" });
      }
      return s;
    }
  } catch (e) { /* 使えないときは新しく始める */ }
  return fresh();
}
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 再開できないだけ */ }
}

// ---- 送信 ----
// Apps Script は preflight(OPTIONS)に答えないので、Content-Type を text/plain にして単純リクエストで送る
// window.PREVIEW(確認用の公開版で config.js に書く)のときは送らない。割り当てはブラウザのランダムになる
async function post(body) {
  if (window.PREVIEW) {
    if (body.assign) return { ok: true, persona: "P2", set: "A" }; // プレビューは家族(P2)から。帯のボタンで切り替える
    return { ok: true };
  }
  const res = await fetch(window.ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "rejected");
  return out;
}
let sending = false;
async function flush() {
  if (sending || !state.pending.length || (!window.ENDPOINT && !window.PREVIEW)) return;
  sending = true;
  const batch = state.pending.slice(0, 40);
  let ok = false;
  try {
    await post({ rows: batch });
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

// ペルソナと画像の組を決める。URL に ?persona=P4&set=A を付けたときはそれを使う(動作確認用)。
// Apps Script に聞けなかったときは、ブラウザでランダムに決める
async function assign() {
  const q = new URLSearchParams(location.search);
  if (PERSONAS[q.get("persona")] && ITEMS.sets[q.get("set")]) return { persona: q.get("persona"), set: q.get("set"), by: "url" };
  try {
    const out = await post({ assign: true, annotator_id: state.id });
    if (PERSONAS[out.persona] && ITEMS.sets[out.set]) return { persona: out.persona, set: out.set, by: "server" };
  } catch (e) { /* 下のランダムに回す */ }
  const ps = Object.keys(PERSONAS), ss = Object.keys(ITEMS.sets);
  return { persona: ps[Math.floor(Math.random() * ps.length)], set: ss[Math.floor(Math.random() * ss.length)], by: "browser" };
}

// ---- 1 背景・同意(18 歳以上の確認と、研究に使うことへの同意の両方が要る) ----
const agreed = () => state.adult && state.consent;
$("adult").onchange = (e) => { state.adult = e.target.checked; persist(); $("bg-next").disabled = !agreed(); };
$("consent").onchange = (e) => { state.consent = e.target.checked; persist(); $("bg-next").disabled = !agreed(); };
$("bg-next").onclick = () => goStep("attr");

// ---- 2 回答者の属性 ----
function chip(label, pressed, onclick, cls = "chip") {
  const b = el("button", cls, label);
  b.type = "button"; b.setAttribute("aria-pressed", String(pressed)); b.onclick = onclick;
  return b;
}
const attrsDone = () => ["age", "gender", "region"].every((k) => state.attrs[k]) && state.attrs.field.length > 0;
function renderAttr() {
  for (const box of document.querySelectorAll("[data-single]")) {
    const k = box.dataset.single;
    box.replaceChildren(...ATTR[k].map((o) => chip(O(o), state.attrs[k] === o[0], () => { state.attrs[k] = o[0]; persist(); renderAttr(); })));
  }
  document.querySelector("[data-multi=field]").replaceChildren(...ATTR.field.map((o) => chip(O(o), state.attrs.field.includes(o[0]), () => {
    // 「特になし」と他の分野は両立しない
    const f = state.attrs.field;
    state.attrs.field = o[0] === "none" ? (f.includes("none") ? [] : ["none"]) : toggleIn(f.filter((x) => x !== "none"), o[0]);
    persist(); renderAttr();
  })));
  $("attr-next").disabled = !attrsDone();
  $("attr-need").hidden = attrsDone();
}
function respondentRow(by) {
  return {
    type: "respondent", annotator_id: state.id, persona: state.persona, set: state.set, assigned_by: by,
    age: state.attrs.age, gender: state.attrs.gender, region: state.attrs.region, fields: state.attrs.field.join("|"),
    adult: state.adult ? "yes" : "", consent: state.consent ? "yes" : "", started_at: state.startedAt, page_version: PAGE_VERSION, lang,
  };
}
$("attr-prev").onclick = () => goStep("bg");
$("attr-next").onclick = async () => {
  if (!state.persona) {
    $("attr-next").disabled = true;
    const a = await assign();
    state.persona = a.persona; state.set = a.set;
    state.order = shuffle(ITEMS.sets[a.set]);
    state.startedAt = new Date().toISOString();
    state.pending.push(respondentRow(a.by));
  } else {
    // 戻って属性を直したときも新しい行として送る(集計では回答者ごとに最後の行を使う)
    state.pending.push(respondentRow("update"));
  }
  persist(); flush();
  goStep("persona");
};

// ---- 3 ペルソナ ----
// 詳しいプロフィールの表(大項目 | 属性 | 値)。「ふつう」「なし」は薄く
const NORMAL = new Set(["ふつう", "なし", "年齢相応", "Normal", "None", "Typical for his age", "Typical for her age"]);
function profTable(m) {
  const tb = el("table", "profile"), body = el("tbody");
  for (const [grp, rows] of L(m.profile)) rows.forEach(([k, v], i) => {
    const tr = el("tr", i === 0 ? "first" : null);
    if (i === 0) { const g = el("th", "grp", grp); g.rowSpan = rows.length; tr.append(g); }
    tr.append(el("th", "attr", k), el("td", NORMAL.has(v) ? "normal" : null, v));
    body.append(tr);
  });
  tb.append(body);
  return tb;
}
// スマートフォン用(2026-11-22): 表をやめて、大項目ごとに「項目名(小さく)→ 値」を縦に並べる。
// 「ふつう」「なし」の項目は大項目の最後に 1 行でまとめる
function profList(m) {
  const box = el("div", "plist");
  for (const [grp, rows] of L(m.profile)) {
    const sec = el("section", "pgrp");
    sec.append(el("h4", null, grp));
    const plain = [];
    for (const [k, v] of rows) {
      if (NORMAL.has(v)) { plain.push(k); continue; }
      const kv = el("div", "kv");
      kv.append(el("span", "k", k), el("span", "v", v));
      sec.append(kv);
    }
    if (plain.length) sec.append(el("p", "plain", t("p.plain", { items: plain.join(lang === "ja" ? "、" : ", ") })));
    box.append(sec);
  }
  return box;
}
// 家の人の紹介。PC は全員を縦に並べて表で、スマートフォンは上のタブで 1 人ずつ切り替えて縦並びで見せる
function memberCards(p) {
  const tabs = el("div", "mtabs ptabs");
  const cards = p.members.map((m, i) => {
    const d = el("div", "member" + (i === 0 ? " on" : ""));
    d.append(el("b", null, `${m.icon} ${L(m.label)}`), el("span", null, `${t("age", { n: m.age })} · ${L(m.desc)}`));
    if (m.profile) d.append(profTable(m), profList(m));
    return d;
  });
  const pick = (i) => {
    tabs.querySelectorAll(".mtab").forEach((x, j) => x.setAttribute("aria-pressed", String(j === i)));
    cards.forEach((c, j) => c.classList.toggle("on", j === i));
    tabs.scrollIntoView({ block: "start" });
  };
  // スマートフォンでは 1 人目だけ読んで先へ進まないように、カードの最後に「次の人を見る」を置く
  cards.forEach((c, i) => {
    if (i + 1 >= p.members.length) return;
    const n = el("button", "btn pnext", t("p.nextmember", { who: `${p.members[i + 1].icon} ${L(p.members[i + 1].label)}` }));
    n.type = "button"; n.onclick = () => pick(i + 1);
    c.append(n);
  });
  if (p.members.length > 1) p.members.forEach((m, i) => {
    const b = el("button", "mtab");
    b.type = "button"; b.setAttribute("aria-pressed", String(i === 0));
    b.append(el("span", "micon", m.icon), el("span", null, L(m.label)), el("small", null, t("age", { n: m.age })));
    b.onclick = () => pick(i);
    tabs.append(b);
  });
  return [tabs, ...cards];
}
const persona = () => PERSONAS[state.persona];
function renderPersona() {
  const p = persona();
  $("p-icon").textContent = p.icon;
  $("p-story").textContent = L(p.story);
  $("p-members").replaceChildren(...memberCards(p));
  $("c-icon").textContent = p.icon;
  $("c-text").replaceChildren(L(p.card), el("small", null, t("p.cardsub")));
  // 回答中にいつでも開ける、詳しいプロフィール
  $("prof-body").replaceChildren(el("p", "story-text", L(p.story)), ...memberCards(p));
}
$("persona-prev").onclick = () => goStep("attr");
$("persona-next").onclick = () => goStep("how");

// ---- 4 答え方 ----
$("how-prev").onclick = () => goStep("persona");
$("how-next").onclick = () => goStep("practice");

// ---- 5・6 練習と本番(同じ画面) ----
// 1 枚の画像は、家の人 1 人ずつに「危ないところ・種類・物・優先度」を答え、
// 全員分が終わったら、誰か 1 人でも危ないと答えた物ごとに「あなたならどうするか」を 1 回だけ答える(2026-11-12)。
// sheet = {per: {家の人の id: draft}, cur: 今答えている人の id, actions: {物: 行動}, actOpen: 開いている行動の物, retap}
//   draft はその人の答えかけ: answer = null | "no" | "yes"、hz は危ないところの組、open は開いている組の番号
//   retap は「画像で選び直す」を押した欄
let mode = "main", pos = 0, sheet = null, draft = null;
const blankDraft = () => ({ answer: null, hz: [], open: -1, confirming: false });
const members = () => persona().members;
const memberOf = (mid) => members().find((m) => m.id === mid);
const items = () => (mode === "practice" ? ITEMS.practice : state.order);
const multi = () => persona().members.length > 1;
const newHz = () => ({ kinds: [], kindOther: "", obj: null, pos: null, pri: null, from: null });
// 2026-11-20 テスターの意見: 家族で危ないところはほぼ共通で、危険度だけ違う。
// 先に答えた人の危ないところを引き継ぎ(種類・物はそのまま、危険度は空)、危険度だけ付け直してもらう。
// 引き継いだ組は from に元の人の id を残して送る(付け直さずに済ませた影響を後で見られるように)
const yesMembers = (mid) => members().filter((m) => m.id !== mid && memberDone(sheet.per[m.id]) && sheet.per[m.id].answer === "yes");
function copyFrom(src) {
  const hz = sheet.per[src].hz.map((h) => ({ ...clone(h), pri: null, from: src }));
  Object.assign(draft, { answer: "yes", hz, open: 0 });
  sheet.actOpen = null; sheet.retap = null;
  renderItem();
}
const newAct = (obj) => ({ isAct: true, obj, act: null, actOther: "", targetMode: null, target: null, targetPos: null, dest: [], from: null, fromPos: null });
const posKey = (slot) => (slot === "obj" ? "pos" : slot + "Pos");
const clone = (x) => JSON.parse(JSON.stringify(x));

// その組で、いま見せてよい質問の段階(この順に 1 つずつ出す)
function reached(h) {
  const s = ["kind"];
  if (!h.kinds.length || (h.kinds.includes("other") && !h.kindOther.trim())) return s;
  s.push("obj"); if (!h.obj) return s;
  s.push("pri"); if (!h.pri) return s;
  s.push("done");
  return s;
}
// 行動(物ごと)で、いま見せてよい質問の段階
function actReached(a) {
  const s = ["act"];
  if (!a.act || (a.act === "other" && !a.actOther.trim())) return s;
  s.push("target"); if (!a.target) return s;
  if (a.act === "put_away") { s.push("dest"); if (!a.dest.length) return s; }
  if (a.act === "move_away") { s.push("from"); if (!a.from) return s; }
  s.push("done");
  return s;
}
const isDone = (h) => reached(h).includes("done");
const actDone = (a) => actReached(a).includes("done");
const memberDone = (d) => d.answer === "no" || (d.answer === "yes" && d.hz.length > 0 && d.hz.every(isDone) && d.open === -1);
const membersDone = () => members().every((m) => memberDone(sheet.per[m.id]));
// 誰か 1 人でも危ないと答えた物(答えた順)と、その物が危ないと答えた人
function hazObjs() {
  const out = [];
  for (const m of members()) {
    const d = sheet.per[m.id];
    if (d.answer === "yes") for (const h of d.hz) if (h.obj && !out.includes(h.obj)) out.push(h.obj);
  }
  return out;
}
const whoFor = (obj) => members().filter((m) => sheet.per[m.id].answer === "yes" && sheet.per[m.id].hz.some((h) => h.obj === obj));
const actionOf = (obj) => (sheet.actions[obj] = sheet.actions[obj] || newAct(obj));
const itemDone = () => membersDone() && (!ASK_ACTIONS || (hazObjs().every((o) => actDone(actionOf(o))) && sheet.actOpen === null));
function pickMember(mid) {
  sheet.cur = mid; draft = sheet.per[mid]; sheet.retap = null;
  if (draft.answer === "yes" && draft.open === -1 && !draft.hz.every(isDone)) draft.open = draft.hz.findIndex((h) => !isDone(h));
  renderItem();
}
// いま画像のクリックで答える相手: 開いている危ないところの組、なければ開いている行動
function curEntity() {
  if (draft.open >= 0) return draft.hz[draft.open];
  if (ASK_ACTIONS && membersDone() && sheet.actOpen !== null) return actionOf(sheet.actOpen);
  return null;
}

// 画像をクリックしたときに決まる欄。「選び直す」を押した欄があればそこ、なければ今いちばん先の欄。
// 行動の「何を」は「ほかの物を選ぶ」を押したときだけ画像で選ぶ
function tapTarget(e) {
  if (!e) return null;
  if (e.isAct) {
    const s = actReached(e);
    if (sheet.retap) return sheet.retap;
    if (s.includes("from")) return "from";
    if (s.includes("target")) return e.targetMode === "other" ? "target" : null;
    return null;
  }
  if (!reached(e).includes("obj")) return null;
  return sheet.retap || "obj";
}

// ---- 物の領域画像 ----
// seg/<画像 ID>.png の R の値が物の番号(0 = 何もない)、seg/<画像 ID>.json が {"objects": [{idx, key, ja, en}]}。
// 無い画像では一覧も出せないので、クリックは印だけになる(物は "?")
const segCache = {};
function loadSeg(id) {
  if (!segCache[id]) segCache[id] = (async () => {
    try {
      const res = await fetch(segNamesUrl(id));
      if (!res.ok) return null;
      const names = await res.json();
      const img = new Image();
      img.src = segUrl(id);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data, objects: names.objects || [] };
    } catch (e) {
      return null;
    }
  })();
  return segCache[id];
}
let seg = null; // 今の画像の領域画像(読み込み中・無いときは null)
function objectAt(x, y) {
  if (!seg) return "?";
  const px = Math.min(seg.w - 1, Math.floor(x * seg.w)), py = Math.min(seg.h - 1, Math.floor(y * seg.h));
  const idx = seg.data[(py * seg.w + px) * 4];
  const o = idx ? seg.objects.find((ob) => ob.idx === idx) : null;
  return o ? o.key : null;
}
function objName(key) {
  if (key === "?") return t("obj.marked");
  const o = seg && seg.objects.find((ob) => ob.key === key);
  return o ? (lang === "ja" ? o.ja : o.en) || o.key : key;
}
const objList = () => (seg ? seg.objects.filter((o) => o.list !== false).sort((a, b) => objName(a.key).localeCompare(objName(b.key), lang)) : []);

function field(legend, node, note) {
  const f = el("fieldset", "step"), l = el("legend", null, legend);
  if (note) l.append(el("small", null, note));
  f.append(l, node);
  return f;
}
function chipsBox(options, isOn, pick) {
  const d = el("div", "chips");
  d.append(...options.map((o) => chip(O(o), isOn(o[0]), () => { pick(o[0]); renderItem(); })));
  return d;
}

function openItem() {
  const id = items()[pos];
  const saved = mode === "main" ? state.answers[id] : null;
  sheet = { per: {}, cur: members()[0].id, actions: {}, actOpen: null, retap: null };
  for (const m of members()) {
    const sv = saved && saved.per[m.id];
    sheet.per[m.id] = sv ? { ...blankDraft(), answer: sv.answer, hz: clone(sv.hz) } : blankDraft();
  }
  for (const [o, a] of Object.entries((saved && saved.actions) || {})) sheet.actions[o] = { ...newAct(o), ...clone(a), isAct: true };
  draft = sheet.per[sheet.cur];
  seg = null;
  const shot = $("shot");
  if (shot.dataset.id !== id) { shot.src = imageUrl(id); shot.dataset.id = id; }
  loadSeg(id).then((s) => { if (items()[pos] === id) { seg = s; renderItem(); } });
  setStatus("");
  renderItem();
  show("view-item");
}

function renderItem() {
  const practice = mode === "practice";
  const list = items();
  const answered = state.order.filter((x) => state.answers[x]).length;
  $("practice-note").hidden = !practice;
  $("progress").textContent = t(practice ? "item.prog.p" : "item.prog", { n: pos + 1, total: list.length });
  $("answered").textContent = practice ? "" : t("item.answered", { n: answered });
  $("bar").style.width = `${practice ? 0 : (answered / list.length) * 100}%`;
  const last = pos === list.length - 1;
  $("item-next").textContent = practice && last ? t("item.toMain") : !practice && last ? t("finish") : t("next");
  $("item-next").disabled = !itemDone();
  $("item-prev").disabled = !practice && pos === 0;
  $("need").textContent = itemDone() ? "" : t(membersDone() && ASK_ACTIONS ? "need.act" : multi() ? "need.m" : "need");

  // 画像の印と、画像の下の案内
  // 全員分が終わったら、まだの行動を開く
  if (ASK_ACTIONS && membersDone() && sheet.actOpen === null && draft.open === -1) {
    const todo = hazObjs().find((o) => !actDone(actionOf(o)));
    if (todo) sheet.actOpen = todo;
  }
  const cur = curEntity();
  const slot = tapTarget(cur), armed = !!slot;
  const stage = $("stage");
  stage.classList.toggle("armed", armed);
  stage.querySelectorAll(".pin").forEach((p) => p.remove());
  const pin = (p, cls, label, dim) => {
    if (!p) return;
    const d = el("div", cls + (dim ? " dim" : ""), label);
    d.style.left = p[0] * 100 + "%"; d.style.top = p[1] * 100 + "%";
    stage.append(d);
  };
  draft.hz.forEach((h, i) => pin(h.pos, "pin", String(i + 1), i !== draft.open));
  if (ASK_ACTIONS && membersDone()) hazObjs().forEach((o, k) => {
    const a = actionOf(o), dim = o !== sheet.actOpen;
    pin(a.targetMode === "other" ? a.targetPos : null, "pin target", String(k + 1), dim);
    pin(a.act === "move_away" ? a.fromPos : null, "pin from", String(k + 1), dim);
  });
  const hint = $("stage-hint");
  const waiting = armed && !cur[slot];
  hint.classList.toggle("go", waiting);
  hint.textContent = !cur ? "" : !armed ? t("hint.wait") : !waiting ? t("hint.done")
    : t({ obj: "hint.tap", target: "hint.target", from: "hint.from" }[slot], { n: cur.isAct ? objName(cur.obj) : draft.open + 1 });

  const flow = $("flow");
  flow.replaceChildren();
  // 家の人のアイコン(2 人以上のとき)。押すとその人の答えに切り替わる
  const me = memberOf(sheet.cur);
  if (multi()) {
    flow.append(el("p", "question", t("m.lead")));
    const tabs = el("div", "mtabs");
    for (const m of members()) {
      const d = sheet.per[m.id];
      const st = memberDone(d) ? (d.answer === "no" ? t("m.no") : t("m.yes", { n: d.hz.length })) : d.answer ? t("m.doing") : t("m.todo");
      const b = el("button", "mtab" + (memberDone(d) ? " done" : ""));
      b.type = "button"; b.setAttribute("aria-pressed", String(m.id === sheet.cur));
      b.append(el("span", "micon", m.icon), el("b", null, L(m.label)), el("small", null, st));
      b.onclick = () => pickMember(m.id);
      tabs.append(b);
    }
    flow.append(tabs);
  }
  // 0. この人にとって危ないところはあるか
  flow.append(el("p", "question", multi() ? t("q0.m", { who: lang === "en" ? L(me.label).toLowerCase() : L(me.label) }) : t("q0")));
  if (draft.answer === null) {
    const yn = el("div", "yn");
    yn.append(chip(t("yes"), false, () => { Object.assign(draft, { answer: "yes", hz: [newHz()], open: 0 }); sheet.actOpen = null; renderItem(); }),
              chip(t("no"), false, () => { draft.answer = "no"; renderItem(); }));
    flow.append(yn);
    const srcs = yesMembers(sheet.cur);
    if (srcs.length) {
      const cp = el("div", "copy-box");
      cp.append(el("p", "copy-lead", t("copy.lead")));
      const row = el("div", "chips");
      row.append(...srcs.map((m) => chip(t("copy.btn", { who: L(m.label), n: sheet.per[m.id].hz.length }), false, () => copyFrom(m.id))));
      cp.append(row);
      flow.append(cp);
    }
  } else if (draft.confirming) {
    const c = el("div", "confirm"), row = el("div", "row");
    const ok = el("button", "btn small danger", t("undo.ok")); ok.type = "button";
    ok.onclick = () => { Object.assign(draft, { answer: null, hz: [], open: -1, confirming: false }); sheet.retap = null; renderItem(); };
    const no = el("button", "btn small", t("undo.cancel")); no.type = "button";
    no.onclick = () => { draft.confirming = false; renderItem(); };
    row.append(ok, no);
    c.append(el("p", null, t("undo.q")), row);
    flow.append(c);
  } else {
    const a = el("div", "answered");
    const u = el("button", "btn small", t("undo")); u.type = "button";
    // 「ない」は消える答えがないのですぐ戻す。「ある」で何か答えていれば確認を挟む
    const touched = draft.hz.some((h) => h.kinds.length || h.obj);
    u.onclick = () => {
      if (draft.answer === "yes" && touched) draft.confirming = true;
      else Object.assign(draft, { answer: null, hz: [], open: -1 });
      sheet.retap = null;
      renderItem();
    };
    a.append(el("p", null, t(draft.answer === "no" ? "ans.no" : "ans.yes")), u);
    flow.append(a);
  }
  if (draft.answer === "yes" && !draft.confirming) {
    // 1〜. 危ないところの組
    draft.hz.forEach((h, i) => flow.append(i === draft.open ? hzOpen(h, i) : hzSummary(h, i)));
    if (draft.open === -1 && draft.hz.length < MAX_HAZARDS && draft.hz.every(isDone)) {
      const add = el("button", "btn ghost step", t("add")); add.type = "button";
      add.onclick = () => { draft.hz.push(newHz()); draft.open = draft.hz.length - 1; sheet.retap = null; sheet.actOpen = null; renderItem(); };
      flow.append(add);
    }
  }
  // この人が終わって、まだの人がいれば「次の人へ」
  const nextM = members().find((m) => !memberDone(sheet.per[m.id]));
  if (multi() && memberDone(draft) && nextM) {
    const go = el("button", "btn primary step", t("m.next", { who: L(nextM.label) })); go.type = "button";
    go.onclick = () => pickMember(nextM.id);
    flow.append(go);
  }
  // 全員分が終わったら: 危ないと答えた物ごとに「あなたならどうするか」
  const objs = ASK_ACTIONS && membersDone() ? hazObjs() : [];
  if (objs.length) {
    const sec = el("div", "act-sec");
    sec.append(el("p", "question", t("act.h")), el("p", "act-lead", t(multi() ? "act.lead.m" : "act.lead")));
    objs.forEach((o, k) => sec.append(o === sheet.actOpen ? actOpenCard(actionOf(o), k) : actSummary(actionOf(o), k)));
    flow.append(sec);
  }
}
// 行動の欄の見出し: 物の名前と、誰にとって危ないと答えたか
function actHead(a, k) {
  const h3 = el("h3");
  h3.append(el("span", "num act", String(k + 1)), objName(a.obj));
  if (multi()) h3.append(el("small", "act-who", t("act.who", { who: whoFor(a.obj).map((m) => L(m.label)).join(lang === "ja" ? "・" : ", ") })));
  return h3;
}
function actOpenCard(a, k) {
  const card = el("div", "hz act-card");
  const head = el("div", "hz-head"); head.append(actHead(a, k)); card.append(head);
  const steps = actReached(a);
  const box = el("div"); box.style.cssText = "display:flex;flex-direction:column;gap:10px";
  box.append(chipsBox(ACTS, (x) => a.act === x, (x) => {
    if (a.act === x) return;
    Object.assign(a, { act: x, targetMode: null, target: null, targetPos: null, dest: [], from: null, fromPos: null });
    sheet.retap = null;
  }));
  if (a.act === "other") box.append(shortText(`act-other-${k}`, a, "actOther", t("ph.act")));
  card.append(field(t("q.act.o"), box));
  if (steps.includes("target")) {
    // まずは「危ない物と同じ」か「ほかの物」かの 2 択。ほかの物のときだけ画像・一覧で選ぶ
    const tb = el("div"); tb.style.cssText = "display:flex;flex-direction:column;gap:12px";
    const two = el("div", "chips");
    two.append(chip(t("same", { n: objName(a.obj) }), a.targetMode === "same", () => {
      Object.assign(a, { targetMode: "same", target: a.obj, targetPos: null }); sheet.retap = null; renderItem();
    }), chip(t("other.pick"), a.targetMode === "other", () => {
      if (a.targetMode !== "other") Object.assign(a, { targetMode: "other", target: null, targetPos: null });
      sheet.retap = null; renderItem();
    }));
    tb.append(two);
    if (a.targetMode === "other") tb.append(slotRow(a, `a${k}`, "target"));
    card.append(field(t(`q.t.${a.act}`), tb));
  }
  // 片付け先は複数選べる
  if (steps.includes("dest")) card.append(field(t("q.dest"), chipsBox(DESTS, (d) => a.dest.includes(d), (d) => (a.dest = toggleIn(a.dest, d))), t("any")));
  if (steps.includes("from")) card.append(field(t("q.from"), slotRow(a, `a${k}`, "from")));
  if (steps.includes("done")) {
    const save = el("button", "btn primary small step", t("act.save")); save.type = "button";
    save.onclick = () => { sheet.actOpen = null; sheet.retap = null; renderItem(); };
    const row = el("div"); row.style.cssText = "display:flex;justify-content:flex-end"; row.append(save);
    card.append(row);
  }
  return card;
}
function actSummary(a, k) {
  const s = el("div", "hz-sum"), txt = el("div", "txt");
  const act = ACTS.find((x) => x[0] === a.act);
  const detail = !actDone(a) ? t("act.notdone")
    : (a.act === "other" ? a.actOther.trim() : O(act)) + (a.act === "put_away" ? ` → ${DESTS.filter((d) => a.dest.includes(d[0])).map(O).join(" / ")}` : "");
  txt.append(actHead(a, k), el("small", null, detail));
  const acts = el("div", "acts");
  const ed = el("button", "btn small", t("edit")); ed.type = "button";
  ed.onclick = () => { sheet.actOpen = a.obj; sheet.retap = null; renderItem(); };
  acts.append(ed);
  s.append(txt, acts);
  return s;
}
function removeHz(i) {
  draft.hz.splice(i, 1);
  if (!draft.hz.length) { draft.hz = [newHz()]; draft.open = 0; }
  else if (draft.open === i) draft.open = -1;
  else if (draft.open > i) draft.open--;
  sheet.retap = null;
  renderItem();
}
function hzOpen(h, i) {
  const card = el("div", "hz");
  const head = el("div", "hz-head"), h3 = el("h3");
  h3.append(el("span", "num", String(i + 1)), t("hz", { n: i + 1 }));
  if (h.from && memberOf(h.from)) h3.append(el("small", "hz-from", t("copy.from", { who: L(memberOf(h.from).label) })));
  head.append(h3);
  if (draft.hz.length > 1 || h.kinds.length) {
    const del = el("button", "btn small", t("del")); del.type = "button";
    del.onclick = () => removeHz(i);
    head.append(del);
  }
  card.append(head);

  const steps = reached(h);
  const kind = field(t("q.kind"), chipsBox(KINDS, (k) => h.kinds.includes(k), (k) => (h.kinds = toggleIn(h.kinds, k))), t("any"));
  if (h.kinds.includes("other")) kind.append(shortText(`kind-other-${i}`, h, "kindOther", t("ph.kind")));
  card.append(kind);
  if (steps.includes("obj")) card.append(field(t("q.obj"), slotRow(h, i, "obj")));
  if (steps.includes("pri")) {
    const box = el("div"); box.style.cssText = "display:flex;flex-direction:column;gap:8px";
    const sc = el("div", "scale");
    sc.append(...[5, 4, 3, 2, 1].map((n) => chip(String(n), h.pri === n, () => { h.pri = n; renderItem(); })));
    const ends = el("div", "scale-ends");
    ends.append(el("span", null, t("pri.hi")), el("span", null, t("pri.lo")));
    box.append(sc, ends);
    card.append(field(t("q.pri"), box));
  }
  if (steps.includes("done")) {
    const save = el("button", "btn primary small step", t("save")); save.type = "button";
    save.onclick = () => { draft.open = draft.hz.findIndex((x) => !isDone(x)); sheet.retap = null; renderItem(); };
    const row = el("div"); row.style.cssText = "display:flex;justify-content:flex-end"; row.append(save);
    card.append(row);
  }
  return card;
}
function hzSummary(h, i) {
  const s = el("div", "hz-sum"), txt = el("div", "txt");
  const kinds = KINDS.filter((k) => h.kinds.includes(k[0])).map(O).join(" / ");
  txt.append(el("b", null, h.obj ? objName(h.obj) : "—"), el("small", null, isDone(h) ? `${kinds} · ${t("pri.sum", { n: h.pri })}` : h.from && h.kinds.length && h.obj ? `${kinds} · ${t("copy.needpri")}` : t("hz.notdone")));
  const acts = el("div", "acts");
  const ed = el("button", "btn small", t("edit")); ed.type = "button";
  ed.onclick = () => { draft.open = i; sheet.retap = null; sheet.actOpen = null; renderItem(); };
  const del = el("button", "btn small", t("del")); del.type = "button";
  del.onclick = () => removeHz(i);
  acts.append(ed, del);
  s.append(el("span", "num", String(i + 1)), txt, acts);
  return s;
}
// 物を 1 つ決める欄: 画像のクリックか、物の名前の一覧
function slotRow(h, i, slot) {
  const row = el("div", "obj");
  const v = h[slot];
  const list = objList();
  row.append(v ? el("span", "obj-name", objName(v)) : el("span", "obj-empty", t(list.length ? "obj.tap" : "obj.empty")));
  if (list.length) {
    const sel = el("select"); sel.id = `${slot}-${i}`;
    sel.append(new Option(t("obj.click"), ""), ...list.map((o) => new Option(objName(o.key), o.key)));
    sel.onchange = () => {
      if (!sel.value) return;
      h[slot] = sel.value; h[posKey(slot)] = null; sheet.retap = null; renderItem();
    };
    const help = el("label", "obj-label", t("obj.help")); help.htmlFor = sel.id;
    row.append(help, sel);
  }
  if (v && tapTarget(h) !== slot) {
    const re = el("button", "btn small", t("obj.retap")); re.type = "button";
    re.onclick = () => { sheet.retap = slot; renderItem(); };
    row.append(re);
  }
  return row;
}
// 「その他」のときだけの短い記述。空かどうかが変わったときだけ描き直し、入力位置は保つ
function shortText(id, h, key, ph) {
  const inp = el("input", "short"); inp.id = id; inp.type = "text"; inp.maxLength = 200; inp.placeholder = ph; inp.value = h[key];
  inp.oninput = () => {
    const was = !!h[key].trim(); h[key] = inp.value;
    if (was !== !!inp.value.trim()) { renderItem(); const n = $(id); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  };
  return inp;
}
$("stage").addEventListener("click", (e) => {
  const cur = draft ? curEntity() : null;
  const slot = tapTarget(cur);
  if (!slot) return;
  const r = $("stage").getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const key = objectAt(x, y);
  if (!key) { setStatus(t("obj.nothing"), true); return; }
  setStatus("");
  cur[slot] = key; cur[posKey(slot)] = [+x.toFixed(4), +y.toFixed(4)]; sheet.retap = null;
  renderItem();
});

// 1 枚の答えを送る行にする。家の人ごとに、危ないところ 1 つ = 1 行、「ない」は 1 行
function rowsFor(id, ans, rev, at) {
  return members().flatMap((m) => memberRows(id, m.id, ans.per[m.id], ans.actions, rev, at));
}
// 行動は物ごとの答え(actions)を、その物を選んだ人の行それぞれに入れる
function memberRows(id, mid, ans, actions, rev, at) {
  const base = {
    type: "answer3", annotator_id: state.id, persona: state.persona, set: state.set, image: id, member: mid,
    position: state.order.indexOf(id) + 1, revision: rev, has_risk: ans.answer, hazard_count: ans.answer === "yes" ? ans.hz.length : 0,
    answered_at: at, started_at: state.startedAt, page_version: PAGE_VERSION, lang,
  };
  if (ans.answer === "no") return [{ ...base, hazard_no: 0 }];
  const xy = (p) => (p ? p : ["", ""]);
  return ans.hz.map((h, i) => ({ h, a: (actions || {})[h.obj] || newAct(h.obj) })).map(({ h, a }, i) => ({
    ...base, hazard_no: i + 1, kinds: h.kinds.join("|"), kind_other: h.kinds.includes("other") ? h.kindOther.trim() : "",
    obj: h.obj, obj_x: xy(h.pos)[0], obj_y: xy(h.pos)[1],
    priority: h.pri, copied_from: h.from || "",
    act: a.act || "", act_other: a.act === "other" ? a.actOther.trim() : "",
    target: a.target || "", target_x: xy(a.targetPos)[0], target_y: xy(a.targetPos)[1],
    dest: a.dest.join("|"), from: a.from || "", from_x: xy(a.fromPos)[0], from_y: xy(a.fromPos)[1],
  }));
}
function commitAndGo(delta) {
  const id = items()[pos];
  if (mode === "main" && itemDone()) {
    const next = { per: Object.fromEntries(members().map((m) => {
      const d = sheet.per[m.id];
      return [m.id, { answer: d.answer, hz: d.answer === "yes" ? clone(d.hz) : [] }];
    })), actions: ASK_ACTIONS ? Object.fromEntries(hazObjs().map((o) => { const { isAct, ...a } = actionOf(o); return [o, clone(a)]; })) : {} };
    const prev = state.answers[id];
    if (!prev || JSON.stringify([prev.per, prev.actions]) !== JSON.stringify([next.per, next.actions])) {
      // 直した答えも新しい行として送る(集計では回答 ID・画像ごとに revision が最大の行を使う)
      const at = new Date().toISOString(), rev = prev ? prev.rev + 1 : 0;
      state.answers[id] = { ...next, rev, at };
      state.pending.push(...rowsFor(id, next, rev, at));
      persist();
      flush();
    }
  }
  const list = items(), np = pos + delta;
  if (np < 0) { if (mode === "practice") goStep("how"); return; }
  if (np >= list.length) {
    if (mode === "practice") { goStep("main"); return; }
    const left = state.order.findIndex((x) => !state.answers[x]);
    if (left < 0) { goStep("done"); return; }
    pos = left;
  } else pos = np;
  openItem();
}
$("item-next").onclick = () => commitAndGo(1);
$("item-prev").onclick = () => commitAndGo(-1);

// ---- 7 完了 ----
$("review").onclick = () => { state.step = "main"; persist(); mode = "main"; pos = 0; openItem(); };

// ---- 画面の切り替え ----
// 答え方がわからなくなったら: 回答画面から、答え方の説明を重ねて出す(答えは消えない)
$("help-open").onclick = () => $("help").showModal();
$("help-close").onclick = () => $("help").close();
$("prof-open").onclick = () => $("prof").showModal();
$("prof-close").onclick = () => $("prof").close();

function goStep(step) {
  state.step = step; persist();
  setStatus("");
  if (step === "bg") { $("adult").checked = !!state.adult; $("consent").checked = state.consent; $("bg-next").disabled = !agreed(); show("view-bg"); }
  else if (step === "attr") { renderAttr(); show("view-attr"); }
  else if (step === "persona") { renderPersona(); show("view-persona"); }
  else if (step === "how") { $("how-p").textContent = t("how.p", { n: state.order.length }); show("view-how"); }
  else if (step === "practice") { renderPersona(); mode = "practice"; pos = 0; openItem(); }
  else if (step === "main") {
    renderPersona(); mode = "main";
    const left = state.order.findIndex((x) => !state.answers[x]);
    pos = left < 0 ? 0 : left;
    openItem();
  } else if (step === "done") { $("my-id").textContent = state.id; show("view-done"); flush(); }
}

$("lang").onclick = () => {
  lang = lang === "ja" ? "en" : "ja";
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* 次に開いたときは既定に戻るだけ */ }
  applyLang();
  if (!$("view-attr").hidden) renderAttr();
  if (state.persona) renderPersona();
  if (!$("view-how").hidden) $("how-p").textContent = t("how.p", { n: state.order.length });
  if (!$("view-item").hidden) renderItem();
};
window.addEventListener("online", flush);

applyLang();
state = load();
persist();
if (window.PREVIEW) {
  const bar = el("div", "practice", lang === "ja" ? "確認用のプレビューです。回答はどこにも送られません。"
    : "Preview only. Answers are not sent anywhere.");
  bar.style.cssText = "position:sticky;top:0;z-index:50;margin:0 0 12px;text-align:center";
  // プレビューだけ: ペルソナを切り替えるボタン(答えは消して、ペルソナの紹介から)
  const pick = el("span"); pick.style.cssText = "margin-left:12px;display:inline-flex;gap:6px;flex-wrap:wrap";
  for (const [pid, p] of Object.entries(PERSONAS)) {
    const b = el("button", "btn small", `${p.icon} ${pid}`); b.type = "button";
    b.onclick = () => {
      Object.assign(state, { persona: pid, set: state.set || "A", answers: {}, order: shuffle(ITEMS.sets[state.set || "A"]) });
      persist(); renderPersona(); goStep(agreed() && attrsDone() ? "persona" : state.step);
    };
    pick.append(b);
  }
  bar.append(pick);
  document.body.prepend(bar);
}
if (!window.ENDPOINT && !window.PREVIEW) show("view-blocked");
else {
  // 割り当て前に閉じた人は属性の画面から
  goStep(!agreed() ? "bg" : !state.persona && state.step !== "attr" ? "attr" : state.step);
  flush();
}
