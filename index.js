require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder,
    REST,
    Routes,
    Events,
    MessageFlags,
    Partials
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { sheetsLog, sheetsUpsertTicket, sheetsUpsertPayment } = require("./sheets");

// =====================================================
// SETTINGS
// =====================================================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || STAFF_ROLE_ID;

const MAX_TICKETS = 25;
const MAX_OPEN_TICKETS_PER_USER = 20;
const MAX_IMAGES_PER_TICKET = 10;
const WARRANTY_DAYS = 8;
const TEMP_MESSAGE_MS = 50 * 1000;
const ADMIN_CALL_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_CALL_MAX = 2;
const CLOSED_TICKET_RETENTION_DAYS = 14;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts-data.json");
const TICKET_JOURNAL_FILE = path.join(DATA_DIR, "ticket-storage.pending.json");
const SELLERS_FILE = path.join(DATA_DIR, "sellers.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.json");
const CONFIG_FILE = path.join(DATA_DIR, "ticket-config.json");
const GAMES_FILE = path.join(DATA_DIR, "games.json");
const TICKET_SHEET_PENDING_FILE = path.join(DATA_DIR, "ticket-sheet-pending.json");

// =====================================================
// GAMES
// =====================================================

const DEFAULT_GAMES = [];

let GAMES = [];

// =====================================================
// PAYMENT METHODS
// =====================================================

const PAYMENT_METHODS = [
    { label: "Vodafone Cash", value: "vodafone", emoji: "📱" },
    { label: "InstaPay", value: "instapay", emoji: "💳" },
    { label: "Orange Cash", value: "orange", emoji: "🟠" },
    { label: "Etisalat Cash", value: "etisalat", emoji: "🟢" },
    { label: "Other / غير ذلك", value: "other", emoji: "➕" }
];

// =====================================================
// SELLER RANK SYSTEM
// =====================================================

const RANKS = [
    {
        key: "trusted",
        accounts: 25,
        roleName: "😎TRUSTED😎",
        roleId: process.env.RANK_ROLE_TRUSTED || "1324715387962523678",
        display: "😎 TRUSTED"
    },
    {
        key: "legendary",
        accounts: 20,
        roleName: "legendary",
        roleId: process.env.RANK_ROLE_LEGENDARY || "1324895905207418900",
        display: "🏆 LEGENDARY"
    },
    {
        key: "gold",
        accounts: 15,
        roleName: "GOLD",
        roleId: process.env.RANK_ROLE_GOLD || "1324894800905895946",
        display: "🥇 GOLD"
    },
    {
        key: "epic",
        accounts: 10,
        roleName: "EPIC",
        roleId: process.env.RANK_ROLE_EPIC || "1324895546246168790",
        display: "💜 EPIC"
    },
    {
        key: "silver",
        accounts: 5,
        roleName: "SILVER",
        roleId: process.env.RANK_ROLE_SILVER || "1324895310790524959",
        display: "🥈 SILVER"
    }
];

// =====================================================
// DATA FILES
// =====================================================

function createFileIfMissing(file, defaultData) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
    }
}

createFileIfMissing(TICKETS_FILE, []);
createFileIfMissing(AUDIT_FILE, []);
createFileIfMissing(SELLERS_FILE, {});
createFileIfMissing(CONFIG_FILE, {
    panelChannelId: null,
    panelMessageId: null
});

createFileIfMissing(GAMES_FILE, DEFAULT_GAMES);

function readJSON(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        console.error(`❌ Error reading ${file}:`, error);
        return fallback;
    }
}

function writeJSON(file, data) {
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
    try {
        fs.renameSync(tempFile, file);
    } catch (error) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
        throw error;
    }
}

function audit(action, actor, ticket = {}, details = {}) {
    const entry = {at: new Date().toISOString(), action, actor, ticketId: ticket?.ticketId || null, game: ticket?.game || null, ...details};
    const entries = readJSON(AUDIT_FILE, []);
    entries.push(entry);
    writeJSON(AUDIT_FILE, entries);
    sheetsLog("AuditLog", entry);
}

function ticketSheetRow(ticket) {
    return {
        ticketId:ticket.ticketId,createdAt:ticket.createdAt,sellerId:ticket.userId,discordTag:ticket.discordTag || "",
        game:getGameName(ticket.game),accountType:ticket.accountType || "—",accountRank:ticket.accountRank || "—",
        skinCount:ticket.skinCount || "—",skinDetails:ticket.skinDetails || "—",quantity:ticket.quantity || 1,
        price:ticket.price || "—",payment:ticket.paymentDisplay || ticket.payment || "—",
        contactPhone:ticket.contactPhone || "—",payoutDetails:ticket.payoutDetails || "—",description:ticket.description || "—",
        status:ticket.status,language:ticket.language,warrantyDays:ticketWarrantyDays(ticket),
        seenBy:ticket.seenBy || "",seenByName:ticket.seenByName || "",seenAt:ticket.seenAt || "",
        soldBy:ticket.soldBy || "",soldByName:ticket.soldByName || "",soldAt:ticket.soldAt || "",
        paidBy:ticket.paidBy || "",paidByName:ticket.paidByName || "",paidAt:ticket.paidAt || "",
        closedBy:ticket.closedBy || "",closedByName:ticket.closedByName || "",closedAt:ticket.closedAt || ""
    };
}
function paymentSheetRow(ticket, creditedTotal = "") {
    const buyers=ticketBuyerIds(ticket);
    const dueAt=buyerDueAt(ticket);
    const buyerPaid=Boolean(ticket.buyerPayment?.paidAt);
    return {
        ticketId:ticket.ticketId,
        sellerId:ticket.userId,
        quantity:ticket.quantity || 1,
        game:getGameName(ticket.game),
        price:ticket.price || "",
        paymentMethod:ticket.paymentDisplay || getPaymentName(ticket.payment),
        buyerId:ticket.buyerPayment?.payerId || buyers.join(","),
        amountDue:ticket.price || "",
        dueSince:ticket.warrantyEndsAt || "",
        buyerPaidAt:ticket.buyerPayment?.paidAt || "",
        buyerStatus:buyerPaid ? "PAID" : (dueAt!==null && dueAt<=Date.now() ? "DUE" : "PENDING"),
        sellerPaidAt:ticket.paidAt || "",
        sellerPaidBy:ticket.paidByName ? `${ticket.paidByName} (${ticket.paidBy})` : ticket.paidBy || "",
        fundsReleasedAt:ticket.fundsReleasedAt || "",
        creditedTotal
    };
}
function logPaymentSnapshot(ticket, creditedTotal = "") {
    Promise.resolve(sheetsUpsertPayment(paymentSheetRow(ticket,creditedTotal)))
        .catch(error=>console.error("Payment sheet sync failed:",error.message));
}
let ticketSheetSyncRunning=false;
function logTicketSnapshot(ticket, initial=false) {
    // Keep updates durable until a verified upsert adapter is available. Never append
    // a new Tickets row for each staff action with an unknown legacy sheetsLog adapter.
    try {
        const row=ticketSheetRow(ticket);
        const pending=readJSON(TICKET_SHEET_PENDING_FILE,{});
        pending[ticket.ticketId]={revision:randomUUID(),row};
        writeJSON(TICKET_SHEET_PENDING_FILE,pending);
        if(typeof sheetsUpsertTicket==="function") flushTicketSheetUpdates().catch(error=>console.error("Ticket sheet sync failed:",error.message));
        else if(initial) Promise.resolve(sheetsLog("Tickets",row)).catch(error=>console.error("Ticket sheet create failed:",error.message));
    } catch(error) {console.error("Ticket sheet snapshot failed:",error.message);}
}
async function flushTicketSheetUpdates() {
    if(ticketSheetSyncRunning || typeof sheetsUpsertTicket!=="function") return;
    ticketSheetSyncRunning=true;
    try {
        const pending=readJSON(TICKET_SHEET_PENDING_FILE,{});
        for(const [id,entry] of Object.entries(pending)) {
            try {
                // Adapter contract: update/insert by ticketId, preserve unrelated rows/columns,
                // and resolve only when the Google Sheets write has completed.
                await sheetsUpsertTicket(entry.row);
                const fresh=readJSON(TICKET_SHEET_PENDING_FILE,{});
                if(fresh[id]?.revision===entry.revision) {delete fresh[id];writeJSON(TICKET_SHEET_PENDING_FILE,fresh);}
            } catch(error) {console.error("Ticket sheet update failed:",error.message);}
        }
    } finally {ticketSheetSyncRunning=false;}
}


function canConfirmPayout(ticket) {
    return Boolean((ticket.receivedAt || ticket.soldAt) && !ticket.paidAt && !ticket.correction && ticket.status !== "CHANGES_REQUESTED");
}

function creditPaidAccounts(ticket) {
    const sellers=loadSellers();
    const seller=sellers[ticket.userId] || {delivered:0,rank:null,manualRank:null};
    const credited=Array.isArray(seller.creditedTickets) ? seller.creditedTickets : [];
    if (!credited.includes(ticket.ticketId)) {
        // Legacy owner sales may already be included. Staff credits are not owner credits.
        if (!(ticket.deliveredCounted && ticket.sellerId === ticket.userId)) {
            seller.delivered=(Number(seller.delivered)||0)+Math.max(1,Number(ticket.quantity)||1);
        }
        seller.creditedTickets=[...credited,ticket.ticketId];
        seller.updatedAt=new Date().toISOString();
        sellers[ticket.userId]=seller;
        saveSellers(sellers);
    }
    return Number(seller.delivered)||0;
}

function payoutReady(ticket) {
    return Boolean(ticket.soldAt && ticket.warrantyEndsAt && new Date(ticket.warrantyEndsAt).getTime() <= Date.now());
}

const OWNER_FIELDS = ["userId","discordTag","username","name","contactPhone","payment","paymentDisplay","payoutDetails"];
const ACCOUNT_FIELDS = ["accounts","buyerId","buyerIds","buyerPayment","price","extra"];
const PRIVATE_TICKET_FIELDS = [...OWNER_FIELDS,...ACCOUNT_FIELDS];

function readStorageArray(file, missingAllowed = false) {
    if (!fs.existsSync(file)) {
        if (missingAllowed) return [];
        throw new Error(`Missing storage file: ${file}`);
    }
    const value = JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
    if (!Array.isArray(value)) throw new Error(`Storage must be an array: ${file}`);
    const ids=new Set();
    for (const row of value) {
        if (!row || typeof row.ticketId!=="string" || ids.has(row.ticketId)) throw new Error(`Invalid or duplicate ticket ID in ${file}`);
        ids.add(row.ticketId);
    }
    return value;
}

function recoverTicketStorage() {
    if (!fs.existsSync(TICKET_JOURNAL_FILE)) return;
    try {
        const pending=JSON.parse(fs.readFileSync(TICKET_JOURNAL_FILE,"utf8"));
        if (pending.version!==1 || !Array.isArray(pending.tickets) || !Array.isArray(pending.accounts)) {
            console.error("⚠️ Invalid ticket storage journal — deleting corrupt journal.");
            fs.unlinkSync(TICKET_JOURNAL_FILE);
            return;
        }
        writeJSON(ACCOUNTS_FILE,pending.accounts);
        writeJSON(TICKETS_FILE,pending.tickets);
        fs.unlinkSync(TICKET_JOURNAL_FILE);
        console.log("✅ Recovered ticket storage from journal.");
    } catch (error) {
        console.error("❌ recoverTicketStorage error:", error.message);
    }
}

function loadTickets() {
    recoverTicketStorage();
    const tickets=readStorageArray(TICKETS_FILE);
    const accounts=readStorageArray(ACCOUNTS_FILE,true);
    const privateById=new Map(accounts.map(row=>[row.ticketId,row]));
    return tickets.map(ticket=>{
        // Older versions kept everything in tickets.json. Read them without losing any fields.
        if (PRIVATE_TICKET_FIELDS.some(key=>Object.prototype.hasOwnProperty.call(ticket,key))) return ticket;
        const record=privateById.get(ticket.ticketId);
        if (!record) throw new Error(`Missing account record for ticket ${ticket.ticketId}; restore accounts-data.json`);
        if (!record.owner || typeof record.owner!=="object" || Array.isArray(record.owner)) throw new Error("Invalid account owner record");
        const merged={...ticket};
        for (const key of OWNER_FIELDS) if (Object.prototype.hasOwnProperty.call(record.owner,key)) merged[key]=record.owner[key];
        for (const key of ACCOUNT_FIELDS) if (Object.prototype.hasOwnProperty.call(record,key)) merged[key]=record[key];
        return merged;
    });
}

function saveTickets(tickets) {
    recoverTicketStorage();
    const metadata=[],accounts=[],ids=new Set();
    for (const ticket of tickets) {
        if (!ticket || typeof ticket.ticketId!=="string" || ids.has(ticket.ticketId)) throw new Error("Invalid ticket ID during save");
        ids.add(ticket.ticketId);
        const meta={...ticket};
        const record={ticketId:ticket.ticketId,owner:{}};
        for (const key of OWNER_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(ticket,key)) record.owner[key]=ticket[key];
            delete meta[key];
        }
        for (const key of ACCOUNT_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(ticket,key)) record[key]=ticket[key];
            delete meta[key];
        }
        metadata.push(meta);accounts.push(record);
    }
    // Recovery completes both file writes if the process stops between them.
    writeJSON(TICKET_JOURNAL_FILE,{version:1,tickets:metadata,accounts});
    writeJSON(ACCOUNTS_FILE,accounts);
    writeJSON(TICKETS_FILE,metadata);
    fs.unlinkSync(TICKET_JOURNAL_FILE);
}

recoverTicketStorage();
if (!fs.existsSync(ACCOUNTS_FILE)) {
    saveTickets(loadTickets());
} else if (readStorageArray(TICKETS_FILE, true).some(ticket=>PRIVATE_TICKET_FIELDS.some(key=>Object.prototype.hasOwnProperty.call(ticket,key)))) {
    saveTickets(loadTickets());
}

function loadSellers() {
    return readJSON(SELLERS_FILE, {});
}

function saveSellers(sellers) {
    writeJSON(SELLERS_FILE, sellers);
}

function loadConfig() {
    return readJSON(CONFIG_FILE, {
        panelChannelId: null,
        panelMessageId: null
    });
}

function saveConfig(config) {
    writeJSON(CONFIG_FILE, config);
}

function validWarrantyDays(value) { return Number.isInteger(value) && value >= 0 && value <= 365; }
function configuredWarrantyDays(ticket) {
    const game=GAMES.find(g=>g.value===ticket.game);
    const type=stockPool(game,ticket.accountTypeId || "general");
    return validWarrantyDays(type?.warrantyDays) ? type.warrantyDays : validWarrantyDays(game?.warrantyDays) ? game.warrantyDays : WARRANTY_DAYS;
}
function ticketWarrantyDays(ticket) {
    if(validWarrantyDays(ticket.warrantyDays)) return ticket.warrantyDays;
    const elapsed=Date.parse(ticket.warrantyEndsAt)-Date.parse(ticket.warrantyStartedAt || ticket.soldAt);
    if(Number.isFinite(elapsed) && elapsed>=0) return Math.round(elapsed/86400000*100)/100;
    return ticket.soldAt ? WARRANTY_DAYS : configuredWarrantyDays(ticket);
}
function normalizeAccountTypes(game) {
    const types = Array.isArray(game.accountTypes) ? game.accountTypes : [
        {id:"general",name:"General",nameAr:"عام",stock:Math.max(0, Number(game.stock)||0),receivedTicketIds:game.receivedTicketIds || []},
        {id:"ranked",name:"Ranked",nameAr:"رانكد",stock:0},
        {id:"rank-ready",name:"Rank Ready",nameAr:"جاهز للرانك",stock:0},
        {id:"skins",name:"With Skins",nameAr:"به سكنات",stock:0}
    ];
    return types.map(t=>({fixedPrice:t.fixedPrice ? String(t.fixedPrice).slice(0,100) : null,id:String(t.id),name:String(t.name).slice(0,80),nameAr:String(t.nameAr || "").slice(0,80),
        warrantyDays: validWarrantyDays(t.warrantyDays) ? t.warrantyDays : null,
        deliveryInfo: t.deliveryInfo ? {en:String(t.deliveryInfo.en || "").slice(0,1000),ar:String(t.deliveryInfo.ar || "").slice(0,1000)} : null,
        stock:Math.max(0,Math.floor(Number(t.stock)||0)),receivedTicketIds:Array.isArray(t.receivedTicketIds)?t.receivedTicketIds:[]})).sort((a,b)=>Number(a.id==="general")-Number(b.id==="general"));
}

function stockPool(game, typeId = "general") {
    return game?.accountTypes?.find(t=>t.id === typeId) || null;
}

function resolveAccountType(game, query) {
    const value=String(query || "").trim().toLowerCase();
    return game?.accountTypes?.find(t=>[t.id,t.name,t.nameAr].some(v=>v?.toLowerCase()===value)) || null;
}
function quotedTicketPrice(game,type,quantity) {
    if(!type?.fixedPrice) return game?.fixedPrice || null;
    const money=buyerMoney(type.fixedPrice);
    const total=money && money.cents*quantity;
    if(!money || !Number.isSafeInteger(quantity) || quantity<1 || !Number.isSafeInteger(total)) throw Error("Invalid type price or quantity");
    return `${(total/100).toFixed(2)} ${money.currency}`;
}


function accountTypeName(type, language = "en") {
    return language === "ar" ? type.nameAr || type.name : type.name;
}

const ACCOUNT_RANKS = {
    valorant: ["Iron","Bronze","Silver","Gold","Platinum","Diamond","Ascendant","Immortal","Radiant"],
    overwatch: ["Bronze","Silver","Gold","Platinum","Diamond","Master","Grandmaster","Champion"],
    apex: ["Rookie","Bronze","Silver","Gold","Platinum","Diamond","Master","Apex Predator"],
    lol: ["Iron","Bronze","Silver","Gold","Platinum","Emerald","Diamond","Master","Grandmaster","Challenger"],
    marvel: ["Bronze","Silver","Gold","Platinum","Diamond","Grandmaster","Celestial","Eternity","One Above All"],
    warzone: ["Bronze","Silver","Gold","Platinum","Diamond","Crimson","Iridescent","Top 250"],
    blackops: ["Bronze","Silver","Gold","Platinum","Diamond","Crimson","Iridescent","Top 250"]
};

function typeDetailsComplete(pending) {
    if (pending.accountTypeId === "ranked") return Boolean(pending.accountRank);
    if (pending.accountTypeId === "skins") return Number.isSafeInteger(pending.skinCount) && pending.skinCount > 0 && Boolean(pending.skinDetails?.trim());
    return true;
}

function paymentPrompt(pending) {
    const game = GAMES.find(g=>g.value===pending.game);
    const type = stockPool(game,pending.accountTypeId);
    return {content:`**${game.label} — ${type.name} / ${type.nameAr || type.name}**\nSelect payout method / اختر طريقة استلام الفلوس`,components:[createPaymentMenu()],flags:MessageFlags.Ephemeral};
}

function createAccountTypeMenu(game) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId("select_account_type").setPlaceholder("Select account type / اختر نوع الحساب")
        .addOptions(game.accountTypes.map(type=>({label:(type.name + (type.nameAr ? ` / ${type.nameAr}` : "")).slice(0,100),
            value:type.id,description:`Available: ${type.stock}${type.fixedPrice ? ` | Each: ${type.fixedPrice}` : ""}`.slice(0,100),emoji:type.stock>0?"🟢":"🔴"}))));
}

function loadGames() {
    const games = readJSON(GAMES_FILE, DEFAULT_GAMES);

    return Array.isArray(games)
        ? games.map(game => ({
            label: String(game.label || "Game").substring(0, 100),
            value: String(game.value || slugifyGameName(game.label || "game")).substring(0, 100),
            emoji: game.emoji || "🎮",
            warrantyDays: validWarrantyDays(game.warrantyDays) ? game.warrantyDays : null,
            stock: normalizeAccountTypes(game).reduce((total,t)=>total+t.stock,0),
            accountTypes: normalizeAccountTypes(game),
            fixedPrice: game.fixedPrice ? String(game.fixedPrice).substring(0, 100) : null,
            receivedTicketIds: Array.isArray(game.receivedTicketIds) ? game.receivedTicketIds : [],
            deliveryInfo: game.deliveryInfo && typeof game.deliveryInfo === "object"
                ? { en: String(game.deliveryInfo.en || "").slice(0, 1000), ar: String(game.deliveryInfo.ar || "").slice(0, 1000) }
                : null,
            customMessage: game.customMessage ? String(game.customMessage).substring(0, 1900) : null
        }))
        : [...DEFAULT_GAMES];
}

function saveGames(games) {
    const normalized=games.map(game=>{
        const accountTypes=normalizeAccountTypes(game);
        return {...game,accountTypes,stock:accountTypes.reduce((total,t)=>total+t.stock,0)};
    });
    writeJSON(GAMES_FILE, normalized);
    GAMES = normalized;
}

function slugifyGameName(name) {
    const base = String(name || "game")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return (base || `game-${Date.now()}`).substring(0, 90);
}

function findGame(query) {
    const target = String(query || "").trim().toLowerCase();

    return GAMES.find(game =>
        game.value.toLowerCase() === target ||
        game.label.toLowerCase() === target
    ) || null;
}

function getGameStock(value, typeId = null) {
    const game = GAMES.find(item => item.value === value);
    return typeId ? stockPool(game,typeId)?.stock || 0 : game ? Math.max(0, Number(game.stock) || 0) : 0;
}

function getStockIndicator(stock) {
    const amount = Math.max(0, Number(stock) || 0);

    if (amount <= 0) return "🔴";
    if (amount < 10) return "🟡";
    return "🟢";
}

