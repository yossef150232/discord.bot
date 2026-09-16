async function sheetsLog(sheet, row) {
    const url = process.env.SHEETS_WEBHOOK_URL;
    if (!url) return;
    try {
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                secret: process.env.SHEETS_SECRET || "",
                sheet,
                row
            }),
            signal: AbortSignal.timeout(20000)
        });
    } catch (error) {
        console.log("⚠️ Sheets logging error:", error.message);
    }
}

module.exports = { sheetsLog };
