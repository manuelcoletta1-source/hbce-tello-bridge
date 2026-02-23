// HBCE TELLO BRIDGE — FAIL CLOSED LOCAL EXECUTION (DRY_RUN + LEDGER)
// Node >=18 required
//
// Run (dry):
//   DRY_RUN=1 node bridge.js
//
// Endpoints:
//   POST /event   (ingest deterministic control event)
//   GET  /status  (current state)
//   GET  /ledger  (read append-only ledger)
//   GET  /export  (download ledger json)

import dgram from "dgram";
import http from "http";
import fs from "fs";

const TELLO_IP = "192.168.10.1";
const TELLO_PORT = 8889;
const HTTP_PORT = 17777;

const DRY_RUN = process.env.DRY_RUN === "1";

// Local append-only ledger file (repo root)
const LEDGER_FILE = "./bridge_ledger.json";

let state = {
  gate: "DENIED",
  mode: "HOLD",
  integrity: "UNKNOWN",
  estop: true,
  last_event: Date.now()
};

const udp = dgram.createSocket("udp4");

function now(){ return Date.now(); }
function nowISO(){ return new Date().toISOString(); }

function readLedger(){
  try{
    const raw = fs.readFileSync(LEDGER_FILE, "utf8");
    const obj = JSON.parse(raw);
    if(obj && Array.isArray(obj.entries)) return obj;
    return { hbce:"HBCE-BRIDGE-LEDGER-v1", entries: [] };
  }catch{
    return { hbce:"HBCE-BRIDGE-LEDGER-v1", entries: [] };
  }
}

function appendLedger(entry){
  const led = readLedger();
  led.entries.push(entry);
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(led, null, 2), "utf8");
}

function sendUDP(cmd){
  return new Promise(res=>{
    const m = Buffer.from(cmd);
    udp.send(m, 0, m.length, TELLO_PORT, TELLO_IP, ()=>res());
  });
}

async function send(cmd){
  if(DRY_RUN){
    console.log("[DRY_RUN] would send:", cmd);
    appendLedger({
      kind: "DRY_SEND",
      timestamp: nowISO(),
      cmd
    });
    return;
  }
  await sendUDP(cmd);
  appendLedger({
    kind: "UDP_SEND",
    timestamp: nowISO(),
    cmd,
    target: `${TELLO_IP}:${TELLO_PORT}`
  });
}

async function init(){
  console.log("[INIT] HBCE BRIDGE", DRY_RUN ? "(DRY_RUN)" : "(LIVE_UDP)");
  appendLedger({
    kind: "BOOT",
    timestamp: nowISO(),
    dry_run: DRY_RUN,
    http_port: HTTP_PORT
  });

  if(DRY_RUN) return;

  try{
    await send("command");
    await send("speed 10");
  }catch(e){
    console.log("[TELLO] init error:", String(e));
    appendLedger({
      kind: "TELLO_INIT_ERROR",
      timestamp: nowISO(),
      error: String(e)
    });
  }
}

function failClosed(reason){
  state.gate = "DENIED";
  state.mode = "HOLD";
  state.estop = true;

  console.log("[FAIL-CLOSED]", reason);

  appendLedger({
    kind: "FAIL_CLOSED",
    timestamp: nowISO(),
    reason,
    state: { ...state }
  });
}

async function execSingleStep(){
  // Single-step discipline: execute at most one action per accepted event.
  // After one step: force HOLD + DENIED + ESTOP.
  if(state.estop){
    appendLedger({ kind:"EXEC_SKIP", timestamp: nowISO(), reason:"ESTOP_TRUE" });
    return;
  }
  if(state.gate !== "ALLOWED"){
    appendLedger({ kind:"EXEC_SKIP", timestamp: nowISO(), reason:"GATE_NOT_ALLOWED" });
    return;
  }
  if(state.integrity !== "HASH_OK"){
    appendLedger({ kind:"EXEC_SKIP", timestamp: nowISO(), reason:"INTEGRITY_NOT_OK" });
    return;
  }

  if(state.mode === "EXPLORE_SLOW"){
    appendLedger({ kind:"EXEC_STEP", timestamp: nowISO(), mode:"EXPLORE_SLOW" });
    console.log("[EXEC] EXPLORE_SLOW step");
    await send("forward 20");
  } else if(state.mode === "FOLLOW_PROXIMITY"){
    appendLedger({ kind:"EXEC_STEP", timestamp: nowISO(), mode:"FOLLOW_PROXIMITY" });
    console.log("[EXEC] FOLLOW_PROXIMITY step");
    await send("cw 15");
  } else {
    appendLedger({ kind:"EXEC_STEP", timestamp: nowISO(), mode:"HOLD" });
    console.log("[EXEC] HOLD");
  }

  // Force safe stop after single step
  state.mode = "HOLD";
  state.gate = "DENIED";
  state.estop = true;

  appendLedger({
    kind: "POST_STEP_FORCED_HALT",
    timestamp: nowISO(),
    state: { ...state }
  });

  console.log("[POST-STEP] forced HOLD + DENIED + ESTOP");
}

function json(res, code, obj){
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj, null, 2));
}

const server = http.createServer((req, res) => {
  // ---- POST /event ----
  if(req.method === "POST" && req.url === "/event"){
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try{
        const e = JSON.parse(body || "{}");

        appendLedger({
          kind: "EVENT_INGEST",
          timestamp: nowISO(),
          event: e
        });

        // Strict gating (fail-closed)
        if(e.integrity !== "HASH_OK"){
          failClosed("INTEGRITY");
        } else if(e.gate !== "ALLOWED"){
          failClosed("GATE");
        } else {
          state.gate = "ALLOWED";
          state.integrity = e.integrity;
          state.mode = e.mode || "HOLD";
          state.estop = !!e.estop;
          state.last_event = now();

          appendLedger({
            kind: "STATE_ACCEPT",
            timestamp: nowISO(),
            state: { ...state }
          });

          console.log("[EVENT]", state);

          // Execute exactly one step, then hard stop
          await execSingleStep();
        }

        json(res, 200, { ok:true, dry_run: DRY_RUN, state });
      }catch(err){
        appendLedger({
          kind: "EVENT_PARSE_ERROR",
          timestamp: nowISO(),
          error: String(err)
        });
        json(res, 400, { ok:false, error: String(err) });
      }
    });
    return;
  }

  // ---- GET /status ----
  if(req.method === "GET" && req.url === "/status"){
    return json(res, 200, { ok:true, dry_run: DRY_RUN, state });
  }

  // ---- GET /ledger ----
  if(req.method === "GET" && req.url === "/ledger"){
    const led = readLedger();
    return json(res, 200, { ok:true, ledger: led });
  }

  // ---- GET /export ----
  if(req.method === "GET" && req.url === "/export"){
    const led = readLedger();
    res.writeHead(200, {
      "content-type": "application/json",
      "content-disposition": 'attachment; filename="bridge_ledger_export.json"'
    });
    res.end(JSON.stringify(led, null, 2));
    appendLedger({ kind:"LEDGER_EXPORT", timestamp: nowISO() });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

init().then(() => {
  server.listen(HTTP_PORT, () => {
    console.log("[HBCE BRIDGE ACTIVE] http://127.0.0.1:" + HTTP_PORT);
    console.log("Endpoints: POST /event | GET /status | GET /ledger | GET /export");
  });
});
