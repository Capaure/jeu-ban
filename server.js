// server.js — playlist aléatoire + créateur robuste + roundSummary étendu
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Serveur démarré sur http://localhost:" + PORT);
});

// --- Clips dans /public/clipsite ---
const clipPool = [
  { file: "clipsite/clip1.mp4", streamer: "Clip 1", limit: 4.650 },
  { file: "clipsite/clip2.mp4", streamer: "Clip 2", limit: 5.210 },
];

// ---- helpers ----
function randCode(){ const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from({length:4},()=>a[Math.floor(Math.random()*a.length)]).join(""); }
function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }

// construit une playlist de longueur N à partir du pool (shuffle cyclique)
function buildClipOrder(n){
  const order = [];
  while (order.length < n){
    const batch = shuffle(clipPool.map((_,i)=>i));
    order.push(...batch);
  }
  return order.slice(0, n);
}

const rooms = Object.create(null);
const getRoom = c => rooms[c];
function ensureRoom(code){
  if (!rooms[code]) rooms[code] = {
    code, creatorId:null,
    players:new Map(),     // socketId -> {name}
    order:[],              // [{id,name,order}]
    round:1, roundsTotal:1,
    clipOrder:[],          // [indices dans clipPool]
    clipPtr:0,
    previewsUsed:0,
    turnIndex:0,
    current:null,          // {clipFile, streamer, limit, attempts[], phase}
    scores:{},
    bestDelta:{},
  };
  return rooms[code];
}
function currentClip(room){
  const idx = room.clipOrder[room.clipPtr] ?? 0;
  return clipPool[idx];
}

function broadcastLobby(code){
  const r=getRoom(code); if(!r) return;
  const players=Array.from(r.players.entries()).map(([id,p])=>({id,name:p.name}));
  io.to(code).emit("lobbyUpdate",{players,code,creatorId:r.creatorId});
}

// round helpers
function prepareRoundIfMissing(room, {broadcast=true} = {}){
  if (room.current) return false;
  const cc = currentClip(room);
  room.previewsUsed = 0;
  room.current = { clipFile: cc.file, streamer: cc.streamer, limit: cc.limit, attempts: [], phase: "idle" };
  if (broadcast){
    io.to(room.code).emit("newRound",{
      clip: room.current.clipFile,
      streamer: room.current.streamer,
      order: room.order,
      round: room.round,
      roundsTotal: room.roundsTotal,
      limitPublic: room.current.limit,
      currentScores: room.scores,
    });
  }
  return true;
}

function buildRoundResults(room){
  const limit = room.current?.limit ?? 0;
  const arr = (room.current?.attempts||[]).map(a=>({...a, delta: Math.abs((a.time||0)-limit)}));
  arr.sort((x,y)=>x.delta-y.delta);
  const duration = room.current?.attempts?.[0]?.duration ?? (Math.max(limit, ...arr.map(r=>r.time)) + 0.5);
  return { limit, results: arr, duration, round: room.round, roundsTotal: room.roundsTotal };
}

function applyScoring(room){
  const {results} = buildRoundResults(room);
  const pts=[5,3,1];
  results.forEach((r,i)=>{
    const n=r.name;
    room.scores[n]=(room.scores[n]||0)+(pts[i]||0);
    if (room.bestDelta[n]==null || r.delta < room.bestDelta[n]) room.bestDelta[n]=r.delta;
  });
}
function finalPodium(room){
  const players = Array.from(room.players.values()).map(p=>p.name);
  const arr = players.map(n=>({name:n, score:room.scores[n]||0, bestDelta:room.bestDelta[n]??null}));
  arr.sort((a,b)=>b.score-a.score);
  return arr;
}

