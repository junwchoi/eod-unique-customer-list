import { fileURLToPath } from "node:url";
import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";

// Load .env from this bot's own folder, wherever the bot was started from. The launcher
// runs "node bot.mjs" without --env-file, so the bot has to read its own settings.
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error; // a missing file is reported below
}

// Discord bot: /customers since:2026-10-01 time:09:30
// Lists the unique customers with paid orders from that moment up to now.
// Replies are private to the person who ran the command.
// Who can use it is controlled by Discord: the command is hidden from everyone except
// server admins (and anyone an admin allows in Server Settings > Integrations).
// Reads Shopify directly, with no embedded app, using the client credentials grant.

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  SHOPIFY_SHOP,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = "2026-10",
} = process.env;

const missing = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "SHOPIFY_SHOP",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
].filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const shop = SHOPIFY_SHOP.replace(/^https?:\/\//, "").replace(/\/+$/, "");

const PAGE_SIZE = 100;
const MAX_PAGES = 200; // up to 20,000 orders per command
const MAX_INLINE_CHARS = 1900; // Discord's limit is 2,000 characters per message
const DEFAULT_TIME = "09:00"; // start time used when /customers is run without a date

// ---------- Shopify access ----------

let cachedToken = null;

// Tokens from the client credentials grant last about 24 hours, so fetch one when needed
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok || !json.access_token) {
    const reason = json.error_description ?? json.error ?? "unknown error";
    throw new Error(
      `Couldn't get a Shopify access token (${response.status}): ${reason}. ` +
        `If it mentions the shop not being permitted, the app and the store aren't in the same Dev Dashboard organization.`,
    );
  }

  const lifetimeMs = (Number(json.expires_in) || 3600) * 1000;
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - 5 * 60 * 1000, 0),
  };
  return cachedToken.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs a GraphQL request. Retries when Shopify throttles us or the token has expired.
