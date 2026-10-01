/* ════════════════════════════════════════════════════════════════════
   adjunct.js — ConvergeSPH shared PSU adjunct logic (PSUFA CBA)

   ONE copy of every adjunct calculation, loaded by both faculty.html and
   scheduling.html, so the CBA interpretations below can't drift apart
   between apps. Pure calculation only: no DOM, no Supabase, no HTML. Each
   page renders the results its own way.

   Load it with a version query so GitHub Pages / browser caches pick up
   changes:  <script src="adjunct.js?v=2026-10-01g"></script>
   …and bump the query whenever this file changes.

   USAGE
     ConvergeAdj.setData({terms, offerings, courses, faculty, overrides, rights})
       terms      raw `terms` rows: code,label,academic_year,sort_order,
                  start_date,end_date
       offerings  raw `offerings` rows: id,term,course_id,instructor1_id,
                  instructor2_id
       courses    raw `courses` rows: id,full_name,credits
       faculty    [{id,first_name,last_name,start_date,categories:[…]}]
       overrides  {facultyId: contract_type}  (faculty_psu_adjunct)
       rights     [faculty_psu_adjunct_rights rows]  (all, incl. superseded)
     Call again after every reload — it clears every cache.

   Every function is also exported as a global under its historical name
   (adjCurrent, adjContractInfo, …) so existing render code keeps working.
   The host page must NOT redeclare any of them.

   ADMIN ONLY. Faculty start dates, overrides and rights only reach admins
   (RLS), so for anyone else these calculations just come back "unknown".
   ════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* ─── STATE (set by setData) ─────────────────────────────────── */
let TERM_SEQ=[];      // every term, oldest → newest
let TERM_MAP={};      // code → term row
let AY_SEQ=[];        // academic years, oldest → newest
let CUR_TERM_IDX=-1;  // index into TERM_SEQ of today's term; -1 = unknown
let TEACHING={};      // faculty id → [offering, …] (either slot)
let COURSES={};       // course id → course row
let FAC=[];
let OVR={};           // faculty id → contract_type override
let RIGHTS={};        // faculty id → [rights rows], newest first
const CL={}, CT={}, RT={};   // per-faculty caches
let RANK=null;

const clear=o=>{for(const k in o)delete o[k];};
const N=v=>{const s=String(v??'').trim();return s===''?null:s;};
const r1=x=>Math.round(x*100)/100;
function fmtDate(d){
  if(!d)return '—';
  const dt=new Date(String(d).slice(0,10)+'T00:00:00');
  return isNaN(dt)?String(d):dt.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
}

/* All terms in true chronological order. AY codes sort as strings
   (AY25-26 < AY26-27) and sort_order runs Summer→Fall→Winter→Spring inside
   an AY, so the pair gives the real sequence across years. */
function setData(d){
  d=d||{};
  TERM_SEQ=(d.terms||[]).slice().sort((a,b)=>
    String(a.academic_year).localeCompare(String(b.academic_year))||(a.sort_order-b.sort_order));
  TERM_MAP={}; TERM_SEQ.forEach(t=>{TERM_MAP[t.code]=t;});
  AY_SEQ=[...new Set(TERM_SEQ.map(t=>t.academic_year))];
  CUR_TERM_IDX=currentTermIdx(localISODate());
  COURSES={}; (d.courses||[]).forEach(c=>{COURSES[c.id]=c;});
  TEACHING={};
  (d.offerings||[]).forEach(o=>{
    [o.instructor1_id,o.instructor2_id].forEach(fid=>{
      if(!fid)return;
      const list=(TEACHING[fid]=TEACHING[fid]||[]);
      if(!list.includes(o))list.push(o);   // same person in both slots → once
    });
  });
  FAC=d.faculty||[];
  OVR=d.overrides||{};
  RIGHTS={};
  (d.rights||[]).forEach(r=>{(RIGHTS[r.faculty_id]=RIGHTS[r.faculty_id]||[]).push(r);});
  Object.values(RIGHTS).forEach(a=>a.sort((x,y)=>String(y.established_at).localeCompare(String(x.established_at))));
  clear(CL);clear(CT);clear(RT);RANK=null;
}

// Local calendar date, not UTC — after 5pm Pacific, UTC is already tomorrow.
function localISODate(d){
  d=d||new Date();
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
}
/* Today's term from the start/end dates set in the scheduling app's Terms &
   Academic Years tool. Between terms (a break), the EARLIER term counts as
   current — i.e. the latest term that has already started. Terms without a
   start date can't be placed in time, so they're skipped here (they still
   count as a step in the 8-term window). Returns -1 if no term has started. */
