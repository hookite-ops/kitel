/* Kitel v2 — 규칙 엔진 + 선택형 온디바이스 AI 두뇌 */
(()=>{
"use strict";
const VERSION="4.0";
/* ================= 저장소 ================= */
const S={
  get(k,d){try{const v=localStorage.getItem("kitel."+k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem("kitel."+k,JSON.stringify(v))}catch(e){}}
};
let todos=S.get("todos",[]);   // {id,text,done,created,doneAt,due,star}
let events=S.get("events",[]); // {id,title,date,time,repeat,notified:{},star,created}
let memos=S.get("memos",[]);
let facts=S.get("facts",[]);  // AI가 기억하는 사용자 정보
let chat=S.get("chat",[]);
let prof=S.get("prof",{name:""});
let opt=Object.assign({tts:false},S.get("opt",{}));
// 구버전 데이터 호환
events.forEach(e=>{if(typeof e.notified!=="object"||!e.notified)e.notified={};if(e.repeat===undefined)e.repeat=null});
todos.forEach(t=>{if(t.due===undefined)t.due=null});

let ctx={lastList:null,lastIds:[],ref:null}; // ref: {type:'todo'|'event',id}
const undoStack=[];
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function snap(){undoStack.push(JSON.stringify({todos,events,memos}));if(undoStack.length>15)undoStack.shift()}
let saveT=0;
function save(){
  S.set("todos",todos);S.set("events",events);S.set("memos",memos);S.set("facts",facts);S.set("prof",prof);S.set("opt",opt);
  cancelAnimationFrame(saveT);saveT=requestAnimationFrame(renderAll);
}
const saveChat=()=>S.set("chat",chat.slice(-200));

/* ================= 날짜 도구 ================= */
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const today=()=>{const d=new Date();d.setHours(0,0,0,0);return d};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const fromYmd=s=>new Date(s+"T00:00");
const WD=["일","월","화","수","목","금","토"];
function dateLabel(s){
  const T=today();
  if(s===ymd(T))return "오늘";if(s===ymd(addDays(T,1)))return "내일";
  if(s===ymd(addDays(T,2)))return "모레";if(s===ymd(addDays(T,-1)))return "어제";
  const d=fromYmd(s);return (d.getMonth()+1)+"월 "+d.getDate()+"일 ("+WD[d.getDay()]+")";
}
function timeLabel(t){
  if(!t)return "하루 종일";
  const [h,m]=t.split(":").map(Number);
  return (h<12?"오전":"오후")+" "+((h%12)||12)+"시"+(m?" "+m+"분":"");
}
const nowHM=()=>{const d=new Date();return pad(d.getHours())+":"+pad(d.getMinutes())};
const REP={daily:"매일",weekdays:"평일마다",weekly:"매주",monthly:"매달"};
function repLabel(e){
  if(!e.repeat)return "";
  if(e.repeat==="weekly")return "매주 "+WD[fromYmd(e.date).getDay()]+"요일";
  if(e.repeat==="monthly")return "매달 "+fromYmd(e.date).getDate()+"일";
  return REP[e.repeat];
}
/* 반복 포함: 특정 날짜에 이 일정이 있는지 */
function occursOn(e,day){
  if(day<e.date)return false;
  if(!e.repeat)return e.date===day;
  const d=fromYmd(day),s=fromYmd(e.date);
  if(e.repeat==="daily")return true;
  if(e.repeat==="weekdays")return d.getDay()>0&&d.getDay()<6;
  if(e.repeat==="weekly")return d.getDay()===s.getDay();
  if(e.repeat==="monthly")return d.getDate()===s.getDate();
  return false;
}
/* 기간 내 발생 목록 [{e,date,ms}] */
function occurrences(fromDay,toDay){
  const out=[];let d=fromYmd(fromDay);const end=fromYmd(toDay);
  while(d<=end){const k=ymd(d);for(const e of events)if(occursOn(e,k))out.push({e,date:k,ms:new Date(k+"T"+(e.time||"23:59")).getTime()});d=addDays(d,1)}
  return out.sort((a,b)=>a.ms-b.ms||(a.e.time?0:1)-(b.e.time?0:1));
}
function nextOcc(e){const t=ymd(today());const o=occurrences(t>e.date?t:e.date,ymd(addDays(fromYmd(t>e.date?t:e.date),40))).find(x=>x.e===e);return o}

/* ================= 자연어 날짜·시간 해석 ================= */
function parseWhen(text){
  let s=" "+text+" ",date=null,time=null,repeat=null,hit=false,ampm="";
  const T=today();let m;
  const cut=x=>{s=s.replace(x," ");hit=true};
  // 상대 시간: 30분 뒤, 2시간 후
  if((m=s.match(/(\d+)\s*(분|시간)\s*(뒤|후|있다가)(에)?/))){
    const d=new Date(Date.now()+(+m[1])*(m[2]==="분"?6e4:36e5));
    date=new Date(d.getFullYear(),d.getMonth(),d.getDate());time=pad(d.getHours())+":"+pad(d.getMinutes());cut(m[0]);
  }
  if((m=s.match(/(?:한\s*)?시간\s*(뒤|후)(에)?/))&&!time){const d=new Date(Date.now()+36e5);date=new Date(d.getFullYear(),d.getMonth(),d.getDate());time=pad(d.getHours())+":"+pad(d.getMinutes());cut(m[0])}
  // 반복
  if((m=s.match(/(?:매일|날마다|하루마다)(\s*마다)?/))){repeat="daily";cut(m[0])}
  else if((m=s.match(/(?:평일\s*(?:마다)?|주중\s*마다)/))){repeat="weekdays";cut(m[0])}
  else if((m=s.match(/매주\s*(월|화|수|목|금|토|일)요일(마다)?|(월|화|수|목|금|토|일)요일\s*마다/))){
    repeat="weekly";const wd=WD.indexOf(m[1]||m[3]);date=addDays(T,(wd-T.getDay()+7)%7);cut(m[0]);
  }
  else if((m=s.match(/(?:매달|매월)\s*(\d{1,2})\s*일(마다)?/))){
    repeat="monthly";let d=new Date(T.getFullYear(),T.getMonth(),+m[1]);if(d<T)d.setMonth(d.getMonth()+1);date=d;cut(m[0]);
  }
  // 상대 날짜
  if(!date){
    const rel=[["내일\\s*모레",2],["오늘",0],["금일",0],["내일",1],["낼",1],["모레",2],["글피",3],["어제",-1]];
    for(const [k,n] of rel){const re=new RegExp("(^|\\s)"+k+"(은|에|에는|도|까지|중에|중으로|으로|로)?(?=\\s)");if(re.test(s)){date=addDays(T,n);cut(re);break}}
  }
  if(!date&&(m=s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/))){date=new Date(+m[1],+m[2]-1,+m[3]);cut(m[0])}
  if(!date&&(m=s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일(에|에는|까지|로)?/))){
    let d=new Date(T.getFullYear(),+m[1]-1,+m[2]);if(d<T)d.setFullYear(d.getFullYear()+1);date=d;cut(m[0]);
  }
  if(!date&&(m=s.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/))){let d=new Date(T.getFullYear(),+m[1]-1,+m[2]);if(d<T)d.setFullYear(d.getFullYear()+1);date=d;cut(m[0])}
  if(!date&&(m=s.match(/다음\s*달\s*(\d{1,2})\s*일(에|까지)?/))){date=new Date(T.getFullYear(),T.getMonth()+1,+m[1]);cut(m[0])}
  if(!date&&(m=s.match(/(\d+)\s*일\s*(뒤|후)(에)?/))){date=addDays(T,+m[1]);cut(m[0])}
  if(!date&&(m=s.match(/(\d+)\s*주\s*(뒤|후)(에)?/))){date=addDays(T,7*m[1]);cut(m[0])}
  if(!date&&(m=s.match(/(다음\s*주|담주|이번\s*주)\s*(?:에)?(?=\s)(?!\s*(월|화|수|목|금|토|일)요일)/))&&!/일정|할\s*일|뭐/.test(s)){
    date=/다음|담/.test(m[1])?addDays(T,((8-T.getDay())%7)||7):T;cut(m[0]);
  }
  if(!date&&(m=s.match(/(이번\s*)?주말(에|로)?/))){date=addDays(T,(6-T.getDay()+7)%7);cut(m[0])}
  if(!date&&(m=s.match(/(다음\s*주|담주|이번\s*주)?\s*(월|화|수|목|금|토|일)요일(에|에는|까지|로)?/))){
    const wd=WD.indexOf(m[2]);let diff=(wd-T.getDay()+7)%7;
    if(m[1]&&/다음|담/.test(m[1])){const toNextMon=((8-T.getDay())%7)||7;diff=toNextMon+((wd+6)%7)}
    date=addDays(T,diff);cut(m[0]);
  }
  if(!date&&(m=s.match(/(\d{1,2})\s*일(에|에는|까지|로)?(?=\s)/))&&!/\d\s*일\s*(동안|간|째)/.test(s)){
    let d=new Date(T.getFullYear(),T.getMonth(),+m[1]);if(d<T)d.setMonth(d.getMonth()+1);date=d;cut(m[0]);
  }
  // 시각
  if(!time){
    if((m=s.match(/(새벽|아침|오전|낮|점심|오후|저녁|밤)?\s*(\d{1,2})\s*시\s*(반|(\d{1,2})\s*분)?\s*(쯤|정도|경)?(에|까지|부터)?/))){
      let h=+m[2],mi=m[3]==="반"?30:(m[4]?+m[4]:0);ampm=m[1]||"";
      if(/오후|저녁|밤/.test(ampm)&&h<12)h+=12;
      else if(/낮|점심/.test(ampm)&&h<6)h+=12;
      else if(!ampm&&h>=1&&h<=6)h+=12;
      if(/새벽|아침|오전/.test(ampm)&&h===12)h=0;
      if(h<24&&mi<60){time=pad(h)+":"+pad(mi);cut(m[0])}
    }else if((m=s.match(/(오전|오후)?\s*(\d{1,2}):(\d{2})/))){
      let h=+m[2];ampm=m[1]||"";if(ampm==="오후"&&h<12)h+=12;if(h<24){time=pad(h)+":"+m[3];cut(m[0])}
    }else if((m=s.match(/(아침|점심|저녁)(에|때)?(?=\s)/))&&(date||repeat)){
      time={아침:"08:00",점심:"12:00",저녁:"19:00"}[m[1]];ampm=m[1];cut(m[0]);
    }
  }
  // 오늘인데 이미 지난 오전 시각이면 오후로
  if(time&&!ampm&&(!date||ymd(date)===ymd(T))&&!repeat){
    let [h,mi]=time.split(":").map(Number);const n=new Date();
    if(h<12&&h*60+mi<=n.getHours()*60+n.getMinutes()){h+=12;time=pad(h)+":"+pad(mi)}
  }
  if(time&&!date){
    date=T;const [h,mi]=time.split(":").map(Number);const n=new Date();
    if(!repeat&&h*60+mi<=n.getHours()*60+n.getMinutes())date=addDays(T,1);
  }
  if(repeat&&!date)date=T;
  return {hit,date:date?ymd(date):null,time,repeat,rest:s.replace(/\s+/g," ").trim()};
}
const STAR_RE=/(아주\s*|정말\s*|진짜\s*)?(중요(한|해|함)?|급(한|해|함)|꼭|필수|!!+|⭐)/g;
function cleanTitle(t){
  return t.replace(STAR_RE," ")
   .replace(/(일정|약속|스케줄)\s*(으로|에)?\s*(추가|등록|잡아|넣어|저장|기록)?\s*(해\s*줘|해줘|해\s*주세요|해|좀|줘)?/g," ")
   .replace(/(추가|등록|저장|기억|넣어)\s*(해\s*줘|해줘|해\s*주세요|해|좀|줘)?/g," ")
   .replace(/(해야\s*(해|돼|됨|함|한다|된다|하는데|겠다)|있어|있음|있다|있대|가야\s*(해|돼)|잡혀\s*있어|하기로\s*했어|할\s*거야|할게)/g," ")
   .replace(/(할\s*일|투두|todo)\s*(에|로|으로)?/gi," ")
   .replace(/(알려\s*줘|알림|리마인드)\s*(해\s*줘)?/g," ")
   .replace(/[.!?~]+$/,"").replace(/\s+(에|은|는|이|가|을|를|까지)$/,"").replace(/^(나|저|난|나는|저는|우리)\s+/,"")
   .replace(/\s+/g," ").trim();
}

