/* ============================================================================
   WHOLE-APP STRESS TEST — one paramedic, 5 years (60 months).
   Exercises: the REAL engine, the REAL OCR extraction (against genuine MDT debug
   texts), manual shift entry, rosters with exceptions, money config, week/month
   rollups, and the retroactive-money fix. Checks every invariant.
   ============================================================================ */
const E = require('./engine/engine.js');
const fs = require('fs');

// load the REAL ocr functions from the app (extracted to /tmp/ocr.js by the runner)
const OCR = require('/tmp/ocr.js');

/* ---- REAL MDT debug texts captured from actual photos during testing ---- */
const REAL_MDT_TEXTS = [
  // clean 4-incident screen
  `Hospital
AS1 5899431
(© 20:13:46 -- 22:26:05
AS1 5899981
(© 01:17:53 ~ 02:51:16
AS1 59001 85
© 04:45:38 — 06:39:30
AS1 5900300
(© 07:41 -01 08:38:58`,
  // wide two-column screen with message log (the hard one)
  `Select incident: Showing all messages
AS1 5001441 BT
Status ©20:10:55 - 20:21:08 Book-On Request
AS1 5901266 © 20:09:26
©20:21:41 - 20:57:44 | Doing Checks
ha AS1 5901233 © 20:00:29
©21:01:18 - 21:09.49 AST Emergenc Mobilisation (5901441)
AS1 5901539 ©2010:58
View ©21:09:47 ~ 22:30:26 CrewAck
AS1 5901640 S201297
©22:34:13 - 00:14:31 Mobile to Incident
Misc yo 5901651 O©20:12:39
00:20:08 - 02:51:02 Crew Ack
AS1 5902033 | ®201245
© 04:12:49 - 05.57.49 StandDown (5901447)`,
  // a simple 3-incident day
  `Select incident:
AS1 5912001
08:15:00 -- 09:40:12
AS1 5912055
10:05:33 -- 11:22:48
AS1 5912090
13:18:05 -- 14:55:30`,
];

/* ---- the user's evolving config (they set money up partway through) ---- */
const USER = {
  currency: '€',
  patterns: ['07-19','19-07'],
  cycleWeeks: 9,
  subsTiers: [{hours:5,label:'',value:13.71},{hours:10,label:'',value:33.61}],
  manualSubs: [{label:'B&B',value:40},{label:'Meal',value:8.5}],
  wage: 0,                       // starts at 0; gets set in month ~3 (the real-world trap)
  otRates: [{mult:1.5,def:true},{mult:2,def:false}],
  otRoundInc: 15
};

