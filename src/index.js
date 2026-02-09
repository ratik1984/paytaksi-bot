import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import fetch from "node-fetch";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { fileURLToPath } from "url";
import { Store } from "./store.js";
import { parseAdminIds, validateInitData } from "./utils.js";

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);

const PORT=process.env.PORT?Number(process.env.PORT):3000;
const BOT_TOKEN=process.env.BOT_TOKEN||"";
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||`http://localhost:${PORT}`).replace(/\/$/,"");
const WEBHOOK_SECRET=process.env.WEBHOOK_SECRET||"paytaksi_bot";
const ADMIN_IDS=parseAdminIds(process.env.ADMIN_IDS||"");
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,"..","data");

const store=new Store(DATA_DIR);

const app=express();
app.use(helmet({contentSecurityPolicy:false}));
app.use(morgan("combined"));
app.use(express.json({limit:"1mb"}));
app.use("/static", express.static(path.join(__dirname,"..","public")));
app.get("/",(req,res)=>res.redirect("/webapp"));
app.get("/webapp",(req,res)=>res.sendFile(path.join(__dirname,"..","public","webapp.html")));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"..","public","admin.html")));

function devUser(req){
  if(req.query?.dev==="1" && req.query?.user_id){
    const id=Number(req.query.user_id);
    if(Number.isFinite(id)) return {id, first_name:"Dev", last_name:"User", username:"devuser"};
  }
  return null;
}
function auth(req,res,next){
  const dev=devUser(req);
  if(dev){req.tgUser=dev; store.touchUser(dev); return next();}
  const initData=String(req.headers["x-telegram-init-data"]||"");
  const v=validateInitData(initData,BOT_TOKEN);
  if(!v.ok) return res.status(401).json({ok:false,error:"unauthorized",reason:v.reason});
  req.tgUser=v.user; store.touchUser(v.user);
  const u=store.state.users[String(v.user.id)];
  if(u?.banned) return res.status(403).json({ok:false,error:"banned"});
  next();
}
function adminOnly(req,res,next){
  if(ADMIN_IDS.has(Number(req.tgUser?.id))) return next();
  return res.status(403).json({ok:false,error:"forbidden"});
}

app.get("/api/me", auth, (req,res)=>{
  const u=store.state.users[String(req.tgUser.id)];
  const d=store.state.drivers[String(req.tgUser.id)]||null;
  res.json({ok:true,user:u,driver:d,isAdmin:ADMIN_IDS.has(Number(req.tgUser.id))});
});

app.get("/api/geocode", auth, async (req,res)=>{
  const q=String(req.query.q||"").trim();
  if(!q) return res.json({ok:true,items:[]});
  const url=`https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=1&q=${encodeURIComponent(q)}`;
  try{
    const r=await fetch(url,{headers:{"User-Agent":"PayTaksiBot/1.0"}});
    const data=await r.json();
    const items=(Array.isArray(data)?data:[]).map(x=>({display_name:x.display_name,lat:Number(x.lat),lon:Number(x.lon)}))
      .filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon));
    res.json({ok:true,items});
  }catch{res.json({ok:false,error:"geocode_failed"});}
});

// passenger
app.post("/api/passenger/set_role", auth, (req,res)=>{
  const role=String(req.body.role||"passenger");
  if(!["passenger","driver"].includes(role)) return res.status(400).json({ok:false});
  const u=store.setRole(req.tgUser.id,role);
  res.json({ok:true,user:u});
});
app.post("/api/passenger/create_order", auth, (req,res)=>{
  const {pickup,dropoff,payMethod}=req.body||{};
  if(!pickup||!dropoff) return res.status(400).json({ok:false,error:"missing_pickup_dropoff"});
  const p={lat:Number(pickup.lat),lon:Number(pickup.lon),addr:String(pickup.addr||"")};
  const d={lat:Number(dropoff.lat),lon:Number(dropoff.lon),addr:String(dropoff.addr||"")};
  if(![p.lat,p.lon,d.lat,d.lon].every(Number.isFinite)) return res.status(400).json({ok:false,error:"bad_coords"});
  const order=store.createOrder(req.tgUser.id,p,d,String(payMethod||"cash"));
  const drv=store.findAvailableDriverNear(p);
  if(drv) store.assignDriver(order.id, drv.id);
  res.json({ok:true,order:store.getOrder(order.id)});
});
app.get("/api/passenger/history", auth, (req,res)=>res.json({ok:true,orders:store.listPassengerOrders(req.tgUser.id)}));
app.post("/api/passenger/rate", auth, (req,res)=>{
  const {orderId,rating}=req.body||{};
  const r=Number(rating);
  if(!orderId||!(r>=1&&r<=5)) return res.status(400).json({ok:false});
  const o=store.setRating(orderId, req.tgUser.id, r);
  if(!o) return res.status(404).json({ok:false});
  res.json({ok:true,order:o});
});