// ---- sockets ----
io.on("connection",(socket)=>{
  let joinedCode=null;

  socket.on("createGame",({pseudo, roundsTotal})=>{
    const code=randCode();
    const room=ensureRoom(code);
    room.creatorId=socket.id;
    room.roundsTotal=Math.max(1, Number(roundsTotal||1));
    room.clipOrder = buildClipOrder(room.roundsTotal); // <<< playlist aléatoire
    room.clipPtr = 0;
    room.players.set(socket.id,{name:pseudo||"Anonyme"});
    socket.join(code); joinedCode=code;
    socket.emit("gameCreated",{code});
    broadcastLobby(code);
  });

  socket.on("joinGame",({code, pseudo})=>{
    if(!code) return socket.emit("errorMsg","Code manquant");
    const room=getRoom(code); if(!room) return socket.emit("errorMsg","Salon introuvable");
    room.players.set(socket.id,{name:pseudo||"Anonyme"});
    socket.join(code); joinedCode=code;
    socket.emit("joined",{code});
    broadcastLobby(code);
  });

  // Re‑couronne si besoin : si le créateur “historique” n'est plus là, celui qui appelle récupère
  socket.on("claimCreator",({code})=>{
    const room=getRoom(code); if(!room) return;
    const creatorStillHere = room.creatorId && room.players.has(room.creatorId);
    if (!creatorStillHere){
      room.creatorId = socket.id;
      io.to(socket.id).emit("youAreCreator");
      broadcastLobby(code);
    } else if (room.creatorId===socket.id){
      io.to(socket.id).emit("youAreCreator");
    }
  });

  socket.on("getLobby",(code)=>broadcastLobby(code));

  // Depuis le lobby → tout le monde va au jeu
  socket.on("openGameFromLobby", (code) => {
    const room = getRoom(code); if (!room) return;
    if (socket.id !== room.creatorId) return socket.emit("errorMsg", "Seul le créateur peut ouvrir le jeu.");
    io.to(code).emit("goToGamePage");
  });

  // game.html prêt → préparer round
  socket.on("readyForRound",(code)=>{
    const room=getRoom(code); if(!room) return;
    prepareRoundIfMissing(room,{broadcast:true});
  });

  // 2 previews max pilotés par créateur
  socket.on("startPreview",(code)=>{
    const room=getRoom(code); if(!room) return;
    if (socket.id!==room.creatorId) return socket.emit("errorMsg","Seul le créateur peut lancer le visionnage.");
    prepareRoundIfMissing(room,{broadcast:true});
    if (room.previewsUsed>=2) return socket.emit("errorMsg","Les 2 visionnages ont déjà été utilisés.");
    room.previewsUsed++;
    room.current.phase="preview";
    io.to(code).emit("previewStart");
  });

  // démarrage manche → ordre aléatoire des JOUEURS
  socket.on("startGame",(code)=>{
    const room=getRoom(code); if(!room) return;
    if (socket.id!==room.creatorId) return socket.emit("errorMsg","Seul le créateur peut démarrer la manche.");
    prepareRoundIfMissing(room,{broadcast:true});

    const players=Array.from(room.players.entries()).map(([id,p])=>({id,name:p.name}));
    room.order = shuffle(players).map((p,i)=>({...p, order:i+1}));
    room.turnIndex=0;
    room.current.phase="playing";

    io.to(code).emit("newRound",{
      clip: room.current.clipFile,
      streamer: room.current.streamer,
      order: room.order,
      round: room.round,
      roundsTotal: room.roundsTotal,
      limitPublic: room.current.limit,
      currentScores: room.scores,
    });

    const first=room.order[0];
    if (first) io.to(code).emit("startTurn",{playerId:first.id, playerName:first.name});
  });

  socket.on("stopAt",({code,time,duration})=>{
    const room=getRoom(code); if(!room) return;
    if (!room.current || room.current.phase!=="playing") return;
    const cur=room.order[room.turnIndex]; if(!cur || cur.id!==socket.id) return;
    const name=room.players.get(socket.id)?.name||"???";
    room.current.attempts.push({id:socket.id, name, time:Number(time)||0, duration:Number(duration)||0});
    io.to(code).emit("playerStopped",{playerId:socket.id, time:Number(time)||0});
    room.turnIndex++;
    if (room.turnIndex < room.order.length){
      const next=room.order[room.turnIndex];
      io.to(code).emit("startTurn",{playerId:next.id, playerName:next.name});
    } else {
      room.current.phase="results";
      applyScoring(room);
      io.to(code).emit("roundSummary", buildRoundResults(room));
    }
  });

  // créateur ouvre la page résultats chez tous
  socket.on("openResults", (code) => {
    const room=getRoom(code); if(!room) return;
    if (socket.id!==room.creatorId) return;
    io.to(code).emit("goToResults");
  });

  socket.on("getResults",(code)=>{
    const room=getRoom(code); if(!room || !room.current) return;
    socket.emit("roundSummary", buildRoundResults(room));
  });

  socket.on("nextRound",(code)=>{
    const room=getRoom(code); if(!room) return;
    if (socket.id!==room.creatorId) return socket.emit("errorMsg","Seul le créateur peut continuer.");
    if (room.round >= room.roundsTotal){
      io.to(code).emit("gameOver",{podium:finalPodium(room)});
      return;
    }
    room.round++;
    room.clipPtr = Math.min(room.clipPtr+1, room.clipOrder.length-1); // avance dans la playlist
    room.current=null; room.previewsUsed=0; room.order=[]; room.turnIndex=0;
    io.to(code).emit("goToGame");
  });

  socket.on("getFinal",(code)=>{
    const room=getRoom(code); if(!room) return;
    socket.emit("finalPodium",{podium:finalPodium(room)});
  });

  socket.on("disconnect",()=>{
    if(!joinedCode) return;
    const room=getRoom(joinedCode); if(!room) return;
    // supprime le joueur; si c'était le créateur, on laisse creatorId comme tel (il sera réattribué via claimCreator au prochain appel)
    room.players.delete(socket.id);
    if (room.creatorId===socket.id){
      // on NE remet PAS à null ici : claimCreator gérera la relève proprement
      // room.creatorId = null;  // ← on évite ça pour ne pas perdre l'info trop tôt
    }
    broadcastLobby(joinedCode);
  });
});

server.listen(PORT, ()=>console.log("Serveur sur http://localhost:"+PORT));
 