GAMES = loadGames();

// =====================================================
// TEMP USER DATA
// =====================================================

const pendingTickets = new Map();
const typeMutationJobs = new Set();

// =====================================================
// BASIC HELPERS
// =====================================================

function findChannelTicket(channelId) {
    return loadTickets().find(t => t.ticketId === channelId);
}

function buildLegacyAccountExtra(account) {
    return account.additionalInfo || account.details || [
        account.email ? `Email: ${account.email}` : "",
        account.emailPassword ? `Email Password: ${account.emailPassword}` : "",
        account.recovery ? `Recovery: ${account.recovery}` : "",
        account.phone ? `Phone: ${account.phone}` : "",
        account.dob ? `Date of Birth: ${account.dob}` : "",
        account.level ? `Level: ${account.level}` : "",
        account.rank ? `Rank: ${account.rank}` : "",
        account.skins ? `Skins: ${account.skins}` : ""
    ].filter(Boolean).join("\n");
}

function getAvailableTickets() {
    return Math.max(0, MAX_TICKETS - loadTickets().filter(ticket => !ticket.closedAt).length);
}

function getAvailabilityIndicator() {
    const available = getAvailableTickets();

    if (available <= 0) return "🔴";
    if (available < 10) return "🟡";
    return "🟢";
}

function getUserOpenTicketCount(userId) {
    return loadTickets().filter(
        ticket => !ticket.closedAt && ticket.userId === userId
    ).length;
}

function deleteReplyLater(interaction, delay = TEMP_MESSAGE_MS) {
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, delay);
}

async function sendTemporaryChannelMessage(channel, payload, delay = TEMP_MESSAGE_MS) {
    try {
        const message = await channel.send(payload);
        setTimeout(() => message.delete().catch(() => {}), delay);
        return message;
    } catch (_) {
        return null;
    }
}

function getNextIncompleteAccountIndex(ticket) {
    const quantity = Math.max(1, Number(ticket.quantity) || 1);
    const accounts = Array.isArray(ticket.accounts) ? ticket.accounts : [];

    for (let i = 0; i < quantity; i += 1) {
        if (!accounts[i]) return i;
    }

    return -1;
}

const DEFAULT_DELIVERY_INFO = "Email:\nPassword:\nFirst name:\nLast name:\nDate of Birth:\nNumber:";

function getDeliveryInfo(ticket) {
    const game = GAMES.find(item => item.value === ticket.game);
    const info = stockPool(game,ticket.accountTypeId || "general")?.deliveryInfo || game?.deliveryInfo;
    return ((ticket.language || ticket.lang) === "ar" ? info?.ar || info?.en : info?.en || info?.ar)
        || DEFAULT_DELIVERY_INFO;
}

