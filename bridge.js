// HBCE BRIDGE — DRY RUN CORE
// Local execution bridge (no drone required)

import http from "http";

const PORT = 17777;

let state = {
  gate: "DENIED",
  mode: "HOLD",
  integrity: "UNKNOWN"
};

console.log("HBCE BRIDGE STARTING...");

const server = http.createServer((req,res)=>{

  if(req.url === "/status"){
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify({
      ok:true,
      system:"HBCE BRIDGE",
      state
    },null,2));
    return;
  }

  if(req.method==="POST" && req.url==="/event"){
    let body="";
    req.on("data",c=>body+=c);

    req.on("end",()=>{
      console.log("EVENT RECEIVED:");
      console.log(body);

      try{
        const e = JSON.parse(body);

        if(e.integrity!=="HASH_OK"){
          state.gate="DENIED";
          state.mode="HOLD";
          console.log("FAIL CLOSED: integrity");
        }else{
          state.gate="ALLOWED";
          state.mode=e.mode||"HOLD";
        }

      }catch(err){
        console.log("INVALID EVENT");
      }

      res.writeHead(200);
      res.end("ok");
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT,()=>{
  console.log("HBCE BRIDGE ACTIVE");
  console.log("http://127.0.0.1:17777/status");
});
