import crypto from "crypto";
export function parseAdminIds(s=""){return new Set(s.split(",").map(x=>x.trim()).filter(Boolean).map(Number).filter(Number.isFinite));}
export function validateInitData(initData, botToken){
  if(!initData||!botToken) return {ok:false, reason:"missing_initData_or_token"};
  const p=new URLSearchParams(initData);
  const hash=p.get("hash"); if(!hash) return {ok:false, reason:"missing_hash"};
  p.delete("hash");
  const d=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret=crypto.createHmac("sha256","WebAppData").update(botToken).digest();
  const calc=crypto.createHmac("sha256",secret).update(d).digest("hex");
  if(calc!==hash) return {ok:false, reason:"hash_mismatch"};
  let user=null; try{user=JSON.parse(p.get("user")||"null");}catch{}
  return {ok:true,user};
}
