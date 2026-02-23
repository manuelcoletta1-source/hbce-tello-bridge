import http from "http";
import https from "https";
import fs from "fs";

const PORT = 17777;
const EVENT_URL = "https://manuelcoletta1-source.github.io/hbce-tello-bridge/event.json";
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
    // first run or unreadable file -> ok
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
    // fail-closed does not depend on persistence; ignore
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
  // Accept integer or numeric string
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

  // ---- E-STOP OVERRIDE (absolute) ----
  // If estop is true, deny + hold regardless of any other fields.
  if(e && e.estop === true){
    setFailClosed("ESTOP_OVERRIDE");
    return;
  }

  // ---- Event object sanity ----
  if(!e || typeof e !== "object"){
    setFailClosed("EVENT_INVALID");
    return;
  }

  // ---- Anti-replay / monotonic event_id ----
  const eid = parseEventId(e);
  if(!Number.isFinite(eid)){
    setFailClosed("EVENT_ID_MISSING_OR_INVALID");
    return;
  }

  if(eid <= diagnostics.last_applied_event_id){
    // Ignore old/replayed events (no state change)
    diagnostics.last_error = "EVENT_REPLAY_IGNORED";
    console.log("[REPLAY_IGNORED] event_id=", eid, "last_applied=", diagnostics.last_applied_event_id);
    return;
  }

  // ---- Deterministic gating ----
  if(e.integrity !== "HASH_OK"){
    setFailClosed("INTEGRITY_NOT_HASH_OK");
    return;
  }

  if(e.gate !== "ALLOWED"){
    setFailClosed("GATE_NOT_ALLOWED");
    return;
  }

  // Apply
  diagnostics.last_applied_event_id = eid;
  persist();

  state.gate = "ALLOWED";
  state.mode = e.mode || "HOLD";
  state.integrity = "HASH_OK";
  diagnostics.last_error = null;

  console.log("[APPLIED] event_id=", eid);
  console.log("[STATE_UPDATED]", state);
}

function fetchEvent(){
  diagnostics.last_fetch_iso = nowISO();
  diagnostics.last_error = null;

  https.get(EVENT_URL, (res) => {
    diagnostics.last_status_code = res.statusCode || null;
    diagnostics.last_content_type = String(res.headers["content-type"] || "");

    let data = "";
    res.on("data", (c) => data += c);

    res.on("end", () => {
      console.log("[FETCH]", diagnostics.last_fetch_iso, "status=", diagnostics.last_status_code, "ct=", diagnostics.last_content_type);

      try{
        const e = JSON.parse(data);
        console.log("[REMOTE_EVENT]", e);
        applyEvent(e);
      }catch(err){
        const snippet = String(data || "").slice(0, 140).replace(/\s+/g, " ").trim();
        setFailClosed("JSON_PARSE_FAILED: " + String(err));
        console.log("[BODY_SNIPPET]", snippet);
      }
    });
  }).on("error", (err) => {
    setFailClosed("FETCH_ERROR: " + String(err));
  });
}

console.log("HBCE BRIDGE STARTING...");
console.log("EVENT_URL:", EVENT_URL);

// Load persisted monotonic counter
loadPersisted();
console.log("[ANTI_REPLAY] last_applied_event_id =", diagnostics.last_applied_event_id);

// Fetch immediately (no waiting)
fetchEvent();

// Poll
setInterval(fetchEvent, POLL_MS);

// Local status server
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

  if(req.url === "/event_url"){
    res.writeHead(200, { "content-type":"text/plain" });
    res.end(EVENT_URL);
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log("HBCE BRIDGE ACTIVE");
  console.log("http://127.0.0.1:17777/status");
});
