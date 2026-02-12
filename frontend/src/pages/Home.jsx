import React from "react";
import { isTelegram } from "../lib/telegram.js";

export default function Home() {
  return (
    <>
      <div className="card">
        <div className="h1">PayTaksi v2</div>
        <div className="row">
          <div className="col">
            <span className="badge ok">Komissiya: 10%</span>
            <span className="badge">Start: 3.50 AZN</span>
            <span className="badge">3 km-dən sonra: 0.40 AZN/km</span>
          </div>
        </div>
        <p className="muted" style={{marginTop:10}}>
          {isTelegram() ? "Telegram daxilində açılıb (auto login olacaq)." : "Brauzerdə test rejimi (Telegram user yoxdursa, demo istifadəçi ilə işləyəcək)."}
        </p>
      </div>

      <div className="card">
        <div className="h1">Nə var?</div>
        <ul className="muted">
          <li>Sərnişin: xəritə, cari yer adı (reverse), ünvan autocomplete, sifariş yaratma, status izləmə.</li>
          <li>Sürücü: qeydiyyat (min 2010), rəng seçimi, sənəd yükləmə, canlı location, real-time sifariş təklifləri, qəbul et.</li>
          <li>Admin: sürücü/sənəd təsdiqi, top-up təsdiqi, qiymət/komissiya setting-ləri.</li>
        </ul>
      </div>
    </>
  );
}
