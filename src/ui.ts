// Frontend SPA for nps-report — modeled on improvebayarea.com's report flow,
// re-skinned for the National Park Service (forest green / cream / gold).
//
// Hand-rolled CSS (no Tailwind CDN) so the page passes a tight CSP + a11y gate.
// Flow: GPS auto-routes to nearest park -> snap a photo -> AI drafts the report
// -> review/edit -> Preview (dry run) -> Send (NPS mails the park).

const GREEN = "#166534";
const GREEN_DARK = "#14532d";
const GOLD = "#c97b17";
const CREAM = "#f6f5ef";
const INK = "#1a211c";

export function renderApp(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ParkReport — report broken things in National Parks</title>
<meta name="description" content="Snap a photo, AI drafts it, and it's sent to the right national park. A people-powered way to report broken or unsafe conditions in US National Parks.">
<meta name="theme-color" content="${GREEN_DARK}">
<meta property="og:title" content="ParkReport — report broken things in National Parks">
<meta property="og:description" content="Snap a photo. AI drafts the report. It's emailed to the right national park.">
<meta property="og:type" content="website">
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--green:${GREEN};--green-dark:${GREEN_DARK};--gold:${GOLD};--cream:${CREAM};--ink:${INK};--muted:#5b6b61;--line:#e2e6df}
  body{font-family:'Inter',system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--cream);color:var(--ink);line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:480px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;padding-bottom:6.5rem}
  header{display:flex;align-items:center;gap:.6rem;padding:1rem 1.25rem;border-bottom:1px solid var(--line);background:#fff;position:sticky;top:0;z-index:20}
  header .mark{width:34px;height:34px;flex:0 0 auto}
  header .name{font-weight:900;font-size:1.15rem;letter-spacing:-.02em;color:var(--green-dark)}
  header .tag{font-size:.7rem;color:var(--muted);font-weight:600}
  main{flex:1;padding:1.1rem 1.25rem;display:flex;flex-direction:column;gap:1rem}
  .note{background:#fff7e6;border-left:4px solid var(--gold);padding:.7rem .9rem;border-radius:.4rem;font-size:.82rem;color:#6b4e09}
  .card{background:#fff;border:1px solid var(--line);border-radius:.9rem;padding:1rem;box-shadow:0 1px 2px rgba(20,40,30,.04)}
  .card.accent{border-left:4px solid var(--green)}
  .label{font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:var(--muted);display:flex;align-items:center;gap:.4rem;margin-bottom:.55rem}
  .pill{display:inline-flex;align-items:center;gap:.35rem;background:#e3f0e8;color:var(--green-dark);border-radius:999px;padding:.2rem .6rem;font-size:.72rem;font-weight:700}
  .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--gold)}
  .dot.live{background:var(--green);animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  select,input,textarea{width:100%;font:inherit;color:var(--ink);background:#fff;border:1.5px solid var(--line);border-radius:.6rem;padding:.7rem .8rem}
  select:focus,input:focus,textarea:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 3px rgba(22,101,52,.12)}
  textarea{min-height:5.5rem;resize:vertical}
  .park-name{font-weight:900;font-size:1.35rem;color:var(--green-dark);line-height:1.15}
  .hint{font-size:.72rem;color:var(--muted);margin-top:.35rem}
  .drop{display:block;border:2px dashed #c4d2c9;border-radius:.7rem;padding:1.5rem 1rem;text-align:center;cursor:pointer;transition:.15s;color:var(--muted)}
  .drop:hover,.drop.over{border-color:var(--green);background:#f1f7f3;color:var(--green-dark)}
  .drop .big{font-size:2rem;line-height:1}
  .preview-img{width:100%;border-radius:.6rem;margin-top:.7rem;display:block;border:1px solid var(--line)}
  .field+.field{margin-top:.7rem}
  .field>span{display:block;font-size:.78rem;font-weight:700;margin-bottom:.3rem}
  .btn{display:flex;align-items:center;justify-content:center;gap:.4rem;width:100%;font-weight:800;border-radius:.7rem;padding:.85rem;border:none;cursor:pointer;font-size:.95rem;transition:transform .1s,opacity .15s}
  .btn:active{transform:scale(.985)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn-primary{background:var(--green);color:#fff}
  .btn-gold{background:var(--gold);color:#fff}
  .btn-outline{background:#fff;border:2px solid var(--green);color:var(--green-dark)}
  .bar{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);padding:.8rem 1.25rem;display:flex;gap:.6rem;max-width:480px;margin:0 auto}
  .bar .btn{flex:1}
  .out{font-size:.82rem;white-space:pre-wrap;background:#0f1f17;color:#e6f2ea;padding:.85rem;border-radius:.6rem;font-family:ui-monospace,Menlo,monospace;max-height:16rem;overflow:auto;margin-top:.7rem}
  .ok{color:#166534;font-weight:700}.err{color:#b3261e;font-weight:700}
  footer{padding:1rem 1.25rem;font-size:.72rem;color:var(--muted);text-align:center}
  .hidden{display:none!important}
  .spin{display:inline-block;width:1rem;height:1rem;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:rot .7s linear infinite}
  @keyframes rot{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3 L25 16 H19 L26 27 H6 L13 16 H7 Z" fill="${GREEN}"/>
      <rect x="14.3" y="26" width="3.4" height="4" fill="${GOLD}"/>
    </svg>
    <div>
      <div class="name">ParkReport</div>
      <div class="tag">Report broken things in National Parks</div>
    </div>
  </header>

  <main>
    <h1 style="font-size:1.45rem;font-weight:900;letter-spacing:-.02em;color:var(--green-dark);line-height:1.2">Report an issue in a national park</h1>
    <div class="note"><strong>How it works:</strong> we fill out the park's own "Email Us" form for you — the National Park Service sends it to the park, and replies go to your email. There's no public ticket number (the NPS doesn't issue one).</div>

    <!-- 1. Location -->
    <section class="card accent">
      <div class="label">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9.69 18.93a.75.75 0 00.62 0C13 17.5 16 14.27 16 10a6 6 0 10-12 0c0 4.27 3 7.5 5.69 8.93zM10 8a2 2 0 100 4 2 2 0 000-4z" clip-rule="evenodd"/></svg>
        Park
        <span id="gps" class="pill" style="margin-left:auto"><span class="dot"></span><span id="gps-txt">Locating…</span></span>
      </div>
      <div id="park-name" class="park-name">Choose a park</div>
      <select id="park" aria-label="Select park" style="margin-top:.6rem"></select>
      <div class="hint" id="park-hint">We auto-pick the nearest park from your location. You can change it.</div>
    </section>

    <!-- 2. Photo -->
    <section class="card">
      <div class="label">Photo (optional, recommended)</div>
      <label class="drop" id="drop" for="photo">
        <div class="big">📷</div>
        <div style="margin-top:.4rem;font-weight:700">Tap to add a photo of the issue</div>
        <div class="hint">AI reads it and drafts your report</div>
      </label>
      <input id="photo" type="file" accept="image/*" capture="environment" class="hidden">
      <img id="preview" class="preview-img hidden" alt="Selected photo preview">
      <button id="analyze" class="btn btn-gold hidden" style="margin-top:.7rem" type="button">✨ Analyze photo with AI</button>
    </section>

    <!-- 3. Details -->
    <section class="card">
      <div class="label">What's wrong</div>
      <div class="field"><span>Category</span>
        <select id="category" aria-label="Category"></select>
      </div>
      <div class="field"><span>Subject</span>
        <input id="subject" placeholder="e.g. Broken railing at the overlook" maxlength="120">
      </div>
      <div class="field"><span>Description</span>
        <textarea id="description" placeholder="Describe what's broken or unsafe, and exactly where."></textarea>
      </div>
      <div class="field"><span>Location in the park (optional)</span>
        <input id="location" placeholder="e.g. Lands End Lookout, near the labyrinth trail">
      </div>
    </section>

    <!-- 4. Contact -->
    <section class="card">
      <div class="label">You</div>
      <div class="field"><span>Your email <span style="color:var(--muted);font-weight:500">— the park replies here</span></span>
        <input id="email" type="email" placeholder="you@example.com" autocomplete="email">
      </div>
      <div class="field"><span>Your name (optional)</span>
        <input id="fullname" placeholder="Jane Visitor" autocomplete="name">
      </div>
    </section>

    <div id="result" class="hidden"></div>
  </main>

  <footer>
    Not affiliated with the National Park Service. Files the park's public "Email Us" form on your behalf.
  </footer>
</div>

<div class="bar">
  <button id="preview-btn" class="btn btn-outline" type="button">Preview</button>
  <button id="send-btn" class="btn btn-primary" type="button">Send to park</button>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { lat: null, lng: null, photoBytes: null, photoB64: null };

// ---- init: categories + parks + geolocation ----
async function init() {
  // categories
  try {
    const cats = await (await fetch('/api/categories')).json();
    $('category').innerHTML = cats.categories.map(c => '<option value="'+c+'"'+(c==='Facilities'?' selected':'')+'>'+c+'</option>').join('');
  } catch {}
  // parks
  try {
    const data = await (await fetch('/api/parks')).json();
    state.parks = data.parks.sort((a,b)=>a.name.localeCompare(b.name));
    $('park').innerHTML = '<option value="">— choose a park —</option>' +
      state.parks.map(p => '<option value="'+p.code+'">'+p.name+'</option>').join('');
    $('park').onchange = () => {
      const p = state.parks.find(x => x.code === $('park').value);
      $('park-name').textContent = p ? p.name : 'Choose a park';
    };
  } catch {}
  // geolocation -> nearest park
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      state.lat = pos.coords.latitude; state.lng = pos.coords.longitude;
      try {
        const loc = await (await fetch('/api/locate', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lat:state.lat,lng:state.lng})})).json();
        if (loc.nearestPark) {
          $('park').value = loc.nearestPark.code;
          $('park-name').textContent = loc.nearestPark.name;
          $('gps-txt').textContent = 'Near ' + (loc.nearestPark.name.split(' National')[0]);
          $('gps').querySelector('.dot').classList.add('live');
          $('park-hint').textContent = '~' + loc.nearestPark.distanceKm + ' km from your location. Change it if needed.';
        } else { $('gps-txt').textContent = 'Located'; }
      } catch { $('gps-txt').textContent = 'Located'; }
    }, () => { $('gps-txt').textContent = 'No GPS'; }, {enableHighAccuracy:true, timeout:8000});
  } else { $('gps-txt').textContent = 'No GPS'; }
}

// ---- photo ----
$('drop').addEventListener('dragover', e=>{e.preventDefault();$('drop').classList.add('over');});
$('drop').addEventListener('dragleave', ()=>$('drop').classList.remove('over'));
$('drop').addEventListener('drop', e=>{e.preventDefault();$('drop').classList.remove('over');if(e.dataTransfer.files[0])loadPhoto(e.dataTransfer.files[0]);});
$('photo').addEventListener('change', e=>{if(e.target.files[0])loadPhoto(e.target.files[0]);});

function loadPhoto(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result;
    state.photoB64 = String(url).split(',')[1];
    $('preview').src = url; $('preview').classList.remove('hidden');
    $('analyze').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

$('analyze').addEventListener('click', async () => {
  const btn = $('analyze'); btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Analyzing…';
  try {
    const body = { imageBase64: state.photoB64, lat: state.lat, lng: state.lng };
    const r = await (await fetch('/api/analyze', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
    if (r.error) throw new Error(r.message || r.error);
    if (r.category) $('category').value = r.category;
    if (r.subject) $('subject').value = r.subject;
    if (r.description) $('description').value = r.description;
    if (r.suggestedPark && !$('park').value) { $('park').value = r.suggestedPark.code; $('park-name').textContent = r.suggestedPark.name; }
    btn.innerHTML = '✓ Drafted — review below';
  } catch (e) {
    btn.innerHTML = '⚠ ' + e.message;
  } finally {
    setTimeout(()=>{btn.disabled=false;btn.innerHTML=old;}, 2500);
  }
});

// ---- report body ----
function reportBody(send) {
  return {
    parkCode: $('park').value || undefined,
    lat: state.lat ?? undefined, lng: state.lng ?? undefined,
    category: $('category').value,
    subject: $('subject').value.trim(),
    description: $('description').value.trim(),
    location: $('location').value.trim() || undefined,
    email: $('email').value.trim(),
    fullname: $('fullname').value.trim() || undefined,
    send,
  };
}
function validate(b) {
  if (!b.parkCode && !(b.lat && b.lng)) return 'Pick a park first.';
  if (!b.subject) return 'Add a subject.';
  if (!b.description) return 'Describe the issue.';
  if (!b.email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(b.email)) return 'Enter a valid email — the park replies there.';
  return null;
}

async function submit(send) {
  const b = reportBody(send);
  const v = validate(b);
  const out = $('result'); out.classList.remove('hidden');
  if (v) { out.innerHTML = '<div class="card"><span class="err">'+v+'</span></div>'; out.scrollIntoView({behavior:'smooth'}); return; }
  if (send && !confirm('Send this report to the park? The National Park Service will email it on your behalf.')) return;
  const btn = send ? $('send-btn') : $('preview-btn'); btn.disabled = true; const old = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    const r = await (await fetch('/api/report', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})).json();
    if (r.error) throw new Error(r.message || r.error);
    const f = r.prepared && r.prepared.fields;
    if (send) {
      out.innerHTML = '<div class="card"><div class="'+(r.ok?'ok':'err')+'">'+(r.ok?'✓ Sent to '+esc(r.park?r.park.name:'the park'):'⚠ '+esc(r.note))+'</div><div class="hint">'+esc(r.note)+'</div></div>';
    } else {
      out.innerHTML = '<div class="card"><div class="label">Preview — this is what gets emailed</div>'+
        '<div class="hint">To: '+esc(r.park?r.park.name:'park mailbox')+' · Category: '+esc(r.category)+'</div>'+
        '<div class="out"><strong>Subject:</strong> '+esc(f?f.subject:'')+'\\n\\n'+esc(f?f.message:'')+'</div>'+
        '<div class="hint" style="margin-top:.5rem">Looks right? Tap <strong>Send to park</strong>.</div></div>';
    }
    out.scrollIntoView({behavior:'smooth'});
  } catch (e) {
    out.innerHTML = '<div class="card"><span class="err">'+esc(e.message)+'</span></div>';
  } finally { btn.disabled=false; btn.innerHTML=old; }
}

$('preview-btn').addEventListener('click', ()=>submit(false));
$('send-btn').addEventListener('click', ()=>submit(true));
init();
</script>
</body>
</html>`;
}

/** Brand favicon (inline SVG) — pine + arrowhead motif. */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${GREEN_DARK}"/><path d="M16 6 L24 17 H19 L25 26 H7 L13 17 H8 Z" fill="#fff"/><rect x="14.3" y="25" width="3.4" height="4" fill="${GOLD}"/></svg>`;
}
