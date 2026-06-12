// Onboarding screens — both directions live here.
// Exposed on window so the host HTML can use them.

// ───────────────────────── Inline icons (subset) ─────────────────────────
const ONB_ICONS = {
  check: "M20 6L9 17l-5-5",
  "check-circle": "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z M9 12l2 2 4-4",
  x: "M18 6L6 18 M6 6l12 12",
  "x-circle": "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z M15 9l-6 6 M9 9l6 6",
  alert: "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  refresh: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5",
  arrow: "M5 12h14 M13 5l7 7-7 7",
  back: "M19 12H5 M11 19l-7-7 7-7",
  spark: "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2 2 M16.4 16.4l2 2 M5.6 18.4l2-2 M16.4 7.6l2-2",
  folder: "M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  cpu: "M5 5h14v14H5z M9 9h6v6H9z M3 9h2 M3 15h2 M19 9h2 M19 15h2 M9 3v2 M15 3v2 M9 19v2 M15 19v2",
  github: "M12 2a10 10 0 0 0-3 19.5c.5.1.7-.2.7-.5v-2c-3 .6-3.5-1.3-3.5-1.3-.5-1-1.2-1.4-1.2-1.4-1-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.2-4.7-5 0-1.1.4-2 1-2.7-.1-.3-.5-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.4 4.7-4.7 5 .4.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A10 10 0 0 0 12 2z",
  google: "M21 12.2c0-.7 0-1.3-.2-2H12v3.8h5c-.2 1.2-.9 2.2-1.9 2.9v2.4h3.1c1.8-1.7 2.8-4.1 2.8-7.1z M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 1-3.2 1-2.4 0-4.5-1.6-5.3-3.8H3.5v2.4A9 9 0 0 0 12 21z M6.7 13.5c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7H3.5a9 9 0 0 0 0 8.1l3.2-1.6z M12 5.4c1.4 0 2.6.5 3.5 1.4l2.7-2.7A9 9 0 0 0 12 1.5 9 9 0 0 0 3.5 7l3.2 2.4C7.5 7.1 9.6 5.4 12 5.4z",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 7l9 6 9-6",
  globe: "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20",
  package: "M16 3l-4-2-4 2-4 2v10l4 2 4 2 4-2 4-2V5z M3 5l9 4 9-4 M12 9v13",
  sigma: "M18 5H6l6 7-6 7h12",
  hash: "M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 18",
  pencil: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  doc: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6 M8 13h8 M8 17h6",
  terminal: "M4 17l6-6-6-6 M12 19h8",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  shield: "M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z M9 12l2 2 4-4",
};
const Ic = ({ n, s = 14, w = 1.7, c = "currentColor", style }) => {
  const d = ONB_ICONS[n] || ONB_ICONS["check"];
  const ps = d.split(/\s(?=M)/);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={{display:'inline-block',flexShrink:0,...(style||{})}} aria-hidden="true">
      {ps.map((p,i)=><path key={i} d={p} />)}
    </svg>
  );
};

// ───────────────────────── Shared assets ─────────────────────────
const FORMATS = [
  { id:'latex',    name:'LaTeX',         glyph:'τ', desc:'Academic & math typesetting', engine:'TeX Live · MiKTeX · MacTeX', size:'~4.2 GB', recommended:true, color:'#A78BFA' },
  { id:'typst',    name:'Typst',         glyph:'§', desc:'Modern markup, fast compile', engine:'Typst CLI 0.12',              size:'62 MB',   color:'#67E8F9' },
  { id:'markdown', name:'Markdown',      glyph:'#', desc:'Plain text with structure',    engine:'Built-in (Pandoc bundled)',   size:'12 MB',   color:'#F0ABFC' },
  { id:'rmd',      name:'R Markdown',    glyph:'R', desc:'Reproducible R reports',       engine:'R + rmarkdown package',       size:'~310 MB', color:'#34D399' },
  { id:'quarto',   name:'Quarto',        glyph:'Q', desc:'Multi-language scientific docs',engine:'Quarto CLI 1.5',             size:'180 MB',  color:'#FBBF24' },
];