/* ================= 유사도 검색 ================= */
const norm=s=>s.replace(/\s+/g,"").toLowerCase();
function bigrams(s){const a=[];for(let i=0;i<s.length-1;i++)a.push(s.slice(i,i+2));return a.length?a:[s]}
function sim(a,b){
  a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 1;
  if(a.includes(b)||b.includes(a))return .85*Math.min(a.length,b.length)/Math.max(a.length,b.length)+.15;
  const A=bigrams(a),B=bigrams(b);let hit=0;const pool=[...B];
  for(const g of A){const i=pool.indexOf(g);if(i>=0){hit++;pool.splice(i,1)}}
  return 2*hit/(A.length+B.length);
}
function best(list,key,get){
  let b=null,bs=0;for(const x of list){const sc=sim(get(x),key);if(sc>bs){bs=sc;b=x}}
  return bs>=.34?b:null;
}
const isRefWord=k=>/^(그거|그것|그\s*일정|그\s*할\s*일|방금\s*(거|그거|것)?|아까\s*(거|그거)?|이거)$/.test(k.trim());
function findTarget(key,pref){
  key=key.replace(/(을|를|은|는|이|가)$/,"").trim();
  if(!key||isRefWord(key)||isRefWord(key.replace(/(일정|할\s*일)$/,"").trim())){
    if(ctx.ref){const l=ctx.ref.type==="todo"?todos:events;const x=l.find(y=>y.id===ctx.ref.id);if(x)return {type:ctx.ref.type,item:x}}
    return null;
  }
  key=key.replace(/^그\s+/,"").replace(/\s*(일정|할\s*일)$/,"").trim();
  const t=best(todos.filter(x=>!x.done),key,x=>x.text),e=best(events,key,x=>x.title);
  if(t&&e){const st=sim(t.text,key),se=sim(e.title,key);if(pref==="event"||se>st)return {type:"event",item:e};return {type:"todo",item:t}}
  if(e&&pref!=="todo")return {type:"event",item:e};
  if(t)return {type:"todo",item:t};
  if(e)return {type:"event",item:e};
  return null;
}

/* ================= 응답 엔진 ================= */
const pick=a=>a[Math.floor(Math.random()*a.length)];
const nm=()=>prof.name?prof.name+"님":"";
const pending=()=>todos.filter(t=>!t.done).sort((a,b)=>{
  const s=(b.star?1:0)-(a.star?1:0);if(s)return s;
  const ad=a.due||"9999",bd=b.due||"9999";if(ad!==bd)return ad<bd?-1:1;
  return (a.created||0)-(b.created||0);
});
function todoLine(t){return (t.star?"⭐ ":"")+t.text+(t.due?" ("+dateLabel(t.due)+"까지)":"")}
function evLine(o,withDate){return (withDate?dateLabel(o.date)+" ":"")+timeLabel(o.e.time)+" · "+(o.e.star?"⭐ ":"")+o.e.title+(o.e.repeat?" 🔁":"")}