function buildAccountDataModal(ticket, accountIndex, existing = {}) {
    const l = ticketText(ticket);
    const modal = new ModalBuilder()
        .setCustomId(`account_data:${ticket.ticketId}:${accountIndex}`)
        .setTitle(l(`Account ${accountIndex + 1} • Login Details`, `الحساب ${accountIndex + 1} • بيانات الدخول`));

    const login = new TextInputBuilder()
        .setCustomId("login")
        .setLabel(l("Login", "بيانات الدخول"))
        .setPlaceholder(l("Email / Username / Login", "الإيميل / اسم المستخدم"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const password = new TextInputBuilder()
        .setCustomId("password")
        .setLabel(l("Password", "كلمة المرور"))
        .setPlaceholder(l("Account password", "كلمة مرور الحساب"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const additionalInfo = new TextInputBuilder()
        .setCustomId("additional_info")
        .setLabel(l("Additional Info (required)", "المعلومات الإضافية (إلزامية)"))
        .setPlaceholder(
            getDeliveryInfo(ticket).slice(0, 100)
        )
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000);

    const oldLogin = existing.login || existing.username || existing.email || "";
    const oldPassword = existing.password || "";
    const oldAdditional = buildLegacyAccountExtra(existing);

    if (oldLogin) login.setValue(String(oldLogin).substring(0, 4000));
    if (oldPassword) password.setValue(String(oldPassword).substring(0, 4000));
    if (oldAdditional) additionalInfo.setValue(String(oldAdditional).substring(0, 4000));

    modal.addComponents(
        new ActionRowBuilder().addComponents(login),
        new ActionRowBuilder().addComponents(password),
        new ActionRowBuilder().addComponents(additionalInfo)
    );

    return modal;
}

async function pingAdminForTicket(interaction, ticket) {
    const l = ticketText(ticket);
    const now = Date.now();
    const windowStartedAt = ticket.adminCallWindowStartedAt
        ? new Date(ticket.adminCallWindowStartedAt).getTime()
        : 0;

    if (!windowStartedAt || now - windowStartedAt >= ADMIN_CALL_WINDOW_MS) {
        ticket.adminCallWindowStartedAt = new Date(now).toISOString();
        ticket.adminCallCount = 0;
    }

    const count = Number(ticket.adminCallCount) || 0;

    if (count >= ADMIN_CALL_MAX) {
        const resetAt = windowStartedAt + ADMIN_CALL_WINDOW_MS;
        const waitSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

        return interaction.reply({
            content:
                l(`⏳ You can call Admin only **${ADMIN_CALL_MAX} times every 15 minutes**. `, `⏳ مسموح تنادي الإدارة **${ADMIN_CALL_MAX} مرات كحد أقصى كل 15 دقيقة**. `) +
                l(`Try again in about **${Math.ceil(waitSeconds / 60)} minute(s)**.`, `جرّب تاني بعد حوالي **${Math.ceil(waitSeconds / 60)} دقيقة**.`),
            flags: MessageFlags.Ephemeral
        });
    }

    ticket.adminCallCount = count + 1;

    const tickets = loadTickets();
    const index = tickets.findIndex(item => item.ticketId === ticket.ticketId);
    if (index !== -1) {
        tickets[index] = ticket;
        saveTickets(tickets);
    }

    await interaction.reply({
        content: l("✅ Admin has been called.", "✅ تم تنبيه الإدارة."),
        flags: MessageFlags.Ephemeral
    });
    deleteReplyLater(interaction);

    await sendTemporaryChannelMessage(
        interaction.channel,
        {
            content: l(`<@&${ADMIN_ROLE_ID}> 🚨 ${interaction.user} needs an Admin in this ticket.`, `<@&${ADMIN_ROLE_ID}> 🚨 ${interaction.user} محتاج الإدارة في التيكت.`),
            allowedMentions: { roles: [ADMIN_ROLE_ID], users: [interaction.user.id] }
        },
        TEMP_MESSAGE_MS
    );
}

function getGameName(value) {
    const game = GAMES.find(item => item.value === value);
    return game ? game.label : (value || "Unknown");
}

function getPaymentName(value) {
    const payment = PAYMENT_METHODS.find(item => item.value === value);
    return payment ? payment.label : (value || "Unknown");
}

function getPayoutPlaceholder(payment, ticket = {}) {
    const l = ticketText(ticket);
    const placeholders = {
        vodafone: l("Vodafone Cash number, example: 010xxxxxxxx", "رقم فودافون كاش، مثال: 010xxxxxxxx"),
        instapay: l("InstaPay number or payment link", "رقم إنستاباي أو رابط الدفع"),
        orange: l("Orange Cash number, example: 012xxxxxxxx", "رقم أورانج كاش، مثال: 012xxxxxxxx"),
        etisalat: l("Etisalat Cash number, example: 011xxxxxxxx", "رقم اتصالات كاش، مثال: 011xxxxxxxx"),
        other: l("Write payment method + number/link/details", "اكتب طريقة الدفع والرقم أو الرابط والتفاصيل")
    };

    return placeholders[payment] || l("Number / link / payment details", "رقم / رابط / تفاصيل الدفع");
}



function isAdmin(interaction) {
    return (
        interaction.member.roles.cache.has(ADMIN_ROLE_ID) ||
        interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function isStaff(interaction) {
    return (
        interaction.member.roles.cache.has(STAFF_ROLE_ID) ||
        interaction.member.roles.cache.has(ADMIN_ROLE_ID) ||
        interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function addDays(date, days) {
    const newDate = new Date(date);
    newDate.setDate(newDate.getDate() + days);
    return newDate;
}

function discordTime(date, style = "R") {
    if (!date) return "—";

    const ms = new Date(date).getTime();
    if (Number.isNaN(ms)) return "—";

    const timestamp = Math.floor(ms / 1000);
    return `<t:${timestamp}:${style}>`;
}

function getStatusEmoji(status) {
    const statuses = {
        READY: "📋",
        CHANGES_REQUESTED: "✏️",
        PAID: "✅",
        RECEIVED: "📥",
        OPENED: "🟡",
        SEEN: "👀",
        SOLD: "🟢",
        WARRANTY: "🛡️",
        FUNDS_RELEASED: "💰",
        CLOSED: "🔴"
    };

    return statuses[status] || "⚪";
}

function getStatusLabel(status) {
    const labels = {
        READY: "READY FOR RECEIPT",
        CHANGES_REQUESTED: "CHANGES REQUESTED",
        PAID: "PAYOUT CONFIRMED",
        RECEIVED: "RECEIVED",
        OPENED: "OPENED",
        SEEN: "SEEN",
        SOLD: "SOLD / DELIVERED",
        WARRANTY: "WARRANTY / FUNDS ON HOLD",
        FUNDS_RELEASED: "FUNDS RELEASED",
        CLOSED: "CLOSED"
    };

    return labels[status] || status || "UNKNOWN";
}

// =====================================================
// PANEL
// =====================================================

function createPanelEmbed() {
    const available = getAvailableTickets();
    const ticketIndicator = getAvailabilityIndicator();

    const gameStockLines = GAMES
        .map(game =>
            `${getStockIndicator(game.stock)} **${game.label}** — ${game.stock} available` +
            (game.fixedPrice ? ` • 💰 ${game.fixedPrice}` : "")
        )
        .join("\n");

    return new EmbedBuilder()
        .setTitle("🎮 INFINITY STORE")
        .setDescription(
            "Welcome to **INFINITY Store**!\n\n" +
            "Select the game you want from the menu below.\n\n" +
            `${ticketIndicator} **Open ticket slots: ${available}/${MAX_TICKETS}**\n` +
            `🎫 **Up to ${MAX_OPEN_TICKETS_PER_USER} open tickets per user**\n\n` +
            "**Game Stock**\n" +
            (gameStockLines || "No games available.") +
            "\n\n🟢 10+  |  🟡 1-9  |  🔴 0\n\n" +
            "💳 **Payment Methods**\n" +
            "• Vodafone Cash\n" +
            "• InstaPay\n" +
            "• Orange Cash\n" +
            "• Etisalat Cash\n" +
            "• Other\n\n" +
            "🛡️ **Seller Warranty:** depends on game and account type, starting after Sold / Delivered. / مدة الضمان حسب اللعبة ونوع الحساب وتبدأ بعد البيع.\n" +
            "💰 Seller funds stay **ON HOLD** during the warranty.\n\n" +
            "📸 You can send account images inside your ticket after it opens."
        )
        .setColor(
            available <= 0
                ? 0xED4245
                : available < 10
                ? 0xFEE75C
                : 0x57F287
        )
        .setFooter({ text: "INFINITY Store • Ticket System" })
        .setTimestamp();
}

function createGameMenu() {
    if (GAMES.length === 0) {
        const empty = new StringSelectMenuBuilder()
            .setCustomId("select_game")
            .setPlaceholder("🔴 No games configured")
            .setDisabled(true)
            .addOptions([
                {
                    label: "No games available",
                    value: "no-games",
                    emoji: "🔴"
                }
            ]);

        return new ActionRowBuilder().addComponents(empty);
    }

    const options = GAMES.slice(0, 25).map(game => ({
        label: game.label,
        value: game.value,
        emoji: game.emoji || "🎮",
        description:
            game.stock <= 0
                ? "🔴 Out of stock"
                : `${getStockIndicator(game.stock)} ${game.stock} account(s) available`
    }));

    const select = new StringSelectMenuBuilder()
        .setCustomId("select_game")
        .setPlaceholder("🎮 Select a game")
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(getAvailableTickets() <= 0)
        .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
}

function createPaymentMenu() {
    const select = new StringSelectMenuBuilder()
        .setCustomId("select_payment")
        .setPlaceholder("💳 Select payment method")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(PAYMENT_METHODS);

    return new ActionRowBuilder().addComponents(select);
}

function ticketText(ticket) {
    return (english, arabic) => (ticket.language || ticket.lang) === "ar" ? arabic : english;
}

function createLanguageMenu() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId("select_language")
            .setPlaceholder("اختر اللغة / Choose language")
            .addOptions({ label: "English", value: "en" }, { label: "العربية", value: "ar" })
    );
}

function createQuantityMenu(ticket = {}) {
    const l = ticketText(ticket);
    const options = [];

    for (let i = 1; i <= 20; i += 1) {
        options.push({
            label: l(`${i} account${i === 1 ? "" : "s"}`, `${i} حساب`),
            value: String(i),
            emoji: i < 10 ? "📦" : "📚"
        });
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId("select_quantity")
        .setPlaceholder(l("📦 How many accounts will you deliver?", "📦 عدد الحسابات اللي هتسلمها؟"))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
}

// =====================================================
// CLIENT
// =====================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// =====================================================
// SLASH COMMANDS
// =====================================================

// Persist IDs independently from games.json so game normalization preserves them.
const gameLayoutJobs = new Map();
function gamePrivatePermissions(guild, includeStaff = false) {
    const flags=PermissionsBitField.Flags;
    const ids=[ADMIN_ROLE_ID,guild.members.me?.id || client.user.id];
    if(includeStaff) ids.push(STAFF_ROLE_ID);
    return [{id:guild.id,deny:[flags.ViewChannel]}, ...[...new Set(ids.filter(id=>id && id!==guild.id))].map(id=>({id,
        allow:[flags.ViewChannel,flags.SendMessages,flags.ReadMessageHistory,flags.AttachFiles,flags.EmbedLinks]}))];
}
async function ensureGameChannels(guild, gameId) {
    const key=`${guild.id}:${gameId}`;
    if(gameLayoutJobs.has(key)) return gameLayoutJobs.get(key);
    const job=(async()=>{
        const game=findGame(gameId);
        const label=game?.label || gameId;
        const layout={...(loadConfig().gameLayouts?.[key] || {})};
        layout.typeChannelIds={...layout.typeChannelIds};
        const persist=()=>{const config=loadConfig();config.gameLayouts={...config.gameLayouts,[key]:layout};saveConfig(config);};
        const channels=await guild.channels.fetch();
        async function category(field,name,permissions) {
            let channel=channels.get(layout[field]);
            if(channel && channel.type!==ChannelType.GuildCategory) throw Error("Saved game category has an invalid type");
            if(!channel) {
                channel=await guild.channels.create({name:name.slice(0,100),type:ChannelType.GuildCategory,permissionOverwrites:permissions});
                layout[field]=channel.id;persist();
            }
            return channel;
        }
        const flags=PermissionsBitField.Flags;
        const publicCategory=await category("publicCategoryId",`🎮 ${label}`,[{id:guild.id,allow:[flags.ViewChannel,flags.ReadMessageHistory]}]);
        const archive=await category("archiveCategoryId",`🔒 ${label} — الأرشيف`,gamePrivatePermissions(guild));
        await archive.permissionOverwrites.set(gamePrivatePermissions(guild));
        await archive.setPosition(publicCategory.position+1);
        async function textChannel(id,name,permissions) {
            let channel=channels.get(id);
            if(channel && channel.type!==ChannelType.GuildText) throw Error("Saved game channel has an invalid type");
            if(!channel) channel=await guild.channels.create({name:name.slice(0,100),type:ChannelType.GuildText,parent:publicCategory.id,permissionOverwrites:permissions});
            else {
                if(channel.name!==name.slice(0,100)) await channel.setName(name.slice(0,100));
                if(channel.parentId!==publicCategory.id) await channel.setParent(publicCategory.id,{lockPermissions:false});
                if(permissions) await channel.permissionOverwrites.set(permissions);
            }
            return channel;
        }
        let voice=channels.get(layout.voiceChannelId);
        if(voice && voice.type!==ChannelType.GuildVoice) throw Error("Saved voice channel has an invalid type");
        const voiceName=`🔊・${label}`.slice(0,100);
        if(!voice) {
            voice=await guild.channels.create({name:voiceName,type:ChannelType.GuildVoice,parent:publicCategory.id});
            layout.voiceChannelId=voice.id;persist();
        } else {
            if(voice.parentId!==publicCategory.id) await voice.setParent(publicCategory.id,{lockPermissions:true});
            if(voice.name!==voiceName) await voice.setName(voiceName);
        }
        const lookPermissions=[{id:guild.id,allow:[flags.ViewChannel,flags.ReadMessageHistory],
            deny:[flags.SendMessages,flags.SendMessagesInThreads,flags.CreatePublicThreads,flags.CreatePrivateThreads]},
            {id:client.user.id,allow:[flags.ViewChannel,flags.SendMessages,flags.ReadMessageHistory,flags.EmbedLinks,flags.MentionEveryone]}];
        const lookFor=await textChannel(layout.lookForChannelId,"🔎・look-for",lookPermissions);
        layout.lookForChannelId=lookFor.id;persist();
        const typeChannels=[];
        const typeEmojis={ranked:"🏆","rank-ready":"⚔️",skins:"🎨",general:"📦"};
        for(const type of game?.accountTypes || []) {
            const channel=await textChannel(layout.typeChannelIds[type.id],`${typeEmojis[type.id] || "🎮"}・${type.id}`);
            layout.typeChannelIds[type.id]=channel.id;persist();typeChannels.push(channel);
        }
        // Discord sorts voice and text in separate groups; look-for leads the text group.
        await voice.setPosition(0);
        await lookFor.setPosition(0);
        for(const [index,channel] of typeChannels.entries()) await channel.setPosition(index+1);

        return layout;
    })();
    gameLayoutJobs.set(key,job);
    try{return await job;}finally{gameLayoutJobs.delete(key);}
}

const SERVER_RULES = `وجودك معانا معناه التزامك بالقوانين دي، فاقراها قبل فتح أي تيكت 👇

### 🤝 الاحترام والتعامل
- احترم الجميع؛ ممنوع السب أو التنمر أو التهديد.
- ممنوع السبام، المنشن المتكرر، والإعلانات بدون إذن الإدارة.
- استخدم كل قناة للغرض المخصص ليها.

### 🎮 تسليم الحسابات
- سلّم حسابات تملكها ومسموح لك بالتصرف فيها؛ ممنوع الحسابات المسروقة.
- بيانات الحساب ومواصفاته لازم تكون صحيحة، مع توضيح أي حظر أو قيود أو مشاكل.
- راجع متطلبات إعلان **look-for** قبل التسليم: النوع، الرانك، السكنات، العدد والسعر.
- ممنوع تسليم نفس الحساب في أكتر من تيكت أو بيعه لأكتر من شخص.
- **متكتبش بيانات الدخول أو الباسورد في القنوات العامة**؛ استخدم نموذج التسليم داخل التيكت.

### 💰 الأسعار والتحويلات
- اتأكد من السعر وشروط الاتفاق مع الإدارة قبل إتمام التسليم.
- اكتب وسيلة استلام الفلوس وبياناتها بدقة، وبلّغ الإدارة فورًا لو فيها خطأ.
- ممنوع تزوير إيصالات الدفع أو الادعاء بإتمام تحويل لم يحصل.
- تابع الاتفاق والدفع داخل التيكت عشان تفاصيل العملية تبقى موثّقة.

### 🛡️ الضمان
- مدة الضمان وموعد استحقاق المبلغ حسب التفاصيل الموضحة في التيكت والاتفاق مع الإدارة.
- ممنوع استرجاع الحساب أو تغيير بياناته أو استخدامه بعد التسليم بدون موافقة الإدارة.
- لو ظهرت مشكلة خلال الضمان، تعاون مع الإدارة وقدّم المعلومات المطلوبة لحلها.

### 🎫 التيكتات والمساعدة
- افتح التيكت في اللعبة والنوع المناسبين، ومتفتحش تيكتات مكررة لنفس الطلب.
- انتظر رد الإدارة واستخدم زر استدعائها باعتدال.
- لو عندك شكوى، وضّح المشكلة وقدّم الأدلة داخل التيكت، مع إخفاء بياناتك الحساسة من أي صور عامة.

⚠️ **مخالفة القوانين ممكن تؤدي لتحذير أو تقييد أو حظر حسب نوع المخالفة وتكرارها.**

✨ **شكرًا لالتزامك، ونتمنى لك تجربة موفقة معانا!**`;

const commands = [
    new SlashCommandBuilder().setName("set-type-price").setDescription("Admin: set the price PER ACCOUNT for a type")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addStringOption(o=>o.setName("type").setDescription("Account type name or ID").setRequired(true))
        .addStringOption(o=>o.setName("price").setDescription("Per account, e.g. 500 EGP or 10 USD").setRequired(true).setMaxLength(100)).toJSON(),
    new SlashCommandBuilder().setName("clear-type-price").setDescription("Admin: remove a type price override")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addStringOption(o=>o.setName("type").setDescription("Account type name or ID").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("remove-account-type").setDescription("Admin: remove one account type; archive its channel")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addStringOption(o=>o.setName("type").setDescription("Account type name or ID").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("send-rules").setDescription("Admin: publish the server rules as the bot")
        .addChannelOption(o=>o.setName("channel").setDescription("Rules channel; defaults to this channel")
            .addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement)).toJSON(),

    new SlashCommandBuilder().setName("setup-game-channels").setDescription("Admin: create or repair game channels")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("look-for").setDescription("Admin: post a free-text account request in English")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addStringOption(o=>o.setName("request").setDescription("Write your request in English: Need 7 rank-ready Marvel accounts...").setRequired(true).setMinLength(1).setMaxLength(1200))
        .addUserOption(o=>o.setName("member").setDescription("Member to mention; defaults to you"))
        .addRoleOption(o=>o.setName("role").setDescription("Optional Sellers role to mention"))
        .addStringOption(o=>o.setName("warning-url").setDescription("Optional Discord rules/warning message link").setMaxLength(200)).toJSON(),

    new SlashCommandBuilder().setName("set-sales")
        .setDescription("Admin: set a user's total sold account count")
        .addUserOption(o=>o.setName("user").setDescription("Account owner").setRequired(true))
        .addIntegerOption(o=>o.setName("count").setDescription("New total sold accounts (not an increment)").setMinValue(0).setMaxValue(1000000).setRequired(true)).toJSON(),

    new SlashCommandBuilder().setName("set-warranty").setDescription("Admin: set warranty days for a game or account type")
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addIntegerOption(o=>o.setName("days").setDescription("Warranty days; 0 means immediate payment eligibility").setMinValue(0).setMaxValue(365).setRequired(true))
        .addStringOption(o=>o.setName("type").setDescription("Optional type name or ID, for example skins")).toJSON(),
    new SlashCommandBuilder().setName("add-account-type").setDescription("Admin: add an account type to one game")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addStringOption(o=>o.setName("name").setDescription("English type name").setRequired(true).setMaxLength(80))
        .addIntegerOption(o=>o.setName("stock").setDescription("Initial quantity").setMinValue(0).setMaxValue(1000000).setRequired(true))
        .addStringOption(o=>o.setName("name-ar").setDescription("Arabic type name").setMaxLength(80)).toJSON(),
    ...["set-type-stock","add-type-stock"].map(name=>new SlashCommandBuilder().setName(name)
        .setDescription(name==="set-type-stock"?"Admin: set a type's total available quantity":"Admin: add quantity to one account type")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true))
        .addStringOption(o=>o.setName("type").setDescription("Type name or ID, for example ranked").setRequired(true))
        .addIntegerOption(o=>o.setName("quantity").setDescription("Quantity").setMinValue(0).setMaxValue(1000000).setRequired(true)).toJSON()),
    new SlashCommandBuilder().setName("account-types").setDescription("Admin: list a game's account types and quantities")
        .addStringOption(o=>o.setName("game").setDescription("Game name or ID").setRequired(true)).toJSON(),
    new SlashCommandBuilder().setName("admin-summary").setDescription("Admin: per-game account summary").toJSON(),
    new SlashCommandBuilder().setName("audit-log").setDescription("Admin: recent stock and ticket actions")
        .addStringOption(o => o.setName("game").setDescription("Optional game name or ID")).toJSON(),
    new SlashCommandBuilder()
        .setName("set-delivery-info")
        .setDescription("Admin: customize required delivery information for one game")
        .addStringOption(option => option.setName("game")
            .setDescription("Game name or ID, for example valorant")
            .setRequired(true))
        .addStringOption(option => option.setName("type")
            .setDescription("Optional account type, for example skins"))
        .toJSON(),
    new SlashCommandBuilder()
        .setName("setup-ticket")
        .setDescription("Create the permanent INFINITY Store ticket panel")
        .toJSON(),

    new SlashCommandBuilder()
        .setName("add-game")
        .setDescription("Admin: add a game and its stock")
        .addStringOption(option =>
            option
                .setName("name")
                .setDescription("Game name")
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("stock")
                .setDescription("Available account quantity")
                .setMinValue(0)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("emoji")
                .setDescription("Optional emoji, example: 🎮")
                .setRequired(false)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("set-stock")
        .setDescription("Admin: change a game's available quantity")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("stock")
                .setDescription("New available quantity")
                .setMinValue(0)
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("set-price")
        .setDescription("Admin: set a fixed price for a game")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("price")
                .setDescription("Fixed price, example: 500 EGP")
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("clear-price")
        .setDescription("Admin: remove a game's fixed price")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("set-game-message")
        .setDescription("Admin: set a custom message for one game")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("message")
                .setDescription("Message to show for this game")
                .setMaxLength(1900)
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("clear-game-message")
        .setDescription("Admin: remove a game's custom message")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("send-game-message")
        .setDescription("Admin: send a game's saved message in this channel")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("remove-game")
        .setDescription("Admin: remove a game")
        .addStringOption(option =>
            option
                .setName("game")
                .setDescription("Exact game name")
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("games")
        .setDescription("Show all games and current stock")
        .toJSON(),

    new SlashCommandBuilder()
        .setName("set-rank")
        .setDescription("Admin: manually set a seller rank")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Seller")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("rank")
                .setDescription("Rank to give, or AUTO")
                .setRequired(true)
                .addChoices(
                    { name: "AUTO", value: "auto" },
                    { name: "SILVER", value: "silver" },
                    { name: "EPIC", value: "epic" },
                    { name: "GOLD", value: "gold" },
                    { name: "LEGENDARY", value: "legendary" },
                    { name: "TRUSTED", value: "trusted" },
                    { name: "NONE", value: "none" }
                )
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName("ticket-admin")
        .setDescription("Staff: open private ticket controls")
        .toJSON(),

    new SlashCommandBuilder()
        .setName("seller-stats")
        .setDescription("Check seller rank and delivered accounts")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Select seller")
                .setRequired(false)
        )
        .toJSON()
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

// =====================================================
// READY
// =====================================================

client.once(Events.ClientReady, async readyClient => {
    console.log(`✅ Logged in as ${readyClient.user.username}`);

    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );

        console.log("✅ Slash commands registered!");
    } catch (error) {
        console.error("❌ Slash command error:", error);
    }

    readyClient.user.setActivity("🎮 INFINITY Store");
});

// =====================================================
// UPDATE PANEL
// =====================================================

async function updatePanel(guild) {
    const config = loadConfig();

    if (!config.panelChannelId || !config.panelMessageId) {
        return;
    }

    try {
        const channel = await guild.channels.fetch(config.panelChannelId);
        if (!channel || !channel.isTextBased()) return;

        const message = await channel.messages.fetch(config.panelMessageId);

        await message.edit({
            embeds: [createPanelEmbed()],
            components: [createGameMenu()]
        });
    } catch (error) {
        console.log("⚠️ Could not update panel:", error.message);
    }
}

// =====================================================
// SELLER RANK
// =====================================================

function getSellerRank(count) {
    return RANKS.find(rank => count >= rank.accounts) || null;
}

function getRankByKey(key) {
    return RANKS.find(rank => rank.key === String(key).toLowerCase()) || null;
}

function getSellerData(userId) {
    const sellers = loadSellers();
    const seller = sellers[userId] || {
        delivered: 0,
        rank: null,
        manualRank: null
    };

    const delivered = seller.delivered || 0;

    let rank = null;
    let rankMode = "AUTO";

    if (seller.manualRank === "none") {
        rank = null;
        rankMode = "MANUAL";
    } else if (seller.manualRank) {
        rank = getRankByKey(seller.manualRank);
        rankMode = "MANUAL";
    } else {
        rank = getSellerRank(delivered);
    }

    return {
        delivered,
        rank,
        rankMode
    };
}

async function updateSellerRank(guild, userId) {
    const sellers = loadSellers();

    if (!sellers[userId]) {
        sellers[userId] = {
            delivered: 0,
            rank: null,
            manualRank: null,
            updatedAt: null
        };
    }

    const seller = sellers[userId];
    const count = seller.delivered || 0;

    let rank = null;

    if (seller.manualRank === "none") {
        rank = null;
    } else if (seller.manualRank) {
        rank = getRankByKey(seller.manualRank);
    } else {
        rank = getSellerRank(count);
    }

    const member = await guild.members.fetch(userId).catch(() => null);

    if (!member) {
        return rank;
    }

    const botMember = guild.members.me || await guild.members.fetchMe();
    await guild.roles.fetch();
    const affectedRoles = RANKS.filter(r => member.roles.cache.has(r.roleId) || (rank && rank.roleId === r.roleId));
    const blockedRole = affectedRoles.find(r => !guild.roles.cache.get(r.roleId)?.editable);
    if (affectedRoles.length && (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) || blockedRole)) {
        console.warn("⚠️ Rank not applied: enable Manage Roles and place the bot role above all seller rank roles.");
        return { ...(rank || {}), display: `${rank ? rank.display : "No Rank"} ⚠️ role not applied (Manage Roles / role order)`, roleUpdateFailed: true };
    }

    // Add the target first so a failed grant does not remove the current rank.
    if (rank && !member.roles.cache.has(rank.roleId)) {
        try { await member.roles.add(rank.roleId); }
        catch (error) {
            console.warn("⚠️ Rank not applied:", error.message);
            return { ...rank, display: `${rank.display} ⚠️ role not applied`, roleUpdateFailed: true };
        }
    }
    let removalFailed = false;
    // Remove all other rank roles by exact role ID
    for (const rankData of RANKS) {
        if (
            member.roles.cache.has(rankData.roleId) &&
            (!rank || rankData.roleId !== rank.roleId)
        ) {
            await member.roles.remove(rankData.roleId).catch(error => {
                removalFailed = true;
                console.log("⚠️ Could not remove rank:", error.message);
            });
        }
    }

    if (removalFailed) return { ...(rank || {}), display: `${rank ? rank.display : "No Rank"} ⚠️ previous role removal failed`, roleUpdateFailed: true };

    if (!rank) {
        const latestSellers=loadSellers();
        if (latestSellers[userId]) latestSellers[userId].rank=null;
        saveSellers(latestSellers);
        return null;
    }

    const latestSellers=loadSellers();
    if (latestSellers[userId]) latestSellers[userId].rank=rank.display;
    saveSellers(latestSellers);
    sheetsLog("Sellers", {
        userId,
        delivered: count,
        rank: rank ? rank.display : "No Rank",
        rankMode: seller.manualRank ? "manual" : "auto",
        updatedAt: new Date().toISOString()
    });

    return rank;
}

async function setManualSellerRank(guild, userId, rankKey) {
    const sellers = loadSellers();

    if (!sellers[userId]) {
        sellers[userId] = {
            delivered: 0,
            rank: null,
            manualRank: null,
            updatedAt: null
        };
    }

    if (rankKey === "auto") {
        sellers[userId].manualRank = null;
    } else if (rankKey === "none") {
        sellers[userId].manualRank = "none";
    } else {
        const rank = getRankByKey(rankKey);

        if (!rank) {
            throw new Error("Unknown rank");
        }

        sellers[userId].manualRank = rank.key;
    }

    sellers[userId].updatedAt = new Date().toISOString();
    saveSellers(sellers);

    return updateSellerRank(guild, userId);
}

async function addDeliveredAccount(guild, userId, amount = 1) {
    const sellers = loadSellers();

    if (!sellers[userId]) {
        sellers[userId] = {
            delivered: 0,
            rank: null,
            manualRank: null,
            updatedAt: null
        };
    }

    sellers[userId].delivered += Math.max(1, Number(amount) || 1);
    sellers[userId].updatedAt = new Date().toISOString();

    saveSellers(sellers);

    const rank = await updateSellerRank(guild, userId);

    return {
        count: sellers[userId].delivered,
        rank
    };
}

// =====================================================
// ADMIN NEW TICKET ALERT
// =====================================================

async function sendAdminNewTicketAlert(guild, ticket, channel, submitted = false) {
    try {
        const role = await guild.roles.fetch(ADMIN_ROLE_ID).catch(() => null);

        if (!role) {
            console.log("⚠️ Admin role not found:", ADMIN_ROLE_ID);
            return;
        }


        const embed = new EmbedBuilder()
            .setTitle(submitted ? "📥 Accounts submitted — ready for review / حسابات جاهزة للاستلام" : "🚨 New Ticket Opened")
            .setColor(0xFEE75C)
            .addFields(
                {
                    name: "👤 Customer",
                    value: `<@${ticket.userId}>`,
                    inline: true
                },
                {
                    name: "🎮 Game",
                    value: getGameName(ticket.game),
                    inline: true
                },
                {
                    name: "🔢 Quantity",
                    value: `${ticket.quantity || 1} ACC`,
                    inline: true
                },
                {
                    name: "💰 Price",
                    value: ticket.price || "—",
                    inline: true
                },
                {
                    name: "💳 Receive Money By",
                    value: ticket.paymentDisplay || getPaymentName(ticket.payment),
                    inline: true
                },
                {
                    name: "📲 Number / Link",
                    value: ticket.payoutDetails || "—",
                    inline: true
                },
                {
                    name: "🎫 Ticket",
                    value: `${channel}`,
                    inline: true
                }
            )
            .setFooter({ text: "INFINITY Store • Admin Alert" })
            .setTimestamp();

        for (const member of role.members.values()) {
            if (member.user.bot) continue;

            await member.send({
                content: submitted ? "📥 راجع الحسابات ثم اضغط استلام الحساب من /ticket-admin. Review the accounts and use Receive Account in /ticket-admin." : "🚨 A new ticket has been opened.",
                embeds: [embed]
            }).catch(() => {});
        }
    } catch (error) {
        console.log("⚠️ Admin DM alert error:", error.message);
    }
}

// =====================================================
// TICKET EMBED
// =====================================================

function createTicketEmbed(ticket) {
    const l = ticketText(ticket);
    const status = ticket.status || "OPENED";
    const description = String(ticket.description || "—").substring(0, 1024);
    const accountCount = Array.isArray(ticket.accounts) ? ticket.accounts.filter(Boolean).length : 0;

    let color = 0xF0B232;

    if (status === "CLOSED") color = 0xED4245;
    if (status === "SEEN") color = 0xFEE75C;
    if (status === "SOLD") color = 0x57F287;
    if (status === "WARRANTY") color = 0x5865F2;
    if (status === "FUNDS_RELEASED") color = 0x57F287;

    const embed = new EmbedBuilder()
        .setTitle(l(`${getStatusEmoji(status)} ${getGameName(ticket.game)} Ticket`, `${getStatusEmoji(status)} تيكت ${getGameName(ticket.game)}`))
        .setColor(color)
        .addFields(
            {
                name: l("👤 Customer", "👤 صاحب التيكت"),
                value: ticket.userId
                    ? `<@${ticket.userId}>\nID: \`${ticket.userId}\``
                    : "—",
                inline: true
            },
            {
                name: l("🎮 Game", "🎮 اللعبة"),
                value: `\`${getGameName(ticket.game)}\``,
                inline: true
            },
            {
                name: l("📊 Status", "📊 الحالة"),
                value: `${getStatusEmoji(status)} **${l(getStatusLabel(status), ({ READY: "جاهز للاستلام", CHANGES_REQUESTED: "مطلوب تعديل البيانات", PAID: "تم تحويل الفلوس", RECEIVED: "تم الاستلام", OPENED: "مفتوح", SEEN: "تمت المشاهدة", SOLD: "تم البيع", WARRANTY: "الضمان — المبلغ معلّق", FUNDS_RELEASED: "المبلغ جاهز للصرف", CLOSED: "مقفول" })[status] || status)}**`,
                inline: true
            },
            {
                name: l("💳 Receive Money By", "💳 استلام الفلوس عن طريق"),
                value: `\`${ticket.paymentDisplay || getPaymentName(ticket.payment)}\``,
                inline: true
            },
            {
                name: l("📲 Payment Number / Link", "📲 رقم / رابط استلام الفلوس"),
                value: `\`${ticket.payoutDetails || "—"}\``,
                inline: true
            },
            {
                name: l("☎️ Contact Number", "☎️ رقم التواصل"),
                value: `\`${ticket.contactPhone || l("Not provided", "غير محدد")}\``,
                inline: true
            },
            {
                name: l("🏷️ Account Type", "🏷️ نوع الحساب"),
                value: `\`${ticket.accountType || "—"}\``,
                inline: true
            },
            {
                name: l("💰 Price", "💰 السعر"),
                value: `\`${ticket.price || "—"}\`${ticket.fixedPrice ? " • 🔒 Fixed" : ""}`,
                inline: true
            },
            {
                name: l("📦 Quantity", "📦 الكمية"),
                value: `\`${ticket.quantity || 1} ACC\``,
                inline: true
            },
            {
                name: l("🔐 Account Data", "🔐 بيانات الحساب"),
                value: l(`\`${accountCount}/${ticket.quantity || 1} account(s) completed\`\nCredentials are hidden from the channel.`, `\`${accountCount}/${ticket.quantity || 1} حساب مكتمل\`\nبيانات الدخول مخفية من الروم.`),
                inline: true
            },
            {
                name: l("📸 Images", "📸 الصور"),
                value:
                    ticket.images && ticket.images.length
                        ? l(`\`${ticket.images.length} image(s) saved\``, `\`${ticket.images.length} صورة محفوظة\``)
                        : l("Send images in this ticket", "ابعت صور الحساب هنا"),
                inline: true
            },
            {
                name: l("📄 Description", "📄 الوصف"),
                value: description
            }
        )
        .setFooter({ text: "INFINITY Store • Ticket System" })
        .setTimestamp(new Date(ticket.createdAt || Date.now()));

    if (ticket.accountRank) embed.addFields({name:l("🏆 Account rank","🏆 رتبة الحساب"),value:ticket.accountRank,inline:true});
    if (ticket.skinCount) embed.addFields({name:l("🎨 Skins","🎨 السكنات"),value:`${ticket.skinCount}\n${ticket.skinDetails || ""}`.slice(0,1024)});
    if (ticket.seenBy) {
        embed.addFields({
            name: l("👀 Seen By", "👀 شاهده"),
            value: `<@${ticket.seenBy}>`,
            inline: true
        });
    }

    if (ticket.sellerId) {
        const sellerData = getSellerData(ticket.sellerId);

        embed.addFields(
            {
                name: l("🏪 Seller", "🏪 البائع"),
                value: `<@${ticket.sellerId}>`,
                inline: true
            },
            {
                name: l("🏆 Seller Rank", "🏆 رتبة البائع"),
                value: sellerData.rank
                    ? `${sellerData.rank.display}\n${sellerData.delivered} ACC`
                    : `No Rank\n${sellerData.delivered} ACC`,
                inline: true
            }
        );
    }

    if (ticket.soldAt) {
        embed.addFields({
            name: l("🟢 Sold / Delivered", "🟢 تم البيع / التسليم"),
            value: discordTime(ticket.soldAt),
            inline: true
        });
    }

    if (ticket.warrantyStartedAt && ticket.warrantyEndsAt) {
        const released = Boolean(ticket.fundsReleasedAt) || payoutReady(ticket);

        embed.addFields(
            {
                name: l("🛡️ Warranty", "🛡️ الضمان"),
                value: released
                    ? l("✅ **COMPLETED**", "✅ **مكتمل**")
                    : l(`🟡 **ACTIVE — ${ticketWarrantyDays(ticket)} DAYS**`, `🟡 **نشط — ${ticketWarrantyDays(ticket)} أيام**`),
                inline: true
            },
            {
                name: l("💰 Funds", "💰 المبلغ"),
                value: released
                    ? (ticket.paidAt ? l("✅ **PAID**", "✅ **تم التحويل**") : l("✅ **READY FOR PAYOUT**", "✅ **جاهز للصرف**"))
                    : l("🔒 **ON HOLD**", "🔒 **معلّق**"),
                inline: true
            },
            {
                name: l("⏳ Release Time", "⏳ موعد إتاحة المبلغ"),
                value: released
                    ? discordTime(ticket.fundsReleasedAt)
                    : `${discordTime(ticket.warrantyEndsAt)}\n${discordTime(ticket.warrantyEndsAt, "F")}`,
                inline: false
            }
        );
    }

    if (ticket.lastModifiedAt) {
        embed.addFields({name:l("Last account update", "آخر تعديل للحساب"),
            value:discordTime(ticket.lastModifiedAt, "F") + "\n" + (ticket.correction ? l("Awaiting admin receipt", "بانتظار تأكيد استلام الإدارة") : l("Confirmed by admin", "تم تأكيد الاستلام بواسطة الإدارة"))});
    }
    if (ticket.images && ticket.images.length > 0) {
        embed.setImage(ticket.images[0].url);
    }

    return embed;
}

// =====================================================
// CUSTOMER DM STATUS
// =====================================================

async function sendTicketStatusDM(ticket, guild, extraText = null) {
    if (!ticket.userId) return;

    try {
        const user = await client.users.fetch(ticket.userId);
        const english = (ticket.language || ticket.lang) !== "ar";
        const text = (ar, en) => english ? en : ar;
        const ticketUrl = `https://discord.com/channels/${guild.id}/${ticket.ticketId}`;
        const ticketLink = `[${text("فتح التيكت", "Open ticket")}](${ticketUrl})`;

        // Only the creation notification includes the full order summary.
        if (ticket.status !== "OPENED") {
            const updates = {
                SEEN: text("👀 الإدارة شافت التيكت.", "👀 Staff have seen your ticket."),
                RECEIVED: text("📥 تم استلام حساباتك.", "📥 Your accounts have been received."),
                SOLD: text(
                    `✅ حساباتك اتباعت وبدأ ضمان ${ticketWarrantyDays(ticket)} أيام. المبلغ معلّق لحد انتهاء الضمان.`,
                    `✅ Accounts sold. Your ${ticketWarrantyDays(ticket)}-day warranty has started; funds are on hold.`
                ),
                WARRANTY: text(
                    `✅ حساباتك اتباعت وبدأ ضمان ${ticketWarrantyDays(ticket)} أيام. المبلغ معلّق لحد انتهاء الضمان.`,
                    `✅ Accounts sold. Your ${ticketWarrantyDays(ticket)}-day warranty has started; funds are on hold.`
                ),
                FUNDS_RELEASED: text(
                    "💰 انتهى الضمان والمبلغ جاهز للصرف.",
                    "💰 Warranty completed. Funds are ready for payout."
                ),
                CLOSED: text(
                    `🔒 التيكت اتقفل وهيتحذف بعد ${CLOSED_TICKET_RETENTION_DAYS} يوم.`,
                    `🔒 Ticket closed. It will be deleted in ${CLOSED_TICKET_RETENTION_DAYS} days.`
                )
            };
            await user.send({
                content: `${updates[ticket.status] || text("🎫 تم تحديث حالة التيكت.", "🎫 Ticket status updated.")}\n${ticketLink}`,
                allowedMentions: { parse: [] }
            });
            return;
        }

        const sellerData = getSellerData(ticket.userId);
        const rankText = sellerData.rank ? sellerData.rank.display : text("بدون رتبة", "No Rank");
        const field = (name, value) => ({ name, value: String(value || "—").slice(0, 1024), inline: true });
        const embed = new EmbedBuilder()
            .setTitle(text("🎫 تم فتح التيكت • INFINITY Store", "🎫 Ticket created • INFINITY Store"))
            .setColor(0x5865F2)
            .setDescription(ticketLink)
            .addFields(
                field(text("📊 الحالة", "📊 Status"), text("🟡 مفتوح — في انتظار الإدارة", "🟡 Open — awaiting staff")),
                field(text("🎮 اللعبة", "🎮 Game"), getGameName(ticket.game)),
                field(text("💰 السعر", "💰 Price"), ticket.price),
                field(text("📦 الكمية", "📦 Quantity"), `${ticket.quantity || 1} ${text("حساب", "account(s)")}`),
                field(text("🏆 رتبتك", "🏆 Your rank"), rankText),
                field(text("💳 طريقة استلام الفلوس", "💳 Payout method"), ticket.paymentDisplay || getPaymentName(ticket.payment)),
                field(text("📲 رقم / رابط الاستلام", "📲 Payout number / link"), ticket.payoutDetails)
            )
            .setFooter({ text: "INFINITY Store" })
            .setTimestamp();

        await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        console.log(`⚠️ Could not DM customer ${ticket.userId}:`, error.message);
    }
}
// =====================================================
// BUYER PRIVATE DELIVERY
// =====================================================

function createAccountSlotMenu(ticket) {
    const l = ticketText(ticket);
    const quantity = Math.min(20, Math.max(1, Number(ticket.quantity) || 1));
    const accounts = Array.isArray(ticket.accounts) ? ticket.accounts : [];
    const options = [];

    for (let i = 0; i < quantity; i += 1) {
        options.push({
            label: l(`Account ${i + 1}`, `الحساب ${i + 1}`),
            value: String(i),
            description: accounts[i] ? l("✅ Data already saved - edit it", "✅ البيانات محفوظة — اضغط للتعديل") : l("📝 Add account data", "📝 إضافة بيانات الحساب"),
            emoji: accounts[i] ? "✅" : "🔐"
        });
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(`account_slot:${ticket.ticketId}`)
        .setPlaceholder(l("Select which account to add / edit", "اختار الحساب للإضافة أو التعديل"))
        .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
}

function ticketBuyerIds(ticket) {
    const values=Array.isArray(ticket.buyerIds) ? ticket.buyerIds : ticket.buyerId ? [ticket.buyerId] : [];
    return [...new Set(values.filter(id=>typeof id === "string" && id.length>0))];
}

function createBuyerMenu(ticket) {
    const select = new UserSelectMenuBuilder()
        .setCustomId(`set_buyer:${ticket.ticketId}`)
        .setPlaceholder("Select buyers / اختر المشترين")
        .setMinValues(0)
        .setMaxValues(25)
        .setDefaultUsers(...ticketBuyerIds(ticket).slice(0,25));

    return new ActionRowBuilder().addComponents(select);
}

// =====================================================
// STAFF BUTTONS
// =====================================================

function createPublicTicketButtons(ticket = {}) {
    const l = ticketText(ticket);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("ticket_account_data")
                .setLabel(l("Submit Account", "تسليم حساب"))
                .setEmoji("🔐")
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId("ticket_call_admin")
                .setLabel(l("Call Admin", "نداء الإدارة"))
                .setEmoji("🚨")
                .setStyle(ButtonStyle.Secondary)

        )
    ];
}

function createPrivateStaffButtons(ticket) {
    const l = ticketText(ticket || {});
    const firstRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_receive")
            .setLabel(l("Receive Account", "استلام الحساب"))
            .setEmoji("📥").setStyle(ButtonStyle.Success)
            .setDisabled(Boolean(ticket?.closedAt || ticket?.status === "CHANGES_REQUESTED" || ((ticket?.receivedAt || ticket?.soldAt) && !ticket?.correction?.awaitingConfirmation))),
        new ButtonBuilder()
            .setCustomId("ticket_seen")
            .setLabel("Seen")
            .setEmoji("👀")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId("ticket_set_buyer")
            .setLabel(ticket && ticketBuyerIds(ticket).length ? "Manage Buyers" : "Set Buyers (Optional)")
            .setEmoji("🛒")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId("ticket_sold")
            .setLabel(l("Sold / Delivered", "تم البيع / التسليم"))
            .setEmoji("🟢")
            .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
            .setCustomId("ticket_close")
            .setLabel("Close Ticket")
            .setEmoji("🔒")
            .setStyle(ButtonStyle.Danger)
    );

    const secondRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_request_edit").setLabel(l("Request correction", "طلب تعديل البيانات"))
            .setStyle(ButtonStyle.Secondary).setDisabled(Boolean(ticket?.closedAt || ticket?.paidAt || ticket?.correction)),
        new ButtonBuilder().setCustomId("ticket_paid").setLabel(l("Confirm payout", "تم تحويل الفلوس"))
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket_buyer_paid").setLabel(l("Confirm buyer payment", "تأكيد دفع المشتري")).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket_admin_refresh")
            .setLabel(l("Refresh controls", "تحديث لوحة الإدارة"))
            .setStyle(ButtonStyle.Secondary)
    );
    return [firstRow, secondRow];
}