// ───────────────────────── Direction A — "Workshop" ─────────────────────────
// Warm hero. Generous whitespace. Hero glyph collage. Friendly tone.
function WorkshopChrome({ step, totalSteps, accent, children, footerLeft, footerRight }) {
  const stepNames = ['Welcome', 'Formats', 'Engines', 'Install'];
  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative',
      background: '#0A0B0F', color: '#E6E8EC', fontFamily: "'Inter', system-ui, sans-serif",
      borderRadius: 18, overflow: 'hidden',
    }}>
      {/* Ambient blobs */}
      <div style={{ position:'absolute', inset:0, overflow:'hidden', pointerEvents:'none' }}>
        <div style={{ position:'absolute', width:540, height:540, left:-160, top:-200, borderRadius:'50%', background:`radial-gradient(circle, ${accent.a} 0%, transparent 65%)`, filter:'blur(100px)', opacity:0.55 }} />
        <div style={{ position:'absolute', width:560, height:560, right:-180, top:-100, borderRadius:'50%', background:`radial-gradient(circle, ${accent.b} 0%, transparent 65%)`, filter:'blur(100px)', opacity:0.45 }} />
        <div style={{ position:'absolute', width:420, height:420, left:'40%', bottom:-180, borderRadius:'50%', background:`radial-gradient(circle, ${accent.c} 0%, transparent 65%)`, filter:'blur(100px)', opacity:0.35 }} />
      </div>

      {/* Centered modal */}
      <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', padding:32 }}>
        <div style={{
          width:760, maxWidth:'100%', borderRadius:18,
          background:'rgba(15,17,22,0.72)', border:'1px solid rgba(255,255,255,0.07)',
          backdropFilter:'blur(28px) saturate(140%)', WebkitBackdropFilter:'blur(28px) saturate(140%)',
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 80px rgba(0,0,0,0.55)',
          overflow:'hidden', display:'flex', flexDirection:'column',
        }}>
          {/* Top bar with stepper */}
          <div style={{ height:56, padding:'0 22px', display:'flex', alignItems:'center', borderBottom:'1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ width:24, height:24, borderRadius:7, background:`linear-gradient(135deg, ${accent.b} 0%, ${accent.a} 100%)`, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, color:'#fff', fontSize:11 }}>τ</div>
            <span style={{ marginLeft:10, fontSize:13, fontWeight:600, letterSpacing:'-0.01em' }}>Typeward</span>
            <span style={{ marginLeft:10, fontSize:11, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>· first run · v0.4.2</span>
            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
              {stepNames.map((n,i)=>{
                const done = i<step, cur = i===step;
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <div style={{
                      width: cur?20:8, height:8, borderRadius:4,
                      background: cur ? `linear-gradient(90deg, ${accent.a}, ${accent.b})` : done ? accent.b : 'rgba(255,255,255,0.10)',
                      transition:'all .2s',
                    }} />
                    {i<stepNames.length-1 && <div style={{ width:14, height:1, background:'rgba(255,255,255,0.08)' }} />}
                  </div>
                );
              })}
              <span style={{ marginLeft:8, fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>{step+1}/{totalSteps}</span>
            </div>
          </div>

          <div style={{ flex:1, position:'relative' }}>{children}</div>

          {/* Footer */}
          <div style={{ height:64, padding:'0 22px', display:'flex', alignItems:'center', borderTop:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.18)' }}>
            <div style={{ fontSize:11.5, color:'#9CA3AF' }}>{footerLeft}</div>
            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8 }}>{footerRight}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkshopBtn({ children, primary, accent, icon, sub, ...rest }) {
  return (
    <button {...rest} style={{
      height:38, padding: sub ? '0 16px 0 14px' : '0 18px',
      borderRadius:10, border: primary ? '0' : '1px solid rgba(255,255,255,0.10)',
      background: primary ? `linear-gradient(135deg, ${accent.a} 0%, ${accent.b} 100%)` : 'rgba(255,255,255,0.04)',
      color: primary ? '#fff' : '#E6E8EC', fontSize:12.5, fontWeight: primary?600:500,
      display:'flex', alignItems:'center', gap:8, cursor:'pointer',
      boxShadow: primary ? `0 0 0 1px ${accent.a}40, 0 8px 28px ${accent.a}33` : 'inset 0 1px 0 rgba(255,255,255,0.04)',
      ...(rest.style||{}),
    }}>
      {children}
      {icon && <Ic n={icon} s={12} w={2.2} />}
    </button>
  );
}

// Step 1 — Welcome (Workshop)
function WorkshopWelcome({ accent }) {
  return (
    <WorkshopChrome step={0} totalSteps={4} accent={accent}
      footerLeft={<span style={{display:'flex',alignItems:'center',gap:6}}><Ic n="shield" s={11} c="#9CA3AF" /> Local-first · your files stay on this machine</span>}
      footerRight={<>
        <button style={{ height:32, padding:'0 14px', borderRadius:8, background:'transparent', color:'#9CA3AF', border:'1px solid rgba(255,255,255,0.08)', fontSize:12, cursor:'pointer' }}>Continue without account</button>
        <WorkshopBtn primary accent={accent} icon="arrow">Get started</WorkshopBtn>
      </>}
    >
      <div style={{ padding:'42px 22px 36px', textAlign:'center', position:'relative', minHeight:380 }}>
        {/* Floating glyph collage */}
        <div style={{ position:'relative', height:140, marginBottom:24, display:'flex', justifyContent:'center', alignItems:'center', fontFamily:"'Times New Roman', serif" }}>
          {[
            { t:'τ', x:'18%', y:6,  s:54, c:accent.a, rot:-8, op:0.85 },
            { t:'∫', x:'31%', y:30, s:78, c:accent.b, rot:6,  op:0.9 },
            { t:'∑', x:'46%', y:0,  s:96, c:'#fff',   rot:0,  op:1, italic:false, weight:600 },
            { t:'∂', x:'62%', y:32, s:64, c:accent.b, rot:-6, op:0.85 },
            { t:'¶', x:'76%', y:14, s:48, c:accent.a, rot:10, op:0.8 },
          ].map((g,i)=>(
            <span key={i} style={{
              position:'absolute', left:g.x, top:g.y,
              fontSize:g.s, color:g.c, opacity:g.op, transform:`rotate(${g.rot}deg)`,
              fontStyle: g.italic===false?'normal':'italic', fontWeight:g.weight||400,
              textShadow:`0 0 30px ${g.c}55`,
            }}>{g.t}</span>
          ))}
        </div>

        <h1 style={{ fontSize:30, fontWeight:600, letterSpacing:'-0.02em', margin:'0 0 10px', textWrap:'balance' }}>
          Welcome to <span style={{ background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`, WebkitBackgroundClip:'text', backgroundClip:'text', color:'transparent' }}>Typeward</span>
        </h1>
        <p style={{ fontSize:14, color:'#9CA3AF', margin:'0 auto', maxWidth:460, lineHeight:1.55, textWrap:'pretty' }}>
          A calm editor for the documents that matter. We'll set up the engines you need
          and get you writing in under two minutes.
        </p>

        <div style={{ marginTop:30, display:'flex', gap:10, justifyContent:'center' }}>
          {[
            { i:'sigma', t:'LaTeX' },
            { i:'package', t:'Typst' },
            { i:'hash', t:'Markdown' },
            { i:'doc', t:'R Markdown' },
            { i:'globe', t:'Quarto' },
          ].map((b,i)=>(
            <div key={i} style={{
              display:'flex', alignItems:'center', gap:6, height:28, padding:'0 10px',
              borderRadius:14, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)',
              fontSize:11.5, color:'#D1D5DB',
            }}>
              <Ic n={b.i} s={11} c={accent.b} />{b.t}
            </div>
          ))}
        </div>
      </div>
    </WorkshopChrome>
  );
}

// Step 2 — Formats (Workshop)
function WorkshopFormats({ accent }) {
  const picked = new Set(['latex','typst','markdown']);
  return (
    <WorkshopChrome step={1} totalSteps={4} accent={accent}
      footerLeft={<span>3 of 5 selected · est. download <span style={{ color:'#E6E8EC', fontFamily:"'JetBrains Mono', monospace" }}>4.4 GB</span></span>}
      footerRight={<>
        <button style={{ height:32, padding:'0 14px', borderRadius:8, background:'transparent', color:'#9CA3AF', border:'1px solid rgba(255,255,255,0.08)', fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}><Ic n="back" s={11} />Back</button>
        <WorkshopBtn primary accent={accent} icon="arrow">Continue</WorkshopBtn>
      </>}
    >
      <div style={{ padding:'28px 22px 22px' }}>
        <h2 style={{ fontSize:20, fontWeight:600, letterSpacing:'-0.015em', margin:'0 0 6px' }}>What do you write?</h2>
        <p style={{ fontSize:12.5, color:'#9CA3AF', margin:'0 0 20px' }}>Pick any combination — we'll only install what you need. You can add more later.</p>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          {FORMATS.map(f=>{
            const on = picked.has(f.id);
            return (
              <div key={f.id} style={{
                position:'relative',
                borderRadius:12, padding:'14px 14px 12px',
                background: on ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                border: on ? `1px solid ${accent.a}55` : '1px solid rgba(255,255,255,0.06)',
                boxShadow: on ? `0 0 0 1px ${accent.a}33, 0 8px 24px ${accent.a}1A` : 'none',
                cursor:'pointer', transition:'all .15s',
              }}>
                {f.recommended && (
                  <div style={{ position:'absolute', top:-7, right:12, padding:'2px 8px', borderRadius:6, background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`, fontSize:9.5, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color:'#fff' }}>Recommended</div>
                )}
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{
                    width:38, height:38, borderRadius:9, display:'flex', alignItems:'center', justifyContent:'center',
                    background:`linear-gradient(135deg, ${f.color}33, ${f.color}11)`,
                    border:`1px solid ${f.color}33`,
                    fontSize:20, fontFamily:"'Times New Roman', serif", fontStyle:'italic', color:f.color, fontWeight:600,
                  }}>{f.glyph}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ fontSize:13.5, fontWeight:600 }}>{f.name}</span>
                    </div>
                    <div style={{ fontSize:11, color:'#9CA3AF', marginTop:1 }}>{f.desc}</div>
                  </div>
                  <div style={{
                    width:18, height:18, borderRadius:'50%', flexShrink:0,
                    background: on ? `linear-gradient(135deg, ${accent.a}, ${accent.b})` : 'transparent',
                    border: on ? '0' : '1.5px solid rgba(255,255,255,0.18)',
                    display:'flex', alignItems:'center', justifyContent:'center',
                  }}>
                    {on && <Ic n="check" s={10} w={3} c="#fff" />}
                  </div>
                </div>
                <div style={{ marginTop:10, paddingTop:8, borderTop:'1px solid rgba(255,255,255,0.05)', display:'flex', alignItems:'center', gap:8, fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>
                  <Ic n="package" s={9} c="#6B7280" /><span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.engine}</span>
                  <span>{f.size}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </WorkshopChrome>
  );
}