function listTodos(){
  const p=pending();
  if(!p.length){ctx.lastList=null;return pick(["남은 할 일이 없어요! 🎉 완전 깔끔해요.","할 일 목록이 비었어요. 오늘은 여유롭게 보내도 되겠네요 😌"])}
  ctx.lastList="todo";ctx.lastIds=p.map(t=>t.id);
  return "📝 남은 할 일 "+p.length+"개\n"+p.map((t,i)=>(i+1)+". "+todoLine(t)).join("\n")+"\n\n\"1번 완료\", \"2번 삭제\"처럼 말해 주세요.";
}
function listEvents(from,to,label){
  const list=occurrences(from,to).filter(o=>from!==ymd(today())||!o.e.time||o.ms>=Date.now()-36e5||to!==from);
  if(!list.length){ctx.lastList=null;return label+"은 비어 있어요. 자유 시간이에요 🪁"}
  const shown=list.slice(0,15);ctx.lastList="event";ctx.lastIds=shown.map(o=>o.e.id);
  return "📅 "+label+"\n"+shown.map((o,i)=>(i+1)+". "+evLine(o,from!==to)).join("\n")+(list.length>15?"\n…외 "+(list.length-15)+"개":"");
}
function briefing(){
  const t=ymd(today()),te=occurrences(t,t),p=pending(),h=new Date().getHours();
  const hi=h<5?"늦은 밤이에요":h<11?"좋은 아침이에요":h<17?"좋은 오후예요":"좋은 저녁이에요";
  const nextE=te.find(o=>o.e.time&&o.ms>Date.now());
  const overdue=p.filter(x=>x.due&&x.due<t);
  let s=hi+(nm()?", "+nm():"")+"! ☀️\n";
  s+=te.length?"📅 오늘 일정 "+te.length+"개: "+te.map(o=>(o.e.time?timeLabel(o.e.time)+" ":"")+o.e.title).join(", "):"📅 오늘은 잡힌 일정이 없어요.";
  if(nextE){const mins=Math.round((nextE.ms-Date.now())/6e4);s+="\n⏭️ 다음: "+nextE.e.title+" ("+(mins<60?mins+"분":Math.floor(mins/60)+"시간 "+(mins%60)+"분")+" 뒤)"}
  s+="\n📝 "+(p.length?"남은 할 일 "+p.length+"개"+(p.filter(x=>x.star).length?" (중요 "+p.filter(x=>x.star).length+"개)":""):"남은 할 일도 없어요!");
  if(overdue.length)s+="\n⚠️ 기한 지난 할 일: "+overdue.map(x=>x.text).join(", ");
  return s;
}
function freeTime(day){
  const occ=occurrences(day,day).filter(o=>o.e.time);
  const busy=occ.map(o=>{const [h,m]=o.e.time.split(":").map(Number);return [h*60+m,h*60+m+60]});
  let start=9*60;if(day===ymd(today())){const n=new Date();start=Math.max(start,Math.ceil((n.getHours()*60+n.getMinutes())/30)*30)}
  const end=22*60,gaps=[];let cur=start;
  busy.sort((a,b)=>a[0]-b[0]).forEach(([a,b])=>{if(a-cur>=60)gaps.push([cur,a]);cur=Math.max(cur,b)});
  if(end-cur>=60)gaps.push([cur,end]);
  const f=x=>timeLabel(pad(Math.floor(x/60))+":"+pad(x%60));
  if(!gaps.length)return dateLabel(day)+"은 꽉 찼어요 😵 (오전 9시~오후 10시 기준)";
  return "🕊️ "+dateLabel(day)+" 비는 시간\n"+gaps.map(([a,b])=>"· "+f(a)+" ~ "+f(b)).join("\n");
}
const HELP=`제가 할 수 있는 일이에요 🪁

📝 할 일
· "장보기 해야 해" · "중요한 보고서 금요일까지"
· "할 일 보여줘" · "1번 완료" · "숙제 다 했어"

📅 일정
· "내일 오후 3시 치과" · "30분 뒤 회의"
· "매주 월요일 9시 학원" · "매일 아침 8시 약"
· "치과 4시로 바꿔줘" · "그거 내일로 미뤄줘"
· "치과 언제야?" · "내일 언제 비어?"
· "오늘 일정" · "이번 주 일정"

🗒️ 메모: "메모 사물함 27" · "메모 보여줘"

✨ 그 밖에
· "브리핑" · "되돌려" · "이번 주 몇 개 했어?"
· "12*34" · "짜장 vs 짬뽕 골라줘" · "타이머 5분"
· 🎤 버튼으로 말로 하기
· 여러 개 한 번에: "빨래 해야 해 그리고 내일 3시 치과"`;

const TALK=[
  [/^(안녕|하이|ㅎㅇ|hi|hello|헬로|반가)/i,()=>pick(["안녕하세요"+(nm()?" "+nm():"")+"! 오늘은 뭘 도와드릴까요? 🪁","반가워요! 할 일이나 일정 있으면 편하게 말해 주세요."])],
  [/(넌|너는|너)\s*(누구|뭐야|이름)|이름이\s*뭐/,()=>"저는 Kitel이에요 🪁 할 일과 일정을 챙겨 주는 나만의 비서예요. 맡기면 날아가서 해결해요!"],
  [/(고마|감사|땡큐|thx|thanks)/i,()=>pick(["천만에요! 언제든 불러 주세요 😊","도움이 됐다니 기뻐요!"])],
  [/(사랑해|좋아해)/,()=>pick(["저도 같이 일하는 거 좋아요 🪁","헤헤, 그 말 들으니 바람 타고 더 높이 날 것 같아요!"])],
  [/(심심|지루)/,()=>pick(["\"주사위\"를 굴려 볼까요? 아니면 미뤄 둔 할 일 하나를 처리해 보는 것도 좋아요 😏","재밌는 사실: 연은 2,000년도 더 전에 중국에서 처음 만들어졌대요 🪁"])],
  [/(피곤|힘들|지쳤|졸려)/,()=>pick(["오늘 고생 많았어요. 물 한 잔 마시고 잠깐 쉬어 가요 💧","무리하지 마세요. 급하지 않은 할 일은 내일로 미뤄도 괜찮아요."])],
  [/(배고|뭐\s*먹)/,()=>"오늘의 추천 메뉴는… "+pick(["김치찌개","치킨","떡볶이","돈까스","라멘","비빔밥","햄버거","마라탕","초밥","제육볶음","쌀국수","냉면"])+"! 🍽️"],
  [/(잘\s*자|굿밤|굿나잇|잘게)/,()=>{const d=ymd(addDays(today(),1)),tm=occurrences(d,d);return "잘 자요 🌙"+(tm.length?"\n내일 첫 일정: "+(tm[0].e.time?timeLabel(tm[0].e.time)+" ":"")+tm[0].e.title:"")}],
  [/^(ㅋㅋ+|ㅎㅎ+|하하+)$/,()=>pick(["😆","ㅋㅋ 기분 좋아 보여요!"])],
  [/(날씨)/,()=>"날씨는 아직 못 봐요 🌤️ 대신 일정은 확실히 챙길게요!"],
];

function addEvent(title,w,star){
  snap();const e={id:uid(),title,date:w.date,time:w.time||"",repeat:w.repeat||null,notified:{},star:!!star,created:Date.now()};
  events.push(e);ctx.ref={type:"event",id:e.id};save();
  return "📅 일정 추가했어요!\n"+(e.repeat?repLabel(e):dateLabel(e.date))+" "+timeLabel(e.time)+" · "+(star?"⭐ ":"")+title+(e.time?"\n10분 전에 알려 드릴게요 🔔":"");
}
function addTodo(text,due,star){
  snap();const t={id:uid(),text,done:false,created:Date.now(),due:due||null,star:!!star};
  todos.push(t);ctx.ref={type:"todo",id:t.id};save();
  return "📝 할 일 추가: \""+(star?"⭐ ":"")+text+"\""+(due?" — "+dateLabel(due)+"까지":"")+"\n(남은 할 일 "+pending().length+"개)";
}
function completeTodo(t){snap();t.done=true;t.doneAt=Date.now();ctx.ref={type:"todo",id:t.id};save();const left=pending().length;
  return "✅ \""+t.text+"\" 완료! "+(left?pick(["수고했어요 👏","좋아요!","하나 끝!"])+" 남은 할 일 "+left+"개.":"할 일을 전부 끝냈어요! 🎉")}
function removeItem(type,x){snap();if(type==="todo")todos=todos.filter(y=>y!==x);else events=events.filter(y=>y!==x);ctx.ref=null;save();
  return "🗑️ "+(type==="todo"?"할 일 \""+x.text+"\"":(x.repeat?"반복 일정 \""+x.title+"\"(전체)":dateLabel(x.date)+" \""+x.title+"\" 일정"))+"을 지웠어요. (\"되돌려\"로 복구 가능)"}

