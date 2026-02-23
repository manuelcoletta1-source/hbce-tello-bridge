import http from "http";
import https from "https";

const PORT = 17777;

let state = {
  gate: "DENIED",
  mode: "HOLD",
  integrity: "UNKNOWN"
};

console.log("HBCE BRIDGE STARTING...");

// ===== FETCH EVENT FROM GITHUB =====
function fetchEvent(){

  const url = "https://manuelcoletta1-source.github.io/hbce-tello-bridge/event.json";

  https.get(url,res=>{
    let data="";

    res.on("data",c=>data+=c);

    res.on("end",()=>{
      try{
        const e = JSON.parse(data);

        console.log("REMOTE EVENT RECEIVED:");
        console.log(e);

        if(e.integrity !== "HASH_OK"){
          state.gate="DENIED";
          state.mode="HOLD";
          state.integrity="FAIL";
          console.log("FAIL CLOSED");
          return;
        }

        state.gate="ALLOWED";
        state.mode=e.mode || "HOLD";
        state.integrity=e.integrity;

        console.log("STATE UPDATED:",state);

      }catch(err){
        console.log("NO VALID EVENT");
      }
    });

  }).on("error",()=>{
    console.log("FETCH ERROR");
  });
}

// controlla ogni 5 secondi
setInterval(fetchEvent,5000);

// ===== STATUS SERVER =====
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

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT,()=>{
  console.log("HBCE BRIDGE ACTIVE");
  console.log("http://127.0.0.1:17777/status");
});
