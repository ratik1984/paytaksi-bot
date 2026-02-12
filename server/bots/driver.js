import { Telegraf, Markup } from "telegraf";
import { prisma } from "../lib/prisma.js";
import { getOrCreateDriver } from "../lib/users.js";
import { audit } from "../lib/audit.js";
import { mainMenuDriver, colors } from "./common.js";

const token=process.env.BOT_DRIVER_TOKEN;
const regState=new Map();

async function blockBalance(){
  const v=await prisma.setting.findUnique({where:{key:"driver_block_balance"}});
  return Number(v?.value ?? -10);
}

export function startDriverBot(){
  if(!token) throw new Error("BOT_DRIVER_TOKEN is missing");
  const bot=new Telegraf(token);

  bot.start(async (ctx)=>{ await getOrCreateDriver(ctx.from.id); regState.delete(ctx.from.id); await ctx.reply("Salam! PayTaksi sürücü botu.", mainMenuDriver()); });

  bot.hears("🧾 Qeydiyyat / Profil", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    await ctx.reply(`Status: ${d.status}\nAvto il: ${d.carYear ?? "-"}\nRəng: ${d.carColor ?? "-"}\nBalans: ${d.balance.toFixed(2)} AZN`, Markup.keyboard([["📝 Qeydiyyata başla"],["⬅️ Geri"]]).resize());
  });

  bot.hears("📝 Qeydiyyata başla", async (ctx)=>{
    await getOrCreateDriver(ctx.from.id);
    regState.set(ctx.from.id,{step:"carYear",data:{}});
    await ctx.reply("Avtomobil buraxılış ilini yazın (minimum 2010):", Markup.removeKeyboard());
  });

  bot.hears("⬅️ Geri", async (ctx)=>{ regState.delete(ctx.from.id); await ctx.reply("Əsas menyu", mainMenuDriver()); });

  bot.on("text", async (ctx)=>{
    const st=regState.get(ctx.from.id);
    if(!st) return;

    if(st.step==="carYear"){
      const y=Number((ctx.message.text||"").trim());
      const maxY=new Date().getFullYear()+1;
      if(!Number.isInteger(y) || y<2010 || y>maxY) return ctx.reply("❌ Minimum 2010 yazın.");
      st.data.carYear=y; st.step="carColor"; regState.set(ctx.from.id,st);
      return ctx.reply("Rəngi seçin:", Markup.inlineKeyboard(colors.map(c=>[Markup.button.callback(c,`color_${c}`)])));
    }

    if(st.step==="topup_amount"){
      const amount=Number((ctx.message.text||"").replace(",","."));
      if(!Number.isFinite(amount) || amount<=0) return ctx.reply("Düzgün məbləğ yazın.");
      st.data.amount=Math.round(amount*100)/100; st.step="topup_method"; regState.set(ctx.from.id,st);
      return ctx.reply("Metodu seçin:", Markup.inlineKeyboard([[Markup.button.callback("💳 Kart-to-kart","topm_card")],[Markup.button.callback("📲 M10","topm_m10")]]));
    }
  });

  bot.action(/color_(.+)/, async (ctx)=>{
    const st=regState.get(ctx.from.id);
    if(!st || st.step!=="carColor") return ctx.answerCbQuery("Vaxt bitdi.");
    const color=ctx.match[1];
    if(!colors.includes(color)) return ctx.answerCbQuery("Yanlış rəng");
    st.data.carColor=color; st.step="idFront"; regState.set(ctx.from.id,st);
    await ctx.answerCbQuery();
    await ctx.reply("Şəxsiyyət vəsiqəsi — ÖN üz (photo) yükləyin.");
  });

  bot.on("photo", async (ctx)=>{
    const st=regState.get(ctx.from.id);
    if(!st) return;
    const fileId=ctx.message.photo[ctx.message.photo.length-1].file_id;

    if(st.step==="idFront"){ st.data.idFrontFileId=fileId; st.step="idBack"; regState.set(ctx.from.id,st); return ctx.reply("ŞV — ARXA üz yükləyin."); }
    if(st.step==="idBack"){ st.data.idBackFileId=fileId; st.step="dlFront"; regState.set(ctx.from.id,st); return ctx.reply("Sürücülük vəsiqəsi — ÖN üz yükləyin."); }
    if(st.step==="dlFront"){ st.data.dlFrontFileId=fileId; st.step="dlBack"; regState.set(ctx.from.id,st); return ctx.reply("Sürücülük vəsiqəsi — ARXA üz yükləyin."); }
    if(st.step==="dlBack"){ st.data.dlBackFileId=fileId; st.step="techFront"; regState.set(ctx.from.id,st); return ctx.reply("Texniki pasport — ÖN üz yükləyin."); }
    if(st.step==="techFront"){ st.data.techFrontFileId=fileId; st.step="techBack"; regState.set(ctx.from.id,st); return ctx.reply("Texniki pasport — ARXA üz yükləyin."); }
    if(st.step==="techBack"){
      st.data.techBackFileId=fileId;
      const u=await getOrCreateDriver(ctx.from.id);
      await prisma.driver.update({where:{userId:u.id},data:{
        status:"PENDING", carYear:st.data.carYear, carColor:st.data.carColor,
        idFrontFileId:st.data.idFrontFileId, idBackFileId:st.data.idBackFileId,
        dlFrontFileId:st.data.dlFrontFileId, dlBackFileId:st.data.dlBackFileId,
        techFrontFileId:st.data.techFrontFileId, techBackFileId:st.data.techBackFileId
      }});
      await audit("driver_submitted",{carYear:st.data.carYear,carColor:st.data.carColor},ctx.from.id);
      regState.delete(ctx.from.id);
      return ctx.reply("✅ Göndərildi. Admin təsdiqindən sonra sifariş ala biləcəksiniz.", mainMenuDriver());
    }

    if(st.step==="topup_proof"){
      const u=await getOrCreateDriver(ctx.from.id);
      const d=await prisma.driver.findUnique({where:{userId:u.id}});
      const req=await prisma.topupRequest.create({data:{driverId:d.id,amount:st.data.amount,method:st.data.method,proofFileId:fileId,status:"PENDING"}});
      await audit("topup_created",{topupId:req.id,amount:req.amount,method:req.method},ctx.from.id);
      regState.delete(ctx.from.id);
      return ctx.reply(`✅ Top-up sorğusu yaradıldı (#${req.id}).`, mainMenuDriver());
    }
  });

  bot.hears("🟢 Onlayn ol", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    if(d.status!=="APPROVED") return ctx.reply("⛔ Hələ təsdiqlənməyibsiniz.");
    const bb=await blockBalance();
    if(d.balance<=bb) return ctx.reply(`⛔ Balans limiti: ${bb} AZN. Sizin balans: ${d.balance.toFixed(2)} AZN.`);
    await prisma.driver.update({where:{id:d.id},data:{isOnline:true}});
    await ctx.reply("🟢 Onlayn oldunuz. Lokasiya göndərin.", Markup.keyboard([[Markup.button.locationRequest("📍 Lokasiyanı paylaş")],["⬅️ Geri"]]).resize());
  });

  bot.hears("🔴 Oflayn ol", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    await prisma.driver.update({where:{userId:u.id},data:{isOnline:false}});
    await ctx.reply("🔴 Oflayn oldunuz.", mainMenuDriver());
  });

  bot.on("location", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    if(!d.isOnline) return;
    await prisma.driver.update({where:{id:d.id},data:{lastLat:ctx.message.location.latitude,lastLon:ctx.message.location.longitude,lastLocAt:new Date()}});
    await ctx.reply("✅ Lokasiya yeniləndi.");
  });

  bot.hears("💰 Balans", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    const bb=await blockBalance();
    await ctx.reply(`Balans: ${d.balance.toFixed(2)} AZN\nLimit: ${bb} AZN (və aşağı) → sifariş qəbul edilmir.`);
  });

  bot.hears("➕ Balans artır", async (ctx)=>{ regState.set(ctx.from.id,{step:"topup_amount",data:{}}); await ctx.reply("Məbləği yazın (AZN):"); });

  bot.action(/topm_(card|m10)/, async (ctx)=>{
    const st=regState.get(ctx.from.id);
    if(!st || st.step!=="topup_method") return ctx.answerCbQuery("Vaxt bitdi.");
    st.data.method=ctx.match[1]; st.step="topup_proof"; regState.set(ctx.from.id,st);
    await ctx.answerCbQuery();
    await ctx.reply("Çek / sübut şəklini yükləyin (photo).");
  });

  bot.action(/accept_(\d+)/, async (ctx)=>{
    const orderId=Number(ctx.match[1]);
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    const bb=await blockBalance();
    if(d.balance<=bb) return ctx.answerCbQuery("Balans limitinə görə olmaz.");
    if(d.status!=="APPROVED") return ctx.answerCbQuery("Təsdiqlənməyibsiniz.");
    const order=await prisma.order.findUnique({where:{id:orderId}});
    if(!order || order.status!=="SEARCHING") return ctx.answerCbQuery("Sifariş aktiv deyil.");
    await prisma.order.update({where:{id:orderId},data:{status:"ACCEPTED",driverId:d.id}});
    await ctx.answerCbQuery("Qəbul edildi");
    try{ await ctx.editMessageReplyMarkup(); }catch{}
    const passenger=await prisma.passenger.findUnique({where:{id:order.passengerId},include:{user:true}});
    try{ await bot.telegram.sendMessage(Number(passenger.user.tgId),`✅ Sifariş qəbul edildi (#${order.id}).`);}catch{}
    await ctx.reply(`Sifariş #${order.id} qəbul edildi.`, Markup.keyboard([["🚗 Start ride","🏁 Finish ride"],["🔴 Oflayn ol"]]).resize());
    await audit("order_accepted",{orderId,driverId:d.id},ctx.from.id);
  });

  bot.hears("🚗 Start ride", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    const order=await prisma.order.findFirst({where:{driverId:d.id,status:"ACCEPTED"},orderBy:{id:"desc"},include:{passenger:{include:{user:true}}}});
    if(!order) return ctx.reply("Aktiv sifariş yoxdur.");
    await prisma.order.update({where:{id:order.id},data:{status:"STARTED"}});
    try{ await bot.telegram.sendMessage(Number(order.passenger.user.tgId),`🚗 Səfər başladı (#${order.id}).`);}catch{}
    await audit("order_started",{orderId:order.id},ctx.from.id);
    await ctx.reply(`🚗 Ride başladı (#${order.id}).`);
  });

  bot.hears("🏁 Finish ride", async (ctx)=>{
    const u=await getOrCreateDriver(ctx.from.id);
    const d=await prisma.driver.findUnique({where:{userId:u.id}});
    const order=await prisma.order.findFirst({where:{driverId:d.id,status:{in:["ACCEPTED","STARTED"]}},orderBy:{id:"desc"},include:{passenger:{include:{user:true}}}});
    if(!order) return ctx.reply("Aktiv sifariş yoxdur.");
    await prisma.$transaction(async (tx)=>{
      await tx.order.update({where:{id:order.id},data:{status:"FINISHED"}});
      await tx.driver.update({where:{id:d.id},data:{balance:{decrement:order.commission}}});
    });
    try{ await bot.telegram.sendMessage(Number(order.passenger.user.tgId),`🏁 Səfər bitdi (#${order.id}). Ödəniş: ${order.fare.toFixed(2)} AZN.`);}catch{}
    await audit("order_finished",{orderId:order.id,commission:order.commission},ctx.from.id);
    await ctx.reply(`🏁 Ride bitdi (#${order.id}). Komissiya tutuldu: ${order.commission.toFixed(2)} AZN`, mainMenuDriver());
  });

  // broadcast loop (once per order per driver)
  setInterval(async ()=>{
    try{
      const orders=await prisma.order.findMany({where:{status:"SEARCHING"},orderBy:{id:"desc"},take:10});
      if(!orders.length) return;
      const drivers=await prisma.driver.findMany({where:{status:"APPROVED",isOnline:true},include:{user:true}});
      if(!drivers.length) return;
      const bb=await blockBalance();
      for(const o of orders){
        if(Date.now()-new Date(o.createdAt).getTime()>5*60*1000) continue;
        for(const d of drivers){
          if(d.balance<=bb) continue;
          const exists=await prisma.orderBroadcast.findUnique({where:{orderId_driverId:{orderId:o.id,driverId:d.id}}});
          if(exists) continue;
          const m=await bot.telegram.sendMessage(Number(d.user.tgId),
            `🚕 Yeni sifariş (#${o.id})\n🏁 ${o.dropAddress?.slice(0,120) || ""}\n📏 ${o.distanceKm.toFixed(2)} km\n💵 ${o.fare.toFixed(2)} AZN\nKomissiya: ${o.commission.toFixed(2)} AZN`,
            Markup.inlineKeyboard([[Markup.button.callback("✅ Qəbul et",`accept_${o.id}`)]])
          );
          await prisma.orderBroadcast.create({data:{orderId:o.id,driverId:d.id,messageId:m.message_id}});
        }
      }
    }catch{}
  },15000);

  bot.launch();
  console.log("Driver bot started");
}
