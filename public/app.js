const $ = (selector) => document.querySelector(selector);
const video = $("#video");
const itemsEl = $("#items");
const fileInput = $("#playlist-file");
const searchInput = $("#search");
const emptyPlayer = $("#empty-player");
let playlist = [];
let activeIndex = -1;
let hls = null;

function parseM3U(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const result = [];
  let metadata = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      const name = comma >= 0 ? line.slice(comma + 1).trim() : "Sem título";
      const getAttr = (key) => {
        const match = attrs.match(new RegExp(key + '="([^"]*)"'));
        return match ? match[1] : "";
      };
      metadata = { name: name || "Sem título", logo: getAttr("tvg-logo"), group: getAttr("group-title") };
    } else if (!line.startsWith("#")) {
      result.push({ name: metadata.name || line, url: line, logo: metadata.logo || "", group: metadata.group || "" });
      metadata = {};
    }
  }
  return result;
}

function safeUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "blob:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function renderItems() {
  const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const visible = playlist.map((item, index) => ({ ...item, index }))
    .filter(item => (item.name + " " + item.group).toLocaleLowerCase("pt-BR").includes(query));
  $("#item-count").textContent = playlist.length + (playlist.length === 1 ? " item" : " itens");
  if (!visible.length) {
    itemsEl.innerHTML = '<div class="empty-library"><span>✦</span><strong>Nenhum item encontrado</strong><p>Confira a busca ou carregue uma playlist M3U válida.</p></div>';
    return;
  }
  itemsEl.replaceChildren();
  for (const item of visible) {
    const button = document.createElement("button");
    button.className = "item" + (item.index === activeIndex ? " active" : "");
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "item-icon";
    icon.textContent = "▶";
    const title = document.createElement("strong");
    title.textContent = item.name;
    const sub = document.createElement("small");
    sub.textContent = item.group || new URL(item.url).hostname;
    button.append(icon, title, sub);
    button.addEventListener("click", () => playItem(item.index));
    itemsEl.append(button);
  }
}

function playItem(index) {
  const item = playlist[index];
  if (!item) return;
  const url = safeUrl(item.url);
  if (!url) {
    $("#player-message").textContent = "Este endereço não é permitido.";
    return;
  }
  activeIndex = index;
  $("#current-title").textContent = item.name;
  $("#player-message").textContent = "Carregando transmissão…";
  emptyPlayer.classList.add("hidden");
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (/\.m3u8(?:$|[?#])/i.test(url) && window.Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {
      $("#player-message").textContent = "Toque em reproduzir para iniciar.";
    }));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) $("#player-message").textContent = "Não foi possível abrir esta transmissão.";
    });
  } else {
    video.src = url;
    video.play().catch(() => {
      $("#player-message").textContent = "Toque em reproduzir. Alguns formatos dependem do navegador.";
    });
  }
  $("#player-message").textContent = item.group || "Reprodução selecionada";
  renderItems();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseM3U(text);
    playlist = parsed.filter(item => safeUrl(item.url));
    activeIndex = -1;
    $("#current-title").textContent = "Nada selecionado";
    $("#player-message").textContent = playlist.length
      ? "Playlist carregada. Escolha um item para reproduzir."
      : "Não encontrei endereços HTTP ou HTTPS válidos nessa playlist.";
    emptyPlayer.classList.remove("hidden");
    renderItems();
  } catch {
    $("#player-message").textContent = "Não consegui ler esse arquivo de playlist.";
  }
});
searchInput.addEventListener("input", renderItems);
renderItems();
