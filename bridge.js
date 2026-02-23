// HBCE TELLO BRIDGE — FAIL CLOSED LOCAL EXECUTION (DRY_RUN READY)
// Node >=18 required
//
// DRY_RUN=1 node bridge.js
// - does NOT send UDP commands
// - prints what it would send
//
// Without DRY_RUN, it will try to talk to DJI Tello on 192.168.10.1:8889

import dgram from "dgram";
import http from "http";

const TELLO_IP = "192.168.10.1";
const TELLO_PORT = 8889;
const HTTP_PORT = 17777;

const DRY_RUN = process.env.DRY_RUN === "1";

let state = {
  gate: "DENIED",
  mode: "HOLD",
  integrity: "UNKNOWN",
  estop: true,
  last_event: Date.now()
};

const udp = dgram.createSocket("udp4");

function now(){ return Date.now(); }

function sendUDP(cmd){
  return new Promise(res=>{
    const m = Buffer.from(cmd);
    udp.send(m, 0, m.length, TELLO_PORT, TELLO_IP, ()=>res());
  });
}

async function send(cmd){
  if(DRY_RUN){
    console.log("[DRY_RUN] would send:", cmd);
    return;
  }
  await sendUDP(cmd);
}

async function init(){
  console.log("[INIT] HBCE BRIDGE", DRY_RUN ? "(DRY_RUN)" : "(LIVE_UDP)");
  if(DRY_RUN) return;
  await send("command");
  await send("speed 10");
}

function failClosed(reason){
  state.gate = "DENIED";
  state.mode = "HOLD";
  state.estop = true;
  console.log("[FAIL-CLOSED]", reason);
}

async function execSingleStep(){
  // Single-step discipline: execute at most one action per accepted event.
  // No loops, no continuous motion.
  if(state.estop) return;
  if(state.gate !== "ALLOWED") return;
  if(state.integrity !== "HASH_OK") return;

  if(state.mode === "EXPLORE_SLOW"){
    console.log("[EXEC] EXPLORE_SLOW step");
    await send("forward 20");
  } else if(state.mode === "FOLLOW_PROXIMITY"){
    console.log("[EXEC] FOLLOW_PROXIMITY step");
    await send("cw 15");
  } else {
    console.log("[EXEC] HOLD");
  }

  // After one step, force HOLD locally (hard safety).
  state.mode = "HOLD";
  state.gate = "DENIED";
  state.estop = true;

  console.log("[POST-STEP] forced HOLD + DENIED + ESTOP");
}

const server = http.createServer((req, res) => {
  if(req.method === "POST" && req.url === "/event"){
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try{
        const e = JSON.parse(body || "{}");

        // Strict gating (fail-closed)
        if(e.integrity !== "HASH_OK") { failClosed("INTEGRITY"); }
        else if(e.gate !== "ALLOWED") { failClosed("GATE"); }
        else {
          state.gate = "ALLOWED";
          state.integrity = e.integrity;
          state.mode = e.mode || "HOLD";
          state.estop = !!e.estop;
          state.last_event = now();
          console.log("[EVENT]", state);

          // execute exactly one step, then hard stop
          await execSingleStep();
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok:true, dry_run: DRY_RUN, state }));
      }catch(err){
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok:false, error: String(err) }));
      }
    });
    return;
  }

  if(req.method === "GET" && req.url === "/status"){
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok:true, dry_run: DRY_RUN, state }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

init().then(() => {
  server.listen(HTTP_PORT, () => {
    console.log("[HBCE BRIDGE ACTIVE] http://127.0.0.1:" + HTTP_PORT);
    console.log("Endpoints: POST /event | GET /status");
  });
});