async function gql(query, variables) {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const response = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (response.status === 401 && attempt < 2) {
      cachedToken = null;
      continue;
    }
    if (!response.ok) {
      throw new Error(`Shopify returned ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    const errors = json.errors ?? [];
    if (errors.some((e) => e.extensions?.code === "THROTTLED") && attempt < 5) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }
}

const SHOP_TIMEZONE_QUERY = `
  query ShopTimezone {
    shop {
      ianaTimezone
    }
  }`;

const PAID_ORDERS_QUERY = `
  query PaidOrders($query: String!, $after: String) {
    orders(first: ${PAGE_SIZE}, after: $after, query: $query, sortKey: PROCESSED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        email
        customer {
          id
          displayName
          defaultEmailAddress {
            emailAddress
          }
        }
        billingAddress {
          name
        }
      }
    }
  }`;

// ---------- Dates and times (all in the store's timezone) ----------

function isValidDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function todayInZone(timeZone) {
  // The en-CA locale formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Accepts "9", "9am", "9:30", "09:30", "9:30pm", "9:30 PM". Returns 24-hour HH:MM or null.
// With no input, returns the fallback.
function parseTime(input, fallback = "00:00") {
  if (!input) return fallback;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(input.trim());
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - utcMs;
}

// The exact UTC instant (in ms) of a local date and time. "24:00" means the end of that day.
function zonedInstantMs(date, time, timeZone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes so daylight saving transitions resolve correctly
  let utc = guess - zoneOffsetMs(guess, timeZone);
  utc = guess - zoneOffsetMs(utc, timeZone);
  return utc;
}

// ---------- Name display ----------

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

// Splits "Mary Jane Watson" into first "Mary Jane" and last "Watson".
// A trailing Jr/Sr/II/III/IV is ignored. A single word is treated as a first name only.
function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length > 2 && NAME_SUFFIX.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 2) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

// "Jane Smith" -> "Jane S."
// If two or more customers would end up with the same shortened name (for example
// "John Smith" and "John Stone" would both be "John S."), those customers are shown
// with their full last names instead. Everyone else keeps the initial.
function abbreviateNames(fullNames) {
  const parsed = fullNames.map((full) => ({ full, ...splitName(full) }));
  const shortKey = (p) =>
    `${p.first} ${[...p.last][0]}`.toLocaleLowerCase();

  const counts = new Map();
  for (const p of parsed) {
    if (!p.last) continue;
    counts.set(shortKey(p), (counts.get(shortKey(p)) ?? 0) + 1);
  }

  return parsed.map((p) => {
    if (!p.last) return p.first; // single-word name, nothing to shorten
    if (counts.get(shortKey(p)) > 1) return `${p.first} ${p.last}`;
    return `${p.first} ${[...p.last][0].toLocaleUpperCase()}.`;
  });
}

// ---------- The report ----------

async function fetchPaidCustomerNames(startDate, startTime, timeZone) {
  const from = new Date(zonedInstantMs(startDate, startTime, timeZone)).toISOString();
  // Orders can't be in the future, so reading through the end of today means "up to now"
  const until = new Date(
    zonedInstantMs(todayInZone(timeZone), "24:00", timeZone),
  ).toISOString();
  const query = `financial_status:paid processed_at:>='${from}' processed_at:<'${until}'`;

  const customers = new Map();
  let orderCount = 0;
  let unidentifiedOrders = 0;
  let anyEmail = false;
  let truncated = false;
  let after = null;

  for (let page = 0; ; page++) {
    const data = await gql(PAID_ORDERS_QUERY, { query, after });
    const connection = data.orders;

    for (const order of connection.nodes) {
      orderCount++;

      const email = (
        order.customer?.defaultEmailAddress?.emailAddress ??
        order.email ??
        ""
      )
        .trim()
        .toLowerCase();
      const name = (
        order.customer?.displayName ??
        order.billingAddress?.name ??
        ""
      ).trim();
      if (email) anyEmail = true;

      // Email is the main key so a guest checkout and an account for the same
      // person merge into one customer. Customer ID is the fallback.
      const key = email || order.customer?.id || "";
      if (!key) {
        unidentifiedOrders++;
        continue;
      }

      const existing = customers.get(key);
      if (!existing) customers.set(key, { name });
      else if (!existing.name && name) existing.name = name;
    }

    if (!connection.pageInfo.hasNextPage) break;
    if (page + 1 >= MAX_PAGES) {
      truncated = true;
      break;
    }
    after = connection.pageInfo.endCursor;
  }

  const all = [...customers.values()];
  const fullNames = all
    .map((c) => c.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  // Only last initials are shown, with full last names where two would look alike
  const names = abbreviateNames(fullNames);

  return {
    names,
    unnamed: all.length - fullNames.length,
    customerCount: all.length,
    orderCount,
    unidentifiedOrders,
    truncated,
    detailsHidden: orderCount > 0 && !anyEmail,
  };
}

// ---------- Discord ----------

async function handleCustomers(interaction) {
  const sinceInput = interaction.options.getString("since")?.trim();

  if (sinceInput && !isValidDate(sinceInput)) {
    await interaction.editReply("Use a date like `2026-10-01` for `since`.");
    return;
  }

  // With a date, the time defaults to midnight. With no date, it defaults to 9:00 AM.
  const time = parseTime(
    interaction.options.getString("time"),
    sinceInput ? "00:00" : DEFAULT_TIME,
  );
  if (!time) {
    await interaction.editReply(
      "Use a time like `09:30` or `9:30pm` for `time`, or leave it out for the default.",
    );
    return;
  }

  const shopData = await gql(SHOP_TIMEZONE_QUERY);
  const timeZone = shopData.shop.ianaTimezone ?? "UTC";
  const today = todayInZone(timeZone);

  // With no date, start from yesterday (in store time), so the window is always "since yesterday morning"
  const since = sinceInput || addDays(today, -1);

  if (since > today) {
    await interaction.editReply("That start date is in the future.");
    return;
  }

  const report = await fetchPaidCustomerNames(since, time, timeZone);
  const label = `${since} ${time} (${timeZone})`;

  const notes = [];
  if (report.unnamed > 0) {
    notes.push(
      `${report.unnamed} ${report.unnamed === 1 ? "customer has" : "customers have"} no name on the order.`,
    );
  }
  if (report.detailsHidden) {
    notes.push(
      "Customer details look hidden. The app may need protected customer data access for names and emails.",
    );
  }
  if (report.truncated) {
    notes.push("This range has too many orders to read in one go. Choose a later start.");
  }
  if (since < addDays(today, -60)) {
    notes.push(
      "Shopify only lets the app read the last 60 days of orders unless read_all_orders is approved.",
    );
  }
  const footer = notes.length > 0 ? `\n\n${notes.map((n) => `_${n}_`).join("\n")}` : "";

  if (report.customerCount === 0) {
    await interaction.editReply(`No paid orders found since ${label}.${footer}`);
    return;
  }

  const count = report.customerCount;
  const header = `**${count} unique ${count === 1 ? "customer" : "customers"}** with paid orders since ${label}:`;
  const list = report.names.map((name) => `• ${name}`).join("\n");
  const inline = `${header}\n${list}${footer}`;

  if (inline.length <= MAX_INLINE_CHARS) {
    await interaction.editReply(inline);
  } else {
    await interaction.editReply({
      content: `${header}\nThe full list is attached.${footer}`,
      files: [
        new AttachmentBuilder(Buffer.from(report.names.join("\n"), "utf8"), {
          name: "customers.txt",
        }),
      ],
    });
  }
}

// Slash commands only need the basic Guilds intent, no privileged intents
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}. Reading orders from ${shop}.`);

  // Guild commands show up right away. This replaces any other commands the app has in this server.
  const guild = await readyClient.guilds.fetch(DISCORD_GUILD_ID);
  await guild.commands.set([
    {
      name: "customers",
      description: "List unique customers with paid orders since a date and time",
      // Hidden from everyone except server admins. Admins can allow specific people or
      // roles in Server Settings > Integrations. Discord enforces this, not the bot.
      defaultMemberPermissions: 0n,
      dmPermission: false,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "since",
          description: "Start date as YYYY-MM-DD (leave out for yesterday at 9:00 AM)",
          required: false,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "time",
          description: "Start time, e.g. 09:30, 9am or 9:30pm (default: midnight, or 9:00 AM with no date)",
          required: false,
        },
      ],
    },
  ]);
  console.log("Registered /customers. The bot is ready.");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "customers") {
    return;
  }

  // Discord wants an answer within 3 seconds, so acknowledge now (privately)
  // and fill in the result when Shopify responds
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    console.log(`/customers run by ${interaction.user.tag}`);
    await handleCustomers(interaction);
  } catch (error) {
    console.error("/customers failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.editReply(`Something went wrong: ${message}`).catch(() => {});
  }
});

client.on(Events.Error, (error) => console.error("Discord client error:", error));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));

await client.login(DISCORD_BOT_TOKEN);
