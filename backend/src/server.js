require("dotenv").config();
const express=require("express");
const cors=require("cors");
const helmet=require("helmet");
const morgan=require("morgan");
const http=require("http");
const { Server }=require("socket.io");
const { v4: uuidv4 }=require("uuid");

const { query }=require("./db");
const { requireApiKey, getActor }=require("./mw");
const { getPricingFromEnv, calcFare, calcCommission }=require("./pricing");
const { findNearbyDrivers, createOffer, acceptOffer, clearOffer }=require("./dispatch");

const app=express();
app.use(cors());
app.use(helmet());
app.use(express.json({limit:"1mb"}));
app.use(morgan("dev"));

const server=http.createServer(app);
const io=new Server(server,{cors:{origin:"*"}});

const socketsByDriverId=new Map();
const socketsByPassengerUserId=new Map();

async function ensureUser(telegramId, role){
  const u=await query("SELECT * FROM users WHERE telegram_id=$1",[telegramId]);
  if(u.rows.length){
    if(role && u.rows[0].role!==role){
      await query("UPDATE users SET role=$1 WHERE id=$2",[role,u.rows[0].id]);
      return (await query("SELECT * FROM users WHERE id=$1",[u.rows[0].id])).rows[0];
    }
    return u.rows[0];
  }
  return (await query(
    "INSERT INTO users (telegram_id,role,created_at) VALUES ($1,$2,NOW()) RETURNING *",
    [telegramId, role||"passenger"]
  )).rows[0];
}
async function ensureDriver(userId){
  const d=await query("SELECT * FROM drivers WHERE user_id=$1",[userId]);
  if(d.rows.length) return d.rows[0];
  return (await query(
    "INSERT INTO drivers (user_id,status,rating,reject_count,wallet_balance,created_at) VALUES ($1,'offline',5.0,0,0,NOW()) RETURNING *",
    [userId]
  )).rows[0];
}
async function logTrip(tripId, type, payload){
  await query("INSERT INTO trip_events (trip_id,type,payload,created_at) VALUES ($1,$2,$3,NOW())",
    [tripId, type, payload?JSON.stringify(payload):null]
  );
}

function emitDriver(driverId, event, payload){
  const sid=socketsByDriverId.get(String(driverId));
  if(sid) io.to(sid).emit(event,payload);
}
function emitPassenger(userId, event, payload){
  const sid=socketsByPassengerUserId.get(String(userId));
  if(sid) io.to(sid).emit(event,payload);
}

app.get("/health",(req,res)=>res.json({ok:true, t:new Date().toISOString()}));

app.post("/api/register", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const role=req.body.role==="driver" ? "driver" : "passenger";
  const user=await ensureUser(actor.telegramId, role);
  if(req.body.name) await query("UPDATE users SET name=$1 WHERE id=$2",[String(req.body.name),user.id]);
  if(req.body.phone) await query("UPDATE users SET phone=$1 WHERE id=$2",[String(req.body.phone),user.id]);
  let driver=null;
  if(role==="driver") driver=await ensureDriver(user.id);
  res.json({user, driver});
});

app.post("/api/driver/profile", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const { car_model, plate }=req.body||{};
  await query("UPDATE drivers SET car_model=$1, plate=$2 WHERE id=$3",
    [car_model?String(car_model):null, plate?String(plate):null, driver.id]
  );
  res.json({driver:(await query("SELECT * FROM drivers WHERE id=$1",[driver.id])).rows[0]});
});

app.post("/api/driver/status", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const status=req.body.status==="online" ? "online" : "offline";
  const pricing=getPricingFromEnv();
  if(status==="online"){
    const cur=(await query("SELECT wallet_balance FROM drivers WHERE id=$1",[driver.id])).rows[0];
    if(Number(cur.wallet_balance) < pricing.minDriverBalance){
      return res.status(400).json({error:"Balance too low. Top up required.", minBalance:pricing.minDriverBalance});
    }
  }
  await query("UPDATE drivers SET status=$1 WHERE id=$2",[status,driver.id]);
  res.json({driver:(await query("SELECT * FROM drivers WHERE id=$1",[driver.id])).rows[0]});
});

