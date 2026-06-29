/* ============================================================================
   STATION-ROSTER STRESS TEST
   Built around the real Mullingar station structure: a 9-week rotating cycle,
   ~20 crew on staggered offsets, the full pattern mix seen on the sheet, plus
   realistic O/T, S/L, and A/L exceptions. Crews are ANONYMISED (Crew 01..N) —
   no real names are used or retained. Runs the real engine over 5 years.
   ============================================================================ */
const E = require('./engine/engine.js');
const OCR = require('/tmp/ocr.js');

/* ---- the real pattern mix from the sheet ---- */
const PATTERNS = {
  'D12a': {start:'08:00', end:'20:00'},   // 0800-2000 12h day
  'D12b': {start:'07:00', end:'19:00'},   // 0700-1900 12h day
  'D10' : {start:'07:00', end:'17:00'},   // 0700-1700 10h day
  'D9'  : {start:'08:00', end:'17:00'},   // 0800-1700 9h day
  'N12a': {start:'19:00', end:'07:00'},   // 1900-0700 12h night
  'N12b': {start:'20:00', end:'08:00'},   // 2000-0800 12h night
};
const DAY_PATS = ['D12a','D12b','D10','D9'];
const NIGHT_PATS = ['N12a','N12b'];
const ALL_WORK = [...DAY_PATS, ...NIGHT_PATS];

/* ---- subsistence + money config (NAS-style) ---- */
const CFG = {
  subsTiers: [{hours:5,label:'',value:13.71},{hours:10,label:'',value:33.61}],
  wage: 22.5,
  otRates: [{mult:1.5,def:true},{mult:2,def:false}],
  otRoundInc: 15, otRoundDir: 'up',
};

/* ---- seeded RNG ---- */
let SEED = parseInt(process.env.SEED||'290626',10);
function rnd(){ SEED=(SEED*1103515245+12345)&0x7fffffff; return SEED/0x7fffffff; }
function pick(a){ return a[Math.floor(rnd()*a.length)]; }
function chance(p){ return rnd()<p; }
function fmtHM(min){ min=((min%1440)+1440)%1440; return String(Math.floor(min/60)).padStart(2,'0')+':'+String(min%60).padStart(2,'0'); }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function weekEndSun(ds){ const d=new Date(ds+'T00:00:00'); const sun=new Date(d); sun.setDate(d.getDate()+(6-((d.getDay()+6)%7))); return ymd(sun); }

/* ---- build a 9-week cycle for one crew ----
   Realistic shape: runs of day or night shifts broken by rest/off, ~36-48h/week. */
function buildCycle(){
  const cyc=[];
  for(let w=0; w<9; w++){
    const wk=[];
    // choose this week's "flavour": day-run, night-run, or mixed/light
    const flavour=rnd();
    let worked=0;
    for(let d=0; d<7; d++){
      // target roughly 3-4 shifts per week
      const wantWork = worked<4 && chance(flavour<0.4?0.55:(flavour<0.8?0.5:0.4));
      if(wantWork){
        const pat = flavour<0.4 ? pick(DAY_PATS) : (flavour<0.8 ? pick(NIGHT_PATS) : pick(ALL_WORK));
        wk.push(pat); worked++;
      } else {
        wk.push(chance(0.5)?'REST':'OFF');
      }
    }
    cyc.push(wk);
  }
  return cyc;
}

function cycleWeekIndex(anchorYmd, anchorWeek, dateStr){
  const a=new Date(anchorYmd+'T00:00:00'), t=new Date(dateStr+'T00:00:00');
  const aM=new Date(a); aM.setDate(a.getDate()-((a.getDay()+6)%7));
  const tM=new Date(t); tM.setDate(t.getDate()-((t.getDay()+6)%7));
  const wb=Math.round((tM-aM)/(7*86400000));
  return ((anchorWeek+wb)%9+9)%9;
}

/* ---- generate calls for a worked shift ---- */
function genCalls(pat){
  const p=PATTERNS[pat];
  let s=parseInt(p.start)*60+ +p.start.split(':')[1];
  let e=parseInt(p.end)*60+ +p.end.split(':')[1]; if(e<=s)e+=1440;
  const n=1+Math.floor(rnd()*4); const calls=[]; let cur=s+Math.floor(rnd()*40);
  for(let i=0;i<n;i++){ const dur=25+Math.floor(rnd()*200); const cs=cur,ce=cur+dur; if(ce>=e)break;
    calls.push({cad:String(5900000+Math.floor(rnd()*99999)),start:fmtHM(cs),clear:fmtHM(ce)});
    cur=ce+(chance(0.45)?(2+Math.floor(rnd()*8)):(15+Math.floor(rnd()*150))); if(cur>=e)break; }
  if(!calls.length){ const cs=s+15,ce=Math.min(cs+120,e-10); calls.push({cad:String(5900000+Math.floor(rnd()*99999)),start:fmtHM(cs),clear:fmtHM(ce)}); }
  const otMin = chance(0.32)?(10+Math.floor(rnd()*170)):0;
  return {calls, back:fmtHM(e+otMin), rosterStart:p.start, rosterEnd:p.end};
}

/* ---- invariants ---- */
let violations=[]; const inv=(c,m,x)=>{ if(!c) violations.push({m,x}); };

/* ---- run: N crews, staggered anchors, 5 years ---- */
const NCREW = 20;
const crews = [];
for(let i=0;i<NCREW;i++){
  crews.push({ id:'Crew '+String(i+1).padStart(2,'0'), cycle:buildCycle(),
    anchorDate:'2021-01-04', anchorWeek:i%9 });   // staggered across the 9 weeks
}