function respond(s){
  let m;
  if(/^(도움|도움말|help|\?|사용법|명령어)$|뭐\s*(할\s*수|해\s*줄\s*수)|기능\s*(알려|뭐)/i.test(s))return HELP;
  if(/^(브리핑|요약|오늘\s*요약)|오늘\s*(뭐\s*해|어때|어떻게\s*돼)/.test(s))return briefing();
  // 되돌리기
  if(/^(되돌려|되돌리기|실행\s*취소|undo|방금\s*(거\s*)?취소|취소\s*해\s*줘)/i.test(s)){
    if(!undoStack.length)return "되돌릴 작업이 없어요.";
    const o=JSON.parse(undoStack.pop());todos=o.todos;events=o.events;memos=o.memos;ctx.ref=null;save();return "↩️ 방금 작업을 되돌렸어요.";
  }
  // 이름
  if((m=s.match(/(?:내|제)\s*이름은\s*([^\s]+?)(?:이야|야|입니다|이에요|예요|라고|이라고)?[.!]?$/))){
    prof.name=m[1].replace(/(이야|야)$/,"");save();return "반가워요, "+prof.name+"님! 이제 이름으로 부를게요 😊";
  }
  // 번호 지칭
  if((m=s.match(/^(\d+)\s*번(?:\s*(?:일정|할\s*일|거|은|는|을|를))?\s*(.*)$/))){
    const n=+m[1],act=m[2];
    if(!ctx.lastList){ctx.lastList="todo";ctx.lastIds=pending().map(t=>t.id)}
    const id=ctx.lastIds[n-1];
    if(!id)return n+"번 항목을 찾지 못했어요. \"할 일 보여줘\"나 \"일정 보여줘\"로 번호를 먼저 확인해 주세요.";
    const type=ctx.lastList,x=(type==="todo"?todos:events).find(y=>y.id===id);
    if(!x)return "이미 정리된 항목이에요.";
    ctx.ref={type,id};
    if(/(삭제|지워|빼|없애|취소)/.test(act))return removeItem(type,x);
    if(type==="todo"&&/(완료|했|끝|다\s*함|체크)/.test(act))return completeTodo(x);
    if(/(중요|별)/.test(act)){snap();x.star=true;save();return "⭐ 중요 표시했어요."}
    if(/(바꿔|변경|옮겨|미뤄|연기|당겨|수정)/.test(act))return editWhen({type,item:x},act);
    return type==="todo"?"\""+x.text+"\"을(를) 어떻게 할까요? (완료/삭제/중요)":"\""+x.title+"\" — "+(x.repeat?repLabel(x):dateLabel(x.date))+" "+timeLabel(x.time);
  }
  // 통계
  if(/(몇\s*개|얼마나|몇\s*건).*(했|완료|끝냈)/.test(s)){
    const days=/오늘/.test(s)?0:/이번\s*달/.test(s)?new Date().getDate()-1:today().getDay();
    const since=addDays(today(),-days).getTime();const n=todos.filter(t=>t.done&&t.doneAt>=since).length;
    const label=/오늘/.test(s)?"오늘":/이번\s*달/.test(s)?"이번 달":"이번 주";
    return "📊 "+label+" 완료한 할 일: "+n+"개"+(n?" 👏":"")+"\n남은 할 일: "+pending().length+"개";
  }
  // 비는 시간
  if(/(언제|몇\s*시에?)\s*(비어|비|한가|시간\s*(돼|있|나)|여유)|빈\s*시간|비는\s*시간/.test(s)){const w=parseWhen(s);return freeTime(w.date||ymd(today()))}
  // 목록 보기
  if(/(할\s*일|투두|todo).*(보여|목록|뭐|알려|확인|있|리스트)|^(할\s*일|투두|todo)\s*$/i.test(s))return listTodos();
  if(/^(중요한?\s*(거|것|할\s*일)|별표).*(보여|뭐|알려)?/.test(s)){const p=pending().filter(t=>t.star);if(!p.length)return "중요 표시한 할 일이 없어요.";ctx.lastList="todo";ctx.lastIds=p.map(t=>t.id);return "⭐ 중요한 할 일\n"+p.map((t,i)=>(i+1)+". "+todoLine(t)).join("\n")}
  const askList=/(일정|스케줄|약속|계획).*(보여|목록|뭐|알려|확인|있|리스트|어때)|(일정|스케줄)\s*(은|좀)?\s*[?？]?$/.test(s)||/^(오늘|내일|모레|이번\s*주|다음\s*주|주말|[월화수목금토일]요일)\s*(엔|에는|은|는)?\s*(뭐|일정)/.test(s);
  if(askList&&!/(추가|등록|잡아|넣어)/.test(s)&&!parseWhen(s).time){
    const T=today();
    if(/이번\s*주/.test(s))return listEvents(ymd(T),ymd(addDays(T,(7-T.getDay())%7)),"이번 주 일정");
    if(/다음\s*주|담주/.test(s)){const st=addDays(T,((8-T.getDay())%7)||7);return listEvents(ymd(st),ymd(addDays(st,6)),"다음 주 일정")}
    if(/이번\s*달/.test(s))return listEvents(ymd(T),ymd(new Date(T.getFullYear(),T.getMonth()+1,0)),"이번 달 일정");
    const w=parseWhen(s);
    if(w.date)return listEvents(w.date,w.date,dateLabel(w.date)+" 일정");
    return listEvents(ymd(T),ymd(addDays(T,30)),"다가오는 일정");
  }
  // 언제야?
  if((m=s.match(/^(.+?)\s*(?:은|는|이|가)?\s*(언제|몇\s*시)(?:야|지|였지|더라|예요|에요|임|냐)?\s*[?？]*$/))&&!/^(지금|오늘|내일)$/.test(m[1].trim())){
    const f=findTarget(m[1],"event");
    if(f&&f.type==="event"){const o=nextOcc(f.item);ctx.ref={type:"event",id:f.item.id};
      return "📅 \""+f.item.title+"\" — "+(f.item.repeat?repLabel(f.item)+" "+timeLabel(f.item.time)+(o?"\n다음: "+dateLabel(o.date):""):dateLabel(f.item.date)+" "+timeLabel(f.item.time))}
    if(f&&f.type==="todo"){ctx.ref={type:"todo",id:f.item.id};return "📝 \""+f.item.text+"\"은(는) 할 일이에요"+(f.item.due?" — "+dateLabel(f.item.due)+"까지":" (기한 없음)")}
  }
  // 일정 변경
  if(/(바꿔|변경|옮겨|미뤄|연기|당겨|수정|미루)/.test(s)&&!/이름/.test(s)){
    const w=parseWhen(s);
    const key=w.rest.replace(/(으로|로)?\s*(좀\s*)?(바꿔|변경|옮겨|미뤄|연기|당겨|수정|미루)\S*/g," ").replace(/(을|를)\s*$/,"").replace(/\s+/g," ").trim();
    const f=findTarget(key);
    if(f)return editWhen(f,s);
    if(key)return "\""+key+"\"에 해당하는 일정을 찾지 못했어요. \"일정 보여줘\"로 확인해 보세요.";
  }
  // 완료(이름)
  if((m=s.match(/^(.+?)\s*(완료|다\s*했어|다\s*했다|다\s*했음|끝냈어|끝났어|했어|함|체크|끝)[.!~]*$/))&&!/^\d/.test(s)&&!/(뭐|몇)/.test(s)){
    const f=findTarget(m[1],"todo");if(f&&f.type==="todo")return completeTodo(f.item);
  }
  // 중요 표시
  if((m=s.match(/^(.+?)\s*(중요\s*표시|별표|중요해|중요하다고)/))){const f=findTarget(m[1]);if(f){snap();f.item.star=true;save();return "⭐ \""+(f.item.text||f.item.title)+"\" 중요 표시했어요."}}
  // 삭제(이름)
  if((m=s.match(/^(.+?)\s*(삭제|지워|빼\s*줘|없애|취소\s*해)/))){
    const f=findTarget(m[1]);if(f)return removeItem(f.type,f.item);
    return "\""+m[1].trim()+"\"을(를) 찾지 못했어요.";
  }
  // 메모
  if(/^메모.*(보여|목록|뭐|확인)|^메모\s*$/.test(s)){
    if(!memos.length)return "저장된 메모가 없어요. \"메모 사물함 번호 27\"처럼 남겨 보세요.";
    return "🗒️ 메모 "+memos.length+"개\n"+memos.slice(-20).map(x=>"· "+x.text).join("\n");
  }
  if((m=s.match(/^(?:메모|기억해\s*줘?|적어\s*줘?)\s*[:：]?\s*(.+)$/))){snap();memos.push({id:uid(),text:m[1],created:Date.now()});save();return "🗒️ 메모해 뒀어요: \""+m[1]+"\""}
  if((m=s.match(/^(.+?)(?:\s*(?:이라고|라고))?\s*(?:메모|기억)\s*해\s*줘?$/))&&!/(할\s*일|일정)/.test(s)){snap();memos.push({id:uid(),text:m[1].trim(),created:Date.now()});save();return "🗒️ 기억해 둘게요: \""+m[1].trim()+"\""}
  if((m=s.match(/^(.+?)\s*(?:뭐였지|뭐더라|기억나\??)\s*[?？]*$/))){
    const x=best(memos,m[1],y=>y.text);if(x)return "🗒️ 메모에 이렇게 있어요: \""+x.text+"\"";
  }
  // 타이머
  if((m=s.match(/(?:타이머|알람)\s*(\d+)\s*(초|분|시간)|(\d+)\s*(초|분|시간)\s*(?:짜리)?\s*(?:타이머|알람)/))){
    const n=+(m[1]||m[3]),u=m[2]||m[4];const ms=n*(u==="초"?1e3:u==="분"?6e4:36e5);
    setTimeout(()=>{notify("⏰ 타이머 끝! ("+n+u+")");botSay("⏰ "+n+u+" 타이머가 끝났어요!")},ms);
    return "⏳ "+n+u+" 타이머 시작! 앱을 열어 두면 시간이 되면 알려 드릴게요.";
  }
  // 시간/날짜 질문
  if(/(지금\s*)?몇\s*시(야|예요|에요|냐|임)?\s*[?？]*$|^지금\s*시간/.test(s)&&!/일정|할\s*일/.test(s))return "지금은 "+timeLabel(nowHM())+"예요 ⏰";
  if(/(며칠|날짜|무슨\s*요일|몇\s*월\s*며칠)/.test(s)&&!/(뒤|후|까지)/.test(s)){const d=new Date();return "오늘은 "+(d.getMonth()+1)+"월 "+d.getDate()+"일 "+WD[d.getDay()]+"요일이에요 📆"}
  if((m=s.match(/(.+?)까지\s*(며칠|몇\s*일)\s*(남았|남음)/))){const w=parseWhen(m[1]);if(w.date){const n=Math.round((fromYmd(w.date)-today())/864e5);return "📆 "+dateLabel(w.date)+"까지 "+n+"일 남았어요"}}

  // 추가 (일정/할 일)
  const w=parseWhen(s);
  const star=STAR_RE.test(s);STAR_RE.lastIndex=0;
  const wantTodo=/(할\s*일|투두|todo)\s*(에|로|으로)?\s*(추가|넣어|등록)|해야\s*(해|돼|됨|함|한다|된다|하는데|겠다)|까지/i.test(s);
  if(w.hit&&!/(몇\s*시|며칠|무슨\s*요일)/.test(s)){
    const title=cleanTitle(w.rest);
    if(title){
      if(wantTodo&&!w.time&&!w.repeat)return addTodo(title,w.date,star);
      return addEvent(title,w,star);
    }
    if(w.date&&!title)return "무슨 일정인지 알려 주세요. 예: \""+(w.time?timeLabel(w.time)+" ":"")+"치과\"";
  }
  if(wantTodo||/(추가|등록)\s*(해\s*줘|해줘|해|좀)?[.!]?$/.test(s)){
    const title=cleanTitle(s);
    if(title)return addTodo(title,null,star);
    return "어떤 할 일을 추가할까요? 예: \"빨래 해야 해\"";
  }
  // 계산
  const ex=s.replace(/더하기|플러스/g,"+").replace(/빼기|마이너스/g,"-").replace(/곱하기|x|×/gi,"*").replace(/나누기|÷/g,"/").replace(/(은|는)?\s*(얼마|몇)(야|이야|임|\?)*$/,"").replace(/[=?]/g,"").replace(/,/g,"").trim();
  if(/^[\d\s+\-*/().%]+$/.test(ex)&&/\d\s*[+\-*/%]\s*[\d(]/.test(ex)){
    try{const r=Function('"use strict";return ('+ex+")")();if(isFinite(r))return "🧮 "+ex+" = "+(Math.round(r*1e8)/1e8).toLocaleString("ko-KR")}catch(e){}
  }
  if((m=s.match(/(.+?)\s*(?:vs|VS|아니면|랑|하고|or)\s*(.+?)\s*(?:중에|중)?\s*(?:골라|뭐가|추천|선택|정해)/))){
    const o=(m[1]+","+m[2]).split(/,|vs|VS|아니면|랑|하고/).map(x=>x.trim()).filter(Boolean);return "🎯 고민 끝! "+pick(o)+"(으)로 가요!";
  }
  if(/주사위/.test(s))return "🎲 "+(1+Math.floor(Math.random()*6))+"!";
  if(/(동전|코인)\s*(던|굴|던져)/.test(s)||/^동전$/.test(s))return "🪙 "+pick(["앞면","뒷면"])+"!";
  for(const [re,fn] of TALK)if(re.test(s))return fn();
  return null; // 모름
}
function editWhen(f,s){
  const x=f.item,w=parseWhen(s);
  if(f.type==="todo"){
    if(w.date){snap();x.due=w.date;save();return "📝 \""+x.text+"\" 기한을 "+dateLabel(w.date)+"(으)로 바꿨어요."}
    if(/(미뤄|연기|미루)/.test(s)){snap();x.due=ymd(addDays(x.due?fromYmd(x.due):today(),1));save();return "📝 \""+x.text+"\" 기한을 "+dateLabel(x.due)+"(으)로 미뤘어요."}
    return "언제로 바꿀까요? 예: \""+x.text+" 금요일로 바꿔줘\"";
  }
  const before=(x.repeat?repLabel(x):dateLabel(x.date))+" "+timeLabel(x.time);
  const hasDate=/(오늘|내일|모레|글피|요일|\d+\s*일|주말|다음\s*주|뒤|후)/.test(s);
  if(!w.time&&!hasDate){
    if(/(미뤄|연기|미루)/.test(s)){snap();x.date=ymd(addDays(fromYmd(x.date),1));x.notified={};save();return "📅 \""+x.title+"\" 하루 미뤘어요 → "+dateLabel(x.date)+" "+timeLabel(x.time)}
    if((/(당겨)/.test(s))){snap();x.date=ymd(addDays(fromYmd(x.date),-1));x.notified={};save();return "📅 \""+x.title+"\" 하루 당겼어요 → "+dateLabel(x.date)+" "+timeLabel(x.time)}
    return "언제로 바꿀까요? 예: \""+x.title+" 4시로 바꿔줘\"";
  }
  snap();
  if(hasDate&&w.date)x.date=w.date;
  if(w.time){x.time=w.time;if(!hasDate&&!x.repeat&&x.date<ymd(today()))x.date=ymd(today())}
  if(w.repeat)x.repeat=w.repeat;
  x.notified={};ctx.ref={type:"event",id:x.id};save();
  return "📅 \""+x.title+"\" 변경 완료!\n"+before+" → "+(x.repeat?repLabel(x):dateLabel(x.date))+" "+timeLabel(x.time);
}

let pendingSuggest=null;
function handleOne(s){
  if(pendingSuggest){
    const p=pendingSuggest;pendingSuggest=null;
    if(/^(응|ㅇㅇ|어|네|예|그래|좋아|ㅇ|웅|yes|넣어|추가|ㅇㅋ|오케이)/i.test(s))return addTodo(p,null,false);
    if(/^(아니|ㄴㄴ|아냐|노|no|됐어|괜찮)/i.test(s))return "알겠어요, 안 넣을게요 🙂";
  }
  return respond(s);
}
/* 여러 명령 한 번에 */
function splitCmds(s){
  const parts=s.split(/\s*(?:\n|그리고\s+(?:또\s+)?|그리고서\s+|[.;]\s+|,\s*그리고\s+)\s*/).map(x=>x.trim()).filter(Boolean);
  return parts.length>1?parts:[s];
}

/* ================= Gemini 에이전트 (서버, 스트리밍) ================= */
const ai={on:false,checked:false,pin:S.get("pin",""),model:"",search:false,ctrl:null};
async function checkAI(){
  try{const r=await fetch("api/health",{cache:"no-store"});const j=await r.json();ai.on=!!j.ai;ai.model=j.model||"";ai.search=!!j.search}catch(e){ai.on=false}
  ai.checked=true;updateAIUI();renderChips();
}
async function askAIStream(text,image,onEv,retry){
  const history=chat.slice(-21,-1).filter(c=>c.text).map(c=>({role:c.who,text:c.text}));
  const body={message:text,image:image||null,history,state:{todos,events,memos,facts,prof}};
  const ctrl=new AbortController();ai.ctrl=ctrl;
  const r=await fetch("api/chat",{method:"POST",headers:{"content-type":"application/json","x-kitel-pin":ai.pin||""},body:JSON.stringify(body),signal:ctrl.signal});
  if(r.status===401&&!retry){const p=prompt("Kitel 비밀번호(PIN)를 입력해 주세요");if(p){ai.pin=p.trim();S.set("pin",ai.pin);return askAIStream(text,image,onEv,true)}}
  if(r.status===503){ai.on=false;updateAIUI()}
  if(!r.ok){const e=new Error("http "+r.status);e.status=r.status;throw e}
  const rd=r.body.getReader(),dec=new TextDecoder();let buf="";
  for(;;){
    const {value,done}=await rd.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    let i;while((i=buf.indexOf("\n\n"))>=0){
      const blk=buf.slice(0,i);buf=buf.slice(i+2);
      for(const line of blk.split("\n"))if(line.startsWith("data: ")){try{onEv(JSON.parse(line.slice(6)))}catch(e){}}
    }
  }
}
function applyAI(j){
  const st=j.state;if(!st||!Array.isArray(st.todos)||!Array.isArray(st.events))return;
  snap();
  todos=st.todos;memos=Array.isArray(st.memos)?st.memos:memos;facts=Array.isArray(st.facts)?st.facts:facts;
  events=st.events.map(e=>Object.assign({},e,{notified:(e.notified&&typeof e.notified==="object")?e.notified:{},repeat:e.repeat||null}));
  if(st.prof&&typeof st.prof.name==="string")prof.name=st.prof.name;
  (j.timers||[]).forEach(t=>setTimeout(()=>{const m="⏰ "+(t.label?t.label+" — ":"")+"타이머 끝!";notify(m);botSay(m)},t.seconds*1000));
  save();
}
/* 사진 첨부 (자동 축소) */
let pendingImage=null;
function shrinkImage(file){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file),img=new Image();
    img.onload=()=>{const M=1280,k=Math.min(1,M/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);res(c.toDataURL("image/jpeg",.85))};
    img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error("이미지를 읽지 못했어요"))};img.src=url;
  });
}