app.post("/api/trips/create", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"passenger");
  const b=req.body||{};
  if(b.pickup_lat==null||b.pickup_lng==null) return res.status(400).json({error:"pickup required"});
  if(b.drop_lat==null||b.drop_lng==null) return res.status(400).json({error:"drop required"});

  const pricing=getPricingFromEnv();
  const fare_est=calcFare(Number(b.est_distance_km||0), pricing);
  const commission_est=calcCommission(fare_est, pricing);

  const tripId=uuidv4();
  await query(`
    INSERT INTO trips
    (id, passenger_user_id, status,
     pickup_lat, pickup_lng, pickup_address,
     drop_lat, drop_lng, drop_address,
     est_distance_km, fare_est, commission_est, payment_method,
     created_at, updated_at)
    VALUES ($1,$2,'SEARCHING',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
  `,[
    tripId, user.id,
    b.pickup_lat, b.pickup_lng, b.pickup_address||null,
    b.drop_lat, b.drop_lng, b.drop_address||null,
    Number(b.est_distance_km||0),
    fare_est, commission_est,
    (b.payment_method==="CARD") ? "CARD" : "CASH"
  ]);
  await logTrip(tripId,"TRIP_CREATED",{fare_est,commission_est});

  const nearby=await findNearbyDrivers({
    lat:Number(b.pickup_lat), lng:Number(b.pickup_lng),
    radiusKm:6, limit:5, minBalance:pricing.minDriverBalance
  });
  const driverIds=nearby.map(x=>x.driver_id);
  createOffer(tripId, driverIds, 20000);
  driverIds.forEach(did=>{
    emitDriver(did,"trip_offer",{
      trip_id:tripId,
      pickup_lat:b.pickup_lat, pickup_lng:b.pickup_lng, pickup_address:b.pickup_address||"",
      drop_lat:b.drop_lat, drop_lng:b.drop_lng, drop_address:b.drop_address||"",
      fare_est,
      payment_method:(b.payment_method==="CARD")?"CARD":"CASH"
    });
  });

  res.json({trip_id:tripId,status:"SEARCHING",offered_drivers:driverIds.length,fare_est,commission_est});
});

app.post("/api/trips/accept", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const { trip_id }=req.body||{};
  if(!trip_id) return res.status(400).json({error:"trip_id required"});
  if(!acceptOffer(trip_id, driver.id)) return res.status(409).json({error:"Offer expired or not assigned"});

  await query("UPDATE trips SET driver_id=$1, status='ACCEPTED', updated_at=NOW() WHERE id=$2 AND status='SEARCHING'",
    [driver.id, trip_id]
  );
  const trip=(await query("SELECT * FROM trips WHERE id=$1",[trip_id])).rows[0];
  await logTrip(trip_id,"ACCEPTED",{driver_id:driver.id});
  clearOffer(trip_id);
  emitPassenger(trip.passenger_user_id,"trip_update",{trip_id,status:"ACCEPTED",driver_id:driver.id});
  res.json({ok:true});
});

app.post("/api/trips/reject", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const { trip_id }=req.body||{};
  if(!trip_id) return res.status(400).json({error:"trip_id required"});
  await query("UPDATE drivers SET reject_count=reject_count+1, rating=GREATEST(1.0, rating-0.03) WHERE id=$1",[driver.id]);
  await logTrip(trip_id,"REJECTED",{driver_id:driver.id});
  res.json({ok:true});
});