const stats={ worked:0, logged:0, viaOcr:0, ot:0, otMoney:0, subMoney:0, exOT:0, exSL:0, exAL:0, engineErr:0, gaps:0, ocrIncidents:0, ocrFlagged:0, warnings:0 };
const perCrewHours={};

let cur=new Date('2021-01-01T00:00:00'); const end=new Date('2026-01-01T00:00:00');
while(cur<end){
  const ds=ymd(cur);
  const dow=(cur.getDay()+6)%7;     // 0=Mon
  for(const crew of crews){
    const wi=cycleWeekIndex(crew.anchorDate, crew.anchorWeek, ds);
    let pat=crew.cycle[wi][dow];

    // ---- exceptions (O/T, S/L, A/L) layered on top of the base cycle ----
    let exType=null;
    if(pat==='OFF' || pat==='REST'){
      if(chance(0.04)){ pat=pick(ALL_WORK); exType='OT'; stats.exOT++; }   // overtime on a day off
    } else {
      const roll=rnd();
      if(roll<0.02){ exType='SL'; stats.exSL++; pat='OFF'; }                // sick
      else if(roll<0.05){ exType='AL'; stats.exAL++; pat='OFF'; }           // annual leave
    }

    if(pat==='OFF' || pat==='REST') continue;
    stats.worked++;
    if(!chance(0.86)) continue;   // not every worked shift gets logged

    const g=genCalls(pat);
    const input={ rosterStart:g.rosterStart, rosterEnd:g.rosterEnd, otRoundInc:CFG.otRoundInc, otRoundDir:CFG.otRoundDir,
      backAtBase:g.back, gapAnswers:{}, subsistenceTiers:CFG.subsTiers, calls:g.calls };

    let r=E.computeShift(input);
    if(r.error){ stats.engineErr++; continue; }
    if(r.needAnswers&&r.needAnswers.length){ r.needAnswers.forEach(q=>{ input.gapAnswers[q.index]=chance(0.5)?'yes':'no'; stats.gaps++; }); r=E.computeShift(input); }
    if(!r.ok){ stats.engineErr++; continue; }
    if(r.warnings&&r.warnings.length) stats.warnings++;

    // ---- invariants ----
    const otH=+(r.overtime.roundedMin/60).toFixed(2);
    inv(otH>=0, 'negative OT', {ds,crew:crew.id});
    inv(r.overtime.roundedMin>=r.overtime.rawMin, 'rounded<raw (up)', {ds});
    r.awayWindows.forEach((w,i)=>{
      if(w.tier>0){ const td=CFG.subsTiers.find(t=>t.hours===w.tier);
        inv(td && w.durMin>=td.hours*60, 'tier not met', {ds,dur:w.durMin,tier:w.tier});
        CFG.subsTiers.forEach(t=>{ if(t.hours>w.tier) inv(w.durMin<t.hours*60,'higher tier missed',{ds,dur:w.durMin}); });
      }
      // sanity: an away window over 18h must raise a warning
      if(w.durMin>18*60) inv(r.warnings&&r.warnings.length>0,'long window not warned',{ds,dur:w.durMin});
    });
    if(r.overtime.rawMin>16*60) inv(r.warnings&&r.warnings.length>0,'high OT not warned',{ds,ot:r.overtime.rawMin});

    const otMoney=otH>0?+(otH*CFG.wage*1.5).toFixed(2):0;
    const subMoney=r.awayWindows.filter(w=>w.tier>0).reduce((s,w)=>{ const td=CFG.subsTiers.find(t=>t.hours===w.tier); return s+(td?td.value:0); },0);
    stats.logged++; stats.ot+=otH; stats.otMoney+=otMoney; stats.subMoney+=subMoney;
    perCrewHours[crew.id]=(perCrewHours[crew.id]||0)+otH;

    // week-ending invariant
    const we=weekEndSun(ds);
    inv(((new Date(we+'T00:00:00').getDay()+6)%7)===6,'week-end not Sunday',{ds,we});
    inv(we>=ds,'week-end before shift',{ds,we});
  }
  cur.setDate(cur.getDate()+1);
}

/* ---- report ---- */
console.log('=== STATION-ROSTER STRESS TEST ===');
console.log('(real Mullingar 9-week cycle structure, '+NCREW+' anonymised crews, 5 years)\n');
console.log('Crews: '+NCREW+' on staggered 9-week offsets');
console.log('Shifts worked: '+stats.worked+', logged: '+stats.logged);
console.log('Exceptions injected: '+stats.exOT+' O/T, '+stats.exSL+' S/L, '+stats.exAL+' A/L');
console.log('Gap questions answered: '+stats.gaps);
console.log('Engine errors (mistyped guard): '+stats.engineErr);
console.log('Sanity warnings raised: '+stats.warnings);
console.log('\n5-year totals across the station:');
console.log('  Overtime: '+stats.ot.toFixed(0)+'h  €'+stats.otMoney.toFixed(2));
console.log('  Subsistence: €'+stats.subMoney.toFixed(2));
console.log('\nInvariant violations: '+violations.length);
if(violations.length){
  const g={}; violations.forEach(v=>g[v.m]=(g[v.m]||0)+1);
  Object.entries(g).forEach(([m,n])=>console.log('  ['+n+'] '+m));
  violations.slice(0,5).forEach(v=>console.log('   eg',v.m,JSON.stringify(v.x)));
  process.exit(1);
} else {
  console.log('\nALL INVARIANTS HELD across the real station rotation.');
}