/* 안전한 마크다운 */
const esc=t=>t.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function inlineMd(t){
  return t.replace(/`([^`\n]+)`/g,"<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g,"<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,"$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function md(src){
  const parts=esc(src).split(/```(?:\w+)?\n?/);
  return parts.map((seg,i)=>{
    if(i%2)return "<pre><code>"+seg.replace(/\n$/,"")+"</code></pre>";
    return seg.split("\n").map(l=>{
      let m;
      if((m=l.match(/^\s*#{1,4}\s+(.*)$/)))return "<b class=h>"+inlineMd(m[1])+"</b>";
      if((m=l.match(/^(\s*)[-*•]\s+(.*)$/)))return m[1]+"• "+inlineMd(m[2]);
      return inlineMd(l);
    }).join("\n");
  }).join("");
}

/* ================= 채팅 UI ================= */
const $=id=>document.getElementById(id);
const log=$("log");
let stick=true;log.addEventListener("scroll",()=>{stick=log.scrollHeight-log.scrollTop-log.clientHeight<80},{passive:true});
const scrollDown=(force)=>{if(force||stick)log.scrollTop=log.scrollHeight};
function bubble(who,text,ts,anim=true,extra){
  const d=document.createElement("div");d.className="msg "+who;if(!anim)d.style.animation="none";
  if(extra&&extra.img){const im=document.createElement("img");im.className="pic";im.src=extra.img;im.alt="첨부 사진";d.appendChild(im)}
  else if(extra&&extra.hadImg){d.appendChild(Object.assign(document.createElement("div"),{className:"picph",textContent:"📷 사진"}))}
  const body=document.createElement("div");body.className="body";
  if(who==="bot")body.innerHTML=md(text);else body.textContent=text;
  d.appendChild(body);
  const acts=document.createElement("div");acts.className="acts";d.appendChild(acts);
  if(extra&&extra.acts)extra.acts.forEach(a=>addAct(d,a));
  if(extra&&extra.src&&extra.src.length)addSrc(d,extra.src);
  const t=document.createElement("span");t.className="t";const dt=new Date(ts);t.textContent=timeLabel(pad(dt.getHours())+":"+pad(dt.getMinutes()))+(extra&&extra.ai?" · ✨":"");
  d.appendChild(t);log.appendChild(d);return d;
}
function addAct(d,a){const c=document.createElement("span");c.className="act";c.textContent=a.icon+" "+a.label;d.querySelector(".acts").appendChild(c)}
function addSrc(d,src){
  const w=document.createElement("div");w.className="src";w.appendChild(document.createTextNode("출처 "));
  src.slice(0,4).forEach((x,i)=>{const a=document.createElement("a");a.href=x.url;a.target="_blank";a.rel="noopener";a.textContent=(i+1)+". "+(x.title||"링크");w.appendChild(a)});
  d.insertBefore(w,d.querySelector(".t"));
}
function speak(text){
  if(!opt.tts||!("speechSynthesis" in window))return;
  try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu,"").slice(0,300));u.lang="ko-KR";u.rate=1.05;speechSynthesis.speak(u)}catch(e){}
}
function botSay(text){chat.push({who:"bot",text,ts:Date.now()});saveChat();bubble("bot",text,Date.now());scrollDown(true);speak(text)}
let busy=false;
function setBusy(v){busy=v;const b=$("sendBtn");b.textContent=v?"■":"↑";b.classList.toggle("stop",v);b.setAttribute("aria-label",v?"멈추기":"보내기")}
async function send(txt){
  if(busy){if(ai.ctrl)ai.ctrl.abort();return}
  const v=(txt??$("in").value).trim();const img=pendingImage;
  if(!v&&!img)return;$("in").value="";autoGrow();clearImage();
  if(img&&!ai.on){toast("사진 인식은 AI가 연결돼야 쓸 수 있어요");return}
  chat.push({who:"me",text:v,ts:Date.now(),hadImg:!!img});saveChat();bubble("me",v,Date.now(),true,{img});scrollDown(true);
  setBusy(true);
  const s=v.replace(/\s+/g," ");
  if(ai.on&&!pendingSuggest&&!/^(되돌려|되돌리기|실행\s*취소|undo)$/i.test(s)){
    const d=bubble("bot","",Date.now(),true,{ai:true});d.classList.add("ai","streaming");scrollDown(true);
    const body=d.querySelector(".body");let acc="",acts=[],raf=0,doneEv=null,errEv=null;
    const paint=()=>{raf=0;body.innerHTML=md(acc);scrollDown()};
    try{
      await askAIStream(s,img,ev=>{
        if(ev.type==="text"){acc+=ev.delta;if(!raf)raf=requestAnimationFrame(paint)}
        else if(ev.type==="action"){acts.push({icon:ev.icon,label:ev.label});addAct(d,ev);scrollDown();if(navigator.vibrate)navigator.vibrate(10)}
        else if(ev.type==="done")doneEv=ev;
        else if(ev.type==="error")errEv=ev;
      });
    }catch(e){if(e.name==="AbortError"){acc+=(acc?"\n\n":"")+"⏹️ 멈췄어요.";}else errEv={status:e.status,message:e.message}}
    cancelAnimationFrame(raf);
    if(doneEv)applyAI(doneEv);
    if(errEv&&!acc.trim()){
      d.remove();
      toast(errEv.status===429?"요청이 많아요. 잠시 후 다시 시도해 주세요":"AI 연결이 불안정해서 기본 모드로 답했어요");
      if(img){botSay("사진을 읽지 못했어요 😢 잠시 후 다시 보내 주세요.");setBusy(false);return}
    }else{
      if(errEv)acc+="\n\n⚠️ 중간에 연결이 끊겼어요. 다시 말해 주세요.";
      d.classList.remove("streaming");body.innerHTML=md(acc||"처리했어요! ✅");
      const src=(doneEv&&doneEv.sources)||[];if(src.length)addSrc(d,src);
      chat.push({who:"bot",text:acc,ts:Date.now(),acts,src,ai:true});saveChat();speak(acc);scrollDown();
      setBusy(false);renderChips();return;
    }
  }
  await new Promise(r=>setTimeout(r,200));
  const parts=pendingSuggest?[s]:splitCmds(s);
  const outs=[];let unknown=false;
  for(const p of parts){const r=handleOne(p);if(r)outs.push(r);else if(parts.length===1)unknown=true;else outs.push("\""+p+"\"은(는) 잘 모르겠어요 🤔")}
  if(unknown){
    if(s.length<=20&&!/[?？]$/.test(s)&&!/(뭐|왜|어떻게|누구|어디|언제)/.test(s)){
      pendingSuggest=cleanTitle(s)||s;
      outs.push("\""+pendingSuggest+"\"을(를) 할 일로 추가할까요? \"응\"이라고 하면 넣어 둘게요.\n(일정이면 \"내일 3시 "+pendingSuggest+"\"처럼 시간을 붙여 주세요)");
    }else outs.push("음, 그건 잘 모르겠어요 🤔"+(!ai.on?"\n지금은 **AI가 연결되지 않은 기본 모드**라서 정해진 말만 알아들어요. 위의 노란 안내를 눌러 AI를 켜 주세요!":""));
  }
  botSay(outs.join("\n\n"));setBusy(false);renderChips();
}
/* 입력창 자동 높이 */
function autoGrow(){const t=$("in");t.style.height="auto";t.style.height=Math.min(t.scrollHeight,120)+"px"}
$("in").addEventListener("input",autoGrow);
/* 사진 */
function clearImage(){pendingImage=null;$("preview").hidden=true;$("preview").textContent=""}
$("camBtn").onclick=()=>{if(!ai.on){toast("사진 인식은 AI가 연결돼야 쓸 수 있어요");return}$("camFile").click()};
$("camFile").onchange=async e=>{
  const f=e.target.files[0];e.target.value="";if(!f)return;
  try{pendingImage=await shrinkImage(f);const pv=$("preview");pv.textContent="";
    const im=document.createElement("img");im.src=pendingImage;const x=document.createElement("button");x.textContent="×";x.onclick=clearImage;
    pv.append(im,Object.assign(document.createElement("span"),{textContent:"이 사진에 대해 말해 보세요 (예: 일정으로 넣어줘)"}),x);pv.hidden=false;$("in").focus()}
  catch(err){toast(err.message)}
};
$("sendBtn").onclick=()=>send();
$("in").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
function renderChips(){
  const base=ai.on?["오늘 브리핑해줘","이번 주 일정 정리해줘","할 일 우선순위 정해줘","오늘 날씨 어때?","내일 언제 비어?"]:["브리핑","할 일 보여줘","오늘 일정","내일 언제 비어?","도움말"];
  const c=pendingSuggest?["응","아니"]:base;
  const el=$("chips");el.textContent="";
  c.forEach(x=>{const b=document.createElement("button");b.className="chip";b.textContent=x;b.onclick=()=>send(x);el.appendChild(b)});
}
/* 음성 입력 */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
const mic=$("micBtn");
if(!SR)mic.hidden=true;
else{
  let rec=null;
  mic.onclick=()=>{
    if(rec){rec.stop();return}
    rec=new SR();rec.lang="ko-KR";rec.interimResults=true;rec.maxAlternatives=1;
    mic.classList.add("rec");let final="";
    rec.onresult=e=>{let t="";for(const r of e.results)t+=r[0].transcript;$("in").value=t;if(e.results[e.results.length-1].isFinal)final=t};
    rec.onerror=e=>{if(e.error==="not-allowed")toast("마이크 권한을 허용해 주세요")};
    rec.onend=()=>{mic.classList.remove("rec");rec=null;if(final.trim())send(final)};
    try{rec.start()}catch(e){mic.classList.remove("rec");rec=null}
  };
}