function currentTermIdx(today){
  const inRange=TERM_SEQ.findIndex(t=>t.start_date&&t.end_date&&
    String(t.start_date).slice(0,10)<=today&&today<=String(t.end_date).slice(0,10));
  if(inRange>=0)return inRange;
  let best=-1;
  TERM_SEQ.forEach((t,i)=>{if(t.start_date&&String(t.start_date).slice(0,10)<=today)best=i;});
  return best;
}

const ADJ_CAT='PSUAdjunct';
const ADJ_WINDOW=8;   // "Current" = taught in today's term or the 7 before it
const termIdx=code=>TERM_SEQ.findIndex(t=>t.code===code);
const termLabel=code=>(TERM_MAP[code]&&TERM_MAP[code].label)||code;
const isPSUAdj=f=>(f.categories||[]).includes(ADJ_CAT);
const isInactive=f=>(f.categories||[]).includes('Inactive');
const adjNoStart=f=>isPSUAdj(f)&&!N(f.start_date);

/* ─── CURRENT ──────────────────────────────────────────────────
   Counts either instructor slot. Future terms already on the schedule don't
   count — the window ends at today's term. */
function adjCurrent(f){
  const idxs=(TEACHING[f.id]||[]).map(o=>termIdx(o.term)).filter(i=>i>=0);
  if(CUR_TERM_IDX<0){
    const last=idxs.length?TERM_SEQ[Math.max(...idxs)].code:null;
    return {state:'unk',last,from:null,to:null,short:false};
  }
  const lo=Math.max(0,CUR_TERM_IDX-(ADJ_WINDOW-1));
  const past=idxs.filter(i=>i<=CUR_TERM_IDX);
  const lastIdx=past.length?Math.max(...past):-1;
  return {
    state:(lastIdx>=lo)?'on':'off',
    last:lastIdx>=0?TERM_SEQ[lastIdx].code:null,
    from:TERM_SEQ[lo].code, to:TERM_SEQ[CUR_TERM_IDX].code,
    short:(CUR_TERM_IDX-(ADJ_WINDOW-1))<0   // fewer than 8 terms on record
  };
}
function adjCurrentTitle(c){
  if(c.state==='unk')return 'Current status unknown — no term has a start date on or before today. Set term dates in Scheduling → Terms & Academic Years.';
  const win=`Window: ${termLabel(c.from)} – ${termLabel(c.to)}`+
    (c.short?` (only ${CUR_TERM_IDX+1} of ${ADJ_WINDOW} terms on record)`:'');
  return (c.last?`Last taught ${termLabel(c.last)}`:'No teaching on record')+'. '+win+'.';
}

/* ─── ACCUMULATED CREDIT LOAD (PSUFA CBA) ────────────────────────
   "Cumulative number of credits, in a department, an Adjunct faculty member
   has taught starting from initial date of hire excluding courses taught
   during a summer session … excluding any credits taught while working
   outside of the PSUFA bargaining unit. A break in service of a full academic
   year (including summer) will reset cumulative load calculations."

   As implemented (decisions, Tim 10/1/26):
   · Department = SPH as a whole — one total across every prefix.
   · From the faculty record's Start Date. Teaching in a term that ended
     before it isn't counted (and isn't service). No start date → everything
     on record counts, and the profile says so.
   · Summer credits never count. Summer teaching IS service, though — it
     interrupts a break.
   · Co-taught (both instructor slots filled) = credits ÷ 2, as in CHTool.
     FTE-exempt courses still count (adjuncts rarely teach them).
   · Break = ADJ_BREAK_TERMS consecutive terms (any four, summer included,
     not tied to AY boundaries) with no teaching. The total restarts at the
     next term taught. If the break is the most recent stretch through
     today's term, the load is 0 now.
   · Through today's term only; future scheduled terms don't count yet.
   · Converge data only: history before the earliest term on record, and
     credits taught outside the bargaining unit, are not accounted for.
   · Ranged/blank credits (e.g. "1-4") can't be summed honestly, so those
     offerings are left out and flagged for a manual check. */
