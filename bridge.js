// HBCE TELLO BRIDGE — FAIL CLOSED LOCAL EXECUTION
// Node >=18 required

import dgram from "dgram";
import http from "http";

const TELLO_IP = "192.168.10.1";
const TELLO_PORT = 8889;
const HTTP_PORT = 17777;

let state = {
  gate: "DENIED",
  mode: "HOLD",
  integrity: "UNKNOWN",
  estop: true,
  last_event: Date.now()
};

const udp = dgram.createSocket("udp4");

function send(cmd){
  return new Promise(res=>{
    const m = Buffer.from(cmd);
    udp.send(m,0,m.length,TELLO_PORT,TELLO_IP,()=>res());
  });
}

async function init(){
  console.log("[INIT] TELLO SDK");
  await send("command");
  await send("speed 10");
}

function failClosed(reason){
  state.gate="DENIED";
  state.mode="HOLD";
  state.estop=true;
  console.log("[FAIL-CLOSED]",reason);
}

async function exec(){
  if(state.estop) return;

  if(state.gate!=="ALLOWED") return;
  if(state.integrity!=="HASH_OK") return;

  if(state.mode==="EXPLORE_SLOW"){
    console.log("[MOVE] forward 20");
    await send("forward 20");
  }

  if(state.mode==="FOLLOW_PROXIMITY"){
    console.log("[MOVE] cw 15");
    await send("cw 15");
  }
}

setInterval(exec,1200);

const server = http.createServer((req,res)=>{
  if(req.method==="POST" && req.url==="/event"){
    let body="";
    req.on("data",c=>body+=c);
    req.on("end",async()=>{
      try{
        const e = JSON.parse(body||"{}");

        if(e.integrity!=="HASH_OK") return failClosed("INTEGRITY");
        if(e.gate!=="ALLOWED") return failClosed("GATE");

        state.gate="ALLOWED";
        state.integrity=e.integrity;
        state.mode=e.mode||"HOLD";
        state.estop=!!e.estop;
        state.last_event=Date.now();

        console.log("[EVENT]",state);

        res.writeHead(200);
        res.end("ok");
      }catch(err){
        res.writeHead(400);
        res.end("err");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

init().then(()=>{
  server.listen(HTTP_PORT,()=>{
    console.log("[HBCE BRIDGE ACTIVE]");
    console.log("http://127.0.0.1:"+HTTP_PORT);
  });
});
