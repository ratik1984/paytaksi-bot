export async function registerWebhook(bot, path, appBaseUrl) {
  const url = `${appBaseUrl}${path}`;
  await bot.telegram.setWebhook(url);
  return url;
}