const ADJ_BREAK_TERMS=4;
const isSummerTerm=t=>/^summer/i.test(String(t.code||''))||/^summer/i.test(String(t.label||''));
const isFallTerm=t=>/^fall/i.test(String(t.code||''))||/^fall/i.test(String(t.label||''));
function parseCredits(v){
  const s=String(v??'').trim();
  if(!s||/[-‐-―]/.test(s))return null;   // blank or ranged
  const n=parseFloat(s);
  return isNaN(n)?null:n;
}
const courseName=c=>c?String(c.full_name).split(':')[0].trim():'(course removed)';
function adjCreditLoadDetail(f){
  if(CL[f.id])return CL[f.id];
  const out={total:null,since:null,resetAfter:null,reset:false,hadBreak:false,runStartIdx:null,
             byTerm:[],items:[],rows:[],flagged:[],notes:[]};
  if(CUR_TERM_IDX<0){out.notes.push('Term dates not set — can\'t tell which terms have happened.');return (CL[f.id]=out);}
  const hire=N(f.start_date)?String(f.start_date).slice(0,10):null;
  const afterHire=t=>{if(!hire)return true;const end=String(t.end_date||t.start_date||'').slice(0,10);return !end||end>=hire;};
  const offs=[];
  (TEACHING[f.id]||[]).forEach(o=>{
    const i=termIdx(o.term);
    if(i<0||i>CUR_TERM_IDX||!afterHire(TERM_SEQ[i]))return;
    offs.push({o,i});
  });
  const taught=new Set(offs.map(x=>x.i));
  // Walk the term sequence: a run of ADJ_BREAK_TERMS untaught terms after
  // some teaching is a break; counting restarts at the next term taught.
  let runStart=null, gap=0, lastBreakEnd=null;
  for(let i=0;i<=CUR_TERM_IDX;i++){
    if(taught.has(i)){
      if(runStart===null)runStart=i;
      else if(gap>=ADJ_BREAK_TERMS){lastBreakEnd=i-1;runStart=i;}
      gap=0;
    }else if(runStart!==null)gap++;
  }
  out.hadBreak=lastBreakEnd!==null;
  out.runStartIdx=runStart;
  if(runStart!==null&&gap>=ADJ_BREAK_TERMS){        // break is the current stretch
    out.reset=true; out.hadBreak=true; out.total=0;
    out.resetAfter=TERM_SEQ[CUR_TERM_IDX-gap].code;   // last term taught
    out.notes.push(`Break in service: no teaching since ${termLabel(out.resetAfter)} (${gap} terms). Count restarts with the next appointment.`);
  }else{
    let tot=0; const per={};
    offs.filter(x=>runStart!==null&&x.i>=runStart).sort((a,b)=>a.i-b.i).forEach(({o,i})=>{
      const t=TERM_SEQ[i], c=COURSES[o.course_id], name=courseName(c);
      if(isSummerTerm(t))return;
      const cr=parseCredits(c&&c.credits);
      if(cr===null){out.flagged.push(`${termLabel(t.code)} ${name} (credits: ${c&&N(c.credits)?c.credits:'blank'})`);return;}
      const two=!!(o.instructor1_id&&o.instructor2_id);
      const eff=two?cr/2:cr;
      tot+=eff; per[i]=(per[i]||0)+eff;
      out.items.push({i,cr,eff,two,name});
      out.rows.push(`${termLabel(t.code)}  ${name}: ${r1(cr)} cr${two?' ÷ 2 (co-taught) → '+r1(eff):''}`);
    });
    // Running total per term — used to find the term a credit threshold was crossed.
    let cum=0;
    Object.keys(per).map(Number).sort((a,b)=>a-b).forEach(i=>{cum+=per[i];out.byTerm.push({i,cum:r1(cum)});});
    out.total=r1(tot);
    out.since=runStart!==null?TERM_SEQ[runStart].code:null;
    if(out.hadBreak)out.notes.push(`Reset by a break in service; counting since ${termLabel(out.since)}.`);
  }
  if(!hire)out.notes.push('No start date on record — counting all teaching in Converge.');
  const first=TERM_SEQ[0];
  if(first&&(!hire||(first.start_date&&hire<String(first.start_date).slice(0,10))))
    out.notes.push(`Converge history begins ${termLabel(first.code)}; earlier credits and any taught outside the PSUFA unit aren't included.`);
  if(out.flagged.length)out.notes.push(`${out.flagged.length} course(s) with ranged/blank credits left out — check manually.`);
  return (CL[f.id]=out);
}
const adjCreditLoad=f=>adjCreditLoadDetail(f).total;

/* ─── CONTRACT TYPE (PSUFA CBA 3.2–3.4) ──────────────────────────
   Calculated, with an admin override for cases Converge can't see (2-year
   rights retained from a previous CBA, etc.). faculty_psu_adjunct.contract_type
   holds the OVERRIDE: NULL = use the calculation.

   3.2  New hires: term-by-term.
   3.3  9-month: after 2 years employed in the department OR 8 credits,
        whichever first. Offered at the start of the following AY.
   3.4  2-year: after 3 years employed OR 20 credits, whichever first, AND
        the professional evaluation (Art. 8 §4). Offered at the start of the
        AY following eligibility. 2-year thereafter.
        Exception: employed since before Sept 16, 2014 → 2-year, no evaluation.

   As implemented (decisions, Tim 10/1/26):
   · "Credits" = accumulated credit load (above): no summer, co-taught ÷ 2,
     reset by a break in service.
   · Years employed count from the Start Date — or, after a break in service,
     from the first term taught after it (the break resets appointments too).
     A break that is the current stretch → term-by-term.
   · "Following AY" = the first FALL term after the term eligibility was
     reached. (Fall 2020 + 8 cr in Fall 2020 → 9-month from Fall 2021.)
   · Evaluation: assumed complete for now (ADJ_EVAL_ASSUMED). When it's
     tracked, a 2-year upgrade takes effect the first Fall after BOTH
     eligibility and the evaluation — which is what makes the CBA's
     "eligible Winter 2020 → Fall 2021" example come out right.
   · Pre-9/16/2014 exception uses the Start Date (SPH's), as a stand-in for
     "employed by PSU", and only when there's been no break since.
   · Eligibility dated before Converge's term history is treated as already
     in effect.
   · No Start Date → can't be calculated (the only flag); an override still
     works. */
