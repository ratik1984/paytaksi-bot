import { Markup } from "telegraf";
export const colors=["ağ","qara","qırmızı","boz","mavi","sarı","yaşıl"];
export const mainMenuPassenger=()=>Markup.keyboard([["🚕 Sifariş yarat"],["📜 Sifarişlərim","❓ Kömək"]]).resize();
export const mainMenuDriver=()=>Markup.keyboard([["🧾 Qeydiyyat / Profil","🟢 Onlayn ol"],["🔴 Oflayn ol","💰 Balans"],["➕ Balans artır","❓ Kömək"]]).resize();
export const mainMenuAdmin=()=>Markup.keyboard([["👥 Sürücülər","🧾 Top-up sorğuları"],["🚕 Sifarişlər","⚙️ Parametrlər"],["📣 Broadcast"]]).resize();