/* ================= 할 일 / 일정 화면 ================= */
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function renderTodos(){
  const box=$("todoList");box.textContent="";
  const p=pending(),d=todos.filter(t=>t.done).sort((a,b)=>(b.doneAt||0)-(a.doneAt||0));
  if(!todos.length){box.innerHTML='<div class="empty">아직 할 일이 없어요.<br>위에 입력하거나 대화에서 "빨래 해야 해"라고 말해 보세요 🪁</div>';return}
  const sec=(t,n)=>{const h=el("div","sec");h.append(el("span",null,t),el("span",null,n));box.appendChild(h)};
  const t0=ymd(today());
  const row=t=>{
    const r=el("div","item"+(t.done?" done":""));
    const c=el("button","chk",t.done?"✓":"");c.setAttribute("aria-label","완료");
    c.onclick=()=>{snap();t.done=!t.done;t.doneAt=t.done?Date.now():null;if(t.done&&navigator.vibrate)navigator.vibrate(15);save()};
    const x=el("div","txt",t.text);
    if(t.due){const sm=el("small",t.due<t0&&!t.done?"late":null,"⏰ "+dateLabel(t.due)+"까지");x.appendChild(sm)}
    const st=el("button","star"+(t.star?" on":""),"★");st.onclick=()=>{t.star=!t.star;save()};
    const del=el("button","del","×");del.onclick=()=>{snap();todos=todos.filter(y=>y!==t);save();toast("삭제했어요 · 대화에서 \"되돌려\"로 복구")};
    r.append(c,x,st,del);box.appendChild(r);
  };
  sec("남은 할 일",p.length);p.forEach(row);
  if(!p.length){const e=el("div","empty","다 끝냈어요! 🎉");e.style.padding="18px";box.appendChild(e)}
  if(d.length){sec("완료",d.length);d.slice(0,30).forEach(row)}
}
let calSel=null; // null=전체
function renderStrip(){
  const st=$("strip");st.textContent="";const T=today();
  const all=el("button","day"+(calSel===null?" on":""));all.append(el("b",null,"전체"),el("span",null,"📋"));all.onclick=()=>{calSel=null;renderEvents()};st.appendChild(all);
  for(let i=0;i<14;i++){
    const d=addDays(T,i),k=ymd(d),n=occurrences(k,k).length;
    const b=el("button","day"+(calSel===k?" on":"")+(d.getDay()===0?" sun":d.getDay()===6?" sat":""));
    b.append(el("small",null,i===0?"오늘":WD[d.getDay()]),el("b",null,String(d.getDate())),el("i",n?"dot":"nodot"));
    b.onclick=()=>{calSel=k;renderEvents()};st.appendChild(b);
  }
}
function renderEvents(){
  renderStrip();
  const box=$("evList");box.textContent="";const T=today(),t0=ymd(T),now=Date.now();
  const row=o=>{
    const e=o.e,r=el("div","item");
    const tm=el("div","time"+(o.ms<now?" past":""));
    tm.textContent=e.time?(()=>{const [h,m]=e.time.split(":").map(Number);return (h<12?"AM ":"PM ")+((h%12)||12)+":"+pad(m)})():"종일";
    const x=el("div","txt",(e.star?"⭐ ":"")+e.title);
    x.appendChild(el("small",null,timeLabel(e.time)+(e.repeat?" · 🔁 "+repLabel(e):"")));
    const del=el("button","del","×");del.onclick=()=>{snap();events=events.filter(y=>y!==e);save();toast((e.repeat?"반복 일정 전체를 ":"")+"삭제했어요 · \"되돌려\"로 복구")};
    r.append(tm,x,del);box.appendChild(r);
  };
  if(!events.length){box.innerHTML='<div class="empty">일정이 없어요.<br>대화에서 "금요일 7시 친구랑 저녁"처럼 말해도 돼요 📅</div>';return}
  if(calSel){
    const list=occurrences(calSel,calSel);
    const h=el("div","sec");h.append(el("span",null,dateLabel(calSel)),el("span",null,list.length+"개"));box.appendChild(h);
    if(!list.length){const e=el("div","empty","이날은 비어 있어요 🪁");e.style.padding="18px";box.appendChild(e)}
    list.forEach(row);return;
  }
  const list=occurrences(t0,ymd(addDays(T,30)));let cur="";
  list.forEach(o=>{if(o.date!==cur){cur=o.date;const h=el("div","sec");h.append(el("span",null,dateLabel(o.date)),el("span",null,list.filter(x=>x.date===o.date).length+"개"));box.appendChild(h)}row(o)});
  if(!list.length){const e=el("div","empty","30일 안에 다가오는 일정이 없어요.");e.style.padding="18px";box.appendChild(e)}
  const past=events.filter(e=>!e.repeat&&e.date<t0).sort((a,b)=>b.date>a.date?1:-1).slice(0,8);
  if(past.length){const h=el("div","sec");h.append(el("span",null,"지난 일정"),el("span",null,""));box.appendChild(h);past.forEach(e=>row({e,date:e.date,ms:0}))}
}
function renderBadges(){
  const p=pending().length,t0=ymd(today()),tc=occurrences(t0,t0).filter(o=>!o.e.time||o.ms>=Date.now()).length;
  const tb=$("todoBadge"),cb=$("calBadge");tb.hidden=!p;tb.textContent=p;cb.hidden=!tc;cb.textContent=tc;
  $("sub").textContent=tc?"오늘 남은 일정 "+tc+"개":(p?"남은 할 일 "+p+"개":"맡기면 날아가서 해결해요");
}
let curView="chat";
function renderAll(){if(curView==="todo")renderTodos();else if(curView==="cal")renderEvents();renderBadges()}