/* ---- seeded RNG ---- */
let SEED = parseInt(process.env.SEED||'424242',10);
function rnd(){ SEED=(SEED*1103515245+12345)&0x7fffffff; return SEED/0x7fffffff; }
function pick(a){ return a[Math.floor(rnd()*a.length)]; }
function chance(p){ return rnd()<p; }
function fmtHM(min){ min=((min%1440)+1440)%1440; const h=Math.floor(min/60),m=min%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function weekEndingSunday(ds){ const d=new Date(ds+'T00:00:00'); const dow=(d.getDay()+6)%7; const sun=new Date(d); sun.setDate(d.getDate()+(6-dow)); return ymd(sun); }

/* ---- app-layer money replicas (must match shift-tracker.html) ---- */
function defaultOtRate(){ const d=USER.otRates.find(r=>r.def); return d?d.mult:(USER.otRates[0]?USER.otRates[0].mult:1); }
function effOtMoney(s){
  if(s.otMoney&&s.otMoney>0) return s.otMoney;
  if(s.otHours>0&&USER.wage>0){ const mult=s.otMult||defaultOtRate(); return +(s.otHours*USER.wage*mult).toFixed(2); }
  return 0;
}
function shiftSubsMoney(s){
  let t=0;
  (s.subsistence||[]).forEach(x=>{ let v=Number(x.value)||0; if(v===0&&x.tier){const td=USER.subsTiers.find(t=>t.hours===x.tier); if(td)v=Number(td.value)||0;} t+=v; });
  (s.manualSubs||[]).forEach(m=>{ let v=Number(m.value)||0; if(v===0){const md=USER.manualSubs.find(x=>x.label===m.label); if(md)v=Number(md.value)||0;} t+=v; });
  return t;
}

/* ---- roster cycle ---- */
function buildCycle(){
  const cyc=[];
  for(let w=0;w<USER.cycleWeeks;w++){ const wk=[]; for(let d=0;d<7;d++){ wk.push(chance(0.45)?pick(USER.patterns):'off'); } cyc.push(wk); }
  return cyc;
}
function rosterForDate(cycle, anchorYmd, dateStr, exceptions){
  if(exceptions[dateStr]){ const ex=exceptions[dateStr]; if(ex.type==='off'||ex.type==='annual'||ex.type==='sick') return {pattern:'off',exception:ex.type}; if(ex.type==='work') return {pattern:ex.pattern,exception:'work'}; }
  const anchor=new Date(anchorYmd+'T00:00:00'); const target=new Date(dateStr+'T00:00:00');
  const aD=(anchor.getDay()+6)%7; const aM=new Date(anchor); aM.setDate(anchor.getDate()-aD);
  const tD=(target.getDay()+6)%7; const tM=new Date(target); tM.setDate(target.getDate()-tD);
  const wb=Math.round((tM-aM)/(7*86400000));
  let wi=((wb)%USER.cycleWeeks+USER.cycleWeeks)%USER.cycleWeeks;
  return {pattern:cycle[wi][tD],exception:null};
}

/* ---- generate a shift's calls (manual path) ---- */
function genCalls(pattern){
  const [sh,eh]=pattern.split('-').map(x=>parseInt(x,10));
  let startMin=sh*60, endMin=eh*60; if(endMin<=startMin)endMin+=1440;
  const n=1+Math.floor(rnd()*4); const calls=[]; let cur=startMin+Math.floor(rnd()*30);
  for(let i=0;i<n;i++){ const dur=25+Math.floor(rnd()*180); const cs=cur,ce=cur+dur; if(ce>=endMin)break; calls.push({cad:String(5900000+Math.floor(rnd()*99999)),start:fmtHM(cs),clear:fmtHM(ce)}); cur=ce+(chance(0.5)?(2+Math.floor(rnd()*8)):(15+Math.floor(rnd()*120))); if(cur>=endMin)break; }
  if(!calls.length){ const cs=startMin+10,ce=Math.min(cs+90,endMin-10); calls.push({cad:String(5900000+Math.floor(rnd()*99999)),start:fmtHM(cs),clear:fmtHM(ce)}); }
  const ot=chance(0.35)?(10+Math.floor(rnd()*170)):0;
  return {calls, backAtBase:fmtHM(endMin+ot)};
}

/* ---- invariants ---- */
let violations=[];
function inv(cond,msg,ctx){ if(!cond) violations.push({msg,ctx}); }

/* ---- run ---- */
const stats={ worked:0, logged:0, viaOcr:0, viaManual:0, ocrIncidents:0, ocrFlagged:0,
  engineErrors:0, gapsAnswered:0, exceptions:0, totalOtHours:0, totalOtMoney:0, totalSubMoney:0 };
const store={};
const cycle=buildCycle();
const anchor='2021-01-04';
const exceptions={};

let cur=new Date('2021-01-01T00:00:00');
const end=new Date('2026-01-01T00:00:00');
let monthCount=0, lastMonth=-1;

while(cur<end){
  const ds=ymd(cur);
  // set wage in month 3 (simulating user adding money info partway through)
  if(cur.getMonth()!==lastMonth){ monthCount++; lastMonth=cur.getMonth(); if(monthCount===3){ USER.wage=22.5; } }

  // occasionally add a roster exception
  if(chance(0.03)){ const t=pick(['off','annual','sick','work']); exceptions[ds]={type:t, pattern:t==='work'?pick(USER.patterns):null}; stats.exceptions++; }

  const rf=rosterForDate(cycle, anchor, ds, exceptions);
  if(rf.pattern!=='off'){
    stats.worked++;
    if(chance(0.85)){
      const [sh,eh]=rf.pattern.split('-');
      let calls, backAtBase;
      let usedOcr=false;

      // ~30% of shifts: log via "OCR scan" using a real MDT debug text
      if(chance(0.30)){
        usedOcr=true; stats.viaOcr++;
        const text=pick(REAL_MDT_TEXTS);
        const rows=OCR.mdtFlag(OCR.mdtExtract(text));
        stats.ocrIncidents+=rows.length;
        stats.ocrFlagged+=rows.filter(r=>r.flagged).length;
        // INVARIANT: every OCR row has a 7-digit CAD (or is flagged)
        rows.forEach(r=>{
          const cadOk=/^\d{7}$/.test(r.cad);
          inv(cadOk||r.flagged, 'OCR row with bad CAD not flagged', {ds, cad:r.cad});
          // INVARIANT: any row with a time must have valid HH:MM:SS
          if(r.start) inv(OCR.mdtValidTime(r.start)||r.flagged, 'OCR invalid start not flagged', {ds, start:r.start});
          if(r.clear) inv(OCR.mdtValidTime(r.clear)||r.flagged, 'OCR invalid clear not flagged', {ds, clear:r.clear});
        });
        // user fixes flagged rows / fills blanks → produce clean calls for the engine
        calls=rows.filter(r=>/^\d{7}$/.test(r.cad)&&r.start&&r.clear).map(r=>({cad:r.cad,start:r.start.slice(0,5),clear:r.clear.slice(0,5)}));
        if(!calls.length){ const g=genCalls(rf.pattern); calls=g.calls; }     // all flagged/blank → manual fallback
        backAtBase=fmtHM(parseInt(eh)*60 + (chance(0.35)?(10+Math.floor(rnd()*120)):0));
      } else {
        stats.viaManual++;
        const g=genCalls(rf.pattern); calls=g.calls; backAtBase=g.backAtBase;
      }

      // build engine input
      const input={ rosterStart:sh.padStart(2,'0')+':00', rosterEnd:eh.padStart(2,'0')+':00',
        otRoundInc:USER.otRoundInc, backAtBase, gapAnswers:{}, subsistenceTiers:USER.subsTiers, calls };
      let r=E.computeShift(input);
      if(r.error){ stats.engineErrors++; cur.setDate(cur.getDate()+1); continue; }
      if(r.needAnswers&&r.needAnswers.length){ r.needAnswers.forEach(g=>{ input.gapAnswers[g.index]=chance(0.5)?'yes':'no'; stats.gapsAnswered++; }); r=E.computeShift(input); }
      if(!r.ok){ stats.engineErrors++; cur.setDate(cur.getDate()+1); continue; }

      // INVARIANT: engine sanity warnings must fire on implausible figures
      r.awayWindows.forEach((w,i)=>{ if(w.durMin>18*60) inv(r.warnings&&r.warnings.length>0,'long away window not warned',{ds,dur:w.durMin}); });
      if(r.overtime.rawMin>16*60) inv(r.warnings&&r.warnings.length>0,'high overtime not warned',{ds,ot:r.overtime.rawMin});

      // save-time money (captures current wage; 0 if wage not yet set)
      const otMult = chance(0.1)?pick(USER.otRates).mult:defaultOtRate();
      const otHoursVal=+(r.overtime.roundedMin/60).toFixed(2);
      const otMoney=(USER.wage>0&&otHoursVal>0)?+(otHoursVal*USER.wage*otMult).toFixed(2):0;
      const subsistence=r.awayWindows.filter(w=>w.tier>0).map(w=>{ const td=USER.subsTiers.find(t=>t.hours===w.tier); return {tier:w.tier,label:w.tierLabel||(w.tier+'h'),value:td?(Number(td.value)||0):0}; });
      const manualClaimed=USER.manualSubs.filter(()=>chance(0.25)).map(m=>({label:m.label,value:m.value}));

      const shift={ date:ds, otHours:otHoursVal, otMult, otMoney, wage:USER.wage, subsistence, manualSubs:manualClaimed, currency:USER.currency, otFrom:'x', otTo:'y' };
      store[ds]=shift; stats.logged++;

      // ---- invariants ----
      inv(otHoursVal>=0,'negative OT hours',{ds});
      inv(r.overtime.roundedMin>=r.overtime.rawMin,'rounded<raw',{ds});
      r.awayWindows.forEach(w=>{ if(w.tier>0){ const td=USER.subsTiers.find(t=>t.hours===w.tier); inv(td&&w.durMin>=td.hours*60,'tier not met',{ds,dur:w.durMin,tier:w.tier});
        USER.subsTiers.forEach(t=>{ if(t.hours>w.tier) inv(w.durMin<t.hours*60,'higher tier available but not chosen',{ds,dur:w.durMin,chosen:w.tier,higher:t.hours}); }); } });

      stats.totalOtHours+=otHoursVal;
    }
  }
  cur.setDate(cur.getDate()+1);
}

/* ---- retroactive money: now compute money for ALL stored shifts (wage is set) ---- */
let weekMoney={}, grandOt=0, grandSub=0;
Object.keys(store).forEach(ds=>{
  const s=store[ds];
  const otM=effOtMoney(s);          // retroactive: shifts saved before wage now get money
  const subM=shiftSubsMoney(s);
  inv(otM>=0,'negative effective OT money',{ds,otM});
  inv(subM>=0,'negative subsistence money',{ds,subM});
  // a shift with OT hours, logged AFTER wage was set, must have money
  if(s.otHours>0) inv(otM>0,'OT hours but zero money (wage is set)',{ds,otHours:s.otHours,otM});
  grandOt+=otM; grandSub+=subM;
  const wk=weekEndingSunday(ds);
  inv(wk>=ds,'week-ending before shift',{ds,wk});
  inv(((new Date(wk+'T00:00:00').getDay()+6)%7)===6,'week-ending not Sunday',{ds,wk});
  weekMoney[wk]=(weekMoney[wk]||0)+subM;
});
const weekSum=Object.values(weekMoney).reduce((a,b)=>a+b,0);
inv(Math.abs(weekSum-grandSub)<0.05,'week subsistence sum != grand total',{weekSum:+weekSum.toFixed(2),grandSub:+grandSub.toFixed(2)});
stats.totalOtMoney=+grandOt.toFixed(2); stats.totalSubMoney=+grandSub.toFixed(2);

/* ---- report ---- */
console.log('=== WHOLE-APP 5-YEAR STRESS TEST (1 paramedic) ===\n');
console.log(`Shifts worked: ${stats.worked}, logged: ${stats.logged}`);
console.log(`  via OCR scan: ${stats.viaOcr}  (${stats.ocrIncidents} incidents extracted, ${stats.ocrFlagged} flagged for check)`);
console.log(`  via manual entry: ${stats.viaManual}`);
console.log(`Roster exceptions applied: ${stats.exceptions}`);
console.log(`Gap questions answered: ${stats.gapsAnswered}`);
console.log(`Engine errors (mistyped guard): ${stats.engineErrors}`);
console.log(`\nTotals over 5 years:`);
console.log(`  Overtime: ${stats.totalOtHours.toFixed(1)}h  ${USER.currency}${stats.totalOtMoney}`);
console.log(`  Subsistence money: ${USER.currency}${stats.totalSubMoney}`);
console.log(`\nInvariant violations: ${violations.length}`);
if(violations.length){
  const g={}; violations.forEach(v=>g[v.msg]=(g[v.msg]||0)+1);
  Object.entries(g).forEach(([m,n])=>console.log(`  [${n}] ${m}`));
  console.log('\nFirst 5:'); violations.slice(0,5).forEach(v=>console.log('  ',v.msg,JSON.stringify(v.ctx)));
  process.exit(1);
} else {
  console.log('\nALL INVARIANTS HELD across OCR, manual entry, roster, engine, and money.');
}
