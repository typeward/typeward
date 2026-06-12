// Format-specific editor mocks. Each is a self-contained mid-fi pane:
// chrome strip (filename + format glyph + actions) → split editor / preview.
// Sized 880×580 to match the design canvas artboards.

// ───────────────────────── Inline icons ─────────────────────────
const EV_ICONS = {
  play:    "M5 4l14 8-14 8z",
  save:    "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",
  refresh: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5",
  share:   "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8 M16 6l-4-4-4 4 M12 2v13",
  search:  "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3",
  cmd:     "M9 6V3H6a3 3 0 0 0 0 6h12a3 3 0 0 0 0-6h-3v3 M9 18v3H6a3 3 0 0 0 0-6h12a3 3 0 0 0 0 6h-3v-3 M9 9v6h6V9z",
  settings:"M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  sparkles:"M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7z",
  eye:     "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  split:   "M3 4h18v16H3z M12 4v16",
  zap:     "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  download:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  more:    "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  check:   "M20 6L9 17l-5-5",
  dot:     "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
};
const EVI = ({ n, s = 13, w = 1.7, c = "currentColor", style }) => {
  const d = EV_ICONS[n] || EV_ICONS["dot"];
  const ps = d.split(/\s(?=M)/);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={{display:'inline-block',flexShrink:0,...(style||{})}} aria-hidden="true">
      {ps.map((p,i)=><path key={i} d={p} />)}
    </svg>
  );
};

// ───────────────────────── Shared chrome ─────────────────────────
function EVShell({ glyph, glyphColor, fname, fmtTag, fmtTagColor, status, actions, accent, children, footerLeft, footerRight }) {
  return (
    <div style={{
      width:'100%', height:'100%', position:'relative',
      background:'#0A0B0F', color:'#E6E8EC',
      fontFamily:"'Inter',system-ui,sans-serif",
      borderRadius:14, overflow:'hidden',
      border:'1px solid rgba(255,255,255,0.06)',
      boxShadow:'inset 0 1px 0 rgba(255,255,255,0.04), 0 18px 60px rgba(0,0,0,0.45)',
      display:'flex', flexDirection:'column',
    }}>
      {/* Ambient blob */}
      <div style={{position:'absolute',width:420,height:420,right:-140,top:-160,borderRadius:'50%',background:`radial-gradient(circle, ${accent}55 0%, transparent 65%)`,filter:'blur(110px)',opacity:0.45,pointerEvents:'none'}} />

      {/* Top chrome */}
      <div style={{height:42, padding:'0 14px', display:'flex', alignItems:'center', borderBottom:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.18)', flexShrink:0, zIndex:2, position:'relative'}}>
        <div style={{display:'flex',gap:6,marginRight:12}}>
          <div style={{width:10,height:10,borderRadius:'50%',background:'#FF5F57'}} />
          <div style={{width:10,height:10,borderRadius:'50%',background:'#FEBC2E'}} />
          <div style={{width:10,height:10,borderRadius:'50%',background:'#28C840'}} />
        </div>
        <div style={{
          width:22, height:22, borderRadius:6,
          background:`linear-gradient(135deg, ${glyphColor}33, ${glyphColor}11)`,
          border:`1px solid ${glyphColor}44`,
          display:'flex',alignItems:'center',justifyContent:'center',
          fontSize:11.5, fontWeight:700, color:glyphColor,
          fontFamily:"'JetBrains Mono',monospace", marginRight:8,
        }}>{glyph}</div>
        <span style={{fontSize:12.5, fontWeight:600, letterSpacing:'-0.005em'}}>{fname}</span>
        {fmtTag && <span style={{marginLeft:8, padding:'2px 7px', borderRadius:4, fontSize:9.5, fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', background:`${fmtTagColor}1A`, color:fmtTagColor, border:`1px solid ${fmtTagColor}33`, fontFamily:"'JetBrains Mono',monospace"}}>{fmtTag}</span>}
        {status && <span style={{marginLeft:10, fontSize:10.5, color:'#6B7280', fontFamily:"'JetBrains Mono',monospace", display:'flex', alignItems:'center', gap:5}}>{status}</span>}
        <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:5}}>
          {actions}
        </div>
      </div>

      {/* Body */}
      <div style={{flex:1, display:'flex', minHeight:0, position:'relative', zIndex:1}}>{children}</div>

      {/* Footer status bar */}
      <div style={{height:24, padding:'0 12px', display:'flex', alignItems:'center', borderTop:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.25)', fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#6B7280', flexShrink:0, gap:12, zIndex:2}}>
        <span>{footerLeft}</span>
        <span style={{marginLeft:'auto'}}>{footerRight}</span>
      </div>
    </div>
  );
}

const evActionBtn = (icon, label, accent) => (
  <button style={{
    height:24, padding:'0 9px', borderRadius:6,
    background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)',
    color:'#D1D5DB', fontSize:11, cursor:'pointer',
    display:'flex', alignItems:'center', gap:5,
  }}><EVI n={icon} s={11} c={accent || '#9CA3AF'} />{label}</button>
);
const evIconBtn = (icon, color) => (
  <button style={{
    width:24, height:24, borderRadius:6, background:'transparent', border:'0',
    color:'#9CA3AF', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
  }}><EVI n={icon} s={12} c={color || '#9CA3AF'} /></button>
);
const evRunBtn = (label, accent) => (
  <button style={{
    height:24, padding:'0 10px', borderRadius:6,
    background:`linear-gradient(135deg, ${accent.a}, ${accent.b})`,
    border:'0', color:'#fff', fontSize:11, fontWeight:600, cursor:'pointer',
    display:'flex', alignItems:'center', gap:5,
    boxShadow:`0 0 0 1px ${accent.a}33, 0 4px 14px ${accent.a}33`,
  }}><EVI n="play" s={10} c="#fff" w={2.4} />{label}</button>
);

