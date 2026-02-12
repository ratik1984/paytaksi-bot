import { Telegraf, Markup } from "telegraf";
import { prisma } from "../lib/prisma.js";
import { ensureAdmin } from "../lib/users.js";
import { audit } from "../lib/audit.js";
import { mainMenuAdmin } from "./common.js";
import { setSetting } from "../lib/settings.js";

const token=process.env.BOT_ADMIN_TOKEN;

export function startAdminBot(){
  if(!token) throw new Error("BOT_ADMIN_TOKEN is missing");
  const bot=new Telegraf(token);

  bot.start(async (ctx)=>{ await ensureAdmin(ctx.from.id); await ctx.reply("Salam! PayTaksi admin botu.", mainMenuAdmin()); });

  bot.hears("👥 Sürücülər", async (ctx)=>{
    await ensureAdmin(ctx.from.id);
    const pending=await prisma.driver.findMany({where:{status:"PENDING"},include:{user:true},take:20,orderBy:{id:"desc"}});
    if(!pending.length) return ctx.reply("Pending sürücü yoxdur.");
    for(const d of pending){
      await ctx.reply(`🧾 Pending Driver #${d.id}\nTG: ${d.user.tgId}\nİl: ${d.carYear}\nRəng: ${d.carColor}\nBalans: ${d.balance.toFixed(2)} AZN`,
        Markup.inlineKeyboard([[Markup.button.callback("✅ Approve",`drv_ok_${d.id}`)],[Markup.button.callback("❌ Reject",`drv_no_${d.id}`)],[Markup.button.callback("📎 Docs",`drv_docs_${d.id}`)]])
      );
    }
  });

  bot.action(/drv_docs_(\d+)/, async (ctx)=>{
    const id=Number(ctx.match[1]);
    const d=await prisma.driver.findUnique({where:{id},include:{user:true}});
    if(!d) return ctx.answerCbQuery("Tapılmadı");
    await ctx.answerCbQuery();
    const files=[["ID Front",d.idFrontFileId],["ID Back",d.idBackFileId],["DL Front",d.dlFrontFileId],["DL Back",d.dlBackFileId],["Tech Front",d.techFrontFileId],["Tech Back",d.techBackFileId]];
    for(const [label,fid] of files){ if(!fid) continue; try{ await ctx.replyWithPhoto(fid,{caption:`${label} (Driver #${d.id})`}); }catch{ await ctx.reply(`${label}: ${fid}`); } }
  });

  bot.action(/drv_ok_(\d+)/, async (ctx)=>{
    const id=Number(ctx.match[1]);
    const d=await prisma.driver.update({where:{id},data:{status:"APPROVED"},include:{user:true}});
    await ctx.answerCbQuery("Approved");
    try{ await bot.telegram.sendMessage(Number(d.user.tgId),"✅ Təsdiqləndiniz. İndi onlayn olub sifariş qəbul edə bilərsiniz."); }catch{}
    await audit("driver_approved",{driverId:id},ctx.from.id);
  });

  bot.action(/drv_no_(\d+)/, async (ctx)=>{
    const id=Number(ctx.match[1]);
    const d=await prisma.driver.update({where:{id},data:{status:"REJECTED"},include:{user:true}});
    await ctx.answerCbQuery("Rejected");
    try{ await bot.telegram.sendMessage(Number(d.user.tgId),"❌ Qeydiyyat rədd edildi. Yenidən göndərin."); }catch{}
    await audit("driver_rejected",{driverId:id},ctx.from.id);
  });

  bot.hears("🧾 Top-up sorğuları", async (ctx)=>{
    await ensureAdmin(ctx.from.id);
    const reqs=await prisma.topupRequest.findMany({where:{status:"PENDING"},include:{driver:{include:{user:true}}},take:20,orderBy:{id:"desc"}});
    if(!reqs.length) return ctx.reply("Pending top-up yoxdur.");
    for(const r of reqs){
      const caption=`💰 Top-up #${r.id}\nDriverTG: ${r.driver.user.tgId}\nAmount: ${r.amount.toFixed(2)} AZN\nMethod: ${r.method}`;
      const kb=Markup.inlineKeyboard([[Markup.button.callback("✅ Approve",`top_ok_${r.id}`)],[Markup.button.callback("❌ Reject",`top_no_${r.id}`)]]);
      if(r.proofFileId) await ctx.replyWithPhoto(r.proofFileId,{caption,reply_markup:kb.reply_markup});
      else await ctx.reply(caption,kb);
    }
  });

  bot.action(/top_ok_(\d+)/, async (ctx)=>{
    const id=Number(ctx.match[1]);
    await ensureAdmin(ctx.from.id);
    const r=await prisma.topupRequest.findUnique({where:{id},include:{driver:{include:{user:true}}}});
    if(!r || r.status!=="PENDING") return ctx.answerCbQuery("Aktiv deyil");
    await prisma.$transaction(async (tx)=>{
      await tx.topupRequest.update({where:{id},data:{status:"APPROVED",decidedAt:new Date()}});
      await tx.driver.update({where:{id:r.driverId},data:{balance:{increment:r.amount}}});
    });
    await ctx.answerCbQuery("Approved");
    try{ await bot.telegram.sendMessage(Number(r.driver.user.tgId),`✅ Top-up təsdiqləndi. Balans +${r.amount.toFixed(2)} AZN.`); }catch{}
    await audit("topup_approved",{topupId:id},ctx.from.id);
  });

  bot.action(/top_no_(\d+)/, async (ctx)=>{
    const id=Number(ctx.match[1]);
    await ensureAdmin(ctx.from.id);
    const r=await prisma.topupRequest.findUnique({where:{id},include:{driver:{include:{user:true}}}});
    if(!r || r.status!=="PENDING") return ctx.answerCbQuery("Aktiv deyil");
    await prisma.topupRequest.update({where:{id},data:{status:"REJECTED",decidedAt:new Date()}});
    await ctx.answerCbQuery("Rejected");
    try{ await bot.telegram.sendMessage(Number(r.driver.user.tgId),`❌ Top-up rədd edildi (#${id}).`); }catch{}
    await audit("topup_rejected",{topupId:id},ctx.from.id);
  });

  bot.hears("🚕 Sifarişlər", async (ctx)=>{
    await ensureAdmin(ctx.from.id);
    const orders=await prisma.order.findMany({orderBy:{id:"desc"},take:20});
    if(!orders.length) return ctx.reply("Sifariş yoxdur.");
    for(const o of orders) await ctx.reply(`#${o.id} ${o.status} — ${o.fare.toFixed(2)} AZN — ${o.distanceKm.toFixed(2)} km`);
  });

  bot.hears("⚙️ Parametrlər", async (ctx)=>{
    await ensureAdmin(ctx.from.id);
    const s=await prisma.setting.findMany();
    const map=Object.fromEntries(s.map(x=>[x.key,x.value]));
    await ctx.reply(`commission_percent: ${map.commission_percent}\nbase_fare: ${map.base_fare}\nincluded_km: ${map.included_km}\nper_km_after: ${map.per_km_after}\ndriver_block_balance: ${map.driver_block_balance}\n\nDəyişmək: /set key value`);
  });

  bot.command("set", async (ctx)=>{
    await ensureAdmin(ctx.from.id);
    const parts=(ctx.message.text||"").split(" ").filter(Boolean);
    if(parts.length<3) return ctx.reply("İstifadə: /set key value");
    const key=parts[1]; const value=parts.slice(2).join(" ");
    await setSetting(key,value);
    await ctx.reply(`✅ Set ${key} = ${value}`);
    await audit("setting_set",{key,value},ctx.from.id);
  });

  bot.hears("📣 Broadcast", async (ctx)=>{ await ensureAdmin(ctx.from.id); await ctx.reply("Mesaj: /bc sizin mesajınız"); });

  bot.command("bc", async (ctx)=>{
    await ensureAdmin(ctx.from.id);
    const text=(ctx.message.text||"").replace(/^\/bc\s*/i,"").trim();
    if(!text) return ctx.reply("İstifadə: /bc mesaj");
    const users=await prisma.user.findMany({select:{tgId:true}});
    let ok=0;
    for(const u of users){ try{ await bot.telegram.sendMessage(Number(u.tgId),`📣 ${text}`); ok++; }catch{} }
    await ctx.reply(`Göndərildi: ${ok}/${users.length}`);
    await audit("broadcast",{ok,total:users.length},ctx.from.id);
  });

  bot.launch();
  console.log("Admin bot started");
}