// Step 3 — Engine detect (Workshop) — mixed states
function WorkshopDetect({ accent }) {
  const rows = [
    { id:'tex', name:'TeX Live', sub:'Used for LaTeX · /usr/local/texlive/2024', state:'ok', meta:'2024.0 · pdflatex, xelatex, lualatex, biber', glyph:'τ', color:'#A78BFA' },
    { id:'typst', name:'Typst CLI', sub:'For .typ documents', state:'install', meta:'62 MB · v0.12.0 from typst.app', glyph:'§', color:'#67E8F9' },
    { id:'pandoc', name:'Pandoc', sub:'Bundled — Markdown → PDF/HTML/DOCX', state:'ok', meta:'3.1.13 · bundled with Typeward', glyph:'#', color:'#F0ABFC' },
    { id:'r', name:'R + rmarkdown', sub:'Rendering R Markdown', state:'fail', meta:"R not found in PATH · we couldn't auto-detect", glyph:'R', color:'#34D399' },
  ];
  return (
    <WorkshopChrome step={2} totalSteps={4} accent={accent}
      footerLeft={<span>3 ready · 1 to install · 1 needs attention</span>}
      footerRight={<>
        <button style={{ height:32, padding:'0 14px', borderRadius:8, background:'transparent', color:'#9CA3AF', border:'1px solid rgba(255,255,255,0.08)', fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}><Ic n="back" s={11} />Back</button>
        <WorkshopBtn primary accent={accent} icon="download">Install 1 engine</WorkshopBtn>
      </>}
    >
      <div style={{ padding:'24px 22px 18px' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:14, marginBottom:18 }}>
          <div style={{ width:36, height:36, borderRadius:9, background:`linear-gradient(135deg, ${accent.a}33, ${accent.b}22)`, border:`1px solid ${accent.a}33`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <Ic n="cpu" s={16} c={accent.a} />
          </div>
          <div>
            <h2 style={{ fontSize:18, fontWeight:600, letterSpacing:'-0.015em', margin:'0 0 4px' }}>Checking your system</h2>
            <p style={{ fontSize:12, color:'#9CA3AF', margin:0, lineHeight:1.5 }}>We scanned for the engines your formats need. Here's what we found.</p>
          </div>
          <button style={{ marginLeft:'auto', height:28, padding:'0 10px', borderRadius:7, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)', color:'#9CA3AF', fontSize:11, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}><Ic n="refresh" s={10} />Re-scan</button>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {rows.map(r=>{
            const ok = r.state==='ok', fail = r.state==='fail', inst = r.state==='install';
            const accentBorder = ok ? '#10B981' : fail ? '#F43F5E' : accent.a;
            return (
              <div key={r.id} style={{
                position:'relative', borderRadius:11, padding:'12px 14px',
                background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.05)',
                borderLeft:`2px solid ${accentBorder}`,
                display:'flex', alignItems:'center', gap:12,
              }}>
                <div style={{
                  width:32, height:32, borderRadius:8, flexShrink:0,
                  background:`linear-gradient(135deg, ${r.color}33, ${r.color}11)`, border:`1px solid ${r.color}33`,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:17, fontFamily:"'Times New Roman', serif", fontStyle:'italic', color:r.color, fontWeight:600,
                }}>{r.glyph}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                    <span style={{ fontSize:13, fontWeight:600 }}>{r.name}</span>
                    <span style={{ fontSize:11, color:'#6B7280' }}>{r.sub}</span>
                  </div>
                  <div style={{ fontSize:10.5, color: fail?'#FCA5A5':'#9CA3AF', fontFamily:"'JetBrains Mono', monospace", marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.meta}</div>
                </div>
                {ok && (
                  <div style={{ display:'flex', alignItems:'center', gap:5, padding:'4px 10px', borderRadius:14, background:'rgba(16,185,129,0.10)', color:'#A7F3D0', fontSize:11, fontWeight:500 }}>
                    <Ic n="check" s={11} w={2.5} />Ready
                  </div>
                )}
                {inst && (
                  <button style={{ height:28, padding:'0 12px', borderRadius:7, background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`, color:'#fff', border:0, fontSize:11, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}>
                    <Ic n="download" s={10} w={2.4} />Install
                  </button>
                )}
                {fail && (
                  <div style={{ display:'flex', gap:6 }}>
                    <button style={{ height:28, padding:'0 10px', borderRadius:7, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#E6E8EC', fontSize:11, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}><Ic n="folder" s={10} />Locate manually</button>
                    <button style={{ height:28, padding:'0 10px', borderRadius:7, background:'rgba(244,63,94,0.10)', border:'1px solid rgba(244,63,94,0.25)', color:'#FCA5A5', fontSize:11, cursor:'pointer' }}>Skip for now</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop:12, padding:'10px 12px', borderRadius:9, background:'rgba(245,158,11,0.06)', border:'1px solid rgba(245,158,11,0.18)', display:'flex', gap:10, alignItems:'flex-start' }}>
          <Ic n="alert" s={13} c="#FBBF24" style={{ marginTop:1 }} />
          <div style={{ fontSize:11.5, color:'#FDE68A', lineHeight:1.5, textWrap:'pretty' }}>
            <span style={{ fontWeight:600 }}>Heads up — </span>
            R wasn't detected. Install it from <span style={{ fontFamily:"'JetBrains Mono', monospace", color:'#FCD34D' }}>cran.r-project.org</span>, or skip and revisit in <span style={{ fontFamily:"'JetBrains Mono', monospace" }}>Settings → Engines</span>.
          </div>
        </div>
      </div>
    </WorkshopChrome>
  );
}

// Step 4 — Install / progress (Workshop)
function WorkshopInstall({ accent }) {
  const tasks = [
    { id:'tex',  name:'TeX Live 2024',  state:'done', size:'4.2 GB', sub:'all packages · biber · index utilities' },
    { id:'typ',  name:'Typst CLI 0.12', state:'live', size:'62 MB',  sub:'downloading from typst.app · 2.1 MB/s', pct:64 },
    { id:'pan',  name:'Pandoc 3.1.13',  state:'queued', size:'12 MB',  sub:'bundled — verifying signature' },
  ];
  return (
    <WorkshopChrome step={3} totalSteps={4} accent={accent}
      footerLeft={<span>2 of 3 done · about <span style={{color:'#E6E8EC', fontFamily:"'JetBrains Mono', monospace"}}>1m 12s</span> remaining</span>}
      footerRight={<>
        <button style={{ height:32, padding:'0 14px', borderRadius:8, background:'transparent', color:'#9CA3AF', border:'1px solid rgba(255,255,255,0.08)', fontSize:12, cursor:'pointer' }}>Run in background</button>
        <WorkshopBtn primary accent={accent} icon="arrow">Open editor</WorkshopBtn>
      </>}
    >
      <div style={{ padding:'24px 22px 18px' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:14, marginBottom:18 }}>
          <div style={{ width:36, height:36, borderRadius:9, background:`linear-gradient(135deg, ${accent.a}33, ${accent.b}22)`, border:`1px solid ${accent.a}33`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <Ic n="download" s={15} c={accent.a} />
          </div>
          <div>
            <h2 style={{ fontSize:18, fontWeight:600, letterSpacing:'-0.015em', margin:'0 0 4px' }}>Setting things up…</h2>
            <p style={{ fontSize:12, color:'#9CA3AF', margin:0, lineHeight:1.5 }}>Hang tight. You can keep using your computer — we'll let you know when it's done.</p>
          </div>
        </div>

        {/* progress list */}
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {tasks.map(t=>{
            const done = t.state==='done', live = t.state==='live';
            return (
              <div key={t.id} style={{
                borderRadius:11, padding:'12px 14px',
                background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.05)',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{
                    width:22, height:22, borderRadius:'50%', flexShrink:0,
                    background: done ? 'rgba(16,185,129,0.15)' : live ? `${accent.a}22` : 'rgba(255,255,255,0.05)',
                    border: done ? '1px solid rgba(16,185,129,0.4)' : live ? `1px solid ${accent.a}66` : '1px solid rgba(255,255,255,0.08)',
                    display:'flex', alignItems:'center', justifyContent:'center',
                  }}>
                    {done && <Ic n="check" s={11} w={2.5} c="#34D399" />}
                    {live && <span style={{ width:7, height:7, borderRadius:'50%', background:accent.a, animation:'onbpulse 1.4s ease-in-out infinite' }} />}
                    {!done && !live && <span style={{ width:5, height:5, borderRadius:'50%', background:'#6B7280' }} />}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                      <span style={{ fontSize:13, fontWeight:600 }}>{t.name}</span>
                      <span style={{ fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>{t.size}</span>
                      {live && <span style={{ marginLeft:'auto', fontSize:11, fontFamily:"'JetBrains Mono', monospace", color:accent.b }}>{t.pct}%</span>}
                      {done && <span style={{ marginLeft:'auto', fontSize:11, color:'#A7F3D0' }}>Done</span>}
                    </div>
                    <div style={{ fontSize:10.5, color:'#9CA3AF', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.sub}</div>
                  </div>
                </div>
                {live && (
                  <div style={{ marginTop:10, height:4, borderRadius:2, background:'rgba(255,255,255,0.05)', overflow:'hidden', position:'relative' }}>
                    <div style={{ width:`${t.pct}%`, height:'100%', background:`linear-gradient(90deg, ${accent.a}, ${accent.b})`, borderRadius:2, transition:'width .3s' }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* live log strip */}
        <div style={{ marginTop:14, borderRadius:10, background:'rgba(0,0,0,0.32)', border:'1px solid rgba(255,255,255,0.04)', overflow:'hidden' }}>
          <div style={{ height:26, padding:'0 12px', display:'flex', alignItems:'center', gap:6, borderBottom:'1px solid rgba(255,255,255,0.04)', fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>
            <Ic n="terminal" s={10} c="#9CA3AF" /> setup.log
            <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:5 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:'#34D399', animation:'onbpulse 1.4s ease-in-out infinite' }} />live
            </span>
          </div>
          <div style={{ padding:'8px 12px', fontFamily:"'JetBrains Mono', monospace", fontSize:10.5, lineHeight:1.6 }}>
            <div style={{ color:'#6B7280' }}>14:02:01 <span style={{ color:'#A7F3D0' }}>[ok]</span> verifying signatures (sha256)</div>
            <div style={{ color:'#6B7280' }}>14:02:02 <span style={{ color:'#A7F3D0' }}>[ok]</span> tex-live-2024 → /usr/local/texlive</div>
            <div style={{ color:'#6B7280' }}>14:02:14 <span style={{ color:'#67E8F9' }}>[get]</span> typst-0.12.0-aarch64-apple-darwin.tar.xz</div>
            <div style={{ color:'#9CA3AF' }}>14:02:18 <span style={{ color:'#67E8F9' }}>[get]</span> 39.7 MB / 62 MB · 2.1 MB/s<span style={{ display:'inline-block', width:7, height:11, marginLeft:2, background:`linear-gradient(180deg, ${accent.a}, ${accent.b})`, animation:'onbblink 1s steps(1) infinite', verticalAlign:'-1px' }} /></div>
          </div>
        </div>
      </div>
    </WorkshopChrome>
  );
}

// ───────────────────────── Direction B — "Console" ─────────────────────────
// Tighter, mono-heavy. Left progress rail. Terminal-flavored.
function ConsoleChrome({ step, totalSteps, accent, children, footerLeft, footerRight }) {
  const steps = [
    { id:0, name:'Welcome', sub:'introduction' },
    { id:1, name:'Formats', sub:'select sources' },
    { id:2, name:'Engines', sub:'detect & verify' },
    { id:3, name:'Install', sub:'fetch & link' },
  ];
  return (
    <div style={{ width:'100%', height:'100%', position:'relative', background:'#08090C', color:'#E6E8EC', fontFamily:"'Inter', system-ui, sans-serif", borderRadius:18, overflow:'hidden' }}>
      {/* subtle grid */}
      <div style={{ position:'absolute', inset:0, backgroundImage:`linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`, backgroundSize:'32px 32px', opacity:0.6, pointerEvents:'none' }} />
      <div style={{ position:'absolute', width:520, height:520, right:-160, bottom:-180, borderRadius:'50%', background:`radial-gradient(circle, ${accent.a}55 0%, transparent 65%)`, filter:'blur(110px)', opacity:0.5, pointerEvents:'none' }} />

      <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', padding:32 }}>
        <div style={{
          width:780, maxWidth:'100%', height:520, borderRadius:14,
          background:'rgba(13,15,20,0.86)', border:'1px solid rgba(255,255,255,0.06)',
          backdropFilter:'blur(28px) saturate(140%)', WebkitBackdropFilter:'blur(28px) saturate(140%)',
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.04), 0 24px 80px rgba(0,0,0,0.6)',
          display:'flex', overflow:'hidden',
        }}>
          {/* Left rail */}
          <div style={{ width:212, flexShrink:0, borderRight:'1px solid rgba(255,255,255,0.05)', display:'flex', flexDirection:'column', background:'rgba(0,0,0,0.20)' }}>
            <div style={{ height:54, padding:'0 16px', display:'flex', alignItems:'center', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ width:22, height:22, borderRadius:6, background:`linear-gradient(135deg, ${accent.b}, ${accent.a})`, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:700, fontSize:10 }}>τ</div>
              <span style={{ marginLeft:9, fontSize:12.5, fontWeight:600, letterSpacing:'-0.005em' }}>Typeward</span>
              <span style={{ marginLeft:'auto', fontSize:10, color:'#4B5563', fontFamily:"'JetBrains Mono', monospace" }}>v0.4.2</span>
            </div>
            <div style={{ padding:'14px 12px', flex:1 }}>
              <div style={{ fontSize:9.5, letterSpacing:'0.10em', textTransform:'uppercase', color:'#6B7280', padding:'0 6px 8px', fontWeight:500 }}>setup</div>
              {steps.map((s,i)=>{
                const cur = i===step, done = i<step;
                return (
                  <div key={s.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 8px', borderRadius:7, background: cur?'rgba(255,255,255,0.04)':'transparent', position:'relative' }}>
                    {cur && <div style={{ position:'absolute', left:0, top:8, bottom:8, width:2, borderRadius:1, background:`linear-gradient(180deg, ${accent.a}, ${accent.b})` }} />}
                    <div style={{
                      width:18, height:18, borderRadius:'50%', flexShrink:0,
                      background: done ? 'rgba(16,185,129,0.15)' : cur ? `${accent.a}22` : 'rgba(255,255,255,0.04)',
                      border: done ? '1px solid rgba(16,185,129,0.4)' : cur ? `1px solid ${accent.a}66` : '1px solid rgba(255,255,255,0.08)',
                      display:'flex', alignItems:'center', justifyContent:'center', fontSize:9.5, fontFamily:"'JetBrains Mono', monospace",
                      color: done ? '#34D399' : cur ? accent.a : '#6B7280', fontWeight:600,
                    }}>
                      {done ? <Ic n="check" s={9} w={3} c="#34D399" /> : i+1}
                    </div>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontSize:12, fontWeight: cur?600:500, color: cur||done?'#E6E8EC':'#9CA3AF' }}>{s.name}</div>
                      <div style={{ fontSize:10, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace", marginTop:1 }}>{s.sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding:'10px 14px', borderTop:'1px solid rgba(255,255,255,0.04)', fontSize:10, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace", display:'flex', alignItems:'center', gap:6 }}>
              <Ic n="shield" s={10} c="#6B7280" />local-first install
            </div>
          </div>

          {/* Right content */}
          <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
            <div style={{ flex:1, overflow:'auto' }}>{children}</div>
            <div style={{ height:54, padding:'0 18px', display:'flex', alignItems:'center', borderTop:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.18)' }}>
              <div style={{ fontSize:11, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>{footerLeft}</div>
              <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>{footerRight}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConsoleBtn({ children, primary, accent, icon, ...rest }) {
  return (
    <button {...rest} style={{
      height:30, padding:'0 12px',
      borderRadius:7, border: primary ? '0' : '1px solid rgba(255,255,255,0.10)',
      background: primary ? `linear-gradient(135deg, ${accent.a} 0%, ${accent.b} 100%)` : 'rgba(255,255,255,0.04)',
      color: primary ? '#fff' : '#E6E8EC', fontSize:11.5, fontWeight: primary?600:500,
      display:'flex', alignItems:'center', gap:6, cursor:'pointer',
      boxShadow: primary ? `0 0 0 1px ${accent.a}40, 0 6px 20px ${accent.a}33` : 'none',
      ...(rest.style||{}),
    }}>{children}{icon && <Ic n={icon} s={11} w={2.2} />}</button>
  );
}

function ConsoleWelcome({ accent }) {
  return (
    <ConsoleChrome step={0} totalSteps={4} accent={accent}
      footerLeft={<span style={{display:'flex', alignItems:'center', gap:5}}><span style={{width:6,height:6,borderRadius:'50%',background:'#34D399'}} />typeward.app · ready</span>}
      footerRight={<>
        <ConsoleBtn>Continue without account</ConsoleBtn>
        <ConsoleBtn primary accent={accent} icon="arrow">Begin setup</ConsoleBtn>
      </>}
    >
      <div style={{ padding:'30px 28px' }}>
        <div style={{ fontSize:10.5, fontFamily:"'JetBrains Mono', monospace", color:accent.b, letterSpacing:'0.12em', textTransform:'uppercase' }}>
          $ typeward init
        </div>
        <h1 style={{ fontSize:30, fontWeight:600, letterSpacing:'-0.025em', margin:'10px 0 8px', textWrap:'balance' }}>
          A precise editor for<br/>
          <span style={{ background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`, WebkitBackgroundClip:'text', backgroundClip:'text', color:'transparent' }}>typeset documents.</span>
        </h1>
        <p style={{ fontSize:12.5, color:'#9CA3AF', margin:'0 0 22px', maxWidth:440, lineHeight:1.55, textWrap:'pretty' }}>
          Four steps. About 90 seconds. We'll detect your toolchain, fetch what's missing,
          and link everything to your PATH — reversibly.
        </p>

        {/* Sign-in row */}
        <div style={{ display:'flex', flexDirection:'column', gap:8, maxWidth:380 }}>
          {[
            { i:'github', t:'Continue with GitHub' },
            { i:'google', t:'Continue with Google' },
            { i:'mail',   t:'Continue with email' },
          ].map((b,i)=>(
            <button key={i} style={{
              height:36, padding:'0 14px', borderRadius:8,
              background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)',
              color:'#E6E8EC', fontSize:12.5, display:'flex', alignItems:'center', gap:10, cursor:'pointer',
              transition:'background .15s',
            }}>
              <Ic n={b.i} s={14} c="#D1D5DB" />{b.t}
            </button>
          ))}
        </div>

        <div style={{ marginTop:22, display:'flex', alignItems:'center', gap:8, fontSize:10.5, fontFamily:"'JetBrains Mono', monospace", color:'#6B7280' }}>
          <Ic n="zap" s={10} c={accent.a} /><span>tip: hit <kbd style={{padding:'1px 5px', borderRadius:4, background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.06)', color:'#D1D5DB'}}>↵</kbd> to continue</span>
        </div>
      </div>
    </ConsoleChrome>
  );
}

function ConsoleFormats({ accent }) {
  const picked = new Set(['latex','typst','markdown','quarto']);
  return (
    <ConsoleChrome step={1} totalSteps={4} accent={accent}
      footerLeft={<span>$ select formats — <span style={{color:accent.b}}>4 chosen</span> · 4.6 GB</span>}
      footerRight={<>
        <ConsoleBtn icon="back">Back</ConsoleBtn>
        <ConsoleBtn primary accent={accent} icon="arrow">Detect engines</ConsoleBtn>
      </>}
    >
      <div style={{ padding:'24px 24px 18px' }}>
        <h2 style={{ fontSize:17, fontWeight:600, letterSpacing:'-0.015em', margin:'0 0 4px' }}>Source formats</h2>
        <p style={{ fontSize:11.5, color:'#9CA3AF', margin:'0 0 16px' }}>Pick what you'll be writing. Each format pulls its own toolchain — small ones are bundled.</p>

        <div style={{ display:'flex', flexDirection:'column', gap:0, borderRadius:10, border:'1px solid rgba(255,255,255,0.06)', overflow:'hidden', background:'rgba(255,255,255,0.02)' }}>
          {FORMATS.map((f,i)=>{
            const on = picked.has(f.id);
            return (
              <div key={f.id} style={{
                padding:'10px 14px', display:'flex', alignItems:'center', gap:12,
                borderBottom: i<FORMATS.length-1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                background: on ? 'rgba(255,255,255,0.025)' : 'transparent',
                cursor:'pointer',
              }}>
                <div style={{
                  width:16, height:16, borderRadius:4, flexShrink:0,
                  background: on ? `linear-gradient(135deg, ${accent.a}, ${accent.b})` : 'transparent',
                  border: on ? '0' : '1.5px solid rgba(255,255,255,0.18)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{on && <Ic n="check" s={9} w={3} c="#fff" />}</div>
                <div style={{
                  width:26, height:26, borderRadius:6, flexShrink:0,
                  background:`${f.color}1A`, border:`1px solid ${f.color}33`,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:14, fontFamily:"'Times New Roman', serif", fontStyle:'italic', color:f.color, fontWeight:600,
                }}>{f.glyph}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12.5, fontWeight:600 }}>{f.name}{f.recommended && <span style={{ marginLeft:6, fontSize:9.5, color:accent.b, fontFamily:"'JetBrains Mono', monospace" }}>· recommended</span>}</div>
                  <div style={{ fontSize:10.5, color:'#9CA3AF', fontFamily:"'JetBrains Mono', monospace", marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.engine}</div>
                </div>
                <div style={{ fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace", flexShrink:0 }}>{f.size}</div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop:14, padding:'10px 12px', borderRadius:8, background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.05)', display:'flex', alignItems:'center', gap:10 }}>
          <Ic n="folder" s={12} c={accent.b} />
          <div style={{ fontSize:11.5, color:'#D1D5DB' }}>Install location</div>
          <div style={{ marginLeft:'auto', fontSize:11, color:'#9CA3AF', fontFamily:"'JetBrains Mono', monospace" }}>~/Library/Typeward/engines</div>
          <button style={{ height:24, padding:'0 8px', borderRadius:6, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', color:'#9CA3AF', fontSize:10.5, cursor:'pointer' }}>Change</button>
        </div>
      </div>
    </ConsoleChrome>
  );
}

function ConsoleDetect({ accent }) {
  const rows = [
    { name:'tex-live',     v:'2024.0',   path:'/usr/local/texlive/2024/bin/aarch64-darwin', state:'ok' },
    { name:'pdflatex',     v:'3.141592653-2.6-1.40.26', path:'./pdflatex', state:'ok', child:true },
    { name:'biber',        v:'2.20',     path:'./biber',     state:'ok', child:true },
    { name:'typst',        v:'—',        path:'not in PATH', state:'install' },
    { name:'pandoc',       v:'3.1.13',   path:'(bundled)',   state:'ok' },
    { name:'r',            v:'—',        path:'not in PATH', state:'fail' },
    { name:'quarto',       v:'1.5.57',   path:'/opt/homebrew/bin/quarto', state:'ok' },
  ];
  return (
    <ConsoleChrome step={2} totalSteps={4} accent={accent}
      footerLeft={<span>$ scan complete — <span style={{color:'#34D399'}}>5 ok</span> · <span style={{color:accent.b}}>1 install</span> · <span style={{color:'#FCA5A5'}}>1 fail</span></span>}
      footerRight={<>
        <ConsoleBtn icon="back">Back</ConsoleBtn>
        <ConsoleBtn primary accent={accent} icon="download">Install missing (62 MB)</ConsoleBtn>
      </>}
    >
      <div style={{ padding:'22px 24px 18px' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:14 }}>
          <h2 style={{ fontSize:17, fontWeight:600, letterSpacing:'-0.015em', margin:0 }}>System detection</h2>
          <span style={{ fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>which {`<engine>`} · macOS 14.4 · arm64</span>
          <button style={{ marginLeft:'auto', height:24, padding:'0 9px', borderRadius:6, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', color:'#9CA3AF', fontSize:10.5, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}><Ic n="refresh" s={10} />Re-scan</button>
        </div>

        {/* Terminal-styled table */}
        <div style={{ borderRadius:9, background:'rgba(0,0,0,0.32)', border:'1px solid rgba(255,255,255,0.05)', overflow:'hidden', fontFamily:"'JetBrains Mono', monospace", fontSize:11.5 }}>
          <div style={{ padding:'6px 14px', borderBottom:'1px solid rgba(255,255,255,0.05)', display:'flex', gap:12, fontSize:10, color:'#6B7280', letterSpacing:'0.06em', textTransform:'uppercase' }}>
            <span style={{ width:140 }}>engine</span>
            <span style={{ width:140 }}>version</span>
            <span style={{ flex:1 }}>path</span>
            <span style={{ width:74, textAlign:'right' }}>status</span>
          </div>
          {rows.map((r,i)=>{
            const ok = r.state==='ok', fail = r.state==='fail', inst = r.state==='install';
            return (
              <div key={i} style={{
                padding:'8px 14px', display:'flex', gap:12, alignItems:'center',
                borderBottom: i<rows.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                background: fail ? 'rgba(244,63,94,0.06)' : inst ? `${accent.a}10` : 'transparent',
              }}>
                <span style={{ width:140, color: r.child ? '#9CA3AF' : '#E6E8EC' }}>
                  {r.child && <span style={{ color:'#4B5563' }}>  └─ </span>}
                  {r.name}
                </span>
                <span style={{ width:140, color: r.v==='—' ? '#6B7280' : '#D1D5DB', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.v}</span>
                <span style={{ flex:1, color: fail?'#FCA5A5':'#9CA3AF', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.path}</span>
                <span style={{ width:74, textAlign:'right' }}>
                  {ok && <span style={{ color:'#A7F3D0' }}>✓ ok</span>}
                  {inst && <span style={{ color:accent.b }}>↓ install</span>}
                  {fail && <span style={{ color:'#FCA5A5' }}>✗ missing</span>}
                </span>
              </div>
            );
          })}
        </div>

        {/* Failed-row callout */}
        <div style={{ marginTop:12, padding:'10px 12px', borderRadius:9, background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.18)', display:'flex', gap:10, alignItems:'flex-start' }}>
          <Ic n="x-circle" s={13} c="#FCA5A5" style={{ marginTop:1 }} />
          <div style={{ flex:1, fontSize:11.5, color:'#FECACA', lineHeight:1.55, textWrap:'pretty' }}>
            <span style={{ fontWeight:600 }}>R not found.</span>
            <span style={{ color:'#FCA5A5' }}> R Markdown rendering will be disabled until R is installed.</span>
            <div style={{ marginTop:6, display:'flex', gap:6 }}>
              <button style={{ height:24, padding:'0 9px', borderRadius:6, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#E6E8EC', fontSize:10.5, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}><Ic n="folder" s={10} />Browse for R…</button>
              <button style={{ height:24, padding:'0 9px', borderRadius:6, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#E6E8EC', fontSize:10.5, cursor:'pointer' }}>Open cran.r-project.org</button>
              <button style={{ height:24, padding:'0 9px', borderRadius:6, background:'transparent', color:'#9CA3AF', border:'1px solid rgba(255,255,255,0.08)', fontSize:10.5, cursor:'pointer' }}>Skip — disable .rmd</button>
            </div>
          </div>
        </div>
      </div>
    </ConsoleChrome>
  );
}

function ConsoleInstall({ accent }) {
  return (
    <ConsoleChrome step={3} totalSteps={4} accent={accent}
      footerLeft={<span>elapsed 00:34 · <span style={{color:accent.b}}>downloading 1/2</span></span>}
      footerRight={<>
        <ConsoleBtn>Pause</ConsoleBtn>
        <ConsoleBtn primary accent={accent} icon="arrow">Open editor</ConsoleBtn>
      </>}
    >
      <div style={{ padding:'22px 24px 18px' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:12 }}>
          <h2 style={{ fontSize:17, fontWeight:600, letterSpacing:'-0.015em', margin:0 }}>Install</h2>
          <span style={{ fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono', monospace" }}>fetch · verify · link</span>
          <span style={{ marginLeft:'auto', fontSize:11, fontFamily:"'JetBrains Mono', monospace", color:accent.b }}>2.1 MB/s</span>
        </div>

        {/* Aggregate bar */}
        <div style={{ marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6, fontSize:11, fontFamily:"'JetBrains Mono', monospace" }}>
            <span style={{ color:'#9CA3AF' }}>typst-0.12.0-aarch64-apple-darwin.tar.xz</span>
            <span style={{ color:'#E6E8EC' }}>39.7 / 62.0 MB · 64%</span>
          </div>
          <div style={{ height:6, borderRadius:3, background:'rgba(255,255,255,0.05)', overflow:'hidden', position:'relative' }}>
            <div style={{ width:'64%', height:'100%', background:`linear-gradient(90deg, ${accent.a}, ${accent.b})`, borderRadius:3, boxShadow:`0 0 12px ${accent.b}66` }} />
          </div>
        </div>

        {/* Live log */}
        <div style={{ borderRadius:9, background:'rgba(0,0,0,0.45)', border:'1px solid rgba(255,255,255,0.05)', overflow:'hidden' }}>
          <div style={{ height:30, padding:'0 14px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid rgba(255,255,255,0.05)', fontSize:10.5, fontFamily:"'JetBrains Mono', monospace", color:'#6B7280' }}>
            <Ic n="terminal" s={10} c="#9CA3AF" />setup.log · stream
            <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:5 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:'#34D399', animation:'onbpulse 1.4s ease-in-out infinite' }} />
              <span>tail -f</span>
            </span>
          </div>
          <div style={{ padding:'10px 14px', fontFamily:"'JetBrains Mono', monospace", fontSize:11, lineHeight:1.65, maxHeight:230, overflow:'auto' }}>
            {[
              ['14:01:54', 'init', '#9CA3AF', 'preparing engine cache at ~/Library/Typeward/engines'],
              ['14:01:55', 'ok',   '#A7F3D0', 'tex-live-2024 detected — symlinking 4 binaries'],
              ['14:01:55', 'link', '#67E8F9', '→ /usr/local/bin/pdflatex'],
              ['14:01:55', 'link', '#67E8F9', '→ /usr/local/bin/xelatex'],
              ['14:01:55', 'link', '#67E8F9', '→ /usr/local/bin/lualatex'],
              ['14:01:56', 'link', '#67E8F9', '→ /usr/local/bin/biber'],
              ['14:01:58', 'ok',   '#A7F3D0', 'pandoc 3.1.13 bundled — sha256 verified'],
              ['14:02:01', 'get',  '#FBBF24', 'fetching typst-0.12.0-aarch64-apple-darwin.tar.xz'],
              ['14:02:14', 'get',  '#FBBF24', '12.1 MB / 62 MB · 2.1 MB/s · ETA 24s'],
              ['14:02:28', 'get',  '#FBBF24', '39.7 MB / 62 MB · 2.1 MB/s · ETA 11s'],
              ['14:02:30', 'warn', '#FCD34D', 'r not in PATH — .rmd compilation disabled'],
            ].map((l,i)=>(
              <div key={i} style={{ display:'flex', gap:8 }}>
                <span style={{ color:'#4B5563', flexShrink:0 }}>{l[0]}</span>
                <span style={{ color:l[2], width:46, flexShrink:0 }}>[{l[1]}]</span>
                <span style={{ color:'#D1D5DB' }}>{l[3]}</span>
              </div>
            ))}
            <div style={{ display:'flex', gap:8 }}>
              <span style={{ color:'#4B5563' }}>14:02:35</span>
              <span style={{ color:accent.b, width:46 }}>[get]</span>
              <span style={{ color:'#E6E8EC' }}>extracting…<span style={{ display:'inline-block', width:7, height:11, marginLeft:2, background:`linear-gradient(180deg, ${accent.a}, ${accent.b})`, animation:'onbblink 1s steps(1) infinite', verticalAlign:'-1px' }} /></span>
            </div>
          </div>
        </div>
      </div>
    </ConsoleChrome>
  );
}

// ───────────────────────── Exports ─────────────────────────
Object.assign(window, {
  WorkshopWelcome, WorkshopFormats, WorkshopDetect, WorkshopInstall,
  ConsoleWelcome,  ConsoleFormats,  ConsoleDetect,  ConsoleInstall,
});
