// The sign-up page's stylesheet (served as /app.css; CSP style-src 'self').
// Tokens are the Open Artifacts tokens from the approved design, light and
// dark. Nothing here is shared with the admin SPA.
export const CSS = `
:root{color-scheme:light;--bg:#eef0f3;--chrome:#f5f6f8;--surface:#fff;--sunken:#eceef1;--divider:#e0e3e8;--border:#bec4cd;--text:#15181c;--text2:#454c56;--muted:#5f6670;--accent:#2350d0;--accent-fg:#1d45b8;--accent-soft:#e7edfc;--accent-text:#fff;--ok:#157a3a;--ok-soft:#e3f3e8;--danger:#be2f1c;--danger-soft:#fbe7e3;--warn:#8a5a00;--warn-soft:#fbf0d9;--btn:#15181c;--btn-text:#fff;--shadow:0 1px 2px rgba(20,24,30,.06),0 8px 24px rgba(20,24,30,.08)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#131518;--chrome:#17191d;--surface:#1c1f23;--sunken:#181a1e;--divider:#2c3037;--border:#3b414a;--text:#e9ebee;--text2:#b7bdc6;--muted:#9097a1;--accent:#7f9cff;--accent-fg:#a3b8ff;--accent-soft:#1f2a4a;--accent-text:#131518;--ok:#6fd08f;--ok-soft:#173022;--danger:#ff7f6b;--danger-soft:#3a1d19;--warn:#f0b955;--warn-soft:#352a12;--btn:#e9ebee;--btn-text:#131518;--shadow:0 0 0 1px #3b414a}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#131518;--chrome:#17191d;--surface:#1c1f23;--sunken:#181a1e;--divider:#2c3037;--border:#3b414a;--text:#e9ebee;--text2:#b7bdc6;--muted:#9097a1;--accent:#7f9cff;--accent-fg:#a3b8ff;--accent-soft:#1f2a4a;--accent-text:#131518;--ok:#6fd08f;--ok-soft:#173022;--danger:#ff7f6b;--danger-soft:#3a1d19;--warn:#f0b955;--warn-soft:#352a12;--btn:#e9ebee;--btn-text:#131518;--shadow:0 0 0 1px #3b414a}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--accent-fg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top{display:flex;align-items:center;gap:8px;padding:12px 16px;font-weight:700}
.top .links{margin-left:auto;font-weight:500;font-size:12.5px;color:var(--text2);display:flex;gap:6px}
.top .links a{color:var(--text2)}
.logo{width:18px;height:18px;border-radius:4px;border:2px solid var(--accent);display:grid;place-items:center;flex:none}
.logo i{width:8px;height:8px;background:var(--accent);border-radius:1px}
main{flex:1;width:100%;max-width:452px;margin:0 auto;padding:24px 16px 48px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;box-shadow:var(--shadow)}
h1{font-size:19px;line-height:1.3;margin:0 0 6px;letter-spacing:-.01em}
.panel p{color:var(--text2);margin:0 0 14px}
.nw{white-space:nowrap}
.muted{color:var(--muted)}
.small{font-size:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:38px;padding:0 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:600 13.5px/1 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none;cursor:pointer}
.btn.pri{background:var(--btn);border-color:var(--btn);color:var(--btn-text)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.link{width:auto;min-height:0;border:0;background:none;padding:0;color:var(--accent-fg);font-weight:500;text-decoration:underline}
.gsign{margin-bottom:12px}
.who{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:12px;background:var(--sunken)}
.who b{font-weight:600;overflow-wrap:anywhere}
.field{display:grid;gap:4px;margin:10px 0}
.field label{font-weight:600;font-size:12px;color:var(--text2)}
.inp{display:flex;align-items:center;border:1px solid var(--border);border-radius:6px;background:var(--surface);min-height:38px;overflow:hidden}
.inp.ok{border-color:var(--ok)}
.inp.err{border-color:var(--danger)}
.inp.off{background:var(--sunken)}
.inp input{flex:1;min-width:0;border:0;background:none;color:var(--text);font:inherit;padding:0 4px 0 10px;height:36px;outline:none}
.inp:focus-within{outline:2px solid var(--accent);outline-offset:1px}
.inp .suf{color:var(--muted);padding-right:10px;white-space:nowrap}
.help{font-size:12px;margin:0;min-height:18px;color:var(--muted)}
.help.tight:empty{min-height:0;margin-top:-4px}
.help.ok{color:var(--ok)}
.help.err{color:var(--danger)}
.sugg{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.sugg button{border:1px solid var(--border);background:var(--surface);color:var(--accent-fg);border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer}
.cta{margin-top:14px}
.ts{margin-top:12px;min-height:0}
.note{border-radius:6px;padding:8px 10px;margin:10px 0;border:1px solid var(--divider);color:var(--text)}
.note strong{display:block}
.note.bad{background:var(--danger-soft);border-color:var(--danger)}
.note.warn{background:var(--warn-soft);border-color:var(--warn)}
.note.info{background:var(--accent-soft);border-color:var(--accent)}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:16px 0}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--divider)}
.stack{display:grid;gap:10px}
.panel .mt{margin:10px 0 0}
.panel .lead{margin:4px 0 0}
.note .btn{display:flex;width:fit-content}
.ns{max-width:420px;margin:24px auto;padding:0 16px}
.state{border-top:1px solid var(--divider);margin-top:12px;padding-top:8px}
.lab{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.steps{list-style:none;margin:10px 0;padding:0;display:grid;gap:10px}
.steps li{display:grid;grid-template-columns:22px 1fr;gap:8px;align-items:start}
.dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--border);display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--muted)}
.dot.done{background:var(--ok);border-color:var(--ok);color:var(--accent-text)}
.dot.now{border-color:var(--accent);border-top-color:transparent;animation:spin 1s linear infinite}
.dot.wait{border-color:var(--warn);border-style:dashed}
.dot.fail{background:var(--danger);border-color:var(--danger);color:var(--accent-text)}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dot.now{animation:none}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:480px){.panel{padding:18px 16px}main{padding-top:12px}}
`;
