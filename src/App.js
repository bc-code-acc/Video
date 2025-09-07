import React, { useEffect, useMemo, useState, useRef } from "react";

/* =========================================
   Utilities
========================================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function normalizeWords(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
const ls = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  },
};

// --- Theme handling ---
const THEME_KEY = "ui_theme"; // "light" | "dark" | "system"

function getSystemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* =========================================
   IndexedDB helpers for persistent file handles
========================================= */
const IDB_NAME = "pwa-video-db";
const IDB_STORE = "handles";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAddHandle(record) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAllHandles() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteHandle(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* =========================================
   Toast (unchanged)
========================================= */
function useToast() {
  const [toast, setToast] = useState(null); // {msg, type}
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);
  return {
    toast,
    show: (msg, type = "info") => setToast({ msg, type }),
    clear: () => setToast(null),
  };
}
function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.type}`} role="status" aria-live="polite">
      {toast.msg}
    </div>
  );
}

/* =========================================
   Scraper (Tab 1) — unchanged logic/formatting
========================================= */
// --- Mobile-first search: Piped + Invidious (no API key) ---
const PIPED_INSTANCES = [
  "https://piped.video",
  "https://piped.yt",
  "https://piped.projectsegfau.lt"
];

const INVIDIOUS_INSTANCES = [
  "https://yewtu.be",
  "https://vid.puffyan.us",
  "https://invidious.kavin.rocks"
];

// Try providers in order until we get usable results
async function providerSearch(query) {
  const encoded = encodeURIComponent(query);

  // 1) Piped (JSON, good CORS)
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetch(`${base}/api/v1/search?q=${encoded}&region=GB`, {
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      if (!r.ok) continue;
      const data = await r.json();
      // Piped returns mixed types. Keep videos only.
      const vids = (Array.isArray(data) ? data : []).filter(it => it.type === "video");
      if (vids.length) {
        // Normalize to {id, title}
        return vids.map(it => {
          // Piped gives it.url like "/watch?v=VIDEOID"
          const m = typeof it.url === "string" ? it.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) : null;
          const id = m ? m[1] : it.id || it.videoId;
          return { id, title: it.title || "" };
        }).filter(v => v.id);
      }
    } catch { /* try next instance */ }
  }

  // 2) Invidious (JSON, CORS depends on instance)
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const r = await fetch(`${base}/api/v1/search?q=${encoded}&type=video`, {
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      if (!r.ok) continue;
      const data = await r.json();
      const vids = (Array.isArray(data) ? data : []).filter(it => it.type === "video" || it.videoId);
      if (vids.length) {
        return vids.map(it => ({
          id: it.videoId || it.id,
          title: it.title || ""
        })).filter(v => v.id);
      }
    } catch { /* try next instance */ }
  }

  return []; // none worked
}

async function findBestYoutubeLink(query, { minMatchRatio = 0.5 } = {}) {
  const candidates = await providerSearch(query);
  if (!candidates.length) return null;

  const qWords = normalizeWords(query);
  const needed = Math.max(1, Math.ceil(qWords.length * minMatchRatio));

  for (const { id, title } of candidates) {
    const titleWords = normalizeWords(title);
    const hits = qWords.reduce(
      (acc, w) => (titleWords.some(tw => tw.includes(w)) ? acc + 1 : acc),
      0
    );
    if (hits >= needed) {
      return { url: `https://www.youtube.com/watch?v=${id}`, title };
    }
  }

  // If none matched strongly, at least return the first result
  const { id, title } = candidates[0];
  return { url: `https://www.youtube.com/watch?v=${id}`, title };
}

