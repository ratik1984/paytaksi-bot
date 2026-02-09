import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";

export class Store{
  constructor(dir="./data"){
    this.dir=dir; this.file=path.join(dir,"db.json");
    this.state={users:{},drivers:{},orders:{},orderEvents:{}};
    this._load();
  }
  _load(){try{fs.mkdirSync(this.dir,{recursive:true}); if(fs.existsSync(this.file)) this.state=JSON.parse(fs.readFileSync(this.file,"utf-8"));}catch{}}
  _save(){try{fs.mkdirSync(this.dir,{recursive:true}); fs.writeFileSync(this.file,JSON.stringify(this.state,null,2));}catch{}}
  touchUser(tg){ if(!tg?.id) return null; const id=String(tg.id);
    const name=[tg.first_name,tg.last_name].filter(Boolean).join(" ").trim()||tg.username||`user_${id}`;
    const u=this.state.users[id]||{id,name,username:tg.username||"",role:"passenger",ratingAvg:0,ratingCount:0,banned:false,createdAt:Date.now()};
    u.name=name; u.username=tg.username||u.username||""; this.state.users[id]=u;
    if(u.role==="driver"&&!this.state.drivers[id]) this.state.drivers[id]={id,online:false,lastLocation:null,activeOrderId:null};
    this._save(); return u;
  }
  setRole(uid,role){const id=String(uid); const u=this.state.users[id]; if(!u) return null; u.role=role;
    if(role==="driver"&&!this.state.drivers[id]) this.state.drivers[id]={id,online:false,lastLocation:null,activeOrderId:null};
    this._save(); return u;}
  banUser(uid,b=true){const id=String(uid); const u=this.state.users[id]; if(!u) return null; u.banned=!!b; this._save(); return u;}
  setDriverOnline(uid,on){const id=String(uid); if(!this.state.drivers[id]) this.state.drivers[id]={id,online:false,lastLocation:null,activeOrderId:null};
    this.state.drivers[id].online=!!on; this._save(); return this.state.drivers[id];}
  updateDriverLocation(uid,lat,lon){const id=String(uid); if(!this.state.drivers[id]) this.state.drivers[id]={id,online:false,lastLocation:null,activeOrderId:null};
    this.state.drivers[id].lastLocation={lat,lon,ts:Date.now()}; this._save(); return this.state.drivers[id];}
  createOrder(pid,pickup,dropoff,payMethod){const id=nanoid(10);
    const o={id,passengerId:String(pid),driverId:null,status:"searching",createdAt:Date.now(),pickup,dropoff,payMethod:payMethod||"cash",rating:null};
    this.state.orders[id]=o; this.state.orderEvents[id]=this.state.orderEvents[id]||[]; this.state.orderEvents[id].push({ts:Date.now(),type:"created",data:{}});
    this._save(); return o;}
  listPassengerOrders(pid){pid=String(pid); return Object.values(this.state.orders).filter(o=>o.passengerId===pid).sort((a,b)=>b.createdAt-a.createdAt);}
  listUsers(){return Object.values(this.state.users).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));}
  listDrivers(){return Object.values(this.state.drivers).map(d=>({...d,user:this.state.users[String(d.id)]||null}));}
  listOrders(){return Object.values(this.state.orders).sort((a,b)=>b.createdAt-a.createdAt);}
  _km(a,b){const R=6371,toRad=x=>x*Math.PI/180; const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
    const sa=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.sqrt(sa));}
  findAvailableDriverNear(pickup,maxKm=8){const now=Date.now();
    const c=Object.values(this.state.drivers).filter(d=>d.online&&!d.activeOrderId&&d.lastLocation&&(now-d.lastLocation.ts)<60000);
    if(!c.length) return null; let best=null, bestKm=1e9; for(const d of c){const km=this._km({lat:pickup.lat,lon:pickup.lon},{lat:d.lastLocation.lat,lon:d.lastLocation.lon});
      if(km<bestKm){bestKm=km; best=d;}} return best;}
  assignDriver(oid,did){oid=String(oid);did=String(did); const o=this.state.orders[oid]; if(!o) return null;
    o.driverId=did; o.status="assigned"; this.state.orderEvents[oid].push({ts:Date.now(),type:"assigned",data:{driverId:did}});
    if(!this.state.drivers[did]) this.state.drivers[did]={id:did,online:false,lastLocation:null,activeOrderId:null};
    this.state.drivers[did].activeOrderId=oid; this._save(); return o;}
  driverAccept(oid,did){oid=String(oid);did=String(did); const o=this.state.orders[oid]; if(!o||o.driverId!==did) return null;
    o.status="accepted"; this.state.orderEvents[oid].push({ts:Date.now(),type:"accepted",data:{}}); this._save(); return o;}
  updateOrderStatus(oid,status){oid=String(oid); const o=this.state.orders[oid]; if(!o) return null;
    o.status=status; this.state.orderEvents[oid].push({ts:Date.now(),type:"status",data:{status}});
    if(status==="completed"||status==="cancelled"){const did=o.driverId; if(did&&this.state.drivers[String(did)]) this.state.drivers[String(did)].activeOrderId=null;}
    this._save(); return o;}
  setRating(oid,pid,r){oid=String(oid); pid=String(pid); const o=this.state.orders[oid]; if(!o||o.passengerId!==pid) return null;
    o.rating=r; this.state.orderEvents[oid].push({ts:Date.now(),type:"rated",data:{rating:r}});
    const u=this.state.users[pid]; if(u){const c=u.ratingCount||0, avg=u.ratingAvg||0; u.ratingCount=c+1; u.ratingAvg=Math.round(((avg*c+r)/(c+1))*100)/100;}
    this._save(); return o;}
  getOrder(oid){return this.state.orders[String(oid)]||null;}
  getOrderTrack(oid){const o=this.getOrder(oid); if(!o) return null; const d=o.driverId?this.state.drivers[String(o.driverId)]:null; return {order:o, driver:d};}
}