const CONTRACT_TYPES=[
  {v:'2yr', label:'2-year'},
  {v:'9mo', label:'9-month'},
  {v:'term',label:'Term-by-term'}
];
const contractTier=v=>CONTRACT_TYPES.findIndex(c=>c.v===v);
const contractLabel=v=>(CONTRACT_TYPES.find(c=>c.v===v)||{}).label||'';
const ADJ_9MO={years:2,credits:8};
const ADJ_2YR={years:3,credits:20};
const ADJ_PRE2014='2014-09-16';
const ADJ_EVAL_ASSUMED=true;   // Art. 8 §4 evaluation not tracked yet
const addYears=(iso,n)=>(+iso.slice(0,4)+n)+iso.slice(4,10);
// Term in which a date falls: the latest term started on or before it.
// -1 = before Converge's history; null = the date hasn't arrived yet.
function termAtDate(iso){
  if(iso>localISODate())return null;
  let best=-1;
  TERM_SEQ.forEach((t,i)=>{if(t.start_date&&String(t.start_date).slice(0,10)<=iso)best=i;});
  return best;
}
// First Fall term after term index i ('pre' when i is before history).
function nextFallAfter(i){
  if(i===-1)return 'pre';
  for(let j=i+1;j<TERM_SEQ.length;j++)if(isFallTerm(TERM_SEQ[j]))return j;
  return null;   // that Fall isn't in the terms table yet
}
const inEffect=j=>j==='pre'||(j!=null&&j<=CUR_TERM_IDX);
const fallLabel=j=>j==='pre'?'before Converge history':j==null?'the next Fall (not yet in terms)':termLabel(TERM_SEQ[j].code);
/* One appointment level: when eligibility was reached (time or credits,
   whichever first), WHICH of the two got there first, and when the
   appointment takes effect. */
function adjTier(serviceStart,d,rule){
  const byTime=termAtDate(addYears(serviceStart,rule.years));
  const hit=d.byTerm.find(x=>x.cum>=rule.credits);
  const byCr=hit?hit.i:null;
  const c=[byTime,byCr].filter(x=>x!=null);
  if(!c.length)return {elig:null,eff:null,by:null,why:`${rule.years} yrs (${fmtDate(addYears(serviceStart,rule.years))}) or ${rule.credits} cr (now ${d.total})`};
  const elig=Math.min(...c);
  const by=(byCr!=null&&byCr===elig&&(byTime==null||byCr<=byTime))?'credits':'time';
  const why=by==='credits'
    ?`${rule.credits} credits reached ${elig===-1?'before Converge history':termLabel(TERM_SEQ[elig].code)}`
    :`${rule.years} years employed (${fmtDate(addYears(serviceStart,rule.years))})`;
  return {elig,eff:nextFallAfter(elig),by,why,years:rule.years};
}
function adjContractCalc(f){
  if(CT[f.id])return CT[f.id];
  const save=r=>(CT[f.id]=r);
  const hire=N(f.start_date)?String(f.start_date).slice(0,10):null;
  if(!hire)return save({type:null,lines:['No start date — can\'t calculate.']});
  if(CUR_TERM_IDX<0)return save({type:null,lines:['Term dates not set — can\'t calculate.']});
  const d=adjCreditLoadDetail(f);
  if(d.reset)return save({type:'term',reset:true,lines:[`Term-by-term: break in service since ${termLabel(d.resetAfter)}. Eligibility restarts with the next appointment.`]});
  if(!d.hadBreak&&hire<ADJ_PRE2014)
    return save({type:'2yr',pre2014:true,lines:[`2-year: employed since before Sept 16, 2014 (start ${fmtDate(hire)}) — automatically eligible, no evaluation required.`]});
  const serviceStart=d.hadBreak&&d.runStartIdx!=null&&TERM_SEQ[d.runStartIdx].start_date
    ?String(TERM_SEQ[d.runStartIdx].start_date).slice(0,10):hire;
  const t9=adjTier(serviceStart,d,ADJ_9MO), t2=adjTier(serviceStart,d,ADJ_2YR);
  const lines=[];
  if(d.hadBreak)lines.push(`Clock restarted after a break in service: counting from ${termLabel(d.since)}.`);
  let type='term';
  if(inEffect(t2.eff))type='2yr';
  else if(inEffect(t9.eff))type='9mo';
  // Explain both levels: in effect / upcoming / not yet eligible.
  const desc=(lbl,t)=>t.elig==null?`${lbl}: not yet eligible — needs ${t.why}.`
    :inEffect(t.eff)?`${lbl}: from ${fallLabel(t.eff)} (eligible: ${t.why}).`
    :`${lbl}: eligible (${t.why}) — offered ${fallLabel(t.eff)}.`;
  if(type!=='2yr')lines.push(desc('9-month',t9));
  lines.push(desc('2-year',t2)+(t2.elig!=null&&ADJ_EVAL_ASSUMED?' Evaluation assumed complete.':''));
  return save({type,lines,t9,t2,serviceStart});
}
// Effective contract type. ovr: undefined → stored override; '' → force
// auto; a type → that type (the edit modal's unsaved selection).
function adjContractInfo(f,ovr){
  const stored=OVR[f.id];
  const manual=ovr===undefined?(contractTier(stored)>=0?stored:null)
                              :(contractTier(ovr)>=0?ovr:null);
  const calc=adjContractCalc(f);
  return {type:manual||calc.type,manual:!!manual,calc};
}
const adjContract=f=>adjContractInfo(f).type;

