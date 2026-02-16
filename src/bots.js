const { Telegraf, Markup } = require('telegraf');

function mkBot(token) {
  if (!token) return null;
  return new Telegraf(token);
}

function setupBots(app, { baseUrl }) {
  const passengerBot = mkBot(process.env.PASSENGER_BOT_TOKEN);
  const driverBot = mkBot(process.env.DRIVER_BOT_TOKEN);
  const adminBot = mkBot(process.env.ADMIN_BOT_TOKEN);

  const passengerWebApp = `${baseUrl}/passenger/`;
  const driverWebApp = `${baseUrl}/driver/`;
  const adminWebApp = `${baseUrl}/admin/`;

  if (passengerBot) {
    passengerBot.start(async (ctx) => {
      await ctx.reply('👋 PayTaksi Sifariş Ver\n\nAşağıdakı düymə ilə tətbiqi açın.',
        Markup.keyboard([[Markup.button.webApp('🚕 Sifariş ver', passengerWebApp)]]).resize()
      );
    });
    passengerBot.command('app', (ctx) => ctx.reply('PayTaksi Passenger tətbiqi:', Markup.keyboard([[Markup.button.webApp('🚕 Sifariş ver', passengerWebApp)]]).resize()));

    app.use(passengerBot.webhookCallback('/webhook/passenger'));
  }

  if (driverBot) {
    driverBot.start(async (ctx) => {
      await ctx.reply('👋 PayTaksi Sürücü Ol\n\nAşağıdakı düymə ilə sürücü panelini açın.',
        Markup.keyboard([[Markup.button.webApp('🚗 Sürücü paneli', driverWebApp)]]).resize()
      );
    });
    driverBot.command('app', (ctx) => ctx.reply('PayTaksi Driver tətbiqi:', Markup.keyboard([[Markup.button.webApp('🚗 Sürücü paneli', driverWebApp)]]).resize()));

    app.use(driverBot.webhookCallback('/webhook/driver'));
  }

  if (adminBot) {
    adminBot.start(async (ctx) => {
      await ctx.reply('👋 PayTaksi Admin\n\nAşağıdakı düymə ilə admin panelini açın.',
        Markup.keyboard([[Markup.button.webApp('🛠 Admin panel', adminWebApp)]]).resize()
      );
    });
    adminBot.command('app', (ctx) => ctx.reply('PayTaksi Admin panel:', Markup.keyboard([[Markup.button.webApp('🛠 Admin panel', adminWebApp)]]).resize()));

    app.use(adminBot.webhookCallback('/webhook/admin'));
  }

  async function setWebhooks() {
    if (!baseUrl) return;
    const secret = process.env.WEBHOOK_SECRET;

    if (passengerBot) {
      await passengerBot.telegram.setWebhook(`${baseUrl}/webhook/passenger`, secret ? { secret_token: secret } : undefined);
    }
    if (driverBot) {
      await driverBot.telegram.setWebhook(`${baseUrl}/webhook/driver`, secret ? { secret_token: secret } : undefined);
    }
    if (adminBot) {
      await adminBot.telegram.setWebhook(`${baseUrl}/webhook/admin`, secret ? { secret_token: secret } : undefined);
    }
  }

  return { passengerBot, driverBot, adminBot, setWebhooks };
}

module.exports = { setupBots };
