const SHEETS_CONFIG = {
    Tickets: [
        "ticketId", "createdAt", "sellerId", "discordTag", "game",
        "accountType", "accountRank", "skinCount", "skinDetails", "quantity",
        "price", "payment", "contactPhone", "payoutDetails", "description",
        "status", "language", "warrantyDays",
        "seenBy", "seenByName", "seenAt",
        "soldBy", "soldByName", "soldAt",
        "paidBy", "paidByName", "paidAt",
        "closedBy", "closedByName", "closedAt"
    ],
    Accounts: [
        "ticketId", "submittedAt", "sellerId", "discordTag", "accountIndex",
        "login", "password", "additionalInfo"
    ],
    Sales: [
        "ticketId", "soldAt", "game", "accountType", "quantity", "sellerId",
        "warrantyDays", "warrantyEndsAt", "buyerCount"
    ],
    Payment: [
        "ticketId", "sellerId", "quantity", "game", "price", "paymentMethod",
        "buyerId", "amountDue", "dueSince", "buyerPaidAt", "buyerStatus",
        "sellerPaidAt", "sellerPaidBy", "fundsReleasedAt", "creditedTotal"
    ],
    Sellers: ["userId", "delivered", "rank", "rankMode", "updatedAt"],
    AuditLog: ["at", "action", "actor", "ticketId", "game", "typeId", "before", "after"]
};

const TAB_COLORS = {
    Tickets: "#2B579A",
    Accounts: "#1E7E34",
    Sales: "#6F42C1",
    Payment: "#D9381E",
    Sellers: "#E67E22",
    AuditLog: "#34495E"
};

function safeCell(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string" && /^[=+\-@]/.test(value)) return "'" + value;
    return value;
}

function jsonResponse(data) {
    return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet(ss, sheetName, headers) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    // Adds new columns to existing sheets without deleting their rows.
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.setTabColor(TAB_COLORS[sheetName] || "#2C3E50");
    return sheet;
}

function formatHeader(sheet, headers, headerColor) {
    sheet.getRange(1, 1, 1, headers.length)
        .setBackground(headerColor || "#2C3E50")
        .setFontColor("#FFFFFF")
        .setFontWeight("bold")
        .setFontSize(11)
        .setHorizontalAlignment("center")
        .setVerticalAlignment("middle");
    sheet.setRowHeight(1, 36);
}

function formatDataRow(sheet, rowNumber, columnCount) {
    const color = rowNumber % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
    sheet.getRange(rowNumber, 1, 1, columnCount)
        .setHorizontalAlignment("center")
        .setVerticalAlignment("middle")
        .setFontSize(10)
        .setBackground(color);
    sheet.setRowHeight(rowNumber, 28);
}

function resizeColumns(sheet, headers) {
    for (let column = 1; column <= headers.length; column++) {
        sheet.autoResizeColumn(column);
        const width = sheet.getColumnWidth(column);
        sheet.setColumnWidth(column, width < 110 ? 120 : Math.min(width + 20, 420));
    }
}

function formatSheet(sheet, headers, headerColor) {
    formatHeader(sheet, headers, headerColor);
    for (let row = 2; row <= sheet.getLastRow(); row++) {
        formatDataRow(sheet, row, headers.length);
    }
    resizeColumns(sheet, headers);
}

function setupSheets() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    for (const [sheetName, headers] of Object.entries(SHEETS_CONFIG)) {
        const sheet = ensureSheet(ss, sheetName, headers);
        formatSheet(sheet, headers, TAB_COLORS[sheetName]);
    }
}

function findUpsertRow(sheet, headers, keyField, keyValue) {
    const keyColumn = headers.indexOf(keyField) + 1;
    if (!keyField || keyColumn === 0 || keyValue === undefined || keyValue === null || keyValue === "") {
        throw new Error("Invalid upsert key");
    }
    if (sheet.getLastRow() < 2) return null;
    const found = sheet.getRange(2, keyColumn, sheet.getLastRow() - 1, 1)
        .createTextFinder(String(keyValue))
        .matchEntireCell(true)
        .findNext();
    return found ? found.getRow() : null;
}

function buildRow(headers, incoming, current) {
    return headers.map((header, index) => {
        if (Object.prototype.hasOwnProperty.call(incoming, header)) return safeCell(incoming[header]);
        return current ? current[index] : "";
    });
}

function doPost(e) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(15000);
        const payload = JSON.parse(e.postData.contents);
        const expectedSecret = PropertiesService.getScriptProperties().getProperty("SHEETS_SECRET");
        if (expectedSecret && payload.secret !== expectedSecret) return jsonResponse({ error: "Unauthorized" });

        const headers = SHEETS_CONFIG[payload.sheet];
        if (!headers) return jsonResponse({ error: "Unknown sheet" });
        if (!payload.row || typeof payload.row !== "object" || Array.isArray(payload.row)) {
            return jsonResponse({ error: "Invalid row" });
        }

        const sheet = ensureSheet(SpreadsheetApp.getActiveSpreadsheet(), payload.sheet, headers);
        formatHeader(sheet, headers, TAB_COLORS[payload.sheet]);
        const action = payload.action || "append";
        let targetRow = sheet.getLastRow() + 1;
        let operation = "inserted";
        let current = null;

        if (action === "upsert") {
            const existingRow = findUpsertRow(sheet, headers, payload.keyField, payload.row[payload.keyField]);
            if (existingRow) {
                targetRow = existingRow;
                current = sheet.getRange(targetRow, 1, 1, headers.length).getValues()[0];
                operation = "updated";
            }
        } else if (action !== "append") {
            return jsonResponse({ error: "Unknown action" });
        }

        const rowData = buildRow(headers, payload.row, current);
        sheet.getRange(targetRow, 1, 1, headers.length).setValues([rowData]);
        formatDataRow(sheet, targetRow, headers.length);
        resizeColumns(sheet, headers);
        return jsonResponse({ status: "ok", operation, row: targetRow });
    } catch (err) {
        return jsonResponse({ error: err.message });
    } finally {
        try { lock.releaseLock(); } catch (_) {}
    }
}
