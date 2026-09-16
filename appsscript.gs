const SHEETS_CONFIG = {
    Tickets: [
        "ticketId",
        "createdAt",
        "sellerId",
        "discordTag",
        "game",
        "accountType",
        "accountRank",
        "skinCount",
        "skinDetails",
        "quantity",
        "price",
        "payment",
        "contactPhone",
        "payoutDetails",
        "description",
        "status",
        "language",
        "warrantyDays"
    ],
    Accounts: [
        "ticketId",
        "submittedAt",
        "sellerId",
        "discordTag",
        "accountIndex",
        "login",
        "password",
        "additionalInfo"
    ],
    Sales: [
        "ticketId",
        "soldAt",
        "game",
        "accountType",
        "quantity",
        "sellerId",
        "warrantyDays",
        "warrantyEndsAt",
        "buyerCount"
    ],
    Payment: [
        "ticketId",
        "sellerId",
        "quantity",
        "game",
        "price",
        "paymentMethod",
        "buyerId",
        "amountDue",
        "dueSince",
        "buyerPaidAt",
        "buyerStatus",
        "sellerPaidAt",
        "sellerPaidBy",
        "fundsReleasedAt",
        "creditedTotal"
    ],
    Sellers: [
        "userId",
        "delivered",
        "rank",
        "rankMode",
        "updatedAt"
    ],
    AuditLog: [
        "at",
        "action",
        "actor",
        "ticketId",
        "game",
        "typeId",
        "before",
        "after"
    ]
};

const TAB_COLORS = {
    Tickets: "#2B579A",
    Accounts: "#1E7E34",
    Sales: "#6F42C1",
    Payment: "#D9381E",
    Sellers: "#E67E22",
    AuditLog: "#34495E"
};

function formatSheet(sheet, headers, headerColor) {
    sheet.setFrozenRows(1);
    const lastRow = Math.max(1, sheet.getLastRow());
    const lastCol = headers.length;

    const headerRange = sheet.getRange(1, 1, 1, lastCol);
    headerRange.setBackground(headerColor || "#2C3E50")
        .setFontColor("#FFFFFF")
        .setFontWeight("bold")
        .setFontSize(11)
        .setHorizontalAlignment("center")
        .setVerticalAlignment("middle");
    sheet.setRowHeight(1, 36);

    if (lastRow > 1) {
        const dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
        dataRange.setHorizontalAlignment("center")
            .setVerticalAlignment("middle")
            .setFontSize(10);

        for (let r = 2; r <= lastRow; r++) {
            sheet.setRowHeight(r, 28);
            const rowColor = r % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
            sheet.getRange(r, 1, 1, lastCol).setBackground(rowColor);
        }
    }

    for (let c = 1; c <= lastCol; c++) {
        sheet.autoResizeColumn(c);
        const w = sheet.getColumnWidth(c);
        if (w < 110) {
            sheet.setColumnWidth(c, 120);
        } else {
            sheet.setColumnWidth(c, w + 20);
        }
    }
}

function setupSheets() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    for (const [sheetName, headers] of Object.entries(SHEETS_CONFIG)) {
        let sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
            sheet = ss.insertSheet(sheetName);
        }
        if (sheet.getLastRow() === 0) {
            sheet.appendRow(headers);
        }
        formatSheet(sheet, headers, TAB_COLORS[sheetName]);
        sheet.setTabColor(TAB_COLORS[sheetName]);
    }
}

function doPost(e) {
    try {
        const payload = JSON.parse(e.postData.contents);
        const expectedSecret = PropertiesService.getScriptProperties().getProperty("SHEETS_SECRET");
        if (expectedSecret && payload.secret !== expectedSecret) {
            return ContentService.createTextOutput(JSON.stringify({ error: "Unauthorized" }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const headers = SHEETS_CONFIG[payload.sheet];
        if (!headers) {
            return ContentService.createTextOutput(JSON.stringify({ error: "Unknown sheet" }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        let sheet = ss.getSheetByName(payload.sheet);
        if (!sheet) {
            sheet = ss.insertSheet(payload.sheet);
            sheet.appendRow(headers);
            formatSheet(sheet, headers, TAB_COLORS[payload.sheet]);
            if (TAB_COLORS[payload.sheet]) {
                sheet.setTabColor(TAB_COLORS[payload.sheet]);
            }
        }

        const rowData = headers.map(header => {
            const val = payload.row[header];
            if (val === undefined || val === null) return "";
            if (typeof val === "string" && /^[=+\-@]/.test(val)) return "'" + val;
            return val;
        });

        sheet.appendRow(rowData);

        const newRow = sheet.getLastRow();
        const rowColor = newRow % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
        const rowRange = sheet.getRange(newRow, 1, 1, headers.length);
        rowRange.setHorizontalAlignment("center")
            .setVerticalAlignment("middle")
            .setFontSize(10)
            .setBackground(rowColor);
        sheet.setRowHeight(newRow, 28);

        for (let c = 1; c <= headers.length; c++) {
            sheet.autoResizeColumn(c);
            const w = sheet.getColumnWidth(c);
            if (w < 110) {
                sheet.setColumnWidth(c, 120);
            }
        }

        return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
            .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}
