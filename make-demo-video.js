// Generates demo.mp4 — an animated MD->PDF demo for social posts.
// Renders frames in Chromium (already downloaded by the extension) and
// encodes them to an H.264 MP4 with the bundled ffmpeg-static binary.
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const MarkdownIt = require('markdown-it');
const puppeteer = require('puppeteer');
const browsers = require('@puppeteer/browsers');
const ffmpegPath = require('ffmpeg-static');

const W = 1280, H = 720, FPS = 24, SECONDS = 11;
const N = FPS * SECONDS;
const FRAME_DIR = '.demo-frames';

const sampleMd = `# Project Report

Convert **Markdown** into a
clean, styled _PDF_ in one click.

## Highlights
- Code, tables & images
- GitHub-style formatting
- Saves next to your file

\`\`\`js
const pdf = convert(md);
\`\`\`
`;

const pageCss = `
  body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.6;color:#24292e;margin:0}
  h1{font-size:26px;margin:0 0 10px;border-bottom:1px solid #eaecef;padding-bottom:8px}
  h2{font-size:20px;margin:18px 0 8px}
  pre{background:#f6f8fa;padding:12px;border-radius:6px;font-family:SFMono-Regular,Consolas,monospace;font-size:13px}
  code{font-family:SFMono-Regular,Consolas,monospace}
  ul{padding-left:20px}
`;
const renderedPdf = new MarkdownIt().render(sampleMd);

function buildHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;
    font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#1e1e1e}
  .app{width:${W}px;height:${H}px;position:relative;background:#1e1e1e;display:flex;flex-direction:column}
  .titlebar{height:40px;background:#323233;display:flex;align-items:center;padding:0 14px;gap:8px;flex:0 0 auto}
  .dot{width:12px;height:12px;border-radius:50%}
  .ttl{color:#cfcfcf;font-size:13px;margin-left:10px}
  .tabbar{height:36px;background:#252526;display:flex;flex:0 0 auto}
  .tab{display:flex;align-items:center;gap:8px;padding:0 16px;background:#1e1e1e;color:#d7d7d7;font-size:13px;border-top:2px solid #6d4aff}
  .stage{flex:1;position:relative;overflow:hidden}
  .editor{position:absolute;inset:0;padding:22px 26px;color:#d4d4d4;
    font-family:SFMono-Regular,Consolas,monospace;font-size:17px;line-height:1.7;white-space:pre-wrap}
  .kw{color:#569cd6}.h{color:#4ec9b0}.str{color:#ce9178}.mut{color:#6a9955}
  .caret{display:inline-block;width:9px;height:20px;background:#aeafad;vertical-align:-3px;margin-left:1px}
  .menu{position:absolute;background:#252526;border:1px solid #454545;border-radius:6px;
    box-shadow:0 8px 28px rgba(0,0,0,.5);padding:6px 0;font-size:13px;color:#cccccc;width:230px}
  .mi{padding:6px 14px}.mi.sep{border-top:1px solid #3a3a3a;margin:5px 0;padding:0}
  .mi.hot{background:#6d4aff;color:#fff}
  .cursor{position:absolute;width:20px;height:20px;z-index:50;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}
  .toast{position:absolute;right:20px;bottom:20px;background:#252526;border:1px solid #454545;
    border-radius:8px;padding:12px 16px;color:#eee;font-size:13px;display:flex;align-items:center;gap:10px;
    box-shadow:0 8px 28px rgba(0,0,0,.5)}
  .spin{width:14px;height:14px;border:2px solid #6d4aff;border-top-color:transparent;border-radius:50%}
  .ok{color:#27c93f;font-weight:700}
  .pdf{position:absolute;top:0;right:0;width:46%;height:100%;background:#fff;
    box-shadow:-12px 0 30px rgba(0,0,0,.35)}
  .pdfbar{height:34px;background:#efefef;color:#666;font-size:12px;display:flex;align-items:center;padding:0 14px}
  .pdfbody{padding:14px 26px;overflow:hidden;height:calc(100% - 34px)}
  ${pageCss}
  </style></head><body>
  <div class="app">
    <div class="titlebar">
      <span class="dot" style="background:#ff5f56"></span>
      <span class="dot" style="background:#ffbd2e"></span>
      <span class="dot" style="background:#27c93f"></span>
      <span class="ttl">MD to PDF — VS Code</span>
    </div>
    <div class="tabbar"><div class="tab">📄 report.md</div></div>
    <div class="stage">
      <div class="editor" id="editor"></div>
      <div class="menu" id="menu" style="display:none">
        <div class="mi">Cut</div>
        <div class="mi">Copy</div>
        <div class="mi sep"></div>
        <div class="mi hot" id="hotitem">Convert Markdown to PDF</div>
        <div class="mi sep"></div>
        <div class="mi">Format Document</div>
      </div>
      <div class="toast" id="toast" style="display:none"></div>
      <div class="pdf" id="pdf" style="transform:translateX(110%)">
        <div class="pdfbar">📕 report.pdf</div>
        <div class="pdfbody">${renderedPdf}</div>
      </div>
      <svg class="cursor" id="cursor" viewBox="0 0 24 24" style="left:600px;top:300px">
        <path d="M5 3l15 9-6 1 3.5 6-2.5 1.4L11 14l-6 4z" fill="#fff" stroke="#000" stroke-width="1.2"/>
      </svg>
    </div>
  </div>
  <script>
    const ed = document.getElementById('editor');
    const menu = document.getElementById('menu');
    const toast = document.getElementById('toast');
    const pdf = document.getElementById('pdf');
    const cursor = document.getElementById('cursor');
    const hot = document.getElementById('hotitem');
    const raw = ${JSON.stringify(sampleMd)};
    // colourise a slice of the markdown for the editor
    function colour(s){
      return s
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/^(#.*)$/gm,'<span class="h">$1</span>')
        .replace(/^(- .*)$/gm,'<span class="str">$1</span>')
        .replace(/(\\*\\*[^*]+\\*\\*|_[^_]+_)/g,'<span class="kw">$1</span>')
        .replace(/(\`\`\`[a-z]*|\`[^\`]*\`)/g,'<span class="mut">$1</span>');
    }
    const MENU_X = 470, MENU_Y = 250;
    function lerp(a,b,t){return a+(b-a)*Math.max(0,Math.min(1,t));}
    function ease(t){t=Math.max(0,Math.min(1,t));return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}
    window.setFrame = (i, n) => {
      const p = i/(n-1);
      // 1) typing 0.00-0.34
      const tf = Math.max(0, Math.min(1,(p-0)/0.34));
      const chars = Math.floor(tf*raw.length);
      const blink = (Math.floor(i/8)%2===0) ? '<span class="caret"></span>' : '';
      ed.innerHTML = colour(raw.slice(0,chars)) + (p<0.40?blink:'');
      // cursor moves to menu spot 0.30-0.36
      const cm = ease((p-0.30)/0.06);
      const cx = lerp(600, MENU_X+115, cm), cy = lerp(300, MENU_Y+2, cm);
      // then onto the hot item 0.40-0.45
      const cm2 = ease((p-0.40)/0.05);
      cursor.style.left = lerp(cx, MENU_X+150, p>0.40?cm2:0)+'px';
      cursor.style.top  = lerp(cy, MENU_Y+86, p>0.40?cm2:0)+'px';
      // 2) menu visible 0.36-0.50
      if(p>=0.36 && p<0.50){ menu.style.display='block'; menu.style.left=MENU_X+'px'; menu.style.top=MENU_Y+'px';
        hot.classList.toggle('hot', !(p>0.45 && Math.floor(i/3)%2===0)); }
      else { menu.style.display='none'; hot.classList.add('hot'); }
      // 3) converting toast 0.50-0.66
      if(p>=0.50 && p<0.66){ toast.style.display='flex';
        toast.innerHTML='<span class="spin" style="border-top-color:transparent;animation:none;transform:rotate('+(i*40)+'deg)"></span> Converting Markdown to PDF…'; }
      // 4) pdf slides in 0.60-0.74
      else if(p>=0.60){
        const sp = ease((p-0.60)/0.14);
        pdf.style.transform = 'translateX('+lerp(110,0,sp)+'%)';
        if(p>=0.76){ toast.style.display='flex';
          toast.innerHTML='<span class="ok">✓</span> PDF saved: report.pdf'; }
        else if(p>=0.66){ toast.style.display='none'; }
      } else { toast.style.display='none'; pdf.style.transform='translateX(110%)'; }
    };
  </script>
  </body></html>`;
}

(async () => {
  const cacheDir = `${os.homedir()}/Library/Application Support/Code/User/globalStorage/mishka.md-to-pdf`;
  const executablePath = browsers.computeExecutablePath({
    browser: browsers.Browser.CHROME, platform: browsers.detectBrowserPlatform(),
    buildId: '149.0.7827.22', cacheDir,
  });
  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAME_DIR);

  const browser = await puppeteer.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setContent(buildHTML(), { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < N; i++) {
    await page.evaluate((i, n) => window.setFrame(i, n), i, N);
    const name = `${FRAME_DIR}/f${String(i).padStart(4, '0')}.png`;
    await page.screenshot({ path: name });
    if (i % 24 === 0) console.log(`captured ${i}/${N}`);
  }
  await browser.close();
  console.log('frames captured, encoding…');

  const r = spawnSync(ffmpegPath, [
    '-y', '-framerate', String(FPS),
    '-i', `${FRAME_DIR}/f%04d.png`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    'demo.mp4',
  ], { stdio: 'inherit' });
  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
  console.log('demo.mp4 written ✓');
})().catch(e => { console.error(e.message); process.exit(1); });
