const WEBHOOK_URL = String(process.env.SHEETS_WEBHOOK_URL || "").trim();
const SECRET = String(process.env.SHEETS_SECRET || "");
const REQUEST_TIMEOUT_MS = 15000;

let warnedMissingConfig = false;

async function postToSheets(sheet, row, options = {}) {
    if (!WEBHOOK_URL) {
        if (!warnedMissingConfig) {
            warnedMissingConfig = true;
            console.warn("⚠️ SHEETS_WEBHOOK_URL is missing; Google Sheets sync is disabled.");
        }
        throw new Error("SHEETS_WEBHOOK_URL is missing");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                secret: SECRET,
                sheet,
                row,
                action: options.action || "append",
                keyField: options.keyField || null
            }),
            redirect: "follow",
            signal: controller.signal
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (_) {
            throw new Error(`Google Sheets returned a non-JSON response (${response.status})`);
        }
        if (!response.ok || result.error) {
            throw new Error(result.error || `Google Sheets HTTP ${response.status}`);
        }
        return result;
    } finally {
        clearTimeout(timeout);
    }
}

// Append-only logs must never interrupt a Discord interaction.
function sheetsLog(sheet, row) {
    return postToSheets(sheet, row).catch(error => {
        console.error(`Google Sheets append failed (${sheet}):`, error.message);
        return null;
    });
}

// Upserts reject on failure so index.js retains ticket updates for retry.
function sheetsUpsertTicket(row) {
    if (!row?.ticketId) return Promise.reject(new Error("Tickets upsert requires ticketId"));
    return postToSheets("Tickets", row, { action: "upsert", keyField: "ticketId" });
}

function sheetsUpsertPayment(row) {
    if (!row?.ticketId) return Promise.reject(new Error("Payment upsert requires ticketId"));
    return postToSheets("Payment", row, { action: "upsert", keyField: "ticketId" });
}

module.exports = { sheetsLog, sheetsUpsertTicket, sheetsUpsertPayment };
