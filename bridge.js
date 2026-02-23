import http from "http";
import https from "https";
import fs from "fs";

const PORT = 17777;

// Append-only ledger pointers
const HEAD_URL = "https://manuelcoletta1-source.github.io/hbce-tello-bridge/head.json";
const BASE_URL = "https://manuelcoletta1-source.github.io/hbce-tello-bridge/";

// Backward-compat fallback (optional)
const LEGACY_EVENT_URL = "https://manuelcoletta1-source.github.io/hbce-tello-bridge/event.json";

const POLL_MS = 5000;

// Persisted local state (anti-replay survives restart)
const STATE_FILE = "./bridge_state.json";

let state = {
  gate: "DENIED",
  mode: "HOLD",
  integrity: "UNKNOWN"
};

let diagnostics = {
  last_fetch_iso: null,
  last_status_code: null,
  last_content_type: null,
  last_error: null,

  head_url: HEAD_URL,
  last_head: null,
  last_head_event_url: null,

  last_event: null,
  last_applied_event_id: 0
};

function nowISO(){ return new Date().toISOString(); }

function loadPersisted(){
  try{
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const obj = JSON.parse(raw);
    if(obj && typeof obj.last_applied_event_id === "number"){
      diagnostics.last_applied_event_id = obj.last_applied_event_id;
    }
  }catch{
    // ok
  }
}

function persist(){
  try{
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ last_applied_event_id: diagnostics.last_applied_event_id }, null, 2),
      "utf8"
    );
  }catch{
    // ok
  }
}

function setFailClosed(reason){
  state.gate = "DENIED";
  state.mode = "HOLD";
  state.integrity = "FAIL";
  diagnostics.last_error = reason;
  console.log("[FAIL_CLOSED]", reason);
}

function parseEventId(e){
  const id = e?.event_id;

  if(typeof id === "number" && Number.isFinite(id)) return Math.trunc(id);

  if(typeof id === "string"){
    const s = id.trim();
    if(!s) return NaN;
    const n = Number(s);
    if(Number.isFinite(n)) return Math.trunc(n);
  }

  return NaN;
}

function applyEvent(e){
  diagnostics.last_event = e;

  // E-STOP override
  if(e && e.estop === true){
    setFailClosed("ESTOP_OVERRIDE");
    return;
  }

  if(!e || typeof e !== "object"){
    setFailClosed("EVENT_INVALID");
    return;
  }

  const eid = parseEventId(e);
  if(!Number.isFinite(eid)){
    setFailClosed("EVENT_ID_MISSING_OR_INVALID");
    return;
  }

  if(eid <= diagnostics.last_applied_event_id){
    diagnostics.last_error = "EVENT_REPLAY_IGNORED";
    console.log("[REPLAY_IGNORED] event_id=", eid, "last_applied=", diagnostics.last_applied_event_id);
    return;
  }

  if(e.integrity !== "HASH_OK"){
    setFailClosed("INTEGRITY_NOT_HASH_OK");
    return;
  }

  if(e.gate !== "ALLOWED"){
    setFailClosed("GATE_NOT_ALLOWED");
    return;
  }

  diagnostics.last_applied_event_id = eid;
  persist();

  state.gate = "ALLOWED";
  state.mode = e.mode || "HOLD";
  state.integrity = "HASH_OK";
  diagnostics.last_error = null;

  console.log("[APPLIED] event_id=", eid);
  console.log("[STATE_UPDATED]", state);
}

function httpsGetText(url){
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      diagnostics.last_status_code = res.statusCode || null;
      diagnostics.last_content_type = String(res.headers["content-type"] || "");

      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve(data));
    }).on("error", (err) => reject(err));
  });
}

async function fetchViaHead(){
  diagnostics.last_fetch_iso = nowISO();
  diagnostics.last_error = null;

  console.log("[FETCH_HEAD]", diagnostics.last_fetch_iso);

  const headRaw = await httpsGetText(HEAD_URL);
  let headObj;

  try{
    headObj = JSON.parse(headRaw);
  }catch(err){
    const snippet = String(headRaw || "").slice(0, 140).replace(/\s+/g, " ").trim();
    setFailClosed("HEAD_JSON_PARSE_FAILED: " + String(err));
    console.log("[HEAD_SNIPPET]", snippet);
    return;
  }

  diagnostics.last_head = headObj;

  const path = headObj?.head?.path;
  if(typeof path !== "string" || !path.trim()){
    setFailClosed("HEAD_PATH_MISSING");
    return;
  }

  const eventUrl = BASE_URL + path.replace(/^\/+/, "");
  diagnostics.last_head_event_url = eventUrl;

  const eventRaw = await httpsGetText(eventUrl);

  try{
    const e = JSON.parse(eventRaw);
    console.log("[REMOTE_EVENT]", e);
    applyEvent(e);
  }catch(err){
    const snippet = String(eventRaw || "").slice(0, 140).replace(/\s+/g, " ").trim();
    setFailClosed("EVENT_JSON_PARSE_FAILED: " + String(err));
    console.log("[EVENT_SNIPPET]", snippet);
  }
}

async function fetchLegacyEvent(){
  diagnostics.last_fetch_iso = nowISO();
  diagnostics.last_error = null;

  console.log("[FETCH_LEGACY]", diagnostics.last_fetch_iso);

  const raw = await httpsGetText(LEGACY_EVENT_URL);
  try{
    const e = JSON.parse(raw);
    console.log("[REMOTE_EVENT_LEGACY]", e);
    applyEvent(e);
  }catch(err){
    const snippet = String(raw || "").slice(0, 140).replace(/\s+/g, " ").trim();
    setFailClosed("LEGACY_JSON_PARSE_FAILED: " + String(err));
    console.log("[LEGACY_SNIPPET]", snippet);
  }
}

async function tick(){
  try{
    await fetchViaHead();
  }catch(err){
    console.log("[HEAD_FETCH_ERROR]", String(err));
    // fallback to legacy if head fetch fails
    try{
      await fetchLegacyEvent();
    }catch(err2){
      setFailClosed("FETCH_ERROR: " + String(err2));
    }
  }
}

console.log("HBCE BRIDGE STARTING...");
console.log("HEAD_URL:", HEAD_URL);

loadPersisted();
console.log("[ANTI_REPLAY] last_applied_event_id =", diagnostics.last_applied_event_id);

// immediate
tick();

// poll
setInterval(tick, POLL_MS);

// status server
const server = http.createServer((req, res) => {
  if(req.url === "/status"){
    res.writeHead(200, { "content-type":"application/json" });
    res.end(JSON.stringify({
      ok: true,
      system: "HBCE BRIDGE",
      state,
      diagnostics
    }, null, 2));
    return;
  }

  if(req.url === "/head_url"){
    res.writeHead(200, { "content-type":"text/plain" });
    res.end(HEAD_URL);
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log("HBCE BRIDGE ACTIVE");
  console.log("http://127.0.0.1:17777/status");
});
