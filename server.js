// Kitel 서버 v4 — 정적 파일 + Gemini 에이전트 (스트리밍·웹검색·장기기억·사진 인식, 의존성 없음)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 8080;
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.6-flash").split(",").map(s => s.trim()).filter(Boolean);
const PIN = process.env.KITEL_PIN || "";
const SEARCH = process.env.KITEL_SEARCH !== "off";
const TZ = "Asia/Seoul";
const PUB = path.join(__dirname, "public");
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
let modelIdx = 0; // 404 나면 다음 모델로 영구 전환

/* ---------- 날짜 (서울 기준) ---------- */
function seoulNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, wd: p.weekday };
}
const WDK = { Sun: "일", Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토" };
const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wdOf = ymd => "일월화수목금토"[new Date(ymd + "T00:00:00Z").getUTCDay()];

/* ---------- 도구 ---------- */
const DATE = { type: "string", description: "YYYY-MM-DD" };
const TIME = { type: "string", description: "24시간제 HH:MM, 시간 없으면 빈 문자열" };
const REPEAT = { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"], description: "반복. weekly=date의 요일마다, monthly=date의 날짜마다" };
const DECL = [
  { name: "add_todo", description: "할 일 추가", parameters: { type: "object", properties: { text: { type: "string" }, due: DATE, important: { type: "boolean" } }, required: ["text"] } },
  { name: "update_todo", description: "할 일 수정(내용·기한·중요·완료). 완료 처리도 이것", parameters: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD, 없애려면 빈 문자열" }, important: { type: "boolean" }, done: { type: "boolean" } }, required: ["id"] } },
  { name: "delete_todo", description: "할 일 삭제", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "add_event", description: "일정 추가", parameters: { type: "object", properties: { title: { type: "string" }, date: DATE, time: TIME, repeat: REPEAT, important: { type: "boolean" }, note: { type: "string", description: "장소·준비물 등 부가 정보" } }, required: ["title", "date"] } },
  { name: "update_event", description: "일정 수정", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, date: DATE, time: TIME, repeat: REPEAT, important: { type: "boolean" }, note: { type: "string" } }, required: ["id"] } },
  { name: "delete_event", description: "일정 삭제(반복 일정은 전체)", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "add_memo", description: "메모 저장(사용자가 적어 두라고 한 정보)", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "delete_memo", description: "메모 삭제", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "remember_fact", description: "사용자에 대해 앞으로 계속 기억할 사실·취향 저장(예: 좋아하는 음식, 학교, 습관). 사용자가 스스로 말한 것만", parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
  { name: "forget_fact", description: "기억한 사실 삭제", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "set_user_name", description: "사용자를 부를 이름 저장", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "start_timer", description: "타이머", parameters: { type: "object", properties: { seconds: { type: "integer" }, label: { type: "string" } }, required: ["seconds"] } }
];
if (SEARCH) DECL.push({ name: "web_search", description: "구글 검색으로 최신 정보 확인(날씨, 뉴스, 가격, 영업시간, 경기 결과, 모르는 사실 등). 실시간·최신 정보가 필요하면 꼭 사용", parameters: { type: "object", properties: { query: { type: "string", description: "검색어(한국어 가능)" } }, required: ["query"] } });
const TOOLS = [{ functionDeclarations: DECL }];

const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const okTime = s => /^\d{2}:\d{2}$/.test(s || "");
const rep = r => (["daily", "weekdays", "weekly", "monthly"].includes(r) ? r : null);
const str = (v, n) => String(v || "").trim().slice(0, n);

async function runTool(st, name, a, emit) {
  const T = id => st.todos.find(x => x.id === id), E = id => st.events.find(x => x.id === id);
  const act = (icon, label) => emit({ type: "action", icon, label });
  switch (name) {
    case "add_todo": {
      const t = { id: uid(), text: str(a.text, 200), done: false, created: Date.now(), due: okDate(a.due) ? a.due : null, star: !!a.important };
      if (!t.text) return { error: "내용 없음" };
      st.todos.push(t); act("📝", t.text + " 추가"); return { ok: true, id: t.id };
    }
    case "update_todo": {
      const t = T(a.id); if (!t) return { error: "그런 할 일 없음. 목록의 id를 확인" };
      if (a.text) t.text = str(a.text, 200);
      if (a.due !== undefined) t.due = okDate(a.due) ? a.due : null;
      if (a.important !== undefined) t.star = !!a.important;
      if (a.done !== undefined) { t.done = !!a.done; t.doneAt = t.done ? Date.now() : null; }
      act(t.done ? "✅" : "✏️", t.text + (t.done ? " 완료" : " 수정")); return { ok: true };
    }
    case "delete_todo": { const t = T(a.id); if (!t) return { error: "그런 할 일 없음" }; st.todos = st.todos.filter(x => x !== t); act("🗑️", t.text + " 삭제"); return { ok: true }; }
    case "add_event": {
      if (!okDate(a.date)) return { error: "date는 YYYY-MM-DD" };
      const e = { id: uid(), title: str(a.title, 200), date: a.date, time: okTime(a.time) ? a.time : "", repeat: rep(a.repeat), notified: {}, star: !!a.important, note: str(a.note, 300), created: Date.now() };
      if (!e.title) return { error: "이름 없음" };
      st.events.push(e); act("📅", e.title + " 추가"); return { ok: true, id: e.id };
    }
    case "update_event": {
      const e = E(a.id); if (!e) return { error: "그런 일정 없음. 목록의 id를 확인" };
      if (a.title) e.title = str(a.title, 200);
      if (okDate(a.date)) e.date = a.date;
      if (a.time !== undefined) e.time = okTime(a.time) ? a.time : "";
      if (a.repeat !== undefined) e.repeat = rep(a.repeat);
      if (a.important !== undefined) e.star = !!a.important;
      if (a.note !== undefined) e.note = str(a.note, 300);
      e.notified = {}; act("✏️", e.title + " 변경"); return { ok: true };
    }
    case "delete_event": { const e = E(a.id); if (!e) return { error: "그런 일정 없음" }; st.events = st.events.filter(x => x !== e); act("🗑️", e.title + " 삭제"); return { ok: true }; }
    case "add_memo": { const m = { id: uid(), text: str(a.text, 1000), created: Date.now() }; if (!m.text) return { error: "비었음" }; st.memos.push(m); act("🗒️", "메모 저장"); return { ok: true, id: m.id }; }
    case "delete_memo": { const n = st.memos.length; st.memos = st.memos.filter(x => x.id !== a.id); if (n === st.memos.length) return { error: "그런 메모 없음" }; act("🗑️", "메모 삭제"); return { ok: true }; }
    case "remember_fact": {
      const f = str(a.fact, 200); if (!f) return { error: "비었음" };
      if (st.facts.some(x => x.text === f)) return { ok: true, note: "이미 기억 중" };
      st.facts.push({ id: uid(), text: f, created: Date.now() }); if (st.facts.length > 80) st.facts.shift();
      act("💡", "기억함: " + f); return { ok: true };
    }
    case "forget_fact": { const n = st.facts.length; st.facts = st.facts.filter(x => x.id !== a.id); if (n === st.facts.length) return { error: "없음" }; act("🧹", "기억 지움"); return { ok: true }; }
    case "set_user_name": { st.prof.name = str(a.name, 30); act("👋", st.prof.name + "님으로 부를게요"); return { ok: true }; }
    case "start_timer": { const s = Math.max(1, Math.min(86400, parseInt(a.seconds) || 0)); st.timers.push({ seconds: s, label: str(a.label, 50) }); act("⏳", "타이머 " + fmtSec(s)); return { ok: true }; }
    case "web_search": {
      const q = str(a.query, 200); if (!q) return { error: "검색어 없음" };
      act("🔎", q + " 검색");
      try { const r = await webSearch(q); r.sources.forEach(s => st.sources.some(x => x.url === s.url) || st.sources.push(s)); return { result: r.text, sources: r.sources.map(s => s.title).slice(0, 5) }; }
      catch (e) { return { error: "검색 실패: " + e.message }; }
    }
  }
  return { error: "알 수 없는 도구" };
}
const fmtSec = s => s >= 3600 ? Math.floor(s / 3600) + "시간" + (s % 3600 ? " " + Math.round(s % 3600 / 60) + "분" : "") : s >= 60 ? Math.round(s / 60) + "분" : s + "초";

/* ---------- 시스템 프롬프트 ---------- */
function systemPrompt(st) {
  const n = seoulNow();
  const cal = Array.from({ length: 21 }, (_, i) => { const d = addDays(n.date, i); return `${d.slice(5)}(${wdOf(d)})`; }).join(" ");
  const todos = st.todos.filter(t => !t.done).map(t => `- [${t.id}] ${t.text}${t.due ? " | 기한 " + t.due : ""}${t.star ? " | ⭐중요" : ""}`).join("\n") || "(없음)";
  const done = st.todos.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 12).map(t => `- [${t.id}] ${t.text}${t.doneAt ? " (" + new Date(t.doneAt).toLocaleDateString("ko-KR", { timeZone: TZ }) + " 완료)" : ""}`).join("\n") || "(없음)";
  const evs = st.events.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(e => `- [${e.id}] ${e.title} | ${e.date}(${wdOf(e.date)}) ${e.time || "종일"}${e.repeat ? " | 반복:" + e.repeat : ""}${e.star ? " | ⭐" : ""}${e.note ? " | " + e.note : ""}`).join("\n") || "(없음)";
  const memos = st.memos.slice(-40).map(m => `- [${m.id}] ${m.text}`).join("\n") || "(없음)";
  const facts = st.facts.map(f => `- [${f.id}] ${f.text}`).join("\n") || "(아직 없음)";
  return `너는 "Kitel"(키텔) 🪁 — ${st.prof.name ? st.prof.name + "님" : "사용자"}만을 위한 개인 비서 에이전트야. 슬로건: "맡기면 날아가서 해결해요".
지금: ${n.date} ${WDK[n.wd]}요일 ${n.time} (서울)
달력(오늘부터 3주): ${cal}
한 주는 월~일. "이번 주 X요일"=이번 월~일 중 X요일, "다음 주 X요일"=다음 월요일부터 시작하는 주의 X요일.

# 성격과 말투
- 똑똑하고 센스 있고 든든한 비서. 친근한 존댓말. 핵심부터 짧게. 필요할 때만 길게.
- 마크다운 사용 가능(**굵게**, 목록 "- ", 번호 목록). 표는 쓰지 마. 이모지는 적당히.
- 아첨·장황한 서론 금지. "~해 드릴까요?"로 끝내기보다 바로 처리하고 결과를 말해.

# 행동 원칙
1. 할 일·일정·메모를 만들거나 바꾸라는 말이면 **반드시 도구를 호출해 실제로 처리**해. 도구 없이 "했어요"라고 하면 거짓말이야.
2. 한 문장에 요청이 여러 개면 도구를 여러 번 호출해. 의도가 분명하면 되묻지 말고 상식으로 채워(“3시 회의”→15:00, 아침 08:00, 점심 12:00, 저녁 19:00, 밤 21:00).
3. 수정·삭제·완료는 아래 목록의 [id]로. "그거/방금 거"는 대화 맥락으로 판단. 비슷한 게 여러 개라 정말 헷갈릴 때만 짧게 확인.
4. 날짜·시간·요일 계산은 위 달력을 보고 신중히. 결과는 "내일(월) 오후 3시"처럼 읽기 쉽게.
5. 일정·할 일 질문(언제야/비는 시간/이번 주 뭐 해/몇 개 했어)은 아래 데이터로 정확히. 없는 건 지어내지 마.
6. 날씨·뉴스·가격·영업시간·최신 사실처럼 바뀌는 정보는 web_search로 찾아서 답해. 추측 금지.
7. 사용자가 자기 취향·상황·습관을 말하면 remember_fact로 기억해 두고, 이후 답변에 자연스럽게 활용해.
8. 사진이 오면 내용을 꼼꼼히 읽어(시간표·포스터·영수증·메모 등). 일정/할 일로 넣어 달라는 뜻이면 바로 넣어.
9. 일정 겹침, 기한 지난 할 일, 무리한 하루 같은 건 한 줄로 챙겨 주는 센스.
10. 공부·코딩·글쓰기·고민 상담·아이디어 등 무엇이든 진짜 실력으로 도와줘.
11. 뭘 할 수 있냐고 물으면: 할 일·일정(반복 포함)·메모 관리, 10분 전 알림, 타이머, 웹 검색, 사진 읽기(시간표→일정), 취향 기억, 음성 입력, 공부·고민 상담을 짧게 소개.
12. 앱 하단 탭(대화/할 일/일정)에 바로 반영되니, 처리 후 목록 전체를 길게 다시 나열하지 마.

# 사용자에 대해 기억하는 것
${facts}
# 남은 할 일
${todos}
# 최근 완료
${done}
# 일정
${evs}
# 메모
${memos}`;
}

/* ---------- Gemini 호출 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gfetch(method, body, stream) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = MODELS[Math.min(modelIdx, MODELS.length - 1)];
    const url = API + encodeURIComponent(model) + ":" + (stream ? "streamGenerateContent?alt=sse" : "generateContent");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (r.ok) return { r, model };
    const txt = await r.text().catch(() => "");
    let msg = txt; try { msg = JSON.parse(txt).error.message; } catch (e) {}
    if ((r.status === 404 || (r.status === 400 && /model/i.test(msg) && /not (found|supported)/i.test(msg))) && modelIdx < MODELS.length - 1) { console.warn("모델 전환:", model, "→", MODELS[modelIdx + 1], msg); modelIdx++; continue; }
    if ((r.status === 429 || r.status === 500 || r.status === 503) && attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
    const e = new Error(msg.slice(0, 300) || "Gemini 오류 " + r.status); e.status = r.status; throw e;
  }
}

async function webSearch(q) {
  const n = seoulNow();
  const { r } = await gfetch("search", {
    systemInstruction: { parts: [{ text: `오늘은 ${n.date} ${n.time}(서울). 검색 결과를 바탕으로 질문에 대한 핵심 사실만 한국어로 간결히 정리해. 숫자·날짜·출처 이름을 정확히.` }] },
    contents: [{ role: "user", parts: [{ text: q }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 900 }
  }, false);
  const j = await r.json();
  const c = j.candidates?.[0];
  const text = (c?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
  const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: str(w.title, 80), url: w.uri })).slice(0, 6);
  if (!text) throw new Error("결과 없음");
  return { text, sources };
}

// SSE 스트림을 읽으며 텍스트는 바로 전달, 파트는 모아서 반환
async function streamTurn(contents, sys, emit) {
  const body = { systemInstruction: { parts: [{ text: sys }] }, contents, tools: TOOLS, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } };
  const { r } = await gfetch("chat", body, true);
  const parts = []; let buf = "", block = null, finish = "";
  const dec = new TextDecoder();
  const add = p => {
    if (p.text !== undefined && !p.functionCall) {
      if (!p.thought) emit({ type: "text", delta: p.text });
      const last = parts[parts.length - 1];
      if (last && last.text !== undefined && !last.functionCall && !!last.thought === !!p.thought && !p.thoughtSignature) { last.text += p.text; return; }
    }
    parts.push(p);
  };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
      if (j.promptFeedback?.blockReason) block = j.promptFeedback.blockReason;
      const c = j.candidates?.[0];
      if (c?.finishReason) finish = c.finishReason;
      for (const p of c?.content?.parts || []) add(p);
    }
  }
  return { parts, block, finish };
}

async function agent(body, emit) {
  const s = body.state || {};
  const st = {
    todos: Array.isArray(s.todos) ? s.todos.slice(0, 600) : [],
    events: Array.isArray(s.events) ? s.events.slice(0, 600) : [],
    memos: Array.isArray(s.memos) ? s.memos.slice(0, 400) : [],
    facts: Array.isArray(s.facts) ? s.facts.slice(0, 80) : [],
    prof: { name: str(s.prof?.name, 30) }, timers: [], sources: []
  };
  const contents = [];
  for (const h of (Array.isArray(body.history) ? body.history.slice(-20) : [])) {
    if (!h || !h.text) continue;
    const role = h.role === "me" ? "user" : "model";
    const text = String(h.text).slice(0, 3000);
    if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts[0].text += "\n" + text;
    else contents.push({ role, parts: [{ text }] });
  }
  while (contents.length && contents[0].role !== "user") contents.shift();
  if (contents.length && contents[contents.length - 1].role === "user") contents.pop(); // 현재 메시지는 아래에서 추가
  const userParts = [];
  if (body.image && /^data:image\/(jpeg|png|webp);base64,/.test(body.image) && body.image.length < 6e6) {
    const [, mime, data] = body.image.match(/^data:(image\/\w+);base64,(.+)$/);
    userParts.push({ inlineData: { mimeType: mime, data } });
  }
  userParts.push({ text: str(body.message, 6000) || (userParts.length ? "이 사진 봐 줘" : "안녕") });
  contents.push({ role: "user", parts: userParts });

  let gotText = false, lastText = "";
  for (let round = 0; round < 8; round++) {
    const { parts, block, finish } = await streamTurn(contents, systemPrompt(st), ev => { if (ev.type === "text" && ev.delta) { gotText = true; lastText += ev.delta; } emit(ev); });
    if (block) { emit({ type: "text", delta: "그 내용은 도와드리기 어려워요." }); gotText = true; break; }
    if (!parts.length) { if (!gotText) emit({ type: "text", delta: finish === "SAFETY" ? "그 내용은 도와드리기 어려워요." : "잠깐 생각이 꼬였어요. 다시 한 번 말해 주세요." }); gotText = true; break; }
    contents.push({ role: "model", parts });
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) break;
    if (gotText) emit({ type: "text", delta: "\n\n" });
    const resp = [];
    for (const p of calls) resp.push({ functionResponse: { name: p.functionCall.name, response: await runTool(st, p.functionCall.name, p.functionCall.args || {}, emit) } });
    contents.push({ role: "user", parts: resp });
  }
  if (!gotText) emit({ type: "text", delta: "처리했어요! ✅" });
  return { state: { todos: st.todos, events: st.events, memos: st.memos, facts: st.facts, prof: st.prof }, timers: st.timers, sources: st.sources };
}

/* ---------- 남용 방지 ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr); if (hits.size > 5000) hits.clear();
  return arr.length > 40;
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }

/* ---------- 정적 파일 (메모리 캐시 + gzip) ---------- */
const cache = new Map();
function serveStatic(req, res, p) {
  if (p === "/") p = "/index.html";
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  const done = (f, data) => {
    const ext = path.extname(f);
    const gz = /gzip/.test(req.headers["accept-encoding"] || "") && /\.(html|js|json|svg)$/.test(ext);
    let c = cache.get(f); if (!c) { c = { raw: data, gz: zlib.gzipSync(data) }; cache.set(f, c); }
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": /\.(html|js)$/.test(ext) || f.endsWith("sw.js") ? "no-cache" : "public, max-age=86400", ...(gz ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}) });
    res.end(gz ? c.gz : c.raw);
  };
  if (cache.has(file)) return done(file, cache.get(file).raw);
  fs.readFile(file, (err, data) => {
    if (!err) return done(file, data);
    const idx = path.join(PUB, "index.html");
    fs.readFile(idx, (e2, d2) => { if (e2) { res.writeHead(404); return res.end("not found"); } done(idx, d2); });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/health") return json(res, 200, { ai: !!KEY, pin: !!PIN, model: KEY ? MODELS[Math.min(modelIdx, MODELS.length - 1)] : null, search: SEARCH, v: 4 });
  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if (!KEY) return json(res, 503, { error: "no_key" });
    if (PIN && req.headers["x-kitel-pin"] !== PIN) return json(res, 401, { error: "pin" });
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (limited(ip)) return json(res, 429, { error: "too_many" });
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 8e6) req.destroy(); });
    req.on("end", async () => {
      let body; try { body = JSON.parse(raw || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
      const emit = ev => { try { res.write("data: " + JSON.stringify(ev) + "\n\n"); } catch (e) {} };
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 15000);
      try { const out = await agent(body, emit); emit({ type: "done", ...out }); }
      catch (e) { console.error("chat error:", e.status, e.message); emit({ type: "error", status: e.status || 500, message: e.message }); }
      clearInterval(ping); res.end();
    });
    return;
  }
  serveStatic(req, res, decodeURIComponent(url.pathname));
}).listen(PORT, () => console.log(`Kitel v4 on :${PORT} · AI ${KEY ? "ON (" + MODELS.join(" → ") + ")" : "OFF (GEMINI_API_KEY 없음)"} · 검색 ${SEARCH ? "ON" : "OFF"}`));