// Shared editor pane (line numbers + tokenized lines).
function EVEditorPane({ lines, activeLine, font = "'JetBrains Mono', ui-monospace, monospace", padTop = 10 }) {
  return (
    <div style={{flex:1, display:'flex', minWidth:0, fontFamily:font, fontSize:12.5, lineHeight:'1.65', overflow:'auto', background:'rgba(0,0,0,0.10)'}}>
      <div style={{width:38, flexShrink:0, paddingTop:padTop, paddingBottom:12, textAlign:'right', userSelect:'none', color:'#4B5563', fontSize:11, paddingRight:8, borderRight:'1px solid rgba(255,255,255,0.04)'}}>
        {lines.map((_,i)=>(
          <div key={i} style={{height:'1.65em', color: i+1===activeLine?'#A78BFA':'#4B5563', fontWeight: i+1===activeLine?600:400}}>{i+1}</div>
        ))}
      </div>
      <div style={{flex:1, paddingTop:padTop, paddingLeft:12, paddingRight:14, paddingBottom:12, minWidth:0, position:'relative'}}>
        {/* Active row mark */}
        <div style={{position:'absolute',left:0,right:0,top: padTop + (activeLine-1)*1.65*12.5,height:1.65*12.5,background:'rgba(167,139,250,0.06)',borderLeft:'2px solid #A78BFA',pointerEvents:'none'}} />
        {lines.map((tokens,i)=>(
          <div key={i} style={{position:'relative', whiteSpace:'pre', minHeight:'1.65em'}}>
            {tokens.map((tk,j)=><span key={j} style={{color: tk.c || '#E6E8EC', fontStyle: tk.i?'italic':'normal', fontWeight: tk.b?600:400}}>{tk.t}</span>)}
            {i+1===activeLine && <span style={{display:'inline-block',width:1.5,height:14,background:'#A78BFA',marginLeft:1,verticalAlign:-2,animation:'evblink 1s steps(1) infinite'}} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── Markdown ─────────────────────────
function MdEditor({ accent }) {
  const A = { a:'#F0ABFC', b:'#A78BFA' };
  const lines = [
    [{c:'#5F6878', t:'---'}],
    [{c:'#A78BFA', t:'title'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"On Stochastic Gradient Flows"'}],
    [{c:'#A78BFA', t:'date'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'2026-04-02'}],
    [{c:'#A78BFA', t:'tags'}, {c:'#9CA3AF', t:': ['}, {c:'#FDE68A', t:'sde, optimization, theory'}, {c:'#9CA3AF', t:']'}],
    [{c:'#5F6878', t:'---'}],
    [{t:''}],
    [{c:'#F0ABFC', b:true, t:'# Asymptotic Behavior of Stochastic Gradient Flows'}],
    [{t:''}],
    [{c:'#E6E8EC', t:'We study the long-time behavior of solutions to the SDE'}],
    [{t:''}],
    [{c:'#67E8F9', t:'$$ dX_t = -\\nabla V(X_t)\\,dt + \\sqrt{2\\beta^{-1}}\\,dB_t $$'}],
    [{t:''}],
    [{c:'#E6E8EC', t:'under additive Brownian noise. Our '}, {c:'#A78BFA', b:true, t:'**main result**'}, {c:'#E6E8EC', t:' is exponential'}],
    [{c:'#E6E8EC', t:'convergence to the Gibbs equilibrium '}, {c:'#67E8F9', i:true, t:'*µ_β ∝ exp(-βV)*'}, {c:'#E6E8EC', t:'.'}],
    [{t:''}],
    [{c:'#F0ABFC', b:true, t:'## Contributions'}],
    [{t:''}],
    [{c:'#A78BFA', t:'1. '}, {c:'#E6E8EC', t:'A sharper rate under log-Sobolev inequalities.'}],
    [{c:'#A78BFA', t:'2. '}, {c:'#E6E8EC', t:'A coupling argument via reflected Brownian motion.'}],
    [{c:'#A78BFA', t:'3. '}, {c:'#E6E8EC', t:'Numerical verification on a 4-well potential — see '}, {c:'#67E8F9', t:'[Fig 1](#fig1)'}, {c:'#E6E8EC', t:'.'}],
    [{t:''}],
    [{c:'#F0ABFC', b:true, t:'## Code'}],
    [{t:''}],
    [{c:'#5F6878', t:'```python'}],
    [{c:'#FB7185', t:'def'}, {c:'#E6E8EC', t:' '}, {c:'#67E8F9', t:'sgld_step'}, {c:'#9CA3AF', t:'(x, lr=1e-2, beta=10):'}],
    [{c:'#9CA3AF', t:'    return x - lr*grad_V(x) + np.sqrt(2*lr/beta)*np.random.randn(*x.shape)'}],
    [{c:'#5F6878', t:'```'}],
  ];
  const status = (
    <>
      <span style={{width:6,height:6,borderRadius:'50%',background:'#34D399'}} />
      preview live
    </>
  );
  return (
    <EVShell glyph="#" glyphColor="#F0ABFC" fname="paper.md" fmtTag="markdown" fmtTagColor="#F0ABFC" status={status} accent={A.a}
      actions={<>
        {evIconBtn('search')}
        {evActionBtn('eye', 'preview', '#F0ABFC')}
        {evRunBtn('Build', A)}
      </>}
      footerLeft="utf-8 · LF · pandoc → html"
      footerRight="248 words · 6 ¶ · ln 24, col 12"
    >
      {/* Editor */}
      <div style={{flex:1, display:'flex', flexDirection:'column', borderRight:'1px solid rgba(255,255,255,0.05)', minWidth:0}}>
        {/* Format bar */}
        <div style={{height:30, padding:'0 10px', display:'flex', alignItems:'center', gap:3, borderBottom:'1px solid rgba(255,255,255,0.04)', background:'rgba(255,255,255,0.015)', flexShrink:0}}>
          {[
            {l:'B', s:{fontWeight:700}},
            {l:'I', s:{fontStyle:'italic'}},
            {l:'S', s:{textDecoration:'line-through'}},
            {l:'·', sep:true},
            {l:'H1', s:{fontSize:10}},
            {l:'H2', s:{fontSize:10}},
            {l:'≡', s:{fontSize:13}},
            {l:'·', sep:true},
            {l:'⌗', s:{fontSize:13}, hint:'code'},
            {l:'∑', s:{fontSize:13}, hint:'math'},
            {l:'⎘', s:{fontSize:13}, hint:'image'},
            {l:'⌘', s:{fontSize:11}, hint:'link'},
          ].map((b,i)=> b.sep ? (
            <div key={i} style={{width:1,height:14,background:'rgba(255,255,255,0.06)',margin:'0 4px'}} />
          ) : (
            <button key={i} style={{height:22, minWidth:22, padding:'0 6px', borderRadius:4, background:'transparent', border:'0', color:'#9CA3AF', fontSize:11, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', ...b.s}}>{b.l}</button>
          ))}
          <span style={{marginLeft:'auto', fontSize:10, color:'#6B7280', fontFamily:"'JetBrains Mono',monospace"}}>front-matter · YAML</span>
        </div>
        <EVEditorPane lines={lines} activeLine={24} />
      </div>

      {/* Preview */}
      <div style={{width:330, flexShrink:0, display:'flex', flexDirection:'column', background:'#FAFAF7', color:'#1F2937'}}>
        <div style={{height:30, padding:'0 12px', display:'flex', alignItems:'center', gap:6, borderBottom:'1px solid rgba(0,0,0,0.06)', background:'#fff', flexShrink:0, color:'#6B7280', fontSize:10.5, fontFamily:"'JetBrains Mono',monospace"}}>
          <EVI n="eye" s={11} c="#9CA3AF" />preview · paper.html
          <span style={{marginLeft:'auto', color:'#10B981', display:'flex', alignItems:'center', gap:4}}><span style={{width:5,height:5,borderRadius:'50%',background:'#10B981'}} />synced</span>
        </div>
        <div style={{flex:1, overflow:'auto', padding:'18px 22px', fontFamily:"'Inter',serif", fontSize:11.5, lineHeight:1.55, color:'#1F2937'}}>
          <div style={{fontSize:10, color:'#9CA3AF', letterSpacing:'0.04em',textTransform:'uppercase',marginBottom:6}}>Apr 2 · sde · optimization · theory</div>
          <h1 style={{fontSize:18, fontWeight:700, letterSpacing:'-0.02em', margin:'0 0 10px', lineHeight:1.2, color:'#111827'}}>Asymptotic Behavior of Stochastic Gradient Flows</h1>
          <p style={{margin:'0 0 10px'}}>We study the long-time behavior of solutions to the SDE</p>
          <div style={{padding:'8px 12px', background:'#F3F4F6', borderRadius:5, margin:'0 0 10px', fontFamily:"'Times New Roman',serif", fontStyle:'italic', textAlign:'center', fontSize:12, color:'#1F2937'}}>dX<sub>t</sub> = −∇V(X<sub>t</sub>) dt + √(2β<sup>−1</sup>) dB<sub>t</sub></div>
          <p style={{margin:'0 0 10px'}}>under additive Brownian noise. Our <strong>main result</strong> is exponential convergence to the Gibbs equilibrium <em style={{fontFamily:"'Times New Roman',serif"}}>µ<sub>β</sub> ∝ exp(−βV)</em>.</p>
          <h2 style={{fontSize:13, fontWeight:700, margin:'14px 0 6px', color:'#111827'}}>Contributions</h2>
          <ol style={{margin:'0 0 10px 18px', paddingLeft:0, color:'#374151'}}>
            <li>A sharper rate under log-Sobolev inequalities.</li>
            <li>A coupling argument via reflected Brownian motion.</li>
            <li>Numerical verification on a 4-well potential — see <span style={{color:'#7C3AED', textDecoration:'underline'}}>Fig 1</span>.</li>
          </ol>
          <h2 style={{fontSize:13, fontWeight:700, margin:'14px 0 6px', color:'#111827'}}>Code</h2>
          <pre style={{margin:0, padding:'8px 10px', background:'#1F2937', color:'#E5E7EB', borderRadius:5, fontFamily:"'JetBrains Mono',monospace", fontSize:10.5, overflow:'hidden'}}>{`def sgld_step(x, lr=1e-2, beta=10):
    return x - lr*grad_V(x) + np.sqrt(...)`}</pre>
        </div>
      </div>
    </EVShell>
  );
}

// ───────────────────────── Typst ─────────────────────────
function TypstEditor({ accent }) {
  const A = { a:'#67E8F9', b:'#A78BFA' };
  const lines = [
    [{c:'#5F6878', t:'// =============================================='}],
    [{c:'#5F6878', t:'// Stochastic gradient flows · ICML companion'}],
    [{c:'#5F6878', t:'// =============================================='}],
    [{t:''}],
    [{c:'#67E8F9', t:'#set'}, {c:'#9CA3AF', t:' page('}, {c:'#A78BFA', t:'paper'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"a4"'}, {c:'#9CA3AF', t:', '}, {c:'#A78BFA', t:'margin'}, {c:'#9CA3AF', t:': '}, {c:'#FB923C', t:'2.4cm'}, {c:'#9CA3AF', t:')'}],
    [{c:'#67E8F9', t:'#set'}, {c:'#9CA3AF', t:' text('}, {c:'#A78BFA', t:'font'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"New Computer Modern"'}, {c:'#9CA3AF', t:', '}, {c:'#A78BFA', t:'size'}, {c:'#9CA3AF', t:': '}, {c:'#FB923C', t:'10pt'}, {c:'#9CA3AF', t:')'}],
    [{c:'#67E8F9', t:'#show'}, {c:'#9CA3AF', t:' '}, {c:'#A78BFA', t:'heading'}, {c:'#9CA3AF', t:': '}, {c:'#67E8F9', t:'set'}, {c:'#9CA3AF', t:' block(below: '}, {c:'#FB923C', t:'1em'}, {c:'#9CA3AF', t:')'}],
    [{t:''}],
    [{c:'#FB7185', t:'= '}, {c:'#E6E8EC', b:true, t:'Asymptotic Behavior of Stochastic Gradient Flows'}],
    [{t:''}],
    [{c:'#9CA3AF', t:'M. Sokol, A. Khanna, J. Tashiro #h('}, {c:'#FB923C', t:'1fr'}, {c:'#9CA3AF', t:') · April 2026'}],
    [{t:''}],
    [{c:'#FB7185', t:'== '}, {c:'#E6E8EC', b:true, t:'Setting'}],
    [{t:''}],
    [{c:'#E6E8EC', t:'We consider the SDE'}],
    [{c:'#9CA3AF', t:'$ '}, {c:'#67E8F9', t:'d X_t = -nabla V(X_t) thin d t + sqrt(2 beta^(-1)) thin d B_t'}, {c:'#9CA3AF', t:' $'}],
    [{c:'#E6E8EC', t:'with potential '}, {c:'#9CA3AF', t:'$V$'}, {c:'#E6E8EC', t:' satisfying a log-Sobolev inequality.'}],
    [{t:''}],
    [{c:'#FB7185', t:'== '}, {c:'#E6E8EC', b:true, t:'Main result'}],
    [{t:''}],
    [{c:'#67E8F9', t:'#theorem'}, {c:'#9CA3AF', t:'(['}, {c:'#FDE68A', t:'Convergence Rate'}, {c:'#9CA3AF', t:'])['}],
    [{c:'#E6E8EC', t:'  Under (LSI) with constant '}, {c:'#9CA3AF', t:'$alpha$'}, {c:'#E6E8EC', t:', '}, {c:'#9CA3AF', t:'$ KL(rho_t || mu_beta) <= e^(-2 alpha t / beta) thin KL(rho_0 || mu_beta) $'}],
    [{c:'#9CA3AF', t:'])'}],
  ];
  const status = (
    <>
      <span style={{width:6,height:6,borderRadius:'50%',background:'#34D399'}} />
      compiled · 0.18s
    </>
  );
  return (
    <EVShell glyph="§" glyphColor="#67E8F9" fname="paper.typ" fmtTag="typst" fmtTagColor="#67E8F9" status={status} accent={A.a}
      actions={<>
        {evIconBtn('search')}
        {evActionBtn('zap', 'live', '#67E8F9')}
        {evRunBtn('Compile', A)}
      </>}
      footerLeft="typst 0.13.0 · live"
      footerRight="2 pages · ln 21, col 18"
    >
      {/* Editor */}
      <div style={{flex:1, display:'flex', flexDirection:'column', borderRight:'1px solid rgba(255,255,255,0.05)', minWidth:0}}>
        <div style={{height:30, padding:'0 10px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid rgba(255,255,255,0.04)', background:'rgba(255,255,255,0.015)', flexShrink:0}}>
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#9CA3AF'}}>main.typ</span>
          <span style={{width:1,height:14,background:'rgba(255,255,255,0.06)'}} />
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#6B7280'}}>theorem.typ</span>
          <span style={{marginLeft:'auto', display:'flex', gap:5, alignItems:'center', fontSize:10, color:'#6B7280', fontFamily:"'JetBrains Mono',monospace"}}>
            <span style={{width:5,height:5,borderRadius:'50%',background:'#34D399'}} />
            auto-recompile
          </span>
        </div>
        <EVEditorPane lines={lines} activeLine={21} />
      </div>

      {/* Preview */}
      <div style={{width:300, flexShrink:0, display:'flex', flexDirection:'column', background:'#1A1A1F'}}>
        <div style={{height:30, padding:'0 12px', display:'flex', alignItems:'center', gap:6, borderBottom:'1px solid rgba(255,255,255,0.05)', background:'rgba(0,0,0,0.20)', flexShrink:0, color:'#9CA3AF', fontSize:10.5, fontFamily:"'JetBrains Mono',monospace"}}>
          <EVI n="eye" s={11} c="#9CA3AF" />preview · 1 / 2
          <span style={{marginLeft:'auto', color:'#67E8F9'}}>180 ms</span>
        </div>
        <div style={{flex:1, overflow:'auto', padding:'14px 12px', display:'flex', justifyContent:'center'}}>
          <div style={{width:230, background:'#FBFAF6', boxShadow:'0 4px 16px rgba(0,0,0,0.5)', padding:'18px 18px', fontFamily:"'Times New Roman',serif", color:'#111827', fontSize:8.5, lineHeight:1.45}}>
            <div style={{fontSize:11, fontWeight:600, textAlign:'center', letterSpacing:'-0.01em', marginBottom:6}}>Asymptotic Behavior of Stochastic Gradient Flows</div>
            <div style={{display:'flex', fontSize:7.5, color:'#374151', marginBottom:10}}>
              <span>M. Sokol, A. Khanna, J. Tashiro</span>
              <span style={{marginLeft:'auto'}}>April 2026</span>
            </div>
            <div style={{fontSize:9, fontWeight:700, marginBottom:4}}>1 · Setting</div>
            <p style={{margin:'0 0 6px'}}>We consider the SDE</p>
            <div style={{textAlign:'center', fontStyle:'italic', margin:'0 0 6px', fontSize:9}}>dX<sub>t</sub> = −∇V(X<sub>t</sub>) dt + √(2β<sup>−1</sup>) dB<sub>t</sub></div>
            <p style={{margin:'0 0 8px'}}>with potential V satisfying a log-Sobolev inequality.</p>
            <div style={{fontSize:9, fontWeight:700, marginBottom:4}}>2 · Main result</div>
            <div style={{padding:'5px 7px', background:'#F3F4F6', border:'1px solid #E5E7EB', borderLeft:'2px solid #67E8F9', fontStyle:'italic'}}>
              <span style={{fontWeight:700, fontStyle:'normal'}}>Theorem 2.1 (Convergence Rate). </span>
              Under (LSI) with constant α,
              <div style={{textAlign:'center', margin:'4px 0', fontSize:8.5}}>KL(ρ<sub>t</sub> ‖ µ<sub>β</sub>) ≤ e<sup>−2αt/β</sup> KL(ρ<sub>0</sub> ‖ µ<sub>β</sub>)</div>
            </div>
            <div style={{textAlign:'center', marginTop:14, fontSize:7, color:'#9CA3AF'}}>1</div>
          </div>
        </div>
      </div>
    </EVShell>
  );
}

// ───────────────────────── R Markdown ─────────────────────────
function RmdEditor({ accent }) {
  const A = { a:'#34D399', b:'#67E8F9' };
  const lines = [
    [{c:'#5F6878', t:'---'}],
    [{c:'#A78BFA', t:'title'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"Reproducible Power Analysis"'}],
    [{c:'#A78BFA', t:'author'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"A. Khanna"'}],
    [{c:'#A78BFA', t:'output'}, {c:'#9CA3AF', t:':'}],
    [{c:'#9CA3AF', t:'  '}, {c:'#A78BFA', t:'html_document'}, {c:'#9CA3AF', t:':'}],
    [{c:'#9CA3AF', t:'    '}, {c:'#A78BFA', t:'toc'}, {c:'#9CA3AF', t:': '}, {c:'#FB923C', t:'true'}],
    [{c:'#9CA3AF', t:'    '}, {c:'#A78BFA', t:'theme'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'flatly'}],
    [{c:'#5F6878', t:'---'}],
    [{t:''}],
    [{c:'#34D399', b:true, t:'## Setup'}],
    [{t:''}],
    [{c:'#5F6878', t:'```{r setup, include=FALSE}'}],
    [{c:'#67E8F9', t:'library'}, {c:'#9CA3AF', t:'(tidyverse)'}],
    [{c:'#67E8F9', t:'library'}, {c:'#9CA3AF', t:'(pwr)'}],
    [{c:'#A78BFA', t:'set.seed'}, {c:'#9CA3AF', t:'('}, {c:'#FB923C', t:'42'}, {c:'#9CA3AF', t:')'}],
    [{c:'#5F6878', t:'```'}],
    [{t:''}],
    [{c:'#34D399', b:true, t:'## Effect-size sweep'}],
    [{t:''}],
    [{c:'#E6E8EC', t:'We sweep Cohen\'s '}, {c:'#67E8F9', t:'`d`'}, {c:'#E6E8EC', t:' from 0.1 → 0.8.'}],
    [{t:''}],
    [{c:'#5F6878', t:'```{r sweep, fig.width=6, fig.height=3.4}'}],
    [{c:'#9CA3AF', t:'effects '}, {c:'#FB7185', t:'<- '}, {c:'#A78BFA', t:'seq'}, {c:'#9CA3AF', t:'('}, {c:'#FB923C', t:'0.1'}, {c:'#9CA3AF', t:', '}, {c:'#FB923C', t:'0.8'}, {c:'#9CA3AF', t:', by='}, {c:'#FB923C', t:'0.05'}, {c:'#9CA3AF', t:')'}],
    [{c:'#9CA3AF', t:'sims '}, {c:'#FB7185', t:'<- '}, {c:'#A78BFA', t:'map_dbl'}, {c:'#9CA3AF', t:'(effects, ~'}, {c:'#A78BFA', t:'pwr.t.test'}, {c:'#9CA3AF', t:'(d=.x, power=.8)$n)'}],
    [{c:'#9CA3AF', t:'tibble(d=effects, n=sims) '}, {c:'#FB7185', t:'%>%'}],
    [{c:'#9CA3AF', t:'  '}, {c:'#A78BFA', t:'ggplot'}, {c:'#9CA3AF', t:'(aes(d, n)) + '}, {c:'#A78BFA', t:'geom_line'}, {c:'#9CA3AF', t:'(color='}, {c:'#FDE68A', t:'"#0F766E"'}, {c:'#9CA3AF', t:')'}],
    [{c:'#5F6878', t:'```'}],
  ];
  const status = (
    <>
      <span style={{width:6,height:6,borderRadius:'50%',background:'#34D399'}} />
      knit · ok
    </>
  );
  return (
    <EVShell glyph="R" glyphColor="#34D399" fname="power-analysis.Rmd" fmtTag="r-markdown" fmtTagColor="#34D399" status={status} accent={A.a}
      actions={<>
        {evIconBtn('search')}
        {evActionBtn('play', 'run chunk', '#34D399')}
        {evRunBtn('Knit', A)}
      </>}
      footerLeft="R 4.4.2 · knitr 1.50 · workspace: 14 objs"
      footerRight="ln 24 · UTF-8 · 138 lines"
    >
      {/* Editor + chunk gutter feel */}
      <div style={{flex:1, display:'flex', flexDirection:'column', borderRight:'1px solid rgba(255,255,255,0.05)', minWidth:0}}>
        <div style={{height:30, padding:'0 10px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid rgba(255,255,255,0.04)', background:'rgba(52,211,153,0.05)', flexShrink:0}}>
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#34D399', fontWeight:600}}>● Source</span>
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#6B7280'}}>Visual</span>
          <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:6}}>
            <button style={{height:20, padding:'0 7px', borderRadius:4, background:'rgba(52,211,153,0.10)', border:'1px solid rgba(52,211,153,0.30)', color:'#34D399', fontSize:10, fontFamily:"'JetBrains Mono',monospace", cursor:'pointer', display:'flex', gap:3, alignItems:'center'}}>▶ chunk</button>
            <button style={{height:20, padding:'0 7px', borderRadius:4, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#9CA3AF', fontSize:10, fontFamily:"'JetBrains Mono',monospace", cursor:'pointer'}}>⤓ all above</button>
          </div>
        </div>
        <EVEditorPane lines={lines} activeLine={24} />
      </div>

      {/* Preview pane = console + plot */}
      <div style={{width:340, flexShrink:0, display:'flex', flexDirection:'column', background:'#FAFAF7', color:'#1F2937'}}>
        <div style={{height:30, padding:'0 12px', display:'flex', alignItems:'center', gap:6, borderBottom:'1px solid rgba(0,0,0,0.06)', background:'#fff', flexShrink:0, color:'#6B7280', fontSize:10.5, fontFamily:"'JetBrains Mono',monospace"}}>
          Console
          <span style={{marginLeft:8, color:'#1F2937', fontWeight:600}}>Plots</span>
          <span style={{marginLeft:8}}>Help</span>
          <span style={{marginLeft:'auto'}}>● R 4.4.2</span>
        </div>
        <div style={{flex:1, overflow:'auto', padding:'10px 14px'}}>
          {/* mini plot */}
          <div style={{background:'#fff', border:'1px solid rgba(0,0,0,0.08)', borderRadius:6, padding:'10px 10px 6px'}}>
            <div style={{fontSize:9.5, color:'#6B7280', marginBottom:4, fontFamily:"'JetBrains Mono',monospace"}}># sample size vs effect size · power = 0.80</div>
            <svg viewBox="0 0 240 120" style={{width:'100%', height:120, display:'block'}}>
              {/* grid */}
              {[20,40,60,80,100].map(y=><line key={y} x1="22" x2="232" y1={y} y2={y} stroke="#F3F4F6" strokeWidth="0.6" />)}
              <line x1="22" y1="10" x2="22" y2="100" stroke="#9CA3AF" strokeWidth="0.6" />
              <line x1="22" y1="100" x2="232" y2="100" stroke="#9CA3AF" strokeWidth="0.6" />
              {/* curve: n ~ 1/d^2 mapped */}
              <path d="M 30 14 Q 60 22 90 40 T 160 78 T 224 92" fill="none" stroke="#0F766E" strokeWidth="1.6" strokeLinecap="round" />
              {[
                [30,14],[50,18],[70,30],[90,42],[120,60],[150,76],[180,84],[210,90],
              ].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="1.6" fill="#0F766E" />)}
              {/* axes labels */}
              <text x="22" y="116" fontSize="6.5" fill="#6B7280" fontFamily="'JetBrains Mono',monospace">0.1</text>
              <text x="220" y="116" fontSize="6.5" fill="#6B7280" fontFamily="'JetBrains Mono',monospace">0.8 (d)</text>
              <text x="2" y="14" fontSize="6.5" fill="#6B7280" fontFamily="'JetBrains Mono',monospace">800</text>
              <text x="6" y="100" fontSize="6.5" fill="#6B7280" fontFamily="'JetBrains Mono',monospace">20</text>
            </svg>
          </div>
          {/* console output */}
          <div style={{marginTop:10, padding:'8px 10px', background:'#0F172A', color:'#E5E7EB', borderRadius:6, fontFamily:"'JetBrains Mono',monospace", fontSize:10, lineHeight:1.55}}>
            <div style={{color:'#67E8F9'}}>{`> head(tibble(d=effects, n=sims), 4)`}</div>
            <div style={{color:'#9CA3AF'}}>{`# A tibble: 4 × 2`}</div>
            <div style={{color:'#9CA3AF'}}>{`      d     n`}</div>
            <div style={{color:'#9CA3AF'}}>{`  <dbl> <dbl>`}</div>
            <div>{`1  0.10  786.`}</div>
            <div>{`2  0.15  351.`}</div>
            <div>{`3  0.20  199.`}</div>
            <div>{`4  0.25  128.`}</div>
            <div style={{color:'#34D399', marginTop:3}}>{`✓ chunk \`sweep\` · 0.34s`}</div>
          </div>
        </div>
      </div>
    </EVShell>
  );
}

// ───────────────────────── Quarto ─────────────────────────
function QuartoEditor({ accent }) {
  const A = { a:'#FBBF24', b:'#FB7185' };
  const lines = [
    [{c:'#5F6878', t:'---'}],
    [{c:'#A78BFA', t:'title'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"Q1 2026 — Onboarding Funnel"'}],
    [{c:'#A78BFA', t:'author'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'"Growth Analytics"'}],
    [{c:'#A78BFA', t:'format'}, {c:'#9CA3AF', t:':'}],
    [{c:'#9CA3AF', t:'  '}, {c:'#A78BFA', t:'html'}, {c:'#9CA3AF', t:':'}],
    [{c:'#9CA3AF', t:'    '}, {c:'#A78BFA', t:'theme'}, {c:'#9CA3AF', t:': '}, {c:'#FDE68A', t:'cosmo'}],
    [{c:'#9CA3AF', t:'    '}, {c:'#A78BFA', t:'code-fold'}, {c:'#9CA3AF', t:': '}, {c:'#FB923C', t:'show'}],
    [{c:'#A78BFA', t:'execute'}, {c:'#9CA3AF', t:':'}],
    [{c:'#9CA3AF', t:'  '}, {c:'#A78BFA', t:'cache'}, {c:'#9CA3AF', t:': '}, {c:'#FB923C', t:'true'}],
    [{c:'#5F6878', t:'---'}],
    [{t:''}],
    [{c:'#FBBF24', b:true, t:'## Activation rate by cohort'}],
    [{t:''}],
    [{c:'#5F6878', t:'```{python}'}],
    [{c:'#5F6878', t:'#| label: fig-funnel'}],
    [{c:'#5F6878', t:'#| fig-cap: "Activation across the Q1 cohorts."'}],
    [{c:'#FB7185', t:'import'}, {c:'#9CA3AF', t:' '}, {c:'#67E8F9', t:'polars'}, {c:'#9CA3AF', t:' as '}, {c:'#67E8F9', t:'pl'}],
    [{c:'#FB7185', t:'import'}, {c:'#9CA3AF', t:' '}, {c:'#67E8F9', t:'altair'}, {c:'#9CA3AF', t:' as '}, {c:'#67E8F9', t:'alt'}],
    [{t:''}],
    [{c:'#9CA3AF', t:'df = pl.read_parquet('}, {c:'#FDE68A', t:'"events.parquet"'}, {c:'#9CA3AF', t:')'}],
    [{c:'#9CA3AF', t:'agg = (df.group_by('}, {c:'#FDE68A', t:'"cohort"'}, {c:'#9CA3AF', t:').agg(pl.col('}, {c:'#FDE68A', t:'"activated"'}, {c:'#9CA3AF', t:').mean()))'}],
    [{c:'#9CA3AF', t:'alt.Chart(agg).mark_bar().encode('}, {c:'#A78BFA', t:'x='}, {c:'#FDE68A', t:'"cohort"'}, {c:'#9CA3AF', t:', '}, {c:'#A78BFA', t:'y='}, {c:'#FDE68A', t:'"activated"'}, {c:'#9CA3AF', t:')'}],
    [{c:'#5F6878', t:'```'}],
    [{t:''}],
    [{c:'#FBBF24', b:true, t:'## Takeaways'}],
    [{t:''}],
    [{c:'#A78BFA', t:'- '}, {c:'#E6E8EC', t:'Cohorts shipped post-Feb 14 activate 22% faster.'}],
    [{c:'#A78BFA', t:'- '}, {c:'#E6E8EC', t:'See @fig-funnel for the full breakdown.'}],
  ];
  const status = (
    <>
      <span style={{width:6,height:6,borderRadius:'50%',background:'#FBBF24'}} />
      python · jupyter
    </>
  );
  return (
    <EVShell glyph="Q" glyphColor="#FBBF24" fname="q1-funnel.qmd" fmtTag="quarto" fmtTagColor="#FBBF24" status={status} accent={A.a}
      actions={<>
        {evIconBtn('search')}
        {evActionBtn('eye', 'preview', '#FBBF24')}
        {evRunBtn('Render', A)}
      </>}
      footerLeft="quarto 1.6.40 · python 3.12 · cache: 4 chunks"
      footerRight="ln 21 · 4 cells · UTF-8"
    >
      {/* Editor */}
      <div style={{flex:1, display:'flex', flexDirection:'column', borderRight:'1px solid rgba(255,255,255,0.05)', minWidth:0}}>
        <div style={{height:30, padding:'0 10px', display:'flex', alignItems:'center', gap:6, borderBottom:'1px solid rgba(255,255,255,0.04)', background:'rgba(251,191,36,0.05)', flexShrink:0}}>
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#FBBF24', fontWeight:600}}>● Source</span>
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#6B7280'}}>Visual</span>
          <span style={{width:1,height:14,background:'rgba(255,255,255,0.06)',marginLeft:4}} />
          <span style={{fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:'#9CA3AF'}}>format: html · pdf · revealjs</span>
          <button style={{marginLeft:'auto', height:20, padding:'0 7px', borderRadius:4, background:'rgba(251,191,36,0.10)', border:'1px solid rgba(251,191,36,0.30)', color:'#FBBF24', fontSize:10, fontFamily:"'JetBrains Mono',monospace", cursor:'pointer'}}>▶ run cell</button>
        </div>
        <EVEditorPane lines={lines} activeLine={21} />
      </div>

      {/* Preview */}
      <div style={{width:330, flexShrink:0, display:'flex', flexDirection:'column', background:'#FFFFFF', color:'#1F2937'}}>
        <div style={{height:30, padding:'0 12px', display:'flex', alignItems:'center', gap:6, borderBottom:'1px solid rgba(0,0,0,0.06)', flexShrink:0, color:'#6B7280', fontSize:10.5, fontFamily:"'JetBrains Mono',monospace"}}>
          <EVI n="eye" s={11} c="#9CA3AF" />q1-funnel.html
          <span style={{marginLeft:'auto', color:'#FBBF24'}}>● rendered 0.6s ago</span>
        </div>
        <div style={{flex:1, overflow:'auto', padding:'14px 18px', fontFamily:"'Inter',sans-serif", fontSize:11, lineHeight:1.55, color:'#1F2937'}}>
          <div style={{fontSize:9.5, color:'#9CA3AF', letterSpacing:'0.04em',textTransform:'uppercase'}}>Growth Analytics · 02 Apr 2026</div>
          <h1 style={{fontSize:16, fontWeight:700, margin:'4px 0 12px', letterSpacing:'-0.015em', color:'#0F172A'}}>Q1 2026 — Onboarding Funnel</h1>
          <h2 style={{fontSize:12.5, fontWeight:700, margin:'0 0 6px', color:'#0F172A'}}>Activation rate by cohort</h2>
          {/* chart */}
          <div style={{padding:'10px 12px', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6}}>
            <svg viewBox="0 0 280 110" style={{width:'100%', display:'block'}}>
              <line x1="30" y1="92" x2="270" y2="92" stroke="#94A3B8" strokeWidth="0.7" />
              <line x1="30" y1="10" x2="30" y2="92" stroke="#94A3B8" strokeWidth="0.7" />
              {[
                {x:46, h:34, l:'Jan W1'},
                {x:84, h:42, l:'Jan W3'},
                {x:122, h:51, l:'Feb W1'},
                {x:160, h:48, l:'Feb W3'},
                {x:198, h:62, l:'Mar W1'},
                {x:236, h:71, l:'Mar W3'},
              ].map((b,i)=>(
                <g key={i}>
                  <rect x={b.x-12} y={92-b.h} width={24} height={b.h} fill={i>=4?'#F59E0B':'#94A3B8'} rx="1" />
                  <text x={b.x} y="104" fontSize="6.5" fill="#475569" textAnchor="middle" fontFamily="'Inter',sans-serif">{b.l}</text>
                </g>
              ))}
              <text x="14" y="14" fontSize="6.5" fill="#475569" fontFamily="'Inter',sans-serif">80%</text>
              <text x="18" y="92" fontSize="6.5" fill="#475569" fontFamily="'Inter',sans-serif">0%</text>
            </svg>
            <div style={{fontSize:9, color:'#64748B', marginTop:4, fontStyle:'italic', textAlign:'center'}}>Figure 1: Activation across the Q1 cohorts.</div>
          </div>
          <h2 style={{fontSize:12.5, fontWeight:700, margin:'12px 0 4px', color:'#0F172A'}}>Takeaways</h2>
          <ul style={{margin:'0 0 0 16px', padding:0, color:'#334155'}}>
            <li>Cohorts shipped post-Feb 14 activate <strong>22% faster</strong>.</li>
            <li>See <span style={{color:'#0EA5E9'}}>Figure 1</span> for the full breakdown.</li>
          </ul>
        </div>
      </div>
    </EVShell>
  );
}

// ───────────────────────── Jupyter ─────────────────────────
function JupyterEditor({ accent }) {
  const A = { a:'#FB923C', b:'#FB7185' };
  return (
    <EVShell glyph="J" glyphColor="#FB923C" fname="exploration.ipynb" fmtTag="jupyter" fmtTagColor="#FB923C"
      status={<><span style={{width:6,height:6,borderRadius:'50%',background:'#34D399'}} />kernel: python 3.12</>}
      accent={A.a}
      actions={<>
        {evIconBtn('save')}
        {evActionBtn('refresh', 'restart', '#FB923C')}
        {evRunBtn('Run all', A)}
      </>}
      footerLeft="ipykernel · 4 cells · idle"
      footerRight="cell [3] · edit"
    >
      <div style={{flex:1, display:'flex', flexDirection:'column', minWidth:0, overflow:'auto', padding:'12px 14px', gap:10, background:'rgba(0,0,0,0.10)'}}>
        {/* Cell 1: markdown */}
        <div style={{display:'flex', gap:8}}>
          <div style={{width:50, flexShrink:0, paddingTop:8, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:'#6B7280', textAlign:'right'}}>md</div>
          <div style={{flex:1, padding:'8px 12px', borderRadius:6, background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.06)', borderLeft:'2px solid rgba(255,255,255,0.10)'}}>
            <div style={{fontSize:14, fontWeight:700, color:'#E6E8EC', letterSpacing:'-0.015em'}}># SGLD on a 4-well potential</div>
            <div style={{fontSize:11.5, color:'#9CA3AF', marginTop:3}}>Quick numerical check that our convergence rate matches the empirical decay.</div>
          </div>
        </div>

        {/* Cell 2: imports */}
        <div style={{display:'flex', gap:8}}>
          <div style={{width:50, flexShrink:0, paddingTop:8, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:'#A78BFA', textAlign:'right'}}>In [1]</div>
          <div style={{flex:1, padding:'8px 12px', borderRadius:6, background:'rgba(0,0,0,0.30)', border:'1px solid rgba(255,255,255,0.06)', borderLeft:'2px solid #FB923C', fontFamily:"'JetBrains Mono',monospace", fontSize:11.5, lineHeight:1.55}}>
            <div><span style={{color:'#FB7185'}}>import</span> <span style={{color:'#67E8F9'}}>numpy</span> <span style={{color:'#FB7185'}}>as</span> <span style={{color:'#67E8F9'}}>np</span></div>
            <div><span style={{color:'#FB7185'}}>import</span> <span style={{color:'#67E8F9'}}>matplotlib.pyplot</span> <span style={{color:'#FB7185'}}>as</span> <span style={{color:'#67E8F9'}}>plt</span></div>
            <div><span style={{color:'#9CA3AF'}}>rng = np.random.default_rng(</span><span style={{color:'#FB923C'}}>0</span><span style={{color:'#9CA3AF'}}>)</span></div>
          </div>
        </div>

        {/* Cell 3: code + active */}
        <div style={{display:'flex', gap:8}}>
          <div style={{width:50, flexShrink:0, paddingTop:8, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:'#A78BFA', textAlign:'right'}}>In [3]</div>
          <div style={{flex:1, padding:'8px 12px', borderRadius:6, background:'rgba(0,0,0,0.30)', border:'1px solid rgba(251,146,60,0.40)', boxShadow:'0 0 0 1px rgba(251,146,60,0.20)', borderLeft:'2px solid #FB923C', fontFamily:"'JetBrains Mono',monospace", fontSize:11.5, lineHeight:1.55}}>
            <div><span style={{color:'#FB7185'}}>def</span> <span style={{color:'#67E8F9'}}>sgld</span><span style={{color:'#9CA3AF'}}>(x0, lr=</span><span style={{color:'#FB923C'}}>1e-2</span><span style={{color:'#9CA3AF'}}>, beta=</span><span style={{color:'#FB923C'}}>10</span><span style={{color:'#9CA3AF'}}>, T=</span><span style={{color:'#FB923C'}}>5000</span><span style={{color:'#9CA3AF'}}>):</span></div>
            <div><span style={{color:'#9CA3AF'}}>{'    xs = [x0]'}</span></div>
            <div><span style={{color:'#9CA3AF'}}>{'    for _ in range(T):'}</span></div>
            <div><span style={{color:'#9CA3AF'}}>{'        x = xs[-1] - lr*grad_V(xs[-1]) + np.sqrt(2*lr/beta)*rng.standard_normal()'}</span><span style={{display:'inline-block',width:7,height:11,background:'#A78BFA',marginLeft:2,verticalAlign:-1,animation:'evblink 1s steps(1) infinite'}} /></div>
            <div><span style={{color:'#9CA3AF'}}>{'        xs.append(x)'}</span></div>
            <div><span style={{color:'#FB7185'}}>    return</span><span style={{color:'#9CA3AF'}}> np.array(xs)</span></div>
          </div>
        </div>

        {/* Cell 3 output */}
        <div style={{display:'flex', gap:8}}>
          <div style={{width:50, flexShrink:0, paddingTop:6, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:'#FB7185', textAlign:'right'}}>Out[3]</div>
          <div style={{flex:1, padding:'8px 10px', borderRadius:6, background:'#FFFFFF'}}>
            <svg viewBox="0 0 360 110" style={{width:'100%', display:'block'}}>
              <line x1="32" y1="94" x2="350" y2="94" stroke="#94A3B8" strokeWidth="0.6" />
              <line x1="32" y1="6" x2="32" y2="94" stroke="#94A3B8" strokeWidth="0.6" />
              {/* histogram-ish trace */}
              <path d="M 32 70 L 60 60 L 90 65 L 120 38 L 150 28 L 180 32 L 210 22 L 240 28 L 270 18 L 300 14 L 340 10" fill="none" stroke="#FB923C" strokeWidth="1.4" />
              <path d="M 32 70 L 60 60 L 90 65 L 120 38 L 150 28 L 180 32 L 210 22 L 240 28 L 270 18 L 300 14 L 340 10 L 340 94 L 32 94 Z" fill="#FB923C22" />
              <text x="36" y="14" fontSize="7" fill="#475569" fontFamily="'Inter',sans-serif">trajectory · ‖x_t − µ‖ over 5000 steps</text>
            </svg>
          </div>
        </div>

        {/* Cell 4: empty */}
        <div style={{display:'flex', gap:8}}>
          <div style={{width:50, flexShrink:0, paddingTop:8, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:'#6B7280', textAlign:'right'}}>In [ ]</div>
          <div style={{flex:1, padding:'10px 12px', borderRadius:6, background:'rgba(255,255,255,0.02)', border:'1px dashed rgba(255,255,255,0.10)', fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'#4B5563', display:'flex', alignItems:'center', gap:6}}>
            <EVI n="sparkles" s={11} c="#67E8F9" />
            <span>Add the next cell — fit an exponential decay…</span>
          </div>
        </div>
      </div>
    </EVShell>
  );
}

// ───────────────────────── Exports ─────────────────────────
Object.assign(window, { MdEditor, TypstEditor, RmdEditor, QuartoEditor, JupyterEditor });
