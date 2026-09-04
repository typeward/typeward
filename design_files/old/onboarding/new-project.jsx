// New project creation screens — both directions.

// ───────────────────────── Inline icons ─────────────────────────
const NP_ICONS = {
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18 M6 6l12 12",
  arrow: "M5 12h14 M13 5l7 7-7 7",
  back: "M19 12H5 M11 19l-7-7 7-7",
  spark: "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2 2 M16.4 16.4l2 2 M5.6 18.4l2-2 M16.4 7.6l2-2",
  cal: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 10h18 M8 3v4 M16 3v4",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  book: "M19 21V4a1 1 0 0 0-1-1H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13",
  doc: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6",
  list: "M21 12h-6 M21 18h-6 M21 6h-6 M9 9V5l-3 0 M9 9V5h6 M9 17v-4l-3 0 M9 17v-4h6",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6 M8 13h8 M8 17h6",
  flag: "M4 21V4 M4 4h12l-2 4 2 4H4",
  tag: "M20 12l-8 8a2 2 0 0 1-3 0L2 13a2 2 0 0 1 0-3l8-8h7a2 2 0 0 1 2 2v7a2 2 0 0 1-1 1z M7 7h.01",
  plus: "M12 5v14 M5 12h14",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  sparkles: "M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7z",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 9l5-5 5 5 M12 4v12",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  paste: "M9 3h6a2 2 0 0 1 2 2v0H7v0a2 2 0 0 1 2-2z M7 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2",
  folder: "M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  folderPlus: "M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M12 11v6 M9 14h6",
  globe: "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20",
  rocket: "M14 14l-4 4 M5 19l3-3 M16 4l4 4-9 9-4 1 1-4z M11 7l6 6",
  star: "M12 2l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z",
  clock: "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z M12 6v6l4 2",
  shield: "M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z",
  refresh: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5",
};
const NIc = ({ n, s = 14, w = 1.7, c = "currentColor", style }) => {
  const d = NP_ICONS[n] || NP_ICONS["check"];
  const ps = d.split(/\s(?=M)/);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={{display:'inline-block',flexShrink:0,...(style||{})}} aria-hidden="true">
      {ps.map((p,i)=><path key={i} d={p} />)}
    </svg>
  );
};

// ───────────────────────── Shared data ─────────────────────────
const NP_FORMATS = [
  { id:'latex',    name:'LaTeX',      glyph:'τ', desc:'Academic & math typesetting',     color:'#A78BFA' },
  { id:'typst',    name:'Typst',      glyph:'§', desc:'Modern markup, fast compile',     color:'#67E8F9' },
  { id:'markdown', name:'Markdown',   glyph:'#', desc:'Plain text with structure',       color:'#F0ABFC' },
  { id:'rmd',      name:'R Markdown', glyph:'R', desc:'Reproducible R reports',          color:'#34D399' },
  { id:'quarto',   name:'Quarto',     glyph:'Q', desc:'Multi-language scientific docs',  color:'#FBBF24' },
];

const NP_TEMPLATES = [
  { id:'icml',    name:'ICML 2026',          group:'ML conferences',  pages:'8 + refs', glyph:'τ', color:'#A78BFA', popular:true },
  { id:'neurips', name:'NeurIPS 2025',       group:'ML conferences',  pages:'9 + refs', glyph:'τ', color:'#A78BFA' },
  { id:'iclr',    name:'ICLR 2026',          group:'ML conferences',  pages:'10 + refs', glyph:'τ', color:'#A78BFA' },
  { id:'ieee',    name:'IEEE Transactions',  group:'Engineering',     pages:'flexible', glyph:'τ', color:'#67E8F9' },
  { id:'acmart',  name:'ACM acmart',         group:'CS conferences',  pages:'flexible', glyph:'τ', color:'#67E8F9' },
  { id:'lncs',    name:'Springer LNCS',      group:'Proceedings',     pages:'12 + refs', glyph:'τ', color:'#67E8F9' },
  { id:'arxiv',   name:'arXiv preprint',     group:'Preprint',        pages:'unlimited', glyph:'τ', color:'#F0ABFC' },
  { id:'thesis',  name:'PhD thesis (book)',  group:'Thesis',          pages:'long-form', glyph:'τ', color:'#FBBF24' },
  { id:'beamer',  name:'Beamer slides',      group:'Talks',           pages:'slides',    glyph:'τ', color:'#FB7185' },
  { id:'quarto',  name:'Quarto article',     group:'Quarto',          pages:'flexible',  glyph:'Q', color:'#FBBF24' },
  { id:'pandoc',  name:'Pandoc article',     group:'Markdown',        pages:'flexible',  glyph:'#', color:'#F0ABFC' },
  { id:'blank',   name:'Blank document',     group:'Start fresh',     pages:'—',         glyph:'∅', color:'#9CA3AF' },
];

// ───────────────────────── Direction A — Workshop ─────────────────────────