// =====================================================
// REFRESH TICKET MESSAGE
// =====================================================

async function refreshTicket(channel, ticket) {
    if (!ticket.ticketMessageId) return;

    try {
        const message = await channel.messages.fetch(ticket.ticketMessageId);

        await message.edit({
            embeds: [createTicketEmbed(ticket)],
            components: createPublicTicketButtons(ticket)
        });
    } catch (error) {
        console.log("⚠️ Ticket refresh error:", error.message);
    }
}

// =====================================================
// INTERACTIONS
// =====================================================

// Buyer settlement is shared by the entire order and independent of seller payout.
function buyerFinancialOrders(buyerId) {
    return loadTickets().filter(t=>ticketBuyerIds(t).includes(buyerId) && (t.receivedAt || t.soldAt));
}
function buyerMoney(price) {
    const value=String(price ?? "").trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,".");
    // Ambiguous separators/ranges are deliberately excluded from totals.
    const match=value.match(/^([^\d.,]*?)\s*(\d+(?:\.\d{1,2})?)\s*([^\d.,]*)$/u);
    if (!match || (match[1].trim() && match[3].trim())) return null;
    const raw=(match[1] || match[3]).trim().toUpperCase();
    const aliases={"$":"USD","دولار":"USD","€":"EUR","يورو":"EUR","جنيه":"EGP","جنيه مصري":"EGP","ج.م":"EGP","ر.س":"SAR","ريال":"SAR"};
    const currency=aliases[raw] || raw || "عملة غير محددة / Unspecified currency";
    if(raw && !aliases[raw] && !/^[A-Z]{3}$/.test(raw)) return null;
    const [whole,fraction=""]=match[2].split(".");
    const cents=Number(whole)*100+Number(fraction.padEnd(2,"0"));
    return Number.isSafeInteger(cents) ? {cents,currency} : null;
}
function buyerDueAt(ticket) {
    const at=ticket.soldAt && ticket.warrantyEndsAt ? Date.parse(ticket.warrantyEndsAt) : NaN;
    return Number.isFinite(at) ? at : null;
}
function buyerPaymentStatus(ticket) {
    if(ticket.buyerPayment?.paidAt) return "مدفوع للجميع / Paid for all buyers";
    const due=buyerDueAt(ticket);
    if(due===null) return "موعد الدفع لم يتحدد / Payment date pending";
    if(due<=Date.now()) return "مستحق الدفع الآن / Due now";
    const minutes=Math.ceil((due-Date.now())/60000);
    return `في الضمان / Warranty: ${Math.floor(minutes/1440)}d ${Math.floor(minutes%1440/60)}h ${minutes%60}m — موعد الدفع / Due: ${new Date(due).toISOString()}`;
}
async function sendBuyerFinances(channel,buyerId,command) {
    if(channel.type!==ChannelType.DM) return;
    const orders=buyerFinancialOrders(buyerId);
    if(!orders.length) return channel.send({content:"لا توجد طلبات مسجلة لك / No orders assigned to you."});
    const lines=[];
    if(command==="orders") {
        for(const t of orders) lines.push(`Order: ${t.ticketId} | ${getGameName(t.game)} | ${t.quantity || 1} ACC\nإجمالي الطلب / Order total: ${t.price ?? "غير محدد / Not set"}\n${buyerPaymentStatus(t)}\n`);
    } else {
        const totals=new Map();let unknown=0;
        for(const t of orders.filter(t=>!t.buyerPayment?.paidAt)) {
            const money=buyerMoney(t.price);
            if(!money){unknown++;continue;}
            const row=totals.get(money.currency) || {total:0,due:0};
            row.total+=money.cents;
            if(buyerDueAt(t)!==null && buyerDueAt(t)<=Date.now()) row.due+=money.cents;
            if(!Number.isSafeInteger(row.total)) throw new Error("Buyer balance exceeds supported precision");
            totals.set(money.currency,row);
        }
        lines.push("إجمالي غير المدفوع يشمل الطلبات داخل الضمان / Unpaid total includes orders under warranty.");
        for(const [currency,row] of totals) lines.push(`${currency}: الإجمالي / Total ${(row.total/100).toFixed(2)} | المستحق الآن / Due now ${(row.due/100).toFixed(2)}`);
        if(!totals.size && !unknown) lines.push("لا توجد مبالغ غير مدفوعة / Nothing outstanding.");
        if(unknown) lines.push(`⚠️ ${unknown} طلب بسعر غير محدد أو غير واضح غير محسوب في الإجمالي؛ اكتب orders / Orders with unclear prices excluded; type orders.`);
    }
    lines.push("المبلغ مشترك بين المشترين؛ دفع أحدهم يسدد التيكت للجميع / One buyer's payment settles the order for all.");
    const content=lines.join("\n");
    await channel.send(content.length<=1900 ? {content,allowedMentions:{parse:[]}} : {content:"تفاصيل طلباتك / Your order report",files:[{attachment:Buffer.from(content,"utf8"),name:`${command}.txt`}],allowedMentions:{parse:[]}});
}
let checkingBuyerPayments=false;
const buyerReminderRetry=new Map();
async function remindBuyerPayments() {
    if(checkingBuyerPayments) return;
    checkingBuyerPayments=true;
    try {
        const allTickets=loadTickets();
        for(const snapshot of allTickets) {
            for(const buyerId of ticketBuyerIds(snapshot)) {
                const ticket=snapshot;
                const key=`${snapshot.ticketId}:${buyerId}`;
                if(!ticket || ticket.buyerPayment?.paidAt || buyerDueAt(ticket)===null || buyerDueAt(ticket)>Date.now() || ticket.buyerPayment?.notified?.[buyerId] || (buyerReminderRetry.get(key)||0)>Date.now()) continue;
                buyerReminderRetry.set(key,Date.now()+60*60*1000);
                try {
                    const user=await client.users.fetch(buyerId);
                    const fresh=loadTickets();const current=fresh.find(t=>t.ticketId===snapshot.ticketId);
                    if(!current || current.buyerPayment?.paidAt || !ticketBuyerIds(current).includes(buyerId) || buyerDueAt(current)===null || buyerDueAt(current)>Date.now()) continue;
                    await user.send({content:`⏰ انتهى ضمان الطلب ${current.ticketId}. مطلوب سداد إجمالي الطلب: ${current.price ?? "راجع الإدارة لتحديد السعر"}. لو أحد المشترين دفع، تواصل مع الإدارة لتأكيده.\nWarranty ended. Order ${current.ticketId} is due: ${current.price ?? "Contact admin for price"}. If already paid, ask admin to confirm.`,allowedMentions:{parse:[]}});
                    current.buyerPayment={...current.buyerPayment,notified:{...current.buyerPayment?.notified,[buyerId]:new Date().toISOString()}};
                    saveTickets(fresh);
                    buyerReminderRetry.delete(key);
                } catch(error) {console.log("Buyer payment reminder failed:",snapshot.ticketId,error.code || error.name);}
            }
        }
    } finally {checkingBuyerPayments=false;}
}

function adminPaymentAlertReason(ticket) {
    const due=buyerDueAt(ticket);
    if(due===null || due>Date.now()) return null;
    if(!ticketBuyerIds(ticket).length) return ticket.paidAt ? null : "noBuyer";
    return !ticket.buyerPayment?.paidAt && Date.now()>=due+3*86400000 ? "buyerOverdue" : null;
}
let checkingAdminPayments=false;
const adminPaymentRetry=new Map();
async function remindAdminPayments() {
    if(checkingAdminPayments) return;
    checkingAdminPayments=true;
    try {
        const candidates=loadTickets().filter(t=>adminPaymentAlertReason(t));
        if(!candidates.length) return;
        const guild=client.guilds.cache.get(GUILD_ID);
        if(!guild) return;
        const role=await guild.roles.fetch(ADMIN_ROLE_ID).catch(()=>null);
        if(!role) return;
        for(const snapshot of candidates) {
            for(const [,member] of role.members) {
                if(member.user.bot) continue;
                const ticket=snapshot;
                const reason=ticket && adminPaymentAlertReason(ticket);
                const key=`${snapshot.ticketId}:${reason}:${member.id}`;
                if(!reason || ticket.buyerPayment?.adminNotified?.[reason]?.[member.id] || (adminPaymentRetry.get(key)||0)>Date.now()) continue;
                adminPaymentRetry.set(key,Date.now()+3600000);
                try {
                    const explanation=reason==="noBuyer"
                        ? "انتهى الضمان ولا يوجد Buyer. راجع تحويل فلوس صاحب الحساب. / Warranty ended with no buyer assigned. Review seller payout."
                        : "مرّت 3 أيام على انتهاء الضمان ولم يُؤكد دفع المشتري. تابع تحصيل المبلغ. / Buyer payment is 3 days overdue. Follow up on collection.";
                    await member.send({content:`⏰ ${explanation}\nتيكت / Ticket: ${ticket.ticketId}\nاللعبة / Game: ${getGameName(ticket.game)}\nالكمية / Quantity: ${ticket.quantity || 1} ACC\nإجمالي الطلب / Total: ${ticket.price ?? "غير محدد / Not set"}\nhttps://discord.com/channels/${GUILD_ID}/${ticket.ticketId}`,allowedMentions:{parse:[]}});
                    const fresh=loadTickets();const current=fresh.find(t=>t.ticketId===ticket.ticketId);
                    if(current) {
                        const payment=current.buyerPayment || {};
                        current.buyerPayment={...payment,adminNotified:{...payment.adminNotified,[reason]:{...payment.adminNotified?.[reason],[member.id]:new Date().toISOString()}}};
                        saveTickets(fresh);
                    }
                    adminPaymentRetry.delete(key);
                } catch(error) {console.log("Admin payment alert failed:",snapshot.ticketId,error.code || error.name);}
            }
        }
    } finally {checkingAdminPayments=false;}
}

function buyerCanRetrieve(ticket, buyerId) {
    return Boolean(ticket && ticketBuyerIds(ticket).includes(buyerId) && (ticket.receivedAt || ticket.soldAt)
        && !ticket.correction && ticket.status !== "CHANGES_REQUESTED"
        && Array.isArray(ticket.accounts) && ticket.accounts.length >= (Number(ticket.quantity) || 1)
        && ticket.accounts.every(account=>account && (account.login || account.username || account.email) && account.password));
}

function buyerOrdersPayload(buyerId, requestedPage=0) {
    const orders=loadTickets().filter(t=>buyerCanRetrieve(t,buyerId));
    if (!orders.length) return {content:"لا توجد حسابات جاهزة مسجّلة لك كمشتري. تواصل مع الإدارة.\nNo ready accounts are assigned to you as buyer.",components:[]};
    const page=Math.max(0,Math.min(Math.floor(Number(requestedPage)||0),Math.ceil(orders.length/25)-1));
    const components=[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId("buyer_order_pick").setPlaceholder("Choose your order / اختر طلبك")
        .addOptions(orders.slice(page*25,page*25+25).map(t=>({
            label:`${getGameName(t.game)} — ${t.quantity || 1} ACC`.slice(0,100),
            description:`${t.accountType || "Account"} • ${t.ticketId}`.slice(0,100),value:t.ticketId
        }))))];
    if (orders.length>25) components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`buyer_orders_page:${page-1}`).setLabel("Previous / السابق").setStyle(ButtonStyle.Secondary).setDisabled(page===0),
        new ButtonBuilder().setCustomId(`buyer_orders_page:${page+1}`).setLabel("Next / التالي").setStyle(ButtonStyle.Secondary).setDisabled((page+1)*25>=orders.length)
    ));
    return {content:`اختر الطلب لاستلام بياناته / Choose an order (${page+1}/${Math.ceil(orders.length/25)})`,components,allowedMentions:{parse:[]}};
}

async function deliverBuyerOrder(channel, buyerId, ticketId) {
    // Recheck the saved assignment when requested, including selections from old menus.
    if (channel.type !== ChannelType.DM) return false;
    const ticket=findChannelTicket(ticketId);
    if (!buyerCanRetrieve(ticket,buyerId)) {
        await channel.send({content:"الطلب غير متاح لك حاليًا. اطلب من الإدارة مراجعة تعيين Buyer والاستلام.\nThis order is not currently available to you."});
        return false;
    }
    const text=[`Order: ${ticket.ticketId}`,`Game: ${getGameName(ticket.game)}`,`Type: ${ticket.accountType || "—"}`,`Order total / إجمالي الطلب: ${ticket.price ?? "Not set / غير محدد"}`,buyerPaymentStatus(ticket),""];
    for (const [index,account] of ticket.accounts.entries()) {
        const extra=buildLegacyAccountExtra(account);
        text.push(`Account ${index+1}`,`Login: ${account.login || account.username || account.email}`,`Password: ${account.password}`,`Additional Info:\n${extra || "—"}`,"");
    }
    // A text attachment preserves complete long passwords/info without Discord truncation or Markdown changes.
    await channel.send({content:`🔐 بيانات حسابات طلبك / Your account details — ${getGameName(ticket.game)} (${ticket.quantity || 1} ACC)`,
        files:[{attachment:Buffer.from(text.join("\n"),"utf8"),name:"account-details.txt"}],allowedMentions:{parse:[]}});
    audit("BUYER_DATA_REQUESTED",buyerId,ticket);
    return true;
}

const activeBuyerRequests=new Set();
async function handleBuyerDM(message) {
    if (message.channel.type!==ChannelType.DM || message.author.bot) return;
    const command=String(message.content || "").trim().toLowerCase();
    const financeCommand=["balance","!balance","رصيدي","عليا كام"].includes(command) ? "balance" : ["orders","!orders","طلباتي"].includes(command) ? "orders" : null;
    if (!financeCommand && !["account","accounts","!account","!accounts","حساب","حساباتي"].includes(command)) return;
    if (activeBuyerRequests.has(message.author.id)) return;
    activeBuyerRequests.add(message.author.id);
    try {
        if(financeCommand) return await sendBuyerFinances(message.channel,message.author.id,financeCommand);
        const orders=loadTickets().filter(t=>buyerCanRetrieve(t,message.author.id));
        if (orders.length===1) await deliverBuyerOrder(message.channel,message.author.id,orders[0].ticketId);
        else await message.channel.send(buyerOrdersPayload(message.author.id));
    } finally { activeBuyerRequests.delete(message.author.id); }
}

