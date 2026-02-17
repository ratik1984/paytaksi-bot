const express = require("express");
const bcrypt = require("bcryptjs");
const { prisma } = require("../db");
const { requireLogin } = require("./adminAuth");

const router = express.Router();

router.get("/login", (req,res)=> res.render("login", { error:null }));
router.post("/login", async (req,res)=>{
  const { email, password } = req.body;
  const admin = await prisma.adminProfile.findUnique({ where:{ email }});
  if (!admin) return res.render("login", { error:"Login yanlışdır" });
  const ok = await bcrypt.compare(password||"", admin.passwordHash);
  if (!ok) return res.render("login", { error:"Login yanlışdır" });
  res.cookie("admin","1", { httpOnly:true, sameSite:"lax" });
  res.redirect("/admin");
});

router.get("/logout", (req,res)=>{ res.clearCookie("admin"); res.redirect("/admin/login"); });

router.get("/", requireLogin, async (req,res)=>{
  const counts = {
    driversPending: await prisma.driverProfile.count({ where:{ status:"PENDING" }}),
    topupsPending: await prisma.topUpRequest.count({ where:{ status:"PENDING" }}),
    ridesActive: await prisma.ride.count({ where:{ status:{ in:["REQUESTED","ACCEPTED","STARTED"] }}})
  };
  res.render("dashboard", { counts });
});

router.get("/drivers", requireLogin, async (req,res)=>{
  const drivers = await prisma.driverProfile.findMany({ include:{ user:true }, orderBy:{ status:"asc" }, take: 200 });
  res.render("drivers", { drivers });
});

router.post("/drivers/:id/approve", requireLogin, async (req,res)=>{
  await prisma.driverProfile.update({ where:{ id:req.params.id }, data:{ status:"APPROVED" }});
  res.redirect("/admin/drivers");
});

router.post("/drivers/:id/reject", requireLogin, async (req,res)=>{
  await prisma.driverProfile.update({ where:{ id:req.params.id }, data:{ status:"REJECTED" }});
  res.redirect("/admin/drivers");
});

router.get("/topups", requireLogin, async (req,res)=>{
  const topups = await prisma.topUpRequest.findMany({ include:{ user:true }, orderBy:{ createdAt:"desc" }, take: 200 });
  res.render("topups", { topups });
});

router.post("/topups/:id/approve", requireLogin, async (req,res)=>{
  const t = await prisma.topUpRequest.findUnique({ where:{ id:req.params.id }});
  if (t && t.status === "PENDING"){
    await prisma.topUpRequest.update({ where:{ id:t.id }, data:{ status:"APPROVED", decidedAt:new Date() }});
    await prisma.balanceLedger.create({ data:{ userId:t.userId, amountAzN:t.amountAzN, reason:`TopUp approved (${t.id})` }});
  }
  res.redirect("/admin/topups");
});

router.post("/topups/:id/reject", requireLogin, async (req,res)=>{
  await prisma.topUpRequest.update({ where:{ id:req.params.id }, data:{ status:"REJECTED", decidedAt:new Date() }});
  res.redirect("/admin/topups");
});

router.get("/rides", requireLogin, async (req,res)=>{
  const rides = await prisma.ride.findMany({
    include:{ passenger:true, driver:true },
    orderBy:{ createdAt:"desc" }, take: 200
  });
  res.render("rides", { rides });
});

router.get("/map", requireLogin, async (req,res)=>{ res.render("map"); });
router.get("/api/map", requireLogin, async (req,res)=>{
  const drivers = await prisma.driverProfile.findMany({ where:{ status:"APPROVED" }, include:{ user:true }});
  const rides = await prisma.ride.findMany({ where:{ status:{ in:["REQUESTED","ACCEPTED","STARTED"] }}, include:{ passenger:true, driver:true }});
  res.json({ drivers, rides });
});

module.exports = { adminRouter: router };
