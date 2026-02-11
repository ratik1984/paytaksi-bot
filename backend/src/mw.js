function requireApiKey(req,res,next){
  const key=req.headers["x-api-key"];
  if(!process.env.API_KEY) return res.status(500).json({error:"API_KEY not set"});
  if(key!==process.env.API_KEY) return res.status(401).json({error:"Unauthorized"});
  next();
}
function getActor(req){
  const telegramId=req.headers["x-telegram-id"];
  if(!telegramId) return null;
  return { telegramId:String(telegramId) };
}
module.exports = { requireApiKey, getActor };