function NPWorkshopChrome({ step, totalSteps, accent, children, footerLeft, footerRight }) {
  const stepNames = ['Format','Template','Details','Deadline','Citations','Drafting','Review'];
  return (
    <div style={{
      width:'100%', height:'100%', position:'relative',
      background:'#0A0B0F', color:'#E6E8EC', fontFamily:"'Inter',system-ui,sans-serif",
      borderRadius:18, overflow:'hidden',
    }}>
      <div style={{position:'absolute',inset:0,overflow:'hidden',pointerEvents:'none'}}>
        <div style={{position:'absolute',width:540,height:540,left:-160,top:-200,borderRadius:'50%',background:`radial-gradient(circle, ${accent.a} 0%, transparent 65%)`,filter:'blur(100px)',opacity:0.55}} />
        <div style={{position:'absolute',width:560,height:560,right:-180,top:-100,borderRadius:'50%',background:`radial-gradient(circle, ${accent.b} 0%, transparent 65%)`,filter:'blur(100px)',opacity:0.45}} />
        <div style={{position:'absolute',width:420,height:420,left:'40%',bottom:-180,borderRadius:'50%',background:`radial-gradient(circle, ${accent.c} 0%, transparent 65%)`,filter:'blur(100px)',opacity:0.35}} />
      </div>
      <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',padding:32}}>
        <div style={{
          width:780, maxWidth:'100%', borderRadius:18,
          background:'rgba(15,17,22,0.74)', border:'1px solid rgba(255,255,255,0.07)',
          backdropFilter:'blur(28px) saturate(140%)', WebkitBackdropFilter:'blur(28px) saturate(140%)',
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 80px rgba(0,0,0,0.55)',
          overflow:'hidden', display:'flex', flexDirection:'column',
        }}>
          <div style={{height:54, padding:'0 22px', display:'flex', alignItems:'center', borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
            <div style={{width:24,height:24,borderRadius:7,background:`linear-gradient(135deg, ${accent.b}, ${accent.a})`,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700,fontSize:11}}>τ</div>
            <span style={{marginLeft:10,fontSize:13,fontWeight:600,letterSpacing:'-0.01em'}}>New project</span>
            <span style={{marginLeft:10,fontSize:11,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace"}}>· step {step+1} of {totalSteps}</span>
            <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:5}}>
              {stepNames.slice(0,totalSteps).map((n,i)=>{
                const done=i<step, cur=i===step;
                return (
                  <div key={i} style={{display:'flex',alignItems:'center',gap:5}}>
                    <div style={{width:cur?18:7,height:7,borderRadius:3.5,background:cur?`linear-gradient(90deg, ${accent.a}, ${accent.b})`:done?accent.b:'rgba(255,255,255,0.10)',transition:'all .2s'}} />
                    {i<totalSteps-1 && <div style={{width:10,height:1,background:'rgba(255,255,255,0.08)'}} />}
                  </div>
                );
              })}
            </div>
            <button style={{marginLeft:12,width:24,height:24,borderRadius:6,background:'transparent',border:'0',color:'#6B7280',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}><NIc n="x" s={12} /></button>
          </div>
          <div style={{flex:1, position:'relative', overflow:'auto'}}>{children}</div>
          <div style={{height:60, padding:'0 22px', display:'flex', alignItems:'center', borderTop:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.18)'}}>
            <div style={{fontSize:11.5,color:'#9CA3AF'}}>{footerLeft}</div>
            <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8}}>{footerRight}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WBtn({ children, primary, accent, icon, ...rest }) {
  return (
    <button {...rest} style={{
      height:34, padding:'0 16px', borderRadius:9,
      border: primary ? '0' : '1px solid rgba(255,255,255,0.10)',
      background: primary ? `linear-gradient(135deg, ${accent.a}, ${accent.b})` : 'rgba(255,255,255,0.04)',
      color: primary?'#fff':'#E6E8EC', fontSize:12.5, fontWeight: primary?600:500,
      display:'flex', alignItems:'center', gap:7, cursor:'pointer',
      boxShadow: primary?`0 0 0 1px ${accent.a}40, 0 8px 26px ${accent.a}33`:'inset 0 1px 0 rgba(255,255,255,0.04)',
      ...(rest.style||{}),
    }}>{children}{icon && <NIc n={icon} s={12} w={2.2} />}</button>
  );
}
const wBack = (accent) => (
  <button style={{height:30,padding:'0 13px',borderRadius:8,background:'transparent',color:'#9CA3AF',border:'1px solid rgba(255,255,255,0.08)',fontSize:11.5,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}><NIc n="back" s={11} />Back</button>
);

// Step 1 — Format (Workshop)
function NPWFormat({ accent }) {
  const picked = 'latex';
  return (
    <NPWorkshopChrome step={0} totalSteps={7} accent={accent}
      footerLeft={<span>Selected: <span style={{color:'#E6E8EC',fontWeight:500}}>LaTeX</span> · we'll use TeX Live</span>}
      footerRight={<WBtn primary accent={accent} icon="arrow">Continue</WBtn>}
    >
      <div style={{padding:'28px 22px 24px'}}>
        <h2 style={{fontSize:22,fontWeight:600,letterSpacing:'-0.02em',margin:'0 0 6px',textWrap:'balance'}}>Start with a <span style={{background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`,WebkitBackgroundClip:'text',backgroundClip:'text',color:'transparent'}}>format</span></h2>
        <p style={{fontSize:12.5,color:'#9CA3AF',margin:'0 0 22px'}}>Each format has its own engine — you can mix freely later.</p>

        <div style={{display:'grid',gridTemplateColumns:'repeat(5, 1fr)',gap:9}}>
          {NP_FORMATS.map(f=>{
            const on = f.id===picked;
            return (
              <div key={f.id} style={{
                position:'relative', padding:'16px 12px 14px', borderRadius:11,
                background: on?'rgba(255,255,255,0.05)':'rgba(255,255,255,0.02)',
                border: on?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',
                boxShadow: on?`0 0 0 1px ${accent.a}33, 0 8px 24px ${accent.a}1A`:'none',
                cursor:'pointer', textAlign:'center', transition:'all .15s',
              }}>
                <div style={{
                  width:46, height:46, borderRadius:11, margin:'0 auto 10px',
                  background:`linear-gradient(135deg, ${f.color}33, ${f.color}11)`, border:`1px solid ${f.color}33`,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:24, fontFamily:"'Times New Roman',serif", fontStyle:'italic', color:f.color, fontWeight:600,
                }}>{f.glyph}</div>
                <div style={{fontSize:12.5,fontWeight:600}}>{f.name}</div>
                <div style={{fontSize:10,color:'#9CA3AF',marginTop:3,lineHeight:1.4,minHeight:28}}>{f.desc}</div>
                {on && <div style={{position:'absolute',top:8,right:8,width:14,height:14,borderRadius:'50%',background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`,display:'flex',alignItems:'center',justifyContent:'center'}}><NIc n="check" s={9} w={3} c="#fff" /></div>}
              </div>
            );
          })}
        </div>

        <div style={{marginTop:18,padding:'12px 14px',borderRadius:10,background:'rgba(167,139,250,0.06)',border:'1px solid rgba(167,139,250,0.18)',display:'flex',gap:10,alignItems:'flex-start'}}>
          <NIc n="zap" s={13} c={accent.a} style={{marginTop:1}} />
          <div style={{fontSize:11.5,color:'#D8B4FE',lineHeight:1.5,textWrap:'pretty'}}>
            <span style={{fontWeight:600,color:'#E9D5FF'}}>Not sure? </span>
            LaTeX is the default for academic papers. Pick Markdown for blog posts and notes; Typst is great if you want fast compile times.
          </div>
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// Step 2 — Template (Workshop)
function NPWTemplate({ accent }) {
  const picked='icml';
  const groups = ['All','ML conferences','CS conferences','Engineering','Thesis','Preprint','Talks','Markdown'];
  return (
    <NPWorkshopChrome step={1} totalSteps={7} accent={accent}
      footerLeft={<span>Template: <span style={{color:'#E6E8EC',fontWeight:500}}>ICML 2026</span> · 8 pages + refs</span>}
      footerRight={<>{wBack(accent)}<WBtn primary accent={accent} icon="arrow">Continue</WBtn></>}
    >
      <div style={{padding:'24px 22px 22px'}}>
        <h2 style={{fontSize:20,fontWeight:600,letterSpacing:'-0.015em',margin:'0 0 4px'}}>Pick a template</h2>
        <p style={{fontSize:12,color:'#9CA3AF',margin:'0 0 14px'}}>Pre-configured class file, fonts, and layout. You can always change later.</p>

        <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
          {groups.map((g,i)=>(
            <button key={i} style={{
              height:26, padding:'0 11px', borderRadius:13,
              background: i===0?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:'rgba(255,255,255,0.04)',
              color: i===0?'#fff':'#9CA3AF', fontSize:11, fontWeight: i===0?600:500,
              border: i===0?'0':'1px solid rgba(255,255,255,0.06)', cursor:'pointer',
            }}>{g}</button>
          ))}
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(3, 1fr)',gap:9,maxHeight:268,overflow:'auto'}}>
          {NP_TEMPLATES.map(t=>{
            const on = t.id===picked;
            return (
              <div key={t.id} style={{
                position:'relative', borderRadius:10, padding:'12px 12px 10px',
                background: on?'rgba(255,255,255,0.05)':'rgba(255,255,255,0.025)',
                border: on?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',
                boxShadow: on?`0 0 0 1px ${accent.a}33`:'none', cursor:'pointer',
              }}>
                {t.popular && <div style={{position:'absolute',top:-6,right:10,padding:'2px 7px',borderRadius:5,background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`,fontSize:9,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'#fff'}}>Popular</div>}
                <div style={{display:'flex',alignItems:'center',gap:9}}>
                  <div style={{
                    width:30, height:38, borderRadius:4, flexShrink:0,
                    background:'#FBFAF6', position:'relative', overflow:'hidden',
                    boxShadow:'0 1px 3px rgba(0,0,0,0.4)',
                  }}>
                    <div style={{position:'absolute',top:4,left:4,right:4,height:2,background:'#1F2937'}} />
                    <div style={{position:'absolute',top:8,left:4,right:4,height:1,background:'#9CA3AF'}} />
                    <div style={{position:'absolute',top:12,left:4,right:8,height:1,background:'#9CA3AF'}} />
                    <div style={{position:'absolute',top:15,left:4,right:6,height:1,background:'#9CA3AF'}} />
                    <div style={{position:'absolute',top:20,left:4,right:8,height:1,background:'#9CA3AF'}} />
                    <div style={{position:'absolute',top:23,left:4,right:5,height:1,background:'#9CA3AF'}} />
                    <div style={{position:'absolute',top:26,left:4,right:9,height:1,background:'#9CA3AF'}} />
                    <div style={{position:'absolute',top:30,left:4,right:7,height:1,background:'#9CA3AF'}} />
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{t.name}</div>
                    <div style={{fontSize:10,color:'#6B7280',marginTop:1}}>{t.group}</div>
                    <div style={{fontSize:10,color:'#9CA3AF',fontFamily:"'JetBrains Mono',monospace",marginTop:3}}>{t.pages}</div>
                  </div>
                  {on && <div style={{width:14,height:14,borderRadius:'50%',background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}><NIc n="check" s={9} w={3} c="#fff" /></div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// Step 3 — Metadata (Workshop)
function NPWMetadata({ accent }) {
  return (
    <NPWorkshopChrome step={2} totalSteps={7} accent={accent}
      footerLeft={<span>Title and abstract help us suggest an outline later</span>}
      footerRight={<>{wBack(accent)}<WBtn primary accent={accent} icon="arrow">Continue</WBtn></>}
    >
      <div style={{padding:'24px 22px 22px'}}>
        <h2 style={{fontSize:20,fontWeight:600,letterSpacing:'-0.015em',margin:'0 0 4px'}}>Project details</h2>
        <p style={{fontSize:12,color:'#9CA3AF',margin:'0 0 18px'}}>The basics — you can edit any of this from <span style={{fontFamily:"'JetBrains Mono',monospace",color:'#D1D5DB'}}>Settings → Project</span> later.</p>

        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div>
            <label style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500}}>Title</label>
            <div style={{marginTop:5,height:36,padding:'0 12px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:`1px solid ${accent.a}55`,boxShadow:`0 0 0 3px ${accent.a}1A`,display:'flex',alignItems:'center',fontSize:13,color:'#E6E8EC'}}>
              On the Asymptotic Behavior of Stochastic Gradient Flows
              <span style={{display:'inline-block',width:1.5,height:14,background:accent.a,marginLeft:2,animation:'onbblink 1s steps(1) infinite'}} />
            </div>
          </div>

          <div>
            <label style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500}}>Abstract <span style={{color:'#6B7280',textTransform:'none',letterSpacing:0}}>· optional</span></label>
            <div style={{marginTop:5,minHeight:74,padding:'9px 12px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)',fontSize:12.5,color:'#D1D5DB',lineHeight:1.55,textWrap:'pretty'}}>
              We study the long-time behavior of solutions to a stochastic differential equation governing gradient flows under additive Brownian noise, establishing exponential convergence to the Gibbs equilibrium under a logarithmic Sobolev inequality.
            </div>
            <div style={{marginTop:4,fontSize:10,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace",display:'flex',gap:10}}>
              <span>248 / 2000 chars</span>
              <span style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:4,color:accent.b}}><NIc n="sparkles" s={10} c={accent.b} />good for outline generation</span>
            </div>
          </div>

          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <div>
              <label style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500}}>Authors</label>
              <div style={{marginTop:5,minHeight:36,padding:'5px 6px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
                {[{n:'M. Sokol',c:'#0EA5E9'},{n:'A. Khanna',c:'#8B5CF6'},{n:'J. Tashiro',c:'#F59E0B'}].map((a,i)=>(
                  <div key={i} style={{display:'flex',alignItems:'center',gap:5,height:24,padding:'0 8px 0 4px',borderRadius:12,background:'rgba(255,255,255,0.06)',fontSize:11.5}}>
                    <div style={{width:18,height:18,borderRadius:'50%',background:`linear-gradient(135deg,${a.c},${a.c}aa)`,fontSize:9,fontWeight:600,display:'flex',alignItems:'center',justifyContent:'center'}}>{a.n[0]}</div>
                    {a.n}
                  </div>
                ))}
                <button style={{height:24,width:24,borderRadius:6,background:'transparent',border:'1px dashed rgba(255,255,255,0.15)',color:'#6B7280',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}><NIc n="plus" s={11} /></button>
              </div>
            </div>
            <div>
              <label style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500}}>Journal / venue</label>
              <div style={{marginTop:5,height:36,padding:'0 12px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)',display:'flex',alignItems:'center',gap:8,fontSize:12.5}}>
                <NIc n="book" s={12} c="#9CA3AF" />
                <span>ICML 2026</span>
                <span style={{marginLeft:'auto',fontSize:10,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace"}}>auto-detected</span>
              </div>
            </div>
          </div>

          <div>
            <label style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500}}>Keywords <span style={{color:'#6B7280',textTransform:'none',letterSpacing:0}}>· optional</span></label>
            <div style={{marginTop:5,minHeight:32,padding:'4px 6px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
              {['stochastic gradient','convergence','Wasserstein','log-Sobolev'].map((k,i)=>(
                <div key={i} style={{height:22,padding:'0 9px',borderRadius:11,background:`${accent.a}1A`,border:`1px solid ${accent.a}33`,fontSize:11,color:'#C4B5FD',display:'flex',alignItems:'center'}}>{k}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// Step 4 — Deadline (Workshop)
function NPWDeadline({ accent }) {
  const days = [...Array(35)].map((_,i)=>i-2); // grid offsets
  const today = 7, picked = 22, deadline = 'Apr 24';
  return (
    <NPWorkshopChrome step={3} totalSteps={7} accent={accent}
      footerLeft={<span>Deadline: <span style={{color:'#E6E8EC',fontWeight:500}}>{deadline}, 23:59 UTC</span> · 22 days from today</span>}
      footerRight={<>{wBack(accent)}<WBtn primary accent={accent} icon="arrow">Continue</WBtn></>}
    >
      <div style={{padding:'24px 22px 22px'}}>
        <h2 style={{fontSize:20,fontWeight:600,letterSpacing:'-0.015em',margin:'0 0 4px'}}>When is it due?</h2>
        <p style={{fontSize:12,color:'#9CA3AF',margin:'0 0 18px'}}>We'll show countdowns on the editor. You can change or remove the deadline anytime.</p>

        <div style={{display:'grid',gridTemplateColumns:'1fr 220px',gap:18}}>
          {/* Calendar */}
          <div style={{borderRadius:12,background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)',padding:'14px 14px 16px'}}>
            <div style={{display:'flex',alignItems:'center',marginBottom:10}}>
              <button style={{width:24,height:24,borderRadius:6,background:'rgba(255,255,255,0.04)',border:'0',color:'#9CA3AF',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}><NIc n="back" s={11} /></button>
              <span style={{flex:1,textAlign:'center',fontSize:13,fontWeight:600}}>April 2026</span>
              <button style={{width:24,height:24,borderRadius:6,background:'rgba(255,255,255,0.04)',border:'0',color:'#9CA3AF',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',transform:'rotate(180deg)'}}><NIc n="back" s={11} /></button>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,fontSize:10,color:'#6B7280',marginBottom:6,textAlign:'center',fontFamily:"'JetBrains Mono',monospace"}}>
              {['S','M','T','W','T','F','S'].map((d,i)=><div key={i}>{d}</div>)}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:3}}>
              {days.map((d,i)=>{
                const day = d+1;
                const inMonth = day>=1 && day<=30;
                const isToday = day===today;
                const isPicked = day===picked;
                const past = day<today;
                return (
                  <div key={i} style={{
                    height:30, borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:11.5, fontWeight: isPicked||isToday?600:400,
                    color: !inMonth?'#374151':past?'#4B5563':isPicked?'#fff':'#D1D5DB',
                    background: isPicked?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:isToday?'rgba(255,255,255,0.06)':'transparent',
                    border: isToday&&!isPicked?`1px solid ${accent.b}66`:'0',
                    cursor: inMonth&&!past?'pointer':'default',
                    boxShadow: isPicked?`0 0 0 1px ${accent.a}55, 0 4px 12px ${accent.a}33`:'none',
                  }}>{inMonth?day:''}</div>
                );
              })}
            </div>
          </div>

          {/* Side */}
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{borderRadius:11,background:`linear-gradient(135deg, ${accent.a}1A, ${accent.b}0F)`,border:`1px solid ${accent.a}33`,padding:'12px 14px'}}>
              <div style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500}}>Deadline</div>
              <div style={{fontSize:22,fontWeight:600,letterSpacing:'-0.015em',marginTop:3}}>{deadline}</div>
              <div style={{fontSize:11,color:'#9CA3AF',fontFamily:"'JetBrains Mono',monospace",marginTop:1}}>Friday · 23:59 UTC</div>
              <div style={{marginTop:10,paddingTop:10,borderTop:'1px solid rgba(255,255,255,0.05)',display:'flex',alignItems:'center',gap:6,fontSize:11,color:'#D8B4FE'}}>
                <NIc n="clock" s={11} c={accent.a} />
                <span style={{fontWeight:600}}>22 days</span>
                <span style={{color:'#9CA3AF'}}>from today</span>
              </div>
            </div>

            <div style={{display:'flex',flexDirection:'column',gap:5}}>
              <div style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#6B7280',fontWeight:500,padding:'0 4px'}}>Quick set</div>
              {[{l:'2 weeks',d:'Apr 9'},{l:'1 month',d:'May 2'},{l:'End of quarter',d:'Jun 30'},{l:'No deadline',d:'remove'}].map((q,i)=>(
                <button key={i} style={{height:30,padding:'0 12px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',color:'#D1D5DB',fontSize:11.5,cursor:'pointer',display:'flex',alignItems:'center',gap:8}}>
                  {q.l}
                  <span style={{marginLeft:'auto',fontSize:10,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace"}}>{q.d}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// Step 5 — Citations (Workshop)
function NPWCitations({ accent }) {
  const picked='zotero';
  const styles=['ACM','IEEE','APA','Chicago','Nature','Plain'];
  return (
    <NPWorkshopChrome step={4} totalSteps={7} accent={accent}
      footerLeft={<span>Source: <span style={{color:'#E6E8EC',fontWeight:500}}>Zotero · Stochastic-Flows collection</span> · 142 entries</span>}
      footerRight={<>{wBack(accent)}<WBtn primary accent={accent} icon="arrow">Continue</WBtn></>}
    >
      <div style={{padding:'24px 22px 22px'}}>
        <h2 style={{fontSize:20,fontWeight:600,letterSpacing:'-0.015em',margin:'0 0 4px'}}>Bibliography</h2>
        <p style={{fontSize:12,color:'#9CA3AF',margin:'0 0 18px'}}>Hook up where your citations come from. We'll auto-sync entries you cite.</p>

        <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:18}}>
          {[
            { id:'zotero', i:'link',   t:'Zotero',          d:'Live sync — recommended', meta:'2 collections · 142 entries' },
            { id:'bib',    i:'upload', t:'Import .bib file', d:'Upload an existing BibTeX', meta:'references.bib · 28 KB' },
            { id:'none',   i:'x',      t:'Skip for now',     d:'Add citations later from the editor', meta:null },
          ].map(o=>{
            const on = o.id===picked;
            return (
              <div key={o.id} style={{
                padding:'12px 14px', borderRadius:11,
                background: on?'rgba(255,255,255,0.05)':'rgba(255,255,255,0.025)',
                border: on?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',
                display:'flex', alignItems:'center', gap:12, cursor:'pointer',
                boxShadow: on?`0 0 0 1px ${accent.a}33`:'none',
              }}>
                <div style={{width:34,height:34,borderRadius:9,background: on?`linear-gradient(135deg, ${accent.a}33, ${accent.b}22)`:'rgba(255,255,255,0.04)',border: on?`1px solid ${accent.a}33`:'1px solid rgba(255,255,255,0.06)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <NIc n={o.i} s={15} c={on?accent.a:'#9CA3AF'} />
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600}}>{o.t}</div>
                  <div style={{fontSize:11.5,color:'#9CA3AF',marginTop:1}}>{o.d}</div>
                </div>
                {o.meta && <div style={{fontSize:10.5,color:'#9CA3AF',fontFamily:"'JetBrains Mono',monospace"}}>{o.meta}</div>}
                <div style={{width:18,height:18,borderRadius:'50%',flexShrink:0,background: on?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:'transparent',border: on?'0':'1.5px solid rgba(255,255,255,0.18)',display:'flex',alignItems:'center',justifyContent:'center'}}>{on && <NIc n="check" s={10} w={3} c="#fff" />}</div>
              </div>
            );
          })}
        </div>

        <div>
          <div style={{fontSize:10.5,letterSpacing:'0.06em',textTransform:'uppercase',color:'#9CA3AF',fontWeight:500,marginBottom:8}}>Citation style</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {styles.map((s,i)=>(
              <button key={s} style={{
                height:30, padding:'0 14px', borderRadius:8,
                background: i===0?`${accent.a}1A`:'rgba(255,255,255,0.03)',
                border: i===0?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',
                color: i===0?'#fff':'#D1D5DB', fontSize:12, fontWeight: i===0?600:500, cursor:'pointer',
                boxShadow: i===0?`0 0 0 1px ${accent.a}33`:'none',
              }}>{s}</button>
            ))}
            <button style={{height:30,padding:'0 12px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px dashed rgba(255,255,255,0.15)',color:'#9CA3AF',fontSize:12,cursor:'pointer',display:'flex',alignItems:'center',gap:5}}>
              <NIc n="plus" s={10} />Custom .csl
            </button>
          </div>
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// Step 6 — Drafting mode (Workshop)
function NPWDrafting({ accent }) {
  const picked='ai';
  return (
    <NPWorkshopChrome step={5} totalSteps={7} accent={accent}
      footerLeft={<span style={{display:'flex',alignItems:'center',gap:5}}><NIc n="sparkles" s={11} c={accent.b} />Outline ready · ~6 sections including Abstract</span>}
      footerRight={<>{wBack(accent)}<WBtn primary accent={accent} icon="arrow">Continue</WBtn></>}
    >
      <div style={{padding:'24px 22px 22px'}}>
        <h2 style={{fontSize:20,fontWeight:600,letterSpacing:'-0.015em',margin:'0 0 4px'}}>How do you want to start?</h2>
        <p style={{fontSize:12,color:'#9CA3AF',margin:'0 0 18px'}}>We'll pre-populate the editor with whichever you choose.</p>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:9,marginBottom:16}}>
          {[
            { id:'ai',    i:'sparkles', t:'AI outline',  d:'From your title + abstract' },
            { id:'tpl',   i:'list',     t:'Template structure', d:'Sections per ICML 2026' },
            { id:'blank', i:'edit',     t:'Blank',       d:'Just preamble + \\begin{document}' },
            { id:'paste', i:'paste',    t:'Paste existing', d:'Drop in a .tex / .md file' },
          ].slice(0,3).map(o=>{
            const on = o.id===picked;
            return (
              <div key={o.id} style={{
                padding:'14px 14px 13px', borderRadius:11,
                background: on?'rgba(255,255,255,0.05)':'rgba(255,255,255,0.025)',
                border: on?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',
                cursor:'pointer',
                boxShadow: on?`0 0 0 1px ${accent.a}33`:'none',
              }}>
                <div style={{width:30,height:30,borderRadius:8,background: on?`linear-gradient(135deg, ${accent.a}33, ${accent.b}22)`:'rgba(255,255,255,0.04)',border: on?`1px solid ${accent.a}33`:'1px solid rgba(255,255,255,0.06)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:9}}>
                  <NIc n={o.i} s={14} c={on?accent.a:'#9CA3AF'} />
                </div>
                <div style={{fontSize:13,fontWeight:600}}>{o.t}</div>
                <div style={{fontSize:11,color:'#9CA3AF',marginTop:2,lineHeight:1.4}}>{o.d}</div>
              </div>
            );
          })}
        </div>

        {/* Outline preview when AI picked */}
        <div style={{borderRadius:11,background:'rgba(0,0,0,0.22)',border:'1px solid rgba(255,255,255,0.05)',overflow:'hidden'}}>
          <div style={{height:32,padding:'0 14px',display:'flex',alignItems:'center',gap:7,borderBottom:'1px solid rgba(255,255,255,0.05)',fontSize:11,color:'#9CA3AF'}}>
            <NIc n="sparkles" s={11} c={accent.b} />
            <span style={{fontWeight:600,color:'#E6E8EC'}}>Suggested outline</span>
            <span style={{color:'#6B7280'}}>· based on your abstract</span>
            <button style={{marginLeft:'auto',height:22,padding:'0 8px',borderRadius:5,background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.06)',color:'#9CA3AF',fontSize:10.5,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}><NIc n="refresh" s={9} />Regenerate</button>
          </div>
          <div style={{padding:'10px 14px',display:'flex',flexDirection:'column',gap:5,fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
            {[
              { n:'§', t:'Abstract', s:'2-sentence overview · log-Sobolev framing' },
              { n:'§ 1', t:'Introduction', s:'motivation, contributions, related work' },
              { n:'§ 2', t:'Preliminaries', s:'SDE notation, LSI, relative entropy' },
              { n:'§ 3', t:'Main Result', s:'Theorem 3.1 · convergence rate', highlight:true },
              { n:'§ 4', t:'Proof', s:'Itô + Grönwall sketch' },
              { n:'§ 5', t:'Conclusion', s:'limitations, future work' },
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',gap:10,padding:'4px 0',color: s.highlight?'#E6E8EC':'#D1D5DB'}}>
                <span style={{color: s.highlight?accent.a:'#6B7280',width:30,flexShrink:0,fontWeight: s.highlight?600:400}}>{s.n}</span>
                <span style={{flex:1,fontWeight: s.highlight?600:500}}>{s.t}</span>
                <span style={{color:'#6B7280',flexShrink:0}}>{s.s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// Step 7 — Review (Workshop)
function NPWReview({ accent }) {
  const items = [
    { l:'Format',    v:'LaTeX',                   i:'doc' },
    { l:'Template',  v:'ICML 2026',               i:'book' },
    { l:'Title',     v:'Asymptotic Behavior of Stochastic Gradient Flows', i:'edit' },
    { l:'Authors',   v:'M. Sokol, A. Khanna, J. Tashiro', i:'users' },
    { l:'Deadline',  v:'Apr 24 · 22 days',        i:'cal' },
    { l:'Citations', v:'Zotero · ACM style',      i:'link' },
    { l:'Drafting',  v:'AI outline · 6 sections', i:'sparkles' },
    { l:'Folder',    v:'~/projects/stochastic-flows', i:'folder' },
  ];
  return (
    <NPWorkshopChrome step={6} totalSteps={7} accent={accent}
      footerLeft={<span>You can change any of this from the project settings later</span>}
      footerRight={<>{wBack(accent)}<WBtn primary accent={accent} icon="rocket">Create project</WBtn></>}
    >
      <div style={{padding:'24px 22px 22px'}}>
        <h2 style={{fontSize:20,fontWeight:600,letterSpacing:'-0.015em',margin:'0 0 4px'}}>Looks good?</h2>
        <p style={{fontSize:12,color:'#9CA3AF',margin:'0 0 18px'}}>Quick sanity check before we scaffold the files.</p>

        <div style={{borderRadius:12,background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden'}}>
          {items.map((it,i)=>(
            <div key={i} style={{
              padding:'10px 14px', display:'flex', alignItems:'center', gap:11,
              borderBottom: i<items.length-1?'1px solid rgba(255,255,255,0.04)':'none',
            }}>
              <div style={{width:24,height:24,borderRadius:6,background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.06)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                <NIc n={it.i} s={11} c={accent.b} />
              </div>
              <span style={{fontSize:11,color:'#9CA3AF',width:80,fontWeight:500,letterSpacing:'0.04em',textTransform:'uppercase'}}>{it.l}</span>
              <span style={{flex:1,fontSize:12.5,color:'#E6E8EC',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{it.v}</span>
              <button style={{height:22,padding:'0 9px',borderRadius:5,background:'transparent',border:'1px solid rgba(255,255,255,0.06)',color:'#9CA3AF',fontSize:10.5,cursor:'pointer'}}>Edit</button>
            </div>
          ))}
        </div>

        <div style={{marginTop:12,padding:'10px 14px',borderRadius:10,background:`${accent.a}10`,border:`1px solid ${accent.a}33`,display:'flex',alignItems:'center',gap:10}}>
          <NIc n="sparkles" s={13} c={accent.a} />
          <div style={{fontSize:11.5,color:'#D8B4FE',lineHeight:1.5,flex:1,textWrap:'pretty'}}>
            <span style={{fontWeight:600,color:'#E9D5FF'}}>On create: </span>
            we'll scaffold <span style={{fontFamily:"'JetBrains Mono',monospace"}}>main.tex</span>, <span style={{fontFamily:"'JetBrains Mono',monospace"}}>icml2026.cls</span>, the AI-generated outline, and a <span style={{fontFamily:"'JetBrains Mono',monospace"}}>references.bib</span> linked to your Zotero collection. Then open the editor.
          </div>
        </div>
      </div>
    </NPWorkshopChrome>
  );
}

// ───────────────────────── Direction B — Console ─────────────────────────
function NPConsoleChrome({ step, totalSteps, accent, children, footerLeft, footerRight }) {
  const steps = [
    { n:'Format',     s:'pick toolchain' },
    { n:'Template',   s:'class & layout' },
    { n:'Details',    s:'title · authors' },
    { n:'Deadline',   s:'due date' },
    { n:'Citations',  s:'.bib source' },
    { n:'Drafting',   s:'starting state' },
    { n:'Review',     s:'create.lock' },
  ];
  return (
    <div style={{width:'100%',height:'100%',position:'relative',background:'#08090C',color:'#E6E8EC',fontFamily:"'Inter',system-ui,sans-serif",borderRadius:18,overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,backgroundImage:`linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`,backgroundSize:'32px 32px',opacity:0.6,pointerEvents:'none'}} />
      <div style={{position:'absolute',width:520,height:520,right:-160,bottom:-180,borderRadius:'50%',background:`radial-gradient(circle, ${accent.a}55 0%, transparent 65%)`,filter:'blur(110px)',opacity:0.5,pointerEvents:'none'}} />
      <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',padding:32}}>
        <div style={{
          width:820, maxWidth:'100%', height:540, borderRadius:14,
          background:'rgba(13,15,20,0.88)', border:'1px solid rgba(255,255,255,0.06)',
          backdropFilter:'blur(28px) saturate(140%)', WebkitBackdropFilter:'blur(28px) saturate(140%)',
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.04), 0 24px 80px rgba(0,0,0,0.6)',
          display:'flex', overflow:'hidden',
        }}>
          {/* Left rail */}
          <div style={{width:208,flexShrink:0,borderRight:'1px solid rgba(255,255,255,0.05)',display:'flex',flexDirection:'column',background:'rgba(0,0,0,0.20)'}}>
            <div style={{height:50,padding:'0 14px',display:'flex',alignItems:'center',borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
              <div style={{width:22,height:22,borderRadius:6,background:`linear-gradient(135deg, ${accent.b}, ${accent.a})`,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700,fontSize:10}}>τ</div>
              <span style={{marginLeft:9,fontSize:12,fontWeight:600}}>new project</span>
              <span style={{marginLeft:'auto',fontSize:9.5,color:'#4B5563',fontFamily:"'JetBrains Mono',monospace"}}>{step+1}/{totalSteps}</span>
            </div>
            <div style={{padding:'10px 8px',flex:1}}>
              <div style={{fontSize:9.5,letterSpacing:'0.10em',textTransform:'uppercase',color:'#6B7280',padding:'0 6px 6px',fontWeight:500}}>$ wizard</div>
              {steps.slice(0,totalSteps).map((s,i)=>{
                const cur=i===step, done=i<step;
                return (
                  <div key={i} style={{display:'flex',alignItems:'center',gap:9,padding:'7px 8px',borderRadius:6,background:cur?'rgba(255,255,255,0.04)':'transparent',position:'relative'}}>
                    {cur && <div style={{position:'absolute',left:0,top:7,bottom:7,width:2,borderRadius:1,background:`linear-gradient(180deg, ${accent.a}, ${accent.b})`}} />}
                    <div style={{width:16,height:16,borderRadius:'50%',flexShrink:0,background: done?'rgba(16,185,129,0.15)':cur?`${accent.a}22`:'rgba(255,255,255,0.04)',border: done?'1px solid rgba(16,185,129,0.4)':cur?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.08)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontFamily:"'JetBrains Mono',monospace",color: done?'#34D399':cur?accent.a:'#6B7280',fontWeight:600}}>
                      {done ? <NIc n="check" s={8} w={3} c="#34D399" /> : i+1}
                    </div>
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:11.5,fontWeight: cur?600:500,color: cur||done?'#E6E8EC':'#9CA3AF'}}>{s.n}</div>
                      <div style={{fontSize:9.5,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace",marginTop:1}}>{s.s}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{padding:'9px 12px',borderTop:'1px solid rgba(255,255,255,0.04)',fontSize:9.5,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace",display:'flex',alignItems:'center',gap:6}}>
              <NIc n="folder" s={10} c="#6B7280" />~/projects
            </div>
          </div>

          {/* Right content */}
          <div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
            <div style={{flex:1,overflow:'auto'}}>{children}</div>
            <div style={{height:50,padding:'0 18px',display:'flex',alignItems:'center',borderTop:'1px solid rgba(255,255,255,0.05)',background:'rgba(0,0,0,0.18)'}}>
              <div style={{fontSize:11,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace"}}>{footerLeft}</div>
              <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6}}>{footerRight}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CBtn({ children, primary, accent, icon, ...rest }) {
  return (
    <button {...rest} style={{
      height:28, padding:'0 11px', borderRadius:6,
      border: primary?'0':'1px solid rgba(255,255,255,0.10)',
      background: primary?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:'rgba(255,255,255,0.04)',
      color: primary?'#fff':'#E6E8EC', fontSize:11, fontWeight: primary?600:500,
      display:'flex', alignItems:'center', gap:5, cursor:'pointer',
      boxShadow: primary?`0 0 0 1px ${accent.a}40, 0 6px 20px ${accent.a}33`:'none',
      ...(rest.style||{}),
    }}>{children}{icon && <NIc n={icon} s={11} w={2.2} />}</button>
  );
}
const cBack = () => <CBtn icon="back">back</CBtn>;

// Console Step 1 — Format
function NPCFormat({ accent }) {
  const picked='latex';
  return (
    <NPConsoleChrome step={0} totalSteps={7} accent={accent}
      footerLeft={<span>$ format=<span style={{color:accent.b}}>latex</span> · engine=tex-live</span>}
      footerRight={<CBtn primary accent={accent} icon="arrow">next</CBtn>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 1 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 16px'}}>select format</h2>

        <div style={{borderRadius:9,border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden'}}>
          {NP_FORMATS.map((f,i)=>{
            const on=f.id===picked;
            return (
              <div key={f.id} style={{padding:'10px 14px',display:'flex',alignItems:'center',gap:12,borderBottom: i<NP_FORMATS.length-1?'1px solid rgba(255,255,255,0.05)':'none',background: on?'rgba(255,255,255,0.04)':'transparent',cursor:'pointer'}}>
                <div style={{width:14,height:14,borderRadius:3.5,flexShrink:0,background: on?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:'transparent',border: on?'0':'1.5px solid rgba(255,255,255,0.18)',display:'flex',alignItems:'center',justifyContent:'center'}}>{on && <NIc n="check" s={9} w={3} c="#fff" />}</div>
                <div style={{width:24,height:24,borderRadius:6,flexShrink:0,background:`${f.color}1A`,border:`1px solid ${f.color}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontFamily:"'Times New Roman',serif",fontStyle:'italic',color:f.color,fontWeight:600}}>{f.glyph}</div>
                <div style={{flex:1,minWidth:0,fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
                  <span style={{color:'#E6E8EC',fontWeight:600}}>{f.name.toLowerCase()}</span>
                  <span style={{color:'#6B7280'}}> — {f.desc}</span>
                </div>
                <span style={{fontSize:10,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace"}}>{f.id==='latex'?'tex-live':f.id==='typst'?'typst':f.id==='rmd'?'r+rmd':f.id==='quarto'?'quarto':'pandoc'}</span>
              </div>
            );
          })}
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// Console Step 2 — Template
function NPCTemplate({ accent }) {
  const picked='icml';
  return (
    <NPConsoleChrome step={1} totalSteps={7} accent={accent}
      footerLeft={<span>$ template=<span style={{color:accent.b}}>icml2026</span> · class=icml2026.cls</span>}
      footerRight={<>{cBack()}<CBtn primary accent={accent} icon="arrow">next</CBtn></>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 2 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 4px'}}>select template</h2>
        <p style={{fontSize:11,color:'#9CA3AF',margin:'0 0 14px',fontFamily:"'JetBrains Mono',monospace"}}>$ ls templates/latex/ · 12 results</p>

        <div style={{borderRadius:9,border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden',fontFamily:"'JetBrains Mono',monospace",fontSize:11}}>
          <div style={{padding:'5px 14px',borderBottom:'1px solid rgba(255,255,255,0.05)',display:'flex',gap:10,fontSize:9.5,color:'#6B7280',letterSpacing:'0.06em',textTransform:'uppercase'}}>
            <span style={{width:14}}></span>
            <span style={{flex:1}}>name</span>
            <span style={{width:120}}>group</span>
            <span style={{width:80,textAlign:'right'}}>length</span>
          </div>
          <div style={{maxHeight:268,overflow:'auto'}}>
            {NP_TEMPLATES.map((t,i)=>{
              const on=t.id===picked;
              return (
                <div key={t.id} style={{padding:'7px 14px',display:'flex',alignItems:'center',gap:10,borderBottom: i<NP_TEMPLATES.length-1?'1px solid rgba(255,255,255,0.04)':'none',background: on?`${accent.a}12`:'transparent',cursor:'pointer'}}>
                  <div style={{width:14,height:14,borderRadius:3.5,flexShrink:0,background: on?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:'transparent',border: on?'0':'1.5px solid rgba(255,255,255,0.18)',display:'flex',alignItems:'center',justifyContent:'center'}}>{on && <NIc n="check" s={9} w={3} c="#fff" />}</div>
                  <span style={{flex:1,color: on?'#E6E8EC':'#D1D5DB',fontWeight: on?600:500}}>{t.name.toLowerCase().replace(/ /g,'-')} {t.popular && <span style={{color:accent.b,fontSize:9.5}}>★</span>}</span>
                  <span style={{width:120,color:'#6B7280'}}>{t.group}</span>
                  <span style={{width:80,textAlign:'right',color:'#9CA3AF'}}>{t.pages}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// Console Step 3 — Details
function NPCDetails({ accent }) {
  return (
    <NPConsoleChrome step={2} totalSteps={7} accent={accent}
      footerLeft={<span>$ project.toml — 248 chars · 3 authors</span>}
      footerRight={<>{cBack()}<CBtn primary accent={accent} icon="arrow">next</CBtn></>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 3 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 12px'}}>project metadata</h2>

        <div style={{borderRadius:9,background:'rgba(0,0,0,0.32)',border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden',fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
          <div style={{height:24,padding:'0 12px',display:'flex',alignItems:'center',gap:6,borderBottom:'1px solid rgba(255,255,255,0.05)',fontSize:10,color:'#6B7280'}}>
            <NIc n="file" s={10} c="#9CA3AF" />project.toml
            <span style={{marginLeft:'auto',color:'#34D399'}}>● valid</span>
          </div>
          <div style={{padding:'12px 14px',lineHeight:1.75}}>
            <div><span style={{color:'#6B7280'}}>1 </span><span style={{color:'#67E8F9'}}>[project]</span></div>
            <div><span style={{color:'#6B7280'}}>2 </span><span style={{color:'#A78BFA'}}>title</span><span style={{color:'#9CA3AF'}}> = </span><span style={{color:'#FDE68A'}}>"Asymptotic Behavior of Stochastic Gradient Flows"</span></div>
            <div><span style={{color:'#6B7280'}}>3 </span><span style={{color:'#A78BFA'}}>journal</span><span style={{color:'#9CA3AF'}}> = </span><span style={{color:'#FDE68A'}}>"ICML 2026"</span></div>
            <div><span style={{color:'#6B7280'}}>4 </span><span style={{color:'#A78BFA'}}>keywords</span><span style={{color:'#9CA3AF'}}> = [</span><span style={{color:'#FDE68A'}}>"stochastic gradient", "Wasserstein", "log-Sobolev"</span><span style={{color:'#9CA3AF'}}>]</span></div>
            <div><span style={{color:'#6B7280'}}>5 </span></div>
            <div><span style={{color:'#6B7280'}}>6 </span><span style={{color:'#A78BFA'}}>abstract</span><span style={{color:'#9CA3AF'}}> = </span><span style={{color:'#FDE68A'}}>"""</span></div>
            <div><span style={{color:'#6B7280'}}>7 </span><span style={{color:'#FDE68A',paddingLeft:8}}>We study the long-time behavior of solutions to a stochastic</span></div>
            <div><span style={{color:'#6B7280'}}>8 </span><span style={{color:'#FDE68A',paddingLeft:8}}>differential equation governing gradient flows under additive</span></div>
            <div><span style={{color:'#6B7280'}}>9 </span><span style={{color:'#FDE68A',paddingLeft:8}}>Brownian noise…<span style={{display:'inline-block',width:7,height:11,marginLeft:1,background:`linear-gradient(180deg, ${accent.a}, ${accent.b})`,animation:'onbblink 1s steps(1) infinite',verticalAlign:'-1px'}} /></span></div>
            <div><span style={{color:'#6B7280'}}>10</span><span style={{color:'#FDE68A'}}>"""</span></div>
            <div><span style={{color:'#6B7280'}}>11</span></div>
            <div><span style={{color:'#6B7280'}}>12</span><span style={{color:'#67E8F9'}}>[[authors]]</span></div>
            <div><span style={{color:'#6B7280'}}>13</span><span style={{color:'#A78BFA'}}>name</span><span style={{color:'#9CA3AF'}}> = </span><span style={{color:'#FDE68A'}}>"M. Sokol"</span><span style={{color:'#6B7280'}}>  # primary</span></div>
            <div><span style={{color:'#6B7280'}}>14</span><span style={{color:'#67E8F9'}}>[[authors]]</span></div>
            <div><span style={{color:'#6B7280'}}>15</span><span style={{color:'#A78BFA'}}>name</span><span style={{color:'#9CA3AF'}}> = </span><span style={{color:'#FDE68A'}}>"A. Khanna"</span></div>
            <div><span style={{color:'#6B7280'}}>16</span><span style={{color:'#67E8F9'}}>[[authors]]</span></div>
            <div><span style={{color:'#6B7280'}}>17</span><span style={{color:'#A78BFA'}}>name</span><span style={{color:'#9CA3AF'}}> = </span><span style={{color:'#FDE68A'}}>"J. Tashiro"</span></div>
          </div>
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// Console Step 4 — Deadline
function NPCDeadline({ accent }) {
  return (
    <NPConsoleChrome step={3} totalSteps={7} accent={accent}
      footerLeft={<span>$ deadline=<span style={{color:accent.b}}>2026-04-24T23:59Z</span></span>}
      footerRight={<>{cBack()}<CBtn primary accent={accent} icon="arrow">next</CBtn></>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 4 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 14px'}}>set deadline</h2>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          {/* ascii calendar */}
          <div style={{borderRadius:9,background:'rgba(0,0,0,0.30)',border:'1px solid rgba(255,255,255,0.06)',padding:'10px 12px',fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
            <div style={{display:'flex',alignItems:'center',marginBottom:8,fontSize:11}}>
              <span style={{color:'#9CA3AF'}}>$ cal -3</span>
              <span style={{marginLeft:'auto',color:accent.b}}>Apr 2026</span>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:1,textAlign:'center'}}>
              {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=><div key={d} style={{color:'#6B7280',fontSize:10,padding:'3px 0'}}>{d}</div>)}
              {[...Array(35)].map((_,i)=>{
                const d=i-2, day=d+1;
                const inMonth = day>=1 && day<=30;
                const today = day===7, picked = day===24;
                return (
                  <div key={i} style={{
                    padding:'5px 0', borderRadius:3,
                    color: !inMonth?'#374151':picked?'#fff':today?accent.b:'#D1D5DB',
                    background: picked?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:today?'rgba(34,211,238,0.10)':'transparent',
                    fontWeight: picked||today?600:400,
                  }}>{inMonth?day:''}</div>
                );
              })}
            </div>
          </div>

          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{borderRadius:9,background:`${accent.a}12`,border:`1px solid ${accent.a}33`,padding:'10px 12px',fontFamily:"'JetBrains Mono',monospace"}}>
              <div style={{fontSize:9.5,color:'#9CA3AF',letterSpacing:'0.06em',textTransform:'uppercase'}}>$ deadline</div>
              <div style={{fontSize:18,fontWeight:600,color:'#E6E8EC',marginTop:3,letterSpacing:'-0.01em'}}>2026-04-24</div>
              <div style={{fontSize:10.5,color:'#9CA3AF',marginTop:2}}>23:59 UTC · Fri</div>
              <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid rgba(255,255,255,0.05)',fontSize:10.5,color:'#D8B4FE',display:'flex',gap:6,alignItems:'center'}}>
                <NIc n="clock" s={10} c={accent.a} />T-22d 09h
              </div>
            </div>

            <div style={{borderRadius:9,background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)',padding:'9px 11px'}}>
              <div style={{fontSize:9.5,color:'#6B7280',fontFamily:"'JetBrains Mono',monospace",letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:5}}>quick</div>
              {[{l:'+ 1 week',d:'Apr 9'},{l:'+ 1 month',d:'May 2'},{l:'no deadline',d:'null'}].map((q,i)=>(
                <div key={i} style={{padding:'5px 0',display:'flex',alignItems:'center',gap:6,fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:'#D1D5DB',cursor:'pointer'}}>
                  <span style={{color:'#6B7280'}}>›</span>{q.l}
                  <span style={{marginLeft:'auto',color:'#6B7280'}}>{q.d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// Console Step 5 — Citations
function NPCCitations({ accent }) {
  return (
    <NPConsoleChrome step={4} totalSteps={7} accent={accent}
      footerLeft={<span>$ src=zotero · style=<span style={{color:accent.b}}>acm</span> · 142 entries linked</span>}
      footerRight={<>{cBack()}<CBtn primary accent={accent} icon="arrow">next</CBtn></>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 5 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 14px'}}>citations</h2>

        <div style={{borderRadius:9,border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden',marginBottom:14,fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
          {[
            {id:'zotero', t:'zotero',     d:'live sync', meta:'2 collections · 142 entries', on:true},
            {id:'bib',    t:'.bib import',d:'one-shot',  meta:'references.bib · 28 KB',     on:false},
            {id:'none',   t:'none',       d:'add later', meta:null,                          on:false},
          ].map((o,i)=>(
            <div key={o.id} style={{padding:'10px 14px',display:'flex',alignItems:'center',gap:10,borderBottom: i<2?'1px solid rgba(255,255,255,0.05)':'none',background: o.on?`${accent.a}12`:'transparent'}}>
              <div style={{width:14,height:14,borderRadius:3.5,flexShrink:0,background: o.on?`linear-gradient(135deg, ${accent.a}, ${accent.b})`:'transparent',border: o.on?'0':'1.5px solid rgba(255,255,255,0.18)',display:'flex',alignItems:'center',justifyContent:'center'}}>{o.on && <NIc n="check" s={9} w={3} c="#fff" />}</div>
              <span style={{color:o.on?'#E6E8EC':'#D1D5DB',fontWeight: o.on?600:500,width:90}}>{o.t}</span>
              <span style={{color:'#6B7280'}}>—</span>
              <span style={{flex:1,color:'#9CA3AF'}}>{o.d}</span>
              {o.meta && <span style={{color:'#6B7280'}}>{o.meta}</span>}
            </div>
          ))}
        </div>

        <div>
          <div style={{fontSize:9.5,fontFamily:"'JetBrains Mono',monospace",color:'#6B7280',letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:6}}>$ style</div>
          <div style={{display:'flex',gap:5,flexWrap:'wrap',fontFamily:"'JetBrains Mono',monospace"}}>
            {['acm','ieee','apa','chicago','nature','plain','custom.csl'].map((s,i)=>(
              <button key={s} style={{
                height:26, padding:'0 11px', borderRadius:5,
                background: i===0?`${accent.a}1A`:'rgba(255,255,255,0.03)',
                border: i===0?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',
                color: i===0?'#fff':'#D1D5DB', fontSize:11, fontWeight: i===0?600:500, cursor:'pointer',
              }}>{s}</button>
            ))}
          </div>
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// Console Step 6 — Drafting
function NPCDrafting({ accent }) {
  return (
    <NPConsoleChrome step={5} totalSteps={7} accent={accent}
      footerLeft={<span>$ outline → <span style={{color:'#34D399'}}>ok</span> · 6 sections · 248 char prompt</span>}
      footerRight={<>{cBack()}<CBtn primary accent={accent} icon="arrow">next</CBtn></>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 6 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 14px'}}>drafting mode</h2>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:7,marginBottom:14,fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
          {[
            {id:'ai', t:'ai-outline', d:'from abstract', on:true},
            {id:'tpl', t:'template',  d:'icml sections', on:false},
            {id:'blank', t:'blank',   d:'preamble only', on:false},
          ].map(o=>(
            <div key={o.id} style={{padding:'10px 12px',borderRadius:8,background: o.on?`${accent.a}12`:'rgba(255,255,255,0.025)',border: o.on?`1px solid ${accent.a}66`:'1px solid rgba(255,255,255,0.06)',cursor:'pointer'}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                <span style={{color:'#6B7280'}}>›</span>
                <span style={{color:o.on?'#E6E8EC':'#D1D5DB',fontWeight: o.on?600:500}}>{o.t}</span>
                {o.on && <span style={{marginLeft:'auto',color:'#34D399',fontSize:10}}>●</span>}
              </div>
              <div style={{color:'#6B7280',fontSize:10.5}}>// {o.d}</div>
            </div>
          ))}
        </div>

        {/* Outline as raw .tex */}
        <div style={{borderRadius:9,background:'rgba(0,0,0,0.32)',border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden',fontFamily:"'JetBrains Mono',monospace",fontSize:11}}>
          <div style={{height:24,padding:'0 12px',display:'flex',alignItems:'center',gap:6,borderBottom:'1px solid rgba(255,255,255,0.05)',fontSize:10,color:'#6B7280'}}>
            <NIc n="file" s={10} c="#9CA3AF" />main.tex (preview)
            <span style={{marginLeft:'auto',color:accent.b}}>↻ regenerate</span>
          </div>
          <div style={{padding:'10px 14px',lineHeight:1.65,maxHeight:170,overflow:'auto'}}>
            <div><span style={{color:'#6B7280'}}>1 </span><span style={{color:'#5F6878',fontStyle:'italic'}}>% generated outline · ai-outline · {`{title}`}</span></div>
            <div><span style={{color:'#6B7280'}}>2 </span><span style={{color:'#A78BFA'}}>\section</span><span style={{color:'#6B7280'}}>{'{'}</span><span style={{color:'#E6E8EC'}}>Introduction</span><span style={{color:'#6B7280'}}>{'}'}</span></div>
            <div><span style={{color:'#6B7280'}}>3 </span><span style={{color:'#5F6878',fontStyle:'italic'}}>% motivation · contributions · related work</span></div>
            <div><span style={{color:'#6B7280'}}>4 </span><span style={{color:'#A78BFA'}}>\section</span><span style={{color:'#6B7280'}}>{'{'}</span><span style={{color:'#E6E8EC'}}>Preliminaries</span><span style={{color:'#6B7280'}}>{'}'}</span></div>
            <div><span style={{color:'#6B7280'}}>5 </span><span style={{color:'#5F6878',fontStyle:'italic'}}>% SDE notation, LSI, relative entropy</span></div>
            <div><span style={{color:'#6B7280'}}>6 </span><span style={{color:'#A78BFA'}}>\section</span><span style={{color:'#6B7280'}}>{'{'}</span><span style={{color:'#E6E8EC'}}>Main Result</span><span style={{color:'#6B7280'}}>{'}'}</span></div>
            <div><span style={{color:'#6B7280'}}>7 </span><span style={{color:'#A78BFA'}}>\begin</span><span style={{color:'#6B7280'}}>{'{'}</span><span style={{color:'#34D399'}}>theorem</span><span style={{color:'#6B7280'}}>{'}['}</span><span style={{color:'#E6E8EC'}}>Convergence Rate</span><span style={{color:'#6B7280'}}>{']'}</span></div>
            <div><span style={{color:'#6B7280'}}>8 </span><span style={{paddingLeft:14,color:'#5F6878',fontStyle:'italic'}}>% statement TBD</span></div>
            <div><span style={{color:'#6B7280'}}>9 </span><span style={{color:'#A78BFA'}}>\end</span><span style={{color:'#6B7280'}}>{'{'}</span><span style={{color:'#34D399'}}>theorem</span><span style={{color:'#6B7280'}}>{'}'}</span></div>
            <div><span style={{color:'#6B7280'}}>10</span><span style={{color:'#A78BFA'}}>\section</span><span style={{color:'#6B7280'}}>{'{'}</span><span style={{color:'#E6E8EC'}}>Proof</span><span style={{color:'#6B7280'}}>{'}'}</span><span style={{display:'inline-block',width:7,height:11,marginLeft:2,background:`linear-gradient(180deg, ${accent.a}, ${accent.b})`,animation:'onbblink 1s steps(1) infinite',verticalAlign:'-1px'}} /></div>
          </div>
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// Console Step 7 — Review
function NPCReview({ accent }) {
  const lines = [
    ['format',    'latex',                                    '#67E8F9'],
    ['template',  'icml2026',                                 '#67E8F9'],
    ['title',     '"Asymptotic Behavior of Stochastic..."',   '#FDE68A'],
    ['authors',   '[m.sokol, a.khanna, j.tashiro]',          '#FDE68A'],
    ['journal',   '"ICML 2026"',                              '#FDE68A'],
    ['deadline',  '2026-04-24T23:59Z',                        '#FDE68A'],
    ['citations', 'zotero://stochastic-flows · acm',          '#A7F3D0'],
    ['drafting',  'ai-outline · 6 sections',                  '#A7F3D0'],
    ['path',      '~/projects/stochastic-flows/',             '#FDE68A'],
  ];
  return (
    <NPConsoleChrome step={6} totalSteps={7} accent={accent}
      footerLeft={<span>$ ready to scaffold · 4 files · ~12 KB</span>}
      footerRight={<>{cBack()}<CBtn primary accent={accent} icon="rocket">create &amp; open</CBtn></>}
    >
      <div style={{padding:'22px 22px'}}>
        <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:accent.b,letterSpacing:'0.10em',textTransform:'uppercase'}}>step 7 / 7</div>
        <h2 style={{fontSize:18,fontWeight:600,letterSpacing:'-0.015em',margin:'6px 0 14px'}}>review &amp; create</h2>

        <div style={{borderRadius:9,background:'rgba(0,0,0,0.32)',border:'1px solid rgba(255,255,255,0.06)',overflow:'hidden',fontFamily:"'JetBrains Mono',monospace",fontSize:11.5}}>
          <div style={{height:24,padding:'0 12px',display:'flex',alignItems:'center',gap:6,borderBottom:'1px solid rgba(255,255,255,0.05)',fontSize:10,color:'#6B7280'}}>
            <NIc n="file" s={10} c="#9CA3AF" />.typeward.lock
            <span style={{marginLeft:'auto',color:'#34D399'}}>● ready</span>
          </div>
          <div style={{padding:'10px 14px',lineHeight:1.75}}>
            {lines.map(([k,v,c],i)=>(
              <div key={i} style={{display:'flex',gap:8}}>
                <span style={{color:'#6B7280',width:18,textAlign:'right'}}>{i+1}</span>
                <span style={{color:'#A78BFA',width:90}}>{k}</span>
                <span style={{color:'#9CA3AF'}}>=</span>
                <span style={{color:c}}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{marginTop:12,padding:'10px 12px',borderRadius:8,background:'rgba(16,185,129,0.06)',border:'1px solid rgba(16,185,129,0.18)',fontFamily:"'JetBrains Mono',monospace",fontSize:10.5,color:'#A7F3D0',display:'flex',gap:8,alignItems:'flex-start',lineHeight:1.5}}>
          <NIc n="check" s={12} w={2.5} c="#34D399" style={{marginTop:1}} />
          <div>
            will write: <span style={{color:'#E6E8EC'}}>main.tex</span>, <span style={{color:'#E6E8EC'}}>icml2026.cls</span>, <span style={{color:'#E6E8EC'}}>references.bib</span>, <span style={{color:'#E6E8EC'}}>.typeward.lock</span> · git init · 1 commit
          </div>
        </div>
      </div>
    </NPConsoleChrome>
  );
}

// ───────────────────────── Exports ─────────────────────────
Object.assign(window, {
  NPWFormat, NPWTemplate, NPWMetadata, NPWDeadline, NPWCitations, NPWDrafting, NPWReview,
  NPCFormat, NPCTemplate, NPCDetails,  NPCDeadline, NPCCitations, NPCDrafting, NPCReview,
});
