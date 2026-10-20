# Stellar Customer Bot

A Discord bot that lists unique customers with paid Shopify orders from a chosen date and time. The `/customers` response is private to the person who runs it.

## Requirements

- Node.js 20.12 or newer
- A Discord application and bot added to your server
- A Shopify app configured for client credentials in the same Dev Dashboard organization as your store
- Shopify API access to orders and the customer data the report should display

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy the example environment file and fill in its values:

   ```powershell
   Copy-Item env.example .env
   ```

   Set `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` from your Discord application and server. Set `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` from your Shopify store and app. `SHOPIFY_API_VERSION` is optional; it defaults to `2026-10`.

3. Start the bot:

   ```powershell
   npm start
   ```

On startup, the bot registers the `/customers` command in the configured server. The command is restricted to server administrators by default; administrators can grant access to specific people or roles in the server's Integrations settings.

## Using `/customers`

- `/customers` lists customers with paid orders since yesterday at 9:00 AM in the store's timezone.
- `/customers since:2026-10-01` starts at midnight on the specified date.
- `/customers since:2026-10-01 time:9:30am` starts at the specified local time.

Times accept formats such as `09:30`, `9am`, and `9:30pm`. Long customer lists are attached as `customers.txt`. Shopify's default order-history access may limit results to the most recent 60 days.

## Configuration and privacy

Keep credentials in `.env`; do not commit or share that file. The repository ignores `.env*` files and `node_modules/`. The bot queries Shopify directly and does not store order data. Customer details shown depend on the data available to the Shopify app.