/* ─── REVIEW ELIGIBILITY (professional evaluation) ───────────────
   Same threshold as the 2-year appointment (ADJ_2YR), computed from the same
   calculation, so the two can never disagree. States:
     due  done  manual  exempt  not  notcurrent  unknown
   Only `due` counts as "review eligible" — it's the actionable one. */
function adjReviewInfo(f){
  // Not current → never eligible, whatever else is true. (Tim, 10/1/26)
  if(adjCurrent(f).state!=='on')
    return {state:'notcurrent',text:`Not eligible — not current (no teaching in the last ${ADJ_WINDOW} terms).`};
  const ci=adjContractInfo(f), c=ci.calc;
  if(ci.manual&&ci.type==='2yr')return {state:'manual',text:'Not needed — 2-year set manually.'};
  if(!c.type)return {state:'unknown',text:c.lines[0]||'Can\'t determine.'};
  if(c.pre2014)return {state:'exempt',text:'Not required (employed before Sept 16, 2014). The Chair may initiate one every four years.'};
  if(c.reset)return {state:'not',text:'Not eligible — break in service. Restarts with the next appointment.'};
  const t2=c.t2;
  if(!t2||t2.elig==null)return {state:'not',text:`Not yet — needs ${t2?t2.why:'3 yrs or 20 cr'}.`};
  const when=t2.elig===-1?'before Converge history':termLabel(TERM_SEQ[t2.elig].code);
  if(inEffect(t2.eff))return {state:'done',text:`Eligible since ${when} (${t2.why}). 2-year from ${fallLabel(t2.eff)}; evaluation assumed complete.`};
  return {state:'due',text:`Eligible since ${when} (${t2.why}) — offer the professional evaluation. 2-year would start ${fallLabel(t2.eff)}.`};
}
function adjReviewEligible(f){
  const s=adjReviewInfo(f).state;
  return s==='unknown'?null:s==='due';
}

/* ─── APPOINTMENT ORDER (PSUFA CBA) ──────────────────────────────
   One list for all of SPH: tier (2-year → 9-month → term-by-term), then
   accumulated credit load, highest first. Who's on it: PSUAdjunct, Current,
   a determinable contract type, and NOT also Inactive. Ties share a rank
   (1, 2, 2, 4).
   override = {facultyId: contractOverride} previews an unsaved override
   ('' = auto). Never cached. */
function adjRanking(override){
  if(!override&&RANK)return RANK;
  const ct=f=>adjContractInfo(f,(override&&f.id in override)?override[f.id]:undefined).type;
  const list=FAC.filter(f=>(isPSUAdj(f)||(override&&f.id in override))&&!isInactive(f)
      &&adjCurrent(f).state==='on'&&contractTier(ct(f))>=0)
    .map(f=>({f,tier:contractTier(ct(f)),cr:adjCreditLoad(f)||0}))
    .sort((a,b)=>(a.tier-b.tier)||(b.cr-a.cr));
  const rank={}; let prev=null;
  list.forEach((x,i)=>{
    const r=(prev&&prev.tier===x.tier&&prev.cr===x.cr)?rank[prev.f.id]:i+1;
    rank[x.f.id]=r; prev=x;
  });
  const counts={}; Object.values(rank).forEach(r=>{counts[r]=(counts[r]||0)+1;});
  const out={rank,size:list.length,tied:id=>counts[rank[id]]>1,list:list.map(x=>x.f)};
  if(!override)RANK=out;
  return out;
}
function adjApptOrder(f){const r=adjRanking().rank[f.id];return r==null?null:r;}