function TabScraper({ showToast }) {
  const [input, setInput] = useState("");
  const [minMatch, setMinMatch] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]); // {song, link, title, status}

  const textRef = useRef(null);

  const lines = useMemo(
    () =>
      input
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [input]
  );

  async function handleSearch() {
    if (!lines.length) return;
    setBusy(true);
    showToast(`Searching ${lines.length} item(s)…`, "info");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const song = lines[i];
      try {
        const hit = await findBestYoutubeLink(song, { minMatchRatio: minMatch });
        if (hit) out.push({ song, link: hit.url, title: hit.title, status: "ok" });
        else out.push({ song, link: "", title: "", status: "Not found" });
      } catch (e) {
        out.push({ song, link: "", title: "", status: `Error: ${e.message}` });
      }
      await sleep(120);
    }
    setResults(out);
    setBusy(false);
    const ok = out.filter((r) => r.status === "ok").length;
    showToast(`Done: ${ok}/${out.length} found`, ok ? "success" : "warn");
  }

  function handleClear() {
    setInput("");
    setResults([]);
    showToast("Cleared", "info");
  }

  async function handleCopyLinks() {
    const links = results.filter((r) => r.status === "ok").map((r) => r.link);
    if (!links.length) return showToast("No links to copy", "warn");
    await navigator.clipboard.writeText(links.join("\n"));
    showToast(`Copied ${links.length} link(s)`, "success");
  }

  function handleDownloadTxt() {
    const links = results.filter((r) => r.status === "ok").map((r) => r.link);
    if (!links.length) return showToast("No links to download", "warn");
    showToast("Downloading songs.txt…", "info");
    const blob = new Blob([links.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "songs.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Downloaded songs.txt", "success");
  }

  return (
    <section>
      <h2 className="title">Easy Search. Video Link Scraper</h2>
      <p className="subtitle">
        Paste <em>one song or video title per line, and the best result will be fetched</em>.
      </p>

      <div className="controls">
        <div className="control">
          <label>Min match ratio</label>
          <input
            type="number"
            step="0.1"
            min={0.1}
            max={1}
            value={minMatch}
            onChange={(e) =>
              setMinMatch(Math.max(0.1, Math.min(1, Number(e.target.value) || 0.5)))
            }
          />
          <span className="hint">fraction of query words to match</span>
        </div>
      </div>

      <textarea
        ref={textRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          const el = e.target;
          el.style.height = "auto"; // reset
          el.style.height = el.scrollHeight + "px"; // grow to fit
        }}
        placeholder={`Example:\nTravis Scott - 4X4\nJ Cole - No Role Modelz\nKanye West - Runaway`}
        className="editor autoExpand"
      />

      <div className="btnRow">
        <button onClick={handleSearch} disabled={busy || !lines.length} className="btn primary">
          {busy ? `Searching (${lines.length})…` : `Find Links (${lines.length})`}
        </button>
        <button
          onClick={handleCopyLinks}
          disabled={!results.some((r) => r.status === "ok")}
          className="btn"
        >
          Copy links
        </button>
        <button
          onClick={handleDownloadTxt}
          disabled={!results.some((r) => r.status === "ok")}
          className="btn"
        >
          Download songs.txt
        </button>
        <button onClick={handleClear} className="btn">
          Clear
        </button>
      </div>

      {results.length ? (
        <div className="cards">
          {results.map((r, i) => (
            <div key={i} className="card">
              <div className="song">{r.song}</div>
              {r.status === "ok" ? (
                <>
                  <a className="link" href={r.link} target="_blank" rel="noreferrer">
                    {r.link}
                  </a>
                </>
              ) : (
                <div className="error">{r.status}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="tip"></div>
      )}
    </section>
  );
}

/* =========================================
   Video Home (Tab 2) — unchanged
========================================= */
const CHANNELS_KEY = "yt_channels";

function TabAltVideoHome({ showToast }) {
  const [search, setSearch] = useState("");
  const [channelUrl, setChannelUrl] = useState("");
  const [channels, setChannels] = useState(() => ls.get(CHANNELS_KEY, []));

  useEffect(() => {
    ls.set(CHANNELS_KEY, channels);
  }, [channels]);

  function doSearch() {
    const q = search.trim();
    if (!q) return;
    window.location.href =
      "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
  }

  function addChannel() {
    const url = channelUrl.trim();
    if (!url || !url.includes("youtube.com")) {
      showToast("Enter a valid YouTube channel URL", "warn");
      return;
    }
    const name = url.split("/").pop().replace("@", "");
    if (channels.some((c) => c.url === url)) {
      showToast("Already saved", "warn");
      setChannelUrl("");
      return;
    }
    const next = [...channels, { name, url }];
    next.sort((a, b) => a.name.localeCompare(b.name));
    setChannels(next);
    setChannelUrl("");
    showToast("Channel saved", "success");
  }

  function removeChannel(idx) {
    const next = channels.filter((_, i) => i !== idx);
    setChannels(next);
    showToast("Removed", "info");
  }

  return (
    <section>
      <h2 className="title">Video Home</h2>
      <p className="subtitle">Search intentionally and jump to your saved channels quickly.</p>

      <div className="stack">
        <input
          className="textInput"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search videos…"
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
        />
        <button className="btn primary" onClick={doSearch}>
          Search
        </button>
      </div>

      <h3 className="h3">Add Channel</h3>
      <div className="stack">
        <input
          className="textInput"
          value={channelUrl}
          onChange={(e) => setChannelUrl(e.target.value)}
          placeholder="https://www.youtube.com/@channelName"
          onKeyDown={(e) => e.key === "Enter" && addChannel()}
        />
        <button className="btn primary" onClick={addChannel}>
          Add Channel
        </button>
      </div>

      <h3 className="h3">Saved Channels</h3>
      <div className="channelList">
        {channels.length === 0 && <div className="muted">No channels saved yet.</div>}
        {channels.map((c, i) => (
          <div className="channelItem" key={c.url}>
            <img
              alt=""
              src={`https://www.google.com/s2/favicons?domain=${c.url}&sz=64`}
              className="channelIcon"
            />
            <a className="channelName" href={c.url}>
              {c.name}
            </a>
            <button className="btn small" onClick={() => removeChannel(i)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =========================================
   Downloads (Tab 3) — OPFS-backed persistence
   - Copies picked files into the PWA's private filesystem (OPFS).
   - Rebuilds playable object URLs after refresh.
   - Falls back to session-only if OPFS is unavailable.
========================================= */
const DL_VIDS_META_KEY = "video_downloads_opfs_meta"; // [{name, size}]

const hasOPFS = !!(navigator.storage && navigator.storage.getDirectory);

// OPFS helpers
async function getVideosDir() {
  const root = await navigator.storage.getDirectory();
  // Create/return a folder named 'videos'
  return await root.getDirectoryHandle("videos", { create: true });
}

async function writeFileToOPFS(file) {
  const dir = await getVideosDir();
  // If a file with the same name exists, we overwrite.
  const handle = await dir.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();
  // fastest and memory-friendly: stream → OPFS
  await file.stream().pipeTo(writable);
  return { name: file.name, size: file.size };
}

async function readFileFromOPFS(name) {
  const dir = await getVideosDir();
  const handle = await dir.getFileHandle(name, { create: false });
  return await handle.getFile();
}

async function deleteFromOPFS(name) {
  const dir = await getVideosDir();
  await dir.removeEntry(name);
}

function TabDownloads({ showToast }) {
  const [videos, setVideos] = useState([]); // [{name, size, url}]
  const [opfsAvailable, setOpfsAvailable] = useState(hasOPFS);

  // Build the in-memory list from OPFS + metadata on mount
  useEffect(() => {
    (async () => {
      if (!hasOPFS) {
        setOpfsAvailable(false);
        const meta = ls.get(DL_VIDS_META_KEY, []);
        if (meta.length) showToast("OPFS not supported here; files won’t persist.", "warn");
        setVideos([]); // nothing to rebuild without OPFS bytes
        return;
      }

      try {
        const meta = ls.get(DL_VIDS_META_KEY, []);
        const rebuilt = [];
        for (const m of meta) {
          try {
            const file = await readFileFromOPFS(m.name);
            const url = URL.createObjectURL(file);
            rebuilt.push({ name: m.name, size: file.size ?? m.size, url });
          } catch {
            // File missing (was deleted or cleared by browser); ignore
          }
        }
        setVideos(rebuilt);
      } catch (e) {
        console.error(e);
        setOpfsAvailable(false);
        showToast("Could not access OPFS; downloads won’t persist.", "warn");
      }

      return () => {
        // Revoke any object URLs we created
        videos.forEach((v) => v.url && URL.revokeObjectURL(v.url));
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  async function handleAdd() {
    try {
      const pickerSupported = "showOpenFilePicker" in window;
      if (!pickerSupported) {
        showToast("This browser can’t open files (no picker).", "warn");
        return;
      }

      const picks = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: "Videos", accept: { "video/*": [".mp4", ".webm", ".mkv"] } }],
      });

      const addedMeta = [];
      for (const handle of picks) {
        const file = await handle.getFile();

        if (hasOPFS) {
          // Persist bytes into OPFS
          await writeFileToOPFS(file);
          addedMeta.push({ name: file.name, size: file.size });
        } else {
          // Fallback: session-only object URL (not persistent)
          const url = URL.createObjectURL(file);
          setVideos((prev) => [...prev, { name: file.name, size: file.size, url }]);
        }
      }

      if (hasOPFS && addedMeta.length) {
        // Merge with any existing metadata, de-dupe by name
        const existing = ls.get(DL_VIDS_META_KEY, []);
        const byName = new Map(existing.map((m) => [m.name, m]));
        for (const m of addedMeta) byName.set(m.name, m);
        const merged = Array.from(byName.values());
        ls.set(DL_VIDS_META_KEY, merged);

        // Rebuild in-memory list (ensures we show latest bytes)
        const rebuilt = [];
        for (const m of merged) {
          try {
            const file = await readFileFromOPFS(m.name);
            const url = URL.createObjectURL(file);
            rebuilt.push({ name: m.name, size: file.size ?? m.size, url });
          } catch { }
        }
        setVideos(rebuilt);
        showToast("Video(s) saved for offline use", "success");
      } else {
        showToast("Video(s) added (session-only)", "warn");
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error(e);
        showToast("Failed to add video", "warn");
      }
    }
  }

  async function handleRemove(name) {
    try {
      if (hasOPFS) {
        await deleteFromOPFS(name);
        const remainingMeta = ls.get(DL_VIDS_META_KEY, []).filter((m) => m.name !== name);
        ls.set(DL_VIDS_META_KEY, remainingMeta);
      }
      setVideos((prev) => prev.filter((v) => v.name !== name));
      showToast("Removed", "info");
    } catch (e) {
      console.error(e);
      showToast("Could not remove", "warn");
    }
  }

  return (
    <section>
      <h2 className="title">Downloads</h2>
      <p className="subtitle">
        Import and manage offline videos.
      </p>

      <div className="btnRow">
        <button className="btn primary" onClick={handleAdd}>Add Video</button>
        {!opfsAvailable && (
          <button className="btn" disabled>
            OPFS unavailable (session-only)
          </button>
        )}
      </div>

      <div className="cards">
        {videos.length === 0 && (
          <div className="muted">
            {opfsAvailable
              ? "No videos yet."
              : "OPFS not supported here. Imported videos won’t persist across refresh."}
          </div>
        )}
        {videos.map((v) => (
          <div className="card" key={v.name}>
            <div className="song">{v.name}</div>
            <div className="muted">{v.size ? (v.size / (1024 * 1024)).toFixed(1) : "?"} MB</div>
            <video
              className="videoPlayer"
              controls
              preload="metadata"
              src={v.url}
              style={{ width: "100%", borderRadius: "8px", marginTop: "8px" }}
            />
            <div className="rowRight">
              <button className="btn small" onClick={() => handleRemove(v.name)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =========================================
   Root App with Tabs + Swipe + Animated Indicator + Light/Dark Toggle
========================================= */
export default function App() {
  const tabs = [
    { id: "scrape", label: "Scraper", comp: TabScraper },
    { id: "home", label: "Video Home", comp: TabAltVideoHome },
    { id: "downloads", label: "Downloads", comp: TabDownloads },
  ];
  const [tab, setTab] = useState(() => ls.get("active_tab", "scrape"));
  const { toast, show } = useToast();

  // THEME: only "light" | "dark"
  const [theme, setTheme] = useState(() => ls.get(THEME_KEY, "light"));

  useEffect(() => {
    ls.set("active_tab", tab);
  }, [tab]);

  // Apply theme to <html> and update meta theme-color
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0b0d12" : "#f7f9fc");
    ls.set(THEME_KEY, theme);
  }, [theme]);

  // Swipe navigation
  const touchStartX = useRef(null);
  function handleTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
  }
  function handleTouchEnd(e) {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 50) {
      const idx = tabs.findIndex((t) => t.id === tab);
      if (dx < 0 && idx < tabs.length - 1) setTab(tabs[idx + 1].id);
      if (dx > 0 && idx > 0) setTab(tabs[idx - 1].id);
    }
    touchStartX.current = null;
  }

  const activeIdx = tabs.findIndex((t) => t.id === tab);
  const ActiveComp = tabs[activeIdx].comp;

  // Toggle theme handler
  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <div className="page" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <nav className="tabs prettyTabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tabBtn ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}

        {/* Sliding indicator spans only the 3 tabs */}
        <div
          className="indicator"
          style={{
            width: `${100 / tabs.length}%`,
            left: `${(100 / tabs.length) * activeIdx}%`,
          }}
        />
      </nav>

      <main className="container fadeSlide">
        <ActiveComp showToast={show} />
      </main>

      <Toast toast={toast} />

      {/* Floating Light/Dark toggle (doesn't affect tabs/swipe) */}
      <button
        className="themeFab"
        aria-label="Toggle theme"
        title={`Switch to ${theme === "dark" ? "Light" : "Dark"} mode`}
        onClick={toggleTheme}
      >
        <span className="emojiIcon">
          {theme === "dark" ? "🌞" : "🌙"}
        </span>
      </button>

      {/* Styles (adds dark theme + FAB; keeps your existing styles) */}
      <style>{`
       
       :root {
        --paper: #ffffff;
        --ink: #1a1a1a;
        --muted: #6b6b6b;
        --brand: #b4532a;        /* terracotta */
        --border: #e8e1db;
        --ok: #2e7d32;
        --warn: #b8791a;
        --err:  #a63d2f;
        --bg: #faf8f6;           /* warm off-white */
      }
      html[data-theme="dark"] {
        --paper: #171311;        /* espresso card */
        --ink: #f2eee9;          /* parchment text */
        --muted: #b8afa8;
        --brand: #c6653a;        /* brighter terracotta for dark */
        --border: #2b231f;
        --ok: #4caf50;
        --warn: #d29a3a;
        --err:  #d06452;
        --bg: #0f0c0a;           /* deep espresso background */
      }
      
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Helvetica Neue", Arial;
        background: var(--bg);
        color: var(--ink);
        transition: background-color .20s ease, color .20s ease;
      }
      
      .page { min-height: 100vh; display: flex; flex-direction: column; }
      
      /* Tabs unchanged layout (3 equal columns) */
      .tabs {
        position: sticky; top: 0; z-index: 5;
        display: grid; grid-template-columns: repeat(3, 1fr);
        border-bottom: 1px solid var(--border);
        background: var(--paper);
        transition: background-color .20s ease, border-color .20s ease;
      }
      .prettyTabs { position: relative; overflow: hidden; }
      .tabBtn {
        padding: 12px 8px; font-weight: 600;
        border: 0; background: transparent; cursor: pointer;
        transition: background .2s, color .2s;
        color: var(--ink);
      }
      .tabBtn.active { color: var(--brand); }
      .tabBtn:not(.active):hover { background: rgba(180, 83, 42, 0.08); }
      
      .indicator {
        position: absolute; bottom: 0; height: 3px; background: var(--brand);
        transition: left .28s ease, width .28s ease;
      }
      
      .container { width: 100%; max-width: 760px; margin: 0 auto; padding: 16px; flex: 1; }
      
      .title { font-size: 1.25rem; font-weight: 700; margin: 6px 0; }
      .subtitle { color: var(--muted); font-size: 0.95rem; margin-bottom: 14px; }
      
      .controls { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 12px; }
      .control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .control label { font-size: 0.9rem; color: var(--ink); }
      .control input {
        width: 100px; padding: 8px 10px; border: 1px solid var(--border);
        border-radius: 8px; font-size: 0.95rem; background: var(--paper); color: var(--ink);
        transition: background-color .20s ease, color .20s ease, border-color .20s ease;
      }
      .hint { font-size: 0.8rem; color: var(--muted); }
      
      .editor {
        width: 100%;
        min-height: 220px;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
        font-size: 16px;
        line-height: 1.4;
        background: var(--paper);
        color: var(--ink);
        outline: none;
        transition: background-color .20s ease, color .20s ease, border-color .20s ease;
      }
      .editor:focus { box-shadow: 0 0 0 2px rgba(180, 83, 42, .35); }
      
      .btnRow { display: grid; grid-template-columns: 1fr; gap: 10px; margin: 14px 0 18px; }
      .btn {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid var(--border);
        background: var(--paper);
        color: var(--ink);
        border-radius: 10px;
        font-size: 0.95rem;
        transition: background-color .20s ease, color .20s ease, border-color .20s ease;
      }
      .btn.small { width: auto; padding: 8px 10px; font-size: 0.9rem; }
      .btn:disabled { opacity: 0.6; }
      .btn:hover { background: rgba(180, 83, 42, 0.08); }
      .primary { background: var(--brand); color: #fff; border-color: var(--brand); }
      .primary:hover { background: #9a4224; }
      
      .stack { display: grid; grid-template-columns: 1fr; gap: 10px; margin-bottom: 12px; }
      .textInput {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 10px;
        font-size: 16px;
        background: var(--paper);
        color: var(--ink);
        transition: background-color .20s ease, color .20s ease, border-color .20s ease;
      }
      
      .cards { display: grid; grid-template-columns: 1fr; gap: 10px; width: 100%; }
      .card {
        background: var(--paper);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px;
        width: 100%;
        max-width: 100%;
        transition: background-color .20s ease, color .20s ease, border-color .20s ease;
      }
      .song { font-weight: 600; font-size: 0.95rem; }
      .link {
        display: inline-block;
        color: var(--brand);
        text-decoration: underline;
        word-break: break-word;
        overflow-wrap: anywhere;
        margin-top: 6px;
        max-width: 100%;
      }
      .rowRight { display: flex; justify-content: flex-end; margin-top: 8px; }
      .muted { color: var(--muted); }
      .error { color: var(--err); margin-top: 6px; font-size: 0.95rem; }
      .h3 { margin: 14px 0 8px; font-size: 1rem; font-weight: 700; }
      
      .channelList { display: grid; gap: 10px; }
      .channelItem {
        display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
        background: var(--paper); padding: 10px; border: 1px solid var(--border); border-radius: 10px;
        transition: background-color .20s ease, color .20s ease, border-color .20s ease;
      }
      .channelIcon { width: 38px; height: 38px; border-radius: 0%; }
      .channelName { color: var(--brand); text-decoration: underline; }
      
      .toast {
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        background: #1f1a18; color: #fff; padding: 10px 14px; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18); font-size: 0.95rem; z-index: 9999; max-width: 90%;
        animation: toast-in .12s ease-out;
      }
      html[data-theme="dark"] .toast { background: #0f0c0a; }
      .toast.success { background: var(--ok); }
      .toast.warn { background: var(--warn); }
      .toast.info { background: var(--muted); }
      @keyframes toast-in { from { transform: translate(-50%, 10px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
      
      /* Smooth page transition on tab change */
      .fadeSlide { animation: fadeSlide 0.25s ease; }
      @keyframes fadeSlide { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
      
      /* Floating theme toggle */
      .themeFab {
        position: fixed; right: 12px; bottom: 16px; z-index: 20;
        width: 42px; height: 42px; border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--paper); color: var(--ink);
        display:flex; align-items:center; justify-content:center;
        font-size: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      }
      .themeFab:hover { background: rgba(180, 83, 42, 0.08); }
      
      @media (min-width: 640px) {
        .controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .btnRow { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .stack { grid-template-columns: 1fr auto; }
      }
      
      .emojiIcon {
        display: inline-block;
        filter: grayscale(1);
        opacity: 0.5;
        font-size: 20px;
        line-height: 1;
      }      
             
      `}</style>
    </div>
  );
}
