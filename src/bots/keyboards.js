const { Markup } = require("telegraf");

function passengerMain(){
  return Markup.keyboard([
    ["🚕 Taksi sifariş et"],
    ["👤 Profil", "🧾 Sifarişlərim"],
    ["ℹ️ Kömək"]
  ]).resize();
}

function driverMain(){
  return Markup.keyboard([
    ["🟢 Onlayn ol / Offlayn ol"],
    ["💰 Balansım", "➕ Balans artır"],
    ["🧾 Gedışlərim", "ℹ️ Kömək"]
  ]).resize();
}

function adminMain(){
  return Markup.keyboard([
    ["🧑‍✈️ Sürücü təsdiqləri", "➕ Balans yükləmələri"],
    ["📦 Aktiv sifarişlər", "📊 Statistikalar"],
    ["ℹ️ Kömək"]
  ]).resize();
}

module.exports = { passengerMain, driverMain, adminMain };