app.post("/api/trips/status", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const { trip_id, status, distance_km_final }=req.body||{};
  if(!trip_id||!status) return res.status(400).json({error:"trip_id and status required"});
  const allowed=["ARRIVED","STARTED","COMPLETED","CANCELED"];
  if(!allowed.includes(status)) return res.status(400).json({error:"invalid status"});
  const trip=(await query("SELECT * FROM trips WHERE id=$1",[trip_id])).rows[0];
  if(!trip) return res.status(404).json({error:"trip not found"});
  if(String(trip.driver_id)!==String(driver.id)) return res.status(403).json({error:"not your trip"});
  const pricing=getPricingFromEnv();

  if(status==="COMPLETED"){
    const dist=Number(distance_km_final||trip.est_distance_km||0);
    const fare=calcFare(dist,pricing);
    const commission=calcCommission(fare,pricing);
    await query("UPDATE trips SET status='COMPLETED', distance_km_final=$1, fare_total=$2, commission=$3, updated_at=NOW() WHERE id=$4",
      [dist,fare,commission,trip_id]
    );
    await query("INSERT INTO wallet_transactions (driver_id,type,amount,ref,status,created_at) VALUES ($1,'COMMISSION',$2,$3,'DONE',NOW())",
      [driver.id, -commission, trip_id]
    );
    await query("UPDATE drivers SET wallet_balance=wallet_balance-$1 WHERE id=$2",[commission,driver.id]);
    await logTrip(trip_id,"COMPLETED",{dist,fare,commission});
    emitPassenger(trip.passenger_user_id,"trip_update",{trip_id,status:"COMPLETED",fare_total:fare,commission});
    emitDriver(driver.id,"trip_update",{trip_id,status:"COMPLETED",fare_total:fare,commission});
    return res.json({ok:true,fare_total:fare,commission});
  }

  await query("UPDATE trips SET status=$1, updated_at=NOW() WHERE id=$2",[status,trip_id]);
  await logTrip(trip_id,status,{driver_id:driver.id});
  emitPassenger(trip.passenger_user_id,"trip_update",{trip_id,status});
  emitDriver(driver.id,"trip_update",{trip_id,status});
  res.json({ok:true});
});

app.get("/api/driver/earnings", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const range=String(req.query.range||"day");
  let interval="1 day"; if(range==="week") interval="7 days"; if(range==="month") interval="30 days";
  const r=await query(`
    SELECT COUNT(*)::int as trips,
           COALESCE(SUM(fare_total),0)::float as gross,
           COALESCE(SUM(commission),0)::float as commission
    FROM trips WHERE driver_id=$1 AND status='COMPLETED' AND updated_at > NOW() - INTERVAL '${interval}'
  `,[driver.id]);
  const d=(await query("SELECT wallet_balance,rating,reject_count,status FROM drivers WHERE id=$1",[driver.id])).rows[0];
  res.json({range, ...r.rows[0], driver:d});
});

function requireAdmin(req,res,next){
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  if(String(actor.telegramId)!==String(process.env.ADMIN_TELEGRAM_ID||"")) return res.status(403).json({error:"not admin"});
  next();
}
app.get("/api/admin/overview", requireApiKey, requireAdmin, async (req,res)=>{
  const trips=(await query("SELECT COUNT(*)::int as total FROM trips",[])).rows[0].total;
  const active=(await query("SELECT COUNT(*)::int as active FROM trips WHERE status IN ('SEARCHING','ACCEPTED','ARRIVED','STARTED')",[])).rows[0].active;
  const online=(await query("SELECT COUNT(*)::int as online FROM drivers WHERE status='online'",[])).rows[0].online;
  res.json({trips, active, drivers_online:online});
});
app.get("/api/admin/drivers", requireApiKey, requireAdmin, async (req,res)=>{
  const r=await query("SELECT d.*, u.telegram_id, u.name, u.phone FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 200",[]);
  res.json({drivers:r.rows});
});
app.get("/api/admin/trips", requireApiKey, requireAdmin, async (req,res)=>{
  const r=await query(`
    SELECT t.*, up.telegram_id as passenger_tg, ud.telegram_id as driver_tg
    FROM trips t
    JOIN users up ON up.id=t.passenger_user_id
    LEFT JOIN drivers d ON d.id=t.driver_id
    LEFT JOIN users ud ON ud.id=d.user_id
    ORDER BY t.created_at DESC LIMIT 200
  `,[]);
  res.json({trips:r.rows});
});
app.get("/api/admin/settings", requireApiKey, requireAdmin, async (req,res)=>{
  const r=await query("SELECT key,value FROM settings ORDER BY key",[]);
  const out={}; r.rows.forEach(x=>out[x.key]=x.value);
  res.json({settings:out});
});
app.post("/api/admin/settings", requireApiKey, requireAdmin, async (req,res)=>{
  const upd=req.body||{};
  const allowed=["BASE_FARE","FREE_KM","PER_KM","COMMISSION_RATE","MIN_DRIVER_BALANCE"];
  for(const k of allowed){
    if(upd[k]==null) continue;
    await query(`
      INSERT INTO settings(key,value,updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `,[k,String(upd[k])]);
    process.env[k]=String(upd[k]);
  }
  res.json({ok:true});
});