$("todoAdd").onclick=()=>{
  const v=$("todoIn").value.trim();if(!v)return;
  const w=parseWhen(v),star=STAR_RE.test(v);STAR_RE.lastIndex=0;
  addTodo(w.hit&&w.date?cleanTitle(w.rest)||v:cleanTitle(v)||v,w.hit?w.date:null,star);$("todoIn").value="";renderTodos();
};
$("todoIn").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.isComposing)$("todoAdd").click()});
$("evDate").value=ymd(today());
$("evAdd").onclick=()=>{
  const ti=$("evTitle").value.trim(),d=$("evDate").value,tm=$("evTime").value,rp=$("evRep").value||null;
  if(!ti){toast("일정 이름을 입력해 주세요");return}if(!d){toast("날짜를 골라 주세요");return}
  addEvent(ti,{date:d,time:tm,repeat:rp},false);$("evTitle").value="";$("evTime").value="";$("evRep").value="";renderEvents();toast("📅 일정 추가 완료");
};
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{
  curView=b.dataset.v;
  document.querySelectorAll("nav button").forEach(x=>x.classList.toggle("on",x===b));
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("on",v.id==="v-"+curView));
  renderAll();if(curView==="chat")scrollDown(true);
});

/* ================= 알림 ================= */
let tt;function toast(m){const t=$("toast");t.textContent=m;t.classList.add("on");clearTimeout(tt);tt=setTimeout(()=>t.classList.remove("on"),3200)}
function notify(m){
  toast(m);if(navigator.vibrate)navigator.vibrate([120,60,120]);
  try{if("Notification" in window&&Notification.permission==="granted"){
    if(navigator.serviceWorker&&navigator.serviceWorker.controller)navigator.serviceWorker.ready.then(r=>r.showNotification("Kitel",{body:m,icon:"icon.svg",badge:"icon.svg",tag:"kitel"}));
    else new Notification("Kitel",{body:m,icon:"icon.svg"});
  }}catch(e){}
}
function checkReminders(){
  const now=Date.now(),t0=ymd(today());let ch=false;
  for(const o of occurrences(t0,ymd(addDays(today(),1)))){
    const e=o.e;if(!e.time||e.notified[o.date])continue;const diff=o.ms-now;
    if(diff<=10*60*1000&&diff>-5*60*1000){
      e.notified[o.date]=true;ch=true;const mins=Math.max(0,Math.round(diff/60000));
      const msg=mins?"🔔 "+mins+"분 뒤 \""+e.title+"\" 일정이에요!":"🔔 지금 \""+e.title+"\" 시간이에요!";notify(msg);botSay(msg);
    }
  }
  // 오래된 알림 기록 정리
  events.forEach(e=>{for(const k in e.notified)if(k<ymd(addDays(today(),-3))){delete e.notified[k];ch=true}});
  if(ch)save();else renderBadges();
}
setInterval(checkReminders,15000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden){checkReminders();renderAll()}});

