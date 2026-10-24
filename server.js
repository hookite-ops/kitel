// Kitel 서버 — 정적 파일 + Gemini 에이전트 API (의존성 없음)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const PIN = process.env.KITEL_PIN || "";
const TZ = "Asia/Seoul";
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/* ---------- 날짜 (서울 기준) ---------- */
function seoulNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, wd: p.weekday };
}
const WDK = { Sun: "일", Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토" };
function addDays(ymd, n) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function wdOf(ymd) { return "일월화수목금토"[new Date(ymd + "T00:00:00Z").getUTCDay()]; }

/* ---------- 도구 정의 ---------- */
const DATE = { type: "string", description: "YYYY-MM-DD 형식 날짜" };
const TIME = { type: "string", description: "24시간제 HH:MM. 시간이 없으면 빈 문자열" };
const TOOLS = [{
  functionDeclarations: [
    { name: "add_todo", description: "할 일을 추가한다", parameters: { type: "object", properties: { text: { type: "string" }, due: DATE, important: { type: "boolean" } }, required: ["text"] } },
    { name: "update_todo", description: "할 일을 수정한다 (내용·기한·중요·완료 여부)", parameters: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD, 기한을 없애려면 빈 문자열" }, important: { type: "boolean" }, done: { type: "boolean" } }, required: ["id"] } },
    { name: "delete_todo", description: "할 일을 삭제한다", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "add_event", description: "일정을 추가한다", parameters: { type: "object", properties: { title: { type: "string" }, date: DATE, time: TIME, repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"], description: "반복. weekly는 date의 요일, monthly는 date의 날짜 기준" }, important: { type: "boolean" } }, required: ["title", "date"] } },
    { name: "update_event", description: "일정을 수정한다 (이름·날짜·시간·반복)", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, date: DATE, time: TIME, repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"] }, important: { type: "boolean" } }, required: ["id"] } },
    { name: "delete_event", description: "일정을 삭제한다 (반복 일정은 전체 삭제)", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "add_memo", description: "메모를 저장한다", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "delete_memo", description: "메모를 삭제한다", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "set_user_name", description: "사용자가 불러 달라는 이름을 저장한다", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "start_timer", description: "타이머를 맞춘다", parameters: { type: "object", properties: { seconds: { type: "integer" }, label: { type: "string" } }, required: ["seconds"] } }
  ]
}];
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const okTime = s => /^\d{2}:\d{2}$/.test(s || "");
const rep = r => (["daily", "weekdays", "weekly", "monthly"].includes(r) ? r : null);

function runTool(st, name, a, out) {
  const T = id => st.todos.find(x => x.id === id), E = id => st.events.find(x => x.id === id);
  switch (name) {
    case "add_todo": {
      const t = { id: uid(), text: String(a.text || "").slice(0, 200), done: false, created: Date.now(), due: okDate(a.due) ? a.due : null, star: !!a.important };
      if (!t.text) return { error: "내용이 비었음" };
      st.todos.push(t); out.push("📝 " + t.text); return { ok: true, id: t.id };
    }
    case "update_todo": {
      const t = T(a.id); if (!t) return { error: "그런 할 일 없음" };
      if (a.text) t.text = String(a.text).slice(0, 200);
      if (a.due !== undefined) t.due = okDate(a.due) ? a.due : null;
      if (a.important !== undefined) t.star = !!a.important;
      if (a.done !== undefined) { t.done = !!a.done; t.doneAt = t.done ? Date.now() : null; if (t.done) out.push("✅ " + t.text); }
      return { ok: true };
    }
    case "delete_todo": { const t = T(a.id); if (!t) return { error: "그런 할 일 없음" }; st.todos = st.todos.filter(x => x !== t); out.push("🗑️ " + t.text); return { ok: true }; }
    case "add_event": {
      if (!okDate(a.date)) return { error: "date 형식 오류" };
      const e = { id: uid(), title: String(a.title || "").slice(0, 200), date: a.date, time: okTime(a.time) ? a.time : "", repeat: rep(a.repeat), notified: {}, star: !!a.important, created: Date.now() };
      if (!e.title) return { error: "이름이 비었음" };
      st.events.push(e); out.push("📅 " + e.title); return { ok: true, id: e.id };
    }
    case "update_event": {
      const e = E(a.id); if (!e) return { error: "그런 일정 없음" };
      if (a.title) e.title = String(a.title).slice(0, 200);
      if (okDate(a.date)) e.date = a.date;
      if (a.time !== undefined) e.time = okTime(a.time) ? a.time : "";
      if (a.repeat !== undefined) e.repeat = rep(a.repeat);
      if (a.important !== undefined) e.star = !!a.important;
      e.notified = {}; out.push("✏️ " + e.title); return { ok: true };
    }
    case "delete_event": { const e = E(a.id); if (!e) return { error: "그런 일정 없음" }; st.events = st.events.filter(x => x !== e); out.push("🗑️ " + e.title); return { ok: true }; }
    case "add_memo": { const m = { id: uid(), text: String(a.text || "").slice(0, 500), created: Date.now() }; if (!m.text) return { error: "비었음" }; st.memos.push(m); out.push("🗒️ 메모"); return { ok: true, id: m.id }; }
    case "delete_memo": { const n = st.memos.length; st.memos = st.memos.filter(x => x.id !== a.id); return n === st.memos.length ? { error: "그런 메모 없음" } : { ok: true }; }
    case "set_user_name": { st.prof.name = String(a.name || "").slice(0, 30); return { ok: true }; }
    case "start_timer": { const s = Math.max(1, Math.min(86400, parseInt(a.seconds) || 0)); st.timers.push({ seconds: s, label: String(a.label || "") }); return { ok: true }; }
  }
  return { error: "알 수 없는 도구" };
}

function systemPrompt(st) {
  const n = seoulNow();
  const week = Array.from({ length: 14 }, (_, i) => { const d = addDays(n.date, i); return `${d}(${wdOf(d)})`; }).join(", ");
  const todos = st.todos.filter(t => !t.done).map(t => `- [${t.id}] ${t.text}${t.due ? " (기한 " + t.due + ")" : ""}${t.star ? " ⭐" : ""}`).join("\n") || "(없음)";
  const done = st.todos.filter(t => t.done).slice(-10).map(t => `- [${t.id}] ${t.text}`).join("\n") || "(없음)";
  const evs = st.events.map(e => `- [${e.id}] ${e.title} | ${e.date} ${e.time || "종일"}${e.repeat ? " | 반복:" + e.repeat : ""}${e.star ? " ⭐" : ""}`).join("\n") || "(없음)";
  const memos = st.memos.slice(-30).map(m => `- [${m.id}] ${m.text}`).join("\n") || "(없음)";
  return `너는 "Kitel"(키텔)이야. ${st.prof.name ? st.prof.name + "님" : "사용자"}의 개인 비서 에이전트. 슬로건: "맡기면 날아가서 해결해요" 🪁
지금: ${n.date} (${WDK[n.wd]}요일) ${n.time}, 서울 시간.
앞으로 14일 달력: ${week}
한 주는 월요일에 시작. "다음 주 X요일"은 다음 월요일부터 시작하는 주의 X요일.

## 규칙
- 항상 한국어, 친근한 존댓말. 짧게(보통 1~4문장). 이모지는 가끔만.
- 할 일·일정·메모를 바꿔 달라는 말이면 반드시 도구를 호출해서 실제로 처리해. 처리하지 않고 했다고 말하면 안 돼.
- 한 메시지에 여러 요청이 있으면 도구를 여러 번 호출해.
- 시간이 애매하면 상식대로 판단(예: "3시 회의"는 보통 오후 3시, "아침"은 08:00, "저녁"은 19:00). 정말 모르겠을 때만 짧게 되물어.
- 수정·삭제·완료는 아래 목록의 id로 지정해. 사용자가 "그거", "방금 거"라고 하면 대화 맥락으로 판단해.
- 처리 결과는 날짜를 "내일 오후 3시"처럼 사람이 읽기 쉽게 말해 줘.
- 일정·할 일 질문(언제야, 비는 시간, 몇 개 했어 등)은 아래 목록을 보고 정확히 답해. 없는 내용은 지어내지 마.
- 일반 대화, 질문, 고민 상담, 아이디어도 똑똑하고 성실하게 도와줘. 실시간 정보(날씨, 뉴스 등)는 확인할 수 없다고 솔직히 말해.

## 남은 할 일
${todos}
## 최근 완료한 할 일
${done}
## 일정 (반복 일정 포함)
${evs}
## 메모
${memos}`;
}

async function gemini(contents, sys) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: TOOLS, generationConfig: { temperature: 0.6, maxOutputTokens: 1024 } }),
    signal: AbortSignal.timeout(40000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message || "Gemini 오류 " + r.status); e.status = r.status; throw e; }
  return j;
}

async function agent(body) {
  const st = {
    todos: Array.isArray(body.state?.todos) ? body.state.todos.slice(0, 500) : [],
    events: Array.isArray(body.state?.events) ? body.state.events.slice(0, 500) : [],
    memos: Array.isArray(body.state?.memos) ? body.state.memos.slice(0, 300) : [],
    prof: { name: String(body.state?.prof?.name || "") }, timers: []
  };
  const contents = [];
  for (const h of (Array.isArray(body.history) ? body.history.slice(-16) : [])) {
    if (!h || !h.text) continue;
    const role = h.role === "me" ? "user" : "model";
    if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts[0].text += "\n" + h.text;
    else contents.push({ role, parts: [{ text: String(h.text).slice(0, 2000) }] });
  }
  while (contents.length && contents[0].role !== "user") contents.shift();
  contents.push({ role: "user", parts: [{ text: String(body.message || "").slice(0, 4000) }] });
  if (contents.length > 1 && contents[contents.length - 2].role === "user") contents.splice(contents.length - 2, 1);

  const actions = [];let reply = "";
  for (let i = 0; i < 6; i++) {
    const j = await gemini(contents, systemPrompt(st));
    const c = j.candidates?.[0]?.content;
    if (!c || !c.parts) { reply = j.promptFeedback?.blockReason ? "그 내용은 답하기 어려워요." : "음, 잠깐 생각이 막혔어요. 다시 말해 주세요."; break; }
    contents.push(c);
    const calls = c.parts.filter(p => p.functionCall);
    const text = c.parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
    if (!calls.length) { reply = text; break; }
    const resp = calls.map(p => ({ functionResponse: { name: p.functionCall.name, response: runTool(st, p.functionCall.name, p.functionCall.args || {}, actions) } }));
    contents.push({ role: "user", parts: resp });
    if (i === 5) reply = text || "처리했어요!";
  }
  return { reply: reply || "처리했어요!", state: st, actions, timers: st.timers };
}

/* ---------- 간단한 남용 방지 ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr); if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}

function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/health") return send(res, 200, { ai: !!KEY, pin: !!PIN, model: MODEL });
  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    if (!KEY) return send(res, 503, { error: "no_key" });
    if (PIN && req.headers["x-kitel-pin"] !== PIN) return send(res, 401, { error: "pin" });
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (limited(ip)) return send(res, 429, { error: "too_many" });
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      try { send(res, 200, await agent(JSON.parse(raw || "{}"))); }
      catch (e) { console.error("chat error:", e.message); send(res, e.status === 429 ? 429 : 502, { error: e.message }); }
    });
    return;
  }
  // 정적 파일
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUB, "index.html"), (e2, d2) => { res.writeHead(e2 ? 404 : 200, { "content-type": TYPES[".html"] }); res.end(d2 || "not found"); });
    }
    const ext = path.extname(file);
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": [".html", ".js"].includes(ext) || p === "/sw.js" ? "no-cache" : "public, max-age=86400" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Kitel on :${PORT} · AI ${KEY ? "ON (" + MODEL + ")" : "OFF (GEMINI_API_KEY 없음)"}`));
