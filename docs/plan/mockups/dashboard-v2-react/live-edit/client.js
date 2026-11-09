// 라이브 편집 화면 쪽. 개발 서버에서만 주입된다. 앱 스타일과 섞이지 않게 shadow DOM을 쓴다.
(() => {
  if (window.__pesLiveEdit) return;
  window.__pesLiveEdit = true;

  const host = document.createElement("div");
  host.id = "pes-live-edit";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Pretendard, system-ui, sans-serif; }
    .fab { position: fixed; left: 16px; bottom: 16px; pointer-events: auto; border: 0; cursor: pointer;
      background: #111; color: #fff; border-radius: 999px; padding: 10px 16px; font-size: 14px; font-weight: 600;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .fab.on { background: #e5484d; }
    .count { margin-left: 6px; background: rgba(255,255,255,.2); border-radius: 999px; padding: 1px 7px; font-size: 12px; }
    .hl { position: fixed; pointer-events: none; border: 2px solid #e5484d; background: rgba(229,72,77,.08);
      border-radius: 4px; display: none; }
    .tag { position: fixed; pointer-events: none; background: #e5484d; color: #fff; font-size: 11px;
      padding: 2px 6px; border-radius: 4px; display: none; max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pick { position: fixed; pointer-events: none; border: 2px dashed #e5484d; border-radius: 4px; display: none; }
    .box { position: fixed; pointer-events: auto; width: 340px; background: #fff; color: #111; border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 14px; display: none; }
    .box .what { font-size: 12px; color: #555; margin-bottom: 8px; max-height: 3.6em; overflow: hidden; }
    .box textarea { width: 100%; min-height: 84px; font-size: 15px; padding: 8px; border: 1px solid #ccc; border-radius: 8px; resize: vertical; }
    .row { display: flex; gap: 8px; justify-content: space-between; align-items: center; margin-top: 8px; }
    .hint { font-size: 11px; color: #777; }
    .btn { border: 0; border-radius: 8px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
    .send { background: #111; color: #fff; } .cancel { background: #eee; color: #111; }
    .toast { position: fixed; left: 16px; bottom: 64px; background: #111; color: #fff; padding: 8px 12px;
      border-radius: 8px; font-size: 13px; display: none; pointer-events: none; max-width: 360px; }
    .list { position: fixed; left: 16px; bottom: 64px; width: 340px; max-height: 50vh; overflow: auto; pointer-events: auto;
      background: #fff; color: #111; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 10px; display: none; font-size: 13px; }
    .item { padding: 6px 4px; border-bottom: 1px solid #eee; display: flex; gap: 8px; }
    .st { flex: none; font-size: 11px; border-radius: 999px; padding: 1px 7px; height: fit-content; }
    .st.wait { background: #fff4d6; color: #7a5b00; } .st.ok { background: #dcf5e3; color: #146c2e; }
  </style>
  <div class="hl"></div><div class="tag"></div><div class="pick"></div>
  <div class="box">
    <div class="what"></div>
    <textarea placeholder="어떻게 바꿀까요? 예: 이 글자를 '시작하기'로 / 이 칸을 더 좁게 / 이 단추를 지워 줘"></textarea>
    <div class="row"><span class="hint">⌘/Ctrl+Enter 보내기 · Esc 닫기</span>
      <span><button class="btn cancel">취소</button> <button class="btn send">보내기</button></span></div>
  </div>
  <div class="toast"></div>
  <div class="list"></div>
  <button class="fab" title="화면에서 고칠 곳을 눌러 Claude에게 부탁합니다 (단축키 Alt+E)">✎ 고치기<span class="count"></span></button>`;

  const $ = (s) => root.querySelector(s);
  const fab = $(".fab"), hl = $(".hl"), tag = $(".tag"), pick = $(".pick"), box = $(".box"),
    ta = $("textarea"), what = $(".what"), toast = $(".toast"), list = $(".list"), count = $(".count");
  let on = false, target = null, picking = false;

  const isOurs = (el) => el === host || host.contains(el);
  const place = (div, r) => Object.assign(div.style, {
    display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });

  function selectorOf(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body && parts.length < 6; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + "#" + e.id); break; }
      const testid = e.getAttribute("data-testid") || e.getAttribute("data-slot");
      if (testid) s += `[data-${e.hasAttribute("data-testid") ? "testid" : "slot"}="${testid}"]`;
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  const label = (el) => {
    const t = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ");
    return `<${el.tagName.toLowerCase()}> ${t.slice(0, 80)}`;
  };
  const near = (el) => {
    const out = [];
    for (let e = el.parentElement; e && e !== document.body && out.length < 3; e = e.parentElement) {
      const h = e.querySelector("h1,h2,h3,h4,[data-slot=card-title]");
      if (h && !out.includes(h.innerText.trim())) out.push(h.innerText.trim().slice(0, 60));
    }
    return out;
  };

  function setOn(v) {
    on = v; fab.classList.toggle("on", on);
    fab.firstChild.textContent = on ? "✕ 고치기 끄기" : "✎ 고치기";
    if (!on) { hl.style.display = tag.style.display = "none"; closeBox(); }
    if (on) { list.style.display = "none"; showToast("고칠 곳을 누르세요"); }
  }
  function closeBox() { box.style.display = "none"; pick.style.display = "none"; picking = false; target = null; }
  function showToast(t, ms = 1800) { toast.textContent = t; toast.style.display = "block";
    clearTimeout(showToast.t); showToast.t = setTimeout(() => (toast.style.display = "none"), ms); }

  fab.addEventListener("click", (e) => {
    if (e.shiftKey || (!on && e.altKey)) { toggleList(); return; }
    setOn(!on);
  });
  fab.addEventListener("contextmenu", (e) => { e.preventDefault(); toggleList(); });
  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.code === "KeyE")) { e.preventDefault(); setOn(!on); }
    if (e.key === "Escape" && on) { e.preventDefault(); e.stopPropagation(); picking ? closeBox() : setOn(false); }
  }, true);

  document.addEventListener("mousemove", (e) => {
    if (!on || picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOurs(el)) { hl.style.display = tag.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    place(hl, r);
    tag.textContent = label(el); tag.style.display = "block";
    tag.style.left = r.left + "px"; tag.style.top = Math.max(0, r.top - 20) + "px";
  }, true);

  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
    document.addEventListener(type, (e) => {
      if (!on || isOurs(e.target) || e.composedPath().includes(host)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (type !== "click" || picking) return;
      target = e.target;
      const r = target.getBoundingClientRect();
      place(pick, r); hl.style.display = tag.style.display = "none";
      what.textContent = label(target);
      box.style.display = "block"; picking = true;
      const bx = Math.min(window.innerWidth - 356, Math.max(16, r.left));
      const by = r.bottom + 8 + 190 < window.innerHeight ? r.bottom + 8 : Math.max(16, r.top - 198);
      box.style.left = bx + "px"; box.style.top = by + "px";
      ta.value = ""; setTimeout(() => ta.focus(), 0);
    }, true);
  }

  $(".cancel").addEventListener("click", closeBox);
  $(".send").addEventListener("click", send);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    if (e.key === "Escape") { e.preventDefault(); closeBox(); }
  });

  async function send() {
    const note = ta.value.trim();
    if (!note || !target) return;
    const el = target, r = el.getBoundingClientRect();
    const payload = {
      note,
      route: location.pathname + location.search + location.hash,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 300),
      aria: el.getAttribute("aria-label") || undefined,
      classes: (el.getAttribute("class") || "").slice(0, 400),
      near: near(el),
      html: el.outerHTML.slice(0, 1500),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: innerWidth, h: innerHeight },
      theme: document.documentElement.className,
    };
    try {
      const res = await fetch("/__live-edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const { id } = await res.json();
      showToast(`#${id} 보냈습니다. Claude가 고치면 화면이 바로 바뀝니다.`, 3000);
      closeBox(); poll();
    } catch { showToast("보내지 못했습니다. 개발 서버가 켜져 있는지 확인해 주세요.", 4000); }
  }

  async function poll() {
    try {
      const s = await (await fetch("/__live-edit")).json();
      const done = new Map(s.done.map((d) => [d.id, d.note || "반영됨"]));
      const waiting = s.requests.filter((r) => !done.has(r.id)).length;
      count.textContent = waiting ? String(waiting) : "";
      list.innerHTML = s.requests.length
        ? s.requests.slice().reverse().map((r) => `<div class="item"><span class="st ${done.has(r.id) ? "ok" : "wait"}">#${r.id} ${done.has(r.id) ? "반영" : "대기"}</span><span>${esc(r.note)}${done.has(r.id) ? `<br><small style="color:#666">${esc(done.get(r.id))}</small>` : ""}</span></div>`).join("")
        : "<div class='item'>아직 보낸 요청이 없습니다.</div>";
    } catch {}
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function toggleList() { poll(); list.style.display = list.style.display === "block" ? "none" : "block"; }
  poll(); setInterval(poll, 3000);
})();