/* ─── ASSIGNMENT RIGHTS (PSUFA CBA 8 §3.6 / §3.7) ────────────────
   9-month: greater of 1 course per AY or the average annual credit load
            taught during the initial 8-credit / 2-year eligibility period.
   2-year:  greater of 2 courses per AY or the average annual credit load
            during the initial 20-credit / 3-year period.
   pre-2014: greater of 2 courses or the AY14-15 + AY15-16 average — those
            years predate Converge, so these are entered by hand.
   "If an Adjunct's assignment rights do not correspond with the discrete
   course units available, their appointment must be rounded up."
   "Once established, assignment rights remain constant."

   As implemented (decisions, Tim 10/1/26):
   · Rights are STORED (faculty_psu_adjunct_rights), established once and
     locked. This calculates what they SHOULD be; the stored row is what
     they ARE. A mismatch is reported, never silently "fixed".
   · Established once the eligibility window closes (the term the threshold
     was reached), for the Fall the appointment starts — so rights for an
     upcoming 9-month/2-year appointment exist in time for spring course
     assignment.
   · Window: from service start (Start Date, or the restart after a break)
     through the term eligibility was reached.
       – Reached by CREDITS: the window includes that term; its length is
         the number of academic years it spans. (CBA: 8 cr in year 1 + 12 by
         Winter of year 2 = 20 cr over 2 AYs → 10 cr.)
       – Reached by TIME: the window is the rule's years (2 or 3) and stops
         before the term containing the anniversary. (CBA: 4 cr + 2 cr over
         2 years → 3 cr.)
   · Window credits = accumulated credit load (no summer, co-taught ÷ 2).
   · Course size = the most common credit value among courses the adjunct
     taught in the window (ties → the smaller), falling back to all their
     counted teaching, then to 4 cr (flagged).
   · Minimum = greater of floor (1 or 2 courses × size) and the average,
     rounded UP to a whole number of courses.
   · A break in service ends the active rights (they're re-established with
     the next qualifying appointment).
   · Can't calculate → manual entry, with a required note: pre-2014 hires,
     eligibility before Converge's history, a contract-type override that
     disagrees with the calculation. */
const ADJ_DEFAULT_COURSE=4;
function modeSmallest(vals){
  const n={}; vals.forEach(v=>{n[v]=(n[v]||0)+1;});
  let best=null,bc=0;
  Object.keys(n).map(Number).sort((a,b)=>a-b).forEach(v=>{if(n[v]>bc){best=v;bc=n[v];}});
  return best;
}
const adjRightsActive=f=>(RIGHTS[f.id]||[]).find(r=>!r.superseded_at)||null;
const adjRightsHistory=f=>RIGHTS[f.id]||[];
/* Which tier to propose:
   · Nothing stored yet → the tier IN EFFECT now (or, if none is in effect
     yet, the one starting next Fall). An adjunct already past 3 years still
     gets their 9-month rights for the current appointment first; the 2-year
     rights follow as an upgrade. Establishing straight to 2-year would leave
     the current year with no rights at all.
   · 9-month stored and 2-year eligibility reached → the 2-year tier (an
     upgrade, effective the Fall it starts).
   · Otherwise the stored tier, so a drift check compares like with like. */
