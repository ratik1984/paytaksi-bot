import { Telegraf, Markup } from "telegraf";
import { prisma } from "../lib/prisma.js";
import { getOrCreatePassenger } from "../lib/users.js";
import { searchPlaces, routeDistanceKm } from "../lib/geo.js";
import { calcFare } from "../lib/pricing.js";
import { audit } from "../lib/audit.js";
import { mainMenuPassenger } from "./common.js";

const token=process.env.BOT_PASSENGER_TOKEN;
const state=new Map();

export function startPassengerBot(){
  if(!token) throw new Error("BOT_PASSENGER_TOKEN is missing");
  const bot=new Telegraf(token);

  bot.start(async (ctx)=>{ await getOrCreatePassenger(ctx.from.id); state.delete(ctx.from.id); await ctx.reply("Salam! PayTaksi sərnişin botu.", mainMenuPassenger()); });

  bot.hears("❓ Kömək",(ctx)=>ctx.reply("Sifariş: 'Sifariş yarat' → pickup location → ünvan yaz → alternativ seç."));
  bot.hears("📜 Sifarişlərim", async (ctx)=>{
    const u=await getOrCreatePassenger(ctx.from.id);
    const orders=await prisma.order.findMany({where:{passengerId:u.passenger.id},orderBy:{id:"desc"},take:10});
    if(!orders.length) return ctx.reply("Sifariş yoxdur.");
    return ctx.reply(orders.map(o=>`#${o.id} ${o.status} — ${o.fare.toFixed(2)} AZN — ${o.distanceKm.toFixed(2)} km`).join("\n"));
  });

  bot.hears("🚕 Sifariş yarat", async (ctx)=>{
    await getOrCreatePassenger(ctx.from.id);
    state.set(ctx.from.id,{step:"pickup"});
    await ctx.reply("📍 Götürüləcəyiniz yeri göndərin (Location).", Markup.keyboard([[Markup.button.locationRequest("📍 Yerimi göndər")],["⬅️ Geri"]]).resize());
  });

  bot.hears("⬅️ Geri", async (ctx)=>{ state.delete(ctx.from.id); await ctx.reply("Əsas menyu", mainMenuPassenger()); });

  bot.on("location", async (ctx)=>{
    const st=state.get(ctx.from.id);
    if(!st || st.step!=="pickup") return;
    st.pickup={lat:ctx.message.location.latitude, lon:ctx.message.location.longitude};
    st.step="drop_text";
    state.set(ctx.from.id,st);
    await ctx.reply("✅ Pickup alındı. İndi gedəcəyiniz ünvanı yazın.", Markup.removeKeyboard());
  });

  bot.on("text", async (ctx)=>{
    const st=state.get(ctx.from.id);
    if(!st || st.step!=="drop_text") return;
    const q=(ctx.message.text||"").trim();
    const places=await searchPlaces(q, st.pickup.lat, st.pickup.lon);
    if(!places.length) return ctx.reply("Heç nə tapılmadı. Başqa ünvan yazın.");
    st.suggestions=places; st.step="drop_pick"; state.set(ctx.from.id,st);
    const buttons=places.map((p,i)=>[Markup.button.callback(`${i+1}) ${p.display.slice(0,45)}…`,`drop_${i}`)]);
    await ctx.reply("Alternativlərdən birini seçin:", Markup.inlineKeyboard(buttons));
  });

  bot.action(/drop_(\d+)/, async (ctx)=>{
    const idx=Number(ctx.match[1]);
    const st=state.get(ctx.from.id);
    if(!st || st.step!=="drop_pick") return ctx.answerCbQuery("Vaxt bitdi.");
    const place=st.suggestions?.[idx];
    if(!place) return ctx.answerCbQuery("Yanlış seçim");
    await ctx.answerCbQuery("Hesablanır...");
    const pu=await getOrCreatePassenger(ctx.from.id);
    const distKm=await routeDistanceKm(st.pickup.lat, st.pickup.lon, place.lat, place.lon);
    const {fare,commission}=await calcFare(distKm);
    const order=await prisma.order.create({data:{
      passengerId:pu.passenger.id,
      pickupLat:st.pickup.lat, pickupLon:st.pickup.lon,
      dropLat:place.lat, dropLon:place.lon, dropAddress:place.display,
      distanceKm:distKm, fare, commission
    }});
    state.delete(ctx.from.id);
    await ctx.reply(`✅ Sifariş yaradıldı (#${order.id}).\n📏 ${distKm.toFixed(2)} km\n💵 ${fare.toFixed(2)} AZN\nSürücü axtarılır...`, Markup.keyboard([["❌ Ləğv et"]]).resize());
    await audit("order_created",{orderId:order.id},ctx.from.id);
  });

  bot.hears("❌ Ləğv et", async (ctx)=>{
    const u=await getOrCreatePassenger(ctx.from.id);
    const order=await prisma.order.findFirst({where:{passengerId:u.passenger.id,status:{in:["SEARCHING","ACCEPTED"]}},orderBy:{id:"desc"},include:{driver:{include:{user:true}}}});
    if(!order) return ctx.reply("Ləğv ediləcək aktiv sifariş yoxdur.", mainMenuPassenger());
    await prisma.order.update({where:{id:order.id},data:{status:"CANCELED"}});
    if(order.driver?.user?.tgId){ try{ await bot.telegram.sendMessage(Number(order.driver.user.tgId),`❌ Sifariş ləğv edildi (#${order.id}).`);}catch{} }
    await audit("order_canceled",{orderId:order.id},ctx.from.id);
    return ctx.reply(`❌ Sifariş ləğv edildi (#${order.id}).`, mainMenuPassenger());
  });

  bot.launch();
  console.log("Passenger bot started");
}