app.post("/api/driver/topup/request", requireApiKey, async (req,res)=>{
  const actor=getActor(req);
  if(!actor) return res.status(400).json({error:"Missing x-telegram-id"});
  const user=await ensureUser(actor.telegramId,"driver");
  const driver=await ensureDriver(user.id);
  const { amount, method, proof_text }=req.body||{};
  const amt=Number(amount||0);
  if(amt<=0) return res.status(400).json({error:"amount must be > 0"});
  const id=uuidv4();
  await query("INSERT INTO topup_requests (id,driver_id,amount,method,proof_text,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'PENDING',NOW(),NOW())",
    [id, driver.id, amt, method?String(method):"CARD_TO_CARD", proof_text?String(proof_text):null]
  );
  res.json({ok:true, request_id:id, status:"PENDING"});
});
app.get("/api/admin/topups", requireApiKey, requireAdmin, async (req,res)=>{
  const r=await query(`
    SELECT tr.*, u.telegram_id, u.name
    FROM topup_requests tr
    JOIN drivers d ON d.id=tr.driver_id
    JOIN users u ON u.id=d.user_id
    ORDER BY tr.created_at DESC LIMIT 200
  `,[]);
  res.json({topups:r.rows});
});
app.post("/api/admin/topups/approve", requireApiKey, requireAdmin, async (req,res)=>{
  const { request_id }=req.body||{};
  if(!request_id) return res.status(400).json({error:"request_id required"});
  const tr=(await query("SELECT * FROM topup_requests WHERE id=$1",[request_id])).rows[0];
  if(!tr) return res.status(404).json({error:"not found"});
  if(tr.status!=="PENDING") return res.status(400).json({error:"not pending"});
  await query("UPDATE topup_requests SET status='APPROVED', updated_at=NOW() WHERE id=$1",[request_id]);
  await query("INSERT INTO wallet_transactions (driver_id,type,amount,ref,status,created_at) VALUES ($1,'TOPUP',$2,$3,'DONE',NOW())",
    [tr.driver_id, Number(tr.amount), request_id]
  );
  await query("UPDATE drivers SET wallet_balance=wallet_balance+$1 WHERE id=$2",[Number(tr.amount), tr.driver_id]);
  emitDriver(tr.driver_id,"wallet_update",{amount:Number(tr.amount), type:"TOPUP", status:"APPROVED"});
  res.json({ok:true});
});

// Socket.IO
io.on("connection",(socket)=>{
  socket.on("identify", async (data)=>{
    try{
      const { telegram_id, role }=data||{};
      if(!telegram_id) return;
      const user=await ensureUser(String(telegram_id), role==="driver"?"driver":"passenger");
      if(role==="driver"){
        const driver=await ensureDriver(user.id);
        socketsByDriverId.set(String(driver.id), socket.id);
        socket.data.driver_id=driver.id;
        socket.emit("identified",{user,driver});
      }else{
        socketsByPassengerUserId.set(String(user.id), socket.id);
        socket.data.passenger_user_id=user.id;
        socket.emit("identified",{user});
      }
    }catch(e){
      socket.emit("error_msg",{error:String(e.message||e)});
    }
  });

  socket.on("driver_location", async (data)=>{
    const driverId=socket.data.driver_id;
    if(!driverId) return;
    const { lat, lng, speed }=data||{};
    if(lat==null||lng==null) return;
    await query(`
      INSERT INTO driver_locations (driver_id,lat,lng,speed,updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (driver_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, speed=EXCLUDED.speed, updated_at=NOW()
    `,[driverId, Number(lat), Number(lng), Number(speed||0)]);
  });

  socket.on("disconnect", ()=>{
    if(socket.data.driver_id) socketsByDriverId.delete(String(socket.data.driver_id));
    if(socket.data.passenger_user_id) socketsByPassengerUserId.delete(String(socket.data.passenger_user_id));
  });
});

const PORT=process.env.PORT||8080;
server.listen(PORT, ()=>console.log("PayTaksi backend on", PORT));