/* ================= 메뉴 ================= */
const sheet=$("sheet");
function updateAIUI(){
  const st=$("aiStatus");
  st.textContent=!ai.checked?"✨ AI 연결 확인 중…":ai.on?"✨ AI 연결됨 · "+ai.model+(ai.search?" · 🔎 검색 가능":"")+"\n아무렇게나 말해도 알아서 처리해요":"⚙️ 기본 모드 — 서버에 GEMINI_API_KEY가 없어서 정해진 말만 알아들어요";
  st.className=ai.on?"on":"";
  $("aiDot").hidden=!ai.on;
  $("aiBanner").hidden=!(ai.checked&&!ai.on);
  $("camBtn").classList.toggle("off",!ai.on);
  $("in").placeholder=ai.on?"무엇이든 말해 보세요…":"Kitel에게 말하기…";
  renderFacts();
}
function renderFacts(){
  const box=$("factList");if(!box)return;box.textContent="";
  if(!facts.length){box.appendChild(el("div","empty","아직 기억한 게 없어요. 대화하다 보면 취향·습관을 알아서 기억해요.")).style.padding="10px";return}
  facts.forEach(f=>{const r=el("div","item");r.append(el("div","txt",f.text));const x=el("button","del","×");x.onclick=()=>{facts=facts.filter(y=>y!==f);save();renderFacts()};r.appendChild(x);box.appendChild(r)});
}
$("aiBanner").onclick=()=>{
  botSay("## ✨ Kitel을 진짜 똑똑하게 만드는 법\n지금은 AI 키가 없어서 **기본 모드**예요. 아래 순서대로 한 번만 하면 돼요.\n\n1. https://aistudio.google.com/apikey 에서 **API 키 만들기** → 복사\n2. Google Cloud 콘솔 → **Cloud Run** → **kitel** 서비스 클릭\n3. 위쪽 **새 버전 수정 및 배포**\n4. **변수 및 보안 비밀** 탭 → **변수 추가**\n   이름 `GEMINI_API_KEY` / 값: 복사한 키\n5. 맨 아래 **배포** → 1~2분 뒤 이 페이지 새로고침\n\n켜지면 오른쪽 위 로고에 ✨가 붙어요!");
};
$("menuBtn").onclick=()=>{updateAIUI();$("optTts").textContent=opt.tts?"🔊 답변 읽어주기 켜짐":"🔈 답변 읽어주기 꺼짐";sheet.classList.add("on")};
sheet.onclick=e=>{if(e.target===sheet)sheet.classList.remove("on")};
$("optClose").onclick=()=>sheet.classList.remove("on");
$("optTts").onclick=()=>{opt.tts=!opt.tts;save();$("optTts").textContent=opt.tts?"🔊 답변 읽어주기 켜짐":"🔈 답변 읽어주기 꺼짐";if(opt.tts)speak("답변을 읽어 드릴게요")};
$("optNotif").onclick=async()=>{
  sheet.classList.remove("on");
  if(!("Notification" in window)){toast("이 브라우저는 알림을 지원하지 않아요");return}
  const p=await Notification.requestPermission();toast(p==="granted"?"🔔 알림이 켜졌어요":"알림이 꺼져 있어요. 브라우저 설정에서 허용해 주세요");
};
$("optExport").onclick=()=>{
  const blob=new Blob([JSON.stringify({v:VERSION,todos,events,memos,facts,prof},null,1)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="kitel-backup-"+ymd(today())+".json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  sheet.classList.remove("on");toast("💾 백업 파일을 저장했어요");
};
$("optImport").onclick=()=>$("importFile").click();
$("importFile").onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  try{const o=JSON.parse(await f.text());if(!Array.isArray(o.todos)||!Array.isArray(o.events))throw 0;snap();todos=o.todos;events=o.events;memos=o.memos||[];facts=o.facts||facts;if(o.prof)prof=o.prof;
    events.forEach(x=>{if(typeof x.notified!=="object"||!x.notified)x.notified={}});save();toast("📥 백업을 불러왔어요")}
  catch(_){toast("올바른 Kitel 백업 파일이 아니에요")}
  e.target.value="";sheet.classList.remove("on");
};
$("optClearChat").onclick=()=>{chat=[];saveChat();log.textContent="";sheet.classList.remove("on");botSay(briefing())};
$("optClearDone").onclick=()=>{snap();const n=todos.filter(t=>t.done).length;todos=todos.filter(t=>!t.done);save();sheet.classList.remove("on");toast("완료한 할 일 "+n+"개 정리했어요")};
$("optReset").onclick=()=>{if(!confirm("할 일·일정·메모·대화를 모두 지울까요?"))return;snap();todos=[];events=[];memos=[];facts=[];chat=[];prof={name:""};save();saveChat();log.textContent="";sheet.classList.remove("on");botSay("처음부터 다시 시작해요! 🪁\n\n"+HELP)};

/* ================= 시작 ================= */
const frag=document.createDocumentFragment();
const recent=chat.slice(-80);
recent.forEach(c=>{const d=bubble(c.who,c.text,c.ts,false,{acts:c.acts,src:c.src,ai:c.ai,hadImg:c.hadImg});frag.appendChild(d)});log.appendChild(frag);
if(!chat.length)botSay("안녕하세요! 저는 **Kitel**이에요 🪁\n할 일·일정·메모를 대신 챙기고, 궁금한 건 찾아서 알려 드려요.\n\n- \"내일 3시 치과 잡고 장보기도 넣어줘\"\n- \"이번 주 일정 보고 언제 운동하면 좋을지 짜줘\"\n- 📷 시간표·포스터 사진 → \"일정으로 넣어줘\"\n- 🎤 말로 해도 돼요");
else if(Date.now()-chat[chat.length-1].ts>3*60*60*1000)botSay(briefing());
scrollDown(true);renderChips();renderAll();checkReminders();
checkAI();
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
// 테스트용 노출
window.__kitel={respond,parseWhen,handleOne,splitCmds};
})();