function pickRightsTier(f,c){
  const has=t=>t&&t.elig!=null;
  const eff9=has(c.t9)&&inEffect(c.t9.eff), eff2=has(c.t2)&&inEffect(c.t2.eff);
  const active=adjRightsActive(f);
  if(active&&active.tier==='9mo'&&has(c.t2))return '2yr';
  if(active&&(active.tier==='2yr'||active.tier==='9mo'))return active.tier;
  if(eff2)return '2yr';
  if(eff9)return '9mo';
  if(has(c.t9))return '9mo';
  if(has(c.t2))return '2yr';
  return null;
}
function adjRightsCalc(f,wantTier){
  const key=f.id+'|'+(wantTier||'');
  if(RT[key])return RT[key];
  const save=r=>(RT[key]=r);
  const ci=adjContractInfo(f), c=ci.calc;
  if(!ci.type&&!c.type)return save({status:'unknown',lines:[c.lines[0]||'Can\'t determine contract type.']});
  if(c.reset)return save({status:'none',reason:'break',lines:['No assignment rights — break in service. Re-established with the next qualifying appointment.']});
  if(ci.manual){
    if(ci.type==='term')return save({status:'none',reason:'term',lines:['Term-by-term (set manually) — no assignment rights.']});
    if(ci.type!==c.type)return save({status:'manual',tier:ci.type,lines:[`Contract type is set manually (${contractLabel(ci.type)}); the calculation can't supply its basis. Enter the rights by hand.`]});
  }
  if(c.pre2014)return save({status:'manual',tier:'pre2014',lines:['Hired before Sept 16, 2014: rights are the greater of 2 courses or the AY14-15/AY15-16 average, which predate Converge. Enter by hand.']});
  const tier=wantTier||pickRightsTier(f,c);
  const t=tier==='2yr'?c.t2:tier==='9mo'?c.t9:null;
  if(!t||t.elig==null)return save({status:'none',reason:'term',lines:['Term-by-term — no assignment rights yet.']});
  const floor=tier==='2yr'?2:1;
  if(t.elig===-1)return save({status:'manual',tier,lines:[`Eligible for ${contractLabel(tier)} before Converge's term history began, so the eligibility window can't be measured. Enter by hand.`]});
  const d=adjCreditLoadDetail(f);
  // Window bounds and length.
  // Window starts at the first term that hadn't ended by the service start
  // (a hire date between terms belongs to the term that follows it).
  const ss=c.serviceStart;
  const fromIdx=(TERM_SEQ.length&&TERM_SEQ[0].start_date&&ss<String(TERM_SEQ[0].start_date).slice(0,10))?-1
    :TERM_SEQ.findIndex(t=>String(t.end_date||t.start_date||'').slice(0,10)>=ss);
  if(fromIdx<0)return save({status:'manual',tier,lines:[`Service starts (${fmtDate(c.serviceStart)}) before Converge's term history, so the eligibility window can't be measured. Enter by hand.`]});
  const lastIdx=t.by==='time'?t.elig-1:t.elig;
  let ays=t.years;
  if(t.by==='credits'){
    const a0=AY_SEQ.indexOf(TERM_SEQ[fromIdx].academic_year), a1=AY_SEQ.indexOf(TERM_SEQ[t.elig].academic_year);
    ays=Math.max(1,a1-a0+1);
  }
  const inWin=d.items.filter(x=>x.i<=lastIdx);
  const winCr=r1(inWin.reduce((s,x)=>s+x.eff,0));
  const avg=r1(winCr/ays);
  let size=modeSmallest(inWin.map(x=>x.cr)), sizeNote='';
  if(size==null){size=modeSmallest(d.items.map(x=>x.cr));sizeNote=size!=null?' (from all counted teaching — none in the window)':'';}
  if(size==null){size=ADJ_DEFAULT_COURSE;sizeNote=` (assumed — no courses with fixed credits on record)`;}
  const floorCr=floor*size;
  const base=Math.max(floorCr,avg);
  const min=Math.ceil(base/size-1e-9)*size;
  const effTerm=t.eff==='pre'||t.eff==null?null:TERM_SEQ[t.eff].code;
  const winTo=lastIdx>=fromIdx?TERM_SEQ[lastIdx].code:TERM_SEQ[fromIdx].code;
  const lines=[
    `${contractLabel(tier)}: eligible by ${t.by==='credits'?'credits':'time'} (${t.why}).`,
    `Window ${termLabel(TERM_SEQ[fromIdx].code)} – ${termLabel(winTo)}: ${winCr} cr over ${ays} AY${ays===1?'':'s'} = ${avg} cr/AY average.`,
    `Floor: ${floor} course${floor>1?'s':''} × ${size} cr${sizeNote} = ${floorCr} cr.`,
    `Greater of the two: ${r1(base)} cr`+(min!==base?` → rounded up to whole courses = ${min} cr.`:'.'),
    `Applies from ${fallLabel(t.eff)}.`
  ];
  if(d.flagged.length)lines.push(`Provisional: ${d.flagged.length} course(s) with ranged/blank credits aren't counted.`);
  return save({status:'calc',tier,lines,row:{
    tier, effective_term:effTerm,
    window_from_term:TERM_SEQ[fromIdx].code, window_to_term:winTo,
    window_credits:winCr, window_ays:ays, avg_annual:avg,
    floor_courses:floor, course_size:size, min_credits:r1(min)
  },effPending:t.eff==null});
}
/* Rights that GOVERN a given academic year. A 2-year row established now
   that starts next Fall doesn't change this year: the row in force is the
   one with the latest effective term on or before the AY's Fall (ties → the
   most recently established, i.e. a correction wins). A row retired for a
   break in service (superseded with nothing after it) stops applying to AYs
   that begin after it was retired. */