// driver
app.post("/api/driver/set_status", auth, (req,res)=>{
  const online=!!(req.body||{}).online;
  store.setRole(req.tgUser.id,"driver");
  const d=store.setDriverOnline(req.tgUser.id, online);
  res.json({ok:true,driver:d});
});
app.post("/api/driver/update_location", auth, (req,res)=>{
  const {lat,lon}=req.body||{};
  const d=store.updateDriverLocation(req.tgUser.id, Number(lat), Number(lon));
  res.json({ok:true,driver:d});
});
app.get("/api/driver/pending", auth, (req,res)=>{
  const did=String(req.tgUser.id);
  const orders=Object.values(store.state.orders).filter(o=>o.driverId===did && ["assigned","accepted","arrived","in_trip"].includes(o.status))
    .sort((a,b)=>b.createdAt-a.createdAt);
  res.json({ok:true,orders});
});
app.post("/api/driver/accept", auth, (req,res)=>{
  const {orderId}=req.body||{};
  const o=store.driverAccept(orderId, req.tgUser.id);
  if(!o) return res.status(404).json({ok:false});
  res.json({ok:true,order:o});
});
app.post("/api/driver/status", auth, (req,res)=>{
  const {orderId,status}=req.body||{};
  const allowed=new Set(["arrived","in_trip","completed","cancelled"]);
  if(!orderId||!allowed.has(status)) return res.status(400).json({ok:false});
  const o=store.getOrder(orderId);
  if(!o||String(o.driverId)!==String(req.tgUser.id)) return res.status(404).json({ok:false});
  res.json({ok:true,order:store.updateOrderStatus(orderId,status)});
});

app.get("/api/order/:id/track", auth, (req,res)=>{
  const t=store.getOrderTrack(req.params.id);
  if(!t) return res.status(404).json({ok:false});
  const uid=String(req.tgUser.id);
  const isAdmin=ADMIN_IDS.has(Number(uid));
  if(!isAdmin && t.order.passengerId!==uid && String(t.order.driverId||"")!==uid) return res.status(403).json({ok:false,error:"forbidden"});
  res.json({ok:true,...t});
});

// admin
app.get("/api/admin/overview", auth, adminOnly, (req,res)=>{
  const users=store.listUsers(), drivers=store.listDrivers(), orders=store.listOrders();
  res.json({ok:true,counts:{
    users:users.length,drivers:drivers.length,onlineDrivers:drivers.filter(d=>d.online).length,
    orders:orders.length,activeOrders:orders.filter(o=>["searching","assigned","accepted","arrived","in_trip"].includes(o.status)).length
  },users,drivers,orders});
});
app.post("/api/admin/ban", auth, adminOnly, (req,res)=>{
  const {userId,banned}=req.body||{};
  if(!userId) return res.status(400).json({ok:false});
  const u=store.banUser(userId, !!banned); if(!u) return res.status(404).json({ok:false});
  res.json({ok:true,user:u});
});

// bot
const bot=new Telegraf(BOT_TOKEN);
bot.start(async (ctx)=>{
  store.touchUser(ctx.from);
  const isAdmin=ADMIN_IDS.has(Number(ctx.from.id));
  const kb=Markup.inlineKeyboard([
    [Markup.button.webApp("🚕 PayTaksi (Mini App)", `${PUBLIC_BASE_URL}/webapp`)],
    [Markup.button.callback("👤 Sərnişin","role_passenger"), Markup.button.callback("🚗 Sürücü","role_driver")],
    ...(isAdmin?[[Markup.button.webApp("🛠 Admin Panel", `${PUBLIC_BASE_URL}/admin`)]]:[])
  ]);
  await ctx.reply("PayTaksi hazırdır. Mini App düyməsini bas.", kb);
});
bot.action("role_passenger", async (ctx)=>{store.setRole(ctx.from.id,"passenger"); await ctx.answerCbQuery("Sərnişin ✅");});
bot.action("role_driver", async (ctx)=>{store.setRole(ctx.from.id,"driver"); await ctx.answerCbQuery("Sürücü ✅");});
bot.command("admin", async (ctx)=>{
  if(!ADMIN_IDS.has(Number(ctx.from.id))) return ctx.reply("Yalnız admin.");
  return ctx.reply("Admin panel:", Markup.inlineKeyboard([[Markup.button.webApp("🛠 Admin Panel", `${PUBLIC_BASE_URL}/admin`)]]));
});
app.post(`/${WEBHOOK_SECRET}/telegram`, (req,res)=>bot.handleUpdate(req.body,res));
app.get("/healthz",(req,res)=>res.json({ok:true}));

app.listen(PORT, async ()=>{
  console.log(`Server: http://localhost:${PORT}`);
  if(BOT_TOKEN && process.env.NODE_ENV==="production"){
    const webhookUrl=`${PUBLIC_BASE_URL}/${WEBHOOK_SECRET}/telegram`;
    try{await bot.telegram.setWebhook(webhookUrl); console.log("Webhook set:", webhookUrl);}catch(e){console.error("Webhook set failed:", e?.message||e);}
  }else{
    try{await bot.launch(); console.log("Bot long polling started.");}catch(e){console.error("Bot launch failed:", e?.message||e);}
  }
});
