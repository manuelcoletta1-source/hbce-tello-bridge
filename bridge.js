import http from "http";
import https from "https";

const PORT = 17777;
const EVENT_URL = "https://manuelcoletta1-source.github.io/hbce-tello-bridge/event.json";
const POLL_MS = 5000;

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
  last_event: null
};

function nowISO(){ return new Date().toISOString(); }

function setFailClosed(reason){
  state.gate = "DENIED";
  state.mode = "HOLD";
  state.integrity = "FAIL";
  diagnostics.last_error = reason;
  console.log("[FAIL_CLOSED]", reason);
}

function applyEvent(e){
  diagnostics.last_event = e;

  // ---- E-STOP OVERRIDE (absolute) ----
  // If estop is true, deny + hold regardless of any other fields.
  if(e && e.estop === true){
    setFailClosed("ESTOP_OVERRIDE");
    return;
  }

  // ---- Deterministic gating ----
  if(!e || typeof e !== "object"){
    setFailClosed("EVENT_INVALID");
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

  state.gate = "ALLOWED";
  state.mode = e.mode || "HOLD";
  state.integrity = "HASH_OK";
  diagnostics.last_error = null;

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