const tKey=code=>{const i=code?termIdx(code):-1;return i;};   // -1 = before history
function adjRightsForAY(f,ay){
  const rows=RIGHTS[f.id]||[];
  if(!rows.length||!ay)return null;
  const ayTerms=TERM_SEQ.filter(t=>t.academic_year===ay);
  if(!ayTerms.length)return null;
  const ayEnd=termIdx(ayTerms[ayTerms.length-1].code);
  const elig=rows.filter(r=>tKey(r.effective_term)<=ayEnd);
  if(!elig.length)return null;
  elig.sort((a,b)=>(tKey(b.effective_term)-tKey(a.effective_term))||String(b.established_at).localeCompare(String(a.established_at)));
  const r=elig[0];
  if(r.superseded_at){
    const replaced=rows.some(x=>x!==r&&String(x.established_at)>=String(r.superseded_at).slice(0,19));
    const ayStart=String(ayTerms[0].start_date||'').slice(0,10);
    if(!replaced&&ayStart&&ayStart>String(r.superseded_at).slice(0,10))return null;   // retired
  }
  return r;
}

/* What, if anything, needs doing about this adjunct's stored rights.
   action:
     ok        stored rights in place and consistent with the calculation
     drift     stored rights in place, but the calculation now differs
               (informational — rights are constant once established)
     establish no stored rights; calculated rights ready to save
     upgrade   stored 9-month rights; calculated 2-year rights ready
     retire    stored rights, but a break in service has ended them
     manual    rights needed but can't be calculated — enter by hand
     none      no rights apply (term-by-term)
     unknown   can't tell (no start date / term dates) */
function adjRightsInfo(f){
  const active=adjRightsActive(f), p=adjRightsCalc(f);
  let action;
  if(p.status==='unknown')action=active?'ok':'unknown';
  else if(p.status==='none')action=active?(p.reason==='break'?'retire':'ok'):'none';
  else if(p.status==='manual')action=active?'ok':'manual';
  else if(!active)action='establish';
  else if(active.tier==='9mo'&&p.tier==='2yr')action='upgrade';
  else if(!active.is_override&&active.tier===p.tier&&+active.min_credits!==+p.row.min_credits)action='drift';
  else action='ok';
  return {active,calc:p,action};
}
/* Credits assigned in an academic year (Fall–Spring; summer excluded, as it
   is from the rights calculation), co-taught ÷ 2. Includes future terms, so
   it works for planning next year. */
function adjAssigned(f,ay){
  const out={total:0,byTerm:{},items:[],flagged:[]};
  (TEACHING[f.id]||[]).forEach(o=>{
    const t=TERM_MAP[o.term];
    if(!t||t.academic_year!==ay||isSummerTerm(t))return;
    const c=COURSES[o.course_id], cr=parseCredits(c&&c.credits);
    if(cr===null){out.flagged.push(`${termLabel(t.code)} ${courseName(c)}`);return;}
    const two=!!(o.instructor1_id&&o.instructor2_id), eff=two?cr/2:cr;
    out.total+=eff; out.byTerm[t.code]=(out.byTerm[t.code]||0)+eff;
    out.items.push({term:t.code,name:courseName(c),cr,eff,two});
  });
  out.total=r1(out.total);
  return out;
}

/* ─── EXPORTS ──────────────────────────────────────────────────── */
const API={
  setData,localISODate,
  ADJ_CAT,ADJ_WINDOW,ADJ_BREAK_TERMS,ADJ_EVAL_ASSUMED,CONTRACT_TYPES,
  termIdx,termLabel,isPSUAdj,isInactive,adjNoStart,isSummerTerm,isFallTerm,parseCredits,
  adjCurrent,adjCurrentTitle,adjCreditLoadDetail,adjCreditLoad,
  contractTier,contractLabel,adjContractCalc,adjContractInfo,adjContract,
  adjReviewInfo,adjReviewEligible,adjRanking,adjApptOrder,
  adjRightsActive,adjRightsHistory,adjRightsCalc,adjRightsInfo,adjRightsForAY,adjAssigned,
  // read-only views of state, for pickers and labels
  terms:()=>TERM_SEQ.slice(), academicYears:()=>AY_SEQ.slice(),
  currentTerm:()=>CUR_TERM_IDX>=0?TERM_SEQ[CUR_TERM_IDX].code:null
};
window.ConvergeAdj=API;
// Historical global names (see header). Skips the namespace-only helpers.
['ADJ_CAT','ADJ_WINDOW','termLabel','isPSUAdj','adjNoStart','adjCurrent','adjCurrentTitle',
 'adjCreditLoadDetail','adjCreditLoad','contractTier','contractLabel','adjContractCalc',
 'adjContractInfo','adjContract','adjReviewInfo','adjReviewEligible','adjRanking','adjApptOrder',
 'adjRightsActive','adjRightsHistory','adjRightsCalc','adjRightsInfo','adjRightsForAY','adjAssigned'
].forEach(k=>{window[k]=API[k];});
})();
