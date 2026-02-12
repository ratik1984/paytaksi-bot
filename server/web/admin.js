import express from "express";
import { prisma } from "../lib/prisma.js";
import { setSetting } from "../lib/settings.js";
export const adminRouter=express.Router();

function requireLogin(req,res,next){ if(req.session?.admin) return next(); return res.redirect("/admin/login"); }

adminRouter.get("/login",(req,res)=>res.render("login",{error:null}));
adminRouter.post("/login",(req,res)=>{
  const u=req.body.username||""; const p=req.body.password||"";
  if(u===(process.env.ADMIN_PANEL_USER||"Ratik") && p===(process.env.ADMIN_PANEL_PASS||"0123456789")){ req.session.admin={username:u}; return res.redirect("/admin"); }
  return res.render("login",{error:"Yanlış login və ya şifrə"});
});
adminRouter.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/admin/login")));

adminRouter.get("/", requireLogin, async (req,res)=>{
  const counts={
    driversPending: await prisma.driver.count({where:{status:"PENDING"}}),
    driversApproved: await prisma.driver.count({where:{status:"APPROVED"}}),
    ordersSearching: await prisma.order.count({where:{status:"SEARCHING"}}),
    ordersActive: await prisma.order.count({where:{status:{in:["ACCEPTED","STARTED"]}}}),
    topupsPending: await prisma.topupRequest.count({where:{status:"PENDING"}}),
  };
  const recentOrders=await prisma.order.findMany({orderBy:{id:"desc"},take:10});
  res.render("dashboard",{admin:req.session.admin,counts,recentOrders});
});

adminRouter.get("/drivers", requireLogin, async (req,res)=>{
  const status=req.query.status||"PENDING";
  const drivers=await prisma.driver.findMany({where:{status},include:{user:true},orderBy:{id:"desc"},take:500});
  res.render("drivers",{admin:req.session.admin,drivers,status});
});
adminRouter.post("/drivers/:id/approve", requireLogin, async (req,res)=>{ await prisma.driver.update({where:{id:Number(req.params.id)},data:{status:"APPROVED"}}); res.redirect("/admin/drivers?status=PENDING"); });
adminRouter.post("/drivers/:id/reject", requireLogin, async (req,res)=>{ await prisma.driver.update({where:{id:Number(req.params.id)},data:{status:"REJECTED"}}); res.redirect("/admin/drivers?status=PENDING"); });

adminRouter.get("/topups", requireLogin, async (req,res)=>{
  const status=req.query.status||"PENDING";
  const topups=await prisma.topupRequest.findMany({where:{status},include:{driver:{include:{user:true}}},orderBy:{id:"desc"},take:500});
  res.render("topups",{admin:req.session.admin,topups,status});
});
adminRouter.post("/topups/:id/approve", requireLogin, async (req,res)=>{
  const id=Number(req.params.id);
  const r=await prisma.topupRequest.findUnique({where:{id}});
  if(r && r.status==="PENDING"){
    await prisma.$transaction(async (tx)=>{
      await tx.topupRequest.update({where:{id},data:{status:"APPROVED",decidedAt:new Date()}});
      await tx.driver.update({where:{id:r.driverId},data:{balance:{increment:r.amount}}});
    });
  }
  res.redirect("/admin/topups?status=PENDING");
});
adminRouter.post("/topups/:id/reject", requireLogin, async (req,res)=>{
  const id=Number(req.params.id);
  const r=await prisma.topupRequest.findUnique({where:{id}});
  if(r && r.status==="PENDING") await prisma.topupRequest.update({where:{id},data:{status:"REJECTED",decidedAt:new Date()}});
  res.redirect("/admin/topups?status=PENDING");
});

adminRouter.get("/orders", requireLogin, async (req,res)=>{
  const status=req.query.status||"SEARCHING";
  const orders=await prisma.order.findMany({where:{status},orderBy:{id:"desc"},take:500});
  res.render("orders",{admin:req.session.admin,orders,status});
});

adminRouter.get("/settings", requireLogin, async (req,res)=>{
  const settings=await prisma.setting.findMany({orderBy:{key:"asc"}});
  res.render("settings",{admin:req.session.admin,settings,saved:req.query.saved||null});
});
adminRouter.post("/settings", requireLogin, async (req,res)=>{
  const keys=["commission_percent","base_fare","included_km","per_km_after","driver_block_balance"];
  for(const k of keys) if(req.body[k]!=null) await setSetting(k, req.body[k]);
  res.redirect("/admin/settings?saved=1");
});