const deliveryInfoSessions = new Map();
client.on(Events.InteractionCreate, async interaction => {
    const l = (english, arabic) => {
        const pending = pendingTickets.get(interaction.user?.id);
        if (pending?.language) return ticketText(pending)(english, arabic);
        if (interaction.channelId && interaction.guild) {
            const context = loadTickets().find(t => t.ticketId === interaction.channelId);
            if (context) return ticketText(context)(english, arabic);
        }
        return english;
    };
    try {
        if (interaction.channel?.type === ChannelType.DM) {
            if (interaction.isStringSelectMenu() && interaction.customId === "buyer_order_pick") {
                await interaction.deferReply();
                const sent=await deliverBuyerOrder(interaction.channel,interaction.user.id,interaction.values[0]);
                return interaction.editReply({content:sent ? "✅ تم إرسال الملف / File sent." : "الطلب غير متاح / Order unavailable."});
            }
            if (interaction.isButton() && interaction.customId.startsWith("buyer_orders_page:")) {
                return interaction.update(buyerOrdersPayload(interaction.user.id,Number(interaction.customId.split(":")[1])));
            }
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === "send-rules") {
            if (!interaction.guild || !isAdmin(interaction)) return interaction.reply({content:"للإدارة فقط.",flags:MessageFlags.Ephemeral});
            const channel=interaction.options.getChannel("channel") || interaction.channel;
            if (!channel || channel.guildId!==interaction.guild.id || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)) {
                return interaction.reply({content:"اختار قناة نصية داخل السيرفر لنشر القوانين.",flags:MessageFlags.Ephemeral});
            }
            await interaction.deferReply({flags:MessageFlags.Ephemeral});
            const bot=interaction.guild.members.me || await interaction.guild.members.fetchMe();
            if (!channel.permissionsFor(bot)?.has([PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.EmbedLinks])) {
                return interaction.editReply({content:"البوت محتاج صلاحيات View Channel وSend Messages وEmbed Links في القناة دي."});
            }
            const message=await channel.send({embeds:[new EmbedBuilder().setColor(0x28b8cf)
                .setTitle("📜 قوانين السيرفر").setDescription(SERVER_RULES)],allowedMentions:{parse:[]}});
            const rulesConfig=loadConfig();rulesConfig.rulesMessageURL=message.url;saveConfig(rulesConfig);
            return interaction.editReply({content:`✅ البوت نشر القوانين: ${message.url}`});
        }
        if (interaction.isChatInputCommand() && ["set-type-price","clear-type-price","remove-account-type"].includes(interaction.commandName)) {
            if (!interaction.guild || !isAdmin(interaction)) return interaction.reply({content:"Admin only / للإدارة فقط",flags:MessageFlags.Ephemeral});
            const game=findGame(interaction.options.getString("game",true));
            const type=resolveAccountType(game,interaction.options.getString("type",true));
            if (!game || !type) return interaction.reply({content:"Game or type not found. Use /account-types.",flags:MessageFlags.Ephemeral});
            if(typeMutationJobs.has(game.value)) return interaction.reply({content:"An update is in progress. Try again shortly.",flags:MessageFlags.Ephemeral});
            const remove=interaction.commandName==="remove-account-type";
            const price=interaction.commandName==="set-type-price" ? buyerMoney(interaction.options.getString("price",true)) : null;
            if(!remove && interaction.commandName==="set-type-price" && (!price || !/^[A-Z]{3}$/.test(price.currency))) {
                return interaction.reply({content:"Use a price with currency, e.g. 500 EGP or 10 USD. This is the price PER ACCOUNT.",flags:MessageFlags.Ephemeral});
            }
            if(remove && (loadTickets().some(t=>!t.closedAt && t.game===game.value && (t.accountTypeId || "general")===type.id)
                || [...pendingTickets.values()].some(t=>t.game===game.value && t.accountTypeId===type.id && Date.now()-t.createdAt<600000))) {
                return interaction.reply({content:"This type has open tickets or a submission in progress. Close its tickets and let active submission sessions finish/expire before removing it.",flags:MessageFlags.Ephemeral});
            }
            typeMutationJobs.add(game.value);
            try {
                await interaction.deferReply({flags:MessageFlags.Ephemeral});
                // Persist synchronously before any channel operations. Closed tickets retain their data.
                const value=price ? `${(price.cents/100).toFixed(2)} ${price.currency}` : null;
                saveGames(GAMES.map(g=>g.value===game.value ? {...g,accountTypes:remove ? g.accountTypes.filter(t=>t.id!==type.id) : g.accountTypes.map(t=>t.id===type.id?{...t,fixedPrice:value}:t)} : g));
                if(remove) {
                    for(const [id,pending] of pendingTickets) if(pending.game===game.value && pending.accountTypeId===type.id) pendingTickets.delete(id);
                    const key=`${interaction.guild.id}:${game.value}`;
                    const layout=loadConfig().gameLayouts?.[key];
                    const channel=layout?.typeChannelIds?.[type.id] ? await interaction.guild.channels.fetch(layout.typeChannelIds[type.id]).catch(()=>null) : null;
                    if(channel) {
                        const ensured=await ensureGameChannels(interaction.guild,game.value);
                        await channel.setParent(ensured.archiveCategoryId,{lockPermissions:true});
                        await channel.setName(`🗃️・retired-${type.id}`.slice(0,100));
                    }
                    const config=loadConfig();
                    if(config.gameLayouts?.[key]?.typeChannelIds) {delete config.gameLayouts[key].typeChannelIds[type.id];saveConfig(config);}
                }
                audit(interaction.commandName.toUpperCase(),interaction.user.id,{game:game.value},{typeId:type.id,before:type.fixedPrice,after:value});
                await updatePanel(interaction.guild);
                return interaction.editReply({content:remove ? `✅ Removed ${type.name}. Its channel history is kept in the admin archive.`
                    : value ? `✅ ${game.label} / ${type.name}: ${value} per account. Ticket total = price × quantity.` : `✅ Type price cleared. The game price applies if configured.`,allowedMentions:{parse:[]}});
            } finally {typeMutationJobs.delete(game.value);}
        }


        if (interaction.isChatInputCommand() && ["setup-game-channels","look-for"].includes(interaction.commandName)) {
            if (!interaction.guild || !isAdmin(interaction)) return interaction.reply({content:"للإدارة فقط",flags:MessageFlags.Ephemeral});
            const game=findGame(interaction.options.getString("game",true));
            if (!game) return interaction.reply({content:"اللعبة غير موجودة.",flags:MessageFlags.Ephemeral});
            await interaction.deferReply({flags:MessageFlags.Ephemeral});
            if (interaction.commandName === "setup-game-channels") {
                const layout=await ensureGameChannels(interaction.guild,game.value);
                return interaction.editReply({content:`✅ تم تجهيز قنوات اللعبة: <#${layout.publicCategoryId}> والأرشيف: <#${layout.archiveCategoryId}>`});
            }
            const request=interaction.options.getString("request",true).trim();
            if(!request) return interaction.editReply({content:"Write the account request in English."});
            const member=interaction.options.getUser("member") || interaction.user;
            const role=interaction.options.getRole("role");
            if(role?.id===interaction.guild.id) return interaction.editReply({content:"Everyone is already included. Choose a Sellers role instead."});
            const config=loadConfig();
            const panelChannel=config.panelChannelId ? await interaction.guild.channels.fetch(config.panelChannelId).catch(()=>null) : null;
            const panel=panelChannel?.isTextBased() && config.panelMessageId ? await panelChannel.messages.fetch(config.panelMessageId).catch(()=>null) : null;
            if (!panel) return interaction.editReply({content:"Run /setup-ticket first to create the account submission panel."});
            const rulesURL=interaction.options.getString("warning-url") || config.rulesMessageURL;
            const warningURL=rulesURL || panel.url;
            if(!/^https:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?$/.test(warningURL)) return interaction.editReply({content:"Use a Discord channel or message link for warning-url."});
            const layout=await ensureGameChannels(interaction.guild,game.value);
            const channel=await interaction.guild.channels.fetch(layout.lookForChannelId);
            const bot=interaction.guild.members.me || await interaction.guild.members.fetchMe();
            if(!channel.permissionsFor(bot)?.has([PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.EmbedLinks,PermissionsBitField.Flags.MentionEveryone])) {
                return interaction.editReply({content:"The bot needs View Channel, Send Messages, Embed Links and Mention Everyone in the look-for channel."});
            }
            const divider="━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
            const mentions=`<@${member.id}>${role ? ` | <@&${role.id}>` : ""} | @everyone`;
            const author=member.id===interaction.user.id ? `**Posted By** ${mentions}` : `**Posted By** <@${interaction.user.id}> | ${mentions}`;
            const notice=rulesURL ? "Read this carefully before selling to avoid scams" : "Review the requirements and use the official submission panel";
            const description=`${request}\n${divider}\n${author}\n${divider}\n-# Important notice — [${notice}](${warningURL})`;
            const embed=new EmbedBuilder().setColor(0x28b8cf).setDescription(description);
            // Embed mentions are visual only; content mentions trigger the requested notifications.
            const message=await channel.send({content:mentions,embeds:[embed],
                allowedMentions:{parse:["everyone"],users:[member.id],roles:role?[role.id]:[]},
                components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link)
                    .setLabel("Submit an account").setURL(panel.url))]});
            return interaction.editReply({content:`✅ Request posted: ${message.url}`,allowedMentions:{parse:[]}});
        }


        if(interaction.isChatInputCommand() && interaction.commandName === "set-warranty") {
            if(!isAdmin(interaction)) return interaction.reply({content:"للإدارة فقط / Admin only",flags:MessageFlags.Ephemeral});
            const game=findGame(interaction.options.getString("game",true));
            const days=interaction.options.getInteger("days",true);
            if(!game || !validWarrantyDays(days)) return interaction.reply({content:"تأكد من اسم اللعبة والمدة من 0 إلى 365 يوم / Check game and days (0–365)",flags:MessageFlags.Ephemeral});
            const query=interaction.options.getString("type")?.trim().toLowerCase();
            const type=query ? game.accountTypes.find(t=>[t.id,t.name,t.nameAr].some(v=>v?.toLowerCase()===query)) : null;
            if(query && !type) return interaction.reply({content:"النوع غير موجود. استخدم /account-types / Unknown type",flags:MessageFlags.Ephemeral});
            const updated={...game,accountTypes:game.accountTypes.map(t=>({...t}))};
            if(type) updated.accountTypes.find(t=>t.id===type.id).warrantyDays=days;
            else {updated.warrantyDays=days;for(const t of updated.accountTypes) t.warrantyDays=null;}
            saveGames(GAMES.map(g=>g===game?updated:g));
            audit("WARRANTY_UPDATED",interaction.user.id,{game:game.value},{typeId:type?.id || null,after:days});
            return interaction.reply({content:`✅ ${game.label}${type ? " / "+type.name : " — جميع الأنواع / All types"}: ${days} يوم / days.\nيُطبق عند البيع القادم؛ الضمان الذي بدأ بالفعل لا يتغير / Applies to future sales; existing warranty dates stay unchanged.`,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
        }
        if (interaction.isChatInputCommand() && ["add-account-type","set-type-stock","add-type-stock","account-types"].includes(interaction.commandName)) {
            if (!isAdmin(interaction)) return interaction.reply({content:"❌ للإدارة فقط / Admin only",flags:MessageFlags.Ephemeral});
            const game=findGame(interaction.options.getString("game",true));
            if (!game) return interaction.reply({content:"❌ اللعبة غير موجودة.",flags:MessageFlags.Ephemeral});
            const command=interaction.commandName;
            if (command==="account-types") return interaction.reply({content:game.accountTypes.map(t=>`**${t.name} / ${t.nameAr || t.name}** — ${t.stock} ACC — Each / سعر الحساب: ${t.fixedPrice || "Game default / سعر اللعبة"} — Warranty / الضمان: ${validWarrantyDays(t.warrantyDays)?t.warrantyDays:validWarrantyDays(game.warrantyDays)?game.warrantyDays:WARRANTY_DAYS} days — ID: ${t.id}`).join("\n").slice(0,1950),flags:MessageFlags.Ephemeral});
            let types=game.accountTypes.map(t=>({...t}));
            let before=0,type;
            if (command==="add-account-type") {
                const name=interaction.options.getString("name",true).trim();
                const id=slugifyGameName(name);
                if (!name || types.some(t=>t.id===id || t.name.toLowerCase()===name.toLowerCase())) return interaction.reply({content:"❌ الاسم فارغ أو النوع موجود بالفعل.",flags:MessageFlags.Ephemeral});
                if (types.length>=25) return interaction.reply({content:"❌ الحد الأقصى 25 نوعًا لكل لعبة.",flags:MessageFlags.Ephemeral});
                type={id,name,nameAr:(interaction.options.getString("name-ar")||"").trim(),stock:interaction.options.getInteger("stock",true),receivedTicketIds:[]};
                types.push(type);
            } else {
                const query=interaction.options.getString("type",true).trim().toLowerCase();
                type=types.find(t=>[t.id,t.name,t.nameAr].some(v=>v?.toLowerCase()===query));
                if (!type) return interaction.reply({content:"❌ النوع غير موجود. استخدم /account-types لمعرفة الأنواع.",flags:MessageFlags.Ephemeral});
                before=type.stock;
                const quantity=interaction.options.getInteger("quantity",true);
                type.stock=command==="add-type-stock"?type.stock+quantity:quantity;
            }
            saveGames(GAMES.map(g=>g===game?{...g,accountTypes:types}:g));
            audit(command.toUpperCase(),interaction.user.id,{game:game.value},{typeId:type.id,before,after:type.stock});
            await interaction.reply({content:`✅ **${game.label} / ${type.name}**: ${type.stock} ACC. إجمالي اللعبة: ${getGameStock(game.value)}.`,flags:MessageFlags.Ephemeral});
            if (command === "add-account-type") await ensureGameChannels(interaction.guild,game.value);
            await updatePanel(interaction.guild);
            return;
        }
        if (interaction.isStringSelectMenu() && interaction.customId==="select_account_type") {
            const pending=pendingTickets.get(interaction.user.id);
            const game=GAMES.find(g=>g.value===pending?.game);
            const type=stockPool(game,interaction.values[0]);
            if (!pending || !type || type.stock<=0) return interaction.reply({content:"❌ النوع غير متاح حاليًا. اختر نوعًا آخر / Type unavailable.",flags:MessageFlags.Ephemeral});
            pending.accountTypeId=type.id;
            delete pending.payment;delete pending.language;delete pending.quantity;
            delete pending.accountRank;delete pending.skinCount;delete pending.skinDetails;
            if (type.id === "ranked") {
                const options=(ACCOUNT_RANKS[game.value] || []).map(rank=>({label:rank,value:rank}));
                options.push({label:"Other / رتبة أخرى",value:"other"});
                return interaction.reply({content:"🏆 Select account rank / اختر رتبة الحساب",flags:MessageFlags.Ephemeral,
                    components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("select_account_rank")
                        .setPlaceholder("Account rank / رتبة الحساب").addOptions(options))]});
            }
            if (type.id === "skins") {
                return interaction.showModal(new ModalBuilder().setCustomId("skin_details").setTitle("Skin details / تفاصيل السكنات")
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("skin_count").setLabel("Number of skins / عدد السكنات")
                            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6).setPlaceholder("Example / مثال: 15")),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("skin_details").setLabel("Skin details / أسماء وتفاصيل السكنات")
                            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))));
            }
            await interaction.reply(paymentPrompt(pending));
            deleteReplyLater(interaction);return;
        }
        if ((interaction.isStringSelectMenu() && interaction.customId === "select_account_rank") ||
            (interaction.isModalSubmit() && ["skin_details","custom_account_rank"].includes(interaction.customId))) {
            const pending=pendingTickets.get(interaction.user.id);
            const game=GAMES.find(g=>g.value===pending?.game);
            if (!pending || !game || !stockPool(game,pending.accountTypeId)) return interaction.reply({content:"❌ Session expired / ابدأ من اختيار اللعبة مجددًا",flags:MessageFlags.Ephemeral});
            if (interaction.customId === "select_account_rank") {
                if (pending.accountTypeId !== "ranked") return interaction.reply({content:"❌ اختر Ranked أولًا.",flags:MessageFlags.Ephemeral});
                const rank=interaction.values[0];
                if (rank === "other") return interaction.showModal(new ModalBuilder().setCustomId("custom_account_rank").setTitle("Account rank / رتبة الحساب")
                    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("rank").setLabel("Rank / الرتبة")
                        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80))));
                if (!(ACCOUNT_RANKS[game.value] || []).includes(rank)) return interaction.reply({content:"❌ Invalid rank / رتبة غير صحيحة",flags:MessageFlags.Ephemeral});
                pending.accountRank=rank;
            } else if (interaction.customId === "custom_account_rank") {
                if (pending.accountTypeId !== "ranked") return interaction.reply({content:"❌ اختر Ranked أولًا.",flags:MessageFlags.Ephemeral});
                pending.accountRank=interaction.fields.getTextInputValue("rank").trim();
                if (!pending.accountRank) return interaction.reply({content:"❌ اكتب الرتبة.",flags:MessageFlags.Ephemeral});
            } else {
                if (pending.accountTypeId !== "skins") return interaction.reply({content:"❌ اختر With Skins أولًا.",flags:MessageFlags.Ephemeral});
                const raw=interaction.fields.getTextInputValue("skin_count").trim().replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
                const count=Number(raw),details=interaction.fields.getTextInputValue("skin_details").trim();
                if (!/^\d+$/.test(raw) || !Number.isSafeInteger(count) || count<1 || !details) return interaction.reply({content:"❌ اكتب عددًا صحيحًا أكبر من صفر وتفاصيل السكنات. اختر With Skins مرة أخرى للمحاولة.",flags:MessageFlags.Ephemeral});
                pending.skinCount=count;pending.skinDetails=details;
            }
            await interaction.reply(paymentPrompt(pending));deleteReplyLater(interaction);return;
        }
        if (interaction.isChatInputCommand() && interaction.commandName === "set-sales") {
            if (!isAdmin(interaction)) return interaction.reply({content:"❌ للإدارة فقط / Admin only",flags:MessageFlags.Ephemeral});
            const user=interaction.options.getUser("user",true);
            const count=interaction.options.getInteger("count",true);
            if (!Number.isSafeInteger(count) || count<0 || count>1000000) return interaction.reply({content:"❌ اكتب عددًا صحيحًا من 0 إلى 1000000.",flags:MessageFlags.Ephemeral});
            await interaction.deferReply({flags:MessageFlags.Ephemeral});
            const sellers=loadSellers();
            const seller=sellers[user.id] || {delivered:0,rank:null,manualRank:null};
            const before=Number(seller.delivered)||0;
            sellers[user.id]={...seller,delivered:count,updatedAt:new Date().toISOString()};
            saveSellers(sellers);
            audit("SALES_COUNT_SET",interaction.user.id,{}, {userId:user.id,before,after:count});
            const rank=await updateSellerRank(interaction.guild,user.id);
            return interaction.editReply({content:`✅ تم ضبط إجمالي مبيعات <@${user.id}>: **${before} → ${count} ACC**.\n`+
                (seller.manualRank ? "الرتبة مثبتة يدويًا؛ لتفعيل الرتبة حسب العدد استخدم /set-rank واختر auto."
                : `الرتبة حسب العدد: **${rank?.display || "No Rank"}**`),allowedMentions:{parse:[]}});
        }
        if ((interaction.isButton() && interaction.customId === "ticket_buyer_paid") ||
            (interaction.isStringSelectMenu() && interaction.customId.startsWith("buyer_paid_pick:"))) {
            if(!isAdmin(interaction)) return interaction.reply({content:"للإدارة فقط / Admin only",flags:MessageFlags.Ephemeral});
            const tickets=loadTickets();
            const ticket=tickets.find(t=>t.ticketId===interaction.channel.id);
            if(!ticket || !(ticket.receivedAt || ticket.soldAt)) return interaction.reply({content:"استلم الحساب أولًا / Receive the account first",flags:MessageFlags.Ephemeral});
            if(ticket.buyerPayment?.paidAt) return interaction.reply({content:"تم تسجيل دفع التيكت بالفعل عند جميع المشترين / Order already settled for all buyers",flags:MessageFlags.Ephemeral});
            const buyers=ticketBuyerIds(ticket);
            if(!buyers.length) return interaction.reply({content:"حدد Buyer أولًا / Assign a buyer first",flags:MessageFlags.Ephemeral});
            if(interaction.isButton()) {
                await interaction.deferReply({flags:MessageFlags.Ephemeral});
                const options=[];
                for(const id of buyers) {
                    const user=await client.users.fetch(id).catch(()=>null);
                    options.push({label:String(user?.tag || user?.username || id).slice(0,100),description:id,value:id});
                }
                return interaction.editReply({content:`اختر المشتري الذي دفع إجمالي الطلب لتأكيد السداد للجميع / Select who paid the full order to confirm settlement for all.\n${ticket.price ?? "السعر غير محدد / Price not set"}`,
                    components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`buyer_paid_pick:${ticket.ticketId}`).setPlaceholder("Who paid? / مين دفع؟").addOptions(options))],allowedMentions:{parse:[]}});
            }
            const payer=interaction.values[0];
            if(interaction.customId!==`buyer_paid_pick:${ticket.ticketId}` || interaction.values.length!==1 || !buyers.includes(payer)) return interaction.reply({content:"اختيار غير صالح؛ افتح اللوحة مجددًا / Invalid selection; reopen controls",flags:MessageFlags.Ephemeral});
            ticket.buyerPayment={...ticket.buyerPayment,paidAt:new Date().toISOString(),payerId:payer,confirmedBy:interaction.user.id,price:ticket.price};
            saveTickets(tickets);
            logPaymentSnapshot(ticket);
            audit("BUYER_PAYMENT_CONFIRMED",interaction.user.id,ticket);
            return interaction.update({content:"✅ تم سداد إجمالي التيكت عند جميع المشترين وإيقاف تنبيهات الدفع / Order settled for all buyers; payment reminders stopped.",components:[],allowedMentions:{parse:[]}});
        }
        if (interaction.isButton() && interaction.customId === "ticket_admin_refresh") {
            if (!isStaff(interaction)) return interaction.reply({content:"❌ Staff only / للمسؤولين فقط",flags:MessageFlags.Ephemeral});
            const ticket=findChannelTicket(interaction.channel.id);
            if (!ticket) return interaction.reply({content:"❌ التيكت غير موجود.",flags:MessageFlags.Ephemeral});
            return interaction.update({content:"🛠️ " + l("Updated staff controls", "تم تحديث لوحة الإدارة"),components:createPrivateStaffButtons(ticket)});
        }
        if (interaction.isChatInputCommand() && ["admin-summary", "audit-log"].includes(interaction.commandName)) {
            if (!isAdmin(interaction)) return interaction.reply({content: "❌ Admin only / للإدارة فقط", flags: MessageFlags.Ephemeral});
            const tickets = loadTickets();
            let lines;
            if (interaction.commandName === "admin-summary") {
                lines = GAMES.map(g => {
                    const rows = tickets.filter(t => t.game === g.value);
                    const count = fn => rows.filter(fn).reduce((n,t) => n + (Number(t.quantity) || 1), 0);
                    return `**${g.label}**\n${g.accountTypes.map(t=>`${t.nameAr || t.name}: ${t.stock}`).join(" | ")}\nالمتاح: ${g.stock} | جاهز للاستلام: ${count(t=>!t.closedAt && t.submittedAt && !t.receivedAt && !t.soldAt && t.status !== "CHANGES_REQUESTED")} | في الضمان: ${count(t=>t.soldAt && !payoutReady(t))} | جاهز للصرف: ${count(t=>payoutReady(t) && !t.paidAt)}`;
                });
            } else {
                const query = interaction.options.getString("game");
                const game = query ? findGame(query) : null;
                if (query && !game) return interaction.reply({content: "اللعبة غير موجودة.", flags: MessageFlags.Ephemeral});
                lines = readJSON(AUDIT_FILE, []).filter(e=>!game || e.game===game.value).slice(-15).reverse().map(e=>
                    `${discordTime(e.at, "f")} **${e.action}** — <@${e.actor}> | ${e.game || "—"}${e.typeId ? ` / ${e.typeId}` : ""}${e.ticketId ? ` | <#${e.ticketId}>` : ""}${e.before !== undefined ? ` | ${e.before} → ${e.after}` : ""}`);
            }
            // Paginate text to preserve every game without exceeding Discord message limits.
            const pages = [""];
            for (const line of lines) {
                if ((pages[pages.length-1] + line).length > 1900) pages.push("");
                pages[pages.length-1] += line + "\n\n";
            }
            await interaction.reply({content: pages[0] || "لا توجد عمليات مسجلة بعد.", flags: MessageFlags.Ephemeral, allowedMentions:{parse:[]}});
            for (const page of pages.slice(1)) await interaction.followUp({content:page,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
            return;
        }
        if ((interaction.isButton() && ["ticket_request_edit", "ticket_paid"].includes(interaction.customId)) ||
            (interaction.isModalSubmit() && interaction.customId === "request_edit_submit")) {
            if (!isAdmin(interaction)) return interaction.reply({content:"❌ للإدارة فقط / Admin only",flags:MessageFlags.Ephemeral});
            const tickets=loadTickets();
            const ticket=tickets.find(t=>t.ticketId===interaction.channel.id);
            if (!ticket) return interaction.reply({content:"التيكت غير موجود.",flags:MessageFlags.Ephemeral});
            if (interaction.customId === "ticket_paid") {
                if (!canConfirmPayout(ticket)) return interaction.reply({content:ticket.paidAt
                    ? l("Payout has already been confirmed. No accounts were counted again.","تم تأكيد الدفع بالفعل. لم تُحتسب الحسابات مرة أخرى.")
                    : ticket.correction || ticket.status === "CHANGES_REQUESTED"
                    ? l("The requested revision must be submitted and received first.","يجب أن يرسل المستخدم البيانات الجديدة ثم تؤكد الإدارة استلامها أولًا.")
                    : l("Press Receive Account first, then Confirm Payout.","اضغط «استلام الحساب» أولًا، وبعده Confirm Payout."),flags:MessageFlags.Ephemeral});
                const count=creditPaidAccounts(ticket);
                ticket.paidAt=new Date().toISOString();ticket.paidBy=interaction.user.id;ticket.paidByName=interaction.user.username;
                ticket.timerStoppedAt=ticket.paidAt;
                ticket.fundsReleasedAt=ticket.fundsReleasedAt || ticket.paidAt;
                ticket.soldAt=ticket.soldAt || ticket.paidAt;
                ticket.sellerId=ticket.userId;ticket.deliveredCounted=true;
                ticket.fundsStatus="PAID";
                if (!ticket.closedAt) ticket.status="PAID";
                saveTickets(tickets);
                logTicketSnapshot(ticket);
                logPaymentSnapshot(ticket,count);
                audit("PAID", interaction.user.id,ticket,{creditedTo:ticket.userId,quantity:ticket.quantity,total:count});
                await interaction.deferReply({flags:MessageFlags.Ephemeral});
                const rank=await updateSellerRank(interaction.guild,ticket.userId);
                await interaction.editReply({content:`✅ تم تأكيد الدفع وإيقاف التايمر.\nحسابات صاحب التيكت: **${count} ACC**\nالرتبة: **${rank?.display || "No Rank"}**`});
                const user=await client.users.fetch(ticket.userId);
                await user.send({content:ticketText(ticket)("✅ Staff confirmed your payout.","✅ الإدارة أكدت تحويل فلوسك.") + `\nhttps://discord.com/channels/${interaction.guild.id}/${ticket.ticketId}`}).catch(()=>{});
                await refreshTicket(interaction.channel,ticket);
                return;
            }
            if (ticket.closedAt || ticket.paidAt) return interaction.reply({content:"❌ التعديل غير متاح بعد إغلاق التيكت أو تأكيد الدفع.",flags:MessageFlags.Ephemeral});
            if (ticket.correction) return interaction.reply({content:"يوجد طلب تعديل قيد التنفيذ أو ينتظر تأكيد الاستلام.",flags:MessageFlags.Ephemeral});
            const reason= ticketText(ticket)("Please submit all account details again using Submit Account. The form will be empty, just like a new account.","من فضلك اضغط «تسليم حساب» وأدخل بيانات الحساب كاملة من جديد. النموذج هيكون فاضي زي تسليم حساب جديد.");
            const previousStatus = ticket.status;
            ticket.accounts=[];
            ticket.status="CHANGES_REQUESTED";ticket.submittedAt=null;
            ticket.correction={reason,by:interaction.user.id,at:new Date().toISOString(),previousStatus,awaitingConfirmation:false};
            saveTickets(tickets);audit("CHANGES_REQUESTED",interaction.user.id,ticket);
            await interaction.reply({content:"✅ تم تسجيل طلب التعديل.",flags:MessageFlags.Ephemeral});
            const payload={content:ticketText(ticket)("🔐 Resubmit account\n","🔐 إعادة تسليم الحساب\n")+reason,
                allowedMentions:{parse:[]},components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link)
                    .setLabel(ticketText(ticket)("Open ticket to submit","فتح التيكت للتسليم"))
                    .setURL(`https://discord.com/channels/${interaction.guild.id}/${ticket.ticketId}`))]};
            const user=await client.users.fetch(ticket.userId);
            await user.send(payload).catch(()=>{});
            await interaction.channel.send({...payload,components:[new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("ticket_account_data").setStyle(ButtonStyle.Primary)
                    .setLabel(ticketText(ticket)("Submit Account", "تسليم حساب")))]});
            await refreshTicket(interaction.channel,ticket);
            return;
        }
        if (interaction.isChatInputCommand() && interaction.commandName === "set-delivery-info") {
            if (!isAdmin(interaction)) return interaction.reply({content: "❌ للإدارة فقط / Admin only", flags: MessageFlags.Ephemeral});
            const game = findGame(interaction.options.getString("game", true));
            if (!game) return interaction.reply({content: "❌ اللعبة غير موجودة. اكتب اسمها أو المعرّف الخاص بها.", flags: MessageFlags.Ephemeral});
            const query = interaction.options.getString("type");
            const type = query ? game.accountTypes.find(t=>[t.id,t.name,t.nameAr].some(v=>v?.toLowerCase()===query.trim().toLowerCase())) : null;
            if (query && !type) return interaction.reply({content:"❌ النوع غير موجود. استخدم /account-types.",flags:MessageFlags.Ephemeral});
            for (const [key,session] of deliveryInfoSessions) if (Date.now()-session.at>900000) deliveryInfoSessions.delete(key);
            const sessionId = randomUUID();
            deliveryInfoSessions.set(sessionId,{game:game.value,typeId:type?.id || null,userId:interaction.user.id,at:Date.now()});
            const modal = new ModalBuilder().setCustomId(`delivery_info:${sessionId}`)
                .setTitle("معلومات التسليم / Delivery Info");
            for (const [language, label] of [["en", "English — required"], ["ar", "العربية — اختياري"]]) {
                const input = new TextInputBuilder().setCustomId(language).setLabel(label)
                    .setStyle(TextInputStyle.Paragraph).setMaxLength(1000)
                    .setRequired(language === "en")
                    .setValue(type?.deliveryInfo?.[language] || game.deliveryInfo?.[language] || DEFAULT_DELIVERY_INFO);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
            }
            return interaction.showModal(modal);
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith("delivery_info:")) {
            if (!isAdmin(interaction)) return interaction.reply({content: "❌ للإدارة فقط / Admin only", flags: MessageFlags.Ephemeral});
            const key=interaction.customId.slice("delivery_info:".length);
            const session=deliveryInfoSessions.get(key);
            if (session && (session.userId!==interaction.user.id || Date.now()-session.at>900000)) return interaction.reply({content:"❌ انتهت الجلسة. افتح الأمر من جديد.",flags:MessageFlags.Ephemeral});
            const game = GAMES.find(item => item.value === (session?.game || key));
            if (!game) return interaction.reply({content: "❌ اللعبة لم تعد موجودة.", flags: MessageFlags.Ephemeral});
            const type=session?.typeId ? stockPool(game,session.typeId) : null;
            if (session?.typeId && !type) return interaction.reply({content:"❌ النوع لم يعد موجودًا.",flags:MessageFlags.Ephemeral});
            const en = interaction.fields.getTextInputValue("en").trim();
            const ar = interaction.fields.getTextInputValue("ar").trim();
            if (!en) return interaction.reply({content: "❌ اكتب المعلومات المطلوبة بالإنجليزية أولًا.", flags: MessageFlags.Ephemeral});
            saveGames(GAMES.map(item => item === game ? (type
                ? {...item,accountTypes:item.accountTypes.map(t=>t.id===type.id?{...t,deliveryInfo:{en,ar}}:t)}
                : {...item, deliveryInfo: {en, ar}}) : item));
            deliveryInfoSessions.delete(key);
            return interaction.reply({content: `✅ تم حفظ معلومات التسليم لـ **${game.label}${type ? ` / ${type.name}` : ""}**. ستظهر في التيكتات الجديدة ونماذج التسليم التي تُفتح بعد الآن.`, flags: MessageFlags.Ephemeral});
        }
        // -------------------------------------------------
        // /setup-ticket
        // -------------------------------------------------

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "setup-ticket"
        ) {
            if (!isAdmin(interaction)) {
                return interaction.reply({
                    content: "❌ Admin role required.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const config = loadConfig();

            if (config.panelChannelId && config.panelMessageId) {
                try {
                    const oldChannel = await interaction.guild.channels.fetch(
                        config.panelChannelId
                    );

                    const oldMessage = await oldChannel.messages.fetch(
                        config.panelMessageId
                    );

                    await oldMessage.delete();
                } catch (_) {
                    // Ignore old panel errors
                }
            }

            const panelMessage = await interaction.channel.send({
                embeds: [createPanelEmbed()],
                components: [createGameMenu()]
            });

            saveConfig({
                panelChannelId: interaction.channel.id,
                panelMessageId: panelMessage.id
            });

            await interaction.reply({
                content:
                    "✅ Permanent ticket panel created!\n" +
                    "You do not need to use `/setup-ticket` again unless you want to move the panel.",
                flags: MessageFlags.Ephemeral
            });

            deleteReplyLater(interaction);
            return;
        }

        // -------------------------------------------------
        // GAME / STOCK ADMIN COMMANDS
        // -------------------------------------------------

        if (
            interaction.isChatInputCommand() &&
            ["add-game", "set-stock", "set-price", "clear-price", "set-game-message", "clear-game-message", "send-game-message", "remove-game"].includes(interaction.commandName)
        ) {
            if (!isAdmin(interaction)) {
                return interaction.reply({
                    content: "❌ Admin role required.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "add-game") {
                const name = interaction.options.getString("name", true).trim();
                const stock = interaction.options.getInteger("stock", true);
                const emoji = interaction.options.getString("emoji") || "🎮";

                if (GAMES.length >= 25) {
                    return interaction.reply({
                        content: "❌ Discord dropdowns support up to 25 games. Remove one first.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (findGame(name)) {
                    return interaction.reply({
                        content: "❌ A game with this name already exists.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                let value = slugifyGameName(name);
                let suffix = 2;

                while (GAMES.some(game => game.value === value)) {
                    value = `${slugifyGameName(name)}-${suffix}`.substring(0, 100);
                    suffix += 1;
                }

                await interaction.deferReply({flags:MessageFlags.Ephemeral});
                GAMES.push({
                    label: name.substring(0, 100),
                    value,
                    emoji,
                    stock,
                    fixedPrice: null,
                    customMessage: null
                });

                saveGames(GAMES);
                await ensureGameChannels(interaction.guild,value);
                await updatePanel(interaction.guild);

                return interaction.editReply({
                    content:
                        `✅ Added **${name}**\n` +
                        `${getStockIndicator(stock)} Stock: **${stock}**`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "set-stock") {
                const query = interaction.options.getString("game", true);
                const stock = interaction.options.getInteger("stock", true);
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const previousStock = stockPool(game,"general")?.stock || 0;
                const general=stockPool(game,"general");
                if (!general) return interaction.reply({content:"استخدم /set-type-stock لتحديد نوع الحساب.",flags:MessageFlags.Ephemeral});
                general.stock = stock;
                saveGames(GAMES);
                audit("STOCK_CHANGED", interaction.user.id, {game: game.value}, {typeId:"general",before:previousStock, after:stock});
                await updatePanel(interaction.guild);

                return interaction.reply({
                    content:
                        `✅ **${game.label} / General**: **${stock}** ACC. Total: ${getGameStock(game.value)}`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "set-price") {
                const query = interaction.options.getString("game", true);
                const price = interaction.options.getString("price", true).trim();
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                game.fixedPrice = price.substring(0, 100);
                saveGames(GAMES);
                await updatePanel(interaction.guild);

                return interaction.reply({
                    content: `✅ Fixed price for **${game.label}** is now **${game.fixedPrice}**.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "clear-price") {
                const query = interaction.options.getString("game", true);
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                game.fixedPrice = null;
                saveGames(GAMES);
                await updatePanel(interaction.guild);

                return interaction.reply({
                    content: `✅ Fixed price removed from **${game.label}**.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "set-game-message") {
                const query = interaction.options.getString("game", true);
                const message = interaction.options.getString("message", true).trim();
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (!message) {
                    return interaction.reply({
                        content: "❌ The message cannot be empty.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                game.customMessage = message.substring(0, 1900);
                saveGames(GAMES);

                return interaction.reply({
                    content:
                        `✅ Saved the custom message for **${game.label}**.\n\n` +
                        `**Preview:**\n${game.customMessage}`,
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] }
                });
            }

            if (interaction.commandName === "clear-game-message") {
                const query = interaction.options.getString("game", true);
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                game.customMessage = null;
                saveGames(GAMES);

                return interaction.reply({
                    content: `✅ Custom message removed from **${game.label}**.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "send-game-message") {
                const query = interaction.options.getString("game", true);
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (!game.customMessage) {
                    return interaction.reply({
                        content: `❌ **${game.label}** does not have a saved message yet. Use \`/set-game-message\` first.`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                await interaction.channel.send({
                    content:
                        `${game.emoji || "🎮"} **${game.label}**\n` +
                        game.customMessage,
                    allowedMentions: { parse: [] }
                });

                return interaction.reply({
                    content: `✅ Sent the saved message for **${game.label}**.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.commandName === "remove-game") {
                const query = interaction.options.getString("game", true);
                const game = findGame(query);

                if (!game) {
                    return interaction.reply({
                        content: "❌ Game not found. Use `/games` to see the exact names.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                GAMES = GAMES.filter(item => item.value !== game.value);
                saveGames(GAMES);
                await updatePanel(interaction.guild);

                return interaction.reply({
                    content: `✅ Removed **${game.label}** from the store.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "games"
        ) {
            const lines = GAMES.map(game =>
                `${getStockIndicator(game.stock)} **${game.label}** — ${game.stock}` +
                (game.fixedPrice ? ` • 💰 Fixed: **${game.fixedPrice}**` : " • 💰 Flexible price") +
                (game.customMessage ? " • 📝 Message: ✅" : " • 📝 Message: ❌")
            );

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🎮 Game Stock")
                        .setDescription(lines.join("\n") || "No games configured.")
                        .setColor(0x5865F2)
                ],
                flags: MessageFlags.Ephemeral
            });
        }

        // -------------------------------------------------
        // /set-rank
        // -------------------------------------------------

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "set-rank"
        ) {
            if (!isAdmin(interaction)) {
                return interaction.reply({
                    content: "❌ Admin role required.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const user = interaction.options.getUser("user", true);
            const rankKey = interaction.options.getString("rank", true);

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const rank = await setManualSellerRank(
                interaction.guild,
                user.id,
                rankKey
            );

            const sellerData = getSellerData(user.id);

            let text = "";

            if (rankKey === "auto") {
                text =
                    `✅ ${user} is back on **AUTO RANK**.\n` +
                    `Current rank: **${rank ? rank.display : "No Rank"}**\n` +
                    `Sales: **${sellerData.delivered} ACC**`;
            } else if (rankKey === "none") {
                text =
                    `✅ Removed all seller rank roles from ${user}.\n` +
                    `Manual rank mode is now **NONE**.`;
            } else {
                text =
                    `✅ Gave ${user} **${rank ? rank.display : rankKey.toUpperCase()}** immediately.\n` +
                    `This is a **manual rank** and will stay until you use /set-rank again.`;
            }

            return interaction.editReply({
                content: rank?.roleUpdateFailed
                    ? "⚠️ تم حفظ إعداد الرتبة لكن تطبيق الرول فشل. فعّل Manage Roles وارفع رول البوت فوق رولات الرتب، ثم أعد نفس الأمر."
                    : text
            });
        }

        // -------------------------------------------------
        // /ticket-admin
        // -------------------------------------------------

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "ticket-admin"
        ) {
            if (!isStaff(interaction)) {
                return interaction.reply({
                    content: "❌ Staff only.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === interaction.channel.id);

            if (!ticket) {
                return interaction.reply({
                    content: "❌ Use this command inside a ticket channel.",
                    flags: MessageFlags.Ephemeral
                });
            }

            return interaction.reply({
                content:
                    `🛠️ **Private Staff Controls**\n` +
                    `Ticket: **${getGameName(ticket.game)}** • ${ticket.quantity || 1} ACC\n` +
                    `Buyer is optional.`,
                components: createPrivateStaffButtons(ticket),
                flags: MessageFlags.Ephemeral
            });
        }

        // -------------------------------------------------
        // /seller-stats
        // -------------------------------------------------

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "seller-stats"
        ) {
            const user =
                interaction.options.getUser("user") ||
                interaction.user;

            const sellerData = getSellerData(user.id);

            const statsEmbed = new EmbedBuilder()
                .setTitle("🏆 Seller Ranking")
                .setThumbnail(user.displayAvatarURL())
                .addFields(
                    {
                        name: "👤 Seller",
                        value: `${user}`,
                        inline: true
                    },
                    {
                        name: "📦 Accounts Delivered",
                        value: `\`${sellerData.delivered} ACC\``,
                        inline: true
                    },
                    {
                        name: "🏅 Current Rank",
                        value: sellerData.rank
                            ? sellerData.rank.display
                            : "No Rank",
                        inline: true
                    },
                    {
                        name: "⚙️ Rank Mode",
                        value: sellerData.rankMode,
                        inline: true
                    }
                )
                .setColor(0xF1C40F);

            return interaction.reply({
                embeds: [statsEmbed],
                flags: MessageFlags.Ephemeral
            });
        }

        // -------------------------------------------------
        // GAME SELECT
        // -------------------------------------------------

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "select_game"
        ) {
            if (getAvailableTickets() <= 0) {
                return interaction.reply({
                    content: `🔴 All ${MAX_TICKETS} ticket slots are currently in use.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const selectedGame = GAMES.find(
                game => game.value === interaction.values[0]
            );

            if (!selectedGame) {
                return interaction.reply({
                    content: "❌ This game is no longer available. Refresh the panel and try again.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (selectedGame.stock <= 0) {
                return interaction.reply({
                    content: `🔴 **${selectedGame.label}** is currently out of stock.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const userOpenTickets =
                getUserOpenTicketCount(interaction.user.id);

            if (userOpenTickets >= MAX_OPEN_TICKETS_PER_USER) {
                return interaction.reply({
                    content:
                        `❌ You already have ${MAX_OPEN_TICKETS_PER_USER} open tickets. Close one before opening another.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            pendingTickets.set(interaction.user.id, {
                game: interaction.values[0],
                createdAt: Date.now()
            });

            await interaction.reply({
                content:
                    `🎮 **Game:** ${getGameName(interaction.values[0])}\n\n` +
                    "Select account type / اختر نوع الحساب:",
                components: [createAccountTypeMenu(selectedGame)],
                flags: MessageFlags.Ephemeral
            });

            deleteReplyLater(interaction);
            return;
        }

        // -------------------------------------------------
        // PAYMENT SELECT
        // -------------------------------------------------

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "select_payment"
        ) {
            const pending = pendingTickets.get(interaction.user.id);

            if (!pending || !pending.accountTypeId || !typeDetailsComplete(pending)) {
                return interaction.reply({
                    content: "❌ Session expired. Select your game again.",
                    flags: MessageFlags.Ephemeral
                });
            }

            pending.payment = interaction.values[0];
            pendingTickets.set(interaction.user.id, pending);

            await interaction.reply({
                content:
                    `💳 **Payment:** ${getPaymentName(pending.payment)}\n\n` +
                    "اختر اللغة / Choose your language:",
                components: [createLanguageMenu()],
                flags: MessageFlags.Ephemeral
            });

            deleteReplyLater(interaction);
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === "select_language") {
            const pending = pendingTickets.get(interaction.user.id);
            if (!pending || !pending.payment || !pending.accountTypeId) {
                return interaction.reply({ content: "انتهت الجلسة، ابدأ من جديد / Session expired. Start again.", flags: MessageFlags.Ephemeral });
            }
            if (!["ar", "en"].includes(interaction.values[0])) return;
            pending.language = interaction.values[0];
            await interaction.update({
                content: ticketText(pending)("Select how many accounts you want to deliver:", "اختار عدد الحسابات اللي هتسلمها:"),
                components: [createQuantityMenu(pending)]
            });
            return;
        }

        // -------------------------------------------------
        // QUANTITY SELECT (1-20)
        // -------------------------------------------------

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "select_quantity"
        ) {
            const pending = pendingTickets.get(interaction.user.id);

            if (!pending || !pending.payment || !pending.language || !pending.accountTypeId || !typeDetailsComplete(pending)) {
                return interaction.reply({
                    content: l("❌ Session expired. Start again from the game menu.", "❌ انتهت الجلسة. ابدأ من اختيار اللعبة."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const requestedQuantity = Number(interaction.values[0]);
            const selectedGame = GAMES.find(game => game.value === pending.game);

            if (!selectedGame) {
                return interaction.reply({
                    content: l("❌ This game is no longer available.", "❌ اللعبة دي لم تعد متاحة."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const selectedPool=stockPool(selectedGame,pending.accountTypeId);
            if (!selectedPool) return interaction.reply({content:l("Account type is no longer available.","نوع الحساب لم يعد متاحًا."),flags:MessageFlags.Ephemeral});
            if (requestedQuantity > selectedPool.stock) {
                return interaction.reply({
                    content:
                        l(`❌ Only **${selectedPool.stock}** account(s) are currently available for **${selectedGame.label}**.`, `❌ المتاح **${selectedPool.stock}** حساب متاح حاليًا للعبة **${selectedGame.label}**.`),
                    flags: MessageFlags.Ephemeral
                });
            }

            pending.quantity = requestedQuantity;
            pendingTickets.set(interaction.user.id, pending);

            const fixedPrice = quotedTicketPrice(selectedGame,selectedPool,requestedQuantity);
            pending.quotedPrice=fixedPrice;
            pending.priceSource=selectedPool.fixedPrice ? "type" : selectedGame.fixedPrice ? "game" : "manual";

            const modal = new ModalBuilder()
                .setCustomId("ticket_modal")
                .setTitle(l(`🎫 Account Information • ${pending.quantity} ACC`, `🎫 معلومات الطلب • ${pending.quantity} ACC`));

            const payoutDetails = new TextInputBuilder()
                .setCustomId("payout_details")
                .setLabel(l("Money receiving number / link", "رقم / رابط استلام الفلوس"))
                .setPlaceholder(getPayoutPlaceholder(pending.payment, pending))
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const contactPhone = new TextInputBuilder()
                .setCustomId("contact_phone")
                .setLabel(l("Contact phone (optional)", "رقم التواصل (اختياري)"))
                .setPlaceholder(l("Optional contact number", "رقم تواصل اختياري"))
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            const description = new TextInputBuilder()
                .setCustomId("description")
                .setLabel(l("Description (optional)", "الوصف (اختياري)"))
                .setPlaceholder(l("Optional notes about the order", "ملاحظات اختيارية عن الطلب"))
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(payoutDetails),
                new ActionRowBuilder().addComponents(contactPhone),
                new ActionRowBuilder().addComponents(description)
            );

            if (!fixedPrice) {
                const price = new TextInputBuilder()
                    .setCustomId("price")
                    .setLabel(l("Price", "السعر"))
                    .setPlaceholder(l("Example: 500 EGP", "مثال: 500 جنيه"))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(price)
                );
            }

            return interaction.showModal(modal);
        }

        // -------------------------------------------------
        // MODAL SUBMIT
        // -------------------------------------------------

        if (
            interaction.isModalSubmit() &&
            interaction.customId === "ticket_modal"
        ) {
            const pending = pendingTickets.get(interaction.user.id);

            if (!pending || !pending.game || !pending.payment || !pending.language || !pending.quantity || !pending.accountTypeId || !typeDetailsComplete(pending)) {
                return interaction.reply({
                    content:
                        l("❌ Session expired. Please start again from the ticket panel.", "❌ انتهت الجلسة. ابدأ من لوحة التيكت."),
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (getAvailableTickets() <= 0) {
                pendingTickets.delete(interaction.user.id);

                return interaction.editReply({
                    content: l("🔴 No tickets are available right now.", "🔴 مفيش تيكتات متاحة حاليًا.")
                });
            }

            const userOpenTickets =
                getUserOpenTicketCount(interaction.user.id);

            if (userOpenTickets >= MAX_OPEN_TICKETS_PER_USER) {
                pendingTickets.delete(interaction.user.id);

                return interaction.editReply({
                    content:
                        l(`❌ You already have ${MAX_OPEN_TICKETS_PER_USER} open tickets. Close one before opening another.`, `❌ عندك بالفعل ${MAX_OPEN_TICKETS_PER_USER} تيكت مفتوح. اقفل واحد قبل فتح غيره.`)
                });
            }

            const selectedType = stockPool(GAMES.find(g=>g.value===pending.game),pending.accountTypeId);
            if (!selectedType) return interaction.editReply({content:"❌ نوع الحساب لم يعد موجودًا. ابدأ من جديد."});
            const accountType = accountTypeName(selectedType,pending.language);
            const description =
                interaction.fields.getTextInputValue("description") || "";
            const payoutDetails =
                interaction.fields.getTextInputValue("payout_details").trim();
            const contactPhone =
                (interaction.fields.getTextInputValue("contact_phone") || "").trim();

            const paymentDisplay = getPaymentName(pending.payment);

            const selectedGame = GAMES.find(game => game.value === pending.game);

            if (!selectedGame) {
                pendingTickets.delete(interaction.user.id);

                return interaction.editReply({
                    content: l("❌ This game is no longer available.", "❌ اللعبة دي لم تعد متاحة.")
                });
            }

            if ((pending.quantity || 1) > selectedType.stock) {
                pendingTickets.delete(interaction.user.id);

                return interaction.editReply({
                    content:
                        l(`❌ Stock changed while you were filling the form. `, `❌ المتاح اتغير أثناء ملء النموذج. `) +
                        l(`Only **${selectedType.stock}** account(s) remain for **${selectedGame.label}**.`, `المتاح **${selectedType.stock}** حساب متبقي للعبة **${selectedGame.label}**.`)
                });
            }

            const currentQuote=quotedTicketPrice(selectedGame,selectedType,pending.quantity);
            if (!Object.prototype.hasOwnProperty.call(pending,"quotedPrice") || currentQuote!==pending.quotedPrice) {
                return interaction.editReply({content:"The price changed. Please select the quantity again to review the new price. / السعر اتغير؛ اختار العدد مرة تانية."});
            }
            let enteredPrice = "";
            if (!currentQuote) {
                enteredPrice = interaction.fields.getTextInputValue("price").trim();
            }

            const price = currentQuote || enteredPrice;
            const fixedPrice = Boolean(currentQuote);

            const safeName = interaction.user.username
                .toLowerCase()
                .replace(/[^a-z0-9-_]/g, "-")
                .substring(0, 18);

            if(typeMutationJobs.has(selectedGame.value)) return interaction.editReply({content:"Account types are being updated. Please try again shortly."});
            const gameLayout = await ensureGameChannels(interaction.guild,selectedGame.value);
            if (!stockPool(findGame(selectedGame.value),pending.accountTypeId) || typeMutationJobs.has(selectedGame.value)) {
                return interaction.editReply({content:"Account type changed. Please start again."});
            }
            const channel = await interaction.guild.channels.create({
                name: `🎫・ticket-${safeName}-${Date.now().toString().slice(-4)}`,
                type: ChannelType.GuildText,
                parent: gameLayout.publicCategoryId,
                topic: `ticket-owner:${interaction.user.id}`,
                permissionOverwrites: [
                    ...gamePrivatePermissions(interaction.guild, true),
                    {
                        id: interaction.user.id,
                        allow: [
                            PermissionsBitField.Flags.ViewChannel,
                            PermissionsBitField.Flags.SendMessages,
                            PermissionsBitField.Flags.ReadMessageHistory,
                            PermissionsBitField.Flags.AttachFiles,
                            PermissionsBitField.Flags.EmbedLinks
                        ]
                    }
                ]
            });

            const ticket = {
                ticketId: channel.id,
                ticketMessageId: null,
                userId: interaction.user.id,
                discordTag: interaction.user.username,

                storageVersion: 2,
                game: pending.game,
                payment: pending.payment,
                language: pending.language,
                paymentDisplay,
                payoutDetails,
                contactPhone,
                accountType,
                accountTypeId: pending.accountTypeId,
                accountRank: pending.accountRank || null,
                skinCount: pending.skinCount || null,
                skinDetails: pending.skinDetails || null,
                quantity: pending.quantity,
                price,
                fixedPrice,
                unitPrice: selectedType.fixedPrice || null,
                description,
                images: [],
                accounts: [],
                buyerIds: [],
                accountDataDmedAt: null,

                status: "OPENED",

                seenBy: null,
                seenAt: null,

                sellerId: null,
                deliveredCounted: false,

                createdAt: new Date().toISOString(),

                soldAt: null,

                warrantyStartedAt: null,
                warrantyEndsAt: null,

                fundsStatus: null,
                fundsReleasedAt: null,

                closedAt: null,
                closedBy: null,
                closedDeleteAt: null,
                deletionWarningSentAt: null,

                adminCallWindowStartedAt: null,
                adminCallCount: 0
            };

            const ticketMessage = await channel.send({
                content: l(`${interaction.user} <@&${ADMIN_ROLE_ID}> 🚨 **New Ticket**`, `${interaction.user} <@&${ADMIN_ROLE_ID}> 🚨 **تيكت جديد**`),
                embeds: [createTicketEmbed(ticket)],
                components: createPublicTicketButtons(ticket),
                allowedMentions: { roles: [ADMIN_ROLE_ID], users: [interaction.user.id] }
            });

            await channel.send({
                embeds: [new EmbedBuilder().setColor(0x5865F2)
                    .setTitle(l("🔐 Submit Account", "🔐 تسليم حساب"))
                    .setDescription(l(
                        "Press **Submit Account**, enter the login and password, then fill **Additional Info** using the example below. Replace the example with your own details. Staff will review and receive the accounts after submission.",
                        "اضغط **تسليم حساب**، واكتب بيانات الدخول وكلمة المرور، ثم املأ **المعلومات الإضافية** باستخدام المثال التالي. استبدل بيانات المثال ببيانات حسابك. بعد الإرسال، ستراجع الإدارة الحسابات وتؤكد استلامها."
                    ))
                    .addFields({ name: l("Required delivery information", "المعلومات المطلوبة عند التسليم"),
                        value: getDeliveryInfo(ticket) })]
            });

            await channel.send({
                embeds: [new EmbedBuilder()
                    .setColor(0xF0B232)
                    .setTitle(l("📸 Upload your account photos here", "📸 ارفع صور حسابك هنا في التيكت"))
                    .setDescription(l(
                        `Use the **+ / Attach File** button beside the message box and send clear screenshots showing the account details.\n\nYou can upload up to **${MAX_IMAGES_PER_TICKET} photos per ticket**.\nThe bot will confirm how many photos were saved.`,
                        `اضغط **علامة + / إرفاق ملف** جنب خانة الرسالة، وابعت صور واضحة تُظهر تفاصيل الحساب.\n\nتقدر ترفع لحد **${MAX_IMAGES_PER_TICKET} صور لكل تيكت**.\nالبوت هيأكد لك عدد الصور اللي اتحفظت.`
                    ))]
            });

            ticket.ticketMessageId = ticketMessage.id;

            const tickets = loadTickets();
            tickets.push(ticket);
            saveTickets(tickets);
            logTicketSnapshot(ticket,true);

            pendingTickets.delete(interaction.user.id);

            await updatePanel(interaction.guild);

            await sendAdminNewTicketAlert(
                interaction.guild,
                ticket,
                channel
            );

            await sendTicketStatusDM(
                ticket,
                interaction.guild,
                "Your ticket has been created successfully."
            );

            await interaction.editReply({
                content: ticketText(ticket)(`✅ Your ticket has been created: ${channel}`, `✅ تم فتح التيكت: ${channel}`)
            });

            deleteReplyLater(interaction);
            return;
        }

        // -------------------------------------------------
        // ACCOUNT DATA - SIMPLE ONE PAGE
        // -------------------------------------------------

        if (
            interaction.isButton() &&
            interaction.customId === "ticket_account_data"
        ) {
            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === interaction.channel.id);

            if (!ticket || ticket.closedAt) {
                return interaction.reply({
                    content: l("❌ Active ticket not found.", "❌ التيكت غير موجود أو مقفول."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const allowed = interaction.user.id === ticket.userId || isStaff(interaction);
            if (!allowed) {
                return interaction.reply({
                    content: l("❌ You cannot edit account data in this ticket.", "❌ مش مسموح لك تعدّل بيانات الحساب هنا."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const nextIndex = getNextIncompleteAccountIndex(ticket);

            if (nextIndex === -1) {
                return interaction.reply({
                    content: l("✅ All account data is already saved. Select one to edit:", "✅ كل بيانات الحسابات محفوظة. اختار حساب للتعديل:"),
                    components: [createAccountSlotMenu(ticket)],
                    flags: MessageFlags.Ephemeral
                });
            }

            const existing = Array.isArray(ticket.accounts)
                ? (ticket.accounts[nextIndex] || {})
                : {};

            return interaction.showModal(
                buildAccountDataModal(ticket, nextIndex, existing)
            );
        }

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith("account_slot:")
        ) {
            const ticketId = interaction.customId.split(":")[1];
            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === ticketId);

            if (!ticket || ticket.closedAt) {
                return interaction.reply({
                    content: l("❌ Active ticket not found.", "❌ التيكت غير موجود أو مقفول."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const allowed = interaction.user.id === ticket.userId || isStaff(interaction);
            if (!allowed) {
                return interaction.reply({
                    content: l("❌ You cannot edit account data.", "❌ مش مسموح لك تعدّل بيانات الحساب."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const accountIndex = Number(interaction.values[0]);
            const existing = Array.isArray(ticket.accounts)
                ? (ticket.accounts[accountIndex] || {})
                : {};

            return interaction.showModal(
                buildAccountDataModal(ticket, accountIndex, existing)
            );
        }

        if (
            interaction.isButton() &&
            interaction.customId.startsWith("account_next:")
        ) {
            const [, ticketId, accountIndexRaw] = interaction.customId.split(":");
            const accountIndex = Number(accountIndexRaw);

            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === ticketId);

            if (!ticket || ticket.closedAt) {
                return interaction.reply({
                    content: l("❌ Active ticket not found.", "❌ التيكت غير موجود أو مقفول."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const allowed = interaction.user.id === ticket.userId || isStaff(interaction);
            if (!allowed) {
                return interaction.reply({
                    content: l("❌ You cannot edit account data.", "❌ مش مسموح لك تعدّل بيانات الحساب."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const quantity = Math.max(1, Number(ticket.quantity) || 1);
            if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= quantity) {
                return interaction.reply({
                    content: l("❌ Invalid account number.", "❌ رقم الحساب غير صحيح."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const existing = Array.isArray(ticket.accounts)
                ? (ticket.accounts[accountIndex] || {})
                : {};

            return interaction.showModal(
                buildAccountDataModal(ticket, accountIndex, existing)
            );
        }

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith("account_data:")
        ) {
            const [, ticketId, accountIndexRaw] = interaction.customId.split(":");
            const accountIndex = Number(accountIndexRaw);

            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === ticketId);

            if (!ticket || ticket.closedAt) {
                return interaction.reply({
                    content: l("❌ Active ticket not found.", "❌ التيكت غير موجود أو مقفول."),
                    flags: MessageFlags.Ephemeral
                });
            }

            const allowed = interaction.user.id === ticket.userId || isStaff(interaction);
            if (!allowed) {
                return interaction.reply({
                    content: l("❌ You cannot edit account data.", "❌ مش مسموح لك تعدّل بيانات الحساب."),
                    flags: MessageFlags.Ephemeral
                });
            }

            if ((ticket.receivedAt || ticket.soldAt) && (ticket.status !== "CHANGES_REQUESTED" || !ticket.correction)) {
                return interaction.reply({content: l("Accounts have already been received; editing is locked.", "تم استلام الحسابات؛ تعديل البيانات مغلق."), flags: MessageFlags.Ephemeral});
            }
            if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= ticket.quantity) return;
            if (!Array.isArray(ticket.accounts)) ticket.accounts = [];

            const additionalInfo = (interaction.fields.getTextInputValue("additional_info") || "").trim();
            if (!additionalInfo) {
                return interaction.reply({
                    content: l("❌ Additional Info is required. Enter the account and its password.", "❌ المعلومات الإضافية إلزامية. اكتب الحساب وكلمة مروره."),
                    flags: MessageFlags.Ephemeral
                });
            }

            ticket.accounts[accountIndex] = {
                login: interaction.fields.getTextInputValue("login").trim(),
                password: interaction.fields.getTextInputValue("password"),
                additionalInfo,
                updatedAt: new Date().toISOString()
            };

            saveTickets(tickets);
            sheetsLog("Accounts", {
                ticketId: ticket.ticketId,
                submittedAt: ticket.accounts[accountIndex].updatedAt,
                sellerId: ticket.userId,
                discordTag: ticket.discordTag || interaction.user.username,
                accountIndex: accountIndex + 1,
                login: ticket.accounts[accountIndex].login,
                password: ticket.accounts[accountIndex].password,
                additionalInfo: ticket.accounts[accountIndex].additionalInfo
            });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await refreshTicket(interaction.channel, ticket);

            const nextIndex = getNextIncompleteAccountIndex(ticket);

            if (nextIndex !== -1) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`account_next:${ticket.ticketId}:${nextIndex}`)
                        .setLabel(l(`Add Account ${nextIndex + 1}`, `إضافة حساب ${nextIndex + 1}`))
                        .setEmoji("➡️")
                        .setStyle(ButtonStyle.Primary)
                );

                await interaction.editReply({
                    content:
                        l(`✅ **Account ${accountIndex + 1} saved.**\n`, `✅ **الحساب ${accountIndex + 1} اتحفظ.**\n`) +
                        l(`⚠️ You still have **Account ${nextIndex + 1}** to enter. `, `⚠️ لسه باقي **الحساب ${nextIndex + 1}** محتاج بياناته. `) +
                        l(`Press the button below so it is not forgotten.`, `اضغط الزر اللي تحت عشان تضيف بياناته.`),
                    components: [row],
                });

                deleteReplyLater(interaction);
                return;
            }

            await interaction.editReply({
                content:
                    l(`✅ Account ${accountIndex + 1} saved. `, `✅ الحساب ${accountIndex + 1} اتحفظ. `) +
                    l(`All **${ticket.quantity || 1} account(s)** were submitted. Staff will review and confirm receipt.`, `تم إرسال **${ticket.quantity || 1} حساب**. ستراجع الإدارة البيانات وتؤكد الاستلام.`),
            });

            const latest = loadTickets();
            const current = latest.find(t => t.ticketId === ticket.ticketId);
            if (current && !current.submittedAt) {
                current.submittedAt = new Date().toISOString();
                current.status = "READY";
                if (current.correction) {
                    current.correction.awaitingConfirmation = true;
                    current.correction.submittedAt = current.submittedAt;
                    current.lastModifiedAt = current.submittedAt;
                    current.revisions = Array.isArray(current.revisions) ? current.revisions : [];
                    current.revisions.push({requestedAt:current.correction.at,requestedBy:current.correction.by,
                        submittedAt:current.submittedAt,submittedBy:interaction.user.id,confirmedAt:null,confirmedBy:null});
                }
                saveTickets(latest);
                audit("READY", interaction.user.id, current);
                await refreshTicket(interaction.channel,current);
                await interaction.channel.send({
                    content: `<@&${ADMIN_ROLE_ID}> 📥 ` + l("Accounts submitted.", "تم تسليم بيانات الحسابات."),
                    allowedMentions: {roles: [ADMIN_ROLE_ID]}
                });
                await sendAdminNewTicketAlert(interaction.guild, current, interaction.channel, true);
            }
            deleteReplyLater(interaction);
            return;
        }

        // -------------------------------------------------
        // CALL ADMIN - MAX 2 TIMES / 15 MINUTES
        // -------------------------------------------------

        if (
            interaction.isButton() &&
            interaction.customId === "ticket_call_admin"
        ) {
            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === interaction.channel.id);

            if (!ticket || ticket.closedAt) {
                return interaction.reply({
                    content: l("❌ Active ticket not found.", "❌ التيكت غير موجود أو مقفول."),
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.user.id !== ticket.userId && !isStaff(interaction)) {
                return interaction.reply({
                    content: l("❌ Only the ticket owner can call Admin.", "❌ صاحب التيكت فقط يقدر ينادي الإدارة."),
                    flags: MessageFlags.Ephemeral
                });
            }

            return pingAdminForTicket(interaction, ticket);
        }

        // -------------------------------------------------
        // SET BUYER BUTTON / USER SELECT
        // -------------------------------------------------

        if (
            interaction.isButton() &&
            interaction.customId === "ticket_set_buyer"
        ) {
            if (!isStaff(interaction)) {
                return interaction.reply({ content: "❌ Staff only.", flags: MessageFlags.Ephemeral });
            }

            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === interaction.channel.id);
            if (!ticket || ticket.closedAt) {
                return interaction.reply({ content: "❌ Active ticket not found.", flags: MessageFlags.Ephemeral });
            }

            return interaction.reply({
                content: "🛒 اختر المشترين (حتى 25). كلهم يقدروا يسترجعوا بيانات نفس التيكت بإرسال account للبوت في الخاص. إلغاء الاختيارات يمسح قائمة المشترين. هذه الرسالة خاصة بالإدارة.",
                components: [createBuyerMenu(ticket)],
                flags: MessageFlags.Ephemeral
            });
        }

        if (
            interaction.isUserSelectMenu() &&
            interaction.customId.startsWith("set_buyer:")
        ) {
            if (!isStaff(interaction)) {
                return interaction.reply({ content: "❌ Staff only.", flags: MessageFlags.Ephemeral });
            }

            const ticketId = interaction.customId.split(":")[1];
            const tickets = loadTickets();
            const ticket = tickets.find(item => item.ticketId === ticketId);

            if (!ticket || ticket.closedAt) {
                return interaction.reply({ content: "❌ Active ticket not found.", flags: MessageFlags.Ephemeral });
            }

            if (ticket.ticketId !== interaction.channel.id || interaction.values.length>25) return interaction.reply({content:"❌ اختيار غير صالح.",flags:MessageFlags.Ephemeral});
            ticket.buyerIds = [...new Set(interaction.values)];
            delete ticket.buyerId;
            saveTickets(tickets);
            audit("BUYERS_UPDATED",interaction.user.id,ticket,{count:ticket.buyerIds.length});

            return interaction.reply({
                content: ticket.buyerIds.length ? `✅ المشترون: ${ticket.buyerIds.map(id=>`<@${id}>`).join("، ")}\nيكتب كل مشتري account في خاص البوت بعد الاستلام.` : "✅ تم مسح قائمة المشترين.",
                flags: MessageFlags.Ephemeral,
                allowedMentions: {parse:[]}
            });
        }

        if (interaction.isButton() && interaction.customId === "ticket_receive") {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ Admin only / للإدارة فقط", flags: MessageFlags.Ephemeral });
            const tickets = loadTickets();
            const ticket = tickets.find(t => t.ticketId === interaction.channel.id);
            const fail = content => interaction.reply({content, flags: MessageFlags.Ephemeral});
            if (!ticket || ticket.closedAt) return fail(l("Active ticket not found.", "التيكت غير موجود أو مغلق."));
            if ((ticket.receivedAt || ticket.soldAt || ticket.deliveredCounted) && !ticket.correction?.awaitingConfirmation) return fail(l("Already received / sold. Stock was not deducted again.", "تم الاستلام أو البيع بالفعل. لم يُخصم المتاح مرة أخرى."));
            if (ticket.status === "CHANGES_REQUESTED") return fail(l("The user must press Submit Account and save all account details first. Then reopen /ticket-admin to receive them.", "المستخدم لازم يضغط «تسليم حساب» ويحفظ بيانات كل الحسابات أولًا. بعدها افتح /ticket-admin من جديد واضغط الاستلام."));
            if (getNextIncompleteAccountIndex(ticket) !== -1) return fail(l("Complete every account first.", "يجب إكمال بيانات كل الحسابات أولًا."));
            const game = GAMES.find(g => g.value === ticket.game);
            const quantity = Math.max(1, Number(ticket.quantity) || 1);
            if (!game) return fail(l("Game not found.", "اللعبة غير موجودة."));
            const pool=stockPool(game,ticket.accountTypeId || "general");
            if (!pool) return fail(l("Account type is missing. Restore it before receipt.","نوع الحساب غير موجود. أعد إضافته قبل الاستلام."));
            const previousStock = pool.stock;
            const receipts = pool.receivedTicketIds || [];
            if (!ticket.receivedAt && !ticket.soldAt && !receipts.includes(ticket.ticketId)) {
                if (pool.stock < quantity) return fail(l("Not enough stock for this account type. Use /set-type-stock.","كمية نوع الحساب غير كافية. استخدم /set-type-stock."));
                const types=game.accountTypes.map(t=>t===pool?{...t,stock:t.stock-quantity,receivedTicketIds:[...receipts,ticket.ticketId]}:t);
                saveGames(GAMES.map(g=>g===game?{...g,accountTypes:types}:g));
            }
            const revisionConfirmation = Boolean(ticket.correction?.awaitingConfirmation);
            if (revisionConfirmation) {
                const revision = (ticket.revisions || []).findLast(item => !item.confirmedAt);
                if (revision) { revision.confirmedAt = new Date().toISOString(); revision.confirmedBy = interaction.user.id; }
                ticket.lastRevisionConfirmedAt = new Date().toISOString();
                ticket.status = ticket.soldAt ? (ticket.fundsReleasedAt ? "FUNDS_RELEASED" : "WARRANTY") : "RECEIVED";
                ticket.correction = null;
            } else ticket.status = "RECEIVED";
            ticket.receivedAt = ticket.receivedAt || new Date().toISOString();
            ticket.receivedBy = ticket.receivedBy || interaction.user.id;
            saveTickets(tickets);
            audit(revisionConfirmation ? "REVISION_CONFIRMED" : "RECEIVED",interaction.user.id,ticket,{typeId:ticket.accountTypeId || "general",before:previousStock,after:getGameStock(ticket.game,ticket.accountTypeId || "general")});
            await interaction.reply({content: l(`Received ${quantity} account(s). Available: ${getGameStock(ticket.game,ticket.accountTypeId || "general")}.`, `تم استلام ${quantity} حساب. المتاح الآن: ${getGameStock(ticket.game,ticket.accountTypeId || "general")}.`), flags: MessageFlags.Ephemeral});
            await refreshTicket(interaction.channel, ticket);
            await updatePanel(interaction.guild);
            if (revisionConfirmation) {
                const user = await client.users.fetch(ticket.userId);
                await user.send({content:ticketText(ticket)("✅ Staff received and confirmed your updated account details.","✅ الإدارة استلمت بيانات الحساب المعدّلة وأكدتها.")}).catch(()=>{});
            } else await sendTicketStatusDM(ticket, interaction.guild);
            return;
        }

        // -------------------------------------------------
        // STAFF BUTTONS
        // -------------------------------------------------

        if (
            interaction.isButton() &&
            [
                "ticket_seen",
                "ticket_sold",
                "ticket_close"
            ].includes(interaction.customId)
        ) {
            if (!isStaff(interaction)) {
                return interaction.reply({
                    content: "❌ Only Staff can use this button.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const tickets = loadTickets();

            const ticket = tickets.find(
                item => item.ticketId === interaction.channel.id
            );

            if (!ticket) {
                return interaction.reply({
                    content: "❌ Ticket data was not found.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // ---------------------------------------------
            // SEEN
            // ---------------------------------------------

            if (interaction.customId === "ticket_seen") {
                if (ticket.closedAt) {
                    return interaction.reply({
                        content: "❌ This ticket is already closed.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (!ticket.receivedAt && !ticket.soldAt && !["READY","CHANGES_REQUESTED"].includes(ticket.status)) ticket.status = "SEEN";
                ticket.seenBy = interaction.user.id;
                ticket.seenByName = interaction.user.username;
                ticket.seenAt = new Date().toISOString();

                saveTickets(tickets);
                logTicketSnapshot(ticket);

                await refreshTicket(interaction.channel, ticket);

                await sendTicketStatusDM(
                    ticket,
                    interaction.guild,
                    "The staff team has seen your ticket."
                );

                return interaction.reply({
                    content: `👀 Ticket marked as **Seen** by ${interaction.user}.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // ---------------------------------------------
            // SOLD / DELIVERED -> 8 DAY WARRANTY
            // ---------------------------------------------

            if (interaction.customId === "ticket_sold") {
                if (ticket.correction) return interaction.reply({content:l("Confirm receipt of the updated details first.","يجب تأكيد استلام البيانات المعدّلة أولًا."),flags:MessageFlags.Ephemeral});
                if (ticket.closedAt) {
                    return interaction.reply({
                        content: "❌ This ticket is already closed.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (ticket.deliveredCounted || ticket.soldAt) {
                    return interaction.reply({
                        content:
                            "❌ This ticket has already been marked as Sold / Delivered.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const completedAccounts = Array.isArray(ticket.accounts)
                    ? ticket.accounts.filter(Boolean).length
                    : 0;

                if (completedAccounts < (ticket.quantity || 1)) {
                    return interaction.reply({
                        content:
                            `❌ Complete **Submit Account** first. ` +
                            `Saved: **${completedAccounts}/${ticket.quantity || 1}** account(s).`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (!ticket.receivedAt) return interaction.reply({content: l("Admin must receive the accounts first.", "يجب أن تضغط الإدارة استلام الحساب أولًا."), flags: MessageFlags.Ephemeral});
                const now = new Date();
                ticket.warrantyDays = configuredWarrantyDays(ticket);
                const warrantyEnds = addDays(now, ticket.warrantyDays);

                ticket.status = "WARRANTY";
                ticket.soldAt = now.toISOString();
                ticket.soldBy = interaction.user.id;
                ticket.soldByName = interaction.user.username;
                ticket.sellerId = ticket.userId;

                ticket.warrantyStartedAt = now.toISOString();
                ticket.warrantyEndsAt = warrantyEnds.toISOString();

                ticket.fundsStatus = "ON_HOLD";
                ticket.fundsReleasedAt = null;

                const game = GAMES.find(item => item.value === ticket.game);
                const deliveredQuantity = Math.max(1, Number(ticket.quantity) || 1);

                if (!game) {
                    return interaction.reply({
                        content:
                            "❌ This game's stock record was not found. Add the game again or fix it with the admin commands.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                ticket.deliveredCounted = false;
                saveTickets(tickets);
                logTicketSnapshot(ticket);
                audit("SOLD",interaction.user.id,ticket,{quantity:ticket.quantity});
                await interaction.deferReply({flags: MessageFlags.Ephemeral});

                const sellerData = getSellerData(ticket.userId);
                const sellerResult = {count:sellerData.delivered,rank:sellerData.rank};

                // Stock was deducted at admin receipt, never at sale.

                await refreshTicket(interaction.channel, ticket);
                await updatePanel(interaction.guild);

                // Buyer is an internal staff reference; no automated buyer DM.

                const rankText =
                    sellerResult.rank
                        ? sellerResult.rank.display
                        : "No Rank";

                await sendTicketStatusDM(
                    ticket,
                    interaction.guild,
                    `The account was marked as **Sold / Delivered**.\n` +
                    `Warranty started for **${ticketWarrantyDays(ticket)} days** and seller funds are **ON HOLD**.`
                );

                return interaction.editReply({
                    content:
                        `🟢 **Account Sold / Delivered**\n\n` +
                        `🏪 Seller: <@${ticket.userId}>\n` +
                        `📦 This Delivery: **${ticket.quantity || 1} ACC**\n` +
                        `📊 Seller Total: **${sellerResult.count} ACC**\n` +
                        `🏆 Seller Rank: **${rankText}**\n` +
                        `${getStockIndicator(game.stock)} ${game.label} Stock Left: **${game.stock}**\n` +
                        `${ticketBuyerIds(ticket).length ? `🛒 Buyers: ${ticketBuyerIds(ticket).map(id=>`<@${id}>`).join(", ")}\n📩 Buyer DM command: **account**\n` : "🛒 Buyers: **Not set (optional)**\n"}\n` +
                        `🛡️ Warranty: **ACTIVE — ${ticketWarrantyDays(ticket)} DAYS**\n` +
                        `💰 Funds: **ON HOLD**\n` +
                        `⏳ Funds Release: ${discordTime(ticket.warrantyEndsAt)}`,
                });
            }

            // ---------------------------------------------
            // CLOSE
            // ---------------------------------------------

            if (interaction.customId === "ticket_close") {
                if (ticket.closedAt) {
                    return interaction.reply({
                        content: "❌ This ticket is already closed.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                await interaction.deferReply({flags:MessageFlags.Ephemeral});
                const layout=await ensureGameChannels(interaction.guild,ticket.game);
                const archive=await interaction.guild.channels.fetch(layout.archiveCategoryId);
                // Lock to the private archive permissions: remove the owner's old allow.
                await interaction.channel.setParent(archive.id,{lockPermissions:true});
                const closedAt = new Date();
                const deleteAt = addDays(closedAt, CLOSED_TICKET_RETENTION_DAYS);

                ticket.status = "CLOSED";
                ticket.closedAt = closedAt.toISOString();
                ticket.closedBy = interaction.user.id;
                ticket.closedByName = interaction.user.username;
                ticket.closedDeleteAt = deleteAt.toISOString();
                ticket.deletionWarningSentAt = null;

                saveTickets(tickets);
                logTicketSnapshot(ticket);

                await sendTicketStatusDM(
                    ticket,
                    interaction.guild,
                    `Your ticket has been closed and moved to the private admin archive for **${CLOSED_TICKET_RETENTION_DAYS} days** before automatic deletion.`
                );

                await interaction.editReply({
                    content:
                        `🔒 Ticket closed. It will remain for **${CLOSED_TICKET_RETENTION_DAYS} days** and then be deleted automatically.`,
                    flags: MessageFlags.Ephemeral
                });



                await interaction.channel.setName(
                    `🔒・closed-${interaction.channel.name.replace(/^(?:🎫・)?(?:closed-)?/, "").substring(0, 80)}`
                ).catch(() => {});

                await updatePanel(interaction.guild);
                return;
            }
        }
    } catch (error) {
        console.error("❌ Interaction error:", error);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: "❌ An error occurred. Check CMD."
                });
            } else {
                await interaction.reply({
                    content: "❌ An error occurred. Check CMD.",
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (_) {
            console.log("⚠️ Could not send error reply.");
        }
    }
});

// =====================================================
// SAVE ACCOUNT IMAGES SENT INSIDE TICKETS
// =====================================================

client.on(Events.MessageCreate, async message => {
    try {
        if (message.author.bot) return;
        if (!message.guild) { await handleBuyerDM(message); return; }
        if (message.attachments.size === 0) return;

        const tickets = loadTickets();
        const ticket = tickets.find(
            item =>
                !item.closedAt &&
                item.ticketId === message.channel.id &&
                item.userId === message.author.id
        );

        if (!ticket) return;
        const l = ticketText(ticket);

        const imageAttachments = [...message.attachments.values()].filter(
            attachment =>
                (attachment.contentType &&
                    attachment.contentType.startsWith("image/")) ||
                /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || "")
        );

        if (imageAttachments.length === 0) return;

        if (!Array.isArray(ticket.images)) {
            ticket.images = [];
        }

        const remaining =
            MAX_IMAGES_PER_TICKET - ticket.images.length;

        if (remaining <= 0) {
            await message.reply(
                `⚠️ Maximum ${MAX_IMAGES_PER_TICKET} images are already saved for this ticket.`
            ).then(reply => {
                setTimeout(() => reply.delete().catch(() => {}), 30000);
            }).catch(() => {});
            return;
        }

        for (const attachment of imageAttachments.slice(0, remaining)) {
            ticket.images.push({
                url: attachment.url,
                name: attachment.name || "image",
                uploadedAt: new Date().toISOString()
            });
        }

        saveTickets(tickets);
        await refreshTicket(message.channel, ticket);

        const savedCount = Math.min(imageAttachments.length, remaining);

        await message.reply(
            `✅ Saved **${savedCount} image(s)**. ` +
            l(`Ticket now has **${ticket.images.length}/${MAX_IMAGES_PER_TICKET} images**.`, `التيكت فيه الآن **${ticket.images.length}/${MAX_IMAGES_PER_TICKET} صور**.`)
        ).then(reply => {
            setTimeout(() => reply.delete().catch(() => {}), 30000);
        }).catch(() => {});
    } catch (error) {
        console.error("❌ Image save error:", error);
    }
});

// =====================================================
// AUTOMATIC 8 DAY WARRANTY / FUNDS RELEASE
// =====================================================

async function checkTimedTickets() {
    await flushTicketSheetUpdates();
    const now = Date.now();
    for (const [id, p] of pendingTickets) if (now - p.createdAt > 10 * 60 * 1000) pendingTickets.delete(id);
    for (const [id, s] of deliveryInfoSessions) if (now - s.at > 900000) deliveryInfoSessions.delete(id);
    for (const [key, expiresAt] of buyerReminderRetry) if (now > expiresAt) buyerReminderRetry.delete(key);
    for (const [key, expiresAt] of adminPaymentRetry) if (now > expiresAt) adminPaymentRetry.delete(key);
    await remindAdminPayments();
    await remindBuyerPayments();
    const tickets = loadTickets();

    for (const ticket of tickets) {
        const l = ticketText(ticket);

        // Closed tickets - warning and deletion
        if (ticket.closedAt) {
            if (ticket.channelDeletedAt) continue;

            const closedAtMs = new Date(ticket.closedAt).getTime();

            if (!Number.isNaN(closedAtMs)) {
                const deleteAtMs = ticket.closedDeleteAt
                    ? new Date(ticket.closedDeleteAt).getTime()
                    : addDays(new Date(ticket.closedAt), CLOSED_TICKET_RETENTION_DAYS).getTime();

                const warningAtMs = deleteAtMs - (24 * 60 * 60 * 1000);

                if (
                    Date.now() >= warningAtMs &&
                    Date.now() < deleteAtMs &&
                    !ticket.deletionWarningSentAt
                ) {
                    const warnChannel = await client.channels.fetch(ticket.ticketId).catch(() => null);
                    if (warnChannel && warnChannel.isTextBased()) {
                        await warnChannel.send(
                            l(`⚠️ **Final day notice:** This closed ticket will be deleted automatically in less than 24 hours.`, `⚠️ **تنبيه آخر يوم:** التيكت المقفول هيتحذف تلقائيًا خلال أقل من 24 ساعة.`)
                        ).catch(() => {});
                    }
                    ticket.deletionWarningSentAt = new Date().toISOString();
                    const wFresh = loadTickets();
                    const wCur = wFresh.find(t => t.ticketId === ticket.ticketId);
                    if (wCur) { wCur.deletionWarningSentAt = ticket.deletionWarningSentAt; saveTickets(wFresh); }
                }

                if (Date.now() >= deleteAtMs) {
                    const delChannel = await client.channels.fetch(ticket.ticketId).catch(() => null);
                    if (delChannel) {
                        await delChannel.delete().catch(error => {
                            console.log("⚠️ Closed ticket delete error:", error.message);
                        });
                    }
                    ticket.channelDeletedAt = new Date().toISOString();
                    const dFresh = loadTickets();
                    const dCur = dFresh.find(t => t.ticketId === ticket.ticketId);
                    if (dCur) { dCur.channelDeletedAt = ticket.channelDeletedAt; saveTickets(dFresh); }
                }
            }

            continue;
        }

        // Warranty expiry - single authoritative funds-release path
        if (!ticket.warrantyEndsAt || ticket.fundsReleasedAt) continue;

        const releaseTime = new Date(ticket.warrantyEndsAt).getTime();
        if (Number.isNaN(releaseTime)) continue;

        if (Date.now() >= releaseTime) {
            const fresh = loadTickets();
            const current = fresh.find(t => t.ticketId === ticket.ticketId);
            if (!current || current.fundsReleasedAt) continue;

            current.status = "FUNDS_RELEASED";
            current.fundsStatus = "RELEASED";
            current.fundsReleasedAt = new Date().toISOString();
            saveTickets(fresh);
            logTicketSnapshot(current);
            logPaymentSnapshot(current);
            sheetsLog("Sales", {
                ticketId: current.ticketId,
                soldAt: current.soldAt || current.fundsReleasedAt,
                game: current.game,
                accountType: current.accountType,
                quantity: current.quantity,
                sellerId: current.sellerId || current.userId,
                warrantyDays: ticketWarrantyDays(current),
                warrantyEndsAt: current.warrantyEndsAt,
                buyerCount: ticketBuyerIds(current).length
            });
            audit("PAYOUT_READY", "system", current);

            const relChannel = await client.channels.fetch(ticket.ticketId).catch(() => null);
            if (relChannel && relChannel.isTextBased()) {
                const lc = ticketText(current);
                await relChannel.send(
                    lc(`✅ **${ticketWarrantyDays(current)}-day warranty completed.**\n\n`, `✅ **${ticketWarrantyDays(current)}-أيام ضمان انتهت.**\n\n`) +
                    lc("💰 Seller funds are now **RELEASED**.", "💰 المبلغ جاهز للصرف الآن.")
                ).catch(() => {});
                await refreshTicket(relChannel, current);
            }

            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                await sendTicketStatusDM(
                    current,
                    guild,
                    `The **${ticketWarrantyDays(current)}-day warranty** has finished.\n` +
                    ticketText(current)("Seller funds are now **RELEASED**.", "المبلغ جاهز للصرف الآن.")
                );
            }
        }
    }
}

// Check every minute
setInterval(() => {
    checkTimedTickets().catch(error =>
        console.error("❌ Timer error:", error)
    );
}, 60 * 1000);

// =====================================================
// ERROR PROTECTION
// =====================================================

client.on("error", error => {
    console.error("❌ Discord Client Error:", error);
});

process.on("unhandledRejection", error => {
    console.error("❌ Unhandled Promise Rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("❌ Uncaught Exception:", error);
});

// =====================================================
// LOGIN
// =====================================================

client.login(TOKEN);
