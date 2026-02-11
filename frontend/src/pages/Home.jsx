import React from 'react';

export default function Home({ me }) {
  return (
    <div>
      <div className="card">
        <div className="h1">PayTaksi</div>
        <div className="row">
          <span className="badge">Komissiya: 10%</span>
          <span className="badge">Start: 3.50 AZN</span>
          <span className="badge">3 km-dən sonra: 0.40 AZN / km</span>
        </div>
        <div className="hr" />
        <div>
          {me ? (
            <>
              <div>Salam, <b>{me.name || 'User'}</b>!</div>
              <small>Rol: {me.role}</small>
            </>
          ) : (
            <small>Telegram daxilində açanda avtomatik login olacaq.</small>
          )}
        </div>
      </div>

      <div className="card">
        <div className="h1">Nə var?</div>
        <ul>
          <li>Sərnişin: avtomatik yer (GPS), ünvan axtarışı (alternativ yaxın yerlər), sifariş yaratma.</li>
          <li>Sürücü: qeydiyyat (min 2010), rəng seçimləri, sənəd yükləmə, yaxın sifarişləri görüb qəbul etmə.</li>
          <li>Balans: top-up sorğuları (Kart-to-Kart / M10), admin təsdiq edir.</li>
          <li>Admin: sürücü/sənəd təsdiqi, top-up təsdiqi, qiymət/komissiya setting-ləri.</li>
        </ul>
      </div>
    </div>
  );
}
